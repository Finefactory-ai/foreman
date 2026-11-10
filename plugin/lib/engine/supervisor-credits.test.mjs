// `foreman run` end to end, when the Console API key runs out of credit: the third session dies
// with Claude's credit error (a billing_error event and "Credit balance is too low", no result
// line). With a subscription token in .env.foreman the run switches to it: the same story starts
// again at once without ANTHROPIC_API_KEY in its environment, it is not a miss, nothing pauses,
// and the owner gets one notification and one FYI. With claude.fallback "none" the run pauses
// instead, with a reason that says so, and starts nothing more. With no subscription sign-in at
// all it pauses with a reason that says that. With only a claude.ai login, the supervisor asks
// `claude auth status` without holding its loop: it keeps ticking (a pause from the owner shows)
// until the answer comes, then switches. Two key sessions running out during one login check ask
// `claude auth status` once, and nothing starts until it answers. A fake `claude` (and `gh`) on the PATH stand in for the
// sessions and GitHub; nothing here is a real key.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, makeRepos } from '../../../test/state-repos.mjs';
import { creditsOutFyi, readSignIn } from './claude-fallback.mjs';
import { fastTick, TEST_TICK_MS } from '../../../test/fast-tick.mjs';
import { endChild, runForeman, startForeman, useSupervisors } from '../../../test/supervisors.mjs';

const KEY = 'sk-ant-acme-fake-0000000000000000000000';
const TOKEN = 'acme-oauth-fake';

// `claude auth status` says signed out. With FAKE_AUTH=slow-login, once three sessions ran (two
// with FAKE_MODE=pair), it adds a line to auth-started next to the log (one line per slow call),
// waits (up to 20 s) for auth-release there, then says a claude.ai login is there. Any other call
// logs "<story> key" or "<story> nokey", by whether ANTHROPIC_API_KEY is set (never its value).
// By default the third session dies out of credit; every other one marks its story blocked and
// says so. With FAKE_MODE=pair, a session without the key marks its story blocked; ACME-1 on the
// key waits until ACME-2 has started, then dies out of credit; ACME-2 on the key waits until the
// login check has started, writes ACME-2-died next to the log, then dies the same way (each
// gives up after 60 s and dies); any other session on the key marks its story blocked.
const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
if (process.argv[2] === 'auth') {
  const ran = readFileSync(process.env.FAKE_CLAUDE_LOG, 'utf8').split('\\n').filter(Boolean).length;
  const after = process.env.FAKE_MODE === 'pair' ? 2 : 3;
  if (process.env.FAKE_AUTH !== 'slow-login' || ran < after) {
    console.log(JSON.stringify({ loggedIn: false }));
    process.exit(0);
  }
  const dir = dirname(process.env.FAKE_CLAUDE_LOG);
  appendFileSync(join(dir, 'auth-started'), 'call\\n');
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (const end = Date.now() + 20000; Date.now() < end && !existsSync(join(dir, 'auth-release'));) Atomics.wait(nap, 0, 0, 100);
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }));
  process.exit(0);
}
const id = process.env.FOREMAN_STORY;
const log = process.env.FAKE_CLAUDE_LOG;
const before = readFileSync(log, 'utf8').split('\\n').filter(Boolean).length;
appendFileSync(log, id + (process.env.ANTHROPIC_API_KEY ? ' key' : ' nokey') + '\\n');
function die() {
  console.log(JSON.stringify({ type: 'assistant', message: { id: 'm1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Credit balance is too low' }] }, parent_tool_use_id: null, error: 'billing_error', session_id: 'fake' }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, num_turns: 1, duration_ms: 1000, result: 'Credit balance is too low', total_cost_usd: 0, session_id: 'fake' }));
  process.exit(1);
}
function blocked() {
  const stories = join(process.env.FOREMAN_STATE_DIR, 'stories');
  mkdirSync(stories, { recursive: true });
  writeFileSync(join(stories, id + '.json'), JSON.stringify({ id, status: 'blocked', blockedBy: 'Fake session', fields: {}, notes: [] }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, result: 'Could not get further.\\nFACTORY_RESULT: blocked ' + id, total_cost_usd: 0, session_id: 'fake' }));
}
if (process.env.FAKE_MODE !== 'pair') {
  if (before === 2) die();
  else blocked();
} else if (!process.env.ANTHROPIC_API_KEY || (id !== 'ACME-1' && id !== 'ACME-2')) {
  blocked();
} else {
  const dir = dirname(log);
  const end = Date.now() + 60000;
  (function wait() {
    const ready = id === 'ACME-1'
      ? readFileSync(log, 'utf8').split('\\n').filter(Boolean).length >= 2
      : existsSync(join(dir, 'auth-started'));
    if (!ready && Date.now() < end) return void setTimeout(wait, 100 + Math.floor(Math.random() * 100));
    if (id === 'ACME-2') writeFileSync(join(dir, 'ACME-2-died'), '');
    die();
  })();
}
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

