import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { envAdapterContract } from '../../../lib/adapters/env/contract.mjs';
import { setSlot } from '../../../lib/engine/state.mjs';
import { layout } from '../config.mjs';
import { create, manifestTypes } from './sandbox-pool.mjs';
import { fakeSfShell, orgRecord, orgRoute, sfError, sfOk } from '../../../../test/fake-sf.mjs';

const ID1 = '00D000000000001AAA';
const ID2 = '00D000000000002AAA';
const ROOT = '/acme/repo';
const HOMEDIR = '/acme/home';
const HEADSHA = 'a'.repeat(40);
const BASESHA = 'b'.repeat(40);

const poolBlock = () => ({
  orgs: { 'acme-dev1': { orgId: ID1 }, 'acme-dev2': { orgId: ID2 }, 'acme-qa': { orgId: '00D000000000003AAA' } },
  build: ['acme-dev1', 'acme-dev2'],
  stages: [{ name: 'qa', org: 'acme-qa' }],
});
const poolConfig = (block = poolBlock(), rest = {}) => ({ slots: 2, remote: 'origin', baseBranch: 'main', branchPrefix: 'story/', pack: 'salesforce', salesforce: block, ...rest });
const sharedConfig = () =>
  poolConfig({ orgs: { 'acme-dev1': { orgId: ID1 } }, build: 'acme-dev1', stages: [{ name: 'dev', org: 'acme-dev1' }] }, { slots: 1 });

// package.xml or destructiveChanges.xml holding `types` ({ ApexClass: ['AcmeNew'] }).
const manifest = (types = {}) =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
    ...Object.entries(types).map(([name, members]) => `  <types>\n${members.map((m) => `    <members>${m}</members>`).join('\n')}\n    <name>${name}</name>\n  </types>`),
    '  <version>62.0</version>',
    '</Package>',
    '',
  ].join('\n');

const REMOVES_ACME_NEW = { package: {}, destructive: { ApexClass: ['AcmeNew', 'AcmeNewTest'] } };

// The `sf sgd source delta` fake: writes the two manifests into the --output-dir it is given.
const sgdRoute = (delta) => (args) => {
  const out = args[args.indexOf('--output-dir') + 1];
  fs.mkdirSync(path.join(out, 'package'), { recursive: true });
  fs.mkdirSync(path.join(out, 'destructiveChanges'), { recursive: true });
  fs.writeFileSync(path.join(out, 'package', 'package.xml'), manifest(delta.package));
  fs.writeFileSync(path.join(out, 'destructiveChanges', 'destructiveChanges.xml'), manifest(delta.destructive));
  return sfOk({ error: null, 'output-dir': out, success: true });
};

// Healthy Acme sf answers; routes in `over` come first and keep their answers, so they win.
const sfRoutes = (over = {}) => ({ ...over, ...healthySf(), ...over });
const healthySf = () => ({
  [orgRoute('acme-dev1')]: orgRecord(ID1),
  [orgRoute('acme-dev2')]: orgRecord(ID2),
  'config set target-org': (args) => sfOk({ successes: [{ name: 'target-org', value: args[3] }], failures: [] }),
  'FROM SourceMember': sfOk({ records: [], totalSize: 0, done: true }),
  'sgd source delta': sgdRoute(REMOVES_ACME_NEW),
  'project deploy start': sfOk({ status: 'Succeeded', success: true, done: true }),
  'org list metadata': sfOk([{ fullName: 'AcmeOld' }]),
  'project reset tracking': sfOk({ sourceMembers: [] }),
});

const ok = (stdout = '') => ({ status: 0, stdout });
const fail = () => ({ status: 1, stdout: '' });

// git and gh answers; `over` keys are matched against "<cmd> <args>" and win.
const otherRoutes = (over = {}) => (cmd, args) => {
  const line = [cmd, ...args].join(' ');
  for (const [key, answer] of Object.entries(over)) if (line.includes(key)) return typeof answer === 'function' ? answer(args) : answer;
  if (line.startsWith('gh pr list')) return ok('[]\n');
  if (line.includes('rev-parse --verify origin/main^{commit}')) return ok(`${BASESHA}\n`);
  if (line.includes('rev-parse --verify --quiet refs/heads/story/acme-1^{commit}')) return ok(`${HEADSHA}\n`);
  if (line.includes('rev-parse')) return fail();
  return ok();
};

