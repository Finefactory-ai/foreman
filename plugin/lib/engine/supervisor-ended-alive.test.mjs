// A supervisor run end to end, with a session that ends its story with `foreman story end blocked`
// while a workflow it started is still running: it prints no result and keeps reporting task
// progress, so neither the outlive check nor the quiet limit would end it soon. The supervisor
// ends the session's process group once watchdog.outliveMinutes have passed since its own story
// end, logs one warn event, frees the slot and the claim, and the recorded result stands. A fake
// `claude` (and `gh`) on the PATH stand in for the session and GitHub; the fake starts `sleep 300`
// in the session's process group, standing in for the workflow agent.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, makeRepos } from '../../../test/state-repos.mjs';
import { fastTick } from '../../../test/fast-tick.mjs';
import { endChild, startForeman, useSupervisors } from '../../../test/supervisors.mjs';

const FAKE_CLAUDE = `#!/usr/bin/env node
const { spawn, spawnSync } = require('node:child_process');
const { appendFileSync, writeFileSync } = require('node:fs');
const id = process.env.FOREMAN_STORY;
appendFileSync(process.env.FAKE_CLAUDE_LOG, id + '\\n');
const foreman = (...args) => spawnSync(process.execPath, [process.env.FAKE_FOREMAN_BIN, ...args], { stdio: 'ignore' }).status; // supervisor-guard: not a supervisor
foreman('story', 'start', id);
const agent = spawn('sleep', ['300'], { stdio: 'ignore' });
writeFileSync(process.env.FAKE_SLEEP_PID, String(agent.pid));
foreman('story', 'block', id, '--reason', 'Fake session');
foreman('story', 'end', 'blocked', '', 'Fake session');
setInterval(() => console.log(JSON.stringify({ type: 'system', subtype: 'task_progress', task_id: 'wf-1' })), 500);
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

describe('the supervisor ends a session whose story ended while it still runs', () => {
  it('ends a session still running after its story ended, and its stub workflow agent, with one warn event; the slot and the claim are freed and its own result stands', async () => {
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

    for (const end = Date.now() + 5000; Date.now() < end && alive(sleepPid); await new Promise((r) => setTimeout(r, 100)));
    expect(() => process.kill(sleepPid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));

    const events = readFileSync(join(state, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const ended = events.filter((e) => /^ACME-1: its story ended \(blocked\) \d+ s ago, but its session is still running; ending it\.$/.test(e.text));
    expect(ended).toHaveLength(1);
    expect(ended[0].kind).toBe('warn');
    expect(events.some((e) => e.text.includes('the session ended without reporting a result'))).toBe(false);
    expect(events.some((e) => e.text.includes('its story has ended, but its session has had no activity'))).toBe(false);
    expect(events.some((e) => e.text.includes('printed its result'))).toBe(false);

    const runs = readdirSync(join(state, 'runs')).filter((f) => f.startsWith('ACME-1-') && f.endsWith('.json'));
    expect(runs).toHaveLength(1);
    const record = JSON.parse(readFileSync(join(state, 'runs', runs[0]), 'utf8'));
    expect(record.result).toBe('blocked');
    expect(record.watchdog.why).toBe('ended-alive');

    expect(JSON.parse(readFileSync(join(state, 'slots', 'w1.json'), 'utf8')).state).toBe('idle');
    expect(existsSync(join(state, 'claims', 'ACME-1.json'))).toBe(false);
    // onExit let the claim go itself: the claim sweep would warn if it had been left for it.
    expect(events.some((e) => /^ACME-1: let go of its claim/.test(e.text))).toBe(false);
    expect(readFileSync(log, 'utf8').split('\n').filter(Boolean)).toEqual(['ACME-1']);
  }, 90_000);
});
