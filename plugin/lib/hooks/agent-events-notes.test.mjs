// The agent-events hook records on the story itself what a session has finished: the design when
// the architect stops, each round when the tester or a reviewer stops (engine/story-notes.mjs). A
// markdown project, so a note is one progress line in the state folder; the session fixture is
// test/session-fixture.mjs, and the hook runs as a child (test/agent-events-fixture.mjs).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dir, hook, withHookDir } from '../../../test/agent-events-fixture.mjs';
import { markedSession } from '../../../test/session-fixture.mjs';

withHookDir();

const PLAN = { ready: true, blocker: '', needs_owner: false, builder: 'developer', resources: [], files: ['src/orders.mjs'], design: 'Add the order queue.', test_plan: 'orders.test.mjs', done_when: 'npm test' };
const BLOCK = { approved: false, findings: [{ severity: 'blocker', rule: 'the queue drops orders', where: 'src/orders.mjs:9', observed: 'the oldest order is lost', fix: 'keep it' }], checked: 'ran it' };
const STOP = (agent) => JSON.stringify({ hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: agent });
const state = () => join(dir, 'state');

function project(features) {
  mkdirSync(join(dir, 'stories'), { recursive: true });
  writeFileSync(join(dir, 'stories', 'ACME-1.md'), '---\nid: ACME-1\ntitle: Orders\nstatus: todo\n---\n\n## Progress notes\n');
  writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'Acme' }, stories: { adapter: 'markdown', dir: 'stories' }, ...(features ? { features } : {}) }));
}
const notes = () => {
  const file = join(state(), 'stories', 'ACME-1.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).notes.map((n) => n.text) : [];
};
const session = (agents) => markedSession(state(), { slot: 'w1', story: 'ACME-1', agents: agents ?? [{ label: 'architect:ACME-1', output: PLAN }] });
const env = { FOREMAN_RUN: '1', FOREMAN_SLOT: 'w1', FOREMAN_STORY: 'ACME-1' };

describe('the agent-events hook records the session on the story', () => {
  it('adds one Design progress line when the architect stops', () => {
    project();
    session();
    const r = hook(env, STOP('foreman:architect'));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(notes()).toEqual(['Design: The architect chose the developer builder, whose work is: everything.']);
    // The same design again adds nothing.
    hook(env, STOP('foreman:architect'));
    expect(notes()).toHaveLength(1);
  });

  it('adds a round when the tester stops', () => {
    project();
    session([
      { label: 'architect:ACME-1', output: PLAN },
      { label: 'test:ACME-1#1', phase: 'Test', agentType: 'foreman:tester', output: BLOCK },
    ]);
    hook(env, STOP('foreman:tester'));
    expect(notes().map((n) => n.split(':')[0]).reverse()).toEqual(['Design', 'Round 1 sent back']);
  });

  it('adds nothing for a SubagentStart, a builder stopping, or a tool call', () => {
    project();
    session();
    hook(env, JSON.stringify({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'foreman:architect' }));
    hook(env, STOP('foreman:builder'));
    hook(env, JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'TodoWrite', tool_input: {}, agent_id: 'a1', agent_type: 'foreman:architect' }));
    expect(notes()).toEqual([]);
  });

  it('adds nothing with jiraComments off, or outside a Foreman run', () => {
    project({ jiraComments: false });
    session();
    hook(env, STOP('foreman:architect'));
    expect(notes()).toEqual([]);
    project();
    hook({ FOREMAN_RUN: '' }, STOP('foreman:architect'));
    expect(notes()).toEqual([]);
  });

  it('with a broken config still exits 0 and prints nothing', () => {
    project();
    writeFileSync(join(dir, 'foreman.config.json'), '{ not json');
    session();
    const r = hook(env, STOP('foreman:architect'));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(notes()).toEqual([]);
  });

  it('with a session that cannot be read still exits 0 and prints nothing', () => {
    project();
    const r = hook(env, STOP('foreman:architect'));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(notes()).toEqual([]);
  });
});
