import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIN_VERSIONS, atLeast, doctorChecks, toolsCheck } from './doctor-salesforce.mjs';
import { withDefaults } from '../../lib/config/defaults.mjs';
import { makeDoctorCommand } from '../../lib/cli/commands/doctor.mjs';
import {
  ACME_DEV1_ID,
  ACME_PROD_ID,
  ACME_QA_ID,
  ACME_UAT_ID,
  AGENTFORCE,
  DATA_CLOUD,
  ORG_LIST,
  PLUGINS,
  TELEMETRY,
  TRACKING,
  acmeOrg,
  acmePlugins,
  acmeSfRoutes,
  fakeSfShell,
  orgRecord,
  orgList,
  orgRoute,
  sfError,
  sfOk,
  sfRaw,
} from '../../../test/fake-sf.mjs';
import { writeInstalled } from '../../../test/fake-skills.mjs';
import { DEPLOYMENTS, PIPELINES, acmeDeployment, acmeDeployments, acmeEnvironment, acmeGearset, acmeTwoPipelines, environmentsOf, fakeGearset } from '../../../test/fake-gearset.mjs';
import { CREDENTIALS_REASON } from './skills.mjs';
import { makeSfCommand } from './sf-command.mjs';
import { recordCooldown } from './sf.mjs';
import { writeScratchOrg } from './scratch-orgs.mjs';
import { AGENTFORCE_FILE, agentforceCheck, readAgentforceSwitch, writeAgentforceSwitch } from './agentforce.mjs';
import { isolatedSh } from './isolation.mjs';
import { fakeCtx, fakeSh } from '../../../test/ship-fakes.mjs';
import { PACKS } from '../index.mjs';
import { fakeCasesOrg } from '../../../test/fake-sf-cases.mjs';

const FIXTURE = fileURLToPath(new URL('../../../test/fixtures/acme-sfdx', import.meta.url));
const REF = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\trefs/heads/main\n';
const SECRET = 'yes-secret-9';
const SOURCE = 'forcedotcom/sf-skills';
const ACME_DEV2_ID = '00D000000000004AAA';
const DEV2_ROUTES = { [orgRoute('acme-dev2')]: orgRecord(ACME_DEV2_ID) };

// Two skills installed as `foreman sf skills` leaves them, with real hashes.
const INSTALLED = {
  'sf-apex': { 'SKILL.md': '# Apex for Acme\n', 'references/a.md': 'Acme apex notes\n' },
  'sf-lwc': { 'SKILL.md': '# LWC for Acme\n' },
};

let dir;
// Outside the project: the isolated sf home and a folder holding an executable sf, so no check
// reads this machine's own home or PATH.
let aux;
let sfHome;
let sfBin;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-sfdoctor-'));
  writeInstalled(dir, INSTALLED, SOURCE);
  aux = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-sfdoctor-aux-'));
  sfHome = path.join(aux, 'sf-home');
  fs.mkdirSync(sfHome);
  sfBin = path.join(aux, 'bin');
  fs.mkdirSync(sfBin);
  fs.writeFileSync(path.join(sfBin, 'sf'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(sfBin, 'sf'), 0o755);
  // Every org already has a clean baseline, so the checks before this story run no Apex tests.
  for (const [alias, orgId] of [['acme-dev1', ACME_DEV1_ID], ['acme-dev2', ACME_DEV2_ID], ['acme-qa', ACME_QA_ID], ['acme-uat', ACME_UAT_ID]]) writeBase(alias, orgId);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(aux, { recursive: true, force: true });
});

// A baseline record as the doctor leaves it under <dir>/.foreman/salesforce/baseline/.
const BASE_RUN = '707000000000001AAA';
const baseFile = (alias, root = dir) => path.join(root, '.foreman', 'salesforce', 'baseline', `${alias}.json`);
function writeBase(alias, orgId, over = {}, root = dir) {
  const record = { alias, orgId, testRunId: BASE_RUN, startedAt: '2026-10-23T08:00:00.000Z', state: 'done', finishedAt: '2026-10-23T09:00:00.000Z', failing: [], coverage: 82, ...over };
  for (const key of Object.keys(record)) if (record[key] === undefined) delete record[key];
  fs.mkdirSync(path.dirname(baseFile(alias, root)), { recursive: true });
  fs.writeFileSync(baseFile(alias, root), JSON.stringify(record));
}
const readBase = (alias) => JSON.parse(fs.readFileSync(baseFile(alias), 'utf8'));
const removeBase = (alias) => fs.rmSync(baseFile(alias), { force: true });

const skill = (source = SOURCE) => ({ source, sourceType: 'github', skillPath: 'skills/x/SKILL.md', computedHash: 'abc123' });
const writeLock = (value) => fs.writeFileSync(path.join(dir, 'skills-lock.json'), typeof value === 'string' ? value : JSON.stringify(value));

// The Acme block: one build sandbox and a QA sandbox on branch qa. `edit` changes the file in place.
function acmeConfig(edit) {
  const file = {
    version: 1,
    project: { name: 'Acme' },
    pack: 'salesforce',
    salesforce: {
      productionBranch: 'main',
      orgs: { 'acme-dev1': { orgId: ACME_DEV1_ID }, 'acme-qa': { orgId: ACME_QA_ID } },
      build: ['acme-dev1'],
      stages: [{ name: 'qa', org: 'acme-qa', branch: 'qa' }],
    },
  };
  edit?.(file.salesforce, file);
  // As loadConfig resolves it: the pack reads the project folder for workflows.
  return withDefaults(file, { project: { root: dir, fs } });
}

// Adds a uat stage on acme-uat, on its own branch.
const addUat = (branch = 'uat') => (b) => {
  b.orgs['acme-uat'] = { orgId: ACME_UAT_ID };
  b.stages.push({ name: 'uat', org: 'acme-uat', branch });
};

// The spec's worked examples (a) and (c), as edits of the Acme block. Example (b) is the Acme
// block with a uat stage (addUat) and test on qa.
const layoutA = (b) => {
  b.orgs = { 'acme-dev1': { orgId: ACME_DEV1_ID } };
  b.build = 'acme-dev1';
  b.stages = [{ name: 'dev', org: 'acme-dev1' }];
  delete b.productionBranch;
};
const layoutC = (b, file) => {
  b.orgs['acme-dev2'] = { orgId: ACME_DEV2_ID };
  b.build = ['acme-dev1', 'acme-dev2'];
  b.stages = [{ name: 'qa', org: 'acme-qa' }];
  file.slots = 2;
};

// The git answers the checks get when nothing else says: ls-remote finds the branch.
const gitFallback = (git = { status: 0, stdout: REF, stderr: '' }) => (cmd, args) =>
  cmd === 'git' && args[0] === 'ls-remote' ? git : { status: 0, stdout: '', stderr: '' };

function ctxFor({ routes = {}, env = {}, git, fallback, fetch } = {}) {
  return {
    root: dir,
    env: { FOREMAN_SF_HOME: sfHome, PATH: sfBin, ...env },
    sh: fakeSfShell(acmeSfRoutes(routes), fallback ?? gitFallback(git)),
    fs,
    sourceRoot: path.join(dir, 'plugin'),
    ...(fetch ? { fetch } : {}),
  };
}

async function runAll(config, ctx) {
  const out = {};
  for (const check of doctorChecks(config, ctx)) out[check.name] = await check.run(ctx);
  return out;
}

async function one(name, { edit, ...opts } = {}) {
  const ctx = ctxFor(opts);
  const res = await runAll(acmeConfig(edit), ctx);
  expect(res, `no check named ${name}`).toHaveProperty([name]);
  return { ...res[name], ctx, all: res };
}

const OK = { ok: true, level: 'error' };
const FAIL = { ok: false, level: 'error' };
const WARN = { ok: false, level: 'warn' };

describe('the salesforce doctor group', () => {
  it('lists its checks in order for the Acme pool config', () => {
    expect(doctorChecks(acmeConfig(), ctxFor()).map((c) => c.name)).toEqual([
      'salesforce tools',
      'salesforce layout',
      'salesforce org acme-dev1 (build)',
      'salesforce org acme-qa (stage qa)',
      'salesforce sf isolation',
      'salesforce plugin',
      'salesforce source tracking acme-dev1',
      'salesforce baseline acme-dev1 (build)',
      'salesforce baseline acme-qa (stage qa)',
      'salesforce agentforce',
      'salesforce test level',
      'salesforce production branch',
      'salesforce workflows',
      'salesforce ci',
      'salesforce skills lock',
      'salesforce skills named',
      'salesforce telemetry',
      'salesforce CONFIRM_PROD',
    ]);
  });
  it('adds the uat stage after qa', () => {
    const names = doctorChecks(acmeConfig(addUat()), ctxFor()).map((c) => c.name);
    expect(names.slice(2, 5)).toEqual(['salesforce org acme-dev1 (build)', 'salesforce org acme-qa (stage qa)', 'salesforce org acme-uat (stage uat)']);
  });
  it('(a) checks a build org that also takes the releases once, named with both roles', async () => {
    const ctx = ctxFor();
    const res = await runAll(acmeConfig(layoutA), ctx);
    const orgChecks = Object.keys(res).filter((name) => name.startsWith('salesforce org '));
    expect(orgChecks).toEqual(['salesforce org acme-dev1 (build, stage dev)']);
    expect(res['salesforce org acme-dev1 (build, stage dev)']).toMatchObject({ ...OK, detail: `sandbox ${ACME_DEV1_ID}` });
    expect(ctx.sh.sfLines().filter((l) => l.includes(orgRoute('acme-dev1')))).toHaveLength(1);
    expect(res['salesforce source tracking acme-dev1']).toMatchObject(OK);
    expect(ctx.sh.sfLines().filter((l) => l.includes('SourceMember') && l.includes('--target-org acme-dev1'))).toHaveLength(1);
    expect(res['salesforce production branch']).toEqual({ ...OK, detail: 'none set: pull requests go into main' });
    expect(ctx.sh.calls.some((c) => c.cmd === 'git')).toBe(false);
  });
  it('(c) checks each build org and its tracking, and the stage org without tracking', async () => {
    const ctx = ctxFor({ routes: DEV2_ROUTES });
    const res = await runAll(acmeConfig(layoutC), ctx);
    expect(Object.keys(res).filter((name) => name.startsWith('salesforce org '))).toEqual([
      'salesforce org acme-dev1 (build)',
      'salesforce org acme-dev2 (build)',
      'salesforce org acme-qa (stage qa)',
    ]);
    expect(res['salesforce org acme-dev2 (build)']).toMatchObject({ ...OK, detail: `sandbox ${ACME_DEV2_ID}` });
    expect(res).toHaveProperty(['salesforce source tracking acme-dev1']);
    expect(res).toHaveProperty(['salesforce source tracking acme-dev2']);
    expect(res).not.toHaveProperty(['salesforce source tracking acme-qa']);
    const tracking = ctx.sh.sfLines().filter((l) => l.includes('SourceMember'));
    expect(tracking.some((l) => l.includes('--target-org acme-dev1'))).toBe(true);
    expect(tracking.some((l) => l.includes('--target-org acme-dev2'))).toBe(true);
    expect(tracking.some((l) => l.includes('--target-org acme-qa'))).toBe(false);
    for (const alias of ['acme-dev1', 'acme-dev2', 'acme-qa']) {
      expect(ctx.sh.sfLines().filter((l) => l.includes(orgRoute(alias))), alias).toHaveLength(1);
    }
  });
  it('checks an org no step uses, and fails a build alias that is not in orgs without running sf', async () => {
    const unused = await runAll(acmeConfig((b) => { b.orgs['acme-uat'] = { orgId: ACME_UAT_ID }; }), ctxFor());
    expect(unused['salesforce org acme-uat (not used)']).toMatchObject({ ...OK, detail: `sandbox ${ACME_UAT_ID}` });

    const ctx = ctxFor();
    const res = await runAll(acmeConfig((b) => { b.build = 'acme-none'; }), ctx);
    expect(res['salesforce org acme-none (build)']).toEqual(expect.objectContaining({ ...FAIL, detail: 'acme-none is not in salesforce.orgs' }));
    expect(res['salesforce source tracking acme-none']).toEqual(expect.objectContaining({ ...WARN, detail: 'skipped: acme-none did not pass its org check' }));
    expect(ctx.sh.sfLines().some((l) => l.includes('acme-none'))).toBe(false);
  });
  it('is all ok on a healthy Acme set', async () => {
    const res = await runAll(acmeConfig(), ctxFor({ env: {} }));
    for (const [name, r] of Object.entries(res)) expect(r, name).toMatchObject(OK);
  });
  it('in scratch mode, warns once for the build orgs and checks no pool, tracking or Dev Hub', async () => {
    const edit = (b) => {
      b.orgs['acme-hub'] = { orgId: ACME_UAT_ID };
      b.build = { scratch: { devHub: 'acme-hub', definition: 'config/project-scratch-def.json' } };
    };
    const ctx = ctxFor();
    const res = await runAll(acmeConfig(edit), ctx);
    expect(Object.keys(res)).toEqual([
      'salesforce tools',
      'salesforce layout',
      'salesforce org build',
      'salesforce org acme-qa (stage qa)',
      'salesforce org acme-dev1 (not used)',
      'salesforce sf isolation',
      'salesforce plugin',
      'salesforce baseline acme-qa (stage qa)',
      'salesforce agentforce',
      'salesforce test level',
      'salesforce production branch',
      'salesforce workflows',
      'salesforce ci',
      'salesforce skills lock',
      'salesforce skills named',
      'salesforce telemetry',
      'salesforce CONFIRM_PROD',
    ]);
    expect(res['salesforce org build']).toEqual(expect.objectContaining({ ...WARN, detail: 'scratch mode: build orgs are made per story and are not checked here' }));
    expect(ctx.sh.sfLines().some((l) => l.includes('acme-hub') || l.includes('SourceMember'))).toBe(false);
    expect(res['salesforce layout'].detail).toMatch(/^build scratch orgs from acme-hub; /);
  });
  it('does not throw on odd block shapes', async () => {
    const odd = [
      (b) => { delete b.stages; },
      (b) => { b.build = 'acme-none'; },
      (b) => { b.build = [null, 7, 'acme-dev1']; b.stages = [null, { name: 3 }, 'qa']; },
      (b) => { b.orgs = 'none'; },
      (b) => { b.build = { scratch: 5 }; b.orgs['acme-qa'] = null; },
      (b) => { b.skills = 'x'; b.productionBranch = 42; },
      (b) => { b.skills = { source: SOURCE, tag: 7 }; },
    ];
    for (const edit of odd) {
      const config = acmeConfig(edit);
      const ctx = ctxFor();
      let res;
      await expect((async () => { res = await runAll(config, ctx); })()).resolves.toBeUndefined();
      expect(Object.keys(res)).toContain('salesforce tools');
    }
    writeLock({ version: 1, skills: { 'sf-apex': null, 'sf-lwc': null } });
    for (const edit of [undefined, (b) => { b.skills = 'x'; }]) {
      const res = await runAll(acmeConfig(edit), ctxFor());
      expect(res['salesforce skills lock']).toMatchObject(FAIL);
      expect(res['salesforce skills named']).toMatchObject(OK);
    }
    const empty = ctxFor();
    await expect(runAll({}, empty)).resolves.toBeTypeOf('object');
    await expect(runAll({ salesforce: null, checks: 'x' }, empty)).resolves.toBeTypeOf('object');
  });
});

