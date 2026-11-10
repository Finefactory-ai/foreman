// `foreman health`: the checks behind "I've fixed it". Runs the healthy() check of every
// configured ship step that has one (lib/adapters/ship/), such as: the hosted database has
// exactly the base's migrations, the base's newest commit is deployed, the live site
// answers below 500, and the project's watch command reports no problems. The rollback is
// not a step and has no check.
//
//   foreman health          every configured check
//   foreman health --site   only the live-site check (the `smoke` step's)
//
// Prints one JSON line { ok, reason, checks: [{ step, ok, reason }] } and exits 0 when every
// check passes, 1 otherwise. With nothing to check it passes with the reason
// "no health checks are configured". Foreman's own keys from .env.foreman (config
// `foremanEnvFile`; only the registry names the steps declare in requires.env), then the
// project's env file (config `envFile`), are loaded for the checks' keys; they are never
// printed. The config has the local settings
// layer on top, so with features.watchRollback off there is no watch check.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadResolved } from '../../settings/load.mjs';
import { foremanEnvName, loadForemanKeys } from '../../engine/foreman-keys.mjs';
import { envNamesOf, stepsFor } from '../../adapters/ship/registry.mjs';
import { realSh } from './ship.mjs';

export const NO_CHECKS = 'no health checks are configured';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function makeHealthCommand({ sh = null, fetch: fetchImpl = null } = {}) {
  return {
    name: 'health',
    summary: 'check production is healthy before a halt is cleared (health [--site])',

    async run(args, { cwd, env, stdout, root, now }) {
      const print = (ok, reason, checks = []) => {
        stdout.write(`${JSON.stringify({ ok, reason, checks })}\n`);
        return ok ? 0 : 1;
      };

      const { config, errors } = loadResolved(root, { env });
      if (errors.length) return print(false, errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join('; '));
      let steps;
      try {
        steps = stepsFor(config);
      } catch (err) {
        return print(false, err.message);
      }
      try {
        loadForemanKeys({ root, config, target: env, names: envNamesOf(steps) });
      } catch {
        return print(false, `Could not read ${foremanEnvName(config)}.`);
      }
      const envFile = join(root, config.envFile);
      if (existsSync(envFile)) {
        try {
          process.loadEnvFile(envFile);
        } catch {
          return print(false, `Could not read ${config.envFile}.`);
        }
      }
      const shellEnv = env === process.env ? process.env : { ...process.env, ...env };
      const ctx = {
        config,
        sh: sh ?? realSh(cwd, shellEnv),
        env: shellEnv,
        fetch: fetchImpl ?? globalThis.fetch,
        sleep,
        now: now ?? (() => new Date()),
        root,
      };

      const wanted = args.includes('--site') ? steps.filter((s) => s.name === 'smoke') : steps;
      const checks = [];
      for (const step of wanted) {
        if (typeof step.healthy !== 'function') continue;
        let r;
        try {
          r = await step.healthy(ctx);
        } catch (err) {
          r = { ok: false, reason: `The ${step.name} check failed: ${err?.message ?? err}` };
        }
        if (r == null) continue; // nothing to check, as configured
        checks.push({ step: step.name, ok: r.ok === true, reason: String(r.reason ?? '') });
      }
      if (checks.length === 0) return print(true, NO_CHECKS);
      const failing = checks.filter((c) => !c.ok);
      const reasons = (list) => list.map((c) => c.reason).filter(Boolean).join(' ');
      return failing.length ? print(false, reasons(failing), checks) : print(true, reasons(checks), checks);
    },
  };
}

export default makeHealthCommand();
