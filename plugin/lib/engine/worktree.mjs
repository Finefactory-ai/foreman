// A slot's worktree: a folder per slot under <stateDir>/worktrees/wN, detached at
// <remote>/<baseBranch>, with the project's env file (config `envFile`) linked in from the
// anchor (the main checkout; never read here). Foreman's own keys file (config
// `foremanEnvFile`, .env.foreman) is never linked, copied or created here, so the agents in a
// slot cannot read it; an envFile that names that file is not linked either. The install
// command runs when the hash of the `install.when` file changes, or when the `install.creates`
// path (such as node_modules) is missing from the worktree; no `when` file, or `install: null`,
// means no install. The dirty check ignores the `generated` paths. Which environment a slot runs in is the env adapter's business.
//
// ensureWorktree does it all synchronously, with `sh`. The supervisor does not: it asks
// worktreeNeeds (fs only) whether the folder must be created or the install run, and when
// either must, `await prepareWorktree(...)` does the same steps with runAsync, so a slow
// install or fetch never holds its loop. Each child gets its time limit (WORKTREE_LIMITS) and
// `track`, so the owner can end it; before each step `live()` says whether the slot still wants
// the folder, and a false one throws Error('cancelled'). The install's hash is written only
// after an install that exited 0 within its limit. Both give the same error texts.

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { spawnSync } from 'node:child_process';
import { matchesGlob } from './glob.mjs';
import { runAsync } from './run-async.mjs';

const FETCH_TRIES = 3;

export function defaultSh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  return { status: r.status ?? 1, stdout: r.stdout ?? '' };
}

export const slotIds = (config) => Array.from({ length: config.slots }, (_, i) => `w${i + 1}`);

export function checkSlot(n, config) {
  if (!Number.isInteger(n) || n < 1 || n > config.slots) {
    throw new Error(`There is no slot ${n}; slots are 1 to ${config.slots}.`);
  }
}

export const worktreeOf = (stateDirPath, n) => join(stateDirPath, 'worktrees', `w${n}`);
const installFile = (stateDirPath, n) => join(stateDirPath, 'slots', `w${n}.install`);

// lstat, not exists: a link whose target is gone still counts as there.
const present = (file) => {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
};

const readOr = (file, fallback) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
};

// Several worktrees fetching at once can fail on a ref lock, so a fetch gets a few tries.
const fetchBase = (anchor, { remote, baseBranch }, sh) => {
  for (let i = 0; i < FETCH_TRIES; i++) {
    if (sh('git', ['fetch', '--quiet', remote, baseBranch], { cwd: anchor }).status === 0) return;
  }
  throw new Error(`Could not fetch ${remote}/${baseBranch} after ${FETCH_TRIES} tries.`);
};

// The install is due when the `when` file exists and either `creates` is missing or the hash of
// the `when` file is not the one recorded after the last install. fs only.
export function installDue(path, stateDir, n, install) {
  const whenFile = install ? join(path, install.when) : null;
  if (!whenFile || !existsSync(whenFile)) return { due: false, hash: null };
  const hash = createHash('sha1').update(readFileSync(whenFile)).digest('hex');
  const missing = Boolean(install.creates) && !existsSync(join(path, install.creates));
  return { due: missing || hash !== (readOr(installFile(stateDir, n), '').trim() || null), hash };
}

// The link points at the anchor's file; nothing here opens either of them.
export function linkEnvFile(anchor, path, config) {
  if (normalize(config.envFile) !== normalize(config.foremanEnvFile ?? '.env.foreman')) {
    const envLink = join(path, config.envFile);
    const envTarget = join(anchor, config.envFile);
    if (!present(envLink) && present(envTarget)) symlinkSync(envTarget, envLink);
  }
}

const writeInstalled = (stateDir, n, hash) => {
  mkdirSync(dirname(installFile(stateDir, n)), { recursive: true });
  writeFileSync(installFile(stateDir, n), `${hash}\n`);
};

