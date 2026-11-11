import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rollBack } from './rollback.mjs';
import { sfVerify } from './steps/sf-verify.mjs';
import { manifestTypes } from './env/sandbox-pool.mjs';
import { markReached, readDeployed, readRelease, recordAgent, recordFirstDeploy, recordRollback } from './releases.mjs';
import { withDefaults } from '../../lib/config/defaults.mjs';
import { fakeSh } from '../../../test/ship-fakes.mjs';
import { ACME_DEV1_ID, ACME_QA_ID, ACME_UAT_ID, acmePlugins, orgRecord, sfCall, sfError, sfOk, sfRaw } from '../../../test/fake-sf.mjs';

const JOB = '0Af000000000005AAA';
const FIRST_JOB = '0Af000000000001AAA';
const CLASSES = 'force-app/main/default/classes';
const FLOWS = 'force-app/main/default/flows';
const BUNDLES = 'force-app/main/default/aiAuthoringBundles';
const AGENT_FILE = `${BUNDLES}/Acme_Order_Helper/Acme_Order_Helper.agent`;
const agentText = (cls) => `system:\n    instructions: "Help Acme customers with orders"\n\ntopic orders:\n    actions:\n        look_up:\n            target: "apex://${cls}"\n            description: "Looks up an Acme order"\n`;

const LAYOUT_A = { orgs: { 'acme-dev1': { orgId: ACME_DEV1_ID } }, build: 'acme-dev1', stages: [{ name: 'dev', org: 'acme-dev1' }] };
const LAYOUT_B = {
  productionBranch: 'main',
  orgs: { 'acme-dev1': { orgId: ACME_DEV1_ID }, 'acme-qa': { orgId: ACME_QA_ID }, 'acme-uat': { orgId: ACME_UAT_ID } },
  build: ['acme-dev1'],
  stages: [{ name: 'qa', org: 'acme-qa', branch: 'qa' }, { name: 'uat', org: 'acme-uat', branch: 'uat' }],
};

// Real git, without the developer's config, with a made-up identity.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Acme',
  GIT_AUTHOR_EMAIL: 'acme@example.com',
  GIT_COMMITTER_NAME: 'Acme',
  GIT_COMMITTER_EMAIL: 'acme@example.com',
};
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete GIT_ENV[key];
const runGit = (cwd, args) => spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function git(cwd, ...args) {
  const r = runGit(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

const xml = (types) =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
    ...Object.entries(types).map(([name, members]) => `    <types>\n${members.map((m) => `        <members>${m}</members>`).join('\n')}\n        <name>${name}</name>\n    </types>`),
    '    <version>62.0</version>',
    '</Package>',
    '',
  ].join('\n');

// `sf sgd source delta`, faked over real git: the diff from --from to --to in the call's cwd,
// with classes/*.cls as ApexClass, flows/*.flow-meta.xml as Flow and every file under
// aiAuthoringBundles/<Name>/ as the one AiAuthoringBundle <Name>.
function fakeSgd(args, opts) {
  const at = (flag) => args[args.indexOf(flag) + 1];
  const diff = git(opts.cwd, 'diff', '--name-status', '--no-renames', at('--from'), at('--to'));
  const pkg = {};
  const destructive = {};
  for (const line of diff.split('\n').filter(Boolean)) {
    const [status, file] = line.split('\t');
    const apex = /\/classes\/([^/]+)\.cls$/.exec(file);
    const flow = /\/flows\/([^/]+)\.flow-meta\.xml$/.exec(file);
    const bundle = /\/aiAuthoringBundles\/([^/]+)\//.exec(file);
    const hit = apex ? ['ApexClass', apex[1]] : flow ? ['Flow', flow[1]] : bundle ? ['AiAuthoringBundle', bundle[1]] : null;
    if (!hit) continue;
    const into = status === 'D' ? destructive : pkg;
    into[hit[0]] = [...new Set([...(into[hit[0]] ?? []), hit[1]])].sort();
  }
  const out = at('--output-dir');
  fs.mkdirSync(path.join(out, 'package'), { recursive: true });
  fs.mkdirSync(path.join(out, 'destructiveChanges'), { recursive: true });
  fs.writeFileSync(path.join(out, 'package', 'package.xml'), xml(pkg));
  fs.writeFileSync(path.join(out, 'destructiveChanges', 'destructiveChanges.xml'), xml(destructive));
  return sfOk({ error: null, 'output-dir': out, success: true });
}

let base;
let origin;
let repo;
let state;
let sfHome;
let merge;
let preMergeTree;

function write(rel, text) {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
}

// qa holds AcmeService and AcmeOld. The story changes AcmeService, deletes AcmeOld, adds
// AcmeNew and AcmeFlow, and is merged into qa with --no-ff (or squashed into one commit whose
// only parent is the base), then pushed.
// The 'agent' story adds the authoring bundle Acme_Order_Helper, whose .agent targets the class
// AcmeOrderAction, with that class and its test. With agentOnBase the bundle is already on qa and
// the story only changes it.
function fixture({ story = 'metadata', squash = false, agentOnBase = false } = {}) {
  git(base, 'init', '-q', '--bare', '-b', 'qa', origin);
  git(base, 'init', '-q', '-b', 'qa', repo);
  write(`${CLASSES}/AcmeService.cls`, 'public class AcmeService {\n    public Integer total() { return 1; }\n}\n');
  write(`${CLASSES}/AcmeOld.cls`, 'public class AcmeOld {\n    // the old way of doing things at Acme\n}\n');
  write('README.md', 'Acme\n');
  if (agentOnBase) {
    write(AGENT_FILE, agentText('AcmeOldAction'));
    write(`${BUNDLES}/Acme_Order_Helper/Acme_Order_Helper.bundle-meta.xml`, '<?xml version="1.0" encoding="UTF-8"?>\n<AiAuthoringBundle xmlns="http://soap.sforce.com/2006/04/metadata"><bundleType>AGENT</bundleType></AiAuthoringBundle>\n');
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'Acme base');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'qa');
  git(repo, 'checkout', '-q', '-b', 'story/s-1');
  if (story === 'metadata') {
    write(`${CLASSES}/AcmeService.cls`, 'public class AcmeService {\n    public Integer total() { return 2; }\n}\n');
    fs.rmSync(path.join(repo, CLASSES, 'AcmeOld.cls'));
    write(`${CLASSES}/AcmeNew.cls`, 'public class AcmeNew {\n    public String hello() { return \'Acme\'; }\n}\n');
    write(`${FLOWS}/AcmeFlow.flow-meta.xml`, '<?xml version="1.0" encoding="UTF-8"?>\n<Flow xmlns="http://soap.sforce.com/2006/04/metadata"><label>Acme Flow</label></Flow>\n');
  } else if (story === 'agent') {
    write(AGENT_FILE, agentText('AcmeOrderAction'));
    write(`${BUNDLES}/Acme_Order_Helper/Acme_Order_Helper.bundle-meta.xml`, '<?xml version="1.0" encoding="UTF-8"?>\n<AiAuthoringBundle xmlns="http://soap.sforce.com/2006/04/metadata"><bundleType>AGENT</bundleType></AiAuthoringBundle>\n');
    write(`${CLASSES}/AcmeOrderAction.cls`, 'public class AcmeOrderAction {\n    // looks up an Acme order\n}\n');
    write(`${CLASSES}/AcmeOrderActionTest.cls`, '@IsTest\nprivate class AcmeOrderActionTest {\n    // tests the Acme order action\n}\n');
  } else {
    write('README.md', 'Acme, now with notes\n');
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'S-1: the story');
  git(repo, 'checkout', '-q', 'qa');
  if (squash) {
    git(repo, 'merge', '-q', '--squash', 'story/s-1');
    git(repo, 'commit', '-q', '-m', 'S-1: the story, squashed');
  } else {
    git(repo, 'merge', '-q', '--no-ff', '-m', 'Merge S-1', 'story/s-1');
  }
  git(repo, 'push', '-q', 'origin', 'qa');
  merge = git(repo, 'rev-parse', 'HEAD');
  preMergeTree = git(repo, 'rev-parse', 'HEAD^1^{tree}');
}

