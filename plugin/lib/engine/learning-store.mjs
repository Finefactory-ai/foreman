// What Foreman learned by itself, with its history. Everything lives in the state folder `dir`;
// paths are relative to it and `/`-separated.
//
//   learning.jsonl                                  the ledger: one JSON line per change, never rewritten
//   learned/traits/<role>.md                        a role's learned traits, each tagged [L-n]
//   learned/skills/foreman-learned-<slug>/SKILL.md  a learned skill
//   learned/.history/L-<n>/v<k>.md                  the text of version k of item L-n, written once
//
// A ledger line: {at, id, v, action, kind, roles, path, before, after, source, reason, by, metrics}.
// `v` is the version in force after the line (0: removed); `before` and `after` are
// {snapshot, sha256} or null. Actions: add and update push a version, undo (the owner) and
// rollback (Foreman) pop one, keep marks the version in force as kept, and refused records
// an add or update that was turned down; a refused line never holds the text.
//
//   readLedger(dir)                 the valid lines, oldest first; a torn line is skipped
//   currentItems(lines)             Map id -> {id, kind, roles, path, v, stack, status, snapshot, sha256, source, reason, lines}
//   addItem(dir, {kind, roles, text, slug, source, reason, metrics}, {now, by})
//   updateItem(dir, id, {text, source, reason, metrics}, {now, by})
//                                   {ok: true, id, line} or {ok: false, line} (the refused line)
//   undoItem(dir, id, {now, by, action, reason, metrics, v})
//                                   {ok, line, error}; action 'rollback' for Foreman's own
//   keepItem(dir, id, {now, by, reason, metrics, v})
//                                   {ok, line, error}
//   refuseItem(dir, {kind, roles, source, reason}, {now, by})
//                                   {ok: false, line}: records a lesson turned down before it
//                                   reached the store (a check or a cap); id null, v 0, no text
//   itemText(dir, item)             the text in force, or null when removed
//
// Foreman's evaluation (learning-eval.mjs, run by `foreman learning tick`) writes its numbers in
// `metrics`, {decision, window, baseline, ...}: a rollback line with decision 'retire' is a
// version retired for having no effect, not a new action. With `v`, undo and keep refuse
// ("changed since it was evaluated") when the version in force is no longer `v`. Undo and keep
// still act when their reason or metrics look like a secret, but write the reason as withheld
// and the metrics as their decision alone.
//
// Undo restores the previous version's snapshot and fails closed when that snapshot is gone
// or its sha256 is not the ledger's. Each change takes <dir>/learning.lock and throws when a
// live process holds it. Files are written through a temp file and a rename, and no path may
// leave <dir>/learned/. Add and update record a refused line when a sibling trait's snapshot is
// missing or changed. Undo still works when the target's folder is already gone.
// BUSY (the lock's words) and Changed (a missing or changed snapshot) are exported so callers can
// tell the store's own refusals apart from other errors.

import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { looksSecret } from '../state-store/branch.mjs';
import { breakIfStale, release, take } from './locks.mjs';

export const LEDGER = 'learning.jsonl';
export const LEARNED = 'learned';
export const ACTIONS = ['add', 'update', 'keep', 'rollback', 'undo', 'refused'];

const KINDS = ['trait', 'skill'];
const ROLE = /^[a-z][a-z0-9-]*$/;
export const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SLUG_MAX = 40;
const ID = /^L-(\d+)$/;
export const BUSY = 'another Foreman process is changing learned items; try again';

export const traitPath = (role) => `${LEARNED}/traits/${role}.md`;
export const skillPath = (slug) => `${LEARNED}/skills/foreman-learned-${slug}/SKILL.md`;
const snapshotPath = (id, v) => `${LEARNED}/.history/${id}/v${v}.md`;
const idNumber = (id) => Number(ID.exec(String(id))?.[1] ?? 0);
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// The absolute path of `rel`, which must stay inside <dir>/learned/.
function inside(dir, rel) {
  const base = resolve(dir, LEARNED);
  const abs = resolve(dir, String(rel));
  if (!abs.startsWith(base + sep)) throw new Error(`${rel} is outside ${LEARNED}/`);
  return abs;
}

function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

// Removes `file`, then each folder above it that is left empty, up to <dir>/learned/.
// A folder already gone (deleted by hand) is skipped.
function removeFile(dir, file) {
  rmSync(file, { force: true });
  const base = resolve(dir, LEARNED);
  for (let d = dirname(file); d.startsWith(base + sep); d = dirname(d)) {
    let entries;
    try {
      entries = readdirSync(d);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    if (entries.length) break;
    rmdirSync(d);
  }
}

export function readLedger(dir) {
  let text;
  try {
    text = readFileSync(join(dir, LEDGER), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    let line;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (line && typeof line === 'object' && !Array.isArray(line) && ACTIONS.includes(line.action)) out.push(line);
  }
  return out;
}

// A torn last line (no newline) gets one first, so it never swallows the new line.
function appendLine(dir, line) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, LEDGER);
  let lead = '';
  if (existsSync(file) && statSync(file).size > 0) {
    const fd = openSync(file, 'r');
    try {
      const b = Buffer.alloc(1);
      readSync(fd, b, 0, 1, statSync(file).size - 1);
      if (b[0] !== 0x0a) lead = '\n';
    } finally {
      closeSync(fd);
    }
  }
  appendFileSync(file, `${lead}${JSON.stringify(line)}\n`);
  return line;
}

