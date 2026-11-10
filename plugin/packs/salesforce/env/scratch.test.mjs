import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { envAdapterContract } from '../../../lib/adapters/env/contract.mjs';
import { setSlot } from '../../../lib/engine/state.mjs';
import { create } from './scratch.mjs';
import { readScratchOrgs, scratchFile, writeScratchOrg } from '../scratch-orgs.mjs';
import { ACME_DEV1_ID, ACME_PROD_ID, fakeSfShell, orgRecord, sfError, sfOk } from '../../../../test/fake-sf.mjs';

const HOMEDIR = '/acme/home';
const ROOT = '/acme/repo';
const DEFINITION = 'config/project-scratch-def.json';
const T0 = Date.parse('2026-10-25T10:00:00.000Z');
const MIN = 60_000;

// The scratch org each alias gets: its org ID, its signup username and the create job's ID.
const ORGS = {
  'foreman-acme-1': { orgId: '00D000000000101AAA', username: 'test-acme-1@scratch.acme.example', jobId: '2SR000000000101AAA' },
  'foreman-acme-2': { orgId: '00D000000000102AAA', username: 'test-acme-2@scratch.acme.example', jobId: '2SR000000000102AAA' },
  'foreman-acme-9': { orgId: '00D000000000109AAA', username: 'test-acme-9@scratch.acme.example', jobId: '2SR000000000109AAA' },
};
const aliasOfJob = (jobId) => Object.keys(ORGS).find((a) => ORGS[a].jobId === jobId);
const argAfter = (args, flag) => args[args.indexOf(flag) + 1];

const scratchBlock = () => ({
  orgs: { 'acme-hub': { orgId: ACME_PROD_ID, production: true } },
  build: { scratch: { devHub: 'acme-hub', definition: DEFINITION } },
  stages: [],
});
const scratchConfig = () => ({ slots: 2, pack: 'salesforce', salesforce: scratchBlock() });
const poolConfig = () => ({ slots: 1, pack: 'salesforce', salesforce: { orgs: { 'acme-dev1': { orgId: ACME_DEV1_ID } }, build: ['acme-dev1'], stages: [] } });

const limitRows = (daily = 5, active = 2) => [
  { name: 'ActiveScratchOrgs', max: 3, remaining: active },
  { name: 'DailyApiRequests', max: 15000, remaining: 14000 },
  { name: 'DailyScratchOrgs', max: 6, remaining: daily },
];
const limits = (daily, active) => sfOk(limitRows(daily, active));

const created = (args) => {
  const alias = argAfter(args, '--alias');
  return sfOk({ username: ORGS[alias].username, scratchOrgInfo: { Id: ORGS[alias].jobId, Status: 'New' }, warnings: [] });
};
const resumed = (args) => {
  const alias = aliasOfJob(argAfter(args, '--job-id'));
  const { username, orgId } = ORGS[alias];
  return sfOk({ username, orgId, authFields: { username, orgId, instanceUrl: `https://${alias}.scratch.my.salesforce.com` }, warnings: [] });
};
// The Organization query, answered for the org behind the alias it targets.
const orgQuery = (args) => {
  const target = argAfter(args, '--target-org');
  const org = ORGS[target] ?? Object.values(ORGS).find((o) => o.username === target);
  return org ? orgRecord(org.orgId) : sfError('NamedOrgNotFoundError', `No authorization information found for ${target}.`);
};
const deleted = (args) => sfOk({ username: argAfter(args, '--target-org'), orgId: '00D000000000101AAA' });

// Healthy Acme sf answers; routes in `over` come first, so they win. 'org list limits' stays
// ahead of any 'org list' route.
const routes = (over = {}) => ({
  'org list limits': limits(),
  ...over,
  'org create scratch': created,
  'org resume scratch': resumed,
  'FROM Organization': orgQuery,
  'config set target-org': (args) => sfOk({ successes: [{ name: 'target-org', value: args[3] }], failures: [] }),
  'org delete scratch': deleted,
  ...over,
});

let stateDir;
let wt;
let sfHomeDir;
beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-scratch-state-'));
  wt = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-scratch-wt-'));
  sfHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-scratch-sfhome-'));
});
afterEach(() => {
  for (const d of [stateDir, wt, sfHomeDir]) fs.rmSync(d, { recursive: true, force: true });
});

