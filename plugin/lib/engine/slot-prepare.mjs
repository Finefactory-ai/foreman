// Preparing a slot's environment. A slot environment's prepare may answer now (a state string)
// or later (a promise of one). This module runs it, applies the one-repair-per-run ladder, and
// keeps track of slots whose prepare has not settled. It never throws and never leaves a
// rejection unhandled.
//
// An outcome is { state, error, repair }: `state` is one of STATES, `error` a message or null,
// and `repair` null when no repair was tried, true when one ran and worked, false when it
// failed. A sync adapter gets its outcome back in the same call, so the supervisor still
// starts its session in the same tick. The adapter's repair may answer a boolean now or a
// promise of one; prepare runs again only once it has settled. Error texts are redacted and
// cut to 200 characters, as they go out in notices. An error with no message shows as
// 'failed with no message'.
//
// It also puts Foreman's learned skills into the slot. learnedSkills reads the skills in force
// from the learning store (none when `learning.apply` is false), each checked against its
// ledger sha256, so a changed snapshot is skipped. syncLearnedSkills replaces the worktree's
// .claude/skills/foreman-learned-* folders with them, after adding the exclude line to the
// common git dir's info/exclude, so a story commit never holds them. It never writes or
// removes a folder skills-lock.json lists (a pack skill) or one without the prefix, touches
// nothing when the lock cannot be read or when .claude or .claude/skills is a symlink or not a
// folder, and copies nothing outside a git repo. A block-scalar description (`description: >`)
// is read by joining its indented lines. learnedSkillsByRole lists, per role, the skills a slot
// folder holds, for the role's brief: only those whose slot file is the version in force.
// None of the three throws; what went wrong comes back as warnings.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { join } from 'node:path';
import { readLock } from '../../packs/salesforce/skills.mjs';
import { currentItems, itemText, readLedger } from './learning-store.mjs';
import { redact } from './state.mjs';
import { defaultSh } from './worktree.mjs';

export const STATES = ['up', 'restarted', 'reset', 'down'];

// What prepareSlot returns when the answer comes later.
export const PENDING = Symbol('pending');

export const isPending = (v) => v != null && typeof v.then === 'function';

// Capped at 4000 characters before it is redacted, so a huge message cannot stall the event
// loop. When the cap cuts the text, the word it cut is dropped and a quoted value it left open
// is closed, so the rules see no half secret, even though redacting shortens the text and
// pulls later characters into the 200 that are shown. A cut head that is one word and that
// redaction shortened shows as '•••'. Redacted before the 200 cut.
const CAP = 4000;
function clip(text, max = 200) {
  const all = String(text);
  if (all.length <= CAP) return redact(all).slice(0, max);
  let head = all.slice(0, CAP);
  let space = head.length - 1; // a loop, not a regex, so a long word cannot backtrack
  while (space >= 0 && !/\s/.test(head[space])) space--;
  if (space >= 0) head = head.slice(0, space + 1);
  for (const q of ['"', "'"]) {
    const at = head.lastIndexOf(`=${q}`);
    if (at >= 0 && head.indexOf(q, at + 2) < 0) head += q;
  }
  const out = redact(head);
  if (space < 0 && out.length < head.length) return '•••';
  return out.slice(0, max);
}
const NO_MESSAGE = 'failed with no message';
const message = (err) => {
  const t = clip(err?.message ?? err);
  return t.trim() ? t : NO_MESSAGE;
};

// A value as JSON, or its type when JSON cannot show it (a circular object, a BigInt).
function shown(v) {
  try {
    return String(JSON.stringify(v));
  } catch {
    return typeof v;
  }
}

// The outcome of one answer from prepare.
function normalise(v) {
  if (STATES.includes(v)) return { state: v, error: null };
  return { state: 'down', error: `prepare answered ${clip(shown(v))}, not up, restarted, reset or down` };
}

// Calls fn with value now when it is plain, or when it settles when it is a promise.
const after = (value, fn) => (isPending(value) ? value.then(fn) : fn(value));

// One call of the adapter's prepare. A plain outcome, or a promise of one that never rejects.
function attempt(adapter, n, path) {
  let v;
  try {
    v = adapter.prepare(n, path);
  } catch (err) {
    return { state: 'down', error: message(err) };
  }
  if (isPending(v)) return Promise.resolve(v).then(normalise, (err) => ({ state: 'down', error: message(err) }));
  return normalise(v);
}