export function currentItems(lines) {
  const items = new Map();
  for (const line of lines) {
    if (line.action === 'refused') {
      items.get(line.id)?.lines.push(line);
      continue;
    }
    let item = items.get(line.id);
    if (line.action === 'add') {
      if (item || !ID.test(String(line.id)) || !line.after) continue;
      item = { id: line.id, kind: line.kind, roles: Array.isArray(line.roles) ? line.roles : [], path: line.path, v: 0, stack: [], status: 'removed', snapshot: null, sha256: null, source: null, reason: '', lines: [], max: 0 };
      items.set(line.id, item);
    }
    if (!item) continue;
    item.lines.push(line);
    const top = item.stack.at(-1);
    if (line.action === 'add' || line.action === 'update') {
      if (!line.after || (line.action === 'update' && !top)) continue;
      const v = line.action === 'add' ? 1 : item.max + 1;
      item.stack.push({ v, snapshot: line.after.snapshot, sha256: line.after.sha256, status: 'evaluating', source: line.source ?? null, reason: line.reason ?? '' });
      item.max = Math.max(item.max, v);
    } else if (line.action === 'undo' || line.action === 'rollback') {
      item.stack.pop();
    } else if (line.action === 'keep' && top) {
      top.status = 'kept';
    }
    const now = item.stack.at(-1);
    item.v = now?.v ?? 0;
    item.status = now?.status ?? 'removed';
    item.snapshot = now?.snapshot ?? null;
    item.sha256 = now?.sha256 ?? null;
    if (now) {
      item.source = now.source;
      item.reason = now.reason;
    }
  }
  for (const item of items.values()) delete item.max;
  return items;
}

// The highest version item `id` ever had, from its lines.
const maxVersion = (item) => Math.max(0, ...item.lines.filter((l) => l.action === 'add' || l.action === 'update').map((l) => Number(l.v) || 0));

export function itemText(dir, item) {
  if (!item?.snapshot) return null;
  return readFileSync(inside(dir, item.snapshot), 'utf8');
}

// The snapshot text, or null when it is missing or its sha256 is not the ledger's.
function checkedSnapshot(dir, ref) {
  try {
    const text = readFileSync(inside(dir, ref.snapshot), 'utf8');
    return sha256(text) === ref.sha256 ? text : null;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export class Changed extends Error {}
const changedError = (id, v, done = 'undone') => new Changed(`the snapshot of ${id} v${v} is missing or changed; nothing was ${done}`);

// The role file's text with `items` in force (id order), or null when it has no traits.
// `extra` maps id -> text for a version not yet in the ledger; `done` words the error.
function renderRole(dir, items, role, extra = new Map(), done = 'undone') {
  const traits = [...items.values()].filter((i) => i.kind === 'trait' && i.v > 0 && i.roles[0] === role);
  for (const id of extra.keys()) if (!traits.some((t) => t.id === id)) traits.push({ id, extra: true });
  traits.sort((a, b) => idNumber(a.id) - idNumber(b.id));
  if (!traits.length) return null;
  const parts = traits.map((t) => {
    const text = extra.has(t.id) ? extra.get(t.id) : checkedSnapshot(dir, t);
    if (text === null) throw changedError(t.id, t.v, done);
    return `[${t.id}] ${text.trim()}`;
  });
  return `${parts.join('\n\n')}\n`;
}

function withLock(dir, fn) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'learning.lock');
  const me = { pid: process.pid, at: new Date().toISOString() };
  if (!take(file, me).ok && !(breakIfStale(file) && take(file, me).ok)) throw new Error(BUSY);
  try {
    return fn();
  } finally {
    release(file, me.pid);
  }
}

const stamp = (now) => (now instanceof Date ? now : new Date()).toISOString();
const plainSource = (source) => (source && typeof source === 'object' ? { key: String(source.key ?? ''), stories: Array.isArray(source.stories) ? source.stories.map(String) : [] } : null);
const plainMetrics = (metrics) => (metrics && typeof metrics === 'object' && !Array.isArray(metrics) ? metrics : null);

