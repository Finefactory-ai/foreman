import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EVENTS_ROTATE_BYTES,
  addEvent,
  addToTotals,
  applyHookEvent,
  clearSpans,
  sessionSpans,
  startTotals,
  beat,
  clearAgents,
  describe as describeTool,
  drainingOf,
  endStory,
  finishedAgents,
  modelMismatches,
  modelName,
  reviewerEngines,
  noteLearned,
  plainWords,
  queuedOf,
  rawCommand,
  roleModels,
  ownerWaiting,
  readSlot,
  readState,
  rotateEvents,
  rotatedEventFiles,
  saveState,
  recordResult,
  redact,
  restartPendingOf,
  runningAgents,
  setLoop,
  setSlot,
  setStage,
  setWorkers,
  snapshot,
  stageMap,
  startStory,
  nextWaitOf,
  openNextRequest,
  setNextWait,
  settleNextRequest,
  takeNextRequest,
  waitingOnOwner,
} from './state.mjs';
import { saveLastGood } from './config-health.mjs';
import { loadConfig } from '../config/load.mjs';
import { writePid } from './supervisor-pid.mjs';
import { ownerClaim } from './locks.mjs';

// A child's environment built from scratch: nothing inherited from the shell that Foreman reads.
const cleanEnv = (extra) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(FOREMAN|FACTORY)_/.test(k))),
  ...extra,
});

let dir;
const at = (s) => new Date(`2026-10-14T10:${String(s).padStart(2, '0')}:00Z`);
const story = { id: 'P4-04', title: 'Add the rate limits', phase: '4', phaseName: 'Identity' };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'factory-state-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('what an agent is doing', () => {
  it('describes tool calls in words, with paths relative to the repo', () => {
    expect(describeTool('Bash', { command: 'npm run test:db' })).toBe('$ npm run test:db');
    expect(describeTool('Edit', { file_path: join('/proj', 'src/lib/env.ts') }, '/proj')).toBe('editing src/lib/env.ts');
    expect(describeTool('Workflow', {})).toBe('running the story pipeline');
    expect(describeTool('Mystery', {})).toBe('using Mystery');
  });

  it('never keeps a secret it is shown', () => {
    expect(redact('curl -H "Authorization: Bearer abc.def.ghi" x')).not.toContain('abc.def');
    expect(redact('STRIPE_SECRET_KEY=sk_test_51Habc123456 node x')).not.toContain('sk_test_51Habc');
    expect(redact('token eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiIxIn0.sig')).not.toContain('eyJhbGci');
    expect(describeTool('Bash', { command: 'export SUPABASE_DB_PASSWORD=hunter2 && x' })).not.toContain('hunter2');
  });

  it('keeps lowercase NAME=value secrets and dash keys out too', () => {
    expect(redact('token=abc123')).not.toContain('abc123');
    expect(redact('api_key=zzz999')).not.toContain('zzz999');
    expect(redact('sk-ant-api03-ABCDEFGHIJ')).not.toContain('ABCDEFGHIJ');
  });

  it('keeps a JSON-escaped quoted secret out', () => {
    const json = redact(JSON.stringify({ t: 'ACME_TOKEN="alpha bravo charlie"' }));
    expect(json).toBe('{"t":"ACME_TOKEN=•••"}');
    for (const word of ['alpha', 'bravo', 'charlie']) expect(json).not.toContain(word);
    const open = redact('ACME_TOKEN=\\"alpha bravo ');
    expect(open).not.toContain('alpha');
    expect(open).not.toContain('bravo');
    expect(redact('x ACME_TOKEN="alpha bravo" y')).toBe('x ACME_TOKEN=••• y');
    expect(redact('token=abc123 next')).toBe('token=••• next');
  });

  it('keeps a quoted secret out however many times the JSON was escaped', () => {
    const two = redact(JSON.stringify(JSON.stringify({ t: 'ACME_TOKEN="d1 d2"' })));
    expect(two).toBe(JSON.stringify(JSON.stringify({ t: 'ACME_TOKEN=•••' })));
    expect(two).not.toContain('d1');
    expect(two).not.toContain('d2');
    const thrice = (v) => JSON.stringify(JSON.stringify(JSON.stringify(v)));
    const three = redact(thrice({ t: 'ACME_TOKEN="alpha bravo"' }));
    expect(three).toBe(thrice({ t: 'ACME_TOKEN=•••' }));
    expect(three).not.toContain('alpha');
    expect(three).not.toContain('bravo');
    const open = redact('ACME_TOKEN=\\\\\\"alpha bravo ');
    expect(open).not.toContain('alpha');
    expect(open).not.toContain('bravo');
    expect(redact('ACME_TOKEN=\\\\foo bar')).toBe('ACME_TOKEN=••• bar');
  });
});

describe('the running-agents record', () => {
  it('tracks each agent from start to stop, with its latest step and the current story', () => {
    startStory(dir, story, at(0));
    applyHookEvent(dir, { hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'architect' }, at(1));
    applyHookEvent(dir, { hook_event_name: 'PreToolUse', agent_id: 'a1', agent_type: 'architect', tool_name: 'Read', tool_input: { file_path: 'x.md' } }, at(2), 'w1', process.cwd());
    applyHookEvent(dir, { hook_event_name: 'PreToolUse', tool_name: 'Workflow', tool_input: {} }, at(2));
    const running = runningAgents(dir);
    expect(running.map((a) => [a.role, a.story, a.doing, a.tools])).toEqual([
      ['architect', 'P4-04', 'reading x.md', 1],
      ['foreman', 'P4-04', 'running the story pipeline', 1],
    ]);
    applyHookEvent(dir, { hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'architect' }, at(9));
    expect(runningAgents(dir).map((a) => a.role)).toEqual(['foreman']);
  });

  it('counts a build round each time the tester starts', () => {
    startStory(dir, story, at(0));
    applyHookEvent(dir, { hook_event_name: 'SubagentStart', agent_id: 't1', agent_type: 'tester' }, at(1));
    applyHookEvent(dir, { hook_event_name: 'SubagentStart', agent_id: 't2', agent_type: 'tester' }, at(5));
    expect(readSlot(dir, 'w1').story.rounds).toBe(2);
  });

  it('counts every agent start, step and finish as slot activity (the watchdog reads it)', () => {
    // Seen on a real run: agent files go when an agent finishes, so between two stages the
    // newest activity left was the pipeline call from the start; slots were stopped as quiet.
    applyHookEvent(dir, { hook_event_name: 'SubagentStart', agent_id: 'r1', agent_type: 'security-reviewer' }, at(10), 'w3');
    expect(readSlot(dir, 'w3').lastBeat).toBe(at(10).toISOString());
    applyHookEvent(dir, { hook_event_name: 'PreToolUse', agent_id: 'r1', agent_type: 'security-reviewer', tool_name: 'Read', tool_input: {} }, at(20), 'w3');
    expect(readSlot(dir, 'w3').lastBeat).toBe(at(20).toISOString());
    applyHookEvent(dir, { hook_event_name: 'SubagentStop', agent_id: 'r1', agent_type: 'security-reviewer' }, at(41), 'w3');
    expect(runningAgents(dir, 'w3')).toHaveLength(0);
    expect(readSlot(dir, 'w3').lastBeat).toBe(at(41).toISOString());
  });
});

describe('the review relay on the page', () => {
  const config = { roles: { reviewers: [
    { name: 'compliance', agent: 'foreman:compliance-reviewer', engine: { name: 'antigravity', model: 'claude-opus-4-6-thinking' } },
    { name: 'security', agent: 'foreman:security-reviewer' },
  ] } };

  it('records which reviewer a relay carries, from the file it writes or the foreman review command', () => {
    startStory(dir, story, at(0));
    applyHookEvent(dir, { hook_event_name: 'SubagentStart', agent_id: 'r1', agent_type: 'foreman:review-relay' }, at(1));
    expect(runningAgents(dir)[0].reviewer).toBeUndefined();
    applyHookEvent(dir, { hook_event_name: 'PreToolUse', agent_id: 'r1', agent_type: 'foreman:review-relay', tool_name: 'Write', tool_input: { file_path: '/tmp/x/foreman-review-compliance.md', content: 'x' } }, at(2));
    expect(runningAgents(dir)[0].reviewer).toBe('compliance');
    applyHookEvent(dir, { hook_event_name: 'SubagentStart', agent_id: 'r2', agent_type: 'review-relay' }, at(3));
    applyHookEvent(dir, { hook_event_name: 'PreToolUse', agent_id: 'r2', agent_type: 'review-relay', tool_name: 'Bash', tool_input: { command: 'foreman review --start --reviewer security --prompt /tmp/x/foreman-review-security.md --chars 1200' } }, at(4));
    expect(runningAgents(dir).map((a) => [a.id, a.reviewer])).toEqual([['r1', 'compliance'], ['r2', 'security']]);
    // A later wait keeps the name, and a reviewer is never taken from another agent's command.
    applyHookEvent(dir, { hook_event_name: 'PreToolUse', agent_id: 'r2', agent_type: 'review-relay', tool_name: 'Bash', tool_input: { command: 'foreman review --wait abc123 --for 540' } }, at(5));
    applyHookEvent(dir, { hook_event_name: 'SubagentStart', agent_id: 't1', agent_type: 'tester' }, at(6));
    applyHookEvent(dir, { hook_event_name: 'PreToolUse', agent_id: 't1', agent_type: 'tester', tool_name: 'Bash', tool_input: { command: 'foreman review --start --reviewer security --prompt p --chars 1' } }, at(7));
    const byId = Object.fromEntries(runningAgents(dir).map((a) => [a.id, a.reviewer]));
    expect(byId).toEqual({ r1: 'compliance', r2: 'security', t1: undefined, foreman: undefined });
  });

  it('shows the relay as the reviewer it carries, with the engine the config sets for it', async () => {
    startStory(dir, story, at(0));
    writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'Acme' }, ...config }));
    applyHookEvent(dir, { hook_event_name: 'SubagentStart', agent_id: 'r1', agent_type: 'foreman:review-relay' }, at(1));
    applyHookEvent(dir, { hook_event_name: 'PreToolUse', agent_id: 'r1', agent_type: 'foreman:review-relay', tool_name: 'Write', tool_input: { file_path: '/tmp/x/foreman-review-compliance.md' } }, at(2));
    applyHookEvent(dir, { hook_event_name: 'SubagentStart', agent_id: 'r2', agent_type: 'foreman:review-relay' }, at(3));
    const agents = (await snapshot(dir, at(4), null, { root: dir })).slots[0].agents;
    const r1 = agents.find((a) => a.id === 'r1');
    expect(r1.relay).toEqual({ reviewer: 'compliance', agent: 'foreman:compliance-reviewer', engine: { name: 'antigravity', model: 'claude-opus-4-6-thinking' } });
    expect(r1.stage).toBe('review');
    expect(agents.find((a) => a.id === 'r2').relay).toBeUndefined();
    expect(Object.hasOwn(agents.find((a) => a.id === 'r2'), 'relay')).toBe(false);
  });

  it('maps each reviewer with an engine to it, for the page', () => {
    expect(reviewerEngines(config)).toEqual({ compliance: { agent: 'foreman:compliance-reviewer', engine: { name: 'antigravity', model: 'claude-opus-4-6-thinking' } } });
    expect(reviewerEngines(null)).toEqual({});
    expect(reviewerEngines({ roles: { reviewers: 'nope' } })).toEqual({});
  });
});

describe('the stage each agent stands for', () => {
  const config = {
    roles: {
      architect: { agent: 'foreman:architect' },
      builders: { developer: { agent: 'foreman:builder' }, ui: { agent: 'acme:ui-builder' }, sql: { agent: 'policy-author' } },
      tester: { agent: 'qa' },
      reviewers: [
        { name: 'compliance', agent: 'foreman:compliance-reviewer' },
        { name: 'a11y', agent: 'acme:a11y' },
      ],
    },
  };

  it('maps configured agents to architect, build, test and review, with and without a plugin prefix', () => {
    const map = stageMap(config);
    expect(map['foreman:architect']).toBe('architect');
    expect(map.architect).toBe('architect');
    expect(map['foreman:builder']).toBe('build');
    expect(map.builder).toBe('build');
    expect(map['acme:ui-builder']).toBe('build');
    expect(map['ui-builder']).toBe('build');
    expect(map['policy-author']).toBe('build');
    expect(map['foreman:policy-author']).toBe('build');
    expect(map.qa).toBe('test');
    expect(map['foreman:qa']).toBe('test');
    expect(map['compliance-reviewer']).toBe('review');
    expect(map['acme:a11y']).toBe('review');
    expect(map.a11y).toBe('review');
    expect(map.developer).toBeUndefined();
    expect(map['foreman:review-relay']).toBe('review');
  });

  it('falls back to the default roles without a config', () => {
    const map = stageMap(null);
    expect(map).toMatchObject({ architect: 'architect', 'foreman:builder': 'build', tester: 'test', 'foreman:security-reviewer': 'review' });
  });

  it('counts a build round when the configured tester starts, whatever it is called', () => {
    startStory(dir, story, at(0));
    const map = stageMap(config);
    applyHookEvent(dir, { hook_event_name: 'SubagentStart', agent_id: 'q1', agent_type: 'foreman:qa' }, at(1), 'w1', dir, map);
    applyHookEvent(dir, { hook_event_name: 'SubagentStart', agent_id: 't1', agent_type: 'tester' }, at(2), 'w1', dir, map);
    expect(readSlot(dir, 'w1').story.rounds).toBe(1);
  });

  it('shows the running agent\'s stage on the page', async () => {
    startStory(dir, story, at(0));
    const map = stageMap(config);
    applyHookEvent(dir, { hook_event_name: 'SubagentStart', agent_id: 'u1', agent_type: 'acme:ui-builder' }, at(1), 'w1', dir, map);
    const snap = await snapshot(dir, at(2), map, { root: dir });
    expect(snap.slots[0].story.stage).toBe('build');
  });
});

