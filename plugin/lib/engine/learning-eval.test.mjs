import { describe, expect, it } from 'vitest';
import { BASELINE_RUNS, evaluate, evaluateItem, OUTCOMES, rolledBack, rolledBackKeys, versionAt, WAIT_DAYS } from './learning-eval.mjs';
import { currentItems } from './learning-store.mjs';
import { clusterFindings, notFixedKey } from './lessons.mjs';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.parse('2026-10-10T00:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const RULE = 'Acme routes have a test that fails if they break';

// The findings that made the lesson, before T0.
const finding = (story, at, extra = {}) => ({ at: iso(at), story, result: 'shipped', builder: 'developer', stage: 'tester', severity: 'blocker', rule: RULE, where: 'src/routes.mjs:3', observed: 'no test', fix: 'add a test', ...extra });
const FINDINGS = [finding('S-1', T0 - 5 * DAY), finding('S-2', T0 - 4 * DAY)];
const KEY = clusterFindings(FINDINGS)[0].key;

// Ledger lines.
const ref = (id, v) => ({ snapshot: `learned/.history/${id}/v${v}.md`, sha256: `${id}-${v}` });
const add = (id, at, { roles = ['developer'], key = KEY, stories = ['S-1', 'S-2'], kind = 'trait' } = {}) => ({
  at: iso(at), id, v: 1, action: 'add', kind, roles, path: `learned/traits/${roles[0]}.md`, before: null, after: ref(id, 1), source: key === null ? null : { key, stories }, reason: 'seed', by: 'foreman', metrics: null,
});
const update = (id, v, at, { roles = ['developer'], key = KEY } = {}) => ({
  at: iso(at), id, v, action: 'update', kind: 'trait', roles, path: `learned/traits/${roles[0]}.md`, before: ref(id, v - 1), after: ref(id, v), source: { key, stories: ['S-1', 'S-2'] }, reason: 'merge', by: 'foreman', metrics: null,
});
const pop = (id, v, at, { action = 'rollback', by = 'foreman', decision = 'rollback', roles = ['developer'] } = {}) => ({
  at: iso(at), id, v, action, kind: 'trait', roles, path: `learned/traits/${roles[0]}.md`, before: null, after: null, source: null, reason: 'x', by, metrics: action === 'rollback' ? { decision } : null,
});
const keep = (id, v, at) => ({ at: iso(at), id, v, action: 'keep', kind: 'trait', roles: ['developer'], path: 'learned/traits/developer.md', before: null, after: ref(id, v), source: null, reason: '', by: 'owner', metrics: null });

// Run records: start `at`, 30 minutes long.
const run = (story, at, extra = {}) => ({ story, slot: 'w1', result: 'shipped', rounds: 1, serious: 0, learned: [], agents: null, startedAt: iso(at), endedAt: iso(at + 30 * 60 * 1000), ...extra });
const BASELINE = Array.from({ length: 10 }, (_, i) => run(`S-${101 + i}`, T0 - 20 * DAY + i * HOUR));
// Window run i (0-based) starts i+1 hours after T0 and lists L-1, with `over` per run.
const windowRuns = (n, over = () => ({}), learned = ['L-1']) => Array.from({ length: n }, (_, i) => run(`S-${201 + i}`, T0 + (i + 1) * HOUR, { learned, ...over(i) }));

const LEDGER = [add('L-1', T0)];
const item = (ledger = LEDGER, id = 'L-1') => currentItems(ledger).get(id);
const evalOne = ({ ledger = LEDGER, runs, findings = FINDINGS, window = 5, now = T0 + DAY, id = 'L-1' }) => evaluateItem(item(ledger, id), { ledger, runs, findings, window, now: new Date(now) });
const evalAll = ({ ledger = LEDGER, runs, findings = FINDINGS, window = 5, now = T0 + DAY }) => evaluate({ ledger, runs, findings, window, now: new Date(now) });

describe('constants', () => {
  it('waits 14 days, compares with 10 runs, and counts only outcomes', () => {
    expect(WAIT_DAYS).toBe(14);
    expect(BASELINE_RUNS).toBe(10);
    expect(OUTCOMES).toEqual(['shipped', 'ready-to-promote', 'failed']);
  });
});

describe('versionAt', () => {
  it('walks adds, updates and pops in order', () => {
    const ledger = [add('L-1', T0), update('L-1', 2, T0 + 10 * HOUR), pop('L-1', 1, T0 + 20 * HOUR)];
    const it1 = item(ledger);
    expect(versionAt(it1, T0 - 1)).toBe(0);
    expect(versionAt(it1, T0)).toBe(1);
    expect(versionAt(it1, T0 + 11 * HOUR)).toBe(2);
    expect(versionAt(it1, iso(T0 + 21 * HOUR))).toBe(1);
  });
});

describe('evaluateItem: the rules', () => {
  it('1. target gone: keep, proven', () => {
    const r = evalOne({ runs: [...BASELINE, ...windowRuns(5)] });
    expect(r.decision).toBe('keep');
    expect(r.metrics.window.runs).toBe(5);
    expect(r.metrics.window.target).toBe(0);
    expect(r.reason).toMatch(/^Proven/);
    expect(r.reason).toBe('Proven over 5 stories: rounds 1.0 → 1.0');
    expect(r.runs).toHaveLength(5);
    expect(r.runs[0]).toBe(`S-201@${iso(T0 + HOUR)}`);
    expect(r).toMatchObject({ id: 'L-1', v: 1, roles: ['developer'], changeAt: iso(T0) });
  });

  it('2. target recurs on 2 window stories: retire, naming both', () => {
    const runs = [...BASELINE, ...windowRuns(5)];
    const findings = [...FINDINGS, finding('S-201', T0 + HOUR + 10 * 60 * 1000), finding('S-203', T0 + 3 * HOUR + 10 * 60 * 1000)];
    const r = evalOne({ runs, findings });
    expect(r.decision).toBe('retire');
    expect(r.reason).toBe('No effect: the problem came back on S-201, S-203');
    expect(r.metrics.window.target).toBe(2);
    expect(r.metrics.decision).toBe('retire');
  });

  it('3. rounds up: rollback with the numbers', () => {
    const rounds = [1, 2, 2, 2, 1];
    const r = evalOne({ runs: [...BASELINE, ...windowRuns(5, (i) => ({ rounds: rounds[i] }))] });
    expect(r.decision).toBe('rollback');
    expect(r.reason).toBe('Stories got worse: rounds 1.0 → 1.6');
    expect(r.metrics.window.rounds).toBe(1.6);
    expect(r.metrics.baseline.rounds).toBe(1);
    expect(r.metrics.baseline.runs).toBe(10);
    expect(r.metrics).toMatchObject({ decision: 'rollback', window: { runs: 5, stories: 5, serious: 0, failRate: 0, target: 0 }, baseline: { runs: 10, stories: 10, serious: 0, failRate: 0, target: 0 } });
  });

  it('4. rounds up but the target dropped: keep', () => {
    const rounds = [1, 2, 2, 2, 1];
    const findings = [...FINDINGS, ...BASELINE.slice(0, 4).map((b) => finding(b.story, Date.parse(b.startedAt) + 60 * 1000))];
    const r = evalOne({ runs: [...BASELINE, ...windowRuns(5, (i) => ({ rounds: rounds[i] }))], findings });
    expect(r.metrics.baseline.target).toBe(4);
    expect(r.metrics.window.target).toBe(0);
    expect(r.decision).toBe('keep');
  });

  it('5. [L-1] named in a finding: rollback after one run; [L-12] does not count', () => {
    const cited = { ...finding('S-201', T0 + HOUR + 60 * 1000), rule: 'Acme errors say what failed', observed: 'the learned rule [L-1] made the developer skip the error test' };
    const r = evalOne({ runs: [...BASELINE, ...windowRuns(1)], findings: [...FINDINGS, cited] });
    expect(r.decision).toBe('rollback');
    expect(r.reason).toBe('[L-1] was named in a finding on S-201');
    expect(r.metrics.cited).toEqual(['S-201']);
    const other = { ...cited, observed: 'the learned rule [L-12] was in the way' };
    expect(evalAll({ runs: [...BASELINE, ...windowRuns(1)], findings: [...FINDINGS, other] })).toEqual([]);
  });

  it('5b. a citation before the change does not count', () => {
    const old = { ...finding('S-2', T0 - DAY), observed: '[L-1] got in the way' };
    expect(evalAll({ runs: [...BASELINE, ...windowRuns(1)], findings: [...FINDINGS, old] })).toEqual([]);
  });

  it('6. 2 failed window runs out of 3: rollback at once', () => {
    const r = evalOne({ runs: [...BASELINE, ...windowRuns(3, (i) => ({ result: i < 2 ? 'failed' : 'shipped' }))] });
    expect(r.decision).toBe('rollback');
    expect(r.reason).toBe('2 runs failed with L-1 on S-201, S-202');
    expect(r.metrics.failed).toEqual(['S-201', 'S-202']);
  });

  it('6a. two window runs that failed on the environment give no rollback and are not counted', () => {
    const runs = [...BASELINE, ...windowRuns(3, (i) => (i < 2 ? { result: 'failed', cause: 'environment' } : {}))];
    const r = evalOne({ runs });
    expect(r.decision).not.toBe('rollback');
    expect(r.metrics.failed ?? []).toEqual([]);
    expect(r.metrics.window.runs).toBe(1);
  });

  it('6a2. the same two failures without a cause still roll back', () => {
    const r = evalOne({ runs: [...BASELINE, ...windowRuns(3, (i) => ({ result: i < 2 ? 'failed' : 'shipped' }))] });
    expect(r.decision).toBe('rollback');
    expect(r.reason).toBe('2 runs failed with L-1 on S-201, S-202');
  });

  it('6b. one story failing twice is 2 runs on one story', () => {
    const runs = [
      ...BASELINE,
      run('S-205', T0 + HOUR, { learned: ['L-1'], result: 'failed' }),
      run('S-205', T0 + 2 * HOUR, { learned: ['L-1'], result: 'failed' }),
      run('S-206', T0 + 3 * HOUR, { learned: ['L-1'] }),
    ];
    const r = evalOne({ runs });
    expect(r.decision).toBe('rollback');
    expect(r.reason).toBe('2 runs failed with L-1 on S-205');
    expect(r.metrics.failed).toEqual(['S-205']);
  });

  it('7. a window not yet full gives no result', () => {
    expect(evalAll({ runs: [...BASELINE, ...windowRuns(3)], now: T0 + 3 * DAY })).toEqual([]);
    expect(evalOne({ runs: [...BASELINE, ...windowRuns(3)], now: T0 + 3 * DAY }).decision).toBeNull();
  });

  it('8. after 14 days it decides on what is there; with no runs it waits', () => {
    const r = evalAll({ runs: [...BASELINE, ...windowRuns(2)], now: T0 + 14 * DAY });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ id: 'L-1', decision: 'keep' });
    expect(r[0].metrics.window.runs).toBe(2);
    expect(evalAll({ runs: BASELINE, now: T0 + 30 * DAY })).toEqual([]);
  });

  it('9. serious +1 rolls back, failures +20 points roll back, serious +0.8 keeps', () => {
    const serious = evalOne({ runs: [...BASELINE, ...windowRuns(5, () => ({ serious: 1 }))] });
    expect(serious.decision).toBe('rollback');
    expect(serious.reason).toBe('Stories got worse: serious findings 0.0 → 1.0');
    const failed = evalOne({ runs: [...BASELINE, ...windowRuns(5, (i) => ({ result: i === 0 ? 'failed' : 'shipped' }))] });
    expect(failed.decision).toBe('rollback');
    expect(failed.reason).toBe('Stories got worse: failures 0% → 20%');
    expect(failed.metrics.window.failRate).toBe(20);
    const less = evalOne({ runs: [...BASELINE, ...windowRuns(5, (i) => ({ serious: i < 4 ? 1 : 0 }))] });
    expect(less.metrics.window.serious).toBe(0.8);
    expect(less.decision).toBe('keep');
  });

  it('9b. lists every metric that rose', () => {
    const r = evalOne({ runs: [...BASELINE, ...windowRuns(5, () => ({ rounds: 2, serious: 1 }))] });
    expect(r.reason).toBe('Stories got worse: rounds 1.0 → 2.0, serious findings 0.0 → 1.0');
  });

  it('10. only outcome runs that used L-1 after the change are in the window; the baseline keeps to the roles', () => {
    const runs = [
      ...BASELINE,
      run('S-150', T0 - 2 * DAY, { agents: [{ role: 'tester' }], rounds: 9 }),
      run('S-151', T0 - DAY, { agents: [{ role: 'developer' }, { role: 'tester' }], rounds: 1 }),
      run('S-190', T0 - HOUR, { learned: ['L-1'] }),
      run('S-191', T0 + HOUR, { learned: [] }),
      run('S-192', T0 + 2 * HOUR, { learned: ['L-1'], result: 'stopped', rounds: 5 }),
      run('S-193', T0 + 3 * HOUR, { learned: ['L-1'], result: 'crashed', rounds: 5 }),
      run('S-194', T0 + 4 * HOUR, { learned: ['L-1'], result: 'ready-to-promote' }),
      run('S-195', T0 + 5 * HOUR, { learned: ['L-1', 'L-2'] }),
    ];
    const r = evalOne({ runs });
    expect(r.runs.map((k) => k.split('@')[0])).toEqual(['S-194', 'S-195']);
    expect(r.metrics.baseline.runs).toBe(10);
    expect(r.metrics.baseline.rounds).toBe(1);
    expect(r.metrics.baseline.stories).toBe(10);
  });

  it('10b. the window is cut to the first `window` runs, oldest first', () => {
    const r = evalOne({ runs: [...BASELINE, ...windowRuns(7)] });
    expect(r.metrics.window.runs).toBe(5);
    expect(r.runs.at(-1).startsWith('S-205@')).toBe(true);
  });
});

