import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alive, endGroup, endProcess, IDLE_ENV, IDLE_EXIT_MS, idleReason, LEASH_ENV, leashOf, leashVerdict, parentGoneReason, tempRoots, underTemp } from './leash.mjs';

let base;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'foreman-leash-'));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('tempRoots and underTemp', () => {
  it('canonicalises a symlinked temp folder and always includes /tmp', () => {
    const real = join(base, 'real');
    mkdirSync(real);
    const link = join(base, 'link');
    symlinkSync(real, link);
    const roots = tempRoots({ tmpdir: link });
    expect(roots).toContain(realpathSync(real));
    expect(roots).not.toContain(link);
    expect(roots).toContain(realpathSync('/tmp'));
    expect(new Set(roots).size).toBe(roots.length);
  });

  it('is true for a root and anything inside it, never for a sibling with the same prefix', () => {
    const roots = tempRoots({ tmpdir: base });
    const tmp = realpathSync('/tmp');
    expect(underTemp('/tmp', roots)).toBe(true);
    expect(underTemp(join(tmp, 'acme', 'state'), roots)).toBe(true);
    expect(underTemp(`${tmp}x`, roots)).toBe(false);
    expect(underTemp('/tmpx/acme', roots)).toBe(false);
    expect(underTemp(join(base, 'acme'), roots)).toBe(true);
    expect(underTemp('/srv/acme', roots)).toBe(false);
  });
});

describe('leashOf', () => {
  const roots = () => tempRoots({ tmpdir: base });

  it('gives a real run (state outside temp, no leash) neither a parent nor an idle limit', () => {
    expect(leashOf({ dir: '/srv/acme/.foreman', env: {}, roots: roots() })).toEqual({ parent: null, idleMs: null });
  });

  it('gives a state folder under temp the idle limit only', () => {
    expect(leashOf({ dir: join(base, 'acme', '.foreman'), env: {}, roots: roots() })).toEqual({ parent: null, idleMs: IDLE_EXIT_MS });
    expect(IDLE_EXIT_MS).toBe(300_000);
  });

  it('takes the leash pid, with the idle limit, wherever the state folder is', () => {
    expect(leashOf({ dir: '/srv/acme/.foreman', env: { [LEASH_ENV]: '4242' }, roots: roots() })).toEqual({ parent: 4242, idleMs: 300_000 });
  });

  it('ignores a leash that is not a pid above 1', () => {
    for (const v of ['0', '1', '-3', 'abc', '']) {
      expect(leashOf({ dir: '/srv/acme/.foreman', env: { [LEASH_ENV]: v }, roots: roots() }).parent, v).toBeNull();
    }
  });

  it('reads the idle limit only for a leashed run, falling back on a bad value', () => {
    const env = (idle) => ({ [LEASH_ENV]: '4242', [IDLE_ENV]: idle });
    expect(leashOf({ dir: '/srv/acme/.foreman', env: env('1500'), roots: roots() }).idleMs).toBe(1500);
    for (const v of ['abc', '0', '-5']) expect(leashOf({ dir: '/srv/acme/.foreman', env: env(v), roots: roots() }).idleMs, v).toBe(300_000);
    expect(leashOf({ dir: join(base, 'acme'), env: { [IDLE_ENV]: '1500' }, roots: roots() }).idleMs).toBe(1500);
    expect(leashOf({ dir: '/srv/acme/.foreman', env: { [IDLE_ENV]: '1500' }, roots: roots() })).toEqual({ parent: null, idleMs: null });
  });
});