describe('salesforce set-up steps and fix hints', () => {
  const SF_STEPS = ['sf-tools', 'sf-layout', 'sf-orgs', 'sf-skills', 'sf-gearset'];
  const gearset = (b) => { b.release = 'gearset'; addUat()(b); };
  const scratch = (b) => {
    b.orgs['acme-hub'] = { orgId: ACME_UAT_ID };
    b.build = { scratch: { devHub: 'acme-hub', definition: 'config/project-scratch-def.json' } };
  };

  it('tags every check with a Salesforce step', () => {
    for (const edit of [undefined, gearset, scratch]) {
      for (const check of doctorChecks(acmeConfig(edit), ctxFor())) expect(SF_STEPS, check.name).toContain(check.step);
    }
    const steps = Object.fromEntries(doctorChecks(acmeConfig(gearset), ctxFor()).map((c) => [c.name, c.step]));
    expect(steps).toMatchObject({
      'salesforce tools': 'sf-tools',
      'salesforce plugin': 'sf-tools',
      'salesforce telemetry': 'sf-tools',
      'salesforce layout': 'sf-layout',
      'salesforce test level': 'sf-layout',
      'salesforce production branch': 'sf-layout',
      'salesforce workflows': 'sf-layout',
      'salesforce ci': 'sf-layout',
      'salesforce CONFIRM_PROD': 'sf-layout',
      'salesforce org acme-qa (stage qa)': 'sf-orgs',
      'salesforce sf isolation': 'sf-orgs',
      'salesforce source tracking acme-dev1': 'sf-orgs',
      'salesforce baseline acme-qa (stage qa)': 'sf-orgs',
      'salesforce agentforce': 'sf-orgs',
      'salesforce skills lock': 'sf-skills',
      'salesforce skills named': 'sf-skills',
      'salesforce gearset token': 'sf-gearset',
      'salesforce gearset environments': 'sf-gearset',
      'salesforce gearset ci job': 'sf-gearset',
      'salesforce gearset ci tests': 'sf-gearset',
    });
    expect(doctorChecks(acmeConfig(scratch), ctxFor()).find((c) => c.name === 'salesforce org build').step).toBe('sf-orgs');
  });

  it('gives every failure and warning a plain hint', async () => {
    fs.rmSync(path.join(dir, 'skills-lock.json'));
    removeBase('acme-qa');
    const notSignedIn = sfError('NamedOrgNotFoundError', 'No authorization information found for acme-qa.', 2);
    const routes = { [orgRoute('acme-qa')]: notSignedIn, [orgRoute('acme-dev1')]: notSignedIn, [PLUGINS]: sfRaw(acmePlugins({ 'sfdx-git-delta': null })) };
    writeWorkflow(dir, deployWorkflow('qa', 'acme-prod'));
    const edit = (b, file) => {
      gearset(b);
      file.ship = { pr: { into: 'qa', mergeMethod: 'squash' }, merge: { keepBranch: false } };
    };
    const ctx = ctxFor({ routes, env: { CONFIRM_PROD: SECRET, FOREMAN_SF_HOME: path.join(aux, 'no-home') } });
    const res = await runAll(acmeConfig(edit), ctx);
    const bad = Object.entries(res).filter(([, r]) => !r.ok);
    expect(bad.length).toBeGreaterThan(8);
    for (const [name, r] of bad) expect(typeof r.fix?.hint === 'string' && r.fix.hint.length > 0, name).toBe(true);
    expect(res['salesforce org acme-qa (stage qa)'].fix.hint).toBe("sign the org in to Foreman's sf home");
    expect(res['salesforce skills lock'].fix).toMatchObject({ action: 'sf-skills', hint: 'run `foreman sf skills`' });
    expect(res['salesforce baseline acme-qa (stage qa)'].fix.step).toBe('sf-orgs');
    expect(JSON.stringify(res)).not.toContain(SECRET);
  });

  it('gives an ok result no fix', async () => {
    for (const [name, r] of Object.entries(await runAll(acmeConfig(), ctxFor()))) expect(r.fix, name).toBeUndefined();
  });

  it('leaves toolsCheck as the cloud doctor reads it', () => {
    const r = toolsCheck({}, fakeSfShell({ [PLUGINS]: sfRaw(acmePlugins({ 'sfdx-git-delta': null })) }));
    expect(r).toEqual({ ok: false, level: 'error', detail: 'sfdx-git-delta missing' });
  });
});

describe('salesforce layout', () => {
  const LAYOUT = 'salesforce layout';
  it('(a) names the shared org', async () => {
    expect(await one(LAYOUT, { edit: layoutA })).toEqual(expect.objectContaining({
      ...OK,
      detail: "build acme-dev1; test the slot's build org; stage dev acme-dev1 on main; 1 slot; acme-dev1 is shared: what is in it is not only shipped work",
    }));
  });
  it('(b) names the test org and each stage on its branch', async () => {
    const edit = (b) => { addUat()(b); b.test = 'qa'; };
    expect(await one(LAYOUT, { edit })).toEqual(expect.objectContaining({
      ...OK,
      detail: 'build acme-dev1; test acme-qa (stage qa); stage qa acme-qa on qa; stage uat acme-uat on uat; 1 slot',
    }));
  });
  it('(c) names both build orgs and the slots', async () => {
    expect(await one(LAYOUT, { edit: layoutC, routes: DEV2_ROUTES })).toEqual(expect.objectContaining({
      ...OK,
      detail: "build acme-dev1, acme-dev2; test the slot's build org; stage qa acme-qa on main; 2 slots",
    }));
  });
  it('runs no sf and no git', () => {
    const ctx = ctxFor();
    const check = doctorChecks(acmeConfig(), ctx).find((c) => c.name === LAYOUT);
    expect(check.run(ctx)).toMatchObject(OK);
    expect(ctx.sh.calls).toHaveLength(0);
  });
  it('names an empty pool as none', async () => {
    const r = await one(LAYOUT, { edit: (b) => { b.build = []; } });
    expect(r).toMatchObject(OK);
    expect(r.detail).toMatch(/^build none; /);
  });
  it('names scratch mode with no dev hub', async () => {
    const r = await one(LAYOUT, { edit: (b) => { b.build = { scratch: {} }; } });
    expect(r).toMatchObject(OK);
    expect(r.detail).toMatch(/^build scratch orgs from no dev hub; /);
  });
  it('shows a pool, test, stage or shared alias that is not valid as <invalid alias>', () => {
    const ctx = ctxFor();
    const config = acmeConfig((b) => {
      b.build = ['acme-dev1', '-o'];
      b.stages = [{ name: 'qa', org: '-o', branch: 'qa' }];
      b.test = 'qa';
    });
    const r = doctorChecks(config, ctx).find((c) => c.name === LAYOUT).run(ctx);
    expect(r).toMatchObject(OK);
    expect(r.detail).toBe('build acme-dev1, <invalid alias>; test <invalid alias> (stage qa); stage qa <invalid alias> on qa; 1 slot; <invalid alias> is shared: what is in it is not only shipped work');
    expect(r.detail).not.toContain('-o');
    expect(ctx.sh.calls).toHaveLength(0);
  });
  it('shows a scratch dev hub that is not a valid alias as <invalid alias>', () => {
    const ctx = ctxFor();
    const config = acmeConfig((b) => { b.build = { scratch: { devHub: '-o' } }; });
    const r = doctorChecks(config, ctx).find((c) => c.name === LAYOUT).run(ctx);
    expect(r.detail).toMatch(/^build scratch orgs from <invalid alias>; /);
    expect(r.detail).not.toContain('-o');
  });
});

describe('atLeast and MIN_VERSIONS', () => {
  it('compares numeric major.minor.patch and ignores a pre-release suffix', () => {
    expect(atLeast('2.150.6', '2.0.0')).toBe(true);
    expect(atLeast('2.0.0', '2.0.0')).toBe(true);
    expect(atLeast('1.9.0', '2.0.0')).toBe(false);
    expect(atLeast('6.20.0', '6.3.0')).toBe(true);
    expect(atLeast('5.0.0-beta.3', '5.0.0')).toBe(true);
    expect(atLeast('4.12.0', '5.0.0')).toBe(false);
    expect(atLeast('nope', '1.0.0')).toBe(false);
    expect(atLeast(undefined, '1.0.0')).toBe(false);
  });
  it('names the CLI, sfdx-git-delta and code-analyzer', () => {
    expect(MIN_VERSIONS).toEqual({ '@salesforce/cli': '2.0.0', 'sfdx-git-delta': '6.0.0', '@salesforce/plugin-code-analyzer': '5.0.0' });
  });
});

describe('salesforce tools', () => {
  const tools = (plugins, edit) => one('salesforce tools', { routes: { [PLUGINS]: plugins }, edit });
  it('is ok on the healthy routes, and shows the CLI version', async () => {
    const r = await tools(sfRaw(acmePlugins()));
    expect(r).toMatchObject(OK);
    expect(r.detail).toContain('2.150.6');
  });
  it('fails when sf is not on PATH', async () => {
    const r = await tools({ status: 1, stdout: '', stderr: 'spawnSync sf ENOENT' });
    expect(r).toMatchObject(FAIL);
    expect(r.detail).toMatch(/install the Salesforce CLI/);
  });
  it('fails when the output cannot be read', async () => {
    expect(await tools({ status: 0, stdout: 'garbled', stderr: '' })).toMatchObject(FAIL);
    expect(await tools(sfRaw({ not: 'a list' }))).toMatchObject(FAIL);
  });
  it('fails on an old CLI, a missing sfdx-git-delta and an old code-analyzer, naming each', async () => {
    const old = await tools(sfRaw(acmePlugins({ '@salesforce/cli': '1.9.0' })));
    expect(old).toMatchObject(FAIL);
    expect(old.detail).toContain('@salesforce/cli 1.9.0 < 2.0.0');
    const missing = await tools(sfRaw(acmePlugins({ 'sfdx-git-delta': null })));
    expect(missing).toMatchObject(FAIL);
    expect(missing.detail).toContain('sfdx-git-delta missing');
    const analyzer = await tools(sfRaw(acmePlugins({ '@salesforce/plugin-code-analyzer': '4.12.0' })));
    expect(analyzer).toMatchObject(FAIL);
    expect(analyzer.detail).toContain('@salesforce/plugin-code-analyzer 4.12.0 < 5.0.0');
  });
  it('warns when plugin-agent is missing and agentforce is auto, and is ok when agentforce is off', async () => {
    const noAgent = sfRaw(acmePlugins({ '@salesforce/plugin-agent': null }));
    const auto = await tools(noAgent, (b) => { b.agentforce = 'auto'; });
    expect(auto).toMatchObject(WARN);
    expect(auto.detail).toContain('@salesforce/plugin-agent');
    expect(await tools(noAgent, (b) => { b.agentforce = 'off'; })).toMatchObject(OK);
  });
  it('is exported on its own, for the cloud doctor, and judges the same', () => {
    const sh = fakeSfShell({ [PLUGINS]: sfRaw(acmePlugins()) });
    expect(toolsCheck({ agentforce: 'auto' }, sh)).toMatchObject(OK);
    expect(toolsCheck({}, fakeSfShell({ [PLUGINS]: sfRaw(acmePlugins({ 'sfdx-git-delta': null })) }))).toMatchObject(FAIL);
  });
});

