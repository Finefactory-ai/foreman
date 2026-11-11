import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  EVAL_LIMIT,
  EVAL_URL,
  RETRY_WAIT_MS,
  answerSnippet,
  evalPayload,
  evalRoom,
  evalsFile,
  gradeEval,
  junit,
  readEvalSpec,
  agentSession,
  recordSuite,
} from './agent-eval.mjs';
import { agentforceCheck, versionsQuery } from './agentforce.mjs';
import { binDir, findRealSf, isolatedSh, wrapperScript } from './isolation.mjs';
import { readRelease } from './releases.mjs';
import { COOLDOWN_MS, coolingDown, cooldownFile } from './sf.mjs';
import { fakeCtx, fakeSh } from '../../../test/ship-fakes.mjs';
import { ACME_PROD_ID, ACME_QA_ID, sfError, sfOk } from '../../../test/fake-sf.mjs';
import {
  ACME_INSTANCE,
  ACME_JWT,
  ACME_PLANNER_ID,
  ACME_SESSION,
  ACME_SPEC,
  ACME_USER_ID,
  EVAL_URL as FAKE_EVAL_URL,
  evalRules,
  failing,
  fakeFetch,
  fakeRealSf,
  orgDisplay,
  orgList,
  passAll,
  planners,
  specText,
  sessionOf,
  specWith,
  tempPath,
} from '../../../test/fake-agent-eval.mjs';

const API = 'Acme_Order_Helper';
const FILE = `tests/${API}-eval.json`;
const PID = ACME_PLANNER_ID;
const STAGE = { name: 'qa', org: 'acme-qa', orgId: ACME_QA_ID, branch: 'qa' };
const LAYOUT = {
  productionBranch: 'main',
  orgs: { 'acme-dev1': { orgId: '00D000000000001AAA' }, 'acme-qa': { orgId: ACME_QA_ID } },
  build: ['acme-dev1'],
  stages: [{ name: 'qa', org: 'acme-qa', branch: 'qa' }],
};
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);

let dir;
let sfHome;
let state;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-agent-eval-'));
  sfHome = path.join(dir, 'sf-home');
  state = path.join(dir, 'state');
  fs.mkdirSync(sfHome);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const clone = (v) => JSON.parse(JSON.stringify(v));
const text = (v) => specText(v);

describe('readEvalSpec', () => {
  it('accepts the builder example and gives it back, the threshold defaulting to 3', () => {
    const r = readEvalSpec(text(ACME_SPEC), API);
    expect(r).toEqual({ ok: true, spec: clone(ACME_SPEC) });
    const noThreshold = clone(ACME_SPEC);
    delete noThreshold.tests[0].outcome.threshold;
    expect(readEvalSpec(text(noThreshold), API).spec.tests[0].outcome).toEqual({ expectation: "The reply gives the order's status.", threshold: 3 });
  });

  const bad = (edit) => {
    const s = clone(ACME_SPEC);
    edit(s);
    return s;
  };
  const SECRETISH = 'ACME-PRIVATE-TEXT';
  const cases = [
    ['an agent mismatch', bad((s) => { s.agent = 'Acme_Case_Helper'; }), 'agent'],
    ['empty tests', bad((s) => { s.tests = []; }), 'tests'],
    ['a duplicate id', bad((s) => { s.tests[1].id = 'order-status'; }), 'tests[1].id'],
    ['a bad id', bad((s) => { s.tests[0].id = `${SECRETISH} x`; }), 'tests[0].id'],
    ['a bad field', bad((s) => { s.tests[0].routing[0].field = `lastExecution.topic${SECRETISH}`; }), 'tests[0].routing[0].field'],
    ['an input name that would break the path', bad((s) => { s.tests[0].routing[2].field = "invokedActions[0][0].function.input.x']"; }), 'tests[0].routing[2].field'],
    ['operator matches', bad((s) => { s.tests[0].routing[1].operator = 'matches'; }), 'tests[0].routing[1].operator'],
    ['threshold 0', bad((s) => { s.tests[0].outcome.threshold = 0; }), 'tests[0].outcome.threshold'],
    ['threshold 6', bad((s) => { s.tests[1].outcome.threshold = 6; }), 'tests[1].outcome.threshold'],
    ['threshold 2.5', bad((s) => { s.tests[1].outcome.threshold = 2.5; }), 'tests[1].outcome.threshold'],
    ['threshold null', bad((s) => { s.tests[0].outcome.threshold = null; }), 'tests[0].outcome.threshold'],
    ['a missing utterance', bad((s) => { delete s.tests[1].utterance; }), 'tests[1].utterance'],
    ['a long utterance', bad((s) => { s.tests[1].utterance = 'a'.repeat(2001); }), 'tests[1].utterance'],
    ['an empty expected', bad((s) => { s.tests[0].routing[0].expected = ''; }), 'tests[0].routing[0].expected'],
    ['an empty expectation', bad((s) => { s.tests[0].outcome.expectation = ''; }), 'tests[0].outcome.expectation'],
    ['routing that is not a list', bad((s) => { s.tests[0].routing = SECRETISH; }), 'tests[0].routing'],
    ['a test with neither routing nor outcome', bad((s) => { s.tests[1].routing = []; delete s.tests[1].outcome; }), 'tests[1]'],
  ];
  for (const [name, spec, where] of cases) {
    it(`refuses ${name}, naming the file and the path, never the text`, () => {
      const r = readEvalSpec(text(spec), API);
      expect(r.ok).toBe(false);
      expect(r.reason).toContain(FILE);
      expect(r.reason).toContain(where);
      expect(r.reason).not.toContain(SECRETISH);
      expect(r.reason).not.toContain("x']");
      expect(r.reason).not.toContain('matches');
    });
  }

  it('refuses text that is not JSON, or not an object, without quoting it', () => {
    for (const t of [`{ "agent": "${SECRETISH}"`, '[]', 'null', '']) {
      const r = readEvalSpec(t, API);
      expect(r.ok, t).toBe(false);
      expect(r.reason).toContain(FILE);
      expect(r.reason).not.toContain(SECRETISH);
    }
  });
});

