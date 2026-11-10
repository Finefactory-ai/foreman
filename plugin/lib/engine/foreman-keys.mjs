// Foreman's own keys, and the file they live in. The project's env file (config `envFile`,
// .env.local by default) is linked into every slot worktree (worktree.mjs), so the builder,
// tester and reviewers can read it. Foreman's own keys go in config `foremanEnvFile`
// (.env.foreman by default) instead: kept out of git, mode 600, and never linked or copied
// into a slot. Everything that reads one of these names takes the process environment first,
// then this file, then the env file; no other name in this file is ever used.
//
//   FOREMAN_KEYS                     the names Foreman owns (frozen)
//   SESSION_KEYS                     the two a story session may take from the file
//   isForemanKey(name)
//   foremanEnvName(config), projectEnvName(config)
//                                    the configured file names, else the defaults
//   foremanEnvPath(root, config), projectEnvPath(root, config)
//   foremanFileKeys({ root, config, fs })
//                                    the registry names set in the foremanEnvFile
//   sessionKeys({ root, config, fs })
//                                    the SESSION_KEYS set in the foremanEnvFile; the env file is
//                                    never read for them
//   withSessionKeys(env, fileKeys)   a copy of env with the SESSION_KEYS from fileKeys filled
//                                    in where env has no value; no other name
//   foremanKeysIn(file, fs)          the registry names in a file, names only
//   loadForemanKeys({ root, config, target, names = FOREMAN_KEYS }) -> the names it set
//                                    for the commands that load the env file into their process:
//                                    sets each registry name in `names` from the foremanEnvFile
//                                    where target has none; reads the file whenever it is there,
//                                    and throws when it cannot, even when no name is wanted
//   isIgnored({ root, file, sh })    'ignored' | 'not-ignored' | 'unknown', from
//                                    `git check-ignore -q --no-index` (exit 0, 1, anything else)
//   linkedTargetSafe({ root, file, sh, fs }) -> boolean
//                                    whether the file a write to root/file really lands in is
//                                    safe from git: true when there is no file, no link, or the
//                                    link's target is outside any git work tree; false when the
//                                    target's own repo tracks it; else whether that repo
//                                    ignores it
//   isTracked({ root, file, sh })    'tracked' | 'untracked' | 'unknown', from
//                                    `git ls-files -- <file>` (exit 0 with or without output,
//                                    anything else); `--no-index` above cannot see the index, so
//                                    a file already committed still reads as ignored there
//   addIgnoreLine(root, entry, fs, ignoreFile = '.gitignore') -> added?
//                                    appends entry unless a line is already entry, /entry,
//                                    entry/ or /entry/
//   migrateKeys({ root, config, sh, fs }) -> { moved, alreadyThere, refused, ignore }
//                                    `foreman keys migrate`; names only, never a value
//
// migrateKeys makes git ignore the foremanEnvFile first (adding the .gitignore line when git
// says no) and moves nothing unless git then says yes, nor when git tracks the file. It builds
// both new files first and moves nothing unless parseEnv reads each back exactly as meant: the
// env file without the moved names and every other value unchanged, the foremanEnvFile with
// its old values and the moved ones. It writes the foremanEnvFile first
// (mode 600, its other lines kept), then the env file at its real path, so a symlinked
// .env.local stays a link, with its own mode and its other lines and comments. A name the
// foremanEnvFile already has keeps that value and is only removed from the env file; a value
// no quoting keeps intact stays where it is. When it has keys to move and the foremanEnvFile
// links to a file git could commit (linkedTargetSafe), it throws before writing either file.

import nodeFs from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseEnv } from 'node:util';
import { keptLines, parseEnvFile, serialize, writeSecretFile } from './env-text.mjs';

export const FOREMAN_KEYS = Object.freeze([
  'JIRA_CLIENT_ID',
  'JIRA_CLIENT_SECRET',
  'RESEND_API_KEY',
  'RESEND_FROM_EMAIL',
  'FOREMAN_NOTIFY_EMAIL',
  'FACTORY_NOTIFY_EMAIL',
  'FOREMAN_DASHBOARD_TOKEN',
  'GEARSET_API_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
]);

export const SESSION_KEYS = Object.freeze(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);

const REGISTRY = new Set(FOREMAN_KEYS);
export const isForemanKey = (name) => REGISTRY.has(name);

export const foremanEnvName = (config) => config?.foremanEnvFile ?? '.env.foreman';
export const projectEnvName = (config) => config?.envFile ?? '.env.local';
export const foremanEnvPath = (root, config) => join(root, foremanEnvName(config));
export const projectEnvPath = (root, config) => join(root, projectEnvName(config));

const isSet = (v) => typeof v === 'string' && v !== '';

// The names of `list` set in `values`, with their values.
const pick = (values, list) => {
  const out = {};
  for (const name of list) if (isSet(values[name])) out[name] = values[name];
  return out;
};

export function foremanFileKeys({ root, config, fs = nodeFs }) {
  return pick(parseEnvFile(foremanEnvPath(root, config), fs), FOREMAN_KEYS);
}

export function sessionKeys({ root, config, fs = nodeFs }) {
  return pick(parseEnvFile(foremanEnvPath(root, config), fs), SESSION_KEYS);
}

export function withSessionKeys(env, fileKeys = {}) {
  const out = { ...env };
  for (const name of SESSION_KEYS) if (!isSet(out[name]) && isSet(fileKeys?.[name])) out[name] = fileKeys[name];
  return out;
}

export function foremanKeysIn(file, fs = nodeFs) {
  const found = parseEnvFile(file, fs);
  return FOREMAN_KEYS.filter((name) => Object.hasOwn(found, name));
}

