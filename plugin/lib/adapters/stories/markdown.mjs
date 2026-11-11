// Story source: one markdown file per story in a folder, with the story's facts in the
// frontmatter (`id:`, `title:`, `status:` and so on). This is how the Obsidian vault works
// today and how a plain repo can keep its stories in `stories/`. A file without an `id:` is
// not a story and is ignored. A story with no `status:` line, or an empty one, is `todo`, as in
// the other sources, so a new story is never dropped silently.
//
// Options (the `stories` block of foreman.config.json):
//   dir              the folder, relative to the project or absolute (required)
//   dirEnv           the name of an environment variable that, when set and not empty, replaces
//                    dir (e.g. NOTES_VAULT_DIR, for a notes vault on another machine)
//   dirEnvSuffix     a path joined to dirEnv's value when it is used (e.g. "Stories", when the
//                    variable names the vault root)
//   idPattern        what a story id looks like, as a RegExp source ("[A-Z]+-\\d+")
//   fields           which frontmatter key holds each of group, groupName, order, dependsOn,
//                    blockedBy (defaults: group, group_name, order, depends_on, blocked_by)
//   ownerTask        { id?, title? } regex sources; a story matching one is the owner's to do.
//                    Passing `ownerTask: {}` turns owner-task detection off.
//   resourcesByGroup { resourceName: [groups] }: every story in those groups needs that resource
//   groupLabel       what the group is called in the story's prompts (default "Group")
//   groupSummary     where a finished group's summary is written: a path relative to dir, with
//                    {group}, {groupName} and {groupLabel} filled in. Unset: no summaries.
//   progressHeading  the heading the dated progress lines go under ("## Progress notes")
//   track            where status changes go: "file" edits the notes in place (a vault outside
//                    the repo); "state" keeps them in an overlay in the state folder and never
//                    touches the notes, whose only change is the story's own commit marking it
//                    done (finalize). Default: "state" when dir is inside the project, else "file".
//   newId            the id template for stories made by create(): {n} is 1 + the highest number
//                    already used by ids of that shape, {group} the origin story's group
//                    (default "F-{n}"; for grouped ids, e.g. "P{group}-F{n}"). The id must match idPattern.
//
// In file mode update() edits one note and leaves every other line of it exactly as it was.
// In state mode it writes <stateDir>/stories/<id>.json instead: { id, status?, blockedBy?,
// fields, notes: [{ date, text }] }, newest note first. A note that says done or retired is
// merged truth and beats the overlay.
//
// create() writes a new note. In file mode it goes straight into dir. In state mode it waits in
// <stateDir>/stories/new/, which list() and brief() read like dir, and finalize() in the
// story's worktree writes it into dir there, so the story's own pull request adds the file.
// Once dir has a note with that id, the waiting copy is ignored and deleted.
//
// note(id, { kind, title, summary, text }) is the story note engine/story-notes.mjs posts; here
// it is one progress line (see note below); false for an unknown id, or when the notes cannot be read.
//
// A story's `followUpOf` is its `follow_up_of:` frontmatter, which create() writes from the
// origin: the story it follows up, or '' for none.
//
// Stage branches (state mode only): when pull requests merge into a branch other than the base
// branch (ctx.shippedOn, { remote, branch }, from engine/story-source.mjs storyTarget), finalize
// never edits a story file that is on the base branch, because the owner may edit it there and
// the two branches would conflict. It writes the story's shipped record instead, in the story's
// own commit: <dir>/.shipped/<id>.json, { id, status: 'done', completed, notes: [{ date, text }] },
// newest note first. Only Foreman writes it, so it cannot conflict. list() reads the records in
// <dir>/.shipped (those already promoted to the base branch) and the ones on
// refs/remotes/<remote>/<branch> (read with git ls-tree and kept for SHIPPED_TTL_MS, because the
// supervisor lists many times a tick). A record is merged truth like a done note: it beats a todo,
// in-progress or blocked note or overlay, but not a retired note or a ready-to-promote park.
// A note made by create() that still waits is written into the checkout as before, since it is
// a new file. In file mode records are ignored.

