import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BLOCK_DEFAULTS, BRANCH, COMMON_STEPS, OMNISTUDIO, PIPELINE_ID, ROLLBACK_COMMAND, checkConfig, defaults, fromOldShape, layout, reservedAlias, slotLimit } from './config.mjs';
import { BRANCH as CORE_BRANCH, validate } from '../../lib/config/validate.mjs';
import { withDefaults } from '../../lib/config/defaults.mjs';
import { main } from '../../lib/cli/main.mjs';
import { loadConfig } from '../../lib/config/load.mjs';

const FIXTURE = fileURLToPath(new URL('../../../test/fixtures/acme-sfdx', import.meta.url));

const ID1 = '00D000000000001AAA';
const ID2 = '00D000000000002AAA';
const ID3 = '00D000000000003AAA';
const ID4 = '00D000000000004AAA';

const COMMON = ['sf-org-guard', 'merge-main', 'sf-delta', 'push', 'pr', 'ci', 'sf-validate', 'mergeable-recheck', 'merge'];
const NO_CI = COMMON.filter((s) => s !== 'ci');
const NEVER = 'production is never a target';
const NO_ORG_ID = 'required: every org is identified by its org ID';

const file = (salesforce, rest = {}) => ({ version: 1, project: { name: 'Acme' }, pack: 'salesforce', ...rest, salesforce });

// (a) one sandbox, one branch, main is not production.
const blockA = () => ({ orgs: { 'acme-dev1': { orgId: ID1 } }, build: 'acme-dev1', stages: [{ name: 'dev', org: 'acme-dev1' }] });
// (a) with the sandbox named `alias`, read from JSON text as the config is, so even __proto__ is
// the block's own key.
const reservedBlock = (alias) => JSON.parse(`{"orgs":{${JSON.stringify(alias)}:{"orgId":"${ID1}"}},"build":${JSON.stringify(alias)},"stages":[{"name":"dev","org":${JSON.stringify(alias)}}]}`);
const RESERVED = ['__proto__', 'constructor', 'hasOwnProperty', 'toString', 'prototype'];
const RESERVED_ALIAS = 'not an org alias: __proto__, constructor, prototype and the like are reserved names';
const fileA = (slots) => file(blockA(), slots === undefined ? {} : { slots });

// (b) one build sandbox, then QA and UAT on their own branches.
const blockB = () => ({
  productionBranch: 'main',
  orgs: { 'acme-dev1': { orgId: ID1 }, 'acme-qa': { orgId: ID3 }, 'acme-uat': { orgId: ID4 } },
  build: ['acme-dev1'],
  stages: [{ name: 'qa', org: 'acme-qa', branch: 'qa' }, { name: 'uat', org: 'acme-uat', branch: 'uat' }],
});
const fileB = () => file(blockB(), { baseBranch: 'main' });

// (c) two build sandboxes, one shared QA, main only.
const blockC = () => ({
  orgs: { 'acme-dev1': { orgId: ID1 }, 'acme-dev2': { orgId: ID2 }, 'acme-qa': { orgId: ID3 } },
  build: ['acme-dev1', 'acme-dev2'],
  stages: [{ name: 'qa', org: 'acme-qa' }],
});
const fileC = () => file(blockC(), { slots: 2 });

// checkConfig on a file after `edit` changes it in place.
function check(make, edit) {
  const f = make();
  edit?.(f.salesforce, f);
  return checkConfig(f.salesforce, f);
}

describe('checkConfig: the worked examples', () => {
  it('accepts (a), (b) and (c)', () => {
    expect(checkConfig(fileA().salesforce, fileA())).toEqual([]);
    expect(checkConfig(fileA(1).salesforce, fileA(1))).toEqual([]);
    expect(checkConfig(fileB().salesforce, fileB())).toEqual([]);
    expect(checkConfig(fileC().salesforce, fileC())).toEqual([]);
  });
  it('accepts 15-character org IDs and test naming a stage', () => {
    expect(check(fileB, (b) => { b.orgs['acme-qa'].orgId = ID3.slice(0, 15); b.test = 'qa'; })).toEqual([]);
  });
  it('accepts scratch mode with a Dev Hub in orgs and a definition', () => {
    expect(check(fileC, (b, f) => {
      delete b.orgs['acme-dev1'];
      delete b.orgs['acme-dev2'];
      b.orgs['acme-hub'] = { orgId: ID4 };
      b.build = { scratch: { devHub: 'acme-hub', definition: 'config/project-scratch-def.json' } };
      delete f.slots;
    })).toEqual([]);
  });
  it('accepts release ci, and gearset with branches on every stage', () => {
    expect(check(fileB, (b) => { b.release = 'ci'; })).toEqual([]);
    expect(check(fileB, (b) => { b.release = 'gearset'; })).toEqual([]);
  });
});

describe('defaults: the exact steps', () => {
  it('(a) deploys to dev after the merge, PRs into main', () => {
    expect(defaults(blockA()).ship).toEqual({ steps: [...COMMON, 'sf-deploy-dev', 'sf-verify-dev'], ci: { required: [] }, rollback: { command: 'foreman sf rollback "$FOREMAN_STORY"', timeoutSeconds: 3600 } });
  });
  it('(b) deploys qa then uat, PRs into qa and keeps the branch', () => {
    expect(defaults(blockB()).ship).toEqual({
      steps: [...COMMON, 'sf-deploy-qa', 'sf-verify-qa', 'sf-deploy-uat', 'sf-verify-uat'],
      ci: { required: [] },
      pr: { into: 'qa' },
      merge: { keepBranch: true },
      rollback: { command: 'foreman sf rollback "$FOREMAN_STORY"', timeoutSeconds: 3600 },
    });
  });
  it('(c) deploys qa, PRs into main', () => {
    expect(defaults(blockC()).ship).toEqual({ steps: [...COMMON, 'sf-deploy-qa', 'sf-verify-qa'], ci: { required: [] }, rollback: { command: 'foreman sf rollback "$FOREMAN_STORY"', timeoutSeconds: 3600 } });
  });
  it('(b) with release ci watches each stage deploy', () => {
    expect(defaults({ ...blockB(), release: 'ci' }).ship.steps).toEqual([...COMMON, 'ci-deploy-watch-qa', 'ci-deploy-watch-uat']);
  });
  it('(b) with release gearset follows the promotion PR in place of pr, ci, mergeable-recheck and merge, and keeps the branch', () => {
    const ship = defaults({ ...blockB(), release: 'gearset' }).ship;
    expect(ship.steps).toEqual(['sf-org-guard', 'merge-main', 'sf-delta', 'push', 'gearset-pr', 'sf-validate', 'gearset-promote-qa', 'gearset-promote-uat']);
    for (const step of ['pr', 'ci', 'mergeable-recheck', 'merge']) expect(ship.steps).not.toContain(step);
    expect(ship.merge).toEqual({ keepBranch: true });
    expect(ship.pr).toEqual({ into: 'qa' });
  });
  it('(b) with release gearset and stopAt qa promotes qa only', () => {
    const ship = defaults({ ...blockB(), release: 'gearset', stopAt: 'qa' }).ship;
    expect(ship.steps).toEqual(['sf-org-guard', 'merge-main', 'sf-delta', 'push', 'gearset-pr', 'sf-validate', 'gearset-promote-qa']);
    expect(ship.merge).toEqual({ keepBranch: true });
  });
  it('(b) with stopAt qa stops after sf-verify-qa and does not keep the branch', () => {
    const ship = defaults({ ...blockB(), stopAt: 'qa' }).ship;
    expect(ship.steps).toEqual([...COMMON, 'sf-deploy-qa', 'sf-verify-qa']);
    expect(ship).not.toHaveProperty('merge');
    expect(ship.rollback).toEqual({ command: 'foreman sf rollback "$FOREMAN_STORY"', timeoutSeconds: 3600 });
  });
  it('rolls back with foreman sf rollback only on the sf path with a stage, quoting the story id', () => {
    expect(ROLLBACK_COMMAND).toBe('foreman sf rollback "$FOREMAN_STORY"');
    expect(defaults({ ...blockB(), release: 'ci' }).ship).not.toHaveProperty('rollback');
    expect(defaults({ ...blockB(), release: 'gearset' }).ship).not.toHaveProperty('rollback');
    expect(defaults(undefined).ship).not.toHaveProperty('rollback');
    expect(defaults({ stages: [{ name: '$(rm -rf /)' }] }).ship).not.toHaveProperty('rollback');
  });
  it('exports the common steps', () => {
    expect(COMMON_STEPS).toEqual(COMMON);
  });
  it('uses stage names only while they are valid', () => {
    const block = { ...blockB(), stages: [{ name: 'qa', org: 'acme-qa' }, { name: 'U-A-T', org: 'acme-uat' }, { name: 'uat', org: 'acme-uat' }] };
    expect(defaults(block).ship.steps).toEqual([...COMMON, 'sf-deploy-qa', 'sf-verify-qa']);
    expect(defaults({ stages: [{ name: '$(rm -rf /)' }] }).ship.steps).toEqual(COMMON);
  });
  it('sets no target for a stage 1 branch that is not a branch name', () => {
    expect(defaults({ stages: [{ name: 'qa', branch: '-x' }] }).ship).not.toHaveProperty('pr');
  });
});