export function loadForemanKeys({ root, config, target = process.env, names = FOREMAN_KEYS }) {
  const file = foremanEnvPath(root, config);
  if (!nodeFs.existsSync(file)) return [];
  const values = parseEnv(nodeFs.readFileSync(file, 'utf8'));
  const wanted = FOREMAN_KEYS.filter((name) => names.includes(name));
  const set = [];
  for (const [name, value] of Object.entries(pick(values, wanted))) {
    if (isSet(target[name])) continue;
    target[name] = value;
    set.push(name);
  }
  return set;
}

export function isIgnored({ root, file, sh }) {
  const { status } = sh('git', ['check-ignore', '-q', '--no-index', file], { cwd: root });
  if (status === 0) return 'ignored';
  if (status === 1) return 'not-ignored';
  return 'unknown';
}

export function linkedTargetSafe({ root, file, sh, fs = nodeFs }) {
  let real;
  try {
    real = fs.realpathSync(join(root, file));
  } catch {
    return true; // missing, or a dangling link: the write makes a plain file at the link's path
  }
  // macOS temp folders live under /private/var, so compare against root's real path.
  if (real === join(fs.realpathSync(root), file)) return true;
  const dir = dirname(real);
  const base = basename(real);
  const inside = sh('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir });
  if (inside.status !== 0 || String(inside.stdout ?? '').trim() !== 'true') return true;
  if (sh('git', ['ls-files', '--error-unmatch', '--', base], { cwd: dir }).status === 0) return false;
  return isIgnored({ root: dir, file: base, sh }) === 'ignored';
}

export function isTracked({ root, file, sh }) {
  const { status, stdout } = sh('git', ['ls-files', '--', file], { cwd: root });
  if (status !== 0) return 'unknown';
  return String(stdout ?? '').trim() ? 'tracked' : 'untracked';
}

export function addIgnoreLine(root, entry, fs = nodeFs, ignoreFile = '.gitignore') {
  const file = join(root, ignoreFile);
  const old = fs.existsSync(file) ? String(fs.readFileSync(file, 'utf8')) : '';
  const same = [entry, `/${entry}`, `${entry}/`, `/${entry}/`];
  if (old.split(/\r?\n/).some((line) => same.includes(line.trim()))) return false;
  fs.mkdirSync(dirname(file), { recursive: true });
  fs.writeFileSync(file, `${old === '' || old.endsWith('\n') ? old : `${old}\n`}${entry}\n`);
  return true;
}

const realPath = (file, fs) => {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
};

const asText = (lines) => (lines.length ? `${lines.join('\n')}\n` : '');

// The same names with the same values, nothing more or less.
function sameEnv(a, b) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && a[k] === b[k]);
}

const without = (values, names) => Object.fromEntries(Object.entries(values).filter(([name]) => !names.has(name)));

export function migrateKeys({ root, config, sh, fs = nodeFs }) {
  const result = { moved: [], alreadyThere: [], refused: [], ignore: null };
  const envReal = realPath(projectEnvPath(root, config), fs);
  if (!envReal) return result;
  const envText = String(fs.readFileSync(envReal, 'utf8'));
  const values = parseEnv(envText);
  const names = FOREMAN_KEYS.filter((name) => Object.hasOwn(values, name));
  if (!names.length) return result;

  const ownName = foremanEnvName(config);
  const refusal = `could not make git ignore ${ownName}; nothing was moved`;
  let ignore = isIgnored({ root, file: ownName, sh });
  if (ignore === 'not-ignored') {
    const added = addIgnoreLine(root, ownName, fs);
    if (isIgnored({ root, file: ownName, sh }) !== 'ignored') throw new Error(refusal);
    ignore = added ? 'added' : 'ignored';
  }
  if (ignore === 'unknown') throw new Error(refusal);
  result.ignore = ignore;
  if (isTracked({ root, file: ownName, sh }) === 'tracked') {
    throw new Error(`${ownName} is tracked by git; remove it from the index first (git rm --cached ${ownName}); nothing was moved`);
  }

  const ownFile = foremanEnvPath(root, config);
  const ownReal = realPath(ownFile, fs) ?? ownFile;
  const ownText = fs.existsSync(ownReal) ? String(fs.readFileSync(ownReal, 'utf8')) : '';
  const own = ownText ? parseEnv(ownText) : {};
  const lines = [];
  for (const name of names) {
    if (isSet(own[name])) {
      result.alreadyThere.push(name);
      continue;
    }
    const line = serialize(name, values[name]);
    if (line === null) result.refused.push(name);
    else {
      result.moved.push(name);
      lines.push(line);
    }
  }

  const moved = new Set(result.moved);
  const gone = new Set([...result.moved, ...result.alreadyThere]);
  const newOwn = asText([...keptLines(ownText, moved), ...lines]);
  const newEnv = asText(keptLines(envText, gone));
  if (gone.size && !sameEnv(parseEnv(newEnv), without(values, gone))) {
    throw new Error(`could not take ${[...gone].join(', ')} out of ${projectEnvName(config)} cleanly; nothing was moved`);
  }
  if (moved.size && !sameEnv(parseEnv(newOwn), { ...without(own, moved), ...Object.fromEntries(result.moved.map((name) => [name, values[name]])) })) {
    throw new Error(`could not write ${ownName} cleanly; nothing was moved`);
  }

  if (moved.size && !linkedTargetSafe({ root, file: ownName, sh, fs })) throw new Error(`${ownName} links to a file git could commit; nothing was moved`);
  if (moved.size) writeSecretFile(ownReal, newOwn);
  if (gone.size) writeSecretFile(envReal, newEnv, fs.statSync(envReal).mode & 0o777);
  return result;
}
