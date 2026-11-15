// Picking and starting a story in a slot: the pick (the owner's "build next" first, then the
// picker), the slot's folder and environment, the session's start, queued work starting and the
// claim sweeps. A part of the supervisor (supervisor.mjs is the entry point and lists the
// parts); it depends on run-context.mjs and, for a session's end, on session-lifecycle.mjs,
// whose endings call back into it. The paragraphs below were part of supervisor.mjs's header.
//
// A slot's folder after its story: a story that ends (the slot goes idle, or parked by the
// owner) leaves the folder clean and detached at base, with any uncommitted changes first saved
// on a local leftover/<slot>-<story>-<date> branch and an event naming the branch
// (leftovers.mjs), and any new key files deleted, not saved. A resumed, held or crash-parked story keeps its folder. At the pick, a dirty
// folder on the branch of a story nothing holds any longer (no claim, session, queued work or
// slot) is saved and cleaned the same way and the pick carries on; any other dirty folder, or
// one whose save fails, parks the slot as before. A folder's story is recognised by its branch
// name (the branch prefix plus an id the source's idPattern accepts), so a story no longer in the
// open list (Done in Jira) counts as ended. Skip, Take over and Restart tidy the folder the same
// way (leftovers saved on a leftover branch). Every dirty park writes a warn event naming the
// slot, the reason and the folder's branch.
//
// Claims while the run goes on: a slot parked for crashes keeps its story's claim only while it
// stays parked on that story (the slot's parkedStory); Unpark, Discard and Skip let it go. Every
// tick, before the picks, a factory claim whose slot is idle, parked without that story, or
// building another story is let go with a warn event, even under this process's live pid
// (sweepClaims, scheduler.mjs looseClaims); stories running, being set up or queued keep theirs,
// as do held and down slots. The picker then takes an In Progress story with no claim first, so
// a story let go is picked again by priority in the same tick. Every tick, before the picks, an
// owner claim whose story is done or retired, or has been missing from a non-empty story list for
// longer than a poll (stories.pollSeconds, default 60 s, at least one tick), is removed with one
// info event (sweepOwnerClaims, scheduler.mjs settledOwnerClaims).
//
// A "build next" request stays pending until its story has started in a slot (next-request.mjs):
// every pick tries it first, and "You asked for X next; starting it." is written only then. While
// the story's brief is fetched, no other story starts and one idle slot reads "Starting X next:
// fetching its brief from Jira". A claim held elsewhere, a failed fetch or checkout of the base
// branch, the schema token held by another story, or a wait on files or resources another running
// story holds (file-locks.mjs waitOf) leaves it pending; after 3 failed starts it
// is logged once and shown on Waiting on you (run:next), and it is still tried first. That
// request never gives way to a higher-priority waiter (yieldsTo): only the automatic pick does.
// A request whose story already runs in a slot (this factory's claim or session, adopted ones
// included) is settled as started, with no warning, at the next tick.

import os from 'node:os';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { claims, dropOwnerClaim, holderOf, letGoClaim, SCHEMA } from './locks.mjs';
import { needsExclusive, nextStory } from './pick.mjs';
import { dropReservations, reserveForStart, spendWait, waitOf } from './file-locks.mjs';
import { dropSteps, looseClaims, looseClaimText, OWNER_CLAIM_POLL_SECONDS, ownerClaimText, SETTLED, settledOwnerClaims, workStop, workStopText } from './scheduler.mjs';
import { checkBeforeEnv, closeInstead } from './resume-close.mjs';
import { doneChange } from './story-source.mjs';
import { foremanEnvName, sessionKeys } from './foreman-keys.mjs';
import { readSignIn } from './claude-fallback.mjs';
import { PLUGIN_DIR } from './code-version.mjs';
import * as session from './session.mjs';
import { takeOver } from './move-work.mjs';
import { peekWork, pickFirst, slotNumber } from './slot-work.mjs';
import { envVerdict, notStartedPatch, PENDING, prepareSlot, sessionStartPatch, syncLearnedSkills } from './slot-prepare.mjs';
import { ensureWorktree, prepareWorktree, worktreeDirty, worktreeNeeds, worktreeOf } from './worktree.mjs';
import { freeStoryFolder, heldIds, leftoverEvents, saveLeftovers, storyOfBranch } from './leftovers.mjs';
import { keepMark, markSession, sessionProjectsDir } from './session-files.mjs';
import { runAsync } from './run-async.mjs';
import { briefNote, failedTry, isStoryId, requestVerdict, runningSlot } from './next-request.mjs';
import {
  clearAgents,
  clearSpans,
  openNextRequest,
  readSlot,
  setSlot,
  setNextWait,
  settleNextRequest,
} from './state.mjs';
import { autoPause, BASE_REF, branchOf, CARRIED, claim, CODE_AT_START, closedShipped, closing, CONFIG, crashes, DIR, downs, dropCheckpoint, envAdapter, event, fileWaiters, git, guarded, inHandSessions, jira, keptOut, LIVE, lookUpMerged, ME, mergedFor, moveHolds, notify, now, OWN, PACK_SESSION, pickFetches, pickStory, preparing, releaseClaim, releaseToken, ROOT, saveRun, saveSkipped, schemaExtra, schemaFree, SESSION_PLUGIN, SESSION_SCOPE, SESSION_SHADOWED, sessions, signins, skipped, sleep, SLOT_IDS, slotChildren, slotIndex, state, statusOf, stories, takeTokenFor, TICK_MS, work, workers } from './run-context.mjs';
import { onExit } from './session-lifecycle.mjs';

