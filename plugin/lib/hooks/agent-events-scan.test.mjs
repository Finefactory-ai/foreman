// The agent-events hook's scan guard: a story session's search of the whole disk, the owner's
// home folder or any folder outside the project is denied, for Bash and for Read, Glob and Grep.
// The fixture is test/agent-events-fixture.mjs.

import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bash, dir, run, withHookDir } from '../../../test/agent-events-fixture.mjs';

withHookDir();

// A home folder that never exists, and the owner's path under the system root (made up).
const HOME = join(parse(tmpdir()).root, `acme-home-${process.pid}`);
const OWNER = join(parse(tmpdir()).root, 'Users', 'acme');
const SESSION = () => ({ FOREMAN_RUN: '1', HOME, FOREMAN_STORY: 'ACME-1', FOREMAN_SLOT: 'w1' });
const worktree = () => {
  const cwd = join(dir, '.foreman', 'worktrees', 'w1');
  mkdirSync(cwd, { recursive: true });
  return cwd;
};
const call = (tool_name, tool_input, agent_type, cwd) =>
  JSON.stringify({ hook_event_name: 'PreToolUse', tool_name, tool_input, cwd, ...(agent_type ? { agent_id: 'x1', agent_type } : {}) });
const bashIn = (agent, command) => JSON.stringify({ ...JSON.parse(bash(agent, command)), cwd: worktree() });
const reasonOf = (r) => {
  expect(r.status).toBe(0);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  expect(out.permissionDecision).toBe('deny');
  return out.permissionDecisionReason;
};

describe('the agent-events hook: the scan guard', () => {
  it('denies an architect scan of the disk, the home folder and the owner folder', () => {
    for (const command of ['find / -name CHANGELOG.md', 'find ~ -name x', 'du -sh ~/*', `rg x ${OWNER}`]) {
      const reason = reasonOf(run(SESSION(), bashIn('foreman:architect', command)));
      expect(reason, command).toMatch(/^Foreman denies this command: `(find|du|rg)` would search \//);
    }
  });

  it('denies the same for the foreman, which has no agent type', () => {
    for (const command of ['find / -name CHANGELOG.md', 'find ~ -name x']) {
      expect(reasonOf(run(SESSION(), bashIn(null, command))), command).toMatch(/^Foreman denies this command: `find` would search \//);
    }
  });

  it('denies an if/then wrapped scan from the architect', () => {
    const reason = reasonOf(run(SESSION(), bashIn('foreman:architect', 'if true; then find / -name x; fi')));
    expect(reason).toMatch(/^Foreman denies this command: `find` would search \//);
  });

  // The fixture's project, worktree and state folder all sit under the temp folder, which is a root
  // itself, so this test cannot tell a dropped anchor from a kept one; sessionScanRoots' unit test
  // (scan-guard.test.mjs) covers a project and state folder outside it.
  it('allows a search in the worktree, the state folder, ~/.claude and the temp folder', () => {
    const command = `find . -name x && rg x ${join(dir, 'state')} && find ~/.claude -name x && du -sh ${tmpdir()}`;
    const r = run(SESSION(), bashIn('foreman:architect', command));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('denies a Read and a Glob outside the project', () => {
    const cwd = worktree();
    const read = run(SESSION(), call('Read', { file_path: join(OWNER, 'Desktop', 'a.txt') }, 'foreman:builder', cwd));
    expect(reasonOf(read)).toMatch(/^Foreman denies this Read call:/);
    const glob = run(SESSION(), call('Glob', { pattern: '*.md', path: HOME }, 'foreman:builder', cwd));
    expect(reasonOf(glob)).toMatch(/^Foreman denies this Glob call:/);
  });

  it('denies a Grep of ~, the home folder', () => {
    const cwd = worktree();
    const r = run(SESSION(), call('Grep', { pattern: 'x', path: '~' }, 'foreman:builder', cwd));
    expect(reasonOf(r)).toMatch(/^Foreman denies this Grep call:/);
  });

  it('allows a Read of a file in the worktree', () => {
    const cwd = worktree();
    const r = run(SESSION(), call('Read', { file_path: join(cwd, 'a.txt') }, 'foreman:builder', cwd));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
});
