// Ship step `gearset-promote-<stage>`, on the gearset release path, one per stage up to stopAt.
// gearsetPromote(stageName) gives the step for that stage, the same module on every call. Gearset
// opens a promotion PR from gs-pipeline/<story branch>_-_<stage branch> into the stage's branch,
// validates it with the commit status "Gearset <environment name>", and its CI job deploys a
// merge of it to the stage's org. salesforce.gearset.promote says who merges it:
//
//   merge (default)  this step. It reads the stage org's Gearset environment through the
//                    Reporting API, in salesforce.gearset.pipelineId's pipeline or in every
//                    pipeline when that is unset (so GEARSET_API_TOKEN is needed, and Gearset's
//                    production environment is refused), then every 20 seconds until ship.ci.timeoutMinutes
//                    (default 30) re-finds the promotion PR (OPEN before MERGED, CLOSED ignored)
//                    and reads that environment's status only. success: it merges with
//                    `gh pr merge <n> --merge --match-head-commit <sha>` and nothing else, since
//                    Gearset takes merge commits only and owns the gs-pipeline branches.
//                    failure, error or the deadline is code 2, with nothing merged. A PR already
//                    MERGED (a re-run after a crash) is not merged again. After the merge it
//                    confirms the deploy, every 20 seconds until a new deadline as long: a
//                    DeployRequest in the stage's org that is not check-only, Succeeded, and
//                    finished after the merge, or, at most every 3 minutes, the Reporting API
//                    listing the promotion PR as deployed to the environment. A merged release
//                    cannot be undone, so the result carries noReturn and any later failure is
//                    code 5: the Reporting API listing the deploy as failed, or no confirmation
//                    by the deadline. A Failed DeployRequest is not taken as the story's
//                    failure, because another person's deploy may be in that org. Facts:
//                    gearsetPromotions, with { org, pr, prNumber, mergedAt, via: 'org' |
//                    'gearset', deployId, testsCompleted } added under the stage's name. A
//                    deploy that ran no Apex tests is a warn event.
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
// through ctx.sh, sf through the isolated sf home. Reasons, details and notes name stages, orgs,
// pull request numbers and URLs, and Gearset environment names: never a token, a header or a
// URL query. It imports neither the core pr nor merge step (both lead back to the config
// validator, which loads this pack), nor gearset-pr's helpers.

