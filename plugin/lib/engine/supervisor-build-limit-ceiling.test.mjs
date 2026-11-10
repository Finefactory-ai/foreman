// `foreman run 1` end to end with the build limit's hard ceiling: a story that keeps making
// progress is stopped at 4 times the build limit, and its slot is parked as a crash for the owner
// to decide, with one `parked` email and no `noresult` one. The cases of a story that keeps
// making progress within the ceiling and of one that stops are in supervisor-build-limit.test.mjs
// and supervisor-build-limit-stall.test.mjs; the fixture, with the fake session, is
// test/build-limit-fixture.mjs.
//
// progress: the build limit is 6 s (watchdog.buildMinutes 0.1), so the ceiling is 24 s, and the
// session starts the real `foreman stage` with a new detail every 700 ms for 60 s. The watchdog
// stops it at the ceiling, not for a lack of progress.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runFactory, setUp, withBuildLimitRepos } from '../../../test/build-limit-fixture.mjs';

withBuildLimitRepos();

describe('the build limit with a story that keeps making progress past the ceiling', () => {
  it('stops it at the ceiling and parks its slot for the owner, with one parked email', async () => {
    setUp({ buildMinutes: 0.1 });
    const { code, state, events, runs, sessions } = await runFactory({ FAKE_MODE: 'progress', FAKE_PROGRESS_MS: '60000' });
    expect(code).toBe(0);
    expect(events.filter((e) => e.text === 'ACME-1: still building after 0.4 minutes although it is making progress; stopping it and asking you what to do.')).toHaveLength(1);
    expect(events.filter((e) => /no progress for/.test(e.text))).toEqual([]);
    expect(events.map((e) => e.text)).toContain('ACME-1 failed: stopped at the hard limit');
    const st = JSON.parse(readFileSync(join(state, 'state.json'), 'utf8'));
    expect(st.recent[0].note).toBe('stopped at the hard limit');

    // One session, not resumed: the slot waits for the owner.
    expect(sessions).toEqual(['ACME-1']);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ result: 'crashed', watchdog: { why: 'ceiling' } });
    expect(JSON.parse(readFileSync(join(state, 'slots', 'w1.json'), 'utf8'))).toMatchObject({
      state: 'parked',
      parkedFor: 'crash',
      parkedStory: 'ACME-1',
      reason: 'ACME-1 was still building after 0.4 minutes (4 times the build limit) while still making progress. Resume carries on from its last finished stage; Restart begins it again from main.',
    });
    const outbox = readdirSync(join(state, 'outbox'));
    expect(outbox.filter((f) => f.endsWith('-parked.json'))).toHaveLength(1);
    expect(outbox.filter((f) => f.endsWith('-noresult.json'))).toEqual([]);
  }, 150_000);
});
