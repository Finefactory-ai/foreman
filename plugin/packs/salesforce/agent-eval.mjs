// Foreman's own agent eval caller, for the Agentforce check (agentforce.mjs). It makes the one
// request `sf agent test run-eval` makes, which Foreman never runs: in plugin-agent 2.0.5 that
// command sends the plain org session to the eval API, gets 401, and refreshes over JWT until the
// org reports "login rate exceeded", which can lock the user out for an hour. This caller uses the
// named-user JWT that `sf agent preview` and `publish` use, a planner session (an employee agent
// cannot use the Agent API session), and the planner of the ACTIVE version, which pins it.
//
//   readEvalSpec(text, api)  the builder's tests/<Api>-eval.json, checked and normalized:
//                            { agent, tests: [{ id, utterance, routing: [{ field, operator,
//                            expected }], outcome?: { expectation, threshold } }] }. A reason
//                            names the file and the bad path, never the file's text.
//   loadEvalSpec(sh, to, api) the spec at commit `to`, through git show, then readEvalSpec
//   evalPayload(spec, plannerId) the eval API's { tests }: per case a planner session, the
//                            message, the state, a string_assertion per routing check and a
//                            bot_response_rating for the outcome
//   gradeEval(spec, response) { routing: [{ case, check, expected }], outcome: [{ case }] }.
//                            A failed, erroring or missing routing check, a case with errors and
//                            a case with no result are routing failures; `expected` is always
//                            the spec's, never the API's actual value.
//   evalRoom / recordSuite   the suite counter: <state>/salesforce/agent-evals.json,
//                            { orgs: { <alias>: [iso, ...] } }, against EVAL_LIMIT, the reported
//                            limit of 10 suites in 10 hours. Old entries are pruned on write; a
//                            broken file reads as empty. A request for more suites than the
//                            limit never fits, so its next is null. recordSuite reads, changes
//                            and writes with no lock of its own. Its only caller is the
//                            Agentforce check in sf-verify, a ship step, and runShip (ship.mjs)
//                            holds the ship lock from the first step to the last, so one release
//                            writes the counter at a time.
//   agentSession(...)        the session for one org: `sf org display` with SF_TEMP_SHOW_SECRETS
//                            on that call alone (sf redacts the token without it), the org ID
//                            and an https Salesforce instance URL checked, the user from
//                            userinfo, and the JWT from /agentforce/bootstrap/nameduser. Both
//                            GETs refuse redirects, so a 3xx fails as its HTTP status.
//   runSuite(...)            POSTs the payload in batches of at most 5, in parallel, and merges
//                            the results
//   junit(api, spec, response, grade) the JUnit XML for the run
//
// No call is retried. A login-rate answer to the session calls cools the org down (sf.mjs). An
// eval answer of 429, or one naming a rate or request limit, fails with no cool-down, so the
// rollback can still reach the org.
//
// The session token and the JWT never appear in a reason, a written file or a log: the session
// holds them in a closure, and JSON.stringify of it shows the org alone. A message names only
// agents, case ids, check ids, aliases, HTTP statuses and sf's own error message.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeAtomic } from '../../lib/adapters/stories/overlay.mjs';
import { isolatedSh } from './isolation.mjs';
import { loginTrouble, recordCooldown, runSf } from './sf.mjs';

export const EVAL_URL = 'https://api.salesforce.com/einstein/evaluation/v1/tests';
export const EVAL_LIMIT = Object.freeze({ suites: 10, hours: 10 });

