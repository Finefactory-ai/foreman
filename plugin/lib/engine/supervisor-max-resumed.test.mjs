// A real `foreman run --foreground --exit-when-idle --workers 1 1` (no environment adapter) with
// three stories an earlier run left in hand (in progress, each with a branch). They are resumed
// first, on top of the one story asked for, and do not count towards it: the run says so when it
// starts and names them when it stops. A fake `claude` and `gh` on the PATH stand in for the
// session and GitHub; the fake claude ships every story it is started on. It also covers a restart
// onto new code in the middle of the run: the counts of the resumed stories are carried across it.

import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, makeRepos } from '../../../test/state-repos.mjs';
import { fastTick } from '../../../test/fast-tick.mjs';
import { slow } from '../../../test/wait-scale.mjs';
import { BIN, runForeman, useSupervisors } from '../../../test/supervisors.mjs';

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

// Like FAKE_CLAUDE, but the 2nd session started first commits a change to the plugin the run
// executes (so the supervisor restarts onto it), and ships only once the new process has taken over.
const FAKE_CLAUDE_RESTART = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const id = process.env.FOREMAN_STORY;
appendFileSync(process.env.FAKE_CLAUDE_LOG, id + '\\n');
const nth = readFileSync(process.env.FAKE_CLAUDE_LOG, 'utf8').split('\\n').filter(Boolean).length;
const foreman = (...args) => spawnSync(process.execPath, [process.env.FAKE_FOREMAN_BIN, ...args], { stdio: 'ignore' }).status; // supervisor-guard: not a supervisor
if (nth === 2) {
  const plug = process.env.FAKE_PLUG;
  const state = process.env.FOREMAN_STATE_DIR;
  writeFileSync(join(plug, 'lib', 'touched.txt'), 'new code\\n');
  const git = (...args) => spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: plug });
  git('add', 'lib/touched.txt');
  git('commit', '-qm', 'Touch the plugin');
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const adopted = () => readFileSync(join(state, 'events.jsonl'), 'utf8').split('\\n').some((l) => l.includes('"Restarted on new code')) && JSON.parse(readFileSync(join(state, 'state.json'), 'utf8')).restart === null;
  for (const end = Date.now() + ${slow(60_000)}; Date.now() < end; Atomics.wait(pause, 0, 0, 200)) {
    try {
      if (adopted()) break;
    } catch {}
  }
}
if (foreman('story', 'start', id) !== 0) process.exit(1);
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

afterEach(() => repos?.cleanup());
// After the hook above, so it runs before it (vitest runs afterEach hooks last first).
useSupervisors();

// The project (Acme) with `stories` ([id, order, status]) on the base branch, a branch for each
// story in progress, the w1 worktree, and the fake `claude` (`claudeText`) and `gh` on the PATH.
function project(stories, claudeText) {
  repos = makeRepos({ version: 1, project: { name: 'Acme' }, slots: 1, workers: 1, console: { adapter: 'files' }, features: { keepAwake: false }, learning: { auto: false } });
  const clone = repos.clone('acme');
  writeFileSync(join(clone, '.gitignore'), '.foreman/\n');
  mkdirSync(join(clone, 'stories'));
  for (const [id, order, status] of stories) writeFileSync(join(clone, 'stories', `${id}.md`), STORY(id, order, status));
  git(clone, 'add', '.');
  git(clone, 'commit', '-qm', 'Add the stories');
  git(clone, 'push', '-q', 'origin', 'main');
  for (const [id, , status] of stories) if (status === 'in-progress') git(clone, 'branch', `story/${id.toLowerCase()}`, 'origin/main');
  git(clone, 'worktree', 'add', '--detach', join(clone, '.foreman', 'worktrees', 'w1'), 'origin/main');
  const state = join(clone, '.foreman');
  const bin = join(repos.base, 'bin');
  mkdirSync(bin);
  for (const [name, text] of [['claude', claudeText], ['gh', FAKE_GH]]) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  const claudeLog = join(repos.base, 'claude.log');
  writeFileSync(claudeLog, '');

  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: repos.base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(env)) if (/^(FOREMAN|FACTORY)_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key)) delete env[key];
  Object.assign(env, fastTick, { FAKE_CLAUDE_LOG: claudeLog });
  return { clone, state, base: repos.base, env, claudeLog };
}

