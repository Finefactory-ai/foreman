// The supervisor's decisions, as small pure functions so each rule has a test. Nothing here
// touches a file, a process or the clock: the supervisor passes in what it knows and acts on
// what comes back.
//
//   canPick         may this slot start a new story now? Its slot must be under the worker count,
//                   and fewer than `workers` stories may run, counting every slot's running story
//   canResume       may this slot resume the work queued for it? As canPick, but a stop, the story
//                   limit and the running count do not apply
//   whenNothingLeft with nothing left to build: exit, stay on standby, or carry on
//   hung            has a running session stopped progressing (a stage change, an agent starting
//                   or finishing, or an agent's tool step), gone quiet, or reached the hard
//                   ceiling (CEILING_FACTOR times the build limit) while still progressing? Or,
//                   its story ended, has it gone quiet (ended-quiet, ended without a resume)?
//   newestStep      the newest tool step among the slot's running agents, and who took it
//   lastProgressText the words for the last progress a stopped session made
//   resumeCheck     what an automatic resume does instead of starting a session
//   outcome         what a finished session means for its slot, claim and schema token; only a
//                   failure the pipeline caused is a miss: a crash, a watchdog stop or a failed end
//                   with `--cause environment` is an environment ending (`env`), never a miss; an
//                   empty Console key (api-credit) that can switch to the subscription is global
//                   'switch', else a pause like credit; a failed Claude sign-in (signin) resumes
//                   the story, global 'signin', for the supervisor to check the sign-in first;
//                   signinRun caps those resumes: a story's sign-in deaths in a row while the
//                   check passes (MAX_SIGNIN_RESUMES), the next counting as a plain crash;
//                   a session the watchdog ended after its story ended (spent: hung's 'ended-quiet',
//                   or the ended-alive check in watch()) goes to the resume check, which closes
//                   the slot
//   spentResult     such a session's own `story end` result, when it printed none
//   failCauseOf     whether a failed end was the story's or the environment's, from the slot's
//                   own `story end` record
//   envWhy          the words for one environment ending
//   afterOutcome    the run-wide counters: misses in a row (and which), rate-limit backoffs (growing
//                   15, 30, 60, 120 minutes and never a pause; an ending inside a running wait joins
//                   it; any ending that is not a backoff starts the ladder again), environment
//                   endings in a row (three wait 15, 30 and 60 minutes, and only then pause), pauses,
//                   the environment waits timed by their own envUntil, the API waits by backoffUntil,
//                   and the switch to the subscription and a failed sign-in, which neither count nor clear
//   actionsFor      the buttons the page shows for a slot in its state
//   backoffMs       the rate-limit backoff, from FOREMAN_BACKOFF_MS (for tests): shorter, never longer
//   apiHeldText     the words for a slot held until the Claude API is back, with the retry time
//   backoffShown    the ISO time the later of the counters' two waits (API backoffUntil, environment
//                   envUntil) ends while it is still running, else null: what state.json's
//                   backoffUntil keeps for the page's idle slots
//   resumeHeld      the held slots Resume, or the end of the Claude API wait, may release: never one a halt holds
//   releaseAfterWait the held slots to release once the backoff ends and nothing pauses, halts or stops
//   looseClaims     the factory claims whose slot moved on (idle, parked without the story, or
//                   building another), let go of every tick, even under a live pid
//   looseClaimText  the warn event's words for one of them
//   ownerClaimFate  what became of the story an owner claim is on: done, retired, gone or neither
//   settledOwnerClaims the owner claims to remove (done, retired, or missing from the source for
//                   more than a poll), and when each missing story was first seen missing
//   ownerClaimText  the info event's words for one of them
//   pendingCommands the one-shot commands from control.json not yet acted on (slot actions, workers,
//                   fixed, handback, and answer-retry: a failed owner answer to try again now)

import { RESULTS } from './classify.mjs';

export const QUIET_MS = 30 * 60_000;
export const BUILD_MS = 2 * 60 * 60_000;
// The hard ceiling is this many times the build limit.
export const CEILING_FACTOR = 4;
// The extra time a session in the release stage gets past the build limit and the ceiling, so it
// is not stopped mid-merge. A constant, not a setting.
export const RELEASE_GRACE_MS = 15 * 60_000;
export const BACKOFF_MS = 15 * 60_000;
// The shortest backoff FOREMAN_BACKOFF_MS can set.
export const MIN_BACKOFF_MS = 1000;
// The rate-limit waits grow by these multiples of the base wait (15, 30, 60, 120 minutes) and stay
// at the last: a limit or outage never turns into a pause.
export const BACKOFF_STEPS = [1, 2, 4, 8];
export const MAX_MISSES = 3;
// Three endings in a row that the environment caused wait these multiples of the base wait (15, 30
// and 60 minutes); a fourth row, after the last wait, pauses the run.
export const ENV_BACKOFF_STEPS = [1, 2, 4];
// How many sign-in deaths in a row a story resumes from while the sign-in check passes.
export const MAX_SIGNIN_RESUMES = 3;

