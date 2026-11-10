// A supervisor run end to end, for the check runs a session starts with `foreman checks --start`:
// they run detached, outside the session's process group, so the supervisor ends the ones a
// session leaves running when it ends, and at start the ones of sessions that had ended before.
// A fake `claude` (and `gh`) on the PATH stand in for the session and GitHub.

import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, makeRepos } from '../../../test/state-repos.mjs';
import { fastTick } from '../../../test/fast-tick.mjs';
import { runForeman, useSupervisors } from '../../../test/supervisors.mjs';
import { writeJob } from './check-jobs.mjs';

const BIN = fileURLToPath(new URL('../../bin/foreman', import.meta.url));
const PR = 'https://example.com/acme/pull/1';

// The session starts the checks, reads the run's pid from its job file, logs it and ships.
const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const id = process.env.FOREMAN_STORY;
const foreman = (...args) => spawnSync(process.execPath, [process.env.FAKE_FOREMAN_BIN, ...args], { encoding: 'utf8' });
const started = foreman('checks', '--start');
const runId = /started the checks as (\\S+);/.exec(started.stdout)?.[1];
const pid = runId ? JSON.parse(readFileSync(process.env.FOREMAN_STATE_DIR + '/check-jobs/' + runId + '.json', 'utf8')).pid : null;
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ story: id, runId, pid, out: started.stdout, err: started.stderr }) + '\\n');
if (foreman('story', 'start', id).status !== 0 || foreman('story', 'done', id, '--note', 'shipped by the fake session').status !== 0) process.exit(1);
foreman('story', 'end', 'shipped', '${PR}', 'ok');
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, result: 'Shipped.\\nFACTORY_RESULT: shipped ' + id, total_cost_usd: 0, session_id: 'fake' }));
`;

const FAKE_GH = `#!/bin/sh
case "$1 $2" in
  "pr list") echo "[]" ;;
  *) exit 1 ;;
esac
`;

const CONFIG = {
  version: 1,
  project: { name: 'Acme' },
  console: { adapter: 'files' },
  features: { keepAwake: false },
  env: { adapter: 'none' },
  ship: { steps: ['push'] },
  checks: [{ run: 'sleep 60', when: 'always' }],
};

let repos;
let stale;

afterEach(() => {
  if (stale?.pid) {
    try {
      process.kill(-stale.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  repos?.cleanup();
});
useSupervisors();

const gone = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

async function until(done, ms = 15_000) {
  for (let waited = 0; waited < ms && !done(); waited += 200) await new Promise((r) => setTimeout(r, 200));
  return done();
}

describe('the supervisor and the check runs a session leaves running', () => {
  it('ends the run its session left and the stale run of a slot that had ended', async () => {
    repos = makeRepos(CONFIG);
    const clone = repos.clone('acme');
    writeFileSync(join(clone, '.gitignore'), '.foreman/\n');
    mkdirSync(join(clone, 'stories'));
    writeFileSync(join(clone, 'stories', 'ACME-1.md'), '---\nid: ACME-1\ntitle: Story ACME-1\nstatus: todo\ndepends_on: []\n---\n\nDo ACME-1.\n\n## Progress notes\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-qm', 'Add the story');
    git(clone, 'push', '-q', 'origin', 'main');
    const stateDir = join(clone, '.foreman');
    mkdirSync(stateDir, { recursive: true });
    const bin = join(repos.base, 'bin');
    mkdirSync(bin);
    for (const [name, text] of [['claude', FAKE_CLAUDE], ['gh', FAKE_GH]]) {
      writeFileSync(join(bin, name), text);
      chmodSync(join(bin, name), 0o755);
    }
    const claudeLog = join(repos.base, 'claude.log');

    // A run of a slot that is not running, left by a supervisor that died.
    // (Its command line names the worker, as the real one's does: a pid is not signalled otherwise.)
    stale = spawn('sh', ['-c', 'sleep 60; sleep 60', 'check-job.mjs', 'w2-old-aaaaaa'], { detached: true, stdio: 'ignore' });
    stale.unref();
    writeJob(stateDir, { id: 'w2-old-aaaaaa', pid: stale.pid, slot: 'w2', story: 'ACME-0', cwd: clone, args: [], startedAt: new Date().toISOString() });

    const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, HOME: repos.base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    for (const key of Object.keys(env)) if (/^(FOREMAN|FACTORY)_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key)) delete env[key];
    Object.assign(env, fastTick, { FAKE_CLAUDE_LOG: claudeLog, FAKE_FOREMAN_BIN: BIN });
    const r = runForeman(['run', '--foreground', '1'], { cwd: clone, env, encoding: 'utf8', timeout: 55_000 });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);

    const logged = readFileSync(claudeLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(logged, out).toHaveLength(1);
    expect(logged[0].pid, logged[0].err).toBeGreaterThan(1);
    expect(await until(() => gone(logged[0].pid) && gone(stale.pid))).toBe(true);
    const jobs = join(stateDir, 'check-jobs');
    expect(existsSync(jobs) ? readdirSync(jobs) : []).toEqual([]);
    const events = readFileSync(join(stateDir, 'events.jsonl'), 'utf8');
    expect(events).toContain('its session left running');
    expect(events).toContain('left running by sessions that had ended');
  }, 90_000);
});
