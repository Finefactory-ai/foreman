import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { confirmedResult } from './parks.mjs';
import { ACTIONS, actionsFor, afterFixCheck, afterOutcome, apiHeldText, BACKOFF_MS, backoffMs, backoffShown, canPick, canResume, dropSteps, ENV_BACKOFF_STEPS, envWhy, failCauseOf, hung, LET_GO_PATCH, looseClaims, looseClaimText, lastProgressText, MAX_SIGNIN_RESUMES, newestStep, outcome, OWNER_CLAIM_POLL_SECONDS, ownerClaimFate, ownerClaimText, pendingCommands, releaseAfterWait, releaseHeld, resumeCheck, resumeHeld, settledOwnerClaims, signinRun, slotIdsFor, slotStoryId, spentResult, STANDBY, whenNothingLeft, workStop, workStopText } from './scheduler.mjs';
import { readSlot, setSlot } from './state.mjs';
import { storiesInSlots } from '../../packs/salesforce/scratch-orgs.mjs';

const base = { halted: false, stopping: false, paused: false, backoffUntil: 0, now: 1000, slotIndex: 0, workers: 3, max: 0, started: 0, slotState: 'idle' };

describe('canPick', () => {
  it('picks when nothing stands in the way', () => expect(canPick(base)).toBe(true));
  it.each([
    ['halted', { halted: true }],
    ['stopping', { stopping: true }],
    ['paused', { paused: true }],
    ['backing off', { backoffUntil: 2000 }],
    ['in an environment wait', { envUntil: 2000 }],
    ['above the worker count', { slotIndex: 2, workers: 2 }],
    ['busy', { slotState: 'building' }],
    ['parked', { slotState: 'parked' }],
    ['at the story limit', { max: 5, started: 5 }],
    ['at the worker count, counting every slot', { running: 3 }],
    ['over the worker count after it was lowered', { running: 4, workers: 3 }],
    ['with 5 running after workers went from 5 to 3', { running: 5, workers: 3, slotIndex: 0 }],
  ])('does not pick when %s', (_, patch) => expect(canPick({ ...base, ...patch })).toBe(false));

  it('picks in a slot under the limit once fewer than the limit run, whichever slots they are in', () => {
    // Slots w1 to w5, workers 3; w1 is idle and asks to pick.
    const slots = ['w1', 'w2', 'w3', 'w4', 'w5'];
    const running = (...busy) => slots.filter((s) => busy.includes(s)).length;
    const w1 = { ...base, workers: 3, slotIndex: 0 };
    expect(canPick({ ...w1, running: running('w2', 'w3', 'w4') })).toBe(false);
    expect(canPick({ ...w1, running: running('w4', 'w5') })).toBe(true);
    expect(canPick({ ...w1, running: running('w2') })).toBe(true);
    // An idle w4 is above the limit: it never picks, however few run.
    expect(canPick({ ...w1, slotIndex: 3, running: running('w2') })).toBe(false);
  });

  it('picks once an environment wait is over', () => expect(canPick({ ...base, envUntil: 500 })).toBe(true));

  it('still picks when the running count is left out, as the old callers do', () => {
    expect('running' in base).toBe(false);
    expect(canPick(base)).toBe(true);
  });
});

describe('canResume', () => {
  it('resumes when nothing stands in the way', () => expect(canResume(base)).toBe(true));

  it.each([3, 5])('resumes queued work while the run drains, with %i running and workers 3', (running) => {
    const args = { ...base, workers: 3, slotIndex: 0, running };
    expect(canPick(args)).toBe(false);
    expect(canResume(args)).toBe(true);
  });

  it.each([
    ['a stop', { stopping: true }],
    ['the story limit', { max: 5, started: 5 }],
  ])('ignores %s', (_, patch) => expect(canResume({ ...base, ...patch })).toBe(true));

  it.each([
    ['halted', { halted: true }],
    ['paused', { paused: true }],
    ['backing off', { backoffUntil: 2000 }],
    ['in an environment wait', { envUntil: 2000 }],
    ['above the worker count, even with nothing running', { slotIndex: 2, workers: 2, running: 0 }],
    ['busy', { slotState: 'building' }],
    ['parked', { slotState: 'parked' }],
  ])('does not resume when %s', (_, patch) => expect(canResume({ ...base, ...patch })).toBe(false));
});

describe('hung', () => {
  const t = (min) => min * 60_000;
  it('is fine while active', () => expect(hung({ startedAt: 0, committedAt: null, lastActivity: t(50) }, t(60))).toBe(null));
  it('is quiet after 30 minutes with no activity', () => expect(hung({ startedAt: 0, committedAt: null, lastActivity: t(10) }, t(41))).toBe('quiet'));
  it('is too long after 2 hours of building', () => expect(hung({ startedAt: 0, committedAt: null, lastActivity: t(120) }, t(121))).toBe('too-long'));
  it('does not count the release against the 2 hours', () => expect(hung({ startedAt: 0, committedAt: t(100), lastActivity: t(150) }, t(160))).toBe(null));
  it('takes custom limits', () => {
    const limits = { quietMs: t(5), buildMs: t(20) };
    expect(hung({ startedAt: 0, committedAt: null, lastActivity: t(10) }, t(14), limits)).toBe(null);
    expect(hung({ startedAt: 0, committedAt: null, lastActivity: t(10) }, t(16), limits)).toBe('quiet');
    expect(hung({ startedAt: 0, committedAt: null, lastActivity: t(20) }, t(21), limits)).toBe('too-long');
    expect(hung({ startedAt: 0, committedAt: t(15), lastActivity: t(20) }, t(24), limits)).toBe(null);
  });

  describe('the build limit measures progress', () => {
    const limits = { quietMs: t(30), buildMs: t(120) };
    it('never stops a session whose agents finish every 20 minutes, up to 470 minutes', () => {
      for (let m = 0; m <= 470; m++) {
        const progressAt = t(Math.floor(m / 20) * 20);
        expect(hung({ startedAt: 0, committedAt: null, lastActivity: t(m), progressAt }, t(m), limits), `minute ${m}`).toBe(null);
      }
      for (const m of [121, 240, 470]) expect(hung({ startedAt: 0, committedAt: null, lastActivity: t(m), progressAt: t(Math.floor(m / 20) * 20) }, t(m), limits)).toBe(null);
    });
    it('stops a session with no progress for the build limit, as before', () => {
      expect(hung({ startedAt: 0, committedAt: null, lastActivity: t(130), progressAt: t(10) }, t(131), limits)).toBe('too-long');
      expect(hung({ startedAt: 0, committedAt: null, lastActivity: t(120) }, t(121), limits)).toBe('too-long');
    });
    it('counts from the start when the progress is older than the start', () => {
      expect(hung({ startedAt: t(100), committedAt: null, lastActivity: t(220), progressAt: t(10) }, t(221), limits)).toBe('too-long');
      expect(hung({ startedAt: t(100), committedAt: null, lastActivity: t(200), progressAt: t(10) }, t(219), limits)).toBe(null);
    });
    it('never stops a session whose agent takes a step every 5 minutes, up to the ceiling', () => {
      for (let m = 0; m <= 479; m++) {
        const s = { startedAt: 0, committedAt: null, lastActivity: t(m), progressAt: t(0), stepAt: t(Math.floor(m / 5) * 5) };
        expect(hung(s, t(m), limits), `minute ${m}`).toBe(null);
      }
      expect(hung({ startedAt: 0, committedAt: null, lastActivity: t(481), progressAt: t(0), stepAt: t(480) }, t(481), limits)).toBe('ceiling');
    });
    it('stops a session with no step, no stage change and no agent change for the build limit', () => {
      expect(hung({ startedAt: 0, committedAt: null, lastActivity: t(125), progressAt: t(0), stepAt: null }, t(121), limits)).toBe('too-long');
      expect(hung({ startedAt: 0, committedAt: null, lastActivity: t(125), progressAt: t(0), stepAt: t(0) }, t(121), limits)).toBe('too-long');
    });
    it('counts the newest of stage progress and steps', () => {
      expect(hung({ startedAt: 0, committedAt: null, lastActivity: t(310), progressAt: t(200), stepAt: t(10) }, t(310), limits)).toBe(null);
      expect(hung({ startedAt: 0, committedAt: null, lastActivity: t(320), progressAt: t(10), stepAt: t(200) }, t(321), limits)).toBe('too-long');
      expect(hung({ startedAt: 0, committedAt: null, lastActivity: t(320), progressAt: t(10), stepAt: t(200) }, t(319), limits)).toBe(null);
    });
    it('ignores a step older than the session start', () => {
      expect(hung({ startedAt: t(100), committedAt: null, lastActivity: t(220), progressAt: null, stepAt: t(50) }, t(221), limits)).toBe('too-long');
    });
    it('stops at the hard ceiling, 4 times the build limit, even with progress', () => {
      expect(hung({ startedAt: 0, committedAt: null, lastActivity: t(479), progressAt: t(475) }, t(479), limits)).toBe(null);
      expect(hung({ startedAt: 0, committedAt: null, lastActivity: t(479), progressAt: t(475) }, t(481), limits)).toBe('ceiling');
      expect(hung({ startedAt: 0, committedAt: null, lastActivity: t(199), progressAt: t(195) }, t(201), { ...limits, ceilingMs: t(200) })).toBe('ceiling');
      expect(hung({ startedAt: 0, committedAt: null, lastActivity: t(199), progressAt: t(195) }, t(199), { ...limits, ceilingMs: t(200) })).toBe(null);
    });
    it('has no ceiling and no build limit once committed', () => {
      expect(hung({ startedAt: 0, committedAt: t(100), lastActivity: t(600), progressAt: t(100) }, t(601), limits)).toBe(null);
    });
    it('says too-long or quiet before the ceiling', () => {
      expect(hung({ startedAt: 0, committedAt: null, lastActivity: t(600), progressAt: t(300) }, t(601), limits)).toBe('too-long');
      expect(hung({ startedAt: 0, committedAt: null, lastActivity: t(455), progressAt: t(455) }, t(490), limits)).toBe('quiet');
    });
    it('gives a session in the release stage the release grace on the ceiling too', () => {
      const s = { startedAt: 0, committedAt: null, lastActivity: t(489), progressAt: t(485), stage: 'release' };
      expect(hung(s, t(490), limits)).toBe(null);
      expect(hung(s, t(496), limits)).toBe('ceiling');
      expect(hung({ ...s, stage: 'build' }, t(490), limits)).toBe('ceiling');
    });
    it('measures the release grace from the last progress', () => {
      const s = { startedAt: 0, committedAt: null, lastActivity: t(310), progressAt: t(200), stage: 'release' };
      expect(hung(s, t(330), limits)).toBe(null);
      expect(hung({ ...s, lastActivity: t(330) }, t(336), limits)).toBe('too-long');
    });
    it('never stops an active ended session, even past the ceiling: the build limit and the ceiling never apply', () =>
      expect(hung({ startedAt: 0, committedAt: null, lastActivity: t(899), progressAt: t(0), ended: true }, t(900), limits)).toBe(null));
    it('ends an ended session quiet past the quiet limit, without a resume', () => {
      const s = { startedAt: 0, committedAt: null, lastActivity: t(0), progressAt: t(0), ended: true };
      expect(hung(s, t(31), limits)).toBe('ended-quiet');
      expect(hung(s, t(29), limits)).toBe(null);
    });
  });

  it('never stops a session whose story end has run while it is active, and ends it once quiet', () => {
    const s = { startedAt: 0, committedAt: null, lastActivity: t(0) };
    expect(hung({ ...s, ended: true, lastActivity: t(495) }, t(500))).toBe(null);
    expect(hung({ ...s, ended: true }, t(500))).toBe('ended-quiet');
    expect(hung(s, t(500))).toBe('too-long');
  });
  it('gives a session in the release stage 15 minutes past the build limit', () => {
    const s = { startedAt: 0, committedAt: null, lastActivity: t(120), stage: 'release' };
    expect(hung(s, t(121))).toBe(null);
    expect(hung({ ...s, lastActivity: t(130) }, t(120 + 15 + 1))).toBe('too-long');
    expect(hung({ ...s, stage: 'build' }, t(121))).toBe('too-long');
  });
  it('takes a custom release grace', () => {
    const limits = { buildMs: t(20), releaseGraceMs: t(5) };
    const s = { startedAt: 0, committedAt: null, lastActivity: t(20), stage: 'release' };
    expect(hung(s, t(24), limits)).toBe(null);
    expect(hung(s, t(26), limits)).toBe('too-long');
  });
  it('still calls a quiet release-stage session quiet: the grace covers only the build limit', () =>
    expect(hung({ startedAt: 0, committedAt: null, lastActivity: t(10), stage: 'release' }, t(41))).toBe('quiet'));
});

