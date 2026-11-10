import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../main.mjs';
import { pendingCommands, slotIdsFor } from '../../engine/scheduler.mjs';
import { add } from '../../console/decisions.mjs';
import { addToTotals, recordResult, setLoop, setWorkers, startStory, startTotals } from '../../engine/state.mjs';
import { describeStatus } from './status.mjs';
import { makeStopCommand } from './control.mjs';
import { writePid } from '../../engine/supervisor-pid.mjs';

let dir;
let clock;
const state = () => join(dir, '.foreman');
const control = () => JSON.parse(readFileSync(join(state(), 'control.json'), 'utf8'));

function project(slots = 3) {
  writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'T' }, slots, checks: [{ run: 'true', when: 'always' }] }));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foreman-cli-control-'));
  clock = new Date('2026-10-15T09:00:00Z');
  project();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function run(argv) {
  let out = '';
  let err = '';
  const code = await main(argv, {
    cwd: dir,
    env: { FOREMAN_PROJECT_DIR: dir },
    now: () => clock,
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
  });
  return { code, out, err };
}
const tick = () => {
  clock = new Date(clock.getTime() + 1000);
};
const oneLine = (s) => s.trim().split('\n').length === 1;

describe('the owner commands', () => {
  it('pause and resume', async () => {
    const p = await run(['pause']);
    expect(p.code).toBe(0);
    expect(oneLine(p.out)).toBe(true);
    expect(control().paused).toBe(true);
    tick();
    const r = await run(['resume']);
    expect(r.code).toBe(0);
    expect(control()).toMatchObject({ paused: false, resumeAt: clock.toISOString() });
  });

  it('stop creates the STOP file, and the marker that keeps the service stopped', async () => {
    const r = await run(['stop']);
    expect(r.code).toBe(0);
    expect(oneLine(r.out)).toBe(true);
    expect(existsSync(join(state(), 'STOP'))).toBe(true);
    expect(existsSync(join(state(), 'service-stopped'))).toBe(true);
  });

  it('stop from your terminal records it came from the command line, not from a run', async () => {
    await run(['stop']);
    const rec = JSON.parse(readFileSync(join(state(), 'STOP'), 'utf8'));
    expect(rec).toMatchObject({ at: clock.toISOString(), via: 'cli', run: false, story: null, slot: null, cwd: dir, pid: process.pid });
    expect(JSON.parse(readFileSync(join(state(), 'service-stopped'), 'utf8'))).toEqual(rec);
  });

  it('stop from a story session in a plain temp project records the session', async () => {
    const anchor = mkdtempSync(join(tmpdir(), 'foreman-cli-control-anchor-'));
    try {
      const code = await main(['stop'], {
        cwd: dir,
        env: { FOREMAN_RUN: '1', FOREMAN_PROJECT_DIR: anchor, FOREMAN_STATE_DIR: join(anchor, '.foreman'), FOREMAN_STORY: 'S-1', FOREMAN_SLOT: 'w3', FOREMAN_STATE_SYNC: 'off' },
        now: () => clock,
        stdout: { write: () => {} },
        stderr: { write: () => {} },
      });
      expect(code).toBe(0);
      expect(JSON.parse(readFileSync(join(state(), 'STOP'), 'utf8'))).toMatchObject({ via: 'cli', run: true, story: 'S-1', slot: 'w3', cwd: dir });
      expect(existsSync(join(anchor, '.foreman'))).toBe(false);
    } finally {
      rmSync(anchor, { recursive: true, force: true });
    }
  });

  it('slot writes a command the supervisor takes exactly once', async () => {
    const r = await run(['slot', 'w2', 'park']);
    expect(r.code).toBe(0);
    expect(oneLine(r.out)).toBe(true);
    const cmds = pendingCommands(control(), {}, slotIdsFor(3));
    expect(cmds).toEqual([{ key: 'slot:w2', kind: 'slot', slot: 'w2', action: 'park', at: clock.toISOString() }]);
    expect(pendingCommands(control(), { 'slot:w2': cmds[0].at }, slotIdsFor(3))).toEqual([]);
    tick();
    await run(['slot', 'w2', 'park']);
    expect(pendingCommands(control(), { 'slot:w2': cmds[0].at }, slotIdsFor(3))).toHaveLength(1);
  });

  it('slot refuses a slot outside the config and an unknown action', async () => {
    expect((await run(['slot', 'w5', 'park'])).code).toBe(1);
    expect((await run(['slot', 'w1', 'explode'])).code).toBe(1);
    expect((await run(['slot', 'w1'])).code).toBe(1);
    expect(existsSync(join(state(), 'control.json'))).toBe(false);
    project(8);
    expect((await run(['slot', 'w5', 'park'])).code).toBe(0);
  });

  it('workers follows the configured slots', async () => {
    expect((await run(['workers', '6'])).code).toBe(1);
    expect((await run(['workers', '0'])).code).toBe(1);
    expect((await run(['workers', 'two'])).code).toBe(1);
    expect((await run(['workers', '2'])).code).toBe(0);
    expect(control()).toMatchObject({ workers: 2, workersAt: clock.toISOString() });
    project(8);
    tick();
    expect((await run(['workers', '6'])).code).toBe(0);
    expect(pendingCommands(control(), {}, slotIdsFor(8))).toEqual([{ key: 'workers', kind: 'workers', value: 6, at: clock.toISOString() }]);
  });

  it('fixed, handback and next', async () => {
    expect((await run(['fixed'])).code).toBe(0);
    tick();
    expect((await run(['handback', 'S-4'])).code).toBe(0);
    tick();
    expect((await run(['next', 'S-7'])).code).toBe(0);
    const c = control();
    expect(c.fixedAt).toBe('2026-10-15T09:00:00.000Z');
    expect(c.handBack).toEqual({ id: 'S-4', at: '2026-10-15T09:00:01.000Z' });
    expect(c).toMatchObject({ nextStory: 'S-7', requestedAt: '2026-10-15T09:00:02.000Z' });
    expect(pendingCommands(c, {}, slotIdsFor(3)).map((x) => x.key)).toEqual(['fixed', 'handback']);
  });

  it('handback and next refuse what is not a story id', async () => {
    expect((await run(['handback'])).code).toBe(1);
    expect((await run(['next', 'S-1; rm -rf /'])).code).toBe(1);
  });

  it('refuses to run without a usable config', async () => {
    rmSync(join(dir, 'foreman.config.json'));
    const r = await run(['pause']);
    expect(r.code).toBe(1);
  });
});

