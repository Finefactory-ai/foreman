import { describe, expect, it } from 'vitest';
import { withDefaults } from '../config/defaults.mjs';
import { REGISTRY, settingsFor } from './registry.mjs';
import { checkLocal, configWithLocal, effective, getPath } from './resolve.mjs';

const min = (extra = {}) => withDefaults({ version: 1, project: { name: 'x' }, ...extra });

describe('effective', () => {
  it('lists every registry entry, then the role models, with source default for the minimal config', () => {
    const all = effective(min(), {});
    expect(Object.keys(all)).toEqual(settingsFor(min()).map((e) => e.name));
    expect(Object.keys(all).slice(0, REGISTRY.length)).toEqual(REGISTRY.map((e) => e.name));
    for (const e of settingsFor(min())) expect(all[e.name], e.name).toEqual({ value: e.default, source: 'default' });
  });

  it('takes a value the config file set, as team', () => {
    const all = effective(min({ slots: 3, rounds: 5, features: { followUps: false }, ship: { steps: ['pr'], ci: { timeoutMinutes: 45 } } }), {});
    expect(all.slots).toEqual({ value: 3, source: 'team' });
    expect(all.rounds).toEqual({ value: 5, source: 'team' });
    expect(all['features.followUps']).toEqual({ value: false, source: 'team' });
    expect(all['features.learnTraits']).toEqual({ value: true, source: 'default' });
    expect(all['ship.ci.timeoutMinutes']).toEqual({ value: 45, source: 'team' });
    expect(all['ship.ci.settleSeconds']).toEqual({ value: 90, source: 'default' });
  });

  it('takes a local value over the team value and the default', () => {
    const all = effective(min({ slots: 3, rounds: 5 }), { rounds: 2, 'features.followUps': false, workers: 3 });
    expect(all.rounds).toEqual({ value: 2, source: 'local' });
    expect(all['features.followUps']).toEqual({ value: false, source: 'local' });
    expect(all.workers).toEqual({ value: 3, source: 'local' });
    expect(all.slots).toEqual({ value: 3, source: 'team' });
  });

  it('ignores an invalid local value and falls back to the team value', () => {
    const all = effective(min({ rounds: 5 }), { rounds: 99, 'features.followUps': 'no' });
    expect(all.rounds).toEqual({ value: 5, source: 'team' });
    expect(all['features.followUps']).toEqual({ value: true, source: 'default' });
  });

  it('checks a local workers against the slots in effect, local ones included', () => {
    expect(effective(min({ slots: 2 }), { workers: 3 }).workers).toEqual({ value: 1, source: 'default' });
    expect(effective(min({ slots: 2 }), { workers: 3, slots: 4 }).workers).toEqual({ value: 3, source: 'local' });
  });
});

describe('checkLocal', () => {
  it('keeps the valid values and warns about each bad one', () => {
    const { values, warnings } = checkLocal(min(), { rounds: 2, slots: 0, nope: 1, 'stories.jql': 'project = X', 'features.followUps': 'off' });
    expect(values).toEqual({ rounds: 2 });
    expect(warnings).toEqual([
      'local setting slots ignored: must be a whole number from 1 to 8',
      'local setting nope ignored: unknown setting',
      'local setting stories.jql ignored: applies only when stories.adapter is "jira"',
      'local setting features.followUps ignored: expected true or false',
    ]);
  });
  it('accepts a missing or empty local layer', () => {
    expect(checkLocal(min(), undefined)).toEqual({ values: {}, warnings: [] });
    expect(checkLocal(min(), {})).toEqual({ values: {}, warnings: [] });
  });
  it('warns, and keeps nothing, when the local layer is not an object', () => {
    expect(checkLocal(min(), [1])).toEqual({ values: {}, warnings: ['local settings ignored: expected an object of name: value'] });
  });
});

