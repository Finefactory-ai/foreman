// Two lines of the supervisor decide whether the gate that runs before a resumed story's session
// lets it through, and only a source-text check in scheduler.test.mjs guarded them. These real
// runs break when either line goes (FM-434):
//   - a release finish queued at start-up (reconcileStart marks it `finish: true`) starts its
//     session even though its story is blocked, because it must finish what the lock started;
//   - a slot held by a halted story records the story as it was (endSession's `heldWas`), so that
//     clearing the halt does not resume a story the owner changed while it was held.

import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { withLoopFree } from '../../../test/loop-free-fixture.mjs';
import { stretchByLoad } from '../../../test/slow-tests.mjs';
import { BIN } from '../../../test/supervisors.mjs';

const NOT_RESUMED = 'ACME-1 not resumed: its story is blocked; slot w1 is free.';

describe('a start-up release finish for a blocked story', () => {
  const ctx = withLoopFree({
    config: { slots: 1, workers: 1 },
    claude: '#!/bin/sh\necho "$FOREMAN_STORY" >> "$LOOP_FREE_CLAUDE"\necho $$ >> "$LOOP_FREE_MARK"\nexec sleep 60\n',
    setup: async (c) => {
      c.story('ACME-1', 'blocked', 'Deploy failed.');
      c.commit('Start');
      mkdirSync(join(c.stateDir, 'locks'), { recursive: true });
      // A release lock a dead run left, at a stage the start-up must always finish.
      const dead = spawnSync(process.execPath, ['-e', '0']).pid;
      writeFileSync(
        join(c.stateDir, 'locks', 'ship.json'),
        JSON.stringify({ pid: dead, slot: 'w1', story: 'ACME-1', by: 'factory', at: new Date().toISOString(), stage: 'hosted-db' }),
      );
    },
  });

  it('starts its session past the gate', async () => {
    ctx.start();
    await ctx.waitFor('the start-up finish', () => ctx.events().includes('Start-up: finishing the release of ACME-1.'), stretchByLoad(40_000));
    await ctx.waitFor(
      'the session, or the gate dropping the item',
      () => (ctx.claudeCalls().includes('ACME-1') && ctx.markPids().length > 0) || ctx.events().some((t) => t.startsWith('ACME-1 not resumed')),
      stretchByLoad(30_000),
    );

    expect(ctx.events().filter((t) => t.startsWith('ACME-1 not resumed'))).toEqual([]);
    expect(ctx.claudeCalls()).toEqual(['ACME-1']);
    expect(ctx.gone(ctx.markPids()[0])).toBe(false);

    expect(ctx.foreman('stop', '--now').status).toBe(0);
  }, 180_000);
});

describe('a story that halts the release line, then blocked again by the owner', () => {
  const ctx = withLoopFree({
    config: { slots: 1, workers: 1 },
    claude: (c) => `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const id = process.env.FOREMAN_STORY;
const log = process.env.LOOP_FREE_CLAUDE;
const before = readFileSync(log, 'utf8').split('\\n').filter((l) => l === id).length;
appendFileSync(log, id + '\\n');
if (before > 0) process.exit(1);
const run = (...args) => spawnSync(process.execPath, [${JSON.stringify(BIN)}, ...args], { stdio: 'ignore' });
run('story', 'start', id);
run('story', 'block', id, '--reason', 'Deploy failed.');
writeFileSync(${JSON.stringify(join(c.stateDir, 'HALT'))}, 'A release failed.\\n');
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, result: 'Deploy failed.\\nFACTORY_RESULT: halted ' + id, total_cost_usd: 0, session_id: 'fake' }));
`,
    setup: async (c) => {
      c.story('ACME-1', 'todo');
      c.commit('Start');
    },
  });

  it('records the story at the hold, and does not resume it once the owner changed it', async () => {
    ctx.start();
    await ctx.waitFor('the hold', () => ctx.slot('w1')?.state === 'held' && ctx.slot('w1').haltedBy === true && ctx.loop()?.state === 'halted', stretchByLoad(60_000));
    expect(ctx.slot('w1').heldWas).toEqual({ status: 'blocked', blockedBy: 'Deploy failed.' });

    // The owner changes the block while the line is halted.
    expect(ctx.foreman('story', 'block', 'ACME-1', '--reason', 'Owner: on hold').status).toBe(0);
    expect(ctx.foreman('fixed').status).toBe(0);
    await ctx.waitFor('the halt to clear', () => ctx.events().some((t) => t.startsWith('Halt cleared')), stretchByLoad(30_000));
    await ctx.waitFor('the story not resumed, or a second session', () => ctx.events().includes(NOT_RESUMED) || ctx.claudeCalls().length > 1, stretchByLoad(30_000));

    expect(ctx.events()).toContain(NOT_RESUMED);
    expect(ctx.claudeCalls()).toEqual(['ACME-1']);
    expect(ctx.slot('w1').state).toBe('idle');
    expect(ctx.slot('w1').heldStory).toBeNull();
    await ctx.waitFor('the claim to go', () => !existsSync(join(ctx.stateDir, 'claims', 'ACME-1.json')), stretchByLoad(30_000));

    expect(ctx.foreman('stop', '--now').status).toBe(0);
  }, 180_000);
});
