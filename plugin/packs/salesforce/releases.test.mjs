import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deployedFile, markReached, readDeployed, readRelease, recordAgent, recordFirstDeploy, recordRollback, releaseFile, rolledBackAt, writeDeployed } from './releases.mjs';
import { ACME_QA_ID } from '../../../test/fake-sf.mjs';

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-releases-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const FIRST = { stage: 'qa', org: 'acme-qa', orgId: ACME_QA_ID, branch: 'qa', merge: 'm1', method: 'merge', jobId: '0Af000000000001AAA', deployedAt: '2026-10-24T10:00:00.000Z' };

describe('the release record of a story', () => {
  it('lives at <state>/salesforce/releases/<story>.json and reads null when missing or broken', () => {
    expect(releaseFile(dir, 'S-1')).toBe(path.join(dir, 'salesforce', 'releases', 'S-1.json'));
    expect(readRelease(dir, 'S-1')).toBeNull();
    fs.mkdirSync(path.dirname(releaseFile(dir, 'S-1')), { recursive: true });
    fs.writeFileSync(releaseFile(dir, 'S-1'), '{ not json');
    expect(readRelease(dir, 'S-1')).toBeNull();
    fs.writeFileSync(releaseFile(dir, 'S-1'), '[1, 2]');
    expect(readRelease(dir, 'S-1')).toBeNull();
  });

  it('markReached adds each stage once, in order', () => {
    expect(markReached(dir, 'S-1', 'qa', 'bbb')).toEqual({ story: 'S-1', to: 'bbb', reached: ['qa'], first: null, rolledBack: null });
    markReached(dir, 'S-1', 'qa', 'bbb');
    markReached(dir, 'S-1', 'uat', 'bbb');
    expect(readRelease(dir, 'S-1')).toEqual({ story: 'S-1', to: 'bbb', reached: ['qa', 'uat'], first: null, rolledBack: null });
  });

  it('a different `to` starts a fresh record', () => {
    markReached(dir, 'S-1', 'qa', 'bbb');
    markReached(dir, 'S-1', 'uat', 'bbb');
    recordFirstDeploy(dir, 'S-1', FIRST);
    recordRollback(dir, 'S-1', { revert: 'r1', jobId: null, at: '2026-10-24T11:00:00.000Z' });
    expect(markReached(dir, 'S-1', 'qa', 'ccc')).toEqual({ story: 'S-1', to: 'ccc', reached: ['qa'], first: null, rolledBack: null });
  });

  it('recordFirstDeploy and recordRollback keep the other fields', () => {
    markReached(dir, 'S-1', 'qa', 'bbb');
    recordFirstDeploy(dir, 'S-1', FIRST);
    expect(readRelease(dir, 'S-1')).toEqual({ story: 'S-1', to: 'bbb', reached: ['qa'], first: FIRST, rolledBack: null });
    const rolledBack = { revert: 'r1', jobId: '0Af000000000002AAA', at: '2026-10-24T11:00:00.000Z' };
    recordRollback(dir, 'S-1', rolledBack);
    expect(readRelease(dir, 'S-1')).toEqual({ story: 'S-1', to: 'bbb', reached: ['qa'], first: FIRST, rolledBack });
  });

  it('a new first deploy clears rolledBack', () => {
    markReached(dir, 'S-1', 'qa', 'bbb');
    recordFirstDeploy(dir, 'S-1', FIRST);
    recordRollback(dir, 'S-1', { revert: 'r1', jobId: null, at: '2026-10-24T11:00:00.000Z' });
    recordFirstDeploy(dir, 'S-1', { ...FIRST, merge: 'm2' });
    expect(readRelease(dir, 'S-1')).toEqual({ story: 'S-1', to: 'bbb', reached: ['qa'], first: { ...FIRST, merge: 'm2' }, rolledBack: null });
  });

  it('keeps each story in its own file, inside the state dir', () => {
    markReached(dir, '../x', 'qa', 'bbb');
    const file = releaseFile(dir, '../x');
    expect(path.dirname(file)).toBe(path.join(dir, 'salesforce', 'releases'));
    expect(fs.existsSync(file)).toBe(true);
    expect(readRelease(dir, '../x')).toMatchObject({ story: '../x', reached: ['qa'] });
    expect(readRelease(dir, 'S-1')).toBeNull();
  });
});