// Prepares the slot's environment, repairing it once when it answers down. `repair` is the
// adapter's repair when this run may still try one, else null. It may answer a boolean now or
// a promise of one; a throw, a rejection or false counts as a failed repair. A throw or a
// rejection from prepare never triggers a repair: the environment answered, it just failed.
export function prepareEnv({ adapter, n, path, repair = null }) {
  return after(attempt(adapter, n, path), (first) => {
    if (first.state !== 'down' || first.error || typeof repair !== 'function') return { ...first, repair: null };
    const failed = (err) => ({ state: 'down', error: message(err), repair: false });
    const next = (ok) => (ok ? after(attempt(adapter, n, path), (second) => ({ ...second, repair: true })) : { state: 'down', error: null, repair: false });
    let r;
    try {
      r = repair();
    } catch (err) {
      return failed(err);
    }
    if (isPending(r)) return Promise.resolve(r).then((ok) => next(Boolean(ok)), failed);
    return next(Boolean(r));
  });
}

// The slot patch for a session that did not start, or null to leave the slot as it is. A park
// the owner asked for while the slot was preparing is carried out now, as no session will end
// to carry it out. A down slot keeps its story, so resume can queue it again.
export function notStartedPatch(st) {
  if (st.parkAfter === true) {
    const patch = { state: 'parked', parkedFor: 'owner', parkAfter: false, reason: 'Parked by you.' };
    return st.state === 'building' ? { ...patch, story: null } : patch;
  }
  if (st.state === 'building') return { state: 'idle', story: null };
  return null;
}

// The slot patch for a session that starts now (`at`, an ISO string): building, with the
// slot's story kept, or a fresh one for `id`. It clears heldStory, which a released held slot
// keeps until its story's session starts (scheduler.mjs releaseHeld), and parkedStory, the story
// a crash-parked slot keeps its claim for (supervisor.mjs onExit).
export function sessionStartPatch(st, id, at) {
  return {
    state: 'building',
    reason: '',
    parkedFor: null,
    parkedStory: null,
    result: null,
    heldStory: null,
    lastBeat: at,
    story: st?.story ?? { id, title: '', stage: 'starting', detail: '', startedAt: at, rounds: 0, committedAt: null },
  };
}

const REPAIRED = 'The slot environment was down; repaired it.';
const NOT_REPAIRED = 'The slot environment was down and could not be repaired.';
const PAUSE = 'The slot environment would not start, even after a repair.';

// What the supervisor does with an outcome: start the session, put the slot down, or pause the
// run (down even after a repair). `events` are the warnings to record; `note` is said about a
// slot that starts in a state other than up.
export function envVerdict({ state, error, repair }) {
  const events = repair === null ? [] : [{ text: repair ? REPAIRED : NOT_REPAIRED, kind: 'warn' }];
  if (state === 'down' && repair !== null) return { action: 'pause', reason: PAUSE, note: null, events };
  if (state === 'down') return { action: 'down', reason: error ? `Its environment would not start: ${error}` : 'Its environment would not start.', note: null, events };
  return { action: 'start', reason: '', note: state === 'up' ? null : `environment ${state}`, events };
}

// The slots whose prepare has not settled. Each add gets a fresh token; only the slot's current
// token settles, and nothing settles once the tracker is closed, so a cancelled or stopped
// slot never starts late. live(slot, token) says whether a token could still settle, for work
// (a worktree install) that should stop at its next step when nobody waits for it.
export function pendingPrepares() {
  const slots = new Map(); // slot -> token
  let closed = false;
  return {
    has: (slot) => slots.has(slot),
    // True while `token` is the slot's current one and the tracker is open: whether the work
    // started for it still has an owner.
    live: (slot, token) => !closed && slots.get(slot) === token,
    get size() {
      return slots.size;
    },
    add(slot, info = {}) {
      if (slots.has(slot)) throw new Error(`slot ${slot} is still preparing`);
      const token = { id: info.id };
      slots.set(slot, token);
      return token;
    },
    settle(slot, token) {
      if (closed || slots.get(slot) !== token) return false;
      slots.delete(slot);
      return true;
    },
    cancel: (slot) => slots.delete(slot),
    close() {
      closed = true;
      slots.clear();
    },
  };
}

// Prepares a slot. A plain outcome when the adapter answered now: the caller acts on it at
// once. PENDING when it answers later: the slot is tracked in `pending` and `later(outcome)` is
// called when it settles, unless it was cancelled or the tracker closed first. A throw from
// `later` goes to onError.
export function prepareSlot({ slot, id, adapter, n, path, repair = null, pending, later, onError }) {
  const outcome = prepareEnv({ adapter, n, path, repair });
  if (!isPending(outcome)) return outcome;
  const token = pending.add(slot, { id });
  outcome
    .then((o) => {
      if (pending.settle(slot, token)) later(o);
    })
    .catch((err) => {
      try {
        onError?.(err);
      } catch {
        // nothing more to do
      }
    });
  return PENDING;
}

