// `foreman notify` and `foreman learn` as the supervisor runs them: in children of their own,
// with a time limit, so the loop keeps turning while they run.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownerCommands } from './owner-commands.mjs';
import { trackedRun, useSupervisors } from '../../../test/supervisors.mjs';

const made = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
// After the hook above, so it runs before it (vitest runs afterEach hooks last first): the
// commands end before their folder goes.
useSupervisors();

// A fake `foreman`: appends its argv to FAKE_ARGV, prints FAKE_STDOUT, then sleeps FAKE_SLEEP_MS,
// waits for the file FAKE_RELEASE when it is set, and exits FAKE_EXIT.
const FAKE = `
const fs = require('node:fs');
fs.appendFileSync(process.env.FAKE_ARGV, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.env.FAKE_STDOUT) process.stdout.write(process.env.FAKE_STDOUT);
const exit = () => process.exit(Number(process.env.FAKE_EXIT || 0));
const wait = () => (process.env.FAKE_RELEASE && !fs.existsSync(process.env.FAKE_RELEASE) ? setTimeout(wait, 20) : exit());
setTimeout(wait, Number(process.env.FAKE_SLEEP_MS || 0));
// The fake ends itself when its test is gone: its parent changed, or FAKE_MAX_MS passed.
const parent = process.ppid;
setInterval(() => { if (process.ppid !== parent) process.exit(1); }, 200).unref();
setTimeout(() => process.exit(1), Number(process.env.FAKE_MAX_MS || 60000)).unref();
`;

function fake(more = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'foreman-owner-commands-'));
  made.push(dir);
  const bin = join(dir, 'foreman.cjs');
  writeFileSync(bin, FAKE);
  const argv = join(dir, 'argv');
  const env = { ...process.env, FAKE_ARGV: argv, ...more };
  const lines = () => (existsSync(argv) ? readFileSync(argv, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { dir, bin, env, lines };
}

describe('notify', () => {
  it('stops at its time limit, says it could not email, and the loop keeps turning meanwhile', async () => {
    const f = fake({ FAKE_SLEEP_MS: '30000' });
    const event = vi.fn();
    const owner = ownerCommands({ bin: f.bin, root: f.dir, env: f.env, run: trackedRun, event, notifyMs: 300 });
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 10);
    const started = Date.now();
    try {
      await owner.notify('stopped', { reason: 'Stopped on request.', slot: 'w2', stories: 3, shipped: 1 });
    } finally {
      clearInterval(timer);
    }
    expect(Date.now() - started).toBeLessThan(3000);
    expect(ticks).toBeGreaterThan(5);
    expect(event).toHaveBeenCalledTimes(1);
    expect(event).toHaveBeenCalledWith('Could not email you (stopped).', 'warn', 'w2');
  });

  it('runs `foreman notify` with the same arguments as before, in the project, and logs nothing when it sends', async () => {
    const f = fake();
    const event = vi.fn();
    const owner = ownerCommands({ bin: f.bin, root: f.dir, env: f.env, run: trackedRun, event });
    await owner.notify('parked', { story: 'ACME-1', reason: 'crashed', slot: 'w1', parkedFor: 'crash', log: '/acme/log', stories: 2, shipped: 1 });
    await owner.notify('halted', { reason: 'A release failed.' });
    expect(event).not.toHaveBeenCalled();
    expect(f.lines()).toEqual([
      ['notify', '--kind', 'parked', '--story', 'ACME-1', '--reason', 'crashed', '--stories', '2', '--shipped', '1', '--log', '/acme/log', '--slot', 'w1', '--parked-for', 'crash'],
      ['notify', '--kind', 'halted', '--story', '', '--reason', 'A release failed.', '--stories', '0', '--shipped', '0', '--log', ''],
    ]);
  });

  it('says it could not email when the command fails or cannot start, with no slot as null', async () => {
    const f = fake({ FAKE_EXIT: '1' });
    const event = vi.fn();
    await ownerCommands({ bin: f.bin, root: f.dir, env: f.env, run: trackedRun, event }).notify('down', { reason: 'x' });
    expect(event).toHaveBeenCalledWith('Could not email you (down).', 'warn', null);
    const failed = vi.fn();
    const run = async () => ({ status: null, signal: null, stdout: '', stderr: '', timedOut: false, ms: 0, error: 'spawn ENOENT' });
    await ownerCommands({ bin: f.bin, root: f.dir, env: f.env, event: failed, run }).notify('stuck', { slot: 'w3' });
    expect(failed).toHaveBeenCalledWith('Could not email you (stuck).', 'warn', 'w3');
  });
});

