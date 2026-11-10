// Whether a learned item on trial worked: keep, retire or rollback, with a reason and the
// numbers before and after. Pure (no files, no clock): `foreman learning tick` passes in the
// ledger (learning-store.mjs), the run records and the findings lines (run-record.mjs), the
// window (learning.window) and now, and applies the result through the store.
//
// Only runs whose result is in OUTCOMES count; stopped, crashed, rate-limited, blocked and
// similar runs say nothing about an item. A run used item X version k when its `learned` lists X
// and k was X's version in force when the run started (versionAt). A run that used a version
// Foreman rolled back (rolledBack, between that version's change and its rollback) counts
// nowhere, so one bad item does not take the others down with it. A failed run whose `cause` is
// 'environment' (the environment ended it, not the story) counts nowhere either: not in the
// window, the baseline, the fail rate, rule b or the r- target.
//
//   window     the first `window` runs that used the item's version in force, from its change on
//   baseline   the last BASELINE_RUNS runs that ended by the change, on the item's roles (a run
//              whose agents are unknown counts)
//   target     what the item was learned from (its source key): f- a findings cluster and n- the
//              cluster of a fix that did not fix, hit by a run with a cluster finding on its story
//              during the session; r- a failed story, hit by a failed run; anything else cannot be
//              measured (null)
//
// The rules, first match wins:
//   a) rollback at once when a finding since the change names the item, "[L-n]", except one
//      made while another version of it that Foreman rolled back was in force
//   b) rollback at once when 2 or more window runs failed; the reason counts the runs and
//      lists each story once
//   c) no decision until the window is full, or WAIT_DAYS have passed with at least one run
//   d) rollback when, against a baseline of at least one run and with the target not dropped,
//      mean rounds rose by 0.5, serious findings by 1, or the failure rate by 20 points
//   e) retire ("no effect") when the target was hit on 2 or more window stories
//   f) keep (proven)
//
//   versionAt(item, time)        the version of a currentItems entry in force at `time`, or 0
//   rolledBack(ledger)           [{id, v, from, to, sourceKey}]: the versions Foreman rolled back
//                                for being worse (a retire is not one)
//   rolledBackKeys(ledger)       the source keys of every version Foreman took out, retires too;
//                                the tick does not send their lessons to the learner again
//   evaluateItem(item, {ledger, runs, findings, window, now})
//                                {id, v, roles, changeAt, decision, reason, metrics, runs}
//   evaluate({ledger, runs, findings, window, now})
//                                the decided results for every item on trial, newest change
//                                first. With overlaps the newest goes first: an older rollback
//                                whose window shares a run with a newer rollback or retire waits
//                                for the next pass, which no longer counts the newer one's runs.

import { currentItems } from './learning-store.mjs';
import { clusterFindings, notFixedKey } from './lessons.mjs';

export const WAIT_DAYS = 14;
export const BASELINE_RUNS = 10;
export const OUTCOMES = ['shipped', 'ready-to-promote', 'failed'];

const DAY_MS = 24 * 3600 * 1000;
const EPS = 1e-9;
const ROUNDS_RISE = 0.5;
const SERIOUS_RISE = 1;
const FAIL_RISE = 20;

const time = (v) => (v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v));
const round = (n, places) => Math.round(n * 10 ** places) / 10 ** places;
const idNumber = (id) => Number(/^L-(\d+)$/.exec(String(id))?.[1] ?? 0);
const distinct = (list) => [...new Set(list)];
const runKey = (r) => `${r.story}@${r.startedAt}`;
const isChange = (l) => (l.action === 'add' || l.action === 'update') && l.after;
const isPop = (l) => l.action === 'undo' || l.action === 'rollback';

export function versionAt(item, at) {
  const when = time(at);
  const stack = [];
  for (const line of item?.lines ?? []) {
    if (!(time(line.at) <= when)) break;
    if (isChange(line)) stack.push(line.v);
    else if (isPop(line)) stack.pop();
  }
  return stack.at(-1) ?? 0;
}

