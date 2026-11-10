// An owner's Restart and Take over from the command centre, end to end, spend the story's
// checkpoint (checkpoint.mjs): a restart begins the story again from main and a take over hands
// it to the owner, so neither may carry stages a stopped session finished. Skip is covered in
// supervisor-skip.test.mjs. A fake `claude` (and `gh`) on the PATH stand in for the session and
// GitHub: each start notes its story and waits until it is killed.
//
// These tests also cover the leftovers (leftovers.mjs) of a dirty Take over and a dirty Restart,
// and Restart's fallback: a session that leaves staged and untracked files in its folder has them
// saved on a leftover branch and the folder made clean and detached again, and when they cannot
// be saved a Restart discards them with a warning. A fake session dirties its folder on demand
// (FAKE_DIRTY) and records the folder's git status at every start.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, makeRepos, sh } from '../../../test/state-repos.mjs';
import { fastTick } from '../../../test/fast-tick.mjs';
import { runForeman, startForeman, useSupervisors } from '../../../test/supervisors.mjs';

const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync, existsSync, mkdirSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const git = (...args) => spawnSync('git', args, { encoding: 'utf8' }).stdout;
const log = process.env.FAKE_CLAUDE_LOG;
const id = process.env.FOREMAN_STORY;
// The status line goes first: a test that sees the plain id line has the status line already.
appendFileSync(log + '.json', JSON.stringify({ status: git('status', '--porcelain'), head: git('rev-parse', '--abbrev-ref', 'HEAD').trim() }) + '\\n');
appendFileSync(log, id + '\\n');
if (process.env.FAKE_DIRTY && !existsSync(log + '.dirtied')) {
  if (process.env.FAKE_DIRTY === 'branch') git('checkout', '-qB', 'story/' + id.toLowerCase());
  mkdirSync('src', { recursive: true });
  writeFileSync('src/staged.txt', 'staged\\n');
  git('add', 'src/staged.txt');
  writeFileSync('notes.txt', 'notes\\n');
  writeFileSync(log + '.dirtied', '');
}
setInterval(() => {}, 1000);
`;

const FAKE_GH = `#!/bin/sh
case "$1 $2" in
  "pr list") echo "[]" ;;
  *) exit 1 ;;
esac
`;

const TODO = '---\nid: ACME-1\ntitle: Story ACME-1\nstatus: todo\ndepends_on: []\n---\n\nDo ACME-1.\n\n## Progress notes\n';

let repos;
let clone;
let bin;
let log;
let child;

beforeEach(() => {
  repos = makeRepos({ version: 1, project: { name: 'Acme' }, console: { adapter: 'files' }, features: { keepAwake: false }, learning: { auto: false } });
  clone = repos.clone('acme');
  writeFileSync(join(clone, '.gitignore'), '.foreman/\n');
  mkdirSync(join(clone, 'stories'));
  writeFileSync(join(clone, 'stories', 'ACME-1.md'), TODO);
  git(clone, 'add', '.');
  git(clone, 'commit', '-qm', 'Add ACME-1');
  git(clone, 'push', '-q', 'origin', 'main');
  bin = join(repos.base, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE);
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  chmodSync(join(bin, 'claude'), 0o755);
  chmodSync(join(bin, 'gh'), 0o755);
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
  repos.cleanup();
});
// After the hooks above, so it runs before them (vitest runs afterEach hooks last first).
useSupervisors();

const runEnv = (extra = {}) => {
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: repos.base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(env)) if (/^(FOREMAN|FACTORY)_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key)) delete env[key];
  Object.assign(env, fastTick);
  return { ...env, FAKE_CLAUDE_LOG: log, ...extra };
};
const foreman = (...args) => runForeman(args, { cwd: clone, env: runEnv(), encoding: 'utf8', timeout: 30_000 });

const stateDir = () => join(clone, '.foreman');
const w1 = () => join(stateDir(), 'worktrees', 'w1');
const checkpoint = () => join(stateDir(), 'checkpoints', 'ACME-1.json');
const plantCheckpoint = () => {
  mkdirSync(join(stateDir(), 'checkpoints'), { recursive: true });
  writeFileSync(checkpoint(), `${JSON.stringify({ story: 'ACME-1', tree: null, at: new Date().toISOString(), entries: [] })}\n`);
};
const events = () => {
  const file = join(stateDir(), 'events.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).text) : [];
};
const eventLines = () => {
  const file = join(stateDir(), 'events.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const leftoverBranches = () => git(clone, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/leftover/').split('\n').filter(Boolean);
const startsJson = () => readFileSync(`${log}.json`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const status = (dir) => sh('git', ['status', '--porcelain'], { cwd: dir }).stdout;
const starts = () => readFileSync(log, 'utf8').split('\n').filter((l) => l === 'ACME-1').length;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(what, test, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (test()) return;
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`the run exited (${child.exitCode}) while waiting for ${what}`);
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}; events ${JSON.stringify(events().slice(-5))}`);
}

