import { describe, expect, it } from 'vitest';
import { DEFAULTS, withDefaults } from './defaults.mjs';
import { fakePack } from '../../../test/fake-pack.mjs';

const min = () => ({ version: 1, project: { name: 'x' } });

describe('withDefaults', () => {
  it('gives the minimal file every default', () => {
    expect(withDefaults(min())).toEqual({
      version: 1,
      project: { name: 'x' },
      baseBranch: 'main',
      remote: 'origin',
      branchPrefix: 'story/',
      stateDir: '.foreman',
      envFile: '.env.local',
      foremanEnvFile: '.env.foreman',
      slots: 1,
      workers: 1,
      rounds: 3,
      install: { run: 'npm ci', when: 'package-lock.json' },
      checks: [],
      generated: [],
      fileLocks: { ignore: ['CHANGELOG.md'] },
      roles: {
        architect: { agent: 'foreman:architect' },
        builders: { developer: { agent: 'foreman:builder', use: 'everything' } },
        tester: { agent: 'foreman:tester' },
        reviewers: [
          { name: 'compliance', agent: 'foreman:compliance-reviewer' },
          { name: 'security', agent: 'foreman:security-reviewer' },
        ],
      },
      resources: {},
      stories: { adapter: 'markdown', dir: 'stories' },
      env: { adapter: 'none' },
      ship: { steps: ['merge-main', 'resources', 'push', 'pr', 'ci', 'mergeable-recheck', 'merge'], ci: { required: [] } },
      notify: { adapter: 'none' },
      console: { adapter: 'dashboard', host: '127.0.0.1', port: 4317 },
      watchdog: { quietMinutes: 30, buildMinutes: 120 },
      state: { store: 'files', branch: 'foreman-state' },
      cloud: { envVars: [], idleMinutes: 10, actions: { cron: '*/30 * * * *' } },
      features: {
        learnTraits: true,
        followUps: true,
        followUpsOfFollowUps: false,
        autoCreateFollowUps: false,
        dependsOnProposals: true,
        autoApplyDependsOn: false,
        productionGuard: true,
        watchRollback: true,
        mergeableRecheck: true,
        notifications: true,
        costMetrics: true,
        keepAwake: true,
        jiraComments: true,
        jiraCommentDetail: 'summary',
        jiraTransitions: true,
        salesforceComments: true,
        salesforceStatuses: true,
      },
      learning: { auto: true, apply: true, model: 'haiku', skillModel: 'sonnet', window: 5, maxPerRole: 8, maxSkills: 10, maxEvaluating: 2, maxPerDay: 3, maxUsdPerDay: 2, redact: [] },
      claude: { fallback: 'subscription' },
    });
  });
  it('has the Salesforce story source\'s two switches on by default', () => {
    expect(DEFAULTS.features).toMatchObject({ salesforceComments: true, salesforceStatuses: true });
    expect(withDefaults({ ...min(), features: { salesforceComments: false } }).features).toMatchObject({ salesforceComments: false, salesforceStatuses: true });
  });
  it('merges features.jiraCommentDetail like any other switch', () => {
    expect(DEFAULTS.features.jiraCommentDetail).toBe('summary');
    expect(withDefaults({ ...min(), features: { jiraCommentDetail: 'full' } }).features).toMatchObject({ jiraCommentDetail: 'full', jiraComments: true });
  });
  it("leaves CHANGELOG.md out of the file locks by default, and a project's list replaces it", () => {
    expect(DEFAULTS.fileLocks.ignore).toEqual(['CHANGELOG.md']);
    expect(withDefaults({ ...min(), fileLocks: { ignore: ['docs/**'] } }).fileLocks).toEqual({ ignore: ['docs/**'] });
  });
  it('falls back to the subscription when the platform credits run out, by default', () => {
    expect(DEFAULTS.claude.fallback).toBe('subscription');
    expect(withDefaults({ ...min(), claude: { fallback: 'none' } }).claude).toEqual({ fallback: 'none' });
  });
  it('merges features key by key, so a file that turns one off keeps the rest', () => {
    const c = withDefaults({ ...min(), features: { followUps: false } });
    expect(c.features.followUps).toBe(false);
    expect(c.features.learnTraits).toBe(true);
  });
  it('merges learning key by key, and a file\'s redact list replaces the default', () => {
    expect(withDefaults({ ...min(), learning: { auto: false } }).learning).toEqual({ auto: false, apply: true, model: 'haiku', skillModel: 'sonnet', window: 5, maxPerRole: 8, maxSkills: 10, maxEvaluating: 2, maxPerDay: 3, maxUsdPerDay: 2, redact: [] });
    expect(withDefaults({ ...min(), learning: { redact: ['acme'] } }).learning.redact).toEqual(['acme']);
  });
  it('never overwrites a value the file set', () => {
    const c = withDefaults({ ...min(), slots: 4, baseBranch: 'trunk', watchdog: { quietMinutes: 5 } });
    expect(c.slots).toBe(4);
    expect(c.baseBranch).toBe('trunk');
    expect(c.watchdog).toEqual({ quietMinutes: 5, buildMinutes: 120 });
  });
  it('keeps falsy values the file set', () => {
    const c = withDefaults({ ...min(), features: { keepAwake: false }, install: null });
    expect(c.features.keepAwake).toBe(false);
    expect(c.install).toBeNull();
  });
  it('reads the old top-level keepAwake as features.keepAwake, and drops the old key', () => {
    const c = withDefaults({ ...min(), keepAwake: false });
    expect(c.features.keepAwake).toBe(false);
    expect(c.features.followUps).toBe(true);
    expect(Object.hasOwn(c, 'keepAwake')).toBe(false);
  });
  it('lets features.keepAwake win over the old top-level keepAwake', () => {
    expect(withDefaults({ ...min(), keepAwake: false, features: { keepAwake: true } }).features.keepAwake).toBe(true);
    expect(withDefaults({ ...min(), keepAwake: true, features: { keepAwake: false } }).features.keepAwake).toBe(false);
  });
  it('replaces arrays instead of merging them', () => {
    const c = withDefaults({ ...min(), ship: { steps: ['pr'] }, roles: { reviewers: [{ name: 'a', agent: 'b' }] } });
    expect(c.ship.steps).toEqual(['pr']);
    expect(c.roles.reviewers).toEqual([{ name: 'a', agent: 'b' }]);
  });
  it('replaces roles.builders as a whole', () => {
    const c = withDefaults({ ...min(), roles: { builders: { ui: { agent: 'u', use: 'ui' } } } });
    expect(Object.keys(c.roles.builders)).toEqual(['ui']);
    expect(c.roles.tester).toEqual({ agent: 'foreman:tester' });
  });
  it('replaces resources and adapter blocks as a whole', () => {
    const c = withDefaults({ ...min(), ship: { steps: ['pr'] }, resources: { schema: { paths: ['a'], describe: 'd' } }, stories: { adapter: 'obsidian' }, console: { adapter: 'dashboard' } });
    expect(c.resources).toEqual({ schema: { paths: ['a'], describe: 'd' } });
    expect(c.stories).toEqual({ adapter: 'obsidian' });
    expect(c.stories.dir).toBeUndefined();
    expect(c.console).toEqual({ adapter: 'dashboard' });
    expect(c.ship).toEqual({ steps: ['pr'] });
  });
  it('does not mutate the input or share structure with DEFAULTS', () => {
    const raw = min();
    const c = withDefaults(raw);
    expect(raw).toEqual(min());
    c.roles.builders.developer.use = 'changed';
    c.ship.steps.push('x');
    expect(DEFAULTS.roles.builders.developer.use).toBe('everything');
    expect(DEFAULTS.ship.steps).toHaveLength(7);
  });
  it('ignores __proto__ keys from parsed JSON', () => {
    const raw = JSON.parse('{"version":1,"project":{"name":"x"},"roles":{"__proto__":{"evil":1}}}');
    const c = withDefaults(raw);
    expect(c.roles.evil).toBeUndefined();
    expect(Object.getPrototypeOf(c.roles)).toBe(Object.prototype);
    expect(Object.hasOwn(c.roles, '__proto__')).toBe(false);
  });
  it('freezes DEFAULTS deeply', () => {
    expect(Object.isFrozen(DEFAULTS)).toBe(true);
    expect(Object.isFrozen(DEFAULTS.roles.builders.developer)).toBe(true);
    expect(Object.isFrozen(DEFAULTS.ship.steps)).toBe(true);
  });
});

