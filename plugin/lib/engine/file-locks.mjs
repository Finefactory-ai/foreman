// File locks: two stories running at once never change the same file. After the architect's
// plan, the slot claims every file the plan's `files` names (`foreman lock files`); a story
// whose plan names a file another running story holds is deferred, and the picker leaves it
// alone until those files are free. A slot's file locks go with its token (supervisor.mjs
// releaseToken): when its story ships, blocks, fails, defers or finds nothing to build.
//
//   locks/file-<hash>.json  one file's holder, { pid, slot, story, by: 'factory', at, path }
//                           (locks.mjs's shape plus the path). <hash> is the first 16 hex
//                           characters of the path's sha256, so any path makes a safe name.
//   waits/<ID>.json         { story, on: [holder ids], files: [held paths],
//                           needs: [every claimable file the plan asks for], at, deferrals }: why a
//                           story was deferred, for the picker (waitBlocks, waitOf). `deferrals`
//                           counts, per holder story, how often it was deferred on that holder.
//   locks/reserve-<hash>.json  a file kept for the highest-priority story waiting on it,
//                           { path, story, from, at, until }: `story` is who it is kept for, `from`
//                           the story that let it go (null when kept at that story's start), `until`
//                           is at + RESERVE_MS. The supervisor writes one when a story ends and lets
//                           a file go (reserveFreed) or picks a story with a wait record
//                           (reserveForStart, at its claim); takeFiles refuses the file to any other
//                           story while it lasts, and `foreman lock files`, the story's session
//                           ending, or its start failing drops it (dropReservations). The same <hash> as the file lock; fileLockFiles never
//                           lists these. yieldsTo tells the picker which stories to hold back.
//
// The picker also reads the story's saved plan (plan-file.mjs): the files and resources it names
// that a running story holds keep it out, and so does a holder it was deferred on twice while
// that holder still runs. Both live in the state dir, so the branch state store carries them.
//
// A holder is live while its pid (the supervisor's) runs or supervisor-adopted.json vouches for
// it (locks.mjs aliveIn, the default isAlive here): after a restart on new code the sessions
// still running keep their file locks under the old supervisor's pid, the new supervisor lets
// them go as each session ends (releaseToken, under any pid it owns), and nothing else may
// break them meanwhile.
//
// Paths are relative to the repository root. Files every story touches are never claimed:
// config.fileLocks.ignore (globs, glob.mjs) and every config.generated path (claimable).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { matchesGlob } from './glob.mjs';
import { aliveIn, breakIfStale, claims, forceSet, holderOf, RESOURCE, take } from './locks.mjs';
import { PLAN_FILE } from './plan-file.mjs';
import { byPriority } from './pick.mjs';

const hashOf = (path) => createHash('sha256').update(path).digest('hex').slice(0, 16);

export const FILE_LOCK = (dir, path) => join(dir, 'locks', `file-${hashOf(path)}.json`);
export const RESERVE = (dir, path) => join(dir, 'locks', `reserve-${hashOf(path)}.json`);
// How long a freed file is kept for the story waiting on it. A constant, not a setting.
export const RESERVE_MS = 30 * 60_000;
export const WAIT = (dir, id) => join(dir, 'waits', `${id}.json`);

const trimSlash = (p) => (p.length > 1 ? p.replace(/\/+$/, '') : p);

