import { describe, expect, it } from 'vitest';
import { agentOf, resultTokens, storyAgents, total, transcriptUsage, ZERO } from './tokens.mjs';

const line = (event) => JSON.stringify(event);
const assistant = (id, usage, model = 'claude-opus-5-5', extra = {}) => line({ type: 'assistant', message: { id, model, role: 'assistant', content: [{ type: 'text', text: 'x' }], usage }, ...extra });
const usage = (input, output, read = 0, write = 0) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: write });

// Three messages: m1 is written twice (one line per content block), and its last line carries
// the final output count; a user line, a synthetic line and a torn last line are not counted.
const TRANSCRIPT = [
  line({ type: 'user', message: { role: 'user', content: 'Plan ACME-1' } }),
  assistant('m1', usage(3, 8, 1000, 200)),
  assistant('m1', usage(3, 173, 1000, 200)),
  line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }),
  assistant('m2', usage(1, 50, 2000, 0)),
  assistant('m3', usage(2, 20, 3000, 10), '<synthetic>'),
  '{"type":"assistant","message":{"id":"m4","usage":{"input_tok',
].join('\n');

describe('transcriptUsage', () => {
  it('sums each message once, with its last line, and names the real model', () => {
    expect(transcriptUsage(TRANSCRIPT)).toEqual({ input: 6, output: 243, cacheRead: 6000, cacheWrite: 210, turns: 3, model: 'claude-opus-5-5' });
  });

  it('counts a line with no id on its own and treats missing fields as 0', () => {
    const text = [line({ type: 'assistant', message: { model: 'claude-haiku-5', usage: { input_tokens: 4 } } }), line({ type: 'assistant', message: { model: 'claude-haiku-5', usage: { output_tokens: 6 } } })].join('\n');
    expect(transcriptUsage(text)).toEqual({ input: 4, output: 6, cacheRead: 0, cacheWrite: 0, turns: 2, model: 'claude-haiku-5' });
  });

  it('gives zeros and no model for nothing', () => {
    expect(transcriptUsage('')).toEqual({ ...ZERO, model: null });
    expect(transcriptUsage(undefined)).toEqual({ ...ZERO, model: null });
    expect(transcriptUsage('not json\n{"type":"assistant"}')).toEqual({ ...ZERO, model: null });
  });
});

describe('total', () => {
  it('adds the four counts', () => {
    expect(total({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, turns: 99 })).toBe(10);
    expect(total(ZERO)).toBe(0);
  });
});

describe('agentOf', () => {
  const meta = (description, workflowPhase, agentType = 'foreman:agent') => ({ agentType, description, workflowPhase });

  it('maps each label the pipeline gives', () => {
    expect(agentOf(meta('architect:ACME-1', 'Architect', 'foreman:architect'))).toEqual({ role: 'architect', name: 'architect', agent: 'foreman:architect', round: null });
    expect(agentOf(meta('build:ACME-1', 'Build', 'foreman:developer'))).toEqual({ role: 'builder', name: 'build', agent: 'foreman:developer', round: 1 });
    expect(agentOf(meta('fix:ACME-1#2', 'Build', 'foreman:developer'))).toEqual({ role: 'builder', name: 'fix', agent: 'foreman:developer', round: 2 });
    expect(agentOf(meta('test:ACME-1#1', 'Test', 'foreman:tester'))).toEqual({ role: 'tester', name: 'test', agent: 'foreman:tester', round: 1 });
    expect(agentOf(meta('security:ACME-1#1', 'Review', 'foreman:security-reviewer'))).toEqual({ role: 'reviewer', name: 'security', agent: 'foreman:security-reviewer', round: 1 });
  });

  it('falls back to the phase, then to other', () => {
    expect(agentOf(meta('plan-check:ACME-1', 'Architect'))).toMatchObject({ role: 'architect', name: 'plan-check' });
    expect(agentOf({ agentType: 'Explore', description: 'look around' })).toEqual({ role: 'other', name: 'Explore', agent: 'Explore', round: null });
    expect(agentOf({ description: 'look around' })).toEqual({ role: 'other', name: 'agent', agent: null, round: null });
  });

  it('gives other for missing or garbage meta', () => {
    const other = { role: 'other', name: 'agent', agent: null, round: null };
    for (const m of [undefined, null, 'x', 7, [], {}]) expect(agentOf(m)).toEqual(other);
  });
});

