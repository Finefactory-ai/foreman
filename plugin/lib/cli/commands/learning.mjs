// `foreman learning`: what Foreman learned by itself (traits and learned skills), with its
// history, and the owner's undo. The store is engine/learning-store.mjs.
//
//   learning list         one line per item: id, kind, roles, version, status, path, reason
//   learning show <id>    the item's ledger lines, then the text in force
//   learning undo <id> [--told-at <time>]
//                         go back one version (the first version's undo removes the item)
//   learning keep <id> [--told-at <time>]
//                         keep the version in force. With --told-at (how answers.mjs applies an
//                         answer to a "learned" FYI, passing the note's createdAt), the note must be
//                         about an add or update by Foreman at that time: the tick gives the FYI the
//                         time of its ledger line, so a note added any other way (`foreman decide
//                         add`) is refused, "The note is not about <id>'s latest change by Foreman;
//                         nothing done", exit 1, as is a version that was undone and not replaced.
//                         It acts when the note's version is in force. A version Foreman replaced
//                         since, with a newer version in force, is done, exit 0: keep does nothing
//                         (the newer note covers it); undo writes nothing either and raises a
//                         "Foreman did not undo <id> for <roles>" note, once, with Got it. One
//                         replaced and then removed (no version in force) is done too, exit 0:
//                         "<id> v<n> is no longer in force: <id> was removed since; nothing to
//                         undo|keep.", nothing written and no note
//   learning scan [--dry-run]
//                         the lessons in the last 60 stories (engine/lessons.mjs), written to
//                         <stateDir>/lessons.json for the learner unless --dry-run; a derived
//                         local file, not kept on the branch store
//   learning run <key> [--dry-run]
//                         asks the learner session (engine/learner.mjs) about one lesson from
//                         scan, checks its proposal and prints it; records each call's cost in
//                         <stateDir>/learner.jsonl unless --dry-run. It never writes a learned
//                         item, and runs whatever learning.auto says (auto is for automatic runs)
//   learning tick         what the supervisor runs in the background after each run record, and
//                         `foreman cloud tick` at the end of a job. First it evaluates the items on
//                         trial (engine/learning-eval.mjs): one that made stories worse or that a
//                         finding named is rolled back, one with no effect is retired (a rollback line
//                         with metrics.decision 'retire'), both with an FYI, "Foreman rolled back|retired
//                         L-n for <roles>", whose Got it only clears it, and the item's open "learned"
//                         FYIs closed; one that worked is kept. Then it scans, and for each lesson not
//                         asked about before (with as many stories), and not one Foreman took out
//                         itself (rolledBackKeys), the learner, the check and the
//                         store. A trait or a learned skill is added (or merged into one in force,
//                         a new version on trial) by Foreman itself and the owner is told with an
//                         FYI, "Foreman learned|changed L-n for <roles>", created at the time of
//                         its ledger line, whose Undo the change and Keep the change answers.mjs
//                         applies. When the owner cannot be told, the tick says so on stderr and
//                         as a warn event, "<what it did>, but the owner was not told: <why>", and
//                         exits 1. learning.model decides, and
//                         learning.skillModel writes a skill. A lesson the check or a cap turns
//                         down is a refused ledger line. At learning.maxSkills a skill verdict
//                         waits: refused without asking learning.skillModel, and asked again once
//                         the lesson has another story. It stops at learning.maxEvaluating,
//                         learning.maxPerDay or learning.maxUsdPerDay. Refused in a story session
//                         (FOREMAN_RUN=1); with learning.auto off it writes nothing. One tick at a time:
//                         <stateDir>/learning-tick.lock (not learning.lock, which the store takes
//                         for each change; nor locks/, which the branch store keeps)
//                         Its children (the learner) get NODE_OPTIONS without the report flags the
//                         supervisor added (tick-log.mjs untickEnv), because a claude on an older Node
//                         would not start with them.
//                         A learned skill's add and update lines carry metrics.packs, the tag and
//                         commit of each skills-lock.json skill its text names
//                         (engine/learning-health.mjs packRefs), so `foreman doctor` can tell when
//                         one moved.
//
// With the branch state store, undo, keep, run and tick are each one commit (state-store/with-state.mjs).
//
// In a story session (FOREMAN_RUN=1) undo and keep refuse on the run's project before they run:
// main.mjs refuses every run-guard.mjs GUARDED command there. From a scratch repo they act on its
// own state, like every guarded command. Only tick refuses in every story session (refuseInRun).

