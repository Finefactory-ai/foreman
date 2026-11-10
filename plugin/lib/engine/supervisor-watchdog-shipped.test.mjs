// `foreman run 1` end to end, for the build-limit watchdog around a story that ships: a session
// that runs `foreman story end shipped` after the build limit has passed is not stopped, and a
// resume queued after a session ended with no result closes the slot instead of starting a
// session when the story is already done, or marks it done when only its pull request merged. A
// plain crash still resumes once. The other watchdog cases are in supervisor-watchdog-ended,
// supervisor-watchdog-release and supervisor-watchdog-overrun.test.mjs, so their waits run on
// different workers; the fixture, with the fake session, is test/watchdog-shipped-fixture.mjs.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { calls, PR, run, runResults, setup, state, stopped, TEST_MS, texts, why, withWatchdogRepos } from '../../../test/watchdog-shipped-fixture.mjs';

withWatchdogRepos();

describe('the watchdog and a story that ships', () => {
  it('does not stop a session that ran `foreman story end shipped` after the build limit', () => {
    setup(true);
    const r = run({ FAKE_MODE: 'ship-late' });
    const feed = texts();
    expect(calls(), why(r)).toEqual(['ACME-1']);
    expect(stopped(feed)).toEqual([]);
    expect(feed.some((t) => t.includes('the session ended without reporting a result'))).toBe(false);
    expect(runResults()).toEqual(['shipped']);
  }, TEST_MS);

  it('closes the slot instead of resuming a story that is already done', () => {
    setup();
    const r = run({ FAKE_MODE: 'done-no-result' });
    expect(calls(), why(r)).toEqual(['ACME-1']);
    expect(texts()).toContain('ACME-1 is already done; not resuming it.');
    expect(existsSync(join(state, 'claims', 'ACME-1.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(state, 'slots', 'w1.json'), 'utf8')).state).toBe('idle');
    expect(r.status).toBe(0);
  }, TEST_MS);

  it('marks a story done instead of resuming it when only its pull request merged', () => {
    setup();
    const r = run({ FAKE_MODE: 'crash', FAKE_GH_MERGED: PR });
    expect(calls(), why(r)).toEqual(['ACME-1']);
    expect(texts()).toContain('ACME-1: its pull request merged; marked it done instead of resuming it.');
    const story = JSON.parse(readFileSync(join(state, 'stories', 'ACME-1.json'), 'utf8'));
    expect(story.status).toBe('done');
    expect(JSON.stringify(story.notes)).toContain(PR);
    expect(existsSync(join(state, 'claims', 'ACME-1.json'))).toBe(false);
  }, TEST_MS);

  it('still resumes a plain crash once when the story is not done and nothing merged', () => {
    setup();
    const r = run({ FAKE_MODE: 'crash' });
    expect(calls(), why(r)).toEqual(['ACME-1', 'ACME-1']);
    expect(JSON.parse(readFileSync(join(state, 'slots', 'w1.json'), 'utf8')).state).toBe('parked');
  }, TEST_MS);
});
