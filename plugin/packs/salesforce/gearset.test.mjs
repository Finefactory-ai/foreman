import { describe, expect, it } from 'vitest';
import { API, MAX_NUDGES, MAX_RATE_LIMIT_WAIT_MS, MIN_RATE_LIMIT_WAIT_MS, NUDGE_MINUTES, RATE_LIMIT_WAIT_MS, SUCCESSFUL, TOKEN_VAR, deploymentOfPr, environmentFor, gearsetDeployments, gearsetEnvironments, gearsetPipelines, gearsetToken, matchEnvironments, noStatusReason, promotionBranch, releaseEnvironments, statusContext, waitOutRateLimit } from './gearset.mjs';
import { layout } from './config.mjs';
import { ACME_QA_ID, ACME_UAT_ID } from '../../../test/fake-sf.mjs';
import {
  ACME_LIVE_ID,
  ACME_STRAY_ID,
  DEPLOYMENTS,
  PIPELINES,
  acmeDeployment,
  acmeDeployments,
  acmeEnvironment,
  acmeGearset,
  acmeTwoPipelines,
  deploymentsOf,
  environmentsOf,
  fakeGearset,
  operationResultOf,
  operationStatusOf,
} from '../../../test/fake-gearset.mjs';

const TOKEN = 't-acme';

describe('gearset helpers', () => {
  it('names the token variable and the API base', () => {
    expect(TOKEN_VAR).toBe('GEARSET_API_TOKEN');
    expect(API).toBe('https://api.gearset.com');
  });

  it('reads the token trimmed, or null', () => {
    expect(gearsetToken({ GEARSET_API_TOKEN: '  t-acme \n' })).toBe('t-acme');
    expect(gearsetToken({ GEARSET_API_TOKEN: '   ' })).toBeNull();
    expect(gearsetToken({})).toBeNull();
    expect(gearsetToken(undefined)).toBeNull();
  });

  it('names the promotion branch and the status context', () => {
    expect(promotionBranch('story/fm-1', 'qa')).toBe('gs-pipeline/story/fm-1_-_qa');
    expect(statusContext('QA')).toBe('Gearset QA');
  });

  it('names both causes of a validation that posted no status', () => {
    const one = noStatusReason('Gearset QA', 7, 1);
    expect(one).toContain('Gearset QA posted no status on pull request #7 within 1 minute.');
    expect(one).not.toContain('1 minutes');
    expect(one).toContain('Gearset pipeline');
    expect(one).toContain('webhook');
    expect(one).toContain('foreman doctor');
    expect(noStatusReason('Gearset QA', 7, 30)).toContain('within 30 minutes');
  });
});

