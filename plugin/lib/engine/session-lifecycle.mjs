// A session's ending, the watchdog, and the sessions found at start: what a session that ended
// means for its story, its slot and the run, the watchdog that stops a session, and the start-up
// reconciliation that adopts or resumes what a run before left. A part of the supervisor
// (supervisor.mjs is the entry point and lists the parts); it depends on run-context.mjs,
// slot-starts.mjs (a resume starts again), owner-controls.mjs and story-followups.mjs. The
// paragraphs below were part of supervisor.mjs's header.
//
// Start-up resumes (the stories a dead run or `foreman stop --now` left in hand) are not pinned to
// the slot they were in. They are queued in priority order (pick.mjs byPriority) and marked
// `ranked`: a free slot under the limit first asks the picker, and starts a story it ranks above
// the queued one before resuming. At start-up each one's old folder is freed (leftovers.mjs
// freeStoryFolder: its unfinished work committed on the story branch, the folder detached), so a
// pick into that slot never parks it as dirty; when a folder cannot be freed the story resumes in
// its old slot. A session stopped by `foreman stop --now` ends `interrupted`, not failed.
//
// Live sessions: whatever the reason a supervisor starts (a restart whose handover did not reach
// it, a hard kill, a crash, the service starting it again), start-up looks for story sessions
// already running in the slots' folders (live-sessions.mjs: `ps` and each one's folder) after the
// handed-over ones are adopted, and adopts them the same way: one "Kept N running across the
// restart" event covering the handed-over sessions and those found, the pid their claims name
// vouched for in supervisor-adopted.json, and no "Start-up: resuming" for their stories. Every
// slot folder is scanned, the handed-over slots too. A folder with two sessions keeps the oldest
// (the handed-over one, for a slot already in hand) and gets one warn event naming both pids and a
// `kill <pid>` for each other (`foreman doctor` reports the same in its 'story sessions' check);
// none is ended from here. A session whose story another live run or the owner holds is said so
// once and left alone. The scan is guarded: a failure in it is a warn event and the start goes on.
//
// The watchdog (watch(), scheduler.mjs hung): before its commit, a session with no progress (no
// stage or detail change and no agent starting or finishing, the slot's story.progressAt, and no
// agent tool step, the newest lastAt in the slot's agent files) for watchdog.buildMinutes (120)
// is stopped and resumed, its event naming the last progress seen, as is one with no activity
// at all for watchdog.quietMinutes (30); both count as a crash (a miss, the noresult email, the
// slot parked on the second). A story that keeps progressing is never stopped for its age alone,
// up to the hard ceiling at 4 times the build limit: then it is stopped and its slot parked as a
// crash (Resume, Restart, Skip, Take over) for the owner to decide, with no miss and one
// `parked` email. The release after the commit has its own timeouts, and a session in the
// release stage gets RELEASE_GRACE_MS (15 min) past the build limit and the ceiling. The build
// limit and the ceiling never stop a session whose `foreman story end` has run, or whose story
// is done, retired or ready-to-promote, or whose story/* pull request merged; the status and the
// pull request are looked up only when a stop is about to happen, at most once per session. Only
// the quiet limit still applies to such a session: with no activity for watchdog.quietMinutes it
// is ended with one warn event and no resume, and counts as no crash and no miss. Its own
// `story end` counts as its result when it printed none; otherwise the slot is closed as for a
// settled resume. A session that ended with no result is resumed only if its story is not
// settled and its pull request did not merge; otherwise the slot is closed (the story marked
// done first when only the pull request merged).
// The run record of a watchdog stop says why, the stages kept and the work redone
// (run-record.mjs, `foreman report`).
//
// Outlived sessions: a session still alive watchdog.outliveMinutes (1) after its log's last event,
// when that event is a final result with FACTORY_RESULT and no background task is open
// (session-outlive.mjs), is ended (SIGTERM, then SIGKILL after 10 s, its whole process group)
// with one warn event, and its result counts. A session still alive watchdog.outliveMinutes after
// its own `foreman story end` (the slot's result for its story, no story in the slot) is ended
// the same way, with one warn event naming the story, and its recorded result counts.
//
// A rate limit or an outage never pauses the run: the wait grows 15, 30, 60, then 120 minutes and
// stays there (scheduler.mjs BACKOFF_STEPS), a session that dies inside a running wait joins it, and
// anything else that ends starts the ladder again. Each step is one warn event, and state.json's
// apiWait ({ since, until, step }) shows while it lasts, as a "stuck waiting" FYI.
// state.json's backoffUntil (the ISO time of the API or the environment backoff, backoffShown) is
// kept after each ending, so an idle slot reads "Picking held: backing off after failed sessions
// until HH:MM". The environment wait has its own end time (counters.envUntil), never the API
// wait's, so a slot held for the API keeps its own retry time and is released only when the API
// wait ends; state.json's envWait ({ since, until, step }) shows while it lasts, as an FYI.
//
// Only a story the pipeline rejected counts toward the three-in-a-row pause. A crash, a watchdog
// stop and a failed end with `foreman story end failed --cause environment` (CI that never started,
// a conflict, a test file that would not load) are the environment's: three in a row wait 15, 30
// and then 60 minutes (scheduler.mjs ENV_BACKOFF_STEPS), each wait one warn event naming them, and
// the run pauses only after that. The cause is read from the slot's own `story end` record, and a
// run record keeps `cause: 'environment'`, which the learning evaluation leaves out.

