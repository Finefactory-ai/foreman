// How `foreman run N` counts, and the words that say so. N counts the new stories the run picks.
// The stories an earlier run left in hand (start-up recovery queues them: a resume, a release to
// finish, a story to close; and a fresh start adopts the live sessions a killed supervisor left
// running) are resumed first, on top of the N, and do not count towards it.
// Pure: the dry run, the supervisor, the snapshot and `foreman status` use it. It imports no part
// of the supervisor.

import { recoveryWords } from './reconcile.mjs';

const stories = (n) => (n === 1 ? 'story' : 'stories');

// The ids, once each, of the stories in hand at a fresh start: first the live sessions it adopted
// (`kept`, as adoptLive records them), then the work start-up recovery queued (`work`).
export function inHandAtStart({ kept, work } = {}) {
  const ids = [];
  for (const list of [kept, work]) {
    if (!Array.isArray(list)) continue;
    for (const e of list) if (e && typeof e === 'object' && typeof e.id === 'string') ids.push(e.id);
  }
  return [...new Set(ids)];
}

// The ids, once each in plan order, of the plan's actions that become queued work.
export function leftInHand(plan) {
  if (!Array.isArray(plan)) return [];
  const ids = plan.filter((a) => a && Object.hasOwn(recoveryWords, a.type) && typeof a.id === 'string').map((a) => a.id);
  return [...new Set(ids)];
}

// What the run says at its start, or null when nothing is left in hand or no number was asked for.
export function resumedLine({ max, count }) {
  if (!(max > 0) || !(count > 0)) return null;
  return `${count} ${stories(count)} left in hand ${count === 1 ? 'is' : 'are'} resumed first, on top of the ${max} asked for: ${count === 1 ? 'it does' : 'they do'} not count towards ${max === 1 ? 'it' : 'them'}.`;
}

// The stop text for a run that started its N stories; resumedShipped is how many resumed stories shipped too.
export function reachedLine({ max, resumedShipped }) {
  const text = `Reached the ${max} ${stories(max)} asked for`;
  return resumedShipped > 0 ? `${text}; ${resumedShipped} resumed ${stories(resumedShipped)} also shipped.` : `${text}.`;
}

// The snapshot's { max, resumed } from state.json's `asked`: none once the run stops or when it is malformed.
export function askedOf(state) {
  if (state?.loop?.state === 'stopped') return null;
  const a = state?.asked;
  if (!a || !Number.isInteger(a.max) || a.max < 0 || !Array.isArray(a.resumed) || !a.resumed.every((id) => typeof id === 'string')) return null;
  return { max: a.max, resumed: a.resumed };
}

// The `foreman status` line, or null unless a run with a number has stories resumed on top.
export function askedText(asked) {
  if (!asked || !(asked.max > 0) || !Array.isArray(asked.resumed) || asked.resumed.length === 0) return null;
  return `Stories: ${asked.max} asked for, ${asked.resumed.length} resumed on top (${asked.resumed.join(', ')})`;
}
