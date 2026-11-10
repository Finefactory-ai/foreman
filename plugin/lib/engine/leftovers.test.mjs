import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { git, makeRepos, sh, writeFile } from '../../../test/state-repos.mjs';
import { freeStoryFolder, heldIds, isKeyFile, leftoverEvents, leftoverName, saveLeftovers, storyOfBranch } from './leftovers.mjs';

const NOW = new Date('2026-10-30T14:53:00Z');
const BRANCH = 'leftover/w1-acme-1-20261030';

describe('leftoverName', () => {
  it('names the slot, the story and the UTC date', () => {
    expect(leftoverName({ slot: 'w5', id: 'ACME-265', now: NOW })).toBe('leftover/w5-acme-265-20261030');
  });
  it('adds -2, then -3, while the name is taken', () => {
    const one = new Set(['leftover/w5-acme-265-20261030']);
    expect(leftoverName({ slot: 'w5', id: 'ACME-265', now: NOW, taken: (n) => one.has(n) })).toBe('leftover/w5-acme-265-20261030-2');
    const two = new Set([...one, 'leftover/w5-acme-265-20261030-2']);
    expect(leftoverName({ slot: 'w5', id: 'ACME-265', now: NOW, taken: (n) => two.has(n) })).toBe('leftover/w5-acme-265-20261030-3');
  });
});

describe('storyOfBranch', () => {
  const ids = ['ACME-1', 'ACME-265'];
  it("gives the story whose branch it is", () => {
    expect(storyOfBranch('story/acme-265', ids, 'story/')).toBe('ACME-265');
    expect(storyOfBranch('story/acme-1', ids, 'story/')).toBe('ACME-1');
  });
  it('gives null for a detached HEAD, main or a branch of no story', () => {
    for (const head of ['HEAD', 'main', 'story/acme-999', '', 'story/acme-2650']) expect(storyOfBranch(head, ids, 'story/')).toBeNull();
  });
  it('uses the prefix it is given', () => {
    expect(storyOfBranch('feature/acme-265', ids, 'feature/')).toBe('ACME-265');
    expect(storyOfBranch('story/acme-265', ids, 'feature/')).toBeNull();
  });
  it('finds an unlisted story from the pattern', () => {
    const P = '[A-Z]+-\\d+';
    expect(storyOfBranch('story/acme-999', ['ACME-1'], 'story/', P)).toBe('ACME-999');
    expect(storyOfBranch('story/acme-1', ['ACME-1'], 'story/', P)).toBe('ACME-1');
  });
  it('keeps the exact case of a listed id, even when the pattern would spell it otherwise', () => {
    expect(storyOfBranch('story/acme-1', ['Acme-1'], 'story/', '[A-Za-z]+-\\d+')).toBe('Acme-1');
    expect(storyOfBranch('story/acme-1', ['Acme-1'], 'story/')).toBe('Acme-1');
    // Control: an unlisted id comes from the pattern, in upper case.
    expect(storyOfBranch('story/acme-2', ['Acme-1'], 'story/', '[A-Za-z]+-\\d+')).toBe('ACME-2');
  });
  it('finds a story from a Jira pattern with an empty list', () => {
    expect(storyOfBranch('story/acme-328', [], 'story/', '[A-Z][A-Z0-9_]+-\\d+')).toBe('ACME-328');
  });
  it("gives null for branches that are not a story's, with the pattern", () => {
    const P = '[A-Z]+-\\d+';
    for (const head of ['HEAD', 'main', 'story/', 'story/not-an-id', 'story/ACME-9', 'leftover/w1-acme-1-20261030']) expect(storyOfBranch(head, [], 'story/', P), head).toBeNull();
    expect(storyOfBranch('feature/acme-9', [], 'story/', P)).toBeNull();
  });
  it('gives null for a bad pattern and does not throw', () => {
    expect(storyOfBranch('story/acme-9', [], 'story/', '(')).toBeNull();
  });
});

