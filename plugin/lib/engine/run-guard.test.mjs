import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  canonicalPath,
  guardedWrite,
  isAnchorTarget,
  ownerControl,
  ownerEnv,
  ownerFilesWrite,
  parentChain,
  ppidLookup,
  ppidOf,
  processTable,
  refuseAnchorWrite,
  refuseInRun,
  refuseOwnerControl,
  refuseRunState,
  sessionPlace,
  storySession,
  unknownPlace,
} from './run-guard.mjs';

describe('refuseInRun', () => {
  it('lets a command run outside a story session', () => {
    expect(refuseInRun({}, 'foreman keys migrate')).toBeNull();
    expect(refuseInRun({ FOREMAN_RUN: '0' }, 'foreman keys migrate')).toBeNull();
    expect(refuseInRun(undefined, 'foreman keys migrate')).toBeNull();
  });

  it('refuses inside one, naming the command', () => {
    expect(refuseInRun({ FOREMAN_RUN: '1' }, 'foreman keys migrate')).toBe(
      "foreman keys migrate does not run inside a Foreman story session (FOREMAN_RUN=1); run it yourself from the project's folder.",
    );
  });
});

describe('guardedWrite', () => {
  it.each([
    [['settings', 'set', 'workers', '1'], 'foreman settings set'],
    [['settings', 'reset', 'workers'], 'foreman settings reset'],
    [['settings', 'set', 'workers', '1', '--team'], 'foreman settings set'],
    [['settings', '--group', 'run', 'set', 'workers', '1'], 'foreman settings set'],
    [['features', 'on', 'learning'], 'foreman features on'],
    [['features', 'off', 'learning'], 'foreman features off'],
    [['init', 'write'], 'foreman init write'],
    [['traits', 'add', 'all', 'Acme rule'], 'foreman traits add'],
    [['learning', 'undo', 'L-1'], 'foreman learning undo'],
    [['learning', 'keep', 'L-1'], 'foreman learning keep'],
    [['learn', 'reopen', 'D-1'], 'foreman learn reopen'],
    [['learn', '--min-stories', '2', 'reopen', 'D-1'], 'foreman learn reopen'],
    [['learn', 'undo', 'd-1'], 'foreman learn undo'],
    [['learn', '--dry-run', 'undo', 'd-1'], 'foreman learn undo'],
    [['decide', 'answer', 'D-1', 'yes'], 'foreman decide answer'],
    [['decide', '--note', 'why', 'answer', 'D-1'], 'foreman decide answer'],
    [['run'], 'foreman run'],
    [['run', '--dry-run'], 'foreman run'],
    [['pause'], 'foreman pause'],
    [['resume'], 'foreman resume'],
    [['stop'], 'foreman stop'],
    [['fixed'], 'foreman fixed'],
    [['slot', 'w1', 'park'], 'foreman slot'],
    [['workers', '1'], 'foreman workers'],
    [['handback', 'S-1'], 'foreman handback'],
    [['next', 'S-1'], 'foreman next'],
    [['sf', 'deletes', 'allow', 'S-1'], 'foreman sf deletes'],
    [['sf', 'deletes', 'keep-out', 'S-1'], 'foreman sf deletes'],
    [['claude', 'use-key'], 'foreman claude use-key'],
  ])('labels %j', ([name, ...args], label) => {
    expect(guardedWrite(name, args)).toBe(label);
  });

  it.each([
    [['settings', 'get', 'workers']],
    [['settings', 'list']],
    [['init', 'detect']],
    [['learning', 'list']],
    [['learning', 'show', 'L-1']],
    [['learn']],
    [['learn', 'apply', 'D-1']],
    [['learn', 'ignore', 'D-1']],
    [['decide', 'add', '--summary', 'answer this']],
    [['decide', 'applied', 'D-1']],
    [['decide', 'pending']],
    [['decide', 'list']],
    [['story', 'next']],
    [['config', 'show']],
    [['keys', 'list']],
    [['constructor']],
    [['sf', 'baseline']],
    [['sf', 'skills']],
    [['sf', 'rollback', 'S-1']],
    [['claude']],
  ])('leaves %j alone', ([name, ...args]) => {
    expect(guardedWrite(name, args)).toBeNull();
  });
});

