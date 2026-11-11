// Everything waiting on the owner, as one list: the dashboard's GET /api/waiting, and the
// "Waiting on you" count in the snapshot and in `foreman status`. Pure: the caller reads the
// files (state.mjs ownerWaiting) and passes them in.
//
// Each item is { id, kind, title, why, blocks: [ids], frees: [ids], link?, details?, actions: [{ id, label }] }:
//
//   decision    a pending item from `foreman decide` (id d-…): its options, or one answer in
//               words; an item from the artifacts console's copy counts but has no action here.
//               Its why is the summary (cut to 160), else the body's first paragraph (cut to 300
//               at a sentence end, else at a word with "…"); details is the whole body, when it
//               has one. Each option action is { id: option-<its index>, label, hint, recommended }:
//               hint is the option's own hint or null; the first option whose label is the
//               recommended one is recommended and comes first, a later one with the same label is not.
//               explain, only when the decision has one with some text in it, is its plain-words
//               explanation { purpose?, happened?, damage?, recommendation? }: the text parts,
//               trimmed, each cut to 280 (lib/console/decisions.mjs explain)
//   owner-task  an open owner task (task:<story id>): Mark done, the `foreman story done` path
//   halt        the run is halted (halt): I fixed it, the `foreman fixed` path
//   release     a story ready to promote (release:<story id>): Check now, `foreman release watch`;
//               its why is the park reason plus " Last check: <outcome>." only, never
//               lastCheck.detail, which can hold what a tool printed (a URL with a password,
//               say): the snapshot carries these items to the artifacts console
//   slot        a parked or down slot (slot:<wN>): its slot actions
//   run         why the run is idle or needs the owner; no blocks or frees: run:nothing-left, the
//               run stopped with "Nothing left to build." (a run with a limit or
//               --exit-when-idle; a run without stays on standby) while open stories remain ("Nothing
//               left to build: N stories wait on your tasks."), and run:jira, picking paused
//               because Jira is not reachable (the refresher's reason), both from the loop in
//               state.json and with no actions; run:config, a now item with no actions while the
//               loop is not stopped and state.json has configProblem: foreman.config.json turned
//               invalid under the run, which carries on with the last good config ("config
//               invalid since HH:MM: <reason>; running on the last good config",
//               engine/config-health.mjs configProblemWhy); run:stuck, a now item with no actions
//               while the loop is not stopped and state.json has stuck: the run is not making
//               progress (engine/progress-watch.mjs), titled "Not building for N minutes", its
//               why the reason cut to 300; run:slow:<slot>, an fyi item with no actions for each
//               `slow` entry (state.json's slow, a session active but in one stage past
//               watchdog.progressMinutes) while the loop is not stopped, titled "<id> is slow",
//               its why progress-watch.mjs slowText ("slow: ACME-1 in its fix round for 1 h
//               45 min (129 steps)"); never counted, never now, never best; run:restart, an
//               fyi item with no actions while the loop is not stopped and the `restartPending`
//               input (state.json's restartPending { from, to, since }) has a `to`: the run is
//               about to restart on new plugin code, titled "Restarting on new code", its why
//               code-version.mjs restartWhy ("New code (a1b2c3d → e4f5a6b): restarting as soon
//               as the slots being set up are ready; the stories in progress keep running.");
//               never counted, never now, never best; run:next, a now item with no actions while
//               the loop is not stopped and the `nextWait` input (state.json's nextWait { id, at,
//               since, tries, reason }, kept only for the open "build next" request) has an id:
//               "<id> cannot start next", its why next-request.mjs nextWaitWhy; run:anchor, a now
//               item with no actions, counted like run:config, while the loop is not stopped and
//               the `anchorWait` input (state.json's anchorWait { why, from, to, remote,
//               baseBranch, since, branch?, files? }) has a why and a to: the main checkout the
//               run's code sits in did not take the new code on the base branch, titled "The run
//               is not taking new code", its why anchor-pull.mjs anchorWaitWhy (which names the
//               files for a tracked change the new code also changes); and run:paused,
//               Foreman paused itself (the `autoPause` input, from state.json's autoPausedAt and autoPauseReason while
//               no resume came after it): its why is the reason (trimmed, cut to 300, else
//               "Foreman paused itself."), it is always now, and its action is Resume; when the input
//               has `retryAt` (a credit pause that tries again by itself: state.json's autoResumeAt)
//               the why ends with "Foreman tries again at HH:MM by itself." and the item carries
//               `retryAt`; run:api-wait, an fyi item with no actions while the loop is not stopped
//               and the `apiWait` input (state.json's apiWait { since, until, step }) ends in the
//               future, titled "Stuck waiting for the Claude API", its why "The Claude API is
//               limited or down (wait N); Foreman tries again at HH:MM by itself." (never counted,
//               never now, never best); run:env-wait, the same for the `envWait` input (state.json's
//               envWait { since, until, step }: three endings in a row were the environment and
//               Foreman waits them out), titled "Waiting out environment failures", its why "Three
//               endings in a row were the environment, not the stories (wait N); Foreman tries
//               again at HH:MM by itself." (never counted, never now, never best);
//               run:answer:<decision id>, a now item with the action Retry for each entry of the
//               `answerFailures` input (state.json's answerFailures { id, story, title, step, tries,
//               at, retryAt }: an owner answer the supervisor could not apply) with an id, a title
//               and a step, while the loop is not stopped: "Could not apply your answer to
//               "<title cut to 120>"", its why "could not apply: <step>. Foreman tries again at
//               HH:MM by itself." (or "... at its next check." once retryAt has passed); counted;
//               run:learning, an fyi item with no actions while the loop is not stopped and the
//               `learningFailed` input (state.json's learningFailed { count, since, why, log },
//               kept once the background learning tick has failed twice or more in a row) has a
//               whole count of 2 or more and a why: titled "The learning tick failed N times in a
//               row", its why the last failure's warn text (cut to 300), never counted, never
//               now, never best;
//               run:files, an fyi item with no actions while the loop is not stopped and the
//               `fileWait` input (file-locks.mjs topFileWait: { id, on, text }, the highest-priority
//               story waiting on files) names a story: titled "<id> waits for <holders>", its why
//               "The highest-priority story waiting on files: <text>" (never counted, never now,
//               never best);
//               run:strays, an fyi item while the loop is not stopped and the `strays` input
//               ({ count }, the live pids of state.json's strays, engine/strays.mjs) counts any:
//               "N stray processes running", supervisors, hook runs and `foreman learn` or `notify` runs that are not this run's (a run kept
//               in a temp folder counts too), with the action End them (end); never counted, never now, never best; run:subscription, an fyi item with no actions whenever the
//               `claudeSignIn` input (engine/claude-fallback.mjs readSignIn) says the run moved to
//               the subscription because the platform credits ran out, whatever the loop does,
//               since the switch outlives the run: "Platform credits ran out at HH:MM; now using
//               your Claude subscription. After topping up, run `foreman claude use-key` …", or
//               after the key's usage limit "The Console API key reached its usage limit at HH:MM
//               (access returns …); … When access returns or you raise the key's limit, run …"
//   learned     a change Foreman learned, or took out again, by itself (a files decision with a
//               learned or rolled-back title): always fyi, with its own actions (see below)
//
// `bundle` marks a decision the owner can answer together with the others like it, as one
// Quick decision (answered through lib/console/bundles.mjs): 'follow-ups' for `foreman learn`'s
// follow-up proposals ("Follow up on <ID>: <n> minor finding(s)?", answers.mjs), which also carry
// `story` (the shipped story) and `minor` (<n>); 'traits' for its trait proposals. Only a files
// decision with options is bundled; any other item has none of the three keys. waitingCount
// counts a bundle as one.
//
// `blocks` is what cannot be built until the item is dealt with (engine/pick.mjs dependentsOf).
// A decision blocks its story and what waits on it, but not a story the list has as done or
// retired (a follow-up on a shipped story blocks nothing).
//
// `frees` is what becomes buildable as soon as the item is dealt with (engine/pick.mjs freedBy):
// for an owner task or a release, the open stories with no other unmet blocker; for a decision,
// its story when that is an open story, not an owner task, whose dependsOn is all met; for a
// slot, its story; for the halt, the stories it holds. A now owner task's why says what it frees:
// "Frees A now. N stories wait on it." or, when it frees nothing but something waits on it,
// "Frees nothing by itself: B also waits on C." ("B is also blocked." when B is blocked in words),
// or just "N stories wait on it." when no story waits on it directly.
//
// `group` is 'now' (the owner can act on it today), 'later' or 'fyi'. Only an owner task can be later:
// one whose dependsOn (Jira's "is blocked by") still has an open blocker. It then carries
// `waitsOn`, its open blockers in dependsOn order, and its why reads "Can start after …".
// A blocker is open when it is a story in the list that is todo, in progress or blocked, or an
// id not in the list that the Jira source names in the task's externalDeps (outside the filter
// and not done). Anything else is met: done, retired, unknown, or outside and done.
// A blocker never holds a task back when it is the task itself or waits on it, directly or through
// other open stories (a cycle), and none of its open blockers can move without the task. So a task
// in a cycle is now, but a task waiting on a loop that never reaches it stays later.
//
// An 'fyi' item is never counted. A run item that is fyi has no actions. The dependency notes,
// the notes about follow-ups Foreman created and the learned changes (isFyiNote) are fyi, and
// block and free nothing. A files decision titled "<ID> now waits for <ids>" (answers.mjs kindOf
// 'waits', a dependency Foreman added itself) stays kind 'decision' with its options (Undo and
// Keep, option-<n>), and so does one titled "Foreman created <n> follow-up stories" (kindOf
// 'created', follow-up stories `foreman learn` created itself) with Undo and close them and Keep
// them. A learned change is kind 'learned':
//   learned  { id: 'L-n', change, roles } (answers.mjs learnedNote)
//   actions  for one titled "Foreman learned <L-n> for <role>" or "Foreman changed <L-n> for
//            <role>" (change add or update, a trait or skill Foreman wrote itself): { id: 'undo',
//            label: 'Undo the change', hint } and { id: 'keep', label: 'Keep the change', hint },
//            which the dashboard runs at once through the store (lib/console/learned.mjs); for one
//            titled "Foreman rolled back <L-n> for <role>", "Foreman retired <L-n> for <role>"
//            (rollback or retire, a change Foreman took out itself after evaluating it) or "Foreman
//            did not undo <L-n> for <role>" (an Undo answered on a note whose version Foreman
//            replaced since, which undid nothing): only { id: 'ok', label: 'Got it', hint }, since
//            the store cannot redo a rollback
//   hint is the decision's own hint for that option, cut to 100, else null; none is recommended.
// Its title, why and details are a decision's.
// A Jira pause is fyi for its first 30 minutes ("Picking paused since HH:MM: …"), because the
// computer sleeping or the network dropping causes most and the refresher retries every minute;
// from 30 minutes it is now ("Still not reachable after 30 minutes: …"). The clock starts at the
// HH:MM in the reason, local time as the refresher wrote it, not at loop.since: setLoop resets
// since whenever the reason's text changes, and the failure's words change between tries.
//
// Order: the now items first. Among them the halt first, because it stops every slot; then
// the self-pause, because nothing new starts until it is resumed; then the run being stuck,
// because nothing moves until its cause goes; then urgent decisions; then parked or down slots;
// then the most freed; then the most blocking; then the newest, with no time last; then the id.
// Then the later items, the fewest open blockers first, ties in the same order.
// Then the fyi items, in the order they were made: the run items, then the dependency notes and
// learned changes.
//
// `headline({ items, loop, slots, stranded, clock })` (clock: the time to compare a retry time with, now by default) is the one line at the top of the Waiting on you tab and in
// the Command centre: { state, text, best }. It takes buildWaiting's whole list, the loop from
// state.json and the shown slots ({ id, state, story }). `best` is the id of the one item to do
// first: the halt, else the self-pause when it is in the list, else run:stuck when it is, else the
// first down slot whose item is in the list, else the first now item (the list's own order breaks
// ties), else null. The first state that fits wins: halted (a halt item, or the loop halted);
// paused (for Jira with the HH:MM from the reason, from the Command centre, or for its own reason);
// stuck (the loop running and a run:stuck item: "Running, but stuck: <its why>.", state running,
// never the Building line); standby (the loop waiting for something to build: when a failed story's decision ("<ID> could
// not pass review" or "<ID> could not be released") blocks other stories, "Standby: nothing to
// build. <ids> failed and holds up N stories. Picks up new stories automatically."; else
// "Standby: nothing to build. <why>. Picks up new stories automatically.", the why being how many stories wait on the
// owner's tasks or on the owner, else how many things need the owner, else how many tasks open up
// as stories ship, else "Nothing waits on you"; but while any now item is a follow-up proposal, of
// the bundle 'follow-ups', "Standby: N follow-up proposals wait on you.", then, from the other
// items alone, " N stories wait on <your tasks or you>." or " N other things need you." when
// there are any, then " Picks up new stories automatically."); running (the loop running and a
// slot building or
// waiting on a story: what it builds and how many things need the owner, none stopping the run);
// else idle: how many stories are left waiting on the owner's tasks (or on the owner, when anything
// but an owner task holds one), the best item and what it frees, or why there is nothing to do.
// `stranded` (strandedStories, state.mjs ownerWaiting) names the stories left In Progress with
// nothing running them: when it has any, "<ids> is In Progress with nothing running it." (or "are
// ... running them." for several) follows the standby, running and idle texts after one space.
// The halted, paused and stuck texts never carry it, and state and best never change for it.
//
// `standbyNews(items)` is the one sentence the run says when it reaches standby with things
// waiting: { text, starts } or null when no now item waits (the group is neither 'later' nor
// 'fyi', as waitingCount counts). text counts, in this order and each left out at zero, the
// follow-up proposals (bundle 'follow-ups'), owner tasks, other decisions and other things,
// then says what one answer starts: "Standby: 3 follow-up proposals and 1 owner task wait on you;
// finishing ACME-300 starts ACME-301." The tail names the item that frees most stories (the
// first on a tie): "finishing <task id> starts <ids>." for an owner task, "one answer starts
// <ids>." for another item; when nothing frees anything, "answering the follow-up proposals
// creates their stories." if follow-ups wait, else "no answer starts a story by itself."
// starts is what that item frees, [] for none. Pure.
//
// `strandedStories({ stories, claimed, slots, skipped })` is the ids, sorted by number, of the
// stories in progress, not owner tasks, that no live claim (`claimed`), no slot (its story,
// heldStory or parkedStory) and no skip this run holds: a story a session left In Progress that
// the run will not pick again by itself.

