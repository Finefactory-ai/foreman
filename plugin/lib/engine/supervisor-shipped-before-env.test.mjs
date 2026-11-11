// A real `foreman run --foreground --exit-when-idle --workers 1` with an environment adapter
// (docker), for the look at whether a story already shipped, made before the slot makes or resets
// its environment. A story whose pull request merged is marked done with no docker call and no
// session, whether it is picked fresh or is start-up work ("closing ACME-1"); one whose look-up
// fails is built. A fake `claude`, `gh` and `docker` on the PATH stand in for the session, GitHub
// and Docker. The fake gh answers the merged-PR look-up for story/acme-1 with a merged pull
// request (exit 1 with FAKE_GH_BROKEN), and start-up recovery's merged list with it only when
// FAKE_GH_STARTUP is set.

import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, makeRepos } from '../../../test/state-repos.mjs';
import { fastTick } from '../../../test/fast-tick.mjs';
import { nextStory } from '../console/control.mjs';
import { BIN, runForeman, useSupervisors } from '../../../test/supervisors.mjs';

const PR = 'https://example.com/acme/pull/1';

const FAKE_CLAUDE = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const id = process.env.FOREMAN_STORY;
appendFileSync(process.env.FAKE_CLAUDE_LOG, id + '\\n');
const foreman = (...args) => spawnSync(process.execPath, [process.env.FAKE_FOREMAN_BIN, ...args], { stdio: 'ignore' }).status; // supervisor-guard: not a supervisor
if (foreman('story', 'start', id) !== 0) process.exit(1);
if (foreman('story', 'done', id, '--note', 'shipped by the fake session') !== 0) process.exit(1);
foreman('story', 'end', 'shipped', '', 'shipped by the fake session');
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, result: 'Done.\\nFACTORY_RESULT: shipped ' + id, total_cost_usd: 0, session_id: 'fake' }));
`;

const FAKE_DOCKER = `#!/bin/sh
echo "$(basename "$(pwd -P)") $*" >> "$FAKE_DOCKER_LOG"
exit 0
`;

const FAKE_GH = `#!/bin/sh
echo "$*" >> "$FAKE_GH_LOG"
if [ "$1 $2" = "pr list" ]; then
  case "$*" in
    *"--head story/acme-1 "*)
      if [ -n "$FAKE_GH_BROKEN" ]; then exit 1; fi
      echo '[{"url":"${PR}"}]' ;;
    *"--json headRefName"*)
      if [ -n "$FAKE_GH_STARTUP" ]; then echo '[{"headRefName":"story/acme-1"}]'; else echo '[]'; fi ;;
    *) echo '[]' ;;
  esac
  exit 0
fi
exit 1
`;

const STORY = (id, order, status = 'todo') => `---\nid: ${id}\ntitle: Story ${id}\nstatus: ${status}\norder: ${order}\ndepends_on: []\n---\n\nDo ${id}.\n\n## Progress notes\n`;

let repos;
let clone;
let bin;
let claudeLog;
let dockerLog;
let ghLog;
let state;

afterEach(() => repos?.cleanup());
// After the hook above, so it runs before it (vitest runs afterEach hooks last first).
useSupervisors();

function setup(stories) {
  repos = makeRepos({ version: 1, project: { name: 'Acme' }, slots: 1, workers: 1, env: { adapter: 'docker', projectPrefix: 'acme' }, console: { adapter: 'files' }, features: { keepAwake: false }, learning: { auto: false } });
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
  for (const [name, text] of [['claude', FAKE_CLAUDE], ['gh', FAKE_GH], ['docker', FAKE_DOCKER]]) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  claudeLog = join(repos.base, 'claude.log');
  dockerLog = join(repos.base, 'docker.log');
  ghLog = join(repos.base, 'gh.log');
  for (const f of [claudeLog, dockerLog, ghLog]) writeFileSync(f, '');
}

const run = (extra = {}, args = []) => {
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: repos.base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(env)) if (/^(FOREMAN|FACTORY)_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key)) delete env[key];
  Object.assign(env, fastTick, { FAKE_CLAUDE_LOG: claudeLog, FAKE_DOCKER_LOG: dockerLog, FAKE_GH_LOG: ghLog, FAKE_FOREMAN_BIN: BIN }, extra);
  return runForeman(['run', '--foreground', '--exit-when-idle', '--workers', '1', ...args], { cwd: clone, env, encoding: 'utf8', timeout: 100_000 });
};
const lines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean);
const texts = () => lines(join(state, 'events.jsonl')).map((l) => JSON.parse(l).text);
const story = (id) => JSON.parse(readFileSync(join(state, 'stories', `${id}.json`), 'utf8'));
const why = (r) => `${texts().join('\n')}\n${r.stdout}\n${r.stderr}`;