describe('newestStep', () => {
  const iso = (ms) => new Date(ms).toISOString();
  it('gives null for no agents', () => expect(newestStep([])).toBe(null));
  it('gives the newest step and who took it', () => {
    const t1 = Date.UTC(2026, 9, 29, 10, 0);
    const t2 = t1 + 60_000;
    expect(newestStep([{ role: 'foreman:builder', lastAt: iso(t1) }, { role: 'foreman', lastAt: iso(t2) }])).toEqual({ at: t2, by: 'foreman' });
    expect(newestStep([{ role: 'foreman', lastAt: iso(t2) }, { role: 'foreman:builder', lastAt: iso(t1) }])).toEqual({ at: t2, by: 'foreman' });
  });
  it('skips a record with a bad lastAt and one that is not an object', () => {
    const t1 = Date.UTC(2026, 9, 29, 10, 0);
    expect(newestStep([{ role: 'a', lastAt: 'bad' }, null, { role: 'b', lastAt: iso(t1) }])).toEqual({ at: t1, by: 'b' });
    expect(newestStep([{ role: 'a', lastAt: 'bad' }, null, 'x', { role: 'c' }])).toBe(null);
  });
});

describe('lastProgressText', () => {
  const min = (n) => n * 60_000;
  const now = min(1000);
  it('names the last step and who took it', () => {
    const step = { at: now - min(182), by: 'foreman:builder' };
    expect(lastProgressText({ startedAt: 0, progressAt: min(10), step }, now)).toBe('last step 3 h 02 min ago by foreman:builder');
  });
  it('calls the main session by that name', () => {
    expect(lastProgressText({ startedAt: 0, step: { at: now - min(5), by: 'foreman' } }, now)).toBe('last step 5 min ago by the main session');
  });
  it('says seconds under a minute', () => {
    expect(lastProgressText({ startedAt: 0, step: { at: now - 12_000, by: 'foreman:builder' } }, now)).toBe('last step 12 s ago by foreman:builder');
  });
  it('names the stage progress when it is newer than the step', () => {
    const step = { at: now - min(300), by: 'foreman:builder' };
    expect(lastProgressText({ startedAt: 0, progressAt: now - min(125), step }, now)).toBe('last stage change or agent start or finish 2 h 05 min ago');
  });
  it('says nothing happened since the start', () => {
    expect(lastProgressText({ startedAt: now - 12_000 }, now)).toBe('nothing since the session started 12 s ago');
    expect(lastProgressText({ startedAt: now - 12_000, progressAt: now - 12_000 }, now)).toBe('nothing since the session started 12 s ago');
    expect(lastProgressText({ startedAt: now - 12_000, progressAt: now - 20_000 }, now)).toBe('nothing since the session started 12 s ago');
  });
  it('does not use a step older than the start', () => {
    expect(lastProgressText({ startedAt: now - 12_000, step: { at: now - 60_000, by: 'foreman:builder' } }, now)).toBe('nothing since the session started 12 s ago');
  });
});

describe('resumeCheck', () => {
  it.each(['done', 'retired', 'ready-to-promote'])('closes a %s story, merged or not', (status) => {
    expect(resumeCheck({ status, merged: false })).toBe('close');
    expect(resumeCheck({ status, merged: true })).toBe('close');
  });
  it('marks a story done when only its pull request merged', () => expect(resumeCheck({ status: 'in-progress', merged: true })).toBe('mark-done'));
  it('starts a session otherwise', () => {
    expect(resumeCheck({ status: 'in-progress', merged: false })).toBe('start');
    expect(resumeCheck({ status: null })).toBe('start');
  });
});

describe('outcome', () => {
  it('moves on after shipping', () =>
    expect(outcome({ result: 'shipped' })).toMatchObject({ slot: 'idle', miss: false, claim: 'release', token: 'release', notify: null }));
  it('frees the slot for a release that finishes later, with nothing to tell', () =>
    expect(outcome({ result: 'ready-to-promote' })).toMatchObject({ slot: 'idle', miss: false, claim: 'release', token: 'release', notify: null }));
  it('does not count a story that only waits on other stories', () => {
    expect(outcome({ result: 'blocked', waitsOnStories: true })).toMatchObject({ slot: 'idle', miss: false, notify: null, claim: 'release', token: 'release' });
  });
  it('does not count a story blocked on the owner, but still emails', () => {
    expect(outcome({ result: 'blocked' })).toMatchObject({ miss: false, notify: 'blocked', slot: 'idle', claim: 'release' });
  });
  it('counts a failed story as a miss and emails', () => {
    expect(outcome({ result: 'failed' })).toMatchObject({ miss: true, env: false, notify: 'failed' });
    expect(outcome({ result: 'failed', failCause: 'story' })).toMatchObject({ miss: true, env: false, notify: 'failed' });
  });
  it('counts a failed story the environment caused as an environment ending, with the email', () => {
    expect(outcome({ result: 'failed', failCause: 'environment' })).toMatchObject({ reason: 'failed', miss: false, env: true, notify: 'failed', slot: 'idle', claim: 'release' });
  });
  it('a plain crash is an environment ending, parked only on the second crash', () => {
    expect(outcome({ result: null })).toMatchObject({ reason: 'crash', slot: 'resume', miss: false, env: true, notify: 'noresult' });
    expect(outcome({ result: null, crashesOfStory: 1 })).toMatchObject({ slot: 'parked', miss: false, env: true, notify: 'parked' });
  });
  it('defers without a miss and remembers the story needs the token', () =>
    expect(outcome({ result: 'deferred' })).toMatchObject({ slot: 'idle', miss: false, claim: 'release', token: 'release', schemaStory: true }));
  it('defers a story waiting on files without counting it as needing the token', () =>
    expect(outcome({ result: 'deferred', waitsOnFiles: true })).toMatchObject({ reason: 'deferred', slot: 'idle', miss: false, claim: 'release', token: 'release', schemaStory: false }));
  it('holds a committed story during a halt', () => {
    expect(outcome({ result: 'held' })).toMatchObject({ slot: 'held', claim: 'keep', token: 'keep', miss: false });
    expect(outcome({ result: 'halted' })).toMatchObject({ slot: 'held', claim: 'keep', token: 'keep' });
  });
  it('resumes after a first crash and parks after a second', () => {
    expect(outcome({ result: null, cause: null, crashesOfStory: 0 })).toMatchObject({ slot: 'resume', miss: false, env: true, notify: 'noresult' });
    expect(outcome({ result: null, cause: null, crashesOfStory: 1 })).toMatchObject({ slot: 'parked', reason: 'crash', notify: 'parked', claim: 'keep' });
  });
  it('parks a story stopped at the hard ceiling for the owner, with no miss', () => {
    expect(outcome({ result: null, ceiling: true })).toMatchObject({ reason: 'ceiling', slot: 'parked', miss: false, claim: 'keep', token: 'keep', notify: 'parked' });
    expect(outcome({ result: null, ceiling: true, crashesOfStory: 1 })).toMatchObject({ reason: 'ceiling', slot: 'parked', miss: false });
    expect(outcome({ result: null })).toMatchObject({ reason: 'crash', slot: 'resume', miss: false, env: true, notify: 'noresult' });
    expect(outcome({ result: null, crashesOfStory: 1 })).toMatchObject({ reason: 'crash', slot: 'parked', miss: false, env: true, notify: 'parked' });
    expect(outcome({ result: 'shipped', ceiling: true })).toMatchObject({ reason: 'shipped', slot: 'idle' });
    expect(outcome({ result: null, cause: 'rate-limit', ceiling: true })).toMatchObject({ reason: 'rate-limit', global: 'backoff' });
  });
  it('treats an API limit as nobody\'s fault', () => {
    expect(outcome({ result: null, cause: 'rate-limit', committed: false })).toMatchObject({ slot: 'resume', miss: false, global: 'backoff' });
    expect(outcome({ result: null, cause: 'outage', committed: true })).toMatchObject({ slot: 'held', global: 'backoff' });
    expect(outcome({ result: null, cause: 'credit' })).toMatchObject({ global: 'pause-credit', miss: false });
  });
  it('switches to the subscription when the Console key is out of credit and a subscription is there', () => {
    expect(outcome({ result: null, cause: 'api-credit', switchable: true, committed: true })).toMatchObject({ slot: 'resume', miss: false, claim: 'keep', token: 'keep', global: 'switch', reason: 'api-credit' });
    expect(outcome({ result: null, cause: 'api-credit', switchable: true })).toMatchObject({ slot: 'resume', global: 'switch' });
  });
  it('pauses on an empty Console key, as on credit, when it cannot switch', () => {
    expect(outcome({ result: null, cause: 'api-credit' })).toMatchObject({ slot: 'resume', miss: false, claim: 'keep', global: 'pause-credit', reason: 'api-credit' });
    expect(outcome({ result: null, cause: 'api-credit', committed: true })).toMatchObject({ slot: 'held', global: 'pause-credit' });
  });
  it('still backs off on a rate limit, whatever switchable says', () => {
    expect(outcome({ result: null, cause: 'rate-limit', switchable: true })).toMatchObject({ slot: 'resume', global: 'backoff' });
  });
  it('resumes a story whose Claude sign-in failed, keeping its claim, with no miss, park or email', () => {
    const signin = { slot: 'resume', miss: false, env: false, claim: 'keep', token: 'keep', global: 'signin', notify: null, reason: 'signin', schemaStory: false };
    expect(outcome({ result: null, cause: 'signin' })).toEqual(signin);
    expect(outcome({ result: null, cause: 'signin', committed: true })).toEqual(signin);
    expect(outcome({ result: null, cause: 'signin', crashesOfStory: 1 })).toEqual(signin);
    expect(outcome({ result: null, cause: 'signin', ceiling: true })).toEqual(signin);
  });
  it('closes a session spent after its story ended through the resume check: no miss, no park, no email', () => {
    const spent = { reason: 'spent', slot: 'resume', miss: false, notify: null, claim: 'keep', token: 'keep' };
    expect(outcome({ result: null, spent: true })).toMatchObject(spent);
    expect(outcome({ result: null, spent: true, crashesOfStory: 1 })).toMatchObject(spent);
    expect(outcome({ result: null, crashesOfStory: 1 })).toMatchObject({ reason: 'crash', slot: 'parked', miss: false, env: true, notify: 'parked' });
    expect(outcome({ result: null })).toMatchObject({ reason: 'crash', slot: 'resume', miss: false, env: true, notify: 'noresult' });
    expect(outcome({ result: 'shipped', spent: true })).toMatchObject({ reason: 'shipped', slot: 'idle', claim: 'release' });
  });
});

