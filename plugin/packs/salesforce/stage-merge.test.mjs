import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeIntoStage } from './stage-merge.mjs';
import { layout } from './config.mjs';
import { realSh } from '../../lib/cli/commands/ship.mjs';
import { fakeSh } from '../../../test/ship-fakes.mjs';
import { ACME_DEV1_ID, ACME_QA_ID, ACME_UAT_ID } from '../../../test/fake-sf.mjs';

const LAYOUT_B = {
  productionBranch: 'main',
  orgs: { 'acme-dev1': { orgId: ACME_DEV1_ID }, 'acme-qa': { orgId: ACME_QA_ID }, 'acme-uat': { orgId: ACME_UAT_ID } },
  build: ['acme-dev1'],
  stages: [{ name: 'qa', org: 'acme-qa', branch: 'qa' }, { name: 'uat', org: 'acme-uat', branch: 'uat' }],
};
const CONFIG = { remote: 'origin', baseBranch: 'main', salesforce: LAYOUT_B };
const UAT = layout(LAYOUT_B, CONFIG).stages[1];

const STORY_REF = 'refs/remotes/origin/story/s-1';
const UAT_REF = 'refs/remotes/origin/uat';
const MERGED = 'c'.repeat(40);
const UAT_HEAD = 'a'.repeat(40);
// The reviewed head: the local story branch, and the remote one when it has not moved.
const STORY_HEAD = 'e'.repeat(40);
const MOVED = 'f'.repeat(40);
const PIN = [/^git rev-parse --verify refs\/(heads|remotes\/origin)\/story\/s-1$/, `${STORY_HEAD}\n`];

const ctxFor = (sh, over = {}) => ({ sh, root: '/acme/repo', config: CONFIG, branch: 'story/s-1', story: 'S-1', ...over });

// The temp worktree of a call: the path `git worktree add` got, or null.
const treeOf = (sh) => {
  const line = sh.calls.find((c) => c.startsWith('git worktree add'));
  return line ? line.split(' ')[4] : null;
};

