// `foreman run` end to end: a story session gets ANTHROPIC_API_KEY from <root>/.env.foreman when
// the supervisor's own environment has none, and no other name from that file. A fake `claude`
// (and `gh`) on the PATH stand in for the session and GitHub; it logs only whether each name
// reached it, never a value, and the share of the cores (FOREMAN_TEST_CORES) the supervisor gave
// it. Nothing here is a real key.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { git, makeRepos } from '../../../test/state-repos.mjs';
import { fastTick } from '../../../test/fast-tick.mjs';
import { endChild, startForeman, useSupervisors } from '../../../test/supervisors.mjs';
import { testCoreShare } from './session.mjs';

const KEY = 'sk-ant-acme-fake-1111111111111111111111';

// `claude auth status` says signed out. Any other call logs "<story> key|nokey resend|noresend
// cores=<FOREMAN_TEST_CORES>", by whether ANTHROPIC_API_KEY is the file's key and whether
// RESEND_API_KEY is set, then marks its story blocked and says so.
const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
if (process.argv[2] === 'auth') {
  console.log(JSON.stringify({ loggedIn: false }));
  process.exit(0);
}
const id = process.env.FOREMAN_STORY;
const key = process.env.ANTHROPIC_API_KEY === ${JSON.stringify(KEY)} ? 'key' : 'nokey';
const resend = process.env.RESEND_API_KEY ? 'resend' : 'noresend';
appendFileSync(process.env.FAKE_CLAUDE_LOG, id + ' ' + key + ' ' + resend + ' cores=' + process.env.FOREMAN_TEST_CORES + '\\n');
const stories = join(process.env.FOREMAN_STATE_DIR, 'stories');
mkdirSync(stories, { recursive: true });
writeFileSync(join(stories, id + '.json'), JSON.stringify({ id, status: 'blocked', blockedBy: 'Fake session', fields: {}, notes: [] }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, result: 'Could not get further.\\nFACTORY_RESULT: blocked ' + id, total_cost_usd: 0, session_id: 'fake' }));
`;

const FAKE_GH = `#!/bin/sh
case "$1 $2" in
  "pr list") echo "[]" ;;
  *) exit 1 ;;
esac
`;

const STORY = (id) => `---\nid: ${id}\ntitle: Story ${id}\nstatus: todo\ndepends_on: []\n---\n\nDo ${id}.\n\n## Progress notes\n`;

let repos;
let clone;
let bin;
let log;

function setUp(extra = {}) {
  repos = makeRepos({ version: 1, project: { name: 'Acme' }, console: { adapter: 'files' }, features: { keepAwake: false }, ...extra });
  clone = repos.clone('acme');
  writeFileSync(join(clone, '.gitignore'), '.foreman/\n.env.foreman\n');
  mkdirSync(join(clone, 'stories'));
  writeFileSync(join(clone, 'stories', 'ACME-1.md'), STORY('ACME-1'));
  git(clone, 'add', '.');
  git(clone, 'commit', '-qm', 'Add the story');
  git(clone, 'push', '-q', 'origin', 'main');
  writeFileSync(join(clone, '.env.foreman'), `ANTHROPIC_API_KEY=${KEY}\nRESEND_API_KEY=re_acme_fake\n`, { mode: 0o600 });
  bin = join(repos.base, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE);
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  chmodSync(join(bin, 'claude'), 0o755);
  chmodSync(join(bin, 'gh'), 0o755);
  log = join(repos.base, 'claude.log');
  writeFileSync(log, '');
}

beforeEach(() => {
  repos = null;
});
afterEach(() => repos?.cleanup());
// After the hooks above, so it runs before them (vitest runs afterEach hooks last first).
useSupervisors();

const runEnv = () => {
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: repos.base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', FAKE_CLAUDE_LOG: log };
  for (const key of Object.keys(env)) {
    if (/^(FOREMAN|FACTORY)_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'RESEND_API_KEY'].includes(key)) delete env[key];
  }
  Object.assign(env, fastTick);
  return env;
};

const sessions = () => readFileSync(log, 'utf8').split('\n').filter(Boolean);

describe("the supervisor and Foreman's own keys", () => {
  // One worker, so the session's share of the cores is all of them (at least 2).
  it('gives a session the Claude key from .env.foreman, and not the other names in it', async () => {
    setUp();
    const child = startForeman(['run', '--foreground', '--exit-when-idle'], { cwd: clone, env: runEnv(), stdio: 'ignore' });
    const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    const timer = setTimeout(() => endChild(child), 80_000);
    const code = await exited;
    clearTimeout(timer);
    expect(code).toBe(0);
    expect(sessions()).toEqual([`ACME-1 key noresend cores=${testCoreShare(os.availableParallelism(), 1)}`]);
  }, 90_000);

  // On a machine with fewer than 4 cores the share and the core count can be equal, so this test
  // separates the two only on 4 or more cores.
  it('splits the cores between the workers: with --workers 2 a session gets half', async () => {
    setUp({ slots: 2 });
    const child = startForeman(['run', '--foreground', '--exit-when-idle', '--workers', '2'], { cwd: clone, env: runEnv(), stdio: 'ignore' });
    const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    const timer = setTimeout(() => endChild(child), 80_000);
    const code = await exited;
    clearTimeout(timer);
    expect(code).toBe(0);
    expect(sessions()).toEqual([`ACME-1 key noresend cores=${testCoreShare(os.availableParallelism(), 2)}`]);
  }, 90_000);
});
