// A real supervisor run, end to end, for file reservations: two slots, three stories. ACME-1 (the
// holder) claims src/a.mjs and keeps it until the test lets it ship. ACME-2 (the highest priority)
// finds it held, defers, and waits. ACME-3 (Low) starts in its freed slot, plans src/a.mjs too and
// waits until no file lock is left. When ACME-1 ships, its file lock goes, but the supervisor keeps
// the file for ACME-2 first (a reservation): ACME-3 claims right after the release, is refused
// ("kept for it") and defers, and ACME-2 then takes the file and ships first. A fake `claude` (and
// `gh`) on the PATH stand in for the sessions and GitHub.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, makeRepos } from '../../../test/state-repos.mjs';
import { fastTick } from '../../../test/fast-tick.mjs';
import { BIN, runForeman, startForeman, useSupervisors } from '../../../test/supervisors.mjs';

const FAKE_CLAUDE = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const id = process.env.FOREMAN_STORY;
const marks = process.env.FAKE_MARKS;
const argv = process.argv.slice(2);
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ story: id, prompt: argv[argv.indexOf('-p') + 1] }) + '\\n');
const session = readFileSync(process.env.FAKE_CLAUDE_LOG, 'utf8').split('\\n').filter(Boolean).filter((l) => JSON.parse(l).story === id).length;
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
const marked = (name) => () => existsSync(join(marks, name));
if (foreman('story', 'start', id).status !== 0) process.exit(1);
const state = process.env.FOREMAN_STATE_DIR;
const plans = join(state, 'plans');
mkdirSync(plans, { recursive: true });
const plan = join(plans, id + '.json');
writeFileSync(plan, JSON.stringify({ ready: true, builder: 'developer', resources: [], files: ['src/a.mjs'] }));
const claim = () => foreman('lock', 'files', id, '--plan', plan);
const noFileLocks = () => !existsSync(join(state, 'locks')) || !readdirSync(join(state, 'locks')).some((f) => f.startsWith('file-'));
if (id === 'ACME-1') {
  if (claim().status !== 0) process.exit(1);
  writeFileSync(join(marks, 'claimed'), '');
  waitUntil(marked('release'), ship);
} else if (id === 'ACME-2' && session === 1) {
  waitUntil(marked('claimed'), () => {
    const r = claim();
    if (r.status !== 7) process.exit(1);
    defer(r);
  });
} else if (id === 'ACME-2' && session === 2) {
  // The low-priority story has tried the file first; this one must still get it. In the
  // "noclaim" run it ends without claiming, so the file kept for it must go free at once.
  waitUntil(marked('low-tried'), () => {
    if (marked('noclaim')()) {
      foreman('story', 'todo', id, '--note', 'ended without claiming');
      foreman('story', 'end', 'deferred', '', 'ended without claiming');
      end('deferred');
    }
    if (claim().status !== 0) process.exit(1);
    ship();
  });
} else if (id === 'ACME-2') {
  // Only in the "noclaim" run: ACME-3 may have started meanwhile and had the file kept for it.
  waitUntil(marked('dropped'), () => {
    const r = claim();
    if (r.status === 7) defer(r);
    if (r.status !== 0) process.exit(1);
    ship();
  });
} else if (session === 1) {
  // ACME-3 plans the file right after the release.
  waitUntil(noFileLocks, () => {
    const r = claim();
    writeFileSync(join(marks, 'low-tried'), '');
    if (r.status === 7) defer(r);
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

const STORY = (id, order) => `---\nid: ${id}\ntitle: Story ${id}\nstatus: todo\norder: ${order}\ndepends_on: []\n---\n\nDo ${id}.\n\n## Progress notes\n`;

let repos;
let clone;
let bin;
let log;
let marks;
let child;

beforeEach(() => {
  repos = makeRepos({ version: 1, project: { name: 'Acme' }, slots: 2, workers: 2, console: { adapter: 'files' }, features: { keepAwake: false }, learning: { auto: false } });
  clone = repos.clone('acme');
  writeFileSync(join(clone, '.gitignore'), '.foreman/\n');
  mkdirSync(join(clone, 'stories'));
  for (const [id, order] of [['ACME-2', 1], ['ACME-1', 5], ['ACME-3', 9]]) writeFileSync(join(clone, 'stories', `${id}.md`), STORY(id, order));
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

describe('foreman run with a file freed while a higher-priority story waits on it', () => {
  it('keeps the file for the waiting story: a low-priority story planning after the release defers to it', async () => {
    child = startForeman(['run', '--foreground'], { cwd: clone, env: runEnv() });
    const exited = child.exited;

    // ACME-2 (the highest priority) finds src/a.mjs held by ACME-1 and defers.
    await waitFor('ACME-2 to defer', () => recent().some((r) => r.id === 'ACME-2' && r.result === 'deferred'), 60_000);
    await waitFor('ACME-3 to start', () => prompts().includes('/foreman:story ACME-3'), 60_000);

    // Waiting on you and status name the top waiting story and the story holding its file.
    const fyi = 'FYI: The highest-priority story waiting on files: ACME-2 waits for ACME-1: src/a.mjs';
    await waitFor('status to name the waiting story', () => foreman('status').stdout.includes(fyi), 60_000);
    expect(existsSync(join(marks, 'release'))).toBe(false);

    // ACME-1 ships: its file lock goes, and the file is kept for ACME-2 before it does.
    writeFileSync(join(marks, 'release'), '');
    await waitFor('ACME-1 to ship', () => shippedIds().includes('ACME-1'), 30_000);
    await waitFor('ACME-3 to try the file', () => recent().some((r) => r.id === 'ACME-3' && r.result === 'deferred'), 60_000);
    const low = recent().find((r) => r.id === 'ACME-3' && r.result === 'deferred');
    expect(low.note).toContain('ACME-2');
    expect(low.note).toContain('src/a.mjs');
    expect(low.note).toContain('kept for it');
    expect(events()).toContain('Kept src/a.mjs for ACME-2, the highest-priority story waiting on it.');

    // ACME-2 takes the file and ships first; ACME-3 ships in the end.
    await waitFor('ACME-2 to ship', () => shippedIds().includes('ACME-2'), 60_000);
    expect(shippedIds()).not.toContain('ACME-3');
    await waitFor('ACME-3 to ship', () => shippedIds().includes('ACME-3'), 60_000);
    expect([...shippedIds()].reverse()).toEqual(['ACME-1', 'ACME-2', 'ACME-3']);
    expect(prompts().filter((p) => p === '/foreman:story ACME-2')).toHaveLength(2);
    expect(prompts().filter((p) => p === '/foreman:story ACME-3')).toHaveLength(2);
    expect(reserveFiles()).toEqual([]);

    expect(foreman('stop').status).toBe(0);
    expect(await exited).toBe(0);
  }, 150_000);

  it('gives a kept file up at once when the story it is kept for ends without claiming it', async () => {
    writeFileSync(join(marks, 'noclaim'), '');
    child = startForeman(['run', '--foreground'], { cwd: clone, env: runEnv() });
    const exited = child.exited;

    await waitFor('ACME-2 to defer', () => recent().some((r) => r.id === 'ACME-2' && r.result === 'deferred'), 60_000);
    await waitFor('ACME-3 to start', () => prompts().includes('/foreman:story ACME-3'), 60_000);
    writeFileSync(join(marks, 'release'), '');
    await waitFor('ACME-1 to ship', () => shippedIds().includes('ACME-1'), 30_000);

    // ACME-2's second session ends without claiming: the file kept for it goes free, not after 30 minutes.
    await waitFor('ACME-2 to end twice', () => recent().filter((r) => r.id === 'ACME-2' && r.result === 'deferred').length === 2, 60_000);
    // (ACME-3 may be started again meanwhile, and the file kept for it: that is not ACME-2's.)
    await waitFor('the file kept for ACME-2 to go free', () => !keptFor().includes('ACME-2'), 30_000);
    writeFileSync(join(marks, 'dropped'), '');

    await waitFor('ACME-2 to ship', () => shippedIds().includes('ACME-2'), 90_000);
    await waitFor('ACME-3 to ship', () => shippedIds().includes('ACME-3'), 60_000);
    expect(reserveFiles()).toEqual([]);

    expect(foreman('stop').status).toBe(0);
    expect(await exited).toBe(0);
  }, 150_000);
});
