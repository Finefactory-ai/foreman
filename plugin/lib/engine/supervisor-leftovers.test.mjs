// `foreman run` end to end, for the changes a story leaves in its slot's folder: a story that
// ships with staged, unstaged and untracked changes leaves w1 clean and detached at base, the
// changes on a local leftover/w1-acme-1-<date> branch and an event naming it, and the next story
// starts in w1 without the slot parking. A dirty folder on the branch of a story that has ended
// and nothing holds is saved and cleaned the same way at the pick; one whose story is still held
// (an owner claim) parks as before, its changes left in place. The dry run says which it would do.
// A fake `claude` (and `gh`) on the PATH stand in for the session and GitHub.

import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, makeRepos, sh, writeFile } from '../../../test/state-repos.mjs';
import { ownerClaim } from './locks.mjs';
import { fastTick } from '../../../test/fast-tick.mjs';
import { endChild, runForeman, startForeman, useSupervisors } from '../../../test/supervisors.mjs';

const BIN = fileURLToPath(new URL('../../bin/foreman', import.meta.url));
const PR = 'https://example.com/acme/pull/1';

// The story FAKE_LEAVE names leaves a staged new file, an unstaged edit, an untracked file and a key file
// on its branch, then ships. Every session writes its story, and the git status and HEAD of its folder, to the log.
const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const id = process.env.FOREMAN_STORY;
const git = (...args) => spawnSync('git', args, { encoding: 'utf8' }).stdout;
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ story: id, status: git('status', '--porcelain'), head: git('rev-parse', '--abbrev-ref', 'HEAD').trim() }) + '\\n');
const foreman = (...args) => spawnSync(process.execPath, [process.env.FAKE_FOREMAN_BIN, ...args], { stdio: 'ignore' }).status;
if (id === process.env.FAKE_LEAVE) {
  git('checkout', '-qB', 'story/acme-1');
  mkdirSync('src', { recursive: true });
  writeFileSync('src/staged.txt', 'staged\\n');
  git('add', 'src/staged.txt');
  writeFileSync('README.md', 'a project, edited by ACME-1\\n');
  writeFileSync('notes.txt', 'notes\\n');
  mkdirSync('certs', { recursive: true });
  writeFileSync('certs/acme.pem', 'not a real key\\n');
}
if (foreman('story', 'start', id) !== 0 || foreman('story', 'done', id, '--note', 'shipped by the fake session') !== 0) process.exit(1);
foreman('story', 'end', 'shipped', '${PR}', 'ok');
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, result: 'Shipped.\\nFACTORY_RESULT: shipped ' + id, total_cost_usd: 0, session_id: 'fake' }));
`;

const FAKE_GH = `#!/bin/sh
case "$1 $2" in
  "pr list") echo "[]" ;;
  *) exit 1 ;;
esac
`;

const CONFIG = { version: 1, project: { name: 'Acme' }, console: { adapter: 'files' }, features: { keepAwake: false }, env: { adapter: 'none' }, ship: { steps: ['push'] } };
const story = (id, status = 'todo') => `---\nid: ${id}\ntitle: Story ${id}\nstatus: ${status}\ndepends_on: []\n---\n\nDo ${id}.\n\n## Progress notes\n`;
const LEFTOVER = /^leftover\/w1-acme-(\d+)-\d{8}$/;

let repos;
let clone;
let stateDir;
let bin;
let claudeLog;
let w1;

function setup(seed) {
  repos = makeRepos(CONFIG);
  clone = repos.clone('acme');
  writeFileSync(join(clone, '.gitignore'), '.foreman/\n');
  mkdirSync(join(clone, 'stories'));
  for (const [id, status] of Object.entries(seed)) writeFileSync(join(clone, 'stories', `${id}.md`), story(id, status));
  git(clone, 'add', '.');
  git(clone, 'commit', '-qm', 'Add the stories');
  git(clone, 'push', '-q', 'origin', 'main');
  stateDir = join(clone, '.foreman');
  mkdirSync(stateDir, { recursive: true });
  w1 = join(stateDir, 'worktrees', 'w1');
  bin = join(repos.base, 'bin');
  mkdirSync(bin);
  for (const [name, text] of [['claude', FAKE_CLAUDE], ['gh', FAKE_GH]]) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  claudeLog = join(repos.base, 'claude.log');
}

