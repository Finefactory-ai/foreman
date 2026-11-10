// `foreman run 1` end to end, for the build-limit watchdog around a story that ships: a session
// past the build limit is not stopped once its `foreman story end` has run, or once its story is
// done. The other watchdog cases are in supervisor-watchdog-shipped.test.mjs; the fixture, with
// the fake session, is test/watchdog-shipped-fixture.mjs.

import { describe, expect, it } from 'vitest';
import { calls, run, runResults, setup, stopped, TEST_MS, texts, why, withWatchdogRepos } from '../../../test/watchdog-shipped-fixture.mjs';

withWatchdogRepos();

describe('the watchdog and a story that ships', () => {
  it.each([
    ['its `foreman story end` has run', 'end-only'],
    ['its story is done', 'done-only'],
  ])('does not stop a session past the build limit when %s', (_, mode) => {
    setup(true);
    const r = run({ FAKE_MODE: mode });
    expect(calls(), why(r)).toEqual(['ACME-1']);
    expect(stopped(texts())).toEqual([]);
    expect(runResults()).toEqual(['shipped']);
  }, TEST_MS);
});
