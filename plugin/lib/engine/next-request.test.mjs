// The owner's "build next" request as plain data: when one is open, how a story that cannot
// start yet is counted, and the sentence shown once it has failed enough times.

import { describe, expect, it } from 'vitest';
import { NEXT_TRIES, briefNote, failedTry, isStoryId, nextWaitWhy, openRequest, requestVerdict, runningSlot } from './next-request.mjs';

const REQ = { id: 'ACME-2', at: '2026-10-30T10:00:00.000Z' };
const T1 = new Date('2026-10-30T10:01:00.000Z');
const T2 = new Date('2026-10-30T10:02:00.000Z');
const T3 = new Date('2026-10-30T10:03:00.000Z');
const WHY = 'could not fetch origin/main';

describe('openRequest', () => {
  it('gives the id and time of a fresh request, with the id trimmed', () => {
    expect(openRequest({ nextStory: ' ACME-2 ', requestedAt: REQ.at }, undefined)).toEqual(REQ);
  });

  it.each([
    ['no story', { requestedAt: REQ.at }, undefined],
    ['a blank story', { nextStory: '  ', requestedAt: REQ.at }, undefined],
    ['no time', { nextStory: 'ACME-2' }, undefined],
    ['a request already handled', { nextStory: 'ACME-2', requestedAt: REQ.at }, REQ.at],
    ['a story that is not text', { nextStory: 7, requestedAt: REQ.at }, undefined],
  ])('gives null for %s', (_, control, handled) => {
    expect(openRequest(control, handled)).toBeNull();
  });

  it('is open again for a new request time', () => {
    expect(openRequest({ nextStory: 'ACME-2', requestedAt: 'later' }, REQ.at)).toEqual({ id: 'ACME-2', at: 'later' });
  });
});

describe('isStoryId and briefNote', () => {
  it('accepts a plain story id and refuses anything else', () => {
    expect(isStoryId('ACME-12')).toBe(true);
    expect(isStoryId('ACME-1; rm -rf /')).toBe(false);
    expect(isStoryId('')).toBe(false);
    expect(isStoryId('-ACME')).toBe(false);
  });

  it('names the story whose brief is being fetched', () => {
    expect(briefNote('ACME-2')).toBe('Starting ACME-2 next: fetching its brief from Jira');
  });
});

describe('failedTry', () => {
  it('counts a failed start, and says nothing before the limit', () => {
    const one = failedTry(null, REQ, WHY, T1);
    expect(one).toEqual({ track: { at: REQ.at, tries: 1, since: T1.toISOString(), logged: false }, log: null, wait: null });
    const two = failedTry(one.track, REQ, WHY, T2);
    expect(two.track).toEqual({ at: REQ.at, tries: 2, since: T1.toISOString(), logged: false });
    expect(two.log).toBeNull();
    expect(two.wait).toBeNull();
  });

  it('logs once and holds a wait when the limit is reached, and keeps the wait afterwards', () => {
    expect(NEXT_TRIES).toBe(3);
    let r = failedTry(null, REQ, WHY, T1);
    r = failedTry(r.track, REQ, WHY, T2);
    r = failedTry(r.track, REQ, WHY, T3);
    expect(r.log).toBe('You asked for ACME-2 next, but it could not start after 3 tries (could not fetch origin/main); it stays first in line.');
    expect(r.wait).toEqual({ id: 'ACME-2', at: REQ.at, since: T1.toISOString(), tries: 3, reason: WHY });
    const four = failedTry(r.track, REQ, 'its claim is held elsewhere', T3);
    expect(four.log).toBeNull();
    expect(four.wait).toMatchObject({ tries: 4, since: T1.toISOString(), reason: 'its claim is held elsewhere' });
    expect(four.track.tries).toBe(4);
  });

  it('starts counting again for a new request', () => {
    let r = failedTry(null, REQ, WHY, T1);
    r = failedTry(r.track, REQ, WHY, T2);
    const fresh = failedTry(r.track, { id: 'ACME-3', at: 'later' }, WHY, T3);
    expect(fresh.track).toEqual({ at: 'later', tries: 1, since: T3.toISOString(), logged: false });
    expect(fresh.wait).toBeNull();
  });

  it('takes the limit as an argument', () => {
    const r = failedTry(null, REQ, WHY, T1, 1);
    expect(r.log).toContain('after 1 tries');
    expect(r.wait).toMatchObject({ tries: 1 });
  });
});

