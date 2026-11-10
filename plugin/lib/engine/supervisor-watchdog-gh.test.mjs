// `foreman run 1` end to end, for the build-limit watchdog around a story that ships: when gh
// cannot answer the merged-PR look-up (it exits 1, or prints bad JSON), a session that ended with
// no result is still resumed once, as a plain crash, and never closed as merged. FAKE_GH_MERGED
// is set, so a working gh would have closed the slot instead. The fixture, with the fake session,
// is test/watchdog-shipped-fixture.mjs.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { calls, PR, run, setup, state, TEST_MS, texts, why, withWatchdogRepos } from '../../../test/watchdog-shipped-fixture.mjs';

withWatchdogRepos();

describe('the watchdog and a story that ships', () => {
  it.each([
    ['exits 1', 'exit'],
    ['prints bad JSON', 'json'],
  ])('still resumes a plain crash once when gh %s for the merged look-up', (_, mode) => {
    setup();
    const r = run({ FAKE_MODE: 'crash', FAKE_GH_MERGED: PR, FAKE_GH_BROKEN: mode });
    expect(calls(), why(r)).toEqual(['ACME-1', 'ACME-1']);
    expect(JSON.parse(readFileSync(join(state, 'slots', 'w1.json'), 'utf8')).state).toBe('parked');
    expect(texts().some((t) => t.includes('its pull request merged'))).toBe(false);
  }, TEST_MS);
});