describe('stories and the loop', () => {
  it('keeps a finished story\'s result, with its pull request, for the supervisor', () => {
    startStory(dir, story, at(0));
    setStage(dir, 'release', 'https://github.com/o/r/pull/30', at(3));
    endStory(dir, 'shipped', '', '', at(7));
    const slot = readSlot(dir, 'w1');
    expect(slot.story).toBeNull();
    expect(slot.result).toMatchObject({ id: 'P4-04', result: 'shipped', pr: 'https://github.com/o/r/pull/30', slot: 'w1' });
  });

  it('records the cause of a failed end, and only then', () => {
    startStory(dir, story, at(0));
    endStory(dir, 'failed', '', 'CI never started', at(3), 'w1', { cause: 'environment' });
    expect(readSlot(dir, 'w1').result).toMatchObject({ id: 'P4-04', result: 'failed', cause: 'environment' });
    startStory(dir, story, at(4));
    endStory(dir, 'failed', '', '', at(5), 'w1', { cause: 'story' });
    expect(readSlot(dir, 'w1').result.cause).toBe('story');
    startStory(dir, story, at(6));
    endStory(dir, 'failed', '', '', at(7), 'w1');
    expect(readSlot(dir, 'w1').result).not.toHaveProperty('cause');
    startStory(dir, story, at(8));
    endStory(dir, 'failed', '', '', at(9), 'w1', { cause: 'banana' });
    expect(readSlot(dir, 'w1').result).not.toHaveProperty('cause');
    startStory(dir, story, at(10));
    endStory(dir, 'shipped', '', '', at(11), 'w1', { cause: 'environment' });
    expect(readSlot(dir, 'w1').result).not.toHaveProperty('cause');
  });

  it('records the loop state once per change', () => {
    setLoop(dir, 'running', '', at(0));
    setLoop(dir, 'running', '', at(1));
    setLoop(dir, 'paused', 'paused from the command centre', at(2));
    expect(readState(dir).loop).toMatchObject({ state: 'paused', reason: 'paused from the command centre' });
  });

  it('standby is one info event, not one per tick', async () => {
    const { STANDBY } = await import('./scheduler.mjs');
    setLoop(dir, 'standby', STANDBY, at(0));
    setLoop(dir, 'standby', STANDBY, at(1));
    expect(readState(dir).loop).toMatchObject({ state: 'standby', reason: STANDBY });
    const events = readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(events.map((e) => [e.text, e.kind])).toEqual([['Factory standby: Nothing to build; picks up new stories automatically.', 'info']]);
  });
});

describe('slots', () => {
  it('keeps each slot in its own file', () => {
    startStory(dir, story, at(1), 'w1');
    startStory(dir, { ...story, id: 'P7-02' }, at(1), 'w2');
    setStage(dir, 'build', '', at(2), 'w1');
    expect(readSlot(dir, 'w1').story.stage).toBe('build');
    expect(readSlot(dir, 'w2').story.stage).toBe('architect');
    expect(readState(dir).current).toBeUndefined();
  });
  it('marks the commit time and the wait for the ship lock', () => {
    startStory(dir, story, at(1), 'w1');
    setStage(dir, 'commit', '', at(5), 'w1');
    expect(readSlot(dir, 'w1').story.committedAt).toBe(at(5).toISOString());
    setStage(dir, 'release', 'waiting for the ship lock', at(6), 'w1');
    expect(readSlot(dir, 'w1').state).toBe('waiting');
    setStage(dir, 'release', 'pushing the branch', at(7), 'w1');
    expect(readSlot(dir, 'w1').state).toBe('building');
  });
  it('leaves the result for the supervisor and clears the story', () => {
    startStory(dir, story, at(1), 'w1');
    endStory(dir, 'shipped', 'https://x/pr/1', 'live', at(9), 'w1');
    expect(readSlot(dir, 'w1')).toMatchObject({ story: null, result: { id: 'P4-04', result: 'shipped' } });
    expect(readState(dir).recent ?? []).toEqual([]);
    recordResult(dir, readSlot(dir, 'w1').result);
    expect(readState(dir).recent[0].id).toBe('P4-04');
  });
  it('files agents under their slot, so two foremen do not collide', () => {
    applyHookEvent(dir, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }, at(1), 'w1');
    applyHookEvent(dir, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'x' } }, at(1), 'w2');
    expect(runningAgents(dir, 'w1')).toHaveLength(1);
    expect(runningAgents(dir, 'w2')).toHaveLength(1);
    clearAgents(dir, 'w1');
    expect(runningAgents(dir, 'w1')).toHaveLength(0);
    expect(runningAgents(dir, 'w2')).toHaveLength(1);
    clearAgents(dir);
    expect(runningAgents(dir, 'w2')).toHaveLength(0);
  });
  it('counts every agent start, step and finish as slot activity (the watchdog reads it)', () => {
    applyHookEvent(dir, { hook_event_name: 'SubagentStart', agent_id: 'r1', agent_type: 'security-reviewer' }, at(10), 'w3');
    applyHookEvent(dir, { hook_event_name: 'SubagentStop', agent_id: 'r1', agent_type: 'security-reviewer' }, at(41), 'w3');
    expect(runningAgents(dir, 'w3')).toHaveLength(0);
    expect(readSlot(dir, 'w3').lastBeat).toBe(at(41).toISOString());
  });
  it('a stage change is progress; the repeated wait for the ship lock is not', () => {
    startStory(dir, story, at(1), 'w1');
    setStage(dir, 'build', '', at(2), 'w1');
    expect(readSlot(dir, 'w1').story.progressAt).toBe(at(2).toISOString());
    setStage(dir, 'release', 'waiting for the ship lock', at(3), 'w1');
    expect(readSlot(dir, 'w1').story.progressAt).toBe(at(3).toISOString());
    setStage(dir, 'release', 'waiting for the ship lock', at(4), 'w1');
    expect(readSlot(dir, 'w1').story.progressAt).toBe(at(3).toISOString());
    setStage(dir, 'release', 'pushing the branch', at(5), 'w1');
    expect(readSlot(dir, 'w1').story.progressAt).toBe(at(5).toISOString());
  });
  it('an agent start or finish is progress; a tool step is activity only', () => {
    startStory(dir, story, at(1), 'w1');
    applyHookEvent(dir, { hook_event_name: 'SubagentStart', agent_id: 't1', agent_type: 'tester' }, at(2), 'w1', dir, { tester: 'test' });
    expect(readSlot(dir, 'w1').story).toMatchObject({ progressAt: at(2).toISOString(), rounds: 1 });
    applyHookEvent(dir, { hook_event_name: 'PreToolUse', agent_id: 't1', agent_type: 'tester', tool_name: 'Read', tool_input: {} }, at(3), 'w1', dir, { tester: 'test' });
    expect(readSlot(dir, 'w1').story.progressAt).toBe(at(2).toISOString());
    expect(readSlot(dir, 'w1').lastBeat).toBe(at(3).toISOString());
    applyHookEvent(dir, { hook_event_name: 'SubagentStop', agent_id: 't1', agent_type: 'tester' }, at(4), 'w1', dir, { tester: 'test' });
    expect(readSlot(dir, 'w1').story).toMatchObject({ progressAt: at(4).toISOString(), rounds: 1 });
  });
  it('records a heartbeat', () => {
    beat(dir, 'w3', at(7));
    expect(readSlot(dir, 'w3').lastBeat).toBe(at(7).toISOString());
  });
  it('sends the page one lane per worker, with the buttons for its state', async () => {
    setWorkers(dir, 2);
    startStory(dir, story, at(1), 'w2');
    const snap = await snapshot(dir, at(3), null, { root: dir });
    expect(snap.slots.map((s) => [s.id, s.state, s.story?.id ?? null])).toEqual([
      ['w1', 'idle', null],
      ['w2', 'building', 'P4-04'],
    ]);
    expect(snap.slots[1].actions).toEqual(['skip', 'takeover', 'park']);
    expect(snap.current).toBeUndefined();
  });
});

describe('draining after workers was lowered', () => {
  const running = { state: 'running', reason: '' };
  const slotsIn = (...states) => states.map((state, i) => ({ id: `w${i + 1}`, state }));
  it('says how many run over the limit, counting building and waiting slots', () =>
    expect(drainingOf({ loop: running, workers: 3, slots: slotsIn('building', 'building', 'waiting', 'building', 'idle') })).toEqual({
      running: 4,
      limit: 3,
      text: '4 running, limit 3: draining',
    }));
  it('is null at the limit', () => expect(drainingOf({ loop: running, workers: 3, slots: slotsIn('building', 'waiting', 'building', 'idle', 'idle') })).toBeNull());
  it('is null for a stopped run', () =>
    expect(drainingOf({ loop: { state: 'stopped', reason: '' }, workers: 3, slots: slotsIn('building', 'building', 'waiting', 'building') })).toBeNull());
  it('does not count held, parked or down slots', () => {
    expect(drainingOf({ loop: running, workers: 3, slots: slotsIn('building', 'building', 'building', 'held', 'parked') })).toBeNull();
    expect(drainingOf({ loop: running, workers: 3, slots: slotsIn('building', 'building', 'building', 'down') })).toBeNull();
  });

  it('is in the snapshot while more than the limit run, and gone at the limit', async () => {
    setWorkers(dir, 3);
    setLoop(dir, 'running', '');
    for (const [n, slot] of [[1, 'w1'], [2, 'w2'], [3, 'w4'], [4, 'w5']]) startStory(dir, { id: `ACME-${n}`, title: `Acme ${n}` }, at(1), slot);
    const snap = await snapshot(dir, at(3), {}, { root: dir, slots: 5 });
    expect(snap.slots.map((s) => [s.id, s.state])).toEqual([
      ['w1', 'building'],
      ['w2', 'building'],
      ['w3', 'idle'],
      ['w4', 'building'],
      ['w5', 'building'],
    ]);
    expect(snap.draining).toEqual({ running: 4, limit: 3, text: '4 running, limit 3: draining' });
    endStory(dir, 'shipped', '', '', at(4), 'w5');
    setSlot(dir, 'w5', { state: 'idle' }, at(4));
    expect((await snapshot(dir, at(5), {}, { root: dir, slots: 5 })).draining).toBeNull();
  });
});

