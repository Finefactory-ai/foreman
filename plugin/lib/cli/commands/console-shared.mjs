// What the owner's commands share: the project's config and state folder, and the story-id check.

import { loadResolved, loadResolvedOrLastGood } from '../../settings/load.mjs';

export { STORY_ID } from '../../console/commands.mjs';

const errorLines = (errors) => errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message));

// { config, dir }, or null after writing why to stderr. `config` has the local settings layer
// on top (lib/settings/load.mjs). With `lastGood` (only `foreman status`), an invalid file
// gives the last good config while a run is on it, after saying so on stderr.
export function openProject({ root, env, stderr, lastGood = false }) {
  const loaded = lastGood ? loadResolvedOrLastGood(root, { env }) : loadResolved(root, { env });
  const { config, errors, dir } = loaded;
  if (!config) {
    stderr.write(`${errors.map((e) => (e.path ? `foreman.config.json ${e.path}: ${e.message}` : e.message)).join('\n')}\n`);
    return null;
  }
  if (loaded.lastGood) stderr.write(`foreman.config.json is invalid (${errorLines(loaded.invalid ?? []).join('; ')}); showing the run on the last good config.\n`);
  return { config, dir };
}