describe('layout', () => {
  it('gives the PR target for (a), (b) and (c)', () => {
    expect(layout(blockA(), fileA()).prInto).toBe('main');
    expect(layout(blockB(), fileB()).prInto).toBe('qa');
    expect(layout(blockC(), fileC()).prInto).toBe('main');
  });
  it('maps a slot to its build org', () => {
    const l = layout(blockC(), fileC());
    expect(l.slotOrg(2)).toEqual({ alias: 'acme-dev2', orgId: ID2 });
    expect(l.slotOrg('w2')).toEqual({ alias: 'acme-dev2', orgId: ID2 });
    expect(l.slotOrg('w1')).toEqual({ alias: 'acme-dev1', orgId: ID1 });
    expect(l.slotOrg(3)).toBeNull();
    expect(l.slotOrg('x1')).toBeNull();
    expect(l.slotOrg(0)).toBeNull();
  });
  it('gives no slot org in scratch mode, or for a build alias not in orgs', () => {
    const scratch = { ...blockC(), build: { scratch: { devHub: 'acme-qa', definition: 'd.json' } } };
    const l = layout(scratch);
    expect(l.slotOrg(1)).toBeNull();
    expect(l.build).toEqual({ mode: 'scratch', aliases: [], devHub: 'acme-qa', definition: 'd.json' });
    expect(layout({ ...blockC(), build: ['acme-none'] }).slotOrg(1)).toBeNull();
  });
  it('resolves (a): one shared stage that follows main', () => {
    const l = layout(blockA(), fileA());
    expect(l.orgs).toEqual({ 'acme-dev1': { orgId: ID1 } });
    expect(l.build).toEqual({ mode: 'pool', aliases: ['acme-dev1'] });
    expect(l.stages).toEqual([{ name: 'dev', org: 'acme-dev1', orgId: ID1, branch: 'main', follows: true, shared: true }]);
    expect(l.productionBranch).toBeNull();
    expect(l.stopAt).toBe('dev');
  });
  it('resolves (b): uat has its own branch', () => {
    const l = layout(blockB(), fileB());
    expect(l.stages[1]).toEqual({ name: 'uat', org: 'acme-uat', orgId: ID4, branch: 'uat', follows: false, shared: false });
    expect(l.productionBranch).toBe('main');
  });
  it('lets a stage without a branch follow the previous one', () => {
    const block = blockB();
    delete block.stages[1].branch;
    expect(layout(block, fileB()).stages[1]).toMatchObject({ branch: 'qa', follows: true });
  });
  it('defaults stopAt to the last stage, and keeps a valid one', () => {
    expect(layout(blockB()).stopAt).toBe('uat');
    expect(layout({ ...blockB(), stopAt: 'qa' }).stopAt).toBe('qa');
    expect(layout({ ...blockB(), stopAt: 'prod' }).stopAt).toBe('uat');
    expect(layout({}).stopAt).toBeNull();
  });
  it('gives the test org for a test stage, and none for build', () => {
    expect(layout(blockB()).test).toEqual({ stage: null, org: null, orgId: null });
    expect(layout({ ...blockB(), test: 'build' }).test).toEqual({ stage: null, org: null, orgId: null });
    expect(layout({ ...blockB(), test: 'qa' }).test).toEqual({ stage: 'qa', org: 'acme-qa', orgId: ID3 });
  });
  it('takes the PR target from ship.pr.into, then baseBranch, when stage 1 has no branch', () => {
    expect(layout(blockC(), { ...fileC(), ship: { pr: { into: 'develop' } } }).prInto).toBe('develop');
    expect(layout(blockC(), { ...fileC(), baseBranch: 'trunk' }).prInto).toBe('trunk');
  });
  it('never takes a reserved name as an org, so the orgs keep their prototype and methods', () => {
    const proto = reservedBlock('__proto__');
    expect(Object.hasOwn(proto.orgs, '__proto__')).toBe(true);
    const l = layout(proto, file(proto));
    expect(Object.getPrototypeOf(l.orgs)).toBe(Object.prototype);
    expect(Object.hasOwn(l.orgs, '__proto__')).toBe(false);
    expect(l.slotOrg(1)).toBeNull();
    expect(l.stages[0].orgId).toBeNull();
    const ctor = layout(reservedBlock('constructor'));
    expect(Object.hasOwn(ctor.orgs, 'constructor')).toBe(false);
    expect(ctor.slotOrg(1)).toBeNull();
    for (const alias of RESERVED) expect(reservedAlias(alias), alias).toBe(true);
    expect(reservedAlias('acme-dev1')).toBe(false);
    expect(reservedAlias(5)).toBe(false);
    expect(reservedAlias(undefined)).toBe(false);
  });
  it.each([[undefined], [null], [5], ['x'], [[]], [{ orgs: 5, build: 7, stages: 'x' }], [{ orgs: { a: null }, build: [null, 3], stages: [null, { name: 3 }] }]])(
    'does not throw on %j',
    (block) => {
      expect(() => layout(block, { ship: 5 })).not.toThrow();
      expect(() => layout(block, null).slotOrg('w1')).not.toThrow();
    },
  );
});

describe('slotLimit', () => {
  it('is 1 for (a), whose build org also takes the releases', () => {
    expect(slotLimit(blockA())).toEqual({ max: 1, why: 'acme-dev1 builds and also takes the dev releases, so one story at a time' });
  });
  it('is the build count for (c)', () => {
    expect(slotLimit(blockC())).toEqual({ max: 2, why: 'one slot per build org' });
  });
  it('is null in scratch mode or for junk', () => {
    expect(slotLimit({ ...blockC(), build: { scratch: { devHub: 'acme-qa', definition: 'd.json' } } })).toBeNull();
    expect(slotLimit(undefined)).toBeNull();
    expect(slotLimit(5)).toBeNull();
  });
});

