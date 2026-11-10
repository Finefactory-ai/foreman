import { describe, expect, it } from 'vitest';
import { runShip, lockStore } from './ship.mjs';
import { fakeCtx, fakeLocks } from '../../../test/ship-fakes.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A step that records what the runner had done when it ran.
const step = (name, result = { ok: true }, extra = {}) => ({
  name,
  ran: [],
  run(ctx) {
    this.ran.push({ shipStage: ctx.locks.holderOf('ship')?.stage, ctx: { ...ctx } });
    return typeof result === 'function' ? result(ctx) : result;
  },
  ...extra,
});

describe('runShip', () => {
  it('runs the steps in order, recording each name on the ship lock before it runs', async () => {
    const ctx = fakeCtx();
    const a = step('a', { ok: true, pr: 'https://x/pull/1' });
    const b = step('b', { ok: true, sha: 'abc' });
    const { code, result } = await runShip({ steps: [a, b], ctx });
    expect(code).toBe(0);
    expect(a.ran[0].shipStage).toBe('a');
    expect(b.ran[0].shipStage).toBe('b');
    expect(ctx.locks.log.filter((l) => l[0] === 'stage').map((l) => l[2])).toEqual(['a', 'b']);
    expect(b.ran[0].ctx.pr).toBe('https://x/pull/1');
    expect(result).toMatchObject({ stage: 'shipped', pr: 'https://x/pull/1', sha: 'abc' });
    expect(ctx.reports).toEqual(expect.arrayContaining(['a', 'b']));
    expect(ctx.halts).toEqual([]);
  });

  it('tells every step which step of the release tests the merged code (testsMergedCode)', async () => {
    const ctx = fakeCtx();
    const a = step('a');
    await runShip({ steps: [a, step('ci', { ok: true }, { testsMergedCode: true })], ctx });
    expect(a.ran[0].ctx.testedBy).toBe('ci');
  });

  it('testedBy is null when no step tests the merged code', async () => {
    const ctx = fakeCtx();
    const a = step('a');
    await runShip({ steps: [a, step('b')], ctx });
    expect(a.ran[0].ctx.testedBy).toBeNull();
  });

  it('no step fact replaces testedBy', async () => {
    const ctx = fakeCtx();
    const b = step('b');
    const { code, result } = await runShip({ steps: [step('a', { ok: true, testedBy: 'x' }), b], ctx });
    expect(code).toBe(0);
    expect(b.ran[0].ctx.testedBy).toBeNull();
    expect(result.testedBy).toBeUndefined();
  });

  it('gives each step the branch, the story id and the config', async () => {
    const ctx = fakeCtx();
    const a = step('a');
    await runShip({ steps: [a], ctx });
    expect(a.ran[0].ctx).toMatchObject({ branch: 'story/s-1', story: 'S-1' });
  });

  it('stops at a failing step and reports its code, stage and reason', async () => {
    const ctx = fakeCtx();
    const a = step('a', { ok: false, code: 2, stage: 'ci', reason: 'CI failed.', pr: 'u' });
    const b = step('b');
    const { code, result } = await runShip({ steps: [a, b], ctx });
    expect(code).toBe(2);
    expect(result).toMatchObject({ stage: 'ci', reason: 'CI failed.', pr: 'u' });
    expect(b.ran).toHaveLength(0);
    expect(ctx.halts).toEqual([]);
  });

  it('a failing step that halts writes HALT', async () => {
    const ctx = fakeCtx();
    const { code } = await runShip({ steps: [step('deploy', { ok: false, code: 5, stage: 'deploy', reason: 'down' }, { halts: true })], ctx });
    expect(code).toBe(5);
    expect(ctx.halts).toHaveLength(1);
    expect(ctx.halts[0]).toMatchObject({ stage: 'deploy', reason: 'down' });
  });

  it('a failure after a point-of-no-return step writes HALT and turns code 1 into 5', async () => {
    const ctx = fakeCtx();
    const merge = step('merge', { ok: true, sha: 's' }, { pointOfNoReturn: true });
    const after = step('verify', { ok: false, code: 1, stage: 'verify', reason: 'nope' });
    const { code, result } = await runShip({ steps: [merge, after], ctx });
    expect(code).toBe(5);
    expect(result).toMatchObject({ stage: 'verify', reason: 'nope', sha: 's' });
    expect(ctx.halts).toHaveLength(1);
  });

  it('after a point of no return any failure code becomes 5', async () => {
    const ctx = fakeCtx();
    const merge = step('merge', { ok: true }, { pointOfNoReturn: true });
    const ci = step('verify', { ok: false, code: 2, stage: 'verify', reason: 'x' });
    expect((await runShip({ steps: [merge, ci], ctx })).code).toBe(5);
    expect(ctx.halts).toHaveLength(1);
  });

  it('a step result with noReturn marks the point of no return at run time', async () => {
    const ctx = fakeCtx();
    const migrate = step('migrate', { ok: true, noReturn: true });
    const merge = step('merge', { ok: false, code: 1, stage: 'merge', reason: 'no' });
    const { code, result } = await runShip({ steps: [migrate, merge], ctx });
    expect(code).toBe(5);
    expect(result).not.toHaveProperty('noReturn');
    expect(ctx.halts).toHaveLength(1);
  });

  it('a step without the flag that does not say noReturn leaves later failures alone', async () => {
    const ctx = fakeCtx();
    const migrate = step('migrate', { ok: true, migrations: [] });
    const merge = step('merge', { ok: false, code: 1, stage: 'merge', reason: 'no' });
    expect((await runShip({ steps: [migrate, merge], ctx })).code).toBe(1);
    expect(ctx.halts).toEqual([]);
  });

  it.each([4, 5])('a step failing with code %i writes HALT even without halts', async (code) => {
    const ctx = fakeCtx();
    expect((await runShip({ steps: [step('x', { ok: false, code, stage: 'x', reason: 'r' })], ctx })).code).toBe(code);
    expect(ctx.halts).toHaveLength(1);
  });

  it('a HALT that cannot be written says so in the result and the events', async () => {
    const ctx = fakeCtx();
    ctx.halt = () => {
      throw new Error('disk full');
    };
    const { code, result } = await runShip({ steps: [step('deploy', { ok: false, code: 5, stage: 'deploy', reason: 'down' }, { halts: true })], ctx });
    expect(code).toBe(5);
    expect(result.haltWritten).toBe(false);
    expect(ctx.events.some((e) => e.kind === 'warn' && /NOT frozen/.test(e.text))).toBe(true);
  });

  it('step facts never replace the runner\'s own ctx keys', async () => {
    const ctx = fakeCtx();
    const sh = ctx.sh;
    const bad = step('bad', { ok: true, sh: null, config: null, story: 'X', branch: 'main', locks: null, report: null, halt: null, sleep: null, now: null, pr: 'u' });
    const after = step('after');
    const { code, result } = await runShip({ steps: [bad, after], ctx });
    expect(code).toBe(0);
    expect(after.ran[0].ctx).toMatchObject({ sh, story: 'S-1', branch: 'story/s-1', pr: 'u' });
    expect(after.ran[0].ctx.config).toBeTruthy();
    expect(result).toMatchObject({ story: 'S-1', pr: 'u' });
    expect(result).not.toHaveProperty('branch');
  });

  it('a point-of-no-return step that fails itself does not halt', async () => {
    const ctx = fakeCtx();
    const { code } = await runShip({ steps: [step('merge', { ok: false, code: 1, stage: 'merge', reason: 'no' }, { pointOfNoReturn: true })], ctx });
    expect(code).toBe(1);
    expect(ctx.halts).toEqual([]);
  });

  it('a step asking the owner to allow deletes stops with code 10: nothing halted, its facts kept, the lock released', async () => {
    const ctx = fakeCtx();
    const deletes = [{ type: 'ApexClass', member: 'AcmeOld' }];
    const delta = step('acme-delta', { ok: false, code: 10, stage: 'acme-delta', reason: 'The change deletes 1 component(s).', deletes, sha256: 'abc' });
    const after = step('push');
    const { code, result } = await runShip({ steps: [step('merge-main'), delta, after], ctx });
    expect(code).toBe(10);
    expect(result).toEqual({ stage: 'acme-delta', reason: 'The change deletes 1 component(s).', deletes, sha256: 'abc' });
    expect(after.ran).toHaveLength(0);
    expect(ctx.halts).toEqual([]);
    expect(ctx.locks.held.has('ship')).toBe(false);
  });

  describe('a step that parks the release', () => {
    const PARK = { reason: 'click Promote', check: { id: 'D-1' } };

    it('stops with code 9, no later step, no HALT, the lock released, and the park in the result only', async () => {
      const ctx = fakeCtx();
      const pr = step('pr', { ok: true, pr: 'https://x/pull/1' });
      const promote = step('acme-promote', { ok: true, parked: PARK });
      const after = step('after');
      const { code, result } = await runShip({ steps: [pr, promote, after], ctx });
      expect(code).toBe(9);
      expect(result).toEqual({ pr: 'https://x/pull/1', stage: 'parked', story: 'S-1', step: 'acme-promote', parked: PARK });
      expect(after.ran).toHaveLength(0);
      expect(ctx.halts).toEqual([]);
      expect(ctx.locks.held.has('ship')).toBe(false);
      expect(ctx.parked).toBeUndefined();
    });

    it('still gives code 9 with no HALT after a point of no return', async () => {
      const ctx = fakeCtx();
      const merge = step('merge', { ok: true, sha: 's' }, { pointOfNoReturn: true });
      const { code, result } = await runShip({ steps: [merge, step('acme-promote', { ok: true, parked: PARK })], ctx });
      expect(code).toBe(9);
      expect(result).toMatchObject({ stage: 'parked', sha: 's', parked: PARK });
      expect(ctx.halts).toEqual([]);
    });

    const invalid = [
      ['an empty reason', { reason: '', check: { id: 'D-1' } }],
      ['a missing check', { reason: 'click Promote' }],
      ['a check that holds a function', { reason: 'click Promote', check: { id: 'D-1', run: () => true } }],
    ];

    it.each(invalid)('refuses a park with %s as a failure of that step (code 1)', async (_, parked) => {
      const ctx = fakeCtx();
      const after = step('after');
      const { code, result } = await runShip({ steps: [step('acme-promote', { ok: true, parked }), after], ctx });
      expect(code).toBe(1);
      expect(result.stage).toBe('acme-promote');
      expect(result.reason).toMatch(/parked/);
      expect(result).not.toHaveProperty('parked');
      expect(after.ran).toHaveLength(0);
      expect(ctx.halts).toEqual([]);
      expect(ctx.locks.held.has('ship')).toBe(false);
    });

    it.each(invalid)('refuses a park with %s after a point of no return with code 5 and one HALT', async (_, parked) => {
      const ctx = fakeCtx();
      const merge = step('merge', { ok: true }, { pointOfNoReturn: true });
      const { code, result } = await runShip({ steps: [merge, step('acme-promote', { ok: true, parked })], ctx });
      expect(code).toBe(5);
      expect(result.reason).toMatch(/parked/);
      expect(ctx.halts).toHaveLength(1);
    });

    it('a failing step that says parked is the ordinary failure', async () => {
      const ctx = fakeCtx();
      const { code, result } = await runShip({ steps: [step('ci', { ok: false, code: 2, stage: 'ci', reason: 'CI failed.', parked: PARK })], ctx });
      expect(code).toBe(2);
      expect(result).toEqual({ stage: 'ci', reason: 'CI failed.' });
      expect(ctx.halts).toEqual([]);
    });
  });

  describe('rolling back', () => {
    // A rollback step that records each call, and the HALTs written before it ran.
    const CMD = 'vercel rollback --yes';
    const rollbackStep = (result = { ok: true, command: CMD }) => step('rollback', (ctx) => {
      ctx.haltsWhenRolledBack = ctx.halts.map((h) => ({ ...h }));
      return typeof result === 'function' ? result(ctx) : result;
    }, { label: 'rolling production back', commandFor: () => CMD });
    const merge = () => step('merge', { ok: true, sha: 's' }, { pointOfNoReturn: true });
    const deploy = (result = { ok: true }) => step('deploy-github', result, { deploys: true, halts: true });
    const watch = () => step('watch', { ok: false, code: 5, stage: 'watch', reason: 'errors went up after the deploy.' }, { halts: true });

    it('runs once when a step after the deploy fails, after a HALT that says it is rolling back, and says production was rolled back', async () => {
      const ctx = fakeCtx();
      const onFailure = rollbackStep();
      const { code, result } = await runShip({ steps: [merge(), deploy(), watch()], ctx, onFailure });
      expect(code).toBe(5);
      expect(onFailure.ran).toHaveLength(1);
      expect(ctx.haltsWhenRolledBack).toEqual([{ sha: 's', stage: 'watch', reason: `Rolling back with \`${CMD}\`… errors went up after the deploy.` }]);
      expect(result).toMatchObject({ stage: 'watch', rolledBack: true, sha: 's' });
      expect(result.reason).toBe(`Production was rolled back with \`${CMD}\`. errors went up after the deploy.`);
      expect(ctx.halts).toHaveLength(2);
      expect(ctx.halts[1]).toEqual(result);
      expect(ctx.reports).toContain('rolling production back');
      expect(ctx.locks.log.filter((l) => l[0] === 'stage').map((l) => l[2])).toEqual(['merge', 'deploy-github', 'watch', 'rollback']);
    });

    it('runs for a failure at any stage after the deploy, such as smoke', async () => {
      const ctx = fakeCtx();
      const onFailure = rollbackStep();
      const smoke = step('smoke', { ok: false, code: 5, stage: 'smoke', reason: 'down.' }, { halts: true });
      const { result } = await runShip({ steps: [merge(), deploy(), smoke, watch()], ctx, onFailure });
      expect(onFailure.ran).toHaveLength(1);
      expect(result).toMatchObject({ stage: 'smoke', rolledBack: true });
    });

    it('says production may be broken when the rollback command fails, and leaves HALT written', async () => {
      const ctx = fakeCtx();
      const onFailure = rollbackStep({ ok: false, command: CMD, exitCode: 2, why: 'exited 2' });
      const { code, result } = await runShip({ steps: [merge(), deploy(), watch()], ctx, onFailure });
      expect(code).toBe(5);
      expect(onFailure.ran).toHaveLength(1);
      expect(result.rolledBack).toBe(false);
      expect(result.reason).toBe(`Rollback failed (\`${CMD}\` exited 2); production may be broken. errors went up after the deploy.`);
      expect(ctx.halts.at(-1)).toEqual(result);
    });

    it('a rollback that runs out of time counts as failed', async () => {
      const ctx = fakeCtx();
      const onFailure = rollbackStep({ ok: false, command: CMD, why: 'did not finish within 300 s' });
      const { result } = await runShip({ steps: [merge(), deploy(), watch()], ctx, onFailure });
      expect(result.rolledBack).toBe(false);
      expect(result.reason).toBe(`Rollback failed (\`${CMD}\` did not finish within 300 s); production may be broken. errors went up after the deploy.`);
    });

    it('a rollback that throws counts as failed', async () => {
      const ctx = fakeCtx();
      const onFailure = { name: 'rollback', run() { throw new Error('spawn sh ENOENT'); } };
      const { result } = await runShip({ steps: [merge(), deploy(), watch()], ctx, onFailure });
      expect(result.rolledBack).toBe(false);
      expect(result.reason).toMatch(/^Rollback failed .*production may be broken\. errors went up/);
      expect(ctx.halts.at(-1)).toEqual(result);
    });

    it('is never called when the deploy itself fails: production still runs the previous version', async () => {
      const ctx = fakeCtx();
      const onFailure = rollbackStep();
      const { code, result } = await runShip({ steps: [merge(), deploy({ ok: false, code: 5, stage: 'deploy', reason: 'Production deployment ended as "failure".' }), watch()], ctx, onFailure });
      expect(code).toBe(5);
      expect(onFailure.ran).toHaveLength(0);
      expect(result).not.toHaveProperty('rolledBack');
      expect(ctx.halts).toEqual([result]);
    });

    it('is never called when no deploy step ran before the failing step', async () => {
      const ctx = fakeCtx();
      const onFailure = rollbackStep();
      const { code, result } = await runShip({ steps: [merge(), watch()], ctx, onFailure });
      expect(code).toBe(5);
      expect(onFailure.ran).toHaveLength(0);
      expect(result).not.toHaveProperty('rolledBack');
      expect(ctx.halts).toEqual([result]);
    });

    it('is never called for a failure before merge', async () => {
      const ctx = fakeCtx();
      const onFailure = rollbackStep();
      const ci = step('ci', { ok: false, code: 2, stage: 'ci', reason: 'CI failed.' });
      const { code, result } = await runShip({ steps: [ci, merge()], ctx, onFailure });
      expect(code).toBe(2);
      expect(onFailure.ran).toHaveLength(0);
      expect(result).not.toHaveProperty('rolledBack');
    });

    it('is never called when merge itself fails, even after a migration passed the point of no return', async () => {
      const ctx = fakeCtx();
      const onFailure = rollbackStep();
      const migrate = step('migrate-supabase', { ok: true, noReturn: true });
      const failingMerge = step('merge', { ok: false, code: 1, stage: 'merge', reason: 'not mergeable' }, { pointOfNoReturn: true });
      const { code, result } = await runShip({ steps: [migrate, failingMerge], ctx, onFailure });
      expect(code).toBe(5);
      expect(onFailure.ran).toHaveLength(0);
      expect(result).not.toHaveProperty('rolledBack');
      expect(ctx.halts).toHaveLength(1);
    });

    it('is never called when the release ships', async () => {
      const ctx = fakeCtx();
      const onFailure = rollbackStep();
      expect((await runShip({ steps: [merge(), deploy(), step('watch')], ctx, onFailure })).code).toBe(0);
      expect(onFailure.ran).toHaveLength(0);
    });

    it('without a rollback configured, a failure after the deploy behaves as before', async () => {
      const ctx = fakeCtx();
      const { code, result } = await runShip({ steps: [merge(), deploy(), watch()], ctx, onFailure: null });
      expect(code).toBe(5);
      expect(result).toEqual({ sha: 's', stage: 'watch', reason: 'errors went up after the deploy.' });
      expect(ctx.halts).toEqual([result]);
    });

    describe('once a noRollback step has started', () => {
      const NOT = 'Not rolled back: Foreman never rolls back once later has started';

      it('a failure of that step halts once and never rolls back', async () => {
        const ctx = fakeCtx();
        const onFailure = rollbackStep();
        const later = step('later', { ok: false, code: 5, stage: 'later', reason: 'the uat deploy failed.' }, { noRollback: true, halts: true });
        const { code, result } = await runShip({ steps: [merge(), deploy(), later], ctx, onFailure });
        expect(code).toBe(5);
        expect(onFailure.ran).toEqual([]);
        expect(ctx.halts).toHaveLength(1);
        expect(ctx.halts[0]).toEqual(result);
        expect(result.reason.startsWith(NOT)).toBe(true);
        expect(result.reason).toMatch(/the uat deploy failed\.$/);
        expect(result).not.toHaveProperty('rolledBack');
      });

      it('a failure of any later step halts once and never rolls back', async () => {
        const ctx = fakeCtx();
        const onFailure = rollbackStep();
        const later = step('later', { ok: true }, { noRollback: true });
        const { code, result } = await runShip({ steps: [merge(), deploy(), later, watch()], ctx, onFailure });
        expect(code).toBe(5);
        expect(onFailure.ran).toEqual([]);
        expect(ctx.halts).toHaveLength(1);
        expect(result.stage).toBe('watch');
        expect(result.reason.startsWith(NOT)).toBe(true);
      });

      it('a failure before that step still rolls back once', async () => {
        const ctx = fakeCtx();
        const onFailure = rollbackStep();
        const later = step('later', { ok: true }, { noRollback: true });
        const { code, result } = await runShip({ steps: [merge(), deploy(), watch(), later], ctx, onFailure });
        expect(code).toBe(5);
        expect(onFailure.ran).toHaveLength(1);
        expect(later.ran).toHaveLength(0);
        expect(result.rolledBack).toBe(true);
      });

      it('an error thrown inside that step halts and never rolls back', async () => {
        const ctx = fakeCtx();
        const onFailure = rollbackStep();
        const later = { name: 'later', noRollback: true, run() { throw new Error('kaboom'); } };
        const { code, result } = await runShip({ steps: [merge(), deploy(), later], ctx, onFailure });
        expect(code).toBe(5);
        expect(onFailure.ran).toEqual([]);
        expect(ctx.halts).toHaveLength(1);
        expect(result.reason.startsWith(NOT)).toBe(true);
        expect(result.reason).toContain('kaboom');
      });
    });
  });

  describe('a step that asks to bring the base in again', () => {
    const MOVED = { ok: false, code: 1, stage: 'mergeable-recheck', reason: 'main moved since this branch was tested.', again: true };
    // Fails with `again` on its first `times` calls, then passes.
    const movesThen = (times) => {
      let n = 0;
      return () => (++n <= times ? MOVED : { ok: true });
    };

    it('restarts from the first step and ships, without a round or an `again` fact', async () => {
      const ctx = fakeCtx();
      const a = step('a');
      const b = step('b', { ok: true, pr: 'u' });
      const recheck = step('recheck', movesThen(1));
      const c = step('c');
      const { code, result } = await runShip({ steps: [a, b, recheck, c], ctx });
      expect(code).toBe(0);
      expect(a.ran).toHaveLength(2);
      expect(b.ran).toHaveLength(2);
      expect(recheck.ran).toHaveLength(2);
      expect(c.ran).toHaveLength(1);
      expect(result).not.toHaveProperty('again');
      expect(result).toMatchObject({ stage: 'shipped', pr: 'u' });
      const infos = ctx.events.filter((e) => e.kind === 'info');
      expect(infos).toEqual([{ kind: 'info', text: 'main moved while S-1 was releasing; bringing it in again (1 of 5).' }]);
      expect(ctx.reports).toContain('main moved; bringing it in again');
      expect(ctx.halts).toEqual([]);
    });

    it('drops the facts of the earlier pass', async () => {
      const ctx = fakeCtx();
      let pass = 0;
      const a = step('a', () => (++pass === 1 ? { ok: true, regenerated: ['x'] } : { ok: true }));
      const recheck = step('recheck', movesThen(1));
      const c = step('c');
      const { code, result } = await runShip({ steps: [a, recheck, c], ctx });
      expect(code).toBe(0);
      expect(result.regenerated).toBeUndefined();
      expect(recheck.ran[1].ctx).not.toHaveProperty('regenerated');
      expect(c.ran[0].ctx).not.toHaveProperty('regenerated');
    });

    it('is ignored after a point of no return: code 5 and HALT, nothing run again', async () => {
      const ctx = fakeCtx();
      const a = step('a');
      const merge = step('merge', { ok: true, sha: 's' }, { pointOfNoReturn: true });
      const after = step('verify', { ...MOVED, stage: 'verify' });
      const { code, result } = await runShip({ steps: [a, merge, after], ctx });
      expect(code).toBe(5);
      expect(ctx.halts).toHaveLength(1);
      expect(a.ran).toHaveLength(1);
      expect(merge.ran).toHaveLength(1);
      expect(after.ran).toHaveLength(1);
      expect(result).not.toHaveProperty('again');
    });

    it('is ignored after a deploy: the rollback runs once, nothing run again', async () => {
      const ctx = fakeCtx();
      const onFailure = step('rollback', { ok: true, command: 'vercel rollback --yes' });
      const merge = step('merge', { ok: true, sha: 's' }, { pointOfNoReturn: true });
      const deploy = step('deploy-github', { ok: true }, { deploys: true, halts: true });
      const watch = step('watch', { ok: false, code: 5, stage: 'watch', reason: 'errors went up.', again: true }, { halts: true });
      const { code, result } = await runShip({ steps: [merge, deploy, watch], ctx, onFailure });
      expect(code).toBe(5);
      expect(onFailure.ran).toHaveLength(1);
      expect(result.rolledBack).toBe(true);
      expect(merge.ran).toHaveLength(1);
      expect(deploy.ran).toHaveLength(1);
    });

    it('is ignored after a deploy with no point of no return before it: the rollback runs once, nothing run again', async () => {
      const ctx = fakeCtx();
      const onFailure = step('rollback', { ok: true, command: 'sf rollback' });
      const a = step('a');
      const deploy = step('sf-deploy', { ok: true }, { deploys: true });
      const watch = step('watch', { ...MOVED, stage: 'watch' });
      const { code, result } = await runShip({ steps: [a, deploy, watch], ctx, onFailure });
      expect(code).toBe(1);
      expect(onFailure.ran).toHaveLength(1);
      expect(result.rolledBack).toBe(true);
      expect(a.ran).toHaveLength(1);
      expect(deploy.ran).toHaveLength(1);
      expect(watch.ran).toHaveLength(1);
      expect(ctx.events.filter((e) => e.kind === 'info')).toEqual([]);
      expect(result.reason.startsWith('main kept moving')).toBe(false);
      expect(result).not.toHaveProperty('again');
      expect(ctx.halts.length).toBeGreaterThanOrEqual(1);
    });

    it('tells each step which pass of the run it is on', async () => {
      const ctx = fakeCtx();
      const a = step('a');
      const c = step('c');
      const { code } = await runShip({ steps: [a, step('recheck', movesThen(1)), c], ctx });
      expect(code).toBe(0);
      expect(a.ran[0].ctx.pass).toBe(1);
      expect(a.ran[1].ctx.pass).toBe(2);
      expect(c.ran[0].ctx.pass).toBe(2);
    });

    it('no step fact replaces pass', async () => {
      const ctx = fakeCtx();
      const b = step('b');
      const { code, result } = await runShip({ steps: [step('a', { ok: true, pass: 9 }), b], ctx });
      expect(code).toBe(0);
      expect(b.ran[0].ctx.pass).toBe(1);
      expect(result.pass).toBeUndefined();
    });

    it('is ignored once a noRollback step has started', async () => {
      const ctx = fakeCtx();
      const a = step('a');
      const later = step('promote', { ...MOVED, stage: 'promote' }, { noRollback: true });
      const { code } = await runShip({ steps: [a, later], ctx });
      expect(code).toBe(1);
      expect(a.ran).toHaveLength(1);
      expect(ctx.halts).toHaveLength(1);
    });

    it('holds the ship lock across the loop-backs and releases it once', async () => {
      const ctx = fakeCtx();
      await runShip({ steps: [step('a'), step('recheck', movesThen(2))], ctx });
      expect(ctx.locks.log.filter((l) => l[0] === 'take')).toEqual([['take', 'ship']]);
      expect(ctx.locks.log.filter((l) => l[0] === 'release')).toEqual([['release', 'ship']]);
      expect(ctx.locks.held.has('ship')).toBe(false);
    });

    it('stops after 5 loop-backs with the step\'s own failure, saying the base kept moving, and releases the lock', async () => {
      const ctx = fakeCtx();
      const a = step('a');
      const recheck = step('recheck', MOVED);
      const after = step('merge', { ok: true }, { pointOfNoReturn: true });
      const { code, result } = await runShip({ steps: [a, recheck, after], ctx });
      expect(code).toBe(1);
      expect(result.stage).toBe('mergeable-recheck');
      expect(result.reason).toBe('main kept moving: brought it in 5 times during this release. main moved since this branch was tested.');
      expect(result).not.toHaveProperty('again');
      expect(a.ran).toHaveLength(6);
      expect(after.ran).toHaveLength(0);
      expect(ctx.halts).toEqual([]);
      expect(ctx.events.filter((e) => e.kind === 'info')).toHaveLength(5);
      expect(ctx.locks.log.filter((l) => l[0] === 'take')).toHaveLength(1);
      expect(ctx.locks.log.filter((l) => l[0] === 'release')).toHaveLength(1);
      expect(ctx.locks.held.has('ship')).toBe(false);
    });

    it('a passing step that says again is not a loop-back', async () => {
      const ctx = fakeCtx();
      const a = step('a');
      const b = step('b', { ok: true, again: true });
      const { code, result } = await runShip({ steps: [a, b], ctx });
      expect(code).toBe(0);
      expect(a.ran).toHaveLength(1);
      expect(result).not.toHaveProperty('again');
    });
  });

  it('a step that throws fails with code 1', async () => {
    const ctx = fakeCtx();
    const boom = { name: 'boom', run() { throw new Error('kaboom'); } };
    const { code, result } = await runShip({ steps: [boom], ctx });
    expect(code).toBe(1);
    expect(result).toMatchObject({ stage: 'boom', reason: expect.stringContaining('kaboom') });
  });

  it('an existing HALT exits 8 before taking the lock', async () => {
    const ctx = fakeCtx({ halted: true });
    const a = step('a');
    const { code } = await runShip({ steps: [a], ctx });
    expect(code).toBe(8);
    expect(ctx.locks.log).toEqual([]);
    expect(a.ran).toHaveLength(0);
  });

  it('a branch without the prefix exits 1', async () => {
    const ctx = fakeCtx({ rules: [['git rev-parse --abbrev-ref HEAD', 'main\n']] });
    const { code, result } = await runShip({ steps: [step('a')], ctx });
    expect(code).toBe(1);
    expect(result.reason).toContain('story/');
    expect(ctx.locks.log).toEqual([]);
  });

  it('a dirty tree exits 1', async () => {
    const ctx = fakeCtx({ rules: [['git status --porcelain', ' M a.js\n']] });
    expect((await runShip({ steps: [step('a')], ctx })).code).toBe(1);
  });

  it('a dirty tree still exits 1 with the uncommitted reason', async () => {
    const ctx = fakeCtx({
      rules: [
        ['git status --porcelain', ' M a.js\n'],
        ['git rev-parse -q --verify MERGE_HEAD', '91be1d0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'],
      ],
    });
    const { code, result } = await runShip({ steps: [step('a')], ctx });
    expect(code).toBe(1);
    expect(result.reason).toBe('The working tree has uncommitted changes.');
  });

  it('a merge in progress exits 1 before taking the lock, even with a clean tree', async () => {
    const ctx = fakeCtx({ rules: [['git rev-parse -q --verify MERGE_HEAD', '91be1d0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n']] });
    const a = step('a');
    const { code, result } = await runShip({ steps: [a], ctx });
    expect(code).toBe(1);
    expect(result.stage).toBe('start');
    expect(result.reason).toMatch(/merge is in progress/);
    expect(ctx.locks.log).toEqual([]);
    expect(a.ran).toHaveLength(0);
    expect(ctx.sh.calls.filter((c) => c.startsWith('git fetch'))).toEqual([]);
  });

  it('no merge in progress lets the release go on', async () => {
    const ctx = fakeCtx({ rules: [['git rev-parse -q --verify MERGE_HEAD', 1]] });
    const a = step('a');
    const { code } = await runShip({ steps: [a], ctx });
    expect(code).toBe(0);
    expect(a.ran).toHaveLength(1);
    expect(ctx.sh.calls).toContain('git rev-parse -q --verify MERGE_HEAD');
  });

  it('no commits ahead of the base exits 1 and releases the lock', async () => {
    const ctx = fakeCtx({ rules: [['git rev-list --count origin/main..HEAD', '0\n']] });
    const a = step('a');
    const { code, result } = await runShip({ steps: [a], ctx });
    expect(code).toBe(1);
    expect(result.reason).toMatch(/no commits ahead/);
    expect(a.ran).toHaveLength(0);
    expect(ctx.locks.held.has('ship')).toBe(false);
  });

  it('retries the fetch three times, then exits 1', async () => {
    const ctx = fakeCtx({ rules: [['git fetch', 1]] });
    const { code } = await runShip({ steps: [step('a')], ctx });
    expect(code).toBe(1);
    expect(ctx.sh.calls.filter((c) => c.startsWith('git fetch'))).toHaveLength(3);
    expect(ctx.locks.held.has('ship')).toBe(false);
  });

  it('releases the ship lock on success and on failure', async () => {
    const ok = fakeCtx();
    await runShip({ steps: [step('a')], ctx: ok });
    expect(ok.locks.held.has('ship')).toBe(false);
    const bad = fakeCtx();
    await runShip({ steps: [step('a', { ok: false, code: 2, stage: 'ci', reason: 'x' })], ctx: bad });
    expect(bad.locks.held.has('ship')).toBe(false);
    const thrown = fakeCtx();
    await runShip({ steps: [{ name: 't', run() { throw new Error('x'); } }], ctx: thrown });
    expect(thrown.locks.held.has('ship')).toBe(false);
  });

  it('waits for a live ship lock, then takes it', async () => {
    const locks = fakeLocks({ ship: { pid: 7, slot: 'w2', story: 'S-9' } });
    const ctx = fakeCtx({ locks });
    let waits = 0;
    ctx.sleep = async (ms) => {
      ctx.sleeps.push(ms);
      if (++waits === 2) locks.held.delete('ship');
    };
    const { code } = await runShip({ steps: [step('a')], ctx });
    expect(code).toBe(0);
    expect(ctx.sleeps.filter((ms) => ms === 20_000)).toHaveLength(2);
    expect(ctx.reports).toContain('waiting for the ship lock');
  });

  it('a halt written while waiting for the lock exits 8', async () => {
    const locks = fakeLocks({ ship: { pid: 7, slot: 'w2', story: 'S-9' } });
    const ctx = fakeCtx({ locks });
    ctx.sleep = async () => {
      ctx.halted = true;
    };
    expect((await runShip({ steps: [step('a')], ctx })).code).toBe(8);
    expect(locks.held.get('ship').pid).toBe(7);
  });

  it('breaks a stale ship lock and says so', async () => {
    const locks = fakeLocks({ ship: { pid: 7, slot: 'w2', story: 'S-9', stage: 'ci', stale: true } });
    const ctx = fakeCtx({ locks });
    const { code } = await runShip({ steps: [step('a')], ctx });
    expect(code).toBe(0);
    expect(ctx.events).toHaveLength(1);
    expect(ctx.events[0]).toMatchObject({ kind: 'warn', text: expect.stringContaining('S-9') });
  });

  it('holds the ship lock as this process, for this slot and story', async () => {
    const ctx = fakeCtx();
    const a = step('a', (c) => ({ ok: true, holder: c.locks.holderOf('ship') }));
    const { result } = await runShip({ steps: [a], ctx });
    expect(result.holder).toMatchObject({ pid: 100, slot: 'w1', story: 'S-1', by: 'factory' });
  });
});

describe('lockStore', () => {
  it('maps ship and resource:<name> to the lock files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-ship-'));
    const locks = lockStore(dir);
    expect(locks.take('ship', { pid: process.pid, slot: 'w1' }).ok).toBe(true);
    expect(fs.existsSync(path.join(dir, 'locks', 'ship.json'))).toBe(true);
    expect(locks.setStage('ship', process.pid, 'push')).toBe(true);
    expect(locks.holderOf('ship')).toMatchObject({ stage: 'push', stale: false });
    expect(locks.release('ship', process.pid)).toBe(true);
    expect(locks.take('resource:schema', { pid: process.pid }).ok).toBe(true);
    expect(fs.existsSync(path.join(dir, 'locks', 'schema.json'))).toBe(true);
    expect(() => locks.holderOf('nonsense')).toThrow();
  });
});
