// What a Foreman story session (FOREMAN_RUN=1) may not run. The project the run builds is the
// "anchor", named by FOREMAN_PROJECT_DIR: its config, local settings, env files and the
// owner's controls are the owner's, so the commands that write them refuse when their target
// is the anchor. A check that needs those commands runs them in a
// scratch git repo or a plain temporary folder instead.
//
//   refuseInRun(env, what) -> null, or the one-line message the command prints before exiting 1;
//       refuses in every story session (`foreman cloud run|tick`)
//   canonicalPath(p) -> p absolute, with symlinks resolved (through its folder when p is missing)
//   isAnchorTarget(target, anchor, { sh }) -> true when target is the anchor, inside it, or a
//       worktree of the same repo (the same git common dir) wherever it lives
//   guardedWrite(name, args) -> 'foreman <name>[ <sub>]' for a command that writes the owner's
//       files, or null (GUARDED says which)
//   ownerFilesWrite(name, args) -> guardedWrite's label, or 'foreman keys <sub>' for keys
//   refuseAnchorWrite(env, target, what, { sh }) -> null outside a run or for another project;
//       else the one-line message the command prints before exiting 1
//   ownerEnv(env) -> a copy of env without FOREMAN_RUN, FOREMAN_STORY and FOREMAN_SLOT, for the
//       commands the supervisor runs as the owner's own work (the owner's answers, the learning
//       tick), which are never a session's
//   sessionPlace(cwd, env, { sh }) -> where a session command stands:
//       { kind: 'run' }            a git repo with FOREMAN_PROJECT_DIR's common dir (the anchor or
//                                  its slot worktree), or any git repo when that is not set
//       { kind: 'scratch', root }  another git repo; root is its main checkout
//       { kind: 'plain', root }    no git repo at all; root is cwd
//       { kind: 'unknown', reason } the folder is missing, or git cannot say (not found, dubious
//                                  ownership and the like): the command refuses
//   refuseRunState(env, root, what) -> null, or the one-line refusal when root's state folder
//       (its foreman.config.json stateDir, read raw, else .foreman) is the run's own
//       (FOREMAN_STATE_DIR, or FOREMAN_PROJECT_DIR's state folder)
//   unknownPlace(what, cwd, reason) -> the one-line refusal for an 'unknown' place
//   rawStateDir(root) -> the stateDir string root's foreman.config.json names, read raw, else
//       '.foreman'
//
// The owner's controls (FM-279) refuse in two more cases, checked before anything else runs: a
// story session whose FOREMAN_RUN was changed or unset, and any process the run's live
// supervisor started (directly, or through a session it adopted after a restart on new code),
// whatever its environment says.
//
//   SESSION_VARS -> the variables that mark a story session
//   storySession(env) -> true when any of SESSION_VARS is a non-empty string (an empty one counts
//       as unset: the dashboard's artifact runs set FOREMAN_RUN to '' on purpose)
//   OWNER_CONTROLS -> the owner's controls by subcommand, as GUARDED: the control.json writers,
//       run, service install|uninstall, settings set|reset and features on|off
//   ownerControl(name, args) -> 'foreman <name>[ <sub>]' for an owner's control, or null
//   processTable({ sh }) -> a Map of pid to parent pid from one `ps -A -o pid=,ppid=` call; lines
//       that are not two numbers and a parent of 0 are left out; null when ps cannot say
//   ppidLookup({ proc, sh }) -> (pid) => the pid's parent, a positive integer or null: from
//       /proc/<pid>/stat first (the runner image has no ps), else from the one process table,
//       read on first need and kept, so a lookup function runs ps at most once
//   ppidOf(pid, { proc, sh }) -> ppidLookup's answer for one pid
//   parentChain({ start, lookup, max }) -> [start, its parent, ...], stopping before a pid at or
//       below 1 or one already seen, or at max entries; [] when start is 1 or below; null when
//       any parent on the way cannot be read, not only start's (a partial chain would hide the
//       supervisor, so it counts as unreadable)
//   refuseOwnerControl({ env, cwd, name, args, alive, parents }) -> null, or the one-line refusal
//       main prints before exiting 1: in a session whose FOREMAN_RUN is not '1', always; with no
//       session variable, when the state folder the command would act on has a live supervisor
//       and that supervisor, or a session it adopted from an earlier supervisor after a restart
//       (supervisor-adopted.json, while its voucher lives), is among this process's parents (or,
//       when the parents cannot be read, when a location variable is set). With no live
//       supervisor it is null without reading the parents. With FOREMAN_RUN=1 it is null: main's
//       session guard decides.
//
// Known limits. The guard stops agent mistakes, not a hostile process.
//   (a) A process the run started that re-parented itself (a double fork, nohup and disown, setsid)
//       has a chain that ends at pid 1 before the supervisor, so with every FOREMAN_* variable
//       stripped it is not caught.
//   (b) A process with every variable stripped, standing in a folder outside any project such as
//       /tmp, gets null (no state folder is the run's): it acts on that folder's own state, so a
//       stray `.foreman/STOP` can land there. That does no harm to the run.