let stateDir;
let wt;
let sfHomeDir;
beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-pool-state-'));
  wt = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-pool-wt-'));
  sfHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-pool-sfhome-'));
});
afterEach(() => {
  for (const d of [stateDir, wt, sfHomeDir]) fs.rmSync(d, { recursive: true, force: true });
});

const recordFile = (orgId = ID1) => path.join(stateDir, 'salesforce', 'orgs', `${orgId.slice(0, 15)}.json`);
const readRecord = (orgId = ID1) => JSON.parse(fs.readFileSync(recordFile(orgId), 'utf8'));
const writeRecord = (record, orgId = ID1) => {
  fs.mkdirSync(path.dirname(recordFile(orgId)), { recursive: true });
  fs.writeFileSync(recordFile(orgId), JSON.stringify({ alias: 'acme-dev1', orgId, at: '2026-10-22T10:00:00.000Z', ...record }));
};
const unshipped = () => writeRecord({ story: 'ACME-1', branch: 'story/acme-1' });

// An adapter over fake sf, git and gh. Slot w1 works on ACME-2 unless `story` is null.
function world({ sf = {}, other = {}, config = poolConfig(), story = 'ACME-2', slot = 'w1' } = {}) {
  if (story) setSlot(stateDir, slot, { story: { id: story } });
  const sh = fakeSfShell(sfRoutes(sf), otherRoutes(other));
  const adapter = create({ adapter: 'sandbox-pool' }, { root: ROOT, stateDir, config, sh, env: { PATH: '/usr/bin', FOREMAN_SF_HOME: sfHomeDir }, homedir: HOMEDIR });
  const calls = sh.calls;
  const lines = () => calls.map((c) => [c.cmd, ...c.args].join(' '));
  const index = (text) => lines().findIndex((l) => l.includes(text));
  const ran = (text) => index(text) >= 0;
  const find = (text) => calls.find((c) => [c.cmd, ...c.args].join(' ').includes(text));
  return { adapter, calls, lines, index, ran, find };
}

const contractDirs = [];
afterAll(() => {
  for (const d of contractDirs) fs.rmSync(d, { recursive: true, force: true });
});
envAdapterContract({
  name: 'sandbox-pool',
  make: () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-pool-contract-'));
    contractDirs.push(dir);
    const sh = fakeSfShell(sfRoutes(), otherRoutes());
    return create({ adapter: 'sandbox-pool' }, { root: ROOT, stateDir: dir, config: poolConfig(), sh, env: { FOREMAN_SF_HOME: path.join(dir, 'sf-home') }, homedir: HOMEDIR });
  },
});

describe('sandbox-pool env(n)', () => {
  it('names the slot and nothing else', () => {
    expect(world({ story: null }).adapter.env(2)).toEqual({ FOREMAN_SLOT: 'w2' });
  });
});

describe('sandbox-pool create', () => {
  it('refuses an unknown option', () => {
    expect(() => create({ adapter: 'sandbox-pool', pool: ['x'] }, { root: ROOT, stateDir, config: poolConfig() })).toThrow('env adapter sandbox-pool: unknown option pool');
  });
  it('refuses scratch mode and a block with no build orgs', () => {
    const scratch = poolConfig({ orgs: { 'acme-hub': { orgId: ID1 } }, build: { scratch: { devHub: 'acme-hub', definition: 'config/project-scratch-def.json' } }, stages: [] });
    expect(() => create({ adapter: 'sandbox-pool' }, { root: ROOT, stateDir, config: scratch })).toThrow('env adapter sandbox-pool: salesforce.build must name one or more sandboxes');
    expect(() => create({}, { root: ROOT, stateDir, config: poolConfig({ orgs: {} }) })).toThrow(/must name one or more sandboxes/);
  });
});

