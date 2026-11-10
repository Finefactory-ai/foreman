// `foreman run 1` end to end, for the build-limit watchdog around a story that ships: a session
// past the build limit is not stopped when only its story/* pull request merged, its story being
// neither done nor ended yet. The control is supervisor-watchdog-overrun.test.mjs, where nothing
// merged and the session is stopped. The fixture, with the fake session, is
// test/watchdog-shipped-fixture.mjs.

import { describe, expect, it } from 'vitest';
import { calls, ghCalls, PR, run, runResults, setup, stopped, TEST_MS, texts, why, withWatchdogRepos } from '../../../test/watchdog-shipped-fixture.mjs';

withWatchdogRepos();

describe('the watchdog and a story that ships', () => {
  it('does not stop a session past the build limit when only its pull request merged', () => {
    setup(true);
    const r = run({ FAKE_MODE: 'merged-only', FAKE_GH_MERGED: PR });
    expect(calls(), why(r)).toEqual(['ACME-1']);
    expect(stopped(texts())).toEqual([]);
    expect(runResults()).toEqual(['shipped']);
    // The merged look-up is what spared it.
    expect(ghCalls().some((c) => c.startsWith('pr list --head story/acme-1 --state merged'))).toBe(true);
  }, TEST_MS);
});