describe('evaluateItem: versions', () => {
  it('11. v2 counts only runs that used v2; after a rollback of v2, v1 skips the runs of v2', () => {
    const early = windowRuns(3);
    const late = Array.from({ length: 5 }, (_, i) => run(`S-${301 + i}`, T0 + (11 + i) * HOUR, { learned: ['L-1'], rounds: 2 }));
    const ledger = [add('L-1', T0), update('L-1', 2, T0 + 10 * HOUR)];
    const v2 = evalOne({ ledger, runs: [...BASELINE, ...early, ...late] });
    expect(v2.v).toBe(2);
    expect(v2.changeAt).toBe(iso(T0 + 10 * HOUR));
    expect(v2.runs.map((k) => k.split('@')[0])).toEqual(['S-301', 'S-302', 'S-303', 'S-304', 'S-305']);
    expect(v2.decision).toBe('rollback');

    const back = [...ledger, pop('L-1', 1, T0 + 20 * HOUR)];
    const after = run('S-401', T0 + 21 * HOUR, { learned: ['L-1'] });
    const v1 = evalOne({ ledger: back, runs: [...BASELINE, ...early, ...late, after], now: T0 + 22 * HOUR });
    expect(v1.v).toBe(1);
    expect(v1.changeAt).toBe(iso(T0));
    expect(v1.runs.map((k) => k.split('@')[0])).toEqual(['S-201', 'S-202', 'S-203', 'S-401']);
  });
});