describe('signinRun', () => {
  it('allows three resumes in a row', () => expect(MAX_SIGNIN_RESUMES).toBe(3));
  it('counts a sign-in death on from the earlier ones and keeps the cause up to the cap', () => {
    expect(signinRun({ cause: 'signin', before: 0 })).toEqual({ cause: 'signin', streak: 1, gaveUp: false });
    expect(signinRun({ cause: 'signin', before: 2 })).toEqual({ cause: 'signin', streak: 3, gaveUp: false });
  });
  it('gives up past the cap: a plain crash', () => {
    expect(signinRun({ cause: 'signin', before: 3 })).toEqual({ cause: null, streak: 4, gaveUp: true });
    expect(signinRun({ cause: 'signin', before: 7 })).toMatchObject({ cause: null, gaveUp: true });
  });
  it('counts anything that is not a positive integer as 0', () => {
    for (const before of [undefined, -1, 'x', 1.5, NaN, null]) expect(signinRun({ cause: 'signin', before }), String(before)).toEqual({ cause: 'signin', streak: 1, gaveUp: false });
    expect(signinRun({ cause: 'signin' })).toEqual({ cause: 'signin', streak: 1, gaveUp: false });
  });
  it('resets the streak on any other cause', () => {
    expect(signinRun({ cause: 'rate-limit', before: 2 })).toEqual({ cause: 'rate-limit', streak: 0, gaveUp: false });
    expect(signinRun({ cause: null, before: 3 })).toEqual({ cause: null, streak: 0, gaveUp: false });
  });
  it('makes the giving-up death an environment crash, and a park when the story crashed before', () => {
    const cause = signinRun({ cause: 'signin', before: 3 }).cause;
    expect(outcome({ result: null, cause })).toMatchObject({ reason: 'crash', slot: 'resume', miss: false, env: true, notify: 'noresult' });
    expect(outcome({ result: null, cause, crashesOfStory: 1 })).toMatchObject({ reason: 'crash', slot: 'parked', miss: false, env: true, notify: 'parked' });
    const o = outcome({ result: null, cause });
    expect(afterOutcome({}, o, 0, 'ACME-1').counters).toMatchObject({ misses: 0, missed: [], envEndings: 1 });
  });
});

describe('spentResult', () => {
  const run = { result: null, story: null, cause: null, resetAt: null };
  const slotResult = { id: 'ACME-1', result: 'shipped', pr: 'https://example.com/acme/pull/1' };
  it("takes the session's own `story end` result when the watchdog ended it after its story ended", () =>
    expect(spentResult(run, { spent: true, slotResult, id: 'ACME-1' })).toEqual({ ...run, result: 'shipped' }));
  it.each([
    ['it was not spent', run, { spent: false, slotResult, id: 'ACME-1' }],
    ['the run already has a result', { ...run, result: 'blocked' }, { spent: true, slotResult, id: 'ACME-1' }],
    ['the slot result is for another story', run, { spent: true, slotResult: { ...slotResult, id: 'ACME-2' }, id: 'ACME-1' }],
    ['the slot result is not a known result', run, { spent: true, slotResult: { ...slotResult, result: 'bogus' }, id: 'ACME-1' }],
    ['there is no slot result', run, { spent: true, slotResult: null, id: 'ACME-1' }],
  ])('leaves the run as it is when %s', (_, given, opts) => expect(spentResult(given, opts)).toBe(given));
});

describe('afterOutcome', () => {
  const c0 = { misses: 0, backoffs: 0, backoffUntil: 0 };
  it('a backoff waits the 15 minutes by default, in the same words', () => {
    const r = afterOutcome(c0, { miss: false, global: 'backoff' }, 100);
    expect(r.counters.backoffUntil).toBe(100 + BACKOFF_MS);
    expect(r.reason).toBe('The Claude API is limited or down; waiting 15 minutes.');
  });
  it('a backoff option shortens the wait and says it in seconds', () => {
    const r = afterOutcome(c0, { miss: false, global: 'backoff' }, 0, null, { backoffMs: 3000 });
    expect(r.counters.backoffUntil).toBe(3000);
    expect(r.reason).toBe('The Claude API is limited or down; waiting 3 seconds.');
  });
  // Each ending comes after the previous wait is over.
  const ladder = (opts, count) => {
    const out = [];
    let c = c0;
    let now = 0;
    for (let i = 0; i < count; i++) {
      const r = afterOutcome(c, { miss: false, global: 'backoff' }, now, null, opts);
      out.push({ ...r, waited: r.counters.backoffUntil - now });
      c = r.counters;
      now = c.backoffUntil;
    }
    return out;
  };
  it('the waits grow 15, 30, 60 and 120 minutes, stay at 120, and never pause', () => {
    const rs = ladder({}, 6);
    expect(rs.map((r) => r.waited / 60_000)).toEqual([15, 30, 60, 120, 120, 120]);
    expect(rs.map((r) => r.global)).toEqual(Array(6).fill('backoff'));
    expect(rs.map((r) => r.counters.backoffs)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rs.slice(0, 4).map((r) => r.reason)).toEqual([
      'The Claude API is limited or down; waiting 15 minutes.',
      'The Claude API is limited or down; waiting 30 minutes.',
      'The Claude API is limited or down; waiting 1 hour.',
      'The Claude API is limited or down; waiting 2 hours.',
    ]);
    expect(rs[5].reason).toBe('The Claude API is limited or down; waiting 2 hours.');
  });
  it('a shortened wait grows the same way, in seconds', () => {
    const rs = ladder({ backoffMs: 3000 }, 5);
    expect(rs.map((r) => r.waited / 1000)).toEqual([3, 6, 12, 24, 24]);
    expect(rs[3].reason).toBe('The Claude API is limited or down; waiting 24 seconds.');
  });
  it('an ending inside a running wait joins it: nothing changes and nothing is said', () => {
    const first = afterOutcome(c0, { miss: false, global: 'backoff' }, 0);
    const joined = afterOutcome(first.counters, { miss: false, global: 'backoff' }, 1000);
    expect(joined).toEqual({ counters: first.counters, global: 'backoff', reason: '' });
    // exactly at the end it is a new step
    expect(afterOutcome(first.counters, { miss: false, global: 'backoff' }, first.counters.backoffUntil).counters.backoffs).toBe(2);
  });
  it.each([
    ['a ship', { miss: false, global: null, reason: 'shipped' }],
    ['a ready-to-promote', { miss: false, global: null, reason: 'ready-to-promote' }],
    ['a block', { miss: false, global: null, reason: 'blocked' }],
    ['a deferral', { miss: false, global: null, reason: 'deferred' }],
    ['an empty pick', { miss: false, global: null, reason: 'empty' }],
    ['a miss', { miss: true, global: null, reason: 'failed' }],
  ])('%s means the API answered: the ladder starts again and the running wait is kept', (_, o) => {
    const r = afterOutcome({ ...c0, backoffs: 4, backoffUntil: 777 }, o, 0, 'ACME-1');
    expect(r.counters).toMatchObject({ backoffs: 0, backoffUntil: 777 });
    expect(r.global).toBeNull();
  });
  it('the miss pause resets the ladder too', () => {
    const r = afterOutcome({ ...c0, misses: 2, backoffs: 3, backoffUntil: 5 }, { miss: true, global: null }, 0, 'ACME-1');
    expect(r).toMatchObject({ global: 'pause', counters: { backoffs: 0, backoffUntil: 5 } });
  });
  it('a switch, a sign-in failure and a credit pause leave the ladder as it is', () => {
    const c = { ...c0, backoffs: 2, backoffUntil: 9 };
    for (const global of ['switch', 'signin', 'pause-credit']) expect(afterOutcome(c, { global, reason: 'credit' }, 0).counters).toMatchObject({ backoffs: 2, backoffUntil: 9 });
  });
  it('pauses after three misses in a row', () => {
    let c = c0;
    for (let i = 0; i < 2; i++) c = afterOutcome(c, { miss: true, global: null }, 0).counters;
    expect(afterOutcome(c, { miss: true, global: null }, 0)).toMatchObject({ global: 'pause' });
  });
  it('a ship resets the misses', () => {
    const c = afterOutcome({ ...c0, misses: 2 }, { miss: false, global: null, slot: 'idle', reason: 'shipped' }, 0).counters;
    expect(c.misses).toBe(0);
  });
  it('a release that finishes later resets the misses, like a ship', () => {
    let c = c0;
    for (let i = 0; i < 2; i++) c = afterOutcome(c, { miss: true, global: null }, 0).counters;
    expect(c.misses).toBe(2);
    c = afterOutcome(c, outcome({ result: 'ready-to-promote' }), 0).counters;
    expect(c.misses).toBe(0);
  });
  it('a ready-to-promote claim with no park counts as a miss, so the auto-pause holds', () => {
    let c = c0;
    for (let i = 0; i < 2; i++) c = afterOutcome(c, { miss: true, global: null }, 0).counters;
    const r = afterOutcome(c, outcome({ result: confirmedResult('ready-to-promote', { park: null, status: 'in-progress' }) }), 0);
    expect(r).toMatchObject({ global: 'pause' });
  });
  it('a ready-to-promote claim with no park does not reset the misses', () => {
    const c = afterOutcome({ ...c0, misses: 1 }, outcome({ result: confirmedResult('ready-to-promote', { park: null, status: 'in-progress' }) }), 0).counters;
    expect(c.misses).toBe(2);
  });
  it('a deferral neither counts nor resets', () => {
    const c = afterOutcome({ ...c0, misses: 2 }, { miss: false, global: null, slot: 'idle', reason: 'deferred' }, 0).counters;
    expect(c.misses).toBe(2);
  });
  // Folds outcomes over story ids, keeping every step's answer.
  const fold = (steps, start = c0) => {
    let c = start;
    return steps.map(([o, id]) => {
      const r = afterOutcome(c, o, 0, id);
      c = r.counters;
      return r;
    });
  };
  const failed = () => outcome({ result: 'failed' });
  const blocked = () => outcome({ result: 'blocked' });
  it('three owner-blocked stories in a row do not pause', () => {
    const rs = fold([[blocked(), 'ACME-1'], [blocked(), 'ACME-2'], [blocked(), 'ACME-3'], [outcome({ result: 'blocked', waitsOnStories: true }), 'ACME-4']]);
    for (const r of rs) expect(r.global).toBeNull();
    expect(rs.at(-1).counters.misses).toBe(0);
  });
  it('three failures pause and name them', () => {
    const rs = fold([[failed(), 'ACME-1'], [failed(), 'ACME-2'], [failed(), 'ACME-3']]);
    expect(rs[0].global).toBeNull();
    expect(rs[1].global).toBeNull();
    expect(rs[2]).toMatchObject({ global: 'pause', reason: 'Three stories in a row did not ship: ACME-1, ACME-2 and ACME-3.' });
    expect(rs[2].counters).toMatchObject({ misses: 0, missed: [] });
  });
  it('one story missing three times in a row is named once', () => {
    const rs = fold([[failed(), 'ACME-1'], [failed(), 'ACME-1'], [failed(), 'ACME-1']]);
    expect(rs[2]).toMatchObject({ global: 'pause', reason: 'ACME-1 did not ship three times in a row.' });
    expect(rs[2].counters).toMatchObject({ misses: 0, missed: [] });
  });
  it('a story missing twice among three says how often', () => {
    const rs = fold([[failed(), 'ACME-1'], [failed(), 'ACME-2'], [failed(), 'ACME-1']]);
    expect(rs[2]).toMatchObject({ global: 'pause', reason: 'Three tries in a row did not ship: ACME-1 twice and ACME-2.' });
  });
  it('ids appear in first-seen order', () => {
    const rs = fold([[failed(), 'ACME-2'], [failed(), 'ACME-1'], [failed(), 'ACME-1']]);
    expect(rs[2]).toMatchObject({ global: 'pause', reason: 'Three tries in a row did not ship: ACME-2 and ACME-1 twice.' });
  });
  it('a mix counts only the failures', () => {
    const rs = fold([[failed(), 'ACME-1'], [blocked(), 'ACME-2'], [failed(), 'ACME-3'], [blocked(), 'ACME-4'], [failed(), 'ACME-5']]);
    expect(rs[2].global).toBeNull();
    expect(rs[2].counters.misses).toBe(2);
    expect(rs[3].global).toBeNull();
    expect(rs[3].counters.misses).toBe(2);
    expect(rs[4]).toMatchObject({ global: 'pause', reason: 'Three stories in a row did not ship: ACME-1, ACME-3 and ACME-5.' });
  });
  it('a crash is not a miss: it counts toward the environment row, not the pause', () => {
    const rs = fold([[failed(), 'ACME-1'], [failed(), 'ACME-2'], [outcome({ result: null, cause: null, crashesOfStory: 0 }), 'ACME-3']]);
    expect(rs[2]).toMatchObject({ global: null, counters: { misses: 2, missed: ['ACME-1', 'ACME-2'], envEndings: 1 } });
  });
  it('a ship clears the named stories', () => {
    const rs = fold([
      [failed(), 'ACME-1'], [failed(), 'ACME-2'], [outcome({ result: 'shipped' }), 'ACME-3'],
      [failed(), 'ACME-4'], [failed(), 'ACME-5'], [failed(), 'ACME-6'],
    ]);
    expect(rs[2].counters).toMatchObject({ misses: 0, missed: [] });
    expect(rs[5]).toMatchObject({ global: 'pause', reason: 'Three stories in a row did not ship: ACME-4, ACME-5 and ACME-6.' });
  });
  it('with no story ids the old text stands', () => {
    let c = c0;
    for (let i = 0; i < 2; i++) c = afterOutcome(c, { miss: true, global: null }, 0).counters;
    expect(afterOutcome(c, { miss: true, global: null }, 0)).toMatchObject({ global: 'pause', reason: 'Three stories in a row did not ship.' });
  });
  it('a switch to the subscription neither counts nor clears, and does not pause', () => {
    const o = outcome({ result: null, cause: 'api-credit', switchable: true, committed: true });
    const r = afterOutcome({ ...c0, misses: 2, missed: ['A', 'B'] }, o, 0, 'C');
    expect(r).toMatchObject({ counters: { ...c0, misses: 2, missed: ['A', 'B'], envEndings: 0 }, global: 'switch', reason: '' });
  });
  it('keeps requeued key sessions out of the three-miss pause', () => {
    // two sessions still on the key die after the switch: each is a switch again, never a miss
    const o = outcome({ result: null, cause: 'api-credit', switchable: true });
    let c = { ...c0, misses: 2, missed: ['A', 'B'] };
    for (const story of ['C', 'D']) {
      const r = afterOutcome(c, o, 0, story);
      expect(r).toMatchObject({ global: 'switch', counters: { misses: 2, missed: ['A', 'B'] } });
      c = r.counters;
    }
  });
  it('names the Console key when it pauses for it', () => {
    expect(afterOutcome(c0, outcome({ result: null, cause: 'api-credit' }), 0)).toMatchObject({ global: 'pause', reason: 'The Console API key is out of credit.' });
    expect(afterOutcome(c0, outcome({ result: null, cause: 'credit' }), 0)).toMatchObject({ global: 'pause', reason: 'The account is out of credit or hit its usage limit.' });
  });
  describe('a failed Claude sign-in', () => {
    const signin = () => outcome({ result: null, cause: 'signin' });
    it('neither counts nor clears the misses, and does not pause', () => {
      const c = { ...c0, misses: 2, missed: ['ACME-1', 'ACME-2'] };
      expect(afterOutcome(c, signin(), 0, 'ACME-3')).toMatchObject({ counters: c, global: 'signin', reason: '' });
    });
    it('three in a row from zero do not pause', () => {
      const rs = fold([[signin(), 'ACME-1'], [signin(), 'ACME-2'], [signin(), 'ACME-3']]);
      for (const r of rs) expect(r.global).toBe('signin');
      expect(rs.at(-1).counters).toMatchObject({ misses: 0, missed: [] });
    });
    it('between two real misses it neither clears them nor counts', () => {
      const rs = fold([[failed(), 'ACME-1'], [signin(), 'ACME-2'], [failed(), 'ACME-3']]);
      expect(rs.map((r) => r.counters.misses)).toEqual([1, 1, 2]);
      expect(rs[2].counters.missed).toEqual(['ACME-1', 'ACME-3']);
      expect(rs.every((r) => r.global !== 'pause')).toBe(true);
    });
    it('leaves a plain crash an environment ending: parked on the second, never a miss', () => {
      expect(outcome({ result: null, cause: null, crashesOfStory: 1 })).toMatchObject({ slot: 'parked', reason: 'crash', miss: false, env: true, notify: 'parked' });
      const crash = () => outcome({ result: null, cause: null, crashesOfStory: 0 });
      const rs = fold([[crash(), 'ACME-1'], [signin(), 'ACME-2'], [crash(), 'ACME-2'], [crash(), 'ACME-3']]);
      expect(rs[3]).toMatchObject({ global: 'env-backoff', counters: { misses: 0, missed: [], envWaits: 1 } });
    });
  });
  it('backs off 15 minutes first, and four in a row never pause', () => {
    let r = afterOutcome(c0, { miss: false, global: 'backoff' }, 0);
    expect(r).toMatchObject({ global: 'backoff', counters: { backoffs: 1, backoffUntil: 15 * 60_000 } });
    r = afterOutcome({ ...r.counters, backoffs: 3 }, { miss: false, global: 'backoff' }, 15 * 60_000);
    expect(r).toMatchObject({ global: 'backoff', counters: { backoffs: 4 } });
  });
});

