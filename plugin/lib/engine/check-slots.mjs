// Which `foreman checks` runs are going, so a newer run in a worktree can stop an older one on a
// changed tree, and so only as many full runs go at once as the machine can take
// (cli/commands/checks.mjs). Two folders in the state folder, both written for a story session
// only:
//
//   check-running/<token>.json   one file per `foreman checks` invocation that runs checks in a
//                                session: { token, pid, script, job, slot, story, tree, at,
//                                state, since, started }. `token` is 16 hex characters; `script` is
//                                process.argv[1]; `job` is the --start job id, or null for a
//                                foreground run; `tree` is the tree hash, or null; `started` is the
//                                process start time at registration (processStart), or null; `at`
//                                is when it registered; `state` is 'started', 'queued' (waiting for a seat)
//                                or 'running' (holding one) and `since` is when it was set.
//   check-running/<token>.stopped   the note a stopRun leaves for a foreground run it stops:
//                                { supersededBy, at }. The dying run reads and removes it
//                                (takeStopNote) to say why it ended. readRuns ignores it, as it
//                                does not end in .json; leaveRun and liveRuns remove it with the
//                                entry.
//   check-slots/<n>.json         the seats: { token, pid, script, job, started, slot, story, at }, n from 0 to
//                                max - 1. `token` is the holder's register token. A seat is taken
//                                like takeClaim takes a claim (engine/check-claims.mjs): a temp
//                                file hard-linked to the name, which is exclusive.
//
//   runAlive(entry, { kill, ps }) -> whether the entry's process is the run that registered it (see below)
//   processStart(pid, { ps }) -> the start time `ps` shows for the pid, or null
//   enterRun(dir, fields) -> { entry } | { error };  setRun(dir, entry, patch) -> the new entry
//       (written only while the file still holds this token);  leaveRun(dir, entry)  (only when
//       the token matches);  liveRuns(dir, { alive }) -> the entries, dropping the file of each one
//       `alive` calls dead and leaving unreadable files out
//   olderInWorktree(entries, me) -> the entries that are in me's slot, on another tree, older than
//       me, other than me and my process: the runs a newer run stops
//   queuedFor(dir, jobId)  whether a run of that job waits for a seat (read only, no process check)
//   checkWaits(dir, { alive }) -> Map slot -> { since, text }, for the queued runs whose process
//       lives. Read only, since the status snapshot calls it
//   checkSlotLimit(config, cores) -> checkRuns.maxParallel, else max(1, floor(cores / 8))
//   takeSlot(dir, { max, holder, alive }) -> { ok: true, seat } | { ok: false, busy } | { ok: false, error }
//   releaseSlot(dir, seat), releaseSeatsOf(dir, token)
//   takeStopNote(dir, token) -> the stop note, removed, or null
//   processTree(rootPid, psText), killTree(rootPid, { ps, kill }), stopRun(dir, entry, opts)
//
// A seat whose holder is dead, or whose file cannot be read twice in a row, is removed and taken
// (only if it still holds the same holder, as dropStaleClaim does). Seats from max up are never
// taken, so when the limit is lowered the runs that already hold a high seat finish, and the limit
// is briefly exceeded.
//
// Who is alive. A run is the registered one only on strong identity, because a signal to a pid
// that was reused by another program, the supervisor or a Claude session could stop the factory
// itself. A job run (--start) must show `check-job.mjs` and its exact job id in its command line
// (jobWorkerAlive, which counts a failing, missing or slow `ps` as not alive). A foreground run must still show the process start time it registered with; a
// run with no start time recorded is never taken for alive, so it is never signalled and its seat
// is freed. The command line's script name is not enough: for a foreground run it is just
// `foreman`, which the supervisor's and every session's command line contains. The register,
// the seats, checkWaits and stopRun all use runAlive.
//
// A register entry's `job` is null (a foreground run) or a JOB_ID. Any other value is never alive,
// never signalled and never joined into a path (isJobId).
//
// stopRun ends a run that is alive (runAlive; nothing is signalled otherwise). killTree never
// signals this process or any ancestor of it, and nothing at all when the root is one of them. It writes the stopped
// job's result first, `{ exit: 1, endedAt, supersededBy }`, so a `--wait` that sees the process gone
// already finds it; then SIGTERM goes to the process and every process under it (killTree), and to
// the job's process group when jobWorkerAlive confirmed the worker, asked once before the tree is
// stopped (never on a lenient answer, so never when `ps` fails), as endCheckJobs does. For a live
// foreground run it writes the stop note before stopTree and leaves the register file to the dying
// run (or to the next liveRuns that finds it dead); a job run, or one not alive, is left at once.
//
// No export throws. Files are written as a temp file renamed into place (check-jobs.mjs writeJson),
// and this file never imports state.mjs, which runs git when it is imported.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JOB_ID, pidAlive, readJob, readResult, writeResult } from './check-jobs.mjs';

