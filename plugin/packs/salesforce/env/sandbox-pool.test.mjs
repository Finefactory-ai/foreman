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

// The `org list metadata` fake: the first time a type and folder are listed it answers `before`
// (what the org holds), later times `after` (what the deploy left).
const HELD = ['AcmeOld', 'AcmeNew', 'AcmeNewTest', 'AcmeHelper', 'AcmeReports/AcmeNewReport', 'AcmeReports/AcmeA', 'AcmeReports/AcmeB', 'AcmeOther/AcmeC', 'Account.Acme__c'];
const orgHolds = (before = HELD, after = ['AcmeOld']) => {
  const listed = new Set();
  return (args) => {
    const key = `${args[args.indexOf('--metadata-type') + 1]}\u0000${args.includes('--folder') ? args[args.indexOf('--folder') + 1] : ''}`;
    const first = !listed.has(key);
    listed.add(key);
    return sfOk((first ? before : after).map((fullName) => ({ fullName })));
  };
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
  'org list metadata': orgHolds(),
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
  if (line.includes('rev-list --count')) return ok('1\n');
  if (line.includes('for-each-ref')) return ok('');
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
    expect(w.index('org list metadata')).toBeLessThan(w.index('project deploy start'));

    expect(w.index('reset tracking')).toBeGreaterThan(w.index('project deploy start'));
    expect(w.lines().findLastIndex((l) => l.includes('org list metadata'))).toBeGreaterThan(w.index('project deploy start'));
    expect(w.index('git worktree remove --force')).toBeGreaterThan(w.lines().findLastIndex((l) => l.includes('org list metadata')));
    expect(w.find('git worktree remove --force').args).toEqual(['worktree', 'remove', '--force', tree]);
    expect(fs.existsSync(path.dirname(out))).toBe(false);

    const stamp = expect.stringMatching(/^\d{4}-\d\d-\d\dT/);
    expect(readRecord()).toEqual({ alias: 'acme-dev1', orgId: ID1, slot: 'w1', story: 'ACME-2', branch: 'story/acme-2', since: stamp, revision: 0, at: stamp });
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
    let calls = 0;
    const w = world({ sf: { 'org list metadata': () => (calls++ === 0 ? sfOk([{ fullName: 'AcmeNew' }, { fullName: 'AcmeNewTest' }]) : sfError('SfError', 'INVALID_SESSION')) } });
    expect(() => w.adapter.prepare(1, wt)).toThrow('could not confirm the clean-up in acme-dev1: INVALID_SESSION');
    expect(w.ran('project deploy start')).toBe(true);
  });
  it('confirms each type with one list call', () => {
    unshipped();
    const w = world();
    expect(w.adapter.prepare(1, wt)).toBe('reset');
    const lists = w.calls.filter((c) => [c.cmd, ...c.args].join(' ').includes('org list metadata'));
    expect(lists).toHaveLength(2);
    for (const list of lists) expect(list.args).toEqual(['org', 'list', 'metadata', '--metadata-type', 'ApexClass', '--target-org', 'acme-dev1', '--json']);
  });
  it('lists each type and folder once', () => {
    unshipped();
    const destructive = { ApexClass: ['AcmeNew', 'AcmeNewTest'], Report: ['AcmeReports/AcmeA', 'AcmeReports/AcmeB', 'AcmeOther/AcmeC'] };
    const w = world({ sf: { 'sgd source delta': sgdRoute({ package: {}, destructive }) } });
    expect(w.adapter.prepare(1, wt)).toBe('reset');
    const lists = w.calls.filter((c) => [c.cmd, ...c.args].join(' ').includes('org list metadata')).map((c) => c.args);
    const once = [
      ['org', 'list', 'metadata', '--metadata-type', 'ApexClass', '--target-org', 'acme-dev1', '--json'],
      ['org', 'list', 'metadata', '--metadata-type', 'Report', '--target-org', 'acme-dev1', '--folder', 'AcmeReports', '--json'],
      ['org', 'list', 'metadata', '--metadata-type', 'Report', '--target-org', 'acme-dev1', '--folder', 'AcmeOther', '--json'],
    ];
    expect(lists).toEqual([...once, ...once]);
  });
  it('names a later member of a group that is still on the org', () => {
    unshipped();
    const w = world({ sf: { 'org list metadata': sfOk([{ fullName: 'AcmeNewTest' }]) } });
    expect(() => w.adapter.prepare(1, wt)).toThrow('acme-dev1 still holds ApexClass AcmeNewTest after the clean-up');
    expect(w.lines().filter((l) => l.includes('org list metadata'))).toHaveLength(2);
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

const LEFTSHA = 'c'.repeat(40);
const LEFT = 'leftover/w1-acme-1-20261022';
const REFUSAL = 'cannot tell what ACME-1 left in acme-dev1: no commits on story/acme-1, no leftover branch, no tracking mark. Clean acme-dev1 by hand, then delete salesforce/orgs/00D000000000001.json in the state folder';
const leftoverLine = (name, date = '2026-10-22T11:00:00+00:00') => `${name}\t${date}`;

// A story that committed nothing and left a branch of its work behind.
const leftoverGit = (over = {}) => ({
  'rev-list --count': ok('0\n'),
  'for-each-ref': ok(`${leftoverLine(LEFT)}\n`),
  [`refs/heads/${LEFT}^{commit}`]: ok(`${LEFTSHA}\n`),
  ...over,
});
const sgdFrom = (sha, delta) => (args) => sgdRoute(args[args.indexOf('--from') + 1] === sha ? delta : { package: {}, destructive: {} })(args);
const REMOVES_HELPER = { package: {}, destructive: { ApexClass: ['AcmeHelper'] } };
const NO_COMMITS = { 'rev-list --count': ok('0\n') };
const member = (MemberType, MemberName, IsNameObsolete = false) => ({ attributes: { type: 'SourceMember' }, MemberType, MemberName, IsNameObsolete });

describe('sandbox-pool prepare: a story that failed before its commit', () => {
  it('cleans the leftover branch when the story branch has no commits', () => {
    unshipped();
    const w = world({ other: leftoverGit(), sf: { 'sgd source delta': sgdFrom(LEFTSHA, REMOVES_HELPER) } });
    expect(w.adapter.prepare(1, wt)).toBe('reset');
    expect(w.find('sgd source delta').args.slice(3, 7)).toEqual(['--from', LEFTSHA, '--to', BASESHA]);
    expect(w.find('project deploy start').args).toContain('--post-destructive-changes');
    expect(w.lines().findLastIndex((l) => l.includes('org list metadata --metadata-type ApexClass'))).toBeGreaterThan(w.index('project deploy start'));
    expect(readRecord().story).toBe('ACME-2');
  });
  it('lists the leftover branches of the slot, newest first, in the project root', () => {
    unshipped();
    const w = world({ other: leftoverGit(), sf: { 'sgd source delta': sgdFrom(LEFTSHA, REMOVES_HELPER) } });
    w.adapter.prepare(1, wt);
    const list = w.find('git for-each-ref');
    expect(list.args).toEqual(['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)%09%(committerdate:iso-strict)', 'refs/heads/leftover/']);
    expect(list.opts.cwd).toBe(ROOT);
  });
  it('keeps the record when the leftover removal is still on the org', () => {
    unshipped();
    const w = world({ other: leftoverGit(), sf: { 'sgd source delta': sgdFrom(LEFTSHA, REMOVES_HELPER), 'org list metadata': sfOk([{ fullName: 'AcmeHelper' }]) } });
    expect(() => w.adapter.prepare(1, wt)).toThrow('acme-dev1 still holds ApexClass AcmeHelper after the clean-up');
    expect(readRecord().story).toBe('ACME-1');
  });
  it('takes the newest matching leftover and ignores other stories, other slots and older runs', () => {
    unshipped();
    const NEWER = 'leftover/w1-acme-1-20261023-2';
    const NEWERSHA = 'd'.repeat(40);
    const lines = [
      leftoverLine('leftover/w1-acme-10-20261024', '2026-10-24T11:00:00+00:00'),
      leftoverLine('leftover/w2-acme-1-20261024', '2026-10-24T10:00:00+00:00'),
      leftoverLine(NEWER, '2026-10-23T11:00:00+00:00'),
      leftoverLine(LEFT),
      leftoverLine('leftover/w1-acme-1-20261001', '2026-10-01T11:00:00+00:00'),
    ].join('\n');
    const w = world({ other: leftoverGit({ 'for-each-ref': ok(`${lines}\n`), [`refs/heads/${NEWER}^{commit}`]: ok(`${NEWERSHA}\n`) }), sf: { 'sgd source delta': sgdFrom(NEWERSHA, REMOVES_HELPER) } });
    expect(w.adapter.prepare(1, wt)).toBe('reset');
    expect(w.find('sgd source delta').args.slice(3, 5)).toEqual(['--from', NEWERSHA]);
  });
  it('refuses when only leftovers of other stories, other slots or older runs exist', () => {
    unshipped();
    const lines = [
      leftoverLine('leftover/w1-acme-10-20261024', '2026-10-24T11:00:00+00:00'),
      leftoverLine('leftover/w2-acme-1-20261024', '2026-10-24T10:00:00+00:00'),
      leftoverLine('leftover/w1-acme-1-20261001', '2026-10-01T11:00:00+00:00'),
    ].join('\n');
    const w = world({ other: { ...NO_COMMITS, 'for-each-ref': ok(`${lines}\n`) } });
    expect(() => w.adapter.prepare(1, wt)).toThrow(REFUSAL);
  });
  it('ignores a leftover dated before the story took the org, even when its branch resolves', () => {
    const OLD = 'leftover/w1-acme-1-20261001';
    const OLDSHA = 'e'.repeat(40);
    const git = { 'rev-list --count': ok('0\n'), 'for-each-ref': ok(`${leftoverLine(OLD, '2026-10-01T11:00:00+00:00')}\n`), [`refs/heads/${OLD}^{commit}`]: ok(`${OLDSHA}\n`) };
    const sf = { 'sgd source delta': sgdFrom(OLDSHA, REMOVES_HELPER) };
    const fromOld = (w) => w.calls.some((c) => c.args.includes('--from') && c.args[c.args.indexOf('--from') + 1] === OLDSHA);

    unshipped();
    const refused = world({ other: git, sf });
    expect(() => refused.adapter.prepare(1, wt)).toThrow(REFUSAL);
    expect(fromOld(refused)).toBe(false);
    expect(refused.ran('sgd source delta')).toBe(false);

    writeRecord({ story: 'ACME-1', branch: 'story/acme-1', revision: 40 });
    const tracked = world({ other: git, sf });
    expect(tracked.adapter.prepare(1, wt)).toBe('up');
    expect(tracked.ran('WHERE RevisionCounter > 40')).toBe(true);
    expect(fromOld(tracked)).toBe(false);
    expect(tracked.ran('sgd source delta')).toBe(false);
  });
  it('uses the slot the record names', () => {
    writeRecord({ story: 'ACME-1', branch: 'story/acme-1', slot: 'w2' });
    const w = world({ other: leftoverGit({ 'for-each-ref': ok(`${leftoverLine('leftover/w2-acme-1-20261022')}\n`), 'refs/heads/leftover/w2-acme-1-20261022^{commit}': ok(`${LEFTSHA}\n`) }), sf: { 'sgd source delta': sgdFrom(LEFTSHA, REMOVES_HELPER) } });
    expect(w.adapter.prepare(1, wt)).toBe('reset');
  });
  it('refuses with no commits, no leftover branch and no tracking mark, and changes nothing', () => {
    for (const other of [{ 'refs/heads/story/acme-1': fail() }, NO_COMMITS]) {
      unshipped();
      const w = world({ other });
      expect(() => w.adapter.prepare(1, wt)).toThrow(REFUSAL);
      for (const text of ['git worktree add', 'sgd source delta', 'project deploy start', 'reset tracking']) expect(w.ran(text)).toBe(false);
      expect(readRecord().story).toBe('ACME-1');
    }
  });
  it('builds the delta from the story branch head when it has commits, even with a leftover branch', () => {
    unshipped();
    const w = world({ other: leftoverGit({ 'rev-list --count': ok('2\n') }) });
    expect(w.adapter.prepare(1, wt)).toBe('reset');
    expect(w.find('rev-list --count').args).toEqual(['rev-list', '--count', `${BASESHA}..${HEADSHA}`]);
    expect(w.find('sgd source delta').args.slice(3, 5)).toEqual(['--from', HEADSHA]);
  });
  it('still uses the story branch when the commits cannot be counted', () => {
    unshipped();
    for (const count of [fail(), ok('many\n')]) {
      const w = world({ other: leftoverGit({ 'rev-list --count': count }) });
      expect(w.adapter.prepare(1, wt)).toBe('reset');
      expect(w.find('sgd source delta').args.slice(3, 5)).toEqual(['--from', HEADSHA]);
      unshipped();
    }
  });
});

describe('sandbox-pool prepare: the tracking fallback', () => {
  const SINCE = 'WHERE RevisionCounter > 40';
  const addTree = (args) => {
    fs.mkdirSync(args[3], { recursive: true });
    fs.writeFileSync(path.join(args[3], 'sfdx-project.json'), JSON.stringify({ packageDirectories: [{ path: 'force-app' }] }));
    return ok();
  };
  const rows = sfOk({
    records: [member('ApexClass', 'AcmeHelper'), member('ApexClass', 'AcmeOld'), member('Profile', 'Admin'), member('ApexClass', 'AcmeGone', true), member('ApexClass', 'AcmeHelper')],
    totalSize: 5,
    done: true,
  });
  const generate = (args) => {
    const dir = args[args.indexOf('--output-dir') + 1];
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.xml'), manifest({ ApexClass: ['AcmeOld'] }));
    return sfOk({ packagePath: path.join(dir, 'package.xml') });
  };
  const tracked = (sf = {}, other = {}) => {
    writeRecord({ story: 'ACME-1', branch: 'story/acme-1', revision: 40 });
    return world({ other: { ...NO_COMMITS, 'git worktree add': addTree, ...other }, sf: { [SINCE]: rows, 'project generate manifest': generate, ...sf } });
  };

  it('restores what is in the base, removes what is not, and leaves the rest', () => {
    let seen;
    const deploy = (args) => {
      seen = {
        package: manifestTypes(args[args.indexOf('--manifest') + 1]),
        destructive: manifestTypes(args[args.indexOf('--post-destructive-changes') + 1]),
        xml: fs.readFileSync(args[args.indexOf('--manifest') + 1], 'utf8'),
      };
      return sfOk({ status: 'Succeeded', success: true, done: true });
    };
    const w = tracked({ 'project deploy start': deploy });
    expect(w.adapter.prepare(1, wt)).toBe('reset');
    expect(seen.package).toEqual({ ApexClass: ['AcmeOld'] });
    expect(seen.destructive).toEqual({ ApexClass: ['AcmeHelper'] });
    expect(seen.xml).toContain('<version>62.0</version>');

    const tree = w.find('git worktree add --detach').args[3];
    const gen = w.find('project generate manifest');
    expect(gen.args.slice(0, 7)).toEqual(['project', 'generate', 'manifest', '--source-dir', 'force-app', '--type', 'package']);
    expect(gen.args[7]).toBe('--output-dir');
    expect(gen.opts.cwd).toBe(tree);
    expect(w.find('org list metadata').args).toContain('ApexClass');
    expect(w.ran('git worktree remove --force')).toBe(true);
    expect(fs.existsSync(path.dirname(tree))).toBe(false);
    expect(readRecord().story).toBe('ACME-2');
  });
  it('returns up with no worktree and no deploy when nothing changed since the mark', () => {
    const w = tracked({ [SINCE]: sfOk({ records: [], totalSize: 0, done: true }) });
    expect(w.adapter.prepare(1, wt)).toBe('up');
    expect(w.ran('git worktree add')).toBe(false);
    expect(w.ran('project deploy start')).toBe(false);
    expect(readRecord().story).toBe('ACME-2');
  });
  it('removes nothing that is not on the allow-list', () => {
    let seen;
    const w = tracked({
      [SINCE]: sfOk({ records: [member('Flow', 'AcmeFlow'), member('Settings', 'Account'), member('CustomField', 'Account.Acme__c')], totalSize: 3, done: true }),
      'project deploy start': (args) => {
        seen = manifestTypes(args[args.indexOf('--post-destructive-changes') + 1]);
        return sfOk({ success: true });
      },
      'org list metadata': orgHolds(['Account.Acme__c'], []),
    });
    expect(w.adapter.prepare(1, wt)).toBe('reset');
    expect(seen).toEqual({ CustomField: ['Account.Acme__c'] });
  });
  it('deploys nothing when every changed member is one it never removes', () => {
    const w = tracked({ [SINCE]: sfOk({ records: [member('Profile', 'Admin'), member('ApexClass', 'AcmeGone', true)], totalSize: 2, done: true }) });
    expect(w.adapter.prepare(1, wt)).toBe('up');
    expect(w.ran('project deploy start')).toBe(false);
    expect(w.ran('git worktree remove --force')).toBe(true);
  });
  it('throws when the changes since the mark cannot be read, and keeps the record', () => {
    const w = tracked({ [SINCE]: sfError('SfError', 'socket hang up') });
    expect(() => w.adapter.prepare(1, wt)).toThrow('could not read source tracking in acme-dev1: socket hang up');
    expect(readRecord().story).toBe('ACME-1');
    expect(w.ran('git worktree add')).toBe(false);
  });
  it('throws when the package folders cannot be read, and keeps the record', () => {
    const w = tracked({}, { 'git worktree add': ok() });
    expect(() => w.adapter.prepare(1, wt)).toThrow('could not read the package folders of origin/main for the clean-up of acme-dev1');
    expect(readRecord().story).toBe('ACME-1');
    expect(w.ran('git worktree remove --force')).toBe(true);
  });
  it('throws when the base components cannot be listed, and keeps the record', () => {
    const w = tracked({ 'project generate manifest': sfError('SfError', 'no source') });
    expect(() => w.adapter.prepare(1, wt)).toThrow('could not list the components of origin/main for the clean-up of acme-dev1: no source');
    expect(readRecord().story).toBe('ACME-1');
    expect(w.ran('project deploy start')).toBe(false);
  });
});

describe('sandbox-pool prepare: deleting only what the org holds', () => {
  const HELPERS = { package: {}, destructive: { ApexClass: ['AcmeHelper', 'AcmeHelperTest'] } };
  const leftover = (sf = {}, other = {}) => {
    unshipped();
    return world({ other: leftoverGit(other), sf: { 'sgd source delta': sgdFrom(LEFTSHA, HELPERS), ...sf } });
  };
  // A deploy that records the manifests it was given.
  const capture = (seen) => (args) => {
    const at = args.indexOf('--post-destructive-changes');
    seen.args = args;
    seen.package = manifestTypes(args[args.indexOf('--manifest') + 1]);
    if (at >= 0) {
      seen.destructive = manifestTypes(args[at + 1]);
      seen.xml = fs.readFileSync(args[at + 1], 'utf8');
    }
    return sfOk({ status: 'Succeeded', success: true, done: true });
  };
  const failure = (n) => ({ componentType: 'ApexClass', fullName: `AcmeHelper${n}`, problem: `No ApexClass named: AcmeHelper${n} found`, problemType: 'Error' });
  const failedDeploy = (componentFailures) => ({
    status: 1,
    stdout: JSON.stringify({
      status: 1,
      name: 'DeployFailed',
      message: 'Deploy failed.',
      result: { status: 'Failed', id: '0Af000000000001AAA', createdByName: 'Acme Admin', numberComponentsTotal: 0, details: { componentFailures } },
    }),
    stderr: '',
  });

  it('deploys nothing when the org holds none of what the leftover branch added', () => {
    const w = leftover({ 'org list metadata': sfOk([{ fullName: 'AcmeOld' }]) });
    expect(w.adapter.prepare(1, wt)).toBe('up');
    expect(w.ran('project deploy start')).toBe(false);
    const lists = w.calls.filter((c) => c.args.includes('metadata') && c.args.includes('list'));
    expect(lists).toHaveLength(1);
    expect(lists[0].args).toEqual(['org', 'list', 'metadata', '--metadata-type', 'ApexClass', '--target-org', 'acme-dev1', '--json']);
    expect(w.index('org list metadata')).toBeLessThan(w.index('reset tracking'));
    expect(w.ran('git worktree remove --force')).toBe(true);
    const stamp = expect.stringMatching(/^\d{4}-\d\d-\d\dT/);
    expect(readRecord()).toEqual({ alias: 'acme-dev1', orgId: ID1, slot: 'w1', story: 'ACME-2', branch: 'story/acme-2', since: stamp, revision: 0, at: stamp });
  });
  it('deletes only the member the org holds', () => {
    const seen = {};
    const w = leftover({ 'org list metadata': orgHolds(['AcmeHelper'], []), 'project deploy start': capture(seen) });
    expect(w.adapter.prepare(1, wt)).toBe('reset');
    expect(seen.destructive).toEqual({ ApexClass: ['AcmeHelper'] });
    expect(seen.xml).toContain('<version>62.0</version>');
    expect(seen.args).toContain('--post-destructive-changes');
    expect(readRecord().story).toBe('ACME-2');
  });
  it('confirms only what it deleted', () => {
    const w = leftover({ 'org list metadata': orgHolds(['AcmeHelper'], ['AcmeHelperTest']) });
    expect(w.adapter.prepare(1, wt)).toBe('reset');
    expect(w.lines().filter((l) => l.includes('org list metadata'))).toHaveLength(2);
    expect(w.lines().findLastIndex((l) => l.includes('org list metadata'))).toBeGreaterThan(w.index('project deploy start'));
    expect(readRecord().story).toBe('ACME-2');
  });
  it('still fails when what it deleted is on the org afterwards', () => {
    const w = leftover({ 'org list metadata': orgHolds(['AcmeHelper'], ['AcmeHelper']) });
    expect(() => w.adapter.prepare(1, wt)).toThrow('acme-dev1 still holds ApexClass AcmeHelper after the clean-up');
    expect(readRecord().story).toBe('ACME-1');
  });
  it('keeps the order of the members and drops a type left with none', () => {
    unshipped();
    const destructive = { ApexClass: ['AcmeNew', 'AcmeGone', 'AcmeHelper'], ApexTrigger: ['AcmeGoneTrigger'] };
    const seen = {};
    const w = world({ sf: { 'sgd source delta': sgdRoute({ package: {}, destructive }), 'org list metadata': orgHolds(['AcmeHelper', 'AcmeNew'], []), 'project deploy start': capture(seen) } });
    expect(w.adapter.prepare(1, wt)).toBe('reset');
    expect(seen.destructive).toEqual({ ApexClass: ['AcmeNew', 'AcmeHelper'] });
  });
  it('still deploys what it restores, with nothing to delete', () => {
    const seen = {};
    const w = leftover({
      'sgd source delta': sgdFrom(LEFTSHA, { package: { ApexClass: ['AcmeOld'] }, destructive: { ApexClass: ['AcmeHelper'] } }),
      'org list metadata': sfOk([{ fullName: 'AcmeOld' }]),
      'project deploy start': capture(seen),
    });
    expect(w.adapter.prepare(1, wt)).toBe('reset');
    expect(seen.args).not.toContain('--post-destructive-changes');
    expect(seen.args).toContain('--manifest');
    expect(seen.package).toEqual({ ApexClass: ['AcmeOld'] });
    expect(w.lines().filter((l) => l.includes('org list metadata'))).toHaveLength(1);
    expect(w.index('org list metadata')).toBeLessThan(w.index('project deploy start'));
  });
  it('throws when the org cannot be listed before the deploy, and changes nothing', () => {
    const w = leftover({ 'org list metadata': sfError('SfError', 'INVALID_SESSION') });
    expect(() => w.adapter.prepare(1, wt)).toThrow('could not list what acme-dev1 holds before the clean-up: INVALID_SESSION');
    expect(w.ran('project deploy start')).toBe(false);
    expect(w.ran('reset tracking')).toBe(false);
    expect(readRecord().story).toBe('ACME-1');
    expect(w.ran('git worktree remove --force')).toBe(true);
  });
  it('lists each type and folder before the deploy, not only after', () => {
    unshipped();
    const destructive = { ApexClass: ['AcmeNew'], Report: ['AcmeReports/AcmeA', 'AcmeReports/AcmeB', 'AcmeOther/AcmeC'] };
    const w = world({ sf: { 'sgd source delta': sgdRoute({ package: {}, destructive }) } });
    expect(w.adapter.prepare(1, wt)).toBe('reset');
    const at = w.index('project deploy start');
    const folders = (lines) => lines.map((l) => (l.includes('--folder') ? l.split('--folder ')[1].split(' ')[0] : '-'));
    const lines = w.lines().filter((l) => l.includes('org list metadata'));
    expect(lines).toHaveLength(6);
    expect(w.lines().slice(0, at).filter((l) => l.includes('org list metadata'))).toHaveLength(3);
    expect(folders(lines.slice(0, 3))).toEqual(['-', 'AcmeReports', 'AcmeOther']);
  });

  describe('folders of folder-based types', () => {
    const listArgs = (type, folder) => ['org', 'list', 'metadata', '--metadata-type', type, '--target-org', 'acme-dev1', ...(folder ? ['--folder', folder] : []), '--json'];
    const listCalls = (w) => w.calls.filter((c) => c.args.includes('metadata') && c.args.includes('list')).map((c) => c.args);

    it('deletes a folder the story added, listed under its folder type', () => {
      unshipped();
      const seen = {};
      const destructive = { Report: ['AcmeReports', 'AcmeReports/AcmeA'] };
      const w = world({ sf: { 'sgd source delta': sgdRoute({ package: {}, destructive }), 'org list metadata': orgHolds(['AcmeReports', 'AcmeReports/AcmeA'], []), 'project deploy start': capture(seen) } });
      expect(w.adapter.prepare(1, wt)).toBe('reset');
      expect(seen.destructive).toEqual({ Report: ['AcmeReports', 'AcmeReports/AcmeA'] });
      const pair = [listArgs('ReportFolder'), listArgs('Report', 'AcmeReports')];
      expect(listCalls(w)).toEqual([...pair, ...pair]);
      const at = w.index('project deploy start');
      const before = w.lines().slice(0, at).filter((l) => l.includes('org list metadata'));
      expect(before).toHaveLength(2);
      expect(readRecord().story).toBe('ACME-2');
    });
    it.each([
      ['Dashboard', 'DashboardFolder'],
      ['Document', 'DocumentFolder'],
      ['EmailTemplate', 'EmailFolder'],
      ['Report', 'ReportFolder'],
    ])('lists a new folder of %s under %s', (type, folderType) => {
      unshipped();
      const seen = {};
      const w = world({ sf: { 'sgd source delta': sgdRoute({ package: {}, destructive: { [type]: ['AcmeFolder'] } }), 'org list metadata': orgHolds(['AcmeFolder'], []), 'project deploy start': capture(seen) } });
      expect(w.adapter.prepare(1, wt)).toBe('reset');
      expect(listCalls(w)[0]).toEqual(listArgs(folderType));
      expect(seen.destructive).toEqual({ [type]: ['AcmeFolder'] });
    });
    it('keeps a folder it deleted from looking confirmed when the org still lists it', () => {
      unshipped();
      const w = world({ sf: { 'sgd source delta': sgdRoute({ package: {}, destructive: { Report: ['AcmeReports'] } }), 'org list metadata': orgHolds(['AcmeReports'], ['AcmeReports']) } });
      expect(() => w.adapter.prepare(1, wt)).toThrow('acme-dev1 still holds Report AcmeReports after the clean-up');
      expect(readRecord().story).toBe('ACME-1');
    });
    it('leaves a folder out when the org does not hold it', () => {
      unshipped();
      const seen = {};
      const destructive = { Report: ['AcmeReports', 'AcmeReports/AcmeA'] };
      const w = world({ sf: { 'sgd source delta': sgdRoute({ package: {}, destructive }), 'org list metadata': orgHolds(['AcmeReports/AcmeA'], []), 'project deploy start': capture(seen) } });
      expect(w.adapter.prepare(1, wt)).toBe('reset');
      expect(seen.destructive).toEqual({ Report: ['AcmeReports/AcmeA'] });
    });
  });

  describe('the API version of the delete list', () => {
    // sgdRoute's answer, with the <version> line left out of the manifests named in `which`.
    const stripVersion = (delta, which) => (args) => {
      const answer = sgdRoute(delta)(args);
      const out = args[args.indexOf('--output-dir') + 1];
      for (const file of which) {
        const p = path.join(out, ...file);
        fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/^.*<version>.*<\/version>\n/m, ''));
      }
      return answer;
    };
    const PACKAGE = ['package', 'package.xml'];
    const DESTRUCTIVE = ['destructiveChanges', 'destructiveChanges.xml'];
    const sgdNoVersion = (delta) => stripVersion(delta, [PACKAGE, DESTRUCTIVE]);

    it('refuses to rewrite the delete list when neither manifest has an API version', () => {
      unshipped();
      const w = world({ sf: { 'sgd source delta': sgdNoVersion(REMOVES_ACME_NEW), 'org list metadata': orgHolds(['AcmeNew'], []) } });
      expect(() => w.adapter.prepare(1, wt)).toThrow(new Error('could not read the API version of the clean-up delta for acme-dev1'));
      expect(w.ran('project deploy start')).toBe(false);
      expect(w.ran('reset tracking')).toBe(false);
      expect(readRecord().story).toBe('ACME-1');
      expect(w.ran('git worktree remove --force')).toBe(true);
    });
    it('takes the API version from package.xml when the delete list has none', () => {
      unshipped();
      const seen = {};
      const w = world({ sf: { 'sgd source delta': stripVersion(REMOVES_ACME_NEW, [DESTRUCTIVE]), 'org list metadata': orgHolds(['AcmeNew'], []), 'project deploy start': capture(seen) } });
      expect(w.adapter.prepare(1, wt)).toBe('reset');
      expect(seen.xml).toContain('<version>62.0</version>');
      expect(seen.destructive).toEqual({ ApexClass: ['AcmeNew'] });
    });
  });

  describe('the tracking fallback', () => {
    const addTree = (args) => {
      fs.mkdirSync(args[3], { recursive: true });
      fs.writeFileSync(path.join(args[3], 'sfdx-project.json'), JSON.stringify({ packageDirectories: [{ path: 'force-app' }] }));
      return ok();
    };
    const generate = (args) => {
      const dir = args[args.indexOf('--output-dir') + 1];
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.xml'), manifest({ ApexClass: ['AcmeOld'] }));
      return sfOk({ packagePath: path.join(dir, 'package.xml') });
    };
    const tracked = (records, sf = {}) => {
      writeRecord({ story: 'ACME-1', branch: 'story/acme-1', revision: 40 });
      return world({
        other: { ...NO_COMMITS, 'git worktree add': addTree },
        sf: { 'WHERE RevisionCounter > 40': sfOk({ records, totalSize: records.length, done: true }), 'project generate manifest': generate, ...sf },
      });
    };

    it('deploys nothing when the org holds none of what tracking names', () => {
      const w = tracked([member('ApexClass', 'AcmeHelper')], { 'org list metadata': sfOk([]) });
      expect(w.adapter.prepare(1, wt)).toBe('up');
      expect(w.ran('project deploy start')).toBe(false);
      expect(w.ran('git worktree remove --force')).toBe(true);
      expect(readRecord().story).toBe('ACME-2');
    });
    it('deletes only the member the org holds', () => {
      const seen = {};
      const w = tracked([member('ApexClass', 'AcmeHelper'), member('ApexClass', 'AcmeGone')], { 'org list metadata': orgHolds(['AcmeHelper'], []), 'project deploy start': capture(seen) });
      expect(w.adapter.prepare(1, wt)).toBe('reset');
      expect(seen.destructive).toEqual({ ApexClass: ['AcmeHelper'] });
      expect(seen.xml).toContain('<version>62.0</version>');
    });
  });

  describe('a failed deploy', () => {
    it('names the component and the problem, and no id or user', () => {
      const w = leftover({ 'org list metadata': orgHolds(['AcmeHelper'], []), 'project deploy start': failedDeploy([failure('')]) });
      let message = '';
      try {
        w.adapter.prepare(1, wt);
      } catch (e) {
        message = e.message;
      }
      expect(message).toBe('the clean-up deploy to acme-dev1 failed: Deploy failed.; ApexClass AcmeHelper: No ApexClass named: AcmeHelper found');
      expect(message).not.toContain('Acme Admin');
      expect(message).not.toContain('0Af000000000001');
      expect(readRecord().story).toBe('ACME-1');
      expect(w.ran('reset tracking')).toBe(false);
      expect(w.ran('git worktree remove --force')).toBe(true);
    });
    it('names five and counts the rest', () => {
      const w = leftover({ 'org list metadata': orgHolds(['AcmeHelper'], []), 'project deploy start': failedDeploy([1, 2, 3, 4, 5, 6, 7].map(failure)) });
      let message = '';
      try {
        w.adapter.prepare(1, wt);
      } catch (e) {
        message = e.message;
      }
      expect(message).toBe(
        `the clean-up deploy to acme-dev1 failed: Deploy failed.; ${[1, 2, 3, 4, 5].map((n) => `ApexClass AcmeHelper${n}: No ApexClass named: AcmeHelper${n} found`).join('; ')}; and 2 more`,
      );
    });
    it("counts every failure past the fifth, beyond the summary's twenty", () => {
      const w = leftover({ 'org list metadata': orgHolds(['AcmeHelper'], []), 'project deploy start': failedDeploy(Array.from({ length: 30 }, (_, i) => failure(i + 1))) });
      let message = '';
      try {
        w.adapter.prepare(1, wt);
      } catch (e) {
        message = e.message;
      }
      expect(message).toBe(
        `the clean-up deploy to acme-dev1 failed: Deploy failed.; ${[1, 2, 3, 4, 5].map((n) => `ApexClass AcmeHelper${n}: No ApexClass named: AcmeHelper${n} found`).join('; ')}; and 25 more`,
      );
    });
  });
});

