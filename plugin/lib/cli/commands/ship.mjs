// `foreman ship`: release the story branch you are on, through the project's ship steps
// (config `ship.steps`, run by lib/engine/ship.mjs). The last line printed is one JSON object
// { ok, code, ...result } and the exit code is the runner's (see ship.mjs for the codes).
// Exit 9 is a parked release: ready to promote, finishing later. Before it exits, the command
// saves the park, marks the story ready-to-promote with the story source and adds the event
// (lib/engine/parks.mjs), and says how that went in `parkSaved` and `storyUpdated`. `ok` is
// true for 0 and 9.
//
//   foreman ship --story <id>     ship the current branch for that story (also --story=<id>,
//                                 or FOREMAN_STORY)
//   foreman ship --preflight      say what each step needs and which env names are missing;
//                                 change nothing. A configured rollback is listed last, with
//                                 `when: "on failure"`.
//
// A release that stops for a reason the owner should see (exit 2, 4, 5, 6 or 10, or 1 from a step) is
// also written on the story itself when features.jiraComments is on, or salesforceComments for a Case
// (engine/story-notes.mjs): what stopped and why, with the pull request. Exit 0, 7, 8 and 9 add nothing: a park comments already.
// The printed JSON and the exit code are the same either way.
//
// The story id is never rebuilt from the branch name. Foreman's own keys from .env.foreman
// (config `foremanEnvFile`; only the registry names the steps declare in requires.env), then
// the project's env file (config `envFile`), are loaded into this process so the steps'
// commands get their values; they are never printed. The config is read fresh each run with the local settings layer on top, so
// the ship timeouts and the watchRollback and mergeableRecheck switches apply to the next
// release. When the config names a pack, that pack's steps can be in `ship.steps`; `packs`
// stands in for the real pack registry (plugin/packs/index.mjs) in tests.
//
// The runner also gets `rolledBackAt`: when the pack says the story's last release was rolled
// back (else null). The pr step uses it to open a new pull request instead of reusing one merged
// before the rollback.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadResolved } from '../../settings/load.mjs';
import { foremanEnvName, loadForemanKeys } from '../../engine/foreman-keys.mjs';
import { envNamesOf, onFailureFor, stepTableFor, stepsFor } from '../../adapters/ship/registry.mjs';
import { runShip as realRunShip, lockStore } from '../../engine/ship.mjs';
import { currentSlot, stateDir } from '../../engine/paths.mjs';
import { addEvent, beat, setStage } from '../../engine/state.mjs';
import { parkStory } from '../../engine/parks.mjs';
import { noteOnStory } from '../../engine/story-notes.mjs';
import { rolledBackAtOf } from '../../engine/resume-close.mjs';
import { PACKS, packFor } from '../../../packs/index.mjs';

// sh(cmd, args, { env, cwd, timeout }): a step may run a command with an environment or a
// folder of its own, and a time limit in ms; a command stopped at its limit says timedOut.
export const realSh = (cwd, env) => (cmd, args = [], opts = {}) => {
  const r = spawnSync(cmd, args, { cwd: opts.cwd ?? cwd, env: opts.env ?? env, timeout: opts.timeout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? String(r.error.message) : ''), timedOut: r.error?.code === 'ETIMEDOUT' };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Status keeping is best effort: it never fails a release.
const quiet = (fn) => {
  try {
    fn();
  } catch {
    // ignore
  }
};

// `--flag value` or `--flag=value`.
function argValue(args, flag) {
  const eq = args.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1) || null;
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
}

function warningsFor(config, packs) {
  const warnings = [];
  const steps = config.ship?.steps ?? [];
  const watchOff = config.features?.watchRollback === false;
  const recheckOff = config.features?.mergeableRecheck === false;
  if (watchOff && (steps.includes('watch') || config.ship?.rollback?.command)) {
    warnings.push('features.watchRollback is off; the watch step and the rollback are skipped');
  }
  if (recheckOff && steps.includes('mergeable-recheck')) {
    warnings.push('features.mergeableRecheck is off; the mergeable-recheck step is skipped, so the base branch can move after CI and the pull request fail to merge');
  }
  if ((config.ship?.ci?.required ?? []).length === 0 && steps.includes('ci')) {
    warnings.push('ship.ci.required is empty; CI is detected by settling');
  }
  if (steps.includes('migrate-supabase') && !config.ship?.['migrate-supabase']?.projectRef) {
    warnings.push('ship["migrate-supabase"].projectRef is not set');
  }
  if (steps.includes('migrate-supabase')) {
    const check = steps.indexOf('supabase-credentials');
    const push = steps.indexOf('push');
    if (check === -1 || (push !== -1 && check > push)) {
      warnings.push('ship.steps has migrate-supabase without supabase-credentials before push; missing hosted credentials show only after CI');
    }
  }
  if (steps.includes('smoke') && (config.ship?.smoke?.urls ?? []).length === 0) {
    warnings.push('ship.smoke.urls is empty; the live site is not checked');
  }
  if (!watchOff && steps.includes('watch') && !config.ship?.rollback?.command) {
    warnings.push('ship.steps has watch but ship.rollback.command is not set; a problem after the deploy halts releases but leaves production as it is');
  }
  if (!watchOff && config.ship?.rollback?.command && !stepsFor(config, { packs }).some((s) => s.deploys)) {
    warnings.push('ship.rollback.command is set but ship.steps has no deploy step (deploy-github); the rollback runs only for a failure after a successful deploy, so it never runs');
  }
  // The first step that wants mergeable-recheck right before it (`beforeNoReturn`).
  const table = stepTableFor(config, { packs });
  const first = steps.findIndex((name) => table[name]?.beforeNoReturn === true);
  if (!(recheckOff && steps.includes('mergeable-recheck')) && first !== -1 && steps[first - 1] !== 'mergeable-recheck') {
    warnings.push(`ship.steps has no mergeable-recheck right before ${steps[first]}; the base branch can move after CI and the pull request fail to merge once the database has changed`);
  }
  return warnings;
}

