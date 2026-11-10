// Telling a sleeping computer from a Jira outage. The supervisor's loop sleeps TICK_MS between
// ticks; when it wakes far later than that, the computer slept (a Mac with its lid closed) or
// the event loop was held. Either way the Jira cache looks stale only because nothing polled,
// so the loop asks the refresher for a fresh answer before the next tick judges the cache:
//
//   await loopRest({ intervalMs: TICK_MS, sleep, jira, event, wait: sleep, progress });
//
// loopRest() is restThenCheckWake() plus, after a late wake, progress.woke(): it restarts the
// progress watchdog's clocks, so the sleep alone is not a stall.
//
// The tick itself is tickMs(process.env.FOREMAN_TICK_MS): DEFAULT_TICK_MS (5 s) unless the
// variable shortens it. FOREMAN_TICK_MS is for tests, so the supervisor tests do not wait on a
// real 5 s tick; it can only shorten the tick, to 50 ms at the least, never lengthen it.
//
// lateWake() says whether a wake is late (more than LATE_FACTOR x the interval past it, and never
// less than LATE_FACTOR x DEFAULT_TICK_MS, 15 s, so a short test tick held for a moment by a busy
// machine is not a sleep; at the default tick the two are the same), and
// checkWake() then logs one warn event and polls Jira (refreshAfterWake), at most twice and
// never for longer than limitMs each. A real outage still fails the poll, so the refresher's
// hold() still pauses picking with its reason. Times are wall-clock epoch ms (Date.now()): on
// macOS the monotonic clock stops while the machine sleeps, which would hide the sleep.
//
// The warn event names what held the loop when something did: `held(sleptAt, wokeAt)` gives the
// longest synchronous child recorded over the rest (loop-holds.mjs holdDuring, the process-wide
// record heldSpawnSync keeps), and the text then says "`npm test` held its event loop for 8 min
// 0 s." instead of "its event loop was held or the computer slept." restThenCheckWake and
// loopRest pass `held` through; tests give their own.

import { holdDuring } from './loop-holds.mjs';

export const LATE_FACTOR = 3;
// The same cap main() puts on the first Jira answer.
export const WAKE_POLL_LIMIT_MS = 30_000;
// The supervisor's tick when FOREMAN_TICK_MS does not shorten it.
export const DEFAULT_TICK_MS = 5000;
const MIN_TICK_MS = 50;

// The tick in ms from FOREMAN_TICK_MS's value: DEFAULT_TICK_MS unless it is a positive integer,
// which is capped at DEFAULT_TICK_MS and raised to MIN_TICK_MS.
export function tickMs(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return DEFAULT_TICK_MS;
  return Math.max(MIN_TICK_MS, Math.min(DEFAULT_TICK_MS, Number(value)));
}

// { lateMs } when the loop woke more than factor x intervalMs past its interval, and more than
// LATE_FACTOR x DEFAULT_TICK_MS (15 s), else null.
export function lateWake({ sleptAt, wokeAt, intervalMs, factor = LATE_FACTOR }) {
  const lateMs = wokeAt - sleptAt - intervalMs;
  return lateMs > Math.max(factor * intervalMs, LATE_FACTOR * DEFAULT_TICK_MS) ? { lateMs } : null;
}

const duration = (ms) => {
  const s = Math.floor(ms / 1000);
  return s < 90 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};

// With `hold` ({ command, ms }), the command that held the loop and for how long.
export function lateWakeText(lateMs, hold = null) {
  if (hold) return `The supervisor woke ${duration(lateMs)} late: \`${hold.command}\` held its event loop for ${duration(hold.ms)}.`;
  return `The supervisor woke ${duration(lateMs)} late: its event loop was held or the computer slept.`;
}

const timeout = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

// Polls Jira and gives the refresher's hold() after it: null when picking may go on. One retry
// when the first poll leaves picking held, for a poll still in flight from before the sleep
// (refresh() would hand that one back) or a network not back yet. Null when there is no Jira.
export async function refreshAfterWake(jira, { wait = timeout, limitMs = WAKE_POLL_LIMIT_MS } = {}) {
  if (!jira) return null;
  const poll = () => Promise.race([jira.refresh(), wait(limitMs)]);
  await poll();
  if (jira.hold()) await poll();
  return jira.hold();
}

// Null when the loop woke on time. After a late wake: one warn event (naming what held the loop,
// from held(sleptAt, wokeAt), when anything did), a fresh Jira poll, and { lateMs, hold } with
// the refresher's hold() after it.
export async function checkWake({ sleptAt, wokeAt, intervalMs, jira, event, wait, limitMs, held = holdDuring }) {
  const late = lateWake({ sleptAt, wokeAt, intervalMs });
  if (!late) return null;
  event(lateWakeText(late.lateMs, held(sleptAt, wokeAt)), 'warn');
  return { lateMs: late.lateMs, hold: await refreshAfterWake(jira, { wait, limitMs }) };
}

// One rest of the supervisor's loop: sleep intervalMs, then checkWake. sleptAt is read just
// before the sleep and wokeAt just after it, both from now() (wall clock, see above). A throw
// from the check is logged as a warn 'Supervisor error: …' event and gives null, so the loop
// carries on.
export async function restThenCheckWake({ intervalMs, sleep, jira, event, wait, limitMs, held, now = Date.now }) {
  const sleptAt = now();
  await sleep(intervalMs);
  try {
    return await checkWake({ sleptAt, wokeAt: now(), intervalMs, jira, event, wait, limitMs, ...(held ? { held } : {}) });
  } catch (err) {
    event(`Supervisor error: ${String(err.message).slice(0, 200)}`, 'warn');
    return null;
  }
}

// One rest of the supervisor's loop: restThenCheckWake, then, after a late wake, progress.woke(now())
// so every progress-watchdog clock starts again at the wake (the sleep alone is not a stall).
export async function loopRest({ progress, now = Date.now, ...rest }) {
  const wake = await restThenCheckWake({ ...rest, now });
  if (wake) progress.woke(now());
  return wake;
}
