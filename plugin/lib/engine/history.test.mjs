import { describe, expect, it } from 'vitest';
import { historyView } from './history.mjs';

// The clock is 2026-10-15T09:00Z, a Thursday.
const NOW = Date.parse('2026-10-15T09:00:00Z');
const run = (story, result, endedAt, extra = {}) => ({ story, result, endedAt, startedAt: endedAt, costUsd: 1, minutes: 30, rounds: 1, stages: { architect: 5, build: 10, test: 5, review: 10 }, ...extra });

describe('historyView', () => {
  it('counts each day from the first record to today: shipped, not shipped, and the cost', () => {
    const v = historyView([
      run('S-1', 'shipped', '2026-10-13T10:00:00Z', { costUsd: 2.5 }),
      run('S-2', 'failed', '2026-10-13T23:30:00Z', { costUsd: 1.25 }),
      run('S-3', 'shipped', '2026-10-15T08:00:00Z', { costUsd: 3 }),
    ], { now: NOW });
    expect(v.days).toEqual([
      { day: '2026-10-13', shipped: 1, notShipped: 1, costUsd: 3.75 },
      { day: '2026-10-14', shipped: 0, notShipped: 0, costUsd: 0 },
      { day: '2026-10-15', shipped: 1, notShipped: 0, costUsd: 3 },
    ]);
    expect(v.since).toBe('2026-10-13T10:00:00Z');
    expect(v.total).toBe(3);
  });

  it('shows at most 14 days, ending today', () => {
    const v = historyView([run('S-1', 'shipped', '2026-09-01T10:00:00Z'), run('S-2', 'shipped', '2026-10-15T07:00:00Z')], { now: NOW });
    expect(v.days).toHaveLength(14);
    expect(v.days[0].day).toBe('2026-10-02');
    expect(v.days.at(-1)).toEqual({ day: '2026-10-15', shipped: 1, notShipped: 0, costUsd: 1 });
  });

  it('sums the last 7 days: shipped of finished, spend, typical time, first-try share and minutes per stage', () => {
    const v = historyView([
      run('S-0', 'shipped', '2026-10-01T10:00:00Z', { minutes: 999 }), // older than 7 days: not counted
      run('S-1', 'shipped', '2026-10-10T10:00:00Z', { minutes: 20, rounds: 1, costUsd: 2, stages: { architect: 4, build: 8, test: 4, review: 4 } }),
      run('S-2', 'shipped', '2026-10-12T10:00:00Z', { minutes: 40, rounds: 2, costUsd: 4, stages: { architect: 6, build: 20, test: 8, review: 6 } }),
      run('S-3', 'shipped', '2026-10-14T10:00:00Z', { minutes: 30, rounds: 1, costUsd: 3, stages: { build: 14 } }),
      run('S-4', 'blocked', '2026-10-14T11:00:00Z', { minutes: 5, costUsd: 0.5 }),
    ], { now: NOW });
    expect(v.week).toEqual({
      finished: 4,
      shipped: 3,
      costUsd: 9.5,
      medianMinutes: 30,
      firstTry: 2,
      // averages over the shipped stories, a missing stage counting as none
      stages: { architect: (4 + 6) / 3, build: (8 + 20 + 14) / 3, test: (4 + 8) / 3, review: (4 + 6) / 3 },
    });
  });

  it('is empty with no records, and skips records with no end', () => {
    const v = historyView([{ story: 'S-1', result: 'shipped' }, null], { now: NOW });
    expect(v).toEqual({ since: null, total: 0, days: [{ day: '2026-10-15', shipped: 0, notShipped: 0, costUsd: 0 }], week: { finished: 0, shipped: 0, costUsd: 0, medianMinutes: null, firstTry: 0, stages: { architect: 0, build: 0, test: 0, review: 0 } },
      tokensPerStory: { agents: [], overall: { shipped: 0, average: null, agents: {} }, days: [{ day: '2026-10-15', shipped: 0, average: null, agents: {} }] } });
  });

  it('reads a cost or minutes that is not a number as none', () => {
    const v = historyView([run('S-1', 'shipped', '2026-10-15T08:00:00Z', { costUsd: 'lots', minutes: null })], { now: NOW });
    expect(v.days.at(-1).costUsd).toBe(0);
    expect(v.week.medianMinutes).toBe(null);
  });
});

