// `foreman run` end to end, telling a slow story from a stuck one: a fake session that keeps
// writing its log past watchdog.progressMinutes is slow: `foreman status` prints an FYI line,
// never "stuck", with no run:stuck item and no stuck notification. The stuck half is in
// supervisor-slow-stuck.test.mjs; the fixture both use is test/supervisor-slow-fixture.mjs.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runFactory, sessionLog, setUp, withSlowRepos } from '../../../test/supervisor-slow-fixture.mjs';

withSlowRepos();

describe('the supervisor with a long stage', () => {
  it('a session that keeps writing its log is slow: an FYI line, never stuck, no notification', async () => {
    setUp({ progressMinutes: 0.05, activityMinutes: 0.25 });
    const r = await runFactory({ FAKE_EVERY_MS: '1000', FAKE_FOR_MS: '8000' }, async (h) => {
      const text = await h.until('FYI: slow: ACME-1 in ', 30_000);
      expect(text).toContain('FYI: slow: ACME-1 in ');
      expect(text.split('\n')[0]).not.toContain('stuck');
      expect(text).not.toContain('Needs you now');
      const snap = JSON.parse(h.status('--json'));
      expect(snap.stuck).toBeNull();
      expect(snap.slow[0].id).toBe('ACME-1');
      expect(h.stuckFiles()).toEqual([]);
      expect(h.events().filter((e) => e.kind === 'warn' && e.text.startsWith('Not building for'))).toEqual([]);
    });
    expect(r.code).toBe(0);
    expect(readFileSync(sessionLog(), 'utf8').split('\n').filter(Boolean)).toEqual(['ACME-1']);
    const saved = JSON.parse(r.read('state.json', '{}'));
    expect(saved.slow).toEqual([]);
    expect(saved.stuck).toBeNull();
    expect(r.stuckFiles()).toEqual([]);
    expect(r.events().filter((e) => e.kind === 'warn' && e.text.startsWith('Not building for'))).toEqual([]);
  }, 90_000);
});
