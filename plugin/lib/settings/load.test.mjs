import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withDefaults } from '../config/defaults.mjs';
import { loadResolved, loadResolvedOrLastGood } from './load.mjs';

let root;
const writeConfig = (raw) => writeFileSync(join(root, 'foreman.config.json'), JSON.stringify(raw));
const writeLocal = (dir, values) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'settings.json'), typeof values === 'string' ? values : JSON.stringify(values));
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'foreman-load-'));
  writeConfig({ version: 1, project: { name: 'x' }, slots: 3, rounds: 4 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('loadResolved', () => {
  it('is the config with the local layer on top, plus the team config and the state folder', () => {
    writeLocal(join(root, '.foreman'), { workers: 2, 'features.followUps': false });
    const r = loadResolved(root, { env: {} });
    expect(r.errors).toEqual([]);
    expect(r.dir).toBe(join(root, '.foreman'));
    expect(r.config.workers).toBe(2);
    expect(r.config.rounds).toBe(4);
    expect(r.config.features.followUps).toBe(false);
    expect(r.team.workers).toBe(1);
    expect(r.team.features.followUps).toBe(true);
    expect(r.localWarnings).toEqual([]);
  });

  it('reads the local layer from the state folder FOREMAN_STATE_DIR names', () => {
    const elsewhere = join(root, 'elsewhere');
    writeLocal(elsewhere, { rounds: 7 });
    expect(loadResolved(root, { env: { FOREMAN_STATE_DIR: elsewhere } }).config.rounds).toBe(7);
  });

  it('ignores a bad local value, and says why', () => {
    writeLocal(join(root, '.foreman'), { workers: 9 });
    const r = loadResolved(root, { env: {} });
    expect(r.config.workers).toBe(1);
    expect(r.localWarnings).toEqual(['local setting workers ignored: must be a whole number from 1 to 3']);
  });

  it('ignores a broken settings file, and says so', () => {
    writeLocal(join(root, '.foreman'), '{ nope');
    const r = loadResolved(root, { env: {} });
    expect(r.config.rounds).toBe(4);
    expect(r.localWarnings[0]).toMatch(/settings\.json is not valid JSON/);
  });

  it("never lets a local ship.pr.into target the salesforce pack's productionBranch", () => {
    writeConfig({
      version: 1,
      project: { name: 'Acme' },
      pack: 'salesforce',
      salesforce: {
        productionBranch: 'main',
        orgs: { 'acme-dev1': { orgId: '00D000000000001AAA' }, 'acme-qa': { orgId: '00D000000000002AAA' } },
        build: ['acme-dev1'],
        stages: [{ name: 'qa', org: 'acme-qa', branch: 'qa' }],
      },
    });
    writeLocal(join(root, '.foreman'), { 'ship.pr.into': 'main' });
    const r = loadResolved(root, { env: {} });
    expect(r.errors).toEqual([]);
    expect(r.config.ship.pr.into).toBe('qa');
    expect(r.localWarnings).toContain('local setting ship.pr.into ignored: must not be salesforce.productionBranch: nothing merges into production');
  });

  it('gives the errors and no config when foreman.config.json is invalid', () => {
    writeConfig({ version: 1 });
    const r = loadResolved(root, { env: {} });
    expect(r.config).toBeNull();
    expect(r.errors).toContainEqual({ path: 'project.name', message: 'required' });
  });
});

describe('loadResolvedOrLastGood', () => {
  const problem = { since: '2026-10-24T22:49:00.000Z', reason: 'bogusKey: unknown key' };
  const team = withDefaults({ version: 1, project: { name: 'Acme' }, slots: 3, rounds: 6 });
  const runOn = (dir, { configProblem = problem, lastGood = team } = {}) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ configProblem }));
    if (lastGood) writeFileSync(join(dir, 'config.last-good.json'), JSON.stringify(lastGood));
  };
  const invalid = (extra = {}) => writeConfig({ version: 1, project: { name: 'Acme' }, slots: 3, rounds: 4, bogusKey: true, ...extra });

  it('is loadResolved for a valid file', () => {
    writeLocal(join(root, '.foreman'), { workers: 2 });
    runOn(join(root, '.foreman'));
    expect(loadResolvedOrLastGood(root, { env: {} })).toEqual(loadResolved(root, { env: {} }));
  });

  it('gives the last good config, local layer on top, while the run is on it', () => {
    invalid();
    const dir = join(root, '.foreman');
    runOn(dir);
    writeLocal(dir, { workers: 2 });
    const r = loadResolvedOrLastGood(root, { env: {} });
    expect(r.lastGood).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.invalid).toContainEqual({ path: 'bogusKey', message: 'unknown key' });
    expect(r.dir).toBe(dir);
    expect(r.team).toEqual(team);
    expect(r.config.rounds).toBe(6);
    expect(r.config.workers).toBe(2);
  });

  it('refuses as loadResolved does when the run is not on the last good config', () => {
    invalid();
    runOn(join(root, '.foreman'), { configProblem: null });
    const r = loadResolvedOrLastGood(root, { env: {} });
    expect(r.config).toBeNull();
    expect(r.errors).toContainEqual({ path: 'bogusKey', message: 'unknown key' });
  });

  it('refuses when there is no last good config', () => {
    invalid();
    runOn(join(root, '.foreman'), { lastGood: null });
    expect(loadResolvedOrLastGood(root, { env: {} }).config).toBeNull();
  });

  it("finds the state folder the invalid file names, and FOREMAN_STATE_DIR wins over it", () => {
    invalid({ stateDir: 'state-here' });
    runOn(join(root, 'state-here'));
    expect(loadResolvedOrLastGood(root, { env: {} })).toMatchObject({ lastGood: true, dir: join(root, 'state-here') });
    const elsewhere = join(root, 'elsewhere');
    expect(loadResolvedOrLastGood(root, { env: { FOREMAN_STATE_DIR: elsewhere } }).config).toBeNull();
    runOn(elsewhere);
    expect(loadResolvedOrLastGood(root, { env: { FOREMAN_STATE_DIR: elsewhere } })).toMatchObject({ lastGood: true, dir: elsewhere });
  });
});
