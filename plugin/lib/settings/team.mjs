// The team settings layer: foreman.config.json itself, edited in place.
// Each edit reads the file, sets or removes one dotted path, validates the whole config, and
// writes it back atomically as 2-space JSON, keeping the other keys in their order. teamApply
// does several such edits, in order, with one check and one write. teamEdit applies an edit
// function to the whole file instead, for a setting a dotted path cannot reach (a role's
// model, registry.mjs `team`). A write
// also moves the deprecated top-level keepAwake to features.keepAwake. An edit that
// would make the config invalid writes nothing and returns the errors.
//
// A block the config replaces as a whole (ship, stories, notify, console...) starts from its
// defaults when the file has none, so setting ship.ci.timeoutMinutes does not drop the default
// ship steps.

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULTS, WHOLE } from '../config/defaults.mjs';
import { CONFIG_FILE } from '../config/load.mjs';
import { validate } from '../config/validate.mjs';
import { getPath } from './resolve.mjs';

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined ? v : structuredClone(v));

export const configFile = (root) => join(root, CONFIG_FILE);

// { raw } or { errors }.
export function readTeam(root) {
  const file = configFile(root);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    return { errors: [err?.code === 'ENOENT' ? `no ${CONFIG_FILE} in ${root}` : `cannot read ${file}: ${err.message}`] };
  }
  try {
    const raw = JSON.parse(text);
    if (!isPlain(raw)) return { errors: [`${file} must hold a JSON object`] };
    return { raw };
  } catch (err) {
    return { errors: [`${file} is not valid JSON: ${err.message}`] };
  }
}

function write(root, raw) {
  const file = configFile(root);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`);
  renameSync(tmp, file);
}

const errorsOf = (raw) => validate(raw).map((e) => (e.path ? `${e.path}: ${e.message}` : e.message));

// The deprecated top-level keepAwake moved to features.keepAwake (a features.keepAwake the file
// already has wins), as a new object; the file is being written anyway.
export function migrated(raw) {
  if (!Object.hasOwn(raw, 'keepAwake')) return raw;
  const out = clone(raw);
  const old = out.keepAwake;
  delete out.keepAwake;
  if (!isPlain(out.features)) out.features = {};
  if (!Object.hasOwn(out.features, 'keepAwake')) out.features.keepAwake = old;
  return out;
}

// `raw` with `name` set to `value`, as a new object.
export function withTeamValue(raw, name, value) {
  const out = clone(raw);
  const keys = name.split('.');
  let at = out;
  keys.slice(0, -1).forEach((key, i) => {
    if (!isPlain(at[key])) {
      const prefix = keys.slice(0, i + 1).join('.');
      at[key] = WHOLE.has(prefix) && isPlain(getPath(DEFAULTS, prefix)) ? clone(getPath(DEFAULTS, prefix)) : {};
    }
    at = at[key];
  });
  at[keys.at(-1)] = clone(value);
  return out;
}

// `raw` without `name`, and without any object that leaves empty, as a new object.
function withoutTeamValue(raw, name) {
  const out = clone(raw);
  const keys = name.split('.');
  const chain = [out];
  for (const key of keys.slice(0, -1)) chain.push(chain.at(-1)[key]);
  delete chain.at(-1)[keys.at(-1)];
  for (let i = chain.length - 1; i > 0; i -= 1) {
    if (Object.keys(chain[i]).length) break;
    delete chain[i - 1][keys[i - 1]];
  }
  return out;
}

// { errors }: empty when the file was written.
export function teamSet(root, name, value) {
  const { raw, errors } = readTeam(root);
  if (errors) return { errors };
  const next = withTeamValue(migrated(raw), name, value);
  const invalid = errorsOf(next);
  if (invalid.length) return { errors: invalid };
  write(root, next);
  return { errors: [] };
}

// { removed, errors }: removed is false, and nothing is written, when the file does not set it.
export function teamReset(root, name) {
  const { raw: file, errors } = readTeam(root);
  if (errors) return { removed: false, errors };
  const raw = migrated(file);
  if (getPath(raw, name) === undefined) return { removed: false, errors: [] };
  const next = withoutTeamValue(raw, name);
  const invalid = errorsOf(next);
  if (invalid.length) return { removed: false, errors: invalid };
  write(root, next);
  return { removed: true, errors: [] };
}

// edit(raw) -> the new raw file, or null for nothing to change. { changed, errors }: changed is
// false, and nothing is written, when edit returns null or the result is invalid.
export function teamEdit(root, edit) {
  const { raw, errors } = readTeam(root);
  if (errors) return { changed: false, errors };
  const next = edit(migrated(raw));
  if (next === null) return { changed: false, errors: [] };
  const invalid = errorsOf(next);
  if (invalid.length) return { changed: false, errors: invalid };
  write(root, next);
  return { changed: true, errors: [] };
}

// edits: [{ name, value } | { name, remove: true }], applied in order (removing a path the file
// does not set does nothing), then checked once and written once. { errors }: empty when the file was written, or when there was nothing to do.
export function teamApply(root, edits) {
  if (!edits.length) return { errors: [] };
  const { raw, errors } = readTeam(root);
  if (errors) return { errors };
  let next = migrated(raw);
  for (const edit of edits) {
    if (edit.remove !== true) next = withTeamValue(next, edit.name, edit.value);
    else if (getPath(next, edit.name) !== undefined) next = withoutTeamValue(next, edit.name);
  }
  const invalid = errorsOf(next);
  if (invalid.length) return { errors: invalid };
  write(root, next);
  return { errors: [] };
}