describe('sandbox-pool prepare: one org per slot', () => {
  it('works only on the slot\'s own org', () => {
    const two = world({ story: null });
    expect(two.adapter.prepare(2, wt)).toBe('up');
    const sf = two.calls.filter((c) => c.cmd === 'sf').map((c) => c.args.join(' '));
    expect(sf.length).toBeGreaterThan(0);
    for (const line of sf) {
      expect(line.includes('--target-org acme-dev2') || line.startsWith('config set target-org acme-dev2')).toBe(true);
      expect(line).not.toContain('acme-dev1');
    }

    const one = world({ story: null });
    expect(one.adapter.prepare(1, wt)).toBe('up');
    for (const line of one.calls.filter((c) => c.cmd === 'sf').map((c) => c.args.join(' '))) {
      expect(line.includes('--target-org acme-dev1') || line.startsWith('config set target-org acme-dev1')).toBe(true);
      expect(line).not.toContain('acme-dev2');
    }
  });
  it('throws for a slot with no build org', () => {
    expect(() => world({ story: null }).adapter.prepare(3, wt)).toThrow('slot w3 has no build org in salesforce.build');
  });
});

describe('sandbox-pool prepare: the identity check', () => {
  it('refuses production and makes no other call', () => {
    unshipped();
    const w = world({ sf: { [orgRoute('acme-dev1')]: orgRecord(ID1, false) } });
    expect(() => w.adapter.prepare(1, wt)).toThrow('acme-dev1 is not a sandbox; production is never a target');
    expect(w.lines()).toEqual([`sf data query --query SELECT Id, IsSandbox FROM Organization --target-org acme-dev1 --json`]);
    expect(readRecord().story).toBe('ACME-1');
  });
  it('writes no record after a refusal on a first lease', () => {
    const w = world({ sf: { [orgRoute('acme-dev1')]: orgRecord(ID1, false) } });
    expect(() => w.adapter.prepare(1, wt)).toThrow(/production is never a target/);
    expect(fs.existsSync(recordFile())).toBe(false);
  });
  it('refuses a different org and makes no other call', () => {
    unshipped();
    const w = world({ sf: { [orgRoute('acme-dev1')]: orgRecord(ID2) } });
    expect(() => w.adapter.prepare(1, wt)).toThrow(/is org .* not /);
    expect(() => w.adapter.prepare(1, wt)).toThrow(`acme-dev1 is org ${ID2.slice(0, 15)}, not ${ID1}`);
    expect(w.lines()).toEqual(Array(2).fill(`sf data query --query SELECT Id, IsSandbox FROM Organization --target-org acme-dev1 --json`));
    expect(readRecord().story).toBe('ACME-1');
  });
  it('accepts the 18-character form of a 15-character org ID', () => {
    const block = poolBlock();
    block.orgs['acme-dev1'].orgId = ID1.slice(0, 15);
    expect(world({ config: poolConfig(block) }).adapter.prepare(1, wt)).toBe('up');
  });
  it('throws when the query fails, naming only the alias and sf\'s message', () => {
    const w = world({ sf: { [orgRoute('acme-dev1')]: sfError('NoAuthInfoFound', 'No authorization information found for acme-dev1.') } });
    expect(() => w.adapter.prepare(1, wt)).toThrow('could not check acme-dev1: No authorization information found for acme-dev1.');
    expect(w.calls).toHaveLength(1);
  });
});

describe('sandbox-pool prepare: target-org and tracking', () => {
  it('sets the worktree\'s own target-org under the isolated home, after the identity check', () => {
    const w = world();
    w.adapter.prepare(1, wt);
    const set = w.find('config set target-org');
    expect(set.args).toEqual(['config', 'set', 'target-org', 'acme-dev1', '--json']);
    expect(set.opts.cwd).toBe(wt);
    expect(set.opts.env.HOME).toBe(sfHomeDir);
    expect(w.index('FROM Organization')).toBe(0);
    expect(w.index('config set target-org')).toBe(1);
  });
  it('throws when target-org cannot be set', () => {
    const w = world({ sf: { 'config set target-org': sfError('ConfigSetError', 'no sfdx-project.json') } });
    expect(() => w.adapter.prepare(1, wt)).toThrow(`could not set target-org acme-dev1 in ${wt}: no sfdx-project.json`);
  });
  it('throws when source tracking is off', () => {
    const w = world({ sf: { 'FROM SourceMember': sfError('INVALID_TYPE', "sObject type 'SourceMember' is not supported.") } });
    expect(() => w.adapter.prepare(1, wt)).toThrow('source tracking is off in acme-dev1');
    expect(w.ran('reset tracking')).toBe(false);
  });
  it('throws when the tracking check fails another way', () => {
    const w = world({ sf: { 'FROM SourceMember': sfError('SfError', 'socket hang up') } });
    expect(() => w.adapter.prepare(1, wt)).toThrow('could not check source tracking in acme-dev1: socket hang up');
  });
  it('resets tracking in the worktree on every prepare', () => {
    const w = world();
    w.adapter.prepare(1, wt);
    w.adapter.prepare(1, wt);
    const resets = w.calls.filter((c) => c.args.join(' ').startsWith('project reset tracking'));
    expect(resets).toHaveLength(2);
    for (const r of resets) {
      expect(r.args).toEqual(['project', 'reset', 'tracking', '--no-prompt', '--target-org', 'acme-dev1', '--json']);
      expect(r.opts.cwd).toBe(wt);
    }
  });
  it('throws when tracking cannot be reset, and keeps the old record', () => {
    writeRecord({ story: 'ACME-2', branch: 'story/acme-2', at: 'then' });
    const w = world({ story: 'ACME-3', other: { 'gh pr list': ok('[{"number":7}]') }, sf: { 'project reset tracking': sfError('SfError', 'tracking files locked') } });
    expect(() => w.adapter.prepare(1, wt)).toThrow('could not reset source tracking in acme-dev1: tracking files locked');
    expect(readRecord().story).toBe('ACME-2');
  });
});

