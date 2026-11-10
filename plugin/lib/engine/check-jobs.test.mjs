import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { endCheckJobs, jobFiles, JOB_ID, jobsDir, killLeftGroup, listJobs, groupOurs, newJobId, pidAlive, pruneJobs, readJob, readResult, removeJob, workerAlive, writeJob, writeResult } from './check-jobs.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foreman-check-jobs-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const job = (id, extra = {}) => ({ id, pid: 4242, slot: 'w1', story: 'ACME-1', cwd: '/x', args: ['--changed'], startedAt: '2026-10-30T10:00:00.000Z', ...extra });
const gone = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

describe('newJobId', () => {
  it('matches JOB_ID, starts with the slot or here, and differs between randoms', () => {
    const now = new Date('2026-10-30T10:00:00Z');
    const a = newJobId({ slot: 'w2', now, random: () => 'aaaaaa' });
    const b = newJobId({ slot: 'w2', now, random: () => 'bbbbbb' });
    expect(a).toMatch(JOB_ID);
    expect(a.startsWith('w2-')).toBe(true);
    expect(a).not.toBe(b);
    expect(newJobId({ slot: null, now })).toMatch(/^here-/);
    expect(newJobId({ slot: '', now })).toMatch(JOB_ID);
  });

  it('cleans a slot that holds a path or other odd characters, so the id always matches JOB_ID', () => {
    const now = new Date('2026-10-30T10:00:00Z');
    for (const slot of ['../../x', 'a/b', '..', '-w1', 'w 1', 'x'.repeat(200)]) {
      const id = newJobId({ slot, now });
      expect(id).toMatch(JOB_ID);
      expect(id).not.toContain('/');
      expect(id).not.toContain('.');
    }
    expect(newJobId({ slot: '../..', now })).toMatch(/^here-/);
    expect(newJobId({ slot: 'w2', now }).startsWith('w2-')).toBe(true);
  });

  it('JOB_ID refuses a path', () => {
    for (const bad of ['../x', 'a/b', '', '-a', 'a b', '..']) expect(JOB_ID.test(bad)).toBe(false);
  });
});