export let started = CARRIED?.started ?? 0; // new stories begun this run
export let nothingLeft = false;
let repaired = false; // the env adapter's repair() runs at most once per run
export let launches = 0; // sessions started or pending, this process
const countedStarts = new Set(); // ids of the stories counted in `started` by a pick, until they end or fail

// Takes back the count of a story this run picked and started, when it ended blocked and built
// nothing. True when it was counted; a resume from the work queue was never counted, so it is not.
export function uncountStart(id) {
  if (!countedStarts.delete(id)) return false;
  started = Math.max(0, started - 1);
  return true;
}

// ── starting a session ───────────────────────────────────────────────────────────────────────

function slotDown(slot, reason) {
  setSlot(DIR, slot, { state: 'down', reason }, now());
  event(`Slot ${slot} is down: ${reason}`, 'warn', slot);
  notify('down', { slot, reason });
}

// The slot's worktree when worktreeNeeds says nothing must be created or installed, so no child
// runs. Returns its path, or null with the slot put down.
function slotWorktree(slot) {
  try {
    return ensureWorktree({ anchor: ROOT, stateDir: DIR, n: slotIndex(slot) + 1, config: CONFIG }).path;
  } catch (err) {
    slotDown(slot, `Its worktree could not be prepared: ${err.message}`);
    return null;
  }
}

// Acts on the outcome of the slot environment's prepare (slot-prepare.mjs). The environment
// itself may be gone (a container runtime that stopped): one repair per run, then a pause.
// Returns true when the session may start.
function envReady(slot, id, outcome) {
  const v = envVerdict(outcome);
  for (const e of v.events) event(e.text, e.kind);
  if (v.action === 'pause') {
    releaseClaim(id);
    releaseToken(slot);
    autoPause(v.reason);
    return false;
  }
  if (v.action === 'down') {
    downs.set(slot, (downs.get(slot) ?? 0) + 1);
    slotDown(slot, v.reason);
    return false;
  }
  if (v.note) event(`Slot ${slot}: ${v.note}.`, 'info', slot);
  downs.delete(slot);
  return true;
}

// Prepares the slot and starts the story's session. Returns 'started', 'failed', or 'pending'
// when the folder or the environment answers later; then the session starts when it settles, and
// `onFail` is called if it does not. A folder that must be created or installed (a few minutes of
// git and `npm ci`) is prepared by children (prepareWorktree), so the loop keeps ticking.
function launchNow(slot, id, mode = '', { onFail } = {}) {
  // Preparing a new slot (worktree, npm ci, its stack) can take a few minutes; show it.
  setSlot(DIR, slot, { state: 'building', reason: '', story: readSlot(DIR, slot).story ?? { id, title: '', stage: 'starting', detail: 'preparing the slot', startedAt: now().toISOString(), rounds: 0, committedAt: null } }, now());
  const notStarted = () => {
    const patch = notStartedPatch(readSlot(DIR, slot));
    if (patch) setSlot(DIR, slot, patch, now());
  };
  const n = slotIndex(slot) + 1;
  const needs = worktreeNeeds({ stateDir: DIR, n, config: CONFIG });
  if (!needs.create && !needs.install) {
    const path = slotWorktree(slot);
    if (!path) {
      notStarted();
      return 'failed';
    }
    return afterWorktree(slot, id, mode, path, onFail, notStarted);
  }
  const token = preparing.add(slot, { id });
  launches++;
  event(`Slot ${slot}: preparing its folder for ${id}.`, 'info', slot);
  prepareWorktree({ anchor: ROOT, stateDir: DIR, n, config: CONFIG, track: slotChildren(slot), live: () => preparing.live(slot, token) }).then(
    guarded('a slot folder', (r) => {
      if (!preparing.settle(slot, token)) return;
      if (afterWorktree(slot, id, mode, r.path, onFail, notStarted) === 'failed') onFail?.();
    }),
    guarded('a slot folder', (err) => {
      if (!preparing.settle(slot, token)) return;
      slotDown(slot, `Its worktree could not be prepared: ${err.message}`);
      notStarted();
      onFail?.();
    }),
  );
  return 'pending';
}

