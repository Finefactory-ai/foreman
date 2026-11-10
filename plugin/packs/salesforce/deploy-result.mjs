// Reading a Salesforce deploy job, for the sf-validate and sf-deploy ship steps.
//
//   summary(result)   the few fields of a deploy response a step may report:
//                     { status, components: { deployed, total }, tests: { completed, errors },
//                       failures: [{ kind: 'component' | 'test' | 'coverage', name, message }] }
//                     It copies only these: never who ran the deploy, user or file ids, file
//                     names, stack traces or the raw result. sf gives each list as one object or
//                     an array; both are read. At most 20 failures, each message tidied and cut
//                     to 300 characters.
//   waitForJob(ctx, sh, { jobId, org, minutes, label })
//                     polls `sf project deploy report --job-id <id> --target-org <org>` every 10
//                     seconds, with ctx.sleep, until the job reaches a FINAL status or `minutes`
//                     pass on ctx.now(). Each poll calls ctx.report(label), which is the slot's
//                     heartbeat; a report that throws is ignored. A read that fails with no result is tried again until the
//                     deadline, keeping its error message. Returns { status, result, lastError }:
//                     status is the last one seen (or null), result the last deploy response.
//                     A read that stopsRetry (a login-rate or sign-in stop, or an org cooling
//                     down) ends the wait at once, with `stopped` set to its message.
//
// The steps start their job with --async and poll here rather than pass a long --wait: sh is
// synchronous, so a long wait would block the runner's beat timer and the slot would look hung.

import { runSf, stopsRetry } from './sf.mjs';

export const FINAL = Object.freeze(['Succeeded', 'Failed', 'Canceled', 'SucceededPartial']);
// A deploy job ID: 0Af and 12 more characters, or 15 more for the 18-character form.
export const JOB_ID = /^0Af[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$/;

const POLL_MS = 10_000;
const REPORT_TIMEOUT_MS = 120_000;
const MAX_FAILURES = 20;
const MAX_MESSAGE = 300;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : isObject(v) ? [v] : []).filter(isObject);
const count = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : 0);
const text = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
const tidy = (v) => text(v).replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE);
const set = (v) => text(v).trim() !== '';

export function summary(result) {
  const r = isObject(result) ? result : {};
  const details = isObject(r.details) ? r.details : {};
  const tests = isObject(details.runTestResult) ? details.runTestResult : {};

  const failures = [
    ...list(details.componentFailures).map((f) => ({
      kind: 'component',
      name: tidy(`${text(f.componentType)} ${text(f.fullName)}${set(f.lineNumber) ? ` line ${text(f.lineNumber).trim()}` : ''}`),
      message: tidy(f.problem),
    })),
    ...list(tests.failures).map((f) => ({ kind: 'test', name: tidy(`${text(f.name)}.${text(f.methodName)}`), message: tidy(f.message) })),
    ...list(tests.codeCoverageWarnings).map((f) => ({ kind: 'coverage', name: tidy(f.name), message: tidy(f.message) })),
  ].slice(0, MAX_FAILURES);

  return {
    status: typeof r.status === 'string' ? r.status : null,
    components: { deployed: count(r.numberComponentsDeployed), total: count(r.numberComponentsTotal) },
    tests: { completed: count(r.numberTestsCompleted), errors: count(r.numberTestErrors) },
    failures,
  };
}

export async function waitForJob(ctx, sh, { jobId, org, minutes, label = `waiting for Salesforce job ${jobId} on ${org}` }) {
  const deadline = ctx.now().getTime() + minutes * 60_000;
  let status = null;
  let result = null;
  let lastError = null;
  for (;;) {
    try {
      ctx.report?.(label);
    } catch {
      // The heartbeat is best effort; it never fails the step.
    }
    const r = runSf(sh, ['project', 'deploy', 'report', '--job-id', jobId, '--target-org', org], { keepResult: true, timeoutMs: REPORT_TIMEOUT_MS });
    if (stopsRetry(r)) return { status, result, lastError, stopped: r.error.message };
    if (isObject(r.result)) {
      result = r.result;
      if (typeof r.result.status === 'string') status = r.result.status;
    } else if (!r.ok) {
      lastError = r.error.message;
    }
    if (FINAL.includes(status)) return { status, result, lastError };
    if (ctx.now().getTime() >= deadline) return { status, result, lastError };
    await ctx.sleep(POLL_MS);
  }
}
