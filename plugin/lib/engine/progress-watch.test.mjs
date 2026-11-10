import { describe, expect, it } from 'vitest';
import { progressWatch, slowText, STUCK_MINUTES, stuckLimits, stuckTitle } from './progress-watch.mjs';

const MIN = 60_000;
const TICK = 5000;
const LIMITS = stuckLimits({});
const T0 = new Date(2026, 9, 25, 9, 0).getTime();
const hhmm = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// Feeds one loop every 5 s from `from` up to and including `to`; returns each loop's answer with its time.
function run(watch, from, to, input) {
  const out = [];
  for (let now = from; now <= to; now += TICK) out.push({ now, ...watch.loop({ now, error: null, starved: null, sessions: [], ...input(now) }, LIMITS) });
  return out;
}

describe('the limits and the title', () => {
  it('reads watchdog.* with the story defaults', () => {
    expect(STUCK_MINUTES).toEqual({ idleMinutes: 10, errorMinutes: 5, progressMinutes: 45, activityMinutes: 20 });
    expect(stuckLimits({})).toEqual({ idleMs: 10 * MIN, errorMs: 5 * MIN, progressMs: 45 * MIN, activityMs: 20 * MIN });
    expect(stuckLimits(undefined)).toEqual({ idleMs: 10 * MIN, errorMs: 5 * MIN, progressMs: 45 * MIN, activityMs: 20 * MIN });
    expect(stuckLimits({ watchdog: { errorMinutes: 0.05 } }).errorMs).toBe(3000);
    expect(stuckLimits({ watchdog: { activityMinutes: 0.1 } }).activityMs).toBe(6000);
    expect(stuckLimits({ watchdog: { idleMinutes: 2, progressMinutes: 60 } })).toEqual({ idleMs: 2 * MIN, errorMs: 5 * MIN, progressMs: 60 * MIN, activityMs: 20 * MIN });
  });

  it('says how long, in words', () => {
    expect(stuckTitle(T0, T0 + 30_000)).toBe('Not building for less than a minute');
    expect(stuckTitle(new Date(T0).toISOString(), T0 + 90_000)).toBe('Not building for 1 minute');
    expect(stuckTitle(T0, new Date(T0 + 12 * MIN + 59_000))).toBe('Not building for 12 minutes');
    expect(stuckTitle(T0, T0 + 119 * MIN)).toBe('Not building for 119 minutes');
    expect(stuckTitle(T0, T0 + 150 * MIN)).toBe('Not building for 2 hours');
    expect(stuckTitle('not a date', T0)).toBe('Not building for less than a minute');
  });
});

