// What waits on the owner: one file per item in <stateDir>/decisions/<id>.json. The story skill
// adds items (`foreman decide add`), the owner answers them (`foreman decide answer`, later the
// dashboard), and the skill applies each answer and marks it applied. Everyone goes through
// this module, so there is one format.
//
//   { id, story, kind: "decision"|"task", title, options: [..], urgent, body, createdAt,
//     answer: null | { option, note, at }, appliedAt: null | iso,
//     summary?, hints?: [..] (one per option), recommend?: <an option>,
//     explain?: { purpose, happened, damage?, recommendation } }
//
// summary is one line of at most 160 characters, each hint at most 100, and recommend one of the
// options. Each is stored only when given, so an item without them reads exactly as before.
//
// explain says the decision in plain words for an owner who has not read the code: what the
// story is for, what happened, whether anything outside the story is damaged (only when
// something was touched), and the recommendation and why. Each part is one line of at most 280
// characters; on a decision with options it needs a hint per option, the "Your options" part.
// It goes last, after the other extras. explainProblems is the writing check: a file path, a
// variable name, a function call or an over-long part, which `decide add` warns about.
//
// Each add and each answer also queues a note for the story itself (engine/story-notes-queue.mjs),
// which whoever flushes next posts as a comment when features.jiraComments is on (or
// salesforceComments, for a Case). The queue never fails an add or an answer.
//
// A task always has two options, Retry the story and Close the task, and takes one of them (the
// generic options branch of answer()); only the first puts the story back in line. add() refuses
// a task given options or hints of its own. A decision with options takes one of them; a decision
// with no options, or an old task stored with none, takes free text, kept as the answer's note.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { answerNote, decisionNote, queueStoryNote } from '../engine/story-notes-queue.mjs';
import { listNames, readText } from '../engine/read-cache.mjs';

export const KINDS = ['decision', 'task'];
export const RETRY_STORY = 'Retry the story';
export const CLOSE_TASK = 'Close the task';
export const TASK_OPTIONS = [RETRY_STORY, CLOSE_TASK];
export const TASK_HINTS = ['Puts the story back in line with your note, so it is built again.', 'Marks this task done and leaves the story as it is, even when it is blocked.'];
const ID = /^d-\d{14}-[0-9a-f]{4}$/;

export const decisionsDir = (dir) => join(dir, 'decisions');
const fileOf = (dir, id) => join(decisionsDir(dir), `${id}.json`);

const isText = (v) => typeof v === 'string' && v.trim() !== '';