const originQa = () => git(origin, 'rev-parse', 'qa');

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-rollback-test-')));
  origin = path.join(base, 'origin.git');
  repo = path.join(base, 'repo');
  state = path.join(base, 'state');
  sfHome = path.join(base, 'sf-home');
  fs.mkdirSync(sfHome);
});
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

const PINNED = sfRaw(acmePlugins({ 'sfdx-git-delta': '6.45.1' }));
const report = (status) => sfOk({ id: JOB, status, numberComponentsDeployed: 3, numberComponentsTotal: 3, numberTestsCompleted: 4, numberTestErrors: 0, details: {} });

// The sh rollBack gets: every call recorded in order; git runs for real, sgd is fakeSgd, and the
// rest of sf answers from the rules.
function shFor({ identity = orgRecord(ACME_QA_ID), deploy = report('Succeeded'), push = null, remove = null, show = null, lsTree = null, restore = null, diff = null, agents = [] } = {}) {
  const fake = fakeSh([
    ...agents,
    [/^sf plugins --core/, PINNED],
    [/^sf data query --query SELECT Id, IsSandbox FROM Organization --target-org acme-qa/, identity],
    [/^sf project deploy start /, sfOk({ id: JOB, status: 'Queued' })],
    [/^sf project deploy report /, deploy],
  ]);
  const sh = (rawCmd, rawArgs = [], opts = {}) => {
    const { cmd, args } = sfCall(rawCmd, rawArgs);
    const line = [cmd, ...args].join(' ');
    sh.calls.push(line);
    sh.opts.push(opts);
    if (cmd === 'git') {
      if (push !== null && args[0] === 'push') return push;
      if (show !== null && args[0] === 'show') return show;
      if (diff !== null && args[0] === 'diff') return diff;
      if (lsTree !== null && args[0] === 'ls-tree') return lsTree;
      if (restore !== null && args[0] === 'restore') return restore;
      if (remove !== null && args[0] === 'worktree' && args[1] === 'remove') return remove;
      const r = runGit(opts.cwd ?? repo, args);
      return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    }
    if (cmd === 'sf' && args[0] === 'sgd') return fakeSgd(args, opts);
    if (cmd === 'sf' && args.slice(0, 3).join(' ') === 'project deploy start') {
      const at = (flag) => args[args.indexOf(flag) + 1];
      sh.deployed = { package: manifestTypes(at('--manifest')), post: args.includes('--post-destructive-changes') ? manifestTypes(at('--post-destructive-changes')) : null };
    }
    return fake(rawCmd, rawArgs, opts);
  };
  sh.calls = [];
  sh.opts = [];
  return sh;
}

const configFor = (salesforce = LAYOUT_B, extra = {}) => withDefaults({ version: 1, project: { name: 'Acme' }, pack: 'salesforce', slots: 1, salesforce, ...extra });

function seed(first = {}, reached = ['qa']) {
  for (const stage of reached) markReached(state, 'S-1', stage, 'bbb');
  recordFirstDeploy(state, 'S-1', { stage: 'qa', org: 'acme-qa', orgId: ACME_QA_ID, branch: 'qa', merge, method: 'merge', jobId: FIRST_JOB, deployedAt: '2026-10-24T10:00:00.000Z', ...first });
}

// The deploy report answers each of `answers` in turn, then the last.
const inTurn = (...answers) => {
  let n = 0;
  return () => answers[Math.min(n++, answers.length - 1)];
};

const ENV = () => ({ FOREMAN_STATE_DIR: state, FOREMAN_SF_HOME: sfHome });

// events: the report and sleep calls, in order, so a test can see the heartbeat between polls.
async function run({ sh = shFor(), config = configFor(), story = 'S-1' } = {}) {
  let clock = Date.UTC(2026, 9, 24, 12, 0, 0);
  const reports = [];
  const sleeps = [];
  const events = [];
  const r = await rollBack({
    root: repo,
    config,
    env: ENV(),
    sh,
    story,
    now: () => new Date(clock),
    sleep: async (ms) => {
      sleeps.push(ms);
      events.push('sleep');
      clock += ms;
    },
    report: (detail) => {
      reports.push(detail);
      events.push(`report ${detail}`);
    },
  });
  return { r, sh, reports, sleeps, events };
}

// sfVerify('qa').healthy on the fixture: real git in repo, the org's newest real deploy is `newest`.
async function healthOf(config = configFor(), newest = JOB) {
  const answer = sfOk({ records: [{ attributes: { type: 'DeployRequest' }, Id: newest, Status: 'Succeeded' }], totalSize: 1, done: true });
  const sh = (cmd, args = [], opts = {}) => {
    if (cmd === 'git') {
      const r = runGit(opts.cwd ?? repo, args);
      return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    }
    return fakeSh([[/FROM DeployRequest/, answer]])(cmd, args, opts);
  };
  return sfVerify('qa').healthy({ root: repo, config, env: ENV(), sh });
}

const deployLine = (sh) => sh.calls.find((l) => l.startsWith('sf project deploy start'));
const pushes = (sh) => sh.calls.filter((l) => l.startsWith('git push'));

