// runAsync: a child command that never holds the event loop, with a time limit that ends its
// whole process group.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAsync } from './run-async.mjs';

const made = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'foreman-run-async-'));
  made.push(dir);
  return dir;
};
const gone = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err.code === 'ESRCH';
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('runAsync', () => {
  it('gives the status and the output', async () => {
    const r = await runAsync('sh', ['-c', 'echo hi'], { cwd: tempDir() });
    expect(r).toMatchObject({ status: 0, stdout: 'hi\n', stderr: '', timedOut: false });
    expect(typeof r.ms).toBe('number');
    expect(await runAsync('sh', ['-c', 'echo no >&2; exit 3'], { cwd: tempDir() })).toMatchObject({ status: 3, stderr: 'no\n' });
  });

  it('ends the whole group at the time limit', async () => {
    const dir = tempDir();
    const pidfile = join(dir, 'pids');
    const started = Date.now();
    const r = await runAsync('sh', ['-c', `echo $$ > "${pidfile}"; sleep 30 & echo $! >> "${pidfile}"; wait`], { cwd: dir, timeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(r.timedOut).toBe(true);
    const pids = readFileSync(pidfile, 'utf8').trim().split('\n').map(Number);
    expect(pids).toHaveLength(2);
    // The kill is sent; give the kernel a moment to reap.
    for (let i = 0; i < 20 && !pids.every(gone); i += 1) await sleep(50);
    for (const pid of pids) expect(gone(pid), String(pid)).toBe(true);
  });

  it('keeps the event loop turning while the child runs', async () => {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 10);
    try {
      const r = await runAsync('sleep', ['0.5'], { cwd: tempDir() });
      expect(r.status).toBe(0);
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(10);
  });

  it('settles a command that cannot start with an error, never a rejection', async () => {
    const r = await runAsync('acme-no-such-command-here', [], { cwd: tempDir() });
    expect(r.status).toBeNull();
    expect(typeof r.error).toBe('string');
    expect(r.error).not.toBe('');
    expect(r.timedOut).toBe(false);
  });

  it('holds the child in track while it runs, and lets it go after', async () => {
    const track = new Set();
    const running = runAsync('sleep', ['0.2'], { cwd: tempDir(), track });
    expect(track.size).toBe(1);
    expect([...track][0].pid).toBeGreaterThan(0);
    await running;
    expect(track.size).toBe(0);
  });

  it('keeps only the last keepBytes of each stream', async () => {
    const r = await runAsync('sh', ['-c', 'seq 1 5000'], { cwd: tempDir(), keepBytes: 100 });
    expect(r.stdout.length).toBeLessThanOrEqual(100);
    expect(r.stdout.endsWith('5000\n')).toBe(true);
  });
});