import fs, { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULTS } from '../../config/defaults.mjs';
import { kindOf, learnedNote, OPTIONS } from '../../engine/answers.mjs';
import { openConsole } from '../../engine/console.mjs';
import { addItem, currentItems, itemText, keepItem, readLedger, refuseItem, undoItem, updateItem } from '../../engine/learning-store.mjs';
import { evaluate, rolledBackKeys } from '../../engine/learning-eval.mjs';
import { packRefs } from '../../engine/learning-health.mjs';
import { capProblem, checkContext, checkLesson, LEARNER_LOG, learnerInput, learnerSpentToday, recordLearnerCall, runLearner } from '../../engine/learner.mjs';
import { lessons, lessonWindow, sessionStory } from '../../engine/lessons.mjs';
import { breakIfStale, release, take } from '../../engine/locks.mjs';
import { readFindingsLines, readRuns } from '../../engine/run-record.mjs';
import { refuseInRun } from '../../engine/run-guard.mjs';
import { untickEnv } from '../../engine/tick-log.mjs';
import { addEvent } from '../../engine/state.mjs';
import { fileSecrets } from '../../setup/project.mjs';
import { defaultSh } from '../../state-store/branch.mjs';
import { readLock } from '../../../packs/salesforce/skills.mjs';
import { openProject } from './console-shared.mjs';
import { readLedger as readLearnLedger } from './learn.mjs';

const EXIT_USAGE = 64;
const USAGE = `usage: foreman learning list
       foreman learning show <id>
       foreman learning undo <id> [--told-at <time>]
       foreman learning keep <id> [--told-at <time>]
       foreman learning scan [--dry-run]
       foreman learning run <key> [--dry-run]
       foreman learning tick
`;
const ID = /^L-\d+$/;
const KEY = /^[a-z]-[0-9a-f]{12}$/;

const items = (dir) => [...currentItems(readLedger(dir)).values()].sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)));

function list({ dir, stdout }) {
  const all = items(dir);
  if (!all.length) {
    stdout.write('Foreman has not learned anything yet.\n');
    return 0;
  }
  for (const i of all) stdout.write(`${[i.id, i.kind, i.roles.join(','), `v${i.v}`, i.status, i.path, String(i.reason ?? '').slice(0, 80)].join('  ')}\n`);
  return 0;
}

function show({ dir, stdout, stderr }, id) {
  const item = currentItems(readLedger(dir)).get(id);
  if (!item) {
    stderr.write(`${id} is not a learned item\n`);
    return 1;
  }
  stdout.write(`${[item.id, item.kind, item.roles.join(','), `v${item.v}`, item.status, item.path].join('  ')}\n\n`);
  for (const l of item.lines) stdout.write(`${[l.at, l.action, `v${l.v}`, l.by, l.reason].join('  ')}\n`);
  const text = itemText(dir, item);
  stdout.write(text === null ? '\n(removed)\n' : `\n${text.endsWith('\n') ? text : `${text}\n`}`);
  return 0;
}

// With `toldAt`, what Foreman's own note at that time is about, or null (refused):
//   { about: {} }            no `toldAt`
//   { about: { v } }         the note's version is in force: act on it
//   { replaced: {...} }      Foreman replaced the note's version with a newer one since, and a version
//                            newer than the note's is still in force: the note is done without acting;
//                            `told` is the line it is about, `newest` the line of the version in force
//                            (not a newer one that was undone since)
//   { gone: {...} }          Foreman replaced the note's version since and then every version was
//                            undone or rolled back: no version is in force, so there is nothing to act on
// Null for any other time: no add or update by Foreman at it (a note added by hand with `foreman
// decide add`, an owner's change, an unknown item), or a version that was undone and not replaced.
function toldAbout(dir, id, toldAt) {
  if (toldAt === null) return { about: {} };
  const item = currentItems(readLedger(dir)).get(id);
  const made = item?.lines.filter((l) => l.action === 'add' || l.action === 'update') ?? [];
  const i = made.findLastIndex((l) => l.by === 'foreman' && l.at === toldAt);
  if (i === -1) return null;
  const told = made[i];
  if (item.v === told.v) return { about: { v: told.v } };
  if (i < made.length - 1 && item.v > told.v) return { replaced: { item, told, newest: made.find((l) => l.v === item.v) } };
  if (i < made.length - 1 && item.v === 0) return { gone: { item, told } };
  return null;
}

const notAbout = (stderr, id) => {
  stderr.write(`The note is not about ${id}'s latest change by Foreman; nothing done\n`);
  return 1;
};

const replacedWords = (id, { told, newest }) => `${id} v${told.v} was replaced by v${newest.v} since`;

