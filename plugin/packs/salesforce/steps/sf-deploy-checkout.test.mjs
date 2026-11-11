// sf-deploy on real git repositories, with a fake sf that, like the real one, finds source only
// in the folder it runs in. The slot's repo is detached on main, which does not have the class
// the story added; the deploy must still start from a checkout of the stage's commit.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sfDeploy } from './sf-deploy.mjs';
import { readDeployJob } from '../deploy-jobs.mjs';
import { readDeployed } from '../releases.mjs';
import { fakeCtx } from '../../../../test/ship-fakes.mjs';
import { ACME_DEV1_ID, ACME_QA_ID, ACME_UAT_ID, sfCall, sfError, sfOk } from '../../../../test/fake-sf.mjs';

const JOB = '0Af000000000001AAA';
const CLASS = 'force-app/main/default/classes/AcmeService.cls';

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

let base;
let origin;
let repo;
let state;
let sfHome;
let delta;
let starts;
let startAnswer;
// When set, `git worktree remove` fails without running, so only a prune can clear git's record.
let failRemove;

const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
};

// main holds sfdx-project.json and README.md; qa and uat branch from it. The story adds the class,
// is pushed, and is merged into `into` with --no-ff. The repo ends detached on origin/main.
function fixture({ into = 'qa', branches = ['qa', 'uat'] } = {}) {
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'init', '-q', '-b', 'main', repo);
  write('sfdx-project.json', '{"packageDirectories":[{"path":"force-app","default":true}]}\n');
  write('README.md', 'Acme\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'Acme base');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  for (const b of branches) {
    git(repo, 'branch', b, 'main');
    git(repo, 'push', '-q', 'origin', b);
  }
  git(repo, 'checkout', '-q', '-b', 'story/s-1');
  write(CLASS, 'public class AcmeService {\n    public Integer total() { return 1; }\n}\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'S-1: the story');
  git(repo, 'push', '-q', 'origin', 'story/s-1');
  git(repo, 'checkout', '-q', into);
  git(repo, 'merge', '-q', '--no-ff', '-m', 'Merge S-1', 'story/s-1');
  git(repo, 'push', '-q', 'origin', into);
  const merged = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'fetch', '-q', 'origin');
  git(repo, 'checkout', '-q', '--detach', 'origin/main');
  return merged;
}

const startFound = (args, opts) => {
  const cwd = opts.cwd ?? repo;
  const seen = { cwd: opts.cwd, args, has: fs.existsSync(path.join(cwd, CLASS)), head: git(cwd, 'rev-parse', 'HEAD') };
  starts.push(seen);
  if (startAnswer) return startAnswer;
  return seen.has ? sfOk({ id: JOB, status: 'Queued' }) : sfError('DeployFailed', 'No source-backed components present in the package.');
};

// git runs for real; sf answers like the real one: a start finds its source only in its cwd.
function hybridSh() {
  const sh = (rawCmd, rawArgs = [], opts = {}) => {
    const { cmd, args } = sfCall(rawCmd, rawArgs);
    sh.calls.push([cmd, ...args].join(' '));
    sh.opts.push(opts);
    if (cmd === 'git') {
      if (failRemove && args[0] === 'worktree' && args[1] === 'remove') return { status: 128, stdout: '', stderr: 'fatal: simulated' };
      const r = runGit(opts.cwd ?? repo, args);
      return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    }
    if (cmd === 'sf' && args.slice(0, 3).join(' ') === 'project deploy start') return startFound(args, opts);
    if (cmd === 'sf' && args.slice(0, 3).join(' ') === 'project deploy report') {
      return sfOk({ id: JOB, status: 'Succeeded', numberComponentsDeployed: 1, numberComponentsTotal: 1, numberTestsCompleted: 1, numberTestErrors: 0, details: {} });
    }
    return { status: 1, stdout: '', stderr: `no fake route for ${cmd} ${args.join(' ')}` };
  };
  sh.calls = [];
  sh.opts = [];
  return sh;
}

function ctxFor(salesforce, sha) {
  const ctx = fakeCtx({
    config: { pack: 'salesforce', salesforce, slots: 1 },
    branch: 'story/s-1',
    root: repo,
    env: { FOREMAN_SF_HOME: sfHome, FOREMAN_STATE_DIR: state },
    sh: hybridSh(),
  });
  ctx.sha = sha;
  fs.mkdirSync(path.join(delta, 'package'), { recursive: true });
  const manifest = path.join(delta, 'package', 'package.xml');
  fs.writeFileSync(manifest, '<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n  <types>\n    <members>AcmeService</members>\n    <name>ApexClass</name>\n  </types>\n  <version>62.0</version>\n</Package>\n');
  ctx.sfDelta = { dir: delta, from: 'aaa', to: 'bbb', manifest, postDestructive: path.join(delta, 'postDestructiveChanges.xml'), deletes: [], sha256: 'f'.repeat(64) };
  return ctx;
}

const worktrees = () => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree '));
const deployJob = (stage) => readDeployJob(state, 'S-1', stage);

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-deploy-checkout-')));
  origin = path.join(base, 'origin.git');
  repo = path.join(base, 'repo');
  state = path.join(base, 'state');
  sfHome = path.join(base, 'sf-home');
  delta = path.join(base, 'delta');
  fs.mkdirSync(sfHome);
  fs.mkdirSync(delta);
  starts = [];
  startAnswer = null;
  failRemove = false;
});
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