describe('leashVerdict', () => {
  const leash = { parent: 4242, idleMs: 1000 };
  it('says the parent is gone first, even when the idle limit is reached too', () => {
    expect(leashVerdict({ leash, alive: () => false, standbySince: 0, now: 5000 })).toEqual({ reason: parentGoneReason(4242) });
    expect(parentGoneReason(4242)).toBe('Stopped: the process that started this run (pid 4242) has ended.');
  });

  it('says nothing while the parent lives and the run is not on standby', () => {
    expect(leashVerdict({ leash, alive: () => true, standbySince: null, now: 5000 })).toBeNull();
  });

  it('stops at the idle limit on standby, not one ms before', () => {
    expect(leashVerdict({ leash, alive: () => true, standbySince: 1000, now: 2000 })).toEqual({ reason: idleReason(1000) });
    expect(leashVerdict({ leash, alive: () => true, standbySince: 1000, now: 1999 })).toBeNull();
    expect(idleReason(300_000)).toBe('Stopped: on standby for 5 min, and this run belongs to a test or a scratch copy.');
    expect(idleReason(1500)).toMatch(/^Stopped: on standby for 1 min,/);
  });

  it('never stops a run with no leash', () => {
    const none = { parent: null, idleMs: null };
    expect(leashVerdict({ leash: none, alive: () => false, standbySince: 0, now: 10 ** 12 })).toBeNull();
  });
});

describe('alive', () => {
  it('is true for this process and false for one that ended', async () => {
    expect(alive(process.pid)).toBe(true);
    const { spawnSync } = await import('node:child_process');
    expect(alive(spawnSync('true').pid)).toBe(false);
  });
});

// A fake kill: a target lives until `dies` says so; every call is recorded.
function fakeKill({ dies = () => false } = {}) {
  const calls = [];
  let gone = false;
  const kill = (target, signal) => {
    calls.push([target, signal]);
    if (signal !== 0 && dies(signal)) gone = true;
    if (gone) {
      const err = new Error('no such process');
      err.code = 'ESRCH';
      throw err;
    }
    return true;
  };
  kill.calls = calls;
  return kill;
}
const sleep = async () => {};

describe('endGroup', () => {
  it('sends SIGTERM to the group and stops there when the group ends', async () => {
    const kill = fakeKill({ dies: (s) => s === 'SIGTERM' });
    expect(await endGroup(4242, { kill, sleep })).toBe('gone');
    expect(kill.calls[0]).toEqual([-4242, 'SIGTERM']);
    expect(kill.calls.some(([, s]) => s === 'SIGKILL')).toBe(false);
  });

  it('sends SIGKILL to a group still there after waitMs', async () => {
    const kill = fakeKill({ dies: (s) => s === 'SIGKILL' });
    expect(await endGroup(4242, { kill, sleep, waitMs: 300 })).toBe('killed');
    expect(kill.calls.filter(([, s]) => s === 'SIGTERM')).toEqual([[-4242, 'SIGTERM']]);
    expect(kill.calls.filter(([, s]) => s === 'SIGKILL')).toEqual([[-4242, 'SIGKILL']]);
    expect(kill.calls.every(([t]) => t === -4242)).toBe(true);
  });

  it('says left when not even SIGKILL ends it', async () => {
    const kill = fakeKill();
    expect(await endGroup(4242, { kill, sleep, waitMs: 200, killWaitMs: 200 })).toBe('left');
  });

  it('never signals a group id that is not a pid above 1', async () => {
    for (const pgid of [0, 1, -5, NaN, undefined, '42']) {
      const kill = fakeKill();
      await endGroup(pgid, { kill, sleep });
      expect(kill.calls, String(pgid)).toEqual([]);
    }
  });

  it('never throws, whatever kill does', async () => {
    const kill = () => {
      throw new Error('boom');
    };
    await expect(endGroup(4242, { kill, sleep, waitMs: 100, killWaitMs: 100 })).resolves.toBeTypeOf('string');
  });
});

describe('endProcess', () => {
  it('signals the pid itself, not a group', async () => {
    const kill = fakeKill({ dies: (s) => s === 'SIGTERM' });
    expect(await endProcess(4242, { kill, sleep })).toBe('gone');
    expect(kill.calls[0]).toEqual([4242, 'SIGTERM']);
  });

  it('kills a survivor after waitMs', async () => {
    const kill = fakeKill({ dies: (s) => s === 'SIGKILL' });
    expect(await endProcess(4242, { kill, sleep, waitMs: 200 })).toBe('killed');
  });

  it('never signals this process, or a pid of 1 or less', async () => {
    for (const pid of [process.pid, 1, 0, -3]) {
      const kill = fakeKill();
      await endProcess(pid, { kill, sleep });
      expect(kill.calls, String(pid)).toEqual([]);
    }
  });
});