import { statSync } from 'node:fs';
import { join } from 'node:path';
import { breakIfStale, claimFile, claims, holderOf, SCHEMA, SHIP } from './locks.mjs';
import { blockedNow, byPriority, waitsOnStories } from './pick.mjs';
import { dropReservations, waitsOnFiles } from './file-locks.mjs';
import { reconcile, recoverySteps } from './reconcile.mjs';
import { afterOutcome, apiHeldText, backoffShown, envWhy, failCauseOf, hung, lastProgressText, newestStep, outcome, SETTLED, signinRun, spentResult } from './scheduler.mjs';
import { creditPauseReason, fallbackOf, readSignIn } from './claude-fallback.mjs';
import { resumeAtFor } from './credit-resume.mjs';
import { recordsRuns, watchdogLimits } from './live-settings.mjs';
import { PLUGIN_DIR } from './code-version.mjs';
import { adoptable, adoptedPids, leftOut, sessionAlive } from './handover.mjs';
import { initPluginWarning } from './plugin-copy.mjs';
import { sessionEnding } from './story-note-text.mjs';
import { closableMergedIds, mustFinishFor, remoteHasBranch, shippedBranches } from './startup.mjs';
import { slotNumber } from './slot-work.mjs';
import { worktreeOf } from './worktree.mjs';
import { freeStoryFolder } from './leftovers.mjs';
import { readInit } from './session-log.mjs';
import { readMark } from './session-files.mjs';
import { fallbackAnswer, runSessionClose } from './session-close.mjs';
import { learnedOf } from './run-record.mjs';
import { holderFor, listStorySessions, logFor, planLive } from './live-sessions.mjs';
import { endedLate, outlived, outliveMs, readHead, readTail } from './session-outlive.mjs';
import { writeAdopted } from './supervisor-pid.mjs';
import { READY, readPark, sessionResult } from './parks.mjs';
import {
  clearAgents,
  endStory,
  readSlot,
  recordResult,
  runningAgents,
  setSlot,
} from './state.mjs';
import { addSchemaStory, autoPause, BACKOFF, BASE_REF, branchOf, CARRIED, checkSignIn, checkSubscription, closing, CONFIG, countEnded, crashes, DIR, dropCheckpoint, endSlotCheckJobs, event, forgetMark, git, guarded, heldSnapshot, learning, LIVE, lookUpMerged, loopChildren, MAX, ME, NET_LIMIT, NODE, notify, now, OWN, owner, projectsOf, recordRun, releaseClaim, releaseToken, rolledBackOf, ROOT, saveCheckpoint, saveRun, sessions, sh, signInCheck, signins, sleep, SLOT_IDS, slotIndex, state, statusOf, STOP_WAIT_MS, stories, subscriptionCheck, takeSpans, work } from './run-context.mjs';
import { killSession, markNothingLeft, tidyFolder, uncountStart } from './slot-starts.mjs';
import { afterOwnerStop, retimeApiHeld } from './owner-controls.mjs';
import { askAboutFailed, closeShippedAsks, queueGroupSummary, tellStory } from './story-followups.mjs';

export let counters = CARRIED?.counters ?? { misses: 0, missed: [], backoffs: 0, backoffUntil: 0, envUntil: 0, envEndings: 0, envList: [], envWaits: 0 };
let handedOver = false; // the sessions went to the next process: no ending is handled here

// A restart on new code hands the sessions to the next process; no ending is handled here after.
export function setHandedOver(value) {
  handedOver = value;
}

// ── a session ended ──────────────────────────────────────────────────────────────────────────

