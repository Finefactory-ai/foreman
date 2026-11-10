// `foreman run 2` end to end, when the first story's session adds a key to foreman.config.json
// that the loaded validator rejects: the supervisor keeps picking on the last good config, says
// so once (an event, a notification, a Needs-you item in `foreman status`), keeps every story's
// email and the stories on the board meanwhile, and clears it when the run stops. A fake `claude` (and `gh`) on the PATH stand in for the sessions and GitHub.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, makeRepos } from '../../../test/state-repos.mjs';
import { runForeman, useSupervisors } from '../../../test/supervisors.mjs';

const BIN = fileURLToPath(new URL('../../bin/foreman', import.meta.url));

// Every session marks its story blocked in the state overlay and says so. ACME-1's also breaks
// the config; ACME-2's saves what `foreman status` says meanwhile.
const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const id = process.env.FOREMAN_STORY;
appendFileSync(process.env.FAKE_CLAUDE_LOG, id + '\\n');
const stories = join(process.env.FOREMAN_STATE_DIR, 'stories');
mkdirSync(stories, { recursive: true });
writeFileSync(join(stories, id + '.json'), JSON.stringify({ id, status: 'blocked', blockedBy: 'Fake session', fields: {}, notes: [] }));
const project = process.env.FOREMAN_PROJECT_DIR;
if (id === 'ACME-1') {
  const file = join(project, 'foreman.config.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), bogusKey: true }, null, 2));
}
if (id === 'ACME-2') {
  for (const [args, out] of [[['status'], 'status.txt'], [['status', '--json'], 'status.json']]) {
    const r = spawnSync(process.execPath, [process.env.FAKE_BIN, ...args], { cwd: project, encoding: 'utf8' });
    writeFileSync(join(process.env.FAKE_OUT, out), r.stdout ?? '');
  }
}
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
let out;

beforeEach(() => {
  repos = makeRepos({ version: 1, project: { name: 'Acme' }, console: { adapter: 'files' }, features: { keepAwake: false }, learning: { auto: false } });
  clone = repos.clone('acme');
  writeFileSync(join(clone, '.gitignore'), '.foreman/\n');
  mkdirSync(join(clone, 'stories'));
  for (const id of ['ACME-1', 'ACME-2']) writeFileSync(join(clone, 'stories', `${id}.md`), STORY(id));
  git(clone, 'add', '.');
  git(clone, 'commit', '-qm', 'Add the stories');
  git(clone, 'push', '-q', 'origin', 'main');
  bin = join(repos.base, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE);
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  chmodSync(join(bin, 'claude'), 0o755);
  chmodSync(join(bin, 'gh'), 0o755);
  log = join(repos.base, 'claude.log');
  writeFileSync(log, '');
  out = join(repos.base, 'out');
  mkdirSync(out);
});
afterEach(() => repos.cleanup());
// After the hooks above, so it runs before them (vitest runs afterEach hooks last first).
useSupervisors();

// At the real 5 s tick, not fastTick (test/fast-tick.mjs): ACME-1's blocked email then starts
// its `foreman notify` long before the next tick would record the broken config, so the email
// is lost unless notify() records it first. A short tick records it in time and hides that.
const runEnv = () => {
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: repos.base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', FAKE_CLAUDE_LOG: log, FAKE_BIN: BIN, FAKE_OUT: out };
  for (const key of Object.keys(env)) if (/^(FOREMAN|FACTORY)_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key)) delete env[key];
  return env;
};

describe('the supervisor when foreman.config.json turns invalid under it', () => {
  it('keeps picking on the last good config and says so once, on the board and in status', () => {
    const state = join(clone, '.foreman');
    const r = runForeman(['run', '--foreground', '2'], { cwd: clone, env: runEnv(), encoding: 'utf8', timeout: 55_000 });
    expect(r.status).toBe(0);
    expect(readFileSync(log, 'utf8').split('\n').filter(Boolean)).toEqual(['ACME-1', 'ACME-2']);

    const events = readFileSync(join(state, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).text);
    expect(events.filter((t) => /foreman\.config\.json is invalid now \(bogusKey: unknown key\)/.test(t))).toHaveLength(1);
    expect(events.filter((t) => /Supervisor error/.test(t))).toEqual([]);

    expect(readdirSync(join(state, 'outbox')).filter((f) => f.endsWith('-config.json'))).toHaveLength(1);
    // ACME-1's blocked email goes out too, though its session broke the config just before it ended.
    expect(events.filter((t) => /^Could not email you/.test(t))).toEqual([]);
    const blocked = readdirSync(join(state, 'outbox')).filter((f) => f.endsWith('-blocked.json'));
    expect(blocked).toHaveLength(2);
    const subjects = blocked.map((f) => JSON.parse(readFileSync(join(state, 'outbox', f), 'utf8')).subject).sort();
    expect(subjects[0].startsWith('ACME-1 is blocked')).toBe(true);
    expect(subjects[1].startsWith('ACME-2 is blocked')).toBe(true);

    const text = readFileSync(join(out, 'status.txt'), 'utf8');
    expect(text).toContain('foreman.config.json is invalid');
    expect(text).toMatch(/config invalid since \d\d:\d\d: bogusKey: unknown key; running on the last good config/);
    const snap = JSON.parse(readFileSync(join(out, 'status.json'), 'utf8'));
    expect(snap.waiting.items.filter((i) => i.id === 'run:config')).toHaveLength(1);
    // The board keeps the stories, read from the last good config.
    expect(snap.progress.total).toBe(2);

    expect(JSON.parse(readFileSync(join(state, 'state.json'), 'utf8')).configProblem).toBeNull();
  }, 60_000);
});