describe('checkConfig: refused, one rule each', () => {
  const PR_INTO = (b) => ({ path: 'productionBranch', message: `pull requests would merge into ${b}, the production branch; set salesforce.stages[0].branch or ship.pr.into to another branch` });

  it('1. a shared org with slots 2', () => {
    const errors = checkConfig(fileA(2).salesforce, fileA(2));
    expect(errors).toContainEqual({ path: 'stages[0].org', message: 'acme-dev1 is a build org: then build must be only acme-dev1 and slots 1' });
    expect(errors).toContainEqual({ path: 'build', message: 'slots is 2 but there are only 1 build orgs: each slot needs its own' });
  });
  it('2. a shared org with two build orgs', () => {
    expect(check(fileA, (b) => { b.orgs['acme-dev2'] = { orgId: ID2 }; b.build = ['acme-dev1', 'acme-dev2']; })).toEqual([
      { path: 'stages[0].org', message: 'acme-dev1 is a build org: then build must be only acme-dev1 and slots 1' },
    ]);
  });
  it("3. a stage org that is another slot's build org", () => {
    expect(check(fileC, (b) => { b.stages.push({ name: 'uat', org: 'acme-dev2' }); })).toEqual([
      { path: 'stages[1].org', message: 'only the first stage may use a build org' },
    ]);
  });
  it('4. duplicate org IDs, in the 18- or 15-character form', () => {
    const same = { path: 'orgs.acme-uat.orgId', message: 'same org as acme-qa: list each org once' };
    expect(check(fileB, (b) => { b.orgs['acme-uat'].orgId = ID3; })).toEqual([same]);
    expect(check(fileB, (b) => { b.orgs['acme-uat'].orgId = ID3.slice(0, 15); })).toEqual([same]);
  });
  it.each(['prod', 'Production'])('5. an org alias %j', (alias) => {
    const errors = check(fileB, (b) => { b.orgs[alias] = { orgId: ID2 }; });
    expect(errors).toEqual([{ path: `orgs.${alias}`, message: expect.stringContaining(NEVER) }]);
  });
  it.each(['prod', 'production'])('5. a stage named %j', (name) => {
    const errors = check(fileB, (b) => { b.stages[0].name = name; });
    expect(errors).toEqual([{ path: 'stages[0].name', message: expect.stringContaining(NEVER) }]);
  });
  it('6. stopAt naming no stage', () => {
    expect(check(fileB, (b) => { b.stopAt = 'staging'; })).toEqual([
      { path: 'stopAt', message: `must name a stage (qa, uat); ${NEVER}` },
    ]);
    expect(check(fileB, (b) => { b.stopAt = 'production'; })).toEqual([{ path: 'stopAt', message: expect.stringContaining(NEVER) }]);
  });
  it('7. stage branches without productionBranch', () => {
    expect(check(fileB, (b) => { delete b.productionBranch; })).toEqual([
      { path: 'productionBranch', message: 'required when a stage has its own branch or release is "gearset"' },
    ]);
  });
  it('8. gearset with a shared org', () => {
    expect(check(fileA, (b) => { b.stages[0].branch = 'dev'; b.productionBranch = 'release'; b.release = 'gearset'; })).toEqual([
      { path: 'stages[0].org', message: 'release "gearset" needs a stage org that is not a build org' },
    ]);
  });
  it('8. gearset without productionBranch', () => {
    expect(check(fileC, (b, f) => { b.release = 'gearset'; b.stages[0].branch = 'qa'; f.slots = 1; })).toEqual([
      { path: 'productionBranch', message: 'required when a stage has its own branch or release is "gearset"' },
    ]);
  });
  it('9. gearset with a stage without a branch', () => {
    expect(check(fileB, (b) => { delete b.stages[1].branch; b.release = 'gearset'; })).toEqual([
      { path: 'stages[1].branch', message: 'required for release "gearset"' },
    ]);
  });
  it('10. the PR target equal to productionBranch', () => {
    expect(check(fileC, (b) => { b.productionBranch = 'main'; })).toEqual([PR_INTO('main')]);
  });
  it('10. a stage branch equal to productionBranch', () => {
    expect(check(fileB, (b) => { b.stages[1].branch = 'main'; })).toContainEqual({
      path: 'stages[1].branch', message: 'must not be productionBranch: nothing merges into production',
    });
  });
});

describe('checkConfig: the org the stories come from', () => {
  const stories = (org, rest = {}) => ({ stories: { adapter: 'salesforce', org, where: 'IsClosed = false', ...rest } });
  // (a) with a second sandbox that only holds the Cases.
  const withCases = (edit) => {
    const f = file(blockA(), stories('acme-cases'));
    f.salesforce.orgs['acme-cases'] = { orgId: ID2 };
    edit?.(f.salesforce, f);
    return f;
  };
  const run = (f) => checkConfig(f.salesforce, f);

  it('does not call an org that only holds the stories unused', () => {
    expect(run(withCases())).toEqual([]);
  });
  it('still calls an org unused when the stories come from another source', () => {
    const f = withCases();
    f.stories = { adapter: 'markdown', dir: 'stories' };
    expect(run(f)).toEqual([{ path: 'orgs.acme-cases', message: 'no step uses acme-cases: list only the build orgs, the stage orgs and the scratch dev hub' }]);
  });
  it('accepts the stories org being a build org', () => {
    expect(run(file(blockA(), stories('acme-dev1')))).toEqual([]);
  });
  it('refuses a stories org that is not in orgs', () => {
    expect(run(file(blockA(), stories('acme-cases')))).toEqual([{ path: 'orgs', message: 'stories.org acme-cases is not in salesforce.orgs: add it with its org ID' }]);
  });
  it('refuses a stories org marked production', () => {
    const errors = run(withCases((b) => { b.orgs['acme-cases'].production = true; }));
    expect(errors).toEqual([{ path: 'orgs', message: `stories.org acme-cases is a production org; ${NEVER}` }]);
  });
  it('refuses a stories org named prod or production', () => {
    for (const alias of ['prod', 'production', 'Production']) {
      const errors = run(file(blockA(), stories(alias)));
      expect(errors.map((e) => e.message), alias).toContain(`stories.org ${alias} is a production org; ${NEVER}`);
    }
  });
  it('checks nothing about stories for another adapter, or without a file', () => {
    expect(checkConfig(blockA(), file(blockA(), { stories: { adapter: 'jira', site: 'acme.atlassian.net', jql: 'x', org: 'zzz' } }))).toEqual([]);
    expect(checkConfig(blockA())).toEqual([]);
    expect(run(file(blockA(), { stories: { adapter: 'salesforce' } }))).toEqual([]);
  });
  it('is checked through validate too, as an error under salesforce', () => {
    const errors = validate(file(blockA(), stories('acme-cases')));
    expect(errors).toContainEqual({ path: 'salesforce.orgs', message: 'stories.org acme-cases is not in salesforce.orgs: add it with its org ID' });
  });
});