describe('queued work, in words', () => {
  const running = { state: 'running', reason: '' };
  const slotsIn = (...states) => states.map((state, i) => ({ id: `w${i + 1}`, state }));
  const shown = slotsIn('idle', 'building', 'building');
  const of = (queued, slots = shown) => queuedOf({ loop: running, queued, workers: 3, slots });

  it('says a story queued for a slot over the worker count waits for one under it, and names an idle one', () => {
    expect(of([{ id: 'ACME-4', slot: null, from: 'w4', mode: '' }])).toEqual([
      { id: 'ACME-4', slot: null, from: 'w4', mode: '', text: 'ACME-4 queued for w4, which is over the worker count; w1 takes it next' },
    ]);
  });
  it('says the next slot to free up takes it when no slot under the limit is idle', () => {
    const [q] = of([{ id: 'ACME-4', slot: null, from: 'w4' }], slotsIn('building', 'building', 'building', 'idle'));
    expect(q.text).toBe('ACME-4 queued for w4, which is over the worker count; the next slot under the worker count to free up takes it');
  });
  it('describes work still pinned above the count as over it too', () => {
    expect(of([{ id: 'ACME-4', slot: 'w5' }])[0].text).toBe('ACME-4 queued for w5, which is over the worker count; w1 takes it next');
    expect(of([{ id: 'ACME-4', slot: 'nowhere' }])[0].text).toContain('queued for nowhere, which is over the worker count');
  });
  it('names the slot work is pinned to when it is under the count', () => {
    expect(of([{ id: 'ACME-4', slot: 'w2' }])[0].text).toBe('ACME-4 queued for w2');
  });
  it('says work for any slot is taken by the next idle one', () => {
    expect(of([{ id: 'ACME-4', slot: null }])[0].text).toBe('ACME-4 queued; w1 takes it next');
    expect(of([{ id: 'ACME-4' }])[0]).toMatchObject({ slot: null, from: null, mode: '' });
  });
  it('does not call the slot a story came from over the count when it is under it', () => {
    expect(of([{ id: 'ACME-4', slot: null, from: 'w2', mode: '' }])[0].text).toBe('ACME-4 queued; w1 takes it next');
  });
  it('says a start-up resume starts by priority, and names the slot it was in only when that is over the count', () => {
    expect(of([{ id: 'ACME-4', slot: null, from: 'w2', ranked: true }])[0].text).toBe('ACME-4 queued to resume; it starts by priority when a slot under the worker count is free');
    expect(of([{ id: 'ACME-4', slot: null, from: null, ranked: true }])[0].text).toBe('ACME-4 queued to resume; it starts by priority when a slot under the worker count is free');
    expect(of([{ id: 'ACME-4', slot: null, from: 'w4', ranked: true }])[0].text).toBe('ACME-4 queued to resume (it was in w4, over the worker count); it starts by priority when a slot under the worker count is free');
  });
  it('is empty for a stopped run, for anything that is not a list and for items with no id', () => {
    expect(queuedOf({ loop: { state: 'stopped' }, queued: [{ id: 'ACME-4' }], workers: 3, slots: shown })).toEqual([]);
    for (const bad of [undefined, null, 'ACME-4', { id: 'ACME-4' }]) expect(of(bad)).toEqual([]);
    expect(of([{ slot: 'w1' }, null, { id: 7 }, { id: 'ACME-5' }]).map((q) => q.id)).toEqual(['ACME-5']);
  });

  it('is in the snapshot, built from the queued list in state.json', async () => {
    setWorkers(dir, 3);
    setLoop(dir, 'running', '', at(1));
    startStory(dir, { id: 'ACME-1', title: 'Acme 1' }, at(1), 'w1');
    startStory(dir, { id: 'ACME-2', title: 'Acme 2' }, at(1), 'w2');
    const file = join(dir, 'state.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), queued: [{ id: 'ACME-4', slot: null, from: 'w4', mode: '' }] }));
    const snap = await snapshot(dir, at(3), {}, { root: dir, slots: 5 });
    expect(snap.queued).toEqual([
      { id: 'ACME-4', slot: null, from: 'w4', mode: '', text: 'ACME-4 queued for w4, which is over the worker count; w3 takes it next' },
    ]);
    setLoop(dir, 'stopped', 'Stopped on request.', at(4));
    expect((await snapshot(dir, at(4), {}, { root: dir, slots: 5 })).queued).toEqual([]);
  });
});

describe('stories waiting on running stories, in the snapshot', () => {
  it('lists a story whose wait names a file a running story holds, and drops it once the file is free', async () => {
    const { FILE_LOCK, writeWait } = await import('./file-locks.mjs');
    const { forceSet } = await import('./locks.mjs');
    writeWait(dir, 'ACME-2', [{ story: 'ACME-1', slot: 'w1', files: ['src/a.mjs'] }], at(1));
    forceSet(FILE_LOCK(dir, 'src/a.mjs'), { pid: process.pid, slot: 'w1', story: 'ACME-1', by: 'factory', at: at(1).toISOString(), path: 'src/a.mjs' });
    const snap = await snapshot(dir, at(3), {}, { root: dir, slots: 5 });
    expect(snap.fileWaits).toEqual([
      { id: 'ACME-2', on: [{ story: 'ACME-1', files: ['src/a.mjs'], resources: [], deferrals: 1 }], text: 'ACME-2 waits for ACME-1: src/a.mjs' },
    ]);
    rmSync(FILE_LOCK(dir, 'src/a.mjs'));
    expect((await snapshot(dir, at(4), {}, { root: dir, slots: 5 })).fileWaits).toEqual([]);
  });
});

describe('stories waiting on a running story through its saved design, in the snapshot', () => {
  it('names the story whose design holds the file, and drops it once that story is gone', async () => {
    const { writeWait } = await import('./file-locks.mjs');
    const { claimFile, forceSet } = await import('./locks.mjs');
    const { PLAN_FILE } = await import('./plan-file.mjs');
    writeWait(dir, 'ACME-2', [{ story: 'ACME-9', slot: 'w9', files: ['src/a.mjs'] }], at(1), ['src/a.mjs']);
    forceSet(claimFile(dir, 'ACME-1'), { pid: process.pid, slot: 'w1', story: 'ACME-1', by: 'factory', at: at(1).toISOString() });
    mkdirSync(join(dir, 'plans'), { recursive: true });
    writeFileSync(PLAN_FILE(dir, 'ACME-1'), JSON.stringify({ files: ['src/a.mjs'] }));
    const snap = await snapshot(dir, at(3), {}, { root: dir, slots: 5 });
    expect(snap.fileWaits).toEqual([
      { id: 'ACME-2', on: [{ story: 'ACME-1', files: ['src/a.mjs'], resources: [], deferrals: 0 }], text: 'ACME-2 waits for ACME-1: src/a.mjs' },
    ]);
    rmSync(claimFile(dir, 'ACME-1'));
    expect((await snapshot(dir, at(4), {}, { root: dir, slots: 5 })).fileWaits).toEqual([]);
  });
});

describe('a queued check, in the snapshot', () => {
  it('gives the slot a checkWait while a live run of it waits for a free check slot, and no key without one', async () => {
    const { enterRun, processStart, setRun } = await import('./check-slots.mjs');
    setWorkers(dir, 2);
    setLoop(dir, 'running', '');
    startStory(dir, { id: 'ACME-1', title: 'Acme 1' }, at(1), 'w1');
    startStory(dir, { id: 'ACME-2', title: 'Acme 2' }, at(1), 'w2');
    const none = await snapshot(dir, at(3), {}, { root: dir, slots: 2 });
    expect(none.slots.every((s) => !('checkWait' in s))).toBe(true);
    const { entry } = enterRun(dir, { pid: process.pid, script: process.argv[1], started: processStart(process.pid), slot: 'w1', story: 'ACME-1', tree: 'aaa', at: at(2).toISOString(), state: 'started', since: at(2).toISOString() });
    expect((await snapshot(dir, at(3), {}, { root: dir, slots: 2 })).slots.every((s) => !('checkWait' in s))).toBe(true);
    setRun(dir, entry, { state: 'queued', since: at(2).toISOString() });
    const snap = await snapshot(dir, at(3), {}, { root: dir, slots: 2 });
    expect(snap.slots[0].checkWait).toEqual({ since: at(2).toISOString(), text: 'check queued: waiting for a free check slot' });
    expect('checkWait' in snap.slots[1]).toBe(false);
  });

  it('shows no wait for a queued run whose process is gone', async () => {
    const { enterRun, setRun } = await import('./check-slots.mjs');
    setWorkers(dir, 1);
    startStory(dir, { id: 'ACME-1', title: 'Acme 1' }, at(1), 'w1');
    const { entry } = enterRun(dir, { pid: 999999999, script: '/p/main.mjs', slot: 'w1', story: 'ACME-1', tree: 'aaa', at: at(2).toISOString(), state: 'started', since: at(2).toISOString() });
    setRun(dir, entry, { state: 'queued' });
    const snap = await snapshot(dir, at(3), {}, { root: dir, slots: 1 });
    expect('checkWait' in snap.slots[0]).toBe(false);
  });
});

describe('who stopped the run, in the snapshot', () => {
  it('reads service-stopped first, then STOP, with the words to show', async () => {
    expect((await snapshot(dir, at(3), null, { root: dir })).stoppedBy).toBeNull();
    writeFileSync(join(dir, 'STOP'), `${JSON.stringify({ at: '2026-10-14T10:02:00.000Z', via: 'cli', run: false })}\n`);
    expect((await snapshot(dir, at(3), null, { root: dir })).stoppedBy).toEqual({ at: '2026-10-14T10:02:00.000Z', via: 'cli', run: false, text: 'your terminal at 10:02 UTC' });
    writeFileSync(join(dir, 'service-stopped'), `${JSON.stringify({ at: '2026-10-14T04:01:15.000Z', via: 'unknown', run: true, story: 'ACME-9', slot: 'w2' })}\n`);
    expect((await snapshot(dir, at(3), null, { root: dir })).stoppedBy).toEqual({ at: '2026-10-14T04:01:15.000Z', via: 'unknown', run: true, story: 'ACME-9', slot: 'w2', text: "ACME-9's session at 04:01 UTC" });
  });

  // FM-284: once the supervisor has taken STOP it keeps the record in last-stop, so a cloud run's
  // stop stays named; STOP and service-stopped, when there, still win.
  it('reads last-stop when there is neither service-stopped nor STOP', async () => {
    writeFileSync(join(dir, 'last-stop'), `${JSON.stringify({ at: '2026-10-14T09:30:00.000Z', via: 'cloud' })}\n`);
    expect((await snapshot(dir, at(3), null, { root: dir })).stoppedBy).toEqual({ at: '2026-10-14T09:30:00.000Z', via: 'cloud', text: 'the cloud runner at 09:30 UTC' });
    writeFileSync(join(dir, 'STOP'), `${JSON.stringify({ at: '2026-10-14T10:02:00.000Z', via: 'cli', run: false })}\n`);
    expect((await snapshot(dir, at(3), null, { root: dir })).stoppedBy.text).toBe('your terminal at 10:02 UTC');
    writeFileSync(join(dir, 'service-stopped'), `${JSON.stringify({ at: '2026-10-14T04:01:15.000Z', via: 'unknown', run: true, story: 'ACME-9' })}\n`);
    expect((await snapshot(dir, at(3), null, { root: dir })).stoppedBy.text).toBe("ACME-9's session at 04:01 UTC");
  });

  it('reads an old ISO-only marker as an unknown process', async () => {
    writeFileSync(join(dir, 'service-stopped'), '2026-10-14T04:01:15.000Z\n');
    expect((await snapshot(dir, at(3), null, { root: dir })).stoppedBy).toEqual({ at: '2026-10-14T04:01:15.000Z', text: 'an unknown process at 04:01 UTC' });
  });
});

describe('the learned items a story was exposed to', () => {
  const acme = { id: 'ACME-1', title: 'Add the invoices', phase: '1', phaseName: 'Billing' };
  const slotText = () => readFileSync(join(dir, 'slots', 'w1.json'), 'utf8');

  it('adds the ids of each call to the story, sorted and once each', () => {
    startStory(dir, acme, at(1), 'w1');
    noteLearned(dir, 'w1', 'ACME-1', ['L-3', 'L-1'], at(2));
    noteLearned(dir, 'w1', 'ACME-1', ['L-1', 'L-2'], at(3));
    expect(readSlot(dir, 'w1').story.learned).toEqual(['L-1', 'L-2', 'L-3']);
  });

  it('writes nothing for another story, with no story started, or with no ids', () => {
    noteLearned(dir, 'w1', 'ACME-1', ['L-1'], at(1));
    expect(existsSync(join(dir, 'slots', 'w1.json'))).toBe(false);
    startStory(dir, acme, at(1), 'w1');
    const before = slotText();
    noteLearned(dir, 'w1', 'ACME-2', ['L-1'], at(2));
    noteLearned(dir, 'w1', 'ACME-1', [], at(2));
    expect(slotText()).toBe(before);
  });

  it('carries the ids into the result, [] when none were noted, and a new story starts with none', () => {
    startStory(dir, acme, at(1), 'w1');
    noteLearned(dir, 'w1', 'ACME-1', ['L-2'], at(2));
    endStory(dir, 'shipped', '', '', at(3), 'w1');
    expect(readSlot(dir, 'w1').result.learned).toEqual(['L-2']);
    startStory(dir, { ...acme, id: 'ACME-2' }, at(4), 'w1');
    expect(readSlot(dir, 'w1').story.learned).toBeUndefined();
    endStory(dir, 'failed', '', '', at(5), 'w1');
    expect(readSlot(dir, 'w1').result.learned).toEqual([]);
  });
});

describe('an interrupted story', () => {
  const acme = { id: 'ACME-1', title: 'Add the invoices', phase: '1', phaseName: 'Billing' };
  const events = () => readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  it('ends as interrupted, with an info event, not a warning', () => {
    startStory(dir, acme, at(1), 'w1');
    endStory(dir, 'interrupted', '', 'stopped with the run; it resumes at the next start', at(2), 'w1');
    const done = readSlot(dir, 'w1').result;
    expect(done).toMatchObject({ id: 'ACME-1', result: 'interrupted' });
    recordResult(dir, done);
    expect(readState(dir).recent[0]).toMatchObject({ id: 'ACME-1', result: 'interrupted' });
    expect(events().at(-1)).toMatchObject({ text: 'ACME-1 interrupted: stopped with the run; it resumes at the next start', kind: 'info' });
  });
  it('still warns for a failed story and calls a shipped one good', () => {
    startStory(dir, acme, at(1), 'w1');
    endStory(dir, 'failed', '', 'x', at(2), 'w1');
    expect(events().at(-1).kind).toBe('warn');
    startStory(dir, { ...acme, id: 'ACME-2' }, at(3), 'w1');
    endStory(dir, 'shipped', '', '', at(4), 'w1');
    expect(events().at(-1).kind).toBe('good');
  });
});

describe('the command line', () => {
  it('prints the snapshot (the slot modules import this file; that must not deadlock)', () => {
    const r = spawnSync('node', ['plugin/lib/engine/state.mjs', 'snapshot'], { encoding: 'utf8', timeout: 20_000, env: cleanEnv({ FOREMAN_STATE_DIR: dir }) });
    expect(r.stderr).not.toContain('unsettled top-level await');
    expect(JSON.parse(r.stdout).slots[0].id).toBe('w1');
  });
});

describe('the default slot', () => {
  it.each(['w1', 'w2'])('is the one FOREMAN_SLOT names (%s), so the tests hold in any slot', (slot) => {
    const r = spawnSync('node', ['plugin/lib/engine/state.mjs', 'beat'], { encoding: 'utf8', timeout: 20_000, env: cleanEnv({ FOREMAN_STATE_DIR: dir, FOREMAN_SLOT: slot }) });
    expect(r.status).toBe(0);
    expect(readSlot(dir, slot).lastBeat).toBeTruthy();
  });
});

describe('a "build this next" request from the page', () => {
  const control = (c) => writeFileSync(join(dir, 'control.json'), JSON.stringify(c));

  it('is honoured once, and only for a story that can be built now', () => {
    control({ nextStory: 'P4-11', requestedAt: '2026-10-14T10:00:00Z' });
    expect(takeNextRequest(dir, (id) => id === 'P4-11')).toBe('P4-11');
    expect(takeNextRequest(dir, (id) => id === 'P4-11')).toBe('');
    control({ nextStory: 'P8-02', requestedAt: '2026-10-14T10:05:00Z' });
    expect(takeNextRequest(dir, () => false)).toBe('');
  });

  it('ignores anything that is not a story id', () => {
    control({ nextStory: 'P4-11; rm -rf /', requestedAt: '2026-10-14T10:00:00Z' });
    expect(takeNextRequest(dir, () => true)).toBe('');
  });

  describe('that stays open until its story has started', () => {
    const events = () => (existsSync(join(dir, 'events.jsonl')) ? readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
    const ask = (id = 'ACME-2', requestedAt = '2026-10-30T10:00:00.000Z') => control({ nextStory: id, requestedAt });

    it('is read without being consumed', () => {
      ask();
      expect(openNextRequest(dir)).toEqual({ id: 'ACME-2', at: '2026-10-30T10:00:00.000Z' });
      expect(openNextRequest(dir)).toEqual({ id: 'ACME-2', at: '2026-10-30T10:00:00.000Z' });
      expect(readState(dir).handledNextAt).toBeUndefined();
      expect(events()).toEqual([]);
    });

    it('is settled once as started, with one event', () => {
      ask();
      const req = openNextRequest(dir);
      expect(settleNextRequest(dir, req, 'started', at(1))).toBe(true);
      expect(settleNextRequest(dir, req, 'started', at(2))).toBe(false);
      expect(events().map((e) => [e.kind, e.text])).toEqual([['info', 'You asked for ACME-2 next; starting it.']]);
      expect(readState(dir).handledNextAt).toBe(req.at);
      expect(openNextRequest(dir)).toBeNull();
    });

    it('is settled as refused with the warning and no "starting it" event', () => {
      ask('ACME-3');
      expect(settleNextRequest(dir, openNextRequest(dir), 'refused', at(1))).toBe(true);
      expect(events().map((e) => [e.kind, e.text])).toEqual([['warn', 'You asked for ACME-3 next, but it cannot be built yet; the factory carries on in order.']]);
      expect(openNextRequest(dir)).toBeNull();
    });

    it('keeps a wait only for the request that is open', () => {
      ask();
      const req = openNextRequest(dir);
      const wait = { id: 'ACME-2', at: req.at, since: at(1).toISOString(), tries: 3, reason: 'could not fetch origin/main' };
      expect(nextWaitOf(dir)).toBeNull();
      setNextWait(dir, wait);
      expect(nextWaitOf(dir)).toEqual(wait);
      setNextWait(dir, null);
      expect(nextWaitOf(dir)).toBeNull();
      expect(readState(dir)).not.toHaveProperty('nextWait');

      setNextWait(dir, wait);
      ask('ACME-2', '2026-10-30T10:05:00.000Z');
      expect(nextWaitOf(dir)).toBeNull();
      ask();
      expect(nextWaitOf(dir)).toEqual(wait);
      settleNextRequest(dir, openNextRequest(dir), 'started', at(2));
      expect(nextWaitOf(dir)).toBeNull();
      expect(readState(dir)).not.toHaveProperty('nextWait');
    });

    it('is listed on Waiting on you while its wait stands, and not after it started', async () => {
      const state = join(dir, 'state');
      mkdirSync(state, { recursive: true });
      writeFileSync(join(state, 'control.json'), JSON.stringify({ nextStory: 'ACME-2', requestedAt: '2026-10-30T10:00:00.000Z' }));
      setLoop(state, 'running', '', at(1));
      const req = openNextRequest(state);
      setNextWait(state, { id: 'ACME-2', at: req.at, since: at(1).toISOString(), tries: 3, reason: 'its claim is held elsewhere' });
      const root = join(dir, 'root');
      mkdirSync(join(root, 'stories'), { recursive: true });
      writeFileSync(join(root, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'Acme' }, slots: 3 }));
      const items = async () => (await ownerWaiting(state, at(2), { root, slots: 3 })).items;
      expect((await items()).find((i) => i.id === 'run:next')).toMatchObject({ kind: 'run', group: 'now', title: 'ACME-2 cannot start next', actions: [] });
      settleNextRequest(state, req, 'started', at(2));
      expect((await items()).map((i) => i.id)).not.toContain('run:next');
    });
  });
});

