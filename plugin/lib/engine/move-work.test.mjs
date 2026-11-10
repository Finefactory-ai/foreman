import { describe, expect, it } from 'vitest';
import { takeOver } from './move-work.mjs';

// Every dependency records its call in order into `calls`, and each event into `events`.
function deps(overrides = {}) {
  const calls = [];
  const events = [];
  const d = {
    workers: 3,
    branch: 'story/acme-1',
    folderReady: () => (calls.push('folderReady'), true),
    moveHolds: (from) => calls.push(`moveHolds:${from}`),
    claim: () => (calls.push('claim'), true),
    closed: () => (calls.push('closed'), false),
    freeFolder: (from) => (calls.push(`freeFolder:${from}`), { freed: true, committed: false, problem: null }),
    letGo: () => calls.push('letGo'),
    event: (text, kind) => events.push([text, kind]),
    ...overrides,
  };
  // An override replaces the recording default, so wrap the ones a test passes in.
  for (const [name, fn] of Object.entries(overrides)) {
    if (typeof fn !== 'function' || name === 'event') continue;
    d[name] = (...args) => {
      calls.push(name === 'moveHolds' || name === 'freeFolder' ? `${name}:${args[0]}` : name);
      return fn(...args);
    };
  }
  return { d, calls, events };
}

const HELD = ['ACME-1 is held by someone else; not resuming it.', 'warn'];

describe('takeOver', () => {
  it('waits, with the work untouched, when the new slot folder is not ready', () => {
    const w = { id: 'ACME-1', slot: null, from: 'w4' };
    const { d, calls, events } = deps({ folderReady: () => false });
    expect(takeOver(w, 'w1', d)).toBe('wait');
    expect(calls).toEqual(['folderReady']);
    expect(events).toEqual([]);
    expect(w.from).toBe('w4');
  });

  it('checks the claim before the old folder is touched', () => {
    const w = { id: 'ACME-1', slot: null, from: 'w4', resume: true };
    const { d, calls, events } = deps({ claim: () => false });
    expect(takeOver(w, 'w1', d)).toBe('refused');
    expect(calls).toEqual(['folderReady', 'moveHolds:w4', 'claim']);
    expect(events).toEqual([HELD]);
    expect(w.from).toBe('w4');
  });

  it('lets go of the story when its old folder cannot be freed', () => {
    const w = { id: 'ACME-1', slot: null, from: 'w4' };
    const problem = 'could not commit its changes to story/acme-1';
    const { d, calls, events } = deps({ freeFolder: () => ({ freed: false, committed: false, problem }) });
    expect(takeOver(w, 'w1', d)).toBe('let-go');
    expect(calls).toEqual(['folderReady', 'moveHolds:w4', 'claim', 'closed', 'freeFolder:w4', 'letGo']);
    expect(events).toEqual([[`ACME-1 could not move from w4 to w1: ${problem}; let go of it, so it is picked again by priority.`, 'warn']]);
  });

  it('moves the story, says so, and drops from so a retry is a plain resume', () => {
    const w = { id: 'ACME-1', slot: null, from: 'w4' };
    const first = deps({ freeFolder: () => ({ freed: true, committed: true, problem: null }) });
    expect(takeOver(w, 'w1', first.d)).toBe('start');
    expect(first.calls).toEqual(['folderReady', 'moveHolds:w4', 'claim', 'closed', 'freeFolder:w4', 'claim']);
    expect(first.events).toEqual([['ACME-1 moved from w4 to w1, as w4 is over the worker count; its unfinished work in w4 is committed on story/acme-1.', 'info']]);
    expect('from' in w).toBe(false);

    const retry = deps();
    expect(takeOver(w, 'w2', retry.d)).toBe('start');
    expect(retry.calls).toEqual(['closed', 'claim']);
    expect(retry.events).toEqual([]);
  });

  it('does not say the slot is over the worker count when it is not', () => {
    const w = { id: 'ACME-1', slot: null, from: 'w2' };
    const { d, events } = deps({ workers: 3 });
    expect(takeOver(w, 'w1', d)).toBe('start');
    expect(events).toEqual([['ACME-1 moved from w2 to w1.', 'info']]);
  });

  it('keeps the order for work with no from: closed, then claim', () => {
    const w = { id: 'ACME-1', slot: 'w1' };
    const plain = deps();
    expect(takeOver(w, 'w1', plain.d)).toBe('start');
    expect(plain.calls).toEqual(['closed', 'claim']);

    const closed = deps({ closed: () => true });
    expect(takeOver({ id: 'ACME-1' }, 'w1', closed.d)).toBe('closed');
    expect(closed.calls).toEqual(['closed']);

    const held = deps({ claim: () => false });
    expect(takeOver({ id: 'ACME-1' }, 'w1', held.d)).toBe('refused');
    expect(held.calls).toEqual(['closed', 'claim']);
    expect(held.events).toEqual([HELD]);
  });

  it('treats a from equal to the slot as no move', () => {
    const w = { id: 'ACME-1', from: 'w1' };
    const { d, calls } = deps();
    expect(takeOver(w, 'w1', d)).toBe('start');
    expect(calls).toEqual(['closed', 'claim']);
  });

  it('moves the holds but frees no folder when from is not a slot id', () => {
    const w = { id: 'ACME-1', from: 'x' };
    const { d, calls, events } = deps();
    expect(takeOver(w, 'w1', d)).toBe('start');
    expect(calls).toEqual(['folderReady', 'moveHolds:x', 'claim', 'closed', 'claim']);
    expect(events).toEqual([]);
    expect('from' in w).toBe(false);
  });

  it('closes a resume that needs no session after the move check, without freeing the folder', () => {
    const w = { id: 'ACME-1', from: 'w4', resume: true };
    const { d, calls } = deps({ closed: () => true });
    expect(takeOver(w, 'w1', d)).toBe('closed');
    expect(calls).toEqual(['folderReady', 'moveHolds:w4', 'claim', 'closed']);
  });
});
