// Real temp git repos for the state-store tests: a bare remote, a seed commit on main with
// foreman.config.json, and clones of it. Git runs with no global or system config, so a
// developer's hooks, signing or identity never change a result.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete ENV[key];

// The shell the code under test gets.
export const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env: ENV, ...opts });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

export function git(cwd, ...args) {
  const r = sh('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

export const writeFile = (file, text) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};

// { base, remote, clone(name), cleanup() }. The seed's config uses `config` as given.
export function makeRepos(config = { version: 1, project: { name: 'T' }, state: { store: 'branch' } }) {
  const base = mkdtempSync(join(tmpdir(), 'foreman-state-'));
  const remote = join(base, 'remote.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  const seed = join(base, 'seed');
  git(base, 'clone', '-q', remote, seed);
  writeFile(join(seed, 'foreman.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  writeFile(join(seed, 'README.md'), 'a project\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-qm', 'Start');
  git(seed, 'push', '-q', 'origin', 'main');
  return {
    base,
    remote,
    clone(name) {
      const dir = join(base, name);
      git(base, 'clone', '-q', remote, dir);
      return dir;
    },
    // The files on the remote's state branch, or [] when it has none.
    remoteFiles(branch = 'foreman-state') {
      const r = sh('git', ['ls-tree', '-r', '--name-only', branch], { cwd: remote });
      return r.status === 0 ? r.stdout.split('\n').filter(Boolean).sort() : [];
    },
    remoteFile(path, branch = 'foreman-state') {
      return git(remote, 'show', `${branch}:${path}`);
    },
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}
