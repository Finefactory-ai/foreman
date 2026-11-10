// The checks `foreman checks --start` runs detached, kept in <stateDir>/check-jobs/ so an agent
// can start them and collect the result with `foreman checks --wait <id>` in calls that each end
// within the Bash tool's time limit (cli/commands/checks.mjs, cli/check-job.mjs). Four files per
// run, all named by its id:
//
//   <id>.json         the job: { id, pid, slot, story, cwd, args, startedAt }; pid is the worker's
//                     process, which leads its own process group
//   <id>.out, <id>.err  what the run printed on stdout and stderr, byte for byte
//   <id>.result.json  { exit, endedAt }, written when the run ended; its absence with a dead
//                     process means the run was killed. A run that a newer run in its worktree
//                     stopped (engine/check-slots.mjs stopRun) also carries `supersededBy`: the
//                     newer run's job id, or null when it has none (a foreground run)
//
// A detached run is outside its session's process group, so the supervisor ends the leftovers
// itself (endCheckJobs, called when a session ends and at start). Old jobs are pruned each time
// one starts (pruneJobs). A job file can outlive its process by any time, and the pid may since
// belong to another program, so nothing is signalled or called running on the pid alone:
// workerAlive checks that the pid's command line is this job's worker (as handover.mjs
// sessionAlive does for sessions). A group left behind by a worker that has gone is accepted only
// for the SIGKILL follow-up the supervisor sends 10 s after its own SIGTERM (killLeftGroup): a
// sweep that took it could signal an unrelated group after the pid was reused.
//
//   jobsDir(stateDirPath), jobFiles(stateDirPath, id) -> { job, out, err, result }
//   newJobId({ slot, now, random }) -> an id that matches JOB_ID (the slot is cleaned to [A-Za-z0-9-])
//   writeJob / readJob, writeResult / readResult, listJobs, removeJob
//   pidAlive(pid, kill) -> whether the process exists
//   workerAlive(job, { kill, ps, procStat }) -> the process exists and `ps` shows it is that job's
//       worker (`check-job.mjs` and the id in its command line). When ps cannot run, Z or X in
//       /proc/<pid>/stat means the worker has ended; with no /proc, the kill check decides.
//   groupOurs(job, { kill, ps, procStat, left }) -> a process group this job's live worker leads
//       and that can be signalled; with `left` also the group a gone worker left
//   killLeftGroup(job, { kill, ps, procStat }) -> SIGKILL to such a group; whether it was sent
//   endCheckJobs(stateDirPath, { keep, groupAlive, kill }) -> { ended }
//   pruneJobs(stateDirPath, { now, maxAgeMs, alive })
//
// Files are written through a temp file renamed into place, so a reader never sees half of one.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const CHECK_JOBS_DIR = 'check-jobs';
export const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,80}$/;

const DAY_MS = 24 * 60 * 60 * 1000;

export const jobsDir = (stateDirPath) => join(stateDirPath, CHECK_JOBS_DIR);

export function jobFiles(stateDirPath, id) {
  const base = join(jobsDir(stateDirPath), id);
  return { job: `${base}.json`, out: `${base}.out`, err: `${base}.err`, result: `${base}.result.json` };
}

