import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearNextStory, fixed, handBack, nextStory, pause, readControl, resume, retryAnswer, saveControl, setWorkers, slotAction, stop, writeControl, writeStopFile } from './control.mjs';
import { ownerCommand } from './commands.mjs';
import { readStopRecord } from './stopper.mjs';
import { pendingCommands, slotIdsFor } from '../engine/scheduler.mjs';
import { takeNextRequest } from '../engine/state.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foreman-control-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const t = (s) => new Date(`2026-10-15T09:00:${String(s).padStart(2, '0')}Z`);
const file = () => JSON.parse(readFileSync(join(dir, 'control.json'), 'utf8'));
const SLOTS = slotIdsFor(3);

describe('control.json', () => {
  it('reads as {} when there is none', () => {
    expect(readControl(dir)).toEqual({});
  });

  it('merges each change into what is there, slots key by key', () => {
    writeControl(dir, { paused: true }, t(1));
    writeControl(dir, { slots: { w1: { action: 'park', at: 'A' } } }, t(2));
    writeControl(dir, { slots: { w2: { action: 'skip', at: 'B' } } }, t(3));
    expect(file()).toEqual({ paused: true, slots: { w1: { action: 'park', at: 'A' }, w2: { action: 'skip', at: 'B' } } });
  });

  it('writes through a temp file and leaves none behind', () => {
    pause(dir, t(1));
    expect(readdirSync(dir)).toEqual(['control.json']);
  });

  it('saveControl replaces the whole file', () => {
    pause(dir, t(1));
    saveControl(dir, { workers: 2 });
    expect(file()).toEqual({ workers: 2 });
  });

  it('pause and resume', () => {
    pause(dir, t(1));
    expect(file().paused).toBe(true);
    resume(dir, t(2));
    expect(file()).toMatchObject({ paused: false, resumeAt: t(2).toISOString() });
  });

  it('a slot action is picked up exactly once', () => {
    slotAction(dir, 'w2', 'park', t(1));
    const cmds = pendingCommands(readControl(dir), {}, SLOTS);
    expect(cmds).toEqual([{ key: 'slot:w2', kind: 'slot', slot: 'w2', action: 'park', at: t(1).toISOString() }]);
    expect(pendingCommands(readControl(dir), { 'slot:w2': t(1).toISOString() }, SLOTS)).toEqual([]);
  });

  it('refuses an action the supervisor does not know', () => {
    expect(() => slotAction(dir, 'w1', 'explode', t(1))).toThrow(/explode/);
    expect(existsSync(join(dir, 'control.json'))).toBe(false);
  });

  it('the same command again gets a fresh `at`, even on a frozen clock', () => {
    slotAction(dir, 'w1', 'skip', t(1));
    const first = readControl(dir).slots.w1.at;
    slotAction(dir, 'w1', 'skip', t(1));
    const second = readControl(dir).slots.w1.at;
    expect(second).not.toBe(first);
    expect(pendingCommands(readControl(dir), { 'slot:w1': first }, SLOTS)).toHaveLength(1);
  });

  it('workers, fixed and hand-back are each picked up exactly once', () => {
    setWorkers(dir, 2, t(1));
    fixed(dir, t(2));
    handBack(dir, 'S-4', t(3));
    const c = readControl(dir);
    expect(c).toMatchObject({ workers: 2, workersAt: t(1).toISOString(), fixedAt: t(2).toISOString(), handBack: { id: 'S-4', at: t(3).toISOString() } });
    const cmds = pendingCommands(c, {}, SLOTS);
    expect(cmds.map((x) => x.key)).toEqual(['workers', 'fixed', 'handback']);
    const handled = Object.fromEntries(cmds.map((x) => [x.key, x.at]));
    expect(pendingCommands(c, handled, SLOTS)).toEqual([]);
  });

  it('next story is taken once by the supervisor', () => {
    nextStory(dir, 'S-7', t(1));
    expect(readControl(dir)).toMatchObject({ nextStory: 'S-7', requestedAt: t(1).toISOString() });
    expect(takeNextRequest(dir, () => true, t(2))).toBe('S-7');
    expect(takeNextRequest(dir, () => true, t(3))).toBe('');
  });

  it('stop touches the STOP file the supervisor watches, not control.json', () => {
    stop(dir, t(1));
    expect(existsSync(join(dir, 'STOP'))).toBe(true);
    expect(existsSync(join(dir, 'service-stopped'))).toBe(true);
    expect(existsSync(join(dir, 'control.json'))).toBe(false);
  });

  it('stop writes who stopped the run, the same JSON record in STOP and service-stopped', () => {
    const by = { at: t(1).toISOString(), via: 'cli', pid: 4242, ppid: 4200, parent: '-zsh', cwd: '/tmp/acme', run: false, story: null, slot: null };
    stop(dir, t(1), by);
    expect(readFileSync(join(dir, 'STOP'), 'utf8')).toBe(`${JSON.stringify(by)}\n`);
    expect(readFileSync(join(dir, 'service-stopped'), 'utf8')).toBe(`${JSON.stringify(by)}\n`);
    expect(readStopRecord(join(dir, 'STOP'))).toEqual(by);
  });

  it('stop with no stopper names the process that called it, a story session included', () => {
    const saved = { run: process.env.FOREMAN_RUN, story: process.env.FOREMAN_STORY };
    process.env.FOREMAN_RUN = '1';
    process.env.FOREMAN_STORY = 'ACME-9';
    try {
      stop(dir, t(2));
    } finally {
      for (const [key, value] of [['FOREMAN_RUN', saved.run], ['FOREMAN_STORY', saved.story]]) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    const rec = readStopRecord(join(dir, 'STOP'));
    expect(rec).toMatchObject({ at: t(2).toISOString(), via: 'unknown', story: 'ACME-9', run: true, pid: process.pid, ppid: process.ppid, cwd: process.cwd() });
    expect(typeof rec.parent).toBe('string');
    expect(readStopRecord(join(dir, 'service-stopped'))).toEqual(rec);
  });

  it('ownerCommand passes the stopper to stop only', () => {
    const by = { at: t(3).toISOString(), via: 'dashboard', cwd: null, run: false, story: null, slot: null, agent: 'Mozilla/5.0' };
    ownerCommand(dir, { slots: 2 }, { action: 'stop' }, t(3), by);
    expect(readStopRecord(join(dir, 'STOP'))).toEqual(by);
    ownerCommand(dir, { slots: 2 }, { action: 'pause' }, t(4), by);
    expect(file()).toEqual({ paused: true });
  });

  it('writeStopFile writes STOP only', () => {
    writeStopFile(dir, { at: t(5).toISOString(), via: 'cloud' });
    expect(readStopRecord(join(dir, 'STOP'))).toEqual({ at: t(5).toISOString(), via: 'cloud' });
    expect(existsSync(join(dir, 'service-stopped'))).toBe(false);
  });

  it('a damaged control.json is replaced, not merged', () => {
    writeFileSync(join(dir, 'control.json'), '{not json');
    pause(dir, t(1));
    expect(file()).toEqual({ paused: true });
  });
});

describe('clearNextStory', () => {
  it('removes a request that is still the one named, and keeps requestedAt', () => {
    nextStory(dir, 'ACME-1', t(1));
    const { requestedAt } = file();
    expect(clearNextStory(dir, { id: 'ACME-1', requestedAt })).toBe(true);
    expect(file()).toEqual({ requestedAt });
  });

  it('leaves a newer request alone', () => {
    nextStory(dir, 'ACME-1', t(1));
    const first = file().requestedAt;
    nextStory(dir, 'ACME-2', t(2));
    expect(clearNextStory(dir, { id: 'ACME-1', requestedAt: first })).toBe(false);
    expect(file()).toMatchObject({ nextStory: 'ACME-2' });
    // The same story asked again later is a newer request too.
    nextStory(dir, 'ACME-2', t(3));
    expect(clearNextStory(dir, { id: 'ACME-2', requestedAt: t(2).toISOString() })).toBe(false);
    expect(file().nextStory).toBe('ACME-2');
  });

  it('does nothing with no control.json and keeps the other controls', () => {
    expect(clearNextStory(dir, { id: 'ACME-1', requestedAt: 'x' })).toBe(false);
    expect(existsSync(join(dir, 'control.json'))).toBe(false);
    pause(dir, t(1));
    nextStory(dir, 'ACME-1', t(2));
    clearNextStory(dir, { id: 'ACME-1', requestedAt: file().requestedAt });
    expect(file().paused).toBe(true);
  });
});

describe('retryAnswer', () => {
  it('writes answerRetry { id, at } with a fresh at each time', () => {
    ownerCommand(dir, { slots: 2 }, { action: 'retry-answer', id: 'd-acme-1' }, t(1));
    expect(file().answerRetry).toEqual({ id: 'd-acme-1', at: t(1).toISOString() });
    // A frozen clock still makes a new command.
    retryAnswer(dir, 'd-acme-1', t(1));
    expect(file().answerRetry.at).toBe(new Date(t(1).getTime() + 1).toISOString());
  });

  it('is what the supervisor reads once per at', () => {
    retryAnswer(dir, 'd-acme-1', t(1));
    const commands = pendingCommands(readControl(dir), {}, SLOTS);
    expect(commands.find((c) => c.kind === 'answer-retry')).toMatchObject({ id: 'd-acme-1', at: t(1).toISOString() });
  });

  it('refuses a missing or bad id', () => {
    for (const id of [undefined, '', 'has space', '-lead', 'x'.repeat(81), 7]) {
      expect(() => ownerCommand(dir, { slots: 2 }, { action: 'retry-answer', id }, t(1)), String(id)).toThrow();
    }
    expect(existsSync(join(dir, 'control.json'))).toBe(false);
  });

  it('says what happens next', () => {
    expect(ownerCommand(dir, { slots: 2 }, { action: 'retry-answer', id: 'run:answer:d-1' }, t(1))).toBe('Retrying that answer at the next check.');
  });
});