describe('evalPayload', () => {
  it('gives exactly the planner-session step list, with the routing JSONPaths and the outcome rating', () => {
    const { spec } = readEvalSpec(text(ACME_SPEC), API);
    const p = evalPayload(spec, PID);
    expect(p.tests).toHaveLength(2);
    expect(p.tests[0]).toEqual({
      id: 'order-status',
      steps: [
        { type: 'agent.create_session', id: 'cs', use_agent_api: false, planner_id: PID },
        { type: 'agent.send_message', id: 'sm', session_id: '$.outputs[0].session_id', utterance: 'Where is order ACME-1001?' },
        { type: 'agent.get_state', id: 'gs', session_id: '$.outputs[0].session_id' },
        { type: 'evaluator.string_assertion', id: 'routing_1', actual: '$.outputs[2].response.planner_response.lastExecution.llmEvents', expected: "'agent_name': 'Order Status'", operator: 'contains' },
        { type: 'evaluator.string_assertion', id: 'routing_2', actual: '$.outputs[2].response.planner_response.lastExecution.invokedActions', expected: "'name': 'get_order_status'", operator: 'contains' },
        { type: 'evaluator.string_assertion', id: 'routing_3', actual: '$.outputs[2].response.planner_response.lastExecution.invokedActions[0][0].function.input.orderNumber', expected: 'ACME-1001', operator: 'equals' },
        { type: 'evaluator.bot_response_rating', id: 'outcome', utterance: 'Where is order ACME-1001?', expected: "The reply gives the order's status.", actual: '$.outputs[1].response', threshold: 3 },
      ],
    });
    const session = p.tests[0].steps[0];
    expect(session).not.toHaveProperty('agent_id');
    expect(session).not.toHaveProperty('agent_version_id');
  });

  it('leaves out the outcome step for a test with none', () => {
    const p = evalPayload(specWith(1), PID);
    expect(p.tests[0].steps.map((s) => s.id)).toEqual(['cs', 'sm', 'gs', 'routing_1']);
  });

  it('posts to the eval API on api.salesforce.com', () => {
    expect(EVAL_URL).toBe('https://api.salesforce.com/einstein/evaluation/v1/tests');
    expect(FAKE_EVAL_URL).toBe(EVAL_URL);
  });
});

describe('gradeEval', () => {
  const spec = () => readEvalSpec(text(ACME_SPEC), API).spec;
  const body = () => evalPayload(spec(), PID);

  it('passes an answer where every check passed', () => {
    expect(gradeEval(spec(), passAll(body()))).toEqual({ routing: [], outcome: [] });
  });

  it("gives a failed routing_2 as a routing failure with the spec's expected, never the actual value", () => {
    const g = gradeEval(spec(), failing(body(), { 'order-status': ['routing_2'] }));
    expect(g).toEqual({ routing: [{ case: 'order-status', check: 'routing_2', expected: "'name': 'get_order_status'" }], outcome: [] });
    expect(JSON.stringify(g)).not.toContain('ACTUAL-FROM-API');
  });

  it('counts a routing check with an error message as failed', () => {
    const r = passAll(body());
    r.results[1].evaluation_results[0] = { id: 'routing_1', is_pass: true, error_message: 'Acme path not found' };
    expect(gradeEval(spec(), r).routing).toEqual([{ case: 'greeting', check: 'routing_1', expected: "'agent_name': 'General'" }]);
  });

  it('gives a failed outcome as an outcome failure only', () => {
    expect(gradeEval(spec(), failing(body(), { greeting: ['outcome'] }))).toEqual({ routing: [], outcome: [{ case: 'greeting' }] });
  });

  it('counts test-level errors, a missing test result and a missing routing result as routing failures', () => {
    const errors = passAll(body());
    errors.results[0].errors = [{ message: 'Failed to create agent session' }];
    expect(gradeEval(spec(), errors).routing).toEqual([expect.objectContaining({ case: 'order-status', check: 'session' })]);

    const missingTest = passAll(body());
    missingTest.results = missingTest.results.filter((t) => t.id !== 'greeting');
    expect(gradeEval(spec(), missingTest).routing).toEqual([expect.objectContaining({ case: 'greeting', check: 'session' })]);

    const missingCheck = passAll(body());
    missingCheck.results[0].evaluation_results = missingCheck.results[0].evaluation_results.filter((e) => e.id !== 'routing_3');
    expect(gradeEval(spec(), missingCheck).routing).toEqual([{ case: 'order-status', check: 'routing_3', expected: 'ACME-1001' }]);

    expect(gradeEval(spec(), {}).routing).toHaveLength(2);
    expect(gradeEval(spec(), null).routing).toHaveLength(2);
  });
});

describe('junit', () => {
  it('has one testcase per case and a failure per failed check, escaping <&"', () => {
    const spec = readEvalSpec(text({ ...clone(ACME_SPEC), tests: [{ ...clone(ACME_SPEC.tests[0]), routing: [{ field: 'lastExecution.llmEvents', operator: 'contains', expected: 'a<b & "c"' }] }, clone(ACME_SPEC.tests[1])] }), API).spec;
    const response = failing(evalPayload(spec, PID), { 'order-status': ['routing_1'], greeting: ['outcome'] });
    const xml = junit(API, spec, response, gradeEval(spec, response));
    expect(xml.match(/<testcase /g)).toHaveLength(2);
    expect(xml).toContain('<failure type="routing"');
    expect(xml).toContain('<failure type="outcome"');
    expect(xml).toContain('a&lt;b &amp; &quot;c&quot;');
    expect(xml).not.toContain('a<b');
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });
});

describe('the suite counter', () => {
  const ONE = { suites: 1, hours: 10 };

  it('is the reported limit of 10 suites in 10 hours', () => {
    expect(EVAL_LIMIT).toEqual({ suites: 10, hours: 10 });
    expect(Object.isFrozen(EVAL_LIMIT)).toBe(true);
  });

  it('refuses a second suite inside the window, and has room again once the first leaves it', () => {
    expect(evalRoom(state, 'acme-qa', { now: T0, limit: ONE })).toEqual({ ok: true, used: 0, next: null });
    recordSuite(state, 'acme-qa', T0);
    expect(evalRoom(state, 'acme-qa', { now: T0 + HOUR, limit: ONE })).toEqual({ ok: false, used: 1, next: new Date(T0 + 10 * HOUR).toISOString() });
    expect(evalRoom(state, 'acme-qa', { now: T0 + 10 * HOUR + 60_000, limit: ONE })).toMatchObject({ ok: true, used: 0 });
    expect(evalRoom(state, 'acme-uat', { now: T0 + HOUR, limit: ONE }).ok).toBe(true);
  });

  it('counts the suites wanted at once', () => {
    for (let i = 0; i < 9; i += 1) recordSuite(state, 'acme-qa', T0 + i * 60_000);
    expect(evalRoom(state, 'acme-qa', { now: T0 + HOUR }).ok).toBe(true);
    expect(evalRoom(state, 'acme-qa', { now: T0 + HOUR, wanted: 2 })).toMatchObject({ ok: false, used: 9 });
  });

  it('gives no next time for a request that can never fit', () => {
    expect(evalRoom(state, 'acme-qa', { now: T0, wanted: 11 })).toEqual({ ok: false, used: 0, next: null });
    for (let i = 0; i < 3; i += 1) recordSuite(state, 'acme-qa', T0 + i * 60_000);
    expect(evalRoom(state, 'acme-qa', { now: T0 + HOUR, wanted: 11 })).toEqual({ ok: false, used: 3, next: null });
    expect(evalRoom(state, 'acme-qa', { now: T0 + HOUR, wanted: 2, limit: ONE })).toEqual({ ok: false, used: 3, next: null });
  });

  it('prunes entries older than the window on write, for every org', () => {
    recordSuite(state, 'acme-qa', T0);
    recordSuite(state, 'acme-uat', T0);
    recordSuite(state, 'acme-qa', T0 + 11 * HOUR);
    expect(JSON.parse(fs.readFileSync(evalsFile(state), 'utf8'))).toEqual({ orgs: { 'acme-qa': [new Date(T0 + 11 * HOUR).toISOString()] } });
    expect(evalsFile(state)).toBe(path.join(state, 'salesforce', 'agent-evals.json'));
  });

  it('reads a broken file as empty', () => {
    fs.mkdirSync(path.dirname(evalsFile(state)), { recursive: true });
    for (const broken of ['{not json', '[]', '{"orgs":[]}', '{"orgs":{"acme-qa":"x"}}']) {
      fs.writeFileSync(evalsFile(state), broken);
      expect(evalRoom(state, 'acme-qa', { now: T0 }), broken).toEqual({ ok: true, used: 0, next: null });
    }
    recordSuite(state, 'acme-qa', T0);
    expect(evalRoom(state, 'acme-qa', { now: T0 }).used).toBe(1);
  });
});

