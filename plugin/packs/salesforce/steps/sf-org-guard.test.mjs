import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sfOrgGuard from './sf-org-guard.mjs';
import { runShip } from '../../../lib/engine/ship.mjs';
import { fakeCtx } from '../../../../test/ship-fakes.mjs';
import { ACME_DEV1_ID, ACME_PROD_ID, ACME_QA_ID, orgRecord, sfError } from '../../../../test/fake-sf.mjs';

const block = (over = {}) => ({
  orgs: { 'acme-dev1': { orgId: ACME_DEV1_ID }, 'acme-qa': { orgId: ACME_QA_ID } },
  build: ['acme-dev1'],
  stages: [{ name: 'qa', org: 'acme-qa' }],
  ...over,
});

const query = (alias) => new RegExp(`^sf data query --query SELECT Id, IsSandbox FROM Organization --target-org ${alias}( |$)`);
const healthy = (over = []) => [...over, [query('acme-dev1'), orgRecord(ACME_DEV1_ID)], [query('acme-qa'), orgRecord(ACME_QA_ID)]];

let sfHome;
let state;
beforeEach(() => {
  sfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-guard-sfhome-'));
  state = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-guard-state-'));
});
afterEach(() => {
  for (const d of [sfHome, state]) fs.rmSync(d, { recursive: true, force: true });
});

const ctxFor = ({ salesforce = block(), config = {}, rules = healthy(), env = {} } = {}) =>
  fakeCtx({ config: { pack: 'salesforce', salesforce, ...config }, rules, root: '/acme/repo', env: { FOREMAN_SF_HOME: sfHome, FOREMAN_STATE_DIR: state, ...env } });

const sfCalls = (ctx) => ctx.sh.calls.filter((l) => l.startsWith('sf '));

