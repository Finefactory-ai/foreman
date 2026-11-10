import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pack, { detect, doctorChecks } from './pack.mjs';
import { COMMON_STEPS, checkConfig, defaults, slotLimit } from './config.mjs';
import { doctorChecks as groupChecks } from './doctor-salesforce.mjs';
import { setUp } from './isolation.mjs';
import * as scratchEnv from './env/scratch.mjs';
import { PACKS } from '../index.mjs';
import { detect as coreDetect } from '../../lib/engine/init-helpers.mjs';
import { makeInitCommand } from '../../lib/cli/commands/init.mjs';
import { makeShipCommand } from '../../lib/cli/commands/ship.mjs';
import { onFailureFor, stepTableFor, stepsFor } from '../../lib/adapters/ship/registry.mjs';
import { withDefaults } from '../../lib/config/defaults.mjs';
import { runShip } from '../../lib/engine/ship.mjs';
import sfOrgGuard from './steps/sf-org-guard.mjs';
import sfDelta from './steps/sf-delta.mjs';
import sfValidate from './steps/sf-validate.mjs';
import { sfDeploy } from './steps/sf-deploy.mjs';
import { sfVerify } from './steps/sf-verify.mjs';
import { ciDeployWatch } from './steps/ci-deploy-watch.mjs';
import gearsetPr from './steps/gearset-pr.mjs';
import { gearsetPromote } from './steps/gearset-promote.mjs';
import { fakeCtx, fakeSh } from '../../../test/ship-fakes.mjs';
import { ACME_DEV1_ID, ACME_QA_ID, ACME_UAT_ID, sfOk } from '../../../test/fake-sf.mjs';

// The pack's steps for a project with no workflow on pull requests, such as the Acme fixture.
const NO_CI_STEPS = COMMON_STEPS.filter((name) => name !== 'ci');

const FIXTURE = fileURLToPath(new URL('../../../test/fixtures/acme-sfdx', import.meta.url));
const NONE = { jest: false, eslint: false, prettier: false };

describe('detect on the Acme fixture', () => {
  it('reports its package folders, API version, LWC tools, OmniStudio and Agentforce', () => {
    expect(detect(FIXTURE)).toEqual({
      packageDirectories: [{ path: 'force-app', default: true }],
      sourceApiVersion: '62.0',
      lwc: { jest: true, eslint: true, prettier: true },
      omnistudio: true,
      agentforce: true,
    });
  });
});

