// The ship steps by name. `stepsFor(config)` turns config `ship.steps` into step modules,
// in order. Adding a step: write its module beside this file and add it to STEPS.
//
// `config` is the resolved config (local settings layer on top), so the switches apply here,
// and the preflight, the runner, `foreman health` and the doctor all agree:
//   features.mergeableRecheck off   the mergeable-recheck step is left out
//   features.watchRollback off      the watch step is left out and there is no rollback
// A config with no features block counts as every switch on.
//
// When the config names a pack (`pack`, see plugin/packs/index.mjs), that pack's steps join the
// table. A pack's `steps` is an object of step modules, or a function of the config returning
// one, for steps whose names come from the config. A pack step may not take a core step's name.
// `packs` stands in for the real registry in tests.
//
// `stepTableFor(config)` is the whole table by name, including steps not in ship.steps.
//
// `envNamesOf(steps)` is the env names the steps declare in `requires.env`, once each, in the
// order first seen. ship, release and health load only these of Foreman's own keys.
//
// A step that parks a release (run returns { ok: true, parked: { reason, check } }) may also
// export `async check(ctx)`, which `foreman release watch` calls later to see whether the
// release finished. ctx is { config, story, slot, pr, check, park, sh, env, root, now, sleep,
// event }: `check` is the stored park.check, `park` the whole park record, and sh, env and
// root are as in `foreman ship`. It returns
//   { ok: true, done: true, note? }      the release finished
//   { ok: true, done: false, detail? }   still waiting (a plain { ok: true } too)
//   { ok: false, reason }                the release failed
// A throw or any other answer counts as a passing problem: the park is kept, the story is left
// as it is, and the next watch tries again. The table is looked up with stepTableFor, so a
// step taken out of ship.steps still answers for its parks.
// A check's `reason`, `detail` and any thrown message go into the event feed and the
// `foreman release watch` output, so they must not carry secrets: no tokens, no keys, and no
// URLs with credentials or query strings.

import mergeMain from './merge-main.mjs';
import resources from './resources.mjs';
import push from './push.mjs';
import pr from './pr.mjs';
import ci from './ci.mjs';
import merge from './merge.mjs';
import prepareMigrations from './prepare-migrations.mjs';
import supabaseCredentials from './supabase-credentials.mjs';
import migrateSupabase from './migrate-supabase.mjs';
import deployGithub from './deploy-github.mjs';
import smoke from './smoke.mjs';
import mergeableRecheck from './mergeable-recheck.mjs';
import watch from './watch.mjs';
import rollback from './rollback.mjs';
import { ROLLBACK_IN_STEPS } from '../../config/validate.mjs';
import { PACKS, packFor } from '../../../packs/index.mjs';

const STEPS = { 'merge-main': mergeMain, 'prepare-migrations': prepareMigrations, resources, 'supabase-credentials': supabaseCredentials, push, pr, ci, 'migrate-supabase': migrateSupabase, 'mergeable-recheck': mergeableRecheck, merge, 'deploy-github': deployGithub, smoke, watch };

export const DEFAULT_STEPS = ['merge-main', 'resources', 'push', 'pr', 'ci', 'mergeable-recheck', 'merge'];


const off = (config, name) => config?.features?.[name] === false;

// The switches that leave a configured step out.
const SWITCHED = { 'mergeable-recheck': 'mergeableRecheck', watch: 'watchRollback' };

// The core steps plus the steps of the pack the config names.
export function stepTableFor(config, { packs = PACKS } = {}) {
  const pack = packFor(config, packs);
  const own = typeof pack?.steps === 'function' ? pack.steps(config) : pack?.steps;
  if (!own) return STEPS;
  if (typeof own !== 'object' || Array.isArray(own)) throw new Error(`pack ${pack.name} ship steps must be an object of step modules`);
  for (const name of Object.keys(own)) {
    if (Object.hasOwn(STEPS, name)) throw new Error(`pack ${pack.name} ship step ${name} clashes with a core step`);
  }
  return { ...STEPS, ...own };
}

export function stepsFor(config, { packs = PACKS } = {}) {
  const table = stepTableFor(config, { packs });
  const steps = (config?.ship?.steps ?? DEFAULT_STEPS).map((name) => {
    if (name === 'rollback') throw new Error(ROLLBACK_IN_STEPS);
    if (!Object.hasOwn(table, name)) throw new Error(`unknown ship step: ${name}`);
    return table[name];
  });
  return steps.filter((s) => !(Object.hasOwn(SWITCHED, s.name) && off(config, SWITCHED[s.name])));
}

export function envNamesOf(steps) {
  const names = [];
  for (const step of steps) {
    for (const name of step?.requires?.env ?? []) {
      if (typeof name === 'string' && name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

// The step the runner calls when a release fails after its code went live: `rollback` when
// ship.rollback.command is set and features.watchRollback is on, else null.
export function onFailureFor(config) {
  return config?.ship?.rollback?.command && !off(config, 'watchRollback') ? rollback : null;
}