const readRecord = (story) => JSON.parse(fs.readFileSync(scratchFile(stateDir, story), 'utf8'));
const hasRecord = (story) => fs.existsSync(scratchFile(stateDir, story));
const readyRecord = (story, over = {}) => {
  const alias = `foreman-${story.toLowerCase()}`;
  const { orgId, username, jobId } = ORGS[alias];
  return { story, slot: 'w1', alias, devHub: 'acme-hub', state: 'ready', jobId, username, orgId, createdAt: new Date(T0).toISOString(), readyAt: new Date(T0).toISOString(), ...over };
};

// An adapter over fake sf, with an instant wait and a clock the test moves. Slot w1 works on
// ACME-1 unless `story` is null.
function world({ sf = {}, story = 'ACME-1', slot = 'w1', config = scratchConfig(), wait } = {}) {
  if (story) setSlot(stateDir, slot, { story: { id: story } });
  const sh = fakeSfShell(routes(sf));
  const clock = { t: T0 };
  const waits = wait ?? vi.fn(async () => {});
  const adapter = create({ adapter: 'scratch' }, { root: ROOT, stateDir, config, sh, env: { PATH: '/usr/bin', FOREMAN_SF_HOME: sfHomeDir }, homedir: HOMEDIR, wait: waits, now: () => clock.t });
  const lines = () => sh.sfLines();
  const count = (text) => lines().filter((l) => l.includes(text)).length;
  const find = (text) => sh.calls.find((c) => c.cmd === 'sf' && c.args.join(' ').includes(text));
  return { adapter, sh, clock, wait: waits, lines, count, find };
}

const contractDirs = [];
afterAll(() => {
  for (const d of contractDirs) fs.rmSync(d, { recursive: true, force: true });
});
envAdapterContract({
  name: 'scratch',
  make: () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-scratch-contract-'));
    contractDirs.push(dir);
    setSlot(dir, 'w1', { story: { id: 'ACME-1' } });
    const sh = fakeSfShell(routes());
    return create({ adapter: 'scratch' }, { root: ROOT, stateDir: dir, config: scratchConfig(), sh, env: { FOREMAN_SF_HOME: path.join(dir, 'sf-home') }, homedir: HOMEDIR, wait: async () => {} });
  },
});

describe('scratch create', () => {
  it('names the slot in env(n), and nothing else', () => {
    expect(world({ story: null }).adapter.env(2)).toEqual({ FOREMAN_SLOT: 'w2' });
  });
  it('refuses an unknown option', () => {
    expect(() => create({ adapter: 'scratch', devHub: 'x' }, { root: ROOT, stateDir, config: scratchConfig() })).toThrow('env adapter scratch: unknown option devHub');
  });
  it('refuses a pool layout, and a scratch block with no Dev Hub or definition', () => {
    expect(() => create({ adapter: 'scratch' }, { root: ROOT, stateDir, config: poolConfig() })).toThrow(/^env adapter scratch: /);
    const noHub = scratchConfig();
    delete noHub.salesforce.build.scratch.devHub;
    expect(() => create({ adapter: 'scratch' }, { root: ROOT, stateDir, config: noHub })).toThrow(/^env adapter scratch: /);
    const noDef = scratchConfig();
    delete noDef.salesforce.build.scratch.definition;
    expect(() => create({ adapter: 'scratch' }, { root: ROOT, stateDir, config: noDef })).toThrow(/^env adapter scratch: /);
  });
  it('has a sweep', () => {
    expect(typeof world({ story: null }).adapter.sweep).toBe('function');
  });
});

describe('scratch prepare: a slot with no story', () => {
  it('rejects and makes no sf call', async () => {
    const w = world({ story: null });
    await expect(w.adapter.prepare(1, wt)).rejects.toThrow('slot w1 has no story; scratch orgs are made per story');
    expect(w.sh.calls).toEqual([]);
  });
});