// agentforceCheck in the stage org, with every sf and HTTP call faked. ctx.sh is the raw sh, as in
// sf-verify, and the check gets the isolated sh over it.
const xml = (types) =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
    ...Object.entries(types).map(([name, members]) => `    <types>\n${members.map((m) => `        <members>${m}</members>`).join('\n')}\n        <name>${name}</name>\n    </types>`),
    '    <version>62.0</version>',
    '</Package>',
    '',
  ].join('\n');
const versions = (list) => sfOk({ records: list.map(([n, status]) => ({ VersionNumber: n, Status: status })), totalSize: list.length, done: true });
const inTurn = (...answers) => {
  let n = 0;
  return () => answers[Math.min(n++, answers.length - 1)];
};
const publishRules = () => [
  [/^sf agent validate authoring-bundle /, sfOk({ success: true })],
  [/^sf agent publish authoring-bundle /, sfOk({ success: true })],
  [/^sf agent activate /, sfOk({ success: true })],
  [/FROM BotVersion/, inTurn(versions([[1, 'Active']]), versions([[1, 'Active'], [2, 'Inactive']]), versions([[1, 'Inactive'], [2, 'Active']]))],
];
const ENV = () => ({ FOREMAN_SF_HOME: sfHome, FOREMAN_STATE_DIR: state, PATH: tempPath(dir, fakeRealSf(dir)) });

function setup({ rules = [], fetch = fakeFetch(), spec = ACME_SPEC, display, list, planner, layout = LAYOUT } = {}) {
  const raw = fakeSh([...rules, ...evalRules({ spec, ...(display ? { display } : {}), ...(list ? { list } : {}), ...(planner ? { planner } : {}) }), ...publishRules()]);
  const ctx = fakeCtx({ config: { pack: 'salesforce', salesforce: layout, slots: 1 }, root: '/acme/repo', env: ENV() });
  const file = path.join(dir, 'package.xml');
  fs.writeFileSync(file, xml({ AiAuthoringBundle: [API], ApexClass: ['AcmeOrderStatusAction'] }));
  ctx.sh = raw;
  ctx.fetch = fetch;
  ctx.sfDelta = { to: 'bbb', manifest: file };
  ctx.sha = '0123456789abcdef0123456789abcdef01234567';
  const sh = isolatedSh(raw, ENV(), sfHome, os.homedir());
  return { ctx, raw, fetch, run: () => agentforceCheck.run({ ctx, sh, stage: STAGE }) };
}
const sfLines = (raw) => raw.calls.filter((l) => l.startsWith('sf '));
const PLANNER_LINE = `sf data query --query SELECT Id FROM GenAiPlannerDefinition WHERE DeveloperName = '${API}_v2' --target-org acme-qa --json`;
const DISPLAY_LINE = 'sf org display --target-org acme-qa --json';
const LIST_LINE = 'sf org list --all --skip-connection-status --json';
const published = (raw) => sfLines(raw).some((l) => l.startsWith('sf agent publish '));

// Every file under a folder, as text.
function filesUnder(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(p));
    else out.push(fs.readFileSync(p, 'utf8'));
  }
  return out;
}

// The secret rule: no session token and no JWT in a result or in any file Foreman wrote.
function noSecrets(result) {
  for (const t of [JSON.stringify(result), ...filesUnder(state), ...filesUnder(path.join(sfHome, '.foreman'))]) {
    expect(t).not.toContain(ACME_SESSION);
    expect(t).not.toContain(ACME_JWT);
  }
}

describe('agentforceCheck runs the eval suite after the activate (gating)', () => {
  it('passes when every check passes, testing the activated version through its planner', async () => {
    const { ctx, raw, fetch, run } = setup();
    const r = await run();
    expect(r).toEqual({ ok: true, changedOrg: true, agents: [{ apiName: API, previous: 1, version: 2 }] });
    expect(ctx.sleeps).toEqual([]);
    expect(sfLines(raw).slice(-3)).toEqual([LIST_LINE, DISPLAY_LINE, PLANNER_LINE]);
    const posts = fetch.posts();
    expect(posts).toHaveLength(1);
    expect(posts[0].body.tests.map((t) => t.steps[0].planner_id)).toEqual([PID, PID]);
    expect(posts[0].body).toEqual(evalPayload(readEvalSpec(text(ACME_SPEC), API).spec, PID));
    noSecrets(r);
  });

  it('re-runs only the case whose routing failed, and passes with a flake note when the re-run passes', async () => {
    let n = 0;
    const fetch = fakeFetch({ evals: (call) => (n++ === 0 ? failing(call.body, { 'order-status': ['routing_2'] }) : passAll(call.body)) });
    const { ctx, run } = setup({ fetch });
    const r = await run();
    expect(r).toMatchObject({ ok: true, changedOrg: true, agents: [{ apiName: API, previous: 1, version: 2 }] });
    expect(r.notes).toEqual(['Agent Acme_Order_Helper in qa: routing case order-status passed only on the re-run']);
    const posts = fetch.posts();
    expect(posts).toHaveLength(2);
    expect(posts[1].body.tests.map((t) => t.id)).toEqual(['order-status']);
    expect(evalRoom(state, 'acme-qa', { now: ctx.now() }).used).toBe(1);
    noSecrets(r);
  });

  it('blocks when the routing fails again on the re-run, naming the agent, case, check and expected text, and keeps the agents for rollback', async () => {
    const fetch = fakeFetch({ evals: (call) => failing(call.body, { 'order-status': ['routing_2'] }) });
    const { run } = setup({ fetch });
    const r = await run();
    expect(r).toEqual({ ok: false, reason: "agent Acme_Order_Helper in acme-qa (qa): routing failed in case order-status (routing_2: expected 'name': 'get_order_status'), also on the re-run", changedOrg: true });
    expect(r.reason).not.toContain('ACTUAL-FROM-API');
    expect(fetch.posts()).toHaveLength(2);
    expect(readRelease(state, 'S-1').agents).toMatchObject([{ stage: 'qa', org: 'acme-qa', apiName: API, previous: 1, version: 2 }]);
    noSecrets(r);
  });

  it('passes an outcome-only failure with a minor note and no re-run', async () => {
    const fetch = fakeFetch({ evals: (call) => failing(call.body, { greeting: ['outcome'] }) });
    const { run } = setup({ fetch });
    const r = await run();
    expect(r).toMatchObject({ ok: true, changedOrg: true });
    expect(r.notes).toEqual(['Check agent Acme_Order_Helper in qa: the judge scored case greeting below 3']);
    expect(fetch.posts()).toHaveLength(1);
    noSecrets(r);
  });

  it('sends 7 cases as 2 POSTs of 5 and 2', async () => {
    const { fetch, run } = setup({ spec: specWith(7) });
    expect((await run()).ok).toBe(true);
    expect(fetch.posts().map((p) => p.body.tests.length)).toEqual([5, 2]);
    expect(fetch.posts().flatMap((p) => p.body.tests.map((t) => t.id))).toEqual(['case-1', 'case-2', 'case-3', 'case-4', 'case-5', 'case-6', 'case-7']);
  });

  it('writes the response JSON and the JUnit file under salesforce/evals/<story>/<stage>-<Api>', async () => {
    const fetch = fakeFetch({ evals: (call) => failing(call.body, { greeting: ['outcome'] }) });
    const { run } = setup({ fetch });
    const r = await run();
    const base = path.join(state, 'salesforce', 'evals', 'S-1', `qa-${API}`);
    const response = JSON.parse(fs.readFileSync(`${base}.json`, 'utf8'));
    expect(response.results.map((t) => t.id)).toEqual(['order-status', 'greeting']);
    const report = fs.readFileSync(`${base}.junit.xml`, 'utf8');
    expect(report.match(/<testcase /g)).toHaveLength(2);
    expect(report).toContain('<failure type="outcome"');
    noSecrets(r);
  });
});

