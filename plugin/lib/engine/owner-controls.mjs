// The owner's control.json commands and Waiting-on-you answers as the loop applies them: Skip,
// Take over, Restart, Park, Resume and the others, the stories held for the Claude API, "I've
// fixed it", and the answers the supervisor applies. Not owner-commands.mjs, which runs the
// `foreman notify` and `foreman learn` children. A part of the supervisor (supervisor.mjs is the
// entry point and lists the parts); it depends on run-context.mjs, slot-starts.mjs,
// session-lifecycle.mjs and story-followups.mjs. The paragraphs below were part of supervisor.mjs's header.
//
// A story that had committed when its session died on a rate limit, an outage or an empty balance
// is held for the Claude API (the slot's heldFor 'api', reading "held until the API is back
// (retry at HH:MM)"). Every tick, before the picks, releaseApiHeld releases such slots once the
// backoff has ended and nothing is paused or halted, and queues their stories as automatic
// resumes: no command needed. Resume in the command centre queues one sooner. A slot a halt
// holds (a failed release) waits for "I've fixed it", as before. A stop leaves such a slot held,
// with its claim, so the stop does not wait on a story that is not running; the next run's first
// tick releases it.
// After Unpark, a folder the crash left dirty is saved on a leftover/ branch at the next pick and
// cleaned (leftovers.mjs), and the story restarts from its committed branch.
//
// A skip from the command centre lasts for the run, standby included: state.json's skipped lists
// the stories for status and the page, and a "build next" request for a skipped story clears the
// skip and starts it.

import { existsSync, rmSync } from 'node:fs';
import { claimFile, claims, holderOf, letGoClaim, ownerClaim } from './locks.mjs';
import { afterFixCheck, apiHeldText, LET_GO_PATCH, pendingCommands, releaseAfterWait, releaseHeld, resumeHeld, slotStoryId } from './scheduler.mjs';
import { hhmm } from './claude-fallback.mjs';
import { retryWhen } from './credit-resume.mjs';
import { openConsole } from './console.mjs';
import { answerNote, queueStoryNote } from './story-notes-queue.mjs';
import { worktreeOf } from './worktree.mjs';
import { runAsync } from './run-async.mjs';
import { answerSkips, answersToApply, applyAnswers, failedAnswer, heldForAnswer, waitsForAnswer } from './answers.mjs';
import { ownerEnv } from './run-guard.mjs';
import {
  readSlot,
  setSlot,
} from './state.mjs';
import { answerFailures, BASE_REF, branchOf, closing, CONFIG, control, crashes, DIR, downs, dropCheckpoint, endChildren, event, FOREMAN_BIN, git, guarded, HALT, handled, inHandSessions, loopChildren, markHandled, NODE, now, OWN, preparing, releaseToken, ROOT, saveRun, saveSkipped, sessions, setHaltSeen, signins, skipped, SLOT_IDS, slotChildren, slotIndex, stories, updateStory, work, workerChanges } from './run-context.mjs';
import { killSession, tidyFolder } from './slot-starts.mjs';
import { counters } from './session-lifecycle.mjs';
import { closeHaltTasks } from './story-followups.mjs';

export let answersRun = null; // the promise of the owner answers being applied, or null
export let fixCheck = null; // the promise of the health check after the owner says the cause is fixed, or null

// ── the owner's commands ─────────────────────────────────────────────────────────────────────

export const afterOwnerStop = guarded('an owner command', (slot, id, why) => {
  if (why === 'skip') {
    skipped.add(id);
    saveSkipped();
    dropCheckpoint(slot, id);
    letGoClaim(DIR, id, OWN);
    releaseToken(slot);
    updateStory(id, { progress: `Skipped from the command centre for the rest of this run; its branch is kept. \`foreman next ${id}\` (Build next) builds it again.` });
    tidyFolder(slot, id);
    setSlot(DIR, slot, LET_GO_PATCH, now());
    event(`${id} skipped for this run.`, 'warn', slot);
  } else if (why === 'takeover') {
    dropCheckpoint(slot, id);
    handOver(slot, id);
  } else if (why === 'restart') {
    restartFresh(slot, id);
  } else {
    setSlot(DIR, slot, { state: 'idle', story: null, result: null }, now());
  }
});

