// The child process behind runJiraSync (sync.mjs): reads { job, site, env, args } as JSON on
// stdin, runs the job against Jira, and prints { ok: true, value } or { ok: false, error }.

import { jiraClient } from './client.mjs';
import { readBrief, readSnapshot } from './issues.mjs';
import { createIssue, sendWrites } from './writes.mjs';

const JOBS = { snapshot: readSnapshot, brief: readBrief, writes: sendWrites, create: createIssue };

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;

let out;
try {
  const { job, site, env, args } = JSON.parse(input);
  if (!Object.hasOwn(JOBS, job)) throw new Error(`unknown Jira job: ${job}`);
  const { request } = jiraClient({ site, env });
  out = { ok: true, value: await JOBS[job](request, args) };
} catch (err) {
  out = { ok: false, error: { name: err?.name ?? 'Error', message: String(err?.message ?? err), ...(err?.status !== undefined ? { status: err.status } : {}) } };
}
process.stdout.write(JSON.stringify(out));
