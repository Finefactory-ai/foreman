import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterSignal, codeChange, codeVersion, codeVersionWatch, INTERRUPT_EXIT, nextPending, RESTART_EXIT, restartStep, restartWhy } from './code-version.mjs';

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete ENV[key];
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, env: ENV, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const write = (file, text) => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
};

let base;
let repo;
let plug;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'foreman-code-version-'));
  repo = join(base, 'repo');
  plug = join(repo, 'plug');
  write(join(plug, 'x.mjs'), 'export const x = 1;\n');
  write(join(plug, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'foreman', version: '9.9.9' }));
  write(join(repo, 'docs', 'note.md'), 'a note\n');
  git(base, 'init', '-q', '-b', 'main', repo);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'start');
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('codeVersion', () => {
  it("is the tree of the plugin folder at HEAD, labelled with HEAD's short sha", () => {
    const v = codeVersion({ dir: plug });
    expect(v).toEqual({ id: git(repo, 'rev-parse', 'HEAD:plug'), label: git(repo, 'rev-parse', '--short', 'HEAD') });
  });

  it('changes with a commit to the plugin folder', () => {
    const before = codeVersion({ dir: plug });
    write(join(plug, 'x.mjs'), 'export const x = 2;\n');
    git(repo, 'commit', '-qam', 'change x');
    const after = codeVersion({ dir: plug });
    expect(after.id).not.toBe(before.id);
    expect(after.label).not.toBe(before.label);
  });

  it('stays the same for a commit outside the plugin folder', () => {
    const before = codeVersion({ dir: plug });
    write(join(repo, 'docs', 'note.md'), 'another note\n');
    git(repo, 'commit', '-qam', 'docs');
    expect(codeVersion({ dir: plug }).id).toBe(before.id);
  });

  it('stays the same for an edit not committed', () => {
    const before = codeVersion({ dir: plug });
    write(join(plug, 'x.mjs'), 'export const x = 3;\n');
    expect(codeVersion({ dir: plug }).id).toBe(before.id);
  });

  it('computes no label when asked not to', () => {
    expect(codeVersion({ dir: plug, label: false }).label).toBeUndefined();
  });

  it('is v<version> outside git, and null with neither', () => {
    const loose = join(base, 'loose');
    write(join(loose, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'foreman', version: '1.2.3' }));
    expect(codeVersion({ dir: loose })).toEqual({ id: 'v1.2.3', label: 'v1.2.3' });
    const empty = join(base, 'empty');
    mkdirSync(empty);
    expect(codeVersion({ dir: empty })).toBeNull();
  });
});

describe('codeChange', () => {
  const a = { id: 'tree-a', label: 'aaaaaaa' };
  const b = { id: 'tree-b', label: 'bbbbbbb' };
  it('is null for the same code, an unknown version or the refused one', () => {
    expect(codeChange(a, { id: 'tree-a' }, null)).toBeNull();
    expect(codeChange(null, b, null)).toBeNull();
    expect(codeChange(a, null, null)).toBeNull();
    expect(codeChange(a, b, 'tree-b')).toBeNull();
  });
  it('says from what to what otherwise', () => {
    expect(codeChange(a, b, 'tree-c')).toEqual({ from: 'aaaaaaa', to: 'bbbbbbb', id: 'tree-b' });
  });
});

describe('restartStep', () => {
  const pending = { from: 'aaaaaaa', to: 'bbbbbbb', id: 'tree-b' };
  const ok = () => ({ ok: true });
  it('does nothing with no change pending', () => {
    expect(restartStep({ pending: null, busy: false, check: ok })).toEqual({ action: 'none' });
  });
  it('waits while a slot is being set up or a session is being stopped', () => {
    let checked = false;
    expect(restartStep({ pending, busy: true, check: () => (checked = true) })).toEqual({ action: 'wait' });
    expect(checked).toBe(false);
  });
  it('restarts when the new code accepts the config, sessions running or not', () => {
    expect(restartStep({ pending, busy: false, check: ok })).toEqual({ action: 'restart' });
  });
  it('refuses, with why, when the new code rejects the config', () => {
    expect(restartStep({ pending, busy: false, check: () => ({ ok: false, reason: 'bogus: unknown key' }) })).toEqual({
      action: 'refuse',
      event: { text: 'New Foreman code (bbbbbbb) rejects foreman.config.json (bogus: unknown key); carrying on with the code already loaded.', kind: 'warn' },
    });
  });
  it('exits with 75 to ask for the restart', () => {
    expect(RESTART_EXIT).toBe(75);
  });
});

