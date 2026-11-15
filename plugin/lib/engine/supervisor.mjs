// Foreman's supervisor: runs up to config.slots stories at once, one per slot, each in a fresh
// Claude session (`claude -p "/foreman:story <ID>"`, built by session.mjs) inside the slot's
// own worktree and environment. Started by `foreman run` from the main checkout, which it
// never builds in. A slot environment's prepare may answer later (slot-prepare.mjs): the slot
// shows building, 'preparing the slot', and is skipped until it settles; a rejection puts the
// slot down with the reason.
//
//   node lib/engine/supervisor.mjs [--workers 1-<slots>] [--max N] [--once] [--exit-when-idle] [--dry-run]
//
// It owns: picking (with claims, the schema token, and skipping a story deferred on files
// another running story holds, file-locks.mjs; a file a story lets go of is kept for 30 minutes for
// the highest-priority story waiting on it, and a lower-priority story whose design names a file
// that story waits on is left alone meanwhile), starting and watching sessions, the
// watchdog, what each ending means (scheduler.mjs), the owner's commands (control.json), the
// halt and "I've fixed it", automatic pauses, emails, publishing the state to the console,
// start-up reconciliation after a run that died, and applying the owner's answers (answers.mjs):
// those that need no story on every tick, the rest when no session runs. Decisions live in the
// small modules it imports; this file wires them together.
//
// The parts of the supervisor, each in its own file in this folder. This file is the entry point:
// its imports wire them together, and it holds the loop (tick), the stop, the restart on new code
// and main. No part imports this file, which ends in `await main()`.
//
// The run-context.mjs import comes after the other imports and before the other parts: every
// module imported above it loads before run-context.mjs's start-up code runs (it reads the config
// and takes the leash variables out of the environment), as when the supervisor was one file whose
// own code ran after all its imports, and the parts that follow it use what that code set up.
//
//   run-context.mjs     what the run reads once at start, and the state every part shares
//   slot-starts.mjs       picking and starting a story in a slot, the claim sweeps
//   session-lifecycle.mjs a session's ending, the watchdog, the sessions found at start
//   owner-controls.mjs    the owner's control.json commands and answers as the loop applies them
//   story-followups.mjs   what an ending leaves on the story and on Waiting on you
//   standby.mjs           standby and the owner task watch
//   session-records.mjs   session files and check runs, the checkpoints
//   background-jobs.mjs   the park watch, the environment sweep, the learning tick
//   account-checks.mjs    the Claude account checks: sign-in, credits, the subscription
//   story-claims.mjs      the schema token, the claims and the file reservations
//   owner-commands.mjs    the `foreman notify` and `foreman learn` children
//   dry-run.mjs           --dry-run: what each slot would start
//
// --dry-run prints what each slot would start and writes nothing.
//
// `run N` counts only the new stories it picks. The stories start-up recovery queues (a resume, a
// release to finish, a story to close), and the live sessions a fresh start adopts, are resumed on
// top and never count towards N (asked-for.mjs).
// A fresh start says how many at the start (stdout and an event), keeps state.json's `asked { max,
// resumed }` for `foreman status`, and the stop line names the resumed stories that also shipped.
//
// Session files and check runs: see session-records.mjs.
//
// Standby and the owner task watch: see standby.mjs.
//
// Leash and strays: a supervisor that belongs to a test or a scratch copy ends on its own
// (leash.mjs). With FOREMAN_LEASH_PID set (tests set it through test/supervisors.mjs, and
// `foreman run` in a story session sets it to the shell that ran it), it stops with "Stopped:
// the process that started this run (pid N) has ended." within a tick or two of that process
// going. With a leash pid, or a state folder under the temp folder, it also stops after
// FOREMAN_IDLE_EXIT_MS (5 min) on standby, "Stopped: on standby for N min, and this run belongs
// to a test or a scratch copy.". Both are a normal stop (exit 0, the loop 'stopped'). The two
// variables are read once at start and taken out of this process's environment, so no session
// or child inherits them; a restart on new code gets them again from startSupervisor's own
// environment. A real run (no leash, state outside the temp folder) has neither limit. A run
// with no leash, not --once and not --dry-run, looks for stray supervisors (strays.mjs, not this
// run's, in temp folders or this project's folders) at its first loop and every 10 minutes, and
// keeps their pids in state.json's strays { pids, mb, at } (null when there are none), written
// only when the list changes (the decision is strays.mjs strayPatch); no event and no
// notification. It keeps the last list when ps cannot run. Waiting on you shows them as the run:strays FYI, and `foreman doctor --end-strays`
// or the dashboard's End them ends them.
//
// A real run writes its pid to <stateDir>/supervisor.pid and removes it as it exits
// (supervisor-pid.mjs), so `foreman run` and `foreman service install` can tell one is going.
// `foreman run` starts this process in its own session, the service manager through
// `foreman run --service` (service.mjs); the exit codes are the same either way, and a clean
// exit (0) is one the service does not restart.
//
// FOREMAN_DASHBOARD_HOST, when set, is the address the dashboard listens on instead of
// console.host (the container runner sets 0.0.0.0).
//
// The loop rests 5 s between ticks. FOREMAN_TICK_MS, for tests, can shorten that (to 50 ms at
// the least, never longer than 5 s; tickMs in wake.mjs). FOREMAN_CPU_SAMPLE_MS, for tests, can
// shorten the progress watchdog's once-a-minute CPU sample (to 500 ms at the least; cpuSampleMs in
// session-cpu.mjs). FOREMAN_BACKOFF_MS, for tests, can shorten the 15-minute backoff after a rate
// limit or outage (to 1 s at the least, never longer; backoffMs in scheduler.mjs).
// FOREMAN_CREDIT_RETRY_MS, for tests, can shorten the 30 minutes between probes of a credit pause
// that keeps failing (to 1 s at the least, never longer; creditRetryMs in credit-resume.mjs).
//
// --once is for a scheduled job (`foreman cloud tick`): no dashboard, no "stopped" email at
// the end of each job, and it stops as soon as nothing is running and nothing may start
// (paused, halted, picking held, or no slot free to pick), where a normal run waits for that
// to change.
//
// New code: when the plugin sits in the project's own checkout (ownCheckout), each tick first
// fast-forwards that checkout's base branch to the tracking ref the merge step's fetch moved
// (anchor-pull.mjs), so a merged story of this repo needs no hand pull. It does so only on the
// base branch, and with no tracked change that the incoming commits also change (any other
// tracked change is kept across the move); otherwise it logs one warn per new base sha and
// leaves the checkout alone. Any such wait is also kept in state.json as anchorWait, the
// run:anchor item on Waiting on you, until the checkout moves. It never fetches, and is skipped
// while stopping.
// When the plugin code this process was loaded from changes under it (a commit to
// plugin/ when Foreman builds its own repo, or a new plugin version; code-version.mjs), it
// starts no new story and restarts in the tick that sees the change, before any pick, or in the
// first tick after the slots being set up are ready, the sessions being stopped have ended
// (neither can be handed over), the sessions whose result is already in their log have exited
// and had their ending handled (handover.mjs resultArrived: they are ending, so "Kept N" never
// names a story that just ended) and the park watch's check has ended. It checks that the new code accepts the config (`foreman
// config check`, else it logs why and carries on with the code it has), saves the run's counts
// in state.json's `restart` with the sessions still running, the queued work and the crash
// counts (handover.mjs), logs one "Restarted on new code (<old> -> <new>)." event (a restart
// onto another Node, in run-context.mjs's header, is the same handover with its own event text) and exits 75
// (RESTART_EXIT), leaving the sessions running: it never stops them, and records no ending after
// the handover. Only `startSupervisor` (run.mjs, so `foreman run`, `cloud tick` and `cloud run`)
// starts it again, with FOREMAN_RESTART=1: the new process carries on the run (its counts,
// --max, skipped stories, totals) with no "started" event, adopts the sessions (one "Kept N
// running across the restart" event) as the first thing main() does once it has written its pid,
// before state.json's `restart` is cleared and before the console, the dashboard and Jira, so a
// stop or a crash from then on cannot leave them unwatched. A handed-over session it cannot adopt
// (a slot its config no longer has, or a second one for a slot) is ended with a warning, and its
// claim and locks are let go for start-up recovery. It queues the work, and polls each adopted
// session's pid every tick and while stopping (handover.mjs sessionAlive, which also checks the
// pid is still that story's session). The watchdogs cover adopted sessions as their own, and an adopted
// session's ending is handled as any other's, from its log. The sessions keep the old
// supervisor's pid as FOREMAN_SUPERVISOR_PID, so their claims and locks name it:
// supervisor-adopted.json (supervisor-pid.mjs) vouches for those pids, written by the old
// process before it exits (vouched for by its parent, startSupervisor's loop, which outlives it)
// and again by the new one for itself, so those locks never look stale (locks.mjs). A fresh
// start (not FOREMAN_RESTART) removes a supervisor-adopted.json left behind (a hard kill, a crash
// before the adoption): no handover is in flight, so nothing is vouched for. The new
// process holds those claims and locks as its own. A STOP wins over a pending restart, and a dry
// run never watches the code. Until it restarts, state.json's restartPending { from, to, since }
// says so (`since` is when the first change was seen): the run:restart FYI on Waiting on you, a
// line in `foreman status`, and idle slots reading "waiting for restart". It is cleared on the
// restart, a refusal, a stop or a start. While supervisor.pid names a process that is no longer a
// supervisor (a hard kill), status, Waiting on you and the page do not show it (state.mjs
// restartPendingOf). A signal (Ctrl-C, kill, a closed terminal) that arrives while it exits for
// the restart ends the run instead: it stops the sessions it was handing over, exits 130
// (INTERRUPT_EXIT) with the loop stopped, and startSupervisor does not start it again.
//
// A loop error that repeats is logged once, then once more with its count when it clears
// (repeats.mjs).
//
// A STOP names who asked (console/stopper.mjs): the event says so, and a stop that came from
// neither the owner's terminal, a browser on the dashboard nor the cloud runner (a story
// session's, say) emails the owner at once (`unexpected-stop`). Once taken, the record is kept
// in last-stop, so status and the dashboard still name who stopped a cloud run; a fresh start
// removes it, and a restart on new code keeps it. A session ended by an interrupt
// keeps its Claude Code transcripts (session-files.mjs), with an event naming them. An interrupt
// that comes while an agent of a session had just run a kill, pkill or killall (the last minute)
// says so instead of "Ctrl-C, kill or a closed terminal": the event names the story and the slot,
// and last-interrupt keeps it for `foreman doctor` (signal-source.mjs).
//
// File reservations: see story-claims.mjs.
//
// Checkpoints: see session-records.mjs.
//
// Progress: after every loop the progress watchdog (progress-watch.mjs) checks that the run is
// moving: no loop error repeating for watchdog.errorMinutes (5), no buildable story left
// unstarted with a slot free for watchdog.idleMinutes (10), and no session without activity (a
// stage event, output in its session log, a hook step, or CPU use, session-cpu.mjs) for
// watchdog.activityMinutes (20). When one holds it records state.json's stuck { kind, since,
// reason } (the run:stuck item on Waiting on you, "running, but stuck" in `foreman status`), logs
// one warn event and sends one `stuck` notification per episode; it logs once more when work
// moves again. A session with activity whose stage is older than watchdog.progressMinutes (45)
// is slow: state.json's slow (an FYI on Waiting on you and in `foreman status`), with no event
// and no notification. It never stops a session (that is watch()). A late wake restarts its
// clocks, and a run that starts or stops clears stuck and slow.
//
// Learning: see background-jobs.mjs.
//
// Held loop: no child that can take long holds the loop. A slot's install and the fetch of a new
// pick (and the base fetch of a new folder) run in children of the slot (worktree.mjs
// prepareWorktree, runAsync), while the slot says "preparing the slot" and counts as preparing;
// the owner's answers apply one step at a time in children, and while they do no story starts
// (an answer that failed is tried again after 1, 2, 5, 15 and then 30 minutes, or when the owner
// presses Retry: startAnswers);
// a session that ended is read (log, transcripts, the working tree hash a session with no result
// needs) in a child of its own (session-close.mjs), the slot saying "closing the session" and
// counting as in hand; `foreman health` after "I've fixed it" and the merged pull request
// look-ups (the watchdog's, a resume's) run in children too. A stop ends the slots' children at
// once and the loop's after the 10 s wait (a restart on new code ends them before it exits).
// What still runs synchronously is short git bookkeeping through `sh` (the dirty check, a
// checkout, leftovers), the start-up recovery and the new-code check; the gh calls and `git
// ls-remote` end within 30 s (NET_LIMIT), the dashboard's git within 5 s and its key tests and
// set-up shells within 2 minutes. loop-holds.mjs recordSyncChildren times every synchronous child
// of this process, whichever module starts it, and keeps any that took a second or more; a late
// wake's event then names the command that held the loop (wake.mjs). The dashboard's step checks
// run in a child of their own and hold nothing.
//
// Platform credits, a sign-in that stops working, a usage limit or an empty balance: see account-checks.mjs.
//
// Jira: with `stories.adapter: "jira"` this process never waits on Jira. Every story source it
// opens (its own, the state snapshot's, the dashboard's) reads only the poll cache and queues
// its Jira writes; the refresher (lib/jira/refresher.mjs) polls, sends and fetches briefs with
// await on its own timer. Salesforce Cases (`stories.adapter: "salesforce"`) work the same way,
// with adapters/stories/salesforce-refresher.mjs, which does the sf calls in a child process, so
// the loop never calls sf itself; "Jira" below reads "Salesforce" for them. While the last poll failed, or the cache is older than 5 polls,
// picking holds with the reason as the loop's state; stories in progress carry on. A story
// whose brief is not fetched yet waits a tick while the refresher fetches it (a story the owner
// asked for next is waited for, with nothing else started before it). After a late wake
// (the computer slept or the loop was held), the loop logs a warn event, naming the command that
// held the loop when one was recorded (see Held loop), and asks the refresher for a fresh poll
// (wake.mjs) before the next tick judges the cache, so a sleep does not show "Jira not
// reachable" and a real outage still does.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adoptLegacySchemaLock } from './locks.mjs';
import { backoffShown, canPick, canResume, NOTHING_LEFT, SETTLED, STANDBY, whenNothingLeft } from './scheduler.mjs';
import { fetchStoryTarget } from './story-source.mjs';
import { creditProbeDue } from './credit-resume.mjs';
import { PROBE_EVERY_TICKS, probeDue, SIGNIN_PAUSE } from './signin-probe.mjs';
import { haltReason } from './halt-reason.mjs';
import { stuckLimits, stuckTitle } from './progress-watch.mjs';
import { afterSignal, codeChange, INTERRUPT_EXIT, nextPending, PLUGIN_DIR, RESTART_EXIT, restartStep } from './code-version.mjs';
import { adoptedPids, handoverSessions, keptText, resultArrived, sessionAlive } from './handover.mjs';
import { copyWarning, ownCopy } from './plugin-copy.mjs';
import { openConsole } from './console.mjs';
import { startDashboard } from '../dashboard/server.mjs';
import { ENV_SWEEP_MS, PARK_CHECK_MS } from './background-jobs.mjs';
import { dryRun } from './dry-run.mjs';
import { inHandAtStart, reachedLine, resumedLine } from './asked-for.mjs';
import { standbyWatch } from './standby.mjs';
import { keepAwake, keepAwakeCommand } from './startup.mjs';
import { loopRest } from './wake.mjs';
import { hasWork, peekWork, rehome, takeable, takeWork } from './slot-work.mjs';
import { envSweepDue } from './slot-prepare.mjs';
import { restartFor } from './node-path.mjs';
import { doubleText } from './live-sessions.mjs';
import { EVERY_TICK, mayApplyAnswers } from './answers.mjs';
import { clearAdopted, clearPid, dropAdopted, writeAdopted, writePid } from './supervisor-pid.mjs';
import { interruptReason, signalSource, SIGNAL_WINDOW_MS, writeInterrupt } from './signal-source.mjs';
import { alive, leashVerdict } from './leash.mjs';
import { findStrays, strayPatch } from './strays.mjs';
import { clearLastStop, stopperDetail, takeStop, unexpectedStop } from '../console/stopper.mjs';
import { parkWatchDue, readParks } from './parks.mjs';
import {
  clearAgents,
  readSlot,
  redact,
  rotateEvents,
  runningAgents,
  setLoop,
  setWorkers,
  stageMap,
  startTotals,
} from './state.mjs';
import { anchorSh, applySettings, ARTIFACTS, autoPaused, checkCredit, checkSignIn, closing, CODE, CODE_AT_START, CONFIG, control, cpu, crashes, creditCheck, DIR, DRY, endChildren, envAdapter, envSweep, event, EXIT_WHEN_IDLE, fileWaiters, finished, FOREMAN_BIN, guarded, HALT, haltSeen, handled, jira, keptOut, learning, LEASH, LEASHED, LIVE, loaded, lookUpMerged, loopChildren, loopErrors, markHandled, MAX, ME, mergedFor, NODE, notify, now, ONCE, OWN, OWN_CHECKOUT, owner, parkWatch, pickStory, preparing, progress, pullAnchor, RESTARTED, resumed, resumedShipped, ROOT, runningCount, saveQueued, saveRun, saveTeamAtStart, schemaExtra, schemaFree, SESSION_PLUGIN, sessions, setHaltSeen, sh, shipped, signInCheck, skipped, sleep, SLOT_IDS, slotChildrenOf, slotIndex, START, startEnvSweep, startParkWatch, state, statusOf, STOP, STOP_WAIT_MS, stories, subscriptionCheck, sweepAtStop, sweepLeftCheckJobs, sweepLeftSessionFiles, TICK_MS, work, workers } from './run-context.mjs';
import { endedFolderStory, forgetStaleNextStart, killSession, launches, nextStarting, nothingLeft, pick, PICK_WAITS, resumeYields, settleRunningRequest, started, startWork, sweepClaims, sweepOwnerClaims } from './slot-starts.mjs';
import { adoptCarried, adoptLive, counters, endDropped, lastActivity, onExit, pollAdopted, reconcileStart, recoveryPlan, setHandedOver, watch } from './session-lifecycle.mjs';
import { answersRun, commands, fixCheck, releaseApiHeld, startAnswers } from './owner-controls.mjs';
import { closeDoneHaltTasks, flushNotes } from './story-followups.mjs';

