// A real supervisor run, end to end, for a committed story whose session dies on a rate limit
// (HTTP 429). The slot is held "until the API is back (retry at HH:MM)", with the story's claim
// kept. Once the backoff ends the run releases it, queues the story and starts a session again
// with no command from the owner, and the story ships. A fake `claude` (and `gh`) on the PATH
// stand in for the sessions and GitHub. FOREMAN_BACKOFF_MS shortens the 15-minute backoff.
// state.json's apiWait shows step 1 while the slot is held and is null once the run has exited.
// With a long backoff, `foreman slot w1 resume` idles the held slot at once with "resumed from the
// command centre." and queues the story; it ships after the backoff, with no "wait is over" event.

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

// The first ACME-1 session commits, then dies on a 429 with no result line. The second one ships.
const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const id = process.env.FOREMAN_STORY;
const before = readFileSync(process.env.FAKE_CLAUDE_LOG, 'utf8').split('\\n').filter((l) => l === id).length;
appendFileSync(process.env.FAKE_CLAUDE_LOG, id + '\\n');
const foreman = (...args) => spawnSync(process.execPath, [process.env.FAKE_FOREMAN_BIN, ...args], { stdio: 'ignore' }).status;
foreman('story', 'start', id);
if (before === 0) {
  foreman('stage', 'commit');
  const said = 'API Error: 429 rate_limit_error: Rate limit reached';
  console.log(JSON.stringify({ type: 'assistant', message: { id: 'msg_err', type: 'message', role: 'assistant', content: [{ type: 'text', text: said }] }, parent_tool_use_id: null, error: 'rate_limit', session_id: 'fake' }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, api_error_status: 429, duration_ms: 1000, num_turns: 2, result: said, stop_reason: null, session_id: 'fake', total_cost_usd: 0 }));
  process.exit(1);
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
  writeFileSync(join(clone, 'stories', 'ACME-1.md'), STORY('ACME-1'));
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

const runEnv = (backoffMs = stretchByLoad(4000)) => {
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: repos.base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(env)) if (/^(FOREMAN|FACTORY)_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key)) delete env[key];
  return { ...env, ...fastTick, FAKE_CLAUDE_LOG: log, FAKE_FOREMAN_BIN: BIN, FOREMAN_BACKOFF_MS: String(Math.round(backoffMs)) };
};

const foreman = (...args) => runForeman(args, { cwd: clone, env: runEnv() });
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

describe('a committed story held for the Claude API', () => {
  it('resumes after the backoff with no command, and ships', async () => {
    setup();
    const child = startForeman(['run', '--foreground', '--exit-when-idle', '--workers', '1'], { cwd: clone, env: runEnv() });
    const slotFile = join(state, 'slots', 'w1.json');
    let held;
    let wait;
    await waitFor(
      'w1 to be held for the API and state.json to show its apiWait',
      () => {
        const slot = readJson(slotFile);
        held = slot;
        wait = readJson(join(state, 'state.json'))?.apiWait;
        return slot?.state === 'held' && slot.heldFor === 'api' && /^held until the API is back \(retry at \d\d:\d\d\)$/.test(slot.reason) && wait?.step === 1;
      },
      RUN_MS,
      child,
    );
    expect(wait, why()).toMatchObject({ step: 1 });
    expect(Number.isFinite(Date.parse(wait.since)), why()).toBe(true);
    expect(Number.isFinite(Date.parse(wait.until)), why()).toBe(true);
    expect(Date.parse(wait.until), why()).toBeGreaterThan(Date.parse(held.since));
    expect(Date.parse(wait.until), why()).toBeGreaterThan(Date.parse(wait.since));
    expect(existsSync(join(state, 'claims', 'ACME-1.json'))).toBe(true);

    expect(await child.exited, why()).toBe(0);
    expect(readJson(join(state, 'state.json'))?.apiWait, why()).toBeNull();

    expect(calls(), why()).toEqual(['ACME-1', 'ACME-1']);
    const events = feed();
    expect(events.map((e) => e.text), why()).toContain('ACME-1: the Claude API wait is over; carrying on from where it stopped.');
    expect(events.some((e) => e.kind === 'warn' && e.text.startsWith('The Claude API is limited or down; waiting')), why()).toBe(true);
    expect(readJson(join(state, 'stories', 'ACME-1.json'))?.status, why()).toBe('done');
    expect(existsSync(join(state, 'claims')) ? readdirSync(join(state, 'claims')).filter((f) => f.endsWith('.json')) : []).toEqual([]);
    const outbox = join(state, 'outbox');
    const stuck = existsSync(outbox) ? readdirSync(outbox).filter((f) => /-(paused|parked|noresult)\.json$/.test(f)) : [];
    expect(stuck).toEqual([]);
    expect(readJson(slotFile)?.state).toBe('idle');
  }, TEST_MS);

  it('Resume in the command centre queues it before the backoff ends, and it ships once the backoff is over', async () => {
    setup();
    const LONG = stretchByLoad(20_000);
    const child = startForeman(['run', '--foreground', '--exit-when-idle', '--workers', '1'], { cwd: clone, env: runEnv(LONG) });
    const slotFile = join(state, 'slots', 'w1.json');
    const resumed = 'ACME-1: resumed from the command centre.';
    let wait;
    await waitFor(
      'w1 to be held for the API and state.json to show its apiWait',
      () => {
        const slot = readJson(slotFile);
        wait = readJson(join(state, 'state.json'))?.apiWait;
        return slot?.state === 'held' && slot.heldFor === 'api' && /^held until the API is back \(retry at \d\d:\d\d\)$/.test(slot.reason) && wait?.step === 1;
      },
      RUN_MS,
      child,
    );

    const r = foreman('slot', 'w1', 'resume');
    expect(r.status, why(r)).toBe(0);
    await waitFor('w1 to idle with the resume event', () => readJson(slotFile)?.state === 'idle' && feed().some((e) => e.text === resumed), stretchByLoad(20_000), child);
    expect(calls(), why()).toEqual(['ACME-1']);
    expect(Date.now(), 'Resume acted before the backoff ended').toBeLessThan(Date.parse(wait.until));
    const slot = readJson(slotFile);
    expect(slot.heldFor, why()).toBeNull();
    expect(slot.reason, why()).toBe('');
    expect(existsSync(join(state, 'claims', 'ACME-1.json'))).toBe(true);

    expect(await child.exited, why()).toBe(0);
    expect(calls(), why()).toEqual(['ACME-1', 'ACME-1']);
    expect(readJson(join(state, 'stories', 'ACME-1.json'))?.status, why()).toBe('done');
    const texts = feed().map((e) => e.text);
    expect(texts.filter((t) => t === resumed), why()).toHaveLength(1);
    expect(texts, why()).not.toContain('ACME-1: the Claude API wait is over; carrying on from where it stopped.');
    expect(existsSync(join(state, 'claims')) ? readdirSync(join(state, 'claims')).filter((f) => f.endsWith('.json')) : []).toEqual([]);
    expect(readJson(slotFile)?.state).toBe('idle');
    expect(readJson(join(state, 'state.json'))?.apiWait, why()).toBeNull();
  }, RUN_MS + stretchByLoad(20_000) + 20_000);
});