describe('salesforce org', () => {
  const QA = 'salesforce org acme-qa (stage qa)';
  const qa = (answer, edit) => one(QA, { routes: answer ? { [orgRoute('acme-qa')]: answer } : {}, edit });
  const clean = (r) => {
    expect(r.detail).not.toContain('accessToken');
    expect(r.detail).not.toContain('Did you mean');
  };

  it('is ok "sandbox <orgId>" for an 18-character and a 15-character configured org ID', async () => {
    const long = await qa();
    expect(long).toEqual(expect.objectContaining({ ...OK, detail: `sandbox ${ACME_QA_ID}` }));
    const short = await qa(null, (b) => { b.orgs['acme-qa'].orgId = ACME_QA_ID.slice(0, 15); });
    expect(short).toEqual(expect.objectContaining({ ...OK, detail: `sandbox ${ACME_QA_ID.slice(0, 15)}` }));
    const build = await one('salesforce org acme-dev1 (build)');
    expect(build).toMatchObject({ ...OK, detail: `sandbox ${ACME_DEV1_ID}` });
  });
  it('runs one Organization query per org, with the alias as its own argument', async () => {
    const { ctx } = await qa();
    const call = ctx.sh.calls.find((c) => c.cmd === 'sf' && c.args.includes('acme-qa'));
    expect(call.args).toEqual(['data', 'query', '--query', 'SELECT Id, IsSandbox FROM Organization', '--target-org', 'acme-qa', '--json']);
    expect(ctx.sh.sfLines().filter((l) => l.includes(orgRoute('acme-dev1')))).toHaveLength(1);
  });
  it('fails while the org is cooling down after a login-rate answer, with no sf call to it, then queries again', async () => {
    const at = Date.parse('2026-10-24T10:00:00.000Z');
    recordCooldown(sfHome, 'acme-qa', { reason: 'login rate exceeded', now: at });
    const during = async (t) => {
      const ctx = { ...ctxFor(), now: () => new Date(t) };
      const res = await runAll(acmeConfig(), ctx);
      return { r: res[QA], ctx };
    };
    const { r, ctx } = await during(at + 60_000);
    expect(r).toMatchObject(FAIL);
    expect(r.detail).toBe('acme-qa is cooling down until 2026-10-24T11:00:00.000Z: it answered "login rate exceeded"; Foreman makes no sf call to it until then');
    expect(r.fix.hint).toBe('wait for the cool-down to end; the org can lock out logins for up to an hour');
    expect(ctx.sh.sfLines().filter((l) => / acme-qa( |$)/.test(l))).toEqual([]);
    const later = await during(at + 3_600_000 + 1);
    expect(later.r).toMatchObject({ ...OK, detail: `sandbox ${ACME_QA_ID}` });
    expect(later.ctx.sh.sfLines().filter((l) => l.includes(orgRoute('acme-qa')))).toHaveLength(1);
  });
  it('fails "not signed in" on NamedOrgNotFoundError', async () => {
    const r = await qa(sfError('NamedOrgNotFoundError', 'No authorization information found for acme-qa.', 2));
    expect(r).toMatchObject(FAIL);
    expect(r.detail).toMatch(/^not signed in to the isolated sf home; run `HOME=/);
    expect(r.detail).toContain(`HOME=${sfHome} SF_USE_GENERIC_UNIX_KEYCHAIN=true sf org login jwt --alias acme-qa --username <user>`);
    clean(r);
  });
  it('fails when the org is not a sandbox: production is refused', async () => {
    const r = await qa(orgRecord(ACME_QA_ID, false));
    expect(r).toEqual(expect.objectContaining({ ...FAIL, detail: 'acme-qa is not a sandbox; production is never a target' }));
    expect(await qa(sfOk({ records: [], totalSize: 0, done: true }))).toMatchObject(FAIL);
  });
  it('fails when the org ID does not match, case-sensitively', async () => {
    const other = await qa(orgRecord('00D000000000009AAA'));
    expect(other).toEqual(expect.objectContaining({ ...FAIL, detail: `acme-qa is org 00D000000000009, not ${ACME_QA_ID}` }));
    expect(await qa(orgRecord('00d000000000002AAA'))).toMatchObject(FAIL);
  });
  it('fails on any other error, and warns when the org cannot be reached', async () => {
    const other = await qa(sfError('MALFORMED_QUERY', 'unexpected token: FROM'));
    expect(other).toEqual(expect.objectContaining({ ...FAIL, detail: 'could not check acme-qa: unexpected token: FROM' }));
    clean(other);
    const down = await qa(sfError('SfError', 'getaddrinfo ENOTFOUND acme--qa.sandbox.my.salesforce.com'));
    expect(down).toEqual(expect.objectContaining({ ...WARN, detail: 'could not reach acme-qa; its identity is not checked' }));
  });
  it('fails a bad alias without running sf', async () => {
    const ctx = ctxFor();
    const res = await runAll(acmeConfig((b) => { b.orgs['-o'] = b.orgs['acme-qa']; delete b.orgs['acme-qa']; b.stages[0].org = '-o'; }), ctx);
    expect(res['salesforce org -o (stage qa)']).toMatchObject(FAIL);
    expect(ctx.sh.calls.some((c) => c.args.includes('-o'))).toBe(false);
  });
  it('never puts an access token from the result into a detail', async () => {
    const leaky = sfOk({ records: [{ Id: ACME_QA_ID, IsSandbox: false }], accessToken: '00D!secret-token' });
    const r = await qa(leaky);
    expect(r.detail).not.toContain('secret-token');
    clean(r);
  });
});

describe('salesforce source tracking', () => {
  const TRACK = 'salesforce source tracking acme-dev1';
  it('is ok when the tooling query runs', async () => {
    const r = await one(TRACK);
    expect(r).toEqual(expect.objectContaining({ ...OK, detail: '' }));
    expect(r.ctx.sh.calls.find((c) => c.args.includes('SELECT Id FROM SourceMember LIMIT 1')).args).toEqual([
      'data', 'query', '--use-tooling-api', '--query', 'SELECT Id FROM SourceMember LIMIT 1', '--target-org', 'acme-dev1', '--json',
    ]);
  });
  it('fails when source tracking is off', async () => {
    const r = await one(TRACK, { routes: { [TRACKING]: sfError('INVALID_TYPE', "sObject type 'SourceMember' is not supported.") } });
    expect(r).toMatchObject(FAIL);
    expect(r.detail).toMatch(/^source tracking is off in acme-dev1; turn on source tracking for Developer sandboxes/);
  });
  it('warns on another error', async () => {
    const r = await one(TRACK, { routes: { [TRACKING]: sfError('SfError', 'Request timed out') } });
    expect(r).toEqual(expect.objectContaining({ ...WARN, detail: 'could not check: Request timed out' }));
  });
  it('warns "skipped" when the org check failed, and runs no tooling query', async () => {
    const r = await one(TRACK, { routes: { [orgRoute('acme-dev1')]: orgRecord(ACME_DEV1_ID, false) } });
    expect(r).toEqual(expect.objectContaining({ ...WARN, detail: 'skipped: acme-dev1 did not pass its org check' }));
    expect(r.ctx.sh.sfLines().some((l) => l.includes('SourceMember'))).toBe(false);
    expect(r.ctx.sh.sfLines().filter((l) => l.includes(orgRoute('acme-dev1')))).toHaveLength(1);
  });
});

describe('salesforce production branch', () => {
  const PROD = 'salesforce production branch';
  it('is ok when the branch is on the remote', async () => {
    const r = await one(PROD);
    expect(r).toEqual(expect.objectContaining({ ...OK, detail: 'main; pull requests go into qa' }));
    const call = r.ctx.sh.calls.find((c) => c.cmd === 'git');
    expect(call.args).toEqual(['ls-remote', '--heads', 'origin', 'main']);
  });
  it('fails when ship.pr.into is the production branch', async () => {
    const r = await one(PROD, { edit: (b, file) => { file.ship = { steps: ['push'], pr: { into: 'main' } }; } });
    expect(r).toEqual(expect.objectContaining({ ...FAIL, detail: 'pull requests would merge into main, the production branch' }));
  });
  it('fails when there is no qa branch and baseBranch is the production branch', async () => {
    const r = await one(PROD, { edit: (b, file) => { delete b.stages[0].branch; file.baseBranch = 'main'; } });
    expect(r).toMatchObject(FAIL);
    expect(r.detail).toContain('the production branch');
  });
  it('fails when productionBranch is missing and a stage has its own branch, or release is gearset', async () => {
    const needed = { ...FAIL, detail: 'salesforce.productionBranch is not set; it is needed when a stage has its own branch or release is "gearset"' };
    expect(await one(PROD, { edit: (b) => { delete b.productionBranch; } })).toEqual(expect.objectContaining(needed));
    const gearset = (b) => { delete b.productionBranch; delete b.stages[0].branch; b.release = 'gearset'; };
    expect(await one(PROD, { edit: gearset })).toEqual(expect.objectContaining(needed));
  });
  it('is ok "none set" when productionBranch is missing and not needed, without running git', async () => {
    const r = await one(PROD, { edit: (b) => { delete b.productionBranch; delete b.stages[0].branch; } });
    expect(r).toEqual(expect.objectContaining({ ...OK, detail: 'none set: pull requests go into main' }));
    expect(r.ctx.sh.calls.some((c) => c.cmd === 'git')).toBe(false);
  });
  it('fails when the qa branch is the production branch, even with pull requests into another branch', async () => {
    const r = await one(PROD, { edit: (b, file) => { file.ship = { steps: ['push'], pr: { into: 'develop' } }; b.stages[0].branch = 'main'; } });
    expect(r).toEqual(expect.objectContaining({ ...FAIL, detail: 'pull requests would merge into main, the production branch' }));
  });
  it('fails when the uat branch is the production branch, even with pull requests into another branch', async () => {
    const edit = (b, file) => {
      file.ship = { steps: ['push'], pr: { into: 'develop' } };
      addUat('main')(b);
    };
    const r = await one(PROD, { edit });
    expect(r).toEqual(expect.objectContaining({ ...FAIL, detail: 'pull requests would merge into main, the production branch' }));
  });
  it('fails a productionBranch that is not a branch name, without running git', async () => {
    for (const value of ['-x', 'a..b']) {
      const r = await one(PROD, { edit: (b) => { b.productionBranch = value; } });
      expect(r, value).toEqual(expect.objectContaining({ ...FAIL, detail: 'salesforce.productionBranch is not a branch name' }));
      expect(r.ctx.sh.calls.filter((c) => c.cmd === 'git'), value).toHaveLength(0);
    }
  });
  it('warns on a remote that starts with "-", without running git', async () => {
    const r = await one(PROD, { edit: (b, file) => { file.remote = '-u'; } });
    expect(r).toEqual(expect.objectContaining({ ...WARN, detail: 'could not check -u' }));
    expect(r.ctx.sh.calls.some((c) => c.cmd === 'git')).toBe(false);
  });
  it('warns when the remote has no such branch, or cannot be reached', async () => {
    const none = await one(PROD, { git: { status: 0, stdout: '', stderr: '' } });
    expect(none).toEqual(expect.objectContaining({ ...WARN, detail: 'main is not a branch on origin; check salesforce.productionBranch' }));
    const down = await one(PROD, { git: { status: 128, stdout: '', stderr: 'fatal: could not read from remote' } });
    expect(down).toEqual(expect.objectContaining({ ...WARN, detail: 'could not check origin' }));
  });
});

describe('salesforce gearset', () => {
  const TOKEN = 't-acme-secret-41';
  const TOKEN_CHECK = 'salesforce gearset token';
  const BRANCH_CHECK = 'salesforce gearset branch';
  const METHOD_CHECK = 'salesforce gearset merge method';
  const ENVS = 'salesforce gearset environments';
  const CI_JOB = 'salesforce gearset ci job';
  const CI_TESTS = 'salesforce gearset ci tests';
  const GEARSET_CHECKS = [TOKEN_CHECK, BRANCH_CHECK, METHOD_CHECK, ENVS, CI_JOB, CI_TESTS];
  // The Acme block on the gearset path: qa and uat each on their own branch.
  const gearset = (more) => (b, file) => {
    b.release = 'gearset';
    addUat()(b);
    more?.(b, file);
  };
  const withToken = { env: { GEARSET_API_TOKEN: TOKEN } };
  const envsAnswer = (body) => fakeGearset(acmeGearset({ [environmentsOf('pipe-1')]: { status: 200, body } }));

  it('adds no gearset check on the sf path, and the same list as before', () => {
    const names = doctorChecks(acmeConfig(addUat()), ctxFor()).map((c) => c.name);
    expect(names.some((n) => n.startsWith('salesforce gearset'))).toBe(false);
    const ci = doctorChecks(acmeConfig((b) => { b.release = 'ci'; }), ctxFor()).map((c) => c.name);
    expect(ci.some((n) => n.startsWith('salesforce gearset'))).toBe(false);
  });

  it('adds its six checks right after the production branch check', () => {
    const names = doctorChecks(acmeConfig(gearset()), ctxFor()).map((c) => c.name);
    const at = names.indexOf('salesforce production branch');
    expect(names.slice(at + 1, at + 7)).toEqual(GEARSET_CHECKS);
    expect(names[at + 7]).toBe('salesforce workflows');
  });

  it('token: fails when it is missing, naming the variable and the env file, never a value', async () => {
    const r = await one(TOKEN_CHECK, { edit: gearset() });
    expect(r).toEqual(expect.objectContaining({
      ...FAIL,
      detail: 'GEARSET_API_TOKEN is not set in .env.foreman; create a Gearset API access token (My account → Team security → Access token management) and add it',
    }));
    const blank = await one(TOKEN_CHECK, { edit: gearset(), env: { GEARSET_API_TOKEN: '  ' } });
    expect(blank).toMatchObject(FAIL);
  });

  it("token: passes when only Foreman's own keys file sets it, without printing it", async () => {
    fs.writeFileSync(path.join(dir, '.env.foreman'), `GEARSET_API_TOKEN=${TOKEN}\n`);
    const r = await one(TOKEN_CHECK, { edit: gearset(), fetch: fakeGearset() });
    expect(r).toEqual(expect.objectContaining({ ...OK, detail: 'GEARSET_API_TOKEN is set' }));
    expect(JSON.stringify(r.all)).not.toContain(TOKEN);
  });

  it('token: passes when only the env file sets it, without printing it', async () => {
    fs.writeFileSync(path.join(dir, '.env.local'), `GEARSET_API_TOKEN=${TOKEN}\n`);
    const r = await one(TOKEN_CHECK, { edit: gearset(), fetch: fakeGearset() });
    expect(r).toEqual(expect.objectContaining({ ...OK, detail: 'GEARSET_API_TOKEN is set' }));
    expect(JSON.stringify(r.all)).not.toContain(TOKEN);
  });

  it('branch: fails with keepBranch off and passes with it on', async () => {
    const off = await one(BRANCH_CHECK, { edit: gearset((b, file) => { file.ship = { merge: { keepBranch: false } }; }) });
    expect(off).toEqual(expect.objectContaining({ ...FAIL, detail: 'ship.merge.keepBranch is off; Gearset needs the story branch until the last stage and back-propagation' }));
    expect(await one(BRANCH_CHECK, { edit: gearset() })).toMatchObject(OK);
  });

  it('merge method: fails squash and passes merge or unset', async () => {
    const squash = await one(METHOD_CHECK, { edit: gearset((b, file) => { file.ship = { pr: { into: 'qa', mergeMethod: 'squash' }, merge: { keepBranch: true } }; }) });
    expect(squash).toEqual(expect.objectContaining({ ...FAIL, detail: 'ship.pr.mergeMethod is squash; Gearset supports merge commits only' }));
    expect(await one(METHOD_CHECK, { edit: gearset() })).toMatchObject(OK);
    expect(await one(METHOD_CHECK, { edit: gearset((b, file) => { file.ship = { pr: { into: 'qa', mergeMethod: 'merge' }, merge: { keepBranch: true } }; }) })).toMatchObject(OK);
  });

  it('environments: passes when each stage org is a Gearset environment, through the Reporting API', async () => {
    const fetch = fakeGearset();
    const r = await one(ENVS, { edit: gearset(), ...withToken, fetch });
    expect(r).toEqual(expect.objectContaining({ ...OK, detail: 'stage qa → Gearset QA, stage uat → Gearset UAT' }));
    // The first two calls are this check's; the ci tests check after it reads Gearset too.
    expect(fetch.calls.slice(0, 2).map((c) => c.path)).toEqual([PIPELINES, environmentsOf('pipe-1')]);
    expect(fetch.calls[0].headers).toMatchObject({ Authorization: `token ${TOKEN}`, 'api-version': '3.0' });
    expect(JSON.stringify(r.all)).not.toContain(TOKEN);
  });

  it('environments: fails a stage with no environment, naming the stage and its alias', async () => {
    const r = await one(ENVS, { edit: gearset(), ...withToken, fetch: envsAnswer([acmeEnvironment('QA', ACME_QA_ID)]) });
    expect(r).toEqual(expect.objectContaining({ ...FAIL, detail: `stage uat (acme-uat): no Gearset environment deploys to ${ACME_UAT_ID}` }));
  });

  it('environments: fails a stage org that is Gearset production', async () => {
    const r = await one(ENVS, { edit: gearset(), ...withToken, fetch: envsAnswer([acmeEnvironment('QA', ACME_QA_ID), acmeEnvironment('UAT', ACME_UAT_ID, 'Production')]) });
    expect(r).toEqual(expect.objectContaining({ ...FAIL, detail: `stage uat (acme-uat): ${ACME_UAT_ID} is Gearset's production environment; production is never a target` }));
  });

  it('environments: fails a refused token or team', async () => {
    const refused = await one(ENVS, { edit: gearset(), ...withToken, fetch: fakeGearset(acmeGearset({ [PIPELINES]: { status: 401, body: {} } })) });
    expect(refused).toEqual(expect.objectContaining({ ...FAIL, detail: 'Gearset refused GEARSET_API_TOKEN' }));
    const tier = await one(ENVS, { edit: gearset(), ...withToken, fetch: fakeGearset(acmeGearset({ [PIPELINES]: { status: 403, body: {} } })) });
    expect(tier).toEqual(expect.objectContaining({ ...FAIL, detail: "the Gearset Reporting API is not enabled for this token's team (Teams or Enterprise tier)" }));
  });

  it('environments: warns on a rate limit or a network error', async () => {
    const limited = await one(ENVS, { edit: gearset(), ...withToken, fetch: fakeGearset(acmeGearset({ [PIPELINES]: { status: 429, body: {} } })) });
    expect(limited).toEqual(expect.objectContaining({ ...WARN, detail: 'Gearset rate-limited the request; try again later' }));
    const down = await one(ENVS, { edit: gearset(), ...withToken, fetch: fakeGearset(acmeGearset({ [PIPELINES]: new Error(`ECONNRESET ${TOKEN}`) })) });
    expect(down).toEqual(expect.objectContaining({ ...WARN, detail: 'could not reach Gearset' }));
  });

  it('environments: warns "skipped" without a token, and calls nothing', async () => {
    const fetch = fakeGearset();
    const r = await one(ENVS, { edit: gearset(), fetch });
    expect(r).toEqual(expect.objectContaining({ ...WARN, detail: 'skipped: GEARSET_API_TOKEN is not set' }));
    expect(fetch.calls).toEqual([]);
  });

  it('environments: reads only the pipeline salesforce.gearset.pipelineId names', async () => {
    const fetch = fakeGearset(acmeTwoPipelines());
    const r = await one(ENVS, { edit: gearset((b) => { b.gearset = { pipelineId: 'pipe-1' }; }), ...withToken, fetch });
    expect(r).toEqual(expect.objectContaining({ ...OK, detail: 'stage qa → Gearset QA, stage uat → Gearset UAT' }));
    expect(fetch.calls.slice(0, 2).map((c) => c.path)).toEqual([PIPELINES, environmentsOf('pipe-1')]);
    expect(fetch.calls.some((c) => c.path === environmentsOf('pipe-2'))).toBe(false);
    // Unset, every pipeline is searched, and the second QA environment clashes.
    const all = await one(ENVS, { edit: gearset(), ...withToken, fetch: fakeGearset(acmeTwoPipelines()) });
    expect(all).toEqual(expect.objectContaining({ ...FAIL, detail: `stage qa (acme-qa): ${ACME_QA_ID} is the target of several Gearset environments (QA, Legacy QA)` }));
    const unknown = await one(ENVS, { edit: gearset((b) => { b.gearset = { pipelineId: 'pipe-9' }; }), ...withToken, fetch: fakeGearset(acmeTwoPipelines()) });
    expect(unknown).toEqual(expect.objectContaining({ ...FAIL, detail: 'Gearset shows no pipeline pipe-9 to this token' }));
  });

  describe('ci job', () => {
    it("passes when each stage's environment has its CI job on", async () => {
      const r = await one(CI_JOB, { edit: gearset(), ...withToken, fetch: fakeGearset() });
      expect(r).toEqual(expect.objectContaining({ ...OK, detail: 'qa → QA CI job on, uat → UAT CI job on' }));
      expect(JSON.stringify(r.all)).not.toContain(TOKEN);
    });

    it('fails a stage whose environment has no CI job, naming the stage', async () => {
      const r = await one(CI_JOB, { edit: gearset(), ...withToken, fetch: envsAnswer([{ ...acmeEnvironment('QA', ACME_QA_ID), CiJobId: null }, acmeEnvironment('UAT', ACME_UAT_ID, 'Release')]) });
      expect(r).toEqual(expect.objectContaining({ ...FAIL, detail: 'stage qa: Gearset environment QA has no CI job; Gearset deploys each promotion through it' }));
      expect(r.fix.hint).toBe("turn on the CI job of each stage's Gearset environment");
    });

    it('fails a stage whose CI job is turned off', async () => {
      const r = await one(CI_JOB, { edit: gearset(), ...withToken, fetch: envsAnswer([acmeEnvironment('QA', ACME_QA_ID), { ...acmeEnvironment('UAT', ACME_UAT_ID, 'Release'), IsJobEnabled: false }]) });
      expect(r).toEqual(expect.objectContaining({ ...FAIL, detail: 'stage uat: Gearset environment UAT: its CI job is turned off; turn it on in Gearset' }));
    });

    it('skips a stage with no environment, which the environments check reports', async () => {
      const r = await one(CI_JOB, { edit: gearset(), ...withToken, fetch: envsAnswer([acmeEnvironment('QA', ACME_QA_ID)]) });
      expect(r).toEqual(expect.objectContaining({ ...OK, detail: 'qa → QA CI job on' }));
    });

    it('warns "skipped" without a token, and on a rate limit; fails a refused token', async () => {
      const fetch = fakeGearset();
      const none = await one(CI_JOB, { edit: gearset(), fetch });
      expect(none).toEqual(expect.objectContaining({ ...WARN, detail: 'skipped: GEARSET_API_TOKEN is not set' }));
      expect(fetch.calls).toEqual([]);
      const limited = await one(CI_JOB, { edit: gearset(), ...withToken, fetch: fakeGearset(acmeGearset({ [PIPELINES]: { status: 429, body: {} } })) });
      expect(limited).toEqual(expect.objectContaining({ ...WARN, detail: 'Gearset rate-limited the request; try again later' }));
      const refused = await one(CI_JOB, { edit: gearset(), ...withToken, fetch: fakeGearset(acmeGearset({ [PIPELINES]: { status: 401, body: {} } })) });
      expect(refused).toEqual(expect.objectContaining({ ...FAIL, detail: 'Gearset refused GEARSET_API_TOKEN' }));
    });

    it('is tagged sf-gearset, and honours pipelineId', async () => {
      expect(doctorChecks(acmeConfig(gearset()), ctxFor()).find((c) => c.name === CI_JOB).step).toBe('sf-gearset');
      const fetch = fakeGearset(acmeTwoPipelines());
      const r = await one(CI_JOB, { edit: gearset((b) => { b.gearset = { pipelineId: 'pipe-1' }; }), ...withToken, fetch });
      expect(r).toMatchObject(OK);
    });
  });

  describe('ci tests', () => {
    const QA_DEPLOY = '0Af000000000009AAA';
    const UAT_DEPLOY = '0Af000000000008AAA';
    const testsQuery = (id) => `SELECT Id, NumberTestsCompleted FROM DeployRequest WHERE Id = '${id}'`;
    const testsRow = (id, n) => sfOk({ records: [{ Id: id, NumberTestsCompleted: n }], totalSize: 1, done: true });
    const uatDeployment = (over = {}) => acmeDeployment({ PipelineEnvironmentId: 'env-uat', SalesforceFinalDeploymentId: UAT_DEPLOY, Date: '2026-10-20T09:00:00Z', ...over });
    // The deployments operation answers per environment: QA's or UAT's list, by EnvironmentIds.
    const reporting = ({ qa = [acmeDeployment()], uat = [uatDeployment()], post } = {}) => {
      const qaOp = acmeDeployments(qa, { id: 'op-qa' });
      const uatOp = acmeDeployments(uat, { id: 'op-uat' });
      return fakeGearset(acmeGearset({
        ...qaOp,
        ...uatOp,
        [DEPLOYMENTS]: post ?? ((url) => (url.includes('EnvironmentIds=env-uat') ? uatOp[DEPLOYMENTS] : qaOp[DEPLOYMENTS])),
      }));
    };
    const sleepless = { sleep: async () => {} };
    const run = async ({ fetch, routes = {}, ...rest } = {}) => {
      const ctx = { ...ctxFor({ ...withToken, fetch, routes }), ...sleepless, ...rest };
      const r = await runAll(acmeConfig(gearset()), ctx);
      return { ...r[CI_TESTS], ctx, all: r };
    };
    const TESTS_RAN = { [testsQuery(QA_DEPLOY)]: testsRow(QA_DEPLOY, 14), [testsQuery(UAT_DEPLOY)]: testsRow(UAT_DEPLOY, 9) };

    it('warns "skipped" without a token, and calls nothing', async () => {
      const fetch = reporting();
      const r = await one(CI_TESTS, { edit: gearset(), fetch });
      expect(r).toEqual(expect.objectContaining({ ...WARN, detail: 'skipped: GEARSET_API_TOKEN is not set' }));
      expect(r.stages).toEqual([{ name: 'qa', state: 'unknown', tests: null }, { name: 'uat', state: 'unknown', tests: null }]);
      expect(fetch.calls).toEqual([]);
    });

    it('gives each stage its state: ran with the count, none, no-deploy or unknown', async () => {
      const ran = await run({ fetch: reporting(), routes: TESTS_RAN });
      expect(ran.stages).toEqual([{ name: 'qa', state: 'ran', tests: 14 }, { name: 'uat', state: 'ran', tests: 9 }]);
      const none = await run({ fetch: reporting(), routes: { ...TESTS_RAN, [testsQuery(QA_DEPLOY)]: testsRow(QA_DEPLOY, 0) } });
      expect(none.stages).toEqual([{ name: 'qa', state: 'none', tests: 0 }, { name: 'uat', state: 'ran', tests: 9 }]);
      const quiet = await run({ fetch: reporting({ qa: [], uat: [] }) });
      expect(quiet.stages).toEqual([{ name: 'qa', state: 'no-deploy', tests: null }, { name: 'uat', state: 'no-deploy', tests: null }]);
      const failedQuery = await run({ fetch: reporting({ uat: [] }), routes: { [testsQuery(QA_DEPLOY)]: sfError('NoAuthInfoFound', 'No authorization information for acme-qa') } });
      expect(failedQuery.stages).toEqual([{ name: 'qa', state: 'unknown', tests: null }, { name: 'uat', state: 'no-deploy', tests: null }]);
      const failedRead = await run({ fetch: fakeGearset(acmeGearset({ [PIPELINES]: { status: 429, body: {} } })) });
      expect(failedRead.stages).toEqual([{ name: 'qa', state: 'unknown', tests: null }, { name: 'uat', state: 'unknown', tests: null }]);
      expect(failedRead).toMatchObject(WARN);
    });

    it("warns when Gearset's newest deploy to a stage ran no Apex tests", async () => {
      const r = await run({ fetch: reporting(), routes: { ...TESTS_RAN, [testsQuery(QA_DEPLOY)]: testsRow(QA_DEPLOY, 0) } });
      expect(r).toMatchObject(WARN);
      expect(r.detail).toContain(`Gearset's last deploy to qa (${QA_DEPLOY}, 2026-10-15) ran no Apex tests; set a test level on the Gearset QA CI job`);
      expect(r.detail).toContain("Foreman's sf-validate still runs RunLocalTests before each merge");
      expect(JSON.stringify(r.all)).not.toContain(TOKEN);
    });

    it('passes when the tests ran, naming the counts per stage, and queries each stage org', async () => {
      const r = await run({ fetch: reporting(), routes: TESTS_RAN });
      expect(r).toEqual(expect.objectContaining({ ...OK, detail: 'qa: 14 Apex tests in Gearset\'s last deploy; uat: 9 Apex tests in Gearset\'s last deploy' }));
      const lines = r.ctx.sh.sfLines();
      expect(lines).toContain(`data query --use-tooling-api --query ${testsQuery(QA_DEPLOY)} --target-org acme-qa --json`);
      expect(lines).toContain(`data query --use-tooling-api --query ${testsQuery(UAT_DEPLOY)} --target-org acme-uat --json`);
    });

    it('takes the newest Successful deployment', async () => {
      const older = acmeDeployment({ SalesforceFinalDeploymentId: '0Af000000000007AAA', Date: '2026-10-01T09:00:00Z' });
      const failed = acmeDeployment({ Status: 'Failed', SalesforceFinalDeploymentId: '0Af000000000006AAA', Date: '2026-10-21T09:00:00Z' });
      const r = await run({ fetch: reporting({ qa: [older, failed, acmeDeployment()] }), routes: TESTS_RAN });
      expect(r).toMatchObject(OK);
      expect(r.ctx.sh.sfLines().some((l) => l.includes('0Af000000000007AAA') || l.includes('0Af000000000006AAA'))).toBe(false);
    });

    it('passes when there is no Gearset deploy to a stage', async () => {
      const r = await run({ fetch: reporting({ qa: [], uat: [] }) });
      expect(r).toEqual(expect.objectContaining({ ...OK, detail: 'no Gearset deploy to qa in the last 30 days; no Gearset deploy to uat in the last 30 days' }));
      expect(r.ctx.sh.sfLines().some((l) => l.includes('NumberTestsCompleted'))).toBe(false);
    });

    it('warns on a rate limit', async () => {
      const r = await run({ fetch: reporting({ post: { status: 429, body: {} } }) });
      expect(r).toMatchObject(WARN);
      expect(r.detail).toContain('Gearset rate-limited the request; try again later');
    });

    it('never puts a deploy ID it cannot read into SOQL, and warns', async () => {
      const odd = "0Af' OR Id != '";
      const r = await run({ fetch: reporting({ qa: [acmeDeployment({ SalesforceFinalDeploymentId: odd })], uat: [] }) });
      expect(r).toMatchObject(WARN);
      expect(r.detail).toContain('unreadable');
      expect(r.ctx.sh.sfLines().some((l) => l.includes('NumberTestsCompleted'))).toBe(false);
    });

    it('warns when the sf query fails', async () => {
      const r = await run({ fetch: reporting({ uat: [] }), routes: { [testsQuery(QA_DEPLOY)]: sfError('NoAuthInfoFound', 'No authorization information for acme-qa') } });
      expect(r).toMatchObject(WARN);
      expect(r.detail).toContain('qa');
    });

    it('runs only when release is gearset', () => {
      const names = doctorChecks(acmeConfig(addUat()), ctxFor()).map((c) => c.name);
      expect(names).not.toContain(CI_TESTS);
      const ci = doctorChecks(acmeConfig((b) => { b.release = 'ci'; }), ctxFor()).map((c) => c.name);
      expect(ci).not.toContain(CI_TESTS);
      expect(doctorChecks(acmeConfig(gearset()), ctxFor()).map((c) => c.name)).toContain(CI_TESTS);
    });
  });
});

// A workflow that runs on push to `branch` and deploys force-app to `alias`.
const deployWorkflow = (branch, alias) => [
  'name: deploy',
  'on:',
  '  push:',
  `    branches: [${branch}]`,
  'jobs:',
  '  deploy:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/checkout@v4',
  `      - run: sf project deploy start --source-dir force-app -o ${alias}`,
  '',
].join('\n');
const writeWorkflow = (root, text) => {
  fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github', 'workflows', 'deploy.yml'), text);
};

describe('salesforce workflows', () => {
  const WORKFLOWS = 'salesforce workflows';
  it('is ok "no workflows" on the Acme block without any', async () => {
    expect(await one(WORKFLOWS)).toEqual(expect.objectContaining({ ...OK, detail: 'no workflows' }));
  });
  it('fails a qa-push deploy to acme-prod', async () => {
    writeWorkflow(dir, deployWorkflow('qa', 'acme-prod'));
    expect(await one(WORKFLOWS)).toEqual(expect.objectContaining({
      ...FAIL,
      detail: '.github/workflows/deploy.yml on qa: deploys to an org not in salesforce.orgs',
    }));
  });
  it('fails a qa-push deploy to acme-prod on release "ci" too', async () => {
    writeWorkflow(dir, deployWorkflow('qa', 'acme-prod'));
    expect(await one(WORKFLOWS, { edit: (b) => { b.release = 'ci'; } })).toEqual(expect.objectContaining({
      ...FAIL,
      detail: '.github/workflows/deploy.yml on qa: deploys to an org not in salesforce.orgs',
    }));
  });
  it('runs no sf and no git', async () => {
    writeWorkflow(dir, deployWorkflow('qa', 'acme-qa'));
    const ctx = ctxFor();
    const check = doctorChecks(acmeConfig(), ctx).find((c) => c.name === WORKFLOWS);
    expect(await check.run(ctx)).toEqual({ ...OK, detail: '1 deploy on qa, all to orgs in salesforce.orgs' });
    expect(ctx.sh.calls).toHaveLength(0);
  });
});

describe('salesforce ci', () => {
  const CI = 'salesforce ci';
  const PR_WORKFLOW = 'name: ci\non: pull_request\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n';
  const writeCi = (name = 'ci.yml') => {
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.github', 'workflows', name), PR_WORKFLOW);
  };
  const OWN_STEPS = { steps: ['sf-org-guard', 'merge-main', 'sf-delta', 'push', 'pr', 'ci', 'sf-validate', 'mergeable-recheck', 'merge', 'sf-deploy-qa', 'sf-verify-qa'] };
  const own = (ship = OWN_STEPS) => (b, file) => { file.ship = ship; };
  const WARNING = (minutes) => `ship.steps has ci, but no CI runs on pull requests into qa: the ci step will wait ${minutes} and then fail every release`;
  const NO_CI = 'no CI runs on pull requests into qa; sf-validate is the check';

  it('is ok when no CI runs on pull requests and the pack left ci out', async () => {
    expect(await one(CI)).toEqual(expect.objectContaining({ ...OK, detail: NO_CI }));
  });
  it('is ok and names the workflow that runs on pull requests', async () => {
    writeCi();
    expect(await one(CI)).toEqual(expect.objectContaining({ ...OK, detail: 'CI on pull requests: ci.yml' }));
  });
  it('names at most five workflows', async () => {
    for (let n = 1; n <= 7; n += 1) writeCi(`ci-${n}.yml`);
    expect((await one(CI)).detail).toBe('CI on pull requests: ci-1.yml, ci-2.yml, ci-3.yml, ci-4.yml, ci-5.yml and 2 more');
  });
  it("warns when the project's own ship.steps name ci and no workflow runs on pull requests", async () => {
    const r = await one(CI, { edit: own() });
    expect(r).toEqual(expect.objectContaining({ ...WARN, detail: WARNING('30 minutes') }));
  });
  it('names ship.ci.timeoutMinutes, and the singular for one minute', async () => {
    const withTimeout = (minutes) => own({ ...OWN_STEPS, ci: { required: [], timeoutMinutes: minutes } });
    expect((await one(CI, { edit: withTimeout(45) })).detail).toBe(WARNING('45 minutes'));
    expect((await one(CI, { edit: withTimeout(1) })).detail).toBe(WARNING('1 minute'));
  });
  it('warns for a push-only deploy workflow when the steps name ci', async () => {
    writeWorkflow(dir, deployWorkflow('qa', 'acme-qa'));
    expect(await one(CI, { edit: own() })).toEqual(expect.objectContaining({ ...WARN, detail: WARNING('30 minutes') }));
    expect(await one(CI)).toEqual(expect.objectContaining({ ...OK, detail: NO_CI }));
  });
  it('is ok when the steps name ci and a workflow runs on pull requests', async () => {
    writeCi();
    expect(await one(CI, { edit: own() })).toEqual(expect.objectContaining({ ...OK, detail: 'CI on pull requests: ci.yml' }));
  });
  it('carries a fix hint on the warning', async () => {
    const ctx = ctxFor();
    const check = doctorChecks(acmeConfig(own()), ctx).find((c) => c.name === CI);
    const r = await check.run(ctx);
    expect(r.fix?.hint).toBe('take ci out of ship.steps, or add a workflow that runs on pull_request');
  });
  it('warns when .github/workflows cannot be read', async () => {
    const denied = { ...fs, readdirSync: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } };
    const ctx = { ...ctxFor(), fs: denied };
    const check = doctorChecks(acmeConfig(), ctx).find((c) => c.name === CI);
    expect(await check.run(ctx)).toEqual(expect.objectContaining({ ...WARN, detail: 'could not read .github/workflows' }));
  });
  it('runs no sf and no git', async () => {
    const ctx = ctxFor();
    const check = doctorChecks(acmeConfig(), ctx).find((c) => c.name === CI);
    await check.run(ctx);
    expect(ctx.sh.calls).toHaveLength(0);
  });
});

