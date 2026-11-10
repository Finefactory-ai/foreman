// The fixture for `foreman cloud tick` end to end (cloud-tick*.test.mjs):
// the real CLI and supervisor, a real temp git remote, and fake `claude` and `gh` programs on
// the PATH, with the short test tick. The fake session marks its story started and done through
// `foreman story`, as a real one does, and reports it shipped.

import { afterEach, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fastTick } from './fast-tick.mjs';
import { git, makeRepos } from './state-repos.mjs';
import { runForeman, useSupervisors } from './supervisors.mjs';

const BIN = fileURLToPath(new URL('../plugin/bin/foreman', import.meta.url));
const STORY = (id) => `---\nid: ${id}\ntitle: Story ${id}\nstatus: todo\ndepends_on: []\n---\n\nDo ${id}.\n\n## Progress notes\n`;

const FAKE_CLAUDE = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { appendFileSync } = require('node:fs');
appendFileSync(process.env.FAKE_LOG, 'claude ' + process.argv.slice(2).join(' ') + ' sync=' + (process.env.FOREMAN_STATE_SYNC || '') + ' resend=' + (process.env.RESEND_API_KEY ? 'set' : 'unset') + '\\n');
const id = process.env.FOREMAN_STORY;
const foreman = (...args) => spawnSync(process.execPath, [${JSON.stringify(BIN)}, ...args], { stdio: 'ignore' }).status; // supervisor-guard: not a supervisor
if (foreman('story', 'start', id) !== 0 || foreman('story', 'done', id, '--note', 'shipped by the fake session') !== 0) process.exit(1);
const result = 'FACTORY_RESULT: shipped ' + id;
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake' }));
console.log(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: result }] }, session_id: 'fake' }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, result, total_cost_usd: 0.5, session_id: 'fake' }));
`;

const FAKE_GH = `#!/bin/sh
echo "gh $*" >> "$FAKE_LOG"
case "$1 $2" in
  "auth setup-git") exit 0 ;;
  "api user") echo "octo 42" ;;
  "pr list") echo "[]" ;;
  *) exit 1 ;;
esac
`;

export let repos;
export let runner;
let bin;
let log;

// Registers the hooks that give each test fresh repos, a runner checkout and the fakes, and that
// end its supervisors before the repos go (vitest runs afterEach hooks last first).
export function withCloudTickRepos() {
  beforeEach(() => {
    repos = makeRepos({ version: 1, project: { name: 'T' }, state: { store: 'branch' }, install: null, cloud: { envVars: ['RESEND_API_KEY'] } });
    const seed = repos.clone('seed2');
    mkdirSync(join(seed, 'stories'));
    writeFileSync(join(seed, 'stories', 'S-1.md'), STORY('S-1'));
    writeFileSync(join(seed, 'stories', 'S-2.md'), STORY('S-2'));
    writeFileSync(join(seed, '.gitignore'), '.env.local\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-qm', 'Add stories');
    git(seed, 'push', '-q', 'origin', 'main');
    runner = repos.clone('runner');
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
  useSupervisors();
}

export function tick(args = [], extraEnv = {}) {
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: repos.base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', FAKE_LOG: log, ...extraEnv };
  for (const key of Object.keys(env)) if (/^(FOREMAN|FACTORY)_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key)) delete env[key];
  Object.assign(env, fastTick);
  return runForeman(['cloud', 'tick', ...args], { cwd: runner, env, encoding: 'utf8', timeout: 90_000 });
}
export const calls = () => spawnSync('cat', [log], { encoding: 'utf8' }).stdout;
export const overlay = (id) => JSON.parse(repos.remoteFile(`stories/${id}.json`));
export const stateLog = () => git(repos.remote, 'log', '--format=%s', 'foreman-state').split('\n');

// Each Actions job starts from a fresh checkout.
export function rmRunner() {
  spawnSync('rm', ['-rf', runner]);
  runner = repos.clone('runner');
}

// Runs `foreman <args>` in another clone of the project (a laptop), as its owner would.
export const foremanIn = (laptop, ...args) => runForeman(args, { cwd: laptop, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', FOREMAN_PROJECT_DIR: laptop }, encoding: 'utf8' });
