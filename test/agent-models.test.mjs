// The Foreman side of "a role's model is the model its agent runs on", end to end and in
// process: the setting (roles.*.model) -> the workflow args -> the pipeline's agent() options ->
// the agent's transcript -> the model recorded in the run record's agents -> the mismatch
// warning. The runtime here is a script: one that honours agent()'s `model` option, and one that
// ignores it (every agent on Opus). The Claude Code side, that a real session honours the option,
// is checked on every real run by the run's warning and the doctor's 'agent models' check.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorkflow } from './workflow-harness.mjs';
import { withDefaults } from '../plugin/lib/config/defaults.mjs';
import { workflowArgs } from '../plugin/lib/engine/workflow-args.mjs';
import { collectSessionTokens } from '../plugin/lib/engine/session-files.mjs';
import { modelMismatches, roleModels } from '../plugin/lib/engine/state.mjs';

const SESSION = '5f0c1d2e-3a4b-4c5d-8e6f-708192a3b4c5';
const FULL = { sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', haiku: 'claude-haiku-4-5' };

const config = withDefaults({
  version: 1,
  project: { name: 'Acme' },
  roles: {
    builders: { developer: { agent: 'foreman:builder', use: 'everything', model: 'sonnet' } },
    reviewers: [
      { name: 'compliance', agent: 'foreman:compliance-reviewer', model: 'sonnet' },
      { name: 'security', agent: 'foreman:security-reviewer' },
    ],
  },
});

const PLAN = { ready: true, blocker: '', needs_owner: false, builder: 'developer', resources: [], design: 'Change login.js only.', test_plan: 'login.test.js proves it.', done_when: 'npm test passes' };
const BUILT = { complete: true, summary: 'Built it.', files: ['login.js'], commands: [{ command: 'npm test', passed: true }], problem: '' };
const OK = { approved: true, findings: [], checked: 'ran npm test' };

let projects;
beforeEach(() => {
  projects = mkdtempSync(join(tmpdir(), 'foreman-agent-models-'));
});
afterEach(() => rmSync(projects, { recursive: true, force: true }));

// Runs the pipeline; every agent call leaves a transcript and a meta file as Claude Code does,
// on the model `modelOf(call)`. Returns the agents the run record would hold.
async function sessionAgents(modelOf) {
  const wf = join(projects, '-tmp-acme', SESSION, 'subagents', 'workflows', 'wf_1');
  mkdirSync(wf, { recursive: true });
  let n = 0;
  const leave = (result) => (call) => {
    n += 1;
    const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    writeFileSync(join(wf, `agent-a${n}.jsonl`), `${JSON.stringify({ type: 'assistant', message: { id: `m${n}`, model: modelOf(call), usage } })}\n`);
    writeFileSync(join(wf, `agent-a${n}.meta.json`), JSON.stringify({ agentType: call.agentType, description: call.label, workflowPhase: call.phase }));
    return result;
  };
  const args = workflowArgs({ story: { id: 'ACME-1', title: 'Acme login' }, briefPath: 'stories/ACME-1.md', config });
  await runWorkflow(args, {
    'architect:': leave(PLAN),
    'build:': leave(BUILT),
    'test:': leave(OK),
    'compliance:': leave(OK),
    'security:': leave(OK),
  });
  const logText = `${JSON.stringify({ type: 'system', subtype: 'init', session_id: SESSION, model: 'claude-opus-5-5', cwd: '/tmp/acme' })}\n`;
  return collectSessionTokens({ logText, projects, record: true }).agents;
}

const modelOfRow = (agents, name) => agents.find((a) => a.name === name)?.model;

describe('a role set to a model: from the setting to the recorded model', () => {
  it('runs the build and the compliance review on Sonnet when the runtime honours the setting', async () => {
    const agents = await sessionAgents((call) => FULL[call.model] ?? 'claude-opus-5-5');
    expect(modelOfRow(agents, 'build')).toBe('claude-sonnet-5-5');
    expect(modelOfRow(agents, 'compliance')).toBe('claude-sonnet-5-5');
    for (const name of ['architect', 'test', 'security']) expect(modelOfRow(agents, name), name).toBe('claude-opus-5-5');
    expect(modelMismatches(agents, roleModels(config))).toEqual([]);
  });

  it('warns for the build and the compliance review when the runtime ignores the setting', async () => {
    const agents = await sessionAgents(() => 'claude-opus-5-5');
    expect(modelMismatches(agents, roleModels(config)).map((m) => m.text)).toEqual([
      'build (foreman:builder) is set to Sonnet but ran on Opus 5.5',
      'compliance (foreman:compliance-reviewer) is set to Sonnet but ran on Opus 5.5',
    ]);
  });
});
