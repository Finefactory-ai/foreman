import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { environmentTotals, learnedOf, modelTotals, readFindingsLines, readRuns, runFile, runRecord, stageMinutes, summarise, watchdogTotals, writeRun } from './run-record.mjs';
import { stageMap } from './state.mjs';

const at = (min) => new Date(Date.UTC(2026, 9, 15, 9, 0) + min * 60000);
const iso = (min) => at(min).toISOString();
const STAGES = stageMap(null);

describe('stageMinutes', () => {
  it('adds up the time each stage had an agent running, overlaps counted once', () => {
    const spans = [
      { role: 'architect', since: iso(0), until: iso(5) },
      { role: 'builder', since: iso(5), until: iso(20) },
      { role: 'tester', since: iso(20), until: iso(26) },
      // two reviewers side by side: 10 minutes of review, not 18
      { role: 'compliance-reviewer', since: iso(26), until: iso(36) },
      { role: 'security-reviewer', since: iso(28), until: iso(34) },
      { role: 'builder', since: iso(36), until: iso(40.5) },
      // not a stage: the foreman itself and anything unknown
      { role: 'foreman', since: iso(0), until: iso(45) },
      { role: 'mystery', since: iso(0), until: iso(45) },
    ];
    expect(stageMinutes(spans, STAGES)).toEqual({ architect: 5, build: 19.5, test: 6, review: 10 });
  });

  it('knows plugin-prefixed agent names and ignores broken spans', () => {
    const spans = [
      { role: 'foreman:tester', since: iso(0), until: iso(3) },
      { role: 'tester', since: 'not a date', until: iso(3) },
      { role: 'tester', since: iso(5), until: iso(4) },
    ];
    expect(stageMinutes(spans, STAGES)).toEqual({ architect: 0, build: 0, test: 3, review: 0 });
  });

  it('keeps spans inside the session', () => {
    const spans = [{ role: 'architect', since: iso(-10), until: iso(4) }];
    expect(stageMinutes(spans, STAGES, { from: at(0), to: at(60) }).architect).toBe(4);
  });
});

describe('runRecord', () => {
  it('builds one session\'s record', () => {
    const record = runRecord({
      story: 'S-1',
      slot: 'w2',
      result: 'shipped',
      log: { costUsd: 2.5, turns: 14, durationMs: 1800000 },
      startedAt: at(0),
      endedAt: at(45.04),
      rounds: 2,
      spans: [{ role: 'architect', since: iso(1), until: iso(4) }],
      stages: STAGES,
    });
    expect(record).toEqual({
      story: 'S-1',
      slot: 'w2',
      result: 'shipped',
      costUsd: 2.5,
      turns: 14,
      firstTurnTokens: null,
      minutes: 45,
      rounds: 2,
      serious: 0,
      learned: [],
      stages: { architect: 3, build: 0, test: 0, review: 0 },
      agents: null,
      startedAt: iso(0),
      endedAt: iso(45.04),
    });
  });

  it('carries an environment cause, and nothing else', () => {
    const base = { story: 'S-3', slot: 'w1', result: 'failed', log: {}, startedAt: at(0), endedAt: at(3), stages: STAGES };
    expect(runRecord({ ...base, cause: 'environment' })).toMatchObject({ cause: 'environment' });
    expect(runRecord(base)).not.toHaveProperty('cause');
    expect(runRecord({ ...base, cause: 'story' })).not.toHaveProperty('cause');
    expect(runRecord({ ...base, cause: 'banana' })).not.toHaveProperty('cause');
  });

  it('leaves cost and turns empty when the session never reported them', () => {
    const record = runRecord({ story: 'S-2', slot: 'w1', result: 'crashed', log: { costUsd: null, turns: null }, startedAt: at(0), endedAt: at(3), stages: STAGES });
    expect(record).toMatchObject({ costUsd: null, turns: null, minutes: 3, rounds: 0, stages: { architect: 0, build: 0, test: 0, review: 0 } });
  });

  it("copies the first turn's context size from the log", () => {
    const base = { story: 'S-3', slot: 'w1', result: 'shipped', startedAt: at(0), endedAt: at(3), stages: STAGES };
    expect(runRecord({ ...base, log: { firstTurnTokens: 21100 } }).firstTurnTokens).toBe(21100);
    expect(runRecord({ ...base, log: {} }).firstTurnTokens).toBeNull();
    expect(runRecord(base).firstTurnTokens).toBeNull();
  });
});

