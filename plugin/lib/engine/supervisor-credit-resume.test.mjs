// A real supervisor run end to end, when the subscription's usage limit pauses it: the first
// session dies with Claude's own "You've hit your limit · resets <time>" and no result line. The
// run pauses itself and records when to try again (state.json's autoResumeAt, the reset time
// Claude printed). Once that time has come it runs the one-turn probe, and (a) carries on by
// itself, with one good event and no Resume command, when Claude answers, or (b) keeps the pause
// and probes again after FOREMAN_CREDIT_RETRY_MS while the probe fails. A probe never clears the
// owner's own pause. A fake `claude` (and `gh`) on the PATH stand in for the sessions, the probe
// and GitHub: FAKE_LIMITED names a file that says 'ok' or 'limited', and FAKE_PROBE_MS is the
// probe's delay.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, makeRepos } from '../../../test/state-repos.mjs';
import { fastTick, TEST_TICK_MS } from '../../../test/fast-tick.mjs';
import { stretchByLoad } from '../../../test/slow-tests.mjs';
import { endChild, runForeman, startForeman, useSupervisors } from '../../../test/supervisors.mjs';

const RUN_MS = stretchByLoad(90_000);
const TEST_MS = RUN_MS + 30_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// `claude auth status` says logged in. A call with --max-turns is the probe: it logs 'probe',
// takes FAKE_PROBE_MS to answer, and fails while FAKE_LIMITED says 'limited'. Any other call is a
// story session: its story's first one dies on the usage limit (reset time FAKE_RESET), the later
// ones mark the story blocked and say so.
const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
if (args[0] === 'auth') {
  console.log(JSON.stringify({ loggedIn: true }));
  process.exit(0);
}
if (args.includes('--max-turns')) {
  appendFileSync(process.env.FAKE_PROBE_LOG, 'probe\\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_PROBE_MS ?? 500));
  if (readFileSync(process.env.FAKE_LIMITED, 'utf8').trim() === 'limited') {
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, num_turns: 0, duration_ms: 10, total_cost_usd: 0, result: "You've hit your limit", session_id: 'fake' }));
    process.exit(1);
  }
  console.log(JSON.stringify({ type: 'result', is_error: false, result: 'ok' }));
  process.exit(0);
}
const id = process.env.FOREMAN_STORY;
const log = process.env.FAKE_CLAUDE_LOG;
const first = !readFileSync(log, 'utf8').split('\\n').includes(id);
appendFileSync(log, id + '\\n');
if (first) {
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, num_turns: 3, duration_ms: 1000, total_cost_usd: 0, result: "You've hit your limit · resets " + process.env.FAKE_RESET, session_id: 'fake' }));
  process.exit(1);
}
const stories = join(process.env.FOREMAN_STATE_DIR, 'stories');
mkdirSync(stories, { recursive: true });
writeFileSync(join(stories, id + '.json'), JSON.stringify({ id, status: 'blocked', blockedBy: 'Fake session', fields: {}, notes: [] }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, result: 'Could not get further.\\nFACTORY_RESULT: blocked ' + id, total_cost_usd: 0, session_id: 'fake' }));
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
let bin;
let log;
let probes;
let limited;

function setUp(answer) {
  repos = makeRepos({ version: 1, project: { name: 'Acme' }, console: { adapter: 'files' }, features: { keepAwake: false }, learning: { auto: false } });
  clone = repos.clone('acme');
  writeFileSync(join(clone, '.gitignore'), '.foreman/\n.env.foreman\n');
  mkdirSync(join(clone, 'stories'));
  writeFileSync(join(clone, 'stories', 'ACME-1.md'), STORY('ACME-1'));
  git(clone, 'add', '.');
  git(clone, 'commit', '-qm', 'Add the story');
  git(clone, 'push', '-q', 'origin', 'main');
  bin = join(repos.base, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE);
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  chmodSync(join(bin, 'claude'), 0o755);
  chmodSync(join(bin, 'gh'), 0o755);
  log = join(repos.base, 'claude.log');
  probes = join(repos.base, 'probe.log');
  limited = join(repos.base, 'limited');
  writeFileSync(log, '');
  writeFileSync(probes, '');
  writeFileSync(limited, answer);
}

beforeEach(() => {
  repos = null;
});
afterEach(() => repos?.cleanup());
// After the hooks above, so it runs before them (vitest runs afterEach hooks last first).
useSupervisors();

// The reset time as the Console words it, a minute ago: the probe is due as soon as the run pauses.
const minuteAgo = () => `${new Date(Date.now() - 60_000).toISOString().slice(0, 16).replace('T', ' at ')} UTC`;

