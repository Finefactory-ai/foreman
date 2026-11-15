// A real supervisor run, end to end: a release halted and the story's session raised the urgent
// task "<ID> stopped the release line". Once the story ships, that task must not stay open on
// Waiting on you saying the line is stopped: clearing the halt with `foreman fixed` closes it at
// the clear, and a halted story that ships with no `fixed` closes it when it ships (FM-466). A fake
// `claude` (and `gh`) on the PATH stand in for the sessions and GitHub.

import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { withLoopFree } from '../../../test/loop-free-fixture.mjs';
import { stretchByLoad } from '../../../test/slow-tests.mjs';
import { BIN } from '../../../test/supervisors.mjs';
import * as decisions from '../console/decisions.mjs';

const TITLE = 'ACME-1 stopped the release line';

// Records its story, ships it through the real `foreman story` commands, and prints the result line.
const shipper = () => `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const id = process.env.FOREMAN_STORY;
appendFileSync(process.env.LOOP_FREE_CLAUDE, id + '\\n');
const foreman = (...args) => spawnSync(process.execPath, [${JSON.stringify(BIN)}, ...args], { stdio: 'ignore' }).status;
foreman('story', 'done', id, '--note', 'shipped by the fake session');
foreman('story', 'end', 'shipped', '', 'shipped by the fake session');
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, result: 'Done.\\nFACTORY_RESULT: shipped ' + id, total_cost_usd: 0, session_id: 'fake' }));
process.exit(0);
`;

const addTask = (c) => decisions.add(c.stateDir, { story: 'ACME-1', kind: 'task', urgent: true, title: TITLE, body: 'Deploy failed.' });
const taskOf = (c) => decisions.list(c.stateDir).find((d) => d.title === TITLE);
const recent = (c) => JSON.parse(readFileSync(join(c.stateDir, 'state.json'), 'utf8')).recent ?? [];

// Nothing waits any more: the decision list and the status say so, and the task is closed unanswered.
function expectNothingWaits(c) {
  const item = taskOf(c);
  expect(item.appliedAt).toBeTruthy();
  expect(item.answer).toBeNull();
  expect(c.foreman('decide', 'list').stdout).toContain('Nothing waits on you');
  const status = c.foreman('status').stdout;
  expect(status).toContain('Waiting on you: 0');
  expect(status).not.toContain('stopped the release line');
}

describe('a halt cleared with foreman fixed', () => {
  const ctx = withLoopFree({
    config: { slots: 2, workers: 2 },
    claude: shipper,
    setup: async (c) => {
      c.story('ACME-1', 'blocked', 'Deploy failed.');
      c.commit('Start');
      mkdirSync(join(c.stateDir, 'slots'), { recursive: true });
      mkdirSync(join(c.stateDir, 'claims'), { recursive: true });
      writeFileSync(join(c.stateDir, 'HALT'), 'A release failed.\n');
      writeFileSync(
        join(c.stateDir, 'slots', 'w2.json'),
        JSON.stringify({
          state: 'held',
          reason: 'This story stopped the release line; waiting for you to fix the cause.',
          heldStory: 'ACME-1',
          haltedBy: true,
          heldFor: null,
          story: { id: 'ACME-1', title: 'Story ACME-1', stage: 'release', detail: 'held' },
          result: null,
          heldWas: { status: 'blocked', blockedBy: 'Deploy failed.' },
          since: '2026-11-10T10:02:00.000Z',
        }),
      );
      const dead = spawnSync(process.execPath, ['-e', '0']);
      writeFileSync(join(c.stateDir, 'claims', 'ACME-1.json'), JSON.stringify({ pid: dead.pid, slot: 'w1', story: 'ACME-1', by: 'factory', at: new Date().toISOString() }));
      addTask(c);
    },
  });

  it("closes the halt's task at the clear, and nothing waits once the story ships", async () => {
    ctx.start();
    await ctx.waitFor('the halt', () => ctx.loop()?.state === 'halted', 40_000);

    // The reported starting state: the halt's task is open and urgent.
    const before = ctx.foreman('decide', 'list').stdout;
    expect(before).toContain('Needs you now (1):');
    expect(before).toContain(`URGENT task for ACME-1: ${TITLE}`);

    expect(ctx.foreman('fixed').status).toBe(0);
    const closed = `Closed "${TITLE}" on Waiting on you: the halt is cleared.`;
    await ctx.waitFor('the task closed at the clear', () => ctx.events().includes(closed), 20_000);
    const events = ctx.events();
    expect(events.findIndex((t) => t.startsWith('Halt cleared'))).toBeGreaterThanOrEqual(0);
    expect(events.indexOf(closed)).toBeGreaterThan(events.findIndex((t) => t.startsWith('Halt cleared')));

    await ctx.waitFor('ACME-1 shipped', () => recent(ctx).some((r) => r.id === 'ACME-1' && r.result === 'shipped'), stretchByLoad(30_000));

    expectNothingWaits(ctx);
    // Closed once, at the clear: the ship found nothing left to close.
    expect(ctx.events().filter((t) => t.startsWith(`ACME-1 shipped; closed "${TITLE}"`))).toEqual([]);

    expect(ctx.foreman('stop', '--now').status).toBe(0);
  }, 180_000);
});

describe('a halted story that ships without foreman fixed', () => {
  const ctx = withLoopFree({
    config: { slots: 1, workers: 1 },
    claude: shipper,
    setup: async (c) => {
      c.story('ACME-1', 'todo');
      c.commit('Start');
      addTask(c);
    },
  });

  it('closes its urgent task when it ships, and nothing waits', async () => {
    ctx.start();
    const closed = `ACME-1 shipped; closed "${TITLE}" on Waiting on you.`;
    await ctx.waitFor('the task closed by the ship', () => ctx.events().includes(closed), stretchByLoad(40_000));

    expectNothingWaits(ctx);
    expect(ctx.events().filter((t) => t.includes('the halt is cleared'))).toEqual([]);

    expect(ctx.foreman('stop', '--now').status).toBe(0);
  }, 180_000);
});

describe('a story done by another path', () => {
  const ctx = withLoopFree({
    config: { slots: 1, workers: 1 },
    claude: shipper,
    setup: async (c) => {
      c.story('ACME-1', 'done');
      c.story('ACME-2', 'blocked', 'Deploy failed.');
      c.commit('Start');
      addTask(c);
      decisions.add(c.stateDir, { story: 'ACME-1', kind: 'task', urgent: true, title: 'ACME-1 needs a key', body: 'A key is missing.' });
      decisions.add(c.stateDir, { story: 'ACME-2', kind: 'task', urgent: true, title: 'ACME-2 stopped the release line', body: 'Deploy failed.' });
    },
  });

  it('closes its urgent halt task, and only that one', async () => {
    ctx.start();
    const closed = `ACME-1 is done; closed "${TITLE}" on Waiting on you.`;
    await ctx.waitFor('the task closed for the done story', () => ctx.events().includes(closed), stretchByLoad(30_000));

    const item = taskOf(ctx);
    expect(item.appliedAt).toBeTruthy();
    expect(item.answer).toBeNull();
    const titled = (title) => decisions.list(ctx.stateDir).find((d) => d.title === title);
    expect(titled('ACME-1 needs a key').appliedAt).toBeNull();
    expect(titled('ACME-2 stopped the release line').appliedAt).toBeNull();
    expect(ctx.claudeCalls()).toEqual([]);

    expect(ctx.foreman('stop', '--now').status).toBe(0);
  }, 180_000);
});
