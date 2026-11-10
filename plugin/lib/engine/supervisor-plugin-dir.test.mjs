// A supervisor run end to end: which plugin folder a story session is given. The supervisor passes
// `--plugin-dir <its own plugin folder>` when the installed Foreman copy is elsewhere, and nothing
// when the installed copy is that folder. It says so once at start, and once on the slot when the
// session's init event shows a different copy loaded. A fake `claude` (and `gh`) on the PATH stand
// in for the session and GitHub; the fake logs the --plugin-dir it got, prints an init event
// naming the plugin path the test chose, and waits for the test before it ends, so the
// supervisor's check of the init has run by then.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { git, makeRepos } from '../../../test/state-repos.mjs';
import { fastTick, TEST_TICK_MS } from '../../../test/fast-tick.mjs';
import { endChild, startForeman, useSupervisors } from '../../../test/supervisors.mjs';
import { PLUGIN_DIR } from './code-version.mjs';

// `claude auth status` says signed out. Any other call logs the --plugin-dir it got, prints an
// init event with the plugin path FAKE_PLUGIN_PATH, waits for the file FAKE_PROCEED, then marks
// its story blocked and says so.
const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync, existsSync, mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
if (process.argv[2] === 'auth') {
  console.log(JSON.stringify({ loggedIn: false }));
  process.exit(0);
}
const id = process.env.FOREMAN_STORY;
const at = process.argv.indexOf('--plugin-dir');
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ pluginDir: at === -1 ? null : process.argv[at + 1] }) + '\\n');
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake', model: 'claude-opus-5-5', plugins: [{ name: 'foreman', path: process.env.FAKE_PLUGIN_PATH, source: 'foreman@foreman', version: '0.0.1' }] }));
const wait = () => {
  if (!existsSync(process.env.FAKE_PROCEED)) return setTimeout(wait, 50);
  const stories = join(process.env.FOREMAN_STATE_DIR, 'stories');
  mkdirSync(stories, { recursive: true });
  writeFileSync(join(stories, id + '.json'), JSON.stringify({ id, status: 'blocked', blockedBy: 'Fake session', fields: {}, notes: [] }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, result: 'Could not get further.\\nFACTORY_RESULT: blocked ' + id, total_cost_usd: 0, session_id: 'fake' }));
  process.exit(0);
};
wait();
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
let proceed;

function setUp() {
  repos = makeRepos({ version: 1, project: { name: 'Acme' }, console: { adapter: 'files' }, features: { keepAwake: false } });
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
  proceed = join(repos.base, 'proceed');
}

beforeEach(() => {
  repos = null;
});
afterEach(() => repos?.cleanup());
// After the hooks above, so it runs before them (vitest runs afterEach hooks last first).
useSupervisors();

// The user-scope installed copy of the plugin: Claude Code's own file, in the config folder.
function install(installPath) {
  const plugins = join(repos.base, '.claude', 'plugins');
  mkdirSync(plugins, { recursive: true });
  writeFileSync(join(plugins, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'foreman@foreman': [{ scope: 'user', installPath, version: '0.0.1' }] } }));
}

const runEnv = (pluginPath) => {
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: repos.base,
    CLAUDE_CONFIG_DIR: join(repos.base, '.claude'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    FAKE_CLAUDE_LOG: log,
    FAKE_PROCEED: proceed,
    FAKE_PLUGIN_PATH: pluginPath,
  };
  for (const key of Object.keys(env)) {
    if (/^(FOREMAN|FACTORY)_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'].includes(key)) delete env[key];
  }
  Object.assign(env, fastTick);
  return env;
};

const sessions = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const events = () => {
  const file = join(clone, '.foreman', 'events.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const warns = (part) => events().filter((e) => e.kind === 'warn' && e.text.includes(part));
const until = async (ready, what) => {
  const deadline = Date.now() + 60_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

// Runs the supervisor to idle, letting the session end once `ready` says the checks it waits on
// have had their chance.
async function runToIdle(pluginPath, ready) {
  const child = startForeman(['run', '--foreground', '--exit-when-idle'], { cwd: clone, env: runEnv(pluginPath), stdio: 'ignore' });
  const exited = new Promise((resolveExit) => child.on('exit', (code) => resolveExit(code)));
  const timer = setTimeout(() => endChild(child), 80_000);
  await until(() => sessions().length > 0, 'the session to start');
  await ready();
  writeFileSync(proceed, '');
  const code = await exited;
  clearTimeout(timer);
  return code;
}

describe('the plugin folder a story session loads', () => {
  it("loads the supervisor's plugin folder when the installed copy is elsewhere, and says so once at start and once on the slot", async () => {
    setUp();
    const cache = join(repos.base, 'cache', 'foreman', '0.0.1');
    install(cache);
    // After the warning, a few more ticks pass with the session still up: it must not warn again.
    const code = await runToIdle(cache, async () => {
      await until(() => warns('its session loaded').length > 0, "the slot's warning");
      await new Promise((r) => setTimeout(r, 3 * TEST_TICK_MS));
    });
    expect(code).toBe(0);
    expect(sessions()).toEqual([{ pluginDir: resolve(PLUGIN_DIR) }]);
    const start = warns('story sessions load this one with --plugin-dir');
    expect(start).toHaveLength(1);
    expect(start[0].slot).toBeNull();
    expect(start[0].text).toContain('0.0.1');
    expect(start[0].text).toContain(cache);
    const slot = warns('its session loaded').filter((e) => e.slot === 'w1');
    expect(slot).toHaveLength(1);
    expect(slot[0].text).toContain(`its session loaded Foreman 0.0.1 from ${cache}`);
    expect(warns('its session loaded')).toHaveLength(1);
  }, 90_000);

  it("passes nothing extra when the installed copy is the supervisor's own folder", async () => {
    setUp();
    install(PLUGIN_DIR);
    // The check of the init runs on a tick; give it a few before the session ends.
    const code = await runToIdle(PLUGIN_DIR, () => new Promise((r) => setTimeout(r, 3 * TEST_TICK_MS)));
    expect(code).toBe(0);
    expect(sessions()).toEqual([{ pluginDir: null }]);
    expect(events().filter((e) => e.text.includes('--plugin-dir') || e.text.includes('its session loaded'))).toEqual([]);
  }, 90_000);
});