describe('scratch prepare: one org per story', () => {
  it('checks the limits, creates, resumes, checks the org and sets target-org, in that order', async () => {
    const w = world();
    expect(await w.adapter.prepare(1, wt)).toBe('reset');
    const { jobId, orgId, username } = ORGS['foreman-acme-1'];
    expect(w.lines()).toEqual([
      'org list limits --target-org acme-hub --json',
      `org create scratch --definition-file ${DEFINITION} --target-dev-hub acme-hub --alias foreman-acme-1 --duration-days 2 --async --json`,
      `org resume scratch --job-id ${jobId} --wait 0 --json`,
      'data query --query SELECT Id, IsSandbox FROM Organization --target-org foreman-acme-1 --json',
      'config set target-org foreman-acme-1 --json',
    ]);
    expect(w.find('org create scratch').opts.cwd).toBe(wt);
    expect(w.find('config set target-org').opts.cwd).toBe(wt);
    for (const c of w.sh.calls) expect(c.opts.env.HOME).toBe(sfHomeDir);
    expect(readRecord('ACME-1')).toMatchObject({ story: 'ACME-1', state: 'ready', slot: 'w1', alias: 'foreman-acme-1', orgId, username, jobId, devHub: 'acme-hub', createdAt: new Date(T0).toISOString(), readyAt: new Date(T0).toISOString() });
  });
  it('reuses the story\'s org in another slot, with no create call', async () => {
    const w = world();
    await w.adapter.prepare(1, wt);
    setSlot(stateDir, 'w2', { story: { id: 'ACME-1' } });
    expect(await w.adapter.prepare(2, wt)).toBe('up');
    expect(w.count('org create scratch')).toBe(1);
    expect(w.count('org list limits')).toBe(1);
    expect(w.count('config set target-org foreman-acme-1')).toBe(2);
    expect(readRecord('ACME-1').slot).toBe('w2');
    expect(readRecord('ACME-1').state).toBe('ready');
  });
  it('gives another story its own org and record', async () => {
    const w = world();
    await w.adapter.prepare(1, wt);
    setSlot(stateDir, 'w2', { story: { id: 'ACME-2' } });
    expect(await w.adapter.prepare(2, wt)).toBe('reset');
    expect(w.lines()).toContain(`org create scratch --definition-file ${DEFINITION} --target-dev-hub acme-hub --alias foreman-acme-2 --duration-days 2 --async --json`);
    expect(readRecord('ACME-2')).toMatchObject({ slot: 'w2', alias: 'foreman-acme-2', orgId: ORGS['foreman-acme-2'].orgId, state: 'ready' });
    expect(readScratchOrgs(stateDir).map((r) => r.story).sort()).toEqual(['ACME-1', 'ACME-2']);
  });
  it('writes a creating record before the create call', async () => {
    let seen = null;
    const w = world({
      sf: {
        'org create scratch': (args) => {
          seen = readScratchOrgs(stateDir);
          return created(args);
        },
      },
    });
    await w.adapter.prepare(1, wt);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ story: 'ACME-1', slot: 'w1', alias: 'foreman-acme-1', devHub: 'acme-hub', state: 'creating', jobId: null, username: null, orgId: null });
  });
});

describe('scratch prepare: waiting for the org', () => {
  const inProgress = () => sfError('StillInProgressError', 'The scratch org is not ready yet (Status: Creating).');
  it('polls every 30 seconds until resume succeeds', async () => {
    let n = 0;
    const w = world({ sf: { 'org resume scratch': (args) => (++n <= 2 ? inProgress() : resumed(args)) } });
    expect(await w.adapter.prepare(1, wt)).toBe('reset');
    expect(w.count('org resume scratch')).toBe(3);
    expect(w.wait.mock.calls).toEqual([[30_000], [30_000]]);
    expect(readRecord('ACME-1').state).toBe('ready');
  });
  it('gives up after 20 minutes and keeps the record for the sweep', async () => {
    let w;
    const wait = vi.fn(async (ms) => {
      w.clock.t += ms;
    });
    w = world({ sf: { 'org resume scratch': inProgress }, wait });
    await expect(w.adapter.prepare(1, wt)).rejects.toThrow('the scratch org for ACME-1 was not ready within 20 minutes');
    expect(wait.mock.calls.length).toBe(40);
    expect(w.count('org delete scratch')).toBe(0);
    expect(readRecord('ACME-1')).toMatchObject({ state: 'creating', jobId: ORGS['foreman-acme-1'].jobId, username: ORGS['foreman-acme-1'].username });
  });
});