let restartPending = null; // { from, to, id, since } once the code changed (setRestartPending)
let refusedCode = null; // the code id whose config check failed: not tried again
let awake = null; // keep-awake (startup.mjs keepAwake), set in main()
let stopping = false;
let exiting = null; // null, 'stop' or 'restart'
let interrupted = false; // a signal came while exiting for a restart
let interruptSource = null; // the session whose agent had just run a kill when the signal came (signal-source.mjs)
let starvedId = null; // the story the last tick could have started and did not

// The session whose agent ran a kill command in the last minute, or null. Never throws: a signal
// is already being handled. Read before stop(), which clears the agents.
function sourceNow() {
  try {
    const agents = SLOT_IDS.flatMap((slot) => runningAgents(DIR, slot).map((a) => ({ slot, story: sessions.get(slot)?.id ?? a.story ?? null, raw: a.raw, lastAt: a.lastAt })));
    return signalSource({ agents, now: now(), windowMs: SIGNAL_WINDOW_MS });
  } catch {
    return null;
  }
}

// The interrupt reason, kept in last-interrupt for `foreman doctor` (a file that cannot be written
// costs only that line).
function interruptNow() {
  try {
    writeInterrupt(DIR, { at: now().toISOString(), ...(interruptSource ? { story: interruptSource.story, slot: interruptSource.slot, command: interruptSource.command } : {}) });
  } catch {
    // the stop goes on
  }
  return interruptReason(interruptSource);
}

