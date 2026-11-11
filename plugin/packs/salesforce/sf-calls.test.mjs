import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Every sf call in the plugin goes through runSf in sf.mjs, which runs it under sf-watch.mjs with
// a time limit. This lists each file's runSf calls, so a new call site fails here until it is
// listed, and finds no sf or sfdx spawned anywhere else.

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WRAPPER = new Set(['packs/salesforce/sf.mjs', 'packs/salesforce/sf-watch.mjs']);

const EXPECTED = {
  'packs/salesforce/agent-eval.mjs': 1,
  'packs/salesforce/agentforce.mjs': 6,
  'packs/salesforce/baseline.mjs': 3,
  'packs/salesforce/cases.mjs': 5,
  'packs/salesforce/deploy-result.mjs': 1,
  'packs/salesforce/doctor-salesforce.mjs': 8,
  'packs/salesforce/isolation.mjs': 3,
  'packs/salesforce/rollback.mjs': 1,
  'packs/salesforce/setup.mjs': 2,
  'packs/salesforce/env/sandbox-pool.mjs': 9,
  'packs/salesforce/env/scratch.mjs': 6,
  'packs/salesforce/steps/ci-deploy-watch.mjs': 1,
  'packs/salesforce/steps/gearset-promote.mjs': 1,
  'packs/salesforce/steps/sf-delta.mjs': 2,
  'packs/salesforce/steps/sf-deploy.mjs': 1,
  'packs/salesforce/steps/sf-validate.mjs': 1,
  'packs/salesforce/steps/sf-verify.mjs': 1,
};

function sources(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') sources(file, out);
    } else if (entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs')) {
      out.push(path.relative(PLUGIN, file).split(path.sep).join('/'));
    }
  }
  return out.sort();
}

const files = sources(PLUGIN);
const text = (rel) => fs.readFileSync(path.join(PLUGIN, rel), 'utf8');

describe('sf call sites', () => {
  it('finds the plugin files', () => {
    expect(files).toContain('packs/salesforce/sf.mjs');
    expect(files).toContain('packs/salesforce/sf-watch.mjs');
  });

  it('spawns sf or sfdx only in sf.mjs and sf-watch.mjs', () => {
    const SPAWN = /\(\s*['"]sfdx?['"]\s*,/;
    const found = files.filter((rel) => !WRAPPER.has(rel) && SPAWN.test(text(rel)));
    expect(found).toEqual([]);
  });

  it('lists every runSf call site, file by file', () => {
    const counts = {};
    for (const rel of files) {
      if (WRAPPER.has(rel)) continue;
      const n = (text(rel).match(/(?<!function )\brunSf\(/g) ?? []).length;
      if (n) counts[rel] = n;
    }
    expect(counts).toEqual(EXPECTED);
  });
});
