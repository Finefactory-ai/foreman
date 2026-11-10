import { describe, expect, it } from 'vitest';
import { HINTS, sparkline, STORY_ROWS, tokenLine, tokenView, units, whoOf } from './token-report.mjs';

const NOW = new Date('2026-10-24T12:00:00Z');
// An ISO time `daysAgo` UTC days before NOW's day, at `hour`.
const dayAt = (daysAgo, hour = 10) => new Date(Date.UTC(2026, 9, 24 - daysAgo, hour)).toISOString();
const row = (role, name, [input, output = 0, cacheRead = 0, cacheWrite = 0], extra = {}) => ({ role, name, agent: null, model: 'claude-opus-5-5', input, output, cacheRead, cacheWrite, turns: 1, round: null, ...extra });
const run = (story, daysAgo, agents, extra = {}) => ({ story, slot: 'w1', result: 'shipped', costUsd: 12.34, startedAt: dayAt(daysAgo, 9), endedAt: dayAt(daysAgo), agents, ...extra });
const view = (over = {}) => tokenView({ runs: [], learner: [], findings: [], now: NOW, ...over });
const role = (v, who) => v.roles.find((r) => r.who === who);

describe('units', () => {
  it('writes counts in plain units', () => {
    const cases = [[0, '0'], [850, '850'], [8_500, '8.5 k'], [85_000, '85 k'], [1_234_567, '1.2 M'], [9_800_000, '9.8 M'], [250_000_000, '250 M'], [3_400_000_000, '3.4 B']];
    for (const [n, text] of cases) expect(units(n), String(n)).toBe(text);
  });

  it('never says 1000 k, and gives 0 for nonsense', () => {
    expect(units(999_999)).toBe('1.0 M');
    expect(units(NaN)).toBe('0');
    expect(units(Infinity)).toBe('0');
    expect(units(undefined)).toBe('0');
  });
});

describe('tokenLine', () => {
  it('names each count', () => {
    expect(tokenLine({ input: 1_234_567, output: 85_000, cacheRead: 9_800_000, cacheWrite: 410_000 })).toBe('1.2 M in · 85 k out · 9.8 M cache read · 410 k cache write');
  });
});

describe('sparkline', () => {
  it('scales to the biggest day', () => {
    const values = [0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 0, 0, 0, 8];
    const s = sparkline(values);
    expect([...s]).toHaveLength(14);
    expect([...s][13]).toBe('█');
    expect([...s][9]).toBe('█');
    expect([...s][0]).toBe('▁');
    expect(sparkline(new Array(14).fill(0))).toBe('▁'.repeat(14));
  });
});

describe('whoOf', () => {
  it('splits reviewers by name and keeps everyone else by role', () => {
    expect(whoOf(row('reviewer', 'security', [1]))).toEqual({ who: 'reviewer:security', label: 'security reviewer' });
    expect(whoOf(row('builder', 'fix', [1]))).toEqual({ who: 'builder', label: 'builder' });
    expect(whoOf(row('orchestration', 'orchestration', [1]))).toEqual({ who: 'orchestration', label: 'the story session itself' });
    expect(whoOf({ role: 'learner' })).toEqual({ who: 'learner', label: 'learner' });
    expect(whoOf({ role: 'mystery', name: 'x' })).toEqual({ who: 'other', label: 'other' });
  });
});

