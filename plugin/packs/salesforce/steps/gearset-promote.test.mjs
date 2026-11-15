import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gearsetPromote } from './gearset-promote.mjs';
import gearsetPr from './gearset-pr.mjs';
import { runShip } from '../../../lib/engine/ship.mjs';
import { fakeCtx } from '../../../../test/ship-fakes.mjs';
import { ACME_DEV1_ID, ACME_QA_ID, ACME_UAT_ID, acmePlugins, orgRecord, orgRoute, sfError, sfOk, sfRaw } from '../../../../test/fake-sf.mjs';
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
  gearsetStatuses,
  operationStatusOf,
} from '../../../../test/fake-gearset.mjs';

const TOKEN = 't-acme';
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const SHA_UAT = 'c3d4e5f60718293a4b5c6d7e8f9012345678a1b2';
const PROMO = 'https://github.com/acme/app/pull/2';
const PROMO_UAT = 'https://github.com/acme/app/pull/3';
const MERGED_AT = '2026-10-15T12:00:30Z';
const DEPLOY = '0Af000000000001AAA';
const BASE = '0123456789abcdef0123456789abcdef01234567';

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

// package.xml or destructiveChanges.xml holding `types` ({ ApexClass: ['AcmeService'] }), as sgd writes it.
const manifest = (types = {}) =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
    ...Object.entries(types).map(([name, members]) => `  <types>\n${members.map((m) => `    <members>${m}</members>`).join('\n')}\n    <name>${name}</name>\n  </types>`),
    '  <version>62.0</version>',
    '</Package>',
    '',
  ].join('\n');