describe('ownerFilesWrite', () => {
  it('is guardedWrite plus every keys subcommand', () => {
    expect(ownerFilesWrite('settings', ['set', 'workers', '1'])).toBe('foreman settings set');
    expect(ownerFilesWrite('settings', ['get', 'workers'])).toBeNull();
    expect(ownerFilesWrite('keys', ['migrate'])).toBe('foreman keys migrate');
    expect(ownerFilesWrite('keys', ['--project', '/a', 'set', 'JIRA_TOKEN'])).toBe('foreman keys set');
    expect(ownerFilesWrite('keys', ['list'])).toBe('foreman keys list');
    expect(ownerFilesWrite('keys', [])).toBe('foreman keys');
    expect(ownerFilesWrite('story', ['next'])).toBeNull();
  });
});

describe('ownerEnv', () => {
  it('is a copy without FOREMAN_RUN, FOREMAN_STORY and FOREMAN_SLOT that keeps every other variable', () => {
    const env = { FOREMAN_RUN: '1', FOREMAN_STORY: 'S-1', FOREMAN_SLOT: 'w1', FOREMAN_PROJECT_DIR: '/acme', FOREMAN_STATE_DIR: '/acme/.foreman', PATH: '/usr/bin' };
    expect(ownerEnv(env)).toEqual({ FOREMAN_PROJECT_DIR: '/acme', FOREMAN_STATE_DIR: '/acme/.foreman', PATH: '/usr/bin' });
    expect(storySession(ownerEnv(env))).toBe(false);
  });

  it('does not change its input', () => {
    const env = { FOREMAN_RUN: '1', FOREMAN_STORY: 'S-1', FOREMAN_SLOT: 'w1', FOREMAN_PROJECT_DIR: '/acme' };
    const copy = ownerEnv(env);
    expect(env).toEqual({ FOREMAN_RUN: '1', FOREMAN_STORY: 'S-1', FOREMAN_SLOT: 'w1', FOREMAN_PROJECT_DIR: '/acme' });
    expect(copy).not.toBe(env);
  });
});

describe('storySession', () => {
  it.each([[{}], [{ FOREMAN_RUN: '' }], [{ FOREMAN_PROJECT_DIR: '/acme' }], [{ FOREMAN_STATE_DIR: '/acme/.foreman', FOREMAN_STORY: '', FOREMAN_SLOT: '' }], [undefined]])('is false for %j', (env) => {
    expect(storySession(env)).toBe(false);
  });

  it.each([[{ FOREMAN_RUN: '1' }], [{ FOREMAN_RUN: '0' }], [{ FOREMAN_STORY: 'S-1' }], [{ FOREMAN_SLOT: 'w1' }]])('is true for %j', (env) => {
    expect(storySession(env)).toBe(true);
  });
});

describe('ownerControl', () => {
  it.each([
    [['stop'], 'foreman stop'],
    [['stop', '--now'], 'foreman stop'],
    [['pause'], 'foreman pause'],
    [['resume'], 'foreman resume'],
    [['fixed'], 'foreman fixed'],
    [['workers', '1'], 'foreman workers'],
    [['slot', 'w1', 'park'], 'foreman slot'],
    [['handback', 'S-1'], 'foreman handback'],
    [['next', 'S-1'], 'foreman next'],
    [['run'], 'foreman run'],
    [['run', '--dry-run'], 'foreman run'],
    [['service', 'install'], 'foreman service install'],
    [['service', 'uninstall'], 'foreman service uninstall'],
    [['settings', 'set', 'workers', '1'], 'foreman settings set'],
    [['settings', 'set', 'workers', '1', '--team'], 'foreman settings set'],
    [['settings', '--group', 'run', 'set', 'workers', '1'], 'foreman settings set'],
    [['settings', '--group=run', 'set', 'workers', '1'], 'foreman settings set'],
    [['settings', '--team', 'reset', 'workers'], 'foreman settings reset'],
    [['settings', 'reset', 'workers'], 'foreman settings reset'],
    [['features', 'on', 'learning'], 'foreman features on'],
    [['features', '--team', 'off', 'learning'], 'foreman features off'],
  ])('labels %j', ([name, ...args], label) => {
    expect(ownerControl(name, args)).toBe(label);
  });

  it.each([
    [['service', 'status']],
    [['service']],
    [['settings', 'get', 'workers']],
    [['settings', '--group', 'set', 'list']],
    [['settings', 'list']],
    [['features', 'list']],
    [['features']],
    [['traits', 'add', 'all', 'Acme rule']],
    [['decide', 'add', '--title', 'stop']],
    [['status']],
    [['story', 'next']],
    [['constructor']],
  ])('leaves %j alone', ([name, ...args]) => {
    expect(ownerControl(name, args)).toBeNull();
  });
});

