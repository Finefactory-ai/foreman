import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../main.mjs';
import { writeRun } from '../../engine/run-record.mjs';
import { recordLearnerCall } from '../../engine/learner.mjs';
import { addItem, keepItem, undoItem } from '../../engine/learning-store.mjs';

let dir;
const state = () => join(dir, '.foreman');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foreman-cli-report-'));
  writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'T' }, checks: [{ run: 'true', when: 'always' }] }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function run(argv) {
  let out = '';
  let err = '';
  const code = await main(argv, {
    cwd: dir,
    env: { FOREMAN_PROJECT_DIR: dir, FOREMAN_STATE_DIR: state() },
    now: () => new Date('2026-10-16T09:00:00Z'),
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
  });
  return { code, out, err };
}

const runs = () => {
  writeRun(state(), { story: 'S-1', slot: 'w1', result: 'rate-limit', costUsd: 0.4, turns: 3, minutes: 5, rounds: 0, startedAt: '2026-10-14T22:00:00Z', endedAt: '2026-10-14T22:05:00Z' });
  writeRun(state(), { story: 'S-1', slot: 'w1', result: 'shipped', costUsd: 2.6, turns: 30, minutes: 40, rounds: 2, startedAt: '2026-10-15T08:00:00Z', endedAt: '2026-10-15T08:40:00Z' });
  writeRun(state(), { story: 'S-2', slot: 'w2', result: 'failed', costUsd: null, turns: null, minutes: 60, rounds: 3, startedAt: '2026-10-15T09:00:00Z', endedAt: '2026-10-15T10:00:00Z' });
};

describe('foreman report', () => {
  it('prints totals per day and per result', async () => {
    runs();
    const r = await run(['report']);
    expect(r.code).toBe(0);
    const lines = r.out.split('\n');
    expect(lines[0]).toBe('Per day (UTC):');
    expect(lines.find((l) => l.includes('2026-10-14'))).toMatch(/2026-10-14\s+1 session\s+1 story\s+0 shipped\s+\$0\.40\s+5 min/);
    expect(lines.find((l) => l.includes('2026-10-15'))).toMatch(/2026-10-15\s+2 sessions\s+2 stories\s+1 shipped\s+\$2\.60\s+1 h 40 min/);
    expect(r.out).toMatch(/By result:\n\s+shipped\s+1 session\s+\$2\.60\s+40 min\n\s+failed\s+1 session\s+\$0\.00\s+60 min\n\s+rate-limit\s+1 session\s+\$0\.40\s+5 min/);
    expect(r.out).toMatch(/Total: 3 sessions, 2 stories, 1 shipped, \$3\.00, 1 h 45 min \(1 session without a cost\)\n$/);
  });

  it('starts from --since and prints JSON with --json', async () => {
    runs();
    const r = await run(['report', '--since', '2026-10-15', '--json']);
    expect(r.code).toBe(0);
    const json = JSON.parse(r.out);
    expect(json.since).toBe('2026-10-15');
    expect(json.days.map((d) => d.day)).toEqual(['2026-10-15']);
    expect(json.total).toMatchObject({ sessions: 2, costUsd: 2.6 });
  });

  it("shows the first turn's context per day and on average, only where it was recorded", async () => {
    runs();
    writeRun(state(), { story: 'S-3', slot: 'w1', result: 'shipped', costUsd: 1, turns: 9, firstTurnTokens: 20000, minutes: 10, rounds: 1, startedAt: '2026-10-16T07:00:00Z', endedAt: '2026-10-16T07:10:00Z' });
    writeRun(state(), { story: 'S-4', slot: 'w2', result: 'shipped', costUsd: 1, turns: 9, firstTurnTokens: 24000, minutes: 10, rounds: 1, startedAt: '2026-10-16T08:00:00Z', endedAt: '2026-10-16T08:10:00Z' });
    const r = await run(['report']);
    const lines = r.out.split('\n');
    expect(lines.find((l) => l.includes('2026-10-16'))).toMatch(/\$2\.00\s+20 min  first turn 22 k$/);
    expect(lines.find((l) => l.includes('2026-10-15'))).not.toContain('first turn');
    expect(lines.find((l) => l.includes('2026-10-14'))).not.toContain('first turn');
    expect(r.out).toMatch(/Total: 5 sessions, 4 stories, 3 shipped, \$5\.00, 2 h 5 min, first turn 22 k on average \(1 session without a cost\)\n/);
    const json = JSON.parse((await run(['report', '--json'])).out);
    expect(json.total.firstTurnTokens).toBe(22000);
    expect(json.days.map((d) => d.firstTurnTokens)).toEqual([null, null, 22000]);
  });

  it('shows no first turn for older records without it', async () => {
    runs();
    const r = await run(['report']);
    expect(r.out).not.toContain('first turn');
    expect(JSON.parse((await run(['report', '--json'])).out).total.firstTurnTokens).toBeNull();
  });

  it('says so when nothing is recorded', async () => {
    const r = await run(['report']);
    expect(r.code).toBe(0);
    expect(r.out).toBe('No story sessions recorded yet.\n');
    runs();
    expect((await run(['report', '--since', '2026-11-01'])).out).toBe('No story sessions recorded since 2026-11-01.\n');
  });

  it('refuses a bad date or an unknown argument with one usage line', async () => {
    for (const args of [['--since', '15/10/2026'], ['--since'], ['--weekly'], ['--tokens', '--cost']]) {
      const r = await run(['report', ...args]);
      expect(r.code).toBe(1);
      expect(r.err).toBe('usage: foreman report [--since YYYY-MM-DD] [--tokens] [--json]\n');
    }
  });
});

