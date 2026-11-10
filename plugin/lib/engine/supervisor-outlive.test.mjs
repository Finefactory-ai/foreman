// `foreman run 1` end to end, with a session that prints its final result and then never exits,
// the way `claude -p` can stay up while a tool server it started never closes. The supervisor
// ends the session's process group once watchdog.outliveMinutes have passed since that result,
// logs one warn event, and the story ends with the result the session printed. A fake `claude`
// (and `gh`) on the PATH stand in for the session and GitHub; the fake starts `sleep 300` in the
// session's process group (the default spawn), standing in for the tool server.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, makeRepos } from '../../../test/state-repos.mjs';
import { fastTick, TEST_TICK_MS } from '../../../test/fast-tick.mjs';
import { endChild, startForeman, useSupervisors } from '../../../test/supervisors.mjs';

// Starts a child in the session's process group (the default spawn, so killSession's
// process.kill(-pid) reaches it), marks its story blocked in the state overlay, prints the final
// result, then stays up and never exits.
const FAKE_CLAUDE = `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const id = process.env.FOREMAN_STORY;
const state = process.env.FOREMAN_STATE_DIR;
appendFileSync(process.env.FAKE_CLAUDE_LOG, id + '\\n');
const server = spawn('sleep', ['300'], { stdio: 'ignore' });
writeFileSync(process.env.FAKE_SLEEP_PID, String(server.pid));
const stories = join(state, 'stories');
mkdirSync(stories, { recursive: true });
writeFileSync(join(stories, id + '.json'), JSON.stringify({ id, status: 'blocked', blockedBy: 'Fake session', fields: {}, notes: [] }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, result: 'Could not get further.\\nFACTORY_RESULT: blocked ' + id, total_cost_usd: 0, session_id: 'fake' }));
setInterval(() => {}, 1000);
`;

// The skill's order: its own `foreman story end` first, the final result a little later (2 ticks),
// then it stays up on the tool server. Ended-alive must not pre-empt the outlive rule.
const FAKE_CLAUDE_ENDS_FIRST = `#!/usr/bin/env node
const { spawn, spawnSync } = require('node:child_process');
const { appendFileSync, writeFileSync } = require('node:fs');
const id = process.env.FOREMAN_STORY;
appendFileSync(process.env.FAKE_CLAUDE_LOG, id + '\\n');
const foreman = (...args) => spawnSync(process.execPath, [process.env.FAKE_FOREMAN_BIN, ...args], { stdio: 'ignore' }).status; // supervisor-guard: not a supervisor
foreman('story', 'start', id);
const server = spawn('sleep', ['300'], { stdio: 'ignore' });
writeFileSync(process.env.FAKE_SLEEP_PID, String(server.pid));
foreman('story', 'block', id, '--reason', 'Fake session');
foreman('story', 'end', 'blocked', '', 'Fake session');
setTimeout(() => {
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, result: 'Could not get further.\\nFACTORY_RESULT: blocked ' + id, total_cost_usd: 0, session_id: 'fake' }));
  setInterval(() => {}, 1000);
}, ${2 * TEST_TICK_MS});
`;

const FAKE_GH = `#!/bin/sh
case "$1 $2" in
  "pr list") echo "[]" ;;
  *) exit 1 ;;
esac
`;

const TODO = '---\nid: ACME-1\ntitle: Story ACME-1\nstatus: todo\ndepends_on: []\n---\n\nDo ACME-1.\n\n## Progress notes\n';

let repos;
let clone;
let bin;
let log;
let sleepPid;

