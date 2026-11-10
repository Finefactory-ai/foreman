import { describe, expect, it, vi } from 'vitest';
import { fakePack } from '../../../test/fake-pack.mjs';
import { AGENT_MODELS, configWarnings, validate } from './validate.mjs';

const min = () => ({ version: 1, project: { name: 'x' } });
const paths = (raw) => validate(raw).map((e) => e.path);
const withKey = (k, v) => ({ ...min(), [k]: v });

describe('validate: the whole file', () => {
  it('accepts the minimal file', () => expect(validate(min())).toEqual([]));
  it.each([[null], [[]], ['text'], [42], [undefined]])('returns an error at "" for %j and never throws', (bad) => {
    expect(validate(bad)).toEqual([{ path: '', message: expect.any(String) }]);
  });
  it('flags a missing project.name', () => {
    expect(validate({ version: 1 })).toContainEqual({ path: 'project.name', message: 'required' });
    expect(paths({ version: 1, project: {} })).toContain('project.name');
    expect(paths({ version: 1, project: { name: '' } })).toContain('project.name');
  });
  it('says "expected non-empty string" for a wrong-typed project.name', () => {
    expect(validate({ version: 1, project: { name: 5 } })).toEqual([{ path: 'project.name', message: 'expected non-empty string' }]);
  });
  it('flags unknown top-level keys, such as a typo of slots', () => {
    expect(validate({ ...min(), slot: 2 })).toContainEqual({ path: 'slot', message: 'unknown key' });
  });
  it('flags unknown nested keys', () => {
    expect(validate(withKey('watchdog', { quiet: 5 }))).toContainEqual({ path: 'watchdog.quiet', message: 'unknown key' });
  });
});

describe('validate: version', () => {
  it('rejects an unsupported version', () => {
    expect(validate({ ...min(), version: 2 })).toContainEqual({ path: 'version', message: 'unsupported config version 2' });
  });
  it('requires a version', () => {
    expect(validate({ project: { name: 'x' } })).toContainEqual({ path: 'version', message: 'required' });
  });
});

describe('validate: scalars', () => {
  it.each([[0], [9], [1.5], ['2']])('rejects slots %j', (v) => {
    expect(validate(withKey('slots', v))).toContainEqual({ path: 'slots', message: 'must be an integer from 1 to 8' });
  });
  it.each([[1], [8]])('accepts slots %j', (v) => expect(validate(withKey('slots', v))).toEqual([]));
  it('checks rounds from 1 to 10', () => {
    expect(paths(withKey('rounds', 0))).toEqual(['rounds']);
    expect(paths(withKey('rounds', 11))).toEqual(['rounds']);
    expect(paths(withKey('rounds', 10))).toEqual([]);
  });
  it.each(['baseBranch', 'remote', 'branchPrefix', 'stateDir', 'envFile', 'foremanEnvFile'])('%s must be a non-empty string', (k) => {
    expect(paths(withKey(k, ''))).toEqual([k]);
    expect(paths(withKey(k, 3))).toEqual([k]);
    expect(paths(withKey(k, 'ok'))).toEqual([]);
  });
  it('foremanEnvFile must not be the same file as envFile', () => {
    const same = [{ path: 'foremanEnvFile', message: 'must not be the same file as envFile' }];
    expect(validate({ ...min(), envFile: '.env.foreman', foremanEnvFile: './.env.foreman' })).toEqual(same);
    expect(validate({ ...min(), foremanEnvFile: '.env.local' })).toEqual(same);
    expect(validate({ ...min(), envFile: '.env.foreman' })).toEqual(same);
    expect(validate({ ...min(), envFile: '.env', foremanEnvFile: '.env.foreman' })).toEqual([]);
  });
  it('keepAwake must be boolean', () => {
    expect(paths(withKey('keepAwake', 'yes'))).toEqual(['keepAwake']);
    expect(paths(withKey('keepAwake', false))).toEqual([]);
  });
  it('watchdog values are positive numbers', () => {
    expect(paths(withKey('watchdog', { quietMinutes: 0, buildMinutes: 'x' }))).toEqual(['watchdog.quietMinutes', 'watchdog.buildMinutes']);
    expect(paths(withKey('watchdog', { quietMinutes: 10 }))).toEqual([]);
  });
  it('rejects Infinity and NaN in watchdog values', () => {
    const raw = JSON.parse('{"version":1,"project":{"name":"x"},"watchdog":{"quietMinutes":1e999}}');
    expect(paths(raw)).toEqual(['watchdog.quietMinutes']);
    expect(paths(withKey('watchdog', { buildMinutes: NaN }))).toEqual(['watchdog.buildMinutes']);
  });
  it('accepts watchdog.ownerTaskHours as a positive number, fractions included, and rejects the rest', () => {
    expect(validate(withKey('watchdog', { ownerTaskHours: 24 }))).toEqual([]);
    expect(validate(withKey('watchdog', { ownerTaskHours: 0.5 }))).toEqual([]);
    for (const bad of [0, -1, '5']) {
      expect(validate(withKey('watchdog', { ownerTaskHours: bad })), String(bad)).toContainEqual({ path: 'watchdog.ownerTaskHours', message: 'must be a positive number' });
    }
  });
  it('accepts the progress watchdog limits, fractions included', () => {
    expect(validate(withKey('watchdog', { idleMinutes: 10, errorMinutes: 0.05, progressMinutes: 45 }))).toEqual([]);
    expect(validate(withKey('watchdog', { activityMinutes: 20 }))).toEqual([]);
  });
  it.each([[0], [-1], ['5'], ['x']])('rejects %j for each progress watchdog limit', (bad) => {
    for (const key of ['idleMinutes', 'errorMinutes', 'progressMinutes', 'activityMinutes']) {
      expect(validate(withKey('watchdog', { [key]: bad }))).toEqual([{ path: `watchdog.${key}`, message: 'must be a positive number' }]);
    }
  });
  it('accepts watchdog.outliveMinutes, fractions included', () => {
    expect(validate(withKey('watchdog', { outliveMinutes: 0.5 }))).toEqual([]);
  });
  it.each([[0], [-1], ['x']])('rejects %j for watchdog.outliveMinutes', (bad) => {
    expect(validate(withKey('watchdog', { outliveMinutes: bad }))).toEqual([{ path: 'watchdog.outliveMinutes', message: 'must be a positive number' }]);
  });
});

