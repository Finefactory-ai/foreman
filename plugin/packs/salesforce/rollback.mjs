// `foreman sf rollback <story id>`: puts stage 1's org and branch back the way they were before
// the story's merge. It is the sf path's ship.rollback.command (config.mjs), so the ship runner
// runs it when a step fails after sf-deploy-<stage 1> succeeded; HALT stays either way.
//
// It reverts metadata only, never data, and only on stage 1: the stages after it are shared with
// people (UAT), so a story that reached one is refused and releases stay halted. In the
// one-sandbox layout stage 1's org is the build org; the next lease resets its tracking.
//
// Refusals, each before any git or sf call, in order: a release path other than "sf"; no
// stage; no first deploy recorded for the story (releases.mjs); a story that reached a later
// stage; a story already rolled back; a stage 1 org other than the one the deploy went to; an
// unknown merge commit, or a rebase merge (nothing single to revert); a branch that is
// productionBranch; an isolated sf home that is not an absolute path. Then the org's identity:
// it must be a sandbox and the org salesforce.orgs names, as sandbox-pool checks it.
//
// Then, in a temporary worktree of the branch fetched from the remote, never the project's own
// checkout: the merge must still be on the branch; `git revert` it (-m 1 for a merge commit);
// build the reverse delta from the merge to its revert with sfdx-git-delta (sf-delta.mjs), so
// what the story changed or deleted comes back and what it added goes into the post-destructive
// changes, except Flows and RecordTypes, which become manual steps; deploy that to stage 1's org
// with testLevel.deploy and wait for it (the heartbeat goes through `report`); then put back the
// agents the story published on stage 1 (agentforce.mjs restoreAgents: reactivate each previous
// version, or deactivate an agent the story created), even when the reverse delta was empty;
// and only when that succeeded too, push the revert to the branch. A failure up to and
// including the deploy leaves the branch and the org as they were. Then the stage's last deploy
// is the revert, so `foreman health` matches the branch, and the story is marked rolled back.
// When the org was changed but the revert is not on the branch (the push failed, the deploy
// outlived the wait, or an agent could not be restored), the stage's last deploy is the revert
// too, and the story is not marked: health fails until the owner does by hand what the message
// says (for an agent, its sf command, then the push), and passes once they have.
//
// rollBack never throws for an expected failure. Every sf call goes through the isolated sf home;
// git runs with the real HOME. It never passes --ignore-*, `quick` or NoTestRun. A message names
// only aliases, org IDs, stages, branches, shas, metadata types and members, plus git's or sf's
// own error message; never an sf result.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stateDir } from '../../lib/engine/paths.mjs';
import { restoreAgents } from './agentforce.mjs';
import { BLOCK_DEFAULTS, BRANCH, TEST_LEVELS, layout } from './config.mjs';
import { FINAL, JOB_ID, summary, waitForJob } from './deploy-result.mjs';
import { manifestTypes } from './env/sandbox-pool.mjs';
import { homeProblem, isolatedSh, orgQuery, sfHome } from './isolation.mjs';
import { readRelease, recordRollback, writeDeployed } from './releases.mjs';
import { runSf } from './sf.mjs';
import { buildDelta, sgdProblem } from './steps/sf-delta.mjs';
import { problems } from './steps/sf-validate.mjs';

