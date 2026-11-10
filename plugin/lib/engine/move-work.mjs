// What starting queued work does when the work was rehomed from a slot over the worker count
// (slot-work.mjs rehome): the order of the steps, and what each failure leaves behind. The
// supervisor passes in everything that touches the world (the slots' folders, the claim files,
// the story source, the event feed), so this module touches no file or process and every path
// has a fast test.
//
//   takeOver  decides, step by step, whether the work starts in the slot. The new slot's folder
//             must be fit to use first; the holds follow the work; the claim is checked before the
//             old folder is touched, so a story this factory does not hold is left alone; only
//             then is the old folder saved and detached. Once the work has moved it no longer
//             carries `from`, so a retry after a failed start is a plain resume.

import { slotNumber } from './slot-work.mjs';

// d: { workers, branch, folderReady(), moveHolds(from), claim(), closed(),
//      freeFolder(from) -> { freed, committed, problem }, letGo(), event(text, kind) }
// Says 'wait' (requeue the work untouched), 'refused' (the story is held by someone else),
// 'closed' (the resume needed no session), 'let-go' (the old folder could not be freed, so the
// story is released) or 'start' (launch the session).
export function takeOver(w, slot, d) {
  const from = w.from && w.from !== slot ? w.from : null;
  if (from) {
    if (!d.folderReady()) return 'wait';
    d.moveHolds(from);
    // The old folder is touched only for a story this factory holds.
    if (!d.claim()) {
      d.event(`${w.id} is held by someone else; not resuming it.`, 'warn');
      return 'refused';
    }
  }
  if (d.closed()) return 'closed';
  if (from && slotNumber(from)) {
    const r = d.freeFolder(from);
    if (!r.freed) {
      d.event(`${w.id} could not move from ${from} to ${slot}: ${r.problem}; let go of it, so it is picked again by priority.`, 'warn');
      d.letGo();
      return 'let-go';
    }
    d.event(`${w.id} moved from ${from} to ${slot}${(slotNumber(from) ?? Infinity) > d.workers ? `, as ${from} is over the worker count` : ''}${r.committed ? `; its unfinished work in ${from} is committed on ${d.branch}` : ''}.`, 'info');
  }
  // The move is done: a retry after a failed launch is a plain resume.
  delete w.from;
  if (!d.claim()) {
    d.event(`${w.id} is held by someone else; not resuming it.`, 'warn');
    return 'refused';
  }
  return 'start';
}
