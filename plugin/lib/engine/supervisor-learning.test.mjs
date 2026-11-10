// `foreman run 2` end to end, for automatic learning: both stories end with the same blocker
// finding (in other words), so the learning tick the supervisor starts after the second run
// record asks the learner, writes one learned developer trait, one ledger line and one FYI on
// Waiting on you. With `learning.auto` off nothing is learned. With a slow learner, the run ends
// only once the tick has finished. A fake `claude` plays both the story sessions and the
// learner (which it knows by --safe-mode).

import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, makeRepos } from '../../../test/state-repos.mjs';
import { list as listDecisions } from '../console/decisions.mjs';
import { buildWaiting } from '../console/waiting.mjs';
import { kindOf } from './answers.mjs';
import { fastTick, TEST_TICK_MS } from '../../../test/fast-tick.mjs';
import { runForeman, useSupervisors } from '../../../test/supervisors.mjs';

const BIN = fileURLToPath(new URL('../../bin/foreman', import.meta.url));
const TRAIT = { verdict: 'trait', reason: 'Two Acme stories shipped untested routes.', trait: { role: 'developer', text: 'Acme: give every new route a test that fails if it breaks.' }, conflicts: [] };
const NONE = { verdict: 'none', reason: 'one-off', conflicts: [] };
const WORDING = { 'ACME-1': 'Acme routes have a test that fails if they break', 'ACME-2': 'Each Acme route has a test that fails when it breaks' };

// With FAKE_LEARNER_MS the learner is slow: it waits for the supervisor's run record of the last
// story session (ACME-2), written as the supervisor handles that session's end, then sleeps that
// long, so the tick is still running when the supervisor starts to stop.
const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync, existsSync, readdirSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { spawnSync } = require('node:child_process');
const argv = process.argv.slice(2);
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ learner: argv.includes('--safe-mode'), story: process.env.FOREMAN_STORY || null }) + '\\n');
if (argv.includes('--safe-mode')) {
  const prompt = argv[argv.indexOf('-p') + 1] || '';
  const reply = prompt.includes('source: findings') ? ${JSON.stringify(JSON.stringify(TRAIT))} : ${JSON.stringify(JSON.stringify(NONE))};
  const ms = Number(process.env.FAKE_LEARNER_MS) || 0;
  const nap = (n) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, n);
  if (ms) {
    const runs = join(dirname(process.env.FAKE_FINDINGS), 'runs');
    const recorded = () => existsSync(runs) && readdirSync(runs).some((f) => f.startsWith('ACME-2-'));
    for (let waited = 0; waited < 30000 && !recorded(); waited += 100) nap(100);
    nap(ms);
  }
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, result: 'Here it is:\\n' + reply }));
  appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ learner: true, done: true }) + '\\n');
  process.exit(0);
}
const id = process.env.FOREMAN_STORY;
const wording = ${JSON.stringify(WORDING)};
appendFileSync(process.env.FAKE_FINDINGS, JSON.stringify({ at: new Date().toISOString(), story: id, result: 'shipped', builder: 'developer', stage: 'tester', severity: 'blocker', rule: wording[id], where: 'src/routes.mjs:3', round: 0, resolved: true }) + '\\n');
const foreman = (...args) => spawnSync(process.execPath, [process.env.FAKE_FOREMAN_BIN, ...args], { stdio: 'ignore' }).status;
if (foreman('story', 'start', id) !== 0 || foreman('story', 'done', id, '--note', 'shipped by the fake session') !== 0) process.exit(1);
const result = 'FACTORY_RESULT: shipped ' + id;
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, result, total_cost_usd: 0, session_id: 'fake' }));
`;

const FAKE_GH = `#!/bin/sh
case "$1 $2" in
  "pr list") echo "[]" ;;
  *) exit 1 ;;
esac
`;

const CONFIG = { version: 1, project: { name: 'Acme' }, console: { adapter: 'files' }, features: { keepAwake: false }, env: { adapter: 'none' }, ship: { steps: ['push'] } };
const story = (id) => `---\nid: ${id}\ntitle: Story ${id}\nstatus: todo\ndepends_on: []\n---\n\nDo ${id}.\n\n## Progress notes\n`;

let repos;
let clone;
let stateDir;
let bin;
let claudeLog;

