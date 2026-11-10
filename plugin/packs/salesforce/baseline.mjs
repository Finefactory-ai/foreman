// What an org already fails before any story touches it: its local Apex tests and its org-wide
// coverage, recorded once and kept until `foreman sf baseline --refresh`. One JSON file per org
// at <stateDir>/salesforce/baseline/<alias>.json,
//
//   { alias, orgId, testRunId, startedAt, state: 'running' | 'done' | 'aborted', finishedAt?,
//     failing?: ["Class.method", ...], coverage?: <whole percent> | null }
//
// failing is sorted, each name once, at most 200. Nothing else is copied from sf: no message,
// no stack trace, no username.
//
//   startBaseline(sh, { alias, orgId }, now)   checks the org is a sandbox with that org ID, then
//                    starts `sf apex run test --test-level RunLocalTests --code-coverage` with
//                    no --wait, so it returns at once with the test run ID. Production is never
//                    a target. { ok: true, record } or { ok: false, reason }.
//   advanceBaseline(sh, record, now)   reads the run's status through the tooling API and, once
//                    it completed, the failing tests and the org-wide coverage. { record, error? };
//                    the record is the same object when nothing changed.
//   problemsOf(record, { coverage })   { failing, coverage } when a done baseline means
//                    RunLocalTests cannot pass there, else null. describe(p) says it in words.
//   isInherited(failures, record)      true when a deploy's failures (deploy-result.mjs
//                    summary) are only tests the baseline lists, plus an org-wide coverage
//                    warning while the baseline coverage was already too low.
//   baselineWrittenAt(dir, alias)      the mtime in ms of the org's baseline file, or null when
//                    it is missing or cannot be read.
//   isTrusted(record, writtenAtMs, startMs)
//                    true only for a done record whose finishedAt and file mtime are both
//                    strictly before startMs, the moment the story branch was last created or
//                    reset. A record edited during the story keeps its old finishedAt but gets
//                    a new mtime, so it is not trusted. Anything not a finite time is false.
//
// readBaseline returns null for a record of another org ID (a refreshed sandbox gets a new one)
// and for a test run ID that is not one: the ID goes into SOQL, so this is checked before any
// query. Every sf call goes through runSf, each value its own argument, in the caller's sh,
// which is the isolated sf home.

import fs from 'node:fs';
import { join } from 'node:path';
import { safeId, writeAtomic } from '../../lib/adapters/stories/overlay.mjs';
import { ALIAS } from './config.mjs';
import { runSf } from './sf.mjs';

export const COVERAGE_NEEDED = 75;
// The test levels an org with a baseline problem cannot pass.
export const CANNOT_PASS = Object.freeze(['RunLocalTests', 'RunAllTestsInOrg']);
// An Apex test run (AsyncApexJob) ID: 707 and 12 more characters, or 15 for the 18-character form.
export const TEST_RUN_ID = /^707[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$/;
export const TEST_NAME = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+$/;
const MAX_FAILING = 200;
const MAX_NAMED = 5;
const STATES = ['running', 'done', 'aborted'];
const STOPPED = ['Aborted', 'Failed'];
const ORG_QUERY = 'SELECT Id, IsSandbox FROM Organization';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.length > 0;
const org15 = (id) => (typeof id === 'string' && id.length >= 15 ? id.slice(0, 15) : null);
const recordsOf = (r) => (isObject(r.result) && Array.isArray(r.result.records) ? r.result.records.filter(isObject) : []);
const named = (names) => `${names.slice(0, MAX_NAMED).join(', ')}${names.length > MAX_NAMED ? ` and ${names.length - MAX_NAMED} more` : ''}`;

export const baselineFile = (dir, alias) => join(dir, 'salesforce', 'baseline', `${safeId(alias)}.json`);

// The record for this alias and org, or null when it is missing, broken, of another alias or
// org, or holds a test run ID that is not one.
export function readBaseline(dir, { alias, orgId } = {}) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(baselineFile(dir, alias), 'utf8'));
  } catch {
    return null;
  }
  if (!isObject(record) || record.alias !== alias) return null;
  if (!org15(orgId) || org15(record.orgId) !== org15(orgId)) return null;
  if (typeof record.testRunId !== 'string' || !TEST_RUN_ID.test(record.testRunId)) return null;
  if (!STATES.includes(record.state) || !isText(record.startedAt)) return null;
  return record;
}

export function baselineWrittenAt(dir, alias) {
  try {
    return fs.statSync(baselineFile(dir, alias)).mtimeMs;
  } catch {
    return null;
  }
}

const isTime = (v) => typeof v === 'number' && Number.isFinite(v);

export function isTrusted(record, writtenAtMs, startMs) {
  if (!isObject(record) || record.state !== 'done' || !isTime(startMs)) return false;
  const finished = typeof record.finishedAt === 'string' ? Date.parse(record.finishedAt) : NaN;
  return isTime(finished) && finished < startMs && isTime(writtenAtMs) && writtenAtMs < startMs;
}

