// `foreman run` restarting on new code waits for what cannot be handed over: a slot being set up
// and a session being stopped. The fixture is test/supervisor-restart-fixture.mjs.

import { describe, expect, it } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { TEST_TICK_MS } from '../../../test/fast-tick.mjs';
import {
  fixtureEnv,
  foremanCli,
  go,
  isUp,
  pidOf,
  restartEvents,
  runRecords,
  setup,
  slotState,
  slow,
  SLOW_PREPARE,
  started,
  startRun,
  stateJson,
  texts,
  until,
  withRestartRepos,
} from '../../../test/supervisor-restart-fixture.mjs';

withRestartRepos();

describe('the supervisor when its own code changes under it', () => {
  it('waits for a slot being set up, then hands its session over too', async () => {
    setup({ slots: 2, workers: 2 }, ['ACME-1', 'ACME-2'], SLOW_PREPARE);
    const run = startRun('go');
    let code;
    try {
      // ACME-1 runs in w1 and has committed new code; w2 is still setting up ACME-2.
      expect(await until(() => stateJson().restartPending, 40_000), 'a restart is pending').toBeTruthy();
      await new Promise((r) => setTimeout(r, TEST_TICK_MS * 4));
      expect(restartEvents()).toEqual([]);
      expect(slotState('w2')).toBe('building');
      expect(started()).toEqual(['ACME-1']);

      writeFileSync(fixtureEnv.ACME_PREPARE_GATE, '');
      expect(await until(() => restartEvents().length > 0, 20_000), 'the run restarted on the new code').toBe(true);
      const all = texts();
      expect(all.findIndex((t) => t === 'Slot w2: ACME-2')).toBeGreaterThan(-1);
      expect(all.findIndex((t) => t === 'Slot w2: ACME-2')).toBeLessThan(all.findIndex((t) => t.startsWith('Restarted on new code')));
      expect(await until(() => texts().some((t) => /^Kept 2 running across the restart: ACME-1 \(w1\), ACME-2 \(w2\)\.?$/.test(t)), 15_000), 'the new process kept ACME-1 and ACME-2 across the restart').toBe(true);

      writeFileSync(go, '');
      const done = () => ['w1', 'w2'].every((s) => slotState(s) === 'idle') && ['ACME-1', 'ACME-2'].every((id) => runRecords().some((r) => r.story === id));
      expect(await until(done, 30_000), 'both slots idle with run records for ACME-1 and ACME-2').toBe(true);
      // Both slots prepare their folders in children at start-up, so which session starts first is not fixed.
      expect(started().sort()).toEqual(['ACME-1', 'ACME-2']);
      expect(runRecords().filter((r) => r.story === 'ACME-2')).toHaveLength(1);
      expect(texts().filter((t) => t.startsWith('Start-up: resuming'))).toEqual([]);
    } finally {
      code = await run.stop();
    }
    expect(code).toBe(0);
  }, slow(120_000));

  it('waits for a session being stopped, and records how it ended', async () => {
    setup({ slots: 2, workers: 2 }, ['ACME-1', 'ACME-2']);
    const run = startRun('stop');
    let code;
    try {
      expect(await until(() => pidOf('ACME-1') && pidOf('ACME-2'), 30_000), 'ACME-1 and ACME-2 started').toBeTruthy();
      // The owner skips ACME-2, whose session takes its time to end; then ACME-1 commits new code.
      const skip = foremanCli('stop', 'slot', 'w2', 'skip');
      expect(skip.status).toBe(0);
      expect(await until(() => existsSync(fixtureEnv.FAKE_TERM), 15_000), 'the ACME-2 session was asked to stop').toBe(true);
      writeFileSync(fixtureEnv.FAKE_COMMIT, '');
      expect(await until(() => stateJson().restartPending, 15_000), 'a restart is pending').toBeTruthy();
      await new Promise((r) => setTimeout(r, TEST_TICK_MS * 4));
      expect(restartEvents()).toEqual([]);
      expect(isUp(pidOf('ACME-2'))).toBe(true);

      writeFileSync(fixtureEnv.FAKE_GO2, '');
      expect(await until(() => restartEvents().length > 0, 20_000), 'the run restarted on the new code').toBe(true);
      const all = texts();
      expect(all.indexOf('ACME-2 skipped for this run.')).toBeGreaterThan(-1);
      expect(all.indexOf('ACME-2 skipped for this run.')).toBeLessThan(all.findIndex((t) => t.startsWith('Restarted on new code')));
      expect(runRecords().filter((r) => r.story === 'ACME-2').map((r) => r.result)).toEqual(['stopped']);
      expect(await until(() => texts().some((t) => /^Kept 1 running across the restart: ACME-1 \(w1\)\.?$/.test(t)), 15_000), 'the new process kept ACME-1 across the restart').toBe(true);

      writeFileSync(go, '');
      expect(await until(() => slotState('w1') === 'idle' && runRecords().some((r) => r.story === 'ACME-1'), 30_000), 'w1 idle with a run record for ACME-1').toBe(true);
      // Both slots prepare their folders in children at start-up, so which session starts first is not fixed.
      expect(started().sort()).toEqual(['ACME-1', 'ACME-2']);
      expect(runRecords().filter((r) => r.story === 'ACME-2')).toHaveLength(1);
    } finally {
      code = await run.stop();
    }
    expect(code).toBe(0);
  }, slow(120_000));
});