const START_TIMEOUT_MS = 600_000;
const MINUTES = 30;
const SHA = /^[0-9a-f]{7,64}$/i;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const id15 = (v) => (typeof v === 'string' ? v.slice(0, 15) : '');
const short = (sha) => String(sha ?? '').slice(0, 7);
const pick = (v, list, fallback) => (list.includes(v) ? v : fallback);
const firstLine = (text) => String(text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? 'git gave no reason';
const refuse = (reason) => ({ ok: false, refused: true, reason });
const fail = (reason) => ({ ok: false, reason });

// What the manifest holds, as a sorted list of { type, member }.
function components(file) {
  return Object.entries(manifestTypes(file))
    .flatMap(([type, members]) => members.map((member) => ({ type, member })))
    .sort((a, b) => compare(a.type, b.type) || compare(a.member, b.member));
}

export async function rollBack({ root, config, env = process.env, sh, story, now = () => new Date(), sleep, report = () => {} }) {
  const block = config?.salesforce;
  const release = isObject(block) && block.release !== undefined ? block.release : BLOCK_DEFAULTS.release;
  if (release !== 'sf') return refuse('rollback is only for release "sf"');
  const l = layout(block, config);
  const first = l.stages[0];
  if (!first) return refuse('the salesforce block has no stage to roll back');

  const state = stateDir(root, config, env);
  const rec = readRelease(state, story);
  if (!rec || !isObject(rec.first)) return refuse(`No deploy of ${story} to ${first.name} is recorded; nothing to roll back.`);
  const reached = Array.isArray(rec.reached) ? rec.reached : [];
  const later = reached.filter((s) => s !== first.name);
  if (later.length) {
    const names = later.join(', ');
    return refuse(`${story} reached ${names}; Foreman never rolls back a later stage, because people share those orgs. Releases stay halted: roll ${names} back by hand.`);
  }
  if (isObject(rec.rolledBack)) return refuse(`${story} is already rolled back (${short(rec.rolledBack.revert)}).`);

  const f = rec.first;
  if (f.org !== first.org || !first.orgId || id15(f.orgId) !== id15(first.orgId)) {
    return refuse(`${story} was deployed to ${f.org} but ${first.name} is now ${first.org}; the config changed since the deploy, so roll it back by hand.`);
  }
  if (typeof f.merge !== 'string' || !SHA.test(f.merge)) return refuse(`the merge commit is not known, so ${story} cannot be reverted automatically; revert it by hand.`);
  if (f.method === 'rebase') return refuse('a rebase merge cannot be reverted automatically; revert it by hand.');
  if (f.method !== 'merge' && f.method !== 'squash') return refuse(`the merge method ${f.method} is not known; revert ${story} by hand.`);
  if (typeof f.branch !== 'string' || !BRANCH.test(f.branch)) return refuse(`the branch ${story} merged into is not known; revert it by hand.`);
  if (l.productionBranch && f.branch === l.productionBranch) return refuse(`${f.branch} is the production branch; production is never a target.`);
  const home = sfHome(env, os.homedir());
  const problem = homeProblem(env, home);
  if (problem) return refuse(problem);

  const where = `${first.org} (${first.name})`;
  const label = `rolling ${story} back on ${first.name}`;
  report(label);

  const iso = isolatedSh(sh, env, home, os.homedir());
  const q = orgQuery(iso, first.org);
  if (!q.ok) return fail(`could not check ${first.org}: ${q.error.message}`);
  const records = isObject(q.result) && Array.isArray(q.result.records) ? q.result.records : [];
  const org = isObject(records[0]) ? records[0] : {};
  if (org.IsSandbox !== true) return refuse(`${first.org} is not a sandbox; production is never a target`);
  if (id15(org.Id) !== id15(first.orgId)) return refuse(`${first.org} is org ${id15(org.Id)}, not ${first.orgId}`);

  const remote = config.remote ?? 'origin';
  const { branch, merge } = f;
  const git = (args, cwd = root) => sh('git', args, { cwd }) ?? {};
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-sf-rollback-'));
  const tree = path.join(tmp, 'tree');
  const out = path.join(tmp, 'delta');
  try {
    if (git(['fetch', '--quiet', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]).status !== 0) return fail(`could not fetch ${branch} from ${remote}`);
    if (git(['worktree', 'add', '--detach', tree, `refs/remotes/${remote}/${branch}`]).status !== 0) return fail(`could not check out ${branch} for the rollback`);
    if (git(['merge-base', '--is-ancestor', merge, 'HEAD'], tree).status !== 0) return fail(`${branch} no longer holds the merge ${short(merge)}`);
    const reverted = git(['revert', '--no-edit', ...(f.method === 'merge' ? ['-m', '1'] : []), merge], tree);
    if (reverted.status !== 0) {
      git(['revert', '--abort'], tree);
      return fail(`could not revert ${short(merge)} on ${branch}: ${firstLine(reverted.stderr || reverted.stdout)}`);
    }
    const head = git(['rev-parse', 'HEAD'], tree);
    const revert = head.status === 0 ? String(head.stdout ?? '').trim() : '';
    if (!revert) return fail(`could not read the revert of ${short(merge)}`);

    const pin = sgdProblem(iso);
    if (pin) return fail(pin);
    const delta = buildDelta(iso, { from: merge, to: revert, dir: out, cwd: tree });
    if (!delta.ok) return fail(delta.reason);
    const manualSteps = delta.byHand.map(({ type, member }) => `Delete ${type} ${member} by hand in ${first.org}; the rollback never deletes ${type}s`);
    const restored = components(delta.manifest);

    // The org now holds (or may hold) the revert, so the stage's last deploy is the revert: health
    // fails until the branch holds it too, which is what the hand push in the messages does.
    const deployedRevert = (jobId) => writeDeployed(state, { stage: first.name, org: first.org, orgId: first.orgId, jobId: jobId ?? f.jobId ?? null, story, commit: revert, at: now().toISOString() });

    let jobId = null;
    if (restored.length || delta.deletes.length) {
      const level = pick(block?.testLevel?.deploy, TEST_LEVELS, BLOCK_DEFAULTS.testLevel.deploy);
      const args = ['project', 'deploy', 'start', '--manifest', delta.manifest, ...(delta.deletes.length ? ['--post-destructive-changes', delta.postDestructive] : []), '--test-level', level, '--target-org', first.org, '--async'];
      const start = runSf(iso, args, { cwd: tree, timeoutMs: START_TIMEOUT_MS });
      jobId = start.ok && typeof start.result?.id === 'string' && JOB_ID.test(start.result.id) ? start.result.id : null;
      if (!jobId) return fail(`The rollback deploy to ${where} never started: ${start.ok ? 'sf gave no deploy job ID' : start.error.message}; the revert was not pushed.`);
      const job = await waitForJob({ now, sleep, report }, iso, { jobId, org: first.org, minutes: MINUTES, label });
      if (job.status !== 'Succeeded') {
        const { failures } = summary(job.result);
        if (FINAL.includes(job.status)) return fail(`The rollback deploy to ${where} failed: ${problems(failures, job.status)}; the revert was not pushed.`);
        deployedRevert(jobId);
        if (job.stopped) return fail(`Stopped watching job ${jobId} on ${where}: ${job.stopped}; check job ${jobId}, and if it succeeded push the revert by hand: git push ${remote} ${revert}:${branch}`);
        const seen = job.status ?? job.lastError ?? 'nothing';
        return fail(`The rollback deploy to ${where} did not finish within ${MINUTES} minutes (last seen "${seen}"); check job ${jobId}, and if it succeeded push the revert by hand: git push ${remote} ${revert}:${branch}`);
      }
    }

    const agents = (Array.isArray(rec.agents) ? rec.agents : []).filter((a) => isObject(a) && a.stage === first.name && a.org === first.org);
    const back = restoreAgents(iso, { org: first.org, agents });
    if (!back.ok) {
      deployedRevert(jobId);
      return fail(`${where} was rolled back except agent ${back.apiName}: ${back.reason}; the revert was not pushed. By hand: ${back.command}, then git push ${remote} ${revert}:${branch}`);
    }

    if (git(['push', '--quiet', remote, `HEAD:refs/heads/${branch}`], tree).status !== 0) {
      deployedRevert(jobId);
      return fail(`${first.org} was rolled back, but the revert ${short(revert)} could not be pushed to ${branch}; push it by hand: git push ${remote} ${revert}:${branch}`);
    }
    const { at } = deployedRevert(jobId);
    recordRollback(state, story, { revert, jobId, at });
    return { ok: true, story, stage: first.name, org: first.org, merge, revert, jobId, components: restored, deletes: delta.deletes, manualSteps, agents: back.restored };
  } finally {
    git(['worktree', 'remove', '--force', tree]);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
