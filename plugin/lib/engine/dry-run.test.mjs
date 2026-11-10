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

function run(prepare = () => {}) {
  const DIR = mkdtempSync(join(tmpdir(), 'foreman-dry-run-'));
  made.push(DIR);
  prepare(DIR);
  const lines = [];
  vi.spyOn(console, 'log').mockImplementation((line) => lines.push(String(line)));
  dryRun({
    loaded: { localWarnings: [] },
    START: { events: [], from: 'flag' },
    workers: 1,
    MAX: 0,
    SLOT_IDS: ['w1'],
    DIR,
    CONFIG: { generated: [] },
    slotIndex: (slot) => ['w1'].indexOf(slot),
    stories: () => ({ list: () => [], idPattern: /^ACME-\d+$/ }),
    pickStory: () => ({ id: 'ACME-1', title: 'First' }),
    recoveryPlan: () => [],
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
});