import { isAbsolute, relative } from 'node:path';
import { failedStoryOf, kindOf, learnedNote, slotHolds } from '../engine/answers.mjs';
import { EXPLAIN_PARTS } from './decisions.mjs';
import { dependentsOf, freedBy, waitersOf } from '../engine/pick.mjs';
import { configProblemWhy } from '../engine/config-health.mjs';
import { slowText, stuckTitle } from '../engine/progress-watch.mjs';
import { creditsOutFyi } from '../engine/claude-fallback.mjs';
import { retryWhen, retrySentence } from '../engine/credit-resume.mjs';
import { restartWhy } from '../engine/code-version.mjs';
import { nextWaitWhy } from '../engine/next-request.mjs';
import { anchorWaitWhy } from '../engine/anchor-pull.mjs';
import { actionsFor, NOTHING_LEFT } from '../engine/scheduler.mjs';

// The page's names for the slot actions (page.html ACTION_LABEL).
export const SLOT_LABELS = {
  skip: 'Skip story',
  takeover: 'Take over',
  park: 'Park',
  unpark: 'Unpark',
  resume: 'Resume',
  restart: 'Restart fresh from main',
  'resume-as-is': 'Resume as is',
  discard: 'Discard changes and reset',
};

const OPEN = ['todo', 'in-progress', 'blocked'];
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const cut = (text, n) => String(text ?? '').slice(0, n);