describe('tokenView: per role', () => {
  const runs = [
    run('S-1', 0, [
      row('architect', 'architect', [100, 10, 1000, 100]),
      row('builder', 'build', [200, 20, 2000, 200], { round: 1 }),
      row('reviewer', 'security', [10, 1, 100, 10], { round: 1 }),
      row('reviewer', 'compliance', [20, 2, 200, 20], { round: 1 }),
      row('orchestration', 'orchestration', [1, 1, 1, 1]),
    ]),
    run('S-2', 3, [row('builder', 'build', [1000])]),
    run('S-3', 10, [row('tester', 'test', [5000])]),
    run('S-4', 20, [row('builder', 'build', [99_999])]),
  ];
  const learner = [
    { at: dayAt(0, 9), key: 'f-1', model: 'haiku', costUsd: 0.5, tokens: { input: 7, output: 0, cacheRead: 0, cacheWrite: 0, turns: 1, models: ['haiku'] } },
    { at: dayAt(2), key: 'f-2', model: 'haiku', costUsd: 0.5, tokens: null },
    { at: dayAt(2), key: 'f-3', model: 'haiku', costUsd: 0.5 },
  ];

  it('totals today, the last 7 days and this run, biggest first', () => {
    const v = view({ runs, learner, runSince: dayAt(1) });
    expect(v.roles.map((r) => r.who)).toEqual(['builder', 'architect', 'reviewer:compliance', 'reviewer:security', 'learner', 'orchestration', 'tester']);
    const builder = role(v, 'builder');
    expect(builder.label).toBe('builder');
    expect(builder.today).toEqual({ input: 200, output: 20, cacheRead: 2000, cacheWrite: 200, turns: 1, total: 2420 });
    expect(builder.week.total).toBe(3420);
    expect(builder.run.total).toBe(2420);
    expect(builder.todayText).toBe('2.4 k');
    expect(builder.weekText).toBe('3.4 k');
    expect(builder.runText).toBe('2.4 k');
    expect(builder.weekLine).toBe('1.2 k in · 20 out · 2.0 k cache read · 200 cache write');
    expect(role(v, 'learner').today.total).toBe(7);
    expect(role(v, 'learner').run.total).toBe(7);
    expect(role(v, 'reviewer:security').label).toBe('security reviewer');
    expect(role(v, 'tester').week.total).toBe(0);
  });

  it('draws 14 days oldest first, leaving out older runs', () => {
    const v = view({ runs, learner, runSince: dayAt(1) });
    const spark = role(v, 'builder').spark;
    expect(spark).toHaveLength(14);
    expect(spark[13]).toBe(2420);
    expect(spark[10]).toBe(1000);
    expect(spark.reduce((a, b) => a + b, 0)).toBe(3420);
    expect(role(v, 'tester').spark[3]).toBe(5000);
    expect(role(v, 'builder').sparkText).toBe(sparkline(spark));
  });

  it('has zeros for this run when the run has no start', () => {
    expect(role(view({ runs }), 'builder').run.total).toBe(0);
  });

  it('drops what ended before --since', () => {
    const v = view({ runs, learner, since: '2026-10-20' });
    expect(role(v, 'tester')).toBeUndefined();
    expect(role(v, 'builder').week.total).toBe(3420);
    expect(view({ runs, learner, since: '2026-10-25' }).empty).toBe(true);
  });
});

