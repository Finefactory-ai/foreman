// Ship step `prepare-migrations`: get the branch's database migrations ready before anything
// is pushed.
//
//   - Migrations apply in name order. When the base gained a newer migration while this
//     branch was open, the branch's own migrations are renamed to follow it (renumber, in
//     migrate-supabase.mjs) and the move is committed.
//   - It records `migrations`: every migration file the branch changes against the base, for
//     `supabase-credentials` and `migrate-supabase` later.
//
// Options: config.ship['prepare-migrations'] = { dir = 'supabase/migrations' }.

import { lines } from '../../engine/git.mjs';
import { newestMigration, renumber } from './migrate-supabase.mjs';

const STAGE = 'prepare-migrations';

export default {
  name: 'prepare-migrations',
  label: 'preparing the migrations',
  needs: ['git'],

  async run(ctx) {
    const { sh, config } = ctx;
    const { remote, baseBranch } = config;
    const dir = config.ship?.['prepare-migrations']?.dir ?? 'supabase/migrations';
    const target = `${remote}/${baseBranch}`;
    const fail = (reason) => ({ ok: false, code: 1, stage: STAGE, reason });
    const list = (args) => {
      const r = sh('git', args);
      return r.status === 0 ? lines(r.stdout) : null;
    };

    const added = list(['diff', '--name-only', '--diff-filter=A', `${target}...HEAD`, '--', dir]);
    if (added === null) return fail(`Could not list the migrations the branch adds against ${target}.`);
    const onBase = list(['ls-tree', '--name-only', target, `${dir}/`]);
    if (onBase === null) return fail(`Could not list the migrations on ${target}.`);

    const moves = renumber(added, newestMigration(onBase), ctx.now());
    for (const { from, to } of moves) {
      if (sh('git', ['mv', from, to]).status !== 0) return fail(`Could not rename ${from}.`);
    }
    if (moves.length > 0 && sh('git', ['commit', '--quiet', '-m', `${ctx.story} Renumber migration after ${baseBranch} moved`]).status !== 0) {
      return fail('Could not commit the renumbered migrations.');
    }

    const migrations = list(['diff', '--name-only', `${target}...HEAD`, '--', dir]);
    if (migrations === null) return fail(`Could not list the migrations the branch changes against ${target}.`);

    return moves.length > 0 ? { ok: true, migrations, renumbered: moves } : { ok: true, migrations };
  },
};