// Why a run stopped when its backlog ran out; `foreman cloud run` waits and picks again on it.
export const NOTHING_LEFT = 'Nothing left to build.';

// The loop's reason while it waits on standby for something to build. It never changes, so
// setLoop logs one event on entering standby and none per poll.
export const STANDBY = 'Nothing to build; picks up new stories automatically.';

// The slots of a run: w1..wN, N being config.slots (1 to 8).
export const slotIdsFor = (n) => Array.from({ length: n }, (_, i) => `w${i + 1}`);

// ── picking ──────────────────────────────────────────────────────────────────────────────

// `started` counts sessions begun this run for new stories; max 0 means no limit.
// `running`: how many of this run's slots have a story running (a session, or a prepare not yet
// settled), whatever slot it is in. After workers is lowered, slots above it are still draining,
// so a slot under it waits until fewer than `workers` run. 0, left out, counts nothing.
export function canPick({ halted, stopping, paused, backoffUntil, envUntil, now, slotIndex, workers, max, started, slotState, running = 0 }) {
  if (halted || stopping || paused) return false;
  if (now < (backoffUntil ?? 0)) return false;
  if (now < (envUntil ?? 0)) return false;
  if (slotIndex >= workers) return false;
  if (running >= workers) return false;
  if (slotState !== 'idle') return false;
  return max === 0 || started < max;
}

// Queued work resumes a story already in hand, not a new one: a stop, the story limit and the
// running count do not hold it back (they limit new picks only). Halted, paused, backing off (the
// Claude API wait or the environment wait),
// a slot at or above the worker count, or a slot that is not idle still do.
export function canResume(args) {
  return canPick({ ...args, stopping: false, max: 0, started: 0, running: 0 });
}

// What the run does when the last pick found nothing to build: null while something runs, is
// queued, or picking is halted or held (paused, a Jira hold); 'exit' for a run with a limit
// (--once, --max N) or --exit-when-idle; otherwise 'standby', where it stays up and picks
// again each tick.
export function whenNothingLeft({ nothingLeft, halted, held, running, queued, once, max, exitWhenIdle }) {
  if (!nothingLeft || halted || held || running || queued) return null;
  if (once || max > 0 || exitWhenIdle) return 'exit';
  return 'standby';
}

// ── the watchdog ─────────────────────────────────────────────────────────────────────────

// Too long: no progress (no stage change, no agent starting or finishing, no agent tool step;
// the newest of progressAt, stepAt and the start) for buildMs (default 2 hours) with nothing
// committed yet, so a story whose agents keep finishing or stepping is never stopped for its age
// alone. Quiet: no agent, log or ship activity for quietMs
// (default 30 minutes). Ceiling: still building ceilingMs (default 4 times buildMs) after the
// start although it is progressing; the owner decides what happens next. The release after the
// commit has its own timeouts, so neither the build limit nor the ceiling applies once
// committed, and a session in the release stage with no commit gets releaseGraceMs more on both.
// `ended`: `foreman story end` already ran in this session, so its story has shipped or ended and
// the session is exiting; neither the build limit nor the ceiling applies. Only the quiet limit
// does: an ended session with no activity for quietMs is 'ended-quiet', to be ended without a
// resume. The supervisor passes config.watchdog's limits.
export function hung(
  { startedAt, committedAt, lastActivity, progressAt, stepAt = null, stage = null, ended = false },
  now,
  { quietMs = QUIET_MS, buildMs = BUILD_MS, ceilingMs = buildMs * CEILING_FACTOR, releaseGraceMs = RELEASE_GRACE_MS } = {},
) {
  if (ended) return now - (lastActivity ?? startedAt) > quietMs ? 'ended-quiet' : null;
  const grace = stage === 'release' ? releaseGraceMs : 0;
  if (committedAt == null && now - Math.max(startedAt, progressAt ?? startedAt, stepAt ?? startedAt) > buildMs + grace) return 'too-long';
  if (now - (lastActivity ?? startedAt) > quietMs) return 'quiet';
  if (committedAt == null && now - startedAt > ceilingMs + grace) return 'ceiling';
  return null;
}

// The newest tool step among the records runningAgents returns: { at (ms), by (the agent's role) },
// or null when none has a lastAt that parses. Records that are not objects are skipped.
export function newestStep(agents) {
  let best = null;
  for (const a of agents ?? []) {
    if (!a || typeof a !== 'object') continue;
    const at = Date.parse(a.lastAt);
    if (Number.isNaN(at)) continue;
    if (!best || at > best.at) best = { at, by: a.role };
  }
  return best;
}

