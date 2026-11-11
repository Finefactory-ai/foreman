// What an automatic resume does for a story that may need no session any more, and the merged-PR
// look-up it and the watchdog share. The supervisor passes in what touches the world (gh, the
// story source, the slot's files, the event feed), so this module touches no file or process
// and its error paths have tests.
//
//   mergedAfter   whether a pull request merged after a story's last rollback (always, with none)
//   rolledBackAtOf
//                 when the pack says the story's release was rolled back, or null
//   mergedPrOf    the merged pull request of a story's branch: its url, the branch when gh gives
//                 none, or null when none merged, none merged after the story's rollback, or gh
//                 cannot tell. Never throws.
//   mergedPrOfAsync
//                 the same look-up with an async gh (the supervisor's, which holds no loop);
//                 gh resolves { status, stdout }. It never rejects.
//   closeInstead  closes the slot instead of resuming (marking the story done first when only its
//                 pull request merged) and says true; false to start the session. The start
//                 that makes an environment first uses it too (`instead: 'environment'`).
//   checkBeforeEnv
//                 whether a start looks for a shipped story before it makes an environment

import { resumeCheck, SETTLED } from './scheduler.mjs';

const MERGED_ARGS = (branch) => ['pr', 'list', '--head', branch, '--state', 'merged', '--json', 'url,mergedAt', '--limit', '10'];

// Whether a pull request merged at `mergedAt` counts as shipped given the story's last rollback
// time: always when none is recorded, else only when it merged after it. A merge time that cannot
// be read does not count once a rollback is recorded.
export function mergedAfter(mergedAt, rolledBackAt) {
  if (rolledBackAt === null || rolledBackAt === undefined) return true;
  const merged = Date.parse(mergedAt);
  if (Number.isNaN(merged)) return false;
  return merged > Date.parse(rolledBackAt);
}

// When the pack says the story's last release was rolled back (pack.rolledBackAt, an ISO time), or
// null: no pack, no such member, a throw or a value that is not a readable time.
export function rolledBackAtOf(pack, { dir, story }) {
  try {
    const at = pack?.rolledBackAt?.({ dir, story });
    return typeof at === 'string' && !Number.isNaN(Date.parse(at)) ? at : null;
  } catch {
    return null;
  }
}

// gh's merged list, read: null for an empty list or a non-list, and for a pull request that merged
// before the rollback; else the url of the newest merge (the branch when it has none). The newest
// is the entry with the greatest readable mergedAt, else the first.
function shipped(stdout, branch, rolledBackAt) {
  const list = JSON.parse(stdout);
  if (!Array.isArray(list) || !list.length) return null;
  let chosen = list[0];
  let best = Number.NEGATIVE_INFINITY;
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue;
    const t = Date.parse(entry.mergedAt);
    if (!Number.isNaN(t) && t > best) {
      best = t;
      chosen = entry;
    }
  }
  if (!mergedAfter(chosen?.mergedAt, rolledBackAt)) return null;
  return chosen?.url || branch;
}

// `gh(args)` runs gh and gives { status, stdout }. `rolledBackAt`: see mergedAfter.
export function mergedPrOf(branch, gh, { rolledBackAt = null } = {}) {
  try {
    const r = gh(MERGED_ARGS(branch));
    if (r.status !== 0) return null;
    return shipped(r.stdout, branch, rolledBackAt);
  } catch {
    return null;
  }
}

// The same, for a gh that answers later. A rejection, a throw, a non-zero status (a time-out
// gives null) or bad JSON gives null.
export async function mergedPrOfAsync(branch, gh, { rolledBackAt = null } = {}) {
  try {
    const r = await gh(MERGED_ARGS(branch));
    if (r.status !== 0) return null;
    return shipped(r.stdout, branch, rolledBackAt);
  } catch {
    return null;
  }
}

// statusOf(id): the story's status, null when unknown. mergedPr(id): as mergedPrOf. markDone(pr):
// marks the story done in its source; a throw is a warn event and the slot is still closed.
// close(): lets go of the claim, token, crash count and checkpoint, and sets the slot idle.
// event(text, kind): adds an event for the slot. In order: the warn, the close, the info.
// `instead` says what the slot was about to do, and only changes the event texts: 'resume' (the
// default) or 'environment' (a start that would make or reset an environment first).
export function closeInstead(id, { statusOf, mergedPr, markDone, close, event, instead = 'resume' }) {
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
  const text =
    instead === 'environment'
      ? action === 'close'
        ? `${id} is already ${status}; closed it with no environment made.`
        : `${id}: its pull request merged; marked it done with no environment made.`
      : action === 'close'
        ? `${id} is already ${status}; not resuming it.`
        : `${id}: its pull request merged; marked it done instead of resuming it.`;
  event(text, 'info');
  return true;
}

// Whether a start looks for a shipped story before it makes an environment: only with an adapter
// that makes one, and only for a plain start. The modes `group-summary` (shipped by design),
// `fresh` (the owner asked for a restart) and `after-halt` (the skill checks health) never wait.
export function checkBeforeEnv({ adapter, mode } = {}) {
  return (adapter ?? 'none') !== 'none' && !mode;
}
