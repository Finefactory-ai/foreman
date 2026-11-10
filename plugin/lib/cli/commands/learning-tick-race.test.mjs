import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../main.mjs';
import { addItem, currentItems, readLedger, updateItem } from '../../engine/learning-store.mjs';
import { list as listDecisions } from '../../console/decisions.mjs';
import { writeRun } from '../../engine/run-record.mjs';

// A change can land between the tick's evaluate and its keep or rollback. The real evaluate
// runs, then `race.after` changes the item, so the tick applies a decision made for a version
// no longer in force unless it passes the evaluated `v` to the store. vi.mock is hoisted,
// hence its own file.
const race = vi.hoisted(() => ({ after: null }));

vi.mock('../../engine/learning-eval.mjs', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    evaluate: (...a) => {
      const r = real.evaluate(...a);
      race.after?.();
      return r;
    },
  };
});

let dir;
const state = () => join(dir, '.foreman');
const roleFile = () => join(state(), 'learned', 'traits', 'developer.md');
const V1 = 'Acme: every route has a test that fails if it breaks';
const V2 = 'Acme: every route and every error path has a test that fails if it breaks';
const STALE = 'L-1 changed since it was evaluated; nothing done';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foreman-cli-learning-race-'));
  writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'Acme' }, checks: [{ run: 'true', when: 'always' }] }));
  mkdirSync(state(), { recursive: true });
  // No findings: the tick scans no lessons and never calls the learner.
  writeFileSync(join(state(), 'findings.jsonl'), '');
});
afterEach(() => {
  race.after = null;
  rmSync(dir, { recursive: true, force: true });
});

async function tick() {
  let out = '';
  let err = '';
  const code = await main(['learning', 'tick'], {
    cwd: dir,
    env: { FOREMAN_PROJECT_DIR: dir },
    now: () => new Date('2026-10-24T09:00:00Z'),
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
  });
  return { code, out, err };
}

const at = { now: new Date('2026-10-24T08:00:00Z') };
const seed = () => addItem(state(), { kind: 'trait', roles: ['developer'], text: V1, source: { key: 'untested-routes', stories: ['S-1', 'S-2'] }, reason: 'two stories shipped untested routes' }, at);
const ms = (iso) => Date.parse(iso);
const record = (story, start, minutes, extra = {}) => ({
  story, slot: 'w1', result: 'shipped', costUsd: 0.1, turns: 10, minutes, rounds: 1, serious: 0, learned: [], stages: {}, agents: null,
  startedAt: new Date(start).toISOString(), endedAt: new Date(start + minutes * 60000).toISOString(), ...extra,
});
// 10 baseline runs (rounds 1) days before the seed at 08:00, and window runs from 08:05, each 5 minutes.
const baseline = () => { for (let i = 0; i < 10; i++) writeRun(state(), record(`S-${101 + i}`, ms('2026-10-20T00:00:00Z') + i * 3600000, 30)); };
const windowStart = (i) => ms('2026-10-24T08:05:00Z') + i * 10 * 60000;
const later = (rounds, learned = ['L-1']) => rounds.forEach((r, i) => writeRun(state(), record(`S-${201 + i}`, windowStart(i), 5, { rounds: r, learned })));
// After the last window run (08:45 to 08:50) and before the tick's clock (09:00).
const updateMidTick = () => {
  race.after = () => updateItem(state(), 'L-1', { text: V2, reason: 'merge' }, { now: new Date('2026-10-24T08:55:00Z') });
};
const decisions = () => (existsSync(join(state(), 'decisions')) ? listDecisions(state()) : []);

describe('foreman learning tick applies a decision only to the version it evaluated', () => {
  it('(a) does not keep v2 when v1 was the version evaluated', async () => {
    seed();
    baseline();
    later([1, 1, 1, 1, 1]);
    updateMidTick();
    const { code, out, err } = await tick();
    expect(code).toBe(0);
    expect(err).toContain(STALE);
    const ledger = readLedger(state());
    expect(ledger.some((l) => l.action === 'keep')).toBe(false);
    expect(currentItems(ledger).get('L-1')).toMatchObject({ v: 2, status: 'evaluating' });
    expect(out).not.toContain('Kept L-1');
  });

  it('(b) does not roll back v2 when v1 was the version evaluated', async () => {
    seed();
    baseline();
    later([1, 2, 2, 2, 1]);
    updateMidTick();
    const { code, out, err } = await tick();
    expect(code).toBe(0);
    expect(err).toContain(STALE);
    const ledger = readLedger(state());
    expect(ledger.some((l) => l.action === 'rollback')).toBe(false);
    expect(currentItems(ledger).get('L-1')).toMatchObject({ v: 2, status: 'evaluating' });
    expect(readFileSync(roleFile(), 'utf8')).toBe(`[L-1] ${V2}\n`);
    expect(decisions().some((d) => d.title === 'Foreman rolled back L-1 for developer')).toBe(false);
    expect(out).not.toContain('Rolled back L-1');
  });
});
