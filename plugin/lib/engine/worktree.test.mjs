import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkSlot, ensureWorktree, prepareWorktree, slotIds, WORKTREE_LIMITS, worktreeDirty, worktreeNeeds, worktreeOf } from './worktree.mjs';

const fakeSh = (answer = () => undefined) => {
  const calls = [];
  const sh = (cmd, args, opts = {}) => {
    calls.push({ cmd, args, opts });
    return answer(cmd, args, opts, calls) ?? { status: 0, stdout: '' };
  };
  return { sh, calls };
};
const said = (call) => [call.cmd, ...call.args].join(' ');

describe('worktreeOf', () => {
  it('puts a slot under the given state dir', () => {
    expect(worktreeOf('/repo/.foreman', 3)).toBe(join('/repo/.foreman', 'worktrees', 'w3'));
  });
});

describe('slotIds and checkSlot', () => {
  it('lists w1..wN', () => {
    expect(slotIds({ slots: 3 })).toEqual(['w1', 'w2', 'w3']);
    expect(slotIds({ slots: 1 })).toEqual(['w1']);
  });
  it('accepts 1..config.slots and refuses the rest', () => {
    const config = { slots: 4 };
    for (const n of [1, 2, 3, 4]) expect(() => checkSlot(n, config)).not.toThrow();
    for (const n of [0, 5, -1, 1.5, '2', NaN]) expect(() => checkSlot(n, config)).toThrow(/slot/);
  });
});

describe('worktreeDirty', () => {
  const dirty = (stdout, generated = []) => worktreeDirty('/wt', { generated, sh: fakeSh(() => ({ status: 0, stdout })).sh });
  it('is clean with nothing listed', () => expect(dirty('')).toBe(false));
  it('is dirty with any change when nothing is generated', () => {
    expect(dirty(' M tracker/dashboard.html\n')).toBe(true);
  });
  it('ignores an exact generated path', () => {
    const generated = [{ path: 'tracker/dashboard.html', regenerate: 'x' }];
    expect(dirty(' M tracker/dashboard.html\n', generated)).toBe(false);
    expect(dirty(' M tracker/dashboard.html\n?? scratch.txt\n', generated)).toBe(true);
    expect(dirty(' M src/lib/env.ts\n', generated)).toBe(true);
  });
  it('ignores paths that match a generated glob, and only those', () => {
    const generated = [{ path: 'dist/**', regenerate: 'x' }, { path: '*.gen.ts', regenerate: 'x' }];
    expect(dirty(' M dist/a/b.js\n?? x.gen.ts\n', generated)).toBe(false);
    expect(dirty(' M dist/a.js\n M src/x.gen.ts\n', generated)).toBe(true);
  });
  it('reads the new name of a rename', () => {
    const generated = [{ path: 'out.txt', regenerate: 'x' }];
    expect(dirty('R  old.txt -> out.txt\n', generated)).toBe(false);
  });
  it('asks git in the given folder', () => {
    const f = fakeSh();
    worktreeDirty('/wt', { generated: [], sh: f.sh });
    expect(said(f.calls[0])).toBe('git status --porcelain');
    expect(f.calls[0].opts.cwd).toBe('/wt');
  });
});

