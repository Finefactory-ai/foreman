// `foreman run 1` end to end, for the two places the supervisor handles a parked release:
// a session that says ready-to-promote with no park (counted as failed, and the story ended
// when the session never ran `foreman story end`), and a start-up that finds a stale claim on a
// story whose release is parked (the claim is let go, not resumed). A fake `claude` (and `gh`)
// on the PATH stand in for the session and GitHub. A last case preloads a recorder into the
// supervisor to prove the start-up order: the stale ship lock is broken after the parked claims
// and their start-up events.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { git, makeRepos } from '../../../test/state-repos.mjs';
import { fastTick } from '../../../test/fast-tick.mjs';
import { runForeman, useSupervisors } from '../../../test/supervisors.mjs';

const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
const id = process.env.FOREMAN_STORY;
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, result: 'Promote it later.\\nFACTORY_RESULT: ready-to-promote ' + id, total_cost_usd: 0, session_id: 'fake' }));
`;

const FAKE_GH = `#!/bin/sh
case "$1 $2" in
  "pr list") echo "[]" ;;
  *) exit 1 ;;
esac
`;

// Preloaded with --import, it logs each removal of a lock or claim file and each event written
// to events.jsonl, in the order the supervisor makes them. syncBuiltinESMExports() carries the
// patched functions into the named imports of locks.mjs and state.mjs.
const ORDER_RECORDER = `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const out = process.env.ORDER_LOG;
const { rmSync, appendFileSync, existsSync } = fs;
if (out) {
  fs.rmSync = function (p, ...rest) {
    const s = String(p);
    if (/[\\\\/](locks|claims)[\\\\/][^\\\\/]+\\.json$/.test(s) && existsSync(s)) appendFileSync(out, JSON.stringify({ rm: s.split(/[\\\\/]/).slice(-2).join('/') }) + '\\n');
    return rmSync.call(this, p, ...rest);
  };
  fs.appendFileSync = function (p, data, ...rest) {
    if (String(p).endsWith('events.jsonl')) appendFileSync(out, JSON.stringify({ event: JSON.parse(String(data)).text }) + '\\n');
    return appendFileSync.call(this, p, data, ...rest);
  };
  syncBuiltinESMExports();
}
`;

const story = (status) => `---\nid: ACME-1\ntitle: Story ACME-1\nstatus: ${status}\ndepends_on: []\n---\n\nDo ACME-1.\n\n## Progress notes\n`;

let repos;
let clone;
let bin;
let log;

function setup(status) {
  writeFileSync(join(clone, 'stories', 'ACME-1.md'), story(status));
  git(clone, 'add', '.');
  git(clone, 'commit', '-qm', 'Add ACME-1');
  git(clone, 'push', '-q', 'origin', 'main');
}

beforeEach(() => {
  repos = makeRepos({ version: 1, project: { name: 'Acme' }, console: { adapter: 'files' }, features: { keepAwake: false }, learning: { auto: false } });
  clone = repos.clone('acme');
  writeFileSync(join(clone, '.gitignore'), '.foreman/\n');
  mkdirSync(join(clone, 'stories'));
  bin = join(repos.base, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE);
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  chmodSync(join(bin, 'claude'), 0o755);
  chmodSync(join(bin, 'gh'), 0o755);
  log = join(repos.base, 'claude.log');
  writeFileSync(log, '');
});
afterEach(() => repos.cleanup());
// After the hooks above, so it runs before them (vitest runs afterEach hooks last first).
useSupervisors();

const runEnv = () => {
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: repos.base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', FAKE_CLAUDE_LOG: log };
  for (const key of Object.keys(env)) if (/^(FOREMAN|FACTORY)_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key)) delete env[key];
  Object.assign(env, fastTick);
  return env;
};

