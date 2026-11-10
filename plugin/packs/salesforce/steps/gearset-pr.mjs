// Ship step `gearset-pr`, in place of pr, ci, mergeable-recheck and merge on the gearset release
// path. Gearset closes the pull request Foreman opens within seconds and opens its own, from
// gs-pipeline/<branch>_-_<environment branch> into the same branch, so this step:
//
//   1. finds the stage whose own branch is the PR target (ship.pr.into, else baseBranch), and
//      that stage org's Gearset environment through the Reporting API (gearset.mjs), in the
//      pipeline salesforce.gearset.pipelineId names, or in every pipeline when it is unset. The
//      environment's name names the status to wait for: "Gearset <name>", for this environment
//      only. Nothing is opened before this passes, so a missing token, a refused team, no
//      environment for the org, or Gearset's production environment is code 1 with no PR.
//   2. finds the promotion PR by its head branch (an OPEN one, else a MERGED one; a CLOSED one
//      is ignored). With none yet, it opens the story's pull request into the target unless one
//      is open already, and only when both lists (the promotion PR and the story's open PR)
//      answered. A gh failure is never read as "none": it waits and tries again on the next round.
//   3. polls every 20 seconds, for ship.ci.timeoutMinutes (default 30), re-finding the promotion
//      PR each time so a head Gearset re-syncs is followed, and reads its head commit's statuses.
//      Only the exact context counts: another environment's on the same commit is ignored.
//
// success is ok, with the facts `pr` (url) and `prNumber` of the promotion PR, which the later
// steps read. failure or error is code 2, as is the deadline. Once the promotion PR is found it
// raises `review` on the story through the story source; one that fails is an event. It never
// merges: merging the promotion PR is gearset-promote's job.
//
// It imports neither the core pr step nor the story source at load time: both lead back to the
// config validator, which loads this pack, so the story source is imported when first needed and
// prTarget is a copy of the pr step's rule.

import { layout } from '../config.mjs';
import { environmentFor, gearsetEnvironments, gearsetToken, promotionBranch, statusContext } from '../gearset.mjs';

const STAGE = 'gearset-pr';
const POLL_MS = 20_000;
const SHA = /^[0-9a-f]{7,64}$/i;

// The branch pull requests merge into, the same rule as the pr step's prTarget.
const prTarget = (config) => config.ship?.pr?.into ?? config.baseBranch;

const fail = (code, reason, extra = {}) => ({ ok: false, code, stage: STAGE, reason, ...extra });
const said = (r) => String(r.stderr || r.stdout || '').trim().split('\n').pop().slice(0, 200);
const plural = (n) => `${n} minute${n === 1 ? '' : 's'}`;

const defaultRaise = async (...args) => (await import('../../../lib/engine/story-events.mjs')).raiseStoryEvent(...args);

