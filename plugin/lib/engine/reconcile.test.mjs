import { describe, expect, it } from 'vitest';
import { reconcile, recoverySteps } from './reconcile.mjs';

const none = { shipLock: null, claims: [], mergedNotDone: [], inProgress: [] };

describe('reconcile', () => {
  it('has nothing to do on a clean start', () => expect(reconcile(none)).toEqual([{ type: 'clear-stale' }]));
  it('finishes a release cut off between the hosted migration and the merge, first', () => {
    const r = reconcile({ ...none, shipLock: { story: 'P6-02', slot: 'w3', stage: 'hosted-db', stale: true }, claims: [{ id: 'P6-02', slot: 'w3', by: 'factory', stale: true }] });
    expect(r[0]).toEqual({ type: 'finish-release', id: 'P6-02', slot: 'w3' });
    expect(r.filter((a) => a.id === 'P6-02')).toHaveLength(1);
  });
  it('resumes, rather than finishes, a release cut off before the hosted step', () => {
    const r = reconcile({ ...none, shipLock: { story: 'P7-01', slot: 'w1', stage: 'ci', stale: true }, claims: [{ id: 'P7-01', slot: 'w1', by: 'factory', stale: true }] });
    expect(r[0]).toEqual({ type: 'resume', id: 'P7-01', slot: null, from: 'w1' });
  });
  it('gives a close action no slot of its own (any slot takes it)', () => {
    const r = reconcile({ shipLock: null, mergedNotDone: ['S-1'] });
    expect(r[0]).toEqual({ type: 'close', id: 'S-1', slot: null });
  });

  it('closes merged stories before resuming others', () => {
    const r = reconcile({ ...none, mergedNotDone: ['P7-04'], claims: [{ id: 'P8-01', slot: 'w2', by: 'factory', stale: true }] });
    expect(r.map((a) => a.type)).toEqual(['close', 'resume', 'clear-stale']);
  });
  it('resumes an in-progress story with a branch, but not one without', () => {
    const r = reconcile({ ...none, inProgress: [{ id: 'P7-05', branch: true }, { id: 'P7-06', branch: false }] });
    expect(r).toContainEqual({ type: 'resume', id: 'P7-05', slot: null, from: null });
    expect(r.find((a) => a.id === 'P7-06')).toBeUndefined();
  });
  it('puts the resumes in the order of the priority list, not claim order', () => {
    const claims = [{ id: 'ACME-2', slot: 'w1', by: 'factory', stale: true }, { id: 'ACME-3', slot: 'w2', by: 'factory', stale: true }];
    const r = reconcile({ ...none, claims, priority: ['ACME-3', 'ACME-2'] });
    expect(r.map((a) => a.id ?? a.type)).toEqual(['ACME-3', 'ACME-2', 'clear-stale']);
  });
  it('puts a resume whose id is not in the priority list after the ones that are, in found order', () => {
    const claims = [{ id: 'ACME-9', slot: 'w1', by: 'factory', stale: true }, { id: 'ACME-8', slot: 'w2', by: 'factory', stale: true }, { id: 'ACME-3', slot: 'w3', by: 'factory', stale: true }];
    const r = reconcile({ ...none, claims, priority: ['ACME-3'] });
    expect(r.map((a) => a.id ?? a.type)).toEqual(['ACME-3', 'ACME-9', 'ACME-8', 'clear-stale']);
  });
  it('ranks a claim resume and an in-progress resume together', () => {
    const claims = [{ id: 'ACME-2', slot: 'w1', by: 'factory', stale: true }];
    const r = reconcile({ ...none, claims, inProgress: [{ id: 'ACME-1', branch: true }], priority: ['ACME-1', 'ACME-2'] });
    expect(r.map((a) => a.id ?? a.type)).toEqual(['ACME-1', 'ACME-2', 'clear-stale']);
  });
  it("keeps the claim's entry, with its from, over the same id's in-progress entry", () => {
    const claims = [{ id: 'ACME-2', slot: 'w2', by: 'factory', stale: true }];
    const r = reconcile({ ...none, claims, inProgress: [{ id: 'ACME-2', branch: true }] });
    expect(r).toEqual([{ type: 'resume', id: 'ACME-2', slot: null, from: 'w2' }, { type: 'clear-stale' }]);
  });
  it('keeps the slot of a finish-release and of a release-claim, and puts the resumes after them and the closes', () => {
    const claims = [
      { id: 'ACME-1', slot: 'w1', by: 'factory', stale: true },
      { id: 'ACME-2', slot: 'w2', by: 'factory', stale: true },
      { id: 'ACME-3', slot: 'w3', by: 'factory', stale: true },
    ];
    const r = reconcile({ ...none, shipLock: { story: 'ACME-1', slot: 'w1', stage: 'merge', stale: true }, mergedNotDone: ['ACME-4'], claims, readyToPromote: ['ACME-3'] });
    expect(r).toEqual([
      { type: 'finish-release', id: 'ACME-1', slot: 'w1' },
      { type: 'close', id: 'ACME-4', slot: null },
      { type: 'release-claim', id: 'ACME-3', slot: 'w3' },
      { type: 'resume', id: 'ACME-2', slot: null, from: 'w2' },
      { type: 'clear-stale' },
    ]);
  });
  it('leaves owner claims and live claims alone', () => {
    const r = reconcile({ ...none, claims: [{ id: 'P7-07', slot: null, by: 'owner', stale: false }, { id: 'P7-08', slot: 'w1', by: 'factory', stale: false }] });
    expect(r).toEqual([{ type: 'clear-stale' }]);
  });
});

