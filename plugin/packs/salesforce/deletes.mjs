// The owner's approval of a story's metadata deletes: one JSON file per story at
// <stateDir>/salesforce/deletes/<story id>.json,
//
//   { story, sha256, deletes: [{ type, member }], askedAt, answer, answeredAt }
//
// sha256 is that of the destructiveChanges.xml sfdx-git-delta wrote when the question was
// asked (steps/sf-delta.mjs). answer is null until the owner answers 'allow' or 'keep-out'
// through `foreman sf deletes`; an answer keeps sha256, so an allow holds for that exact file
// only. A fresh ask replaces the record, answer and all.
//
// It imports only node built-ins and the two helpers below, which import nothing else of
// Foreman's, so the pack's steps and its command can both load it.

import fs from 'node:fs';
import { join } from 'node:path';
import { safeId, writeAtomic } from '../../lib/adapters/stories/overlay.mjs';

export const ANSWERS = Object.freeze(['allow', 'keep-out']);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const write = (file, record) => writeAtomic(file, `${JSON.stringify(record, null, 2)}\n`);

export const deletesFile = (dir, id) => join(dir, 'salesforce', 'deletes', `${safeId(id)}.json`);

// The record, or null for a missing or broken file.
export function readDeletes(dir, id) {
  try {
    const record = JSON.parse(fs.readFileSync(deletesFile(dir, id), 'utf8'));
    return isObject(record) ? record : null;
  } catch {
    return null;
  }
}

// Writes a fresh, unanswered record and returns it.
export function askDeletes(dir, { story, sha256, deletes }, now = new Date()) {
  const record = { story, sha256, deletes, askedAt: now.toISOString(), answer: null, answeredAt: null };
  write(deletesFile(dir, story), record);
  return record;
}

// Records the owner's answer and returns the record. Throws when no record waits for `id` or
// the answer is not one of ANSWERS.
export function answerDeletes(dir, id, answer, now = new Date()) {
  if (!ANSWERS.includes(answer)) throw new Error(`the answer must be ${ANSWERS.join(' or ')}, not ${answer}`);
  const record = readDeletes(dir, id);
  if (!record) throw new Error(`no deletes wait for ${id}`);
  const answered = { ...record, answer, answeredAt: now.toISOString() };
  write(deletesFile(dir, id), answered);
  return answered;
}
