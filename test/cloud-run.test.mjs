// `foreman cloud run` end to end, as the container runs it but without the container: the
// real CLI and supervisor, a temp git remote (FOREMAN_REPO_URL), and fake `claude` and `gh`
// on the PATH. The fake session marks its story done through `foreman story` and reports it
// shipped; the ship step itself is the session's, so no pull request is made here.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fastTick } from './fast-tick.mjs';
import { git, makeRepos } from './state-repos.mjs';
import { runForeman, startForeman, useSupervisors } from './supervisors.mjs';

const BIN = fileURLToPath(new URL('../plugin/bin/foreman', import.meta.url));
const PLUGIN = fileURLToPath(new URL('../plugin', import.meta.url));
const STORY = (id) => `---\nid: ${id}\ntitle: Story ${id}\nstatus: todo\ndepends_on: []\n---\n\nDo ${id}.\n\n## Progress notes\n`;

const FAKE_CLAUDE = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const id = process.env.FOREMAN_STORY;
appendFileSync(process.env.FAKE_LOG, 'claude ' + (id || 'check') + ' resend=' + (process.env.RESEND_API_KEY ? 'set' : 'unset') + '\\n');
if (!id) {
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }));
  process.exit(0);
}
const foreman = (...args) => spawnSync(process.execPath, [${JSON.stringify(BIN)}, ...args], { stdio: 'ignore' }).status; // supervisor-guard: not a supervisor
if (foreman('story', 'start', id) !== 0 || foreman('story', 'done', id, '--note', 'shipped by the fake session') !== 0) process.exit(1);
const result = 'FACTORY_RESULT: shipped ' + id;
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake' }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, result, total_cost_usd: 0.5, session_id: 'fake' }));
`;

const FAKE_GH = `#!/bin/sh
echo "gh $*" >> "$FAKE_LOG"
case "$1 $2" in
  "auth setup-git") exit 0 ;;
  "api user") echo "octo 42" ;;
  "api repos/acme/app") echo "true" ;;
  "api repos/acme/app/pulls?"*) ;;
  "pr list") echo "[]" ;;
  *) exit 1 ;;