describe('gearsetEnvironments', () => {
  it('reads the environments across two pipelines, with the token and api-version headers', async () => {
    const odd = 'pipe 2/x';
    const fetch = fakeGearset(acmeGearset({
      [PIPELINES]: { status: 200, body: [{ PipelineId: 'pipe-1' }, { PipelineId: odd }] },
      [environmentsOf(odd)]: { status: 200, body: [acmeEnvironment('Hotfix', '00D000000000005AAA', 'Release')] },
    }));
    const r = await gearsetEnvironments({ fetch, token: TOKEN });
    expect(r).toEqual({
      ok: true,
      environments: [
        { pipelineId: 'pipe-1', name: 'QA', targetOrgId: ACME_QA_ID, stage: 'Integration', environmentId: 'env-qa', ciJobId: 'job-qa', jobEnabled: true, ciJobType: null },
        { pipelineId: 'pipe-1', name: 'UAT', targetOrgId: ACME_UAT_ID, stage: 'Release', environmentId: 'env-uat', ciJobId: 'job-uat', jobEnabled: true, ciJobType: null },
        { pipelineId: odd, name: 'Hotfix', targetOrgId: '00D000000000005AAA', stage: 'Release', environmentId: 'env-hotfix', ciJobId: 'job-hotfix', jobEnabled: true, ciJobType: null },
      ],
    });
    expect(fetch.calls.map((c) => c.path)).toEqual([PIPELINES, environmentsOf('pipe-1'), environmentsOf(odd)]);
    expect(fetch.calls[2].url).toBe(`${API}/public/reporting/environments?PipelineId=pipe%202%2Fx`);
    for (const call of fetch.calls) {
      expect(call.url.startsWith(API)).toBe(true);
      expect(call.headers).toMatchObject({ Authorization: 'token t-acme', 'api-version': '3.0', Accept: 'application/json' });
    }
  });

  it('keeps a null TargetOrgId, and a missing EnvironmentId or CiJobId, as null', async () => {
    const fetch = fakeGearset(acmeGearset({ [environmentsOf('pipe-1')]: { status: 200, body: [{ Name: 'QA', TargetOrgId: null, Stage: 'Integration' }] } }));
    expect(await gearsetEnvironments({ fetch, token: TOKEN })).toEqual({ ok: true, environments: [{ pipelineId: 'pipe-1', name: 'QA', targetOrgId: null, stage: 'Integration', environmentId: null, ciJobId: null, jobEnabled: null, ciJobType: null }] });
  });

  it.each([
    [{ status: 401, body: { Message: 'no' } }, 'Gearset refused GEARSET_API_TOKEN'],
    [{ status: 403, body: {} }, "the Gearset Reporting API is not enabled for this token's team (Teams or Enterprise tier)"],
    [{ status: 429, body: {} }, 'Gearset rate-limited the request; try again later'],
    [{ status: 500, body: {} }, 'Gearset answered 500'],
    [new Error(`connect ECONNREFUSED ${TOKEN}`), 'could not reach Gearset'],
    [{ status: 200, body: { PipelineId: 'pipe-1' } }, 'Gearset answered something unreadable'],
    [{ status: 200, body: 'not json' }, 'Gearset answered something unreadable'],
  ])('maps a failed pipelines call to its error (%#)', async (answer, error) => {
    const fetch = fakeGearset(acmeGearset({ [PIPELINES]: answer }));
    const r = await gearsetEnvironments({ fetch, token: TOKEN });
    expect(r).toMatchObject({ ok: false, error });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(JSON.stringify(r)).not.toContain('PipelineId=');
  });

  it('maps a failed environments call too', async () => {
    const fetch = fakeGearset(acmeGearset({ [environmentsOf('pipe-1')]: { status: 403, body: {} } }));
    const r = await gearsetEnvironments({ fetch, token: TOKEN });
    expect(r).toMatchObject({ ok: false, error: "the Gearset Reporting API is not enabled for this token's team (Teams or Enterprise tier)" });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it('marks a rate limit and an unreachable Gearset as worth trying again, and nothing else', async () => {
    const transient = async (answer) => (await gearsetEnvironments({ fetch: fakeGearset(acmeGearset({ [PIPELINES]: answer })), token: TOKEN })).transient === true;
    expect(await transient({ status: 429, body: {} })).toBe(true);
    expect(await transient(new Error('down'))).toBe(true);
    expect(await transient({ status: 401, body: {} })).toBe(false);
    expect(await transient({ status: 403, body: {} })).toBe(false);
  });
});

describe('the fake, strict about api-version as the real service is', () => {
  it('answers 400 UnsupportedApiVersion to a call without the header, and 200 with it in any case', async () => {
    const fetch = fakeGearset(acmeGearset());
    const bare = await fetch(`${API}${PIPELINES}`, { headers: { Authorization: `token ${TOKEN}` } });
    expect(bare.status).toBe(400);
    expect((await bare.json()).Code).toBe('UnsupportedApiVersion');
    const old = await fetch(`${API}${PIPELINES}`, { headers: { 'api-version': '1.0' } });
    expect(old.status).toBe(400);
    const good = await fetch(`${API}${PIPELINES}`, { headers: { Authorization: `token ${TOKEN}`, 'API-Version': '3.0' } });
    expect(good.status).toBe(200);
  });

  it('is passed by gearsetPipelines and gearsetEnvironments, which send the header', async () => {
    const fetch = fakeGearset(acmeTwoPipelines());
    expect((await gearsetPipelines({ fetch, token: TOKEN })).ok).toBe(true);
    expect((await gearsetEnvironments({ fetch, token: TOKEN })).ok).toBe(true);
    expect((await gearsetEnvironments({ fetch, token: TOKEN, pipelineId: 'pipe-2' })).ok).toBe(true);
    expect(fetch.calls.length).toBeGreaterThan(3);
    for (const call of fetch.calls) expect(call.headers['api-version']).toBe('3.0');
  });
});

describe('gearsetPipelines', () => {
  it('maps PipelineId, Name and Enabled, and skips an entry with no id', async () => {
    const fetch = fakeGearset(acmeGearset({
      [PIPELINES]: { status: 200, body: [{ PipelineId: 'pipe-1', Name: 'Acme', Enabled: true }, { Name: 'no id' }, 'odd', { PipelineId: '', Name: 'empty' }, { PipelineId: 'pipe-2', Enabled: 'yes' }] },
    }));
    expect(await gearsetPipelines({ fetch, token: TOKEN })).toEqual({
      ok: true,
      pipelines: [{ id: 'pipe-1', name: 'Acme', enabled: true }, { id: 'pipe-2', name: null, enabled: null }],
    });
    expect(fetch.calls.map((c) => c.path)).toEqual([PIPELINES]);
  });

  it.each([
    [401, 'Gearset refused GEARSET_API_TOKEN', false],
    [403, "the Gearset Reporting API is not enabled for this token's team (Teams or Enterprise tier)", false],
    [429, 'Gearset rate-limited the request; try again later', true],
    [500, 'Gearset answered 500', false],
  ])('answers %i with its status and the same words', async (status, error, transient) => {
    const fetch = fakeGearset(acmeGearset({ [PIPELINES]: { status, body: { Message: `no for ${TOKEN}` } } }));
    const r = await gearsetPipelines({ fetch, token: TOKEN });
    expect(r).toEqual({ ok: false, error, transient, status });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it('answers a thrown fetch with status null, as transient, and never throws', async () => {
    const r = await gearsetPipelines({ fetch: fakeGearset(acmeGearset({ [PIPELINES]: new Error(`ECONNRESET ${TOKEN}`) })), token: TOKEN });
    expect(r).toEqual({ ok: false, error: 'could not reach Gearset', transient: true, status: null });
    const throws = await gearsetPipelines({ fetch: () => { throw new Error('sync'); }, token: TOKEN });
    expect(throws).toMatchObject({ ok: false, status: null });
  });
});

describe('gearsetEnvironments with a pipelineId', () => {
  it('lists only that pipeline, with jobEnabled and ciJobType', async () => {
    const fetch = fakeGearset(acmeTwoPipelines({
      [environmentsOf('pipe-2')]: { status: 200, body: [{ ...acmeEnvironment('Legacy QA', ACME_QA_ID), IsJobEnabled: false, CiJobType: 'Validation' }, { ...acmeEnvironment('Odd', ACME_STRAY_ID), IsJobEnabled: 'no', CiJobType: 7 }] },
    }));
    const r = await gearsetEnvironments({ fetch, token: TOKEN, pipelineId: 'pipe-2' });
    expect(r).toEqual({
      ok: true,
      environments: [
        { pipelineId: 'pipe-2', name: 'Legacy QA', targetOrgId: ACME_QA_ID, stage: 'Integration', environmentId: 'env-legacy qa', ciJobId: 'job-legacy qa', jobEnabled: false, ciJobType: 'Validation' },
        { pipelineId: 'pipe-2', name: 'Odd', targetOrgId: ACME_STRAY_ID, stage: 'Integration', environmentId: 'env-odd', ciJobId: 'job-odd', jobEnabled: null, ciJobType: null },
      ],
    });
    expect(fetch.calls.map((c) => c.path)).toEqual([PIPELINES, environmentsOf('pipe-2')]);
  });

  it('answers a pipeline the token cannot see as not transient, and reads no environments', async () => {
    const fetch = fakeGearset(acmeTwoPipelines());
    const r = await gearsetEnvironments({ fetch, token: TOKEN, pipelineId: 'pipe-9' });
    expect(r).toEqual({ ok: false, error: 'Gearset shows no pipeline pipe-9 to this token', transient: false });
    expect(fetch.calls.map((c) => c.path)).toEqual([PIPELINES]);
  });

  it('lists every pipeline without one, as before', async () => {
    const fetch = fakeGearset(acmeTwoPipelines());
    const r = await gearsetEnvironments({ fetch, token: TOKEN });
    expect(r.environments.map((e) => e.pipelineId)).toEqual(['pipe-1', 'pipe-1', 'pipe-2', 'pipe-2', 'pipe-2']);
    expect(fetch.calls.map((c) => c.path)).toEqual([PIPELINES, environmentsOf('pipe-1'), environmentsOf('pipe-2')]);
  });
});

describe('gearsetEnvironments with pipelineIds', () => {
  it('reads only the chosen pipeline, with no pipelines call', async () => {
    const fetch = fakeGearset(acmeTwoPipelines());
    const r = await gearsetEnvironments({ fetch, token: TOKEN, pipelineId: 'pipe-2', pipelineIds: ['pipe-1', 'pipe-2'] });
    expect(r.ok).toBe(true);
    expect(r.environments.length).toBeGreaterThan(0);
    expect(r.environments.every((e) => e.pipelineId === 'pipe-2')).toBe(true);
    expect(fetch.calls.map((c) => c.path)).toEqual([environmentsOf('pipe-2')]);
  });

  it('refuses a pipelineId the list does not hold, and asks nothing', async () => {
    const fetch = fakeGearset(acmeTwoPipelines());
    const r = await gearsetEnvironments({ fetch, token: TOKEN, pipelineId: 'pipe-9', pipelineIds: ['pipe-1', 'pipe-2'] });
    expect(r).toEqual({ ok: false, error: 'Gearset shows no pipeline pipe-9 to this token', transient: false });
    expect(fetch.calls).toEqual([]);
  });

  it('reads every listed pipeline without a pipelineId, with no pipelines call', async () => {
    const fetch = fakeGearset(acmeTwoPipelines());
    const r = await gearsetEnvironments({ fetch, token: TOKEN, pipelineIds: ['pipe-1'] });
    expect(r.ok).toBe(true);
    expect(r.environments.map((e) => e.pipelineId)).toEqual(['pipe-1', 'pipe-1']);
    expect(fetch.calls.map((c) => c.path)).toEqual([environmentsOf('pipe-1')]);
  });

  it('refuses a bad pipelineId the same way, and asks nothing', async () => {
    const fetch = fakeGearset(acmeTwoPipelines());
    const r = await gearsetEnvironments({ fetch, token: TOKEN, pipelineId: '../x', pipelineIds: ['pipe-1', 'pipe-2', '../x'] });
    expect(r).toEqual({ ok: false, error: 'Gearset shows no pipeline ../x to this token', transient: false });
    expect(fetch.calls).toEqual([]);
  });
});

describe('matchEnvironments', () => {
  const block = (qaOrgId = ACME_QA_ID) => ({
    orgs: { 'acme-dev1': { orgId: '00D000000000001AAA' }, 'acme-qa': { orgId: qaOrgId }, 'acme-uat': { orgId: ACME_UAT_ID } },
    build: ['acme-dev1'],
    stages: [{ name: 'qa', org: 'acme-qa', branch: 'qa' }, { name: 'uat', org: 'acme-uat', branch: 'uat' }],
  });
  const env = (name, targetOrgId, over = {}) => ({ pipelineId: 'pipe-1', name, targetOrgId, stage: 'Integration', environmentId: `env-${name}`, ciJobId: `job-${name}`, jobEnabled: true, ciJobType: 'Deployment', ...over });
  const match = (envs, b = block()) => {
    const l = layout(b);
    return matchEnvironments(envs, { orgs: l.orgs, stages: l.stages });
  };

  it("matches on the first 15 characters of the org ID, either way round, naming the alias and Foreman's stage", () => {
    const r = match([env('QA', ACME_QA_ID.slice(0, 15)), env('UAT', ACME_UAT_ID, { stage: 'Release' })], block(ACME_QA_ID));
    expect(r.rows).toEqual([
      { name: 'QA', gearsetStage: 'Integration', targetOrgId: ACME_QA_ID.slice(0, 15), environmentId: 'env-QA', alias: 'acme-qa', stage: 'qa', ciJob: 'enabled', flag: null },
      { name: 'UAT', gearsetStage: 'Release', targetOrgId: ACME_UAT_ID, environmentId: 'env-UAT', alias: 'acme-uat', stage: 'uat', ciJob: 'enabled', flag: null },
    ]);
    expect(r.missing).toEqual([]);
    const reverse = match([env('QA', ACME_QA_ID)], block(ACME_QA_ID.slice(0, 15)));
    expect(reverse.rows[0]).toMatchObject({ alias: 'acme-qa', stage: 'qa' });
  });

  it('flags an environment whose org is in no salesforce.orgs, and a build org has no stage', () => {
    const r = match([env('Scratch', ACME_STRAY_ID), env('Dev', '00D000000000001AAA'), env('None', null)]);
    expect(r.rows.map((x) => [x.name, x.alias, x.stage, x.flag])).toEqual([
      ['Scratch', null, null, 'unmatched'],
      ['Dev', 'acme-dev1', null, null],
      ['None', null, null, 'unmatched'],
    ]);
  });

  it("flags Gearset's production environment, which never counts as a match", () => {
    const r = match([env('QA', ACME_QA_ID), env('Live', ACME_UAT_ID, { stage: 'Production' }), env('Other', ACME_LIVE_ID, { stage: 'Production' })]);
    expect(r.rows[1]).toMatchObject({ name: 'Live', gearsetStage: 'Production', alias: 'acme-uat', stage: 'uat', flag: 'production' });
    expect(r.rows[2].flag).toBe('production');
    expect(r.missing).toEqual(['uat']);
  });

  it('lists a stage with no environment in missing', () => {
    expect(match([env('QA', ACME_QA_ID)]).missing).toEqual(['uat']);
    expect(match([]).missing).toEqual(['qa', 'uat']);
    expect(match(null)).toEqual({ rows: [], missing: ['qa', 'uat'] });
  });

  it("gives each CI job's state: none, off or enabled", () => {
    const r = match([env('A', ACME_QA_ID, { ciJobId: null }), env('B', ACME_QA_ID, { jobEnabled: false }), env('C', ACME_QA_ID, { jobEnabled: null }), env('D', ACME_QA_ID, { ciJobId: null, jobEnabled: false })]);
    expect(r.rows.map((x) => x.ciJob)).toEqual(['none', 'off', 'enabled', 'none']);
  });
});

describe('environmentFor', () => {
  const qa = { pipelineId: 'pipe-1', name: 'QA', targetOrgId: ACME_QA_ID, stage: 'Integration' };
  const uat = { pipelineId: 'pipe-1', name: 'UAT', targetOrgId: ACME_UAT_ID, stage: 'Release' };

  it('matches a 15-character org ID to an 18-character TargetOrgId', () => {
    expect(environmentFor([uat, qa], ACME_QA_ID.slice(0, 15))).toEqual({ ok: true, environment: qa });
    expect(environmentFor([uat, qa], ACME_QA_ID)).toEqual({ ok: true, environment: qa });
  });

  it('errors when nothing matches', () => {
    expect(environmentFor([uat, { ...qa, targetOrgId: null }], ACME_QA_ID)).toEqual({ ok: false, error: `no Gearset environment deploys to ${ACME_QA_ID}` });
  });

  it('takes the same environment listed in two pipelines, and errors when the names differ', () => {
    expect(environmentFor([qa, { ...qa, pipelineId: 'pipe-2' }], ACME_QA_ID)).toEqual({ ok: true, environment: qa });
    expect(environmentFor([qa, { ...qa, name: 'QA2' }], ACME_QA_ID)).toEqual({ ok: false, error: `${ACME_QA_ID} is the target of several Gearset environments (QA, QA2)` });
  });

  it('refuses the production environment', () => {
    expect(environmentFor([{ ...qa, stage: 'Production' }], ACME_QA_ID)).toEqual({ ok: false, error: `${ACME_QA_ID} is Gearset's production environment; production is never a target` });
  });

  it('names a missing org ID instead of printing null', () => {
    for (const value of [undefined, null, '']) {
      expect(environmentFor([uat, { ...qa, targetOrgId: null }], value)).toEqual({ ok: false, error: "the stage's org has no org ID; set its orgId in salesforce.orgs" });
    }
  });
});

describe('gearsetDeployments', () => {
  const FROM = new Date('2026-10-15T11:55:00Z');
  const TO = new Date('2026-10-15T12:10:00Z');
  const QUERY = { pipelineId: 'pipe-1', environmentId: 'env-qa', from: FROM, to: TO };
  const sleeper = () => {
    const sleeps = [];
    const sleep = async (ms) => { sleeps.push(ms); };
    return { sleeps, sleep };
  };
  // A status route that answers Running `running` times, then `last`.
  const runningThen = (running, last) => {
    let n = 0;
    return () => ({ status: 200, body: n++ < running ? { Status: 'Running' } : last });
  };

  it('starts the operation with a POST, polls its status every 5 seconds, then maps the result', async () => {
    const fetch = fakeGearset({ ...acmeDeployments([acmeDeployment()]), [operationStatusOf('op-1')]: runningThen(2, { Status: 'Succeeded', OperationResultId: 'op-1' }) });
    const { sleeps, sleep } = sleeper();
    const r = await gearsetDeployments({ fetch, token: TOKEN, ...QUERY, sleep });
    expect(r).toEqual({
      ok: true,
      deployments: [{ status: SUCCESSFUL, date: '2026-10-15T12:03:00Z', environmentId: 'env-qa', salesforceDeploymentId: '0Af000000000009AAA', pullRequests: [{ number: 2, environmentBranch: 'qa', mergedAt: '2026-10-15T12:00:00Z' }] }],
    });
    expect(fetch.calls.map((c) => [c.method, c.path])).toEqual([
      ['POST', deploymentsOf(QUERY)],
      ['GET', operationStatusOf('op-1')],
      ['GET', operationStatusOf('op-1')],
      ['GET', operationStatusOf('op-1')],
      ['GET', operationResultOf('op-1')],
    ]);
    expect(fetch.calls[0].path).toBe('/public/reporting/deployments?StartDate=2026-10-15T11%3A55%3A00.000Z&EndDate=2026-10-15T12%3A10%3A00.000Z&PipelineId=pipe-1&EnvironmentIds=env-qa');
    for (const call of fetch.calls) expect(call.headers).toMatchObject({ Authorization: `token ${TOKEN}`, 'api-version': '3.0', Accept: 'application/json' });
    expect(sleeps).toEqual([5000, 5000, 5000]);
  });

  it('skips what is not an object, and keeps missing fields as null', async () => {
    const fetch = fakeGearset(acmeDeployments([
      acmeDeployment(),
      'not a deployment',
      acmeDeployment({ Status: 'Failed', DeploymentPullRequests: [{ PullRequest: { Number: 3, EnvironmentBranchName: 'qa', MergedAt: null } }, 'odd', { PullRequest: 'odd' }] }),
      { Status: 'Successful' },
    ]));
    const r = await gearsetDeployments({ fetch, token: TOKEN, ...QUERY, sleep: async () => {} });
    expect(r.deployments).toEqual([
      { status: 'Successful', date: '2026-10-15T12:03:00Z', environmentId: 'env-qa', salesforceDeploymentId: '0Af000000000009AAA', pullRequests: [{ number: 2, environmentBranch: 'qa', mergedAt: '2026-10-15T12:00:00Z' }] },
      { status: 'Failed', date: '2026-10-15T12:03:00Z', environmentId: 'env-qa', salesforceDeploymentId: '0Af000000000009AAA', pullRequests: [{ number: 3, environmentBranch: 'qa', mergedAt: null }] },
      { status: 'Successful', date: null, environmentId: null, salesforceDeploymentId: null, pullRequests: [] },
    ]);
  });

  it('reads the result from the OperationResultId Gearset names', async () => {
    const fetch = fakeGearset({ ...acmeDeployments([acmeDeployment()], { status: { Status: 'Succeeded', OperationResultId: 'res-9' } }), [operationResultOf('res-9')]: { status: 200, body: { Deployments: [] } } });
    const r = await gearsetDeployments({ fetch, token: TOKEN, ...QUERY, sleep: async () => {} });
    expect(r).toEqual({ ok: true, deployments: [] });
    expect(fetch.calls.at(-1).path).toBe(operationResultOf('res-9'));
  });

  it('gives up as transient when the operation is still running after waitMs', async () => {
    const fetch = fakeGearset(acmeDeployments([], { status: { Status: 'Running' } }));
    const { sleeps, sleep } = sleeper();
    const r = await gearsetDeployments({ fetch, token: TOKEN, ...QUERY, sleep, waitMs: 20_000 });
    expect(r).toEqual({ ok: false, error: 'Gearset is still gathering the deployments', transient: true });
    expect(sleeps).toEqual([5000, 5000, 5000, 5000]);
    expect(fetch.calls.some((c) => c.path.endsWith('/result'))).toBe(false);
  });

  it("is a transient error when the operation fails, never echoing Gearset's error text", async () => {
    const fetch = fakeGearset(acmeDeployments([], { status: { Status: 'Failed', Error: `bad token ${TOKEN} in PipelineId=pipe-1` } }));
    const r = await gearsetDeployments({ fetch, token: TOKEN, ...QUERY, sleep: async () => {} });
    expect(r).toEqual({ ok: false, error: 'Gearset could not list the deployments', transient: true });
  });

  it.each([
    ['../pipelines'],
    ['op 1'],
    [''],
    [42],
    ['x'.repeat(101)],
  ])('refuses an operation id it cannot put in a path (%#), with no further call', async (id) => {
    const fetch = fakeGearset({ [DEPLOYMENTS]: { status: 202, body: { Status: 'Running', OperationStatusId: id } } });
    const r = await gearsetDeployments({ fetch, token: TOKEN, ...QUERY, sleep: async () => {} });
    expect(r).toEqual({ ok: false, error: 'Gearset answered something unreadable', transient: false });
    expect(fetch.calls).toHaveLength(1);
  });

  it('is unreadable when the result has no Deployments list', async () => {
    const fetch = fakeGearset({ ...acmeDeployments(), [operationResultOf('op-1')]: { status: 200, body: { Items: [] } } });
    expect(await gearsetDeployments({ fetch, token: TOKEN, ...QUERY, sleep: async () => {} })).toMatchObject({ ok: false, error: 'Gearset answered something unreadable' });
  });

  it.each([
    [401, 'Gearset refused GEARSET_API_TOKEN', false],
    [403, "the Gearset Reporting API is not enabled for this token's team (Teams or Enterprise tier)", false],
    [429, 'Gearset rate-limited the request; try again later', true],
  ])('maps %i on the POST, the status or the result', async (status, error, transient) => {
    for (const path of [DEPLOYMENTS, operationStatusOf('op-1'), operationResultOf('op-1')]) {
      const fetch = fakeGearset({ ...acmeDeployments(), [path]: { status, body: `no for ${TOKEN}` } });
      const r = await gearsetDeployments({ fetch, token: TOKEN, ...QUERY, sleep: async () => {} });
      expect(r).toEqual({ ok: false, error, transient, status });
    }
  });

  it('never names the token, a header or the query in an error, and never throws', async () => {
    const answers = [new Error(`ECONNRESET ${TOKEN}`), { status: 500, body: {} }, { status: 202, body: 'not json' }, { status: 202, body: [] }];
    for (const answer of answers) {
      const fetch = fakeGearset({ ...acmeDeployments(), [DEPLOYMENTS]: answer });
      const r = await gearsetDeployments({ fetch, token: TOKEN, ...QUERY, sleep: async () => {} });
      expect(r.ok).toBe(false);
      const seen = JSON.stringify(r);
      for (const word of [TOKEN, 'Authorization', 'api-version', 'StartDate', 'PipelineId']) expect(seen).not.toContain(word);
    }
    const sleepThrows = await gearsetDeployments({ fetch: fakeGearset(acmeDeployments()), token: TOKEN, ...QUERY, sleep: async () => { throw new Error('no'); } });
    expect(sleepThrows.ok).toBe(false);
  });
});

describe('deploymentOfPr', () => {
  const dep = (over = {}) => ({ status: 'Successful', date: '2026-10-15T12:03:00Z', environmentId: 'env-qa', salesforceDeploymentId: '0Af000000000009AAA', pullRequests: [{ number: 2, environmentBranch: 'qa', mergedAt: '2026-10-15T12:00:00Z' }], ...over });
  const want = { environmentId: 'env-qa', prNumber: 2, branch: 'qa' };

  it('is deployed when a Successful deployment in the environment lists the pull request', () => {
    const d = dep();
    expect(deploymentOfPr([dep({ status: 'Failed' }), d], want)).toEqual({ state: 'deployed', deployment: d });
  });

  it('is failed when the matches are only Failed or PartiallySuccessful', () => {
    const failed = dep({ status: 'Failed' });
    expect(deploymentOfPr([failed], want)).toEqual({ state: 'failed', deployment: failed });
    const partly = dep({ status: 'PartiallySuccessful' });
    expect(deploymentOfPr([partly], want)).toEqual({ state: 'failed', deployment: partly });
  });

  it('is none when nothing matches the environment, the number or the branch', () => {
    expect(deploymentOfPr([], want)).toEqual({ state: 'none' });
    expect(deploymentOfPr([dep({ environmentId: 'env-uat' })], want)).toEqual({ state: 'none' });
    expect(deploymentOfPr([dep({ pullRequests: [{ number: 3, environmentBranch: 'qa' }] })], want)).toEqual({ state: 'none' });
    expect(deploymentOfPr([dep({ pullRequests: [{ number: 2, environmentBranch: 'uat' }] })], want)).toEqual({ state: 'none' });
    expect(deploymentOfPr([dep({ status: 'Unknown' })], want)).toEqual({ state: 'none' });
    expect(deploymentOfPr(null, want)).toEqual({ state: 'none' });
    expect(deploymentOfPr([null, 'x', dep({ environmentId: null })], { ...want, environmentId: null })).toEqual({ state: 'none' });
  });

  it('ignores the branch when none is given', () => {
    const d = dep({ pullRequests: [{ number: 2, environmentBranch: 'other' }] });
    expect(deploymentOfPr([d], { environmentId: 'env-qa', prNumber: 2 })).toEqual({ state: 'deployed', deployment: d });
  });
});

describe('a rate limit carries the time Gearset names', () => {
  const limited = (headers) => fakeGearset(acmeGearset({ [PIPELINES]: { status: 429, body: {}, ...(headers ? { headers } : {}) } }));

  it('reads Retry-After in seconds', async () => {
    const r = await gearsetPipelines({ fetch: limited({ 'Retry-After': '2' }), token: TOKEN });
    expect(r).toEqual({ ok: false, error: 'Gearset rate-limited the request; try again later', transient: true, status: 429, retryAfterMs: 2000 });
  });

  it('reads Retry-After as an HTTP date', async () => {
    const at = new Date(Date.now() + 120_000).toUTCString();
    const r = await gearsetPipelines({ fetch: limited({ 'retry-after': at }), token: TOKEN });
    expect(r.retryAfterMs).toBeGreaterThanOrEqual(115_000);
    expect(r.retryAfterMs).toBeLessThanOrEqual(120_000);
  });

  it('reads a date in the past as no wait', async () => {
    const r = await gearsetPipelines({ fetch: limited({ 'Retry-After': new Date(Date.now() - 60_000).toUTCString() }), token: TOKEN });
    expect(r.retryAfterMs).toBe(0);
  });

  it.each([[undefined], [{ 'Retry-After': 'soon' }], [{ 'Retry-After': '-5' }], [{ 'Retry-After': '' }]])('adds no retryAfterMs without a readable header (%#)', async (headers) => {
    const r = await gearsetPipelines({ fetch: limited(headers), token: TOKEN });
    expect(r).toEqual({ ok: false, error: 'Gearset rate-limited the request; try again later', transient: true, status: 429 });
    expect(Object.hasOwn(r, 'retryAfterMs')).toBe(false);
  });

  it.each([['99999999999999999999999'], ['10000000000000'], ['9'.repeat(400)]])('caps a huge Retry-After at a day (%#)', async (value) => {
    const r = await gearsetPipelines({ fetch: limited({ 'Retry-After': value }), token: TOKEN });
    expect(r).toEqual({ ok: false, error: 'Gearset rate-limited the request; try again later', transient: true, status: 429, retryAfterMs: MAX_RATE_LIMIT_WAIT_MS });
  });

  it('caps an HTTP date at the far edge', async () => {
    const r = await gearsetPipelines({ fetch: limited({ 'Retry-After': new Date(8.64e15).toUTCString() }), token: TOKEN });
    expect(r.retryAfterMs).toBe(MAX_RATE_LIMIT_WAIT_MS);
  });

  it('keeps a value just under the cap', async () => {
    const r = await gearsetPipelines({ fetch: limited({ 'Retry-After': '86399' }), token: TOKEN });
    expect(r.retryAfterMs).toBe(86_399_000);
  });

  it('adds none to an answer that is not a rate limit', async () => {
    const fetch = fakeGearset(acmeGearset({ [PIPELINES]: { status: 500, body: {}, headers: { 'Retry-After': '2' } } }));
    expect(await gearsetPipelines({ fetch, token: TOKEN })).toEqual({ ok: false, error: 'Gearset answered 500', transient: false, status: 500 });
  });

  it('gearsetEnvironments passes it through when the environments call answers it', async () => {
    const fetch = fakeGearset(acmeGearset({ [environmentsOf('pipe-1')]: { status: 429, body: {}, headers: { 'Retry-After': '7' } } }));
    expect(await gearsetEnvironments({ fetch, token: TOKEN })).toMatchObject({ ok: false, status: 429, transient: true, retryAfterMs: 7000 });
  });

  it('gearsetDeployments passes it through from the POST', async () => {
    const fetch = fakeGearset({ [DEPLOYMENTS]: { status: 429, body: {}, headers: { 'Retry-After': '600' } } });
    const r = await gearsetDeployments({ fetch, token: TOKEN, pipelineId: 'pipe-1', environmentId: 'env-qa', from: '2026-10-15T12:00:00Z', to: '2026-10-15T13:00:00Z', sleep: async () => {} });
    expect(r).toMatchObject({ ok: false, status: 429, retryAfterMs: 600_000 });
  });
});

describe('waitOutRateLimit', () => {
  const START = Date.UTC(2026, 9, 15, 12, 0, 0);
  const iso = (ms) => new Date(ms).toISOString();
  const limit = (retryAfterMs) => ({ ok: false, error: 'Gearset rate-limited the request; try again later', transient: true, status: 429, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
  const clock = () => {
    let t = START;
    const sleeps = [];
    return { sleeps, now: () => new Date(t), sleep: async (ms) => { sleeps.push(ms); t += ms; } };
  };
  const answers = (...list) => {
    let i = 0;
    return async () => list[Math.min(i++, list.length - 1)];
  };

  it('has the default and minimum waits', () => {
    expect(RATE_LIMIT_WAIT_MS).toBe(60_000);
    expect(MIN_RATE_LIMIT_WAIT_MS).toBe(1_000);
  });

  it('caps every wait at a day', () => {
    expect(MAX_RATE_LIMIT_WAIT_MS).toBe(86_400_000);
  });

  it('(g) answers rateLimited with a day from now, without throwing, for a huge wait', async () => {
    const c = clock();
    const r = await waitOutRateLimit(answers(limit(1e26)), { ...c, deadline: START + 120_000, told: () => {} });
    expect(r).toEqual({ ...limit(1e26), rateLimited: true, retryAt: iso(START + MAX_RATE_LIMIT_WAIT_MS) });
    expect(c.sleeps).toEqual([]);
  });

  it('(h) waits a day at most for a huge wait', async () => {
    const c = clock();
    const told = [];
    const r = await waitOutRateLimit(answers(limit(1e26), { ok: true }), { ...c, deadline: START + 2 * MAX_RATE_LIMIT_WAIT_MS, told: (...args) => told.push(args) });
    expect(r).toEqual({ ok: true });
    expect(c.sleeps).toEqual([MAX_RATE_LIMIT_WAIT_MS]);
    expect(told).toEqual([[86_400, iso(START + MAX_RATE_LIMIT_WAIT_MS)]]);
  });

  it('(a) waits the named time once, says so, and answers the next read', async () => {
    const c = clock();
    const told = [];
    const done = { ok: true, environments: [] };
    const r = await waitOutRateLimit(answers(limit(2000), done), { ...c, deadline: START + 60_000, told: (...args) => told.push(args) });
    expect(r).toBe(done);
    expect(c.sleeps).toEqual([2000]);
    expect(told).toEqual([[2, iso(START + 2000)]]);
  });

  it('(b) answers rateLimited with the time, and does not sleep, when the wait passes the deadline', async () => {
    const c = clock();
    const r = await waitOutRateLimit(answers(limit(675_000)), { ...c, deadline: START + 120_000, told: () => {} });
    expect(r).toEqual({ ...limit(675_000), rateLimited: true, retryAt: iso(START + 675_000) });
    expect(c.sleeps).toEqual([]);
  });

  it('(c) waits a minute when Gearset names no time', async () => {
    const c = clock();
    await waitOutRateLimit(answers(limit(), { ok: true }), { ...c, deadline: START + 600_000, told: () => {} });
    expect(c.sleeps).toEqual([60_000]);
  });

  it('(d) waits at least a second, and a repeated 0 ends at the deadline', async () => {
    const c = clock();
    const r = await waitOutRateLimit(answers(limit(0), { ok: true }), { ...c, deadline: START + 600_000, told: () => {} });
    expect(r).toEqual({ ok: true });
    expect(c.sleeps).toEqual([1000]);

    const again = clock();
    const stuck = await waitOutRateLimit(answers(limit(0)), { ...again, deadline: START + 5_000, told: () => {} });
    expect(stuck).toMatchObject({ ok: false, status: 429, rateLimited: true });
    expect(again.sleeps).toEqual([1000, 1000, 1000, 1000, 1000]);
  });

  it('(e) returns any other failure at once', async () => {
    const c = clock();
    const refused = { ok: false, error: 'Gearset refused GEARSET_API_TOKEN', transient: false, status: 401 };
    expect(await waitOutRateLimit(answers(refused), { ...c, deadline: START + 60_000, told: () => {} })).toBe(refused);
    expect(c.sleeps).toEqual([]);
  });

  it('(f) keeps waiting when told throws', async () => {
    const c = clock();
    const r = await waitOutRateLimit(answers(limit(2000), { ok: true }), { ...c, deadline: START + 60_000, told: () => { throw new Error('no'); } });
    expect(r).toEqual({ ok: true });
    expect(c.sleeps).toEqual([2000]);
  });
});

describe('releaseEnvironments', () => {
  const pipelineCalls = (fetch) => fetch.calls.filter((c) => c.path === PIPELINES).length;
  const environmentCalls = (fetch) => fetch.calls.filter((c) => c.path.startsWith('/public/reporting/environments')).length;

  it('reads once for one ctx, fetch and token', async () => {
    const fetch = fakeGearset();
    const ctx = {};
    const first = await releaseEnvironments(ctx, { fetch, token: TOKEN });
    const second = await releaseEnvironments(ctx, { fetch, token: TOKEN });
    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    expect(pipelineCalls(fetch)).toBe(1);
    expect(environmentCalls(fetch)).toBe(1);
  });

  it('keeps one answer per pipelineId', async () => {
    const fetch = fakeGearset(acmeTwoPipelines());
    const ctx = {};
    await releaseEnvironments(ctx, { fetch, token: TOKEN, pipelineId: 'pipe-1' });
    await releaseEnvironments(ctx, { fetch, token: TOKEN });
    await releaseEnvironments(ctx, { fetch, token: TOKEN, pipelineId: 'pipe-1' });
    await releaseEnvironments(ctx, { fetch, token: TOKEN });
    expect(pipelineCalls(fetch)).toBe(2);
  });

  it('reads again for a different ctx', async () => {
    const fetch = fakeGearset();
    await releaseEnvironments({}, { fetch, token: TOKEN });
    await releaseEnvironments({}, { fetch, token: TOKEN });
    expect(environmentCalls(fetch)).toBe(2);
  });

  it('reads again for a different token or fetch', async () => {
    const fetch = fakeGearset();
    const ctx = {};
    await releaseEnvironments(ctx, { fetch, token: TOKEN });
    await releaseEnvironments(ctx, { fetch, token: 't-other' });
    expect(environmentCalls(fetch)).toBe(2);
    const other = fakeGearset();
    await releaseEnvironments(ctx, { fetch: other, token: 't-other' });
    expect(environmentCalls(other)).toBe(1);
  });

  it('does not keep a failed read', async () => {
    let status = 500;
    const fetch = fakeGearset(acmeGearset({ [PIPELINES]: () => (status === 500 ? { status, body: {} } : { status: 200, body: [{ PipelineId: 'pipe-1' }] }) }));
    const ctx = {};
    expect(await releaseEnvironments(ctx, { fetch, token: TOKEN })).toMatchObject({ ok: false, status: 500 });
    status = 200;
    expect((await releaseEnvironments(ctx, { fetch, token: TOKEN })).ok).toBe(true);
    expect(pipelineCalls(fetch)).toBe(2);
  });

  it('reads directly, never throwing, when ctx is not an object', async () => {
    const fetch = fakeGearset();
    expect((await releaseEnvironments(null, { fetch, token: TOKEN })).ok).toBe(true);
    expect((await releaseEnvironments(undefined, { fetch, token: TOKEN })).ok).toBe(true);
    expect(environmentCalls(fetch)).toBe(2);
  });
});

describe('the nudge limits', () => {
  it('waits 5 minutes for a status, and nudges at most twice', () => {
    expect(NUDGE_MINUTES).toBe(5);
    expect(MAX_NUDGES).toBe(2);
  });
});