const BATCH = 5;
const SESSION_TIMEOUT_MS = 60_000;
const EVAL_TIMEOUT_MS = 600_000;
const HOUR_MS = 3_600_000;
const MAX_UTTERANCE = 2000;
const CASE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const INPUT_FIELD = /^invokedActions\[0\]\[0\]\.function\.input\.([A-Za-z_][A-Za-z0-9_]*)$/;
const PLAIN_FIELDS = ['lastExecution.llmEvents', 'lastExecution.invokedActions'];
const OPERATORS = ['contains', 'equals'];
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
const LIMITED = /rate limit|request limit|limit exceeded|too many requests/i;
const STATE = '$.outputs[2].response.planner_response.';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.length > 0;
const msOf = (now) => (now instanceof Date ? now.getTime() : Number(now ?? Date.now()));
const id15 = (v) => (typeof v === 'string' ? v.slice(0, 15) : '');

export const evalSpecFile = (api) => `tests/${api}-eval.json`;

// The spec in `text` for agent `api`, as { ok: true, spec } or { ok: false, reason }.
export function readEvalSpec(text, api) {
  const file = evalSpecFile(api);
  const no = (where, problem) => ({ ok: false, reason: `${file}: ${where} ${problem}` });
  let raw;
  try {
    raw = JSON.parse(String(text ?? ''));
  } catch {
    return { ok: false, reason: `${file} is not JSON` };
  }
  if (!isObject(raw)) return { ok: false, reason: `${file} is not a JSON object` };
  if (raw.agent !== api) return no('agent', `is not ${api}`);
  if (!Array.isArray(raw.tests) || raw.tests.length === 0) return no('tests', 'must be a non-empty list');

  const tests = [];
  const seen = new Map();
  for (const [i, t] of raw.tests.entries()) {
    const at = `tests[${i}]`;
    if (!isObject(t)) return no(at, 'must be an object');
    if (typeof t.id !== 'string' || !CASE_ID.test(t.id)) return no(`${at}.id`, 'must be 1 to 80 letters, digits, _ or -');
    if (seen.has(t.id)) return no(`${at}.id`, `repeats tests[${seen.get(t.id)}].id`);
    seen.set(t.id, i);
    if (!isText(t.utterance) || t.utterance.length > MAX_UTTERANCE) return no(`${at}.utterance`, `must be text of 1 to ${MAX_UTTERANCE} characters`);
    if (!Array.isArray(t.routing)) return no(`${at}.routing`, 'must be a list');

    const routing = [];
    for (const [j, r] of t.routing.entries()) {
      const rat = `${at}.routing[${j}]`;
      if (!isObject(r)) return no(rat, 'must be an object');
      if (typeof r.field !== 'string' || !(PLAIN_FIELDS.includes(r.field) || INPUT_FIELD.test(r.field))) {
        return no(`${rat}.field`, 'must be lastExecution.llmEvents, lastExecution.invokedActions or invokedActions[0][0].function.input.<input>');
      }
      if (!OPERATORS.includes(r.operator)) return no(`${rat}.operator`, 'must be contains or equals');
      if (!isText(r.expected)) return no(`${rat}.expected`, 'must be non-empty text');
      routing.push({ field: r.field, operator: r.operator, expected: r.expected });
    }

    let outcome;
    if (t.outcome !== undefined) {
      if (!isObject(t.outcome)) return no(`${at}.outcome`, 'must be an object');
      if (!isText(t.outcome.expectation)) return no(`${at}.outcome.expectation`, 'must be non-empty text');
      const threshold = t.outcome.threshold === undefined ? 3 : t.outcome.threshold;
      if (!Number.isInteger(threshold) || threshold < 1 || threshold > 5) return no(`${at}.outcome.threshold`, 'must be a whole number from 1 to 5');
      outcome = { expectation: t.outcome.expectation, threshold };
    }
    if (routing.length === 0 && !outcome) return no(at, 'needs a routing check or an outcome');
    tests.push({ id: t.id, utterance: t.utterance, routing, ...(outcome ? { outcome } : {}) });
  }
  return { ok: true, spec: { agent: api, tests } };
}

