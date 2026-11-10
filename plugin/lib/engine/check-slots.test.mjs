import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJob, readResult, writeJob, writeResult } from './check-jobs.mjs';
import {
  CHECK_RUNNING_DIR, CHECK_SLOTS_DIR, checkSlotLimit, checkWaits, enterRun, killTree, leaveRun, liveRuns, olderInWorktree,
  jobWorkerAlive, processStart, processTree, queuedFor, releaseSeatsOf, releaseSlot, runAlive, setRun, stopRun, takeSlot, takeStopNote,
} from './check-slots.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foreman-check-slots-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const runningDir = () => join(dir, CHECK_RUNNING_DIR);
const slotsDir = () => join(dir, CHECK_SLOTS_DIR);
const names = (d) => (existsSync(d) ? readdirSync(d).filter((f) => !f.endsWith('.tmp')).sort() : []);
const fields = (extra = {}) => ({ pid: 4242, script: '/p/main.mjs', job: null, slot: 'w1', story: 'ACME-1', tree: 'aaa', at: '2026-11-01T10:00:00.000Z', state: 'started', since: '2026-11-01T10:00:00.000Z', ...extra });

describe('checkSlotLimit', () => {
  it('is one run per 8 cores, at least 1, when unset', () => {
    expect(checkSlotLimit({}, 18)).toBe(2);
    expect(checkSlotLimit({}, 4)).toBe(1);
    expect(checkSlotLimit(null, 64)).toBe(8);
    expect(checkSlotLimit(undefined, 1)).toBe(1);
  });
  it('takes checkRuns.maxParallel when it is a whole number of at least 1', () => {
    expect(checkSlotLimit({ checkRuns: { maxParallel: 3 } }, 64)).toBe(3);
    expect(checkSlotLimit({ checkRuns: { maxParallel: 1 } }, 64)).toBe(1);
  });
  it.each([[0], ['x'], [1.5], [-2], [null]])('falls back to the default for %j', (bad) => {
    expect(checkSlotLimit({ checkRuns: { maxParallel: bad } }, 18)).toBe(2);
  });
});

