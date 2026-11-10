// Answering a bundle of Waiting on you decisions in one go: the dashboard's
// POST /api/waiting/bundle/<name>. A bundle is every unanswered decision that waiting.mjs
// bundleOf puts under one name: 'follow-ups' (`foreman learn`'s follow-up proposals) or
// 'traits' (its trait proposals).
//
//   create-all   answers each one with the first option `foreman learn` asks with
//                (answers.mjs OPTIONS): Create a follow-up story, or Add as a trait
//   ignore-all   answers each one Ignore
//
// Each answer goes through decisions.answer, as one answered by hand would. The supervisor then
// applies them as it applies any answer (answers.mjs, `foreman learn apply|ignore <id>`).
// Answered and applied items are skipped, and one that cannot be answered is reported and does
// not stop the others.

import { OPTIONS } from '../engine/answers.mjs';
import * as decisions from './decisions.mjs';
import { bundleOf } from './waiting.mjs';

export const BUNDLES = Object.freeze({
  'follow-ups': Object.freeze({ 'create-all': OPTIONS.followUp[0], 'ignore-all': 'Ignore' }),
  traits: Object.freeze({ 'create-all': OPTIONS.trait[0], 'ignore-all': 'Ignore' }),
});

export const BUNDLE_ACTIONS = Object.freeze(['create-all', 'ignore-all']);

// Answers every unanswered item of the bundle `name` with `action`'s option. Throws a plain
// Error, which never repeats what it was sent (it comes from the URL), for an unknown name or
// action. Returns { answered: [ids], failed: [{ id, error }] }; a system error's text is never
// passed on, because it can name a file path.
export function answerBundle(dir, name, action, now = new Date()) {
  if (typeof name !== 'string' || !Object.hasOwn(BUNDLES, name)) throw new Error(`Unknown bundle; one of ${Object.keys(BUNDLES).join(', ')}.`);
  if (typeof action !== 'string' || !BUNDLE_ACTIONS.includes(action)) throw new Error(`Unknown action; one of ${BUNDLE_ACTIONS.join(', ')}.`);
  const option = BUNDLES[name][action];
  const answered = [];
  const failed = [];
  for (const item of decisions.pending(dir)) {
    if (item.answer || bundleOf(item) !== name) continue;
    try {
      decisions.answer(dir, item.id, { option }, now);
      answered.push(item.id);
    } catch (err) {
      failed.push({ id: item.id, error: err?.code ? 'Could not save the answer; see the run log.' : String(err?.message ?? err) });
    }
  }
  return { answered, failed };
}

// The line the dashboard shows after a bundle answer.
export function bundleMessage({ answered, failed }) {
  if (!answered.length && !failed.length) return 'Nothing left to answer here.';
  if (!failed.length) return `Answered ${answered.length}.`;
  return `Answered ${answered.length}; ${failed.length} could not be answered.`;
}
