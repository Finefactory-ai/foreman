import { describe, expect, it } from 'vitest';
import { FINAL, JOB_ID, summary, waitForJob } from './deploy-result.mjs';
import { fakeCtx } from '../../../test/ship-fakes.mjs';
import { sfError, sfOk } from '../../../test/fake-sf.mjs';

const JOB = '0Af000000000001AAA';

// A deploy report as `sf project deploy report --json` gives it, with the fields a summary
// must never copy.
const report = (over = {}, details = {}) => ({
  id: JOB,
  status: 'Failed',
  createdBy: '005000000000001AAA',
  createdByName: 'Acme Admin',
  numberComponentsDeployed: 3,
  numberComponentsTotal: 4,
  numberComponentErrors: 1,
  numberTestsCompleted: 12,
  numberTestErrors: 1,
  details: {
    componentFailures: { componentType: 'ApexClass', fullName: 'AcmeService', problem: 'Variable does not exist: total', problemType: 'Error', lineNumber: '14', fileName: 'classes/AcmeService.cls', id: '01p000000000001AAA', createdByName: 'Acme Admin' },
    runTestResult: {
      failures: { name: 'AcmeServiceTest', methodName: 'sumsTheOrder', message: 'System.AssertException: Assertion Failed', stackTrace: 'Class.AcmeServiceTest.sumsTheOrder: line 9', id: '01p000000000002AAA' },
      codeCoverageWarnings: { name: 'AcmeService', message: 'Test coverage of selected Apex Class is 20%, at least 75% test coverage is required', id: '01p000000000001AAA' },
    },
    ...details,
  },
  ...over,
});

describe('summary', () => {
  it('reads the status, the counts and each kind of failure from one-object values', () => {
    expect(summary(report())).toEqual({
      status: 'Failed',
      components: { deployed: 3, total: 4 },
      tests: { completed: 12, errors: 1 },
      failures: [
        { kind: 'component', name: 'ApexClass AcmeService line 14', message: 'Variable does not exist: total' },
        { kind: 'test', name: 'AcmeServiceTest.sumsTheOrder', message: 'System.AssertException: Assertion Failed' },
        { kind: 'coverage', name: 'AcmeService', message: 'Test coverage of selected Apex Class is 20%, at least 75% test coverage is required' },
      ],
    });
  });

  it('reads component failures given as an array, with and without a line number', () => {
    const r = report({}, {
      componentFailures: [
        { componentType: 'ApexClass', fullName: 'AcmeA', problem: 'Missing ;', lineNumber: 3 },
        { componentType: 'CustomField', fullName: 'Account.Acme__c', problem: 'Bad picklist' },
      ],
      runTestResult: { failures: [], codeCoverageWarnings: [] },
    });
    expect(summary(r).failures).toEqual([
      { kind: 'component', name: 'ApexClass AcmeA line 3', message: 'Missing ;' },
      { kind: 'component', name: 'CustomField Account.Acme__c', message: 'Bad picklist' },
    ]);
  });

  it('gives zero counts and no failures for a bare or odd result', () => {
    const empty = { status: null, components: { deployed: 0, total: 0 }, tests: { completed: 0, errors: 0 }, failures: [] };
    expect(summary({})).toEqual(empty);
    expect(summary(null)).toEqual(empty);
    expect(summary({ status: 'Succeeded', details: { componentFailures: 'x', runTestResult: 3 } })).toEqual({ ...empty, status: 'Succeeded' });
  });

  it('keeps at most 20 failures and tidies each message to 300 characters', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ componentType: 'ApexClass', fullName: `Acme${i}`, problem: `line one\n\n   ${'x'.repeat(400)}` }));
    const { failures } = summary(report({}, { componentFailures: many }));
    expect(failures).toHaveLength(20);
    expect(failures[0].message).toHaveLength(300);
    expect(failures[0].message.startsWith('line one x')).toBe(true);
  });

  it('never copies who made the deploy, ids or file names', () => {
    const text = JSON.stringify(summary(report()));
    for (const leak of ['Acme Admin', 'createdBy', '005000000000001AAA', '01p000000000001AAA', 'classes/AcmeService.cls', 'stackTrace', 'line 9']) {
      expect(text).not.toContain(leak);
    }
  });
});