describe('salesforce skills lock', () => {
  const LOCK = 'salesforce skills lock';
  it('is ok "<n> skills from forcedotcom/sf-skills"', async () => {
    expect(await one(LOCK)).toEqual(expect.objectContaining({ ...OK, detail: '2 skills from forcedotcom/sf-skills' }));
  });
  it('warns when there is no skills-lock.json', async () => {
    fs.rmSync(path.join(dir, 'skills-lock.json'));
    const r = await one(LOCK);
    expect(r).toEqual(expect.objectContaining({ ...WARN, detail: "no skills-lock.json; the pack's agents need forcedotcom/sf-skills at tag 1.66.0" }));
  });
  it('fails without naming a source that holds a user name or token', async () => {
    for (const source of ['https://acme:t0ken@git.acme.example/skills.git', 'https://git.acme.example/skills.git?access_token=t0ken']) {
      const edit = (b) => { b.skills = { source, tag: '1.66.0' }; };
      const states = [
        ['installed', () => writeInstalled(dir, INSTALLED, SOURCE)],
        ['missing', () => fs.rmSync(path.join(dir, 'skills-lock.json'))],
        ['matching', () => writeInstalled(dir, INSTALLED, source)],
      ];
      for (const [state, setUp] of states) {
        setUp();
        const r = await one(LOCK, { edit });
        expect(r, `${source} ${state}`).toEqual(expect.objectContaining({ ...FAIL, detail: CREDENTIALS_REASON }));
        expect(r.detail).not.toContain('t0ken');
        for (const [name, check] of Object.entries(r.all)) expect(String(check.detail ?? ''), `${state} ${name}`).not.toContain('t0ken');
      }
    }
  });
  it('fails on bad JSON, version 2 and empty skills', async () => {
    for (const lock of ['{ nope', { version: 2, skills: { a: skill() } }, { version: 1, skills: {} }, { version: 1, skills: [] }, { version: 1 }]) {
      writeLock(lock);
      expect(await one(LOCK), JSON.stringify(lock)).toMatchObject(FAIL);
    }
  });
  it('fails on skills from another source, naming up to five', async () => {
    const skills = { good: skill() };
    for (const n of [1, 2, 3, 4, 5, 6, 7]) skills[`other-${n}`] = skill('someone/else');
    writeLock({ version: 1, skills });
    const r = await one(LOCK);
    expect(r).toMatchObject(FAIL);
    expect(r.detail).toContain('other-1, other-2, other-3, other-4, other-5');
    expect(r.detail).not.toContain('other-6');
    expect(r.detail).not.toContain('good');
  });

  const skillFile = (...parts) => path.join(dir, '.agents', 'skills', ...parts);
  const changed = { ...FAIL, detail: 'changed since install: sf-apex; run `foreman sf skills` to restore them' };

  it('fails when an installed file is edited, or a file is added', async () => {
    const file = skillFile('sf-apex', 'SKILL.md');
    const text = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, text.replace('A', 'B'));
    expect(await one(LOCK)).toEqual(expect.objectContaining(changed));
    fs.writeFileSync(file, text);
    expect(await one(LOCK)).toMatchObject(OK);
    fs.writeFileSync(skillFile('sf-apex', 'extra.md'), 'more\n');
    expect(await one(LOCK)).toEqual(expect.objectContaining(changed));
  });
  it('fails when a skill is not installed, or not linked into .claude/skills', async () => {
    fs.rmSync(path.join(dir, '.claude', 'skills', 'sf-lwc'));
    expect(await one(LOCK)).toEqual(expect.objectContaining({ ...FAIL, detail: 'not in .claude/skills: sf-lwc; run `foreman sf skills`' }));
    fs.rmSync(skillFile('sf-lwc'), { recursive: true });
    expect(await one(LOCK)).toEqual(expect.objectContaining({ ...FAIL, detail: 'not installed: sf-lwc; run `foreman sf skills`' }));
  });
  it('fails a lock entry whose name is not a skill name, without reading outside the skills folders', async () => {
    const lock = JSON.parse(fs.readFileSync(path.join(dir, 'skills-lock.json'), 'utf8'));
    lock.skills['../x'] = { ...lock.skills['sf-apex'] };
    writeLock(lock);
    expect(await one(LOCK)).toEqual(expect.objectContaining({ ...FAIL, detail: 'not installed: ../x; run `foreman sf skills`' }));
  });
  it('fails when the lock is at another tag, and passes a lock with no ref', async () => {
    writeInstalled(dir, INSTALLED, SOURCE, { ref: '1.65.0' });
    expect(await one(LOCK)).toEqual(expect.objectContaining({
      ...FAIL,
      detail: 'skills-lock.json is at tag 1.65.0, salesforce.skills.tag is 1.66.0; run `foreman sf skills`',
    }));
    writeInstalled(dir, INSTALLED, SOURCE, { ref: null });
    expect(await one(LOCK)).toEqual(expect.objectContaining({ ...OK, detail: '2 skills from forcedotcom/sf-skills' }));
  });
  it('names five changed skills, then how many more', async () => {
    const many = {};
    for (const n of [1, 2, 3, 4, 5, 6, 7]) many[`sf-s${n}`] = { 'SKILL.md': `# ${n}\n` };
    writeInstalled(dir, many, SOURCE);
    for (const n of [1, 2, 3, 4, 5, 6, 7]) fs.writeFileSync(skillFile(`sf-s${n}`, 'SKILL.md'), 'edited\n');
    const r = await one(LOCK);
    expect(r).toEqual(expect.objectContaining({
      ...FAIL,
      detail: 'changed since install: sf-s1, sf-s2, sf-s3, sf-s4, sf-s5 and 2 more; run `foreman sf skills` to restore them',
    }));
  });
});

