import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sfValidate from './sf-validate.mjs';
import { runShip } from '../../../lib/engine/ship.mjs';
import { fakeCtx } from '../../../../test/ship-fakes.mjs';
import { ACME_DEV1_ID, ACME_QA_ID, ACME_UAT_ID, sfError, sfOk } from '../../../../test/fake-sf.mjs';

const JOB = '0Af000000000001AAA';

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
  sfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-validate-sfhome-'));
  state = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-validate-state-'));
  delta = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-validate-delta-'));
});
afterEach(() => {
  for (const d of [sfHome, state, delta]) fs.rmSync(d, { recursive: true, force: true });
});

// The facts sf-delta leaves: a real package.xml and postDestructiveChanges.xml in a temp dir.
function sfDeltaFacts({ types = { ApexClass: ['AcmeService'] }, deletes = [] } = {}) {
  fs.mkdirSync(path.join(delta, 'package'), { recursive: true });
  const m = path.join(delta, 'package', 'package.xml');
  const post = path.join(delta, 'postDestructiveChanges.xml');
  fs.writeFileSync(m, manifest(types));
  const removed = {};
  for (const { type, member } of deletes) removed[type] = [...(removed[type] ?? []), member];
  fs.writeFileSync(post, manifest(removed));
  return { dir: delta, from: 'aaa', to: 'bbb', manifest: m, postDestructive: post, deletes, sha256: 'f'.repeat(64) };
}

// The start answers `start`; the report answers each item of `reports` in turn, then the last.
function ctxFor({ salesforce = LAYOUT_B, start = sfOk({ id: JOB, done: false, status: 'Queued' }), reports = [sfOk(report('Succeeded'))], facts = sfDeltaFacts() } = {}) {
  let n = 0;
  const ctx = fakeCtx({
    config: { pack: 'salesforce', salesforce, slots: 1 },
    rules: [
      [/^sf project deploy start /, start],
      [/^sf project deploy report /, () => reports[Math.min(n++, reports.length - 1)]],
    ],
    root: '/acme/repo',
    env: { FOREMAN_SF_HOME: sfHome, FOREMAN_STATE_DIR: state },
  });
  if (facts) ctx.sfDelta = facts;
  return ctx;
}

const sfLines = (ctx) => ctx.sh.calls.filter((l) => l.startsWith('sf '));
const startLine = (ctx) => ctx.sh.calls.find((l) => l.startsWith('sf project deploy start'));
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

