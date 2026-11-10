// Project traits: short markdown texts added to a role's prompt. Three sources, all apply, in
// this order: the project's pack (all.md, then <role>.md, in the pack's traitsDir), files under
// .claude/foreman/traits/ (all.md for every role, <role>.md for one), then the `traits` list on
// the role in foreman.config.json. The project's own come last, so they win. A missing pack
// file is skipped; an unknown pack brings none, because config validation reports it. A list
// entry that names an existing file is read; one ending in .md or .txt that does not exist is
// an error; anything else is inline. Pack files are read with the same injected `readFile` and
// `exists` as the project's, even though the pack's traitsDir is inside the plugin, so a caller
// that passes a fake fs without those files gets no pack traits and no error.
//
// Foreman's own learned traits come after all of those, when a `stateDir` is given and
// `learning.apply` is not false: <stateDir>/learned/traits/all.md, then <role>.md, as the
// learning store writes them (`[L-n] text` entries, blank lines between). They sit under the
// LEARNED_HEADING, so the owner's text above them wins. They are capped at 3 KB per role: the
// highest L numbers are left out first, with a warning. An untagged entry is never left out, so
// text still over the cap after that gets a warning of its own. `learned` names, per role, the ids
// kept, so the run can record what each story was exposed to.

import fs from 'node:fs';
import path from 'node:path';
import { PACKS, packFor } from '../../packs/index.mjs';

export const TRAITS_DIR = '.claude/foreman/traits';
export const MAX_BYTES = 8 * 1024;
export const LEARNED_HEADING = 'Learned by Foreman (CLAUDE.md and the traits above win)';
export const LEARNED_MAX_BYTES = 3 * 1024;

export function roleNames(config) {
  const roles = config.roles ?? {};
  return ['architect', 'tester', ...Object.keys(roles.builders ?? {}), ...(roles.reviewers ?? []).map((r) => r.name)];
}

// The config entry of each role, by name.
function entries(config) {
  const roles = config.roles ?? {};
  const out = { architect: roles.architect, tester: roles.tester };
  for (const [name, b] of Object.entries(roles.builders ?? {})) out[name] = b;
  for (const r of roles.reviewers ?? []) out[r.name] = r;
  return out;
}

// The pack's traits folder, or null when the config names no pack, an unknown one, or one
// without traits.
function packTraitsDir(config, packs) {
  let pack = null;
  try {
    pack = packFor(config, packs);
  } catch {
    return null;
  }
  return typeof pack?.traitsDir === 'string' ? pack.traitsDir : null;
}

// The entries of one learned file: split on blank lines that start a new `[L-n]` entry.
// An entry without a tag is kept, with no id.
function learnedEntries(text) {
  if (!text) return [];
  return text
    .split(/\n\s*\n(?=\[L-\d+\])/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => ({ text: t, id: t.match(/^\[(L-\d+)\]/)?.[1] ?? null }));
}

const idNumber = (id) => Number(id.slice(2));

// Drops the tagged entry with the highest L number until the entries fit the cap, or no
// tagged entry is left. Returns the kept entries, in order, the ids dropped, and whether the
// kept entries are still over the cap.
function capLearned(list) {
  const kept = [...list];
  const dropped = [];
  const size = () => Buffer.byteLength(kept.map((e) => e.text).join('\n\n'));
  while (size() > LEARNED_MAX_BYTES) {
    const tagged = kept.filter((e) => e.id);
    if (!tagged.length) break;
    const top = tagged.reduce((a, b) => (idNumber(b.id) > idNumber(a.id) ? b : a));
    kept.splice(kept.indexOf(top), 1);
    dropped.push(top.id);
  }
  return { kept, dropped, over: size() > LEARNED_MAX_BYTES };
}

export function resolveTraits({ root, config, readFile = fs.readFileSync, exists = fs.existsSync, packs = PACKS, stateDir }) {
  const errors = [];
  const warnings = [];
  const traits = {};
  const learned = {};
  const textAt = (file) => (exists(file) ? String(readFile(file, 'utf8')).trim() : '');
  const fileText = (rel) => textAt(path.join(root, rel));
  const packDir = packTraitsDir(config, packs);
  const packText = (name) => (packDir ? textAt(path.join(packDir, name)) : '');
  const packAll = packText('all.md');
  const all = fileText(`${TRAITS_DIR}/all.md`);
  const byRole = entries(config);
  const learnedDir = stateDir && config.learning?.apply !== false ? path.join(stateDir, 'learned', 'traits') : null;
  const learnedText = (name) => (learnedDir ? textAt(path.join(learnedDir, name)) : '');
  const learnedAll = learnedEntries(learnedText('all.md'));
  for (const role of roleNames(config)) {
    const parts = [packAll, packText(`${role}.md`), all, fileText(`${TRAITS_DIR}/${role}.md`)];
    for (const entry of byRole[role]?.traits ?? []) {
      const file = path.resolve(root, entry);
      if (exists(file)) parts.push(String(readFile(file, 'utf8')).trim());
      else if (/\.(md|txt)$/.test(entry)) errors.push(`traits for ${role}: ${entry} does not exist`);
      else parts.push(entry.trim());
    }
    const owner = parts.filter(Boolean).join('\n\n');
    const { kept, dropped, over } = capLearned([...learnedAll, ...learnedEntries(learnedText(`${role}.md`))]);
    if (dropped.length) warnings.push(`learned traits for ${role} are over 3 KB; left out ${dropped.join(', ')}`);
    if (over) warnings.push(`learned traits for ${role} are still over 3 KB; untagged entries are never left out`);
    const block = kept.length ? `### ${LEARNED_HEADING}\n\n${kept.map((e) => e.text).join('\n\n')}` : '';
    const text = [owner, block].filter(Boolean).join('\n\n');
    if (!text) continue;
    traits[role] = text;
    const ids = [...new Set(kept.map((e) => e.id).filter(Boolean))].sort((a, b) => idNumber(a) - idNumber(b));
    if (ids.length) learned[role] = ids;
    const bytes = Buffer.byteLength(text);
    if (bytes > MAX_BYTES) warnings.push(`traits for ${role} are ${Math.ceil(bytes / 1024)} KB; keep them under 8 KB`);
  }
  return { traits, errors, warnings, learned };
}