// Every version Foreman popped: {id, v, from, to, sourceKey, retired}.
function popped(ledger) {
  const out = [];
  for (const item of currentItems(ledger).values()) {
    const stack = [];
    for (const line of item.lines) {
      if (isChange(line)) stack.push({ v: line.v, at: line.at, sourceKey: line.source?.key ?? null });
      else if (isPop(line)) {
        const top = stack.pop();
        if (top && line.action === 'rollback' && line.by === 'foreman') {
          out.push({ id: item.id, v: top.v, from: top.at, to: line.at, sourceKey: top.sourceKey, retired: line.metrics?.decision === 'retire' });
        }
      }
    }
  }
  return out;
}

export function rolledBack(ledger) {
  return popped(ledger)
    .filter((p) => !p.retired)
    .map(({ id, v, from, to, sourceKey }) => ({ id, v, from, to, sourceKey }));
}

export function rolledBackKeys(ledger) {
  return new Set(popped(ledger).map((p) => p.sourceKey).filter(Boolean));
}

const used = (run, item, v) => Array.isArray(run.learned) && run.learned.includes(item.id) && versionAt(item, run.startedAt) === v;

// The hit test for the item's target, or null when it cannot be measured.
function targetOf(item, findings) {
  const key = String(item.source?.key ?? '');
  const inCluster = (cluster) => (run) => {
    const from = time(run.startedAt);
    const to = time(run.endedAt);
    return (cluster?.members ?? []).some((f) => f.story === run.story && time(f.at) >= from && time(f.at) <= to);
  };
  if (key.startsWith('f-')) return inCluster(clusterFindings(findings).find((c) => c.key === key));
  if (key.startsWith('n-')) {
    const stories = item.source?.stories ?? [];
    return inCluster(clusterFindings(findings).find((c) => stories.some((s) => notFixedKey(c.key, s) === key)));
  }
  if (key.startsWith('r-')) return (run) => run.result === 'failed';
  return null;
}

const mean = (list, field) => (list.length ? round(list.reduce((n, r) => n + (Number(r[field]) || 0), 0) / list.length, 2) : null);

function measure(list, hits) {
  return {
    runs: list.length,
    stories: distinct(list.map((r) => r.story)).length,
    rounds: mean(list, 'rounds'),
    serious: mean(list, 'serious'),
    failRate: list.length ? Math.round((100 * list.filter((r) => r.result === 'failed').length) / list.length) : null,
    target: hits ? list.filter(hits).length : null,
  };
}

const one = (n) => (n === null ? '?' : n.toFixed(1));