// A slot never makes or resets an environment for a story whose pull request merged, or that is
// settled (done or retired): with an adapter that makes one, a plain start first looks the story
// up (one gh child, so the loop keeps ticking) and closes it with no environment made. The slot is
// preparing meanwhile, so no pick, sweep or restart takes it. A look-up that fails says nothing
// merged, and the story starts; so does one whose pull request merged before its last rollback.
// `onClosed` is called when the story was closed instead; `onFail`
// as launchNow's. 'started', 'failed' or 'pending' as launchNow.
function launch(slot, id, mode = '', { onFail, onClosed } = {}) {
  if (!checkBeforeEnv({ adapter: CONFIG.env?.adapter, mode })) return launchNow(slot, id, mode, { onFail });
  setSlot(DIR, slot, { state: 'building', reason: '', story: readSlot(DIR, slot).story ?? { id, title: '', stage: 'starting', detail: 'preparing the slot', startedAt: now().toISOString(), rounds: 0, committedAt: null } }, now());
  const token = preparing.add(slot, { id });
  launches++;
  const settled = SETTLED.includes(statusOf(id));
  (settled ? Promise.resolve(null) : lookUpMerged(id)).then(
    guarded('a shipped check', (pr) => {
      if (!preparing.settle(slot, token)) return;
      const closed = closeInstead(id, {
        statusOf,
        mergedPr: () => pr,
        markDone: (p) => stories().update(id, doneChange(`Its pull request ${p} merged; marked done by Foreman before making its environment.`, now())),
        close: () => {
          releaseClaim(id);
          releaseToken(slot);
          dropReservations(DIR, id);
          crashes.delete(id);
          signins.delete(id);
          dropCheckpoint(slot, id);
          const st = readSlot(DIR, slot);
          setSlot(DIR, slot, st.parkAfter === true ? notStartedPatch(st) : { state: 'idle', reason: '', story: null, result: null }, now());
        },
        event: (text, kind) => event(text, kind, slot),
        instead: 'environment',
      });
      if (closed) {
        closedShipped.add(id);
        onClosed?.();
        return;
      }
      if (launchNow(slot, id, mode, { onFail }) === 'failed') onFail?.();
    }),
  );
  return 'pending';
}

// What follows a slot's folder being ready: learned skills, the environment's prepare and the
// session. 'started', 'failed' or 'pending' as launch.
function afterWorktree(slot, id, mode, path, onFail, notStarted) {
  // Learned skills as the settings stand now, so an apply change counts from the next story.
  for (const w of syncLearnedSkills({ path, stateDir: DIR, config: LIVE }).warnings) event(`Slot ${slot}: ${w}`, 'warn', slot);
  const repair =
    envAdapter.repair && !repaired
      ? () => {
          repaired = true;
          return envAdapter.repair();
        }
      : null;
  const finish = (outcome) => {
    if (envReady(slot, id, outcome)) {
      startSession(slot, id, mode, path);
      return true;
    }
    notStarted();
    return false;
  };
  const r = prepareSlot({
    slot,
    id,
    adapter: envAdapter,
    n: slotIndex(slot) + 1,
    path,
    repair,
    pending: preparing,
    later: guarded('a slot environment', (o) => {
      if (!finish(o)) onFail?.();
    }),
    onError: (err) => event(`Supervisor error in a slot environment: ${String(err?.message ?? err).slice(0, 200)}`, 'warn'),
  });
  if (r === PENDING) {
    launches++;
    event(`Slot ${slot}: preparing its environment for ${id}.`, 'info', slot);
    return 'pending';
  }
  return finish(r) ? 'started' : 'failed';
}

