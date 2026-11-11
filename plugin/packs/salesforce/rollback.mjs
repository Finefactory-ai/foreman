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
// checkout (removed on every path, and git's record of it pruned when the remove fails):
//   1. the merge must still be on the branch; `git revert` it (-m 1 for a merge commit). Then the
//      story-source files the revert changed (markdown stories folder inside the project, stage
//      branch other than baseBranch, a merge commit) are put back from before the revert and the revert amended,
//      except files the base branch lacks that the merge added (the story's shipped record), so a
//      later change on the base branch never conflicts on the stage branch. A squash commit has no
//      ancestry with the base branch, so its story files stay reverted (kept, they would conflict);
//   2. for each agent recorded on stage 1, read what a published agent still holds in the org: the
//      Apex classes its .agent file in the merge names as apex:// targets (agentforce.mjs
//      apexTargets), and, for an agent the story created, its AiAuthoringBundle. Salesforce
//      cannot delete those from the command line while the agent is published, so they are
//      "held": kept out of the post-destructive changes and listed as manual steps;
//   3. build the reverse delta from the merge to its revert with sfdx-git-delta (sf-delta.mjs), so
//      what the story changed or deleted comes back and what it added goes into the post-destructive
//      changes, except the held items and Flows and RecordTypes, which become manual steps;
//   4. put back the agents the story published on stage 1 (agentforce.mjs restoreAgents:
//      reactivate each previous version, or deactivate an agent the story created), even when the
//      reverse delta is empty. A bundle version cannot be changed while it is active, so this is
//      before the deploy;
//   5. deploy the delta to stage 1's org with testLevel.deploy and wait for it (the heartbeat goes
//      through `report`);
//   6. push the revert to the branch. A failure up to and including the deploy (and a failure to
//      fetch the base branch or put the story files back) leaves the branch as
//      it was, and a failure before the deploy leaves the org as it was apart from the agents put
//      back (running the command again leaves those as they are). Then the stage's last deploy is
//      the revert, so `foreman health` matches the branch, and the story is marked rolled back.
// A published agent itself is never deleted: the manual steps say to delete it in Setup, then its
// bundle if one is left, then the classes the rollback kept. The rollback runs no delete command.
// When the org was changed by the deploy but the revert is not on the branch (the push failed or
// the deploy outlived the wait), the stage's last deploy is the revert too, and the story is not
// marked: health fails until the owner does by hand what the message says, and passes once they
// have.
//
// rollBack never throws for an expected failure. Every sf call goes through the isolated sf home;
// git runs with the real HOME. It never passes --ignore-*, `quick` or NoTestRun. A message names
// only aliases, org IDs, stages, branches, shas, metadata types and members, plus git's or sf's
// own error message; never an sf result.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { storiesDirOf } from '../../lib/adapters/stories/markdown.mjs';
import { stateDir } from '../../lib/engine/paths.mjs';
import { AGENT_API_NAME, apexTargets, restoreAgents } from './agentforce.mjs';
import { BLOCK_DEFAULTS, BRANCH, TEST_LEVELS, layout } from './config.mjs';
import { FINAL, JOB_ID, summary, waitForJob } from './deploy-result.mjs';
import { manifestTypes } from './env/sandbox-pool.mjs';
import { homeProblem, isolatedSh, orgQuery, sfHome } from './isolation.mjs';
import { readRelease, recordRollback, writeDeployed } from './releases.mjs';
import { runSf } from './sf.mjs';
import { buildDelta, sgdProblem } from './steps/sf-delta.mjs';
import { problems } from './steps/sf-validate.mjs';
import { removeTempTree } from './temp-tree.mjs';

const START_TIMEOUT_MS = 600_000;
const MINUTES = 30;
const SHA = /^[0-9a-f]{7,64}$/i;

