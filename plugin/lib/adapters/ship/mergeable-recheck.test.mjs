import { describe, expect, it } from 'vitest';
import recheck from './mergeable-recheck.mjs';
import pr from './pr.mjs';
import merge from './merge.mjs';
import mergeMain from './merge-main.mjs';
import { runShip } from '../../engine/ship.mjs';
import { fakeCtx } from '../../../../test/ship-fakes.mjs';

const ANCESTOR = 'git merge-base --is-ancestor origin/main HEAD';
const VIEW = 'gh pr view 12 --json mergeable';
const ctxWith = (rules) => fakeCtx({ rules, prNumber: 12 });

describe('mergeable-recheck step', () => {
  it('needs git and gh, and is never a point of no return', () => {
    expect(recheck.name).toBe('mergeable-recheck');
    expect(recheck.needs).toEqual(['git', 'gh']);
    expect(recheck.pointOfNoReturn).toBeFalsy();
  });

  it('passes when the base has not moved and GitHub says MERGEABLE', async () => {
    const ctx = ctxWith([[VIEW, 'MERGEABLE\n']]);
    expect(await recheck.run(ctx)).toEqual({ ok: true });
    expect(ctx.sh.calls[0]).toBe('git fetch --quiet origin main');
    expect(ctx.sh.calls).toContain(ANCESTOR);
  });

  it('exits 1 when the base moved since the branch was tested', async () => {
    const ctx = ctxWith([[ANCESTOR, 1]]);
    expect(await recheck.run(ctx)).toEqual({
      ok: false,
      code: 1,
      stage: 'mergeable-recheck',
      reason: 'main moved since this branch was tested; ship again to merge it in and re-run CI.',
      again: true,
    });
    expect(ctx.sh.calls.some((c) => c.startsWith('gh '))).toBe(false);
  });

  it('exits 1 when the fetch fails', async () => {
    const ctx = ctxWith([['git fetch', 1]]);
    const r = await recheck.run(ctx);
    expect(r).toMatchObject({ ok: false, code: 1, stage: 'mergeable-recheck' });
    expect(r.again).toBeUndefined();
  });

  it('polls while UNKNOWN, up to 6 times 5 s', async () => {
    let n = 0;
    const ctx = ctxWith([[VIEW, () => (++n < 3 ? 'UNKNOWN' : 'MERGEABLE')]]);
    expect((await recheck.run(ctx)).ok).toBe(true);
    expect(ctx.sleeps).toEqual([5_000, 5_000]);

    const stuck = ctxWith([[VIEW, 'UNKNOWN']]);
    const r = await recheck.run(stuck);
    expect(r).toMatchObject({ ok: false, code: 1, stage: 'mergeable-recheck' });
    expect(r.reason).toContain('UNKNOWN');
    expect(r.again).toBeUndefined();
    expect(stuck.sh.calls.filter((c) => c.startsWith(VIEW))).toHaveLength(6);
  });

  it('exits 1 naming the state when the pull request is CONFLICTING', async () => {
    const r = await recheck.run(ctxWith([[VIEW, 'CONFLICTING']]));
    expect(r).toMatchObject({ ok: false, code: 1, stage: 'mergeable-recheck' });
    expect(r.reason).toContain('CONFLICTING');
    // The local tree would merge cleanly, so bringing main in again would only burn CI runs.
    expect(r.again).toBeUndefined();
  });

  it('exits 1 when no pull request number is known', async () => {
    const r = await recheck.run(fakeCtx());
    expect(r).toMatchObject({ ok: false, code: 1, stage: 'mergeable-recheck' });
    expect(r.again).toBeUndefined();
  });
});

describe('release where main keeps moving between CI and the recheck', () => {
  it('brings main in 5 times, then exits 1 with no migrate, no merge and no HALT', async () => {
    const ctx = fakeCtx({
      rules: [
        ['gh pr view story/s-1', JSON.stringify({ number: 12, url: 'u', state: 'OPEN' })],
        [VIEW, 'MERGEABLE'],
        // The branch is up to date with main until CI has run; after that main always looks moved.
        [ANCESTOR, (line, calls) => (calls.includes('fake ci done') ? 1 : 0)],
      ],
    });
    let ciRuns = 0;
    const ci = { name: 'ci', run: async () => { ciRuns++; ctx.sh('fake', ['ci', 'done']); return { ok: true }; } };
    const migrated = [];
    const migrate = { name: 'migrate-supabase', pointOfNoReturn: true, run: async () => { migrated.push(1); return { ok: true }; } };
    const { code, result } = await runShip({ steps: [pr, ci, recheck, migrate, merge], ctx });
    expect(code).toBe(1);
    expect(result.stage).toBe('mergeable-recheck');
    expect(result.reason.startsWith('main kept moving')).toBe(true);
    expect(migrated).toEqual([]);
    expect(ctx.sh.calls.some((c) => c.startsWith('gh pr merge'))).toBe(false);
    expect(ctx.halts).toEqual([]);
    expect(ciRuns).toBe(6);
  });
});