describe('parentChain', () => {
  const from = (map) => (pid) => (Object.hasOwn(map, pid) ? map[pid] : null);

  it('walks up to the first pid at or below 1', () => {
    expect(parentChain({ start: 10, lookup: from({ 10: 7, 7: 3, 3: 1 }) })).toEqual([10, 7, 3]);
    expect(parentChain({ start: 10, lookup: from({ 10: 7, 7: 0 }) })).toEqual([10, 7]);
  });

  it('stops before a pid it has seen', () => {
    expect(parentChain({ start: 10, lookup: from({ 10: 7, 7: 3, 3: 10 }) })).toEqual([10, 7, 3]);
  });

  it('stops at max entries', () => {
    const lookup = (pid) => pid + 1;
    expect(parentChain({ start: 100, lookup, max: 4 })).toEqual([100, 101, 102, 103]);
  });

  it('is null when any lookup fails, not only the first', () => {
    expect(parentChain({ start: 10, lookup: from({ 10: 7 }) })).toBeNull();
    expect(parentChain({ start: 10, lookup: from({ 10: 7, 7: 3 }) })).toBeNull();
  });

  it('walks the whole chain with one ps call when /proc has none', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-chain-'));
    try {
      const calls = [];
      const sh = (cmd, args) => {
        calls.push([cmd, ...args]);
        return { status: 0, stdout: '    1     0\n   3   1\n  7 3\n 10 7\n' };
      };
      expect(parentChain({ start: 10, lookup: ppidLookup({ proc: tmp, sh }) })).toEqual([10, 7, 3]);
      expect(calls).toEqual([['ps', '-A', '-o', 'pid=,ppid=']]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('is null when the first lookup fails', () => {
    expect(parentChain({ start: 10, lookup: () => null })).toBeNull();
  });

  it('is empty from pid 1 or below, without a lookup', () => {
    const lookup = () => {
      throw new Error('no lookup expected');
    };
    expect(parentChain({ start: 1, lookup })).toEqual([]);
    expect(parentChain({ start: 0, lookup })).toEqual([]);
  });

  it('starts at this process\'s parent by default', () => {
    const chain = parentChain();
    expect(chain[0]).toBe(process.ppid);
    expect(chain).not.toContain(process.pid);
  });
});

describe('ppidLookup and processTable', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-ppid-lookup-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const noPs = () => {
    throw new Error('ps not expected');
  };
  const recording = (answer) => {
    const calls = [];
    const sh = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (typeof answer === 'function') return answer();
      return answer;
    };
    return { calls, sh };
  };

  it('answers from /proc and never runs ps for a pid with a stat file', () => {
    fs.mkdirSync(path.join(tmp, '123'));
    fs.writeFileSync(path.join(tmp, '123', 'stat'), '123 (acme (x) y) S 77 123 123 0 -1 4194560\n');
    const lookup = ppidLookup({ proc: tmp, sh: noPs });
    expect(lookup(123)).toBe(77);
    expect(lookup(123)).toBe(77);
  });

  it('answers a pid with no stat file from the table, reading it once', () => {
    const { calls, sh } = recording({ status: 0, stdout: '  123  4242\n' });
    const lookup = ppidLookup({ proc: tmp, sh });
    expect(lookup(123)).toBe(4242);
    expect(lookup(77)).toBeNull();
    expect(calls).toEqual([['ps', '-A', '-o', 'pid=,ppid=']]);
  });

  it.each([
    ['ps fails', () => ({ status: 1, stdout: '' })],
    ['ps cannot run', () => ({ error: new Error('spawnSync ps ENOENT'), status: null })],
    ['ps throws', () => { throw new Error('boom'); }],
    ['ps gives no table', () => ({ status: 0, stdout: 'acme\n' })],
  ])('is null when %s, and ps is still called once across two lookups', (_, answer) => {
    const { calls, sh } = recording(answer);
    const lookup = ppidLookup({ proc: tmp, sh });
    expect(lookup(123)).toBeNull();
    expect(lookup(124)).toBeNull();
    expect(calls).toEqual([['ps', '-A', '-o', 'pid=,ppid=']]);
  });

  it('ignores lines that do not match and a parent of 0', () => {
    const { sh } = recording({ status: 0, stdout: 'x y\n 123 0\n 124 77\n' });
    expect(processTable({ sh })).toEqual(new Map([[124, 77]]));
  });

  it('is null from processTable when ps fails, cannot run or throws', () => {
    expect(processTable({ sh: () => ({ status: 1, stdout: '' }) })).toBeNull();
    expect(processTable({ sh: () => ({ error: new Error('ENOENT'), status: null }) })).toBeNull();
    expect(processTable({ sh: () => { throw new Error('boom'); } })).toBeNull();
  });

  it("gives this process's parent on this machine", () => {
    expect(ppidLookup()(process.pid)).toBe(process.ppid);
  });
});

describe('ppidOf', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-ppid-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const noPs = () => {
    throw new Error('ps not expected');
  };

  it("is this process's parent on this machine", () => {
    expect(ppidOf(process.pid)).toBe(process.ppid);
  });

  it('reads /proc/<pid>/stat first, after the last ")" of the command name', () => {
    fs.mkdirSync(path.join(tmp, '123'));
    fs.writeFileSync(path.join(tmp, '123', 'stat'), '123 (acme (x) y) S 77 123 123 0 -1 4194560\n');
    expect(ppidOf(123, { proc: tmp, sh: noPs })).toBe(77);
  });

  it('asks ps when /proc has no such file', () => {
    const calls = [];
    const sh = (cmd, args) => {
      calls.push([cmd, ...args]);
      return { status: 0, stdout: '  123  4242\n' };
    };
    expect(ppidOf(123, { proc: tmp, sh })).toBe(4242);
    expect(calls).toEqual([['ps', '-A', '-o', 'pid=,ppid=']]);
  });

  it.each([
    ['ps fails', { status: 1, stdout: '' }],
    ['ps cannot run', { error: new Error('spawnSync ps ENOENT'), status: null }],
    ['ps gives no number', { status: 0, stdout: 'acme\n' }],
    ['ps gives 0', { status: 0, stdout: '123 0\n' }],
    ['ps does not list the pid', { status: 0, stdout: '99 4242\n' }],
  ])('is null when %s', (_, answer) => {
    expect(ppidOf(123, { proc: tmp, sh: () => answer })).toBeNull();
  });

  it('is null when ps throws, and for a stat file it cannot read', () => {
    expect(ppidOf(123, { proc: tmp, sh: () => { throw new Error('boom'); } })).toBeNull();
    fs.mkdirSync(path.join(tmp, '124'));
    fs.writeFileSync(path.join(tmp, '124', 'stat'), '124 (acme) S\n');
    expect(ppidOf(124, { proc: tmp, sh: () => ({ status: 1, stdout: '' }) })).toBeNull();
  });

  it('is null for a process that does not exist', () => {
    expect(ppidOf(2 ** 22 + 12345)).toBeNull();
  });
});