const ago = (ms) => {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `${Math.floor(s)} s`;
  const min = s / 60;
  if (min < 60) return `${Math.floor(min)} min`;
  const total = Math.floor(min);
  return `${Math.floor(total / 60)} h ${String(total % 60).padStart(2, '0')} min`;
};

// The words for the last progress a session made, for the build-limit stop's event: its newest
// tool step (when it is not older than the start or the stage progress), else the stage change or
// agent start or finish, else nothing since the start. `step` is newestStep's result.
export function lastProgressText({ startedAt, progressAt = null, step = null }, now) {
  if (step && step.at >= startedAt && step.at >= (progressAt ?? 0)) {
    const who = step.by === 'foreman' ? 'the main session' : step.by;
    return `last step ${ago(now - step.at)} ago by ${who}`;
  }
  if (progressAt != null && progressAt > startedAt) return `last stage change or agent start or finish ${ago(now - progressAt)} ago`;
  return `nothing since the session started ${ago(now - startedAt)} ago`;
}

// The statuses a story needs no session for (startup.mjs closableIds uses the same list).
export const SETTLED = ['done', 'retired', 'ready-to-promote'];

// What an automatic resume does instead of starting a session: 'close' the slot when the story is
// settled, 'mark-done' when it is not but its pull request merged, otherwise 'start' the session.
export function resumeCheck({ status = null, merged = false }) {
  if (SETTLED.includes(status)) return 'close';
  if (merged) return 'mark-done';
  return 'start';
}

// ── what a finished session means ────────────────────────────────────────────────────────

const ends = (fields) => ({
  slot: 'idle',
  miss: false,
  claim: 'release',
  token: 'release',
  global: null,
  notify: null,
  schemaStory: false,
  env: false,
  ...fields,
});

// `reason` is a short code the supervisor turns into words; for a parked slot it is also the
// slot's `parkedFor`, which decides the buttons (actionsFor).
// `switchable`: the session ran on the Console API key and may switch to the subscription
// (claude.fallback is subscription); the supervisor checks for a subscription sign-in next, and
// pauses itself when there is none. Only an api-credit ending reads it.
// `waitsOnFiles`: a deferred story waits for files another running story holds (file-locks.mjs),
// not for the schema token, so it is not remembered as a schema story. Only a deferral reads it.
// `ceiling`: the watchdog stopped the session at the hard ceiling while it was still progressing,
// so with no result it is parked for the owner to decide, not counted as a miss.
// `spent`: the watchdog ended the session after its story ended (hung's 'ended-quiet', or the
// ended-alive check in watch()). With no
// result it goes to the resume check, which closes the slot (or starts a session only if the
// story was reopened); never a miss, a park or an email, however often it crashed before.
// `failCause`: 'environment' (failCauseOf) when a failed end said the environment caused it. That
// and a plain crash (also a watchdog stop, or a give-up on sign-in resumes) are environment
// endings: `env` true, never a miss. Only a failure the pipeline caused is a miss.
export function outcome({ result, failCause = 'story', cause = null, crashesOfStory = 0, committed = false, waitsOnStories = false, waitsOnFiles = false, switchable = false, ceiling = false, spent = false }) {
  switch (result) {
    case 'shipped':
      return ends({ reason: 'shipped' });
    case 'ready-to-promote':
      // Every check passed and the release finishes later: the slot moves on.
      return ends({ reason: 'ready-to-promote' });
    case 'blocked':
      // A blocked story waits on the owner (a decision, a task, a depends_on proposal, nothing to
      // build, or a release step handed over) or on other stories, so it is never a miss. Only
      // waiting on other stories: the architect found a dependency the tracker did not list, and
      // there is nothing for the owner; the picker takes it again when they land. Otherwise the
      // owner is still emailed.
      if (waitsOnStories) return ends({ reason: 'waiting' });
      return ends({ reason: result, miss: false, notify: result });
    case 'failed':
      if (failCause === 'environment') return ends({ reason: result, miss: false, env: true, notify: result });
      return ends({ reason: result, miss: true, notify: result });
    case 'deferred':
      return ends({ reason: 'deferred', schemaStory: !waitsOnFiles });
    case 'empty':
      return ends({ reason: 'empty' });
    case 'halted':
    case 'held':
      return ends({ reason: result, slot: 'held', claim: 'keep', token: 'keep' });
    default:
      break;
  }
  if (spent) return ends({ reason: 'spent', slot: 'resume', miss: false, claim: 'keep', token: 'keep' });
  // No result line, and the Console key ran out where a switch to the subscription is allowed.
  // The story is requeued (slot 'resume', claim and token kept, no miss) while the supervisor
  // checks for a subscription sign-in. Then it switches, or it pauses when none is found.
  // Committed or not.
  if (cause === 'api-credit' && switchable) {
    return ends({ reason: 'api-credit', slot: 'resume', miss: false, claim: 'keep', token: 'keep', global: 'switch' });
  }
  // The Claude sign-in stopped working: not the story's fault, so no miss, no park and no email,
  // committed or not, however often the story crashed. The story resumes once the supervisor
  // has checked the sign-in, which pauses the run itself while it stays broken. The supervisor
  // passes a cause past MAX_SIGNIN_RESUMES in a row through signinRun first, which turns it into
  // null: a check that passes while sessions keep dying is the story's problem, a plain crash.
  if (cause === 'signin') {
    return ends({ reason: 'signin', slot: 'resume', miss: false, claim: 'keep', token: 'keep', global: 'signin' });
  }
  // A rate limit, outage or empty balance is nobody's fault: wait, then carry on from where the
  // session stopped (or hold it if it had already committed).
  if (cause === 'rate-limit' || cause === 'outage' || cause === 'credit' || cause === 'api-credit') {
    return ends({
      reason: cause,
      slot: committed ? 'held' : 'resume',
      claim: 'keep',
      token: 'keep',
      global: cause === 'credit' || cause === 'api-credit' ? 'pause-credit' : 'backoff',
    });
  }
  // Stopped at the hard ceiling while still progressing: the owner decides (Resume, Restart, Skip
  // or Take over), and nobody missed.
  if (ceiling) return ends({ reason: 'ceiling', slot: 'parked', miss: false, claim: 'keep', token: 'keep', notify: 'parked' });
  // A plain crash: resume once from the branch; the same story crashing again parks the slot.
  if (crashesOfStory >= 1) {
    return ends({ reason: 'crash', slot: 'parked', miss: false, env: true, claim: 'keep', token: 'keep', notify: 'parked' });
  }
  return ends({ reason: 'crash', slot: 'resume', miss: false, env: true, claim: 'keep', token: 'keep', notify: 'noresult' });
}

