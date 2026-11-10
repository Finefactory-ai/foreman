// Jira calls for code that cannot wait on a promise. Story sources are synchronous (the
// supervisor, the dashboard and the CLI all call list() and brief() without await), but
// fetch is not, so the Jira story source runs each read in a child Node process and waits for
// it with spawnSync. One child does a whole job (a full search with its pages and lookups, or
// one brief), so a poll costs one process start.
//
//   runJiraSync('snapshot', { site, env, args: { jql } })        -> readSnapshot's answer
//   runJiraSync('brief', { site, env, args: { key, doneWhenField } }) -> readBrief's answer
//   runJiraSync('writes', { site, env, args: { ops } })            -> sendWrites's answer
//   runJiraSync('create', { site, env, args: { origin, title, ... } }) -> createIssue's answer
//
// A job gets `timeoutMs` (TIMEOUT_MS, 30 s, by default) to finish; a CLI command never waits
// on Jira longer than that per call.
//
// `env` is what the Jira client reads (HOME for the token file, JIRA_CLIENT_ID and
// JIRA_CLIENT_SECRET for a refresh, FOREMAN_JIRA_*_BASE). It goes to the child on stdin,
// never on the command line. An error in the child comes back as an error here, with its
// name and status; a lapsed sign-in is a JiraLoginExpired.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JiraLoginExpired } from './auth.mjs';

const WORKER = fileURLToPath(new URL('./sync-worker.mjs', import.meta.url));
// Three tries with the default Retry-After wait of 5 s fit inside this.
export const TIMEOUT_MS = 30_000;

function revive(error = {}) {
  if (error.name === 'JiraLoginExpired') return new JiraLoginExpired(error.message);
  const err = new Error(error.message ?? 'Jira call failed');
  err.name = error.name ?? 'Error';
  if (error.status !== undefined) err.status = error.status;
  return err;
}

export function runJiraSync(job, { site, env = process.env, args = {}, timeoutMs = TIMEOUT_MS }) {
  const r = spawnSync(process.execPath, [WORKER], {
    input: JSON.stringify({ job, site, env, args }),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: timeoutMs,
  });
  if (r.error) throw new Error(r.error.code === 'ETIMEDOUT' ? `Jira did not answer within ${Math.round(timeoutMs / 1000)} s` : `Jira ${job} did not finish: ${r.error.message}`);
  let out;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    const why = String(r.stderr ?? '').trim().split('\n').filter(Boolean).pop();
    throw new Error(`Jira ${job} gave no answer${why ? `: ${why}` : ''}`);
  }
  if (!out?.ok) throw revive(out?.error);
  return out.value;
}
