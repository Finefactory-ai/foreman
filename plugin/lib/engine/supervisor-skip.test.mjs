// A skip from the command centre, end to end: `foreman slot w1 skip` stops the story's session,
// removes its checkpoint, and leaves the story out for the rest of the run. Standby does not
// bring it back, nor does a tick; state.json's skipped lists it and `foreman status` shows it.
// Only `foreman next <id>` (the dashboard's Build next) clears the skip and starts it again. A
// fake `claude` (and `gh`) on the PATH stand in for the session and GitHub: its first start for a
// story waits until it is killed, and a later one blocks the story, so the picker does not take
// it again.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, makeRepos, sh } from '../../../test/state-repos.mjs';
import { fastTick, TEST_TICK_MS } from '../../../test/fast-tick.mjs';
import { runForeman, startForeman, useSupervisors } from '../../../test/supervisors.mjs';

const BIN = fileURLToPath(new URL('../../bin/foreman', import.meta.url));

const FAKE_CLAUDE = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { appendFileSync, existsSync, mkdirSync, writeFileSync } = require('node:fs');
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
const id = process.env.FOREMAN_STORY;
const marker = process.env.FAKE_CLAUDE_LOG + '.' + id + '.started';
if (!existsSync(marker)) {
  if (process.env.FAKE_DIRTY === id) {
    spawnSync('git', ['checkout', '-qB', 'story/' + id.toLowerCase()]);
    mkdirSync('src', { recursive: true });
    writeFileSync('src/staged.txt', 'staged\\n');
    spawnSync('git', ['add', 'src/staged.txt']);
    writeFileSync('notes.txt', 'notes\\n');
  }
  writeFileSync(marker, String(process.pid));
  setInterval(() => {}, 1000);
} else {
  spawnSync(process.execPath, [process.env.FAKE_FOREMAN_BIN, 'story', 'block', id, '--reason', 'fake'], { stdio: 'ignore' });
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, result: 'Could not get further.\\nFACTORY_RESULT: blocked ' + id, total_cost_usd: 0, session_id: 'fake' }));
}
`;

const FAKE_GH = `#!/bin/sh
case "$1 $2" in
  "pr list") echo "[]" ;;
  *) exit 1 ;;
esac
`;

const note = (id, title, status, extra = '') => `---\nid: ${id}\ntitle: ${title}\nstatus: ${status}\n${extra}---\n\nDo ${id}.\n\n## Progress notes\n`;

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

const addStories = (stories, message) => {
  for (const [id, text] of Object.entries(stories)) writeFileSync(join(clone, 'stories', `${id}.md`), text);
  git(clone, 'add', '.');
  git(clone, 'commit', '-qm', message);
  git(clone, 'push', '-q', 'origin', 'main');
};

const runEnv = (extra = {}) => {
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: repos.base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(env)) if (/^(FOREMAN|FACTORY)_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key)) delete env[key];
  Object.assign(env, fastTick);
  return { ...env, FAKE_CLAUDE_LOG: log, FAKE_FOREMAN_BIN: BIN, ...extra };
};
const foreman = (...args) => runForeman(args, { cwd: clone, env: runEnv(), encoding: 'utf8', timeout: 30_000 });