describe('checkConfig: every org is used', () => {
  const unused = (alias) => ({ path: `orgs.${alias}`, message: `no step uses ${alias}: list only the build orgs, the stage orgs and the scratch dev hub` });
  const scratch = (b, f) => {
    b.orgs['acme-hub'] = { orgId: ID4 };
    b.build = { scratch: { devHub: 'acme-hub', definition: 'd.json' } };
    delete f.slots;
  };
  const noUnusedNoise = (errors) => expect(errors.filter((e) => e.message.startsWith('no step uses'))).toEqual([]);

  it('refuses an org no step uses in pool mode', () => {
    expect(check(fileC, (b) => { b.orgs['acme-uat'] = { orgId: ID4 }; })).toEqual([unused('acme-uat')]);
  });
  it('refuses the old build orgs left in orgs in scratch mode', () => {
    expect(check(fileC, scratch)).toEqual([unused('acme-dev1'), unused('acme-dev2')]);
  });
  it('counts the scratch dev hub as used', () => {
    expect(check(fileC, (b, f) => {
      scratch(b, f);
      delete b.orgs['acme-dev1'];
      delete b.orgs['acme-dev2'];
    })).toEqual([]);
  });
  it('counts a stage org as used, also when test names that stage', () => {
    expect(check(fileB, (b) => { b.test = 'qa'; })).toEqual([]);
  });
  it('says nothing about unused orgs when build or stages are broken', () => {
    noUnusedNoise(check(fileC, (b, f) => { b.build = 5; delete f.slots; }));
    noUnusedNoise(check(fileC, (b) => { delete b.stages; }));
  });
  it('does not report a production alias twice', () => {
    const errors = check(fileB, (b) => { b.orgs.prod = { orgId: ID2 }; });
    expect(errors.filter((e) => e.path === 'orgs.prod')).toHaveLength(1);
    noUnusedNoise(errors);
  });
});

describe('checkConfig: production is never a target', () => {
  it('refuses a stage on the scratch dev hub', () => {
    const errors = check(fileC, (b, f) => {
      b.orgs = { 'acme-qa': { orgId: ID3 } };
      b.build = { scratch: { devHub: 'acme-qa', definition: 'd.json' } };
      delete f.slots;
    });
    expect(errors).toEqual([{ path: 'stages[0].org', message: 'acme-qa is the scratch dev hub, often a production org; production is never a target' }]);
    expect(errors[0].message.endsWith(NEVER)).toBe(true);
  });
  it('still lets stage 1 use a build org in pool mode', () => {
    expect(checkConfig(fileA().salesforce, fileA())).toEqual([]);
    expect(checkConfig(fileB().salesforce, fileB())).toEqual([]);
    expect(checkConfig(fileC().salesforce, fileC())).toEqual([]);
  });
});

describe('checkConfig: a production org, marked "production": true', () => {
  const MAIN_ID = '00D000000000005AAA';
  const BUILD = 'acme-main is a production org; production is never a build org';
  const STAGE = 'acme-main is a production org; deployments to production are blocked';
  const addMain = (b) => { b.orgs['acme-main'] = { orgId: MAIN_ID, production: true }; };

  it('accepts it as the scratch dev hub', () => {
    expect(check(fileC, (b, f) => {
      b.orgs = { 'acme-qa': { orgId: ID3 } };
      addMain(b);
      b.build = { scratch: { devHub: 'acme-main', definition: 'config/project-scratch-def.json' } };
      delete f.slots;
    })).toEqual([]);
  });
  it('accepts it when no step uses it: it is only read from', () => {
    expect(check(fileB, addMain)).toEqual([]);
  });
  it('refuses a production value that is not true or false', () => {
    const errors = check(fileB, (b) => { b.orgs['acme-main'] = { orgId: MAIN_ID, production: 'yes' }; });
    expect(errors).toContainEqual({ path: 'orgs.acme-main.production', message: 'expected true or false' });
    expect(check(fileB, (b) => { b.orgs['acme-dev1'].production = false; })).toEqual([]);
  });
  it('refuses it as a build org, alone or in a pool', () => {
    expect(check(fileB, (b) => { addMain(b); b.build = 'acme-main'; })).toEqual([{ path: 'build', message: BUILD }]);
    expect(check(fileB, (b) => { addMain(b); b.build = ['acme-dev1', 'acme-main']; })).toEqual([{ path: 'build[1]', message: BUILD }]);
  });
  it("refuses it as a stage's org", () => {
    expect(check(fileB, (b) => { addMain(b); b.stages[1].org = 'acme-main'; delete b.orgs['acme-uat']; })).toEqual([{ path: 'stages[1].org', message: STAGE }]);
  });
  it('refuses it as the test org: test names a stage, so the same stage rule holds', () => {
    expect(check(fileB, (b) => {
      addMain(b);
      b.stages[0].org = 'acme-main';
      delete b.orgs['acme-qa'];
      b.test = 'qa';
    })).toEqual([{ path: 'stages[0].org', message: STAGE }]);
  });
  it('says production before "same org as stage" and before the scratch dev hub rule', () => {
    expect(check(fileB, (b) => { addMain(b); b.stages[0].org = 'acme-main'; b.stages[1].org = 'acme-main'; })).toContainEqual({ path: 'stages[1].org', message: STAGE });
    expect(check(fileC, (b, f) => {
      b.orgs = { 'acme-qa': { orgId: ID3 } };
      addMain(b);
      b.build = { scratch: { devHub: 'acme-main', definition: 'd.json' } };
      b.stages[0].org = 'acme-main';
      delete f.slots;
    })).toContainEqual({ path: 'stages[0].org', message: STAGE });
  });
  it('layout carries production: true on the marked org only', () => {
    const block = blockB();
    addMain(block);
    expect(layout(block).orgs).toEqual({
      'acme-dev1': { orgId: ID1 },
      'acme-qa': { orgId: ID3 },
      'acme-uat': { orgId: ID4 },
      'acme-main': { orgId: MAIN_ID, production: true },
    });
    expect(layout({ ...blockB(), orgs: { ...blockB().orgs, 'acme-main': { orgId: MAIN_ID, production: 'yes' } } }).orgs['acme-main']).toEqual({ orgId: MAIN_ID });
  });
});

describe('checkConfig: the effective PR target', () => {
  const PR_INTO = (b) => ({ path: 'productionBranch', message: `pull requests would merge into ${b}, the production branch; set salesforce.stages[0].branch or ship.pr.into to another branch` });

  it("refuses a file whose own ship has no pr.into: the pack's target is replaced", () => {
    expect(check(fileB, (b, f) => { f.ship = { steps: ['merge-main', 'push', 'pr'] }; })).toEqual([PR_INTO('main')]);
  });
  it('refuses ship.pr.into main, once', () => {
    expect(check(fileC, (b, f) => { b.productionBranch = 'main'; f.ship = { steps: ['pr'], pr: { into: 'main' } }; })).toEqual([PR_INTO('main')]);
  });
  it('accepts a file whose own ship targets another branch', () => {
    expect(check(fileB, (b, f) => { f.ship = { steps: ['merge-main', 'push', 'pr'], pr: { into: 'qa' } }; })).toEqual([]);
  });
  it('falls back to main when the file has no baseBranch', () => {
    expect(check(fileB, (b, f) => { delete f.baseBranch; f.ship = { steps: ['pr'] }; })).toEqual([PR_INTO('main')]);
    expect(check(fileB, (b, f) => { delete f.baseBranch; f.ship = { steps: ['pr'] }; b.productionBranch = 'release'; })).toEqual([]);
  });
  it('uses baseBranch when it is not main', () => {
    expect(check(fileB, (b, f) => { f.baseBranch = 'release'; b.productionBranch = 'release'; f.ship = { steps: ['pr'] }; })).toEqual([PR_INTO('release')]);
  });
  it('skips the target check without a file, and does not throw', () => {
    const block = blockC();
    block.productionBranch = 'main';
    expect(checkConfig(block, undefined)).toEqual([]);
  });
});