describe('nextWaitWhy', () => {
  const wait = { id: 'ACME-2', at: REQ.at, since: T1.toISOString(), tries: 3, reason: WHY };

  it('says what is wrong and what the owner can do', () => {
    expect(nextWaitWhy(wait)).toBe(
      'It could not start after 3 tries: could not fetch origin/main. Foreman keeps trying it first, and no other story starts before it. Ask for another story next to replace the request.',
    );
  });

  it('is cut to 300 characters', () => {
    const why = nextWaitWhy({ ...wait, reason: 'x'.repeat(900) });
    expect(why.length).toBeLessThanOrEqual(300);
  });
});

describe('runningSlot', () => {
  const live = { id: 'ACME-3', by: 'factory', pid: 42, slot: 'w1', stale: false };
  const ours = (p) => p === 42;
  const slots = ['w1', 'w2'];

  it('gives the slot of a session running the story', () => {
    expect(runningSlot({ id: 'ACME-3', sessions: [{ slot: 'w2', id: 'ACME-3' }] })).toBe('w2');
  });

  it("gives the slot of this factory's live claim for the story", () => {
    expect(runningSlot({ id: 'ACME-3', claims: [live], ours, slots })).toBe('w1');
  });

  it.each([
    ['an owner claim', { claims: [{ id: 'ACME-3', by: 'owner', pid: null, slot: null, stale: false }] }],
    ['a stale factory claim', { claims: [{ ...live, stale: true }] }],
    ['a live claim under a pid that is not ours', { claims: [{ ...live, pid: 7 }] }],
    ['a claim for a slot this config does not have', { claims: [{ ...live, slot: 'w9' }] }],
    ['a session and a claim for another id', { sessions: [{ slot: 'w2', id: 'ACME-4' }], claims: [{ ...live, id: 'ACME-4' }] }],
    ['no sessions and no claims', {}],
  ])('gives null for %s', (_, given) => {
    expect(runningSlot({ id: 'ACME-3', ours, slots, ...given })).toBeNull();
  });
});

describe('requestVerdict', () => {
  const story = { id: 'ACME-2' };
  const wait = { id: 'ACME-2', on: [], text: 'ACME-2 waits for ACME-1: src/a.mjs' };

  it('refuses a request with no story, a taken story or an exclusive-blocked story, even when it also waits', () => {
    expect(requestVerdict({ story: null, taken: false, exclusiveBlocked: false, wait })).toEqual({ verdict: 'refuse' });
    expect(requestVerdict({ story, taken: true, exclusiveBlocked: false, wait })).toEqual({ verdict: 'refuse' });
    expect(requestVerdict({ story, taken: false, exclusiveBlocked: true, wait })).toEqual({ verdict: 'refuse' });
  });

  it('settles a request whose story runs in a slot as running, before it can be refused', () => {
    const running = { verdict: 'running', slot: 'w2' };
    expect(requestVerdict({ story, taken: false, exclusiveBlocked: false, wait: null, running: 'w2' })).toEqual(running);
    expect(requestVerdict({ story: null, taken: false, exclusiveBlocked: false, wait: null, running: 'w2' })).toEqual(running);
    expect(requestVerdict({ story, taken: true, exclusiveBlocked: false, wait, running: 'w2' })).toEqual(running);
    expect(requestVerdict({ story, taken: false, exclusiveBlocked: true, wait, running: 'w2' })).toEqual(running);
  });

  it('keeps a request open, with the wait as the reason, when only a wait stops it', () => {
    expect(requestVerdict({ story, taken: false, exclusiveBlocked: false, wait })).toEqual({ verdict: 'wait', reason: wait.text });
  });

  it('takes the story otherwise', () => {
    expect(requestVerdict({ story, taken: false, exclusiveBlocked: false, wait: null })).toEqual({ verdict: 'take' });
  });
});