describe('validate: workers', () => {
  it.each([[0], [9], [1.5], ['2']])('rejects workers %j', (v) => {
    expect(validate({ ...min(), slots: 8, workers: v })).toContainEqual({ path: 'workers', message: 'must be an integer from 1 to 8' });
  });
  it('must not exceed slots', () => {
    expect(validate({ ...min(), slots: 2, workers: 3 })).toEqual([{ path: 'workers', message: 'must not be more than slots (2)' }]);
    expect(validate({ ...min(), workers: 2 })).toEqual([{ path: 'workers', message: 'must not be more than slots (1)' }]);
    expect(validate({ ...min(), slots: 3, workers: 3 })).toEqual([]);
  });
});

describe('validate: features', () => {
  it('accepts known switches set to true or false', () => {
    expect(validate(withKey('features', { followUps: false, jiraComments: true, followUpsOfFollowUps: true }))).toEqual([]);
  });
  it('must be an object', () => {
    expect(validate(withKey('features', []))).toEqual([{ path: 'features', message: 'expected object' }]);
  });
  it('flags an unknown switch', () => {
    expect(validate(withKey('features', { followUp: false }))).toEqual([{ path: 'features.followUp', message: 'unknown key' }]);
  });
  it('each switch is a boolean', () => {
    expect(validate(withKey('features', { followUps: 'off', learnTraits: 0 }))).toEqual([
      { path: 'features.followUps', message: 'expected boolean' },
      { path: 'features.learnTraits', message: 'expected boolean' },
    ]);
  });
  it('takes summary or full for jiraCommentDetail, and nothing else', () => {
    expect(validate(withKey('features', { jiraCommentDetail: 'full' }))).toEqual([]);
    expect(validate(withKey('features', { jiraCommentDetail: 'summary' }))).toEqual([]);
    for (const bad of ['all', true]) {
      expect(validate(withKey('features', { jiraCommentDetail: bad }))).toEqual([{ path: 'features.jiraCommentDetail', message: 'must be one of summary, full' }]);
    }
  });
  it('ignores inherited names such as toString', () => {
    expect(paths(withKey('features', JSON.parse('{"toString": true}')))).toEqual(['features.toString']);
  });
});

describe('validate: learning', () => {
  const learning = (v) => validate(withKey('learning', v));
  const full = { auto: true, apply: true, model: 'haiku', skillModel: 'sonnet', window: 5, maxPerRole: 8, maxSkills: 10, maxEvaluating: 2, maxPerDay: 3, maxUsdPerDay: 2, redact: [] };
  it('accepts the full default block and a partial one', () => {
    expect(learning(full)).toEqual([]);
    expect(learning({ auto: false, model: 'opus' })).toEqual([]);
  });
  it('is a known top-level key, and the minimal file is still valid', () => {
    expect(validate(min())).toEqual([]);
    expect(learning({})).toEqual([]);
  });
  it('must be an object', () => {
    expect(learning([])).toEqual([{ path: 'learning', message: 'expected object' }]);
  });
  it('flags an unknown key, including inherited names such as toString', () => {
    expect(learning({ windw: 5 })).toEqual([{ path: 'learning.windw', message: 'unknown key' }]);
    expect(paths(withKey('learning', JSON.parse('{"toString":1}')))).toEqual(['learning.toString']);
  });
  it('auto and apply are booleans', () => {
    expect(learning({ auto: 'off', apply: 0 })).toEqual([
      { path: 'learning.auto', message: 'expected boolean' },
      { path: 'learning.apply', message: 'expected boolean' },
    ]);
  });
  it('refuses an unknown model', () => {
    expect(learning({ model: 'gpt-4', skillModel: 'claude' })).toEqual([
      { path: 'learning.model', message: 'must be one of haiku, sonnet, opus' },
      { path: 'learning.skillModel', message: 'must be one of haiku, sonnet, opus' },
    ]);
    for (const m of ['haiku', 'sonnet', 'opus']) expect(learning({ model: m, skillModel: m })).toEqual([]);
  });
  it('window is a whole number of at least 3', () => {
    for (const bad of [2, 3.5, '5', -3]) {
      expect(learning({ window: bad }), String(bad)).toEqual([{ path: 'learning.window', message: 'must be an integer of at least 3' }]);
    }
    expect(learning({ window: 3 })).toEqual([]);
  });
  it('the caps are whole numbers of at least 0, and 0 is allowed', () => {
    for (const key of ['maxPerRole', 'maxSkills', 'maxEvaluating', 'maxPerDay']) {
      for (const bad of [-1, 1.5, '2']) {
        expect(learning({ [key]: bad }), `${key} ${bad}`).toEqual([{ path: `learning.${key}`, message: 'must be an integer of at least 0' }]);
      }
      expect(learning({ [key]: 0 }), key).toEqual([]);
    }
  });
  it('maxUsdPerDay is a finite number of at least 0', () => {
    for (const bad of [-0.5, Infinity, NaN, '2']) {
      expect(learning({ maxUsdPerDay: bad }), String(bad)).toEqual([{ path: 'learning.maxUsdPerDay', message: 'must be a number of at least 0' }]);
    }
    expect(learning({ maxUsdPerDay: 0 })).toEqual([]);
    expect(learning({ maxUsdPerDay: 0.5 })).toEqual([]);
  });
  it('redact is a list of non-empty strings', () => {
    expect(learning({ redact: 'x' })).toEqual([{ path: 'learning.redact', message: 'expected array' }]);
    expect(learning({ redact: ['a', ''] })).toEqual([{ path: 'learning.redact[1]', message: 'expected non-empty string' }]);
    expect(learning({ redact: ['acme', 'sk-[a-z]+'] })).toEqual([]);
  });
});