import os from 'node:os';
import { layout } from '../config.mjs';
import { deploymentOfPr, environmentFor, gearsetDeployments, gearsetEnvironments, gearsetToken, promotionBranch, statusContext } from '../gearset.mjs';
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
// answer, or { state: 'error', detail }.
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
  if (!listed.ok) return { state: 'error', detail: listed.error };
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

  // Merge mode, from the environment lookup to the confirmed deploy.
  async function merge(ctx, stage, fetch) {
    const token = gearsetToken(ctx.env ?? process.env);
    if (!token) return fail(1, `GEARSET_API_TOKEN is not set; ${name} reads stage ${stageName}'s Gearset environment from the Gearset Reporting API`);
    const read = await gearsetEnvironments({ fetch, token, pipelineId: ctx.config.salesforce?.gearset?.pipelineId });
    if (!read.ok) return fail(1, read.error);
    const found = environmentFor(read.environments, stage.orgId);
    if (!found.ok) return fail(1, found.error);
    const environment = found.environment;
    const context = statusContext(environment.name);
    const head = promotionBranch(ctx.branch, stage.branch);
    const minutes = ctx.config.ship?.ci?.timeoutMinutes ?? 30;

    // Wait for the promotion PR and its validation, unless it is merged already.
    let deadline = ctx.now().getTime() + minutes * 60_000;
    let pr = null;
    let state = null;
    let lastError = '';
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
        }
      }
      if (ctx.now().getTime() >= deadline) {
        const ghError = lastError ? ` (${lastError})` : '';
        if (!pr) return fail(2, `Gearset did not open the ${stageName} promotion pull request (${head}) within ${plural(minutes)}${ghError}`);
        if (state === null) return fail(2, `${context} has not validated pull request #${pr.number} within ${plural(minutes)}${ghError}`);
        return fail(2, `${context} validation did not finish within ${plural(minutes)} on pull request #${pr.number}${ghError}`);
      }
      await ctx.sleep(POLL_MS);
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
      const record = { org: stage.org, pr: pr.url, prNumber: pr.number, mergedAt: pr.mergedAt, via, deployId, testsCompleted };
      return { ok: true, noReturn: true, gearsetPromotions: { ...(ctx.gearsetPromotions ?? {}), [stageName]: record } };
    };
    deadline = ctx.now().getTime() + minutes * 60_000;
    let askedAt = null;
    let detail = '';
    for (;;) {
      ctx.report?.(label);
      const org = orgDeploy(iso, stage, pr.mergedAt);
      if (org.state === 'deployed') return promoted('org', org.deployId, org.testsCompleted);
      if (org.state === 'stopped') return fail(5, `Stopped watching the deploys in ${stage.org} (${stageName}) for pull request #${pr.number}: ${org.detail}`, { noReturn: true });
      detail = org.detail;
      if (askedAt === null || ctx.now().getTime() - askedAt >= REPORTING_EVERY_MS) {
        askedAt = ctx.now().getTime();
        const hit = await reportingDeploy({ fetch, token, environment, prNumber: pr.number, branch: stage.branch, mergedAt: pr.mergedAt, now: ctx.now(), sleep: ctx.sleep });
        if (hit.state === 'deployed') return promoted('gearset', hit.deployment.salesforceDeploymentId, null);
        if (hit.state === 'failed') return fail(5, `Gearset's deploy of pull request #${pr.number} to ${environment.name} failed`, { noReturn: true });
        if (hit.state === 'error') detail = `${detail}; ${hit.detail}`;
      }
      if (ctx.now().getTime() >= deadline) {
        return fail(5, `Gearset has not deployed pull request #${pr.number} to ${stageName} within ${plural(minutes)} of the merge: ${detail}`, { noReturn: true });
      }
      await ctx.sleep(POLL_MS);
    }
  }

  // Owner mode: park the release for the Promote clicks, through stopAt.
  function park(ctx, stage, l) {
    const from = l.stages.indexOf(stage);
    const to = l.stages.findIndex((s) => s.name === l.stopAt);
    const stages = to >= from ? l.stages.slice(from, to + 1) : [];
    if (stages.length === 0) return fail(1, `Stage ${stageName} comes after stopAt ${l.stopAt ?? 'none'}; there is nothing to promote.`);
    for (const s of stages) {
      const why = refusal(s, s.name, l);
      if (why) return fail(1, why);
    }
    const { pr } = findPromotion(ctx.sh, promotionBranch(ctx.branch, stage.branch), stage.branch);
    const later = stages.slice(1).map((s) => s.name);
    const reason = `Click Promote in Gearset for ${stageName}${prName(pr)}${later.length ? `, then ${later.join(', then ')}` : ''}; the release finishes when Gearset has deployed it`;
    const check = { branch: ctx.branch, stages: stages.map((s) => ({ name: s.name, org: s.org, orgId: s.orgId, branch: s.branch })) };
    return { ok: true, parked: { reason, check } };
  }

  return {
    name,
    label,
    needs: ['gh', 'sf'],
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
      return mode === 'owner' ? park(ctx, stage, l) : merge(ctx, stage, fetch);
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

      const token = gearsetToken(ctx.env ?? process.env);
      const iso = isoFor(ctx);
      let environments = null;
      const done = [];
      const untested = [];
      for (const s of stages) {
        const found = findPromotion(ctx.sh, promotionBranch(stored.branch, s.branch), s.branch);
        if (found.error) return { ok: true, done: false, detail: `could not read the ${s.name} promotion pull request: ${found.error}` };
        const pr = found.pr;
        if (!pr) return { ok: true, done: false, detail: `waiting for Gearset to open the ${s.name} promotion pull request` };
        if (pr.state !== 'MERGED') return { ok: true, done: false, detail: `waiting for you to click Promote for ${s.name} in Gearset (pull request #${pr.number})` };

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
