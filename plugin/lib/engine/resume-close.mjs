// What an automatic resume does for a story that may need no session any more, and the merged-PR
// look-up it and the watchdog share. The supervisor passes in what touches the world (gh, the
// story source, the slot's files, the event feed), so this module touches no file or process
// and its error paths have tests.
//
//   mergedPrOf    the merged pull request of a story's branch: its url, the branch when gh gives
//                 none, or null when none merged or gh cannot tell. Never throws.
//   mergedPrOfAsync
//                 the same look-up with an async gh (the supervisor's, which holds no loop);
//                 gh resolves { status, stdout }. It never rejects.
//   closeInstead  closes the slot instead of resuming (marking the story done first when only its
//                 pull request merged) and says true; false to start the session

import { resumeCheck, SETTLED } from './scheduler.mjs';

// `gh(args)` runs gh and gives { status, stdout }.
export function mergedPrOf(branch, gh) {
  try {
    const r = gh(['pr', 'list', '--head', branch, '--state', 'merged', '--json', 'url', '--limit', '1']);
    if (r.status !== 0) return null;
    const list = JSON.parse(r.stdout);
    if (!Array.isArray(list) || !list.length) return null;
    return list[0]?.url || branch;
  } catch {
    return null;
  }
}

// The same, for a gh that answers later. A rejection, a throw, a non-zero status (a time-out
// gives null) or bad JSON gives null.
export async function mergedPrOfAsync(branch, gh) {
  try {
    const r = await gh(['pr', 'list', '--head', branch, '--state', 'merged', '--json', 'url', '--limit', '1']);
    if (r.status !== 0) return null;
    const list = JSON.parse(r.stdout);
    if (!Array.isArray(list) || !list.length) return null;
    return list[0]?.url || branch;
  } catch {
    return null;
  }
}

// statusOf(id): the story's status, null when unknown. mergedPr(id): as mergedPrOf. markDone(pr):
// marks the story done in its source; a throw is a warn event and the slot is still closed.
// close(): lets go of the claim, token, crash count and checkpoint, and sets the slot idle.
// event(text, kind): adds an event for the slot. In order: the warn, the close, the info.
export function closeInstead(id, { statusOf, mergedPr, markDone, close, event }) {
  const status = statusOf(id);
  const pr = SETTLED.includes(status) ? null : mergedPr(id);
  const action = resumeCheck({ status, merged: pr !== null });
  if (action === 'start') return false;
  if (action === 'mark-done') {
    try {
      markDone(pr);
    } catch (err) {
      event(`${id}: could not mark it done: ${String(err?.message ?? err).slice(0, 200)}`, 'warn');
    }
  }
  close();
  event(action === 'close' ? `${id} is already ${status}; not resuming it.` : `${id}: its pull request merged; marked it done instead of resuming it.`, 'info');
  return true;
}
