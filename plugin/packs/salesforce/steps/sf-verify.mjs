// Ship step `sf-verify-<stage>`: checks a stage's org after sf-deploy-<stage>. sfVerify(stageName)
// gives the step for that stage, the same module on every call; sfVerify(stageName, { later:
// true }) gives a later stage's, the same step marked noRollback, with the same healthy(), so a
// failure there halts and never rolls back. verifyStep(stageName, checks) makes a fresh one,
// for tests. It halts on failure. It deploys no metadata itself, but the Agentforce check
// publishes and activates the agents the story changed.
//
//   1. the stage is marked reached for the story (releases.mjs)
//   2. the deploy from sf-deploy-<stage> (ctx.sfDeploys). A skipped deploy passes, with no sf call.
//   3. the org's newest real deploy: DEPLOY_QUERY on the Tooling API, through the isolated sf
//      home. It must be Foreman's job, compared on 15 characters. CheckOnly = false keeps out
//      the dry runs other slots validate there.
//   4. the post-deploy checks in POST_DEPLOY_CHECKS that apply to the config, in order. Each is
//      { name, applies(config) -> boolean, run({ ctx, sh, stage }) -> { ok, reason?,
//      changedOrg?, notes? } }. The list holds the Agentforce check (agentforce.mjs), which
//      validates, publishes, activates and tests each changed agent; the OmniStudio check joins
//      it later. notes are plain lines for the owner, such as an agent reply the judge scored low.
//   5. once a check changed the org (changedOrg: true, on success or on failure), DEPLOY_QUERY
//      again, after the last check or right after a failed one: a publish deploys the agent
//      bundle, so the org's newest real deploy is now the publish. When the stage's last deploy
//      record is this story's, its jobId moves to that deploy (commit, story and at kept), so
//      healthy() does not take the publish for a foreign deploy. That deploy must have finished
//      no earlier than the start of the first check that changed the org; one that finished
//      before, or has no readable CompletedDate, is refused and the record stays. On a failed
//      check, a problem with the re-read is added to the check's reason.
//
// Every failure is code 5. Facts: sfVerify, with { org, jobId, checks: [names run], notes? } (or
// { org, skipped: true }) added under the stage's name; notes only when a check gave some. The
// notes also go into manualSteps, after the ones already there (sf-delta's): facts replace by
// key, and the story note lists manualSteps.
//
// healthy(), for `foreman health`, has no story and no facts. It reads the stage's last deploy
// from releases.mjs (none: nothing to check), and asks whether the stage's branch, fetched from
// the remote, is still at that deploy's commit, and whether the org still has that deploy: the
// newest real deploy on a stage of its own, or, on a stage that shares the build org (where the
// next story's builder deploys), that job's own Status. A failure that a fix by hand can clear
// ends with the command for it: markFixed, `foreman sf fixed <stage>`, records the branch head and
// the org's newest real deploy as the stage's last deploy, after checking the org's identity.
//
// It never passes --ignore-*, `quick` or NoTestRun. A message names only aliases, stages, job
// IDs and shas, plus sf's own error message; never an sf result.

import os from 'node:os';
import { stateDir } from '../../../lib/engine/paths.mjs';
import { agentforceCheck } from '../agentforce.mjs';
import { layout } from '../config.mjs';
import { JOB_ID } from '../deploy-result.mjs';
import { homeProblem, isolatedSh, orgQuery, sfHome } from '../isolation.mjs';
import { markReached, readDeployed, writeDeployed } from '../releases.mjs';
import { runSf } from '../sf.mjs';

export const POST_DEPLOY_CHECKS = [agentforceCheck];

export const DEPLOY_QUERY = "SELECT Id, Status, CompletedDate FROM DeployRequest WHERE Status = 'Succeeded' AND CheckOnly = false ORDER BY CompletedDate DESC LIMIT 1";

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const id15 = (v) => (typeof v === 'string' ? v.slice(0, 15) : '');
const short = (sha) => (typeof sha === 'string' && sha ? sha.slice(0, 7) : 'an unknown commit');
const message = (err) => err?.message ?? String(err);

// The first record of a query result, or null.
function firstRecord(result) {
  const records = isObject(result) && Array.isArray(result.records) ? result.records : [];
  return isObject(records[0]) ? records[0] : null;
}

// A deploy record's Id, when it is one, for a message; never anything else from the result.
const seenId = (record) => (record && typeof record.Id === 'string' && JOB_ID.test(record.Id) ? record.Id : 'none');

const queryIn = (iso, query, org) => runSf(iso, ['data', 'query', '--use-tooling-api', '--query', query, '--target-org', org]);

