import { describe, expect, it } from 'vitest';
import { withDefaults } from '../config/defaults.mjs';
import { AGENT_MODELS, validate } from '../config/validate.mjs';
import { checkValue, findSetting, GROUPS, REGISTRY, settingsFor } from './registry.mjs';
import { roleModelEntries, roleModelEntry } from './role-models.mjs';

const acme = (extra = {}) => withDefaults({ version: 1, project: { name: 'Acme' }, ...extra });
const UNSET = 'Same as the story session';

describe('the role model settings', () => {
  it('finds an entry per role by name, as a model dropdown', () => {
    expect(findSetting('roles.reviewers.security.model')).toMatchObject({
      name: 'roles.reviewers.security.model',
      label: 'Reviewer: security',
      type: 'enum',
      values: AGENT_MODELS,
      default: null,
      applies: 'next-story',
      group: 'models',
      secret: false,
      unset: UNSET,
    });
    expect(findSetting('roles.architect.model')).toMatchObject({ label: 'Architect', group: 'models' });
    expect(findSetting('roles.tester.model')).toMatchObject({ label: 'Tester', group: 'models' });
    expect(findSetting('roles.builders.developer.model')).toMatchObject({ label: 'Builder: developer', group: 'models' });
  });

  it("says where a reviewer's model sits in the file, since its name is not a path there", () => {
    expect(findSetting('roles.reviewers.security.model').inFile).toBe('the reviewer named security in roles.reviewers');
    for (const name of ['roles.architect.model', 'roles.tester.model', 'roles.builders.developer.model', 'workers']) {
      expect(findSetting(name), name).not.toBeNull();
      expect(findSetting(name).inFile, name).toBeUndefined();
    }
  });

  it('finds nothing for a name that is not a role model', () => {
    for (const name of ['roles.nope.model', 'roles.tester', 'roles.tester.agent', 'roles.builders.Dev.model', 'roles.reviewers.model', 'roles.architect.model.x', 'xroles.tester.model']) {
      expect(findSetting(name), name).toBeNull();
      expect(roleModelEntry(name), name).toBeNull();
    }
  });

  it('lists one entry per configured role: architect, builders, tester, reviewers', () => {
    expect(settingsFor(acme()).slice(REGISTRY.length).map((e) => e.label)).toEqual(['Architect', 'Builder: developer', 'Tester', 'Reviewer: compliance', 'Reviewer: compliance engine', 'Reviewer: security', 'Reviewer: security engine']);
    expect(settingsFor(acme()).slice(0, REGISTRY.length)).toEqual([...REGISTRY]);
    const custom = acme({ roles: { builders: { api: { agent: 'a', use: 'apis' }, web: { agent: 'w', use: 'pages' } }, reviewers: [{ name: 'perf', agent: 'p' }] } });
    expect(roleModelEntries(custom).map((e) => e.name)).toEqual([
      'roles.architect.model',
      'roles.builders.api.model',
      'roles.builders.web.model',
      'roles.tester.model',
      'roles.reviewers.perf.model',
      'roles.reviewers.perf.engine',
    ]);
  });

  it('shows an entry only when the project has that role', () => {
    const e = findSetting('roles.reviewers.ux.model');
    expect(e.when(acme())).toBe(false);
    expect(e.whenText).toBe('the project has a reviewer named ux');
    expect(e.when(acme({ roles: { reviewers: [{ name: 'ux', agent: 'u' }] } }))).toBe(true);
    expect(findSetting('roles.builders.ghost.model').when(acme())).toBe(false);
    expect(findSetting('roles.builders.developer.model').when(acme())).toBe(true);
    expect(findSetting('roles.tester.model').when(acme())).toBe(true);
    expect(findSetting('roles.builders.constructor.model').when(acme())).toBe(false);
  });

  it('reads and writes the role model on a loaded config, reviewers by name', () => {
    const config = acme({ roles: { tester: { agent: 'foreman:tester', model: 'haiku' } } });
    expect(findSetting('roles.tester.model').get(config)).toBe('haiku');
    expect(findSetting('roles.architect.model').get(config)).toBeUndefined();
    const sec = findSetting('roles.reviewers.security.model');
    expect(sec.put(config, 'opus')).toBe(config);
    expect(config.roles.reviewers).toEqual([
      { name: 'compliance', agent: 'foreman:compliance-reviewer' },
      { name: 'security', agent: 'foreman:security-reviewer', model: 'opus' },
    ]);
    expect(sec.get(config)).toBe('opus');
    const before = JSON.stringify(config);
    findSetting('roles.reviewers.ux.model').put(config, 'opus');
    findSetting('roles.builders.ghost.model').put(config, 'opus');
    expect(JSON.stringify(config)).toBe(before);
  });

  it('checks the value against the agent models', () => {
    const e = findSetting('roles.tester.model');
    expect(checkValue(e, 'haiku', acme())).toBeNull();
    expect(checkValue(e, 'gpt', acme())).toBe('must be one of haiku, sonnet, opus, fable');
  });

  it('sets the model in a raw file, copying the whole block from the merged config when the file has none', () => {
    const raw = { version: 1, project: { name: 'Acme' } };
    const config = acme();
    expect(findSetting('roles.tester.model').team.set(raw, 'haiku', config)).toEqual({ ...raw, roles: { tester: { agent: 'foreman:tester', model: 'haiku' } } });
    expect(raw).toEqual({ version: 1, project: { name: 'Acme' } });
    const rev = findSetting('roles.reviewers.security.model').team.set(raw, 'sonnet', config);
    expect(rev.roles.reviewers).toEqual([
      { name: 'compliance', agent: 'foreman:compliance-reviewer' },
      { name: 'security', agent: 'foreman:security-reviewer', model: 'sonnet' },
    ]);
    const dev = findSetting('roles.builders.developer.model').team.set(raw, 'opus', config);
    expect(dev.roles.builders).toEqual({ developer: { agent: 'foreman:builder', use: 'everything', model: 'opus' } });
    for (const next of [rev, dev]) expect(validate(next)).toEqual([]);
  });

  it('copies the builders from the merged config, so a pack project keeps its pack builders', () => {
    const packConfig = { ...acme(), roles: { ...acme().roles, builders: { apex: { agent: 'foreman:sf-builder', use: 'apex' } } } };
    const next = findSetting('roles.builders.apex.model').team.set({ version: 1, project: { name: 'Acme' } }, 'opus', packConfig);
    expect(next.roles.builders).toEqual({ apex: { agent: 'foreman:sf-builder', use: 'apex', model: 'opus' } });
  });

  it('removes only the model from the raw file, and returns null when the file does not set it', () => {
    const raw = { version: 1, project: { name: 'Acme' }, roles: { tester: { agent: 'foreman:tester', model: 'haiku' }, reviewers: [{ name: 'perf', agent: 'p', model: 'opus' }] } };
    expect(findSetting('roles.tester.model').team.remove(raw).roles.tester).toEqual({ agent: 'foreman:tester' });
    expect(findSetting('roles.reviewers.perf.model').team.remove(raw).roles.reviewers).toEqual([{ name: 'perf', agent: 'p' }]);
    expect(raw.roles.tester.model).toBe('haiku');
    expect(findSetting('roles.architect.model').team.remove(raw)).toBeNull();
    expect(findSetting('roles.builders.developer.model').team.remove(raw)).toBeNull();
    expect(findSetting('roles.tester.model').team.remove({ version: 1, project: { name: 'Acme' } })).toBeNull();
  });

  it('keeps the descriptions within the dashboard hint rules', () => {
    for (const e of roleModelEntries(acme())) {
      expect(e.description.length, e.name).toBeLessThanOrEqual(100);
      expect(e.description, e.name).not.toContain(';');
      expect(e.description, e.name).toMatch(/^[A-Z0-9`]/);
      expect(e.description, e.name).toMatch(/[^.]\.$/);
    }
  });

  it("has a models group, right after run", () => {
    expect(GROUPS).toContain('models');
    expect(GROUPS.indexOf('models')).toBe(GROUPS.indexOf('run') + 1);
  });

  it('leaves the static registry frozen and without role models', () => {
    expect(Object.isFrozen(REGISTRY)).toBe(true);
    expect(REGISTRY.some((e) => e.name.startsWith('roles.'))).toBe(false);
  });

  it("tells a reviewer's model apart from the engine it may run through", () => {
    expect(findSetting('roles.reviewers.security.model').description).toBe('The Claude model this reviewer runs on, or falls back to when its engine cannot run.');
    expect(findSetting('roles.tester.model').description).toBe("The Claude model this agent runs on. Unset, it uses the story session's model.");
  });
});

describe("a reviewer's engine setting", () => {
  const withEngine = () => acme({ roles: { reviewers: [
    { name: 'compliance', agent: 'foreman:compliance-reviewer' },
    { name: 'security', agent: 'foreman:security-reviewer', engine: { name: 'antigravity', model: 'claude-opus-4-6-thinking', minutes: 30 } },
  ] } });

  it('is one text setting per reviewer, engine:model, in the models group', () => {
    expect(findSetting('roles.reviewers.security.engine')).toMatchObject({
      name: 'roles.reviewers.security.engine',
      label: 'Reviewer: security engine',
      type: 'string',
      default: null,
      applies: 'next-story',
      group: 'models',
      secret: false,
      inFile: 'the reviewer named security in roles.reviewers',
      whenText: 'the project has a reviewer named security',
    });
    expect(findSetting('roles.reviewers.security.engine').description).toBe('Another CLI for this review, as engine:model, such as antigravity:claude-opus-4-6-thinking.');
    expect(findSetting('roles.reviewers.security.engine').when(acme())).toBe(true);
    expect(findSetting('roles.reviewers.ux.engine').when(acme())).toBe(false);
    for (const name of ['roles.tester.engine', 'roles.builders.developer.engine', 'roles.architect.engine', 'roles.reviewers.engine']) expect(findSetting(name), name).toBeNull();
  });

  it('reads the engine as engine:model and writes it back as the engine block, keeping its minutes', () => {
    const config = withEngine();
    const sec = findSetting('roles.reviewers.security.engine');
    expect(sec.get(config)).toBe('antigravity:claude-opus-4-6-thinking');
    expect(findSetting('roles.reviewers.compliance.engine').get(config)).toBeUndefined();
    expect(sec.put(config, 'antigravity:gemini-3-pro')).toBe(config);
    expect(config.roles.reviewers[1].engine).toEqual({ name: 'antigravity', model: 'gemini-3-pro', minutes: 30 });
    findSetting('roles.reviewers.compliance.engine').put(config, 'antigravity:claude-opus-4-6-thinking');
    expect(config.roles.reviewers[0].engine).toEqual({ name: 'antigravity', model: 'claude-opus-4-6-thinking' });
    expect(validate(config)).toEqual([]);
  });

  it('accepts only a known engine, a colon and a model', () => {
    const e = findSetting('roles.reviewers.security.engine');
    expect(checkValue(e, 'antigravity:claude-opus-4-6-thinking', acme())).toBeNull();
    for (const bad of ['antigravity', 'antigravity:', 'cursor:gpt-5', ':model', 'antigravity:two words', 'antigravity:a:b']) {
      expect(checkValue(e, bad, acme()), bad).toBe('expected engine:model, the engine being antigravity, such as antigravity:claude-opus-4-6-thinking');
    }
    expect(checkValue(e, '', acme())).toBe('expected non-empty text');
  });

  it('sets and removes the whole engine block in the raw file', () => {
    const raw = { version: 1, project: { name: 'Acme' } };
    const config = acme();
    const set = findSetting('roles.reviewers.security.engine').team.set(raw, 'antigravity:claude-opus-4-6-thinking', config);
    expect(set.roles.reviewers).toEqual([
      { name: 'compliance', agent: 'foreman:compliance-reviewer' },
      { name: 'security', agent: 'foreman:security-reviewer', engine: { name: 'antigravity', model: 'claude-opus-4-6-thinking' } },
    ]);
    expect(validate(withDefaults(set))).toEqual([]);
    expect(raw).toEqual({ version: 1, project: { name: 'Acme' } });
    const removed = findSetting('roles.reviewers.security.engine').team.remove(set);
    expect(removed.roles.reviewers[1]).toEqual({ name: 'security', agent: 'foreman:security-reviewer' });
    expect(findSetting('roles.reviewers.security.engine').team.remove(raw)).toBeNull();
    expect(findSetting('roles.reviewers.compliance.engine').team.remove(set)).toBeNull();
  });
});
