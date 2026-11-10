import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CHECK_RUNS_FILE, checkRunsPath, checkTotals, findCheckRun, outputTail, TREE_ID, readCheckRuns, recordCheckRun, treeHash } from './check-runs.mjs';
import { readRuns, writeRun } from './run-record.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foreman-check-runs-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

// A repo with two committed files and a .gitignore ignoring *.log.
function repo() {
  const r = join(dir, 'repo');
  mkdirSync(r);
  git(r, 'init', '-q', '-b', 'main');
  writeFileSync(join(r, 'a.txt'), 'a\n');
  writeFileSync(join(r, 'b.txt'), 'b\n');
  writeFileSync(join(r, '.gitignore'), '*.log\n');
  git(r, 'add', '-A');
  git(r, 'commit', '-q', '-m', 'one');
  return r;
}

// A real git runner that notes each temp index treeHash points git at, and whether its folder
// existed then. Tests check only these folders: counting foreman-tree-* in the shared tmpdir
// races with other test files hashing trees in parallel.
function spySh(fail = () => false) {
  const temps = [];
  const sh = (cmd, args, opts = {}) => {
    const index = opts.env?.GIT_INDEX_FILE;
    if (index) temps.push({ folder: dirname(index), existed: existsSync(dirname(index)) });
    if (fail(args)) return { status: 1, stdout: '', stderr: 'failed' };
    return spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  };
  return { sh, temps };
}

describe('treeHash', () => {
  it('hashes a clean checkout to its commit tree, the same every time', () => {
    const r = repo();
    const want = git(r, 'rev-parse', 'HEAD^{tree}').trim();
    expect(treeHash({ cwd: r })).toBe(want);
    expect(treeHash({ cwd: r })).toBe(want);
  });

  it.each([
    ['an unstaged edit to a tracked file', (r) => writeFileSync(join(r, 'a.txt'), 'changed\n')],
    ['a staged edit', (r) => {
      writeFileSync(join(r, 'a.txt'), 'staged\n');
      git(r, 'add', 'a.txt');
    }],
    ['a new untracked file', (r) => writeFileSync(join(r, 'new.txt'), 'n\n')],
    ['a deleted tracked file', (r) => unlinkSync(join(r, 'b.txt'))],
  ])('changes with %s', (_, change) => {
    const r = repo();
    const before = treeHash({ cwd: r });
    change(r);
    const after = treeHash({ cwd: r });
    expect(after).toMatch(/^[0-9a-f]{40}([0-9a-f]{24})?$/);
    expect(after).not.toBe(before);
  });

  it('ignores a file .gitignore matches', () => {
    const r = repo();
    const before = treeHash({ cwd: r });
    writeFileSync(join(r, 'debug.log'), 'noise\n');
    expect(treeHash({ cwd: r })).toBe(before);
  });

  it('keeps a tracked file that .gitignore matches, from the copy of the real index', () => {
    const r = repo();
    writeFileSync(join(r, 'kept.log'), 'forced\n');
    git(r, 'add', '-f', 'kept.log');
    git(r, 'commit', '-q', '-m', 'two');
    expect(treeHash({ cwd: r })).toBe(git(r, 'rev-parse', 'HEAD^{tree}').trim());
  });

  it('leaves the real index, the files and no temp folder behind', () => {
    const r = repo();
    writeFileSync(join(r, 'a.txt'), 'unstaged\n');
    writeFileSync(join(r, 'b.txt'), 'staged\n');
    git(r, 'add', 'b.txt');
    writeFileSync(join(r, 'u.txt'), 'untracked\n');
    const status = git(r, 'status', '--porcelain');
    const cached = git(r, 'diff', '--cached', '--name-only');
    const index = readFileSync(join(r, '.git', 'index'));
    const { sh, temps } = spySh();
    expect(treeHash({ cwd: r, sh })).toMatch(/^[0-9a-f]{40}/);
    expect(git(r, 'status', '--porcelain')).toBe(status);
    expect(git(r, 'diff', '--cached', '--name-only')).toBe(cached);
    expect(readFileSync(join(r, '.git', 'index')).equals(index)).toBe(true);
    expect(temps.length).toBeGreaterThan(0);
    expect(temps.every((t) => t.existed && t.folder.startsWith(join(tmpdir(), 'foreman-tree-')))).toBe(true);
    expect(temps.some((t) => existsSync(t.folder))).toBe(false);
  });

  it('hashes two worktrees at the same commit the same', () => {
    const r = repo();
    git(r, 'worktree', 'add', '-q', join(dir, 'w1'));
    git(r, 'worktree', 'add', '-q', join(dir, 'w2'));
    const one = treeHash({ cwd: join(dir, 'w1') });
    expect(one).toBe(git(r, 'rev-parse', 'HEAD^{tree}').trim());
    expect(treeHash({ cwd: join(dir, 'w2') })).toBe(one);
    writeFileSync(join(dir, 'w2', 'x.txt'), 'x\n');
    expect(treeHash({ cwd: join(dir, 'w2') })).not.toBe(one);
    expect(treeHash({ cwd: join(dir, 'w1') })).toBe(one);
  });

  it('returns null outside a repo and for a missing folder', () => {
    const plain = join(dir, 'plain');
    mkdirSync(plain);
    const { sh, temps } = spySh();
    expect(treeHash({ cwd: plain, sh })).toBeNull();
    expect(treeHash({ cwd: join(dir, 'missing'), sh })).toBeNull();
    expect(temps).toEqual([]);
  });

  it.each(['add', 'write-tree'])('returns null and removes its temp folder when git %s fails', (step) => {
    const r = repo();
    const { sh, temps } = spySh((args) => args[0] === step);
    expect(treeHash({ cwd: r, sh })).toBeNull();
    expect(temps.length).toBeGreaterThan(0);
    expect(temps.every((t) => t.existed)).toBe(true);
    expect(temps.some((t) => existsSync(t.folder))).toBe(false);
  });

  it('returns null when git answers something that is not a tree id', () => {
    const sh = (cmd, args) => (args.includes('rev-parse') ? { status: 0, stdout: 'index\n' } : { status: 0, stdout: 'not-a-hash\n' });
    expect(treeHash({ cwd: dir, sh })).toBeNull();
  });
});

