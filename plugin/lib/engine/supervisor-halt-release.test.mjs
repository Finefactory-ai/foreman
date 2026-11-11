// Clearing a halt on a run whose held slots hold stories the owner has since skipped, blocked or
// finished: the slots are freed with a "not resumed" event and no session starts for them, while
// a halted story that is unchanged since its hold resumes (FM-428).

import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { withLoopFree } from '../../../test/loop-free-fixture.mjs';
import { stretchByLoad } from '../../../test/slow-tests.mjs';

const WAS_HALTED = { status: 'blocked', blockedBy: 'Deploy failed.' };
const heldSlot = (slot, id, { haltedBy, heldWas }) => ({
  state: 'held',
  reason: 'This story stopped the release line; waiting for you to fix the cause.',
  heldStory: id,
  haltedBy,
  heldFor: null,
  story: { id, title: `Story ${id}`, stage: 'release', detail: 'held' },
  result: null,
  heldWas,
  since: `2026-11-10T10:0${slot.slice(1)}:00.000Z`,
});

const holdSetup = (c) => {
  mkdirSync(join(c.stateDir, 'slots'), { recursive: true });
  mkdirSync(join(c.stateDir, 'claims'), { recursive: true });
  writeFileSync(join(c.stateDir, 'HALT'), 'A release failed.\n');
};

describe('clearing a halt', () => {
  const ctx = withLoopFree({
    config: { slots: 4, workers: 4 },
    setup: async (c) => {
      c.story('ACME-1', 'blocked', 'Deploy failed.');
      c.story('ACME-2', 'blocked', 'Owner: on hold');
      c.story('ACME-3', 'done');
      c.story('ACME-4', 'blocked', 'Deploy failed.');
      c.commit('Start');
      holdSetup(c);
      const slots = {
        w1: heldSlot('w1', 'ACME-1', { haltedBy: true, heldWas: WAS_HALTED }),
        w2: heldSlot('w2', 'ACME-2', {
          haltedBy: false,
          heldWas: { status: 'in-progress', blockedBy: '' },
        }),
        w3: heldSlot('w3', 'ACME-3', { haltedBy: true, heldWas: WAS_HALTED }),
        w4: heldSlot('w4', 'ACME-4', { haltedBy: true, heldWas: WAS_HALTED }),
      };
      for (const [w, st] of Object.entries(slots)) writeFileSync(join(c.stateDir, 'slots', `${w}.json`), JSON.stringify(st));
      // A stale factory claim, as a run that died leaves: start-up queues a resume for it.
      const dead = spawnSync(process.execPath, ['-e', '0']);
      writeFileSync(
        join(c.stateDir, 'claims', 'ACME-1.json'),
        JSON.stringify({
          pid: dead.pid,
          slot: 'w1',
          story: 'ACME-1',
          by: 'factory',
          at: new Date().toISOString(),
        }),
      );
    },
  });

  it('frees the slots of skipped, blocked and done stories, and resumes the open one', async () => {
    ctx.start();
    await ctx.waitFor('the halt', () => ctx.loop()?.state === 'halted', 40_000);
    await ctx.waitFor('the start-up resume', () => ctx.events().includes('Start-up: resuming ACME-1.'), 20_000);

    expect(ctx.foreman('slot', 'w1', 'skip').status).toBe(0);
    await ctx.waitFor('the skip', () => ctx.events().includes('ACME-1 skipped for this run.'), 20_000);

    expect(ctx.foreman('fixed').status).toBe(0);
    await ctx.waitFor('the halt to clear', () => ctx.events().some((t) => t.startsWith('Halt cleared')), 20_000);

    await ctx.waitFor(
      'the stories not resumed and the open one built',
      () => {
        const events = ctx.events();
        return (
          events.some((t) => /^ACME-1 not resumed: you skipped it for this run; slot w\d is free\.$/.test(t)) &&
          events.includes('ACME-2 not resumed: its story is blocked; slot w2 is free.') &&
          events.includes('ACME-3 not resumed: its story is done; slot w3 is free.') &&
          ctx.claudeCalls().includes('ACME-4')
        );
      },
      stretchByLoad(30_000),
    );

    const calls = ctx.claudeCalls();
    for (const id of ['ACME-1', 'ACME-2', 'ACME-3']) expect(calls).not.toContain(id);
    expect(ctx.slot('w2').heldStory).toBeNull();
    expect(ctx.slot('w3').heldStory).toBeNull();

    expect(ctx.foreman('stop', '--now').status).toBe(0);
  }, 180_000);
});