describe('the eval caller', () => {
  const cooldownRecord = () => JSON.parse(fs.readFileSync(cooldownFile(sfHome, 'acme-qa'), 'utf8'));

  it('reads the sign-in with SF_TEMP_SHOW_SECRETS on that call alone, every sf call in the sf home', async () => {
    const { raw, run } = setup();
    await run();
    const at = raw.calls.indexOf(DISPLAY_LINE);
    expect(at).toBeGreaterThanOrEqual(0);
    raw.calls.forEach((line, i) => {
      if (!line.startsWith('sf ')) return;
      expect(raw.opts[i].env.HOME, line).toBe(sfHome);
      expect(raw.opts[i].env.SF_TEMP_SHOW_SECRETS, line).toBe(i === at ? 'true' : undefined);
    });
  });

  it('asks userinfo with the session as Bearer, nameduser with the session cookie only, and posts with the JWT and every header', async () => {
    const { fetch, run } = setup();
    await run();
    const [userinfo, nameduser, post] = fetch.calls;
    expect(userinfo).toMatchObject({ url: `${ACME_INSTANCE}/services/oauth2/userinfo`, method: 'GET' });
    expect(userinfo.headers.Authorization).toBe(`Bearer ${ACME_SESSION}`);
    expect(nameduser).toMatchObject({ url: `${ACME_INSTANCE}/agentforce/bootstrap/nameduser`, method: 'GET' });
    expect(nameduser.headers.Cookie).toBe(`sid=${ACME_SESSION}`);
    expect(userinfo.redirect).toBe('manual');
    expect(nameduser.redirect).toBe('manual');
    expect(Object.keys(nameduser.headers).map((k) => k.toLowerCase())).not.toContain('authorization');
    expect(post).toMatchObject({ url: EVAL_URL, method: 'POST' });
    expect(post.headers).toEqual({
      Authorization: `Bearer ${ACME_JWT}`,
      'Content-Type': 'application/json',
      'x-sfdc-core-tenant-id': `core/prod/${ACME_QA_ID}`,
      'x-org-id': ACME_QA_ID,
      'x-sfdc-core-instance-url': ACME_INSTANCE,
      'x-sfdc-user-id': ACME_USER_ID,
      'x-client-feature-id': 'AIPlatformEvaluation',
      'x-sfdc-app-context': 'EinsteinGPT',
    });
    for (const c of fetch.calls) expect(c.signal).toBeInstanceOf(AbortSignal);
  });

  const refusedBeforeFetch = [
    ['an org display id that is another org', orgDisplay({ id: '00D000000000009AAA' })],
    ['an http instance URL', orgDisplay({ instanceUrl: 'http://acme-qa.sandbox.my.salesforce.com' })],
    ['an instance URL on another host', orgDisplay({ instanceUrl: 'https://acme-qa.evil.example' })],
    ['a host that only starts like Salesforce', orgDisplay({ instanceUrl: 'https://acme.salesforce.com.evil.example' })],
    ['no session token', orgDisplay({ accessToken: undefined })],
    ['a redacted placeholder instead of a session', orgDisplay({ accessToken: "[REDACTED] Use 'sf org display --verbose' to see the access token" })],
    ['a token with a space', orgDisplay({ accessToken: '00D000000000002!abc def' })],
    ['a token of another org', orgDisplay({ accessToken: '00D000000000009!abc' })],
    ['an org display that fails', sfError('NoAuthInfoFound', 'No authorization information found for acme-qa.')],
  ];
  for (const [name, display] of refusedBeforeFetch) {
    it(`fails before any fetch for ${name}, after the publish and activate`, async () => {
      const { raw, fetch, run } = setup({ display });
      const r = await run();
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('acme-qa');
      expect(fetch.calls).toEqual([]);
      expect(published(raw)).toBe(true);
      expect(readRelease(state, 'S-1').agents).toHaveLength(1);
      noSecrets(r);
    });
  }

  it('names the redacted placeholder, never quotes it, and sends no request', async () => {
    const { raw, fetch, run } = setup({ display: orgDisplay({ accessToken: "[REDACTED] Use 'sf org display --verbose' to see the access token" }) });
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('redacted');
    expect(r.reason).toContain('acme-qa');
    expect(r.reason).not.toContain('[REDACTED] Use');
    expect(fetch.calls).toEqual([]);
    expect(published(raw)).toBe(true);
  });

  it('reads the session through the real sf: the reveal call starts its PATH with the real sf folder, no wrapper folder, and every other sf call keeps the caller PATH', async () => {
    const { raw, run } = setup();
    await run();
    const at = raw.calls.indexOf(DISPLAY_LINE);
    const first = raw.opts[at].env.PATH.split(path.delimiter)[0];
    expect(first).toBe(path.join(dir, 'real-bin'));
    expect(raw.opts[at].env.PATH.split(path.delimiter)).not.toContain(binDir(sfHome));
    raw.calls.forEach((line, i) => {
      if (!line.startsWith('sf ') || i === at) return;
      expect(raw.opts[i].env.PATH, line).toBe(ENV().PATH);
    });
  });

  it('lists the orgs before the display, with no SF_TEMP_SHOW_SECRETS', async () => {
    const { raw, run } = setup();
    await run();
    const list = raw.calls.indexOf(LIST_LINE);
    expect(list).toBeGreaterThanOrEqual(0);
    expect(list).toBeLessThan(raw.calls.indexOf(DISPLAY_LINE));
    expect(raw.opts[list].env.SF_TEMP_SHOW_SECRETS).toBeUndefined();
  });

  const refusedBeforeDisplay = [
    ['the alias listed under another org ID', orgList([{ alias: 'acme-qa', orgId: '00D000000000009AAA', username: 'admin@acme-qa.acme.example' }]), 'another org'],
    ['the alias listed under the production org ID', orgList([{ alias: 'acme-qa', orgId: ACME_PROD_ID, username: 'admin@acme-qa.acme.example' }]), 'production'],
    ['the alias missing from the list', orgList([]), 'not signed in'],
    ['the list failing', sfError('SfError', 'Acme list broke'), 'could not read the sign-in of acme-qa'],
  ];
  for (const [name, list, reason] of refusedBeforeDisplay) {
    it(`refuses with no display and no fetch for ${name}`, async () => {
      const layout = { ...LAYOUT, orgs: { ...LAYOUT.orgs, 'acme-main': { orgId: ACME_PROD_ID, production: true } } };
      const { raw, fetch, run } = setup({ list, layout });
      const r = await run();
      expect(r.ok).toBe(false);
      expect(r.reason).toContain(reason);
      expect(raw.calls).not.toContain(DISPLAY_LINE);
      expect(fetch.calls).toEqual([]);
      noSecrets(r);
    });
  }

  it('refuses a session whose alias was re-pointed to production after the list: no fetch, and the production token in no reason or file', async () => {
    const layout = { ...LAYOUT, orgs: { ...LAYOUT.orgs, 'acme-main': { orgId: ACME_PROD_ID, production: true } } };
    const prodToken = sessionOf(ACME_PROD_ID);
    // The list still maps acme-qa to the QA org, so the display answering the production org models the alias moving between the two.
    const { raw, fetch, run } = setup({ layout, display: orgDisplay({ id: ACME_PROD_ID }) });
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('another org');
    expect(r.reason).toContain('acme-qa');
    expect(fetch.calls).toEqual([]);
    expect(raw.calls).toContain(DISPLAY_LINE);
    for (const t of [JSON.stringify(r), ...filesUnder(state), ...filesUnder(path.join(sfHome, '.foreman'))]) {
      expect(t).not.toContain(prodToken);
    }
    noSecrets(r);
  });

  it('still passes when a production org is marked beside the stage org', async () => {
    const layout = { ...LAYOUT, orgs: { ...LAYOUT.orgs, 'acme-main': { orgId: ACME_PROD_ID, production: true } } };
    const { run } = setup({ layout });
    expect((await run()).ok).toBe(true);
  });

  it('refuses a stage org that salesforce.orgs marks production: no display, no fetch', async () => {
    const layout = { ...LAYOUT, orgs: { ...LAYOUT.orgs, 'acme-qa': { orgId: ACME_QA_ID, production: true } } };
    const { raw, fetch, run } = setup({ layout });
    const r = await run();
    expect(r).toMatchObject({ ok: false, changedOrg: true });
    expect(r.reason).toContain('production');
    expect(raw.calls).not.toContain(DISPLAY_LINE);
    expect(fetch.calls).toEqual([]);
  });

  it('refuses a production org ID under a non-production alias with no sf call at all', async () => {
    const raw = fakeSh(evalRules());
    const fetch = fakeFetch();
    const block = { ...LAYOUT, orgs: { ...LAYOUT.orgs, 'acme-main': { orgId: ACME_PROD_ID, production: true } } };
    const sh = isolatedSh(raw, ENV(), sfHome, os.homedir());
    const r = await agentSession({ sh, rawSh: raw, env: ENV(), block, org: 'acme-qa', orgId: ACME_PROD_ID, fetch });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('production');
    expect(raw.calls).toEqual([]);
    expect(fetch.calls).toEqual([]);
  });

  it('fails when nameduser gives no JWT', async () => {
    const { fetch, run } = setup({ fetch: fakeFetch({ nameduser: { access_token: 'not-a-jwt' } }) });
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('acme-qa');
    expect(fetch.posts()).toEqual([]);
    noSecrets(r);
  });

  it('fails on a login-rate answer from nameduser and cools the org down', async () => {
    const nameduser = () => new Response('{"error":"login rate exceeded"}', { status: 400 });
    const { ctx, fetch, run } = setup({ fetch: fakeFetch({ nameduser }) });
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('login rate exceeded');
    expect(fetch.posts()).toEqual([]);
    expect(fetch.calls).toHaveLength(2);
    expect(ctx.sleeps).toEqual([]);
    expect(coolingDown(sfHome, 'acme-qa', ctx.now())).not.toBeNull();
    noSecrets(r);
  });

  it('retries userinfo once after RETRY_WAIT_MS when it answers 403 and then 200', async () => {
    let n = 0;
    const userinfo = () => (n++ === 0 ? new Response('{"error":"Forbidden"}', { status: 403 }) : { user_id: ACME_USER_ID });
    const { ctx, fetch, run } = setup({ fetch: fakeFetch({ userinfo }) });
    const r = await run();
    expect(r.ok).toBe(true);
    expect(fetch.calls.filter((c) => c.url.endsWith('/services/oauth2/userinfo'))).toHaveLength(2);
    expect(ctx.sleeps).toEqual([RETRY_WAIT_MS]);
    expect(fetch.posts()).toHaveLength(1);
    noSecrets(r);
  });

  it('retries nameduser once when it answers 503 and then 200', async () => {
    let n = 0;
    const nameduser = () => (n++ === 0 ? new Response('Service Unavailable', { status: 503 }) : { access_token: ACME_JWT });
    const { ctx, fetch, run } = setup({ fetch: fakeFetch({ nameduser }) });
    const r = await run();
    expect(r.ok).toBe(true);
    expect(fetch.calls.filter((c) => c.url.endsWith('/agentforce/bootstrap/nameduser'))).toHaveLength(2);
    expect(ctx.sleeps).toEqual([RETRY_WAIT_MS]);
  });

  it('retries userinfo once after a network error', async () => {
    const inner = fakeFetch();
    let thrown = false;
    const flaky = async (url, init) => {
      if (String(url).endsWith('/services/oauth2/userinfo') && !thrown) {
        thrown = true;
        throw new TypeError('fetch failed');
      }
      return inner(url, init);
    };
    const { ctx, run } = setup({ fetch: flaky });
    const r = await run();
    expect(r.ok).toBe(true);
    expect(ctx.sleeps).toEqual([RETRY_WAIT_MS]);
  });

  it('fails on a second 403 from userinfo, quoting what Salesforce answered with no token in it', async () => {
    const userinfo = () => new Response(`[{"errorCode":"INSUFFICIENT_ACCESS","message":"Session ${ACME_SESSION} denied"}]`, { status: 403 });
    const { ctx, fetch, run } = setup({ fetch: fakeFetch({ userinfo }) });
    const r = await run();
    expect(r).toEqual({
      ok: false,
      reason: 'could not test the agents in acme-qa (qa): could not read the user of acme-qa (HTTP 403, after one retry): Salesforce answered "INSUFFICIENT_ACCESS: Session ••• denied"',
      changedOrg: true,
    });
    expect(fetch.calls).toHaveLength(2);
    expect(fetch.posts()).toEqual([]);
    expect(ctx.sleeps).toEqual([RETRY_WAIT_MS]);
    noSecrets(r);
  });

  it('says so when userinfo gets no answer twice', async () => {
    const failingFetch = async () => {
      throw new TypeError('fetch failed');
    };
    const { run } = setup({ fetch: failingFetch });
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('could not read the user of acme-qa: no answer, after one retry');
  });

  it('never retries a userinfo 403 whose body says login rate exceeded, and cools the org down', async () => {
    const userinfo = () => new Response('{"error":"login rate exceeded"}', { status: 403 });
    const { ctx, fetch, run } = setup({ fetch: fakeFetch({ userinfo }) });
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('login rate exceeded');
    expect(fetch.calls).toHaveLength(1);
    expect(ctx.sleeps).toEqual([]);
    expect(coolingDown(sfHome, 'acme-qa', ctx.now())).not.toBeNull();
    expect(cooldownRecord().at).toBe(ctx.now().toISOString());
    noSecrets(r);
  });

  it('cools the org down when the retry itself answers login rate exceeded', async () => {
    let n = 0;
    const userinfo = () => (n++ === 0 ? new Response('down', { status: 503 }) : new Response('{"error":"login rate exceeded"}', { status: 400 }));
    const { ctx, fetch, run } = setup({ fetch: fakeFetch({ userinfo }) });
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('login rate exceeded');
    expect(fetch.calls).toHaveLength(2);
    expect(ctx.sleeps).toEqual([RETRY_WAIT_MS]);
    expect(coolingDown(sfHome, 'acme-qa', ctx.now())).not.toBeNull();
    const rec = cooldownRecord();
    expect(rec.at).toBe(ctx.now().toISOString());
    expect(rec.until).toBe(new Date(ctx.now().getTime() + COOLDOWN_MS).toISOString());
    expect(r.reason).toContain(rec.until);
  });

  it('counts both retry waits when userinfo and then nameduser are retried before login rate exceeded', async () => {
    let u = 0;
    let n = 0;
    const userinfo = () => (u++ === 0 ? new Response('down', { status: 503 }) : { user_id: ACME_USER_ID });
    const nameduser = () => (n++ === 0 ? new Response('down', { status: 503 }) : new Response('{"error":"login rate exceeded"}', { status: 400 }));
    const { ctx, run } = setup({ fetch: fakeFetch({ userinfo, nameduser }) });
    const r = await run();
    expect(r.ok).toBe(false);
    expect(ctx.sleeps).toEqual([RETRY_WAIT_MS, RETRY_WAIT_MS]);
    expect(cooldownRecord().at).toBe(ctx.now().toISOString());
    noSecrets(r);
  });

  it('does not retry a 401 or a 404 on userinfo', async () => {
    for (const status of [401, 404]) {
      const { ctx, fetch, run } = setup({ fetch: fakeFetch({ userinfo: () => new Response('nope', { status }) }) });
      const r = await run();
      expect(r.ok).toBe(false);
      expect(r.reason).toContain(`HTTP ${status})`);
      expect(r.reason).not.toContain('after one retry');
      expect(fetch.calls).toHaveLength(1);
      expect(ctx.sleeps).toEqual([]);
    }
  });

  it('fails after exactly one POST on an eval 429, and records no cool-down', async () => {
    const { ctx, fetch, run } = setup({ fetch: fakeFetch({ evals: () => new Response('Too Many Requests', { status: 429 }) }) });
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('the eval API is limiting calls (HTTP 429)');
    expect(fetch.posts()).toHaveLength(1);
    expect(ctx.sleeps).toEqual([]);
    expect(fs.existsSync(cooldownFile(sfHome, 'acme-qa'))).toBe(false);
    noSecrets(r);
  });

  it('treats a body naming a request limit as the eval API limiting calls', async () => {
    const { ctx, fetch, run } = setup({ fetch: fakeFetch({ evals: () => new Response('{"message":"REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded."}', { status: 403 }) }) });
    const r = await run();
    expect(r.reason).toContain('the eval API is limiting calls (HTTP 403)');
    expect(fetch.posts()).toHaveLength(1);
    expect(ctx.sleeps).toEqual([]);
    expect(fs.existsSync(cooldownFile(sfHome, 'acme-qa'))).toBe(false);
  });

  it('fails after exactly one POST on an eval 401, with the status only', async () => {
    const { fetch, run } = setup({ fetch: fakeFetch({ evals: () => new Response(`Invalid token ${ACME_JWT}`, { status: 401 }) }) });
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('HTTP 401');
    expect(r.reason).toContain('Invalid token •••');
    expect(r.reason).not.toContain(ACME_JWT);
    expect(fetch.posts()).toHaveLength(1);
    noSecrets(r);
  });

  it('fails when a network error stops a call', async () => {
    const fetch = fakeFetch();
    const failingFetch = async (url, init) => {
      if (String(url) === EVAL_URL) {
        failingFetch.posts += 1;
        throw Object.assign(new Error(`connect ECONNREFUSED ${ACME_JWT}`), { name: 'TypeError' });
      }
      return fetch(url, init);
    };
    failingFetch.posts = 0;
    const { ctx, run } = setup({ fetch: failingFetch });
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('could not reach the eval API: no answer, after one retry');
    expect(failingFetch.posts).toBe(2);
    expect(ctx.sleeps).toEqual([RETRY_WAIT_MS]);
    noSecrets(r);
  });

  it('retries an eval POST once after a 503 and records one suite', async () => {
    let n = 0;
    const evals = (call) => (n++ === 0 ? new Response('Service Unavailable', { status: 503 }) : passAll(call.body));
    const { ctx, fetch, run } = setup({ fetch: fakeFetch({ evals }) });
    const r = await run();
    expect(r.ok).toBe(true);
    expect(fetch.posts()).toHaveLength(2);
    expect(ctx.sleeps).toEqual([RETRY_WAIT_MS]);
    expect(evalRoom(state, 'acme-qa', { now: ctx.now() }).used).toBe(1);
    noSecrets(r);
  });

  it('quotes the redacted answer when an eval POST is refused twice', async () => {
    const evals = () => new Response('{"message":"Forbidden for aaa.bbb.ccc"}', { status: 403 });
    const { fetch, run } = setup({ fetch: fakeFetch({ evals }) });
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('the eval API refused the suite (HTTP 403, after one retry): Salesforce answered "Forbidden for •••"');
    expect(fetch.posts()).toHaveLength(2);
    noSecrets(r);
  });

  it('does not retry an eval POST that timed out', async () => {
    const inner = fakeFetch();
    let posts = 0;
    const timing = async (url, init) => {
      if (String(url) === EVAL_URL) {
        posts += 1;
        throw Object.assign(new Error('x'), { name: 'TimeoutError' });
      }
      return inner(url, init);
    };
    const { ctx, run } = setup({ fetch: timing });
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('timed out');
    expect(r.reason).not.toContain('after one retry');
    expect(posts).toBe(1);
    expect(ctx.sleeps).toEqual([]);
  });

  it('retries each batch on its own', async () => {
    let second = 0;
    const evals = (call) => {
      if (call.body.tests[0].id === 'case-6' && second++ === 0) return new Response('boom', { status: 500 });
      return passAll(call.body);
    };
    const { ctx, fetch, run } = setup({ spec: specWith(7), fetch: fakeFetch({ evals }) });
    const r = await run();
    expect(r.ok).toBe(true);
    expect(fetch.posts()).toHaveLength(3);
    expect(ctx.sleeps).toEqual([RETRY_WAIT_MS]);
  });

  it('fails a 302 on userinfo as plain HTTP 302, following nothing', async () => {
    const fetch = fakeFetch({ userinfo: () => new Response(null, { status: 302, headers: { Location: 'https://acme.evil.example/' } }) });
    const { run } = setup({ fetch });
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('HTTP 302');
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.posts()).toEqual([]);
    noSecrets(r);
  });

  it('fails a 302 on nameduser as plain HTTP 302, following nothing', async () => {
    const fetch = fakeFetch({ nameduser: () => new Response(null, { status: 302, headers: { Location: 'https://acme.evil.example/' } }) });
    const { run } = setup({ fetch });
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('agent token');
    expect(r.reason).toContain('HTTP 302');
    expect(fetch.calls).toHaveLength(2);
    expect(fetch.posts()).toEqual([]);
    noSecrets(r);
  });

  it('fails with no planner record, or two, before any POST', async () => {
    for (const planner of [planners([]), planners([PID, '16j000000000003AAA']), planners(["x' OR Id != '"]), sfError('SfError', 'Acme query broke')]) {
      const { fetch, run } = setup({ planner });
      const r = await run();
      expect(r.ok).toBe(false);
      expect(r.reason).toContain(API);
      expect(fetch.posts()).toEqual([]);
      noSecrets(r);
    }
  });

  it('refuses a missing or malformed spec before any sf call', async () => {
    for (const spec of [null, '{', { ...clone(ACME_SPEC), tests: [] }]) {
      const { raw, fetch, run } = setup({ spec });
      const r = await run();
      expect(r.ok).toBe(false);
      expect(r.reason).toContain(FILE);
      expect(sfLines(raw)).toEqual([]);
      expect(fetch.calls).toEqual([]);
    }
  });
});

