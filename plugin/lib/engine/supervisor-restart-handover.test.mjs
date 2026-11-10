// `foreman run` restarting on new code, the handover itself: a session that ends while the old
// process hands over is read from its log, and the handed-over locks stay live between the old
// process's exit and the adoption, and an adopted session's plugin is warned about once, not again
// by the new process. The fixture is test/supervisor-restart-fixture.mjs.

import { describe, expect, it } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TEST_TICK_MS } from '../../../test/fast-tick.mjs';
import {
  events,
  fixtureEnv,
  go,
  HELD_LOAD,
  HELD_PUBLISH,
  isUp,
  pidOf,
  restartEvents,
  runRecords,
  setup,
  slotState,
  slow,
  started,
  startRun,
  state,
  stateJson,
  texts,
  until,
  withRestartRepos,
} from '../../../test/supervisor-restart-fixture.mjs';
import { breakIfStale, claimFile, claims, take } from './locks.mjs';
import { ADOPTED_FILE, readAdopted, readPid } from './supervisor-pid.mjs';

withRestartRepos();

describe('the supervisor when its own code changes under it', () => {
  it('a session that ended during the handover is read from its log', async () => {
    // The old process outlives the session by holding its last publish, so the ending reaches it
    // after the handover: it must leave that ending to the new process.
    setup({}, ['ACME-1'], HELD_PUBLISH);
    const run = startRun('handover');
    let code;
    try {
      const done = () => restartEvents().length > 0 && stateJson().restart === null && slotState('w1') === 'idle' && runRecords().some((r) => r.story === 'ACME-1');
      expect(await until(done, 60_000), 'restarted, restart cleared, w1 idle with a run record for ACME-1').toBe(true);
      expect(existsSync(fixtureEnv.ACME_HELD)).toBe(true);
      // Past one more tick: nothing records it a second time or resumes it.
      await new Promise((r) => setTimeout(r, TEST_TICK_MS * 4));
      const records = runRecords().filter((r) => r.story === 'ACME-1');
      expect(records).toHaveLength(1);
      expect(records[0].result).toBe('blocked');
      // Both processes would write the same run record file, so a second count shows in the total.
      expect(stateJson().totals.costUsd).toBe(0.25);
      expect(started()).toEqual(['ACME-1']);
      expect(slotState('w1')).toBe('idle');
      expect(texts().filter((t) => t.startsWith('Start-up: resuming'))).toEqual([]);
    } finally {
      code = await run.stop();
    }
    expect(code).toBe(0);
  }, slow(120_000));

  it('a session whose result is in its log is not handed over: the restart waits for its ending', async () => {
    // ACME-1 prints its result and keeps running for a few seconds, and the code changed already.
    setup({}, ['ACME-1']);
    const run = startRun('ending');
    let code;
    try {
      const done = () => restartEvents().length > 0 && stateJson().restart === null && runRecords().some((r) => r.story === 'ACME-1');
      expect(await until(done, 60_000), 'restarted, restart cleared, with a run record for ACME-1').toBe(true);
      expect(texts().filter((t) => t.startsWith('Kept ') && t.includes('ACME-1'))).toEqual([]);
      const records = runRecords().filter((r) => r.story === 'ACME-1');
      expect(records).toHaveLength(1);
      expect(records[0].result).toBe('blocked');
      // The restart came after the ending was handled, not before it.
      const restart = events().find((e) => /^Restarted on new code/.test(e.text));
      expect(Date.parse(restart.at)).toBeGreaterThanOrEqual(Date.parse(records[0].endedAt));
      expect(started()).toEqual(['ACME-1']);
    } finally {
      code = await run.stop();
    }
    expect(code).toBe(0);
  }, slow(120_000));

  it('keeps the handed-over locks live between the old exit and the adoption', async () => {
    setup({}, ['ACME-1'], HELD_LOAD);
    const run = startRun('go');
    let code;
    try {
      expect(await until(() => pidOf('ACME-1') && readPid(state), 30_000), 'ACME-1 started and the supervisor wrote its pid').toBeTruthy();
      const old = readPid(state);
      expect(await until(() => restartEvents().length > 0, 40_000), 'the run restarted on the new code').toBe(true);
      // The old process is gone and the new one is held as it loads, before it writes its pid
      // or adopts the session.
      expect(await until(() => existsSync(fixtureEnv.ACME_START_HELD) && !isUp(old), 20_000), 'the old process exited and the new one is held as it loads').toBe(true);
      expect(readPid(state)).not.toBe(old);
      expect(texts().some((t) => t.startsWith('Kept '))).toBe(false);
      expect(isUp(pidOf('ACME-1'))).toBe(true);
      // startSupervisor's loop vouches for the old supervisor's pid meanwhile.
      const adopted = readAdopted(state);
      expect(adopted).not.toBeNull();
      expect(adopted.pids).toContain(old);
      expect(adopted.by).not.toBe(old);
      expect(isUp(adopted.by)).toBe(true);
      // So the claim the old process took is live: another slot cannot take or break it.
      const file = claimFile(state, 'ACME-1');
      expect(claims(state).map((c) => [c.id, c.pid, c.stale])).toEqual([['ACME-1', old, false]]);
      const other = take(file, { pid: process.pid, slot: 'w2', id: 'ACME-1' });
      expect([other.ok, other.stale]).toEqual([false, false]);
      expect(breakIfStale(file)).toBeNull();
      expect(existsSync(file)).toBe(true);

      writeFileSync(fixtureEnv.ACME_START_GATE, '');
      expect(await until(() => texts().some((t) => t === 'Kept 1 running across the restart: ACME-1 (w1).'), 15_000), 'the new process kept ACME-1 across the restart').toBe(true);
      // From the adoption on, the new process vouches for it.
      const fresh = readPid(state);
      expect(fresh).not.toBeNull();
      expect(fresh).not.toBe(old);
      expect(readAdopted(state)).toEqual({ by: fresh, pids: [old] });
      writeFileSync(go, '');
      expect(await until(() => slotState('w1') === 'idle' && runRecords().some((r) => r.story === 'ACME-1'), 30_000), 'w1 idle with a run record for ACME-1').toBe(true);
      expect(texts().filter((t) => t.startsWith('Start-up: resuming'))).toEqual([]);
    } finally {
      code = await run.stop();
    }
    expect(code).toBe(0);
    // A stopped run leaves no vouching behind.
    expect(existsSync(join(state, ADOPTED_FILE))).toBe(false);
  }, slow(120_000));

  it("warns once about an adopted session's plugin: the new process does not warn again", async () => {
    setup({}, ['ACME-1']);
    const run = startRun('plugin');
    let code;
    try {
      expect(await until(() => texts().includes('Kept 1 running across the restart: ACME-1 (w1).'), 60_000), 'the new process kept ACME-1 across the restart').toBe(true);
      await new Promise((r) => setTimeout(r, TEST_TICK_MS * 4));
      const warns = () => events().filter((e) => e.kind === 'warn' && String(e.text).includes('its session loaded'));
      expect(warns()).toHaveLength(1);
      expect(warns()[0].slot).toBe('w1');
      expect(warns()[0].text).toContain(`its session loaded Foreman 0.0.1 from ${fixtureEnv.FAKE_PLUGIN_PATH}`);
      writeFileSync(go, '');
      expect(await until(() => slotState('w1') === 'idle' && runRecords().some((r) => r.story === 'ACME-1'), 30_000), 'w1 idle with a run record for ACME-1').toBe(true);
      expect(warns()).toHaveLength(1);
    } finally {
      code = await run.stop();
    }
    expect(code).toBe(0);
  }, slow(120_000));
});