describe('what is waiting on the owner', () => {
  const put = (collection, id, data) => {
    const folder = join(dir, 'sync', 'decisions', collection);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `${id}.json`), JSON.stringify(data));
  };

  it('counts only unanswered items that ask for an answer', () => {
    put('items', 'a', { title: 'Answered one', order: 1, kind: 'decision' });
    put('answers', 'a', { choice: 'yes' });
    put('items', 'later', { title: 'Coming later', order: 2, input: 'none' });
    put('items', 'b', { title: 'Pick a scheduler', order: 3, kind: 'decision' });
    put('items', 'c', { title: 'Add a key', order: 2, kind: 'task' });
    const w = waitingOnOwner(dir);
    expect(w.count).toBe(2);
    expect(w.items.map((i) => i.id)).toEqual(['c', 'b']);
  });

  it('says nothing when the decisions page has not been read yet', () => {
    expect(waitingOnOwner(dir)).toBeNull();
  });

  it('reads the decisions folder when there is one, urgent first, then oldest', async () => {
    const { add, answer, applied } = await import('../console/decisions.mjs');
    put('items', 'old', { title: 'From the page copy', order: 1, kind: 'decision' });
    const a = add(dir, { story: 'S-1', kind: 'decision', title: 'S-1 could not pass review', options: ['Retry', 'Drop'] }, at(1));
    const b = add(dir, { story: 'S-2', kind: 'task', title: 'Add the key' }, at(2));
    const c = add(dir, { story: 'S-3', kind: 'task', title: 'S-3 stopped the release line', urgent: true }, at(3));
    const d = add(dir, { story: 'S-4', kind: 'decision', title: 'Answered', options: ['Yes'] }, at(4));
    answer(dir, d, { option: 'Yes' }, at(5));
    const e = add(dir, { story: 'S-5', kind: 'task', title: 'Applied' }, at(6));
    applied(dir, e, at(7));
    const w = waitingOnOwner(dir, at(8));
    expect(w.count).toBe(3);
    expect(w.items.map((i) => [i.id, i.kind])).toEqual([
      [c, 'task'],
      [a, 'decision'],
      [b, 'task'],
    ]);
    expect(w.items[0].urgent).toBe(true);
    expect(w.checkedAt).toBe(at(8).toISOString());
  });
});

describe('owner claims in the snapshot', () => {
  const story = (id, title, status) => `---\nid: ${id}\ntitle: ${title}\nstatus: ${status}\n---\n`;
  const project = () => {
    const root = join(dir, 'acme');
    mkdirSync(join(root, 'stories'), { recursive: true });
    writeFileSync(join(root, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'Acme' }, slots: 3, checks: [{ run: 'true', when: 'always' }] }));
    writeFileSync(join(root, 'stories', 'ACME-1.md'), story('ACME-1', 'Ship the cart', 'done'));
    writeFileSync(join(root, 'stories', 'ACME-2.md'), story('ACME-2', 'Add the search box', 'todo'));
    return root;
  };

  it('gives the id, the real title (a done story too) and when it was taken', async () => {
    const root = project();
    const state = join(dir, 'state');
    ownerClaim(state, 'ACME-1', at(1));
    ownerClaim(state, 'ACME-2', at(1));
    const snap = await snapshot(state, at(2), null, { root, slots: 3 });
    expect(snap.ownerClaims).toEqual([
      { id: 'ACME-1', title: 'Ship the cart', at: at(1).toISOString() },
      { id: 'ACME-2', title: 'Add the search box', at: at(1).toISOString() },
    ]);
  });

  it('gives at null for a claim file without one', async () => {
    const root = project();
    const state = join(dir, 'state');
    mkdirSync(join(state, 'claims'), { recursive: true });
    writeFileSync(join(state, 'claims', 'ACME-2.json'), JSON.stringify({ pid: null, slot: null, story: 'ACME-2', by: 'owner' }));
    const snap = await snapshot(state, at(2), null, { root, slots: 3 });
    expect(snap.ownerClaims).toEqual([{ id: 'ACME-2', title: 'Add the search box', at: null }]);
  });
});