describe('scratch prepare: the Dev Hub limits', () => {
  it('refuses with no create call when the daily limit is used up', async () => {
    const w = world({ sf: { 'org list limits': limits(0, 2) } });
    const err = await w.adapter.prepare(1, wt).catch((e) => e);
    expect(err.message).toBe('acme-hub has used its 6 scratch orgs for today (DailyScratchOrgs); no scratch org was made for ACME-1. Resume the slot once the Dev Hub has more');
    expect(w.count('org create scratch')).toBe(0);
    expect(hasRecord('ACME-1')).toBe(false);
  });
  it('deletes a closed story\'s org at once when the active limit is used up, then creates', async () => {
    writeScratchOrg(stateDir, readyRecord('ACME-9'));
    let reads = 0;
    const w = world({ sf: { 'org list limits': () => (++reads === 1 ? limits(5, 0) : limits(5, 1)) } });
    expect(await w.adapter.prepare(1, wt)).toBe('reset');
    const lines = w.lines();
    const del = lines.findIndex((l) => l.startsWith(`org delete scratch --target-org ${ORGS['foreman-acme-9'].username} --no-prompt`));
    expect(del).toBe(1);
    expect(lines[2]).toBe('org list limits --target-org acme-hub --json');
    expect(lines[3]).toContain('org create scratch');
    expect(w.wait).not.toHaveBeenCalled();
    expect(hasRecord('ACME-9')).toBe(false);
    expect(readRecord('ACME-1').state).toBe('ready');
  });
  it('never deletes a story still in a slot to make room', async () => {
    writeScratchOrg(stateDir, readyRecord('ACME-2', { slot: 'w2' }));
    setSlot(stateDir, 'w2', { story: { id: 'ACME-2' } });
    const w = world({ sf: { 'org list limits': limits(5, 0) } });
    await expect(w.adapter.prepare(1, wt)).rejects.toThrow(/ActiveScratchOrgs/);
    expect(w.count('org delete scratch')).toBe(0);
    expect(hasRecord('ACME-2')).toBe(true);
  });
  it('refuses naming ActiveScratchOrgs when the sweep frees nothing', async () => {
    writeScratchOrg(stateDir, readyRecord('ACME-9'));
    const w = world({ sf: { 'org list limits': limits(5, 0) } });
    const err = await w.adapter.prepare(1, wt).catch((e) => e);
    expect(err.message).toContain('acme-hub');
    expect(err.message).toContain('ActiveScratchOrgs');
    expect(err.message).toContain('ACME-1');
    expect(w.count('org list limits')).toBe(2);
    expect(w.count('org create scratch')).toBe(0);
    expect(hasRecord('ACME-1')).toBe(false);
  });
  it('refuses when the limits cannot be read', async () => {
    const w = world({ sf: { 'org list limits': sfError('NoAuthInfoFound', 'No authorization information found for admin@hub.acme.example.') } });
    const err = await w.adapter.prepare(1, wt).catch((e) => e);
    expect(err.message).toMatch(/^could not read the scratch org limits of acme-hub: /);
    expect(err.message).not.toContain('@');
    expect(w.count('org create scratch')).toBe(0);
  });
  it('refuses when the limits have no scratch org rows', async () => {
    const w = world({ sf: { 'org list limits': sfOk([{ name: 'DailyApiRequests', max: 15000, remaining: 14000 }]) } });
    await expect(w.adapter.prepare(1, wt)).rejects.toThrow('acme-hub reports no scratch org limits; is Dev Hub turned on?');
    const one = world({ sf: { 'org list limits': sfOk(limitRows().filter((r) => r.name !== 'ActiveScratchOrgs')) } });
    await expect(one.adapter.prepare(1, wt)).rejects.toThrow('acme-hub reports no scratch org limits; is Dev Hub turned on?');
    expect(one.count('org create scratch')).toBe(0);
  });
});

describe('scratch prepare: create and resume failures', () => {
  it('removes the record and names no username when create fails', async () => {
    const w = world({ sf: { 'org create scratch': sfError('SignupFailedError', 'failed for admin@x.acme.example') } });
    const err = await w.adapter.prepare(1, wt).catch((e) => e);
    expect(err.message).toMatch(/^could not request a scratch org from acme-hub: /);
    expect(err.message).not.toContain('@');
    expect(hasRecord('ACME-1')).toBe(false);
    expect(w.count('org resume scratch')).toBe(0);
  });
  it('removes the record when create gives no job ID', async () => {
    const w = world({ sf: { 'org create scratch': sfOk({ username: 'x', scratchOrgInfo: {} }) } });
    await expect(w.adapter.prepare(1, wt)).rejects.toThrow(/acme-hub/);
    expect(hasRecord('ACME-1')).toBe(false);
    expect(w.count('org resume scratch')).toBe(0);
  });
  it('deletes the org and the record when resume fails another way', async () => {
    const w = world({ sf: { 'org resume scratch': sfError('ScratchOrgInfoError', 'The signup request for test-acme-1@scratch.acme.example failed') } });
    const err = await w.adapter.prepare(1, wt).catch((e) => e);
    expect(err.message).toMatch(/^the scratch org for ACME-1 could not be created: /);
    expect(err.message).not.toContain('@');
    expect(w.count(`org delete scratch --target-org ${ORGS['foreman-acme-1'].username} --no-prompt`)).toBe(1);
    expect(hasRecord('ACME-1')).toBe(false);
    expect(w.wait).not.toHaveBeenCalled();
  });
  it('stops polling at once on a login stop', async () => {
    const w = world({ sf: { 'org resume scratch': sfError('SfError', 'login rate exceeded') } });
    await expect(w.adapter.prepare(1, wt)).rejects.toThrow(/could not be created/);
    expect(w.count('org resume scratch')).toBe(1);
    expect(w.wait).not.toHaveBeenCalled();
  });
});

