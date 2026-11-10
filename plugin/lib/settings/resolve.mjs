// How the settings layers combine: the local value when set and valid,
// else the team value (foreman.config.json), else the registry's default.
//
//   effective(config, local)      { name: { value, source } } for every setting of this project
//                                 (registry.mjs settingsFor), source being default, team or local
//   configWithLocal(config, local) the config with the valid local values put in at their paths;
//                                 every reader uses this, so nothing reads settings.json itself
//   checkLocal(config, local)     { values, warnings }: the local values that count, and why
//                                 each other one is ignored (for doctor and the panel)
//   ignoredLocal(config, local)   { name: why } for the ignored ones, by name
//
// `config` is the loaded config (defaults merged in). A value in it counts as the team's when
// it differs from the registry default; one equal to the default reads as the default.
// readSetting and writeSetting read and write one setting on a config, through the entry's own
// get and put when it has them (a reviewer's model is inside an array), else its dotted path.

import { checkValue, findSetting, settingsFor, shown } from './registry.mjs';

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined ? v : structuredClone(v));

export function getPath(obj, name) {
  let at = obj;
  for (const key of name.split('.')) {
    if (!isPlain(at) || !Object.hasOwn(at, key)) return undefined;
    at = at[key];
  }
  return at;
}

// Sets `name` in `obj` in place, making the objects on the way.
export function setPath(obj, name, value) {
  const keys = name.split('.');
  let at = obj;
  for (const key of keys.slice(0, -1)) {
    if (!isPlain(at[key])) at[key] = {};
    at = at[key];
  }
  at[keys.at(-1)] = value;
  return obj;
}

export const readSetting = (obj, e) => (typeof e.get === 'function' ? e.get(obj) : getPath(obj, e.name));
export const writeSetting = (obj, e, value) => (typeof e.put === 'function' ? e.put(obj, value) : setPath(obj, e.name, value));

function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (isPlain(a) && isPlain(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

const dependsOnConfig = (e) => typeof e.min === 'function' || typeof e.max === 'function';

// { values, why }: the local values that count, and why each other one is ignored, by name.
function sortLocal(config, local) {
  if (local === undefined || local === null) return { values: {}, why: {} };
  if (!isPlain(local)) return { values: {}, why: null };
  const candidates = {};
  const why = {};
  // First each value on its own, then the limits that depend on the others (workers <= slots).
  for (const [name, value] of Object.entries(local)) {
    const e = findSetting(name);
    const problem = !e ? 'unknown setting' : !shown(e, config) ? `applies only when ${e.whenText}` : dependsOnConfig(e) ? null : checkValue(e, value, config);
    if (problem) why[name] = problem;
    else candidates[name] = value;
  }
  const merged = clone(config) ?? {};
  for (const [name, value] of Object.entries(candidates)) writeSetting(merged, findSetting(name), clone(value));
  const values = {};
  for (const [name, value] of Object.entries(candidates)) {
    const problem = checkValue(findSetting(name), value, merged);
    if (problem) why[name] = problem;
    else values[name] = value;
  }
  return { values, why };
}

export function checkLocal(config, local) {
  const { values, why } = sortLocal(config, local);
  if (why === null) return { values: {}, warnings: ['local settings ignored: expected an object of name: value'] };
  return { values, warnings: Object.keys(local ?? {}).filter((name) => why[name]).map((name) => `local setting ${name} ignored: ${why[name]}`) };
}

// { name: why } for each local value that is ignored (the panel shows it by the setting).
export const ignoredLocal = (config, local) => sortLocal(config, local).why ?? {};

export function configWithLocal(config, local) {
  const out = clone(config) ?? {};
  for (const [name, value] of Object.entries(checkLocal(config, local).values)) writeSetting(out, findSetting(name), clone(value));
  return out;
}

export function effective(config, local) {
  const { values } = checkLocal(config, local);
  const out = {};
  for (const e of settingsFor(config)) {
    if (Object.hasOwn(values, e.name)) {
      out[e.name] = { value: clone(values[e.name]), source: 'local' };
      continue;
    }
    const team = readSetting(config, e);
    out[e.name] = team !== undefined && !deepEqual(team, e.default) ? { value: clone(team), source: 'team' } : { value: clone(e.default), source: 'default' };
  }
  return out;
}
