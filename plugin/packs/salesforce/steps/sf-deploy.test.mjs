import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sfDeploy } from './sf-deploy.mjs';
import { deployJobFile, readDeployJob, writeDeployJob } from '../deploy-jobs.mjs';
import { readDeployed, readRelease, writeDeployed } from '../releases.mjs';
import { runShip } from '../../../lib/engine/ship.mjs';
import { fakeCtx } from '../../../../test/ship-fakes.mjs';
import { ACME_DEV1_ID, ACME_QA_ID, ACME_UAT_ID, sfError, sfOk } from '../../../../test/fake-sf.mjs';

const JOB = '0Af000000000001AAA';
const OTHER_JOB = '0Af000000000009AAA';

// package.xml or postDestructiveChanges.xml holding `types` ({ ApexClass: ['AcmeNew'] }).
const manifest = (types = {}) =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
    ...Object.entries(types).map(([name, members]) => `  <types>\n${members.map((m) => `    <members>${m}</members>`).join('\n')}\n    <name>${name}</name>\n  </types>`),
    '  <version>62.0</version>',
    '</Package>',
    '',
  ].join('\n');

// A deploy report as `sf project deploy report --json` gives it.
const report = (status, details = {}) => ({
  id: JOB,
  status,
  createdByName: 'Acme Admin',
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

// A failure only in what acme-qa already fails: its failing test, and the org-wide coverage.
const INHERITED = {
  runTestResult: {
    failures: [{ name: 'AcmeServiceTest', methodName: 'sumsTheOrder', message: 'Assertion Failed' }],
    codeCoverageWarnings: { message: 'Average test coverage across all Apex Classes and Triggers is 19%, at least 75% test coverage is required.' },
  },
};

const LAYOUT_A = { orgs: { 'acme-dev1': { orgId: ACME_DEV1_ID } }, build: 'acme-dev1', stages: [{ name: 'dev', org: 'acme-dev1' }] };
const LAYOUT_B = {
  productionBranch: 'main',
  orgs: { 'acme-dev1': { orgId: ACME_DEV1_ID }, 'acme-qa': { orgId: ACME_QA_ID }, 'acme-uat': { orgId: ACME_UAT_ID } },
  build: ['acme-dev1'],
  stages: [{ name: 'qa', org: 'acme-qa', branch: 'qa' }, { name: 'uat', org: 'acme-uat', branch: 'uat' }],
};

let sfHome;
let state;
let delta;
beforeEach(() => {
  sfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-deploy-sfhome-'));
  state = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-deploy-state-'));
  delta = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-deploy-delta-'));
});
afterEach(() => {
  for (const d of [sfHome, state, delta]) fs.rmSync(d, { recursive: true, force: true });
});

// The facts sf-delta leaves: a real package.xml and postDestructiveChanges.xml in a temp dir.
function sfDeltaFacts({ types = { ApexClass: ['AcmeService'] }, deletes = [], to = 'bbb' } = {}) {
  fs.mkdirSync(path.join(delta, 'package'), { recursive: true });
  const m = path.join(delta, 'package', 'package.xml');
  const post = path.join(delta, 'postDestructiveChanges.xml');
  fs.writeFileSync(m, manifest(types));
  const removed = {};
  for (const { type, member } of deletes) removed[type] = [...(removed[type] ?? []), member];
  fs.writeFileSync(post, manifest(removed));
  return { dir: delta, from: 'aaa', to, manifest: m, postDestructive: post, deletes, sha256: 'f'.repeat(64) };
}

const startOk = (id = JOB) => sfOk({ id, done: false, status: 'Queued' });

// The fake git answers for merging the story into a later stage's branch: not merged yet, and
// the merge commit is UAT_MERGE.
const UAT_MERGE = 'c'.repeat(40);
// The reviewed head: the local story branch and the remote one agree on it.
const STORY_HEAD = 'e'.repeat(40);
const MERGE_RULES = [
  [/^git rev-parse --verify refs\/(heads|remotes\/origin)\/story\/s-1$/, `${STORY_HEAD}\n`],
  ['git merge-base --is-ancestor', 1],
  ['git rev-parse HEAD', `${UAT_MERGE}\n`],
];

// The start answers `start`; the report answers each item of `reports` in turn, then the last.
// A report item may be a function of the line, called when the report runs.
// The merge step's sha: the head of the branch the pull request merged into, which every deploy
// checks out. M2 is another one.
const STAGE_SHA = '1'.repeat(40);
const M2 = '2'.repeat(40);

function ctxFor({ salesforce = LAYOUT_B, start = startOk(), reports = [sfOk(report('Succeeded'))], facts = sfDeltaFacts(), git = MERGE_RULES, sha = STAGE_SHA, ...rest } = {}) {
  let n = 0;
  const ctx = fakeCtx({
    config: { pack: 'salesforce', salesforce, slots: 1 },
    branch: 'story/s-1',
    rules: [
      ...git,
      [/^sf project deploy start /, start],
      [/^sf project deploy report /, (line) => {
        const r = reports[Math.min(n++, reports.length - 1)];
        return typeof r === 'function' ? r(line) : r;
      }],
    ],
    root: '/acme/repo',
    env: { FOREMAN_SF_HOME: sfHome, FOREMAN_STATE_DIR: state },
    ...rest,
  });
  if (facts) ctx.sfDelta = facts;
  if (sha !== null) ctx.sha = sha;
  return ctx;
}

// The folder `git worktree add --detach <tree> <sha>` was given.
const addLine = (ctx) => ctx.sh.calls.find((l) => l.startsWith('git worktree add --detach'));
const treeOf = (ctx) => addLine(ctx)?.split(' ')[4];
const gitCalls = (ctx, what) => ctx.sh.calls.filter((l) => l.startsWith(`git ${what}`));

const sfLines = (ctx) => ctx.sh.calls.filter((l) => l.startsWith('sf '));
const startLine = (ctx) => ctx.sh.calls.find((l) => l.startsWith('sf project deploy start'));
const reportLines = (ctx) => ctx.sh.calls.filter((l) => l.startsWith('sf project deploy report'));
const recordFile = (stage = 'qa') => path.join(state, 'salesforce', 'deploys', 'S-1', `${stage}.json`);
const seen = [];
afterEach(() => {
  for (const ctx of seen.splice(0)) {
    for (const line of sfLines(ctx)) {
      expect(line).not.toContain('--ignore-');
      expect(line).not.toContain(' quick');
      expect(line).not.toContain('NoTestRun');
      if (line.includes('project deploy start')) expect(line).toContain('--test-level');
    }
  }
});
const make = (opts) => {
  const ctx = ctxFor(opts);
  seen.push(ctx);
  return ctx;
};

describe('sfDeploy(stage)', () => {
  it('is the step that deploys to that stage, needs sf and git, halts and deploys, one module per name', () => {
    const qa = sfDeploy('qa');
    expect(qa).toMatchObject({ name: 'sf-deploy-qa', label: 'deploying the Salesforce delta to qa', needs: ['sf', 'git'], halts: true, deploys: true });
    expect(sfDeploy('qa')).toBe(qa);
    expect(sfDeploy('uat')).not.toBe(qa);
    expect(sfDeploy('uat').name).toBe('sf-deploy-uat');
  });

  it("sfDeploy(stage, { later: true }) is a later stage's step: noRollback, needs sf and git, one module per name", () => {
    const later = sfDeploy('uat', { later: true });
    expect(later).toMatchObject({ name: 'sf-deploy-uat', noRollback: true, needs: ['sf', 'git'], halts: true, deploys: true });
    expect(sfDeploy('uat', { later: true })).toBe(later);
    expect(sfDeploy('uat')).not.toBe(later);
    expect(sfDeploy('uat')).not.toHaveProperty('noRollback');
    expect(sfDeploy('qa').needs).toEqual(['sf', 'git']);
  });

  describe('a later stage on its own branch', () => {
    const uatStart = (ctx) => ctx.sh.calls.findIndex((l) => l.startsWith('sf project deploy start') && l.includes('--target-org acme-uat'));
    const mergeAt = (ctx) => ctx.sh.calls.findIndex((l) => l.startsWith('git merge --no-ff'));

    it('merges the story branch into uat before it deploys, and records the merge as the commit', async () => {
      const qa = make();
      qa.sha = STAGE_SHA;
      await sfDeploy('qa').run(qa);
      const ctx = make();
      ctx.sha = STAGE_SHA;
      const r = await sfDeploy('uat', { later: true }).run(ctx);
      expect(r).toMatchObject({ ok: true, sha: UAT_MERGE, shaBranch: 'uat', sfDeploys: { uat: { org: 'acme-uat', jobId: JOB } } });
      expect(mergeAt(ctx)).toBeGreaterThan(-1);
      expect(ctx.sh.calls[mergeAt(ctx)]).toContain(STORY_HEAD);
      expect(uatStart(ctx)).toBeGreaterThan(mergeAt(ctx));
      expect(readDeployed(state, 'uat').commit).toBe(UAT_MERGE);
      const rec = readRelease(state, 'S-1');
      expect(rec.reached).toEqual(['qa', 'uat']);
      expect(rec.first).toMatchObject({ stage: 'qa', merge: STAGE_SHA });
    });

    it('a merge that fails is code 5 and starts no deploy', async () => {
      const ctx = make({ git: [MERGE_RULES[0], ['git merge-base --is-ancestor', 1], ['git merge --no-ff', 1], ['git diff --name-only --diff-filter=U', 'README.md\n']] });
      const r = await sfDeploy('uat', { later: true }).run(ctx);
      expect(r).toMatchObject({ ok: false, code: 5, stage: 'sf-deploy-uat' });
      expect(r.reason).toContain('story/s-1 conflicts with uat in: README.md');
      expect(uatStart(ctx)).toBe(-1);
      expect(readDeployed(state, 'uat')).toBeNull();
    });

    it('a remote story branch that moved after review is code 5 and starts no deploy', async () => {
      const ctx = make({ git: [['git rev-parse --verify refs/remotes/origin/story/s-1', `${'f'.repeat(40)}\n`], ...MERGE_RULES] });
      const r = await sfDeploy('uat', { later: true }).run(ctx);
      expect(r).toMatchObject({ ok: false, code: 5, stage: 'sf-deploy-uat' });
      expect(r.reason.startsWith('The merge for uat failed:')).toBe(true);
      expect(r.reason).toContain('reviewed');
      expect(ctx.sh.calls.some((l) => l.startsWith('git merge --no-ff'))).toBe(false);
      expect(ctx.sh.calls.some((l) => l.startsWith('sf project deploy start'))).toBe(false);
      expect(readDeployed(state, 'uat')).toBeNull();
    });

    it('an empty delta still merges, and skips the deploy', async () => {
      writeDeployed(state, { stage: 'uat', org: 'acme-uat', orgId: ACME_UAT_ID, jobId: OTHER_JOB, story: 'S-0', commit: 'u0', at: '2026-10-15T11:00:00.000Z' });
      const ctx = make({ facts: sfDeltaFacts({ types: {} }) });
      ctx.sha = STAGE_SHA;
      const r = await sfDeploy('uat', { later: true }).run(ctx);
      expect(r).toEqual({ ok: true, sha: UAT_MERGE, shaBranch: 'uat', sfDeploys: { uat: { org: 'acme-uat', skipped: true } } });
      expect(mergeAt(ctx)).toBeGreaterThan(-1);
      expect(sfLines(ctx)).toEqual([]);
      expect(readDeployed(state, 'uat')).toMatchObject({ jobId: OTHER_JOB, story: 'S-1', commit: UAT_MERGE });
    });
  });

  it('a later stage that follows the branch before it does no merge, deploys a checkout of ctx.sha and records it', async () => {
    const ctx = make({ salesforce: { ...LAYOUT_B, stages: [{ name: 'qa', org: 'acme-qa', branch: 'qa' }, { name: 'uat', org: 'acme-uat' }] } });
    ctx.sha = STAGE_SHA;
    const r = await sfDeploy('uat', { later: true }).run(ctx);
    expect(r.ok).toBe(true);
    expect(r).not.toHaveProperty('sha');
    expect(r).not.toHaveProperty('shaBranch');
    expect(ctx.sh.calls.some((l) => l.startsWith('git merge') || l.startsWith('git fetch'))).toBe(false);
    expect(ctx.sh.calls.filter((l) => l.startsWith('git '))).toEqual([`git worktree add --detach ${treeOf(ctx)} ${STAGE_SHA}`, `git worktree remove --force ${treeOf(ctx)}`]);
    expect(readDeployed(state, 'uat').commit).toBe(STAGE_SHA);
  });

  describe('the checkout the deploy starts in', () => {
    const at = (ctx, prefix) => ctx.sh.calls.findIndex((l) => l.startsWith(prefix));

    it('starts sf in a checkout of the stage commit, made before the start and removed after it', async () => {
      const ctx = make();
      const r = await sfDeploy('qa').run(ctx);
      expect(r.ok).toBe(true);
      const tree = treeOf(ctx);
      expect(tree).toBeTypeOf('string');
      expect(addLine(ctx)).toBe(`git worktree add --detach ${tree} ${STAGE_SHA}`);
      const add = at(ctx, 'git worktree add');
      const start = at(ctx, 'sf project deploy start');
      const remove = at(ctx, 'git worktree remove');
      expect(add).toBeGreaterThan(-1);
      expect(start).toBeGreaterThan(add);
      expect(remove).toBeGreaterThan(start);
      expect(ctx.sh.calls[remove]).toBe(`git worktree remove --force ${tree}`);
      expect(ctx.sh.opts[add].cwd).toBe('/acme/repo');
      expect(ctx.sh.opts[start].cwd).toBe(tree);
      expect(ctx.sh.opts[remove].cwd).toBe('/acme/repo');
      // The report is not read from the checkout, and the folder is gone.
      expect(ctx.sh.opts[at(ctx, 'sf project deploy report')].cwd).toBeUndefined();
      expect(remove).toBeLessThan(at(ctx, 'sf project deploy report'));
      expect(fs.existsSync(path.dirname(tree))).toBe(false);
      expect(gitCalls(ctx, 'worktree prune')).toEqual([]);
    });

    it('prunes git\'s record of the checkout when the remove fails, after the folder is gone, and changes nothing else', async () => {
      let goneAtPrune = null;
      const ctx = make({
        git: [
          ['git worktree remove', { status: 128, stderr: 'fatal: simulated' }],
          ['git worktree prune', () => {
            goneAtPrune = !fs.existsSync(path.dirname(treeOf(ctx)));
            return 0;
          }],
          ...MERGE_RULES,
        ],
      });
      const r = await sfDeploy('qa').run(ctx);
      expect(r).toEqual({ ok: true, sfDeploys: { qa: { org: 'acme-qa', jobId: JOB, components: expect.anything(), tests: expect.anything(), resumed: false } } });
      const tree = treeOf(ctx);
      expect(gitCalls(ctx, 'worktree')).toEqual([`git worktree add --detach ${tree} ${STAGE_SHA}`, `git worktree remove --force ${tree}`, 'git worktree prune']);
      expect(ctx.sh.opts[at(ctx, 'git worktree prune')].cwd).toBe('/acme/repo');
      expect(goneAtPrune).toBe(true);
      expect(fs.existsSync(path.dirname(tree))).toBe(false);
    });

    it('removes the checkout when the start fails, and the reason is the same', async () => {
      const ctx = make({ start: sfError('NoAuthInfoFound', 'No authorization information found for acme-qa.') });
      const r = await sfDeploy('qa').run(ctx);
      expect(r.reason).toBe('The deploy to acme-qa (qa) never started: No authorization information found for acme-qa.');
      expect(gitCalls(ctx, 'worktree remove')).toEqual([`git worktree remove --force ${treeOf(ctx)}`]);
      expect(fs.existsSync(path.dirname(treeOf(ctx)))).toBe(false);
    });

    it('names the commit and the folder when sf finds no source, and still removes the checkout', async () => {
      const ctx = make({ start: sfError('DeployFailed', 'No source-backed components present in the package.') });
      const r = await sfDeploy('qa').run(ctx);
      expect(r.reason).toBe(`The deploy to acme-qa (qa) never started: No source-backed components present in the package. (sf looked in ${treeOf(ctx)}, a checkout of ${STAGE_SHA}, the qa commit)`);
      expect(gitCalls(ctx, 'worktree remove')).toHaveLength(1);
      expect(fs.existsSync(path.dirname(treeOf(ctx)))).toBe(false);
    });

    it('a checkout that fails is code 5 with no start and no record, and cleans up', async () => {
      const ctx = make({ git: [['git worktree add', { status: 128, stderr: 'fatal: invalid reference: x' }], ...MERGE_RULES] });
      const r = await sfDeploy('qa').run(ctx);
      expect(r).toMatchObject({ ok: false, code: 5, stage: 'sf-deploy-qa' });
      expect(r.reason).toBe(`The deploy to acme-qa (qa) never started: could not check out ${STAGE_SHA} (the qa commit) to deploy from: fatal: invalid reference: x`);
      expect(sfLines(ctx)).toEqual([]);
      expect(fs.existsSync(recordFile())).toBe(false);
      expect(gitCalls(ctx, 'worktree remove')).toEqual([`git worktree remove --force ${treeOf(ctx)}`]);
      expect(fs.existsSync(path.dirname(treeOf(ctx)))).toBe(false);
    });

    it('removes the checkout when something throws after the start', async () => {
      const ctx = make();
      const clock = ctx.now;
      // The job record is written with ctx.now() right after the start, inside the checkout's scope.
      ctx.now = () => {
        if (addLine(ctx)) throw new Error('the clock broke');
        return clock();
      };
      await expect(sfDeploy('qa').run(ctx)).rejects.toThrow('the clock broke');
      expect(gitCalls(ctx, 'worktree remove')).toEqual([`git worktree remove --force ${treeOf(ctx)}`]);
      expect(fs.existsSync(path.dirname(treeOf(ctx)))).toBe(false);
    });

    it.each([['no commit', null], ['a commit that is not a sha', 'm1']])('with %s is code 5 before any git or sf call, and no record', async (_, sha) => {
      const ctx = make({ sha });
      const r = await sfDeploy('qa').run(ctx);
      expect(r).toMatchObject({ ok: false, code: 5, stage: 'sf-deploy-qa' });
      expect(r.reason).toBe('The deploy to acme-qa (qa) never started: the qa commit is not known, so there is nothing to check out and deploy.');
      expect(gitCalls(ctx, 'worktree')).toEqual([]);
      expect(sfLines(ctx)).toEqual([]);
      expect(fs.existsSync(recordFile())).toBe(false);
      expect(readDeployed(state, 'qa')).toBeNull();
      expect(readRelease(state, 'S-1')).toMatchObject({ reached: ['qa'], first: null });
    });

    it('an empty delta with no commit is still skipped, with no checkout', async () => {
      const ctx = make({ sha: null, facts: sfDeltaFacts({ types: {} }) });
      const r = await sfDeploy('qa').run(ctx);
      expect(r).toEqual({ ok: true, sfDeploys: { qa: { org: 'acme-qa', skipped: true } } });
      expect(ctx.sh.calls.filter((l) => l.startsWith('git '))).toEqual([]);
    });

    it('a resumed job makes no checkout', async () => {
      writeDeployJob(state, { story: 'S-1', stage: 'qa', org: 'acme-qa', orgId: ACME_QA_ID, jobId: JOB, to: 'bbb', startedAt: '2026-10-15T11:00:00.000Z' });
      const ctx = make();
      const r = await sfDeploy('qa').run(ctx);
      expect(r).toMatchObject({ ok: true, sfDeploys: { qa: { resumed: true } } });
      expect(gitCalls(ctx, 'worktree')).toEqual([]);
    });

    it('a refused resume makes one checkout for its new deploy, and removes it', async () => {
      writeDeployJob(state, { story: 'S-1', stage: 'qa', org: 'acme-qa', orgId: ACME_QA_ID, jobId: OTHER_JOB, to: 'bbb', startedAt: '2026-10-15T11:00:00.000Z' });
      const ctx = make({ reports: [sfOk({ ...report('Succeeded'), id: OTHER_JOB, checkOnly: true }), sfOk(report('Succeeded'))] });
      const r = await sfDeploy('qa').run(ctx);
      expect(r).toMatchObject({ ok: true, sfDeploys: { qa: { jobId: JOB, resumed: false } } });
      expect(gitCalls(ctx, 'worktree add')).toHaveLength(1);
      expect(gitCalls(ctx, 'worktree remove')).toHaveLength(1);
      expect(ctx.sh.opts[at(ctx, 'sf project deploy start')].cwd).toBe(treeOf(ctx));
    });

    it('models the bug: a start that finds source only in the checkout succeeds', async () => {
      const ctx = make({
        start: () => {
          const line = ctx.sh.opts.at(-1);
          return line.cwd === treeOf(ctx) ? startOk() : sfError('DeployFailed', 'No source-backed components present in the package.');
        },
      });
      const r = await sfDeploy('qa').run(ctx);
      expect(r.ok).toBe(true);
    });

    it('a later stage on its own branch deploys a checkout of the merge commit, made after the merge', async () => {
      const qa = make();
      await sfDeploy('qa').run(qa);
      const ctx = make();
      const r = await sfDeploy('uat', { later: true }).run(ctx);
      expect(r.ok).toBe(true);
      // The first worktree is the stage merge's own, of the uat branch; the second is the deploy's.
      const adds = gitCalls(ctx, 'worktree add');
      expect(adds).toHaveLength(2);
      const tree = adds[1].split(' ')[4];
      expect(adds[1]).toBe(`git worktree add --detach ${tree} ${UAT_MERGE}`);
      const mergeAt = ctx.sh.calls.findIndex((l) => l.startsWith('git merge --no-ff'));
      expect(mergeAt).toBeGreaterThan(-1);
      expect(ctx.sh.calls.indexOf(adds[1])).toBeGreaterThan(mergeAt);
      expect(ctx.sh.opts[at(ctx, 'sf project deploy start')].cwd).toBe(tree);
    });
  });

  it('starts a real async deploy of the delta with testLevel.deploy', async () => {
    const ctx = make({ salesforce: { ...LAYOUT_B, testLevel: { validate: 'RunLocalTests', deploy: 'RunAllTestsInOrg' } } });
    await sfDeploy('qa').run(ctx);
    const line = startLine(ctx);
    expect(line).toBe(`sf project deploy start --manifest ${ctx.sfDelta.manifest} --test-level RunAllTestsInOrg --target-org acme-qa --async --json`);
    expect(line).not.toContain('--dry-run');
    const i = ctx.sh.calls.indexOf(line);
    expect(ctx.sh.opts[i].env.HOME).toBe(sfHome);
    expect(ctx.sh.opts[i].env.SF_USE_GENERIC_UNIX_KEYCHAIN).toBe('true');
  });

  it('passes the post-destructive changes only when the delta deletes something', async () => {
    const ctx = make({ facts: sfDeltaFacts({ deletes: [{ type: 'ApexClass', member: 'AcmeOld' }] }) });
    await sfDeploy('qa').run(ctx);
    expect(startLine(ctx)).toContain(`--post-destructive-changes ${ctx.sfDelta.postDestructive} --test-level RunLocalTests`);
    const plain = make();
    await sfDeploy('qa').run(plain);
    expect(startLine(plain)).not.toContain('--post-destructive-changes');
  });

  it('writes the job record before the first report', async () => {
    let record;
    const ctx = make({
      reports: [() => {
        record = JSON.parse(fs.readFileSync(recordFile(), 'utf8'));
        return sfOk(report('Succeeded'));
      }],
    });
    await sfDeploy('qa').run(ctx);
    expect(record).toEqual({ story: 'S-1', stage: 'qa', org: 'acme-qa', orgId: ACME_QA_ID, jobId: JOB, to: 'bbb', startedAt: '2026-10-15T12:00:00.000Z' });
    expect(deployJobFile(state, 'S-1', 'qa')).toBe(recordFile());
  });

  it('succeeds on Succeeded, adds the stage to sfDeploys and removes the record', async () => {
    const ctx = make({ reports: [sfOk(report('InProgress')), sfOk(report('Succeeded'))] });
    ctx.sfDeploys = { dev: { org: 'acme-dev1' } };
    const r = await sfDeploy('qa').run(ctx);
    expect(r).toEqual({
      ok: true,
      sfDeploys: { dev: { org: 'acme-dev1' }, qa: { org: 'acme-qa', jobId: JOB, components: { deployed: 2, total: 2 }, tests: { completed: 5, errors: 0 }, resumed: false } },
    });
    expect(reportLines(ctx)).toEqual([`sf project deploy report --job-id ${JOB} --target-org acme-qa --json`, `sf project deploy report --job-id ${JOB} --target-org acme-qa --json`]);
    expect(ctx.sleeps).toEqual([10000]);
    expect(fs.existsSync(recordFile())).toBe(false);
  });

  it('fails with code 5 and the failures on Failed, and removes the record', async () => {
    const ctx = make({ reports: [sfOk(report('Failed', FAILED))] });
    const r = await sfDeploy('qa').run(ctx);
    expect(r).toMatchObject({ ok: false, code: 5, stage: 'sf-deploy-qa', jobId: JOB });
    expect(r.reason).toContain('The deploy to acme-qa (qa) failed: 2 problem(s)');
    expect(r.failures).toEqual([
      { kind: 'component', name: 'ApexClass AcmeService line 14', message: 'Variable does not exist: total' },
      { kind: 'test', name: 'AcmeServiceTest.sumsTheOrder', message: 'Assertion Failed' },
    ]);
    expect(JSON.stringify(r)).not.toContain('Acme Admin');
    expect(fs.existsSync(recordFile())).toBe(false);
  });

  it('through runShip after the merge, a failed deploy is code 5 with one HALT', async () => {
    const merge = { name: 'merge', pointOfNoReturn: true, run: () => ({ ok: true }) };
    const ctx = make({ reports: [sfOk(report('Failed', FAILED))] });
    const { code, result } = await runShip({ steps: [merge, sfDeploy('qa')], ctx });
    expect(code).toBe(5);
    expect(result).toMatchObject({ stage: 'sf-deploy-qa' });
    expect(ctx.halts).toHaveLength(1);
  });

  describe('a failure the org already had', () => {
    // The baseline the doctor recorded for acme-qa: this test already fails there, at 19%.
    const writeBaseline = (orgId = ACME_QA_ID) => {
      const file = path.join(state, 'salesforce', 'baseline', 'acme-qa.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ alias: 'acme-qa', orgId, testRunId: '707000000000001AAA', startedAt: '2026-10-23T08:00:00.000Z', state: 'done', finishedAt: '2026-10-23T09:00:00.000Z', failing: ['AcmeServiceTest.sumsTheOrder'], coverage: 19 }));
    };
    const merge = { name: 'merge', pointOfNoReturn: true, run: () => ({ ok: true }) };

    it("through runShip, is still code 5 with one HALT, with inherited: true and a reason that it is not the story's change", async () => {
      writeBaseline();
      const ctx = make({ reports: [sfOk(report('Failed', INHERITED))] });
      const { code, result } = await runShip({ steps: [merge, sfDeploy('qa')], ctx });
      expect(code).toBe(5);
      expect(result).toMatchObject({ stage: 'sf-deploy-qa', inherited: true, jobId: JOB });
      expect(result.reason).toBe("The deploy to acme-qa (qa) failed only in what acme-qa already fails before this story (2 problem(s): AcmeServiceTest.sumsTheOrder, ): not this story's change. acme-qa already fails 1 test (AcmeServiceTest.sumsTheOrder) and has 19% Apex coverage (75% needed); set salesforce.testLevel.deploy to RunRelevantTests, or fix the org.");
      expect(result.failures).toHaveLength(2);
      expect(ctx.halts).toHaveLength(1);
      expect(fs.existsSync(recordFile())).toBe(false);
    });

    it("is today's failure with a component failure too, a baseline of another org, or no baseline", async () => {
      writeBaseline();
      const component = await sfDeploy('qa').run(make({ reports: [sfOk(report('Failed', { ...INHERITED, componentFailures: FAILED.componentFailures }))] }));
      expect(component.reason).toBe('The deploy to acme-qa (qa) failed: 3 problem(s): ApexClass AcmeService line 14, AcmeServiceTest.sumsTheOrder, ');
      expect(Object.keys(component).sort()).toEqual(['code', 'failures', 'jobId', 'ok', 'reason', 'stage']);

      writeBaseline('00D000000000009AAA');
      const other = await sfDeploy('qa').run(make({ reports: [sfOk(report('Failed', INHERITED))] }));
      expect(other.reason).toBe('The deploy to acme-qa (qa) failed: 2 problem(s): AcmeServiceTest.sumsTheOrder, ');
      expect(other).not.toHaveProperty('inherited');

      fs.rmSync(path.join(state, 'salesforce', 'baseline'), { recursive: true, force: true });
      const none = await sfDeploy('qa').run(make({ reports: [sfOk(report('Failed', INHERITED))] }));
      expect(none.reason).toBe('The deploy to acme-qa (qa) failed: 2 problem(s): AcmeServiceTest.sumsTheOrder, ');
      expect(none).not.toHaveProperty('inherited');
    });
  });

  it('resumes the stored job after a restart mid-deploy, without starting another', async () => {
    const first = make({
      start: startOk(JOB),
      reports: [sfOk(report('InProgress'))],
      sleep: async () => {
        throw new Error('killed');
      },
    });
    await expect(sfDeploy('qa').run(first)).rejects.toThrow('killed');
    expect(readDeployJob(state, 'S-1', 'qa')).toMatchObject({ jobId: JOB, org: 'acme-qa', to: 'bbb' });

    const second = make({ reports: [sfOk(report('Succeeded'))] });
    const r = await sfDeploy('qa').run(second);
    expect(second.sh.calls.some((l) => l.startsWith('sf project deploy start'))).toBe(false);
    expect(reportLines(second)).toEqual([`sf project deploy report --job-id ${JOB} --target-org acme-qa --json`]);
    expect(r).toMatchObject({ ok: true, sfDeploys: { qa: { org: 'acme-qa', jobId: JOB, resumed: true } } });
    expect(second.events.map((e) => e.text)).toContain(`Resuming the qa deploy of S-1 from job ${JOB}.`);
    expect(fs.existsSync(recordFile())).toBe(false);
  });

  describe('does not resume a record that does not match', () => {
    const cases = {
      'another org': { org: 'acme-uat' },
      'another to SHA': { to: 'ccc' },
      'a bad job id': { jobId: '--target-org acme-prod' },
      // The alias was pointed at another org.
      'another org ID': { orgId: ACME_UAT_ID },
      'no startedAt': { startedAt: undefined },
      'a startedAt that is not a date': { startedAt: 'yesterday' },
    };
    for (const [what, over] of Object.entries(cases)) {
      it(what, async () => {
        writeDeployJob(state, { story: 'S-1', stage: 'qa', org: 'acme-qa', orgId: ACME_QA_ID, jobId: OTHER_JOB, to: 'bbb', startedAt: '2026-10-15T11:00:00.000Z', ...over });
        let record;
        const ctx = make({ reports: [() => ((record = readDeployJob(state, 'S-1', 'qa')), sfOk(report('Succeeded')))] });
        const r = await sfDeploy('qa').run(ctx);
        expect(startLine(ctx)).toBeDefined();
        expect(reportLines(ctx)[0]).toContain(`--job-id ${JOB}`);
        expect(record).toMatchObject({ org: 'acme-qa', to: 'bbb', jobId: JOB });
        expect(r.sfDeploys.qa.resumed).toBe(false);
        expect(ctx.events).toEqual([]);
      });
    }
    it('a broken file', async () => {
      fs.mkdirSync(path.dirname(recordFile()), { recursive: true });
      fs.writeFileSync(recordFile(), '{ not json');
      expect(readDeployJob(state, 'S-1', 'qa')).toBeNull();
      const ctx = make();
      const r = await sfDeploy('qa').run(ctx);
      expect(startLine(ctx)).toBeDefined();
      expect(r).toMatchObject({ ok: true, sfDeploys: { qa: { resumed: false } } });
    });
  });

  it.each([['no to', undefined], ['an empty to', '']])('never resumes when the delta has %s', async (_, to) => {
    writeDeployJob(state, { story: 'S-1', stage: 'qa', org: 'acme-qa', orgId: ACME_QA_ID, jobId: OTHER_JOB, to, startedAt: '2026-10-15T11:00:00.000Z' });
    // sfDeltaFacts fills in a to for undefined, so it is set after.
    const ctx = make({ facts: { ...sfDeltaFacts(), to } });
    const r = await sfDeploy('qa').run(ctx);
    expect(startLine(ctx)).toBeDefined();
    expect(reportLines(ctx)[0]).toContain(`--job-id ${JOB}`);
    expect(r).toMatchObject({ ok: true, sfDeploys: { qa: { jobId: JOB, resumed: false } } });
    expect(ctx.events).toEqual([]);
  });

  describe('checks a resumed job is the deploy the record says', () => {
    const STARTED = '2026-10-15T11:00:00.000Z';
    const stored = () => writeDeployJob(state, { story: 'S-1', stage: 'qa', org: 'acme-qa', orgId: ACME_QA_ID, jobId: OTHER_JOB, to: 'bbb', startedAt: STARTED });
    const reportLine = (id) => `sf project deploy report --job-id ${id} --target-org acme-qa --json`;
    const warnings = (ctx) => ctx.events.filter((e) => e.kind === 'warn').map((e) => e.text);

    it('refuses to resume a validation job and starts a real deploy', async () => {
      stored();
      const ctx = make({ reports: [sfOk({ ...report('Succeeded'), id: OTHER_JOB, checkOnly: true }), sfOk({ ...report('Succeeded'), checkOnly: false })] });
      ctx.sha = STAGE_SHA;
      const r = await sfDeploy('qa').run(ctx);
      expect(startLine(ctx)).toBeDefined();
      expect(reportLines(ctx)).toEqual([reportLine(OTHER_JOB), reportLine(JOB)]);
      expect(warnings(ctx)).toHaveLength(1);
      expect(warnings(ctx)[0]).toContain(`Refused to resume job ${OTHER_JOB}`);
      expect(warnings(ctx)[0]).toContain('validation');
      expect(warnings(ctx)[0]).toContain('starting a new deploy');
      expect(r).toMatchObject({ ok: true, sfDeploys: { qa: { org: 'acme-qa', jobId: JOB, resumed: false } } });
      expect(fs.existsSync(recordFile())).toBe(false);
      expect(readDeployed(state, 'qa').jobId).toBe(JOB);
      expect(readRelease(state, 'S-1').first.jobId).toBe(JOB);
    });

    it("takes sf's checkOnly given as text too", async () => {
      stored();
      const ctx = make({ reports: [sfOk({ ...report('Succeeded'), id: OTHER_JOB, checkOnly: 'true' }), sfOk(report('Succeeded'))] });
      const r = await sfDeploy('qa').run(ctx);
      expect(startLine(ctx)).toBeDefined();
      expect(r.sfDeploys.qa).toMatchObject({ jobId: JOB, resumed: false });
    });

    it('refuses to resume a job created before the record started', async () => {
      stored();
      const ctx = make({ reports: [sfOk({ ...report('Succeeded'), id: OTHER_JOB, createdDate: '2026-10-15T10:00:00.000Z' }), sfOk(report('Succeeded'))] });
      const r = await sfDeploy('qa').run(ctx);
      expect(startLine(ctx)).toBeDefined();
      expect(reportLines(ctx)).toEqual([reportLine(OTHER_JOB), reportLine(JOB)]);
      expect(warnings(ctx)).toHaveLength(1);
      expect(warnings(ctx)[0]).toContain('created before');
      expect(r).toMatchObject({ ok: true, sfDeploys: { qa: { jobId: JOB, resumed: false } } });
    });

    it('still resumes a job created a few minutes before startedAt', async () => {
      stored();
      const ctx = make({ reports: [sfOk({ ...report('Succeeded'), id: OTHER_JOB, createdDate: '2026-10-15T10:55:00.000Z', checkOnly: false })] });
      const r = await sfDeploy('qa').run(ctx);
      expect(startLine(ctx)).toBeUndefined();
      expect(reportLines(ctx)).toEqual([reportLine(OTHER_JOB)]);
      expect(warnings(ctx)).toEqual([]);
      expect(r).toMatchObject({ ok: true, sfDeploys: { qa: { jobId: OTHER_JOB, resumed: true } } });
    });

    it('a refused job whose new deploy never starts fails with code 5 and keeps no record', async () => {
      stored();
      const ctx = make({ start: sfError('NoAuthInfoFound', 'No authorization information found for acme-qa.'), reports: [sfOk({ ...report('Succeeded'), id: OTHER_JOB, checkOnly: true })] });
      const r = await sfDeploy('qa').run(ctx);
      expect(r).toMatchObject({ ok: false, code: 5, stage: 'sf-deploy-qa' });
      expect(r.reason).toBe('The deploy to acme-qa (qa) never started: No authorization information found for acme-qa.');
      expect(fs.existsSync(recordFile())).toBe(false);
      expect(readDeployed(state, 'qa')).toBeNull();
    });
  });

  it('fails with code 5 when the deploy never starts, and writes no record', async () => {
    const ctx = make({ start: sfError('NoAuthInfoFound', 'No authorization information found for acme-qa.') });
    const r = await sfDeploy('qa').run(ctx);
    expect(r).toMatchObject({ ok: false, code: 5, stage: 'sf-deploy-qa' });
    expect(r.reason).toBe('The deploy to acme-qa (qa) never started: No authorization information found for acme-qa.');
    expect(fs.existsSync(recordFile())).toBe(false);
    expect(reportLines(ctx)).toEqual([]);
  });

  it('fails with code 5 when the start gives no job id', async () => {
    const r = await sfDeploy('qa').run(make({ start: sfOk({ status: 'Queued' }) }));
    expect(r).toMatchObject({ ok: false, code: 5 });
    expect(r.reason).toContain('never started');
    expect(fs.existsSync(recordFile())).toBe(false);
  });

  it('keeps the record at the deadline and tells the owner to finish by hand', async () => {
    const ctx = make({ reports: [sfOk(report('InProgress'))] });
    const r = await sfDeploy('qa').run(ctx);
    expect(r).toMatchObject({ ok: false, code: 5, stage: 'sf-deploy-qa', jobId: JOB });
    expect(r.reason).toBe(`The deploy to acme-qa (qa) did not finish within 30 minutes (last seen "InProgress"); job ${JOB} may still be running. The pull request is already merged, so Foreman will not run this release again: check the job with \`sf project deploy report --job-id ${JOB} --target-org acme-qa\`, finish the qa deploy by hand if it failed, then run \`foreman sf fixed qa\` and clear the halt with "I've fixed it".`);
    expect(readDeployJob(state, 'S-1', 'qa')).toMatchObject({ jobId: JOB });
  });

  it('stops watching at once on a login-rate answer: code 5, the record kept, one report', async () => {
    const ctx = make({ reports: [sfError('X', 'login rate exceeded')] });
    const r = await sfDeploy('qa').run(ctx);
    expect(r).toMatchObject({ ok: false, code: 5, stage: 'sf-deploy-qa', jobId: JOB });
    expect(r.reason).toMatch(new RegExp(`^Stopped watching job ${JOB} on acme-qa \\(qa\\): stopped at once:.*login rate exceeded`));
    expect(r.reason).toContain('foreman sf fixed qa');
    expect(r.reason).toContain('already merged');
    expect(reportLines(ctx)).toHaveLength(1);
    expect(ctx.sleeps).toEqual([]);
    expect(readDeployJob(state, 'S-1', 'qa')).toMatchObject({ jobId: JOB });
  });

  it('a heartbeat that throws mid-deploy does not fail the step', async () => {
    const ctx = make({
      reports: [sfOk(report('InProgress')), sfOk(report('Succeeded'))],
      report: () => {
        throw new Error('the beat file is gone');
      },
    });
    const r = await sfDeploy('qa').run(ctx);
    expect(r).toMatchObject({ ok: true, sfDeploys: { qa: { jobId: JOB, resumed: false } } });
    expect(reportLines(ctx)).toHaveLength(2);
  });

  it('deploys for real to a stage that shares the build org', async () => {
    const ctx = make({ salesforce: LAYOUT_A });
    const r = await sfDeploy('dev').run(ctx);
    expect(startLine(ctx)).toBe(`sf project deploy start --manifest ${ctx.sfDelta.manifest} --test-level RunLocalTests --target-org acme-dev1 --async --json`);
    expect(r).toMatchObject({ ok: true, sfDeploys: { dev: { org: 'acme-dev1', jobId: JOB } } });
  });

  it('fails with code 1 for a stage the layout does not have', async () => {
    const ctx = make();
    expect(await sfDeploy('dev').run(ctx)).toMatchObject({ ok: false, code: 1, stage: 'sf-deploy-dev' });
    expect(sfLines(ctx)).toEqual([]);
  });

  it('fails with code 1 for a stage whose org has no org ID', async () => {
    const ctx = make({ salesforce: { ...LAYOUT_B, orgs: { ...LAYOUT_B.orgs, 'acme-qa': {} } } });
    expect(await sfDeploy('qa').run(ctx)).toMatchObject({ ok: false, code: 1 });
    expect(sfLines(ctx)).toEqual([]);
  });

  it('fails with code 1 without the delta facts', async () => {
    const ctx = make({ facts: null });
    expect(await sfDeploy('qa').run(ctx)).toMatchObject({ ok: false, code: 1 });
    expect(sfLines(ctx)).toEqual([]);
  });

  it('skips an empty delta without calling sf, and clears a stale record', async () => {
    writeDeployJob(state, { story: 'S-1', stage: 'qa', org: 'acme-qa', orgId: ACME_QA_ID, jobId: OTHER_JOB, to: 'bbb', startedAt: '2026-10-15T11:00:00.000Z' });
    const ctx = make({ facts: sfDeltaFacts({ types: {} }) });
    const r = await sfDeploy('qa').run(ctx);
    expect(r).toEqual({ ok: true, sfDeploys: { qa: { org: 'acme-qa', skipped: true } } });
    expect(sfLines(ctx)).toEqual([]);
    expect(fs.existsSync(recordFile())).toBe(false);
  });

  describe('the release records', () => {
    it('on Succeeded for stage 1 writes the stage record and the first deploy, with reached [qa]', async () => {
      const ctx = make();
      ctx.sha = STAGE_SHA;
      expect((await sfDeploy('qa').run(ctx)).ok).toBe(true);
      expect(readDeployed(state, 'qa')).toEqual({ stage: 'qa', org: 'acme-qa', orgId: ACME_QA_ID, jobId: JOB, story: 'S-1', commit: STAGE_SHA, at: '2026-10-15T12:00:00.000Z' });
      expect(readRelease(state, 'S-1')).toEqual({
        story: 'S-1',
        to: 'bbb',
        reached: ['qa'],
        first: { stage: 'qa', org: 'acme-qa', orgId: ACME_QA_ID, branch: 'qa', merge: STAGE_SHA, method: 'merge', jobId: JOB, deployedAt: '2026-10-15T12:00:00.000Z' },
        rolledBack: null,
      });
    });

    it('takes the branch and the merge method from ship.pr', async () => {
      const ctx = make({ salesforce: { ...LAYOUT_B, stages: [{ name: 'qa', org: 'acme-qa' }, { name: 'uat', org: 'acme-uat', branch: 'uat' }] } });
      ctx.config.ship = { ...ctx.config.ship, pr: { into: 'develop', mergeMethod: 'squash' } };
      await sfDeploy('qa').run(ctx);
      expect(readDeployed(state, 'qa').commit).toBe(STAGE_SHA);
      expect(readRelease(state, 'S-1').first).toMatchObject({ branch: 'develop', merge: STAGE_SHA, method: 'squash' });
    });

    it('a later stage marks reached but records no first deploy', async () => {
      const ctx = make();
      ctx.sha = STAGE_SHA;
      await sfDeploy('qa').run(ctx);
      const uat = make({ git: MERGE_RULES });
      uat.sha = M2;
      expect((await sfDeploy('uat').run(uat)).ok).toBe(true);
      const rec = readRelease(state, 'S-1');
      expect(rec.reached).toEqual(['qa', 'uat']);
      expect(rec.first).toMatchObject({ stage: 'qa', merge: STAGE_SHA });
      expect(readDeployed(state, 'uat')).toMatchObject({ stage: 'uat', org: 'acme-uat', commit: UAT_MERGE });
    });

    it('the skipped path marks reached too', async () => {
      const ctx = make({ facts: sfDeltaFacts({ types: {} }) });
      await sfDeploy('qa').run(ctx);
      expect(readRelease(state, 'S-1')).toEqual({ story: 'S-1', to: 'bbb', reached: ['qa'], first: null, rolledBack: null });
      expect(readDeployed(state, 'qa')).toBeNull();
    });

    it('the skipped path moves the stage record to the new merge and keeps the org job, since no metadata changed', async () => {
      writeDeployed(state, { stage: 'qa', org: 'acme-qa', orgId: ACME_QA_ID, jobId: OTHER_JOB, story: 'S-0', commit: 'm0', at: '2026-10-15T11:00:00.000Z' });
      const ctx = make({ facts: sfDeltaFacts({ types: {} }) });
      ctx.sha = STAGE_SHA;
      expect((await sfDeploy('qa').run(ctx)).ok).toBe(true);
      expect(readDeployed(state, 'qa')).toEqual({ stage: 'qa', org: 'acme-qa', orgId: ACME_QA_ID, jobId: OTHER_JOB, story: 'S-1', commit: STAGE_SHA, at: '2026-10-15T12:00:00.000Z' });
      expect(readRelease(state, 'S-1').first).toBeNull();
      expect(sfLines(ctx)).toEqual([]);
    });

    it('a failed deploy records no stage record and no first deploy', async () => {
      const ctx = make({ reports: [sfOk(report('Failed', FAILED))] });
      ctx.sha = STAGE_SHA;
      await sfDeploy('qa').run(ctx);
      expect(readDeployed(state, 'qa')).toBeNull();
      expect(readRelease(state, 'S-1')).toMatchObject({ reached: ['qa'], first: null });
    });
  });
});
