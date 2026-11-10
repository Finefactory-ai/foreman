import { readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const PLUGIN = path.join(REPO, 'plugin');
const json = (p) => JSON.parse(readFileSync(path.join(REPO, p), 'utf8'));

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

// contract.mjs files are shared adapter test suites (they import vitest); they never run in an install.
const isTest = (f) => /\.test\.(mjs|js)$/.test(f) || path.basename(f) === 'contract.mjs';
const IMPORT = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\1/g;

describe('plugin layout', () => {
  it('non-test plugin code imports only from inside plugin/ or node built-ins', () => {
    const builtin = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
    const bad = [];
    const files = walk(PLUGIN).filter((f) => /\.(mjs|js)$/.test(f) && !isTest(f));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const [, , spec] of text.matchAll(IMPORT)) {
        if (spec.startsWith('.')) {
          const target = path.resolve(path.dirname(file), spec);
          if (target !== PLUGIN && !target.startsWith(PLUGIN + path.sep)) bad.push(`${path.relative(REPO, file)} -> ${spec}`);
        } else if (!builtin.has(spec)) {
          bad.push(`${path.relative(REPO, file)} -> ${spec}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('vendors no skills: no .agents folder, skills-lock.json or pack SKILL.md under plugin/', () => {
    const all = [];
    const walkAll = (dir) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        all.push(full);
        if (statSync(full).isDirectory()) walkAll(full);
      }
    };
    walkAll(PLUGIN);
    const rel = all.map((f) => path.relative(PLUGIN, f).split(path.sep));
    expect(rel.filter((parts) => parts.includes('.agents'))).toEqual([]);
    expect(rel.filter((parts) => parts.at(-1) === 'skills-lock.json')).toEqual([]);
    expect(rel.filter((parts) => parts[0] === 'packs' && parts.at(-1) === 'SKILL.md')).toEqual([]);
  });

  it('the marketplace points at ./plugin', () => {
    const market = json('.claude-plugin/marketplace.json');
    expect(market.plugins.map((p) => p.source)).toEqual(['./plugin']);
  });

  it('the plugin manifest version matches package.json', () => {
    const manifest = json('plugin/.claude-plugin/plugin.json');
    expect(manifest.version).toBe(json('package.json').version);
  });
});
