// `foreman run` end to end, the CPU sign of activity: a fake session that writes nothing to its
// log past watchdog.activityMinutes, but keeps the CPU busy all the while, is not stuck. The CPU
// is sampled every 2 s here (FOREMAN_CPU_SAMPLE_MS) instead of once a minute, and the limit is
// 15 s, so even on a loaded machine, with slow ticks and a slow session start, several samples
// fall inside it and one late sample cannot let it pass. The session burns about a third of one
// core, metered, and stops once the test has looked, so it adds little load to the tests beside
// it. The silent
// and idle half is in supervisor-slow-stuck.test.mjs; the fixture both use is
// test/supervisor-slow-fixture.mjs.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runFactory, sessionLog, setUp, withSlowRepos } from '../../../test/supervisor-slow-fixture.mjs';

withSlowRepos();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LIMIT_MS = 15_000;

// What a failure needs to show: when the session started, when the watchdog fired and why (the
// stuck files and warn events), and the CPU the session had by then, a line a second.
const explain = (h, startedAt) =>
  JSON.stringify(
    {
      sessionSeenAt: new Date(startedAt).toISOString(),
      stuck: h.stuckFiles().map((f) => h.read(`outbox/${f}`, '')),
      warns: h.events().filter((e) => e.kind === 'warn'),
      burn: h.burnTrace().split('\n').filter(Boolean),
    },
    null,
    2,
  );

describe('the supervisor with a long stage', () => {
  it('a session that writes nothing but keeps the CPU busy is not stuck', async () => {
    setUp({ activityMinutes: LIMIT_MS / 60_000 });
    let startedAt;
    let seen;
    const r = await runFactory({ FAKE_EVERY_MS: '0', FAKE_FOR_MS: '90000', FAKE_BURN: '1', FOREMAN_CPU_SAMPLE_MS: '2000' }, async (h) => {
      for (const end = Date.now() + 30_000; Date.now() < end && !readFileSync(sessionLog(), 'utf8').includes('ACME-1'); ) await sleep(200);
      startedAt = Date.now();
      // Past the 15 s limit by a few ticks, the session spinning all the while; a stuck file ends
      // the wait at once.
      while (Date.now() < startedAt + LIMIT_MS + 5000 && h.stuckFiles().length === 0) await sleep(500);
      const status = h.status();
      const stuck = JSON.parse(h.status('--json')).stuck;
      seen = explain(h, startedAt);
      // Seen what it needs: end the burn, and the session, rather than spin on.
      h.stopBurn();
      expect(h.stuckFiles(), seen).toEqual([]);
      expect(status, seen).not.toContain('running, but stuck');
      expect(stuck, seen).toBeNull();
    });
    seen = explain(r, startedAt);
    expect(r.code, seen).toBe(0);
    expect(readFileSync(sessionLog(), 'utf8').split('\n').filter(Boolean)).toEqual(['ACME-1']);
    expect(JSON.parse(r.read('state.json', '{}')).stuck, seen).toBeNull();
    expect(r.stuckFiles(), seen).toEqual([]);
    expect(r.events().filter((e) => e.kind === 'warn' && e.text.startsWith('Not building for')), seen).toEqual([]);
  }, 120_000);
});
