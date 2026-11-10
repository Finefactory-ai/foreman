// Foreman processes that are not this run's: supervisors, the session guard hook's --decide
// children and `foreman learn` or `notify` runs, left running by tests or by agents' manual
// checks, in temp folders or in this project's folders (its slots' worktrees). `foreman doctor`
// counts them, the supervisor keeps their pids in state.json's `strays` for Waiting on you, and
// `foreman doctor --end-strays` and the dashboard end them. Another project's run is never
// counted, and neither is this run's own supervisor, but any such process over 10 minutes old
// whose folder is under a temp root counts, even another project's real run kept in a temp
// folder. A real hook lives at most 10 s and a learn at most 60 s, so the age never counts a live
// one.
//
//   STRAY_AGE_MS (10 min): a younger process is not counted. Other slots run the tests at
//       the same time, and their live test processes are young.
//   parseEtime(text) -> ms from ps's elapsed time [[dd-]hh:]mm:ss, or null
//   lsofFolders(stdout) -> Map pid -> folder, from `lsof -Fn` output (live-sessions.mjs reads it
//       too)
//   kindOf(command) -> 'supervisor' (node running engine/supervisor.mjs), 'hook' (node running
//       lib/hooks/agent-events.mjs, with or without --decide), 'owner' (node running a `foreman`
//       script with `learn` or `notify`) or null: a shell or grep naming them, or `foreman run`
//   listProcesses({ sh, platform, readlink }) -> [{ pid, rssKb, ageMs, cwd, kind }] for every
//       process kindOf names, or null when ps fails. The folder comes from /proc/<pid>/cwd on
//       Linux, else from one lsof call; null where neither says.
//   findStrays({ root, dir, sh, platform, readlink, roots, selfPid }) -> { listed, strays: [{ pid,
//       rssKb, ageMs, cwd, kind, where }], mb }: where is 'project' (the folder is root or inside
//       it) or 'temp' (under a temp root, leash.mjs); mb is their memory in all. Skips selfPid, the
//       pid in dir's supervisor.pid, young ones and those with no folder. listed is false when
//       ps failed.
//   straysText({ strays, mb }) -> "2 supervisors that are not this run's (1 in temp folders, 1
//       in this project's folders), holding about 1.2 GB"; with a hook or owner command among
//       them: "3 processes that are not this run's (1 supervisor, 1 hook run, 1 learn or notify
//       run; 2 in temp folders, 1 in this project's folders), holding about 2 MB"
//   processKind(pid, { sh }) -> the kind of what the pid runs now, or null (ps failed)
//   endStrays(strays, { stillRuns, kill, sleep, waitMs }) -> { ended, left }: SIGTERM to each
//       pid still running its kind now (stillRuns(pid, kind), checked again, against pid reuse;
//       never pid 1 or this process), whose stop() ends its sessions; SIGKILL to any still there
//       after waitMs (5 s), then one more look.
//   strayPatch(before, found, at) -> { strays: next } | null: the supervisor's decision on what
//       findStrays found, as the patch for state.json. next is { pids, mb (rounded), at }, or null
//       when there are none. null (write nothing) when ps failed (found.listed false, so the last
//       list stays) or when the pids are the same as before's, in the same order.
//
// `sh(cmd, args)` returns { status, stdout }, as the doctor's ctx.sh does.

import { spawnSync } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import { sep } from 'node:path';
import { canonical, tempRoots, underTemp } from './leash.mjs';
import { defaultAlive, readPid } from './supervisor-pid.mjs';

export const STRAY_AGE_MS = 10 * 60_000;
const SUPERVISOR = '/engine/supervisor.mjs';
const HOOK = '/lib/hooks/agent-events.mjs';
const FOREMAN_SCRIPT = /(^|\/)foreman(\.[cm]?js)?$/;
const POLL_MS = 100;

