import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADOPTED_FILE, adoptedAlive, clearAdopted, clearPid, dropAdopted, clearStopped, defaultAlive, isStopped, pidExists, markStopped, PID_FILE, readAdopted, readPid, runningSupervisor, STOPPED_FILE, writeAdopted, writePid } from './supervisor-pid.mjs';
import { committable } from '../state-store/branch.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foreman-pid-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the supervisor pid file', () => {
  it('round-trips the pid', () => {
    writePid(dir, 4242);
    expect(readFileSync(join(dir, PID_FILE), 'utf8').trim()).toBe('4242');
    expect(readPid(dir)).toBe(4242);
  });

  it('reads null when there is no file or it holds no pid', () => {
    expect(readPid(dir)).toBeNull();
    writeFileSync(join(dir, PID_FILE), 'not a pid\n');
    expect(readPid(dir)).toBeNull();
  });

  it('clears the file only for the pid it holds', () => {
    writePid(dir, 4242);
    clearPid(dir, 99);
    expect(readPid(dir)).toBe(4242);
    clearPid(dir, 4242);
    expect(existsSync(join(dir, PID_FILE))).toBe(false);
  });
});

describe('runningSupervisor', () => {
  it('is null with no pid file', () => {
    expect(runningSupervisor(dir, { alive: () => true })).toBeNull();
  });

  it('is null when the pid is not a live supervisor (a stale file after a reboot)', () => {
    writePid(dir, 4242);
    expect(runningSupervisor(dir, { alive: () => false })).toBeNull();
  });

  it('is the pid when it is alive', () => {
    writePid(dir, 4242);
    const asked = [];
    expect(runningSupervisor(dir, { alive: (pid) => { asked.push(pid); return true; } })).toBe(4242);
    expect(asked).toEqual([4242]);
  });
});

describe('defaultAlive', () => {
  let child = null;
  afterEach(() => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    child = null;
  });

  it('is false for a live process that is not a supervisor', () => {
    expect(defaultAlive(process.pid)).toBe(false);
  });

  it('is true for a live supervisor.mjs, and false once it has died', async () => {
    const script = join(dir, 'supervisor.mjs');
    writeFileSync(script, 'setTimeout(() => process.exit(0), 60_000); setInterval(() => {}, 1000);\n');
    child = spawn(process.execPath, [script], { stdio: 'ignore' });
    await new Promise((resolve, reject) => child.once('spawn', resolve).once('error', reject));
    const pid = child.pid;
    expect(defaultAlive(pid)).toBe(true);
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
    expect(defaultAlive(pid)).toBe(false);
  });
});

describe('the stop marker', () => {
  it('is set, read and cleared', () => {
    expect(isStopped(dir)).toBe(false);
    markStopped(dir, new Date('2026-10-25T09:00:00Z'));
    expect(isStopped(dir)).toBe(true);
    expect(readFileSync(join(dir, STOPPED_FILE), 'utf8')).toContain('2026-10-25T09:00:00.000Z');
    clearStopped(dir);
    expect(isStopped(dir)).toBe(false);
    clearStopped(dir);
  });

  it('holds the stopper record it is given, as one JSON line', () => {
    const rec = { at: '2026-10-25T09:00:00.000Z', via: 'cli', run: false };
    markStopped(dir, new Date('2026-10-25T09:00:00Z'), rec);
    expect(readFileSync(join(dir, STOPPED_FILE), 'utf8')).toBe(`${JSON.stringify(rec)}\n`);
    expect(isStopped(dir)).toBe(true);
  });
});

// A pid of a process that has ended.
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

describe('the adopted lineage', () => {
  it('round-trips through the file', () => {
    writeAdopted(dir, { by: 4242, pids: [11, 12] });
    expect(readAdopted(dir)).toEqual({ by: 4242, pids: [11, 12] });
    // Written through a temp file: nothing else is left behind.
    expect(readdirSync(dir)).toEqual([ADOPTED_FILE]);
  });

  it('vouches for a listed pid while the voucher is alive', () => {
    const old = deadPid();
    writeAdopted(dir, { by: process.pid, pids: [old] });
    expect(adoptedAlive(dir, old)).toBe(true);
  });

  it('vouches for nothing once the voucher is dead', () => {
    const old = deadPid();
    writeAdopted(dir, { by: deadPid(), pids: [old] });
    expect(adoptedAlive(dir, old)).toBe(false);
  });

  it('vouches for nothing with an unlisted pid, no file or a malformed file', () => {
    expect(adoptedAlive(dir, 4242)).toBe(false);
    expect(readAdopted(dir)).toBeNull();
    writeAdopted(dir, { by: process.pid, pids: [11] });
    expect(adoptedAlive(dir, 4242)).toBe(false);
    for (const text of ['{not json', '[]', JSON.stringify({ by: 'me', pids: [11] }), JSON.stringify({ by: process.pid, pids: 'all' })]) {
      writeFileSync(join(dir, ADOPTED_FILE), text);
      expect(readAdopted(dir)).toBeNull();
      expect(adoptedAlive(dir, 11)).toBe(false);
    }
  });

  it('asks the injected check about the voucher only', () => {
    writeAdopted(dir, { by: 4242, pids: [11] });
    const asked = [];
    expect(adoptedAlive(dir, 11, { alive: (pid) => { asked.push(pid); return true; } })).toBe(true);
    expect(asked).toEqual([4242]);
    expect(adoptedAlive(dir, 11, { alive: () => false })).toBe(false);
  });

  it('is cleared only by the process that vouches', () => {
    writeAdopted(dir, { by: 4242, pids: [11] });
    clearAdopted(dir, 99);
    expect(existsSync(join(dir, ADOPTED_FILE))).toBe(true);
    clearAdopted(dir, 4242);
    expect(existsSync(join(dir, ADOPTED_FILE))).toBe(false);
    clearAdopted(dir, 4242);
  });
});

describe('dropAdopted', () => {
  it('removes the file whoever vouches for it', () => {
    writeAdopted(dir, { by: process.pid, pids: [11] });
    dropAdopted(dir);
    expect(readAdopted(dir)).toBeNull();
    expect(existsSync(join(dir, ADOPTED_FILE))).toBe(false);
  });

  it('does nothing when there is no file', () => {
    expect(() => dropAdopted(dir)).not.toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('with the branch state store', () => {
  it('the files stay on this machine', () => {
    expect(committable(PID_FILE)).toBe(false);
    expect(committable(STOPPED_FILE)).toBe(false);
    expect(committable(ADOPTED_FILE)).toBe(false);
    expect(ADOPTED_FILE).toBe('supervisor-adopted.json');
    expect(PID_FILE).toBe('supervisor.pid');
    expect(STOPPED_FILE).toBe('service-stopped');
  });
});

describe('pidExists', () => {
  it('is true for a process that runs, and false for one that does not', () => {
    expect(pidExists(process.pid)).toBe(true);
    const gone = spawnSync(process.execPath, ['-e', '0']);
    expect(pidExists(gone.pid)).toBe(false);
  });
});