describe('failCauseOf', () => {
  const slotResult = { id: 'ACME-1', result: 'failed', cause: 'environment' };
  it('is the environment only for a failed run, a matching failed record and cause environment', () =>
    expect(failCauseOf({ result: 'failed', slotResult, id: 'ACME-1' })).toBe('environment'));
  it.each([
    ['another story', { result: 'failed', slotResult, id: 'ACME-2' }],
    ['no record', { result: 'failed', slotResult: null, id: 'ACME-1' }],
    ['no cause', { result: 'failed', slotResult: { ...slotResult, cause: undefined }, id: 'ACME-1' }],
    ['cause story', { result: 'failed', slotResult: { ...slotResult, cause: 'story' }, id: 'ACME-1' }],
    ['a record that is not failed', { result: 'failed', slotResult: { ...slotResult, result: 'blocked' }, id: 'ACME-1' }],
    ['a run result that is not failed', { result: 'shipped', slotResult, id: 'ACME-1' }],
    ['no run result', { result: null, slotResult, id: 'ACME-1' }],
  ])('is the story for %s', (_, args) => expect(failCauseOf(args)).toBe('story'));
});

describe('envWhy', () => {
  it('says a failure in the note\'s words, without the trailing dots', () =>
    expect(envWhy({ reason: 'failed', note: 'CI never started on the pull request.' })).toBe('failed: CI never started on the pull request'));
  it('says failed on the environment with an empty note', () => {
    expect(envWhy({ reason: 'failed', note: '' })).toBe('failed on the environment');
    expect(envWhy({ reason: 'failed', note: '  ... ' })).toBe('failed on the environment');
    expect(envWhy({ reason: 'failed' })).toBe('failed on the environment');
  });
  it('says a watchdog stop and a crash', () => {
    expect(envWhy({ reason: 'crash', watchdog: true })).toBe('was stopped by the watchdog');
    expect(envWhy({ reason: 'crash' })).toBe('ended without a result');
  });
  it('cuts a long note to 100 characters', () => expect(envWhy({ reason: 'failed', note: 'x'.repeat(300) })).toBe(`failed: ${'x'.repeat(100)}`));
});

