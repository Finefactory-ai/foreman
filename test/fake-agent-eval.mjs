// Fakes for Foreman's agent eval caller (plugin/packs/salesforce/agent-eval.mjs): the Acme eval
// spec, the sf answers the caller reads, and a fetch that answers the three Salesforce calls.
//
//   ACME_SPEC                       the builder's example spec for Acme_Order_Helper, two cases
//   specWith(n, api)                a spec of n cases, case-1 to case-<n>, one routing check each
//   specText(spec)                  the spec as git show prints it
//   orgDisplay(over)                `sf org display` for acme-qa, with the session token in it
//   planners(ids)                   the GenAiPlannerDefinition query's answer
//   evalRules({ spec, planner })    fakeSh rules for git show of every tests/<Api>-eval.json,
//                                   the org display and the planner query
//   fakeFetch({ userinfo, nameduser, evals })
//                                   a fetch that records { url, method, headers, body, redirect }
//                                   for each call. Each answer is a Response, a JSON value (200), or a
//                                   function of the call giving one. evals defaults to passAll.
//   passAll(body)                   the eval API's answer with every check passing
//   failing(body, { <case>: [check ids] })
//                                   the same with those checks failing

import { ACME_QA_ID, sfOk } from './fake-sf.mjs';

export const ACME_SESSION = 'ACME-SESSION-SECRET';
export const ACME_JWT = 'aaa.bbb.ccc';
export const ACME_USER_ID = '005000000000001AAA';
export const ACME_PLANNER_ID = '16j000000000002AAA';
export const ACME_INSTANCE = 'https://acme-qa.sandbox.my.salesforce.com';
export const EVAL_URL = 'https://api.salesforce.com/einstein/evaluation/v1/tests';

export const ACME_SPEC = Object.freeze({
  agent: 'Acme_Order_Helper',
  tests: [
    {
      id: 'order-status',
      utterance: 'Where is order ACME-1001?',
      routing: [
        { field: 'lastExecution.llmEvents', operator: 'contains', expected: "'agent_name': 'Order Status'" },
        { field: 'lastExecution.invokedActions', operator: 'contains', expected: "'name': 'get_order_status'" },
        { field: 'invokedActions[0][0].function.input.orderNumber', operator: 'equals', expected: 'ACME-1001' },
      ],
      outcome: { expectation: "The reply gives the order's status.", threshold: 3 },
    },
    {
      id: 'greeting',
      utterance: 'Hello there',
      routing: [{ field: 'lastExecution.llmEvents', operator: 'contains', expected: "'agent_name': 'General'" }],
      outcome: { expectation: 'The reply greets the user and offers help with orders.', threshold: 3 },
    },
  ],
});

export const specWith = (n, api = 'Acme_Order_Helper') => ({
  agent: api,
  tests: Array.from({ length: n }, (_, i) => ({
    id: `case-${i + 1}`,
    utterance: `Where is order ACME-${1001 + i}?`,
    routing: [{ field: 'lastExecution.invokedActions', operator: 'contains', expected: "'name': 'get_order_status'" }],
  })),
});

export const specText = (spec) => `${JSON.stringify(spec, null, 2)}\n`;

export const orgDisplay = (over = {}) =>
  sfOk({ id: ACME_QA_ID, alias: 'acme-qa', username: 'admin@acme-qa.acme.example', instanceUrl: ACME_INSTANCE, accessToken: ACME_SESSION, connectedStatus: 'Connected', ...over });

export const planners = (ids = [ACME_PLANNER_ID]) =>
  sfOk({ records: ids.map((Id) => ({ attributes: { type: 'GenAiPlannerDefinition' }, Id })), totalSize: ids.length, done: true });

// The spec for an agent: `spec` itself (a function of the API name, or an object for every agent)
// with its agent set to the one asked for.
const specFor = (spec, api) => {
  const s = typeof spec === 'function' ? spec(api) : spec;
  return s && typeof s === 'object' && !Array.isArray(s) ? { ...s, agent: api } : s;
};

export function evalRules({ spec = ACME_SPEC, display = orgDisplay(), planner = planners() } = {}) {
  return [
    [/^git show [^ ]+:tests\/[A-Za-z0-9_]+-eval\.json$/, (line) => {
      const api = /tests\/([A-Za-z0-9_]+)-eval\.json$/.exec(line)[1];
      const s = specFor(spec, api);
      return s === null ? { status: 128, stdout: '', stderr: `fatal: path 'tests/${api}-eval.json' does not exist` } : typeof s === 'string' ? s : specText(s);
    }],
    [/^sf org display /, display],
    [/^sf data query --query SELECT Id FROM GenAiPlannerDefinition /, planner],
  ];
}

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const answer = (a, call) => {
  const v = typeof a === 'function' ? a(call) : a;
  return v instanceof Response ? v : json(v);
};

const evaluators = (test) => test.steps.filter((s) => String(s.type).startsWith('evaluator.'));

export const passAll = (body) => ({
  results: body.tests.map((t) => ({ id: t.id, evaluation_results: evaluators(t).map((s) => ({ id: s.id, is_pass: true, actual_value: 'fine' })) })),
});

export const failing = (body, fails = {}) => ({
  results: body.tests.map((t) => ({
    id: t.id,
    evaluation_results: evaluators(t).map((s) => ((fails[t.id] ?? []).includes(s.id) ? { id: s.id, is_pass: false, actual_value: 'ACTUAL-FROM-API' } : { id: s.id, is_pass: true })),
  })),
});

export function fakeFetch({ userinfo = { user_id: ACME_USER_ID }, nameduser = { access_token: ACME_JWT }, evals = (call) => passAll(call.body) } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method ?? 'GET', headers: { ...(init.headers ?? {}) }, body: init.body === undefined ? undefined : JSON.parse(init.body), redirect: init.redirect, signal: init.signal };
    calls.push(call);
    if (call.url.endsWith('/services/oauth2/userinfo')) return answer(userinfo, call);
    if (call.url.endsWith('/agentforce/bootstrap/nameduser')) return answer(nameduser, call);
    if (call.url === EVAL_URL && call.method === 'POST') return answer(evals, call);
    return new Response('not found', { status: 404 });
  };
  fetch.calls = calls;
  fetch.posts = () => calls.filter((c) => c.method === 'POST');
  return fetch;
}
