// A real supervisor run, end to end: a story ends `failed` because the code is not at fault (CI
// never started on its pull request) while two stories depend on it. The supervisor raises one
// decision, "<ID> could not be released", on Waiting on you; standby says which story failed and
// how many it holds up instead of "Nothing waits on you"; and answering "Retry the release" puts
// the story back to todo with the retry note, keeps its branch, and the next session starts as a
// plain `/foreman:story <ID>`. A fake `claude` (and `gh`) on the PATH stand in for the sessions
// and GitHub.
//
// A second run covers a failed ending the story comes back from by itself: a session that claims
// ready-to-promote with no release parked ends failed, but its story stays in progress and the
// picker resumes it. Nothing is asked for it, and a "could not be released" decision left open
// for a story is closed when that story ships.

import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, makeRepos } from '../../../test/state-repos.mjs';
import { fastTick } from '../../../test/fast-tick.mjs';
import { stretchByLoad } from '../../../test/slow-tests.mjs';
import { BIN, runForeman, startForeman, useSupervisors } from '../../../test/supervisors.mjs';
import * as decisions from '../console/decisions.mjs';
import { RELEASE_RETRY_NOTE } from './answers.mjs';

const RUN_MS = stretchByLoad(60_000);
const TEST_MS = 2 * RUN_MS + 30_000;
const PR = 'https://github.com/acme/acme/pull/7';
const REASON = 'CI never started on the pull request; PR left open, code not at fault';

// The first session of ACME-1 ends it failed for a release reason the code did not cause; the
// second only logs its prompt and blocks the story, so it is not picked again.
const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync, existsSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const id = process.env.FOREMAN_STORY;
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
const foreman = (...args) => spawnSync(process.execPath, [process.env.FAKE_FOREMAN_BIN, ...args], { stdio: 'ignore' }).status;
const counter = process.env.FAKE_COUNTER + '.' + id;
const second = existsSync(counter);
writeFileSync(counter, '1');
if (!second) {
  foreman('story', 'start', id);
  foreman('story', 'block', id, '--reason', 'CI never started on the pull request.');
  foreman('story', 'end', 'failed', ${JSON.stringify(PR)}, ${JSON.stringify(REASON)}, '--cause', 'environment');
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, result: 'Failed.\\nFACTORY_RESULT: failed ' + id, total_cost_usd: 0, session_id: 'fake' }));
} else {
  foreman('story', 'block', id, '--reason', 'fake');
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, result: 'Could not get further.\\nFACTORY_RESULT: blocked ' + id, total_cost_usd: 0, session_id: 'fake' }));
}
process.exit(0);
`;

// ACME-1's first session claims ready-to-promote with nothing parked, so the run counts it failed
// (its story stays in progress); every other session ships its story.
const FAKE_CLAUDE_UNPARKED = `#!/usr/bin/env node
const { appendFileSync, existsSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const id = process.env.FOREMAN_STORY;
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
const foreman = (...args) => spawnSync(process.execPath, [process.env.FAKE_FOREMAN_BIN, ...args], { stdio: 'ignore' }).status;
const counter = process.env.FAKE_COUNTER + '.' + id;
const second = existsSync(counter);
writeFileSync(counter, '1');
foreman('story', 'start', id);
if (id === 'ACME-1' && !second) {
  foreman('story', 'end', 'ready-to-promote');
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, result: 'Built.\\nFACTORY_RESULT: ready-to-promote ' + id, total_cost_usd: 0, session_id: 'fake' }));
} else {
  foreman('story', 'done', id, '--note', 'shipped by the fake session');
  foreman('story', 'end', 'shipped', '', 'shipped by the fake session');
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, result: 'Done.\\nFACTORY_RESULT: shipped ' + id, total_cost_usd: 0, session_id: 'fake' }));
}
process.exit(0);
`;

const FAKE_GH = `#!/bin/sh
case "$1 $2" in
  "pr list") echo "[]" ;;
  *) exit 1 ;;
esac
`;

const STORY = (id, extra = '') => `---\nid: ${id}\ntitle: Story ${id}\nstatus: todo\n${extra}---\n\nDo ${id}.\n\n## Progress notes\n`;