describe('nextPending', () => {
  const at = '2026-10-25T09:00:00.000Z';
  const later = '2026-10-25T09:05:00.000Z';
  const change = { from: 'a1b2c3d', to: undefined, id: 'tree-b' };
  it('is null with no change, with or without a pending restart (a refused id, code that reverted)', () => {
    expect(nextPending(null, null, { to: null, at })).toBeNull();
    expect(nextPending({ from: 'a1b2c3d', to: 'e4f5a6b', id: 'tree-b', since: at }, null, { to: null, at: later })).toBeNull();
  });
  it('starts the pending restart at the first change', () => {
    expect(nextPending(null, change, { to: 'e4f5a6b', at })).toEqual({ from: 'a1b2c3d', to: 'e4f5a6b', id: 'tree-b', since: at });
  });
  it('gives back the same pending object for the same code', () => {
    const pending = nextPending(null, change, { to: 'e4f5a6b', at });
    expect(nextPending(pending, change, { to: 'e4f5a6b', at: later })).toBe(pending);
  });
  it('keeps the first since when the code changes again before the restart', () => {
    const pending = nextPending(null, change, { to: 'e4f5a6b', at });
    expect(nextPending(pending, { from: 'a1b2c3d', id: 'tree-c' }, { to: 'c7d8e9f', at: later })).toEqual({ from: 'a1b2c3d', to: 'c7d8e9f', id: 'tree-c', since: at });
  });
});

describe('restartWhy', () => {
  const p = { from: 'a1b2c3d', to: 'e4f5a6b' };
  it('says the stories in progress keep running', () => {
    expect(restartWhy(p)).toBe('New code (a1b2c3d → e4f5a6b): restarting as soon as the slots being set up are ready; the stories in progress keep running.');
    expect(restartWhy(p, 3)).toBe(restartWhy(p));
  });
  it('shows an empty label as ?', () => {
    expect(restartWhy({ from: '', to: 'e4f5a6b' })).toBe('New code (? → e4f5a6b): restarting as soon as the slots being set up are ready; the stories in progress keep running.');
    expect(restartWhy({ from: 'a1b2c3d', to: '' })).toBe('New code (a1b2c3d → ?): restarting as soon as the slots being set up are ready; the stories in progress keep running.');
  });
});

describe('a signal while the supervisor exits', () => {
  it('stops a run that is not exiting, marks a restart exit interrupted, and ignores one while stopping', () => {
    expect(afterSignal(null)).toBe('stop');
    expect(afterSignal('restart')).toBe('interrupt');
    expect(afterSignal('stop')).toBe('none');
  });
  it('exits 130 instead of 75 after an interrupted restart, so startSupervisor does not start it again', () => {
    expect(INTERRUPT_EXIT).toBe(130);
    expect(INTERRUPT_EXIT).not.toBe(RESTART_EXIT);
  });
});

