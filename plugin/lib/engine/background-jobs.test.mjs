// The park watch, the environment sweep and the learning tick, called directly.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backgroundJobs, STOP_SWEEP_MS } from './background-jobs.mjs';

const made = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(more = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'foreman-background-jobs-'));
  made.push(dir);
  const event = vi.fn();
  const jobs = backgroundJobs({
    root: dir,
    dir,
    bin: join(dir, 'foreman.cjs'),
    node: { node: () => process.execPath, check: () => ({}) },
    envAdapter: { sweep: async () => ({ warnings: [] }) },
    settings: () => ({}),
    dry: false,
    once: false,
    state: () => ({}),
    saveRun: vi.fn(),
    event,
    guarded: (what, fn) => fn,
    now: () => new Date('2026-01-01T10:00:00Z'),
    ...more,
  });
  return { dir, event, ...jobs };
}

const until = async (ok) => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 25));
};

describe('startEnvSweep', () => {
  it('logs what the adapter warns about and ends the run', async () => {
    const { event, envSweep, startEnvSweep } = setup({ envAdapter: { sweep: async () => ({ warnings: ['org gone'] }) } });
    startEnvSweep();
    expect(envSweep.running).toBe(true);
    await until(() => !envSweep.running);
    expect(envSweep.running).toBe(false);
    expect(event).toHaveBeenCalledWith('Slot environment: org gone', 'warn');
  });
});

describe('sweepAtStop', () => {
  it('calls the adapter sweep once with { stopping: true, limitMs: STOP_SWEEP_MS } and logs each warning', async () => {
    const sweep = vi.fn(async () => ({ warnings: ['org gone', 'org stuck'] }));
    const { event, sweepAtStop } = setup({ envAdapter: { sweep } });
    await sweepAtStop();
    expect(STOP_SWEEP_MS).toBe(60_000);
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(sweep).toHaveBeenCalledWith({ stopping: true, limitMs: 60_000 });
    expect(event.mock.calls).toEqual([
      ['Slot environment: org gone', 'warn'],
      ['Slot environment: org stuck', 'warn'],
    ]);
  });
  it('calls nothing and logs nothing on a dry run, or for an adapter with no sweep', async () => {
    const sweep = vi.fn(async () => ({ warnings: ['x'] }));
    const dry = setup({ dry: true, envAdapter: { sweep } });
    await dry.sweepAtStop();
    expect(sweep).not.toHaveBeenCalled();
    expect(dry.event).not.toHaveBeenCalled();
    const none = setup({ envAdapter: {} });
    await none.sweepAtStop();
    expect(none.event).not.toHaveBeenCalled();
    const absent = setup({ envAdapter: undefined });
    await expect(absent.sweepAtStop()).resolves.toBeUndefined();
  });
  it('never throws, even when the adapter or the event log does', async () => {
    const boom = setup({
      envAdapter: {
        sweep: () => {
          throw new Error('boom');
        },
      },
    });
    await expect(boom.sweepAtStop()).resolves.toBeUndefined();
    expect(boom.event).toHaveBeenCalledWith('Slot environment: the sweep failed: boom', 'warn');
    const loud = setup({
      envAdapter: { sweep: async () => ({ warnings: ['a'] }) },
      event: () => {
        throw new Error('log broke');
      },
    });
    await expect(loud.sweepAtStop()).resolves.toBeUndefined();
  });
  it('is awaited by the supervisor stop, after the sessions are ended and before the loop is set stopped, and not by a restart', () => {
    const src = readFileSync(new URL('./supervisor.mjs', import.meta.url), 'utf8');
    const stop = src.slice(src.indexOf('async function stop('), src.indexOf('async function restartOnNewCode('));
    const ended = stop.indexOf("process.kill(-s.pid, 'SIGKILL')");
    const sweep = stop.indexOf('await sweepAtStop()');
    const loop = stop.indexOf('setLoop(DIR, loop, reason)');
    expect(ended).toBeGreaterThan(0);
    expect(sweep).toBeGreaterThan(ended);
    expect(loop).toBeGreaterThan(sweep);
    const restart = src.slice(src.indexOf('async function restartOnNewCode('), src.indexOf('function newCodeAccepts('));
    expect(restart.length).toBeGreaterThan(100);
    expect(restart).not.toContain('sweepAtStop');
  });
});

describe('startParkWatch', () => {
  it('starts the release watch and clears the child when it exits', async () => {
    const { dir, parkWatch, startParkWatch } = setup();
    writeFileSync(join(dir, 'foreman.cjs'), 'process.exit(0);');
    startParkWatch();
    expect(parkWatch.lastAt).toBeGreaterThan(0);
    expect(parkWatch.child).toBeTruthy();
    await until(() => parkWatch.child === null);
    expect(parkWatch.child).toBeNull();
  });
});

describe('learning', () => {
  it('is not running at first', () => {
    expect(setup().learning.running()).toBe(false);
  });
});