export const onExit = guarded('a session ending', (slot, entry) => {
  // Handed to the next process, which handles it (see the header of supervisor.mjs).
  if (handedOver) return;
  const s = sessions.get(slot);
  if (!s || s !== entry) return; // already handled (an error and an exit, or a newer session)
  sessions.delete(slot);
  closing.set(slot, s);
  endSlotCheckJobs(slot);
  const spans = takeSpans(slot);
  clearAgents(DIR, slot);
  const id = s.id;
  const shown = readSlot(DIR, slot);
  if (shown.story?.id === id) setSlot(DIR, slot, { story: { ...shown.story, detail: 'closing the session' } }, now());
  // The log and the session's files (megabytes of transcripts) are read in a child of its own, and
  // so is the working tree hash a session with no result needs, so the loop keeps ticking. The
  // child removes the files, unless the session ended in an interrupt (see session-close.mjs).
  const request = { logFile: s.log, projects: projectsOf(slot, s), record: recordsRuns(LIVE), keep: s.stop === 'interrupt', id, worktree: worktreeOf(DIR, slotIndex(slot) + 1), generated: CONFIG.generated, roles: CONFIG.roles };
  runSessionClose({ node: NODE.node(), request, track: loopChildren })
    .then(
      guarded('a session ending', (r) => {
        let answer = r.answer;
        if (!r.ok) {
          answer = fallbackAnswer(s.log);
          event(`Could not read the session files of ${id} in a child of its own (${r.why}); read the end of its log instead.`, 'warn', slot);
        }
        endSession(slot, s, spans, answer);
      }),
    )
    .finally(() => {
      if (closing.get(slot) === s) closing.delete(slot);
    });
});