describe('the live-run register', () => {
  it('enterRun writes a file named by a 16-hex token, setRun changes it, leaveRun removes it', () => {
    const { entry } = enterRun(dir, fields());
    expect(entry.token).toMatch(/^[0-9a-f]{16}$/);
    expect(names(runningDir())).toEqual([`${entry.token}.json`]);
    expect(JSON.parse(readFileSync(join(runningDir(), `${entry.token}.json`), 'utf8'))).toEqual(entry);
    expect(entry).toMatchObject({ pid: 4242, slot: 'w1', state: 'started', tree: 'aaa' });
    const next = setRun(dir, entry, { state: 'queued', since: '2026-11-01T10:01:00.000Z' });
    expect(next).toMatchObject({ token: entry.token, state: 'queued', since: '2026-11-01T10:01:00.000Z', tree: 'aaa' });
    expect(JSON.parse(readFileSync(join(runningDir(), `${entry.token}.json`), 'utf8')).state).toBe('queued');
    leaveRun(dir, next);
    expect(names(runningDir())).toEqual([]);
  });

  it('setRun and leaveRun leave a file that holds another token as it is', () => {
    const { entry } = enterRun(dir, fields());
    const file = join(runningDir(), `${entry.token}.json`);
    const before = readFileSync(file, 'utf8');
    const other = { ...entry, token: 'ffffffffffffffff' };
    setRun(dir, other, { state: 'running' });
    leaveRun(dir, other);
    writeFileSync(file, before.replace(entry.token, 'eeeeeeeeeeeeeeee'));
    const mine = readFileSync(file, 'utf8');
    setRun(dir, entry, { state: 'running' });
    leaveRun(dir, entry);
    expect(readFileSync(file, 'utf8')).toBe(mine);
    expect(readFileSync(file, 'utf8')).not.toContain('"running"');
  });

  it('enterRun answers an error when a file sits where the folder goes', () => {
    writeFileSync(runningDir(), 'not a folder');
    expect(enterRun(dir, fields())).toEqual({ error: expect.any(String) });
  });

  it('liveRuns removes the file of an entry alive calls dead, and leaves unreadable files out', () => {
    const a = enterRun(dir, fields({ pid: 1111 })).entry;
    const b = enterRun(dir, fields({ pid: 2222 })).entry;
    writeFileSync(join(runningDir(), 'junk.json'), '{nope');
    const live = liveRuns(dir, { alive: (e) => e.pid === 2222 });
    expect(live.map((e) => e.token)).toEqual([b.token]);
    expect(names(runningDir())).toEqual(['junk.json', `${b.token}.json`].sort());
    expect(existsSync(join(runningDir(), `${a.token}.json`))).toBe(false);
  });

  it('liveRuns with alive false removes the register file and its stop note', () => {
    const a = enterRun(dir, fields({ pid: 1111 })).entry;
    writeFileSync(join(runningDir(), `${a.token}.stopped`), '{}');
    expect(liveRuns(dir, { alive: () => false })).toEqual([]);
    expect(names(runningDir())).toEqual([]);
  });

  it('liveRuns with the default alive drops an entry whose job is not a job id, and deletes its file', () => {
    const bad = enterRun(dir, fields({ pid: process.pid, job: '../x', started: processStart(process.pid) })).entry;
    const empty = enterRun(dir, fields({ pid: process.pid, job: '', started: processStart(process.pid) })).entry;
    expect(liveRuns(dir)).toEqual([]);
    expect(existsSync(join(runningDir(), `${bad.token}.json`))).toBe(false);
    expect(existsSync(join(runningDir(), `${empty.token}.json`))).toBe(false);
  });

  it('leaveRun removes the entry\'s stop note as well', () => {
    const { entry } = enterRun(dir, fields());
    writeFileSync(join(runningDir(), `${entry.token}.stopped`), '{}');
    leaveRun(dir, entry);
    expect(names(runningDir())).toEqual([]);
  });

  it('takeStopNote returns the note and removes the file, and gives null when there is none', () => {
    const { entry } = enterRun(dir, fields());
    expect(takeStopNote(dir, entry.token)).toBeNull();
    writeFileSync(join(runningDir(), `${entry.token}.stopped`), JSON.stringify({ supersededBy: 'w1-new', at: 'x' }));
    expect(takeStopNote(dir, entry.token)).toEqual({ supersededBy: 'w1-new', at: 'x' });
    expect(names(runningDir())).toEqual([`${entry.token}.json`]);
    expect(takeStopNote(dir, entry.token)).toBeNull();
    expect(takeStopNote(dir, '../../etc')).toBeNull();
    expect(takeStopNote(dir, 'nothex')).toBeNull();
    expect(takeStopNote(join(dir, 'nope'), entry.token)).toBeNull();
  });

  it('liveRuns of a folder that is not there is empty', () => {
    expect(liveRuns(join(dir, 'nope'))).toEqual([]);
  });
});

describe('olderInWorktree', () => {
  const me = { token: 'bbbb', pid: process.pid, slot: 'w1', tree: 'bbb', at: '2026-11-01T10:05:00.000Z' };
  const e = (extra = {}) => ({ token: 'aaaa', pid: 4242, slot: 'w1', tree: 'aaa', at: '2026-11-01T10:00:00.000Z', ...extra });

  it('picks an older run in the same slot on another tree', () => {
    expect(olderInWorktree([e()], me)).toEqual([e()]);
  });
  it('breaks a tie on the time by token', () => {
    const same = { ...me, at: '2026-11-01T10:00:00.000Z' };
    expect(olderInWorktree([e({ token: 'aaaa' })], same)).toHaveLength(1);
    expect(olderInWorktree([e({ token: 'cccc' })], same)).toEqual([]);
  });
  it.each([
    ['the same tree', { tree: 'bbb' }],
    ['another slot', { slot: 'w2' }],
    ['a newer run', { at: '2026-11-01T10:10:00.000Z' }],
    ['this process', { pid: process.pid }],
    ['a null tree', { tree: null }],
    ['an empty tree', { tree: '' }],
    ['itself', { token: 'bbbb' }],
  ])('skips %s', (_name, extra) => {
    expect(olderInWorktree([e(extra)], me)).toEqual([]);
  });
  it('skips every run when this one has no tree or no slot', () => {
    expect(olderInWorktree([e()], { ...me, tree: null })).toEqual([]);
    expect(olderInWorktree([e({ slot: null })], { ...me, slot: null })).toEqual([]);
  });
});

