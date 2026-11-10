// `foreman run` end to end, telling a slow story from a stuck one: a fake session that writes
// nothing for watchdog.activityMinutes is stuck: one item, one notification. The slow half is in
// supervisor-slow.test.mjs; the fixture both use is test/supervisor-slow-fixture.mjs.

import { describe, expect, it } from 'vitest';
import { stretchByLoad } from '../../../test/slow-tests.mjs';
import { runFactory, setUp, withSlowRepos } from '../../../test/supervisor-slow-fixture.mjs';

withSlowRepos();

describe('the supervisor with a long stage', () => {
  it('a session that writes nothing and uses no CPU is stuck, once', async () => {
    setUp({ activityMinutes: 0.1 });
    const r = await runFactory({ FAKE_EVERY_MS: '0', FAKE_FOR_MS: '15000', FOREMAN_CPU_SAMPLE_MS: '2000' }, async (h) => {
      // A poll deadline, not a wait: it ends as soon as the text shows, so it keeps the headroom
      // it had at the real 5 s tick (6 s silent + 2 ticks + 5 s). Slot set-up and session start
      // sit inside it too, and the short tick does not shorten them, so it stretches with load.
      const text = await h.until('Foreman: running, but stuck: ACME-1 in w1 has shown no activity since', stretchByLoad(6000 + 2 * 5000 + 5000));
      expect(text).toContain('Foreman: running, but stuck: ACME-1 in w1 has shown no activity since');
      expect(text).toContain('(no stage change, log output or CPU)');
    });
    expect(r.code).toBe(0);
    expect(r.stuckFiles()).toHaveLength(1);
    expect(r.events().filter((e) => e.kind === 'warn' && e.text.startsWith('Not building for'))).toHaveLength(1);
    expect(JSON.parse(r.read('state.json', '{}')).stuck).toBeNull();
  }, 90_000);
});