describe('sandbox-pool prepare: clean-up after an unshipped story', () => {
  it('deploys the reverse delta, confirms the removal, resets tracking and returns reset', () => {
    unshipped();
    const w = world();
    expect(w.adapter.prepare(1, wt)).toBe('reset');

    const gh = w.find('gh pr list');
    expect(gh.args).toEqual(['pr', 'list', '--head', 'story/acme-1', '--state', 'merged', '--limit', '1', '--json', 'number']);
    expect(gh.opts.cwd).toBe(ROOT);
    expect(w.ran('git fetch --quiet origin main')).toBe(true);

    const add = w.find('git worktree add --detach');
    const tree = add.args[3];
    expect(add.args).toEqual(['worktree', 'add', '--detach', tree, BASESHA]);
    expect(add.opts.cwd).toBe(ROOT);

    const sgd = w.find('sgd source delta');
    const out = sgd.args[sgd.args.indexOf('--output-dir') + 1];
    expect(sgd.args).toEqual(['sgd', 'source', 'delta', '--from', HEADSHA, '--to', BASESHA, '--output-dir', out, '--generate-delta', '--json']);
    expect(sgd.opts.cwd).toBe(tree);
    expect(path.dirname(tree)).toBe(path.dirname(out));

    const deploy = w.find('project deploy start');
    expect(deploy.args).toEqual([
      'project', 'deploy', 'start',
      '--manifest', path.join(out, 'package', 'package.xml'),
      '--post-destructive-changes', path.join(out, 'destructiveChanges', 'destructiveChanges.xml'),
      '--test-level', 'NoTestRun',
      '--target-org', 'acme-dev1',
      '--wait', '30',
      '--json',
    ]);
    expect(deploy.opts.cwd).toBe(tree);
    expect(deploy.args.some((a) => a.startsWith('--ignore') || a === 'quick')).toBe(false);

    const list = w.find('org list metadata');
    expect(list.args).toEqual(['org', 'list', 'metadata', '--metadata-type', 'ApexClass', '--target-org', 'acme-dev1', '--json']);

    expect(w.index('reset tracking')).toBeGreaterThan(w.index('project deploy start'));
    expect(w.index('git worktree remove --force')).toBeGreaterThan(w.index('org list metadata'));
    expect(w.find('git worktree remove --force').args).toEqual(['worktree', 'remove', '--force', tree]);
    expect(fs.existsSync(path.dirname(out))).toBe(false);

    expect(readRecord()).toEqual({ alias: 'acme-dev1', orgId: ID1, story: 'ACME-2', branch: 'story/acme-2', at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) });
  });
  it('cleans after a story when gh cannot say it merged', () => {
    unshipped();
    const w = world({ other: { 'gh pr list': fail() } });
    expect(w.adapter.prepare(1, wt)).toBe('reset');
    expect(w.ran('project deploy start')).toBe(true);
  });
  it('uses the remote branch when the local one is gone', () => {
    unshipped();
    const w = world({ other: { 'refs/heads/story/acme-1': fail(), 'refs/remotes/origin/story/acme-1^{commit}': ok(`${HEADSHA}\n`) } });
    expect(w.adapter.prepare(1, wt)).toBe('reset');
    expect(w.find('sgd source delta').args.slice(3, 7)).toEqual(['--from', HEADSHA, '--to', BASESHA]);
  });
  it('still cleans when the fetch fails, after three tries', () => {
    unshipped();
    const w = world({ other: { 'git fetch': fail() } });
    expect(w.adapter.prepare(1, wt)).toBe('reset');
    expect(w.lines().filter((l) => l.startsWith('git fetch'))).toHaveLength(3);
  });
  it('throws when the base cannot be read', () => {
    unshipped();
    const w = world({ other: { 'origin/main^{commit}': fail() } });
    expect(() => w.adapter.prepare(1, wt)).toThrow('could not read origin/main');
    expect(readRecord().story).toBe('ACME-1');
  });
  it('lists a foldered member in its folder', () => {
    unshipped();
    const w = world({ sf: { 'sgd source delta': sgdRoute({ package: {}, destructive: { Report: ['AcmeReports/AcmeNewReport'] } }) } });
    expect(w.adapter.prepare(1, wt)).toBe('reset');
    expect(w.find('org list metadata').args).toEqual(['org', 'list', 'metadata', '--metadata-type', 'Report', '--target-org', 'acme-dev1', '--folder', 'AcmeReports', '--json']);
  });
  it('deploys nothing for an empty delta and returns up', () => {
    unshipped();
    const w = world({ sf: { 'sgd source delta': sgdRoute({ package: {}, destructive: {} }) } });
    expect(w.adapter.prepare(1, wt)).toBe('up');
    expect(w.ran('project deploy start')).toBe(false);
    expect(w.ran('git worktree remove --force')).toBe(true);
    expect(readRecord().story).toBe('ACME-2');
  });
  it('throws when the delta cannot be built, and removes the temp worktree', () => {
    unshipped();
    const w = world({ sf: { 'sgd source delta': sfError('SfError', 'bad revision') } });
    expect(() => w.adapter.prepare(1, wt)).toThrow('could not build the clean-up delta for acme-dev1: bad revision');
    expect(w.ran('git worktree remove --force')).toBe(true);
  });
  it('throws when the clean-up deploy fails, keeps the record, removes the temp worktree and resets nothing', () => {
    unshipped();
    const w = world({ sf: { 'project deploy start': sfError('DeployFailed', 'Component failures: 1') } });
    expect(() => w.adapter.prepare(1, wt)).toThrow('the clean-up deploy to acme-dev1 failed: Component failures: 1');
    expect(readRecord().story).toBe('ACME-1');
    expect(w.ran('git worktree remove --force')).toBe(true);
    const out = w.find('sgd source delta').args[8];
    expect(fs.existsSync(path.dirname(out))).toBe(false);
    expect(w.ran('reset tracking')).toBe(false);
  });
  it('throws when a removed component is still on the org', () => {
    unshipped();
    const w = world({ sf: { 'org list metadata': sfOk({ fullName: 'AcmeNew' }) } });
    expect(() => w.adapter.prepare(1, wt)).toThrow('acme-dev1 still holds ApexClass AcmeNew after the clean-up');
    expect(readRecord().story).toBe('ACME-1');
  });
  it('throws when the removal cannot be confirmed', () => {
    unshipped();
    const w = world({ sf: { 'org list metadata': sfError('SfError', 'INVALID_SESSION') } });
    expect(() => w.adapter.prepare(1, wt)).toThrow('could not confirm the clean-up in acme-dev1: INVALID_SESSION');
  });
  it('confirms each type with one list call', () => {
    unshipped();
    const w = world();
    expect(w.adapter.prepare(1, wt)).toBe('reset');
    const lists = w.calls.filter((c) => [c.cmd, ...c.args].join(' ').includes('org list metadata'));
    expect(lists).toHaveLength(1);
    expect(lists[0].args).toEqual(['org', 'list', 'metadata', '--metadata-type', 'ApexClass', '--target-org', 'acme-dev1', '--json']);
  });
  it('lists each type and folder once', () => {
    unshipped();
    const destructive = { ApexClass: ['AcmeNew', 'AcmeNewTest'], Report: ['AcmeReports/AcmeA', 'AcmeReports/AcmeB', 'AcmeOther/AcmeC'] };
    const w = world({ sf: { 'sgd source delta': sgdRoute({ package: {}, destructive }) } });
    expect(w.adapter.prepare(1, wt)).toBe('reset');
    const lists = w.calls.filter((c) => [c.cmd, ...c.args].join(' ').includes('org list metadata')).map((c) => c.args);
    expect(lists).toEqual([
      ['org', 'list', 'metadata', '--metadata-type', 'ApexClass', '--target-org', 'acme-dev1', '--json'],
      ['org', 'list', 'metadata', '--metadata-type', 'Report', '--target-org', 'acme-dev1', '--folder', 'AcmeReports', '--json'],
      ['org', 'list', 'metadata', '--metadata-type', 'Report', '--target-org', 'acme-dev1', '--folder', 'AcmeOther', '--json'],
    ]);
  });
  it('names a later member of a group that is still on the org', () => {
    unshipped();
    const w = world({ sf: { 'org list metadata': sfOk([{ fullName: 'AcmeNewTest' }]) } });
    expect(() => w.adapter.prepare(1, wt)).toThrow('acme-dev1 still holds ApexClass AcmeNewTest after the clean-up');
    expect(w.lines().filter((l) => l.includes('org list metadata'))).toHaveLength(1);
    expect(readRecord().story).toBe('ACME-1');
  });
  it('throws when the base cannot be checked out, deploys nothing and keeps the record', () => {
    unshipped();
    const w = world({ other: { 'git worktree add': fail() } });
    expect(() => w.adapter.prepare(1, wt)).toThrow('could not check out origin/main for the clean-up of acme-dev1');
    for (const text of ['sgd source delta', 'project deploy start', 'reset tracking']) expect(w.ran(text)).toBe(false);
    expect(readRecord().story).toBe('ACME-1');
    const tree = w.find('git worktree add --detach').args[3];
    expect(fs.existsSync(path.dirname(tree))).toBe(false);
  });
});

