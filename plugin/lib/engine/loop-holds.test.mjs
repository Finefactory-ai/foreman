// The record of what held the event loop: each synchronous child that took a second or more,
// so a late wake can name it.
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { clearHolds, commandLabel, heldList, heldSpawnSync, holdDuring, HOLD_MIN_MS, HOLDS_KEPT, noteHold } from './loop-holds.mjs';
import { lateWakeText } from './wake.mjs';

const HOLDS_URL = new URL('./loop-holds.mjs', import.meta.url).href;
const WORKTREE_URL = new URL('./worktree.mjs', import.meta.url).href;
// supervisor.mjs and the modules split out of it, so a guard on the loop covers every one of them.
const LOOP_SOURCES = ['supervisor.mjs', 'owner-commands.mjs', 'account-checks.mjs', 'story-claims.mjs', 'standby.mjs', 'session-records.mjs', 'background-jobs.mjs', 'dry-run.mjs'];

const T0 = Date.parse('2026-10-30T10:34:39.000Z');
const MIN = 60_000;

// A clock that reads `at` and moves by `step` ms on each read after the first.
function clockFrom(at, step) {
  let t = at;
  let first = true;
  return () => {
    if (first) {
      first = false;
      return t;
    }
    t += step;
    return t;
  };
}

beforeEach(() => {
  clearHolds();
});

