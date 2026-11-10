// The state overlay a story source keeps beside stories it must not edit: one JSON file per
// story at <stateDir>/stories/<id>.json, { id, status?, blockedBy?, fields, notes: [{ date,
// text }] }, newest note first. The markdown source uses it in state mode; the Jira source
// always does, since the issue in Jira is not Foreman's to rewrite.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readText, renameWritten } from '../../engine/read-cache.mjs';

/** A story id as a safe file name. */
export const safeId = (id) => String(id).replace(/[^A-Za-z0-9._-]/g, '_');

/** A date as YYYY-MM-DD in local time. */
export const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** One dated progress line: `- **2026-10-17** — text`. */
export const bulletOf = ({ date, text }) => `- **${date}** — ${text}`;

// Written to a temp file and renamed, so a reader never sees half a file.
export function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text);
  renameWritten(tmp, file, text);
}

/** The overlay files under one state folder. */
export function overlayStore(stateDir) {
  const file = (id) => join(stateDir, 'stories', `${safeId(id)}.json`);
  const read = (id) => {
    try {
      const text = readText(file(id));
      return text === null ? null : JSON.parse(text);
    } catch {
      return null;
    }
  };
  /** The overlay for `id`, or a fresh empty one, with `fields` and `notes` always present. */
  const load = (id) => {
    const ov = read(id) ?? { id, fields: {}, notes: [] };
    ov.fields ??= {};
    ov.notes ??= [];
    return ov;
  };
  const write = (id, ov) => writeAtomic(file(id), `${JSON.stringify(ov, null, 2)}\n`);
  return { file, read, load, write };
}