// The env names the steps declare (step.requires.env) that are not set. Names only.
function missingEnv(steps, env) {
  return envNamesOf(steps).filter((name) => !String(env[name] ?? '').trim());
}

// The real ctx for the runner: locks and HALT in the state folder, status to the slot.
function shipContext({ config, story, shell, shellEnv, root, env, clock, packs }) {
  const dir = stateDir(root, config, env);
  // When the story's last release was rolled back (null for none); the pr step opens a new pull
  // request instead of reusing one merged before it. The same rule as `foreman story next`.
  let pack = null;
  try {
    pack = packFor(config, packs);
  } catch {
    // no pack, no rollback record
  }
  const rolledBackAt = rolledBackAtOf(pack, { dir, story });
  const slot = currentSlot(env);
  const haltFile = join(dir, 'HALT');
  const supervisor = Number(env.FOREMAN_SUPERVISOR_PID);
  return {
    config,
    story,
    slot,
    pid: process.pid,
    holderPid: Number.isInteger(supervisor) && supervisor > 0 ? supervisor : process.pid,
    sh: shell,
    env: shellEnv,
    root,
    rolledBackAt,
    locks: lockStore(dir),
    sleep,
    now: clock,
    report: (detail) =>
      quiet(() => {
        setStage(dir, 'release', detail, clock(), slot);
        beat(dir, slot, clock());
      }),
    beat: () => quiet(() => beat(dir, slot, clock())),
    isHalted: () => existsSync(haltFile),
    halt: (result) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(haltFile, `${clock().toISOString()} ${JSON.stringify(result)}\n`);
    },
    event: (text, kind) => quiet(() => addEvent(dir, text, kind, clock(), slot)),
  };
}

export function makeShipCommand({ runShip = realRunShip, sh = null, packs = PACKS } = {}) {
  return {
    name: 'ship',
    summary: 'release the story branch through the configured ship steps (ship --story <id> | --preflight)',

    async run(args, { cwd, env, stdout, root, now }) {
      const clock = now ?? (() => new Date());
      const print = (code, result) => {
        stdout.write(`${JSON.stringify({ ok: code === 0 || code === 9, code, ...result })}\n`);
        return code;
      };

      const { config, errors } = loadResolved(root, { env, packs });
      if (errors.length) {
        return print(1, { stage: 'start', reason: errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join('; ') });
      }
      let steps;
      try {
        steps = stepsFor(config, { packs });
      } catch (err) {
        return print(1, { stage: 'start', reason: err.message });
      }
      const onFailure = onFailureFor(config);

      try {
        loadForemanKeys({ root, config, target: env, names: envNamesOf(onFailure ? [...steps, onFailure] : steps) });
      } catch {
        return print(1, { stage: 'start', reason: `Could not read ${foremanEnvName(config)}.` });
      }
      const envFile = join(root, config.envFile);
      if (existsSync(envFile)) {
        try {
          process.loadEnvFile(envFile);
        } catch {
          return print(1, { stage: 'start', reason: `Could not read ${config.envFile}.` });
        }
      }
      const shellEnv = env === process.env ? process.env : { ...process.env, ...env };
      const shell = sh ?? realSh(cwd, shellEnv);

      if (args.includes('--preflight')) {
        stdout.write(
          `${JSON.stringify({
            preflight: true,
            gh_signed_in: shell('gh', ['auth', 'status']).status === 0,
            steps: [
              ...steps.map((s) => ({ name: s.name, needs: s.needs ?? [] })),
              ...(onFailure ? [{ name: onFailure.name, needs: onFailure.needs ?? [], when: 'on failure' }] : []),
            ],
            missing_env: missingEnv(onFailure ? [...steps, onFailure] : steps, shellEnv),
            warnings: warningsFor(config, packs),
          })}\n`,
        );
        return 0;
      }

      const story = argValue(args, '--story') || env.FOREMAN_STORY || '';
      if (!story) return print(1, { stage: 'start', reason: 'no story id: pass --story or set FOREMAN_STORY' });

      try {
        const ctx = shipContext({ config, story, shell, shellEnv, root, env, clock, packs });
        const { code, result } = await runShip({ steps, ctx, onFailure });
        if (code === 9) {
          const recorded = await parkStory(
            { dir: stateDir(root, config, env), root, config, env, now: clock, slot: currentSlot(env) },
            { id: story, step: result.step, reason: result.parked?.reason, check: result.parked?.check, pr: result.pr ?? null },
          );
          return print(code, { ...result, ...recorded });
        }
        if ([2, 4, 5, 6, 10].includes(code) || (code === 1 && result?.stage !== 'start')) {
          quiet(() => noteOnStory({ root, config, env, now: clock }, story, 'release', { code, stage: result?.stage ?? null, reason: result?.reason ?? '', pr: result?.pr ?? null }));
        }
        return print(code, result);
      } catch (err) {
        return print(1, { stage: 'runner', reason: `The ship runner failed: ${err?.message ?? err}` });
      }
    },
  };
}

export default makeShipCommand();
