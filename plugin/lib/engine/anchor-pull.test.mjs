// The supervisor's fast-forward of the checkout it runs from (anchor-pull.mjs), over real temp
// repos: a clone, a second clone that pushes, and a fetch that moves the tracking ref without
// moving HEAD, as the merge step's fetch does.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, makeRepos, sh, writeFile } from '../../../test/state-repos.mjs';
import { anchorEvent, anchorStep, anchorText, anchorWaitOf, anchorWaitWhy, ownCheckout } from './anchor-pull.mjs';

let repos;
let clone;
const opts = () => ({ root: clone, remote: 'origin', baseBranch: 'main', sh });

beforeEach(() => {
  repos = makeRepos({ version: 1, project: { name: 'Acme' } });
  clone = repos.clone('acme');
  writeFile(join(clone, 'plugin', 'lib', 'a.txt'), 'one\n');
  git(clone, 'add', '-A');
  git(clone, 'commit', '-qm', 'Add the plugin');
  git(clone, 'push', '-q', 'origin', 'main');
});
afterEach(() => repos.cleanup());

// A second clone pushes a commit; the first only fetches, so its HEAD stays behind.
function pushFromOther(file = 'plugin/lib/b.txt') {
  const other = repos.clone('other');
  writeFile(join(other, file), 'two\n');
  git(other, 'add', '-A');
  git(other, 'commit', '-qm', 'Change the plugin');
  git(other, 'push', '-q', 'origin', 'main');
  git(clone, 'fetch', '-q', 'origin', 'main');
  return git(other, 'rev-parse', 'HEAD');
}

describe('ownCheckout', () => {
  it('is true for a folder committed in the root checkout', () => {
    expect(ownCheckout({ pluginDir: join(clone, 'plugin'), root: clone, sh })).toBe(true);
  });

  it('is false for a folder that is its own repo', () => {
    const plug = join(repos.base, 'plug');
    mkdirSync(plug);
    git(plug, 'init', '-q', '-b', 'main');
    expect(ownCheckout({ pluginDir: plug, root: clone, sh })).toBe(false);
  });

  it('is false for a folder outside git', () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreman-anchor-'));
    expect(ownCheckout({ pluginDir: dir, root: clone, sh })).toBe(false);
  });

  it('is false for a folder in another worktree of the root', () => {
    const tree = join(repos.base, 'tree');
    git(clone, 'worktree', 'add', '-q', '-b', 'other-branch', tree);
    expect(ownCheckout({ pluginDir: join(tree, 'plugin'), root: clone, sh })).toBe(false);
  });
});

