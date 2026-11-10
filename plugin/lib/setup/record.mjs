// What the dashboard remembers about each set-up step on this machine, in
// <stateDir>/setup.json: step ids, confirmations and times only, never a key's value.
//
//   SETUP_FILE, LIMITS                 'setup.json'; { perMinute: 5, perHour: 30 } per step
//   readRecord(dir)                    { version: 1, steps: { [id]: { checkedAt?, confirmedAt?,
//                                      confirmedByYou?: { [item]: iso }, runs: [iso] } } }; a
//                                      missing or broken file reads as empty, and a step id the
//                                      model does not know, any other field, an item id that is
//                                      not ITEM_ID and any value that is not an ISO time are
//                                      dropped
//   writeRecord(dir, record)           the same fields only, through a tmp file and a rename,
//                                      at mode 600
//   markChecked(dir, id, at)           sets the step's checkedAt
//   markConfirmed(dir, id, at)         sets the step's confirmedAt: a check or a key test passed.
//                                      checkedAt and confirmedAt are what Foreman checked.
//   markConfirmedByYou(dir, id, item, at), clearConfirmedByYou(dir, id, item)
//                                      sets or removes one thing the owner confirmed on the Set up
//                                      screen because Foreman cannot check it, such as
//                                      'ci-tests-<stage>' on sf-gearset; kept apart from checked
//   makeLimiter({ dir, now }).begin(id)
//                                      { ok: true, done() } or { ok: false, retryAfter: seconds,
//                                      why: 'busy' | 'minute' | 'hour' }: one at a time per step
//                                      (in memory), and at most LIMITS tries a minute and an hour.
//                                      The tries are kept as the step's runs, so the limit holds
//                                      across a restart; a refused try is not recorded.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stepById } from './steps.mjs';

export const SETUP_FILE = 'setup.json';
export const LIMITS = Object.freeze({ perMinute: 5, perHour: 30 });

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
// The id of one thing the owner confirmed, such as ci-tests-qa.
export const ITEM_ID = /^[a-z][a-z0-9-]{0,63}$/;

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isTime = (v) => typeof v === 'string' && ISO.test(v) && !Number.isNaN(Date.parse(v));

// Only what setup.json may hold.
function clean(raw) {
  const steps = {};
  if (!isPlain(raw) || raw.version !== 1 || !isPlain(raw.steps)) return { version: 1, steps };
  for (const [id, entry] of Object.entries(raw.steps)) {
    if (!stepById(id) || !isPlain(entry)) continue;
    const step = {};
    if (isTime(entry.checkedAt)) step.checkedAt = entry.checkedAt;
    if (isTime(entry.confirmedAt)) step.confirmedAt = entry.confirmedAt;
    if (isPlain(entry.confirmedByYou)) {
      const byYou = Object.entries(entry.confirmedByYou).filter(([item, at]) => ITEM_ID.test(item) && isTime(at));
      if (byYou.length) step.confirmedByYou = Object.fromEntries(byYou);
    }
    step.runs = Array.isArray(entry.runs) ? entry.runs.filter(isTime) : [];
    steps[id] = step;
  }
  return { version: 1, steps };
}

export function readRecord(dir) {
  try {
    return clean(JSON.parse(readFileSync(join(dir, SETUP_FILE), 'utf8')));
  } catch {
    // A missing or broken file reads as empty; the next write replaces it.
    return { version: 1, steps: {} };
  }
}

export function writeRecord(dir, record) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, SETUP_FILE);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(clean({ ...record, version: 1 }), null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

function mark(dir, id, field, at) {
  const record = readRecord(dir);
  record.steps[id] = { runs: [], ...record.steps[id], [field]: at };
  writeRecord(dir, record);
}

export const markChecked = (dir, id, at) => mark(dir, id, 'checkedAt', at);
export const markConfirmed = (dir, id, at) => mark(dir, id, 'confirmedAt', at);

// One item the owner confirmed, set or removed; the step's other fields stay as they are.
function byYou(dir, id, item, at) {
  const record = readRecord(dir);
  const entry = record.steps[id];
  if (at === null && !entry) return;
  const items = { ...(entry?.confirmedByYou ?? {}) };
  if (at === null) delete items[item];
  else items[item] = at;
  const { confirmedByYou: _old, ...rest } = { runs: [], ...entry };
  record.steps[id] = Object.keys(items).length ? { ...rest, confirmedByYou: items } : rest;
  writeRecord(dir, record);
}

export const markConfirmedByYou = (dir, id, item, at) => byYou(dir, id, item, at);
export const clearConfirmedByYou = (dir, id, item) => byYou(dir, id, item, null);

export function makeLimiter({ dir, now = () => new Date() }) {
  const inFlight = new Set();

  // A refusal when `limit` or more runs fall in the last `windowMs`: the wait is until the
  // oldest run that keeps the count at the limit leaves the window.
  const over = (runs, t, windowMs, limit, why) => {
    const recent = runs.filter((r) => t - r < windowMs).sort((a, b) => a - b);
    if (recent.length < limit) return null;
    return { ok: false, retryAfter: Math.max(1, Math.ceil((recent[recent.length - limit] + windowMs - t) / 1000)), why };
  };

  function begin(stepId) {
    if (inFlight.has(stepId)) return { ok: false, retryAfter: 1, why: 'busy' };
    const t = now().getTime();
    const record = readRecord(dir);
    const kept = (record.steps[stepId]?.runs ?? []).filter((r) => t - Date.parse(r) < HOUR_MS);
    const times = kept.map((r) => Date.parse(r));
    const refused = over(times, t, HOUR_MS, LIMITS.perHour, 'hour') ?? over(times, t, MINUTE_MS, LIMITS.perMinute, 'minute');
    if (refused) return refused;
    record.steps[stepId] = { ...record.steps[stepId], runs: [...kept, new Date(t).toISOString()] };
    writeRecord(dir, record);
    inFlight.add(stepId);
    let open = true;
    return {
      ok: true,
      done() {
        if (!open) return;
        open = false;
        inFlight.delete(stepId);
      },
    };
  }

  return { begin };
}