// The note's version was replaced and the item removed since: the owner asked for it to be gone and
// it is, so this is done, nothing written and no note raised.
function goneDone({ dir, stdout, clock }, id, told, verb) {
  const said = `${id} v${told.v} is no longer in force: ${id} was removed since; nothing to ${verb}.`;
  stdout.write(`${said}\n`);
  try {
    addEvent(dir, said, 'info', clock());
  } catch {
    // the event log is a courtesy
  }
  return 0;
}

// An undo answered on a note whose version was replaced since never undoes the newer version: the
// owner is told, with a Got it, that nothing was undone and how to undo the newer one. The note is
// raised once: a retried answer finds it pending and reuses it.
async function replacedUndo({ dir, config, stdout, stderr, clock }, id, { item, told, newest }) {
  const now = clock();
  const who = (told.roles?.length ? told.roles : item.roles).join(', ');
  const title = `Foreman did not undo ${id} for ${who}`;
  const summary = summaryOf(`${id} v${told.v} was replaced by v${newest.v} before your Undo the change was applied; nothing was undone.`);
  const body = [
    `You answered Undo the change on the note about ${id} v${told.v}, but v${newest.v} had replaced it by then, so nothing was undone: Foreman never undoes a newer version for an answer about an older one.`,
    `To undo ${id} now, answer Undo the change on the note about v${newest.v}, or run \`foreman learning undo ${id}\`.`,
    `The history: \`foreman learning show ${id}\`.`,
  ].join('\n\n');
  const said = `${replacedWords(id, { told, newest })}; nothing undone`;
  let noteId;
  try {
    const desk = openConsole({ config, ctx: { stateDir: dir, now: clock } }).decisions;
    const pending = await desk.pending();
    const story =
      pending.find((d) => kindOf(d) === 'learned' && learnedNote(d)?.id === id && d.createdAt === told.at)?.story ?? told.source?.stories?.at(-1) ?? newest.source?.stories?.at(-1);
    if (!story) throw new Error('no story to attach the note to');
    noteId =
      pending.find((d) => d.title === title && d.body === body)?.id ??
      (await desk.add({ story, kind: 'decision', title, summary, body, options: OPTIONS.rolledBack, hints: ['Clears this note; nothing was undone.'], urgent: false }));
  } catch (err) {
    // A transient failure: the answer stays unapplied and is tried again.
    notTold({ dir, stderr }, said, err, now);
    return 1;
  }
  stdout.write(`${said}. Told the owner: ${noteId}.\n`);
  try {
    addEvent(dir, `${said}. Told the owner on Waiting on you.`, 'info', now);
  } catch {
    // the event log is a courtesy; the note is recorded
  }
  return 0;
}

async function undo(ctx, { id, toldAt }) {
  const { dir, stdout, stderr, clock } = ctx;
  const r = toldAbout(dir, id, toldAt);
  if (!r) return notAbout(stderr, id);
  if (r.gone) return goneDone(ctx, id, r.gone.told, 'undo');
  if (r.replaced) return replacedUndo(ctx, id, r.replaced);
  const done = undoItem(dir, id, { now: clock(), by: 'owner', ...r.about });
  if (!done.ok) {
    stderr.write(`${done.error}\n`);
    return 1;
  }
  stdout.write(done.line.v ? `Undid ${id}: back to v${done.line.v}.\n` : `Undid ${id}: removed.\n`);
  return 0;
}

function keep({ dir, stdout, stderr, clock }, { id, toldAt }) {
  const r = toldAbout(dir, id, toldAt);
  if (!r) return notAbout(stderr, id);
  if (r.gone) return goneDone({ dir, stdout, clock }, id, r.gone.told, 'keep');
  if (r.replaced) {
    const said = `${replacedWords(id, r.replaced)}; its own note covers it.`;
    stdout.write(`${said}\n`);
    try {
      addEvent(dir, said, 'info', clock());
    } catch {
      // the event log is a courtesy
    }
    return 0;
  }
  const kept = keepItem(dir, id, { now: clock(), by: 'owner', ...r.about });
  if (!kept.ok) {
    stderr.write(`${kept.error}\n`);
    return 1;
  }
  stdout.write(`Kept ${id} at v${kept.line.v}.\n`);
  return 0;
}

