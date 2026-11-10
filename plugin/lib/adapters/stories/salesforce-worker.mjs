// The child process behind the supervisor's Salesforce refresher (salesforce-refresher.mjs).
// The supervisor never waits on sf, so the sf calls of a poll run here, in a process of their own.
//
//   runJob({ job, root, options, stateDir, env, features, salesforceOrgs, id }, { sh, now })
//     job 'refresh'  one poll, ignoring pollSeconds: the cache is written and the outbox sent;
//                    gives { count: the number of Cases }
//     job 'drain'    sends the outbox; gives undefined
//     job 'brief'    writes the brief of Case `id`; gives { written: boolean }
//   `sh` and `now` are for tests; by default the story source builds its own isolated sh.
//
// Run as the main module, it reads one JSON object (the arguments above) from stdin and prints
// { ok: true, value } or { ok: false, error: { name, message, code? } } to stdout, the way
// jira/sync-worker.mjs does. The env goes on stdin, never on the command line. code is sf's own
// (timeout, auth, login-rate, cooldown) when the failure had one, and the refresher reads it.

import { pathToFileURL } from 'node:url';
import { create } from './salesforce.mjs';

const JOBS = ['refresh', 'drain', 'brief'];

export async function runJob({ job, root, options, stateDir, env, features, salesforceOrgs, id }, { sh, now } = {}) {
  if (!JOBS.includes(job)) throw new Error(`unknown Salesforce job: ${job}`);
  const source = create(options, { root, stateDir, env, features, salesforceOrgs, ...(sh ? { sh } : {}), ...(now ? { now } : {}) });
  if (job === 'refresh') return { count: source.refresh() };
  if (job === 'drain') {
    source.flush();
    return undefined;
  }
  return { written: source.brief(String(id)) !== null };
}

async function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  let out;
  try {
    out = { ok: true, value: await runJob(JSON.parse(input)) };
  } catch (err) {
    out = { ok: false, error: { name: err?.name ?? 'Error', message: String(err?.message ?? err), ...(err?.code !== undefined && typeof err.code === 'string' ? { code: err.code } : {}) } };
  }
  process.stdout.write(JSON.stringify(out));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