const isoFor = (sh, env) => isolatedSh(sh, env, sfHome(env, os.homedir()), os.homedir());

// The branch's head on the remote, fetched first, or '' when git cannot read it.
function branchHead(sh, root, remote, branch) {
  const fetched = sh('git', ['fetch', '--quiet', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`], { cwd: root }) ?? {};
  const head = fetched.status === 0 ? sh('git', ['rev-parse', '--verify', `refs/remotes/${remote}/${branch}`], { cwd: root }) ?? {} : {};
  return head.status === 0 ? String(head.stdout ?? '').trim() : '';
}

// `foreman sf fixed <stage>`: after the owner fixed a halted stage by hand (deployed the branch,
// or reverted it), records the stage's last deploy as the branch head and the org's newest real
// deploy, so healthy() passes and the halt can be cleared. The org's identity is checked first,
// as sandbox-pool does: a sandbox with the org ID salesforce.orgs gives it. Returns { ok: true,
// stage, org, commit, jobId } or { ok: false, reason }, and records nothing on a failure.
export async function markFixed({ root, config, env = process.env, sh, stage: stageName, now = () => new Date() }) {
  const stage = layout(config.salesforce, config).stages.find((s) => s.name === stageName);
  if (!stage) return { ok: false, reason: `The salesforce block has no stage named ${stageName}.` };
  const home = sfHome(env, os.homedir());
  const problem = homeProblem(env, home);
  if (problem) return { ok: false, reason: problem };
  const where = `${stage.org} (${stageName})`;

  const commit = branchHead(sh, root, config.remote, stage.branch);
  if (!commit) return { ok: false, reason: `could not read ${stage.branch}` };

  const iso = isolatedSh(sh, env, home, os.homedir());
  const who = orgQuery(iso, stage.org);
  if (!who.ok) return { ok: false, reason: `could not check ${stage.org}: ${who.error.message}` };
  const org = firstRecord(who.result) ?? {};
  if (org.IsSandbox !== true) return { ok: false, reason: `${stage.org} is not a sandbox; production is never a target` };
  if (!stage.orgId || id15(org.Id) !== id15(stage.orgId)) return { ok: false, reason: `${stage.org} is org ${id15(org.Id)}, not ${stage.orgId}` };

  const q = queryIn(iso, DEPLOY_QUERY, stage.org);
  if (!q.ok) return { ok: false, reason: `Could not check the last deploy in ${where}: ${q.error.message}` };
  const jobId = seenId(firstRecord(q.result));
  if (jobId === 'none') return { ok: false, reason: `${where} has no deploy to record.` };

  writeDeployed(stateDir(root, config, env), { stage: stageName, org: stage.org, orgId: stage.orgId, jobId, story: null, commit, at: now().toISOString() });
  return { ok: true, stage: stageName, org: stage.org, commit, jobId };
}

export function verifyStep(stageName, checks = POST_DEPLOY_CHECKS) {
  const name = `sf-verify-${stageName}`;
  const fail = (reason) => ({ ok: false, code: 5, stage: name, reason });

  return {
    name,
    label: `checking ${stageName} after the Salesforce deploy`,
    needs: ['sf'],
    halts: true,

    async run(ctx) {
      const stage = layout(ctx.config.salesforce, ctx.config).stages.find((s) => s.name === stageName);
      if (!stage) return fail(`The salesforce block has no stage named ${stageName}.`);
      const env = ctx.env ?? process.env;
      markReached(stateDir(ctx.root, ctx.config, env), ctx.story, stageName, ctx.sfDelta?.to ?? null);

      const done = { ...(ctx.sfVerify ?? {}) };
      const d = ctx.sfDeploys?.[stageName];
      if (!isObject(d)) return fail(`sf-deploy-${stageName} must run first.`);
      if (d.skipped) return { ok: true, sfVerify: { ...done, [stageName]: { org: stage.org, skipped: true } } };

      const where = `${stage.org} (${stageName})`;
      const iso = isoFor(ctx.sh, env);
      const q = queryIn(iso, DEPLOY_QUERY, stage.org);
      if (!q.ok) return fail(`Could not check the last deploy in ${where}: ${q.error.message}`);
      const newest = firstRecord(q.result);
      if (!newest || id15(newest.Id) !== id15(d.jobId)) return fail(`The newest deploy in ${where} is ${seenId(newest)}, not Foreman's ${d.jobId}.`);

      // After a check changed the org: moves this story's stage record to the org's newest real
      // deploy, when that finished no earlier than `since`. Null when all is well, or the problem.
      const adopt = (since) => {
        const again = queryIn(iso, DEPLOY_QUERY, stage.org);
        if (!again.ok) return `Could not check the last deploy in ${where} after publishing agents: ${again.error.message}`;
        const latest = firstRecord(again.result);
        if (seenId(latest) === 'none' || id15(latest.Id) === id15(d.jobId)) return null;
        const state = stateDir(ctx.root, ctx.config, env);
        const rec = readDeployed(state, stageName);
        if (rec?.story !== ctx.story) return null;
        const finished = Date.parse(latest.CompletedDate);
        if (!Number.isFinite(finished) || finished < since) {
          return `The newest deploy in ${where} is ${latest.Id}, which finished before the agents were published, so it is not taken as Foreman's.`;
        }
        writeDeployed(state, { ...rec, jobId: latest.Id });
        return null;
      };

      const ran = [];
      const notes = [];
      let since = null;
      for (const check of checks) {
        if (!check.applies(ctx.config)) continue;
        const startedAt = (ctx.now?.() ?? new Date()).getTime();
        let r;
        try {
          r = await check.run({ ctx, sh: iso, stage });
        } catch (err) {
          r = { ok: false, reason: message(err) };
        }
        if (r?.changedOrg === true && since === null) since = startedAt;
        if (r?.ok !== true) {
          const reason = `${check.name}: ${r?.reason ?? 'failed'}`;
          const problem = since !== null ? adopt(since) : null;
          return fail(problem ? `${reason}; ${problem}` : reason);
        }
        if (Array.isArray(r.notes)) notes.push(...r.notes.filter((n) => typeof n === 'string' && n));
        ran.push(check.name);
      }

      if (since !== null) {
        const problem = adopt(since);
        if (problem) return fail(problem);
      }
      const verified = { org: stage.org, jobId: d.jobId, checks: ran, ...(notes.length ? { notes } : {}) };
      return { ok: true, sfVerify: { ...done, [stageName]: verified }, ...(notes.length ? { manualSteps: [...(ctx.manualSteps ?? []), ...notes] } : {}) };
    },

    async healthy(ctx) {
      const stage = layout(ctx.config.salesforce, ctx.config).stages.find((s) => s.name === stageName);
      if (!stage) return null;
      const env = ctx.env ?? process.env;
      const rec = readDeployed(stateDir(ctx.root, ctx.config, env), stageName);
      if (!rec) return null;
      const where = `${stage.org} (${stageName})`;

      const fixed = ` Once it is fixed by hand, run: foreman sf fixed ${stageName}`;
      if (rec.commit) {
        const sha = branchHead(ctx.sh, ctx.root, ctx.config.remote, stage.branch);
        if (!sha) return { ok: false, reason: `could not read ${stage.branch}` };
        if (sha !== rec.commit) return { ok: false, reason: `${stage.branch} is at ${short(sha)} but ${where} last got ${short(rec.commit)} from Foreman.${fixed}` };
      }

      const iso = isoFor(ctx.sh, env);
      if (stage.shared) {
        if (typeof rec.jobId !== 'string' || !JOB_ID.test(rec.jobId)) return { ok: false, reason: `${where} has no deploy job of Foreman's to check.${fixed}` };
        const q = queryIn(iso, `SELECT Id, Status FROM DeployRequest WHERE Id = '${rec.jobId}'`, stage.org);
        if (!q.ok) return { ok: false, reason: `Could not check the last deploy in ${where}: ${q.error.message}` };
        const job = firstRecord(q.result);
        if (job?.Status !== 'Succeeded') return { ok: false, reason: `Foreman's last deploy to ${where}, ${rec.jobId}, did not succeed there.${fixed}` };
      } else {
        const q = queryIn(iso, DEPLOY_QUERY, stage.org);
        if (!q.ok) return { ok: false, reason: `Could not check the last deploy in ${where}: ${q.error.message}` };
        const newest = firstRecord(q.result);
        if (!newest || id15(newest.Id) !== id15(rec.jobId)) {
          return { ok: false, reason: `The newest deploy in ${where} is ${seenId(newest)}, not Foreman's ${rec.jobId}.${fixed}` };
        }
      }
      return { ok: true, reason: `${where} has Foreman's last deploy, ${short(rec.commit)}.` };
    },
  };
}

const made = new Map();

export function sfVerify(stageName, { later = false } = {}) {
  if (!made.has(stageName)) made.set(stageName, verifyStep(stageName));
  if (!later) return made.get(stageName);
  const key = `${stageName}:later`;
  if (!made.has(key)) made.set(key, { ...made.get(stageName), noRollback: true });
  return made.get(key);
}
