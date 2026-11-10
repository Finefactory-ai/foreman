// A real `foreman run` whose dashboard is asked to test the "Tools and checks" step while the
// project's check is slow (a fake `sleep 30` in place of `npm test`): the check runs in a child of
// its own, so the supervisor keeps ticking (a pause is applied), the dashboard answers, and
// `foreman stop` ends the check with the run. A fake `claude` and `gh` on the PATH stand in for
// the session and GitHub; there are no stories, so the run goes to standby.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRepos } from '../../../test/state-repos.mjs';
import { fastTick } from '../../../test/fast-tick.mjs';
import { runForeman, startForeman, useSupervisors } from '../../../test/supervisors.mjs';

const FAKE_CLAUDE = `#!/bin/sh
exit 1
`;
const FAKE_GH = `#!/bin/sh
case "$1 $2" in
  "pr list") echo "[]" ;;
  *) exit 1 ;;
esac
`;

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

let repos;
let clone;
let bin;
let marks;
let mark;
let port;
let child;

beforeEach(async () => {
  port = await freePort();
  marks = mkdtempSync(join(tmpdir(), 'foreman-setup-check-mark-'));
  mark = join(marks, 'mark');
  repos = makeRepos({
    version: 1,
    project: { name: 'Acme' },
    console: { adapter: 'dashboard', port },
    features: { keepAwake: false },
    learning: { auto: false },
    checks: [{ run: `echo $$ >> "${mark}"; sleep 30`, when: 'always' }],
  });
  clone = repos.clone('acme');
  writeFileSync(join(clone, '.gitignore'), '.foreman/\n');
  mkdirSync(join(clone, 'stories'));
  bin = join(repos.base, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE);
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  chmodSync(join(bin, 'claude'), 0o755);
  chmodSync(join(bin, 'gh'), 0o755);
  child = null;
});
afterEach(() => {
  for (const pid of markPids()) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // gone already
    }
  }
  repos.cleanup();
  rmSync(marks, { recursive: true, force: true });
});
// After the hooks above, so it runs before them (vitest runs afterEach hooks last first).
useSupervisors();

const runEnv = () => {
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: repos.base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(env)) if (/^(FOREMAN|FACTORY)_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key)) delete env[key];
  return { ...env, ...fastTick };
};
const foreman = (...args) => runForeman(args, { cwd: clone, env: runEnv(), encoding: 'utf8', timeout: 30_000 });

const stateDir = () => join(clone, '.foreman');
const loop = () => {
  try {
    return JSON.parse(readFileSync(join(stateDir(), 'state.json'), 'utf8')).loop ?? null;
  } catch {
    return null;
  }
};
const events = () => {
  const file = join(stateDir(), 'events.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).text) : [];
};
function markPids() {
  return mark && existsSync(mark) ? readFileSync(mark, 'utf8').split('\n').filter(Boolean).map(Number) : [];
}
const gone = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err.code === 'ESRCH';
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(what, test, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (test()) return;
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`the run exited (${child.exitCode}) while waiting for ${what}`);
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}; loop ${JSON.stringify(loop())}`);
}

describe('foreman run while the dashboard tests a slow set-up step', () => {
  it('keeps ticking and answering, and `foreman stop` ends the check with the run', async () => {
    let out = '';
    child = startForeman(['run', '--foreground'], { cwd: clone, env: runEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));

    await waitFor('standby', () => loop()?.state === 'standby', 30_000);
    await waitFor('the dashboard', () => out.includes('Dashboard: '), 10_000);
    const base = `http://127.0.0.1:${port}`;

    const check = fetch(`${base}/api/setup/steps/tools/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => null);
    await waitFor('the check to start', () => markPids().length > 0, 20_000);
    const [pid] = markPids();

    const started = Date.now();
    const status = await fetch(`${base}/api/status`);
    expect(status.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(2000);
    const setup = await (await fetch(`${base}/api/setup`)).json();
    expect(setup.steps.find((s) => s.id === 'tools').checking).toBe(true);

    expect(foreman('pause').status).toBe(0);
    await waitFor('the pause', () => loop()?.state === 'paused', 10_000);
    expect(gone(pid)).toBe(false);

    expect(foreman('stop').status).toBe(0);
    expect(await child.exited).toBe(0);
    await waitFor('the check to end', () => gone(pid), 5000);
    await check;
    expect(events().filter((t) => /woke/.test(t))).toEqual([]);
  }, 120_000);
});
