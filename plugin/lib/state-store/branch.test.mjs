// The branch state store (branch.mjs): the state worktree, which files are committed, the secret
// patterns and the shell. syncState is in branch-sync.test.mjs and branch-sync-recovery.test.mjs;
// the fixture the git tests share is test/state-branch-fixture.mjs.

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, sh, writeFile } from '../../../test/state-repos.mjs';
import { a, b, D1, D2, decision, LEARNING, opts, pull, push, readDecision, repos, withClones } from '../../../test/state-branch-fixture.mjs';
import { changedFiles, committable, defaultSh, ensureStateWorktree, GITIGNORE, looksSecret, SECRET_PATTERNS } from './branch.mjs';

// git and child-process heavy: give each test and hook room on a busy machine.
const SLOW_MS = 30_000;
vi.setConfig({ testTimeout: SLOW_MS, hookTimeout: SLOW_MS });

it('gives each test room on a busy machine', ({ task }) => {
  expect(task.timeout).toBe(SLOW_MS);
});

describe('ensureStateWorktree', () => {
  withClones();

  it('the first sync creates the orphan branch on the remote, holding only state', async () => {
    expect(repos.remoteFiles()).toEqual([]);
    await pull(a);
    expect(repos.remoteFiles()).toEqual(['.gitattributes', '.gitignore']);
    // An orphan: no history shared with main.
    expect(sh('git', ['merge-base', 'main', 'foreman-state'], { cwd: repos.remote }).status).not.toBe(0);
    expect(git(repos.remote, 'rev-list', '--count', 'foreman-state')).toBe('1');
    const state = join(a, '.foreman');
    expect(git(state, 'symbolic-ref', '--short', 'HEAD')).toBe('foreman-state');
    expect(readFileSync(join(state, '.gitignore'), 'utf8')).toMatch(/^logs\/$/m);
  });

  it('leaves the project clean: the state folder never shows in its git status', async () => {
    await pull(a);
    decision(a, D1);
    writeFile(join(a, '.foreman', 'logs', 'w1.log'), 'x\n');
    expect(git(a, 'status', '--porcelain')).toBe('');
    expect(git(a, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
  });

  it('a second clone checks out the branch the first one made', async () => {
    await pull(a);
    decision(a, D1);
    await push(a);
    const r = ensureStateWorktree(opts(b));
    expect(r.created).toBe(true);
    expect(readDecision(b, D1).id).toBe(D1);
  });

  it('is a no-op once the state folder is the worktree', async () => {
    await pull(a);
    const r = ensureStateWorktree(opts(a));
    expect(r.created).toBe(false);
  });

  it('moves files already in the state folder into the worktree, once', async () => {
    decision(a, D1);
    writeFile(join(a, '.foreman', 'control.json'), '{"paused":true}\n');
    writeFile(join(a, '.foreman', 'logs', 'w1-1.log'), 'a log\n');
    const r = ensureStateWorktree(opts(a));
    expect(r.created).toBe(true);
    expect(r.moved).toEqual(expect.arrayContaining(['decisions', 'control.json', 'logs']));
    expect(readDecision(a, D1).id).toBe(D1);
    expect(readFileSync(join(a, '.foreman', 'logs', 'w1-1.log'), 'utf8')).toBe('a log\n');
    await push(a);
    expect(repos.remoteFiles()).toEqual(['.gitattributes', '.gitignore', 'control.json', `decisions/${D1}.json`]);
  });

  it('keeps the remote copy when a moved file is already on the branch, and says where the local one is', async () => {
    await pull(a);
    writeFile(join(a, '.foreman', 'control.json'), '{"paused":true}\n');
    await push(a);
    writeFile(join(b, '.foreman', 'control.json'), '{"paused":false}\n');
    decision(b, D2);
    const r = ensureStateWorktree(opts(b));
    expect(readFileSync(join(b, '.foreman', 'control.json'), 'utf8')).toBe('{"paused":true}\n');
    expect(readDecision(b, D2).id).toBe(D2);
    expect(r.leftover).toBeTruthy();
    expect(readFileSync(join(r.leftover, 'control.json'), 'utf8')).toBe('{"paused":false}\n');
  });
});

describe('committable and changedFiles', () => {
  withClones();

  it('keeps the state files and nothing else', () => {
    for (const f of ['state.json', 'control.json', 'decisions/d-1.json', 'claims/P1-01.json', 'locks/schema.json', 'stories/P1-01.json', 'stories/new/F-1.md', 'runs/x.json', 'learn.json', 'settings.json', 'findings.jsonl', 'events.jsonl', 'HALT', 'STOP', 'last-stop', 'jira-outbox/1-ab.json', 'parks/APP-1.json', 'waits/ACME-2.json', 'locks/file-0123456789abcdef.json', ...LEARNING]) {
      expect(committable(f), f).toBe(true);
    }
    expect(committable('learner.jsonl')).toBe(true);
    expect(committable('claude-signin.json')).toBe(true);
    for (const f of ['logs/a.log', 'worktrees/w1/x', 'sync/x.json', 'decisions/d-1.json.1.tmp', 'jira/list.json', 'slots/w1/agents/a.json', '.env', 'id_rsa', 'x.pem', 'notes.txt', 'decisions/sub/x.json', 'stories/S-1.md', 'jira-outbox/.lock', '../x.json', 'parks/APP-1.json.1.2.tmp', 'learned/traits/developer.md.1.tmp', 'learning.lock', 'lessons.json', 'waits/ACME-2.json.1.tmp', 'waits/sub/x.json', 'session-config/w1-settings.json', 'session-config/w1-mcp.json']) {
      expect(committable(f), f).toBe(false);
    }
  });

  it("keeps the sessions' settings and MCP files out of git status", () => {
    expect(GITIGNORE.split('\n')).toContain('session-config/');
  });

  it('stages the learning ledger and learned files', async () => {
    await pull(a);
    const s = join(a, '.foreman');
    for (const f of LEARNING) writeFile(join(s, f), f.endsWith('.jsonl') ? '{"action":"add","id":"L-1"}\n' : '[L-1] Acme: every route has a test\n');
    writeFile(join(s, 'learning.lock'), '{"pid":1}');
    await push(a);
    const remote = repos.remoteFiles();
    expect(remote).toEqual(expect.arrayContaining(LEARNING));
    expect(remote).not.toContain('learning.lock');
    const count = () => Number(git(repos.remote, 'rev-list', '--count', 'foreman-state'));
    const commits = count();
    writeFile(join(s, 'learned', 'traits', 'developer.md'), '[L-1] Acme: every route has a test that fails\n');
    await push(a);
    expect(count()).toBe(commits + 1);
  });

  it('refuses a learned file that holds a token', async () => {
    await pull(a);
    writeFile(join(a, '.foreman', 'learned', 'traits', 'developer.md'), `[L-1] use ghp_${'a'.repeat(36)}\n`);
    const r = await push(a);
    expect(r.refused).toEqual(['learned/traits/developer.md']);
    expect(repos.remoteFiles()).not.toContain('learned/traits/developer.md');
  });

  it('lists the state files changed since the last commit, with their content', async () => {
    await pull(a);
    decision(a, D1);
    writeFile(join(a, '.foreman', 'logs', 'x.log'), 'x\n');
    const writes = changedFiles(opts(a));
    expect([...writes.keys()]).toEqual([`decisions/${D1}.json`]);
    expect(JSON.parse(writes.get(`decisions/${D1}.json`)).id).toBe(D1);
  });
});

describe('SECRET_PATTERNS and looksSecret', () => {
  // Built at run time, so no file holds a whole token.
  const SAMPLES = [
    [`ghp_${'a'.repeat(36)}`, true],
    [`ghs_${'B'.repeat(40)}`, true],
    [`github_pat_${'c'.repeat(40)}`, true],
    [`sk-ant-${'d'.repeat(20)}`, true],
    [`sk_live_${'e'.repeat(16)}`, true],
    ['AKIA' + 'ABCDEFGH23456789', true],
    [`xoxb-${'1'.repeat(10)}`, true],
    ['-----BEGIN RSA PRIVATE KEY-----', true],
    [`ghp_${'a'.repeat(35)}`, false],
    [`sk-ant-${'d'.repeat(19)}`, false],
    ['Acme routes have tests', false],
    ['', false],
  ];

  it('exports the patterns looksSecret uses', () => {
    expect(SECRET_PATTERNS.length).toBe(7);
    expect(SECRET_PATTERNS.every((re) => re instanceof RegExp && !re.global)).toBe(true);
  });

  it.each(SAMPLES)('looksSecret(%j) is %s, as before', (text, secret) => {
    expect(looksSecret(text)).toBe(secret);
    expect(SECRET_PATTERNS.some((re) => re.test(text))).toBe(secret);
  });

  it('looksSecret is false for anything but a string', () => {
    expect(looksSecret(null)).toBe(false);
    expect(looksSecret({ a: `ghp_${'a'.repeat(36)}` })).toBe(false);
  });
});

describe('defaultSh', () => {
  it('says 127 and the spawn error when the command is not found', () => {
    const r = defaultSh('foreman-no-such-command-acme', []);
    expect(r.status).toBe(127);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/ENOENT/);
  });

  it("passes a real command's exit status through", () => {
    expect(defaultSh(process.execPath, ['-e', 'process.exit(3)'])).toMatchObject({ status: 3, stderr: '' });
  });
});
