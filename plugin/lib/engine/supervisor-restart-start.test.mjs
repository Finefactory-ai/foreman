// `foreman run` restarting on new code, how the new process starts: it adopts the handed-over
// sessions before anything else can stop it, ends a handed-over session it cannot adopt and lets
// its claim go, and a fresh start lets go of a supervisor-adopted.json left behind. The fixture
// is test/supervisor-restart-fixture.mjs.

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  clone,
  events,
  fixtureEnv,
  go,
  HELD_START,
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
import { claimFile, claims } from './locks.mjs';
import { ADOPTED_FILE, readAdopted, readPid, writeAdopted } from './supervisor-pid.mjs';

withRestartRepos();

describe('the supervisor started again on new code', () => {
  it('adopts the handed-over sessions before it opens its console, and a stop then ends them', async () => {
    setup({}, ['ACME-1'], HELD_START);
    const run = startRun('go');
    let code;
    try {
      expect(await until(() => pidOf('ACME-1') && readPid(state), 30_000), 'ACME-1 started and the supervisor wrote its pid').toBeTruthy();
      const old = readPid(state);
      expect(await until(() => restartEvents().length > 0, 40_000), 'the run restarted on the new code').toBe(true);
      // The new process is held at its console: it has adopted the session by then.
      expect(await until(() => existsSync(fixtureEnv.ACME_START_HELD) && !isUp(old), 20_000), 'the old process exited and the new one is held at its console').toBe(true);
      const fresh = readPid(state);
      expect(fresh).not.toBe(old);
      expect(texts()).toContain('Kept 1 running across the restart: ACME-1 (w1).');
      expect(readAdopted(state)).toEqual({ by: fresh, pids: [old] });
      expect(stateJson().restart).toBeNull();

      // A kill meanwhile ends the adopted session with the run.
      process.kill(fresh, 'SIGTERM');
      writeFileSync(fixtureEnv.ACME_START_GATE, '');
      expect(await until(() => !isUp(pidOf('ACME-1')), 20_000), 'the adopted ACME-1 session ended with the run').toBe(true);
    } finally {
      code = await run.stop();
    }
    expect(code).toBe(130);
    expect(existsSync(join(state, ADOPTED_FILE))).toBe(false);
  }, slow(120_000));

  it('ends a handed-over session whose slot the new config does not have, and lets its claim go', async () => {
    setup({ slots: 2, workers: 2 }, ['ACME-1', 'ACME-2']);
    const run = startRun('stop');
    let code;
    try {
      expect(await until(() => pidOf('ACME-1') && pidOf('ACME-2') && slotState('w1') === 'building' && slotState('w2') === 'building', 30_000), 'ACME-1 and ACME-2 building in w1 and w2').toBe(true);
      // The new code starts with one slot: w2's session cannot be kept.
      const file = join(clone, 'foreman.config.json');
      const config = JSON.parse(readFileSync(file, 'utf8'));
      writeFileSync(file, `${JSON.stringify({ ...config, slots: 1, workers: 1 }, null, 2)}\n`);
      writeFileSync(fixtureEnv.FAKE_COMMIT, '');
      expect(await until(() => restartEvents().length > 0, 40_000), 'the run restarted on the new code').toBe(true);

      const warn = 'ACME-2: its session in w2 could not be kept across the restart; ending it.';
      expect(await until(() => texts().includes(warn) && existsSync(fixtureEnv.FAKE_TERM), 20_000), 'the new process warned about ACME-2 in w2 and ended its session').toBe(true);
      const kept = texts().indexOf('Kept 1 running across the restart: ACME-1 (w1).');
      expect(kept).toBeGreaterThan(-1);
      expect(texts().indexOf(warn)).toBeGreaterThan(kept);
      expect(events().find((e) => e.text === warn).kind).toBe('warn');

      writeFileSync(fixtureEnv.FAKE_GO2, '');
      const acme2 = pidOf('ACME-2');
      expect(await until(() => !isUp(acme2), 15_000), 'the ACME-2 session process exited').toBe(true);
      expect(await until(() => !claims(state).some((c) => c.id === 'ACME-2'), 10_000), 'the ACME-2 claim was let go').toBe(true);

      writeFileSync(go, '');
      expect(await until(() => slotState('w1') === 'idle' && runRecords().some((r) => r.story === 'ACME-1'), 30_000), 'w1 idle with a run record for ACME-1').toBe(true);
      // ACME-2 is blocked in the overlay, so nothing resumes it. The two started in either order:
      // slots prepare in parallel.
      expect(started().sort()).toEqual(['ACME-1', 'ACME-2']);
    } finally {
      code = await run.stop();
    }
    expect(code).toBe(0);
  }, slow(120_000));

  it("a fresh start lets go of a voucher left behind, so a dead run's claim is resumed", async () => {
    setup({}, ['ACME-2']);
    // A dead run's claim, and a voucher for its pid from a live process (this test, standing in
    // for a pid the system gave to another program).
    const dead = spawnSync('true').pid;
    mkdirSync(join(state, 'claims'), { recursive: true });
    writeFileSync(claimFile(state, 'ACME-2'), JSON.stringify({ pid: dead, slot: 'w1', story: 'ACME-2', by: 'factory', at: new Date().toISOString() }));
    writeAdopted(state, { by: process.pid, pids: [dead] });
    const run = startRun('plain');
    let code;
    try {
      expect(await until(() => texts().includes('Start-up: resuming ACME-2.'), 30_000), 'start-up resumed ACME-2').toBe(true);
      expect(existsSync(join(state, ADOPTED_FILE))).toBe(false);
      expect(await until(() => runRecords().some((r) => r.story === 'ACME-2'), 30_000), 'a run record for ACME-2').toBe(true);
    } finally {
      code = await run.stop();
    }
    expect(code).toBe(0);
  }, slow(120_000));
});