// The wrapper in place with a production org marked, run for real: it unsets SF_TEMP_SHOW_SECRETS,
// so only a read through the real sf gets the session.
describe('agentSession with a production org marked and the wrapper in place, run for real', { timeout: 30_000 }, () => {
  const REAL_TOKEN = '00D000000000002!REAL.TOKEN.FOR.TEST';
  const REDACTED = "[REDACTED] Use 'sf org display --verbose' to see the access token";
  let log;
  let env;
  let rawSh;
  let sh;
  const block = { ...LAYOUT, orgs: { ...LAYOUT.orgs, 'acme-main': { orgId: ACME_PROD_ID, production: true } } };

  beforeEach(() => {
    const realDir = path.join(dir, 'real');
    fs.mkdirSync(realDir, { recursive: true });
    log = path.join(dir, 'fake-sf.log');
    const realSf = path.join(realDir, 'sf');
    const script = [
      '#!/bin/sh',
      'echo "${SF_TEMP_SHOW_SECRETS-unset}|$*" >> "$FAKE_LOG"',
      'if [ "$1 $2" = "org list" ]; then',
      `  echo '{"status":0,"result":{"sandboxes":[{"alias":"acme-qa","orgId":"${ACME_QA_ID}","username":"admin@acme-qa.acme.example"},{"alias":"acme-main","orgId":"${ACME_PROD_ID}","username":"admin@acme-main.acme.example"}]}}'`,
      '  exit 0',
      'fi',
      'if [ "$1 $2" = "org display" ]; then',
      '  alias=""; prev=""',
      '  for a in "$@"; do if [ "$prev" = "--target-org" ]; then alias="$a"; fi; prev="$a"; done',
      `  if [ "$alias" = "acme-main" ]; then id="${ACME_PROD_ID}"; else id="${ACME_QA_ID}"; fi`,
      `  if [ "$SF_TEMP_SHOW_SECRETS" = "true" ]; then t='${REAL_TOKEN}'; else t="${REDACTED}"; fi`,
      `  echo "{\\"status\\":0,\\"result\\":{\\"id\\":\\"$id\\",\\"instanceUrl\\":\\"${ACME_INSTANCE}\\",\\"accessToken\\":\\"$t\\"}}"`,
      '  exit 0',
      'fi',
      'exit 0',
      '',
    ].join('\n');
    fs.writeFileSync(realSf, script, { mode: 0o755 });
    fs.mkdirSync(binDir(sfHome), { recursive: true });
    fs.writeFileSync(path.join(binDir(sfHome), 'sf'), wrapperScript({ realSf, dataDir: path.join(dir, 'data'), production: [{ alias: 'acme-main', orgId: ACME_PROD_ID }] }), { mode: 0o755 });
    env = {
      PATH: tempPath(dir, binDir(sfHome), realDir),
      FOREMAN_SF_HOME: sfHome,
      FAKE_LOG: log,
    };
    rawSh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });
    sh = isolatedSh(rawSh, env, sfHome, os.homedir());
  });

  const logged = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '');

  it('gives a sandbox the real session: userinfo gets it as Bearer', async () => {
    const fetch = fakeFetch();
    const r = await agentSession({ sh, rawSh, env, block, org: 'acme-qa', orgId: ACME_QA_ID, fetch });
    expect(r.ok, r.reason).toBe(true);
    expect(fetch.calls[0].headers.Authorization).toBe(`Bearer ${REAL_TOKEN}`);
    expect(logged()).toContain('true|org display --target-org acme-qa');
    expect(logged()).toContain('unset|org list');
  });

  it('gives production nothing: no org display, no fetch', async () => {
    const fetch = fakeFetch();
    const r = await agentSession({ sh, rawSh, env, block, org: 'acme-main', orgId: ACME_PROD_ID, fetch });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('production');
    expect(fetch.calls).toEqual([]);
    expect(logged()).not.toContain('org display');
  });

  it("builds every PATH from the test's temp folder alone, so the sf the session reads is the test's fake", () => {
    for (const entry of env.PATH.split(path.delimiter)) {
      expect(path.relative(dir, entry).startsWith('..'), entry).toBe(false);
    }
    expect(findRealSf(env, fs, binDir(sfHome))).toBe(path.join(dir, 'real', 'sf'));
  });

  it('refuses a PATH with only the wrapper, naming the missing sf, with no fetch', async () => {
    const empty = path.join(dir, 'empty-bin');
    fs.mkdirSync(empty, { recursive: true });
    const wrapperOnly = { ...env, PATH: tempPath(dir, binDir(sfHome), empty) };
    expect(findRealSf(wrapperOnly, fs, binDir(sfHome))).toBeNull();
    const fetch = fakeFetch();
    const r = await agentSession({ sh: isolatedSh(rawSh, wrapperOnly, sfHome, os.homedir()), rawSh, env: wrapperOnly, block, org: 'acme-qa', orgId: ACME_QA_ID, fetch });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('no Salesforce CLI on PATH');
    expect(fetch.calls).toEqual([]);
    expect(logged()).not.toContain('org display');
  });
});