describe('detect on other projects', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-sfdetect-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  const project = (dirs = [{ path: 'force-app' }]) => write('sfdx-project.json', JSON.stringify({ packageDirectories: dirs }));

  it('does not claim a project without sfdx-project.json', () => {
    write('package.json', '{"devDependencies":{"eslint":"9"}}');
    expect(detect(dir)).toBeNull();
  });
  it('claims a bare project, with no LWC tools and no OmniStudio or Agentforce', () => {
    project();
    expect(detect(dir)).toEqual({
      packageDirectories: [{ path: 'force-app', default: false }],
      sourceApiVersion: null,
      lwc: NONE,
      omnistudio: false,
      agentforce: false,
    });
  });
  it('still claims a project whose sfdx-project.json does not parse', () => {
    write('sfdx-project.json', '{ not json');
    let found;
    expect(() => { found = detect(dir); }).not.toThrow();
    expect(found).toMatchObject({ packageDirectories: [], sourceApiVersion: null, lwc: NONE, omnistudio: false, agentforce: false });
    expect(found.invalid).toEqual(expect.any(String));
  });
  it('claims an sfdx-project.json that is not an object, and says so', () => {
    write('sfdx-project.json', '[]');
    expect(detect(dir)).toMatchObject({ packageDirectories: [], invalid: expect.any(String) });
  });
  it('ignores a package folder that is missing, and still reads the others', () => {
    project([{ path: 'gone' }, { path: 'force-app' }]);
    write('force-app/main/default/bots/Acme_Bot/Acme_Bot.bot-meta.xml', '<Bot/>');
    expect(detect(dir)).toMatchObject({ agentforce: true, omnistudio: false });
  });
  it('does not count an OmniStudio folder inside node_modules or a dot-folder', () => {
    project([{ path: '.' }]);
    write('node_modules/x/omniScripts/a.os-meta.xml', '<x/>');
    write('.sf/omniUiCard/a.xml', '<x/>');
    expect(detect(dir).omnistudio).toBe(false);
  });
  it('finds each OmniStudio and Agentforce folder name', () => {
    for (const name of ['omniScripts', 'omniIntegrationProcedures', 'omniDataTransforms', 'omniUiCard']) {
      fs.rmSync(dir, { recursive: true, force: true });
      project();
      write(`force-app/main/default/${name}/a.xml`, '<x/>');
      expect(detect(dir), name).toMatchObject({ omnistudio: true, agentforce: false });
    }
    for (const name of ['aiAuthoringBundles', 'bots', 'genAiPlannerBundles', 'genAiPlugins', 'genAiFunctions']) {
      fs.rmSync(dir, { recursive: true, force: true });
      project();
      write(`force-app/main/default/${name}/a.xml`, '<x/>');
      expect(detect(dir), name).toMatchObject({ omnistudio: false, agentforce: true });
    }
  });
  it('reads LWC tools from dependencies and scripts', () => {
    project();
    write('package.json', JSON.stringify({ dependencies: { '@salesforce/eslint-config-lwc': '3' }, scripts: { test: 'sfdx-lwc-jest --coverage' } }));
    expect(detect(dir).lwc).toEqual({ jest: true, eslint: true, prettier: false });
  });
  it('reads no LWC tools from a package.json that does not parse', () => {
    project();
    write('package.json', '{ nope');
    expect(detect(dir).lwc).toEqual(NONE);
  });
  it('gives only JSON-safe findings', () => {
    project();
    const found = detect(dir);
    expect(JSON.parse(JSON.stringify(found))).toEqual(found);
  });

  // A sibling folder outside the project, holding an Agentforce and an OmniStudio folder.
  const outside = () => {
    const name = `${path.basename(dir)}-outside`;
    const abs = path.join(dir, '..', name);
    fs.mkdirSync(path.join(abs, 'omniScripts', 'bots'), { recursive: true });
    return { name, abs };
  };
  it('ignores a package folder that climbs out of the project with ../', () => {
    const out = outside();
    try {
      project([{ path: `../${out.name}` }, { path: 'force-app' }]);
      const found = detect(dir);
      expect(found.omnistudio).toBe(false);
      expect(found.agentforce).toBe(false);
      expect(found.packageDirectories).toEqual([{ path: 'force-app', default: false }]);
    } finally {
      fs.rmSync(out.abs, { recursive: true, force: true });
    }
  });
  it('drops every package folder outside the project, and does not throw', () => {
    const escaping = ['../..', '../../..', os.tmpdir(), 'force-app/../../x'];
    project([...escaping.map((p) => ({ path: p })), { path: 'force-app' }]);
    let found;
    expect(() => { found = detect(dir); }).not.toThrow();
    expect(found.packageDirectories).toEqual([{ path: 'force-app', default: false }]);
  });
  it('keeps package folders inside the project that look odd', () => {
    project([{ path: './force-app' }, { path: 'force-app/../force-app' }, { path: '..acme' }]);
    write('..acme/main/default/omniScripts/a.xml', '<x/>');
    const found = detect(dir);
    expect(found.packageDirectories.map((d) => d.path)).toEqual(['./force-app', 'force-app/../force-app', '..acme']);
    expect(found.omnistudio).toBe(true);
  });
  it('does not read through a package folder that links outside the project', () => {
    const out = outside();
    try {
      fs.symlinkSync(out.abs, path.join(dir, 'linked'));
      project([{ path: 'linked' }]);
      const found = detect(dir);
      expect(found.agentforce).toBe(false);
      expect(found.omnistudio).toBe(false);
    } finally {
      fs.rmSync(out.abs, { recursive: true, force: true });
    }
  });
});

