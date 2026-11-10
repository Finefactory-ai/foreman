// A real supervisor run, end to end, for the files kept for a story the moment it is picked. Two
// slots, three stories. ACME-2 (the highest priority) has a wait record naming src/a.mjs, which is
// free, so it is picked first; ACME-3 (lower) plans the same file; ACME-4 (lowest) plans nothing.
// From the pick on, the file is kept for ACME-2 (a reservation, before the slot's fetch and before
// the wait record is spent), so w2 starts ACME-4 and not ACME-3 while ACME-2 has not claimed. When
// the start of ACME-2 fails (its slot's environment will not start, or its folder cannot be
// prepared) no session ever ends, so the file kept for it goes free at once and ACME-3 starts. A
// fake `claude` (and `gh`, and `docker`) on the PATH stand in for the sessions, GitHub and Docker.

import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, makeRepos } from '../../../test/state-repos.mjs';
import { fastTick } from '../../../test/fast-tick.mjs';
import { BIN, runForeman, startForeman, useSupervisors } from '../../../test/supervisors.mjs';

const FAKE_CLAUDE = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
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
const defer = (r) => {
  const reason = JSON.parse(r.stdout.trim().split('\\n').pop()).reason;
  foreman('story', 'todo', id, '--note', reason);
  foreman('story', 'end', 'deferred', '', reason);
  end('deferred');
};
const waitUntil = (test, then) => {
  const until = Date.now() + 90000;
  (function poll() {
    if (test()) return then();
    if (Date.now() > until) process.exit(1);
    setTimeout(poll, 50);
  })();
};
if (foreman('story', 'start', id).status !== 0) process.exit(1);
const state = process.env.FOREMAN_STATE_DIR;
const plans = join(state, 'plans');
mkdirSync(plans, { recursive: true });
const plan = join(plans, id + '.json');
const claim = () => {
  writeFileSync(plan, JSON.stringify({ ready: true, builder: 'developer', resources: [], files: ['src/a.mjs'] }));
  return foreman('lock', 'files', id, '--plan', plan);
};
if (id === 'ACME-2') {
  // It does not claim before the test lets it.
  waitUntil(() => existsSync(join(marks, 'go')), () => {
    if (claim().status !== 0) process.exit(1);
    ship();
  });
} else if (id === 'ACME-3') {
  const r = claim();
  if (r.status === 7) defer(r);
  if (r.status !== 0) process.exit(1);
  ship();
} else {
  ship();
}
`;

const FAKE_GH = `#!/bin/sh
case "$1 $2" in
  "pr list") echo "[]" ;;
  *) exit 1 ;;
esac
`;

const STORY = (id, order) => `---\nid: ${id}\ntitle: Story ${id}\nstatus: todo\norder: ${order}\ndepends_on: []\n---\n\nDo ${id}.\n\n## Progress notes\n`;

let repos;
let clone;
let bin;
let log;
let marks;
let child;

afterEach(() => repos?.cleanup());
// After the hook above, so it runs before it (vitest runs afterEach hooks last first).
useSupervisors();

