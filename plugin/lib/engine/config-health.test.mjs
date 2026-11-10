import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configProblemWhy, LAST_GOOD_FILE, readLastGood, runOnLastGood, saveLastGood } from './config-health.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foreman-config-health-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the last good config', () => {
  it('round-trips through config.last-good.json, with no temp file left', () => {
    const team = { version: 1, project: { name: 'Acme' }, slots: 2 };
    saveLastGood(dir, team);
    expect(existsSync(join(dir, LAST_GOOD_FILE))).toBe(true);
    expect(readdirSync(dir)).toEqual([LAST_GOOD_FILE]);
    expect(readLastGood(dir)).toEqual(team);
  });

  it('is null when there is none, or it is not JSON', () => {
    expect(readLastGood(dir)).toBeNull();
    writeFileSync(join(dir, LAST_GOOD_FILE), '{nope');
    expect(readLastGood(dir)).toBeNull();
  });
});

describe('runOnLastGood', () => {
  it("reads state.json's configProblem", () => {
    const problem = { since: '2026-10-24T22:49:00.000Z', reason: 'bogus: unknown key' };
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ configProblem: problem }));
    expect(runOnLastGood(dir)).toEqual(problem);
  });

  it('is null when it is absent or malformed', () => {
    expect(runOnLastGood(dir)).toBeNull();
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ configProblem: null }));
    expect(runOnLastGood(dir)).toBeNull();
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ configProblem: 'bogus' }));
    expect(runOnLastGood(dir)).toBeNull();
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ configProblem: { since: 'x', reason: 3 } }));
    expect(runOnLastGood(dir)).toBeNull();
    writeFileSync(join(dir, 'state.json'), 'not json');
    expect(runOnLastGood(dir)).toBeNull();
  });
});

describe('configProblemWhy', () => {
  it('says since when, in local time, and why', () => {
    const since = new Date(2026, 9, 24, 23, 49).toISOString();
    expect(configProblemWhy({ since, reason: 'bogus: unknown key' }, new Date())).toBe('config invalid since 23:49: bogus: unknown key; running on the last good config');
  });

  it('falls back to now when since is not a date, and cuts a long reason', () => {
    const why = configProblemWhy({ since: 'never', reason: 'x'.repeat(400) }, new Date(2026, 9, 25, 8, 5));
    expect(why).toBe(`config invalid since 08:05: ${'x'.repeat(300)}; running on the last good config`);
  });
});
