// A child command that never holds the event loop: spawned, not spawnSync'd, with a time limit
// that ends everything it started. For the commands the dashboard and the supervisor run for the
// owner that may take minutes (the set-up step checks, `foreman notify`, `foreman learn`).
//
//   runAsync(cmd, args, { cwd, env, timeoutMs, graceMs, track, keepBytes })
//       -> Promise<{ status, signal, stdout, stderr, timedOut, ms, error? }>
//
// It never rejects. The child leads its own process group (detached), so at timeoutMs the whole
// group gets SIGKILL and timedOut is true; when the output has not closed graceMs after that
// (something outside the group still holds the pipes), the streams are destroyed and it settles
// anyway. When the child exits, anything still left in its group, such as a job sent to the
// background, is killed too, as setup/project.mjs runCheckCommand does. A command that cannot
// start settles { status: null, error: <message> }. Only the last keepBytes of each stream are
// kept. `track`, a Set, holds the child while it runs, so its owner can end the group early (the
// dashboard does on close). With no timeoutMs there is no time limit.

import { spawn } from 'node:child_process';

export const KEEP_BYTES = 64 * 1024;
export const GRACE_MS = 2000;

const killGroup = (pid) => {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // the group is gone already
  }
};

export function runAsync(cmd, args = [], { cwd, env = process.env, timeoutMs, graceMs = GRACE_MS, track, keepBytes = KEEP_BYTES } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const kept = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    let timedOut = false;
    let settled = false;
    let timer = null;
    let grace = null;
    let child = null;

    const settle = (fields) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      if (child) track?.delete(child);
      resolve({ status: null, signal: null, stdout: kept.stdout.toString('utf8'), stderr: kept.stderr.toString('utf8'), timedOut, ms: Date.now() - started, ...fields });
    };
    const keep = (name) => (chunk) => {
      const all = Buffer.concat([kept[name], chunk]);
      kept[name] = all.length > keepBytes ? all.subarray(all.length - keepBytes) : all;
    };

    try {
      child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      settle({ error: String(err?.message ?? err) });
      return;
    }
    track?.add(child);
    child.stdout.on('data', keep('stdout'));
    child.stderr.on('data', keep('stderr'));
    child.on('error', (err) => settle({ error: String(err?.message ?? err) }));
    child.on('close', (status, signal) => {
      if (child.pid) killGroup(child.pid);
      settle({ status, signal });
    });
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        if (child.pid) killGroup(child.pid);
        grace = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          settle({ status: child.exitCode, signal: child.signalCode ?? 'SIGKILL' });
        }, graceMs);
      }, timeoutMs);
    }
  });
}