// The notes in the state overlays (<dir>/stories/*.json) as { story, date, text }; a bad file is skipped.
function overlayNotes(dir) {
  const folder = join(dir, 'stories');
  let names = [];
  try {
    names = readdirSync(folder).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const notes = [];
  for (const name of names) {
    let ov;
    try {
      ov = JSON.parse(readFileSync(join(folder, name), 'utf8'));
    } catch {
      continue;
    }
    if (!ov || typeof ov !== 'object' || !Array.isArray(ov.notes)) continue;
    const story = ov.id ?? basename(name, '.json');
    for (const n of ov.notes) if (n && typeof n === 'object') notes.push({ story, date: n.date, text: n.text });
  }
  return notes;
}

// The session logs of the stories in the window, as { name, text }.
function windowLogs(dir, runs, stories) {
  const folder = join(dir, 'logs');
  let names = [];
  try {
    names = readdirSync(folder);
  } catch {
    return [];
  }
  const inWindow = new Set(stories);
  return names.filter((name) => inWindow.has(sessionStory(name, runs))).map((name) => ({ name, text: readFileSync(join(folder, name), 'utf8') }));
}

const firstLine = (c) => {
  const e = c.evidence?.[0] ?? {};
  const text = c.cluster || e.rule || e.text || (e.rounds !== undefined ? `${c.stories[0]} failed after ${e.rounds} round(s)` : c.key);
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat;
};
const storiesWord = (k) => `${k} ${k === 1 ? 'story' : 'stories'}`;

// The lessons in the window, as engine/lessons.mjs gives them.
function scanResult({ dir, root, env, config }) {
  const findings = readFindingsLines(dir);
  const runs = readRuns(dir);
  const { ignored, applied } = readLearnLedger(dir);
  return lessons({
    findings,
    runs,
    notes: overlayNotes(dir),
    logs: windowLogs(dir, runs, lessonWindow({ findings, runs })),
    skip: [...ignored, ...applied],
    items: [...currentItems(readLedger(dir)).values()],
    env,
    redactValues: [...fileSecrets({ root, config }), ...(config.learning?.redact ?? [])].sort((a, b) => b.length - a.length),
  });
}

function scan(ctx, dryRun) {
  const { dir, stdout, clock } = ctx;
  const result = scanResult(ctx);
  const n = result.window.stories;
  const { candidates, covered } = result;
  if (!candidates.length && !covered.length) stdout.write(`No lessons in the last ${n} stories.\n`);
  else {
    stdout.write(`Lessons in the last ${n} stories (window ${result.window.size}):\n`);
    candidates.forEach((c, i) => {
      stdout.write(`${i + 1}. ${c.source} · ${c.role} · ${storiesWord(c.stories.length)} · ${firstLine(c)}\n`);
      stdout.write(`   key ${c.key}\n`);
      stdout.write(`   stories ${c.stories.join(', ')}\n`);
    });
    for (const c of covered) stdout.write(`Covered by ${c.id} (counts toward its evaluation): ${c.cluster || c.key} · ${storiesWord(c.stories.length)}\n`);
  }
  if (dryRun) {
    stdout.write(`${candidates.length} lesson(s); nothing written (dry run).\n`);
    return 0;
  }
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'lessons.json');
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ at: clock().toISOString(), window: result.window, candidates, covered }, null, 2)}\n`);
  renameSync(tmp, file);
  stdout.write(`${candidates.length} lesson(s); wrote lessons.json.\n`);
  return 0;
}

// Asks the learner about one lesson, as `learning run` and `learning tick` both do. Each call is
// recorded in learner.jsonl, failed ones too (they cost money), unless `record` is false.
function askLearner(ctx, lesson, { now, record, skills = true, newSkills = true }) {
  const { dir, root, env, config } = ctx;
  const run = ctx.sh ?? defaultSh;
  const values = fileSecrets({ root, config });
  const input = learnerInput(lesson, { root, stateDir: dir, config, env, values, run });
  const r = runLearner({ input, config, spentUsd: learnerSpentToday(dir, now), run, env, root, stateDir: dir, now, skills, newSkills, values });
  if (record) for (const c of r.calls) recordLearnerCall(dir, { at: now.toISOString(), key: lesson.key, stories: lesson.stories.length, ...c });
  return { r, input, values };
}

function runLesson(ctx, { key, dryRun }) {
  const { dir, root, env, config, stdout, stderr, clock } = ctx;
  const result = scanResult(ctx);
  const lesson = result.candidates.find((c) => c.key === key);
  if (!lesson) {
    const covered = result.covered.find((c) => c.key === key);
    stderr.write(covered ? `${key} is already covered by ${covered.id}.\n` : `No lesson ${key} in the last ${result.window.stories} stories; \`foreman learning scan\` lists them.\n`);
    return 1;
  }
  stdout.write(`Lesson ${key} (${lesson.source} · ${lesson.role} · ${storiesWord(lesson.stories.length)})\n`);
  const now = clock();
  const { r, values } = askLearner(ctx, lesson, { now, record: !dryRun });
  for (const c of r.calls) stdout.write(`Learner: ${c.model} $${c.costUsd.toFixed(4)}\n`);
  const spent = r.calls.reduce((sum, c) => sum + c.costUsd, 0);
  const finish = (code) => {
    if (dryRun) stdout.write('Nothing written (dry run).\n');
    else if (r.calls.length) stdout.write(`Recorded $${spent.toFixed(4)} of learning spend in learner.jsonl.\n`);
    return code;
  };
  if (!r.ok) {
    stderr.write(`${r.error}\n`);
    return finish(1);
  }
  const checked = checkLesson(r.reply, checkContext({ root, stateDir: dir, config, env, values, now }));
  if (!checked.ok) {
    stderr.write(`Refused: ${checked.reason}\n`);
    return finish(1);
  }
  stdout.write(`Checked lesson:\n${JSON.stringify({ key, source: lesson.source, stories: lesson.stories, ...checked.lesson }, null, 2)}\n`);
  return finish(0);
}

