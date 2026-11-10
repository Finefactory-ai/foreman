// What each session cost and the files and check runs it leaves, called directly.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionRecords } from './session-records.mjs';
import { CHECKPOINT, readCheckpoint, writeCheckpoint } from './checkpoint.mjs';

const made = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(live = { features: { costMetrics: false } }) {
  const dir = mkdtempSync(join(tmpdir(), 'foreman-session-records-'));
  made.push(dir);
  const event = vi.fn();
  const records = sessionRecords({
    dir,
    config: { project: 'Acme', roles: { reviewers: [] } },
    settings: () => live,
    sessions: new Map(),
    event,
    guarded: (what, fn) => fn,
    now: () => new Date('2026-01-01T10:00:00Z'),
  });
  return { dir, event, ...records };
}

describe('takeSpans', () => {
  it('is an array when nothing ran', () => {
    expect(Array.isArray(setup().takeSpans('w1'))).toBe(true);
  });
});

describe('dropCheckpoint', () => {
  it('removes the checkpoint of a story', () => {
    const { dir, event, dropCheckpoint } = setup();
    writeCheckpoint(dir, { story: 'ACME-1', entries: [], tree: null, at: '2026-01-01T10:00:00.000Z' });
    expect(readCheckpoint(dir, 'ACME-1')).toBeTruthy();
    dropCheckpoint('w1', 'ACME-1');
    expect(existsSync(CHECKPOINT(dir, 'ACME-1'))).toBe(false);
    expect(event).not.toHaveBeenCalled();
  });
});

describe('recordRun', () => {
  it('writes no run record with costMetrics off', () => {
    const { dir, recordRun } = setup();
    const r = recordRun({ slot: 'w1', s: { id: 'ACME-1', startedAt: Date.now() }, log: '', result: 'shipped', rounds: 1, spans: [], learned: [] });
    expect(r).toEqual({});
    expect(existsSync(join(dir, 'runs'))).toBe(false);
  });
});

describe('endSlotCheckJobs', () => {
  it('makes no event when the slot left no check runs', () => {
    const { event, endSlotCheckJobs } = setup();
    endSlotCheckJobs('w1');
    expect(event).not.toHaveBeenCalled();
  });
});
