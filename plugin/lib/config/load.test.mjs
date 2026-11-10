import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_FILE, loadConfig } from './load.mjs';
import { loadResolved } from '../settings/load.mjs';
import { fakePack } from '../../../test/fake-pack.mjs';

const reader = (text) => () => text;
const missing = () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; };

describe('loadConfig', () => {
  it('names the file', () => expect(CONFIG_FILE).toBe('foreman.config.json'));
  it('returns the config with defaults for a valid file', () => {
    const r = loadConfig('/proj', { readFile: reader('{"version":1,"project":{"name":"x"}}') });
    expect(r.errors).toEqual([]);
    expect(r.config.slots).toBe(1);
    expect(r.config.project.name).toBe('x');
    expect(r.file).toBe('/proj/foreman.config.json');
  });
  it('reports a missing file', () => {
    const r = loadConfig('/proj', { readFile: missing });
    expect(r.config).toBeNull();
    expect(r.errors).toEqual([{ path: '', message: 'no foreman.config.json in /proj' }]);
  });
  it('reports broken JSON as one error naming the file', () => {
    const r = loadConfig('/proj', { readFile: reader('{ nope') });
    expect(r.config).toBeNull();
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].path).toBe('');
    expect(r.errors[0].message).toContain('foreman.config.json');
  });
  it('returns validation errors and no config for an invalid file', () => {
    const r = loadConfig('/proj', { readFile: reader('{"version":1,"project":{"name":"x"},"slot":2}') });
    expect(r.config).toBeNull();
    expect(r.errors).toEqual([{ path: 'slot', message: 'unknown key' }]);
  });
  it('reads from disk by default', () => {
    const r = loadConfig('/definitely/not/here');
    expect(r.errors[0].message).toContain('no foreman.config.json');
  });
});

describe('loadConfig and loadResolved with packs', () => {
  const file = { version: 1, project: { name: 'Acme' }, pack: 'acme' };
  let root;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-load-pack-'));
    fs.writeFileSync(path.join(root, CONFIG_FILE), JSON.stringify(file));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('loads a file that names an injected pack, with the pack defaults', () => {
    const r = loadConfig(root, { packs: { acme: fakePack() } });
    expect(r.errors).toEqual([]);
    expect(r.config.rounds).toBe(5);
    expect(r.config.ship.steps).toEqual(['merge-main', 'push', 'acme-deploy']);
    const resolved = loadResolved(root, { env: {}, packs: { acme: fakePack() } });
    expect(resolved.errors).toEqual([]);
    expect(resolved.config.rounds).toBe(5);
    expect(resolved.team.acme).toEqual({ region: 'eu', mode: 'basic' });
  });
  it('gives the pack defaults the project folder to read', () => {
    const seen = [];
    const pack = fakePack({ defaults: (block, project) => { seen.push(project); return {}; } });
    expect(loadConfig(root, { packs: { acme: pack } }).errors).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0].root).toBe(root);
    expect(typeof seen[0].fs.readdirSync).toBe('function');
    expect(seen[0].file).toEqual(file);
  });
  it('rejects the same file without injected packs', () => {
    const r = loadConfig(root);
    expect(r.config).toBeNull();
    expect(r.errors.map((e) => e.path)).toEqual(['pack']);
    const resolved = loadResolved(root, { env: {} });
    expect(resolved.config).toBeNull();
    expect(resolved.errors.map((e) => e.path)).toEqual(['pack']);
  });
  it('turns a pack defaults() that throws into a config error', () => {
    const packs = { acme: fakePack({ defaults: () => { throw new Error('dflt boom'); } }) };
    const errors = [{ path: 'acme', message: 'the acme pack could not give its defaults: dflt boom' }];
    let r;
    expect(() => { r = loadConfig(root, { packs }); }).not.toThrow();
    expect(r.config).toBeNull();
    expect(r.errors).toEqual(errors);
    let resolved;
    expect(() => { resolved = loadResolved(root, { env: {}, packs }); }).not.toThrow();
    expect(resolved.config).toBeNull();
    expect(resolved.team).toBeNull();
    expect(resolved.errors).toEqual(errors);
  });
});