describe('learn', () => {
  it('starts one `foreman learn` while one runs, and gives the running one to a second call', async () => {
    const f = fake({ FAKE_SLEEP_MS: '400' });
    const owner = ownerCommands({ bin: f.bin, root: f.dir, env: f.env, run: trackedRun, event: vi.fn() });
    const a = owner.learn();
    const b = owner.learn();
    expect(b).toBe(a);
    await Promise.all([a, b]);
    expect(f.lines()).toEqual([['learn']]);
    await owner.learn();
    expect(f.lines()).toEqual([['learn'], ['learn']]);
  });

  it('logs what it proposed as one event, and nothing when it proposed nothing', async () => {
    const f = fake({ FAKE_STDOUT: 'Proposed 2 trait(s) from repeated findings\nProposed 1 follow-up(s) from minor findings\n' });
    const event = vi.fn();
    await ownerCommands({ bin: f.bin, root: f.dir, env: f.env, run: trackedRun, event }).learn();
    expect(event).toHaveBeenCalledTimes(1);
    expect(event).toHaveBeenCalledWith('Proposed 2 trait(s) from repeated findings; proposed 1 follow-up(s) from minor findings');

    const quiet = vi.fn();
    const g = fake({ FAKE_STDOUT: 'Nothing to propose.\n' });
    await ownerCommands({ bin: g.bin, root: g.dir, env: g.env, run: trackedRun, event: quiet }).learn();
    expect(quiet).not.toHaveBeenCalled();
  });

  it('never throws, and stops at its own time limit', async () => {
    const f = fake({ FAKE_SLEEP_MS: '30000' });
    const started = Date.now();
    await expect(ownerCommands({ bin: f.bin, root: f.dir, env: f.env, run: trackedRun, event: vi.fn(), learnMs: 300 }).learn()).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(3000);
    const run = async () => {
      throw new Error('boom');
    };
    await expect(ownerCommands({ bin: f.bin, root: f.dir, env: f.env, event: vi.fn(), run }).learn()).resolves.toBeUndefined();
  });
});

