// One record per story session, kept in <stateDir>/runs/<story>-<stamp>.json, for what the run
// cost and how long it took:
//
//   { story, slot, result, costUsd, turns, firstTurnTokens, minutes, rounds, serious, learned,
//     stages: { architect, build, test, review }, agents, startedAt, endedAt, cause?, modelMismatches?, watchdog? }
//
// `result` is the session's FACTORY_RESULT, else why it died (rate-limit, outage, api-credit, credit), else
// `crashed`; `stopped` when the owner stopped it (skip, takeover, restart); `interrupted` when the run
// was stopped (`foreman stop --now`, a signal). `costUsd` and `turns` come from the session's final
// stream-json event and are null when it never got there. `cause`, only on a failed session whose
// `foreman story end failed --cause environment` said the environment ended it (CI that never
// started, a conflict, a test file that would not load), is 'environment'; learning-eval.mjs leaves
// such a run out of every count, and `foreman report` counts them (environmentTotals).
// `firstTurnTokens` is the context of the session's first turn (session-log.mjs), null when it is
// unknown. `minutes` is wall-clock time;
// `stages` is the minutes each stage had an agent running, from the spans the agent hook keeps
// (state.mjs), with agents side by side counted once. `rounds` is the build rounds (tester starts).
// `serious` is the blocker and major lines in findings.jsonl for this story written during the
// session, the rounds sent back and fixed included: one line is one finding from one round.
// `learned` is the learned items (`L-n` ids) the story's agents were given, from the slot file
// (state.mjs noteLearned), sorted. `agents` is the tokens each agent of the session used, one
// row { role, name, agent, model, input, output, cacheRead, cacheWrite, turns, round } per agent
// plus the session's own orchestration (tokens.mjs storyAgents, read by session-files.mjs), or
// null when they are unknown. `modelMismatches`, only when some agent ran on another model
// family than its role is set to, is [{ role, name, agent, set, ran, text }] (state.mjs
// modelMismatches). `watchdog`, only on a session the watchdog stopped, is
// { why, kept, redoneTokens, redoneMinutes }: why it stopped (too-long, quiet, ceiling,
// ended-quiet or ended-alive), the finished stages the next session keeps (checkpoint.mjs), and
// the tokens and agent minutes of the work it will do again.
//
// runRecord, learnedOf, stageMinutes, summarise, watchdogTotals, environmentTotals and modelTotals are pure; writeRun, readRuns
// and readFindingsLines touch the folder.
// `foreman report` (cli/commands/report.mjs) prints summarise's totals. Each total's
// firstTurnTokens is the rounded average over its records with a number there, or null.
// watchdogTotals counts the watchdog's stops the same way, by the day they ended. environmentTotals
// counts the failed records whose cause is 'environment', by the day they ended. modelTotals
// lists the model mismatches of the records that ended on or after a day, newest record first.

import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESULTS } from './classify.mjs';
import { parseFindings, SERIOUS } from './learn.mjs';

export const STAGES = ['architect', 'build', 'test', 'review'];

const round = (n, places) => Math.round(n * 10 ** places) / 10 ** places;
const time = (v) => (v instanceof Date ? v.getTime() : Date.parse(v));
const iso = (v) => new Date(time(v)).toISOString();

// Minutes per stage. `stages` maps an agent's role to its stage (state.mjs stageMap); `window`
// clips each span to the session.
export function stageMinutes(spans = [], stages = {}, window = {}) {
  const from = window.from != null ? time(window.from) : -Infinity;
  const to = window.to != null ? time(window.to) : Infinity;
  const byStage = Object.fromEntries(STAGES.map((s) => [s, []]));
  for (const span of spans) {
    const stage = stages[span?.role];
    if (!byStage[stage]) continue;
    const start = Math.max(time(span.since), from);
    const end = Math.min(time(span.until), to);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    byStage[stage].push([start, end]);
  }
  const out = {};
  for (const [stage, list] of Object.entries(byStage)) {
    list.sort((a, b) => a[0] - b[0]);
    let ms = 0;
    let open = null;
    for (const [start, end] of list) {
      if (open && start <= open[1]) open[1] = Math.max(open[1], end);
      else {
        if (open) ms += open[1] - open[0];
        open = [start, end];
      }
    }
    if (open) ms += open[1] - open[0];
    out[stage] = round(ms / 60000, 1);
  }
  return out;
}