function save(dir, item) {
  mkdirSync(decisionsDir(dir), { recursive: true });
  const file = fileOf(dir, item.id);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(item, null, 2)}\n`);
  renameSync(tmp, file);
  return item;
}

function read(dir, id) {
  if (!ID.test(String(id))) throw new Error(`There is no decision ${id}.`);
  try {
    return JSON.parse(readFileSync(fileOf(dir, id), 'utf8'));
  } catch {
    throw new Error(`There is no decision ${id}.`);
  }
}

// d-<yyyymmddhhmmss in UTC>-<4 random hex>
function newId(dir, now) {
  const stamp = now.toISOString().replace(/\D/g, '').slice(0, 14);
  for (;;) {
    const id = `d-${stamp}-${randomBytes(2).toString('hex')}`;
    if (!existsSync(fileOf(dir, id))) return id;
  }
}

const given = (v) => v !== undefined && v !== null;

// Queues the story note for a decision or an answer; never throws.
function tell(dir, note, now) {
  try {
    queueStoryNote(dir, { ...note, at: now, slot: process.env.FOREMAN_SLOT || null });
  } catch {
    // a note is never worth failing an add or an answer
  }
}

export const EXPLAIN_PARTS = ['purpose', 'happened', 'damage', 'recommendation'];
export const EXPLAIN_LABELS = { purpose: 'What this story is for', happened: 'What happened', damage: 'Is anything damaged?', recommendation: 'Recommendation' };
const EXPLAIN_NEEDS = ['purpose', 'happened', 'recommendation'];
const EXPLAIN_MAX = 280;

// "What happened: It broke." or, for a question label, "Is anything damaged? No."
export function explainLine(part, text) {
  const label = EXPLAIN_LABELS[part] ?? part;
  return label.endsWith('?') ? `${label} ${text}` : `${label}: ${text}`;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const quoted = (list) => list.map((p) => `"${p}"`).join(list.length > 2 ? ', ' : ' and ').replace(/, ("[^"]+")$/, ' and $1');

// The explanation, checked and trimmed, its parts in EXPLAIN_PARTS order.
function checkExplain(explain, options, hints) {
  if (!isPlainObject(explain)) throw new Error('The explanation must be an object of its parts: purpose, happened, damage and recommendation.');
  const unknown = Object.keys(explain).filter((k) => !EXPLAIN_PARTS.includes(k));
  if (unknown.length) throw new Error(`The explanation has no part ${quoted(unknown)}; its parts are purpose, happened, damage and recommendation.`);
  const missing = EXPLAIN_NEEDS.filter((p) => !isText(explain[p]));
  if (missing.length) throw new Error(`The explanation is missing ${quoted(missing)}.`);
  if (given(explain.damage) && !isText(explain.damage)) throw new Error('The explain part "damage" must be some text, or left out.');
  const out = {};
  for (const part of EXPLAIN_PARTS) {
    if (!given(explain[part])) continue;
    const line = explain[part].trim();
    if (/[\r\n]/.test(line)) throw new Error(`The explain part "${part}" must be one line.`);
    if (line.length > EXPLAIN_MAX) throw new Error(`The explain part "${part}" is ${line.length} characters; keep each part to ${EXPLAIN_MAX} or fewer.`);
    out[part] = line;
  }
  if (options.length && !hints.length) throw new Error('With an explanation, give one hint per option.');
  return out;
}

// The writing check, pure: [{ part, kind, found, message }] for each file path, variable name or
// function call in a part, and each part over 280 characters. Plain words give [], and so do
// well-known product names such as Node.js and .NET: they are not file paths.
const CODE_EXT = 'mjs|cjs|jsx|js|tsx|ts|json|md|html|css|py|sh|yml|yaml|toml|cls|xml|sql|env';
const CODE_FILE = new RegExp(`^[\\w.-]*\\w\\.(?:${CODE_EXT})$`);
// Well-known product names that look like a file name or a dotfile, and are plain words to an owner.
const PRODUCT_NAMES = new Set(['node.js', 'vue.js', 'next.js', 'nuxt.js', 'nest.js', 'express.js', 'react.js', 'ember.js', 'three.js', 'd3.js', 'chart.js', '.net']);
const WHAT = { path: 'a file path', variable: 'a variable name', call: 'a function call' };

function isPath(token) {
  if (PRODUCT_NAMES.has(token.toLowerCase())) return false;
  if (/^(?:\/|\.\.?\/|~\/)[^/\s]/.test(token)) return true;
  if (/^\.[A-Za-z][\w.-]*$/.test(token)) return true;
  if (CODE_FILE.test(token)) return true;
  if (!token.includes('/') || !/[A-Za-z]/.test(token)) return false;
  const segments = token.split('/');
  if (segments.some((s) => !s)) return false;
  return segments.length >= 3 || /\.[A-Za-z0-9]+$/.test(segments.at(-1));
}

function found(text) {
  const hits = [];
  for (const raw of text.split(/[\s"'`()<>,;]+/)) {
    const token = raw.replace(/[.:!?]+$/, '');
    if (token && isPath(token)) hits.push(['path', token]);
  }
  for (const m of text.matchAll(/(?<![\w$])(?:[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|\$[A-Za-z_]\w*)(?![\w])/g)) hits.push(['variable', m[0]]);
  for (const m of text.matchAll(/(?<![\w$.])[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\((?!e?s\))[^()\n]{0,40}\)?/g)) hits.push(['call', m[0]]);
  return hits;
}

export function explainProblems(explain) {
  if (!explain || typeof explain !== 'object') return [];
  const out = [];
  for (const part of EXPLAIN_PARTS) {
    if (!isText(explain[part])) continue;
    const text = explain[part].trim();
    const label = EXPLAIN_LABELS[part];
    const name = label.endsWith('?') ? `The answer to "${label}"` : label;
    const seen = new Set();
    for (const [kind, hit] of found(text)) {
      if (seen.has(`${kind}:${hit}`)) continue;
      seen.add(`${kind}:${hit}`);
      out.push({ part, kind, found: hit, message: `${name} has ${WHAT[kind]} ("${hit}"); say it in plain words and keep the detail in the body.` });
    }
    if (text.length > EXPLAIN_MAX) out.push({ part, kind: 'long', found: `${text.slice(0, 40)}…`, message: `${name} is ${text.length} characters; keep each part to ${EXPLAIN_MAX} or fewer.` });
  }
  return out;
}