describe('sandbox-pool prepare: when no clean-up runs', () => {
  it('skips a previous story whose pull request merged', () => {
    unshipped();
    const w = world({ other: { 'gh pr list': ok('[{"number":7}]\n') } });
    expect(w.adapter.prepare(1, wt)).toBe('up');
    for (const text of ['sgd source delta', 'project deploy start', 'git worktree add']) expect(w.ran(text)).toBe(false);
    expect(readRecord().story).toBe('ACME-2');
  });
  it('keeps the deploys of the same story when it resumes', () => {
    writeRecord({ story: 'ACME-2', branch: 'story/acme-2' });
    const w = world();
    expect(w.adapter.prepare(1, wt)).toBe('up');
    for (const text of ['gh pr list', 'sgd source delta', 'project deploy start']) expect(w.ran(text)).toBe(false);
    expect(w.ran('reset tracking')).toBe(true);
  });
  it('cleans nothing on a first lease and records the story', () => {
    const w = world();
    expect(w.adapter.prepare(1, wt)).toBe('up');
    expect(w.ran('gh pr list')).toBe(false);
    expect(readRecord()).toMatchObject({ alias: 'acme-dev1', orgId: ID1, story: 'ACME-2', branch: 'story/acme-2' });
  });
  it('treats an unreadable record as none', () => {
    fs.mkdirSync(path.dirname(recordFile()), { recursive: true });
    fs.writeFileSync(recordFile(), '{not json');
    const w = world();
    expect(w.adapter.prepare(1, wt)).toBe('up');
    expect(w.ran('gh pr list')).toBe(false);
    expect(readRecord().story).toBe('ACME-2');
  });
  it('reverses nothing when the story committed nothing, and replaces the record', () => {
    unshipped();
    const w = world({ other: { 'refs/heads/story/acme-1': fail() } });
    expect(w.adapter.prepare(1, wt)).toBe('up');
    expect(w.ran('git worktree add')).toBe(false);
    expect(w.ran('project deploy start')).toBe(false);
    expect(readRecord().story).toBe('ACME-2');
  });
  it('writes no record when the slot has no story', () => {
    const w = world({ story: null });
    expect(w.adapter.prepare(1, wt)).toBe('up');
    expect(fs.existsSync(recordFile())).toBe(false);
  });
  it('cleans nothing and keeps the record when the slot has no story', () => {
    writeRecord({ story: 'ACME-1', branch: 'story/acme-1', at: 'then' });
    const w = world({ story: null });
    expect(w.adapter.prepare(1, wt)).toBe('up');
    for (const text of ['gh pr list', 'git worktree add', 'sgd source delta', 'project deploy start']) expect(w.ran(text)).toBe(false);
    expect(w.ran('reset tracking')).toBe(true);
    expect(readRecord()).toMatchObject({ story: 'ACME-1', at: 'then' });
  });
});

