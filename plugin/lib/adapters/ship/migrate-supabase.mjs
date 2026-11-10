// Ship step `migrate-supabase`: apply the branch's migrations to the hosted Supabase project,
// after CI and before the merge. Database before code: the new code is written for the new
// schema, and migrations only ever add to what the running code needs.
//
//   - No migrations (ctx.migrations, from `prepare-migrations`) → nothing to do.
//   - `supabase link` + `supabase db push --linked --yes`, with the hosted environment.
//   - A failure exits 4 (nothing merged) and writes HALT. Success passes the point of no
//     return: the live database has changed, so a later failure exits 5 and halts.
//   - healthy(): the hosted database has exactly the base's migrations (Supabase Management
//     API, SUPABASE_ACCESS_TOKEN; the token goes only into the request header).
//
// Options: config.ship['migrate-supabase'] = { projectRef (required), dir = 'supabase/migrations' }.
//
// Helpers, shared with `prepare-migrations`:
//   - hostedEnv: the environment for Supabase CLI commands against the live project.
//   - When another story landed a migration while this branch was open, the branch's own
//     migrations may now sort before main's. Postgres applies them in name order, so they
//     are renamed to stamps after main's newest, keeping their order (renumber).
//
// Migration names start with a 14-digit UTC stamp, YYYYMMDDHHMMSS. Stamp arithmetic goes
// through Date so seconds carry into minutes, days and months correctly.

import { basename } from 'node:path';
import { fetchBase, lines } from '../../engine/git.mjs';

// What a release with migrations needs from the env file. Names only; never printed.
export const HOSTED_CREDENTIALS = ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_DB_PASSWORD'];
const TIMEOUT_MS = 15_000;
const STAGE = 'hosted-db';

// A slot names its own local stack through SUPABASE_PROJECT_ID and SUPABASE_*_PORT (the supabase env adapter).
// The CLI also reads SUPABASE_PROJECT_ID as the live project for --linked commands, so those
// commands get the environment without the slot's settings (found 2026-10-15: "Invalid
// project ref format" on the first hosted migration from a slot).
export function hostedEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/^SUPABASE_(PROJECT_ID|[A-Z_]*_PORT)$/.test(key)));
}

const pad = (n, width = 2) => String(n).padStart(width, '0');

export const utcStamp = (date) =>
  `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
  `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;

// The 14-digit stamp at the front of a migration file name, or null.
export function tsOf(name) {
  const m = basename(String(name)).match(/^(\d{14})(?=_|\.|$)/);
  return m ? m[1] : null;
}

// A stamp back to a Date (UTC).
function stampDate(stamp) {
  const [y, mo, d, h, mi, s] = stamp.match(/^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)$/).slice(1).map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s));
}

// The migration with the latest stamp, or null when none has one.
export function newestMigration(names) {
  let best = null;
  for (const name of names) {
    const ts = tsOf(name);
    if (ts && (best === null || ts > tsOf(best))) best = name;
  }
  return best;
}

// branchFiles: migration file names the branch adds, in order. Returns [{ from, to }].
// When any branch file's stamp is <= newest main's, every branch file is renumbered, in
// order, starting at max(now, newest main + 1 s) and adding 1 s each. Otherwise [].
export function renumber(branchFiles, newestMainFile, now = new Date()) {
  const mainTs = newestMainFile ? tsOf(newestMainFile) : null;
  if (!mainTs) return [];
  const clash = branchFiles.some((f) => {
    const ts = tsOf(f);
    return ts !== null && ts <= mainTs;
  });
  if (!clash) return [];

  const afterMain = stampDate(mainTs).getTime() + 1000;
  const nowSecond = Math.floor(now.getTime() / 1000) * 1000;
  const start = Math.max(nowSecond, afterMain);
  return branchFiles.map((from, i) => {
    const name = basename(from);
    const dir = from.slice(0, from.length - name.length);
    const rest = name.slice(tsOf(name)?.length ?? 0);
    return { from, to: `${dir}${utcStamp(new Date(start + i * 1000))}${rest}` };
  });
}

// `git ls-tree --name-only <base> <dir>/` → the version of each migration file.
export const mainVersions = (lsTree) =>
  String(lsTree)
    .split('\n')
    .map((line) => line.trim().match(/(?:^|\/)(\d+)_[^/]*\.sql$/)?.[1])
    .filter(Boolean);

