// Whether a running factory is making progress: the supervisor's progress watchdog. Pure, fed
// once per loop. It only says so; it never stops a session (the quiet and build watchdog in
// scheduler.mjs hung() does that).
//
//   STUCK_MINUTES             the default limits: idleMinutes 10, errorMinutes 5,
//                             progressMinutes 45, activityMinutes 20
//   stuckLimits(config)       { idleMs, errorMs, progressMs, activityMs } from
//                             config.watchdog.idleMinutes, .errorMinutes, .progressMinutes and
//                             .activityMinutes, else STUCK_MINUTES
//   stuckTitle(since, now)    "Not building for less than a minute", "… 1 minute", "… N minutes"
//                             (under 120), else "… N hours", floored; `since` an ISO string or
//                             ms (an invalid one counts as `now`)
//   slowText(entry, now)      "slow: <id> in <phrase> for <dur>" plus " (<n> steps)" when it has
//                             steps (" (1 step)" for one), for one entry of loop's `slow`: the
//                             phrase from its stage and rounds ('its fix round', 'its build',
//                             'its design', 'its tests', 'review', 'its commit', 'its release',
//                             'its start', 'its <stage> stage', else 'its session'), dur as
//                             `foreman status` writes one ('<1 min', 'N min' under 90, else
//                             'H h M min')
//   progressWatch()           { loop(input, limits), woke(atMs) }
//
// loop's input, once per loop: { now (ms), error, starved, sessions }.
//   error     the loop's error text, or null when it ran clean
//   starved   a story id when a free slot could pick, found a story and nothing launched; null
//             when not; undefined when unknown (the loop threw): the idle clock is left as it is
//   sessions  [{ slot, id, progressAt (ms), activeAt (ms, optional), stage, rounds, steps }], one
//             per running session: progressAt its last stage event, activeAt its last other
//             activity (log output, a hook step, CPU); its activity time is the later of the two
//
// Three clocks: the same error text, its digits ignored, since its first loop (a text that differs
// in more than its digits restarts it, a clean loop stops it, and the reason quotes the episode's
// first text), starved since its first loop, and each session's last activity. A clock's start is
// never before the last woke(): after a late wake (the computer slept) every clock starts again,
// so the sleep alone is not a stall. The first that has run for its limit wins:
//
//   error   errorMs     "the supervisor fails every loop: <text>"
//   idle    idleMs      "<id> can be built and a slot is free, but nothing has started"
//   story   activityMs  "<id> in <slot> has shown no activity since HH:MM (no stage change, log
//                       output or CPU)" (the oldest activity, local time)
//
// loop returns { stuck, changed, fresh, cleared, slow, slowChanged }: stuck is { kind, since (ISO),
// reason } or null; fresh when it turned stuck, cleared when it stopped being stuck, changed when
// kind, since or reason differ from the last loop's. A stuck that stays the same changes nothing,
// so one episode is one save, one event and one notification, however many loops it lasts.
//
// Slow is an FYI, never stuck: every session with activity younger than activityMs whose last
// stage event is progressMs old or more (from the last woke() at the earliest). `slow` is
// [{ slot, id, since (ISO of that stage event), stage, rounds, steps }] by since, then slot;
// slowChanged when it differs from the last loop's. Slow never sets stuck, fresh, changed or
// cleared.
//
// Nothing here imports state.mjs, which runs git at import time.

export const STUCK_MINUTES = { idleMinutes: 10, errorMinutes: 5, progressMinutes: 45, activityMinutes: 20 };

const MIN = 60_000;

export function stuckLimits(config) {
  const w = config?.watchdog ?? {};
  return {
    idleMs: (w.idleMinutes ?? STUCK_MINUTES.idleMinutes) * MIN,
    errorMs: (w.errorMinutes ?? STUCK_MINUTES.errorMinutes) * MIN,
    progressMs: (w.progressMinutes ?? STUCK_MINUTES.progressMinutes) * MIN,
    activityMs: (w.activityMinutes ?? STUCK_MINUTES.activityMinutes) * MIN,
  };
}

const msOf = (t) => (typeof t === 'number' ? t : t instanceof Date ? t.getTime() : Date.parse(t));

export function stuckTitle(since, now = Date.now()) {
  const end = msOf(now);
  const start = Number.isFinite(msOf(since)) ? msOf(since) : end;
  const minutes = Math.floor(Math.max(0, end - start) / MIN);
  if (minutes < 1) return 'Not building for less than a minute';
  if (minutes === 1) return 'Not building for 1 minute';
  if (minutes < 120) return `Not building for ${minutes} minutes`;
  return `Not building for ${Math.floor(minutes / 60)} hours`;
}