describe('afterOutcome: endings the environment caused', () => {
  const c0 = { misses: 0, backoffs: 0, backoffUntil: 0 };
  const MIN = 60_000;
  const env = () => outcome({ result: null });
  const story = () => outcome({ result: 'failed' });
  const fold = (steps, start = c0, now = 0, opts = {}) => {
    let c = start;
    return steps.map(([o, id, why]) => {
      const r = afterOutcome(c, o, now, id, { ...opts, why });
      c = r.counters;
      return r;
    });
  };
  it('the ladder is 1, 2 and 4 times the base wait', () => expect(ENV_BACKOFF_STEPS).toEqual([1, 2, 4]));
  it.each([
    ['a watchdog stop', outcome({ result: null }), 'was stopped by the watchdog'],
    ['a crash', outcome({ result: null, crashesOfStory: 1 }), 'ended without a result'],
    ['a CI that never started', outcome({ result: 'failed', failCause: 'environment' }), 'failed: CI never started on the pull request'],
    ['a check that could not load a file the story left alone', outcome({ result: 'failed', failCause: 'environment' }), 'failed: acme.test.mjs could not be loaded'],
    ['a conflict', outcome({ result: 'failed', failCause: 'environment' }), 'failed: conflict with main'],
  ])('%s never changes the misses', (_, o, why) => {
    const r = afterOutcome({ ...c0, misses: 1, missed: ['ACME-0'] }, o, 0, 'ACME-1', { why });
    expect(r).toMatchObject({ global: null, reason: '', counters: { misses: 1, missed: ['ACME-0'], envEndings: 1, envList: [`ACME-1 ${why}`] } });
  });
  const three = [[env(), 'ACME-1', 'was stopped by the watchdog'], [env(), 'ACME-2', 'ended without a result'], [env(), 'ACME-3', 'failed: CI never started on the pull request']];
  it('three in a row wait 15 minutes and name the environment', () => {
    const rs = fold(three);
    expect(rs.map((r) => r.global)).toEqual([null, null, 'env-backoff']);
    expect(rs[2].counters).toMatchObject({ envEndings: 0, envList: [], envWaits: 1, envUntil: 15 * MIN, backoffUntil: 0, misses: 0, missed: [] });
    expect(rs[2].reason).toBe('Three endings in a row were the environment, not the stories: ACME-1 was stopped by the watchdog; ACME-2 ended without a result; ACME-3 failed: CI never started on the pull request. Waiting 15 minutes before carrying on.');
  });
  it('the next triples wait 30 minutes and 1 hour, and the fourth pauses', () => {
    let c = c0;
    let now = 0;
    const out = [];
    for (let i = 0; i < 4; i++) {
      const rs = fold(three, c, now);
      out.push(rs[2]);
      c = rs[2].counters;
      now = c.envUntil;
    }
    expect(out.map((r) => r.global)).toEqual(['env-backoff', 'env-backoff', 'env-backoff', 'pause']);
    expect(out[1].reason).toContain('Waiting 30 minutes before carrying on.');
    expect(out[2].reason).toContain('Waiting 1 hour before carrying on.');
    expect(out[3].reason).toBe('Three endings in a row were the environment, not the stories, after waiting 15 minutes, 30 minutes and 1 hour: ACME-1 was stopped by the watchdog; ACME-2 ended without a result; ACME-3 failed: CI never started on the pull request.');
    expect(out[3].counters).toMatchObject({ envWaits: 0, envEndings: 0, envList: [] });
  });
  it('a shortened base wait gives 3, 6 and 12 seconds in the words', () => {
    let c = c0;
    let now = 0;
    const reasons = [];
    for (let i = 0; i < 3; i++) {
      const r = fold(three, c, now, { backoffMs: 3000 })[2];
      reasons.push(r.reason);
      c = r.counters;
      now = c.envUntil;
    }
    expect(reasons.map((t) => t.match(/Waiting (.*) before/)[1])).toEqual(['3 seconds', '6 seconds', '12 seconds']);
    expect(fold(three, c, now, { backoffMs: 3000 })[2].reason).toContain('after waiting 3 seconds, 6 seconds and 12 seconds');
  });
  it('an ending inside a running wait joins it and counts nothing', () => {
    const c = { ...c0, envEndings: 1, envList: ['ACME-1 ended without a result'], backoffUntil: 5000 };
    const r = afterOutcome(c, env(), 1000, 'ACME-2', { why: 'x' });
    expect(r).toMatchObject({ global: null, reason: '', counters: { envEndings: 1, envList: ['ACME-1 ended without a result'], backoffUntil: 5000 } });
  });
  it('an ending inside a running environment wait joins it and counts nothing', () => {
    const c = { ...c0, envEndings: 1, envList: ['ACME-1 ended without a result'], envUntil: 5000 };
    const r = afterOutcome(c, env(), 1000, 'ACME-2', { why: 'x' });
    expect(r).toMatchObject({ global: null, reason: '', counters: { envEndings: 1, envList: ['ACME-1 ended without a result'], envUntil: 5000 } });
  });
  it('an environment wait leaves backoffUntil alone, whatever step the API ladder is on', () => {
    const rs = fold(three, { ...c0, backoffs: 2, backoffUntil: 0 });
    expect(rs[2]).toMatchObject({ global: 'env-backoff', counters: { backoffs: 0, backoffUntil: 0, envUntil: 15 * MIN } });
  });
  it('an API backoff during an environment wait sets backoffUntil and keeps envUntil', () => {
    const r = afterOutcome({ ...c0, envUntil: 9e9 }, { miss: false, global: 'backoff' }, 0);
    expect(r).toMatchObject({ global: 'backoff', counters: { backoffUntil: 15 * MIN, envUntil: 9e9 } });
  });
  it('a story miss in between resets the row and keeps the waits', () => {
    const rs = fold([[env(), 'ACME-1', 'a'], [env(), 'ACME-2', 'b'], [story(), 'ACME-3'], [env(), 'ACME-4', 'c']], { ...c0, envWaits: 1 });
    expect(rs[2].counters).toMatchObject({ envEndings: 0, envList: [], envWaits: 1, misses: 1, missed: ['ACME-3'] });
    expect(rs[3].counters).toMatchObject({ envEndings: 1, envWaits: 1 });
    expect(rs.map((r) => r.global)).toEqual([null, null, null, null]);
  });
  it('a ship clears all three env counters', () => {
    const c = { ...c0, envEndings: 2, envList: ['a', 'b'], envWaits: 2 };
    for (const result of ['shipped', 'ready-to-promote']) {
      expect(afterOutcome(c, outcome({ result: result === 'shipped' ? 'shipped' : 'ready-to-promote' }), 0, 'ACME-1').counters).toMatchObject({ envEndings: 0, envList: [], envWaits: 0 });
    }
  });
  it('neutral endings touch no env counter', () => {
    const c = { ...c0, envEndings: 2, envList: ['a', 'b'], envWaits: 1 };
    for (const o of [outcome({ result: 'deferred' }), outcome({ result: 'empty' }), outcome({ result: 'blocked' }), outcome({ result: null, spent: true }), outcome({ result: null, ceiling: true }), outcome({ result: null, cause: 'signin' })]) {
      expect(afterOutcome(c, o, 0, 'ACME-1').counters).toMatchObject({ envEndings: 2, envList: ['a', 'b'], envWaits: 1 });
    }
  });
  it('two environment endings then a story miss do not pause, and story misses still pause at three', () => {
    const rs = fold([[env(), 'ACME-1', 'a'], [env(), 'ACME-2', 'b'], [story(), 'ACME-3'], [story(), 'ACME-4'], [story(), 'ACME-5']]);
    expect(rs.map((r) => r.global)).toEqual([null, null, null, null, 'pause']);
    expect(rs[4].reason).toBe('Three stories in a row did not ship: ACME-3, ACME-4 and ACME-5.');
  });
  it('a failure with no cause or cause story still pauses at three', () => {
    const rs = fold([[outcome({ result: 'failed' }), 'ACME-1'], [outcome({ result: 'failed', failCause: 'story' }), 'ACME-2'], [outcome({ result: 'failed' }), 'ACME-3']]);
    expect(rs[2]).toMatchObject({ global: 'pause', reason: 'Three stories in a row did not ship: ACME-1, ACME-2 and ACME-3.' });
  });
});

describe('actionsFor', () => {
  it('offers only what makes sense', () => {
    expect(actionsFor({ state: 'building' })).toEqual(['skip', 'takeover', 'park']);
    expect(actionsFor({ state: 'parked', parkedFor: 'dirty' })).toEqual(['resume-as-is', 'discard']);
    expect(actionsFor({ state: 'parked', parkedFor: 'crash' })).toEqual(['resume', 'restart', 'skip', 'takeover']);
    expect(actionsFor({ state: 'waiting' })).toEqual([]);
  });
  it('a held slot offers Resume and Take over, but only Take over while a halt holds it', () => {
    expect(actionsFor({ state: 'held' })).toEqual(['resume', 'takeover']);
    expect(actionsFor({ state: 'held', haltedBy: false })).toEqual(['resume', 'takeover']);
    expect(actionsFor({ state: 'held', haltedBy: true })).toEqual(['takeover']);
  });
});

describe('backoffMs', () => {
  it('is the 15-minute backoff unless the value is a positive integer', () => {
    for (const v of [undefined, '', 'abc', '0', '-5', '1.5', 3000]) expect(backoffMs(v)).toBe(BACKOFF_MS);
  });
  it('shortens it, to a second at the least, never lengthens it', () => {
    expect(backoffMs('3000')).toBe(3000);
    expect(backoffMs('10')).toBe(1000);
    expect(backoffMs('99999999')).toBe(BACKOFF_MS);
  });
});

describe('apiHeldText', () => {
  it('names the retry time when there is one', () => {
    expect(apiHeldText('14:05')).toBe('held until the API is back (retry at 14:05)');
    expect(apiHeldText(null)).toBe('held until the API is back');
    expect(apiHeldText('')).toBe('held until the API is back');
  });
});

describe('looseClaims', () => {
  // The incident: a claim under the live supervisor's own pid.
  const claim = { id: 'ACME-1', slot: 'w1', by: 'factory', pid: 42, stale: false };
  const slot = (patch) => ({ id: 'w1', state: 'idle', parkedFor: null, story: null, ...patch });
  const loose = (w1, extra = {}) => looseClaims({ claims: [claim], slots: { w1: slot(w1) }, ...extra });

  it('lets go of a claim whose slot is idle', () => expect(loose({})).toEqual([{ id: 'ACME-1', slot: 'w1', why: 'idle' }]));
  it('keeps the claim while the slot is parked for crashes on that story', () => expect(loose({ state: 'parked', parkedFor: 'crash', parkedStory: 'ACME-1' })).toEqual([]));
  it('keeps the claim of a crash park written before parkedStory', () => expect(loose({ state: 'parked', parkedFor: 'crash' })).toEqual([]));
  it('lets go of a claim whose slot is parked for crashes on another story', () =>
    expect(loose({ state: 'parked', parkedFor: 'crash', parkedStory: 'ACME-2' })).toEqual([{ id: 'ACME-1', slot: 'w1', why: 'parked' }]));
  it.each(['owner', 'dirty'])('lets go of a claim whose slot is parked by %s', (parkedFor) =>
    expect(loose({ state: 'parked', parkedFor })).toEqual([{ id: 'ACME-1', slot: 'w1', why: 'parked' }]));
  it.each(['building', 'waiting'])('lets go of a claim whose slot is %s another story', (state) =>
    expect(loose({ state, story: { id: 'ACME-2' } })).toEqual([{ id: 'ACME-1', slot: 'w1', why: 'building', other: 'ACME-2' }]));
  it('keeps the claim of the story its slot is building', () => {
    expect(loose({ state: 'building', story: { id: 'ACME-1' } })).toEqual([]);
    expect(loose({ state: 'building', story: null })).toEqual([]);
  });
  it('keeps the claims of held and down slots', () => {
    expect(loose({ state: 'held', heldStory: 'ACME-1' })).toEqual([]);
    expect(loose({ state: 'down' })).toEqual([]);
  });
  it('keeps the claim of a story queued or running', () => expect(loose({}, { inHand: new Set(['ACME-1']) })).toEqual([]));
  it('leaves an owner claim', () => expect(looseClaims({ claims: [{ ...claim, by: 'owner', pid: null, slot: null }], slots: { w1: slot({}) } })).toEqual([]));
  it("leaves a claim for a slot that is not this run's", () => expect(looseClaims({ claims: [{ ...claim, slot: 'w9' }], slots: { w1: slot({}) } })).toEqual([]));
  it('leaves a claim that is not ours', () => expect(loose({}, { ours: () => false })).toEqual([]));
  it('lets go of a stale claim the same way', () => expect(looseClaims({ claims: [{ ...claim, stale: true }], slots: { w1: slot({}) }, ours: (c) => c.stale })).toEqual([{ id: 'ACME-1', slot: 'w1', why: 'idle' }]));

  it('says why in one sentence', () => {
    expect(looseClaimText({ id: 'ACME-1', slot: 'w1', why: 'idle' })).toBe('ACME-1: let go of its claim; slot w1 is idle.');
    expect(looseClaimText({ id: 'ACME-1', slot: 'w1', why: 'parked' })).toBe('ACME-1: let go of its claim; slot w1 is parked without it.');
    expect(looseClaimText({ id: 'ACME-2', slot: 'w1', why: 'building', other: 'ACME-1' })).toBe('ACME-2: let go of its claim; slot w1 is building ACME-1.');
  });
});