// The backoff in ms from FOREMAN_BACKOFF_MS's value: BACKOFF_MS unless it is a positive integer,
// which is capped at BACKOFF_MS and raised to MIN_BACKOFF_MS. For tests; it can only shorten.
export function backoffMs(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return BACKOFF_MS;
  return Math.max(MIN_BACKOFF_MS, Math.min(BACKOFF_MS, Number(value)));
}

// Caps the sign-in resumes of one story. `before` is its earlier sign-in deaths in a row (anything
// that is not a positive integer counts 0). Another cause starts the count again (streak 0). A
// sign-in death makes streak = before + 1: up to MAX_SIGNIN_RESUMES it stays 'signin'; past it the
// cause is null and `gaveUp` is true, so outcome sees a plain crash (an environment ending, a park when it
// crashed before).
export function signinRun({ cause, before = 0 }) {
  if (cause !== 'signin') return { cause, streak: 0, gaveUp: false };
  const streak = (Number.isInteger(before) && before > 0 ? before : 0) + 1;
  if (streak > MAX_SIGNIN_RESUMES) return { cause: null, streak, gaveUp: true };
  return { cause: 'signin', streak, gaveUp: false };
}

// A session the watchdog ended after its story ended (`spent`: hung's 'ended-quiet', or the
// ended-alive check in watch()) that printed no result: its own
// `foreman story end` result (the slot's result, `slotResult`, for this story `id`) counts, as the
// outlive check lets a printed result stand. Anything else leaves `run` as it is.
export function spentResult(run, { spent, slotResult, id }) {
  if (!spent || run.result !== null || slotResult?.id !== id || !RESULTS.includes(slotResult.result)) return run;
  return { ...run, result: slotResult.result };
}

// Whether a failed end was the environment's: only a failed run whose own `story end` record (the
// slot's result, `slotResult`, for this story `id`) is failed with cause 'environment'. A missing or
// old record, a record for another story or any other cause means the story, as before.
export function failCauseOf({ result, slotResult, id }) {
  return result === 'failed' && slotResult?.id === id && slotResult.result === 'failed' && slotResult.cause === 'environment' ? 'environment' : 'story';
}

// ── run-wide counters ────────────────────────────────────────────────────────────────────