describe('reconcile readyToPromote', () => {
  const stale = { id: 'S-1', slot: 'w1', by: 'factory', stale: true };
  it('lets go of a stale factory claim on a ready-to-promote story instead of resuming it', () => {
    const r = reconcile({ ...none, claims: [stale], readyToPromote: ['S-1'] });
    expect(r).toEqual([{ type: 'release-claim', id: 'S-1', slot: 'w1' }, { type: 'clear-stale' }]);
    expect(r.some((a) => a.type === 'resume')).toBe(false);
  });
  it('still resumes the same claim when the story is not ready to promote', () => {
    expect(reconcile({ ...none, claims: [stale] })).toEqual([{ type: 'resume', id: 'S-1', slot: null, from: 'w1' }, { type: 'clear-stale' }]);
  });
  it('leaves a live claim or an owner claim on a ready-to-promote story alone', () => {
    const claims = [{ id: 'S-1', slot: 'w1', by: 'factory', stale: false }, { id: 'S-2', slot: null, by: 'owner', stale: true }];
    expect(reconcile({ ...none, claims, readyToPromote: ['S-1', 'S-2'] })).toEqual([{ type: 'clear-stale' }]);
  });
  it('gives a ready-to-promote id that is also merged one action', () => {
    const r = reconcile({ ...none, claims: [stale], mergedNotDone: ['S-1'], readyToPromote: ['S-1'] });
    expect(r.filter((a) => a.id === 'S-1')).toHaveLength(1);
  });
});

describe('reconcile mustFinish', () => {
  const cutOff = (stage) => ({ ...none, shipLock: { story: 'S-1', slot: 'w1', stage, stale: true } });
  it('by default finishes a release cut off at hosted-db, merge or migrate-supabase', () => {
    for (const stage of ['hosted-db', 'merge', 'migrate-supabase']) {
      expect(reconcile(cutOff(stage))[0]).toEqual({ type: 'finish-release', id: 'S-1', slot: 'w1' });
    }
  });
  it('takes the stages to finish from the caller', () => {
    expect(reconcile({ ...cutOff('deploy'), mustFinish: ['deploy'] })[0].type).toBe('finish-release');
    expect(reconcile({ ...cutOff('merge'), mustFinish: ['deploy'] })[0].type).toBe('clear-stale');
  });
});

describe('recoverySteps', () => {
  it('lets go of a parked story\'s claim, posts its event, and breaks the ship lock last', () => {
    expect(recoverySteps([{ type: 'release-claim', id: 'S-1', slot: 'w1' }, { type: 'clear-stale' }])).toEqual([
      { do: 'break-claim', id: 'S-1', slot: 'w1' },
      { do: 'event', text: 'Start-up: letting go of S-1; its release is parked and finishes later.', kind: 'info', slot: 'w1' },
      { do: 'break-ship' },
    ]);
  });

  it('queues finish-release, close and resume each just before its event, in plan order', () => {
    const r = recoverySteps([
      { type: 'finish-release', id: 'X', slot: 'w2' },
      { type: 'close', id: 'Y', slot: null },
      { type: 'resume', id: 'Z', slot: null, from: 'w1' },
      { type: 'clear-stale' },
    ]);
    expect(r).toEqual([
      { do: 'queue', slot: 'w2', id: 'X', mode: '' },
      { do: 'event', text: 'Start-up: finishing the release of X.', kind: 'info', slot: 'w2' },
      { do: 'queue', slot: null, id: 'Y', mode: '' },
      { do: 'event', text: 'Start-up: closing Y.', kind: 'info', slot: null },
      { do: 'queue', slot: null, id: 'Z', mode: '', from: 'w1', ranked: true },
      { do: 'event', text: 'Start-up: resuming Z.', kind: 'info', slot: 'w1' },
      { do: 'break-ship' },
    ]);
  });

  it('keeps plan order end to end from the real planner', () => {
    const plan = reconcile({
      ...none,
      shipLock: { story: 'ACME-1', slot: 'w1', stage: 'merge', stale: true },
      mergedNotDone: ['ACME-2'],
      claims: [{ id: 'ACME-3', slot: 'w2', by: 'factory', stale: true }],
      readyToPromote: ['ACME-3'],
    });
    const r = recoverySteps(plan);
    expect(r.map((e) => e.do)).toEqual(['queue', 'event', 'queue', 'event', 'break-claim', 'event', 'break-ship']);
    expect(r.filter((e) => e.do !== 'break-ship').map((e) => e.id ?? e.text.match(/ACME-\d/)[0])).toEqual(['ACME-1', 'ACME-1', 'ACME-2', 'ACME-2', 'ACME-3', 'ACME-3']);
  });

  it('gives an action with no slot a null slot on its queue and its event', () => {
    expect(recoverySteps([{ type: 'resume', id: 'S-2' }])).toEqual([
      { do: 'queue', slot: null, id: 'S-2', mode: '', from: null, ranked: true },
      { do: 'event', text: 'Start-up: resuming S-2.', kind: 'info', slot: null },
    ]);
  });

  it('has nothing to do for an empty plan', () => {
    expect(recoverySteps([])).toEqual([]);
  });
});