describe('mergeIntoStage, with a fake shell', () => {
  it.each([
    ['a missing story branch', { branch: undefined }, UAT],
    ['a story branch that is not a branch name', { branch: '-x' }, UAT],
    ['a stage branch that is not a branch name', {}, { ...UAT, branch: 'uat..x' }],
    ['a stage branch that is productionBranch', {}, { ...UAT, branch: 'main' }],
  ])('refuses %s before any git call', async (_, over, stage) => {
    const sh = fakeSh();
    const r = await mergeIntoStage(ctxFor(sh, over), stage);
    expect(r.ok).toBe(false);
    expect(typeof r.reason).toBe('string');
    expect(sh.calls).toEqual([]);
  });

  it('fails when a fetch fails, and merges nothing', async () => {
    const sh = fakeSh([[/^git fetch --quiet origin \+refs\/heads\/uat:/, { status: 128, stderr: 'fatal: no uat' }]]);
    const r = await mergeIntoStage(ctxFor(sh), UAT);
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('could not fetch uat') });
    expect(sh.calls.some((c) => c.startsWith('git merge '))).toBe(false);
    expect(sh.calls.some((c) => c.startsWith('git push'))).toBe(false);
  });

  it('fails when the story branch cannot be fetched', async () => {
    const sh = fakeSh([[/^git fetch --quiet origin \+refs\/heads\/story\/s-1:/, 1]]);
    const r = await mergeIntoStage(ctxFor(sh), UAT);
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('could not fetch story/s-1') });
  });

  it('a story already on the stage branch is not merged again: the stage head, no push', async () => {
    const sh = fakeSh([
      PIN,
      [`git merge-base --is-ancestor ${STORY_HEAD} ${UAT_REF}`, 0],
      [`git rev-parse --verify ${UAT_REF}`, `${UAT_HEAD}\n`],
    ]);
    const r = await mergeIntoStage(ctxFor(sh), UAT);
    expect(r).toEqual({ ok: true, sha: UAT_HEAD, merged: false });
    expect(sh.calls.some((c) => c.startsWith('git push'))).toBe(false);
    expect(sh.calls.some((c) => c.startsWith('git worktree'))).toBe(false);
  });

  it('merges the story branch with --no-ff in a temp tree, pushes it, and removes the tree', async () => {
    const sh = fakeSh([
      PIN,
      ['git merge-base --is-ancestor', 1],
      ['git rev-parse HEAD', `${MERGED}\n`],
    ]);
    const r = await mergeIntoStage(ctxFor(sh), UAT);
    expect(r).toEqual({ ok: true, sha: MERGED, merged: true });
    expect(sh.calls.slice(0, 2)).toEqual([
      'git fetch --quiet origin +refs/heads/uat:refs/remotes/origin/uat',
      'git fetch --quiet origin +refs/heads/story/s-1:refs/remotes/origin/story/s-1',
    ]);
    const tree = treeOf(sh);
    expect(tree.startsWith(path.join(os.tmpdir(), 'foreman-sf-stage-'))).toBe(true);
    expect(sh.calls).toContain(`git worktree add --detach ${tree} ${UAT_REF}`);
    const mergeAt = sh.calls.findIndex((c) => c.startsWith('git merge --no-ff'));
    expect(sh.calls[mergeAt]).toBe(`git merge --no-ff --no-edit -m Merge story/s-1 into uat for S-1 ${STORY_HEAD}`);
    expect(sh.opts[mergeAt]).toEqual({ cwd: tree });
    const pushAt = sh.calls.indexOf('git push --quiet origin HEAD:refs/heads/uat');
    expect(pushAt).toBeGreaterThan(mergeAt);
    expect(sh.opts[pushAt]).toEqual({ cwd: tree });
    expect(sh.calls.at(-1)).toBe(`git worktree remove --force ${tree}`);
    expect(fs.existsSync(path.dirname(tree))).toBe(false);
  });

  it('a remove that fails is followed by a prune from the project root, after the folder is gone', async () => {
    const sh = fakeSh([PIN, ['git merge-base --is-ancestor', 1], ['git rev-parse HEAD', `${MERGED}\n`], ['git worktree remove', 128]]);
    const r = await mergeIntoStage(ctxFor(sh), UAT);
    expect(r).toEqual({ ok: true, sha: MERGED, merged: true });
    const tree = treeOf(sh);
    expect(sh.calls.at(-1)).toBe('git worktree prune');
    expect(sh.calls.at(-2)).toBe(`git worktree remove --force ${tree}`);
    expect(sh.opts.at(-1)).toEqual({ cwd: '/acme/repo' });
    expect(fs.existsSync(path.dirname(tree))).toBe(false);
  });

  it('a remove that succeeds runs no prune', async () => {
    const sh = fakeSh([PIN, ['git merge-base --is-ancestor', 1], ['git rev-parse HEAD', `${MERGED}\n`]]);
    await mergeIntoStage(ctxFor(sh), UAT);
    expect(sh.calls.some((c) => c.startsWith('git worktree prune'))).toBe(false);
  });

  it('never merges the previous stage branch', async () => {
    const sh = fakeSh([PIN, ['git merge-base --is-ancestor', 1], ['git rev-parse HEAD', `${MERGED}\n`]]);
    await mergeIntoStage(ctxFor(sh), UAT);
    expect(sh.calls.some((c) => c.startsWith('git merge --no-ff'))).toBe(true);
    expect(sh.calls.some((c) => / refs\/remotes\/origin\/qa\b|heads\/qa\b/.test(c))).toBe(false);
  });

  it('a conflict aborts the merge, names the files and pushes nothing', async () => {
    const sh = fakeSh([
      PIN,
      ['git merge-base --is-ancestor', 1],
      ['git merge --no-ff', { status: 1, stdout: 'CONFLICT (content): Merge conflict in force-app/main/default/classes/AcmeService.cls' }],
      ['git diff --name-only --diff-filter=U', 'force-app/main/default/classes/AcmeService.cls\nREADME.md\n'],
    ]);
    const r = await mergeIntoStage(ctxFor(sh), UAT);
    expect(r).toEqual({ ok: false, reason: 'story/s-1 conflicts with uat in: force-app/main/default/classes/AcmeService.cls, README.md; merge it by hand' });
    const tree = treeOf(sh);
    expect(sh.opts[sh.calls.indexOf('git merge --abort')]).toEqual({ cwd: tree });
    expect(sh.calls.some((c) => c.startsWith('git push'))).toBe(false);
    expect(sh.calls.at(-1)).toBe(`git worktree remove --force ${tree}`);
    expect(fs.existsSync(path.dirname(tree))).toBe(false);
  });

  it('a push that fails says the stage branch was not changed, with git\'s first line', async () => {
    const sh = fakeSh([
      PIN,
      ['git merge-base --is-ancestor', 1],
      ['git rev-parse HEAD', `${MERGED}\n`],
      ['git push', { status: 1, stderr: '\n ! [rejected] HEAD -> uat (fetch first)\nerror: failed to push\n' }],
    ]);
    const r = await mergeIntoStage(ctxFor(sh), UAT);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('uat was not changed');
    expect(r.reason).toContain('! [rejected] HEAD -> uat (fetch first)');
    expect(r.reason).not.toContain('failed to push');
    const tree = treeOf(sh);
    expect(sh.calls.at(-1)).toBe(`git worktree remove --force ${tree}`);
    expect(fs.existsSync(path.dirname(tree))).toBe(false);
  });

  it('a worktree that cannot be added fails and still cleans up', async () => {
    const sh = fakeSh([PIN, ['git merge-base --is-ancestor', 1], ['git worktree add', 128]]);
    const r = await mergeIntoStage(ctxFor(sh), UAT);
    expect(r.ok).toBe(false);
    const tree = treeOf(sh);
    expect(sh.calls.at(-1)).toBe(`git worktree remove --force ${tree}`);
    expect(fs.existsSync(path.dirname(tree))).toBe(false);
  });
});