describe('validate: install, checks, generated', () => {
  it('allows install null and an install object', () => {
    expect(validate(withKey('install', null))).toEqual([]);
    expect(validate(withKey('install', { run: 'npm ci', when: 'package-lock.json' }))).toEqual([]);
    expect(paths(withKey('install', { when: 'x' }))).toEqual(['install.run']);
    expect(validate(withKey('install', { run: 'a' }))).toEqual([{ path: 'install.when', message: 'required' }]);
    expect(paths(withKey('install', { run: 'a', when: 'x', extra: 1 }))).toEqual(['install.extra']);
    expect(validate(withKey('install', { run: 'npm ci', when: 'package-lock.json', creates: 'node_modules' }))).toEqual([]);
    expect(paths(withKey('install', { run: 'a', when: 'x', creates: '' }))).toEqual(['install.creates']);
  });
  it('checks each check', () => {
    const checks = [{ run: 'a', when: 'always' }, { run: 'b', when: 5 }, { when: 'always' }];
    expect(validate(withKey('checks', checks))).toEqual([
      { path: 'checks[1].when', message: 'must be "always" or a glob string' },
      { path: 'checks[2].run', message: 'required' },
    ]);
    expect(paths(withKey('checks', [{ run: 'a', when: 'src/**' }, { run: 'b', when: 'always' }]))).toEqual([]);
    expect(paths(withKey('checks', 'nope'))).toEqual(['checks']);
    expect(validate(withKey('checks', [{ run: 'a' }]))).toEqual([{ path: 'checks[0].when', message: 'required' }]);
  });
  it('allows a quick command on a check, a non-empty string', () => {
    expect(validate(withKey('checks', [{ run: 'a', when: 'always', quick: 'b' }]))).toEqual([]);
    expect(validate(withKey('checks', [{ run: 'a', when: 'always', quick: '' }]))).toEqual([{ path: 'checks[0].quick', message: 'expected non-empty string' }]);
    expect(validate(withKey('checks', [{ run: 'a', when: 'always', quick: 5 }]))).toEqual([{ path: 'checks[0].quick', message: 'expected non-empty string' }]);
    expect(paths(withKey('checks', [{ run: 'a', when: 'always', quick: 'b', fast: 'c' }]))).toEqual(['checks[0].fast']);
  });
  it('checks generated entries', () => {
    expect(paths(withKey('generated', [{ path: 'a' }]))).toEqual(['generated[0].regenerate']);
    expect(paths(withKey('generated', [{ path: 'a', regenerate: 'b' }]))).toEqual([]);
  });
});

describe('validate: fileLocks', () => {
  it('accepts a list of globs to leave out', () => {
    expect(validate(withKey('fileLocks', { ignore: ['docs/**'] }))).toEqual([]);
    expect(validate(withKey('fileLocks', {}))).toEqual([]);
  });
  it('flags a wrong shape, an unknown key and an empty glob, by path', () => {
    expect(validate(withKey('fileLocks', { ignore: 'x' }))).toEqual([{ path: 'fileLocks.ignore', message: 'expected array' }]);
    expect(validate(withKey('fileLocks', { ignored: [] }))).toEqual([{ path: 'fileLocks.ignored', message: 'unknown key' }]);
    expect(validate(withKey('fileLocks', { ignore: [''] }))).toEqual([{ path: 'fileLocks.ignore[0]', message: 'expected non-empty string' }]);
    expect(validate(withKey('fileLocks', ['x']))).toEqual([{ path: 'fileLocks', message: 'expected object' }]);
  });
});

