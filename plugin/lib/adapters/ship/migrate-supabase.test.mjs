import { describe, expect, it } from 'vitest';
import migrate, { hostedEnv, hostedMatchesMain, mainVersions, newestMigration, renumber, tsOf, utcStamp } from './migrate-supabase.mjs';
import prepare from './prepare-migrations.mjs';
import credentials from './supabase-credentials.mjs';
import { runShip } from '../../engine/ship.mjs';
import { fakeCtx } from '../../../../test/ship-fakes.mjs';

describe('hostedEnv', () => {
  it('drops the slot\'s local stack settings, which the CLI would read as the live project', () => {
    const env = hostedEnv({ SUPABASE_PROJECT_ID: 'acme-app-w1', SUPABASE_API_PORT: '54421', SUPABASE_DB_PASSWORD: 'p', SUPABASE_ACCESS_TOKEN: 't', PATH: '/bin' });
    expect(env).toEqual({ SUPABASE_DB_PASSWORD: 'p', SUPABASE_ACCESS_TOKEN: 't', PATH: '/bin' });
  });
});

describe('renumber', () => {
  const now = new Date('2026-10-15T12:00:00Z');
  it('leaves newer migrations alone', () => {
    expect(renumber(['20261015110000_b.sql'], '20261015100000_a.sql', now)).toEqual([]);
  });
  it('moves every branch migration after main, keeping their order', () => {
    expect(renumber(['20261015090000_b.sql', '20261015110000_c.sql'], '20261015100000_a.sql', now)).toEqual([
      { from: '20261015090000_b.sql', to: '20261015120000_b.sql' },
      { from: '20261015110000_c.sql', to: '20261015120001_c.sql' },
    ]);
  });
  it('never goes back in time when main is ahead of the clock', () => {
    expect(renumber(['20261015090000_b.sql'], '20261015130000_a.sql', now)).toEqual([{ from: '20261015090000_b.sql', to: '20261015130001_b.sql' }]);
  });
  it('treats an equal stamp as a clash', () => {
    expect(renumber(['20261015100000_b.sql'], '20261015100000_a.sql', now)).toHaveLength(1);
  });
  it('formats UTC stamps', () => {
    expect(utcStamp(new Date('2026-01-02T03:04:05Z'))).toBe('20260102030405');
  });
  it('carries over midnight and month ends through the calendar', () => {
    expect(renumber(['20261031235959_b.sql', '20261031235959_c.sql'], '20261031235959_a.sql', new Date('2026-10-01T00:00:00Z'))).toEqual([
      { from: '20261031235959_b.sql', to: '20261101000000_b.sql' },
      { from: '20261031235959_c.sql', to: '20261101000001_c.sql' },
    ]);
  });
});

describe('tsOf', () => {
  it('reads the 14-digit stamp at the front of a migration name', () => {
    expect(tsOf('20261015100000_a.sql')).toBe('20261015100000');
    expect(tsOf('supabase/migrations/20261015100000_a.sql')).toBe('20261015100000');
  });
  it('returns null for a name without one', () => {
    expect(tsOf('README.md')).toBe(null);
  });
});

describe('newestMigration', () => {
  it('picks the latest stamp, whatever the order given', () => {
    expect(newestMigration(['20261015100000_a.sql', '20261015120000_c.sql', '20261015110000_b.sql'])).toBe('20261015120000_c.sql');
  });
  it('returns null when there are none', () => {
    expect(newestMigration([])).toBe(null);
    expect(newestMigration(['README.md'])).toBe(null);
  });
});

// ── the step ──────────────────────────────────────────────────────────────────────────────

const MIG = ['supabase/migrations/20261015110000_b.sql'];
const HOSTED = { SUPABASE_ACCESS_TOKEN: 'tok', SUPABASE_DB_PASSWORD: 'pw', SUPABASE_PROJECT_ID: 'acme-app-w1', SUPABASE_DB_PORT: '54422', PATH: '/bin' };
const stepConfig = (options = { projectRef: 'uoizcnvpsbrzcvkxdjez' }) => ({ ship: { steps: ['migrate-supabase'], 'migrate-supabase': options } });