// The slot environment's sweep. An adapter may have a sweep() that tidies what closed stories
// left (env/scratch.mjs deletes their scratch orgs) and answers { warnings } now or later. The
// supervisor runs it every `everyMs` while no sweep runs. runEnvSweep never rejects: a throw, a
// rejection or an answer that is not an object becomes one warning, and every warning is
// redacted and cut to 200 characters, as it goes out as an event.
//
// At a stop the supervisor calls runEnvSweep(adapter, { limitMs }) once, which calls
// adapter.sweep({ stopping: true, limitMs }) and waits for it for limitMs plus a backstop of 15 s
// (STOP_BACKSTOP_MS), so a sweep that never settles cannot hold the stop. When the backstop wins,
// the answer is one warning. Warnings at a stop are cut to 600 characters, not 200, so the
// command a warning gives to run by hand stays whole.

export function envSweepDue({ running, lastAt, now, everyMs }) {
  if (running) return false;
  return lastAt === 0 || now - lastAt >= everyMs;
}

export const STOP_BACKSTOP_MS = 15_000;
const STOP_WARNING_MAX = 600;
const LATE = Symbol('late');

export async function runEnvSweep(adapter, stop = null) {
  if (typeof adapter?.sweep !== 'function') return { warnings: [] };
  const max = stop ? STOP_WARNING_MAX : 200;
  let answer;
  let timer = null;
  try {
    if (stop) {
      const { limitMs, backstopMs = STOP_BACKSTOP_MS } = stop;
      const sweep = Promise.resolve().then(() => adapter.sweep({ stopping: true, limitMs }));
      const late = new Promise((resolve) => {
        timer = setTimeout(() => resolve(LATE), limitMs + backstopMs);
      });
      answer = await Promise.race([sweep, late]);
      if (answer === LATE) return { warnings: [`the sweep at the stop did not finish within ${Math.round((limitMs + backstopMs) / 1000)} s`] };
    } else {
      answer = await adapter.sweep();
    }
  } catch (err) {
    return { warnings: [clip(`the sweep failed: ${err?.message || (err == null ? NO_MESSAGE : String(err))}`, max)] };
  } finally {
    clearTimeout(timer);
  }
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) return { warnings: [clip(`the sweep answered ${shown(answer)}, not { warnings }`, max)] };
  const list = Array.isArray(answer.warnings) ? answer.warnings : [];
  return { warnings: list.filter((w) => typeof w === 'string' && w.trim()).map((w) => clip(w, max)) };
}

// Learned skills.

const PREFIX = 'foreman-learned-';
const NAME = /^foreman-learned-[a-z0-9]+(-[a-z0-9]+)*$/;
const USE_MAX = 300;
const EXCLUDE = '/.claude/skills/foreman-learned-*';
const EXCLUDE_NOTE = "# Foreman's learned skills";
const SKILLS_DIR = join('.claude', 'skills');
const idNumber = (id) => Number(/^L-(\d+)$/.exec(String(id))?.[1] ?? 0);
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const why = (err) => String(err?.message ?? err).slice(0, 200);

// The frontmatter `description:` value, unquoted, or ''. A block scalar (`>`, `|`, `>-`, ...)
// gives its indented lines, trimmed and joined with one space, up to the next key.
function description(text) {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const lines = front?.[1].split(/\r?\n/) ?? [];
  const at = lines.findIndex((l) => /^description:/.test(l));
  if (at < 0) return '';
  let v = lines[at].slice('description:'.length).trim();
  if (/^[>|][1-9+-]*$/.test(v)) {
    const body = [];
    for (const l of lines.slice(at + 1)) {
      if (l.trim() && !/^\s/.test(l)) break;
      if (l.trim()) body.push(l.trim());
    }
    return body.join(' ');
  }
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1);
  return v.trim();
}

export function learnedSkills({ stateDir, config } = {}) {
  const skills = [];
  const warnings = [];
  if (!stateDir || config?.learning?.apply === false) return { skills, warnings };
  let items;
  try {
    items = [...currentItems(readLedger(stateDir)).values()];
  } catch (err) {
    return { skills, warnings: [`the learning ledger could not be read: ${why(err)}`] };
  }
  const inForce = items.filter((i) => i.kind === 'skill' && i.v > 0).sort((a, b) => idNumber(a.id) - idNumber(b.id));
  for (const item of inForce) {
    const name = String(item.path ?? '').split('/').at(-2) ?? '';
    if (!NAME.test(name)) {
      warnings.push(`${item.id} has no learned skill folder name; skipped`);
      continue;
    }
    let text = null;
    try {
      text = itemText(stateDir, item);
    } catch {
      text = null;
    }
    if (text === null || sha256(text) !== item.sha256) {
      warnings.push(`${item.id} is missing or changed since it was learned; not used`);
      continue;
    }
    const use = description(text).slice(0, USE_MAX);
    if (!use) {
      warnings.push(`${name} has no description`);
      continue;
    }
    skills.push({ id: item.id, name, roles: [...item.roles], use, text });
  }
  return { skills, warnings };
}

