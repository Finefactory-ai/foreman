// A supervisor started by a test or in a scratch copy ends on its own (leash.mjs): once the
// process named by FOREMAN_LEASH_PID is gone, and after the idle limit on standby. A fake
// `claude` and `gh` on the PATH stand in for the session and GitHub; nothing is buildable, so
// the run goes on standby.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRepos } from '../../../test/state-repos.mjs';
import { fastTick } from '../../../test/fast-tick.mjs';
import { startForeman, useSupervisors } from '../../../test/supervisors.mjs';
import { readPid } from './supervisor-pid.mjs';
import { alive } from './leash.mjs';

const FAKE_CLAUDE = '#!/bin/sh\nexit 1\n';
const FAKE_GH = '#!/bin/sh\ncase "$1 $2" in\n  "pr list") echo "[]" ;;\n  *) exit 1 ;;\nesac\n';

let repos;
let clone;
let bin;
let sleeper;

beforeEach(() => {
  repos = makeRepos({ version: 1, project: { name: 'Acme' }, console: { adapter: 'files' }, features: { keepAwake: false }, learning: { auto: false } });
  clone = repos.clone('acme');
  writeFileSync(join(clone, '.gitignore'), '.foreman/\n');
  mkdirSync(join(clone, 'stories'));
  bin = join(repos.base, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE);
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  chmodSync(join(bin, 'claude'), 0o755);
  chmodSync(join(bin, 'gh'), 0o755);
  sleeper = null;
});
afterEach(() => {
  try {
    sleeper?.kill('SIGKILL');
  } catch {
    // already gone
  }
  repos.cleanup();
});
// After the hooks above, so it runs before them (vitest runs afterEach hooks last first).
useSupervisors();

const runEnv = (extra = {}) => {
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: repos.base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(env)) if (/^(FOREMAN|FACTORY)_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key)) delete env[key];
  return { ...env, ...fastTick, ...extra };
};
const stateDir = () => join(clone, '.foreman');
const state = () => {
  try {
    return JSON.parse(readFileSync(join(stateDir(), 'state.json'), 'utf8'));
  } catch {
    return {};
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(what, test, ms, child) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (test()) return;
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`the run exited (${child.exitCode}) while waiting for ${what}`);
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}; loop ${JSON.stringify(state().loop)}`);
}

describe('a leashed supervisor', () => {
  it('stops within a minute once the process that started it is gone', async () => {
    sleeper = spawn('sleep', ['300'], { stdio: 'ignore' });
    const child = startForeman(['run', '--foreground'], { cwd: clone, env: runEnv(), leash: sleeper.pid, stateDir: stateDir() });
    await waitFor('standby', () => state().loop?.state === 'standby' && readPid(stateDir()) !== null, 30_000, child);
    const pid = readPid(stateDir());
    expect(alive(pid)).toBe(true);

    const killedAt = Date.now();
    sleeper.kill('SIGKILL');
    await waitFor('the supervisor to end', () => !alive(pid), 60_000);
    expect(Date.now() - killedAt).toBeLessThan(60_000);
    expect(await child.exited).toBe(0);
    expect(state().loop).toMatchObject({ state: 'stopped' });
    expect(state().loop.reason).toMatch(/^Stopped: the process that started this run/);
    expect(state().loop.reason).toContain(`(pid ${sleeper.pid})`);
    // A leashed run never looks for strays.
    expect(Object.keys(state())).not.toContain('strays');
    expect(existsSync(join(stateDir(), 'supervisor.pid'))).toBe(false);
  }, 90_000);

  it('stops after the idle limit on standby while its parent lives', async () => {
    const child = startForeman(['run', '--foreground'], { cwd: clone, env: runEnv({ FOREMAN_IDLE_EXIT_MS: '1500' }), stateDir: stateDir() });
    const code = await Promise.race([child.exited, sleep(30_000).then(() => 'timeout')]);
    expect(code).toBe(0);
    expect(state().loop).toMatchObject({ state: 'stopped' });
    expect(state().loop.reason).toMatch(/^Stopped: on standby for/);
  }, 45_000);
});
