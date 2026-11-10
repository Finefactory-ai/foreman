// `foreman run` end to end, when the Claude sign-in stops working under the sessions and works
// again by the time the run checks it: each story resumes at once, with one warn event per check,
// no pause and no parked slot. The case where it stays broken is in supervisor-signin.test.mjs;
// the fixture, with the fake `claude`, is test/supervisor-signin-fixture.mjs.

import { describe, expect, it } from 'vitest';
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
  slots,
  TEST_MS,
  withSigninRepos,
} from '../../../test/supervisor-signin-fixture.mjs';

withSigninRepos();
// After the hooks above, so it runs before them (vitest runs afterEach hooks last first).
useSupervisors();

describe('the supervisor when the Claude sign-in stops working', () => {
  it('resumes the stories at once when the sign-in works again, with no pause and no parked slot', async () => {
    setUp('ok');
    const child = startForeman(['run', '--foreground', '--exit-when-idle', '--workers', '1'], { cwd: clone, env: runEnv({ FAKE_EXPIRE_FIRST: '1' }), stdio: 'ignore' });
    const timer = setTimeout(() => endChild(child), RUN_MS);
    const code = await child.exited;
    clearTimeout(timer);
    expect(code).toBe(0);

    expect(sessions()).toEqual(['ACME-1', 'ACME-1', 'ACME-2', 'ACME-2', 'ACME-3', 'ACME-3']);
    expect(lines(probes)).toHaveLength(3);
    expect(saved().autoPausedAt ?? null).toBeFalsy();
    expect(events().filter((e) => /paused|did not ship|crashed twice/i.test(e.text))).toEqual([]);
    const warned = events().filter((e) => e.text.startsWith('Claude sign-in failed for'));
    expect(warned.map((e) => [e.text, e.kind])).toEqual(
      ['ACME-1', 'ACME-2', 'ACME-3'].map((id) => [`Claude sign-in failed for ${id}; it works again, so they carry on.`, 'warn']),
    );
    expect(outbox().filter((f) => /-(paused|parked|noresult)\.json$/.test(f))).toEqual([]);
    expect(slots().length).toBeGreaterThan(0);
    for (const slot of slots()) expect(slot.state, slot.id).toBe('idle');
  }, TEST_MS);
});
