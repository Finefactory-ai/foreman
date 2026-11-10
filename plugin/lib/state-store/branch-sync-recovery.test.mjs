// syncState on the branch state store, when things go wrong: a push that keeps failing, files
// that must never be committed, a rebase a crash left half done, and a slot worktree inside the
// state folder. The fixture is test/state-branch-fixture.mjs.

import { describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { git, sh, writeFile } from '../../../test/state-repos.mjs';
import { a, b, D1, D2, decision, pull, push, repos, withClones } from '../../../test/state-branch-fixture.mjs';
import { ensureWorktree, worktreeDirty } from '../engine/worktree.mjs';

// git and child-process heavy: give each test and hook room on a busy machine.
const SLOW_MS = 30_000;
vi.setConfig({ testTimeout: SLOW_MS, hookTimeout: SLOW_MS });

describe('syncState', () => {
  withClones();

  it('gives up after 5 tries with a short jittered wait between them', async () => {
    await pull(a);
    decision(a, D1);
    const failingPush = (cmd, args, o) => (args.includes('push') ? { status: 1, stdout: '', stderr: 'rejected' } : sh(cmd, args, o));
    const sleeps = [];
    await expect(push(a, 'x', { sh: failingPush, sleep: async (ms) => sleeps.push(ms) })).rejects.toThrow(/5 tries.*rejected/s);
    expect(sleeps).toHaveLength(4);
    for (const ms of sleeps) {
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThan(3000);
    }
    // The change is kept locally, committed, for the next sync to send.
    expect(git(join(a, '.foreman'), 'status', '--porcelain')).toBe('');
    await push(a);
    expect(repos.remoteFiles()).toContain(`decisions/${D1}.json`);
  });

  it('never commits logs, worktrees, raw copies, temp files, caches or secret-like files', async () => {
    await pull(a);
    const s = join(a, '.foreman');
    decision(a, D1);
    writeFile(join(s, 'logs', 'w1-20261018.log'), 'raw session log\n');
    writeFile(join(s, 'worktrees', 'w9', 'file.txt'), 'x\n');
    writeFile(join(s, 'sync', 'decisions', 'items', 'x.json'), '{}\n');
    writeFile(join(s, 'decisions', `${D2}.json.123.tmp`), '{}\n');
    writeFile(join(s, 'jira', 'list.json'), '{}\n');
    writeFile(join(s, 'slots', 'w1', 'agents', 'x.json'), '{}\n');
    writeFile(join(s, 'slots', 'w1', 'spans.jsonl'), '{}\n');
    writeFile(join(s, 'slots', 'w1.install'), 'hash\n');
    writeFile(join(s, 'slots', 'w1.json'), '{"state":"idle"}\n');
    writeFile(join(s, 'status.json'), '{}\n');
    writeFile(join(s, '.env'), 'KEY=1\n');
    writeFile(join(s, 'deploy.pem'), 'x\n');
    writeFile(join(s, 'notes.txt'), 'not state\n');
    writeFile(join(s, 'runs', 'S-1-20261018-090000.json'), '{}\n');
    writeFile(join(s, 'stories', 'S-1.json'), '{}\n');
    writeFile(join(s, 'stories', 'S-1.md'), 'a Jira brief\n');
    writeFile(join(s, 'claims', 'S-1.json'), '{}\n');
    writeFile(join(s, 'locks', 'ship.json'), '{}\n');
    writeFile(join(s, 'learn.json'), '{}\n');
    writeFile(join(s, 'settings.json'), '{}\n');
    writeFile(join(s, 'STOP'), 'now\n');
    await push(a);
    expect(repos.remoteFiles()).toEqual([
      '.gitattributes',
      '.gitignore',
      'STOP',
      'claims/S-1.json',
      `decisions/${D1}.json`,
      'learn.json',
      'locks/ship.json',
      'runs/S-1-20261018-090000.json',
      'settings.json',
      'slots/w1.json',
      'stories/S-1.json',
    ]);
  });

  it('refuses to commit a state file that holds a token, and says so', async () => {
    await pull(a);
    decision(a, D1);
    writeFile(join(a, '.foreman', 'decisions', `${D2}.json`), `{"body":"use ghp_${'a'.repeat(36)}"}\n`);
    const r = await push(a);
    expect(r.refused).toEqual([`decisions/${D2}.json`]);
    expect(repos.remoteFiles()).toContain(`decisions/${D1}.json`);
    expect(repos.remoteFiles()).not.toContain(`decisions/${D2}.json`);
  });

  it('recovers from a rebase a crash left half done', async () => {
    await pull(a);
    await pull(b);
    writeFile(join(a, '.foreman', 'control.json'), '{"paused":true}\n');
    await push(a);
    writeFile(join(b, '.foreman', 'control.json'), '{"paused":false}\n');
    const sb = join(b, '.foreman');
    git(sb, 'add', '-A');
    git(sb, 'commit', '-qm', 'local');
    git(sb, 'fetch', '-q', 'origin', 'foreman-state');
    expect(sh('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'rebase', 'origin/foreman-state'], { cwd: sb }).status).not.toBe(0); // left mid-rebase
    await push(b);
    expect(repos.remoteFile('control.json')).toBe('{"paused":false}');
  });

  it('a slot worktree inside the state folder is never committed and is not dirty', async () => {
    await pull(a);
    const config = { slots: 1, remote: 'origin', baseBranch: 'main', envFile: '.env.local', install: null };
    const { path } = ensureWorktree({ anchor: a, stateDir: join(a, '.foreman'), n: 1, config, sh });
    writeFile(join(path, 'work.txt'), 'building\n');
    expect(worktreeDirty(path, { sh })).toBe(true);
    rmSync(join(path, 'work.txt'));
    expect(worktreeDirty(path, { sh })).toBe(false);
    decision(a, D1);
    await push(a);
    expect(repos.remoteFiles().some((f) => f.startsWith('worktrees/'))).toBe(false);
    expect(git(join(a, '.foreman'), 'status', '--porcelain')).toBe('');
    expect(git(a, 'status', '--porcelain')).toBe('');
  });
});