// Take over: whatever the slot has is committed and pushed, and the story is the owner's.
function handOver(slot, id) {
  const path = worktreeOf(DIR, slotIndex(slot) + 1);
  const branch = branchOf(id);
  const onBranch = git(path, 'rev-parse', '--abbrev-ref', 'HEAD').stdout === branch;
  if (onBranch) {
    if (git(path, 'status', '--porcelain').stdout) {
      git(path, 'add', '-A');
      git(path, 'commit', '--quiet', '-m', `${id} WIP: handed to the owner`);
    }
    git(path, 'push', '--quiet', '-u', CONFIG.remote, branch);
  }
  ownerClaim(DIR, id);
  releaseToken(slot);
  updateStory(id, { fields: { status: 'blocked', blocked_by: 'Taken by the owner' }, progress: `Taken over from the command centre. ${onBranch ? `Its work is on the branch ${branch}.` : 'No work had started.'} Hand it back on the command centre when the factory should carry on.` });
  tidyFolder(slot, id);
  setSlot(DIR, slot, LET_GO_PATCH, now());
  event(`${id} handed to you.`, 'info', slot);
}

function restartFresh(slot, id) {
  const path = worktreeOf(DIR, slotIndex(slot) + 1);
  if (!tidyFolder(slot, id)) {
    git(path, 'reset', '--quiet', '--hard');
    git(path, 'clean', '-fdq');
    git(path, 'checkout', '--quiet', '--detach', BASE_REF);
    event(`Slot ${slot}: the changes in its folder could not be saved, so restarting ${id} fresh discarded them.`, 'warn', slot);
  }
  git(path, 'branch', '-D', branchOf(id));
  crashes.delete(id);
  signins.delete(id);
  dropCheckpoint(slot, id);
  setSlot(DIR, slot, { state: 'idle', reason: '', story: null, result: null, parkedFor: null, parkedStory: null }, now());
  work.unshift({ slot, id, mode: 'fresh' });
}

function slotCommand(slot, action) {
  const st = readSlot(DIR, slot);
  const running = sessions.get(slot);
  const pending = preparing.has(slot);
  const id = slotStoryId({ st, running, claims: claims(DIR), slot });
  const path = worktreeOf(DIR, slotIndex(slot) + 1);
  switch (action) {
    case 'skip':
    case 'takeover':
    case 'restart':
      if (!id) return;
      if (running) killSession(slot, action);
      else {
        // A prepare still in flight never starts a session for a story the owner moved.
        preparing.cancel(slot);
        endChildren(slotChildren(slot));
        afterOwnerStop(slot, id, action);
      }
      return;
    case 'park':
      if (running || pending) setSlot(DIR, slot, { parkAfter: true }, now());
      else if (st.state === 'idle' || st.state === 'down') setSlot(DIR, slot, { state: 'parked', parkedFor: 'owner', reason: 'Parked by you.' }, now());
      return;
    case 'unpark': {
      // The slot lets go of the story it was parked on; the picker takes it again by priority
      // (In Progress first), so no work is queued for it.
      if (st.state !== 'parked') return;
      const gone = id ? letGoClaim(DIR, id, OWN) : null;
      if (id) crashes.delete(id);
      if (id) signins.delete(id);
      releaseToken(slot);
      setSlot(DIR, slot, { state: 'idle', parkedFor: null, parkedStory: null, reason: '' }, now());
      if (gone) event(`Slot ${slot} unparked; let go of ${id}, which is picked again by priority.`, 'info', slot);
      return;
    }
    case 'resume':
      if (st.state === 'down') {
        downs.delete(slot);
        setSlot(DIR, slot, { state: 'idle', reason: '' }, now());
        if (id) work.unshift({ slot, id, mode: '' });
      } else if (st.state === 'parked' && id) {
        crashes.delete(id);
        signins.delete(id);
        setSlot(DIR, slot, { state: 'idle', parkedFor: null, parkedStory: null, reason: '' }, now());
        work.unshift({ slot, id, mode: '' });
      } else if (st.state === 'held') {
        // A story held for the Claude API: queue it now. A backoff still running holds the work
        // back through canPick; a halt's held slot waits for "I've fixed it".
        for (const r of resumeHeld([{ slot, st }])) {
          setSlot(DIR, slot, r.patch, now());
          if (!work.some((w) => w.id === r.work.id)) work.unshift(r.work);
          event(`${r.work.id}: resumed from the command centre.`, 'info', slot);
        }
      }
      return;
    case 'resume-as-is':
      // Keep the changes. With a story they are that story's work; without one they are put
      // aside in a git stash, so nothing is lost and the slot can take a new story.
      if (!id) git(path, 'stash', 'push', '--include-untracked', '--quiet', '-m', `slot ${slot} leftovers ${now().toISOString()}`);
      setSlot(DIR, slot, { state: 'idle', parkedFor: null, reason: '' }, now());
      if (id) work.unshift({ slot, id, mode: '' });
      return;
    case 'discard': {
      git(path, 'reset', '--quiet', '--hard');
      git(path, 'clean', '-fdq');
      git(path, 'checkout', '--quiet', '--detach', BASE_REF);
      // With nothing running or being set up here, the slot lets go of its story too; the picker
      // takes it again by priority.
      const gone = id && !running && !pending ? letGoClaim(DIR, id, OWN) : null;
      if (!running && !pending) releaseToken(slot);
      setSlot(DIR, slot, { state: 'idle', parkedFor: null, parkedStory: null, reason: '' }, now());
      if (gone) event(`Slot ${slot} reset; let go of ${id}, which is picked again by priority.`, 'info', slot);
      return;
    }
    default:
  }
}