describe('the same loop error', () => {
  it('raises once, at the first loop past the limit, and never again while it repeats', () => {
    const watch = progressWatch();
    const loops = run(watch, T0, T0 + 8 * MIN, () => ({ error: 'ENOENT: no such file', starved: undefined }));
    const fresh = loops.filter((l) => l.fresh);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].now).toBe(T0 + LIMITS.errorMs);
    expect(fresh[0].stuck).toEqual({ kind: 'error', since: new Date(T0).toISOString(), reason: 'the supervisor fails every loop: ENOENT: no such file' });
    expect(loops.filter((l) => l.changed)).toHaveLength(1);
    for (const l of loops.filter((x) => x.now > fresh[0].now)) expect(l).toMatchObject({ fresh: false, changed: false, cleared: false });
    for (const l of loops.filter((x) => x.now < fresh[0].now)) expect(l).toMatchObject({ stuck: null, fresh: false, changed: false });
  });

  it('clears on the first clean loop', () => {
    const watch = progressWatch();
    run(watch, T0, T0 + 6 * MIN, () => ({ error: 'boom', starved: undefined }));
    const r = watch.loop({ now: T0 + 6 * MIN + TICK, error: null, starved: null, sessions: [] }, LIMITS);
    expect(r).toEqual({ stuck: null, changed: true, fresh: false, cleared: true, slow: [], slowChanged: false });
  });

  it('a different text restarts the clock', () => {
    const watch = progressWatch();
    run(watch, T0, T0 + 4 * MIN, () => ({ error: 'first', starved: undefined }));
    const loops = run(watch, T0 + 4 * MIN + TICK, T0 + 12 * MIN, () => ({ error: 'second', starved: undefined }));
    const fresh = loops.filter((l) => l.fresh);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].now).toBe(T0 + 4 * MIN + TICK + LIMITS.errorMs);
  });

  it('an error whose digits change every loop still raises once', () => {
    const watch = progressWatch();
    const loops = run(watch, T0, T0 + 8 * MIN, (now) => ({ error: `Timeout after ${now - T0} ms (attempt ${(now - T0) / TICK})`, starved: undefined }));
    const fresh = loops.filter((l) => l.fresh);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].now).toBe(T0 + LIMITS.errorMs);
    expect(fresh[0].stuck).toEqual({ kind: 'error', since: new Date(T0).toISOString(), reason: 'the supervisor fails every loop: Timeout after 0 ms (attempt 0)' });
    expect(loops.filter((l) => l.changed)).toHaveLength(1);
    expect(loops.filter((l) => l.cleared)).toHaveLength(0);
  });

  it('texts that differ only in digits do not flap after the alert', () => {
    const watch = progressWatch();
    const loops = run(watch, T0, T0 + 10 * MIN, (now) => ({ error: ((now - T0) / TICK) % 2 ? 'lock held by pid 4567' : 'lock held by pid 123', starved: undefined }));
    expect(loops.filter((l) => l.fresh)).toHaveLength(1);
    expect(loops.filter((l) => l.cleared)).toHaveLength(0);
    expect(loops.filter((l) => l.changed)).toHaveLength(1);
  });

  it('a text that differs in more than its digits still restarts the clock', () => {
    const watch = progressWatch();
    run(watch, T0, T0 + 4 * MIN, () => ({ error: 'ENOENT 3', starved: undefined }));
    const loops = run(watch, T0 + 4 * MIN + TICK, T0 + 12 * MIN, () => ({ error: 'EACCES 3', starved: undefined }));
    const fresh = loops.filter((l) => l.fresh);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].now).toBe(T0 + 4 * MIN + TICK + LIMITS.errorMs);
  });
});

describe('buildable work, a free slot and nothing started', () => {
  const REASON = 'ACME-3 can be built and a slot is free, but nothing has started';

  it('raises once after the idle limit', () => {
    const watch = progressWatch();
    const loops = run(watch, T0, T0 + 15 * MIN, () => ({ starved: 'ACME-3' }));
    const fresh = loops.filter((l) => l.fresh);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].now).toBe(T0 + LIMITS.idleMs);
    expect(fresh[0].stuck).toEqual({ kind: 'idle', since: new Date(T0).toISOString(), reason: REASON });
    expect(loops.filter((l) => l.changed)).toHaveLength(1);
  });

  it('clears when a loop is not starved', () => {
    const watch = progressWatch();
    run(watch, T0, T0 + 11 * MIN, () => ({ starved: 'ACME-3' }));
    expect(watch.loop({ now: T0 + 11 * MIN + TICK, error: null, starved: null, sessions: [] }, LIMITS)).toMatchObject({ stuck: null, cleared: true });
  });

  it('a throwing loop (starved unknown) neither starts nor clears the idle clock', () => {
    const watch = progressWatch();
    // Nothing starts the clock while every loop throws: no idle item even after the idle limit.
    const throwing = run(watch, T0, T0 + 4 * MIN, () => ({ error: 'e1', starved: undefined }));
    expect(throwing.every((l) => l.stuck === null)).toBe(true);
    // Starved from here; a throwing loop in the middle leaves the clock running.
    const t1 = T0 + 4 * MIN + TICK;
    run(watch, t1, t1 + 5 * MIN, () => ({ starved: 'ACME-3' }));
    const mid = watch.loop({ now: t1 + 5 * MIN + TICK, error: 'once', starved: undefined, sessions: [] }, LIMITS);
    expect(mid.stuck).toBeNull();
    const loops = run(watch, t1 + 5 * MIN + 2 * TICK, t1 + 11 * MIN, () => ({ starved: 'ACME-3' }));
    const fresh = loops.filter((l) => l.fresh);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].now).toBe(t1 + LIMITS.idleMs);
    expect(fresh[0].stuck.since).toBe(new Date(t1).toISOString());
  });
});