esac
`;

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

let repos;
let seed;
let work;
let bin;
let log;
let port;

beforeEach(async () => {
  port = await freePort();
  repos = makeRepos({ version: 1, project: { name: 'T' }, install: null, console: { adapter: 'dashboard', port }, cloud: { envVars: ['RESEND_API_KEY'], idleMinutes: 0.02 } });
  seed = repos.clone('seed2');
  mkdirSync(join(seed, 'stories'));
  writeFileSync(join(seed, 'stories', 'S-1.md'), STORY('S-1'));
  writeFileSync(join(seed, '.gitignore'), '.env.local\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-qm', 'Add a story');
  git(seed, 'push', '-q', 'origin', 'main');
  work = join(repos.base, 'work');
  mkdirSync(work);
  bin = join(repos.base, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE);
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  chmodSync(join(bin, 'claude'), 0o755);
  chmodSync(join(bin, 'gh'), 0o755);
  log = join(repos.base, 'calls.log');
  writeFileSync(log, '');
});
afterEach(() => repos.cleanup());
// After the hooks above, so it runs before them (vitest runs afterEach hooks last first).
useSupervisors();

const runnerEnv = (extra = {}) => {
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: work,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    FAKE_LOG: log,
    FOREMAN_REPO: 'acme/app',
    FOREMAN_REPO_URL: repos.remote,
    GH_TOKEN: 'ghp_fake_token_for_the_test',
    ANTHROPIC_API_KEY: 'sk-ant-fake-key-for-the-test',
    FOREMAN_PLUGIN_DIR: PLUGIN,
    FOREMAN_WORK: work,
    FOREMAN_DASHBOARD_HOST: '0.0.0.0',
    FOREMAN_DASHBOARD_TOKEN: 'a-dashboard-token-of-enough-length',
    RESEND_API_KEY: 're_end_to_end',
    ...extra,
  };
  for (const key of Object.keys(env)) if (/^FACTORY_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'FOREMAN_STATE_DIR', 'FOREMAN_PROJECT_DIR', 'FOREMAN_RUN', 'FOREMAN_SLOT', 'FOREMAN_STATE_SYNC'].includes(key)) delete env[key];
  Object.assign(env, fastTick);
  return env;
};
const sessions = () => readFileSync(log, 'utf8').split('\n').filter((l) => /^claude S-/.test(l));
const overlay = (id) => JSON.parse(readFileSync(join(work, 'state', 'stories', `${id}.json`), 'utf8'));

describe('foreman cloud run, end to end', () => {
  it('clones the project, builds the stories asked for, and exits (FOREMAN_MAX)', () => {
    const r = runForeman(['cloud', 'run'], { cwd: work, env: runnerEnv({ FOREMAN_MAX: '1' }), encoding: 'utf8', timeout: 90_000, stateDir: join(work, 'state') });
    expect(r.stderr).not.toMatch(/foreman: |Not starting/);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^ok {4}claude answers$/m);
    expect(r.stdout).toMatch(/^warn {2}pull request checks — acme\/app has no pull request yet/m);
    expect(r.stdout).toContain('Reached the 1 story asked for.');
    // the run's events reach the container's log: the real supervisor's story start
    expect(r.stdout).toMatch(/^\S+ story w1 Slot w1: S-1$/m);
    expect(r.stdout).toMatch(new RegExp(`Dashboard: http://0\\.0\\.0\\.0:${port}/`));
    expect(existsSync(join(work, 'repo', 'stories', 'S-1.md'))).toBe(true);
    expect(sessions()).toEqual(['claude S-1 resend=unset']);
    expect(overlay('S-1').status).toBe('done');
    // Foreman's own key goes to .env.foreman, which the runner keeps out of git with .git/info/exclude
    expect(readFileSync(join(work, 'repo', '.env.foreman'), 'utf8')).toContain('RESEND_API_KEY=');
    expect(existsSync(join(work, 'repo', '.env.local'))).toBe(false);
    expect(readFileSync(join(work, 'repo', '.git', 'info', 'exclude'), 'utf8').split('\n')).toContain('.env.foreman');
    for (const out of [r.stdout, r.stderr]) {
      expect(out).not.toContain('re_end_to_end');
      expect(out).not.toContain('ghp_fake_token_for_the_test');
    }
  }, 120_000);

  it('waits when the backlog is empty, pulls, builds a story added meanwhile, and stops on SIGTERM', async () => {
    const child = startForeman(['cloud', 'run'], { cwd: work, env: runnerEnv(), stdio: ['ignore', 'pipe', 'pipe'], stateDir: join(work, 'state') });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const until = async (test, ms = 60_000) => {
      for (let t = 0; t < ms; t += 100) {
        if (test()) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`timed out; output so far:\n${out}`);
    };
    const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));

    await until(() => /Nothing left to build; looking again/.test(out));
    expect(sessions()).toEqual(['claude S-1 resend=unset']);
    writeFileSync(join(seed, 'stories', 'S-2.md'), STORY('S-2'));
    git(seed, 'add', '.');
    git(seed, 'commit', '-qm', 'Add another story');
    git(seed, 'push', '-q', 'origin', 'main');

    await until(() => sessions().length === 2);
    expect(sessions()[1]).toBe('claude S-2 resend=unset');
    await until(() => (out.match(/Nothing left to build; looking again/g) ?? []).length >= 2);
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    expect(overlay('S-2').status).toBe('done');
  }, 150_000);

  it('stops before cloning when a check fails, and says which', () => {
    const r = runForeman(['cloud', 'run'], { cwd: work, env: runnerEnv({ FOREMAN_DASHBOARD_TOKEN: '' }), encoding: 'utf8', timeout: 60_000, stateDir: join(work, 'state') });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^FAIL {2}dashboard token — /m);
    expect(r.stderr).toContain('Not starting');
    expect(existsSync(join(work, 'repo'))).toBe(false);
  }, 60_000);
});
