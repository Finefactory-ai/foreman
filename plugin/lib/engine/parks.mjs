// Parked releases: a ship step that cannot finish now (a promotion someone clicks later, a
// deployment that runs for hours) returns { ok: true, parked: { reason, check } }, and
// `foreman ship` exits 9. The story is then ready to promote: every check passed, its slot is
// free, and the release finishes later. The park is kept at <stateDir>/parks/<id>.json,
// { id, step, reason, check, pr, slot, parkedAt }, so a later run can run `check` to see the
// release finished, and the park survives a restart.
//
// `foreman release watch` (and the supervisor, every few minutes) runs watchParks: each park's
// step `check` says whether the release finished. Finished: the story moves to Done through
// the story source, as `foreman story done` does. Failed hard: the story is blocked with the
// reason; nothing halts, because the failure is that story's alone. Either way the park goes
// only once the story source took the change; when it did not, the outcome is error and the
// park stays. Still waiting, or a check that could not run: the park stays, with
// `lastCheck` { at, outcome, detail }, and the next watch tries again.
//
// A markdown story in state mode whose own commit marks it done (finalize) cannot truly park;
// that case is not handled here.

import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { safeId, writeAtomic } from '../adapters/stories/overlay.mjs';
import { openStorySource } from './story-source.mjs';

/** The story status, the `foreman story end` result and the FACTORY_RESULT word. */
export const READY = 'ready-to-promote';

const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export const parkFile = (dir, id) => join(dir, 'parks', `${safeId(id)}.json`);

/**
 * Writes the park for one story and returns the record. Throws for a park that is not whole.
 * `lastCheck` ({ at, outcome, detail }) is kept only when given.
 */
