import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ciDeployWatch } from './ci-deploy-watch.mjs';
import { runShip } from '../../../lib/engine/ship.mjs';
import { fakeCtx } from '../../../../test/ship-fakes.mjs';
import { ACME_DEV1_ID, ACME_QA_ID, ACME_UAT_ID, sfError, sfOk } from '../../../../test/fake-sf.mjs';

const SHA = 'abc1234def5678abc1234def5678abc1234def56';
const OTHER_SHA = 'fff0000fff0000fff0000fff0000fff0000fff00';
const MERGED_AT = '2026-10-15T12:00:00Z';
const DEPLOY = '0Af000000000001AAA';

const LAYOUT_B = {
  productionBranch: 'main',
  orgs: { 'acme-dev1': { orgId: ACME_DEV1_ID }, 'acme-qa': { orgId: ACME_QA_ID }, 'acme-uat': { orgId: ACME_UAT_ID } },
  build: ['acme-dev1'],
  stages: [{ name: 'qa', org: 'acme-qa', branch: 'qa' }, { name: 'uat', org: 'acme-uat', branch: 'uat' }],
};

// A GitHub Actions run as `gh api .../actions/runs` lists it.
const run = (over = {}) => ({
  id: 101,
  name: 'deploy',
  head_sha: SHA,
  head_branch: 'qa',
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  html_url: 'https://github.com/acme/repo/actions/runs/101',
  ...over,
});
const runs = (...list) => JSON.stringify({ total_count: list.length, workflow_runs: list });

// A DeployRequest row as the Tooling API query gives it.
const deployRow = (over = {}) => ({
  attributes: { type: 'DeployRequest' },
  Id: DEPLOY,
  Status: 'Succeeded',
  CheckOnly: false,
  CreatedDate: '2026-10-15T12:01:00.000+0000',
  StartDate: '2026-10-15T12:01:00.000+0000',
  CompletedDate: '2026-10-15T12:03:00.000+0000',
  ...over,
});
const rows = (...records) => sfOk({ records, totalSize: records.length, done: true });

// Each item of `list` answers one call in turn, then the last answers every later call.
const inTurn = (list) => {
  let n = 0;
  return () => list[Math.min(n++, list.length - 1)];
};

let sfHome;
beforeEach(() => {
  sfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-ciwatch-sfhome-'));
});
afterEach(() => {
  fs.rmSync(sfHome, { recursive: true, force: true });
});

const sfLines = (ctx) => ctx.sh.calls.filter((l) => l.startsWith('sf '));
const ghLines = (ctx) => ctx.sh.calls.filter((l) => l.startsWith('gh '));
const sum = (list) => list.reduce((a, b) => a + b, 0);

// The fake git answers for merging the story into uat: not merged yet, merge commit UAT_MERGE.
const UAT_MERGE = 'd'.repeat(40);
// The reviewed head: the local story branch and the remote one agree on it.
const STORY_HEAD = 'e'.repeat(40);
const MERGE_RULES = [
  [/^git rev-parse --verify refs\/(heads|remotes\/origin)\/story\/s-1$/, `${STORY_HEAD}\n`],
  ['git merge-base --is-ancestor', 1],
  ['git rev-parse HEAD', `${UAT_MERGE}\n`],
];

function ctxFor({ salesforce = LAYOUT_B, sha = SHA, committed = `${MERGED_AT}\n`, gh = [runs(run())], sf = [rows(deployRow())], git = MERGE_RULES, ...rest } = {}) {
  const ctx = fakeCtx({
    config: { pack: 'salesforce', salesforce, slots: 1 },
    branch: 'story/s-1',
    rules: [
      ...git,
      [/^git show -s --format=%cI /, committed],
      [/^gh api repos\/\{owner\}\/\{repo\}\/actions\/runs\?/, inTurn(gh)],
      [/^sf data query --use-tooling-api/, inTurn(sf)],
    ],
    root: '/acme/repo',
    env: { FOREMAN_SF_HOME: sfHome },
    ...rest,
  });
  if (sha !== undefined) ctx.sha = sha;
  return ctx;
}

