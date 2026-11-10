// `foreman run` end to end, for claims the run no longer needs. A slot parked after two crashes
// keeps its story's claim only while it stays parked on it: once the owner unparks it the claim
// goes, and the picker takes that In Progress story again ahead of a todo one. A factory claim
// under the live supervisor's own pid for a slot that is building another story is let go on the
// next tick, with a warn event, so the story it named is built. And an In Progress story with no
// claim is the first one a free slot starts. A fake `claude` (and `gh`) on the PATH stand in for
// the sessions and GitHub; FAKE_MODE says what the fake session does:
//
//   crash-twice    ACME-1 exits with no result while the log has fewer than two ACME-1 lines;
//                  anything else ships. With FAKE_DIRTY set, the second crash first puts the
//                  folder on the branch story/acme-1 and leaves an untracked wip.txt in it
//   foreign-claim  ACME-1 writes a claim for ACME-2 under the supervisor's pid and this slot,
//                  waits FAKE_WAIT_MS, then ships; anything else ships at once
//   (anything else) ships

import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, makeRepos } from '../../../test/state-repos.mjs';
import { fastTick } from '../../../test/fast-tick.mjs';
import { stretchByLoad } from '../../../test/slow-tests.mjs';
import { BIN, runForeman, startForeman, useSupervisors } from '../../../test/supervisors.mjs';

const PR = 'https://example.com/acme/pull/1';
const RUN_MS = stretchByLoad(100_000);
const TEST_MS = RUN_MS + 20_000;

const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const id = process.env.FOREMAN_STORY;
const before = readFileSync(process.env.FAKE_CLAUDE_LOG, 'utf8').split('\\n').filter((l) => l === id).length;
appendFileSync(process.env.FAKE_CLAUDE_LOG, id + '\\n');
const foreman = (...args) => spawnSync(process.execPath, [process.env.FAKE_FOREMAN_BIN, ...args], { stdio: 'ignore' }).status;
const mode = process.env.FAKE_MODE;
foreman('story', 'start', id);
if (mode === 'crash-twice' && id === 'ACME-1' && before < 2) {
  if (process.env.FAKE_DIRTY && before === 1) {
    const head = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    if (head !== 'story/acme-1') spawnSync('git', ['checkout', '-qB', 'story/acme-1']);
    writeFileSync('wip.txt', 'half done\\n');
  }
  process.exit(0);
}
if (mode === 'foreign-claim' && id === 'ACME-1') {
  const claims = join(process.env.FOREMAN_STATE_DIR, 'claims');
  mkdirSync(claims, { recursive: true });
  const holder = { pid: Number(process.env.FOREMAN_SUPERVISOR_PID), slot: process.env.FOREMAN_SLOT, story: 'ACME-2', by: 'factory', at: new Date().toISOString() };
  writeFileSync(join(claims, 'ACME-2.json'), JSON.stringify(holder));
  spawnSync('sleep', [String(Number(process.env.FAKE_WAIT_MS) / 1000)]);
}
foreman('story', 'done', id, '--note', 'ok');
foreman('story', 'end', 'shipped', '${PR}', 'ok');
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, result: 'Shipped.\\nFACTORY_RESULT: shipped ' + id, total_cost_usd: 0, session_id: 'fake' }));
process.exit(0);
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
let state;
let bin;
let log;

// `statuses` maps a story id to its status in its note; every story is ACME-1 or ACME-2.
function setup(statuses = {}) {
  repos = makeRepos({ version: 1, project: { name: 'Acme' }, console: { adapter: 'files' }, features: { keepAwake: false }, learning: { auto: false } });
  clone = repos.clone('acme');
  writeFileSync(join(clone, '.gitignore'), '.foreman/\n');
  mkdirSync(join(clone, 'stories'));
  for (const id of ['ACME-1', 'ACME-2']) writeFileSync(join(clone, 'stories', `${id}.md`), STORY(id, statuses[id]));
  git(clone, 'add', '.');
  git(clone, 'commit', '-qm', 'Add the stories');
  git(clone, 'push', '-q', 'origin', 'main');
  state = join(clone, '.foreman');
  bin = join(repos.base, 'bin');
  mkdirSync(bin);
  for (const [name, text] of [['claude', FAKE_CLAUDE], ['gh', FAKE_GH]]) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  log = join(repos.base, 'claude.log');
  writeFileSync(log, '');
}
afterEach(() => repos?.cleanup());
// After the hook above, so it runs before it (vitest runs afterEach hooks last first).
useSupervisors();

