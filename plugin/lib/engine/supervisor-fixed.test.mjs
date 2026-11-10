// `foreman fixed` on a run that began with a halt: with no health checks configured, the health
// check child (`foreman health`) passes at once and the halt is cleared. That the loop stays free
// while a slow check runs is proven in supervisor-loop-health.test.mjs.

import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withLoopFree } from '../../../test/loop-free-fixture.mjs';

const ctx = withLoopFree({
  setup: async (c) => {
    c.commit('Start');
    mkdirSync(c.stateDir, { recursive: true });
    writeFileSync(join(c.stateDir, 'HALT'), 'A release failed.\n');
  },
});

describe('foreman fixed on a halted run', () => {
  it('clears the halt once the health check passes, and says so', async () => {
    ctx.start();
    await ctx.waitFor('the halt', () => ctx.loop()?.state === 'halted', 40_000);

    expect(ctx.foreman('fixed').status).toBe(0);
    await ctx.waitFor('the halt to clear', () => !existsSync(join(ctx.stateDir, 'HALT')), 20_000);
    await ctx.waitFor('the event', () => ctx.events().includes('Halt cleared; no health checks are configured.'), 10_000);
  }, 120_000);
});
