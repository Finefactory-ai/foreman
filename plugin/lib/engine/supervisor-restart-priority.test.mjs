// `foreman run` end to end, for the stories a dead run or `foreman stop --now` left in hand.
//
//   priority    slots 3, workers 1; ACME-1 is a todo with the best order, ACME-3 and ACME-2 are In
//               Progress with dead-run claims in w1 and w2. The todo starts first in w1, then
//               ACME-3, then ACME-2 (whose old slot w2 is over the limit) one after another in w1;
//               each old folder is freed at start-up and never parked.
//   cannot free slots 2, workers 2; ACME-2 (In Progress, dead-run claim in w2, outranks the todo
//               ACME-1) has work in w2 that cannot be committed (a lock on its branch). It is not
//               moved: it resumes in w2 with a warning, its work left in its folder.
//   interrupt   a story cut off by `foreman stop --now` reads interrupted, not failed, in
//               state.json and in the run record, and resumes at the next start.
//
// A fake `claude` (and `gh`) on the PATH stand in for the sessions and GitHub. A fake session
// starts its story and holds it until the test lets it ship.

import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, makeRepos } from '../../../test/state-repos.mjs';
import { fastTick } from '../../../test/fast-tick.mjs';
import { BIN, runForeman, startForeman, useSupervisors } from '../../../test/supervisors.mjs';

const FAKE_CLAUDE = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { appendFileSync, existsSync, unlinkSync } = require('node:fs');
const { join } = require('node:path');
const id = process.env.FOREMAN_STORY;
const marks = process.env.FAKE_MARKS;
const argv = process.argv.slice(2);
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ story: id, slot: process.env.FOREMAN_SLOT, prompt: argv[argv.indexOf('-p') + 1] }) + '\\n');
const foreman = (...args) => spawnSync(process.execPath, [process.env.FAKE_FOREMAN_BIN, ...args], { encoding: 'utf8' });
if (foreman('story', 'start', id).status !== 0) process.exit(1);
const until = Date.now() + 110000;
(function poll() {
  if (existsSync(join(marks, 'crash-' + id))) {
    unlinkSync(join(marks, 'crash-' + id));
    process.exit(1);
  }
  if (existsSync(join(marks, 'release-' + id)) || existsSync(join(marks, 'release-all'))) {
    if (foreman('story', 'done', id, '--note', 'shipped by the fake session').status !== 0) process.exit(1);
    foreman('story', 'end', 'shipped', '', 'shipped by the fake session');
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, result: 'Done.\\nFACTORY_RESULT: shipped ' + id, total_cost_usd: 0, session_id: 'fake' }));
    process.exit(0);
  }
  if (Date.now() > until) process.exit(1);
  setTimeout(poll, 100);
})();
`;

const FAKE_GH = `#!/bin/sh
case "$1 $2" in
  "pr list") echo "[]" ;;
  *) exit 1 ;;
esac
`;

const STORY = (id, status = 'todo', order = 0) => `---\nid: ${id}\ntitle: Story ${id}\nstatus: ${status}\norder: ${order}\ndepends_on: []\n---\n\nDo ${id}.\n\n## Progress notes\n`;

let repos;
let clone;
let bin;
let log;
let marks;
let child;