describe('runRecord: tokens per agent', () => {
  const base = { story: 'S-1', slot: 'w1', result: 'shipped', startedAt: at(0), endedAt: at(30), stages: STAGES };
  const agents = [
    { role: 'architect', name: 'architect', agent: 'foreman:architect', model: 'claude-opus-5-5', input: 10, output: 20, cacheRead: 3000, cacheWrite: 400, turns: 4, round: null },
    { role: 'orchestration', name: 'orchestration', agent: null, model: 'claude-opus-5-5', input: 5, output: 6, cacheRead: 700, cacheWrite: 80, turns: 9, round: null },
  ];

  it('keeps the agents it is given', () => {
    expect(runRecord({ ...base, agents }).agents).toEqual(agents);
  });

  it('writes agents: null when they are unknown', () => {
    expect(runRecord(base).agents).toBeNull();
    expect(runRecord({ ...base, agents: null }).agents).toBeNull();
    expect(runRecord({ ...base, agents: 'x' }).agents).toBeNull();
  });

  it('round-trips through the runs folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreman-runs-agents-'));
    try {
      writeRun(dir, runRecord({ ...base, agents }));
      writeRun(dir, runRecord({ ...base, story: 'S-2' }));
      const [one, two] = readRuns(dir);
      expect(one.agents).toEqual(agents);
      expect(two.agents).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runRecord: the learned items', () => {
  const base = { story: 'S-1', slot: 'w1', result: 'shipped', startedAt: at(0), endedAt: at(30), stages: STAGES };

  it('keeps the ids sorted and once each, drops non-strings, and puts learned right after serious', () => {
    const record = runRecord({ ...base, learned: ['L-2', 'L-1', 'L-2', 7] });
    expect(record.learned).toEqual(['L-1', 'L-2']);
    const keys = Object.keys(record);
    expect(keys[keys.indexOf('serious') + 1]).toBe('learned');
    expect(runRecord(base).learned).toEqual([]);
  });

  it('sorts L-10 after L-9', () => {
    expect(runRecord({ ...base, learned: ['L-10', 'L-9'] }).learned).toEqual(['L-9', 'L-10']);
  });
});

describe('learnedOf', () => {
  it('prefers the ended story, then the story the slot held, then nothing', () => {
    const slotBefore = { story: { id: 'S-1', learned: ['L-4'] } };
    expect(learnedOf(slotBefore, { id: 'S-1', learned: ['L-3', 'L-1', 'L-3'] })).toEqual(['L-1', 'L-3']);
    expect(learnedOf(slotBefore, { id: 'S-1' })).toEqual(['L-4']);
    expect(learnedOf(slotBefore, null)).toEqual(['L-4']);
    expect(learnedOf(null, null)).toEqual([]);
    expect(learnedOf({ story: null }, undefined)).toEqual([]);
  });
});

describe('runRecord: serious findings', () => {
  const line = (story, severity, min, extra = {}) => ({ at: min === undefined ? undefined : iso(min), story, result: 'shipped', stage: 'tester', severity, rule: 'r', ...extra });
  const base = { story: 'S-1', slot: 'w1', result: 'shipped', startedAt: at(0), endedAt: at(30), stages: STAGES };

  it('counts serious findings of this story in this session', () => {
    const findings = [
      line('S-1', 'blocker', 0, { round: 1, resolved: true }),
      line('S-1', 'major', 10),
      line('S-1', 'minor', 10),
      line('S-1', 'MAJOR', 30),
      line('S-1', 'blocker', -1),
      line('S-1', 'major', 31),
      line('S-2', 'blocker', 10),
      line('S-1', 'blocker', undefined),
      line('S-1', 'blocker', 0, { at: 'not a date' }),
    ];
    expect(runRecord({ ...base, findings }).serious).toBe(3);
  });

  it('serious is 0 with no findings', () => {
    expect(runRecord(base).serious).toBe(0);
    expect(runRecord({ ...base, findings: [] }).serious).toBe(0);
  });

  it('puts serious right after rounds', () => {
    const keys = Object.keys(runRecord(base));
    expect(keys[keys.indexOf('rounds') + 1]).toBe('serious');
  });
});