describe('tokenView: models', () => {
  const runs = () => [
    run('S-1', 1, [row('architect', 'architect', [100], { model: 'claude-opus-4-1' }), row('tester', 'test', [50], { model: 'claude-haiku-4-5' }), row('builder', 'build', [80], { model: null })]),
    run('S-2', 0, [row('tester', 'test', [60], { model: 'claude-haiku-4-5' }), row('builder', 'build', [90], { model: 'claude-sonnet-4-5' }), row('builder', 'fix', [10], { model: 'claude-opus-4-1' })]),
  ];

  it('gives each role the distinct models its sessions recorded, sorted', () => {
    const v = view({ runs: runs() });
    expect(role(v, 'tester')).toMatchObject({ models: ['claude-haiku-4-5'], modelsText: 'claude-haiku-4-5' });
    expect(role(v, 'architect')).toMatchObject({ models: ['claude-opus-4-1'], modelsText: 'claude-opus-4-1' });
    expect(role(v, 'builder')).toMatchObject({ models: ['claude-opus-4-1', 'claude-sonnet-4-5'], modelsText: 'claude-opus-4-1, claude-sonnet-4-5' });
  });

  it("gives each story agent the models of that story's sessions", () => {
    const v = view({ runs: runs() });
    const s1 = v.stories.find((s) => s.story === 'S-1');
    expect(s1.agents.find((a) => a.who === 'tester')).toMatchObject({ models: ['claude-haiku-4-5'], modelsText: 'claude-haiku-4-5' });
    expect(s1.agents.find((a) => a.who === 'builder')).toMatchObject({ models: [], modelsText: '' });
  });

  it("gives a role only the models of the last 7 days, as its week line, and a story agent its story's", () => {
    const v = view({
      runs: [
        run('S-1', 10, [row('tester', 'test', [50], { model: 'claude-opus-4-1' })]),
        run('S-2', 0, [row('tester', 'test', [60], { model: 'claude-haiku-4-5' })]),
        run('S-3', 9, [row('architect', 'architect', [5], { model: 'claude-sonnet-4-5' })]),
      ],
    });
    const tester = role(v, 'tester');
    expect(tester).toMatchObject({ models: ['claude-haiku-4-5'], modelsText: 'claude-haiku-4-5' });
    expect(tester.spark.reduce((a, b) => a + b, 0)).toBe(110);
    const architect = role(v, 'architect');
    expect(architect).toMatchObject({ models: [], modelsText: '' });
    expect(architect.week.total).toBe(0);
    const s1 = v.stories.find((s) => s.story === 'S-1');
    expect(s1.agents.find((a) => a.who === 'tester')).toMatchObject({ models: ['claude-opus-4-1'], modelsText: 'claude-opus-4-1' });
  });

  it('gives an empty modelsText to rows without a model, and to the learner', () => {
    const v = view({
      runs: [run('S-1', 0, [row('tester', 'test', [50], { model: undefined }), row('architect', 'architect', [5], { model: 7 })])],
      learner: [{ at: dayAt(0, 9), key: 'f-1', model: 'haiku', costUsd: 0.5, tokens: { input: 7, output: 0, cacheRead: 0, cacheWrite: 0, turns: 1 } }],
    });
    for (const who of ['tester', 'architect', 'learner']) expect(role(v, who), who).toMatchObject({ models: [], modelsText: '' });
    expect(v.stories[0].agents.map((a) => a.modelsText)).toEqual(['', '']);
  });
});

describe('tokenView: per story', () => {
  it('sums the sessions of a story, biggest agents and stories first', () => {
    const runs = [
      run('S-1', 2, [row('architect', 'architect', [1210]), row('builder', 'build', [2420]), row('reviewer', 'security', [121])]),
      run('S-1', 1, [row('builder', 'fix', [100], { round: 2 }), row('orchestration', 'orchestration', [4])]),
      run('S-2', 0, [row('builder', 'build', [9000])]),
      run('S-3', 15, [row('builder', 'build', [99_000])]),
    ];
    const v = view({ runs });
    expect(v.stories.map((s) => s.story)).toEqual(['S-2', 'S-1']);
    const s1 = v.stories[1];
    expect(s1.total).toBe(3855);
    expect(s1.totalText).toBe('3.9 k');
    expect(s1.endedAt).toBe(dayAt(1));
    expect(s1.agents.map((a) => [a.who, a.total])).toEqual([['builder', 2520], ['architect', 1210], ['reviewer:security', 121], ['orchestration', 4]]);
    expect(s1.agents[0]).toMatchObject({ label: 'builder', totalText: '2.5 k', line: '2.5 k in · 0 out · 0 cache read · 0 cache write' });
  });

  it(`keeps at most ${STORY_ROWS} stories`, () => {
    const runs = Array.from({ length: 25 }, (_, i) => run(`S-${i + 1}`, 1, [row('builder', 'build', [(i + 1) * 100])]));
    const v = view({ runs });
    expect(v.stories).toHaveLength(STORY_ROWS);
    expect(v.stories[0].story).toBe('S-25');
    expect(v.stories.at(-1).story).toBe('S-6');
  });
});

describe('tokenView: unknown and empty', () => {
  it('counts sessions in the last 14 days without token counts', () => {
    const runs = [run('S-1', 0, [row('builder', 'build', [1])]), run('S-2', 1, null), run('S-3', 2, undefined), run('S-4', 30, null)];
    const v = view({ runs });
    expect(v.unknown).toBe(2);
    expect(v.empty).toBe(false);
  });

  it('is empty with no token counts at all', () => {
    expect(view()).toMatchObject({ roles: [], stories: [], hints: [], unknown: 0, empty: true });
    expect(view({ runs: [run('S-1', 0, null)], learner: [{ at: dayAt(0), tokens: null }] }).empty).toBe(true);
    expect(view({ learner: [{ at: dayAt(0), tokens: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, turns: 1 } }] }).empty).toBe(false);
  });
});

