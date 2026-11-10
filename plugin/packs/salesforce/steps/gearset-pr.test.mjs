import { describe, expect, it } from 'vitest';
import gearsetPr from './gearset-pr.mjs';
import { runShip } from '../../../lib/engine/ship.mjs';
import { fakeCtx } from '../../../../test/ship-fakes.mjs';
import { ACME_DEV1_ID, ACME_QA_ID, ACME_UAT_ID } from '../../../../test/fake-sf.mjs';
import { PIPELINES, acmeEnvironment, acmeGearset, acmeTwoPipelines, environmentsOf, fakeGearset } from '../../../../test/fake-gearset.mjs';

const TOKEN = 't-acme';
const HEAD = 'gs-pipeline/story/s-1_-_qa';
const PROMO = 'https://github.com/acme/app/pull/2';
const FEATURE = 'https://github.com/acme/app/pull/1';
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const SHA2 = 'b2c3d4e5f60718293a4b5c6d7e8f901234567890';

const PROMO_LIST = /^gh pr list --head gs-pipeline\/story\/s-1_-_qa --base qa --state all --json number,url,state,headRefOid$/;
const FEATURE_LIST = /^gh pr list --head story\/s-1 --base qa --state open --json number,url$/;
const CREATE = 'gh pr create --base qa --head story/s-1 --fill';
const statusOf = (sha) => `gh api repos/{owner}/{repo}/commits/${sha}/status`;

const promo = (over = {}) => ({ number: 2, url: PROMO, state: 'OPEN', headRefOid: SHA, ...over });
const list = (...prs) => JSON.stringify(prs);
const st = (context, state, description = '') => ({ context, state, description });
const statuses = (...entries) => JSON.stringify({ state: 'pending', sha: SHA, statuses: entries });
const QA_OK = statuses(st('Gearset QA', 'success', 'Validation succeeded'));

// Answers in turn; the last one repeats.
const inTurn = (...answers) => {
  let i = 0;
  return () => answers[Math.min(i++, answers.length - 1)];
};

const block = () => ({
  productionBranch: 'main',
  orgs: { 'acme-dev1': { orgId: ACME_DEV1_ID }, 'acme-qa': { orgId: ACME_QA_ID }, 'acme-uat': { orgId: ACME_UAT_ID } },
  build: ['acme-dev1'],
  stages: [{ name: 'qa', org: 'acme-qa', branch: 'qa' }, { name: 'uat', org: 'acme-uat', branch: 'uat' }],
  release: 'gearset',
});

function setup({ rules = [], routes = acmeGearset(), env = { GEARSET_API_TOKEN: TOKEN }, ship = {}, raise, gearset } = {}) {
  const fetch = fakeGearset(routes);
  const raised = [];
  const raiseStoryEvent = raise ?? ((...args) => {
    raised.push(args);
    return { ok: true };
  });
  const ctx = fakeCtx({
    config: { baseBranch: 'main', pack: 'salesforce', salesforce: { ...block(), ...(gearset ? { gearset } : {}) }, ship: { pr: { into: 'qa' }, ci: { timeoutMinutes: 2 }, ...ship } },
    rules,
    env,
    branch: 'story/s-1',
    fetch,
  });
  const run = () => gearsetPr.run(ctx, { fetch, raiseStoryEvent });
  return { ctx, fetch, raised, run };
}

const ghCalls = (ctx) => ctx.sh.calls.filter((l) => l.startsWith('gh '));