describe('ensureWorktree', () => {
  let anchor;
  let stateDir;
  let path;
  let config;
  beforeEach(() => {
    anchor = mkdtempSync(join(tmpdir(), 'foreman-wt-'));
    stateDir = join(anchor, '.foreman');
    writeFileSync(join(anchor, '.env.local'), 'not read by the code\n');
    path = worktreeOf(stateDir, 1);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, '.git'), 'gitdir: elsewhere\n');
    writeFileSync(join(path, 'package-lock.json'), '{"lockfileVersion":3}');
    config = { slots: 3, remote: 'origin', baseBranch: 'main', envFile: '.env.local', install: { run: 'npm ci', when: 'package-lock.json' } };
  });
  afterEach(() => rmSync(anchor, { recursive: true, force: true }));

  const run = (f, n = 1, over = {}) => ensureWorktree({ anchor, stateDir, n, config: { ...config, ...over }, sh: f.sh });
  const hashFile = () => join(stateDir, 'slots', 'w1.install');

  it('links the env file and installs once per hash of the when-file', () => {
    const f = fakeSh();
    expect(run(f)).toEqual({ path, created: false, installed: true });
    expect(lstatSync(join(path, '.env.local')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(path, '.env.local'))).toBe(join(anchor, '.env.local'));
    expect(f.calls.map(said)).toEqual(['sh -c npm ci']);
    expect(f.calls[0].opts.cwd).toBe(path);
    expect(readFileSync(hashFile(), 'utf8').trim()).toMatch(/^[0-9a-f]{40}$/);

    expect(run(f)).toEqual({ path, created: false, installed: false });
    expect(f.calls.length).toBe(1);
  });
  it('installs again when the when-file changes', () => {
    const f = fakeSh();
    run(f);
    writeFileSync(join(path, 'package-lock.json'), '{"lockfileVersion":3,"x":1}');
    expect(run(f).installed).toBe(true);
    expect(f.calls.length).toBe(2);
  });
  it('never installs when the when-file is absent', () => {
    rmSync(join(path, 'package-lock.json'));
    const f = fakeSh();
    expect(run(f).installed).toBe(false);
    expect(f.calls.length).toBe(0);
    expect(existsSync(hashFile())).toBe(false);
  });
  it('never installs when install is null', () => {
    const f = fakeSh();
    expect(run(f, 1, { install: null }).installed).toBe(false);
    expect(f.calls.length).toBe(0);
  });
  it('runs a custom install command', () => {
    writeFileSync(join(path, 'requirements.txt'), 'pytest\n');
    const f = fakeSh();
    run(f, 1, { install: { run: 'pip install -r requirements.txt', when: 'requirements.txt' } });
    expect(said(f.calls[0])).toBe('sh -c pip install -r requirements.txt');
  });
  it('with install.creates, installs again when that path is missing though the hash is unchanged', () => {
    const f = fakeSh();
    const creates = { install: { ...config.install, creates: 'node_modules' } };
    expect(run(f, 1, creates).installed).toBe(true);
    expect(run(f, 1, creates).installed).toBe(true); // still no node_modules
    mkdirSync(join(path, 'node_modules'));
    expect(run(f, 1, creates).installed).toBe(false);
    expect(f.calls.map(said)).toEqual(['sh -c npm ci', 'sh -c npm ci']);
  });
  it('without install.creates, a missing node_modules does not trigger an install', () => {
    const f = fakeSh();
    run(f);
    expect(run(f).installed).toBe(false);
  });
  it('keeps no hash when the install fails, and names the slot', () => {
    const f = fakeSh(() => ({ status: 1, stdout: '' }));
    expect(() => run(f)).toThrow(/w1/);
    expect(existsSync(hashFile())).toBe(false);
  });
  it('makes no link when the anchor lacks the env file', () => {
    rmSync(join(anchor, '.env.local'));
    run(fakeSh());
    expect(existsSync(join(path, '.env.local'))).toBe(false);
  });
  it('links the file named by config.envFile', () => {
    writeFileSync(join(anchor, '.env'), 'x\n');
    run(fakeSh(), 1, { envFile: '.env' });
    expect(readlinkSync(join(path, '.env'))).toBe(join(anchor, '.env'));
    expect(existsSync(join(path, '.env.local'))).toBe(false);
  });
  it("never links, copies or creates Foreman's own keys file", () => {
    writeFileSync(join(anchor, '.env.foreman'), 'JIRA_CLIENT_SECRET=acme-secret\n');
    run(fakeSh(), 1, { foremanEnvFile: '.env.foreman' });
    expect(readlinkSync(join(path, '.env.local'))).toBe(join(anchor, '.env.local'));
    expect(() => lstatSync(join(path, '.env.foreman'))).toThrow(expect.objectContaining({ code: 'ENOENT' }));
  });
  it('without foremanEnvFile in the config, still leaves .env.foreman out', () => {
    writeFileSync(join(anchor, '.env.foreman'), 'JIRA_CLIENT_SECRET=acme-secret\n');
    run(fakeSh());
    expect(() => lstatSync(join(path, '.env.foreman'))).toThrow(expect.objectContaining({ code: 'ENOENT' }));
  });
  it('makes no link at all when envFile names the keys file', () => {
    writeFileSync(join(anchor, '.env.foreman'), 'JIRA_CLIENT_SECRET=acme-secret\n');
    run(fakeSh(), 1, { envFile: '.env.foreman', foremanEnvFile: '.env.foreman' });
    expect(() => lstatSync(join(path, '.env.foreman'))).toThrow(expect.objectContaining({ code: 'ENOENT' }));
    expect(existsSync(join(path, '.env.local'))).toBe(false);
  });
  it('refuses a slot outside 1..config.slots', () => {
    expect(() => run(fakeSh(), 4)).toThrow(/slot/);
    expect(() => run(fakeSh(), 0)).toThrow(/slot/);
  });
  it('creates a missing worktree at remote/base, retrying a failed fetch', () => {
    rmSync(path, { recursive: true, force: true });
    let fetches = 0;
    const f = fakeSh((cmd, args) => {
      if (cmd === 'git' && args[0] === 'fetch') return { status: ++fetches < 3 ? 1 : 0, stdout: '' };
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'add') {
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, '.git'), 'gitdir: elsewhere\n');
        writeFileSync(join(path, 'package-lock.json'), '{}');
      }
      return undefined;
    });
    expect(run(f, 1, { remote: 'up', baseBranch: 'trunk' })).toEqual({ path, created: true, installed: true });
    const lines = f.calls.map(said);
    expect(lines.filter((l) => l === 'git fetch --quiet up trunk').length).toBe(3);
    expect(lines).toContain(`git worktree add --detach ${path} up/trunk`);
    expect(f.calls.find((c) => c.args[1] === 'add').opts.cwd).toBe(anchor);
  });
  it('gives up after three failed fetches', () => {
    rmSync(path, { recursive: true, force: true });
    const f = fakeSh((cmd, args) => ({ status: args[0] === 'fetch' ? 1 : 0, stdout: '' }));
    expect(() => run(f)).toThrow(/fetch/);
    expect(f.calls.filter((c) => c.args[0] === 'fetch').length).toBe(3);
  });
});