describe('release where main moves before merge', () => {
  const MERGE_MAIN = 'git merge --no-edit --quiet origin/main';
  const UNMERGED = 'git diff --name-only --diff-filter=U';

  // Main moves `moves` times after CI: the ancestor check says "moved" at the recheck and at the
  // merge-main after it, for the first `moves` passes, and "up to date" otherwise.
  const ancestorAfter = (moves) => (line, calls) => {
    const k = calls.filter((c) => c === ANCESTOR).length - 1;
    return k >= 1 && k <= 2 * moves ? 1 : 0;
  };

  function release(moves, extraRules = []) {
    const ctx = fakeCtx({ rules: [...extraRules, [ANCESTOR, ancestorAfter(moves)], [VIEW, 'MERGEABLE']] });
    const runs = { push: 0, pr: 0, ci: 0, merge: 0 };
    const fake = (name, result = { ok: true }, extra = {}) => ({ name, ...extra, run: async () => { runs[name]++; return result; } });
    const steps = [
      mergeMain,
      fake('push'),
      fake('pr', { ok: true, prNumber: 12 }),
      fake('ci'),
      recheck,
      fake('merge', { ok: true, sha: 'abc' }, { pointOfNoReturn: true, beforeNoReturn: true }),
    ];
    return { ctx, runs, run: () => runShip({ steps, ctx }) };
  }

  it.each([1, 2, 3])('main moving %i time(s) after CI ships with code 0 and merges once', async (moves) => {
    const { ctx, runs, run } = release(moves);
    const { code, result } = await run();
    expect(code).toBe(0);
    expect(result.stage).toBe('shipped');
    expect(runs.merge).toBe(1);
    expect(runs.ci).toBe(moves + 1);
    expect(ctx.sh.calls.filter((c) => c === MERGE_MAIN)).toHaveLength(moves);
    expect(ctx.halts).toEqual([]);
    expect(ctx.sh.calls).not.toContain('git merge --abort');
    expect(ctx.locks.held.has('ship')).toBe(false);
  });

  it('a clean re-merge uses no conflict round', async () => {
    const { ctx, run } = release(2);
    const { code, result } = await run();
    expect(code).toBe(0);
    expect(result).not.toHaveProperty('conflicts');
    expect(result).not.toHaveProperty('again');
    expect(ctx.events.some((e) => /conflict/i.test(e.text))).toBe(false);
    expect(ctx.events.filter((e) => e.kind === 'info').map((e) => e.text)).toEqual([
      'main moved while S-1 was releasing; bringing it in again (1 of 5).',
      'main moved while S-1 was releasing; bringing it in again (2 of 5).',
    ]);
  });

  it('a re-merge that conflicts in real code exits 6 with the files, aborted, unmerged and unhalted', async () => {
    const { ctx, runs, run } = release(1, [[MERGE_MAIN, 1], [UNMERGED, 'src/acme.js\n']]);
    const { code, result } = await run();
    expect(code).toBe(6);
    expect(result).toMatchObject({ stage: 'merge-main', conflicts: ['src/acme.js'] });
    expect(ctx.sh.calls).toContain('git merge --abort');
    expect(runs.merge).toBe(0);
    expect(runs.ci).toBe(1);
    expect(ctx.halts).toEqual([]);
    expect(ctx.locks.held.has('ship')).toBe(false);
  });

  it('main moving 6 times exits 1 at mergeable-recheck and never merges', async () => {
    const { runs, run } = release(6);
    const { code, result } = await run();
    expect(code).toBe(1);
    expect(result.stage).toBe('mergeable-recheck');
    expect(result.reason).toMatch(/^main kept moving: brought it in 5 times during this release\. /);
    expect(runs.merge).toBe(0);
    expect(runs.ci).toBe(6);
  });

  it('main moving 5 times still ships', async () => {
    const { runs, run } = release(5);
    expect((await run()).code).toBe(0);
    expect(runs.merge).toBe(1);
  });

  it('main moving twice runs the real pr step three times but raises review on the story once', async () => {
    const open = JSON.stringify({ number: 12, url: 'https://gh/pull/12', state: 'OPEN' });
    const ctx = fakeCtx({ rules: [['gh pr view story/s-1', open], [ANCESTOR, ancestorAfter(2)], [VIEW, 'MERGEABLE']] });
    const raised = [];
    const spy = (...args) => {
      raised.push(args);
      return { ok: true };
    };
    const fake = (name, result = { ok: true }, extra = {}) => ({ name, ...extra, run: async () => result });
    const steps = [
      mergeMain,
      fake('push'),
      { ...pr, run: (c) => pr.run(c, { raiseStoryEvent: spy }) },
      fake('ci'),
      recheck,
      fake('merge', { ok: true, sha: 'abc' }, { pointOfNoReturn: true, beforeNoReturn: true }),
    ];
    const { code } = await runShip({ steps, ctx });
    expect(code).toBe(0);
    expect(ctx.sh.calls.filter((c) => c.startsWith('gh pr view story/s-1'))).toHaveLength(3);
    expect(raised).toHaveLength(1);
    expect(raised[0][2]).toBe('review');
  });
});