describe('tempPath', () => {
  it('joins folders inside the root with the path delimiter', () => {
    expect(tempPath(dir, path.join(dir, 'a'), path.join(dir, 'b', 'c'))).toBe([path.join(dir, 'a'), path.join(dir, 'b', 'c')].join(path.delimiter));
  });

  it('throws on any folder that is not inside the root', () => {
    for (const bad of ['/usr/bin', '/bin', path.dirname(process.execPath), 'bin', `${dir}-other/bin`, path.join(dir, '..', 'x'), dir]) {
      expect(() => tempPath(dir, bad), bad).toThrow(/not inside/);
    }
  });

  it('throws on a root outside the temp folder', () => {
    const root = path.parse(os.tmpdir()).root;
    expect(() => tempPath(root, path.join(root, 'bin'))).toThrow(/not inside the temp folder/);
  });

  it('throws when given no folders', () => {
    expect(() => tempPath(dir)).toThrow();
  });
});

describe('the suite counter through agentforceCheck', () => {
  it('refuses the 11th suite in 10 hours before any validate or publish, and another org still has room', async () => {
    const { ctx, raw, fetch, run } = setup();
    const now = ctx.now().getTime();
    for (let i = 0; i < 10; i += 1) recordSuite(state, 'acme-qa', now - (9.5 * HOUR) + i * 60_000);
    const r = await run();
    const next = new Date(now - 9.5 * HOUR + 10 * HOUR).toISOString();
    expect(r).toEqual({ ok: false, reason: `agent eval limit: 10 suites ran in acme-qa in the last 10 hours (limit 10); the next can run after ${next}` });
    expect(sfLines(raw).filter((l) => /^sf agent (validate|publish)/.test(l))).toEqual([]);
    expect(sfLines(raw)).toEqual([]);
    expect(fetch.calls).toEqual([]);
    expect(evalRoom(state, 'acme-uat', { now }).ok).toBe(true);
  });

  it('refuses more agents than the suite limit before any sf call, fetch or counter write', async () => {
    const { ctx, raw, fetch, run } = setup();
    const names = Array.from({ length: 11 }, (_, i) => `Acme_Agent_${String(i + 1).padStart(2, '0')}`);
    fs.writeFileSync(ctx.sfDelta.manifest, xml({ AiAuthoringBundle: names }));
    const r = await run();
    expect(r).toEqual({ ok: false, reason: '11 agents changed, but acme-qa runs at most 10 eval suites in 10 hours, one per agent: split the story so a release changes at most 10 agents' });
    expect(sfLines(raw)).toEqual([]);
    expect(fetch.calls).toEqual([]);
    expect(r.reason).not.toContain('null');
    expect(fs.existsSync(evalsFile(state))).toBe(false);
  });

  it('does not refuse exactly 10 agents for being too many', async () => {
    const { ctx, run } = setup({ spec: null });
    const names = Array.from({ length: 10 }, (_, i) => `Acme_Agent_${String(i + 1).padStart(2, '0')}`);
    fs.writeFileSync(ctx.sfDelta.manifest, xml({ AiAuthoringBundle: names }));
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.reason).not.toContain('agents changed');
  });

  it('records one suite per agent, and none for the re-run', async () => {
    let n = 0;
    const fetch = fakeFetch({ evals: (call) => (n++ === 0 ? failing(call.body, { greeting: ['routing_1'] }) : passAll(call.body)) });
    const { ctx, run } = setup({ fetch });
    expect((await run()).ok).toBe(true);
    expect(evalRoom(state, 'acme-qa', { now: ctx.now() }).used).toBe(1);
  });

  it('reads the versions three times, all before the eval', async () => {
    const { raw, run } = setup();
    await run();
    const q = `sf data query --query ${versionsQuery(API)} --target-org acme-qa --json`;
    expect(sfLines(raw).filter((l) => l === q)).toHaveLength(3);
    expect(sfLines(raw).indexOf(DISPLAY_LINE)).toBeGreaterThan(sfLines(raw).lastIndexOf(q));
  });
});

