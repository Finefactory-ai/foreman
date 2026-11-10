// Who holds what, when the factory runs several slots at once. Each claim or lock is one
// small JSON file in the state dir (.factory/ by default):
//
//   claims/<ID>.json     which slot is building a story, or that the owner has taken it
//   locks/resource-<name>.json  an exclusive resource: only its holder may build a story that
//                        touches it. The schema token (the resource `schema`) keeps the old
//                        factory's locks/schema.json, so a project can move to Foreman and back
//                        with a live token. Earlier Foreman runs used locks/resource-schema.json.
//   locks/ship.json      the ship lock: one release at a time, with the stage it reached
//   locks/release-watch.json
//                        one release watch at a time (foreman release watch, lib/cli/commands/release.mjs)
//
// A file holds { pid, slot, story, by, at, stage? }. It is created with an exclusive create,
// so two slots can never both take it. It is stale when its pid (the supervisor's) is gone,
// unless supervisor-adopted.json vouches for it: after a restart on new code the sessions still
// running hold their locks under the pid of the supervisor that started them, and that file
// (supervisor-pid.mjs) lists those pids while a live process stands behind them. Every function
// here that takes an isAlive uses that check (aliveIn) by default; an explicit isAlive replaces
// it. An owner claim has no pid and never goes stale, but the supervisor removes one whose story
// is done, retired or gone from the source (dropOwnerClaim, scheduler.mjs settledOwnerClaims). A stale lock is reported, not discarded;
// the supervisor decides what to do with it at start-up (reconcile.mjs). letGoClaim removes a
// factory claim the supervisor's own pids hold, or a stale one, and never an owner claim; it
// re-reads the claim just before removing it and removes it only if it is still the claim it
// judged. The supervisor uses it while it runs for a claim whose slot moved on (scheduler.mjs
// looseClaims).
//
// The CLI is for the foreman and ship.mjs. The holder's pid is FOREMAN_SUPERVISOR_PID and
// its slot is FOREMAN_SLOT, both set by the supervisor for each slot.
//
//   node lib/engine/locks.mjs schema-held         exit 0 when this slot holds the schema token
//   node lib/engine/locks.mjs schema-take <ID>    exit 0 when taken now or already held by this slot
//   node lib/engine/locks.mjs owner-claim <ID>    hand the story to the owner ("I'll take it")

import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { adoptedAlive } from './supervisor-pid.mjs';
import { listNames, readText } from './read-cache.mjs';

export const claimFile = (dir, id) => join(dir, 'claims', `${id}.json`);
export const RESOURCE = (dir, name) => join(dir, 'locks', name === 'schema' ? 'schema.json' : `resource-${name}.json`);
// The schema token is the resource named "schema". Kept for existing callers.
export const SCHEMA = (dir) => RESOURCE(dir, 'schema');
// Where earlier Foreman runs kept the schema token.
const LEGACY_SCHEMA = (dir) => join(dir, 'locks', 'resource-schema.json');
export const SHIP = (dir) => join(dir, 'locks', 'ship.json');

