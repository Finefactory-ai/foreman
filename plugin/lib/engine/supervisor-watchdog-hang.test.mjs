// `foreman run 1` end to end, for the build-limit watchdog around a story that ships: a session
// that ran `foreman story end` and then hangs with no result is ended once the quiet limit
// passes, without a resume; its own `story end` stands as its result and the slot is freed. The
// fixture, with the fake session, is test/watchdog-shipped-fixture.mjs.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { calls, run, runResults, setup, state, stopped, TEST_MS, texts, why, withWatchdogRepos } from '../../../test/watchdog-shipped-fixture.mjs';

withWatchdogRepos();

describe('the watchdog and a story that ships', () => {
  it('ends a session that hangs after its story ended, once quiet, without a resume', () => {
    setup(true, { quiet: true });
    const r = run({ FAKE_MODE: 'end-hang' });
    const feed = texts();
    const ended = feed.filter((t) => /^ACME-1: its story has ended, but its session has had no activity for .*; ending it without a resume\.$/.test(t));
    expect(ended, why(r)).toHaveLength(1);
    expect(calls()).toEqual(['ACME-1']);
    expect(stopped(feed)).toEqual([]);
    expect(feed.some((t) => t.includes('the session ended without reporting a result'))).toBe(false);
    // Its own `story end` counted; without the stop it would be 'crashed'.
    expect(runResults()).toEqual(['shipped']);
    expect(JSON.parse(readFileSync(join(state, 'slots', 'w1.json'), 'utf8')).state).toBe('idle');
    expect(existsSync(join(state, 'claims', 'ACME-1.json'))).toBe(false);
    expect(r.status).toBe(0);
  }, TEST_MS);
});