describe('mergeIntoStage pins the head that was reviewed', () => {
  const noMergeOrPush = (sh) => {
    expect(sh.calls.some((c) => c.startsWith('git worktree'))).toBe(false);
    expect(sh.calls.some((c) => c.startsWith('git merge '))).toBe(false);
    expect(sh.calls.some((c) => c.startsWith('git push'))).toBe(false);
  };

  it('merges the local story branch head, not the remote ref', async () => {
    const sh = fakeSh([PIN, ['git merge-base --is-ancestor', 1], ['git rev-parse HEAD', `${MERGED}\n`]]);
    const r = await mergeIntoStage(ctxFor(sh), UAT);
    expect(r).toEqual({ ok: true, sha: MERGED, merged: true });
    expect(sh.calls).toContain('git rev-parse --verify refs/heads/story/s-1');
    expect(sh.calls).toContain(`git rev-parse --verify ${STORY_REF}`);
    expect(sh.calls).toContain(`git merge-base --is-ancestor ${STORY_HEAD} ${UAT_REF}`);
    expect(sh.calls).toContain(`git merge --no-ff --no-edit -m Merge story/s-1 into uat for S-1 ${STORY_HEAD}`);
    expect(sh.calls.filter((c) => c.startsWith('git merge')).some((c) => c.includes(STORY_REF))).toBe(false);
  });

  it('refuses a remote story branch that moved past the reviewed head', async () => {
    const sh = fakeSh([
      ['git rev-parse --verify refs/heads/story/s-1', `${STORY_HEAD}\n`],
      [`git rev-parse --verify ${STORY_REF}`, `${MOVED}\n`],
      ['git merge-base --is-ancestor', 1],
    ]);
    const r = await mergeIntoStage(ctxFor(sh), UAT);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('story/s-1');
    expect(r.reason).toContain('fffffff');
    expect(r.reason).toContain('eeeeeee');
    expect(r.reason).toContain('reviewed');
    noMergeOrPush(sh);
  });

  it('refuses a remote story ref that cannot be read', async () => {
    const sh = fakeSh([
      ['git rev-parse --verify refs/heads/story/s-1', `${STORY_HEAD}\n`],
      [`git rev-parse --verify ${STORY_REF}`, 128],
    ]);
    const r = await mergeIntoStage(ctxFor(sh), UAT);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('an unknown commit');
    expect(r.reason).toContain('reviewed');
    noMergeOrPush(sh);
  });

  it.each([
    ['missing', { status: 128, stderr: 'fatal: Needed a single revision' }],
    ['not a sha', 'story/s-1\n'],
  ])('refuses a local story branch that is %s: the reviewed head is not known', async (_, answer) => {
    const sh = fakeSh([
      ['git rev-parse --verify refs/heads/story/s-1', answer],
      [`git rev-parse --verify ${STORY_REF}`, `${STORY_HEAD}\n`],
    ]);
    const r = await mergeIntoStage(ctxFor(sh), UAT);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('the head that was reviewed is not known');
    expect(r.reason).toContain('uat was not changed');
    noMergeOrPush(sh);
  });

  it('a pinned head already on the stage branch is not merged again', async () => {
    const sh = fakeSh([
      PIN,
      [`git merge-base --is-ancestor ${STORY_HEAD} ${UAT_REF}`, 0],
      [`git rev-parse --verify ${UAT_REF}`, `${UAT_HEAD}\n`],
    ]);
    expect(await mergeIntoStage(ctxFor(sh), UAT)).toEqual({ ok: true, sha: UAT_HEAD, merged: false });
    expect(sh.calls.some((c) => c.startsWith('git push'))).toBe(false);
  });
});