function setup({ settings } = {}) {
  repos = makeRepos(CONFIG);
  clone = repos.clone('acme');
  writeFileSync(join(clone, '.gitignore'), '.foreman/\n');
  mkdirSync(join(clone, 'stories'));
  for (const id of ['ACME-1', 'ACME-2']) writeFileSync(join(clone, 'stories', `${id}.md`), story(id));
  git(clone, 'add', '.');
  git(clone, 'commit', '-qm', 'Add ACME-1 and ACME-2');
  git(clone, 'push', '-q', 'origin', 'main');
  stateDir = join(clone, '.foreman');
  mkdirSync(stateDir, { recursive: true });
  if (settings) writeFileSync(join(stateDir, 'settings.json'), JSON.stringify(settings));
  bin = join(repos.base, 'bin');
  mkdirSync(bin);
  for (const [name, text] of [['claude', FAKE_CLAUDE], ['gh', FAKE_GH]]) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  claudeLog = join(repos.base, 'claude.log');
}

afterEach(() => repos?.cleanup());
// After the hooks above, so it runs before them (vitest runs afterEach hooks last first).
useSupervisors();

const runEnv = () => {
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, HOME: repos.base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(env)) if (/^(FOREMAN|FACTORY)_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key)) delete env[key];
  Object.assign(env, fastTick);
  return { ...env, FAKE_CLAUDE_LOG: claudeLog, FAKE_FOREMAN_BIN: BIN, FAKE_FINDINGS: join(clone, '.foreman', 'findings.jsonl') };
};

const runTwo = (extra = {}) => runForeman(['run', '--foreground', '2'], { cwd: clone, env: { ...runEnv(), ...extra }, encoding: 'utf8', timeout: 55_000 });
const sessions = () => (existsSync(claudeLog) ? readFileSync(claudeLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// Waits (at most `ms`) for `done()`, checking every 200 ms.
async function until(done, ms = 20_000) {
  for (let waited = 0; waited < ms && !done(); waited += 200) await new Promise((r) => setTimeout(r, 200));
  return done();
}

describe('foreman run with automatic learning', () => {
  it('learns one developer trait from the blocker both stories ended with, and tells the owner', async () => {
    setup();
    const r = runTwo();
    expect(sessions().filter((s) => !s.learner).map((s) => s.story), r.stderr).toEqual(['ACME-1', 'ACME-2']);
    const settled = await until(() => !existsSync(join(stateDir, 'learning-tick.lock')) && existsSync(join(stateDir, 'learning.jsonl')));
    expect(settled, `${r.stdout}\n${r.stderr}`).toBe(true);
    // The tick wrote its own log, and a tick that worked left no warning and no failure streak.
    expect(readdirSync(join(stateDir, 'logs')).some((n) => /^learning-tick-\d{8}-\d{6}(-\d+)?\.log$/.test(n))).toBe(true);
    expect(readFileSync(join(stateDir, 'events.jsonl'), 'utf8')).not.toContain('The learning tick failed');
    expect(JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8')).learningFailed ?? null).toBeNull();
    const role = readFileSync(join(stateDir, 'learned', 'traits', 'developer.md'), 'utf8');
    expect(role.match(/\[L-\d+\]/g)).toEqual(['[L-1]']);
    const ledger = readFileSync(join(stateDir, 'learning.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ action: 'add', by: 'foreman', id: 'L-1' });
    const items = listDecisions(stateDir);
    const learned = items.filter((i) => kindOf(i) === 'learned');
    expect(learned).toHaveLength(1);
    const waiting = buildWaiting({ decisions: { source: 'files', items } });
    expect(waiting.find((i) => i.id === learned[0].id)?.group).toBe('fyi');
  }, 90_000);

  it('the run waits for a slow learning tick before it ends', () => {
    setup();
    // The loop stops within a test tick of recording ACME-2's run (the 2 stories asked for), and
    // the learner sleeps eight test ticks after that record, so the stop has begun and must wait
    // for the tick, inside its 10 s. No polling after: all of it is there when the run ends.
    const r = runTwo({ FAKE_LEARNER_MS: String(8 * TEST_TICK_MS) });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(sessions().filter((s) => s.done)).toContainEqual({ learner: true, done: true });
    expect(existsSync(join(stateDir, 'learning-tick.lock'))).toBe(false);
    const ledger = readFileSync(join(stateDir, 'learning.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(ledger.filter((l) => l.action === 'add')).toHaveLength(1);
    expect(ledger.find((l) => l.action === 'add')).toMatchObject({ action: 'add', by: 'foreman', id: 'L-1' });
    expect(listDecisions(stateDir).filter((i) => kindOf(i) === 'learned')).toHaveLength(1);
  }, 90_000);

  it('learns nothing with learning.auto off', async () => {
    setup({ settings: { 'learning.auto': false } });
    const r = runTwo();
    expect(sessions().filter((s) => !s.learner).map((s) => s.story), r.stderr).toEqual(['ACME-1', 'ACME-2']);
    expect(sessions().filter((s) => s.learner)).toEqual([]);
    for (const f of ['learning.jsonl', 'learned', 'learner.jsonl']) expect(existsSync(join(stateDir, f)), f).toBe(false);
  }, 90_000);
});