describe('the pack', () => {
  it('is named salesforce and registered under that name', () => {
    expect(pack.name).toBe('salesforce');
    expect(PACKS.salesforce).toBe(pack);
    expect(pack.detect).toBe(detect);
    expect(pack.defaults).toBe(defaults);
    expect(pack.checkConfig).toBe(checkConfig);
    expect(pack.slotLimit).toBe(slotLimit);
    expect(pack.doctorChecks).toBe(doctorChecks);
    expect(doctorChecks).toBe(groupChecks);
  });
  it('prepares the story sessions with the isolated sf home', () => {
    expect(pack.prepareSessions).toBe(setUp);
  });
  it('offers the sandbox-pool and scratch slot environments', () => {
    expect(Object.keys(pack.envAdapters)).toEqual(['sandbox-pool', 'scratch']);
    expect(pack.envAdapters.scratch).toBe(scratchEnv);
    expect(typeof pack.envAdapters.scratch.create).toBe('function');
    expect(pack.envAdapters.scratch.requires).toEqual({ env: [], tools: ['sf'] });
  });
  const LAYOUT_B = {
    productionBranch: 'main',
    orgs: { 'acme-dev1': { orgId: ACME_DEV1_ID }, 'acme-qa': { orgId: ACME_QA_ID }, 'acme-uat': { orgId: ACME_UAT_ID } },
    build: ['acme-dev1'],
    stages: [{ name: 'qa', org: 'acme-qa', branch: 'qa' }, { name: 'uat', org: 'acme-uat', branch: 'uat' }],
  };
  const COMMON = ['sf-org-guard', 'sf-delta', 'gearset-pr', 'sf-validate'];
  it('registers its ship steps from the config, with deploy and verify steps for every stage, the later ones marked noRollback, and a Gearset promotion for every stage', () => {
    const steps = pack.steps({ pack: 'salesforce', salesforce: LAYOUT_B });
    expect(Object.keys(steps)).toEqual([...COMMON, 'sf-deploy-qa', 'sf-verify-qa', 'ci-deploy-watch-qa', 'sf-deploy-uat', 'sf-verify-uat', 'ci-deploy-watch-uat', 'gearset-promote-qa', 'gearset-promote-uat']);
    expect(steps['sf-deploy-qa']).toBe(sfDeploy('qa'));
    expect(steps['sf-verify-qa']).toBe(sfVerify('qa'));
    expect(steps['ci-deploy-watch-qa']).toBe(ciDeployWatch('qa'));
    for (const name of ['sf-deploy-qa', 'sf-verify-qa', 'ci-deploy-watch-qa']) expect(steps[name]).not.toHaveProperty('noRollback');
    expect(steps['sf-deploy-uat']).toBe(sfDeploy('uat', { later: true }));
    expect(steps['sf-verify-uat']).toBe(sfVerify('uat', { later: true }));
    expect(steps['ci-deploy-watch-uat']).toBe(ciDeployWatch('uat', { later: true }));
    for (const name of ['sf-deploy-uat', 'sf-verify-uat', 'ci-deploy-watch-uat']) expect(steps[name].noRollback).toBe(true);
    expect(steps['gearset-promote-qa']).toBe(gearsetPromote('qa'));
    expect(steps['gearset-promote-uat']).toBe(gearsetPromote('uat'));
    const a = pack.steps({ salesforce: { orgs: { 'acme-dev1': { orgId: ACME_DEV1_ID } }, build: 'acme-dev1', stages: [{ name: 'dev', org: 'acme-dev1' }] } });
    expect(Object.keys(a)).toEqual([...COMMON, 'sf-deploy-dev', 'sf-verify-dev', 'ci-deploy-watch-dev', 'gearset-promote-dev']);
    expect(Object.keys(pack.steps(undefined))).toEqual(COMMON);
    expect(Object.keys(pack.steps({ salesforce: { ...LAYOUT_B, stages: [{ name: 'Not-A-Step', org: 'acme-qa' }] } }))).toEqual(COMMON);
    expect(() => pack.steps({ salesforce: 'odd' })).not.toThrow();
  });
  it('resolves the ship steps of a release "ci" config, ending with ci-deploy-watch for the stage', () => {
    const config = withDefaults({ version: 1, project: { name: 'Acme' }, pack: 'salesforce', salesforce: { ...LAYOUT_B, release: 'ci', stopAt: 'qa' } });
    const steps = stepsFor(config);
    expect(steps.at(-1)).toBe(ciDeployWatch('qa'));
    expect(steps.map((s) => s.name).at(-1)).toBe('ci-deploy-watch-qa');
  });
  it('resolves every ship step of a release "gearset" config, ending with the last promotion', () => {
    const resolve = (over) => stepsFor(withDefaults({ version: 1, project: { name: 'Acme' }, pack: 'salesforce', salesforce: { ...LAYOUT_B, release: 'gearset', ...over } }));
    const all = resolve();
    expect(all.map((s) => s.name)).toEqual(['sf-org-guard', 'merge-main', 'sf-delta', 'push', 'gearset-pr', 'sf-validate', 'gearset-promote-qa', 'gearset-promote-uat']);
    expect(all.at(-1)).toBe(gearsetPromote('uat'));
    expect(resolve({ stopAt: 'qa' }).at(-1)).toBe(gearsetPromote('qa'));
  });
  it('adds no promotion for a stage whose name cannot be a step name', () => {
    const steps = pack.steps({ salesforce: { ...LAYOUT_B, stages: [{ name: 'qa', org: 'acme-qa', branch: 'qa' }, { name: 'Not-A-Step', org: 'acme-uat', branch: 'uat' }] } });
    expect(Object.keys(steps).filter((n) => n.startsWith('gearset-promote-'))).toEqual(['gearset-promote-qa']);
  });
  it('joins the core table without a clash', () => {
    const table = stepTableFor({ pack: 'salesforce', salesforce: LAYOUT_B });
    expect(table['sf-org-guard']).toBe(sfOrgGuard);
    expect(table['sf-delta']).toBe(sfDelta);
    expect(table['gearset-pr']).toBe(gearsetPr);
    expect(table['sf-validate']).toBe(sfValidate);
    expect(table['sf-deploy-qa']).toBe(sfDeploy('qa'));
    expect(table['sf-deploy-uat']).toBe(sfDeploy('uat', { later: true }));
    expect(table['sf-verify-qa']).toBe(sfVerify('qa'));
    expect(table['sf-verify-uat']).toBe(sfVerify('uat', { later: true }));
    expect(table['ci-deploy-watch-qa']).toBe(ciDeployWatch('qa'));
    expect(table['ci-deploy-watch-uat']).toBe(ciDeployWatch('uat', { later: true }));
    expect(table['gearset-promote-qa']).toBe(gearsetPromote('qa'));
    expect(table['gearset-promote-uat']).toBe(gearsetPromote('uat'));
    expect(table.pr.name).toBe('pr');
    expect(table['merge-main'].name).toBe('merge-main');
  });
});