describe('validate: roles', () => {
  const roles = (r) => withKey('roles', r);
  it('accepts a full roles block', () => {
    expect(validate(roles({
      architect: { agent: 'a', traits: ['x'] },
      builders: { developer: { agent: 'b', use: 'everything' } },
      tester: { agent: 't' },
      reviewers: [{ name: 'compliance', agent: 'c', prompt: 'p' }],
    }))).toEqual([]);
  });
  it('rejects a builder name that is not a slug', () => {
    expect(paths(roles({ builders: { 'UI Builder': { agent: 'a', use: 'u' } } }))).toEqual(['roles.builders.UI Builder']);
  });
  it('requires agent and use on builders', () => {
    expect(paths(roles({ builders: { ui: {} } }))).toEqual(['roles.builders.ui.agent', 'roles.builders.ui.use']);
  });
  it('accepts fullChecks on a builder, a boolean', () => {
    expect(validate(roles({ builders: { developer: { agent: 'b', use: 'u', fullChecks: true } } }))).toEqual([]);
    expect(validate(roles({ builders: { developer: { agent: 'b', use: 'u', fullChecks: false } } }))).toEqual([]);
    expect(validate(roles({ builders: { developer: { agent: 'b', use: 'u', fullChecks: 'yes' } } }))).toEqual([{ path: 'roles.builders.developer.fullChecks', message: 'expected boolean' }]);
    expect(paths(roles({ builders: { developer: { agent: 'b', use: 'u', fullChecks: true, quick: true } } }))).toEqual(['roles.builders.developer.quick']);
    expect(paths(roles({ tester: { agent: 't', fullChecks: true } }))).toEqual(['roles.tester.fullChecks']);
  });
  it('accepts a reviewer engine with a name, a model and optional minutes, and rejects the rest', () => {
    expect(validate(roles({ reviewers: [{ name: 'security', agent: 'a', engine: { name: 'antigravity', model: 'claude-opus-4-6-thinking' } }] }))).toEqual([]);
    expect(validate(roles({ reviewers: [{ name: 'security', agent: 'a', engine: { name: 'antigravity', model: 'm', minutes: 30 } }] }))).toEqual([]);
    expect(paths(roles({ reviewers: [{ name: 's', agent: 'a', engine: 'antigravity' }] }))).toEqual(['roles.reviewers[0].engine']);
    expect(paths(roles({ reviewers: [{ name: 's', agent: 'a', engine: { name: 'gemini', model: 'm' } }] }))).toEqual(['roles.reviewers[0].engine.name']);
    expect(paths(roles({ reviewers: [{ name: 's', agent: 'a', engine: { name: 'antigravity' } }] }))).toEqual(['roles.reviewers[0].engine.model']);
    expect(paths(roles({ reviewers: [{ name: 's', agent: 'a', engine: { name: 'antigravity', model: 'm', minutes: 0 } }] }))).toEqual(['roles.reviewers[0].engine.minutes']);
    expect(paths(roles({ reviewers: [{ name: 's', agent: 'a', engine: { name: 'antigravity', model: 'm', cli: 'x' } }] }))).toEqual(['roles.reviewers[0].engine.cli']);
  });
  it('checks reviewers', () => {
    expect(paths(roles({ reviewers: [{ name: 'Bad Name', agent: 'a' }, { agent: 'a' }, { name: 'ok', agent: 1 }] })))
      .toEqual(['roles.reviewers[0].name', 'roles.reviewers[1].name', 'roles.reviewers[2].agent']);
  });
  it('checks architect, tester and traits', () => {
    expect(paths(roles({ architect: {}, tester: { agent: 't', traits: 'x' } }))).toEqual(['roles.architect.agent', 'roles.tester.traits']);
    expect(paths(roles({ tester: { agent: 't', traits: ['a', 2] } }))).toEqual(['roles.tester.traits[1]']);
  });
  it('rejects names that exist on Object.prototype', () => {
    expect(paths(roles({ builders: { constructor: { agent: 'a', use: 'u' } } }))).toEqual(['roles.builders.constructor']);
    expect(paths(roles({ reviewers: [{ name: 'constructor', agent: 'a' }] }))).toEqual(['roles.reviewers[0].name']);
    expect(paths(withKey('resources', { constructor: { paths: ['a'], describe: 'd' } }))).toEqual(['resources.constructor']);
  });
  it('rejects duplicate reviewer names', () => {
    expect(validate(roles({ reviewers: [{ name: 'a', agent: 'x' }, { name: 'b', agent: 'x' }, { name: 'a', agent: 'x' }] })))
      .toEqual([{ path: 'roles.reviewers[2].name', message: 'duplicate' }]);
  });
  it('flags unknown role keys', () => {
    expect(paths(roles({ boss: {} }))).toEqual(['roles.boss']);
    expect(paths(roles({ tester: { agent: 't', color: 'red' } }))).toEqual(['roles.tester.color']);
  });
});

describe('validate: role models', () => {
  const roles = (r) => withKey('roles', r);
  const MUST = 'must be one of haiku, sonnet, opus, fable';

  it('lists the model aliases the agent() call takes', () => {
    expect(AGENT_MODELS).toEqual(['haiku', 'sonnet', 'opus', 'fable']);
  });

  it('accepts a model on every kind of role', () => {
    expect(validate({ version: 1, project: { name: 'Acme' }, roles: { architect: { agent: 'foreman:architect', model: 'opus' }, tester: { agent: 'foreman:tester', model: 'haiku' } } })).toEqual([]);
    expect(validate(roles({ builders: { developer: { agent: 'foreman:builder', use: 'everything', model: 'sonnet' } } }))).toEqual([]);
    expect(validate(roles({ reviewers: [{ name: 'compliance', agent: 'foreman:compliance-reviewer', model: 'fable' }] }))).toEqual([]);
  });

  it('refuses any other model, at its path', () => {
    expect(validate(roles({ tester: { agent: 't', model: 'gpt-4' } }))).toEqual([{ path: 'roles.tester.model', message: MUST }]);
    expect(validate(roles({ architect: { agent: 'a', model: '' } }))).toEqual([{ path: 'roles.architect.model', message: MUST }]);
    expect(validate(roles({ builders: { developer: { agent: 'b', use: 'u', model: 'x' } } }))).toEqual([{ path: 'roles.builders.developer.model', message: MUST }]);
    expect(validate(roles({ reviewers: [{ name: 'a', agent: 'x' }, { name: 'b', agent: 'x', model: 'x' }] }))).toEqual([{ path: 'roles.reviewers[1].model', message: MUST }]);
    expect(validate(roles({ tester: { agent: 't', model: null } }))).toEqual([{ path: 'roles.tester.model', message: MUST }]);
  });

  it('accepts a model on a Salesforce pack role', () => {
    const sf = {
      version: 1,
      project: { name: 'Acme' },
      pack: 'salesforce',
      salesforce: { orgs: { 'acme-dev1': { orgId: '00D000000000001AAA' } }, build: 'acme-dev1', stages: [{ name: 'dev', org: 'acme-dev1' }] },
    };
    expect(validate(sf)).toEqual([]);
    expect(validate({ ...sf, roles: { architect: { agent: 'foreman:sf-architect', model: 'opus' } } })).toEqual([]);
    expect(validate({ ...sf, roles: { architect: { agent: 'foreman:sf-architect', model: 'gpt' } } })).toEqual([{ path: 'roles.architect.model', message: MUST }]);
  });
});

