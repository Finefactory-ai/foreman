import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { git, makeRepos, sh, writeFile } from '../../../test/state-repos.mjs';
import { io, recording } from '../../../test/with-state-fixture.mjs';
import { stateMode, withState } from './with-state.mjs';
import { main } from '../cli/main.mjs';

// git and child-process heavy: give each test and hook room on a busy machine.
const SLOW_MS = 30_000;
vi.setConfig({ testTimeout: SLOW_MS, hookTimeout: SLOW_MS });

it('gives each test room on a busy machine', ({ task }) => {
  expect(task.timeout).toBe(SLOW_MS);
});

describe('stateMode: which commands sync', () => {
  it.each([
    [['decide', 'answer', 'd-1', 'Yes'], 'write'],
    [['decide', 'applied', 'd-1'], 'write'],
    [['decide', 'add', '--story', 'S-1'], 'write'],
    [['decide', 'list'], 'read'],
    [['decide', 'pending'], 'read'],
    [['pause'], 'write'],
    [['resume'], 'write'],
    [['stop'], 'write'],
    [['workers', '2'], 'write'],
    [['slot', 'w1', 'skip'], 'write'],
    [['handback', 'S-1'], 'write'],
    [['next', 'S-1'], 'write'],
    [['fixed'], 'write'],
    [['settings', 'set', 'workers', '2'], 'write'],
    [['settings', 'reset', 'workers'], 'write'],
    [['settings', 'set', 'workers', '2', '--team'], null],
    [['settings', 'list'], null],
    [['story', 'start', 'S-1'], 'write'],
    [['story', 'block', 'S-1'], 'write'],
    [['story', 'done', 'S-1'], 'write'],
    [['story', 'todo', 'S-1'], 'write'],
    [['story', 'end', 'shipped'], 'write'],
    [['story', 'set', 'S-1'], 'write'],
    [['story', 'depend', 'S-1'], 'write'],
    [['story', 'finalize', 'S-1'], 'write'],
    [['story', 'next'], 'read'],
    [['story', 'plan'], 'read'],
    [['story', 'summary', 'S-1'], null],
    [['learn'], 'write'],
    [['learn', 'apply', 'd-1'], 'write'],
    [['learn', 'ignore', 'd-1'], 'write'],
    [['learn', 'reopen', 'd-1'], 'write'],
    [['learning', 'list'], 'read'],
    [['learning', 'show', 'L-1'], 'read'],
    [['learning', 'undo', 'L-1'], 'write'],
    [['learning', 'keep', 'L-1'], 'write'],
    [['learning', 'scan'], 'read'],
    [['learning', 'scan', '--dry-run'], 'read'],
    [['learning', 'run', 'f-0123456789ab'], 'write'],
    [['learning', 'run', 'f-0123456789ab', '--dry-run'], 'write'],
    [['learning', 'tick'], 'write'],
    [['learning'], null],
    [['release', 'watch'], 'write'],
    [['release'], null],
    [['claude', 'use-key'], 'write'],
    [['claude'], null],
    [['status'], 'read'],
    [['report'], 'read'],
    [['run'], null],
    [['config', 'check'], null],
  ])('%j is %s', (argv, mode) => {
    expect(stateMode(argv)).toBe(mode);
  });
});

describe('withState with the files store', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-with-state-'));
    writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'T' } }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('just runs the command, with no git at all', async () => {
    const log = [];
    const { stderr } = io();
    const code = await withState({ root: dir, env: {}, stderr, sh: recording(log) }, { write: true, message: 'x' }, async () => 7);
    expect(code).toBe(7);
    expect(log).toEqual([]);
  });

  it('runs the command when the config cannot be read, so the command reports it', async () => {
    writeFileSync(join(dir, 'foreman.config.json'), '{');
    const { stderr } = io();
    expect(await withState({ root: dir, env: {}, stderr, sh }, { write: true }, async () => 3)).toBe(3);
  });
});