// The pending restart, kept in state.json (without its code id) for status and the page.
function setRestartPending(next) {
  if (next === restartPending || (!next && !restartPending)) return;
  restartPending = next;
  saveRun({ restartPending: next ? { from: next.from, to: next.to, since: next.since } : null });
}

// ── the progress watchdog ────────────────────────────────────────────────────────────────────

// After each loop: whether the run is making progress (see the header). `error` is the loop's
// error text, or null when it ran clean; a throwing loop leaves the idle clock as it is.
const checkProgress = guarded('the progress watchdog', (error) => {
  const stages = stageMap(LIVE);
  const list = [...sessions]
    .filter(([, s]) => !s.stop)
    .map(([slot, s]) => {
      const story = readSlot(DIR, slot).story;
      const agents = runningAgents(DIR, slot);
      // Log output, hook steps and agents' last steps (lastActivity), or the session's CPU.
      const pid = s.pid;
      const busyAt = pid ? cpu.activeAt(slot, pid, Date.now()) : null;
      return {
        slot,
        id: s.id,
        progressAt: Math.max(s.startedAt, Date.parse(story?.progressAt) || 0),
        activeAt: Math.max(lastActivity(slot, s), busyAt ?? 0),
        // The same stage snapshot() shows: a running agent's, else the story's.
        stage: agents.map((a) => stages[a.role]).find(Boolean) ?? story?.stage,
        rounds: story?.rounds ?? 0,
        steps: agents.reduce((sum, a) => sum + (Number(a.tools) || 0), 0),
      };
    });
  const r = progress.loop({ now: Date.now(), error, starved: error ? undefined : starvedId, sessions: list }, stuckLimits(LIVE));
  if (r.changed) saveRun({ stuck: r.stuck });
  if (r.slowChanged) saveRun({ slow: r.slow });
  if (r.fresh) {
    const text = `${stuckTitle(r.stuck.since, now())}: ${r.stuck.reason}`;
    event(text, 'warn');
    notify('stuck', { reason: text });
  }
  if (r.cleared) event('Making progress again.', 'info');
});