// ACME-0 is done, and w1 is still on its branch with a staged file; ACME-1 is to do.
function seedEnded(status = 'done') {
  setup({ 'ACME-0': status, 'ACME-1': 'todo' });
  git(clone, 'fetch', '-q', 'origin');
  git(clone, 'worktree', 'add', '-q', '-b', 'story/acme-0', w1, 'origin/main');
  writeFile(join(w1, 'src', 'left.txt'), 'left behind by ACME-0\n');
  git(w1, 'add', 'src/left.txt');
}

afterEach(() => repos?.cleanup());
// After the hooks above, so it runs before them (vitest runs afterEach hooks last first).
useSupervisors();

const runEnv = () => {
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, HOME: repos.base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(env)) if (/^(FOREMAN|FACTORY)_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key)) delete env[key];
  Object.assign(env, fastTick);
  return { ...env, FAKE_CLAUDE_LOG: claudeLog, FAKE_FOREMAN_BIN: BIN };
};

const run = (args, extra = {}) => runForeman(args, { cwd: clone, env: { ...runEnv(), ...extra }, encoding: 'utf8', timeout: 55_000 });
const sessions = () => (existsSync(claudeLog) ? readFileSync(claudeLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const leftovers = () => git(clone, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/leftover').split('\n').filter(Boolean);
const events = () => (existsSync(join(stateDir, 'events.jsonl')) ? readFileSync(join(stateDir, 'events.jsonl'), 'utf8') : '');
const slotState = () => JSON.parse(readFileSync(join(stateDir, 'slots', 'w1.json'), 'utf8'));
const status = (dir) => sh('git', ['status', '--porcelain'], { cwd: dir }).stdout;

// Waits (at most `ms`) for `done()`, checking every 200 ms.
async function until(done, ms = 20_000) {
  for (let waited = 0; waited < ms && !done(); waited += 200) await new Promise((r) => setTimeout(r, 200));
  return done();
}

describe('foreman run and the changes a story leaves in its folder', () => {
  it('saves a shipped story\'s leftover changes on a branch and starts the next story in the clean slot', () => {
    setup({ 'ACME-1': 'todo', 'ACME-2': 'todo' });
    const r = run(['run', '--foreground', '2'], { FAKE_LEAVE: 'ACME-1' });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(sessions().map((s) => s.story), out).toEqual(['ACME-1', 'ACME-2']);
    expect(r.status, out).toBe(0);
    expect(sessions()[1]).toMatchObject({ status: '', head: 'HEAD' });
    const found = leftovers();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(LEFTOVER);
    expect(found[0]).toMatch(/^leftover\/w1-acme-1-/);
    const shown = git(clone, 'show', '--name-status', '--format=%s', found[0]);
    expect(shown).toMatch(/^A\tsrc\/staged\.txt$/m);
    expect(shown).toMatch(/^M\tREADME\.md$/m);
    expect(shown).toMatch(/^A\tnotes\.txt$/m);
    expect(shown).not.toContain('acme.pem');
    expect(events()).toContain('ACME-1 left key files in its folder (certs/acme.pem); they are not on any branch and were deleted.');
    expect(events()).toContain(`ACME-1 left changes in its folder; they are on the branch ${found[0]}, and the folder is clean again.`);
    expect(slotState()).toMatchObject({ state: 'idle', parkedFor: null });
    expect(events()).not.toContain('Its folder has changes that do not belong to a story.');
    expect(events()).not.toContain('Slot w1 parked:');
  }, 90_000);

  // No later pick follows ACME-1, so only the tidy when its session ends can clean the folder.
  it('leaves the folder clean and detached at base as soon as a story that left changes ends', () => {
    setup({ 'ACME-1': 'todo' });
    const r = run(['run', '--foreground', '1'], { FAKE_LEAVE: 'ACME-1' });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(sessions().map((s) => s.story), out).toEqual(['ACME-1']);
    expect(r.status, out).toBe(0);
    expect(status(w1)).toBe('');
    expect(git(w1, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
    expect(git(w1, 'rev-parse', 'HEAD')).toBe(git(clone, 'rev-parse', 'origin/main'));
    const found = leftovers();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^leftover\/w1-acme-1-\d{8}$/);
    const shown = git(clone, 'show', '--name-status', '--format=%s', found[0]);
    expect(shown).toMatch(/^A\tsrc\/staged\.txt$/m);
    expect(shown).toMatch(/^M\tREADME\.md$/m);
    expect(shown).toMatch(/^A\tnotes\.txt$/m);
    expect(existsSync(join(w1, 'certs', 'acme.pem'))).toBe(false);
    expect(events()).toContain(`ACME-1 left changes in its folder; they are on the branch ${found[0]}, and the folder is clean again.`);
    expect(slotState()).toMatchObject({ state: 'idle', parkedFor: null });
  }, 90_000);

  it('saves and cleans a dirty folder at the pick when its story has ended and nothing holds it', () => {
    seedEnded();
    const r = run(['run', '--foreground', '1']);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(sessions().map((s) => s.story), out).toEqual(['ACME-1']);
    expect(r.status, out).toBe(0);
    expect(sessions()[0]).toMatchObject({ status: '', head: 'HEAD' });
    const found = leftovers();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^leftover\/w1-acme-0-\d{8}$/);
    expect(git(clone, 'show', '--name-status', '--format=%s', found[0])).toMatch(/^A\tsrc\/left\.txt$/m);
    expect(events()).toContain(`ACME-0 left changes in its folder; they are on the branch ${found[0]}`);
    expect(events()).not.toContain('Its folder has changes that do not belong to a story.');
    expect(events()).not.toContain('Slot w1 parked:');
    expect(slotState()).toMatchObject({ state: 'idle', parkedFor: null });
  }, 90_000);

  it('saves a dirty folder on the branch of a story the source no longer lists, and starts the next story', () => {
    setup({ 'ACME-1': 'todo' });
    git(clone, 'fetch', '-q', 'origin');
    git(clone, 'worktree', 'add', '-q', '-b', 'story/acme-9', w1, 'origin/main');
    writeFile(join(w1, 'src', 'left.txt'), 'left behind by ACME-9\n');
    git(w1, 'add', 'src/left.txt');
    const r = run(['run', '--foreground', '1']);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(sessions().map((s) => s.story), out).toEqual(['ACME-1']);
    expect(r.status, out).toBe(0);
    expect(sessions()[0]).toMatchObject({ status: '', head: 'HEAD' });
    const found = leftovers();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^leftover\/w1-acme-9-\d{8}$/);
    expect(git(clone, 'show', '--name-status', '--format=%s', found[0])).toMatch(/^A\tsrc\/left\.txt$/m);
    expect(events()).toContain(`ACME-9 left changes in its folder; they are on the branch ${found[0]}`);
    expect(events()).not.toContain('Slot w1 parked:');
    expect(slotState()).toMatchObject({ state: 'idle', parkedFor: null });
  }, 90_000);

  it('still parks a dirty folder whose story is held, and leaves its changes alone', async () => {
    // Open, because the run clears the owner's claim on a done story at its first tick.
    seedEnded('in-progress');
    ownerClaim(stateDir, 'ACME-0');
    const child = startForeman(['run', '--foreground', '1'], { cwd: clone, env: runEnv(), stdio: 'ignore' });
    try {
      const parked = await until(() => existsSync(join(stateDir, 'slots', 'w1.json')) && slotState().state === 'parked');
      expect(parked, events()).toBe(true);
      const text = 'Slot w1 parked: its folder has changes that do not belong to a story. The folder is on the branch story/acme-0.';
      expect(await until(() => events().includes(text)), events()).toBe(true);
      const line = events().split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.text === text);
      expect(line).toMatchObject({ kind: 'warn', slot: 'w1' });
      expect(slotState()).toMatchObject({ state: 'parked', parkedFor: 'dirty', reason: 'Its folder has changes that do not belong to a story.' });
      expect(sessions()).toEqual([]);
      expect(leftovers()).toEqual([]);
      expect(status(w1)).toContain('A  src/left.txt');
      expect(git(w1, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('story/acme-0');
    } finally {
      await endChild(child);
    }
  }, 60_000);

  it('the dry run says it would save an ended story\'s changes, and writes nothing', () => {
    seedEnded();
    const r = run(['run', '--dry-run']);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(r.stdout).toContain("would save w1's leftover changes from ACME-0 on a leftover branch and clean its folder");
    expect(r.stdout).toContain('would start ACME-1');
    expect(r.stdout).not.toContain('would park');
    expect(status(w1)).toContain('A  src/left.txt');
    expect(leftovers()).toEqual([]);
  }, 60_000);

  it('the dry run says it would park a dirty folder whose story is held', () => {
    seedEnded();
    ownerClaim(stateDir, 'ACME-0');
    const r = run(['run', '--dry-run']);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('would park w1: its folder has changes that do not belong to a story');
    expect(r.stdout).not.toContain('would save');
    expect(status(w1)).toContain('A  src/left.txt');
  }, 60_000);
});