// A fuller project file without `pack`: what it resolves to must not change when packs arrive.
const fuller = () => ({
  version: 1,
  project: { name: 'Acme' },
  keepAwake: false,
  stories: { adapter: 'jira', site: 'acme.atlassian.net', jql: 'project = ACME ORDER BY Rank', transitions: { started: 'In Progress', shipped: 'Done' } },
  ship: { steps: ['merge-main', 'push', 'pr', 'ci', 'mergeable-recheck', 'merge'], ci: { required: ['unit'] } },
  roles: {
    builders: { web: { agent: 'acme:web-builder', use: 'the web app' } },
    reviewers: [{ name: 'acme-style', agent: 'acme:style-reviewer' }],
  },
  features: { followUps: false },
});

describe('withDefaults: a project without pack', () => {
  it('resolves the minimal file as it always has', () => {
    expect(withDefaults({ version: 1, project: { name: 'Acme' } })).toMatchInlineSnapshot(`
      {
        "baseBranch": "main",
        "branchPrefix": "story/",
        "checks": [],
        "claude": {
          "fallback": "subscription",
        },
        "cloud": {
          "actions": {
            "cron": "*/30 * * * *",
          },
          "envVars": [],
          "idleMinutes": 10,
        },
        "console": {
          "adapter": "dashboard",
          "host": "127.0.0.1",
          "port": 4317,
        },
        "env": {
          "adapter": "none",
        },
        "envFile": ".env.local",
        "features": {
          "autoApplyDependsOn": false,
          "autoCreateFollowUps": false,
          "costMetrics": true,
          "dependsOnProposals": true,
          "followUps": true,
          "followUpsOfFollowUps": false,
          "jiraCommentDetail": "summary",
          "jiraComments": true,
          "jiraTransitions": true,
          "keepAwake": true,
          "learnTraits": true,
          "mergeableRecheck": true,
          "notifications": true,
          "productionGuard": true,
          "salesforceComments": true,
          "salesforceStatuses": true,
          "watchRollback": true,
        },
        "fileLocks": {
          "ignore": [
            "CHANGELOG.md",
          ],
        },
        "foremanEnvFile": ".env.foreman",
        "generated": [],
        "install": {
          "run": "npm ci",
          "when": "package-lock.json",
        },
        "learning": {
          "apply": true,
          "auto": true,
          "maxEvaluating": 2,
          "maxPerDay": 3,
          "maxPerRole": 8,
          "maxSkills": 10,
          "maxUsdPerDay": 2,
          "model": "haiku",
          "redact": [],
          "skillModel": "sonnet",
          "window": 5,
        },
        "notify": {
          "adapter": "none",
        },
        "project": {
          "name": "Acme",
        },
        "remote": "origin",
        "resources": {},
        "roles": {
          "architect": {
            "agent": "foreman:architect",
          },
          "builders": {
            "developer": {
              "agent": "foreman:builder",
              "use": "everything",
            },
          },
          "reviewers": [
            {
              "agent": "foreman:compliance-reviewer",
              "name": "compliance",
            },
            {
              "agent": "foreman:security-reviewer",
              "name": "security",
            },
          ],
          "tester": {
            "agent": "foreman:tester",
          },
        },
        "rounds": 3,
        "ship": {
          "ci": {
            "required": [],
          },
          "steps": [
            "merge-main",
            "resources",
            "push",
            "pr",
            "ci",
            "mergeable-recheck",
            "merge",
          ],
        },
        "slots": 1,
        "state": {
          "branch": "foreman-state",
          "store": "files",
        },
        "stateDir": ".foreman",
        "stories": {
          "adapter": "markdown",
          "dir": "stories",
        },
        "version": 1,
        "watchdog": {
          "buildMinutes": 120,
          "quietMinutes": 30,
        },
        "workers": 1,
      }
    `);
  });
  it('resolves a fuller file as it always has', () => {
    expect(withDefaults(fuller())).toMatchInlineSnapshot(`
      {
        "baseBranch": "main",
        "branchPrefix": "story/",
        "checks": [],
        "claude": {
          "fallback": "subscription",
        },
        "cloud": {
          "actions": {
            "cron": "*/30 * * * *",
          },
          "envVars": [],
          "idleMinutes": 10,
        },
        "console": {
          "adapter": "dashboard",
          "host": "127.0.0.1",
          "port": 4317,
        },
        "env": {
          "adapter": "none",
        },
        "envFile": ".env.local",
        "features": {
          "autoApplyDependsOn": false,
          "autoCreateFollowUps": false,
          "costMetrics": true,
          "dependsOnProposals": true,
          "followUps": false,
          "followUpsOfFollowUps": false,
          "jiraCommentDetail": "summary",
          "jiraComments": true,
          "jiraTransitions": true,
          "keepAwake": false,
          "learnTraits": true,
          "mergeableRecheck": true,
          "notifications": true,
          "productionGuard": true,
          "salesforceComments": true,
          "salesforceStatuses": true,
          "watchRollback": true,
        },
        "fileLocks": {
          "ignore": [
            "CHANGELOG.md",
          ],
        },
        "foremanEnvFile": ".env.foreman",
        "generated": [],
        "install": {
          "run": "npm ci",
          "when": "package-lock.json",
        },
        "learning": {
          "apply": true,
          "auto": true,
          "maxEvaluating": 2,
          "maxPerDay": 3,
          "maxPerRole": 8,
          "maxSkills": 10,
          "maxUsdPerDay": 2,
          "model": "haiku",
          "redact": [],
          "skillModel": "sonnet",
          "window": 5,
        },
        "notify": {
          "adapter": "none",
        },
        "project": {
          "name": "Acme",
        },
        "remote": "origin",
        "resources": {},
        "roles": {
          "architect": {
            "agent": "foreman:architect",
          },
          "builders": {
            "web": {
              "agent": "acme:web-builder",
              "use": "the web app",
            },
          },
          "reviewers": [
            {
              "agent": "acme:style-reviewer",
              "name": "acme-style",
            },
          ],
          "tester": {
            "agent": "foreman:tester",
          },
        },
        "rounds": 3,
        "ship": {
          "ci": {
            "required": [
              "unit",
            ],
          },
          "steps": [
            "merge-main",
            "push",
            "pr",
            "ci",
            "mergeable-recheck",
            "merge",
          ],
        },
        "slots": 1,
        "state": {
          "branch": "foreman-state",
          "store": "files",
        },
        "stateDir": ".foreman",
        "stories": {
          "adapter": "jira",
          "jql": "project = ACME ORDER BY Rank",
          "site": "acme.atlassian.net",
          "transitions": {
            "shipped": "Done",
            "started": "In Progress",
          },
        },
        "version": 1,
        "watchdog": {
          "buildMinutes": 120,
          "quietMinutes": 30,
        },
        "workers": 1,
      }
    `);
  });
  it('a registered but unselected pack changes nothing', () => {
    for (const raw of [{ version: 1, project: { name: 'Acme' } }, fuller()]) {
      expect(withDefaults(raw, { packs: { acme: fakePack() } })).toEqual(withDefaults(raw));
    }
  });
});

