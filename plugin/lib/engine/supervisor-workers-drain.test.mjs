// `foreman run` end to end, for lowering workers while every slot runs: five slots, workers 5,
// seven stories. Each fake session starts its story and holds it until the test lets it ship.
// With ACME-1 to ACME-5 running, `foreman workers 3` lowers the limit. The slots above it (w4, w5)
// finish their stories, and no slot picks a new story until fewer than 3 run, whichever slots the
// running stories are in: not when w1 frees up at 4 running (the case from the bug), and not at 3.
// Meanwhile `foreman status` says the run drains. A fake `claude` (and `gh`) on the PATH stand in
// for the sessions and GitHub.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, makeRepos } from '../../../test/state-repos.mjs';
import { fastTick, TEST_TICK_MS } from '../../../test/fast-tick.mjs';
import { BIN, runForeman, startForeman, useSupervisors } from '../../../test/supervisors.mjs';

const FAKE_CLAUDE = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { appendFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const id = process.env.FOREMAN_STORY;
const marks = process.env.FAKE_MARKS;
const argv = process.argv.slice(2);
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ story: id, slot: process.env.FOREMAN_SLOT, prompt: argv[argv.indexOf('-p') + 1] }) + '\\n');
const foreman = (...args) => spawnSync(process.execPath, [process.env.FAKE_FOREMAN_BIN, ...args], { encoding: 'utf8' });
if (foreman('story', 'start', id).status !== 0) process.exit(1);
const until = Date.now() + 110000;
(function poll() {
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

const STORY = (id) => `---\nid: ${id}\ntitle: Story ${id}\nstatus: todo\ndepends_on: []\n---\n\nDo ${id}.\n\n## Progress notes\n`;
const IDS = ['ACME-1', 'ACME-2', 'ACME-3', 'ACME-4', 'ACME-5', 'ACME-6', 'ACME-7'];

let repos;
let clone;
let bin;
let log;
let marks;
let child;

beforeEach(() => {
  repos = makeRepos({ version: 1, project: { name: 'Acme' }, slots: 5, workers: 5, console: { adapter: 'files' }, features: { keepAwake: false }, learning: { auto: false } });
  clone = repos.clone('acme');
  writeFileSync(join(clone, '.gitignore'), '.foreman/\n');
  mkdirSync(join(clone, 'stories'));
  for (const id of IDS) writeFileSync(join(clone, 'stories', `${id}.md`), STORY(id));
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
// The story running in each slot, from `foreman status --json`.
const storyBySlot = () => Object.fromEntries(statusJson().slots.filter((s) => s.story?.id).map((s) => [s.id, s.story.id]));
const SLOTS = ['w1', 'w2', 'w3', 'w4', 'w5'];

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
// Lets the story in `slot` ship, and waits until it has shipped and its slot is idle again.
async function release(slot, id) {
  writeFileSync(join(marks, `release-${id}`), '');
  await waitFor(`${id} to ship`, () => shippedIds().includes(id), 30_000);
  await waitFor(`${slot} to go idle`, () => readSlotState(slot) === 'idle', 30_000);
}

describe('lowering workers while every slot runs', () => {
  it('starts no new story until fewer than the new limit run, whichever slots they are in, and status says it drains', async () => {
    child = startForeman(['run', '--foreground'], { cwd: clone, env: runEnv() });
    const exited = child.exited;

    // ACME-1 to ACME-5 run, one in each slot; then the limit goes from 5 to 3.
    await waitFor('5 sessions', () => prompts().length === 5, 90_000);
    await waitFor('5 building slots', () => SLOTS.every((s) => readSlotState(s) === 'building'), 30_000);
    expect(foreman('workers', '3').status).toBe(0);
    await waitFor('workers to be 3', () => readJson('state.json', {}).workers === 3, 30_000);
    const bySlot = storyBySlot();
    expect(Object.keys(bySlot).sort()).toEqual(SLOTS);

    // w1, under the limit, frees up with 4 still running (the bug's case): it picks nothing.
    await release('w1', bySlot.w1);
    await sleep(TEST_TICK_MS * 6);
    expect(prompts()).toHaveLength(5);
    const status = foreman('status');
    expect(status.status).toBe(0);
    expect(status.stdout).toContain('4 running, limit 3: draining');
    expect(statusJson().draining).toEqual({ running: 4, limit: 3, text: '4 running, limit 3: draining' });

    // w5, above the limit, finishes: 3 run, the limit, so still nothing new.
    await release('w5', bySlot.w5);
    await sleep(TEST_TICK_MS * 6);
    expect(prompts()).toHaveLength(5);
    expect(statusJson().draining).toBeNull();

    // w2 finishes: 2 run, and one slot under the limit picks the next story.
    await release('w2', bySlot.w2);
    await waitFor('a 6th session', () => prompts().length === 6, 30_000);
    const sixth = sessions()[5];
    expect(sixth.story).toBe('ACME-6');
    expect(['w1', 'w2', 'w3']).toContain(sixth.slot);
    await sleep(TEST_TICK_MS * 6);
    expect(prompts()).toHaveLength(6);

    // Stop, then let every session ship: the run ends without starting ACME-7.
    expect(foreman('stop').status).toBe(0);
    await waitFor('the stop to be taken', () => events().some((t) => t.startsWith('Stop requested')), 30_000);
    writeFileSync(join(marks, 'release-all'), '');
    expect(await exited).toBe(0);
    expect(sessions().map((s) => s.story)).not.toContain('ACME-7');
  }, 120_000);
});
