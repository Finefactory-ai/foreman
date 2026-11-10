import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gearsetPromote } from './gearset-promote.mjs';
import { runShip } from '../../../lib/engine/ship.mjs';
import { fakeCtx } from '../../../../test/ship-fakes.mjs';
import { ACME_DEV1_ID, ACME_QA_ID, ACME_UAT_ID, sfError, sfOk } from '../../../../test/fake-sf.mjs';
import {
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
  operationStatusOf,
} from '../../../../test/fake-gearset.mjs';

const TOKEN = 't-acme';
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const SHA_UAT = 'c3d4e5f60718293a4b5c6d7e8f9012345678a1b2';
const PROMO = 'https://github.com/acme/app/pull/2';
const PROMO_UAT = 'https://github.com/acme/app/pull/3';
const MERGED_AT = '2026-10-15T12:00:30Z';
const DEPLOY = '0Af000000000001AAA';

const listOf = (head, base) => `gh pr list --head ${head} --base ${base} --state all --json number,url,state,headRefOid,mergedAt,isCrossRepository`;
const QA_LIST = listOf('gs-pipeline/story/s-1_-_qa', 'qa');
const UAT_LIST = listOf('gs-pipeline/story/s-1_-_uat', 'uat');
const statusOf = (sha) => `gh api repos/{owner}/{repo}/commits/${sha}/status`;
const MERGE_QA = `gh pr merge 2 --merge --match-head-commit ${SHA}`;
const MERGE_UAT = `gh pr merge 3 --merge --match-head-commit ${SHA_UAT}`;
const SF_QUERY = /^sf data query --use-tooling-api --query SELECT Id, Status, CheckOnly, CompletedDate, NumberTestsCompleted FROM DeployRequest WHERE CreatedDate > \S+ ORDER BY CreatedDate DESC LIMIT 20 --target-org /;
const sfFor = (org) => new RegExp(`${SF_QUERY.source}${org} `);

const promo = (over = {}) => ({ number: 2, url: PROMO, state: 'OPEN', headRefOid: SHA, mergedAt: null, isCrossRepository: false, ...over });
const merged = (over = {}) => promo({ state: 'MERGED', mergedAt: MERGED_AT, ...over });
const promoUat = (over = {}) => ({ number: 3, url: PROMO_UAT, state: 'OPEN', headRefOid: SHA_UAT, mergedAt: null, isCrossRepository: false, ...over });
const mergedUat = (over = {}) => promoUat({ state: 'MERGED', mergedAt: '2026-10-15T12:10:00Z', ...over });
const list = (...prs) => JSON.stringify(prs);
const st = (context, state, description = '') => ({ context, state, description });
const statuses = (...entries) => JSON.stringify({ state: 'pending', statuses: entries });
const QA_OK = statuses(st('Gearset QA', 'success', 'Validation succeeded'));
const UAT_OK = statuses(st('Gearset QA', 'success'), st('Gearset UAT', 'success'));

const deployRow = (over = {}) => ({ attributes: { type: 'DeployRequest' }, Id: DEPLOY, Status: 'Succeeded', CheckOnly: false, CompletedDate: '2026-10-15T12:01:30.000+0000', NumberTestsCompleted: 12, ...over });
const rows = (...records) => sfOk({ records, totalSize: records.length, done: true });

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
const MERGE = { promote: 'merge' };
const OWNER = { promote: 'owner' };

let sfHome;
beforeEach(() => {
  sfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-gspromote-sfhome-'));
});
afterEach(() => {
  fs.rmSync(sfHome, { recursive: true, force: true });
});

function setup({ rules = [], routes = acmeGearset(), env = { GEARSET_API_TOKEN: TOKEN }, gearset = MERGE, salesforce, ship = {} } = {}) {
  const fetch = fakeGearset(routes);
  const sf = salesforce ?? { ...block(), ...(gearset ? { gearset } : {}) };
  const ctx = fakeCtx({
    config: { baseBranch: 'main', pack: 'salesforce', salesforce: sf, ship: { pr: { into: 'qa' }, ci: { timeoutMinutes: 2 }, ...ship } },
    rules,
    env: { FOREMAN_SF_HOME: sfHome, ...env },
    branch: 'story/s-1',
    root: '/acme/repo',
    fetch,
  });
  const run = (stage = 'qa') => gearsetPromote(stage).run(ctx, { fetch });
  return { ctx, fetch, run };
}

const ghCalls = (ctx) => ctx.sh.calls.filter((l) => l.startsWith('gh '));
const sfCalls = (ctx) => ctx.sh.calls.filter((l) => l.startsWith('sf '));
const merges = (ctx) => ctx.sh.calls.filter((l) => l.startsWith('gh pr merge'));
const FORBIDDEN = ['--squash', '--rebase', '--delete-branch', '--admin', '--auto'];