// Each test sets up its own config. With `worktrees` the slots' folders exist before the run, so
// every pick fetches into them (fetchThenStart); without, the first pick makes the folder.
function setup({ extraConfig = {}, worktrees = false } = {}) {
  repos = makeRepos({ version: 1, project: { name: 'Acme' }, slots: 2, workers: 2, console: { adapter: 'files' }, features: { keepAwake: false }, learning: { auto: false }, ...extraConfig });
  clone = repos.clone('acme');
  writeFileSync(join(clone, '.gitignore'), '.foreman/\n');
  mkdirSync(join(clone, 'stories'));
  for (const [id, order] of [['ACME-2', 1], ['ACME-3', 5], ['ACME-4', 9]]) writeFileSync(join(clone, 'stories', `${id}.md`), STORY(id, order));
  git(clone, 'add', '.');
  git(clone, 'commit', '-qm', 'Add the stories');
  git(clone, 'push', '-q', 'origin', 'main');
  if (worktrees) for (const n of [1, 2]) git(clone, 'worktree', 'add', '--detach', join(clone, '.foreman', 'worktrees', `w${n}`), 'origin/main');
  bin = join(repos.base, 'bin');
  mkdirSync(bin);
  // A docker that fails only in slot w1's folder; it matters only when the env adapter is docker.
  const FAKE_DOCKER = '#!/bin/sh\n[ "$(basename "$(pwd -P)")" != w1 ]\n';
  for (const [name, text] of [['claude', FAKE_CLAUDE], ['gh', FAKE_GH], ['docker', FAKE_DOCKER]]) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  log = join(repos.base, 'claude.log');
  writeFileSync(log, '');
  marks = join(repos.base, 'marks');
  mkdirSync(marks);
  child = null;
  // ACME-2 waits on ACME-9, which is not running and under two deferrals: its wait does not hold
  // it back, and it is picked first. Its record names the free file src/a.mjs.
  mkdirSync(join(clone, '.foreman', 'waits'), { recursive: true });
  writeFileSync(join(clone, '.foreman', 'waits', 'ACME-2.json'), JSON.stringify({ story: 'ACME-2', on: ['ACME-9'], files: ['src/a.mjs'], at: new Date().toISOString(), deferrals: { 'ACME-9': 1 } }));
  // ACME-3 plans the same file, so a kept file keeps it out of the pick.
  mkdirSync(join(clone, '.foreman', 'plans'), { recursive: true });
  writeFileSync(join(clone, '.foreman', 'plans', 'ACME-3.json'), JSON.stringify({ ready: true, builder: 'developer', resources: [], files: ['src/a.mjs'] }));
}

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
// Newest first, as the board keeps them.
const recent = () => readJson('state.json', {}).recent ?? [];
const events = () => {
  const file = join(stateDir(), 'events.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).text) : [];
};
const prompts = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).prompt);
const shippedIds = () => recent().filter((r) => r.result === 'shipped').map((r) => r.id);
const reserveFiles = () => (existsSync(join(stateDir(), 'locks')) ? readdirSync(join(stateDir(), 'locks')).filter((f) => f.startsWith('reserve-')) : []);
// Who the files still kept are kept for.
const keptFor = () => reserveFiles().map((f) => readJson(join('locks', f), {}).story);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(what, test, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (test()) return;
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`the run exited (${child.exitCode}) while waiting for ${what}`);
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}; prompts ${JSON.stringify(prompts())}; recent ${JSON.stringify(recent())}`);
}

// The run: ACME-2 is picked in w1 and ACME-4 in w2, ACME-3 is kept out while the file is kept.
const failedStart = async () => {
  child = startForeman(['run', '--foreground'], { cwd: clone, env: runEnv() });
  const exited = child.exited;
  await waitFor('slot w1 to go down', () => events().some((t) => t.startsWith('Slot w1 is down:')), 60_000);
  await waitFor('ACME-3 to ship', () => shippedIds().includes('ACME-3'), 90_000);
  expect(prompts()).not.toContain('/foreman:story ACME-2');
  expect([...shippedIds()].reverse()).toEqual(['ACME-4', 'ACME-3']);
  expect(recent().filter((r) => r.id === 'ACME-3' && r.result === 'deferred')).toEqual([]);
  expect(keptFor()).not.toContain('ACME-2');
  expect(reserveFiles()).toEqual([]);
  expect(foreman('stop').status).toBe(0);
  expect(await exited).toBe(0);
};

describe('foreman run starting a story whose wait names a free file', () => {
  it('keeps the file for the picked story, so a lower-priority story planning it is not started next to it', async () => {
    setup({ worktrees: true });
    child = startForeman(['run', '--foreground'], { cwd: clone, env: runEnv() });
    const exited = child.exited;

    await waitFor('ACME-2 to start', () => prompts().includes('/foreman:story ACME-2'), 60_000);
    expect(reserveFiles()).toHaveLength(1);
    expect(readJson(join('locks', reserveFiles()[0]), {})).toMatchObject({ path: 'src/a.mjs', story: 'ACME-2', from: null });

    // w2 starts ACME-4, not ACME-3, while ACME-2 has not claimed.
    await waitFor('ACME-4 to start', () => prompts().includes('/foreman:story ACME-4'), 60_000);
    expect(prompts()).not.toContain('/foreman:story ACME-3');

    writeFileSync(join(marks, 'go'), '');
    await waitFor('ACME-2 to ship', () => shippedIds().includes('ACME-2'), 60_000);
    await waitFor('ACME-3 to ship', () => shippedIds().includes('ACME-3'), 60_000);
    expect([...shippedIds()].reverse()).toEqual(['ACME-4', 'ACME-2', 'ACME-3']);
    expect(prompts().filter((p) => p === '/foreman:story ACME-3')).toHaveLength(1);
    expect(recent().filter((r) => r.id === 'ACME-3' && r.result === 'deferred')).toEqual([]);
    expect(reserveFiles()).toEqual([]);

    expect(foreman('stop').status).toBe(0);
    expect(await exited).toBe(0);
  }, 150_000);

  it('gives the kept file up at once when the slot environment will not start', async () => {
    setup({ worktrees: true, extraConfig: { env: { adapter: 'docker', projectPrefix: 'acme' } } });
    await failedStart();
  }, 150_000);

  it('gives the kept file up at once when the slot folder cannot be prepared', async () => {
    setup({ extraConfig: { install: { when: 'README.md', run: '[ "$(basename "$(pwd -P)")" != w1 ]' } } });
    await failedStart();
  }, 150_000);
});
