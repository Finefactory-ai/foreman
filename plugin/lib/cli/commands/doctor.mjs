// `foreman doctor`: checks that this machine and project are ready to run Foreman. Runs every
// check (see lib/engine/doctor-checks.mjs) and prints one line each:
//
//   ok    <name>            (or `ok    <name> — <detail>` when the check says more)
//   warn  <name> — <detail>
//   FAIL  <name> — <detail>
//
// Under each warn and FAIL line goes what to do, with the set-up step that fixes it
// (lib/setup/steps.mjs):
//
//         fix: <hint> (dashboard: Set up › <step title>)
//
// Exits 1 when any error-level check failed; warnings alone exit 0. Variable values are never
// printed. `packs` stands in for the real pack registry (plugin/packs/index.mjs) in tests.
//
// doctorContext(...) loads the config and builds the checks' ctx; `foreman setup` uses it too.
//
// `foreman doctor --end-strays` runs no check: it ends the processes that are not this run's
// (engine/strays.mjs, the ones the 'stray processes' line counts), prints "Ending <what>: pid
// a, b." then "Ended N." and any "Still running: pid x.", and exits 1 when some are left, else
// 0 ("No stray processes." when there are none). When ps fails it writes "Could not list the
// running processes." to stderr, ends nothing and exits 1. It refuses inside a story session
// (FOREMAN_RUN=1), so a slot never ends another slot's tests. `strays` ({ find, end }) stands in
// for findStrays and endStrays in tests. Any other argument is ignored.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadResolved } from '../../settings/load.mjs';
import { buildChecks } from '../../engine/doctor-checks.mjs';
import { stateDir } from '../../engine/paths.mjs';
import { runCheck } from '../../setup/status.mjs';
import { stepById } from '../../setup/steps.mjs';
import { PACKS } from '../../../packs/index.mjs';
import { endStrays, findStrays, straysText } from '../../engine/strays.mjs';
import { refuseInRun } from '../../engine/run-guard.mjs';

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const JIRA_CALL_TIMEOUT_MS = 20_000;

// fetch with a time limit, so an unreachable Jira cannot hang the doctor.
const timedFetch = (url, opts = {}) => globalThis.fetch(url, { ...opts, signal: AbortSignal.timeout(JIRA_CALL_TIMEOUT_MS) });

const realSh = (cwd, env) => (cmd, args = [], opts = {}) => {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...opts });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? String(r.error.message) : '') };
};

// The resolved config, the state folder and the ctx every doctor check runs with. `env` is laid
// over the process environment; `sh` is a factory (cwd, env) -> shell, for tests. `dir` is the
// state folder even when the config is invalid.
export function doctorContext({ root, cwd = root, env = {}, sh = null, sourceRoot = SOURCE_ROOT, pluginsDir = null, fetch = timedFetch, packs = PACKS, now } = {}) {
  const merged = { ...process.env, ...env };
  const { config, errors, localWarnings, dir } = loadResolved(root, { env: merged, packs });
  const ctx = {
    root,
    env: merged,
    sh: sh ? sh(cwd, merged) : realSh(root, merged),
    fs,
    sourceRoot,
    pluginsDir: pluginsDir ?? path.join(merged.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'plugins'),
    configErrors: errors,
    localWarnings,
    fetch,
    now,
    packs,
    platform: process.platform,
    home: os.homedir(),
    uid: process.getuid?.(),
  };
  return { config, dir: dir ?? stateDir(root, null, merged), ctx };
}

// The fix line under a warn or FAIL, or null when the result says nothing to do.
export function fixLine(fix) {
  if (!fix) return null;
  const step = fix.step ? stepById(fix.step) : undefined;
  if (fix.hint) return `      fix: ${fix.hint}${step ? ` (dashboard: Set up › ${step.title})` : ''}\n`;
  return step ? `      fix: dashboard: Set up › ${step.title}\n` : null;
}

// `foreman doctor --end-strays` (see the header).
async function endStraysNow({ root, cwd, env, stdout, stderr, sh, sourceRoot, pluginsDir, fetch, packs, now, strays }) {
  const refused = refuseInRun(env, 'foreman doctor --end-strays');
  if (refused) {
    stderr.write(`${refused}\n`);
    return 1;
  }
  const { dir, ctx } = doctorContext({ root, cwd, env, sh, sourceRoot, pluginsDir, fetch, packs, now });
  const found = strays.find({ root, dir, sh: ctx.sh, platform: ctx.platform, readlink: fs.readlinkSync });
  if (!found.listed) {
    stderr.write('Could not list the running processes.\n');
    return 1;
  }
  if (!found.strays.length) {
    stdout.write('No stray processes.\n');
    return 0;
  }
  stdout.write(`Ending ${straysText(found)}: pid ${found.strays.map((s) => s.pid).join(', ')}.\n`);
  const r = await strays.end(found.strays);
  stdout.write(`Ended ${r.ended.length}.\n`);
  if (r.left.length) stdout.write(`Still running: pid ${r.left.join(', ')}.\n`);
  return r.left.length ? 1 : 0;
}

export function makeDoctorCommand({ sh = null, sourceRoot = SOURCE_ROOT, pluginsDir = null, fetch = timedFetch, packs = PACKS, strays = { find: findStrays, end: endStrays } } = {}) {
  return {
    name: 'doctor',
    summary: 'check that this machine and project are ready to run Foreman',

    async run(args, { cwd, env, stdout, stderr, root, now }) {
      if ((args ?? []).includes('--end-strays')) {
        return endStraysNow({ root, cwd, env: env ?? {}, stdout, stderr: stderr ?? stdout, sh, sourceRoot, pluginsDir, fetch, packs, now, strays });
      }
      const { config, ctx } = doctorContext({ root, cwd, env, sh, sourceRoot, pluginsDir, fetch, packs, now });

      let failed = false;
      for (const check of buildChecks(config, ctx)) {
        const result = await runCheck(check, ctx, typeof now === 'function' ? { now } : {});
        if (result.ok) stdout.write(result.detail ? `ok    ${check.name} — ${result.detail}\n` : `ok    ${check.name}\n`);
        else {
          if (result.level === 'warn') stdout.write(`warn  ${check.name} — ${result.detail}\n`);
          else {
            failed = true;
            stdout.write(`FAIL  ${check.name} — ${result.detail}\n`);
          }
          const line = fixLine(result.fix);
          if (line) stdout.write(line);
        }
      }
      return failed ? 1 : 0;
    },
  };
}

export default makeDoctorCommand();
