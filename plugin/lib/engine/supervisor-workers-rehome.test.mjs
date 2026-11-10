// `foreman run` end to end, for work queued for a slot above the worker count: five slots, workers
// 3. Such a slot never picks anything up, so work pinned to it must move to a slot under the limit,
// with its claim and its folder.
//
//   start-up recovery   ACME-1 is In Progress and a dead run's claim names slot w4, whose folder is
//                       still on the story branch with an uncommitted file. At start-up its
//                       unfinished work is committed on its branch and w4's folder is detached and
//                       clean; the story starts in w1 and its claim moves to w1.
//   crash resume        workers 5 and four stories, then `foreman workers 3`; the story in w4
//                       crashes and is queued for w4. Status names it; when w1 frees up it starts
//                       there, within a few ticks, and the loop never goes to standby meanwhile.
//   foreign changes     as start-up recovery, but w1's folder holds a file no story owns: w1 is
//                       parked, the story starts in w2, and w1's file is left alone.
//
// A fake `claude` (and `gh`) on the PATH stand in for the sessions and GitHub. A fake session
// starts its story and holds it until the test lets it ship; a mark `crash-<id>` makes it exit
// with no result once instead.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, makeRepos } from '../../../test/state-repos.mjs';
import { fastTick, TEST_TICK_MS } from '../../../test/fast-tick.mjs';
import { readPid } from './supervisor-pid.mjs';
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

const STORY = (id, status = 'todo') => `---\nid: ${id}\ntitle: Story ${id}\nstatus: ${status}\ndepends_on: []\n---\n\nDo ${id}.\n\n## Progress notes\n`;

let repos;
let clone;
let bin;
let log;
let marks;
let child;

