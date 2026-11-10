// The project's config as every reader should see it: foreman.config.json with the defaults
// merged in, then this machine's local layer (<stateDir>/settings.json) on top through
// configWithLocal. Never throws.
//
//   loadResolved(root, { env })   { config, team, dir, errors, warnings, localWarnings, file }
//
//   config         the resolved config, or null when foreman.config.json is invalid
//   team           the config without the local layer
//   dir            the state folder (FOREMAN_STATE_DIR wins), where the local layer lives
//   warnings       what foreman.config.json has that is deprecated
//   localWarnings  why a local value, or the whole settings file, is ignored
//
//   loadResolvedOrLastGood(root, { env })
//
// The same, except while a running supervisor is on the last good config (state.json has
// configProblem and the state folder has config.last-good.json, engine/config-health.mjs): an
// invalid foreman.config.json then gives that config, with the local layer on top, plus
// `lastGood: true` and `invalid` (the file's errors). The state folder is the one the invalid
// file names when it parses (FOREMAN_STATE_DIR wins). Otherwise it is loadResolved's answer.
// Only the status readers use it: `foreman status`, `foreman notify`, and the board's story list
// (engine/state.mjs snapshot and ownerWaiting, through story-source.mjs openProjectStories with
// lastGood). Every other command refuses an invalid file.
//
// `readFile` and `packs` (the pack registry, plugin/packs/index.mjs) stand in for the real
// ones in tests.

import fs from 'node:fs';
import { join } from 'node:path';
import { CONFIG_FILE, loadConfig } from '../config/load.mjs';
import { readLastGood, runOnLastGood } from '../engine/config-health.mjs';
import { stateDir } from '../engine/paths.mjs';
import { readLocal } from './local.mjs';
import { checkLocal, configWithLocal } from './resolve.mjs';

export function loadResolved(root, { env = process.env, readFile, packs } = {}) {
  const loaded = loadConfig(root, { ...(readFile ? { readFile } : {}), ...(packs ? { packs } : {}) });
  if (!loaded.config) return { ...loaded, team: null, dir: null, warnings: [], localWarnings: [] };
  const dir = stateDir(root, loaded.config, env);
  const local = readLocal(dir);
  return {
    ...loaded,
    config: configWithLocal(loaded.config, local.values),
    team: loaded.config,
    dir,
    localWarnings: [...local.warnings, ...checkLocal(loaded.config, local.values).warnings],
  };
}

// The state folder an invalid file names, when it parses and names one.
function guessStateDir(root, readFile) {
  try {
    const raw = JSON.parse(readFile(join(root, CONFIG_FILE), 'utf8'));
    return raw && typeof raw.stateDir === 'string' ? { stateDir: raw.stateDir } : null;
  } catch {
    return null;
  }
}

export function loadResolvedOrLastGood(root, { env = process.env, readFile, packs } = {}) {
  const loaded = loadResolved(root, { env, readFile, packs });
  if (loaded.config) return loaded;
  const dir = stateDir(root, guessStateDir(root, readFile ?? fs.readFileSync), env);
  const team = runOnLastGood(dir) ? readLastGood(dir) : null;
  if (!team) return loaded;
  const local = readLocal(dir);
  return {
    config: configWithLocal(team, local.values),
    team,
    dir,
    errors: [],
    invalid: loaded.errors,
    lastGood: true,
    warnings: [],
    localWarnings: [...local.warnings, ...checkLocal(team, local.values).warnings],
    file: loaded.file,
  };
}
