// `foreman run` end to end, for file locks: two slots, three stories. ACME-1 claims src/a.mjs and
// holds it until the test lets it ship. ACME-2 names src/a.mjs and src/b.mjs, so `foreman lock
// files` refuses it (exit 7) and its session defers with the reason; the picker then leaves it
// alone while ACME-1 runs, and ACME-3, whose file is free, starts at once. A "build next" request
// for ACME-2 meanwhile stays open as failed tries. When ACME-1 ships, its file lock goes with its
// slot's token, and ACME-2 is picked again (it is the request) and ships. A fake `claude`
// (and `gh`) on the PATH stand in for the sessions and GitHub.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, makeRepos } from '../../../test/state-repos.mjs';
import { fastTick, TEST_TICK_MS } from '../../../test/fast-tick.mjs';
import { BIN, runForeman, startForeman, useSupervisors } from '../../../test/supervisors.mjs';

const FAKE_CLAUDE = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { appendFileSync, existsSync, mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const id = process.env.FOREMAN_STORY;
const marks = process.env.FAKE_MARKS;
const argv = process.argv.slice(2);
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ story: id, prompt: argv[argv.indexOf('-p') + 1] }) + '\\n');
const foreman = (...args) => spawnSync(process.execPath, [process.env.FAKE_FOREMAN_BIN, ...args], { encoding: 'utf8' });
const end = (result) => {
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, result: 'Done.\\nFACTORY_RESULT: ' + result + ' ' + id, total_cost_usd: 0, session_id: 'fake' }));
  process.exit(0);
};
const ship = () => {
  if (foreman('story', 'done', id, '--note', 'shipped by the fake session').status !== 0) process.exit(1);
  foreman('story', 'end', 'shipped', '', 'shipped by the fake session');
  end('shipped');
};
const waitFor = (name, then) => {
  const until = Date.now() + 90000;
  (function poll() {
    if (existsSync(join(marks, name))) return then();
    if (Date.now() > until) process.exit(1);
    setTimeout(poll, 100);
  })();
};
if (foreman('story', 'start', id).status !== 0) process.exit(1);
const plans = join(process.env.FOREMAN_STATE_DIR, 'plans');
mkdirSync(plans, { recursive: true });
const files = { 'ACME-1': ['src/a.mjs'], 'ACME-2': ['src/a.mjs', 'src/b.mjs'], 'ACME-3': ['src/c.mjs'] }[id];
const plan = join(plans, id + '.json');
writeFileSync(plan, JSON.stringify({ ready: true, builder: 'developer', resources: [], files }));
const claim = () => foreman('lock', 'files', id, '--plan', plan);
if (id === 'ACME-1') {
  if (claim().status !== 0) process.exit(1);
  writeFileSync(join(marks, 'claimed'), '');
  waitFor('release', ship);
} else if (id === 'ACME-2') {
  waitFor('claimed', () => {
    const r = claim();
    if (r.status === 7) {
      const reason = JSON.parse(r.stdout.trim().split('\\n').pop()).reason;
      foreman('story', 'todo', id, '--note', reason);
      foreman('story', 'end', 'deferred', '', reason);
      end('deferred');
    }
    if (r.status !== 0) process.exit(1);
    ship();
  });
} else {
  if (claim().status !== 0) process.exit(1);
  ship();
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
let marks;
let child;

beforeEach(() => {
  repos = makeRepos({ version: 1, project: { name: 'Acme' }, slots: 2, workers: 2, console: { adapter: 'files' }, features: { keepAwake: false }, learning: { auto: false }, watchdog: { idleMinutes: 0.05 } });
  clone = repos.clone('acme');
  writeFileSync(join(clone, '.gitignore'), '.foreman/\n');
  mkdirSync(join(clone, 'stories'));
  for (const id of ['ACME-1', 'ACME-2', 'ACME-3']) writeFileSync(join(clone, 'stories', `${id}.md`), STORY(id));
  git(clone, 'add', '.');
  git(clone, 'commit', '-qm', 'Add the stories');
  git(clone, 'push', '-q', 'origin', 'main');
  bin = join(repos.base, 'bin');
  mkdirSync(bin);
  for (const [name, text] of [['claude', FAKE_CLAUDE], ['gh', FAKE_GH]]) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  log = join(repos.base, 'claude.log');
  writeFileSync(log, '');
  marks = join(repos.base, 'marks');
  mkdirSync(marks);
  child = null;
});
afterEach(() => repos.cleanup());
// After the hooks above, so it runs before them (vitest runs afterEach hooks last first).
useSupervisors();

const runEnv = () => {
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: repos.base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(env)) if (/^(FOREMAN|FACTORY)_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key)) delete env[key];
  return { ...env, ...fastTick, FAKE_CLAUDE_LOG: log, FAKE_FOREMAN_BIN: BIN, FAKE_MARKS: marks };
};
const foreman = (...args) => runForeman(args, { cwd: clone, env: runEnv(), timeout: 30_000 });