describe('mergeIntoStage redacts what git says', () => {
  const TOKEN = `ghp_${'A'.repeat(36)}`;
  const SECRET = 'acme-secret-token-value';

  it('in a fetch failure', async () => {
    const sh = fakeSh([[/^git fetch --quiet origin \+refs\/heads\/uat:/, { status: 128, stderr: `fatal: unable to access 'https://x-access-token:${TOKEN}@github.com/acme/repo.git/'` }]]);
    const r = await mergeIntoStage(ctxFor(sh), UAT);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('could not fetch uat');
    expect(r.reason).toContain('•••');
    expect(r.reason).not.toContain('ghp_AAAA');
  });

  it('in a push failure, with the env secrets', async () => {
    const sh = fakeSh([
      PIN,
      ['git merge-base --is-ancestor', 1],
      ['git rev-parse HEAD', `${MERGED}\n`],
      ['git push', { status: 1, stderr: `remote: invalid credentials ${SECRET}\n` }],
    ]);
    const r = await mergeIntoStage(ctxFor(sh, { env: { GH_TOKEN: SECRET } }), UAT);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('uat was not changed');
    expect(r.reason).toContain('•••');
    expect(r.reason).not.toContain(SECRET);
  });

  it('in a merge failure that is not a conflict', async () => {
    const sh = fakeSh([
      PIN,
      ['git merge-base --is-ancestor', 1],
      ['git merge --no-ff', { status: 128, stderr: `fatal: could not read from https://acme:${SECRET}@github.com, token ${TOKEN}\n` }],
    ]);
    const r = await mergeIntoStage(ctxFor(sh, { env: { GH_TOKEN: SECRET } }), UAT);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('could not merge story/s-1 into uat');
    expect(r.reason).not.toContain(SECRET);
    expect(r.reason).not.toContain('ghp_AAAA');
  });
});

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
function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

