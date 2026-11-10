// `foreman run` end to end, when the Claude sign-in stops working under the sessions: each
// session dies with the sign-in error and no result line. That is not the story's fault, so it is
// never a miss and never parks a slot: the story keeps its claim and is queued to resume, and the
// run checks the sign-in itself (`claude auth status`, then a one-turn probe) before anything
// starts again. With it still broken, the run pauses once with the sign-in reason, probes again
// every PROBE_EVERY_TICKS ticks, and carries on by itself once a probe passes. The case where it
// works again at once is in supervisor-signin-resume.test.mjs; the fixture, with the fake
// `claude`, is test/supervisor-signin-fixture.mjs.

import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { endChild, startForeman, useSupervisors } from '../../../test/supervisors.mjs';
import {
  clone,
  events,
  lines,
  outbox,
  probes,
  RUN_MS,
  runEnv,
  saved,
  sessions,
  setUp,
  signin,
  slots,
  state,
  TEST_MS,
  until,
  withSigninRepos,
} from '../../../test/supervisor-signin-fixture.mjs';
import { claims } from './locks.mjs';
import { SIGNIN_PAUSE } from './signin-probe.mjs';

withSigninRepos();
// After the hooks above, so it runs before them (vitest runs afterEach hooks last first).
useSupervisors();

describe('the supervisor when the Claude sign-in stops working', () => {
  it('pauses once with the sign-in reason while it is broken, and resumes by itself once the probe passes', async () => {
    setUp('expired');
    const child = startForeman(['run', '--foreground', '--exit-when-idle', '--workers', '1'], { cwd: clone, env: runEnv(), stdio: 'ignore' });
    try {
      expect(await until(() => saved().autoPausedAt)).toBeTruthy();
      expect(saved().autoPauseReason).toBe(SIGNIN_PAUSE);

      // Two more probes while paused, each still failing.
      expect(await until(() => lines(probes).length >= 3)).toBe(true);
      expect(await until(() => outbox().some((f) => f.endsWith('-paused.json')), 10_000)).toBe(true);
      expect(outbox().filter((f) => f.endsWith('-paused.json'))).toHaveLength(1);
      expect(sessions()).toEqual(['ACME-1']);
      expect(slots().filter((s) => s.state === 'parked')).toEqual([]);
      expect(claims(state()).map((c) => c.id)).toContain('ACME-1');

      writeFileSync(signin, 'ok');
      const timer = setTimeout(() => endChild(child), RUN_MS);
      const code = await child.exited;
      clearTimeout(timer);
      expect(code).toBe(0);

      expect(saved().autoPausedAt ?? null).toBe(null);
      expect(events().filter((e) => e.text === 'Claude sign-in works again; carrying on.')).toHaveLength(1);
      expect(sessions()).toEqual(['ACME-1', 'ACME-1', 'ACME-2', 'ACME-3']);
      expect(outbox().filter((f) => f.endsWith('-paused.json'))).toHaveLength(1);
      expect(events().filter((e) => /crashed twice/i.test(e.text))).toEqual([]);
      expect(outbox().filter((f) => f.endsWith('-parked.json'))).toEqual([]);
    } finally {
      child.kill('SIGTERM');
      const timer = setTimeout(() => endChild(child), 20_000);
      await child.exited;
      clearTimeout(timer);
    }
  }, TEST_MS * 2);
});