// { files, dropped }: `files` relative to the repository root, sorted and without duplicates.
// `tops` are absolute repository roots (the slot's checkout, the project); an absolute path
// under one becomes relative to it. Anything else that cannot name a file in the repository
// (not a string, empty, the root itself, `..` out of it, absolute outside every top) goes to
// `dropped` as given. An entry ending in '/' names a folder, which a file lock cannot hold, so
// it is dropped too: it shows in `dropped` instead of quietly matching nothing.
export function normaliseFiles(list, tops = []) {
  const roots = [...new Set(tops.filter((t) => typeof t === 'string' && posix.isAbsolute(t)).map((t) => trimSlash(posix.normalize(t))))].sort((a, b) => b.length - a.length);
  const files = new Set();
  const dropped = [];
  for (const item of Array.isArray(list) ? list : []) {
    let p = typeof item === 'string' ? item.trim() : '';
    if (p.endsWith('/')) {
      dropped.push(item);
      continue;
    }
    if (p && posix.isAbsolute(p)) {
      const abs = posix.normalize(p);
      const top = roots.find((t) => abs.startsWith(`${t}/`));
      p = top ? abs.slice(top.length + 1) : '';
    }
    p = p && trimSlash(posix.normalize(p));
    if (!p || p === '.' || p === '..' || p.startsWith('../') || posix.isAbsolute(p)) dropped.push(item);
    else files.add(p);
  }
  return { files: [...files].sort(), dropped };
}

// The files a story claims: all but those matching config.fileLocks.ignore or equal to a
// config.generated path.
export function claimable(files, config) {
  const ignore = Array.isArray(config?.fileLocks?.ignore) ? config.fileLocks.ignore.filter((g) => typeof g === 'string' && g) : [];
  const generated = new Set((Array.isArray(config?.generated) ? config.generated : []).map((g) => g?.path).filter((p) => typeof p === 'string' && p).map((p) => trimSlash(posix.normalize(p))));
  return files.filter((f) => !generated.has(f) && !ignore.some((g) => matchesGlob(f, g)));
}

const live = (h) => Boolean(h && !h.stale);

// Claims `files` for story `id` in slot me.slot (me = { pid, slot }). A file this slot already
// holds counts as claimed; one left by a supervisor that died is taken over. When another slot
// holds any file, the locks this call took are let go again and the holders come back as
// conflicts: [{ story, slot, files }], one per holder story, sorted. A free file that is kept for
// another story (reservationOf) is refused the same way: it joins that story's conflict with
// slot null and `reserved: true`, or just its files when the story also holds one.
export function takeFiles(dir, { id, files, me, now = new Date(), isAlive = aliveIn(dir) }) {
  const holder = (path) => ({ pid: me.pid, slot: me.slot, story: id, by: 'factory', at: now.toISOString(), path });
  const taken = [];
  const held = new Map(); // story -> { story, slot, files, reserved? }
  const hold = (story, slot, path, reserved) => {
    const c = held.get(story);
    if (!c) held.set(story, { story, slot, files: [path], ...(reserved ? { reserved: true } : {}) });
    else {
      c.files.push(path);
      if (!reserved && c.reserved) {
        delete c.reserved;
        c.slot = slot;
      }
    }
  };
  for (const path of files) {
    const file = FILE_LOCK(dir, path);
    const h = holderOf(file, isAlive);
    if (h && h.slot === me.slot && (h.pid === me.pid || h.stale)) {
      if (h.stale) forceSet(file, holder(path));
      continue;
    }
    if (!live(h)) {
      const kept = reservationOf(dir, path, now);
      if (kept && kept.story !== id) {
        hold(kept.story, null, path, true);
        continue;
      }
    }
    if (h?.stale) breakIfStale(file, isAlive);
    let r = take(file, holder(path), isAlive);
    if (!r.ok && r.stale) {
      breakIfStale(file, isAlive);
      r = take(file, holder(path), isAlive);
    }
    if (r.ok) {
      taken.push(file);
      continue;
    }
    hold(r.holder?.story ?? '?', r.holder?.slot ?? null, path, false);
  }
  if (held.size === 0) return { ok: true, files };
  for (const file of taken) rmSync(file, { force: true });
  const conflicts = [...held.values()].sort((a, b) => a.story.localeCompare(b.story)).map((c) => ({ ...c, files: [...c.files].sort() }));
  return { ok: false, conflicts };
}