describe('historyView tokensPerStory', () => {
  // One agent row: `n` tokens split over the four counts, all of which count.
  const a = (role, n, name) => ({ role, ...(name ? { name } : {}), input: n / 4, output: n / 4, cacheRead: n / 4, cacheWrite: n / 4 });

  it('divides all the tokens a day spent, failed sessions included, by the stories shipped that day', () => {
    const v = historyView([
      run('S-1', 'shipped', '2026-10-14T10:00:00Z', { agents: [a('builder', 400), a('architect', 100), a('orchestration', 40)] }),
      run('S-2', 'failed', '2026-10-14T11:00:00Z', { agents: [a('builder', 200)] }),
      run('S-3', 'shipped', '2026-10-14T12:00:00Z', { agents: [a('builder', 600), a('reviewer', 80, 'security')] }),
      run('S-4', 'shipped', '2026-10-15T08:00:00Z', { agents: [a('builder', 100), a('tester', 60)] }),
    ], { now: NOW });
    const t = v.tokensPerStory;
    expect(t.days).toEqual([
      { day: '2026-10-14', shipped: 2, average: 710, agents: { builder: 600, architect: 50, orchestration: 20, 'reviewer:security': 40 } },
      { day: '2026-10-15', shipped: 1, average: 160, agents: { builder: 100, tester: 60 } },
    ]);
    // So far: every record ever, over every shipped story.
    expect(t.overall).toEqual({ shipped: 3, average: 527, agents: { builder: 433, architect: 33, orchestration: 13, 'reviewer:security': 27, tester: 20 } });
    // The agents, biggest so far first, each with its label.
    expect(t.agents).toEqual([
      { who: 'builder', label: 'Builder' }, { who: 'architect', label: 'Architect' }, { who: 'reviewer:security', label: 'Security reviewer' },
      { who: 'tester', label: 'Tester' }, { who: 'orchestration', label: 'Story session' },
    ]);
  });

  it('has no average for a day, or so far, with nothing shipped', () => {
    const v = historyView([run('S-1', 'failed', '2026-10-15T08:00:00Z', { agents: [a('builder', 100)] })], { now: NOW });
    expect(v.tokensPerStory.days).toEqual([{ day: '2026-10-15', shipped: 0, average: null, agents: {} }]);
    expect(v.tokensPerStory.overall).toEqual({ shipped: 0, average: null, agents: {} });
  });

  it('counts the agents so far from before the days on show', () => {
    const v = historyView([
      run('S-0', 'shipped', '2026-09-01T10:00:00Z', { agents: [a('builder', 1000)] }),
      run('S-1', 'shipped', '2026-10-15T08:00:00Z', { agents: [a('builder', 200)] }),
    ], { now: NOW });
    expect(v.tokensPerStory.days).toHaveLength(14);
    expect(v.tokensPerStory.days.at(-1)).toEqual({ day: '2026-10-15', shipped: 1, average: 200, agents: { builder: 200 } });
    expect(v.tokensPerStory.overall).toEqual({ shipped: 2, average: 600, agents: { builder: 600 } });
  });

  it('leaves out a shipped story whose tokens are unknown, so it does not pull the average down', () => {
    const v = historyView([
      run('S-1', 'shipped', '2026-10-15T07:00:00Z', { agents: null }),
      run('S-2', 'shipped', '2026-10-15T08:00:00Z', { agents: [a('builder', 300)] }),
    ], { now: NOW });
    expect(v.tokensPerStory.days.at(-1)).toEqual({ day: '2026-10-15', shipped: 1, average: 300, agents: { builder: 300 } });
    expect(v.tokensPerStory.overall.shipped).toBe(1);
  });

  it('shows at most six agents, folding the smallest into other agents', () => {
    const agents = [a('builder', 700), a('architect', 600), a('tester', 500), a('orchestration', 400),
      a('reviewer', 300, 'security'), a('reviewer', 200, 'compliance'), a('reviewer', 100, 'sf-code')];
    const v = historyView([run('S-1', 'shipped', '2026-10-15T08:00:00Z', { agents })], { now: NOW });
    const t = v.tokensPerStory;
    expect(t.agents.map((x) => x.label)).toEqual(['Builder', 'Architect', 'Tester', 'Story session', 'Security reviewer', 'Other agents']);
    expect(t.overall.agents).toEqual({ builder: 700, architect: 600, tester: 500, orchestration: 400, 'reviewer:security': 300, rest: 300 });
    expect(t.days.at(-1).agents.rest).toBe(300);
    expect(t.overall.average).toBe(2800);
  });
});
