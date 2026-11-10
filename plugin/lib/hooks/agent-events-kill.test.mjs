// The agent-events hook's kill guard: a story session's pkill, killall or kill of a process that
// is not its own is denied, and so is any signal to the supervisor. The fixture is
// test/agent-events-fixture.mjs.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bash, dir, run, withHookDir } from '../../../test/agent-events-fixture.mjs';

withHookDir();

const SESSION = () => ({ FOREMAN_RUN: '1', FOREMAN_STORY: 'ACME-1', FOREMAN_SLOT: 'w1' });
const INCIDENT = `pkill -f "vitest run plugin/lib/engine/supervisor-file-locks" ; pkill -f "foreman.*run --foreground"; cp /tmp/sup.bak plugin/lib/engine/supervisor.mjs`;
const denied = (r) => {
  expect(r.status).toBe(0);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  expect(out.hookEventName).toBe('PreToolUse');
  expect(out.permissionDecision).toBe('deny');
  return out.permissionDecisionReason;
};

describe('the agent-events hook: the kill guard', () => {
  it('denies the incident command from a builder, saying why and to kill the recorded PID', () => {
    const reason = denied(run(SESSION(), bash('foreman:builder', INCIDENT)));
    expect(reason).toMatch(/^Foreman denies this command: `pkill` stops processes by name or pattern/);
    expect(reason).toContain('the PID you recorded');
  });

  it('denies a signal to the supervisor named in supervisor.pid', () => {
    mkdirSync(join(dir, 'state'), { recursive: true });
    writeFileSync(join(dir, 'state', 'supervisor.pid'), `${process.pid}\n`);
    const reason = denied(run(SESSION(), bash('foreman:builder', `kill -TERM ${process.pid}`)));
    expect(reason).toContain('the Foreman supervisor');
  });

  it('denies a signal to the supervisor written as a backtick substitution', () => {
    mkdirSync(join(dir, 'state'), { recursive: true });
    writeFileSync(join(dir, 'state', 'supervisor.pid'), `${process.pid}\n`);
    for (const command of ['kill -TERM `cat state/supervisor.pid`', 'kill -9 `pgrep -f "foreman.*run --foreground"`']) {
      expect(denied(run(SESSION(), bash('foreman:builder', command)))).toContain('Foreman allows only');
    }
  });

  it('denies every kill that is not a numeric pid with an allowed signal', () => {
    mkdirSync(join(dir, 'state'), { recursive: true });
    writeFileSync(join(dir, 'state', 'supervisor.pid'), `${process.pid}\n`);
    for (const command of [`kill -s 0 -TERM ${process.pid}`, 'kill $!', 'npm start & sleep 1; kill $!']) {
      expect(denied(run(SESSION(), bash('foreman:builder', command))), command).toContain('Foreman allows only');
    }
  });

  it('denies a command that runs kill for the agent', () => {
    mkdirSync(join(dir, 'state'), { recursive: true });
    writeFileSync(join(dir, 'state', 'supervisor.pid'), `${process.pid}\n`);
    expect(denied(run(SESSION(), bash('foreman:builder', 'pgrep -f "acme.*run" | xargs kill')))).toContain('runs `kill`');
  });

  it('allows a command that signals nothing, and a commit message that mentions kill', () => {
    mkdirSync(join(dir, 'state'), { recursive: true });
    writeFileSync(join(dir, 'state', 'supervisor.pid'), `${process.pid}\n`);
    for (const command of ['echo hello', 'git commit -m "ACME-1 stop the kill by pattern"']) {
      const r = run(SESSION(), bash('foreman:builder', command));
      expect(r.status, command).toBe(0);
      expect(r.stdout, command).toBe('');
    }
  });
});
