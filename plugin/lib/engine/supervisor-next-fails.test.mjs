// "Build next" for a story whose base branch cannot be fetched, end to end: a real `foreman run`
// on one slot whose folder already exists, with the remote moved away. The pick tries the fetch
// three times, so each round fails; the request stays open (handledNextAt unset), "could not
// start after 3 tries" is logged once, state.nextWait names the request, Waiting on you lists it,
// and no other story starts ahead of it. When the remote is back the story starts, the request is
// marked handled and the wait goes. A fake `claude` (and `gh`) on the PATH stand in for the
// session and GitHub.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, makeRepos } from '../../../test/state-repos.mjs';
import { fastTick } from '../../../test/fast-tick.mjs';
import { runForeman, startForeman, useSupervisors } from '../../../test/supervisors.mjs';
import { worktreeOf } from './worktree.mjs';
import { ownerWaiting } from './state.mjs';

const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require('node:fs');
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
writeFileSync(process.env.FAKE_CLAUDE_LOG + '.' + process.env.FOREMAN_STORY + '.started', String(process.pid));
setInterval(() => {}, 1000);
`;

const FAKE_GH = `#!/bin/sh
case "$1 $2" in
  "pr list") echo "[]" ;;
  *) exit 1 ;;
esac
`;

const STORY = (id) => `---\nid: ${id}\ntitle: Story ${id}\nstatus: todo\ndepends_on: []\n---\n\nDo ${id}.\n\n## Progress notes\n`;

const FETCH_FAIL = 'Slot w1: could not fetch origin/main; ACME-2 not started, trying again next round.';
const WARN = 'You asked for ACME-2 next, but it could not start after 3 tries (could not fetch origin/main); it stays first in line.';
const STARTED = 'You asked for ACME-2 next; starting it.';

let repos;
let clone;
let bin;
let log;
let child;

beforeEach(() => {
  repos = makeRepos({ version: 1, project: { name: 'Acme' }, slots: 1, workers: 1, console: { adapter: 'files' }, features: { keepAwake: false }, learning: { auto: false } });
  clone = repos.clone('acme');
  writeFileSync(join(clone, '.gitignore'), '.foreman/\n');
  mkdirSync(join(clone, 'stories'));
  for (const id of ['ACME-1', 'ACME-2']) writeFileSync(join(clone, 'stories', `${id}.md`), STORY(id));
  git(clone, 'add', '.');
  git(clone, 'commit', '-qm', 'Add the stories');
  git(clone, 'push', '-q', 'origin', 'main');
  // The slot's folder exists before the run, so the pick fetches the base branch itself.
  git(clone, 'worktree', 'add', '-q', '--detach', worktreeOf(join(clone, '.foreman'), 1), 'origin/main');
  bin = join(repos.base, 'bin');
  mkdirSync(bin);
  for (const [name, text] of [['claude', FAKE_CLAUDE], ['gh', FAKE_GH]]) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  log = join(repos.base, 'claude.log');
  writeFileSync(log, '');
  child = null;
});
afterEach(() => {
  if (child && child.exitCode === null) {
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  if (existsSync(`${repos.remote}.gone`) && !existsSync(repos.remote)) renameSync(`${repos.remote}.gone`, repos.remote);
  repos.cleanup();
});
// After the hooks above, so it runs before them (vitest runs afterEach hooks last first).
useSupervisors();

const runEnv = () => {
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: repos.base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(env)) if (/^(FOREMAN|FACTORY)_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key)) delete env[key];
  return { ...env, ...fastTick, FAKE_CLAUDE_LOG: log };
};
const foreman = (...args) => runForeman(args, { cwd: clone, env: runEnv(), encoding: 'utf8', timeout: 30_000 });

const stateDir = () => join(clone, '.foreman');
const readJsonFile = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
};
const runState = () => readJsonFile(join(stateDir(), 'state.json'));
const control = () => readJsonFile(join(stateDir(), 'control.json'));
const eventRecords = () => {
  const file = join(stateDir(), 'events.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map(({ text, kind }) => ({ text, kind })) : [];
};
const texts = () => eventRecords().map((e) => e.text);
const count = (text) => texts().filter((t) => t === text).length;
const prompts = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((argv) => argv[argv.indexOf('-p') + 1]);
const storyStarts = () => prompts().filter((p) => p.startsWith('/foreman:story '));
const waiting = async () => (await ownerWaiting(stateDir(), new Date(), { root: clone, slots: 1, stories: [], loop: runState().loop })).items;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(what, test, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (test()) return;
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`the run exited (${child.exitCode}) while waiting for ${what}`);
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}; events ${JSON.stringify(texts().slice(-6))}`);
}

describe('build next for a story whose base branch cannot be fetched', () => {
  it('keeps the request open while the fetch fails, warns once after 3 tries, shows it on Waiting on you, and starts it once the fetch works', async () => {
    expect(foreman('pause').status).toBe(0);
    child = startForeman(['run', '--foreground'], { cwd: clone, env: runEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.resume();
    child.stderr.resume();
    await waitFor('the run to pause', () => runState().loop?.state === 'paused', 30_000);

    // The remote goes away, then the owner asks for ACME-2 next (ACME-1 is ranked first).
    renameSync(repos.remote, `${repos.remote}.gone`);
    expect(foreman('next', 'ACME-2').status).toBe(0);
    expect(foreman('resume').status).toBe(0);

    // Three failed tries log the warn; a fourth shows it is not logged again.
    await waitFor('the request to fail 3 tries', () => texts().includes(WARN), 90_000);
    await waitFor('a try after the limit', () => count(FETCH_FAIL) >= 4, 30_000);

    expect(eventRecords().filter((e) => e.text === WARN)).toEqual([{ text: WARN, kind: 'warn' }]);
    expect(runState().handledNextAt).toBeUndefined();
    expect(runState().nextWait).toMatchObject({ id: 'ACME-2', at: control().requestedAt, reason: 'could not fetch origin/main' });
    expect(runState().nextWait.tries).toBeGreaterThanOrEqual(3);
    expect(typeof runState().nextWait.since).toBe('string');
    expect(storyStarts()).toEqual([]);
    expect(texts()).not.toContain(STARTED);
    const items = (await waiting()).filter((i) => i.id === 'run:next');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'run', group: 'now', title: 'ACME-2 cannot start next', actions: [] });
    expect(items[0].why).toMatch(/^It could not start after \d+ tries: could not fetch origin\/main\. Foreman keeps trying it first/);

    // The remote is back: ACME-2 starts first and the request is handled.
    renameSync(`${repos.remote}.gone`, repos.remote);
    await waitFor('ACME-2 to start', () => existsSync(`${log}.ACME-2.started`), 60_000);
    expect(storyStarts()[0]).toBe('/foreman:story ACME-2');
    expect(count(STARTED)).toBe(1);
    expect(count(WARN)).toBe(1);
    expect(runState().handledNextAt).toBe(control().requestedAt);
    expect(runState().handledNextAt).toBeTruthy();
    expect(runState().nextWait).toBeUndefined();
    expect((await waiting()).map((i) => i.id)).not.toContain('run:next');
  }, 150_000);
});