function startSession(slot, id, mode, path) {
  const log = session.logPath({ stateDir: DIR, slot, now: now() });
  clearAgents(DIR, slot);
  clearSpans(DIR, slot);
  setSlot(DIR, slot, sessionStartPatch(readSlot(DIR, slot), id, now().toISOString()), now());
  // After the platform credits ran out, every session leaves ANTHROPIC_API_KEY out.
  const signIn = readSignIn(DIR);
  const run = session.command({ id, mode, config: CONFIG, slot, n: slotIndex(slot) + 1, root: ROOT, stateDir: DIR, supervisorPid: ME, envAdapter, baseEnv: process.env, packSession: PACK_SESSION, scope: SESSION_SCOPE, pluginDir: SESSION_PLUGIN.dir, pluginRoot: resolve(PLUGIN_DIR), shadowed: SESSION_SHADOWED, pluginLabel: CODE_AT_START?.label, fileKeys: sessionKeys({ root: ROOT, config: CONFIG }), useSubscription: signIn.using === 'subscription', testCores: session.testCoreShare(os.availableParallelism(), workers) });
  // Where Claude Code writes this session's files: from its own env, which may differ from ours.
  const projects = sessionProjectsDir(run.env);
  const child = session.start({ ...run, cwd: path, logFile: log });
  // usedKey: whether the session had a Console key, never the key.
  const entry = { child, pid: child.pid, id, mode, startedAt: Date.now(), log, stop: null, usedKey: Boolean(run.env.ANTHROPIC_API_KEY), holderPid: ME, adopted: false, projects };
  sessions.set(slot, entry);
  if (Number.isInteger(child.pid)) {
    try {
      markSession(DIR, slot, { story: id, pid: child.pid, log, projects });
    } catch (err) {
      event(`Could not note the session files of ${id} (${String(err?.message ?? err).slice(0, 200)}).`, 'warn', slot);
    }
  }
  launches++;
  child.on('exit', () => onExit(slot, entry));
  child.on('error', (err) => {
    event(`Slot ${slot}: the session could not start (${err.message}).`, 'warn', slot);
    onExit(slot, entry);
  });
  event(`Slot ${slot}: ${mode ? `${mode} ` : ''}${id}`, 'story', slot);
  // The owner's "build next" for this story, whose slot was being prepared: it has started now.
  if (nextStarting?.slot === slot) {
    const { asked } = nextStarting;
    nextStarting = null;
    nextStarted(asked);
  }
}