import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { OWNER_ACTIONS } from '../console/commands.mjs';
import { projectRoot } from './paths.mjs';
import { adoptedAlive, defaultAlive, readAdopted, runningSupervisor } from './supervisor-pid.mjs';

const defaultSh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });

export function refuseInRun(env, what) {
  if (env?.FOREMAN_RUN !== '1') return null;
  return `${what} does not run inside a Foreman story session (FOREMAN_RUN=1); run it yourself from the project's folder.`;
}

export function canonicalPath(p) {
  try {
    return realpathSync(p);
  } catch {
    try {
      return path.join(realpathSync(path.dirname(p)), path.basename(p));
    } catch {
      return path.resolve(p);
    }
  }
}

// The canonical git common dir of the repo around dir, or '' when it is not in one.
function commonDir(dir, sh) {
  try {
    const r = sh('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: dir });
    const out = r?.status === 0 ? String(r.stdout).trim() : '';
    return out ? canonicalPath(out) : '';
  } catch {
    return '';
  }
}

// Where git puts dir: { dir } its canonical common dir, { none: true } in no repo, or { error }
// when the folder is missing or git cannot say.
function gitCommon(dir, sh) {
  let isDir = false;
  try {
    isDir = statSync(dir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) return { error: `the folder ${dir} does not exist` };
  let r;
  try {
    r = sh('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: dir });
  } catch (err) {
    return { error: `git could not run (${String(err?.message ?? err).slice(0, 200)})` };
  }
  if (r?.error) return { error: `git could not run (${String(r.error?.message ?? r.error).slice(0, 200)})` };
  if (r?.status === 0) {
    const out = String(r.stdout ?? '').trim();
    return out ? { dir: canonicalPath(out) } : { error: 'git gave no answer' };
  }
  const stderr = String(r?.stderr ?? '').trim();
  if (/not a git repository/i.test(stderr)) return { none: true };
  return { error: (stderr.split('\n').pop() || `git exited with ${r?.status}`).trim().slice(0, 200) };
}

export function sessionPlace(cwd, env, { sh = defaultSh } = {}) {
  const here = gitCommon(cwd, sh);
  if (here.error) return { kind: 'unknown', reason: here.error };
  if (here.none) return { kind: 'plain', root: cwd };
  const anchor = env?.FOREMAN_PROJECT_DIR;
  if (!anchor) return { kind: 'run' };
  if (gitCommon(anchor, sh).dir === here.dir) return { kind: 'run' };
  return { kind: 'scratch', root: path.dirname(here.dir) };
}

export function unknownPlace(what, cwd, reason) {
  return `${what} cannot tell which project ${cwd} belongs to (${reason}), so it does not run inside a story session (FOREMAN_RUN=1); run it in a scratch git repo or a plain temporary folder.`;
}

// The stateDir string a project's foreman.config.json names, read raw (an invalid config is still
// checked), else '.foreman'.
export function rawStateDir(root) {
  try {
    const value = JSON.parse(readFileSync(path.join(root, 'foreman.config.json'), 'utf8'));
    return typeof value?.stateDir === 'string' && value.stateDir !== '' ? value.stateDir : '.foreman';
  } catch {
    return '.foreman';
  }
}

export function refuseRunState(env, root, what) {
  const anchor = env?.FOREMAN_PROJECT_DIR;
  const runStates = [env?.FOREMAN_STATE_DIR, anchor ? path.join(anchor, rawStateDir(anchor)) : ''].filter(Boolean).map(canonicalPath);
  const target = canonicalPath(path.join(root, rawStateDir(root)));
  const runState = runStates.find((dir) => dir === target);
  if (!runState) return null;
  return `${what} would act on ${runState}, the state folder of the run this session belongs to, so it does not run inside a story session (FOREMAN_RUN=1).`;
}

export function isAnchorTarget(target, anchor, { sh = defaultSh } = {}) {
  const t = canonicalPath(target);
  const a = canonicalPath(anchor);
  if (t === a || t.startsWith(a + path.sep)) return true;
  const ct = commonDir(t, sh);
  return Boolean(ct) && ct === commonDir(a, sh);
}

// The commands that write the owner's files, by subcommand; '*' is every form of the command.
export const GUARDED = {
  settings: ['set', 'reset'],
  features: ['on', 'off'],
  init: ['write'],
  traits: ['add'],
  learning: ['undo', 'keep'],
  learn: ['reopen', 'undo'],
  decide: ['answer'],
  sf: ['deletes'],
  claude: ['use-key'],
  run: '*',
  ...Object.fromEntries(OWNER_ACTIONS.map((name) => [name, '*'])),
};

// The options of guarded commands that take a value as the next argument, so that value is not
// taken for the subcommand (`settings --group run set ...` is still a set).
const VALUE_OPTIONS = {
  settings: ['--group'],
  learn: ['--min-stories'],
  decide: ['--story', '--kind', '--title', '--option', '--body', '--note', '--summary', '--hint', '--recommend', '--purpose', '--happened', '--damage', '--recommendation', '--bundle'],
};

// The first argument that is not an option or an option's value.
function subOf(name, args) {
  const takesValue = VALUE_OPTIONS[name] ?? [];
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (a === '--') return args[i + 1];
    if (!a.startsWith('-')) return a;
    if (takesValue.includes(a)) i++;
  }
  return undefined;
}

export function guardedWrite(name, args = []) {
  if (!Object.hasOwn(GUARDED, name)) return null;
  const subs = GUARDED[name];
  if (subs === '*') return `foreman ${name}`;
  const sub = subOf(name, args);
  return subs.includes(sub) ? `foreman ${name} ${sub}` : null;
}

// guardedWrite, plus every form of `foreman keys`, which guards itself in the CLI (it never reads
// FOREMAN_PROJECT_DIR) but writes the owner's key files all the same. The Bash guard uses this.
export function ownerFilesWrite(name, args = []) {
  if (name !== 'keys') return guardedWrite(name, args);
  const sub = subOf('keys', args.filter((a, i) => a !== '--project' && args[i - 1] !== '--project' && !String(a).startsWith('--project=')));
  return sub === undefined ? 'foreman keys' : `foreman keys ${sub}`;
}

export function ownerEnv(env) {
  const out = { ...env };
  for (const key of SESSION_VARS) delete out[key];
  return out;
}

export const SESSION_VARS = ['FOREMAN_RUN', 'FOREMAN_STORY', 'FOREMAN_SLOT'];

export function storySession(env) {
  return SESSION_VARS.some((key) => typeof env?.[key] === 'string' && env[key] !== '');
}

// The owner's controls, by subcommand as in GUARDED; '*' is every form of the command.
export const OWNER_CONTROLS = {
  ...Object.fromEntries(OWNER_ACTIONS.map((name) => [name, '*'])),
  run: '*',
  service: ['install', 'uninstall'],
  settings: ['set', 'reset'],
  features: ['on', 'off'],
};

export function ownerControl(name, args = []) {
  if (!Object.hasOwn(OWNER_CONTROLS, name)) return null;
  const subs = OWNER_CONTROLS[name];
  if (subs === '*') return `foreman ${name}`;
  const sub = subOf(name, args);
  return subs.includes(sub) ? `foreman ${name} ${sub}` : null;
}

const asPid = (text) => {
  const value = String(text ?? '').trim();
  if (!/^\d+$/.test(value)) return null;
  const pid = Number(value);
  return pid > 0 ? pid : null;
};

// pid's parent from <proc>/<pid>/stat, or null when the file is missing or unreadable.
function procParent(pid, proc) {
  let stat = null;
  try {
    stat = readFileSync(path.join(proc, String(pid), 'stat'), 'utf8');
  } catch {
    return null;
  }
  // The command name sits in parentheses and may hold spaces or ')': the fields after the last
  // ')' are the state, then the parent's pid.
  return asPid(stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[1]);
}

// Every process's parent from one `ps` call, as a Map of pid to ppid. Lines that are not two
// numbers, and a parent of 0 (launchd and init), are left out. Null when ps cannot say.
export function processTable({ sh = defaultSh } = {}) {
  let out;
  try {
    const r = sh('ps', ['-A', '-o', 'pid=,ppid=']);
    if (r?.error || r?.status !== 0) return null;
    out = String(r.stdout ?? '');
  } catch {
    return null;
  }
  const table = new Map();
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) continue;
    const pid = asPid(m[1]);
    const ppid = asPid(m[2]);
    if (pid !== null && ppid !== null) table.set(pid, ppid);
  }
  return table;
}

