import { describe, expect, it } from 'vitest';
import { hhmm, localStamp } from './claude-fallback.mjs';
import {
  afterCreditProbe,
  CREDIT_RETRY_MS,
  CREDIT_WAIT_MS,
  creditProbeDue,
  creditRetryMs,
  MAX_RESET_AHEAD_MS,
  resetTime,
  resumeAtFor,
  retrySentence,
  retryWhen,
} from './credit-resume.mjs';

const at = (iso) => Date.parse(iso);

describe('resetTime', () => {
  const now = at('2026-11-01T10:00:00Z');
  it('reads the Console date form as UTC, with or without a trailing dot', () => {
    expect(resetTime('2026-11-01 at 00:00 UTC', at('2026-10-30T10:00:00Z'))).toBe(Date.UTC(2026, 10, 1));
    expect(resetTime('2026-11-01 00:00 UTC.', at('2026-10-30T10:00:00Z'))).toBe(Date.UTC(2026, 10, 1));
  });
  it('gives a date in the past as it is, so the probe runs at once', () => {
    expect(resetTime('2026-10-01 at 06:30 UTC', now)).toBe(at('2026-10-01T06:30:00Z'));
  });
  it('reads a clock time in a named zone: today, or tomorrow once it has passed', () => {
    expect(resetTime('3pm (Europe/London)', now)).toBe(at('2026-11-01T15:00:00Z'));
    expect(resetTime('3pm (Europe/London)', at('2026-11-01T16:00:00Z'))).toBe(at('2026-11-02T15:00:00Z'));
  });
  it('follows daylight saving in the zone', () => {
    expect(resetTime('6:30pm (America/New_York)', at('2026-07-01T12:00:00Z'))).toBe(at('2026-07-01T22:30:00Z'));
    expect(resetTime('6:30pm (America/New_York)', at('2026-12-01T12:00:00Z'))).toBe(at('2026-12-01T23:30:00Z'));
  });
  it('reads a weekday, the next one whose time is still ahead', () => {
    expect(resetTime('Fri 6pm (Europe/London)', at('2026-11-04T09:00:00Z'))).toBe(at('2026-11-06T18:00:00Z'));
    expect(resetTime('Friday, 6pm (Europe/London)', at('2026-11-04T09:00:00Z'))).toBe(at('2026-11-06T18:00:00Z'));
    // today counts while ahead; once passed it is next week
    expect(resetTime('Fri 6pm (Europe/London)', at('2026-11-06T09:00:00Z'))).toBe(at('2026-11-06T18:00:00Z'));
    expect(resetTime('Fri 6pm (Europe/London)', at('2026-11-06T19:00:00Z'))).toBe(at('2026-11-13T18:00:00Z'));
  });
  it('reads a month and day', () => {
    expect(resetTime('Nov 7, 6pm (Europe/London)', now)).toBe(at('2026-11-07T18:00:00Z'));
    expect(resetTime('November 7 at 6pm (Europe/London)', now)).toBe(at('2026-11-07T18:00:00Z'));
  });
  it('reads a 24-hour clock and a bare UTC', () => {
    expect(resetTime('18:00 UTC', now)).toBe(at('2026-11-01T18:00:00Z'));
    expect(resetTime('06:00 GMT', now)).toBe(at('2026-11-02T06:00:00Z'));
    expect(resetTime('12am (UTC)', at('2026-11-01T10:00:00Z'))).toBe(at('2026-11-02T00:00:00Z'));
    expect(resetTime('12pm UTC', at('2026-11-01T10:00:00Z'))).toBe(at('2026-11-01T12:00:00Z'));
  });
  it('uses the machine zone when none is given', () => {
    const n = new Date(2026, 10, 1, 10, 0, 0);
    expect(resetTime('3pm', n.getTime())).toBe(new Date(2026, 10, 1, 15).getTime());
    const late = new Date(2026, 10, 1, 16, 0, 0);
    expect(resetTime('3pm', late.getTime())).toBe(new Date(2026, 10, 2, 15).getTime());
  });
  it.each([
    ['empty', ''],
    ['null', null],
    ['undefined', undefined],
    ['a number', 7],
    ['words', 'soon'],
    ['a bare number', '7'],
    ['an unknown zone', '3pm (Not/AZone)'],
    ['an hour out of range with am/pm', '13pm UTC'],
    ['a minute out of range', '10:75 UTC'],
    ['a day that does not exist', 'Feb 31, 6pm UTC'],
    ['more than 35 days ahead', '2027-06-01 at 00:00 UTC'],
    ['longer than 80 characters', '3pm (Europe/London)' + ' '.repeat(80)],
  ])('gives null for %s', (_, text) => {
    expect(resetTime(text, at('2026-11-01T00:00:00Z'))).toBeNull();
  });
  it('still reads the longest realistic form, a month, day and long zone', () => {
    expect(resetTime('November 7 at 6pm (America/Argentina/Buenos_Aires)', now)).toBe(at('2026-11-07T21:00:00Z'));
  });
  it('gives null at once for text too long to be a reset time, without stalling', () => {
    for (const s of ['1' + ' '.repeat(50_000) + 'x', '.'.repeat(50_000) + 'x', '1' + ' '.repeat(1_000_000) + 'x']) {
      const started = performance.now();
      expect(resetTime(s, now)).toBeNull();
      expect(performance.now() - started).toBeLessThan(200);
    }
  });
  it('allows a date just inside the 35 days', () => {
    const base = at('2026-11-01T00:00:00Z');
    expect(resetTime('2026-12-05 at 00:00 UTC', base)).toBe(at('2026-12-05T00:00:00Z'));
    expect(at('2026-12-05T00:00:00Z') - base).toBeLessThanOrEqual(MAX_RESET_AHEAD_MS);
    expect(resetTime('2026-12-07 at 00:00 UTC', base)).toBeNull();
  });
});

