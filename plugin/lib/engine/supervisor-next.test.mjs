// "Build next" for a Jira story whose brief is not fetched yet, end to end: a real `foreman run`
// against the fake Atlassian. The request is not spent while the brief is fetched: the story the
// owner asked for starts first (the story ranked ahead of it waits), one idle slot says what it
// waits for, and "You asked for X next; starting it." is written once, after the session starts.
// A fake `claude` (and `gh`) on the PATH stand in for the session and GitHub.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRepos } from '../../../test/state-repos.mjs';
import { fastTick } from '../../../test/fast-tick.mjs';
import { startFakeJira } from '../../../test/fake-jira.mjs';
import { runForeman, startForeman, useSupervisors } from '../../../test/supervisors.mjs';
import { writeToken } from '../jira/auth.mjs';
import { readSlot } from './state.mjs';
import { claims } from './locks.mjs';
import { briefNote } from './next-request.mjs';

const SITE = 'acme.atlassian.net';

const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require('node:fs');
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
writeFileSync(process.env.FAKE_CLAUDE_LOG + '.' + process.env.FOREMAN_STORY + '.started', String(process.pid));
setInterval(() => {}, 1000);
`;

const FAKE_GH = `#!/bin/sh
case "$1 $2" in
  "pr list") echo "[]" ;;
  *) exit 1 ;;
esac
`;

let jira;
let repos;
let clone;
let bin;
let log;
let child;

beforeAll(async () => {
  jira = await startFakeJira();
});
afterAll(async () => {
  await jira.close();
});

beforeEach(() => {
  jira.reset();
  repos = makeRepos({
    version: 1,
    project: { name: 'Acme' },
    console: { adapter: 'files' },
    features: { keepAwake: false },
    learning: { auto: false },
    slots: 2,
    stories: { adapter: 'jira', site: SITE, jql: 'project = ACME ORDER BY rank', pollSeconds: 5 },
  });
  clone = repos.clone('acme');
  writeFileSync(join(clone, '.gitignore'), '.foreman/\n');
  bin = join(repos.base, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE);
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  chmodSync(join(bin, 'claude'), 0o755);
  chmodSync(join(bin, 'gh'), 0o755);
  log = join(repos.base, 'claude.log');
  writeFileSync(log, '');
  jira.addIssue({ key: 'ACME-1', summary: 'First in rank' });
  jira.addIssue({ key: 'ACME-2', summary: 'Asked for next' });
  child = null;
});
afterEach(() => {
  if (child && child.exitCode === null) {
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  repos.cleanup();
});
// After the hooks above, so it runs before them (vitest runs afterEach hooks last first).
useSupervisors();

const runEnv = () => {
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: repos.base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(env)) if (/^(FOREMAN|FACTORY)_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key)) delete env[key];
  Object.assign(env, fastTick, { FOREMAN_JIRA_API_BASE: jira.url, FOREMAN_JIRA_AUTH_BASE: jira.url });
  writeToken(SITE, { cloudId: jira.cloudId, site: SITE, ...jira.tokens, expiresAt: '2999-01-01T00:00:00.000Z' }, { env });
  return { ...env, FAKE_CLAUDE_LOG: log };
};
const foreman = (...args) => runForeman(args, { cwd: clone, env: runEnv(), encoding: 'utf8', timeout: 30_000 });

const stateDir = () => join(clone, '.foreman');
const readJsonFile = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
};
const runState = () => readJsonFile(join(stateDir(), 'state.json'));
const loop = () => runState().loop ?? null;
const events = () => {
  const file = join(stateDir(), 'events.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).text) : [];
};
const prompts = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((argv) => argv[argv.indexOf('-p') + 1]);
const storyStarts = () => prompts().filter((p) => p.startsWith('/foreman:story '));
const slotsSaying = (reason) => ['w1', 'w2'].filter((slot) => readSlot(stateDir(), slot).reason === reason);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(what, test, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (test()) return;
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`the run exited (${child.exitCode}) while waiting for ${what}`);
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}; loop ${JSON.stringify(loop())}`);
}

describe('"build next" for a Jira story whose brief is not fetched yet', () => {
  it('starts that story first, keeps the request open meanwhile, and logs "starting it" once its session starts', async () => {
    expect(foreman('pause').status).toBe(0);
    child = startForeman(['run', '--foreground', '--workers', '2'], { cwd: clone, env: runEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.resume();
    child.stderr.resume();
    await waitFor('the run to pause', () => loop()?.state === 'paused', 30_000);
    await waitFor('the first poll of Jira', () => existsSync(join(stateDir(), 'jira', 'list.json')), 30_000);

    // ACME-1, ranked ahead, already has its brief (as a story fetched earlier does), so it could
    // start at once; only ACME-2's brief is missing.
    mkdirSync(join(stateDir(), 'stories'), { recursive: true });
    writeFileSync(join(stateDir(), 'stories', 'ACME-1.md'), '---\nid: ACME-1\ntitle: "First in rank"\nstatus: todo\n---\n\n# ACME-1 · First in rank\n\n## What\n\nWork.\n\n## Done when\n\nIt is done.\n');

    // Every Jira call now takes four seconds, so the brief is fetched over several ticks.
    jira.setDelay(4000);
    expect(foreman('next', 'ACME-2').status).toBe(0);
    expect(foreman('resume').status).toBe(0);

    // While the brief is fetched: one slot says so, nothing else starts, and the request is open.
    const note = briefNote('ACME-2');
    expect(note).toBe('Starting ACME-2 next: fetching its brief from Jira');
    await waitFor('a slot to say it fetches the brief', () => slotsSaying(note).length > 0, 30_000);
    expect(slotsSaying(note)).toHaveLength(1);
    // Watch for a few ticks while ACME-2's brief is still missing: no other slot takes ACME-1
    // (no claim, no session, nothing but the note on either slot), and the request stays open.
    const briefFile = join(stateDir(), 'stories', 'ACME-2.md');
    const noter = slotsSaying(note)[0];
    const other = noter === 'w1' ? 'w2' : 'w1';
    const until = Date.now() + 3000;
    let looks = 0;
    while (Date.now() < until && !existsSync(briefFile)) {
      expect(claims(stateDir())).toEqual([]);
      expect(storyStarts()).toEqual([]);
      expect(readSlot(stateDir(), other).story).toBeNull();
      expect(readSlot(stateDir(), other).state).toBe('idle');
      expect(runState().handledNextAt).toBeUndefined();
      expect(events()).not.toContain('You asked for ACME-2 next; starting it.');
      looks++;
      await sleep(100);
    }
    expect(looks).toBeGreaterThanOrEqual(5);

    // Then ACME-2 starts first, and only then is the request marked handled.
    await waitFor('ACME-2 to start', () => existsSync(`${log}.ACME-2.started`), 60_000);
    expect(storyStarts()[0]).toBe('/foreman:story ACME-2');
    const said = events();
    expect(said.filter((t) => t === 'You asked for ACME-2 next; starting it.')).toHaveLength(1);
    const started = said.findIndex((t) => /^Slot w\d: ACME-2$/.test(t));
    expect(started).toBeGreaterThanOrEqual(0);
    expect(said.indexOf('You asked for ACME-2 next; starting it.')).toBeGreaterThan(started);
    expect(runState().handledNextAt).toBe(readJsonFile(join(stateDir(), 'control.json')).requestedAt);
    expect(runState().handledNextAt).toBeTruthy();
    expect(slotsSaying(note)).toEqual([]);
  }, 120_000);
});
