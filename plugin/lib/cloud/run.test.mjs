import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { cloudRun } from './run.mjs';
import { foremanVersion } from './versions.mjs';
import { NOTHING_LEFT } from '../engine/scheduler.mjs';

let work;
let plugin;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-cloud-run-'));
  plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-cloud-run-plugin-'));
  fs.mkdirSync(path.join(plugin, '.claude-plugin'));
  fs.writeFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: foremanVersion() }));
});

const repoDir = () => path.join(work, 'repo');
const stateDir = () => path.join(work, 'state');
const CONFIG = { version: 1, project: { name: 'P' }, slots: 2, cloud: { envVars: ['RESEND_API_KEY'], idleMinutes: 3 } };

// The world outside: a git that "clones" by writing the project, gh, claude, the supervisor,
// the dashboard, the idle wait and the process's signals. `order` records what happened.
function world({ cloneFails = false, ffFails = false, supervisor = [], config = CONFIG } = {}) {
  const order = [];
  const seen = { supervisors: [], waits: [], dashboards: 0, closed: 0 };
  const proc = new EventEmitter();
  const endings = [...supervisor];
  const sh = (cmd, args = [], opts = {}) => {
    const line = [cmd, ...args].join(' ');
    if (cmd === 'gh' && args[0] === 'auth') order.push('gh auth setup-git');
    if (cmd === 'git' && args[0] === 'clone') {
      order.push('clone');
      if (cloneFails) return { status: 128, stdout: '', stderr: 'repository not found' };
      const dir = args[args.length - 1];
      fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'foreman.config.json'), JSON.stringify(config));
      seen.cloneArgs = args;
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'git' && args.includes('fetch')) order.push('fetch');
    if (cmd === 'git' && args.includes('merge')) {
      order.push('fast-forward');
      if (ffFails) return { status: 1, stdout: '', stderr: 'Not possible to fast-forward' };
    }
    if (cmd === 'git' && args[0] === 'config' && args[1] === 'user.email' && args.length === 2) return { status: 0, stdout: 'me@example.com\n', stderr: '' };
    if (line.startsWith('gh api user')) return { status: 0, stdout: 'octo\n', stderr: '' };
    if (line.startsWith('gh api repos/')) return { status: 0, stdout: 'true\n', stderr: '' };
    if (cmd === 'claude' && args[0] === '-p') {
      order.push('claude answers');
      return { status: 0, stdout: JSON.stringify({ type: 'result', is_error: false, result: 'ok' }), stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  const deps = {
    sh,
    fs,
    proc,
    startSupervisor: async ({ root, env, args, proc: relay }) => {
      order.push('supervisor');
      const end = endings.shift() ?? { code: 0, reason: NOTHING_LEFT };
      seen.supervisors.push({ root, env, args, envFile: fs.existsSync(path.join(root, '.env.local')) ? fs.readFileSync(path.join(root, '.env.local'), 'utf8') : null, foremanFile: fs.existsSync(path.join(root, '.env.foreman')) ? fs.readFileSync(path.join(root, '.env.foreman'), 'utf8') : null, stopAtStart: fs.existsSync(path.join(stateDir(), 'STOP')) });
      if (end.during) await end.during({ proc, relay });
      fs.mkdirSync(stateDir(), { recursive: true });
      fs.writeFileSync(path.join(stateDir(), 'state.json'), JSON.stringify({ loop: { state: 'stopped', reason: end.reason } }));
      return end.code;
    },
    startDashboard: async ({ host }) => {
      seen.dashboards++;
      seen.dashboardHost = host;
      return { server: { close: () => { seen.closed++; } }, url: `http://${host}:4317/` };
    },
    wait: async (ms) => {
      order.push('idle');
      seen.waits.push(ms);
    },
    now: () => new Date('2026-10-18T10:00:00Z'),
  };
  return { order, seen, deps, proc };
}

const ENV = () => ({ FOREMAN_REPO: 'acme/app', GH_TOKEN: 'ghp_x', ANTHROPIC_API_KEY: 'sk-ant-x', FOREMAN_PLUGIN_DIR: plugin, FOREMAN_WORK: work, RESEND_API_KEY: 're_secret' });

async function run(w, env = ENV()) {
  let out = '';
  let err = '';
  const code = await cloudRun({ env, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } }, ...w.deps });
  return { code, out, err };
}

