// The Agentforce check on real git repositories, with a fake sf that, like the real one, finds the
// agent bundle only in the folder it runs in. The slot's repo is detached on main, which does not
// have the bundle the story added; validate and publish must still run in a checkout of the
// stage's commit, and the checkout must be gone afterwards.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentforceCheck } from './agentforce.mjs';
import { isolatedSh } from './isolation.mjs';
import { fakeCtx, fakeSh } from '../../../test/ship-fakes.mjs';
import { ACME_QA_ID, ACME_UAT_ID, sfCall, sfError, sfOk } from '../../../test/fake-sf.mjs';
import { ACME_SPEC, evalRules, fakeFetch, fakeRealSf, tempPath, orgDisplay, specText } from '../../../test/fake-agent-eval.mjs';

const API = 'Acme_Order_Helper';
const BUNDLE_DIR = `force-app/main/default/aiAuthoringBundles/${API}`;
const BUNDLE_FILE = `${BUNDLE_DIR}/${API}.agent`;
const EVAL_FILE = `tests/${API}-eval.json`;

const LAYOUT_B = {
  productionBranch: 'main',
  orgs: { 'acme-dev1': { orgId: '00D000000000001AAA' }, 'acme-qa': { orgId: ACME_QA_ID }, 'acme-uat': { orgId: ACME_UAT_ID } },
  build: ['acme-dev1'],
  stages: [{ name: 'qa', org: 'acme-qa', branch: 'qa' }, { name: 'uat', org: 'acme-uat', branch: 'uat' }],
};
const QA = { name: 'qa', org: 'acme-qa', orgId: ACME_QA_ID, branch: 'qa' };
const UAT = { name: 'uat', org: 'acme-uat', orgId: ACME_UAT_ID, branch: 'uat' };

const MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
    <types>
        <members>${API}</members>
        <name>AiAuthoringBundle</name>
    </types>
    <types>
        <members>AcmeOrderStatusAction</members>
        <name>ApexClass</name>
    </types>
    <version>62.0</version>
