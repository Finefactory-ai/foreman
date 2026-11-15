// The --dry-run report, called with a fake context.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dryRun } from './dry-run.mjs';
import { setSlot } from './state.mjs';

const made = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(prepare = () => {}, { MAX = 0, plan = [] } = {}) {
  const DIR = mkdtempSync(join(tmpdir(), 'foreman-dry-run-'));
  made.push(DIR);
  prepare(DIR);
  const lines = [];
  vi.spyOn(console, 'log').mockImplementation((line) => lines.push(String(line)));
  dryRun({
    loaded: { localWarnings: [] },
    START: { events: [], from: 'flag' },
    workers: 1,
    MAX,
    SLOT_IDS: ['w1'],
    DIR,
    CONFIG: { generated: [] },
    slotIndex: (slot) => ['w1'].indexOf(slot),
    stories: () => ({ list: () => [], idPattern: '^ACME-\\d+$'}),
    pickStory: () => ({ id: 'ACME-1', title: 'First' }),
    recoveryPlan: () => plan,
    endedFolderStory: () => null,
    schemaExtra: () => [],
    schemaFree: () => true,
    keptOut: () => () => false,
    fileWaiters: () => [],
  });
  return lines;
}

describe('dryRun', () => {
  it('says what each idle slot would start', () => {
    const lines = run();
    expect(lines).toContain('1 worker (--workers)');
    expect(lines).toContain('would start ACME-1 (First) in w1');
  });

  it('starts nothing in a parked slot', () => {
    const lines = run((DIR) => setSlot(DIR, 'w1', { state: 'parked' }));
    expect(lines).toContain('w1 is parked; nothing starts there');
  });

  it('says the stories left in hand are resumed on top of the number asked for', () => {
    const plan = [1, 2, 3].map((n) => ({ type: 'resume', id: `ACME-${n}`, slot: null, from: null }));
    const lines = run(() => {}, { MAX: 1, plan: [...plan, { type: 'clear-stale' }] });
    const line = '3 stories left in hand are resumed first, on top of the 1 asked for: they do not count towards it.';
    expect(lines).toContain(line);
    expect(lines.indexOf(line)).toBeGreaterThan(lines.indexOf('1 worker (--workers)'));
  });

  it('adds no line with nothing left in hand', () => {
    const lines = run(() => {}, { MAX: 1, plan: [] });
    expect(lines.some((l) => l.includes('left in hand'))).toBe(false);
  });

  it('adds no line when no number was asked for', () => {
    const plan = [{ type: 'resume', id: 'ACME-1', slot: null, from: null }];
    const lines = run(() => {}, { MAX: 0, plan });
    expect(lines.some((l) => l.includes('left in hand'))).toBe(false);
  });
});
