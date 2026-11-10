// `foreman learn`: findings that keep stopping stories become proposed traits, and the minor
// findings a story shipped with become a proposed follow-up story.
//
//   learn [--dry-run] [--min-stories N]   ask the owner about each new repeated rule, and about
//                                         each shipped story's new minor findings
//   learn apply <decision id>             add the proposed trait, after "Add as a trait", or
//                                         create the follow-up story, after "Create a follow-up story"
//   learn ignore <decision id>            never propose it again, after "Ignore"
//   learn reopen <decision id>            take an ignored proposal back, so `learn` asks again
//   learn undo <decision id>              close the follow-up stories Foreman created itself, after
//                                         "Undo and close them" (only those still todo that no
//                                         live claim holds; the rest are left and said)
//
// It reads <stateDir>/findings.jsonl (written by `foreman story end`) and keeps a ledger in
// <stateDir>/learn.json: { proposed: {key: decisionId}, ignored: [keys], applied: [keys],
// details: {decisionId: detail}, unannounced?: [created] }. A trait's detail is {key, builder,
// rule, trait}; a follow-up's is {kind: 'followup', story, keys, findings, created?}, its keys
// `followup:<story>:<normalised rule>`, one per finding. A key is proposed at most once.
//
// With features.autoCreateFollowUps on, `learn` creates each follow-up story at once (priority
// Low, where the source has priorities) instead of asking, and marks its keys applied. Each
// story made is a `created` entry { id, story, findings: <n>, keys }, put in `unannounced` and
// saved at once, so a learn stopped part way never makes the same story twice. Every learn that
// is not a dry run, whatever the switch, then tells the owner about every unannounced story in
// one FYI ("Foreman created <n> follow-up stories", Undo and close them | Keep them) whose detail
// is {kind: 'followup-created', stories: [created], closed?: [ids]}, and empties unannounced; when
// it cannot, they stay for the next learn. A create that fails asks the owner as before. The
// ledger file carries `unannounced` only while it holds something.
// The grouping lives in engine/learn.mjs; the question goes through the project's console,
// like `foreman decide add`, with a one-line summary (engine/learn.mjs traitSummary and
// followUpSummary), which --dry-run prints under each "Would ask:" line; the story is made
// by the story source's optional create().
//
// While `learning.auto` is on (the default), Foreman writes learned traits itself (`foreman
// learning tick`), so `learn` proposes no traits, only follow-ups. A key it ignored or applied
// still keeps the learning tick off that lesson (engine/lessons.mjs skip).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { OPTIONS as ANSWER_OPTIONS } from '../../engine/answers.mjs';
import { openConsole } from '../../engine/console.mjs';
import { createdSummary, createdTitle, followUpDoneWhen, followUps, followUpSummary, followUpTitle, followUpWhat, parseFindings, proposals, traitExplain, traitHints, traitSummary } from '../../engine/learn.mjs';
import { claims } from '../../engine/locks.mjs';
import { refuseInRun } from '../../engine/run-guard.mjs';
import { doneChange, openStorySource } from '../../engine/story-source.mjs';
import { noteOnStory } from '../../engine/story-notes.mjs';
import { resolveTraits, roleNames, TRAITS_DIR } from '../../engine/traits.mjs';
import { openProject } from './console-shared.mjs';
import traitsCommand from './traits.mjs';

const EXIT_USAGE = 64;
const USAGE = `usage: foreman learn [--dry-run] [--min-stories N]
       foreman learn apply <decision id>
       foreman learn ignore <decision id>
       foreman learn reopen <decision id>
       foreman learn undo <decision id>
`;
const OPTIONS = { 'dry-run': { type: 'boolean' }, 'min-stories': { type: 'string' } };

const ledgerFile = (dir) => join(dir, 'learn.json');

export function readLedger(dir) {
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(ledgerFile(dir), 'utf8')) ?? {};
  } catch {
    // none yet
  }
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const arr = (v) => (Array.isArray(v) ? v : []);
  return { proposed: obj(raw.proposed), ignored: arr(raw.ignored), applied: arr(raw.applied), details: obj(raw.details), unannounced: arr(raw.unannounced) };
}