export const CHECK_RUNNING_DIR = 'check-running';
export const CHECK_SLOTS_DIR = 'check-slots';
export const QUEUED_TEXT = 'check queued: waiting for a free check slot';

const message = (err) => err?.message ?? String(err);
const isText = (v) => typeof v === 'string' && v !== '';
const isJobId = (v) => typeof v === 'string' && JOB_ID.test(v);

function readJson(file) {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value)}\n`);
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

const realPs = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });

export function processStart(pid, { ps = realPs } = {}) {
  try {
    if (!Number.isInteger(pid) || pid <= 1) return null;
    const r = ps('ps', ['-p', String(pid), '-o', 'lstart=']);
    if (r.error || r.status !== 0) return null;
    const text = String(r.stdout ?? '').trim().replace(/\s+/g, ' ');
    return text === '' ? null : text;
  } catch {
    return null;
  }
}

// Strict: the pid exists and its command line shows check-job.mjs and the exact job id. Unlike
// workerAlive (check-jobs.mjs), a `ps` that is missing (the runner image installs procps, but a
// machine without `ps` still counts as not alive), fails or times out counts as not alive, because
// a signal must never go to a pid that may have been reused.
export function jobWorkerAlive(pid, id, { kill = process.kill, ps = realPs } = {}) {
  try {
    if (!isJobId(id) || !pidAlive(pid, kill)) return false;
    const r = ps('ps', ['-p', String(pid), '-o', 'command=']);
    if (!r || r.error || r.status !== 0) return false;
    const command = ` ${String(r.stdout ?? '').trim()} `;
    return command.includes('check-job.mjs') && command.includes(` ${id} `);
  } catch {
    return false;
  }
}

export function runAlive(e, { kill = process.kill, ps = realPs } = {}) {
  try {
    if (!e || !pidAlive(e.pid, kill)) return false;
    if (e.job != null) return isJobId(e.job) && jobWorkerAlive(e.pid, e.job, { kill, ps });
    if (!isText(e.started)) return false;
    return processStart(e.pid, { ps }) === e.started;
  } catch {
    return false;
  }
}

const runFile = (dir, token) => join(dir, CHECK_RUNNING_DIR, `${token}.json`);
const stopNoteFile = (dir, token) => join(dir, CHECK_RUNNING_DIR, `${token}.stopped`);
const TOKEN = /^[0-9a-f]{16}$/;

// --- The register ------------------------------------------------------------------------

export function enterRun(dir, { pid = process.pid, script = '', job = null, slot = null, story = null, tree = null, at, state = 'started', since = at, started = processStart(pid) } = {}) {
  const entry = { token: randomBytes(8).toString('hex'), pid, script, job, slot, story, tree, at, state, since, started };
  try {
    mkdirSync(join(dir, CHECK_RUNNING_DIR), { recursive: true });
    writeJson(runFile(dir, entry.token), entry);
    return { entry };
  } catch (err) {
    return { error: message(err) };
  }
}

export function setRun(dir, entry, patch) {
  const next = { ...entry, ...patch };
  try {
    if (TOKEN.test(entry.token) && readJson(runFile(dir, entry.token))?.token === entry.token) writeJson(runFile(dir, entry.token), next);
  } catch {
    // the register is only a hint; the run goes on
  }
  return next;
}

export function leaveRun(dir, entry) {
  try {
    if (TOKEN.test(entry.token) && readJson(runFile(dir, entry.token))?.token === entry.token) {
      rmSync(runFile(dir, entry.token), { force: true });
      rmSync(stopNoteFile(dir, entry.token), { force: true });
    }
  } catch {
    // left for the next run to find dead
  }
}

// The note stopRun left for this run, removed as it is read; null when there is none.
export function takeStopNote(dir, token) {
  try {
    if (typeof token !== 'string' || !TOKEN.test(token)) return null;
    const note = readJson(stopNoteFile(dir, token));
    rmSync(stopNoteFile(dir, token), { force: true });
    return note;
  } catch {
    return null;
  }
}

function readRuns(dir) {
  let names;
  try {
    names = readdirSync(join(dir, CHECK_RUNNING_DIR));
  } catch {
    return [];
  }
  const runs = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    const e = readJson(join(dir, CHECK_RUNNING_DIR, name));
    if (e && typeof e.token === 'string' && TOKEN.test(e.token) && `${e.token}.json` === name) runs.push(e);
  }
  return runs;
}

export function liveRuns(dir, { alive = runAlive } = {}) {
  const live = [];
  for (const e of readRuns(dir)) {
    let ok = false;
    try {
      ok = alive(e) === true;
    } catch {
      ok = false;
    }
    if (ok) live.push(e);
    else {
      try {
        if (readJson(runFile(dir, e.token))?.token === e.token) {
          rmSync(runFile(dir, e.token), { force: true });
          rmSync(stopNoteFile(dir, e.token), { force: true });
        }
      } catch {
        // leave it
      }
    }
  }
  return live;
}

const time = (v) => Date.parse(v);

export function olderInWorktree(entries, me) {
  if (!isText(me?.slot) || !isText(me?.tree)) return [];
  return (entries ?? []).filter((e) =>
    e && e.token !== me.token && e.pid !== process.pid && e.slot === me.slot && isText(e.tree) && e.tree !== me.tree
    && (time(e.at) < time(me.at) || (time(e.at) === time(me.at) && String(e.token) < String(me.token))));
}

export function queuedFor(dir, jobId) {
  try {
    return readRuns(dir).some((e) => e.job === jobId && e.state === 'queued');
  } catch {
    return false;
  }
}

export function checkWaits(dir, { alive = runAlive } = {}) {
  const waits = new Map();
  try {
    for (const e of readRuns(dir)) {
      if (e.state !== 'queued' || !isText(e.slot) || waits.has(e.slot)) continue;
      if (alive(e) === true) waits.set(e.slot, { since: e.since ?? null, text: QUEUED_TEXT });
    }
  } catch {
    // status keeping must never fail
  }
  return waits;
}

// --- The machine cap ---------------------------------------------------------------------

export function checkSlotLimit(config, cores) {
  const set = config?.checkRuns?.maxParallel;
  if (Number.isInteger(set) && set >= 1) return set;
  return Math.max(1, Math.floor(Number(cores) / 8) || 1);
}

const seatFile = (dir, n) => join(dir, CHECK_SLOTS_DIR, `${n}.json`);

// Removes the seat file the caller found dead, only if it still holds that holder (or is unreadable
// both times when the caller saw no holder), never a newer one.
function dropSeat(dir, n, holder) {
  try {
    const now = readJson(seatFile(dir, n));
    if ((now === null && !holder) || (holder?.token !== undefined && now?.token === holder.token)) rmSync(seatFile(dir, n), { force: true });
  } catch {
    // leave it
  }
}

export function takeSlot(dir, { max, holder, alive = runAlive }) {
  try {
    mkdirSync(join(dir, CHECK_SLOTS_DIR), { recursive: true });
  } catch (err) {
    return { ok: false, error: message(err) };
  }
  const busy = [];
  for (let n = 0; n < max; n++) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const tmp = `${seatFile(dir, n)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      try {
        writeFileSync(tmp, `${JSON.stringify({ token: holder.token, pid: holder.pid, script: holder.script, job: holder.job ?? null, started: holder.started ?? null, slot: holder.slot, story: holder.story, at: holder.at })}\n`);
        linkSync(tmp, seatFile(dir, n));
        return { ok: true, seat: { n, token: holder.token } };
      } catch (err) {
        if (err?.code !== 'EEXIST') return { ok: false, error: message(err) };
      } finally {
        rmSync(tmp, { force: true });
      }
      let held = readJson(seatFile(dir, n));
      if (!held) held = readJson(seatFile(dir, n));
      let live = false;
      try {
        live = held !== null && alive(held) === true;
      } catch {
        live = false;
      }
      if (live) {
        busy.push(held);
        break;
      }
      dropSeat(dir, n, held);
    }
  }
  return { ok: false, busy };
}

