// A real `foreman run --foreground --exit-when-idle --workers 1 1` (no environment adapter) with
// stories that end blocked. A story that ends blocked built nothing, so it does not use up the one
// story the run asked for: the next todo story starts and ships. A story blocked on stories that
// are already done is recorded in words, picked once, and left for the owner with one task. A session
// that reports blocked without a block the picker leaves alone still counts, so `run 1` ends after it. A fake
// `claude` and `gh` on the PATH stand in for the session and GitHub; the fake claude blocks the
// stories named in FAKE_BLOCKS (a JSON object of story id to reason) and ships every other.

import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, makeRepos } from '../../../test/state-repos.mjs';
import { fastTick } from '../../../test/fast-tick.mjs';
import { BIN, runForeman, useSupervisors } from '../../../test/supervisors.mjs';

const FAKE_CLAUDE = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const id = process.env.FOREMAN_STORY;
const how = process.env.FAKE_BLOCK_HOW || 'command';
appendFileSync(process.env.FAKE_CLAUDE_LOG, id + '\\n');
const foreman = (...args) => spawnSync(process.execPath, [process.env.FAKE_FOREMAN_BIN, ...args], { stdio: 'ignore' }).status; // supervisor-guard: not a supervisor
if (foreman('story', 'start', id) !== 0) process.exit(1);
const reason = JSON.parse(process.env.FAKE_BLOCKS || '{}')[id];
if (reason) {
  if (how === 'command') foreman('story', 'block', id, '--reason', reason);
  if (how === 'overlay') {
    const file = join(process.env.FOREMAN_STATE_DIR, 'stories', id + '.json');
    let old = {};
    try { old = JSON.parse(readFileSync(file, 'utf8')); } catch {}
    writeFileSync(file, JSON.stringify({ fields: {}, notes: [], ...old, id, status: 'blocked', blockedBy: reason }));
  }
  foreman('story', 'end', 'blocked', '', reason);
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, result: 'Blocked.\\nFACTORY_RESULT: blocked ' + id, total_cost_usd: 0, session_id: 'fake' }));
  process.exit(0);
}
if (foreman('story', 'done', id, '--note', 'shipped by the fake session') !== 0) process.exit(1);
foreman('story', 'end', 'shipped', '', 'shipped by the fake session');
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, result: 'Done.\\nFACTORY_RESULT: shipped ' + id, total_cost_usd: 0, session_id: 'fake' }));
`;

const FAKE_GH = `#!/bin/sh
if [ "$1 $2" = "pr list" ]; then
  echo '[]'
  exit 0
fi
exit 1
`;

const STORY = (id, order, status = 'todo') => `---\nid: ${id}\ntitle: Story ${id}\nstatus: ${status}\norder: ${order}\ndepends_on: []\n---\n\nDo ${id}.\n\n## Progress notes\n`;

let repos;
let clone;
let bin;
let claudeLog;
let state;

afterEach(() => repos?.cleanup());
// After the hook above, so it runs before it (vitest runs afterEach hooks last first).
useSupervisors();

function setup(stories) {
  repos = makeRepos({ version: 1, project: { name: 'Acme' }, slots: 1, workers: 1, console: { adapter: 'files' }, features: { keepAwake: false }, learning: { auto: false } });
  clone = repos.clone('acme');
  writeFileSync(join(clone, '.gitignore'), '.foreman/\n');
  mkdirSync(join(clone, 'stories'));
  for (const [id, order, status] of stories) writeFileSync(join(clone, 'stories', `${id}.md`), STORY(id, order, status));
  git(clone, 'add', '.');
  git(clone, 'commit', '-qm', 'Add the stories');
  git(clone, 'push', '-q', 'origin', 'main');
  git(clone, 'worktree', 'add', '--detach', join(clone, '.foreman', 'worktrees', 'w1'), 'origin/main');
  state = join(clone, '.foreman');
  bin = join(repos.base, 'bin');
  mkdirSync(bin);
  for (const [name, text] of [['claude', FAKE_CLAUDE], ['gh', FAKE_GH]]) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  claudeLog = join(repos.base, 'claude.log');
  writeFileSync(claudeLog, '');
}

