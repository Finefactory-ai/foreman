// The environment the supervisor gave a slot's story session, kept in a file so `foreman checks`
// can run a project's checks in that environment and not in whatever the calling shell has set
// (cli/commands/checks.mjs). A check run under the session's own environment is the same run for
// every agent of the session, so its record can be shared (check-runs.mjs).
//
// The file is <stateDir>/session-config/<slot>-env.json, next to the slot's settings and MCP
// files (session.mjs). It holds the env session.command() returns less SESSION_KEYS (a project's
// checks do not need the Claude sign-in), as one JSON object of strings, and is written with mode 600 like the settings file, which can already hold the user's
// env and keys. The anchor guard (anchor-files.mjs) denies the plain ways an agent could write
// it; the guard is best effort, and a changed file is also caught here: it must carry the
// caller's own FOREMAN_RUN, FOREMAN_SLOT, FOREMAN_STATE_DIR and FOREMAN_STORY.
//
//   SESSION_CONFIG_DIR -> the folder's name inside the state folder; the anchor guard protects all of it
//   sessionEnvPath(stateDirPath, slot) -> the file's path
//   readSessionEnv(callerEnv, { readFile }) -> { env, why }
//       env is a fresh copy of the session's environment; why is null when it was read. Outside a
//       story session (FOREMAN_RUN is not "1") both are null: that is not an error. In a session
//       that cannot read its file, env is null and why says what was wrong.
//
// Imports only node:fs and node:path, so anchor-files.mjs can import it and stay pure.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SLOT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/;
const SAME = ['FOREMAN_RUN', 'FOREMAN_SLOT', 'FOREMAN_STATE_DIR', 'FOREMAN_STORY'];

export const SESSION_CONFIG_DIR = 'session-config';
export const sessionEnvPath = (stateDirPath, slot) => join(stateDirPath, SESSION_CONFIG_DIR, `${slot}-env.json`);

export function readSessionEnv(callerEnv, { readFile = (p) => readFileSync(p, 'utf8') } = {}) {
  if (callerEnv?.FOREMAN_RUN !== '1') return { env: null, why: null };
  const dir = callerEnv.FOREMAN_STATE_DIR;
  const slot = callerEnv.FOREMAN_SLOT;
  if (typeof dir !== 'string' || dir === '' || typeof slot !== 'string' || !SLOT.test(slot)) {
    return { env: null, why: 'FOREMAN_SLOT or FOREMAN_STATE_DIR is not set' };
  }
  const path = sessionEnvPath(dir, slot);
  let parsed;
  try {
    parsed = JSON.parse(readFile(path));
  } catch (err) {
    return { env: null, why: `cannot read ${path}: ${err.message}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.values(parsed).every((v) => typeof v === 'string')) {
    return { env: null, why: 'it is not an environment' };
  }
  if (SAME.some((key) => parsed[key] !== callerEnv[key])) {
    return { env: null, why: `it belongs to another session: for ${parsed.FOREMAN_STORY ?? 'no story'} in ${parsed.FOREMAN_SLOT ?? 'no slot'}` };
  }
  return { env: { ...parsed }, why: null };
}