describe('a session with no activity', () => {
  it('raises once when the oldest progress passes the limit, naming the story and the slot (no activeAt: progress counts)', () => {
    const watch = progressWatch();
    const sessions = [
      { slot: 'w1', id: 'ACME-1', progressAt: T0 + 30 * MIN },
      { slot: 'w2', id: 'ACME-2', progressAt: T0 },
    ];
    const loops = run(watch, T0, T0 + 50 * MIN, () => ({ sessions }));
    const fresh = loops.filter((l) => l.fresh);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].now).toBe(T0 + LIMITS.activityMs);
    expect(fresh[0].stuck).toEqual({ kind: 'story', since: new Date(T0).toISOString(), reason: `ACME-2 in w2 has shown no activity since ${hhmm(T0)} (no stage change, log output or CPU)` });
    expect(loops.filter((l) => l.changed)).toHaveLength(1);
  });

  it('is stuck after 20 minutes of silence: one fresh, one change, never slow', () => {
    const watch = progressWatch();
    const sessions = [{ slot: 'w1', id: 'ACME-1', progressAt: T0, activeAt: T0, stage: 'build', rounds: 0, steps: 3 }];
    const loops = run(watch, T0, T0 + 60 * MIN, () => ({ sessions }));
    const fresh = loops.filter((l) => l.fresh);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].now).toBe(T0 + 20 * MIN);
    expect(fresh[0].stuck).toEqual({ kind: 'story', since: new Date(T0).toISOString(), reason: `ACME-1 in w1 has shown no activity since ${hhmm(T0)} (no stage change, log output or CPU)` });
    expect(loops.filter((l) => l.changed)).toHaveLength(1);
    expect(loops.every((l) => Array.isArray(l.slow) && l.slow.length === 0 && !l.slowChanged)).toBe(true);

    // Activity again: the stuck clears.
    const now = T0 + 60 * MIN + TICK;
    expect(watch.loop({ now, error: null, starved: null, sessions: [{ ...sessions[0], activeAt: now }] }, LIMITS)).toMatchObject({ stuck: null, cleared: true });
  });

  it('clears on newer progress, or when the session leaves', () => {
    const watch = progressWatch();
    run(watch, T0, T0 + 46 * MIN, () => ({ sessions: [{ slot: 'w1', id: 'ACME-2', progressAt: T0 }] }));
    const now = T0 + 46 * MIN + TICK;
    expect(watch.loop({ now, error: null, starved: null, sessions: [{ slot: 'w1', id: 'ACME-2', progressAt: now }] }, LIMITS)).toMatchObject({ stuck: null, cleared: true });

    const other = progressWatch();
    run(other, T0, T0 + 46 * MIN, () => ({ sessions: [{ slot: 'w1', id: 'ACME-2', progressAt: T0 }] }));
    expect(other.loop({ now, error: null, starved: null, sessions: [] }, LIMITS)).toMatchObject({ stuck: null, cleared: true });
  });
});