describe('foreman ship --preflight on a copy of the Acme fixture', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-sfship-'));
    fs.cpSync(FIXTURE, dir, { recursive: true });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const writeConfig = (extra = {}) =>
    fs.writeFileSync(
      path.join(dir, 'foreman.config.json'),
      JSON.stringify({
        version: 1,
        project: { name: 'Acme' },
        pack: 'salesforce',
        slots: 1,
        salesforce: { orgs: { 'acme-dev1': { orgId: ACME_DEV1_ID } }, build: 'acme-dev1', stages: [{ name: 'dev', org: 'acme-dev1' }] },
        ...extra,
      }),
    );

  async function preflight() {
    let out = '';
    const code = await makeShipCommand({ sh: fakeSh([]) }).run(['--preflight'], {
      cwd: dir,
      root: dir,
      env: { FOREMAN_STATE_DIR: path.join(dir, '.foreman') },
      stdout: { write: (s) => (out += s) },
    });
    return { code, json: JSON.parse(out.trim().split('\n').at(-1)) };
  }

  it('lists sf-org-guard first and sf-delta right after merge-main, from the real pack', async () => {
    writeConfig({ ship: { steps: ['sf-org-guard', 'merge-main', 'sf-delta', 'push', 'pr', 'ci', 'mergeable-recheck', 'merge'] } });
    const { code, json } = await preflight();
    expect(code).toBe(0);
    expect(json.steps[0]).toEqual({ name: 'sf-org-guard', needs: ['sf'] });
    expect(json.steps[1].name).toBe('merge-main');
    expect(json.steps[2]).toEqual({ name: 'sf-delta', needs: ['sf', 'git'] });
  });

  it('lists the direct path through sf-deploy-dev in order, from the real pack', async () => {
    writeConfig({ ship: { steps: [...COMMON_STEPS, 'sf-deploy-dev'] } });
    const { code, json } = await preflight();
    expect(code).toBe(0);
    expect(json.steps.map((s) => s.name)).toEqual(['sf-org-guard', 'merge-main', 'sf-delta', 'push', 'pr', 'ci', 'sf-validate', 'mergeable-recheck', 'merge', 'sf-deploy-dev']);
    expect(json.steps.find((s) => s.name === 'sf-validate').needs).toEqual(['sf']);
    expect(json.steps.find((s) => s.name === 'sf-deploy-dev').needs).toEqual(['sf']);
  });

  it('with the pack defaults, lists the whole stage 1 path and the rollback on failure, with no rollback warning', async () => {
    writeConfig();
    const { code, json } = await preflight();
    expect(code).toBe(0);
    expect(json.steps).toEqual([
      ...NO_CI_STEPS.map((name) => ({ name, needs: expect.any(Array) })),
      { name: 'sf-deploy-dev', needs: ['sf'] },
      { name: 'sf-verify-dev', needs: ['sf'] },
      { name: 'rollback', needs: ['sh'], when: 'on failure' },
    ]);
    expect(json.warnings.filter((w) => w.includes('rollback'))).toEqual([]);
  });

  it('with the pack defaults and a workflow on pull_request, keeps ci in the path', async () => {
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.github', 'workflows', 'ci.yml'), 'name: ci\non: pull_request\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n');
    writeConfig();
    const { code, json } = await preflight();
    expect(code).toBe(0);
    expect(json.steps.map((s) => s.name)).toEqual([...COMMON_STEPS, 'sf-deploy-dev', 'sf-verify-dev', 'rollback']);
  });

  describe('with layout (b): qa on branch qa, then uat on branch uat', () => {
    const LAYOUT_B = {
      productionBranch: 'main',
      orgs: { 'acme-dev1': { orgId: ACME_DEV1_ID }, 'acme-qa': { orgId: ACME_QA_ID }, 'acme-uat': { orgId: ACME_UAT_ID } },
      build: ['acme-dev1'],
      stages: [{ name: 'qa', org: 'acme-qa', branch: 'qa' }, { name: 'uat', org: 'acme-uat', branch: 'uat' }],
    };
    const common = () => NO_CI_STEPS.map((name) => ({ name, needs: expect.any(Array) }));

    it('release sf lists the uat deploy and verify after qa, then the rollback on failure', async () => {
      writeConfig({ salesforce: LAYOUT_B });
      const { code, json } = await preflight();
      expect(code).toBe(0);
      expect(json.steps).toEqual([
        ...common(),
        { name: 'sf-deploy-qa', needs: ['sf'] },
        { name: 'sf-verify-qa', needs: ['sf'] },
        { name: 'sf-deploy-uat', needs: ['sf', 'git'] },
        { name: 'sf-verify-uat', needs: ['sf'] },
        { name: 'rollback', needs: ['sh'], when: 'on failure' },
      ]);
    });

    it('release ci lists the uat watch after the qa one, with no rollback', async () => {
      writeConfig({ salesforce: { ...LAYOUT_B, release: 'ci' } });
      const { code, json } = await preflight();
      expect(code).toBe(0);
      expect(json.steps).toEqual([...common(), { name: 'ci-deploy-watch-qa', needs: ['gh', 'sf'] }, { name: 'ci-deploy-watch-uat', needs: ['gh', 'sf', 'git'] }]);
    });

    it('stopAt qa ends at qa on both paths', async () => {
      writeConfig({ salesforce: { ...LAYOUT_B, stopAt: 'qa' } });
      const sf = await preflight();
      expect(sf.code).toBe(0);
      expect(sf.json.steps.filter((s) => s.when !== 'on failure').at(-1).name).toBe('sf-verify-qa');
      expect(sf.json.steps.map((s) => s.name)).not.toContain('sf-deploy-uat');
      writeConfig({ salesforce: { ...LAYOUT_B, stopAt: 'qa', release: 'ci' } });
      const ci = await preflight();
      expect(ci.code).toBe(0);
      expect(ci.json.steps.at(-1).name).toBe('ci-deploy-watch-qa');
    });
  });
});

