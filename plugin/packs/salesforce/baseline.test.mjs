import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  COVERAGE_NEEDED,
  advanceBaseline,
  baselineFile,
  baselineWrittenAt,
  clearBaseline,
  describe as describeProblems,
  isInherited,
  isTrusted,
  problemsOf,
  readBaseline,
  startBaseline,
  writeBaseline,
} from './baseline.mjs';
import { ACME_QA_ID, fakeSfShell, orgRecord, orgRoute, sfError, sfOk } from '../../../test/fake-sf.mjs';

const RUN = '707000000000001AAA';
const NOW = new Date('2026-10-24T09:00:00.000Z');
const LATER = new Date('2026-10-24T10:30:00.000Z');
const QA = { alias: 'acme-qa', orgId: ACME_QA_ID };

const START = 'apex run test --test-level RunLocalTests';
const RUN_RESULT = 'FROM ApexTestRunResult';
const TEST_RESULT = 'FROM ApexTestResult ';
const COVERAGE = 'FROM ApexOrgWideCoverage';

const rows = (records) => sfOk({ records, totalSize: records.length, done: true });
const statusOf = (Status) => rows([{ attributes: { type: 'ApexTestRunResult' }, Status }]);
const failed = (cls, method) => ({ attributes: { type: 'ApexTestResult' }, ApexClass: { attributes: { type: 'ApexClass' }, Name: cls }, MethodName: method });
const coverage = (n) => rows([{ attributes: { type: 'ApexOrgWideCoverage' }, PercentCovered: n }]);

const running = (over = {}) => ({ alias: 'acme-qa', orgId: ACME_QA_ID, testRunId: RUN, startedAt: NOW.toISOString(), state: 'running', ...over });
const done = (over = {}) => running({ state: 'done', finishedAt: LATER.toISOString(), failing: ['AcmeServiceTest.sumsTheOrder'], coverage: 19, ...over });

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-baseline-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('the baseline record', () => {
  it('lives at <stateDir>/salesforce/baseline/<alias>.json, and round-trips', () => {
    expect(baselineFile(dir, 'acme-qa')).toBe(path.join(dir, 'salesforce', 'baseline', 'acme-qa.json'));
    writeBaseline(dir, done());
    expect(readBaseline(dir, QA)).toEqual(done());
    clearBaseline(dir, 'acme-qa');
    expect(readBaseline(dir, QA)).toBeNull();
    expect(() => clearBaseline(dir, 'acme-qa')).not.toThrow();
  });

  it('matches the org on its first 15 characters, so the 15- and 18-character IDs agree', () => {
    writeBaseline(dir, done());
    expect(readBaseline(dir, { alias: 'acme-qa', orgId: ACME_QA_ID.slice(0, 15) })).toEqual(done());
  });

  it('reads as null when missing, broken, for another alias or org, or with a bad test run ID', () => {
    expect(readBaseline(dir, QA)).toBeNull();

    fs.mkdirSync(path.dirname(baselineFile(dir, 'acme-qa')), { recursive: true });
    fs.writeFileSync(baselineFile(dir, 'acme-qa'), '{ not json');
    expect(readBaseline(dir, QA)).toBeNull();
    fs.writeFileSync(baselineFile(dir, 'acme-qa'), '[1, 2]');
    expect(readBaseline(dir, QA)).toBeNull();

    writeBaseline(dir, done({ alias: 'acme-uat' }));
    fs.renameSync(baselineFile(dir, 'acme-uat'), baselineFile(dir, 'acme-qa'));
    expect(readBaseline(dir, QA)).toBeNull();

    writeBaseline(dir, done({ orgId: '00D000000000009AAA' }));
    expect(readBaseline(dir, QA)).toBeNull();

    writeBaseline(dir, done({ testRunId: "707x' OR Id != '" }));
    expect(readBaseline(dir, QA)).toBeNull();

    writeBaseline(dir, done());
    expect(readBaseline(dir, { alias: 'acme-qa', orgId: null })).toBeNull();
  });
});

