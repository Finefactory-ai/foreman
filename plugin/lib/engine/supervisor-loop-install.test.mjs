// A real supervisor run whose slot install (`sleep 30` in place of `npm ci`) is slow: the install
// runs in a child of its own, so the supervisor keeps ticking (a pause is applied), the dashboard
// answers, and `foreman stop --now` ends the install with the run. A fake `claude` and `gh` on the
// PATH stand in for the session and GitHub.

import { describe, expect, it } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { holdsTheLoopFree, withLoopFree } from '../../../test/loop-free-fixture.mjs';

const ctx = withLoopFree({
  config: { install: { when: 'package.json', run: 'echo $$ >> "$LOOP_FREE_MARK"; sleep 30' } },
  setup: async (c) => {
    c.story('ACME-1');
    writeFileSync(join(c.clone, 'package.json'), '{"name":"acme"}\n');
    c.commit('Add the story and package.json');
  },
});

describe('a supervisor run while a slot installs slowly', () => {
  it('keeps ticking and answering, and `foreman stop --now` ends the install with the run', async () => {
    ctx.start();
    await ctx.waitFor('the install to start', () => ctx.markPids().length > 0, 40_000);
    const [pid] = ctx.markPids();
    expect(ctx.slot('w1')).toMatchObject({ state: 'building', story: { id: 'ACME-1', detail: 'preparing the slot' } });

    await holdsTheLoopFree(ctx, { pid });

    expect(existsSync(join(ctx.stateDir, 'slots', 'w1.install'))).toBe(false);
    expect(ctx.claudeCalls()).toEqual([]);
  }, 120_000);
});
