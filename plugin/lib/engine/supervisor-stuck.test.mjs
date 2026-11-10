// `foreman run` end to end, when the story source fails on every loop (the first story's session
// deletes the stories folder): with watchdog.errorMinutes at 0.05 (3 s), the progress watchdog
// says so within the limit plus two ticks, in `foreman status` and as one Needs-you item, sends
// one notification however many loops fail, and the alert clears when the run stops. A fake
// `claude` (and `gh`) on the PATH stand in for the session and GitHub.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, makeRepos } from '../../../test/state-repos.mjs';
import { endChild, runForeman, startForeman, useSupervisors } from '../../../test/supervisors.mjs';

// The session marks its story blocked in the state overlay, deletes the project's stories
// folder, and says it is blocked.
const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const id = process.env.FOREMAN_STORY;
appendFileSync(process.env.FAKE_CLAUDE_LOG, id + '\\n');
const stories = join(process.env.FOREMAN_STATE_DIR, 'stories');
mkdirSync(stories, { recursive: true });
writeFileSync(join(stories, id + '.json'), JSON.stringify({ id, status: 'blocked', blockedBy: 'Fake session', fields: {}, notes: [] }));
if (id === 'ACME-1') rmSync(join(process.env.FOREMAN_PROJECT_DIR, 'stories'), { recursive: true });
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, result: 'Could not get further.\\nFACTORY_RESULT: blocked ' + id, total_cost_usd: 0, session_id: 'fake' }));
`;

const FAKE_GH = `#!/bin/sh
case "$1 $2" in
  "pr list") echo "[]" ;;
  *) exit 1 ;;
esac
`;

const STORY = (id) => `---\nid: ${id}\ntitle: Story ${id}\nstatus: todo\ndepends_on: []\n---\n\nDo ${id}.\n\n## Progress notes\n`;
const ERROR_MS = 3000;
const TICK_MS = 5000;

let repos;
let clone;
let bin;
let log;

beforeEach(() => {
  repos = makeRepos({ version: 1, project: { name: 'Acme' }, console: { adapter: 'files' }, features: { keepAwake: false }, learning: { auto: false }, watchdog: { errorMinutes: 0.05 } });
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
});
afterEach(() => repos.cleanup());
// After the hooks above, so it runs before them (vitest runs afterEach hooks last first).
useSupervisors();

const runEnv = () => {
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: repos.base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', FAKE_CLAUDE_LOG: log };
  for (const key of Object.keys(env)) if (/^(FOREMAN|FACTORY)_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key)) delete env[key];
  return env;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('the supervisor when it fails on every loop', () => {
  it('says it is stuck once, in status and as one item, and clears when the run stops', async () => {
    const state = join(clone, '.foreman');
    const read = (name, fallback) => (existsSync(join(state, name)) ? readFileSync(join(state, name), 'utf8') : fallback);
    const events = () => read('events.jsonl', '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const stuckFiles = () => (existsSync(join(state, 'outbox')) ? readdirSync(join(state, 'outbox')).filter((f) => f.endsWith('-stuck.json')) : []);
    const status = (...args) => runForeman(['status', ...args], { cwd: clone, env: runEnv(), encoding: 'utf8' }).stdout ?? '';

    // In the foreground, so this test owns the process; --exit-when-idle, so it stops once nothing is left.
    const child = startForeman(['run', '--foreground', '--exit-when-idle'], { cwd: clone, env: runEnv(), stdio: 'ignore' });
    const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    let code;
    let since;
    try {
      let text = '';
      for (const end = Date.now() + 40_000; Date.now() < end; await sleep(500)) {
        text = status();
        if (text.includes('Foreman: running, but stuck: the supervisor fails every loop: ENOENT')) break;
      }
      expect(text).toContain('Foreman: running, but stuck: the supervisor fails every loop: ENOENT');
      const snap = JSON.parse(status('--json'));
      expect(snap.waiting.items.filter((i) => i.id === 'run:stuck')).toHaveLength(1);
      since = snap.stuck.since;

      // Two more failing loops: still one notification and one event.
      await sleep(11_000);
      expect(stuckFiles()).toHaveLength(1);
      expect(events().filter((e) => e.kind === 'warn' && e.text.startsWith('Not building for'))).toHaveLength(1);

      // The stories are back: the next clean loop finds nothing left and the run stops.
      mkdirSync(join(clone, 'stories'), { recursive: true });
      writeFileSync(join(clone, 'stories', 'ACME-1.md'), STORY('ACME-1'));
      const timer = setTimeout(() => endChild(child), 30_000);
      code = await exited;
      clearTimeout(timer);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        endChild(child);
        await exited;
      }
    }
    expect(code).toBe(0);
    expect(readFileSync(log, 'utf8').split('\n').filter(Boolean)).toEqual(['ACME-1']);

    const saved = JSON.parse(read('state.json', '{}'));
    expect(saved.stuck).toBeNull();
    const all = events();
    const closing = all.map((e) => e.text.match(/^Supervisor error: ENOENT.* \((\d+) times since \d\d:\d\d\)$/)).find(Boolean);
    expect(Number(closing?.[1])).toBeGreaterThanOrEqual(3);
    const firstError = all.find((e) => /^Supervisor error: ENOENT/.test(e.text));
    const alert = all.find((e) => e.text.startsWith('Not building for'));
    expect(alert.text).toMatch(/^Not building for less than a minute: the supervisor fails every loop: ENOENT/);
    // The clock starts at the first failing loop.
    expect(Math.abs(Date.parse(since) - Date.parse(firstError.at))).toBeLessThan(1000);
    expect(Date.parse(alert.at) - Date.parse(since)).toBeLessThan(ERROR_MS + 2 * TICK_MS);
    expect(stuckFiles()).toHaveLength(1);
  }, 90_000);
});