// The slots held for the Claude API show when the wait ends. A later backoff can move that time,
// so the shown text follows counters.backoffUntil.
export function retimeApiHeld() {
  const why = apiHeldText(counters.backoffUntil > Date.now() ? hhmm(counters.backoffUntil) : null);
  for (const slot of SLOT_IDS) {
    const st = readSlot(DIR, slot);
    if (st.state !== 'held' || st.heldFor !== 'api') continue;
    if (st.reason === why && st.story?.detail === why) continue;
    setSlot(DIR, slot, { reason: why, story: st.story ? { ...st.story, detail: why } : st.story }, now());
  }
}

// Once the Claude API wait is over (and nothing is paused, halted or stopping), the slots held
// for it are released and their stories queued, as an automatic resume, to start again this tick. A slot a
// halt holds waits for "I've fixed it" (fixed). On a fresh start the counters are zero, so a slot
// an earlier run held is released at the first tick; a story already queued or running is not
// queued twice.
export function releaseApiHeld({ halted, paused, stopping }) {
  const inHand = new Set([...work.map((w) => w.id), ...inHandSessions().map((s) => s.id)]);
  const slots = SLOT_IDS.map((slot) => ({ slot, st: readSlot(DIR, slot) }));
  for (const r of releaseAfterWait(slots, { halted, paused, stopping, backoffUntil: counters.backoffUntil, now: Date.now(), inHand })) {
    setSlot(DIR, r.slot, r.patch, now());
    if (r.work) work.push(r.work);
    const id = r.work?.id ?? slots.find((x) => x.slot === r.slot).st.heldStory;
    event(`${id}: the Claude API wait is over; carrying on from where it stopped.`, 'info', r.slot);
  }
}

// "I've fixed it": run `foreman health` (the configured ship steps' checks, such as the live
// site and the hosted database); only when it passes, clear the halt and release what was
// held, oldest first. The check loads the project's env file itself. A released slot keeps
// heldStory until the story's session starts (startSession), so the env sweep keeps its org.
function fixed() {
  // A press while a check runs is folded into it.
  if (!existsSync(HALT) || fixCheck) return;
  fixCheck = runAsync(NODE.node(), [FOREMAN_BIN, 'health'], { cwd: ROOT, timeoutMs: 120_000, track: loopChildren })
    .then(
      guarded('the health check', (res) => {
        // Cleared meanwhile (the halt file removed by hand): nothing to judge.
        if (!existsSync(HALT)) return;
        const answer = afterFixCheck({ status: res.status, stdout: res.stdout.trim() });
        if (!answer.clear) {
          saveRun({ fixProblem: answer.fixProblem });
          event(answer.event.text, answer.event.kind);
          return;
        }
        const clearedAt = now();
        rmSync(HALT, { force: true });
        setHaltSeen(false);
        saveRun({ fixProblem: null });
        event(answer.event.text, answer.event.kind);
        closeHaltTasks(clearedAt);
        for (const r of releaseHeld(SLOT_IDS.map((slot) => ({ slot, st: readSlot(DIR, slot) })))) {
          setSlot(DIR, r.slot, r.patch, now());
          work.push(r.work);
        }
      }),
    )
    .finally(() => {
      fixCheck = null;
    });
}

function handBack(id) {
  const c = holderOf(claimFile(DIR, id));
  if (c?.by !== 'owner') return;
  rmSync(claimFile(DIR, id), { force: true });
  updateStory(id, { fields: { status: 'todo', blocked_by: '' }, progress: 'Handed back to the factory from the command centre.' });
  event(`${id} handed back to the factory.`, 'info');
}

export function commands() {
  const c = control();
  for (const cmd of pendingCommands(c, handled(), SLOT_IDS)) {
    // The slot's session is being read: the command is left unmarked, so it applies once that ends.
    if (cmd.kind === 'slot' && closing.has(cmd.slot)) continue;
    markHandled(cmd.key, cmd.at);
    // Applied with any settings change in applySettings(), the newer one winning.
    if (cmd.kind === 'workers') workerChanges.push({ value: cmd.value, at: Date.parse(cmd.at) || Date.now() });
    else if (cmd.kind === 'slot') slotCommand(cmd.slot, cmd.action);
    else if (cmd.kind === 'fixed') fixed();
    else if (cmd.kind === 'handback') handBack(cmd.id);
    else if (cmd.kind === 'answer-retry') retryAnswer(cmd.id);
  }
}