describe('foreman status', () => {
  it('shows paused after foreman pause when no run is active', async () => {
    await run(['pause']);
    const r = await run(['status']);
    expect(r.code).toBe(0);
    expect(r.out.split('\n')[0]).toMatch(/paused/i);
  });

  it('shows the loop, each slot, recent results and what waits on the owner', async () => {
    setLoop(state(), 'running', '', clock);
    setWorkers(state(), 2);
    startStory(state(), { id: 'S-3', title: 'Add login' }, clock, 'w2');
    recordResult(state(), { id: 'S-2', title: 'Sign up', result: 'shipped', pr: 'https://x/pr/2', endedAt: clock.toISOString(), slot: 'w1' });
    add(state(), { story: 'S-9', kind: 'task', title: 'Add the key' }, clock);
    const r = await run(['status']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/running/);
    expect(r.out).toMatch(/w1\s+idle/);
    expect(r.out).toMatch(/w2\s+building\s+S-3/);
    expect(r.out).toMatch(/architect/);
    expect(r.out).toMatch(/S-2 shipped/);
    expect(r.out).toMatch(/Waiting on you: 1/);
  });

  it('counts an open owner task as waiting on the owner, and names it', async () => {
    mkdirSync(join(dir, 'stories'), { recursive: true });
    writeFileSync(join(dir, 'stories', 'ABC-1.md'), '---\nid: ABC-1\ntitle: Add the key (owner task)\nstatus: todo\n---\n');
    const r = await run(['status']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Waiting on you: 1\n/);
    expect(r.out).toContain('  Your tasks (1):\n');
    expect(r.out).toMatch(/^ {4}Add the key \(owner task\)$/m);
  });

  it('shows what a task takes, read from its file', async () => {
    mkdirSync(join(dir, 'stories'), { recursive: true });
    writeFileSync(join(dir, 'stories', 'ABC-1.md'), '---\nid: ABC-1\ntitle: Add the key (owner task)\nstatus: todo\n---\n\n## Takes\n\nAbout 2 hours\n');
    const r = await run(['status']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^ {4}Add the key \(owner task\) · takes About 2 hours$/m);
  });

  it('counts only the owner tasks that can start now, and says how many wait for later', async () => {
    mkdirSync(join(dir, 'stories'), { recursive: true });
    writeFileSync(join(dir, 'stories', 'ABC-1.md'), '---\nid: ABC-1\ntitle: Add the key (owner task)\nstatus: todo\n---\n');
    writeFileSync(join(dir, 'stories', 'ABC-2.md'), '---\nid: ABC-2\ntitle: Build it\nstatus: todo\n---\n');
    writeFileSync(join(dir, 'stories', 'ABC-3.md'), '---\nid: ABC-3\ntitle: Run the proof (owner task)\nstatus: todo\ndepends_on: [ABC-2]\n---\n');
    const r = await run(['status']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Waiting on you: 1 \(1 later\)\n/);
    expect(r.out).toContain('  Your tasks (1):\n');
    expect(r.out).toMatch(/^ {4}Add the key \(owner task\)$/m);
    expect(r.out).toContain('  Later: 1 (first after ABC-2)\n');
    expect(r.out).not.toContain('Run the proof');
  });

  it('shows the cost and minutes of each recent story and the totals of the run', async () => {
    startTotals(state(), clock);
    recordResult(state(), { id: 'S-2', title: 'Sign up', result: 'shipped', endedAt: clock.toISOString(), slot: 'w1' }, { costUsd: 2.456, minutes: 41.5 });
    addToTotals(state(), { story: 'S-2', result: 'shipped', costUsd: 2.456, minutes: 41.5 });
    addToTotals(state(), { story: 'S-1', result: 'rate-limit', costUsd: 0.5, minutes: 3 });
    const r = await run(['status']);
    expect(r.out).toMatch(/S-2 shipped {2}\$2\.46 · 42 min/);
    expect(r.out).toMatch(/This run: 2 stories, 1 shipped, \$2\.96, 45 min/);
  });

  it('leaves out cost and minutes nobody recorded', () => {
    const out = describeStatus({ loop: { state: 'stopped' }, workers: 1, slots: [], recent: [{ id: 'S-1', result: 'failed' }], totals: { stories: 0, shipped: 0, costUsd: 0, minutes: 0 } }, 1);
    expect(out).toContain('  S-1 failed\n');
    expect(out).not.toContain('This run');
    expect(out).not.toContain('$');
  });

  it('with the artifacts console, counts what waits on the copy of the decisions page', async () => {
    const urls = { commandCenterUrl: 'https://pages.example/artifact/cc', decisionsUrl: 'https://pages.example/artifact/dp' };
    writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'T' }, checks: [{ run: 'true', when: 'always' }], console: { adapter: 'artifacts', ...urls } }));
    mkdirSync(join(state(), 'sync', 'decisions', 'items'), { recursive: true });
    writeFileSync(join(state(), 'sync', 'decisions', 'items', 'd-a.json'), JSON.stringify({ kind: 'task', title: 'Add the key', input: 'optional' }));
    const r = await run(['status']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Waiting on you: 1/);
  });

  it('a console without its settings is a clear error', async () => {
    writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'T' }, checks: [{ run: 'true', when: 'always' }], console: { adapter: 'artifacts' } }));
    const r = await run(['status']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/commandCenterUrl/);
  });

  it('--json prints the snapshot', async () => {
    await run(['pause']);
    const r = await run(['status', '--json']);
    expect(r.code).toBe(0);
    const snap = JSON.parse(r.out);
    expect(snap.control.paused).toBe(true);
    expect(Array.isArray(snap.slots)).toBe(true);
    expect(snap.waiting).toBeNull();
  });
});

