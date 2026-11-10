// The control files a run leaves behind that nothing will ever settle, and the one clean-up of
// them. `foreman run` and `foreman doctor` call it, so the owner reads no request or voucher that
// is no longer true.
//
//   staleControl(dir, { alive }) -> { nextStory, adopted }
//       nextStory   { id, requestedAt } when control.json keeps a build-next request that
//                   state.json's handledNextAt settled already, or that has no requestedAt (nothing
//                   can settle that); else null
//       adopted     { by } when supervisor-adopted.json vouches for a pid that is gone (`alive`
//                   says so), or { by: null } when it cannot be read; else null
//       `alive` defaults to supervisor-pid.mjs pidExists, never defaultAlive: the voucher may be
//       run.mjs's loop, not a supervisor. It only reads.
//   staleParts({ nextStory, adopted }) -> the words for each stale part, for a doctor that only
//       reports (inside a story session)
//   clearStaleControl(dir, { alive, now }) -> { cleared: [part, ...] }
//       removes what is stale and writes exactly one info event, "Cleared stale control: ...",
//       naming each part. nextStory goes through console/control.mjs clearNextStory, which only
//       removes the request it was shown (a newer one stays, and its part is not named); the
//       adopted file goes only while it still vouches for the same dead pid, or is still
//       unreadable. With nothing stale it writes nothing.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { clearNextStory, readControl } from '../console/control.mjs';
import { addEvent, readState } from './state.mjs';
import { ADOPTED_FILE, clearAdopted, dropAdopted, pidExists, readAdopted } from './supervisor-pid.mjs';

const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

export function staleControl(dir, { alive = pidExists } = {}) {
  const control = readControl(dir);
  let next = null;
  if (nonEmpty(control.nextStory)) {
    const settled = typeof control.requestedAt !== 'string' || readState(dir).handledNextAt === control.requestedAt;
    if (settled) next = { id: control.nextStory, requestedAt: control.requestedAt };
  }
  let adopted = null;
  if (existsSync(join(dir, ADOPTED_FILE))) {
    const vouch = readAdopted(dir);
    if (!vouch) adopted = { by: null };
    else if (!alive(vouch.by)) adopted = { by: vouch.by };
  }
  return { nextStory: next, adopted };
}

const nextPart = (n) => `the build-next request for ${String(n.id).slice(0, 40)}, already handled`;
const adoptedPart = (a) => (a.by === null ? 'supervisor-adopted.json, which could not be read' : `supervisor-adopted.json, which vouched for pid ${a.by} that is gone`);

export function staleParts({ nextStory, adopted }) {
  return [...(nextStory ? [nextPart(nextStory)] : []), ...(adopted ? [adoptedPart(adopted)] : [])];
}

export function clearStaleControl(dir, { alive = pidExists, now = new Date() } = {}) {
  const { nextStory, adopted } = staleControl(dir, { alive });
  const parts = [];
  if (nextStory && clearNextStory(dir, nextStory)) {
    parts.push(nextPart(nextStory));
  }
  if (adopted) {
    if (adopted.by === null) {
      if (readAdopted(dir) === null) dropAdopted(dir);
    } else {
      clearAdopted(dir, adopted.by);
    }
    if (!existsSync(join(dir, ADOPTED_FILE))) {
      parts.push(adoptedPart(adopted));
    }
  }
  if (parts.length) addEvent(dir, `Cleared stale control: ${parts.join('; ')}.`, 'info', now);
  return { cleared: parts };
}
