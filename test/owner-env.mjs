// Tests that need the owner's shape of environment (no story session, not started by a run)
// build one here, from scratch in a temporary project, and never by unsetting or overriding the
// live session's variables: a session's env stripped back to "owner" would still point at the
// real run.
//
//   ownerProject({ git, config }) -> { tmp, dir, home, env, remove }
//       tmp     a new folder under the system temp directory
//       dir     tmp/acme, holding foreman.config.json (config, default an Acme project with two
//               slots); a git repo with one commit when git is true (the default)
//       home    tmp/home, the env's HOME and XDG_CONFIG_HOME
//       env     a new object with only PATH, HOME, XDG_CONFIG_HOME, TMPDIR, GIT_CONFIG_NOSYSTEM and
//               the Acme git author and committer: no FOREMAN_* variable, nothing else copied
//       remove  deletes tmp

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

const ACME = { version: 1, project: { name: 'Acme' }, slots: 2 };

export function ownerProject({ git = true, config = ACME } = {}) {
  const tmp = mkdtempSync(join(os.tmpdir(), 'foreman-owner-'));
  const dir = join(tmp, 'acme');
  const home = join(tmp, 'home');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: home,
    TMPDIR: os.tmpdir(),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Acme',
    GIT_AUTHOR_EMAIL: 'acme@example.com',
    GIT_COMMITTER_NAME: 'Acme',
    GIT_COMMITTER_EMAIL: 'acme@example.com',
  };
  writeFileSync(join(dir, 'foreman.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  if (git) {
    for (const args of [['init', '-q'], ['add', '.'], ['commit', '-q', '-m', 'Acme']]) {
      const r = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' });
      if (r.status !== 0) {
        rmSync(tmp, { recursive: true, force: true });
        throw new Error(`git ${args.join(' ')}: ${r.stderr || r.error?.message}`);
      }
    }
  }
  return { tmp, dir, home, env, remove: () => rmSync(tmp, { recursive: true, force: true }) };
}
