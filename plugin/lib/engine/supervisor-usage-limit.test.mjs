// `foreman run` end to end, when the Console API key reaches the usage limit set on it: a session
// dies with Claude Code's exact words, an assistant event made from the API error and an error
// result ("API Error: 400 You have reached your specified API usage limits. You will regain access
// on 2026-11-01 at 00:00 UTC."), and no result line. With a subscription token in .env.foreman the
// run switches to it, records the usage limit and when access returns, starts the story again
// without ANTHROPIC_API_KEY, and counts no miss. Sessions still on the key that die the same way
// after the switch start again on the subscription too: no slot parks and nothing pauses. With
// claude.fallback "none" the run pauses instead, with a reason naming the usage limit and when
// access returns, and starts nothing more. A fake `claude` (and `gh`) on the PATH stand in for
// the sessions and GitHub; nothing here is a real key.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, makeRepos } from '../../../test/state-repos.mjs';
import { readSignIn } from './claude-fallback.mjs';
import { readSlot } from './state.mjs';
import { fastTick, TEST_TICK_MS } from '../../../test/fast-tick.mjs';
import { endChild, runForeman, startForeman, useSupervisors } from '../../../test/supervisors.mjs';

const KEY = 'sk-ant-acme-fake-1111111111111111111111';
const TOKEN = 'acme-oauth-fake';
const BACK = '2026-11-01 at 00:00 UTC';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// `claude auth status` says signed out. Any other call logs "<story> key" or "<story> nokey", by
// whether ANTHROPIC_API_KEY is set (never its value). FAKE_MODE says which sessions die:
//   third  the third session dies at once
//   race   ACME-3 on the key dies at once; ACME-1 and ACME-2 on the key wait until the run has
//          switched (claude-signin.json is there), then die the same way
// Every other session marks its story blocked and says so.
const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
if (process.argv[2] === 'auth') {
  console.log(JSON.stringify({ loggedIn: false }));
  process.exit(0);
}
const said = 'API Error: 400 You have reached your specified API usage limits. You will regain access on ${BACK}.';
const id = process.env.FOREMAN_STORY;
const log = process.env.FAKE_CLAUDE_LOG;
const onKey = Boolean(process.env.ANTHROPIC_API_KEY);
const before = readFileSync(log, 'utf8').split('\\n').filter(Boolean).length;
appendFileSync(log, id + (onKey ? ' key' : ' nokey') + '\\n');
function die() {
  console.log(JSON.stringify({ type: 'assistant', message: { id: 'a1', model: '<synthetic>', role: 'assistant', type: 'message', content: [{ type: 'text', text: said }] }, parent_tool_use_id: null, session_id: 'fake', error: 'unknown', api_error_status: 400 }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, api_error_status: 400, duration_ms: 1000, num_turns: 3, result: said, stop_reason: 'stop_sequence', session_id: 'fake', total_cost_usd: 0, terminal_reason: 'api_error' }));
  process.exit(1);
}
function blocked() {
  const stories = join(process.env.FOREMAN_STATE_DIR, 'stories');
  mkdirSync(stories, { recursive: true });
  writeFileSync(join(stories, id + '.json'), JSON.stringify({ id, status: 'blocked', blockedBy: 'Fake session', fields: {}, notes: [] }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, result: 'Could not get further.\\nFACTORY_RESULT: blocked ' + id, total_cost_usd: 0, session_id: 'fake' }));
  process.exit(0);
}
const mode = process.env.FAKE_MODE;
if (mode === 'third') {
  if (before === 2) die();
  blocked();
}
if (!onKey) blocked();
if (id === 'ACME-3') die();
const signIn = join(process.env.FOREMAN_STATE_DIR, 'claude-signin.json');
const end = Date.now() + 60000;
(function wait() {
  if (existsSync(signIn) || Date.now() > end) die();
  setTimeout(wait, 200);
})();
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
  for (const id of ['ACME-1', 'ACME-2', 'ACME-3']) writeFileSync(join(clone, 'stories', `${id}.md`), STORY(id));
  git(clone, 'add', '.');
  git(clone, 'commit', '-qm', 'Add the stories');
  git(clone, 'push', '-q', 'origin', 'main');
  writeFileSync(join(clone, '.env.foreman'), `ANTHROPIC_API_KEY=${KEY}\nCLAUDE_CODE_OAUTH_TOKEN=${TOKEN}\n`, { mode: 0o600 });
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