describe('the machine cap', () => {
  const holder = (extra = {}) => ({ token: 'tok1', pid: 4242, script: '/p/main.mjs', slot: 'w1', story: 'ACME-1', at: '2026-11-01T10:00:00.000Z', ...extra });

  it('takes seat 0 first, then 1, writing the holder', () => {
    const a = takeSlot(dir, { max: 2, holder: holder({ token: 'a' }), alive: () => true });
    const b = takeSlot(dir, { max: 2, holder: holder({ token: 'b' }), alive: () => true });
    expect(a).toEqual({ ok: true, seat: { n: 0, token: 'a' } });
    expect(b).toEqual({ ok: true, seat: { n: 1, token: 'b' } });
    expect(names(slotsDir())).toEqual(['0.json', '1.json']);
    expect(JSON.parse(readFileSync(join(slotsDir(), '1.json'), 'utf8'))).toMatchObject({ token: 'b', slot: 'w1', story: 'ACME-1' });
  });

  it('answers busy with both holders when max seats are held by live runs', () => {
    takeSlot(dir, { max: 2, holder: holder({ token: 'a', slot: 'w2', story: 'ACME-2' }), alive: () => true });
    takeSlot(dir, { max: 2, holder: holder({ token: 'b' }), alive: () => true });
    const res = takeSlot(dir, { max: 2, holder: holder({ token: 'c' }), alive: () => true });
    expect(res.ok).toBe(false);
    expect(res.busy.map((h) => h.token).sort()).toEqual(['a', 'b']);
    expect(names(slotsDir())).toEqual(['0.json', '1.json']);
  });

  it('replaces a dead holder\'s seat', () => {
    takeSlot(dir, { max: 1, holder: holder({ token: 'dead' }), alive: () => true });
    const res = takeSlot(dir, { max: 1, holder: holder({ token: 'new' }), alive: (h) => h.token !== 'dead' });
    expect(res).toEqual({ ok: true, seat: { n: 0, token: 'new' } });
    expect(JSON.parse(readFileSync(join(slotsDir(), '0.json'), 'utf8')).token).toBe('new');
  });

  it('replaces a seat file that cannot be read', () => {
    mkdirSync(slotsDir(), { recursive: true });
    writeFileSync(join(slotsDir(), '0.json'), '{nope');
    const res = takeSlot(dir, { max: 1, holder: holder({ token: 'new' }), alive: () => true });
    expect(res).toEqual({ ok: true, seat: { n: 0, token: 'new' } });
  });

  it('never uses a seat at or above max', () => {
    mkdirSync(slotsDir(), { recursive: true });
    writeFileSync(join(slotsDir(), '0.json'), JSON.stringify(holder({ token: 'a' })));
    const res = takeSlot(dir, { max: 1, holder: holder({ token: 'b' }), alive: () => true });
    expect(res.ok).toBe(false);
    expect(names(slotsDir())).toEqual(['0.json']);
  });

  it('answers an error when a file sits where the folder goes', () => {
    writeFileSync(slotsDir(), 'not a folder');
    expect(takeSlot(dir, { max: 1, holder: holder(), alive: () => true })).toEqual({ ok: false, error: expect.any(String) });
  });

  it('releaseSlot removes the seat only when its token matches', () => {
    const { seat } = takeSlot(dir, { max: 1, holder: holder({ token: 'a' }), alive: () => true });
    releaseSlot(dir, { ...seat, token: 'other' });
    expect(names(slotsDir())).toEqual(['0.json']);
    releaseSlot(dir, seat);
    expect(names(slotsDir())).toEqual([]);
  });

  it('releaseSeatsOf removes every seat of one token and no other', () => {
    takeSlot(dir, { max: 3, holder: holder({ token: 'a' }), alive: () => true });
    takeSlot(dir, { max: 3, holder: holder({ token: 'b' }), alive: () => true });
    mkdirSync(slotsDir(), { recursive: true });
    writeFileSync(join(slotsDir(), '2.json'), JSON.stringify(holder({ token: 'a' })));
    releaseSeatsOf(dir, 'a');
    expect(names(slotsDir())).toEqual(['1.json']);
  });

  it('never throws on a missing folder', () => {
    expect(() => releaseSeatsOf(join(dir, 'nope'), 'a')).not.toThrow();
    expect(() => releaseSlot(join(dir, 'nope'), { n: 0, token: 'a' })).not.toThrow();
  });
});