describe('mergeIntoStage, with real git', () => {
  let base;
  let origin;
  let repo;

  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  };
  const commit = (message) => {
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', message);
  };

  // main and uat on the remote, uat one commit ahead; story/s-1 from main, pushed.
  function fixture({ conflict = false } = {}) {
    git(base, 'init', '-q', '--bare', '-b', 'main', origin);
    git(base, 'init', '-q', '-b', 'main', repo);
    write('README.md', 'Acme\n');
    commit('Acme base');
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-q', 'origin', 'main');
    git(repo, 'checkout', '-q', '-b', 'uat');
    write('uat.txt', 'Acme UAT notes\n');
    if (conflict) write('README.md', 'Acme, as UAT has it\n');
    commit('UAT notes');
    git(repo, 'push', '-q', 'origin', 'uat');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'checkout', '-q', '-b', 'story/s-1');
    write('README.md', 'Acme, now with the story\n');
    commit('S-1: the story');
    git(repo, 'push', '-q', 'origin', 'story/s-1');
  }

  const ctx = () => ({ sh: realSh(repo, GIT_ENV), root: repo, config: CONFIG, branch: 'story/s-1', story: 'S-1' });

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-stage-merge-test-')));
    origin = path.join(base, 'origin.git');
    repo = path.join(base, 'repo');
  });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  it('pushes a merge commit to uat whose second parent is the story head', async () => {
    fixture();
    const story = git(origin, 'rev-parse', 'story/s-1');
    const before = git(origin, 'rev-parse', 'uat');
    const r = await mergeIntoStage(ctx(), UAT);
    expect(r).toEqual({ ok: true, sha: git(origin, 'rev-parse', 'uat'), merged: true });
    expect(git(origin, 'rev-parse', 'uat^1')).toBe(before);
    expect(git(origin, 'rev-parse', 'uat^2')).toBe(story);
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('story/s-1');

    const again = await mergeIntoStage(ctx(), UAT);
    expect(again).toEqual({ ok: true, sha: r.sha, merged: false });
    expect(git(origin, 'rev-parse', 'uat')).toBe(r.sha);
  });

  it('a remove that fails leaves no stale worktree record: the prune clears it', async () => {
    fixture();
    const real = realSh(repo, GIT_ENV);
    const sh = (cmd, args = [], opts = {}) => (cmd === 'git' && args[0] === 'worktree' && args[1] === 'remove' ? { status: 128, stdout: '', stderr: 'fatal: simulated' } : real(cmd, args, opts));
    const r = await mergeIntoStage({ ...ctx(), sh }, UAT);
    expect(r.ok).toBe(true);
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('prunable');
  });

  it('refuses an unreviewed commit pushed to the remote story branch, and leaves uat where it was', async () => {
    fixture();
    const reviewed = git(repo, 'rev-parse', 'story/s-1');
    write('extra.txt', 'Acme, unreviewed\n');
    commit('S-1: pushed after review');
    git(repo, 'push', '-q', 'origin', 'story/s-1');
    git(repo, 'update-ref', 'refs/heads/story/s-1', reviewed);
    git(repo, 'reset', '-q', '--hard', 'HEAD');
    const before = git(origin, 'rev-parse', 'uat');
    const r = await mergeIntoStage(ctx(), UAT);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('reviewed');
    expect(r.reason).toContain(reviewed.slice(0, 7));
    expect(git(origin, 'rev-parse', 'uat')).toBe(before);
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('refuses when the local story branch is gone, and leaves uat where it was', async () => {
    fixture();
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'branch', '-q', '-D', 'story/s-1');
    const before = git(origin, 'rev-parse', 'uat');
    const r = await mergeIntoStage(ctx(), UAT);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('the head that was reviewed is not known');
    expect(git(origin, 'rev-parse', 'uat')).toBe(before);
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('a conflict leaves uat on the remote where it was', async () => {
    fixture({ conflict: true });
    const before = git(origin, 'rev-parse', 'uat');
    const r = await mergeIntoStage(ctx(), UAT);
    expect(r).toEqual({ ok: false, reason: 'story/s-1 conflicts with uat in: README.md; merge it by hand' });
    expect(git(origin, 'rev-parse', 'uat')).toBe(before);
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
  });
});