describe('readFindingsLines', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-findings-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('gives [] when there is no findings file', () => {
    expect(readFindingsLines(dir)).toEqual([]);
    expect(readFindingsLines(join(dir, 'nowhere'))).toEqual([]);
  });

  it('reads the JSON lines and skips a torn one', () => {
    writeFileSync(join(dir, 'findings.jsonl'), '{"story":"S-1","severity":"major"}\n{"story":"S-1","sev\n{"story":"S-2","severity":"minor"}\n');
    expect(readFindingsLines(dir)).toEqual([
      { story: 'S-1', severity: 'major' },
      { story: 'S-2', severity: 'minor' },
    ]);
  });
});

describe('the runs folder', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-runs-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('names a record after its story and start time', () => {
    expect(runFile('/s', { story: 'P4-04', startedAt: '2026-10-15T09:08:07.123Z' })).toBe('/s/runs/P4-04-20261015-090807.json');
    expect(runFile('/s', { story: '../../etc', startedAt: '2026-10-15T09:08:07Z' })).toBe('/s/runs/etc-20261015-090807.json');
  });

  it('writes records and reads them back, skipping what is not one', () => {
    writeRun(dir, { story: 'S-1', result: 'shipped', startedAt: iso(0), endedAt: iso(10), costUsd: 1, minutes: 10 });
    writeRun(dir, { story: 'S-2', result: 'failed', startedAt: iso(20), endedAt: iso(30), costUsd: 2, minutes: 10 });
    writeFileSync(join(dir, 'runs', 'broken.json'), '{');
    mkdirSync(join(dir, 'runs', 'folder.json'));
    expect(readdirSync(join(dir, 'runs'))).toHaveLength(4);
    expect(readRuns(dir).map((r) => r.story)).toEqual(['S-1', 'S-2']);
    expect(readRuns(join(dir, 'nowhere'))).toEqual([]);
  });
});

describe('summarise', () => {
  const runs = [
    { story: 'S-1', result: 'rate-limit', startedAt: '2026-10-14T22:00:00Z', endedAt: '2026-10-14T22:05:00Z', costUsd: 0.4, minutes: 5 },
    { story: 'S-1', result: 'shipped', startedAt: '2026-10-15T08:00:00Z', endedAt: '2026-10-15T08:40:00Z', costUsd: 2.6, minutes: 40 },
    { story: 'S-2', result: 'failed', startedAt: '2026-10-15T09:00:00Z', endedAt: '2026-10-15T10:00:00Z', costUsd: null, minutes: 60 },
  ];

  it('totals per day (UTC, by end) and per result', () => {
    const s = summarise(runs);
    expect(s.days).toEqual([
      { day: '2026-10-14', sessions: 1, stories: 1, shipped: 0, costUsd: 0.4, minutes: 5, firstTurnTokens: null },
      { day: '2026-10-15', sessions: 2, stories: 2, shipped: 1, costUsd: 2.6, minutes: 100, firstTurnTokens: null },
    ]);
    expect(s.results).toEqual([
      { result: 'shipped', sessions: 1, costUsd: 2.6, minutes: 40, firstTurnTokens: null },
      { result: 'failed', sessions: 1, costUsd: 0, minutes: 60, firstTurnTokens: null },
      { result: 'rate-limit', sessions: 1, costUsd: 0.4, minutes: 5, firstTurnTokens: null },
    ]);
    expect(s.total).toEqual({ sessions: 3, stories: 2, shipped: 1, costUsd: 3, minutes: 105, firstTurnTokens: null, unpriced: 1 });
  });

  it('starts from a day', () => {
    expect(summarise(runs, { since: '2026-10-15' }).total).toMatchObject({ sessions: 2, costUsd: 2.6 });
  });

  it("averages the first turn's context over the sessions that have it", () => {
    const sized = [
      { ...runs[1], firstTurnTokens: 20000 },
      { ...runs[2], firstTurnTokens: 24001 },
      { ...runs[2], story: 'S-3' },
      { ...runs[0], firstTurnTokens: 'big' },
    ];
    const s = summarise(sized);
    expect(s.days.map((d) => d.firstTurnTokens)).toEqual([null, 22001]);
    expect(s.total.firstTurnTokens).toBe(22001);
    expect(s.results.find((r) => r.result === 'shipped').firstTurnTokens).toBe(20000);
    expect(s.results.find((r) => r.result === 'failed').firstTurnTokens).toBe(24001);
    expect(summarise([{ ...runs[1], firstTurnTokens: 20000 }, { ...runs[1], firstTurnTokens: 24000 }, runs[2]]).total.firstTurnTokens).toBe(22000);
    expect(summarise(runs).total.firstTurnTokens).toBeNull();
  });
});