const stateDir = () => join(clone, '.foreman');
const runState = () => {
  try {
    return JSON.parse(readFileSync(join(stateDir(), 'state.json'), 'utf8'));
  } catch {
    return {};
  }
};
const loop = () => runState().loop ?? null;
const events = () => {
  const file = join(stateDir(), 'events.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).text) : [];
};
const starts = (id) => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((argv) => argv[argv.indexOf('-p') + 1]).filter((p) => p === `/foreman:story ${id}`).length;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(what, test, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (test()) return;
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`the run exited (${child.exitCode}) while waiting for ${what}`);
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}; loop ${JSON.stringify(loop())}`);
}

describe('a story skipped from the command centre', () => {
  it('stays skipped through standby, shows in status, and only foreman next builds it again', async () => {
    addStories({ 'ACME-1': note('ACME-1', 'Story ACME-1', 'todo', 'depends_on: []\n') }, 'Add ACME-1');

    child = startForeman(['run', '--foreground'], { cwd: clone, env: runEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.resume();
    child.stderr.resume();
    const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));

    // (a) The session starts and waits.
    await waitFor('ACME-1 to start', () => existsSync(`${log}.ACME-1.started`), 30_000);

    // (b, c) The skip stops it and spends its checkpoint; neither standby nor a tick picks it again.
    const checkpoint = join(stateDir(), 'checkpoints', 'ACME-1.json');
    mkdirSync(join(stateDir(), 'checkpoints'), { recursive: true });
    writeFileSync(checkpoint, `${JSON.stringify({ story: 'ACME-1', tree: null, at: new Date().toISOString(), entries: [] })}\n`);
    expect(foreman('slot', 'w1', 'skip').status).toBe(0);
    await waitFor('the skip event', () => events().includes('ACME-1 skipped for this run.'), 20_000);
    expect(existsSync(checkpoint)).toBe(false);
    expect(runState().skipped).toEqual(['ACME-1']);
    await waitFor('standby', () => loop()?.state === 'standby', 30_000);
    await sleep(4 * TEST_TICK_MS);
    expect(starts('ACME-1')).toBe(1);
    expect(loop()?.state).toBe('standby');

    // (d) Status lists it.
    expect(foreman('status').stdout).toContain('Skipped this run: ACME-1');

    // (e) Build next clears the skip and starts it.
    expect(foreman('next', 'ACME-1').status).toBe(0);
    await waitFor('the second start of ACME-1', () => starts('ACME-1') === 2, 20_000);
    expect(events()).toContain('ACME-1 is no longer skipped.');
    expect(events()).toContain('You asked for ACME-1 next; starting it.');
    expect(runState().skipped).toEqual([]);

    // (f) The stop leaves nothing skipped, even with a story still skipped when it stops.
    await waitFor('standby after ACME-1', () => loop()?.state === 'standby', 30_000);
    addStories({ 'ACME-2': note('ACME-2', 'Story ACME-2', 'todo', 'depends_on: []\n') }, 'Add ACME-2');
    await waitFor('ACME-2 to start', () => existsSync(`${log}.ACME-2.started`), 20_000);
    expect(foreman('slot', 'w1', 'skip').status).toBe(0);
    await waitFor('the skip of ACME-2', () => events().includes('ACME-2 skipped for this run.'), 20_000);
    expect(runState().skipped).toEqual(['ACME-2']);
    await waitFor('standby after ACME-2', () => loop()?.state === 'standby', 30_000);
    expect(foreman('stop').status).toBe(0);
    expect(await exited).toBe(0);
    expect(runState().skipped).toEqual([]);
  }, 120_000);

  it('leaves the folder clean and detached at base, its changes on a leftover branch', async () => {
    addStories({ 'ACME-1': note('ACME-1', 'Story ACME-1', 'todo', 'depends_on: []\n') }, 'Add ACME-1');
    child = startForeman(['run', '--foreground'], { cwd: clone, env: runEnv({ FAKE_DIRTY: 'ACME-1' }), stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.resume();
    child.stderr.resume();
    const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    await waitFor('ACME-1 to start', () => existsSync(`${log}.ACME-1.started`), 30_000);

    expect(foreman('slot', 'w1', 'skip').status).toBe(0);
    // tidyFolder runs before the event is written.
    await waitFor('the skip event', () => events().includes('ACME-1 skipped for this run.'), 20_000);

    const w1 = join(clone, '.foreman', 'worktrees', 'w1');
    expect(sh('git', ['status', '--porcelain'], { cwd: w1 }).stdout).toBe('');
    expect(git(w1, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
    expect(git(w1, 'rev-parse', 'HEAD')).toBe(git(clone, 'rev-parse', 'origin/main'));
    const found = git(clone, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/leftover').split('\n').filter(Boolean);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^leftover\/w1-acme-1-\d{8}$/);
    const shown = git(clone, 'show', '--name-status', '--format=%s', found[0]);
    expect(shown).toMatch(/^A\tsrc\/staged\.txt$/m);
    expect(shown).toMatch(/^A\tnotes\.txt$/m);
    expect(events()).toContain(`Slot w1: ACME-1 left changes in its folder; they are on the branch ${found[0]}, and the folder is clean again.`);
    expect(() => git(clone, 'rev-parse', '--verify', 'story/acme-1')).not.toThrow();

    await waitFor('standby', () => loop()?.state === 'standby', 30_000);
    expect(foreman('stop').status).toBe(0);
    expect(await exited).toBe(0);
  }, 120_000);
});