// The rest of a session's ending, once its log and files are read (the child's answer, see
// session-close.mjs): the result, the checkpoint, the run record, and what the slot and the run do
// next. A failure here is an event, never the end of the supervisor.
function endSession(slot, s, spans, answer) {
  const id = s.id;
  if (answer.kept.length) event(`Kept the session files of ${id} (it ended in an interrupt): ${answer.kept.join(', ')}`, 'warn', slot);
  if (answer.filesError) event(`Could not read or remove the session files of ${id} (${answer.filesError}).`, 'warn', slot);
  const agents = answer.agents;
  forgetMark(slot, s);
  const slotState = readSlot(DIR, slot);

  // Ended by the owner's command, not by the story: handled where the command is.
  if (['skip', 'takeover', 'restart', 'interrupt'].includes(s.stop)) {
    // An interrupt is the run stopping (`foreman stop --now`, a signal): the story resumes at the next start.
    const interrupt = s.stop === 'interrupt';
    if (slotState.story) {
      if (interrupt) endStory(DIR, 'interrupted', '', 'stopped with the run; it resumes at the next start', now(), slot);
      else endStory(DIR, 'failed', '', `stopped: ${s.stop}`, now(), slot);
    }
    const stopped = readSlot(DIR, slot).result;
    recordResult(DIR, stopped, recordRun({ slot, s, log: answer.log, result: interrupt ? 'interrupted' : 'stopped', rounds: stopped?.rounds ?? slotState.story?.rounds ?? 0, spans, learned: learnedOf(slotState, stopped), agents }));
    learning.start();
    afterOwnerStop(slot, id, s.stop);
    return;
  }

  // The watchdog ended it after its story ended (hung's 'ended-quiet', or watch()'s 'ended-alive'):
  // with no result printed, its own `foreman story end` result counts; with none, the resume
  // check closes the slot.
  const spent = s.stop === 'watchdog' && (s.watchdog === 'ended-quiet' || s.watchdog === 'ended-alive');
  // A ready-to-promote claim is trusted only with the park `foreman ship` saved, or the story already done.
  const checked = sessionResult(spentResult(answer.result, { spent, slotResult: slotState.result, id }), { id, parkOf: () => readPark(DIR, id), statusOf: () => stories().list().find((x) => x.id === id)?.status ?? null, storyOpen: Boolean(slotState.story) });
  const capped = signinRun({ cause: checked.run.cause, before: signins.get(id) ?? 0 });
  if (capped.streak > 0) signins.set(id, capped.streak);
  else signins.delete(id);
  const run = capped.gaveUp ? { ...checked.run, cause: null } : checked.run;
  if (capped.gaveUp) event(`${id}: its session died on the Claude sign-in ${capped.streak} times in a row while the sign-in check passed; counting it as a crash.`, 'warn', slot);
  if (checked.warn) event(checked.warn, 'warn', slot);
  if (checked.endReason) endStory(DIR, 'failed', '', checked.endReason, now(), slot);
  // No result: keep what its agents finished for the next session; a result spends the checkpoint.
  const saved = run.result === null ? saveCheckpoint(slot, s, answer) : null;
  if (run.result !== null) dropCheckpoint(slot, id);
  const ceiling = s.stop === 'watchdog' && s.watchdog === 'ceiling';
  const crash = run.result === null && !run.cause && !spent;
  let waiting = false;
  let leftBlocked = false; // the story is recorded blocked, and the picker would leave it alone
  if (run.result === 'blocked') {
    try {
      const source = stories();
      const list = source.list();
      const mine = list.find((s) => s.id === id);
      waiting = waitsOnStories(mine?.blockedBy, { idPattern: source.idPattern });
      leftBlocked = Boolean(mine) && blockedNow(mine, list, { idPattern: source.idPattern });
    } catch {
      // the vault may be briefly unreadable; then it counts as an ordinary block
    }
  }
  // The Console key ran out of credit: may later sessions use the subscription instead?
  const fallback = fallbackOf(LIVE);
  const outOfCredit = run.cause === 'api-credit' && s.usedKey;
  // It may switch: the subscription check that follows says whether a sign-in is there.
  const switchable = outOfCredit && fallback === 'subscription';
  // A story deferred on files (`foreman lock files` wrote its wait) does not need the schema token.
  const deferredOnFiles = run.result === 'deferred' && waitsOnFiles(DIR, id);
  const failCause = failCauseOf({ result: run.result, slotResult: slotState.result, id });
  const o = outcome({ result: run.result, failCause, cause: run.cause, crashesOfStory: crashes.get(id) ?? 0, committed: Boolean(slotState.story?.committedAt), waitsOnStories: waiting, waitsOnFiles: deferredOnFiles, switchable, ceiling, spent });
  if (crash) {
    crashes.set(id, (crashes.get(id) ?? 0) + 1);
    const why = ceiling ? 'stopped at the hard limit' : s.stop === 'watchdog' ? 'stopped by the watchdog' : 'the session ended without reporting a result';
    if (slotState.story) endStory(DIR, 'failed', '', why, now(), slot);
  }
  const done = readSlot(DIR, slot).result;
  const label = run.result ?? run.cause ?? (spent ? 'stopped' : 'crashed');
  const watchdog = s.stop === 'watchdog' ? { why: s.watchdog ?? null, kept: saved?.kept ?? [], redoneTokens: saved?.tokens ?? 0, redoneMinutes: saved?.minutes ?? 0 } : undefined;
  recordResult(DIR, done, recordRun({ slot, s, log: answer.log, result: label, rounds: done?.rounds ?? slotState.story?.rounds ?? 0, spans, learned: learnedOf(slotState, done), agents, cause: failCause === 'environment' && run.result === 'failed' ? 'environment' : undefined, watchdog }));
  learning.start();
  // The ship's findings are in findings.jsonl already; its follow-ups should exist while others build.
  if (run.result === 'shipped') owner.learn({ queue: true });
  if (run.result === 'shipped') closeShippedAsks(slot, id);
  // A failed ending asks the owner what to do with the story, unless an item about it is open or
  // the story goes back in line by itself.
  if (run.result === 'failed') askAboutFailed(slot, id, done, failCause);
  countEnded(run.result, id);
  // A story that ended blocked built nothing: it does not use up one of the stories `run N` asked for.
  // Only when it is recorded blocked in a way the picker leaves alone; one the picker would take
  // again at once (the session never ran `story block`) keeps counting, so `run N` still ends.
  if (run.result === 'blocked' && leftBlocked && uncountStart(id) && MAX > 0) event(`${id} was blocked and shipped nothing, so it does not count toward the ${MAX} ${MAX === 1 ? 'story' : 'stories'} asked for.`, 'info', slot);
  if (run.result === 'empty') markNothingLeft();

  if (o.claim === 'release') releaseClaim(id);
  // Files kept for this story that it never claimed go free at once, not after 30 minutes.
  if (o.claim === 'release') dropReservations(DIR, id);
  if (o.token === 'release') releaseToken(slot);
  if (o.schemaStory) addSchemaStory(id);

  if (run.result === 'shipped') queueGroupSummary(slot, id);

  const parkAfter = slotState.parkAfter === true;
  const parkedWhy = o.reason === 'ceiling' ? ceilingReason(id) : `The session crashed twice on ${id}.`;
  // A session that ended with no result: say why on the story, and what is kept for the resume.
  if (run.result === null) {
    const ending = sessionEnding({ stop: s.stop, watchdog: s.watchdog, cause: run.cause, resetAt: run.resetAt ?? null, next: o.slot, kept: saved?.kept ?? [], reason: o.slot === 'parked' ? parkedWhy : '', session: s.startedAt });
    if (ending) tellStory(slot, id, 'session', ending);
  }
  if (o.slot === 'resume') {
    // An automatic resume: startWork checks first that the story still needs a session.
    work.unshift({ slot, id, mode: '', resume: true });
    setSlot(DIR, slot, { state: 'idle', reason: '', story: null, result: null }, now());
  } else if (o.slot === 'parked') {
    setSlot(DIR, slot, { state: 'parked', parkedFor: 'crash', parkedStory: id, reason: parkedWhy, story: null, result: null }, now());
  } else if (o.slot === 'held') {
    const why = run.result === 'halted' ? 'This story stopped the release line; waiting for you to fix the cause.' : run.cause ? apiHeldText(null) : 'Committed; releases are frozen by a halt.';
    setSlot(DIR, slot, { state: 'held', reason: why, heldStory: id, haltedBy: run.result === 'halted', heldFor: run.cause ? 'api' : null, heldWas: heldSnapshot(id), story: { id, title: done?.title ?? '', stage: 'release', detail: why }, result: null }, now());
  } else {
    tidyFolder(slot, id);
    setSlot(DIR, slot, { state: parkAfter ? 'parked' : 'idle', parkedFor: parkAfter ? 'owner' : null, parkAfter: false, reason: parkAfter ? 'Parked by you.' : '', story: null, result: null }, now());
  }

  const why = o.env ? envWhy({ reason: o.reason, watchdog: s.stop === 'watchdog', note: slotState.result?.id === id ? slotState.result.note : '' }) : '';
  const after = afterOutcome(counters, o, Date.now(), id, { backoffMs: BACKOFF, why });
  counters = after.counters;
  // The time picking is held for a backoff, for the page's idle slots.
  const backoffAt = backoffShown(counters, Date.now());
  if (backoffAt !== (state().backoffUntil ?? null)) saveRun({ backoffUntil: backoffAt });
  retimeApiHeld();
  // The sign-in failed: check it before the story resumes (see account-checks.mjs).
  if (after.global === 'signin') {
    signInCheck.ids.add(id);
    checkSignIn();
  }
  if (after.global === 'backoff' && after.reason) {
    event(after.reason, 'warn');
    saveRun({ apiWait: { since: state().apiWait?.since ?? now().toISOString(), until: new Date(counters.backoffUntil).toISOString(), step: counters.backoffs } });
  } else if (counters.backoffs === 0 && state().apiWait) {
    saveRun({ apiWait: null });
  }
  // Three endings in a row were the environment: wait (held through counters.envUntil, never the
  // API wait's backoffUntil), say so, and show it as state.json's envWait. Not apiWait, which tells
  // the owner the Claude API is down.
  if (after.global === 'env-backoff') {
    event(after.reason, 'warn');
    saveRun({ envWait: { since: now().toISOString(), until: new Date(counters.envUntil).toISOString(), step: counters.envWaits } });
  } else if (state().envWait && !(counters.envUntil > Date.now())) {
    saveRun({ envWait: null });
  }
  // Already on the subscription (a session still on the key when it switched), or a check
  // already running whose answer covers this story too: nothing more to do.
  if (after.global === 'switch' && readSignIn(DIR).using !== 'subscription' && !subscriptionCheck.running) {
    Object.assign(subscriptionCheck, { since: now().toISOString(), limit: run.limit, resetAt: run.resetAt, fallback, slot });
    checkSubscription();
  }
  if (after.global === 'pause') {
    // A credit pause tries again by itself; the miss pause waits for the owner.
    const again = o.global === 'pause-credit' ? { resumeAt: resumeAtFor({ resetAt: run.resetAt, now: Date.now() }) } : {};
    if (outOfCredit) autoPause(creditPauseReason({ since: now().toISOString(), fallback, limit: run.limit, resetAt: run.resetAt }), again);
    else autoPause(run.cause === 'credit' && run.resetAt ? `${after.reason} It resets ${run.resetAt}.` : after.reason, again);
  }

  if (o.notify === 'parked') notify('parked', { slot, story: id, parkedFor: 'crash', reason: parkedWhy, log: s.log });
  else if (o.notify) notify(o.notify, { slot, story: id, log: s.log });
}