describe('checkConfig: aliases, stages and keys', () => {
  it.each(RESERVED)('refuses the reserved name %s as an org alias', (alias) => {
    const block = reservedBlock(alias);
    expect(Object.hasOwn(block.orgs, alias)).toBe(true);
    expect(checkConfig(block, file(block))).toContainEqual({ path: `orgs.${alias}`, message: RESERVED_ALIAS });
    // The same block with an ordinary name passes.
    expect(checkConfig(fileA().salesforce, fileA())).toEqual([]);
  });
  it.each([
    ['build', (b) => { b.build = 'acme-none'; }],
    ['build[1]', (b) => { b.build = ['acme-dev1', 'acme-none']; }],
    ['stages[0].org', (b) => { b.stages[0].org = 'acme-none'; }],
    ['build.scratch.devHub', (b, f) => { b.build = { scratch: { devHub: 'acme-none', definition: 'd.json' } }; delete f.slots; }],
  ])('refuses an alias not in orgs at %s', (path, edit) => {
    expect(check(fileC, edit)).toContainEqual({ path, message: 'acme-none is not in orgs' });
  });
  it('refuses a build alias listed twice', () => {
    expect(check(fileC, (b) => { b.build = ['acme-dev1', 'acme-dev2', 'acme-dev1']; })).toEqual([
      { path: 'build[2]', message: 'acme-dev1 is listed twice' },
    ]);
  });
  it('refuses an empty build list, and a build of another shape', () => {
    expect(check(fileC, (b, f) => { b.build = []; delete f.slots; })).toContainEqual({ path: 'build', message: 'must not be empty' });
    expect(check(fileC, (b, f) => { b.build = 5; delete f.slots; })).toContainEqual({ path: 'build', message: expect.stringMatching(/^expected an org alias/) });
  });
  it('requires a scratch devHub and definition, and no other keys', () => {
    expect(check(fileC, (b, f) => { b.build = { scratch: {} }; delete f.slots; })).toEqual([
      { path: 'build.scratch.devHub', message: 'required' },
      { path: 'build.scratch.definition', message: 'required' },
    ]);
    expect(check(fileC, (b, f) => { b.build = { pool: [] }; delete f.slots; })).toContainEqual({ path: 'build.pool', message: 'unknown key' });
  });
  it('refuses slots above the build orgs in pool mode only', () => {
    expect(check(fileC, (b, f) => { f.slots = 3; })).toEqual([
      { path: 'build', message: 'slots is 3 but there are only 2 build orgs: each slot needs its own' },
    ]);
    expect(check(fileC, (b, f) => {
      delete b.orgs['acme-dev1'];
      delete b.orgs['acme-dev2'];
      b.orgs['acme-hub'] = { orgId: ID4 };
      b.build = { scratch: { devHub: 'acme-hub', definition: 'd.json' } };
      f.slots = 4;
    })).toEqual([]);
  });
  it('refuses two stages on one org', () => {
    expect(check(fileB, (b) => { b.stages[1].org = 'acme-qa'; })).toEqual([
      { path: 'stages[1].org', message: 'same org as stage qa: give each stage its own org' },
    ]);
  });
  it('refuses 0 or 5 stages', () => {
    expect(check(fileB, (b) => { b.stages = []; })).toContainEqual({ path: 'stages', message: 'must have 1 to 4 stages' });
    expect(check(fileB, (b) => {
      for (const n of [5, 6, 7]) b.orgs[`acme-s${n}`] = { orgId: `00D00000000000${n}AAA` };
      b.stages.push({ name: 's5', org: 'acme-s5', branch: 's5' }, { name: 's6', org: 'acme-s6', branch: 's6' }, { name: 's7', org: 'acme-s7', branch: 's7' });
    })).toEqual([{ path: 'stages', message: 'must have 1 to 4 stages' }]);
  });
  it('requires stages, build and orgs', () => {
    expect(check(fileC, (b) => { delete b.stages; })).toContainEqual({ path: 'stages', message: 'required' });
    expect(check(fileC, (b) => { delete b.build; })).toContainEqual({ path: 'build', message: 'required' });
    expect(check(fileC, (b) => { delete b.orgs; })).toContainEqual({ path: 'orgs', message: 'required' });
    expect(check(fileC, (b) => { b.orgs = {}; })).toContainEqual({ path: 'orgs', message: 'must not be empty' });
  });
  it.each(['QA', '1qa', 'qa-1', 'a'.repeat(17), 7])('refuses stage name %j', (name) => {
    expect(check(fileB, (b) => { b.stages[0].name = name; })).toContainEqual({ path: 'stages[0].name', message: expect.stringMatching(/^expected a stage name/) });
  });
  it('refuses a stage name used twice', () => {
    expect(check(fileB, (b) => { b.stages[1].name = 'qa'; })).toEqual([{ path: 'stages[1].name', message: 'qa is used twice' }]);
  });
  it('refuses a stage branch that is not a branch name', () => {
    expect(check(fileB, (b) => { b.stages[1].branch = 'a..b'; })).toEqual([{ path: 'stages[1].branch', message: 'expected a branch name' }]);
  });
  it('refuses test naming no stage', () => {
    expect(check(fileB, (b) => { b.test = 'nope'; })).toEqual([{ path: 'test', message: 'must be "build" or a stage name (qa, uat)' }]);
  });
  it('refuses an unknown stage key, and an unknown org key', () => {
    expect(check(fileB, (b) => { b.stages[0].alias = 'x'; })).toEqual([{ path: 'stages[0].alias', message: 'unknown key' }]);
    expect(check(fileB, (b) => { b.orgs['acme-qa'].branch = 'qa'; })).toEqual([{ path: 'orgs.acme-qa.branch', message: 'unknown key' }]);
  });
  it('requires an org ID, and refuses one that is not an org ID', () => {
    expect(check(fileB, (b) => { delete b.orgs['acme-qa'].orgId; })).toEqual([{ path: 'orgs.acme-qa.orgId', message: NO_ORG_ID }]);
    for (const v of ['12345', '005000000000001AAA', '00D00000000000', 42]) {
      expect(check(fileB, (b) => { b.orgs['acme-qa'].orgId = v; }), String(v)).toEqual([
        { path: 'orgs.acme-qa.orgId', message: 'expected a Salesforce org ID (00D…, 15 or 18 characters)' },
      ]);
    }
  });
  it.each(['-o', 'a b'])('refuses alias %j', (alias) => {
    expect(check(fileC, (b) => { b.orgs[alias] = { orgId: ID4 }; })).toEqual([
      { path: `orgs.${alias}`, message: expect.stringMatching(/^expected an org alias/) },
    ]);
  });
  it('refuses a block-level production key', () => {
    expect(check(fileB, (b) => { b.production = { orgId: ID1 }; })).toEqual([{ path: 'production', message: 'unknown key' }]);
  });
  it('refuses a productionBranch that is not a branch name', () => {
    expect(check(fileB, (b) => { b.productionBranch = '-x'; })).toEqual([{ path: 'productionBranch', message: 'expected a branch name' }]);
  });
});