export function savePark(dir, { id, step, reason, check, pr = null, slot = null, parkedAt, lastCheck } = {}) {
  if (!nonEmpty(id)) throw new Error('a park needs the story id');
  if (!nonEmpty(step)) throw new Error('a park needs the step that parked the release');
  if (!nonEmpty(reason)) throw new Error('a park needs a reason');
  if (!isPlain(check)) throw new Error('a park needs a check that is a plain object');
  const record = { id, step, reason, check, pr, slot, parkedAt, ...(lastCheck === undefined ? {} : { lastCheck }) };
  writeAtomic(parkFile(dir, id), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

function readRecord(file) {
  try {
    const record = JSON.parse(readFileSync(file, 'utf8'));
    return isPlain(record) && nonEmpty(record.id) ? record : null;
  } catch {
    return null;
  }
}

/** Removes the park for one story. A park that is not there is fine. */
export function removePark(dir, id) {
  rmSync(parkFile(dir, id), { force: true });
}

/** The park for one story, or null. */
export function readPark(dir, id) {
  const file = parkFile(dir, id);
  return existsSync(file) ? readRecord(file) : null;
}

// A session's claim of ready-to-promote is trusted only with the park `foreman ship` saved:
// `park` is readPark's answer for the story, `status` its status when there is no park. A
// story already done counts too, since the park watch may have finished the release and
// removed the park in between. An unconfirmed claim is 'failed'; other results pass through.
export function confirmedResult(result, { park = null, status = null } = {}) {
  if (result !== READY) return result;
  return isPlain(park) || status === 'done' ? READY : 'failed';
}

/** The reason a story is ended with when its ready-to-promote claim has no park. */
export const UNPARKED = 'claimed ready-to-promote, but no release is parked';

// The supervisor's check of a session's result, as { run, warn, endReason }. A ready-to-promote
// claim is checked against `parkOf()`, then `statusOf()` when there is no park; a status that
// cannot be read leaves the claim unconfirmed. An unconfirmed claim makes the run failed, with
// the warning to post. `storyOpen` means the slot still holds the story, so `foreman story end`
// never ran: then endReason says why to end it. Other results pass through untouched.
export function sessionResult(run, { id, parkOf = () => null, statusOf = () => null, storyOpen = false } = {}) {
  if (run.result !== READY) return { run, warn: null, endReason: null };
  const park = parkOf();
  let status = null;
  if (!park) {
    try {
      status = statusOf();
    } catch {
      // an unreadable vault leaves the claim unconfirmed
    }
  }
  if (confirmedResult(run.result, { park, status }) !== 'failed') return { run, warn: null, endReason: null };
  return {
    run: { ...run, result: 'failed' },
    warn: `${id} said ready-to-promote, but no release is parked; counted as failed.`,
    endReason: storyOpen ? UNPARKED : null,
  };
}

/** Every readable park, oldest first (then by id). Corrupt and half-written files are skipped. */
export function readParks(dir) {
  const folder = join(dir, 'parks');
  let names;
  try {
    names = readdirSync(folder);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith('.json'))
    .map((name) => readRecord(join(folder, name)))
    .filter(Boolean)
    .sort((a, b) => String(a.parkedAt ?? '').localeCompare(String(b.parkedAt ?? '')) || a.id.localeCompare(b.id));
}

const message = (err) => String(err?.message ?? err);

// Adds an event to the feed; best effort. state.mjs is loaded here, not at the top: its
// snapshot reads the parks, and its CLI's top-level await deadlocks on an import both ways.
async function feed(dir, text, kind, at, slot) {
  try {
    const { addEvent } = await import('./state.mjs');
    addEvent(dir, text, kind, at, slot);
  } catch {
    // the feed is best effort
  }
}

// Records a parked release: the park, then the story (ready-to-promote, with the note "ready to
// promote: <reason>" and the event `parked`, which no story source moves an issue for), then
// the event feed. `config` is the config the release ran with, so a pack it names is not
// refused by a reload. Never throws; says what it managed.
export async function parkStory({ dir, root, config, env = process.env, now = () => new Date(), slot = null }, { id, step, reason, check, pr = null }) {
  const answer = { parkSaved: false, storyUpdated: false };
  const at = now();
  try {
    savePark(dir, { id, step, reason, check, pr, slot, parkedAt: at.toISOString() });
    answer.parkSaved = true;
  } catch (err) {
    answer.parkError = message(err);
  }
  try {
    const source = openStorySource({ root, config, now, env });
    answer.storyUpdated = (await source.update(id, { status: READY, note: `ready to promote: ${reason}`, event: 'parked' })) === true;
  } catch (err) {
    answer.storyError = message(err);
  }
  await feed(dir, `${id} is ready to promote: ${reason}`, 'good', at, slot);
  return answer;
}

// The local date, YYYY-MM-DD, as `foreman story done` writes `completed`.
const dateOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// What one check said, as { outcome, detail, note? }: done, waiting, failed, or error for a
// check that threw or answered something else.
async function runCheck(table, park, ctxFor) {
  const step = Object.hasOwn(table ?? {}, park.step) ? table[park.step] : null;
  if (!step) return { outcome: 'error', detail: `unknown ship step ${park.step}` };
  if (typeof step.check !== 'function') return { outcome: 'error', detail: `${park.step} has no check` };
  let answer;
  try {
    answer = await step.check(ctxFor(park));
  } catch (err) {
    return { outcome: 'error', detail: `${park.step} check failed: ${message(err)}` };
  }
  if (!isPlain(answer) || typeof answer.ok !== 'boolean') return { outcome: 'error', detail: `${park.step} check gave no answer Foreman can read` };
  if (answer.ok === false) {
    return nonEmpty(answer.reason) ? { outcome: 'failed', detail: answer.reason } : { outcome: 'error', detail: `${park.step} check failed without a reason` };
  }
  if (answer.done === true) return { outcome: 'done', detail: '', note: nonEmpty(answer.note) ? answer.note : '' };
  if (answer.done === undefined || answer.done === false) return { outcome: 'waiting', detail: nonEmpty(answer.detail) ? answer.detail : undefined };
  return { outcome: 'error', detail: `${park.step} check gave no answer Foreman can read` };
}

// Keeps a park for the next watch, with what this check said.
function keep(dir, park, outcome, detail, at) {
  const { lastCheck: before, ...rest } = park;
  try {
    savePark(dir, { ...rest, lastCheck: { at: at.toISOString(), outcome, detail } });
  } catch {
    // a park that cannot be rewritten is still there for the next watch
  }
  return before;
}

/**
 * Checks every park, oldest first, through its step's `check`, and finishes, fails or keeps
 * each. `table` is the whole step table (stepTableFor), so a step taken out of ship.steps
 * still answers; `ctxFor(park)` builds the ctx its check gets. Never throws.
 * Returns { results: [{ id, step, outcome, detail }] }, outcome done | waiting | failed | error.
 */
export async function watchParks({ dir, root, config, env = process.env, now = () => new Date(), table = {}, ctxFor = () => ({}) }) {
  const results = [];
  let parks;
  try {
    parks = readParks(dir);
  } catch {
    parks = [];
  }
  let source = null;
  const openSource = () => (source ??= openStorySource({ root, config, now, env }));
  for (const park of parks) {
    const at = now();
    let { outcome, detail, note } = await runCheck(table, park, ctxFor);
    try {
      if (outcome === 'done') {
        const updated = await openSource().update(park.id, { status: 'done', fields: { completed: dateOf(at) }, note: `Released: ${note || park.reason}`, event: 'shipped' });
        if (updated === true) {
          removePark(dir, park.id);
          await feed(dir, `${park.id} shipped: the release finished`, 'good', at, park.slot ?? null);
        } else {
          outcome = 'error';
          detail = `the release finished but ${park.id} could not be moved to Done`;
        }
      } else if (outcome === 'failed') {
        const updated = await openSource().update(park.id, { status: 'blocked', fields: { blockedBy: detail }, note: `Release failed: ${detail}`, event: 'failed' });
        if (updated === true) {
          removePark(dir, park.id);
          await feed(dir, `${park.id} release failed: ${detail}`, 'warn', at, park.slot ?? null);
        } else {
          outcome = 'error';
          detail = `the release failed but ${park.id} could not be blocked: ${detail}`;
        }
      }
    } catch (err) {
      outcome = 'error';
      detail = `the release check for ${park.id} could not be recorded: ${message(err)}`;
    }
    if (outcome === 'waiting' || outcome === 'error') {
      const before = keep(dir, park, outcome, detail, at);
      if (outcome === 'error' && before?.detail !== detail) await feed(dir, `${park.id} release check: ${detail}`, 'warn', at, park.slot ?? null);
    }
    results.push({ id: park.id, step: park.step, outcome, detail });
  }
  return { results };
}

/** Whether a release watch should start now: none running, parks waiting, and the interval passed (or none run yet). */
export function parkWatchDue({ running, lastAt, count, now, everyMs }) {
  return !running && count > 0 && (lastAt === 0 || now - lastAt >= everyMs);
}