// Runs with tokens per agent, the clock at 2026-10-16T09:00Z.
const row = (role, name, input, extra = {}) => ({ role, name, agent: null, model: 'claude-opus-5-5', input, output: 0, cacheRead: 0, cacheWrite: 0, turns: 1, round: null, ...extra });
const tokenRuns = () => {
  writeRun(state(), { story: 'S-1', slot: 'w1', result: 'shipped', costUsd: 2, minutes: 40, rounds: 1, startedAt: '2026-10-16T07:00:00Z', endedAt: '2026-10-16T08:00:00Z', agents: [row('architect', 'architect', 600_000), row('builder', 'build', 1_200_000), row('reviewer', 'security', 40_000, { round: 1 }), row('orchestration', 'orchestration', 5_000)] });
  writeRun(state(), { story: 'S-2', slot: 'w1', result: 'shipped', costUsd: 1, minutes: 20, rounds: 1, startedAt: '2026-10-05T07:00:00Z', endedAt: '2026-10-05T08:00:00Z', agents: [row('tester', 'test', 70_000, { round: 1 })] });
  writeRun(state(), { story: 'S-3', slot: 'w2', result: 'failed', costUsd: null, minutes: 5, rounds: 0, startedAt: '2026-10-15T07:00:00Z', endedAt: '2026-10-15T08:00:00Z', agents: null });
};

