// The only writer of keys to env files. Foreman's own keys (engine/foreman-keys.mjs) live in
// config `foremanEnvFile` (.env.foreman), any other key in the project's `envFile`
// (.env.local). Every write goes through a temp file with a random name in the same folder and
// a rename (engine/env-text.mjs), leaves the file at mode 600, and keeps the file's other lines
// and comments. No value ever leaves this file, except through secretValue.
//
// ctx = { root, config, env = process.env, sh, fs, lockFile?, lockWaitMs = 5000 }
//
//   fileFor(name, config)              the file for a name, relative to root
//   mask(value)                        '•••• ' and the last 4 characters for a value of 24 or
//                                      more, else 'set'
//   keyState(names, ctx) -> [{ name, set, masked, source }]
//                                      source 'environment' when the process environment has it
//                                      (Foreman cannot change it then), 'file', or null; never a
//                                      value
//   writeKeys(file, values, { remove, fs }) -> { written, removed, refused }
//                                      the shared primitive: synchronous, no lock, no git check;
//                                      a symlinked file stays a link; writes nothing when there
//                                      is nothing to write or remove
//   setKey(name, value, ctx) -> { file }
//                                      throws one plain line, never the value: a bad name, a
//                                      name set in the environment (code 'environment'), an
//                                      empty value, a value no quoting keeps intact, a file git
//                                      does not ignore (code 'not-ignored', with err.fix), a
//                                      file git already tracks (code 'tracked', from
//                                      foreman-keys.mjs isTracked; no fix is offered), or a
//                                      file that links to one git could commit (code
//                                      'link-not-ignored', with no fix: the target may be in
//                                      another repo)
//   removeKey(name, ctx) -> { file, removed }
//   checkName(name)                    throws for a name that is not a key name, or that looks
//                                      like a key's value (secrets/redact.mjs would blank it);
//                                      neither message holds the name
//   changeable(name, env)              throws as setKey does for a bad name or a name set in
//                                      the environment, so a command can stop before it asks
//                                      for the value
//   ignoreKeyFile(name, ctx) -> 'added' | 'ignored'
//                                      the fix for 'not-ignored': adds the file to .gitignore
//   secretValue(name, ctx)             the value from the environment, else the file, else
//                                      null. For the key tests only: it must never be printed or
//                                      returned by a command or an endpoint.
//
// One writer at a time: in this process, calls for the same file run one after another; across
// processes, each write holds the lock <stateDir>/locks/keys.json (engine/locks.mjs), waits
// for a live holder up to lockWaitMs and breaks a stale one. Inside the lock the file is read
// again, so a write never loses another one.

import nodeFs from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { keptLines, parseEnvFile, serialize, writeSecretFile } from '../engine/env-text.mjs';
import { addIgnoreLine, foremanEnvName, isForemanKey, isIgnored, isTracked, linkedTargetSafe, projectEnvName } from '../engine/foreman-keys.mjs';
import { breakIfStale, release, take } from '../engine/locks.mjs';
import { stateDir } from '../engine/paths.mjs';
import { redact } from './redact.mjs';

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LOCK_RETRY_MS = 50;

const isSet = (v) => typeof v === 'string' && v !== '';

export const fileFor = (name, config) => (isForemanKey(name) ? foremanEnvName(config) : projectEnvName(config));

export const mask = (value) => (value.length >= 24 ? `•••• ${value.slice(-4)}` : 'set');

export function keyState(names, { root, config, env = process.env, fs = nodeFs }) {
  const files = new Map();
  const fileValues = (rel) => {
    if (!files.has(rel)) files.set(rel, parseEnvFile(join(root, rel), fs));
    return files.get(rel);
  };
  return names.map((name) => {
    let value = null;
    let source = null;
    if (isSet(env?.[name])) {
      value = env[name];
      source = 'environment';
    } else if (isSet(fileValues(fileFor(name, config))[name])) {
      value = fileValues(fileFor(name, config))[name];
      source = 'file';
    }
    return { name, set: value !== null, masked: value === null ? null : mask(value), source };
  });
}

export function secretValue(name, { root, config, env = process.env, fs = nodeFs }) {
  if (isSet(env?.[name])) return env[name];
  const value = parseEnvFile(join(root, fileFor(name, config)), fs)[name];
  return isSet(value) ? value : null;
}

const realPath = (file, fs) => {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
};

const readText = (file, fs) => (fs.existsSync(file) ? String(fs.readFileSync(file, 'utf8')) : '');