describe('resultTokens', () => {
  it('sums modelUsage across models', () => {
    const event = {
      type: 'result',
      num_turns: 9,
      usage: usage(1, 1, 1, 1),
      modelUsage: {
        'claude-opus-5-5': { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40, costUSD: 1 },
        'claude-haiku-5': { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 },
      },
    };
    expect(resultTokens(event)).toEqual({ input: 11, output: 22, cacheRead: 33, cacheWrite: 44, turns: 9, models: ['claude-opus-5-5', 'claude-haiku-5'] });
  });

  it('falls back to usage, and gives null for neither', () => {
    expect(resultTokens({ type: 'result', num_turns: 2, usage: usage(2, 61, 21695, 21825) })).toEqual({ input: 2, output: 61, cacheRead: 21695, cacheWrite: 21825, turns: 2, models: [] });
    expect(resultTokens({ type: 'result', usage: usage(1, 1), modelUsage: {} })).toMatchObject({ input: 1, output: 1, turns: 0 });
    expect(resultTokens({ type: 'result', num_turns: 2 })).toBeNull();
    expect(resultTokens(null)).toBeNull();
  });
});

describe('storyAgents', () => {
  const sub = (description, workflowPhase, u) => ({ meta: { agentType: 'foreman:x', description, workflowPhase }, text: assistant('m', u) });
  const subagents = [
    sub('test:ACME-1#1', 'Test', usage(10, 10, 100, 10)),
    sub('security:ACME-1#1', 'Review', usage(5, 5, 50, 5)),
    sub('architect:ACME-1', 'Architect', usage(20, 20, 200, 20)),
    sub('build:ACME-1', 'Build', usage(30, 30, 300, 30)),
    sub('compliance:ACME-1#1', 'Review', usage(5, 5, 50, 5)),
    sub('fix:ACME-1#2', 'Build', usage(1, 1, 10, 1)),
  ];
  const T = { input: 100, output: 100, cacheRead: 1000, cacheWrite: 100, turns: 7 };

  it('adds orchestration as the total minus the subagents, in a fixed order', () => {
    const rows = storyAgents({ subagents, total: T, model: 'claude-opus-5-5' });
    expect(rows.map((r) => `${r.role}/${r.name}/${r.round}`)).toEqual([
      'architect/architect/null',
      'orchestration/orchestration/null',
      'builder/build/1',
      'tester/test/1',
      'reviewer/compliance/1',
      'reviewer/security/1',
      'builder/fix/2',
    ]);
    expect(rows.find((r) => r.role === 'orchestration')).toEqual({ role: 'orchestration', name: 'orchestration', agent: null, model: 'claude-opus-5-5', input: 29, output: 29, cacheRead: 290, cacheWrite: 29, turns: 7, round: null });
    expect(rows.find((r) => r.role === 'architect')).toEqual({ role: 'architect', name: 'architect', agent: 'foreman:x', model: 'claude-opus-5-5', input: 20, output: 20, cacheRead: 200, cacheWrite: 20, turns: 1, round: null });
  });

  it('clamps orchestration at 0 when the subagents add up to more', () => {
    const rows = storyAgents({ subagents, total: { input: 1, output: 1000, cacheRead: 1, cacheWrite: 1, turns: 1 }, model: null });
    expect(rows.find((r) => r.role === 'orchestration')).toMatchObject({ input: 0, output: 929, cacheRead: 0, cacheWrite: 0 });
  });

  it('has no orchestration row without a total', () => {
    const rows = storyAgents({ subagents, total: null, model: 'm' });
    expect(rows).toHaveLength(6);
    expect(rows.some((r) => r.role === 'orchestration')).toBe(false);
    expect(storyAgents({ subagents: [], total: null })).toEqual([]);
  });

  it('gives the same order whatever order the subagents come in', () => {
    const a = storyAgents({ subagents, total: T, model: 'm' });
    const b = storyAgents({ subagents: [...subagents].reverse(), total: T, model: 'm' });
    expect(b).toEqual(a);
  });
});