describe('startBaseline', () => {
  const start = (routes) => {
    const sh = fakeSfShell({ [START]: sfOk({ testRunId: RUN }), ...routes });
    return { sh, r: startBaseline(sh, QA, NOW) };
  };

  it("starts the org's local tests with coverage, without waiting, and returns a running record", () => {
    const { sh, r } = start({ [orgRoute('acme-qa')]: orgRecord(ACME_QA_ID) });
    expect(r).toEqual({ ok: true, record: running() });
    expect(sh.sfLines()).toEqual([
      'data query --query SELECT Id, IsSandbox FROM Organization --target-org acme-qa --json',
      'apex run test --test-level RunLocalTests --code-coverage --target-org acme-qa --json',
    ]);
  });

  it('refuses an org that is not a sandbox, without starting any test', () => {
    const { sh, r } = start({ [orgRoute('acme-qa')]: orgRecord(ACME_QA_ID, false) });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('not a sandbox');
    expect(sh.sfLines().some((l) => l.includes('apex run test'))).toBe(false);
  });

  it('refuses an org with another org ID, without starting any test', () => {
    const { sh, r } = start({ [orgRoute('acme-qa')]: orgRecord('00D000000000009AAA') });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('00D000000000009');
    expect(sh.sfLines().some((l) => l.includes('apex run test'))).toBe(false);
  });

  it('refuses when the org cannot be checked, or has no org ID or a bad alias, without starting any test', () => {
    const failing = start({ [orgRoute('acme-qa')]: sfError('NoAuthInfoFound', 'No authorization information found for acme-qa.') });
    expect(failing.r).toMatchObject({ ok: false });
    expect(failing.sh.sfLines().some((l) => l.includes('apex run test'))).toBe(false);

    for (const org of [{ alias: 'acme-qa', orgId: null }, { alias: '--target-org', orgId: ACME_QA_ID }]) {
      const sh = fakeSfShell({});
      expect(startBaseline(sh, org, NOW).ok).toBe(false);
      expect(sh.sfLines()).toEqual([]);
    }
  });

  it('fails on a missing or bad test run ID, and when sf fails', () => {
    const org = { [orgRoute('acme-qa')]: orgRecord(ACME_QA_ID) };
    expect(start({ ...org, [START]: sfOk({}) }).r).toMatchObject({ ok: false });
    expect(start({ ...org, [START]: sfOk({ testRunId: "707x' OR Id != '" }) }).r).toMatchObject({ ok: false });
    const r = start({ ...org, [START]: sfError('SfError', 'Already running') }).r;
    expect(r).toEqual({ ok: false, reason: 'Already running' });
  });
});

