// `foreman run 1` end to end, while the only slot is building: the owner keeps a change Foreman
// learned, and the supervisor applies that answer on its next tick, without waiting for the run
// to go idle. A review answer given at the same moment still waits until nothing runs. The review
// note is older and answered first, so a supervisor that applied it during the run would do so
// before the learned note, and the session would see it. A fake `claude` (and `gh`) on the PATH
// stand in for the session and GitHub; the session watches the learned note's file and records
// when it is applied.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, makeRepos } from '../../../test/state-repos.mjs';
import * as decisions from '../console/decisions.mjs';
import { addItem, readLedger } from './learning-store.mjs';
import { fastTick, TEST_TICK_MS } from '../../../test/fast-tick.mjs';
import { stretchByLoad } from '../../../test/slow-tests.mjs';
import { endChild, startForeman, useSupervisors } from '../../../test/supervisors.mjs';

const WORK_MS = 3000;
const REAL_TICK_MS = 5000;

// Says it started, then polls the learned note every 250 ms for up to 30 s. Once the note is
// applied it writes when, and whether the review note was applied by then, to the seen file. The
// review note is older and answered first, so if the supervisor applied it during the run, it
// did so before the learned note and shows here. Then it marks its story blocked in the state
// overlay and says so.
const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const id = process.env.FOREMAN_STORY;
const state = process.env.FOREMAN_STATE_DIR;
appendFileSync(process.env.FAKE_CLAUDE_LOG, id + '\\n');
writeFileSync(process.env.FAKE_STARTED, String(Date.now()));
const decision = (name) => { try { return JSON.parse(readFileSync(join(state, 'decisions', name + '.json'), 'utf8')); } catch { return null; } };
const end = Date.now() + 30000;
const finish = () => {
  const stories = join(state, 'stories');
  mkdirSync(stories, { recursive: true });
  writeFileSync(join(stories, id + '.json'), JSON.stringify({ id, status: 'blocked', blockedBy: 'Fake session', fields: {}, notes: [] }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, result: 'Could not get further.\\nFACTORY_RESULT: blocked ' + id, total_cost_usd: 0, session_id: 'fake' }));
  process.exit(0);
};
const timer = setInterval(() => {
  const learned = decision(process.env.FAKE_LEARNED_ID);
  if (learned && learned.appliedAt) {
    clearInterval(timer);
    const review = decision(process.env.FAKE_REVIEW_ID);
    writeFileSync(process.env.FAKE_SEEN, JSON.stringify({ at: Date.now(), reviewAppliedAt: review ? review.appliedAt ?? null : 'missing' }));
    finish();
  } else if (Date.now() > end) {
    clearInterval(timer);
    finish();
  }
}, 250);
`;

const FAKE_GH = `#!/bin/sh
case "$1 $2" in
  "pr list") echo "[]" ;;
  *) exit 1 ;;
