import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateHead } from './head-validate.mjs';
import { layout } from './config.mjs';
import { fakeCtx } from '../../../test/ship-fakes.mjs';
import { ACME_DEV1_ID, ACME_QA_ID, ACME_UAT_ID, acmePlugins, orgRecord, orgRoute, sfError, sfOk, sfRaw } from '../../../test/fake-sf.mjs';

const JOB = '0Af000000000001AAA';
const SHA = 'c3d4e5f60718293a4b5c6d7e8f9012345678a1b2';
const BASE = '0123456789abcdef0123456789abcdef01234567';
const HEAD = 'gs-pipeline/story/s-1_-_uat';
const WHAT = 'pull request #3';
const LABEL = 'validating pull request #3 on acme-uat';

const block = (over = {}) => ({
  productionBranch: 'main',
  orgs: { 'acme-dev1': { orgId: ACME_DEV1_ID }, 'acme-qa': { orgId: ACME_QA_ID }, 'acme-uat': { orgId: ACME_UAT_ID } },
  build: ['acme-dev1'],
  stages: [{ name: 'qa', org: 'acme-qa', branch: 'qa' }, { name: 'uat', org: 'acme-uat', branch: 'uat' }],
  release: 'gearset',
  ...over,
});

const manifest = (types = {}) =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
    ...Object.entries(types).map(([name, members]) => `  <types>\n${members.map((m) => `    <members>${m}</members>`).join('\n')}\n    <name>${name}</name>\n  </types>`),
    '  <version>62.0</version>',
    '</Package>',
    '',
  ].join('\n');

const report = (status, details = {}) => ({
  id: JOB,
  status,
  numberComponentsDeployed: status === 'Succeeded' ? 2 : 1,
  numberComponentsTotal: 2,
  numberTestsCompleted: 5,
  numberTestErrors: details.runTestResult ? 1 : 0,
  details,
});
const FAILED = {
  componentFailures: { componentType: 'ApexClass', fullName: 'AcmeService', problem: 'Variable does not exist: total', lineNumber: '14' },
  runTestResult: { failures: [{ name: 'AcmeServiceTest', methodName: 'sumsTheOrder', message: 'Assertion Failed' }] },
};
const INHERITED = {
  runTestResult: {
    failures: [{ name: 'AcmeServiceTest', methodName: 'sumsTheOrder', message: 'Assertion Failed' }],
    codeCoverageWarnings: { message: 'Average test coverage across all Apex Classes and Triggers is 19%, at least 75% test coverage is required.' },
  },
};

// The `sf sgd source delta` fake: writes the two manifests into the --output-dir on the line.
const sgd = ({ pkg, destructive }) => (line) => {
  const words = line.split(' ');
  const out = words[words.indexOf('--output-dir') + 1];
  fs.mkdirSync(path.join(out, 'package'), { recursive: true });
  fs.mkdirSync(path.join(out, 'destructiveChanges'), { recursive: true });
  fs.writeFileSync(path.join(out, 'package', 'package.xml'), manifest(pkg));
  fs.writeFileSync(path.join(out, 'destructiveChanges', 'destructiveChanges.xml'), manifest(destructive));
  return sfOk({ error: null, 'output-dir': out, success: true });
};

let sfHome;
let state;
beforeEach(() => {
  sfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-headval-sfhome-'));
  state = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-headval-state-'));
});
afterEach(() => {
  for (const d of [sfHome, state]) fs.rmSync(d, { recursive: true, force: true });
});

