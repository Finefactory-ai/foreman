// A two-story run end to end, for follow-up proposals: ACME-1 ships with a minor finding, and the
// ACME-2 session, still building, already finds ACME-1's follow-up proposal in learn.json. Before
// this, `foreman learn` ran only on standby and when the run stopped, so the proposal came too
// late for any story still being built. A fake `claude` plays both sessions.

import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, makeRepos } from '../../../test/state-repos.mjs';
import { fastTick } from '../../../test/fast-tick.mjs';
import { runForeman, useSupervisors } from '../../../test/supervisors.mjs';

const BIN = fileURLToPath(new URL('../../bin/foreman', import.meta.url));

// ACME-1 appends one minor finding and ships. ACME-2 polls learn.json (up to 15 s) for a proposal
// keyed `followup:ACME-1:` and logs whether it saw one, then ships.
const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const id = process.env.FOREMAN_STORY;
const nap = (n) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, n);
if (id === 'ACME-1') {
  appendFileSync(process.env.FAKE_FINDINGS, JSON.stringify({ at: new Date().toISOString(), story: id, result: 'shipped', builder: 'developer', stage: 'reviewer', severity: 'minor', rule: 'Acme route lacks a test', where: 'src/routes.mjs:3', round: 0, resolved: false }) + '\\n');
}
if (id === 'ACME-2') {
  const ledger = join(process.env.FAKE_STATE_DIR, 'learn.json');
  const saw = () => {
    try {
      return Object.keys(JSON.parse(readFileSync(ledger, 'utf8')).proposed || {}).some((k) => k.startsWith('followup:ACME-1:'));
    } catch {
      return false;
    }
  };
  for (let waited = 0; waited < 15000 && !saw(); waited += 100) nap(100);
  appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ story: id, saw: saw() }) + '\\n');
} else {
  appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ story: id }) + '\\n');
}
const foreman = (...args) => spawnSync(process.execPath, [process.env.FAKE_FOREMAN_BIN, ...args], { stdio: 'ignore' }).status;
if (foreman('story', 'start', id) !== 0 || foreman('story', 'done', id, '--note', 'shipped by the fake session') !== 0) process.exit(1);
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, result: 'FACTORY_RESULT: shipped ' + id, total_cost_usd: 0, session_id: 'fake' }));
`;

const FAKE_GH = `#!/bin/sh
case "$1 $2" in
  "pr list") echo "[]" ;;
  *) exit 1 ;;
esac
`;

const CONFIG = { version: 1, project: { name: 'Acme' }, console: { adapter: 'files' }, features: { keepAwake: false }, env: { adapter: 'none' }, ship: { steps: ['push'] }, slots: 1, learning: { auto: false } };
const story = (id) => `---\nid: ${id}\ntitle: Story ${id}\nstatus: todo\ndepends_on: []\n---\n\nDo ${id}.\n\n## Progress notes\n`;

let repos;

afterEach(() => repos?.cleanup());
// After the hook above, so it runs before it (vitest runs afterEach hooks last first).
useSupervisors();

describe('a run with follow-ups', () => {
  it('proposes the follow-ups of a shipped story while the next story is still building', () => {
    repos = makeRepos(CONFIG);
    const clone = repos.clone('acme');
    writeFileSync(join(clone, '.gitignore'), '.foreman/\n');
    mkdirSync(join(clone, 'stories'));
    for (const id of ['ACME-1', 'ACME-2']) writeFileSync(join(clone, 'stories', `${id}.md`), story(id));
    git(clone, 'add', '.');
    git(clone, 'commit', '-qm', 'Add ACME-1 and ACME-2');
    git(clone, 'push', '-q', 'origin', 'main');
    const stateDir = join(clone, '.foreman');
    mkdirSync(stateDir, { recursive: true });
    const bin = join(repos.base, 'bin');
    mkdirSync(bin);
    for (const [name, text] of [['claude', FAKE_CLAUDE], ['gh', FAKE_GH]]) {
      writeFileSync(join(bin, name), text);
      chmodSync(join(bin, name), 0o755);
    }
    const log = join(repos.base, 'claude.log');
    const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, HOME: repos.base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    for (const key of Object.keys(env)) if (/^(FOREMAN|FACTORY)_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key)) delete env[key];
    Object.assign(env, fastTick, { FAKE_CLAUDE_LOG: log, FAKE_FOREMAN_BIN: BIN, FAKE_FINDINGS: join(stateDir, 'findings.jsonl'), FAKE_STATE_DIR: stateDir });

    const r = runForeman(['run', '--foreground', '2'], { cwd: clone, env, encoding: 'utf8', timeout: 55_000 });
    const lines = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    expect(lines.map((l) => l.story), `${r.stdout}\n${r.stderr}`).toEqual(['ACME-1', 'ACME-2']);
    expect(lines[1]).toEqual({ story: 'ACME-2', saw: true });
    const ledger = JSON.parse(readFileSync(join(stateDir, 'learn.json'), 'utf8'));
    expect(Object.keys(ledger.proposed).filter((k) => k.startsWith('followup:ACME-1:'))).toHaveLength(1);
  }, 90_000);
});
