// setup.json: step ids, confirmations and times only, and the per-step limit it keeps.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LIMITS, SETUP_FILE, clearConfirmedByYou, makeLimiter, markChecked, markConfirmed, markConfirmedByYou, readRecord, writeRecord } from './record.mjs';

const T0 = Date.parse('2026-10-24T09:00:00.000Z');
const EMPTY = { version: 1, steps: {} };

let dir;
let t;
const now = () => new Date(t);
const file = () => path.join(dir, SETUP_FILE);
const raw = () => fs.readFileSync(file(), 'utf8');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-setup-record-'));
  t = T0;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('readRecord and writeRecord', () => {
  it('reads a missing or broken file as empty', () => {
    expect(readRecord(dir)).toEqual(EMPTY);
    fs.writeFileSync(file(), '{not json');
    expect(readRecord(dir)).toEqual(EMPTY);
    fs.writeFileSync(file(), JSON.stringify([1, 2]));
    expect(readRecord(dir)).toEqual(EMPTY);
    fs.writeFileSync(file(), JSON.stringify({ version: 2, steps: { github: { checkedAt: '2026-10-24T09:00:00.000Z', runs: [] } } }));
    expect(readRecord(dir)).toEqual(EMPTY);
  });

  it('drops unknown step ids, unknown fields and values that are not times', () => {
    fs.writeFileSync(
      file(),
      JSON.stringify({
        version: 1,
        extra: 'nope',
        steps: {
          '../x': { checkedAt: '2026-10-24T09:00:00.000Z', runs: [] },
          ['__proto__']: { checkedAt: '2026-10-24T09:00:00.000Z' },
          github: { checkedAt: '2026-10-24T09:00:00.000Z', confirmedAt: 'yesterday', runs: ['2026-10-24T08:59:00.000Z', 42, 'soon'], value: 're_acme-fake', note: 'hi' },
          project: { confirmedAt: 17, runs: 'many' },
          notifications: 'done',
        },
      }),
    );
    expect(readRecord(dir)).toEqual({
      version: 1,
      steps: {
        github: { checkedAt: '2026-10-24T09:00:00.000Z', runs: ['2026-10-24T08:59:00.000Z'] },
        project: { runs: [] },
      },
    });
  });

  it('writes at mode 600, with no tmp file left behind, and only the known fields', () => {
    writeRecord(dir, { version: 1, other: 1, steps: { github: { checkedAt: '2026-10-24T09:00:00.000Z', runs: [], secret: 'x' }, nope: { runs: [] } } });
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual([SETUP_FILE]);
    expect(JSON.parse(raw())).toEqual({ version: 1, steps: { github: { checkedAt: '2026-10-24T09:00:00.000Z', runs: [] } } });
  });

  it('markChecked and markConfirmed set only their own field', () => {
    markChecked(dir, 'github', '2026-10-24T09:00:00.000Z');
    expect(readRecord(dir).steps).toEqual({ github: { checkedAt: '2026-10-24T09:00:00.000Z', runs: [] } });
    markConfirmed(dir, 'github', '2026-10-24T09:05:00.000Z');
    expect(readRecord(dir).steps).toEqual({ github: { checkedAt: '2026-10-24T09:00:00.000Z', confirmedAt: '2026-10-24T09:05:00.000Z', runs: [] } });
    markConfirmed(dir, 'project', '2026-10-24T09:06:00.000Z');
    expect(readRecord(dir).steps.project).toEqual({ confirmedAt: '2026-10-24T09:06:00.000Z', runs: [] });
    expect(readRecord(dir).steps.github.checkedAt).toBe('2026-10-24T09:00:00.000Z');
  });
});