describe('sf-org-guard', () => {
  it('is the first Salesforce ship step, and halts the release line when it fails', () => {
    expect(sfOrgGuard).toMatchObject({ name: 'sf-org-guard', label: 'checking every Salesforce org is an allow-listed sandbox', needs: ['sf'], halts: true });
  });

  it('passes two allow-listed sandboxes, querying each once through the isolated sf home', async () => {
    const ctx = ctxFor();
    expect(await sfOrgGuard.run(ctx)).toEqual({ ok: true });
    const calls = sfCalls(ctx);
    expect(calls.filter((l) => l.includes('FROM Organization --target-org acme-dev1'))).toHaveLength(1);
    expect(calls.filter((l) => l.includes('FROM Organization --target-org acme-qa'))).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/^sf data query .*--target-org acme-dev1 --json$/);
    ctx.sh.calls.forEach((line, i) => {
      if (!line.startsWith('sf ')) return;
      expect(ctx.sh.opts[i].env.HOME).toBe(sfHome);
      expect(ctx.sh.opts[i].env.SF_USE_GENERIC_UNIX_KEYCHAIN).toBe('true');
    });
  });

  it('refuses a production org with code 8', async () => {
    const ctx = ctxFor({ rules: healthy([[query('acme-qa'), orgRecord(ACME_QA_ID, false)]]) });
    const r = await sfOrgGuard.run(ctx);
    expect(r).toMatchObject({ ok: false, code: 8, stage: 'sf-org-guard' });
    expect(r.reason).toContain('not a sandbox');
    expect(r.reason).toBe('acme-qa is not a sandbox; production is never a target');
  });

  describe('a production org marked "production": true', () => {
    const withMain = () => block({ orgs: { 'acme-dev1': { orgId: ACME_DEV1_ID }, 'acme-qa': { orgId: ACME_QA_ID }, 'acme-main': { orgId: ACME_PROD_ID, production: true } } });

    it('passes when it is not a deploy target and its server says IsSandbox false, with its org ID', async () => {
      const ctx = ctxFor({ salesforce: withMain(), rules: healthy([[query('acme-main'), orgRecord(ACME_PROD_ID, false)]]) });
      expect(await sfOrgGuard.run(ctx)).toEqual({ ok: true });
      expect(sfCalls(ctx).filter((l) => l.includes('--target-org acme-main'))).toHaveLength(1);
    });
    it('refuses it with code 8 when its server says it is a sandbox', async () => {
      const ctx = ctxFor({ salesforce: withMain(), rules: healthy([[query('acme-main'), orgRecord(ACME_PROD_ID)]]) });
      expect(await sfOrgGuard.run(ctx)).toEqual({ ok: false, code: 8, stage: 'sf-org-guard', reason: 'acme-main is marked "production": true in salesforce.orgs, but its server says it is a sandbox' });
    });
    it('refuses it with code 8 when it gives another org ID', async () => {
      const ctx = ctxFor({ salesforce: withMain(), rules: healthy([[query('acme-main'), orgRecord('00D000000000009AAA', false)]]) });
      expect(await sfOrgGuard.run(ctx)).toMatchObject({ ok: false, code: 8, reason: `acme-main is org 00D000000000009, not ${ACME_PROD_ID}` });
    });
    it('refuses a release target whose server says IsSandbox false, even when it is marked production', async () => {
      // checkConfig refuses this block; the step does not rely on that.
      const salesforce = block({ orgs: { 'acme-dev1': { orgId: ACME_DEV1_ID }, 'acme-qa': { orgId: ACME_QA_ID, production: true } } });
      const ctx = ctxFor({ salesforce, rules: healthy([[query('acme-qa'), orgRecord(ACME_QA_ID, false)]]) });
      expect(await sfOrgGuard.run(ctx)).toEqual({ ok: false, code: 8, stage: 'sf-org-guard', reason: 'acme-qa is not a sandbox; production is never a target' });
      const build = block({ orgs: { 'acme-dev1': { orgId: ACME_DEV1_ID, production: true }, 'acme-qa': { orgId: ACME_QA_ID } } });
      const onBuild = ctxFor({ salesforce: build, rules: healthy([[query('acme-dev1'), orgRecord(ACME_DEV1_ID, false)]]) });
      expect(await sfOrgGuard.run(onBuild)).toMatchObject({ code: 8, reason: 'acme-dev1 is not a sandbox; production is never a target' });
    });
  });

  it('refuses an org that answers with no record', async () => {
    const ctx = ctxFor({ rules: healthy([[query('acme-dev1'), { status: 0, stdout: JSON.stringify({ status: 0, result: { records: [], totalSize: 0 } }) }]]) });
    expect(await sfOrgGuard.run(ctx)).toMatchObject({ code: 8, reason: 'acme-dev1 is not a sandbox; production is never a target' });
  });

  it('refuses the wrong org, naming the alias and both org IDs', async () => {
    const other = '00D000000000009AAA';
    const ctx = ctxFor({ rules: healthy([[query('acme-qa'), orgRecord(other)]]) });
    const r = await sfOrgGuard.run(ctx);
    expect(r).toMatchObject({ ok: false, code: 8, stage: 'sf-org-guard' });
    expect(r.reason).toBe(`acme-qa is org ${other.slice(0, 15)}, not ${ACME_QA_ID}`);
  });

  it('passes a 15-character configured org ID against the 18-character record', async () => {
    const ctx = ctxFor({ salesforce: block({ orgs: { 'acme-dev1': { orgId: ACME_DEV1_ID.slice(0, 15) }, 'acme-qa': { orgId: ACME_QA_ID } } }) });
    expect(await sfOrgGuard.run(ctx)).toEqual({ ok: true });
  });

  it('refuses an allow-listed org with no org ID', async () => {
    const ctx = ctxFor({ salesforce: block({ orgs: { 'acme-dev1': { orgId: ACME_DEV1_ID }, 'acme-qa': {} } }) });
    expect(await sfOrgGuard.run(ctx)).toMatchObject({ ok: false, code: 8, reason: 'acme-qa has no org ID in salesforce.orgs' });
  });

  it('refuses a block with no orgs', async () => {
    const ctx = ctxFor({ salesforce: { build: 'acme-dev1', stages: [] } });
    const r = await sfOrgGuard.run(ctx);
    expect(r).toMatchObject({ ok: false, code: 8, stage: 'sf-org-guard' });
    expect(sfCalls(ctx)).toEqual([]);
  });

  describe('the pull request target', () => {
    it('refuses pull requests into the production branch through ship.pr.into, before any sf call', async () => {
      const ctx = ctxFor({ salesforce: block({ productionBranch: 'main' }), config: { ship: { pr: { into: 'main' } } } });
      const r = await sfOrgGuard.run(ctx);
      expect(r).toEqual({ ok: false, code: 8, stage: 'sf-org-guard', reason: 'pull requests would merge into main, the production branch; production is never a target' });
      expect(sfCalls(ctx)).toEqual([]);
    });

    it('refuses pull requests into the production branch through baseBranch, before any sf call', async () => {
      const ctx = ctxFor({ salesforce: block({ productionBranch: 'release' }), config: { baseBranch: 'release' } });
      const r = await sfOrgGuard.run(ctx);
      expect(r).toMatchObject({ ok: false, code: 8, reason: 'pull requests would merge into release, the production branch; production is never a target' });
      expect(sfCalls(ctx)).toEqual([]);
    });

    it('refuses a first stage that merges into the production branch', async () => {
      const ctx = ctxFor({ salesforce: block({ productionBranch: 'prod-line', stages: [{ name: 'qa', org: 'acme-qa', branch: 'prod-line' }] }), config: { ship: { pr: { into: 'qa' } } } });
      const r = await sfOrgGuard.run(ctx);
      expect(r).toMatchObject({ ok: false, code: 8, reason: 'pull requests would merge into prod-line, the production branch; production is never a target' });
      expect(sfCalls(ctx)).toEqual([]);
    });

    it('passes a pull request into another branch', async () => {
      const ctx = ctxFor({ salesforce: block({ productionBranch: 'main' }), config: { ship: { pr: { into: 'qa' } } } });
      expect(await sfOrgGuard.run(ctx)).toEqual({ ok: true });
    });

    it('passes a pull request into main when no production branch is set', async () => {
      const ctx = ctxFor({ config: { ship: { pr: { into: 'main' } } } });
      expect(await sfOrgGuard.run(ctx)).toEqual({ ok: true });
    });
  });

  it('refuses an org it cannot read, with sf\'s message and nothing more', async () => {
    const ctx = ctxFor({ rules: healthy([[query('acme-qa'), sfError('NamedOrgNotFoundError', 'No authorization information found for acme-qa.')]]) });
    const r = await sfOrgGuard.run(ctx);
    expect(r).toEqual({ ok: false, code: 8, stage: 'sf-org-guard', reason: 'could not check acme-qa: No authorization information found for acme-qa.' });
    expect(r.reason).not.toContain('@');
    expect(r.reason).not.toContain('Did you mean');
    expect(JSON.stringify(r)).not.toContain('stack');
  });

  it('refuses a relative FOREMAN_SF_HOME with no sf call', async () => {
    const ctx = ctxFor({ env: { FOREMAN_SF_HOME: '~/sf-home' } });
    const r = await sfOrgGuard.run(ctx);
    expect(r).toMatchObject({ ok: false, code: 8, stage: 'sf-org-guard' });
    expect(r.reason).toContain('FOREMAN_SF_HOME must be an absolute path');
    expect(sfCalls(ctx)).toEqual([]);
  });

  it('through runShip, a production org stops the release with code 8 and writes HALT', async () => {
    const ctx = ctxFor({ rules: healthy([[query('acme-dev1'), orgRecord(ACME_DEV1_ID, false)]]) });
    const later = { name: 'later', ran: 0, run() { this.ran += 1; return { ok: true }; } };
    const { code, result } = await runShip({ steps: [sfOrgGuard, later], ctx });
    expect(code).toBe(8);
    expect(result).toMatchObject({ stage: 'sf-org-guard', reason: 'acme-dev1 is not a sandbox; production is never a target' });
    expect(later.ran).toBe(0);
    expect(ctx.halts).toHaveLength(1);
    expect(ctx.locks.held.has('ship')).toBe(false);
  });
});