describe('tokenView: hints', () => {
  const kinds = (v) => v.hints.map((h) => h.kind);

  it('lowCache: a role reading little from the cache', () => {
    const fires = view({ runs: [run('S-1', 1, [row('builder', 'build', [600_000, 0, 400_000, 0])])] });
    expect(kinds(fires)).toEqual(['lowCache']);
    expect(fires.hints[0].text).toMatch(/builder/);
    expect(fires.hints[0].text).toMatch(/40%/);
    const half = view({ runs: [run('S-1', 1, [row('builder', 'build', [500_000, 0, 500_000, 0])])] });
    expect(kinds(half)).toEqual([]);
    const small = view({ runs: [run('S-1', 1, [row('builder', 'build', [HINTS.lowCacheMinInput - 1])])] });
    expect(kinds(small)).toEqual([]);
  });

  it('growth: tokens per story up more than half on the week before', () => {
    const weeks = (now) => [
      run('P-1', 9, [row('builder', 'build', [1000])]),
      run('P-2', 10, [row('builder', 'build', [1000])]),
      run('Q-1', 1, [row('builder', 'build', [now])]),
      run('Q-2', 2, [row('builder', 'build', [now])]),
    ];
    const fires = view({ runs: weeks(1501) });
    expect(kinds(fires)).toEqual(['growth']);
    expect(fires.hints[0].text).toMatch(/builder/);
    expect(kinds(view({ runs: weeks(1500) }))).toEqual([]);
    expect(kinds(view({ runs: weeks(5000).slice(0, 3) }))).toEqual([]);
  });

  it("fixRounds: fix rounds over half of the builder's tokens, on two stories or more", () => {
    const fires = view({ runs: [run('S-1', 1, [row('builder', 'build', [400]), row('builder', 'fix', [300], { round: 2 })]), run('S-2', 2, [row('builder', 'build', [100]), row('builder', 'fix', [301], { round: 2 })])] });
    expect(kinds(fires)).toEqual(['fixRounds']);
    expect(fires.hints[0].text).toMatch(/2 stories/);
    const half = view({ runs: [run('S-1', 1, [row('builder', 'build', [500]), row('builder', 'fix', [300], { round: 2 })]), run('S-2', 2, [row('builder', 'build', [50]), row('builder', 'fix', [250], { round: 2 })])] });
    expect(kinds(half)).toEqual([]);
    const oneStory = view({ runs: [run('S-1', 1, [row('builder', 'build', [100]), row('builder', 'fix', [900], { round: 2 })])] });
    expect(kinds(oneStory)).toEqual([]);
  });

  it('quietReviewer: a reviewer that finds nothing but costs a lot', () => {
    const stories = (n) => Array.from({ length: n }, (_, i) => run(`S-${i + 1}`, i, [row('builder', 'build', [700]), row('reviewer', 'security', [300], { round: 1 }), row('reviewer', 'compliance', [10], { round: 1 })]));
    const fires = view({ runs: stories(5), findings: [{ at: dayAt(1), story: 'S-2', stage: 'compliance', severity: 'minor' }, { at: dayAt(20), story: 'S-1', stage: 'security', severity: 'major' }] });
    expect(kinds(fires)).toEqual(['quietReviewer']);
    expect(fires.hints[0].text).toMatch(/security reviewer/);
    const found = view({ runs: stories(5), findings: [{ at: dayAt(1), story: 'S-2', stage: 'security', severity: 'minor' }] });
    expect(kinds(found)).toEqual([]);
    expect(kinds(view({ runs: stories(4) }))).toEqual([]);
  });
});

describe('tokenView: no money', () => {
  it('carries no dollar amount, even when the runs and learner lines do', () => {
    const runs = [run('S-1', 0, [row('builder', 'build', [600_000, 0, 400_000, 0])], { costUsd: 99.5 })];
    const learner = [{ at: dayAt(0), costUsd: 1.25, tokens: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, turns: 1 } }];
    const text = JSON.stringify(view({ runs, learner, runSince: dayAt(1) }));
    expect(text).not.toContain('$');
    expect(text).not.toContain('costUsd');
    expect(text).not.toContain('USD');
  });
});