describe('learn, queued', () => {
  it('starts exactly one more learn after the running one, however many are queued', async () => {
    const f = fake({ FAKE_SLEEP_MS: '300' });
    const owner = ownerCommands({ bin: f.bin, root: f.dir, env: f.env, run: trackedRun, event: vi.fn() });
    const first = owner.learn();
    const a = owner.learn({ queue: true });
    const b = owner.learn({ queue: true });
    const c = owner.learn({ queue: true });
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(a).not.toBe(first);
    await Promise.all([first, a, b, c]);
    expect(f.lines()).toEqual([['learn'], ['learn']]);
    await owner.settled();
    expect(f.lines()).toEqual([['learn'], ['learn']]);
  });

  it('starts one at once when none runs, and queues again once that one is running', async () => {
    const f = fake({ FAKE_SLEEP_MS: '200' });
    const owner = ownerCommands({ bin: f.bin, root: f.dir, env: f.env, run: trackedRun, event: vi.fn() });
    const a = owner.learn({ queue: true });
    const again = owner.learn({ queue: true });
    expect(again).not.toBe(a);
    await Promise.all([a, again]);
    expect(f.lines()).toEqual([['learn'], ['learn']]);
    await owner.learn({ queue: true });
    expect(f.lines()).toHaveLength(3);
  });

  it('gives a plain learn the queued promise and starts nothing more', async () => {
    const f = fake({ FAKE_SLEEP_MS: '200' });
    const owner = ownerCommands({ bin: f.bin, root: f.dir, env: f.env, run: trackedRun, event: vi.fn() });
    owner.learn();
    const queued = owner.learn({ queue: true });
    expect(owner.learn()).toBe(queued);
    await queued;
    expect(f.lines()).toEqual([['learn'], ['learn']]);
  });

  it('lets a stop wait for the queued learn, and settled() too', async () => {
    const f = fake({ FAKE_SLEEP_MS: '200' });
    const owner = ownerCommands({ bin: f.bin, root: f.dir, env: f.env, run: trackedRun, event: vi.fn() });
    owner.learn();
    owner.learn({ queue: true });
    await owner.finish(null, {});
    expect(f.lines()).toEqual([['learn'], ['learn']]);

    const g = fake({ FAKE_SLEEP_MS: '200' });
    const other = ownerCommands({ bin: g.bin, root: g.dir, env: g.env, run: trackedRun, event: vi.fn() });
    other.learn();
    other.learn({ queue: true });
    await other.settled();
    expect(g.lines()).toEqual([['learn'], ['learn']]);
  });

  it('never throws', async () => {
    const run = async () => {
      throw new Error('boom');
    };
    const owner = ownerCommands({ bin: 'x', root: '.', event: vi.fn(), run });
    owner.learn();
    await expect(owner.learn({ queue: true })).resolves.toBeUndefined();
  });
});

