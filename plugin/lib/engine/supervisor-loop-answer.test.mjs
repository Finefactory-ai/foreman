// A real supervisor run whose owner answer ("Drop" on a story that could not pass review) is
// applied through a slow `gh pr list` (a fake that sleeps 30): the answer step runs in a child of
// its own, so the supervisor keeps ticking (a pause is applied), the dashboard answers, and
// `foreman stop --now` ends the step with the run.

import { describe, expect, it } from 'vitest';
import * as decisions from '../console/decisions.mjs';
import { holdsTheLoopFree, withLoopFree } from '../../../test/loop-free-fixture.mjs';

const SLOW_GH = `#!/bin/sh
case "$1 $2" in
  "pr list")
    case " $* " in
      *" --head "*) echo $$ >> "$LOOP_FREE_MARK"; sleep 30 ;;
    esac
    echo "[]" ;;
  *) exit 1 ;;
esac
`;

const ctx = withLoopFree({
  gh: SLOW_GH,
  setup: async (c) => {
    c.story('ACME-1', 'blocked', 'Factory could not pass review; nothing was built');
    c.commit('Add the blocked story');
    const id = decisions.add(c.stateDir, { story: 'ACME-1', kind: 'decision', title: 'ACME-1 could not pass review', options: ['Retry with a note to the architect', "I'll take it", 'Drop'] });
    decisions.answer(c.stateDir, id, { option: 'Drop', note: '' });
  },
});

describe('a supervisor run while an owner answer applies slowly', () => {
  it('keeps ticking and answering, and `foreman stop --now` ends the step with the run', async () => {
    ctx.start();
    await ctx.waitFor('the answer step to start', () => ctx.markPids().length > 0, 40_000);
    const [pid] = ctx.markPids();
    await ctx.waitFor('the event', () => ctx.events().includes('Applying your answer to "ACME-1 could not pass review".'), 10_000);

    await holdsTheLoopFree(ctx, { pid });

    expect(ctx.claudeCalls()).toEqual([]);
  }, 120_000);
});