export function releaseSlot(dir, seat) {
  try {
    if (readJson(seatFile(dir, seat.n))?.token === seat.token) rmSync(seatFile(dir, seat.n), { force: true });
  } catch {
    // the next run finds a dead holder and takes it
  }
}

export function releaseSeatsOf(dir, token) {
  try {
    for (const name of readdirSync(join(dir, CHECK_SLOTS_DIR))) {
      if (!/^\d+\.json$/.test(name)) continue;
      const file = join(dir, CHECK_SLOTS_DIR, name);
      if (readJson(file)?.token === token) rmSync(file, { force: true });
    }
  } catch {
    // no seats
  }
}

// --- Stopping a run ----------------------------------------------------------------------

// Every process under rootPid by `pid ppid` lines, deepest first, then rootPid.
export function processTree(rootPid, psText) {
  const kids = new Map();
  for (const line of String(psText ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const [pid, ppid] = [Number(m[1]), Number(m[2])];
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(pid);
  }
  const out = [];
  const seen = new Set([rootPid]);
  const walk = (pid) => {
    for (const kid of kids.get(pid) ?? []) {
      if (seen.has(kid)) continue;
      seen.add(kid);
      walk(kid);
      out.push(kid);
    }
  };
  walk(rootPid);
  out.push(rootPid);
  return out;
}

const realPsText = () => spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 5000 }).stdout ?? null;