// The spec for `api` at commit `to`, read through git show in the caller's sh.
export function loadEvalSpec(sh, to, api) {
  const file = evalSpecFile(api);
  if (!isText(to)) return { ok: false, reason: `${file} cannot be read: the story's commit is unknown` };
  const r = sh('git', ['show', `${to}:${file}`]) ?? {};
  if (r.status !== 0) return { ok: false, reason: `${file} is missing: the builder writes one eval spec per changed agent` };
  return readEvalSpec(String(r.stdout ?? ''), api);
}

const actualOf = (field) => `${STATE}${field.startsWith('invokedActions') ? `lastExecution.${field}` : field}`;

export function evalPayload(spec, plannerId) {
  return {
    tests: spec.tests.map((t) => ({
      id: t.id,
      steps: [
        { type: 'agent.create_session', id: 'cs', use_agent_api: false, planner_id: plannerId },
        { type: 'agent.send_message', id: 'sm', session_id: '$.outputs[0].session_id', utterance: t.utterance },
        { type: 'agent.get_state', id: 'gs', session_id: '$.outputs[0].session_id' },
        ...t.routing.map((r, i) => ({ type: 'evaluator.string_assertion', id: `routing_${i + 1}`, actual: actualOf(r.field), expected: r.expected, operator: r.operator })),
        ...(t.outcome
          ? [{ type: 'evaluator.bot_response_rating', id: 'outcome', utterance: t.utterance, expected: t.outcome.expectation, actual: '$.outputs[1].response', threshold: t.outcome.threshold }]
          : []),
      ],
    })),
  };
}

const NO_SESSION = 'a session with no errors';

export function gradeEval(spec, response) {
  const results = isObject(response) && Array.isArray(response.results) ? response.results.filter(isObject) : [];
  const byId = new Map(results.map((r) => [r.id, r]));
  const routing = [];
  const outcome = [];
  for (const t of spec.tests) {
    const result = byId.get(t.id);
    if (!result || (Array.isArray(result.errors) && result.errors.length > 0)) {
      routing.push({ case: t.id, check: 'session', expected: NO_SESSION });
      continue;
    }
    const checks = new Map((Array.isArray(result.evaluation_results) ? result.evaluation_results : []).filter(isObject).map((e) => [e.id, e]));
    t.routing.forEach((r, i) => {
      const check = `routing_${i + 1}`;
      const e = checks.get(check);
      if (!e || e.is_pass !== true || isText(e.error_message)) routing.push({ case: t.id, check, expected: r.expected });
    });
    if (t.outcome && checks.get('outcome')?.is_pass === false) outcome.push({ case: t.id });
  }
  return { routing, outcome };
}

// The suite counter.
export const evalsFile = (state) => path.join(state, 'salesforce', 'agent-evals.json');

function readEvals(state) {
  try {
    const rec = JSON.parse(fs.readFileSync(evalsFile(state), 'utf8'));
    if (!isObject(rec) || !isObject(rec.orgs)) return {};
    const orgs = {};
    for (const [org, list] of Object.entries(rec.orgs)) {
      if (Array.isArray(list)) orgs[org] = list.filter((v) => typeof v === 'string' && Number.isFinite(Date.parse(v)));
    }
    return orgs;
  } catch {
    return {};
  }
}

const inWindow = (list, at, hours) => list.map(Date.parse).filter((t) => t > at - hours * HOUR_MS).sort((a, b) => a - b);

// Whether `wanted` more suites fit in `org`'s window: { ok, used, next }, next the ISO time the
// oldest suite in the window leaves it (null for none). A request for more suites than the limit
// never fits, so it gets { ok: false, used, next: null }.
export function evalRoom(state, org, { now, wanted = 1, limit = EVAL_LIMIT } = {}) {
  const at = msOf(now);
  const times = inWindow(readEvals(state)[org] ?? [], at, limit.hours);
  const used = times.length;
  if (wanted > limit.suites) return { ok: false, used, next: null };
  const ok = used + wanted <= limit.suites;
  const leaving = times[Math.min(Math.max(used + wanted - limit.suites - 1, 0), used - 1)];
  return { ok, used, next: used ? new Date(leaving + limit.hours * HOUR_MS).toISOString() : null };
}