describe('a long stage with activity', () => {
  const at5 = (now) => T0 + Math.floor((now - T0) / (5 * MIN)) * 5 * MIN;
  const session = (now) => ({ slot: 'w3', id: 'ACME-1', progressAt: T0, activeAt: at5(now), stage: 'build', rounds: 1, steps: 129 });

  it('is slow from the progress limit, never stuck, and says so once', () => {
    const watch = progressWatch();
    const loops = run(watch, T0, T0 + 60 * MIN, (now) => ({ sessions: [session(now)] }));
    for (const l of loops) expect(l).toMatchObject({ stuck: null, fresh: false, changed: false, cleared: false });
    const entry = { slot: 'w3', id: 'ACME-1', since: new Date(T0).toISOString(), stage: 'build', rounds: 1, steps: 129 };
    for (const l of loops.filter((x) => x.now >= T0 + 45 * MIN)) expect(l.slow).toEqual([entry]);
    for (const l of loops.filter((x) => x.now < T0 + 45 * MIN)) expect(l.slow).toEqual([]);
    expect(loops.filter((l) => l.slowChanged).map((l) => l.now)).toEqual([T0 + 45 * MIN]);
  });

  it('lists every slow session by since, then slot', () => {
    const watch = progressWatch();
    const now = T0 + 90 * MIN;
    const r = watch.loop({ now, error: null, starved: null, sessions: [
      { slot: 'w2', id: 'ACME-2', progressAt: T0 + 10 * MIN, activeAt: now },
      { slot: 'w3', id: 'ACME-3', progressAt: T0, activeAt: now },
      { slot: 'w1', id: 'ACME-1', progressAt: T0, activeAt: now },
      { slot: 'w4', id: 'ACME-4', progressAt: now - 10 * MIN, activeAt: now },
    ] }, LIMITS);
    expect(r.slow.map((e) => e.slot)).toEqual(['w1', 'w3', 'w2']);
    expect(r.slow[0]).toEqual({ slot: 'w1', id: 'ACME-1', since: new Date(T0).toISOString(), stage: null, rounds: 0, steps: 0 });
    expect(r.slowChanged).toBe(true);
    expect(r.stuck).toBeNull();
  });

  it('a late wake restarts the slow since at the wake', () => {
    const watch = progressWatch();
    run(watch, T0, T0 + 50 * MIN, (now) => ({ sessions: [session(now)] }));
    const woke = T0 + 120 * MIN;
    watch.woke(woke);
    const loops = run(watch, woke, woke + 50 * MIN, (now) => ({ sessions: [{ ...session(now), activeAt: now }] }));
    for (const l of loops.filter((x) => x.now < woke + 45 * MIN)) expect(l.slow).toEqual([]);
    for (const l of loops.filter((x) => x.now >= woke + 45 * MIN)) expect(l.slow[0].since).toBe(new Date(woke).toISOString());
    expect(loops.every((l) => l.stuck === null)).toBe(true);
  });
});

describe('slowText', () => {
  const since = new Date(T0).toISOString();
  const entry = { slot: 'w3', id: 'ACME-1', since, stage: 'build', rounds: 1, steps: 129 };

  it('names the story, its stage, how long and its steps', () => {
    expect(slowText(entry, T0 + 105 * MIN)).toBe('slow: ACME-1 in its fix round for 1 h 45 min (129 steps)');
    expect(slowText({ ...entry, rounds: 0 }, T0 + 105 * MIN)).toBe('slow: ACME-1 in its build for 1 h 45 min (129 steps)');
    expect(slowText({ ...entry, steps: 0 }, T0 + 46 * MIN)).toBe('slow: ACME-1 in its fix round for 46 min');
    expect(slowText({ ...entry, steps: 1 }, T0 + 46 * MIN)).toBe('slow: ACME-1 in its fix round for 46 min (1 step)');
    expect(slowText({ ...entry, stage: 'deploy' }, T0 + 46 * MIN)).toBe('slow: ACME-1 in its deploy stage for 46 min (129 steps)');
    expect(slowText({ ...entry, stage: null }, T0 + 46 * MIN)).toBe('slow: ACME-1 in its session for 46 min (129 steps)');
    expect(slowText({ ...entry, stage: undefined }, new Date(T0 + 30_000))).toBe('slow: ACME-1 in its session for <1 min (129 steps)');
  });

  it('has a phrase for each stage', () => {
    const phrase = (stage, rounds = 0) => slowText({ ...entry, stage, rounds, steps: 0 }, T0 + 46 * MIN).replace(/^slow: ACME-1 in (.*) for 46 min$/, '$1');
    expect(phrase('architect')).toBe('its design');
    expect(phrase('test')).toBe('its tests');
    expect(phrase('review')).toBe('review');
    expect(phrase('commit')).toBe('its commit');
    expect(phrase('release')).toBe('its release');
    expect(phrase('starting')).toBe('its start');
  });
});

