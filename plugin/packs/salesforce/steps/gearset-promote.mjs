// Ship step `gearset-promote-<stage>`, on the gearset release path, one per stage up to stopAt.
// gearsetPromote(stageName) gives the step for that stage, the same module on every call. Gearset
// opens a promotion PR from gs-pipeline/<story branch>_-_<stage branch> into the stage's branch,
// validates it with the commit status "Gearset <environment name>", and its CI job deploys a
// merge of it to the stage's org. salesforce.gearset.promote says who merges it:
//
//   merge (default)  this step. It reads the stage org's Gearset environment through the
//                    Reporting API, in salesforce.gearset.pipelineId's pipeline or in every
//                    pipeline when that is unset (so GEARSET_API_TOKEN is needed, and Gearset's
//                    production environment is refused). The read is kept on the release's ctx
//                    (gearset.mjs releaseEnvironments), so gearset-pr's is reused. A 429 waits the
//                    time Retry-After names, with an info event, inside the step's limit; a wait
//                    that would pass it is code 1 with `rateLimited: true` and `retryAt`, nothing
//                    merged. Then every 20 seconds until ship.ci.timeoutMinutes
//                    (default 30) re-finds the promotion PR (OPEN before MERGED, CLOSED ignored)
//                    and reads that environment's status only. success: it merges with
//                    `gh pr merge <n> --merge --match-head-commit <sha>` and nothing else, since
//                    Gearset takes merge commits only and owns the gs-pipeline branches.
//                    failure or error is code 2, with nothing merged, as is a validation still
//                    pending at the deadline. Gearset validates a PR into the first stage by itself
//                    and never one into a later stage, so a later stage's PR gets no status unless
//                    a person presses Run validation. With salesforce.gearset.validateLaterStages
//                    "foreman" (the default), a PR into a later stage that has no status of that
//                    context after salesforce.gearset.nudgeMinutes (or when the deadline comes
//                    first) is validated by Foreman, not nudged and not parked: an info event says
//                    so, head-validate.mjs dry-runs that PR's head, by its commit, against the
//                    stage's org (never a production org), and Gearset's status on that head still
//                    wins (failure or error is code 2). The dry run covers the pull request's whole
//                    diff against the stage branch (sfdx-git-delta from the merge base to the head),
//                    not only this story's change, since the PR can carry other queued changes. A
//                    failed dry run is code 2 with `failures`
//                    and `validatedBy: 'foreman'`, nothing merged. When it passes, the merge below
//                    is of that same head (`--match-head-commit`), so a head that moved is refused
//                    by gh and nothing is merged. Foreman never calls Gearset's Automation API for
//                    this. With "gearset" (and always for the first stage), a PR with no status of
//                    that context at all is nudged
//                    after salesforce.gearset.nudgeMinutes (default NUDGE_MINUTES, 5), at most
//                    MAX_NUDGES (2) times, one full wait apart, with an empty commit on top of the
//                    PR's head, pushed to the promotion branch by fast-forward only, which Gearset's
//                    "source branch updated" trigger takes as the start. The nudge never calls
//                    Gearset's Automation API: the validation job of a pull request is made
//                    per PR, its id is in no public API, and the only place it shows is the
//                    target_url of a commit status, which
//                    anyone who can write to the repository may post (and Gearset posts with a
//                    person's token, so the status creator proves nothing either). A run request
//                    for an id read from there could start any job in the team, even one that
//                    deploys, and the environment's own CI job id is a different job from the
//                    PR's validation job. A nudge that fails is a warn event and still counts. The
//                    PR is re-listed every poll, so the head the push made is the one whose status
//                    is merged. When the status still has not come after the last nudge (or the
//                    deadline arrives first), the step parks the story (exit 9, nothing halts, the
//                    slot is freed) with one plain task: press Run validation on the PR in
//                    Gearset's pipeline. The park's check holds { branch, mode: 'merge', stages }
//                    and `foreman release watch` finishes the
//                    promotion (see check). A PR already
//                    MERGED (a re-run after a crash) is not merged again. After the merge it
//                    confirms the deploy, every 20 seconds until a new deadline as long: a
//                    DeployRequest in the stage's org that is not check-only, Succeeded, and
//                    finished after the merge, or, at most every 3 minutes (later when a 429 names a
//                    later time, at most a day, with an info event), the Reporting API
//                    listing the promotion PR as deployed to the environment. A merged release
//                    cannot be undone, so the result carries noReturn and any later failure is
//                    code 5: the Reporting API listing the deploy as failed, or no confirmation
//                    by the deadline. A Failed DeployRequest is not taken as the story's
//                    failure, because another person's deploy may be in that org. Facts:
//                    gearsetPromotions, with { org, pr, prNumber, mergedAt, via: 'org' |
//                    'gearset', deployId, testsCompleted, validatedBy } added under the stage's name.
//                    validatedBy is 'gearset' when Gearset's own success status was merged, and
//                    'foreman' (with validation: { jobId, components, tests } or { skipped: true }
//                    when the pull request changes no Salesforce metadata) when Foreman's dry run was;
//                    it is left out for a PR already MERGED, where it is not known. A
//                    deploy that ran no Apex tests is a warn event.
//                    A parked merge-mode check (mode: 'merge') does what the owner's click does, outside
//                    the ship lock: an open PR waits for its status (no nudge, so no loop), merges
//                    once it passes (`--match-head-commit`, info event), fails the story when it
//                    failed, waits without GEARSET_API_TOKEN, and refuses Gearset's production
//                    environment; then it confirms the deploy as above. For a later stage with
//                    validateLaterStages "foreman" (the default) and no status of that context,
//                    it does not wait for a click: it validates the PR itself, as the run does
//                    (foremanValidate), waiting up to 30 minutes for the dry run, and merges the
//                    validated head. A dry run that fails, a refused org or a Gearset failure
//                    status fails the story with nothing merged; one that never started, did not
//                    finish or was stopped is a waiting answer, so the next watch tries again.
//                    With "gearset", and for the first stage, it waits for the status as before.
//                    The park reason says so: with "foreman" it says Foreman validates and
//                    promotes the later stages itself; with "gearset" it tells the owner to press
//                    Run validation on the later stages' promotion pull requests too.
//   owner            the owner clicks Promote in Gearset. The step parks the release for every
//                    stage from this one through stopAt (no later step runs after a park), with
//                    a check of plain data: { branch, stages: [{ name, org, orgId, branch }] }.
//                    `foreman release watch` calls check(ctx), which, stage by stage, waits for
//                    the promotion PR, then for its merge, then confirms the deploy in the org
//                    or, with a token, through the Reporting API. A failed Reporting API deploy
//                    fails the release.
//
// Production is never a target: a stage with no org ID, one that follows another's branch, one
// on productionBranch, and (merge mode) Gearset's Production environment are refused with code
// 1 before any merge; check refuses a stored org that is no longer in salesforce.orgs with the
// same org ID, or a stored branch that is now productionBranch. Every gh and sf call goes
// through ctx.sh, sf through the isolated sf home. Foreman's own validation of a later stage's PR
// (head-validate.mjs) also uses git, for a temporary checkout of the PR's head. Reasons, details
// and notes name stages, orgs, pull request numbers and URLs, and Gearset environment names: never
// a token, a header or a URL query. It imports neither the core pr nor merge step (both lead back to the config
// validator, which loads this pack), nor gearset-pr's helpers.