describe('processTree and killTree', () => {
  const ps = ['  1     0', ' 10     1', ' 11    10', ' 12    10', ' 13    11', ' 99     1', 'junk line'].join('\n');

  it('lists the descendants deepest first, then the root', () => {
    const tree = processTree(10, ps);
    expect(tree.at(-1)).toBe(10);
    expect(tree.slice().sort()).toEqual([10, 11, 12, 13]);
    expect(tree.indexOf(13)).toBeLessThan(tree.indexOf(11));
    expect(processTree(99, ps)).toEqual([99]);
    expect(processTree(7, ps)).toEqual([7]);
  });

  it('sends SIGTERM to every pid of the tree, and only to the root when ps fails', () => {
    const sent = [];
    killTree(10, { ps: () => ps, kill: (pid, sig) => sent.push([pid, sig]) });
    expect(sent.map(([pid]) => pid).sort()).toEqual([10, 11, 12, 13]);
    expect(sent.every(([, sig]) => sig === 'SIGTERM')).toBe(true);
    const only = [];
    killTree(10, { ps: () => null, kill: (pid, sig) => only.push([pid, sig]) });
    expect(only).toEqual([[10, 'SIGTERM']]);
    const thrown = [];
    killTree(10, { ps: () => { throw new Error('no ps'); }, kill: (pid) => thrown.push(pid) });
    expect(thrown).toEqual([10]);
  });

  it('never signals this process, its parent or any process above them', () => {
    const chain = ['  1     0', ' 10     1', ' 20    10', ' 30    20', ' 31    20', ' 40    30'].join('\n');
    // we are 40, our parent is 30, above that 20 and 10
    const sent = [];
    killTree(20, { ps: () => chain, kill: (pid) => sent.push(pid), self: 40, parent: 30 });
    expect(sent).toEqual([]);
    killTree(31, { ps: () => chain, kill: (pid) => sent.push(pid), self: 40, parent: 30 });
    expect(sent).toEqual([31]);
    const kids = [];
    killTree(10, { ps: () => chain, kill: (pid) => kids.push(pid), self: 99, parent: 98 });
    expect(kids.sort((a, b) => a - b)).toEqual([10, 20, 30, 31, 40]);
    const own = [];
    killTree(40, { ps: () => null, kill: (pid) => own.push(pid), self: 40, parent: 30 });
    killTree(30, { ps: () => null, kill: (pid) => own.push(pid), self: 40, parent: 30 });
    expect(own).toEqual([]);
  });

  it('ignores a kill that throws', () => {
    expect(() => killTree(10, { ps: () => ps, kill: () => { throw new Error('ESRCH'); } })).not.toThrow();
  });
});