// True when slot holds every file now (a live holder in that slot). No files: true.
export function holdsFiles(dir, files, slot, isAlive = aliveIn(dir)) {
  return files.every((f) => {
    const h = holderOf(FILE_LOCK(dir, f), isAlive);
    return live(h) && h.slot === slot;
  });
}

// The by-hand check: true when every file has a lock record naming this slot and this story.
// A by-hand lock names the exited `foreman lock files` pid, so liveness is ignored, but the
// record must exist and be this slot's and this story's. No files: true.
export function claimedFiles(dir, files, { slot, story }) {
  return files.every((f) => {
    const h = holderOf(FILE_LOCK(dir, f), () => true);
    return Boolean(h) && h.slot === slot && h.story === story;
  });
}

// The file lock files there are now.
export function fileLockFiles(dir) {
  const folder = join(dir, 'locks');
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((f) => f.startsWith('file-') && f.endsWith('.json'))
    .map((f) => join(folder, f));
}

// ── reservations ─────────────────────────────────────────────────────────────────────────

// The reservation on a path, or null: it must parse as an object with a story and an `until`
// after `now`. Nothing is deleted here.
export function reservationOf(dir, path, now = new Date()) {
  const r = readJson(RESERVE(dir, path));
  if (!r || typeof r !== 'object' || Array.isArray(r) || typeof r.story !== 'string') return null;
  return Date.parse(r.until) > now.getTime() ? r : null;
}

function writeReservation(dir, path, story, from, now) {
  const file = RESERVE(dir, path);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify({ path, story, from, at: now.toISOString(), until: new Date(now.getTime() + RESERVE_MS).toISOString() }));
  renameSync(tmp, file);
}

const reserveFilesIn = (dir) => {
  try {
    return readdirSync(join(dir, 'locks'))
      .filter((f) => f.startsWith('reserve-') && f.endsWith('.json'))
      .map((f) => join(dir, 'locks', f));
  } catch {
    return [];
  }
};

// Removes every reserve file that has run out, or cannot be read.
function pruneReservations(dir, now) {
  for (const file of reserveFilesIn(dir)) {
    const r = readJson(file);
    if (!r || typeof r !== 'object' || Array.isArray(r) || !(Date.parse(r.until) > now.getTime())) rmSync(file, { force: true });
  }
}

// Removes the reservations kept for `story` and returns their file paths.
export function dropReservations(dir, story) {
  const dropped = [];
  for (const file of reserveFilesIn(dir)) {
    if (readJson(file)?.story !== story) continue;
    rmSync(file, { force: true });
    dropped.push(file);
  }
  return dropped;
}

// The files the wait record lists.
const recordFiles = (dir, id) => {
  const record = readRecord(dir, id);
  return Array.isArray(record?.files) ? record.files.filter((f) => typeof f === 'string') : [];
};

// The files the wait record lists and the files it needs (older records have no `needs`), sorted
// and without repeats.
const recordNeeds = (dir, id) => {
  const needs = readRecord(dir, id)?.needs;
  const own = Array.isArray(needs) ? needs.filter((f) => typeof f === 'string') : [];
  return [...new Set([...recordFiles(dir, id), ...own])].sort();
};

// The files the story's saved plan names, or [] when there is no readable plan.
const planFilesOf = (dir, id) => {
  const plan = readJson(PLAN_FILE(dir, id));
  return plan && typeof plan === 'object' && !Array.isArray(plan) ? normaliseFiles(plan.files, []).files : [];
};

// The files the story names: its wait record's (files and needs) and its saved plan's, sorted and
// without repeats.
export function namedFiles(dir, id) {
  return [...new Set([...recordNeeds(dir, id), ...planFilesOf(dir, id)])].sort();
}

// The id of the first waiter (story objects, best first) that ranks above `story` and whose wait
// record names a file `story` names (record or plan), or null: `story` gives way to it. Only the
// waiter's record counts, never its plan.
export function yieldsTo(dir, story, waiters) {
  const mine = namedFiles(dir, story.id);
  if (mine.length === 0) return null;
  for (const w of waiters) {
    if (w.id === story.id || byPriority(w, story) >= 0) continue;
    if (recordFiles(dir, w.id).some((f) => mine.includes(f))) return w.id;
  }
  return null;
}