// ── the loop ─────────────────────────────────────────────────────────────────────────────────

// ── the console ──────────────────────────────────────────────────────────────────────────────

// The artifacts console is pushed by sync.mjs, a child of its own, because each push is a
// Claude call that takes seconds; the push itself is in lib/adapters/console/artifacts.mjs.
// Every other console is sent the snapshot from here, when it changed and at least every few
// minutes.
const SYNC = fileURLToPath(new URL('./sync.mjs', import.meta.url));
let consoleAdapter = null;
let dashboard = null; // the dashboard's server, when console.adapter is `dashboard`

const { publish, enterStandby, checkOwnerTasks, leaveStandby, standbyOn, standbySince } = standbyWatch({
  root: ROOT,
  config: CONFIG,
  dir: DIR,
  tickMs: TICK_MS,
  dry: DRY,
  settings: () => LIVE,
  consoleAdapter: () => consoleAdapter,
  awake: () => awake,
  stopping: () => stopping,
  exiting: () => exiting,
  owner,
  notify,
  state,
  saveRun,
  event,
  now,
});

// ── the loop ─────────────────────────────────────────────────────────────────────────────────


// The stray supervisors (see the header), at the first loop and every STRAY_CHECK_MS after,
// for a run with no leash; state.json's strays changes only when the pids do.
const STRAY_CHECK_MS = 10 * 60_000;
let strayCheckAt = 0;
function checkStrays() {
  if (LEASHED || ONCE || DRY || Date.now() < strayCheckAt) return;
  strayCheckAt = Date.now() + STRAY_CHECK_MS;
  try {
    const patch = strayPatch(state().strays, findStrays({ root: ROOT, dir: DIR }), now().toISOString());
    if (patch) saveRun(patch);
  } catch {
    // a look that fails changes nothing; the next one tries again
  }
}