describe('the owner stopping a story from the command centre', () => {
  it("an owner restart and take over each remove the story's checkpoint", async () => {
    child = startForeman(['run', '--foreground'], { cwd: clone, env: runEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.resume();
    child.stderr.resume();
    const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    await waitFor('ACME-1 to start', () => starts() === 1, 30_000);

    // Restart: the session is stopped and the story begins again, with no checkpoint.
    plantCheckpoint();
    expect(existsSync(checkpoint())).toBe(true);
    expect(foreman('slot', 'w1', 'restart').status).toBe(0);
    await waitFor('the second start of ACME-1', () => starts() === 2, 30_000);
    expect(existsSync(checkpoint())).toBe(false);

    // Take over: the story is the owner's, with no checkpoint.
    plantCheckpoint();
    expect(foreman('slot', 'w1', 'takeover').status).toBe(0);
    await waitFor('the take over', () => events().includes('ACME-1 handed to you.'), 30_000);
    expect(existsSync(checkpoint())).toBe(false);

    expect(foreman('stop').status).toBe(0);
    expect(await exited).toBe(0);
  }, 120_000);

  const LEFTOVER = /^leftover\/w1-acme-1-\d{8}$/;
  const startRun = (extra) => {
    child = startForeman(['run', '--foreground'], { cwd: clone, env: runEnv(extra), stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.resume();
    child.stderr.resume();
    return new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  };
  const dirtied = () => existsSync(`${log}.dirtied`);

  it('a dirty take over off the story branch leaves its changes on a leftover branch and the folder clean and detached at base', async () => {
    const exited = startRun({ FAKE_DIRTY: 'detached' });
    await waitFor('the session to dirty its folder', dirtied, 30_000);

    // The folder stays detached, so the take over makes no WIP commit: only tidying saves the changes.
    expect(foreman('slot', 'w1', 'takeover').status).toBe(0);
    await waitFor('the take over', () => events().includes('ACME-1 handed to you.'), 30_000);

    expect(status(w1())).toBe('');
    expect(git(w1(), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
    expect(git(w1(), 'rev-parse', 'HEAD')).toBe(git(clone, 'rev-parse', 'origin/main'));
    const branches = leftoverBranches();
    expect(branches).toHaveLength(1);
    const [b] = branches;
    expect(b).toMatch(LEFTOVER);
    const shown = git(clone, 'show', '--name-status', '--format=%s', b);
    expect(shown).toMatch(/^A\tsrc\/staged\.txt$/m);
    expect(shown).toMatch(/^A\tnotes\.txt$/m);
    expect(events()).toContain(`Slot w1: ACME-1 left changes in its folder; they are on the branch ${b}, and the folder is clean again.`);

    expect(foreman('stop').status).toBe(0);
    expect(await exited).toBe(0);
  }, 120_000);

  it('a dirty restart leaves its changes on a leftover branch and starts the story again in a clean folder', async () => {
    const exited = startRun({ FAKE_DIRTY: 'branch' });
    await waitFor('the session to dirty its folder', dirtied, 30_000);

    expect(foreman('slot', 'w1', 'restart').status).toBe(0);
    await waitFor('the second start of ACME-1', () => starts() === 2, 30_000);

    const branches = leftoverBranches();
    expect(branches).toHaveLength(1);
    const [b] = branches;
    expect(b).toMatch(LEFTOVER);
    const shown = git(clone, 'show', '--name-status', '--format=%s', b);
    expect(shown).toMatch(/^A\tsrc\/staged\.txt$/m);
    expect(shown).toMatch(/^A\tnotes\.txt$/m);
    expect(events()).toContain(`Slot w1: ACME-1 left changes in its folder; they are on the branch ${b}, and the folder is clean again.`);
    expect(events().some((text) => text.includes('could not be saved'))).toBe(false);
    expect(startsJson()[1].status).toBe('');

    expect(foreman('slot', 'w1', 'skip').status).toBe(0);
    await waitFor('the skip', () => events().includes('ACME-1 skipped for this run.'), 30_000);
    expect(leftoverBranches()).toHaveLength(1);

    expect(foreman('stop').status).toBe(0);
    expect(await exited).toBe(0);
  }, 120_000);

  it('a restart whose changes cannot be saved discards them with a warning and starts the story again in a clean folder', async () => {
    // A branch named plain `leftover` stops git making any `leftover/...` branch, so the save fails.
    git(clone, 'branch', 'leftover');
    const exited = startRun({ FAKE_DIRTY: 'branch' });
    await waitFor('the session to dirty its folder', dirtied, 30_000);

    expect(foreman('slot', 'w1', 'restart').status).toBe(0);
    await waitFor('the second start of ACME-1', () => starts() === 2, 30_000);

    expect(eventLines()).toContainEqual(expect.objectContaining({
      text: 'Slot w1: the changes in its folder could not be saved, so restarting ACME-1 fresh discarded them.',
      kind: 'warn',
      slot: 'w1',
    }));
    expect(events().some((text) => text.startsWith('Slot w1: could not save the leftover changes of ACME-1 (could not make the branch leftover/w1-acme-1-'))).toBe(true);
    expect(leftoverBranches()).toEqual([]);
    expect(startsJson()[1].status).toBe('');

    expect(foreman('slot', 'w1', 'skip').status).toBe(0);
    await waitFor('the skip', () => events().includes('ACME-1 skipped for this run.'), 30_000);

    expect(foreman('stop').status).toBe(0);
    expect(await exited).toBe(0);
  }, 120_000);
});