const localSh = (cmd, args = []) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 });
  return { status: r.status ?? 1, stdout: r.stdout ?? '' };
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function parseEtime(text) {
  const m = String(text ?? '').trim().match(/^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const [days, hours, minutes, seconds] = [m[1], m[2], m[3], m[4]].map((v) => Number(v ?? 0));
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

// Which Foreman process a command line is, when node runs it; not a shell or a grep whose
// command line names it.
export function kindOf(command) {
  const [exe = '', script = '', first = ''] = String(command ?? '').trim().split(/\s+/);
  if (!/(^|\/)node[^/]*$/.test(exe)) return null;
  if (script.endsWith(SUPERVISOR)) return 'supervisor';
  if (script.endsWith(HOOK)) return 'hook';
  if (FOREMAN_SCRIPT.test(script) && (first === 'learn' || first === 'notify')) return 'owner';
  return null;
}

// pid -> folder, from `lsof -Fn` output: a p<pid> line, then n<path> for its cwd.
export function lsofFolders(stdout) {
  const out = new Map();
  let pid = null;
  for (const line of String(stdout ?? '').split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid !== null && !out.has(pid)) out.set(pid, line.slice(1));
  }
  return out;
}

export function listProcesses({ sh = localSh, platform = process.platform, readlink = readlinkSync } = {}) {
  let r;
  try {
    r = sh('ps', ['-axo', 'pid=,rss=,etime=,command=']);
  } catch {
    return null;
  }
  if (!r || r.status !== 0) return null;
  const rows = [];
  for (const line of String(r.stdout ?? '').split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    const kind = m ? kindOf(m[4]) : null;
    if (!m || !kind) continue;
    rows.push({ pid: Number(m[1]), rssKb: Number(m[2]), ageMs: parseEtime(m[3]), cwd: null, kind });
  }
  if (!rows.length) return rows;
  if (platform === 'linux') {
    for (const row of rows) {
      try {
        row.cwd = String(readlink(`/proc/${row.pid}/cwd`)) || null;
      } catch {
        row.cwd = null;
      }
    }
    return rows;
  }
  let folders = new Map();
  try {
    // lsof exits 1 when one of the pids has gone; what it printed for the others still counts.
    folders = lsofFolders(sh('lsof', ['-a', '-d', 'cwd', '-Fn', '-p', rows.map((row) => row.pid).join(',')])?.stdout);
  } catch {
    // no lsof: no folders
  }
  for (const row of rows) row.cwd = folders.get(row.pid) || null;
  return rows;
}

export function findStrays({ root, dir, sh, platform, readlink, roots = tempRoots(), selfPid = process.pid } = {}) {
  const list = listProcesses({ sh, platform, readlink });
  if (list === null) return { listed: false, strays: [], mb: 0 };
  const own = dir ? readPid(dir) : null;
  const project = root ? canonical(root) : null;
  const strays = [];
  for (const s of list) {
    if (s.pid === selfPid || s.pid === own) continue;
    if (s.ageMs === null || s.ageMs < STRAY_AGE_MS) continue;
    if (!s.cwd) continue;
    const cwd = canonical(s.cwd);
    const where = project && (cwd === project || cwd.startsWith(project + sep)) ? 'project' : underTemp(cwd, roots) ? 'temp' : null;
    if (where) strays.push({ ...s, where });
  }
  return { listed: true, strays, mb: strays.reduce((sum, s) => sum + (s.rssKb || 0), 0) / 1024 };
}

export function strayPatch(before, found, at) {
  if (!found?.listed) return null;
  const next = found.strays.length ? { pids: found.strays.map((s) => s.pid), mb: Math.round(found.mb), at } : null;
  if (JSON.stringify(before?.pids ?? []) === JSON.stringify(next?.pids ?? [])) return null;
  return { strays: next };
}

const KIND_TEXT = [
  ['supervisor', '1 supervisor', 'supervisors'],
  ['hook', '1 hook run', 'hook runs'],
  ['owner', '1 learn or notify run', 'learn or notify runs'],
];

export function straysText({ strays = [], mb = 0 } = {}) {
  const n = strays.length;
  const temp = strays.filter((s) => s.where === 'temp').length;
  const project = strays.filter((s) => s.where === 'project').length;
  const parts = [...(temp ? [`${temp} in temp folders`] : []), ...(project ? [`${project} in this project's folders`] : [])];
  const size = mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
  if (strays.some((s) => s.kind && s.kind !== 'supervisor')) {
    const kinds = KIND_TEXT.map(([kind, one, many]) => [strays.filter((s) => s.kind === kind).length, one, many])
      .filter(([count]) => count)
      .map(([count, one, many]) => (count === 1 ? one : `${count} ${many}`));
    return `${n} ${n === 1 ? 'process that is' : 'processes that are'} not this run's (${kinds.join(', ')}${parts.length ? `; ${parts.join(', ')}` : ''}), holding about ${size}`;
  }
  return `${n} ${n === 1 ? 'supervisor that is' : 'supervisors that are'} not this run's${parts.length ? ` (${parts.join(', ')})` : ''}, holding about ${size}`;
}

// What the pid runs now, as kindOf names it; null when ps fails or it is something else.
export function processKind(pid, { sh = localSh } = {}) {
  try {
    const r = sh('ps', ['-o', 'command=', '-p', String(pid)]);
    return r?.status === 0 ? kindOf(String(r.stdout ?? '').split('\n')[0]) : null;
  } catch {
    return null;
  }
}

// Still the kind it was when listed: a supervisor by its pid file check, the others by ps.
const defaultStillRuns = (pid, kind) => (!kind || kind === 'supervisor' ? defaultAlive(pid) : processKind(pid) === kind);

export async function endStrays(strays, { stillRuns = defaultStillRuns, kill = process.kill.bind(process), sleep = pause, waitMs = 5_000 } = {}) {
  const exists = (pid) => {
    try {
      kill(pid, 0);
      return true;
    } catch (err) {
      return err?.code === 'EPERM';
    }
  };
  const send = (pid, signal) => {
    try {
      kill(pid, signal);
    } catch {
      // gone already
    }
  };
  const targets = [];
  for (const s of strays ?? []) {
    const pid = s?.pid;
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid || targets.includes(pid)) continue;
    let still = false;
    try {
      still = stillRuns(pid, s?.kind);
    } catch {
      still = false;
    }
    if (still) targets.push(pid);
  }
  for (const pid of targets) send(pid, 'SIGTERM');
  for (let waited = 0; waited < waitMs && targets.some(exists); waited += POLL_MS) await sleep(POLL_MS);
  const survivors = targets.filter(exists);
  if (survivors.length) {
    for (const pid of survivors) send(pid, 'SIGKILL');
    await sleep(POLL_MS * 2);
  }
  return { ended: targets.filter((pid) => !exists(pid)), left: targets.filter(exists) };
}
