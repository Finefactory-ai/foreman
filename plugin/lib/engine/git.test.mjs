import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeInProgress } from './git.mjs';

describe('mergeInProgress', () => {
  let dir;
  let ctx;
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout;
  };
  const commit = (file) => {
    fs.writeFileSync(path.join(dir, file), `${file}\n`);
    git('add', file);
    git('commit', '-q', '-m', file);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-git-'));
    ctx = { sh: (cmd, args) => spawnSync(cmd, args, { cwd: dir, encoding: 'utf8' }) };
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Acme');
    git('config', 'user.email', 'acme@example.com');
    git('config', 'commit.gpgsign', 'false');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('false on a plain repo with no merge', () => {
    commit('a.txt');
    expect(mergeInProgress(ctx)).toBe(false);
  });

  it('true while a merge is staged, also when the tree equals HEAD, and false once it is committed', () => {
    commit('a.txt');
    git('checkout', '-q', '-b', 'side');
    commit('b.txt');
    git('checkout', '-q', 'main');
    commit('c.txt');
    git('merge', '-q', '--no-commit', '--no-ff', '-s', 'ours', 'side');
    expect(mergeInProgress(ctx)).toBe(true);
    expect(git('status', '--porcelain')).toBe('');
    git('commit', '-q', '--no-edit');
    expect(mergeInProgress(ctx)).toBe(false);
  });
});