describe('finish', () => {
  const until = async (what, test) => {
    const by = Date.now() + 10_000;
    while (!test()) {
      if (Date.now() > by) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  it('runs `foreman learn` and the last email side by side, and resolves once both have settled', async () => {
    const f = fake();
    const release = join(f.dir, 'release');
    f.env.FAKE_RELEASE = release;
    const event = vi.fn();
    const owner = ownerCommands({ bin: f.bin, root: f.dir, env: f.env, run: trackedRun, event });
    let done = false;
    const finished = owner.finish('stopped', { reason: 'Stopped on request.', stories: 2, shipped: 1 }).then(() => {
      done = true;
    });
    // Both started before either was let go: the stop waits for the slower, not for both in turn.
    await until('both children to start', () => f.lines().length === 2);
    expect(f.lines().map((l) => l[0]).sort()).toEqual(['learn', 'notify']);
    expect(f.lines().find((l) => l[0] === 'notify')).toEqual(['notify', '--kind', 'stopped', '--story', '', '--reason', 'Stopped on request.', '--stories', '2', '--shipped', '1', '--log', '']);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(done).toBe(false);
    writeFileSync(release, '');
    await finished;
    expect(done).toBe(true);
    expect(event).not.toHaveBeenCalled();
  });

  it('runs only `foreman learn` with no kind, and joins a learn already running', async () => {
    const f = fake({ FAKE_SLEEP_MS: '300' });
    const owner = ownerCommands({ bin: f.bin, root: f.dir, env: f.env, run: trackedRun, event: vi.fn() });
    const running = owner.learn();
    await owner.finish(null, { reason: 'x' });
    await running;
    expect(f.lines()).toEqual([['learn']]);
  });

  it('still says it could not email when the last email fails', async () => {
    const f = fake({ FAKE_EXIT: '1' });
    const event = vi.fn();
    await ownerCommands({ bin: f.bin, root: f.dir, env: f.env, run: trackedRun, event }).finish('halted', { reason: 'x' });
    expect(event).toHaveBeenCalledWith('Could not email you (halted).', 'warn', null);
  });
});

describe('settled', () => {
  it('resolves only after every pending notify and learn has settled', async () => {
    const f = fake({ FAKE_SLEEP_MS: '300' });
    const owner = ownerCommands({ bin: f.bin, root: f.dir, env: f.env, run: trackedRun, event: vi.fn() });
    await owner.settled();
    const done = [];
    owner.notify('stopped', {}).then(() => done.push('notify'));
    owner.learn().then(() => done.push('learn'));
    await owner.settled();
    expect(done.sort()).toEqual(['learn', 'notify']);
    expect(f.lines()).toHaveLength(2);
  });
});

describe('the supervisor', () => {
  const src = readFileSync(new URL('./supervisor.mjs', import.meta.url), 'utf8');
  const body = (sig) => {
    const start = src.indexOf(sig);
    expect(start, sig).toBeGreaterThan(-1);
    return src.slice(start, src.indexOf('\n}\n', start));
  };
  // Standby lives in standby.mjs, inside a factory: its functions close at two spaces.
  const standby = readFileSync(new URL('./standby.mjs', import.meta.url), 'utf8');
  const inner = (sig) => {
    const start = standby.indexOf(sig);
    expect(start, sig).toBeGreaterThan(-1);
    return standby.slice(start, standby.indexOf('\n  }\n', start));
  };

  it('sends every email through its owner commands, with the run counts', () => {
    expect(body('function notify(kind, fields = {}) {')).toContain('return owner.notify(kind, { ...fields, stories: finished, shipped });');
    expect(src).not.toMatch(/spawnSync\(process\.execPath/);
  });

  it('waits for the emails and the learn still running before it exits, on a stop and on new code', () => {
    for (const sig of ['async function stop(', 'async function restartOnNewCode(']) {
      const fn = body(sig);
      const settled = fn.indexOf('await owner.settled();');
      expect(settled, sig).toBeGreaterThan(-1);
      expect(settled, sig).toBeLessThan(fn.indexOf('dashboard?.close();'));
      expect(settled, sig).toBeLessThan(fn.indexOf('process.exit('));
    }
    // The stopped or halted email is sent beside the last learn, and before the config problem it
    // may still need is cleared.
    const stop = body('async function stop(');
    const finish = stop.indexOf("await owner.finish(code === 2 || !ONCE ? (code === 2 ? 'halted' : 'stopped') : null, { reason, stories: finished, shipped });");
    expect(finish).toBeGreaterThan(-1);
    expect(finish).toBeLessThan(stop.indexOf('saveRun({ configProblem: null'));
    expect(stop).not.toContain('await owner.learn();');
  });

  it('starts learn in the background on entering standby', () => {
    expect(inner('function enterStandby() {')).toContain('owner.learn()');
  });

  it('keeps any failure while announcing standby inside announceStandby', () => {
    const fn = inner('async function announceStandby() {');
    expect(fn).toMatch(/^async function announceStandby\(\) \{\n    try \{\n/);
    expect(fn).toMatch(/\n    \} catch \{\n(      \/\/[^\n]*\n)*    \}$/);
    const close = fn.lastIndexOf('    } catch {');
    for (const part of ["notify('standby'", 'standbyNews(items)', "event(news.text, 'info')"]) {
      expect(fn.indexOf(part), part).toBeGreaterThan(-1);
      expect(fn.indexOf(part), part).toBeLessThan(close);
    }
  });

  it('queues a learn after each shipped story, once its run is recorded', () => {
    expect(src).toMatch(/recordResult\(DIR, done, recordRun\([^\n]*\)\);\n  learning\.start\(\);\n(  \/\/[^\n]*\n)*  if \(run\.result === 'shipped'\) owner\.learn\(\{ queue: true \}\);/);
  });
});

// A stand-in Node that fails as Node does after a Homebrew upgrade replaced a library it needs.
const DYLD = 'dyld[4242]: Library not loaded: /opt/homebrew/opt/simdjson/lib/libsimdjson.33.dylib';
function standin(dir) {
  const file = join(dir, 'standin-node');
  writeFileSync(file, `#!/bin/sh\necho '${DYLD}' >&2\necho '  Referenced from: <ACME> /opt/acme/bin/node' >&2\nexit 134\n`);
  chmodSync(file, 0o755);
  return file;
}

describe('the Node the commands run on', () => {
  it('is the command that runs, and defaults to this process\'s Node', async () => {
    const f = fake();
    const seen = [];
    const run = async (cmd, args) => {
      seen.push([cmd, args[0]]);
      return { status: 0, signal: null, stdout: '', stderr: '', timedOut: false, ms: 0 };
    };
    await ownerCommands({ bin: f.bin, root: f.dir, env: f.env, event: vi.fn(), run, node: () => '/opt/acme/bin/node' }).notify('stopped');
    await ownerCommands({ bin: f.bin, root: f.dir, env: f.env, event: vi.fn(), run }).notify('stopped');
    expect(seen).toEqual([['/opt/acme/bin/node', f.bin], [process.execPath, f.bin]]);
  });

  it('asks node() each time, so a Node chosen later is the one used', async () => {
    const f = fake();
    let node = '/opt/acme/old/node';
    const seen = [];
    const run = async (cmd) => {
      seen.push(cmd);
      return { status: 0, signal: null, stdout: '', stderr: '', timedOut: false, ms: 0 };
    };
    const owner = ownerCommands({ bin: f.bin, root: f.dir, env: f.env, event: vi.fn(), run, node: () => node });
    await owner.notify('stopped');
    node = '/opt/acme/bin/node';
    await owner.notify('stopped');
    expect(seen).toEqual(['/opt/acme/old/node', '/opt/acme/bin/node']);
  });

  it('says a Node that cannot load is a set-up problem, with the dyld line, in one warn event', async () => {
    const f = fake();
    const event = vi.fn();
    const node = standin(f.dir);
    await ownerCommands({ bin: f.bin, root: f.dir, env: f.env, run: trackedRun, event, node: () => node }).notify('stopped', { slot: 'w1' });
    expect(event).toHaveBeenCalledTimes(1);
    const [text, kind, slot] = event.mock.calls[0];
    expect(kind).toBe('warn');
    expect(slot).toBe('w1');
    expect(text).toContain('Could not email you (stopped)');
    expect(text).toContain(DYLD);
    expect(text).toContain(`Node (${node})`);
    expect(text).toContain('set-up');
    expect(text).toContain('Homebrew');
  });

  it('keeps the plain text for a failure that is not a load error', async () => {
    const f = fake({ FAKE_EXIT: '1' });
    const event = vi.fn();
    await ownerCommands({ bin: f.bin, root: f.dir, env: f.env, run: trackedRun, event }).notify('stopped');
    expect(event.mock.calls).toEqual([['Could not email you (stopped).', 'warn', null]]);
  });

  it('says the same for `foreman learn`, and logs nothing for another failure', async () => {
    const f = fake();
    const event = vi.fn();
    const node = standin(f.dir);
    await ownerCommands({ bin: f.bin, root: f.dir, env: f.env, run: trackedRun, event, node: () => node }).learn();
    expect(event).toHaveBeenCalledTimes(1);
    expect(event.mock.calls[0][1]).toBe('warn');
    expect(event.mock.calls[0][0]).toContain('`foreman learn` failed');
    expect(event.mock.calls[0][0]).toContain(DYLD);
    expect(event.mock.calls[0][0]).toContain(`Node (${node})`);
    expect(event.mock.calls[0][0]).toContain('set-up');
    const quiet = vi.fn();
    const g = fake({ FAKE_EXIT: '1' });
    await ownerCommands({ bin: g.bin, root: g.dir, env: g.env, run: trackedRun, event: quiet }).learn();
    expect(quiet).not.toHaveBeenCalled();
  });
});