describe('sf-deploy starts in a checkout of the stage commit', () => {
  it('qa deploys from a checkout of the qa merge, which is gone afterwards', async () => {
    const QA_MERGE = fixture();
    const ctx = ctxFor(LAYOUT_B, QA_MERGE);
    expect(fs.existsSync(path.join(repo, CLASS))).toBe(false);
    const r = await sfDeploy('qa').run(ctx);
    expect(r.ok).toBe(true);
    expect(starts).toHaveLength(1);
    expect(starts[0].cwd).toBeTypeOf('string');
    expect(starts[0].cwd).not.toBe(repo);
    expect(starts[0].has).toBe(true);
    expect(starts[0].head).toBe(QA_MERGE);
    expect(fs.existsSync(starts[0].cwd)).toBe(false);
    expect(worktrees()).toHaveLength(1);
    expect(readDeployed(state, 'qa').commit).toBe(QA_MERGE);
    expect(fs.existsSync(path.join(repo, CLASS))).toBe(false);
  });

  it('a remove that fails leaves no stale worktree record: the prune clears it', async () => {
    const QA_MERGE = fixture();
    failRemove = true;
    const r = await sfDeploy('qa').run(ctxFor(LAYOUT_B, QA_MERGE));
    expect(r.ok).toBe(true);
    expect(starts).toHaveLength(1);
    expect(fs.existsSync(starts[0].cwd)).toBe(false);
    expect(fs.existsSync(path.dirname(starts[0].cwd))).toBe(false);
    expect(worktrees()).toHaveLength(1);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('prunable');
  });

  it('removes the checkout when sf fails, and writes no job record', async () => {
    const QA_MERGE = fixture();
    startAnswer = sfError('NoAuthInfoFound', 'No authorization information found for acme-qa.');
    const r = await sfDeploy('qa').run(ctxFor(LAYOUT_B, QA_MERGE));
    expect(r).toMatchObject({ ok: false, code: 5, stage: 'sf-deploy-qa' });
    expect(starts).toHaveLength(1);
    expect(fs.existsSync(starts[0].cwd)).toBe(false);
    expect(fs.existsSync(path.dirname(starts[0].cwd))).toBe(false);
    expect(worktrees()).toHaveLength(1);
    expect(deployJob('qa')).toBeNull();
  });

  it('names the commit and the folder when sf finds no source there', async () => {
    fixture();
    const mainSha = git(repo, 'rev-parse', 'origin/main');
    const r = await sfDeploy('qa').run(ctxFor(LAYOUT_B, mainSha));
    expect(r).toMatchObject({ ok: false, code: 5 });
    expect(starts[0].has).toBe(false);
    expect(r.reason.startsWith('The deploy to acme-qa (qa) never started: No source-backed components present in the package.')).toBe(true);
    expect(r.reason).toContain(`sf looked in ${starts[0].cwd}, a checkout of ${mainSha}, the qa commit`);
    expect(fs.existsSync(starts[0].cwd)).toBe(false);
    expect(worktrees()).toHaveLength(1);
  });

  it('uat deploys from a checkout of its own merge commit', async () => {
    const QA_MERGE = fixture();
    const ctx = ctxFor(LAYOUT_B, QA_MERGE);
    expect((await sfDeploy('qa').run(ctx)).ok).toBe(true);
    starts.length = 0;
    const r = await sfDeploy('uat', { later: true }).run(ctx);
    expect(r).toMatchObject({ ok: true, shaBranch: 'uat' });
    expect(r.sha).toBe(git(origin, 'rev-parse', 'uat'));
    expect(r.sha).not.toBe(QA_MERGE);
    expect(starts).toHaveLength(1);
    expect(starts[0].head).toBe(r.sha);
    expect(starts[0].has).toBe(true);
    expect(starts[0].cwd).not.toBe(repo);
    expect(fs.existsSync(starts[0].cwd)).toBe(false);
    expect(worktrees()).toHaveLength(1);
    expect(readDeployed(state, 'uat').commit).toBe(r.sha);
  });

  it('the single-branch layout deploys with the same start arguments as before', async () => {
    const MAIN_MERGE = fixture({ into: 'main', branches: [] });
    const ctx = ctxFor(LAYOUT_A, MAIN_MERGE);
    const r = await sfDeploy('dev').run(ctx);
    expect(r.ok).toBe(true);
    expect(starts[0].args).toEqual(['project', 'deploy', 'start', '--manifest', ctx.sfDelta.manifest, '--test-level', 'RunLocalTests', '--target-org', 'acme-dev1', '--async', '--json']);
    expect(starts[0].head).toBe(MAIN_MERGE);
    expect(starts[0].has).toBe(true);
    expect(starts[0].cwd).not.toBe(repo);
    expect(fs.existsSync(starts[0].cwd)).toBe(false);
    expect(worktrees()).toHaveLength(1);
    expect(readDeployed(state, 'dev').commit).toBe(MAIN_MERGE);
  });
});