// `config` is merged over the project's; `statuses` maps a story id to its status, `orders` to its order.
function setup(config, ids, statuses = {}, orders = {}) {
  repos = makeRepos({ version: 1, project: { name: 'Acme' }, slots: 5, console: { adapter: 'files' }, features: { keepAwake: false }, learning: { auto: false }, ...config });
  clone = repos.clone('acme');
  writeFileSync(join(clone, '.gitignore'), '.foreman/\n');
  mkdirSync(join(clone, 'stories'));
  for (const id of ids) writeFileSync(join(clone, 'stories', `${id}.md`), STORY(id, statuses[id], orders[id]));
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
}
afterEach(() => repos?.cleanup());
// After the hook above, so it runs before it (vitest runs afterEach hooks last first).
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
const readSlotState = (slot) => readJson(join('slots', `${slot}.json`), {}).state ?? 'idle';
const recent = () => readJson('state.json', {}).recent ?? [];
const events = () => {
  const file = join(stateDir(), 'events.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).text) : [];
};
const sessions = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const prompts = () => sessions().map((s) => s.prompt);
const shippedIds = () => recent().filter((r) => r.result === 'shipped').map((r) => r.id);
const statusJson = () => {
  const r = foreman('status', '--json');
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout);
};
const storyBySlot = () => Object.fromEntries(statusJson().slots.filter((s) => s.story?.id).map((s) => [s.id, s.story.id]));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(what, test, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (test()) return;
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`the run exited (${child.exitCode}) while waiting for ${what}`);
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}; sessions ${JSON.stringify(sessions().map((s) => [s.story, s.slot]))}; events ${JSON.stringify(events().slice(-8))}`);
}
async function release(id) {
  writeFileSync(join(marks, `release-${id}`), '');
  await waitFor(`${id} to ship`, () => shippedIds().includes(id), 30_000);
}


const deadClaim = (id, slot) => {
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  mkdirSync(join(stateDir(), 'claims'), { recursive: true });
  writeFileSync(join(stateDir(), 'claims', `${id}.json`), JSON.stringify({ pid: dead, slot, story: id, by: 'factory', at: new Date().toISOString() }));
};

describe('stories a run left in hand', () => {
  it('two interrupted stories and a higher-priority todo: the todo starts first with the limit at one', async () => {
    setup({ workers: 1, slots: 3 }, ['ACME-1', 'ACME-2', 'ACME-3'], { 'ACME-2': 'in-progress', 'ACME-3': 'in-progress' }, { 'ACME-1': 0, 'ACME-3': 1, 'ACME-2': 2 });
    const w1 = join(stateDir(), 'worktrees', 'w1');
    const w2 = join(stateDir(), 'worktrees', 'w2');
    git(clone, 'worktree', 'add', '-q', '-b', 'story/acme-3', w1, 'origin/main');
    git(clone, 'worktree', 'add', '-q', '-b', 'story/acme-2', w2, 'origin/main');
    writeFileSync(join(w1, 'wip.txt'), 'unfinished work\n');
    deadClaim('ACME-3', 'w1');
    deadClaim('ACME-2', 'w2');

    child = startForeman(['run', '--foreground'], { cwd: clone, env: runEnv() });
    const exited = child.exited;
    await waitFor('the first session', () => sessions().length >= 1, 90_000);
    expect(sessions()[0]).toMatchObject({ story: 'ACME-1', slot: 'w1' });
    expect(events().indexOf('Start-up: resuming ACME-3.')).toBeGreaterThanOrEqual(0);
    expect(events().indexOf('Start-up: resuming ACME-3.')).toBeLessThan(events().indexOf('Start-up: resuming ACME-2.'));
    expect(git(clone, 'log', '-1', '--format=%s', 'story/acme-3')).toBe('ACME-3 WIP: kept at start-up from slot w1');
    expect(git(clone, 'show', 'story/acme-3:wip.txt')).toBe('unfinished work');
    expect(sessions()).toHaveLength(1);

    // The loop stays up while work is queued, and ACME-1 is released.
    const standby = [];
    const watch = setInterval(() => {
      try {
        if (readJson('state.json', {}).loop?.state === 'standby') standby.push(true);
      } catch {
        // ignore a read in the middle of a write
      }
    }, 100);
    try {
      await release('ACME-1');
      await waitFor('the second session', () => sessions().length >= 2, 60_000);
      expect(sessions()[1]).toMatchObject({ story: 'ACME-3', slot: 'w1' });
      await release('ACME-3');
      await waitFor('the third session', () => sessions().length >= 3, 60_000);
    } finally {
      clearInterval(watch);
    }
    expect(sessions()[2]).toMatchObject({ story: 'ACME-2', slot: 'w1' });
    await waitFor('the move to be said', () => events().includes('ACME-2 moved from w2 to w1, as w2 is over the worker count.'), 30_000);
    expect(standby).toEqual([]);
    expect(events().some((t) => t.includes('held by someone else'))).toBe(false);
    expect(events().some((t) => t.includes('changes that do not belong'))).toBe(false);
    expect(readSlotState('w1')).not.toBe('parked');

    expect(foreman('stop').status).toBe(0);
    await waitFor('the stop to be taken', () => events().some((t) => t.startsWith('Stop requested')), 30_000);
    writeFileSync(join(marks, 'release-all'), '');
    expect(await exited).toBe(0);
  }, 180_000);

  it('an old folder that cannot be freed at start-up: the story resumes in its old slot, with a warning', async () => {
    setup({ workers: 2, slots: 2 }, ['ACME-1', 'ACME-2'], { 'ACME-2': 'in-progress' }, { 'ACME-2': 0, 'ACME-1': 1 });
    const w2 = join(stateDir(), 'worktrees', 'w2');
    git(clone, 'worktree', 'add', '-q', '-b', 'story/acme-2', w2, 'origin/main');
    writeFileSync(join(w2, 'wip.txt'), 'unfinished work\n');
    deadClaim('ACME-2', 'w2');
    // A lock on the branch ref makes the commit fail while the add still works.
    const lock = join(clone, '.git', 'refs', 'heads', 'story', 'acme-2.lock');
    writeFileSync(lock, '');

    child = startForeman(['run', '--foreground'], { cwd: clone, env: runEnv() });
    const exited = child.exited;
    await waitFor('the warning', () => events().includes("Start-up: could not free w2's folder for ACME-2 (could not commit its changes to story/acme-2); it resumes in w2."), 90_000);
    unlinkSync(lock);
    await waitFor('both sessions', () => sessions().length >= 2, 90_000);
    expect(Object.fromEntries(sessions().map((s) => [s.story, s.slot]))).toEqual({ 'ACME-1': 'w1', 'ACME-2': 'w2' });
    expect(events().some((t) => t.startsWith('ACME-2 moved from') || t.startsWith('ACME-2 could not move'))).toBe(false);
    expect(events().some((t) => t.includes('changes that do not belong'))).toBe(false);
    expect(readSlotState('w2')).not.toBe('parked');
    expect(git(clone, 'log', '-1', '--format=%s', 'story/acme-2')).not.toBe('ACME-2 WIP: kept at start-up from slot w2');
    expect(readFileSync(join(w2, 'wip.txt'), 'utf8')).toBe('unfinished work\n');

    expect(foreman('stop').status).toBe(0);
    await waitFor('the stop to be taken', () => events().some((t) => t.startsWith('Stop requested')), 30_000);
    writeFileSync(join(marks, 'release-all'), '');
    expect(await exited).toBe(0);
  }, 180_000);

  it('an In Progress story with a branch and no claim waits for the higher-priority todo and runs once', async () => {
    setup({ workers: 1, slots: 2 }, ['ACME-1', 'ACME-2'], { 'ACME-2': 'in-progress' }, { 'ACME-1': 0, 'ACME-2': 1 });
    git(clone, 'branch', 'story/acme-2', 'origin/main');

    child = startForeman(['run', '--foreground'], { cwd: clone, env: runEnv() });
    const exited = child.exited;
    await waitFor('the first session', () => sessions().length >= 1, 90_000);
    expect(sessions()[0]).toMatchObject({ story: 'ACME-1', slot: 'w1' });
    await waitFor('the resume to be said', () => events().includes('Start-up: resuming ACME-2.'), 30_000);

    await release('ACME-1');
    await waitFor('the second session', () => sessions().length >= 2, 60_000);
    expect(sessions()[1]).toMatchObject({ story: 'ACME-2', slot: 'w1' });
    await release('ACME-2');
    // Give the loop time to start the story again, were it still queued or picked.
    await waitFor('the loop to settle', () => readJson('state.json', {}).loop?.state === 'standby', 60_000);
    expect(sessions().map((s) => s.story)).toEqual(['ACME-1', 'ACME-2']);
    expect(events().filter((t) => t === 'ACME-2 shipped' || t.startsWith('ACME-2 shipped')).length).toBeLessThanOrEqual(1);
    expect(events().some((t) => t.includes('held by someone else'))).toBe(false);

    expect(foreman('stop').status).toBe(0);
    expect(await exited).toBe(0);
  }, 180_000);

  it('an interrupted story reads interrupted, and is resumed at the next start', async () => {
    setup({ slots: 1 }, ['ACME-1']);
    child = startForeman(['run', '--foreground'], { cwd: clone, env: runEnv() });
    const first = child.exited;
    await waitFor('the session', () => sessions().length === 1 && readSlotState('w1') === 'building', 90_000);
    expect(foreman('stop', '--now').status).toBe(0);
    await first;

    expect(recent()[0]).toMatchObject({ id: 'ACME-1', result: 'interrupted' });
    const runsDir = join(stateDir(), 'runs');
    const records = readdirSync(runsDir).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(readFileSync(join(runsDir, n), 'utf8')));
    expect(records.map((r) => r.result)).toEqual(['interrupted']);
    expect(events()).toContain('ACME-1 interrupted: stopped with the run; it resumes at the next start');
    expect(events().some((t) => t.startsWith('ACME-1 failed'))).toBe(false);

    child = startForeman(['run', '--foreground'], { cwd: clone, env: runEnv() });
    const second = child.exited;
    await waitFor('the second session', () => sessions().length === 2, 90_000);
    expect(events()).toContain('Start-up: resuming ACME-1.');
    expect(sessions()[1]).toMatchObject({ story: 'ACME-1', slot: 'w1' });

    writeFileSync(join(marks, 'release-all'), '');
    expect(foreman('stop').status).toBe(0);
    expect(await second).toBe(0);
  }, 150_000);
});