describe('refuseOwnerControl', () => {
  let tmp;
  let anchor;
  let state;
  let plain;
  const changed = (what) =>
    `${what} does not run from a Foreman story session whose FOREMAN_RUN is changed or unset (FOREMAN_STORY or FOREMAN_SLOT is still set); the owner runs it from their own terminal or the dashboard, and a test builds an owner environment from scratch in a temporary project.`;
  const startedByRun = (what, dir, pid) =>
    `${what} would act on ${dir}, the state folder of the Foreman run (supervisor ${pid}) that started this process, so it does not run here; the owner runs it from their own terminal or the dashboard, and a test builds an owner environment from scratch in a temporary project.`;
  const noParents = () => {
    throw new Error('parents not expected');
  };
  const alive = (pid) => pid === 4242;
  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-owner-control-')));
    anchor = path.join(tmp, 'acme');
    state = path.join(anchor, '.foreman');
    plain = path.join(tmp, 'plain');
    fs.mkdirSync(state, { recursive: true });
    fs.mkdirSync(plain);
    fs.writeFileSync(path.join(anchor, 'foreman.config.json'), '{"version":1,"project":{"name":"Acme"}}\n');
    fs.writeFileSync(path.join(state, 'supervisor.pid'), '4242\n');
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const location = () => ({ FOREMAN_PROJECT_DIR: anchor, FOREMAN_STATE_DIR: state });

  it('refuses a session whose FOREMAN_RUN is unset but whose FOREMAN_STORY is set, wherever it stands', () => {
    for (const env of [{ FOREMAN_STORY: 'S-1' }, { FOREMAN_STORY: 'S-1', ...location() }, { FOREMAN_SLOT: 'w1', FOREMAN_RUN: '0' }, { FOREMAN_SLOT: 'w1', FOREMAN_RUN: '' }]) {
      expect(refuseOwnerControl({ env, cwd: plain, name: 'stop', args: [], alive: () => false, parents: noParents })).toBe(changed('foreman stop'));
    }
  });

  // The FM-261 probe: an unquoted zsh string left FOREMAN_RUN holding the rest of the line.
  it('refuses a session whose FOREMAN_RUN holds an unsplit string, with and without FOREMAN_STORY', () => {
    for (const env of [{ FOREMAN_RUN: '1 FOREMAN_PROJECT_DIR=/tmp/acme' }, { FOREMAN_RUN: '1 FOREMAN_PROJECT_DIR=/tmp/acme', FOREMAN_STORY: 'S-1', ...location() }]) {
      expect(refuseOwnerControl({ env, cwd: plain, name: 'stop', args: [], alive: () => false, parents: noParents })).toBe(changed('foreman stop'));
    }
  });

  it('is null with FOREMAN_RUN=1: the session guard in main decides', () => {
    const env = { FOREMAN_RUN: '1', FOREMAN_STORY: 'S-1', FOREMAN_SLOT: 'w1', ...location() };
    expect(refuseOwnerControl({ env, cwd: plain, name: 'stop', args: [], alive, parents: () => [4242] })).toBeNull();
  });

  it('is null for a command that is not an owner control, even in a changed session', () => {
    const env = { FOREMAN_STORY: 'S-1', ...location() };
    for (const [name, ...args] of [['settings', 'get', 'workers'], ['decide', 'add', '--title', 'Acme'], ['status'], ['service', 'status']]) {
      expect(refuseOwnerControl({ env, cwd: plain, name, args, alive, parents: () => [4242] }), name).toBeNull();
    }
  });

  it('is null when no supervisor is alive, without reading the parents', () => {
    expect(refuseOwnerControl({ env: location(), cwd: plain, name: 'stop', args: [], alive: () => false, parents: noParents })).toBeNull();
    fs.rmSync(path.join(state, 'supervisor.pid'));
    expect(refuseOwnerControl({ env: location(), cwd: plain, name: 'stop', args: [], alive, parents: noParents })).toBeNull();
  });

  it('refuses when the live supervisor started this process', () => {
    expect(refuseOwnerControl({ env: location(), cwd: plain, name: 'stop', args: [], alive, parents: () => [9, 4242, 1] })).toBe(startedByRun('foreman stop', state, 4242));
    expect(refuseOwnerControl({ env: location(), cwd: plain, name: 'settings', args: ['set', 'workers', '1'], alive, parents: () => [4242] })).toBe(
      startedByRun('foreman settings set', state, 4242),
    );
  });

  it("finds the state folder through FOREMAN_PROJECT_DIR's config when FOREMAN_STATE_DIR is not set", () => {
    fs.writeFileSync(path.join(anchor, 'foreman.config.json'), '{"version":1,"project":{"name":"Acme"},"stateDir":"run-state"}\n');
    const runState = path.join(anchor, 'run-state');
    fs.mkdirSync(runState);
    fs.writeFileSync(path.join(runState, 'supervisor.pid'), '4242\n');
    fs.rmSync(path.join(state, 'supervisor.pid'));
    expect(refuseOwnerControl({ env: { FOREMAN_PROJECT_DIR: anchor }, cwd: plain, name: 'pause', args: [], alive, parents: () => [4242] })).toBe(
      startedByRun('foreman pause', runState, 4242),
    );
  });

  it('finds the state folder from the folder it runs in when no location variable is set', () => {
    expect(refuseOwnerControl({ env: {}, cwd: anchor, name: 'stop', args: [], alive, parents: () => [4242] })).toBe(startedByRun('foreman stop', state, 4242));
    expect(refuseOwnerControl({ env: {}, cwd: plain, name: 'stop', args: [], alive, parents: noParents })).toBeNull();
  });

  it('is null when the live supervisor is not among the parents (the owner\'s terminal)', () => {
    expect(refuseOwnerControl({ env: location(), cwd: plain, name: 'stop', args: [], alive, parents: () => [9, 1] })).toBeNull();
    expect(refuseOwnerControl({ env: {}, cwd: anchor, name: 'stop', args: [], alive, parents: () => [] })).toBeNull();
  });

  it('refuses when the parents cannot be read and a location variable is set, and lets it through without one', () => {
    expect(refuseOwnerControl({ env: { FOREMAN_STATE_DIR: state }, cwd: plain, name: 'stop', args: [], alive, parents: () => null })).toBe(
      startedByRun('foreman stop', state, 4242),
    );
    expect(refuseOwnerControl({ env: { FOREMAN_PROJECT_DIR: anchor }, cwd: plain, name: 'stop', args: [], alive, parents: () => null })).toBe(
      startedByRun('foreman stop', state, 4242),
    );
    expect(refuseOwnerControl({ env: {}, cwd: anchor, name: 'stop', args: [], alive, parents: () => null })).toBeNull();
  });

  it('a chain that breaks partway up counts as unreadable', () => {
    const parents = () => parentChain({ start: 9, lookup: (p) => (p === 9 ? 7 : null) });
    expect(refuseOwnerControl({ env: { FOREMAN_STATE_DIR: state }, cwd: plain, name: 'stop', args: [], alive, parents })).toBe(startedByRun('foreman stop', state, 4242));
    expect(refuseOwnerControl({ env: {}, cwd: anchor, name: 'stop', args: [], alive, parents })).toBeNull();
  });

  // After a restart on new code, a session the old supervisor started is no longer under the new
  // one; supervisor-adopted.json lists its pid while its voucher lives.
  describe("a session adopted from the run's earlier supervisor", () => {
    const adopt = (by, pids) => fs.writeFileSync(path.join(state, 'supervisor-adopted.json'), `${JSON.stringify({ by, pids })}\n`);

    it('refuses when an adopted pid is among the parents and its voucher lives', () => {
      adopt(process.pid, [5151]);
      expect(refuseOwnerControl({ env: {}, cwd: anchor, name: 'stop', args: [], alive, parents: () => [9, 5151, 1] })).toBe(startedByRun('foreman stop', state, 4242));
    });

    it('is null when the voucher is dead', () => {
      adopt(2 ** 22 + 12345, [5151]);
      expect(refuseOwnerControl({ env: {}, cwd: anchor, name: 'stop', args: [], alive, parents: () => [9, 5151, 1] })).toBeNull();
    });

    it('ignores the adopted file when no supervisor is alive', () => {
      adopt(process.pid, [5151]);
      expect(refuseOwnerControl({ env: {}, cwd: anchor, name: 'stop', args: [], alive: () => false, parents: noParents })).toBeNull();
    });
  });
});