describe('scratch prepare: the identity check', () => {
  it('refuses an org that is not a sandbox, deletes it and removes the record', async () => {
    const w = world({ sf: { 'FROM Organization': orgRecord(ORGS['foreman-acme-1'].orgId, false) } });
    await expect(w.adapter.prepare(1, wt)).rejects.toThrow('foreman-acme-1 is not a sandbox; production is never a target');
    expect(w.count('org delete scratch')).toBe(1);
    expect(w.count('config set target-org')).toBe(0);
    expect(hasRecord('ACME-1')).toBe(false);
  });
  it('refuses another org ID, naming both', async () => {
    const w = world({ sf: { 'FROM Organization': orgRecord('00D000000000999AAA') } });
    await expect(w.adapter.prepare(1, wt)).rejects.toThrow(`foreman-acme-1 is org 00D000000000999, not ${ORGS['foreman-acme-1'].orgId}`);
    expect(w.count('config set target-org')).toBe(0);
    expect(hasRecord('ACME-1')).toBe(false);
  });
  it('reads the org ID from authFields when resume gives none of its own', async () => {
    const w = world({
      sf: {
        'org resume scratch': () => {
          const { username, orgId } = ORGS['foreman-acme-1'];
          return sfOk({ username, authFields: { username, orgId } });
        },
      },
    });
    expect(await w.adapter.prepare(1, wt)).toBe('reset');
    expect(readRecord('ACME-1').orgId).toBe(ORGS['foreman-acme-1'].orgId);
  });
  it('throws when target-org cannot be set', async () => {
    const w = world({ sf: { 'config set target-org': sfError('ConfigSetError', 'no sfdx-project.json') } });
    await expect(w.adapter.prepare(1, wt)).rejects.toThrow(`could not set target-org foreman-acme-1 in ${wt}: no sfdx-project.json`);
  });
});

