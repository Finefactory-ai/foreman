// `foreman run` end to end, when something other than the owner asks it to stop. A fake `claude`
// on the PATH starts a session (an init event with a fixed session id, its transcripts under
// CLAUDE_CONFIG_DIR/projects) and then hangs. While it runs, a stop is recorded as a story
// session checking `foreman stop` would leave it, straight through the control module: the
// running supervisor says who asked, emails the owner at once (outbox/*-unexpected-stop.json),
// and when the run is then interrupted it keeps the hung session's transcripts so the cause can
// be read. `foreman status` then names the session that stopped the run.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, makeRepos } from '../../../test/state-repos.mjs';
import { fastTick } from '../../../test/fast-tick.mjs';
import { endChild, runForeman, startForeman, useSupervisors } from '../../../test/supervisors.mjs';
import * as control from '../console/control.mjs';
import { readStopRecord, stopperOf } from '../console/stopper.mjs';
import { readInterrupt } from './signal-source.mjs';

const SESSION = '7c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5';

const FAKE_CLAUDE = `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const S = '${SESSION}';
const project = join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-tmp-acme');
const put = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: S, model: 'claude-opus-5-5', cwd: process.cwd() }));
put(join(project, S, 'subagents', 'agent-a1.jsonl'), '{"type":"assistant"}\\n');
put(join(project, S + '.jsonl'), '{"type":"system"}\\n');
setInterval(() => {}, 1000);
`;

const FAKE_GH = `#!/bin/sh
case "$1 $2" in
  "pr list") echo "[]" ;;
  *) exit 1 ;;
esac
`;

const PKILL = 'pkill -f "foreman.*run --foreground"';
const STORY = `---\nid: ACME-1\ntitle: Story ACME-1\nstatus: todo\ndepends_on: []\n---\n\nDo ACME-1.\n\n## Progress notes\n`;

let repos;
let clone;
let bin;
let config;

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
  config = join(repos.base, 'claude-config');
  mkdirSync(config);
});
afterEach(() => repos.cleanup());
// After the hooks above, so it runs before them (vitest runs afterEach hooks last first).
useSupervisors();

const runEnv = () => {
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: repos.base, CLAUDE_CONFIG_DIR: config, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(env)) if (/^(FOREMAN|FACTORY)_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key)) delete env[key];
  return { ...env, ...fastTick };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(check, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) if (check()) return true;
  return check();
}

describe('a stop that did not come from the owner', () => {
  it('is named, emailed at once, keeps the interrupted session files, and shows in status', async () => {
    const state = join(clone, '.foreman');
    const events = () => (existsSync(join(state, 'events.jsonl')) ? readFileSync(join(state, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).text) : []);
    const outbox = (kind) => (existsSync(join(state, 'outbox')) ? readdirSync(join(state, 'outbox')).filter((f) => f.endsWith(`-${kind}.json`)) : []);
    const sessionFile = join(config, 'projects', '-tmp-acme', `${SESSION}.jsonl`);
    const sessionDir = join(config, 'projects', '-tmp-acme', SESSION);

    // A stale record from the last run: a fresh start forgets it (FM-284).
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'last-stop'), `${JSON.stringify({ via: 'cloud', at: '2026-10-01T00:00:00.000Z' })}\n`);

    const child = startForeman(['run', '--foreground', '1'], { cwd: clone, env: runEnv(), stateDir: state });
    const exited = child.exited;
    try {
      expect(await until(() => existsSync(sessionFile) && existsSync(join(sessionDir, 'subagents', 'agent-a1.jsonl')), 30_000)).toBe(true);
      expect(existsSync(join(state, 'last-stop'))).toBe(false);

      // The bypass: a story session's stop, written straight to the run's state folder.
      const ps = () => ({ status: 0, stdout: 'node /tmp/acme-check/stop.mjs\n', stderr: '' });
      control.stop(state, new Date(), stopperOf({ via: 'unknown', env: { FOREMAN_RUN: '1', FOREMAN_STORY: 'ACME-9', FOREMAN_SLOT: 'w2' }, cwd: '/tmp/acme-check', sh: ps }));

      expect(await until(() => outbox('unexpected-stop').length === 1, 15_000)).toBe(true);
      const asked = events().find((e) => e.startsWith("Stop requested by ACME-9's session"));
      expect(asked).toMatch(/^Stop requested by ACME-9's session at \d\d:\d\d UTC \(pid \d+, parent "node \/tmp\/acme-check\/stop\.mjs", in \/tmp\/acme-check\): finishing the stories in progress\.$/);
      const mail = JSON.parse(readFileSync(join(state, 'outbox', outbox('unexpected-stop')[0]), 'utf8'));
      expect(mail.subject).toBe('Foreman was asked to stop, not by you');
      expect(mail.text).toContain("ACME-9's session");
      // The supervisor took STOP and kept who asked in last-stop.
      expect(existsSync(join(state, 'STOP'))).toBe(false);
      expect(readStopRecord(join(state, 'last-stop'))).toMatchObject({ story: 'ACME-9', slot: 'w2' });

      // The hung session is interrupted: its files stay for reading. Its builder had just run a
      // pkill, so the run's stop names that session (FM-365).
      const now = new Date().toISOString();
      const agents = join(state, 'slots', 'w1', 'agents');
      mkdirSync(agents, { recursive: true });
      writeFileSync(join(agents, 'b1.json'), JSON.stringify({ id: 'b1', role: 'foreman:builder', story: 'ACME-1', since: now, lastAt: now, tools: 1, raw: PKILL }));
      child.kill('SIGTERM');
      const timer = setTimeout(() => endChild(child), 40_000);
      await exited;
      clearTimeout(timer);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        await endChild(child);
        await exited;
      }
    }
    expect(events()).toContain(`Factory stopped: Interrupted by a signal from ACME-1's session in w1, which had just run \`${PKILL}\`.`);
    expect(readInterrupt(state)).toMatchObject({ story: 'ACME-1', slot: 'w1', command: PKILL });
    expect(existsSync(sessionFile)).toBe(true);
    expect(existsSync(join(sessionDir, 'subagents', 'agent-a1.jsonl'))).toBe(true);
    expect(events().some((e) => e.startsWith('Kept the session files of ACME-1 (it ended in an interrupt): ') && e.includes(SESSION))).toBe(true);

    const status = runForeman(['status'], { cwd: clone, env: runEnv(), stateDir: state, timeout: 30_000 });
    expect(status.stdout).toMatch(/^Foreman: stopped by ACME-9's session at \d\d:\d\d UTC$/m);
  }, 60_000);
});