describe('foreman sf rollback on the fixture history', () => {
  it('a remove that fails is followed by a prune from the project root, and leaves no stale worktree record', async () => {
    fixture();
    seed();
    const { r, sh } = await run({ sh: shFor({ remove: { status: 128, stdout: '', stderr: 'fatal: simulated' } }) });
    expect(r.ok).toBe(true);
    expect(git(origin, 'rev-parse', 'qa^1')).toBe(merge);
    const removeAt = sh.calls.findIndex((l) => l.startsWith('git worktree remove'));
    expect(removeAt).toBeGreaterThan(-1);
    expect(sh.calls[removeAt + 1]).toBe('git worktree prune');
    expect(sh.opts[removeAt + 1].cwd).toBe(repo);
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('prunable');
    const m = /--manifest (\S+)\/delta\/package\/package\.xml/.exec(deployLine(sh));
    expect(path.basename(m[1])).toMatch(/^foreman-sf-rollback-/);
    expect(fs.existsSync(m[1])).toBe(false);
  });

  it('a remove that succeeds runs no prune', async () => {
    fixture();
    seed();
    const { r, sh } = await run();
    expect(r.ok).toBe(true);
    expect(sh.calls.filter((l) => l.startsWith('git worktree prune'))).toEqual([]);
  });

  it('reverts the merge, deploys the reverse delta to stage 1 with a test level, and pushes the revert', async () => {
    fixture();
    seed();
    // The deploy is still running on the first two polls.
    const { r, sh, sleeps, events } = await run({ sh: shFor({ deploy: inTurn(report('InProgress'), report('InProgress'), report('Succeeded')) }) });
    const revert = originQa();
    expect(r).toMatchObject({ ok: true, story: 'S-1', stage: 'qa', org: 'acme-qa', merge, revert, jobId: JOB, agents: [] });
    expect(sh.calls.filter((l) => l.startsWith('sf agent ') || l.includes('FROM BotVersion'))).toEqual([]);
    expect(r.deletes).toEqual([{ type: 'ApexClass', member: 'AcmeNew' }]);
    expect(r.components).toEqual([{ type: 'ApexClass', member: 'AcmeOld' }, { type: 'ApexClass', member: 'AcmeService' }]);
    expect(r.manualSteps).toEqual(['Delete Flow AcmeFlow by hand in acme-qa; the rollback never deletes Flows']);

    // The reverse delta: from the merge to its revert, in the temporary worktree.
    const sgd = sh.calls.findIndex((l) => l.startsWith('sf sgd source delta'));
    expect(sh.calls[sgd]).toMatch(new RegExp(`^sf sgd source delta --from ${merge} --to ${revert} --output-dir \\S+ --generate-delta --json$`));
    expect(sh.deployed.package).toEqual({ ApexClass: ['AcmeOld', 'AcmeService'] });
    expect(sh.deployed.post).toEqual({ ApexClass: ['AcmeNew'] });

    const line = deployLine(sh);
    const m = /^sf project deploy start --manifest (\S+)\/delta\/package\/package\.xml --post-destructive-changes (\S+)\/delta\/postDestructiveChanges\.xml --test-level RunLocalTests --target-org acme-qa --async --json$/.exec(line);
    expect(m).not.toBeNull();
    expect(m[2]).toBe(m[1]);
    expect(path.basename(m[1])).toMatch(/^foreman-sf-rollback-/);
    const i = sh.calls.indexOf(line);
    expect(sh.opts[i].cwd).toBe(path.join(m[1], 'tree'));
    expect(sh.opts[i].env.HOME).toBe(sfHome);
    expect(sh.opts[sgd].cwd).toBe(path.join(m[1], 'tree'));
    expect(fs.existsSync(m[1])).toBe(false);

    // The identity check runs before the deploy, through the isolated sf home.
    const identity = sh.calls.findIndex((l) => l.includes('FROM Organization --target-org acme-qa'));
    expect(identity).toBeGreaterThanOrEqual(0);
    expect(identity).toBeLessThan(i);
    expect(sh.opts[identity].env.HOME).toBe(sfHome);

    // origin/qa is a revert of the merge, with the tree qa had before it.
    expect(git(origin, 'rev-parse', 'qa^1')).toBe(merge);
    expect(git(origin, 'rev-parse', 'qa^{tree}')).toBe(preMergeTree);

    expect(readDeployed(state, 'qa')).toEqual({ stage: 'qa', org: 'acme-qa', orgId: ACME_QA_ID, jobId: JOB, story: 'S-1', commit: revert, at: '2026-10-24T12:00:20.000Z' });
    expect(readRelease(state, 'S-1').rolledBack).toEqual({ revert, jobId: JOB, at: '2026-10-24T12:00:20.000Z' });
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
    expect(await healthOf()).toMatchObject({ ok: true });
    // The heartbeat: once before the identity check, then once on every poll, after each sleep,
    // so the watchdog never sees the slot idle for a whole poll.
    expect(sh.calls.filter((l) => l.startsWith('sf project deploy report'))).toHaveLength(3);
    expect(sleeps).toEqual([10_000, 10_000]);
    const beat = 'report rolling S-1 back on qa';
    expect(events).toEqual([beat, beat, 'sleep', beat, 'sleep', beat]);
    for (const l of sh.calls.filter((c) => c.startsWith('sf '))) {
      expect(l).not.toContain('--ignore');
      expect(l).not.toContain(' quick');
      expect(l).not.toContain('NoTestRun');
    }
  });

  it('reverts a squash merge without -m, deploys the reverse delta and pushes the revert', async () => {
    fixture({ squash: true });
    seed({ method: 'squash' });
    const { r, sh } = await run();
    // The squash commit has one parent: the base.
    expect(git(repo, 'rev-list', '--parents', '-n', '1', merge).split(' ')).toHaveLength(2);
    expect(r).toMatchObject({ ok: true, story: 'S-1', stage: 'qa', merge, revert: originQa(), jobId: JOB });
    expect(sh.calls.filter((l) => l.startsWith('git revert'))).toEqual([`git revert --no-edit ${merge}`]);
    expect(sh.calls.some((l) => l.startsWith('git revert') && l.includes(' -m '))).toBe(false);
    expect(deployLine(sh)).toContain('--test-level RunLocalTests --target-org acme-qa');
    expect(sh.deployed.package).toEqual({ ApexClass: ['AcmeOld', 'AcmeService'] });
    expect(sh.deployed.post).toEqual({ ApexClass: ['AcmeNew'] });
    expect(pushes(sh)).toHaveLength(1);
    expect(git(origin, 'rev-parse', 'qa^1')).toBe(merge);
    expect(git(origin, 'rev-parse', 'qa^{tree}')).toBe(preMergeTree);
    expect(readRelease(state, 'S-1').rolledBack).toMatchObject({ revert: r.revert, jobId: JOB });
  });

  it('rolls back a story shipped again after a rollback with the same to', async () => {
    fixture();
    seed();
    recordRollback(state, 'S-1', { revert: 'b'.repeat(40), jobId: JOB, at: '2026-10-24T11:00:00.000Z' });
    // The story ships to stage 1 again: a new first deploy.
    seed();
    const { r } = await run();
    expect(r).toMatchObject({ ok: true, story: 'S-1', merge });
    expect(readRelease(state, 'S-1').rolledBack).toMatchObject({ revert: r.revert, jobId: JOB });
  });

  it('pushes the revert with no deploy and a null job when the reverse delta is empty', async () => {
    fixture({ story: 'readme' });
    seed();
    const { r, sh } = await run();
    expect(r).toMatchObject({ ok: true, jobId: null, components: [], deletes: [], manualSteps: [], agents: [] });
    expect(deployLine(sh)).toBeUndefined();
    expect(git(origin, 'rev-parse', 'qa^1')).toBe(merge);
    expect(readDeployed(state, 'qa')).toMatchObject({ jobId: FIRST_JOB, commit: r.revert });
    expect(readRelease(state, 'S-1').rolledBack).toMatchObject({ revert: r.revert, jobId: null });
  });

  it('stops before any deploy when the revert conflicts, aborts it and leaves origin/qa as it was', async () => {
    fixture();
    seed();
    write(`${CLASSES}/AcmeService.cls`, 'public class AcmeService {\n    public Integer total() { return 3; }\n}\n');
    git(repo, 'commit', '-q', '-am', 'Acme: a later change to the same line');
    git(repo, 'push', '-q', 'origin', 'qa');
    const before = originQa();
    const { r, sh } = await run();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(new RegExp(`^could not revert ${merge.slice(0, 7)} on qa: `));
    expect(sh.calls).toContain('git revert --abort');
    expect(deployLine(sh)).toBeUndefined();
    expect(pushes(sh)).toEqual([]);
    expect(originQa()).toBe(before);
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('refuses when qa no longer holds the merge', async () => {
    fixture();
    seed();
    git(origin, 'update-ref', 'refs/heads/qa', `${merge}^1`);
    const { r, sh } = await run();
    expect(r).toEqual({ ok: false, reason: `qa no longer holds the merge ${merge.slice(0, 7)}` });
    expect(deployLine(sh)).toBeUndefined();
  });

  it('pushes nothing when the deploy fails', async () => {
    fixture();
    seed();
    const failed = sfOk({ id: JOB, status: 'Failed', details: { componentFailures: { componentType: 'ApexClass', fullName: 'AcmeOld', problem: 'Acme broke' } } });
    const { r, sh } = await run({ sh: shFor({ deploy: failed }) });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('1 problem(s): ApexClass AcmeOld');
    expect(pushes(sh)).toEqual([]);
    expect(originQa()).toBe(merge);
    expect(readRelease(state, 'S-1').rolledBack).toBeNull();
    expect(readDeployed(state, 'qa')).toBeNull();
  });

  it('says how to push the revert by hand when the push fails', async () => {
    fixture();
    seed();
    const { r } = await run({ sh: shFor({ push: { status: 1, stdout: '', stderr: 'protected branch' } }) });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^acme-qa was rolled back, but the revert [0-9a-f]{7} could not be pushed to qa; push it by hand: git push origin [0-9a-f]{40}:qa$/);
    expect(originQa()).toBe(merge);
    expect(readRelease(state, 'S-1').rolledBack).toBeNull();

    // The org holds the revert, so the stage record does too: health fails until the owner
    // pushes the revert as the message says, and passes once they have.
    const revert = /git push origin ([0-9a-f]{40}):qa$/.exec(r.reason)[1];
    expect(readDeployed(state, 'qa')).toEqual({ stage: 'qa', org: 'acme-qa', orgId: ACME_QA_ID, jobId: JOB, story: 'S-1', commit: revert, at: '2026-10-24T12:00:00.000Z' });
    expect(await healthOf()).toMatchObject({ ok: false });
    git(repo, 'push', '-q', 'origin', `${revert}:qa`);
    expect(await healthOf()).toMatchObject({ ok: true });
  });

  it('records the revert as the stage deploy when the deploy outlives the wait, so health passes only after the hand push', async () => {
    fixture();
    seed();
    const { r, sh } = await run({ sh: shFor({ deploy: report('InProgress') }) });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(new RegExp(`^The rollback deploy to acme-qa \\(qa\\) did not finish within 30 minutes \\(last seen "InProgress"\\); check job ${JOB}, and if it succeeded push the revert by hand: git push origin ([0-9a-f]{40}):qa$`));
    expect(pushes(sh)).toEqual([]);
    expect(originQa()).toBe(merge);
    expect(readRelease(state, 'S-1').rolledBack).toBeNull();
    const revert = /([0-9a-f]{40}):qa$/.exec(r.reason)[1];
    expect(readDeployed(state, 'qa')).toMatchObject({ jobId: JOB, commit: revert });
    expect(await healthOf()).toMatchObject({ ok: false });
    git(repo, 'push', '-q', 'origin', `${revert}:qa`);
    expect(await healthOf()).toMatchObject({ ok: true });
  });

  it('stops watching the rollback deploy at once on a login-rate answer, and records the revert', async () => {
    fixture();
    seed();
    const { r, sh, sleeps } = await run({ sh: shFor({ deploy: sfError('X', 'login rate exceeded') }) });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(new RegExp(`^Stopped watching job ${JOB} on acme-qa \\(qa\\): stopped at once:.*login rate exceeded`));
    expect(sh.calls.filter((l) => l.startsWith('sf project deploy report'))).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(pushes(sh)).toEqual([]);
    expect(readDeployed(state, 'qa')).toMatchObject({ jobId: JOB });
  });

  describe('the agents the story published', () => {
    const AGENT = 'Acme_Order_Helper';
    const ACTIVATE = `sf agent activate --api-name ${AGENT} --version 1 --target-org acme-qa --json`;
    const DEACTIVATE = `sf agent deactivate --api-name ${AGENT} --target-org acme-qa --json`;
    const bot = (list) => sfOk({ records: list.map(([n, status]) => ({ VersionNumber: n, Status: status })), totalSize: list.length, done: true });
    const agentRoutes = ({ versions = [[1, 'Inactive'], [2, 'Active']], activate = sfOk({ success: true }) } = {}) => [
      [/FROM BotVersion/, bot(versions)],
      [/^sf agent activate /, activate],
      [/^sf agent deactivate /, sfOk({ success: true })],
    ];
    const published = (over = {}) => recordAgent(state, 'S-1', { stage: 'qa', org: 'acme-qa', apiName: AGENT, previous: 1, version: 2, at: '2026-10-24T10:00:00.000Z', ...over });
    const agentLines = (sh) => sh.calls.filter((l) => l.startsWith('sf agent '));

    it('reactivates the previous version before the deploy and before the push', async () => {
      fixture();
      seed();
      published();
      const { r, sh } = await run({ sh: shFor({ agents: agentRoutes() }) });
      expect(r).toMatchObject({ ok: true, agents: [{ apiName: AGENT, version: 1 }] });
      expect(agentLines(sh)).toEqual([ACTIVATE]);
      const at = sh.calls.indexOf(ACTIVATE);
      expect(at).toBeGreaterThan(sh.calls.findIndex((l) => l.includes('FROM Organization --target-org acme-qa')));
      expect(at).toBeGreaterThan(sh.calls.findIndex((l) => l.startsWith('sf sgd source delta')));
      expect(at).toBeLessThan(sh.calls.findIndex((l) => l.startsWith('sf project deploy start')));
      expect(at).toBeLessThan(sh.calls.findIndex((l) => l.startsWith('git push')));
      expect(sh.opts[at].env.HOME).toBe(sfHome);
      expect(readRelease(state, 'S-1').rolledBack).toMatchObject({ revert: r.revert });
    });

    it('deactivates an agent the story created', async () => {
      fixture();
      seed();
      published({ previous: null, version: 1 });
      const { r, sh } = await run({ sh: shFor({ agents: agentRoutes({ versions: [[1, 'Active']] }) }) });
      expect(r).toMatchObject({ ok: true, agents: [{ apiName: AGENT, version: null }] });
      expect(agentLines(sh)).toEqual([DEACTIVATE]);
    });

    it('ignores an entry for a later stage or another org', async () => {
      fixture();
      seed();
      published({ stage: 'uat', org: 'acme-uat' });
      published({ apiName: 'Acme_Case_Helper', org: 'acme-dev1' });
      const { r, sh } = await run({ sh: shFor({ agents: agentRoutes() }) });
      expect(r).toMatchObject({ ok: true, agents: [] });
      expect(agentLines(sh)).toEqual([]);
      expect(sh.calls.some((l) => l.includes('FROM BotVersion'))).toBe(false);
    });

    it('restores the agent when the reverse delta is empty too', async () => {
      fixture({ story: 'readme' });
      seed();
      published();
      const { r, sh } = await run({ sh: shFor({ agents: agentRoutes() }) });
      expect(r).toMatchObject({ ok: true, jobId: null, agents: [{ apiName: AGENT, version: 1 }] });
      expect(deployLine(sh)).toBeUndefined();
      expect(sh.calls.indexOf(ACTIVATE)).toBeLessThan(sh.calls.findIndex((l) => l.startsWith('git push')));
    });

    it('deploys and pushes nothing, and records no rollback, when the agent cannot be put back, and says what to run by hand', async () => {
      fixture();
      seed();
      published();
      const { r, sh } = await run({ sh: shFor({ agents: agentRoutes({ activate: sfError('ActivateError', 'Acme activation broke') }) }) });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/^could not put back agent Acme_Order_Helper in acme-qa \(qa\): /);
      expect(r.reason).toContain('Acme activation broke');
      expect(r.reason).toContain('nothing was deployed and the revert was not pushed');
      expect(r.reason).toContain(`sf agent activate --api-name ${AGENT} --version 1 --target-org acme-qa`);
      expect(r.reason).toMatch(/then run foreman sf rollback S-1 again$/);
      expect(r.reason).not.toContain('Did you mean');
      expect(deployLine(sh)).toBeUndefined();
      expect(pushes(sh)).toEqual([]);
      expect(originQa()).toBe(merge);
      expect(readRelease(state, 'S-1').rolledBack).toBeNull();
      expect(readDeployed(state, 'qa')).toBeNull();
    });

    it('says the agents already put back when the deploy then fails, and pushes nothing', async () => {
      fixture();
      seed();
      published();
      const failed = sfOk({ id: JOB, status: 'Failed', details: { componentFailures: { componentType: 'ApexClass', fullName: 'AcmeOld', problem: 'Acme broke' } } });
      const { r, sh } = await run({ sh: shFor({ deploy: failed, agents: agentRoutes() }) });
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('1 problem(s): ApexClass AcmeOld');
      expect(r.reason).toMatch(new RegExp(`the revert was not pushed; agent\\(s\\) ${AGENT} were already put back, and running foreman sf rollback S-1 again leaves them as they are\\.$`));
      expect(agentLines(sh)).toEqual([ACTIVATE]);
      expect(pushes(sh)).toEqual([]);
      expect(readRelease(state, 'S-1').rolledBack).toBeNull();
    });

    it('says the agents already put back when the deploy never starts', async () => {
      fixture();
      seed();
      published();
      const { r } = await run({ sh: shFor({ agents: [[/^sf project deploy start /, sfError('DeployError', 'Acme cannot start')], ...agentRoutes()] }) });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/^The rollback deploy to acme-qa \(qa\) never started: .*; the revert was not pushed; agent\(s\) Acme_Order_Helper were already put back, and running foreman sf rollback S-1 again leaves them as they are\.$/);
    });

    it('stops before any deploy, agent call or push when the agent bundle cannot be read', async () => {
      fixture({ story: 'agent' });
      seed();
      published({ previous: null, version: 1 });
      const { r, sh } = await run({ sh: shFor({ agents: agentRoutes({ versions: [[1, 'Active']] }), show: { status: 128, stdout: '', stderr: 'fatal: Acme cannot read that' } }) });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(new RegExp(`^could not read agent ${AGENT}'s bundle at ${merge.slice(0, 7)}: fatal: Acme cannot read that; nothing was deployed and the revert was not pushed$`));
      expect(deployLine(sh)).toBeUndefined();
      expect(agentLines(sh)).toEqual([]);
      expect(pushes(sh)).toEqual([]);
      expect(originQa()).toBe(merge);
      expect(readDeployed(state, 'qa')).toBeNull();
    });

    it('stops before any deploy, agent call or push when the merge cannot be listed', async () => {
      fixture({ story: 'agent' });
      seed();
      published({ previous: null, version: 1 });
      const { r, sh } = await run({ sh: shFor({ agents: agentRoutes({ versions: [[1, 'Active']] }), lsTree: { status: 128, stdout: '', stderr: 'fatal: Acme cannot list that' } }) });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(new RegExp(`^could not read agent ${AGENT}'s bundle at ${merge.slice(0, 7)}: fatal: Acme cannot list that; nothing was deployed and the revert was not pushed$`));
      expect(deployLine(sh)).toBeUndefined();
      expect(agentLines(sh)).toEqual([]);
      expect(pushes(sh)).toEqual([]);
      expect(originQa()).toBe(merge);
      expect(readDeployed(state, 'qa')).toBeNull();
      expect(sh.calls.filter((l) => l.startsWith('git show'))).toEqual([]);
    });

    it('rolls back a story that created an agent: deactivates it before the deploy, keeps its bundle and the classes it uses out of the deletes, pushes the revert and lists the Setup steps', async () => {
      fixture({ story: 'agent' });
      seed();
      published({ previous: null, version: 1 });
      const { r, sh } = await run({ sh: shFor({ agents: agentRoutes({ versions: [[1, 'Active']] }) }) });
      expect(r.ok).toBe(true);
      const deploy = sh.calls.findIndex((l) => l.startsWith('sf project deploy start'));
      expect(sh.calls.indexOf(DEACTIVATE)).toBeGreaterThan(-1);
      expect(sh.calls.indexOf(DEACTIVATE)).toBeLessThan(deploy);
      expect(sh.deployed.post).toEqual({ ApexClass: ['AcmeOrderActionTest'] });
      expect(r.deletes).toEqual([{ type: 'ApexClass', member: 'AcmeOrderActionTest' }]);
      expect(r.held).toEqual([{ type: 'AiAuthoringBundle', member: AGENT, agent: AGENT }, { type: 'ApexClass', member: 'AcmeOrderAction', agent: AGENT }]);
      expect(r.manualSteps).toEqual([
        `Delete agent ${AGENT} in acme-qa by hand in Setup > Agentforce Agents: the rollback deactivated it, but Salesforce cannot delete a published agent from the command line`,
        `Then delete AiAuthoringBundle ${AGENT} in acme-qa by hand, if deleting the agent left it`,
        `Then delete ApexClass AcmeOrderAction in acme-qa by hand; agent ${AGENT} used it, so the rollback kept it`,
      ]);
      expect(r.agents).toEqual([{ apiName: AGENT, version: null }]);
      expect(pushes(sh)).toHaveLength(1);
      expect(git(origin, 'rev-parse', 'qa^1')).toBe(merge);
      expect(readRelease(state, 'S-1').rolledBack).toMatchObject({ revert: r.revert });
      expect(readDeployed(state, 'qa')).toMatchObject({ commit: r.revert });
      expect(sh.calls.filter((l) => l.includes('delete'))).toEqual([]);
      // The merge's .agent file is read once, in the temporary tree.
      const shows = sh.calls.filter((l) => l.startsWith('git show') || l.startsWith('git ls-tree'));
      expect(shows).toEqual([`git ls-tree -r --name-only ${merge}`, `git show ${merge}:${AGENT_FILE}`]);
      for (const l of shows) expect(path.basename(sh.opts[sh.calls.indexOf(l)].cwd)).toBe('tree');
    });

    it('rolls back a story that changed an existing agent: reactivates the old version before the deploy and keeps the class its .agent uses', async () => {
      fixture({ story: 'agent', agentOnBase: true });
      seed();
      published({ previous: 1, version: 2 });
      const { r, sh } = await run({ sh: shFor({ agents: agentRoutes() }) });
      expect(r.ok).toBe(true);
      expect(sh.calls.indexOf(ACTIVATE)).toBeGreaterThan(-1);
      expect(sh.calls.indexOf(ACTIVATE)).toBeLessThan(sh.calls.findIndex((l) => l.startsWith('sf project deploy start')));
      expect(sh.deployed.package).toEqual({ AiAuthoringBundle: [AGENT] });
      expect(sh.deployed.post).toEqual({ ApexClass: ['AcmeOrderActionTest'] });
      expect(r.held).toEqual([{ type: 'ApexClass', member: 'AcmeOrderAction', agent: AGENT }]);
      expect(r.manualSteps).toEqual([`Delete ApexClass AcmeOrderAction in acme-qa by hand once no version of agent ${AGENT} uses it; version 2 (the story's, now inactive) still does`]);
      expect(pushes(sh)).toHaveLength(1);
    });

    it('reads the held classes from the merge only for the agents recorded on stage 1', async () => {
      fixture({ story: 'agent' });
      seed();
      published({ previous: null, version: 1, stage: 'uat', org: 'acme-uat' });
      const { r, sh } = await run({ sh: shFor({ agents: agentRoutes() }) });
      expect(r.ok).toBe(true);
      expect(sh.calls.filter((l) => l.startsWith('git ls-tree') || l.startsWith('git show'))).toEqual([]);
      expect(r.held).toEqual([]);
      expect(sh.deployed.post).toEqual({ ApexClass: ['AcmeOrderAction', 'AcmeOrderActionTest'], AiAuthoringBundle: [AGENT] });
    });
  });

  describe('the org identity check', () => {
    for (const [what, identity] of [['not a sandbox', orgRecord(ACME_QA_ID, false)], ['another org', orgRecord(ACME_UAT_ID)]]) {
      it(`refuses an org that is ${what}, with no git call, deploy or push`, async () => {
        fixture();
        seed();
        const { r, sh } = await run({ sh: shFor({ identity }) });
        expect(r).toMatchObject({ ok: false, refused: true });
        expect(sh.calls.filter((l) => l.startsWith('git '))).toEqual([]);
        expect(deployLine(sh)).toBeUndefined();
        expect(originQa()).toBe(merge);
      });
    }
  });
});

