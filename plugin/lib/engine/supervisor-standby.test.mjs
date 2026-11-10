// `foreman run` with no story count, end to end: when nothing is buildable the supervisor stays
// on standby instead of exiting, polls the story source each tick, and starts a story as soon
// as one becomes buildable: a new story, an owner task marked done, an answered decision.
// `foreman stop` ends it. `--exit-when-idle` and `run 1` still exit with "Nothing left to
// build.". A fake `claude` (and `gh`) on the PATH stand in for the session and GitHub; the fake
// session blocks its story, so the picker does not take it again.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, makeRepos } from '../../../test/state-repos.mjs';
import * as decisions from '../console/decisions.mjs';
import { fastTick, TEST_TICK_MS } from '../../../test/fast-tick.mjs';
import { runForeman, startForeman, useSupervisors } from '../../../test/supervisors.mjs';

const BIN = fileURLToPath(new URL('../../bin/foreman', import.meta.url));

const FAKE_CLAUDE = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { appendFileSync } = require('node:fs');
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
const id = process.env.FOREMAN_STORY;
spawnSync(process.execPath, [process.env.FAKE_FOREMAN_BIN, 'story', 'block', id, '--reason', 'fake'], { stdio: 'ignore' });
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, result: 'Could not get further.\\nFACTORY_RESULT: blocked ' + id, total_cost_usd: 0, session_id: 'fake' }));
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

const runEnv = () => {
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: repos.base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(env)) if (/^(FOREMAN|FACTORY)_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key)) delete env[key];
  Object.assign(env, fastTick);
  return { ...env, FAKE_CLAUDE_LOG: log, FAKE_FOREMAN_BIN: BIN };
};
const foreman = (...args) => runForeman(args, { cwd: clone, env: runEnv(), encoding: 'utf8', timeout: 30_000 });

const stateDir = () => join(clone, '.foreman');
const loop = () => {
  try {
    return JSON.parse(readFileSync(join(stateDir(), 'state.json'), 'utf8')).loop ?? null;
  } catch {
    return null;
  }
};
const events = () => {
  const file = join(stateDir(), 'events.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).text) : [];
};
const prompts = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((argv) => argv[argv.indexOf('-p') + 1]);

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
const STANDBY_EVENT = 'Factory standby: Nothing to build; picks up new stories automatically.';

describe('foreman run with nothing to build', () => {
  it('stays on standby and starts each story as it becomes buildable, until foreman stop', async () => {
    addStories(
      {
        'ACME-1': note('ACME-1', 'Story ACME-1', 'blocked', 'depends_on: []\nblocked_by: Factory could not pass review; nothing was built\n'),
        'ACME-2': note('ACME-2', 'Story ACME-2', 'todo', 'depends_on: [ACME-3]\n'),
        'ACME-3': note('ACME-3', 'Add the key (owner task)', 'todo', 'depends_on: []\n'),
      },
      'Add stories',
    );
    const id = decisions.add(stateDir(), { story: 'ACME-1', kind: 'decision', title: 'ACME-1 could not pass review', options: ['Retry with a note to the architect', "I'll take it", 'Drop'] });

    let out = '';
    child = startForeman(['run', '--foreground'], { cwd: clone, env: runEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));

    // 1. Standby: the process stays, polls, and logs the standby once.
    await waitFor('standby', () => loop()?.state === 'standby', 30_000);
    await sleep(3 * TEST_TICK_MS);
    expect(child.exitCode).toBeNull();
    expect(prompts()).toEqual([]);
    expect(events().filter((t) => t === STANDBY_EVENT)).toHaveLength(1);
    const status = foreman('status');
    expect(status.stdout).toContain('Foreman: standby');
    expect(status.stdout).toContain('Standby: nothing to build.');

    // 2. A new story in the source starts within about one poll.
    addStories({ 'ACME-4': note('ACME-4', 'Story ACME-4', 'todo', 'depends_on: []\n') }, 'Add ACME-4');
    await waitFor('ACME-4 to start', () => prompts().includes('/foreman:story ACME-4'), 20_000);
    await waitFor('the running event', () => events().lastIndexOf('Factory running') > events().indexOf(STANDBY_EVENT), 10_000);
    await waitFor('standby again', () => loop()?.state === 'standby', 30_000);

    // 3. The owner task marked done frees ACME-2.
    expect(foreman('story', 'done', 'ACME-3', '--note', 'done').status).toBe(0);
    await waitFor('ACME-2 to start', () => prompts().includes('/foreman:story ACME-2'), 20_000);
    await waitFor('standby after ACME-2', () => loop()?.state === 'standby', 30_000);

    // 4. An answered decision is applied, and its story starts.
    decisions.answer(stateDir(), id, { option: 'Retry with a note to the architect' });
    await waitFor('ACME-1 to start', () => prompts().includes('/foreman:story ACME-1'), 20_000);
    expect(decisions.list(stateDir()).find((d) => d.id === id).appliedAt).toBeTruthy();
    await waitFor('standby after ACME-1', () => loop()?.state === 'standby', 30_000);

    // 5. foreman stop ends the run.
    expect(foreman('stop').status).toBe(0);
    expect(await exited).toBe(0);
    expect(loop()).toMatchObject({ state: 'stopped', reason: 'Stopped on request.' });
    expect(out).not.toContain('Nothing left to build');
    expect(prompts().filter((p) => p === '/foreman:story ACME-4')).toHaveLength(1);
  }, 120_000);

  describe('still exits when asked to', () => {
    beforeEach(() => {
      addStories({ 'ACME-1': note('ACME-1', 'Story ACME-1', 'blocked', 'depends_on: []\nblocked_by: waits on the owner\n') }, 'Add ACME-1');
    });

    it.each([
      ['--exit-when-idle', ['run', '--foreground', '--exit-when-idle']],
      ['a story count', ['run', '--foreground', '1']],
    ])('with %s', (_, args) => {
      const r = runForeman(args, { cwd: clone, env: runEnv(), encoding: 'utf8', timeout: 55_000 });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Nothing left to build.');
      expect(loop()).toMatchObject({ state: 'stopped', reason: 'Nothing left to build.' });
      expect(events()).not.toContain(STANDBY_EVENT);
    }, 60_000);
  });
});