describe('a uat failure through runShip and the real pack', () => {
  const LAYOUT_B = {
    productionBranch: 'main',
    orgs: { 'acme-dev1': { orgId: ACME_DEV1_ID }, 'acme-qa': { orgId: ACME_QA_ID }, 'acme-uat': { orgId: ACME_UAT_ID } },
    build: ['acme-dev1'],
    stages: [{ name: 'qa', org: 'acme-qa', branch: 'qa' }, { name: 'uat', org: 'acme-uat', branch: 'uat' }],
  };
  const JOB = '0Af000000000001AAA';
  const UAT_MERGE = 'c'.repeat(40);
  const report = (status) => sfOk({ id: JOB, status, numberComponentsDeployed: 1, numberComponentsTotal: 1, numberTestsCompleted: 1, numberTestErrors: 0, details: {} });
  const package_ = '<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n  <types>\n    <members>AcmeService</members>\n    <name>ApexClass</name>\n  </types>\n  <version>62.0</version>\n</Package>\n';

  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-sf-uat-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  function run({ deploy, query = null }) {
    const config = withDefaults({ version: 1, project: { name: 'Acme' }, pack: 'salesforce', slots: 1, salesforce: LAYOUT_B });
    const rules = [
      [/^git rev-parse --verify refs\/(heads|remotes\/origin)\/story\/s-1$/, `${'e'.repeat(40)}\n`],
      ['git merge-base --is-ancestor', 1],
      ['git rev-parse HEAD', `${UAT_MERGE}\n`],
      [/^sf project deploy start /, sfOk({ id: JOB, status: 'Queued' })],
      [/^sf project deploy report /, deploy],
      ...(query ? [[/^sf data query --use-tooling-api/, query]] : []),
    ];
    const ctx = fakeCtx({ config, rules, root: tmp, env: { FOREMAN_SF_HOME: path.join(tmp, 'sf-home'), FOREMAN_STATE_DIR: path.join(tmp, 'state') } });
    fs.mkdirSync(path.join(tmp, 'sf-home'));
    const manifest = path.join(tmp, 'package.xml');
    fs.writeFileSync(manifest, package_);
    ctx.sfDelta = { from: 'aaa', to: 'bbb', manifest, postDestructive: path.join(tmp, 'post.xml'), deletes: [] };
    const merge = { name: 'merge', pointOfNoReturn: true, run: () => ({ ok: true, sha: 'm1' }) };
    const qa = { name: 'sf-deploy-qa', deploys: true, halts: true, run: () => ({ ok: true, sfDeploys: { qa: { org: 'acme-qa', jobId: JOB } } }) };
    const table = stepTableFor(config);
    const spy = { calls: 0 };
    const onFailure = { ...onFailureFor(config), run: () => ((spy.calls += 1), { ok: true }) };
    return { config, ctx, spy, onFailure, steps: [merge, qa, table['sf-deploy-uat'], table['sf-verify-uat']] };
  }

  it('an sf-deploy-uat failure after the qa deploy is code 5 with one HALT, and never rolls back', async () => {
    const { config, ctx, spy, onFailure, steps } = run({ deploy: report('Failed') });
    expect(onFailureFor(config)).not.toBeNull();
    const { code, result } = await runShip({ steps: steps.slice(0, 3), ctx, onFailure });
    expect(code).toBe(5);
    expect(spy.calls).toBe(0);
    expect(ctx.halts).toHaveLength(1);
    expect(result.stage).toBe('sf-deploy-uat');
    expect(result.reason.startsWith('Not rolled back')).toBe(true);
    expect(ctx.sh.calls.findIndex((l) => l.startsWith('git merge --no-ff'))).toBeLessThan(ctx.sh.calls.findIndex((l) => l.startsWith('sf project deploy start')));
  });

  it('an sf-verify-uat failure after sf-deploy-uat passed is code 5 with one HALT, and never rolls back', async () => {
    const other = sfOk({ records: [{ attributes: { type: 'DeployRequest' }, Id: '0Af000000000009AAA', Status: 'Succeeded' }], totalSize: 1, done: true });
    const { config, ctx, spy, onFailure, steps } = run({ deploy: report('Succeeded'), query: other });
    expect(onFailureFor(config)).not.toBeNull();
    const { code, result } = await runShip({ steps, ctx, onFailure });
    expect(code).toBe(5);
    expect(spy.calls).toBe(0);
    expect(ctx.halts).toHaveLength(1);
    expect(result.stage).toBe('sf-verify-uat');
    expect(result.reason.startsWith('Not rolled back')).toBe(true);
    expect(result).toMatchObject({ sha: UAT_MERGE, shaBranch: 'uat' });
  });
});