// The first paragraph of a body, on one line, in at most n characters: whole when it fits, else
// up to its last sentence end that fits, else up to its last whole word with "…".
function firstParagraph(body, n) {
  const para = body.trim().split(/\n\s*\n/)[0].replace(/\s+/g, ' ');
  if (para.length <= n) return para;
  const ends = [...para.slice(0, n + 1).matchAll(/[.!?](?=\s)/g)].filter((m) => m.index < n);
  if (ends.length) return para.slice(0, ends.at(-1).index + 1);
  const space = para.lastIndexOf(' ', n - 1);
  const words = space > 0 ? para.slice(0, space).replace(/[\s,;:]+$/, '') : '';
  return `${words || para.slice(0, n - 1)}…`;
}

// The text parts of a decision's explanation, trimmed and cut to 280, or null when it has none.
function explainOf(d) {
  if (!d.explain || typeof d.explain !== 'object') return null;
  const parts = EXPLAIN_PARTS.filter((p) => isText(d.explain[p]));
  return parts.length ? Object.fromEntries(parts.map((p) => [p, cut(d.explain[p].trim(), 280)])) : null;
}

function decisionWhy(d) {
  if (isText(d.summary)) return cut(d.summary.trim(), 160);
  if (isText(d.body)) return firstParagraph(d.body, 300);
  return `${d.story} needs your ${d.kind === 'task' ? 'answer' : 'decision'}`;
}

// The options as actions, the recommended one first: only the first option with the
// recommended label, so a duplicate label is not recommended twice. Each id keeps the option's
// own index, which is how the server maps an answer back to its label.
function optionActions(d, options) {
  const hints = Array.isArray(d.hints) ? d.hints : [];
  const first = options.indexOf(d.recommend);
  const actions = options.map((label, i) => ({ id: `option-${i}`, label, hint: isText(hints[i]) ? cut(hints[i].trim(), 100) : null, recommended: i === first }));
  return [...actions.filter((a) => a.recommended), ...actions.filter((a) => !a.recommended)];
}
const unique = (list) => [...new Set(list)];

// A learned note's actions (see the header): Undo and Keep for a change in force, Got it for one
// Foreman took out itself. Each hint is the decision's own for that option, cut to 100, else null.
const LEARNED_ACTIONS = {
  change: [['undo', 'Undo the change'], ['keep', 'Keep the change']],
  out: [['ok', 'Got it']],
};
function learnedActions(d, learned) {
  const options = Array.isArray(d.options) ? d.options : [];
  const hints = Array.isArray(d.hints) ? d.hints : [];
  const which = learned?.change === 'add' || learned?.change === 'update' ? 'change' : 'out';
  return LEARNED_ACTIONS[which].map(([id, label]) => {
    const hint = hints[options.indexOf(label)];
    return { id, label, hint: isText(hint) ? cut(hint.trim(), 100) : null };
  });
}

