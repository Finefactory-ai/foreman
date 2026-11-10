// Which supervisor runs for a state folder, whether the owner stopped the service, and which
// earlier supervisors' pids still stand for running sessions. The files sit directly under the
// state folder and stay on this machine: none is in the branch store's KEEP list
// (lib/state-store/branch.mjs), so a pid never travels to another computer.
//
//   supervisor.pid     the running supervisor's pid, written at start and removed as it exits
//   service-stopped    left by `foreman stop`; a run started by the service manager
//                      (`foreman run --service`) waits for a plain `foreman run` while it is there.
//                      It holds one JSON line, the record of who stopped the run
//                      (console/stopper.mjs), the same as STOP
//   supervisor-adopted.json
//                      { by, pids }: after a restart on new code (supervisor.mjs), the sessions
//                      left running hold claims and locks under the pid of the supervisor that
//                      started them, which has exited. While the process `by` lives, the pids
//                      listed count as alive for those locks (locks.mjs aliveIn). The old
//                      supervisor writes it as it exits, vouched for by its parent (run.mjs
//                      startSupervisor's loop); the new one writes it again, vouched for by
//                      itself, and removes it as it exits.
//
//   writePid(dir, pid), readPid(dir) -> number | null, clearPid(dir, pid) removes the file only
//       when it still holds that pid (a newer supervisor's file stays)
//   runningSupervisor(dir, { alive }) -> the pid of a live supervisor, or null. A pid file left by
//       a run that died, or one whose pid now belongs to another program (after a reboot), is null.
//   defaultAlive(pid) -> the process exists (EPERM counts) and `ps` says it runs supervisor.mjs;
//       when ps itself cannot run, the kill check alone decides
//   markStopped(dir, now, record), clearStopped(dir), isStopped(dir); record defaults to { at }
//   writeAdopted(dir, { by, pids }) through a temp file; readAdopted(dir) -> { by, pids } or null
//       (no file, or one that is not that shape); clearAdopted(dir, by) removes the file only when
//       `by` vouches for it; dropAdopted(dir) removes it whoever vouches for it: a fresh start
//       removes any left behind, since no handover is in flight
//   pidExists(pid) -> the process exists (EPERM counts): the default check for a voucher, and what
//       engine/stale-control.mjs uses to find a voucher that is gone
//   adoptedAlive(dir, pid, { alive }) -> pid is listed and its voucher is alive. The default check
//       is pidExists, not defaultAlive: the voucher may be run.mjs.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PID_FILE = 'supervisor.pid';
export const STOPPED_FILE = 'service-stopped';
export const ADOPTED_FILE = 'supervisor-adopted.json';

export function writePid(dir, pid) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, PID_FILE), `${pid}\n`);
}

export function readPid(dir) {
  let text;
  try {
    text = readFileSync(join(dir, PID_FILE), 'utf8').trim();
  } catch {
    return null;
  }
  if (!/^\d+$/.test(text)) return null;
  const pid = Number(text);
  return pid > 0 ? pid : null;
}

export function clearPid(dir, pid) {
  if (readPid(dir) === pid) rmSync(join(dir, PID_FILE), { force: true });
}

export function defaultAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err?.code !== 'EPERM') return false;
  }
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  if (r.error) return true;
  return r.status === 0 && String(r.stdout).includes('supervisor.mjs');
}

export function runningSupervisor(dir, { alive = defaultAlive } = {}) {
  const pid = readPid(dir);
  return pid !== null && alive(pid) ? pid : null;
}

export function markStopped(dir, now = new Date(), record = { at: now.toISOString() }) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, STOPPED_FILE), `${JSON.stringify(record)}\n`);
}

export function clearStopped(dir) {
  rmSync(join(dir, STOPPED_FILE), { force: true });
}

export const isStopped = (dir) => existsSync(join(dir, STOPPED_FILE));

const isPid = (v) => Number.isInteger(v) && v > 0;

// The process exists; EPERM means it runs as someone else.
export function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

export function writeAdopted(dir, { by, pids }) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, ADOPTED_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ by, pids })}\n`);
  renameSync(tmp, file);
}

export function readAdopted(dir) {
  let value;
  try {
    value = JSON.parse(readFileSync(join(dir, ADOPTED_FILE), 'utf8'));
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || !isPid(value.by) || !Array.isArray(value.pids)) return null;
  return { by: value.by, pids: value.pids.filter(isPid) };
}

export function adoptedAlive(dir, pid, { alive = pidExists } = {}) {
  const adopted = readAdopted(dir);
  return Boolean(adopted && adopted.pids.includes(pid) && alive(adopted.by));
}

export function clearAdopted(dir, by) {
  if (readAdopted(dir)?.by === by) rmSync(join(dir, ADOPTED_FILE), { force: true });
}

export function dropAdopted(dir) {
  rmSync(join(dir, ADOPTED_FILE), { force: true });
}