describe('through core init, with the real registry', () => {
  it('detect claims the Acme fixture for the salesforce pack and suggests its steps', () => {
    const { suggested, found } = coreDetect(FIXTURE, { gitRemote: () => null });
    expect(suggested.pack).toBe('salesforce');
    expect(found.pack).toBe('salesforce');
    expect(found.packFindings.packageDirectories[0].path).toBe('force-app');
    expect(suggested.ship.steps).toEqual(NO_CI_STEPS);
    expect(found.packErrors).toBeUndefined();
  });
  it("leaves out the core checks, so the pack's own checks apply", () => {
    expect(JSON.parse(fs.readFileSync(path.join(FIXTURE, 'package.json'), 'utf8')).scripts.test).toEqual(expect.any(String));
    const { suggested } = coreDetect(FIXTURE, { gitRemote: () => null });
    expect(suggested).not.toHaveProperty('checks');
  });
  it('foreman init detect prints pack salesforce', async () => {
    let out = '';
    let err = '';
    const code = await makeInitCommand().run(['detect'], { root: FIXTURE, cwd: FIXTURE, env: {}, stdout: { write: (s) => (out += s) }, stderr: { write: (s) => (err += s) } });
    expect(code).toBe(0);
    expect(err).toBe('');
    expect(JSON.parse(out).suggested.pack).toBe('salesforce');
  });
});
