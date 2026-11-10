// A real supervisor run whose pick fetches main into slot w1's worktree through a slow `git fetch`
// (a wrapper that sleeps 30 for that folder): the fetch runs in a child of its own, so the
// supervisor keeps ticking (a pause is applied), the dashboard answers, and `foreman stop --now`
// ends the fetch with the run.

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '../../../test/state-repos.mjs';
import { holdsTheLoopFree, withLoopFree } from '../../../test/loop-free-fixture.mjs';

const ctx = withLoopFree({
  git: `case "$1" in
  fetch)
    case "$(pwd -P)" in
      */worktrees/w1) echo $$ >> "$LOOP_FREE_MARK"; sleep 30 ;;
    esac ;;
esac`,
  setup: async (c) => {
    c.story('ACME-1');
    c.commit('Add the story');
    // The slot's worktree exists before the run, so its pick fetches rather than creates.
    git(c.clone, 'worktree', 'add', '--detach', join(c.stateDir, 'worktrees', 'w1'), 'origin/main');
  },
});

describe('a supervisor run while the pick fetches slowly', () => {
  it('keeps ticking and answering, and `foreman stop --now` ends the fetch with the run', async () => {
    ctx.start();
    await ctx.waitFor('the fetch to start', () => ctx.markPids().length > 0, 40_000);
    const [pid] = ctx.markPids();
    expect(ctx.slot('w1')).toMatchObject({ state: 'building', story: { id: 'ACME-1', detail: 'preparing the slot' } });
    expect(existsSync(join(ctx.stateDir, 'claims', 'ACME-1.json'))).toBe(true);

    await holdsTheLoopFree(ctx, { pid });

    expect(ctx.claudeCalls()).toEqual([]);
  }, 120_000);
});