import os from 'node:os';
import { layout } from '../config.mjs';
import { MAX_NUDGES, MAX_RATE_LIMIT_WAIT_MS, NUDGE_MINUTES, deploymentOfPr, environmentFor, gearsetDeployments, gearsetEnvironments, gearsetToken, promotionBranch, releaseEnvironments, statusContext, waitOutRateLimit } from '../gearset.mjs';
import { validateHead } from '../head-validate.mjs';
import { isolatedSh, sfHome } from '../isolation.mjs';
import { runSf, stopsRetry } from '../sf.mjs';

const POLL_MS = 20_000;
const REPORTING_EVERY_MS = 3 * 60_000;
const BEFORE_MERGE_MS = 5 * 60_000;
const SHA = /^[0-9a-f]{7,64}$/i;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v : '');
const said = (r) => String(r?.stderr || r?.stdout || '').trim().split('\n').pop().slice(0, 200);
const plural = (n) => `${n} minute${n === 1 ? '' : 's'}`;
// sf gives dates as 2026-10-15T12:01:00.000+0000, which Date.parse reads only with the colon.
const sfTime = (v) => Date.parse(text(v).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
const count = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const prName = (pr) => (pr ? ` (pull request #${pr.number})` : '');
// Whether Gearset lists the environment deploying to `orgId` as its production one.
const isProduction = (environments, orgId) => environments.some((e) => e?.stage === 'Production' && text(e.targetOrgId).slice(0, 15) === text(orgId).slice(0, 15));
// `v` without the characters " ` $ { } \, for text that goes into a double-quoted shell argument.
const plain = (v) => String(v ?? '').replace(/["`${}\\]/g, '');
const andList = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

// The promotion PR into `base` from `head`: { pr } (null when there is none yet), or { error }
// when gh could not list them. `--head` matches the branch name only, so anyone with a fork
// can open a PR from a branch of the same name; only a PR gh reports as coming from this
// repository (isCrossRepository false) is Gearset's promotion and may be merged.
function findPromotion(sh, head, base) {
  const r = sh('gh', ['pr', 'list', '--head', head, '--base', base, '--state', 'all', '--json', 'number,url,state,headRefOid,mergedAt,isCrossRepository']) ?? {};
  if (r.status !== 0) return { error: `gh pr list failed: ${said(r)}` };
  let prs;
  try {
    prs = JSON.parse(String(r.stdout ?? ''));
  } catch {
    return { error: 'gh pr list answered something unreadable' };
  }
  if (!Array.isArray(prs)) return { error: 'gh pr list answered something unreadable' };
  const real = prs.filter((p) => isObject(p) && p.isCrossRepository === false);
  return { pr: real.find((p) => p.state === 'OPEN') ?? real.find((p) => p.state === 'MERGED') ?? null };
}

// The status `context` on `sha`: { state } (lowercase) with its description, { state: null }
// when it has not appeared, or { error } when the statuses could not be read. Another
// environment's status on the same commit is not this one.
function validation(sh, sha, context) {
  if (!SHA.test(String(sha ?? ''))) return { error: 'gh pr list gave no head commit for the promotion PR' };
  const r = sh('gh', ['api', `repos/{owner}/{repo}/commits/${sha}/status`]) ?? {};
  if (r.status !== 0) return { error: `gh api commits/${sha}/status failed: ${said(r)}` };
  let body;
  try {
    body = JSON.parse(String(r.stdout ?? ''));
  } catch {
    return { error: `gh api commits/${sha}/status answered something unreadable` };
  }
  const mine = (Array.isArray(body?.statuses) ? body.statuses : []).find((s) => s?.context === context);
  return mine ? { state: String(mine.state ?? '').toLowerCase(), description: String(mine.description ?? '') } : { state: null };
}

// Pushes an empty commit on top of the promotion PR's head to the promotion branch, which starts a
// validation whose trigger is the source branch being updated. The ref moves by fast-forward
// only (force=false), so Gearset's branch is never rewritten, and the working tree is not touched.
// { ok: true } or { ok: false, detail }.
function pushEmptyCommit(sh, head, pr) {
  const tree = sh('gh', ['api', `repos/{owner}/{repo}/git/commits/${pr.headRefOid}`, '--jq', '.tree.sha']) ?? {};
  if (tree.status !== 0) return { ok: false, detail: said(tree) };
  const treeSha = String(tree.stdout ?? '').trim();
  if (!SHA.test(treeSha)) return { ok: false, detail: 'unreadable tree/commit' };
  const made = sh('gh', ['api', '-X', 'POST', 'repos/{owner}/{repo}/git/commits', '-f', `message=Ask Gearset to validate pull request #${pr.number}`, '-f', `tree=${treeSha}`, '-f', `parents[]=${pr.headRefOid}`, '--jq', '.sha']) ?? {};
  if (made.status !== 0) return { ok: false, detail: said(made) };
  const newSha = String(made.stdout ?? '').trim();
  if (!SHA.test(newSha)) return { ok: false, detail: 'unreadable tree/commit' };
  const moved = sh('gh', ['api', '-X', 'PATCH', `repos/{owner}/{repo}/git/refs/heads/${head}`, '-f', `sha=${newSha}`, '-F', 'force=false']) ?? {};
  return moved.status === 0 ? { ok: true } : { ok: false, detail: said(moved) };
}

// One nudge for a validation that has not started: an empty commit on the promotion branch. It
// never uses the Automation API (see the header). A nudge that fails is a warn event and still
// counts. Never throws.
function nudge(ctx, { pr, head, context, n, minutes }) {
  try {
    const pushed = pushEmptyCommit(ctx.sh, head, pr);
    if (pushed.ok) ctx.event?.(`${context} had not started on pull request #${pr.number} after ${plural(minutes)}; pushed an empty commit to ${head} to start it (nudge ${n} of ${MAX_NUDGES}).`, 'info');
    else ctx.event?.(`Could not nudge Gearset on pull request #${pr.number}: ${pushed.detail}`, 'warn');
  } catch (err) {
    try {
      ctx.event?.(`Could not nudge Gearset on pull request #${pr.number}: ${String(err?.message ?? err).slice(0, 200)}`, 'warn');
    } catch {
      // an event never fails a release
    }
  }
}

// Whether `stage.org` shows a deploy that finished after `mergedAt`: { state: 'deployed',
// deployId, testsCompleted }, { state: 'none', detail }, { state: 'error', detail }, or
// { state: 'stopped', detail } when the query stopsRetry and must not be tried again.
function orgDeploy(iso, stage, mergedAt) {
  const at = typeof mergedAt === 'string' ? new Date(mergedAt) : new Date(NaN);
  if (Number.isNaN(at.getTime())) return { state: 'error', detail: `the merge time of the ${stage.name} promotion pull request is unreadable` };
  const since = at.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const query = `SELECT Id, Status, CheckOnly, CompletedDate, NumberTestsCompleted FROM DeployRequest WHERE CreatedDate > ${since} ORDER BY CreatedDate DESC LIMIT 20`;
  const q = runSf(iso, ['data', 'query', '--use-tooling-api', '--query', query, '--target-org', stage.org]);
  if (stopsRetry(q)) return { state: 'stopped', detail: q.error.message };
  if (!q.ok) return { state: 'error', detail: `could not read the deploys in ${stage.org}: ${q.error.message}` };
  const records = isObject(q.result) && Array.isArray(q.result.records) ? q.result.records : [];
  const real = records.filter((row) => isObject(row) && row.CheckOnly !== true);
  const done = real.find((row) => row.Status === 'Succeeded' && sfTime(row.CompletedDate) > at.getTime());
  if (done) return { state: 'deployed', deployId: text(done.Id), testsCompleted: count(done.NumberTestsCompleted) };
  const newest = real[0] ? `; the newest is ${text(real[0].Status) || 'unknown'}` : '';
  return { state: 'none', detail: `${stage.org} shows no successful deploy that finished after the merge at ${since}${newest}` };
}

// What the Reporting API says about pull request `prNumber` in `environment`: deploymentOfPr's
// answer, or { state: 'error', detail }, which carries retryAfterMs when Gearset rate-limited the
// listing and named a time.
async function reportingDeploy({ fetch, token, environment, prNumber, branch, mergedAt, now, sleep }) {
  const merged = typeof mergedAt === 'string' ? Date.parse(mergedAt) : NaN;
  if (Number.isNaN(merged)) return { state: 'error', detail: 'the merge time of the promotion pull request is unreadable' };
  const listed = await gearsetDeployments({
    fetch,
    token,
    pipelineId: environment.pipelineId,
    environmentId: environment.environmentId,
    from: new Date(merged - BEFORE_MERGE_MS),
    to: now,
    sleep,
  });
  if (!listed.ok) {
    const limited = listed.status === 429 && Number.isFinite(listed.retryAfterMs);
    return { state: 'error', detail: listed.error, ...(limited ? { retryAfterMs: listed.retryAfterMs } : {}) };
  }
  return deploymentOfPr(listed.deployments, { environmentId: environment.environmentId, prNumber, branch });
}

// Why `stage` cannot be promoted through Gearset, or null.
function refusal(stage, stageName, l) {
  if (!stage) return `The salesforce block has no stage named ${stageName}.`;
  if (!stage.orgId) return `The org ${stage.org} of stage ${stage.name} has no org ID in salesforce.orgs.`;
  if (stage.follows) return `Stage ${stage.name} has no branch of its own; Gearset promotes into an environment branch.`;
  if (stage.branch === l.productionBranch) return `Stage ${stage.name} is on ${stage.branch}, the production branch; production is never a target.`;
  return null;
}

function make(stageName) {
  const name = `gearset-promote-${stageName}`;
  const label = `promoting to ${stageName} through Gearset`;
  const fail = (code, reason, extra = {}) => ({ ok: false, code, stage: name, reason, ...extra });

  const isoFor = (ctx) => {
    const env = ctx.env ?? process.env;
    return isolatedSh(ctx.sh, env, sfHome(env, os.homedir()), os.homedir());
  };

  // The stages from `stage` through stopAt, all of them promotable: { stages }, or { error }.
  function stagesThrough(stage, l) {
    const from = l.stages.indexOf(stage);
    const to = l.stages.findIndex((s) => s.name === l.stopAt);
    const stages = to >= from ? l.stages.slice(from, to + 1) : [];
    if (stages.length === 0) return { error: `Stage ${stageName} comes after stopAt ${l.stopAt ?? 'none'}; there is nothing to promote.` };
    for (const s of stages) {
      const why = refusal(s, s.name, l);
      if (why) return { error: why };
    }
    return { stages };
  }

  // Foreman's own dry run of a promotion PR's head against the stage's org (head-validate.mjs), for a
  // later stage Gearset never validates, then Gearset's status on that same head once more: a
  // failure or error there still wins (code 2). { ok: true, validated } (validated is { jobId,
  // components, tests }, or { skipped: true } when the PR changes no Salesforce metadata), or { ok:
  // false, code, reason, facts, final }: facts are the failures (and `inherited`) of a failed dry
  // run, and `final` says the answer will not change by waiting (code 1, a failed job, Gearset's
  // failure), against one that may (never started, did not finish, stopped watching).
  async function foremanValidate(ctx, { stage, head, pr, context, label: heartbeat }) {
    const v = await validateHead(ctx, { stage, head, sha: pr.headRefOid, what: `pull request #${pr.number}`, label: heartbeat });
    if (!v.ok) {
      const { ok: _ok, code, reason, ...facts } = v;
      return { ok: false, code, reason, facts, final: code === 1 || Array.isArray(facts.failures) };
    }
    const again = validation(ctx.sh, pr.headRefOid, context);
    if (again.state === 'failure' || again.state === 'error') {
      const why = again.description.slice(0, 200);
      return { ok: false, code: 2, reason: `${context} validation failed on pull request #${pr.number}${why ? `: ${why}` : ''}`, facts: {}, final: true };
    }
    ctx.event?.(
      v.skipped
        ? `Foreman, not Gearset, checked pull request #${pr.number} for ${stage.org} (${stage.name}): it changes no Salesforce metadata, so there was nothing to dry-run; merging it.`
        : `Foreman, not Gearset, validated pull request #${pr.number} against ${stage.org} (${stage.name}): job ${v.jobId}, ${v.tests.completed} tests run; merging it.`,
      'info',
    );
    return { ok: true, validated: v.skipped ? { skipped: true } : { jobId: v.jobId, components: v.components, tests: v.tests } };
  }

  // Gearset never started the validation, nudges or not: park the story with one plain task, for
  // the stages from this one through stopAt. `foreman release watch` merges the PR when the status
  // passes (check). The reason goes into a double-quoted argument, so it holds no quote, backtick,
  // dollar sign, brace or backslash: the Gearset names in it (a Gearset admin's text) are stripped
  // of those characters. The raw context is what the status lookups use.
  function stall(ctx, stage, l, pr, environment, context, nudges) {
    const sliced = stagesThrough(stage, l);
    if (sliced.error) return fail(1, sliced.error);
    const { stages } = sliced;
    const later = stages.slice(1).map((s) => s.name);
    const shown = plain(environment.name);
    const shownContext = plain(context);
    ctx.event?.(`${shownContext} has not validated pull request #${pr.number} after ${nudges} nudge${nudges === 1 ? '' : 's'}; ${ctx.story} is parked until it does.`, 'warn');
    const lead = `Gearset has not started validating pull request #${pr.number} for ${stageName}. In Gearset, open the pipeline, select the ${shown} environment and press Run validation on pull request #${pr.number}; Foreman merges it when ${shownContext} passes`;
    const reason = !later.length
      ? `${lead}, and the release finishes when Gearset has deployed it.`
      : (ctx.config.salesforce?.gearset?.validateLaterStages ?? 'foreman') === 'foreman'
        ? `${lead}, then validates and promotes ${andList(later)} itself, and the release finishes when Gearset has deployed it.`
        : `${lead}, then promotes ${andList(later)}, and the release finishes when Gearset has deployed it. Gearset never validates a later stage by itself, so press Run validation on the promotion pull request of ${andList(later)} too once Gearset opens it.`;
    return { ok: true, parked: { reason, check: { branch: ctx.branch, mode: 'merge', stages: stages.map((s) => ({ name: s.name, org: s.org, orgId: s.orgId, branch: s.branch })) } } };
  }

  // Merge mode, from the environment lookup to the confirmed deploy.
  async function merge(ctx, stage, fetch, l) {
    const token = gearsetToken(ctx.env ?? process.env);
    if (!token) return fail(1, `GEARSET_API_TOKEN is not set; ${name} reads stage ${stageName}'s Gearset environment from the Gearset Reporting API`);
    // The step's own limit counts the wait for a rate limit too.
    const minutes = ctx.config.ship?.ci?.timeoutMinutes ?? 30;
    let deadline = ctx.now().getTime() + minutes * 60_000;
    const told = (seconds, retryAt) => {
      ctx.event?.(`Gearset rate-limited ${name}; waiting ${seconds} seconds, as Gearset asked, then trying again (at ${retryAt}).`, 'info');
      ctx.report?.(`waiting for Gearset's rate limit until ${retryAt}`);
    };
    const read = await waitOutRateLimit(
      () => releaseEnvironments(ctx, { fetch, token, pipelineId: ctx.config.salesforce?.gearset?.pipelineId }),
      { now: ctx.now, sleep: ctx.sleep, deadline, told },
    );
    if (read.rateLimited) {
      return fail(1, `Gearset rate-limited ${name} until ${read.retryAt}, past the step's limit of ${plural(minutes)}; try the release again after ${read.retryAt}.`, { rateLimited: true, retryAt: read.retryAt });
    }
    if (!read.ok) return fail(1, read.error);
    const found = environmentFor(read.environments, stage.orgId);
    if (!found.ok) return fail(1, found.error);
    const environment = found.environment;
    const context = statusContext(environment.name);
    const head = promotionBranch(ctx.branch, stage.branch);
    // Gearset validates a PR into the first stage by itself and never one into a later stage, so
    // unless salesforce.gearset.validateLaterStages is "gearset", Foreman validates a later stage's
    // PR when Gearset has posted no status for it.
    const later = l.stages.indexOf(stage) > 0;
    const selfValidates = later && (ctx.config.salesforce?.gearset?.validateLaterStages ?? 'foreman') === 'foreman';
    let foremanValidates = false;

    // Wait for the promotion PR and its validation, unless it is merged already.
    deadline = ctx.now().getTime() + minutes * 60_000;
    let pr = null;
    let state = null;
    let lastError = '';
    // A status that has not appeared is nudged after nudgeMs, at most MAX_NUDGES times.
    const nudgeMinutes = ctx.config.salesforce?.gearset?.nudgeMinutes ?? NUDGE_MINUTES;
    const nudgeMs = nudgeMinutes * 60_000;
    let quietSince = null;
    let nudges = 0;
    for (;;) {
      ctx.report?.(label);
      const listed = findPromotion(ctx.sh, head, stage.branch);
      if (listed.error) lastError = listed.error;
      if (listed.pr) pr = listed.pr;
      if (listed.pr?.state === 'MERGED') break;
      if (listed.pr) {
        const v = validation(ctx.sh, listed.pr.headRefOid, context);
        if (v.error) lastError = v.error;
        else {
          state = v.state;
          if (state === 'success') break;
          if (state === 'failure' || state === 'error') {
            const why = v.description.slice(0, 200);
            return fail(2, `${context} validation failed on pull request #${pr.number}${why ? `: ${why}` : ''}`);
          }
          if (state !== null) quietSince = null;
          else if (listed.pr.state === 'OPEN') {
            const at = ctx.now().getTime();
            quietSince ??= at;
            if (at - quietSince >= nudgeMs) {
              if (selfValidates) {
                foremanValidates = true;
                break;
              }
              if (nudges >= MAX_NUDGES) return stall(ctx, stage, l, pr, environment, context, nudges);
              nudges += 1;
              nudge(ctx, { pr: listed.pr, head, context, n: nudges, minutes: nudgeMinutes });
              quietSince = ctx.now().getTime();
            }
          }
        }
      }
      if (ctx.now().getTime() >= deadline) {
        const ghError = lastError ? ` (${lastError})` : '';
        if (!pr) return fail(2, `Gearset did not open the ${stageName} promotion pull request (${head}) within ${plural(minutes)}${ghError}`);
        if (state === null && selfValidates && pr.state === 'OPEN' && quietSince !== null) {
          foremanValidates = true;
          break;
        }
        if (state === null) return stall(ctx, stage, l, pr, environment, context, nudges);
        return fail(2, `${context} validation did not finish within ${plural(minutes)} on pull request #${pr.number}${ghError}`);
      }
      await ctx.sleep(POLL_MS);
    }

    // Gearset posted no status: Foreman's own dry run against the stage's org, of this very head.
    // Gearset's status on that head still wins, and the merge below is pinned to this head.
    let validatedBy = pr.state === 'MERGED' ? null : 'gearset';
    let validated = null;
    if (foremanValidates) {
      validatedBy = 'foreman';
      ctx.event?.(`Gearset posted no ${plain(context)} status on pull request #${pr.number} after ${plural(Math.round((ctx.now().getTime() - quietSince) / 60_000))}, as it does not validate a later stage by itself; Foreman is validating it against ${stage.org} (${stage.name}) instead.`, 'info');
      const v = await foremanValidate(ctx, { stage, head, pr, context, label });
      if (!v.ok) return fail(v.code, v.reason, { validatedBy, ...v.facts });
      validated = v.validated;
    }

    // Merge it: a merge commit of exactly the head that was validated.
    if (pr.state !== 'MERGED') {
      const before = ctx.now().toISOString();
      const r = ctx.sh('gh', ['pr', 'merge', String(pr.number), '--merge', '--match-head-commit', String(pr.headRefOid)]) ?? {};
      const after = findPromotion(ctx.sh, head, stage.branch);
      if (after.pr?.state === 'MERGED') pr = after.pr;
      else if (r.status !== 0) return fail(1, `Could not merge promotion pull request #${pr.number}: ${said(r)}`);
      else pr = { ...pr, state: 'MERGED' };
      if (!(typeof pr.mergedAt === 'string' && pr.mergedAt)) pr = { ...pr, mergedAt: before };
    }

    // Confirm the deploy. The merge cannot be undone, so every failure from here is code 5.
    const iso = isoFor(ctx);
    const promoted = (via, deployId, testsCompleted) => {
      if (testsCompleted === 0) ctx.event?.(`Gearset deployed ${stageName} with no Apex tests run; set a test level on its CI job`, 'warn');
      const record = { org: stage.org, pr: pr.url, prNumber: pr.number, mergedAt: pr.mergedAt, via, deployId, testsCompleted, ...(validatedBy ? { validatedBy } : {}), ...(validated ? { validation: validated } : {}) };
      return { ok: true, noReturn: true, gearsetPromotions: { ...(ctx.gearsetPromotions ?? {}), [stageName]: record } };
    };
    deadline = ctx.now().getTime() + minutes * 60_000;
    let nextAskAt = null;
    let detail = '';
    for (;;) {
      ctx.report?.(label);
      const org = orgDeploy(iso, stage, pr.mergedAt);
      if (org.state === 'deployed') return promoted('org', org.deployId, org.testsCompleted);
      if (org.state === 'stopped') return fail(5, `Stopped watching the deploys in ${stage.org} (${stageName}) for pull request #${pr.number}: ${org.detail}`, { noReturn: true });
      detail = org.detail;
      if (nextAskAt === null || ctx.now().getTime() >= nextAskAt) {
        const askedAt = ctx.now().getTime();
        const hit = await reportingDeploy({ fetch, token, environment, prNumber: pr.number, branch: stage.branch, mergedAt: pr.mergedAt, now: ctx.now(), sleep: ctx.sleep });
        if (hit.state === 'deployed') return promoted('gearset', hit.deployment.salesforceDeploymentId, null);
        if (hit.state === 'failed') return fail(5, `Gearset's deploy of pull request #${pr.number} to ${environment.name} failed`, { noReturn: true });
        if (hit.state === 'error') detail = `${detail}; ${hit.detail}`;
        // Gearset's Retry-After can push the next question past the usual spacing.
        nextAskAt = askedAt + Math.max(REPORTING_EVERY_MS, Math.min(MAX_RATE_LIMIT_WAIT_MS, hit.retryAfterMs ?? 0));
        if (nextAskAt > askedAt + REPORTING_EVERY_MS) {
          ctx.event?.(`Gearset rate-limited ${name}; asking it about the deploy again after ${new Date(nextAskAt).toISOString()}`, 'info');
        }
      }
      if (ctx.now().getTime() >= deadline) {
        return fail(5, `Gearset has not deployed pull request #${pr.number} to ${stageName} within ${plural(minutes)} of the merge: ${detail}`, { noReturn: true });
      }
      await ctx.sleep(POLL_MS);
    }
  }

  // Owner mode: park the release for the Promote clicks, through stopAt.
  function park(ctx, stage, l) {
    const sliced = stagesThrough(stage, l);
    if (sliced.error) return fail(1, sliced.error);
    const { stages } = sliced;
    const { pr } = findPromotion(ctx.sh, promotionBranch(ctx.branch, stage.branch), stage.branch);
    const later = stages.slice(1).map((s) => s.name);
    const reason = `Click Promote in Gearset for ${stageName}${prName(pr)}${later.length ? `, then ${later.join(', then ')}` : ''}; the release finishes when Gearset has deployed it`;
    const check = { branch: ctx.branch, stages: stages.map((s) => ({ name: s.name, org: s.org, orgId: s.orgId, branch: s.branch })) };
    return { ok: true, parked: { reason, check } };
  }

  return {
    name,
    label,
    needs: ['gh', 'sf', 'git'],
    requires: { env: ['GEARSET_API_TOKEN'] },
    halts: true,
    deploys: true,
    mayMarkNoReturn: true,

    async run(ctx, deps = {}) {
      const fetch = deps.fetch ?? ctx.fetch ?? globalThis.fetch;
      const l = layout(ctx.config.salesforce, ctx.config);
      const stage = l.stages.find((s) => s.name === stageName) ?? null;
      const why = refusal(stage, stageName, l);
      if (why) return fail(1, why);
      const mode = ctx.config.salesforce?.gearset?.promote ?? 'merge';
      return mode === 'owner' ? park(ctx, stage, l) : merge(ctx, stage, fetch, l);
    },

    // The parked release, checked by `foreman release watch`. See registry.mjs for the answers.
    async check(ctx, deps = {}) {
      const fetch = deps.fetch ?? ctx.fetch ?? globalThis.fetch;
      const stored = isObject(ctx.check) ? ctx.check : {};
      const stages = Array.isArray(stored.stages) ? stored.stages.filter(isObject) : [];
      if (!stages.length || typeof stored.branch !== 'string') return { ok: false, reason: `the ${name} park holds no stages to check` };
      const l = layout(ctx.config.salesforce, ctx.config);
      for (const s of stages) {
        const now = l.orgs[s.org];
        if (!now || now.orgId !== s.orgId) return { ok: false, reason: `${s.org} (stage ${s.name}) is no longer in salesforce.orgs with org ID ${s.orgId}; the release is not checked against another org` };
        if (s.branch === l.productionBranch) return { ok: false, reason: `stage ${s.name} is on ${s.branch}, the production branch; production is never a target` };
      }

      // Gearset never validates a later stage by itself: with the default setting Foreman does.
      const selfValidates = (s) => (ctx.config.salesforce?.gearset?.validateLaterStages ?? 'foreman') === 'foreman' && l.stages.findIndex((x) => x.name === s.name) > 0;
      const token = gearsetToken(ctx.env ?? process.env);
      const iso = isoFor(ctx);
      let environments = null;
      const done = [];
      const untested = [];
      for (const s of stages) {
        const found = findPromotion(ctx.sh, promotionBranch(stored.branch, s.branch), s.branch);
        if (found.error) return { ok: true, done: false, detail: `could not read the ${s.name} promotion pull request: ${found.error}` };
        let pr = found.pr;
        if (!pr) return { ok: true, done: false, detail: `waiting for Gearset to open the ${s.name} promotion pull request` };
        if (pr.state !== 'MERGED') {
          if (stored.mode !== 'merge') return { ok: true, done: false, detail: `waiting for you to click Promote for ${s.name} in Gearset (pull request #${pr.number})` };
          const waiting = (detail) => ({ ok: true, done: false, detail });
          if (!token) return waiting(`GEARSET_API_TOKEN is not set; Foreman needs it to read Gearset's validation of pull request #${pr.number} for ${s.name}`);
          environments ??= await gearsetEnvironments({ fetch, token, pipelineId: ctx.config.salesforce?.gearset?.pipelineId });
          if (!environments.ok) return waiting(environments.error);
          const env = environmentFor(environments.environments, s.orgId);
          if (!env.ok) return isProduction(environments.environments, s.orgId) ? { ok: false, reason: env.error } : waiting(env.error);
          const context = statusContext(env.environment.name);
          const v = validation(ctx.sh, pr.headRefOid, context);
          if (v.error) return waiting(v.error);
          if (v.state === 'failure' || v.state === 'error') {
            const why = v.description.slice(0, 200);
            return { ok: false, reason: `${context} validation failed on pull request #${pr.number}${why ? `: ${why}` : ''}` };
          }
          let byForeman = false;
          if (v.state === null && selfValidates(s)) {
            // Gearset never validates a later stage by itself, so Foreman does, as the run does.
            ctx.event?.(`Gearset posted no ${plain(context)} status on pull request #${pr.number}, as it does not validate a later stage by itself; Foreman is validating it against ${s.org} (${s.name}) instead.`, 'info');
            const own = await foremanValidate(ctx, { stage: s, head: promotionBranch(stored.branch, s.branch), pr, context, label: `promoting to ${s.name} through Gearset` });
            if (!own.ok) return own.final ? { ok: false, reason: own.reason } : waiting(own.reason);
            byForeman = true;
          } else if (v.state === null) return waiting(`waiting for ${context} on pull request #${pr.number}: in Gearset, press Run validation on it in the ${env.environment.name} environment`);
          else if (v.state !== 'success') return waiting(`waiting for ${context} to finish validating pull request #${pr.number}`);
          // Validated: merge exactly the head that was validated, as the run does.
          const r = ctx.sh('gh', ['pr', 'merge', String(pr.number), '--merge', '--match-head-commit', String(pr.headRefOid)]) ?? {};
          const after = findPromotion(ctx.sh, promotionBranch(stored.branch, s.branch), s.branch);
          if (after.pr?.state !== 'MERGED') return waiting(`could not merge promotion pull request #${pr.number} yet: ${said(r)}`);
          pr = after.pr;
          ctx.event?.(`Merged Gearset's ${s.name} promotion pull request #${pr.number} for ${ctx.story} once ${byForeman ? "Foreman's validation" : context} passed.`, 'info');
        }

        const org = orgDeploy(iso, s, pr.mergedAt);
        if (org.state === 'deployed') {
          done.push(`${s.name} (pull request #${pr.number})`);
          if (org.testsCompleted === 0) untested.push(s.name);
          continue;
        }
        let detail = org.detail;
        if (token) {
          environments ??= await gearsetEnvironments({ fetch, token, pipelineId: ctx.config.salesforce?.gearset?.pipelineId });
          if (!environments.ok) detail = `${detail}; ${environments.error}`;
          else {
            const env = environmentFor(environments.environments, s.orgId);
            if (!env.ok && isProduction(environments.environments, s.orgId)) return { ok: false, reason: env.error };
            if (!env.ok) detail = `${detail}; ${env.error}`;
            else {
              const hit = await reportingDeploy({ fetch, token, environment: env.environment, prNumber: pr.number, branch: s.branch, mergedAt: pr.mergedAt, now: ctx.now(), sleep: ctx.sleep });
              if (hit.state === 'deployed') {
                done.push(`${s.name} (pull request #${pr.number})`);
                continue;
              }
              if (hit.state === 'failed') return { ok: false, reason: `Gearset's deploy of pull request #${pr.number} to ${env.environment.name} failed` };
              if (hit.state === 'error') detail = `${detail}; ${hit.detail}`;
            }
          }
        }
        return { ok: true, done: false, detail: `waiting for Gearset to deploy pull request #${pr.number} to ${s.name} (${detail})` };
      }
      const note = `Gearset deployed ${andList(done)}${untested.length ? `, with no Apex tests run in ${andList(untested)}` : ''}`;
      return { ok: true, done: true, note };
    },
  };
}

const made = new Map();

export function gearsetPromote(stageName) {
  if (!made.has(stageName)) made.set(stageName, make(stageName));
  return made.get(stageName);
}