describe('outputTail', () => {
  it('keeps the last 30 lines', () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
    const tail = outputTail(text);
    expect(tail.split('\n')).toHaveLength(30);
    expect(tail.startsWith('line 21\n')).toBe(true);
    expect(tail.endsWith('line 50')).toBe(true);
  });

  it('keeps at most the last 3000 characters', () => {
    const tail = outputTail(`${'x'.repeat(5000)}END`);
    expect(tail).toHaveLength(3000);
    expect(tail.endsWith('END')).toBe(true);
  });

  it('blanks secret values and token-shaped text before cutting', () => {
    const secret = 'acme-secret-value-123';
    const text = `start ${secret}\n${'y'.repeat(2990)} ${secret}\nGH ghp_${'a'.repeat(30)}`;
    const tail = outputTail(text, { env: { GH_TOKEN: 'acme-env-key-9999' }, secrets: [secret] });
    expect(tail).not.toContain(secret);
    expect(tail).not.toContain('acme-secret');
    expect(tail).not.toContain('ghp_');
    expect(outputTail('key acme-env-key-9999', { env: { GH_TOKEN: 'acme-env-key-9999' } })).not.toContain('acme-env-key-9999');
  });

  it('gives an empty tail for no output', () => {
    expect(outputTail('')).toBe('');
    expect(outputTail(undefined)).toBe('');
  });
});

