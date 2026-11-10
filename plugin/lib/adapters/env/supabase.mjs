// The Supabase slot environment: one local stack per slot, every port moved up by
// portStep·n. The Supabase CLI reads its ports from environment variables, so config.toml is
// never edited. Options: projectPrefix (required), portStep (100), extraPorts
// ({ NAME: { base, step } }), excludeStudio (true), colima (false).

import { defaultSh } from '../../engine/worktree.mjs';
import { hostedEnv } from '../ship/migrate-supabase.mjs';

export { hostedEnv };

export const requires = { env: [], tools: ['supabase'] };
export const requiresFor = (options = {}) => ({ env: [], tools: options.colima === true ? ['supabase', 'colima'] : ['supabase'] });

const NAME = 'env adapter supabase';

export function create(options = {}, ctx = {}) {
  const { adapter, projectPrefix, portStep = 100, extraPorts = {}, excludeStudio = true, colima = false, ...rest } = options;
  const unknown = Object.keys(rest);
  if (unknown.length) throw new Error(`${NAME}: unknown option ${unknown.join(', ')}`);
  if (typeof projectPrefix !== 'string' || !projectPrefix) throw new Error(`${NAME}: projectPrefix is required`);
  if (!Number.isInteger(portStep)) throw new Error(`${NAME}: portStep must be an integer`);
  for (const [name, p] of Object.entries(extraPorts)) {
    if (!p || !Number.isInteger(p.base) || !Number.isInteger(p.step)) throw new Error(`${NAME}: extraPorts.${name} needs integer base and step`);
  }
  const sh = ctx.sh ?? defaultSh;
  const slots = ctx.config?.slots;

  const env = (n) => {
    if (!Number.isInteger(n) || n < 1 || (slots !== undefined && n > slots)) {
      throw new Error(`There is no slot ${n}${slots !== undefined ? `; slots are 1 to ${slots}` : ''}.`);
    }
    const up = portStep * n;
    const mail = String(54324 + up);
    const out = {
      SUPABASE_PROJECT_ID: `${projectPrefix}-w${n}`,
      SUPABASE_API_PORT: String(54321 + up),
      SUPABASE_DB_PORT: String(54322 + up),
      SUPABASE_DB_SHADOW_PORT: String(54320 + up),
      SUPABASE_DB_POOLER_PORT: String(54329 + up),
      SUPABASE_STUDIO_PORT: String(54323 + up),
      SUPABASE_INBUCKET_PORT: mail,
      SUPABASE_LOCAL_SMTP_PORT: mail,
      SUPABASE_ANALYTICS_PORT: String(54327 + up),
      SUPABASE_EDGE_RUNTIME_INSPECTOR_PORT: String(8083 + n),
    };
    for (const [name, p] of Object.entries(extraPorts)) out[name] = String(p.base + p.step * n);
    out.FOREMAN_SLOT = `w${n}`;
    return out;
  };

  // The upkeep ladder, cheapest first. Each rung says what it took to get the stack up.
  const prepare = (n, path) => {
    const opts = { cwd: path, env: { ...process.env, ...env(n) } };
    const start = excludeStudio ? ['start', '-x', 'studio'] : ['start'];
    const ok = (...args) => sh('supabase', args, opts).status === 0;
    if (ok('status')) return 'up';
    if (ok(...start)) return 'restarted';
    ok('stop', '--no-backup');
    if (ok(...start)) return 'reset';
    return 'down';
  };

  const adapterOut = { env, prepare, hostedEnv };
  if (colima) {
    let tried = false;
    adapterOut.repair = () => {
      if (tried) return false;
      tried = true;
      if (sh('colima', ['status'], {}).status === 0) return true;
      return sh('colima', ['start'], {}).status === 0;
    };
  }
  return adapterOut;
}
