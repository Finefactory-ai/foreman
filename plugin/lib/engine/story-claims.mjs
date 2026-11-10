// The story claims, the schema token and the file reservations of the slots this run owns.
//
// File reservations (file-locks.mjs): releaseToken, just before it removes a slot's file locks,
// keeps each freed file for the highest-priority story whose wait record names it (one event
// names them); the picker starts a story with a wait record only after keeping its free files
// for it; the story's session ending, or its `foreman lock files`, drops what was kept for it.

import { rmSync } from 'node:fs';
import { claimFile, claims, forceSet, holderOf, release, SCHEMA, take } from './locks.mjs';
import { byPriority, eligible, needsExclusive } from './pick.mjs';
import { fileLockFiles, reserveFreed, reserveText, waitBlocks, yieldsTo } from './file-locks.mjs';
import { movable, ownsLock, slotLockFiles } from './slot-work.mjs';

// `own` and `skipped` are the supervisor's own sets: this reads and changes them in place.
export function storyClaims({ dir: DIR, config: CONFIG, own: OWN, me: ME, skipped, stories, event, now }) {
  const holder = (slot, id) => ({ pid: ME, slot, story: id, by: 'factory', at: now().toISOString() });
  const schemaFree = () => {
    const h = holderOf(SCHEMA(DIR));
    return !h || h.stale;
  };
  // Lets go of the schema token, every configured resource and every file lock this slot holds.
  // A file lock of this slot's is first kept for the highest-priority story waiting on it
  // (keepFreedFiles), so there is no moment when the file is free and not kept.
  function releaseToken(slot) {
    const fileLocks = new Set(fileLockFiles(DIR));
    const owned = [...slotLockFiles(DIR, CONFIG), ...fileLocks].map((file) => ({ file, h: holderOf(file) })).filter(({ h }) => [...OWN].some((pid) => ownsLock(h, slot, pid)));
    keepFreedFiles(owned.filter(({ file, h }) => fileLocks.has(file) && typeof h.path === 'string').map(({ h }) => ({ path: h.path, from: h.story })));
    for (const { file } of owned) rmSync(file, { force: true });
  }
  // The stories that could start now, best first: the ones that file reservations and yielding
  // rank. [] when the stories cannot be read.
  function fileWaiters() {
    try {
      const source = stories();
      return eligible(source.list(), { idPattern: source.idPattern, skip: [...claims(DIR).map((c) => c.id), ...skipped] }).sort(byPriority);
    } catch {
      return [];
    }
  }
  // Keeps freed files ([{ path, from }]) for the highest-priority story waiting on each, and logs one
  // event per story. It never throws: a failure here must not stop a slot's release.
  function keepFreedFiles(freed) {
    if (freed.length === 0) return;
    try {
      const byStory = new Map();
      for (const { path, story } of reserveFreed(DIR, { freed, waiters: fileWaiters(), now: now() })) byStory.set(story, [...(byStory.get(story) ?? []), path]);
      for (const [story, paths] of byStory) event(reserveText(story, paths.sort()), 'info');
    } catch {
      // The files are released all the same.
    }
  }
  // The test the automatic pick uses to leave a story out: it needs the schema token while another
  // story has it, a running story holds (or a reservation keeps) a file or resource it names, or it
  // names a file a higher-priority story's wait record names (yieldsTo). `waiters` is fileWaiters().
  const keptOut = ({ extra, free, waiters }) => (s) => (needsExclusive(s, extra) && !free) || waitBlocks(DIR, s.id) || yieldsTo(DIR, s, waiters) !== null;
  // Lets go of a story's claim when this process holds it (under any pid it owns).
  function releaseClaim(id) {
    const file = claimFile(DIR, id);
    const h = holderOf(file);
    if (OWN.has(h?.pid)) release(file, h.pid);
  }
  // Moves the factory's own claim and locks on a story from the slot it was pinned to (over the
  // worker count) to the slot taking it. The owner's claims stay where they are.
  function moveHolds(from, to, id) {
    for (const file of [claimFile(DIR, id), ...slotLockFiles(DIR, CONFIG), ...fileLockFiles(DIR)]) {
      const h = holderOf(file);
      if (!movable(h, { from, id, ours: (p) => OWN.has(p) })) continue;
      const { stale, ...rest } = h;
      forceSet(file, { ...rest, pid: ME, slot: to, at: now().toISOString() });
    }
  }
  // The claim for a story this supervisor is about to work on: taken fresh, or re-taken from a
  // run that died (a stale claim of the factory's own).
  function claim(slot, id) {
    const file = claimFile(DIR, id);
    const got = take(file, holder(slot, id));
    if (got.ok) return true;
    if (OWN.has(got.holder?.pid) && got.holder.slot === slot) {
      // Held under an adopted session's pid: taken again under this process's own.
      if (got.holder.pid !== ME) forceSet(file, holder(slot, id));
      return true;
    }
    if (got.stale && got.holder?.by !== 'owner') {
      forceSet(file, holder(slot, id));
      return true;
    }
    return false;
  }
  function takeTokenFor(slot, id) {
    const h = holderOf(SCHEMA(DIR));
    if (h && !h.stale && !(OWN.has(h.pid) && h.slot === slot)) return false;
    forceSet(SCHEMA(DIR), holder(slot, id));
    return true;
  }
  return { holder, schemaFree, releaseToken, fileWaiters, keptOut, releaseClaim, moveHolds, claim, takeTokenFor };
}