describe('recordCheckRun and readCheckRuns', () => {
  const state = () => join(dir, 'state', 'deep');

  it('round-trips, creating the folder', () => {
    expect(checkRunsPath('/s')).toBe(join('/s', CHECK_RUNS_FILE));
    expect(CHECK_RUNS_FILE).toBe('check-runs.jsonl');
    recordCheckRun(state(), { at: '2026-10-26T10:00:00.000Z', run: 'npm test', tree: 'a'.repeat(40), exit: 0 });
    recordCheckRun(state(), { at: '2026-10-26T11:00:00.000Z', run: 'npm test', tree: 'b'.repeat(40), exit: 1 });
    expect(readCheckRuns(state()).map((e) => e.tree[0])).toEqual(['a', 'b']);
  });

  it('skips blank and malformed lines, and gives [] for no file', () => {
    expect(readCheckRuns(state())).toEqual([]);
    mkdirSync(state(), { recursive: true });
    writeFileSync(checkRunsPath(state()), '\n{"run":"npm test"}\nnot json\n[1]\n"str"\n\n{"run":"b"}\n');
    expect(readCheckRuns(state())).toEqual([{ run: 'npm test' }, { run: 'b' }]);
  });

  it('cuts the file to its newest half over the cap, keeping the newest entry', () => {
    for (let i = 0; i < 40; i++) recordCheckRun(state(), { n: i, pad: 'p'.repeat(50) }, { maxBytes: 1000 });
    const size = statSync(checkRunsPath(state())).size;
    expect(size).toBeLessThan(1000 + 200);
    const entries = readCheckRuns(state());
    expect(entries.at(-1).n).toBe(39);
    expect(entries.length).toBeLessThan(40);
    // Whole lines only: every line parses.
    const lines = readFileSync(checkRunsPath(state()), 'utf8').split('\n').filter(Boolean);
    expect(lines.length).toBe(entries.length);
    // Oldest first, consecutive.
    expect(entries.map((e) => e.n)).toEqual(entries.map((_, i) => 40 - entries.length + i));
    expect(readdirSync(state())).toEqual([CHECK_RUNS_FILE]);
  });

  it('leaves a file under the cap alone', () => {
    for (let i = 0; i < 5; i++) recordCheckRun(state(), { n: i });
    expect(readCheckRuns(state()).map((e) => e.n)).toEqual([0, 1, 2, 3, 4]);
  });

  it('throws when the state folder cannot be made', () => {
    writeFileSync(join(dir, 'state'), 'a file');
    expect(() => recordCheckRun(state(), { n: 1 })).toThrow();
  });

  it('refuses to append through a link at check-runs.jsonl, leaving its target alone', () => {
    mkdirSync(state(), { recursive: true });
    const target = join(dir, 'target.txt');
    writeFileSync(target, 'keep\n');
    symlinkSync(target, checkRunsPath(state()));
    expect(() => recordCheckRun(state(), { n: 1 })).toThrow(/not a regular file/);
    expect(readFileSync(target, 'utf8')).toBe('keep\n');
    expect(lstatSync(checkRunsPath(state())).isSymbolicLink()).toBe(true);
  });

  it('refuses a dangling link and does not create its target', () => {
    mkdirSync(state(), { recursive: true });
    symlinkSync(join(dir, 'nowhere.txt'), checkRunsPath(state()));
    expect(() => recordCheckRun(state(), { n: 1 })).toThrow(/not a regular file/);
    expect(existsSync(join(dir, 'nowhere.txt'))).toBe(false);
  });

  it('refuses a folder at check-runs.jsonl', () => {
    mkdirSync(checkRunsPath(state()), { recursive: true });
    expect(() => recordCheckRun(state(), { n: 1 })).toThrow(/not a regular file/);
  });

  it('refuses a link even when the file is over the cap, and cuts nothing', () => {
    mkdirSync(state(), { recursive: true });
    const target = join(dir, 'target.txt');
    const big = `${'x'.repeat(99)}\n`.repeat(20);
    writeFileSync(target, big);
    symlinkSync(target, checkRunsPath(state()));
    expect(() => recordCheckRun(state(), { n: 1 }, { maxBytes: 1000 })).toThrow(/not a regular file/);
    expect(readFileSync(target, 'utf8')).toBe(big);
  });

  it('cuts through an unpredictable temp name, so a planted link at the old pid name is never written', () => {
    mkdirSync(state(), { recursive: true });
    const target = join(dir, 'target.txt');
    writeFileSync(target, 'keep\n');
    const planted = `${checkRunsPath(state())}.${process.pid}.tmp`;
    symlinkSync(target, planted);
    for (let i = 0; i < 40; i++) recordCheckRun(state(), { n: i, pad: 'p'.repeat(50) }, { maxBytes: 1000 });
    expect(readFileSync(target, 'utf8')).toBe('keep\n');
    expect(readCheckRuns(state()).at(-1).n).toBe(39);
    expect(readdirSync(state()).sort()).toEqual([CHECK_RUNS_FILE, `${CHECK_RUNS_FILE}.${process.pid}.tmp`]);
  });
});