// ── the watchdog ─────────────────────────────────────────────────────────────────────────────

export function lastActivity(slot, s) {
  const times = [s.startedAt];
  for (const a of runningAgents(DIR, slot)) times.push(Date.parse(a.lastAt) || 0);
  const beat = readSlot(DIR, slot).lastBeat;
  if (beat) times.push(Date.parse(beat) || 0);
  // The session writes a stream-json event to its log for every message and tool result
  // (session.mjs), so a growing log is activity, the main conversation's own included.
  try {
    times.push(statSync(s.log).mtimeMs);
  } catch {
    // no log yet
  }
  return Math.max(...times);
}

// The watchdog's limits, from watchdog.* in the settings in effect.
const minutes = (m) => (m % 60 === 0 ? `${m / 60} ${m === 60 ? 'hour' : 'hours'}` : `${m} ${m === 1 ? 'minute' : 'minutes'}`);
// Why a slot is parked after the hard ceiling (Waiting on you, the email).
const ceilingReason = (id) =>
  `${id} was still building after ${minutes(watchdogLimits(LIVE).ceilingMinutes)} (4 times the build limit) while still making progress. Resume carries on from its last finished stage; Restart begins it again from main.`;

// Once per session, from the head of its log: a warn event when its init event shows Foreman
// loaded from anywhere but PLUGIN_DIR. The init is not written yet: try again next tick. A log
// that is cut at the bytes read and has no init is not looked at again.
function checkSessionPlugin(slot, s) {
  const head = readHead(s.log);
  const init = readInit(head.text);
  if (!init && !head.cut) return;
  s.pluginChecked = true;
  const w = initPluginWarning({ id: s.id, init, expected: PLUGIN_DIR });
  if (w) event(w, 'warn', slot);
}