describe('foreman report --tokens', () => {
  it('prints the role table, a line per story and the hints', async () => {
    tokenRuns();
    const r = await run(['report', '--tokens']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/role\s+today\s+7 days\s+this run\s+last 14 days/);
    expect(r.out).toMatch(/\n\s+builder\s+1\.2 M\s+1\.2 M\s+0\s+[▁▂▃▄▅▆▇█]{14}\n/);
    expect(r.out).toMatch(/security reviewer/);
    expect(r.out).toMatch(/builder \(claude-opus-5-5\): 1\.2 M in · 0 out · 0 cache read · 0 cache write/);
    expect(r.out).toMatch(/\n\s+S-1\s+1\.8 M\s+builder \(claude-opus-5-5\) 1\.2 M · architect \(claude-opus-5-5\) 600 k · security reviewer \(claude-opus-5-5\) 40 k · the story session itself \(claude-opus-5-5\) 5\.0 k\n/);
    expect(r.out).toMatch(/only 0% of its input came from the cache/);
    expect(r.out).toMatch(/1 session without token counts/);
    expect(r.out).not.toContain('$');
  });

  it("names each agent's recorded model on the 7-day line and the story line", async () => {
    writeRun(state(), { story: 'S-7', slot: 'w1', result: 'shipped', costUsd: 1, minutes: 9, rounds: 1, startedAt: '2026-10-16T07:00:00Z', endedAt: '2026-10-16T08:00:00Z', agents: [row('tester', 'test', 70_000, { model: 'claude-haiku-4-5' }), row('architect', 'architect', 9_000, { model: 'claude-opus-4-1' })] });
    const r = await run(['report', '--tokens']);
    expect(r.out).toContain('\n  tester (claude-haiku-4-5): 70 k in · 0 out · 0 cache read · 0 cache write\n');
    expect(r.out).toContain('\n  architect (claude-opus-4-1): 9.0 k in');
    expect(r.out).toMatch(/\n\s+S-7\s+79 k\s+tester \(claude-haiku-4-5\) 70 k · architect \(claude-opus-4-1\) 9\.0 k\n/);
  });

  it('names on the 7-day line only the models of the last 7 days', async () => {
    writeRun(state(), { story: 'S-8', slot: 'w1', result: 'shipped', costUsd: 1, minutes: 9, rounds: 1, startedAt: '2026-10-06T07:00:00Z', endedAt: '2026-10-06T08:00:00Z', agents: [row('tester', 'test', 50_000, { model: 'claude-opus-4-1' })] });
    writeRun(state(), { story: 'S-9', slot: 'w1', result: 'shipped', costUsd: 1, minutes: 9, rounds: 1, startedAt: '2026-10-15T07:00:00Z', endedAt: '2026-10-15T08:00:00Z', agents: [row('tester', 'test', 70_000, { model: 'claude-haiku-4-5' })] });
    const r = await run(['report', '--tokens']);
    expect(r.out).toContain('\n  tester (claude-haiku-4-5): ');
    const week = r.out.slice(r.out.indexOf('\nLast 7 days:\n'), r.out.indexOf('\nPer story'));
    expect(week).toContain('tester (claude-haiku-4-5): 70 k in');
    expect(week).not.toContain('claude-opus-4-1');
  });

  it('prints no model where the sessions recorded none, as before', async () => {
    writeRun(state(), { story: 'S-7', slot: 'w1', result: 'shipped', costUsd: 1, minutes: 9, rounds: 1, startedAt: '2026-10-16T07:00:00Z', endedAt: '2026-10-16T08:00:00Z', agents: [row('tester', 'test', 70_000, { model: null })] });
    const r = await run(['report', '--tokens']);
    expect(r.out).toContain('\nLast 7 days:\n  tester: 70 k in · 0 out · 0 cache read · 0 cache write\n');
    expect(r.out).toMatch(/\n\s+S-7\s+70 k\s+tester 70 k\n/);
    expect(r.out).not.toContain('tester (');
    expect(r.out).not.toContain('()');
  });

  it('prints the view as JSON', async () => {
    tokenRuns();
    const r = await run(['report', '--tokens', '--json']);
    expect(r.code).toBe(0);
    const v = JSON.parse(r.out);
    expect(v.roles.map((x) => x.who)).toContain('builder');
    expect(v.stories.map((x) => x.story)).toEqual(['S-1', 'S-2']);
    expect(Array.isArray(v.hints)).toBe(true);
  });

  it('starts from --since', async () => {
    tokenRuns();
    const r = await run(['report', '--tokens', '--since', '2026-10-10', '--json']);
    expect(JSON.parse(r.out).stories.map((x) => x.story)).toEqual(['S-1']);
  });

  it('says so when no token counts are recorded', async () => {
    runs();
    const r = await run(['report', '--tokens']);
    expect(r).toMatchObject({ code: 0, out: 'No token counts recorded yet.\n' });
  });

  it('adds a Tokens section to the plain report only when there are token counts', async () => {
    tokenRuns();
    const r = await run(['report']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/\nTotal: 3 sessions[^\n]*\n\nTokens\n/);
    expect(r.out).toMatch(/role\s+today\s+7 days/);
    const json = JSON.parse((await run(['report', '--json'])).out);
    expect(Object.keys(json)).toEqual(['since', 'days', 'results', 'total']);
  });
});

