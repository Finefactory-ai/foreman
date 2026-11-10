// What the Salesforce pack knows about Gearset, shared by the gearset-pr and gearset-promote
// steps and the doctor.
//
//   gearsetToken(env)             the GEARSET_API_TOKEN value, trimmed, or null. It comes from
//                                 the project's environment, never from the config.
//   promotionBranch(branch, env)  the head of the PR Gearset opens in place of the story's:
//                                 gs-pipeline/<branch>_-_<environment branch>. Gearset acts as
//                                 the owner on GitHub, so the PR is found by this, not by author.
//   statusContext(name)           the commit status Gearset's validation posts on it,
//                                 "Gearset <environment name>". It is a commit status, not a
//                                 check run.
//   gearsetPipelines(...)         the pipelines the token's team can see, each { id, name, enabled }
//   gearsetEnvironments(...)      every environment of every pipeline, or of the one pipelineId
//                                 names (salesforce.gearset.pipelineId), from the Reporting API
//                                 v3, each with its EnvironmentId, CiJobId, whether the CI job is
//                                 on (jobEnabled) and its type (ciJobType). No field shows a CI
//                                 job's test level. pipelineIds, the ids a caller has already
//                                 listed, saves listing the pipelines again.
//   environmentFor(envs, orgId)   the one environment that deploys to orgId, never production; a
//                                 missing org ID is refused with its own error
//   matchEnvironments(envs, ...)  the Set up screen's table: each environment beside the alias in
//                                 salesforce.orgs and the Foreman stage on its org, flagged when it
//                                 is production or no org matches, and the stages none deploys to
//   gearsetDeployments(...)       the deployments to one environment between two times. The
//                                 Reporting API answers through an operation: a POST starts it,
//                                 its status is polled no faster than every 5 seconds until it is
//                                 not Running, then its result lists the deployments.
//   deploymentOfPr(list, ...)     whether those deployments show a pull request deployed
//                                 (Successful), failed (only Failed or PartiallySuccessful), or
//                                 not at all
//
// The Reporting API takes `Authorization: token <token>` and `api-version: 3.0` as headers (a
// query parameter is ignored), and needs Gearset's Teams or Enterprise tier. An error names
// only what went wrong: never the token, a header, a URL query or Gearset's own error text. A
// failed call also carries status, the HTTP code, or null when Gearset could not be reached.

import { PIPELINE_ID } from './config.mjs';

export const TOKEN_VAR = 'GEARSET_API_TOKEN';
export const API = 'https://api.gearset.com';

const TIMEOUT_MS = 30_000;
const UNREADABLE = 'Gearset answered something unreadable';
const UNREACHABLE = 'could not reach Gearset';
const STATUS_ERRORS = {
  401: `Gearset refused ${TOKEN_VAR}`,
  403: "the Gearset Reporting API is not enabled for this token's team (Teams or Enterprise tier)",
  429: 'Gearset rate-limited the request; try again later',
};

const POLL_MS = 5_000;
// An operation id goes into a URL path, so only these characters.
const OPERATION_ID = /^[A-Za-z0-9-]{1,100}$/;