// (pid) => its parent, or null: /proc first, else the process table, which is read once on first
// need and kept (a table that could not be read included), so ps runs at most once per lookup.
export function ppidLookup({ proc = '/proc', sh = defaultSh } = {}) {
  let table;
  return (pid) => {
    const ppid = procParent(pid, proc);
    if (ppid !== null) return ppid;
    if (table === undefined) table = processTable({ sh });
    return table?.get(Number(pid)) ?? null;
  };
}

export function ppidOf(pid, opts) {
  return ppidLookup(opts)(pid);
}

export function parentChain({ start = process.ppid, lookup = ppidLookup(), max = 64 } = {}) {
  if (!(start > 1)) return [];
  const chain = [];
  const seen = new Set();
  let pid = start;
  while (pid > 1 && !seen.has(pid) && chain.length < max) {
    chain.push(pid);
    seen.add(pid);
    const parent = lookup(pid);
    if (parent === null || parent === undefined) return null;
    pid = parent;
  }
  return chain;
}

// The pids that stand for the run: its live supervisor, and the sessions an earlier supervisor
// started that it adopted after a restart, while their voucher lives (adoptedAlive's own check:
// the voucher may be run.mjs, which defaultAlive would not count).
function runPids(dir, pid) {
  const adopted = readAdopted(dir)?.pids ?? [];
  return [pid, ...adopted.filter((p) => adoptedAlive(dir, p))];
}

