import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectRoot, stateDir, currentSlot } from './paths.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });

describe('projectRoot', () => {
  let base, repo, worktree, plain;
  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-paths-')));
    repo = join(base, 'repo');
    worktree = join(base, 'wt');
    plain = join(base, 'plain');
    execFileSync('mkdir', [repo, plain]);
    git(repo, 'init', '-q');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
    git(repo, 'worktree', 'add', '-q', '-b', 'wt', worktree);
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it('uses FOREMAN_PROJECT_DIR when set', () => {
    expect(projectRoot({ cwd: repo, env: { FOREMAN_PROJECT_DIR: '/some/where' } })).toBe('/some/where');
  });
  it('is the repo when run inside a git repo', () => {
    expect(projectRoot({ cwd: repo, env: {} })).toBe(repo);
  });
  it('is the main checkout when run inside a worktree', () => {
    expect(projectRoot({ cwd: worktree, env: {} })).toBe(repo);
  });
  it('is the main checkout from a sub folder', () => {
    execFileSync('mkdir', ['-p', join(worktree, 'a')]);
    expect(projectRoot({ cwd: join(worktree, 'a'), env: {} })).toBe(repo);
  });
  it('is the current folder outside git', () => {
    expect(projectRoot({ cwd: plain, env: {} })).toBe(plain);
  });
});

describe('stateDir', () => {
  it('prefers FOREMAN_STATE_DIR', () => {
    expect(stateDir('/p', { stateDir: 'x' }, { FOREMAN_STATE_DIR: '/env' })).toBe('/env');
  });
  it('then config.stateDir under the root', () => {
    expect(stateDir('/p', { stateDir: '.factory' }, {})).toBe(join('/p', '.factory'));
  });
  it('then .foreman', () => {
    expect(stateDir('/p', null, {})).toBe(join('/p', '.foreman'));
    expect(stateDir('/p', {}, {})).toBe(join('/p', '.foreman'));
  });
});

describe('currentSlot', () => {
  it('defaults to w1', () => {
    expect(currentSlot({})).toBe('w1');
  });
  it('reads FOREMAN_SLOT', () => {
    expect(currentSlot({ FOREMAN_SLOT: 'w3' })).toBe('w3');
  });
});
