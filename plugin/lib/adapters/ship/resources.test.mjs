import { describe, expect, it } from 'vitest';
import resources from './resources.mjs';
import { fakeCtx, fakeLocks } from '../../../../test/ship-fakes.mjs';

const config = {
  resources: {
    schema: { paths: ['supabase/migrations/**'], describe: 'database schema' },
    payments: { paths: ['src/payments/**'], describe: 'payment code' },
  },
};
const diff = (files) => [['git diff --name-only origin/main...HEAD', `${files.join('\n')}\n`]];

describe('resources step', () => {
  it('takes the lock of a resource the branch touches, and only that one', async () => {
    const ctx = fakeCtx({ branch: 'story/s-1', config, holderPid: 55, rules: diff(['supabase/migrations/2026_x.sql', 'src/app.ts']) });
    const r = await resources.run(ctx);
    expect(r).toEqual({ ok: true, resources: ['schema'] });
    expect(ctx.locks.held.get('resource:schema')).toMatchObject({ pid: 55, slot: 'w1', story: 'S-1', by: 'factory' });
    expect(ctx.locks.held.has('resource:payments')).toBe(false);
  });

  it('a resource held by another live slot exits 7 naming the holder', async () => {
    const locks = fakeLocks({ 'resource:schema': { pid: 9, slot: 'w2', story: 'S-7' } });
    const ctx = fakeCtx({ branch: 'story/s-1', config, locks, rules: diff(['supabase/migrations/a.sql']) });
    const r = await resources.run(ctx);
    expect(r).toMatchObject({ ok: false, code: 7, stage: 'resources', resource: 'schema' });
    expect(r.reason).toContain('w2');
    expect(r.reason).toContain('S-7');
    expect(locks.held.get('resource:schema').slot).toBe('w2');
  });

  it('a resource this slot already holds is fine', async () => {
    const locks = fakeLocks({ 'resource:schema': { pid: 9, slot: 'w1', story: 'S-1' } });
    const ctx = fakeCtx({ branch: 'story/s-1', config, locks, rules: diff(['supabase/migrations/a.sql']) });
    expect(await resources.run(ctx)).toEqual({ ok: true, resources: ['schema'] });
  });

  it('a stale holder is replaced', async () => {
    const locks = fakeLocks({ 'resource:schema': { pid: 9, slot: 'w2', story: 'S-7', stale: true } });
    const ctx = fakeCtx({ branch: 'story/s-1', config, locks, rules: diff(['supabase/migrations/a.sql']) });
    expect((await resources.run(ctx)).ok).toBe(true);
    expect(locks.held.get('resource:schema')).toMatchObject({ slot: 'w1', story: 'S-1' });
  });

  it('no resources configured: nothing to check', async () => {
    const ctx = fakeCtx({ branch: 'story/s-1' });
    expect(await resources.run(ctx)).toEqual({ ok: true, resources: [] });
  });

  it('a diff that fails exits 1', async () => {
    const ctx = fakeCtx({ branch: 'story/s-1', config, rules: [['git diff', 128]] });
    expect(await resources.run(ctx)).toMatchObject({ ok: false, code: 1 });
  });
});
