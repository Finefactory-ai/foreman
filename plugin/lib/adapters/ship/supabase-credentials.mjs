// Ship step `supabase-credentials`: a branch with migrations cannot ship without the hosted
// database, so missing credentials stop the release here (code 3), before CI spends ten
// minutes on it. It runs after `resources`, so a branch that needs a resource another slot
// holds stops with 7 first. Names only; values are never printed.
//
// The migrations are ctx.migrations (from `prepare-migrations`); without them it lists what
// the branch changes in config.ship['migrate-supabase'].dir (default supabase/migrations).

import { lines } from '../../engine/git.mjs';
import { HOSTED_CREDENTIALS } from './migrate-supabase.mjs';

const STAGE = 'hosted-db';

export default {
  name: 'supabase-credentials',
  label: 'checking the hosted database credentials',
  needs: [],
  requires: { env: HOSTED_CREDENTIALS },

  async run(ctx) {
    const { config } = ctx;
    let migrations = ctx.migrations;
    if (!Array.isArray(migrations)) {
      const dir = config.ship?.['migrate-supabase']?.dir ?? 'supabase/migrations';
      const r = ctx.sh('git', ['diff', '--name-only', `${config.remote}/${config.baseBranch}...HEAD`, '--', dir]);
      if (r.status !== 0) return { ok: false, code: 1, stage: STAGE, reason: "Could not list the branch's migrations." };
      migrations = lines(r.stdout);
    }
    if (migrations.length === 0) return { ok: true };
    const env = ctx.env ?? process.env;
    const missing = HOSTED_CREDENTIALS.filter((name) => !String(env[name] ?? '').trim());
    if (missing.length > 0) return { ok: false, code: 3, stage: STAGE, reason: `Missing in ${config.envFile}: ${missing.join(', ')}`, migrations };
    return { ok: true };
  },
};