describe('salesforce skills named', () => {
  const NAMED = 'salesforce skills named';
  const agent = (name, text) => {
    const file = path.join(dir, 'plugin', 'agents', `${name}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const developer = (b, file) => { file.roles = { builders: { developer: { agent: 'foreman:sf-developer', use: 'everything' } } }; };

  it('is ok when no pack agent names a skill', async () => {
    expect(await one(NAMED)).toEqual(expect.objectContaining({ ...OK, detail: 'no pack agent names a skill' }));
    agent('sf-developer', '---\nname: sf-developer\n---\nBuild Acme things.\n');
    expect(await one(NAMED, { edit: developer })).toEqual(expect.objectContaining({ ...OK, detail: 'no pack agent names a skill' }));
  });
  it('fails for a named skill missing from the lock, and is ok once it is installed', async () => {
    agent('sf-developer', '---\nname: sf-developer\nskills: sf-apex, platform-soql-query\n---\nBuild Acme things.\n');
    expect(await one(NAMED, { edit: developer })).toEqual(expect.objectContaining({
      ...FAIL,
      detail: 'missing from skills-lock.json: sf-developer: platform-soql-query',
    }));
    writeInstalled(dir, { ...INSTALLED, 'platform-soql-query': { 'SKILL.md': '# SOQL for Acme\n' } }, SOURCE);
    expect(await one(NAMED, { edit: developer })).toEqual(expect.objectContaining({ ...OK, detail: '2 named skills, all in skills-lock.json' }));
  });
  it('fails, naming the count, when skills are named and there is no lock', async () => {
    agent('sf-developer', '---\nskills: [sf-apex, sf-lwc]\n---\n');
    fs.rmSync(path.join(dir, 'skills-lock.json'));
    expect(await one(NAMED, { edit: developer })).toEqual(expect.objectContaining({
      ...FAIL,
      detail: 'pack agents name 2 skills but skills-lock.json is missing; run `foreman sf skills`',
    }));
    writeLock('{ nope');
    const bad = await one(NAMED, { edit: developer });
    expect(bad).toMatchObject(FAIL);
    expect(bad.detail).toMatch(/^pack agents name 2 skills but skills-lock.json is not valid JSON; run `foreman sf skills`$/);
  });
  it('reads only foreman: agents with a plain name, from the plugin agents folder', async () => {
    fs.mkdirSync(path.join(dir, 'plugin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugin', 'x.md'), '---\nskills: outside\n---\n');
    agent('local-dev', '---\nskills: not-read\n---\n');
    const edit = (b, file) => {
      file.roles = {
        architect: { agent: 'foreman:../x' },
        builders: { developer: { agent: 'local-dev', use: 'everything' } },
      };
    };
    expect(await one(NAMED, { edit })).toEqual(expect.objectContaining({ ...OK, detail: 'no pack agent names a skill' }));
  });
});

describe('salesforce telemetry', () => {
  const TELE = 'salesforce telemetry';
  const on = { [TELEMETRY]: sfOk([{ name: 'disable-telemetry', value: undefined, success: true }]) };
  it('is ok with SF_DISABLE_TELEMETRY=true in the environment, without asking sf', async () => {
    const r = await one(TELE, { env: { SF_DISABLE_TELEMETRY: 'true' }, routes: on });
    expect(r).toMatchObject(OK);
    expect(r.ctx.sh.sfLines().some((l) => l.includes('disable-telemetry'))).toBe(false);
  });
  it('is ok with it only in .env.local, or with DO_NOT_TRACK', async () => {
    fs.writeFileSync(path.join(dir, '.env.local'), 'SF_DISABLE_TELEMETRY=1\n');
    expect(await one(TELE, { routes: on })).toMatchObject(OK);
    fs.rmSync(path.join(dir, '.env.local'));
    expect(await one(TELE, { env: { DO_NOT_TRACK: 'yes' }, routes: on })).toMatchObject(OK);
    expect(await one(TELE, { env: { DO_NOT_TRACK: '0' }, routes: on })).toMatchObject(WARN);
  });
  it('is ok when sf config says disable-telemetry is true', async () => {
    expect(await one(TELE)).toMatchObject(OK);
    expect(await one(TELE, { routes: { [TELEMETRY]: sfOk([{ name: 'disable-telemetry', value: true }]) } })).toMatchObject(OK);
  });
  it('warns otherwise', async () => {
    const r = await one(TELE, { routes: on });
    expect(r).toEqual(expect.objectContaining({
      ...WARN,
      detail: 'Salesforce CLI telemetry is on; set SF_DISABLE_TELEMETRY=true in .env.local or run `sf config set disable-telemetry true --global`',
    }));
    expect(await one(TELE, { routes: { [TELEMETRY]: sfError('SfError', 'broken') } })).toMatchObject(WARN);
  });
});

describe('salesforce CONFIRM_PROD', () => {
  const CONFIRM = 'salesforce CONFIRM_PROD';
  it('fails when it is in the environment, without printing the value', async () => {
    const r = await one(CONFIRM, { env: { CONFIRM_PROD: SECRET } });
    expect(r).toMatchObject(FAIL);
    expect(r.detail).toBe('CONFIRM_PROD is set in the environment or .env.local; Foreman never sets it, remove it');
    expect(JSON.stringify(r.all)).not.toContain(SECRET);
  });
  it('fails when it is in .env.local, even when empty', async () => {
    fs.writeFileSync(path.join(dir, '.env.local'), `OTHER=1\nCONFIRM_PROD=${SECRET}\n`);
    const r = await one(CONFIRM);
    expect(r).toMatchObject(FAIL);
    expect(JSON.stringify(r.all)).not.toContain(SECRET);
    fs.writeFileSync(path.join(dir, '.env.local'), 'CONFIRM_PROD=\n');
    expect(await one(CONFIRM)).toMatchObject(FAIL);
  });
  it('fails when a check command holds --I-CONFIRM-PROD or CONFIRM_PROD', async () => {
    const flag = await one(CONFIRM, { edit: (b, file) => { file.checks = [{ run: `sf project deploy start --I-CONFIRM-PROD ${SECRET}`, when: 'always' }]; } });
    expect(flag).toMatchObject(FAIL);
    expect(flag.detail).not.toContain(SECRET);
    const name = await one(CONFIRM, { edit: (b, file) => { file.checks = [{ run: 'npm test' }, { run: `CONFIRM_PROD=${SECRET} npm run deploy` }]; } });
    expect(name).toMatchObject(FAIL);
    expect(name.detail).not.toContain(SECRET);
  });
  it('fails when a check\'s quick command holds --I-CONFIRM-PROD or CONFIRM_PROD, naming checks[i].quick', async () => {
    const flag = await one(CONFIRM, { edit: (b, file) => { file.checks = [{ run: 'npm test', when: 'always', quick: `sf project deploy start --I-CONFIRM-PROD ${SECRET}` }]; } });
    expect(flag).toMatchObject(FAIL);
    expect(flag.detail).toBe('checks[0].quick confirms a production deploy (CONFIRM_PROD or --I-CONFIRM-PROD); Foreman never does, remove it');
    expect(flag.detail).not.toContain(SECRET);
    const name = await one(CONFIRM, { edit: (b, file) => { file.checks = [{ run: 'npm test', when: 'always' }, { run: 'npm run lint', when: 'always', quick: `CONFIRM_PROD=${SECRET} npm run deploy` }]; } });
    expect(name).toMatchObject(FAIL);
    expect(name.detail).toContain('checks[1].quick');
    expect(name.detail).not.toContain(SECRET);
    expect(JSON.stringify(name)).not.toContain(SECRET);
  });
  it('is ok otherwise', async () => {
    expect(await one(CONFIRM)).toEqual(expect.objectContaining({ ...OK, detail: '' }));
  });
});

describe('the isolated sf home', () => {
  const isolated = (call) => call.opts?.env?.HOME === sfHome && call.opts?.env?.SF_USE_GENERIC_UNIX_KEYCHAIN === 'true';
  it('runs the org and source tracking queries in it, and the tools check outside it', async () => {
    const ctx = ctxFor();
    const res = await runAll(acmeConfig(), ctx);
    expect(res['salesforce source tracking acme-dev1']).toMatchObject(OK);
    const { sh } = ctx;
    const of = (text) => sh.calls.filter((c) => c.cmd === 'sf' && c.args.join(' ').includes(text));
    for (const text of ['FROM Organization', 'FROM SourceMember', 'org list']) {
      expect(of(text).length, text).toBeGreaterThan(0);
      for (const call of of(text)) expect(isolated(call), text).toBe(true);
    }
    expect(of('plugins --core')).toHaveLength(1);
    expect(of('plugins --core')[0].opts.env).toBeUndefined();
  });
});

describe('salesforce sf isolation', () => {
  const ISO = 'salesforce sf isolation';
  const STRAY = acmeOrg('acme-prod', '00D000000000009AAA');
  const homeOf = (...entries) => ({ [ORG_LIST]: orgList(entries) });

  it('is ok when the home holds only the configured sandboxes', async () => {
    const r = await one(ISO);
    expect(r).toEqual(expect.objectContaining({ ...OK, detail: `${sfHome}: 2 orgs, all allow-listed sandboxes` }));
    const list = r.ctx.sh.calls.find((c) => c.args.join(' ').includes('org list'));
    expect(list.args).toEqual(['org', 'list', '--all', '--skip-connection-status', '--json']);
  });
  it('fails on a stray org, and runs no sf call that targets it', async () => {
    const r = await one(ISO, { routes: homeOf(acmeOrg('acme-dev1', ACME_DEV1_ID), STRAY) });
    expect(r).toMatchObject(FAIL);
    expect(r.detail).toContain('acme-prod (00D000000000009AAA)');
    expect(r.detail).toContain('salesforce.orgs');
    expect(r.detail).not.toContain(STRAY.username);
    expect(r.ctx.sh.sfLines().some((l) => l.includes('acme-prod') || l.includes(STRAY.username))).toBe(false);
  });
  it('fails when an org in the home is not a sandbox', async () => {
    const r = await one(ISO, { routes: { [orgRoute('acme-qa')]: orgRecord(ACME_QA_ID, false) } });
    expect(r).toEqual(expect.objectContaining({ ...FAIL, detail: 'acme-qa in the isolated sf home is not a sandbox and salesforce.orgs does not mark it "production": true; deployments to production are blocked' }));
  });
  it('fails when there is no sf on PATH', async () => {
    const r = await one(ISO, { env: { PATH: path.join(aux, 'nothing') } });
    expect(r).toMatchObject(FAIL);
    expect(r.detail).toContain('sf is not on PATH');
  });
  it('fails when FOREMAN_SF_HOME is not absolute', async () => {
    const r = await one(ISO, { env: { FOREMAN_SF_HOME: '~/sf-home' } });
    expect(r).toEqual(expect.objectContaining({ ...FAIL, detail: 'FOREMAN_SF_HOME must be an absolute path, not ~/sf-home' }));
    expect(r.ctx.sh.sfLines().some((l) => l.includes('org list'))).toBe(false);
  });
  it('warns when the home does not exist yet', async () => {
    const missing = path.join(aux, 'no-home');
    const r = await one(ISO, { env: { FOREMAN_SF_HOME: missing } });
    expect(r).toEqual(expect.objectContaining({ ...WARN, detail: `the isolated sf home ${missing} does not exist yet; sign each org in there (see the org checks)` }));
  });
  it('fails when the home cannot be listed', async () => {
    const r = await one(ISO, { routes: { [ORG_LIST]: sfError('SfError', 'broken') } });
    expect(r).toMatchObject(FAIL);
    expect(r.detail).toContain('could not list the orgs in the isolated sf home');
  });
  it('queries each org once across the org checks and this one', async () => {
    const r = await one(ISO);
    for (const alias of ['acme-dev1', 'acme-qa']) expect(r.ctx.sh.sfLines().filter((l) => l.includes(orgRoute(alias))), alias).toHaveLength(1);
  });
});

describe('a production org marked "production": true', () => {
  const MAIN = 'salesforce org acme-main (production)';
  const HUB = 'salesforce org acme-main (production, scratch dev hub)';
  const ENTRIES = [acmeOrg('acme-dev1', ACME_DEV1_ID), acmeOrg('acme-qa', ACME_QA_ID), acmeOrg('acme-main', ACME_PROD_ID)];
  const homeWithMain = (answer = orgRecord(ACME_PROD_ID, false), entries = ENTRIES) => ({ [ORG_LIST]: orgList(entries), [orgRoute('acme-main')]: answer });
  const addMain = (b) => { b.orgs['acme-main'] = { orgId: ACME_PROD_ID, production: true }; };
  const scratchOnMain = (b) => {
    delete b.orgs['acme-dev1'];
    addMain(b);
    b.build = { scratch: { devHub: 'acme-main', definition: 'config/project-scratch-def.json' } };
  };
  const toMain = (ctx) => ctx.sh.sfLines().filter((l) => / acme-main( |$)/.test(l));

  it('is ok "production (connected; deployments blocked)", with no baseline, agentforce or tracking call to it', async () => {
    const ctx = ctxFor({ routes: homeWithMain() });
    const res = await runAll(acmeConfig(addMain), ctx);
    expect(res[MAIN]).toEqual(expect.objectContaining({ ...OK, detail: 'production (connected; deployments blocked)' }));
    expect(doctorChecks(acmeConfig(addMain), ctxFor()).find((c) => c.name === MAIN).step).toBe('sf-orgs');
    expect(Object.keys(res).filter((name) => name.includes('acme-main'))).toEqual([MAIN]);
    expect(toMain(ctx)).toEqual([`data query --query SELECT Id, IsSandbox FROM Organization --target-org acme-main --json`]);
    expect(res['salesforce sf isolation']).toEqual(expect.objectContaining({ ...OK, detail: `${sfHome}: 3 orgs: 2 allow-listed sandboxes, 1 production (connected; deployments blocked)` }));
    expect(res['salesforce layout'].detail).toContain('production acme-main: connected; deployments blocked, data changes not blocked');
    for (const [name, r] of Object.entries(res)) expect(r, name).toMatchObject(OK);
  });
  it('names it the scratch dev hub when it is one, and checks it the same way', async () => {
    const ctx = ctxFor({ routes: homeWithMain(undefined, [acmeOrg('acme-qa', ACME_QA_ID), acmeOrg('acme-main', ACME_PROD_ID)]) });
    const res = await runAll(acmeConfig(scratchOnMain), ctx);
    expect(Object.keys(res).filter((name) => name.startsWith('salesforce org '))).toEqual(['salesforce org build', 'salesforce org acme-qa (stage qa)', HUB]);
    expect(res[HUB]).toEqual(expect.objectContaining({ ...OK, detail: 'production (connected; deployments blocked)' }));
    expect(res['salesforce sf isolation']).toMatchObject(OK);
    expect(toMain(ctx)).toHaveLength(1);
    expect(res['salesforce layout'].detail).toContain('production acme-main: connected; deployments blocked, data changes not blocked');
  });
  it("accepts a running story's scratch org that the state folder records, and only then", async () => {
    const SCRATCH_ID = '00D000000000101AAA';
    const scratch = { alias: 'foreman-acme-1', username: 'test-acme-1@scratch.acme.example', orgId: SCRATCH_ID, isSandbox: true };
    const ACTIVE = 'FROM ActiveScratchOrg';
    const activeRows = (ids) => sfOk({ records: ids.map((id) => ({ attributes: { type: 'ActiveScratchOrg' }, ScratchOrg: id })), totalSize: ids.length, done: true });
    const routes = { ...homeWithMain(undefined, [acmeOrg('acme-qa', ACME_QA_ID), acmeOrg('acme-main', ACME_PROD_ID), scratch]), [orgRoute('foreman-acme-1')]: orgRecord(SCRATCH_ID), [ACTIVE]: activeRows(['00D000000000101']) };
    const stray = await runAll(acmeConfig(scratchOnMain), ctxFor({ routes }));
    expect(stray['salesforce sf isolation']).toMatchObject(FAIL);
    expect(stray['salesforce sf isolation'].detail).toContain(`foreman-acme-1 (${SCRATCH_ID})`);

    const record = { story: 'ACME-1', slot: 'w1', alias: 'foreman-acme-1', devHub: 'acme-main', state: 'ready', jobId: '2SR000000000101AAA', username: scratch.username, orgId: SCRATCH_ID, createdAt: '2026-10-25T10:00:00.000Z' };
    writeScratchOrg(path.join(dir, '.foreman'), record);
    const ctx = ctxFor({ routes });
    const res = await runAll(acmeConfig(scratchOnMain), ctx);
    expect(res['salesforce sf isolation']).toEqual(expect.objectContaining({ ...OK, detail: `${sfHome}: 3 orgs: 1 allow-listed sandbox, 1 story scratch org, 1 production (connected; deployments blocked)` }));
    expect(ctx.sh.sfLines().filter((l) => l.includes(ACTIVE))).toEqual([`data query --query SELECT ScratchOrg ${ACTIVE} WHERE ScratchOrg IN ('00D000000000101') --target-org acme-main --json`]);

    const inactive = await runAll(acmeConfig(scratchOnMain), ctxFor({ routes: { ...routes, [ACTIVE]: activeRows([]) } }));
    expect(inactive['salesforce sf isolation']).toMatchObject(FAIL);
    expect(inactive['salesforce sf isolation'].detail).toContain('has no active scratch org');

    const unreachable = await runAll(acmeConfig(scratchOnMain), ctxFor({ routes: { ...routes, [ACTIVE]: sfError('NamedOrgNotFoundError', 'No authorization information found for admin@acme-main.acme.example.') } }));
    expect(unreachable['salesforce sf isolation']).toMatchObject(FAIL);
    expect(unreachable['salesforce sf isolation'].detail).toContain('could not check the story scratch orgs on the Dev Hub acme-main: ');
    expect(unreachable['salesforce sf isolation'].detail).not.toContain('@');

    writeScratchOrg(path.join(dir, '.foreman'), { ...record, devHub: 'acme-other' });
    const otherHub = await runAll(acmeConfig(scratchOnMain), ctxFor({ routes }));
    expect(otherHub['salesforce sf isolation']).toMatchObject(FAIL);
    expect(otherHub['salesforce sf isolation'].detail).toContain('not in salesforce.orgs');
  });
  it('still leaves out an unmarked scratch dev hub', async () => {
    const edit = (b) => {
      scratchOnMain(b);
      delete b.orgs['acme-main'].production;
    };
    const res = await runAll(acmeConfig(edit), ctxFor({ routes: homeWithMain() }));
    expect(Object.keys(res).some((name) => name.includes('acme-main'))).toBe(false);
  });
  it('fails a marked org whose server says it is a sandbox, with the hint to remove the mark', async () => {
    const res = await runAll(acmeConfig(addMain), ctxFor({ routes: homeWithMain(orgRecord(ACME_PROD_ID)) }));
    expect(res[MAIN]).toMatchObject({ ...FAIL, detail: 'acme-main is marked "production": true in salesforce.orgs, but it is a sandbox' });
    expect(res[MAIN].fix.hint).toBe('remove "production": true from acme-main in salesforce.orgs');
  });
  it('fails a marked org with another org ID', async () => {
    const res = await runAll(acmeConfig(addMain), ctxFor({ routes: homeWithMain(orgRecord('00D000000000009AAA', false)) }));
    expect(res[MAIN]).toMatchObject({ ...FAIL, detail: `acme-main is org 00D000000000009, not ${ACME_PROD_ID}` });
  });
  it('gives the production login URL when it is not signed in', async () => {
    const res = await runAll(acmeConfig(addMain), ctxFor({ routes: homeWithMain(sfError('NamedOrgNotFoundError', 'No authorization information found for acme-main.', 2), ENTRIES.slice(0, 2)) }));
    expect(res[MAIN]).toMatchObject(FAIL);
    expect(res[MAIN].detail).toContain('sf org login jwt --alias acme-main --username <user>');
    expect(res[MAIN].detail).toContain('--instance-url https://login.salesforce.com');
  });
});

describe('the org checks and the isolated sf home', () => {
  const QA = 'salesforce org acme-qa (stage qa)';
  const DEV1 = 'salesforce org acme-dev1 (build)';
  const ORG_CHECKS = [DEV1, QA];

  it('fails an alias the home maps to an org not in salesforce.orgs, and makes no call to it', async () => {
    const ctx = ctxFor({ routes: { [ORG_LIST]: orgList([acmeOrg('acme-dev1', ACME_DEV1_ID), acmeOrg('acme-qa', '00D000000000009AAA')]) } });
    const res = await runAll(acmeConfig(), ctx);
    expect(res[QA]).toMatchObject(FAIL);
    expect(res[QA].detail).toContain('acme-qa (00D000000000009AAA)');
    expect(res[QA].detail).toContain('salesforce.orgs');
    expect(res[QA].fix.hint).toBe("keep only the sandboxes in salesforce.orgs in Foreman's sf home");
    expect(ctx.sh.sfLines().filter((l) => l.includes('--target-org acme-qa'))).toEqual([]);
    expect(res[DEV1]).toMatchObject(OK);
    expect(res['salesforce sf isolation']).toMatchObject(FAIL);
  });
  it('fails every org check when the home cannot be listed, with no query', async () => {
    const ctx = ctxFor({ routes: { [ORG_LIST]: sfError('SfError', 'broken') } });
    const res = await runAll(acmeConfig(), ctx);
    for (const name of ORG_CHECKS) {
      expect(res[name], name).toMatchObject(FAIL);
      expect(res[name].detail, name).toContain('could not list the orgs');
    }
    expect(ctx.sh.sfLines().filter((l) => l.includes('--target-org'))).toEqual([]);
  });
  it('runs org list once per doctor run', async () => {
    const ctx = ctxFor();
    await runAll(acmeConfig(), ctx);
    expect(ctx.sh.sfLines().filter((l) => l.includes('org list'))).toHaveLength(1);
  });
  it('fails every org check on a relative FOREMAN_SF_HOME, with no sf call to the home', async () => {
    const ctx = ctxFor({ env: { FOREMAN_SF_HOME: '~/sf-home' } });
    const res = await runAll(acmeConfig(), ctx);
    for (const name of ORG_CHECKS) {
      expect(res[name], name).toMatchObject(FAIL);
      expect(res[name].detail, name).toContain('FOREMAN_SF_HOME must be an absolute path');
    }
    expect(ctx.sh.sfLines().filter((l) => l.includes('org list') || l.includes('--target-org'))).toEqual([]);
  });
});

describe('salesforce plugin', () => {
  const PLUGIN = 'salesforce plugin';
  const list = (status) => `Installed plugins:\n\n  ❯ foreman@foreman\n    Version: 0.1.0\n    Status: ✔ enabled\n\n  ❯ salesforce-development@salesforce\n    Version: 1.0.0\n    Scope: user\n    Status: ${status}\n`;
  const claude = (answer) => (cmd, args = []) => {
    if (cmd === 'claude' && args.join(' ') === 'plugin list') return answer;
    return gitFallback()(cmd, args);
  };

  it('warns when salesforce-development is enabled', async () => {
    const r = await one(PLUGIN, { fallback: claude({ status: 0, stdout: list('✔ enabled'), stderr: '' }) });
    expect(r).toEqual(expect.objectContaining({ ...WARN, detail: 'salesforce-development is enabled for you; Foreman turns it off for its own runs' }));
    expect(r.fix.hint).toBe('nothing to do: Foreman turns the plugin off for its own runs');
  });
  it('is ok when it is disabled or not installed', async () => {
    expect(await one(PLUGIN, { fallback: claude({ status: 0, stdout: list('✘ disabled'), stderr: '' }) })).toMatchObject(OK);
    expect(await one(PLUGIN, { fallback: claude({ status: 0, stdout: 'Installed plugins:\n', stderr: '' }) })).toMatchObject(OK);
  });
  it('warns when the list cannot be read', async () => {
    const r = await one(PLUGIN, { fallback: claude({ status: 1, stdout: '', stderr: 'claude: not found' }) });
    expect(r).toEqual(expect.objectContaining({ ...WARN, detail: 'could not read `claude plugin list`' }));
    expect(r.fix.hint).toBe('check that `claude plugin list` works in this project');
    expect(r.fix.hint).not.toMatch(/nothing to do/);
  });
});

describe('salesforce baseline', () => {
  const QA = 'salesforce baseline acme-qa (stage qa)';
  const DEV1 = 'salesforce baseline acme-dev1 (build)';
  const LEVEL = 'salesforce test level';
  const RUN2 = '707000000000002AAA';
  const START = 'apex run test --test-level RunLocalTests';
  const RUN_RESULT = 'FROM ApexTestRunResult';
  const TEST_RESULT = 'FROM ApexTestResult ';
  const COVERAGE = 'FROM ApexOrgWideCoverage';
  const rows = (records) => sfOk({ records, totalSize: records.length, done: true });
  const statusOf = (Status) => rows([{ Status }]);
  const failed = (cls, method) => ({ ApexClass: { Name: cls }, MethodName: method });
  const completed = (failing = [], percent = 82) => ({
    [RUN_RESULT]: statusOf('Completed'),
    [TEST_RESULT]: rows(failing.map(([cls, method]) => failed(cls, method))),
    [COVERAGE]: rows([{ PercentCovered: percent }]),
  });
  const BAD = { failing: ['AcmeServiceTest.sumsTheOrder'], coverage: 19 };
  const apexLines = (sh) => sh.sfLines().filter((l) => /apex run test|ApexTestRunResult|ApexTestResult|ApexOrgWideCoverage/.test(l));

  it('runs one check per org with a role, after source tracking, and none for an unused org', () => {
    const names = doctorChecks(acmeConfig((b) => { addUat()(b); b.orgs['acme-spare'] = { orgId: ACME_DEV2_ID }; }), ctxFor()).map((c) => c.name);
    const at = names.indexOf('salesforce source tracking acme-dev1');
    expect(names.slice(at + 1, at + 6)).toEqual([DEV1, QA, 'salesforce baseline acme-uat (stage uat)', 'salesforce agentforce', LEVEL]);
    expect(names.some((n) => n.includes('acme-spare') && n.startsWith('salesforce baseline'))).toBe(false);
  });

  describe('a clean org', () => {
    it('is ok, as is the test level, once a running baseline completes with no failures and 82%', async () => {
      writeBase('acme-qa', ACME_QA_ID, { state: 'running', finishedAt: undefined, failing: undefined, coverage: undefined });
      const r = await one(QA, { routes: completed() });
      expect(r).toMatchObject(OK);
      expect(r.detail).toMatch(/^no failing tests, 82% Apex coverage, recorded \d{4}-\d{2}-\d{2}$/);
      expect(r.all[LEVEL]).toMatchObject(OK);
      expect(readBase('acme-qa')).toMatchObject({ state: 'done', failing: [], coverage: 82, testRunId: BASE_RUN });
    });

    it('starts the tests on the first run, and is ok on the next once they finish', async () => {
      removeBase('acme-qa');
      const routes = { [START]: sfOk({ testRunId: RUN2 }), ...completed() };
      const first = await one(QA, { routes });
      expect(first).toMatchObject(WARN);
      expect(first.detail).toBe(`started the org's local tests (test run ${RUN2}) to record what already fails there; run \`foreman doctor\` again when they finish, which can take a long time`);
      expect(readBase('acme-qa')).toMatchObject({ alias: 'acme-qa', orgId: ACME_QA_ID, testRunId: RUN2, state: 'running' });
      expect(first.ctx.sh.sfLines().filter((l) => l.includes(START))).toEqual(['apex run test --test-level RunLocalTests --code-coverage --target-org acme-qa --json']);
      expect(first.all[LEVEL]).toEqual({ ...OK, detail: 'no baseline yet for acme-qa' });

      const second = await one(QA, { routes });
      expect(second).toMatchObject(OK);
      expect(second.ctx.sh.sfLines().some((l) => l.includes(START))).toBe(false);
      expect(second.all[LEVEL]).toMatchObject(OK);
      expect(readBase('acme-qa')).toMatchObject({ state: 'done', testRunId: RUN2, coverage: 82 });
    });

    it('says "no Apex" when the org has no coverage rows', async () => {
      writeBase('acme-qa', ACME_QA_ID, { coverage: null });
      const r = await one(QA);
      expect(r).toMatchObject(OK);
      expect(r.detail).toBe('no failing tests, no Apex, recorded 2026-10-23');
    });
  });

  describe('a failing test and low coverage', () => {
    it('warns on a stage org, naming the test and 19%, and suggests RunRelevantTests', async () => {
      writeBase('acme-qa', ACME_QA_ID, BAD);
      const r = await one(QA);
      expect(r).toMatchObject(WARN);
      expect(r.detail).toBe('acme-qa already fails 1 test (AcmeServiceTest.sumsTheOrder) and has 19% Apex coverage (75% needed): RunLocalTests deploys there will fail whatever the story does. Use RunRelevantTests in salesforce.testLevel, or fix the org, then run `foreman sf baseline --refresh`');
      expect(r.detail).not.toContain('admin@');
      expect(r.detail).not.toContain('Assertion');
    });

    it('warns at the test level when RunLocalTests is used against it, and is ok with RunRelevantTests', async () => {
      writeBase('acme-qa', ACME_QA_ID, BAD);
      const r = await one(LEVEL);
      expect(r).toMatchObject(WARN);
      expect(r.detail).toBe('testLevel.deploy is RunLocalTests, but acme-qa (stage qa) already fails 1 test (AcmeServiceTest.sumsTheOrder) and has 19% Apex coverage (75% needed), so it cannot pass there; testLevel.validate is RunLocalTests, but acme-qa (stage qa) already fails 1 test (AcmeServiceTest.sumsTheOrder) and has 19% Apex coverage (75% needed), so it cannot pass there; set it to RunRelevantTests, or fix the org');

      const relevant = await one(LEVEL, { edit: (b) => { b.testLevel = { validate: 'RunRelevantTests', deploy: 'RunRelevantTests' }; } });
      expect(relevant).toMatchObject(OK);
      expect(relevant.ctx.sh.sfLines().some((l) => l.includes('apex run test'))).toBe(false);
    });

    it('checks only the validate level off the sf release path', async () => {
      writeBase('acme-qa', ACME_QA_ID, BAD);
      const r = await one(LEVEL, { edit: (b) => { b.release = 'ci'; b.testLevel = { validate: 'RunRelevantTests', deploy: 'RunLocalTests' }; } });
      expect(r).toMatchObject(OK);
    });

    it('warns on a build-only org with failing tests that the tester calls them inherited, and is ok with only low coverage', async () => {
      writeBase('acme-dev1', ACME_DEV1_ID, BAD);
      const r = await one(DEV1);
      expect(r).toEqual(expect.objectContaining({ ...WARN, detail: "acme-dev1 already fails 1 test (AcmeServiceTest.sumsTheOrder); the tester reports failures in these tests as inherited, not as the story's" }));
      expect(r.all[LEVEL]).toMatchObject(OK);

      writeBase('acme-dev1', ACME_DEV1_ID, { failing: [], coverage: 19 });
      expect(await one(DEV1)).toEqual(expect.objectContaining({ ...OK, detail: 'no failing tests, 19% Apex coverage, recorded 2026-10-23' }));
    });

    it('records a completed run with failures from the org, and then warns', async () => {
      writeBase('acme-qa', ACME_QA_ID, { state: 'running', finishedAt: undefined, failing: undefined, coverage: undefined });
      const r = await one(QA, { routes: completed([['AcmeServiceTest', 'sumsTheOrder']], 19.2) });
      expect(r).toMatchObject(WARN);
      expect(r.detail).toContain('AcmeServiceTest.sumsTheOrder');
      expect(r.detail).toContain('19%');
    });
  });

  describe('the cached baseline', () => {
    it('is reused with no Apex or test-result sf call until `foreman sf baseline --refresh`', async () => {
      for (let i = 0; i < 2; i += 1) {
        const ctx = ctxFor();
        const res = await runAll(acmeConfig(), ctx);
        expect(res[QA]).toMatchObject(OK);
        expect(res[DEV1]).toMatchObject(OK);
        expect(apexLines(ctx.sh)).toEqual([]);
      }

      fs.writeFileSync(path.join(dir, 'foreman.config.json'), JSON.stringify({
        version: 1,
        project: { name: 'Acme' },
        pack: 'salesforce',
        salesforce: {
          productionBranch: 'main',
          orgs: { 'acme-dev1': { orgId: ACME_DEV1_ID }, 'acme-qa': { orgId: ACME_QA_ID } },
          build: ['acme-dev1'],
          stages: [{ name: 'qa', org: 'acme-qa', branch: 'qa' }],
        },
      }));
      const sh = fakeSfShell(acmeSfRoutes({ [START]: sfOk({ testRunId: RUN2 }) }));
      let out = '';
      const code = await makeSfCommand({ sh, packs: PACKS, homedir: aux }).run(['baseline', '--refresh'], {
        cwd: dir,
        root: dir,
        env: { FOREMAN_SF_HOME: sfHome, FOREMAN_STATE_DIR: path.join(dir, '.foreman') },
        stdout: { write: (s) => { out += s; } },
        stderr: { write: (s) => { out += s; } },
      });
      expect(code).toBe(0);
      expect(JSON.parse(out.trim().split('\n').at(-1))).toEqual({ ok: true, started: [{ alias: 'acme-dev1', testRunId: RUN2 }, { alias: 'acme-qa', testRunId: RUN2 }], failed: [] });
      expect(sh.sfLines().filter((l) => l.includes('apex run test'))).toEqual([
        'apex run test --test-level RunLocalTests --code-coverage --target-org acme-dev1 --json',
        'apex run test --test-level RunLocalTests --code-coverage --target-org acme-qa --json',
      ]);
      for (const call of sh.calls.filter((c) => c.cmd === 'sf')) expect(call.opts.env.HOME).toBe(sfHome);
      for (const alias of ['acme-dev1', 'acme-qa']) expect(readBase(alias)).toMatchObject({ state: 'running', testRunId: RUN2 });

      const ctx = ctxFor({ routes: { [RUN_RESULT]: statusOf('Processing') } });
      const res = await runAll(acmeConfig(), ctx);
      expect(res[QA]).toMatchObject(WARN);
      expect(res[QA].detail).toBe(`the org's local tests are still running (test run ${RUN2}, started ${readBase('acme-qa').startedAt.slice(0, 16).replace('T', ' ')} UTC)`);
      expect(ctx.sh.sfLines().filter((l) => l.includes(RUN_RESULT))).toHaveLength(2);
      expect(ctx.sh.sfLines().some((l) => l.includes('apex run test'))).toBe(false);
    });

    it('gives a shared org one check and one start', async () => {
      removeBase('acme-dev1');
      const ctx = ctxFor({ routes: { [START]: sfOk({ testRunId: RUN2 }) } });
      const res = await runAll(acmeConfig(layoutA), ctx);
      expect(Object.keys(res).filter((n) => n.startsWith('salesforce baseline'))).toEqual(['salesforce baseline acme-dev1 (build, stage dev)']);
      expect(ctx.sh.sfLines().filter((l) => l.includes('apex run test'))).toHaveLength(1);
    });
  });

  describe('refused and error paths', () => {
    it('skips an org that failed its org check, and starts no tests there', async () => {
      removeBase('acme-qa');
      const r = await one(QA, { routes: { [orgRoute('acme-qa')]: orgRecord(ACME_QA_ID, false), [START]: sfOk({ testRunId: RUN2 }) } });
      expect(r).toEqual(expect.objectContaining({ ...WARN, detail: 'skipped: acme-qa did not pass its org check' }));
      expect(r.ctx.sh.sfLines().some((l) => l.includes('apex run test'))).toBe(false);
    });

    it('warns when the tests cannot be started', async () => {
      removeBase('acme-qa');
      const r = await one(QA, { routes: { [START]: sfError('SfError', 'Request timed out') } });
      expect(r).toEqual(expect.objectContaining({ ...WARN, detail: "could not start the org's local tests: Request timed out" }));
      expect(fs.existsSync(baseFile('acme-qa'))).toBe(false);
    });

    it('warns when the run cannot be read, and keeps the record', async () => {
      writeBase('acme-qa', ACME_QA_ID, { state: 'running', finishedAt: undefined, failing: undefined, coverage: undefined });
      const r = await one(QA, { routes: { [RUN_RESULT]: sfError('SfError', 'Request timed out') } });
      expect(r).toEqual(expect.objectContaining({ ...WARN, detail: `could not read test run ${BASE_RUN}: Request timed out` }));
      expect(readBase('acme-qa').state).toBe('running');
    });

    it('warns with --refresh on an aborted run', async () => {
      writeBase('acme-qa', ACME_QA_ID, { state: 'aborted', failing: undefined, coverage: undefined });
      const r = await one(QA);
      expect(r).toEqual(expect.objectContaining({ ...WARN, detail: `test run ${BASE_RUN} was aborted; run \`foreman sf baseline --refresh\`` }));
    });

    it('starts again for a baseline of another org ID, as after a sandbox refresh', async () => {
      writeBase('acme-qa', '00D000000000009AAA', BAD);
      const r = await one(QA, { routes: { [START]: sfOk({ testRunId: RUN2 }) } });
      expect(r).toMatchObject(WARN);
      expect(r.detail).toContain(`started the org's local tests (test run ${RUN2})`);
      expect(readBase('acme-qa')).toMatchObject({ orgId: ACME_QA_ID, state: 'running' });
    });
  });
});

