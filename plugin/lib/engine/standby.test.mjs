// Standby and the owner task watch, called directly.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { standbyWatch } from './standby.mjs';
import { readState } from './state.mjs';

const made = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(more = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'foreman-standby-'));
  made.push(dir);
  const awake = { release: vi.fn(), take: vi.fn() };
  const owner = { learn: vi.fn(() => Promise.resolve()) };
  const notify = vi.fn();
  const saveRun = vi.fn();
  const event = vi.fn();
  const watch = standbyWatch({
    root: dir,
    config: { slots: 1 },
    dir,
    tickMs: 50,
    dry: false,
    settings: () => ({}),
    consoleAdapter: () => null,
    awake: () => awake,
    stopping: () => false,
    exiting: () => null,
    owner,
    notify,
    state: () => readState(dir),
    saveRun,
    event,
    now: () => new Date('2026-01-01T10:00:00Z'),
    ...more,
  });
  return { dir, awake, owner, notify, saveRun, event, ...watch };
}

describe('enterStandby', () => {
  it('sets the loop to standby once, lets keep-awake go and asks for a learn', async () => {
    const { dir, awake, owner, notify, standbyOn, standbySince, enterStandby } = setup();
    expect(standbyOn()).toBe(false);
    enterStandby();
    expect(readState(dir).loop.state).toBe('standby');
    expect(awake.release).toHaveBeenCalledTimes(1);
    expect(owner.learn).toHaveBeenCalledTimes(1);
    expect(standbyOn()).toBe(true);
    expect(typeof standbySince()).toBe('number');
    enterStandby();
    expect(awake.release).toHaveBeenCalledTimes(1);
    expect(owner.learn).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 100));
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('leaveStandby', () => {
  it('runs the loop again and takes keep-awake back', () => {
    const { dir, awake, standbyOn, standbySince, enterStandby, leaveStandby } = setup();
    enterStandby();
    leaveStandby();
    expect(readState(dir).loop.state).toBe('running');
    expect(awake.take).toHaveBeenCalledTimes(1);
    expect(standbyOn()).toBe(false);
    expect(standbySince()).toBeNull();
  });
});

describe('publish', () => {
  it('does nothing without a console', async () => {
    const { publish } = setup();
    await expect(publish(true)).resolves.toBeUndefined();
  });
});

describe('checkOwnerTasks', () => {
  it('saves nothing in a dry run', async () => {
    const { saveRun, event, checkOwnerTasks } = setup({ dry: true });
    await checkOwnerTasks();
    expect(saveRun).not.toHaveBeenCalled();
    expect(event).not.toHaveBeenCalled();
  });
});