// Whether the hosted project has exactly `versions` applied. { ok, missing, extra, error? }
export async function hostedMatchesMain({ ref, token, versions, fetchImpl = fetch }) {
  const failed = (error) => ({ ok: false, missing: [], extra: [], error });
  if (!token) return failed('no Supabase access token is set');
  let rows;
  try {
    const r = await fetchImpl(`https://api.supabase.com/v1/projects/${ref}/database/migrations`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (r.status !== 200) return failed(`the Supabase API answered ${r.status}`);
    rows = await r.json();
  } catch {
    return failed('the Supabase API did not answer');
  }
  if (!Array.isArray(rows)) return failed('the Supabase API sent an unexpected answer');
  const hosted = new Set(rows.map((row) => String(row?.version)));
  const onMain = new Set(versions);
  const missing = versions.filter((v) => !hosted.has(v));
  const extra = [...hosted].filter((v) => !onMain.has(v));
  return { ok: missing.length === 0 && extra.length === 0, missing, extra };
}

const optionsOf = (config) => {
  const o = config.ship?.['migrate-supabase'] ?? {};
  return { projectRef: o.projectRef, dir: o.dir ?? 'supabase/migrations' };
};
const NO_REF = 'ship["migrate-supabase"].projectRef is not set in foreman.config.json.';

export default {
  name: 'migrate-supabase',
  label: 'applying migrations to the live database',
  needs: ['supabase'],
  requires: { env: HOSTED_CREDENTIALS },
  // Its result passes the point of no return when it changed the live database, so a
  // release cut off while it runs is finished, not redone (startup.mjs mustFinishFor).
  mayMarkNoReturn: true,
  // The preflight wants mergeable-recheck right before it: the live database changes here.
  beforeNoReturn: true,
  // hosted-db is the lock stage the old release script left while migrating; a release cut
  // off there is finished on startup too (startup.mjs mustFinishFor).
  mustFinish: ['hosted-db'],

  async run(ctx) {
    const { sh, config } = ctx;
    const { projectRef, dir } = optionsOf(config);
    let migrations = ctx.migrations;
    if (!Array.isArray(migrations)) {
      const r = sh('git', ['diff', '--name-only', `${config.remote}/${config.baseBranch}...HEAD`, '--', dir]);
      if (r.status !== 0) return { ok: false, code: 1, stage: STAGE, reason: 'Could not list the branch\'s migrations.' };
      migrations = lines(r.stdout);
    }
    if (migrations.length === 0) return { ok: true };
    if (!projectRef) return { ok: false, code: 1, stage: STAGE, reason: NO_REF };

    ctx.report?.(`applying ${migrations.length} migration(s) to the live database`);
    const env = hostedEnv(ctx.env ?? process.env);
    const pushed =
      sh('supabase', ['link', '--project-ref', projectRef], { env }).status === 0 &&
      sh('supabase', ['db', 'push', '--linked', '--yes'], { env }).status === 0;
    if (!pushed) return { ok: false, code: 4, stage: STAGE, reason: 'supabase db push failed; nothing was merged.' };
    return { ok: true, noReturn: true };
  },

  async healthy(ctx) {
    const { config } = ctx;
    const { projectRef, dir } = optionsOf(config);
    if (!projectRef) return { ok: false, reason: NO_REF };
    const base = config.baseBranch;
    const target = `${config.remote}/${base}`;
    let versions = null;
    if (await fetchBase(ctx)) {
      const r = ctx.sh('git', ['ls-tree', '--name-only', target, `${dir}/`]);
      if (r.status === 0) versions = mainVersions(r.stdout);
    }
    if (versions === null) return { ok: false, reason: `Could not read ${base}'s migrations.` };

    const env = ctx.env ?? process.env;
    const db = await hostedMatchesMain({ ref: projectRef, token: env.SUPABASE_ACCESS_TOKEN, versions, fetchImpl: ctx.fetch ?? fetch });
    const problems = [];
    if (db.error) problems.push(`The hosted database could not be checked: ${db.error}.`);
    if (db.missing.length) problems.push(`The live database is missing migrations that ${base} has: ${db.missing.join(', ')}.`);
    if (db.extra.length) problems.push(`The live database has migrations that ${base} does not: ${db.extra.join(', ')}.`);
    if (problems.length) return { ok: false, reason: problems.join(' ') };
    return { ok: true, reason: `The hosted database matches ${base}.` };
  },
};
