// `foreman run 1` end to end, for the build-limit watchdog around a story that ships: a session
// spared only because its story/* pull request merged, which then hangs with no result, is ended
// once the quiet limit passes, as an ended one is: no stop to resume it, no crash, a run record
// of 'stopped', and the resume check marks the story done and frees the slot. The session that
// ran `foreman story end` is in supervisor-watchdog-hang.test.mjs. The fixture, with the fake
// session, is test/watchdog-shipped-fixture.mjs.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { calls, PR, run, runResults, setup, state, stopped, TEST_MS, texts, why, withWatchdogRepos } from '../../../test/watchdog-shipped-fixture.mjs';

withWatchdogRepos();

describe('the watchdog and a story that ships', () => {
  it('ends a session that hangs after its pull request merged, once quiet, without a resume', () => {
    setup(true, { quiet: true });
    const r = run({ FAKE_MODE: 'merged-hang', FAKE_GH_MERGED: PR });
    const feed = texts();
    const ended = feed.filter((t) => /^ACME-1: its story has ended, but its session has had no activity for .*; ending it without a resume\.$/.test(t));
    expect(ended, why(r)).toHaveLength(1);
    expect(calls()).toEqual(['ACME-1']);
    expect(stopped(feed)).toEqual([]);
    // No crash: endStory('failed') would say this.
    expect(feed.some((t) => t.includes('stopped by the watchdog'))).toBe(false);
    expect(runResults()).toEqual(['stopped']);
    expect(feed).toContain('ACME-1: its pull request merged; marked it done instead of resuming it.');
    expect(JSON.parse(readFileSync(join(state, 'slots', 'w1.json'), 'utf8')).state).toBe('idle');
    expect(existsSync(join(state, 'claims', 'ACME-1.json'))).toBe(false);
    expect(r.status).toBe(0);
  }, TEST_MS);
});