describe('salesforce agentforce', () => {
  const NAME = 'salesforce agentforce';
  const state = () => path.join(dir, '.foreman');
  const switchFile = () => path.join(state(), AGENTFORCE_FILE);
  const OFF = { off: true, reason: 'acme-qa (stage qa) has no Agentforce', at: '2026-10-15T11:00:00.000Z' };
  const none = sfOk({ records: [], totalSize: 0, done: true });
  const inOrg = (key, alias) => `${key} --target-org ${alias}`;
  // The Data Cloud query ends with its WHERE clause, so the org follows that.
  const dataCloudIn = (alias) => `'Data Cloud') --target-org ${alias}`;
  const agentforceLines = (ctx) => ctx.sh.sfLines().filter((l) => l.includes('GenAiPlannerDefinition') || l.includes('PermissionSetLicense'));
  const clean = (r) => {
    const t = JSON.stringify({ detail: r.detail, fix: r.fix });
    expect(t).not.toContain('@');
    expect(t).not.toMatch(/admin|accessToken|password/i);
  };

  // agentforceCheck on a story that changes Acme_Order_Helper, with the doctor's state folder.
  const releaseAgent = async () => {
    const pkg = path.join(aux, 'package.xml');
    fs.writeFileSync(pkg, '<Package><types><members>Acme_Order_Helper</members><name>AiAuthoringBundle</name></types></Package>');
    const raw = fakeSh();
    const env = { FOREMAN_SF_HOME: sfHome, FOREMAN_STATE_DIR: state() };
    const ctx = fakeCtx({ config: { pack: 'salesforce', salesforce: acmeConfig().salesforce, slots: 1 }, root: dir, env });
    ctx.sh = raw;
    ctx.sfDelta = { to: 'bbb', manifest: pkg };
    const r = await agentforceCheck.run({ ctx, sh: isolatedSh(raw, env, sfHome, os.homedir()), stage: { name: 'qa', org: 'acme-qa', orgId: ACME_QA_ID } });
    return { r, raw };
  };

  it('warns and turns Agentforce off when the stage org has no Agentforce, and the release then refuses agent bundles', async () => {
    const r = await one(NAME, { routes: { [inOrg(AGENTFORCE, 'acme-qa')]: sfError('INVALID_TYPE', "sObject type 'GenAiPlannerDefinition' is not supported.") } });
    expect(r).toMatchObject(WARN);
    expect(r.detail).toBe('Agentforce is off: acme-qa (stage qa) has no Agentforce');
    expect(r.fix.hint).toBe('turn on Agentforce and Data Cloud in that org, then run the doctor again');
    expect(readAgentforceSwitch(state())).toMatchObject({ off: true, reason: 'acme-qa (stage qa) has no Agentforce' });
    clean(r);

    const { r: released, raw } = await releaseAgent();
    expect(released).toEqual({ ok: false, reason: 'Agentforce is off: acme-qa (stage qa) has no Agentforce' });
    expect(raw.calls).toEqual([]);
  });

  it('turns Agentforce off when an org has no Data Cloud licence', async () => {
    const r = await one(NAME, { routes: { [dataCloudIn('acme-qa')]: none } });
    expect(r).toMatchObject(WARN);
    expect(r.detail).toBe('Agentforce is off: acme-qa (stage qa) has no Data Cloud licence');
    expect(readAgentforceSwitch(state())).toMatchObject({ off: true, reason: 'acme-qa (stage qa) has no Data Cloud licence' });
    expect(typeof readAgentforceSwitch(state()).at).toBe('string');
    clean(r);
  });

  it('names every org that misses either', async () => {
    const r = await one(NAME, { routes: { [DATA_CLOUD]: none, [inOrg(AGENTFORCE, 'acme-qa')]: sfError('INVALID_TYPE', 'Entity GenAiPlannerDefinition is not supported') } });
    expect(r.detail).toBe('Agentforce is off: acme-dev1 (build) has no Data Cloud licence; acme-qa (stage qa) has no Agentforce and no Data Cloud licence');
  });

  it('is ok when every org with a role has both, and clears an earlier off', async () => {
    writeAgentforceSwitch(state(), OFF);
    const r = await one(NAME);
    expect(r).toEqual(expect.objectContaining({ ...OK, detail: 'on in acme-dev1, acme-qa' }));
    expect(fs.existsSync(switchFile())).toBe(false);
    const lines = agentforceLines(r.ctx);
    expect(lines).toHaveLength(4);
    for (const l of lines) expect(l).toMatch(/--target-org acme-(dev1|qa) --json$/);
    expect(lines.find((l) => l.includes('PermissionSetLicense'))).toContain("SELECT DeveloperName FROM PermissionSetLicense WHERE Status = 'Active' AND (DeveloperName LIKE 'GenieDataPlatform%' OR MasterLabel = 'Data Cloud')");
    expect(lines.find((l) => l.includes('GenAiPlannerDefinition'))).toContain('SELECT Id FROM GenAiPlannerDefinition LIMIT 1');
  });

  it('checks no org without a role', async () => {
    const r = await one(NAME, { edit: (b) => { b.orgs['acme-uat'] = { orgId: ACME_UAT_ID }; } });
    expect(r).toMatchObject(OK);
    expect(agentforceLines(r.ctx).some((l) => l.includes('acme-uat'))).toBe(false);
  });

  it('warns could not check on a network error and leaves the record', async () => {
    writeAgentforceSwitch(state(), OFF);
    const before = fs.readFileSync(switchFile(), 'utf8');
    const r = await one(NAME, { routes: { [inOrg(AGENTFORCE, 'acme-qa')]: sfError('SfError', 'getaddrinfo ENOTFOUND acme-qa.sandbox.my.salesforce.com') } });
    expect(r).toMatchObject(WARN);
    expect(r.detail).toContain('could not check');
    expect(r.detail).toContain('acme-qa');
    expect(fs.readFileSync(switchFile(), 'utf8')).toBe(before);
    clean(r);
  });

  it('leaves no record after a network error when there was none', async () => {
    const r = await one(NAME, { routes: { [dataCloudIn('acme-dev1')]: sfError('SfError', 'socket hang up') } });
    expect(r).toMatchObject(WARN);
    expect(fs.existsSync(switchFile())).toBe(false);
  });

  it('skips an org that fails its identity check and leaves the record', async () => {
    writeAgentforceSwitch(state(), OFF);
    const before = fs.readFileSync(switchFile(), 'utf8');
    const r = await one(NAME, { routes: { [orgRoute('acme-qa')]: orgRecord(ACME_QA_ID, false) } });
    expect(r).toMatchObject(WARN);
    expect(r.detail).toContain('skipped: acme-qa did not pass its org check');
    expect(agentforceLines(r.ctx).some((l) => l.includes('acme-qa'))).toBe(false);
    expect(fs.readFileSync(switchFile(), 'utf8')).toBe(before);
    clean(r);
  });

  it('is ok with no sf call when salesforce.agentforce is off', async () => {
    writeAgentforceSwitch(state(), OFF);
    const r = await one(NAME, { edit: (b) => { b.agentforce = 'off'; } });
    expect(r).toEqual(expect.objectContaining({ ...OK, detail: 'off in foreman.config.json' }));
    expect(agentforceLines(r.ctx)).toEqual([]);
  });
});