// "A", "A and B", "A, B and C", then "A, B and N more".
export function names(ids) {
  if (ids.length === 1) return ids[0];
  if (ids.length <= 3) return `${ids.slice(0, -1).join(', ')} and ${ids.at(-1)}`;
  return `${ids[0]}, ${ids[1]} and ${ids.length - 2} more`;
}

const canStartAfter = (ids) => `Can start after ${names(ids)}.`;

// A Jira URL as is; a file inside the project relative to it; anything else no link, because
// the snapshot leaves the machine and a local path can name the owner's home folder.
function linkOf(ref, root) {
  if (!isText(ref)) return null;
  if (ref.startsWith('https://')) return ref;
  if (!root) return null;
  const rel = relative(root, ref);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : null;
}

// The bundle a decision belongs to, or null: 'follow-ups' or 'traits', by answers.mjs kindOf.
export function bundleOf(d) {
  if (d?.kind !== 'decision' || !Array.isArray(d.options) || !d.options.length) return null;
  const kind = kindOf(d);
  if (kind === 'followUp') return 'follow-ups';
  if (kind === 'trait') return 'traits';
  return null;
}

// Whether a decision is a dependency note: one Foreman wrote when it added a dependency itself
// ("<ID> now waits for <ids>", answers.mjs kindOf 'waits'), with its options. It is FYI.
export function isDependencyNote(d) {
  return d?.kind === 'decision' && Array.isArray(d.options) && d.options.length > 0 && kindOf(d) === 'waits';
}

// Whether a decision is an FYI note: a dependency note, a note about follow-up stories Foreman
// created itself ("Foreman created <n> follow-up stories", kindOf 'created'), a learned change
// Foreman wrote when it learned a trait or skill itself ("Foreman learned|changed <L-n> for
// <role>", kindOf 'learned'), or one it took out again after evaluating it ("Foreman rolled
// back|retired|did not undo <L-n> for <role>", kindOf 'rolledBack'), with its options.
export function isFyiNote(d) {
  return d?.kind === 'decision' && Array.isArray(d.options) && d.options.length > 0 && ['waits', 'created', 'learned', 'rolledBack'].includes(kindOf(d));
}

// The bundle keys of a files decision: none, { bundle }, or for a follow-up { bundle, story, minor }.
function bundleKeys(d) {
  const bundle = bundleOf(d);
  if (!bundle) return {};
  if (bundle !== 'follow-ups') return { bundle };
  return { bundle, story: d.story, minor: Number(String(d.title).match(/: (\d+) minor finding/)?.[1] ?? 0) };
}

// How many things wait on the owner now: the items in neither the later nor the fyi group,
// each bundle once.
export function waitingCount(items) {
  const now = (Array.isArray(items) ? items : []).filter((i) => i?.group !== 'later' && i?.group !== 'fyi');
  return now.filter((i) => !isText(i?.bundle)).length + new Set(now.map((i) => i?.bundle).filter(isText)).size;
}

export function standbyNews(items) {
  const now = (Array.isArray(items) ? items : []).filter((i) => i && i.group !== 'later' && i.group !== 'fyi');
  if (!now.length) return null;
  const followUps = now.filter((i) => i.bundle === 'follow-ups').length;
  const tasks = now.filter((i) => i.kind === 'owner-task').length;
  const decisions = now.filter((i) => i.kind === 'decision' && i.bundle !== 'follow-ups').length;
  const other = now.length - followUps - tasks - decisions;
  const parts = [
    followUps && plural(followUps, 'follow-up proposal', 'follow-up proposals'),
    tasks && plural(tasks, 'owner task', 'owner tasks'),
    decisions && plural(decisions, 'decision', 'decisions'),
    other && plural(other, 'other thing', 'other things'),
  ].filter(Boolean);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
  let best = null;
  for (const i of now) {
    const frees = Array.isArray(i.frees) ? i.frees : [];
    if (frees.length > (best?.frees.length ?? 0)) best = { id: i.id, kind: i.kind, frees };
  }
  const starts = best ? [...best.frees] : [];
  let tail;
  if (best?.kind === 'owner-task') tail = `finishing ${String(best.id).replace(/^task:/, '')} starts ${names(starts)}.`;
  else if (best) tail = `one answer starts ${names(starts)}.`;
  else if (followUps) tail = 'answering the follow-up proposals creates their stories.';
  else tail = 'no answer starts a story by itself.';
  return { text: `Standby: ${list} ${now.length === 1 ? 'waits' : 'wait'} on you; ${tail}`, starts };
}

const JIRA_DOWN = /Jira not reachable since (\d{2}):(\d{2})/;
const JIRA_LATE_MS = 30 * 60000;
const pad = (n) => String(n).padStart(2, '0');