describe('checkConfig: the other settings', () => {
  const full = () => file({ ...blockB(), release: 'sf', testLevel: { validate: 'RunLocalTests', deploy: 'RunLocalTests' }, coverage: { floor: 75, target: 90 }, destructive: 'ask', omnistudio: 'auto', agentforce: 'auto', gearset: { promote: 'owner' }, skills: { source: 'forcedotcom/sf-skills', tag: '1.66.0' } }, { baseBranch: 'main' });

  it('accepts every setting at its documented value', () => {
    expect(check(full)).toEqual([]);
  });
  it('refuses release devops-center, saying it is not supported yet, and other values', () => {
    expect(check(full, (b) => { b.release = 'devops-center'; })).toEqual([
      { path: 'release', message: 'must be one of sf, ci, gearset (devops-center is not supported yet)' },
    ]);
    expect(check(full, (b) => { b.release = 'x'; })).toEqual([{ path: 'release', message: 'must be one of sf, ci, gearset' }]);
  });
  it('refuses testLevel NoTestRun', () => {
    expect(check(full, (b) => { b.testLevel.deploy = 'NoTestRun'; })).toEqual([
      { path: 'testLevel.deploy', message: 'must be one of RunLocalTests, RunAllTestsInOrg, RunRelevantTests' },
    ]);
  });
  it('refuses a coverage floor under 75, and a target under the floor', () => {
    expect(check(full, (b) => { b.coverage.floor = 70; })).toEqual([{ path: 'coverage.floor', message: 'must be an integer from 75 to 100' }]);
    expect(check(full, (b) => { b.coverage = { floor: 85, target: 80 }; })).toEqual([{ path: 'coverage.target', message: 'must be an integer from 85 to 100' }]);
    expect(check(full, (b) => { b.coverage = { floor: 80.5 }; })).toEqual([{ path: 'coverage.floor', message: 'must be an integer from 75 to 100' }]);
  });
  it.each([
    ['destructive', (b) => { b.destructive = 'yes'; }, 'must be one of ask, allow'],
    ['omnistudio', (b) => { b.omnistudio = 'datapacks'; }, 'must be one of auto, standard, managed, off (datapacks is not supported yet)'],
    ['agentforce', (b) => { b.agentforce = 'on'; }, 'must be one of auto, off'],
    ['gearset.promote', (b) => { b.gearset.promote = 'auto'; }, 'must be one of owner, merge'],
  ])('refuses a %s outside its list', (path, edit, message) => {
    expect(check(full, edit)).toEqual([{ path, message }]);
  });
  it.each([
    ['testLevel', (b) => { b.testLevel.run = 'RunLocalTests'; }],
    ['coverage', (b) => { b.coverage.max = 100; }],
    ['skills', (b) => { b.skills.ref = 'x'; }],
    ['gearset', (b) => { b.gearset.token = 'x'; }],
  ])('refuses an unknown key in %s', (path, edit) => {
    expect(check(full, edit)).toEqual([{ path: expect.stringMatching(new RegExp(`^${path}\\.[a-z]+$`)), message: 'unknown key' }]);
  });
  it('takes an optional gearset.pipelineId, a Gearset pipeline ID', () => {
    expect(check(full, (b) => { b.gearset.pipelineId = 'pipe-1'; })).toEqual([]);
    expect(check(full, (b) => { b.gearset.pipelineId = '3f2a9c1e-0b4d-4e8a-9a51-6c2d7e8f9a10'; })).toEqual([]);
    for (const bad of ['', 'a b', '../x', 'x'.repeat(101), 5, null]) {
      expect(check(full, (b) => { b.gearset.pipelineId = bad; }), String(bad)).toEqual([{ path: 'gearset.pipelineId', message: 'expected a Gearset pipeline ID' }]);
    }
    expect(check(full, (b) => { b.gearset = { pipelineId: 'pipe-1', other: 1 }; })).toEqual([{ path: 'gearset.other', message: 'unknown key' }]);
  });
  it('gives no default pipelineId', () => {
    expect(PIPELINE_ID.test('pipe-1')).toBe(true);
    expect(BLOCK_DEFAULTS.gearset).toEqual({ promote: 'merge' });
    expect(defaults({ ...blockB(), release: 'gearset' }).salesforce.gearset).toEqual({ promote: 'merge' });
  });
  it('refuses empty skills strings', () => {
    expect(check(full, (b) => { b.skills.tag = ''; })).toEqual([{ path: 'skills.tag', message: 'expected non-empty string' }]);
  });
  it.each([[undefined, 'required: the salesforce block (orgs, build, stages)'], [5, 'expected object'], [[], 'expected object'], [null, 'expected object']])(
    'reports block %j at the block itself, without throwing',
    (block, message) => {
      expect(checkConfig(block, fileB())).toEqual([{ path: '', message }]);
    },
  );
  it('does not throw on junk inside the block', () => {
    const junk = [
      { orgs: { a: 5, b: null, c: [] }, build: { scratch: 5 }, stages: [null, 5, { name: 3, org: [] }], testLevel: 'x', coverage: 3, gearset: [], skills: 'x', test: 4, stopAt: {} },
      { orgs: [], build: [null, {}], stages: {}, productionBranch: 5, release: 'gearset' },
    ];
    for (const block of junk) {
      expect(() => checkConfig(block, { ship: 5, slots: 'x' })).not.toThrow();
      expect(() => checkConfig(block, { ship: { pr: 5 } })).not.toThrow();
    }
  });
});

describe('checkConfig: sf-org-guard runs before any real Salesforce run', () => {
  const GUARD = (name) => `ship.steps runs ${name} without sf-org-guard ahead of it; put sf-org-guard first: it checks every org is an allow-listed sandbox, and production is never a target`;
  const withShip = (ship) => file(blockA(), { ship });
  const guardErrors = (f) => checkConfig(f.salesforce, f).filter((e) => e.message.includes('sf-org-guard'));

  it.each([
    ['no guard before a hand-written deploy', ['sf-delta', 'push', 'pr', 'ci', 'merge', 'sf-deploy-dev'], 'sf-deploy-dev'],
    ['the guard after sf-validate', ['sf-delta', 'sf-validate', 'sf-org-guard', 'merge', 'sf-deploy-dev'], 'sf-validate'],
    ['sf-validate alone, with no guard', ['merge-main', 'sf-delta', 'sf-validate'], 'sf-validate'],
  ])('refuses %s', (_, steps, name) => {
    const f = withShip({ steps });
    expect(guardErrors(f)).toEqual([{ path: '', message: GUARD(name) }]);
    expect(GUARD(name)).toContain(name);
  });

  it.each([
    ['the pack steps', [...COMMON_STEPS, 'sf-deploy-dev', 'sf-verify-dev']],
    ['a guard ahead of the deploy, not first', ['merge-main', 'sf-org-guard', 'sf-delta', 'sf-deploy-dev']],
    ['no Salesforce run at all', ['merge-main', 'push', 'pr', 'ci', 'merge']],
  ])('accepts %s', (_, steps) => {
    expect(guardErrors(withShip({ steps }))).toEqual([]);
  });

  it('accepts a file with no ship of its own: the pack steps start with sf-org-guard', () => {
    expect(checkConfig(fileA().salesforce, fileA())).toEqual([]);
  });

  it('does not throw on an odd ship', () => {
    for (const ship of [5, { steps: 'x' }, { steps: [5, null, 'sf-deploy-dev'] }]) {
      expect(() => checkConfig(blockA(), { ship })).not.toThrow();
    }
    expect(guardErrors(withShip(5))).toEqual([]);
    expect(guardErrors(withShip({ steps: 'x' }))).toEqual([]);
  });
});