// ---- the tick ----

const TICK_LOCK = 'learning-tick.lock';
const BUDGET_SPENT = 'the learning budget for today is spent';
const LEARNED_HINTS = ["Takes Foreman's learned rule out again; later stories go without it.", 'Keeps the learned rule and clears this note.'];
const SKILL_HINTS = ["Takes Foreman's learned skill out again; later stories go without it.", 'Keeps the learned skill and clears this note.'];
const ROLLED_BACK_HINTS = ['Clears this note; Foreman already took the change out.'];

// One line, at most 160 characters, cut at a word with "…".
function summaryOf(text) {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length <= 160) return line;
  const space = line.lastIndexOf(' ', 158);
  return `${line.slice(0, space > 0 ? space : 159)}…`;
}

// key -> the most stories a lesson had when the learner answered it without an error.
function askedBefore(dir) {
  let text = '';
  try {
    text = readFileSync(join(dir, LEARNER_LOG), 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const asked = new Map();
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    let line;
    try {
      line = JSON.parse(raw);
    } catch {
      continue; // a torn line
    }
    if (!line || typeof line !== 'object' || typeof line.key !== 'string' || line.error !== null) continue;
    const n = Number.isInteger(line.stories) ? line.stories : 0;
    asked.set(line.key, Math.max(asked.get(line.key) ?? 0, n));
  }
  return asked;
}

// Why no lesson may be asked about now, or null: a cap, or the day's learning budget.
function heldBack(dir, learning, now) {
  const ledger = readLedger(dir);
  const capped = capProblem({ items: [...currentItems(ledger).values()], ledger, learning, now });
  if (capped) return capped;
  const spent = learnerSpentToday(dir, now);
  const cap = Number(learning.maxUsdPerDay) || 0;
  return spent >= cap ? `${BUDGET_SPENT} ($${spent.toFixed(2)} of $${cap.toFixed(2)})` : null;
}

// Whether a reply is about a skill: a skill verdict, or a merge into a learned skill in force.
const aboutSkill = (reply, input) => reply?.verdict === 'skill' || (reply?.verdict === 'merge' && (input.skillIds ?? []).includes(reply?.merge?.id));

// Tells the owner about a trait or skill Foreman wrote: an FYI with Undo the change and Keep the
// change, and an event. `text` is the trait, or the skill's { name, description }. The FYI's
// createdAt is `now`, the time of the ledger line, which `learning undo|keep --told-at` checks.
// Returns the decision's id; throws when the console cannot take it.
async function tellOwner(ctx, { id, kind, roles, text, reason, lesson, changed, now }) {
  const { dir, config } = ctx;
  const who = roles.join(', ');
  const title = `Foreman ${changed ? 'changed' : 'learned'} ${id} for ${who}`;
  const skill = kind === 'skill';
  const said = skill ? `${text.name}: ${text.description}` : text;
  const body = [
    `[${id}] ${said}`,
    `Why: ${reason}`,
    `From the stories: ${lesson.stories.join(', ')}.`,
    skill
      ? `Used from the next story: copied into each slot and listed for ${who}. Undo the change takes it out again (\`foreman learning undo ${id}\`): back one version, or removed when it was new. Keep the change keeps it and clears this note.`
      : `Used from the next story. Undo the change takes it out again (\`foreman learning undo ${id}\`): back one version, or removed when it was new. Keep the change keeps it and clears this note.`,
  ].join('\n\n');
  const itemId = await openConsole({ config, ctx: { stateDir: dir, now: () => now } }).decisions.add({
    story: lesson.stories.at(-1),
    kind: 'decision',
    title,
    summary: summaryOf(`${who}: ${skill ? text.description : text}`),
    body,
    options: OPTIONS.learned,
    hints: skill ? SKILL_HINTS : LEARNED_HINTS,
    urgent: false,
  });
  try {
    addEvent(dir, `${title}; Undo on Waiting on you.`, 'info', now);
  } catch {
    // the event log is a courtesy; the item and the note are recorded
  }
  return { title, itemId };
}

// Says on stderr, and as a warn event, that `said` was done but the owner was not told: `err`'s
// first line.
function notTold({ dir, stderr }, said, err, now) {
  const text = `${said}, but the owner was not told: ${String(err?.message ?? err).split('\n')[0]}`;
  stderr.write(`${text}\n`);
  try {
    addEvent(dir, text, 'warn', now);
  } catch {
    // the event log is a courtesy; stderr and the exit code say it too
  }
  return text;
}

// One lesson through the learner, the check and the store. Returns 'stop' to end the tick,
// 'failed' when the owner could not be told, else null.
async function tickLesson(ctx, lesson, learning) {
  const { dir, root, env, config, stdout, stderr, clock } = ctx;
  const { key } = lesson;
  const now = clock();
  const held = heldBack(dir, learning, now);
  if (held) {
    stdout.write(`Held back: ${held}.\n`);
    return 'stop';
  }
  // The skills in force: at learning.maxSkills a new skill waits, without the skill model.
  const live = [...currentItems(readLedger(dir)).values()].filter((i) => i.kind === 'skill' && i.v > 0);
  const max = Number(learning.maxSkills);
  const room = live.length < max;
  const { r, input, values } = askLearner(ctx, lesson, { now, record: true, skills: true, newSkills: room });
  if (!r.ok) {
    stderr.write(`${key}: ${r.error}\n`);
    return r.error.startsWith(BUDGET_SPENT) ? 'stop' : null;
  }
  const source = { key, stories: lesson.stories };
  const roles = lesson.role ? [lesson.role] : [];
  if (r.reply.verdict === 'skill' && !room) {
    const waits = `Foreman already has ${live.length} learned skills (the most is ${max})`;
    refuseItem(dir, { kind: 'skill', roles, source, reason: waits }, { now, by: 'foreman' });
    stdout.write(`Waiting ${key}: ${waits}.\n`);
    return null;
  }
  const checked = checkLesson(r.reply, checkContext({ root, stateDir: dir, config, env, values, now }));
  if (!checked.ok) {
    refuseItem(dir, { kind: aboutSkill(r.reply, input) ? 'skill' : 'trait', roles, source, reason: checked.reason }, { now, by: 'foreman' });
    stdout.write(`Refused ${key}: ${checked.reason}\n`);
    return null;
  }
  const { verdict, reason, trait, skill, merge } = checked.lesson;
  if (verdict === 'none') {
    stdout.write(`Nothing to learn from ${key}: ${reason}\n`);
    return null;
  }
  if (verdict === 'skill' || merge?.kind === 'skill') return tickSkill(ctx, { lesson, source, reason, skill: skill ?? merge.skill, id: merge?.id ?? null, now });
  const text = verdict === 'trait' ? trait.text : merge.text;
  const stored =
    verdict === 'trait'
      ? addItem(dir, { kind: 'trait', roles: [trait.role], text, source, reason }, { now, by: 'foreman' })
      : updateItem(dir, merge.id, { text, source, reason }, { now, by: 'foreman' });
  if (!stored.ok) {
    stdout.write(`Refused ${key}: ${stored.line.reason}\n`);
    return null;
  }
  const role = stored.line.roles[0];
  const said = { id: stored.id, kind: 'trait', roles: [role], text, reason, lesson, changed: verdict === 'merge', now };
  let told;
  try {
    told = await tellOwner(ctx, said);
  } catch (err) {
    notTold(ctx, `Foreman ${said.changed ? 'changed' : 'learned'} ${stored.id} for ${role}`, err, now);
    return 'failed';
  }
  stdout.write(`Learned ${stored.id} for ${role}: ${text}${/[.!?]$/.test(text) ? '' : '.'} Told the owner: ${told.itemId}.\n`);
  return null;
}

// A checked skill into the store: added, or (with `id`, a merge) a new version of a learned
// skill, which restarts its evaluation. `skill.text` is the SKILL.md checkLesson rendered.
async function tickSkill(ctx, { lesson, source, reason, skill, id, now }) {
  const { dir, root, stdout } = ctx;
  const { key } = lesson;
  const packs = packRefs(skill.text, readLock(root, fs).lock?.skills);
  const metrics = packs ? { packs } : null;
  const stored = id
    ? updateItem(dir, id, { text: skill.text, source, reason, metrics }, { now, by: 'foreman' })
    : addItem(dir, { kind: 'skill', roles: skill.roles, slug: skill.slug, text: skill.text, source, reason, metrics }, { now, by: 'foreman' });
  if (!stored.ok) {
    stdout.write(`Refused ${key}: ${stored.line.reason}\n`);
    return null;
  }
  const roles = stored.line.roles;
  const said = { id: stored.id, kind: 'skill', roles, text: { name: skill.name, description: skill.description }, reason, lesson, changed: Boolean(id), now };
  let told;
  try {
    told = await tellOwner(ctx, said);
  } catch (err) {
    notTold(ctx, `Foreman ${said.changed ? 'changed' : 'learned'} ${stored.id} for ${roles.join(', ')}`, err, now);
    return 'failed';
  }
  stdout.write(`Learned ${stored.id} for ${roles.join(', ')}: ${skill.name}. Told the owner: ${told.itemId}.\n`);
  return null;
}

// One set of evaluation numbers in words.
const inWords = ({ runs, rounds, serious, failRate }) =>
  `${runs} ${runs === 1 ? 'story' : 'stories'}, ${rounds === null ? '?' : rounds.toFixed(1)} rounds and ${serious === null ? '?' : serious.toFixed(1)} serious findings a story, ${failRate === null ? '?' : failRate}% failed`;

// Rolls back or retires one evaluated item, closes its "learned" FYIs and tells the owner.
// Returns 1 when the owner could not be told, else 0.
async function takeOut(ctx, r, item) {
  const { dir, config, stdout, stderr, clock } = ctx;
  const now = clock();
  const retire = r.decision === 'retire';
  const done = undoItem(dir, r.id, { now, by: 'foreman', action: 'rollback', reason: r.reason, metrics: r.metrics, v: r.v });
  if (!done.ok) {
    stderr.write(`${done.error}\n`);
    return 0;
  }
  const said = `${retire ? 'Retired' : 'Rolled back'} ${r.id}: ${r.reason}`;
  const who = r.roles.join(', ');
  const title = `Foreman ${retire ? 'retired' : 'rolled back'} ${r.id} for ${who}`;
  const windowStories = r.runs.map((k) => k.split('@')[0]);
  const story = windowStories.at(-1) ?? item?.source?.stories?.at(-1) ?? r.metrics.cited?.at(-1);
  const body = [
    r.reason,
    `Before it: ${inWords(r.metrics.baseline)}. With it: ${inWords(r.metrics.window)}.`,
    windowStories.length ? `Watched over: ${windowStories.join(', ')}.` : 'No story used it yet.',
    `${retire ? 'Foreman retired it for having no effect' : 'Foreman rolled it back'}: ${done.line.v ? `back to v${done.line.v}` : 'removed'}. Later stories go without it.`,
    `The history: \`foreman learning show ${r.id}\`.`,
  ].join('\n\n');
  try {
    const desk = openConsole({ config, ctx: { stateDir: dir, now: clock } }).decisions;
    // Its open "learned" notes would act on another version, or fail for good.
    for (const d of await desk.pending()) {
      if (kindOf(d) === 'learned' && String(d.title).split(' ')[2] === r.id) await desk.applied(d.id);
    }
    await desk.add({ story, kind: 'decision', title, summary: summaryOf(said), body, options: OPTIONS.rolledBack, hints: ROLLED_BACK_HINTS, urgent: false });
  } catch (err) {
    // The one warn event says both what was done and why the owner was not told.
    notTold(ctx, said, err, now);
    stdout.write(`${said}\n`);
    return 1;
  }
  try {
    addEvent(dir, said, 'warn', now);
  } catch {
    // the event log is a courtesy; the ledger has it
  }
  stdout.write(`${said}\n`);
  return 0;
}

// Evaluates the items on trial and applies each decision. Returns the exit code so far.
async function evaluateTrials(ctx, learning) {
  const { dir, stdout, stderr, clock } = ctx;
  const ledger = readLedger(dir);
  const results = evaluate({ ledger, runs: readRuns(dir), findings: readFindingsLines(dir), window: Number(learning.window), now: clock() });
  const items = currentItems(ledger);
  let code = 0;
  for (const r of results) {
    if (r.decision === 'keep') {
      const now = clock();
      const kept = keepItem(dir, r.id, { now, by: 'foreman', reason: r.reason, metrics: r.metrics, v: r.v });
      if (!kept.ok) {
        stderr.write(`${kept.error}\n`);
        continue;
      }
      const said = `Kept ${r.id}: ${r.reason}`;
      try {
        addEvent(dir, said, 'info', now);
      } catch {
        // the event log is a courtesy; the ledger has it
      }
      stdout.write(`${said}\n`);
    } else if (await takeOut(ctx, r, items.get(r.id))) code = 1;
  }
  return code;
}

async function tick(given) {
  const ctx = { ...given, env: untickEnv(given.env) };
  const { dir, config, stdout, stderr, env, clock } = ctx;
  const refused = refuseInRun(env, 'foreman learning tick');
  if (refused) {
    stderr.write(`${refused}\n`);
    return 1;
  }
  if (config.learning?.auto === false) {
    stdout.write('Automatic learning is off (learning.auto); nothing written.\n');
    return 0;
  }
  const lock = join(dir, TICK_LOCK);
  const me = { pid: process.pid, at: clock().toISOString() };
  if (!take(lock, me).ok && !(breakIfStale(lock) && take(lock, me).ok)) {
    stdout.write('A learning tick is already running.\n');
    return 0;
  }
  try {
    const learning = { ...DEFAULTS.learning, ...(config.learning ?? {}) };
    let code = await evaluateTrials(ctx, learning);
    const asked = askedBefore(dir);
    // A lesson Foreman took out itself is not learned again by the next tick.
    const taken = rolledBackKeys(readLedger(dir));
    const fresh = scanResult(ctx).candidates.filter((c) => !taken.has(c.key) && !(asked.has(c.key) && asked.get(c.key) >= c.stories.length));
    if (!fresh.length) {
      stdout.write('No new lessons.\n');
      return code;
    }
    for (const lesson of fresh) {
      const step = await tickLesson(ctx, lesson, learning);
      if (step === 'failed') code = 1;
      if (step === 'stop') break;
    }
    return code;
  } finally {
    release(lock, me.pid);
  }
}

// Each subcommand, and whether it takes an id. undo and keep, which also take --told-at, are in
// dispatch().
const SUBS = { list: [list, false], show: [show, true] };

// [handler, its argument], or null for a usage error.
function dispatch(args) {
  const [sub, ...rest] = args;
  if (sub === 'scan') {
    try {
      const { values } = parseArgs({ args: rest, options: { 'dry-run': { type: 'boolean' } }, strict: true, allowPositionals: false });
      return [scan, values['dry-run'] === true];
    } catch {
      return null;
    }
  }
  if (sub === 'tick') return rest.length ? null : [tick, null];
  if (sub === 'undo' || sub === 'keep') {
    try {
      const { values, positionals } = parseArgs({ args: rest, options: { 'told-at': { type: 'string' } }, strict: true, allowPositionals: true });
      if (positionals.length !== 1 || !ID.test(positionals[0])) return null;
      return [sub === 'undo' ? undo : keep, { id: positionals[0], toldAt: values['told-at'] ?? null }];
    } catch {
      return null;
    }
  }
  if (sub === 'run') {
    try {
      const { values, positionals } = parseArgs({ args: rest, options: { 'dry-run': { type: 'boolean' } }, strict: true, allowPositionals: true });
      if (positionals.length !== 1 || !KEY.test(positionals[0])) return null;
      return [runLesson, { key: positionals[0], dryRun: values['dry-run'] === true }];
    } catch {
      return null;
    }
  }
  const entry = Object.hasOwn(SUBS, sub) ? SUBS[sub] : null;
  if (!entry || (entry[1] && !ID.test(rest[0] ?? ''))) return null;
  return [entry[0], rest[0]];
}

export default {
  name: 'learning',
  summary: 'what Foreman learned, with its history (learning list|show|undo|keep|scan|run|tick)',

  async run(args, { root, env, stdout, stderr, now, sh }) {
    const picked = dispatch(args);
    if (!picked) {
      stderr.write(USAGE);
      return EXIT_USAGE;
    }
    const [handler, arg] = picked;
    const project = openProject({ root, env, stderr });
    if (!project) return 1;
    const ctx = { dir: project.dir, root, env, config: project.config, stdout, stderr, sh, clock: now ?? (() => new Date()) };
    try {
      return await handler(ctx, arg);
    } catch (err) {
      // One plain line: no stack trace, and store messages never hold file contents.
      stderr.write(`${String(err?.message ?? err).split('\n')[0]}\n`);
      return 1;
    }
  },
};