// The rules for a qa promotion that merges: OPEN, then MERGED after the merge, with `sf` the
// answer to the DeployRequest query in acme-qa.
const qaMerges = (sf = rows(deployRow())) => [
  [QA_LIST, inTurn(list(promo()), list(merged()))],
  [statusOf(SHA), QA_OK],
  [MERGE_QA, ''],
  [sfFor('acme-qa'), sf],
];

describe('gearsetPromote(stage)', () => {
  it('is one module per stage name', () => {
    expect(gearsetPromote('qa')).toBe(gearsetPromote('qa'));
    expect(gearsetPromote('uat')).not.toBe(gearsetPromote('qa'));
  });

  it('is a gh and sf step that needs the Gearset token, halts, deploys and may pass the point of no return', () => {
    const qa = gearsetPromote('qa');
    expect(qa).toMatchObject({
      name: 'gearset-promote-qa',
      label: 'promoting to qa through Gearset',
      needs: ['gh', 'sf'],
      requires: { env: ['GEARSET_API_TOKEN'] },
      halts: true,
      deploys: true,
      mayMarkNoReturn: true,
    });
    expect(typeof qa.run).toBe('function');
    expect(typeof qa.check).toBe('function');
    expect(gearsetPromote('uat').name).toBe('gearset-promote-uat');
  });
});