const seen = [];
afterEach(() => {
  for (const ctx of seen.splice(0)) {
    for (const line of sfLines(ctx)) {
      expect(line).not.toMatch(/(^| )deploy( |$)/);
      expect(line).not.toContain('--ignore-');
      expect(line).not.toContain(' quick');
    }
  }
});
const make = (opts) => {
  const ctx = ctxFor(opts);
  seen.push(ctx);
  return ctx;
};

describe('ciDeployWatch(stage)', () => {
  it('is the step that watches the CI deploy to that stage, needs gh and sf, halts and deploys, one module per name', () => {
    const qa = ciDeployWatch('qa');
    expect(qa).toMatchObject({ name: 'ci-deploy-watch-qa', label: 'watching the CI deploy to qa', needs: ['gh', 'sf'], halts: true, deploys: true });
    expect(typeof qa.run).toBe('function');
    expect(ciDeployWatch('qa')).toBe(qa);
    expect(ciDeployWatch('uat')).not.toBe(qa);
    expect(ciDeployWatch('uat').name).toBe('ci-deploy-watch-uat');
  });

  it("ciDeployWatch(stage, { later: true }) is a later stage's step: noRollback, needs gh, sf and git, one module per name", () => {
    const later = ciDeployWatch('uat', { later: true });
    expect(later).toMatchObject({ name: 'ci-deploy-watch-uat', noRollback: true, needs: ['gh', 'sf', 'git'], halts: true, deploys: true });
    expect(ciDeployWatch('uat', { later: true })).toBe(later);
    expect(ciDeployWatch('uat')).not.toBe(later);
    expect(ciDeployWatch('uat')).not.toHaveProperty('noRollback');
  });
});

describe('a later stage', () => {
  const LAYOUT_C = { ...LAYOUT_B, stages: [...LAYOUT_B.stages, { name: 'stg', org: 'acme-uat' }] };

  it('on its own branch merges the story first, then watches the merge on that branch', async () => {
    const ctx = make({ gh: [runs(run({ head_sha: UAT_MERGE, head_branch: 'uat' }))] });
    const r = await ciDeployWatch('uat', { later: true }).run(ctx);
    expect(r).toMatchObject({ ok: true, sha: UAT_MERGE, shaBranch: 'uat', ciDeploys: { uat: { org: 'acme-uat', sha: UAT_MERGE, deployId: DEPLOY } } });
    const mergeAt = ctx.sh.calls.findIndex((l) => l.startsWith('git merge --no-ff'));
    expect(ctx.sh.calls[mergeAt]).toContain(STORY_HEAD);
    const ghAt = ctx.sh.calls.findIndex((l) => l.startsWith('gh '));
    expect(ghAt).toBeGreaterThan(mergeAt);
    expect(ctx.sh.calls[ghAt]).toContain(`head_sha=${UAT_MERGE}&branch=uat&event=push`);
    expect(ctx.sh.calls).toContain(`git show -s --format=%cI ${UAT_MERGE}`);
  });

  it('on its own branch, a merge that fails is code 5 with no gh or sf call', async () => {
    const ctx = make({ git: [['git fetch', 1]] });
    const r = await ciDeployWatch('uat', { later: true }).run(ctx);
    expect(r).toMatchObject({ ok: false, code: 5, stage: 'ci-deploy-watch-uat' });
    expect(r.reason).toContain('could not fetch uat');
    expect(ghLines(ctx)).toEqual([]);
    expect(sfLines(ctx)).toEqual([]);
  });

  it('on its own branch, a remote story branch that moved after review is code 5 with no gh or sf call', async () => {
    const ctx = make({ git: [['git rev-parse --verify refs/remotes/origin/story/s-1', `${'f'.repeat(40)}\n`], ...MERGE_RULES] });
    const r = await ciDeployWatch('uat', { later: true }).run(ctx);
    expect(r).toMatchObject({ ok: false, code: 5, stage: 'ci-deploy-watch-uat' });
    expect(r.reason.startsWith('The merge for uat failed:')).toBe(true);
    expect(r.reason).toContain('reviewed');
    expect(ctx.sh.calls.some((l) => l.startsWith('git merge --no-ff'))).toBe(false);
    expect(ghLines(ctx).some((l) => l.includes('actions/runs'))).toBe(false);
    expect(sfLines(ctx)).toEqual([]);
  });

  it('that follows a branch watches the sha the stage before it gave, on that branch, with no merge', async () => {
    const ctx = make({ salesforce: LAYOUT_C, sha: UAT_MERGE, gh: [runs(run({ head_sha: UAT_MERGE, head_branch: 'uat' }))] });
    ctx.shaBranch = 'uat';
    const r = await ciDeployWatch('stg', { later: true }).run(ctx);
    expect(r).toMatchObject({ ok: true, ciDeploys: { stg: { org: 'acme-uat', sha: UAT_MERGE } } });
    expect(r).not.toHaveProperty('shaBranch');
    expect(ctx.sh.calls.some((l) => l.startsWith('git merge') || l.startsWith('git fetch'))).toBe(false);
    expect(ghLines(ctx)[0]).toContain(`head_sha=${UAT_MERGE}&branch=uat&event=push`);
  });

  it('that follows a branch other than the one the sha is on is code 1', async () => {
    const ctx = make({ salesforce: LAYOUT_C, sha: UAT_MERGE });
    ctx.shaBranch = 'qa';
    const r = await ciDeployWatch('stg', { later: true }).run(ctx);
    expect(r).toMatchObject({ ok: false, code: 1, stage: 'ci-deploy-watch-stg' });
    expect(r.reason).toBe('Stage stg is on branch uat, but pull requests merge into qa; only the stage on qa can have its CI deploy watched.');
  });
});