describe('the waiting list in the snapshot', () => {
  const note = (id, title, extra = '') => `---\nid: ${id}\ntitle: ${title}\nstatus: todo\n${extra}---\n`;
  const project = (stories) => {
    const root = join(dir, 'acme');
    mkdirSync(join(root, 'stories'), { recursive: true });
    writeFileSync(join(root, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'Acme' }, slots: 3, checks: [{ run: 'true', when: 'always' }] }));
    for (const [id, text] of Object.entries(stories)) writeFileSync(join(root, 'stories', `${id}.md`), text);
    return root;
  };

  it('counts an open owner task, with the stories it blocks', async () => {
    const root = project({ 'ABC-1': note('ABC-1', 'Add the key (owner task)'), 'ABC-2': note('ABC-2', 'Use the key', 'depends_on: [ABC-1]\n') });
    const snap = await snapshot(join(dir, 'state'), at(2), null, { root, slots: 3 });
    expect(snap.waiting.count).toBe(1);
    expect(snap.waiting.items[0]).toMatchObject({ id: 'task:ABC-1', kind: 'owner-task', blocks: ['ABC-2'] });
    expect(snap.waiting.checkedAt).toBe(at(2).toISOString());
  });

  it('is null with no decisions source and nothing waiting', async () => {
    const root = project({ 'ABC-1': note('ABC-1', 'Build the page') });
    expect((await snapshot(join(dir, 'state'), at(2), null, { root, slots: 3 })).waiting).toBeNull();
  });

  it('the snapshot counts now items only and gives later', async () => {
    const root = project({
      'ABC-1': note('ABC-1', 'Add the key (owner task)'),
      'ABC-2': note('ABC-2', 'Build it'),
      'ABC-3': note('ABC-3', 'Run the proof (owner task)', 'depends_on: [ABC-2]\n'),
    });
    const snap = await snapshot(join(dir, 'state'), at(2), null, { root, slots: 3 });
    expect(snap.waiting.count).toBe(1);
    expect(snap.waiting.later).toBe(1);
    expect(snap.waiting.items.map((i) => i.id)).toEqual(['task:ABC-1']);
  });

  it('counts a bundle of follow-ups as one', async () => {
    const { add } = await import('../console/decisions.mjs');
    const root = project({ 'ABC-1': note('ABC-1', 'Add the key (owner task)') });
    const state = join(dir, 'state');
    for (const n of [5, 6, 7]) {
      add(state, { story: `ABC-${n}`, kind: 'decision', title: `Follow up on ABC-${n}: 2 minor finding(s)?`, options: ['Create a follow-up story', 'Ignore'], summary: '2 minor: a; b' }, at(1));
    }
    const snap = await snapshot(state, at(2), null, { root, slots: 3 });
    expect(snap.waiting.count).toBe(2);
    expect(snap.waiting.later).toBe(0);
  });

  it("today's owner tasks give 6 now and 9 later", async () => {
    const story = (id, title, { status = 'todo', deps = [] } = {}) =>
      `---\nid: ${id}\ntitle: ${title}\nstatus: ${status}\n${deps.length ? `depends_on: [${deps.map((n) => `ACME-${n}`).join(', ')}]\n` : ''}---\n`;
    const stories = {};
    for (const n of [11, 30, 39, 58]) stories[`ACME-${n}`] = story(`ACME-${n}`, `Groundwork ${n}`, { status: 'done' });
    for (const n of [31, 32, 35, 38, 43, 46, 54, 57]) stories[`ACME-${n}`] = story(`ACME-${n}`, `Build part ${n}`);
    for (const n of [12, 13, 17, 18]) stories[`ACME-${n}`] = story(`ACME-${n}`, `Spike ${n} (owner task)`, { deps: [11] });
    for (const n of [14, 16]) stories[`ACME-${n}`] = story(`ACME-${n}`, `Spike ${n} (owner task)`);
    const proofs = { 40: [30, 31, 32, 35, 38, 39], 41: [40], 44: [43, 41], 47: [46], 48: [44, 47], 55: [54, 41], 56: [55, 48], 59: [57, 58, 56], 60: [59] };
    for (const [n, deps] of Object.entries(proofs)) stories[`ACME-${n}`] = story(`ACME-${n}`, `Proof or release ${n} (owner task)`, { deps });
    const root = project(stories);
    const spikes = ['ACME-12', 'ACME-13', 'ACME-14', 'ACME-16', 'ACME-17', 'ACME-18'].map((id) => `task:${id}`);

    const snap = await snapshot(join(dir, 'state'), at(2), null, { root, slots: 3 });
    expect(snap.waiting.count).toBe(6);
    expect(snap.waiting.later).toBe(9);
    expect(snap.waiting.items).toHaveLength(5);
    for (const item of snap.waiting.items) expect(spikes).toContain(item.id);

    const all = await ownerWaiting(join(dir, 'state'), at(2), { root, slots: 3 });
    expect(all.items).toHaveLength(15);
    expect(all.items.find((i) => i.id === 'task:ACME-40')).toMatchObject({
      waitsOn: ['ACME-31', 'ACME-32', 'ACME-35', 'ACME-38'],
      why: 'Can start after ACME-31, ACME-32 and 2 more.',
    });
  });

  // The refresher's reason carries the local HH:MM the failures began.
  const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const jiraReason = (d) => `Jira not reachable since ${hhmm(d)}: fetch failed; picking paused, stories in progress carry on`;

  it('a short Jira pause is an FYI item, left out of the count, later and items', async () => {
    const root = project({
      'ABC-1': note('ABC-1', 'Add the key (owner task)'),
      'ABC-2': note('ABC-2', 'Build it'),
      'ABC-3': note('ABC-3', 'Run the proof (owner task)', 'depends_on: [ABC-2]\n'),
    });
    const state = join(dir, 'state');
    const before = await snapshot(state, at(2), null, { root, slots: 3 });
    const since = new Date(at(2).getTime() - 10 * 60000);
    setLoop(state, 'paused', jiraReason(since), since);

    const all = await ownerWaiting(state, at(2), { root, slots: 3 });
    expect(all.items.find((i) => i.id === 'run:jira')).toMatchObject({ kind: 'run', group: 'fyi', actions: [] });

    const snap = await snapshot(state, at(2), null, { root, slots: 3 });
    expect(snap.waiting.count).toBe(before.waiting.count);
    expect(snap.waiting.later).toBe(before.waiting.later);
    expect(snap.waiting.items.map((i) => i.id)).not.toContain('run:jira');
  });

  it('shows a run on the last good config as a now item', async () => {
    const root = project({ 'ABC-1': note('ABC-1', 'Build it') });
    const state = join(dir, 'state');
    setLoop(state, 'running', '', at(1));
    const file = join(state, 'state.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), configProblem: { since: at(1).toISOString(), reason: 'bogusKey: unknown key' } }));
    const snap = await snapshot(state, at(2), null, { root, slots: 3 });
    expect(snap.waiting.items.filter((i) => i.id === 'run:config')).toHaveLength(1);
    expect(snap.waiting.items.find((i) => i.id === 'run:config')).toMatchObject({ kind: 'run', group: 'now', title: 'foreman.config.json is invalid' });
    expect(snap.waiting.count).toBe(1);
  });

  // A run on the last good config: state.json's configProblem, the saved config, and an invalid file.
  const onLastGood = (root, state, { problem = true } = {}) => {
    setLoop(state, 'running', '', at(1));
    saveLastGood(state, loadConfig(root).config);
    if (problem) {
      const file = join(state, 'state.json');
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), configProblem: { since: at(1).toISOString(), reason: 'bogusKey: unknown key' } }));
    }
    const config = join(root, 'foreman.config.json');
    writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, 'utf8')), bogusKey: true }));
  };

  it('keeps the stories on the board while the run is on the last good config', async () => {
    const root = project({ 'ABC-1': note('ABC-1', 'Add the key (owner task)'), 'ABC-2': note('ABC-2', 'Use the key', 'depends_on: [ABC-1]\n') });
    const state = join(dir, 'state');
    onLastGood(root, state);
    const env = { FOREMAN_STATE_DIR: state };

    const snap = await snapshot(state, at(2), null, { root, slots: 3, env });
    expect(snap.progress.total).toBe(2);
    expect(snap.queue.waiting + snap.queue.now.length).toBeGreaterThan(0);
    const ids = snap.waiting.items.map((i) => i.id);
    expect(ids).toContain('task:ABC-1');
    expect(ids).toContain('run:config');

    const all = await ownerWaiting(state, at(2), { root, slots: 3, env });
    expect(all.items.find((i) => i.id === 'task:ABC-1')).toMatchObject({ blocks: ['ABC-2'] });
  });

  it('never reads the last good config outside a run on it', async () => {
    const root = project({ 'ABC-1': note('ABC-1', 'Add the key (owner task)'), 'ABC-2': note('ABC-2', 'Use the key', 'depends_on: [ABC-1]\n') });
    const state = join(dir, 'state');
    onLastGood(root, state, { problem: false });
    const env = { FOREMAN_STATE_DIR: state };

    const snap = await snapshot(state, at(2), null, { root, slots: 3, env });
    expect(snap.progress).toBeNull();
    expect((snap.waiting?.items ?? []).map((i) => i.id)).not.toContain('task:ABC-1');
    const all = await ownerWaiting(state, at(2), { root, slots: 3, env });
    expect(all.items.map((i) => i.id)).not.toContain('task:ABC-1');
  });

  it('shows a stuck run as one now item and carries stuck while the loop runs', async () => {
    const root = project({ 'ABC-1': note('ABC-1', 'Build it') });
    const state = join(dir, 'state');
    setLoop(state, 'running', '', at(1));
    const file = join(state, 'state.json');
    const stuck = { kind: 'error', since: new Date(at(2).getTime() - 12 * 60000).toISOString(), reason: 'the supervisor fails every loop: ENOENT' };
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), stuck }));
    const all = await ownerWaiting(state, at(2), { root, slots: 3 });
    expect(all.items.filter((i) => i.id === 'run:stuck')).toHaveLength(1);
    expect(all.items.find((i) => i.id === 'run:stuck')).toMatchObject({ kind: 'run', group: 'now', title: 'Not building for 12 minutes', why: stuck.reason });
    expect((await snapshot(state, at(2), null, { root, slots: 3 })).stuck).toEqual(stuck);

    setLoop(state, 'stopped', 'Stopped on request.', at(3));
    expect((await snapshot(state, at(3), null, { root, slots: 3 })).stuck).toBeNull();
  });

  it('shows a slow story as an FYI item and carries slow while the loop runs', async () => {
    const root = project({ 'ABC-1': note('ABC-1', 'Build it') });
    const state = join(dir, 'state');
    setLoop(state, 'running', '', at(1));
    const file = join(state, 'state.json');
    const slow = [{ slot: 'w3', id: 'ABC-1', since: new Date(at(2).getTime() - 105 * 60000).toISOString(), stage: 'build', rounds: 1, steps: 129 }];
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), slow }));
    const all = await ownerWaiting(state, at(2), { root, slots: 3 });
    expect(all.items.find((i) => i.id === 'run:slow:w3')).toMatchObject({ kind: 'run', group: 'fyi', actions: [], why: 'slow: ABC-1 in its fix round for 1 h 45 min (129 steps)' });
    const snap = await snapshot(state, at(2), null, { root, slots: 3 });
    expect(snap.slow).toEqual(slow);
    expect(snap.stuck).toBeNull();
    expect(snap.waiting.items.map((i) => i.id)).not.toContain('run:slow:w3');

    setLoop(state, 'stopped', 'Stopped on request.', at(3));
    expect((await snapshot(state, at(3), null, { root, slots: 3 })).slow).toEqual([]);
  });

  it('carries the stories skipped this run while the loop runs, and none once it stops', async () => {
    const root = project({ 'ACME-1': note('ACME-1', 'Build it') });
    const state = join(dir, 'state');
    setLoop(state, 'running', '', at(1));
    const file = join(state, 'state.json');
    expect((await snapshot(state, at(2), null, { root, slots: 3 })).skipped).toEqual([]);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), skipped: ['ACME-2'] }));
    expect((await snapshot(state, at(2), null, { root, slots: 3 })).skipped).toEqual(['ACME-2']);

    setLoop(state, 'stopped', 'Stopped on request.', at(3));
    expect((await snapshot(state, at(3), null, { root, slots: 3 })).skipped).toEqual([]);
  });

  it('shows a restart pending on new code as an FYI item and carries restartPending while the loop runs', async () => {
    const root = project({ 'ABC-1': note('ABC-1', 'Build it') });
    const state = join(dir, 'state');
    setLoop(state, 'running', '', at(1));
    setSlot(state, 'w1', { state: 'building', story: { id: 'ABC-1', title: 'Build it', stage: 'build' } }, at(1));
    const file = join(state, 'state.json');
    const restartPending = { from: 'a1b2c3d', to: 'e4f5a6b', since: at(1).toISOString() };
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), restartPending }));
    const snap = await snapshot(state, at(2), null, { root, slots: 3 });
    expect(snap.restartPending).toEqual(restartPending);
    const all = await ownerWaiting(state, at(2), { root, slots: 3 });
    expect(all.items.find((i) => i.id === 'run:restart')).toMatchObject({
      kind: 'run',
      group: 'fyi',
      actions: [],
      why: 'New code (a1b2c3d → e4f5a6b): restarting as soon as the slots being set up are ready; the stories in progress keep running.',
    });
    expect(snap.waiting.items.map((i) => i.id)).not.toContain('run:restart');

    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), restartPending: null }));
    expect((await snapshot(state, at(3), null, { root, slots: 3 })).restartPending).toBeNull();
    expect((await ownerWaiting(state, at(3), { root, slots: 3 })).items.map((i) => i.id)).not.toContain('run:restart');

    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), restartPending }));
    setLoop(state, 'stopped', 'Stopped on request.', at(4));
    expect((await snapshot(state, at(4), null, { root, slots: 3 })).restartPending).toBeNull();
    expect((await ownerWaiting(state, at(4), { root, slots: 3 })).items.map((i) => i.id)).not.toContain('run:restart');
  });

  it('carries a backoffUntil still in the future, and none once it is past or the loop is stopped', async () => {
    const root = project({ 'ABC-1': note('ABC-1', 'Build it') });
    const state = join(dir, 'state');
    setLoop(state, 'running', '', at(1));
    const file = join(state, 'state.json');
    const put = (backoffUntil) => writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), backoffUntil }));
    const later = new Date(at(2).getTime() + 600000).toISOString();
    put(later);
    expect((await snapshot(state, at(2), null, { root, slots: 3 })).backoffUntil).toBe(later);
    put(new Date(at(2).getTime() - 1000).toISOString());
    expect((await snapshot(state, at(2), null, { root, slots: 3 })).backoffUntil).toBeNull();
    put(null);
    expect((await snapshot(state, at(2), null, { root, slots: 3 })).backoffUntil).toBeNull();
    put(later);
    setLoop(state, 'stopped', 'Stopped on request.', at(3));
    put(later);
    expect((await snapshot(state, at(3), null, { root, slots: 3 })).backoffUntil).toBeNull();
  });

  it('shows an owner answer that could not be applied as a now item with a Retry, while the loop runs', async () => {
    const root = project({ 'ABC-1': note('ABC-1', 'Build it') });
    const state = join(dir, 'state');
    setLoop(state, 'running', '', at(1));
    const file = join(state, 'state.json');
    const failure = { id: 'd-20261101090000-abcd', story: 'ABC-1', title: 'ABC-1: which store?', step: 'putting ABC-1 back to todo', tries: 1, at: at(1).toISOString(), retryAt: new Date(at(2).getTime() + 60000).toISOString() };
    const put = (answerFailures) => writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), answerFailures }));
    put([failure]);
    const all = await ownerWaiting(state, at(2), { root, slots: 3 });
    expect(all.items.find((i) => i.id === 'run:answer:d-20261101090000-abcd')).toMatchObject({ kind: 'run', group: 'now', actions: [{ id: 'retry', label: 'Retry' }] });
    expect((await snapshot(state, at(2), null, { root, slots: 3 })).waiting.items.map((i) => i.id)).toContain('run:answer:d-20261101090000-abcd');
    put('not a list');
    expect((await ownerWaiting(state, at(2), { root, slots: 3 })).items.map((i) => i.id)).not.toContain('run:answer:d-20261101090000-abcd');
    put([failure]);
    setLoop(state, 'stopped', 'Stopped on request.', at(3));
    expect((await ownerWaiting(state, at(3), { root, slots: 3 })).items.map((i) => i.id)).not.toContain('run:answer:d-20261101090000-abcd');
  });

  it('hides a restart pending once the supervisor that recorded it has died', async () => {
    const root = project({ 'ABC-1': note('ABC-1', 'Build it') });
    const state = join(dir, 'state');
    setLoop(state, 'running', '', at(1));
    setSlot(state, 'w1', { state: 'building', story: { id: 'ABC-1', title: 'Build it', stage: 'build' } }, at(1));
    const file = join(state, 'state.json');
    const restartPending = { from: 'a1b2c3d', to: 'e4f5a6b', since: at(1).toISOString() };
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), restartPending }));
    const shown = async () => ({
      pending: (await snapshot(state, at(2), null, { root, slots: 3 })).restartPending,
      ids: (await ownerWaiting(state, at(2), { root, slots: 3 })).items.map((i) => i.id),
    });

    // A supervisor killed with kill -9 while draining: its pid is gone.
    writePid(state, spawnSync('true').pid);
    let seen = await shown();
    expect(seen.pending).toBeNull();
    expect(seen.ids).not.toContain('run:restart');

    // A pid now held by another program (the vitest worker is not supervisor.mjs).
    writePid(state, process.pid);
    seen = await shown();
    expect(seen.pending).toBeNull();
    expect(seen.ids).not.toContain('run:restart');

    // No pid file: shown again, with state.json untouched.
    rmSync(join(state, 'supervisor.pid'));
    seen = await shown();
    expect(seen.pending).toEqual(restartPending);
    expect(seen.ids).toContain('run:restart');
  });

  it('shows the stray supervisors still running as an FYI item, counting only live pids', async () => {
    const root = project({ 'ABC-1': note('ABC-1', 'Build it') });
    const state = join(dir, 'state');
    setLoop(state, 'running', '', at(1));
    const file = join(state, 'state.json');
    const deadPid = spawnSync('true').pid;
    const strays = (pids) => writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), strays: { pids, mb: 300, at: at(1).toISOString() } }));
    strays([process.pid, deadPid]);
    const all = await ownerWaiting(state, at(2), { root, slots: 3 });
    expect(all.items.find((i) => i.id === 'run:strays')).toMatchObject({ kind: 'run', group: 'fyi', title: '1 stray process running', actions: [{ id: 'end', label: 'End them' }] });

    strays([deadPid]);
    expect((await ownerWaiting(state, at(2), { root, slots: 3 })).items.map((i) => i.id)).not.toContain('run:strays');

    strays([process.pid]);
    setLoop(state, 'stopped', 'Stopped on request.', at(3));
    expect((await ownerWaiting(state, at(3), { root, slots: 3 })).items.map((i) => i.id)).not.toContain('run:strays');
  });

  it('a run stopped with nothing left to build says so', async () => {
    const root = project({ 'ABC-1': note('ABC-1', 'Add the key (owner task)'), 'ABC-2': note('ABC-2', 'Use the key', 'depends_on: [ABC-1]\n') });
    const state = join(dir, 'state');
    setLoop(state, 'stopped', 'Nothing left to build.', at(1));
    const all = await ownerWaiting(state, at(2), { root, slots: 3 });
    expect(all.items.find((i) => i.id === 'run:nothing-left')).toMatchObject({ group: 'fyi', why: 'Nothing left to build: 1 story waits on your tasks.' });
  });

  it('carries the headline, from the whole list, the loop and the shown slots', async () => {
    const { headline } = await import('../console/waiting.mjs');
    // ABC-3 is a later owner task that blocks ABC-4, so a headline built from only the now
    // items would count 1 story left instead of 2.
    const root = project({
      'ABC-1': note('ABC-1', 'Add the key (owner task)'),
      'ABC-2': note('ABC-2', 'Use the key', 'depends_on: [ABC-1]\n'),
      'ABC-3': note('ABC-3', 'Run the proof (owner task)', 'depends_on: [ABC-2]\n'),
      'ABC-4': note('ABC-4', 'Ship it', 'depends_on: [ABC-3]\n'),
    });
    const state = join(dir, 'state');
    setLoop(state, 'stopped', 'Nothing left to build.', at(1));
    const snap = await snapshot(state, at(2), null, { root, slots: 3 });
    const all = await ownerWaiting(state, at(2), { root, slots: 3 });
    expect(all.items.find((i) => i.id === 'task:ABC-3')).toMatchObject({ group: 'later', blocks: ['ABC-4'] });
    expect(snap.waiting.headline).toEqual(headline({ items: all.items, loop: snap.loop, slots: snap.slots }));
    expect(snap.waiting.headline).toMatchObject({ state: 'idle', best: 'task:ABC-1' });
    expect(snap.waiting.headline.text).toBe('Idle: the 2 stories left all wait on your tasks. Do Add the key (owner task) first: it frees ABC-2 now and 1 story in all.');
    // What /api/waiting serves is unchanged: no item carries a headline.
    for (const item of all.items) expect(item).not.toHaveProperty('headline');
    expect(all).not.toHaveProperty('headline');
  });

  it('on standby, the headline says so and why', async () => {
    const { STANDBY } = await import('./scheduler.mjs');
    const root = project({ 'ABC-1': note('ABC-1', 'Add the key (owner task)'), 'ABC-2': note('ABC-2', 'Use the key', 'depends_on: [ABC-1]\n') });
    const state = join(dir, 'state');
    setLoop(state, 'standby', STANDBY, at(1));
    const snap = await snapshot(state, at(2), null, { root, slots: 3 });
    expect(snap.loop.state).toBe('standby');
    expect(snap.waiting.headline).toEqual({ state: 'standby', text: 'Standby: nothing to build. 1 story waits on your tasks. Picks up new stories automatically.', best: 'task:ABC-1' });
  });

  describe('a self-pause', () => {
    const T = '2026-10-14T10:01:00.000Z';
    const R = 'Three stories in a row did not ship: ACME-1, ACME-2 and ACME-3.';
    const setUp = (control) => {
      const state = join(dir, 'state');
      mkdirSync(state, { recursive: true });
      writeFileSync(join(state, 'state.json'), JSON.stringify({ loop: { state: 'paused', reason: R, since: T }, autoPausedAt: T, autoPauseReason: R }));
      if (control) writeFileSync(join(state, 'control.json'), JSON.stringify(control));
      return state;
    };
    const root = () => project({ 'ACME-1': note('ACME-1', 'Build it') });

    it('is a Needs-you item while no resume came after it', async () => {
      const all = await ownerWaiting(setUp(null), at(2), { root: root(), slots: 3 });
      expect(all.items.find((i) => i.id === 'run:paused')).toMatchObject({ kind: 'run', why: R, actions: [{ id: 'resume', label: 'Resume' }], group: 'now' });
    });

    it('is gone once a resume came after it', async () => {
      const all = await ownerWaiting(setUp({ paused: false, resumeAt: '2026-10-14T10:02:00.000Z' }), at(2), { root: root(), slots: 3 });
      expect(all.items.map((i) => i.id)).not.toContain('run:paused');
    });

    it('stays when the last resume came before it', async () => {
      const all = await ownerWaiting(setUp({ paused: false, resumeAt: '2026-10-14T10:00:00.000Z' }), at(2), { root: root(), slots: 3 });
      expect(all.items.find((i) => i.id === 'run:paused')).toMatchObject({ why: R });
    });

    it('says when Foreman tries again, from state.json autoResumeAt', async () => {
      const state = setUp(null);
      const autoResumeAt = '2026-10-14T14:30:00.000Z';
      writeFileSync(join(state, 'state.json'), JSON.stringify({ loop: { state: 'paused', reason: R, since: T }, autoPausedAt: T, autoPauseReason: R, autoResumeAt }));
      const all = await ownerWaiting(state, at(2), { root: root(), slots: 3 });
      const item = all.items.find((i) => i.id === 'run:paused');
      expect(item).toMatchObject({ retryAt: autoResumeAt });
      expect(item.why).toMatch(/^Three stories in a row did not ship: ACME-1, ACME-2 and ACME-3\. Foreman tries again at (\d\d:\d\d|\d{4}-\d\d-\d\d \d\d:\d\d) by itself\.$/);
    });

    it('has no retry time when autoResumeAt does not read', async () => {
      const state = setUp(null);
      writeFileSync(join(state, 'state.json'), JSON.stringify({ loop: { state: 'paused', reason: R, since: T }, autoPausedAt: T, autoPauseReason: R, autoResumeAt: 'later' }));
      const item = (await ownerWaiting(state, at(2), { root: root(), slots: 3 })).items.find((i) => i.id === 'run:paused');
      expect(item.why).toBe(R);
      expect(item).not.toHaveProperty('retryAt');
    });

    it('shows the Claude API wait while it lasts', async () => {
      const state = join(dir, 'state');
      mkdirSync(state, { recursive: true });
      const loop = { state: 'running', reason: '', since: T };
      writeFileSync(join(state, 'state.json'), JSON.stringify({ loop, apiWait: { since: T, until: '2026-10-14T12:00:00.000Z', step: 3 } }));
      const all = await ownerWaiting(state, at(2), { root: root(), slots: 3 });
      expect(all.items.find((i) => i.id === 'run:api-wait')).toMatchObject({ group: 'fyi', why: expect.stringContaining('(wait 3); Foreman tries again at ') });
      writeFileSync(join(state, 'state.json'), JSON.stringify({ loop, apiWait: { since: T, until: '2026-10-14T10:00:30.000Z', step: 3 } }));
      expect((await ownerWaiting(state, at(2), { root: root(), slots: 3 })).items.map((i) => i.id)).not.toContain('run:api-wait');
    });

    it('shows the environment wait while it lasts', async () => {
      const state = join(dir, 'state');
      mkdirSync(state, { recursive: true });
      const loop = { state: 'running', reason: '', since: T };
      writeFileSync(join(state, 'state.json'), JSON.stringify({ loop, envWait: { since: T, until: '2026-10-14T12:00:00.000Z', step: 2 } }));
      const all = await ownerWaiting(state, at(2), { root: root(), slots: 3 });
      expect(all.items.find((i) => i.id === 'run:env-wait')).toMatchObject({ group: 'fyi', why: expect.stringContaining('(wait 2); Foreman tries again at ') });
      writeFileSync(join(state, 'state.json'), JSON.stringify({ loop, envWait: { since: T, until: '2026-10-14T10:00:30.000Z', step: 2 } }));
      expect((await ownerWaiting(state, at(2), { root: root(), slots: 3 })).items.map((i) => i.id)).not.toContain('run:env-wait');
    });

    it('shows a learning tick that failed twice or more in a row, and not a single failure', async () => {
      const state = join(dir, 'state');
      mkdirSync(state, { recursive: true });
      const loop = { state: 'running', reason: '', since: T };
      const why = 'The learning tick failed (exit 1); its log /acme/learning-tick-1.log ends: "Error: boom".';
      writeFileSync(join(state, 'state.json'), JSON.stringify({ loop, learningFailed: { count: 3, since: T, why, log: '/acme/learning-tick-1.log' } }));
      const all = await ownerWaiting(state, at(2), { root: root(), slots: 3 });
      expect(all.items.find((i) => i.id === 'run:learning')).toMatchObject({ group: 'fyi', title: 'The learning tick failed 3 times in a row', why });
      writeFileSync(join(state, 'state.json'), JSON.stringify({ loop, learningFailed: { count: 1, since: T, why, log: '/acme/learning-tick-1.log' } }));
      expect((await ownerWaiting(state, at(2), { root: root(), slots: 3 })).items.map((i) => i.id)).not.toContain('run:learning');
      writeFileSync(join(state, 'state.json'), JSON.stringify({ loop }));
      expect((await ownerWaiting(state, at(2), { root: root(), slots: 3 })).items.map((i) => i.id)).not.toContain('run:learning');
    });

    it('shows the main checkout not taking new code while state.json records it, and not once it is cleared', async () => {
      const state = join(dir, 'state');
      mkdirSync(state, { recursive: true });
      const loop = { state: 'running', reason: '', since: T };
      const anchorWait = { why: 'dirty', files: ['.claude/settings.json'], from: 'aaaaaaa1', to: 'bbbbbbb2', remote: 'origin', baseBranch: 'main', since: T };
      writeFileSync(join(state, 'state.json'), JSON.stringify({ loop, anchorWait }));
      const all = await ownerWaiting(state, at(2), { root: root(), slots: 3 });
      expect(all.items.find((i) => i.id === 'run:anchor')).toMatchObject({ group: 'now', why: expect.stringContaining('.claude/settings.json') });
      writeFileSync(join(state, 'state.json'), JSON.stringify({ loop }));
      expect((await ownerWaiting(state, at(2), { root: root(), slots: 3 })).items.map((i) => i.id)).not.toContain('run:anchor');
    });
  });
});

