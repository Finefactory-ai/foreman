// `foreman run 1` end to end, for the build-limit watchdog around a story that ships: a session
// in the release stage gets its grace past the build limit. The other watchdog cases are in
// supervisor-watchdog-shipped.test.mjs; the fixture, with the fake session, is
// test/watchdog-shipped-fixture.mjs.

import { describe, expect, it } from 'vitest';
import { calls, run, runResults, setup, stopped, TEST_MS, texts, why, withWatchdogRepos } from '../../../test/watchdog-shipped-fixture.mjs';

withWatchdogRepos();

describe('the watchdog and a story that ships', () => {
  it('gives a session in the release stage its grace past the build limit', () => {
    setup(true);
    const r = run({ FAKE_MODE: 'release' });
    expect(calls(), why(r)).toEqual(['ACME-1']);
    expect(stopped(texts())).toEqual([]);
    expect(runResults()).toEqual(['shipped']);
  }, TEST_MS);
});