// counters { misses, missed, backoffs, backoffUntil, envUntil, envEndings, envList, envWaits }: `backoffs` is the step on the ladder
// (BACKOFF_STEPS); any ending that is not a rate limit or outage means the API answered, so it sets
// `backoffs` to 0 and leaves `backoffUntil`, which is the wait still running. `missed` is the ids of
// the stories that counted toward `misses`, so the pause can name them. When an id repeats, the pause names each
// story once with how often it missed ("ACME-1 twice"), or says one story missed three times.
// `story` is the finished story's id. A pause clears the counter that caused it, so when the owner
// resumes the run starts counting afresh. Only a ship or a ready-to-promote clears the misses;
// anything else that is not a miss (blocked, waiting, deferred, empty, a backoff) neither counts
// nor clears the misses.
// `envEndings` and `envList` are the environment endings in a row (outcome's `env`) and their words;
// they never touch `misses` or `missed`. The third makes `global: 'env-backoff'`: the supervisor waits
// ENV_BACKOFF_STEPS times the base wait (`envWaits` is how many such waits came in a row). The third
// after the last wait pauses. `envUntil` is the environment wait still running, set only by an
// env-backoff; `backoffUntil` is set only by a rate limit or an outage. A story miss breaks the row (envEndings 0, envWaits kept); a ship
// or a ready-to-promote clears all three. An environment ending inside a running wait joins it.
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const unique = (list) => [...new Set(list)];
// "A", "A and B", "A, B and C".
const names = (ids) => (ids.length === 1 ? ids[0] : `${ids.slice(0, -1).join(', ')} and ${ids.at(-1)}`);
// The pause's words for the stories that missed, in the order first seen.
const missReason = (missed) => {
  if (!missed.length) return 'Three stories in a row did not ship.';
  const ids = unique(missed);
  if (ids.length === missed.length) return `Three stories in a row did not ship: ${names(ids)}.`;
  if (ids.length === 1) return `${ids[0]} did not ship three times in a row.`;
  const times = (id) => missed.filter((m) => m === id).length;
  const counted = ids.map((id) => (times(id) === 1 ? id : times(id) === 2 ? `${id} twice` : `${id} ${times(id)} times`));
  return `Three tries in a row did not ship: ${names(counted)}.`;
};