// recordSuite reads, changes and writes with no lock of its own. Its only caller is the Agentforce
// check in sf-verify, a ship step, and runShip (ship.mjs) holds the ship lock from the first step
// to the last, so one release writes the counter at a time.
export function recordSuite(state, org, now) {
  const at = msOf(now);
  const orgs = readEvals(state);
  const kept = {};
  for (const [alias, list] of Object.entries(orgs)) {
    const times = inWindow(list, at, EVAL_LIMIT.hours);
    if (times.length) kept[alias] = times.map((t) => new Date(t).toISOString());
  }
  kept[org] = [...(kept[org] ?? []), new Date(at).toISOString()];
  writeAtomic(evalsFile(state), `${JSON.stringify({ orgs: kept }, null, 2)}\n`);
}

// One fetch with a time limit and no retry: { status, text } or { status: 0, error }.
async function request(fetch, url, init, ms) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
    let text = '';
    try {
      text = await res.text();
    } catch {
      text = '';
    }
    return { status: res.status, text };
  } catch (err) {
    return { status: 0, error: err?.name === 'TimeoutError' ? 'timed out' : 'no answer' };
  }
}

const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

function salesforceOrigin(value) {
  try {
    const url = new URL(String(value));
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || !(host.endsWith('.salesforce.com') || host.endsWith('.force.com'))) return null;
    return url.origin;
  } catch {
    return null;
  }
}

// The session for `org`: { ok: true, session } or { ok: false, reason }. `sh` is the isolated sh
// the check got, `rawSh` the sh under it.
export async function agentSession({ sh, rawSh, env = process.env, org, orgId, fetch = globalThis.fetch, now = Date.now() }) {
  const no = (reason) => ({ ok: false, reason });
  const secretSh = isolatedSh(rawSh, { ...env, SF_TEMP_SHOW_SECRETS: 'true' }, sh.sfHome, os.homedir());
  const shown = runSf(secretSh, ['org', 'display', '--target-org', org], { now });
  if (!shown.ok) return no(`could not read the sign-in of ${org}: ${shown.error.message}`);
  const info = isObject(shown.result) ? shown.result : {};
  if (!isText(orgId) || id15(info.id) !== id15(orgId)) return no(`${org} is signed in to another org than the one salesforce.orgs names`);
  const origin = salesforceOrigin(info.instanceUrl);
  if (!origin) return no(`${org}'s instance URL is not an https Salesforce address`);
  const token = info.accessToken;
  if (!isText(token)) return no(`sf gave no session for ${org}`);

  const coolDown = () => {
    const rec = recordCooldown(sh.sfHome, org, { reason: 'login rate exceeded', now });
    return no(`${org} answered "login rate exceeded"; Foreman never retries it and makes no sf call to ${org} until ${rec.until}`);
  };
  const get = (url, headers) => request(fetch, url, { method: 'GET', headers, redirect: 'manual' }, SESSION_TIMEOUT_MS);

  const who = await get(`${origin}/services/oauth2/userinfo`, { Authorization: `Bearer ${token}` });
  if (loginTrouble(who.text) === 'login-rate') return coolDown();
  if (who.status === 0) return no(`could not read the user of ${org}: ${who.error}`);
  if (who.status !== 200) return no(`could not read the user of ${org} (HTTP ${who.status})`);
  const userId = parse(who.text)?.user_id;
  if (!isText(userId)) return no(`${org} gave no user for the session`);

  const named = await get(`${origin}/agentforce/bootstrap/nameduser`, { Cookie: `sid=${token}` });
  if (loginTrouble(named.text) === 'login-rate') return coolDown();
  if (named.status === 0) return no(`could not get an agent token from ${org}: ${named.error}`);
  if (named.status !== 200) return no(`could not get an agent token from ${org} (HTTP ${named.status})`);
  const jwt = parse(named.text)?.access_token;
  if (typeof jwt !== 'string' || !JWT.test(jwt)) return no(`${org} gave no agent token`);

  const headers = {
    Authorization: `Bearer ${jwt}`,
    'Content-Type': 'application/json',
    'x-sfdc-core-tenant-id': `core/prod/${orgId}`,
    'x-org-id': orgId,
    'x-sfdc-core-instance-url': origin,
    'x-sfdc-user-id': userId,
    'x-client-feature-id': 'AIPlatformEvaluation',
    'x-sfdc-app-context': 'EinsteinGPT',
  };
  return { ok: true, session: { org, headers: () => ({ ...headers }) } };
}