// The `sf sgd source delta` fake: writes the two manifests into the --output-dir on the line.
const sgd = ({ package: pkg, destructive }) => (line) => {
  const words = line.split(' ');
  const out = words[words.indexOf('--output-dir') + 1];
  fs.mkdirSync(path.join(out, 'package'), { recursive: true });
  fs.mkdirSync(path.join(out, 'destructiveChanges'), { recursive: true });
  fs.writeFileSync(path.join(out, 'package', 'package.xml'), manifest(pkg ?? {}));
  fs.writeFileSync(path.join(out, 'destructiveChanges', 'destructiveChanges.xml'), manifest(destructive ?? {}));
  return sfOk({ error: null, 'output-dir': out, success: true });
};
const sgdRules = (pkg) => [
  [/^sf plugins --core/, sfRaw(acmePlugins({ 'sfdx-git-delta': '6.45.1' }))],
  [/^git merge-base /, `${BASE}\n`],
  [/^sf sgd source delta /, sgd({ package: pkg })],
];

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

  it('is a gh, sf and git step that needs the Gearset token, halts, deploys and may pass the point of no return', () => {
    const qa = gearsetPromote('qa');
    expect(qa).toMatchObject({
      name: 'gearset-promote-qa',
      label: 'promoting to qa through Gearset',
      needs: ['gh', 'sf', 'git'],
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
      gearsetPromotions: { qa: { org: 'acme-qa', pr: PROMO, prNumber: 2, mergedAt: MERGED_AT, via: 'org', deployId: DEPLOY, testsCompleted: 12, validatedBy: 'gearset' } },
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

    it('parks, with no nudge, when the status never appears before the deadline; fails with code 2 when it is still pending', async () => {
      const none = setup({ rules: [[QA_LIST, list(promo())], [statusOf(SHA), statuses(st('Gearset UAT', 'success'))]] });
      const r = await none.run();
      expect(r).toMatchObject({ ok: true, parked: { check: { branch: 'story/s-1', mode: 'merge' } } });
      expect(r.parked.reason).toContain('Run validation on pull request #2');
      expect(r.noStatus).toBeUndefined();
      expect(none.ctx.sleeps).toHaveLength(6);
      expect(none.ctx.sh.calls.some((l) => l.startsWith('gh api -X'))).toBe(false);
      expect(merges(none.ctx)).toEqual([]);
      const pending = setup({ rules: [[QA_LIST, list(promo())], [statusOf(SHA), statuses(st('Gearset QA', 'pending'))]] });
      const p = await pending.run();
      expect(p).toMatchObject({ ok: false, code: 2 });
      expect(p.reason).toContain('Gearset QA validation did not finish within 2 minutes on pull request #2');
      expect(p.noStatus).toBeUndefined();
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
        gearsetPromotions: { qa: { org: 'acme-qa', pr: PROMO, prNumber: 2, mergedAt: MERGED_AT, via: 'gearset', deployId: '0Af000000000009AAA', testsCompleted: null, validatedBy: 'gearset' } },
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

  describe('a Gearset rate limit', () => {
    const limited = (seconds) => ({ status: 429, body: {}, headers: { 'Retry-After': String(seconds) } });
    const START = Date.UTC(2026, 9, 15, 12, 0, 0);
    const envs = acmeGearset()[environmentsOf('pipe-1')];

    it('on the environments read waits the time Gearset names, says so, and merges as before', async () => {
      const { ctx, run } = setup({ rules: qaMerges(), routes: acmeGearset({ [environmentsOf('pipe-1')]: inTurn(limited(2), envs) }) });
      expect(await run()).toMatchObject({ ok: true, noReturn: true });
      expect(ctx.sleeps[0]).toBe(2000);
      expect(ctx.events.find((e) => e.kind === 'info').text).toMatch(/Gearset rate-limited gearset-promote-qa; waiting 2 seconds, as Gearset asked/);
      expect(merges(ctx)).toEqual([MERGE_QA]);
    });

    it('on the environments read that would pass the step limit is code 1 with the time, and merges nothing', async () => {
      const { ctx, run } = setup({ rules: qaMerges(), routes: acmeGearset({ [environmentsOf('pipe-1')]: limited(675) }) });
      const retryAt = new Date(START + 675_000).toISOString();
      const r = await run();
      expect(r).toMatchObject({ ok: false, code: 1, stage: 'gearset-promote-qa', rateLimited: true, retryAt });
      expect(r.reason).toBe(`Gearset rate-limited gearset-promote-qa until ${retryAt}, past the step's limit of 2 minutes; try the release again after ${retryAt}.`);
      expect(merges(ctx)).toEqual([]);
      expect(ghCalls(ctx)).toEqual([]);
      expect(ctx.sleeps).toEqual([]);
    });

    it("on the deploys Gearset lists after the merge asks again only when Gearset says, and still ends with code 5", async () => {
      const { ctx, fetch, run } = setup({
        rules: qaMerges(rows()),
        routes: acmeGearset({ [DEPLOYMENTS]: limited(600) }),
        ship: { ci: { timeoutMinutes: 15 } },
      });
      const r = await run();
      expect(r).toMatchObject({ ok: false, code: 5, stage: 'gearset-promote-qa', noReturn: true });
      expect(r.reason).toContain('within 15 minutes of the merge');
      const posts = fetch.calls.filter((c) => c.method === 'POST' && c.path.startsWith(DEPLOYMENTS));
      expect(posts).toHaveLength(2);
      expect(ctx.events.some((e) => e.kind === 'info' && /Gearset rate-limited gearset-promote-qa; asking it about the deploy again after /.test(e.text))).toBe(true);
    });

    it('a huge Retry-After on the environments read is capped at a day: code 1 with the time, and merges nothing', async () => {
      const { ctx, run } = setup({ rules: qaMerges(), routes: acmeGearset({ [environmentsOf('pipe-1')]: limited('99999999999999999999999') }) });
      expect(await run()).toMatchObject({ ok: false, code: 1, stage: 'gearset-promote-qa', rateLimited: true, retryAt: new Date(START + 86_400_000).toISOString() });
      expect(merges(ctx)).toEqual([]);
      expect(ghCalls(ctx)).toEqual([]);
      expect(ctx.sleeps).toEqual([]);
    });

    it('a huge Retry-After on the deploys listed after the merge does not throw: code 5 with noReturn, and asks once', async () => {
      const { ctx, fetch, run } = setup({
        rules: qaMerges(rows()),
        routes: acmeGearset({ [DEPLOYMENTS]: limited('99999999999999999999999') }),
        ship: { ci: { timeoutMinutes: 10 } },
      });
      const r = await run();
      expect(r).toMatchObject({ ok: false, code: 5, stage: 'gearset-promote-qa', noReturn: true });
      expect(r.reason).toContain('within 10 minutes of the merge');
      expect(r.reason).not.toContain('Invalid time value');
      expect(fetch.calls.filter((c) => c.method === 'POST' && c.path.startsWith(DEPLOYMENTS))).toHaveLength(1);
      expect(ctx.events.some((e) => e.kind === 'info' && /asking it about the deploy again after \d{4}-\d{2}-\d{2}T/.test(e.text))).toBe(true);
    });

    it('on the deploys Gearset lists with no time named keeps the 3 minute spacing and says nothing', async () => {
      const { ctx, fetch, run } = setup({ rules: qaMerges(rows()), routes: acmeGearset({ [DEPLOYMENTS]: { status: 429, body: {} } }), ship: { ci: { timeoutMinutes: 10 } } });
      expect(await run()).toMatchObject({ ok: false, code: 5 });
      expect(fetch.calls.filter((c) => c.method === 'POST')).toHaveLength(4);
      expect(ctx.events.filter((e) => e.kind === 'info')).toEqual([]);
    });
  });

  describe('one release with two stages', () => {
    it('reads the pipeline environments once for gearset-pr, gearset-promote-qa and gearset-promote-uat', async () => {
      const { ctx, fetch } = setup({
        rules: [
          [/^gh pr list --head gs-pipeline\/story\/s-1_-_qa --base qa --state all --json number,url,state,headRefOid$/, list(promo())],
          ...qaMerges(),
          [UAT_LIST, inTurn(list(promoUat()), list(mergedUat()))],
          [statusOf(SHA_UAT), UAT_OK],
          [MERGE_UAT, ''],
          [sfFor('acme-uat'), rows(deployRow({ CompletedDate: '2026-10-15T12:11:00.000+0000' }))],
        ],
      });
      expect(await gearsetPr.run(ctx, { fetch, raiseStoryEvent: () => ({ ok: true }) })).toMatchObject({ ok: true, prNumber: 2 });
      expect(await gearsetPromote('qa').run(ctx, { fetch })).toMatchObject({ ok: true, noReturn: true });
      expect(await gearsetPromote('uat').run(ctx, { fetch })).toMatchObject({ ok: true, noReturn: true });
      expect(fetch.calls.filter((c) => c.path.startsWith('/public/reporting/environments'))).toHaveLength(1);
      expect(fetch.calls.filter((c) => c.path === PIPELINES)).toHaveLength(1);
      expect(merges(ctx)).toEqual([MERGE_QA, MERGE_UAT]);
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

describe('a promotion PR Gearset never validates', () => {
  const OLD_SHA = 'b2c3d4e5f60718293a4b5c6d7e8f9012345678a1';
  const NEW_SHA = 'd4e5f60718293a4b5c6d7e8f9012345678a1b2c3';
  const TREE = 'e5f60718293a4b5c6d7e8f9012345678a1b2c3d4';
  const HEAD_UAT = 'gs-pipeline/story/s-1_-_uat';
  const COMMITS = 'gh api repos/{owner}/{repo}/pulls/3/commits';
  const CREATE = 'gh api -X POST repos/{owner}/{repo}/git/commits';
  const PATCH = `gh api -X PATCH repos/{owner}/{repo}/git/refs/heads/${HEAD_UAT}`;
  const START = Date.UTC(2026, 9, 15, 12, 0, 0);
  const NUDGING = { promote: 'merge', nudgeMinutes: 1, validateLaterStages: 'gearset' };
  // Gearset makes a validation job for each pull request; its id is in the target_url of the
  // status an earlier commit of that PR carries. It is not the environment's CI job id (job-uat).
  const JOB_URL = 'https://app.gearset.com/continuous-integration-runs?jobId=job-val-3';
  const REASON = 'Gearset has not started validating pull request #3 for uat. In Gearset, open the pipeline, select the UAT environment and press Run validation on pull request #3; Foreman merges it when Gearset UAT passes, and the release finishes when Gearset has deployed it.';
  const UAT_STAGE = { name: 'uat', org: 'acme-uat', orgId: ACME_UAT_ID, branch: 'uat' };
  const deployed = [sfFor('acme-uat'), rows(deployRow({ CompletedDate: '2026-10-15T12:11:00.000+0000' }))];
  const patches = (ctx) => ctx.sh.calls.filter((l) => l.startsWith('gh api -X PATCH'));
  const automation = (fetch) => fetch.calls.filter((c) => c.path.startsWith('/public/automation/'));

  // The calls that push an empty commit, with the time each PATCH was made.
  const pushRules = (holder, { patch = '', at = [] } = {}) => [
    [`gh api repos/{owner}/{repo}/git/commits/${SHA_UAT}`, `${TREE}\n`],
    [CREATE, `${NEW_SHA}\n`],
    [PATCH, () => { at.push(holder.ctx.now().getTime()); return patch; }],
  ];
  const nudging = (opts = {}) => {
    const holder = {};
    const s = setup({ gearset: NUDGING, ship: { ci: { timeoutMinutes: 30 } }, ...opts, rules: opts.rules ? opts.rules(holder) : [] });
    holder.ctx = s.ctx;
    return s;
  };
  const never = (holder, over = {}) => [[UAT_LIST, list(promoUat())], [statusOf(SHA_UAT), statuses(st('Gearset QA', 'success'))], ...pushRules(holder, over)];

  it('nudges once with an empty commit after the delay, and merges the new head once its status arrives', async () => {
    const at = [];
    const { ctx, fetch, run } = nudging({
      rules: (holder) => [
        [UAT_LIST, inTurn(list(promoUat()), list(promoUat()), list(promoUat()), list(promoUat()), list(promoUat({ headRefOid: NEW_SHA })), list(mergedUat({ headRefOid: NEW_SHA })))],
        [statusOf(SHA_UAT), statuses(st('Gearset QA', 'success'))],
        [statusOf(NEW_SHA), UAT_OK],
        [`gh pr merge 3 --merge --match-head-commit ${NEW_SHA}`, ''],
        deployed,
        ...pushRules(holder, { at }),
      ],
    });
    const r = await run('uat');
    expect(r).toMatchObject({ ok: true, noReturn: true, gearsetPromotions: { uat: { prNumber: 3, via: 'org' } } });
    expect(patches(ctx)).toEqual([`${PATCH} -f sha=${NEW_SHA} -F force=false`]);
    expect(at).toHaveLength(1);
    expect(at[0]).toBeGreaterThanOrEqual(START + 60_000);
    expect(ctx.sh.calls.filter((l) => l.startsWith(CREATE))[0]).toContain(`parents[]=${SHA_UAT}`);
    expect(merges(ctx)).toEqual([`gh pr merge 3 --merge --match-head-commit ${NEW_SHA}`]);
    expect(ctx.events.some((e) => e.kind === 'info' && /pushed an empty commit to gs-pipeline\/story\/s-1_-_uat .*\(nudge 1 of 2\)/.test(e.text))).toBe(true);
    expect(automation(fetch)).toEqual([]);
    expect(ctx.sh.calls.some((l) => l.startsWith(COMMITS))).toBe(false);
    for (const line of ctx.sh.calls) for (const flag of FORBIDDEN) expect(line).not.toContain(flag);
  });

  it('parks the story with the plain task after two nudges, and merges nothing', async () => {
    // Gearset posts nothing on a later stage's PR, whatever is pushed to it.
    const { ctx, run } = nudging({ rules: (holder) => [[UAT_LIST, list(promoUat())], gearsetStatuses({ [SHA_UAT]: { environment: 'UAT' } }), ...pushRules(holder)] });
    const r = await run('uat');
    expect(r).toEqual({ ok: true, parked: { reason: REASON, check: { branch: 'story/s-1', mode: 'merge', stages: [UAT_STAGE] } } });
    expect(patches(ctx)).toHaveLength(2);
    expect(ctx.sleeps).toHaveLength(9);
    expect(merges(ctx)).toEqual([]);
    for (const c of ['{', '"', '`', '$']) expect(r.parked.reason).not.toContain(c);
    expect(r.parked.reason).toContain('Run validation');
    expect(r.parked.reason).toContain('#3');
    expect(JSON.parse(JSON.stringify(r.parked.check))).toEqual(r.parked.check);
    expect(ctx.events.some((e) => e.kind === 'warn' && /has not validated pull request #3 after 2 nudges/.test(e.text))).toBe(true);
  });

  // The park reason goes into a double-quoted `story end` argument, and a Gearset environment name
  // is whatever a Gearset admin typed.
  describe('a Gearset environment named with shell characters', () => {
    const HOSTILE = 'Acme "UAT" $(x) `y` {z} \\w';
    const hostileRoutes = () => acmeGearset({ [environmentsOf('pipe-1')]: { status: 200, body: [acmeEnvironment('QA', ACME_QA_ID), acmeEnvironment(HOSTILE, ACME_UAT_ID, 'Release')] } });

    it('parks with a reason and a warn event that carry none of those characters', async () => {
      const { ctx, run } = nudging({ routes: hostileRoutes(), rules: (holder) => never(holder) });
      const r = await run('uat');
      expect(r.parked.reason).toBe('Gearset has not started validating pull request #3 for uat. In Gearset, open the pipeline, select the Acme UAT (x) y z w environment and press Run validation on pull request #3; Foreman merges it when Gearset Acme UAT (x) y z w passes, and the release finishes when Gearset has deployed it.');
      const warn = ctx.events.find((e) => e.kind === 'warn' && /has not validated pull request #3 after 2 nudges/.test(e.text));
      expect(warn).toBeDefined();
      for (const c of ['"', '`', '$', '{', '}', '\\']) {
        expect(r.parked.reason).not.toContain(c);
        expect(warn.text).not.toContain(c);
      }
      expect(patches(ctx)).toHaveLength(2);
      expect(merges(ctx)).toEqual([]);
    });

    it('still merges on a status posted under the raw name', async () => {
      const { ctx, run } = nudging({
        routes: hostileRoutes(),
        rules: () => [
          [UAT_LIST, inTurn(list(promoUat()), list(mergedUat()))],
          [statusOf(SHA_UAT), statuses(st(`Gearset ${HOSTILE}`, 'success'))],
          [MERGE_UAT, ''],
          deployed,
        ],
      });
      expect(await run('uat')).toMatchObject({ ok: true, noReturn: true });
      expect(merges(ctx)).toEqual([MERGE_UAT]);
    });
  });

  it('names the stages still to promote in the park of the first stage', async () => {
    const { run } = setup({
      gearset: NUDGING,
      ship: { ci: { timeoutMinutes: 30 } },
      rules: [[QA_LIST, list(promo())], [statusOf(SHA), statuses()]],
    });
    const r = await run('qa');
    expect(r.parked.reason).toBe('Gearset has not started validating pull request #2 for qa. In Gearset, open the pipeline, select the QA environment and press Run validation on pull request #2; Foreman merges it when Gearset QA passes, then promotes uat, and the release finishes when Gearset has deployed it. Gearset never validates a later stage by itself, so press Run validation on the promotion pull request of uat too once Gearset opens it.');
    expect(r.parked.check.stages.map((s) => s.name)).toEqual(['qa', 'uat']);
    for (const c of ['{', '}', '"', '`', '$', '\\']) expect(r.parked.reason).not.toContain(c);
  });

  it('through the ship runner is code 9 with no halt, and the ship lock is released', async () => {
    const { ctx } = nudging({ rules: (holder) => [...qaMerges(), ...never(holder)] });
    const { code, result } = await runShip({ steps: [gearsetPromote('qa'), gearsetPromote('uat')], ctx });
    expect(code).toBe(9);
    expect(result).toMatchObject({ stage: 'parked', step: 'gearset-promote-uat', gearsetPromotions: { qa: { via: 'org' } }, parked: { reason: REASON } });
    expect(ctx.halts).toEqual([]);
    expect(ctx.locks.holderOf('ship')).toBeNull();
    expect(patches(ctx)).toHaveLength(2);
  });

  // Gearset's per-PR validation job id, read from an earlier commit's status, is never used: a
  // commit status is anyone's to post, and the id is in no API that could confirm it. The nudge
  // is the push, whatever the earlier statuses carry.
  describe('a job id in an earlier commit status', () => {
    const earlier = (url, routes = {}) => {
      const at = [];
      return nudging({
        routes: acmeGearset(routes),
        rules: (holder) => [
          [UAT_LIST, inTurn(list(promoUat()), list(promoUat()), list(promoUat()), list(promoUat()), list(promoUat()), list(mergedUat()))],
          [statusOf(SHA_UAT), inTurn(statuses(), statuses(), statuses(), statuses(), UAT_OK)],
          [statusOf(OLD_SHA), statuses({ ...st('Gearset UAT', 'success'), target_url: url })],
          [COMMITS, JSON.stringify([OLD_SHA, SHA_UAT])],
          [MERGE_UAT, ''],
          deployed,
          ...pushRules(holder, { at }),
        ],
      });
    };

    it('is not used: a per-PR job id, as Gearset posts it, leads to a push and no Automation API call', async () => {
      const { ctx, fetch, run } = earlier(JOB_URL);
      expect(await run('uat')).toMatchObject({ ok: true, noReturn: true });
      expect(automation(fetch)).toEqual([]);
      expect(patches(ctx)).toHaveLength(1);
      expect(ctx.events.some((e) => e.kind === 'info' && /pushed an empty commit/.test(e.text))).toBe(true);
      expect(ctx.events.some((e) => /validation job/.test(e.text))).toBe(false);
      expect(JSON.stringify(ctx.events)).not.toContain('job-val-3');
      expect(merges(ctx)).toEqual([MERGE_UAT]);
    });

    it('is not used even when it is the environment\'s own CI job (that job deploys the branch): it pushes', async () => {
      const { ctx, fetch, run } = earlier('https://app.gearset.com/continuous-integration-runs?jobId=job-uat');
      expect(await run('uat')).toMatchObject({ ok: true, noReturn: true });
      expect(automation(fetch)).toEqual([]);
      expect(patches(ctx)).toHaveLength(1);
    });

    it('is not used from another host: it pushes', async () => {
      const { ctx, fetch, run } = earlier('https://evil.example/x?jobId=job-val-3');
      expect(await run('uat')).toMatchObject({ ok: true, noReturn: true });
      expect(automation(fetch)).toEqual([]);
      expect(patches(ctx)).toHaveLength(1);
    });
  });

  it('warns when the push fails, counts it as a nudge, and still parks after exactly two', async () => {
    const { ctx, run } = nudging({ rules: (holder) => never(holder, { patch: { status: 1, stderr: 'gh: Update is not a fast forward (HTTP 422)' } }) });
    const r = await run('uat');
    expect(r).toMatchObject({ ok: true, parked: { reason: REASON } });
    expect(patches(ctx)).toHaveLength(2);
    const warns = ctx.events.filter((e) => e.kind === 'warn' && e.text.startsWith('Could not nudge Gearset on pull request #3: '));
    expect(warns).toHaveLength(2);
    expect(warns[0].text).toContain('not a fast forward');
  });

  it('warns and counts a nudge when the commit cannot be made', async () => {
    const { ctx, run } = nudging({ rules: () => [[UAT_LIST, list(promoUat())], [statusOf(SHA_UAT), statuses()], [`gh api repos/{owner}/{repo}/git/commits/${SHA_UAT}`, { status: 1, stderr: 'HTTP 404' }]] });
    const r = await run('uat');
    expect(r).toMatchObject({ ok: true, parked: { reason: REASON } });
    expect(patches(ctx)).toEqual([]);
    expect(ctx.events.filter((e) => e.kind === 'warn' && e.text.startsWith('Could not nudge Gearset')).length).toBe(2);
  });

  it('never nudges before the delay: the deadline first parks with no push', async () => {
    const { ctx, run } = setup({ gearset: { ...MERGE, validateLaterStages: 'gearset' }, ship: { ci: { timeoutMinutes: 2 } }, rules: [[UAT_LIST, list(promoUat())], [statusOf(SHA_UAT), statuses()]] });
    const r = await run('uat');
    expect(r).toMatchObject({ ok: true, parked: { reason: REASON } });
    expect(ctx.sh.calls.some((l) => l.startsWith('gh api -X'))).toBe(false);
    expect(ctx.sleeps).toHaveLength(6);
  });

  it('does not nudge when a status is pending, and fails with code 2 at the deadline as before', async () => {
    const { ctx, run } = nudging({ ship: { ci: { timeoutMinutes: 5 } }, rules: (holder) => [[UAT_LIST, list(promoUat())], [statusOf(SHA_UAT), statuses(st('Gearset UAT', 'pending'))], ...pushRules(holder)] });
    expect(await run('uat')).toMatchObject({ ok: false, code: 2 });
    expect(patches(ctx)).toEqual([]);
  });

  it('keeps the code-2 failure for a promotion PR that never appears', async () => {
    const { ctx, run } = nudging({ rules: () => [[UAT_LIST, list()]] });
    expect(await run('uat')).toMatchObject({ ok: false, code: 2 });
    expect(patches(ctx)).toEqual([]);
  });

  // Gearset never validates a pull request into a later stage by itself, so with the default
  // setting Foreman does the check-only deploy against the stage's org and merges that head.
  describe('a later stage Gearset never validates (validateLaterStages foreman, the default)', () => {
    const DRY_JOB = '0Af000000000002AAA';
    const QUIET_MS = 5 * 60_000;
    const heads = { [SHA]: { environment: 'QA', first: true }, [SHA_UAT]: { environment: 'UAT' } };
    const dryRun = (status, details = {}) => ({ id: DRY_JOB, status, numberComponentsDeployed: 2, numberComponentsTotal: 2, numberTestsCompleted: 5, numberTestErrors: details.runTestResult ? 1 : 0, details });
    const FAILED_RUN = { componentFailures: { componentType: 'ApexClass', fullName: 'AcmeService', problem: 'Variable does not exist: total', lineNumber: '14' } };
    const startsOf = (ctx) => ctx.sh.calls.filter((l) => l.startsWith('sf project deploy start'));
    const uatInfo = (ctx) => ctx.events.filter((e) => e.kind === 'info').map((e) => e.text);

    let state;
    beforeEach(() => {
      state = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-gspromote-state-'));
    });
    afterEach(() => {
      fs.rmSync(state, { recursive: true, force: true });
    });

    // qa merges (Gearset validates it) and uat gets no status; Foreman's dry run is `report`, of
    // the pull request's own sgd delta `pkg`. `over` rules come first and so win. `at` holds the
    // clock when each dry run started, `manifests` the manifest text each one deployed.
    function scenario({ over = [], gearset = { promote: 'merge' }, ship = { ci: { timeoutMinutes: 30 } }, report = sfOk(dryRun('Succeeded')), org = orgRecord(ACME_UAT_ID), pkg = { ApexClass: ['AcmeService'] }, salesforce, merge = '' } = {}) {
      const holder = {};
      const at = [];
      const manifests = [];
      const s = setup({
        gearset,
        salesforce,
        ship,
        env: { GEARSET_API_TOKEN: TOKEN, FOREMAN_STATE_DIR: state },
        rules: [
          ...over,
          [QA_LIST, inTurn(list(promo()), list(merged()))],
          [UAT_LIST, (line, calls) => (calls.includes(MERGE_UAT) ? list(mergedUat()) : list(promoUat()))],
          gearsetStatuses(heads),
          [MERGE_QA, ''],
          [MERGE_UAT, merge],
          [new RegExp(orgRoute('acme-uat')), org],
          ...sgdRules(pkg),
          [/^sf project deploy start /, (line) => {
            at.push(holder.ctx.now().getTime());
            const words = line.split(' ');
            manifests.push(fs.readFileSync(words[words.indexOf('--manifest') + 1], 'utf8'));
            return sfOk({ id: DRY_JOB, done: false, status: 'Queued' });
          }],
          [/^sf project deploy report /, report],
          [sfFor('acme-qa'), rows(deployRow())],
          [sfFor('acme-uat'), rows(deployRow({ Id: '0Af000000000003AAA', CompletedDate: '2026-10-15T12:11:00.000+0000' }))],
        ],
      });
      holder.ctx = s.ctx;
      s.at = at;
      s.manifests = manifests;
      return s;
    }
    const ship = (ctx) => runShip({ steps: [gearsetPromote('qa'), gearsetPromote('uat')], ctx });

    it('validates the head against acme-uat itself, merges it and confirms the deploy: no nudge, no park, no halt, no owner task', async () => {
      const { ctx, fetch, at } = scenario();
      const { code, result } = await ship(ctx);
      expect(code).toBe(0);
      expect(result).not.toHaveProperty('parked');
      expect(ctx.halts).toEqual([]);
      expect(merges(ctx)).toEqual([MERGE_QA, MERGE_UAT]);
      expect(ctx.sh.calls.some((l) => l.startsWith('gh api -X'))).toBe(false);
      expect(fetch.calls.filter((c) => c.path.startsWith('/public/automation/'))).toEqual([]);

      const [start] = startsOf(ctx);
      expect(startsOf(ctx)).toHaveLength(1);
      expect(start).toContain('--dry-run');
      expect(start).toContain('--target-org acme-uat');
      expect(start).toContain('--test-level RunLocalTests');
      expect(ctx.sh.calls.filter((l) => l.startsWith('sf sgd source delta')).map((l) => l.split(' ').slice(4, 8).join(' '))).toEqual([`--from ${BASE} --to ${SHA_UAT}`]);
      expect(at[0]).toBeGreaterThanOrEqual(START + QUIET_MS);
      // The merge is after the dry run, and the deploy confirmation after the merge.
      const calls = ctx.sh.calls;
      expect(calls.findIndex((l) => l.startsWith('sf project deploy start'))).toBeLessThan(calls.indexOf(MERGE_UAT));
      expect(calls.indexOf(MERGE_UAT)).toBeLessThan(calls.findIndex((l) => sfFor('acme-uat').test(l)));

      expect(result.gearsetPromotions.qa).toMatchObject({ validatedBy: 'gearset', via: 'org' });
      expect(result.gearsetPromotions.uat).toMatchObject({
        org: 'acme-uat',
        prNumber: 3,
        via: 'org',
        deployId: '0Af000000000003AAA',
        validatedBy: 'foreman',
        validation: { jobId: DRY_JOB, components: { deployed: 2, total: 2 }, tests: { completed: 5, errors: 0 } },
      });
      const told = uatInfo(ctx);
      expect(told).toContain('Gearset posted no Gearset UAT status on pull request #3 after 5 minutes, as it does not validate a later stage by itself; Foreman is validating it against acme-uat (uat) instead.');
      expect(told).toContain(`Foreman, not Gearset, validated pull request #3 against acme-uat (uat): job ${DRY_JOB}, 5 tests run; merging it.`);
      for (const line of calls) for (const flag of FORBIDDEN) expect(line).not.toContain(flag);
    });

    it('dry-runs another queued change the pull request carries, not only the story delta', async () => {
      const { ctx, run, manifests } = scenario({ pkg: { ApexClass: ['AcmeService', 'AcmeOther'] } });
      const r = await run('uat');
      expect(r).toMatchObject({ ok: true, noReturn: true, gearsetPromotions: { uat: { validatedBy: 'foreman', validation: { jobId: DRY_JOB } } } });
      expect(manifests).toHaveLength(1);
      expect(manifests[0]).toContain('AcmeOther');
      expect(merges(ctx)).toEqual([MERGE_UAT]);
    });

    it('stops the release when the dry run fails: only qa is merged, the uat pull request is not', async () => {
      const { ctx } = scenario({ report: sfOk(dryRun('Failed', FAILED_RUN)) });
      const { code, result } = await ship(ctx);
      expect(code).toBe(5);
      expect(result.stage).toBe('gearset-promote-uat');
      expect(result.reason.startsWith("Foreman's validation of pull request #3 on acme-uat (uat) failed")).toBe(true);
      expect(result.failures).toHaveLength(1);
      expect(result.validatedBy).toBe('foreman');
      expect(result.gearsetPromotions.qa).toMatchObject({ validatedBy: 'gearset' });
      expect(merges(ctx)).toEqual([MERGE_QA]);
      expect(ctx.halts).toHaveLength(1);
    });

    it('is code 2 with nothing merged when the uat step runs alone and the dry run fails', async () => {
      const { ctx, run } = scenario({ report: sfOk(dryRun('Failed', FAILED_RUN)) });
      const r = await run('uat');
      expect(r).toMatchObject({ ok: false, code: 2, stage: 'gearset-promote-uat', validatedBy: 'foreman' });
      expect(r.failures).toHaveLength(1);
      expect(merges(ctx)).toEqual([]);
      expect(ctx.sh.calls.some((l) => sfFor('acme-uat').test(l))).toBe(false);
    });

    it('validates and merges when the deadline comes before the quiet window, with no park', async () => {
      const { ctx, run } = scenario({ ship: { ci: { timeoutMinutes: 2 } } });
      const r = await run('uat');
      expect(r).toMatchObject({ ok: true, noReturn: true, gearsetPromotions: { uat: { validatedBy: 'foreman' } } });
      expect(r).not.toHaveProperty('parked');
      expect(startsOf(ctx)).toHaveLength(1);
      expect(merges(ctx)).toEqual([MERGE_UAT]);
      expect(ctx.sh.calls.some((l) => l.startsWith('gh api -X'))).toBe(false);
    });

    it('does not validate when Gearset posts a success on the head: it merges, validatedBy gearset', async () => {
      const { ctx, run } = scenario({ over: [[statusOf(SHA_UAT), UAT_OK]] });
      const r = await run('uat');
      expect(r).toMatchObject({ ok: true, noReturn: true, gearsetPromotions: { uat: { validatedBy: 'gearset' } } });
      expect(r.gearsetPromotions.uat).not.toHaveProperty('validation');
      expect(startsOf(ctx)).toEqual([]);
      expect(merges(ctx)).toEqual([MERGE_UAT]);
    });

    it('does not validate when Gearset posts a failure: code 2, no dry run, nothing merged', async () => {
      const { ctx, run } = scenario({ over: [[statusOf(SHA_UAT), statuses(st('Gearset UAT', 'failure', 'Validation failed'))]] });
      expect(await run('uat')).toEqual({ ok: false, code: 2, stage: 'gearset-promote-uat', reason: 'Gearset UAT validation failed on pull request #3: Validation failed' });
      expect(startsOf(ctx)).toEqual([]);
      expect(merges(ctx)).toEqual([]);
    });

    it("lets Gearset's status win when it turns to failure on the validated head after Foreman passed: code 2, nothing merged", async () => {
      const failing = statuses(st('Gearset UAT', 'failure', 'Validation failed'));
      const { ctx, run } = scenario({ over: [[statusOf(SHA_UAT), (line, calls) => (calls.some((l) => l.startsWith('sf project deploy start')) ? failing : statuses())]] });
      const r = await run('uat');
      expect(r).toMatchObject({ ok: false, code: 2, stage: 'gearset-promote-uat', reason: 'Gearset UAT validation failed on pull request #3: Validation failed' });
      expect(startsOf(ctx)).toHaveLength(1);
      expect(merges(ctx)).toEqual([]);
    });

    it('merges only the validated head: gh refuses when it moved, and nothing is merged', async () => {
      const { ctx, run } = scenario({ merge: { status: 1, stderr: 'GraphQL: Head branch was modified. Review and try the merge again.' }, over: [[UAT_LIST, list(promoUat())]] });
      const r = await run('uat');
      expect(r).toEqual({ ok: false, code: 1, stage: 'gearset-promote-uat', reason: 'Could not merge promotion pull request #3: GraphQL: Head branch was modified. Review and try the merge again.' });
      expect(merges(ctx)).toEqual([`gh pr merge 3 --merge --match-head-commit ${SHA_UAT}`]);
      expect(sfCalls(ctx).some((l) => sfFor('acme-uat').test(l))).toBe(false);
    });

    it('is refused for an org marked production, with no dry run and no merge', async () => {
      const salesforce = { ...block(), gearset: MERGE, orgs: { ...block().orgs, 'acme-uat': { orgId: ACME_UAT_ID, production: true } } };
      const { ctx, run } = scenario({ salesforce });
      const r = await run('uat');
      expect(r).toMatchObject({ ok: false, code: 1, stage: 'gearset-promote-uat' });
      expect(r.reason).toContain('production is never a target');
      expect(startsOf(ctx)).toEqual([]);
      expect(merges(ctx)).toEqual([]);
    });

    it('is refused for an org its server says is not a sandbox, with no dry run and no merge', async () => {
      const { ctx, run } = scenario({ org: orgRecord(ACME_UAT_ID, false) });
      const r = await run('uat');
      expect(r).toMatchObject({ ok: false, code: 1, stage: 'gearset-promote-uat', validatedBy: 'foreman' });
      expect(r.reason).toContain('not a sandbox; production is never a target');
      expect(startsOf(ctx)).toEqual([]);
      expect(merges(ctx)).toEqual([]);
    });

    it('still nudges and parks the first stage when Gearset posts no status, as before', async () => {
      const { ctx, run } = scenario({ gearset: { promote: 'merge', nudgeMinutes: 1 }, over: [[QA_LIST, list(promo())], [statusOf(SHA), statuses()]] });
      const r = await run('qa');
      expect(r).toMatchObject({ ok: true, parked: { check: { mode: 'merge' } } });
      expect(r.parked.reason).toBe('Gearset has not started validating pull request #2 for qa. In Gearset, open the pipeline, select the QA environment and press Run validation on pull request #2; Foreman merges it when Gearset QA passes, then validates and promotes uat itself, and the release finishes when Gearset has deployed it.');
      for (const c of ['{', '}', '"', '`', '$', '\\']) expect(r.parked.reason).not.toContain(c);
      expect(ctx.events.filter((e) => /empty commit|Could not nudge/.test(e.text))).toHaveLength(2);
      expect(startsOf(ctx)).toEqual([]);
      expect(merges(ctx)).toEqual([]);
    });

    it('merges with nothing to dry-run when the pull request changes no Salesforce metadata', async () => {
      const { ctx, run } = scenario({ pkg: {} });
      const r = await run('uat');
      expect(r).toMatchObject({ ok: true, noReturn: true, gearsetPromotions: { uat: { validatedBy: 'foreman', validation: { skipped: true } } } });
      expect(startsOf(ctx)).toEqual([]);
      expect(merges(ctx)).toEqual([MERGE_UAT]);
      expect(uatInfo(ctx).some((t) => /it changes no Salesforce metadata, so there was nothing to dry-run/.test(t))).toBe(true);
    });

    it('does not record who validated a pull request that was already merged (a re-run)', async () => {
      const { ctx, run } = scenario({ over: [[UAT_LIST, list(mergedUat())]] });
      const r = await run('uat');
      expect(r).toMatchObject({ ok: true, noReturn: true });
      expect(r.gearsetPromotions.uat).not.toHaveProperty('validatedBy');
      expect(startsOf(ctx)).toEqual([]);
      expect(merges(ctx)).toEqual([]);
    });

    it('with validateLaterStages "gearset" is today\'s behaviour: two nudges, then the park, with no dry run and no merge', async () => {
      const { ctx } = scenario({
        gearset: { ...NUDGING },
        over: [
          [`gh api repos/{owner}/{repo}/git/commits/${SHA_UAT}`, `${TREE}\n`],
          [CREATE, `${NEW_SHA}\n`],
          [PATCH, ''],
        ],
      });
      const { code, result } = await ship(ctx);
      expect(code).toBe(9);
      expect(result).toMatchObject({ stage: 'parked', step: 'gearset-promote-uat', parked: { reason: REASON, check: { branch: 'story/s-1', mode: 'merge', stages: [UAT_STAGE] } } });
      expect(patches(ctx)).toHaveLength(2);
      expect(startsOf(ctx)).toEqual([]);
      expect(ctx.sh.calls.some((l) => l.includes('FROM Organization --target-org acme-uat'))).toBe(false);
      expect(merges(ctx)).toEqual([MERGE_QA]);
      expect(ctx.halts).toEqual([]);
    });
  });
});

describe('merge mode: check', () => {
  const STORED = { branch: 'story/s-1', mode: 'merge', stages: [{ name: 'uat', org: 'acme-uat', orgId: ACME_UAT_ID, branch: 'uat' }] };
  const STORED_QA_UAT = { branch: 'story/s-1', mode: 'merge', stages: [{ name: 'qa', org: 'acme-qa', orgId: ACME_QA_ID, branch: 'qa' }, STORED.stages[0]] };
  const deploy = [sfFor('acme-uat'), rows(deployRow({ CompletedDate: '2026-10-15T12:11:00.000+0000' }))];
  const WAIT_NONE = 'waiting for Gearset UAT on pull request #3: in Gearset, press Run validation on it in the UAT environment';
  const DRY_JOB = '0Af000000000002AAA';
  const GEARSET_ONLY = { promote: 'merge', validateLaterStages: 'gearset' };
  const dryRun = (status, details = {}) => ({ id: DRY_JOB, status, numberComponentsDeployed: 2, numberComponentsTotal: 2, numberTestsCompleted: 5, numberTestErrors: details.runTestResult ? 1 : 0, details });
  const FAILED_RUN = { componentFailures: { componentType: 'ApexClass', fullName: 'AcmeService', problem: 'Variable does not exist: total', lineNumber: '14' } };
  const startsOf = (ctx) => ctx.sh.calls.filter((l) => l.startsWith('sf project deploy start'));

  let state;
  beforeEach(() => {
    state = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-gspromote-check-state-'));
  });
  afterEach(() => {
    fs.rmSync(state, { recursive: true, force: true });
  });

  function checking({ rules = [], routes, env = { GEARSET_API_TOKEN: TOKEN }, stored = STORED, gearset = MERGE, pkg = { ApexClass: ['AcmeService'] }, org = orgRecord(ACME_UAT_ID), report = sfOk(dryRun('Succeeded')) } = {}) {
    const s = setup({
      gearset,
      routes,
      env: { FOREMAN_STATE_DIR: state, ...env },
      rules: [
        ...rules,
        [new RegExp(orgRoute('acme-uat')), org],
        ...sgdRules(pkg),
        [/^sf project deploy start /, sfOk({ id: DRY_JOB, done: false, status: 'Queued' })],
        [/^sf project deploy report /, report],
      ],
    });
    s.ctx.check = JSON.parse(JSON.stringify(stored));
    const check = () => gearsetPromote('qa').check(s.ctx, { fetch: s.fetch });
    return { ...s, check };
  }
  const writes = (ctx) => ctx.sh.calls.filter((l) => l.startsWith('gh api -X'));
  // uat is OPEN until it is merged, then MERGED, with no Gearset UAT status on its head.
  const uatOpen = (...more) => [[UAT_LIST, (line, calls) => (calls.includes(MERGE_UAT) ? list(mergedUat()) : list(promoUat()))], [statusOf(SHA_UAT), statuses(st('Gearset QA', 'success'))], [MERGE_UAT, ''], deploy, ...more];

  describe('a later stage Gearset posted no status on (validateLaterStages foreman, the default)', () => {
    it('validates it itself, merges, and is done after the deploy, with no write and no Automation API call', async () => {
      const { ctx, fetch, check } = checking({ rules: uatOpen() });
      expect(await check()).toEqual({ ok: true, done: true, note: 'Gearset deployed uat (pull request #3)' });
      expect(startsOf(ctx)).toHaveLength(1);
      expect(startsOf(ctx)[0]).toContain('--dry-run');
      expect(startsOf(ctx)[0]).toContain('--target-org acme-uat');
      const calls = ctx.sh.calls;
      expect(calls.findIndex((l) => l.startsWith('sf project deploy start'))).toBeLessThan(calls.indexOf(MERGE_UAT));
      expect(merges(ctx)).toEqual([MERGE_UAT]);
      const told = ctx.events.filter((e) => e.kind === 'info').map((e) => e.text);
      expect(told).toContain('Gearset posted no Gearset UAT status on pull request #3, as it does not validate a later stage by itself; Foreman is validating it against acme-uat (uat) instead.');
      expect(told).toContain(`Foreman, not Gearset, validated pull request #3 against acme-uat (uat): job ${DRY_JOB}, 5 tests run; merging it.`);
      expect(told).toContain("Merged Gearset's uat promotion pull request #3 for S-1 once Foreman's validation passed.");
      expect(writes(ctx)).toEqual([]);
      expect(fetch.calls.filter((c) => c.path.startsWith('/public/automation/'))).toEqual([]);
      for (const line of calls) for (const flag of FORBIDDEN) expect(line).not.toContain(flag);
    });

    it('fails the story, and merges nothing, when the dry run fails', async () => {
      const { ctx, check } = checking({ rules: uatOpen(), report: sfOk(dryRun('Failed', FAILED_RUN)) });
      const r = await check();
      expect(r.ok).toBe(false);
      expect(r.reason.startsWith("Foreman's validation of pull request #3 on acme-uat (uat) failed")).toBe(true);
      expect(merges(ctx)).toEqual([]);
    });

    it('waits, and merges nothing, when the validation never started', async () => {
      const { ctx, check } = checking({ rules: [[/^git fetch /, { status: 128, stderr: 'fatal: unable to access' }], ...uatOpen()] });
      const r = await check();
      expect(r).toMatchObject({ ok: true, done: false });
      expect(r.detail).toContain('never started');
      expect(merges(ctx)).toEqual([]);
    });

    it('waits, and merges nothing, when the dry run did not finish', async () => {
      const { ctx, check } = checking({ rules: uatOpen(), report: sfOk(dryRun('InProgress')) });
      const r = await check();
      expect(r).toMatchObject({ ok: true, done: false });
      expect(r.detail).toContain('did not finish within 30 minutes');
      expect(merges(ctx)).toEqual([]);
    });

    it('fails the story, with no dry run and no merge, when the org is not a sandbox', async () => {
      const { ctx, check } = checking({ rules: uatOpen(), org: orgRecord(ACME_UAT_ID, false) });
      const r = await check();
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('not a sandbox');
      expect(startsOf(ctx)).toEqual([]);
      expect(merges(ctx)).toEqual([]);
    });

    it("lets Gearset's status win when it turns to failure after Foreman passed", async () => {
      const failing = statuses(st('Gearset UAT', 'failure', 'Validation failed'));
      const { ctx, check } = checking({ rules: [[statusOf(SHA_UAT), (line, calls) => (calls.some((l) => l.startsWith('sf project deploy start')) ? failing : statuses())], ...uatOpen()] });
      expect(await check()).toEqual({ ok: false, reason: 'Gearset UAT validation failed on pull request #3: Validation failed' });
      expect(startsOf(ctx)).toHaveLength(1);
      expect(merges(ctx)).toEqual([]);
    });

    it('merges with nothing to dry-run when the pull request changes no Salesforce metadata', async () => {
      const { ctx, check } = checking({ rules: uatOpen(), pkg: {} });
      expect(await check()).toEqual({ ok: true, done: true, note: 'Gearset deployed uat (pull request #3)' });
      expect(startsOf(ctx)).toEqual([]);
      expect(merges(ctx)).toEqual([MERGE_UAT]);
      expect(ctx.events.some((e) => e.kind === 'info' && /it changes no Salesforce metadata, so there was nothing to dry-run/.test(e.text))).toBe(true);
    });

    it('does not validate a first stage: it waits for Gearset QA, with no dry run', async () => {
      const { ctx, check } = checking({ stored: STORED_QA_UAT, rules: [[QA_LIST, list(promo())], [statusOf(SHA), statuses()]] });
      expect(await check()).toEqual({ ok: true, done: false, detail: 'waiting for Gearset QA on pull request #2: in Gearset, press Run validation on it in the QA environment' });
      expect(startsOf(ctx)).toEqual([]);
      expect(ctx.sh.calls.some((l) => l.startsWith('git '))).toBe(false);
      expect(merges(ctx)).toEqual([]);
    });
  });

  it('with validateLaterStages "gearset" waits with the Run validation detail while Gearset has posted no status, and does nothing', async () => {
    const { ctx, fetch, check } = checking({ gearset: GEARSET_ONLY, rules: [[UAT_LIST, list(promoUat())], [statusOf(SHA_UAT), statuses(st('Gearset QA', 'success'))]] });
    expect(await check()).toEqual({ ok: true, done: false, detail: WAIT_NONE });
    expect(writes(ctx)).toEqual([]);
    expect(merges(ctx)).toEqual([]);
    expect(startsOf(ctx)).toEqual([]);
    expect(fetch.calls.filter((c) => c.path.startsWith('/public/automation/'))).toEqual([]);
  });

  it('waits while the validation is pending', async () => {
    const { ctx, check } = checking({ rules: [[UAT_LIST, list(promoUat())], [statusOf(SHA_UAT), statuses(st('Gearset UAT', 'pending'))]] });
    expect(await check()).toEqual({ ok: true, done: false, detail: 'waiting for Gearset UAT to finish validating pull request #3' });
    expect(merges(ctx)).toEqual([]);
  });

  it('merges once the validation passes and is done after the deploy, with an info event', async () => {
    const { ctx, check } = checking({ rules: [[UAT_LIST, inTurn(list(promoUat()), list(mergedUat()))], [statusOf(SHA_UAT), UAT_OK], [MERGE_UAT, ''], deploy] });
    expect(await check()).toEqual({ ok: true, done: true, note: 'Gearset deployed uat (pull request #3)' });
    expect(merges(ctx)).toEqual([MERGE_UAT]);
    expect(ctx.events).toContainEqual({ text: "Merged Gearset's uat promotion pull request #3 for S-1 once Gearset UAT passed.", kind: 'info' });
    for (const line of ctx.sh.calls) for (const flag of FORBIDDEN) expect(line).not.toContain(flag);
  });

  it('waits when the merge fails and the PR stays open', async () => {
    const { check } = checking({ rules: [[UAT_LIST, list(promoUat())], [statusOf(SHA_UAT), UAT_OK], [MERGE_UAT, { status: 1, stderr: 'GraphQL: Head branch was modified' }]] });
    expect(await check()).toEqual({ ok: true, done: false, detail: 'could not merge promotion pull request #3 yet: GraphQL: Head branch was modified' });
  });

  it('fails the story, not the line, when the validation failed', async () => {
    const { ctx, check } = checking({ rules: [[UAT_LIST, list(promoUat())], [statusOf(SHA_UAT), statuses(st('Gearset UAT', 'failure', 'Validation failed'))]] });
    expect(await check()).toEqual({ ok: false, reason: 'Gearset UAT validation failed on pull request #3: Validation failed' });
    expect(merges(ctx)).toEqual([]);
  });

  it('waits without a token, naming it, and merges nothing', async () => {
    const { ctx, fetch, check } = checking({ env: {}, rules: [[UAT_LIST, list(promoUat())], [statusOf(SHA_UAT), UAT_OK]] });
    const r = await check();
    expect(r).toMatchObject({ ok: true, done: false });
    expect(r.detail).toContain('GEARSET_API_TOKEN is not set');
    expect(merges(ctx)).toEqual([]);
    expect(fetch.calls).toEqual([]);
  });

  it("refuses an org that Gearset lists as its production environment, and merges nothing", async () => {
    const routes = acmeGearset({ [environmentsOf('pipe-1')]: { status: 200, body: [acmeEnvironment('QA', ACME_QA_ID), acmeEnvironment('UAT', ACME_UAT_ID, 'Production')] } });
    const { ctx, check } = checking({ routes, rules: [[UAT_LIST, list(promoUat())], [statusOf(SHA_UAT), UAT_OK]] });
    const r = await check();
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('production') });
    expect(merges(ctx)).toEqual([]);
  });

  it('waits when the Gearset environments cannot be read', async () => {
    const { ctx, check } = checking({ routes: acmeGearset({ [PIPELINES]: { status: 500, body: {} } }), rules: [[UAT_LIST, list(promoUat())], [statusOf(SHA_UAT), UAT_OK]] });
    const r = await check();
    expect(r).toMatchObject({ ok: true, done: false });
    expect(merges(ctx)).toEqual([]);
  });

  it('still answers the click-Promote detail for a stored check without a mode', async () => {
    const { mode: _mode, ...owner } = STORED;
    const { check } = checking({ stored: owner, rules: [[UAT_LIST, list(promoUat())]] });
    expect(await check()).toEqual({ ok: true, done: false, detail: 'waiting for you to click Promote for uat in Gearset (pull request #3)' });
  });

  it('never puts the token in an answer', async () => {
    const secret = 't-acme-secret-77';
    const scenarios = [
      { gearset: GEARSET_ONLY, rules: [[UAT_LIST, list(promoUat())], [statusOf(SHA_UAT), statuses()]] },
      { rules: [[UAT_LIST, list(promoUat())], [statusOf(SHA_UAT), UAT_OK], [MERGE_UAT, { status: 1, stderr: 'no' }]] },
      { rules: [[UAT_LIST, list(promoUat())]], routes: acmeGearset({ [PIPELINES]: new Error(`refused ${secret}`) }) },
      { rules: [[UAT_LIST, list(promoUat())], [statusOf(SHA_UAT), statuses(st('Gearset UAT', 'failure', 'bad'))]] },
    ];
    for (const s of scenarios) {
      const { check } = checking({ ...s, env: { GEARSET_API_TOKEN: secret } });
      expect(JSON.stringify(await check())).not.toContain(secret);
    }
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
