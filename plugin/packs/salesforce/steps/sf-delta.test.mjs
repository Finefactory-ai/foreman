import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sfDelta, { SGD_LINE, buildDelta, sgdProblem } from './sf-delta.mjs';
import { isolatedSh } from '../isolation.mjs';
import { fakeSh } from '../../../../test/ship-fakes.mjs';
import { answerDeletes, askDeletes, deletesFile, readDeletes } from '../deletes.mjs';
import { manifestTypes } from '../env/sandbox-pool.mjs';
import { runShip } from '../../../lib/engine/ship.mjs';
import { fakeCtx } from '../../../../test/ship-fakes.mjs';
import { ACME_DEV1_ID, acmePlugins, sfError, sfOk, sfRaw } from '../../../../test/fake-sf.mjs';
import { ACME_SPEC, specText } from '../../../../test/fake-agent-eval.mjs';

const ASKED = new Date('2026-10-23T10:00:00.000Z');

// package.xml or destructiveChanges.xml holding `types` ({ ApexClass: ['Old'] }), as sgd writes it.
const manifest = (types = {}) =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
    ...Object.entries(types).map(([name, members]) => `  <types>\n${members.map((m) => `    <members>${m}</members>`).join('\n')}\n    <name>${name}</name>\n  </types>`),
    '  <version>62.0</version>',
    '</Package>',
    '',
  ].join('\n');

// The `sf sgd source delta` fake: writes the two manifests into the --output-dir on the line.
const sgd = (delta) => (line) => {
  const out = line.split(' ')[line.split(' ').indexOf('--output-dir') + 1];
  fs.mkdirSync(path.join(out, 'package'), { recursive: true });
  fs.mkdirSync(path.join(out, 'destructiveChanges'), { recursive: true });
  fs.writeFileSync(path.join(out, 'package', 'package.xml'), manifest(delta.package ?? { ApexClass: ['AcmeNew'] }));
  fs.writeFileSync(path.join(out, 'destructiveChanges', 'destructiveChanges.xml'), manifest(delta.destructive ?? {}));
  return sfOk({ error: null, 'output-dir': out, success: true });
};

const PINNED = sfRaw(acmePlugins({ 'sfdx-git-delta': '6.45.1' }));
const rulesFor = ({ destructive = {}, plugins = PINNED, delta = null, over = [] } = {}) => [
  ...over,
  [/^sf plugins --core/, plugins],
  ['git merge-base HEAD origin/main', 'aaa\n'],
  ['git rev-parse HEAD', 'bbb\n'],
  [/^sf sgd source delta /, delta ?? sgd({ destructive })],
];

let sfHome;
let state;
beforeEach(() => {
  sfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-delta-sfhome-'));
  state = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-delta-state-'));
});
afterEach(() => {
  for (const d of [sfHome, state]) fs.rmSync(d, { recursive: true, force: true });
});

const block = (over = {}) => ({ orgs: { 'acme-dev1': { orgId: ACME_DEV1_ID } }, build: 'acme-dev1', stages: [{ name: 'dev', org: 'acme-dev1' }], ...over });
const ctxFor = ({ salesforce = block(), ...rules } = {}) =>
  fakeCtx({ config: { pack: 'salesforce', salesforce, slots: 1 }, rules: rulesFor(rules), root: '/acme/repo', env: { FOREMAN_SF_HOME: sfHome, FOREMAN_STATE_DIR: state } });

const deltaDir = () => path.join(state, 'salesforce', 'delta', 'S-1');
const destructiveXml = () => path.join(deltaDir(), 'destructiveChanges', 'destructiveChanges.xml');
const postXml = () => path.join(deltaDir(), 'postDestructiveChanges.xml');
const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sgdLine = (ctx) => ctx.sh.calls.find((l) => l.startsWith('sf sgd '));

const OLD = { ApexClass: ['Old'] };