const runEnv = (extra = {}) => {
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: repos.base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', FAKE_CLAUDE_LOG: log, FAKE_PROBE_LOG: probes, FAKE_LIMITED: limited, FAKE_RESET: minuteAgo() };
  for (const key of Object.keys(env)) {
    if (/^(FOREMAN|FACTORY)_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'].includes(key)) delete env[key];
  }
  return Object.assign(env, fastTick, extra);
};

const state = () => join(clone, '.foreman');
const read = (name) => (existsSync(join(state(), name)) ? readFileSync(join(state(), name), 'utf8') : '');
const json = (name) => {
  try {
    return JSON.parse(read(name) || '{}');
  } catch {
    return {};
  }
};
const saved = () => json('state.json');
const events = () => read('events.jsonl').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const outbox = () => (existsSync(join(state(), 'outbox')) ? readdirSync(join(state(), 'outbox')) : []);
const lines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean);
const sessions = () => lines(log);
const until = async (test, ms = RUN_MS) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (test()) return true;
  return test();
};
const start = (env) => startForeman(['run', '--foreground', '--exit-when-idle', '--workers', '1'], { cwd: clone, env, stdio: 'ignore' });
const finish = async (child) => {
  child.kill('SIGTERM');
  const timer = setTimeout(() => endChild(child), 20_000);
  await child.exited;
  clearTimeout(timer);
};

describe('the supervisor when the usage limit pauses the run', () => {
  it('resumes without a command once the probe answers', async () => {
    setUp('ok');
    const child = start(runEnv());
    const timer = setTimeout(() => endChild(child), RUN_MS);
    try {
      expect(await child.exited).toBe(0);
    } finally {
      clearTimeout(timer);
      await finish(child);
    }

    expect(sessions()).toEqual(['ACME-1', 'ACME-1']);
    expect(lines(probes)).toHaveLength(1);
    expect(events().filter((e) => /^Factory paused/.test(e.text))).toHaveLength(1);
    const again = events().filter((e) => e.text === 'Claude answers again; carrying on after the usage limit.');
    expect(again).toHaveLength(1);
    expect(again[0].kind).toBe('good');
    const paused = outbox().filter((f) => f.endsWith('-paused.json'));
    expect(paused).toHaveLength(1);
    expect(read(join('outbox', paused[0]))).toContain('Foreman tries again at');
    expect(saved().autoPausedAt).toBeFalsy();
    expect(saved().autoResumeAt).toBeFalsy();
    expect(json('control.json').resumeAt).toBeUndefined();
  }, TEST_MS);

  it("keeps the pause and retries while the probe fails, and never clears the owner's pause", async () => {
    setUp('limited');
    const child = start(runEnv({ FOREMAN_CREDIT_RETRY_MS: String(stretchByLoad(2000)) }));
    try {
      expect(await until(() => saved().autoPausedAt)).toBeTruthy();
      const initial = saved().autoResumeAt;
      expect(initial).toBeTruthy();

      // The first probe fails: the pause stays and the next try is a retry interval on.
      expect(await until(() => saved().autoResumeAt && saved().autoResumeAt !== initial)).toBe(true);
      const first = saved().autoResumeAt;
      expect(Date.parse(first)).toBeGreaterThan(Date.parse(initial));

      // And a second probe, later, still failing.
      expect(await until(() => lines(probes).length >= 2)).toBe(true);
      expect(await until(() => saved().autoResumeAt !== first)).toBe(true);
      expect(Date.parse(saved().autoResumeAt)).toBeGreaterThan(Date.parse(first));
      expect(sessions()).toEqual(['ACME-1']);
      expect(saved().autoPausedAt).toBeTruthy();
      expect(events().filter((e) => /Claude answers again/.test(e.text))).toEqual([]);
      expect(outbox().filter((f) => f.endsWith('-paused.json'))).toHaveLength(1);

      const status = runForeman(['status'], { cwd: clone, env: runEnv(), encoding: 'utf8' }).stdout ?? '';
      expect(status).toContain('Foreman tries again at');

      // The owner pauses too; Claude answers again: only Foreman's own pause goes.
      expect(runForeman(['pause'], { cwd: clone, env: runEnv(), encoding: 'utf8' }).status).toBe(0);
      writeFileSync(limited, 'ok');
      expect(await until(() => !saved().autoPausedAt)).toBe(true);
      expect(saved().autoResumeAt).toBeFalsy();
      await sleep(3 * TEST_TICK_MS);
      expect(sessions()).toEqual(['ACME-1']);
      expect(json('control.json').paused).toBe(true);

      // Resume starts the story again.
      expect(runForeman(['resume'], { cwd: clone, env: runEnv(), encoding: 'utf8' }).status).toBe(0);
      const timer = setTimeout(() => endChild(child), RUN_MS);
      expect(await child.exited).toBe(0);
      clearTimeout(timer);
      expect(sessions()).toEqual(['ACME-1', 'ACME-1']);
    } finally {
      await finish(child);
    }
  }, TEST_MS * 2);
});
