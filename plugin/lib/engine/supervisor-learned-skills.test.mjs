// `foreman run 1` end to end, for learned skills: with one learned developer skill in force, the
// slot worktree the session starts in holds the skill under .claude/skills, git status there is
// empty, and the build prompt the pipeline makes from that session's `foreman workflow-args`
// lists the skill. With `learning.apply` off the slot has no learned skill and the args none. A
// fake `claude`, running in the slot worktree, logs what it sees.

import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, makeRepos } from '../../../test/state-repos.mjs';
import { runWorkflow } from '../../../test/workflow-harness.mjs';
import { addItem } from './learning-store.mjs';
import { fastTick } from '../../../test/fast-tick.mjs';
import { runForeman, useSupervisors } from '../../../test/supervisors.mjs';

const BIN = fileURLToPath(new URL('../../bin/foreman', import.meta.url));
const NAME = 'foreman-learned-acme-routes';
const SKILL = `---\nname: ${NAME}\ndescription: Use when adding an Acme route\n---\n## Steps\n...\n`;

const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync, existsSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const id = process.env.FOREMAN_STORY;
const status = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
const args = spawnSync(process.execPath, [process.env.FAKE_FOREMAN_BIN, 'workflow-args', id], { encoding: 'utf8' });
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({
  cwd: process.cwd(),
  skill: existsSync('.claude/skills/${NAME}/SKILL.md'),
  status: status.status === 0 ? status.stdout : 'git status failed: ' + status.stderr,
  args: args.stdout,
  argsErr: args.stderr,
}) + '\\n');
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, result: 'Promote it later.\\nFACTORY_RESULT: ready-to-promote ' + id, total_cost_usd: 0, session_id: 'fake' }));
`;

const FAKE_GH = `#!/bin/sh
case "$1 $2" in
  "pr list") echo "[]" ;;
  *) exit 1 ;;
esac
`;

const CONFIG = { version: 1, project: { name: 'Acme' }, console: { adapter: 'files' }, features: { keepAwake: false }, learning: { auto: false }, env: { adapter: 'none' }, ship: { steps: ['push'] } };
const story = `---\nid: ACME-1\ntitle: Story ACME-1\nstatus: todo\ndepends_on: []\n---\n\nDo ACME-1.\n\n## Progress notes\n`;

let repos;
let clone;
let bin;
let claudeLog;

function setup({ settings } = {}) {
  repos = makeRepos(CONFIG);
  clone = repos.clone('acme');
  writeFileSync(join(clone, '.gitignore'), '.foreman/\n');
  mkdirSync(join(clone, 'stories'));
  writeFileSync(join(clone, 'stories', 'ACME-1.md'), story);
  git(clone, 'add', '.');
  git(clone, 'commit', '-qm', 'Add ACME-1');
  git(clone, 'push', '-q', 'origin', 'main');
  const stateDir = join(clone, '.foreman');
  expect(addItem(stateDir, { kind: 'skill', roles: ['developer'], slug: 'acme-routes', text: SKILL }).ok).toBe(true);
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
  return { ...env, FAKE_CLAUDE_LOG: claudeLog, FAKE_FOREMAN_BIN: BIN };
};

const runOnce = () => runForeman(['run', '--foreground', '1'], { cwd: clone, env: runEnv(), encoding: 'utf8', timeout: 55_000 });
const sessions = () => (existsSync(claudeLog) ? readFileSync(claudeLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// The pipeline's build prompt for the logged workflow args.
async function buildPrompt(argsLine) {
  const BUILT = { complete: true, summary: 'Built it.', files: [], commands: [], problem: '' };
  const OK = { approved: true, findings: [], checked: 'ran it' };
  const PLAN = { ready: true, blocker: '', needs_owner: false, builder: 'developer', resources: [], design: 'd', test_plan: 't', done_when: 'w' };
  const { calls } = await runWorkflow(JSON.parse(argsLine), { 'architect:': PLAN, 'build:': BUILT, 'fix:': BUILT, 'test:': OK, 'compliance:': OK, 'security:': OK });
  return calls.find((c) => c.label === 'build:ACME-1').prompt;
}

describe('foreman run with a learned skill', () => {
  it('starts the session in a slot holding the skill, git status empty, and the build prompt lists it', async () => {
    setup();
    const r = runOnce();
    const [s] = sessions();
    expect(s, r.stderr).toBeDefined();
    expect(s.skill).toBe(true);
    expect(s.status).toBe('');
    expect(s.args, s.argsErr).toBeTruthy();
    const args = JSON.parse(s.args);
    expect(args.skills.developer.map((k) => k.name)).toEqual([NAME]);
    const prompt = await buildPrompt(s.args);
    const at = prompt.indexOf('## Learned skills');
    expect(at).toBeGreaterThan(-1);
    expect(prompt.slice(at)).toContain(`- ${NAME} [L-1]: Use when adding an Acme route`);
  }, 60_000);

  it('leaves the skill out of the slot and the args once learning.apply is off', async () => {
    setup({ settings: { 'learning.apply': false } });
    const r = runOnce();
    const [s] = sessions();
    expect(s, r.stderr).toBeDefined();
    expect(s.skill).toBe(false);
    expect(s.status).toBe('');
    const args = JSON.parse(s.args);
    expect(args.skills).toEqual({});
    expect(await buildPrompt(s.args)).not.toContain('## Learned skills');
  }, 60_000);
});
