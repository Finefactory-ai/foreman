// `foreman release watch`: finish the releases that are ready to promote. Each park (a release
// a ship step parked, lib/engine/parks.mjs) is checked through its step's `check`: a finished
// one moves its story to Done with the story source's write-back, a hard failure blocks the
// story with the reason, and one still waiting stays for the next watch. The supervisor runs
// this every few minutes; anyone can run it by hand.
//
// The last line printed is one JSON object, { ok: true, checked, results: [{ id, step,
// outcome, detail }] }, and the exit code is 0 whatever the parks said. One watch runs at a
// time (the lock locks/release-watch.json in the state folder); another one prints
// { ok: true, busy: true } and checks nothing. A config that cannot be read exits 1.
//
// Foreman's own keys from .env.foreman (config `foremanEnvFile`; only the registry names the
// steps declare in requires.env, from the whole step table, since a park can belong to a step
// no longer in ship.steps), then the project's env file (config `envFile`), are loaded into
// this process so the checks' commands get their values; they are never printed. `packs` stands in for the real pack
// registry (plugin/packs/index.mjs) in tests.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadResolved } from '../../settings/load.mjs';
import { foremanEnvName, loadForemanKeys } from '../../engine/foreman-keys.mjs';
import { envNamesOf, stepTableFor } from '../../adapters/ship/registry.mjs';
import { stateDir } from '../../engine/paths.mjs';
import { addEvent } from '../../engine/state.mjs';
import { breakIfStale, release, take } from '../../engine/locks.mjs';
import { watchParks } from '../../engine/parks.mjs';
import { realSh } from './ship.mjs';
import { PACKS } from '../../../packs/index.mjs';

const EXIT_USAGE = 64;
const USAGE = 'usage: foreman release watch\n';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The lock: taken now, or taken after breaking one whose holder is gone. False when another
// watch is running.
function takeLock(file, holder) {
  if (take(file, holder).ok) return true;
  if (breakIfStale(file)) return take(file, holder).ok;
  return false;
}

export function makeReleaseCommand({ sh = null, packs = PACKS } = {}) {
  return {
    name: 'release',
    summary: 'finish parked releases (release watch)',

    async run(args, { cwd, env, stdout, stderr, root, now }) {
      const clock = now ?? (() => new Date());
      const print = (code, result) => {
        stdout.write(`${JSON.stringify(result)}\n`);
        return code;
      };
      if (args.length !== 1 || args[0] !== 'watch') {
        stderr.write(USAGE);
        return EXIT_USAGE;
      }

      const { config, errors } = loadResolved(root, { env, packs });
      if (errors.length) return print(1, { ok: false, reason: errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join('; ') });
      let table;
      try {
        table = stepTableFor(config, { packs });
      } catch (err) {
        return print(1, { ok: false, reason: err.message });
      }

      try {
        loadForemanKeys({ root, config, target: env, names: envNamesOf(Object.values(table)) });
      } catch {
        return print(1, { ok: false, reason: `Could not read ${foremanEnvName(config)}.` });
      }
      const envFile = join(root, config.envFile);
      if (existsSync(envFile)) {
        try {
          process.loadEnvFile(envFile);
        } catch {
          return print(1, { ok: false, reason: `Could not read ${config.envFile}.` });
        }
      }
      const shellEnv = env === process.env ? process.env : { ...process.env, ...env };
      const shell = sh ?? realSh(cwd, shellEnv);

      const dir = stateDir(root, config, env);
      const lock = join(dir, 'locks', 'release-watch.json');
      if (!takeLock(lock, { pid: process.pid, by: 'release-watch', at: clock().toISOString() })) {
        return print(0, { ok: true, busy: true, reason: 'another release watch is running' });
      }
      try {
        const ctxFor = (park) => ({
          config,
          story: park.id,
          slot: park.slot ?? null,
          pr: park.pr ?? null,
          check: park.check,
          park,
          sh: shell,
          env: shellEnv,
          root,
          now: clock,
          sleep,
          event: (text, kind) => {
            try {
              addEvent(dir, text, kind, clock(), park.slot ?? null);
            } catch {
              // the feed is best effort
            }
          },
        });
        const { results } = await watchParks({ dir, root, config, env, now: clock, table, ctxFor });
        return print(0, { ok: true, checked: results.length, results });
      } finally {
        release(lock, process.pid);
      }
    },
  };
}

export default makeReleaseCommand();