describe('confirmed by you', () => {
  const CHECKED = '2026-10-24T09:00:00.000Z';
  const CONFIRMED = '2026-10-24T09:05:00.000Z';
  const BY_YOU = '2026-10-24T09:10:00.000Z';

  it('is kept apart from checked: markConfirmedByYou leaves checkedAt and confirmedAt alone', () => {
    markChecked(dir, 'sf-gearset', CHECKED);
    markConfirmed(dir, 'sf-gearset', CONFIRMED);
    markConfirmedByYou(dir, 'sf-gearset', 'ci-tests-qa', BY_YOU);
    expect(readRecord(dir).steps['sf-gearset']).toEqual({ checkedAt: CHECKED, confirmedAt: CONFIRMED, confirmedByYou: { 'ci-tests-qa': BY_YOU }, runs: [] });
  });

  it('survives markChecked and markConfirmed, and a limiter run', () => {
    markConfirmedByYou(dir, 'sf-gearset', 'ci-tests-qa', BY_YOU);
    markChecked(dir, 'sf-gearset', CHECKED);
    markConfirmed(dir, 'sf-gearset', CONFIRMED);
    const r = makeLimiter({ dir, now }).begin('sf-gearset');
    r.done();
    expect(readRecord(dir).steps['sf-gearset']).toMatchObject({ checkedAt: CHECKED, confirmedAt: CONFIRMED, confirmedByYou: { 'ci-tests-qa': BY_YOU } });
  });

  it('clearConfirmedByYou removes only that item', () => {
    markConfirmedByYou(dir, 'sf-gearset', 'ci-tests-qa', BY_YOU);
    markConfirmedByYou(dir, 'sf-gearset', 'ci-tests-uat', CONFIRMED);
    markChecked(dir, 'sf-gearset', CHECKED);
    clearConfirmedByYou(dir, 'sf-gearset', 'ci-tests-qa');
    expect(readRecord(dir).steps['sf-gearset']).toEqual({ checkedAt: CHECKED, confirmedByYou: { 'ci-tests-uat': CONFIRMED }, runs: [] });
    clearConfirmedByYou(dir, 'sf-gearset', 'ci-tests-uat');
    expect(readRecord(dir).steps['sf-gearset']).toEqual({ checkedAt: CHECKED, runs: [] });
    clearConfirmedByYou(dir, 'github', 'ci-tests-qa');
    expect(readRecord(dir).steps.github).toBeUndefined();
  });

  it('drops a bad item id or a value that is not an ISO time when read', () => {
    fs.writeFileSync(file(), JSON.stringify({
      version: 1,
      steps: {
        'sf-gearset': {
          runs: [],
          confirmedByYou: { '../x': BY_YOU, QA: BY_YOU, 'ci-tests-qa': BY_YOU, 'ci-tests-uat': 'yesterday', 'ci-tests-dev': 7, ['__proto__']: BY_YOU },
        },
        github: { runs: [], confirmedByYou: 'all' },
      },
    }));
    expect(readRecord(dir).steps).toEqual({ 'sf-gearset': { runs: [], confirmedByYou: { 'ci-tests-qa': BY_YOU } }, github: { runs: [] } });
  });

  it('refuses to write a bad item, and keeps the file at mode 600', () => {
    markConfirmedByYou(dir, 'sf-gearset', '../x', BY_YOU);
    markConfirmedByYou(dir, 'sf-gearset', 'ci-tests-qa', 'soon');
    expect(readRecord(dir).steps['sf-gearset'] ?? { runs: [] }).toEqual({ runs: [] });
    markConfirmedByYou(dir, 'sf-gearset', 'ci-tests-qa', BY_YOU);
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
    expect(JSON.parse(raw()).steps['sf-gearset'].confirmedByYou).toEqual({ 'ci-tests-qa': BY_YOU });
  });
});

describe('makeLimiter', () => {
  it('has the limits the story names', () => {
    expect(LIMITS).toEqual({ perMinute: 5, perHour: 30 });
    expect(Object.isFrozen(LIMITS)).toBe(true);
  });

  it('refuses the 6th try within a minute, and allows it again a minute later', () => {
    const limiter = makeLimiter({ dir, now });
    for (let i = 0; i < 5; i += 1) {
      const r = limiter.begin('github');
      expect(r.ok, `try ${i + 1}`).toBe(true);
      r.done();
      t += 1000;
    }
    // Runs at 0..4 s; now 5 s: the oldest leaves the minute at 60 s.
    expect(limiter.begin('github')).toEqual({ ok: false, retryAfter: 55, why: 'minute' });
    t += 61_000;
    const again = limiter.begin('github');
    expect(again.ok).toBe(true);
    again.done();
  });

  it('refuses the 31st try within an hour', () => {
    const limiter = makeLimiter({ dir, now });
    for (let i = 0; i < 30; i += 1) {
      const r = limiter.begin('github');
      expect(r.ok, `try ${i + 1}`).toBe(true);
      r.done();
      t += 13_000;
    }
    // 30 runs from 0 to 377 s; now 390 s: the oldest leaves the hour at 3600 s.
    expect(limiter.begin('github')).toEqual({ ok: false, retryAfter: 3210, why: 'hour' });
    expect(readRecord(dir).steps.github.runs).toHaveLength(30);
  });

  it('runs one at a time per step, and done() frees it', () => {
    const limiter = makeLimiter({ dir, now });
    const first = limiter.begin('github');
    expect(first.ok).toBe(true);
    expect(limiter.begin('github')).toEqual({ ok: false, retryAfter: 1, why: 'busy' });
    const other = limiter.begin('project');
    expect(other.ok).toBe(true);
    first.done();
    first.done();
    const next = limiter.begin('github');
    expect(next.ok).toBe(true);
    next.done();
    other.done();
  });

  it('does not let one step use up another step', () => {
    const limiter = makeLimiter({ dir, now });
    for (let i = 0; i < 5; i += 1) limiter.begin('github').done();
    expect(limiter.begin('github').ok).toBe(false);
    const r = limiter.begin('project');
    expect(r.ok).toBe(true);
    r.done();
  });

  it('keeps the runs in setup.json, so a new limiter still refuses', () => {
    const first = makeLimiter({ dir, now });
    for (let i = 0; i < 5; i += 1) first.begin('github').done();
    const second = makeLimiter({ dir, now });
    expect(second.begin('github')).toMatchObject({ ok: false, why: 'minute' });
  });

  it('writes nothing for a refused try', () => {
    const limiter = makeLimiter({ dir, now });
    const held = limiter.begin('github');
    const afterFirst = raw();
    expect(limiter.begin('github').ok).toBe(false);
    expect(raw()).toBe(afterFirst);
    held.done();
    for (let i = 0; i < 4; i += 1) limiter.begin('github').done();
    const afterFive = raw();
    t += 1000;
    expect(limiter.begin('github').ok).toBe(false);
    expect(raw()).toBe(afterFive);
    expect(readRecord(dir).steps.github.runs).toHaveLength(5);
  });

  it('forgets runs older than an hour when it records a new one', () => {
    const limiter = makeLimiter({ dir, now });
    limiter.begin('github').done();
    t += 3_601_000;
    limiter.begin('github').done();
    expect(readRecord(dir).steps.github.runs).toEqual([new Date(t).toISOString()]);
  });
});