export function newJobId({ slot, now, random = () => randomBytes(3).toString('hex') }) {
  const part = String(slot ?? '').replace(/[^A-Za-z0-9-]/g, '').replace(/^-+/, '').slice(0, 40) || 'here';
  return `${part}-${now.getTime().toString(36)}-${random()}`;
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`);
  renameSync(tmp, file);
}

function readJson(file) {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export function writeJob(stateDirPath, job) {
  const { id, pid, slot, story, cwd, args, startedAt } = job;
  writeJson(jobFiles(stateDirPath, id).job, { id, pid, slot, story, cwd, args, startedAt });
}

export const readJob = (stateDirPath, id) => readJson(jobFiles(stateDirPath, id).job);

export function writeResult(stateDirPath, id, { exit, endedAt, supersededBy }) {
  writeJson(jobFiles(stateDirPath, id).result, { exit, endedAt, ...(supersededBy !== undefined ? { supersededBy } : {}) });
}

export const readResult = (stateDirPath, id) => readJson(jobFiles(stateDirPath, id).result);

export function listJobs(stateDirPath) {
  let names;
  try {
    names = readdirSync(jobsDir(stateDirPath));
  } catch {
    return [];
  }
  const jobs = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json') || name.endsWith('.result.json')) continue;
    const j = readJson(join(jobsDir(stateDirPath), name));
    if (j && typeof j.id === 'string' && JOB_ID.test(j.id)) jobs.push(j);
  }
  return jobs;
}

// Signal 0 reaches a process that exists, EPERM included (it is there, just not ours).
function reachable(target, kill) {
  try {
    kill(target, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

export function pidAlive(pid, kill = process.kill) {
  return Number.isInteger(pid) && pid > 1 && reachable(pid, kill);
}

const realPs = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

const realProcStat = (pid) => {
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
};

// The state letter in /proc/<pid>/stat: the first one after the last ')', since the command name
// in parentheses may hold one itself.
const procState = (text) => text.slice(text.lastIndexOf(')') + 1).trim()[0];

// The process with this job's pid is the job's worker, not a program that got the pid since.
export function workerAlive(job, { kill = process.kill, ps = realPs, procStat = realProcStat } = {}) {
  if (!job || !pidAlive(job.pid, kill)) return false;
  const r = ps('ps', ['-p', String(job.pid), '-o', 'command=']);
  if (r.error) {
    // No ps: a zombie or dead process still answers the kill check, so read its state; with no /proc the kill check decides.
    const stat = procStat(job.pid);
    return typeof stat === 'string' ? !['Z', 'X'].includes(procState(stat)) : true;
  }
  const command = ` ${String(r.stdout ?? '').trim()} `;
  return r.status === 0 && command.includes('check-job.mjs') && command.includes(` ${job.id} `);
}

// The pid leads a process group that is there and ours to signal, never EPERM. A live worker is
// ours. With `left`, so is the group a gone worker left: it still carries the pid. But a
// leader-less group could also be an unrelated program's after pid reuse, so only the follow-up to
// the supervisor's own SIGTERM asks for it.
export function groupOurs(job, { kill = process.kill, ps = realPs, procStat = realProcStat, left = false } = {}) {
  if (!job || !Number.isInteger(job.pid) || job.pid <= 1) return false;
  if (workerAlive(job, { kill, ps, procStat })) return true;
  if (!left) return false;
  if (pidAlive(job.pid, kill)) return false; // a process by that pid that is not the worker
  try {
    kill(-job.pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The SIGKILL follow-up, 10 s after the supervisor's SIGTERM: only to a group that is still ours.
// Never throws.
export function killLeftGroup(job, { kill = process.kill, ps = realPs, procStat = realProcStat } = {}) {
  try {
    if (!groupOurs(job, { kill, ps, procStat, left: true })) return false;
    kill(-job.pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

export function removeJob(stateDirPath, id) {
  for (const file of Object.values(jobFiles(stateDirPath, id))) rmSync(file, { force: true });
}

// Ends the runs of the jobs `keep` does not name that have no result and whose process group is
// still there (SIGTERM; the caller follows up with SIGKILL), and removes the files of every job
// `keep` does not name. Never throws.
export function endCheckJobs(stateDirPath, { keep = () => false, groupAlive = (_pid, j) => groupOurs(j), kill = (pid, sig) => process.kill(-pid, sig) } = {}) {
  const ended = [];
  try {
    for (const j of listJobs(stateDirPath)) {
      if (keep(j)) continue;
      try {
        if (!readResult(stateDirPath, j.id) && groupAlive(j.pid, j)) {
          ended.push(j);
          try {
            kill(j.pid, 'SIGTERM');
          } catch {
            // already gone
          }
        }
        removeJob(stateDirPath, j.id);
      } catch {
        // leave this one; the next sweep tries again
      }
    }
  } catch {
    // nothing more to do
  }
  return { ended };
}

// Removes the jobs whose result, or for a dead job with none its start, is older than maxAgeMs.
export function pruneJobs(stateDirPath, { now, maxAgeMs = DAY_MS, alive = (_pid, j) => workerAlive(j) } = {}) {
  const t = (now ?? new Date()).getTime();
  for (const j of listJobs(stateDirPath)) {
    try {
      const result = readResult(stateDirPath, j.id);
      const at = Date.parse(result ? result.endedAt : j.startedAt);
      if (result ? false : alive(j.pid, j)) continue;
      if (Number.isFinite(at) && t - at > maxAgeMs) removeJob(stateDirPath, j.id);
    } catch {
      // keep it
    }
  }
}