describe('scratch prepare: a record left before', () => {
  it('replaces a ready record whose check fails', async () => {
    writeScratchOrg(stateDir, readyRecord('ACME-1', { orgId: '00D000000000777AAA' }));
    const w = world();
    expect(await w.adapter.prepare(1, wt)).toBe('reset');
    expect(w.lines()[0]).toBe('data query --query SELECT Id, IsSandbox FROM Organization --target-org foreman-acme-1 --json');
    expect(w.lines()[1]).toBe(`org delete scratch --target-org ${ORGS['foreman-acme-1'].username} --no-prompt --json`);
    expect(w.count('org create scratch')).toBe(1);
    expect(readRecord('ACME-1')).toMatchObject({ state: 'ready', orgId: ORGS['foreman-acme-1'].orgId });
  });
  it('replaces a ready record whose query fails', async () => {
    writeScratchOrg(stateDir, readyRecord('ACME-1'));
    let first = true;
    const w = world({
      sf: {
        'FROM Organization': (args) => {
          if (!first) return orgQuery(args);
          first = false;
          return sfError('NamedOrgNotFoundError', 'No authorization information found for foreman-acme-1.');
        },
      },
    });
    expect(await w.adapter.prepare(1, wt)).toBe('reset');
    expect(w.count('org delete scratch')).toBe(1);
    expect(w.count('org create scratch')).toBe(1);
  });
  it('replaces a ready record whose alias is not the story\'s, with no query on that alias', async () => {
    writeScratchOrg(stateDir, readyRecord('ACME-1', { alias: 'foreman-acme-9' }));
    const w = world();
    expect(await w.adapter.prepare(1, wt)).toBe('reset');
    expect(w.lines().some((l) => l.includes('--target-org foreman-acme-9'))).toBe(false);
    expect(w.count('org create scratch')).toBe(1);
    expect(readRecord('ACME-1')).toMatchObject({ alias: 'foreman-acme-1', state: 'ready' });
    expect(w.lines()).toContain('config set target-org foreman-acme-1 --json');
  });
  it('replaces a creating record a dead run left', async () => {
    writeScratchOrg(stateDir, readyRecord('ACME-1', { state: 'creating', orgId: null, readyAt: undefined }));
    const w = world();
    expect(await w.adapter.prepare(1, wt)).toBe('reset');
    expect(w.lines()[0]).toBe(`org resume scratch --job-id ${ORGS['foreman-acme-1'].jobId} --wait 0 --json`);
    expect(w.lines()[1]).toBe(`org delete scratch --target-org ${ORGS['foreman-acme-1'].username} --no-prompt --json`);
    expect(w.count('org create scratch')).toBe(1);
  });
  it('resumes a creating record once before deleting it, and records the org it signed in', async () => {
    writeScratchOrg(stateDir, readyRecord('ACME-1', { state: 'creating', username: null, orgId: null, readyAt: undefined }));
    const w = world({ sf: { 'org delete scratch': sfError('SfError', 'Request timed out for test-acme-1@scratch.acme.example') } });
    const err = await w.adapter.prepare(1, wt).catch((e) => e);
    expect(err.message).toMatch(/^could not replace the scratch org foreman-acme-1 of ACME-1: /);
    expect(err.message).not.toContain('@');
    expect(w.count('org resume scratch')).toBe(1);
    expect(w.lines()[1]).toBe(`org delete scratch --target-org ${ORGS['foreman-acme-1'].username} --no-prompt --json`);
    expect(w.count('org create scratch')).toBe(0);
    expect(readRecord('ACME-1')).toMatchObject({ state: 'creating', orgId: ORGS['foreman-acme-1'].orgId, username: ORGS['foreman-acme-1'].username });
  });
  it('keeps a creating record whose org is still being made, with no delete and no second org', async () => {
    writeScratchOrg(stateDir, readyRecord('ACME-1', { state: 'creating', orgId: null, readyAt: undefined }));
    let w;
    // The clock moves with each wait, so a poll loop ends.
    const wait = vi.fn(async (ms) => {
      w.clock.t += ms;
    });
    w = world({ sf: { 'org resume scratch': sfError('StillInProgressError', 'The scratch org is not ready yet (Status: Creating).') }, wait });
    const err = await w.adapter.prepare(1, wt).catch((e) => e);
    expect(err.message).toBe('could not replace the scratch org foreman-acme-1 of ACME-1: its org is still being made');
    expect(w.count('org resume scratch')).toBe(1);
    expect(w.count('org delete scratch')).toBe(0);
    expect(w.count('org create scratch')).toBe(0);
    expect(w.count('org list limits')).toBe(0);
    expect(wait).not.toHaveBeenCalled();
    expect(readRecord('ACME-1')).toMatchObject({ state: 'creating', orgId: null, jobId: ORGS['foreman-acme-1'].jobId });
  });
  it('keeps a creating record, and makes no delete, when its resume hits a login stop', async () => {
    writeScratchOrg(stateDir, readyRecord('ACME-1', { state: 'creating', orgId: null, readyAt: undefined }));
    const w = world({ sf: { 'org resume scratch': sfError('SfError', 'login rate exceeded') } });
    const err = await w.adapter.prepare(1, wt).catch((e) => e);
    expect(err.message).toMatch(/^could not replace the scratch org foreman-acme-1 of ACME-1: /);
    expect(err.message).not.toContain('still being made');
    expect(w.count('org delete scratch')).toBe(0);
    expect(w.count('org create scratch')).toBe(0);
    expect(hasRecord('ACME-1')).toBe(true);
  });
  it('refuses when the old org cannot be deleted', async () => {
    writeScratchOrg(stateDir, readyRecord('ACME-1', { state: 'creating' }));
    const w = world({ sf: { 'org delete scratch': sfError('SfError', 'Request timed out for test-acme-1@scratch.acme.example') } });
    const err = await w.adapter.prepare(1, wt).catch((e) => e);
    expect(err.message).toMatch(/^could not replace the scratch org foreman-acme-1 of ACME-1: /);
    expect(err.message).not.toContain('@');
    expect(w.count('org create scratch')).toBe(0);
    expect(hasRecord('ACME-1')).toBe(true);
  });
});

