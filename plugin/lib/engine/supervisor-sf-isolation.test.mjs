// `foreman run 1` end to end, for the Salesforce pack's isolated sf home: with the pack on, the
// story session starts with the sf wrappers first on its PATH, FOREMAN_SF_HOME set and the
// salesforce-development plugin turned off; a home holding an org off the allow-list stops the
// run before any session; and a project without a pack runs without them. Every session is
// lean (session-scope.mjs): project and local settings only, no MCP server it was not given,
// the user's CLAUDE.md and auto memory left out, and the user's model carried over. A fake
// `claude` logs what it was started with, and a fake `sf` on the PATH answers `org list`, so
// no org is contacted.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { git, makeRepos } from '../../../test/state-repos.mjs';
import { ACME_DEV1_ID, ACME_QA_ID, acmeOrg } from '../../../test/fake-sf.mjs';
import { fastTick } from '../../../test/fast-tick.mjs';
import { runForeman, useSupervisors } from '../../../test/supervisors.mjs';

// What every session leaves out of the HOME the run is given: its CLAUDE.md and auto memory.
const LEAN = (home) => ({ claudeMdExcludes: [join(home, '.claude', 'CLAUDE.md')], autoMemoryEnabled: false });
// The plugin off, and the Read tool denied on the key folder of the HOME the run is given.
const SETTINGS = (home) => ({
  ...LEAN(home),
  enabledPlugins: { 'salesforce-development@salesforce': false },
  permissions: { deny: [`Read(/${join(home, '.config', 'foreman', 'sf')}/**)`] },
});
// The session gets its settings as a file path, so no value is on the process list.
const settingsOf = (argv) => JSON.parse(readFileSync(argv[argv.indexOf('--settings') + 1], 'utf8'));
// The lean flags every session has, and no MCP config it was not given.
const expectLean = (argv) => {
  expect(argv).toContain('--strict-mcp-config');
  expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('project,local');
  expect(argv).not.toContain('--mcp-config');
};

const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ argv: process.argv.slice(2), PATH: process.env.PATH, FOREMAN_SF_HOME: process.env.FOREMAN_SF_HOME ?? null }) + '\\n');
const id = process.env.FOREMAN_STORY;
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, result: 'Promote it later.\\nFACTORY_RESULT: ready-to-promote ' + id, total_cost_usd: 0, session_id: 'fake' }));
`;

// Logs each call, and answers `org list` with the file FAKE_SF_ORGS names.
const FAKE_SF = `#!/bin/sh
echo "$*" >> "$FAKE_SF_LOG"
case "$*" in
  "org list"*) cat "$FAKE_SF_ORGS" ;;
  *) echo '{"status":1,"name":"NoRoute","message":"no fake route"}'; exit 1 ;;
esac
`;

const FAKE_GH = `#!/bin/sh
case "$1 $2" in
  "pr list") echo "[]" ;;
  *) exit 1 ;;
esac
`;

const ACME_SF = {
  productionBranch: 'main',
  orgs: { 'acme-dev1': { orgId: ACME_DEV1_ID }, 'acme-qa': { orgId: ACME_QA_ID } },
  build: ['acme-dev1'],
  stages: [{ name: 'qa', org: 'acme-qa', branch: 'qa' }],
};
const BASE = { version: 1, project: { name: 'Acme' }, console: { adapter: 'files' }, features: { keepAwake: false }, learning: { auto: false } };

const story = `---\nid: ACME-1\ntitle: Story ACME-1\nstatus: todo\ndepends_on: []\n---\n\nDo ACME-1.\n\n## Progress notes\n`;

let repos;
let clone;
let bin;
let claudeLog;
let sfLog;
let orgs;
let sfHome;

function setup(config) {
  repos = makeRepos(config);
  clone = repos.clone('acme');
  writeFileSync(join(clone, '.gitignore'), '.foreman/\n');
  mkdirSync(join(clone, 'stories'));
  writeFileSync(join(clone, 'stories', 'ACME-1.md'), story);
  git(clone, 'add', '.');
  git(clone, 'commit', '-qm', 'Add ACME-1');
  git(clone, 'push', '-q', 'origin', 'main');
  bin = join(repos.base, 'bin');
  mkdirSync(bin);
  for (const [name, text] of [['claude', FAKE_CLAUDE], ['gh', FAKE_GH], ['sf', FAKE_SF]]) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  claudeLog = join(repos.base, 'claude.log');
  sfLog = join(repos.base, 'sf.log');
  orgs = join(repos.base, 'orgs.json');
  sfHome = join(repos.base, 'sf-home');
  homeHolds([]);
}

const homeHolds = (entries) =>
  writeFileSync(orgs, JSON.stringify({ status: 0, result: { other: [], sandboxes: entries, nonScratchOrgs: entries, devHubs: [], scratchOrgs: [] }, warnings: [] }));

afterEach(() => repos?.cleanup());
// After the hooks above, so it runs before them (vitest runs afterEach hooks last first).
useSupervisors();