// The story branch is cut from main, where the story file lives, and qa is behind main: the merge
// into qa brings stories/S-1.md and the story's shipped record with it. main is the base branch.
const STORY_TEXT = '---\nid: S-1\nstatus: todo\n---\n\n# S-1\n';
const STORIES = 'stories';
const SERVICE = `${CLASSES}/AcmeService.cls`;
// With deleted, main also had stories/S-0.md, which the 'S-1 is a story' commit deletes, so the merge
// into qa deletes it and its revert would add it back.
function storyFixture({ squash = false, deleted = false } = {}) {
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'init', '-q', '-b', 'main', repo);
  write(SERVICE, 'public class AcmeService {\n    public Integer total() { return 1; }\n}\n');
  write('README.md', 'Acme\n');
  if (deleted) write(`${STORIES}/S-0.md`, '---\nid: S-0\nstatus: done\n---\n\n# S-0\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'Acme base');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'branch', 'qa');
  git(repo, 'push', '-q', 'origin', 'qa');
  write(`${STORIES}/S-1.md`, STORY_TEXT);
  if (deleted) fs.rmSync(path.join(repo, STORIES, 'S-0.md'));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'S-1 is a story');
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'checkout', '-q', '-b', 'story/s-1');
  write(`${CLASSES}/AcmeNew.cls`, 'public class AcmeNew {\n    public String hello() { return \'Acme\'; }\n}\n');
  write(`${STORIES}/.shipped/S-1.json`, '{"id":"S-1","status":"done"}\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'S-1: the story');
  git(repo, 'checkout', '-q', 'qa');
  if (squash) {
    git(repo, 'merge', '-q', '--squash', 'story/s-1');
    git(repo, 'commit', '-q', '-m', 'S-1: the story, squashed');
  } else {
    git(repo, 'merge', '-q', '--no-ff', '-m', 'Merge S-1', 'story/s-1');
  }
  git(repo, 'push', '-q', 'origin', 'qa');
  merge = git(repo, 'rev-parse', 'HEAD');
}