describe('scratch sweep: delete on close', () => {
  const closed = () => {
    writeScratchOrg(stateDir, readyRecord('ACME-1'));
    return world({ story: 'ACME-2' });
  };
  it('deletes a story\'s org once it has been out of every slot for 5 minutes', async () => {
    const w = closed();
    expect(await w.adapter.sweep()).toEqual({ deleted: [], warnings: [] });
    expect(w.count('org delete scratch')).toBe(0);
    w.clock.t += 4 * MIN;
    expect(await w.adapter.sweep()).toEqual({ deleted: [], warnings: [] });
    w.clock.t += MIN;
    expect(await w.adapter.sweep()).toEqual({ deleted: ['ACME-1'], warnings: [] });
    expect(w.lines()).toEqual([`org delete scratch --target-org ${ORGS['foreman-acme-1'].username} --no-prompt --json`]);
    expect(hasRecord('ACME-1')).toBe(false);
  });
  it('starts the grace again when the story comes back to a slot', async () => {
    const w = closed();
    await w.adapter.sweep();
    w.clock.t += 3 * MIN;
    setSlot(stateDir, 'w2', { story: { id: 'ACME-1' } });
    await w.adapter.sweep();
    setSlot(stateDir, 'w2', { story: null });
    w.clock.t += 3 * MIN;
    expect((await w.adapter.sweep()).deleted).toEqual([]);
    w.clock.t += 5 * MIN;
    expect((await w.adapter.sweep()).deleted).toEqual(['ACME-1']);
  });
  it('never deletes a story in a slot, as its story or its held story', async () => {
    writeScratchOrg(stateDir, readyRecord('ACME-1'));
    writeScratchOrg(stateDir, readyRecord('ACME-2', { slot: 'w2' }));
    setSlot(stateDir, 'w2', { state: 'held', heldStory: 'ACME-2', story: null });
    const w = world({ story: 'ACME-1' });
    await w.adapter.sweep();
    w.clock.t += 60 * MIN;
    expect(await w.adapter.sweep()).toEqual({ deleted: [], warnings: [] });
    expect(w.sh.calls).toEqual([]);
  });
  it('removes the record when the org is no longer signed in', async () => {
    writeScratchOrg(stateDir, readyRecord('ACME-1'));
    const w = world({ story: 'ACME-2', sf: { 'org delete scratch': sfError('NamedOrgNotFoundError', 'No authorization information found for test-acme-1@scratch.acme.example.') } });
    await w.adapter.sweep();
    w.clock.t += 5 * MIN;
    expect(await w.adapter.sweep()).toEqual({ deleted: ['ACME-1'], warnings: [] });
    expect(hasRecord('ACME-1')).toBe(false);
  });
  it('keeps the record and warns, with no username, when the delete fails', async () => {
    writeScratchOrg(stateDir, readyRecord('ACME-1'));
    const w = world({ story: 'ACME-2', sf: { 'org delete scratch': sfError('SfError', 'Request timed out for test-acme-1@scratch.acme.example') } });
    await w.adapter.sweep();
    w.clock.t += 5 * MIN;
    const r = await w.adapter.sweep();
    expect(r.deleted).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/^could not delete the scratch org foreman-acme-1 of ACME-1: /);
    expect(r.warnings[0]).not.toContain('@');
    expect(hasRecord('ACME-1')).toBe(true);
  });
  it('skips a creating record silently while its org is still being made, then deletes it once it is ready', async () => {
    writeScratchOrg(stateDir, readyRecord('ACME-1', { state: 'creating', orgId: null, readyAt: undefined }));
    let making = true;
    const w = world({ story: 'ACME-2', sf: { 'org resume scratch': (args) => (making ? sfError('StillInProgressError', 'The scratch org is not ready yet (Status: Creating).') : resumed(args)) } });
    await w.adapter.sweep();
    w.clock.t += 5 * MIN;
    expect(await w.adapter.sweep()).toEqual({ deleted: [], warnings: [] });
    w.clock.t += MIN;
    expect(await w.adapter.sweep()).toEqual({ deleted: [], warnings: [] });
    expect(w.count('org resume scratch')).toBe(2);
    expect(w.count('org delete scratch')).toBe(0);
    expect(hasRecord('ACME-1')).toBe(true);
    making = false;
    w.clock.t += MIN;
    expect(await w.adapter.sweep()).toEqual({ deleted: ['ACME-1'], warnings: [] });
    expect(w.lines().slice(-2)).toEqual([
      `org resume scratch --job-id ${ORGS['foreman-acme-1'].jobId} --wait 0 --json`,
      `org delete scratch --target-org ${ORGS['foreman-acme-1'].username} --no-prompt --json`,
    ]);
    expect(hasRecord('ACME-1')).toBe(false);
  });
  it('goes on to the delete when the resume of a creating record says its job is gone', async () => {
    writeScratchOrg(stateDir, readyRecord('ACME-1', { state: 'creating', orgId: null, readyAt: undefined }));
    const w = world({
      story: 'ACME-2',
      sf: {
        'org resume scratch': sfError('ScratchOrgInfoError', 'The signup request for test-acme-1@scratch.acme.example failed'),
        'org delete scratch': sfError('NamedOrgNotFoundError', 'No authorization information found for test-acme-1@scratch.acme.example.'),
      },
    });
    await w.adapter.sweep();
    w.clock.t += 5 * MIN;
    expect(await w.adapter.sweep()).toEqual({ deleted: ['ACME-1'], warnings: [] });
    expect(w.lines()).toEqual([
      `org resume scratch --job-id ${ORGS['foreman-acme-1'].jobId} --wait 0 --json`,
      `org delete scratch --target-org ${ORGS['foreman-acme-1'].username} --no-prompt --json`,
    ]);
    expect(hasRecord('ACME-1')).toBe(false);
  });
  it('removes a record with no username and no org ID with no sf call', async () => {
    writeScratchOrg(stateDir, readyRecord('ACME-1', { state: 'creating', username: null, orgId: null, jobId: null }));
    const w = world({ story: 'ACME-2' });
    await w.adapter.sweep();
    w.clock.t += 5 * MIN;
    expect(await w.adapter.sweep()).toEqual({ deleted: ['ACME-1'], warnings: [] });
    expect(w.sh.calls).toEqual([]);
    expect(hasRecord('ACME-1')).toBe(false);
  });
  it('targets the alias when the record has an org ID but no username', async () => {
    writeScratchOrg(stateDir, readyRecord('ACME-1', { username: null }));
    const w = world({ story: 'ACME-2' });
    await w.adapter.sweep();
    w.clock.t += 5 * MIN;
    await w.adapter.sweep();
    expect(w.lines()).toEqual(['org delete scratch --target-org foreman-acme-1 --no-prompt --json']);
  });
  it('still resolves when sh throws, keeping the record', async () => {
    writeScratchOrg(stateDir, readyRecord('ACME-1'));
    setSlot(stateDir, 'w1', { story: { id: 'ACME-2' } });
    const boom = () => {
      throw new Error('spawn sf ENOENT');
    };
    const clock = { t: T0 };
    const adapter = create({ adapter: 'scratch' }, { root: ROOT, stateDir, config: scratchConfig(), sh: boom, env: { FOREMAN_SF_HOME: sfHomeDir }, homedir: HOMEDIR, wait: async () => {}, now: () => clock.t });
    await expect(adapter.sweep()).resolves.toEqual({ deleted: [], warnings: [] });
    clock.t += 5 * MIN;
    const r = await adapter.sweep();
    expect(r.deleted).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(hasRecord('ACME-1')).toBe(true);
  });
  it('still resolves, with no warning, when the state folder cannot be read', async () => {
    const file = path.join(stateDir, 'a-file');
    fs.writeFileSync(file, 'x');
    const adapter = create({ adapter: 'scratch' }, { root: ROOT, stateDir: file, config: scratchConfig(), sh: fakeSfShell(routes()), env: { FOREMAN_SF_HOME: sfHomeDir }, homedir: HOMEDIR, wait: async () => {} });
    await expect(adapter.sweep()).resolves.toEqual({ deleted: [], warnings: [] });
  });
  it('resolves with one warning when the sweep itself throws', async () => {
    writeScratchOrg(stateDir, readyRecord('ACME-1'));
    const now = () => {
      throw new Error('clock broke');
    };
    const adapter = create({ adapter: 'scratch' }, { root: ROOT, stateDir, config: scratchConfig(), sh: fakeSfShell(routes()), env: { FOREMAN_SF_HOME: sfHomeDir }, homedir: HOMEDIR, wait: async () => {}, now });
    const r = await adapter.sweep();
    expect(r.deleted).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('clock broke');
  });
  it('runs one sweep for two calls at once', async () => {
    const w = closed();
    w.clock.t = T0;
    await w.adapter.sweep();
    w.clock.t += 5 * MIN;
    const a = w.adapter.sweep();
    const b = w.adapter.sweep();
    expect(b).toBe(a);
    await Promise.all([a, b]);
    expect(w.count('org delete scratch')).toBe(1);
    const c = w.adapter.sweep();
    expect(c).not.toBe(a);
    await c;
  });
});
