// A supervisor run end to end from a plugin committed in the project's own checkout (the anchor).
// A story session pushes a change to plugin/ onto origin/main and fetches, as the merge step
// does. The supervisor fast-forwards the checkout and restarts on the new code with no hand
// pull and keeps a tracked change the new code does not touch; with a tracked change the new
// code also changes it leaves the checkout alone, warns once, records the wait and keeps its code.
// The test changes nothing in the clone after the start: it only reads.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, makeRepos } from '../../../test/state-repos.mjs';
import { fastTick, TEST_TICK_MS } from '../../../test/fast-tick.mjs';
import { endChild, startForeman, useSupervisors } from '../../../test/supervisors.mjs';

const PLUGIN = fileURLToPath(new URL('../../', import.meta.url));

// `claude auth status` says signed out. A story session pushes a change to plugin/ onto
// origin/main and fetches (the merge and its fetch), then marks its story blocked and says so.
const FAKE_CLAUDE = `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
if (process.argv[2] === 'auth') {
  console.log(JSON.stringify({ loggedIn: false }));
  process.exit(0);
}
const id = process.env.FOREMAN_STORY;
const git = (...args) => spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: process.cwd() });
writeFileSync(join(process.cwd(), 'plugin', 'lib', 'touched.txt'), 'new code\\n');
writeFileSync(join(process.cwd(), 'README.md'), 'new code\\n');
git('add', 'plugin/lib/touched.txt', 'README.md');
git('commit', '-qm', 'Touch the plugin');
git('push', '-q', 'origin', 'HEAD:main');
git('fetch', '-q', 'origin', 'main');
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
let state;

beforeEach(() => {
  repos = null;
});
afterEach(() => repos?.cleanup());
// After the hook above, so it runs before it (vitest runs afterEach hooks last first).
useSupervisors();

function setUp() {
  repos = makeRepos({ version: 1, project: { name: 'Acme' }, console: { adapter: 'files' }, features: { keepAwake: false }, learning: { auto: false } });
  clone = repos.clone('acme');
  state = join(clone, '.foreman');
  writeFileSync(join(clone, '.gitignore'), '.foreman/\n');
  mkdirSync(join(clone, 'stories'));
  writeFileSync(join(clone, 'stories', 'ACME-1.md'), STORY('ACME-1'));
  writeFileSync(join(clone, 'NOTES.md'), 'notes\n');
  cpSync(PLUGIN, join(clone, 'plugin'), { recursive: true, filter: (src) => !src.endsWith('.test.mjs') });
  git(clone, 'add', '-A');
  git(clone, 'commit', '-qm', 'Add the plugin and the story');
  git(clone, 'push', '-q', 'origin', 'main');
  const bin = join(repos.base, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE);
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  chmodSync(join(bin, 'claude'), 0o755);
  chmodSync(join(bin, 'gh'), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: repos.base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(env)) {
    if (/^(FOREMAN|FACTORY)_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'].includes(key)) delete env[key];
  }
  return { ...env, ...fastTick };
}

const events = () => {
  const file = join(state, 'events.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const RESTART = /^Restarted on new code \([0-9a-f]+ -> [0-9a-f]+\)\.$/;
const restarts = () => events().filter((e) => RESTART.test(e.text));
const until = async (ready, what, ms = 40_000) => {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

function start(env) {
  const child = startForeman(['run', '--foreground'], { cwd: clone, env, stdio: 'ignore', bin: join(clone, 'plugin', 'bin', 'foreman'), stateDir: state });
  const exited = new Promise((resolveExit) => child.on('exit', (code) => resolveExit(code)));
  return {
    // Stops the run the way the owner does and returns its exit code.
    async stop() {
      const timer = setTimeout(() => endChild(child), 20_000);
      writeFileSync(join(state, 'STOP'), '');
      const code = await exited;
      clearTimeout(timer);
      return code;
    },
  };
}

describe('the supervisor fast-forwards its own checkout after a merge', () => {
  it('restarts on new code with no hand pull', async () => {
    const env = setUp();
    writeFileSync(join(clone, 'NOTES.md'), 'mine\n');
    const run = start(env);
    let code;
    try {
      await until(() => restarts().length > 0, 'the restart on new code');
      expect(git(clone, 'rev-parse', 'HEAD')).toBe(git(repos.remote, 'rev-parse', 'main'));
      expect(existsSync(join(clone, 'plugin', 'lib', 'touched.txt'))).toBe(true);
      expect(readFileSync(join(clone, 'NOTES.md'), 'utf8')).toBe('mine\n');
      const all = events();
      const moved = all.filter((e) => e.kind === 'info' && e.text.startsWith("Fast-forwarded the main checkout's main"));
      expect(moved).toHaveLength(1);
      expect(all.indexOf(moved[0])).toBeLessThan(all.findIndex((e) => RESTART.test(e.text)));
      expect(restarts()).toHaveLength(1);
      expect(all.filter((e) => e.kind === 'warn' && e.text.startsWith('New code is on'))).toEqual([]);
    } finally {
      code = await run.stop();
    }
    expect(code).toBe(0);
  }, 90_000);

  it('leaves a dirty main checkout alone with one warn event', async () => {
    const env = setUp();
    writeFileSync(join(clone, 'README.md'), 'dirty\n');
    const before = git(clone, 'rev-parse', 'HEAD');
    const run = start(env);
    let code;
    const warns = () => events().filter((e) => e.kind === 'warn' && e.text.startsWith('New code is on origin/main (') && e.text.includes('uncommitted changes'));
    try {
      await until(() => warns().length > 0, 'the warning');
      await new Promise((r) => setTimeout(r, TEST_TICK_MS * 6));
      expect(warns()).toHaveLength(1);
      expect(events().some((e) => e.text.startsWith('Restarted on new code'))).toBe(false);
      expect(git(clone, 'rev-parse', 'HEAD')).toBe(before);
      expect(readFileSync(join(clone, 'README.md'), 'utf8')).toBe('dirty\n');
      const wait = JSON.parse(readFileSync(join(state, 'state.json'), 'utf8')).anchorWait;
      expect(wait).toMatchObject({ why: 'dirty', files: ['README.md'], remote: 'origin', baseBranch: 'main' });
    } finally {
      code = await run.stop();
    }
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(join(state, 'state.json'), 'utf8')).anchorWait).toBeNull();
  }, 90_000);
});