describe('heldSpawnSync', () => {
  it('records a call that held the loop, by its command, and gives its result unchanged', () => {
    const result = { status: 0, stdout: 'ok', stderr: '' };
    const seen = [];
    const run = (...args) => {
      seen.push(args);
      return result;
    };
    const opts = { cwd: '/acme' };
    const r = heldSpawnSync('sh', ['-c', 'npm test'], opts, { run, clock: clockFrom(T0, 8 * MIN) });
    expect(r).toBe(result);
    expect(seen).toEqual([['sh', ['-c', 'npm test'], opts]]);
    expect(holdDuring(T0 - 1000, T0 + 9 * MIN)).toEqual({ command: 'npm test', ms: 8 * MIN });
  });

  it('keeps no call under HOLD_MIN_MS', () => {
    expect(HOLD_MIN_MS).toBe(1000);
    heldSpawnSync('git', ['status'], {}, { run: () => ({ status: 0 }), clock: clockFrom(T0, HOLD_MIN_MS - 1) });
    expect(holdDuring(T0 - MIN, T0 + MIN)).toBeNull();
    heldSpawnSync('git', ['status'], {}, { run: () => ({ status: 0 }), clock: clockFrom(T0, HOLD_MIN_MS) });
    expect(holdDuring(T0 - MIN, T0 + MIN)).toEqual({ command: 'git status', ms: HOLD_MIN_MS });
  });

  it('takes spawnSync by default and passes the options on', () => {
    const r = heldSpawnSync('sh', ['-c', 'echo acme'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('acme\n');
  });
});

describe('holdDuring', () => {
  it('gives the longest hold that overlaps the window, and none that ended before it', () => {
    noteHold({ command: 'git fetch', startedAt: T0, endedAt: T0 + 2000 });
    noteHold({ command: 'npm test', startedAt: T0 + 10_000, endedAt: T0 + 10_000 + 5 * MIN });
    noteHold({ command: 'gh pr list', startedAt: T0 + 6 * MIN, endedAt: T0 + 6 * MIN + 3000 });
    expect(holdDuring(T0 + 5000, T0 + 7 * MIN)).toEqual({ command: 'npm test', ms: 5 * MIN });
    expect(holdDuring(T0 + 5 * MIN + 20_000, T0 + 7 * MIN)).toEqual({ command: 'gh pr list', ms: 3000 });
    expect(holdDuring(T0 + 8 * MIN, T0 + 9 * MIN)).toBeNull();
  });

  it(`keeps the last ${HOLDS_KEPT} holds only`, () => {
    expect(HOLDS_KEPT).toBe(20);
    noteHold({ command: 'the oldest', startedAt: T0, endedAt: T0 + 9 * MIN });
    for (let i = 1; i <= HOLDS_KEPT; i += 1) noteHold({ command: `git ${i}`, startedAt: T0 + i, endedAt: T0 + i + 1000 });
    expect(holdDuring(T0, T0 + 10 * MIN).command).not.toBe('the oldest');
  });

  it('is null with nothing recorded', () => {
    expect(holdDuring(T0, T0 + MIN)).toBeNull();
  });
});

describe('commandLabel', () => {
  it('is the script for sh -c, the subcommand for foreman, else the base name and its leading words', () => {
    expect(commandLabel('sh', ['-c', 'npm test'])).toBe('npm test');
    expect(commandLabel('/bin/sh', ['-c', 'npm run lint'])).toBe('npm run lint');
    expect(commandLabel(process.execPath, ['/opt/acme/foreman/plugin/bin/foreman', 'notify', '--kind', 'x'])).toBe('foreman notify');
    expect(commandLabel('/opt/homebrew/bin/node', ['/opt/acme/foreman/plugin/bin/foreman', 'config', 'check'])).toBe('foreman config check');
    expect(commandLabel('/usr/bin/git', ['-C', '/acme', 'status'])).toBe('git');
    expect(commandLabel('gh', ['pr', 'list', '--state', 'merged', '--limit', '50'])).toBe('gh pr list');
    expect(commandLabel('git', ['ls-remote', '--heads', 'origin', 'story/*'])).toBe('git ls-remote');
    expect(commandLabel(process.execPath, ['/opt/acme/foreman/plugin/lib/engine/sync.mjs', '--once'])).toBe('node sync.mjs');
    expect(commandLabel('node', ['--version'])).toBe('node');
    expect(commandLabel('git', ['config', 'user.email', 'a@acme.com'])).toBe('git config');
    expect(commandLabel('gh')).toBe('gh');
  });

  it('names a foreman command by its subcommand and the lower-case words after it', () => {
    const bin = '/opt/acme/foreman/plugin/bin/foreman';
    expect(commandLabel(process.execPath, [bin, 'release', 'watch'])).toBe('foreman release watch');
    expect(commandLabel(process.execPath, [bin, 'story', 'S-1'])).toBe('foreman story');
    expect(commandLabel(process.execPath, [bin, 'config', 'check', 'extra'])).toBe('foreman config check');
    expect(commandLabel(process.execPath, [bin, 'health'])).toBe('foreman health');
  });

  it('keeps only the subcommand of a command with values, so no login email reaches a hold', () => {
    const args = ['org', 'login', 'jwt', '--alias', 'acme-qa', '--username', 'a@acme.com', '--jwt-key-file', '/acme/server.key', '--client-id', '3MVG9acme'];
    const label = commandLabel('/usr/local/bin/sf', args);
    expect(label).toBe('sf org login jwt');
    expect(label).not.toContain('a@acme.com');
    heldSpawnSync('/usr/local/bin/sf', args, {}, { run: () => ({ status: 0 }), clock: clockFrom(T0, 2000) });
    const hold = holdDuring(T0, T0 + MIN);
    expect(hold.command).toBe('sf org login jwt');
    expect(hold.command).not.toContain('a@acme.com');
  });

  it('a time limit ends a hung child, and the hold is still named', () => {
    const from = Date.now();
    const r = heldSpawnSync('sleep', ['30'], { timeout: 1200, killSignal: 'SIGKILL' });
    const to = Date.now();
    expect(r.signal).toBe('SIGKILL');
    expect(to - from).toBeLessThan(5000);
    expect(holdDuring(from, to).command).toBe('sleep');
  });

  it('never carries a key, and cuts a long one to 80 characters', () => {
    const key = 'sk-ant-api03-acmeacmeacmeacmeacme0123456789';
    const label = commandLabel('sh', ['-c', `curl -H "x-api-key: ${key}" https://acme.example`]);
    expect(label).not.toContain(key);
    expect(label).not.toContain('acmeacmeacme');
    const token = commandLabel('sh', ['-c', 'ACME_API_TOKEN=acme-plain-value npm test']);
    expect(token).not.toContain('acme-plain-value');
    const long = commandLabel('sh', ['-c', `echo ${'a'.repeat(200)}`]);
    expect(long).toHaveLength(80);
    expect(long.endsWith('…')).toBe(true);
  });

  it('a recorded hold carries the label, never the raw command', () => {
    const key = 'sk-ant-api03-acmeacmeacmeacmeacme0123456789';
    heldSpawnSync('sh', ['-c', `ANTHROPIC_API_KEY=${key} claude -p hi`], {}, { run: () => ({ status: 0 }), clock: clockFrom(T0, 2000) });
    const hold = holdDuring(T0, T0 + MIN);
    expect(hold.command).not.toContain(key);
    expect(hold.command).toContain('claude -p hi');
  });
});

describe('the synchronous shells that go through it', () => {
  const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

  it("the supervisor's sh, and no synchronous `claude auth status` in it or the modules split from it (the subscription check runs asynchronously)", () => {
    expect(read('./supervisor.mjs')).toContain("const r = heldSpawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });");
    for (const file of LOOP_SOURCES) {
      const src = read(`./${file}`);
      expect(src, file).not.toContain('authSh');
      expect(src, file).not.toContain('subscriptionSignIn(');
      expect(src, file).not.toMatch(/\bspawnSync\(/);
    }
  });

  it("the supervisor's gh and git ls-remote calls end within 30 s", () => {
    const src = read('./supervisor.mjs');
    expect(src).toContain("const NET_LIMIT = { timeout: 30_000, killSignal: 'SIGKILL' };");
    const calls = src.match(/\bsh\('gh', [^\n]*/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const call of calls) expect(call).toContain('...NET_LIMIT');
    const asyncCalls = src.match(/\brunAsync\('gh', [^\n]*/g) ?? [];
    expect(asyncCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of asyncCalls) expect(call).toContain('timeoutMs: 30_000');
    expect(src).toContain("sh('gh', ['pr', 'list', '--state', 'merged', '--limit', '50', '--json', 'headRefName'], { cwd: ROOT, ...NET_LIMIT })");
    expect(src).toMatch(/sh\('git', \['ls-remote'[^\n]*\.\.\.NET_LIMIT/);
  });

  it("the dashboard's git shell, and its key and set-up shell within 2 minutes unless a call sets its own", () => {
    const src = read('../dashboard/server.mjs');
    expect(src).toContain("const realSh = (cmd, args, opts) => heldSpawnSync(cmd, args, { ...opts, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });");
    expect(src).toContain("heldSpawnSync(cmd, args, { env: shellEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, killSignal: 'SIGKILL', ...opts });");
    expect(src).not.toMatch(/\bspawnSync\(/);
  });
});

// Runs a script in a child that imports the modules by file URL; the child prints a JSON line.
function inChild(body) {
  const script = `import * as holds from ${JSON.stringify(HOLDS_URL)};\nimport { defaultSh } from ${JSON.stringify(WORKTREE_URL)};\nimport cp from 'node:child_process';\n${body}`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`child failed (${r.status}): ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
}

describe('recordSyncChildren', () => {
  it('records a call made through a named spawnSync import of another module', () => {
    const out = inChild(`
      holds.recordSyncChildren({ minMs: 0 });
      defaultSh('true', []);
      console.log(JSON.stringify(holds.heldList().map((h) => h.command)));`);
    expect(out).toEqual(['true']);
  });

  it('records execFileSync and execSync', () => {
    const out = inChild(`
      holds.recordSyncChildren({ minMs: 0 });
      cp.execFileSync('true');
      cp.execSync('true');
      console.log(JSON.stringify(holds.heldList().map((h) => h.command)));`);
    expect(out).toEqual(['true', 'true']);
  });

  it('labels an execSync by its script and an execFileSync by its command words', () => {
    const out = inChild(`
      holds.recordSyncChildren({ minMs: 0 });
      cp.execSync('echo acme-script');
      cp.execFileSync('git', ['--version']);
      console.log(JSON.stringify(holds.heldList().map((h) => h.command)));`);
    expect(out).toEqual(['echo acme-script', 'git']);
  });

  it('records heldSpawnSync once, not twice', () => {
    const out = inChild(`
      holds.recordSyncChildren({ minMs: 0 });
      holds.heldSpawnSync('true', [], {}, { minMs: 0 });
      console.log(JSON.stringify(holds.heldList().map((h) => h.command)));`);
    expect(out).toEqual(['true']);
  });

  it('a second install adds no second record, and its undo does nothing', () => {
    const out = inChild(`
      const undo1 = holds.recordSyncChildren({ minMs: 0 });
      const undo2 = holds.recordSyncChildren({ minMs: 0 });
      undo2();
      defaultSh('true', []);
      const whileOn = holds.heldList().length;
      undo1();
      defaultSh('true', []);
      console.log(JSON.stringify({ whileOn, after: holds.heldList().length }));`);
    expect(out).toEqual({ whileOn: 1, after: 1 });
  });

  it('undo stops the recording and restores the originals', () => {
    const out = inChild(`
      const before = cp.spawnSync;
      const undo = holds.recordSyncChildren({ minMs: 0 });
      const hooked = cp.spawnSync !== before;
      undo();
      defaultSh('true', []);
      console.log(JSON.stringify({ hooked, restored: cp.spawnSync === before, count: holds.heldList().length }));`);
    expect(out).toEqual({ hooked: true, restored: true, count: 0 });
  });

  it('keeps no call under minMs', () => {
    const out = inChild(`
      holds.recordSyncChildren({ minMs: 60000 });
      defaultSh('true', []);
      console.log(JSON.stringify(holds.heldList().length));`);
    expect(out).toBe(0);
  });

  it('gives the result of the call unchanged, and records a call that threw', () => {
    const out = inChild(`
      holds.recordSyncChildren({ minMs: 0 });
      const out = cp.execSync('echo acme', { encoding: 'utf8' });
      let threw = false;
      try { cp.execFileSync('false'); } catch { threw = true; }
      console.log(JSON.stringify({ out, threw, count: holds.heldList().length }));`);
    expect(out).toEqual({ out: 'acme\n', threw: true, count: 2 });
  });

  it('the late-wake text names the command', () => {
    const out = inChild(`
      holds.recordSyncChildren({ minMs: 0 });
      const from = Date.now() - 1;
      cp.execSync('sleep 0.05');
      console.log(JSON.stringify(holds.holdDuring(from, Date.now() + 1)));`);
    expect(out.command).toBe('sleep 0.05');
    expect(lateWakeText(5 * MIN, out)).toContain('`sleep 0.05` held its event loop');
  });

  it('heldList is a copy', () => {
    noteHold({ command: 'git fetch', startedAt: T0, endedAt: T0 + 2000 });
    heldList().length = 0;
    expect(heldList()).toHaveLength(1);
  });
});

describe('the supervisor installs the record', () => {
  it('right after its imports', () => {
    const src = readFileSync(fileURLToPath(new URL('./supervisor.mjs', import.meta.url)), 'utf8');
    expect(src).toContain('recordSyncChildren();');
  });

  it('counts a session being read as in hand wherever a held set is built, and as running', () => {
    const src = readFileSync(fileURLToPath(new URL('./supervisor.mjs', import.meta.url)), 'utf8');
    expect(src).toContain('const inHandSessions = () => [...sessions.values(), ...closing.values()];');
    expect(src.match(/inHandSessions\(\)/g).length).toBeGreaterThanOrEqual(5);
    expect(src).toContain('sessions.has(s) || closing.has(s) || preparing.has(s)');
  });

  it('runs no install, answer step, fetch, health check or session read synchronously', () => {
    for (const file of LOOP_SOURCES) {
      const src = readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), 'utf8');
      expect(src, file).not.toContain("sh('sleep'");
      expect(src, file).not.toMatch(/sh\(NODE\.node\(\), \[FOREMAN_BIN, 'health'\]/);
      expect(src, file).not.toContain('applyOwnerAnswers');
      expect(src, file).not.toContain('sessionTokens(');
    }
    const src = readFileSync(fileURLToPath(new URL('./supervisor.mjs', import.meta.url)), 'utf8');
    expect(src).toContain('const CODE = DRY ? null : codeVersionWatch();');
  });
});
