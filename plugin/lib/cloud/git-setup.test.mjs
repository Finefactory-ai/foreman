import { describe, expect, it } from 'vitest';
import { setUpGit } from './git-setup.mjs';

// A fake shell: `answers` maps a command line prefix to a result; calls are recorded.
function fakeSh(answers = {}) {
  const calls = [];
  const sh = (cmd, args = [], opts = {}) => {
    const line = [cmd, ...args].join(' ');
    calls.push({ line, cwd: opts.cwd });
    const key = Object.keys(answers).find((k) => line.startsWith(k));
    return { status: 0, stdout: '', stderr: '', ...(key ? answers[key] : {}) };
  };
  sh.calls = calls;
  sh.lines = () => calls.map((c) => c.line);
  return sh;
}

describe('setUpGit', () => {
  it('signs git in through gh, and takes the identity from the token account when git has none', () => {
    const sh = fakeSh({ 'git config user.email': { status: 1 }, 'gh api user': { stdout: 'octo 42\n' } });
    const r = setUpGit({ root: '/p', sh });
    expect(sh.lines()).toEqual([
      'gh auth setup-git',
      'git config user.email',
      'gh api user --jq .login + " " + (.id | tostring)',
      'git config user.name octo',
      'git config user.email 42+octo@users.noreply.github.com',
    ]);
    expect(sh.calls.filter((c) => c.line.startsWith('git')).every((c) => c.cwd === '/p')).toBe(true);
    expect(r).toEqual({ identity: 'octo', warnings: [] });
  });

  it('keeps an identity git already has', () => {
    const sh = fakeSh({ 'git config user.email': { stdout: 'me@example.com\n' } });
    expect(setUpGit({ root: '/p', sh })).toEqual({ identity: 'kept', warnings: [] });
    expect(sh.lines()).not.toContain('gh api user --jq .login + " " + (.id | tostring)');
  });

  it('falls back to "Foreman" when the token has no user account, and says so', () => {
    const sh = fakeSh({ 'git config user.email': { status: 1 }, 'gh api user': { status: 1, stderr: 'Resource not accessible by integration' } });
    const r = setUpGit({ root: '/p', sh });
    expect(sh.lines()).toContain('git config user.name Foreman');
    expect(sh.lines()).toContain('git config user.email foreman@localhost');
    expect(r.identity).toBe('Foreman');
    expect(r.warnings[0]).toMatch(/could not read the token's account/);
  });

  it('warns when gh cannot set up git', () => {
    const r = setUpGit({ root: '/p', sh: fakeSh({ 'gh auth setup-git': { status: 1, stderr: 'not logged in' }, 'git config user.email': { stdout: 'a@b' } }) });
    expect(r.warnings).toEqual(['`gh auth setup-git` failed, so git pushes may not be signed in: not logged in']);
  });
});