// True when any string in `values`, at any depth (object keys included), looks like a secret.
// Each raw string is checked on its own: JSON.stringify would turn a line break before a token
// into `\n`, and the `\b` in the patterns would then miss it.
function holdsSecret(...values) {
  const seen = new Set();
  const walk = (v) => {
    if (typeof v === 'string') return looksSecret(v);
    if (!v || typeof v !== 'object' || seen.has(v)) return false;
    seen.add(v);
    return Object.entries(v).some(([k, x]) => looksSecret(k) || walk(x));
  };
  return values.some(walk);
}

function refuse(dir,{ id = null, v = 0, kind = null, roles = [], path = null, source = null }, reason, { now, by }) {
  const line = { at: stamp(now), id, v, action: 'refused', kind, roles, path, before: null, after: null, source, reason, by, metrics: null };
  return { ok: false, line: appendLine(dir, line) };
}

export function refuseItem(dir, { kind = null, roles = [], source = null, reason } = {}, { now = new Date(), by = 'foreman' } = {}) {
  return withLock(dir, () => {
    const shape = { kind: KINDS.includes(kind) ? kind : null, roles: Array.isArray(roles) ? roles.filter((r) => typeof r === 'string') : [], source: plainSource(source) };
    return refuse(dir, shape, String(reason ?? '').slice(0, 300), { now, by });
  });
}

// Why `input` cannot be added, or null.
function addProblem(items, { kind, roles, slug, text }) {
  if (!KINDS.includes(kind)) return 'kind must be trait or skill';
  if (!Array.isArray(roles)) return kind === 'trait' ? 'a trait needs exactly one role' : 'a skill needs at least one role';
  if (kind === 'trait' && roles.length !== 1) return 'a trait needs exactly one role';
  if (kind === 'skill' && !roles.length) return 'a skill needs at least one role';
  if (!roles.every((r) => typeof r === 'string' && ROLE.test(r))) return 'a role must be lowercase letters, digits and dashes';
  if (kind === 'skill') {
    if (typeof slug !== 'string' || !SLUG.test(slug) || slug.length > SLUG_MAX) return `a skill slug must be lowercase words joined by dashes, at most ${SLUG_MAX} characters`;
    if ([...items.values()].some((i) => i.v > 0 && i.path === skillPath(slug))) return `another learned item already uses the slug ${slug}`;
  }
  if (typeof text !== 'string' || !text.trim()) return 'the text is empty';
  return null;
}

// Writes version `v` of item `id`: the snapshot, then the target file. Returns the {snapshot, sha256}.
// Throws Changed, worded with `done`, when a sibling trait's snapshot is missing or changed.
function writeVersion(dir, items, { id, kind, roles, path }, v, text, done) {
  // Render before writing anything, so a damaged sibling snapshot stops the change whole.
  const rendered = kind === 'trait' ? renderRole(dir, items, roles[0], new Map([[id, text]]), done) : text;
  const ref = { snapshot: snapshotPath(id, v), sha256: sha256(text) };
  const target = inside(dir, path);
  writeAtomic(inside(dir, ref.snapshot), text);
  writeAtomic(target, rendered);
  return ref;
}

export function addItem(dir, input = {}, { now = new Date(), by = 'foreman' } = {}) {
  return withLock(dir, () => {
    const lines = readLedger(dir);
    const items = currentItems(lines);
    const { kind, roles, text, slug, reason = '', metrics = null } = input;
    const shape = { kind: KINDS.includes(kind) ? kind : null };
    if (holdsSecret(text, slug, roles, reason, input.source, metrics)) return refuse(dir, shape, 'looks like it holds a secret', { now, by });
    const source = plainSource(input.source);
    const given = { ...shape, roles: Array.isArray(roles) ? roles.filter((r) => typeof r === 'string') : [], source };
    const problem = addProblem(items, input);
    if (problem) return refuse(dir, given, problem, { now, by });
    // A refused update may name an id that never existed, so refused lines do not count.
    const id = `L-${Math.max(0, ...lines.filter((l) => l.action !== 'refused').map((l) => idNumber(l.id))) + 1}`;
    const path = kind === 'trait' ? traitPath(roles[0]) : skillPath(slug);
    let after;
    try {
      after = writeVersion(dir, items, { id, kind, roles, path }, 1, text, 'added');
    } catch (err) {
      if (err instanceof Changed) return refuse(dir, given, err.message, { now, by });
      throw err;
    }
    const line = { at: stamp(now), id, v: 1, action: 'add', kind, roles: [...roles], path, before: null, after, source, reason: String(reason), by, metrics: plainMetrics(metrics) };
    return { ok: true, id, line: appendLine(dir, line) };
  });
}