describe('ownerClaimFate / settledOwnerClaims / ownerClaimText', () => {
  const AT = '2026-10-24T09:00:00.000Z';
  const NOW = Date.parse('2026-11-09T10:00:00.000Z');
  const ABSENT_MS = 60_000;
  const owner = (id) => ({ id, by: 'owner', pid: null, slot: null, at: AT, stale: false });
  const story = (id, status) => ({ id, status });
  const settle = (over) => settledOwnerClaims({ claims: [owner('ACME-1')], stories: [story('ACME-2', 'todo')], absentSince: {}, now: NOW, absentMs: ABSENT_MS, ...over });

  it('ownerClaimFate gives done and retired for listed stories with those statuses', () => {
    expect(ownerClaimFate('ACME-1', [story('ACME-1', 'done')])).toBe('done');
    expect(ownerClaimFate('ACME-1', [story('ACME-1', 'retired')])).toBe('retired');
  });
  it.each(['todo', 'in-progress', 'blocked', 'ready-to-promote'])('ownerClaimFate gives null for a %s story', (status) => {
    expect(ownerClaimFate('ACME-1', [story('ACME-1', status)])).toBeNull();
  });
  it('ownerClaimFate gives gone for an id missing from a non-empty list, null from an empty one', () => {
    expect(ownerClaimFate('ACME-1', [story('ACME-2', 'todo')])).toBe('gone');
    expect(ownerClaimFate('ACME-1', [])).toBeNull();
  });

  it('drops a claim on a done or retired story at once, with the claim\'s at', () => {
    for (const status of ['done', 'retired']) {
      const r = settle({ stories: [story('ACME-1', status)] });
      expect(r.drop).toEqual([{ id: 'ACME-1', why: status, at: AT }]);
      expect(r.absentSince).toEqual({});
    }
  });
  it('keeps a claim on an open story and records nothing for it', () => {
    const r = settle({ stories: [story('ACME-1', 'in-progress')], absentSince: { 'ACME-1': '2026-11-09T09:00:00.000Z' } });
    expect(r).toEqual({ drop: [], absentSince: {} });
  });
  it('ignores factory claims, even on done stories', () => {
    const r = settle({ claims: [{ ...owner('ACME-1'), by: 'factory', pid: 42 }], stories: [story('ACME-1', 'done')] });
    expect(r).toEqual({ drop: [], absentSince: {} });
  });
  it('notes a missing story at now and does not drop it yet', () => {
    expect(settle()).toEqual({ drop: [], absentSince: { 'ACME-1': new Date(NOW).toISOString() } });
  });
  it('drops a missing story only after strictly more than a poll', () => {
    const first = settle().absentSince;
    expect(settle({ absentSince: first, now: NOW + ABSENT_MS })).toEqual({ drop: [], absentSince: first });
    expect(settle({ absentSince: first, now: NOW + ABSENT_MS + 1 })).toEqual({ drop: [{ id: 'ACME-1', why: 'gone', at: AT }], absentSince: {} });
  });
  it('drops nothing when the list could not be read, and keeps only current owner claims in absentSince', () => {
    const absentSince = { 'ACME-1': '2026-11-09T09:00:00.000Z', 'ACME-7': '2026-11-09T09:00:00.000Z' };
    expect(settle({ stories: null, absentSince })).toEqual({ drop: [], absentSince: { 'ACME-1': '2026-11-09T09:00:00.000Z' } });
  });
  it('drops nothing for an empty list and keeps an existing entry unchanged', () => {
    const absentSince = { 'ACME-1': '2026-11-09T09:00:00.000Z' };
    expect(settle({ stories: [], absentSince, now: NOW + 10 * ABSENT_MS })).toEqual({ drop: [], absentSince });
    expect(settle({ stories: [] })).toEqual({ drop: [], absentSince: {} });
  });
  it('removes the entry of an id that is no longer an owner claim', () => {
    const r = settle({ claims: [], absentSince: { 'ACME-1': '2026-11-09T09:00:00.000Z' } });
    expect(r.absentSince).toEqual({});
  });
  it('restarts the clock at now on an invalid date', () => {
    expect(settle({ absentSince: { 'ACME-1': 'soon' }, now: NOW + 10 * ABSENT_MS })).toEqual({ drop: [], absentSince: { 'ACME-1': new Date(NOW + 10 * ABSENT_MS).toISOString() } });
  });
  it('OWNER_CLAIM_POLL_SECONDS is the 60 second default poll', () => expect(OWNER_CLAIM_POLL_SECONDS).toBe(60));

  it('ownerClaimText gives the three sentences', () => {
    expect(ownerClaimText({ id: 'ACME-1', why: 'done' })).toBe('ACME-1: cleared your claim; the story is done.');
    expect(ownerClaimText({ id: 'ACME-1', why: 'retired' })).toBe('ACME-1: cleared your claim; the story is retired.');
    expect(ownerClaimText({ id: 'ACME-1', why: 'gone' })).toBe('ACME-1: cleared your claim; the story is no longer in the story source.');
  });
  it('is swept by the supervisor every tick, after the claims sweep and before the picks', () => {
    const src = fs.readFileSync(new URL('./supervisor.mjs', import.meta.url), 'utf8');
    const tick = src.slice(src.indexOf('async function tick()'));
    const at = tick.indexOf('sweepOwnerClaims()');
    expect(tick.indexOf('sweepClaims()')).toBeGreaterThan(0);
    expect(at).toBeGreaterThan(tick.indexOf('sweepClaims()'));
    expect(at).toBeLessThan(tick.indexOf('for (const slot of SLOT_IDS)'));
    const fn = src.slice(src.indexOf('const sweepOwnerClaims = guarded('), src.indexOf('// ── the loop'));
    expect(fn).toContain('dropOwnerClaim(DIR, d.id, d.at)');
    expect(fn).toContain("'info'");
    expect(fn).toContain('saveRun({ ownerClaimsAbsent');
  });
});

describe('pendingCommands', () => {
  it('returns each command once', () => {
    const control = { slots: { w2: { action: 'resume', at: 'A' } }, fixedAt: 'F', handBack: { id: 'P7-01', at: 'H' } };
    expect(pendingCommands(control, {}).map((c) => c.key)).toEqual(['slot:w2', 'fixed', 'handback']);
    expect(pendingCommands(control, { 'slot:w2': 'A', fixed: 'F', handback: 'H' })).toEqual([]);
  });
  it('takes a worker count only when it was set, once, by its own time', () => {
    expect(pendingCommands({ workers: 1 }, {})).toEqual([]);
    expect(pendingCommands({ workers: 2, workersAt: 'W' }, {})).toEqual([{ key: 'workers', kind: 'workers', value: 2, at: 'W' }]);
    expect(pendingCommands({ workers: 2, workersAt: 'W' }, { workers: 'W' })).toEqual([]);
    expect(pendingCommands({ workers: 9, workersAt: 'X' }, {})).toEqual([]);
  });
  it('returns a failed-answer retry once per at', () => {
    const control = { answerRetry: { id: 'd-acme-1', at: 'R1' } };
    expect(pendingCommands(control, {})).toEqual([{ key: 'answer-retry', kind: 'answer-retry', id: 'd-acme-1', at: 'R1' }]);
    expect(pendingCommands(control, { 'answer-retry': 'R1' })).toEqual([]);
    expect(pendingCommands({ answerRetry: { id: 'd-acme-1', at: 'R2' } }, { 'answer-retry': 'R1' })).toHaveLength(1);
    expect(pendingCommands({ answerRetry: { id: 'd-acme-1' } }, {})).toEqual([]);
    expect(pendingCommands({ answerRetry: { at: 'R1' } }, {})).toEqual([]);
  });
  it('ignores unknown slots and actions', () => {
    expect(pendingCommands({ slots: { w9: { action: 'resume', at: 'A' }, w1: { action: 'explode', at: 'B' } } }, {})).toEqual([]);
  });
});

describe('slots follow the config', () => {
  it('slotIdsFor names w1..wN', () => {
    expect(slotIdsFor(1)).toEqual(['w1']);
    expect(slotIdsFor(3)).toEqual(['w1', 'w2', 'w3']);
    expect(slotIdsFor(8)).toHaveLength(8);
  });
  it('w5 is a slot at 8 and not at 3', () => {
    const control = { slots: { w5: { action: 'park', at: 'A' } } };
    expect(pendingCommands(control, {}, slotIdsFor(8)).map((c) => c.key)).toEqual(['slot:w5']);
    expect(pendingCommands(control, {}, slotIdsFor(3))).toEqual([]);
  });
  it('the worker count goes up to the number of slots', () => {
    const control = { workers: 6, workersAt: 'W' };
    expect(pendingCommands(control, {}, slotIdsFor(8))).toEqual([{ key: 'workers', kind: 'workers', value: 6, at: 'W' }]);
    expect(pendingCommands(control, {}, slotIdsFor(3))).toEqual([]);
  });
  it('exports the actions the supervisor knows', () => {
    expect([...ACTIONS].sort()).toEqual(['discard', 'park', 'restart', 'resume', 'resume-as-is', 'skip', 'takeover', 'unpark']);
  });
});

describe('afterFixCheck', () => {
  const answer = (o) => `${JSON.stringify(o)}\n`;

  it('clears the halt only when the health check exits 0 and says ok', () => {
    expect(afterFixCheck({ status: 0, stdout: answer({ ok: true, reason: 'The live site answers (https://s).', checks: [] }) })).toEqual({
      clear: true,
      fixProblem: null,
      event: { text: 'Halt cleared: The live site answers (https://s).', kind: 'good' },
    });
  });

  it('says plainly when no health checks are configured', () => {
    expect(afterFixCheck({ status: 0, stdout: answer({ ok: true, reason: 'no health checks are configured', checks: [] }) }).event).toEqual({
      text: 'Halt cleared; no health checks are configured.',
      kind: 'good',
    });
  });

  it('keeps the halt when the check fails, saving why', () => {
    expect(afterFixCheck({ status: 1, stdout: answer({ ok: false, reason: 'https://s answered 503.', checks: [] }) })).toEqual({
      clear: false,
      fixProblem: 'https://s answered 503.',
      event: { text: 'Still halted: https://s answered 503.', kind: 'warn' },
    });
  });

  it('keeps the halt when the exit code and the answer disagree', () => {
    expect(afterFixCheck({ status: 1, stdout: answer({ ok: true, reason: 'fine' }) }).clear).toBe(false);
    expect(afterFixCheck({ status: 0, stdout: answer({ ok: false, reason: 'down' }) }).clear).toBe(false);
  });

  it('keeps the halt when the check does not answer', () => {
    for (const r of [{ status: 0, stdout: '' }, { status: 0, stdout: 'not json' }, { status: null, stdout: undefined }]) {
      expect(afterFixCheck(r)).toMatchObject({ clear: false, fixProblem: 'The health check did not answer.' });
    }
  });

  it('reads the last line that has something on it', () => {
    expect(afterFixCheck({ status: 0, stdout: `warming up\n${answer({ ok: true, reason: 'ok' })}\n\n` }).clear).toBe(true);
  });
});