describe('resumeAtFor', () => {
  const now = at('2026-11-01T10:00:00Z');
  it('is the parsed reset time as an ISO string', () => {
    expect(resumeAtFor({ resetAt: '2026-11-01 at 12:00 UTC', now })).toBe('2026-11-01T12:00:00.000Z');
  });
  it('is an hour from now when there is no reset time or it does not parse', () => {
    const hour = new Date(now + CREDIT_WAIT_MS).toISOString();
    expect(CREDIT_WAIT_MS).toBe(60 * 60_000);
    expect(resumeAtFor({ resetAt: null, now })).toBe(hour);
    expect(resumeAtFor({ resetAt: 'soon', now })).toBe(hour);
    expect(resumeAtFor({ now })).toBe(hour);
  });
});

describe('creditProbeDue', () => {
  const now = at('2026-11-01T10:00:00Z');
  const base = { pausedAt: '2026-11-01T09:00:00.000Z', resumeAt: '2026-11-01T10:00:00.000Z', running: false, now };
  it('is true at and after the resume time', () => {
    expect(creditProbeDue(base)).toBe(true);
    expect(creditProbeDue({ ...base, now: now + 1 })).toBe(true);
  });
  it.each([
    ['no pause', { pausedAt: null }],
    ['no resume time', { resumeAt: null }],
    ['a check running', { running: true }],
    ['the time not yet come', { now: now - 1 }],
    ['a resume time that does not parse', { resumeAt: 'later' }],
  ])('is false with %s', (_, over) => {
    expect(creditProbeDue({ ...base, ...over })).toBe(false);
  });
});

describe('afterCreditProbe', () => {
  const now = at('2026-11-01T10:00:00Z');
  const base = { ok: true, pausedAt: 'P', probedPausedAt: 'P', resumeAt: '2026-11-01T10:00:00.000Z', now, retryMs: CREDIT_RETRY_MS };
  it('clears the pause with one good event when Claude answers', () => {
    expect(afterCreditProbe(base)).toEqual({
      clear: true,
      resumeAt: null,
      event: { text: 'Claude answers again; carrying on after the usage limit.', kind: 'good' },
    });
  });
  it.each([
    ['the pause went (the owner pressed Resume)', { pausedAt: null }],
    ['the pause changed', { pausedAt: 'Q' }],
    ['it is not a credit pause', { resumeAt: null }],
  ])('touches nothing when %s', (_, over) => {
    for (const ok of [true, false]) {
      expect(afterCreditProbe({ ...base, ok, ...over })).toEqual({ clear: false, resumeAt: null, event: null });
    }
  });
  it('keeps the pause and tries again after the retry time when the probe fails, with no event', () => {
    expect(afterCreditProbe({ ...base, ok: false })).toEqual({ clear: false, resumeAt: new Date(now + CREDIT_RETRY_MS).toISOString(), event: null });
    expect(afterCreditProbe({ ...base, ok: false, retryMs: 2000 }).resumeAt).toBe(new Date(now + 2000).toISOString());
  });
});

describe('creditRetryMs', () => {
  it('is 30 minutes unless the value is a positive integer', () => {
    expect(CREDIT_RETRY_MS).toBe(30 * 60_000);
    for (const v of [undefined, '', 'abc', '0', '-5', '1.5', 3000]) expect(creditRetryMs(v)).toBe(CREDIT_RETRY_MS);
  });
  it('shortens it, to a second at the least, never lengthens it', () => {
    expect(creditRetryMs('3000')).toBe(3000);
    expect(creditRetryMs('10')).toBe(1000);
    expect(creditRetryMs('99999999999')).toBe(CREDIT_RETRY_MS);
  });
});

describe('retryWhen and retrySentence', () => {
  const now = new Date(2026, 10, 1, 10, 0, 0).getTime();
  it('gives the time of day when it is the same local day', () => {
    const when = new Date(2026, 10, 1, 15, 30, 0).toISOString();
    expect(retryWhen(when, now)).toBe(hhmm(when));
    expect(retrySentence(when, now)).toBe(`Foreman tries again at ${hhmm(when)} by itself.`);
  });
  it('gives the date and time on another day', () => {
    const when = new Date(2026, 10, 3, 0, 5, 0).toISOString();
    expect(retryWhen(when, now)).toBe(localStamp(when));
    expect(retrySentence(when, now)).toBe(`Foreman tries again at ${localStamp(when)} by itself.`);
  });
});