describe('stopRun', () => {
  const NOW = new Date('2026-11-01T10:06:00.000Z');
  const setup = (job = 'w1-old-1') => {
    const { entry } = enterRun(dir, fields({ job }));
    if (job) writeJob(dir, { id: job, pid: entry.pid, slot: 'w1', story: 'ACME-1', cwd: '/x', args: [], startedAt: entry.at });
    takeSlot(dir, { max: 2, holder: { token: entry.token, pid: entry.pid, script: entry.script, slot: 'w1', story: 'ACME-1', at: entry.at }, alive: () => true });
    return entry;
  };

  it('writes the result before it stops the tree, then drops the seats and the register file', () => {
    const e = setup();
    const calls = [];
    stopRun(dir, e, {
      supersededBy: 'w1-new', now: NOW, alive: () => true,
      stopTree: (pid) => calls.push(['tree', pid, readResult(dir, 'w1-old-1')]),
      groupKill: (pid) => calls.push(['group', pid]),
    });
    expect(calls[0][0]).toBe('tree');
    expect(calls[0][1]).toBe(4242);
    expect(calls[0][2]).toEqual({ exit: 1, endedAt: NOW.toISOString(), supersededBy: 'w1-new' });
    expect(names(runningDir())).toEqual([]);
    expect(names(slotsDir())).toEqual([]);
  });

  it('signals the job\'s process group only when the job pid is the entry\'s and the group is ours', () => {
    const e = setup();
    const calls = [];
    // the real groupOurs sees a pid that is not a check-job worker, so no group kill happens
    stopRun(dir, e, { supersededBy: 'x', now: NOW, alive: () => true, stopTree: () => {}, groupKill: (pid) => calls.push(pid) });
    expect(calls).toEqual([]);
  });

  it('never overwrites an existing result', () => {
    const e = setup();
    writeResult(dir, 'w1-old-1', { exit: 0, endedAt: 'done' });
    stopRun(dir, e, { supersededBy: 'w1-new', now: NOW, alive: () => true, stopTree: () => {}, groupKill: () => {} });
    expect(readResult(dir, 'w1-old-1')).toEqual({ exit: 0, endedAt: 'done' });
  });

  it('writes no result when the run has no job, but leaves a stop note before it stops the tree', () => {
    const e = setup(null);
    let stopped = null;
    let noteThen = null;
    stopRun(dir, e, {
      supersededBy: 'w1-new', now: NOW, alive: () => true,
      stopTree: (pid) => { stopped = pid; noteThen = JSON.parse(readFileSync(join(runningDir(), `${e.token}.stopped`), 'utf8')); },
      groupKill: () => {},
    });
    expect(stopped).toBe(4242);
    expect(noteThen).toEqual({ supersededBy: 'w1-new', at: NOW.toISOString() });
    expect(existsSync(join(dir, 'check-jobs'))).toBe(false);
    expect(names(runningDir())).toEqual([`${e.token}.json`, `${e.token}.stopped`]);
    expect(names(slotsDir())).toEqual([]);
    expect(JSON.parse(readFileSync(join(runningDir(), `${e.token}.stopped`), 'utf8'))).toEqual({ supersededBy: 'w1-new', at: NOW.toISOString() });
  });

  it('a job entry\'s stopRun writes no stop note', () => {
    const e = setup();
    stopRun(dir, e, { supersededBy: 'w1-new', now: NOW, alive: () => true, stopTree: () => {}, groupKill: () => {} });
    expect(names(runningDir())).toEqual([]);
  });

  it('a dead foreground entry gets no note and its file is removed', () => {
    const e = setup(null);
    let signalled = false;
    stopRun(dir, e, { supersededBy: 'w1-new', now: NOW, alive: () => false, stopTree: () => { signalled = true; }, groupKill: () => { signalled = true; } });
    expect(signalled).toBe(false);
    expect(names(runningDir())).toEqual([]);
    expect(names(slotsDir())).toEqual([]);
  });

  it('asks jobAlive once, before it stops the tree, and kills the group when that answer was true', () => {
    const e = setup();
    const calls = [];
    let asked = 0;
    stopRun(dir, e, {
      supersededBy: 'x', now: NOW, alive: () => { calls.push('alive'); return true; },
      // true only while the tree still stands: a question put after stopTree gets false
      jobAlive: () => { asked++; return !calls.includes('tree'); },
      stopTree: () => calls.push('tree'), groupKill: () => calls.push('group'),
    });
    expect(calls).toEqual(['alive', 'tree', 'group']);
    expect(asked).toBe(1);
  });

  it('kills no group when jobAlive answers false before the tree is stopped', () => {
    const e = setup();
    const calls = [];
    let asked = 0;
    stopRun(dir, e, {
      supersededBy: 'x', now: NOW, alive: () => { calls.push('alive'); return true; },
      jobAlive: () => { asked++; return calls.includes('tree'); },
      stopTree: () => calls.push('tree'), groupKill: () => calls.push('group'),
    });
    expect(calls).toEqual(['alive', 'tree']);
    expect(asked).toBe(1);
  });

  it.each([['../escape'], [42], [''], ['w1 old'], [{}]])('never signals, reads or writes anything for the register job %j', (bad) => {
    const { entry } = enterRun(dir, fields({ job: bad }));
    takeSlot(dir, { max: 2, holder: { token: entry.token, pid: entry.pid, script: entry.script, slot: 'w1', story: 'ACME-1', at: entry.at }, alive: () => true });
    const calls = [];
    stopRun(dir, entry, { supersededBy: 'x', now: NOW, alive: () => true, stopTree: () => calls.push('tree'), groupKill: () => calls.push('group'), jobAlive: () => true });
    expect(calls).toEqual([]);
    expect(existsSync(join(dir, 'escape.result.json'))).toBe(false);
    expect(existsSync(join(dir, 'check-jobs'))).toBe(false);
    expect(names(runningDir())).toEqual([]);
    expect(names(slotsDir())).toEqual([]);
  });

  it('with the process dead sends no signal and writes no result, but still drops the seats and the file', () => {
    const e = setup();
    let signalled = false;
    stopRun(dir, e, { supersededBy: 'w1-new', now: NOW, alive: () => false, stopTree: () => { signalled = true; }, groupKill: () => { signalled = true; } });
    expect(signalled).toBe(false);
    expect(readResult(dir, 'w1-old-1')).toBeNull();
    expect(readJob(dir, 'w1-old-1')).not.toBeNull();
    expect(names(runningDir())).toEqual([]);
    expect(names(slotsDir())).toEqual([]);
  });

  it('never throws', () => {
    expect(() => stopRun(join(dir, 'nope'), fields({ token: 'x' }), { alive: () => true, stopTree: () => { throw new Error('x'); } })).not.toThrow();
  });
});