describe('validate: resources', () => {
  it('rejects empty strings in lists and describe', () => {
    expect(paths(withKey('resources', { schema: { paths: [''], describe: '' } }))).toEqual(['resources.schema.paths[0]', 'resources.schema.describe']);
    expect(paths(withKey('ship', { steps: [''] }))).toEqual(['ship.steps[0]']);
    expect(paths(withKey('roles', { tester: { agent: 't', traits: [''] } }))).toEqual(['roles.tester.traits[0]']);
  });
  it('needs slug names, paths and describe', () => {
    expect(paths(withKey('resources', { 'Bad Name': { paths: ['a'], describe: 'd' } }))).toEqual(['resources.Bad Name']);
    expect(paths(withKey('resources', { schema: { paths: [], describe: 'd' } }))).toEqual(['resources.schema.paths']);
    expect(paths(withKey('resources', { schema: { paths: ['a', 2] } }))).toEqual(['resources.schema.paths[1]', 'resources.schema.describe']);
    expect(paths(withKey('resources', { schema: { paths: ['a'], describe: 'd' } }))).toEqual([]);
  });
});

describe('validate: adapter blocks', () => {
  it.each(['stories', 'env', 'notify', 'console'])('%s needs an object with a non-empty adapter string', (k) => {
    expect(paths(withKey(k, 'x'))).toEqual([k]);
    expect(paths(withKey(k, {}))).toEqual([`${k}.adapter`]);
    expect(paths(withKey(k, { adapter: '' }))).toEqual([`${k}.adapter`]);
    expect(paths(withKey(k, { adapter: 'a' }))).toEqual([]);
  });
  it('passes extra keys inside an adapter block', () => {
    expect(validate(withKey('stories', { adapter: 'markdown', dir: 'x', idPattern: '^P' }))).toEqual([]);
  });
  it('checks ship steps and ci but leaves other keys alone', () => {
    expect(paths(withKey('ship', { steps: [] }))).toEqual(['ship.steps']);
    expect(paths(withKey('ship', { steps: ['pr', 3] }))).toEqual(['ship.steps[1]']);
    expect(paths(withKey('ship', { steps: ['pr'], ci: 'x' }))).toEqual(['ship.ci']);
    expect(paths(withKey('ship', { steps: ['pr'], ci: { required: [] }, deploy: { a: 1 } }))).toEqual([]);
  });
  it('checks ship.productionHosts', () => {
    const hosts = (h) => paths(withKey('ship', { steps: ['pr'], productionHosts: h }));
    expect(hosts(['api.example.com', 'db.x.supabase.co'])).toEqual([]);
    expect(hosts('api.example.com')).toEqual(['ship.productionHosts']);
    expect(hosts([])).toEqual(['ship.productionHosts']);
    expect(hosts([''])).toEqual(['ship.productionHosts[0]']);
    expect(hosts(['https://api.example.com'])).toEqual(['ship.productionHosts[0]']);
    expect(hosts(['api.example.com/path'])).toEqual(['ship.productionHosts[0]']);
  });
  it('checks ship.smoke options', () => {
    const smoke = (s) => paths(withKey('ship', { steps: ['smoke'], smoke: s }));
    expect(smoke({ urls: ['https://a'], expect: { 'https://a': 200 } })).toEqual([]);
    expect(smoke({ urls: ['https://a'] })).toEqual([]);
    expect(smoke('x')).toEqual(['ship.smoke']);
    expect(smoke({ urls: ['https://a'], expct: {} })).toEqual(['ship.smoke.expct']);
    expect(smoke({ expect: [] })).toEqual(['ship.smoke.expect']);
    expect(smoke({ expect: { 'https://a': '200' } })).toEqual(['ship.smoke.expect["https://a"]']);
    expect(smoke({ expect: { 'https://a': 99 } })).toEqual(['ship.smoke.expect["https://a"]']);
    expect(smoke({ expect: { 'https://a': 600 } })).toEqual(['ship.smoke.expect["https://a"]']);
    expect(smoke({ expect: { 'https://a': 200.5 } })).toEqual(['ship.smoke.expect["https://a"]']);
  });
  it('checks ship.watch options', () => {
    const watch = (w, steps = ['merge', 'watch']) => paths(withKey('ship', { steps, ...(w === undefined ? {} : { watch: w }) }));
    expect(watch({ command: './check.sh' })).toEqual([]);
    expect(watch({ command: './check.sh', minutes: 5, everySeconds: 30 })).toEqual([]);
    expect(watch(undefined)).toEqual(['ship.watch.command']);
    expect(watch({})).toEqual(['ship.watch.command']);
    expect(watch({ command: '' })).toEqual(['ship.watch.command']);
    expect(watch('x')).toEqual(['ship.watch']);
    expect(watch({ command: './check.sh', minuts: 5 })).toEqual(['ship.watch.minuts']);
    expect(watch({ command: './check.sh', minutes: 0 })).toEqual(['ship.watch.minutes']);
    expect(watch({ command: './check.sh', everySeconds: '60' })).toEqual(['ship.watch.everySeconds']);
    expect(watch({ command: './check.sh' }, ['merge'])).toEqual([]);
    expect(watch({ command: './check.sh', timeoutSeconds: 30 })).toEqual([]);
    expect(watch({ command: './check.sh', timeoutSeconds: 0 })).toEqual(['ship.watch.timeoutSeconds']);
    expect(watch({ command: './check.sh', timeoutSeconds: '30' })).toEqual(['ship.watch.timeoutSeconds']);
  });
  it('checks ship.rollback.timeoutSeconds', () => {
    const rollback = (r) => paths(withKey('ship', { steps: ['merge'], rollback: { command: 'x', ...r } }));
    expect(rollback({ timeoutSeconds: 300 })).toEqual([]);
    expect(rollback({ timeoutSeconds: -1 })).toEqual(['ship.rollback.timeoutSeconds']);
    expect(rollback({ timeoutSeconds: Infinity })).toEqual(['ship.rollback.timeoutSeconds']);
  });
  it('checks ship.rollback options and keeps rollback out of ship.steps', () => {
    const ship = (s) => validate(withKey('ship', s));
    expect(ship({ steps: ['merge'], rollback: { command: 'vercel rollback --yes' } })).toEqual([]);
    expect(ship({ steps: ['merge'], rollback: {} })).toEqual([{ path: 'ship.rollback.command', message: 'required' }]);
    expect(ship({ steps: ['merge'], rollback: { command: 'x', when: 'always' } })).toEqual([{ path: 'ship.rollback.when', message: 'unknown key' }]);
    expect(ship({ steps: ['merge', 'rollback'], rollback: { command: 'x' } })).toEqual([
      { path: 'ship.steps[1]', message: 'rollback runs only on failure; set ship.rollback.command and leave it out of ship.steps' },
    ]);
  });
  it('checks ship.ci timings and required names', () => {
    const ci = (c) => paths(withKey('ship', { steps: ['ci'], ci: c }));
    expect(ci({ required: ['unit'], timeoutMinutes: 10, settleSeconds: 30 })).toEqual([]);
    expect(ci({ timeoutMinutes: Number.NaN })).toEqual(['ship.ci.timeoutMinutes']);
    expect(ci({ timeoutMinutes: 0 })).toEqual(['ship.ci.timeoutMinutes']);
    expect(ci({ timeoutMinutes: '30' })).toEqual(['ship.ci.timeoutMinutes']);
    expect(ci({ timeoutMinutes: Infinity })).toEqual(['ship.ci.timeoutMinutes']);
    expect(ci({ settleSeconds: -1 })).toEqual(['ship.ci.settleSeconds']);
    expect(ci({ required: 'unit' })).toEqual(['ship.ci.required']);
    expect(ci({ required: ['unit', ''] })).toEqual(['ship.ci.required[1]']);
  });
  it('checks ship.pr.mergeMethod', () => {
    const pr = (p) => paths(withKey('ship', { steps: ['merge'], pr: p }));
    for (const m of ['merge', 'squash', 'rebase']) expect(pr({ mergeMethod: m })).toEqual([]);
    expect(pr({ mergeMethod: 'fast-forward' })).toEqual(['ship.pr.mergeMethod']);
    expect(pr('x')).toEqual(['ship.pr']);
  });
  it('checks ship.pr.into is a branch name', () => {
    const pr = (p) => paths(withKey('ship', { steps: ['merge'], pr: p }));
    expect(pr({ into: 'qa' })).toEqual([]);
    expect(pr({ into: 'env/qa' })).toEqual([]);
    for (const bad of ['', 3, 'a..b', '-x']) expect(pr({ into: bad })).toEqual(['ship.pr.into']);
    expect(validate(withKey('ship', { steps: ['merge'], pr: { into: '' } }))).toContainEqual({ path: 'ship.pr.into', message: 'expected a branch name' });
  });
  it('checks ship.merge', () => {
    const merge = (m) => paths(withKey('ship', { steps: ['merge'], merge: m }));
    expect(merge({ keepBranch: true })).toEqual([]);
    expect(merge({ keepBranch: false })).toEqual([]);
    expect(merge({ keepBranch: 'yes' })).toEqual(['ship.merge.keepBranch']);
    expect(merge({ keep: true })).toEqual(['ship.merge.keep']);
    expect(merge('x')).toEqual(['ship.merge']);
    expect(validate(withKey('ship', { steps: ['merge'], merge: { keepBranch: 1 } }))).toContainEqual({ path: 'ship.merge.keepBranch', message: 'expected true or false' });
  });
});

