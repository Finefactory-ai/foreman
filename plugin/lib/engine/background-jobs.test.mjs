// The park watch, the environment sweep and the learning tick, called directly.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backgroundJobs } from './background-jobs.mjs';

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