describe('merge mode', () => {
  it('merges the open promotion PR once Gearset QA passes, with a merge commit only, and confirms the deploy in the org', async () => {
    const { ctx, run } = setup({ rules: qaMerges() });
    const r = await run();
    expect(r).toEqual({
      ok: true,
      noReturn: true,
      gearsetPromotions: { qa: { org: 'acme-qa', pr: PROMO, prNumber: 2, mergedAt: MERGED_AT, via: 'org', deployId: DEPLOY, testsCompleted: 12 } },
    });
    expect(merges(ctx)).toEqual([MERGE_QA]);
    for (const line of ctx.sh.calls) for (const flag of FORBIDDEN) expect(line).not.toContain(flag);
    expect(sfCalls(ctx)[0]).toContain('WHERE CreatedDate > 2026-10-15T12:00:30Z');
    expect(sfCalls(ctx)[0]).toContain('--target-org acme-qa');
    expect(ctx.reports).toContain('promoting to qa through Gearset');
    expect(ctx.events).toEqual([]);
  });

  it('reads only the pipeline salesforce.gearset.pipelineId names, so a second pipeline on the QA org is no clash', async () => {
    const { ctx, fetch, run } = setup({ rules: qaMerges(), routes: acmeTwoPipelines(), gearset: { promote: 'merge', pipelineId: 'pipe-1' } });
    expect(await run()).toMatchObject({ ok: true, noReturn: true });
    expect(merges(ctx)).toEqual([MERGE_QA]);
    const read = fetch.calls.filter((c) => c.path.startsWith('/public/reporting/environments')).map((c) => c.path);
    expect(read).toEqual([environmentsOf('pipe-1')]);
    // Without it, every pipeline is searched as before, and the two QA environments clash.
    const all = setup({ rules: qaMerges(), routes: acmeTwoPipelines() });
    expect(await all.run()).toMatchObject({ ok: false, code: 1, reason: `${ACME_QA_ID} is the target of several Gearset environments (QA, Legacy QA)` });
  });

  it('keeps the promotions of earlier stages', async () => {
    const { ctx, run } = setup({ rules: qaMerges() });
    ctx.gearsetPromotions = { dev: { org: 'acme-dev' } };
    const r = await run();
    expect(Object.keys(r.gearsetPromotions)).toEqual(['dev', 'qa']);
  });

  it("follows the uat environment: waits for its PR and its own status, ignoring Gearset QA's", async () => {
    const { ctx, run } = setup({
      rules: [
        [UAT_LIST, inTurn(list(), list(), list(promoUat()), list(promoUat()), list(mergedUat()))],
        [statusOf(SHA_UAT), inTurn(statuses(st('Gearset QA', 'success')), UAT_OK)],
        [MERGE_UAT, ''],
        [sfFor('acme-uat'), rows(deployRow({ CompletedDate: '2026-10-15T12:11:00.000+0000' }))],
      ],
    });
    const r = await run('uat');
    expect(r).toMatchObject({ ok: true, noReturn: true, gearsetPromotions: { uat: { org: 'acme-uat', prNumber: 3, via: 'org', deployId: DEPLOY } } });
    expect(merges(ctx)).toEqual([MERGE_UAT]);
    expect(ctx.sleeps).toEqual([20_000, 20_000, 20_000]);
    expect(sfCalls(ctx).every((l) => l.includes('--target-org acme-uat'))).toBe(true);
  });

  it('does not merge again when the promotion PR is already MERGED (a re-run), and confirms in the org', async () => {
    const { ctx, run } = setup({ rules: [[QA_LIST, list(merged())], [sfFor('acme-qa'), rows(deployRow())]] });
    expect(await run()).toMatchObject({ ok: true, noReturn: true, gearsetPromotions: { qa: { via: 'org', prNumber: 2, deployId: DEPLOY } } });
    expect(merges(ctx)).toEqual([]);
  });

  it('takes an OPEN promotion PR before a MERGED one and ignores a CLOSED one', async () => {
    const closed = { number: 5, url: 'https://github.com/acme/app/pull/5', state: 'CLOSED', headRefOid: SHA_UAT, mergedAt: null, isCrossRepository: false };
    const { ctx, run } = setup({ rules: [[QA_LIST, inTurn(list(closed, merged({ number: 1 }), promo()), list(merged()))], [statusOf(SHA), QA_OK], [MERGE_QA, ''], [sfFor('acme-qa'), rows(deployRow())]] });
    expect(await run()).toMatchObject({ ok: true });
    expect(merges(ctx)).toEqual([MERGE_QA]);
  });

  describe('pull requests from forks', () => {
    const FORK_SHA = 'f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0';
    const fork = (over = {}) => promo({ number: 9, url: 'https://github.com/acme/app/pull/9', headRefOid: FORK_SHA, isCrossRepository: true, ...over });

    it('never merges an OPEN cross-repository PR on the promotion branch, even with Gearset QA passing', async () => {
      const { ctx, run } = setup({ rules: [[QA_LIST, list(fork())], [statusOf(FORK_SHA), QA_OK]] });
      const r = await run();
      expect(r).toMatchObject({ ok: false, code: 2, stage: 'gearset-promote-qa' });
      expect(r.reason).toContain('Gearset did not open the qa promotion pull request');
      expect(merges(ctx)).toEqual([]);
      expect(ctx.sh.calls).not.toContain(statusOf(FORK_SHA));
    });

    it("merges Gearset's own PR when a newer fork PR on the same branch name is listed first", async () => {
      const { ctx, run } = setup({ rules: [[QA_LIST, inTurn(list(fork(), promo()), list(fork(), merged()))], [statusOf(FORK_SHA), QA_OK], [statusOf(SHA), QA_OK], [MERGE_QA, ''], [sfFor('acme-qa'), rows(deployRow())]] });
      expect(await run()).toMatchObject({ ok: true, noReturn: true, gearsetPromotions: { qa: { prNumber: 2 } } });
      expect(merges(ctx)).toEqual([MERGE_QA]);
    });

    it('does not take a MERGED fork PR as the promotion on a re-run', async () => {
      const { ctx, run } = setup({ rules: [[QA_LIST, list(fork({ state: 'MERGED', mergedAt: MERGED_AT }))], [sfFor('acme-qa'), rows(deployRow())]] });
      expect(await run()).toMatchObject({ ok: false, code: 2 });
      expect(merges(ctx)).toEqual([]);
      expect(sfCalls(ctx)).toEqual([]);
    });

    it('ignores a PR whose origin gh does not report', async () => {
      const unknown = promo();
      delete unknown.isCrossRepository;
      const { ctx, run } = setup({ rules: [[QA_LIST, list(unknown)], [statusOf(SHA), QA_OK]] });
      expect(await run()).toMatchObject({ ok: false, code: 2 });
      expect(merges(ctx)).toEqual([]);
    });
  });

  describe('failures before the merge', () => {
    it('fails with code 2 and the description when Gearset QA validation fails, and merges nothing', async () => {
      const { ctx, run } = setup({ rules: [[QA_LIST, list(promo())], [statusOf(SHA), statuses(st('Gearset QA', 'failure', 'Validation failed: 3 component errors'))]] });
      expect(await run()).toEqual({ ok: false, code: 2, stage: 'gearset-promote-qa', reason: 'Gearset QA validation failed on pull request #2: Validation failed: 3 component errors' });
      expect(merges(ctx)).toEqual([]);
    });

    it('fails on an error state too, keeping the first 200 characters of the description', async () => {
      const { ctx, run } = setup({ rules: [[QA_LIST, list(promo())], [statusOf(SHA), statuses(st('Gearset QA', 'error', 'x'.repeat(300)))]] });
      const r = await run();
      expect(r).toMatchObject({ ok: false, code: 2 });
      expect(r.reason).toBe(`Gearset QA validation failed on pull request #2: ${'x'.repeat(200)}`);
      expect(merges(ctx)).toEqual([]);
    });

    it('fails with code 2 at ship.ci.timeoutMinutes when the promotion PR never appears', async () => {
      const { ctx, run } = setup({ rules: [[QA_LIST, list()]] });
      const r = await run();
      expect(r).toMatchObject({ ok: false, code: 2, stage: 'gearset-promote-qa' });
      expect(r.reason).toContain('Gearset did not open the qa promotion pull request (gs-pipeline/story/s-1_-_qa) within 2 minutes');
      expect(ctx.sleeps).toHaveLength(6);
      expect(merges(ctx)).toEqual([]);
    });

    it('fails with code 2 when the status never appears, or is still pending', async () => {
      const none = setup({ rules: [[QA_LIST, list(promo())], [statusOf(SHA), statuses(st('Gearset UAT', 'success'))]] });
      const r = await none.run();
      expect(r).toMatchObject({ ok: false, code: 2 });
      expect(r.reason).toContain('Gearset QA has not validated pull request #2 within 2 minutes');
      const pending = setup({ rules: [[QA_LIST, list(promo())], [statusOf(SHA), statuses(st('Gearset QA', 'pending'))]] });
      const p = await pending.run();
      expect(p).toMatchObject({ ok: false, code: 2 });
      expect(p.reason).toContain('Gearset QA validation did not finish within 2 minutes on pull request #2');
      expect(merges(pending.ctx)).toEqual([]);
    });

    it('is code 1 when gh pr merge fails and the PR is still OPEN', async () => {
      const { ctx, run } = setup({ rules: [[QA_LIST, list(promo())], [statusOf(SHA), QA_OK], [MERGE_QA, { status: 1, stderr: 'GraphQL: Head branch was modified. Review and try the merge again.' }]] });
      const r = await run();
      expect(r).toEqual({ ok: false, code: 1, stage: 'gearset-promote-qa', reason: 'Could not merge promotion pull request #2: GraphQL: Head branch was modified. Review and try the merge again.' });
      expect(r.noReturn).toBeUndefined();
      expect(sfCalls(ctx)).toEqual([]);
    });

    it('carries on when gh pr merge fails but the PR is MERGED after all', async () => {
      const { ctx, run } = setup({ rules: [[QA_LIST, inTurn(list(promo()), list(merged()))], [statusOf(SHA), QA_OK], [MERGE_QA, { status: 1, stderr: 'timeout' }], [sfFor('acme-qa'), rows(deployRow())]] });
      expect(await run()).toMatchObject({ ok: true, noReturn: true, gearsetPromotions: { qa: { via: 'org' } } });
      expect(merges(ctx)).toHaveLength(1);
    });
  });

  describe('confirming the deploy', () => {
    it('confirms through the Reporting API when the org shows nothing', async () => {
      const { ctx, fetch, run } = setup({ rules: qaMerges(rows()), routes: acmeGearset(acmeDeployments([acmeDeployment()])) });
      const r = await run();
      expect(r).toEqual({
        ok: true,
        noReturn: true,
        gearsetPromotions: { qa: { org: 'acme-qa', pr: PROMO, prNumber: 2, mergedAt: MERGED_AT, via: 'gearset', deployId: '0Af000000000009AAA', testsCompleted: null } },
      });
      const post = fetch.calls.find((c) => c.method === 'POST');
      expect(post.path).toBe(deploymentsOf({ from: '2026-10-15T11:55:30Z', to: '2026-10-15T12:00:00Z', pipelineId: 'pipe-1', environmentId: 'env-qa' }));
      for (const call of fetch.calls) expect(call.headers).toMatchObject({ Authorization: `token ${TOKEN}`, 'api-version': '3.0' });
      expect(fetch.calls.filter((c) => c.path === operationStatusOf('op-1'))).toHaveLength(1);
      expect(ctx.sleeps).toEqual([5000]);
    });

    it('fails with code 5 past the point of no return when the Reporting API lists the deploy as Failed', async () => {
      const { run } = setup({ rules: qaMerges(rows()), routes: acmeGearset(acmeDeployments([acmeDeployment({ Status: 'Failed' })])) });
      expect(await run()).toEqual({ ok: false, code: 5, stage: 'gearset-promote-qa', reason: "Gearset's deploy of pull request #2 to QA failed", noReturn: true });
    });

    it('fails with code 5 when nothing confirms the deploy by the deadline', async () => {
      const { run } = setup({ rules: qaMerges(rows(deployRow({ Status: 'Failed' }), deployRow({ CheckOnly: true }))), routes: acmeGearset(acmeDeployments([])) });
      const r = await run();
      expect(r).toMatchObject({ ok: false, code: 5, stage: 'gearset-promote-qa', noReturn: true });
      expect(r.reason).toContain('Gearset has not deployed pull request #2 to qa within 2 minutes');
      expect(r.reason).toContain('acme-qa shows no successful deploy');
    });

    it('does not count a deploy that finished before the merge', async () => {
      const { run } = setup({ rules: qaMerges(rows(deployRow({ CompletedDate: '2026-10-15T12:00:10.000+0000' }))), routes: acmeGearset(acmeDeployments([])) });
      expect(await run()).toMatchObject({ ok: false, code: 5 });
    });

    it('asks the Reporting API at most once every 3 minutes, and the org on every poll', async () => {
      const { ctx, fetch, run } = setup({ rules: qaMerges(rows()), routes: acmeGearset(acmeDeployments([])), ship: { ci: { timeoutMinutes: 10 } } });
      expect(await run()).toMatchObject({ ok: false, code: 5 });
      const posts = fetch.calls.filter((c) => c.method === 'POST' && c.path.startsWith(DEPLOYMENTS));
      expect(posts.length).toBeGreaterThanOrEqual(3);
      expect(posts.length).toBeLessThanOrEqual(4);
      expect(sfCalls(ctx).length).toBeGreaterThan(20);
    });

    it('warns when Gearset deployed with no Apex tests run', async () => {
      const { ctx, run } = setup({ rules: qaMerges(rows(deployRow({ NumberTestsCompleted: 0 }))) });
      expect(await run()).toMatchObject({ ok: true, gearsetPromotions: { qa: { testsCompleted: 0 } } });
      expect(ctx.events).toEqual([{ text: 'Gearset deployed qa with no Apex tests run; set a test level on its CI job', kind: 'warn' }]);
    });

    it('fails with code 5 at once past the point of no return on a login-rate answer, after a single query', async () => {
      const { ctx, run } = setup({ rules: qaMerges(sfError('X', 'login rate exceeded')), routes: acmeGearset(acmeDeployments([])) });
      const r = await run();
      expect(r).toMatchObject({ ok: false, code: 5, stage: 'gearset-promote-qa', noReturn: true });
      expect(r.reason).toMatch(/^Stopped watching the deploys in acme-qa \(qa\) for pull request #2: stopped at once:.*login rate exceeded/);
      expect(sfCalls(ctx)).toHaveLength(1);
      expect(ctx.sleeps).toEqual([]);
    });

    it('waits through an sf error and confirms on a later poll', async () => {
      const { ctx, run } = setup({ rules: qaMerges(inTurn(sfError('NoAuthInfoFound', 'No authorization information'), rows(deployRow()))), routes: acmeGearset(acmeDeployments([])) });
      expect(await run()).toMatchObject({ ok: true, gearsetPromotions: { qa: { via: 'org' } } });
      expect(ctx.sleeps).toContain(20_000);
    });
  });

  describe('stops before any gh call', () => {
    const before = async (opts, reason, stage = 'qa') => {
      const { ctx, run } = setup(opts);
      expect(await run(stage)).toEqual({ ok: false, code: 1, stage: `gearset-promote-${stage}`, reason });
      expect(ghCalls(ctx)).toEqual([]);
      expect(sfCalls(ctx)).toEqual([]);
      return ctx;
    };

    it('when GEARSET_API_TOKEN is missing', async () => {
      await before({ env: {} }, "GEARSET_API_TOKEN is not set; gearset-promote-qa reads stage qa's Gearset environment from the Gearset Reporting API");
    });
    it('when the Reporting API refuses the token', async () => {
      await before({ routes: acmeGearset({ [PIPELINES]: { status: 403, body: {} } }) }, "the Gearset Reporting API is not enabled for this token's team (Teams or Enterprise tier)");
    });
    it("when acme-qa is Gearset's production environment", async () => {
      await before({ routes: acmeGearset({ [environmentsOf('pipe-1')]: { status: 200, body: [acmeEnvironment('QA', ACME_QA_ID, 'Production')] } }) }, `${ACME_QA_ID} is Gearset's production environment; production is never a target`);
    });
    it('when the stage branch is productionBranch, with no Gearset call either', async () => {
      const salesforce = { ...block(), gearset: MERGE, stages: [{ name: 'qa', org: 'acme-qa', branch: 'main' }] };
      const { ctx, fetch, run } = setup({ salesforce });
      expect(await run()).toEqual({ ok: false, code: 1, stage: 'gearset-promote-qa', reason: 'Stage qa is on main, the production branch; production is never a target.' });
      expect(ghCalls(ctx)).toEqual([]);
      expect(sfCalls(ctx)).toEqual([]);
      expect(fetch.calls).toEqual([]);
    });
    it('when there is no such stage', async () => {
      await before({}, 'The salesforce block has no stage named stg.', 'stg');
    });
    it('when the stage follows another instead of having its own branch', async () => {
      const salesforce = { ...block(), gearset: MERGE, stages: [{ name: 'qa', org: 'acme-qa', branch: 'qa' }, { name: 'uat', org: 'acme-uat' }] };
      await before({ salesforce }, 'Stage uat has no branch of its own; Gearset promotes into an environment branch.', 'uat');
    });
    it('when the stage org has no org ID', async () => {
      const salesforce = { ...block(), gearset: MERGE, orgs: { ...block().orgs, 'acme-qa': {} } };
      await before({ salesforce }, 'The org acme-qa of stage qa has no org ID in salesforce.orgs.');
    });
  });

  describe('through the ship runner', () => {
    it('halts with code 5 when uat fails after qa merged and deployed', async () => {
      const { ctx } = setup({
        rules: [...qaMerges(), [UAT_LIST, list(promoUat())], [statusOf(SHA_UAT), statuses(st('Gearset UAT', 'failure', 'Validation failed'))]],
      });
      const { code, result } = await runShip({ steps: [gearsetPromote('qa'), gearsetPromote('uat')], ctx });
      expect(code).toBe(5);
      expect(result).toMatchObject({ stage: 'gearset-promote-uat', gearsetPromotions: { qa: { via: 'org' } } });
      expect(ctx.halts).toHaveLength(1);
      expect(merges(ctx)).toEqual([MERGE_QA]);
    });
  });

  it('merges by default, with no gearset key in the salesforce block', async () => {
    const { ctx, run } = setup({ rules: qaMerges(), gearset: null });
    expect(ctx.config.salesforce.gearset).toEqual({ promote: 'merge' });
    expect(await run()).toMatchObject({ ok: true, noReturn: true });
    expect(merges(ctx)).toEqual([MERGE_QA]);
  });
});

describe('owner mode: run', () => {
  const STAGES = [
    { name: 'qa', org: 'acme-qa', orgId: ACME_QA_ID, branch: 'qa' },
    { name: 'uat', org: 'acme-uat', orgId: ACME_UAT_ID, branch: 'uat' },
  ];

  it('parks the story with every stage through stopAt, and merges nothing', async () => {
    const { ctx, fetch, run } = setup({ gearset: OWNER, env: {}, rules: [[QA_LIST, list(promo())]] });
    const r = await run();
    expect(r).toEqual({
      ok: true,
      parked: {
        reason: 'Click Promote in Gearset for qa (pull request #2), then uat; the release finishes when Gearset has deployed it',
        check: { branch: 'story/s-1', stages: STAGES },
      },
    });
    expect(merges(ctx)).toEqual([]);
    expect(fetch.calls).toEqual([]);
    expect(JSON.parse(JSON.stringify(r.parked.check))).toEqual(r.parked.check);
  });

  it('names no pull request when Gearset has not opened it yet', async () => {
    const { run } = setup({ gearset: OWNER, rules: [[QA_LIST, list()]] });
    expect((await run()).parked.reason).toBe('Click Promote in Gearset for qa, then uat; the release finishes when Gearset has deployed it');
  });

  it('parks qa only when stopAt is qa', async () => {
    const { run } = setup({ salesforce: { ...block(), gearset: OWNER, stopAt: 'qa' }, rules: [[QA_LIST, list(promo())]] });
    const r = await run();
    expect(r.parked.check.stages).toEqual([STAGES[0]]);
    expect(r.parked.reason).toBe('Click Promote in Gearset for qa (pull request #2); the release finishes when Gearset has deployed it');
  });

  it('is code 1 when the stage comes after stopAt', async () => {
    const { run } = setup({ salesforce: { ...block(), gearset: OWNER, stopAt: 'qa' } });
    expect(await run('uat')).toMatchObject({ ok: false, code: 1, stage: 'gearset-promote-uat' });
  });

  it('is code 1 when a later stage up to stopAt cannot be promoted', async () => {
    const salesforce = { ...block(), gearset: OWNER, stages: [{ name: 'qa', org: 'acme-qa', branch: 'qa' }, { name: 'uat', org: 'acme-uat', branch: 'main' }] };
    const { ctx, run } = setup({ salesforce });
    expect(await run()).toMatchObject({ ok: false, code: 1, reason: expect.stringContaining('production') });
    expect(ghCalls(ctx)).toEqual([]);
  });

  it('through the ship runner: code 9, and the uat step never runs', async () => {
    const { ctx } = setup({ gearset: OWNER, rules: [[QA_LIST, list(promo())]] });
    const { code, result } = await runShip({ steps: [gearsetPromote('qa'), gearsetPromote('uat')], ctx });
    expect(code).toBe(9);
    expect(result).toMatchObject({ stage: 'parked', step: 'gearset-promote-qa', parked: { check: { branch: 'story/s-1', stages: STAGES } } });
    expect(ctx.sh.calls.some((l) => l.startsWith(UAT_LIST))).toBe(false);
    expect(ctx.halts).toEqual([]);
  });
});

describe('owner mode: check', () => {
  const STORED = {
    branch: 'story/s-1',
    stages: [
      { name: 'qa', org: 'acme-qa', orgId: ACME_QA_ID, branch: 'qa' },
      { name: 'uat', org: 'acme-uat', orgId: ACME_UAT_ID, branch: 'uat' },
    ],
  };
  const uatRow = (over = {}) => deployRow({ Id: '0Af000000000002AAA', CompletedDate: '2026-10-15T12:11:00.000+0000', ...over });

  function checking({ rules = [], routes, env = {}, salesforce, stored = STORED } = {}) {
    const s = setup({ gearset: OWNER, rules, routes, env, salesforce });
    s.ctx.check = JSON.parse(JSON.stringify(stored));
    const check = () => gearsetPromote('qa').check(s.ctx, { fetch: s.fetch });
    return { ...s, check };
  }
  const bothMerged = (qa = rows(deployRow()), uat = rows(uatRow())) => [
    [QA_LIST, list(merged())],
    [UAT_LIST, list(mergedUat())],
    [sfFor('acme-qa'), qa],
    [sfFor('acme-uat'), uat],
  ];

  it('waits for Gearset to open the promotion pull request', async () => {
    const { check } = checking({ rules: [[QA_LIST, list()]] });
    expect(await check()).toEqual({ ok: true, done: false, detail: 'waiting for Gearset to open the qa promotion pull request' });
  });

  it('waits for the Promote click while the PR is open', async () => {
    const { check } = checking({ rules: [[QA_LIST, list(promo())]] });
    expect(await check()).toEqual({ ok: true, done: false, detail: 'waiting for you to click Promote for qa in Gearset (pull request #2)' });
  });

  it('does not count a merged fork PR as the promotion', async () => {
    const fork = merged({ number: 9, url: 'https://github.com/acme/app/pull/9', isCrossRepository: true });
    const { ctx, check } = checking({ rules: [[QA_LIST, list(fork)], [sfFor('acme-qa'), rows(deployRow())]] });
    expect(await check()).toEqual({ ok: true, done: false, detail: 'waiting for Gearset to open the qa promotion pull request' });
    expect(sfCalls(ctx)).toEqual([]);
  });

  it('waits for uat once qa is merged and deployed', async () => {
    const { check } = checking({ rules: [[QA_LIST, list(merged())], [UAT_LIST, list(promoUat())], [sfFor('acme-qa'), rows(deployRow())]] });
    expect(await check()).toEqual({ ok: true, done: false, detail: 'waiting for you to click Promote for uat in Gearset (pull request #3)' });
  });

  it('is done when every stage is merged and deployed', async () => {
    const { ctx, fetch, check } = checking({ rules: bothMerged() });
    expect(await check()).toEqual({ ok: true, done: true, note: 'Gearset deployed qa (pull request #2) and uat (pull request #3)' });
    expect(merges(ctx)).toEqual([]);
    expect(fetch.calls).toEqual([]);
    expect(sfCalls(ctx).some((l) => l.includes('WHERE CreatedDate > 2026-10-15T12:10:00Z') && l.includes('--target-org acme-uat'))).toBe(true);
  });

  it('says when a stage ran no Apex tests', async () => {
    const { check } = checking({ rules: bothMerged(rows(deployRow()), rows(uatRow({ NumberTestsCompleted: 0 }))) });
    expect(await check()).toEqual({ ok: true, done: true, note: 'Gearset deployed qa (pull request #2) and uat (pull request #3), with no Apex tests run in uat' });
  });

  it('without a token uses only the org, and waits when it shows nothing', async () => {
    const { fetch, check } = checking({ rules: bothMerged(rows()) });
    const r = await check();
    expect(r).toMatchObject({ ok: true, done: false });
    expect(r.detail).toContain('waiting for Gearset to deploy pull request #2 to qa');
    expect(fetch.calls).toEqual([]);
  });

  it('with a token, a Successful Reporting API hit confirms what the org does not show', async () => {
    const deployments = [
      acmeDeployment(),
      acmeDeployment({ PipelineEnvironmentId: 'env-uat', SalesforceFinalDeploymentId: '0Af000000000008AAA', DeploymentPullRequests: [{ PullRequest: { Number: 3, EnvironmentBranchName: 'uat', MergedAt: '2026-10-15T12:10:00Z' } }] }),
    ];
    const { fetch, check } = checking({ rules: bothMerged(rows(), rows()), env: { GEARSET_API_TOKEN: TOKEN }, routes: acmeGearset(acmeDeployments(deployments)) });
    expect(await check()).toEqual({ ok: true, done: true, note: 'Gearset deployed qa (pull request #2) and uat (pull request #3)' });
    expect(fetch.calls.filter((c) => c.method === 'POST')).toHaveLength(2);
  });

  it('with a token and salesforce.gearset.pipelineId, reads only that pipeline', async () => {
    const deployments = [
      acmeDeployment(),
      acmeDeployment({ PipelineEnvironmentId: 'env-uat', SalesforceFinalDeploymentId: '0Af000000000008AAA', DeploymentPullRequests: [{ PullRequest: { Number: 3, EnvironmentBranchName: 'uat', MergedAt: '2026-10-15T12:10:00Z' } }] }),
    ];
    const salesforce = { ...block(), gearset: { promote: 'owner', pipelineId: 'pipe-1' } };
    const { fetch, check } = checking({ rules: bothMerged(rows(), rows()), env: { GEARSET_API_TOKEN: TOKEN }, routes: acmeTwoPipelines(acmeDeployments(deployments)), salesforce });
    expect(await check()).toEqual({ ok: true, done: true, note: 'Gearset deployed qa (pull request #2) and uat (pull request #3)' });
    expect(fetch.calls.filter((c) => c.path.startsWith('/public/reporting/environments')).map((c) => c.path)).toEqual([environmentsOf('pipe-1')]);
  });

  it('with a token, a Failed Reporting API hit fails the release', async () => {
    const { check } = checking({ rules: bothMerged(rows()), env: { GEARSET_API_TOKEN: TOKEN }, routes: acmeGearset(acmeDeployments([acmeDeployment({ Status: 'PartiallySuccessful' })])) });
    expect(await check()).toEqual({ ok: false, reason: "Gearset's deploy of pull request #2 to QA failed" });
  });

  it('refuses a stored org that is no longer in salesforce.orgs, or whose org ID changed, with no sf call', async () => {
    const gone = checking({ rules: bothMerged(), salesforce: { ...block(), gearset: OWNER, orgs: { 'acme-dev1': { orgId: ACME_DEV1_ID }, 'acme-uat': { orgId: ACME_UAT_ID } } } });
    expect(await gone.check()).toMatchObject({ ok: false, reason: expect.stringContaining('acme-qa') });
    expect(sfCalls(gone.ctx)).toEqual([]);

    const changed = checking({ rules: bothMerged(), stored: { ...STORED, stages: [{ ...STORED.stages[0], orgId: '00D000000000007AAA' }, STORED.stages[1]] } });
    expect(await changed.check()).toMatchObject({ ok: false, reason: expect.stringContaining('acme-qa') });
    expect(sfCalls(changed.ctx)).toEqual([]);
  });

  it('refuses a stored stage on the production branch', async () => {
    const { ctx, check } = checking({ rules: bothMerged(), stored: { ...STORED, stages: [{ ...STORED.stages[0], branch: 'main' }] } });
    expect(await check()).toMatchObject({ ok: false, reason: expect.stringContaining('production') });
    expect(sfCalls(ctx)).toEqual([]);
    expect(ghCalls(ctx)).toEqual([]);
  });

  it('waits with a detail when the sf query fails', async () => {
    const { check } = checking({ rules: bothMerged(sfError('NoAuthInfoFound', 'No authorization information for acme-qa')) });
    const r = await check();
    expect(r).toMatchObject({ ok: true, done: false });
    expect(r.detail).toContain('No authorization information for acme-qa');
  });

  it('never puts the token in a reason, detail or note', async () => {
    const secret = 't-acme-secret-77';
    const scenarios = [
      { rules: bothMerged(rows()), routes: acmeGearset(acmeDeployments([acmeDeployment({ Status: 'Failed' })])) },
      { rules: bothMerged(rows()), routes: acmeGearset({ [PIPELINES]: new Error(`refused ${secret}`) }) },
      { rules: bothMerged(rows()), routes: acmeGearset(acmeDeployments([], { status: { Status: 'Failed', Error: `bad ${secret}` } })) },
      { rules: bothMerged() },
      { rules: [[QA_LIST, list(promo())]] },
    ];
    for (const s of scenarios) {
      const { check } = checking({ ...s, env: { GEARSET_API_TOKEN: secret } });
      expect(JSON.stringify(await check())).not.toContain(secret);
    }
  });
});