// Runs the spec's cases against the planner: { ok: true, response: { results } } or { ok: false,
// reason }.
export async function runSuite({ session, fetch = globalThis.fetch, plannerId, spec }) {
  const { tests } = evalPayload(spec, plannerId);
  const batches = [];
  for (let i = 0; i < tests.length; i += BATCH) batches.push(tests.slice(i, i + BATCH));
  const answers = await Promise.all(
    batches.map((batch) => request(fetch, EVAL_URL, { method: 'POST', headers: session.headers(), body: JSON.stringify({ tests: batch }) }, EVAL_TIMEOUT_MS)),
  );
  const results = [];
  for (const a of answers) {
    if (a.status === 0) return { ok: false, reason: `could not reach the eval API: ${a.error}` };
    if (a.status === 429 || (a.status !== 200 && LIMITED.test(a.text))) {
      return { ok: false, reason: `the eval API is limiting calls (HTTP ${a.status}); Foreman never retries it, so run the release again later` };
    }
    if (a.status !== 200) return { ok: false, reason: `the eval API refused the suite (HTTP ${a.status})` };
    const body = parse(a.text);
    if (!isObject(body) || !Array.isArray(body.results)) return { ok: false, reason: 'the eval API gave no results' };
    results.push(...body.results);
  }
  return { ok: true, response: { results } };
}

const escapeXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export function junit(api, spec, response, grade) {
  const results = isObject(response) && Array.isArray(response.results) ? response.results.filter(isObject) : [];
  const errorOf = (caseId, check) => {
    const e = results.find((r) => r.id === caseId)?.evaluation_results?.find?.((x) => isObject(x) && x.id === check);
    return isText(e?.error_message) ? `; ${e.error_message}` : '';
  };
  const cases = spec.tests.map((t) => {
    const failures = [
      ...grade.routing.filter((f) => f.case === t.id).map((f) => {
        const message = `${f.check}: expected ${f.expected}${errorOf(t.id, f.check)}`;
        return `      <failure type="routing" message="${escapeXml(message)}">${escapeXml(message)}</failure>`;
      }),
      ...grade.outcome.filter((f) => f.case === t.id).map(() => {
        const message = `the judge scored the reply below ${t.outcome?.threshold ?? 3}: ${t.outcome?.expectation ?? ''}`;
        return `      <failure type="outcome" message="${escapeXml(message)}">${escapeXml(message)}</failure>`;
      }),
    ];
    const open = `    <testcase classname="${escapeXml(api)}" name="${escapeXml(t.id)}"`;
    return failures.length ? [`${open}>`, ...failures, '    </testcase>'].join('\n') : `${open}/>`;
  });
  const failed = spec.tests.filter((t) => grade.routing.some((f) => f.case === t.id) || grade.outcome.some((f) => f.case === t.id)).length;
  const counts = `tests="${spec.tests.length}" failures="${failed}"`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="${escapeXml(api)}" ${counts}>`,
    `  <testsuite name="${escapeXml(api)}" ${counts}>`,
    ...cases,
    '  </testsuite>',
    '</testsuites>',
    '',
  ].join('\n');
}