export function watch() {
  const limits = watchdogLimits(LIVE);
  const graceMs = outliveMs(LIVE);
  for (const [slot, s] of sessions) {
    if (s.stop) continue;
    if (!s.pluginChecked) checkSessionPlugin(slot, s);
    const st = readSlot(DIR, slot);
    // A session still up a while after printing its final result (session-outlive.mjs).
    // No log yet: only the outlive check is skipped, the watchdog below still runs.
    let quietSince = null;
    try {
      quietSince = statSync(s.log).mtimeMs;
    } catch {
      // no log yet
    }
    if (quietSince !== null && Date.now() - quietSince >= graceMs) {
      const o = outlived({ tail: readTail(s.log), quietSince, now: Date.now(), graceMs });
      if (o) {
        event(`${s.id}: its session printed its result (${o.result}) ${Math.round(o.forMs / 1000)} s ago but is still running; ending it.`, 'warn', slot);
        killSession(slot, 'outlived');
        continue;
      }
    }
    // Its own `foreman story end` ran graceMs ago and it is still up (a workflow it started still
    // running): end it as one that printed its result; its own end stands (onExit's spent). When
    // the log already holds a printed final result, `outlived` above ends it once the log has been
    // quiet for the grace, so this stands down.
    const late = endedLate({ slotResult: st.result, slotStory: st.story, id: s.id, now: Date.now(), graceMs, tailOf: () => readTail(s.log) });
    if (late) {
      event(`${s.id}: its story ended (${late.result}) ${Math.round(late.forMs / 1000)} s ago, but its session is still running; ending it.`, 'warn', slot);
      s.watchdog = 'ended-alive';
      killSession(slot, 'watchdog');
      continue;
    }
    const committedAt = st.story?.committedAt;
    // Progress: a stage or detail change, or an agent starting or finishing (state.mjs), or an
    // agent's tool step (the newest lastAt in the slot's agent files; one older than the session
    // does no harm, hung takes the max with the start).
    const progressAt = Math.max(s.startedAt, Date.parse(st.story?.progressAt) || 0);
    const step = newestStep(runningAgents(DIR, slot));
    // startSession clears the slot's result, so a result for this story is this session's own
    // `foreman story end`.
    const input = {
      startedAt: s.startedAt,
      committedAt: committedAt ? Date.parse(committedAt) : null,
      lastActivity: lastActivity(slot, s),
      progressAt,
      stepAt: step?.at ?? null,
      stage: st.story?.stage ?? null,
      ended: st.result?.id === s.id,
    };
    const t = Date.now();
    let why = hung(input, t, limits);
    // A session whose story is settled or whose pull request merged is judged as an ended one:
    // only the quiet limit applies. s.shipped is kept, so gh is asked at most once per session;
    // it is asked in a child, and the session is judged again on the tick that has the answer.
    if (why && why !== 'ended-quiet') {
      if (s.shipped === undefined && SETTLED.includes(statusOf(s.id))) s.shipped = true;
      else if (s.shipped === undefined) {
        s.shippedLookup ??= lookUpMerged(s.id).then((pr) => {
          s.shipped = pr !== null;
        });
        continue;
      }
      if (s.shipped) why = hung({ ...input, ended: true }, t, limits);
    }
    if (!why) continue;
    if (why === 'ended-quiet') {
      event(`${s.id}: its story has ended, but its session has had no activity for ${minutes(limits.quietMinutes)}; ending it without a resume.`, 'warn', slot);
      s.watchdog = 'ended-quiet';
      killSession(slot, 'watchdog');
      continue;
    }
    const text = {
      'too-long': `no progress for ${minutes(limits.buildMinutes)} (no stage change, no agent starting or finishing and no agent step; ${lastProgressText({ startedAt: s.startedAt, progressAt: Date.parse(st.story?.progressAt) || null, step }, t)}); stopping the session to resume it.`,
      quiet: `no activity for ${minutes(limits.quietMinutes)}; stopping the session to resume it.`,
      ceiling: `still building after ${minutes(limits.ceilingMinutes)} although it is making progress; stopping it and asking you what to do.`,
    }[why];
    event(`${s.id}: ${text}`, 'warn', slot);
    s.watchdog = why;
    killSession(slot, 'watchdog');
  }
}

// An adopted session is not this process's child, so no exit event comes for it: its pid is
// polled instead (handover.mjs sessionAlive).
export function pollAdopted() {
  for (const [slot, s] of sessions) if (s.adopted && !sessionAlive(s)) onExit(slot, s);
}

// ── start-up reconciliation ──────────────────────────────────────────────────────────────────