// Learner calls and ledger lines, the clock at 2026-10-16T09:00Z.
const learning = () => {
  recordLearnerCall(state(), { at: '2026-10-14T10:00:00Z', key: 'f-000000000001', model: 'haiku', costUsd: 0.3 });
  recordLearnerCall(state(), { at: '2026-10-15T10:00:00Z', key: 'f-000000000002', model: 'sonnet', costUsd: 0.12 });
  const at = (iso) => ({ now: new Date(iso) });
  addItem(state(), { kind: 'trait', roles: ['developer'], text: 'Acme: test every route' }, at('2026-10-14T11:00:00Z'));
  addItem(state(), { kind: 'trait', roles: ['tester'], text: 'Acme: run the route tests' }, at('2026-10-14T12:00:00Z'));
  addItem(state(), { kind: 'trait', roles: ['reviewer'], text: 'Acme: read the route tests' }, at('2026-10-14T13:00:00Z'));
  keepItem(state(), 'L-1', at('2026-10-15T11:00:00Z'));
  undoItem(state(), 'L-2', { ...at('2026-10-15T12:00:00Z'), by: 'foreman', action: 'rollback' });
  undoItem(state(), 'L-3', { ...at('2026-10-15T13:00:00Z'), by: 'foreman', action: 'rollback', metrics: { decision: 'retire' } });
  undoItem(state(), 'L-1', { ...at('2026-10-15T14:00:00Z'), by: 'owner' });
};
const SECTION = 'Learning\n  Learner: 2 calls, $0.42\n  Changes: 3 added, 1 kept, 1 rolled back, 1 retired, 1 undone\n';

describe('foreman report: learning', () => {
  it('adds a Learning section after the totals and before the tokens', async () => {
    tokenRuns();
    learning();
    const r = await run(['report']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/\nTotal: 3 sessions[^\n]*\n\nLearning\n/);
    expect(r.out).toContain(`\n\n${SECTION}`);
    expect(r.out.indexOf('Learning\n')).toBeLessThan(r.out.indexOf('\nTokens\n'));
    expect(r.out).toContain(`${SECTION}\nTokens\n`);
  });

  it('ends with the Learning section when there are no token counts', async () => {
    runs();
    learning();
    const r = await run(['report']);
    expect(r.out).toMatch(new RegExp(`\\(1 session without a cost\\)\\n\\n${SECTION.replace(/[$().]/g, '\\$&')}$`));
  });

  it('starts from --since', async () => {
    runs();
    learning();
    const r = await run(['report', '--since', '2026-10-15']);
    expect(r.out).toContain('Learning\n  Learner: 1 call, $0.12\n  Changes: 0 added, 1 kept, 1 rolled back, 1 retired, 1 undone\n');
  });

  it('adds the totals to --json', async () => {
    runs();
    learning();
    const json = JSON.parse((await run(['report', '--json'])).out);
    expect(json.learning).toEqual({ calls: 2, costUsd: 0.42, added: 3, kept: 1, rolledBack: 1, retired: 1, undone: 1 });
  });

  it('prints the section after the no-sessions line', async () => {
    learning();
    const r = await run(['report']);
    expect(r.out).toBe(`No story sessions recorded yet.\n\n${SECTION}`);
  });

  it('adds the waits on a run in progress after the reuses, only when there are some', async () => {
    runs();
    checkLines({ waited: 2 });
    expect((await run(['report'])).out).toMatch(/S-1\s+2 full-suite runs\s+8 min\s+1 reused {2}2 waited on a run in progress {2}2 rounds\n$/);
    checkLines({ waited: 1, denied: 1 });
    expect((await run(['report'])).out).toMatch(/1 reused {2}1 waited on a run in progress {2}2 rounds {2}1 hand run denied\n$/);
    checkLines();
    expect((await run(['report'])).out).not.toContain('waited');
  });

  it('carries waited in each --json checks entry, apart from reused', async () => {
    runs();
    checkLines({ waited: 2 });
    expect(JSON.parse((await run(['report', '--json'])).out).checks[0]).toEqual({ story: 'S-1', fullRuns: 2, minutes: 8, quickRuns: 0, quickMinutes: 0, reused: 1, waited: 2, denied: 0, rounds: 2 });
  });

  it('leaves --tokens alone', async () => {
    tokenRuns();
    const before = (await run(['report', '--tokens'])).out;
    learning();
    expect((await run(['report', '--tokens'])).out).toBe(before);
  });
});

