// Telling the project's story source that something happened to a story, outside
// `foreman story`: the ship `pr` step raises `review` once the pull request is open. A Jira
// source comments and moves the issue; a markdown source ignores the event.
//
//   raiseStoryEvent({ root, env, now }, id, event, note) -> { ok: true } | { ok: false, error }
//
// It never throws: a story source that cannot be opened, or a story it does not know, is
// an answer the caller turns into an event, never a failed step.

import { openProjectStories } from './story-source.mjs';

export function raiseStoryEvent({ root, env = process.env, now } = {}, id, event, note) {
  try {
    if (!root) return { ok: false, error: 'no project folder' };
    if (!id) return { ok: false, error: 'no story id' };
    const source = openProjectStories({ root, env, now });
    return source.update(id, { event, ...(note ? { note } : {}) }) ? { ok: true } : { ok: false, error: `no such story: ${id}` };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}
