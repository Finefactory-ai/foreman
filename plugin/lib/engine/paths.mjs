// Where things are. The project is the repo Foreman works on, never the folder these scripts
// live in (as a plugin they live in the plugin cache).

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';

const defaultSh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });

// FOREMAN_PROJECT_DIR when set, else the main checkout of the git repo around cwd (inside a
// worktree, git's common dir is the main checkout's .git), else cwd.
export function projectRoot({ cwd = process.cwd(), env = process.env, sh = defaultSh } = {}) {
  if (env.FOREMAN_PROJECT_DIR) return env.FOREMAN_PROJECT_DIR;
  const r = sh('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd });
  const common = r.status === 0 ? String(r.stdout).trim() : '';
  return common ? dirname(common) : cwd;
}

export function stateDir(root, config, env = process.env) {
  return env.FOREMAN_STATE_DIR || join(root, config?.stateDir ?? '.foreman');
}

export function currentSlot(env = process.env) {
  return env.FOREMAN_SLOT || 'w1';
}
