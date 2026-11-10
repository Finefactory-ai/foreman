// A fake fetch for the Gearset Reporting API, and the Acme pipeline it answers with by default.
//
//   fakeGearset(routes)   a fetch(url, init). routes maps a path with its query, such as
//                         '/public/reporting/pipelines' or
//                         '/public/reporting/environments?PipelineId=pipe-1', to
//                         { status, body }, a function (url, init) returning one, or an Error,
//                         which the fetch throws. A path with no route of its own, query
//                         included, falls back to the route for the bare path; with neither it
//                         answers 404. fetch.calls records { url, path, method, headers } for
//                         each call. As the real service does, a call whose headers lack
//                         api-version 3.0 (the header name in any case) gets 400
//                         UnsupportedApiVersion before any route is looked at.
//   acmeGearset(over)     the routes for one Acme pipeline, pipe-1 'Acme', with environments QA
//                         (TargetOrgId ACME_QA_ID) and UAT (ACME_UAT_ID). Routes in `over` win.
//   acmeTwoPipelines(over)
//                         acmeGearset's pipe-1, plus pipe-2 'Acme Legacy', whose environments
//                         are Legacy QA (also ACME_QA_ID), Scratch (ACME_STRAY_ID, an org in no
//                         salesforce.orgs) and Live (ACME_LIVE_ID, Gearset's Production stage)
//   acmeEnvironment(...)  one environment as the Reporting API v3 lists it
//   acmeDeployment(over)  one deployment as the deployments operation's result lists it: QA
//                         (env-qa), Successful, with promotion pull request #2 into qa
//   acmeDeployments(list, { id, status })
//                         the routes for one deployments operation, op-1: the POST (by its bare
//                         path) answers 202 and the operation id, its status answers `status`
//                         (Succeeded by default), and its result lists `list`
//   deploymentsOf(...)    the deployments POST path with its query, as gearset.mjs builds it
//   operationStatusOf(id), operationResultOf(id)
//                         the operation's status and result paths

import { ACME_QA_ID, ACME_UAT_ID } from './fake-sf.mjs';

export const PIPELINES = '/public/reporting/pipelines';
export const environmentsOf = (pipelineId) => `/public/reporting/environments?PipelineId=${encodeURIComponent(pipelineId)}`;
export const DEPLOYMENTS = '/public/reporting/deployments';
const isoOf = (v) => new Date(v).toISOString();
export const deploymentsOf = ({ from, to, pipelineId, environmentId }) =>
  `${DEPLOYMENTS}?StartDate=${encodeURIComponent(isoOf(from))}&EndDate=${encodeURIComponent(isoOf(to))}&PipelineId=${encodeURIComponent(pipelineId)}&EnvironmentIds=${encodeURIComponent(environmentId)}`;
export const operationStatusOf = (id) => `/public/operation/${id}/status`;
export const operationResultOf = (id) => `/public/operation/${id}/result`;

export const acmeEnvironment = (name, targetOrgId, stage = 'Integration') => ({
  EnvironmentId: `env-${name.toLowerCase()}`,
  Name: name,
  CiJobId: `job-${name.toLowerCase()}`,
  IsJobEnabled: true,
  TargetOrgId: targetOrgId,
  Stage: stage,
});

export const acmeGearset = (over = {}) => ({
  [PIPELINES]: { status: 200, body: [{ PipelineId: 'pipe-1', Name: 'Acme' }] },
  [environmentsOf('pipe-1')]: { status: 200, body: [acmeEnvironment('QA', ACME_QA_ID), acmeEnvironment('UAT', ACME_UAT_ID, 'Release')] },
  ...over,
});

export const ACME_STRAY_ID = '00D000000000098AAA';
export const ACME_LIVE_ID = '00D000000000099AAA';

export const acmeTwoPipelines = (over = {}) => acmeGearset({
  [PIPELINES]: { status: 200, body: [{ PipelineId: 'pipe-1', Name: 'Acme', Enabled: true }, { PipelineId: 'pipe-2', Name: 'Acme Legacy', Enabled: false }] },
  [environmentsOf('pipe-2')]: {
    status: 200,
    body: [
      { ...acmeEnvironment('Legacy QA', ACME_QA_ID), EnvironmentId: 'env-legacy-qa', CiJobId: 'job-legacy-qa' },
      acmeEnvironment('Scratch', ACME_STRAY_ID),
      { ...acmeEnvironment('Live', ACME_LIVE_ID, 'Production'), CiJobId: null },
    ],
  },
  ...over,
});

export const acmeDeployment = (over = {}) => ({
  DeploymentId: 'dep-1',
  Status: 'Successful',
  Date: '2026-10-15T12:03:00Z',
  PipelineId: 'pipe-1',
  PipelineEnvironmentId: 'env-qa',
  SalesforceFinalDeploymentId: '0Af000000000009AAA',
  MetadataItemsInDeploymentCount: 2,
  DeploymentPullRequests: [{ PullRequest: { Number: 2, EnvironmentBranchName: 'qa', MergedAt: '2026-10-15T12:00:00Z' }, FeaturePullRequests: [] }],
  ...over,
});

export const acmeDeployments = (list = [acmeDeployment()], { id = 'op-1', status = { Status: 'Succeeded', OperationResultId: id } } = {}) => ({
  [DEPLOYMENTS]: { status: 202, body: { Status: 'Running', OperationStatusId: id } },
  [operationStatusOf(id)]: { status: 200, body: status },
  [operationResultOf(id)]: { status: 200, body: { Deployments: list } },
});

export function fakeGearset(routes = acmeGearset()) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const path = `${u.pathname}${u.search}`;
    const headers = { ...(init.headers ?? {}) };
    calls.push({ url: String(url), path, method: init.method ?? 'GET', headers });
    const version = Object.entries(headers).find(([name]) => name.toLowerCase() === 'api-version')?.[1];
    if (String(version ?? '').trim() !== '3.0') {
      const body = { Code: 'UnsupportedApiVersion', Message: "The HTTP resource that matches the request URI does not support the API version '1.0'." };
      return { ok: false, status: 400, json: async () => body, text: async () => JSON.stringify(body) };
    }
    const key = Object.hasOwn(routes, path) ? path : Object.hasOwn(routes, u.pathname) ? u.pathname : null;
    let route = key === null ? { status: 404, body: { Message: 'not found' } } : routes[key];
    if (typeof route === 'function') route = route(String(url), init);
    if (route instanceof Error) throw route;
    const { status = 200, body = null } = route;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  };
  fetch.calls = calls;
  return fetch;
}