describe('anchorStep', () => {
  it('does nothing when the checkout is up to date', () => {
    const head = git(clone, 'rev-parse', 'HEAD');
    expect(anchorStep(opts())).toEqual({ action: 'none' });
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('fast-forwards a clean checkout on the base branch', () => {
    const from = git(clone, 'rev-parse', 'HEAD');
    const to = pushFromOther();
    expect(anchorStep(opts())).toEqual({ action: 'moved', from, to });
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(to);
    expect(existsSync(join(clone, 'plugin', 'lib', 'b.txt'))).toBe(true);
  });

  it('keeps an untracked file and still moves', () => {
    pushFromOther();
    writeFileSync(join(clone, 'notes.txt'), 'mine\n');
    expect(anchorStep(opts()).action).toBe('moved');
    expect(readFileSync(join(clone, 'notes.txt'), 'utf8')).toBe('mine\n');
  });

  it('does nothing when the checkout is ahead', () => {
    writeFile(join(clone, 'local.txt'), 'x\n');
    git(clone, 'add', '-A');
    git(clone, 'commit', '-qm', 'Local');
    const head = git(clone, 'rev-parse', 'HEAD');
    expect(anchorStep(opts())).toEqual({ action: 'none' });
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('leaves a checkout with a tracked change the new code also changes alone, naming only that file', () => {
    const from = git(clone, 'rev-parse', 'HEAD');
    const to = pushFromOther('README.md');
    writeFileSync(join(clone, 'README.md'), 'dirty\n');
    writeFileSync(join(clone, 'plugin', 'lib', 'a.txt'), 'mine\n');
    expect(anchorStep(opts())).toEqual({ action: 'wait', why: 'dirty', files: ['README.md'], from, to });
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(from);
    expect(readFileSync(join(clone, 'README.md'), 'utf8')).toBe('dirty\n');
    expect(readFileSync(join(clone, 'plugin', 'lib', 'a.txt'), 'utf8')).toBe('mine\n');
  });

  it('fast-forwards past a tracked change the new code does not touch, and keeps it', () => {
    const from = git(clone, 'rev-parse', 'HEAD');
    const to = pushFromOther();
    writeFileSync(join(clone, 'README.md'), 'dirty\n');
    expect(anchorStep(opts())).toEqual({ action: 'moved', from, to });
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(to);
    expect(existsSync(join(clone, 'plugin', 'lib', 'b.txt'))).toBe(true);
    expect(readFileSync(join(clone, 'README.md'), 'utf8')).toBe('dirty\n');
  });

  it('keeps a staged unrelated change across the move', () => {
    pushFromOther();
    writeFileSync(join(clone, 'README.md'), 'dirty\n');
    git(clone, 'add', 'README.md');
    expect(anchorStep(opts()).action).toBe('moved');
    expect(git(clone, 'diff', '--cached', '--name-only')).toBe('README.md');
    expect(readFileSync(join(clone, 'README.md'), 'utf8')).toBe('dirty\n');
  });

  it('waits as dirty when a locally deleted file is changed upstream', () => {
    const from = git(clone, 'rev-parse', 'HEAD');
    pushFromOther('README.md');
    rmSync(join(clone, 'README.md'));
    expect(anchorStep(opts())).toMatchObject({ action: 'wait', why: 'dirty', files: ['README.md'] });
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(from);
  });

  // Commits `file` in the clone and pushes it, so a later push from the other clone changes it.
  const commitHere = (file) => {
    writeFile(join(clone, file), 'one\n');
    git(clone, 'add', '-A');
    git(clone, 'commit', '-qm', `Add ${file}`);
    git(clone, 'push', '-q', 'origin', 'main');
  };

  it('names a non-ASCII file the new code also changes by its real name', () => {
    commitHere('é.txt');
    pushFromOther('é.txt');
    writeFileSync(join(clone, 'é.txt'), 'dirty\n');
    const step = anchorStep(opts());
    expect(step).toMatchObject({ action: 'wait', why: 'dirty' });
    expect(step.files.map((f) => f.normalize('NFC'))).toEqual(['é.txt']);
    expect(step.files.join('')).not.toMatch(/["\\]/);
    const why = anchorWaitWhy(anchorWaitOf(step, null, { remote: 'origin', baseBranch: 'main', at: '2026-11-09T00:00:00.000Z' }).wait).normalize('NFC');
    expect(why).toContain('é.txt');
    expect(why).not.toContain('\\303');
  });

  it('names a file with a space in it exactly', () => {
    commitHere('with space.txt');
    pushFromOther('with space.txt');
    writeFileSync(join(clone, 'with space.txt'), 'dirty\n');
    expect(anchorStep(opts())).toMatchObject({ action: 'wait', why: 'dirty', files: ['with space.txt'] });
  });

  it('names a file with a quote in it exactly', () => {
    commitHere('say "hi".txt');
    pushFromOther('say "hi".txt');
    writeFileSync(join(clone, 'say "hi".txt'), 'dirty\n');
    expect(anchorStep(opts())).toMatchObject({ action: 'wait', why: 'dirty', files: ['say "hi".txt'] });
  });

  it('waits as failed when a diff fails, and does not merge', () => {
    const to = pushFromOther();
    const from = git(clone, 'rev-parse', 'HEAD');
    writeFileSync(join(clone, 'README.md'), 'dirty\n');
    const calls = [];
    const fake = (cmd, args, o) => {
      calls.push(args[0]);
      return args[0] === 'diff' ? { status: 1, stdout: '' } : sh(cmd, args, o);
    };
    expect(anchorStep({ ...opts(), sh: fake })).toEqual({ action: 'wait', why: 'failed', from, to });
    expect(calls).not.toContain('merge');
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(from);
  });

  it('waits as failed when only the incoming diff fails', () => {
    pushFromOther();
    writeFileSync(join(clone, 'README.md'), 'dirty\n');
    const calls = [];
    const fake = (cmd, args, o) => {
      calls.push(args[0]);
      return args[0] === 'diff' && args[args.length - 1] !== 'HEAD' ? { status: 1, stdout: '' } : sh(cmd, args, o);
    };
    expect(anchorStep({ ...opts(), sh: fake })).toMatchObject({ action: 'wait', why: 'failed' });
    expect(calls).not.toContain('merge');
  });

  it('an unrelated dirty file on a diverged checkout waits as diverged', () => {
    pushFromOther();
    writeFile(join(clone, 'local.txt'), 'x\n');
    git(clone, 'add', '-A');
    git(clone, 'commit', '-qm', 'Local');
    writeFileSync(join(clone, 'README.md'), 'dirty\n');
    expect(anchorStep(opts())).toMatchObject({ action: 'wait', why: 'diverged' });
    expect(existsSync(join(clone, 'plugin', 'lib', 'b.txt'))).toBe(false);
  });

  it('leaves a checkout on another branch alone', () => {
    const from = git(clone, 'rev-parse', 'HEAD');
    const to = pushFromOther();
    git(clone, 'checkout', '-q', '-b', 'feature');
    expect(anchorStep(opts())).toEqual({ action: 'wait', why: 'branch', branch: 'feature', from, to });
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(from);
  });

  it('leaves a detached HEAD alone', () => {
    const from = git(clone, 'rev-parse', 'HEAD');
    const to = pushFromOther();
    git(clone, 'checkout', '-q', '--detach');
    expect(anchorStep(opts())).toEqual({ action: 'wait', why: 'branch', branch: '', from, to });
  });

  it('does not fast-forward a diverged checkout', () => {
    pushFromOther();
    writeFile(join(clone, 'local.txt'), 'x\n');
    git(clone, 'add', '-A');
    git(clone, 'commit', '-qm', 'Local');
    const step = anchorStep(opts());
    expect(step).toMatchObject({ action: 'wait', why: 'diverged' });
    expect(existsSync(join(clone, 'plugin', 'lib', 'b.txt'))).toBe(false);
  });

  it('does nothing when the tracking ref is missing', () => {
    expect(anchorStep({ ...opts(), baseBranch: 'nope' })).toEqual({ action: 'none' });
  });

  it('reports a merge that fails', () => {
    const to = pushFromOther();
    const from = git(clone, 'rev-parse', 'HEAD');
    const fake = (cmd, args, o) => (args[0] === 'merge' ? { status: 1, stdout: '' } : sh(cmd, args, o));
    expect(anchorStep({ ...opts(), sh: fake })).toEqual({ action: 'wait', why: 'failed', from, to });
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(from);
  });

  it('waits as failed when git status itself fails, and does not merge', () => {
    const to = pushFromOther();
    const from = git(clone, 'rev-parse', 'HEAD');
    const calls = [];
    const fake = (cmd, args, o) => {
      calls.push(args[0]);
      return args[0] === 'status' ? { status: 1, stdout: '' } : sh(cmd, args, o);
    };
    expect(anchorStep({ ...opts(), sh: fake })).toEqual({ action: 'wait', why: 'failed', from, to });
    expect(calls).not.toContain('merge');
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(from);
  });

  it('reports a merge a loose untracked file blocks, leaving the file', () => {
    pushFromOther();
    const from = git(clone, 'rev-parse', 'HEAD');
    writeFileSync(join(clone, 'plugin', 'lib', 'b.txt'), 'mine\n');
    expect(anchorStep(opts())).toMatchObject({ action: 'wait', why: 'failed' });
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(from);
    expect(readFileSync(join(clone, 'plugin', 'lib', 'b.txt'), 'utf8')).toBe('mine\n');
  });
});

describe('anchorText', () => {
  const o = { remote: 'origin', baseBranch: 'main' };
  const from = '1111111aaaaaaaaaaaaa';
  const to = '2222222bbbbbbbbbbbbb';
  const head = 'New code is on origin/main (2222222), but ';

  it('says each outcome in one sentence', () => {
    expect(anchorText({ action: 'moved', from, to }, o)).toBe("Fast-forwarded the main checkout's main to origin/main (1111111 -> 2222222).");
    expect(anchorText({ action: 'wait', why: 'dirty', from, to }, o)).toBe(`${head}the main checkout has uncommitted changes, so Foreman left it alone: the run keeps the code it has until you commit or stash them and pull.`);
    expect(anchorText({ action: 'wait', why: 'branch', branch: 'feature', from, to }, o)).toBe(`${head}the main checkout is on feature, not main, so Foreman left it alone: the run keeps the code it has until you switch back and pull.`);
    expect(anchorText({ action: 'wait', why: 'branch', branch: '', from, to }, o)).toBe(`${head}the main checkout is on a detached HEAD, not main, so Foreman left it alone: the run keeps the code it has until you switch back and pull.`);
    expect(anchorText({ action: 'wait', why: 'diverged', from, to }, o)).toBe(`${head}the main checkout's main has commits that origin/main does not, so it cannot be fast-forwarded: the run keeps the code it has until you pull.`);
    expect(anchorText({ action: 'wait', why: 'failed', from, to }, o)).toBe(`${head}fast-forwarding the main checkout failed: the run keeps the code it has until you pull.`);
  });

  it('says nothing for none', () => {
    expect(anchorText({ action: 'none' }, o)).toBeNull();
  });

  it('names no path', () => {
    for (const why of ['dirty', 'branch', 'diverged', 'failed']) {
      const text = anchorText({ action: 'wait', why, branch: 'feature', from, to }, o);
      expect(text.replaceAll('origin/main', '')).not.toContain('/');
    }
  });
});

describe('anchorEvent', () => {
  const o = { remote: 'origin', baseBranch: 'main' };
  const wait = (to) => ({ action: 'wait', why: 'dirty', from: 'aaaaaaa', to });

  it('gives an info event for a move and resets what was warned', () => {
    const r = anchorEvent({ action: 'moved', from: 'aaaaaaa', to: 'bbbbbbb' }, 'bbbbbbb', o);
    expect(r.event.kind).toBe('info');
    expect(r.event.text).toContain('Fast-forwarded');
    expect(r.warnedTo).toBeNull();
  });

  it('warns once per new base sha', () => {
    const first = anchorEvent(wait('xxxxxxx'), null, o);
    expect(first.event.kind).toBe('warn');
    expect(first.warnedTo).toBe('xxxxxxx');
    expect(anchorEvent(wait('xxxxxxx'), first.warnedTo, o).event).toBeNull();
    const again = anchorEvent(wait('yyyyyyy'), first.warnedTo, o);
    expect(again.event.kind).toBe('warn');
    expect(again.warnedTo).toBe('yyyyyyy');
  });

  it('gives no event for none and keeps what was warned', () => {
    expect(anchorEvent({ action: 'none' }, 'xxxxxxx', o)).toEqual({ event: null, warnedTo: 'xxxxxxx' });
  });
});

describe('anchorWaitOf', () => {
  const o = { remote: 'origin', baseBranch: 'main', at: '2026-11-09T10:00:00.000Z' };
  const dirty = { action: 'wait', why: 'dirty', files: ['a', 'b'], from: 'aaaaaaa', to: 'bbbbbbb' };

  it('records a new wait in full, with since = at', () => {
    expect(anchorWaitOf(dirty, null, o)).toEqual({
      wait: { why: 'dirty', files: ['a', 'b'], from: 'aaaaaaa', to: 'bbbbbbb', remote: 'origin', baseBranch: 'main', since: o.at },
      changed: true,
    });
  });

  it('is unchanged for the same step, keeping since', () => {
    const first = anchorWaitOf(dirty, null, o).wait;
    const again = anchorWaitOf(dirty, first, { ...o, at: '2026-11-09T11:00:00.000Z' });
    expect(again).toEqual({ wait: first, changed: false });
  });

  it('is changed for a new base sha or other files, keeping since', () => {
    const first = anchorWaitOf(dirty, null, o).wait;
    const later = { ...o, at: '2026-11-09T11:00:00.000Z' };
    const moved = anchorWaitOf({ ...dirty, to: 'ccccccc' }, first, later);
    expect(moved.changed).toBe(true);
    expect(moved.wait.since).toBe(o.at);
    expect(moved.wait.to).toBe('ccccccc');
    const files = anchorWaitOf({ ...dirty, files: ['a'] }, first, later);
    expect(files.changed).toBe(true);
    expect(files.wait.since).toBe(o.at);
    const why = anchorWaitOf({ action: 'wait', why: 'diverged', from: 'aaaaaaa', to: 'bbbbbbb' }, first, later);
    expect(why.changed).toBe(true);
    expect(why.wait.since).toBe(o.at);
  });

  it('carries branch only for a branch wait and files only for a dirty one', () => {
    const branch = anchorWaitOf({ action: 'wait', why: 'branch', branch: 'feature', from: 'a', to: 'b' }, null, o).wait;
    expect(branch.branch).toBe('feature');
    expect(branch).not.toHaveProperty('files');
    for (const why of ['diverged', 'failed']) {
      const w = anchorWaitOf({ action: 'wait', why, branch: 'x', files: ['y'], from: 'a', to: 'b' }, null, o).wait;
      expect(w).not.toHaveProperty('branch');
      expect(w).not.toHaveProperty('files');
    }
    expect(anchorWaitOf({ action: 'wait', why: 'dirty', branch: 'x', files: ['y'], from: 'a', to: 'b' }, null, o).wait).not.toHaveProperty('branch');
  });

  it('clears a wait when the checkout moved or caught up', () => {
    const first = anchorWaitOf(dirty, null, o).wait;
    expect(anchorWaitOf({ action: 'moved', from: 'a', to: 'b' }, first, o)).toEqual({ wait: null, changed: true });
    expect(anchorWaitOf({ action: 'none' }, first, o)).toEqual({ wait: null, changed: true });
    expect(anchorWaitOf({ action: 'none' }, null, o)).toEqual({ wait: null, changed: false });
    expect(anchorWaitOf({ action: 'moved', from: 'a', to: 'b' }, null, o)).toEqual({ wait: null, changed: false });
  });
});

describe('anchorWaitWhy', () => {
  const base = { from: '1111111aaaaaaaaaaaaa', to: '2222222bbbbbbbbbbbbb', remote: 'origin', baseBranch: 'main', since: 'T' };
  const head = 'New code is on origin/main (2222222), but ';
  const dirtyTail = (list) => `the main checkout has uncommitted changes${list ? ` to ${list}` : ''} that the new code also changes. Commit or stash them, or move a per-machine setting to .claude/settings.local.json, then pull: the run keeps the code it has until then.`;

  it('says each wait in one sentence', () => {
    expect(anchorWaitWhy({ ...base, why: 'dirty', files: ['a'] })).toBe(head + dirtyTail('a'));
    expect(anchorWaitWhy({ ...base, why: 'dirty' })).toBe(head + dirtyTail(''));
    expect(anchorWaitWhy({ ...base, why: 'dirty', files: [] })).toBe(head + dirtyTail(''));
    expect(anchorWaitWhy({ ...base, why: 'branch', branch: 'feature' })).toBe(`${head}the main checkout is on feature, not main. Switch back to main and pull: the run keeps the code it has until then.`);
    expect(anchorWaitWhy({ ...base, why: 'branch', branch: '' })).toBe(`${head}the main checkout is on a detached HEAD, not main. Switch back to main and pull: the run keeps the code it has until then.`);
    expect(anchorWaitWhy({ ...base, why: 'diverged' })).toBe(`${head}the main checkout's main has commits that origin/main does not, so it cannot be fast-forwarded. Pull to bring them together, or move them to a branch: the run keeps the code it has until then.`);
    expect(anchorWaitWhy({ ...base, why: 'failed' })).toBe(`${head}fast-forwarding the main checkout failed, perhaps because a file git does not track is in the way. Run git pull there to see why: the run keeps the code it has until then.`);
  });

  it('lists files as a, b, c and N more', () => {
    expect(anchorWaitWhy({ ...base, why: 'dirty', files: ['a', 'b'] })).toContain('changes to a and b that');
    expect(anchorWaitWhy({ ...base, why: 'dirty', files: ['a', 'b', 'c'] })).toContain('changes to a, b and c that');
    expect(anchorWaitWhy({ ...base, why: 'dirty', files: ['a', 'b', 'c', 'd', 'e'] })).toContain('changes to a, b, c and 2 more that');
  });

  it('points at the per-machine settings file for a dirty wait', () => {
    expect(anchorWaitWhy({ ...base, why: 'dirty', files: ['a'] })).toContain('.claude/settings.local.json');
  });
});