describe('validate: state', () => {
  const state = (v) => paths(withKey('state', v));
  it('accepts the files and branch stores, with or without a branch name', () => {
    expect(state({ store: 'files' })).toEqual([]);
    expect(state({ store: 'branch' })).toEqual([]);
    expect(state({ store: 'branch', branch: 'foreman-state' })).toEqual([]);
    expect(state({ branch: 'state/foreman' })).toEqual([]);
  });
  it('rejects another store, a bad branch name and unknown keys', () => {
    expect(validate(withKey('state', { store: 'db' }))).toContainEqual({ path: 'state.store', message: 'must be "files" or "branch"' });
    for (const bad of ['', 'has space', '-x', 'a..b', '/a', 'a/', 'a.lock', 5]) expect(state({ branch: bad })).toEqual(['state.branch']);
    expect(state({ store: 'branch', where: 'x' })).toEqual(['state.where']);
    expect(state('branch')).toEqual(['state']);
  });
  it('rejects the base branch as the state branch', () => {
    expect(paths({ ...min(), state: { store: 'branch', branch: 'main' } })).toEqual(['state.branch']);
    expect(paths({ ...min(), baseBranch: 'trunk', state: { branch: 'trunk' } })).toEqual(['state.branch']);
  });
});

describe('validate: cloud', () => {
  const cloud = (v) => paths(withKey('cloud', v));
  it('accepts the key names, the idle wait and the schedule', () => {
    expect(cloud({})).toEqual([]);
    expect(cloud({ envVars: ['RESEND_API_KEY', 'supabase_url', '_X1'], idleMinutes: 2.5, actions: { cron: '0 */2 * * 1-5' } })).toEqual([]);
    expect(cloud({ actions: { cron: '*/30 * * * *' } })).toEqual([]);
  });
  it('rejects a bad key name, a bad wait, a bad schedule and unknown keys', () => {
    expect(cloud({ envVars: 'RESEND_API_KEY' })).toEqual(['cloud.envVars']);
    for (const bad of ['', '1X', 'HAS SPACE', 'A-B', 5]) expect(cloud({ envVars: [bad] })).toEqual(['cloud.envVars[0]']);
    for (const bad of [0, -1, '10', null]) expect(cloud({ idleMinutes: bad })).toEqual(['cloud.idleMinutes']);
    for (const bad of ['', '* * * *', '* * * * * *', '@hourly', '0 9 * * MON;rm', 5]) expect(cloud({ actions: { cron: bad } })).toEqual(['cloud.actions.cron']);
    expect(cloud({ actions: { cron: '0 * * * *', on: 'push' } })).toEqual(['cloud.actions.on']);
    expect(cloud({ actions: 'x' })).toEqual(['cloud.actions']);
    expect(cloud({ where: 'fly' })).toEqual(['cloud.where']);
    expect(cloud('x')).toEqual(['cloud']);
  });
});