describe('runRecord: a watchdog stop', () => {
  const base = { story: 'S-1', slot: 'w1', result: 'crashed', startedAt: at(0), endedAt: at(130), stages: STAGES };
  it('adds watchdog only when given, after the other fields', () => {
    expect(Object.hasOwn(runRecord(base), 'watchdog')).toBe(false);
    const watchdog = { why: 'too-long', kept: ['architect:S-1'], redoneTokens: 1200, redoneMinutes: 12.5 };
    const record = runRecord({ ...base, watchdog });
    expect(record.watchdog).toEqual(watchdog);
    expect(Object.keys(record).at(-1)).toBe('watchdog');
  });
});

describe('watchdogTotals', () => {
  const stop = (story, day, why, redoneTokens, redoneMinutes) => ({ story, result: 'crashed', startedAt: `${day}T08:00:00Z`, endedAt: `${day}T10:00:00Z`, watchdog: { why, kept: [], redoneTokens, redoneMinutes } });
  const runs = [
    stop('S-1', '2026-10-14', 'too-long', 1000, 10),
    stop('S-1', '2026-10-15', 'ceiling', 2000, 20.25),
    stop('S-2', '2026-10-15', 'quiet', 500, 5),
    { story: 'S-3', result: 'shipped', startedAt: '2026-10-15T08:00:00Z', endedAt: '2026-10-15T09:00:00Z' },
  ];
  it('counts the stories, sessions and hard-limit stops, and sums the redone work', () => {
    expect(watchdogTotals(runs)).toEqual({ stories: 2, sessions: 3, ceiling: 1, redoneTokens: 3500, redoneMinutes: 35.3 });
  });
  it('starts from a day', () => {
    expect(watchdogTotals(runs, { since: '2026-10-15' })).toEqual({ stories: 2, sessions: 2, ceiling: 1, redoneTokens: 2500, redoneMinutes: 25.3 });
  });
  it('is all zeros with no watchdog stops', () => {
    expect(watchdogTotals([runs[3]])).toEqual({ stories: 0, sessions: 0, ceiling: 0, redoneTokens: 0, redoneMinutes: 0 });
  });
});

describe('environmentTotals', () => {
  const failed = (story, day, cause) => ({ story, result: 'failed', startedAt: `${day}T08:00:00Z`, endedAt: `${day}T10:00:00Z`, ...(cause ? { cause } : {}) });
  const runs = [
    failed('S-3', '2026-10-14', 'environment'),
    failed('S-2', '2026-10-15', 'environment'),
    failed('S-4', '2026-10-15'),
    { story: 'S-1', result: 'shipped', startedAt: '2026-10-15T08:00:00Z', endedAt: '2026-10-15T09:00:00Z' },
  ];
  it('counts the failed sessions that said the environment ended them, out of the failed ones', () => {
    expect(environmentTotals(runs)).toEqual({ sessions: 2, failed: 3, stories: ['S-2', 'S-3'] });
  });
  it('does not count a shipped record that carries the cause', () => {
    expect(environmentTotals([{ ...runs[3], cause: 'environment' }])).toEqual({ sessions: 0, failed: 0, stories: [] });
  });
  it('lists a story once and sorts the ids by number', () => {
    const more = [failed('S-10', '2026-10-15', 'environment'), failed('S-2', '2026-10-15', 'environment'), ...runs];
    expect(environmentTotals(more).stories).toEqual(['S-2', 'S-3', 'S-10']);
  });
  it('starts from a day', () => {
    expect(environmentTotals(runs, { since: '2026-10-15' })).toEqual({ sessions: 1, failed: 2, stories: ['S-2'] });
  });
  it('is all zeros with no records', () => {
    expect(environmentTotals([])).toEqual({ sessions: 0, failed: 0, stories: [] });
  });
});

