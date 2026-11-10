// How a test starts Foreman's supervisor (`foreman run`, `cloud run|tick`, or any CLI command
// next to one) and makes sure it ends: a test that starts one and dies, or fails, must not leave
// it running. test/supervisor-guard.test.mjs fails any test file that starts a supervisor
// another way.
//
//   useSupervisors()   registers afterEach(stopSupervisors); call it once at a file's top level
//   startForeman(args, { cwd, env, stdio, bin, stateDir, leash, node }) -> the child: `foreman <args>`
//       run by `node` (this process's Node by default), with spawn, leading its own process group (detached), with FOREMAN_LEASH_PID set to
//       `leash` (this process by default), so a supervisor left behind ends once this test
//       file's worker is gone (plugin/lib/engine/leash.mjs). child.exited resolves with its
//       exit code (null after a signal).
//   runForeman(args, { cwd, env, bin, stateDir, timeout, encoding, input }) -> spawnSync's result,
//       with the same leash
//   startChild(cmd, args, { cwd, env, stdio }) -> the child: any other command a test starts and
//       must see ended (the agent-events hook), with spawn, leading its own process group
//       (detached); child.exited as for startForeman. It adds no state folder.
//   trackedRun(cmd, args, opts) -> runAsync's promise (plugin/lib/engine/run-async.mjs) with its
//       child tracked, for `ownerCommands({ run: trackedRun })`: its group ends with the test
//   endChild(child)    ends a started child's whole group (SIGTERM, then SIGKILL)
//   stopSupervisors()  ends every tracked child's group and the supervisor of every tracked
//       state folder (a background `foreman run`, whose supervisor sits in its own group), all
//       at once and within the 30 s hook limit; never throws
//
// stateDir defaults to the env's FOREMAN_STATE_DIR, else <cwd>/.foreman. The supervisor pid in
// it is noted as soon as runForeman returns, so a test's own afterEach that removes the folder
// first does not hide it.

import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';
import { endGroup, endProcess, LEASH_ENV } from '../plugin/lib/engine/leash.mjs';
import { runAsync } from '../plugin/lib/engine/run-async.mjs';
import { defaultAlive, readPid } from '../plugin/lib/engine/supervisor-pid.mjs';

export const BIN = fileURLToPath(new URL('../plugin/bin/foreman', import.meta.url));

const children = new Set();
const dirs = new Set();
const pids = new Set();

const stateDirOf = (cwd, env, stateDir) => stateDir ?? (env?.FOREMAN_STATE_DIR || join(cwd ?? process.cwd(), '.foreman'));
const withLeash = (env, leash) => ({ ...env, [LEASH_ENV]: String(leash) });

// The supervisor pid a state folder names now, while the folder is surely there.
function notePid(dir) {
  const pid = readPid(dir);
  if (pid !== null) pids.add(pid);
}

export function useSupervisors() {
  afterEach(stopSupervisors);
}

function track(child) {
  child.exited = new Promise((resolve) => {
    child.once('exit', (code) => resolve(code));
    child.once('error', () => resolve(null));
  });
  children.add(child);
  return child;
}

export function startChild(cmd, args, { cwd, env = process.env, stdio = 'ignore' } = {}) {
  return track(spawn(cmd, args, { cwd, env, stdio, detached: true }));
}

export const trackedRun = (cmd, args, opts = {}) => runAsync(cmd, args, { ...opts, track: children });

export function startForeman(args, { cwd, env = process.env, stdio = 'ignore', bin = BIN, stateDir, leash = process.pid, node = process.execPath } = {}) {
  const child = spawn(node, [bin, ...args], { cwd, env: withLeash(env, leash), stdio, detached: true });
  track(child);
  dirs.add(stateDirOf(cwd, env, stateDir));
  return child;
}

export function runForeman(args, { cwd, env = process.env, bin = BIN, stateDir, timeout = 55_000, encoding = 'utf8', input } = {}) {
  const dir = stateDirOf(cwd, env, stateDir);
  dirs.add(dir);
  const r = spawnSync(process.execPath, [bin, ...args], { cwd, env: withLeash(env, process.pid), encoding, timeout, ...(input === undefined ? {} : { input }) });
  notePid(dir);
  return r;
}

export function endChild(child) {
  return endGroup(child?.pid);
}

export async function stopSupervisors() {
  const groups = [...children];
  const folders = [...dirs];
  const noted = [...pids];
  children.clear();
  dirs.clear();
  pids.clear();
  try {
    for (const dir of folders) notePid(dir);
    const supervisors = new Set([...noted, ...pids]);
    pids.clear();
    await Promise.all([
      ...groups.map((child) => endGroup(child.pid).catch(() => 'left')),
      // Only a pid that still runs a supervisor: after a reboot or a long run it may be another program.
      ...[...supervisors].map((pid) => (defaultAlive(pid) ? endProcess(pid) : 'gone')),
    ]);
  } catch {
    // never fails the test it cleans up after
  }
}