describe('migrate-supabase step', () => {
  it('needs the supabase CLI and the hosted credentials, and may pass the point of no return', () => {
    expect(migrate.name).toBe('migrate-supabase');
    expect(migrate.needs).toEqual(['supabase']);
    expect(migrate.requires.env).toEqual(['SUPABASE_ACCESS_TOKEN', 'SUPABASE_DB_PASSWORD']);
    expect(migrate.mayMarkNoReturn).toBe(true);
    expect(migrate.pointOfNoReturn).toBeFalsy();
  });

  it('with no migrations does nothing and leaves the point of no return alone', async () => {
    const ctx = fakeCtx({ config: stepConfig(), migrations: [], env: HOSTED });
    expect(await migrate.run(ctx)).toEqual({ ok: true });
    expect(ctx.sh.calls.some((c) => c.startsWith('supabase'))).toBe(false);
  });

  it('links the project and pushes the migrations with the hosted environment', async () => {
    const ctx = fakeCtx({ config: stepConfig(), migrations: MIG, env: HOSTED });
    expect(await migrate.run(ctx)).toEqual({ ok: true, noReturn: true });
    const i = ctx.sh.calls.indexOf('supabase link --project-ref uoizcnvpsbrzcvkxdjez');
    const j = ctx.sh.calls.indexOf('supabase db push --linked --yes');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(j).toBeGreaterThan(i);
    const hosted = { SUPABASE_ACCESS_TOKEN: 'tok', SUPABASE_DB_PASSWORD: 'pw', PATH: '/bin' };
    expect(ctx.sh.opts[i].env).toEqual(hosted);
    expect(ctx.sh.opts[j].env).toEqual(hosted);
  });

  it('works out the migrations itself when no earlier step recorded them', async () => {
    const ctx = fakeCtx({ config: stepConfig(), env: HOSTED, rules: [['git diff --name-only origin/main...HEAD -- supabase/migrations', `${MIG[0]}\n`]] });
    expect(await migrate.run(ctx)).toEqual({ ok: true, noReturn: true });
    const none = fakeCtx({ config: stepConfig(), env: HOSTED });
    expect(await migrate.run(none)).toEqual({ ok: true });
  });

  it('a failed link or db push exits 4 and says nothing was merged', async () => {
    for (const failing of ['supabase link', 'supabase db push']) {
      const ctx = fakeCtx({ config: stepConfig(), migrations: MIG, env: HOSTED, rules: [[failing, 1]] });
      expect(await migrate.run(ctx)).toEqual({ ok: false, code: 4, stage: 'hosted-db', reason: 'supabase db push failed; nothing was merged.' });
    }
  });

  it('without a project ref it stops with code 1 before touching the database', async () => {
    const ctx = fakeCtx({ config: stepConfig({}), migrations: MIG, env: HOSTED });
    expect(await migrate.run(ctx)).toMatchObject({ ok: false, code: 1, stage: 'hosted-db', reason: expect.stringContaining('projectRef') });
    expect(ctx.sh.calls.some((c) => c.startsWith('supabase'))).toBe(false);
  });
});

describe('migrate-supabase in a release', () => {
  const steps = (calls) => [
    { name: 'push', run: () => (calls.push('push'), { ok: true }) },
    migrate,
    { name: 'merge', run: () => (calls.push('merge'), { ok: false, code: 1, stage: 'merge', reason: 'The merge failed.' }) },
  ];

  it('a failed db push exits 4, writes HALT and never merges', async () => {
    const calls = [];
    const ctx = fakeCtx({ config: stepConfig(), migrations: MIG, env: HOSTED, rules: [['supabase db push', 1]] });
    const { code, result } = await runShip({ steps: steps(calls), ctx });
    expect(code).toBe(4);
    expect(result).toMatchObject({ stage: 'hosted-db' });
    expect(ctx.halts).toHaveLength(1);
    expect(calls).toEqual(['push']);
  });

  it('after the database changed, a merge failure exits 5 and halts', async () => {
    const ctx = fakeCtx({ config: stepConfig(), migrations: MIG, env: HOSTED });
    const { code } = await runShip({ steps: steps([]), ctx });
    expect(code).toBe(5);
    expect(ctx.halts).toHaveLength(1);
  });

  it('with no migrations, a merge failure exits 1 and does not halt', async () => {
    const ctx = fakeCtx({ config: stepConfig(), migrations: [], env: HOSTED });
    const { code } = await runShip({ steps: steps([]), ctx });
    expect(code).toBe(1);
    expect(ctx.halts).toEqual([]);
  });
});

describe('prepare-migrations, supabase-credentials, then migrate-supabase in a release', () => {
  it('missing credentials with migrations exit 3 before anything is pushed', async () => {
    const pushed = [];
    const push = { name: 'push', run: () => (pushed.push(1), { ok: true }) };
    const ctx = fakeCtx({
      config: stepConfig(),
      env: { SUPABASE_DB_PASSWORD: 'pw' },
      rules: [['git diff --name-only', `${MIG[0]}\n`], ['git ls-tree', '']],
    });
    const { code, result } = await runShip({ steps: [prepare, credentials, push, migrate], ctx });
    expect(code).toBe(3);
    expect(result).toMatchObject({ stage: 'hosted-db', reason: 'Missing in .env.local: SUPABASE_ACCESS_TOKEN', migrations: MIG });
    expect(pushed).toEqual([]);
    expect(ctx.halts).toEqual([]);
  });
});

// ── health: the hosted database has exactly the base's migrations ────────────────────────────

const res = (status, body) => Promise.resolve({ status, ok: status < 400, json: () => Promise.resolve(body) });

