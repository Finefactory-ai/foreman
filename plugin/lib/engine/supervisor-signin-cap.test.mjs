// A full supervisor run, end to end, when the Claude sign-in check passes but every session still
// dies with the sign-in error: a story resumes this way MAX_SIGNIN_RESUMES times in a row, then the
// next death counts as a plain crash (an environment crash and a notification), and the one after parks the slot.
// The run is never paused for the sign-in, because the check passes. The fixture, with the fake
// `claude`, is test/supervisor-signin-fixture.mjs.

import { describe, expect, it } from 'vitest';
import { endChild, startForeman, useSupervisors } from '../../../test/supervisors.mjs';
import {
  clone,
  events,
  lines,
  outbox,
  probes,
  runEnv,
  saved,
  sessions,
  setUp,
  slots,
  TEST_MS,
  until,
  withSigninRepos,
} from '../../../test/supervisor-signin-fixture.mjs';
import { SIGNIN_PAUSE } from './signin-probe.mjs';

withSigninRepos();
// After the hooks above, so it runs before them (vitest runs afterEach hooks last first).
useSupervisors();

describe('the supervisor when the Claude sign-in keeps failing while the check passes', () => {
  it('counts the fourth sign-in death in a row as a crash and parks the slot on the fifth', async () => {
    setUp('ok');
    const child = startForeman(['run', '--foreground', '--workers', '1'], { cwd: clone, env: runEnv({ FAKE_EXPIRE_ALWAYS: '1', FAKE_PROBE_MS: '0' }), stdio: 'ignore' });
    try {
      expect(await until(() => slots().some((s) => s.state === 'parked'))).toBe(true);
      expect(await until(() => outbox().some((f) => f.endsWith('-parked.json')))).toBe(true);

      expect(sessions()).toEqual(['ACME-1', 'ACME-1', 'ACME-1', 'ACME-1', 'ACME-1']);
      expect(lines(probes)).toHaveLength(3);
      expect(events().filter((e) => e.kind === 'warn' && e.text === 'Claude sign-in failed for ACME-1; it works again, so they carry on.')).toHaveLength(3);
      expect(events().filter((e) => e.kind === 'warn' && e.text.includes('times in a row while the sign-in check passed; counting it as a crash.'))).toHaveLength(2);
      const parked = slots().find((s) => s.state === 'parked');
      expect(parked).toMatchObject({ parkedFor: 'crash', parkedStory: 'ACME-1' });
      expect(saved().autoPauseReason).not.toBe(SIGNIN_PAUSE);
      expect(saved().autoPausedAt).toBeFalsy();
      expect(outbox().filter((f) => f.endsWith('-noresult.json'))).toHaveLength(1);
      expect(outbox().filter((f) => f.endsWith('-parked.json'))).toHaveLength(1);
    } finally {
      child.kill('SIGTERM');
      const timer = setTimeout(() => endChild(child), 20_000);
      await child.exited;
      clearTimeout(timer);
    }
  }, TEST_MS);
});