describe('releaseHeld', () => {
  const RELEASED = { state: 'idle', reason: '', haltedBy: false, heldFor: null, story: null };
  const held = (heldStory, since, haltedBy = false) => ({ state: 'held', heldStory, haltedBy, since, story: { id: heldStory } });

  it('releases the held slots oldest first, keeping heldStory on each', () => {
    const out = releaseHeld([
      { slot: 'w1', st: held('ACME-2', '2026-10-30T10:05:00.000Z', true) },
      { slot: 'w2', st: { state: 'idle', story: null } },
      { slot: 'w3', st: held('ACME-1', '2026-10-30T10:00:00.000Z') },
    ]);
    expect(out).toEqual([
      { slot: 'w3', patch: RELEASED, work: { slot: 'w3', id: 'ACME-1', mode: '' } },
      { slot: 'w1', patch: RELEASED, work: { slot: 'w1', id: 'ACME-2', mode: 'after-halt' } },
    ]);
    for (const r of out) expect(Object.hasOwn(r.patch, 'heldStory')).toBe(false);
  });
  it('skips a held slot with no held story', () => {
    expect(releaseHeld([{ slot: 'w1', st: { state: 'held', heldStory: null, since: 'x' } }, { slot: 'w2', st: { state: 'held', since: 'y' } }])).toEqual([]);
  });

  it('carries what the story looked like when the slot was held, as work.was', () => {
    const heldWas = { status: 'blocked', blockedBy: 'Deploy failed' };
    const st = { ...held('ACME-1', '2026-10-30T10:00:00.000Z', true), heldWas };
    expect(releaseHeld([{ slot: 'w1', st }])[0].work).toEqual({ slot: 'w1', id: 'ACME-1', mode: 'after-halt', was: heldWas });
    const api = { ...held('ACME-2', '2026-10-30T10:00:00.000Z'), heldFor: 'api', heldWas };
    expect(resumeHeld([{ slot: 'w2', st: api }])[0].work).toEqual({ slot: 'w2', id: 'ACME-2', mode: '', was: heldWas });
    expect(releaseAfterWait([{ slot: 'w2', st: api }], { now: 10 })[0].work).toEqual({ slot: 'w2', id: 'ACME-2', mode: '', was: heldWas, resume: true });
  });

  describe('applied to a slot file', () => {
    let dir;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-release-held-'));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('keeps the story counted in the slots, so the env sweep keeps its org', () => {
      setSlot(dir, 'w1', { state: 'held', heldStory: 'ACME-2', haltedBy: true, story: { id: 'ACME-2' } });
      const [r] = releaseHeld([{ slot: 'w1', st: readSlot(dir, 'w1') }]);
      setSlot(dir, 'w1', r.patch);
      expect(readSlot(dir, 'w1')).toMatchObject({ state: 'idle', story: null, heldStory: 'ACME-2' });
      expect(storiesInSlots(dir).has('ACME-2')).toBe(true);
    });
  });

  it('is what the supervisor runs when the halt clears', () => {
    const src = fs.readFileSync(new URL('./supervisor.mjs', import.meta.url), 'utf8');
    const fixed = src.slice(src.indexOf('function fixed()'), src.indexOf('function handBack('));
    expect(fixed).toContain('releaseHeld(SLOT_IDS.map((slot) => ({ slot, st: readSlot(DIR, slot) })))');
    expect(fixed).toContain('setSlot(DIR, r.slot, r.patch, now());');
    expect(fixed).toContain('work.push(r.work);');
    expect(fixed).not.toContain('heldStory: null');
  });

  it('is gated: queued work passes queuedStop before takeOver, and a held slot records heldWas', () => {
    const src = fs.readFileSync(new URL('./supervisor.mjs', import.meta.url), 'utf8');
    const start = src.slice(src.indexOf('function startWork('), src.indexOf('const sweepClaims'));
    expect(start).toContain('queuedStop(w)');
    expect(start.indexOf('queuedStop(w)')).toBeLessThan(start.indexOf('takeOver('));
    const reconcile = src.slice(src.indexOf('function reconcileStart('), src.indexOf('function startWork('));
    expect(reconcile).toContain('finish: true');
    const end = src.slice(src.indexOf('function endSession('), src.indexOf('const afterOwnerStop'));
    expect(end).toContain('heldWas: heldSnapshot(id)');
  });
});

describe('workStop', () => {
  const ID = '[A-Z]+-\\d+';
  const st = (id, status, blockedBy = '') => ({ id, status, blockedBy });
  const list = [
    st('ACME-1', 'todo'),
    st('ACME-2', 'in-progress'),
    st('ACME-3', 'blocked', 'Deploy failed.'),
    st('ACME-4', 'done'),
    st('ACME-5', 'retired'),
    st('ACME-6', 'ready-to-promote'),
    st('ACME-7', 'blocked', 'ACME-4 must land first'),
    st('ACME-8', 'blocked', 'ACME-1 must land first'),
  ];
  const stop = (w, over = {}) => workStop({ slot: 'w1', mode: '', ...w }, { stories: list, idPattern: ID, ...over });

  it('stops work for a story skipped this run', () => {
    expect(stop({ id: 'ACME-1' }, { skipped: ['ACME-1'] })).toEqual({ why: 'skipped' });
    expect(stop({ id: 'ACME-4', resume: true }, { skipped: ['ACME-4'] })).toEqual({ why: 'skipped' });
  });
  it('lets finish-release work and summary work through, even when skipped', () => {
    expect(stop({ id: 'ACME-1', finish: true }, { skipped: ['ACME-1'] })).toBeNull();
    expect(stop({ id: 'ACME-1', mode: 'group-summary' }, { skipped: ['ACME-1'] })).toBeNull();
    expect(stop({ id: 'ACME-4', mode: 'phase-summary' })).toBeNull();
  });
  it('stops work for a done, retired or ready-to-promote story, but leaves a resume to closeInstead', () => {
    expect(stop({ id: 'ACME-4' })).toEqual({ why: 'settled', status: 'done' });
    expect(stop({ id: 'ACME-5' })).toEqual({ why: 'settled', status: 'retired' });
    expect(stop({ id: 'ACME-6' })).toEqual({ why: 'settled', status: 'ready-to-promote' });
    expect(stop({ id: 'ACME-4', resume: true })).toBeNull();
  });
  it('stops work for a story blocked in words, in any gated mode', () => {
    expect(stop({ id: 'ACME-3' })).toEqual({ why: 'blocked' });
    expect(stop({ id: 'ACME-3', mode: 'fresh' })).toEqual({ why: 'blocked' });
  });
  it('lets a halted story resume when nothing changed since it was held', () => {
    expect(stop({ id: 'ACME-3', mode: 'after-halt', was: { status: 'blocked', blockedBy: 'Deploy failed.' } })).toBeNull();
  });
  it('stops a halted story the owner changed since it was held', () => {
    expect(stop({ id: 'ACME-3', mode: 'after-halt', was: { status: 'blocked', blockedBy: 'Something else' } })).toEqual({ why: 'blocked' });
    expect(stop({ id: 'ACME-3', mode: 'after-halt', was: { status: 'in-progress', blockedBy: '' } })).toEqual({ why: 'blocked' });
  });
  it('lets an after-halt story with no record resume as before', () => {
    expect(stop({ id: 'ACME-3', mode: 'after-halt' })).toBeNull();
  });
  it('lets a story blocked only on done stories through, and stops one blocked on an open story', () => {
    expect(stop({ id: 'ACME-7' })).toBeNull();
    expect(stop({ id: 'ACME-8' })).toEqual({ why: 'blocked' });
  });
  it('lets todo and in-progress stories through', () => {
    expect(stop({ id: 'ACME-1' })).toBeNull();
    expect(stop({ id: 'ACME-2' })).toBeNull();
  });
  it('lets a story the source does not list through', () => {
    expect(stop({ id: 'ACME-99' })).toBeNull();
  });
  it('checks only the skip when the source cannot be read', () => {
    expect(stop({ id: 'ACME-4' }, { stories: null })).toBeNull();
    expect(stop({ id: 'ACME-4' }, { stories: null, skipped: ['ACME-4'] })).toEqual({ why: 'skipped' });
  });
  it('treats a blocked story as blocked when there is no id pattern', () => {
    expect(stop({ id: 'ACME-7' }, { idPattern: undefined })).toEqual({ why: 'blocked' });
  });
});

describe('workStopText', () => {
  it('words the three reasons', () => {
    expect(workStopText({ id: 'ACME-1', slot: 'w1', stop: { why: 'skipped' } })).toBe('ACME-1 not resumed: you skipped it for this run; slot w1 is free.');
    expect(workStopText({ id: 'ACME-2', slot: 'w2', stop: { why: 'settled', status: 'done' } })).toBe('ACME-2 not resumed: its story is done; slot w2 is free.');
    expect(workStopText({ id: 'ACME-3', slot: 'w3', stop: { why: 'blocked' } })).toBe('ACME-3 not resumed: its story is blocked; slot w3 is free.');
  });
});

describe('dropSteps', () => {
  const NONE = { free: false, letGo: false, tidy: false, say: false };

  it('touches nothing and says nothing when the story already runs elsewhere', () => {
    for (const pinned of [false, true]) {
      for (const elsewhere of [false, true]) expect(dropSteps({ running: true, pinned, elsewhere })).toEqual(NONE);
    }
  });
  it('frees the slot, lets the story go and says so for a pinned story nothing else holds', () => {
    expect(dropSteps({ running: false, pinned: true, elsewhere: false })).toEqual({ free: true, letGo: true, tidy: true, say: true });
  });
  it('clears the pin only, when the story is also in hand elsewhere', () => {
    expect(dropSteps({ running: false, pinned: true, elsewhere: true })).toEqual({ free: true, letGo: false, tidy: false, say: false });
  });
  it('lets go and says so for an unpinned story nothing else holds', () => {
    expect(dropSteps({ running: false, pinned: false, elsewhere: false })).toEqual({ free: false, letGo: true, tidy: false, say: true });
  });
  it('drops a duplicate of a story in hand elsewhere quietly', () => {
    expect(dropSteps({ running: false, pinned: false, elsewhere: true })).toEqual(NONE);
  });
  it('is the unpinned, nowhere-else result with no argument', () => {
    expect(dropSteps()).toEqual(dropSteps({ running: false, pinned: false, elsewhere: false }));
  });
  it('is what the supervisor drops stopped work with: running is read from sessions and slots, and the claim goes after the decision', () => {
    const src = fs.readFileSync(new URL('./supervisor.mjs', import.meta.url), 'utf8');
    const drop = src.slice(src.indexOf('function dropWork('), src.indexOf('function startWork('));
    expect(drop).toContain('inHandSessions()');
    expect(drop).toContain('.story?.id === w.id');
    expect(drop).toContain('dropSteps({ running, pinned, elsewhere })');
    expect(drop.indexOf('releaseClaim(')).toBeGreaterThan(drop.indexOf('dropSteps('));
  });
});

describe('resumeHeld', () => {
  const RELEASED = { state: 'idle', reason: '', haltedBy: false, heldFor: null, story: null };
  const held = (heldStory, since, haltedBy = false) => ({ state: 'held', heldStory, haltedBy, heldFor: haltedBy ? null : 'api', since, story: { id: heldStory } });

  it('releases an api-held slot as work to queue', () => {
    expect(resumeHeld([{ slot: 'w1', st: held('ACME-1', '2026-10-30T10:00:00.000Z') }])).toEqual([{ slot: 'w1', patch: RELEASED, work: { slot: 'w1', id: 'ACME-1', mode: '' } }]);
  });
  it('gives two held slots oldest first', () => {
    const out = resumeHeld([
      { slot: 'w2', st: held('ACME-2', '2026-10-30T10:05:00.000Z') },
      { slot: 'w1', st: held('ACME-1', '2026-10-30T10:00:00.000Z') },
    ]);
    expect(out.map((r) => r.slot)).toEqual(['w1', 'w2']);
  });
  it('refuses a slot a halt holds: that one waits for "I\'ve fixed it"', () => {
    expect(resumeHeld([{ slot: 'w3', st: held('ACME-3', '2026-10-30T09:00:00.000Z', true) }])).toEqual([]);
  });
  it('ignores idle, parked and held slots with no held story', () => {
    expect(
      resumeHeld([
        { slot: 'w1', st: { state: 'idle', story: null } },
        { slot: 'w2', st: { state: 'parked', parkedFor: 'crash', heldStory: 'ACME-2' } },
        { slot: 'w3', st: { state: 'held', heldStory: null, since: 'x' } },
      ]),
    ).toEqual([]);
  });
});