export function evaluateItem(item, { ledger = [], runs = [], findings = [], window, now } = {}) {
  const items = currentItems(ledger);
  const { id, v, roles } = item;
  const changeLine = item.lines.filter((l) => isChange(l) && l.v === v).at(-1);
  const changeAt = changeLine?.at ?? null;
  const change = time(changeAt);
  const size = Math.max(1, Number(window) || 1);

  // Runs that used a version Foreman rolled back count nowhere; this item's own version aside.
  const bad = rolledBack(ledger).filter((b) => !(b.id === id && b.v === v));
  // This item's other versions Foreman rolled back: a citation made under one is about it.
  const ownBad = rolledBack(ledger).filter((b) => b.id === id && b.v !== v);
  const excluded = (run) =>
    bad.some((b) => {
      const other = items.get(b.id);
      const at = time(run.startedAt);
      return other && at >= time(b.from) && at < time(b.to) && used(run, other, b.v);
    });
  const outcome = runs.filter((r) => r && OUTCOMES.includes(r.result) && r.cause !== 'environment' && !excluded(r));

  const windowRuns = outcome
    .filter((r) => time(r.startedAt) >= change && used(r, item, v))
    .sort((a, b) => time(a.startedAt) - time(b.startedAt))
    .slice(0, size);
  const sameRoles = (r) => !Array.isArray(r.agents) || r.agents.some((a) => roles.includes(a?.role));
  const baseRuns = outcome
    .filter((r) => time(r.endedAt) <= change && sameRoles(r))
    .sort((a, b) => time(a.endedAt) - time(b.endedAt))
    .slice(-BASELINE_RUNS);

  const hits = targetOf(item, findings);
  const w = measure(windowRuns, hits);
  const b = measure(baseRuns, hits);
  const metrics = { decision: null, window: w, baseline: b };
  const result = (decision, reason, extra = {}) => ({
    id,
    v,
    roles,
    changeAt,
    decision,
    reason,
    metrics: { ...metrics, decision, ...extra },
    runs: windowRuns.map(runKey),
  });

  // a) named in a finding since the change, not while a rolled-back version of it was in force
  const tag = `[${id}]`;
  const underBad = (f) => ownBad.some((b) => time(f.at) >= time(b.from) && time(f.at) < time(b.to));
  const cited = distinct(
    findings
      .filter((f) => f && time(f.at) >= change && !underBad(f) && ['rule', 'observed', 'fix', 'where'].some((k) => String(f[k] ?? '').includes(tag)))
      .map((f) => String(f.story ?? ''))
      .filter(Boolean),
  );
  if (cited.length) return result('rollback', `${tag} was named in a finding on ${cited.join(', ')}`, { cited });

  // b) two failures in the window
  const failedRuns = windowRuns.filter((r) => r.result === 'failed');
  const failed = distinct(failedRuns.map((r) => r.story));
  if (failedRuns.length >= 2) return result('rollback', `${failedRuns.length} runs failed with ${id} on ${failed.join(', ')}`, { failed });

  // c) wait for a full window, or WAIT_DAYS with something to go on
  const waited = time(now) - change >= WAIT_DAYS * DAY_MS;
  if (!(w.runs >= size || (waited && w.runs >= 1))) return result(null, `waits: ${w.runs} of ${size} stories so far`);

  // d) worse, with the target not dropped
  if (b.runs >= 1) {
    const dropped = hits !== null && w.target / w.runs < b.target / b.runs;
    const rose = [];
    if (w.rounds - b.rounds >= ROUNDS_RISE - EPS) rose.push(`rounds ${one(b.rounds)} → ${one(w.rounds)}`);
    if (w.serious - b.serious >= SERIOUS_RISE - EPS) rose.push(`serious findings ${one(b.serious)} → ${one(w.serious)}`);
    if (w.failRate - b.failRate >= FAIL_RISE - EPS) rose.push(`failures ${b.failRate}% → ${w.failRate}%`);
    if (!dropped && rose.length) return result('rollback', `Stories got worse: ${rose.join(', ')}`);
  }

  // e) no effect
  if (hits !== null) {
    const back = distinct(windowRuns.filter(hits).map((r) => r.story));
    if (back.length >= 2) return result('retire', `No effect: the problem came back on ${back.join(', ')}`);
  }

  // f) proven
  const rounds = b.runs ? `rounds ${one(b.rounds)} → ${one(w.rounds)}` : `rounds ${one(w.rounds)}`;
  return result('keep', `Proven over ${w.stories} ${w.stories === 1 ? 'story' : 'stories'}: ${rounds}`);
}

export function evaluate({ ledger = [], runs = [], findings = [], window, now } = {}) {
  const onTrial = [...currentItems(ledger).values()].filter((i) => i.v > 0 && i.status === 'evaluating');
  const results = onTrial
    .map((item) => evaluateItem(item, { ledger, runs, findings, window, now }))
    .sort((a, b) => time(b.changeAt) - time(a.changeAt) || idNumber(b.id) - idNumber(a.id));
  const taken = new Map(); // run key -> the id whose rollback or retire counted it
  for (const r of results) {
    if (r.decision === 'rollback') {
      const first = r.runs.map((k) => taken.get(k)).find(Boolean);
      if (first) {
        r.decision = null;
        r.reason = `waits: ${first} was rolled back first`;
        r.metrics = { ...r.metrics, decision: null };
        continue;
      }
    }
    if (r.decision === 'rollback' || r.decision === 'retire') for (const k of r.runs) if (!taken.has(k)) taken.set(k, r.id);
  }
  return results.filter((r) => r.decision !== null);
}