</Package>
`;

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
let calls;
let agentCalls;
let failRemove;
let validateAnswer;
let publishAnswer;
// When set, `git show` goes to the fake sh, which answers the eval spec from no real commit.
let fakeShow;

const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
};

// main holds sfdx-project.json and README.md; qa and uat branch from it. The story adds the agent
// bundle and its eval spec, is pushed, and is merged into each of qa and uat with --no-ff. The
// repo ends detached on origin/main.
function fixture() {
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'init', '-q', '-b', 'main', repo);
  write('sfdx-project.json', '{"packageDirectories":[{"path":"force-app","default":true}]}\n');
  write('README.md', 'Acme\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'Acme base');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  for (const b of ['qa', 'uat']) {
    git(repo, 'branch', b, 'main');
    git(repo, 'push', '-q', 'origin', b);
  }
  git(repo, 'checkout', '-q', '-b', 'story/s-1');
  write(BUNDLE_FILE, 'system:\n  instructions: "Acme order helper"\n');
  write(`${BUNDLE_DIR}/${API}.bundle-meta.xml`, '<?xml version="1.0" encoding="UTF-8"?>\n<AiAuthoringBundle xmlns="http://soap.sforce.com/2006/04/metadata"/>\n');
  write(EVAL_FILE, specText(ACME_SPEC));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'S-1: the story');
  git(repo, 'push', '-q', 'origin', 'story/s-1');
  const head = git(repo, 'rev-parse', 'HEAD');
  const merged = {};
  for (const b of ['qa', 'uat']) {
    git(repo, 'checkout', '-q', b);
    git(repo, 'merge', '-q', '--no-ff', '-m', `Merge S-1 into ${b}`, 'story/s-1');
    git(repo, 'push', '-q', 'origin', b);
    merged[b] = git(repo, 'rev-parse', 'HEAD');
  }
  git(repo, 'fetch', '-q', 'origin');
  git(repo, 'checkout', '-q', '--detach', 'origin/main');
  return { head, qa: merged.qa, uat: merged.uat };
}

const inTurn = (...answers) => {
  let n = 0;
  return () => answers[Math.min(n++, answers.length - 1)];
};
const versions = (list) =>
  sfOk({ records: list.map(([n, status]) => ({ attributes: { type: 'BotVersion' }, VersionNumber: n, Status: status })), totalSize: list.length, done: true });

const happyRules = () => [
  [/^sf agent activate /, sfOk({ success: true, version: 2 })],
  [/^sf data query --query SELECT VersionNumber, Status FROM BotVersion/, inTurn(versions([[1, 'Active']]), versions([[1, 'Active'], [2, 'Inactive']]), versions([[1, 'Inactive'], [2, 'Active']]))],
];

// git runs for real; validate and publish answer like the real sf: the bundle is found only in
// their cwd. Everything else goes to a fake sh.
function hybridSh(fake) {
  const sh = (rawCmd, rawArgs = [], opts = {}) => {
    const { cmd, args } = sfCall(rawCmd, rawArgs);
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'git') {
      if (args[0] === 'show' && fakeShow) return fake(rawCmd, rawArgs, opts);
      if (failRemove && args[0] === 'worktree' && args[1] === 'remove') return { status: 128, stdout: '', stderr: 'fatal: simulated' };
      const r = runGit(opts.cwd ?? repo, args);
      return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    }
    const verb = cmd === 'sf' && args[0] === 'agent' && args[2] === 'authoring-bundle' ? args[1] : null;
    if (verb === 'validate' || verb === 'publish') {
      const dir = opts.cwd ?? repo;
      const has = fs.existsSync(path.join(dir, BUNDLE_FILE));
      agentCalls.push({ verb, cwd: opts.cwd, has, head: git(dir, 'rev-parse', 'HEAD') });
      const forced = verb === 'validate' ? validateAnswer : publishAnswer;
      if (forced) return forced;
      return has ? sfOk({ success: true }) : sfError('SfError', `Cannot find an authoring bundle named '${API}' in the project.`);
    }
    return fake(rawCmd, rawArgs, opts);
  };
  return sh;
}

function setup({ sha, display } = {}) {
  const fake = fakeSh([...happyRules(), ...evalRules(display ? { display } : {})]);
  const sh = hybridSh(fake);
  const env = { FOREMAN_SF_HOME: sfHome, FOREMAN_STATE_DIR: state, PATH: tempPath(base, fakeRealSf(base)) };
  const ctx = fakeCtx({ config: { pack: 'salesforce', salesforce: LAYOUT_B, slots: 1 }, root: repo, env });
  ctx.sh = sh;
  ctx.fetch = fakeFetch();
  const manifest = path.join(base, 'package.xml');
  fs.writeFileSync(manifest, MANIFEST);
  ctx.sfDelta = { to: sha.head, manifest };
  ctx.sha = sha.commit;
  return { ctx, run: (stage) => agentforceCheck.run({ ctx, sh: isolatedSh(sh, env, sfHome, os.homedir()), stage }) };
}

const worktrees = () => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree '));

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-agentforce-checkout-')));
  origin = path.join(base, 'origin.git');
  repo = path.join(base, 'repo');
  state = path.join(base, 'state');
  sfHome = path.join(base, 'sf-home');
  fs.mkdirSync(sfHome);
  calls = [];
  agentCalls = [];
  failRemove = false;
  validateAnswer = null;
  publishAnswer = null;
  fakeShow = false;
});
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

const ran = (verb) => agentCalls.filter((c) => c.verb === verb);

describe('the Agentforce check runs in a checkout of the stage commit', () => {
  it('qa validates and publishes from a checkout of the qa merge, which is gone afterwards', async () => {
    const f = fixture();
    const { run } = setup({ sha: { head: f.head, commit: f.qa } });
    expect(fs.existsSync(path.join(repo, BUNDLE_FILE))).toBe(false);
    const r = await run(QA);
    expect(r).toEqual({ ok: true, changedOrg: true, agents: [{ apiName: API, previous: 1, version: 2 }] });
    expect(ran('validate')).toHaveLength(1);
    expect(ran('publish')).toHaveLength(1);
    const [v] = ran('validate');
    const [p] = ran('publish');
    for (const c of [v, p]) {
      expect(c.cwd).toBeTypeOf('string');
      expect(c.cwd).not.toBe(repo);
      expect(c.has).toBe(true);
      expect(c.head).toBe(f.qa);
    }
    expect(p.cwd).toBe(v.cwd);
    expect(fs.existsSync(v.cwd)).toBe(false);
    expect(fs.existsSync(path.dirname(v.cwd))).toBe(false);
    expect(worktrees()).toHaveLength(1);
    expect(fs.existsSync(path.join(repo, BUNDLE_FILE))).toBe(false);
    expect(calls).toContain(`git show ${f.qa}:${EVAL_FILE}`);
    expect(calls.filter((c) => c.startsWith('git show ')).every((c) => !c.includes(f.head))).toBe(true);
  });

  it('a later stage on its own branch runs from a checkout of its own merge', async () => {
    const f = fixture();
    const { run } = setup({ sha: { head: f.head, commit: f.uat }, display: orgDisplay({ id: ACME_UAT_ID, alias: 'acme-uat' }) });
    const r = await run(UAT);
    expect(r.ok).toBe(true);
    expect(ran('validate')).toHaveLength(1);
    expect(ran('publish')).toHaveLength(1);
    for (const c of agentCalls) {
      expect(c.head).toBe(f.uat);
      expect(c.has).toBe(true);
      expect(fs.existsSync(c.cwd)).toBe(false);
    }
    expect(worktrees()).toHaveLength(1);
  });

  it('a commit git cannot check out fails before any sf agent call and leaves nothing behind', async () => {
    const f = fixture();
    fakeShow = true;
    const unknown = 'f'.repeat(40);
    const { run } = setup({ sha: { head: f.head, commit: unknown } });
    const r = await run(QA);
    expect(r.ok).toBe(false);
    expect(r).not.toHaveProperty('changedOrg');
    expect(r.reason.startsWith(`could not check the agents in acme-qa (qa): could not check out ${unknown} (the qa commit):`)).toBe(true);
    expect(calls.some((c) => c.startsWith('sf agent '))).toBe(false);
    const add = calls.find((c) => c.startsWith('git worktree add '));
    expect(add).toBeDefined();
    const tree = add.split(' ')[4];
    expect(fs.existsSync(path.dirname(tree))).toBe(false);
    expect(worktrees()).toHaveLength(1);
  });

  it('removes the checkout when validate fails, and publishes nothing', async () => {
    const f = fixture();
    validateAnswer = sfError('ValidationError', 'Acme agent script has 2 errors');
    const { run } = setup({ sha: { head: f.head, commit: f.qa } });
    const r = await run(QA);
    expect(r.ok).toBe(false);
    expect(r).not.toHaveProperty('changedOrg');
    expect(ran('publish')).toHaveLength(0);
    expect(fs.existsSync(ran('validate')[0].cwd)).toBe(false);
    expect(fs.existsSync(path.dirname(ran('validate')[0].cwd))).toBe(false);
    expect(worktrees()).toHaveLength(1);
  });

  it('removes the checkout when the publish fails', async () => {
    const f = fixture();
    publishAnswer = sfError('PublishError', 'Acme publish broke');
    const { run } = setup({ sha: { head: f.head, commit: f.qa } });
    const r = await run(QA);
    expect(r.ok).toBe(false);
    expect(ran('publish')).toHaveLength(1);
    expect(fs.existsSync(ran('publish')[0].cwd)).toBe(false);
    expect(worktrees()).toHaveLength(1);
  });

  it('a remove that fails leaves no stale worktree record: the prune clears it', async () => {
    const f = fixture();
    failRemove = true;
    const { run } = setup({ sha: { head: f.head, commit: f.qa } });
    const r = await run(QA);
    expect(r.ok).toBe(true);
    const [v] = ran('validate');
    expect(fs.existsSync(v.cwd)).toBe(false);
    expect(fs.existsSync(path.dirname(v.cwd))).toBe(false);
    expect(worktrees()).toHaveLength(1);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('prunable');
  });
});
