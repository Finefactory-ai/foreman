// A real supervisor run whose owner answer ("Retry with a note to the architect" on a story that
// could not pass review) fails at its first step, `foreman story todo`: the story's overlay file
// cannot be written (a folder stands where it goes). The supervisor keeps the failure in
// state.json's answerFailures ({ id, step, tries, retryAt }, what Waiting on you reads as "could
// not apply: <step>") and says when it tries again. Waiting on the growing wait would take a
// minute, so the test mends the overlay and writes control.json's answerRetry, as the Retry
// button does: the supervisor says it retries now and applies the answer again before the
// retryAt, and the failure is gone. A second run marks the answer applied by hand instead: the
// supervisor forgets the failure at its next tick, with no Retry and no second attempt. Acme ids only.

import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as decisions from '../console/decisions.mjs';
import { retryAnswer } from '../console/control.mjs';
import { withLoopFree } from '../../../test/loop-free-fixture.mjs';

const TITLE = 'ACME-1 could not pass review';
const STEP = 'putting ACME-1 back to todo';

const ctx = withLoopFree({
  setup: async (c) => {
    c.story('ACME-1', 'blocked', 'Factory could not pass review; nothing was built');
    c.commit('Add the blocked story');
    // A folder where the story's overlay file goes: `foreman story todo` cannot write it.
    mkdirSync(join(c.stateDir, 'stories', 'ACME-1.json'), { recursive: true });
    c.decision = decisions.add(c.stateDir, { story: 'ACME-1', kind: 'decision', title: TITLE, options: ['Retry with a note to the architect', "I'll take it", 'Drop'] });
    decisions.answer(c.stateDir, c.decision, { option: 'Retry with a note to the architect', note: 'Use the cache' });
  },
});

const failures = () => {
  try {
    return JSON.parse(readFileSync(join(ctx.stateDir, 'state.json'), 'utf8')).answerFailures ?? [];
  } catch {
    return [];
  }
};
const count = (text) => ctx.events().filter((t) => t === text).length;

describe('a supervisor run whose owner answer fails to apply', () => {
  it('keeps the failure in state.json, tries again at a time it names, and applies the answer again when the owner presses Retry', async () => {
    ctx.start();
    await ctx.waitFor('the failure in state.json', () => failures().length === 1, 40_000);

    const [failure] = failures();
    expect(failure).toMatchObject({ id: ctx.decision, story: 'ACME-1', title: TITLE, step: STEP, tries: 1 });
    expect(Date.parse(failure.retryAt)).toBeGreaterThan(Date.now());
    const warn = ctx.events().find((t) => t.startsWith(`Could not apply your answer to "${TITLE}": ${STEP} failed.`));
    expect(warn).toContain(' Foreman tries it again at ');
    expect(count(`Applying your answer to "${TITLE}".`)).toBe(1);

    // The owner mends the cause and presses Retry: the answer is applied again at once, though the
    // retryAt is a minute away.
    rmSync(join(ctx.stateDir, 'stories', 'ACME-1.json'), { recursive: true, force: true });
    retryAnswer(ctx.stateDir, ctx.decision);
    await ctx.waitFor('the retry event', () => ctx.events().includes(`Retrying your answer to "${TITLE}" now.`), 20_000);
    await ctx.waitFor('the answer applied again', () => ctx.events().includes(`Applied your answer to "${TITLE}": Retry with a note to the architect.`), 30_000);

    expect(count(`Applying your answer to "${TITLE}".`)).toBe(2);
    expect(failures()).toEqual([]);
    expect(decisions.list(ctx.stateDir).find((d) => d.id === ctx.decision).appliedAt).toBeTruthy();
  }, 120_000);

  it('forgets the failure, with no Retry, once the answer is applied by hand', async () => {
    ctx.start();
    await ctx.waitFor('the failure in state.json', () => failures().length === 1, 40_000);
    expect(failures()[0]).toMatchObject({ id: ctx.decision, step: STEP, tries: 1 });

    // The owner applies the answer by hand: it is no longer pending. The folder stays, so a real
    // apply would fail again, and the retryAt is a minute away, so only the prune can empty the list.
    decisions.applied(ctx.stateDir, ctx.decision);
    await ctx.waitFor('the failure forgotten', () => failures().length === 0, 20_000);

    expect(count(`Applying your answer to "${TITLE}".`)).toBe(1);
    expect(ctx.events()).not.toContain(`Retrying your answer to "${TITLE}" now.`);
    expect(ctx.events().filter((t) => t.startsWith(`Applied your answer to "${TITLE}"`))).toEqual([]);
  }, 120_000);
});