const lines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean);

describe('foreman run N with stories left in hand', () => {
  it('resumes them on top of the one asked for, and says so at the start and at the stop', () => {
    const { clone, state, env, claudeLog } = project([['ACME-1', 1, 'in-progress'], ['ACME-2', 2, 'in-progress'], ['ACME-3', 3, 'in-progress'], ['ACME-4', 5], ['ACME-5', 6]], FAKE_CLAUDE);
    env.FAKE_FOREMAN_BIN = BIN;
    const r = runForeman(['run', '--foreground', '--exit-when-idle', '--workers', '1', '1'], { cwd: clone, env, encoding: 'utf8', timeout: 100_000 });

    const texts = lines(join(state, 'events.jsonl')).map((l) => JSON.parse(l).text);
    const why = `${texts.join('\n')}\n${r.stdout}\n${r.stderr}`;
    expect(r.status, why).toBe(0);
    expect(lines(claudeLog).sort(), why).toEqual(['ACME-1', 'ACME-2', 'ACME-3', 'ACME-4']);
    const start = '3 stories left in hand are resumed first, on top of the 1 asked for: they do not count towards it.';
    expect(r.stdout).toContain(start);
    expect(r.stdout.indexOf(start)).toBeLessThan(r.stdout.indexOf('Reached'));
    expect(texts).toContain(start);
    expect(r.stdout).toContain('Reached the 1 story asked for; 3 resumed stories also shipped.');
    expect(JSON.parse(readFileSync(join(state, 'state.json'), 'utf8')).asked).toBeNull();
  }, 120_000);

  it('keeps counting the resumed stories that ship across a restart onto new code', () => {
    const { clone, state, base, env, claudeLog } = project([['ACME-1', 1, 'in-progress'], ['ACME-2', 2, 'in-progress'], ['ACME-3', 5], ['ACME-4', 6]], FAKE_CLAUDE_RESTART);
    // A copy of the plugin in a git repo of its own, which the second session commits to.
    const plug = join(base, 'plug');
    cpSync(fileURLToPath(new URL('../../', import.meta.url)), plug, { recursive: true, filter: (src) => !src.endsWith('.test.mjs') });
    git(base, 'init', '-q', '-b', 'main', plug);
    git(plug, 'add', '-A');
    git(plug, 'commit', '-qm', 'The plugin');
    Object.assign(env, { FAKE_FOREMAN_BIN: join(plug, 'bin', 'foreman'), FAKE_PLUG: plug });
    const r = runForeman(['run', '--foreground', '--exit-when-idle', '--workers', '1', '1'], { cwd: clone, env, encoding: 'utf8', bin: join(plug, 'bin', 'foreman'), stateDir: state, timeout: slow(100_000) });

    const texts = lines(join(state, 'events.jsonl')).map((l) => JSON.parse(l).text);
    const why = `${texts.join('\n')}\n${r.stdout}\n${r.stderr}`;
    expect(r.status, why).toBe(0);
    expect(lines(claudeLog).sort(), why).toEqual(['ACME-1', 'ACME-2', 'ACME-3']);
    expect(texts.filter((t) => /^Restarted on new code \([0-9a-f]+ -> [0-9a-f]+\)\.$/.test(t)), why).toHaveLength(1);
    // The process started on the new code must not say it again.
    const start = '2 stories left in hand are resumed first, on top of the 1 asked for: they do not count towards it.';
    expect(texts.filter((t) => t === start), why).toHaveLength(1);
    expect(r.stdout, why).toContain('Reached the 1 story asked for; 2 resumed stories also shipped.');
    expect(JSON.parse(readFileSync(join(state, 'state.json'), 'utf8')).restart, why).toBeNull();
  }, slow(120_000));
});