// What start-up must do, from the ship lock, the claims, merged pull requests and the stories.
// Reads only.
export function recoveryPlan() {
  const ship = holderOf(SHIP(DIR));
  const all = stories().list();
  let merged = [];
  const prs = sh('gh', ['pr', 'list', '--state', 'merged', '--limit', '50', '--json', 'headRefName,mergedAt'], { cwd: ROOT, ...NET_LIMIT });
  if (prs.status === 0) {
    try {
      merged = closableMergedIds(shippedBranches(JSON.parse(prs.stdout), all, CONFIG.branchPrefix, rolledBackOf), all, CONFIG.branchPrefix);
    } catch {
      // carry on without it
    }
  }
  const remote = sh('git', ['ls-remote', '--heads', CONFIG.remote, `${CONFIG.branchPrefix}*`], { cwd: ROOT, ...NET_LIMIT }).stdout;
  const hasBranch = (id) => remoteHasBranch(remote, branchOf(id)) || git(ROOT, 'rev-parse', '--verify', '--quiet', branchOf(id)).status === 0;
  const inProgress = all.filter((s) => s.status === 'in-progress').map((s) => ({ id: s.id, branch: hasBranch(s.id) }));
  return reconcile({
    shipLock: ship ? { story: ship.story, slot: ship.slot, stage: ship.stage, stale: ship.stale } : null,
    claims: claims(DIR),
    mergedNotDone: merged,
    inProgress,
    mustFinish: mustFinishFor(CONFIG),
    readyToPromote: all.filter((s) => s.status === READY).map((s) => s.id),
    priority: [...all].sort(byPriority).map((s) => s.id),
  });
}

export function reconcileStart() {
  const plan = recoveryPlan();
  // A story an adopted session runs, or one already queued, is not queued again (nor its event).
  const inHand = new Set([...[...sessions.values()].map((s) => s.id), ...work.map((w) => w.id)]);
  let quiet = false;
  const ranked = [];
  for (const e of recoverySteps(plan)) {
    if (e.do === 'break-ship') breakIfStale(SHIP(DIR));
    else if (e.do === 'break-claim') breakIfStale(claimFile(DIR, e.id));
    else if (e.do === 'queue') {
      quiet = inHand.has(e.id);
      if (quiet) continue;
      const w = { slot: e.slot, id: e.id, mode: e.mode, ...(e.from ? { from: e.from } : {}), ...(e.ranked ? { ranked: true } : { finish: true }) };
      work.push(w);
      if (w.ranked) ranked.push(w);
    } else if (e.do === 'event') {
      if (!quiet) event(e.text, e.kind, e.slot);
      quiet = false;
    }
  }
  // A start-up resume is not pinned to its old slot, and a pick into that slot would find the
  // story's branch checked out and its changes in the way. So each old folder is freed now: its
  // unfinished work committed on the story branch (the checkpoint's tree, so the finished stages
  // are kept) and the folder detached and clean. The story skill's resume rule checks the branch
  // out again. An adopted session's folder is never touched.
  for (const w of ranked) {
    if (!w.from || !slotNumber(w.from) || sessions.has(w.from)) continue;
    const branch = branchOf(w.id);
    const r = freeStoryFolder({ path: worktreeOf(DIR, slotNumber(w.from)), id: w.id, branch, from: w.from, to: null, base: BASE_REF, generated: CONFIG.generated, message: `${w.id} WIP: kept at start-up from slot ${w.from}` });
    if (r.freed) {
      if (r.committed) event(`Start-up: ${w.id}'s unfinished work in ${w.from} is committed on ${branch}.`, 'info', w.from);
    } else {
      w.slot = w.from;
      delete w.ranked;
      event(`Start-up: could not free ${w.from}'s folder for ${w.id} (${r.problem}); it resumes in ${w.from}.`, 'warn', w.from);
    }
  }
  // A stale schema token whose story is not being resumed is let go.
  const token = holderOf(SCHEMA(DIR));
  if (token?.stale && !work.some((w) => w.id === token.story)) breakIfStale(SCHEMA(DIR));
  // Slots of a run that died are idle now unless parked, held or down (parked and down wait for the owner; held ones for the API's wait or a halt).
  for (const slot of SLOT_IDS) {
    if (sessions.has(slot)) continue; // an adopted session's slot keeps its story
    const st = readSlot(DIR, slot);
    if (['building', 'waiting'].includes(st.state)) setSlot(DIR, slot, { state: 'idle', story: null }, now());
  }
  return plan;
}