const runEnv = (extra = {}) => {
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: repos.base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(env)) if (/^(FOREMAN|FACTORY)_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key)) delete env[key];
  return { ...env, ...fastTick, FAKE_CLAUDE_LOG: log, FAKE_FOREMAN_BIN: BIN, ...extra };
};

const calls = () => readFileSync(log, 'utf8').split('\n').filter(Boolean);
const feed = () => {
  const file = join(state, 'events.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const texts = () => feed().map((e) => e.text);
const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const claimFiles = () => (existsSync(join(state, 'claims')) ? readdirSync(join(state, 'claims')).filter((f) => f.endsWith('.json')) : []);
// The run's events and output, for a failed expectation.
const why = (r = {}) => `${feed().map((e) => `${e.at} ${e.kind} ${e.text}`).join('\n')}\ncalls ${JSON.stringify(calls())}\n${r.stdout ?? ''}\n${r.stderr ?? ''}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(what, test, ms, child) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (test()) return;
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`the run exited (${child.exitCode}) while waiting for ${what}\n${why()}`);
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}\n${why()}`);
}

describe('claims the run no longer needs', () => {
  it('after a slot parks for crashes and is unparked, its story is picked again by priority', async () => {
    setup();
    const env = runEnv({ FAKE_MODE: 'crash-twice', FAKE_DIRTY: '1' });
    const child = startForeman(['run', '--foreground', '2'], { cwd: clone, env });
    const slotFile = join(state, 'slots', 'w1.json');
    await waitFor('w1 to park for crashes', () => readJson(slotFile)?.state === 'parked' && readJson(slotFile)?.parkedFor === 'crash', RUN_MS, child);

    // Kept while the slot stays parked on its story.
    expect(readJson(slotFile).parkedStory, why()).toBe('ACME-1');
    expect(existsSync(join(state, 'claims', 'ACME-1.json'))).toBe(true);

    expect(runForeman(['slot', 'w1', 'unpark'], { cwd: clone, env }).status).toBe(0);
    expect(await child.exited, why()).toBe(0);

    expect(calls(), why()).toEqual(['ACME-1', 'ACME-1', 'ACME-1']);
    expect(texts()).toContain('Slot w1 unparked; let go of ACME-1, which is picked again by priority.');
    expect(existsSync(join(state, 'claims', 'ACME-1.json'))).toBe(false);
    expect(readJson(join(state, 'stories', 'ACME-1.json'))?.status).toBe('done');

    // The queued resume after the first crash kept its claim through the sweep (the sweep counts
    // queued work as in hand), so nothing was let go of by the sweep.
    expect(texts().filter((t) => t.includes('let go of its claim')), why()).toEqual([]);

    // The folder the second crash left dirty is saved on a leftover branch at the next pick, after
    // the unpark, and the story restarts from its committed branch.
    const unparkAt = texts().findIndex((t) => t.startsWith('Slot w1 unparked; let go of ACME-1'));
    const saved = texts().flatMap((t, i) => (/^Slot w1: ACME-1 left changes in its folder; they are on the branch leftover\/w1-acme-1-\d{8}, and the folder is clean again\.$/.test(t) ? [i] : []));
    expect(saved, why()).toHaveLength(1);
    expect(saved[0]).toBeGreaterThan(unparkAt);
    const branches = git(clone, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/leftover').split('\n').filter(Boolean);
    expect(branches, why()).toHaveLength(1);
    expect(git(clone, 'show', '--name-status', '--format=%s', branches[0])).toMatch(/^A\twip\.txt$/m);
  }, TEST_MS);

  it('discarding a crash-parked slot lets go of its story, which is picked again by priority', async () => {
    setup();
    const env = runEnv({ FAKE_MODE: 'crash-twice' });
    const child = startForeman(['run', '--foreground', '2'], { cwd: clone, env });
    const slotFile = join(state, 'slots', 'w1.json');
    await waitFor('w1 to park for crashes', () => readJson(slotFile)?.state === 'parked' && readJson(slotFile)?.parkedFor === 'crash', RUN_MS, child);
    expect(existsSync(join(state, 'claims', 'ACME-1.json'))).toBe(true);

    expect(runForeman(['slot', 'w1', 'discard'], { cwd: clone, env }).status).toBe(0);
    expect(await child.exited, why()).toBe(0);

    expect(calls(), why()).toEqual(['ACME-1', 'ACME-1', 'ACME-1']);
    expect(texts()).toContain('Slot w1 reset; let go of ACME-1, which is picked again by priority.');
    expect(existsSync(join(state, 'claims', 'ACME-1.json'))).toBe(false);
    expect(readJson(join(state, 'stories', 'ACME-1.json'))?.status).toBe('done');
  }, TEST_MS);

  it('a claim the live supervisor holds for a slot that moved on is let go', () => {
    setup();
    const r = runForeman(['run', '--foreground', '2'], { cwd: clone, env: runEnv({ FAKE_MODE: 'foreign-claim', FAKE_WAIT_MS: String(stretchByLoad(3000)) }), timeout: RUN_MS });
    expect(calls(), why(r)).toEqual(['ACME-1', 'ACME-2']);
    const events = feed();
    const letGo = events.findIndex((e) => e.text === 'ACME-2: let go of its claim; slot w1 is building ACME-1.');
    expect(letGo, why(r)).toBeGreaterThanOrEqual(0);
    expect(events[letGo].kind).toBe('warn');
    expect(letGo).toBeLessThan(events.findIndex((e) => e.text === 'Slot w1: ACME-2'));
    expect(claimFiles()).toEqual([]);
  }, TEST_MS);

  it('an owner claim on a done story is cleared within one tick; one on an open story stays', () => {
    setup({ 'ACME-1': 'done' });
    mkdirSync(join(state, 'claims'), { recursive: true });
    for (const id of ['ACME-1', 'ACME-2']) {
      writeFileSync(join(state, 'claims', `${id}.json`), JSON.stringify({ pid: null, slot: null, story: id, by: 'owner', at: '2026-10-24T09:00:00.000Z' }));
    }
    const r = runForeman(['run', '--foreground', '1'], { cwd: clone, env: runEnv(), timeout: RUN_MS });
    expect(r.status, why(r)).toBe(0);
    expect(calls(), why(r)).toEqual([]);
    const cleared = feed().filter((e) => e.text.includes('cleared your claim'));
    expect(cleared.map((e) => ({ text: e.text, kind: e.kind })), why(r)).toEqual([{ text: 'ACME-1: cleared your claim; the story is done.', kind: 'info' }]);
    expect(existsSync(join(state, 'claims', 'ACME-1.json'))).toBe(false);
    expect(readJson(join(state, 'claims', 'ACME-2.json'))).toMatchObject({ by: 'owner', story: 'ACME-2' });
  }, TEST_MS);

  it('an In Progress story with no claim is picked within one tick', () => {
    setup({ 'ACME-2': 'in-progress' });
    const r = runForeman(['run', '--foreground', '1'], { cwd: clone, env: runEnv(), timeout: RUN_MS });
    expect(calls(), why(r)).toEqual(['ACME-2']);
    // The first run of a slot prepares its folder in a child, which has its own event before the session starts.
    expect(texts().filter((t) => t.startsWith('Slot w1:'))).toContain('Slot w1: ACME-2');
  }, TEST_MS);
});
