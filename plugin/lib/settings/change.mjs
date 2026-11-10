// Reading and changing settings for a project, on either layer. `foreman settings`, `foreman
// features` and (later) the dashboard's /api/settings all go through here, so they check and
// say things the same way.
//
//   settingsView({ root, env })                 { config, rows, warnings } or { error }; each row
//                                               is { name, label, description, group, type,
//                                               default, applies, limits, value, source } plus
//                                               `warning` when its local value is ignored, and
//                                               `unset` when the setting has a "no value" text
//                                               (a role's model), and `inFile` when the name is
//                                               not the setting's path in the file (a reviewer's
//                                               model)
//   settingValue({ root, env }, name)           { value } or { error }
//   changeSetting({ root, env }, { name, value, layer, reset })
//                                               { lines } or { error }
//
// `layer` is "local" (default: <stateDir>/settings.json) or "team" (foreman.config.json).
// `ctx.dir`, when given, is the state folder (the dashboard passes the one it serves).
// A value is checked against the registry (type, limits, whether it applies to this project);
// a team change is also checked as a whole config before the file is written, resolved the way
// loadConfig resolves it, with the project folder. A setting with its
// own team edit (registry.mjs `team`, a role's model) is written through teamEdit.

import fs from 'node:fs';
import { withDefaults } from '../config/defaults.mjs';
import { loadConfig } from '../config/load.mjs';
import { stateDir } from '../engine/paths.mjs';
import { readLocal, resetLocal, setLocal } from './local.mjs';
import { checkValue, findSetting, looksSecret, settingsFor, shown } from './registry.mjs';
import { checkLocal, configWithLocal, effective, ignoredLocal, writeSetting } from './resolve.mjs';
import { readTeam, teamEdit, teamReset, teamSet, withTeamValue } from './team.mjs';

export const LAYERS = ['local', 'team'];
export const COMMIT_REMINDER = 'foreman.config.json changed; commit it so the team gets it';

export const display = (v) => (v === null || v === undefined ? '(not set)' : typeof v === 'string' ? v : JSON.stringify(v));

// The registry entry for `name`, or the reason there is none.
export function settingFor(name) {
  const e = findSetting(name);
  if (e) return { entry: e };
  if (looksSecret(name)) return { error: `${name} looks like a secret; secrets go in the project's env file, never in settings` };
  return { error: `unknown setting: ${name}` };
}

function open({ root, env, dir: given }) {
  const { config, errors } = loadConfig(root);
  if (!config) return { error: errors.map((e) => (e.path ? `foreman.config.json ${e.path}: ${e.message}` : e.message)).join('\n') };
  const dir = given ?? stateDir(root, config, env);
  return { config, dir, local: readLocal(dir) };
}

// The limits a setting's type takes, worked out for `config` (workers is at most slots).
export function limitsOf(e, config) {
  const out = {};
  for (const key of ['min', 'max', 'above', 'values', 'keys']) {
    const v = typeof e[key] === 'function' ? e[key](config) : e[key];
    if (v !== undefined) out[key] = Array.isArray(v) ? [...v] : v;
  }
  return out;
}

// Every setting that applies to this project, with its value and where the value comes from.
export function settingsView(ctx) {
  const project = open(ctx);
  if (project.error) return project;
  const { config, local } = project;
  const values = effective(config, local.values);
  const resolved = configWithLocal(config, local.values);
  const ignored = ignoredLocal(config, local.values);
  const rows = settingsFor(config).filter((e) => shown(e, config)).map((e) => ({
    name: e.name,
    label: e.label,
    description: e.description,
    group: e.group,
    type: e.type,
    default: e.default,
    applies: e.applies,
    limits: limitsOf(e, resolved),
    ...(e.unset ? { unset: e.unset } : {}),
    ...(e.inFile ? { inFile: e.inFile } : {}),
    ...values[e.name],
    ...(ignored[e.name] ? { warning: ignored[e.name] } : {}),
  }));
  return { config, rows, warnings: [...local.warnings, ...checkLocal(config, local.values).warnings] };
}

// { value, source } in effect for one setting, or { error }: a role's model has no value for
// a project without that role.
function inEffect(ctx, e) {
  const project = open(ctx);
  if (project.error) return project;
  const v = effective(project.config, project.local.values)[e.name];
  return v ?? { error: `${e.name} applies only when ${e.whenText}` };
}

// { value } in effect for one setting, or { error }.
export function settingValue(ctx, name) {
  const { entry: e, error } = settingFor(name);
  if (error) return { error };
  const v = inEffect(ctx, e);
  return v.error ? { error: v.error } : { value: v.value };
}

const now = (ctx, e) => {
  const v = inEffect(ctx, e);
  return v.error ? v.error : `now ${display(v.value)} (${v.source})`;
};

export function changeSetting(ctx, { name, value, layer = 'local', reset = false }) {
  if (!LAYERS.includes(layer)) return { error: `layer must be local or team, not ${layer}` };
  const { entry: e, error } = settingFor(name);
  if (error) return { error };
  const project = open(ctx);
  if (project.error) return project;
  const { config, dir, local } = project;

  if (reset) {
    if (layer === 'local') {
      let removed;
      try {
        removed = resetLocal(dir, name);
      } catch (err) {
        return { error: err.message };
      }
      if (!removed) return { lines: [`${name} has no local value`] };
      return { lines: [`${name}: local value removed; ${now(ctx, e)}`] };
    }
    const r = e.team ? teamEdit(ctx.root, (raw) => e.team.remove(raw)) : teamReset(ctx.root, name);
    if (r.errors.length) return { error: `foreman.config.json would be invalid: ${r.errors.join('; ')}` };
    if (!(e.team ? r.changed : r.removed)) return { lines: [`${name} has no team value`] };
    return { lines: [`${name}: team value removed; ${now(ctx, e)}`, COMMIT_REMINDER] };
  }

  if (!shown(e, config)) return { error: `${name} applies only when ${e.whenText}` };
  const lines = [`${name} = ${display(value)} (${layer}; applies ${e.applies})`];

  if (layer === 'local') {
    const problem = checkValue(e, value, writeSetting(configWithLocal(config, local.values), e, value));
    if (problem) return { error: `${name}: ${problem}` };
    try {
      setLocal(dir, name, value);
    } catch (err) {
      return { error: err.message };
    }
    return { lines };
  }

  const team = readTeam(ctx.root);
  if (team.errors) return { error: team.errors.join('\n') };
  const next = e.team ? e.team.set(team.raw, value, config) : withTeamValue(team.raw, name, value);
  const problem = checkValue(e, value, withDefaults(next, { project: { root: ctx.root, fs } }));
  if (problem) return { error: `${name}: ${problem}` };
  const r = e.team ? teamEdit(ctx.root, (raw) => e.team.set(raw, value, config)) : teamSet(ctx.root, name, value);
  if (r.errors.length) return { error: `foreman.config.json would be invalid: ${r.errors.join('; ')}` };
  lines.push(COMMIT_REMINDER);
  const kept = checkLocal(config, local.values).values;
  if (Object.hasOwn(kept, name)) lines.push(`note: the local value ${display(kept[name])} still wins on this machine; \`foreman settings reset ${name}\` drops it`);
  return { lines };
}