describe('sandbox-pool: git and gh', () => {
  it('never run under the isolated sf home', () => {
    unshipped();
    const w = world();
    w.adapter.prepare(1, wt);
    const others = w.calls.filter((c) => c.cmd === 'git' || c.cmd === 'gh');
    expect(others.length).toBeGreaterThan(0);
    for (const c of others) expect(c.opts.env?.HOME).not.toBe(sfHomeDir);
    for (const c of w.calls.filter((x) => x.cmd === 'sf')) expect(c.opts.env.HOME).toBe(sfHomeDir);
  });
});

describe('sandbox-pool: a build org that also takes stage 1', () => {
  it('is the shared layout', () => {
    expect(layout(sharedConfig().salesforce, sharedConfig()).stages[0].shared).toBe(true);
  });
  it('records the current story before prepare returns', () => {
    const w = world({ config: sharedConfig() });
    expect(fs.existsSync(recordFile())).toBe(false);
    expect(w.adapter.prepare(1, wt)).toBe('up');
    expect(readRecord()).toMatchObject({ alias: 'acme-dev1', story: 'ACME-2', branch: 'story/acme-2' });
  });
  it('leaves a merged story\'s release on the org', () => {
    unshipped();
    const w = world({ config: sharedConfig(), other: { 'gh pr list': ok('[{"number":7}]') } });
    expect(w.adapter.prepare(1, wt)).toBe('up');
    expect(w.ran('project deploy start')).toBe(false);
    expect(readRecord().story).toBe('ACME-2');
  });
  it('cleans an unmerged story', () => {
    unshipped();
    const w = world({ config: sharedConfig() });
    expect(w.adapter.prepare(1, wt)).toBe('reset');
    expect(w.ran('project deploy start')).toBe(true);
    expect(readRecord().story).toBe('ACME-2');
  });
});