let repos;
let clone;
let state;
let bin;
let log;

const CHAIN = [['ACME-1', 'depends_on: []\n'], ['ACME-2', 'depends_on: [ACME-1]\n'], ['ACME-3', 'depends_on: [ACME-1]\n']];

// `claude` is the fake session's text, `stories` the [id, front matter] pairs, and `built`
// whether ACME-1 has a built branch on the remote.
function setup({ claude = FAKE_CLAUDE, stories = CHAIN, built = true } = {}) {
  repos = makeRepos({ version: 1, project: { name: 'Acme' }, console: { adapter: 'files' }, features: { keepAwake: false }, learning: { auto: false } });
  clone = repos.clone('acme');
  writeFileSync(join(clone, '.gitignore'), '.foreman/\n');
  mkdirSync(join(clone, 'stories'));
  for (const [id, extra] of stories) writeFileSync(join(clone, 'stories', `${id}.md`), STORY(id, extra));
  git(clone, 'add', '.');
  git(clone, 'commit', '-qm', 'Add the stories');
  git(clone, 'push', '-q', 'origin', 'main');
  // The built branch the release stopped on, kept for the resume.
  if (built) {
    git(clone, 'checkout', '-q', '-b', 'story/acme-1');
    writeFileSync(join(clone, 'built.txt'), 'built\n');
    git(clone, 'add', 'built.txt');
    git(clone, 'commit', '-qm', 'ACME-1 Story ACME-1');
    git(clone, 'push', '-q', 'origin', 'story/acme-1');
    git(clone, 'checkout', '-q', 'main');
  }
  state = join(clone, '.foreman');
  bin = join(repos.base, 'bin');
  mkdirSync(bin);
  for (const [name, text] of [['claude', claude], ['gh', FAKE_GH]]) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  log = join(repos.base, 'claude.log');
  writeFileSync(log, '');
}
afterEach(() => repos?.cleanup());
// After the hook above, so it runs before it (vitest runs afterEach hooks last first).
useSupervisors();

const runEnv = () => {
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: repos.base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(env)) if (/^(FOREMAN|FACTORY)_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key)) delete env[key];
  return { ...env, ...fastTick, FAKE_CLAUDE_LOG: log, FAKE_FOREMAN_BIN: BIN, FAKE_COUNTER: join(repos.base, 'sessions') };
};

