// `foreman run 1` end to end, for the build-limit watchdog around a story that ships: a session
// that really overran the build limit is still stopped, once. The other watchdog cases are in
// supervisor-watchdog-shipped.test.mjs; the fixture, with the fake session, is
// test/watchdog-shipped-fixture.mjs.

import { describe, expect, it } from 'vitest';
import { run, setup, TEST_MS, texts, why, withWatchdogRepos } from '../../../test/watchdog-shipped-fixture.mjs';

withWatchdogRepos();

describe('the watchdog and a story that ships', () => {
  it('still stops a session that really overran the build limit', () => {
    setup(true);
    const r = run({ FAKE_MODE: 'overrun' });
    const hits = texts().filter((t) => /^ACME-1: no progress for .*; stopping the session to resume it\.$/.test(t));
    expect(hits, why(r)).toHaveLength(1);
  }, TEST_MS);
});