describe('the slots shown follow the configured slot count', () => {
  it('shows a busy w5 at 8 slots', async () => {
    setWorkers(dir, 1);
    startStory(dir, story, at(1), 'w5');
    const snap = await snapshot(dir, at(2), {}, { root: dir, slots: 8 });
    expect(snap.slots.map((s) => s.id)).toEqual(['w1', 'w5']);
    const three = await snapshot(dir, at(2), {}, { root: dir, slots: 3 });
    expect(three.slots.map((s) => s.id)).toEqual(['w1']);
  });
});

describe('what a session cost and took', () => {
  it('keeps each finished agent\'s start and stop, and counts running ones up to now', () => {
    applyHookEvent(dir, { hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'architect' }, at(1), 'w2');
    applyHookEvent(dir, { hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'architect' }, at(6), 'w2');
    applyHookEvent(dir, { hook_event_name: 'SubagentStart', agent_id: 'b1', agent_type: 'developer' }, at(7), 'w2');
    applyHookEvent(dir, { hook_event_name: 'PreToolUse', tool_name: 'Workflow', tool_input: {} }, at(7), 'w2');
    expect(sessionSpans(dir, 'w2', at(20))).toEqual([
      { role: 'architect', since: at(1).toISOString(), until: at(6).toISOString() },
      { role: 'developer', since: at(7).toISOString(), until: at(20).toISOString() },
      { role: 'foreman', since: at(7).toISOString(), until: at(20).toISOString() },
    ]);
    // clearing the running agents leaves the finished spans; clearSpans starts afresh
    clearAgents(dir, 'w2');
    expect(sessionSpans(dir, 'w2', at(20))).toHaveLength(1);
    clearSpans(dir, 'w2');
    expect(sessionSpans(dir, 'w2', at(20))).toEqual([]);
    expect(sessionSpans(dir, 'w1', at(20))).toEqual([]);
  });

  it('puts cost and minutes on a recent result', () => {
    startStory(dir, story, at(1), 'w1');
    endStory(dir, 'shipped', '', '', at(9), 'w1');
    recordResult(dir, readSlot(dir, 'w1').result, { costUsd: 1.25, minutes: 8.5 });
    expect(readState(dir).recent[0]).toMatchObject({ id: 'P4-04', costUsd: 1.25, minutes: 8.5 });
    recordResult(dir, { id: 'P4-05', result: 'failed', endedAt: at(10).toISOString() });
    expect(readState(dir).recent[0]).not.toHaveProperty('costUsd');
  });

  it('adds up the stories, shipped, cost and minutes of the current run', async () => {
    expect((await snapshot(dir, at(2), {}, { root: dir, slots: 1 })).totals).toEqual({ since: null, stories: 0, shipped: 0, costUsd: 0, minutes: 0 });
    startTotals(dir, at(0));
    addToTotals(dir, { story: 'P4-04', result: 'rate-limit', costUsd: 0.4, minutes: 2 });
    addToTotals(dir, { story: 'P4-04', result: 'shipped', costUsd: 2.1, minutes: 30.25 });
    addToTotals(dir, { story: 'P4-05', result: 'failed', costUsd: null, minutes: 10 });
    expect((await snapshot(dir, at(2), {}, { root: dir, slots: 1 })).totals).toEqual({ since: at(0).toISOString(), stories: 2, shipped: 1, costUsd: 2.5, minutes: 42.3 });
    startTotals(dir, at(5));
    expect((await snapshot(dir, at(6), {}, { root: dir, slots: 1 })).totals).toMatchObject({ stories: 0, costUsd: 0 });
  });
});

