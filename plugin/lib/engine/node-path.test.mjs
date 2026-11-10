// Which Node the supervisor's children run on, and whether this process's own Node still starts.
// The stand-in Node is a script that fails the way Node does after a Homebrew upgrade replaced
// a library it needs (the macOS dyld message, exit 134).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { learningTicks } from './learning-ticks.mjs';
import { ownerCommands } from './owner-commands.mjs';
import { trackedRun, useSupervisors } from '../../../test/supervisors.mjs';
import {
  childNodeText,
  chooseNode,
  homebrewLink,
  likelyHomebrew,
  loadErrorLine,
  nodeCandidates,
  nodeWatch,
  probeNode,
  restartFor,
  spawnSh,
} from './node-path.mjs';

const DYLD = 'dyld[4242]: Library not loaded: /opt/homebrew/opt/simdjson/lib/libsimdjson.33.dylib';
const LINUX = 'node: error while loading shared libraries: libsimdjson.so.33: cannot open shared object file';

useSupervisors();

let base;
let BIN;
let STANDIN;

beforeAll(() => {
  base = fs.mkdtempSync(join(tmpdir(), 'foreman-node-path-'));
  BIN = join(base, 'bin');
  fs.mkdirSync(BIN);
  fs.symlinkSync(process.execPath, join(BIN, 'node'));
  STANDIN = join(base, 'standin-node');
  fs.writeFileSync(STANDIN, `#!/bin/sh\necho '${DYLD}' >&2\necho '  Referenced from: <ACME-UUID> /opt/acme/bin/node' >&2\nexit 134\n`, { mode: 0o755 });
  fs.chmodSync(STANDIN, 0o755);
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('loadErrorLine', () => {
  it('picks the dyld line out of several lines, finds the Linux line, and is null otherwise', () => {
    expect(loadErrorLine(`\n${DYLD}\n  Referenced from: <X> /opt/acme/bin/node\n`)).toBe(DYLD);
    expect(loadErrorLine(`Some noise\n  ${LINUX}  \n`)).toBe(LINUX);
    expect(loadErrorLine('Error: boom')).toBeNull();
    expect(loadErrorLine('')).toBeNull();
    expect(loadErrorLine(undefined)).toBeNull();
  });

  it('cuts a long line to 300 characters', () => {
    const long = `Library not loaded: ${'x'.repeat(500)}`;
    expect(loadErrorLine(long)).toHaveLength(300);
  });
});

describe('homebrewLink', () => {
  it("is the prefix's bin/node for a Cellar path, else null", () => {
    expect(homebrewLink('/opt/homebrew/Cellar/node/26.9.0/bin/node')).toBe('/opt/homebrew/bin/node');
    expect(homebrewLink('/usr/bin/node')).toBeNull();
  });
});

describe('nodeCandidates', () => {
  it('puts the service node first, then the Homebrew link, the PATH node, then execPath', () => {
    const exec = '/opt/homebrew/Cellar/node/26.9.0/bin/node';
    const out = nodeCandidates({ execPath: exec, serviceNode: '/opt/acme/bin/node', env: { PATH: BIN }, fs });
    expect(out).toEqual(['/opt/acme/bin/node', '/opt/homebrew/bin/node', join(BIN, 'node'), exec]);
  });

  it('drops duplicates and empty entries, and skips a PATH with no node', () => {
    const exec = '/opt/acme/bin/node';
    expect(nodeCandidates({ execPath: exec, serviceNode: exec, env: { PATH: BIN }, fs })).toEqual([exec, join(BIN, 'node')]);
    expect(nodeCandidates({ execPath: exec, env: { PATH: base }, fs })).toEqual([exec]);
    expect(nodeCandidates({ execPath: exec, env: {}, fs })).toEqual([exec]);
  });

  it('ignores a relative PATH entry', () => {
    expect(nodeCandidates({ execPath: '/opt/acme/bin/node', env: { PATH: 'bin' }, fs: { existsSync: () => true } })).toEqual(['/opt/acme/bin/node']);
  });
});

describe('probeNode', () => {
  it('names the dyld line for a Node that cannot load its library', () => {
    const r = probeNode(STANDIN, spawnSh());
    expect(r).toEqual({ ok: false, node: STANDIN, cause: DYLD });
  });

  it('is ok with the version for a Node that starts', () => {
    const r = probeNode(process.execPath, spawnSh());
    expect(r).toMatchObject({ ok: true, node: process.execPath });
    expect(r.version).toMatch(/^v\d+/);
  });

  it('says it could not start for a path that does not exist', () => {
    const r = probeNode(join(base, 'missing-node'), spawnSh());
    expect(r.ok).toBe(false);
    expect(r.cause).toMatch(/^could not start/);
  });

  it('gives the cause in order: load error, could not start, signal, exit code', () => {
    const sh = (r) => () => ({ status: null, signal: null, stdout: '', stderr: '', ...r });
    expect(probeNode('/n', sh({ status: 134, stderr: DYLD })).cause).toBe(DYLD);
    expect(probeNode('/n', sh({ status: null, error: 'spawn ENOENT' })).cause).toBe('could not start (spawn ENOENT)');
    expect(probeNode('/n', sh({ status: null, signal: 'SIGKILL' })).cause).toBe('killed by SIGKILL');
    expect(probeNode('/n', sh({ status: 3 })).cause).toBe('exit 3');
    expect(probeNode('/n', sh({ status: 0, stdout: ' v22.1.0\n' }))).toEqual({ ok: true, node: '/n', version: 'v22.1.0' });
  });

  it('runs node --version with a time limit', () => {
    const calls = [];
    probeNode('/n', (cmd, args, opts) => {
      calls.push([cmd, args, opts]);
      return { status: 0, stdout: 'v1', stderr: '' };
    });
    expect(calls).toEqual([['/n', ['--version'], { timeout: 10_000 }]]);
  });
});

describe('spawnSh', () => {
  it('runs with utf8 text and piped output, and gives the error message', () => {
    const seen = [];
    const run = (cmd, args, opts) => {
      seen.push(opts);
      return { status: null, signal: null, stdout: 'o', stderr: 'e', error: new Error('boom') };
    };
    expect(spawnSh(run)('x', ['y'], { timeout: 5 })).toEqual({ status: null, signal: null, stdout: 'o', stderr: 'e', error: 'boom' });
    expect(seen[0]).toMatchObject({ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5 });
  });
});

describe('chooseNode', () => {
  it('chooses the PATH node when execPath does not start', () => {
    const r = chooseNode({ execPath: STANDIN, env: { PATH: BIN }, fs, sh: spawnSh() });
    expect(r).toMatchObject({ ok: true, node: join(BIN, 'node') });
    expect(r.version).toMatch(/^v\d+/);
    // execPath is tried last, so the first Node that starts ends the search.
    expect(r.tried).toEqual([]);
  });

  it('records each Node that failed before one that starts', () => {
    const exec = '/opt/homebrew/Cellar/node/26.9.0/bin/node';
    const sh = (node) => (node === join(BIN, 'node') ? { status: 0, stdout: 'v22.0.0', stderr: '' } : { status: 134, stdout: '', stderr: DYLD });
    const r = chooseNode({ execPath: exec, serviceNode: '/opt/acme/bin/node', env: { PATH: BIN }, fs, sh });
    expect(r).toMatchObject({ ok: true, node: join(BIN, 'node'), version: 'v22.0.0' });
    expect(r.tried).toEqual([
      { node: '/opt/acme/bin/node', cause: DYLD },
      { node: '/opt/homebrew/bin/node', cause: DYLD },
    ]);
  });

  it('gives ok false with execPath and the causes when none starts', () => {
    const r = chooseNode({ execPath: STANDIN, env: { PATH: base }, fs, sh: spawnSh() });
    expect(r).toEqual({ ok: false, node: STANDIN, version: null, tried: [{ node: STANDIN, cause: DYLD }] });
  });
});

describe('likelyHomebrew and childNodeText', () => {
  it('spots Homebrew in the path or the cause', () => {
    expect(likelyHomebrew('/opt/homebrew/Cellar/node/26.9.0/bin/node', 'exit 1')).toBe(true);
    expect(likelyHomebrew('/opt/acme/bin/node', DYLD)).toBe(true);
    expect(likelyHomebrew('/opt/acme/bin/node', 'exit 1')).toBe(false);
  });

  it('says it is a set-up problem, and names Homebrew only when likely', () => {
    expect(childNodeText('Could not email you (stopped)', { node: '/opt/acme/bin/node', cause: 'exit 1' })).toBe(
      "Could not email you (stopped): Node (/opt/acme/bin/node) could not start: exit 1. This is a problem with this computer's set-up, not with a story. `foreman doctor` checks it.",
    );
    expect(childNodeText('x', { node: '/opt/acme/bin/node', cause: DYLD })).toContain("not with a story; Homebrew probably upgraded Node or a library it needs. `foreman doctor`");
  });
});

// A fake sh and clock: only the nodes in `works` start, and `broken` takes them away again.
function fakeWatch({ execPath = '/opt/homebrew/Cellar/node/26.9.0/bin/node', serviceNode = null, broken = new Set(), exists = [join(BIN, 'node')], works = [execPath, serviceNode, ...exists], everyMs = 60_000 } = {}) {
  const clock = { t: 1_000_000 };
  const sh = (node) => (broken.has(node) || !works.includes(node) ? { status: 134, signal: null, stdout: '', stderr: DYLD } : { status: 0, signal: null, stdout: 'v22.0.0\n', stderr: '' });
  const fakeFs = { existsSync: (p) => exists.includes(p) };
  const watch = nodeWatch({ execPath, serviceNode, env: { PATH: BIN }, fs: fakeFs, sh, now: () => clock.t, everyMs });
  return { watch, clock, broken, execPath };
}

describe('nodeWatch', () => {
  it('gives no event and broken() null while execPath starts', () => {
    const f = fakeWatch();
    expect(f.watch.node()).toBe(f.execPath);
    expect(f.watch.check({ force: true })).toEqual({ event: null });
    f.clock.t += 120_000;
    expect(f.watch.check()).toEqual({ event: null });
    expect(f.watch.broken()).toBeNull();
    expect(f.watch.node()).toBe(f.execPath);
  });

  it('warns once when execPath stops starting, after the interval, and names the new Node', () => {
    const f = fakeWatch();
    f.watch.check({ force: true });
    f.broken.add(f.execPath);
    f.clock.t += 30_000;
    expect(f.watch.check()).toEqual({ event: null });
    expect(f.watch.broken()).toBeNull();
    f.clock.t += 30_000;
    const c = f.watch.check();
    expect(c.event.kind).toBe('warn');
    expect(c.event.text).toContain(f.execPath);
    expect(c.event.text).toContain(DYLD);
    expect(c.event.text).toContain('Homebrew');
    expect(c.event.text).toContain(join(BIN, 'node'));
    expect(c.event.text).toContain('v22.0.0');
    expect(f.watch.broken()).toMatchObject({ id: 'node', from: f.execPath, to: join(BIN, 'node'), version: 'v22.0.0', cause: DYLD });
    expect(f.watch.node()).toBe(join(BIN, 'node'));
    f.clock.t += 120_000;
    expect(f.watch.check()).toEqual({ event: null });
    expect(f.watch.broken()).toMatchObject({ to: join(BIN, 'node') });
  });

  it('warns once that no Node starts, keeps broken() null, and warns again only after one worked in between', () => {
    const f = fakeWatch({ exists: [], works: ['/opt/homebrew/Cellar/node/26.9.0/bin/node'] });
    f.broken.add(f.execPath);
    const first = f.watch.check({ force: true });
    expect(first.event.kind).toBe('warn');
    expect(first.event.text).toContain('No Node on this computer starts');
    expect(first.event.text).toContain(`${f.execPath}: ${DYLD}`);
    expect(first.event.text).toContain('brew reinstall node');
    expect(f.watch.broken()).toBeNull();
    f.clock.t += 120_000;
    expect(f.watch.check()).toEqual({ event: null });
    f.broken.delete(f.execPath);
    f.clock.t += 120_000;
    expect(f.watch.check()).toEqual({ event: null });
    f.broken.add(f.execPath);
    f.clock.t += 120_000;
    expect(f.watch.check().event.text).toContain('No Node on this computer starts');
  });

  it('checks again before the interval only when forced', () => {
    const f = fakeWatch();
    f.watch.check({ force: true });
    f.broken.add(f.execPath);
    expect(f.watch.check()).toEqual({ event: null });
    expect(f.watch.check({ force: true }).event.text).toContain('no longer starts');
  });

  it('puts the service node ahead of the PATH node', () => {
    const f = fakeWatch({ serviceNode: '/opt/acme/bin/node' });
    f.watch.check({ force: true });
    f.broken.add(f.execPath);
    f.watch.check({ force: true });
    expect(f.watch.broken().to).toBe('/opt/acme/bin/node');
  });
});

describe('nodeWatch, a probe that did not fail because Node is broken', () => {
  const EXEC = '/opt/homebrew/Cellar/node/26.9.0/bin/node';
  const TIMEOUT = { status: null, signal: 'SIGTERM', stdout: '', stderr: '', error: `spawnSync ${EXEC} ETIMEDOUT` };
  const OK = { status: 0, signal: null, stdout: 'v22.0.0\n', stderr: '' };
  // execPath answers the probes in `script` in turn (then answers); only the PATH node else answers.
  function timing(script, { exists = [join(BIN, 'node')] } = {}) {
    const clock = { t: 1_000_000 };
    const steps = [...script];
    const sh = (node) => (node === EXEC ? (steps.length ? steps.shift() : OK) : node === join(BIN, 'node') ? OK : { status: 1, signal: null, stdout: '', stderr: '' });
    const watch = nodeWatch({ execPath: EXEC, env: { PATH: BIN }, fs: { existsSync: (p) => exists.includes(p) }, sh, now: () => clock.t });
    return { watch, clock };
  }

  it("counts Homebrew's link to the same keg as its own Node answering", () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'foreman-node-link-'));
    try {
      const keg = join(dir, 'keg-node');
      const link = join(dir, 'link-node');
      fs.writeFileSync(keg, 'x');
      fs.symlinkSync(keg, link);
      let first = true;
      const sh = (node) => {
        if (node === keg && first) {
          first = false;
          return { status: 134, signal: null, stdout: '', stderr: DYLD };
        }
        return OK;
      };
      const watch = nodeWatch({ execPath: keg, serviceNode: link, env: { PATH: '' }, fs, sh });
      expect(watch.check({ force: true })).toEqual({ event: null });
      expect(watch.broken()).toBeNull();
      expect(watch.node()).toBe(keg);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a probe that times out counts only when the next check fails too', () => {
    const f = timing([TIMEOUT, TIMEOUT]);
    expect(f.watch.check({ force: true })).toEqual({ event: null });
    expect(f.watch.broken()).toBeNull();
    expect(f.watch.node()).toBe(EXEC);
    f.clock.t += 60_000;
    const c = f.watch.check();
    expect(c.event.kind).toBe('warn');
    expect(c.event.text).toContain('no longer starts');
    expect(c.event.text).toContain('ETIMEDOUT');
    expect(c.event.text).toContain(join(BIN, 'node'));
    expect(f.watch.broken().to).toBe(join(BIN, 'node'));
  });

  it('an answer in between resets the count', () => {
    const f = timing([TIMEOUT, OK, TIMEOUT]);
    for (let i = 0; i < 3; i++) {
      expect(f.watch.check({ force: true })).toEqual({ event: null });
      f.clock.t += 60_000;
    }
    expect(f.watch.broken()).toBeNull();
    expect(f.watch.node()).toBe(EXEC);
  });

  it('a Node that is gone counts at once', () => {
    const f = timing([{ status: null, signal: null, stdout: '', stderr: '', error: 'spawnSync /opt/acme/old/node ENOENT' }]);
    const c = f.watch.check({ force: true });
    expect(c.event.kind).toBe('warn');
    expect(c.event.text).toContain('ENOENT');
    expect(f.watch.broken().to).toBe(join(BIN, 'node'));
  });

  it('no Node starts, under load: one strike is quiet, the second warns once', () => {
    const clock = { t: 1_000_000 };
    const sh = () => TIMEOUT;
    const watch = nodeWatch({ execPath: EXEC, env: { PATH: BIN }, fs: { existsSync: (p) => p === join(BIN, 'node') }, sh, now: () => clock.t });
    expect(watch.check({ force: true })).toEqual({ event: null });
    clock.t += 60_000;
    expect(watch.check().event.text).toContain('No Node on this computer starts');
    clock.t += 60_000;
    expect(watch.check()).toEqual({ event: null });
    expect(watch.broken()).toBeNull();
  });
});