describe('foreman stop --now', () => {
  const acme = () =>
    writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'Acme' }, slots: 2, checks: [{ run: 'true', when: 'always' }] }));
  beforeEach(acme);

  // makeStopCommand with a fake alive check and a kill that records its calls.
  async function stopWith(args, { alive = () => true, kill } = {}) {
    const kills = [];
    const command = makeStopCommand({ alive, kill: kill ?? ((pid, sig) => kills.push([pid, sig])) });
    let out = '';
    let err = '';
    const code = await command.run(args, { root: dir, cwd: dir, env: { FOREMAN_PROJECT_DIR: dir }, now: () => clock, stdout: { write: (t) => { out += t; } }, stderr: { write: (t) => { err += t; } } });
    return { code, out, err, kills };
  }
  const stopped = () => existsSync(join(state(), 'STOP')) && existsSync(join(state(), 'service-stopped'));

  it('asks the run to stop, then signals the live supervisor the pid file names', async () => {
    writePid(state(), 4242);
    const r = await stopWith(['--now'], { alive: (pid) => pid === 4242 });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.kills).toEqual([[4242, 'SIGTERM']]);
    expect(stopped()).toBe(true);
    expect(r.out).toContain('Stop requested');
    expect(r.out).toContain('Stopped the supervisor (pid 4242) now');
  });

  it('records who stopped the run, as plain stop does', async () => {
    writePid(state(), 4242);
    const r = await stopWith(['--now'], { alive: (pid) => pid === 4242 });
    expect(r.code).toBe(0);
    const rec = JSON.parse(readFileSync(join(state(), 'STOP'), 'utf8'));
    expect(rec).toMatchObject({ at: clock.toISOString(), via: 'cli', run: false, cwd: dir });
    expect(JSON.parse(readFileSync(join(state(), 'service-stopped'), 'utf8'))).toEqual(rec);
    expect(r.kills).toEqual([[4242, 'SIGTERM']]);
  });

  it('signals nothing when the pid file names no live supervisor, and still leaves the stop', async () => {
    writePid(state(), 4242);
    const r = await stopWith(['--now'], { alive: () => false });
    expect(r.code).toBe(0);
    expect(r.kills).toEqual([]);
    expect(r.out).toContain('No Foreman supervisor is running here, so nothing was stopped now.');
    expect(stopped()).toBe(true);
  });

  it('signals nothing with no pid file', async () => {
    const r = await stopWith(['--now']);
    expect(r.code).toBe(0);
    expect(r.kills).toEqual([]);
    expect(r.out).toContain('No Foreman supervisor is running here');
  });

  it('plain stop never signals, and prints one line', async () => {
    writePid(state(), 4242);
    const r = await stopWith([]);
    expect(r.code).toBe(0);
    expect(r.kills).toEqual([]);
    expect(oneLine(r.out)).toBe(true);
    expect(stopped()).toBe(true);
  });

  it('refuses any other argument, writing nothing', async () => {
    for (const args of [['--bogus'], ['--now', '--now'], ['now'], ['--now=1']]) {
      const r = await stopWith(args);
      expect(r.code).toBe(1);
      expect(r.err).toBe('usage: foreman stop [--now]\n');
      expect(r.kills).toEqual([]);
      expect(existsSync(join(state(), 'STOP'))).toBe(false);
      expect(existsSync(join(state(), 'service-stopped'))).toBe(false);
    }
  });

  it('says the supervisor had already stopped when the signal finds no process', async () => {
    writePid(state(), 4242);
    const gone = Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    const r = await stopWith(['--now'], { kill: () => { throw gone; } });
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
    expect(r.out).toContain('had already stopped');
  });

  it('reports any other signal error', async () => {
    writePid(state(), 4242);
    const denied = Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    const r = await stopWith(['--now'], { kill: () => { throw denied; } });
    expect(r.code).toBe(1);
    expect(r.err).toContain('kill EPERM');
    expect(stopped()).toBe(true);
  });

  describe('with real processes', () => {
    let child = null;
    afterEach(() => {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      child = null;
    });

    it('stops a running supervisor.mjs with SIGTERM', async () => {
      const script = join(dir, 'supervisor.mjs');
      writeFileSync(script, 'setTimeout(() => process.exit(0), 60_000); setInterval(() => {}, 1000);\n');
      child = spawn(process.execPath, [script], { stdio: 'ignore' });
      await new Promise((resolve, reject) => child.once('spawn', resolve).once('error', reject));
      const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve(signal)));
      writePid(state(), child.pid);
      const r = await run(['stop', '--now']);
      expect(r.err).toBe('');
      expect(r.code).toBe(0);
      expect(r.out).toContain(`Stopped the supervisor (pid ${child.pid}) now`);
      expect(await exited).toBe('SIGTERM');
    });

    it('signals nothing when the pid file names a process that is not a supervisor', async () => {
      writePid(state(), process.pid);
      const r = await run(['stop', '--now']);
      expect(r.code).toBe(0);
      expect(r.out).toContain('No Foreman supervisor is running here, so nothing was stopped now.');
    });
  });
});