beforeEach(() => {
  repos = makeRepos({ version: 1, project: { name: 'Acme' }, console: { adapter: 'files' }, features: { keepAwake: false }, learning: { auto: false }, watchdog: { outliveMinutes: 0.05 } });
  clone = repos.clone('acme');
  writeFileSync(join(clone, '.gitignore'), '.foreman/\n');
  mkdirSync(join(clone, 'stories'));
  writeFileSync(join(clone, 'stories', 'ACME-1.md'), TODO);
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
  sleepPid = null;
});
afterEach(() => {
  if (sleepPid) {
    try {
      process.kill(sleepPid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  repos.cleanup();
});
// After the hooks above, so it runs before them (vitest runs afterEach hooks last first).
useSupervisors();

const runEnv = (extra) => {
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: repos.base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', FAKE_CLAUDE_LOG: log };
  for (const key of Object.keys(env)) if (/^(FOREMAN|FACTORY)_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key)) delete env[key];
  Object.assign(env, fastTick);
  return { ...env, ...extra };
};

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
};

describe('the supervisor ends a session that outlives its final result', () => {
  it('ends it and its process group with one warn event, and the printed result stands', async () => {
    const state = join(clone, '.foreman');
    const pidFile = join(repos.base, 'sleep.pid');
    const child = startForeman(['run', '--foreground', '1'], { cwd: clone, env: runEnv({ FAKE_SLEEP_PID: pidFile }), stdio: 'ignore' });
    const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    const timer = setTimeout(() => endChild(child), 60_000);
    const code = await exited;
    clearTimeout(timer);

    expect(existsSync(pidFile)).toBe(true);
    sleepPid = Number(readFileSync(pidFile, 'utf8'));
    expect(code).toBe(0);

    const events = readFileSync(join(state, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const ended = events.filter((e) => e.text.startsWith('ACME-1: its session printed its result (blocked)'));
    expect(ended).toHaveLength(1);
    expect(ended[0].kind).toBe('warn');
    expect(ended[0].text).toMatch(/^ACME-1: its session printed its result \(blocked\) \d+ s ago but is still running; ending it\.$/);

    // Its result stands: blocked, not a crash.
    expect(events.some((e) => e.text.includes('the session ended without reporting a result'))).toBe(false);
    const runs = readdirSync(join(state, 'runs')).filter((f) => f.startsWith('ACME-1-') && f.endsWith('.json'));
    expect(runs).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(state, 'runs', runs[0]), 'utf8')).result).toBe('blocked');

    // The child in the session's process group was ended too.
    for (const end = Date.now() + 5000; Date.now() < end && alive(sleepPid); await new Promise((r) => setTimeout(r, 100)));
    expect(() => process.kill(sleepPid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    expect(readFileSync(log, 'utf8').split('\n').filter(Boolean)).toEqual(['ACME-1']);
  }, 90_000);

  it('ends a session that ran its own story end before printing its result as one that printed it', async () => {
    writeFileSync(join(bin, 'claude'), FAKE_CLAUDE_ENDS_FIRST);
    chmodSync(join(bin, 'claude'), 0o755);
    const state = join(clone, '.foreman');
    const pidFile = join(repos.base, 'sleep.pid');
    const foremanBin = fileURLToPath(new URL('../../bin/foreman', import.meta.url));
    const child = startForeman(['run', '--foreground', '1'], { cwd: clone, env: runEnv({ FAKE_SLEEP_PID: pidFile, FAKE_FOREMAN_BIN: foremanBin }), stdio: 'ignore' });
    const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    const timer = setTimeout(() => endChild(child), 60_000);
    const code = await exited;
    clearTimeout(timer);

    expect(existsSync(pidFile)).toBe(true);
    sleepPid = Number(readFileSync(pidFile, 'utf8'));
    expect(code).toBe(0);

    const events = readFileSync(join(state, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const printed = events.filter((e) => e.kind === 'warn' && /^ACME-1: its session printed its result \(blocked\) \d+ s ago but is still running; ending it\.$/.test(e.text));
    expect(printed).toHaveLength(1);
    expect(events.some((e) => e.text.includes('its story ended (blocked)'))).toBe(false);
    expect(events.some((e) => e.text.includes('the session ended without reporting a result'))).toBe(false);

    const runs = readdirSync(join(state, 'runs')).filter((f) => f.startsWith('ACME-1-') && f.endsWith('.json'));
    expect(runs).toHaveLength(1);
    const record = JSON.parse(readFileSync(join(state, 'runs', runs[0]), 'utf8'));
    expect(record.result).toBe('blocked');
    expect(record.watchdog).toBeUndefined();

    expect(JSON.parse(readFileSync(join(state, 'slots', 'w1.json'), 'utf8')).state).toBe('idle');
    for (const end = Date.now() + 5000; Date.now() < end && alive(sleepPid); await new Promise((r) => setTimeout(r, 100)));
    expect(() => process.kill(sleepPid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    expect(readFileSync(log, 'utf8').split('\n').filter(Boolean)).toEqual(['ACME-1']);
  }, 90_000);
});