describe('mainVersions', () => {
  it('reads migration versions from git', () => {
    expect(mainVersions('supabase/migrations/20261013000000_a.sql\nsupabase/migrations/20261014000000_b.sql\n')).toEqual(['20261013000000', '20261014000000']);
  });
  it('ignores files that are not migrations', () => {
    expect(mainVersions('supabase/migrations/README.md\nsupabase/migrations/.gitkeep\n')).toEqual([]);
  });
});

describe('hostedMatchesMain', () => {
  it('compares hosted migrations with main', async () => {
    const f = () => res(200, [{ version: '20261013000000', name: 'a' }]);
    expect(await hostedMatchesMain({ ref: 'r', token: 't', versions: ['20261013000000', '20261014000000'], fetchImpl: f })).toMatchObject({ ok: false, missing: ['20261014000000'], extra: [] });
  });
  it('finds migrations the hosted database has that main does not', async () => {
    const f = () => res(200, [{ version: '20261013000000' }, { version: '20261099000000' }]);
    expect(await hostedMatchesMain({ ref: 'r', token: 't', versions: ['20261013000000'], fetchImpl: f })).toEqual({ ok: false, missing: [], extra: ['20261099000000'] });
  });
  it('passes when they match, sending the token only as a bearer header', async () => {
    const seen = [];
    const f = (url, init) => (seen.push({ url, init }), res(200, [{ version: '20261013000000' }]));
    expect(await hostedMatchesMain({ ref: 'abc', token: 't0k', versions: ['20261013000000'], fetchImpl: f })).toEqual({ ok: true, missing: [], extra: [] });
    expect(seen[0].url).toBe('https://api.supabase.com/v1/projects/abc/database/migrations');
    expect(seen[0].url).not.toContain('t0k');
    expect(seen[0].init.headers.authorization).toBe('Bearer t0k');
  });
  it('fails without a token, on a non-200 answer, on no answer and on an odd answer', async () => {
    expect((await hostedMatchesMain({ ref: 'r', token: '', versions: [], fetchImpl: () => res(200, []) })).error).toMatch(/no Supabase access token/);
    expect((await hostedMatchesMain({ ref: 'r', token: 't', versions: [], fetchImpl: () => res(401, []) })).error).toMatch(/401/);
    expect((await hostedMatchesMain({ ref: 'r', token: 't', versions: [], fetchImpl: () => Promise.reject(new Error('x')) })).error).toMatch(/did not answer/);
    expect((await hostedMatchesMain({ ref: 'r', token: 't', versions: [], fetchImpl: () => res(200, { rows: [] }) })).error).toMatch(/unexpected/);
  });
});

describe('migrate-supabase healthy', () => {
  const lsTree = 'supabase/migrations/20261013000000_a.sql\nsupabase/migrations/20261014000000_b.sql\n';
  const ctxWith = (rows, extra = {}) =>
    fakeCtx({
      config: stepConfig(),
      env: { SUPABASE_ACCESS_TOKEN: 'tok' },
      fetch: (url) => (url.includes('api.supabase.com') ? res(200, rows) : res(500)),
      rules: [['git ls-tree --name-only origin/main supabase/migrations/', lsTree]],
      ...extra,
    });

  it('passes only when the hosted database has exactly the base\'s migrations', async () => {
    const ctx = ctxWith([{ version: '20261013000000' }, { version: '20261014000000' }]);
    expect(await migrate.healthy(ctx)).toEqual({ ok: true, reason: 'The hosted database matches main.' });
    expect(ctx.sh.calls).toContain('git fetch --quiet origin main');
  });

  it('says which migrations are missing or extra', async () => {
    const r = await migrate.healthy(ctxWith([{ version: '20261013000000' }, { version: '20261099000000' }]));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('The live database is missing migrations that main has: 20261014000000.');
    expect(r.reason).toContain('The live database has migrations that main does not: 20261099000000.');
  });

  it('fails when the hosted database cannot be checked, without printing the token', async () => {
    const ctx = ctxWith([], { fetch: () => res(401, []) });
    const r = await migrate.healthy(ctx);
    expect(r).toEqual({ ok: false, reason: 'The hosted database could not be checked: the Supabase API answered 401.' });
    const noToken = await migrate.healthy(ctxWith([], { env: {} }));
    expect(noToken.ok).toBe(false);
    expect(noToken.reason).toContain('no Supabase access token');
  });

  it('fails when the base\'s migrations cannot be read', async () => {
    const r = await migrate.healthy(ctxWith([], { rules: [['git ls-tree', 128]] }));
    expect(r).toEqual({ ok: false, reason: "Could not read main's migrations." });
  });

  it('fails without a project ref', async () => {
    const r = await migrate.healthy(fakeCtx({ config: stepConfig({}), env: { SUPABASE_ACCESS_TOKEN: 'tok' } }));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('projectRef');
  });
});

describe('migrate-supabase flags', () => {
  it('wants mergeable-recheck right before it, and finishes a release the old script cut off at hosted-db', () => {
    expect(migrate.beforeNoReturn).toBe(true);
    expect(migrate.mustFinish).toEqual(['hosted-db']);
  });
});