describe('finding the CI run', () => {
  it('asks for push runs of the merge commit on the target branch', async () => {
    const ctx = make();
    expect(await ciDeployWatch('qa').run(ctx)).toMatchObject({ ok: true });
    const [line] = ghLines(ctx);
    expect(line).toContain(`head_sha=${SHA}&branch=qa&event=push`);
    expect(ctx.sh.calls).toContain(`git show -s --format=%cI ${SHA}`);
  });

  it('ignores runs of another commit or another branch, and follows the match from queued to success', async () => {
    const ctx = make({
      gh: [
        runs(run({ head_sha: OTHER_SHA }), run({ head_branch: 'main' })),
        runs(run({ status: 'queued', conclusion: null }), run({ head_sha: OTHER_SHA, conclusion: 'failure' })),
        runs(run({ status: 'in_progress', conclusion: null }), run({ head_branch: 'main', conclusion: 'failure' })),
        runs(run(), run({ head_sha: OTHER_SHA, conclusion: 'failure' })),
      ],
    });
    const r = await ciDeployWatch('qa').run(ctx);
    expect(r).toMatchObject({ ok: true });
    expect(ghLines(ctx)).toHaveLength(5);
    expect(ctx.sleeps).toEqual([20_000, 20_000, 20_000, 20_000]);
    expect(ctx.reports.length).toBeGreaterThanOrEqual(4);
    expect(ctx.reports.every((d) => d === 'watching the CI deploy to qa')).toBe(true);
    expect(r.ciDeploys.qa.runs).toEqual([{ name: 'deploy', url: 'https://github.com/acme/repo/actions/runs/101', conclusion: 'success' }]);
  });

  it('a failed CI run is code 5 naming the run and its page, with no sf call', async () => {
    const ctx = make({ gh: [runs(run({ conclusion: 'failure' }))] });
    const r = await ciDeployWatch('qa').run(ctx);
    expect(r).toMatchObject({ ok: false, code: 5, stage: 'ci-deploy-watch-qa' });
    expect(r.reason).toContain('CI run deploy for abc1234 on qa ended as failure');
    expect(r.reason).toContain('https://github.com/acme/repo/actions/runs/101');
    expect(sfLines(ctx)).toEqual([]);
  });

  it('skipped and neutral runs pass beside a successful one', async () => {
    const ctx = make({ gh: [runs(run(), run({ id: 2, name: 'lint', conclusion: 'skipped' }), run({ id: 3, name: 'notes', conclusion: 'neutral' }))] });
    expect(await ciDeployWatch('qa').run(ctx)).toMatchObject({ ok: true });
  });

  it('times out with code 5 when no run starts for the merge commit within 30 minutes', async () => {
    const ctx = make({ gh: [runs()] });
    const r = await ciDeployWatch('qa').run(ctx);
    expect(r).toMatchObject({ ok: false, code: 5, stage: 'ci-deploy-watch-qa' });
    expect(r.reason).toMatch(/No GitHub Actions run started .* within 30 minutes/);
    expect(r.reason).toContain('abc1234 on qa');
    expect(sum(ctx.sleeps)).toBe(30 * 60_000);
    expect(sfLines(ctx)).toEqual([]);
  });

  it('names the last gh error when no run was ever read', async () => {
    const ctx = make({ gh: [{ status: 1, stdout: '', stderr: 'gh: HTTP 502' }] });
    const r = await ciDeployWatch('qa').run(ctx);
    expect(r).toMatchObject({ ok: false, code: 5 });
    expect(r.reason).toMatch(/No GitHub Actions run started .* within 30 minutes/);
    expect(r.reason).toMatch(/\(gh: HTTP 502\)$/);
  });

  it('keeps polling through unreadable gh output', async () => {
    const ctx = make({ gh: ['not json', JSON.stringify({ nope: 1 }), runs(run())] });
    expect(await ciDeployWatch('qa').run(ctx)).toMatchObject({ ok: true });
    expect(ghLines(ctx)).toHaveLength(4);
  });

  it('times out with code 5 while a run is still in progress', async () => {
    const ctx = make({ gh: [runs(run({ status: 'in_progress', conclusion: null }))] });
    const r = await ciDeployWatch('qa').run(ctx);
    expect(r).toMatchObject({ ok: false, code: 5 });
    expect(r.reason).toMatch(/did not finish within 30 minutes/);
    expect(r.reason).toContain('in_progress');
    expect(sum(ctx.sleeps)).toBe(30 * 60_000);
    expect(sfLines(ctx)).toEqual([]);
  });

  it('a finished run set is read twice before the org check', async () => {
    const ctx = make({ gh: [runs(run())] });
    expect(await ciDeployWatch('qa').run(ctx)).toMatchObject({ ok: true });
    expect(ghLines(ctx)).toHaveLength(2);
    expect(ctx.sleeps).toEqual([20_000]);
    expect(sfLines(ctx)).toHaveLength(1);
    expect(ctx.sh.calls.lastIndexOf(ghLines(ctx)[1])).toBeLessThan(ctx.sh.calls.indexOf(sfLines(ctx)[0]));
  });

  const LATE_URL = 'https://github.com/acme/repo/actions/runs/102';
  const late = (over = {}) => run({ id: 102, name: 'deploy-late', html_url: LATE_URL, ...over });

  it('a workflow queued after the first one finished is watched, and its failure is code 5', async () => {
    const ctx = make({ gh: [runs(run()), runs(run(), late({ status: 'queued', conclusion: null })), runs(run(), late({ conclusion: 'failure' }))] });
    const r = await ciDeployWatch('qa').run(ctx);
    expect(r).toMatchObject({ ok: false, code: 5, stage: 'ci-deploy-watch-qa' });
    expect(r.reason).toContain('CI run deploy-late for abc1234 on qa ended as failure');
    expect(r.reason).toContain(LATE_URL);
    expect(sfLines(ctx)).toEqual([]);
  });

  it('a late run that passes is waited for and listed in the facts', async () => {
    const ctx = make({ gh: [runs(run()), runs(run(), late({ status: 'queued', conclusion: null })), runs(run(), late())] });
    const r = await ciDeployWatch('qa').run(ctx);
    expect(r).toMatchObject({ ok: true });
    expect(r.ciDeploys.qa.runs.map((x) => x.name)).toEqual(['deploy', 'deploy-late']);
    expect(ghLines(ctx)).toHaveLength(4);
  });

  it('a poll gh cannot answer does not count as the second look, and keeps the first', async () => {
    const ctx = make({ gh: [runs(run()), { status: 1, stdout: '', stderr: 'gh: HTTP 502' }, runs(run())] });
    expect(await ciDeployWatch('qa').run(ctx)).toMatchObject({ ok: true });
    expect(ghLines(ctx)).toHaveLength(3);
  });

  it('runs first seen finished at the deadline go on to the org check', async () => {
    const ctx = make({ gh: [...Array(90).fill(runs(run({ status: 'in_progress', conclusion: null }))), runs(run())] });
    expect(await ciDeployWatch('qa').run(ctx)).toMatchObject({ ok: true });
    expect(sum(ctx.sleeps)).toBe(30 * 60_000);
    expect(sfLines(ctx)).toHaveLength(1);
  });
});

