// `foreman run` and the story sessions still running when it starts again, by any road: onto
// another Node when its own stops starting (the stand-in below), and fresh after the supervisor was
// killed. The new process adopts each live session instead of starting its story again beside it,
// and warns once about a folder that has two. The fixture is test/supervisor-restart-fixture.mjs.

import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  go,
  isUp,
  pidOf,
  runRecords,
  setup,
  slotState,
  slow,
  started,
  startRun,
  state,
  texts,
  until,
  withRestartRepos,
  repos,
} from '../../../test/supervisor-restart-fixture.mjs';
import { readAdopted, readPid } from './supervisor-pid.mjs';

withRestartRepos();

const DYLD = 'dyld[4242]: Library not loaded: /opt/acme/lib/libsimdjson.33.dylib';
const KEPT = 'Kept 2 running across the restart: ACME-2 (w1), ACME-4 (w2).';

// A Node laid out as Homebrew's is: <prefix>/Cellar/node/9.9.9/bin/node, a copy of this process's
// Node (with the lib folder it loads from, when it has one), so that the run's execPath is that
// path and Homebrew's link is <prefix>/bin/node. The link is not made until the test says.
function homebrewNode() {
  const prefix = join(realpathSync(repos.base), 'brew');
  const bin = join(prefix, 'Cellar', 'node', '9.9.9', 'bin');
  mkdirSync(bin, { recursive: true });
  const node = join(bin, 'node');
  copyFileSync(process.execPath, node);
  chmodSync(node, 0o755);
  const lib = join(dirname(dirname(process.execPath)), 'lib');
  if (existsSync(lib)) symlinkSync(lib, join(prefix, 'Cellar', 'node', '9.9.9', 'lib'));
  return {
    node,
    bin,
    link: join(prefix, 'bin', 'node'),
    makeLink() {
      mkdirSync(join(prefix, 'bin'), { recursive: true });
      symlinkSync(process.execPath, join(prefix, 'bin', 'node'));
    },
    // Replaced, never written over: the running processes keep the Node they loaded.
    breakIt() {
      const standIn = join(bin, 'node.new');
      writeFileSync(standIn, `#!/bin/sh\necho '${DYLD}' >&2\nexit 134\n`);
      chmodSync(standIn, 0o755);
      renameSync(standIn, node);
    },
  };
}

// The PATH of the run: the fakes, the Node under test, and the system folders (no other node;
// /usr/sbin is there for lsof, which the live sessions scan reads a session's folder with on macOS).
const pathWith = (...dirs) => [...dirs, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
const ageSeconds = (pid) => {
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'etime='], { encoding: 'utf8' });
  const m = String(r.stdout).trim().match(/(\d+):(\d+)$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
};
const commandOf = (pid) => String(spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).stdout).trim();