describe('job and result files', () => {
  it('round-trip, and read null when missing or not JSON', () => {
    expect(readJob(dir, 'a')).toBeNull();
    expect(readResult(dir, 'a')).toBeNull();
    writeJob(dir, job('a'));
    writeResult(dir, 'a', { exit: 3, endedAt: '2026-10-30T10:05:00.000Z' });
    expect(readJob(dir, 'a')).toEqual(job('a'));
    expect(readResult(dir, 'a')).toEqual({ exit: 3, endedAt: '2026-10-30T10:05:00.000Z' });
    writeFileSync(jobFiles(dir, 'b').job, '{nope');
    writeFileSync(jobFiles(dir, 'b').result, '{nope');
    expect(readJob(dir, 'b')).toBeNull();
    expect(readResult(dir, 'b')).toBeNull();
  });

  it('keeps supersededBy when it is given (a job id or null) and leaves it out when it is not', () => {
    writeResult(dir, 'a', { exit: 1, endedAt: 'x', supersededBy: 'w1-new-1' });
    expect(readResult(dir, 'a')).toEqual({ exit: 1, endedAt: 'x', supersededBy: 'w1-new-1' });
    writeResult(dir, 'b', { exit: 1, endedAt: 'x', supersededBy: null });
    expect(readResult(dir, 'b')).toEqual({ exit: 1, endedAt: 'x', supersededBy: null });
    expect('supersededBy' in readResult(dir, 'b')).toBe(true);
    writeResult(dir, 'c', { exit: 0, endedAt: 'x' });
    expect('supersededBy' in readResult(dir, 'c')).toBe(false);
  });

  it('leaves no temp file behind', () => {
    writeJob(dir, job('a'));
    writeResult(dir, 'a', { exit: 0, endedAt: 'x' });
    expect(readdirSync(jobsDir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('listJobs skips results, and is empty with no folder', () => {
    expect(listJobs(dir)).toEqual([]);
    writeJob(dir, job('a'));
    writeJob(dir, job('b'));
    writeResult(dir, 'a', { exit: 0, endedAt: 'x' });
    writeFileSync(jobFiles(dir, 'c').job, 'bad');
    expect(listJobs(dir).map((j) => j.id).sort()).toEqual(['a', 'b']);
  });

  it('removeJob removes all four files', () => {
    writeJob(dir, job('a'));
    writeResult(dir, 'a', { exit: 0, endedAt: 'x' });
    writeFileSync(jobFiles(dir, 'a').out, 'o');
    writeFileSync(jobFiles(dir, 'a').err, 'e');
    removeJob(dir, 'a');
    expect(readdirSync(jobsDir(dir))).toEqual([]);
  });
});

describe('pidAlive', () => {
  it('is true for this process and false for anything else', () => {
    expect(pidAlive(process.pid)).toBe(true);
    for (const bad of [0, 1, -1, 'x', null, 1.5]) expect(pidAlive(bad, () => {})).toBe(false);
    const esrch = () => { throw Object.assign(new Error('x'), { code: 'ESRCH' }); };
    const eperm = () => { throw Object.assign(new Error('x'), { code: 'EPERM' }); };
    expect(pidAlive(4242, esrch)).toBe(false);
    expect(pidAlive(4242, eperm)).toBe(true);
    expect(pidAlive(4242, () => true)).toBe(true);
  });
});

describe('workerAlive and groupOurs', () => {
  const esrch = () => { throw Object.assign(new Error('x'), { code: 'ESRCH' }); };
  const eperm = () => { throw Object.assign(new Error('x'), { code: 'EPERM' }); };
  const ps = (stdout, status = 0) => () => ({ status, stdout });
  const j = job('w1-abc-123456', { pid: 501 });
  const worker = 'node /p/check-job.mjs /repo /repo/.foreman w1-abc-123456 --changed\n';

  it("is true for that job's worker only", () => {
    expect(workerAlive(j, { kill: () => true, ps: ps(worker) })).toBe(true);
    expect(workerAlive(j, { kill: eperm, ps: ps(worker) })).toBe(true);
    expect(workerAlive(j, { kill: () => true, ps: ps('/usr/bin/vim notes.txt\n') })).toBe(false);
    expect(workerAlive(j, { kill: () => true, ps: ps('node /p/check-job.mjs /r /s w1-abc-1234567\n') })).toBe(false);
    expect(workerAlive(j, { kill: () => true, ps: ps('node /p/check-job.mjs /r /s other-id\n') })).toBe(false);
    expect(workerAlive(j, { kill: () => true, ps: ps('', 1) })).toBe(false);
    expect(workerAlive(j, { kill: esrch, ps: ps(worker) })).toBe(false);
    expect(workerAlive(null)).toBe(false);
  });

  describe('when ps cannot run, /proc/<pid>/stat', () => {
    const noPs = () => ({ error: new Error('ENOENT'), status: null, stdout: '' });
    const stat = (text) => {
      const asked = [];
      const fn = (pid) => {
        asked.push(pid);
        return text;
      };
      fn.asked = asked;
      return fn;
    };

    it('says a zombie has ended', () => {
      const procStat = stat('501 (node) Z 1 501 501');
      expect(workerAlive(j, { kill: () => true, ps: noPs, procStat })).toBe(false);
      expect(procStat.asked).toEqual([501]);
    });

    it('says a dead process has ended', () => {
      expect(workerAlive(j, { kill: () => true, ps: noPs, procStat: stat('501 (node) X 1') })).toBe(false);
    });

    it('reads the state after the last ), whatever the command name holds', () => {
      expect(workerAlive(j, { kill: () => true, ps: noPs, procStat: stat('501 (a) b) X 1') })).toBe(false);
      expect(workerAlive(j, { kill: () => true, ps: noPs, procStat: stat('501 (a Z) S 1') })).toBe(true);
    });

    it('says a running or sleeping process is alive', () => {
      expect(workerAlive(j, { kill: () => true, ps: noPs, procStat: stat('501 (node) S 1') })).toBe(true);
      expect(workerAlive(j, { kill: () => true, ps: noPs, procStat: stat('501 (node) R 1') })).toBe(true);
    });

    it('falls back to the kill check when there is no /proc', () => {
      expect(workerAlive(j, { kill: () => true, ps: noPs, procStat: () => null })).toBe(true);
      expect(workerAlive(j, { kill: esrch, ps: noPs, procStat: () => null })).toBe(false);
    });

    it('lets the kill check win over a live state', () => {
      expect(workerAlive(j, { kill: esrch, ps: noPs, procStat: stat('501 (node) S 1') })).toBe(false);
    });

    it('is never read when ps runs', () => {
      const procStat = stat('501 (node) Z 1');
      expect(workerAlive(j, { kill: () => true, ps: ps(worker), procStat })).toBe(true);
      expect(workerAlive(j, { kill: () => true, ps: ps('/usr/bin/vim\n'), procStat })).toBe(false);
      expect(procStat.asked).toEqual([]);
    });

    it('groupOurs passes it through: a zombie worker is not a live worker', () => {
      expect(groupOurs(j, { kill: () => true, ps: noPs, procStat: stat('501 (node) Z 1') })).toBe(false);
      expect(groupOurs(j, { kill: () => true, ps: noPs, procStat: stat('501 (node) S 1') })).toBe(true);
    });
  });

  describe('groupOurs', () => {
    const groupOnly = (target) => { if (target > 0) throw Object.assign(new Error('x'), { code: 'ESRCH' }); };

    it('accepts a live worker, with or without left', () => {
      expect(groupOurs(j, { kill: () => true, ps: ps(worker) })).toBe(true);
      expect(groupOurs(j, { kill: () => true, ps: ps(worker), left: true })).toBe(true);
    });

    it('refuses a group a gone worker left, unless left is asked for', () => {
      expect(groupOurs(j, { kill: groupOnly, ps: ps('') })).toBe(false);
      expect(groupOurs(j, { kill: groupOnly, ps: ps(''), left: true })).toBe(true);
    });

    it('refuses a pid that now belongs to another program, with or without left', () => {
      expect(groupOurs(j, { kill: () => true, ps: ps('/usr/bin/vim\n') })).toBe(false);
      expect(groupOurs(j, { kill: () => true, ps: ps('/usr/bin/vim\n'), left: true })).toBe(false);
    });

    it('refuses a group it may not signal, a gone group and pid 1', () => {
      const epermGroup = (t) => { if (t < 0) throw Object.assign(new Error('x'), { code: 'EPERM' }); throw Object.assign(new Error('x'), { code: 'ESRCH' }); };
      expect(groupOurs(j, { kill: epermGroup, ps: ps(''), left: true })).toBe(false);
      expect(groupOurs(j, { kill: esrch, ps: ps(''), left: true })).toBe(false);
      expect(groupOurs({ ...j, pid: 1 }, { left: true })).toBe(false);
      expect(groupOurs({ ...j, pid: 1 })).toBe(false);
    });
  });
});

describe('killLeftGroup', () => {
  const esrchFor = (code = 'ESRCH') => Object.assign(new Error('x'), { code });
  const j = job('w1-abc-123456', { pid: 501 });
  const ps = (stdout, status = 0) => () => ({ status, stdout });

  it('sends SIGKILL to the group a gone worker left, and says so', () => {
    const calls = [];
    const kill = (target, sig) => {
      if (target > 0) throw esrchFor();
      calls.push([target, sig]);
    };
    expect(killLeftGroup(j, { kill, ps: ps('') })).toBe(true);
    expect(calls).toEqual([[-501, 0], [-501, 'SIGKILL']]);
  });

  it('sends nothing when the pid now shows another program', () => {
    const calls = [];
    const kill = (target, sig) => { calls.push([target, sig]); };
    expect(killLeftGroup(j, { kill, ps: ps('/usr/bin/vim\n') })).toBe(false);
    expect(calls.filter(([, sig]) => sig === 'SIGKILL')).toEqual([]);
  });

  it('sends nothing when the group is gone', () => {
    const calls = [];
    const kill = (target, sig) => { calls.push([target, sig]); throw esrchFor(); };
    expect(killLeftGroup(j, { kill, ps: ps('') })).toBe(false);
    expect(calls.filter(([, sig]) => sig === 'SIGKILL')).toEqual([]);
  });

  it('does not throw when the signal throws', () => {
    const kill = (target, sig) => {
      if (target > 0) throw esrchFor();
      if (sig === 'SIGKILL') throw new Error('boom');
    };
    expect(() => killLeftGroup(j, { kill, ps: ps('') })).not.toThrow();
    expect(killLeftGroup(j, { kill, ps: ps('') })).toBe(false);
  });
});

describe('endCheckJobs', () => {
  const seed = () => {
    for (const id of ['run', 'done', 'kept', 'dead']) {
      writeJob(dir, job(id, { pid: { run: 11, done: 12, kept: 13, dead: 14 }[id] }));
      writeFileSync(jobFiles(dir, id).out, 'o');
      writeFileSync(jobFiles(dir, id).err, 'e');
    }
    writeResult(dir, 'done', { exit: 0, endedAt: 'x' });
  };

  it('signals only jobs that are not kept, have no result and are alive; removes every job not kept', () => {
    seed();
    const sent = [];
    const out = endCheckJobs(dir, {
      keep: (j) => j.id === 'kept',
      groupAlive: (pid) => pid !== 14,
      kill: (pid, sig) => sent.push([pid, sig]),
    });
    expect(sent).toEqual([[11, 'SIGTERM']]);
    expect(out.ended.map((j) => j.id)).toEqual(['run']);
    expect(listJobs(dir).map((j) => j.id)).toEqual(['kept']);
    expect(readdirSync(jobsDir(dir)).sort()).toEqual(['kept.err', 'kept.json', 'kept.out']);
  });

  it('does not throw when a kill throws', () => {
    seed();
    const out = endCheckJobs(dir, { groupAlive: () => true, kill: () => { throw new Error('boom'); } });
    expect(out.ended.map((j) => j.id).sort()).toEqual(['dead', 'kept', 'run']);
    expect(listJobs(dir)).toEqual([]);
  });

  it('does nothing with no folder', () => {
    expect(endCheckJobs(join(dir, 'none'))).toEqual({ ended: [] });
  });

  it('signals nothing when the pid now belongs to another program, and still removes the job', async () => {
    const other = spawn('sh', ['-c', 'sleep 30; sleep 30'], { detached: true, stdio: 'ignore' });
    other.unref();
    try {
      writeJob(dir, job('reused', { pid: other.pid }));
      const out = endCheckJobs(dir);
      expect(out.ended).toEqual([]);
      expect(listJobs(dir)).toEqual([]);
      await new Promise((r) => setTimeout(r, 300));
      expect(gone(other.pid)).toBe(false);
    } finally {
      process.kill(-other.pid, 'SIGKILL');
    }
  });

  it('signals nothing to a group a gone worker left, but still removes the job', () => {
    writeJob(dir, job('left', { pid: 11 }));
    writeFileSync(jobFiles(dir, 'left').out, 'o');
    const groupOnly = (target) => { if (target > 0) throw Object.assign(new Error('x'), { code: 'ESRCH' }); };
    const sent = [];
    const out = endCheckJobs(dir, { groupAlive: (_pid, j) => groupOurs(j, { kill: groupOnly, ps: () => ({ status: 0, stdout: '' }) }), kill: (pid, sig) => sent.push([pid, sig]) });
    expect(sent).toEqual([]);
    expect(out.ended).toEqual([]);
    expect(readdirSync(jobsDir(dir))).toEqual([]);
  });

  it('does not take the worker of another job for this one', () => {
    writeJob(dir, job('mine', { pid: 11 }));
    const sent = [];
    const ps = () => ({ status: 0, stdout: 'node /p/check-job.mjs /r /s other-id\n' });
    const out = endCheckJobs(dir, { groupAlive: (_pid, j) => groupOurs(j, { kill: () => true, ps }), kill: (pid, sig) => sent.push([pid, sig]) });
    expect(sent).toEqual([]);
    expect(out.ended).toEqual([]);
  });

  it('ends a real detached process', async () => {
    const child = spawn('sh', ['-c', 'sleep 30; sleep 30', 'check-job.mjs', 'real'], { detached: true, stdio: 'ignore' });
    child.unref();
    writeJob(dir, job('real', { pid: child.pid }));
    const out = endCheckJobs(dir);
    expect(out.ended.map((j) => j.id)).toEqual(['real']);
    for (let i = 0; i < 20 && !gone(child.pid); i++) await new Promise((r) => setTimeout(r, 100));
    expect(gone(child.pid)).toBe(true);
    expect(existsSync(jobFiles(dir, 'real').job)).toBe(false);
  });
});

describe('pruneJobs', () => {
  it('removes old finished jobs and old dead ones, keeps fresh and running ones', () => {
    const now = new Date('2026-10-31T12:00:00Z');
    const old = '2026-10-30T10:00:00.000Z';
    const fresh = '2026-10-31T11:00:00.000Z';
    writeJob(dir, job('oldres', { startedAt: old }));
    writeResult(dir, 'oldres', { exit: 0, endedAt: old });
    writeJob(dir, job('olddead', { startedAt: old, pid: 99 }));
    writeJob(dir, job('fresh', { startedAt: fresh }));
    writeResult(dir, 'fresh', { exit: 0, endedAt: fresh });
    writeJob(dir, job('running', { startedAt: old, pid: 77 }));
    pruneJobs(dir, { now, alive: (pid) => pid === 77 });
    expect(listJobs(dir).map((j) => j.id).sort()).toEqual(['fresh', 'running']);
    expect(existsSync(jobFiles(dir, 'oldres').result)).toBe(false);
  });
});
