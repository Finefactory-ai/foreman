import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changeSetting } from './change.mjs';
import { loadConfig } from '../config/load.mjs';

// A team change is checked against the config loadConfig would give for the same folder, so the
// test records the config checkValue receives. vi.mock is hoisted, hence its own file.
const seen = vi.hoisted(() => ({ configs: [] }));

vi.mock('./registry.mjs', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    checkValue: (e, v, c) => {
      seen.configs.push(c);
      return real.checkValue(e, v, c);
    },
  };
});

const ACME = {
  version: 1,
  project: { name: 'Acme' },
  checks: [{ run: 'npm test', when: 'always' }],
  pack: 'salesforce',
  salesforce: {
    productionBranch: 'main',
    orgs: { 'acme-dev1': { orgId: '00D000000000001AAA' }, 'acme-qa': { orgId: '00D000000000002AAA' } },
    build: ['acme-dev1'],
    stages: [{ name: 'qa', org: 'acme-qa', branch: 'qa' }],
  },
};
const WORKFLOW = 'name: ci\non: pull_request\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n';

let root;
const configFile = () => join(root, 'foreman.config.json');
const change = (value) => changeSetting({ root, env: {} }, { name: 'rounds', value, layer: 'team' });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'foreman-change-team-'));
  writeFileSync(configFile(), JSON.stringify(ACME, null, 2));
  seen.configs.length = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('a team change is checked against the config loadConfig gives', () => {
  it('leaves out ci when no workflow runs on pull requests', () => {
    const r = change(4);
    expect(r.error).toBeUndefined();
    const steps = seen.configs.at(-1).ship.steps;
    expect(steps).toEqual(loadConfig(root).config.ship.steps);
    expect(steps).not.toContain('ci');
  });

  it('keeps ci when a workflow runs on pull requests', () => {
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), WORKFLOW);
    const r = change(4);
    expect(r.error).toBeUndefined();
    const steps = seen.configs.at(-1).ship.steps;
    expect(steps).toEqual(loadConfig(root).config.ship.steps);
    expect(steps).toContain('ci');
  });

  it('still refuses a value that is out of range and leaves the file alone', () => {
    const before = JSON.parse(readFileSync(configFile(), 'utf8'));
    const r = change(99);
    expect(r.error).toMatch(/^rounds: /);
    expect(JSON.parse(readFileSync(configFile(), 'utf8'))).toEqual(before);
  });
});
