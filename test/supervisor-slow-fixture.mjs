// The fixture for `foreman run` end to end with a long stage (supervisor-slow.test.mjs, slow;
// supervisor-slow-stuck.test.mjs, stuck; supervisor-busy-cpu.test.mjs, silent but busy): a fake
// `claude` that writes its log every FAKE_EVERY_MS, or nothing when it is 0, for FAKE_FOR_MS
// (busy on the CPU and writing nothing when FAKE_BURN is 1, until the test calls stopBurn), and a
// fake `gh`, on the PATH, with the short test tick.

import { afterEach, beforeEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, makeRepos } from './state-repos.mjs';
import { fastTick } from './fast-tick.mjs';
import { endChild, runForeman, startForeman, useSupervisors } from './supervisors.mjs';

// The session writes a stream-json line to its log (stdout) every FAKE_EVERY_MS, or nothing when
// it is 0, for FAKE_FOR_MS; then it marks its story blocked in the state overlay and says so.
// With FAKE_BURN=1 it also burns the CPU, silent, for FAKE_FOR_MS or until the FAKE_CLAUDE_STOP
// file exists, whichever is first; then it ends at once. Once a second it adds its CPU time so
// far to the FAKE_CLAUDE_BURN file, never its log. The burn is metered, on its own main thread:
// every 100 ms it spins until it has had BURN_MS of CPU, or for 90 ms when the machine is too
// busy to give it that. So it uses about a third of one core, three times CPU_BUSY_SHARE, and at
// most one core under load. Spinning threads, a whole core each, slowed the git-heavy tests that
// run beside it past their limit (FM-267).
const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const id = process.env.FOREMAN_STORY;
appendFileSync(process.env.FAKE_CLAUDE_LOG, id + '\\n');
const every = Number(process.env.FAKE_EVERY_MS);
const timer = every > 0 ? setInterval(() => console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'still testing' }] } })), every) : null;
const finish = () => {
  if (timer) clearInterval(timer);
  const stories = join(process.env.FOREMAN_STATE_DIR, 'stories');
  mkdirSync(stories, { recursive: true });
  writeFileSync(join(stories, id + '.json'), JSON.stringify({ id, status: 'blocked', blockedBy: 'Fake session', fields: {}, notes: [] }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, result: 'Could not get further.\\nFACTORY_RESULT: blocked ' + id, total_cost_usd: 0, session_id: 'fake' }));
};
if (process.env.FAKE_BURN === '1') {
  const { existsSync } = require('node:fs');
  const BURN_MS = 30;
  const end = Date.now() + Number(process.env.FAKE_FOR_MS);
  const burn = setInterval(() => {
    const from = process.cpuUsage();
    for (const until = Date.now() + 90; Date.now() < until; ) {
      const u = process.cpuUsage(from);
      if (u.user + u.system >= BURN_MS * 1000) break;
    }
  }, 100);
  let polls = 0;
  const poll = setInterval(() => {
    // The CPU the session has had, once a second, for a failing test to show (burnTrace).
    if (polls++ % 5 === 0) { const u = process.cpuUsage(); appendFileSync(process.env.FAKE_CLAUDE_BURN, new Date().toISOString() + ' ' + Math.round((u.user + u.system) / 1000) + ' ms CPU\\n'); }
    if (Date.now() < end && !existsSync(process.env.FAKE_CLAUDE_STOP)) return;
    clearInterval(poll);
    clearInterval(burn);
    finish();
  }, 200);
} else setTimeout(finish, Number(process.env.FAKE_FOR_MS));
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

export function setUp(watchdog) {
  repos = makeRepos({ version: 1, project: { name: 'Acme' }, console: { adapter: 'files' }, features: { keepAwake: false }, learning: { auto: false }, watchdog });
  clone = repos.clone('acme');
  writeFileSync(join(clone, '.gitignore'), '.foreman/\n');
  mkdirSync(join(clone, 'stories'));
  writeFileSync(join(clone, 'stories', 'ACME-1.md'), STORY('ACME-1'));
  git(clone, 'add', '.');
  git(clone, 'commit', '-qm', 'Add the story');
  git(clone, 'push', '-q', 'origin', 'main');
  bin = join(repos.base, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE);
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  chmodSync(join(bin, 'claude'), 0o755);
  chmodSync(join(bin, 'gh'), 0o755);
  log = join(repos.base, 'claude.log');
  writeFileSync(log, '');
}
// The sessions' log: one story id per line, one line per session.
export const sessionLog = () => log;

// Registers the hooks that drop each test's repos and end its supervisor (that one first:
// vitest runs afterEach hooks last first).
export function withSlowRepos() {
  beforeEach(() => {
    repos = null;
  });
  afterEach(() => repos?.cleanup());
  useSupervisors();
}

const runEnv = (fake) => {
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: repos.base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_STOP: join(repos.base, 'claude.stop'), FAKE_CLAUDE_BURN: join(repos.base, 'claude.burn') };
  for (const key of Object.keys(env)) if (/^(FOREMAN|FACTORY)_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key)) delete env[key];
  Object.assign(env, fastTick);
  return { ...env, ...fake };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs `foreman run` in the foreground until it exits; `during` gets the helpers while it runs.
export async function runFactory(fake, during) {
  const state = join(clone, '.foreman');
  const read = (name, fallback) => (existsSync(join(state, name)) ? readFileSync(join(state, name), 'utf8') : fallback);
  const helpers = {
    read,
    events: () => read('events.jsonl', '').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    // Ends a FAKE_BURN session's burn, and with it the session.
    stopBurn: () => writeFileSync(join(repos.base, 'claude.stop'), ''),
    // A FAKE_BURN session's own CPU time, one line a second: "<ISO time> <n> ms CPU".
    burnTrace: () => (existsSync(join(repos.base, 'claude.burn')) ? readFileSync(join(repos.base, 'claude.burn'), 'utf8') : ''),
    stuckFiles: () => (existsSync(join(state, 'outbox')) ? readdirSync(join(state, 'outbox')).filter((f) => f.endsWith('-stuck.json')) : []),
    status: (...args) => runForeman(['status', ...args], { cwd: clone, env: runEnv(fake), encoding: 'utf8' }).stdout ?? '',
    async until(text, ms) {
      let out = '';
      for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) {
        out = helpers.status();
        if (out.includes(text)) break;
      }
      return out;
    },
  };
  const child = startForeman(['run', '--foreground', '--exit-when-idle'], { cwd: clone, env: runEnv(fake), stdio: 'ignore' });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  let code;
  try {
    await during(helpers);
    const timer = setTimeout(() => endChild(child), 40_000);
    code = await exited;
    clearTimeout(timer);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      endChild(child);
      await exited;
    }
  }
  return { code, ...helpers };
}