// Earlier Foreman runs kept the schema token in locks/resource-schema.json. Move it back to
// locks/schema.json so a live lock carries over. Never overwrites a lock already there.
export function adoptLegacySchemaLock(dir) {
  const from = LEGACY_SCHEMA(dir);
  const to = SCHEMA(dir);
  if (!existsSync(from) || existsSync(to)) return false;
  try {
    renameSync(from, to);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

// Is this process still running? EPERM means it runs as someone else, so it is alive.
// A null pid is an owner claim, which never goes stale.
export const alive = (pid) => {
  if (pid === null || pid === undefined) return true;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

// alive, or vouched for by the state folder's supervisor-adopted.json.
export const aliveIn = (dir) => (pid) => alive(pid) || (pid !== null && pid !== undefined && adoptedAlive(dir, pid));
// The state folder of a lock file: every one is <dir>/claims/x.json or <dir>/locks/x.json.
const aliveFor = (file) => aliveIn(dirname(dirname(file)));

const UNREADABLE = Symbol('unreadable');

// null when there is no file, UNREADABLE when it is not a JSON object.
const read = (file) => {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  return parse(text);
};

const parse = (text) => {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : UNREADABLE;
  } catch {
    return UNREADABLE;
  }
};

const tempFor = (file) => `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;

// Replace a file through a temp file so a reader never sees half of it.
const replace = (file, value) => {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = tempFor(file);
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, file);
};

export function holderOf(file, isAlive = aliveFor(file)) {
  const value = read(file);
  if (value === null) return null;
  if (value === UNREADABLE) return { stale: true };
  return { ...value, stale: !isAlive(value.pid ?? null) };
}

// Exclusive create. The holder is written to a temp file first and then hard-linked into
// place: link fails when the name exists (like open with 'wx'), and a reader never sees an
// empty lock it could mistake for a damaged, stale one.
export function take(file, holder, isAlive = aliveFor(file)) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = tempFor(file);
  writeFileSync(tmp, JSON.stringify(holder));
  try {
    linkSync(tmp, file);
    return { ok: true, holder };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const existing = holderOf(file, isAlive);
    if (existing === null) return take(file, holder, isAlive); // released in between
    const rest = { ...existing };
    delete rest.stale;
    return { ok: false, holder: 'pid' in rest ? rest : null, stale: existing.stale };
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function release(file, pid) {
  const value = read(file);
  if (value === null || value === UNREADABLE || value.pid !== pid) return false;
  rmSync(file, { force: true });
  return true;
}

export function breakIfStale(file, isAlive = aliveFor(file)) {
  const existing = holderOf(file, isAlive);
  if (!existing?.stale) return null;
  rmSync(file, { force: true });
  const old = { ...existing };
  delete old.stale;
  return old;
}

export function forceSet(file, holder) {
  replace(file, holder);
}

export function setStage(file, pid, stage) {
  const value = read(file);
  if (value === null || value === UNREADABLE || value.pid !== pid) return false;
  replace(file, { ...value, stage });
  return true;
}

// Read through the cache (read-cache.mjs): the folder and each file are read again only when they
// changed. `stale` is worked out here on every call, never kept, because a pid can exit while
// the file stays as it is. The reads that decide a write (holderOf, take, release, ...) do not
// use the cache.
export function claims(dir, isAlive = aliveIn(dir)) {
  const folder = join(dir, 'claims');
  return listNames(folder)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .sort()
    .map((id) => {
      const text = readText(claimFile(dir, id));
      if (text === null) return null;
      const value = parse(text);
      if (value === UNREADABLE) return { id, stale: true };
      return { id, ...value, stale: !isAlive(value.pid ?? null) };
    })
    .filter(Boolean);
}

// The same claim as the one read before? An unreadable file matches only an unreadable one.
const sameHolder = (a, b) => {
  if (a === UNREADABLE) return b === UNREADABLE;
  return b !== null && b !== UNREADABLE && b.pid === a.pid && b.by === a.by && b.slot === a.slot && b.at === a.at;
};

// Lets go of a story's factory claim when `own` (a Set of supervisor pids) holds it or it is
// stale. Returns the holder it removed (an unreadable file gives {}), or null. Never an owner
// claim, nor one another live pid holds. A file that is JSON without a pid counts as a live
// claim of no one, so it stays. The claim is read again just before it is removed, and removed
// only if it is still the one judged: an owner claim or a new factory claim put there in
// between stays.
export function letGoClaim(dir, id, own, isAlive = aliveIn(dir)) {
  const file = claimFile(dir, id);
  const first = read(file);
  if (first === null) return null;
  if (first !== UNREADABLE) {
    if (first.by !== 'factory') return null;
    if (!own.has(first.pid) && isAlive(first.pid ?? null)) return null;
  }
  if (!sameHolder(first, read(file))) return null;
  rmSync(file, { force: true });
  return first === UNREADABLE ? {} : { ...first };
}

// Removes the owner's claim on a story, but only the one taken at `at`: a claim the owner took
// again in between stays. Returns the holder it removed, or null (no file, an unreadable file,
// a factory claim, another `at`). The claim is read again just before it is removed.
export function dropOwnerClaim(dir, id, at) {
  const file = claimFile(dir, id);
  const first = read(file);
  if (first === null || first === UNREADABLE || first.by !== 'owner' || first.at !== at) return null;
  if (!sameHolder(first, read(file))) return null;
  rmSync(file, { force: true });
  return { ...first };
}

// "I'll take it": the story passes to the owner, whoever held it, until it is handed back.
export function ownerClaim(dir, id, now = new Date()) {
  const holder = { pid: null, slot: null, story: id, by: 'owner', at: now.toISOString() };
  forceSet(claimFile(dir, id), holder);
  return holder;
}

// me = { pid, slot }: the supervisor's pid and this slot's id.
export function holdsSchema(dir, me, isAlive = aliveIn(dir)) {
  const holder = holderOf(SCHEMA(dir), isAlive);
  return Boolean(holder && !holder.stale && holder.by === 'factory' && holder.pid === me.pid && holder.slot === me.slot);
}

export function takeSchema(dir, id, me, now = new Date(), isAlive = aliveIn(dir)) {
  if (holdsSchema(dir, me, isAlive)) return true;
  return take(SCHEMA(dir), { pid: me.pid, slot: me.slot, story: id, by: 'factory', at: now.toISOString() }, isAlive).ok;
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────

// state.mjs is imported here, not at the top: state.mjs's own CLI imports this file, and a
// static import both ways deadlocks that CLI's top-level await.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { DIR } = await import('./state.mjs');
  const [cmd, id] = process.argv.slice(2);
  const pid = Number(process.env.FOREMAN_SUPERVISOR_PID);
  const me = { pid: Number.isInteger(pid) && pid > 0 ? pid : null, slot: process.env.FOREMAN_SLOT || null };
  adoptLegacySchemaLock(DIR);
  const validId = typeof id === 'string' && /^P\d+[a-z]?-[A-Za-z0-9-]+$/.test(id);
  try {
    if (cmd === 'schema-held') process.exit(holdsSchema(DIR, me) ? 0 : 1);
    else if (cmd === 'schema-take' && validId) process.exit(takeSchema(DIR, id, me) ? 0 : 1);
    else if (cmd === 'owner-claim' && validId) ownerClaim(DIR, id);
    else {
      console.error('usage: locks.mjs schema-held | schema-take <ID> | owner-claim <ID>');
      process.exit(2);
    }
  } catch (err) {
    console.error(`locks.mjs: ${err.message}`);
    process.exit(1);
  }
}

// True when `slot` holds the resource `name` right now (a live holder in that slot).
export function holdsResource(dir, name, slot, isAlive = aliveIn(dir)) {
  const holder = holderOf(RESOURCE(dir, name), isAlive);
  return Boolean(holder && !holder.stale && holder.slot === slot);
}