// An empty unannounced is left out, so a ledger the switch never touched stays as it was.
function saveLedger(dir, ledger) {
  mkdirSync(dir, { recursive: true });
  const file = ledgerFile(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  const { unannounced = [], ...rest } = ledger;
  writeFileSync(tmp, `${JSON.stringify(unannounced.length ? { ...rest, unannounced } : rest, null, 2)}\n`);
  renameSync(tmp, file);
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

// Each role's traits as its agents see them, plus all.md on its own.
function currentTraits(root, config) {
  const { traits } = resolveTraits({ root, config });
  return { ...traits, all: readText(join(root, TRAITS_DIR, 'all.md')) };
}

function bodyOf(p) {
  const examples = p.examples.map((e) => `- ${e.story}${e.where ? ` (${e.where})` : ''}${e.fix ? `: ${e.fix}` : ''}`);
  return [
    `The same finding stopped ${p.stories.length} stories for ${p.builder === 'all' ? 'the builders' : p.builder}: ${p.stories.join(', ')}.`,
    '',
    'Examples:',
    ...examples,
    '',
    `Proposed trait for ${p.builder === 'all' ? 'all.md (every agent)' : p.builder}:`,
    p.trait,
  ].join('\n');
}

const titleOf = (p) => `Add a trait for ${p.builder}: ${p.rule}?`;

const CREATE = 'Create a follow-up story';
// The answers each proposal offers (the dashboard's help texts are keyed by them).
export const TRAIT_OPTIONS = Object.freeze(['Add as a trait', 'Ignore']);
export const FOLLOW_UP_OPTIONS = Object.freeze([CREATE, 'Ignore']);
const followUpStoryTitle = (story) => `Follow-ups from ${story}`;
// The detail kind of the note about follow-ups Foreman created itself, and its Undo.
const CREATED_KIND = 'followup-created';
const [UNDO_CREATED] = ANSWER_OPTIONS.created;
const CREATED_HINTS = ['Closes the new stories not started yet; nothing is built for them.', 'Keeps the stories and clears this note.'];
const UNDONE_NOTE = 'Closed: the owner undid this follow-up, which Foreman created by itself (Undo on Waiting on you).';

// The follow-up story for proposal p, made by the story source; `extra` adds to what create()
// gets (the priority, when Foreman creates it by itself).
// A follow-up that was made is also written on the story it follows up (engine/story-notes.mjs),
// when features.jiraComments is on (or salesforceComments, for a Case). A failure there never fails
// the learner.
function tellFollowUp({ root, config, env, clock }, origin, made, title) {
  try {
    noteOnStory({ root, config, env, now: clock }, origin, 'follow-up', { id: made.id, title });
  } catch {
    // a note on the story is never worth failing the learner
  }
}

function makeFollowUpStory(source, p, config, extra = {}) {
  return source.create({ title: followUpStoryTitle(p.story), what: followUpWhat(p), doneWhen: followUpDoneWhen(config.checks), dependsOn: [], origin: p.story, ...extra });
}

function followUpBody(p) {
  return [
    `${p.story} shipped with ${p.findings.length} minor finding(s) still open:`,
    '',
    followUpWhat(p),
    '',
    `"${CREATE}" adds a story, "${followUpStoryTitle(p.story)}", to fix them.`,
  ].join('\n');
}

// The shipped stories' new minor findings, checked against the existing stories' titles. Only
// a source that can create stories gets proposals; a problem opening it is said and skipped.
// None at all while features.followUps is off; and unless features.followUpsOfFollowUps is on,
// a story that is itself a follow-up gets none. "Itself a follow-up" comes from the story's
// recorded origin: its followUpOf in the list, or else the source's followUpOf(id) lookup of
// that one id, since a filter may leave shipped stories out of the list. A lookup that throws
// counts as no origin. `config` has the local layer on top.
function followUpProposals({ root, config, env, now, stdout, stderr }, lines, seen) {
  if (!followUps(lines, { seen }).length) return [];
  if (config.features?.followUps === false) {
    stdout.write('Follow-up proposals are off (features.followUps).\n');
    return [];
  }
  const deeper = config.features?.followUpsOfFollowUps === true;
  let source;
  let stories;
  try {
    source = openStorySource({ root, config, now, env });
    stories = source.list();
  } catch (err) {
    stderr.write(`follow-ups not proposed: cannot read the stories (${err.message})\n`);
    return [];
  }
  if (typeof source.create !== 'function') {
    stderr.write('follow-ups not proposed: this story source cannot create stories\n');
    return [];
  }
  const found = followUps(lines, { seen, titles: stories.map((s) => s.title) });
  if (deeper) return found;
  const listed = new Map(stories.map((s) => [s.id, s.followUpOf ?? '']));
  const safeLookup = (id) => {
    try {
      return String(source.followUpOf(id) ?? '');
    } catch {
      return '';
    }
  };
  const originOf = (id) => listed.get(id) || (typeof source.followUpOf === 'function' ? safeLookup(id) : '');
  const followUpIds = new Set(found.map((p) => p.story).filter((id) => originOf(id) !== ''));
  for (const p of found) {
    if (followUpIds.has(p.story)) stdout.write(`${p.story} is itself a follow-up; not proposing follow-ups from it (features.followUpsOfFollowUps is off)\n`);
  }
  return found.filter((p) => !followUpIds.has(p.story));
}

async function propose({ root, dir, config, decisions, values, env, clock, stdout, stderr }) {
  let minStories = 3;
  if (values['min-stories'] !== undefined) {
    minStories = Number(values['min-stories']);
    if (!Number.isInteger(minStories) || minStories < 1) {
      stderr.write(`--min-stories must be a whole number of at least 1\n${USAGE}`);
      return EXIT_USAGE;
    }
  }
  const lines = parseFindings(readText(join(dir, 'findings.jsonl')));
  const ledger = readLedger(dir);
  const seen = [...Object.keys(ledger.proposed), ...ledger.ignored, ...ledger.applied];
  const autoLearns = config.learning?.auto !== false;
  const traitsOn = config.features?.learnTraits !== false && !autoLearns;
  const found = traitsOn ? proposals(lines, { ignored: seen, existingTraits: currentTraits(root, config), minStories }) : [];
  if (!traitsOn && proposals(lines, { ignored: seen, minStories }).length) {
    stdout.write(autoLearns ? 'Trait proposals are off while Foreman learns traits itself (learning.auto).\n' : 'Trait proposals are off (features.learnTraits).\n');
  }
  const follow = followUpProposals({ root, config, env, now: clock, stdout, stderr }, lines, seen);
  const autoCreate = config.features?.autoCreateFollowUps === true;

  if (values['dry-run']) {
    for (const p of found) stdout.write(`Would ask: ${titleOf(p)}\n  summary: ${traitSummary(p)}\n  stories: ${p.stories.join(', ')}\n  trait: ${p.trait}\n`);
    for (const p of follow) {
      const head = autoCreate ? `Would create: ${followUpStoryTitle(p.story)}` : `Would ask: ${followUpTitle(p)}`;
      stdout.write(`${head}\n  summary: ${followUpSummary(p)}\n${followUpWhat(p).replace(/^/gm, '  ')}\n`);
    }
    stdout.write(`${found.length + follow.length} proposal(s); nothing written (dry run).\n`);
    return 0;
  }

  let made = 0;
  for (const p of found) {
    try {
      const id = await decisions.add({
        story: p.stories.at(-1),
        kind: 'decision',
        title: titleOf(p),
        summary: traitSummary(p),
        body: bodyOf(p),
        options: TRAIT_OPTIONS,
        urgent: false,
        hints: traitHints(p),
        recommend: TRAIT_OPTIONS[0],
        explain: traitExplain(p),
      });
      ledger.proposed[p.key] = id;
      ledger.details[id] = { key: p.key, builder: p.builder, rule: p.rule, trait: p.trait };
      saveLedger(dir, ledger);
      stdout.write(`${id}  ${titleOf(p)}\n`);
      made += 1;
    } catch (err) {
      stderr.write(`could not ask about ${p.key}: ${err.message}\n`);
    }
  }
  stdout.write(`Proposed ${made} trait(s) from repeated findings.\n`);

  // With autoCreateFollowUps on, each follow-up is created at once; one whose create fails is
  // asked about as before, so no proposal is lost.
  let created = 0;
  let source = null;
  let openError = null;
  if (autoCreate && follow.length) {
    try {
      source = openStorySource({ root, config, now: clock, env });
    } catch (err) {
      openError = err;
    }
  }
  let asked = 0;
  for (const p of follow) {
    if (autoCreate) {
      let made = null;
      try {
        if (openError) throw openError;
        made = await makeFollowUpStory(source, p, config, { priority: 'Low' });
      } catch (err) {
        stderr.write(`could not create the follow-up from ${p.story} (${err.message}); asking you instead\n`);
      }
      if (made) {
        for (const key of p.keys) if (!ledger.applied.includes(key)) ledger.applied.push(key);
        ledger.unannounced.push({ id: made.id, story: p.story, findings: p.findings.length, keys: p.keys });
        // Saved at once: a learn stopped part way never makes the same story twice.
        saveLedger(dir, ledger);
        tellFollowUp({ root, config, env, clock }, p.story, made, followUpStoryTitle(p.story));
        stdout.write(`Created ${made.id}: ${followUpStoryTitle(p.story)}\n`);
        created += 1;
        continue;
      }
    }
    try {
      const id = await decisions.add({
        story: p.story,
        kind: 'decision',
        title: followUpTitle(p),
        summary: followUpSummary(p),
        body: followUpBody(p),
        options: FOLLOW_UP_OPTIONS,
        urgent: false,
      });
      for (const key of p.keys) ledger.proposed[key] = id;
      ledger.details[id] = { kind: 'followup', story: p.story, keys: p.keys, findings: p.findings };
      saveLedger(dir, ledger);
      stdout.write(`${id}  ${followUpTitle(p)}\n`);
      asked += 1;
    } catch (err) {
      stderr.write(`could not ask about the follow-ups from ${p.story}: ${err.message}\n`);
    }
  }
  await announce({ dir, decisions, ledger, stdout, stderr });
  if (autoCreate) stdout.write(`Created ${created} follow-up story(s) from minor findings.\n`);
  stdout.write(`Proposed ${asked} follow-up(s) from minor findings.\n`);
  return 0;
}

// Tells the owner, in one FYI with an Undo, about every follow-up story Foreman created that it
// has not told them about yet, this run's and any a stopped run left. When the console refuses,
// they stay unannounced for the next learn.
async function announce({ dir, decisions, ledger, stdout, stderr }) {
  const list = ledger.unannounced;
  if (!list.length) return;
  const title = createdTitle(list.length);
  let id;
  try {
    id = await decisions.add({
      story: list.at(-1).story,
      kind: 'decision',
      title,
      summary: createdSummary(list),
      body: [
        ...list.map((c) => `- ${c.id}: ${followUpStoryTitle(c.story)} (${c.findings} minor finding(s))`),
        '',
        `The run picks them up like any other story. "${UNDO_CREATED}" closes the ones not started yet; a story already started is left as it is.`,
      ].join('\n'),
      options: ANSWER_OPTIONS.created,
      hints: CREATED_HINTS,
      urgent: false,
    });
  } catch (err) {
    stderr.write(`created ${list.map((c) => c.id).join(', ')}, but the owner was not told: ${err.message}\n`);
    return;
  }
  ledger.details[id] = { kind: CREATED_KIND, stories: list };
  ledger.unannounced = [];
  saveLedger(dir, ledger);
  stdout.write(`${id}  ${title}\n`);
}

// Whether the owner's recorded answer is `choice`: true, false, or null when this console
// keeps no local copy of the item (then the caller is trusted).
async function answered(decisions, id, choice) {
  let item;
  try {
    item = (await decisions.list()).find((d) => d.id === id);
  } catch {
    return null;
  }
  if (!item) return null;
  const a = item.answer;
  if (!a) return false;
  if (a.option === choice) return true;
  // An item with no options is answered in words.
  return !item.options?.length && String(a.note ?? '').trim().toLowerCase() === choice.toLowerCase();
}

// "Create a follow-up story": the story source makes it, once; its findings are then applied.
async function createFollowUp(detail, ledger, { root, dir, config, env, clock, stdout }) {
  const title = followUpStoryTitle(detail.story);
  if (detail.created) {
    stdout.write(`Already created ${detail.created}: ${title}\n`);
    return 0;
  }
  const source = openStorySource({ root, config, now: clock, env });
  if (typeof source.create !== 'function') throw new Error('this story source cannot create stories');
  const made = await makeFollowUpStory(source, detail, config);
  detail.created = made.id;
  for (const key of detail.keys ?? []) if (!ledger.applied.includes(key)) ledger.applied.push(key);
  ledger.ignored = ledger.ignored.filter((k) => !(detail.keys ?? []).includes(k));
  saveLedger(dir, ledger);
  tellFollowUp({ root, config, env, clock }, detail.story, made, title);
  stdout.write(`Created ${made.id}: ${title}${made.path ? ` (${made.path})` : ''}\n`);
  return 0;
}

async function settle(sub, id, { root, dir, config, decisions, cwd, env, stdout, stderr, now, clock }) {
  const ledger = readLedger(dir);
  const detail = ledger.details[id];
  if (!detail || detail.kind === CREATED_KIND) {
    stderr.write(`${id} is not a trait or follow-up proposal.\n`);
    return 1;
  }
  const followUp = detail.kind === 'followup';
  const choice = sub === 'apply' ? (followUp ? CREATE : 'Add as a trait') : 'Ignore';
  const ok = await answered(decisions, id, choice);
  if (ok === false) {
    stderr.write(`${id}: the owner did not choose ${choice}.\n`);
    return 1;
  }
  if (ok === null) stderr.write(`note: could not check the answer to ${id} here; going by the command.\n`);
  if (followUp && sub === 'apply') {
    const code = await createFollowUp(detail, ledger, { root, dir, config, env, clock, stdout });
    if (code !== 0) return code;
  } else if (followUp) {
    const keys = (detail.keys ?? []).filter((k) => !ledger.ignored.includes(k) && !ledger.applied.includes(k));
    if (keys.length) {
      ledger.ignored.push(...keys);
      saveLedger(dir, ledger);
    }
    stdout.write(`Ignored the follow-ups from ${detail.story}\n`);
  } else if (sub === 'apply') {
    // A builder since removed from the config gets the trait in all.md, so the question closes.
    const role = detail.builder === 'all' || roleNames(config).includes(detail.builder) ? detail.builder : 'all';
    if (role !== detail.builder) stdout.write(`${detail.builder} is no longer in the config; adding the trait to all.md instead.\n`);
    if (!ledger.applied.includes(detail.key)) {
      const code = await traitsCommand.run(['add', role, detail.trait], { root, cwd, env, stdout, stderr, now });
      if (code !== 0) return code;
      ledger.applied.push(detail.key);
      ledger.ignored = ledger.ignored.filter((k) => k !== detail.key);
      saveLedger(dir, ledger);
    }
    stdout.write(`Added to ${role === 'all' ? 'all.md' : `${role}'s traits`}: ${detail.trait}\n`);
  } else {
    if (!ledger.ignored.includes(detail.key) && !ledger.applied.includes(detail.key)) {
      ledger.ignored.push(detail.key);
      saveLedger(dir, ledger);
    }
    stdout.write(`Ignored: ${detail.rule}\n`);
  }
  try {
    await decisions.applied(id);
  } catch (err) {
    stderr.write(`warning: ${err.message}\n`);
  }
  return 0;
}

// "Undo and close them" on the note about follow-ups Foreman created: closes each of them that is
// still todo and that no live claim holds (the supervisor applies this on every tick, even while
// sessions build), and leaves the rest. Their findings stay applied, so they are never proposed
// again. An update that fails stops it before the note is marked applied, so it runs again. The
// ledger is read again before each save, so a `learn` running meanwhile loses nothing.
async function undo(id, { root, dir, config, decisions, env, clock, stdout, stderr }) {
  const ledger = readLedger(dir);
  const detail = ledger.details[id];
  if (detail?.kind !== CREATED_KIND) {
    stderr.write(`${id} is not a note about follow-ups Foreman created.\n`);
    return 1;
  }
  const ok = await answered(decisions, id, UNDO_CREATED);
  if (ok === false) {
    stderr.write(`${id}: the owner did not choose ${UNDO_CREATED}.\n`);
    return 1;
  }
  if (ok === null) stderr.write(`note: could not check the answer to ${id} here; going by the command.\n`);
  const source = openStorySource({ root, config, now: clock, env });
  const stories = new Map((await source.list()).map((s) => [s.id, s]));
  const held = new Set(claims(dir).filter((c) => !c.stale).map((c) => c.id));
  const closed = [];
  const record = () => recordClosed(dir, id, detail, closed);
  for (const { id: storyId } of Array.isArray(detail.stories) ? detail.stories : []) {
    const story = stories.get(storyId);
    const left = !story ? 'not found' : story.status !== 'todo' ? story.status : held.has(storyId) ? 'claimed' : null;
    if (left) {
      stdout.write(`Left ${storyId}: ${left}.\n`);
      continue;
    }
    try {
      await source.update(storyId, doneChange(UNDONE_NOTE, clock()));
    } catch (err) {
      record();
      stderr.write(`could not close ${storyId}: ${err.message}\n`);
      return 1;
    }
    closed.push(storyId);
  }
  record();
  stdout.write(`Closed ${closed.length ? joinIds(closed) : 'none'}.\n`);
  try {
    await decisions.applied(id);
  } catch (err) {
    stderr.write(`warning: ${err.message}\n`);
  }
  return 0;
}

// Puts this undo's closed ids on the note's detail in the ledger as it is now, read again just
// before the save: a learn that saved meanwhile (a story it created, its applied keys, its note)
// is kept, and only `closed` comes from here.
function recordClosed(dir, id, detail, closed) {
  const fresh = readLedger(dir);
  const into = fresh.details[id] ?? detail;
  into.closed = [...new Set([...(Array.isArray(into.closed) ? into.closed : []), ...closed])];
  fresh.details[id] = into;
  saveLedger(dir, fresh);
}

// "A", "A and B", "A, B and C".
const joinIds = (ids) => (ids.length > 1 ? `${ids.slice(0, -1).join(', ')} and ${ids.at(-1)}` : ids.join(''));

// Takes an ignored proposal back: its ignored keys and their proposed entries go, so the next
// `learn` asks again as a new decision. The details stay as history.
function reopen(id, { dir, stdout, stderr }) {
  const ledger = readLedger(dir);
  const detail = ledger.details[id];
  if (!detail || detail.kind === CREATED_KIND) {
    stderr.write(`${id} is not a trait or follow-up proposal.\n`);
    return 1;
  }
  const followUp = detail.kind === 'followup';
  const keys = followUp ? (detail.keys ?? []) : [detail.key];
  const title = followUp ? followUpTitle({ story: detail.story, findings: detail.findings ?? [] }) : titleOf(detail);
  if (keys.length && keys.every((k) => ledger.applied.includes(k))) {
    stderr.write(`${id} was already applied; it cannot be reopened.\n`);
    return 1;
  }
  const ignored = keys.filter((k) => ledger.ignored.includes(k) && !ledger.applied.includes(k));
  if (!ignored.length) {
    stdout.write(`${id} is still waiting for an answer; nothing to reopen\n`);
    return 0;
  }
  ledger.ignored = ledger.ignored.filter((k) => !ignored.includes(k));
  for (const k of ignored) delete ledger.proposed[k];
  saveLedger(dir, ledger);
  stdout.write(`Reopened ${title}; run \`foreman learn\` to ask again.\n`);
  return 0;
}

export default {
  name: 'learn',
  summary: 'propose traits from repeated findings and follow-up stories from minor ones (learn [--dry-run]|apply|ignore|reopen|undo)',

  async run(args, { root, cwd, env, stdout, stderr, now }) {
    let parsed;
    try {
      parsed = parseArgs({ args, options: OPTIONS, allowPositionals: true, strict: true });
    } catch (err) {
      stderr.write(`${err.message}\n${USAGE}`);
      return EXIT_USAGE;
    }
    const { values, positionals } = parsed;
    const [sub, id, ...extra] = positionals;
    if (sub !== undefined && !(['apply', 'ignore', 'reopen', 'undo'].includes(sub) && id && extra.length === 0)) {
      stderr.write(USAGE);
      return EXIT_USAGE;
    }
    // A story session never closes stories, on any project (the run guard also lists it).
    const refused = sub === 'undo' ? refuseInRun(env, 'foreman learn undo') : null;
    if (refused) {
      stderr.write(`${refused}\n`);
      return 1;
    }
    const project = openProject({ root, env, stderr });
    if (!project) return 1;
    const clock = now ?? (() => new Date());
    const ctx = { root, dir: project.dir, config: project.config, cwd, env, stdout, stderr, now, clock, values };
    try {
      // Opened only when something will be written, so a dry run touches nothing.
      ctx.decisions = (values['dry-run'] && !sub) || sub === 'reopen' ? null : openConsole({ config: project.config, ctx: { stateDir: project.dir, now: clock } }).decisions;
      if (!sub) return await propose(ctx);
      if (sub === 'reopen') return reopen(id, ctx);
      if (sub === 'undo') return await undo(id, ctx);
      return await settle(sub, id, ctx);
    } catch (err) {
      stderr.write(`${err.message}\n`);
      return 1;
    }
  },
};