import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { listNames, readText } from '../../engine/read-cache.mjs';
import { bulletOf, localDate, overlayStore, safeId as safe, writeAtomic } from './overlay.mjs';

// The one place the default id pattern lives; the picking rules take the pattern from the source.
export const DEFAULT_ID_PATTERN = '[A-Z]+-\\d+';
export const DEFAULT_NEW_ID = 'F-{n}';
// Where a story's shipped record lives under dir, and how long the remote branch's list of them is kept.
export const SHIPPED_DIR = '.shipped';
export const SHIPPED_TTL_MS = 30_000;

const OPTION_KEYS = ['adapter', 'dir', 'dirEnv', 'dirEnvSuffix', 'idPattern', 'fields', 'ownerTask', 'resourcesByGroup', 'progressHeading', 'groupSummary', 'groupLabel', 'track', 'newId'];
const TRACKS = ['file', 'state'];
const FINAL = ['done', 'retired'];

const DEFAULT_FIELDS = { group: 'group', groupName: 'group_name', order: 'order', dependsOn: 'depends_on', blockedBy: 'blocked_by' };

// The names under SHIPPED_DIR on each remote branch read so far: `${dir}\0${ref}` -> { at, names }.
// Module-level because the supervisor opens a fresh source on every call.
const shippedCache = new Map();
const gitEnv = () => {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[key];
  return env;
};

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function regex(source, name, flags) {
  try {
    return new RegExp(source, flags);
  } catch {
    throw new Error(`${name} is not a valid regular expression`);
  }
}

export function checkOptions(options) {
  if (!isPlain(options)) throw new Error('stories options must be an object');
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.includes(key)) throw new Error(`stories.${key} is not a known option`);
  }
  const { dir, idPattern, fields, groupLabel, ownerTask, resourcesByGroup, progressHeading, track } = options;
  if (typeof dir !== 'string' || dir === '') throw new Error('stories.dir is required');
  for (const key of ['dirEnv', 'dirEnvSuffix']) {
    if (options[key] !== undefined && (typeof options[key] !== 'string' || options[key] === '')) throw new Error(`stories.${key} must be a non-empty string`);
  }
  if (options.dirEnvSuffix !== undefined && options.dirEnv === undefined) throw new Error('stories.dirEnvSuffix needs stories.dirEnv');
  if (track !== undefined && !TRACKS.includes(track)) throw new Error(`stories.track must be one of ${TRACKS.join(', ')}`);
  if (idPattern !== undefined && (typeof idPattern !== 'string' || idPattern === '')) throw new Error('stories.idPattern must be a non-empty string');
  if (idPattern !== undefined) {
    regex(idPattern, 'stories.idPattern');
    if (/(^|[^\\])\^|(^|[^\\])\$/.test(idPattern)) throw new Error('stories.idPattern must not contain ^ or $ (ids are found inside text)');
  }
  if (fields !== undefined) {
    if (!isPlain(fields)) throw new Error('stories.fields must be an object');
    for (const [k, v] of Object.entries(fields)) {
      if (!(k in DEFAULT_FIELDS)) throw new Error(`stories.fields.${k} is not a known field`);
      if (typeof v !== 'string' || v === '') throw new Error(`stories.fields.${k} must be a frontmatter key`);
    }
  }
  if (ownerTask !== undefined) {
    if (!isPlain(ownerTask)) throw new Error('stories.ownerTask must be an object');
    for (const k of ['id', 'title']) {
      if (ownerTask[k] === undefined) continue;
      if (typeof ownerTask[k] !== 'string' || ownerTask[k] === '') throw new Error(`stories.ownerTask.${k} must be a non-empty string`);
      regex(ownerTask[k], `stories.ownerTask.${k}`);
    }
  }
  if (resourcesByGroup !== undefined) {
    if (!isPlain(resourcesByGroup)) throw new Error('stories.resourcesByGroup must be an object');
    for (const [name, groups] of Object.entries(resourcesByGroup)) {
      if (!Array.isArray(groups) || groups.some((g) => typeof g !== 'string')) throw new Error(`stories.resourcesByGroup.${name} must be a list of group names (strings)`);
    }
  }
  if (options.groupSummary !== undefined && (typeof options.groupSummary !== 'string' || options.groupSummary === '')) throw new Error('stories.groupSummary must be a non-empty path template');
  if (groupLabel !== undefined && (typeof groupLabel !== 'string' || groupLabel === '')) throw new Error('stories.groupLabel must be a non-empty string');
  if (progressHeading !== undefined && (typeof progressHeading !== 'string' || progressHeading === '')) throw new Error('stories.progressHeading must be a non-empty string');
  const { newId } = options;
  if (newId !== undefined) {
    if (typeof newId !== 'string' || newId === '') throw new Error('stories.newId must be a non-empty id template');
    if ((newId.match(/\{n\}/g) ?? []).length !== 1) throw new Error('stories.newId must hold {n} exactly once');
    const other = newId.replace(/\{(?:n|group)\}/g, '').match(/\{[^}]*\}/);
    if (other) throw new Error(`stories.newId: ${other[0]} is not a known placeholder (use {n} and {group})`);
  }
}

