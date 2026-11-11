// A HALT written by `foreman ship` holds the ship state object (the facts first, then stage and
// reason). The owner sees the step's reason, never the object: as the loop reason, on
// /api/status, in `foreman status` (its headline and the Waiting on you item), and in the
// decision the story skill adds with the same JSON line as its body.

import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withLoopFree } from '../../../test/loop-free-fixture.mjs';

const R = 'qa (acme-qa) was rolled back with `foreman sf rollback "$FOREMAN_STORY"`. ./watch.sh reported a problem after the deploy: 3 new errors';
const STATE = {
  sfDelta: { dir: '/tmp/acme-delta', from: 'a'.repeat(40), to: 'b'.repeat(40), components: Array.from({ length: 12 }, (_, i) => `classes/AcmeService${i}.cls`) },
  sfDeploys: { qa: { org: 'acme-qa', jobId: '0Af000000000001AAA' } },
  stage: 'watch',
  reason: R,
  rolledBack: true,
  pr: 'https://github.com/acme/acme/pull/5',
};

const ctx = withLoopFree({
  setup: async (c) => {
    c.commit('Start');
    mkdirSync(c.stateDir, { recursive: true });
    writeFileSync(join(c.stateDir, 'HALT'), `2026-11-10T11:27:00.000Z ${JSON.stringify(STATE)}\n`);
  },
});

describe('a HALT written with the ship state object', () => {
  it('shows the step reason on the loop, /api/status, foreman status and the decision, with no brace', async () => {
    expect(JSON.stringify(STATE).length).toBeGreaterThan(300);
    ctx.start();
    await ctx.waitFor('the halt', () => ctx.loop()?.state === 'halted', 40_000);
    expect(ctx.loop().reason).toBe(R);

    await ctx.waitFor('the dashboard', () => ctx.out.includes('Dashboard: '), 20_000);
    const status = await (await fetch(`http://127.0.0.1:${ctx.port}/api/status`)).json();
    expect(status.loop.reason).toBe(R);

    const added = ctx.foreman('decide', 'add', '--story', 'ACME-1', '--kind', 'task', '--urgent', '--title', 'ACME-1 stopped the release line', '--body', JSON.stringify({ ok: false, code: 5, ...STATE }));
    expect(added.status).toBe(0);

    const shown = ctx.foreman('status');
    expect(shown.status).toBe(0);
    expect(shown.stdout).toContain(`Foreman: halted: ${R}`);
    expect(shown.stdout).toMatch(new RegExp(`The run is halted\\n\\s+${R.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    expect(shown.stdout).toMatch(new RegExp(`ACME-1 stopped the release line\\n\\s+${R.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    expect(shown.stdout).not.toContain('{');

    expect(ctx.foreman('stop', '--now').status).toBe(0);
    expect(await ctx.child.exited).toBe(130);
  }, 120_000);
});