describe('foreman doctor on the Acme fixture', () => {
  const LIST = 'Installed plugins:\n\n  ❯ foreman@foreman\n    Version: 0.1.0\n    Scope: project\n    Status: ✔ enabled\n';
  let root;
  let source;

  beforeEach(() => {
    root = path.join(dir, 'acme');
    fs.cpSync(FIXTURE, root, { recursive: true });
    fs.writeFileSync(path.join(root, 'foreman.config.json'), JSON.stringify({
      version: 1,
      project: { name: 'Acme' },
      pack: 'salesforce',
      salesforce: {
        productionBranch: 'main',
        orgs: { 'acme-dev1': { orgId: ACME_DEV1_ID }, 'acme-qa': { orgId: ACME_QA_ID } },
        build: ['acme-dev1'],
        stages: [{ name: 'qa', org: 'acme-qa', branch: 'qa' }],
      },
    }));
    writeInstalled(root, INSTALLED, SOURCE);
    source = path.join(dir, 'source');
    fs.mkdirSync(path.join(source, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(source, '.claude-plugin', 'plugin.json'), '{"version":"0.1.0"}');
  });

  const fallback = (cmd, args = []) => {
    const line = [cmd, ...args].join(' ');
    if (line === 'claude plugin list') return { status: 0, stdout: LIST, stderr: '' };
    if (line.startsWith('git ls-remote')) return { status: 0, stdout: REF, stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };

  async function doctor(routes = {}) {
    let out = '';
    const command = makeDoctorCommand({ sh: () => fakeSfShell(acmeSfRoutes(routes), fallback), sourceRoot: source });
    const env = { FOREMAN_SF_HOME: sfHome, PATH: `${sfBin}${path.delimiter}${process.env.PATH ?? ''}` };
    const code = await command.run([], { cwd: root, root, env, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { out += s; } } });
    return { code, out };
  }

  it('prints the salesforce lines, all ok', async () => {
    const { code, out } = await doctor();
    expect(code).toBe(0);
    expect(out).toMatch(/^ok {4}salesforce tools/m);
    expect(out).toMatch(/^ok {4}salesforce layout — build acme-dev1; test the slot's build org; stage qa acme-qa on qa; 1 slot$/m);
    expect(out).toMatch(/^ok {4}salesforce org acme-dev1 \(build\) — sandbox 00D000000000001AAA$/m);
    expect(out).toMatch(/^ok {4}salesforce org acme-qa \(stage qa\)/m);
    expect(out).toMatch(/^ok {4}salesforce sf isolation — .*: 2 orgs, all allow-listed sandboxes$/m);
    expect(out).toMatch(/^ok {4}salesforce plugin$/m);
    expect(out).toMatch(/^ok {4}salesforce source tracking acme-dev1$/m);
    expect(out).toMatch(/^ok {4}salesforce production branch/m);
    expect(out).toMatch(/^ok {4}salesforce skills lock — 2 skills from forcedotcom\/sf-skills$/m);
    expect(out).toMatch(/^ok {4}salesforce skills named — no pack agent names a skill$/m);
    expect(out).toMatch(/^ok {4}salesforce telemetry/m);
    expect(out).toMatch(/^ok {4}salesforce CONFIRM_PROD$/m);
    expect(out).not.toMatch(/^FAIL {2}(salesforce|pack)/m);
  });
  it('fails and exits 1 when acme-qa is not a sandbox', async () => {
    const { code, out } = await doctor({ [orgRoute('acme-qa')]: orgRecord(ACME_QA_ID, false) });
    expect(out).toMatch(/^FAIL {2}salesforce org acme-qa \(stage qa\) — acme-qa is not a sandbox; production is never a target$/m);
    expect(code).toBe(1);
  });

  // Example (a): one sandbox, one branch, no productionBranch, and a workflow deploying main.
  const asLayoutA = (alias) => {
    fs.writeFileSync(path.join(root, 'foreman.config.json'), JSON.stringify({
      version: 1,
      project: { name: 'Acme' },
      pack: 'salesforce',
      salesforce: {
        orgs: { 'acme-dev1': { orgId: ACME_DEV1_ID } },
        build: 'acme-dev1',
        stages: [{ name: 'dev', org: 'acme-dev1' }],
      },
    }));
    writeWorkflow(root, deployWorkflow('main', alias));
  };
  // The isolated sf home signed in to acme-dev1 only, as layout (a) needs.
  const DEV1_ONLY = { [ORG_LIST]: orgList([acmeOrg('acme-dev1', ACME_DEV1_ID)]) };
  it('(a) fails and exits 1 when a workflow deploys main to acme-prod', async () => {
    asLayoutA('acme-prod');
    const { code, out } = await doctor(DEV1_ONLY);
    expect(out).toMatch(/^FAIL {2}salesforce workflows — \.github\/workflows\/deploy\.yml on main: deploys to an org not in salesforce\.orgs$/m);
    expect(out.match(/^FAIL .*$/gm)).toHaveLength(1);
    expect(code).toBe(1);
  });
  it('(a) passes a workflow that deploys main to acme-dev1', async () => {
    asLayoutA('acme-dev1');
    const { code, out } = await doctor(DEV1_ONLY);
    expect(out).toMatch(/^ok {4}salesforce workflows — 1 deploy on main, all to orgs in salesforce\.orgs$/m);
    expect(out).not.toMatch(/^FAIL /m);
    expect(code).toBe(0);
  });
});

describe('salesforce stories: the Cases source', () => {
  const CASES_ID = '00D000000000005AAA';
  const NAMES = ['salesforce stories options', 'salesforce stories filter', 'salesforce stories statuses'];
  // The Acme block, with a sandbox that only holds the Cases, and the stories read from it.
  const cases = (stories = {}, { stageOrg = false, extra } = {}) => (b, file) => {
    if (!stageOrg) b.orgs['acme-cases'] = { orgId: CASES_ID };
    file.stories = { adapter: 'salesforce', org: stageOrg ? 'acme-qa' : 'acme-cases', where: "IsClosed = false AND Type = 'Foreman'", ...stories };
    extra?.(b, file);
  };
  const setup = ({ stories, stageOrg = false, extra, routes = {}, tidy } = {}) => {
    const org = fakeCasesOrg({ orgId: stageOrg ? ACME_QA_ID : CASES_ID, alias: stageOrg ? 'acme-qa' : 'acme-cases' });
    org.addCase({ number: '00000001', subject: 'First' });
    org.addCase({ number: '00000002', subject: 'Second' });
    tidy?.(org);
    const allRoutes = { ...org.routes, [orgRoute('acme-cases')]: orgRecord(CASES_ID), ...routes };
    return { org, edit: cases(stories, { stageOrg, extra }), routes: allRoutes };
  };
  const all = async (s) => {
    const ctx = ctxFor({ routes: s.routes });
    return { res: await runAll(acmeConfig(s.edit), ctx), ctx };
  };

  it('lists its three checks after the org checks, only when the stories come from Salesforce', () => {
    const s = setup();
    const names = doctorChecks(acmeConfig(s.edit), ctxFor()).map((c) => c.name);
    expect(names.filter((n) => n.startsWith('salesforce stories'))).toEqual(NAMES);
    expect(names.indexOf(NAMES[0])).toBeGreaterThan(names.indexOf('salesforce org acme-cases (stories)'));
    expect(doctorChecks(acmeConfig(), ctxFor()).map((c) => c.name).filter((n) => n.startsWith('salesforce stories'))).toEqual([]);
    expect(doctorChecks(acmeConfig((b, f) => { f.stories = { adapter: 'jira', site: 'acme.atlassian.net', jql: 'x' }; }), ctxFor()).map((c) => c.name).filter((n) => n.includes('stories'))).toEqual([]);
  });

  it('names the org check "stories", also next to its other roles', async () => {
    const only = await all(setup());
    expect(only.res['salesforce org acme-cases (stories)']).toMatchObject({ ...OK, detail: `sandbox ${CASES_ID}` });
    const shared = setup({ stageOrg: true });
    const names = doctorChecks(acmeConfig(shared.edit), ctxFor({ routes: shared.routes })).map((c) => c.name);
    expect(names).toContain('salesforce org acme-qa (stage qa, stories)');
    expect(names).not.toContain('salesforce org acme-qa (stage qa)');
  });

  it('runs no baseline, source tracking or Agentforce query for an org that only holds the Cases', async () => {
    const s = setup();
    const { res, ctx } = await all(s);
    expect(Object.keys(res).some((n) => n.startsWith('salesforce baseline acme-cases'))).toBe(false);
    expect(Object.keys(res).some((n) => n.startsWith('salesforce source tracking acme-cases'))).toBe(false);
    expect(ctx.sh.sfLines().filter((l) => l.includes('--target-org acme-cases') && !l.includes('FROM Organization') && !l.includes('FROM Case') && !l.includes('sobject describe'))).toEqual([]);
    expect(res['salesforce agentforce'].detail).not.toContain('acme-cases');
  });

  it('is all ok on a healthy set', async () => {
    const s = setup({ stories: { doneWhenField: 'Done_When__c', dependsOnField: 'Depends_On__c', ownerField: 'Type', ownerValue: 'Owner task', statuses: { started: 'Working', shipped: 'Closed' } } });
    const { res } = await all(s);
    for (const name of NAMES) expect(res[name], name).toMatchObject(OK);
    expect(res['salesforce stories options'].detail).toBe('Cases in acme-cases');
  });

  it('passes the filter check with the number of Cases it finds, and runs the filter with ORDER BY and LIMIT', async () => {
    const s = setup({ stories: { orderBy: 'Priority DESC' } });
    const { res, ctx } = await all(s);
    expect(res['salesforce stories filter']).toMatchObject({ ...OK, detail: 'finds 2 Cases' });
    expect(ctx.sh.sfLines().some((l) => l.includes("FROM Case WHERE (IsClosed = false AND Type = 'Foreman') ORDER BY Priority DESC LIMIT 200 --target-org acme-cases"))).toBe(true);
  });

  it('says one Case in the singular, and none', async () => {
    const one_ = setup({ tidy: (o) => o.failNext('FROM Case', sfOk({ records: [{ Id: '500000000000001AAA', CaseNumber: '00000001' }], totalSize: 1, done: true })) });
    expect((await all(one_)).res['salesforce stories filter'].detail).toBe('finds 1 Case');
  });

  it('runs a list view through its SOQL', async () => {
    const s = setup({ stories: { where: undefined, listView: 'Foreman_Stories' }, tidy: (o) => o.addListView('Foreman_Stories', 'SELECT Id FROM Case WHERE IsClosed = false ORDER BY CaseNumber LIMIT 50') });
    const { res, ctx } = await all(s);
    expect(res['salesforce stories filter']).toMatchObject({ ...OK, detail: 'finds 2 Cases' });
    expect(ctx.sh.sfLines().some((l) => l.includes('FROM Case WHERE IsClosed = false ORDER BY CaseNumber LIMIT 200'))).toBe(true);
  });

  it('fails the filter check with sf\'s message on a query it refuses', async () => {
    const s = setup({ tidy: (o) => o.failNext('FROM Case', sfError('MALFORMED_QUERY', "unexpected token: 'AND'")) });
    const { res } = await all(s);
    expect(res['salesforce stories filter']).toMatchObject({ ...FAIL });
    expect(res['salesforce stories filter'].detail).toContain("unexpected token: 'AND'");
    expect(res['salesforce stories filter'].fix.hint).toBeTruthy();
  });

  it('fails the filter check for a list view that is not there', async () => {
    const s = setup({ stories: { where: undefined, listView: 'Missing_View' } });
    const { res } = await all(s);
    expect(res['salesforce stories filter']).toMatchObject(FAIL);
    expect(res['salesforce stories filter'].detail).toContain('Missing_View');
  });

  it('warns "skipped" when the org check fails, and reads no Case', async () => {
    const s = setup({ stories: { statuses: { started: 'Working' } }, routes: { [orgRoute('acme-cases')]: orgRecord(CASES_ID, false) } });
    const { res, ctx } = await all(s);
    expect(res['salesforce org acme-cases (stories)']).toMatchObject(FAIL);
    expect(res['salesforce stories filter']).toMatchObject({ ...WARN, detail: 'skipped: acme-cases did not pass its org check' });
    expect(res['salesforce stories statuses']).toMatchObject({ ...WARN, detail: 'skipped: acme-cases did not pass its org check' });
    expect(ctx.sh.sfLines().filter((l) => /FROM Case|sobject describe/.test(l))).toEqual([]);
  });

  it('fails the statuses check on a Status the org does not have, naming the near match', async () => {
    const s = setup({ stories: { statuses: { started: 'working', shipped: 'Closed', review: 'Nonsense' } } });
    const { res } = await all(s);
    const r = res['salesforce stories statuses'];
    expect(r).toMatchObject(FAIL);
    expect(r.detail).toContain('statuses.started "working" is not an active Case Status (did you mean "Working"?)');
    expect(r.detail).toContain('statuses.review "Nonsense" is not an active Case Status');
    expect(r.detail).not.toContain('statuses.shipped');
  });

  it('does not take an inactive Status', async () => {
    const s = setup({ stories: { statuses: { started: 'Retired' } } });
    expect((await all(s)).res['salesforce stories statuses']).toMatchObject(FAIL);
  });

  it('fails the statuses check on a field Case does not have', async () => {
    const s = setup({ stories: { doneWhenField: 'Missing_Done__c', dependsOnField: 'Depends_On__c', ownerField: 'Gone__c', ownerValue: 'x' } });
    const r = (await all(s)).res['salesforce stories statuses'];
    expect(r).toMatchObject(FAIL);
    expect(r.detail).toContain('doneWhenField Missing_Done__c is not a field of Case');
    expect(r.detail).toContain('ownerField Gone__c is not a field of Case');
    expect(r.detail).not.toContain('dependsOnField');
  });

  it('passes the statuses check as "none set" with no statuses and no fields, and makes no describe call', async () => {
    const { res, ctx } = await all(setup());
    expect(res['salesforce stories statuses']).toMatchObject({ ...OK, detail: 'none set' });
    expect(ctx.sh.sfLines().filter((l) => l.includes('sobject describe'))).toEqual([]);
  });

  it('describes Case once for all the names it checks', async () => {
    const { ctx } = await all(setup({ stories: { statuses: { started: 'Working' }, doneWhenField: 'Done_When__c', dependsOnField: 'Depends_On__c' } }));
    expect(ctx.sh.sfLines().filter((l) => l.includes('sobject describe'))).toHaveLength(1);
  });

  it('fails the options check, skips the other two and makes no sf call about Cases, for bad options', async () => {
    const s = setup({ stories: { where: undefined } });
    const { res, ctx } = await all(s);
    expect(res['salesforce stories options']).toMatchObject({ ...FAIL, detail: 'stories.where or stories.listView is required' });
    for (const name of NAMES.slice(1)) expect(res[name], name).toMatchObject({ ...FAIL, detail: 'skipped: fix the stories options first' });
    expect(ctx.sh.sfLines().filter((l) => /FROM Case|FROM ListView|sobject describe|api request/.test(l))).toEqual([]);
  });

  it('fails the options check for a stories org that is not in salesforce.orgs', async () => {
    const s = setup({ stories: { org: 'acme-nowhere' } });
    const { res } = await all(s);
    expect(res['salesforce stories options']).toMatchObject({ ...FAIL, detail: 'stories.org: acme-nowhere is not in salesforce.orgs' });
    expect(res['salesforce stories filter'].detail).toBe('skipped: fix the stories options first');
  });

  it('fails the options check for a stories org marked production, and runs no Case query', async () => {
    const s = setup({ extra: (b) => { b.orgs['acme-cases'].production = true; } });
    const { res, ctx } = await all(s);
    expect(res['salesforce stories options']).toMatchObject({ ...FAIL, detail: 'stories.org: acme-cases is a production org; Foreman reads stories only from a sandbox' });
    expect(ctx.sh.sfLines().filter((l) => /FROM Case|sobject describe/.test(l))).toEqual([]);
  });

  it('fails the options check for an org named prod or production', async () => {
    for (const alias of ['prod', 'production']) {
      const edit = (b, file) => {
        b.orgs[alias] = { orgId: CASES_ID };
        file.stories = { adapter: 'salesforce', org: alias, where: 'IsClosed = false' };
      };
      const res = await runAll(acmeConfig(edit), ctxFor());
      expect(res['salesforce stories options'], alias).toMatchObject(FAIL);
      expect(res['salesforce stories options'].detail, alias).toContain('production org');
    }
  });

  it('never names a username or a token in a detail', async () => {
    const { res } = await all(setup({ stories: { statuses: { started: 'working' } } }));
    for (const name of NAMES) expect(res[name].detail, name).not.toMatch(/@|acme\.example|token/i);
  });

  it('gives each check a set-up step and a fix hint when it is not ok', async () => {
    const s = setup({ stories: { where: undefined } });
    const checks = doctorChecks(acmeConfig(s.edit), ctxFor({ routes: s.routes }));
    for (const name of NAMES) expect(checks.find((c) => c.name === name).step).toBe('sf-orgs');
    const result = await checks.find((c) => c.name === NAMES[0]).run(ctxFor({ routes: s.routes }));
    expect(result.fix.hint).toBeTruthy();
  });
});