describe('clearing a halt while an idle slot comes before the held one', () => {
  // The held, halted, unchanged story is in w2 and w1 is idle: w1 takes the leftover ranked
  // resume (no `was`, so the gate refuses it) before w2 gets its after-halt work.
  const ctx = withLoopFree({
    config: { slots: 2, workers: 2 },
    claude: '#!/bin/sh\necho "$FOREMAN_STORY" >> "$LOOP_FREE_CLAUDE"\necho $$ >> "$LOOP_FREE_MARK"\nexec sleep 20\n',
    setup: async (c) => {
      c.story('ACME-1', 'blocked', 'Deploy failed.');
      c.commit('Start');
      holdSetup(c);
      writeFileSync(join(c.stateDir, 'slots', 'w2.json'), JSON.stringify(heldSlot('w2', 'ACME-1', { haltedBy: true, heldWas: WAS_HALTED })));
      const dead = spawnSync(process.execPath, ['-e', '0']);
      writeFileSync(
        join(c.stateDir, 'claims', 'ACME-1.json'),
        JSON.stringify({
          pid: dead.pid,
          slot: 'w1',
          story: 'ACME-1',
          by: 'factory',
          at: new Date().toISOString(),
        }),
      );
    },
  });

  it('drops the duplicate quietly and resumes the held story in after-halt mode', async () => {
    ctx.start();
    await ctx.waitFor('the halt', () => ctx.loop()?.state === 'halted', 40_000);
    await ctx.waitFor('the start-up resume', () => ctx.events().includes('Start-up: resuming ACME-1.'), 20_000);

    expect(ctx.foreman('fixed').status).toBe(0);
    await ctx.waitFor('the halt to clear', () => ctx.events().some((t) => t.startsWith('Halt cleared')), 20_000);
    await ctx.waitFor('the after-halt session', () => ctx.claudeCalls().includes('ACME-1') && ctx.events().some((t) => t.includes('after-halt ACME-1')), stretchByLoad(30_000));
    await ctx.waitFor('the queue to empty', () => JSON.parse(readFileSync(join(ctx.stateDir, 'state.json'), 'utf8')).queued?.length === 0, stretchByLoad(30_000));

    expect(ctx.events().filter((t) => t.includes('not resumed'))).toEqual([]);
    expect(ctx.claudeCalls()).toEqual(['ACME-1']);
    expect(ctx.slot('w2').state).toBe('building');
    expect(existsSync(join(ctx.stateDir, 'claims', 'ACME-1.json'))).toBe(true);

    expect(ctx.foreman('stop', '--now').status).toBe(0);
  }, 180_000);
});

describe('clearing a halt while the held story is not skipped', () => {
  // The fake session for ACME-1 stays alive. The slot w2 is parked, so the leftover ranked resume
  // (queued at start-up from the stale claim) waits until w2 is unparked, after the session runs:
  // only the running check then stands between that duplicate and the claim.
  const ctx = withLoopFree({
    config: { slots: 2, workers: 2 },
    claude: '#!/bin/sh\necho "$FOREMAN_STORY" >> "$LOOP_FREE_CLAUDE"\necho $$ >> "$LOOP_FREE_MARK"\nexec sleep 60\n',
    setup: async (c) => {
      c.story('ACME-1', 'blocked', 'Deploy failed.');
      c.commit('Start');
      holdSetup(c);
      writeFileSync(join(c.stateDir, 'slots', 'w1.json'), JSON.stringify(heldSlot('w1', 'ACME-1', { haltedBy: true, heldWas: WAS_HALTED })));
      writeFileSync(
        join(c.stateDir, 'slots', 'w2.json'),
        JSON.stringify({ state: 'parked', parkedFor: 'owner', parkedStory: null, reason: 'Parked by you.', story: null, result: null, since: '2026-11-10T10:02:00.000Z' }),
      );
      const dead = spawnSync(process.execPath, ['-e', '0']);
      writeFileSync(
        join(c.stateDir, 'claims', 'ACME-1.json'),
        JSON.stringify({
          pid: dead.pid,
          slot: 'w1',
          story: 'ACME-1',
          by: 'factory',
          at: new Date().toISOString(),
        }),
      );
    },
  });
  const queued = (c) => JSON.parse(readFileSync(join(c.stateDir, 'state.json'), 'utf8')).queued;

  it('keeps the claim and says nothing of the story its session runs', async () => {
    ctx.start();
    await ctx.waitFor('the halt', () => ctx.loop()?.state === 'halted', 40_000);
    await ctx.waitFor('the start-up resume', () => ctx.events().includes('Start-up: resuming ACME-1.'), 20_000);

    expect(ctx.foreman('fixed').status).toBe(0);
    await ctx.waitFor('the halt to clear', () => ctx.events().some((t) => t.startsWith('Halt cleared')), 20_000);
    await ctx.waitFor('the session', () => ctx.claudeCalls().includes('ACME-1') && ctx.markPids().length > 0 && ctx.slot('w1').state === 'building', stretchByLoad(30_000));

    // The leftover ranked resume waits for a free slot; w1's session has already cleared its pin.
    const waiting = queued(ctx);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ id: 'ACME-1', slot: null, ranked: true });

    expect(ctx.foreman('slot', 'w2', 'unpark').status).toBe(0);
    await ctx.waitFor('the duplicate to reach the gate', () => queued(ctx)?.length === 0 && ctx.slot('w2').state === 'idle', stretchByLoad(30_000));

    const pid = ctx.markPids()[0];
    expect(ctx.gone(pid)).toBe(false);
    expect(ctx.claudeCalls()).toEqual(['ACME-1']);
    expect(existsSync(join(ctx.stateDir, 'claims', 'ACME-1.json'))).toBe(true);
    expect(ctx.slot('w1').state).toBe('building');
    expect(ctx.events().filter((t) => t.startsWith('ACME-1 not resumed'))).toEqual([]);

    expect(ctx.foreman('stop', '--now').status).toBe(0);
  }, 180_000);
});