export function ensureWorktree({ anchor, stateDir, n, config, sh = defaultSh }) {
  checkSlot(n, config);
  const path = worktreeOf(stateDir, n);
  let created = false;

  if (!existsSync(join(path, '.git'))) {
    fetchBase(anchor, config, sh);
    mkdirSync(dirname(path), { recursive: true });
    sh('git', ['worktree', 'prune'], { cwd: anchor }); // forget a worktree whose folder was deleted
    if (sh('git', ['worktree', 'add', '--detach', path, `${config.remote}/${config.baseBranch}`], { cwd: anchor }).status !== 0) {
      throw new Error(`Could not create the worktree for slot w${n} at ${path}.`);
    }
    created = true;
  }

  linkEnvFile(anchor, path, config);

  let installed = false;
  const { install } = config;
  const { due, hash } = installDue(path, stateDir, n, install);
  if (due) {
    if (sh('sh', ['-c', install.run], { cwd: path }).status !== 0) {
      throw new Error(`The install command (${install.run}) failed in slot w${n} (${path}).`);
    }
    writeInstalled(stateDir, n, hash);
    installed = true;
  }
  return { path, created, installed };
}

// What the slot's folder needs before a session: created (no worktree yet) and/or installed.
// fs only, so the supervisor asks it on the loop and runs prepareWorktree only when it must.
export function worktreeNeeds({ stateDir, n, config }) {
  const path = worktreeOf(stateDir, n);
  const create = !existsSync(join(path, '.git'));
  return { create, install: !create && installDue(path, stateDir, n, config.install).due };
}

export const WORKTREE_LIMITS = { fetchMs: 60_000, gitMs: 120_000, installMs: 20 * 60_000 };

// ensureWorktree's steps, each child run with `run` (runAsync) so the event loop stays free.
export async function prepareWorktree({ anchor, stateDir, n, config, run = runAsync, track, live = () => true, limits = WORKTREE_LIMITS }) {
  checkSlot(n, config);
  const path = worktreeOf(stateDir, n);
  const step = async (cmd, args, cwd, timeoutMs) => {
    if (!live()) throw new Error('cancelled');
    return run(cmd, args, { cwd, timeoutMs, track });
  };
  const worked = (r) => r.status === 0 && !r.timedOut;
  let created = false;

  if (!existsSync(join(path, '.git'))) {
    let fetched = false;
    for (let i = 0; i < FETCH_TRIES && !fetched; i++) {
      fetched = worked(await step('git', ['fetch', '--quiet', config.remote, config.baseBranch], anchor, limits.fetchMs));
    }
    if (!fetched) throw new Error(`Could not fetch ${config.remote}/${config.baseBranch} after ${FETCH_TRIES} tries.`);
    if (!live()) throw new Error('cancelled');
    mkdirSync(dirname(path), { recursive: true });
    await step('git', ['worktree', 'prune'], anchor, limits.gitMs);
    if (!worked(await step('git', ['worktree', 'add', '--detach', path, `${config.remote}/${config.baseBranch}`], anchor, limits.gitMs))) {
      throw new Error(`Could not create the worktree for slot w${n} at ${path}.`);
    }
    created = true;
  }

  if (!live()) throw new Error('cancelled');
  linkEnvFile(anchor, path, config);

  let installed = false;
  const { install } = config;
  const { due, hash } = installDue(path, stateDir, n, install);
  if (due) {
    const r = await step('sh', ['-c', install.run], path, limits.installMs);
    if (r.timedOut) {
      throw new Error(`The install command (${install.run}) did not finish within ${Math.round(limits.installMs / 60_000)} minutes in slot w${n} (${path}).`);
    }
    if (r.status !== 0) throw new Error(`The install command (${install.run}) failed in slot w${n} (${path}).`);
    writeInstalled(stateDir, n, hash);
    installed = true;
  }
  return { path, created, installed };
}

// Dirty means a change outside the generated paths (exact paths or globs).
export function worktreeDirty(path, { generated = [], sh = defaultSh } = {}) {
  const patterns = generated.map((g) => g.path);
  return sh('git', ['status', '--porcelain'], { cwd: path })
    .stdout.split('\n')
    .filter((line) => line.trim() !== '')
    .some((line) => {
      let file = line.slice(3);
      const arrow = file.indexOf(' -> ');
      if (arrow !== -1) file = file.slice(arrow + 4);
      file = file.replace(/^"(.*)"$/, '$1');
      return !patterns.some((p) => matchesGlob(file, p));
    });
}
