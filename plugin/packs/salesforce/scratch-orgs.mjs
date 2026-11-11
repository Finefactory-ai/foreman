// The scratch org registry: one record per story that has, or is getting, a scratch org, in
// <stateDir>/salesforce/scratch/<story>.json. The scratch slot environment (env/scratch.mjs)
// writes them; the isolated sf home (isolation.mjs) and the doctor read them, so a story's own
// scratch org is allow-listed for that story only. No sf call here.
//
// A record is { story, slot: 'wN', alias, devHub, state: 'creating' | 'ready', jobId, username,
// orgId, createdAt, readyAt? }. A 'creating' record is written before `sf org create scratch`,
// so a run killed while sf signs the org in still leaves the org's username on record.
//
// It imports only node and overlay.mjs, never state.mjs: state.mjs loads the config defaults,
// which load the pack registry, which loads this file.

import fs from 'node:fs';
import { join } from 'node:path';
import { safeId, writeAtomic } from '../../lib/adapters/stories/overlay.mjs';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.length > 0;

const folder = (stateDir) => join(stateDir, 'salesforce', 'scratch');

export const scratchFile = (stateDir, story) => join(folder(stateDir), `${safeId(story)}.json`);

// The alias a story's scratch org gets. safeId keeps it to letters, digits, '.', '_' and '-',
// so it always passes config.mjs ALIAS.
export const scratchAlias = (story) => `foreman-${safeId(story).toLowerCase()}`;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Every record that parses and names a story and an alias. Never throws.
export function readScratchOrgs(stateDir) {
  if (!isText(stateDir)) return [];
  let names;
  try {
    names = fs.readdirSync(folder(stateDir));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    const r = readJson(join(folder(stateDir), name));
    if (isObject(r) && isText(r.story) && isText(r.alias)) out.push(r);
  }
  return out;
}

export function writeScratchOrg(stateDir, record) {
  writeAtomic(scratchFile(stateDir, record.story), `${JSON.stringify(record, null, 2)}\n`);
}

export function removeScratchOrg(stateDir, story) {
  fs.rmSync(scratchFile(stateDir, story), { force: true });
}

// The stories every slot holds: its story's id, and the story a held slot keeps. Read from
// <stateDir>/slots/w*.json directly, as env/sandbox-pool.mjs does, to keep off state.mjs.
export function storiesInSlots(stateDir) {
  const ids = new Set();
  if (!isText(stateDir)) return ids;
  let names;
  try {
    names = fs.readdirSync(join(stateDir, 'slots'));
  } catch {
    return ids;
  }
  for (const name of names) {
    if (!/^w\d+\.json$/.test(name)) continue;
    const slot = readJson(join(stateDir, 'slots', name));
    if (!isObject(slot)) continue;
    if (isObject(slot.story) && isText(slot.story.id)) ids.add(slot.story.id);
    if (isText(slot.heldStory)) ids.add(slot.heldStory);
  }
  return ids;
}

// The stories that hold a claim: one id per <stateDir>/claims/*.json, whoever holds it (the
// factory or the owner), live or stale, and whether or not the file parses. A claimed story is
// one a run resumes (interrupted, held, parked, queued) or the owner holds; every closing ending
// lets go of its claim. Read from the folder directly, as storiesInSlots reads the slots, to keep
// off locks.mjs and state.mjs. Never throws.
export function claimedStories(stateDir) {
  const ids = new Set();
  if (!isText(stateDir)) return ids;
  let names;
  try {
    names = fs.readdirSync(join(stateDir, 'claims'));
  } catch {
    return ids;
  }
  for (const name of names) {
    if (name.endsWith('.json') && name.length > '.json'.length) ids.add(name.slice(0, -'.json'.length));
  }
  return ids;
}