// Gearset's DeploymentStatus is Successful, Failed or PartiallySuccessful; an operation's own
// status is Running, Succeeded or Failed.
export const SUCCESSFUL = 'Successful';
const FAILED = ['Failed', 'PartiallySuccessful'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.length > 0;
const textOrNull = (v) => (isText(v) ? v : null);
const id15 = (v) => (typeof v === 'string' ? v.slice(0, 15) : '');
const unreadable = (status) => ({ ok: false, error: UNREADABLE, transient: false, ...(status === undefined ? {} : { status }) });
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function gearsetToken(env) {
  const value = isObject(env) ? env[TOKEN_VAR] : undefined;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export const promotionBranch = (branch, envBranch) => `gs-pipeline/${branch}_-_${envBranch}`;

export const statusContext = (name) => `Gearset ${name}`;

// One Reporting API call. { ok: true, body } with an array body (expect 'array') or an object
// body (expect 'object'), or { ok: false, error, transient, status } where transient is true for
// a rate limit or no answer: worth trying again later, and status is the HTTP code, or null with
// no answer. Any 2xx is ok, so a 202 Accepted is too.
async function request(fetch, token, { method = 'GET', path, expect = 'array' }) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `token ${token}`, 'api-version': '3.0', Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: UNREACHABLE, transient: true, status: null };
  }
  const status = Number.isInteger(res?.status) ? res.status : null;
  if (!res?.ok) {
    return { ok: false, error: STATUS_ERRORS[status] ?? `Gearset answered ${res?.status}`, transient: status === 429, status };
  }
  let body;
  try {
    body = await res.json();
  } catch {
    return unreadable(status);
  }
  const fits = expect === 'object' ? isObject(body) : Array.isArray(body);
  return fits ? { ok: true, body } : unreadable(status);
}

const pipelineIdOf = (p) => (isObject(p) && isText(p.PipelineId) ? p.PipelineId : null);

// The pipelines the token's team can see: { ok: true, pipelines: [{ id, name, enabled }] }, only
// those with a PipelineId, else the call's failure. name is null when Gearset gives none, enabled
// null when it is not true or false. Never throws.
export async function gearsetPipelines({ fetch, token }) {
  try {
    const listed = await request(fetch, token, { path: '/public/reporting/pipelines' });
    if (!listed.ok) return listed;
    const pipelines = listed.body
      .filter((p) => pipelineIdOf(p) !== null)
      .map((p) => ({ id: p.PipelineId, name: textOrNull(p.Name), enabled: typeof p.Enabled === 'boolean' ? p.Enabled : null }));
    return { ok: true, pipelines };
  } catch {
    return { ...unreadable(), status: null };
  }
}

// Every environment of every pipeline the token's team can see, or of pipeline `pipelineId` only
// when it is given, each { pipelineId, name, targetOrgId, stage, environmentId, ciJobId,
// jobEnabled, ciJobType }. stage is Gearset's: Integration, Release or Production. jobEnabled is
// IsJobEnabled when it is true or false, else null; ciJobType is Deployment or Validation as
// Gearset says, or null. `pipelineIds`, an array of the pipeline ids the caller has already
// listed (gearsetPipelines), stands in for the pipelines list, which is then not asked for. A
// pipelineId the pipelines list does not hold is an error that is not transient, and is never
// asked for. Never throws.
export async function gearsetEnvironments({ fetch, token, pipelineId, pipelineIds }) {
  let ids;
  if (Array.isArray(pipelineIds)) {
    ids = pipelineIds.filter(isText);
  } else {
    const pipelines = await request(fetch, token, { path: '/public/reporting/pipelines' });
    if (!pipelines.ok) return pipelines;
    ids = pipelines.body.map(pipelineIdOf).filter((id) => id !== null);
  }
  if (pipelineId !== undefined && pipelineId !== null) {
    if (!(typeof pipelineId === 'string' && PIPELINE_ID.test(pipelineId) && ids.includes(pipelineId))) {
      return { ok: false, error: `Gearset shows no pipeline ${pipelineId} to this token`, transient: false };
    }
    ids = [pipelineId];
  }
  const environments = [];
  for (const id of ids) {
    const listed = await request(fetch, token, { path: `/public/reporting/environments?PipelineId=${encodeURIComponent(id)}` });
    if (!listed.ok) return listed;
    for (const e of listed.body) {
      if (!isObject(e)) continue;
      environments.push({
        pipelineId: id,
        name: isText(e.Name) ? e.Name : null,
        targetOrgId: isText(e.TargetOrgId) ? e.TargetOrgId : null,
        stage: isText(e.Stage) ? e.Stage : null,
        environmentId: textOrNull(e.EnvironmentId),
        ciJobId: textOrNull(e.CiJobId),
        jobEnabled: typeof e.IsJobEnabled === 'boolean' ? e.IsJobEnabled : null,
        ciJobType: textOrNull(e.CiJobType),
      });
    }
  }
  return { ok: true, environments };
}