esac
`;

const TODO = '---\nid: ACME-1\ntitle: Story ACME-1\nstatus: todo\ndepends_on: []\n---\n\nDo ACME-1.\n\n## Progress notes\n';
const BLOCKED = '---\nid: ACME-2\ntitle: Story ACME-2\nstatus: blocked\ndepends_on: []\nblocked_by: Factory could not pass review\n---\n\nDo ACME-2.\n\n## Progress notes\n';
const REVIEW = ['Retry with a note to the architect', "I'll take it", 'Drop'];

let repos;
let clone;
let bin;
let log;

beforeEach(() => {
  repos = makeRepos({ version: 1, project: { name: 'Acme' }, console: { adapter: 'files' }, features: { keepAwake: false }, learning: { auto: false } });
  clone = repos.clone('acme');
  writeFileSync(join(clone, '.gitignore'), '.foreman/\n');
  mkdirSync(join(clone, 'stories'));
  writeFileSync(join(clone, 'stories', 'ACME-1.md'), TODO);
  writeFileSync(join(clone, 'stories', 'ACME-2.md'), BLOCKED);
  git(clone, 'add', '.');
  git(clone, 'commit', '-qm', 'Add ACME-1 and ACME-2');
  git(clone, 'push', '-q', 'origin', 'main');
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

const runEnv = (extra) => {
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: repos.base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', FAKE_CLAUDE_LOG: log };
  for (const key of Object.keys(env)) if (/^(FOREMAN|FACTORY)_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key)) delete env[key];
  Object.assign(env, fastTick);
  return { ...env, ...extra };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('the supervisor applies a learned-change answer while a story runs', () => {
  it('keeps the change within a tick, while the review answer waits for idle', async () => {
    const state = join(clone, '.foreman');
    // The note gets the time of the change it is about, as the learning tick gives it.
    const T = new Date();
    const added = addItem(state, { kind: 'trait', roles: ['developer'], text: 'Acme: give every route a test.' }, { now: T });
    expect(added).toMatchObject({ ok: true, id: 'L-1' });
    const learnedId = decisions.add(state, { story: 'ACME-1', kind: 'decision', title: 'Foreman learned L-1 for developer', options: ['Undo the change', 'Keep the change'] }, T);
    // The review note is older, so a supervisor that applied every kind while ACME-1 runs would
    // apply it before the learned note, and the fake would see it applied.
    const reviewId = decisions.add(state, { story: 'ACME-2', kind: 'decision', title: 'ACME-2 could not pass review', options: REVIEW }, new Date(T.getTime() - 1000));

    const started = join(repos.base, 'started');
    const seen = join(repos.base, 'seen.json');
    const env = runEnv({ FAKE_STARTED: started, FAKE_SEEN: seen, FAKE_LEARNED_ID: learnedId, FAKE_REVIEW_ID: reviewId });
    const child = startForeman(['run', '--foreground', '1'], { cwd: clone, env, stdio: 'ignore' });
    const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    let code;
    let answeredAt;
    try {
      for (const end = Date.now() + 30_000; Date.now() < end && !existsSync(started); await sleep(100));
      expect(existsSync(started)).toBe(true);

      answeredAt = Date.now();
      // The review first, so any tick that sees the learned answer also sees the review answer.
      decisions.answer(state, reviewId, { option: 'Retry with a note to the architect', note: 'Use the cache' });
      decisions.answer(state, learnedId, { option: 'Keep the change' });

      const timer = setTimeout(() => endChild(child), 60_000);
      code = await exited;
      clearTimeout(timer);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        endChild(child);
        await exited;
      }
    }
    expect(code).toBe(0);

    // Applied while the session was still running, within two ticks of the answer. At the short
    // test tick, the tick's own work and the fake's 250 ms poll take longer than the ticks, so
    // they get WORK_MS on top, stretched by the machine's load. The bound never passes the two
    // real ticks (10 s) it was before the test tick.
    expect(existsSync(seen)).toBe(true);
    const saw = JSON.parse(readFileSync(seen, 'utf8'));
    expect(saw.at - answeredAt).toBeLessThanOrEqual(Math.min(2 * TEST_TICK_MS + stretchByLoad(WORK_MS), 2 * REAL_TICK_MS));
    // The review answer needs the run idle, so it was still pending then.
    expect(saw.reviewAppliedAt).toBeNull();

    expect(decisions.list(state).find((d) => d.id === learnedId).appliedAt).toBeTruthy();
    expect(readLedger(state).filter((l) => l.action === 'keep' && l.id === 'L-1' && l.by === 'owner')).toHaveLength(1);
    const events = readFileSync(join(state, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).text);
    expect(events).toContain('Applied your answer to "Foreman learned L-1 for developer": Keep the change.');
    expect(readFileSync(log, 'utf8').split('\n').filter(Boolean)).toEqual(['ACME-1']);
  }, 90_000);
});
