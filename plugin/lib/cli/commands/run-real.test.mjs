// `foreman run` through the real bin: the dry run, and a run detached for real that
// `foreman stop` ends. The rest of the command's tests are in run.test.mjs; the project both use
// is test/run-command-fixture.mjs.

import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FILE_LOCK } from '../../engine/file-locks.mjs';
import { forceSet } from '../../engine/locks.mjs';
import { readPid } from '../../engine/supervisor-pid.mjs';
import { fastTick } from '../../../../test/fast-tick.mjs';
import { cleanEnv, foreman, git, proj, tmp, withRunProject } from '../../../../test/run-command-fixture.mjs';
import { runForeman, useSupervisors } from '../../../../test/supervisors.mjs';

withRunProject();
// After the project's hooks, so it runs before them (vitest runs afterEach hooks last first).
useSupervisors();

describe('foreman run --dry-run', () => {
  it('prints the story each slot would start, and writes nothing', () => {
    const r = foreman('run', '--dry-run', '--workers', '2');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('would start S-1 (First thing) in w1');
    expect(r.stdout).toContain('would start S-2 (Second thing) in w2');
    expect(r.stdout).not.toContain('in w3');
    expect(existsSync(join(proj, '.foreman'))).toBe(false);
  });

  describe('stories a dead run left in hand', () => {
    // A dead run's claim names S-2 in a slot (w1 unless said).
    const deadClaim = (slot = 'w1') => {
      const dead = spawnSync(process.execPath, ['-e', '']).pid;
      mkdirSync(join(proj, '.foreman', 'claims'), { recursive: true });
      writeFileSync(join(proj, '.foreman', 'claims', 'S-2.json'), JSON.stringify({ pid: dead, slot, story: 'S-2', by: 'factory', at: new Date().toISOString() }));
    };

    it('with one worker, a higher-priority story starts first and the resume waits', () => {
      deadClaim();
      const r = foreman('run', '--dry-run', '--workers', '1');
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('would start S-1 (First thing) in w1');
      expect(r.stdout).not.toContain('resuming S-2');
    });

    it('with two workers, the resume takes the free slot, moved from its old one but not over the count', () => {
      deadClaim();
      const r = foreman('run', '--dry-run', '--workers', '2');
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('would start S-1 (First thing) in w1');
      expect(r.stdout).toContain('would start resuming S-2 in w2 (moved from w1)');
      expect(r.stdout).not.toContain('over the worker count');
    });

    it('with two workers and the old slot over the count, the resume takes the free slot and says so', () => {
      deadClaim('w3');
      const r = foreman('run', '--dry-run', '--workers', '2');
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('would start S-1 (First thing) in w1');
      expect(r.stdout).toContain('would start resuming S-2 in w2 (moved from w3, over the worker count)');
    });
  });

  it('starts no more than the stories asked for', () => {
    const r = foreman('run', '1', '--dry-run', '--workers', '2');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('would start S-1 (First thing) in w1');
    expect(r.stdout).not.toContain('S-2');
    expect(r.stdout).toContain('nothing to start in w2');
  });

  it('passes over a slot that is not idle', () => {
    mkdirSync(join(proj, '.foreman', 'slots'), { recursive: true });
    writeFileSync(join(proj, '.foreman', 'slots', 'w1.json'), JSON.stringify({ state: 'parked', reason: 'Parked by you.' }));
    const r = foreman('run', '--dry-run', '--workers', '2');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('w1 is parked');
    expect(r.stdout).toContain('would start S-1 (First thing) in w2');
  });

  describe('the workers setting', () => {
    const configWith = (extra) =>
      writeFileSync(join(proj, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'Acme' }, slots: 3, checks: [{ run: 'true', when: 'always' }], stories: { adapter: 'markdown', dir: 'stories' }, install: null, ...extra }));
    const localSettings = (values) => {
      mkdirSync(join(proj, '.foreman'), { recursive: true });
      writeFileSync(join(proj, '.foreman', 'settings.json'), JSON.stringify(values));
    };

    it('without --workers, runs as many slots as the team setting says', () => {
      configWith({ workers: 2 });
      const r = foreman('run', '--dry-run');
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('2 workers (the workers setting)');
      expect(r.stdout).toContain('would start S-2 (Second thing) in w2');
      expect(r.stdout).not.toContain('w3');
    });

    it('without --workers, takes the local value over the team one', () => {
      configWith({ workers: 1 });
      localSettings({ workers: 3 });
      const r = foreman('run', '--dry-run');
      expect(r.stdout).toContain('3 workers (the workers setting)');
      expect(r.stdout).toContain('nothing to start in w3');
    });

    it('--workers wins over the setting for that run', () => {
      configWith({ workers: 3 });
      const r = foreman('run', '--dry-run', '--workers', '1');
      expect(r.stdout).toContain('1 worker (--workers)');
      expect(r.stdout).not.toContain('w2');
    });

    it('a local slots below the team workers caps the workers, with a warning', () => {
      configWith({ workers: 3 });
      localSettings({ slots: 2 });
      const r = foreman('run', '--dry-run');
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('warning: Workers 3 is more than the 2 slots this run has; using 2.');
      expect(r.stdout).toContain('2 workers (the workers setting)');
      expect(r.stdout).not.toContain('w3');
    });
  });

  it('says when a slot has nothing to start', () => {
    const r = foreman('run', '--dry-run', '--workers', '3');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('would start S-1 (First thing) in w1');
    expect(r.stdout).toContain('would start S-2 (Second thing) in w2');
    expect(r.stdout).toContain('nothing to start in w3');
  });

  it('leaves out a story whose saved plan names a file a running story holds', () => {
    const dir = join(proj, '.foreman');
    mkdirSync(join(dir, 'plans'), { recursive: true });
    writeFileSync(join(dir, 'plans', 'S-1.json'), JSON.stringify({ ready: true, files: ['src/a.mjs'] }));
    forceSet(FILE_LOCK(dir, 'src/a.mjs'), { pid: process.pid, slot: 'w3', story: 'S-9', by: 'factory', at: new Date().toISOString(), path: 'src/a.mjs' });
    const r = foreman('run', '--dry-run', '--workers', '1');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('would start S-2 (Second thing) in w1');
    expect(r.stdout).not.toContain('would start S-1');
  });

  it('leaves out a lower-priority story whose saved plan names a file a higher-priority story waits on', () => {
    const dir = join(proj, '.foreman');
    mkdirSync(join(dir, 'plans'), { recursive: true });
    mkdirSync(join(dir, 'waits'), { recursive: true });
    writeFileSync(join(dir, 'waits', 'S-1.json'), JSON.stringify({ story: 'S-1', on: [], files: ['src/a.mjs'], at: new Date().toISOString(), deferrals: {} }));
    writeFileSync(join(dir, 'plans', 'S-2.json'), JSON.stringify({ ready: true, files: ['src/a.mjs'] }));
    const r = foreman('run', '--dry-run', '--workers', '2');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('would start S-1 (First thing) in w1');
    expect(r.stdout).toContain('nothing to start in w2');
    expect(r.stdout).not.toContain('would start S-2');
  });
}, 120_000);

