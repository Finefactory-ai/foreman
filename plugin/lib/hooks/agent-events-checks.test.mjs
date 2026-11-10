// The agent-events hook's check guard: a Bash command that runs one of the project's checks by
// hand is denied and the denial is recorded in the run's check-runs.jsonl. The fixture is
// test/agent-events-fixture.mjs.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bash, CONFIG, dir, hook, withHookDir } from '../../../test/agent-events-fixture.mjs';

withHookDir();

const RUN = 'SLOW_TEST_GUARD=report npm test';
const SESSION = { FOREMAN_RUN: '1', FOREMAN_STORY: 'ACME-1', FOREMAN_SLOT: 'w2' };
const withChecks = (checks, env, input) => {
  writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ ...CONFIG, checks }));
  return hook(env, input);
};
const records = () => {
  const file = join(dir, 'state', 'check-runs.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const reasonOf = (r) => {
  expect(r.status).toBe(0);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  expect(out.permissionDecision).toBe('deny');
  return out.permissionDecisionReason;
};

describe('the agent-events hook: the check guard', () => {
  const node = [{ run: RUN, when: 'always' }];

  it('denies a builder hand run of a check and records the denial', () => {
    const r = withChecks(node, SESSION, bash('foreman:builder', `${RUN} 2>&1 | tail -40`));
    expect(reasonOf(r)).toContain('foreman checks');
    expect(records()).toEqual([expect.objectContaining({ story: 'ACME-1', slot: 'w2', run: RUN, full: true, denied: true })]);
    expect(typeof records()[0].at).toBe('string');
  });

  it('records a null story and slot outside a story', () => {
    withChecks(node, { FOREMAN_RUN: '1' }, bash(null, 'npm test'));
    expect(records()).toEqual([expect.objectContaining({ story: null, slot: null, run: RUN, denied: true })]);
  });

  it('allows foreman checks and a targeted test run, and adds no line', () => {
    for (const command of ['foreman checks --changed', 'npx vitest run plugin/lib/engine/state.test.mjs']) {
      const r = withChecks(node, SESSION, bash('foreman:builder', command));
      expect(r.status).toBe(0);
      expect(r.stdout, command).toBe('');
    }
    expect(records()).toEqual([]);
  });

  it('does nothing without FOREMAN_RUN: allows npm test and writes no file', () => {
    const r = withChecks(node, { FOREMAN_STORY: 'ACME-1' }, bash('foreman:builder', 'npm test'));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(readdirSync(dir).sort()).toEqual(['foreman.config.json']);
  });

  it('denies pytest and allows a targeted pytest run for a project with a pytest check', () => {
    const py = [{ run: 'pytest', when: 'always' }];
    expect(reasonOf(withChecks(py, SESSION, bash('foreman:tester', 'pytest -q')))).toContain('`pytest`');
    expect(withChecks(py, SESSION, bash('foreman:tester', 'pytest tests/test_x.py')).stdout).toBe('');
    expect(records()).toEqual([expect.objectContaining({ run: 'pytest', denied: true })]);
  });

  it('adds no denied line when the host guard denies a command that is not a check', () => {
    const r = withChecks(node, SESSION, bash('foreman:tester', 'curl https://app.example.com/health'));
    expect(reasonOf(r)).toMatch(/off production/);
    expect(records()).toEqual([]);
  });

  it('adds no denied line when the project-files guard denies first', () => {
    const r = withChecks(node, SESSION, bash('foreman:builder', `echo x >> ${join(dir, '.env.local')}; ${RUN}`));
    expect(reasonOf(r)).toMatch(/belongs to the project this run builds/);
    expect(records()).toEqual([]);
  });

  it('still denies when the record cannot be written', () => {
    writeFileSync(join(dir, 'state'), 'a file where the state folder should be');
    const r = withChecks(node, SESSION, bash('foreman:builder', 'npm test'));
    expect(reasonOf(r)).toContain('foreman checks');
  });
});