describe('restartPendingOf', () => {
  const pending = { from: 'a1b2c3d', to: 'e4f5a6b', since: at(1).toISOString() };
  const running = { loop: { state: 'running' }, restartPending: pending };

  it('shows the pending restart when there is no pid file, without checking any process', () => {
    const seen = [];
    expect(restartPendingOf(dir, running, { alive: (p) => { seen.push(p); return true; } })).toEqual(pending);
    expect(seen).toEqual([]);
  });

  it('shows it while the supervisor the pid file names is alive', () => {
    writePid(dir, 4242);
    const seen = [];
    expect(restartPendingOf(dir, running, { alive: (p) => { seen.push(p); return true; } })).toEqual(pending);
    expect(seen).toEqual([4242]);
  });

  it('hides it once the supervisor the pid file names has died', () => {
    writePid(dir, 4242);
    expect(restartPendingOf(dir, running, { alive: () => false })).toBeNull();
  });

  it('hides it for a stopped run, even with a live supervisor', () => {
    writePid(dir, 4242);
    expect(restartPendingOf(dir, { loop: { state: 'stopped' }, restartPending: pending }, { alive: () => true })).toBeNull();
  });

  it('is null with no restart pending, whatever the pid file says', () => {
    writePid(dir, 4242);
    expect(restartPendingOf(dir, { loop: { state: 'running' } }, { alive: () => true })).toBeNull();
    expect(restartPendingOf(dir, { loop: { state: 'running' }, restartPending: null }, { alive: () => false })).toBeNull();
    expect(restartPendingOf(dir, null, { alive: () => true })).toBeNull();
  });
});

describe('what an agent is doing, in plain words', () => {
  it('describes each tool', () => {
    expect(plainWords('Bash', { command: 'npm test', description: 'Run the tests' })).toBe('Run the tests');
    expect(plainWords('Bash', { command: 'npm test' })).toBe('Running a command');
    expect(plainWords('Bash', { command: 'npm test', description: '   ' })).toBe('Running a command');
    expect(plainWords('Read', { file_path: '/acme/src/a.js' }, '/acme')).toBe('Reading src/a.js');
    for (const tool of ['Edit', 'Write', 'MultiEdit']) expect(plainWords(tool, { file_path: '/acme/src/a.js' }, '/acme')).toBe('Editing src/a.js');
    expect(plainWords('NotebookEdit', { notebook_path: '/acme/n.ipynb' }, '/acme')).toBe('Editing n.ipynb');
    expect(plainWords('Grep', { pattern: 'TODO' })).toBe('Searching for TODO');
    expect(plainWords('Glob', { pattern: 'TODO' })).toBe('Searching for TODO');
    expect(plainWords('Agent', { subagent_type: 'foreman:tester' })).toBe('Starting tester');
    expect(plainWords('Agent', {})).toBe('Starting an agent');
    expect(plainWords('Workflow', {})).toBe('Starting the story pipeline');
    expect(plainWords('Skill', { skill: 'acme-style' })).toBe('Following acme-style');
    expect(plainWords('WebFetch', { url: 'https://acme.example/docs' })).toBe('Looking up https://acme.example/docs');
    expect(plainWords('Monitor', {})).toBe('Waiting for the pipeline');
    expect(plainWords('ScheduleWakeup', {})).toBe('Waiting for the pipeline');
    expect(plainWords('StructuredOutput', {})).toBe('Writing its report');
    expect(plainWords('TodoWrite', {})).toBe('Updating its to-do list');
  });

  it('puts any other tool in plain words, and none at all as Working', () => {
    expect(plainWords('ToolSearch', {})).toBe('Tool search');
    expect(plainWords('mcp__acme__list_items', {})).toBe('List items');
    expect(plainWords(undefined)).toBe('Working');
    expect(plainWords('')).toBe('Working');
  });

  it('keeps a secret out of every text', () => {
    expect(plainWords('Bash', { description: 'Export ACME_TOKEN=abc123 first' })).not.toContain('abc123');
    expect(plainWords('Bash', { description: 'Export ACME_TOKEN=abc123 first' })).toContain('•••');
    expect(plainWords('Bash', { description: 'Use sk-ant-api03-ABCDEFGHIJ' })).toBe('Use •••');
    expect(plainWords('Grep', { pattern: 'sk-ant-api03-ABCDEFGHIJ' })).not.toContain('ABCDEFGHIJ');
    expect(plainWords('Bash', { description: 'x'.repeat(300) }).length).toBe(140);
  });

  it('gives the raw command of a Bash call only, redacted and cut at 500', () => {
    expect(rawCommand('Bash', { command: 'npm test\n  --verbose' })).toBe('npm test\n  --verbose');
    expect(rawCommand('Bash', { command: 'ACME_TOKEN=abc123 npm test' })).toBe('ACME_TOKEN=••• npm test');
    const cut = rawCommand('Bash', { command: 'a'.repeat(900) });
    expect(cut).toHaveLength(501);
    expect(cut.endsWith('…')).toBe(true);
    expect(rawCommand('Read', { file_path: 'x' })).toBeNull();
    expect(rawCommand('Bash', {})).toBe('');
  });

  it('keeps describe and the doing field as they were', () => {
    startStory(dir, story, at(0));
    applyHookEvent(dir, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Run the tests' } }, at(1));
    const [a] = runningAgents(dir);
    expect(a.doing).toBe('$ npm test');
    expect(a.says).toBe('Run the tests');
    expect(a.raw).toBe('npm test');
  });
});

describe('the short model name', () => {
  it('shortens the ids Claude Code writes', () => {
    expect(modelName('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelName('claude-sonnet-5-5')).toBe('Sonnet 5.5');
    expect(modelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(modelName('claude-sonnet-4-20250514')).toBe('Sonnet 4');
    expect(modelName('claude-3-5-sonnet-20241022')).toBe('Sonnet 3.5');
  });

  it('is null for nothing, and returns an unknown id cut at 40', () => {
    for (const v of ['<synthetic>', null, '', undefined, 5, {}]) expect(modelName(v)).toBeNull();
    expect(modelName('acme-model')).toBe('acme-model');
    expect(modelName('x'.repeat(60))).toHaveLength(40);
  });
});

describe('the model each role is set to', () => {
  const cfg = { roles: { architect: { agent: 'foreman:architect', model: 'opus' }, builders: { developer: { agent: 'foreman:builder', model: 'opus' } }, tester: { agent: 'foreman:tester' }, reviewers: [{ name: 'a', agent: 'foreman:security-reviewer', model: 'haiku' }] } };

  it('has the same keys as the stage map, with the role\'s model', () => {
    const models = roleModels(cfg);
    expect(Object.keys(models).sort()).toEqual(Object.keys(stageMap(cfg)).sort());
    expect(models['foreman:builder']).toBe('opus');
    expect(models.builder).toBe('opus');
    expect(models.tester).toBeNull();
    expect(models['security-reviewer']).toBe('haiku');
  });

  it('is null for a key two roles claim with different models', () => {
    const two = { roles: { architect: { agent: 'foreman:architect', model: 'opus' }, builders: { developer: { agent: 'foreman:architect', model: 'sonnet' } }, tester: { agent: 'foreman:tester' }, reviewers: [] } };
    expect(roleModels(two).architect).toBeNull();
    expect(roleModels(two)['foreman:architect']).toBeNull();
  });

  it('uses the default roles without a config', () => {
    expect(Object.keys(roleModels(null)).sort()).toEqual(Object.keys(stageMap(null)).sort());
  });
});

describe('the model an agent runs on', () => {
  let projects;
  const U = '4947378a-6485-4e40-9357-671b81c4acf3';
  const wf = () => join(projects, '-tmp-acme', U, 'subagents', 'workflows', 'wf_1');
  const put = (file, model) => {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, [JSON.stringify({ type: 'user', message: { content: 'task' } }), JSON.stringify({ type: 'attachment' }), '{"type":"api-request-blob","x":1}', JSON.stringify({ type: 'assistant', message: { model, content: [] } })].join('\n') + '\n');
  };
  const pre = (extra = {}) => ({ hook_event_name: 'PreToolUse', session_id: U, agent_id: 'a1', agent_type: 'foreman:builder', tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Run the tests' }, ...extra });

  beforeEach(() => {
    projects = join(dir, 'projects');
    mkdirSync(projects, { recursive: true });
  });

  it('is read from the agent\'s transcript once, and kept', () => {
    put(join(wf(), 'agent-a1.jsonl'), 'claude-sonnet-5-5');
    applyHookEvent(dir, pre(), at(1), 'w1', dir, {}, { projects });
    const [a] = runningAgents(dir);
    expect(a).toMatchObject({ model: 'claude-sonnet-5-5', says: 'Run the tests', raw: 'npm test' });
    // A changed transcript is not read again, and a deleted one does no harm.
    put(join(wf(), 'agent-a1.jsonl'), 'claude-opus-5-5');
    applyHookEvent(dir, pre(), at(2), 'w1', dir, {}, { projects });
    expect(runningAgents(dir)[0]).toMatchObject({ model: 'claude-sonnet-5-5', tools: 2 });
    rmSync(join(projects, '-tmp-acme'), { recursive: true });
    applyHookEvent(dir, pre(), at(3), 'w1', dir, {}, { projects });
    expect(runningAgents(dir)[0]).toMatchObject({ model: 'claude-sonnet-5-5', tools: 3 });
  });

  it('is read from the session\'s own transcript for the foreman', () => {
    put(join(projects, '-tmp-acme', `${U}.jsonl`), 'claude-opus-5-5');
    applyHookEvent(dir, { hook_event_name: 'PreToolUse', session_id: U, tool_name: 'Workflow', tool_input: {} }, at(1), 'w1', dir, {}, { projects });
    expect(runningAgents(dir)[0]).toMatchObject({ role: 'foreman', model: 'claude-opus-5-5' });
  });

  it('leaves the model out when there is no transcript or the session id is not a UUID, and does not throw', () => {
    applyHookEvent(dir, pre(), at(1), 'w1', dir, {}, { projects });
    applyHookEvent(dir, pre({ session_id: '../x' }), at(2), 'w1', dir, {}, { projects });
    applyHookEvent(dir, pre({ session_id: undefined }), at(3), 'w1', dir, {}, { projects: join(dir, 'none') });
    const [a] = runningAgents(dir);
    expect(a.tools).toBe(3);
    expect('model' in a).toBe(false);
  });

  it('records a model a later call finds', () => {
    applyHookEvent(dir, pre(), at(1), 'w1', dir, {}, { projects });
    put(join(wf(), 'agent-a1.jsonl'), 'claude-haiku-4-5-20251001');
    applyHookEvent(dir, pre(), at(2), 'w1', dir, {}, { projects });
    expect(runningAgents(dir)[0].model).toBe('claude-haiku-4-5-20251001');
  });

  it('is named in the finished event, and the old text stays without a model', () => {
    put(join(wf(), 'agent-a1.jsonl'), 'claude-sonnet-5-5');
    applyHookEvent(dir, pre(), at(0), 'w1', dir, {}, { projects });
    applyHookEvent(dir, { hook_event_name: 'SubagentStop', session_id: U, agent_id: 'a1', agent_type: 'foreman:builder' }, at(1), 'w1', dir, {}, { projects });
    const last = () => readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).text).at(-1);
    expect(last()).toBe('foreman:builder finished after 1 min, 1 steps, on Sonnet 5.5');
    applyHookEvent(dir, pre({ agent_id: 'a2', session_id: undefined }), at(2), 'w1', dir, {}, { projects });
    applyHookEvent(dir, { hook_event_name: 'SubagentStop', agent_id: 'a2', agent_type: 'foreman:builder' }, at(3), 'w1', dir, {}, { projects });
    expect(last()).toBe('foreman:builder finished after 1 min, 1 steps');
  });

  it('says Starting when an agent starts', () => {
    applyHookEvent(dir, { hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'foreman:builder' }, at(1));
    expect(runningAgents(dir)[0].says).toBe('Starting');
  });
});

describe('the agents that finished, and the page\'s view of them', () => {
  const cfg = { slots: 2, roles: { architect: { agent: 'foreman:architect' }, builders: { developer: { agent: 'foreman:builder', model: 'opus' } }, tester: { agent: 'foreman:tester' }, reviewers: [] } };

  it('writes the id into the span and lists the last finished agents newest first', () => {
    for (let i = 1; i <= 10; i++) {
      applyHookEvent(dir, { hook_event_name: 'SubagentStart', agent_id: `a${i}`, agent_type: 'foreman:tester' }, new Date(Date.UTC(2026, 9, 14, 10, i, 0)));
      applyHookEvent(dir, { hook_event_name: 'SubagentStop', agent_id: `a${i}`, agent_type: 'foreman:tester' }, new Date(Date.UTC(2026, 9, 14, 10, i, 30)));
    }
    const done = finishedAgents(dir, 'w1');
    expect(done).toHaveLength(8);
    expect(done[0]).toEqual({ id: 'a10', role: 'foreman:tester', since: '2026-10-14T10:10:00.000Z', until: '2026-10-14T10:10:30.000Z' });
    expect(done[7].id).toBe('a3');
    expect(sessionSpans(dir, 'w1', at(30))).toHaveLength(10);
    expect(finishedAgents(dir, 'w2')).toEqual([]);
  });

  it('leaves out a span line with no id (an older status file)', () => {
    mkdirSync(join(dir, 'slots', 'w1'), { recursive: true });
    writeFileSync(join(dir, 'slots', 'w1', 'spans.jsonl'), `${JSON.stringify({ role: 'tester', since: 'a', until: 'b' })}\nnot json\n`);
    expect(finishedAgents(dir, 'w1')).toEqual([]);
  });

  it('adds stage, short model, the mismatch note and the slot\'s model to the snapshot', async () => {
    startStory(dir, story, at(0));
    const map = stageMap(cfg);
    applyHookEvent(dir, { hook_event_name: 'SubagentStart', agent_id: 'b1', agent_type: 'foreman:builder' }, at(1), 'w1', dir, map);
    applyHookEvent(dir, { hook_event_name: 'SubagentStart', agent_id: 't1', agent_type: 'foreman:tester' }, at(1), 'w1', dir, map);
    applyHookEvent(dir, { hook_event_name: 'SubagentStart', agent_id: 'f1', agent_type: undefined }, at(1), 'w1', dir, map);
    const edit = (id, model) => {
      const f = join(dir, 'slots', 'w1', 'agents', `${id}.json`);
      writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), model }));
    };
    edit('b1', 'claude-sonnet-5-5');
    edit('t1', 'claude-sonnet-5-5');
    edit('f1', 'claude-opus-5-5');
    applyHookEvent(dir, { hook_event_name: 'SubagentStart', agent_id: 'x1', agent_type: 'foreman:tester' }, at(1), 'w1', dir, map);
    applyHookEvent(dir, { hook_event_name: 'SubagentStop', agent_id: 'x1', agent_type: 'foreman:tester' }, at(2), 'w1', dir, map);
    const snap = await snapshot(dir, at(3), map, { root: dir, slots: 1, models: roleModels(cfg) });
    const by = (id) => snap.slots[0].agents.find((a) => a.id === id);
    expect(by('b1')).toMatchObject({ stage: 'build', modelName: 'Sonnet 5.5', modelNote: 'Set to Opus, runs on Sonnet 5.5' });
    expect(by('t1')).toMatchObject({ stage: 'test', modelName: 'Sonnet 5.5', modelNote: null });
    expect(by('f1')).toMatchObject({ role: 'foreman', modelName: 'Opus 5.5', modelNote: null });
    expect(snap.slots[0].model).toBe('Opus 5.5');
    expect(snap.slots[0].finished.map((f) => f.id)).toEqual(['x1']);
  });

  it('says nothing when the families match, and has no model without one', async () => {
    startStory(dir, story, at(0));
    const map = stageMap(cfg);
    applyHookEvent(dir, { hook_event_name: 'SubagentStart', agent_id: 'b1', agent_type: 'foreman:builder' }, at(1), 'w1', dir, map);
    const f = join(dir, 'slots', 'w1', 'agents', 'b1.json');
    writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), model: 'claude-opus-5-5' }));
    let snap = await snapshot(dir, at(3), map, { root: dir, slots: 1, models: roleModels(cfg) });
    expect(snap.slots[0].agents[0]).toMatchObject({ modelName: 'Opus 5.5', modelNote: null });
    expect(snap.slots[0].model).toBeNull();
    rmSync(f);
    applyHookEvent(dir, { hook_event_name: 'SubagentStart', agent_id: 'b1', agent_type: 'foreman:builder' }, at(1), 'w1', dir, map);
    snap = await snapshot(dir, at(3), map, { root: dir, slots: 1, models: roleModels(cfg) });
    expect(snap.slots[0].agents[0]).toMatchObject({ modelName: null, modelNote: null });
  });
});

