// A project whose pull requests merge into a stage branch (qa, then uat) while stories are cut
// from main: a shipped story must read as done from a fresh clone with no state, and the
// owner's edits to a story file on main must never conflict with the stage branches.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeRepos, git, sh, writeFile } from '../../../../test/state-repos.mjs';
import { nextStory } from '../../engine/pick.mjs';
import { openStorySource } from '../../engine/story-source.mjs';

const CONFIG = {
  version: 1,
  project: { name: 'Acme' },
  baseBranch: 'main',
  remote: 'origin',
  ship: { pr: { into: 'qa' } },
  stories: { adapter: 'markdown', dir: 'stories' },
};
const NOW = () => new Date(2026, 9, 15, 12, 0, 0);
const story = (n) => `---\nid: S-${n}\ntitle: Story ${n}\nstatus: todo\ncompleted:\n---\n\n# S-${n}\n\n## Progress notes\n\n_Newest first._\n`;

let repos;
let seed;
let laptop;
let merger;
let scratch;

// Every directory is real, so each source gets its own state folder (<root>/.foreman).
const open = (root) => openStorySource({ root, config: CONFIG, now: NOW, env: { PATH: process.env.PATH } });
const listOf = (root) => open(root).list();
const statusOf = (root, id) => listOf(root).find((s) => s.id === id)?.status;
const pick = (root) => nextStory(listOf(root), { idPattern: open(root).idPattern });

beforeEach(() => {
  repos = makeRepos(CONFIG);
  seed = join(repos.base, 'seed');
  writeFile(join(seed, '.gitignore'), '.foreman/\n');
  writeFile(join(seed, 'stories', 'S-1.md'), story(1));
  writeFile(join(seed, 'stories', 'S-2.md'), story(2));
  git(seed, 'add', '.');
  git(seed, 'commit', '-qm', 'Stories');
  git(seed, 'push', '-q', 'origin', 'main');
  for (const stage of ['qa', 'uat']) git(seed, 'push', '-q', 'origin', `main:refs/heads/${stage}`);
  laptop = repos.clone('laptop');
  merger = repos.clone('merger');
  scratch = mkdtempSync(join(tmpdir(), 'markdown-stages-'));
});
afterEach(() => {
  repos.cleanup();
  rmSync(scratch, { recursive: true, force: true });
});

// The story's life, as the pipeline runs it: a worktree cut from origin/main, finalize, one
// commit, a pushed branch, then a merge into qa and into uat. Returns the two merge statuses.
function shipStory(id) {
  git(laptop, 'fetch', '-q', 'origin');
  const wt = join(scratch, `wt-${id}`);
  git(laptop, 'worktree', 'add', '-q', '-b', `story/${id}`, wt, 'origin/main');
  const source = open(laptop);
  source.update(id, { status: 'in-progress', note: 'Started.' });
  source.finalize(id, { note: 'Works.', cwd: wt });
  git(wt, 'add', '-A');
  git(wt, 'commit', '-qm', `${id} shipped`);
  git(wt, 'push', '-q', 'origin', `story/${id}`);
  const statuses = [];
  for (const stage of ['qa', 'uat']) {
    git(merger, 'fetch', '-q', 'origin');
    git(merger, 'checkout', '-q', '-B', stage, `origin/${stage}`);
    const merged = sh('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'merge', '--no-ff', '-m', `Merge ${id}`, `origin/story/${id}`], { cwd: merger });
    statuses.push(merged.status);
    if (merged.status !== 0) sh('git', ['merge', '--abort'], { cwd: merger });
    else git(merger, 'push', '-q', 'origin', stage);
  }
  return statuses;
}

describe('a shipped story on a project with stage branches', () => {
  it('reads as done from a fresh clone with no state, and is never offered again', () => {
    expect(shipStory('S-1')).toEqual([0, 0]);
    const fresh = join(repos.base, 'fresh');
    git(repos.base, 'clone', '-q', repos.remote, fresh);
    expect(statusOf(fresh, 'S-1')).toBe('done');
    expect(statusOf(fresh, 'S-2')).toBe('todo');
    expect(pick(fresh)?.id).toBe('S-2');
    expect(git(fresh, 'show', 'origin/main:stories/S-1.md')).toBe(story(1).trimEnd());
  });

  it('lets the next story merge into qa and uat after the owner edits a shipped story on main', () => {
    expect(shipStory('S-1')).toEqual([0, 0]);
    git(seed, 'pull', '-q');
    const edited = story(1).replace('title: Story 1', 'title: Story one, renamed').replace('_Newest first._', '_Newest first._\n\nThe owner added a line.');
    writeFile(join(seed, 'stories', 'S-1.md'), edited);
    git(seed, 'commit', '-qam', 'Owner edit');
    git(seed, 'push', '-q', 'origin', 'main');

    expect(shipStory('S-2')).toEqual([0, 0]);
    expect(git(laptop, 'show', 'origin/main:stories/S-1.md')).toBe(edited.trimEnd());
    expect(git(merger, 'show', 'origin/qa:stories/S-1.md')).toBe(edited.trimEnd());

    const fresh = join(repos.base, 'fresh');
    git(repos.base, 'clone', '-q', repos.remote, fresh);
    expect(statusOf(fresh, 'S-1')).toBe('done');
    expect(statusOf(fresh, 'S-2')).toBe('done');
    expect(pick(fresh)).toBeFalsy();
  });

  it('keeps a record on qa and uat with the story and its notes, newest first', () => {
    shipStory('S-1');
    git(merger, 'fetch', '-q', 'origin');
    for (const stage of ['qa', 'uat']) {
      const record = JSON.parse(git(merger, 'show', `origin/${stage}:stories/.shipped/S-1.json`));
      expect(record).toMatchObject({ id: 'S-1', status: 'done', completed: '2026-10-15' });
      expect(record.notes.map((n) => n.text)).toEqual(['Works.', 'Started.']);
    }
  });
});