describe('heldIds', () => {
  it('collects the ids of claims, sessions, queued work and slots, and skips nulls', () => {
    const held = heldIds({
      claims: [{ id: 'ACME-1', pid: 7, by: 'factory' }, { id: 'ACME-2', pid: null, by: 'owner' }, { id: 'ACME-9', pid: 3, stale: true }],
      sessions: [{ id: 'ACME-3' }],
      work: [{ slot: 'w1', id: 'ACME-4', mode: '' }],
      slots: [{ state: 'building', story: { id: 'ACME-5' } }, { state: 'held', story: null, heldStory: 'ACME-6' }, { state: 'idle', story: null, heldStory: null }, {}],
    });
    expect([...held].sort()).toEqual(['ACME-1', 'ACME-2', 'ACME-3', 'ACME-4', 'ACME-5', 'ACME-6', 'ACME-9']);
  });
  it('is empty with nothing given', () => {
    expect(heldIds({}).size).toBe(0);
  });
});

describe('isKeyFile', () => {
  it('is true for env files, pem files, private ssh keys and the names it is given', () => {
    for (const f of ['.env', '.envrc', '.env.local', 'config/.env.production', 'certs/acme.pem', 'id_rsa', 'deploy/id_ed25519']) expect(isKeyFile(f), f).toBe(true);
    expect(isKeyFile('secrets/acme.keys', ['secrets/acme.keys'])).toBe(true);
    expect(isKeyFile('sub/acme.keys', ['acme.keys'])).toBe(true);
  });
  it('is false for env templates, public keys and look-alikes', () => {
    for (const f of ['.env.example', '.env.sample', '.env.template', '.env.dist', 'id_rsa.pub', 'src/id_utils.js', 'environment.js', 'README.md']) expect(isKeyFile(f), f).toBe(false);
    expect(isKeyFile('notes.txt', [undefined, null])).toBe(false);
  });
});

describe('leftoverEvents', () => {
  const at = { slot: 'w1', id: 'ACME-1', base: 'origin/main' };
  it('says the changes are on the branch and the folder is clean again', () => {
    expect(leftoverEvents({ ...at, result: { branch: BRANCH, clean: true, problem: null, dropped: [] } })).toEqual([
      `Slot w1: ACME-1 left changes in its folder; they are on the branch ${BRANCH}, and the folder is clean again.`,
    ]);
  });
  it('says the folder could not be put back at base', () => {
    expect(leftoverEvents({ ...at, result: { branch: BRANCH, clean: false, problem: null, dropped: [] } })).toEqual([
      `Slot w1: ACME-1 left changes in its folder; they are on the branch ${BRANCH}, but the folder could not be put back at origin/main.`,
    ]);
  });
  it('names the key files that were deleted', () => {
    expect(leftoverEvents({ ...at, result: { branch: null, clean: true, problem: null, dropped: ['certs/acme.pem', '.env.local'] } })).toEqual([
      'Slot w1: ACME-1 left key files in its folder (certs/acme.pem, .env.local); they are not on any branch and were deleted.',
    ]);
  });
  it('gives the problem', () => {
    expect(leftoverEvents({ ...at, result: { branch: null, clean: false, problem: 'could not commit them to x', dropped: [] } })).toEqual([
      'Slot w1: could not save the leftover changes of ACME-1 (could not commit them to x); the folder is left as it was.',
    ]);
  });
  it('gives nothing when there is nothing to say, and treats a missing dropped as empty', () => {
    expect(leftoverEvents({ ...at, result: { branch: null, clean: true, problem: null, dropped: [] } })).toEqual([]);
    expect(leftoverEvents({ ...at, result: { branch: null, clean: true, problem: null } })).toEqual([]);
  });
});