describe('foreman cloud run', () => {
  it('goes through its steps in order: doctor, git, clone, the project checks, the env file, the supervisor', async () => {
    const w = world({ supervisor: [{ code: 0, reason: 'Stopped on request.' }] });
    const { code, out } = await run(w);
    expect(code).toBe(0);
    expect(w.order).toEqual(['claude answers', 'gh auth setup-git', 'clone', 'supervisor']);
    expect(out).toMatch(/^ok {4}GH_TOKEN$/m);
    expect(w.seen.cloneArgs).toEqual(['clone', '--quiet', '--branch', 'main', 'https://github.com/acme/app.git', repoDir()]);
    const s = w.seen.supervisors[0];
    expect(s.root).toBe(repoDir());
    expect(s.env.FOREMAN_STATE_DIR).toBe(stateDir());
  });

  it('writes the project keys to the env file when git ignores it, and keeps them from the supervisor', async () => {
    const w = world({ supervisor: [{ code: 0, reason: 'Stopped on request.' }] });
    const sh = w.deps.sh;
    w.deps.sh = (cmd, args, opts) => (cmd === 'git' && args[0] === 'check-ignore' ? { status: 0, stdout: '', stderr: '' } : sh(cmd, args, opts));
    const { out, err } = await run(w);
    const s = w.seen.supervisors[0];
    expect(s.foremanFile).toContain('RESEND_API_KEY=');
    expect(s.envFile).toBeNull();
    expect(s.env.RESEND_API_KEY).toBeUndefined();
    expect(s.env.GH_TOKEN).toBe('ghp_x');
    expect(out + err).not.toContain('re_secret');
  });

  it('never writes the keys to an env file git would commit', async () => {
    const w = world({ supervisor: [{ code: 0, reason: 'Stopped on request.' }] });
    const sh = w.deps.sh;
    w.deps.sh = (cmd, args, opts) => (cmd === 'git' && args[0] === 'check-ignore' ? { status: 1, stdout: '', stderr: '' } : sh(cmd, args, opts));
    const { err } = await run(w);
    expect(w.seen.supervisors[0].envFile).toBeNull();
    expect(w.seen.supervisors[0].foremanFile).toBeNull();
    expect(w.seen.supervisors[0].env.RESEND_API_KEY).toBeUndefined();
    expect(err).toMatch(/\.env\.foreman is not ignored by git/);
    expect(err).not.toContain('re_secret');
  });

  it('stops before anything else when a runner check fails', async () => {
    const w = world();
    const { code, err } = await run(w, { ...ENV(), GH_TOKEN: '' });
    expect(code).toBe(1);
    expect(w.order).not.toContain('clone');
    expect(err).toMatch(/Not starting/);
  });

  it('uses FOREMAN_BRANCH and FOREMAN_REPO_URL, and passes FOREMAN_WORKERS and FOREMAN_MAX on', async () => {
    const w = world({ supervisor: [{ code: 0, reason: 'Reached the 1 story asked for.' }] });
    await run(w, { ...ENV(), FOREMAN_BRANCH: 'trunk', FOREMAN_REPO_URL: '/srv/app.git', FOREMAN_WORKERS: '2', FOREMAN_MAX: '1' });
    expect(w.seen.cloneArgs).toEqual(['clone', '--quiet', '--branch', 'trunk', '/srv/app.git', repoDir()]);
    expect(w.seen.supervisors[0].args).toEqual(['--max', '1', '--workers', '2']);
  });

  it('refuses a worker count beyond the slots, or a story count that is not a number', async () => {
    let w = world();
    let r = await run(w, { ...ENV(), FOREMAN_WORKERS: '3' });
    expect(r.code).toBe(64);
    expect(r.err).toMatch(/1 to 2/);
    w = world();
    r = await run(w, { ...ENV(), FOREMAN_MAX: 'all' });
    expect(r.code).toBe(64);
    expect(w.order).not.toContain('supervisor');
  });

  it('fetches and fast-forwards a clone that is already there, instead of cloning', async () => {
    fs.mkdirSync(path.join(repoDir(), '.git'), { recursive: true });
    fs.writeFileSync(path.join(repoDir(), 'foreman.config.json'), JSON.stringify(CONFIG));
    const w = world({ supervisor: [{ code: 0, reason: 'Stopped on request.' }] });
    await run(w);
    expect(w.order).toEqual(['claude answers', 'gh auth setup-git', 'fetch', 'fast-forward', 'supervisor']);
  });

  it('stops when the clone cannot be fast-forwarded at start', async () => {
    fs.mkdirSync(path.join(repoDir(), '.git'), { recursive: true });
    fs.writeFileSync(path.join(repoDir(), 'foreman.config.json'), JSON.stringify(CONFIG));
    const w = world({ ffFails: true });
    const r = await run(w);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/fast-forward/);
    expect(w.order).not.toContain('supervisor');
  });

  it('stops when the clone fails', async () => {
    const w = world({ cloneFails: true });
    const r = await run(w);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/repository not found/);
  });

  it('clears an old STOP when the container starts', async () => {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(path.join(stateDir(), 'STOP'), 'old\n');
    const w = world({ supervisor: [{ code: 0, reason: 'Stopped on request.' }] });
    await run(w);
    expect(w.seen.supervisors[0].stopAtStart).toBe(false);
  });

  describe('the idle loop', () => {
    it('waits cloud.idleMinutes when nothing is left, pulls, and picks again; the dashboard stays up meanwhile', async () => {
      const w = world({ supervisor: [{ code: 0, reason: NOTHING_LEFT }, { code: 0, reason: NOTHING_LEFT }, { code: 0, reason: 'Stopped on request.' }] });
      const { code, out } = await run(w, { ...ENV(), FOREMAN_DASHBOARD_HOST: '0.0.0.0', FOREMAN_DASHBOARD_TOKEN: 't'.repeat(32) });
      expect(code).toBe(0);
      expect(w.order).toEqual(['claude answers', 'gh auth setup-git', 'clone', 'supervisor', 'idle', 'fetch', 'fast-forward', 'supervisor', 'idle', 'fetch', 'fast-forward', 'supervisor']);
      expect(w.seen.waits).toEqual([180_000, 180_000]);
      expect(w.seen.dashboards).toBe(2);
      expect(w.seen.closed).toBe(2);
      expect(w.seen.dashboardHost).toBe('0.0.0.0');
      expect(out).toMatch(/Nothing left to build; looking again in 3 minutes/);
    });

    it('asks the supervisor to exit when idle, so the container keeps its own idle loop', async () => {
      const w = world({ supervisor: [{ code: 0, reason: 'Stopped on request.' }] });
      await run(w);
      expect(w.seen.supervisors[0].args).toContain('--exit-when-idle');
    });

    it('does not loop after the stories asked for (FOREMAN_MAX)', async () => {
      const w = world({ supervisor: [{ code: 0, reason: NOTHING_LEFT }] });
      await run(w, { ...ENV(), FOREMAN_MAX: '1' });
      expect(w.order.filter((s) => s === 'supervisor')).toHaveLength(1);
      expect(w.order).not.toContain('idle');
    });

    it('carries on with the clone it has when a pull between backlogs fails', async () => {
      const w = world({ ffFails: false, supervisor: [{ code: 0, reason: NOTHING_LEFT }, { code: 0, reason: 'Stopped on request.' }] });
      const sh = w.deps.sh;
      let fetches = 0;
      w.deps.sh = (cmd, args, opts) => (cmd === 'git' && args.includes('fetch') && ++fetches >= 1 ? { status: 1, stdout: '', stderr: 'network down' } : sh(cmd, args, opts));
      const { code, err } = await run(w);
      expect(code).toBe(0);
      expect(err).toMatch(/network down/);
      expect(w.order.filter((s) => s === 'supervisor')).toHaveLength(2);
    });

    it('passes a failed supervisor exit code on, without looping', async () => {
      const w = world({ supervisor: [{ code: 1, reason: '' }] });
      expect((await run(w)).code).toBe(1);
      expect(w.order).not.toContain('idle');
    });
  });

  describe('the events echo', () => {
    const AT = '2026-10-18T10:00:00.000Z';
    const events = () => path.join(stateDir(), 'events.jsonl');
    const write = (...list) => {
      fs.mkdirSync(stateDir(), { recursive: true });
      fs.appendFileSync(events(), list.map(([text, kind, slot = null]) => JSON.stringify({ at: AT, text, kind, slot }) + '\n').join(''));
    };

    it('writes the events of the run to stdout, one line each: story starts and ends, halts, slots down', async () => {
      const w = world({
        supervisor: [{
          code: 0,
          reason: 'Stopped on request.',
          during: async () => write(['Slot w1: ACME-1', 'story', 'w1'], ['ACME-1 shipped', 'ok', 'w1'], ['Slot w2 is down: Its environment would not start: limit reached', 'warn', 'w2'], ['Factory halted: CI is red', 'warn']),
        }],
      });
      const { out } = await run(w);
      expect(out).toContain(`${AT} story w1 Slot w1: ACME-1\n`);
      expect(out).toContain(`${AT} ok w1 ACME-1 shipped\n`);
      expect(out).toContain(`${AT} warn w2 Slot w2 is down: Its environment would not start: limit reached\n`);
      expect(out).toContain(`${AT} warn - Factory halted: CI is red\n`);
    });

    it('does not repeat the events an earlier run left', async () => {
      write(['Slot w1: OLD-1', 'story', 'w1']);
      const w = world({ supervisor: [{ code: 0, reason: 'Stopped on request.', during: async () => write(['Slot w1: ACME-1', 'story', 'w1']) }] });
      const { out } = await run(w);
      expect(out).not.toContain('OLD-1');
      expect(out).toContain('Slot w1: ACME-1');
    });

    it('masks a key in an event', async () => {
      const w = world({ supervisor: [{ code: 0, reason: 'Stopped on request.', during: async () => write(['push failed with GH_TOKEN=ghp_x', 'warn']) }] });
      const { out } = await run(w);
      expect(out).toContain('push failed with GH_TOKEN=•••');
      expect(out).not.toContain('ghp_x\n');
      expect(out.match(/push failed.*/)[0]).not.toContain('ghp_x');
    });

    it('masks the bare value of a project key in an event, though the supervisor never gets the key', async () => {
      const config = { ...CONFIG, cloud: { ...CONFIG.cloud, envVars: ['RESEND_API_KEY', 'ACME_REGION'] } };
      const w = world({
        config,
        supervisor: [{
          code: 0,
          reason: 'Stopped on request.',
          during: async () => write(['Slot w2 is down: sign-in https://auth.acme.example/cb?refresh=AcmeRefreshValue123 refused', 'warn', 'w2'], ['eu region is slow', 'info']),
        }],
      });
      const { out } = await run(w, { ...ENV(), RESEND_API_KEY: 'AcmeRefreshValue123', ACME_REGION: 'eu' });
      expect(out).not.toContain('AcmeRefreshValue123');
      expect(out).toContain('refresh=••• refused');
      expect(out).toContain(`${AT} info - eu region is slow`);
      expect(w.seen.supervisors[0].env.RESEND_API_KEY).toBeUndefined();
    });

    it('goes on across the idle loop: the second run is echoed after "Nothing left to build"', async () => {
      const w = world({
        supervisor: [
          { code: 0, reason: NOTHING_LEFT, during: async () => write(['first run event', 'info']) },
          { code: 0, reason: 'Stopped on request.', during: async () => write(['second run event', 'info']) },
        ],
      });
      const { out } = await run(w);
      const first = out.indexOf('first run event');
      const idle = out.indexOf('Nothing left to build');
      const second = out.indexOf('second run event');
      expect(first).toBeGreaterThan(-1);
      expect(idle).toBeGreaterThan(first);
      expect(second).toBeGreaterThan(idle);
    });

    it('follows the log on a timer while the supervisor runs, and stops when the run ends', async () => {
      let during;
      const w = world({ supervisor: [{ code: 0, reason: 'Stopped on request.', during: async () => { await during(); } }] });
      const lines = [];
      during = async () => {
        write(['mid-run event', 'info']);
        for (let i = 0; i < 200 && !lines.some((l) => l.includes('mid-run event')); i++) await new Promise((r) => setTimeout(r, 10));
      };
      let out = '';
      const code = await cloudRun({ env: ENV(), stdout: { write: (s) => { out += s; lines.push(s); } }, stderr: { write: () => {} }, echoMs: 5, ...w.deps });
      expect(code).toBe(0);
      expect(lines.some((l) => l.includes('mid-run event'))).toBe(true);
      const count = lines.length;
      write(['after the run', 'info']);
      await new Promise((r) => setTimeout(r, 40));
      expect(lines).toHaveLength(count);
      expect(out).not.toContain('after the run');
    });
  });

  describe('signals', () => {
    it('the first SIGTERM asks the run to finish the stories in progress; a second stops it now', async () => {
      const w = world({
        supervisor: [{
          code: 130,
          reason: 'Interrupted',
          during: async ({ proc, relay }) => {
            const forwarded = [];
            relay.on('SIGTERM', (s) => forwarded.push(s));
            proc.emit('SIGTERM', 'SIGTERM');
            expect(fs.existsSync(path.join(stateDir(), 'STOP'))).toBe(true);
            // The STOP names the cloud runner as the stopper.
            expect(JSON.parse(fs.readFileSync(path.join(stateDir(), 'STOP'), 'utf8'))).toMatchObject({ via: 'cloud', pid: process.pid });
            expect(fs.existsSync(path.join(stateDir(), 'service-stopped'))).toBe(false);
            expect(forwarded).toEqual([]);
            proc.emit('SIGTERM', 'SIGTERM');
            expect(forwarded).toEqual(['SIGTERM']);
          },
        }],
      });
      const { code, out } = await run(w);
      expect(code).toBe(130);
      expect(out).toMatch(/finishing the stories in progress/i);
      expect(w.order).not.toContain('idle');
    });

    it('SIGINT is passed on at once', async () => {
      const w = world({
        supervisor: [{
          code: 130,
          reason: 'Interrupted',
          during: async ({ proc, relay }) => {
            const forwarded = [];
            relay.on('SIGINT', (s) => forwarded.push(s));
            proc.emit('SIGINT', 'SIGINT');
            expect(forwarded).toEqual(['SIGINT']);
          },
        }],
      });
      expect((await run(w)).code).toBe(130);
    });

    it('a SIGTERM while idle ends the run at once', async () => {
      const w = world({ supervisor: [{ code: 0, reason: NOTHING_LEFT }] });
      let aborted = false;
      w.deps.wait = (ms, { signal }) => new Promise((resolve) => signal.addEventListener('abort', () => { aborted = true; resolve(); })); // ends only on a stop
      const done = run(w);
      await new Promise((r) => setTimeout(r, 20));
      w.proc.emit('SIGTERM', 'SIGTERM');
      const { code } = await done;
      expect(code).toBe(0);
      expect(aborted).toBe(true);
      expect(w.seen.closed).toBe(1);
      expect(w.proc.listenerCount('SIGTERM')).toBe(0);
    });
  });
});
