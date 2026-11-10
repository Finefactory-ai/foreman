// `foreman run`: its arguments, starting in the background and restarting on new code, with
// fakes for the supervisor. The branch store is in run-branch.test.mjs, and the describes that
// start the real bin in run-real.test.mjs; the project these use is test/run-command-fixture.mjs.

import { beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { main } from '../main.mjs';
import { nextStory, readControl } from '../../console/control.mjs';
import { saveState } from '../../engine/state.mjs';
import { makeRunCommand, startDetached, startSupervisor, superviseChild } from './run.mjs';
import { ADOPTED_FILE, markStopped, writeAdopted, writePid } from '../../engine/supervisor-pid.mjs';
import { proj, withRunProject } from '../../../../test/run-command-fixture.mjs';

withRunProject();

async function run(argv) {
  let out = '';
  let err = '';
  const code = await main(argv, {
    cwd: proj,
    env: { FOREMAN_PROJECT_DIR: proj },
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
  });
  return { code, out, err };
}

describe('foreman run arguments', () => {
  it('refuses more workers than slots', async () => {
    const r = await run(['run', '--workers', '9']);
    expect(r.code).toBe(64);
    expect(r.err).toContain('1 to 3');
  });

  it('refuses a worker count that is not a whole number, and unknown arguments', async () => {
    expect((await run(['run', '--workers', '0'])).code).toBe(64);
    expect((await run(['run', '--workers', 'two'])).code).toBe(64);
    expect((await run(['run', '--workers'])).code).toBe(64);
    expect((await run(['run', 'many'])).code).toBe(64);
    expect((await run(['run', '--fast'])).code).toBe(64);
  });

  it('stops at an invalid config', async () => {
    writeFileSync(join(proj, 'foreman.config.json'), '{');
    const r = await run(['run', '--dry-run']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('not valid JSON');
  });
});

// Real git clones and pushes against a local remote: slow on a loaded machine.
describe('foreman run in the background', () => {
  const state = () => join(proj, '.foreman');
  const fakeChild = (pid) => {
    const child = new EventEmitter();
    child.pid = pid;
    child.unrefs = 0;
    child.unref = () => {
      child.unrefs++;
    };
    return child;
  };
  const writeConfig = (extra = {}) =>
    writeFileSync(join(proj, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'Acme' }, slots: 3, checks: [{ run: 'true', when: 'always' }], stories: { adapter: 'markdown', dir: 'stories' }, install: null, ...extra }));

  // `foreman run <args>` with a fake spawn. `child(c, sleeps)` acts as the supervisor would, on
  // each poll: sleeps counts the polls so far.
  const runBg = async (args, { child: act = (c, n) => { if (n === 2) writePid(state(), c.pid); }, env: extraEnv = {}, ...deps } = {}) => {
    const seen = { spawns: [], foreground: 0 };
    let polls = 0;
    let current;
    const command = makeRunCommand({
      startSupervisor: async ({ args: argv }) => {
        seen.foreground++;
        seen.argv = argv;
        return 0;
      },
      startDetached: (o) =>
        startDetached({
          ...o,
          spawn: (cmd, argv, opts) => {
            current = fakeChild(5151);
            seen.spawns.push({ cmd, argv, opts, child: current });
            return current;
          },
          sleep: async () => {
            polls++;
            act(current, polls);
            await new Promise((r) => setImmediate(r));
          },
        }),
      openService: () => null,
      alive: () => false,
      ...deps,
    });
    let out = '';
    let err = '';
    const code = await command.run(args, { cwd: proj, root: proj, env: { FOREMAN_PROJECT_DIR: proj, PATH: process.env.PATH, ...extraEnv }, stdout: { write: (t) => { out += t; } }, stderr: { write: (t) => { err += t; } } });
    return { code, out, err, seen };
  };
  beforeEach(() => writeConfig());

  it('starts the supervisor in its own session, and returns once it has written its pid', async () => {
    const r = await runBg(['2']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.seen.foreground).toBe(0);
    expect(r.seen.spawns).toHaveLength(1);
    const { cmd, argv, opts, child } = r.seen.spawns[0];
    expect(cmd).toBe(process.execPath);
    // The detached child runs startSupervisor, so a background run restarts on new code too.
    expect(argv[0]).toMatch(/cli[\\/]run-in-background\.mjs$/);
    expect(argv.slice(1)).toEqual(['--max', '2']);
    expect(opts).toMatchObject({ cwd: proj, detached: true });
    expect(opts.env).toMatchObject({ FOREMAN_RUN: '1', FOREMAN_PROJECT_DIR: proj });
    expect(opts.stdio[0]).toBe('ignore');
    expect(typeof opts.stdio[1]).toBe('number');
    expect(opts.stdio[2]).toBe(opts.stdio[1]);
    expect(child.unrefs).toBe(1);
    expect(r.out).toContain('Foreman is running in the background (pid 5151).');
    expect(r.out).toContain('Dashboard: http://127.0.0.1:4317/');
    expect(r.out).toContain(`Log: ${join(state(), 'logs', 'supervisor.out')}`);
    expect(r.out).toContain('`foreman status` shows progress');
    expect(existsSync(join(state(), 'logs', 'supervisor.out'))).toBe(true);
  });

  it('prints the pid the supervisor wrote, not its launcher\'s, and ignores a stale pid file', async () => {
    writePid(state(), 4040);
    const r = await runBg(['2'], { child: (c, n) => { if (n === 2) writePid(state(), 6161); } });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain('Foreman is running in the background (pid 6161).');
  });

  it('prints no dashboard with another console', async () => {
    writeConfig({ console: { adapter: 'files' } });
    const r = await runBg([]);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('Dashboard');
  });

  it('brackets an IPv6 dashboard host', async () => {
    writeConfig({ console: { adapter: 'dashboard', host: '::1', port: 5000 } });
    const r = await runBg([]);
    expect(r.out).toContain('Dashboard: http://[::1]:5000/');
  });

  it('says so, with the end of the log, when the supervisor stops as it starts', async () => {
    const r = await runBg([], {
      child: (c, n) => {
        if (n !== 1) return;
        writeFileSync(join(state(), 'logs', 'supervisor.out'), 'old line\nforeman.config.json slots: must be a number\n', { flag: 'a' });
        c.emit('exit', 1, null);
      },
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain('The supervisor stopped as it started:');
    expect(r.err).toContain('slots: must be a number');
    expect(r.out).not.toContain('running in the background');
  });

  it('reports a supervisor that finishes cleanly before its pid is seen, with the end of its log', async () => {
    const r = await runBg([], {
      child: (c, n) => {
        if (n !== 1) return;
        writeFileSync(join(state(), 'logs', 'supervisor.out'), 'Nothing left to build.\n', { flag: 'a' });
        c.emit('exit', 0, null);
      },
    });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain('The supervisor finished as it started:');
    expect(r.out).toContain('Nothing left to build.');
    expect(r.out).not.toContain('running in the background');
  });

  it('prints no pid when the supervisor has not written its pid in time, only where to look', async () => {
    const r = await runBg([], { child: () => {} });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain('Started the supervisor in the background; it has not written its pid yet.');
    expect(r.out).toContain(join(state(), 'logs', 'supervisor.out'));
    expect(r.out).not.toContain('pid 5151');
    expect(r.out).not.toContain('running in the background (pid');
  });

  it('refuses a second run while one is going, before it changes anything', async () => {
    writePid(state(), 777);
    writeFileSync(join(state(), 'STOP'), 'x\n');
    const r = await runBg([], { alive: () => true });
    expect(r.code).toBe(1);
    expect(r.err).toContain('Foreman is already running (pid 777).');
    expect(r.seen.spawns).toHaveLength(0);
    expect(r.seen.foreground).toBe(0);
    expect(existsSync(join(state(), 'STOP'))).toBe(true);
    const svc = await runBg(['--service'], { alive: () => true });
    expect(svc.code).toBe(0);
    expect(svc.seen.foreground).toBe(0);
  });

  it('lets a dry run go alongside a live one', async () => {
    writePid(state(), 777);
    const r = await runBg(['--dry-run'], { alive: () => true });
    expect(r.code).toBe(0);
    expect(r.seen.foreground).toBe(1);
  });

  describe('stale control left by an earlier run', () => {
    const events = () => (existsSync(join(state(), 'events.jsonl')) ? readFileSync(join(state(), 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).text) : []);
    // A handled build-next request, and an adopted file whose voucher is gone.
    const leave = () => {
      nextStory(state(), 'ACME-1', new Date('2026-11-01T09:00:00Z'));
      saveState(state(), { loop: { state: 'stopped' }, handledNextAt: readControl(state()).requestedAt });
      writeAdopted(state(), { by: 15565, pids: [15500] });
    };

    it('clears a handled request and a dead voucher, with one event', async () => {
      leave();
      const r = await runBg(['2'], { pidExists: (pid) => pid !== 15565 });
      expect(r.code).toBe(0);
      expect(readControl(state()).nextStory).toBeUndefined();
      expect(readControl(state()).requestedAt).toBeTruthy();
      expect(existsSync(join(state(), ADOPTED_FILE))).toBe(false);
      expect(events().filter((t) => t.startsWith('Cleared stale control'))).toEqual([
        'Cleared stale control: the build-next request for ACME-1, already handled; supervisor-adopted.json, which vouched for pid 15565 that is gone.',
      ]);
    });

    it('keeps a voucher whose process lives and an open request', async () => {
      nextStory(state(), 'ACME-1', new Date('2026-11-01T09:00:00Z'));
      writeAdopted(state(), { by: 15565, pids: [] });
      const r = await runBg(['2'], { pidExists: () => true });
      expect(r.code).toBe(0);
      expect(readControl(state()).nextStory).toBe('ACME-1');
      expect(existsSync(join(state(), ADOPTED_FILE))).toBe(true);
      expect(events()).toEqual([]);
    });

    it('a dry run clears nothing', async () => {
      leave();
      const r = await runBg(['--dry-run'], { pidExists: () => false });
      expect(r.code).toBe(0);
      expect(readControl(state()).nextStory).toBe('ACME-1');
      expect(existsSync(join(state(), ADOPTED_FILE))).toBe(true);
      expect(events()).toEqual([]);
    });
  });

  it('--foreground stays attached', async () => {
    const r = await runBg(['--foreground', '1']);
    expect(r.code).toBe(0);
    expect(r.seen.foreground).toBe(1);
    expect(r.seen.argv).toEqual(['--max', '1']);
    expect(r.seen.spawns).toHaveLength(0);
  });

  it('in a story session, stays in the foreground: never detached and never through the service', async () => {
    const svc = { label: 'ai.foreman.acme', starts: 0, installed: () => true, start() { this.starts++; return { ok: true }; } };
    for (const args of [[], ['1']]) {
      const r = await runBg(args, { env: { FOREMAN_RUN: '1' }, openService: () => svc });
      expect(r.code).toBe(0);
      expect(r.seen.spawns).toHaveLength(0);
      expect(r.seen.foreground).toBe(1);
      expect(r.err).toContain('A story session runs Foreman in the foreground');
    }
    expect(svc.starts).toBe(0);
    const none = await runBg([], { env: { FOREMAN_RUN: '1' } });
    expect(none.seen.spawns).toHaveLength(0);
    expect(none.seen.foreground).toBe(1);
  });

  describe('the leash in a story session', () => {
    // The env the foreground start gets, with parentPid 4242 standing in for the shell.
    const startEnv = async (env, args = []) => {
      let seenEnv = null;
      const r = await runBg(args, {
        env,
        parentPid: 4242,
        startSupervisor: async (o) => {
          seenEnv = o.env;
          return 0;
        },
      });
      expect(r.code).toBe(0);
      return seenEnv;
    };

    it("ties the run to the shell that started it", async () => {
      expect((await startEnv({ FOREMAN_RUN: '1' })).FOREMAN_LEASH_PID).toBe('4242');
      expect((await startEnv({ FOREMAN_RUN: '1' }, ['--foreground', '1'])).FOREMAN_LEASH_PID).toBe('4242');
    });

    it('keeps a leash already given, and replaces one that is not a pid above 1', async () => {
      expect((await startEnv({ FOREMAN_RUN: '1', FOREMAN_LEASH_PID: '777' })).FOREMAN_LEASH_PID).toBe('777');
      expect((await startEnv({ FOREMAN_RUN: '1', FOREMAN_LEASH_PID: '1' })).FOREMAN_LEASH_PID).toBe('4242');
    });

    it('adds no leash outside a story session', async () => {
      expect(Object.keys(await startEnv({}, ['--foreground']))).not.toContain('FOREMAN_LEASH_PID');
    });
  });

  it('--service waits for `foreman run` after a `foreman stop`, and leaves the marker', async () => {
    markStopped(state(), new Date());
    const r = await runBg(['--foreground', '--service']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Stopped with `foreman stop`; the service waits for `foreman run`.');
    expect(r.seen.foreground).toBe(0);
    expect(r.seen.spawns).toHaveLength(0);
    expect(existsSync(join(state(), 'service-stopped'))).toBe(true);
    const plain = await runBg(['--service']);
    expect(plain.seen.foreground).toBe(0);
  });

  it('--service runs in the foreground when not stopped, and keeps no marker of its own', async () => {
    const r = await runBg(['--service']);
    expect(r.code).toBe(0);
    expect(r.seen.foreground).toBe(1);
    expect(r.seen.argv).toEqual(['--max', '0']);
  });

  it('a plain run removes the stop marker', async () => {
    markStopped(state(), new Date());
    const r = await runBg([]);
    expect(r.code).toBe(0);
    expect(existsSync(join(state(), 'service-stopped'))).toBe(false);
  });

  it('starts the installed service instead of a process of its own', async () => {
    const svc = { label: 'ai.foreman.acme', starts: 0, installed: () => true, start() { this.starts++; writePid(state(), 888); return { ok: true }; } };
    markStopped(state(), new Date());
    const r = await runBg([], { openService: () => svc, alive: (pid) => pid === 888 });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(svc.starts).toBe(1);
    expect(r.seen.spawns).toHaveLength(0);
    expect(r.seen.foreground).toBe(0);
    expect(r.out).toContain('Foreman is running in the background (pid 888, the service ai.foreman.acme).');
    expect(r.out).toContain(`Log: ${join(state(), 'logs', 'supervisor.out')}`);
    expect(existsSync(join(state(), 'service-stopped'))).toBe(false);
  });

  it('says so when the installed service does not start', async () => {
    const svc = { label: 'ai.foreman.acme', installed: () => true, start: () => ({ ok: false, error: 'Bootstrap failed: 5: Input/output error' }) };
    const r = await runBg([], { openService: () => svc });
    expect(r.code).toBe(1);
    expect(r.err).toContain('The service ai.foreman.acme did not start: Bootstrap failed: 5: Input/output error');
    expect(r.out).not.toContain('running in the background');
    expect(r.seen.spawns).toHaveLength(0);
  });

  it('says the service was asked to start when it writes no pid in time', async () => {
    let polls = 0;
    const svc = { label: 'ai.foreman.acme', installed: () => true, start: () => ({ ok: true }) };
    const r = await runBg([], {
      openService: () => svc,
      pollSleep: async () => {
        polls++;
      },
      serviceWaitMs: 300,
    });
    expect(r.code).toBe(0);
    expect(polls).toBe(3);
    expect(r.out).toContain('Asked the service ai.foreman.acme to start; it has not written its pid yet.');
    expect(r.out).toContain(join(state(), 'logs', 'supervisor.out'));
    expect(r.out).not.toContain('running in the background');
  });

  it('with the service installed, refuses a story count, a worker count or --exit-when-idle, before it changes anything', async () => {
    mkdirSync(state(), { recursive: true });
    writeFileSync(join(state(), 'STOP'), 'x\n');
    const svc = { label: 'ai.foreman.acme', installed: () => true, start: () => ({ ok: true }) };
    for (const args of [['3'], ['--workers', '2'], ['--exit-when-idle']]) {
      const r = await runBg(args, { openService: () => svc });
      expect(r.code).toBe(64);
      expect(r.err).toContain('The service runs until stopped, on standby when there is nothing to build: for a story count or --exit-when-idle use `foreman run --foreground N`');
      expect(existsSync(join(state(), 'STOP'))).toBe(true);
    }
    const fg = await runBg(['--foreground', '3'], { openService: () => svc });
    expect(fg.code).toBe(0);
    expect(fg.seen.foreground).toBe(1);
  });
});

describe('superviseChild', () => {
  const fakes = () => {
    const proc = new EventEmitter();
    const child = new EventEmitter();
    child.signals = [];
    child.kill = (sig) => child.signals.push(sig);
    return { proc, child };
  };

  it('passes the stop signals on to the supervisor and waits for it to exit', async () => {
    const { proc, child } = fakes();
    const done = superviseChild(child, { proc, stderr: { write: () => {} } });
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) proc.emit(sig, sig);
    expect(child.signals).toEqual(['SIGINT', 'SIGTERM', 'SIGHUP']);
    child.emit('exit', 130, null);
    expect(await done).toBe(130);
    expect(['SIGINT', 'SIGTERM', 'SIGHUP'].map((s) => proc.listenerCount(s))).toEqual([0, 0, 0]);
  });

  it('gives the exit code, 130 for a signal, 1 when it could not start', async () => {
    let f = fakes();
    let done = superviseChild(f.child, { proc: f.proc, stderr: { write: () => {} } });
    f.child.emit('exit', 0, null);
    expect(await done).toBe(0);
    f = fakes();
    done = superviseChild(f.child, { proc: f.proc, stderr: { write: () => {} } });
    f.child.emit('exit', null, 'SIGKILL');
    expect(await done).toBe(130);
    f = fakes();
    let err = '';
    done = superviseChild(f.child, { proc: f.proc, stderr: { write: (t) => { err += t; } } });
    f.child.emit('error', new Error('ENOENT'));
    expect(await done).toBe(1);
    expect(err).toContain('ENOENT');
  });
});

describe('startSupervisor restarts the supervisor on new code', () => {
  const SUPERVISOR = fileURLToPath(new URL('../../engine/supervisor.mjs', import.meta.url));
  const fakeSpawn = () => {
    const calls = [];
    const children = [];
    const spawn = (cmd, argv, opts) => {
      const child = new EventEmitter();
      child.signals = [];
      child.kill = (sig) => child.signals.push(sig);
      calls.push({ cmd, argv, opts });
      children.push(child);
      return child;
    };
    return { spawn, calls, children };
  };
  const until = async (fn) => {
    for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setImmediate(r));
  };

  it('starts it again, the same way, when it exits 75, and passes signals to the new one', async () => {
    const f = fakeSpawn();
    const proc = new EventEmitter();
    const args = ['--max', '2', '--workers', '1'];
    const done = startSupervisor({ root: '/acme', env: { PATH: '/bin' }, args, stderr: { write: () => {} }, proc, spawn: f.spawn, node: () => '/opt/acme/bin/node' });
    expect(f.calls).toHaveLength(1);
    f.children[0].emit('exit', 75, null);
    await until(() => f.calls.length === 2);
    expect(f.calls).toHaveLength(2);
    for (const c of f.calls) {
      expect(c.cmd).toBe('/opt/acme/bin/node');
      expect(c.argv).toEqual([SUPERVISOR, ...args]);
      expect(c.opts).toMatchObject({ cwd: '/acme', stdio: 'inherit' });
      expect(c.opts.env).toMatchObject({ PATH: '/bin', FOREMAN_RUN: '1', FOREMAN_PROJECT_DIR: '/acme' });
    }
    expect(f.calls[0].opts.env).not.toHaveProperty('FOREMAN_RESTART');
    expect(f.calls[1].opts.env.FOREMAN_RESTART).toBe('1');
    proc.emit('SIGINT', 'SIGINT');
    expect(f.children[0].signals).toEqual([]);
    expect(f.children[1].signals).toEqual(['SIGINT']);
    f.children[1].emit('exit', 0, null);
    expect(await done).toBe(0);
  });

  it('returns any other exit code at once', async () => {
    for (const code of [0, 1, 2, 130]) {
      const f = fakeSpawn();
      const done = startSupervisor({ root: '/acme', env: {}, args: [], stderr: { write: () => {} }, proc: new EventEmitter(), spawn: f.spawn, node: () => '/opt/acme/bin/node' });
      f.children[0].emit('exit', code, null);
      expect(await done).toBe(code);
      expect(f.calls).toHaveLength(1);
    }
  });

  it('starts it, and starts it again after exit 75, on a Node that starts when its own does not', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreman-run-node-'));
    try {
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      symlinkSync(process.execPath, join(bin, 'node'));
      const standin = join(dir, 'standin-node');
      writeFileSync(standin, "#!/bin/sh\necho 'dyld[4242]: Library not loaded: /opt/homebrew/opt/simdjson/lib/libsimdjson.33.dylib' >&2\nexit 134\n");
      chmodSync(standin, 0o755);
      const f = fakeSpawn();
      const done = startSupervisor({ root: '/acme', env: { PATH: bin }, args: [], stderr: { write: () => {} }, proc: new EventEmitter(), spawn: f.spawn, execPath: standin });
      expect(f.calls[0].cmd).toBe(join(bin, 'node'));
      f.children[0].emit('exit', 75, null);
      await until(() => f.calls.length === 2);
      expect(f.calls[1].cmd).toBe(join(bin, 'node'));
      f.children[1].emit('exit', 0, null);
      expect(await done).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('starts on its own Node when that starts, even with another node earlier on the PATH', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreman-run-node-'));
    try {
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'node'), '#!/bin/sh\necho v0.0.1\n');
      chmodSync(join(bin, 'node'), 0o755);
      const f = fakeSpawn();
      const done = startSupervisor({ root: '/acme', env: { PATH: bin }, args: [], stderr: { write: () => {} }, proc: new EventEmitter(), spawn: f.spawn, execPath: process.execPath });
      expect(f.calls[0].cmd).toBe(process.execPath);
      f.children[0].emit('exit', 75, null);
      await until(() => f.calls.length === 2);
      expect(f.calls[1].cmd).toBe(process.execPath);
      f.children[1].emit('exit', 0, null);
      expect(await done).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('asks for the Node again at each start', async () => {
    const f = fakeSpawn();
    const nodes = ['/opt/acme/old/node', '/opt/acme/bin/node'];
    const done = startSupervisor({ root: '/acme', env: {}, args: [], stderr: { write: () => {} }, proc: new EventEmitter(), spawn: f.spawn, node: () => nodes.shift() });
    f.children[0].emit('exit', 75, null);
    await until(() => f.calls.length === 2);
    expect(f.calls.map((c) => c.cmd)).toEqual(['/opt/acme/old/node', '/opt/acme/bin/node']);
    f.children[1].emit('exit', 0, null);
    await done;
  });
});
