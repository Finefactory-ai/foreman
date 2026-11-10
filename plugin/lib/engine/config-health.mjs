// What the run keeps when foreman.config.json turns invalid under it: the last config that
// passed validation, saved in the state folder, and the problem the supervisor records in
// state.json while it runs on that copy.
//
//   LAST_GOOD_FILE               config.last-good.json in the state folder
//   saveLastGood(dir, team)      writes the team config (no local layer) through a temp file
//   readLastGood(dir)            the saved config, or null
//   runOnLastGood(dir)           state.json's configProblem { since, reason } while the run is on
//                                the last good config, else null
//   configProblemWhy(p, now)     "config invalid since HH:MM: <reason>; running on the last good
//                                config", HH:MM local time of `since` (else `now`), the reason cut
//                                to 300 characters
//
// Only file reads and writes; it never imports state.mjs, which runs git at import time.

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readText } from './read-cache.mjs';

export const LAST_GOOD_FILE = 'config.last-good.json';

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

export function saveLastGood(dir, team) {
  const file = join(dir, LAST_GOOD_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(team, null, 2)}\n`);
  renameSync(tmp, file);
}

export function readLastGood(dir) {
  const saved = readJson(join(dir, LAST_GOOD_FILE));
  return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : null;
}

export function runOnLastGood(dir) {
  let state = null;
  try {
    state = JSON.parse(readText(join(dir, 'state.json')));
  } catch {
    // a missing or bad state.json holds no problem
  }
  const problem = state?.configProblem;
  return problem && typeof problem === 'object' && typeof problem.reason === 'string' ? problem : null;
}

const pad = (n) => String(n).padStart(2, '0');

export function configProblemWhy({ since, reason } = {}, now = new Date()) {
  const at = new Date(since);
  const when = Number.isNaN(at.getTime()) ? new Date(now) : at;
  return `config invalid since ${pad(when.getHours())}:${pad(when.getMinutes())}: ${String(reason ?? '').slice(0, 300)}; running on the last good config`;
}