// The serious findings lines of `story` with `at` inside the session; a line with no readable
// `at` is not counted.
function seriousIn(findings, story, startedAt, endedAt) {
  const from = time(startedAt);
  const to = time(endedAt);
  return (findings ?? []).filter((f) => {
    if (!f || typeof f !== 'object' || f.story !== story) return false;
    if (!SERIOUS.includes(String(f.severity ?? '').toLowerCase())) return false;
    const when = typeof f.at === 'string' ? Date.parse(f.at) : NaN;
    return Number.isFinite(when) && when >= from && when <= to;
  }).length;
}

// Sorted, once each, strings only.
const learnedList = (ids) =>
  Array.isArray(ids) ? [...new Set(ids.filter((id) => typeof id === 'string'))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })) : [];

// The learned ids of the session's story: from the result it ended with, else from the story
// the slot held before it ended.
export function learnedOf(slotBefore, done) {
  return learnedList(done?.learned ?? slotBefore?.story?.learned ?? []);
}

export function runRecord({ story, slot, result, log = {}, startedAt, endedAt, rounds = 0, spans = [], stages = {}, findings = [], learned = [], agents = null, cause, modelMismatches, watchdog }) {
  return {
    story,
    slot,
    result,
    costUsd: log.costUsd ?? null,
    turns: log.turns ?? null,
    firstTurnTokens: log.firstTurnTokens ?? null,
    minutes: round(Math.max(0, time(endedAt) - time(startedAt)) / 60000, 1),
    rounds: rounds ?? 0,
    serious: seriousIn(findings, story, startedAt, endedAt),
    learned: learnedList(learned),
    stages: stageMinutes(spans, stages, { from: startedAt, to: endedAt }),
    agents: Array.isArray(agents) ? agents : null,
    startedAt: iso(startedAt),
    endedAt: iso(endedAt),
    ...(cause === 'environment' ? { cause } : {}),
    ...(Array.isArray(modelMismatches) && modelMismatches.length ? { modelMismatches } : {}),
    ...(watchdog === undefined ? {} : { watchdog }),
  };
}

// <dir>/runs/<story>-<yyyymmdd-hhmmss>.json; the story id is reduced to a safe file name.
export function runFile(dir, { story, startedAt }) {
  const safe = String(story ?? 'none').replace(/[^A-Za-z0-9._-]/g, '').replace(/^[.]+/, '') || 'none';
  const stamp = iso(startedAt).replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return join(dir, 'runs', `${safe}-${stamp}.json`);
}