// learning.jsonl as a directory: reading it fails with EISDIR, as an unreadable file would.
const brokenLedger = () => mkdirSync(join(state(), 'learning.jsonl'), { recursive: true });

describe('foreman report: an unreadable learning.jsonl', () => {
  it('prints the plain report as it would without the ledger', async () => {
    runs();
    const before = (await run(['report'])).out;
    brokenLedger();
    const r = await run(['report']);
    expect(r).toEqual({ code: 0, out: before, err: '' });
    expect(r.out).not.toContain('Learning');
  });

  it('prints --json with the same keys', async () => {
    runs();
    brokenLedger();
    const r = await run(['report', '--json']);
    expect(r.code).toBe(0);
    expect(Object.keys(JSON.parse(r.out))).toEqual(['since', 'days', 'results', 'total']);
  });

  it('still says so when no sessions are recorded', async () => {
    brokenLedger();
    const r = await run(['report']);
    expect(r.code).toBe(0);
    expect(r.out).toBe('No story sessions recorded yet.\n');
  });

  it("still counts the learner's calls", async () => {
    brokenLedger();
    recordLearnerCall(state(), { at: '2026-10-14T10:00:00Z', key: 'f-000000000001', model: 'haiku', costUsd: 0.3 });
    const r = await run(['report']);
    expect(r.out).toBe('No story sessions recorded yet.\n\nLearning\n  Learner: 1 call, $0.30\n  Changes: 0 added, 0 kept, 0 rolled back, 0 retired, 0 undone\n');
  });
});

// Two watchdog stops on top of runs(), the clock at 2026-10-16T09:00Z.
const watchdogRuns = () => {
  writeRun(state(), { story: 'S-4', slot: 'w1', result: 'crashed', costUsd: null, minutes: 120, rounds: 1, startedAt: '2026-10-15T11:00:00Z', endedAt: '2026-10-15T13:00:00Z', watchdog: { why: 'too-long', kept: ['architect:S-4'], redoneTokens: 1_200_000, redoneMinutes: 45 } });
  writeRun(state(), { story: 'S-5', slot: 'w2', result: 'crashed', costUsd: null, minutes: 480, rounds: 2, startedAt: '2026-10-15T14:00:00Z', endedAt: '2026-10-15T22:00:00Z', watchdog: { why: 'ceiling', kept: [], redoneTokens: 300_000, redoneMinutes: 30 } });
};

describe('foreman report: the watchdog', () => {
  it('adds a Watchdog section after the totals and before Learning', async () => {
    runs();
    watchdogRuns();
    learning();
    const r = await run(['report']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/\nTotal: 5 sessions[^\n]*\n\nWatchdog\n  Stopped: 2 stories, 2 sessions \(1 at the hard limit\)\n  Redone work: 1\.5 M tokens, 75 min of agent time\n\nLearning\n/);
    const json = JSON.parse((await run(['report', '--json'])).out);
    expect(json.watchdog).toEqual({ stories: 2, sessions: 2, ceiling: 1, redoneTokens: 1_500_000, redoneMinutes: 75 });
  });

  it('leaves the section and the key out with no watchdog stops', async () => {
    runs();
    const r = await run(['report']);
    expect(r.out).not.toContain('Watchdog');
    const json = JSON.parse((await run(['report', '--json'])).out);
    expect(Object.keys(json)).toEqual(['since', 'days', 'results', 'total']);
  });

  it('starts from --since', async () => {
    runs();
    watchdogRuns();
    expect((await run(['report', '--since', '2026-10-16'])).out).not.toContain('Watchdog');
  });
});

