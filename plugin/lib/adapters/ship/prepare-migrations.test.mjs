import { describe, expect, it } from 'vitest';
import prepare from './prepare-migrations.mjs';
import { fakeCtx } from '../../../../test/ship-fakes.mjs';

const CREDS = { SUPABASE_ACCESS_TOKEN: 'tok', SUPABASE_DB_PASSWORD: 'pw' };
const DIR = 'supabase/migrations';

// added: files the branch adds; main: files on the base; all: every migration file the branch
// changes (after any renumbering).
const ctxFor = ({ added = [], main = [], all = added, env = CREDS, config = {}, rules = [] } = {}) =>
  fakeCtx({
    branch: 'story/s-1',
    env,
    config,
    rules: [
      ...rules,
      ['git diff --name-only --diff-filter=A', added.join('\n')],
      ['git ls-tree --name-only', main.join('\n')],
      ['git diff --name-only origin/main...HEAD', all.join('\n')],
    ],
  });

describe('prepare-migrations step', () => {
  it('needs git, and no credentials: the supabase-credentials step checks those', () => {
    expect(prepare.name).toBe('prepare-migrations');
    expect(prepare.needs).toEqual(['git']);
    expect(prepare.requires).toBeUndefined();
  });

  it('with no migrations needs no credentials and records none', async () => {
    const ctx = ctxFor({ env: {} });
    expect(await prepare.run(ctx)).toEqual({ ok: true, migrations: [] });
    expect(ctx.sh.calls.some((c) => c.startsWith('git mv'))).toBe(false);
  });

  it('lists the files the branch adds against the base, under the default folder', async () => {
    const ctx = ctxFor({ added: [`${DIR}/20261015110000_b.sql`], main: [`${DIR}/20261015100000_a.sql`] });
    expect(await prepare.run(ctx)).toEqual({ ok: true, migrations: [`${DIR}/20261015110000_b.sql`] });
    expect(ctx.sh.calls).toContain(`git diff --name-only --diff-filter=A origin/main...HEAD -- ${DIR}`);
    expect(ctx.sh.calls).toContain(`git ls-tree --name-only origin/main ${DIR}/`);
    expect(ctx.sh.calls).toContain(`git diff --name-only origin/main...HEAD -- ${DIR}`);
    expect(ctx.sh.calls.some((c) => c.startsWith('git mv'))).toBe(false);
    expect(ctx.sh.calls.some((c) => c.startsWith('git commit'))).toBe(false);
  });

  it('uses the configured folder, remote and base branch', async () => {
    const ctx = ctxFor({ config: { remote: 'up', baseBranch: 'trunk', ship: { steps: ['prepare-migrations'], 'prepare-migrations': { dir: 'db/migrate' } } } });
    await prepare.run(ctx);
    expect(ctx.sh.calls).toContain('git diff --name-only --diff-filter=A up/trunk...HEAD -- db/migrate');
    expect(ctx.sh.calls).toContain('git ls-tree --name-only up/trunk db/migrate/');
  });

  it('renumbers the branch migrations after the base moved, and commits the move', async () => {
    const added = [`${DIR}/20261015090000_b.sql`, `${DIR}/20261015110000_c.sql`];
    const renamed = [`${DIR}/20261015120000_b.sql`, `${DIR}/20261015120001_c.sql`];
    const ctx = ctxFor({ added, main: [`${DIR}/20261015000000_z.sql`, `${DIR}/20261015100000_a.sql`], all: renamed });
    expect(await prepare.run(ctx)).toEqual({ ok: true, migrations: renamed, renumbered: [{ from: added[0], to: renamed[0] }, { from: added[1], to: renamed[1] }] });
    expect(ctx.sh.calls).toContain(`git mv ${added[0]} ${renamed[0]}`);
    expect(ctx.sh.calls).toContain(`git mv ${added[1]} ${renamed[1]}`);
    expect(ctx.sh.calls).toContain('git commit --quiet -m S-1 Renumber migration after main moved');
  });

  it('never renumbers back in time when the base is ahead of the clock', async () => {
    const ctx = ctxFor({ added: [`${DIR}/20261015090000_b.sql`], main: [`${DIR}/20261015130000_a.sql`] });
    await prepare.run(ctx);
    expect(ctx.sh.calls).toContain(`git mv ${DIR}/20261015090000_b.sql ${DIR}/20261015130001_b.sql`);
  });

  it('a rename that fails stops the release with code 1', async () => {
    const ctx = ctxFor({ added: [`${DIR}/20261015090000_b.sql`], main: [`${DIR}/20261015100000_a.sql`], rules: [['git mv', 1]] });
    expect(await prepare.run(ctx)).toMatchObject({ ok: false, code: 1, stage: 'prepare-migrations', reason: `Could not rename ${DIR}/20261015090000_b.sql.` });
  });

  it('a commit that fails stops the release with code 1', async () => {
    const ctx = ctxFor({ added: [`${DIR}/20261015090000_b.sql`], main: [`${DIR}/20261015100000_a.sql`], rules: [['git commit', 1]] });
    expect(await prepare.run(ctx)).toMatchObject({ ok: false, code: 1, stage: 'prepare-migrations', reason: 'Could not commit the renumbered migrations.' });
  });

  it('a git diff that fails stops the release with code 1', async () => {
    const ctx = ctxFor({ rules: [['git diff', 128]] });
    expect(await prepare.run(ctx)).toMatchObject({ ok: false, code: 1, stage: 'prepare-migrations' });
  });

  it('records migrations whether or not the hosted credentials are set', async () => {
    const ctx = ctxFor({ added: [`${DIR}/20261015110000_b.sql`], env: {} });
    expect(await prepare.run(ctx)).toEqual({ ok: true, migrations: [`${DIR}/20261015110000_b.sql`] });
  });

  it('counts a migration the branch only changes, not adds', async () => {
    const ctx = ctxFor({ all: [`${DIR}/20261001000000_old.sql`], env: {} });
    expect(await prepare.run(ctx)).toEqual({ ok: true, migrations: [`${DIR}/20261001000000_old.sql`] });
  });
});
