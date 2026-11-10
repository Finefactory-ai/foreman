import { describe, expect, it } from 'vitest';
import credentials from './supabase-credentials.mjs';
import { fakeCtx } from '../../../../test/ship-fakes.mjs';

const CREDS = { SUPABASE_ACCESS_TOKEN: 'tok', SUPABASE_DB_PASSWORD: 'pw' };
const DIR = 'supabase/migrations';
const MIG = [`${DIR}/20261015110000_b.sql`];

// migrations: ctx.migrations from prepare-migrations (undefined: the step lists them itself);
// all: what git diff lists then.
const ctxFor = ({ migrations, all = [], env = CREDS, config = {}, rules = [] } = {}) =>
  fakeCtx({ env, config, ...(migrations === undefined ? {} : { migrations }), rules: [...rules, ['git diff --name-only origin/main...HEAD', all.join('\n')]] });

describe('supabase-credentials step', () => {
  it('needs nothing to run and declares the hosted credentials', () => {
    expect(credentials.name).toBe('supabase-credentials');
    expect(credentials.needs).toEqual([]);
    expect(credentials.requires.env).toEqual(['SUPABASE_ACCESS_TOKEN', 'SUPABASE_DB_PASSWORD']);
  });

  it('passes with every credential set, or with no migrations', async () => {
    expect(await credentials.run(ctxFor({ migrations: MIG }))).toEqual({ ok: true });
    expect(await credentials.run(ctxFor({ migrations: [], env: {} }))).toEqual({ ok: true });
  });

  it('with migrations and missing credentials exits 3 naming only what is missing, never a value', async () => {
    const ctx = ctxFor({ migrations: MIG, env: { SUPABASE_DB_PASSWORD: 'secret-pw', SUPABASE_ACCESS_TOKEN: '  ' } });
    const r = await credentials.run(ctx);
    expect(r).toEqual({ ok: false, code: 3, stage: 'hosted-db', reason: 'Missing in .env.local: SUPABASE_ACCESS_TOKEN', migrations: MIG });
    expect(JSON.stringify(r)).not.toContain('secret-pw');
  });

  it('names the configured env file and every missing name', async () => {
    const ctx = ctxFor({ migrations: MIG, env: {}, config: { envFile: '.env' } });
    expect((await credentials.run(ctx)).reason).toBe('Missing in .env: SUPABASE_ACCESS_TOKEN, SUPABASE_DB_PASSWORD');
  });

  it('lists the migrations itself when no earlier step did, in the migrate-supabase folder', async () => {
    const ctx = ctxFor({ all: [`db/m/20261001000000_old.sql`], env: {}, config: { ship: { steps: ['supabase-credentials'], 'migrate-supabase': { dir: 'db/m' } } } });
    expect(await credentials.run(ctx)).toMatchObject({ ok: false, code: 3 });
    expect(ctx.sh.calls).toContain('git diff --name-only origin/main...HEAD -- db/m');
  });

  it('a git diff that fails stops the release with code 1', async () => {
    const ctx = ctxFor({ rules: [['git diff', 128]] });
    expect(await credentials.run(ctx)).toMatchObject({ ok: false, code: 1, stage: 'hosted-db' });
  });
});