const runEnv = () => {
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, HOME: repos.base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(env)) if (/^(FOREMAN|FACTORY)_/.test(key) || /^SF_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'CLAUDE_CONFIG_DIR'].includes(key)) delete env[key];
  Object.assign(env, fastTick);
  return { ...env, FAKE_CLAUDE_LOG: claudeLog, FAKE_SF_LOG: sfLog, FAKE_SF_ORGS: orgs, FOREMAN_SF_HOME: sfHome };
};

const runOnce = () => runForeman(['run', '--foreground', '1'], { cwd: clone, env: runEnv(), encoding: 'utf8', timeout: 55_000 });
const sessions = () => (existsSync(claudeLog) ? readFileSync(claudeLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

describe('foreman run with the Salesforce pack', () => {
  // The pack's default ship steps are not all built yet, so the run names its own. Its default
  // slot environment, sandbox-pool, checks the build org before the session; this test is about
  // the sf home, so it names none.
  beforeEach(() => setup({ ...BASE, pack: 'salesforce', salesforce: ACME_SF, env: { adapter: 'none' }, ship: { steps: ['push'], pr: { into: 'qa' } } }));

  it('starts the session with the sf wrappers first on PATH, FOREMAN_SF_HOME set, the plugin off and the key folder denied to Read', () => {
    const r = runOnce();
    const [s] = sessions();
    expect(s, r.stderr).toBeDefined();
    const at = s.argv.indexOf('--settings');
    expect(at).toBeGreaterThan(-1);
    expect(settingsOf(s.argv)).toEqual(SETTINGS(repos.base));
    expect(s.argv[at + 2]).toBe('--allowedTools');
    expectLean(s.argv);
    expect(s.PATH.split(delimiter)[0]).toBe(join(sfHome, '.foreman', 'bin'));
    expect(s.FOREMAN_SF_HOME).toBe(sfHome);
    expect(existsSync(join(sfHome, '.foreman', 'bin', 'sf'))).toBe(true);
    expect(existsSync(join(sfHome, '.foreman', 'bin', 'sfdx'))).toBe(true);
  }, 60_000);

  it('stops with exit 1, naming the org, when the home holds an org off the allow-list', () => {
    homeHolds([acmeOrg('acme-dev1', ACME_DEV1_ID), acmeOrg('acme-prod', '00D000000000009AAA')]);
    const r = runOnce();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Foreman cannot start');
    expect(r.stderr).toContain('acme-prod');
    expect(r.stderr).toContain('salesforce.orgs');
    expect(existsSync(claudeLog)).toBe(false);
    expect(readFileSync(sfLog, 'utf8')).not.toContain('acme-prod');
  }, 60_000);
});

describe('foreman run without a pack', () => {
  beforeEach(() => setup(BASE));

  it('starts a lean session with none of the pack\'s settings, and never calls sf', () => {
    const r = runOnce();
    const [s] = sessions();
    expect(s, r.stderr).toBeDefined();
    expect(settingsOf(s.argv)).toEqual(LEAN(repos.base));
    expectLean(s.argv);
    expect(s.PATH).toBe(runEnv().PATH);
    expect(existsSync(sfLog)).toBe(false);
    expect(existsSync(join(sfHome, '.foreman'))).toBe(false);
  }, 60_000);

  it("carries the user's model but not their hooks or other plugins", () => {
    mkdirSync(join(repos.base, '.claude'), { recursive: true });
    writeFileSync(join(repos.base, '.claude', 'settings.json'), JSON.stringify({ model: 'opus', env: { ACME_TOKEN: 'acme-fake-token' }, sandbox: { enabled: true }, hooks: { Stop: [] }, enabledPlugins: { 'other@acme': true } }));
    const r = runOnce();
    const [s] = sessions();
    expect(s, r.stderr).toBeDefined();
    const settings = settingsOf(s.argv);
    expect(settings).toMatchObject({ ...LEAN(repos.base), model: 'opus' });
    expect(settings).not.toHaveProperty('hooks');
    expect(settings.enabledPlugins?.['other@acme'] ?? false).toBe(false);
    expect(settings.env.ACME_TOKEN).toBe('acme-fake-token');
    expect(settings.sandbox).toEqual({ enabled: true });
    expect(JSON.stringify(s.argv)).not.toContain('acme-fake-token');
    const file = s.argv[s.argv.indexOf('--settings') + 1];
    expect(file).toBe(join(realpathSync(clone), '.foreman', 'session-config', 'w1-settings.json'));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expectLean(s.argv);
  }, 60_000);
});

describe('foreman run naming an MCP server the project does not define', () => {
  beforeEach(() => setup({ ...BASE, session: { mcpServers: ['ghost'] } }));

  it('stops with exit 1, naming the server, before any session', () => {
    const r = runOnce();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Foreman cannot start');
    expect(r.stderr).toContain('ghost');
    expect(existsSync(claudeLog)).toBe(false);
  }, 60_000);
});