// The environment that deploys to orgId, matched on the first 15 characters of the org ID. The
// same environment listed in several pipelines counts once; production is never a target.
export function environmentFor(environments, orgId) {
  const want = id15(orgId);
  if (!want) return { ok: false, error: "the stage's org has no org ID; set its orgId in salesforce.orgs" };
  const matches = (Array.isArray(environments) ? environments : []).filter((e) => want && id15(e?.targetOrgId) === want);
  if (matches.length === 0) return { ok: false, error: `no Gearset environment deploys to ${orgId}` };
  if (matches.some((e) => e.stage === 'Production')) {
    return { ok: false, error: `${orgId} is Gearset's production environment; production is never a target` };
  }
  const names = [...new Set(matches.map((e) => e.name))];
  if (names.length > 1) return { ok: false, error: `${orgId} is the target of several Gearset environments (${names.join(', ')})` };
  if (!isText(names[0])) return { ok: false, error: `the Gearset environment that deploys to ${orgId} has no name` };
  return { ok: true, environment: matches[0] };
}

// The Set up screen's table, from gearsetEnvironments' list. `orgs` is layout().orgs (alias ->
// { orgId }) and `stages` layout().stages. Answers { rows, missing }: one row per environment, in
// order, { name, gearsetStage, targetOrgId, environmentId, alias, stage, ciJob, flag }, where
// alias is the org in salesforce.orgs with the same first 15 org-ID characters (as
// environmentFor matches), stage the Foreman stage on that org, ciJob 'none' (no CI job), 'off'
// (turned off) or 'enabled', and flag 'production' for Gearset's production environment,
// 'unmatched' when no org matches, else null. missing names each stage whose org no environment
// that is not production deploys to. Pure.
export function matchEnvironments(environments, { orgs, stages } = {}) {
  const known = isObject(orgs) ? Object.entries(orgs).filter(([, o]) => isObject(o) && isText(o.orgId)) : [];
  const steps = Array.isArray(stages) ? stages.filter(isObject) : [];
  const rows = (Array.isArray(environments) ? environments : []).filter(isObject).map((e) => {
    const want = id15(e.targetOrgId);
    const alias = want ? known.find(([, o]) => id15(o.orgId) === want)?.[0] ?? null : null;
    const stage = alias === null ? null : steps.find((s) => s.org === alias)?.name ?? null;
    const ciJob = !isText(e.ciJobId) ? 'none' : e.jobEnabled === false ? 'off' : 'enabled';
    const flag = e.stage === 'Production' ? 'production' : alias === null ? 'unmatched' : null;
    return { name: textOrNull(e.name), gearsetStage: textOrNull(e.stage), targetOrgId: textOrNull(e.targetOrgId), environmentId: textOrNull(e.environmentId), alias, stage, ciJob, flag };
  });
  const targeted = new Set(rows.filter((r) => r.flag !== 'production').map((r) => id15(r.targetOrgId)).filter(Boolean));
  const missing = steps.filter((s) => !(isText(s.orgId) && targeted.has(id15(s.orgId)))).map((s) => s.name);
  return { rows, missing };
}

