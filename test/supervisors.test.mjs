// The shared helper every supervisor test uses (test/supervisors.mjs): its afterEach ends the
// runs a test started, the whole process group, even when the test failed.

import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRepos } from './state-repos.mjs';
import { readPid } from '../plugin/lib/engine/supervisor-pid.mjs';
import { alive } from '../plugin/lib/engine/leash.mjs';
import { runForeman, startChild, startForeman, stopSupervisors, trackedRun, useSupervisors } from './supervisors.mjs';

const made = [];
const folders = [];
afterEach(() => {
  for (const repos of made.splice(0)) repos.cleanup();
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});
// After the hooks above, so it runs before them (vitest runs afterEach hooks last first).
useSupervisors();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// No session ever starts here (there is nothing to build); gh answers the start-up's PR list.
const FAKE_GH = '#!/bin/sh\ncase "$1 $2" in\n  "pr list") echo "[]" ;;\n  *) exit 1 ;;\nesac\n';
const FAKE_CLAUDE = '#!/bin/sh\nexit 1\n';

// An Acme project with nothing to build, a files console, and a clean environment.
function acme() {
  const repos = makeRepos({ version: 1, project: { name: 'Acme' }, console: { adapter: 'files' }, features: { keepAwake: false }, learning: { auto: false } });
  const clone = repos.clone('acme');
  writeFileSync(join(clone, '.gitignore'), '.foreman/\n');
  mkdirSync(join(clone, 'stories'));
  const bin = join(repos.base, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE);
  chmodSync(join(bin, 'gh'), 0o755);
  chmodSync(join(bin, 'claude'), 0o755);
  made.push(repos);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: repos.base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(env)) if (/^(FOREMAN|FACTORY)_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key)) delete env[key];
  return { repos, clone, env, stateDir: join(clone, '.foreman') };
}

async function supervisorOf(stateDir, child = null, ms = 30_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const pid = readPid(stateDir);
    if (pid !== null && alive(pid)) return pid;
    if (child && child.exitCode !== null) throw new Error(`the run exited (${child.exitCode}) before its supervisor started`);
    await sleep(200);
  }
  throw new Error('no supervisor started');
}

const groupGone = (pgid) => {
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (err) {
    return err.code === 'ESRCH';
  }
};

let failedPid = null;

describe('stopSupervisors', () => {
  it('ends a standby run and its whole group', async () => {
    const { clone, env, stateDir } = acme();
    const child = startForeman(['run', '--foreground'], { cwd: clone, env, stateDir });
    const pid = await supervisorOf(stateDir, child);
    expect(pid).not.toBe(child.pid);
    await stopSupervisors();
    expect(alive(pid)).toBe(false);
    expect(alive(child.pid)).toBe(false);
    expect(groupGone(child.pid)).toBe(true);
  }, 60_000);

  it('ends a background run by its state folder', async () => {
    const { clone, env, stateDir } = acme();
    const r = runForeman(['run'], { cwd: clone, env, stateDir });
    expect(r.status).toBe(0);
    const pid = await supervisorOf(stateDir);
    expect(alive(pid)).toBe(true);
    await stopSupervisors();
    expect(alive(pid)).toBe(false);
  }, 60_000);

  it.fails('a failing test still has its supervisor stopped', async () => {
    const { clone, env, stateDir } = acme();
    startForeman(['run', '--foreground'], { cwd: clone, env, stateDir });
    failedPid = await supervisorOf(stateDir);
    throw new Error('forced failure');
  }, 60_000);

  it('the failed test left no supervisor', () => {
    expect(failedPid).toBeGreaterThan(1);
    expect(alive(failedPid)).toBe(false);
  });

  it('never throws with nothing to stop, or a state folder that is gone', async () => {
    await expect(stopSupervisors()).resolves.toBeUndefined();
    const { repos, clone, env, stateDir } = acme();
    runForeman(['status'], { cwd: clone, env, stateDir });
    repos.cleanup();
    expect(existsSync(stateDir)).toBe(false);
    await expect(stopSupervisors()).resolves.toBeUndefined();
  });
});

const waitFor = async (check, ms = 10_000) => {
  const until = Date.now() + ms;
  while (!check() && Date.now() < until) await sleep(50);
  return check();
};
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'foreman-children-'));
  folders.push(dir);
  return dir;
};
const readPidFile = (file) => (existsSync(file) && readFileSync(file, 'utf8').trim() ? Number(readFileSync(file, 'utf8')) : 0);

// A fake foreman.cjs like owner-commands.test.mjs's: writes its pid, then sleeps a minute.
const SLEEPER = "require('node:fs').writeFileSync(process.argv[3], String(process.pid)); setInterval(() => {}, 1000);\n";
// A hook-like child: starts a grandchild that sleeps, and writes both pids.
const PARENT =
  "const { spawn } = require('node:child_process'); const fs = require('node:fs');\n" +
  "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });\n" +
  "fs.writeFileSync(process.argv[1], String(g.pid)); setInterval(() => {}, 1000);\n";

let hookPid = null;
let ownerPid = null;

describe('children the tests start', () => {
  it('startChild ends a child and its whole group', async () => {
    const pidFile = join(scratch(), 'grandchild.pid');
    const child = startChild(process.execPath, ['-e', PARENT, pidFile], {});
    expect(await waitFor(() => readPidFile(pidFile) > 0)).toBe(true);
    const grandchild = readPidFile(pidFile);
    expect(alive(grandchild)).toBe(true);
    await stopSupervisors();
    expect(alive(child.pid)).toBe(false);
    expect(alive(grandchild)).toBe(false);
    expect(groupGone(child.pid)).toBe(true);
  }, 30_000);

  it('trackedRun ends a running owner command', async () => {
    const dir = scratch();
    const fake = join(dir, 'foreman.cjs');
    const pidFile = join(dir, 'owner.pid');
    writeFileSync(fake, SLEEPER);
    const done = trackedRun(process.execPath, [fake, 'learn', pidFile], {});
    let settled = false;
    done.then(() => (settled = true));
    expect(await waitFor(() => readPidFile(pidFile) > 0)).toBe(true);
    const pid = readPidFile(pidFile);
    expect(alive(pid)).toBe(true);
    await stopSupervisors();
    expect(alive(pid)).toBe(false);
    expect(await waitFor(() => settled)).toBe(true);
  }, 30_000);

  it.fails('a failing test still has its hook-like child and owner command ended', async () => {
    const dir = scratch();
    const pidFile = join(dir, 'grandchild.pid');
    startChild(process.execPath, ['-e', PARENT, pidFile], {});
    expect(await waitFor(() => readPidFile(pidFile) > 0)).toBe(true);
    hookPid = readPidFile(pidFile);
    const fake = join(dir, 'foreman.cjs');
    const ownerFile = join(dir, 'owner.pid');
    writeFileSync(fake, SLEEPER);
    trackedRun(process.execPath, [fake, 'learn', ownerFile], {});
    expect(await waitFor(() => readPidFile(ownerFile) > 0)).toBe(true);
    ownerPid = readPidFile(ownerFile);
    throw new Error('forced failure');
  }, 30_000);

  it('the failed test left neither the child nor the owner command', async () => {
    expect(hookPid).toBeGreaterThan(1);
    expect(ownerPid).toBeGreaterThan(1);
    expect(await waitFor(() => !alive(hookPid) && !alive(ownerPid), 3000)).toBe(true);
  });
});