// Two failed sessions that said the environment ended them, on top of runs(), ending on 2026-10-15.
const envRuns = () => {
  writeRun(state(), { story: 'S-3', slot: 'w1', result: 'failed', cause: 'environment', costUsd: null, minutes: 30, rounds: 1, startedAt: '2026-10-15T11:00:00Z', endedAt: '2026-10-15T11:30:00Z' });
  writeRun(state(), { story: 'S-4', slot: 'w2', result: 'failed', cause: 'environment', costUsd: null, minutes: 20, rounds: 1, startedAt: '2026-10-15T12:00:00Z', endedAt: '2026-10-15T12:20:00Z' });
};

describe('foreman report: environment endings', () => {
  it('adds an Environment endings section after the totals', async () => {
    runs();
    envRuns();
    const r = await run(['report']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/\nTotal: [^\n]*\n\nEnvironment endings\n  2 of 3 failed sessions said the environment ended them: S-3, S-4\. The learned-rule checks leave them out\.\n/);
  });

  it('comes after Watchdog and before Learning', async () => {
    runs();
    watchdogRuns();
    envRuns();
    learning();
    const out = (await run(['report'])).out;
    const [watchdog, environment, learned] = ['\nWatchdog\n', '\nEnvironment endings\n', '\nLearning\n'].map((t) => out.indexOf(t));
    expect(watchdog).toBeGreaterThan(-1);
    expect(environment).toBeGreaterThan(watchdog);
    expect(learned).toBeGreaterThan(environment);
  });

  it('is in --json under environment, after the totals', async () => {
    runs();
    envRuns();
    const json = JSON.parse((await run(['report', '--json'])).out);
    expect(json.environment).toEqual({ sessions: 2, failed: 3, stories: ['S-3', 'S-4'] });
    expect(Object.keys(json)).toEqual(['since', 'days', 'results', 'total', 'environment']);
  });

  it('leaves the section and the key out when no session said so', async () => {
    runs();
    expect((await run(['report'])).out).not.toContain('Environment endings');
    expect(Object.keys(JSON.parse((await run(['report', '--json'])).out))).toEqual(['since', 'days', 'results', 'total']);
  });

  it('starts from --since', async () => {
    runs();
    envRuns();
    const r = await run(['report', '--since', '2026-10-16']);
    expect(r.out).not.toContain('Environment endings');
    expect(JSON.parse((await run(['report', '--since', '2026-10-16', '--json'])).out)).not.toHaveProperty('environment');
  });
});

// Check records for S-1 on 2026-10-15: two full real runs (3 and 5 min), one reuse, one run of a
// glob check; `older` adds a full run on 2026-10-13.
const checkLines = ({ older = false, denied = 0, waited = 0, quick = 0 } = {}) => {
  const line = (o) => JSON.stringify({ slot: 'w1', tree: 'a'.repeat(40), ...o });
  const lines = [
    line({ at: '2026-10-15T08:10:00.000Z', story: 'S-1', run: 'npm test', full: true, exit: 1, ms: 180000, tail: '' }),
    line({ at: '2026-10-15T08:20:00.000Z', story: 'S-1', run: 'npm test', full: true, exit: 0, ms: 300000, tail: '' }),
    line({ at: '2026-10-15T08:30:00.000Z', story: 'S-1', run: 'npm test', full: true, reused: true, from: '2026-10-15T08:20:00.000Z' }),
    line({ at: '2026-10-15T08:31:00.000Z', story: 'S-1', run: 'npm run lint:sql', full: false, exit: 0, ms: 60000, tail: '' }),
  ];
  for (let i = 0; i < waited; i++) lines.push(line({ at: '2026-10-15T08:3' + (2 + i) + ':00.000Z', story: 'S-1', run: 'npm test', full: true, reused: true, waited: true, from: '2026-10-15T08:20:00.000Z' }));
  for (let i = 0; i < denied; i++) lines.push(line({ at: '2026-10-15T08:4' + i + ':00.000Z', story: 'S-1', run: 'npm test', full: i % 2 === 0, denied: true }));
  for (let i = 0; i < quick; i++) lines.push(line({ at: '2026-10-15T08:5' + i + ':00.000Z', story: 'S-1', run: 'npm test', quick: true, cmd: 'npm test -- --changed', full: true, exit: 0, ms: 30000, tail: '' }));
  if (older) lines.unshift(line({ at: '2026-10-13T08:00:00.000Z', story: 'S-1', run: 'npm test', full: true, exit: 0, ms: 600000, tail: '' }));
  mkdirSync(state(), { recursive: true });
  writeFileSync(join(state(), 'check-runs.jsonl'), `${lines.join('\n')}\n`);
};

