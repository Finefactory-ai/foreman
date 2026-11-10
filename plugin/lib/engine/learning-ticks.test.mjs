import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildWaiting } from '../console/waiting.mjs';
import { learningTicks, streakRecord } from './learning-ticks.mjs';
import { childNodeText, probeNode, spawnSh } from './node-path.mjs';

const FAILED = 'The learning tick failed (exit 1); run `foreman learning tick` to see why.';

// A learningTicks over fake children: each spawn pushes a new EventEmitter into `children`, and
// each event pushes [text, kind] into `events`. `setAuto` changes what auto() returns.
function fake({ enabled = true, auto = undefined, spawnTick, explain, newLog, readLog, streak } = {}) {
  const children = [];
  const events = [];
  const logs = [];
  let value = auto;
  const ticks = learningTicks({
    spawnTick:
      spawnTick ??
      ((log) => {
        const child = new EventEmitter();
        child.pid = 4242;
        children.push(child);
        logs.push(log);
        return child;
      }),
    enabled,
    auto: () => value,
    event: (text, kind) => events.push([text, kind]),
    ...(explain ? { explain } : {}),
    ...(newLog ? { newLog } : {}),
    ...(readLog ? { readLog } : {}),
    ...(streak ? { streak } : {}),
  });
  return { ticks, children, events, logs, setAuto: (v) => { value = v; } };
}

describe('learningTicks', () => {
  it.each([[undefined], [true]])('starts one tick with learning.auto %s', (auto) => {
    const f = fake({ auto });
    f.ticks.start();
    expect(f.children).toHaveLength(1);
    expect(f.ticks.running()).toBe(true);
    expect(f.events).toEqual([]);
  });

  it('starts nothing with learning.auto off', () => {
    const f = fake({ auto: false });
    f.ticks.start();
    expect(f.children).toHaveLength(0);
    expect(f.ticks.running()).toBe(false);
  });

  it('starts nothing on a dry run or --once', () => {
    const f = fake({ enabled: false, auto: true });
    f.ticks.start();
    f.ticks.start();
    expect(f.children).toHaveLength(0);
    expect(f.ticks.running()).toBe(false);
  });

  it('records that arrive during a tick lead to exactly one more tick', () => {
    const f = fake();
    f.ticks.start();
    f.ticks.start();
    f.ticks.start();
    expect(f.children).toHaveLength(1);
    f.children[0].emit('exit', 0, null);
    expect(f.children).toHaveLength(2);
    expect(f.ticks.running()).toBe(true);
    f.children[1].emit('exit', 0, null);
    expect(f.children).toHaveLength(2);
    expect(f.ticks.running()).toBe(false);
    expect(f.events).toEqual([]);
  });

  it('drops the pending tick when learning.auto is turned off during a tick', () => {
    const f = fake({ auto: true });
    f.ticks.start();
    f.ticks.start();
    f.setAuto(false);
    f.children[0].emit('exit', 0, null);
    expect(f.children).toHaveLength(1);
    expect(f.ticks.running()).toBe(false);
  });

  it('logs one warn event for a tick that exits non-zero', () => {
    const f = fake();
    f.ticks.start();
    f.children[0].emit('exit', 1, null);
    expect(f.events).toEqual([[FAILED, 'warn']]);
    expect(f.ticks.running()).toBe(false);
  });

  it('logs nothing for a tick that exits 0', () => {
    const f = fake();
    f.ticks.start();
    f.children[0].emit('exit', 0, null);
    expect(f.events).toEqual([]);
  });

  it('names the signal for a tick that was killed', () => {
    const f = fake();
    f.ticks.start();
    f.children[0].emit('exit', null, 'SIGKILL');
    expect(f.events).toHaveLength(1);
    expect(f.events[0][1]).toBe('warn');
    expect(f.events[0][0]).toContain('killed by SIGKILL');
    expect(f.events[0][0]).toBe('The learning tick failed (killed by SIGKILL); run `foreman learning tick` to see why.');
  });

  it('a failed tick still starts the pending one', () => {
    const f = fake();
    f.ticks.start();
    f.ticks.start();
    f.children[0].emit('exit', 1, null);
    expect(f.events).toEqual([[FAILED, 'warn']]);
    expect(f.children).toHaveLength(2);
    expect(f.ticks.running()).toBe(true);
  });

  it('a spawn error is one warn event, drops the pending tick, and a later exit from that child does nothing', () => {
    const f = fake();
    f.ticks.start();
    f.ticks.start();
    f.children[0].emit('error', new Error('ENOENT'));
    expect(f.events).toEqual([['Could not start learning: ENOENT', 'warn']]);
    expect(f.ticks.running()).toBe(false);
    expect(f.children).toHaveLength(1);
    f.children[0].emit('exit', 1, null);
    expect(f.events).toHaveLength(1);
    expect(f.children).toHaveLength(1);
    expect(f.ticks.running()).toBe(false);
    // The pending tick was dropped: the next record starts one tick, and nothing follows it.
    f.ticks.start();
    f.children[1].emit('exit', 0, null);
    expect(f.children).toHaveLength(2);
    expect(f.ticks.running()).toBe(false);
  });

  it('an exit from a child that is no longer the current one does nothing', () => {
    const f = fake();
    f.ticks.start();
    f.children[0].emit('error', new Error('ENOENT'));
    f.ticks.start();
    expect(f.children).toHaveLength(2);
    f.children[0].emit('exit', 1, null);
    expect(f.ticks.running()).toBe(true);
    expect(f.events).toEqual([['Could not start learning: ENOENT', 'warn']]);
  });

  it('a spawnTick that throws is one warn event, and nothing runs', () => {
    const f = fake({
      spawnTick: () => {
        throw new Error('spawn EAGAIN');
      },
    });
    f.ticks.start();
    expect(f.events).toEqual([['Could not start learning: spawn EAGAIN', 'warn']]);
    expect(f.ticks.running()).toBe(false);
  });
});

