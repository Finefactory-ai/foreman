// Changing a role's model on either layer, through the same module as `foreman settings` and
// the dashboard (change.mjs).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withDefaults } from '../config/defaults.mjs';
import { changeSetting, settingsView, settingValue } from './change.mjs';

const ACME = { version: 1, project: { name: 'Acme' }, checks: [{ run: 'npm test', when: 'always' }] };

let root;
const ctx = () => ({ root, env: {} });
const file = () => join(root, 'foreman.config.json');
const raw = () => JSON.parse(readFileSync(file(), 'utf8'));
const write = (r) => writeFileSync(file(), `${JSON.stringify(r, null, 2)}\n`);
const localFile = () => join(root, '.foreman', 'settings.json');
const local = () => JSON.parse(readFileSync(localFile(), 'utf8'));
const without = (config, ...paths) => {
  const out = structuredClone(config);
  for (const p of paths) p(out);
  return out;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'foreman-change-'));
  write(ACME);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('role models on the team layer', () => {
  it('copies the default role block into a file with no roles, and changes nothing else', () => {
    const before = raw();
    const r = changeSetting(ctx(), { name: 'roles.tester.model', value: 'haiku', layer: 'team' });
    expect(r.error).toBeUndefined();
    expect(r.lines).toContain('foreman.config.json changed; commit it so the team gets it');
    const after = raw();
    expect(after).toEqual({ ...before, roles: { tester: { agent: 'foreman:tester', model: 'haiku' } } });
    expect(without(withDefaults(after), (c) => delete c.roles.tester.model)).toEqual(withDefaults(before));
  });

  it('copies the whole reviewers array, and only the named reviewer gains the model', () => {
    const before = raw();
    expect(changeSetting(ctx(), { name: 'roles.reviewers.security.model', value: 'sonnet', layer: 'team' }).error).toBeUndefined();
    expect(raw().roles).toEqual({
      reviewers: [
        { name: 'compliance', agent: 'foreman:compliance-reviewer' },
        { name: 'security', agent: 'foreman:security-reviewer', model: 'sonnet' },
      ],
    });
    expect(without(withDefaults(raw()), (c) => delete c.roles.reviewers[1].model)).toEqual(withDefaults(before));
  });

  it('keeps every pack builder when a team model is saved on a Salesforce pack project', () => {
    write({
      ...ACME,
      pack: 'salesforce',
      salesforce: {
        productionBranch: 'main',
        orgs: { 'acme-dev1': { orgId: '00D000000000001AAA' }, 'acme-qa': { orgId: '00D000000000002AAA' } },
        build: ['acme-dev1'],
        stages: [{ name: 'qa', org: 'acme-qa', branch: 'qa' }],
      },
    });
    const before = raw();
    const pack = withDefaults(before).roles.builders;
    expect(Object.keys(pack)).toEqual(['admin', 'developer', 'agentforce']);
    expect(changeSetting(ctx(), { name: 'roles.builders.admin.model', value: 'opus', layer: 'team' }).error).toBeUndefined();
    expect(raw().roles).toEqual({ builders: { ...pack, admin: { ...pack.admin, model: 'opus' } } });
    expect(without(withDefaults(raw()), (c) => delete c.roles.builders.admin.model)).toEqual(withDefaults(before));
  });

  it('writes only that role model on a file that already lists its roles', () => {
    const listed = { ...ACME, roles: { builders: { api: { agent: 'acme:api', use: 'the API' } }, reviewers: [{ name: 'perf', agent: 'acme:perf', prompt: 'Look for slow queries.' }] } };
    write(listed);
    expect(changeSetting(ctx(), { name: 'roles.builders.api.model', value: 'opus', layer: 'team' }).error).toBeUndefined();
    expect(changeSetting(ctx(), { name: 'roles.reviewers.perf.model', value: 'haiku', layer: 'team' }).error).toBeUndefined();
    expect(raw()).toEqual({
      ...listed,
      roles: {
        builders: { api: { agent: 'acme:api', use: 'the API', model: 'opus' } },
        reviewers: [{ name: 'perf', agent: 'acme:perf', prompt: 'Look for slow queries.', model: 'haiku' }],
      },
    });
  });

  it('resets only the model, keeping the role, and says so the second time', () => {
    changeSetting(ctx(), { name: 'roles.tester.model', value: 'haiku', layer: 'team' });
    const r = changeSetting(ctx(), { name: 'roles.tester.model', layer: 'team', reset: true });
    expect(r.lines).toEqual(['roles.tester.model: team value removed; now (not set) (default)', 'foreman.config.json changed; commit it so the team gets it']);
    expect(raw().roles).toEqual({ tester: { agent: 'foreman:tester' } });
    expect(changeSetting(ctx(), { name: 'roles.tester.model', layer: 'team', reset: true }).lines).toEqual(['roles.tester.model has no team value']);
  });

  it('shows the team value in the view and in settingValue', () => {
    changeSetting(ctx(), { name: 'roles.architect.model', value: 'opus', layer: 'team' });
    expect(settingValue(ctx(), 'roles.architect.model')).toEqual({ value: 'opus' });
    const row = settingsView(ctx()).rows.find((x) => x.name === 'roles.architect.model');
    expect(row).toMatchObject({ label: 'Architect', group: 'models', value: 'opus', source: 'team', unset: 'Same as the story session', limits: { values: ['haiku', 'sonnet', 'opus', 'fable'] } });
  });
});