describe('gearset-pr', () => {
  it('is a gh step that needs the Gearset token and does not halt', () => {
    expect(gearsetPr).toMatchObject({ name: 'gearset-pr', label: "opening the pull request and following Gearset's promotion PR", needs: ['gh'], requires: { env: ['GEARSET_API_TOKEN'] } });
    expect(gearsetPr.halts).toBeUndefined();
  });

  it('found: the promotion PR is open and Gearset QA passed', async () => {
    const { ctx, raised, run } = setup({ rules: [[PROMO_LIST, list(promo())], [statusOf(SHA), QA_OK]] });
    expect(await run()).toEqual({ ok: true, pr: PROMO, prNumber: 2 });
    expect(ctx.sh.calls.some((l) => l.startsWith('gh pr create'))).toBe(false);
    expect(ctx.sleeps).toEqual([]);
    expect(ctx.reports).toContain(PROMO);
    expect(raised).toHaveLength(1);
    expect(raised[0].slice(1)).toEqual(['S-1', 'review', `Pull request ready for review: ${PROMO}`]);
  });

  it('not yet created: opens the PR into qa, then follows the promotion PR Gearset opens', async () => {
    const { ctx, run } = setup({
      rules: [[PROMO_LIST, inTurn(list(), list(), list(promo()))], [FEATURE_LIST, list()], [CREATE, `${FEATURE}\n`], [statusOf(SHA), QA_OK]],
    });
    expect(await run()).toEqual({ ok: true, pr: PROMO, prNumber: 2 });
    expect(ctx.sh.calls).toContain(CREATE);
    expect(ctx.sh.calls.filter((l) => l.startsWith('gh pr create'))).toHaveLength(1);
    expect(ctx.sh.calls.some((l) => l.includes('--base main'))).toBe(false);
    expect(ctx.sleeps).toEqual([20_000, 20_000]);
    expect(ctx.reports).toEqual([FEATURE, PROMO]);
  });

  it('does not open a second PR when the feature PR is already open', async () => {
    const { ctx, run } = setup({
      rules: [[PROMO_LIST, inTurn(list(), list(promo()))], [FEATURE_LIST, list({ number: 1, url: FEATURE })], [statusOf(SHA), QA_OK]],
    });
    expect(await run()).toEqual({ ok: true, pr: PROMO, prNumber: 2 });
    expect(ctx.sh.calls.some((l) => l.startsWith('gh pr create'))).toBe(false);
    expect(ctx.reports).toEqual([FEATURE, PROMO]);
  });

  it('fails with code 2 when Gearset QA validation fails', async () => {
    const { run } = setup({ rules: [[PROMO_LIST, list(promo())], [statusOf(SHA), statuses(st('Gearset QA', 'failure', 'Validation failed: 3 component errors'))]] });
    const r = await run();
    expect(r).toEqual({ ok: false, code: 2, stage: 'gearset-pr', reason: 'Gearset QA validation failed on pull request #2: Validation failed: 3 component errors', pr: PROMO, prNumber: 2 });
  });

  it('fails on an error state too, keeping the first 200 characters of the description', async () => {
    const { run } = setup({ rules: [[PROMO_LIST, list(promo())], [statusOf(SHA), statuses(st('Gearset QA', 'error', 'x'.repeat(300)))]] });
    const r = await run();
    expect(r).toMatchObject({ ok: false, code: 2, prNumber: 2 });
    expect(r.reason).toBe(`Gearset QA validation failed on pull request #2: ${'x'.repeat(200)}`);
  });

  it("ignores another environment's status and waits for Gearset QA", async () => {
    const { ctx, run } = setup({
      rules: [
        [PROMO_LIST, list(promo())],
        [statusOf(SHA), inTurn(
          statuses(st('Gearset UAT', 'success'), st('Gearset QA', 'pending')),
          statuses(st('Gearset UAT', 'success'), st('Gearset QA', 'pending')),
          statuses(st('Gearset UAT', 'success'), st('Gearset QA', 'success')),
        )],
      ],
    });
    expect(await run()).toEqual({ ok: true, pr: PROMO, prNumber: 2 });
    expect(ctx.sleeps).toEqual([20_000, 20_000]);
  });

  it('does not take any other Gearset status, or a near match, as the validation', async () => {
    const { run } = setup({ rules: [[PROMO_LIST, list(promo())], [statusOf(SHA), statuses(st('Gearset UAT', 'success'), st('Gearset QA2', 'success'), st('gearset qa', 'success'))]] });
    expect(await run()).toMatchObject({ ok: false, code: 2, reason: expect.stringContaining('has not validated') });
  });

  it('times out when Gearset never opens the promotion PR', async () => {
    const { ctx, run } = setup({ rules: [[PROMO_LIST, list()], [FEATURE_LIST, list()], [CREATE, `${FEATURE}\n`]] });
    const r = await run();
    expect(r).toEqual({
      ok: false,
      code: 2,
      stage: 'gearset-pr',
      reason: `Gearset did not open ${HEAD} within 2 minutes; check that the pipeline's QA environment uses this repository and its CI job validates pull requests`,
      pr: FEATURE,
    });
    expect(ctx.sleeps).toHaveLength(6);
  });

  it('times out when Gearset QA never validates the promotion PR', async () => {
    const { run } = setup({ rules: [[PROMO_LIST, list(promo())], [statusOf(SHA), statuses(st('Gearset UAT', 'success'))]] });
    expect(await run()).toEqual({
      ok: false,
      code: 2,
      stage: 'gearset-pr',
      reason: 'Gearset QA has not validated pull request #2 within 2 minutes; turn on "Validate pull requests targeting the source branch" for its CI job',
      pr: PROMO,
      prNumber: 2,
    });
  });

  it('times out when Gearset QA is still pending', async () => {
    const { run } = setup({ rules: [[PROMO_LIST, list(promo())], [statusOf(SHA), statuses(st('Gearset QA', 'pending'))]] });
    expect(await run()).toEqual({
      ok: false,
      code: 2,
      stage: 'gearset-pr',
      reason: 'Gearset QA validation did not finish within 2 minutes on pull request #2',
      pr: PROMO,
      prNumber: 2,
    });
  });

  it('adds the last gh error to a timeout', async () => {
    const { run } = setup({ rules: [[PROMO_LIST, list(promo())], [statusOf(SHA), { status: 1, stderr: 'HTTP 502: Bad Gateway' }]] });
    const r = await run();
    expect(r).toMatchObject({ ok: false, code: 2 });
    expect(r.reason).toContain('has not validated pull request #2');
    expect(r.reason).toContain('HTTP 502: Bad Gateway');
  });

  it('ignores a CLOSED promotion PR and prefers an OPEN one to a MERGED one', async () => {
    const closed = { number: 5, url: 'https://github.com/acme/app/pull/5', state: 'CLOSED', headRefOid: SHA2 };
    const merged = { number: 3, url: 'https://github.com/acme/app/pull/3', state: 'MERGED', headRefOid: SHA2 };
    const both = setup({ rules: [[PROMO_LIST, list(closed, merged, promo())], [statusOf(SHA), QA_OK], [statusOf(SHA2), QA_OK]] });
    expect(await both.run()).toEqual({ ok: true, pr: PROMO, prNumber: 2 });

    const old = setup({ rules: [[PROMO_LIST, list(closed, merged)], [statusOf(SHA2), QA_OK]] });
    expect(await old.run()).toEqual({ ok: true, pr: merged.url, prNumber: 3 });

    const gone = setup({ rules: [[PROMO_LIST, inTurn(list(closed), list(closed, promo()))], [FEATURE_LIST, list()], [CREATE, `${FEATURE}\n`], [statusOf(SHA), QA_OK], [statusOf(SHA2), QA_OK]] });
    expect(await gone.run()).toEqual({ ok: true, pr: PROMO, prNumber: 2 });
    expect(gone.ctx.sh.calls).toContain(CREATE);
  });

  it('reads the status of the new head after Gearset re-syncs the promotion branch', async () => {
    const { ctx, run } = setup({
      rules: [[PROMO_LIST, inTurn(list(promo()), list(promo({ headRefOid: SHA2 })))], [statusOf(SHA), statuses(st('Gearset QA', 'pending'))], [statusOf(SHA2), QA_OK]],
    });
    expect(await run()).toEqual({ ok: true, pr: PROMO, prNumber: 2 });
    expect(ctx.sh.calls).toContain(statusOf(SHA2));
    expect(ctx.reports.filter((d) => d === PROMO)).toHaveLength(1);
  });

  describe('a gh list that fails does not open a pull request', () => {
    const FAILED = { status: 1, stderr: 'HTTP 502: Bad Gateway' };
    const creates = (ctx) => ctx.sh.calls.filter((l) => l.startsWith('gh pr create'));

    it('follows a promotion PR that exists when the first promotion list failed', async () => {
      const { ctx, run } = setup({ rules: [[PROMO_LIST, inTurn(FAILED, list(promo()))], [FEATURE_LIST, list()], [statusOf(SHA), QA_OK]] });
      expect(await run()).toEqual({ ok: true, pr: PROMO, prNumber: 2 });
      expect(creates(ctx)).toEqual([]);
      expect(ctx.sh.calls.some((l) => FEATURE_LIST.test(l))).toBe(false);
      expect(ctx.sleeps).toEqual([20_000]);
    });

    it('does not create the story PR when the feature list failed and the PR is open', async () => {
      const { ctx, run } = setup({
        rules: [[PROMO_LIST, inTurn(list(), list(), list(promo()))], [FEATURE_LIST, inTurn(FAILED, list({ number: 1, url: FEATURE }))], [statusOf(SHA), QA_OK]],
      });
      expect(await run()).toMatchObject({ ok: true });
      expect(creates(ctx)).toEqual([]);
      expect(ctx.reports).toEqual([FEATURE, PROMO]);
    });

    it('opens the story PR once, on the round after both lists failed', async () => {
      const { ctx, run } = setup({
        rules: [[PROMO_LIST, inTurn(FAILED, list(), list(promo()))], [FEATURE_LIST, list()], [CREATE, `${FEATURE}\n`], [statusOf(SHA), QA_OK]],
      });
      expect(await run()).toMatchObject({ ok: true });
      expect(creates(ctx)).toHaveLength(1);
      const promoCalls = ctx.sh.calls.map((l, i) => (PROMO_LIST.test(l) ? i : -1)).filter((i) => i >= 0);
      expect(ctx.sh.calls.indexOf(CREATE)).toBeGreaterThan(promoCalls[1]);
    });

    it('waits until the deadline when gh never answers', async () => {
      const { ctx, run } = setup({ rules: [[PROMO_LIST, FAILED], [FEATURE_LIST, FAILED]] });
      const r = await run();
      expect(r).toMatchObject({ ok: false, code: 2, stage: 'gearset-pr' });
      expect(r).not.toHaveProperty('pr');
      expect(r.reason).toContain(`Gearset did not open ${HEAD} within 2 minutes`);
      expect(r.reason).toContain('gh pr list failed: HTTP 502: Bad Gateway');
      expect(creates(ctx)).toEqual([]);
    });

    it('needs the promotion list to answer too before creating', async () => {
      const { ctx, run } = setup({ rules: [[PROMO_LIST, FAILED], [FEATURE_LIST, list()]] });
      expect(await run()).toMatchObject({ ok: false, code: 2, stage: 'gearset-pr' });
      expect(creates(ctx)).toEqual([]);
    });

    it('still fails with code 1 when the create fails after both lists answered empty', async () => {
      const { run } = setup({ rules: [[PROMO_LIST, list()], [FEATURE_LIST, list()], [CREATE, { status: 1, stderr: 'boom' }]] });
      expect(await run()).toEqual({ ok: false, code: 1, stage: 'gearset-pr', reason: 'Could not open the pull request into qa.' });
    });
  });

  describe('stops before anything is opened', () => {
    const before = async (opts, reason) => {
      const { ctx, run } = setup(opts);
      expect(await run()).toEqual({ ok: false, code: 1, stage: 'gearset-pr', reason });
      expect(ghCalls(ctx)).toEqual([]);
    };

    it('when GEARSET_API_TOKEN is missing', async () => {
      await before({ env: {} }, "GEARSET_API_TOKEN is not set; gearset-pr reads stage qa's Gearset environment from the Gearset Reporting API");
    });
    it('when the Reporting API refuses the team', async () => {
      await before({ routes: acmeGearset({ [PIPELINES]: { status: 403, body: {} } }) }, "the Gearset Reporting API is not enabled for this token's team (Teams or Enterprise tier)");
    });
    it('when no environment deploys to acme-qa', async () => {
      await before({ routes: acmeGearset({ [environmentsOf('pipe-1')]: { status: 200, body: [acmeEnvironment('UAT', ACME_UAT_ID, 'Release')] } }) }, `no Gearset environment deploys to ${ACME_QA_ID}`);
    });
    it('when acme-qa is Gearset production', async () => {
      await before({ routes: acmeGearset({ [environmentsOf('pipe-1')]: { status: 200, body: [acmeEnvironment('QA', ACME_QA_ID, 'Production')] } }) }, `${ACME_QA_ID} is Gearset's production environment; production is never a target`);
    });
  });

  describe('with salesforce.gearset.pipelineId', () => {
    const rules = [[PROMO_LIST, list(promo())], [statusOf(SHA), QA_OK]];

    it('reads only that pipeline, so a second pipeline on the QA org is no clash', async () => {
      const { fetch, run } = setup({ rules, routes: acmeTwoPipelines(), gearset: { promote: 'merge', pipelineId: 'pipe-1' } });
      expect(await run()).toEqual({ ok: true, pr: PROMO, prNumber: 2 });
      expect(fetch.calls.map((c) => c.path)).toEqual([PIPELINES, environmentsOf('pipe-1')]);
    });

    it('without it, still searches every pipeline', async () => {
      const { fetch, run } = setup({ rules, routes: acmeTwoPipelines() });
      expect(await run()).toMatchObject({ ok: false, code: 1, reason: `${ACME_QA_ID} is the target of several Gearset environments (QA, Legacy QA)` });
      expect(fetch.calls.map((c) => c.path)).toEqual([PIPELINES, environmentsOf('pipe-1'), environmentsOf('pipe-2')]);
    });

    it('fails when the token sees no such pipeline', async () => {
      const { ctx, run } = setup({ rules, routes: acmeTwoPipelines(), gearset: { promote: 'merge', pipelineId: 'pipe-9' } });
      expect(await run()).toEqual({ ok: false, code: 1, stage: 'gearset-pr', reason: 'Gearset shows no pipeline pipe-9 to this token' });
      expect(ghCalls(ctx)).toEqual([]);
    });
  });

  it('refuses a ship.pr.into that is no stage branch', async () => {
    const { ctx, fetch, run } = setup({ ship: { pr: { into: 'develop' } } });
    expect(await run()).toEqual({ ok: false, code: 1, stage: 'gearset-pr', reason: "ship.pr.into is develop, which is no stage's own branch; Gearset promotes into a stage's environment branch" });
    expect(ghCalls(ctx)).toEqual([]);
    expect(fetch.calls).toEqual([]);
  });

  it('turns a story source that throws or refuses into a warn event, and still succeeds', async () => {
    const thrown = setup({ rules: [[PROMO_LIST, list(promo())], [statusOf(SHA), QA_OK]], raise: () => { throw new Error('jira down'); } });
    expect(await thrown.run()).toEqual({ ok: true, pr: PROMO, prNumber: 2 });
    expect(thrown.ctx.events).toEqual([{ text: 'Could not tell the story source S-1 is in review (jira down).', kind: 'warn' }]);

    const refused = setup({ rules: [[PROMO_LIST, list(promo())], [statusOf(SHA), QA_OK]], raise: async () => ({ ok: false, error: 'no such story: S-1' }) });
    expect(await refused.run()).toEqual({ ok: true, pr: PROMO, prNumber: 2 });
    expect(refused.ctx.events).toEqual([{ text: 'Could not tell the story source S-1 is in review (no such story: S-1).', kind: 'warn' }]);
  });

  describe('through the ship runner', () => {
    const runnerCtx = (statusAnswer) => fakeCtx({
      config: { baseBranch: 'main', pack: 'salesforce', salesforce: block(), ship: { pr: { into: 'qa' }, ci: { timeoutMinutes: 2 } } },
      rules: [[PROMO_LIST, list(promo())], [statusOf(SHA), statusAnswer]],
      env: { GEARSET_API_TOKEN: TOKEN },
      fetch: fakeGearset(acmeGearset()),
    });

    it('ships with the promotion PR as the pr fact', async () => {
      const ctx = runnerCtx(QA_OK);
      const { code, result } = await runShip({ steps: [gearsetPr], ctx });
      expect(code).toBe(0);
      expect(result).toMatchObject({ stage: 'shipped', pr: PROMO, prNumber: 2 });
      expect(ctx.halts).toEqual([]);
    });

    it('fails a failed validation with code 2 and writes no HALT', async () => {
      const ctx = runnerCtx(statuses(st('Gearset QA', 'failure', 'Validation failed')));
      const { code, result } = await runShip({ steps: [gearsetPr], ctx });
      expect(code).toBe(2);
      expect(result).toMatchObject({ stage: 'gearset-pr', pr: PROMO, prNumber: 2 });
      expect(ctx.halts).toEqual([]);
    });
  });

  it('never puts the token in a result, reason, event or report', async () => {
    const secret = 't-acme-secret-77';
    const scenarios = [
      { rules: [[PROMO_LIST, list(promo())], [statusOf(SHA), QA_OK]], raise: () => { throw new Error('down'); } },
      { rules: [[PROMO_LIST, list(promo())], [statusOf(SHA), statuses(st('Gearset QA', 'failure', 'bad'))]] },
      { rules: [[PROMO_LIST, list()], [FEATURE_LIST, list()], [CREATE, `${FEATURE}\n`]] },
      { routes: acmeGearset({ [PIPELINES]: { status: 401, body: {} } }) },
      { routes: acmeGearset({ [PIPELINES]: new Error(`refused for ${secret}`) }) },
    ];
    for (const s of scenarios) {
      const { ctx, run } = setup({ ...s, env: { GEARSET_API_TOKEN: secret } });
      const r = await run();
      const seen = JSON.stringify({ r, events: ctx.events, reports: ctx.reports, calls: ctx.sh.calls });
      expect(seen).not.toContain(secret);
    }
  });
});
