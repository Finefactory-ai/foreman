// The local settings layer: <stateDir>/settings.json, this machine only (the state folder is
// gitignored). It is a flat object of setting name to value, such as
// { "features.followUps": false, "workers": 2 }. This module only reads and writes the file;
// lib/settings/resolve.mjs decides which values count.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SETTINGS_FILE = 'settings.json';

export const localFile = (stateDir) => join(stateDir, SETTINGS_FILE);

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// { values, warnings }. A missing file is empty; a broken one is empty with a warning.
export function readLocal(stateDir) {
  const file = localFile(stateDir);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { values: {}, warnings: [] };
    return { values: {}, warnings: [`cannot read ${file}: ${err.message}; local settings ignored`] };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { values: {}, warnings: [`${file} is not valid JSON (${err.message}); local settings ignored`] };
  }
  if (!isPlain(raw)) return { values: {}, warnings: [`${file}: expected an object of name: value; local settings ignored`] };
  return { values: raw, warnings: [] };
}

// Throws when the file is there but unreadable, rather than write over what it holds.
function readForWrite(stateDir) {
  const { values, warnings } = readLocal(stateDir);
  if (warnings.length) throw new Error(`${warnings[0].replace(/; local settings ignored$/, '')}; fix or delete it first`);
  return values;
}

function writeLocal(stateDir, values) {
  mkdirSync(stateDir, { recursive: true });
  const file = localFile(stateDir);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(values, null, 2)}\n`);
  renameSync(tmp, file);
}

export function setLocal(stateDir, name, value) {
  const values = readForWrite(stateDir);
  values[name] = value;
  writeLocal(stateDir, values);
}

// Removes one value; true when there was one.
export function resetLocal(stateDir, name) {
  if (!existsSync(localFile(stateDir))) return false;
  const values = readForWrite(stateDir);
  if (!Object.hasOwn(values, name)) return false;
  delete values[name];
  writeLocal(stateDir, values);
  return true;
}
