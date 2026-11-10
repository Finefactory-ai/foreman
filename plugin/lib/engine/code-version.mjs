// Which Foreman code a supervisor runs, so it can restart itself when that code changes under
// it (Foreman building its own repo, or a plugin update). No side effects at import time.
//
//   RESTART_EXIT        75: the supervisor's exit code that asks `startSupervisor` (run.mjs) to
//                       start it again with the same arguments
//   INTERRUPT_EXIT      130: the exit code of a run ended by a signal, which startSupervisor
//                       returns as it is
//   PLUGIN_DIR          the plugin/ folder this code was loaded from. It is also the plugin every
//                       story session loads (plugin-copy.mjs sessionPlugin: `--plugin-dir`
//                       whenever the installed copy is elsewhere), so codeVersion() watches the
//                       sessions' code, and a restart on new code moves the sessions too
//   codeVersion(opts)   { id, label } or null. In git, id is the tree of the plugin folder at
//                       HEAD (`git rev-parse HEAD:./`), so only committed plugin code counts,
//                       and label is the short HEAD (only when `label` is true). Outside git
//                       both are v<version> from .claude-plugin/plugin.json; with neither, null.
//   codeVersionWatch({ dir, sh, stat, readFile })
//                       { version({ label }) }: codeVersion, but git runs only when something
//                       changed. The first call finds the repository's git dir and common dir once;
//                       after that a call stats HEAD, the index, packed-refs and the ref HEAD names
//                       (outside git, plugin.json) and gives the answer it kept while their mtime
//                       and size are the same. A label wanted after a call without one costs one
//                       `git rev-parse --short HEAD`. The supervisor asks every tick, so a tick
//                       runs no git child in the quiet case. When git cannot say where its
//                       directories are but still knows the tree, nothing is kept
//   codeChange(start, current, refusedId)
//                       { from, to, id } when the code is not what the run started with and not
//                       the code already refused; else null. The caller fills in `to` once a
//                       change is seen.
//   restartStep({ pending, busy, check })
//                       what to do about a pending change: none, wait (`busy`: something that
//                       cannot be handed to the next process, such as a slot being set up),
//                       restart (`check()` says the new code accepts the config), or refuse
//                       with the warn event to log. Running sessions and queued work are handed
//                       over, so they never make it wait.
//   nextPending(pending, change, { to, at })
//                       the next pending restart: null when there is no change (none, the
//                       refused code, or code that reverted); the same `pending` object for the
//                       same code id; else { from, to, id, since }, `since` staying at the first
//                       change seen (`at`) when the code changes again before the restart
//   restartWhy({ from, to })
//                       the sentence a pending restart shows (Waiting on you, `foreman status`):
//                       "New code (<from> → <to>): restarting as soon as the slots being set up
//                       are ready; the stories in progress keep running."; an empty label shows
//                       as '?'
//   afterSignal(exiting)
//                       what a SIGINT, SIGTERM or SIGHUP does, given how the supervisor is
//                       exiting (null, 'stop' or 'restart'): 'stop' when it is not exiting,
//                       'interrupt' while it exits for a restart (it exits 130 instead), 'none'
//                       while it stops

import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RESTART_EXIT = 75;
export const INTERRUPT_EXIT = 130;

export const PLUGIN_DIR = fileURLToPath(new URL('../..', import.meta.url));

// Git with no repository named by the environment, so `cwd` decides.
function realSh(cmd, args, opts = {}) {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[key];
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env, ...opts });
  return { status: r.status ?? 1, stdout: (r.stdout ?? '').trim() };
}

export function codeVersion({ dir = PLUGIN_DIR, sh = realSh, readFile = (f) => readFileSync(f, 'utf8'), label = true } = {}) {
  const tree = sh('git', ['rev-parse', 'HEAD:./'], { cwd: dir });
  if (tree.status === 0 && tree.stdout) {
    if (!label) return { id: tree.stdout };
    const head = sh('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir });
    return { id: tree.stdout, label: head.status === 0 ? head.stdout : '' };
  }
  try {
    const version = JSON.parse(readFile(join(dir, '.claude-plugin', 'plugin.json'))).version;
    if (typeof version === 'string' && version) return { id: `v${version}`, label: `v${version}` };
  } catch {
    // no version either
  }
  return null;
}

// The mtime and size of a file, '-' when it is not there.
const stamp = (stat, file) => {
  try {
    const st = stat(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return '-';
  }
};

export function codeVersionWatch({ dir = PLUGIN_DIR, sh = realSh, stat = (f) => statSync(f), readFile = (f) => readFileSync(f, 'utf8') } = {}) {
  let paths; // undefined: not looked up yet; null: not in git; else { gitDir, commonDir }
  let cache = null; // { fp, v, labelled }

  const find = () => {
    const r = sh('git', ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], { cwd: dir });
    const [gitDir, commonDir] = r.status === 0 ? r.stdout.split('\n').map((l) => l.trim()) : [];
    return gitDir && commonDir ? { gitDir, commonDir } : null;
  };

  const fingerprint = () => {
    if (!paths) return stamp(stat, join(dir, '.claude-plugin', 'plugin.json'));
    const { gitDir, commonDir } = paths;
    const parts = [stamp(stat, join(gitDir, 'HEAD')), stamp(stat, join(gitDir, 'index')), stamp(stat, join(commonDir, 'packed-refs'))];
    let ref = null;
    try {
      ref = /^ref: (.+)$/m.exec(readFile(join(gitDir, 'HEAD')))?.[1].trim() ?? null;
    } catch {
      ref = null;
    }
    parts.push(ref ? stamp(stat, join(commonDir, ref)) : '-');
    return parts.join('|');
  };

  return {
    version({ label = true } = {}) {
      if (paths === undefined) paths = find();
      const fp = fingerprint();
      if (cache && cache.fp === fp) {
        if (!label || cache.labelled || cache.v === null) return cache.v;
        const head = sh('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir });
        cache = { fp, v: { id: cache.v.id, label: head.status === 0 ? head.stdout : '' }, labelled: true };
        return cache.v;
      }
      const v = codeVersion({ dir, sh, readFile, label });
      // A tree id without a git dir to watch (a git too old for `--path-format`): nothing to tell
      // when it changes, so it is asked for every time rather than kept.
      const unwatched = !paths && v !== null && /^[0-9a-f]{40,64}$/.test(v.id);
      cache = unwatched ? null : { fp, v, labelled: label || (v !== null && 'label' in v) };
      return v;
    },
  };
}

export function codeChange(start, current, refusedId) {
  if (!start || !current || start.id === current.id || current.id === refusedId) return null;
  return { from: start.label, to: current.label, id: current.id };
}

export function restartStep({ pending, busy, check }) {
  if (!pending) return { action: 'none' };
  if (busy) return { action: 'wait' };
  const r = check();
  if (r?.ok) return { action: 'restart' };
  return { action: 'refuse', event: { text: `New Foreman code (${pending.to}) rejects foreman.config.json (${r?.reason ?? 'unknown'}); carrying on with the code already loaded.`, kind: 'warn' } };
}

export function nextPending(pending, change, { to, at }) {
  if (!change) return null;
  if (change.id === pending?.id) return pending;
  return { from: change.from, to, id: change.id, since: pending?.since ?? at };
}

export function restartWhy({ from, to }) {
  return `New code (${from || '?'} → ${to || '?'}): restarting as soon as the slots being set up are ready; the stories in progress keep running.`;
}

export function afterSignal(exiting) {
  if (exiting === null) return 'stop';
  return exiting === 'restart' ? 'interrupt' : 'none';
}