describe('validate: session', () => {
  const session = (v) => paths(withKey('session', v));
  it('accepts no list, an empty list and plain tool names', () => {
    expect(session({})).toEqual([]);
    expect(session({ extraTools: [] })).toEqual([]);
    expect(session({ extraTools: ['mcp__acme__query', 'Workflow(acme:x)'] })).toEqual([]);
  });
  it('rejects a non-object, a non-list, a bad name and unknown keys', () => {
    expect(session('x')).toEqual(['session']);
    expect(session({ extraTools: 'mcp__a' })).toEqual(['session.extraTools']);
    for (const bad of ['', 5, null, '--dangerously-skip-permissions', '-x', 'has space']) {
      expect(session({ extraTools: [bad] })).toEqual(['session.extraTools[0]']);
    }
    expect(session({ tools: [] })).toEqual(['session.tools']);
  });
  it('is a known top-level key', () => {
    expect(validate({ ...min(), session: { extraTools: [] } })).toEqual([]);
  });
  it('accepts a model of the agent set for the story session itself, and no other', () => {
    expect(session({ model: 'sonnet' })).toEqual([]);
    expect(session({ model: 'fable' })).toEqual([]);
    expect(session({ model: 'gpt-5' })).toEqual(['session.model']);
    expect(session({ model: 5 })).toEqual(['session.model']);
  });
  it('accepts MCP server names and the userSettings switch', () => {
    expect(session({ mcpServers: ['acmeDb', 'acme-docs', 'a.b_c'], userSettings: false })).toEqual([]);
    expect(session({ mcpServers: [], userSettings: true })).toEqual([]);
  });
  it('rejects a bad server list, a bad server name and a non-boolean userSettings', () => {
    expect(session({ mcpServers: 'x' })).toEqual(['session.mcpServers']);
    for (const bad of ['-x', 'has space', '_x', 'a/b']) {
      const errors = validate(withKey('session', { mcpServers: ['acmeDb', bad] }));
      expect(errors).toEqual([{ path: 'session.mcpServers[1]', message: 'expected an MCP server name from .mcp.json' }]);
    }
    expect(session({ mcpServers: [''] })).toEqual(['session.mcpServers[0]']);
    expect(session({ mcpServers: [5] })).toEqual(['session.mcpServers[0]']);
    expect(session({ userSettings: 'no' })).toEqual(['session.userSettings']);
    expect(session({ userSettings: 1 })).toEqual(['session.userSettings']);
    expect(session({ userSetting: true })).toEqual(['session.userSetting']);
  });
});

describe('validate: claude', () => {
  const claude = (v) => validate(withKey('claude', v));
  it('accepts the two fallbacks and an empty block', () => {
    expect(claude({ fallback: 'subscription' })).toEqual([]);
    expect(claude({ fallback: 'none' })).toEqual([]);
    expect(claude({})).toEqual([]);
  });
  it('rejects another fallback, an unknown key and a non-object', () => {
    expect(claude({ fallback: 'max' })).toEqual([{ path: 'claude.fallback', message: 'must be one of subscription, none' }]);
    expect(claude({ fallback: 'none', plan: 'max' })).toEqual([{ path: 'claude.plan', message: 'unknown key' }]);
    expect(claude('none')).toEqual([{ path: 'claude', message: 'expected object' }]);
  });
});