export default {
  name: 'gearset-pr',
  label: "opening the pull request and following Gearset's promotion PR",
  needs: ['gh'],
  requires: { env: ['GEARSET_API_TOKEN'] },

  async run(ctx, deps = {}) {
    const fetch = deps.fetch ?? ctx.fetch ?? globalThis.fetch;
    const raise = deps.raiseStoryEvent ?? defaultRaise;
    const { sh, branch } = ctx;

    const target = prTarget(ctx.config);
    const stage = layout(ctx.config.salesforce, ctx.config).stages.find((s) => !s.follows && s.branch === target);
    if (!stage) return fail(1, `ship.pr.into is ${target}, which is no stage's own branch; Gearset promotes into a stage's environment branch`);

    const token = gearsetToken(ctx.env ?? process.env);
    if (!token) return fail(1, `GEARSET_API_TOKEN is not set; gearset-pr reads stage ${stage.name}'s Gearset environment from the Gearset Reporting API`);
    const read = await gearsetEnvironments({ fetch, token, pipelineId: ctx.config.salesforce?.gearset?.pipelineId });
    if (!read.ok) return fail(1, read.error);
    const found = environmentFor(read.environments, stage.orgId);
    if (!found.ok) return fail(1, found.error);
    const envName = found.environment.name;
    const context = statusContext(envName);
    const head = promotionBranch(branch, target);

    let lastError = '';
    const listPrs = (args) => {
      const r = sh('gh', ['pr', 'list', ...args]);
      if (r.status !== 0) {
        lastError = `gh pr list failed: ${said(r)}`;
        return null;
      }
      try {
        const prs = JSON.parse(r.stdout);
        if (Array.isArray(prs)) return prs.filter((p) => p !== null && typeof p === 'object');
      } catch {
        // falls through to unreadable
      }
      lastError = 'gh pr list answered something unreadable';
      return null;
    };
    // The promotion PR, null when the list answered with none OPEN or MERGED, or undefined when
    // the list failed.
    const findPromotion = () => {
      const prs = listPrs(['--head', head, '--base', target, '--state', 'all', '--json', 'number,url,state,headRefOid']);
      if (!prs) return undefined;
      return prs.find((p) => p.state === 'OPEN') ?? prs.find((p) => p.state === 'MERGED') ?? null;
    };
    // The target environment's status on `sha`: { state } with state lowercase, { state: null }
    // when it has not appeared, or null when the statuses could not be read.
    const validation = (sha) => {
      if (!SHA.test(String(sha ?? ''))) {
        lastError = 'gh pr list gave no head commit for the promotion PR';
        return null;
      }
      const r = sh('gh', ['api', `repos/{owner}/{repo}/commits/${sha}/status`]);
      if (r.status !== 0) {
        lastError = `gh api commits/${sha}/status failed: ${said(r)}`;
        return null;
      }
      let body;
      try {
        body = JSON.parse(r.stdout);
      } catch {
        lastError = `gh api commits/${sha}/status answered something unreadable`;
        return null;
      }
      const statuses = Array.isArray(body?.statuses) ? body.statuses : [];
      const mine = statuses.find((s) => s?.context === context);
      return mine ? { state: String(mine.state ?? '').toLowerCase(), description: String(mine.description ?? '') } : { state: null };
    };

    let featureUrl = null;
    let opened = false; // the story's PR was found open, or this step opened it
    // Opens the story's PR unless one is open. A failed list leaves `opened` false, so the next
    // round tries again; a failed create is the step's failure.
    const openStoryPr = () => {
      const open = listPrs(['--head', branch, '--base', target, '--state', 'open', '--json', 'number,url']);
      if (!open) return null;
      if (open.length) featureUrl = typeof open[0].url === 'string' ? open[0].url : null;
      else {
        const r = sh('gh', ['pr', 'create', '--base', target, '--head', branch, '--fill']);
        if (r.status !== 0) return fail(1, `Could not open the pull request into ${target}.`);
        const url = String(r.stdout ?? '').trim().split('\n').pop();
        featureUrl = /^https?:\/\//.test(url) ? url : null;
      }
      opened = true;
      if (featureUrl) ctx.report?.(featureUrl);
      return null;
    };

    let promo = null;
    const minutes = ctx.config.ship?.ci?.timeoutMinutes ?? 30;
    const deadline = ctx.now().getTime() + minutes * 60_000;
    let pr = null; // the promotion PR, once found
    let state = null; // the last state read of the target environment's status
    for (;;) {
      const seen = findPromotion();
      promo = seen ?? promo;
      if (!promo && !opened && seen === null) {
        const failed = openStoryPr();
        if (failed) return failed;
      }
      if (promo) {
        if (!pr) {
          ctx.report?.(promo.url);
          await tellReview(ctx, promo.url, raise);
        }
        pr = promo;
        const v = validation(promo.headRefOid);
        if (v) {
          state = v.state;
          const facts = { pr: pr.url, prNumber: pr.number };
          if (state === 'success') return { ok: true, ...facts };
          if (state === 'failure' || state === 'error') {
            const why = v.description.slice(0, 200);
            return fail(2, `${context} validation failed on pull request #${pr.number}${why ? `: ${why}` : ''}`, facts);
          }
        }
      }
      if (ctx.now().getTime() >= deadline) {
        const ghError = lastError ? ` (${lastError})` : '';
        if (!pr) {
          return fail(2, `Gearset did not open ${head} within ${plural(minutes)}; check that the pipeline's ${envName} environment uses this repository and its CI job validates pull requests${ghError}`, featureUrl ? { pr: featureUrl } : {});
        }
        const facts = { pr: pr.url, prNumber: pr.number };
        if (state === null) {
          return fail(2, `${context} has not validated pull request #${pr.number} within ${plural(minutes)}; turn on "Validate pull requests targeting the source branch" for its CI job${ghError}`, facts);
        }
        return fail(2, `${context} validation did not finish within ${plural(minutes)} on pull request #${pr.number}${ghError}`, facts);
      }
      await ctx.sleep(POLL_MS);
    }
  },
};

async function tellReview(ctx, url, raise) {
  let r;
  try {
    r = await raise({ root: ctx.root, env: ctx.env, now: ctx.now }, ctx.story, 'review', `Pull request ready for review: ${url}`);
  } catch (err) {
    r = { ok: false, error: String(err?.message ?? err) };
  }
  if (r?.ok === false) {
    try {
      ctx.event?.(`Could not tell the story source ${ctx.story} is in review (${r.error}).`, 'warn');
    } catch {
      // an event is never worth failing the release over
    }
  }
}
