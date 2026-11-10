// The fixture for the anchor guard tests (anchor-guard.test.mjs, anchor-guard-refused.test.mjs,
// anchor-guard-owner.test.mjs): the Acme project a Foreman run builds (the anchor) with slot w1's
// worktree in it, a scratch git repo, the run's environment, and a snapshot of every file a story
// session must not change.

import { afterEach, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../plugin/lib/cli/main.mjs';
import { REGISTRY } from '../plugin/lib/settings/registry.mjs';

export const BIN = fileURLToPath(new URL('../plugin/bin/foreman', import.meta.url));
export const CONFIG = `${JSON.stringify({ version: 1, project: { name: 'Acme' }, slots: 2 }, null, 2)}\n`;
export const SWITCH = REGISTRY.find((e) => e.group === 'features').name.slice('features.'.length);
export const refusal = (what, anchor) =>
  `${what} would change ${anchor}, the project this Foreman run builds, so it does not run inside a story session (FOREMAN_RUN=1); run it in a scratch git repo instead.\n`;

export let tmp;
export let home;
export let anchor;
export let slot;
export let scratch;
export let plain;

export const gitEnv = () => ({
  PATH: process.env.PATH,
  HOME: home,
  XDG_CONFIG_HOME: home,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Acme',
  GIT_AUTHOR_EMAIL: 'acme@example.com',
  GIT_COMMITTER_NAME: 'Acme',
  GIT_COMMITTER_EMAIL: 'acme@example.com',
});
export const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
};

export function repo(name, { config = true } = {}) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, 'stories'), { recursive: true });
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'stories', '.keep'), '');
  if (config) fs.writeFileSync(path.join(dir, 'foreman.config.json'), CONFIG);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'Acme');
  return dir;
}

// The run's environment, as the supervisor sets it for a session in slot w1.
export const runEnv = (extra = {}) => ({
  ...gitEnv(),
  FOREMAN_RUN: '1',
  FOREMAN_PROJECT_DIR: anchor,
  FOREMAN_STATE_DIR: path.join(anchor, '.foreman'),
  FOREMAN_SLOT: 'w1',
  FOREMAN_STORY: 'S-1',
  FOREMAN_STATE_SYNC: 'off',
  ...extra,
});

// The bytes of every file a story session must not change in the anchor.
export function snapshot() {
  const out = {};
  const walk = (rel) => {
    const abs = path.join(anchor, rel);
    if (!fs.existsSync(abs)) return;
    if (rel === path.join('.foreman', 'worktrees')) return;
    if (fs.lstatSync(abs).isDirectory()) {
      for (const name of fs.readdirSync(abs).sort()) walk(path.join(rel, name));
    } else {
      out[rel] = fs.readFileSync(abs).toString('base64');
    }
  };
  for (const rel of ['foreman.config.json', '.foreman', '.env.local', '.claude', 'stories']) walk(rel);
  return out;
}

// alive and parents stand in for the owner-control check's process lookups (run-guard.mjs
// refuseOwnerControl); left out, main uses the real ones.
export async function run(argv, { cwd, env = runEnv(), alive, parents }) {
  let out = '';
  let err = '';
  const code = await main(argv, { cwd, env, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } }, alive, parents });
  return { code, out, err };
}

export const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// Registers the hooks that give each test the Acme anchor with its slot worktree, a scratch repo
// and a plain Acme project in no git repo, in a fresh temp folder.
export function withAnchorRepos() {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-anchor-guard-'));
    home = path.join(tmp, 'home');
    fs.mkdirSync(home);
    anchor = repo('acme');
    fs.mkdirSync(path.join(anchor, '.foreman'), { recursive: true });
    fs.writeFileSync(path.join(anchor, '.foreman', 'settings.json'), '{\n  "workers": 2\n}\n');
    fs.writeFileSync(path.join(anchor, '.env.local'), 'ACME_URL=http://localhost\n');
    slot = path.join(anchor, '.foreman', 'worktrees', 'w1');
    git(anchor, 'worktree', 'add', '-q', '--detach', slot);
    fs.symlinkSync(path.join(anchor, '.env.local'), path.join(slot, '.env.local'));
    scratch = repo('scratch');
    // A temporary Acme project in no git repo at all.
    plain = path.join(tmp, 'plain-acme');
    fs.mkdirSync(plain);
    fs.writeFileSync(path.join(plain, 'foreman.config.json'), CONFIG);
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
}
