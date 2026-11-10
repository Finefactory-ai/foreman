// A real supervisor run that began with a halt, whose health check after `foreman fixed` (a watch
// command that sleeps 30 s) is slow: the check runs in a child of its own, so the supervisor keeps
// ticking (a slot command is applied), the dashboard answers and the halt stays in place; and
// `foreman stop --now` ends the check with the run, without clearing the halt.

import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withLoopFree } from '../../../test/loop-free-fixture.mjs';

const ctx = withLoopFree({
  config: { ship: { steps: ['watch'], watch: { command: 'echo $$ >> "$LOOP_FREE_MARK"; sleep 30' } } },
  setup: async (c) => {
    c.commit('Start');
    mkdirSync(c.stateDir, { recursive: true });
    writeFileSync(join(c.stateDir, 'HALT'), 'A release failed.\n');
  },
});

describe('a supervisor run while the health check after a fix runs slowly', () => {
  it('keeps ticking and answering with the halt in place, and `foreman stop --now` ends the check with the run', async () => {
    const halt = join(ctx.stateDir, 'HALT');
    ctx.start();
    await ctx.waitFor('the halt', () => ctx.loop()?.state === 'halted', 40_000);

    expect(ctx.foreman('fixed').status).toBe(0);
    await ctx.waitFor('the health check to start', () => ctx.markPids().length > 0, 40_000);
    const [pid] = ctx.markPids();

    // While the check sleeps: the dashboard answers, a slot command is applied on a tick.
    await ctx.waitFor('the dashboard', () => ctx.out.includes('Dashboard: '), 20_000);
    const started = Date.now();
    const status = await fetch(`http://127.0.0.1:${ctx.port}/api/status`);
    expect(status.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(2000);

    expect(ctx.foreman('slot', 'w1', 'park').status).toBe(0);
    await ctx.waitFor('the slot to park', () => ctx.slot('w1')?.state === 'parked', 10_000);

    expect(ctx.gone(pid)).toBe(false);
    expect(existsSync(halt)).toBe(true);
    expect(ctx.loop().state).toBe('halted');
    expect(ctx.events().filter((t) => t.startsWith('Halt cleared'))).toEqual([]);

    // A stop in the middle of the check ends it, and an unfinished check never clears the halt.
    expect(ctx.foreman('stop', '--now').status).toBe(0);
    expect(await ctx.child.exited).toBe(130);
    await ctx.waitFor('the check to end', () => ctx.gone(pid), 5000);
    expect(ctx.events().filter((t) => /woke .* late/.test(t))).toEqual([]);
    expect(existsSync(halt)).toBe(true);
  }, 120_000);
});