const stateDir = () => join(clone, '.foreman');
const readJson = (name, fallback) => {
  try {
    return JSON.parse(readFileSync(join(stateDir(), name), 'utf8'));
  } catch {
    return fallback;
  }
};
const recent = () => readJson('state.json', {}).recent ?? [];
const events = () => {
  const file = join(stateDir(), 'events.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).text) : [];
};
const prompts = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).prompt);
const shippedIds = () => recent().filter((r) => r.result === 'shipped').map((r) => r.id);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const IDLE_MS = 3000; // watchdog.idleMinutes 0.05
const waitRecord = () => readJson(join('waits', 'ACME-2.json'), null);
// The files ACME-2 waited on come free while ACME-1 still runs: its wait record names nothing and
// its plan is gone, so only the deferral counts can keep it out (file-locks.mjs waitOf). The record
// is renamed over the old one, so the supervisor never reads a half-written file.
function freeFiles() {
  const record = waitRecord();
  const tmp = join(stateDir(), 'waits', 'ACME-2.json.test.tmp');
  writeFileSync(tmp, JSON.stringify({ story: 'ACME-2', on: [], files: [], at: record.at, deferrals: record.deferrals }));
  renameSync(tmp, join(stateDir(), 'waits', 'ACME-2.json'));
  rmSync(join(stateDir(), 'plans', 'ACME-2.json'), { force: true });
}
async function waitFor(what, test, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (test()) return;
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`the run exited (${child.exitCode}) while waiting for ${what}`);
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}; prompts ${JSON.stringify(prompts())}; recent ${JSON.stringify(recent())}`);
}

describe('foreman run with two stories naming the same file', () => {
  it('defers the second until the first ships, and starts one with disjoint files at once', async () => {
    child = startForeman(['run', '--foreground'], { cwd: clone, env: runEnv() });
    const exited = child.exited;

    // ACME-2 finds src/a.mjs held by ACME-1 and defers, with the reason on the board.
    await waitFor('ACME-2 to defer', () => recent().some((r) => r.id === 'ACME-2' && r.result === 'deferred'), 60_000);
    const deferred = recent().find((r) => r.id === 'ACME-2');
    expect(deferred.note).toContain('ACME-1');
    expect(deferred.note).toContain('src/a.mjs');
    expect(events().some((t) => t.startsWith('ACME-2 deferred: waiting for ACME-1'))).toBe(true);

    // ACME-3 names only src/c.mjs: it starts and ships while ACME-1 still holds src/a.mjs.
    await waitFor('ACME-3 to start', () => prompts().includes('/foreman:story ACME-3'), 60_000);
    await waitFor('ACME-3 to ship', () => shippedIds().includes('ACME-3'), 60_000);
    expect(existsSync(join(marks, 'release'))).toBe(false);
    expect(shippedIds()).not.toContain('ACME-1');

    // ACME-2 is not started again while ACME-1 runs, over several ticks.
    await sleep(TEST_TICK_MS * 6);
    expect(prompts().filter((p) => p === '/foreman:story ACME-2')).toHaveLength(1);
    expect(shippedIds()).not.toContain('ACME-1');

    // Status names what it waits on.
    expect(foreman('status').stdout).toContain('ACME-2 waits for ACME-1: src/a.mjs');

    // A "build next" request for it stays open as failed tries, not refused.
    const wording = 'ACME-2 waits for ACME-1: src/a.mjs';
    expect(foreman('next', 'ACME-2').status).toBe(0);
    await waitFor('the request to fail 3 tries', () => events().includes(`You asked for ACME-2 next, but it could not start after 3 tries (${wording}); it stays first in line.`), 60_000);
    expect(events().some((t) => t.startsWith('You asked for ACME-2 next, but it cannot be built yet'))).toBe(false);
    // A request that only waits on a running story is not a story that should have started: no idle alert.
    await sleep(IDLE_MS + 2 * TEST_TICK_MS);
    expect(events().some((t) => t.includes('ACME-2 can be built and a slot is free'))).toBe(false);
    expect(readJson('state.json', {}).stuck ?? null).toBeNull();
    expect(prompts().filter((p) => p === '/foreman:story ACME-2')).toHaveLength(1);

    // ACME-1 ships, its file lock goes, and ACME-2 is picked and ships.
    writeFileSync(join(marks, 'release'), '');
    await waitFor('ACME-1 to ship', () => shippedIds().includes('ACME-1'), 30_000);
    await waitFor('ACME-2 to ship', () => shippedIds().includes('ACME-2'), 60_000);
    expect(prompts().filter((p) => p === '/foreman:story ACME-2')).toHaveLength(2);
    expect(events()).toContain('You asked for ACME-2 next; starting it.');
    expect(prompts().indexOf('/foreman:story ACME-3')).toBeLessThan(prompts().lastIndexOf('/foreman:story ACME-2'));
    expect(readJson('schema-stories.json', [])).not.toContain('ACME-2');
    expect(existsSync(join(stateDir(), 'waits', 'ACME-2.json'))).toBe(false);

    expect(foreman('stop').status).toBe(0);
    expect(await exited).toBe(0);
  }, 120_000);

  it('keeps a story deferred twice on the same running story out until that story ships', async () => {
    child = startForeman(['run', '--foreground'], { cwd: clone, env: runEnv() });
    const exited = child.exited;
    const deferrals = () => recent().filter((r) => r.id === 'ACME-2' && r.result === 'deferred').length;
    const asks = () => prompts().filter((p) => p === '/foreman:story ACME-2');

    await waitFor('ACME-2 to defer', () => deferrals() >= 1, 60_000);
    expect(waitRecord().deferrals).toEqual({ 'ACME-1': 1 });
    await waitFor('ACME-3 to ship', () => shippedIds().includes('ACME-3'), 60_000);

    // Its files come free while ACME-1 still runs: it is picked a second time and defers again.
    freeFiles();
    await waitFor('ACME-2 to start again', () => asks().length === 2, 60_000);
    await waitFor('ACME-2 to defer twice', () => deferrals() >= 2, 60_000);
    expect(shippedIds()).not.toContain('ACME-1');
    // The count of the holder that still runs was kept (a clearWait at the start would reset it).
    expect(waitRecord().deferrals).toEqual({ 'ACME-1': 2 });

    // Freed again, only the count keeps it out: not picked a third time over several ticks.
    freeFiles();
    await sleep(TEST_TICK_MS * 6);
    expect(asks()).toHaveLength(2);
    expect(shippedIds()).not.toContain('ACME-1');
    expect(foreman('status').stdout).toContain('ACME-2 waits for ACME-1 to ship or end: deferred on it twice');

    // ACME-1 ships, and the rule lets go: ACME-2 starts a third time and ships.
    writeFileSync(join(marks, 'release'), '');
    await waitFor('ACME-1 to ship', () => shippedIds().includes('ACME-1'), 30_000);
    await waitFor('ACME-2 to ship', () => shippedIds().includes('ACME-2'), 60_000);
    expect(asks()).toHaveLength(3);
    expect(existsSync(join(stateDir(), 'waits', 'ACME-2.json'))).toBe(false);

    expect(foreman('stop').status).toBe(0);
    expect(await exited).toBe(0);
  }, 120_000);
});