// Keeps each freed file ([{ path, from }], `from` the story that let it go) for the first waiter
// (story objects, best first) that names it in its wait record, is held up by nobody but `from`,
// and does not itself give way to a higher waiter. Call it before the releaser's locks go.
// Returns [{ path, story }]. Reservations that ran out are removed first.
export function reserveFreed(dir, { freed, waiters, now = new Date(), isAlive = aliveIn(dir) }) {
  pruneReservations(dir, now);
  const kept = [];
  for (const { path, from } of freed) {
    const w = waiters.find(
      (c) => c.id !== from && recordFiles(dir, c.id).includes(path) && (waitOf(dir, c.id, isAlive, now)?.on ?? []).every((e) => e.story === from) && yieldsTo(dir, c, waiters) === null,
    );
    if (!w) continue;
    writeReservation(dir, path, w.id, from, now);
    kept.push({ path, story: w.id });
  }
  return kept;
}

// A story is starting: keeps the files its wait record names that nobody holds or has reserved.
export function reserveForStart(dir, id, { now = new Date(), isAlive = aliveIn(dir) } = {}) {
  for (const path of recordFiles(dir, id)) {
    if (live(holderOf(FILE_LOCK(dir, path), isAlive)) || reservationOf(dir, path, now)) continue;
    writeReservation(dir, path, id, null, now);
  }
}

// The one-line event for files kept for a story.
export function reserveText(story, files) {
  return `Kept ${fileList(files)} for ${story}, the highest-priority story waiting on ${files.length === 1 ? 'it' : 'them'}.`;
}

// ── waits ────────────────────────────────────────────────────────────────────────────────

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

// The wait record as an object, or null when it is missing, unreadable or not an object.
const readRecord = (dir, id) => {
  const record = readJson(WAIT(dir, id));
  return record && typeof record === 'object' && !Array.isArray(record) ? record : null;
};

// Only the own entries whose value is a positive integer.
const counts = (v) => {
  const out = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, n] of Object.entries(v)) if (Number.isInteger(n) && n > 0) out[k] = n;
  }
  return out;
};

const writeRecord = (dir, id, record) => {
  const file = WAIT(dir, id);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify(record));
  renameSync(tmp, file);
};

// `needs` (optional) are the files the story's plan claims; the record keeps them so the picker
// leaves the story out while any running story holds or plans to change one.
export function writeWait(dir, id, conflicts, now = new Date(), needs) {
  const deferrals = counts(readRecord(dir, id)?.deferrals);
  for (const c of conflicts) deferrals[c.story] = (deferrals[c.story] ?? 0) + 1;
  const wanted = Array.isArray(needs) ? { needs: [...new Set(needs.filter((f) => typeof f === 'string'))].sort() } : {};
  writeRecord(dir, id, { story: id, on: conflicts.map((c) => c.story), files: [...new Set(conflicts.flatMap((c) => c.files))].sort(), ...wanted, at: now.toISOString(), deferrals });
}

export function clearWait(dir, id) {
  rmSync(WAIT(dir, id), { force: true });
}

// The ids of the stories that are running: a live factory claim, or a live file lock that names
// them. An owner's claim does not count.
function runningIds(dir, isAlive) {
  const ids = new Set(claims(dir, isAlive).filter((c) => c.by === 'factory' && !c.stale).map((c) => c.id));
  for (const file of fileLockFiles(dir)) {
    const h = holderOf(file, isAlive);
    if (live(h) && typeof h.story === 'string') ids.add(h.story);
  }
  return ids;
}

// True when the story is running (see runningIds).
const running = (dir, story, isAlive) => runningIds(dir, isAlive).has(story);

const SAFE_RESOURCE = /^[A-Za-z0-9._-]+$/;