// Why the run is idle or needs the owner, as run items (see the header). `loop` is state.json's
// { state, reason, since }; `configProblem` its { since, reason } or null; `stuck` its
// { kind, since, reason } or null; `slow` its [{ slot, id, since, stage, rounds, steps }];
// `restartPending` its { from, to, since } or null; `claudeSignIn` claude-signin.json's record
// or null; `strays` { count } of the stray processes still running (supervisors, hook runs, learn
// or notify runs), or null; `nextWait` the open "build next" request that keeps failing to start,
// or null; `apiWait` its { since, until, step } while the Claude API is limited or down, or null;
// `envWait` the same while Foreman waits out environment failures, or null;
// `fileWait` the top waiting story's { id, on, text } (file-locks.mjs topFileWait), or null;
// `learningFailed` state.json's { count, since, why, log } once the learning tick has failed twice
// or more in a row, or null; `answerFailures` state.json's list of { id, story, title, step, tries,
// at, retryAt }, the owner answers the supervisor could not apply; `anchorWait` state.json's
// record of the main checkout not taking new code (anchor-pull.mjs anchorWaitOf), or null.
function runItems(loop, stories, now, configProblem, stuck, slow, restartPending, claudeSignIn, strays, nextWait, apiWait, fileWait = null, learningFailed = null, answerFailures = [], anchorWait = null, envWait = null) {
  const items = [];
  const run = (fields) => ({ kind: 'run', blocks: [], frees: [], actions: [], ...fields });
  if (isText(configProblem?.reason) && loop?.state !== 'stopped') {
    items.push(run({ id: 'run:config', title: 'foreman.config.json is invalid', why: configProblemWhy(configProblem, now), group: 'now', at: configProblem.since }));
  }
  if (isText(stuck?.reason) && loop?.state !== 'stopped') {
    items.push(run({ id: 'run:stuck', title: stuckTitle(stuck.since, now), why: cut(stuck.reason, 300), group: 'now', at: stuck.since }));
  }
  if (isText(nextWait?.id) && loop?.state !== 'stopped') {
    items.push(run({ id: 'run:next', title: `${nextWait.id} cannot start next`, why: nextWaitWhy(nextWait), group: 'now', at: nextWait.since }));
  }
  if (isText(anchorWait?.why) && isText(anchorWait?.to) && loop?.state !== 'stopped') {
    items.push(run({ id: 'run:anchor', title: 'The run is not taking new code', why: anchorWaitWhy(anchorWait), group: 'now', at: anchorWait.since }));
  }
  if (loop?.state !== 'stopped') {
    for (const f of Array.isArray(answerFailures) ? answerFailures : []) {
      if (!isText(f?.id) || !isText(f?.title) || !isText(f?.step)) continue;
      const later = Date.parse(f.retryAt) > now;
      items.push(
        run({
          id: `run:answer:${f.id}`,
          title: `Could not apply your answer to "${cut(f.title, 120)}"`,
          why: `could not apply: ${f.step}. ${later ? retrySentence(f.retryAt, now) : 'Foreman tries again at its next check.'}`,
          group: 'now',
          at: f.at,
          actions: [{ id: 'retry', label: 'Retry' }],
        }),
      );
    }
  }
  if (loop?.state !== 'stopped') {
    for (const entry of Array.isArray(slow) ? slow : []) {
      if (!isText(entry?.id) || !isText(entry?.slot)) continue;
      items.push(run({ id: `run:slow:${entry.slot}`, title: `${entry.id} is slow`, why: slowText(entry, now), group: 'fyi', at: entry.since }));
    }
  }
  const until = Date.parse(apiWait?.until);
  if (loop?.state !== 'stopped' && until > now) {
    const why = `The Claude API is limited or down (wait ${apiWait.step}); ${retrySentence(apiWait.until, now)}`;
    items.push(run({ id: 'run:api-wait', title: 'Stuck waiting for the Claude API', why, group: 'fyi', at: apiWait.since }));
  }
  const envEnd = Date.parse(envWait?.until);
  if (loop?.state !== 'stopped' && envEnd > now) {
    const why = `Three endings in a row were the environment, not the stories (wait ${envWait.step}); ${retrySentence(envWait.until, now)}`;
    items.push(run({ id: 'run:env-wait', title: 'Waiting out environment failures', why, group: 'fyi', at: envWait.since }));
  }
  if (loop?.state !== 'stopped' && Number.isInteger(learningFailed?.count) && learningFailed.count >= 2 && isText(learningFailed.why)) {
    items.push(run({ id: 'run:learning', title: `The learning tick failed ${learningFailed.count} times in a row`, why: cut(learningFailed.why, 300), group: 'fyi', at: learningFailed.since }));
  }
  if (isText(fileWait?.id) && loop?.state !== 'stopped') {
    const holders = unique((Array.isArray(fileWait.on) ? fileWait.on : []).map((e) => e?.story).filter(isText));
    const title = holders.length ? `${fileWait.id} waits for ${names(holders)}` : `${fileWait.id} waits on files`;
    items.push(run({ id: 'run:files', title, why: `The highest-priority story waiting on files: ${fileWait.text}`, group: 'fyi' }));
  }
  if (isText(restartPending?.to) && loop?.state !== 'stopped') {
    items.push(run({ id: 'run:restart', title: 'Restarting on new code', why: restartWhy(restartPending), group: 'fyi', at: restartPending.since }));
  }
  const strayCount = Number.isInteger(strays?.count) ? strays.count : 0;
  if (strayCount > 0 && loop?.state !== 'stopped') {
    items.push(
      run({
        id: 'run:strays',
        title: `${strayCount} stray process${strayCount === 1 ? '' : 'es'} running`,
        why: "Not this run's: supervisors, hook runs or `foreman learn` and `notify` runs left by tests or manual checks, in temp folders or this project's folders (a run kept in a temp folder counts too). They hold memory and slow the run.",
        group: 'fyi',
        actions: [{ id: 'end', label: 'End them' }],
      }),
    );
  }
  if (loop?.state === 'stopped' && loop.reason === NOTHING_LEFT) {
    const n = stories.filter((s) => OPEN.includes(s.status) && !s.ownerTask).length;
    if (n > 0) {
      items.push(run({ id: 'run:nothing-left', title: 'The run stopped', why: `Nothing left to build: ${n} ${n === 1 ? 'story waits' : 'stories wait'} on your tasks.`, group: 'fyi' }));
    }
  }
  const down = loop?.state === 'paused' && typeof loop.reason === 'string' ? loop.reason.match(JIRA_DOWN) : null;
  if (down) {
    const stamp = new Date(loop.since);
    const base = Number.isNaN(stamp.getTime()) ? new Date(now) : stamp;
    // Local time on purpose: the refresher wrote HH:MM on this machine's clock.
    const since = new Date(base);
    since.setHours(Number(down[1]), Number(down[2]), 0, 0);
    if (since > base) since.setDate(since.getDate() - 1);
    const at = since.toISOString();
    if (now - since < JIRA_LATE_MS) {
      const hhmm = `${pad(since.getHours())}:${pad(since.getMinutes())}`;
      items.push(run({ id: 'run:jira', title: 'Picking paused', why: `Picking paused since ${hhmm}: Jira not reachable. Often the computer slept or the network dropped; it retries every minute. Stories in progress carry on.`, group: 'fyi', at }));
    } else {
      items.push(run({ id: 'run:jira', title: 'Jira still not reachable', why: 'Still not reachable after 30 minutes: check the network or `foreman jira status`', group: 'now', at }));
    }
  }
  if (claudeSignIn?.using === 'subscription') {
    const back =
      claudeSignIn.limit === 'usage'
        ? "When access returns or you raise the key's limit, run `foreman claude use-key` to go back to the key."
        : 'After topping up, run `foreman claude use-key` to go back to the key.';
    const why = `${creditsOutFyi(claudeSignIn)} ${back}`;
    items.push(run({ id: 'run:subscription', title: 'Using your subscription', why, group: 'fyi', at: claudeSignIn.since }));
  }
  return items;
}