export function killSession(slot, why) {
  const s = sessions.get(slot);
  if (!s) return;
  s.stop = why;
  // An interrupted session's files stay to be read, even if it outlives this process.
  if (why === 'interrupt') {
    try {
      keepMark(DIR, slot);
    } catch {
      // onExit keeps them all the same; only a later sweep could miss it
    }
  }
  try {
    process.kill(-s.pid, 'SIGTERM');
  } catch {
    // already gone
  }
  setTimeout(() => {
    try {
      process.kill(-s.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }, 10_000).unref();
}

// ── picking ─────────────────────────────────────────────────────────────────────────────────

// The "build next" request being tried: failedTry's track, and the one slot that says it is
// fetching the story's brief.
let nextTrack = null;
let nextNote = null; // { slot, id }
// The slot whose start is still being prepared for the owner's "build next", and the request it
// answers: { slot, asked }. No other slot picks a story meanwhile, and the request is marked
// started only once the session starts (startSession), so the story asked for starts first and is
// reported after it, as it was when the folder was ready at once.
export let nextStarting = null;

function clearNextNote() {
  if (nextNote && readSlot(DIR, nextNote.slot).reason === briefNote(nextNote.id)) setSlot(DIR, nextNote.slot, { reason: '' }, now());
  nextNote = null;
}
// Only one slot says it, however many are free.
function noteNext(slot, id) {
  if (nextNote && nextNote.slot !== slot && readSlot(DIR, nextNote.slot).reason === briefNote(nextNote.id)) return;
  setSlot(DIR, slot, { reason: briefNote(id) }, now());
  nextNote = { slot, id };
}
function nextFailed(req, reason) {
  const r = failedTry(nextTrack, req, reason, now());
  nextTrack = r.track;
  if (r.log) event(r.log, 'warn');
  if (r.wait) setNextWait(DIR, r.wait);
}
function nextStarted(req) {
  settleNextRequest(DIR, req, 'started', now());
  nextTrack = null;
  clearNextNote();
}
// The slot that runs the story asked for, or null (next-request.mjs runningSlot): a session of
// this process or one adopted across a restart, or this factory's claim for one of its slots.
const requestRunningIn = (id) => runningSlot({ id, sessions: [...sessions, ...closing].map(([slot, s]) => ({ slot, id: s.id })), claims: claims(DIR), ours: (pid) => OWN.has(pid), slots: SLOT_IDS });
// A "build next" whose story already runs in a slot is settled as started, with no warning: a
// restart between the pick and the settlement leaves it open (FM-366). A start this process is
// still preparing for the request (pickFetches, nextStarting) settles itself.
export function settleRunningRequest() {
  const req = openNextRequest(DIR);
  if (!req || [...pickFetches.values()].includes(req.id) || nextStarting?.asked.id === req.id) return;
  if (requestRunningIn(req.id)) nextStarted(req);
}

// False after parking the slot when its folder has changes that do not belong to a story.
function folderReady(slot) {
  const path = worktreeOf(DIR, slotIndex(slot) + 1);
  if (existsSync(join(path, '.git')) && worktreeDirty(path, { generated: CONFIG.generated })) {
    // Changes left by a story that has ended are saved and cleaned; any others park the slot.
    const ended = endedFolderStory(path);
    if (!ended || !tidyFolder(slot, ended)) {
      setSlot(DIR, slot, { state: 'parked', parkedFor: 'dirty', reason: 'Its folder has changes that do not belong to a story.' }, now());
      const head = git(path, 'rev-parse', '--abbrev-ref', 'HEAD');
      const on = head.status === 0 && head.stdout && head.stdout !== 'HEAD' ? `The folder is on the branch ${head.stdout}.` : 'The folder is on no branch.';
      event(`Slot ${slot} parked: its folder has changes that do not belong to a story. ${on}`, 'warn', slot);
      notify('parked', { slot, parkedFor: 'dirty', reason: 'Its folder has changes that do not belong to a story.' });
      return false;
    }
  }
  return true;
}

// What pick returns when the story it found only waits on running stories (held files or
// resources, or the schema token): nothing could start, so the tick loop does not count it as starved.
export const PICK_WAITS = Symbol('pick waits');

// Returns the id of the story it found, started or not. Returns PICK_WAITS when that story only
// waits on running stories, and null when there was none.
export function pick(slot) {
  const taken = claims(DIR).map((c) => c.id);
  const free = schemaFree();
  const extra = schemaExtra();
  // A story waiting on files or resources another running story holds is left out of a normal
  // pick (waitBlocks). A skip does not stand in the way of the owner asking for the story by name.

  // The owner's "build this next", if it can be built now and nobody has it. It clears a skip. It
  // stays open until its story has started (see the header), so every pick tries it first; a
  // story that only waits on held files counts as a failed try and keeps its place.
  const req = openNextRequest(DIR);
  if (nextNote && (!req || req.id !== nextNote.id)) clearNextNote();
  let story = null;
  if (req) {
    // Its story is being fetched for, or prepared, in another slot: nothing to decide yet.
    if ([...pickFetches.values()].includes(req.id) || nextStarting?.asked.id === req.id) {
      nothingLeft = false;
      return req.id;
    }
    const s = isStoryId(req.id) ? pickStory({ id: req.id, strict: true }) : null;
    const v = requestVerdict({
      story: s,
      taken: !!s && taken.includes(s.id),
      exclusiveBlocked: !!s && needsExclusive(s, extra) && !free,
      wait: s ? waitOf(DIR, s.id) : null,
      running: s || isStoryId(req.id) ? requestRunningIn(req.id) : null,
    });
    if (v.verdict === 'running') {
      // It runs already (a slot earlier in this tick resumed it): started, and the pick carries on to the normal order.
      nextStarted(req);
    } else if (v.verdict === 'wait') {
      nothingLeft = false;
      nextFailed(req, v.reason);
      return PICK_WAITS;
    } else if (v.verdict === 'take') {
      story = s;
      if (skipped.has(s.id)) {
        skipped.delete(s.id);
        saveSkipped();
        event(`${s.id} is no longer skipped.`, 'info');
      }
    } else if (v.verdict === 'refuse') {
      settleNextRequest(DIR, req, 'refused', now());
      nextTrack = null;
      clearNextNote();
    }
  }
  // Queued work is in hand: the picker must not start a queued, unclaimed In Progress story as a new one.
  story ??= pickStory({ skip: [...taken, ...skipped, ...closedShipped, ...work.map((w) => w.id)], exclude: keptOut({ extra, free, waiters: fileWaiters() }) });
  if (!story) {
    nothingLeft = true;
    return null;
  }
  nothingLeft = false;
  // The story the owner asked for, when this pick has it.
  const asked = req && story.id === req.id ? req : null;

  const path = worktreeOf(DIR, slotIndex(slot) + 1);
  if (!folderReady(slot)) return story.id;
  // The brief comes from Jira: fetched with await, and the pick tried again next tick.
  if (jira && !jira.briefTried(story.id) && !stories().brief(story.id)) {
    jira.fetchBrief(story.id);
    if (asked) noteNext(slot, story.id);
    return story.id;
  }
  if (!claim(slot, story.id)) {
    if (asked) nextFailed(asked, 'its claim is held elsewhere');
    return story.id;
  }
  // The free files its wait record names are kept for it from the claim on (before the fetch and
  // before spendWait), so a story picked in the next slot this tick cannot take them.
  reserveForStart(DIR, story.id, { now: now() });
  // A new story starts from the newest main, and so does its session's copy of the factory's
  // own skill and scripts (a worktree made before a change to them would run the old ones).
  // The fetch runs in a child, so the loop keeps ticking; the start follows when it is back.
  if (existsSync(join(path, '.git'))) fetchThenStart(slot, story, asked, path);
  else if (!startPicked(slot, story, asked)) return PICK_WAITS;
  return story.id;
}

// The rest of a pick once the slot's folder is at the newest main: the schema token, the spent
// wait record (its files are kept for the story from the claim, in pick), then launch. With `counted` the start was counted when the fetch began, so
// a failure (at once or later) takes it back and a start adds nothing. False when the schema token
// is held by another story, so nothing started.
function startPicked(slot, story, asked, { counted = false } = {}) {
  if (needsExclusive(story, schemaExtra()) && !takeTokenFor(slot, story.id)) {
    releaseClaim(story.id);
    // The story is not started and is kept out of the pick until the token is free.
    dropReservations(DIR, story.id);
    if (counted) started--;
    if (asked) nextFailed(asked, 'the schema token is held by another story');
    return false;
  }
  // An earlier deferral's wait is spent (its files were free to pick it), so a wait at the end
  // of this session is one this session wrote. The count of a holder that still runs stays, so a
  // second deferral on it is counted.
  spendWait(DIR, story.id);
  // A pending start counts toward --max, and stops counting if it then fails.
  // No session will end for a start that fails (onExit drops reservations), so the files kept for
  // the story go free now instead of after RESERVE_MS.
  const unkeep = () => dropReservations(DIR, story.id);
  const r = launch(slot, story.id, '', {
    onFail: () => {
      started--;
      countedStarts.delete(story.id);
      unkeep();
      if (asked && nextStarting?.slot === slot) {
        nextStarting = null;
        nextFailed(asked, readSlot(DIR, slot).reason || 'its slot could not be prepared');
      }
    },
    // A story that shipped does not count toward --max, and the owner's "build next" for it is settled.
    onClosed: () => {
      started--;
      countedStarts.delete(story.id);
      unkeep();
      if (asked && nextStarting?.slot === slot) {
        nextStarting = null;
        settleNextRequest(DIR, asked, 'refused', now());
        nextTrack = null;
        clearNextNote();
      }
    },
  });
  if (r === 'failed') {
    unkeep();
    if (counted) started--;
  } else {
    if (!counted) started++;
    countedStarts.add(story.id);
  }
  if (asked) {
    if (r === 'failed') nextFailed(asked, readSlot(DIR, slot).reason || 'its slot could not be prepared');
    else if (r === 'pending') nextStarting = { slot, asked };
    else nextStarted(asked);
  }
  return true;
}

const FETCH_TRIES = 3;

// Fetches the base into the slot's folder in a child (three tries, 3 s apart, 60 s each), checks it
// out, and starts the story. The slot is preparing meanwhile, so no pick and no command treats it
// as free; the claim is held, and the owner's "build next" request for this story stays open
// (pick answers it). A fetch that fails, or a slot cancelled or stopped meanwhile, takes the start
// back, as the synchronous fetch did.
function fetchThenStart(slot, story, asked, path) {
  const id = story.id;
  const token = preparing.add(slot, { id });
  started++;
  launches++;
  pickFetches.set(slot, id);
  setSlot(DIR, slot, { state: 'building', reason: '', story: { id, title: '', stage: 'starting', detail: 'preparing the slot', startedAt: now().toISOString(), rounds: 0, committedAt: null } }, now());
  (async () => {
    for (let i = 0; i < FETCH_TRIES; i++) {
      if (!preparing.live(slot, token)) return false;
      const r = await runAsync('git', ['fetch', '--quiet', CONFIG.remote, CONFIG.baseBranch], { cwd: path, timeoutMs: 60_000, track: slotChildren(slot) });
      if (r.status === 0) return true;
      if (i < FETCH_TRIES - 1 && preparing.live(slot, token)) await sleep(3000);
    }
    return false;
  })().then(
    guarded('a slot fetch', (fetched) => {
      pickFetches.delete(slot);
      if (!preparing.settle(slot, token)) {
        started--;
        return;
      }
      if (fetched && git(path, 'checkout', '--quiet', '--detach', BASE_REF).status === 0) {
        startPicked(slot, story, asked, { counted: true });
        return;
      }
      started--;
      releaseClaim(id);
      const patch = notStartedPatch(readSlot(DIR, slot));
      if (patch) setSlot(DIR, slot, patch, now());
      event(`Slot ${slot}: could not ${fetched ? `check out ${BASE_REF}` : `fetch ${BASE_REF}`}; ${id} not started, trying again next round.`, 'warn', slot);
      if (asked) nextFailed(asked, fetched ? `could not check out ${BASE_REF}` : `could not fetch ${BASE_REF}`);
    }),
  );
}

// ── a slot's folder after its story ──────────────────────────────────────────────────────────

// Saves what a story left uncommitted in its slot's folder on a leftover branch, and leaves the
// folder clean and detached at base (leftovers.mjs). True when the folder is clean after.
export function tidyFolder(slot, id) {
  const path = worktreeOf(DIR, slotIndex(slot) + 1);
  if (!existsSync(join(path, '.git'))) return true;
  const r = saveLeftovers({ path, slot, id, base: BASE_REF, generated: CONFIG.generated, keyFiles: [CONFIG.envFile, foremanEnvName(CONFIG)], now: now() });
  for (const text of leftoverEvents({ slot, id, base: BASE_REF, result: r })) event(text, 'warn', slot);
  return r.clean;
}

// The story whose branch a folder is on, when nothing holds it any longer (no claim, session,
// queued work or slot names it), or null. The story is found by the branch name, so one that is
// no longer open (Done in Jira) is still found. It only reads.
export function endedFolderStory(path) {
  const head = git(path, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (head.status !== 0) return null;
  let source;
  try {
    source = stories();
  } catch {
    return null;
  }
  let ids = [];
  try {
    ids = source.list().map((s) => s.id);
  } catch {
    // the branch pattern alone
  }
  const id = storyOfBranch(head.stdout, ids, CONFIG.branchPrefix, source.idPattern);
  if (!id) return null;
  const held = heldIds({ claims: claims(DIR), sessions: inHandSessions(), work, slots: SLOT_IDS.map((s) => readSlot(DIR, s)) });
  return held.has(id) ? null : id;
}

// Every path that starts queued work comes through here: releaseHeld, resumeHeld, releaseAfterWait,
// start-up resumes, crash resumes, owner Resume and restart. So the gate is here: work for a story
// the owner skipped this run, that is settled, or that the owner blocked since its slot was held,
// does not start, and its slot is freed. A slot records `heldWas` when it goes held because a
// story that halts the release line blocks itself first, so a block alone cannot mean the owner's.
function queuedStop(w) {
  try {
    const source = stories();
    return workStop(w, { skipped: [...skipped], stories: source.list(), idPattern: source.idPattern });
  } catch {
    return workStop(w, { skipped: [...skipped], stories: null });
  }
}

// Frees the slot of work that must not start: the slot's pinned story and the story's claim, token
// and reservations go, unless the story is still in hand elsewhere (queued, held in another slot): see dropSteps.
// A story that a session runs, a slot prepares or any other slot carries is already resumed by that
// slot (a held slot's resume leaves a ranked start-up resume for the same story behind): the
// duplicate is dropped quietly and nothing is let go, so the live session keeps its claim.
function dropWork(slot, w, stop) {
  const running = inHandSessions().some((s) => s.id === w.id) || SLOT_IDS.some((other) => other !== slot && readSlot(DIR, other).story?.id === w.id);
  const pinned = readSlot(DIR, slot).heldStory === w.id;
  const elsewhere = work.some((x) => x.id === w.id) || SLOT_IDS.some((other) => other !== slot && readSlot(DIR, other).heldStory === w.id);
  // dropSteps decides (see scheduler.mjs): a story still in hand elsewhere leaves its own item to
  // decide and say, so a "not resumed" here could be followed by that story resuming.
  const d = dropSteps({ running, pinned, elsewhere });
  if (d.free) setSlot(DIR, slot, { state: 'idle', reason: '', story: null, result: null, heldStory: null, heldWas: null, haltedBy: false, heldFor: null }, now());
  if (d.letGo) {
    releaseClaim(w.id);
    dropReservations(DIR, w.id);
  }
  if (d.tidy) {
    releaseToken(slot);
    tidyFolder(slot, w.id);
  }
  if (d.say) event(workStopText({ id: w.id, slot, stop }), 'info', slot);
}

export function startWork(slot, w) {
  const stop = queuedStop(w);
  if (stop) return dropWork(slot, w, stop);
  // Work rehomed from a slot over the worker count: this slot's folder must be fit to use, and the
  // claim and locks follow the work. The claim is checked before the old folder is freed, and once
  // the work has moved it no longer carries `from`, so a retry is a plain resume (move-work.mjs).
  // An automatic resume of a story that needs no session closes the slot instead, marking the
  // story done first when only its pull request merged (resume-close.mjs). The old folder still
  // has the story branch checked out: its unfinished work goes onto the branch and the folder is
  // detached, so this slot's session can check the branch out.
  const step = takeOver(w, slot, {
    workers,
    branch: branchOf(w.id),
    folderReady: () => folderReady(slot),
    moveHolds: (from) => moveHolds(from, slot, w.id),
    claim: () => claim(slot, w.id),
    closed: () =>
      Boolean(
        w.resume &&
          closeInstead(w.id, {
            statusOf,
            mergedPr: () => mergedFor.get(w)?.pr ?? null,
            markDone: (pr) => stories().update(w.id, doneChange(`Its pull request ${pr} merged; marked done by Foreman without a new session after its session ended.`, now())),
            close: () => {
              releaseClaim(w.id);
              releaseToken(slot);
              crashes.delete(w.id);
              signins.delete(w.id);
              dropCheckpoint(slot, w.id);
              setSlot(DIR, slot, { state: 'idle', reason: '', story: null, result: null }, now());
            },
            event: (text, kind) => event(text, kind, slot),
          }),
      ),
    freeFolder: (from) => freeStoryFolder({ path: worktreeOf(DIR, slotNumber(from)), id: w.id, branch: branchOf(w.id), from, to: slot, base: BASE_REF, generated: CONFIG.generated }),
    letGo: () => {
      releaseClaim(w.id);
      releaseToken(slot);
    },
    event: (text, kind) => event(text, kind, slot),
  });
  if (step === 'wait') {
    work.unshift(w);
    return;
  }
  if (step !== 'start') return;
  const t = holderOf(SCHEMA(DIR));
  if (t?.story === w.id) takeTokenFor(slot, w.id);
  // A story closed instead used its work item up: it is not queued again.
  const r = launch(slot, w.id, w.mode, { onFail: () => work.unshift(w), onClosed: () => {} });
  if (r === 'failed') work.unshift(w);
}

// Lets go of the factory claims whose slot moved on (scheduler.mjs looseClaims), even under this
// process's live pid, with a warn event each: the stories running, being set up or queued keep
// theirs. Runs every tick before the picks, so a story let go is picked in the same tick.
export const sweepClaims = guarded('the claim sweep', () => {
  const inHand = new Set(inHandSessions().map((s) => s.id));
  for (const w of work) inHand.add(w.id);
  for (const slot of SLOT_IDS) {
    const id = preparing.has(slot) ? readSlot(DIR, slot).story?.id : null;
    if (id) inHand.add(id);
  }
  const slots = Object.fromEntries(SLOT_IDS.map((slot) => [slot, readSlot(DIR, slot)]));
  for (const r of looseClaims({ claims: claims(DIR), slots, inHand, ours: (c) => OWN.has(c.pid) || c.stale })) {
    if (letGoClaim(DIR, r.id, OWN)) event(looseClaimText(r), 'warn', r.slot);
  }
});

// Removes the owner claims on stories that are done or retired, or have been missing from the
// source's (non-empty) list for more than a poll (scheduler.mjs settledOwnerClaims), with an info
// event each. The list is read only while an owner claim exists, from the cache (the supervisor's
// sources are cache-only), so the tick never waits on Jira or sf. When each missing story was
// first seen missing is kept in state.json (ownerClaimsAbsent), written only when it changed, so
// a restart does not reset the clock.
export const sweepOwnerClaims = guarded('the owner claim sweep', () => {
  const owned = claims(DIR).filter((c) => c.by === 'owner');
  const before = state().ownerClaimsAbsent ?? {};
  let list = null;
  if (owned.length) {
    try {
      list = stories().list();
    } catch {
      list = null;
    }
  }
  const r = settledOwnerClaims({ claims: owned, stories: list, absentSince: before, now: now().getTime(), absentMs: Math.max(TICK_MS, (LIVE.stories?.pollSeconds ?? OWNER_CLAIM_POLL_SECONDS) * 1000) });
  for (const d of r.drop) if (dropOwnerClaim(DIR, d.id, d.at)) event(ownerClaimText(d), 'info');
  if (JSON.stringify(r.absentSince) !== JSON.stringify(before)) saveRun({ ownerClaimsAbsent: r.absentSince });
});

// Whether the work this slot would take is a start-up resume that gives way to a story the picker
// would start now (slot-work.mjs pickFirst). Never throws: when the stories cannot be read the
// resume goes ahead.
export const resumeYields = (slot) => {
  try {
    const w = peekWork(work, slot);
    if (w?.ranked !== true) return false;
    const source = stories();
    const list = source.list();
    const free = schemaFree();
    const extra = schemaExtra();
    const rival = nextStory(list, {
      idPattern: source.idPattern,
      skip: [...claims(DIR).map((c) => c.id), ...skipped, ...work.map((x) => x.id)],
      exclude: keptOut({ extra, free, waiters: fileWaiters() }),
    });
    return pickFirst(w, rival, list);
  } catch {
    return false;
  }
};

// A pick found no story (or an ended session said there was none left).
export function markNothingLeft() {
  nothingLeft = true;
}

// A "build next" start whose slot is no longer being prepared is forgotten.
export function forgetStaleNextStart() {
  if (nextStarting && !preparing.has(nextStarting.slot)) nextStarting = null;
}
