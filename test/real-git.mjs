// The PATH `npm test` gives the suite (test/run-suite.mjs). On macOS, /usr/bin/git is the Xcode
// launcher: every call goes through xcrun, which then starts the real git, so each one costs
// about 8 ms against 3 ms for the real binary. The suite makes about 11,500 git calls, so
// realGitPath puts the real git's folder (`xcrun --find git`) just before /usr/bin on PATH. It is
// the same git: only the launcher is skipped. Whatever came before /usr/bin still wins, and
// anywhere else, or when xcrun gives no real git, PATH stays as it was.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const USR_BIN = '/usr/bin';
const folder = (entry) => path.posix.normalize(entry).replace(/(.)\/+$/, '$1');

function canRun(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export const xcrunGit = () => spawnSync('xcrun', ['--find', 'git'], { encoding: 'utf8', timeout: 5000 });

// `path` with the real git's folder just before its first /usr/bin entry, when that entry holds
// the first git on it and the platform is macOS; else `path` unchanged.
export function realGitPath({ platform = process.platform, path: p = process.env.PATH ?? '', find = xcrunGit, isExe = canRun } = {}) {
  if (platform !== 'darwin') return p;
  const entries = p.split(':');
  const first = entries.findIndex((entry) => entry && isExe(path.posix.join(entry, 'git')));
  if (first < 0 || folder(entries[first]) !== USR_BIN) return p;
  let real;
  try {
    const found = find();
    if (found?.status !== 0) return p;
    real = String(found.stdout ?? '').trim();
  } catch {
    return p;
  }
  if (!path.posix.isAbsolute(real)) return p;
  const dir = path.posix.dirname(real);
  if (folder(dir) === USR_BIN || !isExe(real)) return p;
  return [...entries.slice(0, first), dir, ...entries.slice(first)].join(':');
}

// `env` with PATH from realGitPath and nothing else changed. An env with no PATH keeps none.
export function suiteEnv(env = process.env, opts = {}) {
  if (env.PATH === undefined) return { ...env };
  return { ...env, PATH: realGitPath({ path: env.PATH, ...opts }) };
}