describe('the stand-in as the running Node', () => {
  it('runs the learning tick and foreman notify on the stable Node, with no warning', async () => {
    const watch = nodeWatch({ execPath: STANDIN, env: { PATH: BIN }, fs, sh: spawnSh() });
    const c = watch.check({ force: true });
    expect(c.event.kind).toBe('warn');
    expect(c.event.text).toContain(DYLD);
    expect(c.event.text).toContain(STANDIN);
    expect(watch.node()).toBe(join(BIN, 'node'));

    const marker = join(base, 'tick-marker');
    const tickScript = join(base, 'tick.cjs');
    fs.writeFileSync(tickScript, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, process.argv[0]);`);
    const events = [];
    const ticks = learningTicks({
      spawnTick: () => spawn(watch.node(), [tickScript], { stdio: 'ignore' }),
      enabled: true,
      auto: () => true,
      event: (text, kind) => events.push([text, kind]),
    });
    ticks.start();
    for (let i = 0; i < 500 && (ticks.running() || !fs.existsSync(marker)); i++) await new Promise((r) => setTimeout(r, 10));
    expect(fs.existsSync(marker)).toBe(true);
    expect(events).toEqual([]);

    const argv = join(base, 'notify-argv');
    const fakeBin = join(base, 'foreman.cjs');
    fs.writeFileSync(fakeBin, `require('node:fs').appendFileSync(${JSON.stringify(argv)}, JSON.stringify(process.argv.slice(2)) + '\\n');`);
    const ownerEvents = [];
    const owner = ownerCommands({ bin: fakeBin, root: base, env: { ...process.env }, run: trackedRun, event: (text, kind) => ownerEvents.push([text, kind]), node: () => watch.node() });
    await owner.notify('stopped', { reason: 'Stopped on request.' });
    expect(JSON.parse(fs.readFileSync(argv, 'utf8').split('\n')[0])[0]).toBe('notify');
    expect(ownerEvents).toEqual([]);
  });
});

describe('restartFor', () => {
  const accepts = () => ({ ok: true });
  const code = { from: 'a1', to: 'b2', id: 'x' };
  const node = { id: 'node', from: '/opt/acme/old/node', to: '/opt/acme/bin/node', version: 'v22.0.0', cause: DYLD };

  it('takes the code restart first, with its text and its check', () => {
    const r = restartFor({ code, node, stopping: false, accepts });
    expect(r).toEqual({ pending: code, check: accepts, text: 'Restarted on new code (a1 -> b2).' });
  });

  it('restarts onto the Node when only that is pending, with a check that is ok', () => {
    const r = restartFor({ code: null, node, stopping: false, accepts });
    expect(r.pending).toBe(node);
    expect(r.text).toBe('Restarted onto Node /opt/acme/bin/node (v22.0.0): /opt/acme/old/node no longer starts.');
    expect(r.check()).toEqual({ ok: true });
  });

  it('leaves out the version when there is none', () => {
    expect(restartFor({ code: null, node: { ...node, version: null }, stopping: false, accepts }).text).toBe('Restarted onto Node /opt/acme/bin/node: /opt/acme/old/node no longer starts.');
  });

  it('is null while stopping, and when nothing is pending', () => {
    expect(restartFor({ code: null, node, stopping: true, accepts })).toBeNull();
    expect(restartFor({ code: null, node: null, stopping: false, accepts })).toBeNull();
  });
});

describe('the sources', () => {
  it('start no child with process.execPath', () => {
    for (const file of ['supervisor.mjs', 'owner-commands.mjs', 'account-checks.mjs', 'story-claims.mjs', 'standby.mjs', 'session-records.mjs', 'background-jobs.mjs', 'dry-run.mjs']) {
      const src = fs.readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      expect(src).not.toMatch(/\b(spawn|sh|run)\(process\.execPath/);
    }
  });

  it("wire the supervisor's restart and picks to the Node watch", () => {
    const src = fs.readFileSync(new URL('./supervisor.mjs', import.meta.url), 'utf8');
    expect(src).toContain('node: () => NODE.node() });');
    expect(src).toContain('let restartNow = restartFor({ code: restartPending, node: NODE.broken(), stopping, accepts: newCodeAccepts });');
    expect(src).toContain('check: restartNow.check });');
    expect(src).toContain('return restartOnNewCode(restartNow.pending, restartNow.text);');
    expect(src).toContain('stopping: stopping || !!restartNow,');
    expect(src).toContain('const nc = NODE.check();');
    expect(src).toContain('NODE.check({ force: true })');
    expect(src).toContain('everyMs: Math.min(NODE_CHECK_MS, NODE_CHECK_TICKS * TICK_MS)');
    expect(src.match(/process\.execPath/g)).toHaveLength(1); // only the nodeWatch line
  });
});