describe('sf-validate', () => {
  it('is a step that needs sf, never halts and never deploys', () => {
    expect(sfValidate).toMatchObject({ name: 'sf-validate', label: "validating the Salesforce delta on the first stage's org", needs: ['sf'] });
    expect(sfValidate.halts).toBeUndefined();
    expect(sfValidate.deploys).toBeUndefined();
    expect(sfValidate.testsMergedCode).toBe(true);
  });

  it("dry-runs the delta on the first stage's org, async, with the isolated sf home", async () => {
    const ctx = make();
    await sfValidate.run(ctx);
    const line = startLine(ctx);
    expect(line).toBe(`sf project deploy start --dry-run --manifest ${ctx.sfDelta.manifest} --test-level RunLocalTests --target-org acme-qa --async --json`);
    const i = ctx.sh.calls.indexOf(line);
    expect(ctx.sh.opts[i].env.HOME).toBe(sfHome);
    expect(ctx.sh.opts[i].env.SF_USE_GENERIC_UNIX_KEYCHAIN).toBe('true');
    expect(ctx.sh.limits[i]).toBe(600000);
  });

  it('still validates on the first stage when that org is the build org', async () => {
    const ctx = make({ salesforce: LAYOUT_A });
    const r = await sfValidate.run(ctx);
    expect(startLine(ctx)).toContain('--target-org acme-dev1 --async');
    expect(r).toMatchObject({ ok: true, sfValidate: { stage: 'dev', org: 'acme-dev1', jobId: JOB } });
  });

  it('uses testLevel.validate', async () => {
    const ctx = make({ salesforce: { ...LAYOUT_B, testLevel: { validate: 'RunAllTestsInOrg', deploy: 'RunLocalTests' } } });
    await sfValidate.run(ctx);
    expect(startLine(ctx)).toContain('--test-level RunAllTestsInOrg');
  });

  it('passes the post-destructive changes only when the delta deletes something', async () => {
    const plain = make();
    await sfValidate.run(plain);
    expect(startLine(plain)).not.toContain('--post-destructive-changes');

    const deleting = make({ facts: sfDeltaFacts({ deletes: [{ type: 'ApexClass', member: 'AcmeOld' }] }) });
    await sfValidate.run(deleting);
    expect(startLine(deleting)).toContain(`--manifest ${deleting.sfDelta.manifest} --post-destructive-changes ${deleting.sfDelta.postDestructive} --test-level RunLocalTests`);
  });

  it('polls the report until it succeeds, and gives the counts', async () => {
    const ctx = make({ reports: [sfOk(report('InProgress')), sfOk(report('Succeeded'))] });
    const r = await sfValidate.run(ctx);
    const reports = ctx.sh.calls.filter((l) => l.startsWith('sf project deploy report'));
    expect(reports).toEqual([`sf project deploy report --job-id ${JOB} --target-org acme-qa --json`, `sf project deploy report --job-id ${JOB} --target-org acme-qa --json`]);
    expect(ctx.sleeps).toEqual([10000]);
    expect(r).toEqual({ ok: true, sfValidate: { stage: 'qa', org: 'acme-qa', jobId: JOB, components: { deployed: 2, total: 2 }, tests: { completed: 5, errors: 0 } } });
    expect(JSON.stringify(r)).not.toContain('Acme Admin');
  });

  it('fails with code 2 and the failures when the validation fails', async () => {
    const ctx = make({ reports: [sfOk(report('Failed', FAILED))] });
    const r = await sfValidate.run(ctx);
    expect(r).toMatchObject({ ok: false, code: 2, stage: 'sf-validate' });
    expect(r.reason).toBe('The Salesforce validation on acme-qa (qa) failed: 2 problem(s): ApexClass AcmeService line 14, AcmeServiceTest.sumsTheOrder');
    expect(r.failures).toEqual([
      { kind: 'component', name: 'ApexClass AcmeService line 14', message: 'Variable does not exist: total' },
      { kind: 'test', name: 'AcmeServiceTest.sumsTheOrder', message: 'Assertion Failed' },
    ]);
    expect(JSON.stringify(r)).not.toContain('Acme Admin');
  });

  it('reads a failed report that sf exits 1 for', async () => {
    const exit1 = { status: 1, stdout: JSON.stringify({ status: 1, result: report('Failed', FAILED) }), stderr: '' };
    const r = await sfValidate.run(make({ reports: [exit1] }));
    expect(r).toMatchObject({ ok: false, code: 2, stage: 'sf-validate' });
    expect(r.failures).toHaveLength(2);
  });

  it('through runShip, a failed validation is code 2 with no HALT', async () => {
    const ctx = make({ reports: [sfOk(report('Failed', FAILED))] });
    const { code, result } = await runShip({ steps: [sfValidate], ctx });
    expect(code).toBe(2);
    expect(result).toMatchObject({ stage: 'sf-validate' });
    expect(result.failures).toHaveLength(2);
    expect(ctx.halts).toEqual([]);
  });

  describe('a failure the org already had', () => {
    // The baseline the doctor recorded for acme-qa: this test already fails there, at 19%.
    const writeBaseline = (orgId = ACME_QA_ID) => {
      const file = path.join(state, 'salesforce', 'baseline', 'acme-qa.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ alias: 'acme-qa', orgId, testRunId: '707000000000001AAA', startedAt: '2026-10-23T08:00:00.000Z', state: 'done', finishedAt: '2026-10-23T09:00:00.000Z', failing: ['AcmeServiceTest.sumsTheOrder'], coverage: 19 }));
    };
    const TODAY = 'The Salesforce validation on acme-qa (qa) failed: 3 problem(s): ApexClass AcmeService line 14, AcmeServiceTest.sumsTheOrder, ';

    it('is code 2 with inherited: true and says it is not the story\'s change', async () => {
      writeBaseline();
      const r = await sfValidate.run(make({ reports: [sfOk(report('Failed', INHERITED))] }));
      expect(r).toMatchObject({ ok: false, code: 2, stage: 'sf-validate', inherited: true });
      expect(r.reason).toBe("The Salesforce validation on acme-qa (qa) failed only in what acme-qa already fails before this story (2 problem(s): AcmeServiceTest.sumsTheOrder, ): not this story's change. acme-qa already fails 1 test (AcmeServiceTest.sumsTheOrder) and has 19% Apex coverage (75% needed); set salesforce.testLevel.validate to RunRelevantTests, or fix the org.");
      expect(r.reason).toContain('already fails');
      expect(r.reason).toContain("not this story's change");
      expect(r.failures).toHaveLength(2);
    });

    it('through runShip, is still code 2 with no HALT', async () => {
      writeBaseline();
      const ctx = make({ reports: [sfOk(report('Failed', INHERITED))] });
      const { code, result } = await runShip({ steps: [sfValidate], ctx });
      expect(code).toBe(2);
      expect(result.inherited).toBe(true);
      expect(ctx.halts).toEqual([]);
    });

    it('is today\'s failure with a component failure too, a baseline of another org, or no baseline', async () => {
      const withComponent = { ...INHERITED, componentFailures: FAILED.componentFailures };
      writeBaseline();
      const component = await sfValidate.run(make({ reports: [sfOk(report('Failed', withComponent))] }));
      expect(component.reason).toBe(TODAY);
      expect(component).not.toHaveProperty('inherited');

      writeBaseline('00D000000000009AAA');
      const other = await sfValidate.run(make({ reports: [sfOk(report('Failed', INHERITED))] }));
      expect(other.reason).toBe('The Salesforce validation on acme-qa (qa) failed: 2 problem(s): AcmeServiceTest.sumsTheOrder, ');
      expect(other).not.toHaveProperty('inherited');
      expect(Object.keys(other).sort()).toEqual(['code', 'failures', 'ok', 'reason', 'stage']);

      fs.rmSync(path.join(state, 'salesforce'), { recursive: true, force: true });
      const none = await sfValidate.run(make({ reports: [sfOk(report('Failed', INHERITED))] }));
      expect(none.reason).toBe('The Salesforce validation on acme-qa (qa) failed: 2 problem(s): AcmeServiceTest.sumsTheOrder, ');
      expect(none).not.toHaveProperty('inherited');
    });
  });

  it('fails with code 2 when the validation never starts', async () => {
    const ctx = make({ start: sfError('NoAuthInfoFound', 'No authorization information found for acme-qa.') });
    const r = await sfValidate.run(ctx);
    expect(r).toMatchObject({ ok: false, code: 2, stage: 'sf-validate' });
    expect(r.reason).toBe('The Salesforce validation on acme-qa (qa) never started: No authorization information found for acme-qa.');
    expect(ctx.sh.calls.some((l) => l.startsWith('sf project deploy report'))).toBe(false);
  });

  it('fails with code 2 when the start gives no job id', async () => {
    const r = await sfValidate.run(make({ start: sfOk({ id: '--target-org acme-prod', status: 'Queued' }) }));
    expect(r).toMatchObject({ ok: false, code: 2 });
    expect(r.reason).toContain('never started');
  });

  it('fails with code 2 when the validation does not finish within 30 minutes', async () => {
    const ctx = make({ reports: [sfOk(report('InProgress'))] });
    const r = await sfValidate.run(ctx);
    expect(r).toMatchObject({ ok: false, code: 2, stage: 'sf-validate' });
    expect(r.reason).toBe('The Salesforce validation on acme-qa (qa) did not finish within 30 minutes (last seen "InProgress").');
    expect(ctx.sleeps.reduce((a, b) => a + b, 0)).toBe(30 * 60_000);
  });

  it('fails with code 2 at once on a login-rate answer, after a single report', async () => {
    const ctx = make({ reports: [sfError('X', 'login rate exceeded')] });
    const r = await sfValidate.run(ctx);
    expect(r).toMatchObject({ ok: false, code: 2, stage: 'sf-validate' });
    expect(r.reason).toMatch(new RegExp(`^Stopped watching job ${JOB} on acme-qa \\(qa\\): stopped at once:.*login rate exceeded`));
    expect(ctx.sh.calls.filter((l) => l.startsWith('sf project deploy report'))).toHaveLength(1);
    expect(ctx.sleeps).toEqual([]);
  });

  it('fails with code 1 without the delta facts', async () => {
    const ctx = make({ facts: null });
    const r = await sfValidate.run(ctx);
    expect(r).toMatchObject({ ok: false, code: 1, stage: 'sf-validate' });
    expect(sfLines(ctx)).toEqual([]);
  });

  it('fails with code 1 when there is no stage', async () => {
    const ctx = make({ salesforce: { ...LAYOUT_A, stages: [] } });
    expect(await sfValidate.run(ctx)).toMatchObject({ ok: false, code: 1 });
    expect(sfLines(ctx)).toEqual([]);
  });

  it('skips an empty delta without calling sf', async () => {
    const ctx = make({ facts: sfDeltaFacts({ types: {} }) });
    const r = await sfValidate.run(ctx);
    expect(r).toEqual({ ok: true, sfValidate: { stage: 'qa', org: 'acme-qa', skipped: true } });
    expect(sfLines(ctx)).toEqual([]);
  });

  it('validates a delta that only deletes', async () => {
    const ctx = make({ facts: sfDeltaFacts({ types: {}, deletes: [{ type: 'ApexClass', member: 'AcmeOld' }] }) });
    const r = await sfValidate.run(ctx);
    expect(r.ok).toBe(true);
    expect(startLine(ctx)).toContain('--post-destructive-changes');
  });
});