// Makes sure <common>/info/exclude holds the learned skills' line, once.
function excludeLearned(common) {
  const file = join(common, 'info', 'exclude');
  const had = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (had.split('\n').includes(EXCLUDE)) return;
  fs.mkdirSync(join(common, 'info'), { recursive: true });
  fs.appendFileSync(file, `${had && !had.endsWith('\n') ? '\n' : ''}${EXCLUDE_NOTE}\n${EXCLUDE}\n`);
}

// The first of .claude and .claude/skills that is a symlink or not a folder, or null. lstat, not
// realpath: even a link inside the repo would put the folders outside the exclude line. A
// missing entry is fine, as mkdirSync then makes real folders; any other error is thrown.
function unsafeSkillsParent(path) {
  for (const rel of ['.claude', '.claude/skills']) {
    let st;
    try {
      st = fs.lstatSync(join(path, rel));
    } catch (err) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return rel;
  }
  return null;
}

export function syncLearnedSkills({ path, stateDir, config, sh = defaultSh } = {}) {
  const copied = [];
  const removed = [];
  const warnings = [];
  const done = () => ({ copied, removed, warnings });
  try {
    const lock = readLock(path, fs);
    if (lock.error) return { copied, removed, warnings: ['skills-lock.json could not be read; learned skills not refreshed'] };
    const locked = new Set(Object.keys(lock.lock?.skills ?? {}));
    const { skills, warnings: found } = learnedSkills({ stateDir, config });
    warnings.push(...found);

    let common = null;
    try {
      const r = sh('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: path });
      if (r.status === 0 && String(r.stdout ?? '').trim()) common = String(r.stdout).trim();
    } catch {
      common = null;
    }
    if (!common) {
      if (skills.length) warnings.push('the slot is not a git repository; learned skills not copied');
      return done();
    }
    const unsafe = unsafeSkillsParent(path);
    if (unsafe) {
      warnings.push(`${unsafe} is a symlink or not a folder; learned skills not refreshed`);
      return done();
    }
    excludeLearned(common);

    const dir = join(path, SKILLS_DIR);
    const entries = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    for (const entry of entries.sort()) {
      if (!entry.startsWith(PREFIX) || locked.has(entry)) continue;
      // rmSync removes a symlink itself and never follows it.
      fs.rmSync(join(dir, entry), { recursive: true, force: true });
      removed.push(entry);
    }
    for (const skill of skills) {
      if (locked.has(skill.name)) {
        warnings.push(`${skill.name} is a pack skill; learned skill ${skill.id} not copied`);
        continue;
      }
      fs.mkdirSync(join(dir, skill.name), { recursive: true });
      fs.writeFileSync(join(dir, skill.name, 'SKILL.md'), skill.text);
      copied.push(skill.name);
    }
    return done();
  } catch (err) {
    warnings.push(`learned skills not refreshed: ${why(err)}`);
    return done();
  }
}

export function learnedSkillsByRole({ stateDir, config, roles = [], dir } = {}) {
  const byRole = {};
  const ids = new Set();
  const { skills, warnings } = learnedSkills({ stateDir, config });
  // Only a slot file that is the version in force, so the brief's use-when matches the file.
  const present = skills.filter((s) => {
    if (!dir) return false;
    let text;
    try {
      text = fs.readFileSync(join(dir, SKILLS_DIR, s.name, 'SKILL.md'), 'utf8');
    } catch {
      return false;
    }
    if (sha256(text) === sha256(s.text)) return true;
    warnings.push(`${s.name} in the slot is not the version in force; not listed`);
    return false;
  });
  for (const role of roles) {
    const list = present.filter((s) => s.roles.includes(role) || s.roles.includes('all'));
    if (!list.length) continue;
    byRole[role] = list.map((s) => ({ id: s.id, name: s.name, use: s.use, path: `.claude/skills/${s.name}/SKILL.md` }));
    for (const s of list) ids.add(s.id);
  }
  return { byRole, ids: [...ids].sort((a, b) => idNumber(a) - idNumber(b)), warnings };
}