function setup({
  salesforce = block(),
  org = orgRecord(ACME_UAT_ID),
  start = sfOk({ id: JOB, done: false, status: 'Queued' }),
  reports = [sfOk(report('Succeeded'))],
  pkg = { ApexClass: ['AcmeService'] },
  destructive = {},
  plugins = sfRaw(acmePlugins({ 'sfdx-git-delta': '6.45.1' })),
  mergeBase = `${BASE}\n`,
  sgdAnswer = null,
  git = {},
} = {}) {
  let n = 0;
  const ctx = fakeCtx({
    config: { pack: 'salesforce', salesforce, slots: 1 },
    rules: [
      [new RegExp(orgRoute('acme-uat')), org],
      [/^sf plugins --core/, plugins],
      [/^git fetch /, git.fetch ?? ''],
      [/^git merge-base /, mergeBase],
      [/^git worktree add /, git.add ?? ''],
      [/^sf sgd source delta /, sgdAnswer ?? sgd({ pkg, destructive })],
      [/^sf project deploy start /, start],
      [/^sf project deploy report /, () => reports[Math.min(n++, reports.length - 1)]],
    ],
    root: '/acme/repo',
    env: { FOREMAN_SF_HOME: sfHome, FOREMAN_STATE_DIR: state },
  });
  const l = layout(ctx.config.salesforce, ctx.config);
  const stage = l.stages.find((s) => s.name === 'uat');
  const run = (over = {}) => validateHead(ctx, { stage, head: HEAD, sha: SHA, what: WHAT, label: LABEL, ...over });
  return { ctx, stage, run };
}

const sfLines = (ctx) => ctx.sh.calls.filter((l) => l.startsWith('sf '));
const startLine = (ctx) => ctx.sh.calls.find((l) => l.startsWith('sf project deploy start'));
const gitLines = (ctx) => ctx.sh.calls.filter((l) => l.startsWith('git '));
const treeOf = (ctx) => ctx.sh.calls.find((l) => l.startsWith('git worktree add'))?.split(' ').at(-2);
const noCalls = (ctx) => {
  expect(sfLines(ctx)).toEqual([]);
  expect(gitLines(ctx)).toEqual([]);
};

