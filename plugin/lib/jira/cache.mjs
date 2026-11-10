// The poll cache of the Jira story source: <stateDir>/jira/list.json holds the last answer to
// the JQL, { version, site, jql, fetchedAt, issues, outside } (issues and outside as
// readSnapshot in issues.mjs gives them). The story source reads and writes it from the CLI;
// the supervisor's refresher (refresher.mjs) writes it on its own timer.
//
// Also here: the env the Jira client sees, for JIRA_CLIENT_ID and JIRA_CLIENT_SECRET when a
// token needs a refresh: the process env, over the registry names in Foreman's own keys file
// (.env.foreman; no other name from it), over the project's env file. It is handed to the
// client only, never put into process.env.

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from '../adapters/stories/overlay.mjs';
import { readText } from '../engine/read-cache.mjs';
import { parseEnvFile } from '../engine/env-text.mjs';
import { FOREMAN_KEYS } from '../engine/foreman-keys.mjs';

export const CACHE_VERSION = 1;

export const listCacheFile = (stateDir) => join(stateDir, 'jira', 'list.json');

/** The cached answer for this site and JQL, of any age, or null. */
export function readListCache(stateDir, { site, jql }) {
  try {
    const c = JSON.parse(readText(listCacheFile(stateDir)));
    return c?.version === CACHE_VERSION && c.site === site && c.jql === jql && Array.isArray(c.issues) ? c : null;
  } catch {
    return null;
  }
}

export function writeListCache(stateDir, { site, jql, fetchedAt, issues, outside }) {
  const entry = { version: CACHE_VERSION, site, jql, fetchedAt, issues, outside: outside ?? {} };
  writeAtomic(listCacheFile(stateDir), `${JSON.stringify(entry)}\n`);
  return entry;
}

export const clearListCache = (stateDir) => rmSync(listCacheFile(stateDir), { force: true });

/** The process env over Foreman's keys in foremanEnvFile over the project's env file. */
export function jiraEnv(env = process.env, envFile, foremanEnvFile) {
  const own = parseEnvFile(foremanEnvFile);
  const registry = Object.fromEntries(FOREMAN_KEYS.filter((name) => own[name]).map((name) => [name, own[name]]));
  return { ...parseEnvFile(envFile), ...registry, ...env };
}