// Why a story is kept out of the picker now, or null: { id, on: [{ story, files, resources,
// deferrals }], text }, `on` sorted by story id. These count:
//   - a file named by the wait record or the saved plan that a running story holds
//   - a resource named by the saved plan that a running story holds
//   - a story the record says it was deferred on twice or more, while that story still runs
//   - a free file named by either, kept at `now` for another story (reservationOf): the entry is
//     that story's, with the file under `kept` (the key is there only when something is kept)
//   - a file the wait record names (files or needs), free and not kept for anyone, that a running
//     story's saved plan names: the entry is that running story's
export function waitOf(dir, id, isAlive = aliveIn(dir), now = new Date()) {
  const record = readRecord(dir, id);
  const plan = readJson(PLAN_FILE(dir, id));
  const planObject = plan && typeof plan === 'object' && !Array.isArray(plan) ? plan : {};
  const files = namedFiles(dir, id);
  const recorded = recordNeeds(dir, id);
  let plans = null; // running story -> its plan's files, read once and only when needed
  const entries = new Map();
  const kept = new Map(); // story -> files kept for it
  const entry = (story) => {
    if (!entries.has(story)) entries.set(story, { story, files: [], resources: [], deferrals: 0 });
    return entries.get(story);
  };
  for (const f of files) {
    const h = holderOf(FILE_LOCK(dir, f), isAlive);
    if (live(h)) {
      if (h.story !== id) entry(h.story ?? '?').files.push(f);
      continue;
    }
    const reserved = reservationOf(dir, f, now);
    if (reserved && reserved.story !== id) {
      entry(reserved.story);
      kept.set(reserved.story, [...(kept.get(reserved.story) ?? []), f]);
      continue;
    }
    if (reserved || !recorded.includes(f)) continue;
    plans ??= new Map([...runningIds(dir, isAlive)].filter((r) => r !== id).map((r) => [r, planFilesOf(dir, r)]));
    for (const [r, planned] of plans) if (planned.includes(f)) entry(r).files.push(f);
  }
  const resources = Array.isArray(planObject.resources) ? planObject.resources.filter((r) => typeof r === 'string' && SAFE_RESOURCE.test(r) && r !== '.' && r !== '..') : [];
  for (const name of [...new Set(resources)].sort()) {
    const h = holderOf(RESOURCE(dir, name), isAlive);
    if (live(h) && h.story !== id) entry(h.story ?? '?').resources.push(name);
  }
  const deferrals = counts(record?.deferrals);
  for (const [h, n] of Object.entries(deferrals)) {
    if (n >= 2 && h !== id && running(dir, h, isAlive)) entry(h);
  }
  if (entries.size === 0) return null;
  const on = [...entries.values()].sort((a, b) => a.story.localeCompare(b.story)).map((e) => ({ ...e, ...(kept.has(e.story) ? { kept: kept.get(e.story) } : {}), deferrals: deferrals[e.story] ?? 0 }));
  const items = (e) => [...e.files, ...e.resources, ...(e.kept ?? []).map((f) => `${f} (kept for it)`)];
  const twice = (e) => (e.deferrals === 2 ? 'twice' : `${e.deferrals} times`);
  let text;
  if (on.length === 1) {
    const [e] = on;
    text = items(e).length ? `${id} waits for ${e.story}: ${fileList(items(e))}` : `${id} waits for ${e.story} to ship or end: deferred on it ${twice(e)}`;
  } else {
    text = `${id} waits for ${joined(on.map((e) => (items(e).length ? `${e.story} (${fileList(items(e))})` : `${e.story} (deferred on it ${twice(e)})`)))}`;
  }
  return { id, on, text: text.length <= MAX_REASON ? text : `${text.slice(0, MAX_REASON - 1)}…` };
}

// True while the story is kept out of the picker (see waitOf).
export function waitBlocks(dir, id, isAlive = aliveIn(dir), now = new Date()) {
  return waitOf(dir, id, isAlive, now) !== null;
}