const run = (blocks, how = 'command') => {
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: repos.base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(env)) if (/^(FOREMAN|FACTORY)_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key)) delete env[key];
  Object.assign(env, fastTick, { FAKE_CLAUDE_LOG: claudeLog, FAKE_FOREMAN_BIN: BIN, FAKE_BLOCKS: JSON.stringify(blocks), FAKE_BLOCK_HOW: how });
  return runForeman(['run', '--foreground', '--exit-when-idle', '--workers', '1', '1'], { cwd: clone, env, encoding: 'utf8', timeout: 100_000 });
};
const lines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean);
const texts = () => lines(join(state, 'events.jsonl')).map((l) => JSON.parse(l).text);
const story = (id) => JSON.parse(readFileSync(join(state, 'stories', `${id}.json`), 'utf8'));
const why = (r) => `${texts().join('\n')}\n${r.stdout}\n${r.stderr}`;
const items = () => {
  const folder = join(state, 'decisions');
  return existsSync(folder) ? readdirSync(folder).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(folder, f), 'utf8'))) : [];
};

describe('foreman run N and a story that ends blocked', () => {
  it('starts and ships the next todo story: a blocked attempt does not use up the one asked for', () => {
    setup([['ACME-1', 1], ['ACME-2', 5]]);
    const r = run({ 'ACME-1': 'needs a key from the owner' });
    expect(r.status, why(r)).toBe(0);
    expect(lines(claudeLog)).toEqual(['ACME-1', 'ACME-2']);
    expect(story('ACME-2').status).toBe('done');
    expect(story('ACME-1').status).toBe('blocked');
    expect(r.stdout).toContain('Reached the 1 story asked for.');
    expect(r.stdout).not.toContain('left in hand');
    expect(texts()).toContain('ACME-1 was blocked and shipped nothing, so it does not count toward the 1 story asked for.');
  }, 120_000);

  it('picks a story blocked on a story that is already done once, and asks the owner once', () => {
    setup([['ACME-1', 1, 'done'], ['ACME-2', 1], ['ACME-3', 5]]);
    const r = run({ 'ACME-2': 'ACME-1 must land first' });
    expect(r.status, why(r)).toBe(0);
    expect(lines(claudeLog)).toEqual(['ACME-2', 'ACME-3']);
    expect(story('ACME-3').status).toBe('done');
    expect(story('ACME-2').status).toBe('blocked');
    expect(story('ACME-2').blockedBy).toMatch(/^Needs you:/);
    const tasks = items();
    expect(tasks, why(r)).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ story: 'ACME-2', kind: 'task', title: 'ACME-2 is blocked on ACME-1, which is already done' });
  }, 120_000);

  it('keeps counting a story whose session reports blocked without recording a block: run 1 ends after it', () => {
    setup([['ACME-1', 1], ['ACME-2', 5]]);
    const r = run({ 'ACME-1': 'needs a key from the owner' }, 'none');
    expect(r.status, why(r)).toBe(0);
    expect(lines(claudeLog)).toEqual(['ACME-1']);
    expect(r.stdout).toContain('Reached the 1 story asked for.');
    expect(texts().some((t) => t.includes('does not count toward'))).toBe(false);
    expect(story('ACME-1').status).not.toBe('blocked');
  }, 120_000);

  it('keeps counting a story blocked on stories already done, which the picker would take again: run 1 ends after it', () => {
    setup([['ACME-1', 1, 'done'], ['ACME-2', 1], ['ACME-3', 5]]);
    const r = run({ 'ACME-2': 'ACME-1 must land first' }, 'overlay');
    expect(r.status, why(r)).toBe(0);
    expect(lines(claudeLog)).toEqual(['ACME-2']);
    expect(story('ACME-2')).toMatchObject({ status: 'blocked', blockedBy: 'ACME-1 must land first' });
    expect(r.stdout).toContain('Reached the 1 story asked for.');
    expect(texts().some((t) => t.includes('does not count toward'))).toBe(false);
  }, 120_000);
});