const isoOf = (v) => {
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

// One deployment as the operation's result lists it, with only the fields Foreman reads.
function deploymentOf(d) {
  const prs = Array.isArray(d.DeploymentPullRequests) ? d.DeploymentPullRequests : [];
  return {
    status: textOrNull(d.Status),
    date: textOrNull(d.Date),
    environmentId: textOrNull(d.PipelineEnvironmentId),
    salesforceDeploymentId: textOrNull(d.SalesforceFinalDeploymentId),
    pullRequests: prs
      .filter((p) => isObject(p) && isObject(p.PullRequest))
      .map(({ PullRequest: p }) => ({
        number: Number.isInteger(p.Number) ? p.Number : null,
        environmentBranch: textOrNull(p.EnvironmentBranchName),
        mergedAt: textOrNull(p.MergedAt),
      })),
  };
}

// The deployments of pipeline `pipelineId` to environment `environmentId` between `from` and
// `to` (Dates or ISO strings): { ok: true, deployments: [{ status, date, environmentId,
// salesforceDeploymentId, pullRequests: [{ number, environmentBranch, mergedAt }] }] }, or
// { ok: false, error, transient }. It waits `sleep(5000)` before each status poll, and gives up
// as transient after `waitMs` of polling. Never throws.
export async function gearsetDeployments({ fetch, token, pipelineId, environmentId, from, to, sleep = realSleep, waitMs = 60_000 }) {
  try {
    const start = isoOf(from);
    const end = isoOf(to);
    if (!start || !end || !isText(pipelineId)) return { ok: false, error: 'the deployments to ask Gearset for are not known', transient: false };
    const query = [['StartDate', start], ['EndDate', end], ['PipelineId', pipelineId], ...(isText(environmentId) ? [['EnvironmentIds', environmentId]] : [])]
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join('&');
    const started = await request(fetch, token, { method: 'POST', path: `/public/reporting/deployments?${query}`, expect: 'object' });
    if (!started.ok) return started;
    const id = started.body.OperationStatusId;
    if (!(typeof id === 'string' && OPERATION_ID.test(id))) return unreadable();

    let status;
    for (let waited = 0; ; ) {
      await sleep(POLL_MS);
      waited += POLL_MS;
      const polled = await request(fetch, token, { path: `/public/operation/${id}/status`, expect: 'object' });
      if (!polled.ok) return polled;
      status = polled.body;
      if (status.Status !== 'Running') break;
      if (waited >= waitMs) return { ok: false, error: 'Gearset is still gathering the deployments', transient: true };
    }
    if (status.Status === 'Failed') return { ok: false, error: 'Gearset could not list the deployments', transient: true };
    if (status.Status !== 'Succeeded') return unreadable();

    // Gearset names the id to read the result with; the operation's own id when it does not.
    const resultId = typeof status.OperationResultId === 'string' && OPERATION_ID.test(status.OperationResultId) ? status.OperationResultId : id;
    const result = await request(fetch, token, { path: `/public/operation/${resultId}/result`, expect: 'object' });
    if (!result.ok) return result;
    if (!Array.isArray(result.body.Deployments)) return unreadable();
    return { ok: true, deployments: result.body.Deployments.filter(isObject).map(deploymentOf) };
  } catch {
    return unreadable();
  }
}

// What `deployments` (gearsetDeployments' list) say about pull request `prNumber` into `branch`
// (when given) in environment `environmentId`: { state: 'deployed', deployment } when a
// matching deployment is Successful (the newest such), { state: 'failed', deployment } when
// the matches are only Failed or PartiallySuccessful, else { state: 'none' }. Pure.
export function deploymentOfPr(deployments, { environmentId, prNumber, branch } = {}) {
  if (!isText(environmentId)) return { state: 'none' };
  const matches = (Array.isArray(deployments) ? deployments : [])
    .filter((d) => isObject(d) && d.environmentId === environmentId)
    .filter((d) => (Array.isArray(d.pullRequests) ? d.pullRequests : []).some((p) => isObject(p) && p.number === prNumber && (!branch || p.environmentBranch === branch)))
    .sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
  const deployed = matches.find((d) => d.status === SUCCESSFUL);
  if (deployed) return { state: 'deployed', deployment: deployed };
  const failed = matches.find((d) => FAILED.includes(d.status));
  return failed ? { state: 'failed', deployment: failed } : { state: 'none' };
}