// The words for where a story is, from its stage and rounds (see the header).
function stagePhrase(stage, rounds) {
  if (stage === 'build') return rounds > 0 ? 'its fix round' : 'its build';
  const named = { architect: 'its design', test: 'its tests', review: 'review', commit: 'its commit', release: 'its release', starting: 'its start' };
  if (Object.hasOwn(named, stage)) return named[stage];
  return typeof stage === 'string' && stage ? `its ${stage} stage` : 'its session';
}

// The same words as `foreman status` duration(), kept here so this file imports nothing.
function duration(minutes) {
  const m = Number(minutes) || 0;
  if (m < 1) return '<1 min';
  if (m < 90) return `${Math.round(m)} min`;
  return `${Math.floor(m / 60)} h ${Math.round(m % 60)} min`;
}

export function slowText(entry, now = Date.now()) {
  const end = msOf(now);
  const start = Number.isFinite(msOf(entry?.since)) ? msOf(entry.since) : end;
  const steps = Number(entry?.steps) || 0;
  const count = steps > 0 ? ` (${steps} ${steps === 1 ? 'step' : 'steps'})` : '';
  return `slow: ${entry?.id} in ${stagePhrase(entry?.stage, Number(entry?.rounds) || 0)} for ${duration(Math.max(0, end - start) / MIN)}${count}`;
}

// An error's text with its digits ignored, so a counter, pid or timestamp in it does not restart
// the error clock.
const errorKey = (text) => String(text).replace(/\d+/g, '#');

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export function progressWatch() {
  let err = null; // { text, key, since }: text is the episode's first
  let idle = null; // { since, id }
  let wokeAt = -Infinity;
  let last = null; // the last loop's stuck
  let lastSlow = '[]'; // the last loop's slow, as JSON

  const same = (a, b) => a?.kind === b?.kind && a?.since === b?.since && a?.reason === b?.reason;

  return {
    loop({ now, error = null, starved, sessions = [] } = {}, limits = stuckLimits(null)) {
      if (error == null) err = null;
      else if (err?.key !== errorKey(error)) err = { text: error, key: errorKey(error), since: now };
      if (starved === null) idle = null;
      else if (typeof starved === 'string') idle = { since: idle?.since ?? now, id: starved };

      const from = (t) => Math.max(t, wokeAt);
      const iso = (t) => new Date(t).toISOString();
      // Each session's activity time: the later of its last stage event and its other activity.
      const active = [];
      for (const s of sessions) {
        if (!Number.isFinite(s?.progressAt)) continue;
        active.push({ s, at: Number.isFinite(s.activeAt) ? Math.max(s.progressAt, s.activeAt) : s.progressAt });
      }
      let stuck = null;
      if (err && now - from(err.since) >= limits.errorMs) {
        stuck = { kind: 'error', since: iso(from(err.since)), reason: `the supervisor fails every loop: ${err.text}` };
      } else if (idle && now - from(idle.since) >= limits.idleMs) {
        stuck = { kind: 'idle', since: iso(from(idle.since)), reason: `${idle.id} can be built and a slot is free, but nothing has started` };
      } else {
        let oldest = null;
        for (const s of active) if (!oldest || s.at < oldest.at) oldest = s;
        if (oldest && now - from(oldest.at) >= limits.activityMs) {
          const at = from(oldest.at);
          stuck = { kind: 'story', since: iso(at), reason: `${oldest.s.id} in ${oldest.s.slot} has shown no activity since ${hhmm(at)} (no stage change, log output or CPU)` };
        }
      }

      // Slow: active, but its stage has run past progressMs (an FYI, never stuck).
      const slow = active
        .filter(({ s, at }) => now - from(at) < limits.activityMs && now - from(s.progressAt) >= limits.progressMs)
        .map(({ s }) => ({ slot: s.slot, id: s.id, since: iso(from(s.progressAt)), stage: s.stage ?? null, rounds: s.rounds ?? 0, steps: s.steps ?? 0 }))
        .sort((a, b) => a.since.localeCompare(b.since) || String(a.slot).localeCompare(String(b.slot)));
      const slowJson = JSON.stringify(slow);

      const answer = { stuck, changed: !same(stuck, last), fresh: last === null && stuck !== null, cleared: last !== null && stuck === null, slow, slowChanged: slowJson !== lastSlow };
      last = stuck;
      lastSlow = slowJson;
      return answer;
    },
    woke(atMs) {
      wokeAt = atMs;
    },
  };
}