describe('the supervisor started again with story sessions still running', () => {
  it('restarts onto Homebrew\'s link when its Node stops starting, keeps the sessions it has, and starts none again', async () => {
    setup({ slots: 2, workers: 2 }, ['ACME-2', 'ACME-4']);
    const brew = homebrewNode();
    const run = startRun('go', [], { node: brew.node, env: { PATH: pathWith(join(repos.base, 'bin'), brew.bin) } });
    let extra;
    let code;
    try {
      expect(await until(() => started().length === 2 && readPid(state) !== null, 40_000), 'both sessions started and the supervisor wrote its pid').toBe(true);
      const old = readPid(state);
      expect(commandOf(old)).toContain(brew.node);
      // A second session in w1's folder, newer than the one the supervisor started (ps counts seconds).
      expect(await until(() => ageSeconds(pidOf('ACME-2')) >= 2, 20_000), 'ACME-2 has run for 2 s').toBe(true);
      const idle = join(repos.base, 'idle-session.mjs');
      writeFileSync(idle, 'setInterval(() => {}, 1000);\n');
      extra = spawn(process.execPath, [idle, '-p', '/foreman:story ACME-2', '--output-format', 'stream-json'], { cwd: join(state, 'worktrees', 'w1'), detached: true, stdio: 'ignore' });
      // Its Node stops starting; Homebrew's link is there, as after `brew upgrade`.
      brew.makeLink();
      brew.breakIt();
      expect(await until(() => texts().includes(KEPT), 60_000), 'the new process kept both sessions across the restart').toBe(true);
      const now = readPid(state);
      expect(now).not.toBe(old);
      expect(isUp(old)).toBe(false);
      expect(texts().some((t) => t.startsWith(`Restarted onto Node ${brew.link} (`) && t.endsWith(`: ${brew.node} no longer starts.`))).toBe(true);
      // The new process runs on the link, and vouches for the pid the sessions' claims name.
      expect(commandOf(now)).toContain(brew.link);
      expect(readAdopted(state)).toEqual({ by: now, pids: [old] });
      expect(isUp(pidOf('ACME-2'))).toBe(true);
      expect(isUp(pidOf('ACME-4'))).toBe(true);
      // One "Kept" event for the start, and the folder with two is warned about although its
      // session was handed over.
      expect(texts().filter((t) => t.startsWith('Kept '))).toHaveLength(1);
      const w1 = texts().filter((t) => t.startsWith('w1 has '));
      expect(w1).toHaveLength(1);
      expect(w1[0]).toBe(`w1 has 2 story sessions in its folder: ACME-2 (pid ${pidOf('ACME-2')}), ACME-2 (pid ${extra.pid}). Keeping ACME-2 (pid ${pidOf('ACME-2')}), the one kept across the restart; end the other with \`kill ${extra.pid}\`.`);

      writeFileSync(go, '');
      expect(await until(() => ['w1', 'w2'].every((s) => slotState(s) === 'idle') && ['ACME-2', 'ACME-4'].every((id) => runRecords().some((r) => r.story === id)), 30_000), 'both slots idle with run records for ACME-2 and ACME-4').toBe(true);
      expect(started().sort()).toEqual(['ACME-2', 'ACME-4']);
      expect(texts().filter((t) => t.startsWith('Start-up: resuming'))).toEqual([]);
      expect(runRecords().filter((r) => r.story === 'ACME-2')).toHaveLength(1);
      expect(runRecords().filter((r) => r.story === 'ACME-4')).toHaveLength(1);
    } finally {
      if (extra?.pid) {
        try {
          process.kill(-extra.pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
      code = await run.stop();
    }
    expect(code).toBe(0);
  }, slow(120_000));

  it('adopts the live sessions after the supervisor was killed, and warns once about a folder with two', async () => {
    setup({ slots: 2, workers: 2 }, ['ACME-2', 'ACME-4']);
    const first = startRun('go');
    let second;
    let extra;
    let code;
    try {
      expect(await until(() => started().length === 2 && readPid(state) !== null, 40_000), 'both sessions started and the supervisor wrote its pid').toBe(true);
      const old = readPid(state);
      // A second session in w1's folder, newer than the one the supervisor started (ps counts seconds).
      expect(await until(() => ageSeconds(pidOf('ACME-2')) >= 2, 20_000), 'ACME-2 has run for 2 s').toBe(true);
      const idle = join(repos.base, 'idle-session.mjs');
      writeFileSync(idle, 'setInterval(() => {}, 1000);\n');
      extra = spawn(process.execPath, [idle, '-p', '/foreman:story ACME-2', '--output-format', 'stream-json'], { cwd: join(state, 'worktrees', 'w1'), detached: true, stdio: 'ignore' });

      // The supervisor dies without a word; the sessions go on.
      process.kill(old, 'SIGKILL');
      await first.exited;
      expect(isUp(old)).toBe(false);
      expect(isUp(pidOf('ACME-2'))).toBe(true);
      expect(isUp(pidOf('ACME-4'))).toBe(true);

      second = startRun('go');
      expect(await until(() => texts().includes(KEPT), 40_000), 'the new process kept both sessions across the restart').toBe(true);
      const now = readPid(state);
      expect(now).not.toBe(old);
      expect(readAdopted(state)).toEqual({ by: now, pids: [old] });
      expect(texts().filter((t) => t.startsWith('Kept '))).toHaveLength(1);
      const w1 = texts().filter((t) => /^w1 has \d+ story sessions/.test(t));
      expect(w1).toHaveLength(1);
      expect(w1[0]).toBe(`w1 has 2 story sessions in its folder: ACME-2 (pid ${pidOf('ACME-2')}), ACME-2 (pid ${extra.pid}). Keeping ACME-2 (pid ${pidOf('ACME-2')}), the oldest; end the other with \`kill ${extra.pid}\`.`);
      expect(texts().filter((t) => /^w2 has/.test(t))).toEqual([]);

      writeFileSync(go, '');
      expect(await until(() => ['w1', 'w2'].every((s) => slotState(s) === 'idle') && ['ACME-2', 'ACME-4'].every((id) => runRecords().some((r) => r.story === id)), 30_000), 'both slots idle with run records for ACME-2 and ACME-4').toBe(true);
      expect(started().sort()).toEqual(['ACME-2', 'ACME-4']);
      expect(texts().filter((t) => t.startsWith('Start-up: resuming'))).toEqual([]);
      expect(runRecords().filter((r) => r.story === 'ACME-2')).toHaveLength(1);
    } finally {
      if (extra?.pid) {
        try {
          process.kill(-extra.pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
      code = await (second ?? first).stop();
    }
    expect(code).toBe(0);
  }, slow(120_000));
});