describe('checkWaits and queuedFor', () => {
  const mine = (extra = {}) => fields({ pid: process.pid, script: process.argv[1], started: processStart(process.pid), state: 'queued', since: '2026-11-01T10:03:00.000Z', ...extra });

  it('maps a slot to the queued text for a live queued run', () => {
    enterRun(dir, mine());
    const waits = checkWaits(dir);
    expect([...waits.keys()]).toEqual(['w1']);
    expect(waits.get('w1')).toEqual({ since: '2026-11-01T10:03:00.000Z', text: 'check queued: waiting for a free check slot' });
  });

  it('gives nothing for a running entry or a dead process', () => {
    enterRun(dir, mine({ state: 'running' }));
    expect(checkWaits(dir).size).toBe(0);
    enterRun(dir, mine({ slot: 'w2', pid: 999999999 }));
    expect(checkWaits(dir).size).toBe(0);
  });

  it('leaves a dead entry\'s file on disk, and works on a missing folder', () => {
    const { entry } = enterRun(dir, mine({ slot: 'w2' }));
    checkWaits(dir, { alive: () => false });
    expect(existsSync(join(runningDir(), `${entry.token}.json`))).toBe(true);
    expect(checkWaits(join(dir, 'nope')).size).toBe(0);
  });

  it('queuedFor is true for a queued entry of that job, without checking the process', () => {
    enterRun(dir, mine({ job: 'w1-old-1', pid: 999999999 }));
    enterRun(dir, mine({ job: 'w1-run-2', state: 'running' }));
    expect(queuedFor(dir, 'w1-old-1')).toBe(true);
    expect(queuedFor(dir, 'w1-run-2')).toBe(false);
    expect(queuedFor(dir, 'other')).toBe(false);
    expect(queuedFor(join(dir, 'nope'), 'w1-old-1')).toBe(false);
  });
});