describe('answerSnippet', () => {
  it('reads the code and message of an error array, or of a plain object', () => {
    expect(answerSnippet('[{"errorCode":"X","message":"m"}]')).toBe('X: m');
    expect(answerSnippet('{"error":"invalid_request","error_description":"d"}')).toBe('invalid_request: d');
    expect(answerSnippet('{"message":"only"}')).toBe('only');
  });

  it('trims plain text, strips tags, and gives nothing for no text', () => {
    expect(answerSnippet('  plain   text \n')).toBe('plain text');
    expect(answerSnippet('<html><body><h1>Forbidden</h1></body></html>')).toBe('Forbidden');
    expect(answerSnippet('')).toBe('');
    expect(answerSnippet(null)).toBe('');
  });

  it('blanks a passed secret and token shapes that were never passed', () => {
    expect(answerSnippet('bad ACME-SESSION-SECRET here', ['ACME-SESSION-SECRET'])).toBe('bad ••• here');
    expect(answerSnippet('Bearer abc')).not.toContain('abc');
    expect(answerSnippet('x eyJhbGciOi.eyJzdWIiOiIx.c2lnbmF0dXJl y')).toBe('x ••• y');
    expect(answerSnippet('sid 00D000000000001!AQ4AQFakeSessionValue end')).toBe('sid ••• end');
  });

  it('blanks a session id stuck to a word character or URL-encoded', () => {
    const cases = [
      ['sid x00D000000000001!AQ4AQFakeSessionValue end', 'sid x••• end'],
      ['sid _00D000000000001!AQ4AQFakeSessionValue end', 'sid _••• end'],
      ['sid 00D000000000001%21AQ4AQFakeSessionValue end', 'sid ••• end'],
    ];
    for (const [input, want] of cases) {
      const got = answerSnippet(input);
      expect(got).toBe(want);
      expect(got).not.toContain('AQ4AQFakeSessionValue');
    }
  });

  it('drops control and escape characters and collapses whitespace in a JSON message too', () => {
    const got = answerSnippet('{"errorCode":"BAD","message":"line one\\nline two \\u001b[31mred\\u001b[0m\\u0007"}');
    expect(got).toBe('BAD: line one line two red');
    expect(got).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    expect(answerSnippet('plain \x1b[1mbold\x1b[0m\r\ntext')).toBe('plain bold text');
    expect(answerSnippet('{"message":"tok\\u001b[0m ACME-SESSION-SECRET"}', ['ACME-SESSION-SECRET'])).toBe('tok •••');
  });

  it('cuts to 160 characters with an ellipsis, after redacting', () => {
    const long = answerSnippet('a'.repeat(400));
    expect(long.length).toBeLessThanOrEqual(161);
    expect(long.endsWith('…')).toBe(true);
    const straddle = answerSnippet(`${'a'.repeat(150)}ACME-SESSION-SECRET${'b'.repeat(50)}`, ['ACME-SESSION-SECRET']);
    expect(straddle).not.toContain('ACME-SESS');
    expect(straddle).toContain('•••');
  });

  it('turns double quotes into single quotes', () => {
    expect(answerSnippet('say "hi"')).toBe("say 'hi'");
  });
});