// `token: false` leaves CLAUDE_CODE_OAUTH_TOKEN out of .env.foreman, keeping the key.
function setUp(extra = {}, { token = true } = {}) {
  repos = makeRepos({ version: 1, project: { name: 'Acme' }, console: { adapter: 'files' }, features: { keepAwake: false }, ...extra });
  clone = repos.clone('acme');
  writeFileSync(join(clone, '.gitignore'), '.foreman/\n.env.foreman\n');
  mkdirSync(join(clone, 'stories'));
  for (const id of ['ACME-1', 'ACME-2', 'ACME-3']) writeFileSync(join(clone, 'stories', `${id}.md`), STORY(id));
  git(clone, 'add', '.');
  git(clone, 'commit', '-qm', 'Add the stories');
  git(clone, 'push', '-q', 'origin', 'main');
  writeFileSync(join(clone, '.env.foreman'), `ANTHROPIC_API_KEY=${KEY}\n${token ? `CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}\n` : ''}`, { mode: 0o600 });
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
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: repos.base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', FAKE_CLAUDE_LOG: log };
  if (mode) env.FAKE_MODE = mode;
  for (const key of Object.keys(env)) {
    if (/^(FOREMAN|FACTORY)_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'].includes(key)) delete env[key];
  }
  Object.assign(env, fastTick);
  return env;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = () => join(clone, '.foreman');
const read = (name, fallback = '') => (existsSync(join(state(), name)) ? readFileSync(join(state(), name), 'utf8') : fallback);
const events = () => read('events.jsonl').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const outbox = () => (existsSync(join(state(), 'outbox')) ? readdirSync(join(state(), 'outbox')) : []);
const sessions = () => readFileSync(log, 'utf8').split('\n').filter(Boolean);
const waitFor = async (check, ms) => {
  for (const end = Date.now() + ms; Date.now() < end && !check(); await sleep(100));
  return check();
};

describe('the supervisor when the platform credits run out', () => {
  it('switches later sessions to the subscription, re-runs the story, and never pauses', async () => {
    setUp();
    // In the foreground, so this test owns the process; --exit-when-idle, so it stops once nothing is left.
    const child = startForeman(['run', '--foreground', '--exit-when-idle'], { cwd: clone, env: runEnv(), stdio: 'ignore' });
    const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    const timer = setTimeout(() => endChild(child), 80_000);
    const code = await exited;
    clearTimeout(timer);
    expect(code).toBe(0);

    expect(sessions()).toEqual(['ACME-1 key', 'ACME-2 key', 'ACME-3 key', 'ACME-3 nokey']);
    const saved = JSON.parse(read('state.json', '{}'));
    expect(saved.autoPausedAt ?? null).toBeFalsy();
    expect(events().filter((e) => /paused/i.test(e.text))).toEqual([]);
    expect(events().filter((e) => e.text.startsWith('API credits used up at'))).toHaveLength(1);
    expect(outbox().filter((f) => f.endsWith('-credits.json'))).toHaveLength(1);
    expect(outbox().filter((f) => f.endsWith('-paused.json'))).toEqual([]);
    const signIn = readSignIn(state());
    expect(signIn).toMatchObject({ using: 'subscription', reason: 'API credits used up' });

    // Waiting on you carries one FYI, which `foreman status` prints.
    const status = runForeman(['status'], { cwd: clone, env: runEnv(), encoding: 'utf8' }).stdout ?? '';
    const fyi = status.split('\n').filter((l) => l.includes(creditsOutFyi(signIn)));
    expect(fyi).toHaveLength(1);
    expect(fyi[0]).toMatch(/^\s+FYI: /);
    expect(fyi[0]).toContain('`foreman claude use-key`');

    // The key is in none of the state files the run wrote.
    const files = ['events.jsonl', 'state.json', 'claude-signin.json', ...outbox().map((f) => join('outbox', f))];
    for (const f of files) expect(read(f), f).not.toContain(KEY);
  }, 90_000);

  it('pauses with a clear reason instead when claude.fallback is "none"', async () => {
    setUp({ claude: { fallback: 'none' } });
    const child = startForeman(['run', '--foreground', '--exit-when-idle'], { cwd: clone, env: runEnv(), stdio: 'ignore' });
    const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    try {
      let saved = {};
      for (const end = Date.now() + 60_000; Date.now() < end; await sleep(500)) {
        saved = JSON.parse(read('state.json', '{}') || '{}');
        if (saved.autoPausedAt) break;
      }
      expect(saved.autoPausedAt).toBeTruthy();
      expect(saved.autoPauseReason).toContain('claude.fallback is "none"');
      expect(saved.autoPauseReason).toContain('Resume');
      for (const end = Date.now() + 10_000; Date.now() < end && !outbox().some((f) => f.endsWith('-paused.json')); await sleep(250));
      expect(outbox().filter((f) => f.endsWith('-paused.json'))).toHaveLength(1);
      expect(outbox().filter((f) => f.endsWith('-credits.json'))).toEqual([]);

      // More than one tick later, still nothing after the credit error.
      await sleep(3 * TEST_TICK_MS);
      expect(sessions()).toEqual(['ACME-1 key', 'ACME-2 key', 'ACME-3 key']);
      expect(readSignIn(state()).using).toBe('key');
    } finally {
      child.kill('SIGTERM');
      const timer = setTimeout(() => endChild(child), 20_000);
      await exited;
      clearTimeout(timer);
    }
  }, 90_000);

  it('pauses with the no-sign-in reason when no subscription sign-in is found, and starts nothing more', async () => {
    setUp({}, { token: false });
    const child = startForeman(['run', '--foreground', '--exit-when-idle'], { cwd: clone, env: runEnv(), stdio: 'ignore' });
    const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    try {
      let saved = {};
      for (const end = Date.now() + 60_000; Date.now() < end; await sleep(500)) {
        saved = JSON.parse(read('state.json', '{}') || '{}');
        if (saved.autoPausedAt) break;
      }
      expect(saved.autoPausedAt).toBeTruthy();
      expect(saved.autoPauseReason).toContain('no subscription sign-in was found');
      expect(saved.autoPauseReason).toContain('Resume');
      await waitFor(() => outbox().some((f) => f.endsWith('-paused.json')), 10_000);
      expect(outbox().filter((f) => f.endsWith('-paused.json'))).toHaveLength(1);
      expect(outbox().filter((f) => f.endsWith('-credits.json'))).toEqual([]);
      expect(events().filter((e) => /later sessions use your subscription/.test(e.text))).toEqual([]);

      // More than one tick later, still nothing after the credit error: it does not loop.
      await sleep(3 * TEST_TICK_MS);
      expect(sessions()).toEqual(['ACME-1 key', 'ACME-2 key', 'ACME-3 key']);
      expect(readSignIn(state()).using).toBe('key');
    } finally {
      child.kill('SIGTERM');
      const timer = setTimeout(() => endChild(child), 20_000);
      await exited;
      clearTimeout(timer);
    }
  }, 90_000);

  it('keeps ticking while it checks for a claude.ai login, then switches', async () => {
    setUp({}, { token: false });
    const env = { ...runEnv(), FAKE_AUTH: 'slow-login' };
    const started = join(repos.base, 'auth-started');
    const release = join(repos.base, 'auth-release');
    const child = startForeman(['run', '--foreground', '--exit-when-idle'], { cwd: clone, env, stdio: 'ignore' });
    const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    let code;
    try {
      expect(await waitFor(() => existsSync(started), 60_000)).toBe(true);
      // While it checks, nothing starts: the story that ran out waits for the answer.
      await sleep(3 * TEST_TICK_MS);
      expect(sessions()).toEqual(['ACME-1 key', 'ACME-2 key', 'ACME-3 key']);
      // The check is still running: a pause from the owner shows within a few ticks.
      runForeman(['pause'], { cwd: clone, env: runEnv(), encoding: 'utf8' });
      const shown = await waitFor(() => events().some((e) => e.text.startsWith('Factory paused')), 10 * TEST_TICK_MS);
      expect(existsSync(release)).toBe(false);
      expect(shown).toBe(true);
    } finally {
      writeFileSync(release, '');
      runForeman(['resume'], { cwd: clone, env: runEnv(), encoding: 'utf8' });
      const timer = setTimeout(() => endChild(child), 80_000);
      code = await exited;
      clearTimeout(timer);
    }
    expect(code).toBe(0);
    expect(sessions()).toEqual(['ACME-1 key', 'ACME-2 key', 'ACME-3 key', 'ACME-3 nokey']);
    expect(readSignIn(state()).using).toBe('subscription');
    expect(events().filter((e) => e.text.startsWith('API credits used up at'))).toHaveLength(1);
    expect(outbox().filter((f) => f.endsWith('-credits.json'))).toHaveLength(1);

    const files = ['events.jsonl', 'state.json', 'claude-signin.json', ...outbox().map((f) => join('outbox', f))];
    for (const f of files) expect(read(f), f).not.toContain(KEY);
  }, 150_000);

  it('checks once when two key sessions run out while the login check is running, and starts nothing until it answers', async () => {
    setUp({ slots: 2 }, { token: false });
    const env = { ...runEnv('pair'), FAKE_AUTH: 'slow-login' };
    const started = join(repos.base, 'auth-started');
    const died = join(repos.base, 'ACME-2-died');
    const release = join(repos.base, 'auth-release');
    const asked = () => readFileSync(started, 'utf8').split('\n').filter(Boolean);
    const child = startForeman(['run', '--foreground', '--exit-when-idle', '--workers', '2'], { cwd: clone, env, stdio: 'ignore' });
    const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    let code;
    try {
      expect(await waitFor(() => existsSync(started), 60_000)).toBe(true);
      expect(await waitFor(() => existsSync(died), 60_000)).toBe(true);
      // The supervisor handles ACME-2's outcome while the check still runs.
      await sleep(5 * TEST_TICK_MS);
      // Nothing started, not the requeued stories and not ACME-3.
      expect([...sessions()].sort()).toEqual(['ACME-1 key', 'ACME-2 key']);
      expect(asked()).toHaveLength(1);
    } finally {
      writeFileSync(release, '');
      const timer = setTimeout(() => endChild(child), 80_000);
      code = await exited;
      clearTimeout(timer);
    }
    expect(code).toBe(0);
    expect(asked()).toHaveLength(1);
    expect([...sessions()].sort()).toEqual(['ACME-1 key', 'ACME-1 nokey', 'ACME-2 key', 'ACME-2 nokey', 'ACME-3 nokey']);
    expect(readSignIn(state()).using).toBe('subscription');
    expect(events().filter((e) => e.text.startsWith('API credits used up at'))).toHaveLength(1);
    expect(outbox().filter((f) => f.endsWith('-credits.json'))).toHaveLength(1);
    expect(outbox().filter((f) => f.endsWith('-paused.json'))).toEqual([]);
    expect(JSON.parse(read('state.json', '{}')).autoPausedAt ?? null).toBeFalsy();

    const files = ['events.jsonl', 'state.json', 'claude-signin.json', ...outbox().map((f) => join('outbox', f))];
    for (const f of files) expect(read(f), f).not.toContain(KEY);
  }, 150_000);
});