describe('advanceBaseline', () => {
  const advance = (routes, record = running()) => {
    const sh = fakeSfShell(routes);
    return { sh, ...advanceBaseline(sh, record, LATER) };
  };

  it('reads the run status through the tooling API with the test run ID', () => {
    const { sh } = advance({ [RUN_RESULT]: statusOf('Queued') });
    expect(sh.sfLines()).toEqual([
      `data query --use-tooling-api --query SELECT Status FROM ApexTestRunResult WHERE AsyncApexJobId = '${RUN}' --target-org acme-qa --json`,
    ]);
  });

  it('leaves a run that is queued, processing, holding or not listed yet as it is', () => {
    for (const answer of [statusOf('Queued'), statusOf('Processing'), statusOf('Holding'), rows([])]) {
      const record = running();
      const r = advance({ [RUN_RESULT]: answer }, record);
      expect(r.record).toBe(record);
      expect(r.error).toBeUndefined();
      expect(r.sh.sfLines()).toHaveLength(1);
    }
  });

  it('marks an aborted or failed run aborted', () => {
    for (const status of ['Aborted', 'Failed']) {
      const r = advance({ [RUN_RESULT]: statusOf(status) });
      expect(r.record).toEqual(running({ state: 'aborted', finishedAt: LATER.toISOString() }));
    }
  });

  it('records the failing tests, sorted and once each, and the org-wide coverage, rounded', () => {
    const r = advance({
      [RUN_RESULT]: statusOf('Completed'),
      [TEST_RESULT]: rows([failed('AcmeServiceTest', 'sumsTheOrder'), failed('AcmeServiceTest', 'sumsTheOrder')]),
      [COVERAGE]: coverage(19.4),
    });
    expect(r.record).toEqual(done());
    expect(r.error).toBeUndefined();
    const lines = r.sh.sfLines();
    expect(lines[1]).toBe(`data query --use-tooling-api --query SELECT ApexClass.Name, MethodName FROM ApexTestResult WHERE AsyncApexJobId = '${RUN}' AND Outcome IN ('Fail', 'CompileFail') --target-org acme-qa --json`);
    expect(lines[2]).toBe('data query --use-tooling-api --query SELECT PercentCovered FROM ApexOrgWideCoverage --target-org acme-qa --json');
  });

  it('sorts several failing tests and drops names that are not test names', () => {
    const r = advance({
      [RUN_RESULT]: statusOf('Completed'),
      [TEST_RESULT]: rows([failed('AcmeZedTest', 'b'), failed('AcmeAlphaTest', 'a'), failed("x' OR 1", 'y'), failed('AcmeTest', ''), { MethodName: 'orphan' }]),
      [COVERAGE]: coverage(82),
    });
    expect(r.record.failing).toEqual(['AcmeAlphaTest.a', 'AcmeZedTest.b']);
    expect(r.record.coverage).toBe(82);
  });

  it('records null coverage when the org has no Apex', () => {
    const r = advance({ [RUN_RESULT]: statusOf('Completed'), [TEST_RESULT]: rows([]), [COVERAGE]: rows([]) });
    expect(r.record).toEqual(done({ failing: [], coverage: null }));
  });

  it('keeps the record and gives the error when a query fails', () => {
    for (const routes of [
      { [RUN_RESULT]: sfError('SfError', 'Request timed out') },
      { [RUN_RESULT]: statusOf('Completed'), [TEST_RESULT]: sfError('SfError', 'Request timed out'), [COVERAGE]: coverage(82) },
      { [RUN_RESULT]: statusOf('Completed'), [TEST_RESULT]: rows([]), [COVERAGE]: sfError('SfError', 'Request timed out') },
    ]) {
      const record = running();
      const r = advance(routes, record);
      expect(r.record).toBe(record);
      expect(r.error).toBe('Request timed out');
    }
  });

  it('runs no query for a record whose test run ID is not one', () => {
    const record = running({ testRunId: "707x' OR Id != '" });
    const r = advance({}, record);
    expect(r.record).toBe(record);
    expect(r.error).toBeTruthy();
    expect(r.sh.sfLines()).toEqual([]);
  });
});

describe('problemsOf and describe', () => {
  it('is null for a clean, running or aborted record', () => {
    expect(problemsOf(done({ failing: [], coverage: 82 }))).toBeNull();
    expect(problemsOf(done({ failing: [], coverage: null }))).toBeNull();
    expect(problemsOf(running())).toBeNull();
    expect(problemsOf(running({ state: 'aborted' }))).toBeNull();
    expect(problemsOf(null)).toBeNull();
  });

  it('names the failing tests and the low coverage, unless coverage is left out', () => {
    expect(COVERAGE_NEEDED).toBe(75);
    expect(problemsOf(done())).toEqual({ failing: ['AcmeServiceTest.sumsTheOrder'], coverage: 19 });
    expect(problemsOf(done({ failing: [] }))).toEqual({ failing: [], coverage: 19 });
    expect(problemsOf(done({ failing: [] }), { coverage: false })).toBeNull();
    expect(problemsOf(done(), { coverage: false })).toEqual({ failing: ['AcmeServiceTest.sumsTheOrder'], coverage: null });
    expect(problemsOf(done({ failing: [], coverage: 75 }))).toBeNull();
  });

  it('says it in one phrase, dropping the half that does not apply', () => {
    expect(describeProblems(problemsOf(done()))).toBe('already fails 1 test (AcmeServiceTest.sumsTheOrder) and has 19% Apex coverage (75% needed)');
    expect(describeProblems(problemsOf(done({ failing: [] })))).toBe('has 19% Apex coverage (75% needed)');
    expect(describeProblems(problemsOf(done({ coverage: 82 })))).toBe('already fails 1 test (AcmeServiceTest.sumsTheOrder)');
    const many = ['A.a', 'B.b', 'C.c', 'D.d', 'E.e', 'F.f', 'G.g'];
    expect(describeProblems({ failing: many, coverage: null })).toBe('already fails 7 tests (A.a, B.b, C.c, D.d, E.e and 2 more)');
  });
});