describe('evaluateItem: citations of a rolled-back version', () => {
  // v1 at T0, v2 at T0+10h, Foreman rolls v2 back at T0+20h; v1 is in force again after.
  const ledger = [add('L-1', T0), update('L-1', 2, T0 + 10 * HOUR), pop('L-1', 1, T0 + 20 * HOUR)];
  const cite = (story, at) => ({ ...finding(story, at), observed: 'the learned rule [L-1] got in the way' });
  const runs = [...BASELINE, ...windowRuns(3)];
  const now = T0 + 22 * HOUR;

  it('16. a citation made under a rolled-back v2 does not roll back v1', () => {
    const findings = [...FINDINGS, cite('S-301', T0 + 12 * HOUR)];
    expect(evalAll({ ledger, runs, findings, now })).toEqual([]);
    expect(evalOne({ ledger, runs, findings, now }).decision).toBeNull();
  });

  it('16b. a citation after the rollback, with v1 back, still rolls v1 back', () => {
    const r = evalOne({ ledger, runs, findings: [...FINDINGS, cite('S-301', T0 + 12 * HOUR), cite('S-401', T0 + 21 * HOUR)], now });
    expect(r.v).toBe(1);
    expect(r.decision).toBe('rollback');
    expect(r.reason).toBe('[L-1] was named in a finding on S-401');
  });

  it('16c. a citation while v1 was first in force still counts', () => {
    const r = evalOne({ ledger, runs, findings: [...FINDINGS, cite('S-205', T0 + 5 * HOUR)], now });
    expect(r.decision).toBe('rollback');
    expect(r.reason).toBe('[L-1] was named in a finding on S-205');
  });

  it('16d. an owner undo of v2 is not a Foreman rollback', () => {
    const undone = [add('L-1', T0), update('L-1', 2, T0 + 10 * HOUR), pop('L-1', 1, T0 + 20 * HOUR, { action: 'undo', by: 'owner' })];
    const r = evalOne({ ledger: undone, runs, findings: [...FINDINGS, cite('S-301', T0 + 12 * HOUR)], now });
    expect(r.decision).toBe('rollback');
    expect(r.reason).toBe('[L-1] was named in a finding on S-301');
  });

  it('16e. a citation at the instant of the rollback counts against v1 (the window is half-open)', () => {
    const r = evalOne({ ledger, runs, findings: [...FINDINGS, cite('S-401', T0 + 20 * HOUR)], now });
    expect(r.decision).toBe('rollback');
    expect(r.reason).toBe('[L-1] was named in a finding on S-401');
  });

  it('16f. another item rolled back at the time does not shield a citation of [L-1]', () => {
    // L-1 is at v2 and L-2's rolled-back version is v1, so only the id tells them apart.
    const other = [add('L-1', T0 - HOUR), update('L-1', 2, T0), add('L-2', T0 + 10 * HOUR, { roles: ['tester'], key: 'f-000000000002' }), pop('L-2', 0, T0 + 20 * HOUR, { roles: ['tester'] })];
    expect(rolledBack(other)).toEqual([{ id: 'L-2', v: 1, from: iso(T0 + 10 * HOUR), to: iso(T0 + 20 * HOUR), sourceKey: 'f-000000000002' }]);
    const r = evalOne({ ledger: other, runs, findings: [...FINDINGS, cite('S-301', T0 + 12 * HOUR)], now });
    expect(r.decision).toBe('rollback');
    expect(r.reason).toBe('[L-1] was named in a finding on S-301');
  });
});

