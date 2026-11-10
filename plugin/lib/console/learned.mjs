// What Foreman learned by itself, for the dashboard: the Learned list, the owner's Undo and Keep,
// and the counts `foreman status` shows. Pure apart from the learning store
// (engine/learning-store.mjs, <dir>/learning.jsonl and <dir>/learned/) and the decision files
// (lib/console/decisions.mjs).
//
//   learnedRows(dir)               one row per ledger item, newest id first, at most 50:
//                                  { id, kind, roles, v, status, reason, by, at }. status is
//                                  'on trial' (the version in force is being evaluated), 'kept',
//                                  'undone' (removed, the last pop the owner's), 'rolled back'
//                                  (removed by Foreman) or 'retired' (removed by a rollback whose
//                                  metrics.decision is 'retire'). reason is why the version in
//                                  force was made, or for a removed item the last undo or
//                                  rollback's reason, else "Undone by you" / "Rolled back by
//                                  Foreman". by and at are the last change's (a refused line is
//                                  not a change). Never the text, path, snapshot or sha256.
//   undoLearned(dir, id, { now })  the owner's Undo: back one version, or removed when it had one
//   keepLearned(dir, id, { now })  the owner's Keep: the version in force is no longer on trial
//                                  Both answer { ok: true, message } or { ok: false, status, error }.
//                                  On ok every open "Foreman learned|changed <id> for …" note is
//                                  closed: answered Undo the change (or Keep the change) and marked
//                                  applied in the same write, so the supervisor never runs `foreman
//                                  learning undo` on it a second time. An id that is not L-<n> is a
//                                  404 that does not repeat it. A well-formed id the ledger does not
//                                  have (the ledger lost or reset) still has its open learned or
//                                  changed notes closed and is ok, with no store call and no ledger
//                                  line; it is a 404 only when it has none. An item no longer in
//                                  force still has its notes closed and is ok. A refusal the store
//                                  answers (r.error) is a 409 with the store's words; of the plain
//                                  errors it throws, only its own lock-busy (BUSY) and
//                                  snapshot-changed (Changed) refusals pass through as a 409 with
//                                  their words, and any other becomes the fixed NOT_CHANGED 409, so
//                                  no path reaches an answer. No note is touched on a 409.
//   hasLearned(dir, id)            whether id is L-<n> and the ledger has it
//   NO_ITEM                        the 404's words
//   learningCounts(dir)            { active, evaluating }: the items in force and those of them on
//                                  trial; null when the ledger has no item

import { learnedNote } from '../engine/answers.mjs';
import { BUSY, Changed, currentItems, keepItem, readLedger, undoItem } from '../engine/learning-store.mjs';
import * as decisions from './decisions.mjs';

const ID = /^L-\d+$/;
const MAX_ROWS = 50;
const UNDO = 'Undo the change';
const KEEP = 'Keep the change';
export const NO_ITEM = 'No learned item has that id; reload the list.';
const NOT_CHANGED = 'The learned item could not be changed; run foreman learning undo or keep for it from the command line to see why.';

const idNumber = (id) => Number(String(id).slice(2));

function rowOf(item) {
  const changes = item.lines.filter((l) => l.action !== 'refused');
  const last = changes.at(-1) ?? {};
  let status;
  let reason = item.reason;
  if (item.v > 0) {
    status = item.status === 'kept' ? 'kept' : 'on trial';
  } else {
    const pop = changes.filter((l) => l.action === 'undo' || l.action === 'rollback').at(-1);
    const byOwner = pop?.action === 'undo';
    status = byOwner ? 'undone' : pop?.metrics?.decision === 'retire' ? 'retired' : 'rolled back';
    reason = String(pop?.reason ?? '').trim() || (byOwner ? 'Undone by you' : 'Rolled back by Foreman');
  }
  return { id: item.id, kind: item.kind, roles: [...item.roles], v: item.v, status, reason: String(reason ?? ''), by: last.by ?? null, at: last.at ?? null };
}

export function learnedRows(dir) {
  return [...currentItems(readLedger(dir)).values()]
    .sort((a, b) => idNumber(b.id) - idNumber(a.id))
    .slice(0, MAX_ROWS)
    .map(rowOf);
}

export function learningCounts(dir) {
  const items = [...currentItems(readLedger(dir)).values()];
  if (!items.length) return null;
  const active = items.filter((i) => i.v > 0);
  return { active: active.length, evaluating: active.filter((i) => i.status === 'evaluating').length };
}

export function hasLearned(dir, id) {
  return typeof id === 'string' && ID.test(id) && currentItems(readLedger(dir)).has(id);
}

// The open learned or changed notes for `id`.
function notesFor(dir, id) {
  return decisions.pending(dir).filter((d) => {
    const n = learnedNote(d);
    return n?.id === id && (n.change === 'add' || n.change === 'update');
  });
}

// Closes every open learned or changed note for `id` with `option`, answer and applied in one
// write. A note that does not offer the option is only marked applied: it must not act later.
function closeNotes(dir, id, option, now) {
  for (const d of notesFor(dir, id)) {
    try {
      decisions.answer(dir, d.id, { option }, now, { applied: true });
    } catch {
      decisions.applied(dir, d.id, now);
    }
  }
}

// The owner's Undo or Keep through `change` (undoItem or keepItem), as the header says.
function ownerChange(dir, id, now, change, option, said) {
  if (typeof id !== 'string' || !ID.test(id)) return { ok: false, status: 404, error: NO_ITEM };
  if (!currentItems(readLedger(dir)).has(id)) {
    // The ledger lost the item: its notes can still be cleared, with nothing asked of the store.
    if (!notesFor(dir, id).length) return { ok: false, status: 404, error: NO_ITEM };
    closeNotes(dir, id, option, now);
    return { ok: true, message: `${id} is no longer in the learned list; the note is cleared.` };
  }
  let r;
  try {
    r = change(dir, id, { now, by: 'owner' });
  } catch (err) {
    // A system error (it has a code) is the caller's. Of the plain errors only the store's own
    // refusals (the lock busy, a snapshot changed) pass in their words; any other may name a path.
    if (err?.code) throw err;
    return { ok: false, status: 409, error: err instanceof Changed || err?.message === BUSY ? err.message : NOT_CHANGED };
  }
  if (!r.ok) {
    if (currentItems(readLedger(dir)).get(id)?.v !== 0) return { ok: false, status: 409, error: r.error };
    closeNotes(dir, id, option, now);
    return { ok: true, message: `${id} was already taken out; the note is cleared.` };
  }
  closeNotes(dir, id, option, now);
  return { ok: true, message: said(r.line) };
}

export function undoLearned(dir, id, { now = new Date() } = {}) {
  return ownerChange(dir, id, now, undoItem, UNDO, (line) => (line.v ? `Undid ${id}: back to v${line.v}.` : `Undid ${id}: removed.`));
}

export function keepLearned(dir, id, { now = new Date() } = {}) {
  return ownerChange(dir, id, now, keepItem, KEEP, (line) => `Kept ${id} at v${line.v}.`);
}