const onQa = (file) => runGit(origin, ['cat-file', '-e', `qa:${file}`]).status === 0;
const gitCalls = (sh, prefix) => sh.calls.filter((l) => l.startsWith(prefix));

// After the rollback: S-1's story file is set to blocked on main, the next story is cut from main,
// and its merge into qa (as the origin has it) must be clean.
function mergeNextStory() {
  git(repo, 'checkout', '-q', 'main');
  write(`${STORIES}/S-1.md`, STORY_TEXT.replace('status: todo', 'status: blocked'));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'S-1 is blocked');
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'checkout', '-q', '-b', 'story/s-2');
  write(`${CLASSES}/AcmeSecond.cls`, 'public class AcmeSecond {\n    // the second Acme story\n}\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'S-2: the next story');
  git(repo, 'checkout', '-q', 'qa');
  git(repo, 'reset', '-q', '--hard', 'origin/qa');
  const merged = runGit(repo, ['merge', '--no-ff', '-m', 'Merge S-2', 'story/s-2']);
  expect(merged.stderr + merged.stdout).not.toContain('CONFLICT');
  expect(merged.status).toBe(0);
  expect(git(repo, 'show', `qa:${STORIES}/S-1.md`)).toContain('status: blocked');
}

describe('foreman sf rollback and the story files on the stage branch', () => {
  for (const [name, squash] of [
    ["keeps the story file on qa after the rollback of a merge commit, so a later status change on main does not conflict with the next story's merge", false],
    ["leaves the story file reverted on qa after a squash rollback, and the next story's merge into qa is still clean", true],
  ]) {
    it(name, async () => {
      storyFixture({ squash });
      seed(squash ? { method: 'squash' } : {});
      const { r, sh } = await run();
      expect(r.ok).toBe(true);
      expect(r.revert).toBe(originQa());
      // A squash commit has no ancestry with main, so its story file stays reverted: kept, it would
      // be an add/add conflict with main's next change however it was rolled back.
      if (squash) expect(onQa(`${STORIES}/S-1.md`)).toBe(false);
      else expect(git(origin, 'show', `qa:${STORIES}/S-1.md`)).toBe(STORY_TEXT.trim());
      if (squash) expect(gitCalls(sh, 'git restore')).toEqual([]);
      // FM-436: the story's shipped record stays reverted, so list() no longer reads it as shipped on qa.
      expect(onQa(`${STORIES}/.shipped/S-1.json`)).toBe(false);
      expect(onQa(`${CLASSES}/AcmeNew.cls`)).toBe(false);
      expect(git(origin, 'rev-parse', 'qa^1')).toBe(merge);
      if (squash) expect(sh.calls.some((l) => l.startsWith('git revert') && l.includes(' -m '))).toBe(false);
      expect(sh.deployed.post).toEqual({ ApexClass: ['AcmeNew'] });
      expect(readRelease(state, 'S-1').rolledBack.revert).toBe(originQa());
      expect(readDeployed(state, 'qa').commit).toBe(originQa());
      expect(await healthOf()).toMatchObject({ ok: true });
      mergeNextStory();
    });
  }

  it('keeps a story file the merge deleted deleted on qa after the rollback, because main no longer has it', async () => {
    storyFixture({ deleted: true });
    seed();
    const { r, sh } = await run();
    expect(r.ok).toBe(true);
    expect(r.revert).toBe(originQa());
    // The revert would add S-0.md back; main lacks it, so it stays deleted. Dropping `|| !before.has(p)` fails here.
    expect(onQa(`${STORIES}/S-0.md`)).toBe(false);
    expect(git(origin, 'show', `qa:${STORIES}/S-1.md`)).toBe(STORY_TEXT.trim());
    expect(onQa(`${STORIES}/.shipped/S-1.json`)).toBe(false);
    expect(onQa(`${CLASSES}/AcmeNew.cls`)).toBe(false);
    const restores = gitCalls(sh, 'git restore');
    expect(restores).toHaveLength(1);
    expect(restores[0]).toContain(`:(literal)${STORIES}/S-0.md`);
    expect(restores[0]).toContain(`:(literal)${STORIES}/S-1.md`);
    expect(restores[0]).not.toContain('.shipped');
    expect(git(origin, 'rev-parse', 'qa^1')).toBe(merge);
    expect(readRelease(state, 'S-1').rolledBack.revert).toBe(originQa());
    expect(await healthOf()).toMatchObject({ ok: true });
    mergeNextStory();
  });

  it('stops before any deploy or push when the story files cannot be listed', async () => {
    storyFixture();
    seed();
    const before = originQa();
    const { r, sh } = await run({ sh: shFor({ lsTree: { status: 128, stdout: '', stderr: 'fatal: Acme cannot list that' } }) });
    expect(r).toEqual({ ok: false, reason: 'could not keep the story files on qa: fatal: Acme cannot list that; nothing was deployed and the revert was not pushed' });
    expect(deployLine(sh)).toBeUndefined();
    expect(pushes(sh)).toEqual([]);
    expect(gitCalls(sh, 'git restore')).toEqual([]);
    expect(gitCalls(sh, 'git commit --amend')).toEqual([]);
    expect(sh.calls.filter((l) => l.startsWith('sf agent '))).toEqual([]);
    expect(originQa()).toBe(before);
    expect(readDeployed(state, 'qa')).toBeNull();
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  it("stops before fetching main, deploying or pushing when the revert's story-file diff fails", async () => {
    storyFixture();
    seed();
    const before = originQa();
    const { r, sh } = await run({ sh: shFor({ diff: { status: 128, stdout: '', stderr: 'fatal: Acme cannot diff that' } }) });
    expect(r).toEqual({ ok: false, reason: 'could not keep the story files on qa: fatal: Acme cannot diff that; nothing was deployed and the revert was not pushed' });
    expect(gitCalls(sh, 'git fetch')).toHaveLength(1);
    expect(gitCalls(sh, 'git ls-tree')).toEqual([]);
    expect(gitCalls(sh, 'git restore')).toEqual([]);
    expect(gitCalls(sh, 'git commit --amend')).toEqual([]);
    expect(deployLine(sh)).toBeUndefined();
    expect(pushes(sh)).toEqual([]);
    expect(originQa()).toBe(before);
    expect(readDeployed(state, 'qa')).toBeNull();
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('stops before any deploy or push when main cannot be fetched, with the worktree gone', async () => {
    storyFixture();
    git(origin, 'update-ref', '-d', 'refs/heads/main');
    seed();
    const before = originQa();
    const { r, sh } = await run();
    expect(r).toEqual({ ok: false, reason: 'could not fetch main from origin, so the story files on qa cannot be kept; nothing was deployed and the revert was not pushed' });
    expect(deployLine(sh)).toBeUndefined();
    expect(pushes(sh)).toEqual([]);
    expect(sh.calls.filter((l) => l.startsWith('sf agent '))).toEqual([]);
    expect(originQa()).toBe(before);
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('stops before any deploy or push when the story files cannot be put back', async () => {
    storyFixture();
    seed();
    const before = originQa();
    const { r, sh } = await run({ sh: shFor({ restore: { status: 1, stdout: '', stderr: 'fatal: simulated' } }) });
    expect(r.ok).toBe(false);
    expect(r.reason.startsWith('could not keep the story files on qa: fatal: simulated')).toBe(true);
    expect(deployLine(sh)).toBeUndefined();
    expect(pushes(sh)).toEqual([]);
    expect(originQa()).toBe(before);
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('leaves the revert as it was when qa is the base branch', async () => {
    storyFixture();
    seed();
    const { r, sh } = await run({ config: configFor(LAYOUT_B, { baseBranch: 'qa' }) });
    expect(r.ok).toBe(true);
    expect(onQa(`${STORIES}/S-1.md`)).toBe(false);
    expect(gitCalls(sh, 'git restore')).toEqual([]);
    expect(gitCalls(sh, 'git commit --amend')).toEqual([]);
    expect(gitCalls(sh, 'git fetch')).toHaveLength(1);
  });

  it('leaves the revert as it was when the stories are not a markdown folder in the project', async () => {
    for (const stories of [{ adapter: 'markdown', dir: '../elsewhere' }, { adapter: 'jira', project: 'ACME' }, { adapter: 'markdown', dir: '.' }]) {
      fs.rmSync(base, { recursive: true, force: true });
      fs.mkdirSync(base);
      fs.mkdirSync(sfHome);
      storyFixture();
      seed();
      const { r, sh } = await run({ config: configFor(LAYOUT_B, { stories }) });
      expect(r.ok).toBe(true);
      expect(gitCalls(sh, 'git restore')).toEqual([]);
      expect(gitCalls(sh, 'git commit --amend')).toEqual([]);
      expect(gitCalls(sh, 'git fetch')).toHaveLength(1);
      expect(onQa(`${STORIES}/S-1.md`)).toBe(false);
    }
  });

  it('makes no further git call when the revert changed no story file', async () => {
    fixture();
    seed();
    const { r, sh } = await run();
    expect(r.ok).toBe(true);
    expect(gitCalls(sh, 'git fetch')).toHaveLength(1);
    expect(sh.calls.some((l) => l.startsWith('git ls-tree -r --name-only -z refs/remotes'))).toBe(false);
    expect(gitCalls(sh, 'git restore')).toEqual([]);
    expect(gitCalls(sh, 'git commit --amend')).toEqual([]);
  });
});

describe('foreman sf rollback refuses before any git or sf call', () => {
  const M = 'a'.repeat(40);

  it('for a story that reached uat', async () => {
    seed({ merge: M }, ['qa', 'uat']);
    const { r, sh } = await run();
    expect(r).toMatchObject({ ok: false, refused: true });
    expect(r.reason).toBe('S-1 reached uat; Foreman never rolls back a later stage, because people share those orgs. Releases stay halted: roll uat back by hand.');
    expect(sh.calls).toEqual([]);
  });

  const cases = {
    'no record': { setup: () => {}, reason: 'No deploy of S-1 to qa is recorded; nothing to roll back.' },
    'no first deploy': { setup: () => markReached(state, 'S-1', 'qa', 'bbb'), reason: 'No deploy of S-1 to qa is recorded; nothing to roll back.' },
    'already rolled back': {
      setup: () => {
        seed({ merge: M });
        recordRollback(state, 'S-1', { revert: 'b'.repeat(40), jobId: JOB, at: '2026-10-24T11:00:00.000Z' });
      },
      reason: /already rolled back \(bbbbbbb\)/,
    },
    'release ci': { setup: () => seed({ merge: M }), config: configFor({ ...LAYOUT_B, release: 'ci' }), reason: 'rollback is only for release "sf"' },
    'a rebase merge': { setup: () => seed({ merge: M, method: 'rebase' }), reason: /a rebase merge cannot be reverted automatically; revert it by hand/ },
    'an unknown merge': { setup: () => seed({ merge: null }), reason: /the merge commit is not known/ },
    'a changed org': { setup: () => seed({ merge: M, org: 'acme-dev1', orgId: ACME_DEV1_ID }), reason: /config changed/ },
    'a changed org ID': { setup: () => seed({ merge: M, orgId: ACME_UAT_ID }), reason: /config changed/ },
    'a production branch': { setup: () => seed({ merge: M, branch: 'main' }), reason: /production is never a target/ },
  };
  for (const [what, { setup, config, reason }] of Object.entries(cases)) {
    it(`for ${what}`, async () => {
      setup();
      const { r, sh } = await run({ config });
      expect(r).toMatchObject({ ok: false, refused: true });
      if (typeof reason === 'string') expect(r.reason).toBe(reason);
      else expect(r.reason).toMatch(reason);
      expect(sh.calls).toEqual([]);
    });
  }

  it('for a relative sf home', async () => {
    seed({ merge: M });
    const sh = shFor();
    let clock = Date.UTC(2026, 9, 24, 12);
    const r = await rollBack({ root: repo, config: configFor(), env: { FOREMAN_STATE_DIR: state, FOREMAN_SF_HOME: 'sf-home' }, sh, story: 'S-1', now: () => new Date(clock), sleep: async (ms) => (clock += ms), report: () => {} });
    expect(r).toMatchObject({ ok: false, refused: true, reason: 'FOREMAN_SF_HOME must be an absolute path, not sf-home' });
    expect(sh.calls).toEqual([]);
  });

  it('for a one-sandbox layout, rollback targets the build org that is stage 1', async () => {
    markReached(state, 'S-1', 'dev', 'bbb');
    recordFirstDeploy(state, 'S-1', { stage: 'dev', org: 'acme-dev1', orgId: ACME_DEV1_ID, branch: 'main', merge: M, method: 'rebase', jobId: FIRST_JOB, deployedAt: '2026-10-24T10:00:00.000Z' });
    const { r, sh } = await run({ config: configFor(LAYOUT_A) });
    expect(r.reason).toMatch(/rebase/);
    expect(sh.calls).toEqual([]);
  });
});