describe('releaseAfterWait', () => {
  const RELEASED = { state: 'idle', reason: '', haltedBy: false, heldFor: null, story: null };
  const held = (heldStory, since, haltedBy = false) => ({ state: 'held', heldStory, haltedBy, heldFor: haltedBy ? null : 'api', since, story: { id: heldStory } });
  const slots = [
    { slot: 'w2', st: held('ACME-2', '2026-10-30T10:05:00.000Z') },
    { slot: 'w1', st: held('ACME-1', '2026-10-30T10:00:00.000Z') },
  ];
  const open = { halted: false, paused: false, backoffUntil: 1000, now: 1000 };

  it('releases nothing while halted, paused or backing off', () => {
    expect(releaseAfterWait(slots, { ...open, halted: true })).toEqual([]);
    expect(releaseAfterWait(slots, { ...open, paused: true })).toEqual([]);
    expect(releaseAfterWait(slots, { ...open, now: 999 })).toEqual([]);
  });
  it('releases nothing while a stop is in progress, so the stop leaves the slot held for the next run', () => {
    expect(releaseAfterWait(slots, { ...open, stopping: true })).toEqual([]);
    expect(releaseAfterWait(slots, { ...open, stopping: false })).toHaveLength(2);
  });
  it('releases the held slots oldest first once the backoff ends, as an automatic resume', () => {
    expect(releaseAfterWait(slots, open)).toEqual([
      { slot: 'w1', patch: RELEASED, work: { slot: 'w1', id: 'ACME-1', mode: '', resume: true } },
      { slot: 'w2', patch: RELEASED, work: { slot: 'w2', id: 'ACME-2', mode: '', resume: true } },
    ]);
  });
  it('ignores an environment wait: only the API wait holds a slot held for the API', () => {
    expect(releaseAfterWait(slots, { ...open, envUntil: 9e9 })).toHaveLength(2);
  });
  it('treats a missing backoff as over', () => {
    expect(releaseAfterWait(slots, { halted: false, paused: false, now: 5 })).toHaveLength(2);
    expect(releaseAfterWait(slots, { halted: false, paused: false, backoffUntil: null, now: 5 })).toHaveLength(2);
  });
  it('never releases a slot a halt holds: that one waits for "I\'ve fixed it"', () => {
    const mixed = [{ slot: 'w3', st: held('ACME-3', '2026-10-30T09:00:00.000Z', true) }, ...slots];
    const out = releaseAfterWait(mixed, open);
    expect(out.map((r) => r.slot)).toEqual(['w1', 'w2']);
    expect(releaseAfterWait([{ slot: 'w3', st: held('ACME-3', 'a', true) }], { ...open, now: 1e12 })).toEqual([]);
  });
  it('releases a story already in hand with no work, so it is not queued twice', () => {
    const out = releaseAfterWait(slots, { ...open, inHand: new Set(['ACME-1']) });
    expect(out.map((r) => [r.slot, r.work?.id ?? null])).toEqual([['w1', null], ['w2', 'ACME-2']]);
    expect(out[0].patch).toEqual(RELEASED);
  });
  it('ignores idle, parked and held slots with no held story', () => {
    expect(
      releaseAfterWait(
        [
          { slot: 'w1', st: { state: 'idle', story: null } },
          { slot: 'w2', st: { state: 'parked', parkedFor: 'crash', heldStory: 'ACME-2' } },
          { slot: 'w3', st: { state: 'held', heldStory: null, since: 'x' } },
        ],
        open,
      ),
    ).toEqual([]);
  });
  it('is what the supervisor runs every tick, before the claims sweep and the picks', () => {
    const src = fs.readFileSync(new URL('./supervisor.mjs', import.meta.url), 'utf8');
    const tick = src.slice(src.indexOf('async function tick()'));
    expect(tick.indexOf('releaseApiHeld({ halted, paused, stopping })')).toBeGreaterThan(0);
    expect(tick.indexOf('releaseApiHeld({ halted, paused, stopping })')).toBeLessThan(tick.indexOf('sweepClaims()'));
    const fn = src.slice(src.indexOf('function releaseApiHeld('), src.indexOf('function fixed()'));
    expect(fn).toContain('function releaseApiHeld({ halted, paused, stopping })');
    expect(fn).toContain('releaseAfterWait(');
    expect(fn).toMatch(/releaseAfterWait\(slots, \{[^}]*\bstopping\b[^}]*\}\)/);
    expect(fn).toContain('backoffUntil: counters.backoffUntil');
    expect(fn).toContain('work.push(r.work)');
  });
  it('the supervisor holds a session that died on the API for the API, and shows the retry time', () => {
    const src = fs.readFileSync(new URL('./supervisor.mjs', import.meta.url), 'utf8');
    expect(src).toContain("heldFor: run.cause ? 'api' : null");
    expect(src).toContain("afterOutcome(counters, o, Date.now(), id, { backoffMs: BACKOFF, why })");
    expect(src).toContain('retimeApiHeld();');
    expect(src).toContain("after.global === 'backoff' && after.reason");
  });
  it('the supervisor times an environment wait by envUntil and shows it as envWait, never touching the API hold', () => {
    const src = fs.readFileSync(new URL('./supervisor.mjs', import.meta.url), 'utf8');
    expect(src).toContain('envUntil: counters.envUntil');
    expect(src).toContain('envWait: { since:');
    expect(src).toContain('until: new Date(counters.envUntil)');
    expect(src).toContain('envUntil: 0');
    const retime = src.slice(src.indexOf('function retimeApiHeld('), src.indexOf('function releaseApiHeld('));
    expect(retime).toContain('backoffUntil');
    expect(retime).not.toContain('envUntil');
    expect(src).toMatch(/apiWait: null, envWait: null/);
  });
  it('Resume on a held slot queues its story through resumeHeld', () => {
    const src = fs.readFileSync(new URL('./supervisor.mjs', import.meta.url), 'utf8');
    const resume = src.slice(src.indexOf("case 'resume':"), src.indexOf("case 'resume-as-is':"));
    expect(resume).toContain("st.state === 'held'");
    expect(resume).toContain('resumeHeld([{ slot, st }])');
    expect(resume).toContain('work.unshift(r.work)');
  });
});

describe('slotStoryId', () => {
  const claim = (id, slot, by = 'factory') => ({ id, slot, by });

  it('gives the story a crash-parked slot was parked on, not a stale heldStory', () => {
    expect(slotStoryId({ st: { state: 'parked', parkedFor: 'crash', parkedStory: 'ACME-2', heldStory: 'ACME-1' }, slot: 'w1' })).toBe('ACME-2');
  });
  it('falls back to the slot claim for a parked slot with no parkedStory, never to a stale heldStory', () => {
    const st = { state: 'parked', parkedFor: 'crash', heldStory: 'ACME-1' };
    expect(slotStoryId({ st, claims: [claim('ACME-3', 'w1')], slot: 'w1' })).toBe('ACME-3');
    expect(slotStoryId({ st, slot: 'w1' })).toBeNull();
  });
  it('reads heldStory on a held slot and on an idle slot released by releaseHeld', () => {
    expect(slotStoryId({ st: { state: 'held', heldStory: 'ACME-1' }, slot: 'w1' })).toBe('ACME-1');
    const [r] = releaseHeld([{ slot: 'w1', st: { state: 'held', heldStory: 'ACME-1', since: 'x' } }]);
    expect(slotStoryId({ st: { state: 'held', heldStory: 'ACME-1', ...r.patch }, slot: 'w1' })).toBe('ACME-1');
  });
  it('prefers the running story, then the slot story, then heldStory', () => {
    const st = { state: 'building', story: { id: 'ACME-2' }, heldStory: 'ACME-3' };
    expect(slotStoryId({ st, running: { id: 'ACME-1' }, slot: 'w1' })).toBe('ACME-1');
    expect(slotStoryId({ st, slot: 'w1' })).toBe('ACME-2');
    expect(slotStoryId({ st: { state: 'idle', heldStory: 'ACME-3' }, slot: 'w1' })).toBe('ACME-3');
  });
  it('ignores an owner claim and a claim for another slot', () => {
    expect(slotStoryId({ st: { state: 'idle' }, claims: [claim('ACME-1', 'w1', 'owner'), claim('ACME-2', 'w2')], slot: 'w1' })).toBeNull();
  });
  it('gives null for no slot state at all', () => expect(slotStoryId({ slot: 'w1' })).toBeNull());
});

describe('LET_GO_PATCH', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-let-go-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('empties a held slot, heldStory included', () => {
    setSlot(dir, 'w1', { state: 'held', heldStory: 'ACME-1', story: { id: 'ACME-1' } });
    setSlot(dir, 'w1', LET_GO_PATCH);
    const st = readSlot(dir, 'w1');
    expect(st).toMatchObject({ state: 'idle', story: null, heldStory: null, parkedStory: null });
    expect(slotStoryId({ st, slot: 'w1' })).toBeNull();
  });
  it('clears heldFor, so a slot that let go of its story keeps no stale api marker', () => {
    setSlot(dir, 'w1', { state: 'held', heldFor: 'api', heldStory: 'ACME-1', story: { id: 'ACME-1' } });
    setSlot(dir, 'w1', LET_GO_PATCH);
    expect(readSlot(dir, 'w1')).toMatchObject({ state: 'idle', heldFor: null });
    expect(LET_GO_PATCH.heldFor).toBeNull();
  });
  it('is what the supervisor applies when the owner skips or takes over a story', () => {
    const src = fs.readFileSync(new URL('./supervisor.mjs', import.meta.url), 'utf8');
    const command = src.slice(src.indexOf('function slotCommand('), src.indexOf('function fixed()'));
    expect(command).toContain('slotStoryId({ st, running, claims: claims(DIR), slot })');
    expect(command).not.toContain('st.heldStory ?? st.parkedStory');
    const stops = src.slice(src.indexOf('const afterOwnerStop'), src.indexOf('function restartFresh('));
    expect(stops.split('LET_GO_PATCH').length - 1).toBeGreaterThanOrEqual(2);
  });
});

describe('whenNothingLeft', () => {
  const idle = { nothingLeft: true, halted: false, held: false, running: false, queued: 0, once: false, max: 0, exitWhenIdle: false };

  it('stays on standby when nothing is left and no limit asks to exit', () => expect(whenNothingLeft(idle)).toBe('standby'));
  it.each([
    ['--once', { once: true }],
    ['--max', { max: 2 }],
    ['--exit-when-idle', { exitWhenIdle: true }],
  ])('exits with %s', (_, patch) => expect(whenNothingLeft({ ...idle, ...patch })).toBe('exit'));
  it.each([
    ['halted', { halted: true }],
    ['held (paused or a Jira hold)', { held: true }],
    ['a session runs or prepares', { running: true }],
    ['work is queued', { queued: 1 }],
    ['there is something left', { nothingLeft: false }],
  ])('does nothing when %s', (_, patch) => expect(whenNothingLeft({ ...idle, ...patch })).toBeNull());
  it('says why the loop waits', () => expect(STANDBY).toBe('Nothing to build; picks up new stories automatically.'));
});

describe('backoffShown', () => {
  it('gives the ISO time of a backoff still running', () => {
    expect(backoffShown({ backoffUntil: 5000 }, 1000)).toBe(new Date(5000).toISOString());
  });

  it('gives null for none, a past one or an ended one', () => {
    expect(backoffShown({ backoffUntil: 0 }, 1000)).toBeNull();
    expect(backoffShown({ backoffUntil: 500 }, 1000)).toBeNull();
    expect(backoffShown({ backoffUntil: 1000 }, 1000)).toBeNull();
    expect(backoffShown({}, 1000)).toBeNull();
  });

  it('gives the later of the API wait and the environment wait', () => {
    expect(backoffShown({ backoffUntil: 0, envUntil: 5000 }, 1000)).toBe(new Date(5000).toISOString());
    expect(backoffShown({ backoffUntil: 3000, envUntil: 5000 }, 1000)).toBe(new Date(5000).toISOString());
    expect(backoffShown({ backoffUntil: 5000, envUntil: 3000 }, 1000)).toBe(new Date(5000).toISOString());
    expect(backoffShown({ backoffUntil: 0, envUntil: 500 }, 1000)).toBeNull();
  });

  it('is what the supervisor keeps in state.json after each ending, at stop and at start', () => {
    const src = fs.readFileSync(new URL('./supervisor.mjs', import.meta.url), 'utf8');
    expect(src).toContain('backoffShown(counters, Date.now())');
    expect(src).toContain('saveRun({ backoffUntil: backoffAt })');
    expect(src).toMatch(/saveRun\(\{ configProblem: null, stuck: null[^}]*backoffUntil: null/);
  });
});