describe('FINAL and JOB_ID', () => {
  it('know the final statuses', () => {
    expect(FINAL).toEqual(['Succeeded', 'Failed', 'Canceled', 'SucceededPartial']);
    for (const s of ['InProgress', 'Pending', 'Canceling', 'Queued']) expect(FINAL).not.toContain(s);
  });
  it('accepts 15 and 18 character deploy job ids only', () => {
    for (const id of [JOB, '0Af000000000001']) expect(JOB_ID.test(id)).toBe(true);
    for (const id of ['0Af00000000001', '00D000000000001AAA', '0Af000000000001AAAB', `${JOB} --x`, '-0Af000000000001', '']) expect(JOB_ID.test(id)).toBe(false);
  });
});

describe('waitForJob', () => {
  const LINE = `sf project deploy report --job-id ${JOB} --target-org acme-qa --json`;

  it('polls the report every 10 seconds until a final status, reporting each poll', async () => {
    let n = 0;
    const ctx = fakeCtx({ rules: [['sf project deploy report', () => (++n < 3 ? sfOk({ status: 'InProgress' }) : sfOk(report({ status: 'Succeeded' })))]] });
    const r = await waitForJob(ctx, ctx.sh, { jobId: JOB, org: 'acme-qa', minutes: 30, label: 'deploying' });
    expect(r.status).toBe('Succeeded');
    expect(r.result.numberComponentsTotal).toBe(4);
    expect(r.lastError).toBeNull();
    expect(ctx.sh.calls.filter((l) => l === LINE)).toHaveLength(3);
    expect(ctx.sleeps).toEqual([10000, 10000]);
    expect(ctx.reports).toEqual(['deploying', 'deploying', 'deploying']);
    expect(ctx.sh.limits[0]).toBe(120000);
  });

  it('keeps the result of a report that exits 1', async () => {
    const failed = { status: 1, stdout: JSON.stringify({ status: 1, result: report() }), stderr: '' };
    const ctx = fakeCtx({ rules: [['sf project deploy report', failed]] });
    const r = await waitForJob(ctx, ctx.sh, { jobId: JOB, org: 'acme-qa', minutes: 30 });
    expect(r.status).toBe('Failed');
    expect(summary(r.result).failures).toHaveLength(3);
  });

  it('retries a failed read until the deadline and keeps its message', async () => {
    const ctx = fakeCtx({ rules: [['sf project deploy report', sfError('SfError', 'socket hang up')]] });
    const r = await waitForJob(ctx, ctx.sh, { jobId: JOB, org: 'acme-qa', minutes: 1 });
    expect(r).toEqual({ status: null, result: null, lastError: 'socket hang up' });
    expect(ctx.sleeps).toEqual([10000, 10000, 10000, 10000, 10000, 10000]);
  });

  it('stops at once on a login-rate answer, with no retry and no sleep', async () => {
    const ctx = fakeCtx({ rules: [['sf project deploy report', sfError('X', 'login rate exceeded')]] });
    const r = await waitForJob(ctx, ctx.sh, { jobId: JOB, org: 'acme-qa', minutes: 30 });
    expect(r.status).toBeNull();
    expect(r.result).toBeNull();
    expect(r.stopped).toMatch(/^stopped at once:.*login rate exceeded/);
    expect(ctx.sh.calls.filter((l) => l === LINE)).toHaveLength(1);
    expect(ctx.sleeps).toEqual([]);
  });

  it('remembers the last status seen when the deadline comes', async () => {
    let n = 0;
    const ctx = fakeCtx({ rules: [['sf project deploy report', () => (++n === 1 ? sfOk({ status: 'Pending' }) : sfOk({ status: 'InProgress' }))]] });
    const r = await waitForJob(ctx, ctx.sh, { jobId: JOB, org: 'acme-qa', minutes: 1 });
    expect(r.status).toBe('InProgress');
  });

  it('a heartbeat that throws never breaks the wait', async () => {
    let n = 0;
    let beats = 0;
    const ctx = fakeCtx({
      rules: [['sf project deploy report', () => (++n === 1 ? sfOk({ status: 'InProgress' }) : sfOk(report({ status: 'Succeeded' })))]],
      report: () => {
        beats += 1;
        throw new Error('the beat file is gone');
      },
    });
    const r = await waitForJob(ctx, ctx.sh, { jobId: JOB, org: 'acme-qa', minutes: 30, label: 'deploying' });
    expect(r).toMatchObject({ status: 'Succeeded' });
    expect(ctx.sh.calls.filter((l) => l === LINE)).toHaveLength(2);
    expect(beats).toBe(2);
  });
});