const prompts = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((argv) => argv[argv.indexOf('-p') + 1]);
const feed = () => {
  const file = join(state, 'events.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).text) : [];
};
const loop = () => {
  try {
    return JSON.parse(readFileSync(join(state, 'state.json'), 'utf8')).loop ?? null;
  } catch {
    return null;
  }
};
const pending = () => decisions.pending(state);
const why = () => `loop ${JSON.stringify(loop())}\nevents ${JSON.stringify(feed())}\nprompts ${JSON.stringify(existsSync(log) ? prompts() : [])}\npending ${JSON.stringify(pending())}`;

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

// Every note the story holds: its file when the source writes in place, and its overlay.
function notesOf(id) {
  const parts = [];
  for (const file of [join(clone, 'stories', `${id}.md`), join(state, 'stories', `${id}.json`)]) if (existsSync(file)) parts.push(readFileSync(file, 'utf8'));
  return parts.join('\n').replace(/\\n/g, '\n');
}

describe('a story that ends failed with the code not at fault', () => {
  it('raises one decision, names the story on standby, and Retry the release resumes it from its branch', async () => {
    setup();
    const child = startForeman(['run', '--foreground', '--workers', '1'], { cwd: clone, env: runEnv(), stdio: 'ignore' });
    try {
      await waitFor('standby with a decision', () => loop()?.state === 'standby' && pending().length > 0, RUN_MS, child);
      // Give a second, wrong decision the chance to show up.
      await sleep(1500);

      const items = pending();
      expect(items, why()).toHaveLength(1);
      expect(items[0]).toMatchObject({ story: 'ACME-1', kind: 'decision', title: 'ACME-1 could not be released', options: ['Retry the release', "I'll take it", 'Drop'], recommend: 'Retry the release' });
      expect(items[0].body).toContain(PR);
      expect(feed().some((t) => t === 'ACME-1 failed; asked you what to do with it on Waiting on you.'), why()).toBe(true);

      const status = runForeman(['status'], { cwd: clone, env: runEnv(), encoding: 'utf8', timeout: 30_000 });
      expect(status.stdout).toContain('ACME-1 failed and holds up 2 stories');
      expect(status.stdout).not.toContain('Nothing waits on you');

      // Retry the release: back to todo with the note, resumed as a plain story start.
      decisions.answer(state, items[0].id, { option: 'Retry the release' });
      await waitFor('the second ACME-1 session', () => prompts().length >= 2, RUN_MS, child);
      expect(prompts().at(-1)).toBe('/foreman:story ACME-1');
      expect(feed(), why()).toContain('Applied your answer to "ACME-1 could not be released": Retry the release.');
      expect(decisions.list(state).find((d) => d.id === items[0].id).appliedAt).toBeTruthy();
      expect(notesOf('ACME-1')).toContain(RELEASE_RETRY_NOTE);
      expect(git(clone, 'ls-remote', '--heads', repos.remote, 'story/acme-1')).not.toBe('');
      await waitFor('standby again', () => loop()?.state === 'standby', RUN_MS, child);
      // The second session only blocked the story: nothing more was asked.
      expect(pending().filter((d) => !d.appliedAt && d.title === 'ACME-1 could not be released'), why()).toHaveLength(0);

      expect(runForeman(['stop'], { cwd: clone, env: runEnv(), encoding: 'utf8', timeout: 30_000 }).status).toBe(0);
      expect(await child.exited, why()).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill('SIGTERM');
    }
  }, TEST_MS);
});

describe('a failed story that goes back in line, and a release decision left open when its story ships', () => {
  it('asks nothing for an unparked ready-to-promote claim, and closes the open release decision when the story ships', async () => {
    setup({ claude: FAKE_CLAUDE_UNPARKED, stories: [['ACME-1', 'depends_on: []\n'], ['ACME-2', 'depends_on: []\n']], built: false });
    // A release decision left open for ACME-2; the picker does not skip a story that has one.
    const seeded = decisions.add(state, { story: 'ACME-2', kind: 'decision', title: 'ACME-2 could not be released', options: ['Retry the release', "I'll take it", 'Drop'] });
    const closed = 'ACME-2 shipped; closed "ACME-2 could not be released" on Waiting on you.';
    const child = startForeman(['run', '--foreground', '--workers', '1'], { cwd: clone, env: runEnv(), stdio: 'ignore' });
    try {
      await waitFor('three sessions and the loop at rest', () => prompts().length >= 3 && ['standby', 'idle'].includes(loop()?.state), RUN_MS, child);
      await waitFor('the release decision closed', () => feed().includes(closed), RUN_MS, child);

      const texts = feed();
      expect(texts, why()).toContain('ACME-1 said ready-to-promote, but no release is parked; counted as failed.');
      expect(texts, why()).toContain('ACME-1 failed; its story is in-progress, so nothing was asked on Waiting on you.');
      expect(texts, why()).not.toContain('ACME-1 failed; asked you what to do with it on Waiting on you.');
      expect(decisions.list(state).filter((d) => d.title === 'ACME-1 could not be released'), why()).toHaveLength(0);
      const item = decisions.list(state).find((d) => d.id === seeded);
      expect(item.appliedAt, why()).toBeTruthy();
      expect(item.answer).toBeNull();
      expect(pending().filter((d) => !d.appliedAt && /could not be released/.test(d.title)), why()).toHaveLength(0);
      expect(prompts().filter((p) => p === '/foreman:story ACME-1'), why()).toHaveLength(2);

      expect(runForeman(['stop'], { cwd: clone, env: runEnv(), encoding: 'utf8', timeout: 30_000 }).status).toBe(0);
      expect(await child.exited, why()).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill('SIGTERM');
    }
  }, TEST_MS);
});