describe('learningTicks log', () => {
  const LOG = '/x/learning-tick-1.log';
  const BASE = 'The learning tick failed (exit 1)';

  it("hands spawnTick the path newLog gives, and null when there is no newLog", () => {
    const f = fake({ newLog: () => LOG });
    f.ticks.start();
    expect(f.logs).toEqual([LOG]);
    const g = fake();
    g.ticks.start();
    expect(g.logs).toEqual([null]);
  });

  it('a newLog that throws gives spawnTick null, and the generic text', () => {
    const f = fake({ newLog: () => { throw new Error('EACCES'); }, readLog: () => { throw new Error('not called'); } });
    f.ticks.start();
    expect(f.logs).toEqual([null]);
    f.children[0].emit('exit', 1, null);
    expect(f.events).toEqual([[FAILED, 'warn']]);
  });

  it.each([
    ['quotes the end of the log', { quote: 'Error: boom', report: null }, `${BASE}; its log ${LOG} ends: "Error: boom".`],
    ['says there was no output', { quote: '', report: null }, `${BASE} with no output; its log is ${LOG}.`],
    ['says the log could not be read', null, `${BASE}; its log ${LOG} could not be read.`],
    ['adds the diagnostic report', { quote: 'Error: boom', report: '/x/report.1.json' }, `${BASE}; its log ${LOG} ends: "Error: boom". Node's diagnostic report: /x/report.1.json.`],
    ['adds the diagnostic report to no output', { quote: '', report: '/x/report.1.json' }, `${BASE} with no output; its log is ${LOG}. Node's diagnostic report: /x/report.1.json.`],
  ])('%s', (_, read, text) => {
    const f = fake({ newLog: () => LOG, readLog: () => read });
    f.ticks.start();
    f.children[0].emit('exit', 1, null);
    expect(f.events).toEqual([[text, 'warn']]);
  });

  it('treats a readLog that throws as a log that could not be read', () => {
    const f = fake({ newLog: () => LOG, readLog: () => { throw new Error('EIO'); } });
    f.ticks.start();
    f.children[0].emit('exit', 1, null);
    expect(f.events).toEqual([[`${BASE}; its log ${LOG} could not be read.`, 'warn']]);
  });

  it('names the signal of a killed tick', () => {
    const f = fake({ newLog: () => LOG, readLog: () => ({ quote: 'FATAL ERROR: Acme', report: null }) });
    f.ticks.start();
    f.children[0].emit('exit', null, 'SIGABRT');
    expect(f.events).toEqual([[`The learning tick failed (killed by SIGABRT); its log ${LOG} ends: "FATAL ERROR: Acme".`, 'warn']]);
  });

  it('gives readLog the log and the pid the child had', () => {
    const calls = [];
    const f = fake({ newLog: () => LOG, readLog: (...args) => (calls.push(args), null) });
    f.ticks.start();
    f.children[0].emit('exit', 1, null);
    expect(calls).toEqual([[LOG, 4242]]);
  });

  it("still logs explain's text, and does not read the log", () => {
    let reads = 0;
    const f = fake({ newLog: () => LOG, explain: () => 'Node is broken on this computer.', readLog: () => (reads++, null) });
    f.ticks.start();
    f.children[0].emit('exit', 134, null);
    expect(f.events).toEqual([['Node is broken on this computer.', 'warn']]);
    expect(reads).toBe(0);
  });

  it('logs no event for a tick that exits 0, and does not read its log', () => {
    let reads = 0;
    const f = fake({ newLog: () => LOG, readLog: () => (reads++, null) });
    f.ticks.start();
    f.children[0].emit('exit', 0, null);
    expect(f.events).toEqual([]);
    expect(reads).toBe(0);
  });
});

