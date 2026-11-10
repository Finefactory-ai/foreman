// What the project's pack adds to every story session. The supervisor calls
// preparePackSessions once at start, before any session; a refusal stops the run. It asks the
// pack's prepareSessions hook (plugin/packs/index.mjs says what it returns) and accepts only a
// session session.command can use as given: string values in `env`, absolute folders in
// `pathPrefix`, and a plain object in `settings`. Anything else is a refusal, never trimmed.
//
//   { ok: true, session: null }                     no pack, or a pack without the hook
//   { ok: true, session: { env, pathPrefix, settings } }
//   { ok: false, reason }                           the hook refused, threw, gave an unusable
//                                                   session, or the pack is unknown

import { spawnSync } from 'node:child_process';
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PACKS, packFor } from '../../packs/index.mjs';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPlain = (v) => isObject(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const message = (err) => err?.message ?? String(err);

// spawnSync with piped output, honouring the caller's env, cwd and timeout.
function realSh(cmd, args = [], opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.timeout ? { timeout: opts.timeout } : {}),
  });
  const stderr = r.error ? `${r.stderr ?? ''} ${r.error.code ?? ''} ${message(r.error)}` : r.stderr ?? '';
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr };
}

// The session as session.command takes it, or the reason it cannot be used. Nothing is dropped:
// a session Foreman would have to weaken (a relative PATH folder, a non-string env value) stops
// the run instead, so a broken hook can never quietly turn isolation off.
function clean(session) {
  if (session === null || session === undefined) return { session: null };
  if (!isObject(session)) return { why: 'the session is not an object' };
  const { env = {}, pathPrefix = [], settings = {} } = session;
  if (!isObject(env)) return { why: 'env is not an object' };
  for (const [key, value] of Object.entries(env)) if (typeof value !== 'string') return { why: `env.${key} is not a string` };
  if (!Array.isArray(pathPrefix)) return { why: 'pathPrefix is not a list' };
  for (const p of pathPrefix) if (typeof p !== 'string' || !path.isAbsolute(p)) return { why: `pathPrefix entry ${String(p)} is not an absolute path` };
  if (!isPlain(settings)) return { why: 'settings is not a plain object' };
  return { session: { env: { ...env }, pathPrefix: [...pathPrefix], settings } };
}

export function preparePackSessions({ config, env = process.env, packs = PACKS, fs = nodeFs, sh = realSh, homedir = os.homedir() }) {
  let pack;
  try {
    pack = packFor(config, packs);
  } catch (err) {
    return { ok: false, reason: `pack ${config?.pack}: ${message(err)}` };
  }
  if (!pack || typeof pack.prepareSessions !== 'function') return { ok: true, session: null };
  let r;
  try {
    r = pack.prepareSessions({ config, env, fs, sh, homedir });
  } catch (err) {
    return { ok: false, reason: `pack ${pack.name}: ${message(err)}` };
  }
  if (!isObject(r) || typeof r.ok !== 'boolean') return { ok: false, reason: `pack ${pack.name}: prepareSessions gave no verdict` };
  if (!r.ok) return { ok: false, reason: typeof r.reason === 'string' && r.reason ? r.reason : `pack ${pack.name}: refused, with no reason` };
  const c = clean(r.session);
  if (c.why) return { ok: false, reason: `pack ${pack.name}: prepareSessions gave a session Foreman cannot use: ${c.why}` };
  return { ok: true, session: c.session };
}
