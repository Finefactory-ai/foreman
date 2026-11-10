// `foreman run 1` end to end with the build limit, which measures the time since the story's
// last progress, not the session's age: a story that keeps making progress. The case of one that
// stops is in supervisor-build-limit-stall.test.mjs, and that of one whose agent only takes tool
// steps in supervisor-build-limit-steps.test.mjs; the fixture, with the fake session, is
// test/build-limit-fixture.mjs.
//
// progress: the build limit is 9 s (watchdog.buildMinutes 0.15) and the session starts the real
// `foreman stage` with a new detail every 700 ms for about 18 s, then says it is blocked. It is
// never stopped: one session, no watchdog event, and the story ends blocked. Under a heavy load
// (several stories' suites at once) one `foreman stage` can take seconds to start, so they are
// not waited for one by one, and the limit leaves room for the first to land.

import { describe, expect, it } from 'vitest';
import { runFactory, setUp, withBuildLimitRepos } from '../../../test/build-limit-fixture.mjs';

withBuildLimitRepos();

describe('the build limit with a story that keeps making progress', () => {
  it('lets it run past the limit to its result, with no stop', async () => {
    setUp({ buildMinutes: 0.15 });
    const started = Date.now();
    const { code, events, runs, sessions } = await runFactory({ FAKE_MODE: 'progress' });
    expect(code).toBe(0);
    // It reported its steps, past the 9 s limit.
    expect(events.filter((e) => /^ACME-1: build · step \d+$/.test(e.text)).length).toBeGreaterThanOrEqual(3);
    expect(Date.now() - started).toBeGreaterThan(18_000);
    expect(events.filter((e) => /no progress for|still building after|stopping the session/.test(e.text))).toEqual([]);
    // One session, never restarted, and the story ended with what it said.
    expect(sessions).toEqual(['ACME-1']);
    expect(runs).toHaveLength(1);
    expect(runs[0].result).toBe('blocked');
    expect(Object.hasOwn(runs[0], 'watchdog')).toBe(false);
  }, 150_000);
});