describe('the old shape', () => {
  // The spec's old §3 sample, with the IDs above.
  const OLD_SAMPLE = () => ({
    productionBranch: 'main',
    orgs: {
      build: { mode: 'sandbox-pool', pool: [{ alias: 'acme-dev1', orgId: ID1 }] },
      qa: { alias: 'acme-qa', orgId: ID3, branch: 'qa' },
      uat: { alias: 'acme-uat', orgId: ID4, branch: 'uat' },
    },
    stopAt: 'qa',
    release: 'sf',
    testLevel: { validate: 'RunLocalTests', deploy: 'RunLocalTests' },
    coverage: { floor: 75, target: 90 },
    destructive: 'ask',
    omnistudio: 'auto',
    agentforce: 'auto',
    gearset: { promote: 'owner' },
    skills: { source: 'forcedotcom/sf-skills', tag: '1.66.0' },
  });

  it('converts to (b), keeping stopAt qa because qa was the old default', () => {
    const { orgs, stopAt, ...rest } = OLD_SAMPLE();
    expect(fromOldShape(OLD_SAMPLE())).toEqual({ ...blockB(), ...rest, stopAt: 'qa' });
  });
  it('writes stopAt qa when uat was there without one, and none without uat', () => {
    const old = OLD_SAMPLE();
    delete old.stopAt;
    expect(fromOldShape(old).stopAt).toBe('qa');
    delete old.orgs.uat;
    expect(fromOldShape(old)).not.toHaveProperty('stopAt');
    expect(fromOldShape(old).stages).toEqual([{ name: 'qa', org: 'acme-qa', branch: 'qa' }]);
  });
  it('converts scratch mode', () => {
    const old = OLD_SAMPLE();
    old.orgs.build = { mode: 'scratch', devHub: { alias: 'acme-hub', orgId: ID2 }, definition: 'config/project-scratch-def.json' };
    const out = fromOldShape(old);
    expect(out.build).toEqual({ scratch: { devHub: 'acme-hub', definition: 'config/project-scratch-def.json' } });
    expect(out.orgs).toEqual({ 'acme-hub': { orgId: ID2 }, 'acme-qa': { orgId: ID3 }, 'acme-uat': { orgId: ID4 } });
  });
  it('never throws', () => {
    for (const block of [undefined, null, 5, { orgs: 5 }, { orgs: { build: { pool: [null, 3] }, qa: 5 } }]) {
      expect(() => fromOldShape(block)).not.toThrow();
    }
  });
  it('is refused with one error holding the converted block', () => {
    const errors = checkConfig(OLD_SAMPLE());
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe('');
    expect(errors[0].message).toContain('old shape');
    expect(errors[0].message).toContain(JSON.stringify(fromOldShape(OLD_SAMPLE()), null, 2));
  });
  it('gives validate() a single salesforce error', () => {
    const errors = validate(file(OLD_SAMPLE(), { baseBranch: 'main' }));
    expect(errors).toEqual([{ path: 'salesforce', message: expect.stringContaining('old shape') }]);
  });
});

describe('defaults: the rest of the config', () => {
  it('gives the common steps, the Salesforce roles and the block defaults for no block', () => {
    const d = defaults(undefined);
    expect(d.ship).toEqual({ steps: COMMON, ci: { required: [] } });
    expect(d.roles).toEqual({
      architect: { agent: 'foreman:sf-architect' },
      builders: {
        admin: { agent: 'foreman:sf-admin', use: 'declarative work only: objects, fields, Flows, validation rules, permission sets, layouts' },
        developer: { agent: 'foreman:sf-developer', use: 'any story with Apex or LWC, plus the metadata it needs' },
        agentforce: { agent: 'foreman:sf-agentforce', use: 'Agentforce: agent bundles, their actions and the Apex or Flows behind them' },
      },
      tester: { agent: 'foreman:sf-tester' },
      reviewers: [
        { name: 'compliance', agent: 'foreman:compliance-reviewer' },
        { name: 'security', agent: 'foreman:security-reviewer' },
        { name: 'code', agent: 'foreman:sf-code-reviewer' },
      ],
    });
    expect(d.install).toEqual({ run: 'npm ci', when: 'package-lock.json', creates: 'node_modules' });
    expect(d.checks).toEqual([
      { run: 'sf project deploy start --dry-run --test-level RunLocalTests --wait 60', when: '**/*.{cls,trigger,xml}' },
      { run: 'npm run lint --if-present', when: '**/{lwc,aura}/**' },
      { run: 'npm run test:unit --if-present', when: '**/lwc/**' },
    ]);
    expect(d.salesforce).toEqual(BLOCK_DEFAULTS);
    expect(d.salesforce).not.toBe(BLOCK_DEFAULTS);
    expect(BLOCK_DEFAULTS).not.toHaveProperty('stopAt');
    expect(BLOCK_DEFAULTS.test).toBe('build');
    // By default Foreman merges Gearset's promotion PR itself.
    expect(BLOCK_DEFAULTS.gearset.promote).toBe('merge');
  });
  it('lists no OmniStudio builder whatever omnistudio says, and drops Agentforce when it is off', () => {
    for (const omnistudio of OMNISTUDIO) expect(Object.keys(defaults({ omnistudio }).roles.builders), omnistudio).toEqual(['admin', 'developer', 'agentforce']);
    expect(Object.keys(defaults({ agentforce: 'off' }).roles.builders)).toEqual(['admin', 'developer']);
  });
  it('names only agents that ship under plugin/agents/', () => {
    const blocks = [undefined, ...OMNISTUDIO.map((omnistudio) => ({ omnistudio })), { agentforce: 'off' }, { release: 'gearset' }];
    for (const b of blocks) {
      const { roles } = defaults(b);
      const agents = [roles.architect, roles.tester, ...Object.values(roles.builders), ...roles.reviewers].map((r) => r.agent);
      for (const agent of agents) {
        expect(agent.startsWith('foreman:'), agent).toBe(true);
        expect(fs.existsSync(fileURLToPath(new URL(`../../agents/${agent.slice('foreman:'.length)}.md`, import.meta.url))), agent).toBe(true);
      }
    }
  });
  it('puts only a listed test level in the dry-run check', () => {
    expect(defaults({ testLevel: { validate: 'RunAllTestsInOrg' } }).checks[0].run).toBe('sf project deploy start --dry-run --test-level RunAllTestsInOrg --wait 60');
    expect(defaults({ testLevel: { validate: '$(rm -rf /)' } }).checks[0].run).toBe('sf project deploy start --dry-run --test-level RunLocalTests --wait 60');
  });
  it.each([['junk'], [5], [null], [[]], [{ release: 'devops-center', stopAt: 'prod' }], [{ orgs: 5, testLevel: 'x', stages: 5 }]])('falls back to the common steps for %j', (block) => {
    expect(defaults(block).ship.steps).toEqual(COMMON);
  });
  it('picks the sandbox-pool env adapter for build sandboxes, and scratch for scratch orgs', () => {
    expect(defaults(blockA()).env).toEqual({ adapter: 'sandbox-pool' });
    expect(defaults(blockC()).env).toEqual({ adapter: 'sandbox-pool' });
    expect(defaults({ ...blockC(), build: { scratch: { devHub: 'acme-dev1', definition: 'config/project-scratch-def.json' } } }).env).toEqual({ adapter: 'scratch' });
  });
  it("lets the project's own env block replace the pack's", () => {
    const f = fileC();
    expect(withDefaults(f).env).toEqual({ adapter: 'sandbox-pool' });
    expect(withDefaults({ ...f, env: { adapter: 'none' } }).env).toEqual({ adapter: 'none' });
  });
  it('has no check that runs always, so doctor never reaches an org', () => {
    for (const c of defaults(blockB()).checks) expect(c.when).not.toBe('always');
  });
});

describe('the branch-name rule', () => {
  it('is the core one', () => expect(BRANCH.source).toBe(CORE_BRANCH.source));
});