describe('the agents a release published', () => {
  const AGENT = { stage: 'qa', org: 'acme-qa', apiName: 'Acme_Order_Helper', previous: 1, version: 2, at: '2026-10-24T10:00:00.000Z' };

  it('recordAgent appends one entry per stage and agent, keeping the other fields', () => {
    markReached(dir, 'S-1', 'qa', 'bbb');
    recordFirstDeploy(dir, 'S-1', FIRST);
    const other = { ...AGENT, apiName: 'Acme_Case_Helper', previous: null, version: 1 };
    recordAgent(dir, 'S-1', AGENT);
    expect(recordAgent(dir, 'S-1', other)).toEqual({ story: 'S-1', to: 'bbb', reached: ['qa'], first: FIRST, rolledBack: null, agents: [AGENT, other] });
    expect(readRelease(dir, 'S-1').agents).toEqual([AGENT, other]);
  });

  it('a retried publish replaces the version but keeps the first previous', () => {
    recordAgent(dir, 'S-1', AGENT);
    recordAgent(dir, 'S-1', { ...AGENT, previous: 2, version: 3, at: '2026-10-24T11:00:00.000Z' });
    expect(readRelease(dir, 'S-1').agents).toEqual([{ ...AGENT, previous: 1, version: 3, at: '2026-10-24T11:00:00.000Z' }]);
  });

  it('keeps an entry per stage for the same agent', () => {
    recordAgent(dir, 'S-1', AGENT);
    recordAgent(dir, 'S-1', { ...AGENT, stage: 'uat', org: 'acme-uat', previous: 5, version: 6 });
    expect(readRelease(dir, 'S-1').agents.map((a) => [a.stage, a.previous])).toEqual([['qa', 1], ['uat', 5]]);
  });

  it('markReached with the same `to` keeps the agents; a new `to` drops them', () => {
    markReached(dir, 'S-1', 'qa', 'bbb');
    recordAgent(dir, 'S-1', AGENT);
    expect(markReached(dir, 'S-1', 'uat', 'bbb').agents).toEqual([AGENT]);
    expect(markReached(dir, 'S-1', 'qa', 'ccc')).toEqual({ story: 'S-1', to: 'ccc', reached: ['qa'], first: null, rolledBack: null });
  });

  it('reads a record without agents as none', () => {
    markReached(dir, 'S-1', 'qa', 'bbb');
    expect(readRelease(dir, 'S-1').agents).toBeUndefined();
    expect(recordAgent(dir, 'S-1', AGENT).agents).toEqual([AGENT]);
    fs.writeFileSync(releaseFile(dir, 'S-1'), JSON.stringify({ story: 'S-1', to: 'bbb', reached: ['qa'], first: null, rolledBack: null, agents: 'broken' }));
    expect(recordAgent(dir, 'S-1', AGENT).agents).toEqual([AGENT]);
  });
});

describe('rolledBackAt', () => {
  const AT = '2026-10-24T11:00:00.000Z';

  it('is null with no file, a broken file, or rolledBack null', () => {
    expect(rolledBackAt(dir, 'S-1')).toBeNull();
    fs.mkdirSync(path.dirname(releaseFile(dir, 'S-1')), { recursive: true });
    fs.writeFileSync(releaseFile(dir, 'S-1'), '{ not json');
    expect(rolledBackAt(dir, 'S-1')).toBeNull();
    markReached(dir, 'S-2', 'qa', 'bbb');
    expect(rolledBackAt(dir, 'S-2')).toBeNull();
  });

  it('is null for a rolledBack that is not an object with a text `at`', () => {
    fs.mkdirSync(path.dirname(releaseFile(dir, 'S-1')), { recursive: true });
    for (const rolledBack of ['yes', ['x'], {}, { at: 5 }, { at: '' }]) {
      fs.writeFileSync(releaseFile(dir, 'S-1'), JSON.stringify({ story: 'S-1', to: 'a', reached: [], first: null, rolledBack }));
      expect(rolledBackAt(dir, 'S-1')).toBeNull();
    }
  });

  it('gives `at` after recordRollback', () => {
    markReached(dir, 'S-1', 'qa', 'bbb');
    recordFirstDeploy(dir, 'S-1', FIRST);
    recordRollback(dir, 'S-1', { revert: 'r1', jobId: null, at: AT });
    expect(rolledBackAt(dir, 'S-1')).toBe(AT);
  });

  it('is null again after a new first deploy, and after a new `to`', () => {
    markReached(dir, 'S-1', 'qa', 'bbb');
    recordRollback(dir, 'S-1', { revert: 'r1', jobId: null, at: AT });
    recordFirstDeploy(dir, 'S-1', FIRST);
    expect(rolledBackAt(dir, 'S-1')).toBeNull();
    recordRollback(dir, 'S-1', { revert: 'r1', jobId: null, at: AT });
    markReached(dir, 'S-1', 'qa', 'ccc');
    expect(rolledBackAt(dir, 'S-1')).toBeNull();
  });
});

describe('the last deploy Foreman made to a stage', () => {
  const REC = { stage: 'qa', org: 'acme-qa', orgId: ACME_QA_ID, jobId: '0Af000000000001AAA', story: 'S-1', commit: 'm1', at: '2026-10-24T10:00:00.000Z' };

  it('round-trips per stage, and reads null when missing or broken', () => {
    expect(readDeployed(dir, 'qa')).toBeNull();
    expect(writeDeployed(dir, REC)).toEqual(REC);
    expect(readDeployed(dir, 'qa')).toEqual(REC);
    expect(readDeployed(dir, 'uat')).toBeNull();
    expect(deployedFile(dir, 'qa')).toBe(path.join(dir, 'salesforce', 'deployed', 'qa.json'));
    fs.writeFileSync(deployedFile(dir, 'qa'), 'nope');
    expect(readDeployed(dir, 'qa')).toBeNull();
  });

  it('replaces the stage record and keeps a ../ stage inside the state dir', () => {
    writeDeployed(dir, REC);
    writeDeployed(dir, { ...REC, story: 'S-2', commit: 'm2' });
    expect(readDeployed(dir, 'qa')).toMatchObject({ story: 'S-2', commit: 'm2' });
    expect(path.dirname(deployedFile(dir, '../x'))).toBe(path.join(dir, 'salesforce', 'deployed'));
  });
});
