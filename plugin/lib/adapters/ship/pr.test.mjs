import { describe, expect, it } from 'vitest';
import pr, { prTarget } from './pr.mjs';
import merge from './merge.mjs';
import { runShip } from '../../engine/ship.mjs';
import { fakeCtx } from '../../../../test/ship-fakes.mjs';

const open = JSON.stringify({ number: 12, url: 'https://gh/pull/12', state: 'OPEN' });

describe('pr step', () => {
  it('finds the open pull request and waits until GitHub knows it can merge', async () => {
    let asked = 0;
    const ctx = fakeCtx({ branch: 'story/s-1', rules: [['gh pr view story/s-1', open], ['gh pr view 12 --json mergeable', () => (++asked < 3 ? 'UNKNOWN\n' : 'MERGEABLE\n')]] });
    const r = await pr.run(ctx);
    expect(r).toEqual({ ok: true, pr: 'https://gh/pull/12', prNumber: 12 });
    expect(ctx.sleeps).toEqual([10_000, 10_000]);
    expect(ctx.reports).toContain('https://gh/pull/12');
    expect(ctx.sh.calls.some((c) => c.startsWith('gh pr create'))).toBe(false);
    expect(ctx.sh.calls.some((c) => c.startsWith('gh pr ready') || c.startsWith('gh pr edit'))).toBe(false);
  });

  it('asks GitHub whether the pull request is a draft', async () => {
    const ctx = fakeCtx({ branch: 'story/s-1', rules: [['gh pr view story/s-1', open], ['gh pr view 12 --json mergeable', 'MERGEABLE']] });
    await pr.run(ctx);
    expect(ctx.sh.calls).toContain('gh pr view story/s-1 --json number,url,state,isDraft,mergedAt');
  });

  describe('a story rolled back after its pull request merged', () => {
    const ROLLED_BACK_AT = '2026-11-10T18:00:00Z';
    const oldMerged = { number: 28, url: 'https://gh/pull/28', state: 'MERGED', mergedAt: '2026-11-10T09:00:00Z' };
    const fresh = { number: 41, url: 'https://gh/pull/41', state: 'OPEN' };
    // `gh pr view story/s-1` answers `before` until `gh pr create` has run, then `after`.
    const ctxFor = ({ before = oldMerged, after = fresh, create = 0, ...rest } = {}) => {
      let created = false;
      return fakeCtx({
        branch: 'story/s-1',
        rules: [
          ['gh pr create', () => { created = true; return create; }],
          ['gh pr view story/s-1', () => JSON.stringify(created ? after : before)],
          ['gh pr view 41 --json mergeable', 'MERGEABLE'],
        ],
        ...rest,
      });
    };

    it('a story rolled back after its pull request merged gets a new pull request', async () => {
      const raised = [];
      const ctx = ctxFor({ rolledBackAt: ROLLED_BACK_AT });
      const r = await pr.run(ctx, { raiseStoryEvent: (...a) => (raised.push(a), { ok: true }) });
      expect(r).toEqual({ ok: true, pr: 'https://gh/pull/41', prNumber: 41 });
      expect(ctx.sh.calls).toContain('gh pr create --base main --head story/s-1 --fill');
      expect(ctx.events).toHaveLength(1);
      expect(ctx.events[0]).toMatchObject({ kind: 'info' });
      expect(ctx.events[0].text).toContain('#28');
      expect(raised[0][3]).toContain('https://gh/pull/41');
    });

    it('opens the new pull request into ship.pr.into when it is set', async () => {
      const ctx = ctxFor({ rolledBackAt: ROLLED_BACK_AT });
      ctx.config = { ...ctx.config, ship: { ...ctx.config.ship, pr: { into: 'qa' } } };
      expect((await pr.run(ctx)).ok).toBe(true);
      expect(ctx.sh.calls).toContain('gh pr create --base qa --head story/s-1 --fill');
    });

    it.each([[undefined], [null]])('without a rollback record (%s) the old merged pull request still fails as MERGED', async (rolledBackAt) => {
      const ctx = ctxFor({ rolledBackAt });
      const r = await pr.run(ctx);
      expect(r).toMatchObject({ ok: false, code: 1, stage: 'pr', reason: 'Pull request #28 is MERGED.' });
      expect(ctx.sh.calls.some((c) => c.startsWith('gh pr create'))).toBe(false);
    });

    it('a pull request merged after the rollback is the rebuild already shipped: still MERGED, nothing opened', async () => {
      const ctx = ctxFor({ rolledBackAt: ROLLED_BACK_AT, before: { ...oldMerged, mergedAt: '2026-11-11T09:00:00Z' } });
      const r = await pr.run(ctx);
      expect(r).toMatchObject({ ok: false, code: 1, stage: 'pr', reason: 'Pull request #28 is MERGED.' });
      expect(ctx.sh.calls.some((c) => c.startsWith('gh pr create'))).toBe(false);
    });

    it.each([['missing', undefined], ['unreadable', 'not a time']])('a merge time that is %s counts as before the rollback', async (_name, mergedAt) => {
      const ctx = ctxFor({ rolledBackAt: ROLLED_BACK_AT, before: { ...oldMerged, mergedAt } });
      expect(await pr.run(ctx)).toEqual({ ok: true, pr: 'https://gh/pull/41', prNumber: 41 });
      expect(ctx.sh.calls).toContain('gh pr create --base main --head story/s-1 --fill');
    });

    it('a closed pull request still fails as CLOSED and nothing is opened', async () => {
      const ctx = ctxFor({ rolledBackAt: ROLLED_BACK_AT, before: { number: 28, url: 'u', state: 'CLOSED' } });
      expect(await pr.run(ctx)).toMatchObject({ ok: false, code: 1, stage: 'pr', reason: 'Pull request #28 is CLOSED.' });
      expect(ctx.sh.calls.some((c) => c.startsWith('gh pr create'))).toBe(false);
    });

    it('stops when the new pull request cannot be opened', async () => {
      const ctx = ctxFor({ rolledBackAt: ROLLED_BACK_AT, create: 1 });
      expect(await pr.run(ctx)).toMatchObject({ ok: false, code: 1, stage: 'pr', reason: 'Could not open the pull request.' });
    });

    it('stops when, after the create, the old pull request is still the one found', async () => {
      const ctx = ctxFor({ rolledBackAt: ROLLED_BACK_AT, after: oldMerged });
      expect(await pr.run(ctx)).toMatchObject({ ok: false, code: 1, stage: 'pr', reason: 'Opened the pull request but cannot find it.' });
      expect(ctx.sh.calls.some((c) => c.includes('--json mergeable'))).toBe(false);
    });

    it('still opens the new pull request when its event throws', async () => {
      const ctx = ctxFor({ rolledBackAt: ROLLED_BACK_AT, event: () => { throw new Error('feed is gone'); } });
      expect((await pr.run(ctx, { raiseStoryEvent: () => ({ ok: true }) })).ok).toBe(true);
    });

    it('is retried and shipped: the new pull request is the one that merges', async () => {
      let merged = false;
      let created = false;
      const ctx = fakeCtx({
        rolledBackAt: ROLLED_BACK_AT,
        rules: [
          ['gh pr create', () => { created = true; return 0; }],
          ['gh pr view story/s-1', () => JSON.stringify(created ? fresh : oldMerged)],
          ['gh pr view 41 --json mergeable', 'MERGEABLE'],
          ['gh pr merge 41 --merge', () => { merged = true; return 0; }],
          ['gh pr view 41 --json state', () => (merged ? 'MERGED' : 'OPEN')],
        ],
      });
      const { code, result } = await runShip({ steps: [pr, merge], ctx });
      expect(code).toBe(0);
      expect(result).toMatchObject({ stage: 'shipped', prNumber: 41 });
      expect(ctx.sh.calls).toContain('gh pr merge 41 --merge');
      expect(ctx.sh.calls.some((c) => c.startsWith('gh pr merge 28'))).toBe(false);
    });
  });

  describe('a reused draft pull request (left by a failed run)', () => {
    const quiet = { raiseStoryEvent: () => ({ ok: true }) };
    const draft = JSON.stringify({ number: 12, url: 'https://gh/pull/12', state: 'OPEN', isDraft: true });
    const rulesFor = (extra = []) => [...extra, ['gh pr view story/s-1', draft], ['gh pr view 12 --json mergeable', 'MERGEABLE']];

    it('is marked ready, and its body is rebuilt from its commits', async () => {
      const ctx = fakeCtx({ branch: 'story/s-1', rules: rulesFor([['gh pr view 12 --json commits', 'S-1 Add login\nS-1 Fix review\n']]) });
      expect(await pr.run(ctx, quiet)).toEqual({ ok: true, pr: 'https://gh/pull/12', prNumber: 12 });
      const calls = ctx.sh.calls;
      expect(calls).toContain('gh pr ready 12');
      expect(calls.indexOf('gh pr ready 12')).toBeLessThan(calls.findIndex((c) => c.includes('--json mergeable')));
      expect(calls).toContain('gh pr edit 12 --body - S-1 Add login\n- S-1 Fix review');
      expect(ctx.events).toEqual([]);
    });

    it('stops when it cannot be marked ready, and never asks whether it can merge', async () => {
      const ctx = fakeCtx({ branch: 'story/s-1', rules: rulesFor([['gh pr ready 12', { status: 1 }]]) });
      const r = await pr.run(ctx, quiet);
      expect(r).toMatchObject({ ok: false, code: 1, stage: 'pr', pr: 'https://gh/pull/12' });
      expect(r.reason).toContain('draft');
      expect(ctx.sh.calls.some((c) => c.includes('--json mergeable'))).toBe(false);
      expect(ctx.sh.calls.some((c) => c.startsWith('gh pr edit'))).toBe(false);
    });

    it.each([
      ['the commits cannot be read', [['gh pr view 12 --json commits', { status: 1 }]]],
      ['there are no commits', [['gh pr view 12 --json commits', '\n']]],
      ['the edit fails', [['gh pr view 12 --json commits', 'S-1 Add login\n'], ['gh pr edit 12', { status: 1 }]]],
    ])('still passes, with a warning, when %s', async (_name, extra) => {
      const ctx = fakeCtx({ branch: 'story/s-1', rules: rulesFor(extra) });
      expect((await pr.run(ctx, quiet)).ok).toBe(true);
      expect(ctx.sh.calls).toContain('gh pr ready 12');
      expect(ctx.events).toHaveLength(1);
      expect(ctx.events[0].kind).toBe('warn');
      expect(ctx.events[0].text).toContain('#12');
    });

    it('still passes, with a warning, when a call throws', async () => {
      const ctx = fakeCtx({ branch: 'story/s-1', rules: rulesFor([['gh pr view 12 --json commits', () => { throw new Error('gh is gone'); }]]) });
      expect((await pr.run(ctx, quiet)).ok).toBe(true);
      expect(ctx.events).toHaveLength(1);
      expect(ctx.events[0].text).toContain('#12');
    });

    it('is left alone when isDraft is false', async () => {
      const notDraft = JSON.stringify({ number: 12, url: 'https://gh/pull/12', state: 'OPEN', isDraft: false });
      const ctx = fakeCtx({ branch: 'story/s-1', rules: [['gh pr view story/s-1', notDraft], ['gh pr view 12 --json mergeable', 'MERGEABLE']] });
      expect((await pr.run(ctx, quiet)).ok).toBe(true);
      expect(ctx.sh.calls.some((c) => c.startsWith('gh pr ready') || c.startsWith('gh pr edit'))).toBe(false);
    });
  });

  it('creates the pull request when there is none', async () => {
    let created = false;
    const ctx = fakeCtx({
      branch: 'story/s-1',
      rules: [
        ['gh pr create', () => { created = true; return 0; }],
        ['gh pr view story/s-1', () => (created ? open : { status: 1, stderr: 'no pull requests found' })],
        ['gh pr view 12 --json mergeable', 'MERGEABLE'],
      ],
    });
    expect((await pr.run(ctx)).ok).toBe(true);
    expect(ctx.sh.calls).toContain('gh pr create --base main --head story/s-1 --fill');
  });

  const createsWhenNone = () => {
    let created = false;
    return fakeCtx({
      branch: 'story/s-1',
      rules: [
        ['gh pr create', () => { created = true; return 0; }],
        ['gh pr view story/s-1', () => (created ? open : { status: 1, stderr: 'no pull requests found' })],
        ['gh pr view 12 --json mergeable', 'MERGEABLE'],
      ],
    });
  };

  it('opens the pull request into ship.pr.into when it is set', async () => {
    const ctx = createsWhenNone();
    ctx.config = { ...ctx.config, ship: { ...ctx.config.ship, pr: { into: 'qa' } } };
    expect((await pr.run(ctx)).ok).toBe(true);
    expect(ctx.sh.calls).toContain('gh pr create --base qa --head story/s-1 --fill');
    expect(ctx.sh.calls.some((c) => c.includes('--base main'))).toBe(false);
  });

  it('ship.pr.into equal to baseBranch opens into the base', async () => {
    const ctx = createsWhenNone();
    ctx.config = { ...ctx.config, ship: { ...ctx.config.ship, pr: { into: 'main' } } };
    expect((await pr.run(ctx)).ok).toBe(true);
    expect(ctx.sh.calls).toContain('gh pr create --base main --head story/s-1 --fill');
  });

  it('a pull request that is not open exits 1', async () => {
    const ctx = fakeCtx({ branch: 'story/s-1', rules: [['gh pr view story/s-1', JSON.stringify({ number: 3, url: 'u', state: 'CLOSED' })]] });
    expect(await pr.run(ctx)).toMatchObject({ ok: false, code: 1, stage: 'pr' });
  });

  it('a pull request that cannot merge exits 1, because CI will not run on it', async () => {
    const ctx = fakeCtx({ branch: 'story/s-1', rules: [['gh pr view story/s-1', open], ['gh pr view 12 --json mergeable', 'CONFLICTING']] });
    const r = await pr.run(ctx);
    expect(r).toMatchObject({ ok: false, code: 1, pr: 'https://gh/pull/12' });
    expect(r.reason).toBe('Pull request #12 cannot merge (CONFLICTING); CI will not run on it.');
  });

  it('raises review on the story with the pull request URL, once it is open', async () => {
    const raised = [];
    const raiseStoryEvent = (...args) => {
      raised.push(args);
      return { ok: true };
    };
    const ctx = fakeCtx({ branch: 'story/s-1', root: '/project', env: { A: '1' }, rules: [['gh pr view story/s-1', open], ['gh pr view 12 --json mergeable', 'MERGEABLE']] });
    expect((await pr.run(ctx, { raiseStoryEvent })).ok).toBe(true);
    expect(raised).toEqual([[{ root: '/project', env: { A: '1' }, now: ctx.now }, 'S-1', 'review', 'Pull request ready for review: https://gh/pull/12']]);
  });

  it('names the commit in the note when git gives its short sha', async () => {
    const raised = [];
    const raiseStoryEvent = (...args) => {
      raised.push(args);
      return { ok: true };
    };
    const rules = [['git rev-parse --short HEAD', 'abc1234\n'], ['gh pr view story/s-1', open], ['gh pr view 12 --json mergeable', 'MERGEABLE']];
    const ctx = fakeCtx({ branch: 'story/s-1', root: '/project', env: { A: '1' }, rules });
    expect((await pr.run(ctx, { raiseStoryEvent })).ok).toBe(true);
    expect(raised[0][3]).toBe('Pull request ready for review: https://gh/pull/12 (commit abc1234)');
  });

  it('keeps the plain note when git gives no sha, a failure, or something that is not one', async () => {
    for (const answer of [{ status: 128, stderr: 'fatal: not a git repository' }, 'not a sha at all\n', '']) {
      const raised = [];
      const rules = [['git rev-parse --short HEAD', answer], ['gh pr view story/s-1', open], ['gh pr view 12 --json mergeable', 'MERGEABLE']];
      const ctx = fakeCtx({ branch: 'story/s-1', rules });
      await pr.run(ctx, { raiseStoryEvent: (...args) => (raised.push(args), { ok: true }) });
      expect(raised[0][3]).toBe('Pull request ready for review: https://gh/pull/12');
    }
  });

  it('raises nothing when the runner brings the base in again (pass 2), but still reports the URL', async () => {
    const raised = [];
    const raiseStoryEvent = (...args) => {
      raised.push(args);
      return { ok: true };
    };
    const ctx = fakeCtx({ branch: 'story/s-1', root: '/project', env: { A: '1' }, pass: 2, rules: [['gh pr view story/s-1', open], ['gh pr view 12 --json mergeable', 'MERGEABLE']] });
    expect(await pr.run(ctx, { raiseStoryEvent })).toEqual({ ok: true, pr: 'https://gh/pull/12', prNumber: 12 });
    expect(raised).toEqual([]);
    expect(ctx.reports).toContain('https://gh/pull/12');
  });

  it('raises review once on the runner\'s first pass', async () => {
    const raised = [];
    const raiseStoryEvent = (...args) => {
      raised.push(args);
      return { ok: true };
    };
    const ctx = fakeCtx({ branch: 'story/s-1', root: '/project', env: { A: '1' }, pass: 1, rules: [['gh pr view story/s-1', open], ['gh pr view 12 --json mergeable', 'MERGEABLE']] });
    expect((await pr.run(ctx, { raiseStoryEvent })).ok).toBe(true);
    expect(raised).toEqual([[{ root: '/project', env: { A: '1' }, now: ctx.now }, 'S-1', 'review', 'Pull request ready for review: https://gh/pull/12']]);
  });

  it('a story source that fails never fails the step, and says why in an event', async () => {
    const ctx = fakeCtx({ branch: 'story/s-1', root: '/project', env: {}, rules: [['gh pr view story/s-1', open], ['gh pr view 12 --json mergeable', 'MERGEABLE']] });
    const throws = () => {
      throw new Error('Jira is down');
    };
    expect((await pr.run(ctx, { raiseStoryEvent: throws })).ok).toBe(true);
    expect(await pr.run(ctx, { raiseStoryEvent: () => ({ ok: false, error: 'no such story: S-1' }) })).toMatchObject({ ok: true });
    expect(ctx.events.map((e) => e.text)).toEqual(['Could not tell the story source S-1 is in review (Jira is down).', 'Could not tell the story source S-1 is in review (no such story: S-1).']);
  });

  it('raises nothing for a pull request that is not open', async () => {
    const raised = [];
    const ctx = fakeCtx({ branch: 'story/s-1', root: '/project', rules: [['gh pr view story/s-1', JSON.stringify({ number: 3, url: 'u', state: 'CLOSED' })]] });
    await pr.run(ctx, { raiseStoryEvent: (...a) => raised.push(a) });
    expect(raised).toEqual([]);
  });

  it('gives up on UNKNOWN after 18 tries', async () => {
    const ctx = fakeCtx({ branch: 'story/s-1', rules: [['gh pr view story/s-1', open], ['gh pr view 12 --json mergeable', 'UNKNOWN']] });
    const r = await pr.run(ctx);
    expect(r).toMatchObject({ ok: false, code: 1 });
    expect(ctx.sh.calls.filter((c) => c.includes('mergeable'))).toHaveLength(18);
  });
});

describe('prTarget', () => {
  it('is ship.pr.into when set, and baseBranch otherwise', () => {
    expect(prTarget({ baseBranch: 'main', ship: { steps: ['pr'], pr: { into: 'qa' } } })).toBe('qa');
    expect(prTarget({ baseBranch: 'main' })).toBe('main');
    expect(prTarget({ baseBranch: 'main', ship: { steps: ['pr'] } })).toBe('main');
    expect(prTarget({ baseBranch: 'main', ship: { steps: ['pr'], pr: { mergeMethod: 'squash' } } })).toBe('main');
  });
});
