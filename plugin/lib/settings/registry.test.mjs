import { describe, expect, it } from 'vitest';
import { DEFAULTS, withDefaults } from '../config/defaults.mjs';
import { APPLIES, checkValue, findSetting, GROUPS, looksSecret, parseValue, REGISTRY, shown, TYPES } from './registry.mjs';

const min = () => withDefaults({ version: 1, project: { name: 'x' } });
const get = (obj, name) => name.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
const jira = () => ({ ...min(), stories: { adapter: 'jira', site: 'acme.atlassian.net', jql: 'project = X' } });

describe('the settings registry', () => {
  it('gives every entry a name, label, description, type, applies, group and no secret', () => {
    const names = new Set();
    for (const e of REGISTRY) {
      expect(e.name).toMatch(/^[A-Za-z][\w-]*(\.[A-Za-z][\w-]*)*$/);
      expect(names.has(e.name)).toBe(false);
      names.add(e.name);
      expect(typeof e.label).toBe('string');
      expect(e.label.length).toBeGreaterThan(0);
      expect(e.description.length).toBeGreaterThan(0);
      expect(TYPES).toContain(e.type);
      expect(APPLIES).toContain(e.applies);
      expect(GROUPS).toContain(e.group);
      expect(e.secret).toBe(false);
      expect(looksSecret(e.name)).toBe(false);
    }
  });

  it('has every default valid for its own type and limits (null means the reader decides)', () => {
    for (const e of REGISTRY) {
      if (e.default === null) continue;
      expect(checkValue(e, e.default, min()), e.name).toBeNull();
    }
  });

  it('agrees with the config defaults wherever both have a value', () => {
    for (const e of REGISTRY) {
      const d = get(DEFAULTS, e.name);
      if (d !== undefined) expect(e.default, e.name).toEqual(d);
    }
  });

  it('has a boolean switch for every key of DEFAULTS.features, and no others', () => {
    const switches = REGISTRY.filter((e) => e.name.startsWith('features.'));
    expect(switches.map((e) => e.name.slice('features.'.length)).sort()).toEqual(Object.keys(DEFAULTS.features).sort());
    for (const e of switches.filter((x) => x.name !== 'features.jiraCommentDetail')) {
      expect(e).toMatchObject({ type: 'boolean', group: 'features' });
      expect(e.applies).toBe(e.name === 'features.keepAwake' ? 'next-run' : 'next-story');
    }
    expect(findSetting('features.jiraCommentDetail')).toMatchObject({ type: 'enum', values: ['summary', 'full'], default: 'summary', applies: 'next-story', group: 'features', label: 'Comment detail' });
    expect(findSetting('features.followUpsOfFollowUps').default).toBe(false);
    expect(findSetting('features.followUps').default).toBe(true);
    expect(findSetting('features.autoApplyDependsOn')).toMatchObject({ type: 'boolean', group: 'features', default: false, label: 'Apply depends_on proposals' });
    expect(findSetting('features.autoCreateFollowUps')).toMatchObject({ type: 'boolean', group: 'features', default: false, label: 'Create follow-ups without asking' });
  });

  it('lists the typed settings of the spec, in their groups', () => {
    const groupOf = Object.fromEntries(REGISTRY.map((e) => [e.name, e.group]));
    expect(groupOf).toMatchObject({
      workers: 'run',
      slots: 'run',
      rounds: 'run',
      'watchdog.quietMinutes': 'run',
      'watchdog.buildMinutes': 'run',
      'claude.fallback': 'run',
      'ship.ci.timeoutMinutes': 'release',
      'ship.ci.settleSeconds': 'release',
      'ship.deploy-github.timeoutMinutes': 'release',
      'ship.watch.minutes': 'release',
      'ship.watch.everySeconds': 'release',
      'ship.smoke.urls': 'release',
      'ship.pr.into': 'release',
      'ship.merge.keepBranch': 'release',
      'stories.jql': 'jira',
      'stories.pollSeconds': 'jira',
      'stories.ownerLabel': 'jira',
      'stories.transitions': 'jira',
      'notify.to': 'notify',
      'console.port': 'console',
      'console.host': 'console',
      'learning.auto': 'learning',
      'learning.apply': 'learning',
      'learning.model': 'learning',
      'learning.skillModel': 'learning',
      'learning.window': 'learning',
      'learning.maxPerRole': 'learning',
      'learning.maxSkills': 'learning',
      'learning.maxEvaluating': 'learning',
      'learning.maxPerDay': 'learning',
      'learning.maxUsdPerDay': 'learning',
      'learning.redact': 'learning',
    });
    expect(findSetting('slots').applies).toBe('restart');
    expect(findSetting('console.port').applies).toBe('restart');
    expect(findSetting('workers').applies).toBe('next-story');
  });

  it('has the story session\u2019s own model, unset by default, in the models group', () => {
    expect(findSetting('session.model')).toMatchObject({ type: 'enum', values: ['haiku', 'sonnet', 'opus', 'fable'], default: null, applies: 'next-story', group: 'models', unset: 'The Claude CLI default' });
  });

  it('has what sessions do when the Console key runs out of credit', () => {
    expect(findSetting('claude.fallback')).toMatchObject({ type: 'enum', values: ['subscription', 'none'], default: 'subscription', applies: 'next-story', group: 'run', label: 'When credits run out' });
    expect(findSetting('claude.fallback').default).toBe(DEFAULTS.claude.fallback);
  });

  it('has how many full test runs may go at once, unset by default', () => {
    expect(findSetting('checkRuns.maxParallel')).toMatchObject({ type: 'integer', min: 1, max: 64, default: null, applies: 'next-story', group: 'run' });
  });

  it('has the learning settings, each read before the next story, with their types and limits', () => {
    const learning = REGISTRY.filter((e) => e.group === 'learning');
    expect(learning.map((e) => e.name)).toEqual(Object.keys(DEFAULTS.learning).map((k) => `learning.${k}`));
    for (const e of learning) expect(e, e.name).toMatchObject({ applies: 'next-story', default: DEFAULTS.learning[e.name.slice('learning.'.length)] });
    for (const e of learning) expect(e.when, e.name).toBeUndefined();
    expect(findSetting('learning.auto')).toMatchObject({ type: 'boolean', default: true });
    expect(findSetting('learning.apply')).toMatchObject({ type: 'boolean', default: true });
    expect(findSetting('learning.model')).toMatchObject({ type: 'enum', values: ['haiku', 'sonnet', 'opus'], default: 'haiku' });
    expect(findSetting('learning.skillModel')).toMatchObject({ type: 'enum', values: ['haiku', 'sonnet', 'opus'], default: 'sonnet' });
    expect(findSetting('learning.window')).toMatchObject({ type: 'integer', min: 3, default: 5 });
    for (const key of ['maxPerRole', 'maxSkills', 'maxEvaluating', 'maxPerDay']) expect(findSetting(`learning.${key}`), key).toMatchObject({ type: 'integer', min: 0 });
    expect(findSetting('learning.maxUsdPerDay')).toMatchObject({ type: 'number', min: 0, default: 2 });
    expect(findSetting('learning.maxUsdPerDay').above).toBeUndefined();
    expect(findSetting('learning.redact')).toMatchObject({ type: 'string[]', default: [] });
  });

  it('refuses an unknown learner model, a short window and negative caps', () => {
    expect(checkValue(findSetting('learning.model'), 'gpt-4')).toBe('must be one of haiku, sonnet, opus');
    expect(checkValue(findSetting('learning.skillModel'), 'claude')).toBe('must be one of haiku, sonnet, opus');
    expect(checkValue(findSetting('learning.window'), 2)).toBe('must be a whole number of at least 3');
    expect(checkValue(findSetting('learning.window'), 3)).toBeNull();
    expect(checkValue(findSetting('learning.maxPerDay'), -1)).toBe('must be a whole number of at least 0');
    expect(checkValue(findSetting('learning.maxPerDay'), 0)).toBeNull();
    expect(checkValue(findSetting('learning.maxUsdPerDay'), -1)).toBe('must be a number of at least 0');
    expect(checkValue(findSetting('learning.maxUsdPerDay'), 0)).toBeNull();
    expect(checkValue(findSetting('learning.redact'), ['acme', ''])).toBe('expected a list of non-empty text');
  });

  it('has the pull request target and keep-the-branch settings, unset by default', () => {
    expect(findSetting('ship.pr.into')).toMatchObject({ type: 'string', default: null, applies: 'next-story' });
    expect(findSetting('ship.merge.keepBranch')).toMatchObject({ type: 'boolean', default: false, applies: 'next-story' });
  });

  // The description is served as the settings hint by plugin/lib/dashboard/help.mjs (settingHelp), and help.test.mjs caps every hint at 100 characters.
  it('keeps every description within the dashboard hint limit: at most 100 characters', () => {
    for (const e of REGISTRY) expect(e.description.length, e.name).toBeLessThanOrEqual(100);
  });

  it('writes every description without semicolons', () => {
    for (const e of REGISTRY) expect(e.description, e.name).not.toContain(';');
  });

  it('writes every description as a complete sentence ending in a full stop', () => {
    for (const e of REGISTRY) {
      expect(e.description, e.name).toBe(e.description.trim());
      expect(e.description, e.name).toMatch(/^[A-Z0-9`]/);
      expect(e.description, e.name).toMatch(/[^.]\.$/);
    }
    expect(findSetting('features.jiraComments').description).toBe('Posts Foreman\'s notes as comments on the Jira issue.');
  });

  it('describes the CI settle time as checks staying finished, and says why the settle exists', () => {
    const { description } = findSetting('ship.ci.settleSeconds');
    expect(description).not.toContain('appear before it trusts');
    expect(description).toContain('stay finished');
    expect(description).toContain('so a fast check cannot pass before the real CI');
  });

  it('describes the build limit as the stop event does: stage change, agent start, end or step, and the 4 times ceiling', () => {
    const { description } = findSetting('watchdog.buildMinutes');
    expect(description).toContain('no stage change');
    expect(description).toContain('agent start, end or step');
    expect(description).toContain('4 times');
    expect(description).not.toContain('agent finishing');
  });

  it('describes watch and rollback in a finished sentence', () => {
    const { description } = findSetting('features.watchRollback');
    expect(description.endsWith('set up.')).toBe(true);
    expect(description.endsWith('rollback steps.')).toBe(false);
  });

  it('finds an entry by name, and nothing for an unknown or inherited name', () => {
    expect(findSetting('rounds').type).toBe('integer');
    expect(findSetting('nope')).toBeNull();
    expect(findSetting('toString')).toBeNull();
  });
});

describe('shown: settings that apply only to some projects', () => {
  it('shows the Jira settings only when the story source is Jira', () => {
    for (const name of ['stories.jql', 'stories.pollSeconds', 'stories.ownerLabel', 'stories.transitions']) {
      expect(shown(findSetting(name), min()), name).toBe(false);
      expect(shown(findSetting(name), jira()), name).toBe(true);
    }
  });
  it('shows notify.to only for the email notifier, console.* only for the dashboard, ship.watch.* only with a watch block', () => {
    expect(shown(findSetting('notify.to'), min())).toBe(false);
    expect(shown(findSetting('notify.to'), { ...min(), notify: { adapter: 'email-resend' } })).toBe(true);
    expect(shown(findSetting('console.port'), min())).toBe(true);
    expect(shown(findSetting('console.host'), { ...min(), console: { adapter: 'artifacts' } })).toBe(false);
    expect(shown(findSetting('ship.watch.minutes'), min())).toBe(false);
    expect(shown(findSetting('ship.watch.minutes'), { ...min(), ship: { steps: ['watch'], watch: { command: 'x' } } })).toBe(true);
  });
  it('shows everything else always', () => {
    expect(shown(findSetting('features.jiraComments'), min())).toBe(true);
    expect(shown(findSetting('ship.smoke.urls'), min())).toBe(true);
    expect(shown(findSetting('ship.pr.into'), min())).toBe(true);
    expect(shown(findSetting('ship.merge.keepBranch'), min())).toBe(true);
  });
});

describe('checkValue: each type and its limits', () => {
  const entry = (extra) => ({ name: 't', label: 't', description: 't', applies: 'next-story', group: 'run', secret: false, default: null, ...extra });
  it('boolean', () => {
    expect(checkValue(entry({ type: 'boolean' }), true)).toBeNull();
    expect(checkValue(entry({ type: 'boolean' }), 'true')).toBe('expected true or false');
  });
  it('integer, with min and max (max may depend on the config)', () => {
    const e = entry({ type: 'integer', min: 1, max: 10 });
    expect(checkValue(e, 1)).toBeNull();
    expect(checkValue(e, 10)).toBeNull();
    for (const bad of [0, 11, 1.5, '2', NaN]) expect(checkValue(e, bad)).toBe('must be a whole number from 1 to 10');
    expect(checkValue(entry({ type: 'integer', min: 0 }), -1)).toBe('must be a whole number of at least 0');
    expect(checkValue(findSetting('workers'), 3, { ...min(), slots: 2 })).toBe('must be a whole number from 1 to 2');
    expect(checkValue(findSetting('workers'), 2, { ...min(), slots: 2 })).toBeNull();
  });
  it('number, with a lower bound that the value must be above', () => {
    const e = entry({ type: 'number', above: 0 });
    expect(checkValue(e, 0.5)).toBeNull();
    for (const bad of [0, -1, Infinity, '3']) expect(checkValue(e, bad)).toBe('must be a number above 0');
  });
  it('string: non-empty text', () => {
    expect(checkValue(entry({ type: 'string' }), 'a')).toBeNull();
    expect(checkValue(entry({ type: 'string' }), '')).toBe('expected non-empty text');
    expect(checkValue(entry({ type: 'string' }), 3)).toBe('expected non-empty text');
  });
  it('string[]: a list of non-empty text', () => {
    expect(checkValue(entry({ type: 'string[]' }), [])).toBeNull();
    expect(checkValue(entry({ type: 'string[]' }), ['a', 'b'])).toBeNull();
    expect(checkValue(entry({ type: 'string[]' }), 'a')).toBe('expected a list of non-empty text');
    expect(checkValue(entry({ type: 'string[]' }), ['a', ''])).toBe('expected a list of non-empty text');
  });
  it('enum: one of the allowed values', () => {
    const e = entry({ type: 'enum', values: ['merge', 'squash'] });
    expect(checkValue(e, 'squash')).toBeNull();
    expect(checkValue(e, 'rebase')).toBe('must be one of merge, squash');
  });
  it('map: an object of non-empty text, with only the allowed keys', () => {
    const e = findSetting('stories.transitions');
    expect(checkValue(e, {})).toBeNull();
    expect(checkValue(e, { started: 'In Progress', shipped: 'Done' })).toBeNull();
    expect(checkValue(e, { start: 'In Progress' })).toBe('unknown key start (use started, blocked, review, failed, shipped)');
    expect(checkValue(e, { started: '' })).toBe('started: expected non-empty text');
    expect(checkValue(e, ['x'])).toBe('expected an object');
    expect(checkValue(entry({ type: 'map' }), { anything: 'goes' })).toBeNull();
  });
  it('a setting with its own check applies it after the type: ship.pr.into must be a branch name', () => {
    const e = findSetting('ship.pr.into');
    for (const ok of ['qa', 'env/qa', 'release-1.2']) expect(checkValue(e, ok), ok).toBeNull();
    for (const bad of ['-x', '--upload-pack=touch /tmp/x', 'a..b', 'qa:main', '/qa', 'qa/', 'x.lock', 'a b']) {
      expect(checkValue(e, bad), bad).toBe('expected a branch name');
    }
    expect(checkValue(e, '')).toBe('expected non-empty text');
  });
  it('ship.pr.into must not be the pack block productionBranch: nothing merges into production', () => {
    const e = findSetting('ship.pr.into');
    const sf = withDefaults({ version: 1, project: { name: 'Acme' }, pack: 'salesforce', salesforce: { productionBranch: 'main' } });
    expect(checkValue(e, 'main', sf)).toBe('must not be salesforce.productionBranch: nothing merges into production');
    expect(checkValue(e, 'qa', sf)).toBeNull();
    expect(checkValue(e, 'main', min())).toBeNull();
    expect(checkValue(e, 'main')).toBeNull();
    expect(checkValue(e, 'a..b', sf)).toBe('expected a branch name');
  });
  it('ship.pr.into accepts a salesforce block without productionBranch', () => {
    expect(checkValue(findSetting('ship.pr.into'), 'main', withDefaults(sfA()))).toBeNull();
  });
  it('null is never a value you can set', () => {
    expect(checkValue(findSetting('stories.jql'), null)).toBe('expected non-empty text');
  });
});

// The Salesforce worked examples: (a) one sandbox that builds and takes the releases, (c) two
// build sandboxes and one shared QA.
const sfA = () => ({
  version: 1,
  project: { name: 'Acme' },
  pack: 'salesforce',
  salesforce: { orgs: { 'acme-dev1': { orgId: '00D000000000001AAA' } }, build: 'acme-dev1', stages: [{ name: 'dev', org: 'acme-dev1' }] },
});
const sfC = () => ({
  version: 1,
  project: { name: 'Acme' },
  pack: 'salesforce',
  slots: 2,
  salesforce: {
    orgs: { 'acme-dev1': { orgId: '00D000000000001AAA' }, 'acme-dev2': { orgId: '00D000000000002AAA' }, 'acme-qa': { orgId: '00D000000000003AAA' } },
    build: ['acme-dev1', 'acme-dev2'],
    stages: [{ name: 'qa', org: 'acme-qa' }],
  },
});

describe('slots against the pack layout', () => {
  const slots = () => findSetting('slots');
  it('refuses slots 2 for (a), whose one sandbox also takes the releases', () => {
    expect(checkValue(slots(), 2, withDefaults(sfA()))).toMatch(/^must be at most 1: acme-dev1/);
    expect(checkValue(slots(), 1, withDefaults(sfA()))).toBeNull();
  });
  it('allows one slot per build org for (c)', () => {
    expect(checkValue(slots(), 2, withDefaults(sfC()))).toBeNull();
    expect(checkValue(slots(), 3, withDefaults(sfC()))).toMatch(/^must be at most 2/);
  });
  it('keeps the static limit without a pack', () => {
    expect(checkValue(slots(), 8, min())).toBeNull();
    expect(checkValue(slots(), 9, min())).toBe('must be a whole number from 1 to 8');
  });
});

describe('parseValue: text from the command line', () => {
  const parse = (name, text) => parseValue(findSetting(name), text);
  it('reads booleans as true/false/on/off', () => {
    expect(parse('features.followUps', 'false')).toEqual({ value: false });
    expect(parse('features.followUps', 'on')).toEqual({ value: true });
    expect(parse('features.followUps', 'maybe')).toEqual({ error: 'expected true or false' });
    expect(parse('learning.auto', 'false')).toEqual({ value: false });
  });
  it('reads numbers', () => {
    expect(parse('rounds', '4')).toEqual({ value: 4 });
    expect(parse('ship.ci.settleSeconds', '2.5')).toEqual({ value: 2.5 });
    expect(parse('rounds', 'four')).toEqual({ error: 'expected a number' });
    expect(parse('rounds', '')).toEqual({ error: 'expected a number' });
  });
  it('reads text as it is', () => expect(parse('console.host', '0.0.0.0')).toEqual({ value: '0.0.0.0' }));
  it('reads a list as JSON or comma-separated', () => {
    expect(parse('ship.smoke.urls', '["https://a.com", "https://b.com"]')).toEqual({ value: ['https://a.com', 'https://b.com'] });
    expect(parse('ship.smoke.urls', 'https://a.com, https://b.com')).toEqual({ value: ['https://a.com', 'https://b.com'] });
    expect(parse('ship.smoke.urls', '')).toEqual({ value: [] });
    expect(parse('ship.smoke.urls', '[1')).toMatchObject({ error: expect.stringContaining('JSON') });
  });
  it('reads a map as a JSON object', () => {
    expect(parse('stories.transitions', '{"started":"In Progress"}')).toEqual({ value: { started: 'In Progress' } });
    expect(parse('stories.transitions', 'started=In Progress')).toMatchObject({ error: expect.stringContaining('JSON') });
  });
});

describe('looksSecret', () => {
  it.each(['RESEND_API_KEY', 'notify.apiKey', 'jira.token', 'stories.clientSecret', 'db.password', 'aws.credentials', 'x.privateKey'])('%s looks like a secret', (n) => {
    expect(looksSecret(n)).toBe(true);
  });
  it.each(['features.followUps', 'workers', 'console.port', 'stories.ownerLabel'])('%s does not', (n) => expect(looksSecret(n)).toBe(false));
});
