// The supervisor's late-wake check: a loop that wakes far later than it asked (the computer
// slept, or the event loop was held) logs it and asks Jira again before the cache is judged.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeToken } from '../jira/auth.mjs';
import { jiraRefresher } from '../jira/refresher.mjs';
import { startFakeJiraHere } from '../../../test/fake-jira.mjs';
import { checkWake, DEFAULT_TICK_MS, LATE_FACTOR, lateWake, lateWakeText, loopRest, refreshAfterWake, restThenCheckWake, tickMs, WAKE_POLL_LIMIT_MS } from './wake.mjs';
import { progressWatch, stuckLimits } from './progress-watch.mjs';

const SITE = 'acme.atlassian.net';
const JQL = 'project = APP ORDER BY rank';
const T0 = new Date('2026-10-17T12:00:00Z');
const TEN_MIN = 10 * 60_000;

let jira;
const dirs = [];
beforeAll(async () => {
  jira = await startFakeJiraHere();
});
afterAll(async () => {
  await jira.close();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
beforeEach(() => {
  jira.reset();
  jira.addIssue({ key: 'APP-1', summary: 'Sign in' });
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-wake-'));
  dirs.push(root);
  const env = { HOME: path.join(root, 'home'), FOREMAN_JIRA_API_BASE: jira.url, FOREMAN_JIRA_AUTH_BASE: jira.url };
  writeToken(SITE, { cloudId: jira.cloudId, site: SITE, ...jira.tokens, expiresAt: '2999-01-01T00:00:00.000Z' }, { env });
  const stateDir = path.join(root, '.foreman');
  const options = { adapter: 'jira', site: SITE, jql: JQL, pollSeconds: 60 };
  const t = { clock: T0 };
  const refresher = jiraRefresher({ stories: () => options, stateDir, env, now: () => t.clock });
  return { refresher, t };
}

const searches = async () => (await jira.requests()).filter((r) => r.method === 'POST' && /\/search\/jql$/.test(r.path)).length;

describe('lateWake', () => {
  it('is null on time and at exactly 3 x the interval late, and gives the lateness past that', () => {
    expect(LATE_FACTOR).toBe(3);
    expect(WAKE_POLL_LIMIT_MS).toBe(30_000);
    expect(lateWake({ sleptAt: 1000, wokeAt: 1000 + 5000, intervalMs: 5000 })).toBeNull();
    expect(lateWake({ sleptAt: 1000, wokeAt: 1000 + 5000 + 15_000, intervalMs: 5000 })).toBeNull();
    expect(lateWake({ sleptAt: 1000, wokeAt: 1000 + 5000 + 15_001, intervalMs: 5000 })).toEqual({ lateMs: 15_001 });
    expect(lateWake({ sleptAt: 1000, wokeAt: 1000 + TEN_MIN, intervalMs: 5000 })).toEqual({ lateMs: TEN_MIN - 5000 });
  });
});

describe('tickMs', () => {
  it('is the 5 s default for no value, an empty value, a non-integer, zero and a negative', () => {
    expect(DEFAULT_TICK_MS).toBe(5000);
    for (const v of [undefined, '', 'abc', '1.5', '0', '-5']) expect(tickMs(v)).toBe(5000);
  });

  it('takes a shorter tick, never a longer one, and never under 50 ms', () => {
    expect(tickMs('500')).toBe(500);
    expect(tickMs('50')).toBe(50);
    expect(tickMs('5000')).toBe(5000);
    expect(tickMs('99999')).toBe(5000);
    expect(tickMs('10')).toBe(50);
    expect(tickMs('1')).toBe(50);
  });

  it('the supervisor reads its tick from FOREMAN_TICK_MS through tickMs', () => {
    const src = fs.readFileSync(new URL('./supervisor.mjs', import.meta.url), 'utf8');
    expect(src).toContain('const TICK_MS = tickMs(process.env.FOREMAN_TICK_MS);');
  });
});

describe('lateWake at a short tick', () => {
  it('is null until the lateness passes 3 x the default tick, however short the interval', () => {
    expect(lateWake({ sleptAt: 0, wokeAt: 500 + 2000, intervalMs: 500 })).toBeNull();
    expect(lateWake({ sleptAt: 0, wokeAt: 500 + 15_000, intervalMs: 500 })).toBeNull();
    expect(lateWake({ sleptAt: 0, wokeAt: 500 + 16_000, intervalMs: 500 })).toEqual({ lateMs: 16_000 });
  });

  it('a rest 2 s late at a 500 ms interval logs nothing and leaves the clocks alone', async () => {
    let clock = +T0;
    const now = () => clock;
    const sleep = async (ms) => {
      clock += ms + 2000;
    };
    const event = vi.fn();
    const progress = { woke: vi.fn() };
    const fake = { refresh: vi.fn(async () => {}), hold: () => null };
    const r = await loopRest({ intervalMs: 500, sleep, jira: fake, event, wait: () => Promise.resolve(), progress, now });
    expect(r).toBeNull();
    expect(event).not.toHaveBeenCalled();
    expect(progress.woke).not.toHaveBeenCalled();
    expect(fake.refresh).not.toHaveBeenCalled();
  });
});

describe('lateWakeText', () => {
  it('names the lateness and both causes', () => {
    expect(lateWakeText(20_000)).toBe('The supervisor woke 20 s late: its event loop was held or the computer slept.');
    expect(lateWakeText(552_000)).toContain('9 min 12 s');
    expect(lateWakeText(20_000, null)).toBe('The supervisor woke 20 s late: its event loop was held or the computer slept.');
  });

  it('names the command that held the loop, and for how long, when one was recorded', () => {
    expect(lateWakeText(480_000, { command: 'npm test', ms: 480_000 })).toBe('The supervisor woke 8 min 0 s late: `npm test` held its event loop for 8 min 0 s.');
    expect(lateWakeText(20_000, { command: 'gh pr list', ms: 25_000 })).toBe('The supervisor woke 20 s late: `gh pr list` held its event loop for 25 s.');
  });
});

describe('checkWake with a recorded hold', () => {
  const EIGHT_MIN = 8 * 60_000;

  it('logs the command that held the loop as one warn event', async () => {
    const event = vi.fn();
    const held = vi.fn(() => ({ command: 'npm test', ms: EIGHT_MIN }));
    const sleptAt = +T0;
    const wokeAt = +T0 + 5000 + EIGHT_MIN;
    const fake = { refresh: async () => {}, hold: () => null };
    await checkWake({ sleptAt, wokeAt, intervalMs: 5000, jira: fake, event, wait: () => Promise.resolve(), held });
    expect(held).toHaveBeenCalledWith(sleptAt, wokeAt);
    expect(event).toHaveBeenCalledTimes(1);
    expect(event).toHaveBeenCalledWith('The supervisor woke 8 min 0 s late: `npm test` held its event loop for 8 min 0 s.', 'warn');
  });

  it('keeps the old words when nothing was recorded, and asks nothing on time', async () => {
    const event = vi.fn();
    const held = vi.fn(() => null);
    await checkWake({ sleptAt: +T0, wokeAt: +T0 + TEN_MIN, intervalMs: 5000, jira: null, event, held });
    expect(event).toHaveBeenCalledWith('The supervisor woke 9 min 55 s late: its event loop was held or the computer slept.', 'warn');
    const onTime = vi.fn(() => ({ command: 'npm test', ms: 1 }));
    await checkWake({ sleptAt: +T0, wokeAt: +T0 + 5000, intervalMs: 5000, jira: null, event: vi.fn(), held: onTime });
    expect(onTime).not.toHaveBeenCalled();
  });

  it('reads the process-wide record by default', async () => {
    const { clearHolds, noteHold } = await import('./loop-holds.mjs');
    clearHolds();
    try {
      noteHold({ command: 'npm test', startedAt: +T0 + 1000, endedAt: +T0 + 1000 + EIGHT_MIN });
      const event = vi.fn();
      await checkWake({ sleptAt: +T0, wokeAt: +T0 + 5000 + EIGHT_MIN, intervalMs: 5000, jira: null, event });
      expect(event).toHaveBeenCalledWith('The supervisor woke 8 min 0 s late: `npm test` held its event loop for 8 min 0 s.', 'warn');
    } finally {
      clearHolds();
    }
  });

  it('restThenCheckWake and loopRest pass held through', async () => {
    let clock = +T0;
    const now = () => clock;
    const sleep = async () => {
      clock += 5000 + EIGHT_MIN;
    };
    const held = vi.fn(() => ({ command: 'npm test', ms: EIGHT_MIN }));
    const event = vi.fn();
    const progress = { woke: vi.fn() };
    await loopRest({ intervalMs: 5000, sleep, jira: null, event, progress, now, held });
    expect(held).toHaveBeenCalledWith(+T0, +T0 + 5000 + EIGHT_MIN);
    expect(event).toHaveBeenCalledWith('The supervisor woke 8 min 0 s late: `npm test` held its event loop for 8 min 0 s.', 'warn');
    expect(progress.woke).toHaveBeenCalledTimes(1);

    clock = +T0;
    const direct = vi.fn(() => null);
    await restThenCheckWake({ intervalMs: 5000, sleep, jira: null, event: vi.fn(), now, held: direct });
    expect(direct).toHaveBeenCalledTimes(1);
  });
});

describe('checkWake', () => {
  it('a late wake logs exactly one warn event naming the lateness', async () => {
    const event = vi.fn();
    const fake = { refresh: async () => {}, hold: () => null };
    const r = await checkWake({ sleptAt: +T0, wokeAt: +T0 + TEN_MIN, intervalMs: 5000, jira: fake, event, wait: () => Promise.resolve() });
    expect(event).toHaveBeenCalledTimes(1);
    expect(event).toHaveBeenCalledWith(expect.stringMatching(/woke 9 min 55 s late: its event loop was held or the computer slept/), 'warn');
    expect(r).toEqual({ lateMs: TEN_MIN - 5000, hold: null });
  });

  it('an on-time wake does nothing, even with a stale cache', async () => {
    const event = vi.fn();
    const refresh = vi.fn(async () => {});
    const fake = { refresh, hold: () => ({ reason: 'Jira not reachable since 12:00: no fresh answer' }) };
    const r = await checkWake({ sleptAt: +T0, wokeAt: +T0 + 5000, intervalMs: 5000, jira: fake, event, wait: () => Promise.resolve() });
    expect(r).toBeNull();
    expect(event).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('a late wake with a stale cache polls Jira again, and picking does not pause when Jira answers', async () => {
    const { refresher, t } = setup();
    await refresher.refresh();
    t.clock = new Date(+T0 + TEN_MIN);
    // The false pause the sleep showed before this check.
    expect(refresher.hold().reason).toMatch(/no fresh answer; picking paused/);
    const before = await searches();
    const event = vi.fn();
    const r = await checkWake({ sleptAt: +T0, wokeAt: +t.clock, intervalMs: 5000, jira: refresher, event });
    expect(await searches()).toBeGreaterThan(before);
    expect(r.hold).toBeNull();
    expect(refresher.hold()).toBeNull();
    expect(event).toHaveBeenCalledTimes(1);
  });

  it('a real outage still pauses picking with the reason', async () => {
    const { refresher, t } = setup();
    await refresher.refresh();
    t.clock = new Date(+T0 + TEN_MIN);
    jira.setDown(500);
    try {
      const event = vi.fn();
      const r = await checkWake({ sleptAt: +T0, wokeAt: +t.clock, intervalMs: 5000, jira: refresher, event });
      const reason = /^Jira not reachable since .*; picking paused, stories in progress carry on$/;
      expect(r.hold.reason).toMatch(reason);
      expect(refresher.hold().reason).toMatch(reason);
      expect(event).toHaveBeenCalledTimes(1);
      expect(event.mock.calls[0][1]).toBe('warn');
    } finally {
      jira.setDown(false);
    }
  });

  it('with no Jira still logs the late wake', async () => {
    const event = vi.fn();
    const r = await checkWake({ sleptAt: +T0, wokeAt: +T0 + TEN_MIN, intervalMs: 5000, jira: null, event });
    expect(event).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ lateMs: TEN_MIN - 5000, hold: null });
  });
});

describe('refreshAfterWake', () => {
  it('polls once more when the first poll leaves picking held', async () => {
    let held = true;
    const refresh = vi.fn(async () => {
      if (refresh.mock.calls.length >= 2) held = false;
    });
    const fake = { refresh, hold: () => (held ? { reason: 'stale' } : null) };
    expect(await refreshAfterWake(fake, { wait: () => new Promise(() => {}) })).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('polls once when the first poll clears the hold', async () => {
    let held = true;
    const refresh = vi.fn(async () => {
      held = false;
    });
    const fake = { refresh, hold: () => (held ? { reason: 'stale' } : null) };
    expect(await refreshAfterWake(fake, { wait: () => new Promise(() => {}) })).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('never hangs on a poll that never ends', async () => {
    const fake = { refresh: () => new Promise(() => {}), hold: () => ({ reason: 'x' }) };
    expect(await refreshAfterWake(fake, { wait: () => Promise.resolve() })).toEqual({ reason: 'x' });
  });

  it('is null with no Jira', async () => {
    expect(await refreshAfterWake(null)).toBeNull();
  });
});

describe('restThenCheckWake', () => {
  it('reads sleptAt before the sleep and wokeAt after it', async () => {
    let clock = +T0;
    const now = () => clock;
    const sleep = vi.fn(async () => {
      clock += TEN_MIN;
    });
    const event = vi.fn();
    const fake = { refresh: async () => {}, hold: () => null };
    const r = await restThenCheckWake({ intervalMs: 5000, sleep, jira: fake, event, now });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(5000);
    expect(r).toEqual({ lateMs: TEN_MIN - 5000, hold: null });
    expect(event).toHaveBeenCalledTimes(1);
    expect(event).toHaveBeenCalledWith(expect.stringMatching(/woke 9 min 55 s late/), 'warn');
  });

  it('does nothing after an on-time rest', async () => {
    let clock = +T0;
    const now = () => clock;
    const sleep = vi.fn(async (ms) => {
      clock += ms;
    });
    const event = vi.fn();
    const fake = { refresh: vi.fn(async () => {}), hold: () => null };
    const r = await restThenCheckWake({ intervalMs: 5000, sleep, jira: fake, event, now });
    expect(r).toBeNull();
    expect(event).not.toHaveBeenCalled();
    expect(fake.refresh).not.toHaveBeenCalled();
  });

  it('passes jira, wait and limitMs through to the check', async () => {
    let clock = +T0;
    const now = () => clock;
    const sleep = async () => {
      clock += TEN_MIN;
    };
    const fake = { refresh: () => new Promise(() => {}), hold: () => ({ reason: 'stale' }) };
    const wait = vi.fn(() => Promise.resolve());
    const r = await restThenCheckWake({ intervalMs: 5000, sleep, jira: fake, event: vi.fn(), wait, limitMs: 1234, now });
    expect(r.hold).toEqual({ reason: 'stale' });
    expect(wait).toHaveBeenCalledWith(1234);
  });

  it('logs a throwing check as a warn event and gives null, so the loop carries on', async () => {
    let clock = +T0;
    const now = () => clock;
    const sleep = async () => {
      clock += TEN_MIN;
    };
    const event = vi.fn();
    const fake = { refresh: () => Promise.reject(new Error('boom')), hold: () => null };
    await expect(restThenCheckWake({ intervalMs: 5000, sleep, jira: fake, event, now })).resolves.toBeNull();
    expect(event).toHaveBeenLastCalledWith('Supervisor error: boom', 'warn');
  });

  it('cuts the logged error message to 200 characters', async () => {
    let clock = +T0;
    const now = () => clock;
    const sleep = async () => {
      clock += TEN_MIN;
    };
    const event = vi.fn();
    const fake = { refresh: () => Promise.reject(new Error('x'.repeat(300))), hold: () => null };
    expect(await restThenCheckWake({ intervalMs: 5000, sleep, jira: fake, event, now })).toBeNull();
    expect(event).toHaveBeenLastCalledWith(`Supervisor error: ${'x'.repeat(200)}`, 'warn');
  });

  it('reads the wall clock by default', async () => {
    const spy = vi.spyOn(Date, 'now').mockReturnValueOnce(+T0).mockReturnValueOnce(+T0 + TEN_MIN);
    try {
      const r = await restThenCheckWake({ intervalMs: 5000, sleep: async () => {}, jira: null, event: vi.fn() });
      expect(r).toEqual({ lateMs: TEN_MIN - 5000, hold: null });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('loopRest', () => {
  it('a late wake restarts the progress clocks at the wall clock after the check', async () => {
    let clock = +T0;
    const now = () => clock;
    const sleep = async () => {
      clock += TEN_MIN;
    };
    const event = vi.fn();
    const progress = { woke: vi.fn() };
    const fake = {
      refresh: async () => {
        clock += 1000;
      },
      hold: () => null,
    };
    const r = await loopRest({ intervalMs: 5000, sleep, jira: fake, event, wait: () => Promise.resolve(), progress, now });
    expect(r).toEqual({ lateMs: TEN_MIN - 5000, hold: null });
    expect(progress.woke).toHaveBeenCalledTimes(1);
    expect(progress.woke).toHaveBeenCalledWith(+T0 + TEN_MIN + 1000);
    expect(event).toHaveBeenCalledTimes(1);
    expect(event).toHaveBeenCalledWith(expect.stringMatching(/woke 9 min 55 s late/), 'warn');
  });

  it('an on-time rest leaves the clocks alone', async () => {
    let clock = +T0;
    const now = () => clock;
    const sleep = async (ms) => {
      clock += ms;
    };
    const progress = { woke: vi.fn() };
    const fake = { refresh: async () => {}, hold: () => null };
    const r = await loopRest({ intervalMs: 5000, sleep, jira: fake, event: vi.fn(), progress, now });
    expect(r).toBeNull();
    expect(progress.woke).not.toHaveBeenCalled();
  });

  it('a throwing check gives null and does not restart the clocks', async () => {
    let clock = +T0;
    const now = () => clock;
    const sleep = async () => {
      clock += TEN_MIN;
    };
    const event = vi.fn();
    const progress = { woke: vi.fn() };
    const fake = { refresh: () => Promise.reject(new Error('boom')), hold: () => null };
    const r = await loopRest({ intervalMs: 5000, sleep, jira: fake, event, wait: () => new Promise(() => {}), progress, now });
    expect(r).toBeNull();
    expect(event).toHaveBeenLastCalledWith('Supervisor error: boom', 'warn');
    expect(progress.woke).not.toHaveBeenCalled();
  });

  it('with the real progress watch, a sleep through an error limit raises nothing', async () => {
    let clock = +T0;
    const now = () => clock;
    const sleep = async () => {
      clock += 30 * 60_000;
    };
    const limits = stuckLimits({});
    const watch = progressWatch();
    watch.loop({ now: now(), error: 'boom', starved: undefined, sessions: [] }, limits);
    const fake = { refresh: async () => {}, hold: () => null };
    await loopRest({ intervalMs: 5000, sleep, jira: fake, event: vi.fn(), wait: () => Promise.resolve(), progress: watch, now });
    const r = watch.loop({ now: now(), error: 'boom', starved: undefined, sessions: [] }, limits);
    expect(r.stuck).toBeNull();
  });

  it('the supervisor rests through loopRest with its progress watch', () => {
    const src = fs.readFileSync(new URL('./supervisor.mjs', import.meta.url), 'utf8');
    expect(src).toContain('await loopRest({ intervalMs: TICK_MS, sleep, jira, event, wait: sleep, progress })');
    expect(src).not.toContain('restThenCheckWake(');
  });
});
