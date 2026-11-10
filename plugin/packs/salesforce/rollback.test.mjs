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
// with classes/*.cls as ApexClass and flows/*.flow-meta.xml as Flow.
function fakeSgd(args, opts) {
  const at = (flag) => args[args.indexOf(flag) + 1];
  const diff = git(opts.cwd, 'diff', '--name-status', '--no-renames', at('--from'), at('--to'));
  const pkg = {};
  const destructive = {};
  for (const line of diff.split('\n').filter(Boolean)) {
    const [status, file] = line.split('\t');
    const apex = /\/classes\/([^/]+)\.cls$/.exec(file);
    const flow = /\/flows\/([^/]+)\.flow-meta\.xml$/.exec(file);
    const hit = apex ? ['ApexClass', apex[1]] : flow ? ['Flow', flow[1]] : null;
    if (!hit) continue;
    const into = status === 'D' ? destructive : pkg;
    into[hit[0]] = [...(into[hit[0]] ?? []), hit[1]].sort();
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
function fixture({ story = 'metadata', squash = false } = {}) {
  git(base, 'init', '-q', '--bare', '-b', 'qa', origin);
  git(base, 'init', '-q', '-b', 'qa', repo);
  write(`${CLASSES}/AcmeService.cls`, 'public class AcmeService {\n    public Integer total() { return 1; }\n}\n');
  write(`${CLASSES}/AcmeOld.cls`, 'public class AcmeOld {\n    // the old way of doing things at Acme\n}\n');
  write('README.md', 'Acme\n');
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
function shFor({ identity = orgRecord(ACME_QA_ID), deploy = report('Succeeded'), push = null, agents = [] } = {}) {
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

    it('reactivates the previous version after the deploy and before the push', async () => {
      fixture();
      seed();
      published();
      const { r, sh } = await run({ sh: shFor({ agents: agentRoutes() }) });
      expect(r).toMatchObject({ ok: true, agents: [{ apiName: AGENT, version: 1 }] });
      expect(agentLines(sh)).toEqual([ACTIVATE]);
      const at = sh.calls.indexOf(ACTIVATE);
      expect(at).toBeGreaterThan(sh.calls.findLastIndex((l) => l.startsWith('sf project deploy report')));
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

    it('pushes nothing and records no rollback when the agent cannot be restored, and says what to run by hand', async () => {
      fixture();
      seed();
      published();
      const { r, sh } = await run({ sh: shFor({ agents: agentRoutes({ activate: sfError('ActivateError', 'Acme activation broke') }) }) });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/^acme-qa \(qa\) was rolled back except agent Acme_Order_Helper: /);
      expect(r.reason).toContain('Acme activation broke');
      expect(r.reason).toContain('the revert was not pushed');
      expect(r.reason).toContain(`sf agent activate --api-name ${AGENT} --version 1 --target-org acme-qa`);
      expect(r.reason).toMatch(/then git push origin [0-9a-f]{40}:qa$/);
      expect(r.reason).not.toContain('Did you mean');
      expect(pushes(sh)).toEqual([]);
      expect(originQa()).toBe(merge);
      expect(readRelease(state, 'S-1').rolledBack).toBeNull();
      const revert = /([0-9a-f]{40}):qa$/.exec(r.reason)[1];
      expect(readDeployed(state, 'qa')).toMatchObject({ jobId: JOB, commit: revert });
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