describe('sandbox-pool prepare: the org record', () => {
  const REV = 'ORDER BY RevisionCounter DESC';
  it('stores the revision the org is at after the reset', () => {
    const w = world({ sf: { [REV]: sfOk({ records: [{ RevisionCounter: 57 }], totalSize: 1, done: true }) } });
    w.adapter.prepare(1, wt);
    expect(readRecord().revision).toBe(57);
    const q = w.find('ORDER BY RevisionCounter');
    expect(q.args).toEqual(['data', 'query', '--use-tooling-api', '--query', 'SELECT RevisionCounter FROM SourceMember ORDER BY RevisionCounter DESC LIMIT 1', '--target-org', 'acme-dev1', '--json']);
    expect(w.index('ORDER BY RevisionCounter')).toBeGreaterThan(w.index('reset tracking'));
  });
  it('leaves the revision out when the answer is malformed', () => {
    for (const answer of [{ records: [{ RevisionCounter: 'x' }] }, { records: [{ RevisionCounter: -1 }] }, { records: [{}] }, { nope: 1 }]) {
      const w = world({ sf: { [REV]: sfOk(answer) } });
      w.adapter.prepare(1, wt);
      expect(readRecord()).not.toHaveProperty('revision');
    }
  });
  it('throws when the revision cannot be read, and keeps the old record', () => {
    unshipped();
    const w = world({ sf: { [REV]: sfError('SfError', 'socket hang up') } });
    expect(() => w.adapter.prepare(1, wt)).toThrow('could not read the source tracking revision in acme-dev1: socket hang up');
    expect(readRecord().story).toBe('ACME-1');
  });
  it('keeps since and revision when the story resumes, and does not ask again', () => {
    writeRecord({ story: 'ACME-2', branch: 'story/acme-2', since: 'S', revision: 7 });
    const w = world();
    expect(w.adapter.prepare(1, wt)).toBe('up');
    expect(w.ran('ORDER BY RevisionCounter')).toBe(false);
    expect(readRecord()).toMatchObject({ since: 'S', revision: 7, slot: 'w1' });
  });
  it('keeps since on a resume with no usable revision, and asks for the revision', () => {
    writeRecord({ story: 'ACME-2', branch: 'story/acme-2', revision: -3, at: '2026-10-22T10:00:00.000Z' });
    const w = world();
    w.adapter.prepare(1, wt);
    expect(w.ran('ORDER BY RevisionCounter')).toBe(true);
    expect(readRecord()).toMatchObject({ since: '2026-10-22T10:00:00.000Z', revision: 0 });
  });
  it('makes no revision query for a slot with no story', () => {
    const w = world({ story: null });
    w.adapter.prepare(1, wt);
    expect(w.ran('ORDER BY RevisionCounter')).toBe(false);
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
