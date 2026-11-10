// `foreman run` restarting on new code, what the new process takes on: the watchdog still covers
// an adopted session, an adopted session's file locks stay live and go when it ends, an adopted
// session's agents are read, and its files removed, from the folder its mark names (its own
// CLAUDE_CONFIG_DIR, not the supervisor's), and queued work is resumed once, by the new process.
// The fixture is test/supervisor-restart-fixture.mjs.

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '../../../test/state-repos.mjs';
import {
  FOLDER_SESSION,
  fixtureEnv,
  go,
  isUp,
  pidOf,
  plug,
  restartEvents,
  runRecords,
  SESSION_CONFIG,
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
import { claimFile, claims, holderOf } from './locks.mjs';
import { FILE_LOCK, fileLockFiles, takeFiles } from './file-locks.mjs';
import { readPid } from './supervisor-pid.mjs';

withRestartRepos();

describe('the supervisor when its own code changes under it', () => {
  it('the watchdog still covers an adopted session', async () => {
    setup({ watchdog: { outliveMinutes: 0.05 } }, ['ACME-1']);
    const run = startRun('linger');
    let code;
    try {
      expect(await until(() => restartEvents().length > 0, 40_000), 'the run restarted on the new code').toBe(true);
      const restartAt = texts().findIndex((t) => t.startsWith('Restarted on new code'));
      const ended = () => texts().slice(restartAt).some((t) => /^ACME-1: its session printed its result \(blocked\) \d+ s ago but is still running; ending it\.$/.test(t));
      expect(await until(ended, 30_000), 'the watchdog ended the adopted ACME-1 session').toBe(true);
      const pid = pidOf('ACME-1');
      expect(await until(() => !isUp(pid), 30_000), 'the ACME-1 session process exited').toBe(true);
      expect(await until(() => runRecords().some((r) => r.story === 'ACME-1'), 15_000), 'a run record for ACME-1').toBe(true);
      expect(runRecords().filter((r) => r.story === 'ACME-1')).toHaveLength(1);
    } finally {
      code = await run.stop();
    }
    expect(code).toBe(0);
  }, slow(120_000));

  it("keeps an adopted session's file locks live across the restart, and lets them go when it ends", async () => {
    setup({}, ['ACME-1']);
    const run = startRun('files');
    let code;
    try {
      expect(await until(() => existsSync(FILE_LOCK(state, 'src/a.mjs')) && readPid(state), 30_000), 'ACME-1 locked src/a.mjs and the supervisor wrote its pid').toBeTruthy();
      const old = readPid(state);
      expect(await until(() => texts().some((t) => t === 'Kept 1 running across the restart: ACME-1 (w1).'), 40_000), 'the new process kept ACME-1 across the restart').toBe(true);
      expect(isUp(old)).toBe(false);
      // The lock still names the old supervisor's pid, and is live: another slot is refused.
      const lock = FILE_LOCK(state, 'src/a.mjs');
      expect(holderOf(lock)).toMatchObject({ pid: old, slot: 'w1', story: 'ACME-1', path: 'src/a.mjs' });
      expect(holderOf(lock).stale).toBe(false);
      const other = takeFiles(state, { id: 'ACME-2', files: ['src/a.mjs'], me: { pid: process.pid, slot: 'w2' } });
      expect(other).toEqual({ ok: false, conflicts: [{ story: 'ACME-1', slot: 'w1', files: ['src/a.mjs'] }] });
      expect(holderOf(lock)).toMatchObject({ pid: old, slot: 'w1' });

      // The session ends under the new process, which lets its file lock go with its token.
      writeFileSync(go, '');
      expect(await until(() => slotState('w1') === 'idle' && runRecords().some((r) => r.story === 'ACME-1'), 30_000), 'w1 idle with a run record for ACME-1').toBe(true);
      expect(await until(() => fileLockFiles(state).length === 0, 10_000), 'the adopted session file locks were let go').toBe(true);
    } finally {
      code = await run.stop();
    }
    expect(code).toBe(0);
  }, slow(120_000));

  it("reads an adopted session's agents from the folder its mark names, and removes its files there", async () => {
    setup({}, ['ACME-1'], SESSION_CONFIG);
    const project = join(fixtureEnv.ACME_SESSION_CONFIG, 'projects', '-tmp-acme');
    const mark = join(state, 'session-files', 'w1.json');
    // One story: the new process ends the run itself once the adopted session has ended.
    const run = startRun('folder', ['1']);
    let code;
    try {
      expect(await until(() => existsSync(join(project, `${FOLDER_SESSION}.jsonl`)) && existsSync(mark), 30_000), 'the session transcript and its folder mark were written').toBe(true);
      // The session's own folder, not the supervisor's (HOME/.claude).
      expect(JSON.parse(readFileSync(mark, 'utf8'))).toMatchObject({ story: 'ACME-1', projects: join(fixtureEnv.ACME_SESSION_CONFIG, 'projects'), keep: false });
      expect(await until(() => texts().includes('Kept 1 running across the restart: ACME-1 (w1).'), 40_000), 'the new process kept ACME-1 across the restart').toBe(true);
      expect(await until(() => texts().includes('Factory stopped: Reached the 1 story asked for.'), 30_000), 'the run stopped after the 1 story asked for').toBe(true);
    } finally {
      code = await run.stop();
    }
    expect(code).toBe(0);
    const records = runRecords().filter((r) => r.story === 'ACME-1');
    expect(records).toHaveLength(1);
    expect(records[0].agents?.find((a) => a.role === 'builder')).toMatchObject({ name: 'build', input: 20, output: 40 });
    expect(existsSync(join(project, `${FOLDER_SESSION}.jsonl`))).toBe(false);
    expect(existsSync(join(project, FOLDER_SESSION))).toBe(false);
    expect(existsSync(mark)).toBe(false);
    expect(texts().filter((t) => /session files/.test(t))).toEqual([]);
  }, slow(120_000));

  it('hands queued work over: it is resumed once, by the new process', async () => {
    setup({}, ['ACME-2']);
    // A dead run's claim: queued at start-up, and held back by the halt.
    const dead = spawnSync('true').pid;
    mkdirSync(join(state, 'claims'), { recursive: true });
    writeFileSync(claimFile(state, 'ACME-2'), JSON.stringify({ pid: dead, slot: 'w1', story: 'ACME-2', by: 'factory', at: new Date().toISOString() }));
    writeFileSync(join(state, 'HALT'), 'A release failed.');
    const run = startRun('plain');
    let code;
    try {
      expect(await until(() => texts().includes('Start-up: resuming ACME-2.'), 30_000), 'start-up resumed ACME-2').toBe(true);
      writeFileSync(join(plug, 'lib', 'touched.txt'), 'new code\n');
      git(plug, 'add', 'lib/touched.txt');
      git(plug, 'commit', '-qm', 'Touch the plugin');
      expect(await until(() => restartEvents().length > 0 && stateJson().restart === null, 60_000), 'the restarted process cleared the carried restart').toBe(true);
      rmSync(join(state, 'HALT'), { force: true });
      expect(await until(() => runRecords().some((r) => r.story === 'ACME-2'), 30_000), 'a run record for ACME-2').toBe(true);
    } finally {
      code = await run.stop();
    }
    expect(code).toBe(0);
    expect(started()).toEqual(['ACME-2']);
    expect(texts().filter((t) => t.startsWith('Start-up: resuming'))).toEqual(['Start-up: resuming ACME-2.']);
    expect(restartEvents()).toHaveLength(1);
  }, slow(120_000));
});