describe('configWithLocal', () => {
  it('applies the valid local values at their paths and leaves the input alone', () => {
    const config = min({ ship: { steps: ['pr'] } });
    const before = JSON.stringify(config);
    const out = configWithLocal(config, { rounds: 2, 'features.followUpsOfFollowUps': true, 'ship.ci.timeoutMinutes': 5, 'ship.smoke.urls': ['https://a'] });
    expect(out.rounds).toBe(2);
    expect(out.features.followUpsOfFollowUps).toBe(true);
    expect(out.features.followUps).toBe(true);
    expect(out.ship).toEqual({ steps: ['pr'], ci: { timeoutMinutes: 5 }, smoke: { urls: ['https://a'] } });
    expect(JSON.stringify(config)).toBe(before);
  });
  it('drops invalid and inapplicable local values', () => {
    const out = configWithLocal(min(), { rounds: 0, 'stories.jql': 'x' });
    expect(out.rounds).toBe(3);
    expect(out.stories).toEqual({ adapter: 'markdown', dir: 'stories' });
  });
  it('resolves the Jira switches on every story source, ahead of the Jira write side using them', () => {
    const config = min({ features: { jiraTransitions: false } });
    expect(effective(config, { 'features.jiraComments': false })).toMatchObject({
      'features.jiraComments': { value: false, source: 'local' },
      'features.jiraTransitions': { value: false, source: 'team' },
    });
    expect(configWithLocal(config, { 'features.jiraComments': false }).features).toMatchObject({ jiraComments: false, jiraTransitions: false });
    expect(min().features).toMatchObject({ jiraComments: true, jiraTransitions: true });
  });
  it('takes a local ship.pr.into that is a branch name', () => {
    expect(configWithLocal(min({ ship: { steps: ['pr'] } }), { 'ship.pr.into': 'qa' }).ship).toEqual({ steps: ['pr'], pr: { into: 'qa' } });
  });
  it('ignores, with a warning, a local ship.pr.into that is not a branch name, so git and gh never see it', () => {
    const config = min({ ship: { steps: ['pr', 'merge'] } });
    for (const bad of ['-x', 'a..b', '--upload-pack=touch /tmp/pwned', 'qa:main']) {
      expect(checkLocal(config, { 'ship.pr.into': bad }).warnings, bad).toEqual([`local setting ship.pr.into ignored: expected a branch name`]);
      expect(configWithLocal(config, { 'ship.pr.into': bad }).ship, bad).toEqual({ steps: ['pr', 'merge'] });
    }
  });
  it("ignores, with a warning, a local ship.pr.into that is the pack's productionBranch", () => {
    const sf = withDefaults({ version: 1, project: { name: 'Acme' }, pack: 'salesforce', salesforce: { productionBranch: 'main' } });
    const why = 'local setting ship.pr.into ignored: must not be salesforce.productionBranch: nothing merges into production';
    expect(checkLocal(sf, { 'ship.pr.into': 'main' })).toMatchObject({ values: {}, warnings: [why] });
    expect(configWithLocal(sf, { 'ship.pr.into': 'main' }).ship.pr).toEqual(sf.ship.pr);
    expect(configWithLocal(sf, { 'ship.pr.into': 'qa' }).ship.pr.into).toBe('qa');
  });
  it('fills nothing in from the registry defaults', () => {
    const out = configWithLocal(min(), {});
    expect(out).toEqual(min());
  });
});

describe('role models on the local layer', () => {
  const LOCAL = { 'roles.tester.model': 'haiku', 'roles.reviewers.security.model': 'sonnet' };

  it('puts each role model into its role, a reviewer inside the array, and leaves the others alone', () => {
    const config = min();
    const before = JSON.stringify(config);
    const out = configWithLocal(config, LOCAL);
    expect(out.roles.tester).toEqual({ agent: 'foreman:tester', model: 'haiku' });
    expect(out.roles.reviewers).toEqual([
      { name: 'compliance', agent: 'foreman:compliance-reviewer' },
      { name: 'security', agent: 'foreman:security-reviewer', model: 'sonnet' },
    ]);
    expect(out.roles.architect).toEqual({ agent: 'foreman:architect' });
    expect(JSON.stringify(config)).toBe(before);
  });

  it('reports them as local, over a team value', () => {
    const config = min({ roles: { tester: { agent: 'foreman:tester', model: 'opus' } } });
    expect(effective(config, {})['roles.tester.model']).toEqual({ value: 'opus', source: 'team' });
    expect(effective(config, LOCAL)).toMatchObject({
      'roles.tester.model': { value: 'haiku', source: 'local' },
      'roles.reviewers.security.model': { value: 'sonnet', source: 'local' },
      'roles.reviewers.compliance.model': { value: null, source: 'default' },
    });
  });

  it('ignores a value for a role the project lacks, and an unknown model, with a warning', () => {
    const { values, warnings } = checkLocal(min(), { 'roles.reviewers.ux.model': 'opus', 'roles.tester.model': 'gpt' });
    expect(values).toEqual({});
    expect(warnings).toEqual([
      'local setting roles.reviewers.ux.model ignored: applies only when the project has a reviewer named ux',
      'local setting roles.tester.model ignored: must be one of haiku, sonnet, opus, fable',
    ]);
    expect(configWithLocal(min(), { 'roles.reviewers.ux.model': 'opus' }).roles).toEqual(min().roles);
  });
});

describe('getPath', () => {
  it('reads a dotted path, including names with hyphens, and never an inherited key', () => {
    expect(getPath({ ship: { 'deploy-github': { timeoutMinutes: 3 } } }, 'ship.deploy-github.timeoutMinutes')).toBe(3);
    expect(getPath({ a: 1 }, 'a.b')).toBeUndefined();
    expect(getPath({}, 'toString')).toBeUndefined();
  });
});