export function buildWaiting({ decisions, stories = [], idPattern, slots = [], halt = null, parks = [], root, loop = null, autoPause = null, configProblem = null, stuck = null, slow = [], restartPending = null, claudeSignIn = null, strays = null, nextWait = null, apiWait = null, fileWait = null, learningFailed = null, answerFailures = [], anchorWait = null, envWait = null, now = new Date() } = {}) {
  stories = Array.isArray(stories) ? stories : [];
  const tasks = stories.filter((s) => s.ownerTask && OPEN.includes(s.status));
  const fileItems = decisions?.source === 'files' ? decisions.items ?? [] : [];
  const busySlots = slots.filter((s) => s.state === 'parked' || s.state === 'down');
  const ids = unique([
    ...tasks.map((s) => s.id),
    ...fileItems.map((d) => d.story).filter(isText),
    ...parks.map((p) => p.id),
    ...busySlots.map((s) => s.story?.id).filter(isText),
  ]);
  const lookups = idPattern && stories.length;
  const deps = lookups ? dependentsOf(stories, ids, { idPattern }) : new Map();
  const free = lookups ? freedBy(stories, ids, { idPattern }) : new Map();
  const waiters = lookups ? waitersOf(stories, ids, { idPattern }) : new Map();
  const dependents = (id) => deps.get(id) ?? [];
  const byId = new Map(stories.map((s) => [s.id, s]));
  const isOpen = (task) => (id) => (byId.has(id) ? OPEN.includes(byId.get(id).status) : Object.hasOwn(task.externalDeps ?? {}, id));
  const met = (story) => (id) => (byId.has(id) ? byId.get(id).status === 'done' : !Object.hasOwn(story.externalDeps ?? {}, id));
  // The stories that can move only once task `taskId` is done, the task included. A story is held
  // when it is open, leads back to the task through open stories, and every open blocker it has
  // (not itself) is held too. So a loop through the task is held, but a loop that never reaches
  // the task, or a story with an open blocker that can move without the task, is not.
  const heldBy = (taskId) => {
    const openDeps = (st) => unique(st.dependsOn ?? []).filter((id) => id !== st.id).filter(isOpen(st));
    const open = stories.filter((st) => st.id !== taskId && OPEN.includes(st.status));
    const held = new Set([taskId]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const st of open) if (!held.has(st.id) && openDeps(st).some((id) => held.has(id))) { held.add(st.id); grew = true; }
    }
    for (let shrank = true; shrank; ) {
      shrank = false;
      for (const st of open) if (held.has(st.id) && !openDeps(st).every((id) => held.has(id))) { held.delete(st.id); shrank = true; }
    }
    return held;
  };
  // A decision's own story is freed by answering it when nothing else holds it.
  const freesItself = (id) => {
    const story = byId.get(id);
    return Boolean(story && OPEN.includes(story.status) && !story.ownerTask && (story.dependsOn ?? []).every(met(story)));
  };
  const shipped = (id) => ['done', 'retired'].includes(byId.get(id)?.status);

  const items = [];
  if (halt) {
    items.push({
      id: 'halt',
      kind: 'halt',
      title: 'The run is halted',
      why: `${halt.reason}${halt.fixProblem ? ` Last check: ${halt.fixProblem}` : ''}`,
      blocks: [...(halt.held ?? [])],
      frees: [...(halt.held ?? [])],
      actions: [{ id: 'fixed', label: 'I fixed it' }],
      at: halt.at ?? null,
    });
  }

  if (autoPause) {
    const reason = String(autoPause.reason ?? '').trim().slice(0, 300) || 'Foreman paused itself.';
    const retryAt = isText(autoPause.retryAt) && !Number.isNaN(Date.parse(autoPause.retryAt)) ? autoPause.retryAt : null;
    items.push({
      id: 'run:paused',
      kind: 'run',
      title: 'Foreman paused itself',
      why: retryAt ? `${reason} ${retrySentence(retryAt, now)}` : reason,
      ...(retryAt ? { retryAt } : {}),
      blocks: [],
      frees: [],
      actions: [{ id: 'resume', label: 'Resume' }],
      at: autoPause.at ?? null,
    });
  }

  // Dependency notes, created follow-ups and learned changes: FYI, out of the sort, oldest first
  // as fileItems are.
  const notes = [];
  for (const d of fileItems) {
    const options = Array.isArray(d.options) ? d.options : [];
    if (isFyiNote(d)) {
      const details = isText(d.body) ? { details: d.body.trim() } : {};
      if (kindOf(d) === 'waits' || kindOf(d) === 'created') {
        notes.push({ id: d.id, kind: 'decision', title: cut(d.title, 120), why: decisionWhy(d), ...details, blocks: [], frees: [], actions: optionActions(d, options), group: 'fyi' });
      } else {
        const learned = learnedNote(d);
        notes.push({ id: d.id, kind: 'learned', learned, title: cut(d.title, 120), why: decisionWhy(d), ...details, blocks: [], frees: [], actions: learnedActions(d, learned), group: 'fyi' });
      }
      continue;
    }
    const explain = explainOf(d);
    items.push({
      id: d.id,
      kind: 'decision',
      title: cut(d.title, 120),
      why: decisionWhy(d),
      blocks: unique([...(shipped(d.story) ? [] : [d.story]), ...dependents(d.story)].filter(isText)),
      frees: isText(d.story) && freesItself(d.story) ? [d.story] : [],
      ...(isText(d.body) ? { details: d.body.trim() } : {}),
      ...(explain ? { explain } : {}),
      actions: options.length ? optionActions(d, options) : [{ id: 'answer', label: 'Send answer' }],
      ...bundleKeys(d),
      at: d.createdAt ?? null,
      urgent: d.urgent === true,
    });
  }
  if (decisions?.source === 'copy') {
    for (const d of decisions.items ?? []) {
      items.push({ id: d.id, kind: 'decision', title: cut(d.title ?? d.id, 120), why: 'Answer it on your decisions page.', blocks: [], frees: [], actions: [], at: null });
    }
  }

  for (const s of tasks) {
    const blocks = dependents(s.id);
    const frees = free.get(s.id) ?? [];
    const why = () => {
      if (s.status === 'blocked' && isText(s.blockedBy)) return s.blockedBy;
      if (frees.length) return `Frees ${names(frees)} now. ${blocks.length} ${blocks.length === 1 ? 'story waits' : 'stories wait'} on it.`;
      if (blocks.length) {
        const w = waiters.get(s.id)?.[0];
        if (!w) return `${blocks.length} ${blocks.length === 1 ? 'story waits' : 'stories wait'} on it.`;
        return w.on.length ? `Frees nothing by itself: ${w.id} also waits on ${names(w.on)}.` : `Frees nothing by itself: ${w.id} is also blocked.`;
      }
      return 'An open owner task.';
    };
    const link = linkOf(s.ref, root);
    const held = heldBy(s.id);
    const waitsOn = unique(s.dependsOn ?? []).filter((id) => id !== s.id).filter(isOpen(s)).filter((id) => !held.has(id));
    const when = waitsOn.length ? { group: 'later', waitsOn, why: canStartAfter(waitsOn) } : { group: 'now', why: why() };
    items.push({ id: `task:${s.id}`, kind: 'owner-task', title: s.title, why: when.why, blocks, frees, ...(link ? { link } : {}), actions: [{ id: 'done', label: 'Mark done' }], group: when.group, ...(when.waitsOn ? { waitsOn } : {}), at: null });
  }

  for (const p of parks) {
    // The outcome only: a check's detail can carry what its tool printed (a URL with a password,
    // say), and the snapshot never shows it.
    const check = p.lastCheck?.outcome ? ` Last check: ${p.lastCheck.outcome}.` : '';
    items.push({
      id: `release:${p.id}`,
      kind: 'release',
      title: `${p.id}${p.title ? ` ${p.title}` : ''} is ready to promote`,
      why: `${p.reason}${check}`,
      blocks: dependents(p.id),
      frees: free.get(p.id) ?? [],
      ...(isText(p.pr) ? { link: p.pr } : {}),
      actions: [{ id: 'check', label: 'Check now' }],
      at: p.parkedAt ?? null,
    });
  }

  for (const s of busySlots) {
    const story = s.story?.id;
    items.push({
      id: `slot:${s.id}`,
      kind: 'slot',
      title: `Slot ${s.id} is ${s.state}`,
      why: isText(s.reason) ? s.reason : s.state === 'down' ? 'The slot is down.' : 'The slot is parked.',
      blocks: isText(story) ? unique([story, ...dependents(story)]) : [],
      frees: isText(story) ? [story] : [],
      actions: actionsFor(s).map((a) => ({ id: a, label: SLOT_LABELS[a] ?? a })),
      at: s.since ?? null,
    });
  }

  // FYI items stay out of the sort, in the order they were made.
  const run = runItems(loop, stories, now, configProblem, stuck, slow, restartPending, claudeSignIn, strays, nextWait, apiWait, fileWait, learningFailed, answerFailures, anchorWait, envWait);
  const fyiItems = [...run.filter((i) => i.group === 'fyi'), ...notes];
  items.push(...run.filter((i) => i.group !== 'fyi'));

  const when = (item) => (item.at ? String(item.at) : null);
  items.sort(
    (a, b) =>
      (b.kind === 'halt') - (a.kind === 'halt') ||
      (b.id === 'run:paused') - (a.id === 'run:paused') ||
      (b.id === 'run:stuck') - (a.id === 'run:stuck') ||
      (b.urgent === true) - (a.urgent === true) ||
      (b.kind === 'slot') - (a.kind === 'slot') ||
      b.frees.length - a.frees.length ||
      b.blocks.length - a.blocks.length ||
      (when(a) === null) - (when(b) === null) ||
      String(when(b) ?? '').localeCompare(String(when(a) ?? '')) ||
      String(a.id).localeCompare(String(b.id)),
  );
  const nowItems = items.filter((i) => i.group !== 'later').map((i) => ({ ...i, group: 'now' }));
  const laterItems = items.filter((i) => i.group === 'later').sort((a, b) => a.waitsOn.length - b.waitsOn.length);
  return [...nowItems, ...laterItems, ...fyiItems].map(({ at, urgent, ...item }) => item);
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// The one item to do first (see the header): the halt, else the self-pause, else the run being
// stuck, else the first down slot in the list, else the first now item.
function bestOf(items, now, slots) {
  const ids = new Set(items.map((i) => i?.id));
  const halt = items.find((i) => i?.kind === 'halt');
  if (halt) return halt.id;
  if (ids.has('run:paused')) return 'run:paused';
  if (ids.has('run:stuck')) return 'run:stuck';
  const down = slots.find((s) => s?.state === 'down' && ids.has(`slot:${s.id}`));
  if (down) return `slot:${down.id}`;
  return now[0]?.id ?? null;
}