describe('withDefaults: pack defaults sit between Foreman and the project', () => {
  const packs = { acme: fakePack() };
  const acme = (over = {}) => ({ version: 1, project: { name: 'Acme' }, pack: 'acme', ...over });

  it('takes ship.steps and rounds from the pack when the project says nothing', () => {
    const c = withDefaults(acme(), { packs });
    expect(c.ship).toEqual({ steps: ['merge-main', 'push', 'acme-deploy'] });
    expect(c.rounds).toBe(5);
    expect(c.pack).toBe('acme');
  });
  it('lets the project value win over the pack', () => {
    expect(withDefaults(acme({ rounds: 2 }), { packs }).rounds).toBe(2);
  });
  it('lets the project ship replace the pack ship as a whole', () => {
    const withCi = fakePack({ defaults: () => ({ ship: { steps: ['merge-main', 'push', 'acme-deploy'], ci: { required: ['acme'] } } }) });
    const ship = withDefaults(acme({ ship: { steps: ['pr'] } }), { packs: { acme: withCi } }).ship;
    expect(ship).toEqual({ steps: ['pr'] });
    expect(ship).not.toHaveProperty('ci');
  });
  it('fills the rest from Foreman defaults', () => {
    const c = withDefaults(acme(), { packs });
    expect(c.remote).toBe('origin');
    expect(c.roles).toEqual(withDefaults({ version: 1, project: { name: 'Acme' } }).roles);
  });
  it('merges the pack block key by key', () => {
    expect(withDefaults(acme({ acme: { mode: 'full' } }), { packs }).acme).toEqual({ region: 'eu', mode: 'full' });
    expect(withDefaults(acme({ acme: { region: 'us' } }), { packs }).acme).toEqual({ region: 'us', mode: 'basic' });
  });
  it('gives defaults() a clone of the project block', () => {
    const seen = [];
    const pack = fakePack({ defaults: (block) => { seen.push(block); block.mode = 'changed'; return {}; } });
    const raw = acme({ acme: { mode: 'full' } });
    const c = withDefaults(raw, { packs: { acme: pack } });
    expect(seen).toEqual([{ mode: 'changed' }]);
    expect(raw.acme).toEqual({ mode: 'full' });
    expect(c.acme).toEqual({ mode: 'full' });
  });
  it('gives defaults() no project view when withDefaults has none', () => {
    const seen = [];
    const pack = fakePack({ defaults: (block, project) => { seen.push(project); return {}; } });
    withDefaults(acme(), { packs: { acme: pack } });
    expect(seen).toEqual([undefined]);
  });
  it('gives defaults() the project folder, and a copy of the raw file', () => {
    const seen = [];
    const pack = fakePack({
      defaults: (block, project) => {
        seen.push(project);
        project.file.rounds = 99;
        return {};
      },
    });
    const files = { readdirSync() {}, readFileSync() {} };
    const raw = acme({ rounds: 2 });
    const c = withDefaults(raw, { packs: { acme: pack }, project: { root: '/acme', fs: files } });
    expect(seen).toHaveLength(1);
    expect(seen[0].root).toBe('/acme');
    expect(seen[0].fs).toBe(files);
    expect(raw.rounds).toBe(2);
    expect(c.rounds).toBe(2);
  });
  it('gives defaults() no project view for a project without a root', () => {
    const seen = [];
    const pack = fakePack({ defaults: (block, project) => { seen.push(project); return {}; } });
    for (const project of [{}, { root: 7 }, null, 'x']) withDefaults(acme(), { packs: { acme: pack }, project });
    expect(seen).toEqual([undefined, undefined, undefined, undefined]);
  });
  it('works for a pack with no defaults, and for defaults() that return nothing', () => {
    const plain = withDefaults({ version: 1, project: { name: 'Acme' } });
    expect(withDefaults(acme(), { packs: { acme: fakePack({ defaults: undefined }) } })).toEqual({ ...plain, pack: 'acme' });
    expect(withDefaults(acme(), { packs: { acme: fakePack({ defaults: () => undefined }) } })).toEqual({ ...plain, pack: 'acme' });
  });
  it('lets a pack set session.extraTools, and the project list replace it', () => {
    const pack = fakePack({ defaults: () => ({ session: { extraTools: ['mcp__acme__query'] } }) });
    expect(withDefaults(acme(), { packs: { acme: pack } }).session.extraTools).toEqual(['mcp__acme__query']);
    const own = withDefaults(acme({ session: { extraTools: ['mcp__acme__other'] } }), { packs: { acme: pack } });
    expect(own.session.extraTools).toEqual(['mcp__acme__other']);
  });
  it('gives the minimal file no session key', () => {
    expect(withDefaults({ version: 1, project: { name: 'Acme' } })).not.toHaveProperty('session');
  });
  it('shares no objects with DEFAULTS', () => {
    const c = withDefaults(acme(), { packs });
    c.roles.builders.developer.use = 'changed';
    c.install.run = 'changed';
    c.features.followUps = false;
    expect(DEFAULTS.roles.builders.developer.use).toBe('everything');
    expect(DEFAULTS.install.run).toBe('npm ci');
    expect(DEFAULTS.features.followUps).toBe(true);
  });
});
