// A real supervisor run, end to end, for stories that fail. A failure the environment caused
// (`foreman story end failed --cause environment`) is not a miss: three in a row back off instead of
// pausing, with one warn event naming them, and the run carries on and exits 0. A failure the
// pipeline caused (cause story, or none) still pauses the run after three in a row. A fake `claude`
// (and `gh`) on the PATH stand in for the sessions and GitHub. FOREMAN_BACKOFF_MS shortens the
// 15-minute base wait.

import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, makeRepos } from '../../../test/state-repos.mjs';
import { fastTick } from '../../../test/fast-tick.mjs';
import { stretchByLoad } from '../../../test/slow-tests.mjs';
import { BIN, endChild, startForeman, useSupervisors } from '../../../test/supervisors.mjs';

const RUN_MS = stretchByLoad(100_000);
const TEST_MS = RUN_MS + 20_000;

// Each session starts its story, blocks it (so it is not picked again), ends it failed with the
// cause FAKE_CAUSES names for it (none: no flag), and prints the failed result line.
const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const id = process.env.FOREMAN_STORY;
appendFileSync(process.env.FAKE_CLAUDE_LOG, id + '\\n');
const foreman = (...args) => spawnSync(process.execPath, [process.env.FAKE_FOREMAN_BIN, ...args], { stdio: 'ignore' }).status;
const cause = JSON.parse(process.env.FAKE_CAUSES || '{}')[id];
foreman('story', 'start', id);
foreman('story', 'block', id, '--reason', 'it failed');
foreman('story', 'end', 'failed', '', 'CI never started on the pull request.', ...(cause ? ['--cause', cause] : []));
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, result: 'Failed.\\nFACTORY_RESULT: failed ' + id, total_cost_usd: 0, session_id: 'fake' }));
process.exit(0);
`;

const FAKE_GH = `#!/bin/sh
case "$1 $2" in
  "pr list") echo "[]" ;;
  *) exit 1 ;;
esac
`;

const STORY = (id) => `---\nid: ${id}\ntitle: Story ${id}\nstatus: todo\ndepends_on: []\n---\n\nDo ${id}.\n\n## Progress notes\n`;

let repos;
let clone;
let state;
let bin;
let log;

function setup() {
  repos = makeRepos({ version: 1, project: { name: 'Acme' }, console: { adapter: 'files' }, features: { keepAwake: false }, learning: { auto: false } });
  clone = repos.clone('acme');
  writeFileSync(join(clone, '.gitignore'), '.foreman/\n');
  mkdirSync(join(clone, 'stories'));
  for (const id of ['ACME-1', 'ACME-2', 'ACME-3']) writeFileSync(join(clone, 'stories', `${id}.md`), STORY(id));
  git(clone, 'add', '.');
  git(clone, 'commit', '-qm', 'Add the story');
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

const runEnv = (causes) => {
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: repos.base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(env)) if (/^(FOREMAN|FACTORY)_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key)) delete env[key];
  return { ...env, ...fastTick, FAKE_CLAUDE_LOG: log, FAKE_FOREMAN_BIN: BIN, FAKE_CAUSES: JSON.stringify(causes), FOREMAN_BACKOFF_MS: String(Math.round(stretchByLoad(2000))) };
};

const calls = () => readFileSync(log, 'utf8').split('\n').filter(Boolean);
const feed = () => {
  const file = join(state, 'events.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
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

const ENV = { 'ACME-1': 'environment', 'ACME-2': 'environment', 'ACME-3': 'environment' };

describe('endings the environment caused', () => {
  it('backs off after three in a row instead of pausing, and the run carries on', async () => {
    setup();
    const child = startForeman(['run', '--foreground', '--exit-when-idle', '--workers', '1'], { cwd: clone, env: runEnv(ENV) });
    expect(await child.exited, why()).toBe(0);
    expect(readJson(join(state, 'state.json'))?.autoPausedAt, why()).toBeFalsy();
    // the stop path clears the environment wait
    expect(readJson(join(state, 'state.json'))?.envWait ?? null, why()).toBeNull();
    const texts = feed().map((e) => e.text);
    const backoffs = feed().filter((e) => e.kind === 'warn' && e.text.startsWith('Three endings in a row were the environment'));
    expect(backoffs, why()).toHaveLength(1);
    expect(backoffs[0].text, why()).toMatch(/^Three endings in a row were the environment, not the stories: ACME-1 failed: CI never started on the pull request; ACME-2 .*; ACME-3 .*\. Waiting \d+ seconds before carrying on\.$/);
    expect(texts.some((t) => /did not ship/.test(t)), why()).toBe(false);
    const runs = readdirSync(join(state, 'runs')).filter((f) => f.endsWith('.json')).map((f) => readJson(join(state, 'runs', f)));
    expect(runs, why()).toHaveLength(3);
    for (const r of runs) expect(r, why()).toMatchObject({ result: 'failed', cause: 'environment' });
  }, TEST_MS);
});

describe('failures the pipeline caused', () => {
  it('pauses after three in a row', async () => {
    setup();
    const child = startForeman(['run', '--foreground', '--workers', '1'], { cwd: clone, env: runEnv({ 'ACME-1': 'story' }), stdio: 'ignore' });
    try {
      await waitFor('the pause', () => readJson(join(state, 'state.json'))?.autoPauseReason === 'Three stories in a row did not ship: ACME-1, ACME-2 and ACME-3.', RUN_MS, child);
      expect(feed().some((e) => e.text.startsWith('Three endings in a row were the environment')), why()).toBe(false);
    } finally {
      child.kill('SIGTERM');
      const timer = setTimeout(() => endChild(child), 20_000);
      await child.exited;
      clearTimeout(timer);
    }
  }, TEST_MS);
});
