import { describe, expect, it } from 'vitest';
import merge from './merge.mjs';
import { fakeCtx } from '../../../../test/ship-fakes.mjs';

const base = (rules = []) =>
  fakeCtx({
    branch: 'story/s-1',
    pr: 'https://gh/pull/12',
    prNumber: 12,
    rules: [
      ...rules,
      ['gh pr view 12 --json state', 'MERGED\n'],
      ['git rev-parse --path-format=absolute --git-dir', '/repo/.git\n'],
      ['git rev-parse --path-format=absolute --git-common-dir', '/repo/.git\n'],
      ['git rev-parse origin/main', 'abc123\n'],
    ],
  });

describe('merge step', () => {
  it('is the point of no return', () => expect(merge.pointOfNoReturn).toBe(true));

  it('merges, cleans up the branch, and records the base sha', async () => {
    const ctx = base();
    expect(await merge.run(ctx)).toEqual({ ok: true, sha: 'abc123' });
    expect(ctx.sh.calls).toContain('gh pr merge 12 --merge');
    expect(ctx.sh.calls).toContain('git push --quiet origin --delete story/s-1');
    expect(ctx.sh.calls).toContain('git checkout --quiet main');
    expect(ctx.sh.calls).toContain('git pull --quiet --ff-only origin main');
    expect(ctx.sh.calls).toContain('git branch -D story/s-1');
  });

  it('uses the configured merge method', async () => {
    const ctx = base();
    ctx.config = { ...ctx.config, ship: { steps: ['merge'], pr: { mergeMethod: 'squash' } } };
    await merge.run(ctx);
    expect(ctx.sh.calls).toContain('gh pr merge 12 --squash');
  });

  it('a non-zero gh pr merge after a merge that did happen counts as merged', async () => {
    const ctx = base([['gh pr merge', { status: 1, stderr: 'cannot switch to main in a worktree' }]]);
    expect((await merge.run(ctx)).ok).toBe(true);
  });

  it('a pull request that did not merge exits 1', async () => {
    const ctx = base([['gh pr merge', 1], ['gh pr view 12 --json state', 'OPEN\n']]);
    expect(await merge.run(ctx)).toMatchObject({ ok: false, code: 1, stage: 'merge', pr: 'https://gh/pull/12' });
    expect(ctx.sh.calls.some((c) => c.startsWith('git branch -D'))).toBe(false);
  });

  it('in a worktree it detaches at the base instead of checking it out', async () => {
    const ctx = base([['git rev-parse --path-format=absolute --git-dir', '/repo/.git/worktrees/w1\n']]);
    await merge.run(ctx);
    expect(ctx.sh.calls).toContain('git checkout --quiet --detach origin/main');
    expect(ctx.sh.calls).not.toContain('git checkout --quiet main');
  });

  it('detaches when it cannot tell whether it is in a worktree', async () => {
    const ctx = base([['git rev-parse --path-format=absolute --git-common-dir', 128]]);
    await merge.run(ctx);
    expect(ctx.sh.calls).toContain('git checkout --quiet --detach origin/main');
    expect(ctx.sh.calls).not.toContain('git checkout --quiet main');
  });

  it('a failure to delete the remote branch is ignored', async () => {
    const ctx = base([['git push --quiet origin --delete', 1]]);
    expect((await merge.run(ctx)).ok).toBe(true);
  });

  const keep = (ctx) => {
    ctx.config = { ...ctx.config, ship: { steps: ['merge'], merge: { keepBranch: true } } };
    return ctx;
  };
  const deletes = (ctx) => ctx.sh.calls.filter((c) => c.startsWith('git push --quiet origin --delete') || c.startsWith('git branch -D'));

  it('keepBranch deletes no branch', async () => {
    const ctx = keep(base());
    expect(await merge.run(ctx)).toEqual({ ok: true, sha: 'abc123' });
    expect(deletes(ctx)).toEqual([]);
    expect(ctx.sh.calls).toContain('git checkout --quiet main');
    expect(ctx.sh.calls).toContain('git pull --quiet --ff-only origin main');
  });

  it('keepBranch in a worktree still detaches and deletes nothing', async () => {
    const ctx = keep(base([['git rev-parse --path-format=absolute --git-dir', '/repo/.git/worktrees/w1\n']]));
    expect((await merge.run(ctx)).ok).toBe(true);
    expect(ctx.sh.calls).toContain('git checkout --quiet --detach origin/main');
    expect(deletes(ctx)).toEqual([]);
  });

  it('a failed merge with keepBranch exits 1 as before', async () => {
    const ctx = keep(base([['gh pr merge', 1], ['gh pr view 12 --json state', 'OPEN\n']]));
    expect(await merge.run(ctx)).toMatchObject({ ok: false, code: 1, stage: 'merge', pr: 'https://gh/pull/12' });
    expect(deletes(ctx)).toEqual([]);
  });

  it('with ship.pr.into it records the target\'s sha', async () => {
    const ctx = base([['git rev-parse --verify refs/remotes/origin/qa', 'def456\n']]);
    ctx.config = { ...ctx.config, ship: { steps: ['merge'], pr: { into: 'qa' } } };
    expect(await merge.run(ctx)).toEqual({ ok: true, sha: 'def456' });
    // A full refspec and a full ref name: neither can be read as a git option.
    expect(ctx.sh.calls).toContain('git fetch --quiet origin +refs/heads/qa:refs/remotes/origin/qa');
    expect(ctx.sh.calls).toContain('git checkout --quiet main');
    expect(ctx.sh.calls).toContain('git pull --quiet --ff-only origin main');
  });

  it('forces the target fetch, so a reset qa branch still updates its tracking ref', async () => {
    const ctx = base([['git rev-parse --verify refs/remotes/origin/qa', 'def456\n']]);
    ctx.config = { ...ctx.config, ship: { steps: ['merge'], pr: { into: 'qa' } } };
    await merge.run(ctx);
    expect(ctx.sh.calls.find((c) => c.startsWith('git fetch --quiet origin +refs/heads/qa'))).toBeDefined();
    expect(ctx.sh.calls.some((c) => c.startsWith('git fetch --quiet origin refs/heads/qa:'))).toBe(false);
  });

  const failedFetch = () => {
    const ctx = base([
      ['git fetch --quiet origin +refs/heads/qa', 1],
      ['git rev-parse --verify refs/remotes/origin/qa', 'stale999\n'],
    ]);
    ctx.config = { ...ctx.config, ship: { steps: ['merge'], pr: { into: 'qa' } } };
    return ctx;
  };

  it('a failed fetch of the target records no sha and warns, instead of reading a stale ref', async () => {
    const ctx = failedFetch();
    expect(await merge.run(ctx)).toEqual({ ok: true, sha: null });
    expect(ctx.sh.calls).not.toContain('git rev-parse --verify refs/remotes/origin/qa');
    const warns = ctx.events.filter((e) => e.kind === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0].text).toContain('qa');
    expect(warns[0].text).toContain('origin');
    expect(ctx.sh.calls).toContain('git branch -D story/s-1');
    expect(ctx.halts).toEqual([]);
  });

  it('a failed fetch of the target with no event function still records no sha', async () => {
    const ctx = failedFetch();
    delete ctx.event;
    expect(await merge.run(ctx)).toEqual({ ok: true, sha: null });
  });

  it('into equal to baseBranch makes today\'s calls', async () => {
    const plain = base();
    await merge.run(plain);
    const ctx = base();
    ctx.config = { ...ctx.config, ship: { steps: ['merge'], pr: { into: 'main' } } };
    expect(await merge.run(ctx)).toEqual({ ok: true, sha: 'abc123' });
    expect(ctx.sh.calls).toEqual(plain.sh.calls);
  });
});

describe('merge flags', () => {
  it('wants mergeable-recheck right before it', () => {
    expect(merge.beforeNoReturn).toBe(true);
  });
});