describe('refuseAnchorWrite', () => {
  let tmp;
  const gitEnv = () => ({ PATH: process.env.PATH, HOME: tmp, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Acme', GIT_AUTHOR_EMAIL: 'acme@example.com', GIT_COMMITTER_NAME: 'Acme', GIT_COMMITTER_EMAIL: 'acme@example.com' });
  const git = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
  };
  const repo = (name) => {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q');
    fs.writeFileSync(path.join(dir, 'foreman.config.json'), '{"version":1,"project":{"name":"Acme"}}\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'Acme');
    return dir;
  };
  const what = 'foreman settings set';
  const anchorMessage = (anchor) =>
    `foreman settings set would change ${anchor}, the project this Foreman run builds, so it does not run inside a story session (FOREMAN_RUN=1); run it in a scratch git repo instead.`;

  let anchor;
  let env;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-run-guard-'));
    anchor = repo('acme');
    env = { FOREMAN_RUN: '1', FOREMAN_PROJECT_DIR: anchor };
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('is null outside a run', () => {
    expect(refuseAnchorWrite({}, anchor, what)).toBeNull();
    expect(refuseAnchorWrite({ FOREMAN_RUN: '0', FOREMAN_PROJECT_DIR: anchor }, anchor, what)).toBeNull();
    expect(refuseAnchorWrite(undefined, anchor, what)).toBeNull();
  });

  it('refuses the anchor itself', () => {
    expect(refuseAnchorWrite(env, anchor, what)).toBe(anchorMessage(anchor));
  });

  it('refuses a symlink to the anchor', () => {
    const link = path.join(tmp, 'acme-link');
    fs.symlinkSync(anchor, link);
    expect(refuseAnchorWrite(env, link, what)).toBe(anchorMessage(anchor));
  });

  it('refuses a folder inside the anchor', () => {
    const sub = path.join(anchor, 'src', 'app');
    fs.mkdirSync(sub, { recursive: true });
    expect(refuseAnchorWrite(env, sub, what)).toBe(anchorMessage(anchor));
  });

  it('refuses a slot worktree of the anchor inside it', () => {
    const slot = path.join(anchor, '.foreman', 'worktrees', 'w1');
    git(anchor, 'worktree', 'add', '-q', '--detach', slot);
    expect(refuseAnchorWrite(env, slot, what)).toBe(anchorMessage(anchor));
  });

  it('refuses a worktree of the anchor made outside it', () => {
    const outside = path.join(tmp, 'acme-w2');
    git(anchor, 'worktree', 'add', '-q', '--detach', outside);
    expect(isAnchorTarget(outside, anchor)).toBe(true);
    expect(refuseAnchorWrite(env, outside, what)).toBe(anchorMessage(anchor));
  });

  it('lets an unrelated scratch repo through', () => {
    const scratch = repo('scratch');
    expect(isAnchorTarget(scratch, anchor)).toBe(false);
    expect(refuseAnchorWrite(env, scratch, what)).toBeNull();
  });

  it('refuses when the run does not say which project it builds', () => {
    const scratch = repo('scratch');
    const message = `${what} cannot tell which project this Foreman run builds (FOREMAN_PROJECT_DIR is not set), so it does not run inside a story session (FOREMAN_RUN=1); run it in a scratch git repo instead.`;
    expect(refuseAnchorWrite({ FOREMAN_RUN: '1' }, scratch, what)).toBe(message);
    expect(refuseAnchorWrite({ FOREMAN_RUN: '1', FOREMAN_PROJECT_DIR: '' }, scratch, what)).toBe(message);
  });

  it('canonicalPath resolves symlinks, and a missing file through its folder', () => {
    const real = fs.realpathSync(anchor);
    const link = path.join(tmp, 'acme-link');
    fs.symlinkSync(anchor, link);
    expect(canonicalPath(link)).toBe(real);
    expect(canonicalPath(path.join(link, 'missing.json'))).toBe(path.join(real, 'missing.json'));
    expect(canonicalPath(path.join(tmp, 'no', 'such', 'file'))).toBe(path.resolve(tmp, 'no', 'such', 'file'));
  });
});

// Where a command run from a story session stands: in the run's project, in another git repo, in
// no repo at all, or somewhere git cannot say. The fake git answers by folder.
describe('sessionPlace', () => {
  let tmp;
  let anchor;
  let slot;
  let scratch;
  let plain;
  let odd;
  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-place-')));
    [anchor, slot, scratch, plain, odd] = ['acme', 'acme-w1', 'scratch', 'plain', 'odd'].map((name) => {
      const dir = path.join(tmp, name);
      fs.mkdirSync(dir);
      return dir;
    });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const answers = () => ({
    [anchor]: { status: 0, stdout: `${path.join(tmp, 'acme', '.git')}\n`, stderr: '' },
    [slot]: { status: 0, stdout: `${path.join(tmp, 'acme', '.git')}\n`, stderr: '' },
    [scratch]: { status: 0, stdout: `${path.join(tmp, 'scratch', '.git')}\n`, stderr: '' },
    [plain]: { status: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git\n' },
    [odd]: { status: 128, stdout: '', stderr: "fatal: detected dubious ownership in repository at '/tmp/odd'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory /tmp/odd\n" },
  });
  const fakeSh = (cmd, args, { cwd }) => {
    expect(cmd).toBe('git');
    expect(args).toEqual(['rev-parse', '--path-format=absolute', '--git-common-dir']);
    return answers()[cwd] ?? { status: 128, stdout: '', stderr: 'fatal: not a git repository' };
  };
  const env = () => ({ FOREMAN_RUN: '1', FOREMAN_PROJECT_DIR: anchor });

  it('is the run from the anchor and from a worktree of it', () => {
    expect(sessionPlace(anchor, env(), { sh: fakeSh })).toEqual({ kind: 'run' });
    expect(sessionPlace(slot, env(), { sh: fakeSh })).toEqual({ kind: 'run' });
  });

  it('is a scratch repo, rooted at its common dir\'s folder, for another git repo', () => {
    expect(sessionPlace(scratch, env(), { sh: fakeSh })).toEqual({ kind: 'scratch', root: scratch });
  });

  it('is plain outside any git repo', () => {
    expect(sessionPlace(plain, env(), { sh: fakeSh })).toEqual({ kind: 'plain', root: plain });
  });

  it('is unknown when git cannot run', () => {
    const place = sessionPlace(plain, env(), { sh: () => ({ error: new Error('spawnSync git ENOENT'), status: null }) });
    expect(place.kind).toBe('unknown');
    expect(place.reason).toContain('ENOENT');
  });

  it('is unknown when git fails for another reason, with its last line', () => {
    const place = sessionPlace(odd, env(), { sh: fakeSh });
    expect(place.kind).toBe('unknown');
    expect(place.reason).toBe('git config --global --add safe.directory /tmp/odd');
  });

  it('is unknown for a folder that does not exist, without asking git', () => {
    const missing = path.join(tmp, 'gone');
    let asked = false;
    const place = sessionPlace(missing, env(), { sh: () => { asked = true; return { status: 0, stdout: '/x/.git\n' }; } });
    expect(place).toEqual({ kind: 'unknown', reason: `the folder ${missing} does not exist` });
    expect(asked).toBe(false);
  });

  it('is unknown for a file rather than a folder', () => {
    const file = path.join(tmp, 'file.txt');
    fs.writeFileSync(file, 'Acme');
    expect(sessionPlace(file, env(), { sh: fakeSh })).toEqual({ kind: 'unknown', reason: `the folder ${file} does not exist` });
  });

  it('is the run in any git repo when the run does not say which project it builds', () => {
    expect(sessionPlace(scratch, { FOREMAN_RUN: '1' }, { sh: fakeSh })).toEqual({ kind: 'run' });
    expect(sessionPlace(plain, { FOREMAN_RUN: '1' }, { sh: fakeSh })).toEqual({ kind: 'plain', root: plain });
  });

  it('unknownPlace names the command, the folder and the reason', () => {
    expect(unknownPlace('foreman stop', '/tmp/gone', 'the folder /tmp/gone does not exist')).toBe(
      'foreman stop cannot tell which project /tmp/gone belongs to (the folder /tmp/gone does not exist), so it does not run inside a story session (FOREMAN_RUN=1); run it in a scratch git repo or a plain temporary folder.',
    );
  });
});

// A project a session re-roots onto must not keep its state in the run's own state folder.
describe('refuseRunState', () => {
  let tmp;
  let anchor;
  let other;
  const config = (dir, extra = {}) => fs.writeFileSync(path.join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'Acme' }, ...extra }));
  const message = (state) => `foreman stop would act on ${state}, the state folder of the run this session belongs to, so it does not run inside a story session (FOREMAN_RUN=1).`;
  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-run-state-')));
    anchor = path.join(tmp, 'acme');
    other = path.join(tmp, 'elsewhere', 'plain-acme');
    fs.mkdirSync(path.join(anchor, '.foreman'), { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    config(anchor);
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const env = () => ({ FOREMAN_RUN: '1', FOREMAN_PROJECT_DIR: anchor, FOREMAN_STATE_DIR: path.join(anchor, '.foreman') });

  it('is null for a temp project with its own state folder', () => {
    config(other);
    expect(refuseRunState(env(), other, 'foreman stop')).toBeNull();
    fs.rmSync(path.join(other, 'foreman.config.json'));
    expect(refuseRunState(env(), other, 'foreman stop')).toBeNull();
  });

  it('refuses a target whose state folder is FOREMAN_STATE_DIR', () => {
    const state = path.join(tmp, 'run-state');
    fs.mkdirSync(state);
    config(other, { stateDir: path.relative(other, state) });
    expect(refuseRunState({ ...env(), FOREMAN_STATE_DIR: state }, other, 'foreman stop')).toBe(message(state));
  });

  it("refuses a target whose relative stateDir reaches the anchor's .foreman", () => {
    config(other, { stateDir: path.relative(other, path.join(anchor, '.foreman')) });
    expect(refuseRunState(env(), other, 'foreman stop')).toBe(message(path.join(anchor, '.foreman')));
    const noStateEnv = env();
    delete noStateEnv.FOREMAN_STATE_DIR;
    expect(refuseRunState(noStateEnv, other, 'foreman stop')).toBe(message(path.join(anchor, '.foreman')));
  });

  it('refuses through a symlink to the run state folder', () => {
    const link = path.join(tmp, 'state-link');
    fs.symlinkSync(path.join(anchor, '.foreman'), link);
    config(other, { stateDir: path.relative(other, link) });
    expect(refuseRunState(env(), other, 'foreman stop')).toBe(message(path.join(anchor, '.foreman')));
  });

  it('reads an invalid config without throwing, and still checks its stateDir', () => {
    fs.writeFileSync(path.join(other, 'foreman.config.json'), '{not json');
    expect(refuseRunState(env(), other, 'foreman stop')).toBeNull();
    fs.writeFileSync(path.join(other, 'foreman.config.json'), JSON.stringify({ version: 'nope', stateDir: path.relative(other, path.join(anchor, '.foreman')) }));
    expect(refuseRunState(env(), other, 'foreman stop')).toBe(message(path.join(anchor, '.foreman')));
  });

  it('refuses the anchor itself', () => {
    expect(refuseRunState(env(), anchor, 'foreman stop')).toBe(message(path.join(anchor, '.foreman')));
  });
});