describe('through core config, with the real registry', () => {
  it('validates the files for (a), (b) and (c)', () => {
    expect(validate(fileA())).toEqual([]);
    expect(validate(fileB())).toEqual([]);
    expect(validate(fileC())).toEqual([]);
  });
  it('prefixes block paths with salesforce', () => {
    const f = fileB();
    delete f.salesforce.productionBranch;
    expect(validate(f)).toEqual([{ path: 'salesforce.productionBranch', message: 'required when a stage has its own branch or release is "gearset"' }]);
  });
  it('reports a missing block', () => {
    expect(validate({ ...fileB(), salesforce: undefined })).toEqual([{ path: 'salesforce', message: 'required: the salesforce block (orgs, build, stages)' }]);
  });
  it('resolves the pack defaults under the file', () => {
    const config = withDefaults(fileB());
    expect(config.roles.architect.agent).toBe('foreman:sf-architect');
    expect(config.ship.pr.into).toBe('qa');
    expect(config.salesforce.test).toBe('build');
    expect(config.salesforce.coverage).toEqual({ floor: 75, target: 90 });
    expect(config.salesforce.productionBranch).toBe('main');
  });
  it('adds no stopAt to (a)', () => {
    expect(withDefaults(fileA()).salesforce).not.toHaveProperty('stopAt');
  });
  it('lets the project win key by key in its block', () => {
    const f = fileB();
    f.salesforce.coverage = { target: 95 };
    expect(withDefaults(f).salesforce.coverage).toEqual({ floor: 75, target: 95 });
  });
  it('refuses a project ship that deploys without sf-org-guard', () => {
    const f = { ...fileA(), ship: { steps: ['merge-main', 'sf-delta', 'push', 'pr', 'ci', 'merge', 'sf-deploy-dev'] } };
    expect(validate(f)).toContainEqual({
      path: 'salesforce',
      message: 'ship.steps runs sf-deploy-dev without sf-org-guard ahead of it; put sf-org-guard first: it checks every org is an allow-listed sandbox, and production is never a target',
    });
  });
  it('lets a project ship replace the pack ship as a whole', () => {
    const ship = { steps: ['merge-main', 'push', 'pr'], pr: { into: 'qa' } };
    expect(withDefaults({ ...fileB(), ship }).ship).toEqual(ship);
  });
});

describe('foreman config show on the Acme fixture configured as (c)', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-sfshow-'));
    fs.cpSync(FIXTURE, dir, { recursive: true });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('prints the (c) steps, no ship.pr, and PRs into main', async () => {
    fs.writeFileSync(path.join(dir, 'foreman.config.json'), JSON.stringify(fileC()));
    let out = '';
    let err = '';
    const code = await main(['config', 'show'], { cwd: dir, env: {}, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } });
    expect(code, out + err).toBe(0);
    const parsed = JSON.parse(out);
    // The fixture has no workflows, so the pack leaves out ci.
    expect(parsed.ship.steps).toEqual([...NO_CI, 'sf-deploy-qa', 'sf-verify-qa']);
    expect(parsed.ship).not.toHaveProperty('pr');
    expect(parsed.baseBranch).toBe('main');
    expect(layout(parsed.salesforce, parsed).prInto).toBe('main');
  });
});

const fileA2 = (steps) => file(blockA(), { ship: { steps } });

describe('defaults: ci only when a workflow runs on pull requests into the PR target', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-sfci-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workflow = (name, text) => {
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.github', 'workflows', name), text);
  };
  const project = (extra = {}) => ({ root: dir, fs, ...extra });
  const A = [...NO_CI, 'sf-deploy-dev', 'sf-verify-dev'];

  it('leaves out ci when there is no .github/workflows', () => {
    expect(defaults(blockA(), project()).ship.steps).toEqual(A);
    expect(defaults(blockA(), project()).ship.ci).toEqual({ required: [] });
  });
  it('keeps ci when a workflow runs on pull_request', () => {
    workflow('ci.yml', 'on: pull_request\n');
    expect(defaults(blockA(), project()).ship.steps).toEqual([...COMMON, 'sf-deploy-dev', 'sf-verify-dev']);
  });
  it('leaves out ci when the only workflow runs on push', () => {
    workflow('deploy.yml', 'on:\n  push:\n    branches: [main]\n');
    expect(defaults(blockA(), project()).ship.steps).toEqual(A);
  });
  it('judges the PR target: pull_request into develop is no CI for main', () => {
    workflow('ci.yml', 'on:\n  pull_request:\n    branches: [develop]\n');
    expect(defaults(blockA(), project()).ship.steps).toEqual(A);
    expect(defaults(blockA(), project({ file: { baseBranch: 'develop' } })).ship.steps).toContain('ci');
    const staged = { ...blockA(), stages: [{ name: 'dev', org: 'acme-dev1', branch: 'develop' }], productionBranch: 'main' };
    expect(defaults(staged, project()).ship.steps).toContain('ci');
    expect(defaults(staged, project()).ship.pr).toEqual({ into: 'develop' });
  });
  it('reads the PR target from the file ship.pr.into', () => {
    workflow('ci.yml', 'on:\n  pull_request:\n    branches: [develop]\n');
    expect(defaults(blockA(), project({ file: { ship: { pr: { into: 'develop' } } } })).ship.steps).toContain('ci');
  });
  it('leaves out ci on the ci release with no workflows, and keeps the deploy watch steps', () => {
    expect(defaults({ ...blockA(), release: 'ci' }, project()).ship.steps).toEqual([...NO_CI, 'ci-deploy-watch-dev']);
  });
  it('keeps the gearset steps as they are', () => {
    const steps = defaults({ ...blockB(), release: 'gearset' }, project()).ship.steps;
    expect(steps).toEqual(['sf-org-guard', 'merge-main', 'sf-delta', 'push', 'gearset-pr', 'sf-validate', 'gearset-promote-qa', 'gearset-promote-uat']);
  });
  it('keeps ci when the workflows folder cannot be read', () => {
    const denied = { ...fs, readdirSync: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } };
    expect(defaults(blockA(), project({ fs: denied })).ship.steps).toContain('ci');
  });
  it('keeps ci when a workflow file cannot be read', () => {
    workflow('ci.yml', 'on: pull_request\n');
    const denied = { ...fs, readFileSync: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } };
    expect(defaults(blockA(), project({ fs: denied })).ship.steps).toContain('ci');
  });
  it('keeps ci with no project, or one with no root or fs', () => {
    expect(defaults(blockA()).ship.steps).toContain('ci');
    expect(defaults(blockA(), undefined).ship.steps).toContain('ci');
    expect(defaults(blockA(), { root: dir }).ship.steps).toContain('ci');
    expect(defaults(blockA(), { fs }).ship.steps).toContain('ci');
    expect(defaults(blockA(), { root: 7, fs }).ship.steps).toContain('ci');
    expect(defaults(blockA(), 'x').ship.steps).toContain('ci');
  });
  it('through withDefaults, with a project folder', () => {
    expect(withDefaults(fileA(), { project: { root: dir, fs } }).ship.steps).toEqual(A);
    expect(withDefaults(fileA()).ship.steps).toContain('ci');
  });

  describe('through loadConfig', () => {
    const writeFile = (f) => fs.writeFileSync(path.join(dir, 'foreman.config.json'), JSON.stringify(f));
    it('has no ci without workflows', () => {
      writeFile(fileA());
      const r = loadConfig(dir);
      expect(r.errors).toEqual([]);
      expect(r.config.ship.steps).toEqual(A);
    });
    it('has ci with a workflow on pull_request', () => {
      writeFile(fileA());
      workflow('ci.yml', 'on: pull_request\n');
      expect(loadConfig(dir).config.ship.steps).toEqual([...COMMON, 'sf-deploy-dev', 'sf-verify-dev']);
    });
    it('has no ci with a push-only workflow', () => {
      writeFile(fileA());
      workflow('deploy.yml', 'on: push\n');
      expect(loadConfig(dir).config.ship.steps).toEqual(A);
    });
    it("keeps a project's own ship.steps as written", () => {
      const steps = [...COMMON, 'sf-deploy-dev', 'sf-verify-dev'];
      writeFile(fileA2(steps));
      expect(loadConfig(dir).config.ship.steps).toEqual(steps);
    });
  });
});