describe('worktreeNeeds and prepareWorktree', () => {
  let anchor;
  let stateDir;
  let path;
  let config;
  beforeEach(() => {
    anchor = mkdtempSync(join(tmpdir(), 'foreman-wt-async-'));
    stateDir = join(anchor, '.foreman');
    writeFileSync(join(anchor, '.env.local'), 'not read by the code\n');
    path = worktreeOf(stateDir, 1);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, '.git'), 'gitdir: elsewhere\n');
    writeFileSync(join(path, 'package-lock.json'), '{"lockfileVersion":3}');
    config = { slots: 3, remote: 'origin', baseBranch: 'main', envFile: '.env.local', install: { run: 'npm ci', when: 'package-lock.json' } };
  });
  afterEach(() => rmSync(anchor, { recursive: true, force: true }));

  const needs = (over = {}) => worktreeNeeds({ stateDir, n: 1, config: { ...config, ...over } });
  const hashFile = () => join(stateDir, 'slots', 'w1.install');

  // A fake async run: records each call, answers { status: 0 } unless the answer function says more.
  const fakeRun = (answer = () => undefined) => {
    const calls = [];
    const run = async (cmd, args, opts = {}) => {
      calls.push({ cmd, args, opts });
      return { status: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...(answer(cmd, args, opts, calls) ?? {}) };
    };
    return { run, calls };
  };
  const prepare = (f, over = {}, extra = {}) => prepareWorktree({ anchor, stateDir, n: 1, config: { ...config, ...over }, run: f.run, ...extra });

  describe('worktreeNeeds', () => {
    it('needs a create when the folder is missing, and no install then', () => {
      rmSync(path, { recursive: true, force: true });
      expect(needs()).toEqual({ create: true, install: false });
    });
    it('needs an install when no hash is recorded', () => {
      expect(needs()).toEqual({ create: false, install: true });
    });
    it('needs nothing once the hash is recorded, and an install when the file changes', () => {
      mkdirSync(join(stateDir, 'slots'), { recursive: true });
      writeFileSync(hashFile(), `${createHash('sha1').update(readFileSync(join(path, 'package-lock.json'))).digest('hex')}\n`);
      expect(needs()).toEqual({ create: false, install: false });
      writeFileSync(join(path, 'package-lock.json'), '{"changed":1}');
      expect(needs()).toEqual({ create: false, install: true });
    });
    it('needs an install when `creates` is missing though the hash is recorded', () => {
      mkdirSync(join(stateDir, 'slots'), { recursive: true });
      writeFileSync(hashFile(), `${createHash('sha1').update(readFileSync(join(path, 'package-lock.json'))).digest('hex')}\n`);
      const creates = { install: { ...config.install, creates: 'node_modules' } };
      expect(needs(creates)).toEqual({ create: false, install: true });
      mkdirSync(join(path, 'node_modules'));
      expect(needs(creates)).toEqual({ create: false, install: false });
    });
    it('needs no install with install null or no when-file', () => {
      expect(needs({ install: null })).toEqual({ create: false, install: false });
      rmSync(join(path, 'package-lock.json'));
      expect(needs()).toEqual({ create: false, install: false });
    });
  });

  describe('prepareWorktree', () => {
    it('exports its limits', () => {
      expect(WORKTREE_LIMITS).toEqual({ fetchMs: 60_000, gitMs: 120_000, installMs: 20 * 60_000 });
    });

    it('links the env file, installs, and writes the hash after an install that exits 0', async () => {
      const f = fakeRun();
      expect(await prepare(f)).toEqual({ path, created: false, installed: true });
      expect(readlinkSync(join(path, '.env.local'))).toBe(join(anchor, '.env.local'));
      expect(f.calls.map(said)).toEqual(['sh -c npm ci']);
      expect(readFileSync(hashFile(), 'utf8').trim()).toMatch(/^[0-9a-f]{40}$/);
      expect(await prepare(f)).toEqual({ path, created: false, installed: false });
      expect(f.calls).toHaveLength(1);
    });

    it('passes the time limit, the folder and the track to every call', async () => {
      rmSync(path, { recursive: true, force: true });
      const track = new Set();
      const f = fakeRun((cmd, args) => {
        if (args[0] === 'worktree' && args[1] === 'add') {
          mkdirSync(path, { recursive: true });
          writeFileSync(join(path, '.git'), 'gitdir: elsewhere\n');
          writeFileSync(join(path, 'package-lock.json'), '{}');
        }
      });
      expect(await prepare(f, { remote: 'up', baseBranch: 'trunk' }, { track })).toEqual({ path, created: true, installed: true });
      const by = (pred) => f.calls.find(pred);
      expect(by((c) => c.args[0] === 'fetch')).toMatchObject({ cmd: 'git', args: ['fetch', '--quiet', 'up', 'trunk'], opts: { cwd: anchor, timeoutMs: 60_000, track } });
      expect(by((c) => c.args[0] === 'worktree' && c.args[1] === 'prune').opts).toMatchObject({ cwd: anchor, timeoutMs: 120_000, track });
      expect(by((c) => c.args[1] === 'add')).toMatchObject({ args: ['worktree', 'add', '--detach', path, 'up/trunk'], opts: { cwd: anchor, timeoutMs: 120_000, track } });
      expect(by((c) => c.cmd === 'sh')).toMatchObject({ args: ['-c', 'npm ci'], opts: { cwd: path, timeoutMs: 20 * 60_000, track } });
    });

    it('retries a failed fetch and gives up after three tries with the same text', async () => {
      rmSync(path, { recursive: true, force: true });
      const f = fakeRun((cmd, args) => (args[0] === 'fetch' ? { status: 1 } : undefined));
      await expect(prepare(f)).rejects.toThrow('Could not fetch origin/main after 3 tries.');
      expect(f.calls.filter((c) => c.args[0] === 'fetch')).toHaveLength(3);
    });

    it('says so when the worktree cannot be added', async () => {
      rmSync(path, { recursive: true, force: true });
      const f = fakeRun((cmd, args) => (args[1] === 'add' ? { status: 1 } : undefined));
      await expect(prepare(f)).rejects.toThrow(`Could not create the worktree for slot w1 at ${path}.`);
    });

    it('says so when the install exits 1, and keeps no hash', async () => {
      const f = fakeRun((cmd) => (cmd === 'sh' ? { status: 1 } : undefined));
      await expect(prepare(f)).rejects.toThrow(`The install command (npm ci) failed in slot w1 (${path}).`);
      expect(existsSync(hashFile())).toBe(false);
    });

    it('says a timed-out install did not finish within 20 minutes, and keeps no hash', async () => {
      const f = fakeRun((cmd) => (cmd === 'sh' ? { status: 0, timedOut: true } : undefined));
      await expect(prepare(f)).rejects.toThrow(`The install command (npm ci) did not finish within 20 minutes in slot w1 (${path}).`);
      expect(existsSync(hashFile())).toBe(false);
    });

    it('throws cancelled before the install when live() turns false, and runs nothing more', async () => {
      let live = true;
      const f = fakeRun((cmd, args) => {
        if (args[0] === 'fetch') live = false;
      });
      rmSync(path, { recursive: true, force: true });
      await expect(prepare(f, {}, { live: () => live })).rejects.toThrow('cancelled');
      expect(f.calls.map(said)).toEqual(['git fetch --quiet origin main']);
    });

    it('throws cancelled before the install even when the folder exists', async () => {
      const f = fakeRun();
      await expect(prepare(f, {}, { live: () => false })).rejects.toThrow('cancelled');
      expect(f.calls).toHaveLength(0);
      expect(existsSync(hashFile())).toBe(false);
    });

    it('refuses a slot outside 1..config.slots', async () => {
      await expect(prepareWorktree({ anchor, stateDir, n: 4, config, run: fakeRun().run })).rejects.toThrow(/slot/);
    });
  });
});