describe('evaluate: overlaps', () => {
  const both = [add('L-1', T0), add('L-2', T0 + HOUR, { roles: ['tester'], key: 'f-000000000002' })];
  const bad = Array.from({ length: 5 }, (_, i) => run(`S-${201 + i}`, T0 + (2 + i) * HOUR, { learned: ['L-1', 'L-2'], rounds: 2 }));

  it('12. with shared bad runs the newest is rolled back first; then the older one skips them', () => {
    expect(evalOne({ ledger: both, runs: [...BASELINE, ...bad] }).decision).toBe('rollback');
    const r = evalAll({ ledger: both, runs: [...BASELINE, ...bad] });
    expect(r.map((x) => [x.id, x.decision])).toEqual([['L-2', 'rollback']]);

    const later = [...both, pop('L-2', 0, T0 + 10 * HOUR, { roles: ['tester'] })];
    expect(rolledBack(later)).toEqual([{ id: 'L-2', v: 1, from: iso(T0 + HOUR), to: iso(T0 + 10 * HOUR), sourceKey: 'f-000000000002' }]);
    const l1 = evalOne({ ledger: later, runs: [...BASELINE, ...bad], now: T0 + 11 * HOUR });
    expect(l1.metrics.window.runs).toBe(0);
    expect(l1.decision).toBeNull();
    expect(evalAll({ ledger: later, runs: [...BASELINE, ...bad], now: T0 + 11 * HOUR })).toEqual([]);
  });

  it('orders newest change first, ties by the higher L number', () => {
    const same = [add('L-1', T0), add('L-2', T0, { roles: ['tester'], key: 'f-000000000002' }), add('L-3', T0 - HOUR, { roles: ['architect'], key: 'f-000000000003' })];
    const runs = Array.from({ length: 5 }, (_, i) => run(`S-${201 + i}`, T0 + (1 + i) * HOUR, { learned: ['L-1', 'L-2', 'L-3'] }));
    expect(evalAll({ ledger: same, runs: [...BASELINE, ...runs] }).map((x) => x.id)).toEqual(['L-2', 'L-1', 'L-3']);
  });

  it('a retire does not hold back an older keep', () => {
    const findings = [...FINDINGS, finding('S-203', T0 + 4 * HOUR + 60 * 1000), finding('S-204', T0 + 5 * HOUR + 60 * 1000)];
    const ledger = [add('L-1', T0, { roles: ['tester'], key: 'f-000000000002' }), add('L-2', T0 + HOUR)];
    const r = evalAll({ ledger, runs: [...BASELINE, ...bad.map((b) => ({ ...b, rounds: 1 }))], findings });
    expect(r.map((x) => [x.id, x.decision])).toEqual([['L-2', 'retire'], ['L-1', 'keep']]);
  });
});

