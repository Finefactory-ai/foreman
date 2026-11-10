// A run on standby, end to end, for what it tells the owner. With an owner task holding a story,
// reaching standby logs one event and sends one `standby` email saying what waits and what
// finishing the task starts; the task is told once more, in its own email and event, after
// watchdog.ownerTaskHours, and never again. With nothing waiting on the owner, standby says
// nothing. A fake `claude` and `gh` on the PATH stand in for the session and GitHub; no
// session starts here, since every story is held back.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, makeRepos } from '../../../test/state-repos.mjs';
import { fastTick, TEST_TICK_MS } from '../../../test/fast-tick.mjs';
import { runForeman, startForeman, useSupervisors } from '../../../test/supervisors.mjs';

const FAKE_CLAUDE = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const id = process.env.FOREMAN_STORY;
spawnSync(process.execPath, [process.env.FAKE_FOREMAN_BIN, 'story', 'block', id, '--reason', 'fake'], { stdio: 'ignore' });
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Could not get further.\\nFACTORY_RESULT: blocked ' + id, total_cost_usd: 0, session_id: 'fake' }));
`;
const FAKE_GH = `#!/bin/sh
case "$1 $2" in
  "pr list") echo "[]" ;;
  *) exit 1 ;;
esac
`;

const BIN = fileURLToPath(new URL('../../bin/foreman', import.meta.url));
const note = (id, title, status, extra = '') => `---\nid: ${id}\ntitle: ${title}\nstatus: ${status}\n${extra}---\n\nDo ${id}.\n\n## Progress notes\n`;
const NEWS = 'Standby: 1 owner task waits on you; finishing ACME-1 starts ACME-2.';

let repos;
let clone;
let bin;
let child;

function setup(config, stories) {
  repos = makeRepos({ version: 1, project: { name: 'Acme' }, console: { adapter: 'files' }, features: { keepAwake: false }, learning: { auto: false }, ...config });
  clone = repos.clone('acme');
  writeFileSync(join(clone, '.gitignore'), '.foreman/\n');
  mkdirSync(join(clone, 'stories'));
  for (const [id, text] of Object.entries(stories)) writeFileSync(join(clone, 'stories', `${id}.md`), text);
  git(clone, 'add', '.');
  git(clone, 'commit', '-qm', 'Add stories');
  git(clone, 'push', '-q', 'origin', 'main');
  bin = join(repos.base, 'bin');
  mkdirSync(bin);
  for (const [name, text] of [['claude', FAKE_CLAUDE], ['gh', FAKE_GH]]) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
}

beforeEach(() => {
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
  repos?.cleanup();
});
// After the hooks above, so it runs before them (vitest runs afterEach hooks last first).
useSupervisors();

const runEnv = () => {
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, HOME: repos.base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(env)) if (/^(FOREMAN|FACTORY)_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key)) delete env[key];
  return { ...env, ...fastTick, FAKE_FOREMAN_BIN: BIN };
};
const stateDir = () => join(clone, '.foreman');
const state = () => {
  try {
    return JSON.parse(readFileSync(join(stateDir(), 'state.json'), 'utf8'));
  } catch {
    return {};
  }
};
const events = () => {
  const file = join(stateDir(), 'events.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).text) : [];
};
const outbox = (suffix) => {
  const dir = join(stateDir(), 'outbox');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(suffix)).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))) : [];
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(what, test, ms = 30_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (test()) return;
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`the run exited (${child.exitCode}) while waiting for ${what}`);
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}; loop ${JSON.stringify(state().loop)}; events ${JSON.stringify(events())}`);
}
const start = () => {
  child = startForeman(['run', '--foreground'], { cwd: clone, env: runEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  return new Promise((resolve) => child.on('exit', (code) => resolve(code)));
};

describe('a run on standby with an owner task waiting', () => {
  it('says what waits and what finishing the task starts, once, and tells the owner of a task held too long, once', async () => {
    setup(
      { watchdog: { ownerTaskHours: 0.001 } },
      { 'ACME-1': note('ACME-1', 'Add the key (owner task)', 'todo', 'depends_on: []\n'), 'ACME-2': note('ACME-2', 'Story ACME-2', 'todo', 'depends_on: [ACME-1]\n') },
    );
    const exited = start();

    await waitFor('standby', () => state().loop?.state === 'standby');
    await waitFor('the standby event', () => events().includes(NEWS));
    await waitFor('the standby email', () => outbox('-standby.json').length === 1);
    expect(outbox('-standby.json')[0].text).toContain(NEWS);
    expect(events().filter((t) => t === NEWS)).toHaveLength(1);

    // 0.001 h is 3.6 s: the watch tells the task once.
    await waitFor('the owner task email', () => outbox('-owner-task.json').length === 1);
    await waitFor('the owner task event', () => events().some((t) => /^Owner task ACME-1 .*has held ACME-2 for/.test(t)));
    expect(outbox('-owner-task.json')[0].subject).toBe('An owner task still holds ACME-2');

    // The watch looks every ten ticks; twice that and more, nothing is told again.
    await sleep(25 * TEST_TICK_MS);
    expect(outbox('-owner-task.json')).toHaveLength(1);
    expect(events().filter((t) => /^Owner task ACME-1 .*has held ACME-2 for/.test(t))).toHaveLength(1);
    expect(outbox('-standby.json')).toHaveLength(1);
    expect(state().ownerTasks['ACME-1'].told).toBe(true);

    // A story that starts and is blocked sends the run out of standby and back to it with the same
    // news: the event is logged again, the email is not sent again.
    writeFileSync(join(clone, 'stories', 'ACME-3.md'), note('ACME-3', 'Story ACME-3', 'todo', 'depends_on: []\n'));
    git(clone, 'add', '.');
    git(clone, 'commit', '-qm', 'Add ACME-3');
    git(clone, 'push', '-q', 'origin', 'main');
    await waitFor('the news again', () => events().filter((t) => t === NEWS).length === 2);
    await sleep(6 * TEST_TICK_MS); // an email would be written by now
    expect(outbox('-standby.json')).toHaveLength(1);

    const stop = runForeman(['stop'], { cwd: clone, env: runEnv(), encoding: 'utf8', timeout: 30_000 });
    expect(stop.status).toBe(0);
    expect(await exited).toBe(0);
  }, 120_000);

  it('says nothing on standby when nothing waits on the owner', async () => {
    setup({}, { 'ACME-1': note('ACME-1', 'Story ACME-1', 'blocked', 'depends_on: []\nblocked_by: waits on a vendor\n') });
    const exited = start();

    await waitFor('standby', () => state().loop?.state === 'standby');
    // Long enough for `foreman learn` to run and the news to be asked for.
    await sleep(12 * TEST_TICK_MS);
    expect(outbox('-standby.json')).toEqual([]);
    expect(outbox('-owner-task.json')).toEqual([]);
    expect(events().filter((t) => t.startsWith('Standby:'))).toEqual([]);

    expect(runForeman(['stop'], { cwd: clone, env: runEnv(), encoding: 'utf8', timeout: 30_000 }).status).toBe(0);
    expect(await exited).toBe(0);
  }, 120_000);
});