export function writeRun(dir, record) {
  const file = runFile(dir, record);
  mkdirSync(join(dir, 'runs'), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(tmp, file);
  return file;
}

// Every record in the folder, oldest first; a file that is not a record is skipped.
export function readRuns(dir) {
  let names;
  try {
    names = readdirSync(join(dir, 'runs')).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const runs = [];
  for (const name of names) {
    try {
      const r = JSON.parse(readFileSync(join(dir, 'runs', name), 'utf8'));
      if (r && typeof r === 'object' && r.story && Number.isFinite(time(r.endedAt))) runs.push(r);
    } catch {
      // half written, or not ours
    }
  }
  return runs.sort((a, b) => time(a.startedAt) - time(b.startedAt));
}

// The parsed lines of <dir>/findings.jsonl, or [] when there is no file or it cannot be read.
export function readFindingsLines(dir) {
  try {
    return parseFindings(readFileSync(join(dir, 'findings.jsonl'), 'utf8'));
  } catch {
    return [];
  }
}

const day = (r) => iso(r.endedAt).slice(0, 10);
const resultOrder = (r) => (RESULTS.includes(r) ? RESULTS.indexOf(r) : RESULTS.length);

// The rounded average of the records' firstTurnTokens that are numbers, or null for none.
function averageFirstTurn(list) {
  const known = list.map((r) => r.firstTurnTokens).filter((n) => typeof n === 'number' && Number.isFinite(n));
  return known.length ? Math.round(known.reduce((a, b) => a + b, 0) / known.length) : null;
}

// Totals per day (UTC, by when the session ended) and per result, from `since` (YYYY-MM-DD) on.
export function summarise(runs, { since = '' } = {}) {
  const chosen = runs.filter((r) => !since || day(r) >= since);
  const sum = (list) => ({
    sessions: list.length,
    stories: new Set(list.map((r) => r.story)).size,
    shipped: list.filter((r) => r.result === 'shipped').length,
    costUsd: round(list.reduce((n, r) => n + (Number(r.costUsd) || 0), 0), 2),
    minutes: round(list.reduce((n, r) => n + (Number(r.minutes) || 0), 0), 1),
    firstTurnTokens: averageFirstTurn(list),
  });
  const group = (key) => {
    const map = new Map();
    for (const r of chosen) map.set(key(r), [...(map.get(key(r)) ?? []), r]);
    return map;
  };
  const days = [...group(day)].sort(([a], [b]) => a.localeCompare(b)).map(([d, list]) => ({ day: d, ...sum(list) }));
  const results = [...group((r) => String(r.result ?? 'unknown'))]
    .sort(([a], [b]) => resultOrder(a) - resultOrder(b) || a.localeCompare(b))
    .map(([result, list]) => {
      const { sessions, costUsd, minutes, firstTurnTokens } = sum(list);
      return { result, sessions, costUsd, minutes, firstTurnTokens };
    });
  return { days, results, total: { ...sum(chosen), unpriced: chosen.filter((r) => typeof r.costUsd !== 'number').length } };
}

// The watchdog's stops from `since` (YYYY-MM-DD) on: the stories and sessions it stopped, how
// many at the hard ceiling, and the tokens and agent minutes the next sessions did again.
export function watchdogTotals(runs, { since = '' } = {}) {
  const stops = runs.filter((r) => r?.watchdog && typeof r.watchdog === 'object' && (!since || day(r) >= since));
  return {
    stories: new Set(stops.map((r) => r.story)).size,
    sessions: stops.length,
    ceiling: stops.filter((r) => r.watchdog.why === 'ceiling').length,
    redoneTokens: stops.reduce((n, r) => n + (Number(r.watchdog.redoneTokens) || 0), 0),
    redoneMinutes: round(stops.reduce((n, r) => n + (Number(r.watchdog.redoneMinutes) || 0), 0), 1),
  };
}

// The failed sessions from `since` (YYYY-MM-DD) on, and how many of them said the environment ended
// them (cause 'environment'): { sessions, failed, stories }, the stories sorted by number.
export function environmentTotals(runs, { since = '' } = {}) {
  const failed = runs.filter((r) => r?.result === 'failed' && (!since || day(r) >= since));
  const claimed = failed.filter((r) => r.cause === 'environment');
  return {
    sessions: claimed.length,
    failed: failed.length,
    stories: [...new Set(claimed.map((r) => r.story))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
  };
}

// The agents that ran on another model than their role is set to, from `since` (YYYY-MM-DD) on:
// one entry per mismatch { story, endedAt, role, name, agent, set, ran, text }, newest record first.
export function modelTotals(runs, { since = '' } = {}) {
  const chosen = runs.filter((r) => Array.isArray(r?.modelMismatches) && r.modelMismatches.length && (!since || day(r) >= since));
  return chosen
    .sort((a, b) => time(b.endedAt) - time(a.endedAt))
    .flatMap((r) =>
      r.modelMismatches
        .filter((m) => m && typeof m.text === 'string')
        .map((m) => ({ story: r.story, endedAt: iso(r.endedAt), role: m.role, name: m.name, agent: m.agent, set: m.set, ran: m.ran, text: m.text })),
    );
}