export function writeBaseline(dir, record) {
  writeAtomic(baselineFile(dir, record.alias), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export function clearBaseline(dir, alias) {
  fs.rmSync(baselineFile(dir, alias), { force: true });
}

export function startBaseline(sh, { alias, orgId } = {}, now = new Date()) {
  if (!(typeof alias === 'string' && ALIAS.test(alias))) return { ok: false, reason: 'not a valid org alias' };
  if (!org15(orgId)) return { ok: false, reason: `${alias} has no org ID in salesforce.orgs` };
  const q = runSf(sh, ['data', 'query', '--query', ORG_QUERY, '--target-org', alias]);
  if (!q.ok) return { ok: false, reason: `could not check ${alias}: ${q.error.message}` };
  const org = recordsOf(q)[0];
  if (!org || org.IsSandbox !== true) return { ok: false, reason: `${alias} is not a sandbox; production is never a target` };
  const id = org15(org.Id) ?? '';
  if (id !== org15(orgId)) return { ok: false, reason: `${alias} is org ${id}, not ${orgId}` };

  const r = runSf(sh, ['apex', 'run', 'test', '--test-level', 'RunLocalTests', '--code-coverage', '--target-org', alias]);
  if (!r.ok) return { ok: false, reason: r.error.message };
  const testRunId = isObject(r.result) ? r.result.testRunId : undefined;
  if (typeof testRunId !== 'string' || !TEST_RUN_ID.test(testRunId)) return { ok: false, reason: 'sf gave no test run ID' };
  return { ok: true, record: { alias, orgId, testRunId, startedAt: now.toISOString(), state: 'running' } };
}

const tooling = (sh, query, alias) => runSf(sh, ['data', 'query', '--use-tooling-api', '--query', query, '--target-org', alias]);

export function advanceBaseline(sh, record, now = new Date()) {
  const id = record?.testRunId;
  if (typeof id !== 'string' || !TEST_RUN_ID.test(id)) return { record, error: 'the record holds no test run ID' };
  const alias = record.alias;

  const status = tooling(sh, `SELECT Status FROM ApexTestRunResult WHERE AsyncApexJobId = '${id}'`, alias);
  if (!status.ok) return { record, error: status.error.message };
  const state = recordsOf(status)[0]?.Status;
  if (STOPPED.includes(state)) return { record: { ...record, state: 'aborted', finishedAt: now.toISOString() } };
  // Queued, Processing, Holding, or not listed yet.
  if (state !== 'Completed') return { record };

  const tests = tooling(sh, `SELECT ApexClass.Name, MethodName FROM ApexTestResult WHERE AsyncApexJobId = '${id}' AND Outcome IN ('Fail', 'CompileFail')`, alias);
  if (!tests.ok) return { record, error: tests.error.message };
  const names = recordsOf(tests)
    .map((row) => `${isObject(row.ApexClass) ? row.ApexClass.Name : ''}.${row.MethodName ?? ''}`)
    .filter((name) => TEST_NAME.test(name));
  const failing = [...new Set(names)].sort().slice(0, MAX_FAILING);

  const cov = tooling(sh, 'SELECT PercentCovered FROM ApexOrgWideCoverage', alias);
  if (!cov.ok) return { record, error: cov.error.message };
  const percent = recordsOf(cov)[0]?.PercentCovered;
  const coverage = typeof percent === 'number' && Number.isFinite(percent) ? Math.round(percent) : null;

  return { record: { ...record, state: 'done', finishedAt: now.toISOString(), failing, coverage } };
}

const failingOf = (record) => (Array.isArray(record.failing) ? record.failing.filter((n) => typeof n === 'string' && TEST_NAME.test(n)) : []);
const lowCoverage = (record) => typeof record.coverage === 'number' && record.coverage < COVERAGE_NEEDED;

// What makes RunLocalTests fail there whatever the story does, or null. With coverage false,
// only the failing tests count (a build org takes no deploy with tests).
export function problemsOf(record, { coverage = true } = {}) {
  if (!isObject(record) || record.state !== 'done') return null;
  const failing = failingOf(record);
  const low = coverage && lowCoverage(record) ? record.coverage : null;
  if (!failing.length && low === null) return null;
  return { failing, coverage: low };
}

// "already fails 1 test (AcmeServiceTest.sumsTheOrder) and has 19% Apex coverage (75% needed)",
// either half dropped when it does not apply.
export function describe(p) {
  const parts = [];
  if (p?.failing?.length) parts.push(`already fails ${p.failing.length} ${p.failing.length === 1 ? 'test' : 'tests'} (${named(p.failing)})`);
  if (typeof p?.coverage === 'number') parts.push(`has ${p.coverage}% Apex coverage (${COVERAGE_NEEDED}% needed)`);
  return parts.join(' and ');
}

const ORG_WIDE = /average test coverage across all/i;

export function isInherited(failures, record) {
  if (!Array.isArray(failures) || !failures.length) return false;
  if (!isObject(record) || record.state !== 'done') return false;
  const failing = failingOf(record);
  return failures.every((f) => {
    if (!isObject(f)) return false;
    if (f.kind === 'test') return failing.includes(f.name);
    if (f.kind === 'coverage') return (f.name === '' || ORG_WIDE.test(String(f.message ?? ''))) && lowCoverage(record);
    return false;
  });
}
