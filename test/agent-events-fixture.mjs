// The fixture for the agent-events hook tests (agent-events*.test.mjs): the hook run as a child
// process from a fresh temp project folder, with a clean environment, and the production guard's
// sample config and Bash input.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach } from 'vitest';

const HOOK = fileURLToPath(new URL('../plugin/lib/hooks/agent-events.mjs', import.meta.url));

// A child's environment built from scratch: nothing inherited from the shell that Foreman reads.
export const cleanEnv = (extra) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(FOREMAN|FACTORY)_/.test(k))),
  ...extra,
});

export let dir;
// Registers the hooks that give each test a fresh project folder, dir.
export function withHookDir() {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-hook-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
}

export const START = JSON.stringify({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'foreman:architect' });
export const hook = (env, input = START) =>
  spawnSync('node', [HOOK], { input, encoding: 'utf8', timeout: 20_000, cwd: dir, env: cleanEnv({ FOREMAN_PROJECT_DIR: dir, FOREMAN_STATE_DIR: join(dir, 'state'), ...env }) });

// The production guard's sample project, a Bash call by an agent, and a hook run with that config.
export const CONFIG = { version: 1, project: { name: 'x' }, ship: { steps: ['pr'], smoke: { urls: ['https://app.example.com/health'] } } };
export const bash = (agent_type, command) =>
  JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, ...(agent_type ? { agent_id: 'x1', agent_type } : {}) });
export const run = (env, input) => {
  writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify(CONFIG));
  return hook(env, input);
};

// The deny the host guard prints for a tester's call to production.
export const HOST_DENY = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: 'Foreman keeps the tester and reviewers off production (app.example.com). Test against the local or slot environment instead.',
  },
};
