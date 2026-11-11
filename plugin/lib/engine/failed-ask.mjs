// The decision the supervisor raises when a story ends `failed` and nothing else is open for it:
// "<ID> could not be released", with Retry the release, I'll take it and Drop (answers.mjs
// applies them). Pure: the caller reads the pending items and adds the item this returns.
//
//   failedAsk({ id, title, reason, pr, cause, pending, earlierFailures })
//     → null when an item about the story is already open (the session's own "could not pass
//       review", a "Decide for <ID>", a task, an earlier "could not be released"), else the item
//       for `decisions.add`. The proposals and notes about a story (depends, waits, trait,
//       follow-up, learned, rolled back, created) do not count as open for it.
//
//   resumesByItself(story, { idPattern })
//     → true when the picker takes the story again without the owner: it is to do, in progress
//       or done, or blocked on another story (the run picks it once that ships). False for no
//       story, an unknown status, a story blocked for a reason in words, and a blocked story when
//       there is no idPattern to read its blockers with. Only then is the owner asked.
//
//   releaseAsksFor(pending, id)
//     → the "<ID> could not be released" items still open for the story, answered or not, so a
//       story that shipped can have them closed before a stale answer runs against it.

import { kindOf, OPTIONS, releaseTitle } from './answers.mjs';
import { waitsOnStories } from './pick.mjs';

const NOT_ASKS = ['depends', 'waits', 'trait', 'followUp', 'learned', 'rolledBack', 'created'];
const SUMMARY_MAX = 160;
const PART_MAX = 280;

const oneLine = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const cut = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

export function resumesByItself(story, { idPattern } = {}) {
  const status = story?.status;
  if (status === 'todo' || status === 'in-progress' || status === 'done') return true;
  if (status !== 'blocked' || typeof idPattern !== 'string' || !idPattern) return false;
  return waitsOnStories(story.blockedBy, { idPattern });
}

export function releaseAsksFor(pending, id) {
  return (Array.isArray(pending) ? pending : []).filter((item) => item?.story === id && !item.appliedAt && kindOf(item) === 'release');
}

export function failedAsk({ id, title = '', reason = '', pr = '', cause = 'story', pending = [], earlierFailures = 0 } = {}) {
  const open = (Array.isArray(pending) ? pending : []).some((p) => p?.story === id && !p.appliedAt && !NOT_ASKS.includes(kindOf(p)));
  if (open) return null;

  const why = oneLine(reason);
  const notAtFault = cause === 'environment' || /not at fault/i.test(why);
  const take = !notAtFault && earlierFailures > 0;
  const recommend = take ? OPTIONS.release[1] : OPTIONS.release[0];
  const name = oneLine(title);

  const body = [
    `Reason: ${why || 'none given'}`,
    ...(oneLine(pr) ? [`Pull request: ${oneLine(pr)}`] : []),
    notAtFault ? 'Cause: the environment; the code is not at fault' : 'Cause: the story',
  ].join('\n');

  return {
    story: id,
    kind: 'decision',
    title: releaseTitle(id),
    options: [...OPTIONS.release],
    hints: [
      'Puts it back in line; it resumes from its built branch and ships again.',
      'You take the story over; the run leaves it alone until you hand it back.',
      "Closes the story's pull requests, deletes its branch and blocks it.",
    ],
    recommend,
    summary: cut(`${id} failed: ${why || 'no reason given'}`, SUMMARY_MAX),
    body,
    explain: {
      purpose: cut(`Story ${id}${name ? `: ${name}` : ''}.`, PART_MAX),
      happened: notAtFault
        ? 'The story was built, but its release stopped for a reason outside its code, so it did not ship.'
        : 'The story ended without shipping; the reason is in the summary and under Details.',
      recommendation: notAtFault
        ? 'Retry the release: the code is not at fault, so once the cause is gone the built branch can ship as it is.'
        : take
          ? "I'll take it: the story has failed before, so another try would likely meet the same problem."
          : 'Retry the release: one more try from the built branch may get it through.',
    },
  };
}