// The owner pressed Retry on a failed answer: due now, applied by the next startAnswers.
function retryAnswer(id) {
  const failure = answerFailures.get(id);
  if (!failure) return;
  answerFailures.set(id, { ...failure, retryAt: now().toISOString() });
  saveAnswerFailures();
  event(`Retrying your answer to "${failure.title}" now.`, 'info');
}

// The local date, YYYY-MM-DD.
const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// The failures as the page reads them, kept in state.json.
function saveAnswerFailures() {
  saveRun({ answerFailures: [...answerFailures.values()] });
}

// Starts applying the owner's answers the supervisor applies (answers.mjs): every kind when no
// session runs, or only `kinds` (EVERY_TICK while sessions run; answers.mjs says why those are
// safe). The steps run in children (`foreman`, gh, git; none holds the loop), one apply at a time:
// while answersRun is set no new apply starts and the tick starts no story anywhere, so an answer
// is never applied twice and no pick runs beside one. A story answer (close or answer) is applied
// only to a story that waitsForAnswer allows, read fresh for each item with what holds a story
// now: a live claim (an owner claim never goes stale), a session, queued work, or a slot held or
// parked on it (its claim may read stale after a restart). So a second answer for a story the
// first just put back to todo is left to that story's session. A problem here is an event, never
// the end of the run; an answer that failed is kept in answerFailures (state.json's
// answerFailures, which the page shows on Waiting on you as "could not apply: <step>" with a
// Retry) and tried again after a growing wait (answers.mjs ANSWER_RETRY_MS: 1, 2, 5, 15, then 30
// minutes), or at once when the owner presses Retry (control.json's answerRetry, the
// answer-retry command). Only this function applies answers, one apply at a time, so a retry
// never applies one twice.
export async function startAnswers(kinds = null) {
  if (answersRun) return;
  try {
    const items = await openConsole({ config: CONFIG, ctx: { stateDir: DIR, now } }).decisions.pending();
    // An answer given anywhere (the page of the artifacts console, say) is written on its story too;
    // the ledger drops the ones already posted.
    for (const item of items) if (item.answer) queueStoryNote(DIR, { ...answerNote(item), at: now(), slot: null });
    const canRequeue = (id) => {
      try {
        const source = stories();
        const held = heldForAnswer({ claims: claims(DIR), sessions: inHandSessions(), work, slots: SLOT_IDS.map((s) => readSlot(DIR, s)) });
        return waitsForAnswer(source.list().find((s) => s.id === id), { held, idPattern: source.idPattern });
      } catch {
        return false;
      }
    };
    // A failure whose answer is no longer pending (applied by hand, or gone) is forgotten.
    const pending = new Set(items.map((i) => i.id));
    let changed = false;
    for (const id of [...answerFailures.keys()]) if (!pending.has(id)) changed = answerFailures.delete(id) || changed;
    if (changed) saveAnswerFailures();
    const skip = answerSkips(answerFailures, Date.now());
    const todo = answersToApply(items, { skip, kinds, canRequeue });
    if (todo.length === 0) return;
    // runAsync's { status, stdout } with the output trimmed, as the steps read it; a time-out is status null.
    const owned = (run) => run.then((r) => ({ status: r.status, stdout: r.stdout.trim() }));
    answersRun = applyAnswers(
      todo.map((t) => t.item),
      {
        foreman: (args) => owned(runAsync(NODE.node(), [FOREMAN_BIN, ...args], { cwd: ROOT, env: ownerEnv(process.env), timeoutMs: 120_000, track: loopChildren })),
        gh: (args) => owned(runAsync('gh', args, { cwd: ROOT, timeoutMs: 30_000, track: loopChildren })),
        git: (args) => owned(runAsync('git', args, { cwd: ROOT, timeoutMs: 60_000, track: loopChildren })),
        branchPrefix: CONFIG.branchPrefix,
        remote: CONFIG.remote,
        today: localDate(now()),
        skip,
        kinds,
        canRequeue,
        onItem: (item) => event(`Applying your answer to "${item.title}".`, 'info'),
      },
    )
      .then((results) => {
        const at = Date.now();
        for (const r of results) {
          if (r.ok) {
            event(r.text, 'info');
            answerFailures.delete(r.id);
          } else {
            answerFailures.set(r.id, failedAnswer(answerFailures.get(r.id), r, at));
            event(`${r.text} Foreman tries it again at ${retryWhen(answerFailures.get(r.id).retryAt, at)}.`, 'warn');
          }
        }
        if (results.length) saveAnswerFailures();
      })
      .catch((err) => event(`Could not apply the owner's answers: ${String(err?.message ?? err).slice(0, 200)}`, 'warn'))
      .finally(() => {
        answersRun = null;
      });
  } catch (err) {
    event(`Could not apply the owner's answers: ${String(err?.message ?? err).slice(0, 200)}`, 'warn');
  }
}
