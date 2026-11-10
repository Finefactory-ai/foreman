// The fixture for `foreman run` end to end when the Claude sign-in stops working under the
// sessions (supervisor-signin.test.mjs and supervisor-signin-resume.test.mjs, split so their waits
// run on different workers): each session dies with Claude's own "Failed to authenticate: OAuth
// session expired" result and no result line. A fake `claude` (and `gh`) on the PATH stand in for
// the sessions, the probe and GitHub: FAKE_SIGNIN names a file that says 'ok' or 'expired', and
// FAKE_EXPIRE_FIRST=1 makes each story's first session die even with the sign-in working,
// FAKE_EXPIRE_ALWAYS=1 makes every story session die whatever FAKE_SIGNIN says, and FAKE_PROBE_MS
// is the probe's delay in ms (3000 when unset). The
// test files start the supervisor themselves, so each registers useSupervisors() after
// withSigninRepos() (test/supervisor-guard.test.mjs checks it).

import { afterEach, beforeEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, makeRepos } from './state-repos.mjs';
import { fastTick } from './fast-tick.mjs';
import { stretchByLoad } from './slow-tests.mjs';
import { readSlot } from '../plugin/lib/engine/state.mjs';

const EXPIRED = 'Failed to authenticate: OAuth session expired and could not be refreshed';

// `claude auth status` says logged in. A call with --max-turns is the probe: it logs 'probe',
// takes 3 s (six test ticks, or FAKE_PROBE_MS) to answer, and fails while FAKE_SIGNIN says expired. Any other call
// is a story session: it logs its story and dies with the sign-in error while FAKE_SIGNIN says
// expired, on the story's first session with FAKE_EXPIRE_FIRST=1, or on every session with
// FAKE_EXPIRE_ALWAYS=1; otherwise it marks its
// story blocked and says so.
const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
const expired = readFileSync(process.env.FAKE_SIGNIN, 'utf8').trim() === 'expired';
const failed = ${JSON.stringify(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, num_turns: 0, duration_ms: 10, total_cost_usd: 0, result: EXPIRED, session_id: 'fake' }))};
if (args[0] === 'auth') {
  console.log(JSON.stringify({ loggedIn: true }));
  process.exit(0);
}
if (args.includes('--max-turns')) {
  appendFileSync(process.env.FAKE_PROBE_LOG, 'probe\\n');
  // A real probe takes seconds: answer only after several ticks, so a start not held while the
  // check runs would show up as an extra session or an extra probe.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_PROBE_MS ?? 3000));
  if (expired) {
    console.log(failed);
    process.exit(1);
  }
  console.log(JSON.stringify({ type: 'result', is_error: false, result: 'ok' }));
  process.exit(0);
}
const id = process.env.FOREMAN_STORY;
const log = process.env.FAKE_CLAUDE_LOG;
const first = !readFileSync(log, 'utf8').split('\\n').includes(id);
appendFileSync(log, id + '\\n');
if (expired || process.env.FAKE_EXPIRE_ALWAYS === '1' || (process.env.FAKE_EXPIRE_FIRST === '1' && first)) {
  console.log(failed);
  process.exit(1);
}
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
// The time one run may take, stretched on a busy machine, and its test.
export const RUN_MS = stretchByLoad(90_000);
export const TEST_MS = RUN_MS + 30_000;

let repos;
// The run's clone, the probe log and the file the fake reads the sign-in from, for a test to use.
export let clone;
let bin;
let log;
export let probes;
export let signin;

export function setUp(signedIn) {
  repos = makeRepos({ version: 1, project: { name: 'Acme' }, console: { adapter: 'files' }, features: { keepAwake: false }, learning: { auto: false } });
  clone = repos.clone('acme');
  writeFileSync(join(clone, '.gitignore'), '.foreman/\n.env.foreman\n');
  mkdirSync(join(clone, 'stories'));
  for (const id of ['ACME-1', 'ACME-2', 'ACME-3']) writeFileSync(join(clone, 'stories', `${id}.md`), STORY(id));
  git(clone, 'add', '.');
  git(clone, 'commit', '-qm', 'Add the stories');
  git(clone, 'push', '-q', 'origin', 'main');
  bin = join(repos.base, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE);
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  chmodSync(join(bin, 'claude'), 0o755);
  chmodSync(join(bin, 'gh'), 0o755);
  log = join(repos.base, 'claude.log');
  probes = join(repos.base, 'probe.log');
  signin = join(repos.base, 'signin');
  writeFileSync(log, '');
  writeFileSync(probes, '');
  writeFileSync(signin, signedIn);
}

// Registers the hooks that drop each test's repos. The test file registers useSupervisors() after
// this, so its hook, which ends the supervisor, runs first (vitest runs afterEach hooks last first).
export function withSigninRepos() {
  beforeEach(() => {
    repos = null;
  });
  afterEach(() => repos?.cleanup());
}

export const runEnv = (extra = {}) => {
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: repos.base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', FAKE_CLAUDE_LOG: log, FAKE_PROBE_LOG: probes, FAKE_SIGNIN: signin };
  for (const key of Object.keys(env)) {
    if (/^(FOREMAN|FACTORY)_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'].includes(key)) delete env[key];
  }
  Object.assign(env, fastTick, extra);
  return env;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const state = () => join(clone, '.foreman');
const read = (name, fallback = '') => (existsSync(join(state(), name)) ? readFileSync(join(state(), name), 'utf8') : fallback);
export const saved = () => JSON.parse(read('state.json', '{}') || '{}');
export const events = () => read('events.jsonl').split('\n').filter(Boolean).map((l) => JSON.parse(l));
export const outbox = () => (existsSync(join(state(), 'outbox')) ? readdirSync(join(state(), 'outbox')) : []);
export const lines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean);
export const sessions = () => lines(log);
export const slots = () => (existsSync(join(state(), 'slots')) ? readdirSync(join(state(), 'slots')).filter((f) => f.endsWith('.json')).map((f) => readSlot(state(), f.slice(0, -5))) : []);
export const until = async (test, ms = RUN_MS) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) if (test()) return true;
  return test();
};