describe('saveLeftovers', () => {
  let repos;
  let wt;
  let baseSha;
  let storySha;

  afterEach(() => repos?.cleanup());

  // A clone whose main ignores node_modules, and a worktree on story/acme-1 with one commit.
  function setup() {
    repos = makeRepos({ version: 1, project: { name: 'Acme' } });
    const clone = repos.clone('acme');
    writeFileSync(join(clone, '.gitignore'), 'node_modules/\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-qm', 'Ignore node_modules');
    git(clone, 'push', '-q', 'origin', 'main');
    wt = join(repos.base, 'wt');
    git(clone, 'worktree', 'add', '-q', '-b', 'story/acme-1', wt, 'origin/main');
    writeFile(join(wt, 'work.txt'), 'the story so far\n');
    git(wt, 'add', 'work.txt');
    git(wt, 'commit', '-qm', 'ACME-1 work');
    baseSha = git(wt, 'rev-parse', 'origin/main');
    storySha = git(wt, 'rev-parse', 'story/acme-1');
  }

  // A staged new file, an unstaged edit and an untracked file, plus an ignored one.
  function leaveChanges() {
    writeFile(join(wt, 'src', 'staged.txt'), 'staged\n');
    git(wt, 'add', 'src/staged.txt');
    writeFileSync(join(wt, 'README.md'), 'a project, edited\n');
    writeFileSync(join(wt, 'notes.txt'), 'notes\n');
    writeFile(join(wt, 'node_modules', 'x'), 'installed\n');
  }

  const status = () => sh('git', ['status', '--porcelain'], { cwd: wt }).stdout;
  const leftoverRefs = () => git(wt, 'for-each-ref', '--format=%(refname)', 'refs/heads/leftover');
  const detachedAtBase = () => {
    expect(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(baseSha);
  };

  it('commits staged, unstaged and untracked changes to a leftover branch and leaves the folder clean at base', () => {
    setup();
    leaveChanges();
    const r = saveLeftovers({ path: wt, slot: 'w1', id: 'ACME-1', base: 'origin/main', now: NOW, sh });
    expect(r).toEqual({ branch: BRANCH, clean: true, problem: null, dropped: [] });
    expect(status()).toBe('');
    detachedAtBase();
    const shown = git(wt, 'show', '--name-status', '--format=%s', BRANCH);
    expect(shown).toContain('ACME-1 leftovers from slot w1');
    expect(shown).toMatch(/^A\tsrc\/staged\.txt$/m);
    expect(shown).toMatch(/^M\tREADME\.md$/m);
    expect(shown).toMatch(/^A\tnotes\.txt$/m);
    expect(shown).not.toContain('node_modules');
    expect(git(wt, 'rev-parse', `${BRANCH}^`)).toBe(storySha);
    expect(git(wt, 'rev-parse', 'story/acme-1')).toBe(storySha);
    expect(existsSync(join(wt, 'node_modules', 'x'))).toBe(true);
  });

  it('picks the next free name when the day already has one for the story', () => {
    setup();
    git(wt, 'branch', BRANCH, 'origin/main');
    leaveChanges();
    const r = saveLeftovers({ path: wt, slot: 'w1', id: 'ACME-1', base: 'origin/main', now: NOW, sh });
    expect(r.branch).toBe(`${BRANCH}-2`);
    expect(git(wt, 'rev-parse', BRANCH)).toBe(baseSha);
  });

  it('makes no branch for a folder with no changes, and still detaches it at base', () => {
    setup();
    const r = saveLeftovers({ path: wt, slot: 'w1', id: 'ACME-1', base: 'origin/main', now: NOW, sh });
    expect(r).toEqual({ branch: null, clean: true, problem: null, dropped: [] });
    detachedAtBase();
    expect(leftoverRefs()).toBe('');
  });

  it('drops changes that are only under the generated paths, with no branch', () => {
    setup();
    writeFile(join(wt, 'dist', 'out.js'), 'built\n');
    const r = saveLeftovers({ path: wt, slot: 'w1', id: 'ACME-1', base: 'origin/main', generated: [{ path: 'dist/**', regenerate: 'x' }], now: NOW, sh });
    expect(r).toEqual({ branch: null, clean: true, problem: null, dropped: [] });
    expect(status()).toBe('');
    expect(existsSync(join(wt, 'dist', 'out.js'))).toBe(false);
    expect(leftoverRefs()).toBe('');
    detachedAtBase();
  });

  it("saves past a failing pre-commit hook, with no git identity set up", () => {
    setup();
    const hooks = join(resolve(wt, git(wt, 'rev-parse', '--git-common-dir')), 'hooks');
    writeFile(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(hooks, 'pre-commit'), 0o755);
    leaveChanges();
    const r = saveLeftovers({ path: wt, slot: 'w1', id: 'ACME-1', base: 'origin/main', now: NOW, sh });
    expect(r).toEqual({ branch: BRANCH, clean: true, problem: null, dropped: [] });
    expect(git(wt, 'log', '-1', '--format=%an <%ae>', BRANCH)).toBe('Foreman <foreman@localhost>');
  });

  it('says the folder is not clean when it cannot be detached at base', () => {
    setup();
    leaveChanges();
    const r = saveLeftovers({ path: wt, slot: 'w1', id: 'ACME-1', base: 'nope/main', now: NOW, sh });
    expect(r).toEqual({ branch: BRANCH, clean: false, problem: null, dropped: [] });
    expect(git(wt, 'show', '--name-only', '--format=%s', BRANCH)).toContain('notes.txt');
  });

  it('says the folder is not clean when it has no changes and cannot be detached at base', () => {
    setup();
    const r = saveLeftovers({ path: wt, slot: 'w1', id: 'ACME-1', base: 'nope/main', now: NOW, sh });
    expect(r).toEqual({ branch: null, clean: false, problem: null, dropped: [] });
  });

  it('never puts a new key file on the leftover branch, and deletes it', () => {
    setup();
    leaveChanges();
    writeFileSync(join(wt, '.env.local'), 'KEY=1\n');
    writeFile(join(wt, 'certs', 'acme.pem'), 'pem\n');
    git(wt, 'add', 'certs/acme.pem');
    writeFileSync(join(wt, 'id_ed25519'), 'key\n');
    const r = saveLeftovers({ path: wt, slot: 'w1', id: 'ACME-1', base: 'origin/main', now: NOW, sh });
    expect(r).toEqual({ branch: BRANCH, clean: true, problem: null, dropped: ['.env.local', 'certs/acme.pem', 'id_ed25519'] });
    const shown = git(wt, 'show', '--name-status', '--format=%s', BRANCH);
    expect(shown).toMatch(/^A\tsrc\/staged\.txt$/m);
    expect(shown).toMatch(/^M\tREADME\.md$/m);
    expect(shown).toMatch(/^A\tnotes\.txt$/m);
    for (const f of ['.env.local', 'acme.pem', 'id_ed25519']) expect(shown).not.toContain(f);
    for (const f of ['.env.local', 'certs/acme.pem', 'id_ed25519']) expect(existsSync(join(wt, f))).toBe(false);
    expect(status()).toBe('');
    detachedAtBase();
  });

  it('makes no branch when the only change is a new key file, and deletes it', () => {
    setup();
    writeFileSync(join(wt, '.env.local'), 'KEY=1\n');
    const r = saveLeftovers({ path: wt, slot: 'w1', id: 'ACME-1', base: 'origin/main', now: NOW, sh });
    expect(r).toEqual({ branch: null, clean: true, problem: null, dropped: ['.env.local'] });
    expect(leftoverRefs()).toBe('');
    expect(existsSync(join(wt, '.env.local'))).toBe(false);
    expect(status()).toBe('');
    detachedAtBase();
  });

  it('leaves out the key file names it is given', () => {
    setup();
    writeFileSync(join(wt, 'acme.secrets'), 'KEY=1\n');
    writeFileSync(join(wt, 'notes.txt'), 'notes\n');
    const r = saveLeftovers({ path: wt, slot: 'w1', id: 'ACME-1', base: 'origin/main', keyFiles: ['acme.secrets', undefined], now: NOW, sh });
    expect(r.dropped).toEqual(['acme.secrets']);
    const shown = git(wt, 'show', '--name-only', '--format=%s', BRANCH);
    expect(shown).toContain('notes.txt');
    expect(shown).not.toContain('acme.secrets');
  });

  it('still saves an edit to a key file that git already tracks', () => {
    setup();
    writeFileSync(join(wt, '.env'), 'A=1\n');
    git(wt, 'add', '-f', '.env');
    git(wt, 'commit', '-qm', 'ACME-1 env');
    writeFileSync(join(wt, '.env'), 'A=2\n');
    const r = saveLeftovers({ path: wt, slot: 'w1', id: 'ACME-1', base: 'origin/main', now: NOW, sh });
    expect(r).toEqual({ branch: BRANCH, clean: true, problem: null, dropped: [] });
    expect(git(wt, 'show', '--name-status', '--format=%s', BRANCH)).toMatch(/^M\t\.env$/m);
  });

  it('leaves the folder as it was when the key files cannot be dropped from the index', () => {
    setup();
    leaveChanges();
    writeFileSync(join(wt, '.env.local'), 'KEY=1\n');
    const before = status();
    const failRm = (cmd, args, opts) => (args[0] === 'rm' ? { status: 1, stdout: '' } : sh(cmd, args, opts));
    const r = saveLeftovers({ path: wt, slot: 'w1', id: 'ACME-1', base: 'origin/main', now: NOW, sh: failRm });
    expect(r).toEqual({ branch: null, clean: false, problem: `could not commit them to ${BRANCH}`, dropped: [] });
    expect(leftoverRefs()).toBe('');
    expect(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('story/acme-1');
    expect(status()).toBe(before);
  });

  it('leaves the folder exactly as it was when the commit fails, with no branch left behind', () => {
    setup();
    leaveChanges();
    const before = status();
    const failCommit = (cmd, args, opts) => (args.includes('commit') ? { status: 1, stdout: '' } : sh(cmd, args, opts));
    const r = saveLeftovers({ path: wt, slot: 'w1', id: 'ACME-1', base: 'origin/main', now: NOW, sh: failCommit });
    expect(r.branch).toBeNull();
    expect(r.clean).toBe(false);
    expect(r.problem).toBe(`could not commit them to ${BRANCH}`);
    expect(leftoverRefs()).toBe('');
    expect(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('story/acme-1');
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(storySha);
    expect(status()).toBe(before);
    expect(before).toContain('A  src/staged.txt');
    expect(before).toContain(' M README.md');
    expect(before).toContain('?? notes.txt');
  });

  it('leaves the folder as it was when the branch cannot be made', () => {
    setup();
    leaveChanges();
    const before = status();
    const failBranch = (cmd, args, opts) => (args[0] === 'checkout' && args.includes('-b') ? { status: 1, stdout: '' } : sh(cmd, args, opts));
    const r = saveLeftovers({ path: wt, slot: 'w1', id: 'ACME-1', base: 'origin/main', now: NOW, sh: failBranch });
    expect(r).toEqual({ branch: null, clean: false, problem: `could not make the branch ${BRANCH}`, dropped: [] });
    expect(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('story/acme-1');
    expect(status()).toBe(before);
  });

  it('never throws, even when its shell does', () => {
    const r = saveLeftovers({ path: '/nowhere', slot: 'w1', id: 'ACME-1', base: 'origin/main', now: NOW, sh: () => {
      throw new Error('boom');
    } });
    expect(r.branch).toBeNull();
    expect(r.clean).toBe(false);
    expect(r.problem).toMatch(/boom/);
    expect(r.dropped).toEqual([]);
  });
});

describe('freeStoryFolder', () => {
  let repos;
  let wt;
  let baseSha;
  let storySha;

  afterEach(() => repos?.cleanup());

  function setup() {
    repos = makeRepos({ version: 1, project: { name: 'Acme' } });
    const clone = repos.clone('acme');
    writeFileSync(join(clone, '.gitignore'), 'node_modules/\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-qm', 'Ignore node_modules');
    git(clone, 'push', '-q', 'origin', 'main');
    wt = join(repos.base, 'wt');
    git(clone, 'worktree', 'add', '-q', '-b', 'story/acme-1', wt, 'origin/main');
    writeFile(join(wt, 'work.txt'), 'the story so far\n');
    git(wt, 'add', 'work.txt');
    git(wt, 'commit', '-qm', 'ACME-1 work');
    baseSha = git(wt, 'rev-parse', 'origin/main');
    storySha = git(wt, 'rev-parse', 'story/acme-1');
  }

  function leaveChanges() {
    writeFile(join(wt, 'src', 'staged.txt'), 'staged\n');
    git(wt, 'add', 'src/staged.txt');
    writeFileSync(join(wt, 'README.md'), 'a project, edited\n');
    writeFileSync(join(wt, 'notes.txt'), 'notes\n');
    writeFile(join(wt, 'node_modules', 'x'), 'installed\n');
  }

  const status = () => sh('git', ['status', '--porcelain'], { cwd: wt }).stdout;
  const free = (extra = {}) => freeStoryFolder({ path: wt, id: 'ACME-1', branch: 'story/acme-1', from: 'w4', to: 'w1', base: 'origin/main', sh, ...extra });

  it('commits every change to the story branch and leaves the folder detached at base, clean', () => {
    setup();
    leaveChanges();
    expect(free()).toEqual({ freed: true, committed: true, problem: null });
    expect(git(wt, 'log', '-1', '--format=%s', 'story/acme-1')).toBe('ACME-1 WIP: moved from slot w4 to w1');
    expect(git(wt, 'rev-parse', 'story/acme-1^')).toBe(storySha);
    const shown = git(wt, 'show', '--name-status', '--format=%s', 'story/acme-1');
    expect(shown).toMatch(/^A\tsrc\/staged\.txt$/m);
    expect(shown).toMatch(/^M\tREADME\.md$/m);
    expect(shown).toMatch(/^A\tnotes\.txt$/m);
    expect(shown).not.toContain('node_modules');
    expect(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(baseSha);
    expect(status()).toBe('');
  });

  it('commits under the given message, and under the moved-from subject without one', () => {
    setup();
    leaveChanges();
    expect(free({ from: 'w4', to: null, message: 'ACME-1 WIP: kept at start-up from slot w4' }).committed).toBe(true);
    expect(git(wt, 'log', '-1', '--format=%s', 'story/acme-1')).toBe('ACME-1 WIP: kept at start-up from slot w4');
  });

  it('makes no commit for a clean folder on the branch, and detaches it', () => {
    setup();
    expect(free()).toEqual({ freed: true, committed: false, problem: null });
    expect(git(wt, 'rev-parse', 'story/acme-1')).toBe(storySha);
    expect(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(baseSha);
  });

  it('drops changes that are only under the generated paths, with no commit', () => {
    setup();
    writeFile(join(wt, 'dist', 'out.js'), 'built\n');
    expect(free({ generated: [{ path: 'dist/**', regenerate: 'x' }] })).toEqual({ freed: true, committed: false, problem: null });
    expect(git(wt, 'rev-parse', 'story/acme-1')).toBe(storySha);
    expect(existsSync(join(wt, 'dist', 'out.js'))).toBe(false);
    expect(status()).toBe('');
  });

  it('leaves out the generated paths when it commits the rest', () => {
    setup();
    writeFile(join(wt, 'dist', 'out.js'), 'built\n');
    writeFileSync(join(wt, 'notes.txt'), 'notes\n');
    expect(free({ generated: [{ path: 'dist/**', regenerate: 'x' }] }).committed).toBe(true);
    const shown = git(wt, 'show', '--name-only', '--format=%s', 'story/acme-1');
    expect(shown).toContain('notes.txt');
    expect(shown).not.toContain('dist');
  });

  it('leaves a folder on another branch alone', () => {
    setup();
    git(wt, 'checkout', '-q', '-b', 'story/acme-2');
    writeFileSync(join(wt, 'notes.txt'), 'notes\n');
    expect(free()).toEqual({ freed: true, committed: false, problem: null });
    expect(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('story/acme-2');
    expect(status()).toBe('?? notes.txt\n');
  });

  it('leaves a detached folder alone', () => {
    setup();
    git(wt, 'checkout', '-q', '--detach', 'story/acme-1');
    writeFileSync(join(wt, 'notes.txt'), 'notes\n');
    expect(free()).toEqual({ freed: true, committed: false, problem: null });
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(storySha);
    expect(status()).toBe('?? notes.txt\n');
  });

  it('is freed when there is no worktree at the path', () => {
    expect(freeStoryFolder({ path: '/nowhere/at/all', id: 'ACME-1', branch: 'story/acme-1', from: 'w4', to: 'w1', base: 'origin/main' })).toEqual({ freed: true, committed: false, problem: null });
  });

  it('leaves the folder as it was when the commit fails', () => {
    setup();
    leaveChanges();
    const before = status();
    const failCommit = (cmd, args, opts) => (args.includes('commit') ? { status: 1, stdout: '' } : sh(cmd, args, opts));
    const r = free({ sh: failCommit });
    expect(r).toEqual({ freed: false, committed: false, problem: 'could not commit its changes to story/acme-1' });
    expect(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('story/acme-1');
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(storySha);
    expect(existsSync(join(wt, 'notes.txt'))).toBe(true);
    expect(status()).toContain('?? notes.txt');
    expect(status()).toContain(' M README.md');
    expect(before).toContain('A  src/staged.txt');
  });

  it('says so when it cannot detach the folder', () => {
    setup();
    const r = free({ base: 'origin/no-such-branch' });
    expect(r).toEqual({ freed: false, committed: false, problem: 'could not detach it at origin/no-such-branch' });
  });

  it('never throws, even when its shell does', () => {
    setup();
    writeFileSync(join(repos.base, '.git'), 'gitdir: nowhere\n');
    const r = freeStoryFolder({ path: repos.base, id: 'ACME-1', branch: 'story/acme-1', from: 'w4', to: 'w1', base: 'origin/main', sh: () => {
      throw new Error('boom');
    } });
    expect(r.freed).toBe(false);
    expect(r.problem).toMatch(/boom/);
  });
});