describe('confirming the deploy in the org', () => {
  it('queries DeployRequest after the merge on the stage org, through the isolated sf home', async () => {
    const ctx = make();
    const r = await ciDeployWatch('qa').run(ctx);
    const [line] = sfLines(ctx);
    expect(line).toContain('--use-tooling-api');
    expect(line).toContain('FROM DeployRequest');
    expect(line).toContain(`CreatedDate > ${MERGED_AT}`);
    expect(line).toContain('--target-org acme-qa');
    const at = ctx.sh.calls.indexOf(line);
    expect(ctx.sh.opts[at].env.HOME).toBe(sfHome);
    expect(r).toEqual({
      ok: true,
      ciDeploys: { qa: { org: 'acme-qa', sha: SHA, deployId: DEPLOY, runs: [{ name: 'deploy', url: 'https://github.com/acme/repo/actions/runs/101', conclusion: 'success' }] } },
    });
  });

  it('keeps the ciDeploys facts of other stages', async () => {
    const ctx = make();
    ctx.ciDeploys = { dev: { org: 'acme-dev1' } };
    const r = await ciDeployWatch('qa').run(ctx);
    expect(Object.keys(r.ciDeploys)).toEqual(['dev', 'qa']);
  });

  it('never counts a check-only deploy', async () => {
    const ctx = make({ sf: [rows(deployRow({ CheckOnly: true }))] });
    const r = await ciDeployWatch('qa').run(ctx);
    expect(r).toMatchObject({ ok: false, code: 5 });
    expect(r.reason).toMatch(/shows no successful deploy that finished after the merge/);
  });

  it('waits for a pending deploy, then passes', async () => {
    const ctx = make({ sf: [rows(deployRow({ Status: 'InProgress', CompletedDate: null })), rows(deployRow())] });
    const r = await ciDeployWatch('qa').run(ctx);
    expect(r).toMatchObject({ ok: true });
    expect(sfLines(ctx)).toHaveLength(2);
    expect(ctx.sleeps).toEqual([20_000, 20_000]);
  });

  it('times out with code 5 while the deploy is still in progress in the org', async () => {
    const ctx = make({ sf: [rows(deployRow({ Status: 'InProgress', CompletedDate: null }))] });
    const r = await ciDeployWatch('qa').run(ctx);
    expect(r).toMatchObject({ ok: false, code: 5, stage: 'ci-deploy-watch-qa' });
    expect(r.reason).toMatch(/did not finish within 30 minutes/);
    expect(r.reason).toContain('acme-qa (qa)');
    expect(sum(ctx.sleeps)).toBe(30 * 60_000);
  });

  it('fails at once with code 5 when there is no successful deploy after the merge', async () => {
    const ctx = make({ sf: [rows()] });
    const r = await ciDeployWatch('qa').run(ctx);
    expect(r).toMatchObject({ ok: false, code: 5, stage: 'ci-deploy-watch-qa' });
    expect(r.reason).toMatch(/The CI runs for abc1234 passed, but acme-qa \(qa\) shows no successful deploy that finished after the merge at 2026-10-15T12:00:00Z/);
    expect(ctx.sleeps).toEqual([20_000]);
    expect(sfLines(ctx)).toHaveLength(1);
  });

  it('names the newest deploy when it failed', async () => {
    const ctx = make({ sf: [rows(deployRow({ Status: 'Failed' }))] });
    const r = await ciDeployWatch('qa').run(ctx);
    expect(r).toMatchObject({ ok: false, code: 5 });
    expect(r.reason).toMatch(/the newest was Failed$/);
  });

  it('a Succeeded deploy that finished before the merge does not count', async () => {
    const ctx = make({ sf: [rows(deployRow({ CompletedDate: '2026-10-15T11:59:00.000+0000' }))] });
    const r = await ciDeployWatch('qa').run(ctx);
    expect(r).toMatchObject({ ok: false, code: 5 });
    expect(r.reason).toMatch(/shows no successful deploy that finished after the merge/);
  });

  it('tries a failed query again and passes when the next one finds the deploy', async () => {
    const ctx = make({ sf: [sfError('INVALID_TYPE', 'sObject type DeployRequest is not supported'), rows(deployRow())] });
    expect(await ciDeployWatch('qa').run(ctx)).toMatchObject({ ok: true });
    expect(sfLines(ctx)).toHaveLength(2);
  });

  it('a login-rate answer is code 5 at once, after a single query', async () => {
    const ctx = make({ sf: [sfError('X', 'login rate exceeded')] });
    const r = await ciDeployWatch('qa').run(ctx);
    expect(r).toMatchObject({ ok: false, code: 5 });
    expect(r.reason).toMatch(/^Stopped watching the deploy of \S+ to acme-qa \(qa\): stopped at once:.*login rate exceeded/);
    expect(sfLines(ctx)).toHaveLength(1);
  });

  // CI runs that ran from 12:05 to 12:09; a deploy must be created in that window, a minute either side.
  const timed = (over = {}) => run({ run_started_at: '2026-10-15T12:05:00Z', updated_at: '2026-10-15T12:09:00Z', ...over });
  const OUTSIDE = /shows no successful deploy made while they ran \(2026-10-15T12:05:00Z to 2026-10-15T12:09:00Z\)/;

  it('counts a deploy created while the CI runs ran', async () => {
    const ctx = make({ gh: [runs(timed())], sf: [rows(deployRow({ CreatedDate: '2026-10-15T12:07:00.000+0000', CompletedDate: '2026-10-15T12:08:00.000+0000' }))] });
    expect(await ciDeployWatch('qa').run(ctx)).toMatchObject({ ok: true, ciDeploys: { qa: { deployId: DEPLOY } } });
  });

  it('a deploy made after the CI runs ended does not count (a manual deploy)', async () => {
    const ctx = make({ gh: [runs(timed())], sf: [rows(deployRow({ CreatedDate: '2026-10-15T12:15:00.000+0000', CompletedDate: '2026-10-15T12:16:00.000+0000' }))] });
    const r = await ciDeployWatch('qa').run(ctx);
    expect(r).toMatchObject({ ok: false, code: 5, stage: 'ci-deploy-watch-qa' });
    expect(r.reason).toMatch(OUTSIDE);
    expect(sfLines(ctx)).toHaveLength(1);
  });

  it('a deploy made after the merge but before the CI runs started does not count', async () => {
    const ctx = make({ gh: [runs(timed())], sf: [rows(deployRow({ CreatedDate: '2026-10-15T12:02:00.000+0000' }))] });
    const r = await ciDeployWatch('qa').run(ctx);
    expect(r).toMatchObject({ ok: false, code: 5 });
    expect(r.reason).toMatch(OUTSIDE);
  });

  it('one minute of clock slack each side counts', async () => {
    for (const at of ['12:04:15', '12:09:45']) {
      const ctx = make({ gh: [runs(timed())], sf: [rows(deployRow({ CreatedDate: `2026-10-15T${at}.000+0000`, CompletedDate: '2026-10-15T12:11:00.000+0000' }))] });
      expect(await ciDeployWatch('qa').run(ctx)).toMatchObject({ ok: true });
    }
    const ctx = make({ gh: [runs(timed())], sf: [rows(deployRow({ CreatedDate: '2026-10-15T12:10:30.000+0000', CompletedDate: '2026-10-15T12:11:00.000+0000' }))] });
    const r = await ciDeployWatch('qa').run(ctx);
    expect(r).toMatchObject({ ok: false, code: 5 });
    expect(r.reason).toMatch(OUTSIDE);
  });

  it('the window spans every run: the earliest start (or creation) to the latest update', async () => {
    const ctx = make({
      gh: [runs(timed(), run({ id: 2, name: 'lint', created_at: '2026-10-15T12:03:00Z', updated_at: '2026-10-15T12:20:00Z' }))],
      sf: [rows(deployRow({ Status: 'Failed', CreatedDate: '2026-10-15T12:30:00.000+0000' }))],
    });
    const r = await ciDeployWatch('qa').run(ctx);
    expect(r.reason).toMatch(/made while they ran \(2026-10-15T12:03:00Z to 2026-10-15T12:20:00Z\); the newest was Failed$/);
  });

  it('a row whose CreatedDate cannot be read is not in the window', async () => {
    const ctx = make({ gh: [runs(timed())], sf: [rows(deployRow({ CreatedDate: null }))] });
    const r = await ciDeployWatch('qa').run(ctx);
    expect(r).toMatchObject({ ok: false, code: 5 });
    expect(r.reason).toMatch(OUTSIDE);
  });

  it('with only a start time, the window has no end', async () => {
    const ctx = make({ gh: [runs(run({ run_started_at: '2026-10-15T12:05:00Z' }))], sf: [rows(deployRow({ CreatedDate: '2026-10-15T12:02:00.000+0000' }))] });
    const r = await ciDeployWatch('qa').run(ctx);
    expect(r.reason).toMatch(/made while they ran \(2026-10-15T12:05:00Z to now\)/);
    const later = make({ gh: [runs(run({ run_started_at: '2026-10-15T12:05:00Z' }))], sf: [rows(deployRow({ CreatedDate: '2026-10-15T13:00:00.000+0000', CompletedDate: '2026-10-15T13:01:00.000+0000' }))] });
    expect(await ciDeployWatch('qa').run(later)).toMatchObject({ ok: true });
  });

  it('with only an end time, the window starts at the merge', async () => {
    const ctx = make({ gh: [runs(run({ updated_at: '2026-10-15T12:09:00Z' }))], sf: [rows(deployRow({ CreatedDate: '2026-10-15T12:15:00.000+0000' }))] });
    const r = await ciDeployWatch('qa').run(ctx);
    expect(r.reason).toMatch(/made while they ran \(2026-10-15T12:00:00Z to 2026-10-15T12:09:00Z\)/);
    const early = make({ gh: [runs(run({ updated_at: '2026-10-15T12:09:00Z' }))], sf: [rows(deployRow({ CreatedDate: '2026-10-15T12:01:00.000+0000' }))] });
    expect(await ciDeployWatch('qa').run(early)).toMatchObject({ ok: true });
  });

  it('a pending deploy outside the window does not keep the step waiting', async () => {
    const ctx = make({ gh: [runs(timed())], sf: [rows(deployRow({ Status: 'InProgress', CompletedDate: null, CreatedDate: '2026-10-15T12:15:00.000+0000' }))] });
    const r = await ciDeployWatch('qa').run(ctx);
    expect(r).toMatchObject({ ok: false, code: 5 });
    expect(r.reason).toMatch(OUTSIDE);
    expect(sfLines(ctx)).toHaveLength(1);
  });

  it('the query asks for CreatedDate', async () => {
    const ctx = make();
    await ciDeployWatch('qa').run(ctx);
    const [line] = sfLines(ctx);
    expect(line).toContain('SELECT Id, Status, CheckOnly, CreatedDate,');
    expect(line).toContain(`CreatedDate > ${MERGED_AT}`);
  });

  it('runs without times keep the merge-time rule', async () => {
    const ctx = make({ sf: [rows(deployRow({ CreatedDate: '2026-10-15T12:30:00.000+0000', CompletedDate: '2026-10-15T12:31:00.000+0000' }))] });
    expect(await ciDeployWatch('qa').run(ctx)).toMatchObject({ ok: true });
  });

  it('a query failing until the deadline is code 5 with its error', async () => {
    const ctx = make({ sf: [sfError('INVALID_TYPE', 'sObject type DeployRequest is not supported')] });
    const r = await ciDeployWatch('qa').run(ctx);
    expect(r).toMatchObject({ ok: false, code: 5 });
    expect(r.reason).toMatch(/did not finish within 30 minutes/);
    expect(r.reason).toContain('sObject type DeployRequest is not supported');
    expect(r.reason).not.toContain('Did you mean');
  });
});