export function writeKeys(file, values, { remove = [], fs = nodeFs } = {}) {
  const real = realPath(file, fs);
  const old = readText(real, fs);
  const had = old ? parseEnv(old) : {};
  const written = [];
  const refused = [];
  const lines = [];
  for (const [name, value] of Object.entries(values)) {
    const line = serialize(name, value);
    if (line === null) refused.push(name);
    else {
      written.push(name);
      lines.push(line);
    }
  }
  const removed = remove.filter((name) => Object.hasOwn(had, name) && !written.includes(name));
  if (!written.length && !removed.length) return { written, removed, refused };
  const kept = [...keptLines(old, new Set([...written, ...removed])), ...lines];
  writeSecretFile(real, kept.length ? `${kept.join('\n')}\n` : '', 0o600, fs);
  return { written, removed, refused };
}

const failure = (message, extra = {}) => Object.assign(new Error(message), extra);

export function checkName(name) {
  if (typeof name !== 'string' || !NAME.test(name)) throw failure('that is not a key name: use letters, digits and _, not starting with a digit');
  if (redact(name) !== name) throw failure("that looks like a key's value, not its name: give the name only, and paste the value when asked");
}

export function changeable(name, env) {
  checkName(name);
  if (isSet(env?.[name])) throw failure(`${name} is set outside Foreman, in the environment, so Foreman cannot change it`, { code: 'environment' });
}

// ── one writer at a time ──────────────────────────────────────────────────────────────────

const queues = new Map();

function queued(file, job) {
  const next = (queues.get(file) ?? Promise.resolve()).then(job, job);
  const tail = next.catch(() => {});
  queues.set(file, tail);
  tail.then(() => {
    if (queues.get(file) === tail) queues.delete(file);
  });
  return next;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function locked({ root, config, lockFile, lockWaitMs = 5000 }, job) {
  const file = lockFile ?? join(stateDir(root, config, {}), 'locks', 'keys.json');
  const deadline = Date.now() + lockWaitMs;
  for (;;) {
    const r = take(file, { pid: process.pid, by: 'keys', at: new Date().toISOString() });
    if (r.ok) break;
    if (r.stale) {
      breakIfStale(file);
      continue;
    }
    if (Date.now() >= deadline) throw failure('another Foreman command is changing the keys; try again');
    await sleep(LOCK_RETRY_MS);
  }
  try {
    return job();
  } finally {
    release(file, process.pid);
  }
}

function change(ctx, rel, job) {
  const file = join(ctx.root, rel);
  return queued(file, () => locked(ctx, () => job(file)));
}

// ── the operations ────────────────────────────────────────────────────────────────────────

export async function setKey(name, value, ctx) {
  const { root, config, env = process.env, sh, fs = nodeFs } = ctx;
  changeable(name, env);
  if (!isSet(value)) throw failure(`${name} is empty`);
  if (serialize(name, value) === null) throw failure(`the value of ${name} cannot be written safely`);
  const rel = fileFor(name, config);
  if (isIgnored({ root, file: rel, sh }) !== 'ignored') {
    throw failure(`git does not ignore ${rel}, so nothing was written`, { code: 'not-ignored', fix: { action: 'add-to-gitignore', file: rel } });
  }
  if (isTracked({ root, file: rel, sh }) === 'tracked') {
    throw failure(`${rel} is tracked by git, so nothing was written; remove it from the index first (git rm --cached ${rel})`, { code: 'tracked' });
  }
  if (!linkedTargetSafe({ root, file: rel, sh, fs })) throw failure(`${rel} links to a file git could commit, so nothing was written`, { code: 'link-not-ignored' });
  await change(ctx, rel, (file) => {
    const r = writeKeys(file, { [name]: value }, { fs });
    if (r.refused.length) throw failure(`the value of ${name} cannot be written safely`);
  });
  return { file: rel };
}

export async function removeKey(name, ctx) {
  const { config, env = process.env, fs = nodeFs } = ctx;
  changeable(name, env);
  const rel = fileFor(name, config);
  const r = await change(ctx, rel, (file) => writeKeys(file, {}, { remove: [name], fs }));
  return { file: rel, removed: r.removed.length > 0 };
}

export function ignoreKeyFile(name, { root, config, sh, fs = nodeFs }) {
  const rel = fileFor(name, config);
  const state = isIgnored({ root, file: rel, sh });
  if (state === 'ignored') return 'ignored';
  const added = state === 'not-ignored' && addIgnoreLine(root, rel, fs);
  if (isIgnored({ root, file: rel, sh }) !== 'ignored') throw failure(`could not make git ignore ${rel}`);
  return added ? 'added' : 'ignored';
}