const runOnce = () => runForeman(['run', '--foreground', '1'], { cwd: clone, env: runEnv(), encoding: 'utf8', timeout: 55_000 });
const calls = () => readFileSync(log, 'utf8').split('\n').filter(Boolean);
const events = () => readFileSync(join(clone, '.foreman', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

describe('a session that says ready-to-promote with no release parked', () => {
  it('is counted as failed, with a warning, and its story is ended', () => {
    setup('todo');
    runOnce();
    expect(calls()).toHaveLength(1);
    const feed = events();
    expect(feed).toContainEqual(expect.objectContaining({ text: 'ACME-1 said ready-to-promote, but no release is parked; counted as failed.', kind: 'warn' }));
    expect(feed.map((e) => e.text)).toContain('ACME-1 failed: claimed ready-to-promote, but no release is parked');
  }, 60_000);
});

describe('a start-up that finds a stale claim on a story whose release is parked', () => {
  it('lets the claim go and does not resume the story', () => {
    setup('ready-to-promote');
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    const claim = join(clone, '.foreman', 'claims', 'ACME-1.json');
    mkdirSync(join(clone, '.foreman', 'claims'), { recursive: true });
    writeFileSync(claim, JSON.stringify({ pid: dead, slot: 'w1', story: 'ACME-1', by: 'factory', at: new Date().toISOString() }));

    runOnce();
    expect(events().map((e) => e.text)).toContain('Start-up: letting go of ACME-1; its release is parked and finishes later.');
    expect(existsSync(claim)).toBe(false);
    expect(calls()).toHaveLength(0);
  }, 60_000);
});

describe('start-up reconciliation, end to end', () => {
  it('breaks the stale ship lock after the parked claims and their start-up events', () => {
    setup('ready-to-promote');
    writeFileSync(join(clone, 'stories', 'ACME-2.md'), story('ready-to-promote').replaceAll('ACME-1', 'ACME-2'));
    git(clone, 'add', '.');
    git(clone, 'commit', '-qm', 'Add ACME-2');
    git(clone, 'push', '-q', 'origin', 'main');

    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    const at = new Date().toISOString();
    mkdirSync(join(clone, '.foreman', 'claims'), { recursive: true });
    mkdirSync(join(clone, '.foreman', 'locks'), { recursive: true });
    const claimOf = (id) => join(clone, '.foreman', 'claims', `${id}.json`);
    for (const id of ['ACME-1', 'ACME-2']) writeFileSync(claimOf(id), JSON.stringify({ pid: dead, slot: 'w1', story: id, by: 'factory', at }));
    const ship = join(clone, '.foreman', 'locks', 'ship.json');
    writeFileSync(ship, JSON.stringify({ pid: dead, slot: 'w1', story: 'ACME-9', by: 'factory', at, stage: 'waiting' }));

    const recorder = join(repos.base, 'record-order.mjs');
    writeFileSync(recorder, ORDER_RECORDER);
    const orderLog = join(repos.base, 'order.log');
    writeFileSync(orderLog, '');
    const env = { ...runEnv(), NODE_OPTIONS: `--import=${pathToFileURL(recorder).href}`, ORDER_LOG: orderLog };
    runForeman(['run', '--foreground', '1'], { cwd: clone, env, encoding: 'utf8', timeout: 55_000 });

    const order = readFileSync(orderLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const pos = (entry) => order.findIndex((o) => JSON.stringify(o) === JSON.stringify(entry));
    const letGo = (id) => ({ event: `Start-up: letting go of ${id}; its release is parked and finishes later.` });

    // (a) the ship lock is broken exactly once
    expect(order.filter((o) => o.rm === 'locks/ship.json')).toHaveLength(1);
    expect(existsSync(ship)).toBe(false);
    // (b) both claims are broken
    expect(order).toContainEqual({ rm: 'claims/ACME-1.json' });
    expect(order).toContainEqual({ rm: 'claims/ACME-2.json' });
    expect(existsSync(claimOf('ACME-1'))).toBe(false);
    expect(existsSync(claimOf('ACME-2'))).toBe(false);
    // (c) both start-up events are written
    expect(order).toContainEqual(letGo('ACME-1'));
    expect(order).toContainEqual(letGo('ACME-2'));
    // (d) the ship lock goes last
    const shipAt = pos({ rm: 'locks/ship.json' });
    for (const entry of [{ rm: 'claims/ACME-1.json' }, { rm: 'claims/ACME-2.json' }, letGo('ACME-1'), letGo('ACME-2')]) expect(shipAt).toBeGreaterThan(pos(entry));
    // (e) each claim is broken just before its event
    expect(pos({ rm: 'claims/ACME-1.json' })).toBeLessThan(pos(letGo('ACME-1')));
    expect(pos({ rm: 'claims/ACME-2.json' })).toBeLessThan(pos(letGo('ACME-2')));
    // (f) the parked stories are not resumed
    expect(calls()).toHaveLength(0);
  }, 60_000);
});