// What the best item does for the stories: "it frees A now and N stories in all", "N stories
// wait on it", or '' when it touches none.
function effectOf(item) {
  const frees = Array.isArray(item?.frees) ? item.frees : [];
  const blocks = Array.isArray(item?.blocks) ? item.blocks : [];
  if (frees.length) return `it frees ${names(frees)} now and ${plural(blocks.length, 'story', 'stories')} in all`;
  if (blocks.length) return blocks.length === 1 ? '1 story waits on it' : `${blocks.length} stories wait on it`;
  return '';
}

export function strandedStories({ stories = [], claimed = [], slots = [], skipped = [] } = {}) {
  const held = new Set([...claimed, ...skipped]);
  for (const slot of Array.isArray(slots) ? slots : []) {
    for (const id of slotHolds(slot)) held.add(id);
  }
  return stories
    .filter((s) => s?.status === 'in-progress' && !s.ownerTask && !held.has(s.id))
    .map((s) => s.id)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export function headline({ items = [], loop = null, slots = [], stranded = [], clock = new Date() } = {}) {
  items = Array.isArray(items) ? items.filter(Boolean) : [];
  slots = Array.isArray(slots) ? slots : [];
  stranded = Array.isArray(stranded) ? stranded.filter(isText) : [];
  const left = stranded.length === 0 ? '' : stranded.length === 1 ? ` ${names(stranded)} is In Progress with nothing running it.` : ` ${names(stranded)} are In Progress with nothing running them.`;
  const now = items.filter((i) => i.group !== 'later' && i.group !== 'fyi');
  const laterItems = items.filter((i) => i.group === 'later');
  const count = waitingCount(items);
  const best = bestOf(items, now, slots);
  const bestItem = items.find((i) => i.id === best) ?? null;

  if (items.some((i) => i.kind === 'halt') || loop?.state === 'halted') {
    return { state: 'halted', text: 'Halted: a release failed. Nothing ships until you fix it.', best };
  }

  if (loop?.state === 'paused') {
    const reason = typeof loop.reason === 'string' ? loop.reason.trim() : '';
    const down = reason.match(JIRA_DOWN);
    const retryAt = items.find((i) => i.id === 'run:paused')?.retryAt ?? null;
    let text;
    if (down) text = `Paused: Jira not reachable since ${down[1]}:${down[2]}. New stories start when it answers; stories in progress carry on.`;
    else if (!reason || reason.toLowerCase() === 'paused from the command centre') text = 'Paused from the Command centre. Nothing new starts until you resume.';
    else if (retryAt) text = `Paused: ${reason.replace(/\.+$/, '')}. Foreman tries again at ${retryWhen(retryAt, clock)} by itself; Resume starts it sooner.`;
    else text = `Paused: ${reason.replace(/\.+$/, '')}. Nothing new starts until you resume.`;
    return { state: 'paused', text, best };
  }

  const stuck = items.find((i) => i.id === 'run:stuck');
  if (loop?.state === 'running' && stuck) {
    return { state: 'running', text: `Running, but stuck: ${String(stuck.why ?? '').replace(/\.+$/, '')}.`, best };
  }

  const open = [...now, ...laterItems];
  const blocking = open.filter((i) => Array.isArray(i.blocks) && i.blocks.length);
  const waits = new Set(blocking.flatMap((i) => i.blocks)).size;
  const who = blocking.every((i) => i.kind === 'owner-task') ? 'your tasks' : 'you';

  if (loop?.state === 'standby') {
    // A failed story (a decision "<ID> could not pass review" or "... be released" whose story is
    // open) that holds up other stories is named first: nothing else on standby says why the run idles.
    const failed = now.filter((i) => i.kind === 'decision' && failedStoryOf(i.title) && Array.isArray(i.blocks) && i.blocks.includes(failedStoryOf(i.title)));
    const failedIds = [...new Set(failed.map((i) => failedStoryOf(i.title)))];
    const held = new Set(failed.flatMap((i) => i.blocks).filter((id) => !failedIds.includes(id)));
    if (held.size > 0) {
      return { state: 'standby', text: `Standby: nothing to build. ${names(failedIds)} failed and ${failedIds.length === 1 ? 'holds' : 'hold'} up ${plural(held.size, 'story', 'stories')}. Picks up new stories automatically.${left}`, best };
    }
    // Follow-up proposals waiting on the owner are named first; the rest is said from the other
    // items alone, since a proposal's story may be missing from the list (Jira drops done issues)
    // and would then count as a story waiting.
    const follow = now.filter((i) => i.bundle === 'follow-ups').length;
    if (follow > 0) {
      const others = blocking.filter((i) => i.bundle !== 'follow-ups');
      const otherWaits = new Set(others.flatMap((i) => i.blocks)).size;
      const otherWho = others.every((i) => i.kind === 'owner-task') ? 'your tasks' : 'you';
      let extra = '';
      if (otherWaits > 1) extra = ` ${otherWaits} stories wait on ${otherWho}.`;
      else if (otherWaits === 1) extra = ` 1 story waits on ${otherWho}.`;
      else if (count - 1 >= 1) extra = count - 1 === 1 ? ' 1 other thing needs you.' : ` ${count - 1} other things need you.`;
      return { state: 'standby', text: `Standby: ${follow} follow-up proposal${follow === 1 ? ' waits' : 's wait'} on you.${extra} Picks up new stories automatically.${left}`, best };
    }
    let why;
    if (waits > 1) why = `${waits} stories wait on ${who}`;
    else if (waits === 1) why = `1 story waits on ${who}`;
    else if (count >= 1) why = count === 1 ? '1 thing needs you' : `${count} things need you`;
    else if (laterItems.length) why = `${laterItems.length === 1 ? '1 task opens up' : `${laterItems.length} tasks open up`} as stories ship`;
    else why = 'Nothing waits on you';
    return { state: 'standby', text: `Standby: nothing to build. ${why}. Picks up new stories automatically.${left}`, best };
  }

  const building = slots.filter((s) => (s?.state === 'building' || s?.state === 'waiting') && isText(s.story?.id)).map((s) => s.story.id);
  if (loop?.state === 'running' && building.length) {
    const need = count === 0 ? 'Nothing needs you.' : count === 1 ? '1 thing needs you; it is not stopping the run.' : `${count} things need you; none is stopping the run.`;
    return { state: 'running', text: `Building ${names(building)}. ${need}${left}`, best };
  }

  let text;
  if (bestItem) {
    const effect = effectOf(bestItem);
    const first = `Do ${bestItem.title} first${effect ? `: ${effect}` : ''}.`;
    if (waits > 1) text = `Idle: the ${waits} stories left all wait on ${who}. ${first}`;
    else if (waits === 1) text = `Idle: the 1 story left waits on ${who}. ${first}`;
    else text = `Idle: ${count === 1 ? '1 thing needs you' : `${count} things need you`}. Do ${bestItem.title} first.`;
  } else if (laterItems.length) {
    text = `Idle: nothing you can do yet. ${laterItems.length === 1 ? '1 task opens up' : `${laterItems.length} tasks open up`} as stories ship.`;
  } else {
    text = 'Idle: nothing left to build and nothing waits on you.';
  }
  return { state: 'idle', text: `${text}${left}`, best };
}