export function refuseOwnerControl({ env, cwd, name, args = [], alive = defaultAlive, parents = () => parentChain() }) {
  const what = ownerControl(name, args);
  if (!what) return null;
  if (storySession(env) && env.FOREMAN_RUN !== '1') {
    return `${what} does not run from a Foreman story session whose FOREMAN_RUN is changed or unset (FOREMAN_STORY or FOREMAN_SLOT is still set); the owner runs it from their own terminal or the dashboard, and a test builds an owner environment from scratch in a temporary project.`;
  }
  if (storySession(env)) return null;
  const root = projectRoot({ cwd, env: env ?? {} });
  const dir = env?.FOREMAN_STATE_DIR || path.join(root, rawStateDir(root));
  const pid = runningSupervisor(dir, { alive });
  if (pid === null) return null;
  const chain = parents();
  const startedByRun = chain === null ? Boolean(env?.FOREMAN_STATE_DIR || env?.FOREMAN_PROJECT_DIR) : runPids(dir, pid).some((p) => chain.includes(p));
  if (!startedByRun) return null;
  return `${what} would act on ${canonicalPath(dir)}, the state folder of the Foreman run (supervisor ${pid}) that started this process, so it does not run here; the owner runs it from their own terminal or the dashboard, and a test builds an owner environment from scratch in a temporary project.`;
}

export function refuseAnchorWrite(env, target, what, { sh = defaultSh } = {}) {
  if (env?.FOREMAN_RUN !== '1') return null;
  const anchor = env.FOREMAN_PROJECT_DIR;
  if (!anchor) {
    return `${what} cannot tell which project this Foreman run builds (FOREMAN_PROJECT_DIR is not set), so it does not run inside a story session (FOREMAN_RUN=1); run it in a scratch git repo instead.`;
  }
  if (isAnchorTarget(target, anchor, { sh })) {
    return `${what} would change ${anchor}, the project this Foreman run builds, so it does not run inside a story session (FOREMAN_RUN=1); run it in a scratch git repo instead.`;
  }
  return null;
}
