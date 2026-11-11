import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTempTree } from './temp-tree.mjs';

describe('removeTempTree, with a fake git', () => {
  let tmp;
  let tree;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-temp-tree-test-'));
    tree = path.join(tmp, 'tree');
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const recorder = (answers = {}) => {
    const calls = [];
    const opts = [];
    const goneAt = [];
    const git = (args, cwd) => {
      const line = args.join(' ');
      calls.push(line);
      opts.push(cwd);
      goneAt.push(!fs.existsSync(tmp));
      const answer = answers[args.slice(0, 2).join(' ')];
      return answer === undefined ? { status: 0 } : answer;
    };
    return { git, calls, opts, goneAt };
  };

  it('a remove that succeeds runs no prune, and the folder is gone', () => {
    const r = recorder();
    expect(removeTempTree(r.git, tree, tmp)).toBeUndefined();
    expect(r.calls).toEqual([`worktree remove --force ${tree}`]);
    expect(fs.existsSync(tmp)).toBe(false);
  });

  it('a remove that fails is followed by a prune, after the folder is deleted', () => {
    const r = recorder({ 'worktree remove': { status: 128, stderr: 'fatal: simulated' } });
    removeTempTree(r.git, tree, tmp);
    expect(r.calls).toEqual([`worktree remove --force ${tree}`, 'worktree prune']);
    expect(r.goneAt).toEqual([false, true]);
    expect(fs.existsSync(tmp)).toBe(false);
  });

  it('a git that gives no status still gets the prune, and nothing throws', () => {
    const r = recorder({ 'worktree remove': {}, 'worktree prune': {} });
    expect(() => removeTempTree(r.git, tree, tmp)).not.toThrow();
    expect(r.calls).toEqual([`worktree remove --force ${tree}`, 'worktree prune']);
    expect(fs.existsSync(tmp)).toBe(false);
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
const run = (cwd, args) => spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function git(cwd, ...args) {
  const r = run(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

describe('removeTempTree, with real git', () => {
  let base;
  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-temp-tree-real-')));
  });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  it('a remove that fails leaves no stale record, and leaves a live worktree alone', () => {
    const repo = path.join(base, 'repo');
    git(base, 'init', '-q', '-b', 'main', repo);
    fs.writeFileSync(path.join(repo, 'README.md'), 'Acme\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'Acme base');
    const live = path.join(base, 'live');
    git(repo, 'worktree', 'add', '-q', '--detach', live, 'HEAD');
    const tmp = path.join(base, 'tmp');
    fs.mkdirSync(tmp);
    const tree = path.join(tmp, 'tree');
    git(repo, 'worktree', 'add', '-q', '--detach', tree, 'HEAD');

    const wrapped = (args, cwd = repo) => {
      if (args[0] === 'worktree' && args[1] === 'remove') return { status: 128, stderr: 'fatal: simulated' };
      const r = run(cwd, args);
      return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
    };
    removeTempTree(wrapped, tree, tmp);

    const listed = git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree '));
    expect(listed).toEqual([`worktree ${repo}`, `worktree ${live}`]);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('prunable');
    expect(fs.existsSync(tmp)).toBe(false);
    expect(fs.existsSync(live)).toBe(true);
  });
});
