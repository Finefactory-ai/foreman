// `foreman run` end to end from a copy of the plugin in a git repo of its own, when a change is
// committed to that plugin: the supervisor restarts on the new code at once, hands the sessions
// still running to the new process, which keeps watching them, records each of their results once
// and starts the next story in a free slot meanwhile; a run restarted while halted stays halted;
// a skipped story and the worker count are carried across the restart; when the new code rejects
// the config, the run logs why once and carries on with the code it has; and a signal during the
// restart exit ends the run with 130 instead. The handover, the waits and the adopted work are in the other
// supervisor-restart-*.test.mjs files; the fixture they share is test/supervisor-restart-fixture.mjs.

import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '../../../test/state-repos.mjs';
import { TEST_TICK_MS } from '../../../test/fast-tick.mjs';
import { runForeman, useSupervisors } from '../../../test/supervisors.mjs';
import {
  clone,
  go,
  HELD_PUBLISH,
  isUp,
  pidOf,
  plug,
  restartEvents,
  runEnv,
  runRecords,
  setup,
  slotState,
  slow,
  started,
  startRun,
  state,
  stateJson,
  STORY,
  texts,
  until,
  withRestartRepos,
} from '../../../test/supervisor-restart-fixture.mjs';
import { claims } from './locks.mjs';
import { readPid } from './supervisor-pid.mjs';

withRestartRepos();
// This file also runs `foreman run` itself (runForeman). withRestartRepos registers the same hook;
// the guard (test/supervisor-guard.test.mjs) asks for it here too, and a second run finds nothing left.
useSupervisors();

describe('the supervisor when its own code changes under it', () => {
  it('restarts at once with two sessions running, starts the next story in the free slot, and records each adopted result once', async () => {
    setup({ slots: 3, workers: 3 }, ['ACME-1', 'ACME-2']);
    const before = git(plug, 'rev-parse', '--short', 'HEAD');
    const run = startRun('go');
    let code;
    try {
      expect(await until(() => restartEvents().length > 0, 40_000), 'the run restarted on the new code').toBe(true);
      writeFileSync(join(clone, 'stories', 'ACME-3.md'), STORY('ACME-3'));
      // The new process starts ACME-3 in the free slot while the two sessions still run.
      expect(await until(() => started().includes('ACME-3'), 15_000), 'the new process started ACME-3 in the free slot').toBe(true);
      expect(isUp(pidOf('ACME-1'))).toBe(true);
      expect(isUp(pidOf('ACME-2'))).toBe(true);
      // Their slots still show them, and their claims, held under the old supervisor's pid, are live.
      expect([slotState('w1'), slotState('w2')]).toEqual(['building', 'building']);
      const kept = claims(state).filter((c) => c.id === 'ACME-1' || c.id === 'ACME-2');
      expect(kept.map((c) => [c.id, c.stale])).toEqual([['ACME-1', false], ['ACME-2', false]]);
      expect(kept.every((c) => c.pid !== readPid(state) && !isUp(c.pid))).toBe(true);
      expect(texts().some((t) => /^Kept 2 running across the restart: ACME-1 \(w1\), ACME-2 \(w2\)\.?$/.test(t))).toBe(true);

      writeFileSync(go, '');
      const done = () => ['w1', 'w2', 'w3'].every((s) => slotState(s) === 'idle') && ['ACME-1', 'ACME-2', 'ACME-3'].every((id) => runRecords().some((r) => r.story === id));
      expect(await until(done, 30_000), 'all three slots idle with a run record for ACME-1, ACME-2 and ACME-3').toBe(true);

      const ids = started();
      expect(ids.filter((id) => id === 'ACME-1')).toHaveLength(1);
      expect(ids.filter((id) => id === 'ACME-2')).toHaveLength(1);
      expect(texts().filter((t) => t.startsWith('Start-up: resuming'))).toEqual([]);
      const records = runRecords();
      expect(records.filter((r) => r.story === 'ACME-1')).toHaveLength(1);
      expect(records.filter((r) => r.story === 'ACME-2')).toHaveLength(1);
      const restarts = restartEvents();
      expect(restarts).toHaveLength(1);
      expect(restarts[0][1]).toBe(before);
      expect(restarts[0][2]).toBe(git(plug, 'rev-parse', '--short', 'HEAD'));
      expect(restarts[0][1]).not.toBe(restarts[0][2]);
      expect(texts().filter((t) => t.startsWith('Foreman started with'))).toHaveLength(1);
      const final = stateJson();
      expect(final.restart).toBeNull();
      expect(final.restartPending).toBeNull();
    } finally {
      code = await run.stop();
    }
    expect(code).toBe(0);
  }, slow(120_000));

  it('a run restarted while halted is still halted', async () => {
    setup({}, ['ACME-1', 'ACME-2', 'ACME-3']);
    // A stale wait: the plugin is in a repo of its own, so no tick touches it and only the start clears it.
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'state.json'), JSON.stringify({ anchorWait: { why: 'dirty', files: ['README.md'], from: 'a'.repeat(40), to: 'b'.repeat(40), remote: 'origin', baseBranch: 'main', since: '2026-11-01T00:00:00.000Z' } }));
    const run = startRun('halt', ['2']);
    let code;
    try {
      // The restarted process has started once it cleared the carried restart.
      expect(await until(() => restartEvents().length > 0 && stateJson().restart === null, 60_000), 'the restarted process cleared the carried restart').toBe(true);
      expect(stateJson().anchorWait).toBeNull();
      // Past its start and its first tick.
      await new Promise((r) => setTimeout(r, TEST_TICK_MS * 3 + 1000));
      const loop = stateJson().loop;
      expect(loop.state).toBe('halted');
      expect(loop.reason).toBe('A release failed.');
    } finally {
      code = await run.stop();
    }
    expect(code).toBe(0);
    expect(started()).toEqual(['ACME-1']);
    const all = texts();
    const after = all.slice(all.findIndex((t) => t.startsWith('Restarted on new code')));
    // The stop event names who asked: an empty STOP reads as an unknown process.
    const stopAt = after.findIndex((t) => t.startsWith('Stop requested by ') && t.endsWith(': finishing the stories in progress.'));
    expect(stopAt).toBeGreaterThan(-1);
    expect(after.slice(0, stopAt)).not.toContain('Factory running');
  }, slow(120_000));
});