describe('where a setting sits in the file', () => {
  it("gives a reviewer row inFile, and no other row", () => {
    const rows = settingsView(ctx()).rows;
    expect(rows.find((x) => x.name === 'roles.reviewers.security.model')).toMatchObject({ inFile: 'the reviewer named security in roles.reviewers' });
    for (const name of ['roles.architect.model', 'workers']) {
      const row = rows.find((x) => x.name === name);
      expect(row, name).toBeDefined();
      expect(Object.hasOwn(row, 'inFile'), name).toBe(false);
    }
  });
});

describe('role models on the local layer', () => {
  it('writes and removes the flat key in settings.json, and leaves foreman.config.json alone', () => {
    const before = readFileSync(file(), 'utf8');
    expect(changeSetting(ctx(), { name: 'roles.reviewers.security.model', value: 'sonnet', layer: 'local' }).error).toBeUndefined();
    expect(local()).toEqual({ 'roles.reviewers.security.model': 'sonnet' });
    expect(settingValue(ctx(), 'roles.reviewers.security.model')).toEqual({ value: 'sonnet' });
    const r = changeSetting(ctx(), { name: 'roles.reviewers.security.model', layer: 'local', reset: true });
    expect(r.lines).toEqual(['roles.reviewers.security.model: local value removed; now (not set) (default)']);
    expect(local()).toEqual({});
    expect(readFileSync(file(), 'utf8')).toBe(before);
  });
});

describe('role model refusals', () => {
  it('refuses a role the project lacks, on either layer, and writes nothing', () => {
    const before = readFileSync(file(), 'utf8');
    for (const layer of ['local', 'team']) {
      expect(changeSetting(ctx(), { name: 'roles.builders.ghost.model', value: 'opus', layer })).toEqual({ error: 'roles.builders.ghost.model applies only when the project has a builder named ghost' });
    }
    expect(readFileSync(file(), 'utf8')).toBe(before);
    expect(existsSync(localFile())).toBe(false);
  });

  it('refuses a model that is not one of the agent models, on either layer', () => {
    for (const layer of ['local', 'team']) {
      expect(changeSetting(ctx(), { name: 'roles.tester.model', value: 'gpt', layer })).toEqual({ error: 'roles.tester.model: must be one of haiku, sonnet, opus, fable' });
    }
    expect(raw()).toEqual(ACME);
  });

  it('gives an error, not a throw, for the value of a role the project lacks', () => {
    expect(settingValue(ctx(), 'roles.reviewers.ux.model')).toEqual({ error: 'roles.reviewers.ux.model applies only when the project has a reviewer named ux' });
    expect(settingValue(ctx(), 'roles.nope.model')).toEqual({ error: 'unknown setting: roles.nope.model' });
  });

  it('removes a stale local value for a role the project lacks, without throwing', () => {
    changeSetting(ctx(), { name: 'roles.tester.model', value: 'haiku', layer: 'local' });
    writeFileSync(localFile(), JSON.stringify({ 'roles.reviewers.ux.model': 'opus' }));
    const r = changeSetting(ctx(), { name: 'roles.reviewers.ux.model', layer: 'local', reset: true });
    expect(r.error).toBeUndefined();
    expect(r.lines[0]).toMatch(/^roles\.reviewers\.ux\.model: local value removed/);
    expect(local()).toEqual({});
  });
});