describe('findCheckRun', () => {
  const T = 'a'.repeat(40);
  const U = 'b'.repeat(40);
  it('returns the newest real run of the command for the tree', () => {
    const entries = [
      { at: '1', run: 'npm test', tree: T, exit: 1, env: 'session' },
      { at: '2', run: 'npm test', tree: T, exit: 0, env: 'session' },
      { at: '3', run: 'npm test', tree: T, reused: true, exit: 0, env: 'session' },
      { at: '4', run: 'npm test', tree: U, exit: 0, env: 'session' },
      { at: '5', run: 'npm run lint', tree: T, exit: 0, env: 'session' },
      { at: '6', run: 'npm test', tree: T, exit: '0', env: 'session' },
      { at: '7', run: 'npm test', tree: T, exit: 0.5, env: 'session' },
      { at: 8, run: 'npm test', tree: T, exit: 0, env: 'session' },
    ];
    expect(findCheckRun(entries, { run: 'npm test', tree: T })).toBe(entries[1]);
    expect(findCheckRun(entries, { run: 'npm test', tree: U })).toBe(entries[3]);
    expect(findCheckRun(entries, { run: 'npm run x', tree: T })).toBeNull();
    expect(findCheckRun([], { run: 'npm test', tree: T })).toBeNull();
    expect(findCheckRun([{ at: '1', run: 'npm test', tree: T, exit: 0, reused: true, env: 'session' }], { run: 'npm test', tree: T })).toBeNull();
  });

  it('ignores a denied line with the same run, even one with a forged exit and tree', () => {
    const real = { at: '1', run: 'npm test', tree: T, exit: 1, env: 'session' };
    const entries = [real, { at: '2', run: 'npm test', full: true, denied: true }, { at: '3', run: 'npm test', tree: T, exit: 0, denied: true, env: 'session' }];
    expect(findCheckRun(entries, { run: 'npm test', tree: T })).toBe(real);
    expect(findCheckRun(entries.slice(1), { run: 'npm test', tree: T })).toBeNull();
  });

  it('never returns a line made in the caller\'s environment, or one with no env at all', () => {
    const entries = [
      { at: '1', run: 'npm test', tree: T, exit: 0 },
      { at: '2', run: 'npm test', tree: T, exit: 0, env: 'caller' },
      { at: '3', run: 'npm test', tree: T, exit: 0, env: 'Session' },
    ];
    expect(findCheckRun(entries, { run: 'npm test', tree: T })).toBeNull();
    const session = { at: '0', run: 'npm test', tree: T, exit: 1, env: 'session' };
    expect(findCheckRun([session, ...entries], { run: 'npm test', tree: T })).toBe(session);
  });

  it('skips a quick line, newer or not, and returns the full line under it', () => {
    const full = { at: '1', run: 'npm test', tree: T, exit: 1, env: 'session' };
    const quick = { at: '2', run: 'npm test', quick: true, cmd: 'npm test -- --changed', tree: T, exit: 0, env: 'session' };
    expect(findCheckRun([full, quick], { run: 'npm test', tree: T })).toBe(full);
    expect(findCheckRun([quick], { run: 'npm test', tree: T })).toBeNull();
    expect(findCheckRun([{ ...quick, quick: false }], { run: 'npm test', tree: T })).not.toBeNull();
  });

  it('exports the tree id pattern', () => {
    expect(TREE_ID.test('a'.repeat(40))).toBe(true);
    expect(TREE_ID.test('index')).toBe(false);
  });
});