const realOr = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const id15 = (v) => (typeof v === 'string' ? v.slice(0, 15) : '');
const short = (sha) => String(sha ?? '').slice(0, 7);
const pick = (v, list, fallback) => (list.includes(v) ? v : fallback);
const firstLine = (text) => String(text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? 'git gave no reason';
const refuse = (reason) => ({ ok: false, refused: true, reason });
const fail = (reason) => ({ ok: false, reason });

// The stories folder as a repo-relative POSIX path, or null when the source is not a markdown folder
// inside the project (a Jira source, or a folder outside root or root itself).
function storyFolder(config, root, env) {
  const options = config.stories;
  if (options?.adapter !== 'markdown' || typeof options.dir !== 'string') return null;
  const rel = path.relative(realOr(root), realOr(storiesDirOf(options, { root, env })));
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

// After the revert, in the temporary tree: puts the story-source files the revert changed back as they
// were before it, and amends the revert, so a later change to them on the base branch cannot conflict
// on the stage branch. A file the base branch lacks that the merge added (the story's shipped record)
// stays reverted. Returns null, or a failure.
function keepStoryFiles({ git, tree, root, remote, base, branch, folder }) {
  const listed = (r) => String(r.stdout ?? '').split('\0').filter(Boolean);
  const spec = `:(literal)${folder}`;
  const diff = git(['diff', '--name-only', '--no-renames', '-z', 'HEAD~1', 'HEAD', '--', spec], tree);
  if (diff.status !== 0) return fail(`could not keep the story files on ${branch}: ${firstLine(diff.stderr || diff.stdout)}; nothing was deployed and the revert was not pushed`);
  const changed = listed(diff);
  if (!changed.length) return null;
  const ref = `refs/remotes/${remote}/${base}`;
  if (git(['fetch', '--quiet', remote, `+refs/heads/${base}:${ref}`], root).status !== 0) {
    return fail(`could not fetch ${base} from ${remote}, so the story files on ${branch} cannot be kept; nothing was deployed and the revert was not pushed`);
  }
  const lines = [];
  for (const at of [ref, 'HEAD~1']) {
    const r = git(['ls-tree', '-r', '--name-only', '-z', at, '--', spec], tree);
    if (r.status !== 0) return fail(`could not keep the story files on ${branch}: ${firstLine(r.stderr || r.stdout)}; nothing was deployed and the revert was not pushed`);
    lines.push(new Set(listed(r)));
  }
  const [onBase, before] = lines;
  const keep = changed.filter((p) => onBase.has(p) || !before.has(p));
  if (!keep.length) return null;
  for (const args of [['restore', '--source=HEAD~1', '--staged', '--worktree', '--', ...keep.map((p) => `:(literal)${p}`)], ['commit', '--amend', '--no-edit', '--allow-empty', '--quiet']]) {
    const r = git(args, tree);
    if (r.status !== 0) return fail(`could not keep the story files on ${branch}: ${firstLine(r.stderr || r.stdout)}; nothing was deployed and the revert was not pushed`);
  }
  return null;
}

// What the manifest holds, as a sorted list of { type, member }.
function components(file) {
  return Object.entries(manifestTypes(file))
    .flatMap(([type, members]) => members.map((member) => ({ type, member })))
    .sort((a, b) => compare(a.type, b.type) || compare(a.member, b.member));
}

// The agents recorded on stage 1 for this story.
const agentsOn = (rec, stage) => (Array.isArray(rec.agents) ? rec.agents : []).filter((a) => isObject(a) && a.stage === stage.name && a.org === stage.org);

// What the published agents still hold, as [{ type, member, agent }] (one entry per type and member,
// the first agent wins), or { error } when the merge's files cannot be read. `git` runs in the
// temporary tree.
function heldBy(git, agents, merge) {
  const held = new Map();
  const add = (type, member, agent) => {
    if (!held.has(`${type}\0${member}`)) held.set(`${type}\0${member}`, { type, member, agent });
  };
  let listing = null;
  for (const { apiName: api, previous } of agents) {
    if (typeof api !== 'string' || !AGENT_API_NAME.test(api)) continue;
    const fault = (r) => ({ error: `could not read agent ${api}'s bundle at ${short(merge)}: ${firstLine(r.stderr || r.stdout)}; nothing was deployed and the revert was not pushed` });
    if (listing === null) {
      const r = git(['ls-tree', '-r', '--name-only', merge]);
      if (r.status !== 0) return fault(r);
      listing = String(r.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
    }
    const file = listing.find((p) => new RegExp(`(^|/)aiAuthoringBundles/${api}/${api}\\.agent$`).test(p));
    if (file) {
      const r = git(['show', `${merge}:${file}`]);
      if (r.status !== 0) return fault(r);
      for (const cls of apexTargets(r.stdout)) add('ApexClass', cls, api);
    }
    if (previous === null) add('AiAuthoringBundle', api, api);
  }
  return { held: [...held.values()] };
}

// The Setup steps for the held items, in the recorded agents' order.
function agentSteps(agents, held, org) {
  const steps = [];
  for (const { apiName: api, previous, version } of agents) {
    const classes = held.filter((h) => h.agent === api && h.type === 'ApexClass');
    if (previous === null) {
      steps.push(`Delete agent ${api} in ${org} by hand in Setup > Agentforce Agents: the rollback deactivated it, but Salesforce cannot delete a published agent from the command line`);
      if (held.some((h) => h.agent === api && h.type === 'AiAuthoringBundle')) steps.push(`Then delete AiAuthoringBundle ${api} in ${org} by hand, if deleting the agent left it`);
      for (const { member } of classes) steps.push(`Then delete ApexClass ${member} in ${org} by hand; agent ${api} used it, so the rollback kept it`);
    } else {
      const which = Number.isInteger(version) ? `version ${version} (the story's, now inactive)` : "the story's version (now inactive)";
      for (const { member } of classes) steps.push(`Delete ApexClass ${member} in ${org} by hand once no version of agent ${api} uses it; ${which} still does`);
    }
  }
  return steps;
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
    const base = config.baseBranch ?? 'main';
    const folder = f.method === 'merge' && branch !== base && BRANCH.test(base) ? storyFolder(config, root, env) : null;
    if (folder !== null) {
      const kept = keepStoryFiles({ git, tree, root, remote, base, branch, folder });
      if (kept) return kept;
    }
    const head = git(['rev-parse', 'HEAD'], tree);
    const revert = head.status === 0 ? String(head.stdout ?? '').trim() : '';
    if (!revert) return fail(`could not read the revert of ${short(merge)}`);

    const agents = agentsOn(rec, first);
    const holding = heldBy((args) => git(args, tree), agents, merge);
    if (holding.error) return fail(holding.error);

    const pin = sgdProblem(iso);
    if (pin) return fail(pin);
    const delta = buildDelta(iso, { from: merge, to: revert, dir: out, cwd: tree, hold: holding.held });
    if (!delta.ok) return fail(delta.reason);
    const manualSteps = [
      ...delta.byHand.map(({ type, member }) => `Delete ${type} ${member} by hand in ${first.org}; the rollback never deletes ${type}s`),
      ...agentSteps(agents, delta.held, first.org),
    ];
    const restored = components(delta.manifest);

    // The org now holds (or may hold) the revert, so the stage's last deploy is the revert: health
    // fails until the branch holds it too, which is what the hand push in the messages does.
    const deployedRevert = (jobId) => writeDeployed(state, { stage: first.name, org: first.org, orgId: first.orgId, jobId: jobId ?? f.jobId ?? null, story, commit: revert, at: now().toISOString() });

    // A bundle version cannot be changed or deleted while it is active, so the agents go back first.
    const back = restoreAgents(iso, { org: first.org, agents });
    if (!back.ok) {
      return fail(`could not put back agent ${back.apiName} in ${where}: ${back.reason}; nothing was deployed and the revert was not pushed. By hand: ${back.command}, then run foreman sf rollback ${story} again`);
    }
    const names = back.restored.map((a) => a.apiName).join(', ');
    const kept = back.restored.length ? `; agent(s) ${names} were already put back, and running foreman sf rollback ${story} again leaves them as they are` : '';

    let jobId = null;
    if (restored.length || delta.deletes.length) {
      const level = pick(block?.testLevel?.deploy, TEST_LEVELS, BLOCK_DEFAULTS.testLevel.deploy);
      const args = ['project', 'deploy', 'start', '--manifest', delta.manifest, ...(delta.deletes.length ? ['--post-destructive-changes', delta.postDestructive] : []), '--test-level', level, '--target-org', first.org, '--async'];
      const start = runSf(iso, args, { cwd: tree, timeoutMs: START_TIMEOUT_MS });
      jobId = start.ok && typeof start.result?.id === 'string' && JOB_ID.test(start.result.id) ? start.result.id : null;
      if (!jobId) return fail(`The rollback deploy to ${where} never started: ${start.ok ? 'sf gave no deploy job ID' : start.error.message}; the revert was not pushed${kept}.`);
      const job = await waitForJob({ now, sleep, report }, iso, { jobId, org: first.org, minutes: MINUTES, label });
      if (job.status !== 'Succeeded') {
        const { failures } = summary(job.result);
        if (FINAL.includes(job.status)) return fail(`The rollback deploy to ${where} failed: ${problems(failures, job.status)}; the revert was not pushed${kept}.`);
        deployedRevert(jobId);
        if (job.stopped) return fail(`Stopped watching job ${jobId} on ${where}: ${job.stopped}; check job ${jobId}, and if it succeeded push the revert by hand: git push ${remote} ${revert}:${branch}`);
        const seen = job.status ?? job.lastError ?? 'nothing';
        return fail(`The rollback deploy to ${where} did not finish within ${MINUTES} minutes (last seen "${seen}"); check job ${jobId}, and if it succeeded push the revert by hand: git push ${remote} ${revert}:${branch}`);
      }
    }

    if (git(['push', '--quiet', remote, `HEAD:refs/heads/${branch}`], tree).status !== 0) {
      deployedRevert(jobId);
      return fail(`${first.org} was rolled back, but the revert ${short(revert)} could not be pushed to ${branch}; push it by hand: git push ${remote} ${revert}:${branch}`);
    }
    const { at } = deployedRevert(jobId);
    recordRollback(state, story, { revert, jobId, at });
    return { ok: true, story, stage: first.name, org: first.org, merge, revert, jobId, components: restored, deletes: delta.deletes, held: delta.held, manualSteps, agents: back.restored };
  } finally {
    removeTempTree(git, tree, tmp);
  }
}
