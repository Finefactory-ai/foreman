// The Supabase slot environment: one local stack per slot, every port moved up by
// portStep·n. The Supabase CLI reads its ports from environment variables, so config.toml is
// never edited. Options: projectPrefix (required), portStep (100), extraPorts
// ({ NAME: { base, step } }), excludeStudio (true), colima (false).
//
//
// At a stop (sweep({ stopping: true, limitMs })) this run's slot stacks that run are stopped, their
// data kept, so a held story's stack starts again as it was. A stack is this run's when its
// Supabase project id (the container label com.supabase.cli.project) is exactly <projectPrefix>-wN,
// so another factory's stacks on the same machine are never touched.
//
// Colima is shared by every Foreman run on the machine, so what is known about it lives in
// ~/.config/foreman/colima (ctx.machineDir): `started` when a Foreman run started it (repair), and
// runs/<pid> for each supervisor that used it (prepare, repair). At a stop the run takes its own
// entry out and forgets entries whose supervisor is gone. Colima is stopped only by the last run
// to stop, only when a Foreman run started it, and only when no container is left on it.

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runAsync } from '../../engine/run-async.mjs';
import { defaultAlive } from '../../engine/supervisor-pid.mjs';
import { defaultSh } from '../../engine/worktree.mjs';
import { hostedEnv } from '../ship/migrate-supabase.mjs';

export { hostedEnv };

export const requires = { env: [], tools: ['supabase'] };
export const requiresFor = (options = {}) => ({ env: [], tools: options.colima === true ? ['supabase', 'colima'] : ['supabase'] });

const NAME = 'env adapter supabase';
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
  const run = ctx.run ?? runAsync;
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
    if (colima) usingColima();
    const opts = { cwd: path, env: { ...process.env, ...env(n) } };
    const start = excludeStudio ? ['start', '-x', 'studio'] : ['start'];
    const ok = (...args) => sh('supabase', args, opts).status === 0;
    if (ok('status')) return 'up';
    if (ok(...start)) return 'restarted';
    ok('stop', '--no-backup');
    if (ok(...start)) return 'reset';
    return 'down';
  };

  // What every Foreman run on the machine knows about Colima (see the header). A file that cannot
  // be written or read only costs leaving Colima up at the stop.
  const colimaDir = join(ctx.machineDir ?? join(process.env.HOME || homedir(), '.config', 'foreman'), 'colima');
  const startedFile = join(colimaDir, 'started');
  const runsDir = join(colimaDir, 'runs');
  const me = String(ctx.pid ?? process.pid);
  const alive = ctx.alive ?? defaultAlive;
  const quietly = (fn) => {
    try {
      return fn();
    } catch {
      return undefined;
    }
  };
  const usingColima = () =>
    quietly(() => {
      mkdirSync(runsDir, { recursive: true });
      writeFileSync(join(runsDir, me), `${ctx.root ?? ''}\n`);
    });
  const startedColima = () =>
    quietly(() => {
      mkdirSync(colimaDir, { recursive: true });
      writeFileSync(startedFile, `${new Date().toISOString()}\n`);
    });
  // The other supervisors still using Colima; the entries of those that are gone are removed.
  const otherRuns = () =>
    (quietly(() => readdirSync(runsDir)) ?? []).filter((name) => {
      if (name === me) return false;
      const pid = Number(name);
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) return true;
      quietly(() => rmSync(join(runsDir, name), { force: true }));
      return false;
    });

  const slotOf = new RegExp(`^${escapeRe(projectPrefix)}-w(\\d+)$`);
  const sweep = async ({ stopping = false, limitMs = 60_000 } = {}) => {
    if (!stopping) return { warnings: [] };
    const deadline = Date.now() + limitMs;
    const timeoutMs = () => Math.max(1000, deadline - Date.now());
    const ps = async (format) => {
      const r = await run('docker', ['ps', '--format', format], { cwd: ctx.root, timeoutMs: timeoutMs() });
      return r.status === 0 ? r.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : null;
    };
    const warnings = [];
    const projects = await ps('{{.Label "com.supabase.cli.project"}}');
    if (projects !== null) {
      const slotsUp = [...new Set(projects.map((p) => slotOf.exec(p)?.[1]).filter(Boolean))];
      await Promise.all(
        slotsUp.map(async (n) => {
          const id = `${projectPrefix}-w${n}`;
          const r = await run('supabase', ['stop', '--project-id', id], { cwd: ctx.root, timeoutMs: timeoutMs() });
          if (r.status !== 0) warnings.push(`slot ${n} stack did not stop; run \`supabase stop --project-id ${id}\``);
        }),
      );
    }
    if (colima) {
      quietly(() => rmSync(join(runsDir, me), { force: true }));
      // No Docker means no Colima to stop.
      if (projects !== null && otherRuns().length === 0 && existsSync(startedFile)) {
        const left = (await ps('{{.Names}}')) ?? [];
        if (left.length) {
          warnings.push(`Colima left running: other containers still use it (${left.slice(0, 5).join(', ')})`);
        } else if ((await run('colima', ['stop'], { timeoutMs: timeoutMs() })).status === 0) {
          quietly(() => rmSync(startedFile, { force: true }));
        } else {
          warnings.push('Colima did not stop; run `colima stop`');
        }
      }
    }
    return { warnings };
  };

  const adapterOut = { env, prepare, hostedEnv, sweep };
  if (colima) {
    let tried = false;
    adapterOut.repair = () => {
      if (tried) return false;
      tried = true;
      usingColima();
      if (sh('colima', ['status'], {}).status === 0) return true;
      if (sh('colima', ['start'], {}).status !== 0) return false;
      startedColima();
      return true;
    };
  }
  return adapterOut;
}
