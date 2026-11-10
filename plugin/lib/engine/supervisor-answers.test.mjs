// `foreman run 1` end to end, when the only story failed review and the owner answered
// "Retry with a note to the architect": the supervisor applies the answer itself, before it
// decides there is nothing to build, and starts the story. The same for a story blocked on an
// owner task answered in words, unless the owner has claimed that story. A fake `claude` (and
// `gh`) on the PATH stand in for the session and GitHub.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, makeRepos } from '../../../test/state-repos.mjs';
import * as decisions from '../console/decisions.mjs';
import * as locks from './locks.mjs';
import { fastTick } from '../../../test/fast-tick.mjs';
import { runForeman, useSupervisors } from '../../../test/supervisors.mjs';

const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
const id = process.env.FOREMAN_STORY;
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, result: 'Could not get further.\\nFACTORY_RESULT: blocked ' + id, total_cost_usd: 0, session_id: 'fake' }));
`;

const FAKE_GH = `#!/bin/sh
case "$1 $2" in
  "pr list") echo "[]" ;;
  *) exit 1 ;;
esac
`;

const STORY = '---\nid: ACME-1\ntitle: Story ACME-1\nstatus: blocked\ndepends_on: []\nblocked_by: Factory could not pass review; nothing was built\n---\n\nDo ACME-1.\n\n## Progress notes\n';
const OWNER_BLOCKED = STORY.replace('blocked_by: Factory could not pass review; nothing was built', 'blocked_by: Owner decision needed: which store?');

let repos;
let clone;
let bin;
let log;

beforeEach(() => {
  repos = makeRepos({ version: 1, project: { name: 'Acme' }, console: { adapter: 'files' }, features: { keepAwake: false }, learning: { auto: false } });
  clone = repos.clone('acme');
  writeFileSync(join(clone, '.gitignore'), '.foreman/\n');
  mkdirSync(join(clone, 'stories'));
  writeFileSync(join(clone, 'stories', 'ACME-1.md'), STORY);
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
});
afterEach(() => repos.cleanup());
// After the hooks above, so it runs before them (vitest runs afterEach hooks last first).
useSupervisors();

const runEnv = () => {
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: repos.base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', FAKE_CLAUDE_LOG: log };
  for (const key of Object.keys(env)) if (/^(FOREMAN|FACTORY)_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key)) delete env[key];
  Object.assign(env, fastTick);
  return env;
};

describe('the supervisor applies an answered retry when nothing else runs', () => {
  it('puts the failed story back with the note, marks the answer applied, and starts it', () => {
    const state = join(clone, '.foreman');
    const id = decisions.add(state, { story: 'ACME-1', kind: 'decision', title: 'ACME-1 could not pass review', options: ['Retry with a note to the architect', "I'll take it", 'Drop'] });
    decisions.answer(state, id, { option: 'Retry with a note to the architect', note: 'Use the cache' });

    const r = runForeman(['run', '--foreground', '1'], { cwd: clone, env: runEnv(), encoding: 'utf8', timeout: 55_000 });
    expect(r.stdout).not.toContain('Nothing left to build');
    expect(r.status).toBe(0);
    // The supervisor removes its pid file as it exits.
    expect(existsSync(join(state, 'supervisor.pid'))).toBe(false);

    const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(calls).toHaveLength(1);
    expect(calls[0][calls[0].indexOf('-p') + 1]).toBe('/foreman:story ACME-1');

    const overlay = JSON.parse(readFileSync(join(state, 'stories', 'ACME-1.json'), 'utf8'));
    expect(JSON.stringify(overlay.notes)).toContain('Note for the architect: Use the cache');
    expect(decisions.list(state).find((d) => d.id === id).appliedAt).toBeTruthy();

    const events = readFileSync(join(state, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).text);
    expect(events).toContain('Applied your answer to "ACME-1 could not pass review": Retry with a note to the architect.');
  }, 60_000);
});

describe('the supervisor applies an answered owner task about a story blocked in words', () => {
  const TITLE = 'ACME-1: which store?';
  // ACME-1 blocked on an owner question in words, and the owner's task answered in words.
  const setUp = () => {
    writeFileSync(join(clone, 'stories', 'ACME-1.md'), OWNER_BLOCKED);
    git(clone, 'commit', '-qam', 'Block ACME-1 on the owner');
    git(clone, 'push', '-q', 'origin', 'main');
    const state = join(clone, '.foreman');
    const id = decisions.add(state, { story: 'ACME-1', kind: 'task', title: TITLE, options: [] });
    decisions.answer(state, id, { option: null, note: '(A) the database' });
    return { state, id };
  };
  const callsOf = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const eventsOf = (state) => (existsSync(join(state, 'events.jsonl')) ? readFileSync(join(state, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).text) : []);

  it('puts a story blocked on an owner task back with the answer and starts it', () => {
    const { state, id } = setUp();

    const r = runForeman(['run', '--foreground', '1'], { cwd: clone, env: runEnv(), encoding: 'utf8', timeout: 55_000 });
    expect(r.stdout).not.toContain('Nothing left to build');
    expect(r.status).toBe(0);

    const calls = callsOf();
    expect(calls).toHaveLength(1);
    expect(calls[0][calls[0].indexOf('-p') + 1]).toBe('/foreman:story ACME-1');

    const overlay = JSON.parse(readFileSync(join(state, 'stories', 'ACME-1.json'), 'utf8'));
    expect(JSON.stringify(overlay.notes)).toContain(JSON.stringify(`Note for the architect: the owner answered "${TITLE}": (A) the database`).slice(1, -1));
    expect(decisions.list(state).find((d) => d.id === id).appliedAt).toBeTruthy();
    expect(eventsOf(state)).toContain(`Applied your answer to "${TITLE}": ACME-1 is back to todo with your answer.`);
  }, 60_000);

  it('leaves a story the owner has claimed alone', () => {
    const { state, id } = setUp();
    locks.ownerClaim(state, 'ACME-1');

    const r = runForeman(['run', '--foreground', '1'], { cwd: clone, env: runEnv(), encoding: 'utf8', timeout: 55_000 });
    expect(r.status).toBe(0);
    expect(callsOf()).toEqual([]);
    expect(decisions.list(state).find((d) => d.id === id).appliedAt).toBeNull();
    const overlay = join(state, 'stories', 'ACME-1.json');
    const status = existsSync(overlay) ? JSON.parse(readFileSync(overlay, 'utf8')).status ?? 'blocked' : 'blocked';
    expect(status).toBe('blocked');
    expect(readFileSync(join(clone, 'stories', 'ACME-1.md'), 'utf8')).toContain('status: blocked');
  }, 60_000);
});