describe('learningTicks streak', () => {
  const LOG = '/x/learning-tick-1.log';

  it('counts failed exits in a row, with the text just logged, and starts again after a pass', () => {
    const calls = [];
    const f = fake({ newLog: () => LOG, readLog: () => ({ quote: 'Error: boom', report: null }), streak: (n, last) => calls.push([n, last]) });
    const text = `The learning tick failed (exit 1); its log ${LOG} ends: "Error: boom".`;
    for (let i = 0; i < 3; i++) {
      f.ticks.start();
      f.children[i].emit('exit', 1, null);
    }
    expect(calls).toEqual([[1, { text, log: LOG }], [2, { text, log: LOG }], [3, { text, log: LOG }]]);
    f.ticks.start();
    f.children[3].emit('exit', 0, null);
    expect(calls[3]).toEqual([0, null]);
    f.ticks.start();
    f.children[4].emit('exit', 1, null);
    expect(calls[4]).toEqual([1, { text, log: LOG }]);
    expect(f.events).toHaveLength(4);
  });

  it('gives explain\'s text and a null log when there is no log', () => {
    const calls = [];
    const f = fake({ explain: () => 'explained', streak: (n, last) => calls.push([n, last]) });
    f.ticks.start();
    f.children[0].emit('exit', 1, null);
    expect(calls).toEqual([[1, { text: 'explained', log: null }]]);
  });

  it('is told before the pending tick starts', () => {
    const childrenSeen = [];
    const f = fake({ streak: () => childrenSeen.push(f.children.length) });
    f.ticks.start();
    f.ticks.start();
    f.children[0].emit('exit', 1, null);
    expect(childrenSeen).toEqual([1]);
    expect(f.children).toHaveLength(2);
  });

  it('is not told about an error, and an error does not break the count', () => {
    const calls = [];
    const f = fake({ streak: (n) => calls.push(n) });
    f.ticks.start();
    f.children[0].emit('exit', 1, null);
    f.ticks.start();
    f.children[1].emit('error', new Error('ENOENT'));
    expect(calls).toEqual([1]);
    f.children[1].emit('exit', 1, null);
    expect(calls).toEqual([1]);
    f.ticks.start();
    f.children[2].emit('exit', 1, null);
    expect(calls).toEqual([1, 2]);
  });

  it('is not told about the exit of a child that is no longer the current one', () => {
    const calls = [];
    const f = fake({ streak: (n) => calls.push(n) });
    f.ticks.start();
    f.children[0].emit('error', new Error('ENOENT'));
    f.ticks.start();
    f.children[0].emit('exit', 1, null);
    expect(calls).toEqual([]);
  });

  it('a streak that throws still lets the pending tick start', () => {
    const f = fake({ streak: () => { throw new Error('disk full'); } });
    f.ticks.start();
    f.ticks.start();
    f.children[0].emit('exit', 1, null);
    expect(f.children).toHaveLength(2);
    expect(f.ticks.running()).toBe(true);
    expect(f.events).toEqual([[FAILED, 'warn']]);
  });
});

describe('streakRecord', () => {
  const AT = '2026-11-09T10:00:00.000Z';
  const S = '2026-11-09T09:00:00.000Z';
  const last = { text: 'text', log: '/x/l.log' };
  const never = () => { throw new Error('recorded must not be called'); };

  it('n=1 starts the run at now and saves nothing, without asking recorded', () => {
    expect(streakRecord(1, last, { since: null, at: AT, recorded: never })).toEqual({ since: AT, save: null });
  });
  it('n=2 saves the failure with the run start', () => {
    expect(streakRecord(2, last, { since: S, at: AT, recorded: never })).toEqual({ since: S, save: { learningFailed: { count: 2, since: S, why: 'text', log: '/x/l.log' } } });
  });
  it('n=2 with no start uses now for both', () => {
    expect(streakRecord(2, last, { since: null, at: AT, recorded: never })).toEqual({ since: AT, save: { learningFailed: { count: 2, since: AT, why: 'text', log: '/x/l.log' } } });
  });
  it('n=3 counts 3', () => {
    expect(streakRecord(3, last, { since: S, at: AT, recorded: never }).save.learningFailed.count).toBe(3);
  });
  it('n=2 with no last gives null why and log', () => {
    expect(streakRecord(2, null, { since: S, at: AT, recorded: never }).save.learningFailed).toEqual({ count: 2, since: S, why: null, log: null });
  });
  it('n=0 clears a recorded failure', () => {
    expect(streakRecord(0, null, { since: S, at: AT, recorded: () => true })).toEqual({ since: null, save: { learningFailed: null } });
  });
  it('n=0 saves nothing when none is recorded', () => {
    expect(streakRecord(0, null, { since: S, at: AT, recorded: () => false })).toEqual({ since: null, save: null });
  });
});