describe('manifestTypes', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-manifest-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const write = (types) => {
    const file = path.join(dir, 'destructiveChanges.xml');
    const blocks = Object.entries(types).map(([name, members]) => `  <types>\n${members.map((m) => `    <members>${m}</members>`).join('\n')}\n    <name>${name}</name>\n  </types>`);
    fs.writeFileSync(file, ['<?xml version="1.0" encoding="UTF-8"?>', '<Package xmlns="http://soap.sforce.com/2006/04/metadata">', ...blocks, '  <version>62.0</version>', '</Package>', ''].join('\n'));
    return file;
  };

  it('decodes the five XML entities in members', () => {
    expect(manifestTypes(write({ CustomObject: ['A&amp;B', '&lt;X&gt;', 'Q&quot;&apos;'] }))).toEqual({ CustomObject: ['A&B', '<X>', `Q"'`] });
  });

  it('decodes the name too', () => {
    expect(manifestTypes(write({ 'Acme&amp;Type': ['AcmeOne'] }))).toEqual({ 'Acme&Type': ['AcmeOne'] });
  });

  it('decodes in a single pass, so an escaped entity stays one entity', () => {
    expect(manifestTypes(write({ CustomObject: ['A&amp;lt;B'] }))).toEqual({ CustomObject: ['A&lt;B'] });
  });

  it('leaves plain members alone, still skips *, and reads a missing file as empty', () => {
    expect(manifestTypes(write({ ApexClass: ['AcmeOne', '*', 'Account.Acme__c'] }))).toEqual({ ApexClass: ['AcmeOne', 'Account.Acme__c'] });
    expect(manifestTypes(write({ ApexClass: ['*'] }))).toEqual({});
    expect(manifestTypes(path.join(dir, 'missing.xml'))).toEqual({});
  });
});