describe('foreman run, detached for real', () => {
  const FAKE_CLAUDE = `#!/usr/bin/env node
setTimeout(() => {
  const id = process.env.FOREMAN_STORY;
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, result: 'Could not get further.\\nFACTORY_RESULT: blocked ' + id, total_cost_usd: 0, session_id: 'fake' }));
}, 5000);
`;
  const FAKE_GH = '#!/bin/sh\ncase "$1 $2" in\n  "pr list") echo "[]" ;;\n  *) exit 1 ;;\nesac\n';
  let pid = null;
  const isAlive = (p) => {
    try {
      process.kill(p, 0);
      return true;
    } catch {
      return false;
    }
  };
  afterEach(() => {
    if (pid && isAlive(pid)) process.kill(pid, 'SIGKILL');
    pid = null;
  });

  it('returns at once, leaves the supervisor in its own session, and `foreman stop` leaves the marker', async () => {
    writeFileSync(
      join(proj, 'foreman.config.json'),
      JSON.stringify({ version: 1, project: { name: 'Acme' }, slots: 1, checks: [{ run: 'true', when: 'always' }], stories: { adapter: 'markdown', dir: 'stories' }, install: null, console: { adapter: 'files' }, features: { keepAwake: false } }),
    );
    git(proj, 'commit', '--quiet', '-am', 'files console');
    git(proj, 'push', '--quiet', 'origin', 'main');
    const bin = join(tmp, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'claude'), FAKE_CLAUDE);
    writeFileSync(join(bin, 'gh'), FAKE_GH);
    chmodSync(join(bin, 'claude'), 0o755);
    chmodSync(join(bin, 'gh'), 0o755);
    const env = { ...cleanEnv(), PATH: `${bin}:${process.env.PATH}`, HOME: tmp, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...fastTick };
    const state = join(proj, '.foreman');

    const started = Date.now();
    const r = runForeman(['run', '1'], { cwd: proj, env, encoding: 'utf8', timeout: 10_000, stateDir: state });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.stdout).toContain('running in the background (pid');
    // `foreman run` waits only a few seconds for the pid file; under load the supervisor may
    // write it just after, so wait for it (bounded) rather than read it once.
    const pidBy = Date.now() + 20_000;
    while ((pid = readPid(state)) === null && Date.now() < pidBy) await new Promise((res) => setTimeout(res, 100));
    expect(pid).toBeGreaterThan(0);
    expect(isAlive(pid)).toBe(true);
    const pgid = (p) => spawnSync('ps', ['-o', 'pgid=', '-p', String(p)], { encoding: 'utf8' }).stdout.trim();
    expect(pgid(pid)).not.toBe('');
    expect(pgid(pid)).not.toBe(pgid(process.pid));

    const stop = runForeman(['stop'], { cwd: proj, env, encoding: 'utf8', timeout: 10_000, stateDir: state });
    expect(stop.status).toBe(0);
    expect(existsSync(join(state, 'service-stopped'))).toBe(true);

    const deadline = Date.now() + 45_000;
    while (existsSync(join(state, 'supervisor.pid')) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 250));
    expect(existsSync(join(state, 'supervisor.pid'))).toBe(false);
    expect(readFileSync(join(state, 'logs', 'supervisor.out'), 'utf8')).toContain('Stopped on request.');
  }, 60_000);
});
