// The supervisor end to end with the build limit, which measures the time since the story's
// last progress, and an agent's tool step is progress: a story whose agent keeps taking steps
// but never changes stage or finishes. The cases of one that makes stage progress and one that
// stops are in supervisor-build-limit.test.mjs and supervisor-build-limit-stall.test.mjs; the
// fixture, with the fake session, is test/build-limit-fixture.mjs.
//
// steps: the build limit is 9 s (watchdog.buildMinutes 0.15) and the session runs the real
// agent-events hook for a builder's tool step every 700 ms for about 18 s, never a stage
// change, then says it is blocked. It is never stopped: one session, no watchdog event, and the
// story ends blocked. The builder's finish event counts the steps the hook recorded.

import { describe, expect, it } from 'vitest';
import { runFactory, setUp, withBuildLimitRepos } from '../../../test/build-limit-fixture.mjs';

withBuildLimitRepos();

describe('the build limit with a story whose agent keeps taking steps', () => {
  it('lets it run past the limit to its result, with no stop', async () => {
    setUp({ buildMinutes: 0.15 });
    const started = Date.now();
    const { code, events, runs, sessions } = await runFactory({ FAKE_MODE: 'steps' });
    expect(code).toBe(0);
    expect(Date.now() - started).toBeGreaterThan(18_000);
    expect(events.filter((e) => /no progress for|still building after|stopping the session/.test(e.text))).toEqual([]);
    // The hook's steps really landed.
    const finished = events.map((e) => /^foreman:builder finished after \d+ min, (\d+) steps/.exec(e.text)).filter(Boolean);
    expect(finished).toHaveLength(1);
    expect(Number(finished[0][1])).toBeGreaterThanOrEqual(10);
    // One session, never restarted, and the story ended with what it said.
    expect(sessions).toEqual(['ACME-1']);
    expect(runs).toHaveLength(1);
    expect(runs[0].result).toBe('blocked');
    expect(Object.hasOwn(runs[0], 'watchdog')).toBe(false);
  }, 150_000);
});