describe('isInherited', () => {
  const test = (name) => ({ kind: 'test', name, message: 'Assertion Failed' });
  const orgWide = { kind: 'coverage', name: '', message: 'Average test coverage across all Apex Classes and Triggers is 19%, at least 75% test coverage is required.' };

  it('is true when every failure is a test the baseline lists', () => {
    expect(isInherited([test('AcmeServiceTest.sumsTheOrder')], done())).toBe(true);
  });

  it('is true with an org-wide coverage warning while the baseline coverage is low', () => {
    expect(isInherited([test('AcmeServiceTest.sumsTheOrder'), orgWide], done())).toBe(true);
    expect(isInherited([orgWide], done({ failing: [] }))).toBe(true);
    expect(isInherited([{ ...orgWide, name: 'AcmeService' }], done())).toBe(true);
  });

  it('is false with a component failure, an unlisted test or a per-class coverage warning', () => {
    const component = { kind: 'component', name: 'ApexClass AcmeService line 14', message: 'Variable does not exist: total' };
    expect(isInherited([test('AcmeServiceTest.sumsTheOrder'), component], done())).toBe(false);
    expect(isInherited([test('AcmeServiceTest.sumsTheOrder'), test('AcmeOtherTest.adds')], done())).toBe(false);
    const perClass = { kind: 'coverage', name: 'AcmeService', message: 'Test coverage of selected Apex Class is 10%, at least 75% test coverage is required' };
    expect(isInherited([test('AcmeServiceTest.sumsTheOrder'), perClass], done())).toBe(false);
  });

  it('is false with an org-wide warning when the baseline coverage was fine', () => {
    expect(isInherited([test('AcmeServiceTest.sumsTheOrder'), orgWide], done({ coverage: 82 }))).toBe(false);
    expect(isInherited([orgWide], done({ coverage: null }))).toBe(false);
  });

  it('is false with no failures, or without a done baseline', () => {
    expect(isInherited([], done())).toBe(false);
    expect(isInherited([test('AcmeServiceTest.sumsTheOrder')], running())).toBe(false);
    expect(isInherited([test('AcmeServiceTest.sumsTheOrder')], null)).toBe(false);
    expect(isInherited(null, done())).toBe(false);
  });
});

describe('isTrusted and baselineWrittenAt', () => {
  // done() finished at LATER; the story branch was created an hour after it.
  const before = LATER.getTime() + 30 * 60 * 1000;
  const start = LATER.getTime() + 60 * 60 * 1000;

  it('trusts a done record finished and written before the story branch was created', () => {
    expect(isTrusted(done(), before, start)).toBe(true);
  });

  it('does not trust a record finished at or after the branch was created', () => {
    expect(isTrusted(done({ finishedAt: new Date(start).toISOString() }), before, start)).toBe(false);
    expect(isTrusted(done({ finishedAt: new Date(start + 1000).toISOString() }), before, start)).toBe(false);
  });

  it('does not trust a file written at or after the branch was created, though its finishedAt is old', () => {
    expect(isTrusted(done(), start, start)).toBe(false);
    expect(isTrusted(done(), start + 1000, start)).toBe(false);
  });

  it('does not trust a missing or unparsable finishedAt', () => {
    expect(isTrusted(done({ finishedAt: undefined }), before, start)).toBe(false);
    expect(isTrusted(done({ finishedAt: 'yesterday-ish' }), before, start)).toBe(false);
    expect(isTrusted(done({ finishedAt: 0 }), before, start)).toBe(false);
  });

  it('does not trust a record with no written time, no branch start, or a state other than done', () => {
    expect(isTrusted(done(), null, start)).toBe(false);
    expect(isTrusted(done(), NaN, start)).toBe(false);
    expect(isTrusted(done(), before, null)).toBe(false);
    expect(isTrusted(done(), before, NaN)).toBe(false);
    expect(isTrusted(running({ finishedAt: LATER.toISOString() }), before, start)).toBe(false);
    expect(isTrusted(done({ state: 'aborted' }), before, start)).toBe(false);
    expect(isTrusted(null, before, start)).toBe(false);
  });

  it("gives the baseline file's mtime, or null when there is no file", () => {
    expect(baselineWrittenAt(dir, 'acme-qa')).toBeNull();
    writeBaseline(dir, done());
    const at = new Date('2026-10-23T09:00:00.000Z');
    fs.utimesSync(baselineFile(dir, 'acme-qa'), at, at);
    expect(baselineWrittenAt(dir, 'acme-qa')).toBe(at.getTime());
  });
});