describe('validateHead', () => {
  it("dry-runs what the pull request carries on the stage org from a checkout of exactly that commit, and removes the checkout", async () => {
    const { ctx, run } = setup();
    const r = await run();
    expect(r).toEqual({ ok: true, jobId: JOB, components: { deployed: 2, total: 2 }, tests: { completed: 5, errors: 0 } });

    const at = (pred) => ctx.sh.calls.findIndex(pred);
    const org = at((l) => l.startsWith('sf data query') && l.includes('FROM Organization --target-org acme-uat'));
    const plugins = at((l) => l.startsWith('sf plugins --core'));
    const fetch = at((l) => l.startsWith('git fetch'));
    const fetchStage = at((l) => l === 'git fetch --quiet origin +refs/heads/uat:refs/remotes/origin/uat');
    const base = at((l) => l.startsWith('git merge-base'));
    const add = at((l) => l.startsWith('git worktree add'));
    const delta = at((l) => l.startsWith('sf sgd source delta'));
    const start = at((l) => l.startsWith('sf project deploy start'));
    const remove = at((l) => l.startsWith('git worktree remove'));
    expect(org).toBeGreaterThanOrEqual(0);
    expect(org).toBeLessThan(plugins);
    expect(plugins).toBeLessThan(fetch);
    expect(fetch).toBeLessThan(fetchStage);
    expect(fetchStage).toBeLessThan(base);
    expect(base).toBeLessThan(add);
    expect(add).toBeLessThan(delta);
    expect(delta).toBeLessThan(start);
    expect(start).toBeLessThan(remove);

    expect(ctx.sh.calls[fetch]).toBe(`git fetch --quiet origin +refs/heads/${HEAD}:refs/remotes/origin/${HEAD}`);
    expect(ctx.sh.calls[base]).toBe(`git merge-base refs/remotes/origin/uat ${SHA}`);
    const tree = treeOf(ctx);
    expect(ctx.sh.calls[add]).toBe(`git worktree add --detach ${tree} ${SHA}`);
    expect(path.basename(tree)).toBe('tree');
    const dir = path.join(path.dirname(tree), 'delta');
    expect(ctx.sh.calls[delta]).toBe(`sf sgd source delta --from ${BASE} --to ${SHA} --output-dir ${dir} --generate-delta --json`);
    expect(ctx.sh.opts[delta].cwd).toBe(tree);
    expect(ctx.sh.calls[start]).toBe(`sf project deploy start --dry-run --manifest ${dir}/package/package.xml --test-level RunLocalTests --target-org acme-uat --async --json`);
    expect(ctx.sh.opts[start].cwd).toBe(tree);
    expect(ctx.sh.opts[start].env.HOME).toBe(sfHome);
    expect(ctx.sh.limits[start]).toBe(600_000);
    expect(ctx.sh.calls[remove]).toBe(`git worktree remove --force ${tree}`);
    expect(fs.existsSync(path.dirname(tree))).toBe(false);
    expect(ctx.sh.calls.filter((l) => l.startsWith('sf project deploy report'))).toEqual([`sf project deploy report --job-id ${JOB} --target-org acme-uat --json`]);
  });

  it('validates what the pull request carries, not a story delta the context holds', async () => {
    const seen = [];
    const start = (line) => {
      const manifestPath = line.split(' ')[line.split(' ').indexOf('--manifest') + 1];
      seen.push({ manifestPath, text: fs.readFileSync(manifestPath, 'utf8') });
      return sfOk({ id: JOB, done: false, status: 'Queued' });
    };
    const { ctx, run } = setup({ pkg: { ApexClass: ['AcmeService', 'AcmeOther'] }, start });
    ctx.sfDelta = { manifest: '/elsewhere/story/package.xml', postDestructive: '/elsewhere/story/post.xml', deletes: [], dir: '/elsewhere/story' };
    expect(await run()).toMatchObject({ ok: true, jobId: JOB });
    expect(seen).toHaveLength(1);
    expect(seen[0].text).toContain('AcmeOther');
    expect(seen[0].manifestPath).not.toBe(ctx.sfDelta.manifest);
    expect(startLine(ctx)).not.toContain('/elsewhere/');
  });

  it('needs no ctx.sfDelta', async () => {
    const { ctx, run } = setup();
    expect(ctx.sfDelta).toBeUndefined();
    expect(await run()).toMatchObject({ ok: true, jobId: JOB });
  });

  it('uses the configured remote for the fetch', async () => {
    const { ctx, run } = setup();
    ctx.config.remote = 'upstream';
    await run();
    expect(gitLines(ctx)[0]).toBe(`git fetch --quiet upstream +refs/heads/${HEAD}:refs/remotes/upstream/${HEAD}`);
    expect(gitLines(ctx)[1]).toBe('git fetch --quiet upstream +refs/heads/uat:refs/remotes/upstream/uat');
    expect(gitLines(ctx)[2]).toBe(`git merge-base refs/remotes/upstream/uat ${SHA}`);
  });

  it('passes testLevel.validate through, and never --ignore, quick or NoTestRun', async () => {
    const { ctx, run } = setup({ salesforce: block({ testLevel: { validate: 'RunRelevantTests', deploy: 'RunLocalTests' } }) });
    expect(await run()).toMatchObject({ ok: true });
    expect(startLine(ctx)).toContain('--test-level RunRelevantTests');
    expect(startLine(ctx)).not.toContain('--post-destructive-changes');
    for (const line of ctx.sh.calls) {
      expect(line).not.toContain('--ignore');
      expect(line).not.toContain(' quick');
      expect(line).not.toContain('NoTestRun');
    }
  });

  describe('refuses, with no sf or git call', () => {
    it('an org marked production', async () => {
      const { ctx, run } = setup({ salesforce: block({ orgs: { ...block().orgs, 'acme-uat': { orgId: ACME_UAT_ID, production: true } } }) });
      const r = await run();
      expect(r).toMatchObject({ ok: false, code: 1 });
      expect(r.reason).toBe('acme-uat is marked "production": true in salesforce.orgs; production is never a target.');
      noCalls(ctx);
    });

    it('a stage on the production branch', async () => {
      const { ctx, stage, run } = setup();
      const r = await run({ stage: { ...stage, branch: 'main' } });
      expect(r).toMatchObject({ ok: false, code: 1 });
      expect(r.reason).toContain('production');
      noCalls(ctx);
    });

    it('a stage with no org ID', async () => {
      const { ctx, stage, run } = setup();
      const r = await run({ stage: { ...stage, orgId: null } });
      expect(r).toMatchObject({ ok: false, code: 1 });
      expect(r.reason).toContain('no org ID');
      noCalls(ctx);
    });

    it('a stage branch git could read as an option', async () => {
      const { ctx, stage, run } = setup();
      const r = await run({ stage: { ...stage, branch: '-x' } });
      expect(r).toMatchObject({ ok: false, code: 1 });
      expect(r.reason).toBe('The branch of stage uat is not a branch name Foreman will pass to git.');
      noCalls(ctx);
    });

    it('a head branch name git could read as an option', async () => {
      const { ctx, run } = setup();
      expect(await run({ head: '--upload-pack=x' })).toMatchObject({ ok: false, code: 1 });
      noCalls(ctx);
    });
  });

  describe('the org guard', () => {
    it('refuses an org whose server says it is not a sandbox, and starts no deploy', async () => {
      const { ctx, run } = setup({ org: orgRecord(ACME_UAT_ID, false) });
      const r = await run();
      expect(r).toMatchObject({ ok: false, code: 1 });
      expect(r.reason).toContain('not a sandbox; production is never a target');
      expect(startLine(ctx)).toBeUndefined();
      expect(gitLines(ctx)).toEqual([]);
    });

    it('refuses an org that is not the org ID in salesforce.orgs', async () => {
      const { ctx, run } = setup({ org: orgRecord(ACME_QA_ID) });
      expect(await run()).toMatchObject({ ok: false, code: 1 });
      expect(startLine(ctx)).toBeUndefined();
      expect(gitLines(ctx)).toEqual([]);
    });

    it('is code 2 "never started" when the org cannot be checked', async () => {
      const { ctx, run } = setup({ org: sfError('NoAuthInfoFound', 'No authorization information found for acme-uat.') });
      const r = await run();
      expect(r).toMatchObject({ ok: false, code: 2 });
      expect(r.reason).toContain('never started');
      expect(r.reason).toContain('No authorization information found for acme-uat.');
      expect(startLine(ctx)).toBeUndefined();
      expect(gitLines(ctx)).toEqual([]);
    });
  });

  describe('the delta', () => {
    const dirOf = (ctx) => path.join(path.dirname(treeOf(ctx)), 'delta');

    it('sends the pull request deletes to --post-destructive-changes, and leaves a Flow delete out', async () => {
      const { ctx, run } = setup({ destructive: { ApexClass: ['AcmeOld'], Flow: ['Acme_Flow'] } });
      expect(await run()).toMatchObject({ ok: true, jobId: JOB });
      expect(startLine(ctx)).toBe(`sf project deploy start --dry-run --manifest ${dirOf(ctx)}/package/package.xml --post-destructive-changes ${dirOf(ctx)}/postDestructiveChanges.xml --test-level RunLocalTests --target-org acme-uat --async --json`);
    });

    it('has no --post-destructive-changes when the only delete is a Flow', async () => {
      const { ctx, run } = setup({ destructive: { Flow: ['Acme_Flow'] } });
      expect(await run()).toMatchObject({ ok: true, jobId: JOB });
      expect(startLine(ctx)).not.toContain('--post-destructive-changes');
    });

    it('is skipped, with no deploy, when it changes no metadata, and the checkout is gone', async () => {
      const { ctx, run } = setup({ pkg: {} });
      expect(await run()).toEqual({ ok: true, skipped: true });
      expect(startLine(ctx)).toBeUndefined();
      expect(ctx.sh.calls.some((l) => l.startsWith('git worktree remove'))).toBe(true);
      expect(fs.existsSync(path.dirname(treeOf(ctx)))).toBe(false);
    });

    it('is validated when it only deletes', async () => {
      const { ctx, run } = setup({ pkg: {}, destructive: { ApexClass: ['AcmeOld'] } });
      expect(await run()).toMatchObject({ ok: true, jobId: JOB });
      expect(startLine(ctx)).toContain(`--post-destructive-changes ${dirOf(ctx)}/postDestructiveChanges.xml`);
    });

    it('is code 2 never started, naming 6.45 and with no git call, when sfdx-git-delta is not the pinned line', async () => {
      const { ctx, run } = setup({ plugins: sfRaw(acmePlugins({ 'sfdx-git-delta': '6.20.0' })) });
      const r = await run();
      expect(r).toMatchObject({ ok: false, code: 2 });
      expect(r.reason).toContain('never started');
      expect(r.reason).toContain('6.45');
      expect(gitLines(ctx)).toEqual([]);
      expect(startLine(ctx)).toBeUndefined();
    });

    it('is code 2 never started, naming the stage branch, when it cannot be fetched, with no checkout', async () => {
      const { ctx, run } = setup({ git: { fetch: (line) => (line.includes('refs/heads/uat:') ? { status: 128, stderr: "fatal: couldn't find remote ref refs/heads/uat" } : '') } });
      const r = await run();
      expect(r).toMatchObject({ ok: false, code: 2 });
      expect(r.reason).toContain('never started');
      expect(r.reason).toContain('could not fetch uat from origin');
      expect(ctx.sh.calls.some((l) => l.startsWith('git worktree add'))).toBe(false);
      expect(startLine(ctx)).toBeUndefined();
    });

    it('is code 2 never started when git finds no merge base, with no checkout', async () => {
      const { ctx, run } = setup({ mergeBase: '' });
      const r = await run();
      expect(r).toMatchObject({ ok: false, code: 2 });
      expect(r.reason).toContain('never started');
      expect(r.reason).toContain('could not find where pull request #3 left uat');
      expect(ctx.sh.calls.some((l) => l.startsWith('git worktree add'))).toBe(false);
      expect(startLine(ctx)).toBeUndefined();
    });

    it('is code 2 never started when sgd fails, and the checkout is gone', async () => {
      const { ctx, run } = setup({ sgdAnswer: sfError('SgdError', 'sgd broke') });
      const r = await run();
      expect(r).toMatchObject({ ok: false, code: 2 });
      expect(r.reason).toContain('never started');
      expect(r.reason).toContain('could not build the delta');
      expect(startLine(ctx)).toBeUndefined();
      expect(fs.existsSync(path.dirname(treeOf(ctx)))).toBe(false);
    });
  });

  describe('a validation that never starts, with the checkout gone afterwards', () => {
    it('a sha that is not a commit id: no git call', async () => {
      const { ctx, run } = setup();
      const r = await run({ sha: 'main' });
      expect(r).toMatchObject({ ok: false, code: 2 });
      expect(r.reason).toContain('never started');
      expect(gitLines(ctx)).toEqual([]);
      expect(startLine(ctx)).toBeUndefined();
    });

    it('a failed fetch', async () => {
      const { ctx, run } = setup({ git: { fetch: { status: 128, stderr: "fatal: couldn't find remote ref refs/heads/gs-pipeline/story/s-1_-_uat\nmore" } } });
      const r = await run();
      expect(r).toMatchObject({ ok: false, code: 2 });
      expect(r.reason).toContain("Foreman's validation of pull request #3 on acme-uat (uat) never started");
      expect(r.reason).toContain("couldn't find remote ref");
      expect(r.reason).not.toContain('more');
      expect(startLine(ctx)).toBeUndefined();
      expect(ctx.sh.calls.some((l) => l.startsWith('git worktree add'))).toBe(false);
    });

    it('a failed checkout, with the folder removed', async () => {
      const { ctx, run } = setup({ git: { add: { status: 128, stderr: 'fatal: invalid reference' } } });
      const r = await run();
      expect(r).toMatchObject({ ok: false, code: 2 });
      expect(r.reason).toContain('never started');
      expect(r.reason).toContain('invalid reference');
      expect(startLine(ctx)).toBeUndefined();
      expect(fs.existsSync(path.dirname(treeOf(ctx)))).toBe(false);
      expect(ctx.sh.calls.some((l) => l.startsWith('git worktree remove'))).toBe(true);
    });

    it('a start that gives no job id, with the folder removed', async () => {
      const { ctx, run } = setup({ start: sfOk({ id: '--target-org acme-prod', status: 'Queued' }) });
      const r = await run();
      expect(r).toMatchObject({ ok: false, code: 2 });
      expect(r.reason).toContain('never started');
      expect(ctx.sh.calls.some((l) => l.startsWith('sf project deploy report'))).toBe(false);
      expect(fs.existsSync(path.dirname(treeOf(ctx)))).toBe(false);
    });

    it('a start that sf refuses, with sf\'s words', async () => {
      const { ctx, run } = setup({ start: sfError('NoAuthInfoFound', 'No authorization information found for acme-uat.') });
      const r = await run();
      expect(r).toMatchObject({ ok: false, code: 2 });
      expect(r.reason).toContain('No authorization information found for acme-uat.');
      expect(fs.existsSync(path.dirname(treeOf(ctx)))).toBe(false);
    });

    it('redacts a secret in git\'s words', async () => {
      const { run } = setup({ git: { fetch: { status: 128, stderr: 'fatal: unable to access https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/acme/app.git/' } } });
      const r = await run();
      expect(r.reason).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    });
  });

  describe('the job', () => {
    it('removes the checkout right after the start, before the job is read', async () => {
      const { ctx, run } = setup({ reports: [sfOk(report('InProgress')), sfOk(report('Succeeded'))] });
      await run();
      const remove = ctx.sh.calls.findIndex((l) => l.startsWith('git worktree remove'));
      const firstReport = ctx.sh.calls.findIndex((l) => l.startsWith('sf project deploy report'));
      expect(remove).toBeGreaterThan(0);
      expect(remove).toBeLessThan(firstReport);
      expect(ctx.sleeps).toEqual([10_000]);
    });

    it('is code 2 with the failures when the validation fails, and says Foreman validated it', async () => {
      const { run } = setup({ reports: [sfOk(report('Failed', FAILED))] });
      const r = await run();
      expect(r).toMatchObject({ ok: false, code: 2 });
      expect(r.reason).toBe("Foreman's validation of pull request #3 on acme-uat (uat) failed: 2 problem(s): ApexClass AcmeService line 14, AcmeServiceTest.sumsTheOrder");
      expect(r.failures).toEqual([
        { kind: 'component', name: 'ApexClass AcmeService line 14', message: 'Variable does not exist: total' },
        { kind: 'test', name: 'AcmeServiceTest.sumsTheOrder', message: 'Assertion Failed' },
      ]);
      expect(r).not.toHaveProperty('inherited');
    });

    it('is code 2 with inherited: true when only what the org already failed fails', async () => {
      const file = path.join(state, 'salesforce', 'baseline', 'acme-uat.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ alias: 'acme-uat', orgId: ACME_UAT_ID, testRunId: '707000000000001AAA', startedAt: '2026-10-23T08:00:00.000Z', state: 'done', finishedAt: '2026-10-23T09:00:00.000Z', failing: ['AcmeServiceTest.sumsTheOrder'], coverage: 19 }));
      const { run } = setup({ reports: [sfOk(report('Failed', INHERITED))] });
      const r = await run();
      expect(r).toMatchObject({ ok: false, code: 2, inherited: true });
      expect(r.reason).toContain("Foreman's validation of pull request #3 on acme-uat (uat) failed only in what acme-uat already fails");
      expect(r.reason).toContain("not this story's change");
      expect(r.failures).toHaveLength(2);
    });

    it('is code 2 when the job does not finish within 30 minutes', async () => {
      const { ctx, run } = setup({ reports: [sfOk(report('InProgress'))] });
      const r = await run();
      expect(r).toMatchObject({ ok: false, code: 2 });
      expect(r.reason).toBe('Foreman\'s validation of pull request #3 on acme-uat (uat) did not finish within 30 minutes (last seen "InProgress").');
      expect(ctx.sleeps.reduce((a, b) => a + b, 0)).toBe(30 * 60_000);
    });

    it('is code 2 at once on a login-rate answer', async () => {
      const { ctx, run } = setup({ reports: [sfError('X', 'login rate exceeded')] });
      const r = await run();
      expect(r).toMatchObject({ ok: false, code: 2 });
      expect(r.reason).toMatch(new RegExp(`^Foreman's validation of pull request #3 on acme-uat \\(uat\\): stopped watching job ${JOB}: stopped at once:.*login rate exceeded`));
      expect(ctx.sleeps).toEqual([]);
    });
  });
});