describe('checkTotals', () => {
  const entries = [
    { at: '2026-10-14T10:00:00Z', story: 'S-1', run: 'npm test', full: true, exit: 0, ms: 600000 },
    { at: '2026-10-15T10:00:00Z', story: 'S-1', run: 'npm test', full: true, exit: 1, ms: 180000 },
    { at: '2026-10-15T11:00:00Z', story: 'S-1', run: 'npm test', full: true, exit: 0, ms: 300000 },
    { at: '2026-10-15T12:00:00Z', story: 'S-1', run: 'npm test', full: true, reused: true, from: 'x' },
    { at: '2026-10-15T12:00:00Z', story: 'S-1', run: 'npm run lint', full: false, exit: 0, ms: 900000 },
    { at: '2026-10-15T12:00:00Z', story: 'S-1', run: 'npm run lint', full: false, reused: true },
    { at: '2026-10-15T12:00:00Z', story: null, run: 'npm test', full: true, exit: 0, ms: 60000 },
    { at: '2026-10-15T12:00:00Z', run: 'npm test', full: true, exit: 0, ms: 60000 },
    { at: '2026-10-15T13:00:00Z', story: 'A-2', run: 'npm test', full: true, exit: 0, ms: 61000 },
  ];

  it('counts full real runs, minutes and reused per story, sorted by story', () => {
    expect(checkTotals(entries)).toEqual([
      { story: 'A-2', fullRuns: 1, minutes: 1, quickRuns: 0, quickMinutes: 0, reused: 0, waited: 0, denied: 0, rounds: null },
      { story: 'S-1', fullRuns: 3, minutes: 18, quickRuns: 0, quickMinutes: 0, reused: 1, waited: 0, denied: 0, rounds: null },
    ]);
  });

  it('starts from since, by UTC day', () => {
    expect(checkTotals(entries, { since: '2026-10-15' }).find((t) => t.story === 'S-1')).toEqual({ story: 'S-1', fullRuns: 2, minutes: 8, quickRuns: 0, quickMinutes: 0, reused: 1, waited: 0, denied: 0, rounds: null });
    expect(checkTotals(entries, { since: '2026-10-16' })).toEqual([]);
  });

  it('sums rounds from the run records of the story, from since on', () => {
    const state = join(dir, 's');
    writeRun(state, { story: 'S-1', slot: 'w1', result: 'failed', rounds: 1, startedAt: '2026-10-14T08:00:00Z', endedAt: '2026-10-14T09:00:00Z' });
    writeRun(state, { story: 'S-1', slot: 'w1', result: 'shipped', rounds: 2, startedAt: '2026-10-15T08:00:00Z', endedAt: '2026-10-15T09:00:00Z' });
    writeRun(state, { story: 'S-9', slot: 'w1', result: 'shipped', rounds: 5, startedAt: '2026-10-15T08:00:00Z', endedAt: '2026-10-15T09:00:00Z' });
    const runs = readRuns(state);
    expect(checkTotals(entries, { runs }).find((t) => t.story === 'S-1').rounds).toBe(3);
    expect(checkTotals(entries, { runs, since: '2026-10-15' }).find((t) => t.story === 'S-1').rounds).toBe(2);
    expect(checkTotals(entries, { runs }).find((t) => t.story === 'A-2').rounds).toBeNull();
  });

  it('counts denied hand runs per story, full or not, and nothing else for them', () => {
    const denied = [
      ...entries,
      { at: '2026-10-15T14:00:00Z', story: 'S-1', run: 'npm test', full: true, denied: true },
      { at: '2026-10-15T14:00:00Z', story: 'S-1', run: 'npm run lint', full: false, denied: true },
      { at: '2026-10-14T14:00:00Z', story: 'S-1', run: 'npm test', full: true, denied: true, exit: 0, ms: 600000, reused: true },
      { at: '2026-10-15T14:00:00Z', story: null, run: 'npm test', full: true, denied: true },
    ];
    expect(checkTotals(denied).find((t) => t.story === 'S-1')).toEqual({ story: 'S-1', fullRuns: 3, minutes: 18, quickRuns: 0, quickMinutes: 0, reused: 1, waited: 0, denied: 3, rounds: null });
    expect(checkTotals(denied, { since: '2026-10-15' }).find((t) => t.story === 'S-1')).toEqual({ story: 'S-1', fullRuns: 2, minutes: 8, quickRuns: 0, quickMinutes: 0, reused: 1, waited: 0, denied: 2, rounds: null });
    expect(Object.keys(checkTotals(denied)[0])).toEqual(['story', 'fullRuns', 'minutes', 'quickRuns', 'quickMinutes', 'reused', 'waited', 'denied', 'rounds']);
  });

  it('lists a story with only denied lines, with fullRuns 0', () => {
    const only = [{ at: '2026-10-15T14:00:00Z', story: 'S-7', run: 'pytest', full: false, denied: true }];
    expect(checkTotals(only)).toEqual([{ story: 'S-7', fullRuns: 0, minutes: 0, quickRuns: 0, quickMinutes: 0, reused: 0, waited: 0, denied: 1, rounds: null }]);
    expect(checkTotals(only, { since: '2026-10-16' })).toEqual([]);
  });

  it('counts a quick line apart from the full runs, the reuses and the waits', () => {
    const quick = [
      { at: '2026-10-15T10:00:00Z', story: 'S-1', run: 'npm test', full: true, exit: 0, ms: 120000, env: 'session' },
      { at: '2026-10-15T10:01:00Z', story: 'S-1', run: 'npm test', quick: true, cmd: 'npm test -- --changed', full: true, exit: 0, ms: 30000, env: 'session' },
      { at: '2026-10-15T10:02:00Z', story: 'S-1', run: 'npm test', quick: true, cmd: 'npm test -- --changed', full: true, exit: 1, ms: 30000, env: 'session' },
      { at: '2026-10-15T10:03:00Z', story: 'S-1', run: 'npm test', quick: true, cmd: 'npm test -- --changed', full: true, exit: 0, ms: 30000, env: 'session' },
      { at: '2026-10-15T10:04:00Z', story: 'S-1', run: 'npm test', quick: true, full: true, reused: true, waited: true },
    ];
    const [t] = checkTotals(quick);
    expect(t).toEqual({ story: 'S-1', fullRuns: 1, minutes: 2, quickRuns: 4, quickMinutes: 1.5, reused: 0, waited: 0, denied: 0, rounds: null });
    expect(Object.keys(t)).toEqual(['story', 'fullRuns', 'minutes', 'quickRuns', 'quickMinutes', 'reused', 'waited', 'denied', 'rounds']);
  });

  it('lists a story with only quick lines, with fullRuns 0, and starts them from since', () => {
    const only = [{ at: '2026-10-15T10:00:00Z', story: 'S-4', run: 'npm test', quick: true, full: true, exit: 0, ms: 60000 }];
    expect(checkTotals(only)).toEqual([{ story: 'S-4', fullRuns: 0, minutes: 0, quickRuns: 1, quickMinutes: 1, reused: 0, waited: 0, denied: 0, rounds: null }]);
    expect(checkTotals(only, { since: '2026-10-16' })).toEqual([]);
  });

  it('gives [] for no entries and skips lines that are not objects', () => {
    expect(checkTotals([])).toEqual([]);
    expect(checkTotals([null, 3, 'x'])).toEqual([]);
  });

  it('counts a reuse that waited on a run in progress apart from the other reuses', () => {
    const waited = [
      { at: '2026-10-15T10:00:00Z', story: 'S-1', run: 'npm test', full: true, exit: 0, ms: 60000, env: 'session' },
      { at: '2026-10-15T10:01:00Z', story: 'S-1', run: 'npm test', full: true, reused: true, waited: true, from: 'x' },
      { at: '2026-10-15T10:02:00Z', story: 'S-1', run: 'npm test', full: true, reused: true, waited: true, from: 'x' },
      { at: '2026-10-15T10:03:00Z', story: 'S-1', run: 'npm test', full: true, reused: true, from: 'x' },
      { at: '2026-10-15T10:03:00Z', story: 'S-1', run: 'npm test', full: true, reused: true, by: 'merge-main', from: 'x' },
      { at: '2026-10-15T10:03:00Z', story: 'S-1', run: 'npm test', full: true, reused: true, waited: 'yes', from: 'x' },
    ];
    expect(checkTotals(waited)).toEqual([{ story: 'S-1', fullRuns: 1, minutes: 1, quickRuns: 0, quickMinutes: 0, reused: 3, waited: 2, denied: 0, rounds: null }]);
  });
});
