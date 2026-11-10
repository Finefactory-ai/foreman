// A supervisor that belongs to a test or a scratch copy ends on its own (supervisor.mjs): when
// the process that started it is gone, or after a short time on standby. A real run has
// neither limit. Also how a test or a stray count ends a supervisor and its process group.
//
//   LEASH_ENV (FOREMAN_LEASH_PID): the supervisor ends when this pid is gone. Tests set it
//       (test/supervisors.mjs), and `foreman run` sets it in a story session to the shell
//       that ran it (commands/run.mjs).
//   IDLE_ENV (FOREMAN_IDLE_EXIT_MS): the idle limit, read only for a supervisor that already
//       has a leash (a leash pid, or a state folder under the temp folder). IDLE_EXIT_MS (5 min)
//       when it is not a positive whole number.
//   canonical(p) -> p absolute with symlinks resolved, through its nearest existing folder
//   tempRoots({ tmpdir }) -> the canonical temp folders: the system one and /tmp
//   underTemp(path, roots) -> path, made canonical, is a root or inside one
//   leashOf({ dir, env, roots }) -> { parent, idleMs }: parent the leash pid (a whole number
//       above 1) or null; idleMs set when there is a parent or the state folder `dir` is under
//       a temp root, else null. A real run gets { parent: null, idleMs: null }.
//   leashVerdict({ leash, alive, standbySince, now }) -> null, or { reason } to stop with: the
//       parent gone first, then standby that lasted idleMs
//   alive(pid) -> the process exists (EPERM counts)
//   endGroup(pgid, opts), endProcess(pid, opts) -> 'gone' | 'killed' | 'left': SIGTERM, a wait
//       of up to waitMs (15 s) polled every 100 ms, then SIGKILL and up to killWaitMs (2 s).
//       Never throw. endGroup never signals a group id that is not a pid above 1 (kill(-0)
//       would reach the caller's own group); endProcess never signals this process or a pid of
//       1 or less. Either gives 'left' for a target it refuses.

import { realpathSync } from 'node:fs';
import os from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

export const LEASH_ENV = 'FOREMAN_LEASH_PID';
export const IDLE_ENV = 'FOREMAN_IDLE_EXIT_MS';
export const IDLE_EXIT_MS = 5 * 60_000;

const POLL_MS = 100;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A whole number written as digits only, or null.
const wholeNumber = (v) => (/^\d+$/.test(String(v ?? '').trim()) ? Number(String(v).trim()) : null);

// run-guard.mjs canonicalPath, but through the nearest folder that exists when p does not: a
// state folder not made yet still reads /private/var/... on macOS, as its temp root does.
export function canonical(p) {
  const tail = [];
  for (let head = resolve(p); ; ) {
    try {
      return join(realpathSync(head), ...tail.reverse());
    } catch {
      const up = dirname(head);
      if (up === head) return resolve(p);
      tail.push(basename(head));
      head = up;
    }
  }
}

export function tempRoots({ tmpdir = os.tmpdir() } = {}) {
  return [...new Set([tmpdir, '/tmp'].map(canonical))];
}

export function underTemp(path, roots) {
  if (!path) return false;
  const p = canonical(path);
  return (roots ?? []).some((root) => {
    const r = canonical(root);
    return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
  });
}

export function leashOf({ dir, env = {}, roots = tempRoots() } = {}) {
  const pid = wholeNumber(env?.[LEASH_ENV]);
  const parent = pid !== null && pid > 1 ? pid : null;
  if (parent === null && !underTemp(dir, roots)) return { parent: null, idleMs: null };
  const idle = wholeNumber(env?.[IDLE_ENV]);
  return { parent, idleMs: idle !== null && idle > 0 ? idle : IDLE_EXIT_MS };
}

export const parentGoneReason = (pid) => `Stopped: the process that started this run (pid ${pid}) has ended.`;
export const idleReason = (ms) => `Stopped: on standby for ${Math.max(1, Math.round(ms / 60000))} min, and this run belongs to a test or a scratch copy.`;

export function leashVerdict({ leash, alive: isAlive = alive, standbySince = null, now = Date.now() }) {
  if (!leash) return null;
  if (leash.parent !== null && leash.parent !== undefined && !isAlive(leash.parent)) return { reason: parentGoneReason(leash.parent) };
  if (leash.idleMs !== null && leash.idleMs !== undefined && standbySince !== null && now - standbySince >= leash.idleMs) return { reason: idleReason(leash.idleMs) };
  return null;
}

export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

const isPidAbove1 = (n) => Number.isInteger(n) && n > 1;

// SIGTERM to target, wait, SIGKILL, wait (see the header). `exists()` says whether it is there.
async function end(target, { kill, exists, sleep, waitMs, killWaitMs }) {
  const send = (signal) => {
    try {
      kill(target, signal);
    } catch {
      // gone, or not ours to signal: the polls below say which
    }
  };
  const waitGone = async (ms) => {
    for (let waited = 0; ; waited += POLL_MS) {
      if (!exists()) return true;
      if (waited >= ms) return false;
      await sleep(POLL_MS);
    }
  };
  try {
    send('SIGTERM');
    if (await waitGone(waitMs)) return 'gone';
    send('SIGKILL');
    return (await waitGone(killWaitMs)) ? 'killed' : 'left';
  } catch {
    return 'left';
  }
}

// Whether kill(target, 0) finds it: EPERM counts as there, any other error as gone.
const existsWith = (kill, target) => () => {
  try {
    kill(target, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
};

export async function endGroup(pgid, { kill = process.kill.bind(process), isAlive, sleep = pause, waitMs = 15_000, killWaitMs = 2_000 } = {}) {
  if (!isPidAbove1(pgid)) return 'left';
  return end(-pgid, { kill, exists: isAlive ? () => isAlive(pgid) : existsWith(kill, -pgid), sleep, waitMs, killWaitMs });
}

export async function endProcess(pid, { kill = process.kill.bind(process), isAlive, sleep = pause, waitMs = 15_000, killWaitMs = 2_000 } = {}) {
  if (!isPidAbove1(pid) || pid === process.pid) return 'left';
  return end(pid, { kill, exists: isAlive ? () => isAlive(pid) : existsWith(kill, pid), sleep, waitMs, killWaitMs });
}