const NO_ENV = 'ACME-1: its pull request merged; marked it done with no environment made.';

// What every case that closes ACME-1 shows.
function expectClosed(r) {
  expect(texts(), why(r)).toContain(NO_ENV);
  expect(texts().some((t) => t.includes('preparing its environment for ACME-1'))).toBe(false);
  expect(story('ACME-1').status).toBe('done');
  expect(JSON.stringify(story('ACME-1').notes)).toContain(PR);
  expect(existsSync(join(state, 'claims', 'ACME-1.json'))).toBe(false);
}

describe('foreman run with an environment adapter and a story whose pull request merged', () => {
  it('marks a todo story done, picked fresh, with no docker call and no session', () => {
    setup([['ACME-1', 1]]);
    const r = run();
    expect(r.status, why(r)).toBe(0);
    expect(lines(claudeLog)).toEqual([]);
    expect(lines(dockerLog)).toEqual([]);
    expectClosed(r);
    expect(lines(ghLog)).toContain('pr list --head story/acme-1 --state merged --json url,mergedAt --limit 10');
  }, 120_000);

  it('builds the next story after closing it, with docker and a session', () => {
    setup([['ACME-1', 1], ['ACME-2', 5]]);
    const r = run();
    expect(r.status, why(r)).toBe(0);
    expectClosed(r);
    expect(lines(claudeLog)).toEqual(['ACME-2']);
    expect(lines(dockerLog).length).toBeGreaterThan(0);
    expect(story('ACME-2').status).toBe('done');
  }, 120_000);

  it('does not count the closed story toward --max: with --max 1 it builds the next story', () => {
    setup([['ACME-1', 1], ['ACME-2', 5]]);
    const r = run({}, ['1']);
    expect(r.status, why(r)).toBe(0);
    expectClosed(r);
    expect(lines(claudeLog)).toEqual(['ACME-2']);
    expect(story('ACME-2').status).toBe('done');
    expect(r.stdout).toContain('Reached the 1 story asked for.');
  }, 120_000);

  it("settles the owner's build-next request for it as refused, and builds the next story", () => {
    setup([['ACME-1', 5], ['ACME-2', 1]]);
    nextStory(state, 'ACME-1');
    const at = JSON.parse(readFileSync(join(state, 'control.json'), 'utf8')).requestedAt;
    const r = run();
    expect(r.status, why(r)).toBe(0);
    expectClosed(r);
    const said = texts();
    expect(said.filter((t) => t === 'You asked for ACME-1 next, but it cannot be built yet; the factory carries on in order.')).toHaveLength(1);
    expect(said).not.toContain('You asked for ACME-1 next; starting it.');
    expect(JSON.parse(readFileSync(join(state, 'state.json'), 'utf8')).handledNextAt).toBe(at);
    expect(lines(claudeLog)).toEqual(['ACME-2']);
    expect(story('ACME-2').status).toBe('done');
  }, 120_000);

  it('closes the story queued by start-up recovery, with no docker call and no session', () => {
    setup([['ACME-1', 1, 'in-progress']]);
    const r = run({ FAKE_GH_STARTUP: '1' });
    expect(r.status, why(r)).toBe(0);
    expect(texts(), why(r)).toContain('Start-up: closing ACME-1.');
    expect(lines(claudeLog)).toEqual([]);
    expect(lines(dockerLog)).toEqual([]);
    expectClosed(r);
  }, 120_000);

  it('builds the story when the merged look-up fails', () => {
    setup([['ACME-1', 1]]);
    const r = run({ FAKE_GH_BROKEN: '1' });
    expect(r.status, why(r)).toBe(0);
    expect(texts().includes(NO_ENV)).toBe(false);
    expect(lines(dockerLog).length).toBeGreaterThan(0);
    expect(lines(claudeLog)).toEqual(['ACME-1']);
    expect(story('ACME-1').status).toBe('done');
  }, 120_000);
});