// The summary, hints, recommend and explain, checked and trimmed: only the ones given.
function extras(options, { summary, hints, recommend, explain }) {
  const out = {};
  if (given(summary)) {
    if (!isText(summary) || /[\r\n]/.test(summary.trim())) throw new Error('The summary must be one line of text.');
    const line = summary.trim();
    if (line.length > 160) throw new Error(`The summary is ${line.length} characters; keep it to 160 or fewer.`);
    out.summary = line;
  }
  if (!Array.isArray(hints) || !hints.every(isText)) throw new Error('Each hint must be some text.');
  if (hints.length && hints.length !== options.length) {
    throw new Error(`Give one hint per option, or none: ${options.length} ${options.length === 1 ? 'option' : 'options'} and ${hints.length} ${hints.length === 1 ? 'hint' : 'hints'}.`);
  }
  const trimmed = hints.map((h) => h.trim());
  trimmed.forEach((h, i) => {
    if (h.length > 100) throw new Error(`Hint ${i + 1} is ${h.length} characters; keep each hint to 100 or fewer.`);
  });
  if (trimmed.length) out.hints = trimmed;
  if (given(recommend)) {
    if (!options.length) throw new Error('There are no options to recommend.');
    const pick = isText(recommend) ? recommend.trim() : '';
    if (!options.includes(pick)) throw new Error(`"${pick || recommend}" is not one of the options; recommend one of ${options.map((o) => `"${o}"`).join(', ')}.`);
    out.recommend = pick;
  }
  if (given(explain)) out.explain = checkExplain(explain, options, trimmed);
  return out;
}

export const TASK_REFUSAL = 'A task always offers "Retry the story" and "Close the task"; add it without options or hints.';

export function add(dir, { story, kind, title, options = [], urgent = false, body = '', summary, hints = [], recommend, explain } = {}, now = new Date()) {
  if (!isText(story)) throw new Error('A decision needs the story it is about.');
  if (!KINDS.includes(kind)) throw new Error(`The kind must be decision or task, not ${kind}.`);
  if (!isText(title)) throw new Error('A decision needs a title.');
  if (!Array.isArray(options) || !options.every(isText)) throw new Error('Each option must be some text.');
  if (kind === 'task') {
    if (options.length || hints?.length) throw new Error(TASK_REFUSAL);
    options = TASK_OPTIONS;
    hints = TASK_HINTS;
  }
  const more = extras(options.map((o) => o.trim()), { summary, hints, recommend, explain });
  const item = {
    id: newId(dir, now),
    story: story.trim(),
    kind,
    title: title.trim(),
    options: options.map((o) => o.trim()),
    urgent: urgent === true,
    body: typeof body === 'string' ? body : '',
    createdAt: now.toISOString(),
    answer: null,
    appliedAt: null,
    ...more,
  };
  save(dir, item);
  tell(dir, decisionNote(item), now);
  return item.id;
}

// Every item, oldest first. A file that cannot be read is left out. The folder and the files are
// read through the cache (engine/read-cache.mjs) and parsed on every call, so a caller never
// shares an item with another. read() above, which answer and applied use, is not cached.
export function list(dir) {
  const folder = decisionsDir(dir);
  return listNames(folder)
    .filter((f) => f.endsWith('.json') && ID.test(f.slice(0, -5)))
    .map((f) => {
      try {
        const text = readText(join(folder, f));
        return text === null ? null : JSON.parse(text);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .map((item) => ({ ...item, options: Array.isArray(item.options) ? item.options : [], answer: item.answer ?? null, appliedAt: item.appliedAt ?? null }))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id));
}

// Not yet applied, oldest first, each with its answer or null.
export const pending = (dir) => list(dir).filter((item) => !item.appliedAt);

// With applied: true the answer and appliedAt are saved in the one write, for an answer that was
// acted on already (the dashboard's Undo on a learned note, lib/console/learned.mjs): nothing
// sees it answered but not applied, so the supervisor never applies it a second time.
export function answer(dir, id, { option, note } = {}, now = new Date(), { applied = false } = {}) {
  const item = read(dir, id);
  if (item.appliedAt) throw new Error(`${id} was already applied.`);
  const options = Array.isArray(item.options) ? item.options : [];
  let given;
  if (options.length) {
    if (!options.includes(option)) throw new Error(`"${option}" is not one of the options for ${id}: ${options.map((o) => `"${o}"`).join(', ')}.`);
    given = { option, note: isText(note) ? note.trim() : '' };
  } else {
    const text = [option, note].filter(isText).map((t) => t.trim()).join('\n');
    if (!text) throw new Error(`${id} needs an answer in words.`);
    given = { option: null, note: text };
  }
  const saved = save(dir, { ...item, answer: { ...given, at: now.toISOString() }, ...(applied ? { appliedAt: now.toISOString() } : {}) });
  tell(dir, answerNote(saved), now);
  return given;
}

export function applied(dir, id, now = new Date()) {
  const item = read(dir, id);
  save(dir, { ...item, appliedAt: now.toISOString() });
}