describe('who counts as the registered run', () => {
  const ps = (stdout, status = 0) => () => ({ stdout, status });
  const alive = () => true;

  it('a foreground run is the one whose start time still matches', () => {
    const e = { pid: 4242, script: '/p/plugin/bin/foreman', job: null, started: 'Sun Nov 1 10:00:00 2026' };
    expect(runAlive(e, { kill: alive, ps: ps('Sun Nov  1 10:00:00 2026\n') })).toBe(true);
    expect(runAlive(e, { kill: alive, ps: ps('Sun Nov  1 10:05:00 2026\n') })).toBe(false);
    expect(runAlive(e, { kill: alive, ps: ps('', 1) })).toBe(false);
    expect(runAlive(e, { kill: alive, ps: () => ({ error: new Error('ENOENT') }) })).toBe(false);
    expect(runAlive({ ...e, started: null }, { kill: alive, ps: ps('Sun Nov  1 10:00:00 2026\n') })).toBe(false);
    expect(runAlive(e, { kill: () => { throw Object.assign(new Error('x'), { code: 'ESRCH' }); }, ps: ps('Sun Nov  1 10:00:00 2026\n') })).toBe(false);
  });

  it('a command line that merely contains the script name does not make a run alive', () => {
    const e = { pid: 4242, script: '/p/plugin/bin/foreman', job: null, started: null };
    const supervisor = () => ({ stdout: 'node /p/plugin/bin/foreman run --foreground --plugin-dir /p/foreman\n', status: 0 });
    expect(runAlive(e, { kill: alive, ps: supervisor })).toBe(false);
  });

  it('a job run must show check-job.mjs and its exact job id', () => {
    const e = { pid: 4242, script: '/p/plugin/bin/foreman', job: 'w1-old-1', started: null };
    expect(runAlive(e, { kill: alive, ps: ps('node /p/check-job.mjs /r /s w1-old-1\n') })).toBe(true);
    expect(runAlive(e, { kill: alive, ps: ps('node /p/plugin/bin/foreman run\n') })).toBe(false);
    expect(runAlive(e, { kill: alive, ps: ps('node /p/check-job.mjs /r /s w1-other-2\n') })).toBe(false);
  });

  it('a job run is not alive when ps is missing, fails or times out', () => {
    const e = { pid: 4242, script: '/p/plugin/bin/foreman', job: 'w1-old-1', started: null };
    expect(runAlive(e, { kill: alive, ps: () => ({ error: new Error('ENOENT') }) })).toBe(false);
    expect(runAlive(e, { kill: alive, ps: () => ({ error: Object.assign(new Error('spawnSync ps ETIMEDOUT'), { code: 'ETIMEDOUT' }), status: null }) })).toBe(false);
    expect(runAlive(e, { kill: alive, ps: ps('node /p/check-job.mjs /r /s w1-old-1\n', 1) })).toBe(false);
    expect(runAlive(e, { kill: alive, ps: () => { throw new Error('boom'); } })).toBe(false);
    expect(jobWorkerAlive(4242, 'w1-old-1', { kill: alive, ps: () => ({ error: new Error('ENOENT') }) })).toBe(false);
    expect(jobWorkerAlive(4242, 'w1-old-1', { kill: alive, ps: ps('node /p/check-job.mjs /r /s w1-old-1\n') })).toBe(true);
    expect(jobWorkerAlive(4242, null, { kill: alive, ps: ps('node /p/check-job.mjs /r /s w1-old-1\n') })).toBe(false);
  });

  it('runAlive is false for a job value that is not a job id, even when ps shows it', () => {
    for (const job of ['../../x', 'w1 old', '', 42, {}]) {
      const e = { pid: 4242, script: '/p/plugin/bin/foreman', job, started: 'Sun Nov 1 10:00:00 2026' };
      expect(runAlive(e, { kill: alive, ps: ps(`node /p/check-job.mjs /r /s ${job} \n`) })).toBe(false);
    }
    for (const job of [null, undefined]) {
      const e = { pid: 4242, script: '/p/plugin/bin/foreman', job, started: 'Sun Nov 1 10:00:00 2026' };
      expect(runAlive(e, { kill: alive, ps: ps('Sun Nov  1 10:00:00 2026\n') })).toBe(true);
    }
  });

  it('jobWorkerAlive is false for an id that is not a job id', () => {
    for (const id of ['w1 old', '../x']) {
      expect(jobWorkerAlive(4242, id, { kill: alive, ps: ps(`node /p/check-job.mjs /r /s ${id} \n`) })).toBe(false);
    }
  });

  it('stopRun sends no signal for a job entry while ps fails, but still drops the seats and the file', () => {
    const { entry } = enterRun(dir, fields({ job: 'w1-old-1' }));
    writeJob(dir, { id: 'w1-old-1', pid: entry.pid, slot: 'w1', story: 'ACME-1', cwd: '/x', args: [], startedAt: entry.at });
    takeSlot(dir, { max: 1, holder: { token: entry.token, pid: entry.pid, script: entry.script, slot: 'w1', story: 'ACME-1', at: entry.at }, alive: () => true });
    const signalled = [];
    const noPs = () => ({ error: new Error('ENOENT') });
    stopRun(dir, entry, {
      supersededBy: 'w1-new', now: new Date(),
      alive: (e) => runAlive(e, { kill: () => true, ps: noPs }),
      stopTree: (p) => signalled.push(['tree', p]), groupKill: (p) => signalled.push(['group', p]),
    });
    expect(signalled).toEqual([]);
    expect(readResult(dir, 'w1-old-1')).toBeNull();
    expect(names(runningDir())).toEqual([]);
    expect(names(slotsDir())).toEqual([]);
  });

  it('stopRun kills the process group only when the strict job check confirms the worker', () => {
    const { entry } = enterRun(dir, fields({ job: 'w1-old-1' }));
    writeJob(dir, { id: 'w1-old-1', pid: entry.pid, slot: 'w1', story: 'ACME-1', cwd: '/x', args: [], startedAt: entry.at });
    const calls = [];
    const opts = { supersededBy: 'w1-new', now: new Date(), alive: () => true, stopTree: () => {}, groupKill: (p) => calls.push(p) };
    stopRun(dir, entry, { ...opts, jobAlive: () => false });
    expect(calls).toEqual([]);
    stopRun(dir, entry, { ...opts, jobAlive: (pid, id) => pid === entry.pid && id === 'w1-old-1' });
    expect(calls).toEqual([entry.pid]);
  });

  it('processStart reads the start time and gives null when ps cannot', () => {
    expect(processStart(4242, { ps: ps('Sun Nov  1 10:00:00 2026\n') })).toBe('Sun Nov 1 10:00:00 2026');
    expect(processStart(4242, { ps: ps('', 1) })).toBeNull();
    expect(processStart(0, { ps: ps('x') })).toBeNull();
    expect(typeof processStart(process.pid)).toBe('string');
  });

  it('stopRun by default signals nothing for a register pid whose command line merely contains foreman, or that is our parent', () => {
    for (const pid of [process.ppid, process.pid, 999999999]) {
      const { entry } = enterRun(dir, fields({ pid, script: process.argv[1] ?? 'foreman', job: null, started: 'Mon Jan 1 00:00:00 2020' }));
      takeSlot(dir, { max: 1, holder: { token: entry.token, pid, script: entry.script, slot: 'w1', story: 'ACME-1', at: entry.at }, alive: () => true });
      const signalled = [];
      stopRun(dir, entry, { supersededBy: 'w1-new', now: new Date(), stopTree: (p) => signalled.push(p), groupKill: (p) => signalled.push(p) });
      expect(signalled).toEqual([]);
      expect(names(runningDir())).toEqual([]);
      expect(names(slotsDir())).toEqual([]);
    }
  });

  it('a seat held by a reused pid is taken over by default', () => {
    const { entry } = enterRun(dir, fields({ pid: process.ppid, job: null, started: 'Mon Jan 1 00:00:00 2020' }));
    takeSlot(dir, { max: 1, holder: { token: entry.token, pid: process.ppid, script: process.argv[1], slot: 'w2', story: 'ACME-2', at: entry.at }, alive: () => true });
    const res = takeSlot(dir, { max: 1, holder: { token: 'newnewnewnewnew1', pid: process.pid, script: 'x', slot: 'w1', story: 'ACME-1', at: entry.at } });
    expect(res.ok).toBe(true);
  });
});
