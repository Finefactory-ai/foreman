// The owner's controls: the one module that writes <stateDir>/control.json, so the CLI and the
// dashboard never invent their own format. The supervisor reads the file each tick
// (scheduler.mjs pendingCommands, state.mjs takeNextRequest and isPaused).
//
//   paused                    true while the owner wants no new stories started
//   resumeAt                  a Resume, which also clears a pause the factory made itself
//   workers, workersAt        the worker count, applied once per workersAt
//   slots.<wN>                { action, at }: one slot command, applied once per at
//   fixedAt                   "I've fixed it", after a halt
//   handBack                  { id, at }: give a story the owner took back to the factory
//   nextStory, requestedAt    build this story next, if it can be built now
//   answerRetry               { id, at }: try a failed owner answer again now (retryAnswer),
//                             applied once per at
//
// clearNextStory(dir, { id, requestedAt }) drops a nextStory that was already handled (foreman
// run and doctor, engine/stale-control.mjs), only while it is still that request: a newer one
// written meanwhile stays. It keeps requestedAt, so the next request's stamp stays later.
//
// Every write is read-modify-write through a temp file and a rename, so a reader never sees half
// a file. A command's `at` is always later than the one it replaces, so pressing the same button
// twice is two commands even on a frozen clock. Stop is not in control.json: it is the STOP file,
// which the supervisor watches, plus the service-stopped marker (engine/supervisor-pid.mjs), so a
// factory run as a service stays stopped until `foreman run`. Both hold one JSON line naming who
// stopped the run (console/stopper.mjs): stop(dir, now, by) writes `by`, or, with none given, the
// process that called it, so a direct call from a story session still names that session.
// writeStopFile(dir, record) writes STOP alone (the cloud runner's first SIGTERM).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACTIONS } from '../engine/scheduler.mjs';
import { markStopped } from '../engine/supervisor-pid.mjs';
import { stopperOf } from './stopper.mjs';

export const controlFile = (dir) => join(dir, 'control.json');
export const stopFile = (dir) => join(dir, 'STOP');

// A decision id: letters, digits, dots, colons, dashes and underscores, at most 80.
export const ANSWER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function readControl(dir) {
  try {
    const value = JSON.parse(readFileSync(controlFile(dir), 'utf8'));
    return isPlain(value) ? value : {};
  } catch {
    return {};
  }
}

// Replaces the whole file (the artifacts console, which copies a page's controls in wholesale).
export function saveControl(dir, value) {
  mkdirSync(dir, { recursive: true });
  const file = controlFile(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`);
  renameSync(tmp, file);
  return value;
}

// Merges `patch` into the file; `slots` merges slot by slot. `now` is taken for symmetry with
// the helpers; the stamps are in the patch.
// eslint-disable-next-line no-unused-vars
export function writeControl(dir, patch, now = new Date()) {
  const was = readControl(dir);
  const next = { ...was, ...patch };
  if (patch.slots) next.slots = { ...(isPlain(was.slots) ? was.slots : {}), ...patch.slots };
  return saveControl(dir, next);
}

// now as ISO, moved 1 ms past `prev` when the clock has not passed it.
function freshAt(prev, now) {
  const at = now.toISOString();
  const before = Date.parse(prev ?? '');
  if (Number.isNaN(before) || Date.parse(at) > before) return at;
  return new Date(before + 1).toISOString();
}

export const pause = (dir, now = new Date()) => writeControl(dir, { paused: true }, now);

export const resume = (dir, now = new Date()) => writeControl(dir, { paused: false, resumeAt: freshAt(readControl(dir).resumeAt, now) }, now);

export function setWorkers(dir, n, now = new Date()) {
  if (!Number.isInteger(n) || n < 1) throw new Error(`The worker count must be a whole number of at least 1, not ${n}.`);
  return writeControl(dir, { workers: n, workersAt: freshAt(readControl(dir).workersAt, now) }, now);
}

export function slotAction(dir, slot, action, now = new Date()) {
  if (!/^w[1-9]\d*$/.test(String(slot))) throw new Error(`There is no slot ${slot}.`);
  if (!ACTIONS.has(action)) throw new Error(`Unknown slot action ${action}; one of ${[...ACTIONS].join(', ')}.`);
  const prev = readControl(dir).slots?.[slot]?.at;
  return writeControl(dir, { slots: { [slot]: { action, at: freshAt(prev, now) } } }, now);
}

export const fixed = (dir, now = new Date()) => writeControl(dir, { fixedAt: freshAt(readControl(dir).fixedAt, now) }, now);

export function handBack(dir, id, now = new Date()) {
  if (!id) throw new Error('Which story? handBack needs a story id.');
  return writeControl(dir, { handBack: { id, at: freshAt(readControl(dir).handBack?.at, now) } }, now);
}

export function nextStory(dir, id, now = new Date()) {
  if (!id) throw new Error('Which story? nextStory needs a story id.');
  return writeControl(dir, { nextStory: id, requestedAt: freshAt(readControl(dir).requestedAt, now) }, now);
}

// Removes `nextStory` while it is still `id` with the same requestedAt; true when it did.
export function clearNextStory(dir, { id, requestedAt }) {
  const was = readControl(dir);
  if (was.nextStory !== id || was.requestedAt !== requestedAt) return false;
  const { nextStory: _gone, ...rest } = was;
  saveControl(dir, rest);
  return true;
}

export function retryAnswer(dir, id, now = new Date()) {
  if (typeof id !== 'string' || !ANSWER_ID.test(id)) throw new Error(`${id} is not an answer id.`);
  return writeControl(dir, { answerRetry: { id, at: freshAt(readControl(dir).answerRetry?.at, now) } }, now);
}

export function writeStopFile(dir, record) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(stopFile(dir), `${JSON.stringify(record)}\n`);
}

export function stop(dir, now = new Date(), by) {
  const record = by ?? stopperOf({ via: 'unknown', env: process.env, cwd: process.cwd(), at: now });
  writeStopFile(dir, record);
  markStopped(dir, now, record);
}
