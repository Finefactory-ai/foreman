// The supervisor's queue of work and a slot's locks. Pure.
//
// Queued work is { slot, id, mode, resume?, from? }: `slot` names the slot it must run in, or is
// null (or missing) when any slot may take it. `ranked: true` marks a start-up resume, which yields
// to a higher-priority story the picker would start in the same slot (pickFirst). `from` is the slot the work was pinned to before
// rehome set it free, because that slot is over the worker count and never picks anything up.
//
//   slotNumber(slot)               'w3' gives 3; anything that is not a slot id gives null
//   rehome(queue, workers)         sets work pinned above the worker count (or to a name that is no
//                                  slot) free, in place, keeping the old slot in `from`; returns
//                                  the moved work as [{ id, from }]; a second call moves nothing
//   peekWork(queue, slot)          the work takeWork would take, left in the queue; null when none
//   pickFirst(work, rival, stories)
//                                  whether ranked work gives way to `rival`, the story the picker
//                                  would start (priority, see pick.mjs byPriority)
//   takeable(queue, workers)       how many queued items some slot under the worker count may take
//   movable(holder, { from, id, ours })
//                                  whether a claim or lock holder is the factory's own hold on the
//                                  story under `from`, so it may move to the slot taking the work
//
// takeWork and hasWork do not look at the worker count: rehomed work is work for any slot, and
// the scheduler's canPick keeps a slot over the count from taking it.

import { RESOURCE } from './locks.mjs';
import { byPriority } from './pick.mjs';

const forAny = (w) => w.slot == null;

export function slotNumber(slot) {
  const m = typeof slot === 'string' ? /^w([1-9]\d*)$/.exec(slot) : null;
  return m ? Number(m[1]) : null;
}

// Work whose slot is set but over the worker count (or no slot at all) is set free; see the header.
export function rehome(queue, workers) {
  const moved = [];
  for (const w of queue) {
    if (w.slot == null) continue;
    const n = slotNumber(w.slot);
    if (n !== null && n <= workers) continue;
    moved.push({ id: w.id, from: w.slot });
    w.from = w.slot;
    w.slot = null;
  }
  return moved;
}

export function takeable(queue, workers) {
  return queue.filter((w) => forAny(w) || (slotNumber(w.slot) ?? Infinity) <= workers).length;
}

export function movable(holder, { from, id, ours }) {
  return Boolean(holder && holder.by !== 'owner' && holder.slot === from && (holder.story ?? id) === id && (ours(holder.pid) || holder.stale));
}

export const hasWork = (queue, slot) => queue.some((w) => w.slot === slot || forAny(w));

const indexFor = (queue, slot) => {
  const i = queue.findIndex((w) => w.slot === slot);
  return i === -1 ? queue.findIndex(forAny) : i;
};

// The work takeWork would take, left in the queue.
export function peekWork(queue, slot) {
  const i = indexFor(queue, slot);
  return i === -1 ? null : queue[i];
}

// Removes and returns the work for this slot: work meant for it first, else work for any slot.
export function takeWork(queue, slot) {
  const i = indexFor(queue, slot);
  return i === -1 ? null : queue.splice(i, 1)[0];
}

// Whether ranked work (a start-up resume) gives way to `rival`, the story the picker would start:
// only when the rival is another story and ranks ahead of the queued one by priority. A queued
// story missing from `stories` resumes.
export function pickFirst(work, rival, stories) {
  if (work?.ranked !== true || !rival || rival.id === work.id) return false;
  const queued = stories.find((s) => s.id === work.id);
  return Boolean(queued) && byPriority(rival, queued) < 0;
}

// The resource lock files a slot may hold: the schema token and each configured resource.
export function slotLockFiles(dir, config) {
  const names = ['schema', ...Object.keys(config?.resources ?? {})];
  return [...new Set(names)].map((name) => RESOURCE(dir, name));
}

// A lock is this slot's to let go when the slot holds it and this supervisor (pid) took it, or
// the process that took it is dead.
export const ownsLock = (holder, slot, pid) => Boolean(holder && holder.slot === slot && (holder.pid === pid || holder.stale));

// The group-summary work to queue after a story shipped, or null. Null when the source keeps
// no group summaries, the summary is not needed, or one for this group is already queued or
// running (two slots can finish a group's last two stories at once). `running` lists the
// sessions as { id, mode }; `groupOf(id)` gives a story's group.
export function groupSummaryWork({ source, group, slot, id, queue, running, groupOf }) {
  if (!source?.groupSummary?.(group)?.needed) return null;
  const same = (w) => w.mode === 'group-summary' && groupOf(w.id) === group;
  if (queue.some(same) || running.some(same)) return null;
  return { slot, id, mode: 'group-summary' };
}