export function updateItem(dir, id, input = {}, { now = new Date(), by = 'foreman' } = {}) {
  return withLock(dir, () => {
    const items = currentItems(readLedger(dir));
    const item = items.get(id);
    const { text, reason = '', metrics = null } = input;
    const shape = item ? { id, v: item.v, kind: item.kind, roles: item.roles, path: item.path } : { id: ID.test(String(id)) ? id : null };
    if (holdsSecret(text, reason, input.source, metrics)) return refuse(dir, shape, 'looks like it holds a secret', { now, by });
    const source = plainSource(input.source);
    // Never write an id that is not L-n: it may hold a token, and the ledger is append-only.
    if (!ID.test(String(id))) return refuse(dir, { ...shape, source }, 'the id is not a learned item id', { now, by });
    if (!item || item.v === 0) return refuse(dir, { ...shape, source }, `${id} is not in force; nothing to update`, { now, by });
    if (typeof text !== 'string' || !text.trim()) return refuse(dir, { ...shape, source }, 'the text is empty', { now, by });
    const v = maxVersion(item) + 1;
    const before = { snapshot: item.snapshot, sha256: item.sha256 };
    let after;
    try {
      after = writeVersion(dir, items, item, v, text, 'updated');
    } catch (err) {
      if (err instanceof Changed) return refuse(dir, { ...shape, source }, err.message, { now, by });
      throw err;
    }
    const line = { at: stamp(now), id, v, action: 'update', kind: item.kind, roles: [...item.roles], path: item.path, before, after, source, reason: String(reason), by, metrics: plainMetrics(metrics) };
    return { ok: true, id, line: appendLine(dir, line) };
  });
}

const staleError = (id) => `${id} changed since it was evaluated; nothing done`;
const WITHHELD = 'withheld: it looked like it held a secret';
const DECISIONS = ['keep', 'rollback', 'retire'];

// The reason and metrics an undo or keep line may hold. The action never waits on them, so a
// secret is withheld rather than refused; the decision stays, as it tells a retire from a rollback.
function cleanNote(reason, metrics) {
  const plain = plainMetrics(metrics);
  const decision = plain?.decision;
  return {
    reason: holdsSecret(reason) ? WITHHELD : String(reason),
    metrics: holdsSecret(plain) ? (DECISIONS.includes(decision) ? { decision } : null) : plain,
  };
}

export function undoItem(dir, id, { now = new Date(), by = 'owner', action = 'undo', reason = '', metrics = null, v } = {}) {
  if (action !== 'undo' && action !== 'rollback') throw new Error(`undoItem action must be undo or rollback, not ${action}`);
  return withLock(dir, () => {
    const items = currentItems(readLedger(dir));
    const item = items.get(id);
    if (!item || item.v === 0) return { ok: false, line: null, error: `${id} is not in force; nothing to undo` };
    if (v !== undefined && item.v !== v) return { ok: false, line: null, error: staleError(id) };
    const undone = item.stack.at(-1);
    const restored = item.stack.at(-2) ?? null;
    const next = { ...item, stack: item.stack.slice(0, -1), v: restored?.v ?? 0, snapshot: restored?.snapshot ?? null, sha256: restored?.sha256 ?? null };
    const later = new Map(items).set(id, next);
    let text;
    try {
      if (item.kind === 'trait') text = renderRole(dir, later, item.roles[0]);
      else if (restored) {
        text = checkedSnapshot(dir, restored);
        if (text === null) throw changedError(id, restored.v);
      }
    } catch (err) {
      if (err instanceof Changed) return { ok: false, line: null, error: err.message };
      throw err;
    }
    const note = cleanNote(reason, metrics);
    const target = inside(dir, item.path);
    if (text === null || text === undefined) removeFile(dir, target);
    else writeAtomic(target, text);
    const line = {
      at: stamp(now),
      id,
      v: restored?.v ?? 0,
      action,
      kind: item.kind,
      roles: [...item.roles],
      path: item.path,
      before: { snapshot: undone.snapshot, sha256: undone.sha256 },
      after: restored ? { snapshot: restored.snapshot, sha256: restored.sha256 } : null,
      source: null,
      reason: note.reason,
      by,
      metrics: note.metrics,
    };
    return { ok: true, line: appendLine(dir, line), error: null };
  });
}

export function keepItem(dir, id, { now = new Date(), by = 'owner', reason = '', metrics = null, v } = {}) {
  return withLock(dir, () => {
    const item = currentItems(readLedger(dir)).get(id);
    if (!item || item.v === 0) return { ok: false, line: null, error: `${id} is not in force; nothing to keep` };
    if (v !== undefined && item.v !== v) return { ok: false, line: null, error: staleError(id) };
    const current = { snapshot: item.snapshot, sha256: item.sha256 };
    const note = cleanNote(reason, metrics);
    const line = { at: stamp(now), id, v: item.v, action: 'keep', kind: item.kind, roles: [...item.roles], path: item.path, before: null, after: current, source: null, reason: note.reason, by, metrics: note.metrics };
    return { ok: true, line: appendLine(dir, line), error: null };
  });
}
