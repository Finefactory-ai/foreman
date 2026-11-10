import { describe, expect, it } from 'vitest';
import { API, SUCCESSFUL, TOKEN_VAR, deploymentOfPr, environmentFor, gearsetDeployments, gearsetEnvironments, gearsetPipelines, gearsetToken, matchEnvironments, promotionBranch, statusContext } from './gearset.mjs';
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