describe('refusals before any gh or sf call', () => {
  const refused = async (ctx, code) => {
    const r = await ciDeployWatch(ctx.stageName ?? 'qa').run(ctx);
    expect(r).toMatchObject({ ok: false, code });
    expect(ghLines(ctx)).toEqual([]);
    expect(sfLines(ctx)).toEqual([]);
    return r;
  };

  it('no merge commit is code 5', async () => {
    for (const sha of [undefined, null, '', 'not-a-sha']) {
      const ctx = make({ sha });
      if (sha === undefined) delete ctx.sha;
      const r = await refused(ctx, 5);
      expect(r.reason).toBe('No merge commit is known on qa, so its CI run cannot be found.');
    }
  });

  it('a merge commit whose time cannot be read is code 5', async () => {
    for (const committed of [{ status: 128, stdout: '', stderr: 'fatal: bad object' }, 'not a date\n']) {
      const r = await refused(make({ committed }), 5);
      expect(r.reason).toContain('could not read the time of merge commit abc1234');
    }
  });

  it('a stage not in the block is code 1', async () => {
    const ctx = make();
    const r = await ciDeployWatch('prod').run(ctx);
    expect(r).toMatchObject({ ok: false, code: 1, stage: 'ci-deploy-watch-prod', reason: 'The salesforce block has no stage named prod.' });
    expect(ctx.sh.calls.filter((l) => /^(gh|sf|git show) /.test(l))).toEqual([]);
  });

  it('a stage org with no org ID is code 1', async () => {
    const ctx = make({ salesforce: { ...LAYOUT_B, orgs: { ...LAYOUT_B.orgs, 'acme-qa': {} } } });
    const r = await refused(ctx, 1);
    expect(r.reason).toContain('acme-qa');
  });

  it('a stage whose branch is not the pull request target is code 1', async () => {
    const ctx = make();
    ctx.config.ship = { ...ctx.config.ship, pr: { into: 'develop' } };
    const r = await ciDeployWatch('qa').run(ctx);
    expect(r).toMatchObject({ ok: false, code: 1, stage: 'ci-deploy-watch-qa' });
    expect(r.reason).toBe('Stage qa is on branch qa, but pull requests merge into develop; only the stage on develop can have its CI deploy watched.');
    expect(ctx.sh.calls.filter((l) => /^(gh|sf|git show) /.test(l))).toEqual([]);
  });
});

describe('through runShip', () => {
  it('a failed CI run is code 5 with one HALT', async () => {
    const ctx = make({ gh: [runs(run({ conclusion: 'failure' }))] });
    const { code, result } = await runShip({ steps: [ciDeployWatch('qa')], ctx });
    expect(code).toBe(5);
    expect(result).toMatchObject({ stage: 'ci-deploy-watch-qa' });
    expect(ctx.halts).toHaveLength(1);
  });
});