// `config` is merged over the project's; `statuses` maps a story id to its status.
function setup(config, ids, statuses = {}) {
  repos = makeRepos({ version: 1, project: { name: 'Acme' }, slots: 5, console: { adapter: 'files' }, features: { keepAwake: false }, learning: { auto: false }, ...config });
  clone = repos.clone('acme');
  writeFileSync(join(clone, '.gitignore'), '.foreman/\n');
  mkdirSync(join(clone, 'stories'));
  for (const id of ids) writeFileSync(join(clone, 'stories', `${id}.md`), STORY(id, statuses[id]));
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
const SLOTS = ['w1', 'w2', 'w3', 'w4'];

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

describe('work queued for a slot above the worker count', () => {
  it('start-up recovery: a story a dead run had in w4 starts in w1, with its claim and its folder', async () => {
    setup({ workers: 3 }, ['ACME-1'], { 'ACME-1': 'in-progress' });
    // The dead run: ACME-1 built in w4, whose folder holds an uncommitted file on the story branch.
    const w4 = join(stateDir(), 'worktrees', 'w4');
    git(clone, 'worktree', 'add', '-q', '-b', 'story/acme-1', w4, 'origin/main');
    writeFileSync(join(w4, 'wip.txt'), 'unfinished work\n');
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    mkdirSync(join(stateDir(), 'claims'), { recursive: true });
    writeFileSync(join(stateDir(), 'claims', 'ACME-1.json'), JSON.stringify({ pid: dead, slot: 'w4', story: 'ACME-1', by: 'factory', at: new Date().toISOString() }));

    child = startForeman(['run', '--foreground'], { cwd: clone, env: runEnv() });
    const exited = child.exited;
    await waitFor('the session', () => sessions().length >= 1, 90_000);
    expect(sessions()[0]).toMatchObject({ story: 'ACME-1', slot: 'w1' });
    await waitFor('the move to be said', () => events().some((t) => t.startsWith('ACME-1 moved from w4 to w1')), 30_000);
    expect(events().some((t) => t.includes('held by someone else'))).toBe(false);
    expect(events()).toContain('Start-up: resuming ACME-1.');

    expect(git(clone, 'log', '-1', '--format=%s', 'story/acme-1')).toBe('ACME-1 WIP: kept at start-up from slot w4');
    expect(git(clone, 'show', 'story/acme-1:wip.txt')).toBe('unfinished work');
    expect(git(w4, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
    expect(git(w4, 'status', '--porcelain')).toBe('');
    const claim = JSON.parse(readFileSync(join(stateDir(), 'claims', 'ACME-1.json'), 'utf8'));
    expect(claim).toMatchObject({ slot: 'w1', pid: readPid(stateDir()), story: 'ACME-1', by: 'factory' });

    expect(foreman('stop').status).toBe(0);
    await waitFor('the stop to be taken', () => events().some((t) => t.startsWith('Stop requested')), 30_000);
    writeFileSync(join(marks, 'release-all'), '');
    expect(await exited).toBe(0);
  }, 120_000);

  it('crash resume after lowering: the story queued for w4 starts in the first slot that frees up', async () => {
    setup({ workers: 5 }, ['ACME-1', 'ACME-2', 'ACME-3', 'ACME-4']);
    child = startForeman(['run', '--foreground'], { cwd: clone, env: runEnv() });
    const exited = child.exited;

    await waitFor('4 sessions', () => sessions().length === 4, 90_000);
    await waitFor('4 building slots', () => SLOTS.every((s) => readSlotState(s) === 'building'), 30_000);
    expect(foreman('workers', '3').status).toBe(0);
    await waitFor('workers to be 3', () => readJson('state.json', {}).workers === 3, 30_000);
    const bySlot = storyBySlot();
    expect(Object.keys(bySlot).sort()).toEqual(SLOTS);

    // The story in w4 crashes; it is queued, and nothing under the limit is free to take it.
    const crashed = bySlot.w4;
    writeFileSync(join(marks, `crash-${crashed}`), '');
    await waitFor('the queued story to show in status', () => (statusJson().queued ?? []).length === 1, 30_000);
    const queued = statusJson().queued;
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ id: crashed, from: 'w4' });
    expect(queued[0].text).toContain('queued for w4, which is over the worker count');
    const plain = foreman('status');
    expect(plain.status).toBe(0);
    expect(plain.stdout).toContain('Queued:');
    expect(plain.stdout).toContain(queued[0].text);
    expect(sessions()).toHaveLength(4);

    // w1 frees up: the queued story starts there, a 5th session.
    const standby = [];
    const watch = setInterval(() => {
      try {
        if (readJson('state.json', {}).loop?.state === 'standby') standby.push(true);
      } catch {
        // ignore a read in the middle of a write
      }
    }, 100);
    try {
      await release(bySlot.w1);
      await waitFor('a 5th session', () => sessions().length === 5, TEST_TICK_MS * 20);
    } finally {
      clearInterval(watch);
    }
    expect(sessions()[4]).toMatchObject({ story: crashed, slot: 'w1' });
    await waitFor('the queue to empty', () => (statusJson().queued ?? []).length === 0, 30_000);
    expect(standby).toEqual([]);
    expect(events().some((t) => t.includes('held by someone else'))).toBe(false);
    expect(events().some((t) => t.startsWith(`${crashed} moved from w4 to w1`))).toBe(true);
    const claim = JSON.parse(readFileSync(join(stateDir(), 'claims', `${crashed}.json`), 'utf8'));
    expect(claim).toMatchObject({ slot: 'w1', story: crashed });

    expect(foreman('stop').status).toBe(0);
    await waitFor('the stop to be taken', () => events().some((t) => t.startsWith('Stop requested')), 30_000);
    writeFileSync(join(marks, 'release-all'), '');
    expect(await exited).toBe(0);
  }, 150_000);

  it('start-up recovery with foreign changes in w1: the story a dead run had in w4 starts in w2, and w1 is parked', async () => {
    setup({ workers: 3 }, ['ACME-1'], { 'ACME-1': 'in-progress' });
    const w4 = join(stateDir(), 'worktrees', 'w4');
    git(clone, 'worktree', 'add', '-q', '-b', 'story/acme-1', w4, 'origin/main');
    writeFileSync(join(w4, 'wip.txt'), 'unfinished work\n');
    // w1's folder holds a change no story owns.
    const w1 = join(stateDir(), 'worktrees', 'w1');
    git(clone, 'worktree', 'add', '-q', '--detach', w1, 'origin/main');
    writeFileSync(join(w1, 'stray.txt'), 'not ours\n');
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    mkdirSync(join(stateDir(), 'claims'), { recursive: true });
    writeFileSync(join(stateDir(), 'claims', 'ACME-1.json'), JSON.stringify({ pid: dead, slot: 'w4', story: 'ACME-1', by: 'factory', at: new Date().toISOString() }));

    child = startForeman(['run', '--foreground'], { cwd: clone, env: runEnv() });
    const exited = child.exited;
    await waitFor('the session', () => sessions().length >= 1, 90_000);
    expect(sessions()[0]).toMatchObject({ story: 'ACME-1', slot: 'w2' });
    await waitFor('the move to be said', () => events().some((t) => t.startsWith('ACME-1 moved from w4 to w2')), 30_000);
    expect(events().some((t) => t.includes('held by someone else'))).toBe(false);

    expect(readSlotState('w1')).toBe('parked');
    expect(existsSync(join(w1, 'stray.txt'))).toBe(true);
    expect(git(w1, 'status', '--porcelain')).toContain('stray.txt');
    expect(git(clone, 'show', 'story/acme-1:wip.txt')).toBe('unfinished work');
    const claim = JSON.parse(readFileSync(join(stateDir(), 'claims', 'ACME-1.json'), 'utf8'));
    expect(claim).toMatchObject({ slot: 'w2', pid: readPid(stateDir()), story: 'ACME-1', by: 'factory' });

    expect(foreman('stop').status).toBe(0);
    await waitFor('the stop to be taken', () => events().some((t) => t.startsWith('Stop requested')), 30_000);
    writeFileSync(join(marks, 'release-all'), '');
    expect(await exited).toBe(0);
  }, 120_000);
});