// Stops the sessions still running (SIGTERM, then SIGKILL for any still there after 10 s),
// deletes the slot environments of the stories that closed (up to 60 s; an interrupted, held or
// claimed story keeps its own), records why, emails, and exits. `loop` is the state left for the console.
async function stop(code, reason, { loop = code === 2 ? 'halted' : 'stopped' } = {}) {
  if (exiting) return;
  exiting = 'stop';
  stopping = true;
  // Nothing launches after stopping begins; a slot being set up loses its install or fetch.
  preparing.close();
  for (const set of slotChildrenOf.values()) endChildren(set);
  try {
    const running = [...sessions.entries()];
    for (const [slot] of running) killSession(slot, 'interrupt');
    for (let waited = 0; (sessions.size > 0 || closing.size > 0 || answersRun || parkWatch.child || learning.running()) && waited < STOP_WAIT_MS; waited += 250) {
      await sleep(250);
      pollAdopted();
    }
    // What the loop still has running (an answer step, a session read) is not waited for any longer.
    endChildren(loopChildren);
    for (const [, s] of running) {
      try {
        process.kill(-s.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    for (const t of loopErrors.clear(now())) event(t, 'warn');
    // The sessions are gone, so the slot environments of closed stories can go too (up to 60 s).
    await sweepAtStop();
    awake?.release();
    setLoop(DIR, loop, reason);
    clearAgents(DIR);
    jira?.stop();
    console.log(reason);
    // The last `foreman learn` (a problem there only costs the proposals) and the stopped or
    // halted email, side by side, so the stop waits for the slower and not for both in turn. A
    // scheduled job ending is not news; a halt is.
    await owner.finish(code === 2 || !ONCE ? (code === 2 ? 'halted' : 'stopped') : null, { reason, stories: finished, shipped });
    // After the email, which may still need the last good config: a stopped run is on no config,
    // and is never stuck.
    saveRun({ configProblem: null, stuck: null, slow: [], restartPending: null, skipped: [], apiWait: null, envWait: null, anchorWait: null, backoffUntil: null, answerFailures: [], learningFailed: null, asked: null });
    await publish(true).catch(() => {});
    // The emails still on their way: their children are detached, so they would outlive this
    // process, but an exit before they end would lose their warnings.
    await owner.settled();
    dashboard?.close();
  } catch (err) {
    console.error(`Supervisor error while stopping: ${err?.message ?? err}`);
  } finally {
    process.exit(code);
  }
}

// Exits for startSupervisor to start this run again on the new code (see the header): no slot
// is being set up and no session is being stopped by now. The run's counts, the sessions still
// running, the queued work and the crash counts go into state.json's `restart` for the new
// process, and supervisor-adopted.json vouches for this pid before it exits. The sessions keep
// running; their endings are the new process's. No email and no `foreman learn`: the run
// carries on.
async function restartOnNewCode({ from, to }, text = `Restarted on new code (${from} -> ${to}).`) {
  if (exiting) return;
  setHandedOver(true);
  exiting = 'restart';
  preparing.close();
  try {
    for (const t of loopErrors.clear(now())) event(t, 'warn');
    const handed = handoverSessions([...sessions], ME);
    saveRun({ restart: { at: now().toISOString(), from, to, started, finished, shipped, resumed: [...resumed], resumedShipped, workers, counters, skipped: [...skipped], haltSeen, pid: ME, sessions: handed, work: [...work], crashes: Object.fromEntries(crashes) }, restartPending: null, stuck: null, slow: [] });
    // Vouched for by startSupervisor's loop, which outlives this process (see the header). The
    // pids adopted earlier stay listed: a held story's claim may still name one.
    writeAdopted(DIR, { by: process.ppid > 1 ? process.ppid : ME, pids: [...new Set([...adoptedPids(ME, [...sessions.values()]), ...OWN])] });
    event(text);
    jira?.stop();
    await publish(true).catch(() => {});
    await owner.settled();
    dashboard?.close();
  } catch (err) {
    console.error(`Supervisor error while restarting: ${err?.message ?? err}`);
  } finally {
    endChildren(loopChildren);
    // A signal during the restart ends the run as any Ctrl-C does (see the header): no next
    // process adopts the sessions, so the handover is taken back and stop() ends them. A session
    // that ended while handed over was ignored by onExit: it is handled now, so stop() does not
    // wait on it. stop() exits the process itself.
    if (interrupted) {
      try {
        saveRun({ restart: null });
        dropAdopted(DIR);
      } catch {
        // stopping anyway
      }
      setHandedOver(false);
      exiting = null;
      for (const [slot, s] of [...sessions]) if (!sessionAlive(s)) onExit(slot, s);
      await stop(INTERRUPT_EXIT, interruptNow());
      return;
    }
    process.exit(RESTART_EXIT);
  }
}

// Whether the code on disk accepts the config: `foreman config check` run by the new code.
function newCodeAccepts() {
  const r = sh(NODE.node(), [FOREMAN_BIN, 'config', 'check'], { cwd: ROOT });
  return r.status === 0 ? { ok: true } : { ok: false, reason: r.stdout.split('\n')[0] || `exit ${r.status}` };
}

async function tick() {
  const before = launches;
  commands();
  applySettings();
  if (!DRY) flushNotes();
  for (const m of rehome(work, workers)) event(`${m.id} was queued for ${m.from}, which is over the worker count (${workers}); a slot under it takes it.`, 'info', m.from);
  if (existsSync(STOP)) {
    const by = takeStop(DIR) ?? {};
    stopping = true;
    event(`Stop requested by ${stopperDetail(by)}: finishing the stories in progress.`, 'warn');
    if (unexpectedStop(by)) notify('unexpected-stop', { reason: `Stop requested by ${stopperDetail(by)}, not from your terminal or the dashboard.` });
  }
  // New plugin code: no new story starts until the run restarts on it (STOP wins).
  if (CODE_AT_START && !stopping) {
    if (OWN_CHECKOUT) pullAnchor();
    const change = codeChange(CODE_AT_START, CODE.version({ label: false }), refusedCode);
    // The label costs a second git call: only for code not seen yet.
    const to = change && change.id !== restartPending?.id ? (CODE.version().label ?? change.id) : null;
    setRestartPending(nextPending(restartPending, change, { to, at: now().toISOString() }));
  } else if (stopping) setRestartPending(null);
  const halted = existsSync(HALT);
  if (halted && !haltSeen) {
    setHaltSeen(true);
    setLoop(DIR, 'halted', redact(haltReason(readFileSync(HALT, 'utf8'))).slice(0, 300));
    notify('halted', { reason: 'A release failed; releases are frozen until you press "I\'ve fixed it".' });
  }
  if (!DRY) void closeDoneHaltTasks();
  // Paused for the sign-in: probe it now and then, and at once after a restart.
  if (state().autoPausedAt && state().autoPauseReason === SIGNIN_PAUSE && probeDue({ running: signInCheck.running, lastAt: signInCheck.lastAt, now: Date.now(), everyMs: PROBE_EVERY_TICKS * TICK_MS })) checkSignIn();
  const paused = control().paused === true || autoPaused();
  // A credit pause whose time has come: probe, and let the pause go once Claude answers.
  if (creditProbeDue({ pausedAt: state().autoPausedAt, resumeAt: state().autoResumeAt, running: creditCheck.running || signInCheck.running, now: Date.now() })) checkCredit();
  // Jira not answering holds new picks only; a quiet hold (no answer yet) is not shown.
  const jiraHold = !halted && !paused ? (jira?.hold() ?? null) : null;
  const shownHold = jiraHold && !jiraHold.quiet ? jiraHold.reason : '';
  if (!halted) {
    const loopState = paused || shownHold ? 'paused' : standbyOn() ? 'standby' : 'running';
    setLoop(DIR, loopState, paused ? state().autoPauseReason || 'paused from the command centre' : shownHold ? shownHold : standbyOn() ? STANDBY : '');
  }
  // A sign-in check, or the subscription check, holds every start until it answers.
  const pickHeld = paused || !!jiraHold || signInCheck.running || subscriptionCheck.running;
  releaseApiHeld({ halted, paused, stopping });
  pollAdopted();
  watch();
  if (parkWatchDue({ running: !!parkWatch.child, lastAt: parkWatch.lastAt, count: readParks(DIR).length, now: Date.now(), everyMs: PARK_CHECK_MS })) startParkWatch();
  void checkOwnerTasks();
  if (!DRY && typeof envAdapter.sweep === 'function' && envSweepDue({ running: envSweep.running, lastAt: envSweep.lastAt, now: Date.now(), everyMs: ENV_SWEEP_MS })) startEnvSweep();
  // New code: restart now, before any pick, unless a slot is being set up, a session is being
  // stopped or the park watch checks; the sessions running and the queued work are handed over
  // (see the header).
  const nc = NODE.check();
  if (nc.event) event(nc.event.text, nc.event.kind);
  let restartNow = restartFor({ code: restartPending, node: NODE.broken(), stopping, accepts: newCodeAccepts });
  if (restartNow) {
    const restart = restartStep({ pending: restartNow.pending, busy: preparing.size > 0 || [...sessions.values()].some((s) => s.stop || resultArrived(s)) || closing.size > 0 || !!answersRun || !!fixCheck || !!parkWatch.child || signInCheck.running || subscriptionCheck.running || creditCheck.running, check: restartNow.check });
    if (restart.action === 'refuse') {
      event(restart.event.text, restart.event.kind);
      refusedCode = restartPending.id;
      setRestartPending(null);
      restartNow = null;
    } else if (restart.action === 'restart') {
      return restartOnNewCode(restartNow.pending, restartNow.text);
    }
  }

  const answersIdle = mayApplyAnswers({ running: sessions.size + closing.size, preparing: preparing.size, queued: takeable(work, workers), halted, held: pickHeld, stopping });
  await startAnswers(answersIdle ? null : EVERY_TICK);
  sweepClaims();
  sweepOwnerClaims();

  let couldPick = false;
  let found = null; // the first story a free slot found
  forgetStaleNextStart();
  // Before the slot loop: a story that runs already settles its request even when no slot is free.
  settleRunningRequest();
  for (const slot of SLOT_IDS) {
    // A slot whose session is being read, or any slot while owner answers apply, starts nothing.
    if (sessions.has(slot) || closing.has(slot) || preparing.has(slot) || answersRun) continue;
    // The story the owner asked for next is still being prepared in another slot: no other pick yet.
    const nextFirst = nextStarting !== null && nextStarting.slot !== slot;
    const st = readSlot(DIR, slot).state;
    // Counted per slot, so a story an earlier slot started this tick counts.
    const base = { halted, stopping, paused: paused || signInCheck.running || subscriptionCheck.running, backoffUntil: counters.backoffUntil, envUntil: counters.envUntil, now: Date.now(), slotIndex: slotIndex(slot), workers, slotState: st, running: runningCount() };
    // Queued work resumes a story already in hand, not a new one: the running count limits new picks only.
    if (hasWork(work, slot) && canResume(base)) {
      // A start-up resume gives way to a story the picker ranks above it, if this slot may pick.
      const pickOk = !nextFirst && canPick({ ...base, stopping: stopping || !!restartNow, paused: pickHeld, max: MAX, started });
      if (pickOk && resumeYields(slot)) {
        couldPick = true;
        const id = pick(slot);
        if (id !== PICK_WAITS) found ??= id;
      } else {
        // An automatic resume may need no session (resume-close.mjs): the merged pull request is
        // asked for in a child, and the work waits for the next tick that has the answer.
        const w = peekWork(work, slot);
        if (w?.resume && !mergedFor.has(w) && !SETTLED.includes(statusOf(w.id))) {
          void lookUpMerged(w.id).then((pr) => mergedFor.set(w, { pr }));
          continue;
        }
        startWork(slot, takeWork(work, slot));
      }
    } else if (!nextFirst && canPick({ ...base, stopping: stopping || !!restartNow, paused: pickHeld, max: MAX, started })) {
      couldPick = true;
      const id = pick(slot);
      if (id !== PICK_WAITS) found ??= id;
    }
  }
  saveQueued();

  // The park watch is a short check every few minutes: it delays a stop, but never counts for
  // standby, which would then flap.
  const running = sessions.size > 0 || closing.size > 0 || preparing.size > 0;
  if (running || takeable(work, workers) > 0) leaveStandby();
  const idle = whenNothingLeft({ nothingLeft, halted, held: pickHeld, running, queued: takeable(work, workers), once: ONCE, max: MAX, exitWhenIdle: EXIT_WHEN_IDLE });
  const busy = running || !!answersRun || !!fixCheck || !!parkWatch.child || signInCheck.running || subscriptionCheck.running || creditCheck.running;
  if (!busy && takeable(work, workers) === 0) {
    if (stopping) return stop(0, 'Stopped on request.');
    if (MAX > 0 && started >= MAX) return stop(0, reachedLine({ max: MAX, resumedShipped }));
    if (idle === 'exit') return stop(0, NOTHING_LEFT);
    if (ONCE && halted) return stop(0, 'Halted: nothing can start until `foreman fixed`.', { loop: 'halted' });
    if (ONCE && pickHeld) return stop(0, `Nothing can start now: ${paused ? 'paused' : jiraHold.reason || 'waiting for Jira'}.`, { loop: 'paused' });
    if (ONCE && !couldPick) return stop(0, 'Nothing can start now: no slot is free (parked, held or down), or the run is backing off.');
  }
  // Starved: a free slot found a story and nothing started this tick (the progress watchdog). A
  // story that only waits on running stories is not starved.
  starvedId = couldPick && found && launches === before ? found : null;
  if (idle === 'standby') enterStandby();
  return null;
}

async function main() {
  if (DRY) {
    dryRun({ loaded, START, workers, MAX, SLOT_IDS, DIR, CONFIG, slotIndex, stories, pickStory, recoveryPlan, endedFolderStory, schemaExtra, schemaFree, keptOut, fileWaiters });
    process.exit(0);
  }
  mkdirSync(join(DIR, 'logs'), { recursive: true });
  writePid(DIR, ME);
  process.on('exit', () => {
    clearPid(DIR, ME);
    // Only a file this process vouches for: the one written at a restart is its parent's.
    clearAdopted(DIR, ME);
  });
  // Does this process's own Node start? Its children use one that does (see the header of run-context.mjs).
  const nodeAtStart = NODE.check({ force: true });
  if (nodeAtStart.event) event(nodeAtStart.event.text, nodeAtStart.event.kind);
  // No handover is in flight on a fresh start, so a voucher left behind (a hard kill, a crash
  // before the adoption) must not keep any claim or lock alive.
  if (!RESTARTED) dropAdopted(DIR);
  // A fresh start forgets who stopped the last run; a restart on new code keeps it.
  if (!RESTARTED) clearLastStop(DIR);
  // From here a stop ends every session in hand, the adopted ones included (see the header).
  // A signal while it exits for a restart is kept, and ends the run once the handover is done.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
    process.on(signal, () => {
      const a = afterSignal(exiting);
      if (a === 'stop' || a === 'interrupt') interruptSource = sourceNow();
      if (a === 'stop') stop(INTERRUPT_EXIT, interruptNow());
      else if (a === 'interrupt') interrupted = true;
    });
  // The handed-over sessions are adopted first, while state.json still lists them in `restart`.
  // Then every slot folder is scanned for sessions that no handover named (a hard kill, a crash),
  // skipping the handed-over ones being ended. One "Kept N" event covers both, then the double
  // warnings; the handed-over sessions that could not be kept are ended last.
  const found = { kept: [], doubles: [] };
  const dropped = RESTARTED ? adoptCarried(found.kept) : [];
  adoptLive(found, dropped.map((d) => d.pid));
  if (found.kept.length) event(keptText(found.kept, SLOT_IDS));
  for (const d of found.doubles) event(doubleText(d), 'warn', d.slot);
  if (dropped.length) await endDropped(dropped);
  adoptLegacySchemaLock(DIR);
  sweepLeftSessionFiles();
  sweepLeftCheckJobs();
  setWorkers(DIR, workers);
  // A restart carries on the run's totals.
  if (!RESTARTED) startTotals(DIR, now());
  saveRun({ handled: handled(), anchorWait: null, learningFailed: null, configProblem: null, stuck: null, slow: [], restartPending: null, backoffUntil: backoffShown(counters, Date.now()), answerFailures: [], skipped: [...skipped], ...(RESTARTED ? { restart: null } : { apiWait: null, envWait: null }) });
  saveTeamAtStart();
  // caffeinate's -w pid still ends it with this process; standby lets go of it meanwhile.
  awake = keepAwake(keepAwakeCommand(CONFIG, process.platform, ME), { spawn, onError: () => event('Could not keep the computer awake.', 'warn') });
  awake.take();
  // A run restarted while halted is still halted (its halt was seen, so the tick will not say so again).
  if (haltSeen && existsSync(HALT)) setLoop(DIR, 'halted', redact(haltReason(readFileSync(HALT, 'utf8'))).slice(0, 300));
  else setLoop(DIR, 'running', '');
  for (const w of loaded.localWarnings) event(w, 'warn');
  for (const e of START.events) event(e.text, e.kind);
  if (!RESTARTED) event(`Foreman started with ${workers} ${workers === 1 ? 'slot' : 'slots'}${MAX ? `, for ${MAX} ${MAX === 1 ? 'story' : 'stories'}` : ''}.`);
  if (!RESTARTED && SESSION_PLUGIN.copy) event(copyWarning({ copy: SESSION_PLUGIN.copy, own: { ...ownCopy({ pluginDir: PLUGIN_DIR }), label: CODE_AT_START?.label } }), 'warn');
  if (control().paused === true || autoPaused()) {
    const reason = control().paused === true ? 'paused with `foreman pause`' : state().autoPauseReason || 'Foreman paused itself';
    const line = `Starting paused: ${reason}; run \`foreman resume\` to continue.`;
    console.log(line);
    event(line, 'warn');
  }
  // The start count wins at start: a count already in control.json is history.
  markHandled('workers', control().workersAt ?? null);
  if (ARTIFACTS) {
    if (sh(NODE.node(), [SYNC, '--once'], { cwd: ROOT }).status !== 0) {
      console.log("Note: the command centre cannot be updated from here (writes need a Claude session's approval).");
      console.log('      Foreman will still build. To watch it live, start it from Claude in VS Code instead.');
    }
    spawn(NODE.node(), [SYNC, '--loop', '--parent', String(ME)], { cwd: ROOT, stdio: 'ignore' }).unref();
  } else {
    try {
      consoleAdapter = openConsole({ config: CONFIG, ctx: { stateDir: DIR, now } });
    } catch (err) {
      event(`The console could not be opened (${err.message}); \`foreman status\` still works.`, 'warn');
    }
    // The dashboard runs in this process. A failure to start (a port in use, a host with no
    // token) is an event; the run carries on and `foreman status` still works.
    if ((CONFIG.console?.adapter ?? 'dashboard') === 'dashboard' && !ONCE) {
      startDashboard({ root: ROOT, config: CONFIG, stateDir: DIR, env: process.env, now, host: process.env.FOREMAN_DASHBOARD_HOST || undefined })
        .then(({ server, url }) => {
          dashboard = server;
          console.log(`Dashboard: ${url}`);
          event(`Dashboard at ${url}`);
        })
        .catch((err) => {
          const why = err.code === 'EADDRINUSE' ? `port ${CONFIG.console?.port ?? 4317} is in use` : err.message;
          event(`The dashboard did not start (${why}); the run carries on, and \`foreman status\` still works.`, 'warn');
        });
    }
  }
  if (jira) {
    // The first answer before start-up recovery reads the stories; never more than 30 s.
    await Promise.race([jira.refresh(), sleep(30_000)]);
    jira.start();
  }
  // With stage branches, the records of what other runs shipped are on the stage branch: fetch it,
  // so a reused clone or a laptop with no state does not build a story again.
  const shippedWarning = fetchStoryTarget({ root: ROOT, config: LIVE, sh: anchorSh });
  if (shippedWarning) event(shippedWarning, 'warn');
  reconcileStart();
  // A fresh start has no queued work before reconcileStart, so `work` holds just what recovery queued,
  // and `found.kept` holds the live sessions adopted from a run that was killed.
  if (!RESTARTED) {
    const ids = inHandAtStart({ kept: found.kept, work });
    for (const id of ids) resumed.add(id);
    saveRun({ asked: { max: MAX, resumed: ids } });
    const line = resumedLine({ max: MAX, count: ids.length });
    if (line) {
      console.log(line);
      event(line, 'info');
    }
  }
  while (!exiting) {
    let loopError = null;
    try {
      await tick();
      rotateEvents(DIR);
      await publish();
      for (const t of loopErrors.clear(now())) event(t, 'warn');
    } catch (err) {
      for (const t of loopErrors.seen(`Supervisor error: ${String(err.message).slice(0, 200)}`, now())) event(t, 'warn');
      loopError = redact(String(err.message).slice(0, 200));
    }
    if (!exiting) checkProgress(loopError);
    if (!exiting) {
      // A test's or a scratch copy's run ends on its own (see the header).
      const verdict = leashVerdict({ leash: LEASH, alive, standbySince: standbySince(), now: Date.now() });
      if (verdict) await stop(0, verdict.reason);
    }
    if (!exiting) checkStrays();
    // wait: sleep leaves a ref'd 30 s timer after a wake poll. That is harmless because stop()
    // ends in process.exit, and a ref'd timer keeps the process alive while a poll is out.
    // A late wake (the computer slept) is not a stall: the progress clocks start again.
    await loopRest({ intervalMs: TICK_MS, sleep, jira, event, wait: sleep, progress });
  }
}

await main();