describe('sf-delta', () => {
  it('is the step that works out the delta, needs sf and git, and never halts', () => {
    expect(sfDelta).toMatchObject({ name: 'sf-delta', label: 'working out the Salesforce delta', needs: ['sf', 'git'] });
    expect(sfDelta.halts).toBeUndefined();
    expect(SGD_LINE).toBe('6.45');
  });

  it('runs sgd from the merge base to HEAD into the state folder, never with --merge-base', async () => {
    const ctx = ctxFor();
    await sfDelta.run(ctx);
    const line = sgdLine(ctx);
    expect(line).toBe(`sf sgd source delta --from aaa --to bbb --output-dir ${deltaDir()} --generate-delta --json`);
    expect(line).not.toContain('--merge-base');
    const i = ctx.sh.calls.indexOf(line);
    expect(ctx.sh.opts[i].env.HOME).toBe(sfHome);
    expect(ctx.sh.opts[i].env.SF_USE_GENERIC_UNIX_KEYCHAIN).toBe('true');
    expect(ctx.sh.limits[i]).toBe(600000);
    const plugins = ctx.sh.calls.findIndex((l) => l.startsWith('sf plugins --core'));
    expect(ctx.sh.opts[plugins].env.HOME).toBe(sfHome);
  });

  it('passes a delta that deletes nothing, with the manifests and an empty post-destructive file', async () => {
    const ctx = ctxFor();
    const r = await sfDelta.run(ctx);
    expect(r.ok).toBe(true);
    expect(r.sfDelta).toEqual({
      dir: deltaDir(),
      from: 'aaa',
      to: 'bbb',
      manifest: path.join(deltaDir(), 'package', 'package.xml'),
      postDestructive: postXml(),
      deletes: [],
      sha256: sha(destructiveXml()),
    });
    expect(fs.existsSync(r.sfDelta.manifest)).toBe(true);
    const post = fs.readFileSync(postXml(), 'utf8');
    expect(post).toContain('<Package xmlns="http://soap.sforce.com/2006/04/metadata">');
    expect(post).toContain('<version>62.0</version>');
    expect(post).not.toContain('<types>');
    expect(r.manualSteps).toEqual([]);
    expect(r.deletesAllowed).toBeUndefined();
    expect(fs.existsSync(deletesFile(state, 'S-1'))).toBe(false);
  });

  it('asks the owner when the delta deletes something and destructive is ask', async () => {
    const ctx = ctxFor({ destructive: OLD });
    const r = await sfDelta.run(ctx);
    expect(r).toMatchObject({ ok: false, code: 10, stage: 'sf-delta', deletes: [{ type: 'ApexClass', member: 'Old' }], manualSteps: [] });
    expect(r.reason).toBe('The change deletes 1 component(s); the owner must allow the deletes before it ships.');
    expect(r.sha256).toBe(sha(destructiveXml()));
    expect(readDeletes(state, 'S-1')).toMatchObject({ story: 'S-1', sha256: r.sha256, deletes: [{ type: 'ApexClass', member: 'Old' }], answer: null, answeredAt: null });
  });

  it('through runShip, the ask stops with code 10, no HALT, no later step and the lock released', async () => {
    const ctx = ctxFor({ destructive: OLD });
    const later = { name: 'push', ran: 0, run() { this.ran += 1; return { ok: true }; } };
    const { code, result } = await runShip({ steps: [sfDelta, later], ctx });
    expect(code).toBe(10);
    expect(result).toMatchObject({ stage: 'sf-delta', deletes: [{ type: 'ApexClass', member: 'Old' }] });
    expect(later.ran).toBe(0);
    expect(ctx.halts).toEqual([]);
    expect(ctx.locks.held.has('ship')).toBe(false);
  });

  it('passes deletes the owner allowed for the same destructiveChanges.xml', async () => {
    const first = await sfDelta.run(ctxFor({ destructive: OLD }));
    answerDeletes(state, 'S-1', 'allow', ASKED);
    const r = await sfDelta.run(ctxFor({ destructive: OLD }));
    expect(r).toMatchObject({ ok: true, deletesAllowed: true, manualSteps: [] });
    expect(r.sfDelta).toMatchObject({ deletes: [{ type: 'ApexClass', member: 'Old' }], sha256: first.sha256 });
    expect(manifestTypes(postXml())).toEqual({ ApexClass: ['Old'] });
  });

  it('asks again when the allowed deletes were for a different file', async () => {
    askDeletes(state, { story: 'S-1', sha256: 'f'.repeat(64), deletes: [{ type: 'ApexClass', member: 'Older' }] }, ASKED);
    answerDeletes(state, 'S-1', 'allow', ASKED);
    const r = await sfDelta.run(ctxFor({ destructive: OLD }));
    expect(r).toMatchObject({ ok: false, code: 10, stage: 'sf-delta' });
    expect(r.keepOut).toBeUndefined();
    expect(readDeletes(state, 'S-1')).toMatchObject({ sha256: sha(destructiveXml()), deletes: [{ type: 'ApexClass', member: 'Old' }], answer: null, answeredAt: null });
  });

  it('stops with keepOut when the owner asked to keep the deletes out, and leaves the record', async () => {
    askDeletes(state, { story: 'S-1', sha256: 'f'.repeat(64), deletes: [{ type: 'ApexClass', member: 'Old' }] }, ASKED);
    answerDeletes(state, 'S-1', 'keep-out', ASKED);
    const before = fs.readFileSync(deletesFile(state, 'S-1'), 'utf8');
    const r = await sfDelta.run(ctxFor({ destructive: OLD }));
    expect(r).toEqual({
      ok: false,
      code: 10,
      stage: 'sf-delta',
      reason: 'The owner asked to keep deletes out, but the change still deletes 1 component(s).',
      deletes: [{ type: 'ApexClass', member: 'Old' }],
      keepOut: true,
      manualSteps: [],
    });
    expect(fs.readFileSync(deletesFile(state, 'S-1'), 'utf8')).toBe(before);
  });

  it('passes deletes without asking when destructive is allow', async () => {
    const r = await sfDelta.run(ctxFor({ salesforce: block({ destructive: 'allow' }), destructive: OLD }));
    expect(r.ok).toBe(true);
    expect(r.sfDelta.deletes).toEqual([{ type: 'ApexClass', member: 'Old' }]);
    expect(manifestTypes(postXml())).toEqual({ ApexClass: ['Old'] });
    expect(fs.existsSync(deletesFile(state, 'S-1'))).toBe(false);
  });

  it('sorts the deletes by type, then member', async () => {
    const r = await sfDelta.run(ctxFor({ salesforce: block({ destructive: 'allow' }), destructive: { CustomField: ['Account.Z__c', 'Account.A__c'], ApexClass: ['Old', 'Alpha'] } }));
    expect(r.sfDelta.deletes).toEqual([
      { type: 'ApexClass', member: 'Alpha' },
      { type: 'ApexClass', member: 'Old' },
      { type: 'CustomField', member: 'Account.A__c' },
      { type: 'CustomField', member: 'Account.Z__c' },
    ]);
    expect(manifestTypes(postXml())).toEqual({ ApexClass: ['Alpha', 'Old'], CustomField: ['Account.A__c', 'Account.Z__c'] });
  });

  describe('Flow and RecordType deletes', () => {
    const MIXED = { ApexClass: ['Old'], Flow: ['Acme_Intake'], RecordType: ['Account.Acme_Partner', 'Case.Acme_Claim'] };

    it('leaves them out of the post-destructive file and lists each as a manual step', async () => {
      const r = await sfDelta.run(ctxFor({ destructive: MIXED }));
      expect(r).toMatchObject({ ok: false, code: 10, deletes: [{ type: 'ApexClass', member: 'Old' }] });
      expect(r.manualSteps).toEqual([
        'Delete Flow Acme_Intake by hand in each org the story reaches; Foreman never deletes Flows',
        'Delete RecordType Account.Acme_Partner by hand in each org the story reaches; Foreman never deletes RecordTypes',
        'Delete RecordType Case.Acme_Claim by hand in each org the story reaches; Foreman never deletes RecordTypes',
      ]);
      expect(manifestTypes(postXml())).toEqual({ ApexClass: ['Old'] });
      expect(readDeletes(state, 'S-1').deletes).toEqual([{ type: 'ApexClass', member: 'Old' }]);
    });

    it('passes with no approval asked when they are the only deletes', async () => {
      const r = await sfDelta.run(ctxFor({ destructive: { Flow: ['Acme_Intake'], RecordType: ['Account.Acme_Partner'] } }));
      expect(r.ok).toBe(true);
      expect(r.sfDelta.deletes).toEqual([]);
      expect(r.manualSteps).toHaveLength(2);
      expect(fs.readFileSync(postXml(), 'utf8')).not.toContain('<types>');
      expect(fs.existsSync(deletesFile(state, 'S-1'))).toBe(false);
    });
  });

  describe('agent test definitions', () => {
    it('stops with code 2 when the change puts an AiEvaluationDefinition in the package folders', async () => {
      const ctx = ctxFor({ delta: sgd({ package: { ApexClass: ['AcmeNew'], AiEvaluationDefinition: ['Acme_Order_Helper_Tests'] } }) });
      const r = await sfDelta.run(ctx);
      expect(r).toMatchObject({
        ok: false,
        code: 2,
        stage: 'sf-delta',
        failures: [{ kind: 'AiEvaluationDefinition', name: 'Acme_Order_Helper_Tests', message: 'agent test definitions never go in the package folders; delete it' }],
      });
      expect(r.reason).toContain('Acme_Order_Helper_Tests');
      expect(r.reason).toContain('tests/<agent>-eval.json');
      expect(fs.existsSync(deletesFile(state, 'S-1'))).toBe(false);
    });

    it('through runShip, the stop is code 2 with no later step and no HALT', async () => {
      const ctx = ctxFor({ delta: sgd({ package: { AiEvaluationDefinition: ['Acme_Order_Helper_Tests'] } }) });
      const later = { name: 'push', ran: 0, run() { this.ran += 1; return { ok: true }; } };
      const { code, result } = await runShip({ steps: [sfDelta, later], ctx });
      expect(code).toBe(2);
      expect(result).toMatchObject({ stage: 'sf-delta' });
      expect(later.ran).toBe(0);
      expect(ctx.halts).toEqual([]);
    });

    it('passes a change that deletes one, which reaches the normal delete decision', async () => {
      const r = await sfDelta.run(ctxFor({ destructive: { AiEvaluationDefinition: ['Acme_Order_Helper_Tests'] } }));
      expect(r).toMatchObject({ ok: false, code: 10, deletes: [{ type: 'AiEvaluationDefinition', member: 'Acme_Order_Helper_Tests' }] });
      expect(r.failures).toBeUndefined();
      const allowed = await sfDelta.run(ctxFor({ salesforce: block({ destructive: 'allow' }), destructive: { AiEvaluationDefinition: ['Acme_Order_Helper_Tests'] } }));
      expect(allowed.ok).toBe(true);
    });
  });

  describe('agent eval specs', () => {
    const BUNDLE = { package: { AiAuthoringBundle: ['Acme_Order_Helper'], ApexClass: ['AcmeOrderStatusAction'] } };
    const SHOW = 'git show bbb:tests/Acme_Order_Helper-eval.json';
    const missing = { status: 128, stdout: '', stderr: "fatal: path 'tests/Acme_Order_Helper-eval.json' does not exist in 'bbb'" };

    it('stops with code 2 naming the file when an agent bundle has no eval spec at HEAD', async () => {
      const ctx = ctxFor({ delta: sgd(BUNDLE), over: [[SHOW, missing]] });
      const r = await sfDelta.run(ctx);
      expect(r).toMatchObject({ ok: false, code: 2, stage: 'sf-delta' });
      expect(r.reason).toContain('tests/Acme_Order_Helper-eval.json');
      expect(ctx.sh.calls).toContain(SHOW);
    });

    it("stops with code 2 and readEvalSpec's reason for a malformed spec", async () => {
      const bad = { ...ACME_SPEC, tests: [{ ...ACME_SPEC.tests[0], routing: [{ field: 'lastExecution.topic', operator: 'contains', expected: 'Acme' }] }] };
      const r = await sfDelta.run(ctxFor({ delta: sgd(BUNDLE), over: [[SHOW, specText(bad)]] }));
      expect(r).toMatchObject({ ok: false, code: 2, stage: 'sf-delta' });
      expect(r.reason).toContain('tests/Acme_Order_Helper-eval.json');
      expect(r.reason).toContain('tests[0].routing[0].field');
    });

    it('passes a valid spec', async () => {
      const r = await sfDelta.run(ctxFor({ delta: sgd(BUNDLE), over: [[SHOW, specText(ACME_SPEC)]] }));
      expect(r.ok).toBe(true);
    });

    it('skips the check when agentforce is off', async () => {
      const ctx = ctxFor({ salesforce: block({ agentforce: 'off' }), delta: sgd(BUNDLE), over: [[SHOW, missing]] });
      expect((await sfDelta.run(ctx)).ok).toBe(true);
      expect(ctx.sh.calls).not.toContain(SHOW);
    });

    it('reads no spec for a change with no agent bundle', async () => {
      const ctx = ctxFor();
      expect((await sfDelta.run(ctx)).ok).toBe(true);
      expect(ctx.sh.calls.some((l) => l.startsWith('git show '))).toBe(false);
    });
  });

  it('reads an entity-encoded member once and writes it back escaped exactly once', async () => {
    const r = await sfDelta.run(ctxFor({ destructive: { CustomObject: ['A&amp;B'] } }));
    expect(r).toMatchObject({ ok: false, code: 10, stage: 'sf-delta' });
    expect(r.deletes).toEqual([{ type: 'CustomObject', member: 'A&B' }]);
    const post = fs.readFileSync(postXml(), 'utf8');
    expect(post).toContain('<members>A&amp;B</members>');
    expect(post).not.toContain('&amp;amp;');
    expect(manifestTypes(postXml())).toEqual({ CustomObject: ['A&B'] });
    expect(manifestTypes(postXml())).toEqual(manifestTypes(destructiveXml()));
    expect(r.sha256).toBe(sha(destructiveXml()));
  });

  describe('the story id', () => {
    const BAD = ['..', '.', '', 'a/b'];
    const SENTINELS = [
      ['salesforce', 'orgs', 'acme-dev1.json'],
      ['salesforce', 'delta', 'S-2', 'keep.txt'],
      ['salesforce', 'deletes', 'S-2.json'],
    ];
    const plant = () =>
      SENTINELS.map((parts) => {
        const file = path.join(state, ...parts);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `acme ${parts.join('/')}\n`);
        return [file, fs.readFileSync(file)];
      });

    it.each(BAD)('refuses %j with code 1 before anything runs, and touches nothing', async (bad) => {
      const ctx = ctxFor({ destructive: OLD });
      ctx.story = bad;
      const planted = plant();
      const r = await sfDelta.run(ctx);
      expect(r).toMatchObject({ ok: false, code: 1, stage: 'sf-delta' });
      expect(r.reason.startsWith('not a story id')).toBe(true);
      for (const [file, bytes] of planted) expect(fs.readFileSync(file)).toEqual(bytes);
      expect(ctx.sh.calls.filter((l) => l.startsWith('sf ') || l.startsWith('git '))).toEqual([]);
    });

    it('through runShip, a bad id stops with code 1, no later step and no HALT', async () => {
      const ctx = ctxFor({ destructive: OLD });
      ctx.story = '..';
      const later = { name: 'push', ran: 0, run() { this.ran += 1; return { ok: true }; } };
      const { code, result } = await runShip({ steps: [sfDelta, later], ctx });
      expect(code).toBe(1);
      expect(result).toMatchObject({ stage: 'sf-delta' });
      expect(later.ran).toBe(0);
      expect(ctx.halts).toEqual([]);
    });
  });

  describe('the sfdx-git-delta pin', () => {
    it('refuses another version line, and never runs the delta', async () => {
      const ctx = ctxFor({ plugins: sfRaw(acmePlugins()) });
      const r = await sfDelta.run(ctx);
      expect(r).toEqual({ ok: false, code: 1, stage: 'sf-delta', reason: 'sfdx-git-delta 6.20.0 is installed; Foreman needs 6.45.x: sf plugins install sfdx-git-delta@6.45.1' });
      expect(r.reason).toContain(`${SGD_LINE}.x`);
      expect(sgdLine(ctx)).toBeUndefined();
    });

    it('refuses a missing sfdx-git-delta', async () => {
      const ctx = ctxFor({ plugins: sfRaw(acmePlugins({ 'sfdx-git-delta': null })) });
      const r = await sfDelta.run(ctx);
      expect(r).toMatchObject({ ok: false, code: 1, stage: 'sf-delta', reason: 'sfdx-git-delta missing is installed; Foreman needs 6.45.x: sf plugins install sfdx-git-delta@6.45.1' });
      expect(sgdLine(ctx)).toBeUndefined();
    });

    it('refuses when sf cannot list its plugins', async () => {
      const ctx = ctxFor({ plugins: sfError('SfError', 'plugins broke') });
      expect(await sfDelta.run(ctx)).toMatchObject({ ok: false, code: 1, stage: 'sf-delta' });
      expect(sgdLine(ctx)).toBeUndefined();
    });

    it('passes 6.45.1', async () => {
      expect((await sfDelta.run(ctxFor())).ok).toBe(true);
    });
  });

  it('fails with code 1 when the merge base or HEAD cannot be read', async () => {
    for (const over of [[['git merge-base HEAD origin/main', 1]], [['git rev-parse HEAD', 128]]]) {
      const ctx = ctxFor({ over });
      expect(await sfDelta.run(ctx)).toMatchObject({ ok: false, code: 1, stage: 'sf-delta' });
      expect(sgdLine(ctx)).toBeUndefined();
    }
  });

  it('fails with code 1 and sf\'s message only when sgd fails', async () => {
    const r = await sfDelta.run(ctxFor({ delta: sfError('SgdError', 'fatal: bad revision aaa') }));
    expect(r).toEqual({ ok: false, code: 1, stage: 'sf-delta', reason: 'could not build the delta: fatal: bad revision aaa' });
  });

  it('clears what an earlier run left in the delta folder', async () => {
    fs.mkdirSync(path.join(deltaDir(), 'package'), { recursive: true });
    fs.writeFileSync(path.join(deltaDir(), 'stale.txt'), 'old');
    fs.writeFileSync(path.join(deltaDir(), 'package', 'Old.cls'), 'old');
    expect((await sfDelta.run(ctxFor())).ok).toBe(true);
    expect(fs.existsSync(path.join(deltaDir(), 'stale.txt'))).toBe(false);
    expect(fs.existsSync(path.join(deltaDir(), 'package', 'Old.cls'))).toBe(false);
  });

  describe('the helpers rollback shares', () => {
    const isoFor = (rules) => {
      const sh = fakeSh(rules);
      return { sh, iso: isolatedSh(sh, { FOREMAN_SF_HOME: sfHome }, sfHome, os.homedir()) };
    };

    it("sgdProblem gives the step's exact message, or null for the pinned line", async () => {
      expect(sgdProblem(isoFor([[/^sf plugins --core/, PINNED]]).iso)).toBeNull();
      const ctx = ctxFor({ plugins: sfRaw(acmePlugins()) });
      const r = await sfDelta.run(ctx);
      expect(sgdProblem(isoFor([[/^sf plugins --core/, sfRaw(acmePlugins())]]).iso)).toBe(r.reason);
      expect(sgdProblem(isoFor([[/^sf plugins --core/, sfError('SfError', 'plugins broke')]]).iso)).toBe('could not list the sf plugins: plugins broke');
    });

    it('buildDelta runs sgd in cwd and splits Flow and RecordType from the sorted deletes', () => {
      const out = path.join(state, 'rollback-delta');
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'stale.txt'), 'old');
      const { sh, iso } = isoFor([[/^sf sgd source delta /, sgd({ destructive: { RecordType: ['Case.Acme_Claim'], ApexClass: ['AcmeZ', 'AcmeA'], Flow: ['Acme_Intake'] } })]]);
      const r = buildDelta(iso, { from: 'm1', to: 'r1', dir: out, cwd: '/acme/tree' });
      expect(sh.calls).toEqual([`sf sgd source delta --from m1 --to r1 --output-dir ${out} --generate-delta --json`]);
      expect(sh.opts[0].cwd).toBe('/acme/tree');
      expect(sh.limits[0]).toBe(600000);
      expect(sh.opts[0].env.HOME).toBe(sfHome);
      expect(fs.existsSync(path.join(out, 'stale.txt'))).toBe(false);
      expect(r).toEqual({
        ok: true,
        manifest: path.join(out, 'package', 'package.xml'),
        postDestructive: path.join(out, 'postDestructiveChanges.xml'),
        deletes: [{ type: 'ApexClass', member: 'AcmeA' }, { type: 'ApexClass', member: 'AcmeZ' }],
        byHand: [{ type: 'Flow', member: 'Acme_Intake' }, { type: 'RecordType', member: 'Case.Acme_Claim' }],
        held: [],
        sha256: sha(path.join(out, 'destructiveChanges', 'destructiveChanges.xml')),
      });
      expect(manifestTypes(r.postDestructive)).toEqual({ ApexClass: ['AcmeA', 'AcmeZ'] });
    });

    it('buildDelta keeps a held delete out of deletes and postDestructiveChanges.xml and returns it in held, still hashing the whole destructiveChanges.xml', () => {
      const out = path.join(state, 'hold-delta');
      const { iso } = isoFor([[/^sf sgd source delta /, sgd({ destructive: { ApexClass: ['AcmeY', 'AcmeX'], AiAuthoringBundle: ['Acme_Order_Helper'] } })]]);
      const hold = [{ type: 'ApexClass', member: 'AcmeX', agent: 'Acme_Order_Helper' }, { type: 'AiAuthoringBundle', member: 'Acme_Order_Helper', agent: 'Acme_Order_Helper' }, { type: 'ApexClass', member: 'AcmeNotDeleted' }];
      const r = buildDelta(iso, { from: 'm1', to: 'r1', dir: out, hold });
      expect(r.deletes).toEqual([{ type: 'ApexClass', member: 'AcmeY' }]);
      expect(r.held).toEqual([{ type: 'AiAuthoringBundle', member: 'Acme_Order_Helper', agent: 'Acme_Order_Helper' }, { type: 'ApexClass', member: 'AcmeX', agent: 'Acme_Order_Helper' }]);
      expect(manifestTypes(r.postDestructive)).toEqual({ ApexClass: ['AcmeY'] });
      expect(r.sha256).toBe(sha(path.join(out, 'destructiveChanges', 'destructiveChanges.xml')));
    });

    it('buildDelta matches a hold on type and member, so a class named like a held bundle is still deleted', () => {
      const out = path.join(state, 'hold-type-delta');
      const { iso } = isoFor([[/^sf sgd source delta /, sgd({ destructive: { ApexClass: ['AcmeX'] } })]]);
      const r = buildDelta(iso, { from: 'm1', to: 'r1', dir: out, hold: [{ type: 'AiAuthoringBundle', member: 'AcmeX' }] });
      expect(r.deletes).toEqual([{ type: 'ApexClass', member: 'AcmeX' }]);
      expect(r.held).toEqual([]);
    });

    it('buildDelta leaves a held Flow in byHand', () => {
      const out = path.join(state, 'hold-flow-delta');
      const { iso } = isoFor([[/^sf sgd source delta /, sgd({ destructive: { Flow: ['Acme_Intake'] } })]]);
      const r = buildDelta(iso, { from: 'm1', to: 'r1', dir: out, hold: [{ type: 'Flow', member: 'Acme_Intake' }] });
      expect(r.byHand).toEqual([{ type: 'Flow', member: 'Acme_Intake' }]);
      expect(r.held).toEqual([]);
      expect(r.deletes).toEqual([]);
    });

    it('buildDelta passes no cwd when none is given', () => {
      const out = path.join(state, 'plain-delta');
      const { sh, iso } = isoFor([[/^sf sgd source delta /, sgd({})]]);
      expect(buildDelta(iso, { from: 'aaa', to: 'bbb', dir: out }).ok).toBe(true);
      expect(sh.opts[0]).not.toHaveProperty('cwd');
    });

    it("buildDelta gives the step's reasons when sgd fails or writes no destructiveChanges.xml", () => {
      const out = path.join(state, 'bad-delta');
      expect(buildDelta(isoFor([[/^sf sgd source delta /, sfError('SgdError', 'fatal: bad revision m1')]]).iso, { from: 'm1', to: 'r1', dir: out })).toEqual({
        ok: false,
        reason: 'could not build the delta: fatal: bad revision m1',
      });
      expect(buildDelta(isoFor([[/^sf sgd source delta /, sfOk({})]]).iso, { from: 'm1', to: 'r1', dir: out })).toEqual({ ok: false, reason: 'sfdx-git-delta wrote no destructiveChanges.xml' });
    });
  });
});