describe('codeVersionWatch', () => {
  // A fake git that counts its calls, and a stat that reads a table of fingerprints.
  function rig({ inGit = true } = {}) {
    const calls = [];
    const files = new Map();
    const sh = (cmd, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'rev-parse' && args.includes('--git-dir')) return inGit ? { status: 0, stdout: '/acme/.git\n/acme/.git' } : { status: 128, stdout: '' };
      if (args[0] === 'rev-parse' && args[1] === 'HEAD:./') return inGit ? { status: 0, stdout: 'tree-1' } : { status: 128, stdout: '' };
      if (args[0] === 'rev-parse' && args[1] === '--short') return { status: 0, stdout: 'abc1234' };
      return { status: 1, stdout: '' };
    };
    const stat = (f) => {
      if (!files.has(f)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { mtimeMs: files.get(f), size: 1 };
    };
    const readFile = (f) => {
      if (f.endsWith('HEAD')) return 'ref: refs/heads/main\n';
      if (f.endsWith('plugin.json')) return JSON.stringify({ version: '1.2.3' });
      throw new Error('no file');
    };
    return { calls, files, sh, stat, readFile };
  }

  it('runs git on the first call and not again while nothing changed', () => {
    const r = rig();
    for (const f of ['HEAD', 'index']) r.files.set(`/acme/.git/${f}`, 1);
    r.files.set('/acme/.git/refs/heads/main', 1);
    const watch = codeVersionWatch({ dir: '/acme/plug', sh: r.sh, stat: r.stat, readFile: r.readFile });
    expect(watch.version()).toEqual({ id: 'tree-1', label: 'abc1234' });
    const first = r.calls.length;
    expect(first).toBeGreaterThan(0);
    expect(watch.version()).toEqual({ id: 'tree-1', label: 'abc1234' });
    expect(watch.version({ label: false })).toEqual({ id: 'tree-1', label: 'abc1234' });
    expect(r.calls).toHaveLength(first);
  });

  it.each([['/acme/.git/HEAD'], ['/acme/.git/index'], ['/acme/.git/refs/heads/main']])('runs git again when the mtime of %s changes', (file) => {
    const r = rig();
    for (const f of ['/acme/.git/HEAD', '/acme/.git/index', '/acme/.git/refs/heads/main']) r.files.set(f, 1);
    const watch = codeVersionWatch({ dir: '/acme/plug', sh: r.sh, stat: r.stat, readFile: r.readFile });
    watch.version();
    const first = r.calls.length;
    r.files.set(file, 2);
    watch.version();
    expect(r.calls.length).toBeGreaterThan(first);
    const second = r.calls.length;
    watch.version();
    expect(r.calls).toHaveLength(second);
  });

  it('runs git again when packed-refs appears', () => {
    const r = rig();
    r.files.set('/acme/.git/HEAD', 1);
    const watch = codeVersionWatch({ dir: '/acme/plug', sh: r.sh, stat: r.stat, readFile: r.readFile });
    watch.version();
    const first = r.calls.length;
    r.files.set('/acme/.git/packed-refs', 5);
    watch.version();
    expect(r.calls.length).toBeGreaterThan(first);
  });

  it('adds only the short-HEAD call when a label is wanted after a call without one', () => {
    const r = rig();
    r.files.set('/acme/.git/HEAD', 1);
    const watch = codeVersionWatch({ dir: '/acme/plug', sh: r.sh, stat: r.stat, readFile: r.readFile });
    expect(watch.version({ label: false })).toEqual({ id: 'tree-1' });
    const first = r.calls.length;
    expect(watch.version().label).toBe('abc1234');
    const added = r.calls.slice(first);
    expect(added).toEqual(['rev-parse --short HEAD']);
    const again = r.calls.length;
    watch.version();
    expect(r.calls).toHaveLength(again);
  });

  it('outside git, runs git once and then watches plugin.json', () => {
    const r = rig({ inGit: false });
    r.files.set('/acme/plug/.claude-plugin/plugin.json', 1);
    const watch = codeVersionWatch({ dir: '/acme/plug', sh: r.sh, stat: r.stat, readFile: r.readFile });
    expect(watch.version()).toEqual({ id: 'v1.2.3', label: 'v1.2.3' });
    const first = r.calls.length;
    watch.version();
    watch.version({ label: false });
    expect(r.calls).toHaveLength(first);
    r.files.set('/acme/plug/.claude-plugin/plugin.json', 2);
    watch.version();
    expect(r.calls.length).toBeGreaterThan(first);
  });

  it('keeps nothing when git gives a tree but not its directories, so a commit is still seen', () => {
    const r = rig();
    const sh = (cmd, args, opts) => {
      if (args.includes('--git-dir')) return { status: 129, stdout: '' };
      const out = r.sh(cmd, args, opts);
      return args[1] === 'HEAD:./' ? { ...out, stdout: 'a'.repeat(40) } : out;
    };
    const watch = codeVersionWatch({ dir: '/acme/plug', sh, stat: r.stat, readFile: r.readFile });
    watch.version();
    const first = r.calls.length;
    watch.version();
    expect(r.calls.length).toBeGreaterThan(first);
  });

  it('a commit in the plugin folder of a real repo changes the id, a worktree too', () => {
    const watch = codeVersionWatch({ dir: plug });
    const before = watch.version();
    expect(before).toEqual(codeVersion({ dir: plug }));
    write(join(plug, 'x.mjs'), 'export const x = 2;\n');
    git(repo, 'commit', '-qam', 'change x');
    const after = watch.version();
    expect(after.id).not.toBe(before.id);
    expect(after).toEqual(codeVersion({ dir: plug }));
    const tree = join(base, 'tree');
    git(repo, 'worktree', 'add', '--detach', tree);
    const other = codeVersionWatch({ dir: join(tree, 'plug') });
    const one = other.version();
    write(join(tree, 'plug', 'x.mjs'), 'export const x = 9;\n');
    git(tree, 'commit', '-qam', 'in the worktree');
    expect(other.version().id).not.toBe(one.id);
  });
});