const runEnv = (mode) => {
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: repos.base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', FAKE_CLAUDE_LOG: log, FAKE_MODE: mode };
  for (const key of Object.keys(env)) {
    if (/^(FOREMAN|FACTORY)_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'].includes(key)) delete env[key];
  }
  Object.assign(env, fastTick);
  return env;
};

const state = () => join(clone, '.foreman');
const read = (name, fallback = '') => (existsSync(join(state(), name)) ? readFileSync(join(state(), name), 'utf8') : fallback);
const events = () => read('events.jsonl').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const outbox = () => (existsSync(join(state(), 'outbox')) ? readdirSync(join(state(), 'outbox')) : []);
const sessions = () => readFileSync(log, 'utf8').split('\n').filter(Boolean);
const switches = () => events().filter((e) => /later sessions use your subscription/.test(e.text));

async function run(mode, args = []) {
  // In the foreground, so this test owns the process; --exit-when-idle, so it stops once nothing is left.
  const child = startForeman(['run', '--foreground', '--exit-when-idle', ...args], { cwd: clone, env: runEnv(mode), stdio: 'ignore' });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const timer = setTimeout(() => endChild(child), 80_000);
  const code = await exited;
  clearTimeout(timer);
  return code;
}

function expectNoTrouble() {
  const saved = JSON.parse(read('state.json', '{}'));
  expect(saved.autoPausedAt ?? null).toBeFalsy();
  expect(events().filter((e) => /paused/i.test(e.text))).toEqual([]);
  for (const kind of ['noresult', 'parked', 'paused']) expect(outbox().filter((f) => f.endsWith(`-${kind}.json`)), kind).toEqual([]);
}

describe('the supervisor when the Console API key reaches its usage limit', () => {
  it('switches the run on the usage-limit error and records no miss', async () => {
    setUp();
    expect(await run('third')).toBe(0);

    expect(sessions()).toEqual(['ACME-1 key', 'ACME-2 key', 'ACME-3 key', 'ACME-3 nokey']);
    expectNoTrouble();
    expect(switches()).toHaveLength(1);
    expect(switches()[0].text).toMatch(/^The Console API key reached its usage limit at \d\d:\d\d \(access returns 2026-11-01 at 00:00 UTC\); later sessions use your subscription\.$/);
    expect(outbox().filter((f) => f.endsWith('-credits.json'))).toHaveLength(1);
    expect(readSignIn(state())).toMatchObject({ using: 'subscription', limit: 'usage', resetAt: BACK });

    // Waiting on you carries one FYI naming the usage limit, which `foreman status` prints.
    const status = runForeman(['status'], { cwd: clone, env: runEnv('third'), encoding: 'utf8' }).stdout ?? '';
    const fyi = status.split('\n').filter((l) => /^\s+FYI: /.test(l) && l.includes('usage limit') && l.includes(BACK));
    expect(fyi).toHaveLength(1);

    // The key is in none of the state files the run wrote.
    const files = ['events.jsonl', 'state.json', 'claude-signin.json', ...outbox().map((f) => join('outbox', f))];
    for (const f of files) expect(read(f), f).not.toContain(KEY);
  }, 90_000);

  it('requeues two key sessions that die after the switch, parks no slot, does not pause', async () => {
    setUp({ slots: 3 });
    expect(await run('race', ['--workers', '3'])).toBe(0);

    expect([...sessions()].sort()).toEqual(['ACME-1 key', 'ACME-1 nokey', 'ACME-2 key', 'ACME-2 nokey', 'ACME-3 key', 'ACME-3 nokey']);
    expect(switches()).toHaveLength(1);
    expect(outbox().filter((f) => f.endsWith('-credits.json'))).toHaveLength(1);
    expectNoTrouble();
    for (const slot of ['w1', 'w2', 'w3']) expect(readSlot(state(), slot)?.state, slot).not.toBe('parked');
    expect(readSignIn(state())).toMatchObject({ using: 'subscription', limit: 'usage', resetAt: BACK });
  }, 90_000);

  it('pauses with the usage-limit reason instead when claude.fallback is "none"', async () => {
    setUp({ claude: { fallback: 'none' } });
    const child = startForeman(['run', '--foreground', '--exit-when-idle'], { cwd: clone, env: runEnv('third'), stdio: 'ignore' });
    const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    try {
      let saved = {};
      for (const end = Date.now() + 60_000; Date.now() < end; await sleep(500)) {
        saved = JSON.parse(read('state.json', '{}') || '{}');
        if (saved.autoPausedAt) break;
      }
      expect(saved.autoPausedAt).toBeTruthy();
      expect(saved.autoPauseReason).toMatch(
        /^The Console API key reached its usage limit at \d\d:\d\d \(access returns 2026-11-01 at 00:00 UTC\)\. claude\.fallback is "none", so Foreman paused instead of using your subscription\. /,
      );
      expect(saved.autoPauseReason).toContain('Resume');
      expect(saved.autoPauseReason).not.toContain('Platform credits');
      for (const end = Date.now() + 10_000; Date.now() < end && !outbox().some((f) => f.endsWith('-paused.json')); await sleep(250));
      expect(outbox().filter((f) => f.endsWith('-paused.json'))).toHaveLength(1);
      expect(outbox().filter((f) => f.endsWith('-credits.json'))).toEqual([]);
      expect(switches()).toEqual([]);

      // More than one tick later, still nothing after the usage-limit error: the token in
      // .env.foreman is not used, so no "nokey" session starts.
      await sleep(3 * TEST_TICK_MS);
      expect(sessions()).toEqual(['ACME-1 key', 'ACME-2 key', 'ACME-3 key']);
      expect(readSignIn(state()).using).toBe('key');

      // The key is in none of the state files the run wrote.
      for (const f of ['state.json', 'events.jsonl', ...outbox().map((f) => join('outbox', f))]) expect(read(f), f).not.toContain(KEY);
    } finally {
      child.kill('SIGTERM');
      const timer = setTimeout(() => endChild(child), 20_000);
      await exited;
      clearTimeout(timer);
    }
  }, 90_000);
});