describe('withState with the branch store', () => {
  let repos;
  let a;
  beforeEach(() => {
    repos = makeRepos();
    a = repos.clone('a');
  });
  afterEach(() => repos.cleanup());

  it('a write pulls, runs the command, then pushes what it wrote', async () => {
    const log = [];
    const { stderr } = io();
    const code = await withState({ root: a, env: {}, stderr, sh: recording(log), sleep: async () => {} }, { write: true, message: 'pause' }, async () => {
      log.push('command');
      writeFile(join(a, '.foreman', 'control.json'), '{"paused":true}\n');
      return 0;
    });
    expect(code).toBe(0);
    const at = log.indexOf('command');
    expect(log.slice(0, at)).toContain('git fetch');
    expect(log.slice(at)).toContain('git push');
    expect(log.slice(at)).not.toContain('git fetch');
    expect(repos.remoteFile('control.json')).toBe('{"paused":true}');
  });

  it('does no git at all inside a run that syncs around itself (FOREMAN_STATE_SYNC=off)', async () => {
    const log = [];
    const { stderr } = io();
    const code = await withState({ root: a, env: { FOREMAN_STATE_SYNC: 'off' }, stderr, sh: recording(log) }, { write: true, message: 'x' }, async () => 5);
    expect(code).toBe(5);
    expect(log).toEqual([]);
  });

  it('a read pulls and never pushes', async () => {
    const log = [];
    const { stderr } = io();
    await withState({ root: a, env: {}, stderr, sh: recording(log) }, { write: false }, async () => {
      log.push('command');
      return 0;
    });
    const at = log.indexOf('command');
    expect(log.slice(0, at)).toContain('git fetch');
    expect(log.slice(at)).toEqual(['command']);
  });

  it('a write stops before the command when the state cannot be fetched', async () => {
    const offline = (cmd, args, opts) => (args.includes('fetch') || args.includes('ls-remote') ? { status: 128, stdout: '', stderr: 'could not read from remote' } : sh(cmd, args, opts));
    const { out, stderr } = io();
    let ran = false;
    const code = await withState({ root: a, env: {}, stderr, sh: offline }, { write: true, message: 'x' }, async () => {
      ran = true;
      return 0;
    });
    expect(code).toBe(1);
    expect(ran).toBe(false);
    expect(out.stderr).toMatch(/could not read from remote/);
  });

  it('a read carries on with this machine\'s copy when the state cannot be fetched', async () => {
    const offline = (cmd, args, opts) => (args.includes('fetch') || args.includes('ls-remote') ? { status: 128, stdout: '', stderr: 'offline' } : sh(cmd, args, opts));
    const { out, stderr } = io();
    expect(await withState({ root: a, env: {}, stderr, sh: offline }, { write: false }, async () => 0)).toBe(0);
    expect(out.stderr).toMatch(/^warning: .*this machine's copy/m);
  });

  it('a push that keeps failing says the change is kept here and fails the command', async () => {
    const { out, stderr } = io();
    const noPush = (cmd, args, opts) => (args.includes('push') ? { status: 1, stdout: '', stderr: 'rejected' } : sh(cmd, args, opts));
    await withState({ root: a, env: {}, stderr, sh, sleep: async () => {} }, { write: false }, async () => 0); // set up
    const code = await withState({ root: a, env: {}, stderr, sh: noPush, sleep: async () => {} }, { write: true, message: 'x' }, async () => {
      writeFile(join(a, '.foreman', 'control.json'), '{"paused":true}\n');
      return 0;
    });
    expect(code).toBe(1);
    expect(out.stderr).toMatch(/kept on this machine/);
  });
});

describe('the foreman launcher on the branch store', () => {
  let repos;
  afterEach(() => repos.cleanup());

  // Real processes, the real shell and no git identity on the machine (a fresh cloud runner).
  const BIN = fileURLToPath(new URL('../../bin/foreman', import.meta.url));
  const foreman = (cwd, ...args) => {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const r = spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };

  it('decide answer in one clone shows as answered in decide list in the other', () => {
    repos = makeRepos();
    const a = repos.clone('a');
    const b = repos.clone('b');
    const add = foreman(a, 'decide', 'add', '--story', 'S-1', '--kind', 'decision', '--title', 'Which table?', '--option', 'Reuse', '--option', 'New');
    expect(add.stderr).toBe('');
    const id = add.stdout.trim();
    expect(foreman(b, 'decide', 'answer', id, 'Reuse')).toMatchObject({ code: 0, stdout: `${id} answered: Reuse\n` });
    const list = foreman(a, 'decide', 'list');
    expect(list.code).toBe(0);
    expect(list.stdout).toContain(`${id}  decision for S-1: Which table?  [answered: Reuse]`);
    expect(git(repos.remote, 'log', '-1', '--format=%an %s', 'foreman-state')).toBe('Foreman foreman decide answer');
  });
});

describe('foreman commands on the files store', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-files-store-'));
    writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'T' } }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('decide answer runs no git and writes the plain state folder', async () => {
    const log = [];
    const { stdout, stderr } = io();
    const ctx = { cwd: dir, env: { FOREMAN_PROJECT_DIR: dir }, stdout, stderr, sh: recording(log) };
    expect(await main(['decide', 'add', '--story', 'S-1', '--kind', 'task', '--title', 'Do it'], ctx)).toBe(0);
    expect(await main(['pause'], ctx)).toBe(0);
    expect(log).toEqual([]);
    expect(existsSync(join(dir, '.foreman', '.git'))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, '.foreman', 'control.json'), 'utf8')).paused).toBe(true);
  });
});