describe('learningTicks wired to streakRecord', () => {
  const LOG = '/x/learning-tick-1.log';

  it('two failed ticks record learningFailed with count 2 and a pass clears it', () => {
    let store = {};
    let since = null;
    let clock = 0;
    const saves = [];
    const ats = [];
    const streak = (n, last) => {
      const at = new Date(Date.UTC(2026, 10, 9, 10, 0, clock++)).toISOString();
      ats.push(at);
      const step = streakRecord(n, last, { since, at, recorded: () => Boolean(store.learningFailed) });
      since = step.since;
      if (step.save) {
        saves.push(step.save);
        store = { ...store, ...step.save };
      }
    };
    const f = fake({ newLog: () => LOG, readLog: () => ({ quote: 'Error: boom', report: null }), streak });
    const text = `The learning tick failed (exit 1); its log ${LOG} ends: "Error: boom".`;
    f.ticks.start();
    f.children[0].emit('exit', 1, null);
    expect(store.learningFailed).toBeUndefined();
    f.ticks.start();
    f.children[1].emit('exit', 1, null);
    expect(store.learningFailed).toEqual({ count: 2, since: ats[0], why: text, log: LOG });
    const waiting = buildWaiting({ decisions: { source: 'files', items: [] }, learningFailed: store.learningFailed, loop: { state: 'running' } });
    expect(JSON.stringify(waiting)).toContain('The learning tick failed 2 times in a row');
    f.ticks.start();
    f.children[2].emit('exit', 0, null);
    expect(store.learningFailed).toBeNull();
    const written = saves.length;
    f.ticks.start();
    f.children[3].emit('exit', 0, null);
    expect(saves).toHaveLength(written);
  });
});

describe('learningTicks explain', () => {
  const dir = mkdtempSync(join(tmpdir(), 'foreman-learning-ticks-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("logs explain's text as the warn event instead of the generic one", () => {
    const f = fake({ explain: () => 'Node is broken on this computer.' });
    f.ticks.start();
    f.children[0].emit('exit', 134, null);
    expect(f.events).toEqual([['Node is broken on this computer.', 'warn']]);
  });

  it('explains a killed tick too', () => {
    const f = fake({ explain: () => 'explained' });
    f.ticks.start();
    f.children[0].emit('exit', null, 'SIGABRT');
    expect(f.events).toEqual([['explained', 'warn']]);
  });

  it('keeps the generic text when explain returns null, and does not call it for a tick that worked', () => {
    let calls = 0;
    const f = fake({ explain: () => (calls++, null) });
    f.ticks.start();
    f.children[0].emit('exit', 1, null);
    expect(f.events).toEqual([[FAILED, 'warn']]);
    f.ticks.start();
    f.children[1].emit('exit', 0, null);
    expect(f.events).toHaveLength(1);
    expect(calls).toBe(1);
  });

  it('still starts the pending tick after an explained failure', () => {
    const f = fake({ explain: () => 'explained' });
    f.ticks.start();
    f.ticks.start();
    f.children[0].emit('exit', 134, null);
    expect(f.events).toEqual([['explained', 'warn']]);
    expect(f.children).toHaveLength(2);
    expect(f.ticks.running()).toBe(true);
  });

  it('reports the dyld line as a set-up problem for a real child that cannot load Node', async () => {
    const standin = join(dir, 'standin-node');
    writeFileSync(standin, "#!/bin/sh\necho 'dyld[4242]: Library not loaded: /opt/homebrew/opt/simdjson/lib/libsimdjson.33.dylib' >&2\nexit 134\n", { mode: 0o755 });
    const events = [];
    const ticks = learningTicks({
      spawnTick: () => spawn(standin, ['learning', 'tick'], { stdio: 'ignore' }),
      enabled: true,
      auto: () => true,
      event: (text, kind) => events.push([text, kind]),
      explain: () => {
        const p = probeNode(standin, spawnSh());
        return p.ok ? null : childNodeText('The learning tick failed', p);
      },
    });
    ticks.start();
    for (let i = 0; i < 500 && events.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(events).toHaveLength(1);
    expect(events[0][1]).toBe('warn');
    expect(events[0][0]).toContain('Library not loaded: /opt/homebrew/opt/simdjson/lib/libsimdjson.33.dylib');
    expect(events[0][0]).toContain('set-up');
    expect(events[0][0]).not.toContain('killed by');
  });
});