describe('the supervisor carrying its run across a restart', () => {
  it('a skipped story stays skipped and the worker count is kept across a restart', () => {
    setup({ slots: 2 }, ['ACME-1', 'ACME-2']);
    const r = runForeman(['run', '--foreground', '--workers', '1', '2'], { cwd: clone, env: runEnv('skip'), bin: join(plug, 'bin', 'foreman'), stateDir: state, timeout: slow(85_000) });
    expect(r.status).toBe(0);
    // Without the carried skipped set the new process would pick ACME-1 again.
    expect(started()).toEqual(['ACME-1', 'ACME-2']);
    expect(restartEvents()).toHaveLength(1);
    expect(texts().filter((t) => t === 'ACME-1 skipped for this run.')).toHaveLength(1);
    const final = stateJson();
    // Without the carry it would be the flag's 1: the new process marks control.json's change handled.
    expect(final.workers).toBe(2);
    expect(final.restart).toBeNull();
    expect(final.restartPending).toBeNull();
  }, slow(90_000));
});

describe('the supervisor when the new code rejects the config', () => {
  it('carries on with the code it has when the new code rejects the config', () => {
    setup({}, ['ACME-1', 'ACME-2']);
    const r = runForeman(['run', '--foreground', '2'], { cwd: clone, env: runEnv('reject'), bin: join(plug, 'bin', 'foreman'), stateDir: state, timeout: slow(85_000) });
    expect(r.status).toBe(0);
    // Picking went on with the old code.
    expect(started()).toEqual(['ACME-1', 'ACME-2']);
    // Once: the refused code is not tried again on the later ticks.
    expect(texts().filter((t) => /^New Foreman code \([0-9a-f]+\) rejects foreman\.config\.json \(version: refused by the new code\); carrying on with the code already loaded\.$/.test(t))).toHaveLength(1);
    expect(texts().filter((t) => t.startsWith('Restarted on new code'))).toEqual([]);
    expect(texts().filter((t) => t.startsWith('Foreman started with'))).toHaveLength(1);
    expect(stateJson().restartPending).toBeNull();
  }, slow(90_000));
});

describe('the supervisor interrupted while it exits for a restart', () => {
  it('a signal during the restart exit stops the run with 130 and starts no new process', async () => {
    // The old process holds its last publish until ACME-1 has ended.
    setup({}, ['ACME-1'], HELD_PUBLISH);
    const run = startRun('go', ['1']);
    let code;
    try {
      expect(await until(() => Boolean(stateJson().restart?.pid), 40_000), 'state.json recorded the restarting pid').toBe(true);
      process.kill(readPid(state), 'SIGINT');
      writeFileSync(go, '');
      let timer;
      code = await Promise.race([run.exited, new Promise((resolve) => (timer = setTimeout(() => resolve(run.stop()), slow(40_000))))]);
      clearTimeout(timer);
    } finally {
      if (code === undefined) await run.stop();
    }
    expect(code).toBe(130);
    expect(restartEvents()).toHaveLength(1);
    expect(texts().filter((t) => /^Kept \d+ running across the restart/.test(t))).toEqual([]);
    expect(texts().filter((t) => t.startsWith('Foreman started with'))).toHaveLength(1);
    const final = stateJson();
    expect(final.loop.state).toBe('stopped');
    expect(final.restart).toBeNull();
    expect(final.restartPending).toBeNull();
    expect(final.configProblem).toBeNull();
    expect(readPid(state)).toBeNull();
    expect(started()).toEqual(['ACME-1']);
    // ACME-1 ended while it was handed over: its result is still recorded, once.
    expect(runRecords().filter((r) => r.story === 'ACME-1')).toHaveLength(1);
  }, slow(120_000));
});