describe('the agents that ran on another model than their role is set to', () => {
  const row = (over = {}) => ({ role: 'builder', name: 'build', agent: 'foreman:builder', model: 'claude-opus-5-5', ...over });
  const sonnet = { 'foreman:builder': 'sonnet', 'foreman:tester': null };

  it('names the role, the setting and the model it ran on', () => {
    expect(modelMismatches([row()], sonnet)).toEqual([
      { role: 'builder', name: 'build', agent: 'foreman:builder', set: 'sonnet', ran: 'claude-opus-5-5', text: 'build (foreman:builder) is set to Sonnet but ran on Opus 5.5' },
    ]);
  });

  it('finds none when the families match, the role sets no model, or the model is unknown', () => {
    expect(modelMismatches([row({ model: 'claude-sonnet-5-5' })], sonnet)).toEqual([]);
    expect(modelMismatches([row({ role: 'tester', name: 'test', agent: 'foreman:tester' })], sonnet)).toEqual([]);
    expect(modelMismatches([row({ role: 'orchestration', name: 'orchestration', agent: null })], sonnet)).toEqual([]);
    expect(modelMismatches([row({ model: null })], sonnet)).toEqual([]);
    expect(modelMismatches([row({ model: '<synthetic>' })], sonnet)).toEqual([]);
    expect(modelMismatches([row({ agent: 'foreman:unknown' })], sonnet)).toEqual([]);
    expect(modelMismatches([row()], {})).toEqual([]);
  });

  it('finds none for no rows', () => {
    for (const v of [null, undefined, 'x', {}]) expect(modelMismatches(v, sonnet)).toEqual([]);
  });

  it('finds none for a key two roles claim with different models', () => {
    const two = { roles: { architect: { agent: 'foreman:architect', model: 'opus' }, builders: { developer: { agent: 'foreman:architect', model: 'sonnet' } }, tester: { agent: 'foreman:tester' }, reviewers: [] } };
    expect(modelMismatches([row({ role: 'architect', name: 'architect', agent: 'foreman:architect' })], roleModels(two))).toEqual([]);
  });

  it('lists the same agent, name and model once, and build and fix separately', () => {
    expect(modelMismatches([row(), row()], sonnet)).toHaveLength(1);
    expect(modelMismatches([row(), row({ name: 'fix' })], sonnet).map((m) => m.name)).toEqual(['build', 'fix']);
  });
});

describe('the event log', () => {
  const NOW = new Date('2026-11-09T10:15:00.123Z');
  const eventsFile = () => join(dir, 'events.jsonl');
  const fill = (n, prefix = 'event') => {
    for (let i = 0; i < n; i++) addEvent(dir, `${prefix} ${i}`, 'info', new Date(Date.UTC(2026, 10, 9, 9, 0, i)));
  };

  it('rotates at 5 MB', () => {
    expect(EVENTS_ROTATE_BYTES).toBe(5 * 1024 * 1024);
  });

  it('leaves a log under the limit alone', () => {
    fill(3);
    const before = readFileSync(eventsFile(), 'utf8');
    expect(rotateEvents(dir, { limit: 2000, now: NOW })).toBeNull();
    expect(readFileSync(eventsFile(), 'utf8')).toBe(before);
    rmSync(eventsFile());
    expect(rotateEvents(dir, { limit: 2000, now: NOW })).toBeNull();
  });

  it('moves a log over the limit to a dated file, and the next event starts a new log', () => {
    fill(30);
    const before = readFileSync(eventsFile(), 'utf8');
    expect(before.length).toBeGreaterThan(2000);
    expect(rotateEvents(dir, { limit: 2000, now: NOW })).toBe('events-2026-11-09T10-15-00Z.jsonl');
    expect(existsSync(eventsFile())).toBe(false);
    expect(readFileSync(join(dir, 'events-2026-11-09T10-15-00Z.jsonl'), 'utf8')).toBe(before);
    addEvent(dir, 'after', 'info', NOW);
    expect(readFileSync(eventsFile(), 'utf8')).toContain('after');
  });

  it('never overwrites a rotated file of the same second, and lists the newest first', () => {
    fill(30, 'first');
    rotateEvents(dir, { limit: 2000, now: NOW });
    const first = readFileSync(join(dir, 'events-2026-11-09T10-15-00Z.jsonl'), 'utf8');
    fill(30, 'second');
    const second = readFileSync(eventsFile(), 'utf8');
    expect(rotateEvents(dir, { limit: 2000, now: NOW })).toBe('events-2026-11-09T10-15-00Z-2.jsonl');
    expect(readFileSync(join(dir, 'events-2026-11-09T10-15-00Z.jsonl'), 'utf8')).toBe(first);
    expect(readFileSync(join(dir, 'events-2026-11-09T10-15-00Z-2.jsonl'), 'utf8')).toBe(second);
    fill(30, 'third');
    expect(rotateEvents(dir, { limit: 2000, now: NOW })).toBe('events-2026-11-09T10-15-00Z-3.jsonl');
    writeFileSync(join(dir, 'events-2026-11-08T23-00-00Z.jsonl'), '');
    writeFileSync(join(dir, 'events-notes.jsonl'), '');
    expect(rotatedEventFiles(dir)).toEqual([
      'events-2026-11-09T10-15-00Z-3.jsonl',
      'events-2026-11-09T10-15-00Z-2.jsonl',
      'events-2026-11-09T10-15-00Z.jsonl',
      'events-2026-11-08T23-00-00Z.jsonl',
    ]);
  });

  it('still shows the 40 newest events after a rotation', async () => {
    fill(30, 'old');
    rotateEvents(dir, { limit: 2000, now: NOW });
    fill(15, 'new');
    const events = (await snapshot(dir, at(3), null, { root: dir })).events;
    expect(events).toHaveLength(40);
    expect(events.map((e) => e.text)).toEqual([
      ...Array.from({ length: 15 }, (_, i) => `new ${14 - i}`),
      ...Array.from({ length: 25 }, (_, i) => `old ${29 - i}`),
    ]);
  });

  it('shows the events of a log that was never rotated, newest first', async () => {
    fill(5);
    expect((await snapshot(dir, at(3), null, { root: dir })).events.map((e) => e.text)).toEqual(['event 4', 'event 3', 'event 2', 'event 1', 'event 0']);
    rmSync(eventsFile());
    expect((await snapshot(dir, at(3), null, { root: dir })).events).toEqual([]);
  });

  it('skips one line that does not parse and shows the others', async () => {
    fill(3);
    appendFileSync(eventsFile(), '{"at": broken\n');
    fill(2, 'later');
    const texts = (await snapshot(dir, at(3), null, { root: dir })).events.map((e) => e.text);
    expect(texts).toEqual(['later 1', 'later 0', 'event 2', 'event 1', 'event 0']);
  });
});

describe('state.json through the cache', () => {
  const stateFile = () => join(dir, 'state.json');
  const old = (file) => utimesSync(file, Date.now() / 1000 - 3600, Date.now() / 1000 - 3600);

  it('gives a fresh object on every call', () => {
    saveState(dir, { loop: { state: 'running' }, workers: 2, recent: [] });
    old(stateFile());
    readState(dir).workers = 99;
    readState(dir).recent.push('x');
    expect(readState(dir)).toMatchObject({ workers: 2, recent: [] });
  });

  it('sees a state.json another writer put there by temp file and rename', () => {
    saveState(dir, { loop: { state: 'running' }, workers: 2, recent: [] });
    old(stateFile());
    expect(readState(dir).workers).toBe(2);
    writeFileSync(`${stateFile()}.9.tmp`, JSON.stringify({ loop: { state: 'standby' }, workers: 3, recent: [] }));
    old(`${stateFile()}.9.tmp`);
    renameSync(`${stateFile()}.9.tmp`, stateFile());
    expect(readState(dir)).toMatchObject({ workers: 3, loop: { state: 'standby' } });
  });

  it('round-trips what saveState wrote, and gives the default when there is no file or a bad one', () => {
    const state = { loop: { state: 'paused', since: null, reason: 'r' }, workers: 3, recent: [{ id: 'ACME-1' }] };
    saveState(dir, state);
    expect(readState(dir)).toEqual(state);
    writeFileSync(stateFile(), '{nope');
    expect(readState(dir)).toMatchObject({ loop: { state: 'stopped' }, workers: 1, recent: [] });
    rmSync(stateFile());
    expect(readState(dir).loop.state).toBe('stopped');
  });
});
