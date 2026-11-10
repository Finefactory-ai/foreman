// On macOS, `npm test` puts the real git ahead of /usr/bin, whose git is the xcrun launcher
// (test/real-git.mjs).

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { realGitPath, suiteEnv } from './real-git.mjs';

const CLT = '/Library/Developer/CommandLineTools/usr/bin';
const BREW_PATH = '/opt/homebrew/bin:/usr/bin:/bin';

// isExe that says yes only for the files listed.
const exes = (...files) => (file) => files.includes(file);
const found = (stdout, status = 0) => () => ({ status, stdout });
const throws = () => {
  throw new Error('xcrun failed');
};
// A find that throws and counts its calls: realGitPath catches the throw, so only the count
// shows that it looked.
function never() {
  const find = () => {
    find.calls += 1;
    throw new Error('find was called');
  };
  find.calls = 0;
  return find;
}

describe('realGitPath', () => {
  it('leaves PATH alone off macOS, without looking for the real git', () => {
    const p = '/usr/bin:/bin';
    const find = never();
    expect(realGitPath({ platform: 'linux', path: p, find, isExe: exes('/usr/bin/git') })).toBe(p);
    expect(find.calls).toBe(0);
  });

  it('leaves PATH alone when a real git already wins before /usr/bin', () => {
    const isExe = exes('/opt/homebrew/bin/git', '/usr/bin/git');
    const find = never();
    expect(realGitPath({ platform: 'darwin', path: BREW_PATH, find, isExe })).toBe(BREW_PATH);
    expect(find.calls).toBe(0);
  });

  it('puts the real git folder just before /usr/bin, not at the front', () => {
    const isExe = exes('/usr/bin/git', `${CLT}/git`);
    const out = realGitPath({ platform: 'darwin', path: BREW_PATH, find: found(`${CLT}/git\n`), isExe });
    expect(out).toBe(`/opt/homebrew/bin:${CLT}:/usr/bin:/bin`);
  });

  it.each([
    ['find throws', throws, exes('/usr/bin/git', `${CLT}/git`)],
    ['find exits non-zero', found(`${CLT}/git\n`, 1), exes('/usr/bin/git', `${CLT}/git`)],
    ['find gives no status', found(`${CLT}/git\n`, null), exes('/usr/bin/git', `${CLT}/git`)],
    ['find prints nothing', found('  \n'), exes('/usr/bin/git', `${CLT}/git`)],
    ['find prints a relative path', found('usr/bin/git\n'), exes('/usr/bin/git', 'usr/bin/git')],
    ['find prints /usr/bin/git', found('/usr/bin/git\n'), exes('/usr/bin/git')],
    ['the found git is not executable', found(`${CLT}/git\n`), exes('/usr/bin/git')],
  ])('leaves PATH alone when %s', (_, find, isExe) => {
    expect(realGitPath({ platform: 'darwin', path: BREW_PATH, find, isExe })).toBe(BREW_PATH);
  });

  it('changes nothing when run twice', () => {
    const isExe = exes('/usr/bin/git', `${CLT}/git`);
    const find = found(`${CLT}/git\n`);
    const once = realGitPath({ platform: 'darwin', path: BREW_PATH, find, isExe });
    expect(realGitPath({ platform: 'darwin', path: once, find, isExe })).toBe(once);
  });

  it('leaves PATH alone when no git is on it, without looking for the real git', () => {
    const find = never();
    expect(realGitPath({ platform: 'darwin', path: BREW_PATH, find, isExe: exes() })).toBe(BREW_PATH);
    expect(realGitPath({ platform: 'darwin', path: '', find, isExe: exes() })).toBe('');
    expect(find.calls).toBe(0);
  });
});

describe('suiteEnv', () => {
  const opts = { platform: 'darwin', find: found(`${CLT}/git\n`), isExe: exes('/usr/bin/git', `${CLT}/git`) };

  it('changes only PATH, to realGitPath result, and leaves the env given alone', () => {
    const env = { PATH: BREW_PATH, HOME: '/home/acme', ACME_TOKEN: 'x', EMPTY: '' };
    const before = { ...env };
    const out = suiteEnv(env, opts);
    expect(out).toEqual({ ...before, PATH: realGitPath({ path: BREW_PATH, ...opts }) });
    expect(out.PATH).toBe(`/opt/homebrew/bin:${CLT}:/usr/bin:/bin`);
    expect(env).toEqual(before);
    expect(out).not.toBe(env);
  });

  it('adds no PATH when the env has none', () => {
    const out = suiteEnv({ HOME: '/home/acme' }, opts);
    expect(out).toEqual({ HOME: '/home/acme' });
  });
});

const xcrun = process.platform === 'darwin' ? spawnSync('xcrun', ['--find', 'git'], { encoding: 'utf8', timeout: 5000 }) : null;
const realGit = xcrun?.status === 0 ? xcrun.stdout.trim() : '';

describe('on this Mac', () => {
  it.runIf(process.platform === 'darwin' && path.isAbsolute(realGit))('runs the same git that /usr/bin/git starts', () => {
    const env = suiteEnv({ ...process.env, PATH: '/usr/bin:/bin' });
    expect(env.PATH).toBe(`${path.dirname(realGit)}:/usr/bin:/bin`);
    for (const flag of ['--exec-path', '--version']) {
      const viaPath = spawnSync('git', [flag], { env, encoding: 'utf8' });
      const launcher = spawnSync('/usr/bin/git', [flag], { encoding: 'utf8' });
      expect(viaPath.status).toBe(0);
      expect(viaPath.stdout).toBe(launcher.stdout);
    }
  });
});