describe('validate: checkRuns', () => {
  const runs = (v) => validate(withKey('checkRuns', v));
  it('accepts a whole number from 1 to 64 and an empty block', () => {
    expect(runs({ maxParallel: 2 })).toEqual([]);
    expect(runs({ maxParallel: 1 })).toEqual([]);
    expect(runs({ maxParallel: 64 })).toEqual([]);
    expect(runs({})).toEqual([]);
  });
  it.each([[0], [65], [1.5], ['x'], [null]])('rejects maxParallel %j', (bad) => {
    expect(runs({ maxParallel: bad })).toEqual([{ path: 'checkRuns.maxParallel', message: 'must be an integer from 1 to 64' }]);
  });
  it('rejects an unknown key and a non-object', () => {
    expect(runs({ maxParallel: 2, other: 1 })).toEqual([{ path: 'checkRuns.other', message: 'unknown key' }]);
    expect(runs(3)).toEqual([{ path: 'checkRuns', message: 'expected object' }]);
  });
});

describe('validate: reports every error', () => {
  it('collects several errors in one pass', () => {
    expect(paths({ version: 1, slots: 0, slot: 1 })).toEqual(expect.arrayContaining(['project.name', 'slots', 'slot']));
  });
});

describe('configWarnings', () => {
  it('has none for the minimal file', () => expect(configWarnings(min())).toEqual([]));
  it('says the top-level keepAwake is deprecated, and what to use', () => {
    expect(configWarnings(withKey('keepAwake', false))).toEqual(['keepAwake is deprecated; it is read as features.keepAwake (`foreman settings set features.keepAwake false --team` moves it there)']);
  });
  it('says features.keepAwake wins when both are set', () => {
    expect(configWarnings({ ...min(), keepAwake: false, features: { keepAwake: true } })).toEqual(['keepAwake is deprecated and ignored: features.keepAwake is set too; remove keepAwake']);
  });
  it('never throws on a file that is not an object', () => {
    expect(configWarnings(null)).toEqual([]);
  });
});

describe('validate: pack', () => {
  const packs = { acme: fakePack() };
  const acme = (over = {}) => ({ ...min(), pack: 'acme', ...over });

  it('accepts a known pack', () => {
    expect(validate(acme(), { packs })).toEqual([]);
  });
  it('rejects an unknown pack and names the known ones', () => {
    expect(validate({ ...min(), pack: 'zeta' }, { packs: { acme: fakePack(), beta: fakePack({ name: 'beta' }) } })).toEqual([
      { path: 'pack', message: 'unknown pack "zeta"; known packs: acme, beta' },
    ]);
  });
  it('says no packs are installed when the registry is empty', () => {
    expect(validate({ ...min(), pack: 'salesforce' }, { packs: {} })).toEqual([{ path: 'pack', message: 'unknown pack "salesforce"; no packs are installed' }]);
  });
  it.each([[3], ['']])('rejects pack %j', (v) => {
    expect(validate({ ...min(), pack: v }, { packs })).toEqual([{ path: 'pack', message: 'expected non-empty string' }]);
  });
});

describe('validate: the pack block', () => {
  const packs = { acme: fakePack() };
  const acme = (block) => ({ ...min(), pack: 'acme', acme: block });

  it('prefixes the paths checkConfig returns with the block name', () => {
    expect(validate(acme({ region: 'moon' }), { packs })).toEqual([{ path: 'acme.region', message: 'unknown region' }]);
  });
  it('accepts a good block', () => {
    expect(validate(acme({ region: 'eu' }), { packs })).toEqual([]);
  });
  it('hands checkConfig exactly the project block', () => {
    const checkConfig = vi.fn(() => []);
    const raw = acme({ region: 'eu' });
    validate(raw, { packs: { acme: fakePack({ checkConfig }) } });
    expect(checkConfig).toHaveBeenCalledTimes(1);
    expect(checkConfig.mock.calls[0][0]).toBe(raw.acme);
    expect(checkConfig.mock.calls[0][1]).toBe(raw);
  });
  it('uses the block name alone for an empty path', () => {
    const pack = fakePack({ checkConfig: () => [{ path: '', message: 'expected object' }] });
    expect(validate(acme(5), { packs: { acme: pack } })).toEqual([{ path: 'acme', message: 'expected object' }]);
  });
  it('treats a pack block without pack as an unknown key', () => {
    expect(validate({ ...min(), acme: { region: 'eu' } }, { packs })).toEqual([{ path: 'acme', message: 'unknown key' }]);
  });
  it('reports a checkConfig that throws, and does not throw', () => {
    const pack = fakePack({ checkConfig: () => { throw new Error('boom'); } });
    expect(validate(acme({}), { packs: { acme: pack } })).toEqual([{ path: 'acme', message: 'the acme pack could not check its block: boom' }]);
  });
});

describe('validate: the Salesforce story source', () => {
  const sfStories = { adapter: 'salesforce', org: 'acme-qa', where: "IsClosed = false AND Type = 'Foreman'" };

  it('needs the Salesforce pack, and says where the Cases org goes', () => {
    expect(validate({ ...min(), stories: sfStories })).toEqual([
      { path: 'stories.adapter', message: '"salesforce" needs "pack": "salesforce", with the org that holds the Cases in salesforce.orgs' },
    ]);
  });
  it('is not reported again with the pack on (the pack checks its own block)', () => {
    const errors = validate({ ...min(), pack: 'salesforce', stories: sfStories });
    expect(errors.filter((e) => e.path === 'stories.adapter')).toEqual([]);
  });
  it('leaves other adapters alone', () => {
    expect(validate({ ...min(), stories: { adapter: 'markdown', dir: 'stories' } })).toEqual([]);
  });
});