describe('the header of run-record.mjs', () => {
  // the header wraps its lines: read it as running text
  const text = readFileSync(new URL('./run-record.mjs', import.meta.url), 'utf8').replace(/\n\/\/ ?/g, ' ');
  it('keeps the cost sentence in one piece, once', () => {
    const sentence = "`costUsd` and `turns` come from the session's final stream-json event and are null when it never got there.";
    expect(text.split(sentence).length - 1).toBe(1);
    expect(text.split("`costUsd` and `turns` come from the session's").length - 1).toBe(1);
  });
});

describe('runRecord: agents that ran on another model than set', () => {
  const base = { story: 'ACME-1', slot: 'w1', result: 'shipped', startedAt: at(0), endedAt: at(30), stages: STAGES };
  const m = { role: 'tester', name: 'test', agent: 'foreman:tester', set: 'haiku', ran: 'claude-opus-5-5', text: 'test (foreman:tester) is set to Haiku but ran on Opus 5.5' };
  it('carries modelMismatches when there are some', () => {
    expect(runRecord({ ...base, modelMismatches: [m] }).modelMismatches).toEqual([m]);
  });
  it('keeps the old shape with none', () => {
    expect('modelMismatches' in runRecord({ ...base, modelMismatches: [] })).toBe(false);
    expect('modelMismatches' in runRecord({ ...base, modelMismatches: undefined })).toBe(false);
    expect('modelMismatches' in runRecord({ ...base, modelMismatches: 'x' })).toBe(false);
    expect('modelMismatches' in runRecord(base)).toBe(false);
  });
});

describe('modelTotals', () => {
  const m = (name) => ({ role: 'tester', name, agent: 'foreman:tester', set: 'haiku', ran: 'claude-opus-5-5', text: `${name} (foreman:tester) is set to Haiku but ran on Opus 5.5` });
  const run = (story, day, modelMismatches) => ({ story, result: 'shipped', startedAt: `${day}T08:00:00Z`, endedAt: `${day}T10:00:00Z`, ...(modelMismatches ? { modelMismatches } : {}) });
  const runs = [run('ACME-1', '2026-10-14', [m('test')]), run('ACME-2', '2026-10-15', [m('test'), m('fix')]), run('ACME-3', '2026-10-15')];
  it('lists the mismatches, newest record first', () => {
    expect(modelTotals(runs).map((e) => [e.story, e.name])).toEqual([['ACME-2', 'test'], ['ACME-2', 'fix'], ['ACME-1', 'test']]);
    expect(modelTotals(runs)[0]).toEqual({ story: 'ACME-2', endedAt: '2026-10-15T10:00:00.000Z', ...m('test') });
  });
  it('starts from a day', () => {
    expect(modelTotals(runs, { since: '2026-10-15' }).map((e) => e.story)).toEqual(['ACME-2', 'ACME-2']);
    expect(modelTotals(runs, { since: '2026-10-16' })).toEqual([]);
  });
  it('drops entries whose text is not a string, and records without mismatches', () => {
    expect(modelTotals([run('ACME-1', '2026-10-14', [{ ...m('test'), text: 5 }, m('fix')]), run('ACME-2', '2026-10-14', [])]).map((e) => e.name)).toEqual(['fix']);
  });
  it('is empty for no runs', () => {
    expect(modelTotals([])).toEqual([]);
  });
});
