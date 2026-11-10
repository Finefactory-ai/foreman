// The fixture for the `foreman run` command tests (run.test.mjs, and run-real.test.mjs, which
// starts the real bin): a temp project with two markdown stories, pushed to a bare origin, and
// the helpers that run Foreman in it.

import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runForeman } from './supervisors.mjs';

export let tmp;
export let proj;

// The environment of a plain shell: nothing Foreman set for another run leaks in.
export const cleanEnv = () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('FOREMAN_') && !k.startsWith('FACTORY_')));
  return { ...env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
};
export const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
};
export const story = (id, title) => `---\nid: ${id}\ntitle: ${title}\nstatus: todo\ndepends_on: []\n---\n\n## Progress notes\n`;

// Registers the hooks that give each test a fresh project with two stories, pushed to a bare origin.
export function withRunProject() {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'foreman-run-'));
    const origin = join(tmp, 'origin.git');
    proj = join(tmp, 'proj');
    git(tmp, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
    mkdirSync(join(proj, 'stories'), { recursive: true });
    writeFileSync(
      join(proj, 'foreman.config.json'),
      JSON.stringify({ version: 1, project: { name: 'T' }, slots: 3, checks: [{ run: 'true', when: 'always' }], stories: { adapter: 'markdown', dir: 'stories' }, install: null }),
    );
    writeFileSync(join(proj, 'stories', 'S-1.md'), story('S-1', 'First thing'));
    writeFileSync(join(proj, 'stories', 'S-2.md'), story('S-2', 'Second thing'));
    writeFileSync(join(proj, '.gitignore'), '.foreman/\n');
    git(proj, 'init', '--quiet', '--initial-branch=main');
    git(proj, 'add', '-A');
    git(proj, 'commit', '--quiet', '-m', 'start');
    git(proj, 'remote', 'add', 'origin', origin);
    git(proj, 'push', '--quiet', '-u', 'origin', 'main');
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));
}

export const foreman = (...args) => runForeman(args, { cwd: proj, env: cleanEnv(), encoding: 'utf8', timeout: 60_000 });