// This process and everything above it, by `pid ppid` lines; at least self and its parent.
function ourSide(self, parent, psText) {
  const up = new Map();
  for (const line of String(psText ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) up.set(Number(m[1]), Number(m[2]));
  }
  const side = new Set([self]);
  if (Number.isInteger(parent)) side.add(parent);
  for (const start of [self, parent]) {
    let pid = start;
    for (let hops = 0; up.has(pid) && hops < 1000; hops++) {
      pid = up.get(pid);
      side.add(pid);
    }
  }
  return side;
}

export function killTree(rootPid, { ps = realPsText, kill = process.kill, self = process.pid, parent = process.ppid } = {}) {
  let text = null;
  try {
    text = ps();
  } catch {
    text = null;
  }
  const keep = ourSide(self, parent, text);
  if (keep.has(rootPid)) return; // the root is this process or above it: nothing is signalled
  const pids = typeof text === 'string' && text !== '' ? processTree(rootPid, text) : [rootPid];
  for (const pid of pids) {
    if (keep.has(pid)) continue;
    try {
      kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
}

export function stopRun(dir, e, { supersededBy = null, now = new Date(), alive = runAlive, stopTree = killTree, groupKill = (pid) => process.kill(-pid, 'SIGTERM'), jobAlive = jobWorkerAlive } = {}) {
  try {
    const foreground = e.job == null;
    let live = false;
    try {
      live = (foreground || isJobId(e.job)) && alive(e) === true && e.pid !== process.pid;
    } catch {
      live = false;
    }
    let noted = false;
    if (live) {
      let group = false;
      if (foreground) {
        // Before the signal, so the dying run finds it when its handler runs.
        try {
          if (TOKEN.test(e.token)) {
            writeJson(stopNoteFile(dir, e.token), { supersededBy, at: now.toISOString() });
            noted = true;
          }
        } catch {
          // the run then ends without saying why
        }
      } else {
        try {
          const job = readJob(dir, e.job);
          group = job !== null && job.id === e.job && job.pid === e.pid && jobAlive(job.pid, job.id) === true;
        } catch {
          group = false;
        }
        try {
          if (readResult(dir, e.job) === null) writeResult(dir, e.job, { exit: 1, endedAt: now.toISOString(), supersededBy });
        } catch {
          // the waiter then finds the process gone
        }
      }
      try {
        stopTree(e.pid);
      } catch {
        // already gone
      }
      if (group) {
        try {
          groupKill(e.pid);
        } catch {
          // already gone
        }
      }
    }
    releaseSeatsOf(dir, e.token);
    if (!noted) leaveRun(dir, e);
  } catch {
    // a run left behind is found dead by the next one
  }
}