describe('evaluate: what is evaluated', () => {
  it('13. a kept item and a removed item are not evaluated', () => {
    const rounds = [2, 2, 2, 2, 2];
    const runs = [...BASELINE, ...windowRuns(5, (i) => ({ rounds: rounds[i] }), ['L-1', 'L-2'])];
    const ledger = [add('L-1', T0), keep('L-1', 1, T0 + 1), add('L-2', T0, { roles: ['tester'] }), pop('L-2', 0, T0 + 2, { action: 'undo', by: 'owner', roles: ['tester'] })];
    expect(evalAll({ ledger, runs })).toEqual([]);
  });
});

describe('evaluateItem: targets', () => {
  it('14a. an n- target is the cluster whose not-fixed key it is', () => {
    const fixtures = [finding('S-1', T0 - 5 * DAY, { round: 1 }), finding('S-1', T0 - 5 * DAY, { round: 2 })];
    const nKey = notFixedKey(clusterFindings(fixtures)[0].key, 'S-1');
    const ledger = [add('L-1', T0, { key: nKey, stories: ['S-1'] })];
    const findings = [...fixtures, finding('S-201', T0 + HOUR + 60 * 1000), finding('S-202', T0 + 2 * HOUR + 60 * 1000)];
    const r = evalOne({ ledger, runs: [...BASELINE, ...windowRuns(5)], findings });
    expect(r.metrics.window.target).toBe(2);
    expect(r.decision).toBe('retire');
  });

  it('14b. an r- target counts failed runs', () => {
    const ledger = [add('L-1', T0, { key: 'r-0123456789ab', stories: ['S-9'] })];
    const r = evalOne({ ledger, runs: [...BASELINE, ...windowRuns(5, (i) => ({ result: i === 2 ? 'failed' : 'shipped' }))] });
    expect(r.metrics.window.target).toBe(1);
    expect(r.metrics.baseline.target).toBe(0);
    expect(r.decision).toBe('rollback');
  });

  it('14c. an unknown source has no target and never retires', () => {
    const ledger = [add('L-1', T0, { key: 'a-0123456789ab', stories: ['S-9'] })];
    const findings = [...FINDINGS, finding('S-201', T0 + HOUR + 60 * 1000), finding('S-202', T0 + 2 * HOUR + 60 * 1000)];
    const r = evalOne({ ledger, runs: [...BASELINE, ...windowRuns(5)], findings });
    expect(r.metrics.window.target).toBeNull();
    expect(r.metrics.baseline.target).toBeNull();
    expect(r.decision).toBe('keep');
    const none = evalOne({ ledger: [add('L-1', T0, { key: null })], runs: [...BASELINE, ...windowRuns(5)], findings });
    expect(none.metrics.window.target).toBeNull();
    expect(none.decision).toBe('keep');
  });

  it('14d. an unmeasurable target never counts as dropped', () => {
    const ledger = [add('L-1', T0, { key: 'a-0123456789ab', stories: ['S-9'] })];
    const r = evalOne({ ledger, runs: [...BASELINE, ...windowRuns(5, () => ({ rounds: 2 }))] });
    expect(r.decision).toBe('rollback');
  });
});

describe('rolledBack and rolledBackKeys', () => {
  it('15. hold the source key after a foreman rollback, not after an owner undo', () => {
    expect(rolledBackKeys([add('L-1', T0), pop('L-1', 0, T0 + HOUR)])).toEqual(new Set([KEY]));
    expect(rolledBackKeys([add('L-1', T0), pop('L-1', 0, T0 + HOUR, { action: 'undo', by: 'owner' })])).toEqual(new Set());
  });

  it('a retire is in rolledBackKeys but not in rolledBack', () => {
    const ledger = [add('L-1', T0), pop('L-1', 0, T0 + HOUR, { decision: 'retire' })];
    expect(rolledBack(ledger)).toEqual([]);
    expect(rolledBackKeys(ledger)).toEqual(new Set([KEY]));
  });

  it('a rollback of v2 names v2, its update time and its source key', () => {
    const ledger = [add('L-1', T0), update('L-1', 2, T0 + HOUR, { key: 'f-00000000000b' }), pop('L-1', 1, T0 + 2 * HOUR)];
    expect(rolledBack(ledger)).toEqual([{ id: 'L-1', v: 2, from: iso(T0 + HOUR), to: iso(T0 + 2 * HOUR), sourceKey: 'f-00000000000b' }]);
  });
});