describe('foreman report: checks', () => {
  it('adds a Checks section per story after the totals', async () => {
    runs();
    checkLines();
    const r = await run(['report']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/\(1 session without a cost\)\n\nChecks \(per story\)\n/);
    expect(r.out).toMatch(/S-1\s+2 full-suite runs\s+8 min\s+1 reused\s+2 rounds\n$/);
  });

  it('puts it after Learning and before Tokens', async () => {
    tokenRuns();
    learning();
    checkLines();
    const r = await run(['report']);
    expect(r.out).toContain(`${SECTION}\nChecks (per story)\n`);
    expect(r.out.indexOf('Checks (per story')).toBeLessThan(r.out.indexOf('\nTokens\n'));
    expect(r.out).toMatch(/S-1\s+2 full-suite runs\s+8 min\s+1 reused\s+1 round\n\nTokens\n/);
  });

  it('orders the sections Watchdog, Learning, Checks, Tokens, and keeps every key in --json', async () => {
    tokenRuns();
    watchdogRuns();
    learning();
    checkLines();
    const r = await run(['report']);
    const at = ['\nWatchdog\n', '\nLearning\n', '\nChecks (per story)\n', '\nTokens\n'].map((h) => r.out.indexOf(h));
    expect(at.every((i) => i > -1)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    const json = JSON.parse((await run(['report', '--json'])).out);
    expect(Object.keys(json)).toEqual(['since', 'days', 'results', 'total', 'watchdog', 'learning', 'checks']);
  });

  it('adds the totals to --json', async () => {
    runs();
    checkLines();
    const json = JSON.parse((await run(['report', '--json'])).out);
    expect(json.checks[0]).toEqual({ story: 'S-1', fullRuns: 2, minutes: 8, quickRuns: 0, quickMinutes: 0, reused: 1, waited: 0, denied: 0, rounds: 2 });
  });

  it('starts from --since', async () => {
    runs();
    checkLines({ older: true });
    expect((await run(['report'])).out).toMatch(/S-1\s+3 full-suite runs\s+18 min\s+1 reused\s+2 rounds/);
    const r = await run(['report', '--since', '2026-10-14']);
    expect(r.out).toMatch(/S-1\s+2 full-suite runs\s+8 min\s+1 reused\s+2 rounds/);
    expect(JSON.parse((await run(['report', '--since', '2026-10-16', '--json'])).out)).not.toHaveProperty('checks');
  });

  it('prints the section after the no-sessions line, without rounds when no run is recorded', async () => {
    checkLines();
    const r = await run(['report']);
    expect(r.out).toMatch(/^No story sessions recorded yet\.\n\nChecks \(per story\)\n {2}S-1\s+2 full-suite runs\s+8 min\s+1 reused\n$/);
  });

  it('ends the story line with the hand runs denied, only when there are some', async () => {
    runs();
    checkLines({ denied: 2 });
    expect((await run(['report'])).out).toMatch(/S-1\s+2 full-suite runs\s+8 min\s+1 reused\s+2 rounds {2}2 hand runs denied\n$/);
    checkLines({ denied: 1 });
    expect((await run(['report'])).out).toMatch(/2 rounds {2}1 hand run denied\n$/);
    checkLines();
    expect((await run(['report'])).out).not.toContain('denied');
  });

  it('lists the quick runs apart from the full-suite runs, only when there are some', async () => {
    runs();
    checkLines({ quick: 3 });
    const out = (await run(['report'])).out;
    expect(out).toMatch(/S-1\s+2 full-suite runs\s+8 min\s+3 quick runs\s+2 min\s+1 reused\s+2 rounds\n$/);
    checkLines({ quick: 1 });
    expect((await run(['report'])).out).toMatch(/8 min\s+1 quick run\s+<1 min\s+1 reused/);
    checkLines();
    expect((await run(['report'])).out).not.toContain('quick');
  });

  it('carries the quick runs and minutes in each --json checks entry', async () => {
    runs();
    checkLines({ quick: 3 });
    expect(JSON.parse((await run(['report', '--json'])).out).checks[0]).toEqual({ story: 'S-1', fullRuns: 2, minutes: 8, quickRuns: 3, quickMinutes: 1.5, reused: 1, waited: 0, denied: 0, rounds: 2 });
  });

  it('carries denied in each --json checks entry', async () => {
    runs();
    checkLines({ denied: 2 });
    expect(JSON.parse((await run(['report', '--json'])).out).checks[0]).toEqual({ story: 'S-1', fullRuns: 2, minutes: 8, quickRuns: 0, quickMinutes: 0, reused: 1, waited: 0, denied: 2, rounds: 2 });
  });

  it('leaves --tokens alone', async () => {
    tokenRuns();
    const before = (await run(['report', '--tokens'])).out;
    checkLines();
    expect((await run(['report', '--tokens'])).out).toBe(before);
  });
});

// A session of ACME-1 whose tester ran on Opus though its role is set to Haiku.
const mismatchRun = (withMismatch = true) =>
  writeRun(state(), {
    story: 'ACME-1', slot: 'w1', result: 'shipped', costUsd: 1, minutes: 20, rounds: 1, startedAt: '2026-10-15T08:00:00Z', endedAt: '2026-10-15T08:20:00Z',
    modelMismatches: !withMismatch ? undefined : [{ role: 'tester', name: 'test', agent: 'foreman:tester', set: 'haiku', ran: 'claude-opus-5-5', text: 'test (foreman:tester) is set to Haiku but ran on Opus 5.5' }],
  });

describe('foreman report: models', () => {
  it('adds a Models section after the totals, with the story, the day and the text', async () => {
    runs();
    mismatchRun();
    const r = await run(['report']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/\nTotal: 4 sessions[^\n]*\n\nModels \(set and ran differ\)\n  ACME-1  2026-10-15  test \(foreman:tester\) is set to Haiku but ran on Opus 5\.5\n$/);
  });

  it('puts it after Checks and before Tokens', async () => {
    tokenRuns();
    mismatchRun();
    checkLines();
    const r = await run(['report']);
    const at = ['\nChecks (per story)\n', '\nModels (set and ran differ)\n', '\nTokens\n'].map((h) => r.out.indexOf(h));
    expect(at.every((i) => i > -1)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('adds the entries to --json under models', async () => {
    runs();
    mismatchRun();
    const json = JSON.parse((await run(['report', '--json'])).out);
    expect(json.models).toEqual([
      { story: 'ACME-1', endedAt: '2026-10-15T08:20:00.000Z', role: 'tester', name: 'test', agent: 'foreman:tester', set: 'haiku', ran: 'claude-opus-5-5', text: 'test (foreman:tester) is set to Haiku but ran on Opus 5.5' },
    ]);
  });

  it('leaves the section and the key out after --since, and with no mismatches', async () => {
    runs();
    mismatchRun();
    const later = await run(['report', '--since', '2026-10-16']);
    expect(later.out).not.toContain('Models (set');
    expect('models' in JSON.parse((await run(['report', '--since', '2026-10-16', '--json'])).out)).toBe(false);
    rmSync(state(), { recursive: true, force: true });
    runs();
    expect((await run(['report'])).out).not.toContain('Models (set');
    expect('models' in JSON.parse((await run(['report', '--json'])).out)).toBe(false);
  });

  it('leaves --tokens alone', async () => {
    tokenRuns();
    mismatchRun(false);
    const before = (await run(['report', '--tokens'])).out;
    mismatchRun();
    expect((await run(['report', '--tokens'])).out).toBe(before);
  });
});