// True when the story has a wait record that names files.
export function waitsOnFiles(dir, id) {
  const record = readRecord(dir, id);
  return Array.isArray(record?.files) && record.files.length > 0;
}

// The wait is spent when the story is started: its files were free. The count of a holder that
// still runs stays, so a second deferral on it is counted; the rest goes.
export function spendWait(dir, id, isAlive = aliveIn(dir)) {
  const record = readRecord(dir, id);
  if (!record) return;
  const kept = {};
  for (const [h, n] of Object.entries(counts(record.deferrals))) if (running(dir, h, isAlive)) kept[h] = n;
  if (Object.keys(kept).length === 0) clearWait(dir, id);
  else writeRecord(dir, id, { story: id, on: [], files: [], at: record.at, deferrals: kept });
}

// The names (without .json) of the JSON files in a folder of the state dir.
const jsonNames = (folder) => {
  try {
    return readdirSync(folder)
      .filter((f) => f.endsWith('.json') && f.length > 5)
      .map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
};

// Every story that waits on running stories now, sorted by id: [{ id, on, text }]. With `stories`
// (the source's list, { id, status }), saved plans count too and only listed, unfinished
// stories show. A story with a live claim, running or the owner's, is not waiting.
export function fileWaits(dir, { stories = null, isAlive = aliveIn(dir), now = new Date() } = {}) {
  const ids = new Set(jsonNames(join(dir, 'waits')));
  if (Array.isArray(stories)) for (const id of jsonNames(join(dir, 'plans'))) ids.add(id);
  const claimed = new Set(claims(dir, isAlive).map((c) => c.id));
  const open = Array.isArray(stories) ? new Map(stories.filter((s) => s && s.status !== 'done').map((s) => [s.id, s])) : null;
  return [...ids]
    .sort()
    .filter((id) => !claimed.has(id) && (!open || open.has(id)))
    .map((id) => waitOf(dir, id, isAlive, now))
    .filter(Boolean)
    .map(({ id, on, text }) => ({ id, on, text }));
}

// The wait of the story that ranks first by priority (byPriority) among fileWaits, or null.
export function topFileWait(dir, { stories = null, isAlive = aliveIn(dir), now = new Date() } = {}) {
  if (!Array.isArray(stories)) return null;
  const byId = new Map(stories.map((s) => [s.id, s]));
  const ranked = fileWaits(dir, { stories, isAlive, now })
    .filter((w) => byId.has(w.id))
    .sort((a, b) => byPriority(byId.get(a.id), byId.get(b.id)));
  return ranked[0] ?? null;
}

// ── the reason ───────────────────────────────────────────────────────────────────────────

const MAX_REASON = 200;
// "a", "a and b", "a, b and c"; past 3, "a, b, c and 2 more".
const fileList = (files) => {
  if (files.length > 3) return `${files.slice(0, 3).join(', ')} and ${files.length - 3} more`;
  return files.length === 1 ? files[0] : `${files.slice(0, -1).join(', ')} and ${files.at(-1)}`;
};
const joined = (parts) => (parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`);

// The one-line reason a deferred story shows, at most 200 characters.
export function waitReason(conflicts) {
  if (!conflicts.length) return '';
  const reserved = conflicts.some((c) => c.reserved);
  let text;
  if (conflicts.length === 1) {
    const [c] = conflicts;
    text = c.reserved ? `waiting for ${c.story} to start: ${fileList(c.files)} ${c.files.length === 1 ? 'is' : 'are'} kept for it` : `waiting for ${c.story} to ship: it is changing ${fileList(c.files)}`;
  } else {
    text = `waiting for ${joined(conflicts.map((c) => `${c.story} (${fileList(c.files)}${c.reserved ? ' kept for it' : ''})`))}${reserved ? '' : ' to ship'}`;
  }
  return text.length <= MAX_REASON ? text : `${text.slice(0, MAX_REASON - 1)}…`;
}