// A wait in words: "2 hours" for whole hours, "15 minutes" from a minute up, else "3 seconds".
const HOUR_MS = 60 * 60_000;
const waitWords = (ms) => {
  if (ms >= HOUR_MS && ms % HOUR_MS === 0) return ms === HOUR_MS ? '1 hour' : `${ms / HOUR_MS} hours`;
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)} seconds`;
};

// The words for one environment ending: a failed end in its note's words (trailing dots dropped, cut to
// 100 characters), a watchdog stop, or a crash with no result.
export function envWhy({ reason, watchdog = false, note = '' }) {
  if (reason === 'failed') {
    const text = String(note ?? '').trim().replace(/\.+$/, '').trim().slice(0, 100).trim();
    return text ? `failed: ${text}` : 'failed on the environment';
  }
  return watchdog ? 'was stopped by the watchdog' : 'ended without a result';
}

// What a slot held for the Claude API shows; `retry` is the time of day ('HH:MM') the backoff ends.
export function apiHeldText(retry) {
  return retry ? `held until the API is back (retry at ${retry})` : 'held until the API is back';
}

// The ISO time the counters' later wait ends, while it is later than nowMs, else null. It covers the
// API backoff (counters.backoffUntil) and the environment backoff (counters.envUntil).
export function backoffShown(counters, nowMs) {
  const until = Math.max(Number(counters?.backoffUntil ?? 0), Number(counters?.envUntil ?? 0));
  return until > nowMs ? new Date(until).toISOString() : null;
}

// `backoffMs` is the wait a rate limit or outage sets (BACKOFF_MS unless a test shortens it).
// `why` is envWhy's words for an environment ending.
export function afterOutcome(counters, o, now, story = null, { backoffMs: wait = BACKOFF_MS, why = '' } = {}) {
  const c = { misses: 0, missed: [], backoffs: 0, backoffUntil: 0, envUntil: 0, envEndings: 0, envList: [], envWaits: 0, ...counters };

  // The switch to the subscription is nobody's miss and no success either.
  if (o.global === 'switch') return { counters: c, global: 'switch', reason: '' };
  // Nor is a failed sign-in, and it touches no backoff: the supervisor checks the sign-in.
  if (o.global === 'signin') return { counters: c, global: 'signin', reason: '' };

  if (o.global === 'pause-credit') {
    const reason = o.reason === 'api-credit' ? 'The Console API key is out of credit.' : 'The account is out of credit or hit its usage limit.';
    return { counters: c, global: 'pause', reason };
  }

  if (o.global === 'backoff') {
    // A session that died inside a wait already running (another slot's) joins it: no new step.
    if (now < (c.backoffUntil ?? 0)) return { counters: c, global: 'backoff', reason: '' };
    const ms = wait * BACKOFF_STEPS[Math.min(c.backoffs, BACKOFF_STEPS.length - 1)];
    return {
      counters: { ...c, backoffs: c.backoffs + 1, backoffUntil: now + ms },
      global: 'backoff',
      reason: `The Claude API is limited or down; waiting ${waitWords(ms)}.`,
    };
  }

  if (o.env) {
    // Inside a wait already running (another slot's, API or environment) it joins it: nothing counts.
    if (now < Math.max(c.backoffUntil ?? 0, c.envUntil ?? 0)) return { counters: { ...c, backoffs: 0 }, global: null, reason: '' };
    const item = [story, why || 'ended on the environment'].filter(isText).join(' ');
    const envEndings = c.envEndings + 1;
    const envList = [...(Array.isArray(c.envList) ? c.envList : []), item];
    if (envEndings < MAX_MISSES) return { counters: { ...c, envEndings, envList, backoffs: 0 }, global: null, reason: '' };
    if (c.envWaits < ENV_BACKOFF_STEPS.length) {
      const ms = wait * ENV_BACKOFF_STEPS[c.envWaits];
      return {
        counters: { ...c, envEndings: 0, envList: [], envWaits: c.envWaits + 1, backoffs: 0, envUntil: now + ms },
        global: 'env-backoff',
        reason: `Three endings in a row were the environment, not the stories: ${envList.join('; ')}. Waiting ${waitWords(ms)} before carrying on.`,
      };
    }
    return {
      counters: { ...c, envEndings: 0, envList: [], envWaits: 0, backoffs: 0 },
      global: 'pause',
      reason: `Three endings in a row were the environment, not the stories, after waiting ${names(ENV_BACKOFF_STEPS.map((n) => waitWords(wait * n)))}: ${envList.join('; ')}.`,
    };
  }

  if (o.miss) {
    const misses = c.misses + 1;
    const missed = [...(Array.isArray(c.missed) ? c.missed : []), story].filter(isText);
    if (misses >= MAX_MISSES) {
      return { counters: { ...c, misses: 0, missed: [], envEndings: 0, envList: [], backoffs: 0 }, global: 'pause', reason: missReason(missed) };
    }
    return { counters: { ...c, misses, missed, envEndings: 0, envList: [], backoffs: 0 }, global: null, reason: '' };
  }

  // Only a story that shipped, or went through every check and parked its release, breaks a
  // run of misses, as in the single loop; a deferral or an empty pick is neither a miss nor a
  // success.
  if (o.reason === 'shipped' || o.reason === 'ready-to-promote') {
    return { counters: { ...c, misses: 0, missed: [], envEndings: 0, envList: [], envWaits: 0, backoffs: 0 }, global: null, reason: '' };
  }
  return { counters: { ...c, backoffs: 0 }, global: null, reason: '' };
}

// ── owner controls ───────────────────────────────────────────────────────────────────────

// "I've fixed it": what to do with the answer of `foreman health` ({ status, stdout } of the
// child). The halt is cleared only when it exits 0 and its last JSON line says ok.
export function afterFixCheck({ status, stdout }) {
  let answer = null;
  try {
    answer = JSON.parse(String(stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '');
  } catch {
    // no answer
  }
  const reason = typeof answer?.reason === 'string' && answer.reason ? answer.reason : 'The health check did not answer.';
  if (status !== 0 || answer?.ok !== true) {
    return { clear: false, fixProblem: reason, event: { text: `Still halted: ${reason}`, kind: 'warn' } };
  }
  const text = reason === 'no health checks are configured' ? 'Halt cleared; no health checks are configured.' : `Halt cleared: ${reason}`;
  return { clear: true, fixProblem: null, event: { text, kind: 'good' } };
}

// The held slots to release once a halt clears, oldest first: each slot's patch and the work
// that puts its story back on the queue. The patch leaves heldStory on the slot, so the story
// still counts as in a slot (scratch-orgs.mjs storiesInSlots) until its session starts, and no
// env sweep deletes its org meanwhile. `slots` is [{ slot, st }].
export function releaseHeld(slots) {
  return slots
    .filter(({ st }) => st?.state === 'held' && st.heldStory)
    .sort((a, b) => String(a.st.since).localeCompare(String(b.st.since)))
    .map(({ slot, st }) => ({
      slot,
      patch: { state: 'idle', reason: '', haltedBy: false, heldFor: null, story: null },
      work: { slot, id: st.heldStory, mode: st.haltedBy ? 'after-halt' : '' },
    }));
}

// The held slots that Resume, or the end of the Claude API wait, may release: as releaseHeld, but
// never one a halt holds (haltedBy), which waits for "I've fixed it". `slots` is [{ slot, st }].
export function resumeHeld(slots) {
  return releaseHeld(slots.filter(({ st }) => !st?.haltedBy));
}

// The held slots to release once the Claude API wait is over, oldest first, as resumeHeld
// releases them. Nothing is released while `halted` (a held result frozen by someone else's halt
// has haltedBy false but waits for the same fix), while `paused`, nor while `stopping`: a stop
// leaves the slot held, with its claim, for the next run, whose first tick releases it; nor
// before `backoffUntil`. The work is an automatic
// resume (resume: true), so startWork closes the slot instead when the story is settled or its
// pull request merged. A story in `inHand` (running or already queued) gets no work, so it is
// not queued twice. `slots` is [{ slot, st }].
export function releaseAfterWait(slots, { halted = false, paused = false, stopping = false, backoffUntil = 0, now, inHand = new Set() }) {
  if (halted || paused || stopping || now < (backoffUntil ?? 0)) return [];
  return resumeHeld(slots).map((r) => ({
    ...r,
    work: inHand.has(r.work.id) ? null : { ...r.work, resume: true },
  }));
}

// The story an owner command (skip, unpark, take over...) acts on in a slot, or null: the
// running one, the slot's story, then for a parked slot only parkedStory (its heldStory may be
// left over from before), else heldStory (a slot released by releaseHeld keeps it on purpose
// until its session starts, see above) or parkedStory, then the slot's factory claim.
export function slotStoryId({ st = {}, running = null, claims = [], slot }) {
  return (
    running?.id ??
    st.story?.id ??
    (st.state === 'parked' ? st.parkedStory : (st.heldStory ?? st.parkedStory)) ??
    claims.find((c) => c.slot === slot && c.by === 'factory')?.id ??
    null
  );
}

// The slot patch for when the owner moves a story out of its slot (skip, take over). It clears
// heldStory, so a later command never acts on a story the slot no longer has, and heldFor, so a
// slot that has let go of its story leaves no stale marker.
export const LET_GO_PATCH = { state: 'idle', reason: '', story: null, result: null, parkedFor: null, parkedStory: null, heldStory: null, heldFor: null };

export const SLOT_ACTIONS = { building: ['skip', 'takeover', 'park'], waiting: [], held: ['resume', 'takeover'], idle: ['park'], down: ['resume', 'park'] };

const PARKED_ACTIONS = { crash: ['resume', 'restart', 'skip', 'takeover'], dirty: ['resume-as-is', 'discard'], owner: ['unpark'] };

export function actionsFor(slot) {
  // Nothing can start while a halt holds the slot, so Resume would do nothing there.
  if (slot?.state === 'held' && slot.haltedBy) return ['takeover'];
  const list = slot?.state === 'parked' ? PARKED_ACTIONS[slot.parkedFor] : SLOT_ACTIONS[slot?.state];
  return [...(list ?? [])];
}

export const ACTIONS = new Set(['skip', 'takeover', 'park', 'unpark', 'resume', 'restart', 'resume-as-is', 'discard']);

// ── claims a slot no longer needs ────────────────────────────────────────────────────────────

// The factory claims to let go of: `claims` as locks.mjs claims() lists them, `slots` this run's
// slots (slot id -> readSlot()), `inHand` the stories running, preparing or queued, and `ours`
// whether this process may let go of a claim (its own pid, or stale). The slot's state decides,
// not whether the pid is alive: an idle slot needs no claim; a parked one keeps only the story it
// was parked on for crashes (parkedStory; a park written before that field keeps it too); a
// building or waiting one keeps only its story. Held and down slots keep theirs: resume and
// "I've fixed it" read them. Each result is { id, slot, why: 'idle'|'parked'|'building', other? }.
export function looseClaims({ claims, slots, inHand = new Set(), ours = () => true }) {
  const out = [];
  for (const c of claims ?? []) {
    if (c.by !== 'factory' || !ours(c) || !Object.hasOwn(slots ?? {}, c.slot) || inHand.has(c.id)) continue;
    const st = slots[c.slot] ?? {};
    if (st.state === 'idle') out.push({ id: c.id, slot: c.slot, why: 'idle' });
    else if (st.state === 'parked') {
      const kept = st.parkedFor === 'crash' && (st.parkedStory == null || st.parkedStory === c.id);
      if (!kept) out.push({ id: c.id, slot: c.slot, why: 'parked' });
    } else if (st.state === 'building' || st.state === 'waiting') {
      const other = st.story?.id;
      if (other && other !== c.id) out.push({ id: c.id, slot: c.slot, why: 'building', other });
    }
  }
  return out;
}

// The warn event for a claim looseClaims let go of.
export function looseClaimText({ id, slot, why, other }) {
  if (why === 'parked') return `${id}: let go of its claim; slot ${slot} is parked without it.`;
  if (why === 'building') return `${id}: let go of its claim; slot ${slot} is building ${other}.`;
  return `${id}: let go of its claim; slot ${slot} is idle.`;
}

// ── owner claims on settled stories ──────────────────────────────────────────────────────────

// How long a story may be missing from the source before the owner's claim on it is cleared when
// `stories.pollSeconds` is not set: the Jira and Salesforce sources' default poll.
export const OWNER_CLAIM_POLL_SECONDS = 60;

// What became of the story an owner claim is on, from the source's list ({ id, status } each):
// 'done' or 'retired' when it is listed so, 'gone' when it is missing from a non-empty list, else
// null. An empty list says nothing (a cache not filled yet, a changed query), so it gives null.
export function ownerClaimFate(id, stories) {
  const found = (stories ?? []).find((s) => s.id === id);
  if (found) return found.status === 'done' || found.status === 'retired' ? found.status : null;
  return stories?.length ? 'gone' : null;
}

// Which owner claims to remove, and when each missing story was first seen missing. `stories` is
// the source's list, or null when it could not be read: then nothing is dropped. A story missing
// from the list is dropped only once it has been missing for more than `absentMs`, as a story
// that left the source's query (Jira's own JQL leaves out Done issues) and not a failed read.
// Returns { drop: [{ id, why, at }], absentSince: { id: iso } }, absentSince holding only ids of
// current owner claims. Factory claims are never touched here.
export function settledOwnerClaims({ claims = [], stories = null, absentSince = {}, now, absentMs }) {
  const drop = [];
  const seen = {};
  for (const c of claims) {
    if (c.by !== 'owner') continue;
    const before = absentSince?.[c.id];
    if (stories === null) {
      if (before !== undefined) seen[c.id] = before;
      continue;
    }
    const fate = ownerClaimFate(c.id, stories);
    if (fate === 'done' || fate === 'retired') drop.push({ id: c.id, why: fate, at: c.at });
    else if (fate === 'gone') {
      const parsed = Date.parse(before);
      const since = Number.isNaN(parsed) ? now : parsed;
      if (now - since > absentMs) drop.push({ id: c.id, why: 'gone', at: c.at });
      else seen[c.id] = new Date(since).toISOString();
    } else if (!stories.length && before !== undefined) seen[c.id] = before;
  }
  return { drop, absentSince: seen };
}

// The info event for an owner claim that was cleared.
export function ownerClaimText({ id, why }) {
  if (why === 'retired') return `${id}: cleared your claim; the story is retired.`;
  if (why === 'gone') return `${id}: cleared your claim; the story is no longer in the story source.`;
  return `${id}: cleared your claim; the story is done.`;
}

// Each command carries `at` and is honoured once: it is pending while `at` differs from the
// `at` last handled under its key. Order: the run's slots, then the worker count, then "I've
// fixed it", then hand-back. `slotIds` is the run's slot list (slotIdsFor(config.slots)); the
// worker count may go up to its length. Three slots when not given.
export function pendingCommands(control, handled = {}, slotIds = slotIdsFor(3)) {
  const out = [];
  const seen = handled ?? {};
  const slots = control?.slots ?? {};
  for (const slot of slotIds) {
    const cmd = slots[slot];
    if (!cmd || !ACTIONS.has(cmd.action) || !cmd.at) continue;
    const key = `slot:${slot}`;
    if (seen[key] !== cmd.at) out.push({ key, kind: 'slot', slot, action: cmd.action, at: cmd.at });
  }
  // The worker count is a command too: it applies when it is changed (workersAt), never because
  // an old value is still sitting in the page's document when a run starts with --workers.
  const w = control?.workers;
  if (control?.workersAt && Number.isInteger(w) && w >= 1 && w <= slotIds.length && seen.workers !== control.workersAt) {
    out.push({ key: 'workers', kind: 'workers', value: w, at: control.workersAt });
  }
  if (control?.fixedAt && seen.fixed !== control.fixedAt) out.push({ key: 'fixed', kind: 'fixed', at: control.fixedAt });
  const hb = control?.handBack;
  if (hb?.id && hb.at && seen.handback !== hb.at) out.push({ key: 'handback', kind: 'handback', id: hb.id, at: hb.at });
  // A failed owner answer the owner asked to try again now, once per `at`.
  const ar = control?.answerRetry;
  if (ar?.id && ar.at && seen['answer-retry'] !== ar.at) out.push({ key: 'answer-retry', kind: 'answer-retry', id: ar.id, at: ar.at });
  return out;
}