describe('together', () => {
  it('raises nothing under each limit', () => {
    const watch = progressWatch();
    const loops = [
      ...run(watch, T0, T0 + LIMITS.errorMs - TICK, () => ({ error: 'boom', starved: undefined })),
    ];
    const idle = progressWatch();
    loops.push(...run(idle, T0, T0 + LIMITS.idleMs - TICK, () => ({ starved: 'ACME-3' })));
    const story = progressWatch();
    loops.push(...run(story, T0, T0 + LIMITS.activityMs - TICK, () => ({ sessions: [{ slot: 'w1', id: 'ACME-2', progressAt: T0 }] })));
    expect(loops.every((l) => l.stuck === null && !l.fresh && !l.changed)).toBe(true);
  });

  it('error beats idle beats story; switching kind is a change, not a second alert', () => {
    const watch = progressWatch();
    const sessions = [{ slot: 'w1', id: 'ACME-2', progressAt: T0 }];
    // Story first: past 20 minutes of no activity with nothing else.
    const story = run(watch, T0, T0 + 46 * MIN, () => ({ sessions }));
    expect(story.filter((l) => l.fresh)).toHaveLength(1);
    expect(story.at(-1).stuck.kind).toBe('story');
    // Starved from here: idle takes over once it passes its own limit.
    const t1 = T0 + 46 * MIN + TICK;
    const idle = run(watch, t1, t1 + 11 * MIN, () => ({ starved: 'ACME-3', sessions }));
    expect(idle.filter((l) => l.fresh)).toHaveLength(0);
    const switched = idle.filter((l) => l.changed);
    expect(switched).toHaveLength(1);
    expect(switched[0]).toMatchObject({ now: t1 + LIMITS.idleMs, fresh: false, cleared: false, stuck: { kind: 'idle' } });
    // Every loop fails from here: error wins once it passes its limit.
    const t2 = t1 + 11 * MIN + TICK;
    const error = run(watch, t2, t2 + 6 * MIN, () => ({ error: 'boom', starved: undefined, sessions }));
    expect(error.filter((l) => l.fresh)).toHaveLength(0);
    expect(error.filter((l) => l.changed)).toHaveLength(1);
    expect(error.at(-1).stuck.kind).toBe('error');
  });

  it('a late wake restarts every clock at the wake', () => {
    const watch = progressWatch();
    const sessions = [{ slot: 'w1', id: 'ACME-2', progressAt: T0 }];
    run(watch, T0, T0 + 4 * MIN, () => ({ starved: 'ACME-3', sessions }));
    // The computer slept for an hour: every limit has passed by the first loop after it.
    const woke = T0 + 64 * MIN;
    watch.woke(woke);
    const after = run(watch, woke, woke + 9 * MIN, () => ({ starved: 'ACME-3', sessions }));
    expect(after.every((l) => l.stuck === null)).toBe(true);
    const later = run(watch, woke + 9 * MIN + TICK, woke + 11 * MIN, () => ({ starved: 'ACME-3', sessions }));
    const fresh = later.filter((l) => l.fresh);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ now: woke + LIMITS.idleMs, stuck: { kind: 'idle', since: new Date(woke).toISOString() } });
  });

  it('a wake during an episode clears it until a limit passes again', () => {
    const watch = progressWatch();
    run(watch, T0, T0 + 6 * MIN, () => ({ error: 'boom', starved: undefined }));
    const woke = T0 + 30 * MIN;
    watch.woke(woke);
    expect(watch.loop({ now: woke, error: 'boom', starved: undefined, sessions: [] }, LIMITS)).toMatchObject({ stuck: null, cleared: true });
    const loops = run(watch, woke + TICK, woke + 6 * MIN, () => ({ error: 'boom', starved: undefined }));
    expect(loops.filter((l) => l.fresh).map((l) => l.now)).toEqual([woke + LIMITS.errorMs]);
  });
});