const escapeKey = (key) => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const frontmatterOf = (text) => text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
// A frontmatter value as YAML means it: 'single quoted' (with '' for a quote) or "double
// quoted" (with \" for a quote). Notes use both; a blocked_by that cannot be read as ids is
// never picked again.
export function unquote(value) {
  const single = value.match(/^'(.*)'$/);
  if (single) return single[1].replace(/''/g, "'");
  const double = value.match(/^"(.*)"$/);
  if (double) return double[1].replace(/\\(["\\])/g, '$1');
  return value;
}
const fieldOf = (fm, key) => unquote((fm.match(new RegExp(`^${escapeKey(key)}:[ \\t]*(.*)$`, 'm'))?.[1] ?? '').trim());

// Written in double quotes when YAML would misread it, the way titles are in existing notes.
const yamlValue = (value) => {
  const v = Array.isArray(value) ? `[${value.join(', ')}]` : String(value);
  if (v === '') return '';
  return v.includes(': ') || v.includes('#') || v.startsWith('"') ? ` "${v.replace(/"/g, '\\"')}"` : ` ${v}`;
};


const realOr = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
const isInside = (root, path) => {
  const rel = relative(realOr(root), realOr(path));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

// Written to a temp file and linked into place: a reader never sees half a file, and an
// existing file is never replaced (two writers racing for one name: the second gets EEXIST).
function writeNew(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text);
  try {
    linkSync(tmp, file);
  } finally {
    unlinkSync(tmp);
  }
}

// A note's text with frontmatter keys set ([key, value] pairs) and progress lines added as the
// newest notes (newest first), every other line kept as it was.
function edited(text, sets, bullets, progressHeading) {
  const lines = text.split('\n');
  for (const [key, value] of sets) {
    const line = `${key}:${yamlValue(value)}`;
    const close = lines.indexOf('---', 1);
    const at = lines.slice(1, close).findIndex((l) => l.startsWith(`${key}:`));
    if (at === -1) lines.splice(close, 0, line);
    else lines[at + 1] = line;
  }
  if (bullets.length) {
    const heading = lines.indexOf(progressHeading);
    if (heading === -1) {
      lines.push('', progressHeading, ...bullets.flatMap((b) => ['', b]), '');
    } else {
      // After the italic hint line when there is one, else straight after the heading.
      let at = heading + 1;
      while (lines[at] === '') at += 1;
      const after = lines[at]?.startsWith('_') ? at : heading;
      const block = bullets.flatMap((b) => ['', b]);
      lines.splice(after + 1, 0, ...(lines[after + 1] === '' ? block : [...block, '']));
    }
  }
  return lines.join('\n');
}

// The absolute stories folder for these options (dirEnv's value when set, else dir); it checks nothing.
export function storiesDirOf(options = {}, { root, env = process.env } = {}) {
  const moved = options.dirEnv ? String(env[options.dirEnv] ?? '') : '';
  return moved ? resolve(root, moved, options.dirEnvSuffix ?? '') : resolve(root, options.dir);
}

export function create(options, ctx = {}) {
  checkOptions(options);
  const root = ctx.root ?? process.cwd();
  const now = ctx.now ?? (() => new Date());
  const env = ctx.env ?? process.env;
  const dir = storiesDirOf(options, { root, env });
  const idPattern = options.idPattern ?? DEFAULT_ID_PATTERN;
  const fields = { ...DEFAULT_FIELDS, ...(options.fields ?? {}) };
  const progressHeading = options.progressHeading ?? '## Progress notes';
  const resourcesByGroup = options.resourcesByGroup ?? {};
  const ownerId = options.ownerTask?.id ? new RegExp(options.ownerTask.id) : null;
  const ownerTitle = new RegExp((options.ownerTask ?? { title: '\\(owner task\\)' }).title ?? '(?!)', 'i');
  const track = options.track ?? (isInside(root, dir) ? 'state' : 'file');
  const stateDir = ctx.stateDir;
  // Stage branches: where pull requests merge when that is not the base branch. File mode ignores it.
  const target = track === 'state' && ctx.shippedOn ? ctx.shippedOn : null;
  if (track === 'state' && !stateDir) throw new Error('stories tracked in state need a state folder (ctx.stateDir)');
  const keyed = { ...fields, status: 'status', title: 'title' };

  const newId = options.newId ?? DEFAULT_NEW_ID;
  // State mode: notes made by create() wait here until the base branch has them.
  const waitingDir = () => join(stateDir, 'stories', 'new');

  // The notes in one folder: { file, text, fm }.
  const notesIn = (folder) =>
    listNames(folder, { strict: true })
      .filter((name) => name.endsWith('.md'))
      .sort()
      .map((name) => {
        const file = join(folder, name);
        const text = readText(file);
        return text === null ? null : { file, text, fm: frontmatterOf(text) };
      })
      .filter((n) => n && fieldOf(n.fm, 'id'));

  // Every story note, the waiting ones (state mode) marked `waiting`. A waiting note whose id
  // dir already has has merged: the real file wins and the copy is deleted.
  const notes = () => {
    const real = notesIn(dir);
    if (track !== 'state' || !existsSync(waitingDir())) return real;
    const have = new Set(real.map((n) => fieldOf(n.fm, 'id')));
    const waiting = [];
    for (const n of notesIn(waitingDir())) {
      if (!have.has(fieldOf(n.fm, 'id'))) waiting.push({ ...n, waiting: true });
      else rmSync(n.file, { force: true });
    }
    return [...real, ...waiting];
  };

  const toStory = ({ file, fm }) => {
    const id = fieldOf(fm, 'id');
    const title = fieldOf(fm, 'title');
    const group = fieldOf(fm, fields.group);
    return {
      id,
      title,
      ref: file,
      status: fieldOf(fm, 'status') || 'todo',
      group,
      groupName: fieldOf(fm, fields.groupName),
      order: Number(fieldOf(fm, fields.order)) || 0,
      dependsOn: fieldOf(fm, fields.dependsOn).match(new RegExp(idPattern, 'g')) ?? [],
      blockedBy: fieldOf(fm, fields.blockedBy),
      ownerTask: Boolean((ownerId && ownerId.test(id)) || ownerTitle.test(title)),
      resources: Object.entries(resourcesByGroup).filter(([, groups]) => groups.includes(group)).map(([name]) => name),
      followUpOf: fieldOf(fm, 'follow_up_of'),
    };
  };

  const find = (id) => notes().find((n) => fieldOf(n.fm, 'id') === id) ?? null;

  // The frontmatter pairs a change sets: [key, value], logical names mapped to note keys.
  const setsOf = (status, changes) =>
    Object.entries({ ...(status === undefined ? {} : { status }), ...changes }).map(([k, v]) => [keyed[k] ?? k, v]);

  // ---- state mode: the overlay ----
  const overlay = stateDir ? overlayStore(stateDir) : null;
  const readOverlay = (id) => overlay.read(id);
  const overlaySets = (ov) => [
    ...(ov.status === undefined ? [] : [['status', ov.status]]),
    ...(ov.blockedBy === undefined ? [] : [[fields.blockedBy, ov.blockedBy]]),
    ...Object.entries(ov.fields ?? {}),
  ];
  const isFinal = (n) => FINAL.includes(fieldOf(n.fm, 'status'));
  // The note as Foreman sees it: the file, with the overlay on top unless the file is final.
  const effective = (n) => {
    if (track !== 'state' || isFinal(n)) return n;
    const ov = readOverlay(fieldOf(n.fm, 'id'));
    return ov ? { ...n, fm: frontmatterOf(edited(n.text, overlaySets(ov), [], progressHeading)) } : n;
  };

  // The record file names on the remote branch (cached), read with git; empty when anything fails.
  const remoteShipped = () => {
    const ref = `refs/remotes/${target.remote}/${target.branch}`;
    const key = `${realOr(dir)}\0${ref}`;
    const at = now().getTime();
    const had = shippedCache.get(key);
    if (had && at - had.at < SHIPPED_TTL_MS) return had.names;
    let names = [];
    try {
      const r = spawnSync('git', ['ls-tree', '-z', '--name-only', ref, '--', `${SHIPPED_DIR}/`], { cwd: dir, encoding: 'utf8', timeout: 10_000, env: gitEnv() });
      if (r.status === 0) names = String(r.stdout).split('\0').filter(Boolean).map((p) => basename(p));
    } catch {
      names = [];
    }
    shippedCache.set(key, { at, names });
    return names;
  };

  // The record file names promoted into dir; empty when the folder is missing or cannot be read, as the remote read is.
  const localShipped = () => {
    try {
      return listNames(join(dir, SHIPPED_DIR));
    } catch {
      return [];
    }
  };

  // The names of the shipped records: those in dir (promoted to the base branch) and, with a
  // stage branch, those on its remote ref.
  const shippedNames = () => {
    if (track !== 'state') return new Set();
    const names = localShipped().filter((name) => name.endsWith('.json'));
    if (target) names.push(...remoteShipped());
    return new Set(names.filter((name) => name.endsWith('.json')));
  };

  const list = () => {
    const shipped = shippedNames();
    return notes().map((n) => {
      const s = toStory(effective(n));
      return shipped.has(`${safe(s.id)}.json`) && !['done', 'retired', 'ready-to-promote'].includes(s.status) ? { ...s, status: 'done' } : s;
    });
  };

  const brief = (id) => {
    const note = find(id);
    if (!note) return null;
    if (track !== 'state' || isFinal(note)) return { path: note.file };
    const ov = readOverlay(id);
    if (!ov || (!ov.notes?.length && ov.blockedBy === undefined)) return { path: note.file };
    const path = join(stateDir, 'briefs', `${safe(id)}.md`);
    writeAtomic(path, edited(note.text, overlaySets(ov), (ov.notes ?? []).map(bulletOf), progressHeading));
    return { path };
  };

  // `event` (the Jira source's write-back) means nothing here: a change that is only an event
  // and its note is left out, so the story file never gets the release's notes twice.
  function update(id, { status, fields: changes = {}, note, event } = {}) {
    const found = find(id);
    if (!found) return false;
    if (event !== undefined && status === undefined && Object.keys(changes).length === 0) return true;
    const sets = setsOf(status, changes);
    const entry = note ? { date: localDate(now()), text: note } : null;

    if (track === 'file') {
      writeFileSync(found.file, edited(found.text, sets, entry ? [bulletOf(entry)] : [], progressHeading));
      return true;
    }
    const ov = overlay.load(id);
    for (const [key, value] of sets) {
      if (key === 'status') ov.status = value;
      else if (key === fields.blockedBy) ov.blockedBy = value;
      else ov.fields[key] = value;
    }
    if (entry) ov.notes.unshift(entry);
    overlay.write(id, ov);
    return true;
  }

  // A story note (engine/story-notes.mjs): one dated progress line, the title with its first
  // letter capitalised, ': ' and the summary folded to one line, 500 characters at most. It is
  // not an event, so the line is all it records; the full text is for sources that hold comments.
  function note(id, { title, summary } = {}) {
    const head = String(title ?? '').trim();
    const said = String(summary ?? '').trim();
    const line = `${head.charAt(0).toUpperCase()}${head.slice(1)}${said ? `: ${said}` : ''}`.replace(/\s+/g, ' ').trim().slice(0, 500);
    try {
      return update(id, { note: line });
    } catch {
      // A folder that cannot be read is a story that cannot be found, not a note to try again for ever.
      return false;
    }
  }

  // State mode: mark the story done in the copy of its file in the checkout around cwd (the
  // story's worktree), with the overlay's notes, so the story's commit carries them. Returns
  // { path } of the edited file, { path: null } when there is nothing to edit, null for an
  // unknown id. With stage branches (target) a note already on the base branch is not edited:
  // the story's shipped record is written instead and its path returned (see the header).
  function finalize(id, { note, cwd = process.cwd() } = {}) {
    const found = find(id);
    if (!found) return null;
    // A waiting note goes into dir under its own name; any other note is edited where it is.
    const inRepo = found.waiting ? join(dir, basename(found.file)) : found.file;
    if (track !== 'state' || !isInside(root, inRepo)) return { path: null };
    const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
    if (top.status !== 0) throw new Error(`finalize must run inside a git checkout (${cwd})`);
    const checkout = String(top.stdout).trim();
    const today = localDate(now());
    if (target && !found.waiting) return { path: writeRecord(checkout, id, today, note) };
    const repoPath = found.waiting ? join(realOr(dir), basename(found.file)) : realOr(found.file);
    const path = join(checkout, relative(realOr(root), repoPath));
    // A story made by create() is not on the base branch yet: its own commit adds the file.
    if (found.waiting && !existsSync(path)) writeAtomic(path, found.text);
    if (!existsSync(path)) throw new Error(`${path} is not in this checkout`);
    const earlier = (readOverlay(id)?.notes ?? []).map(bulletOf);
    const text = readFileSync(path, 'utf8');
    // Run again (a fix round after finalize), it adds no line the file already has.
    const have = new Set(text.split('\n'));
    const bullets = [...(note ? [bulletOf({ date: today, text: note })] : []), ...earlier].filter((b) => !have.has(b));
    writeFileSync(path, edited(text, setsOf('done', { completed: today }), bullets, progressHeading));
    return { path: target ? writeRecord(checkout, id, today, note) : path };
  }

  // The story's shipped record in the checkout: the note given, then the notes of the record
  // already there (a fix round), then the overlay's, each date+text once, newest first.
  function writeRecord(checkout, id, today, note) {
    const path = join(checkout, relative(realOr(root), realOr(dir)), SHIPPED_DIR, `${safe(id)}.json`);
    let before = [];
    try {
      const earlier = JSON.parse(readFileSync(path, 'utf8')).notes;
      if (Array.isArray(earlier)) before = earlier;
    } catch {
      before = [];
    }
    const seen = new Set();
    const notes = [...(note ? [{ date: today, text: note }] : []), ...before, ...(readOverlay(id)?.notes ?? [])].filter((n) => {
      const key = `${n?.date}\0${n?.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    writeAtomic(path, `${JSON.stringify({ id, status: 'done', completed: today, notes }, null, 2)}\n`);
    return path;
  }

  // Where the group's summary goes and whether it is due: every live story done, the file
  // there, and not yet saying "<label> X (is) finished". Null when the option is unset or the
  // group has no stories.
  const groupLabel = options.groupLabel ?? 'Group';
  function groupSummary(group) {
    if (typeof options.groupSummary !== 'string' || options.groupSummary === '') return null;
    const live = list().filter((s) => s.group === group && s.status !== 'retired');
    if (!live.length) return null;
    const path = resolve(dir, options.groupSummary.replace(/\{(group|groupName|groupLabel)\}/g, (_, k) => ({ group, groupName: live[0].groupName, groupLabel })[k]));
    const finished = new RegExp(`${escapeKey(groupLabel)} \\S+ (?:is )?finished`, 'i');
    const needed = live.every((s) => s.status === 'done') && existsSync(path) && !finished.test(readFileSync(path, 'utf8'));
    return { path, needed };
  }

  // A new story note, in the layout of the others: { id, path }. The id comes from newId; the
  // origin story, when given, lends its group fields and its file-naming style.
  function createStory({ title, what = '', doneWhen = '', dependsOn = [], origin } = {}) {
    const name = String(title ?? '').replace(/\s+/g, ' ').trim();
    if (!name) throw new Error('a new story needs a title');
    const all = notes();
    const from = origin ? all.find((n) => fieldOf(n.fm, 'id') === origin) : null;
    if (origin && !from) throw new Error(`unknown origin story: ${origin}`);
    const group = from ? fieldOf(from.fm, fields.group) : '';
    if (newId.includes('{group}') && !group) throw new Error(`stories.newId uses {group}, but ${origin ? `${origin} has no group` : 'no origin story was given'}`);
    const [before, after] = newId.replace(/\{group\}/g, group).split('{n}');
    const shape = new RegExp(`^${escapeKey(before)}(\\d+)${escapeKey(after)}$`);
    const top = Math.max(0, ...all.map((n) => Number(shape.exec(fieldOf(n.fm, 'id'))?.[1] ?? 0)));
    const id = `${before}${top + 1}${after}`;
    if (!new RegExp(`^(?:${idPattern})$`).test(id)) throw new Error(`the new id ${id} (from stories.newId "${newId}") does not match stories.idPattern`);

    // "P2a-03 Keep an audit table.md" style when the origin is named that way, else "<id>.md".
    const titled = from && basename(from.file).startsWith(`${origin} `);
    const fileName = titled ? `${id} ${name.replace(/[\\/:*?"<>|]/g, '')}.md` : `${safe(id)}.md`;
    const path = join(track === 'state' ? waitingDir() : dir, fileName);
    const fm = [['id', id], ['title', name], ['status', 'todo']];
    for (const key of from ? [fields.group, fields.groupName, fields.order] : []) {
      const value = fieldOf(from.fm, key);
      if (value) fm.push([key, value]);
    }
    fm.push([fields.dependsOn, dependsOn]);
    if (origin) fm.push(['follow_up_of', origin]);
    const text = [
      '---',
      ...fm.map(([k, v]) => `${k}:${yamlValue(v)}`),
      '---',
      '',
      `# ${id} · ${name}`,
      '',
      '## What',
      '',
      String(what).trim(),
      '',
      '## Done when',
      '',
      String(doneWhen).trim(),
      '',
      progressHeading,
      '',
      '_Newest first._',
      '',
    ].join('\n');
    writeNew(path, text);
    return { id, path };
  }

  return { list, update, note, brief, finalize, groupSummary, create: createStory, track, idPattern, groupLabel };
}