// After a restart on new code: the sessions, queued work and crash counts the old process handed
// over (see the header of supervisor.mjs). This process vouches for the pids their locks name from now on. The
// adopted sessions are in `sessions` before the first await, so a stop from then on ends them. A
// handed-over session it cannot adopt (a slot this config does not have, a second one for a slot)
// is ended, SIGTERM then SIGKILL, and its claim and locks let go, so start-up recovery can resume
// its story in a slot this process has. adoptCarried is synchronous: it adopts, pushes what it kept
// onto `kept` (main() words the one "Kept N" event) and returns the sessions it could not adopt,
// which endDropped ends once the live scan has run.
export function adoptCarried(kept) {
  const list = adoptable(CARRIED?.sessions, SLOT_IDS);
  const dropped = leftOut(CARRIED?.sessions, list);
  for (const pid of adoptedPids(CARRIED?.pid, [...list, ...dropped])) OWN.add(pid);
  const vouched = [...OWN].filter((p) => p !== ME);
  if (vouched.length) writeAdopted(DIR, { by: ME, pids: vouched });
  for (const a of list) {
    sessions.set(a.slot, { child: null, pid: a.pid, id: a.id, mode: a.mode, startedAt: a.startedAt, log: a.log, usedKey: a.usedKey, holderPid: a.holderPid, stop: null, adopted: true, pluginChecked: true });
  }
  for (const w of Array.isArray(CARRIED?.work) ? CARRIED.work : []) if (typeof w?.id === 'string') work.push(w);
  const carriedCrashes = CARRIED?.crashes && typeof CARRIED.crashes === 'object' ? CARRIED.crashes : {};
  for (const [id, n] of Object.entries(carriedCrashes)) if (Number.isInteger(n) && n > 0) crashes.set(id, n);
  kept.push(...list);
  return dropped;
}

export async function endDropped(dropped) {
  for (const d of dropped) {
    event(`${d.id}: its session in ${d.slot} could not be kept across the restart; ending it.`, 'warn', null);
    // Signalled only while ps shows it is still that story's session, never a reused pid.
    if (sessionAlive(d)) {
      try {
        process.kill(-d.pid, 'SIGTERM');
      } catch {
        // already gone
      }
      for (let waited = 0; sessionAlive(d) && waited < STOP_WAIT_MS; waited += 250) await sleep(250);
      if (sessionAlive(d)) {
        try {
          process.kill(-d.pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
    releaseClaim(d.id);
    if (typeof d.slot === 'string') releaseToken(d.slot);
  }
}

// Story sessions already running in the slots' folders that neither a start-up nor a handover
// brought in (live-sessions.mjs): after a hard kill or a crash, or a restart whose handover did
// not reach this process. Every slot folder is scanned. For a slot with no session in hand, the
// oldest session running in its folder is adopted as a handed-over one is, so start-up recovery
// does not start its story again beside it. Its claim names the supervisor that started it; this
// process vouches for that pid (supervisor-adopted.json), as it does after a handover. A claim a
// live run of someone else holds is said so once and left alone. A slot already in hand (a
// handed-over session, say) only gets the double warning when its folder has a second session.
// The second session is never ended from here. An unmarked session in a folder with a double gets
// an empty log, never the other session's transcript. usedKey is not known for a session found
// this way, so it reads as no key. The caller owns `found` ({ kept, doubles }) and words the
// events; `skip` are pids being ended. A failure is a warn event and the start goes on.
export const adoptLive = guarded('the live sessions scan', (found, skip = []) => {
  const list = listStorySessions();
  if (!list?.length) return;
  const folders = Object.fromEntries(SLOT_IDS.map((slot) => [slot, worktreeOf(DIR, slotIndex(slot) + 1)]));
  const held = Object.fromEntries([...sessions].map(([slot, s]) => [slot, { pid: s.pid, id: s.id }]));
  const { keep, doubles } = planLive({ list, folders, held, own: [...[...sessions.values()].map((s) => s.pid), ...skip] });
  found.doubles.push(...doubles);
  const doubled = new Set(doubles.map((d) => d.slot));
  try {
    for (const a of keep) {
      const { holderPid, heldBy } = holderFor({ claim: claims(DIR).find((c) => c.id === a.id), slot: a.slot, ours: OWN, me: ME });
      if (heldBy) {
        event(`${a.id}: a session (pid ${a.pid}) is running in ${a.slot}, but ${heldBy} holds the story; leaving it alone.`, 'warn', a.slot);
        continue;
      }
      const log = logFor({ mark: readMark(DIR, a.slot), kept: a, doubled: doubled.has(a.slot), folder: join(DIR, 'logs') });
      OWN.add(holderPid);
      sessions.set(a.slot, { child: null, pid: a.pid, id: a.id, mode: a.mode, startedAt: Date.now() - a.ageMs, log, usedKey: false, holderPid, stop: null, adopted: true, pluginChecked: true });
      found.kept.push(a);
    }
  } finally {
    const vouched = [...OWN].filter((p) => p !== ME);
    if (vouched.length) writeAdopted(DIR, { by: ME, pids: vouched });
  }
});
