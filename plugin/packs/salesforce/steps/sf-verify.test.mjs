import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEPLOY_QUERY, POST_DEPLOY_CHECKS, markFixed, sfVerify, verifyStep } from './sf-verify.mjs';
import { sfDeploy } from './sf-deploy.mjs';
import { defaults } from '../config.mjs';
import { readDeployed, readRelease, writeDeployed } from '../releases.mjs';
import rollback from '../../../lib/adapters/ship/rollback.mjs';
import { runShip } from '../../../lib/engine/ship.mjs';
import { makeHealthCommand } from '../../../lib/cli/commands/health.mjs';
import { fakeCtx, fakeSh } from '../../../../test/ship-fakes.mjs';
import { ACME_DEV1_ID, ACME_QA_ID, ACME_UAT_ID, orgRecord, sfError, sfOk } from '../../../../test/fake-sf.mjs';
import { evalRules, fakeFetch, failing } from '../../../../test/fake-agent-eval.mjs';

const JOB = '0Af000000000001AAA';
const JOB15 = JOB.slice(0, 15);
const OTHER_JOB = '0Af000000000009AAA';
const PUBLISH_JOB = '0Af000000000007AAA';
const COMMIT = 'c0ffee1234567890abcdef1234567890abcdef12';
const NEWER = 'beef00001234567890abcdef1234567890abcdef';

const LAYOUT_A = { orgs: { 'acme-dev1': { orgId: ACME_DEV1_ID } }, build: 'acme-dev1', stages: [{ name: 'dev', org: 'acme-dev1' }] };
const LAYOUT_B = {
  productionBranch: 'main',
  orgs: { 'acme-dev1': { orgId: ACME_DEV1_ID }, 'acme-qa': { orgId: ACME_QA_ID }, 'acme-uat': { orgId: ACME_UAT_ID } },
  build: ['acme-dev1'],
  stages: [{ name: 'qa', org: 'acme-qa', branch: 'qa' }, { name: 'uat', org: 'acme-uat', branch: 'uat' }],
};

// The answer to the DeployRequest query: the newest real deploy, or none.
// CompletedDate undefined leaves the field out.
const newest = (id, completed = '2026-10-15T11:59:00.000+0000') =>
  sfOk({ records: id ? [{ attributes: { type: 'DeployRequest' }, Id: id, Status: 'Succeeded', ...(completed === undefined ? {} : { CompletedDate: completed }) }] : [], totalSize: id ? 1 : 0, done: true });
// A deploy that finished after the fake clock's start (2026-10-15T12:00:00Z), as a publish does.
const LATER = '2026-10-15T12:00:30.000+0000';
const byId = (status) => sfOk({ records: [{ attributes: { type: 'DeployRequest' }, Id: JOB, Status: status }], totalSize: 1, done: true });
const QUERY = `sf data query --use-tooling-api --query ${DEPLOY_QUERY}`;
const BY_ID = `sf data query --use-tooling-api --query SELECT Id, Status FROM DeployRequest WHERE Id = '${JOB}'`;

let sfHome;
let state;
beforeEach(() => {
  sfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-verify-sfhome-'));
  state = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-verify-state-'));
});
afterEach(() => {
  for (const d of [sfHome, state]) fs.rmSync(d, { recursive: true, force: true });
});

const seen = [];
afterEach(() => {
  for (const ctx of seen.splice(0)) {
    for (const line of ctx.sh.calls.filter((l) => l.startsWith('sf '))) {
      expect(line).not.toContain('--ignore');
      expect(line).not.toContain(' quick');
      expect(line).not.toContain('NoTestRun');
    }
  }
});

function make({ salesforce = LAYOUT_B, query = newest(JOB), rules = [], deploys = { qa: { org: 'acme-qa', jobId: JOB } }, ...rest } = {}) {
  const ctx = fakeCtx({
    config: { pack: 'salesforce', salesforce, slots: 1 },
    rules: [...rules, [QUERY, query]],
    root: '/acme/repo',
    env: { FOREMAN_SF_HOME: sfHome, FOREMAN_STATE_DIR: state },
    ...rest,
  });
  if (deploys) ctx.sfDeploys = deploys;
  ctx.sfDelta = { to: 'bbb' };
  seen.push(ctx);
  return ctx;
}
const sfLines = (ctx) => ctx.sh.calls.filter((l) => l.startsWith('sf '));

describe('sfVerify(stage)', () => {
  it('is the step that checks a stage after its deploy: needs sf, halts, deploys nothing, one module per name', () => {
    const qa = sfVerify('qa');
    expect(qa).toMatchObject({ name: 'sf-verify-qa', label: 'checking qa after the Salesforce deploy', needs: ['sf'], halts: true });
    expect(qa.deploys).toBeUndefined();
    expect(typeof qa.healthy).toBe('function');
    expect(sfVerify('qa')).toBe(qa);
    expect(sfVerify('uat')).not.toBe(qa);
    expect(verifyStep('qa')).not.toBe(qa);
    expect(POST_DEPLOY_CHECKS.map((c) => c.name)).toEqual(['agentforce']);
  });

  it("sfVerify(stage, { later: true }) is a later stage's step: noRollback, the same healthy, one module per name", () => {
    const later = sfVerify('uat', { later: true });
    expect(later).toMatchObject({ name: 'sf-verify-uat', noRollback: true, needs: ['sf'], halts: true });
    expect(later.deploys).toBeUndefined();
    expect(sfVerify('uat', { later: true })).toBe(later);
    expect(sfVerify('uat')).not.toBe(later);
    expect(sfVerify('uat')).not.toHaveProperty('noRollback');
    expect(later.healthy).toBe(sfVerify('uat').healthy);
  });

  it('marks the stage reached for the story', async () => {
    await sfVerify('qa').run(make());
    expect(readRelease(state, 'S-1')).toMatchObject({ to: 'bbb', reached: ['qa'] });
  });

  it('fails with code 5 when sf-deploy did not run first, with no sf call', async () => {
    const ctx = make({ deploys: null });
    expect(await sfVerify('qa').run(ctx)).toEqual({ ok: false, code: 5, stage: 'sf-verify-qa', reason: 'sf-deploy-qa must run first.' });
    expect(sfLines(ctx)).toEqual([]);
  });

  it('fails with code 5 for a stage the layout does not have', async () => {
    const ctx = make();
    expect(await sfVerify('dev').run(ctx)).toMatchObject({ ok: false, code: 5, stage: 'sf-verify-dev' });
    expect(sfLines(ctx)).toEqual([]);
  });

  it('passes a skipped deploy with no sf call', async () => {
    const ctx = make({ deploys: { dev: { org: 'acme-dev1' }, qa: { org: 'acme-qa', skipped: true } } });
    expect(await sfVerify('qa').run(ctx)).toEqual({ ok: true, sfVerify: { qa: { org: 'acme-qa', skipped: true } } });
    expect(sfLines(ctx)).toEqual([]);
  });

  it('queries the newest real deploy in the stage org through the isolated sf home', async () => {
    const ctx = make();
    await sfVerify('qa').run(ctx);
    const line = `sf data query --use-tooling-api --query ${DEPLOY_QUERY} --target-org acme-qa --json`;
    expect(sfLines(ctx)).toEqual([line]);
    expect(ctx.sh.opts[ctx.sh.calls.indexOf(line)].env.HOME).toBe(sfHome);
    expect(DEPLOY_QUERY).toBe("SELECT Id, Status, CompletedDate FROM DeployRequest WHERE Status = 'Succeeded' AND CheckOnly = false ORDER BY CompletedDate DESC LIMIT 1");
  });

  it("passes when the newest deploy is Foreman's, comparing 15 characters", async () => {
    const ctx = make({ deploys: { qa: { org: 'acme-qa', jobId: JOB15 } } });
    ctx.sfVerify = { dev: { org: 'acme-dev1', skipped: true } };
    expect(await sfVerify('qa').run(ctx)).toEqual({ ok: true, sfVerify: { dev: { org: 'acme-dev1', skipped: true }, qa: { org: 'acme-qa', jobId: JOB15, checks: ['agentforce'] } } });
  });

  it('fails with code 5 when another deploy is newer, or there is none', async () => {
    expect(await sfVerify('qa').run(make({ query: newest(OTHER_JOB) }))).toEqual({
      ok: false,
      code: 5,
      stage: 'sf-verify-qa',
      reason: `The newest deploy in acme-qa (qa) is ${OTHER_JOB}, not Foreman's ${JOB}.`,
    });
    expect((await sfVerify('qa').run(make({ query: newest(null) }))).reason).toBe(`The newest deploy in acme-qa (qa) is none, not Foreman's ${JOB}.`);
  });

  it('fails with code 5 when the query fails', async () => {
    const r = await sfVerify('qa').run(make({ query: sfError('NoAuthInfoFound', 'No authorization information found for acme-qa.') }));
    expect(r).toEqual({ ok: false, code: 5, stage: 'sf-verify-qa', reason: 'Could not check the last deploy in acme-qa (qa): No authorization information found for acme-qa.' });
  });

  describe('the post-deploy checks', () => {
    const hook = (name, applies, result) => {
      const calls = [];
      return { name, calls, applies: () => applies, run: (args) => (calls.push(args), typeof result === 'function' ? result() : result) };
    };

    it('runs only the checks that apply, after the query, with the stage', async () => {
      const ctx = make();
      const yes = hook('acme-omni', true, () => {
        expect(sfLines(ctx)).toHaveLength(1);
        return { ok: true };
      });
      const no = hook('acme-agent', false, { ok: true });
      const r = await verifyStep('qa', [yes, no]).run(ctx);
      expect(r).toEqual({ ok: true, sfVerify: { qa: { org: 'acme-qa', jobId: JOB, checks: ['acme-omni'] } } });
      expect(yes.calls).toHaveLength(1);
      expect(yes.calls[0].ctx).toBe(ctx);
      expect(yes.calls[0].stage).toMatchObject({ name: 'qa', org: 'acme-qa' });
      expect(typeof yes.calls[0].sh).toBe('function');
      expect(no.calls).toEqual([]);
    });

    it("adds a check's notes to the facts, and to manualSteps after sf-delta's", async () => {
      const ctx = make();
      ctx.manualSteps = ['Delete Flow Acme_Intake by hand in each org the story reaches; Foreman never deletes Flows'];
      const noted = hook('acme-agent', true, { ok: true, notes: ['Check agent Acme_Order_Helper in qa: the judge scored case greeting below 3', 7, null] });
      const quiet = hook('acme-omni', true, { ok: true, notes: [] });
      const r = await verifyStep('qa', [noted, quiet]).run(ctx);
      expect(r).toEqual({
        ok: true,
        sfVerify: { qa: { org: 'acme-qa', jobId: JOB, checks: ['acme-agent', 'acme-omni'], notes: ['Check agent Acme_Order_Helper in qa: the judge scored case greeting below 3'] } },
        manualSteps: [
          'Delete Flow Acme_Intake by hand in each org the story reaches; Foreman never deletes Flows',
          'Check agent Acme_Order_Helper in qa: the judge scored case greeting below 3',
        ],
      });
    });

    it('leaves manualSteps untouched when no check has notes', async () => {
      const ctx = make();
      ctx.manualSteps = ['Delete Flow Acme_Intake by hand in each org the story reaches; Foreman never deletes Flows'];
      const r = await verifyStep('qa', [hook('acme-agent', true, { ok: true, notes: [] })]).run(ctx);
      expect(r).toEqual({ ok: true, sfVerify: { qa: { org: 'acme-qa', jobId: JOB, checks: ['acme-agent'] } } });
      expect(r).not.toHaveProperty('manualSteps');
    });

    it('fails with code 5 when a check fails or throws', async () => {
      const failing = hook('acme-omni', true, async () => ({ ok: false, reason: 'OmniScript Acme_Intake is not active' }));
      expect(await verifyStep('qa', [failing]).run(make())).toEqual({ ok: false, code: 5, stage: 'sf-verify-qa', reason: 'acme-omni: OmniScript Acme_Intake is not active' });
      const throwing = hook('acme-agent', true, () => {
        throw new Error('agent broke');
      });
      expect(await verifyStep('qa', [throwing]).run(make())).toMatchObject({ ok: false, code: 5, reason: 'acme-agent: agent broke' });
    });

    describe('a check that changed the org', () => {
      const changed = () => hook('acme-agent', true, { ok: true, changedOrg: true });
      const stageRecord = (story = 'S-1') => writeDeployed(state, { stage: 'qa', org: 'acme-qa', orgId: ACME_QA_ID, jobId: JOB, story, commit: COMMIT, at: '2026-10-15T11:00:00.000Z' });
      const inTurn = (...answers) => {
        let n = 0;
        return () => answers[Math.min(n++, answers.length - 1)];
      };

      it("re-reads the org's newest deploy and moves the story's stage record to it", async () => {
        stageRecord();
        const ctx = make({ query: inTurn(newest(JOB), newest(PUBLISH_JOB, LATER)) });
        const r = await verifyStep('qa', [changed()]).run(ctx);
        expect(r).toEqual({ ok: true, sfVerify: { qa: { org: 'acme-qa', jobId: JOB, checks: ['acme-agent'] } } });
        expect(sfLines(ctx).filter((l) => l.includes('FROM DeployRequest'))).toHaveLength(2);
        expect(readDeployed(state, 'qa')).toEqual({ stage: 'qa', org: 'acme-qa', orgId: ACME_QA_ID, jobId: PUBLISH_JOB, story: 'S-1', commit: COMMIT, at: '2026-10-15T11:00:00.000Z' });
      });

      it('leaves a stage record of another story alone', async () => {
        const before = stageRecord('S-2');
        const ctx = make({ query: inTurn(newest(JOB), newest(PUBLISH_JOB, LATER)) });
        expect((await verifyStep('qa', [changed()]).run(ctx)).ok).toBe(true);
        expect(readDeployed(state, 'qa')).toEqual(before);
      });

      it('does not re-read when no check changed the org', async () => {
        stageRecord();
        const ctx = make({ query: inTurn(newest(JOB), newest(PUBLISH_JOB, LATER)) });
        expect((await verifyStep('qa', [hook('acme-agent', true, { ok: true })]).run(ctx)).ok).toBe(true);
        expect(sfLines(ctx).filter((l) => l.includes('FROM DeployRequest'))).toHaveLength(1);
        expect(readDeployed(state, 'qa').jobId).toBe(JOB);
      });

      it('fails with code 5 when the re-read fails', async () => {
        stageRecord();
        const ctx = make({ query: inTurn(newest(JOB), sfError('NoAuthInfoFound', 'No authorization information found for acme-qa.')) });
        expect(await verifyStep('qa', [changed()]).run(ctx)).toEqual({
          ok: false,
          code: 5,
          stage: 'sf-verify-qa',
          reason: 'Could not check the last deploy in acme-qa (qa) after publishing agents: No authorization information found for acme-qa.',
        });
        expect(readDeployed(state, 'qa').jobId).toBe(JOB);
      });

      const NOT_ACTIVE = 'agent Acme_Order_Helper version 2 is not active';
      const failedAfterPublish = () => hook('acme-agent', true, { ok: false, reason: NOT_ACTIVE, changedOrg: true });

      it('moves the record to the publish when the check fails after publishing, then fails with code 5', async () => {
        stageRecord();
        const ctx = make({ query: inTurn(newest(JOB), newest(PUBLISH_JOB, LATER)) });
        expect(await verifyStep('qa', [failedAfterPublish()]).run(ctx)).toEqual({ ok: false, code: 5, stage: 'sf-verify-qa', reason: `acme-agent: ${NOT_ACTIVE}` });
        expect(sfLines(ctx).filter((l) => l.includes('FROM DeployRequest'))).toHaveLength(2);
        expect(readDeployed(state, 'qa').jobId).toBe(PUBLISH_JOB);
      });

      it('adopts after a later check fails when an earlier one changed the org', async () => {
        stageRecord();
        const ctx = make({ query: inTurn(newest(JOB), newest(PUBLISH_JOB, LATER)) });
        const omni = hook('acme-omni', true, { ok: false, reason: 'OmniScript Acme_Intake is not active' });
        expect(await verifyStep('qa', [changed(), omni]).run(ctx)).toEqual({ ok: false, code: 5, stage: 'sf-verify-qa', reason: 'acme-omni: OmniScript Acme_Intake is not active' });
        expect(readDeployed(state, 'qa').jobId).toBe(PUBLISH_JOB);
      });

      it('adopts after a later check throws when an earlier one changed the org', async () => {
        stageRecord();
        const ctx = make({ query: inTurn(newest(JOB), newest(PUBLISH_JOB, LATER)) });
        const omni = hook('acme-omni', true, () => {
          throw new Error('omni broke');
        });
        expect(await verifyStep('qa', [changed(), omni]).run(ctx)).toMatchObject({ ok: false, code: 5, reason: 'acme-omni: omni broke' });
        expect(readDeployed(state, 'qa').jobId).toBe(PUBLISH_JOB);
      });

      it('does not re-read when a check fails without changing the org', async () => {
        stageRecord();
        const ctx = make({ query: inTurn(newest(JOB), newest(PUBLISH_JOB, LATER)) });
        const r = await verifyStep('qa', [hook('acme-agent', true, { ok: false, reason: NOT_ACTIVE })]).run(ctx);
        expect(r).toEqual({ ok: false, code: 5, stage: 'sf-verify-qa', reason: `acme-agent: ${NOT_ACTIVE}` });
        expect(sfLines(ctx).filter((l) => l.includes('FROM DeployRequest'))).toHaveLength(1);
        expect(readDeployed(state, 'qa').jobId).toBe(JOB);
      });

      it('adds the re-read failure to the halt reason', async () => {
        stageRecord();
        const ctx = make({ query: inTurn(newest(JOB), sfError('NoAuthInfoFound', 'No authorization information found for acme-qa.')) });
        const r = await verifyStep('qa', [failedAfterPublish()]).run(ctx);
        expect(r).toMatchObject({ ok: false, code: 5, stage: 'sf-verify-qa' });
        expect(r.reason).toContain(`acme-agent: ${NOT_ACTIVE}`);
        expect(r.reason).toContain('after publishing agents');
        expect(r.reason).toContain('No authorization information found for acme-qa.');
        expect(readDeployed(state, 'qa').jobId).toBe(JOB);
      });

      it('refuses a newest deploy that finished before the publish started', async () => {
        stageRecord();
        const ctx = make({ query: inTurn(newest(JOB), newest(PUBLISH_JOB, '2026-10-15T11:59:30.000+0000')) });
        const r = await verifyStep('qa', [changed()]).run(ctx);
        expect(r).toMatchObject({ ok: false, code: 5, stage: 'sf-verify-qa' });
        expect(r.reason).toContain(PUBLISH_JOB);
        expect(r.reason).toContain('before the agents were published');
        expect(r.reason).not.toContain('11:59');
        expect(readDeployed(state, 'qa').jobId).toBe(JOB);
      });

      it('refuses a newest deploy with a missing or unparseable CompletedDate', async () => {
        for (const completed of [undefined, null, 'not a date']) {
          stageRecord();
          const ctx = make({ query: inTurn(newest(JOB), newest(PUBLISH_JOB, completed)) });
          const r = await verifyStep('qa', [changed()]).run(ctx);
          expect(r, String(completed)).toMatchObject({ ok: false, code: 5, stage: 'sf-verify-qa' });
          expect(r.reason).toContain('before the agents were published');
          expect(readDeployed(state, 'qa').jobId).toBe(JOB);
        }
      });

      it('takes a deploy that finished exactly when the publishing check started', async () => {
        stageRecord();
        const ctx = make({ query: inTurn(newest(JOB), newest(PUBLISH_JOB, '2026-10-15T12:00:00.000+0000')) });
        expect((await verifyStep('qa', [changed()]).run(ctx)).ok).toBe(true);
        expect(readDeployed(state, 'qa').jobId).toBe(PUBLISH_JOB);
      });

      it('measures from the start of the check that changed the org, not the first check', async () => {
        stageRecord();
        const ctx = make({ query: inTurn(newest(JOB), newest(PUBLISH_JOB, '2026-10-15T12:00:30.000+0000')) });
        const slow = hook('acme-omni', true, async () => {
          await ctx.sleep(60_000);
          return { ok: true };
        });
        const r = await verifyStep('qa', [slow, changed()]).run(ctx);
        expect(r).toMatchObject({ ok: false, code: 5 });
        expect(r.reason).toContain('before the agents were published');
        expect(readDeployed(state, 'qa').jobId).toBe(JOB);
      });

      it('measures from the first check that changed the org, not a later one', async () => {
        stageRecord();
        const ctx = make({ query: inTurn(newest(JOB), newest(PUBLISH_JOB, '2026-10-15T12:00:30.000+0000')) });
        const slowChange = hook('acme-agent', true, async () => {
          await ctx.sleep(60_000);
          return { ok: true, changedOrg: true };
        });
        const omni = hook('acme-omni', true, { ok: true, changedOrg: true });
        expect((await verifyStep('qa', [slowChange, omni]).run(ctx)).ok).toBe(true);
        expect(readDeployed(state, 'qa').jobId).toBe(PUBLISH_JOB);
      });

      it('refuses the same early deploy on the failure path', async () => {
        stageRecord();
        const ctx = make({ query: inTurn(newest(JOB), newest(PUBLISH_JOB, '2026-10-15T11:59:30.000+0000')) });
        const r = await verifyStep('qa', [failedAfterPublish()]).run(ctx);
        expect(r).toMatchObject({ ok: false, code: 5, stage: 'sf-verify-qa' });
        expect(r.reason).toContain(`acme-agent: ${NOT_ACTIVE}`);
        expect(r.reason).toContain('before the agents were published');
        expect(readDeployed(state, 'qa').jobId).toBe(JOB);
      });

      it("leaves another story's record alone on the failure path too", async () => {
        const before = stageRecord('S-2');
        const ctx = make({ query: inTurn(newest(JOB), newest(PUBLISH_JOB, LATER)) });
        expect(await verifyStep('qa', [failedAfterPublish()]).run(ctx)).toEqual({ ok: false, code: 5, stage: 'sf-verify-qa', reason: `acme-agent: ${NOT_ACTIVE}` });
        expect(readDeployed(state, 'qa')).toEqual(before);
      });
    });

    it('publishes and activates a changed agent through sfVerify, and moves the stage record to the publish', async () => {
      const AGENT = 'Acme_Order_Helper';
      const pkg = path.join(state, 'package.xml');
      fs.writeFileSync(pkg, `<Package><types><members>${AGENT}</members><name>AiAuthoringBundle</name></types><types><members>AcmeOrderStatusAction</members><name>ApexClass</name></types></Package>`);
      writeDeployed(state, { stage: 'qa', org: 'acme-qa', orgId: ACME_QA_ID, jobId: JOB, story: 'S-1', commit: COMMIT, at: '2026-10-15T11:00:00.000Z' });
      const bot = (list) => sfOk({ records: list.map(([n, status]) => ({ VersionNumber: n, Status: status })), totalSize: list.length, done: true });
      let deploys = 0;
      let botQueries = 0;
      const ctx = make({
        query: () => (deploys++ === 0 ? newest(JOB) : newest(PUBLISH_JOB, LATER)),
        rules: [
          [/^sf agent validate authoring-bundle /, sfOk({ success: true })],
          [/^sf agent publish authoring-bundle /, sfOk({ success: true })],
          [/^sf agent activate /, sfOk({ success: true })],
          [/FROM BotVersion/, () => [bot([[1, 'Active']]), bot([[1, 'Active'], [2, 'Inactive']]), bot([[1, 'Inactive'], [2, 'Active']])][Math.min(botQueries++, 2)]],
          ...evalRules(),
        ],
      });
      ctx.sfDelta = { to: 'bbb', manifest: pkg };
      ctx.fetch = fakeFetch();
      const r = await sfVerify('qa').run(ctx);
      expect(r).toEqual({ ok: true, sfVerify: { qa: { org: 'acme-qa', jobId: JOB, checks: ['agentforce'] } } });
      const agentLines = sfLines(ctx).filter((l) => l.startsWith('sf agent '));
      expect(agentLines).toEqual([
        `sf agent validate authoring-bundle --api-name ${AGENT} --target-org acme-qa --json`,
        `sf agent publish authoring-bundle --api-name ${AGENT} --target-org acme-qa --skip-retrieve --json`,
        `sf agent activate --api-name ${AGENT} --version 2 --target-org acme-qa --json`,
      ]);
      expect(readRelease(state, 'S-1').agents).toMatchObject([{ stage: 'qa', org: 'acme-qa', apiName: AGENT, previous: 1, version: 2 }]);
      expect(readDeployed(state, 'qa')).toMatchObject({ jobId: PUBLISH_JOB, commit: COMMIT, story: 'S-1' });
    });

    it("puts the agent eval's outcome note in manualSteps through sfVerify", async () => {
      const pkg = path.join(state, 'package.xml');
      fs.writeFileSync(pkg, '<Package><types><members>Acme_Order_Helper</members><name>AiAuthoringBundle</name></types></Package>');
      const bot = (list) => sfOk({ records: list.map(([n, status]) => ({ VersionNumber: n, Status: status })), totalSize: list.length, done: true });
      let botQueries = 0;
      const ctx = make({
        rules: [
          [/^sf agent (validate|publish|activate) /, sfOk({ success: true })],
          [/FROM BotVersion/, () => [bot([[1, 'Active']]), bot([[1, 'Active'], [2, 'Inactive']]), bot([[1, 'Inactive'], [2, 'Active']])][Math.min(botQueries++, 2)]],
          ...evalRules(),
        ],
      });
      ctx.sfDelta = { to: 'bbb', manifest: pkg };
      ctx.manualSteps = [];
      ctx.fetch = fakeFetch({ evals: (call) => failing(call.body, { greeting: ['outcome'] }) });
      const r = await sfVerify('qa').run(ctx);
      const note = 'Check agent Acme_Order_Helper in qa: the judge scored case greeting below 3';
      expect(r).toMatchObject({ ok: true, manualSteps: [note] });
      expect(r.sfVerify.qa.notes).toEqual([note]);
    });
  });

  describe('healthy', () => {
    const GIT = [
      ['git fetch --quiet origin +refs/heads/qa:refs/remotes/origin/qa', 0],
      ['git rev-parse --verify refs/remotes/origin/qa', `${COMMIT}\n`],
    ];
    const health = (over = {}) => make({ rules: [...(over.rules ?? []), ...GIT], ...over });
    const record = (stage = 'qa', org = 'acme-qa', orgId = ACME_QA_ID) => writeDeployed(state, { stage, org, orgId, jobId: JOB, story: 'S-1', commit: COMMIT, at: '2026-10-15T12:00:00.000Z' });

    it('has nothing to check without a deploy record, or for a stage the layout lacks', async () => {
      const ctx = health();
      expect(await sfVerify('qa').healthy(ctx)).toBeNull();
      expect(await sfVerify('dev').healthy(ctx)).toBeNull();
      expect(ctx.sh.calls).toEqual([]);
    });

    it("passes when the branch is at Foreman's commit and the newest deploy is Foreman's", async () => {
      record();
      const ctx = health();
      expect(await sfVerify('qa').healthy(ctx)).toEqual({ ok: true, reason: "acme-qa (qa) has Foreman's last deploy, c0ffee1." });
      expect(ctx.sh.calls.slice(0, 2)).toEqual(GIT.map(([line]) => line));
      expect(ctx.sh.opts[0].cwd).toBe('/acme/repo');
    });

    it('fails when the branch moved on, naming both short shas', async () => {
      record();
      const r = await sfVerify('qa').healthy(health({ rules: [['git rev-parse --verify refs/remotes/origin/qa', `${NEWER}\n`]] }));
      expect(r).toEqual({ ok: false, reason: 'qa is at beef000 but acme-qa (qa) last got c0ffee1 from Foreman. Once it is fixed by hand, run: foreman sf fixed qa' });
    });

    it('fails when the branch cannot be read', async () => {
      record();
      expect(await sfVerify('qa').healthy(health({ rules: [['git rev-parse --verify', 128]] }))).toEqual({ ok: false, reason: 'could not read qa' });
    });

    it('fails when another deploy is newer on a stage of its own', async () => {
      record();
      const r = await sfVerify('qa').healthy(health({ query: newest(OTHER_JOB) }));
      expect(r.ok).toBe(false);
      expect(r.reason).toContain(OTHER_JOB);
      expect(r.reason).toMatch(/ Once it is fixed by hand, run: foreman sf fixed qa$/);
    });

    it("a shared stage ignores a newer builder's deploy and checks Foreman's job by its Id", async () => {
      record('dev', 'acme-dev1', ACME_DEV1_ID);
      const ctx = health({
        salesforce: LAYOUT_A,
        query: newest(OTHER_JOB),
        rules: [
          [BY_ID, byId('Succeeded')],
          ['git fetch --quiet origin +refs/heads/main:refs/remotes/origin/main', 0],
          ['git rev-parse --verify refs/remotes/origin/main', `${COMMIT}\n`],
        ],
      });
      expect(await sfVerify('dev').healthy(ctx)).toEqual({ ok: true, reason: "acme-dev1 (dev) has Foreman's last deploy, c0ffee1." });
      expect(sfLines(ctx)).toEqual([`${BY_ID} --target-org acme-dev1 --json`]);
    });

    it('a shared stage fails when the job did not succeed', async () => {
      record('dev', 'acme-dev1', ACME_DEV1_ID);
      const rules = [[BY_ID, byId('Failed')], ['git rev-parse --verify refs/remotes/origin/main', `${COMMIT}\n`]];
      expect((await sfVerify('dev').healthy(health({ salesforce: LAYOUT_A, rules }))).ok).toBe(false);
    });

    it('fails with "Could not check" when the query fails', async () => {
      record();
      const r = await sfVerify('qa').healthy(health({ query: sfError('NoAuthInfoFound', 'No authorization information found for acme-qa.') }));
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/^Could not check/);
    });

    // The stage record has to follow the branch, or a halt could never be cleared.
    describe('stays in step with the branch', () => {
      const at = (head, query = newest(JOB), rules = []) =>
        make({ query, rules: [...rules, ['git fetch --quiet origin +refs/heads/qa:refs/remotes/origin/qa', 0], ['git rev-parse --verify refs/remotes/origin/qa', `${head}\n`]] });

      it('after a story with no metadata merges: the skipped deploy moves the record to the merge', async () => {
        record();
        const pkg = path.join(state, 'package.xml');
        fs.writeFileSync(pkg, '<Package><version>62.0</version></Package>');
        const ctx = make({ deploys: null });
        ctx.sfDelta = { to: 'bbb', manifest: pkg, postDestructive: path.join(state, 'post.xml'), deletes: [] };
        ctx.sha = NEWER;
        expect((await sfDeploy('qa').run(ctx)).sfDeploys.qa.skipped).toBe(true);
        expect(await sfVerify('qa').healthy(at(NEWER))).toEqual({ ok: true, reason: "acme-qa (qa) has Foreman's last deploy, beef000." });
      });

      it('after a failed deploy fixed by hand: fails until `foreman sf fixed` records the head, then passes', async () => {
        record();
        const pkg = path.join(state, 'package.xml');
        fs.writeFileSync(pkg, '<Package><types><members>AcmeService</members><name>ApexClass</name></types></Package>');
        const ctx = make({
          deploys: null,
          rules: [
            [/^sf project deploy start /, sfOk({ id: OTHER_JOB, status: 'Queued' })],
            [/^sf project deploy report /, sfOk({ id: OTHER_JOB, status: 'Failed', details: {} })],
          ],
        });
        ctx.sfDelta = { to: 'bbb', manifest: pkg, postDestructive: path.join(state, 'post.xml'), deletes: [] };
        ctx.sha = NEWER;
        expect((await sfDeploy('qa').run(ctx)).code).toBe(5);
        // The owner deploys the branch by hand: the org's newest deploy is theirs.
        expect((await sfVerify('qa').healthy(at(NEWER, newest(OTHER_JOB)))).ok).toBe(false);

        const fix = at(NEWER, newest(OTHER_JOB), [[/FROM Organization --target-org acme-qa/, orgRecord(ACME_QA_ID)]]);
        const r = await markFixed({ root: fix.root, config: fix.config, env: fix.env, sh: fix.sh, stage: 'qa', now: fix.now });
        expect(r).toEqual({ ok: true, stage: 'qa', org: 'acme-qa', commit: NEWER, jobId: OTHER_JOB });
        expect(readDeployed(state, 'qa')).toEqual({ stage: 'qa', org: 'acme-qa', orgId: ACME_QA_ID, jobId: OTHER_JOB, story: null, commit: NEWER, at: '2026-10-15T12:00:00.000Z' });
        const identity = fix.sh.calls.findIndex((l) => l.includes('FROM Organization'));
        expect(identity).toBeGreaterThanOrEqual(0);
        expect(identity).toBeLessThan(fix.sh.calls.findIndex((l) => l.includes('FROM DeployRequest')));
        expect(fix.sh.opts[identity].env.HOME).toBe(sfHome);
        expect(await sfVerify('qa').healthy(at(NEWER, newest(OTHER_JOB)))).toMatchObject({ ok: true });
      });
    });
  });

  describe('markFixed', () => {
    const IDENTITY = /FROM Organization --target-org acme-qa/;
    const GIT_AT_NEWER = [['git fetch --quiet origin +refs/heads/qa:refs/remotes/origin/qa', 0], ['git rev-parse --verify refs/remotes/origin/qa', `${NEWER}\n`]];
    const fixWith = (ctx, stage = 'qa') => markFixed({ root: ctx.root, config: ctx.config, env: ctx.env, sh: ctx.sh, stage, now: ctx.now });

    it('refuses a stage the layout does not have, with no call', async () => {
      const ctx = make({ rules: GIT_AT_NEWER });
      expect(await fixWith(ctx, 'dev')).toEqual({ ok: false, reason: 'The salesforce block has no stage named dev.' });
      expect(ctx.sh.calls).toEqual([]);
    });

    for (const [what, identity] of [['not a sandbox', orgRecord(ACME_QA_ID, false)], ['another org', orgRecord(ACME_UAT_ID)]]) {
      it(`refuses an org that is ${what}, and records nothing`, async () => {
        const ctx = make({ rules: [[IDENTITY, identity], ...GIT_AT_NEWER] });
        expect((await fixWith(ctx)).ok).toBe(false);
        expect(ctx.sh.calls.some((l) => l.includes('FROM DeployRequest'))).toBe(false);
        expect(readDeployed(state, 'qa')).toBeNull();
      });
    }

    it('fails when the branch cannot be read, and records nothing', async () => {
      const ctx = make({ rules: [['git rev-parse --verify', 128]] });
      expect(await fixWith(ctx)).toEqual({ ok: false, reason: 'could not read qa' });
      expect(readDeployed(state, 'qa')).toBeNull();
    });

    it('fails when the org has no real deploy, and records nothing', async () => {
      const ctx = make({ query: newest(null), rules: [[IDENTITY, orgRecord(ACME_QA_ID)], ...GIT_AT_NEWER] });
      expect(await fixWith(ctx)).toEqual({ ok: false, reason: 'acme-qa (qa) has no deploy to record.' });
      expect(readDeployed(state, 'qa')).toBeNull();
    });
  });
});

describe('through the runner', () => {
  it('a newer foreign deploy fails sf-verify, and the core rollback runs foreman sf rollback for the story', async () => {
    const ROLLBACK = 'sh -c foreman sf rollback "$FOREMAN_STORY"';
    const pkg = path.join(state, 'package.xml');
    fs.writeFileSync(pkg, '<Package><types><members>AcmeService</members><name>ApexClass</name></types></Package>');
    const ctx = make({
      deploys: null,
      query: newest(OTHER_JOB),
      rules: [
        [/^sf project deploy start /, sfOk({ id: JOB, status: 'Queued' })],
        [/^sf project deploy report /, sfOk({ id: JOB, status: 'Succeeded' })],
        [ROLLBACK, 0],
      ],
    });
    ctx.config.ship = { ...ctx.config.ship, rollback: defaults(LAYOUT_B).ship.rollback };
    ctx.sfDelta = { to: 'bbb', manifest: pkg, postDestructive: path.join(state, 'post.xml'), deletes: [] };
    const { code, result } = await runShip({ steps: [sfDeploy('qa'), sfVerify('qa')], ctx, onFailure: rollback });
    expect(code).toBe(5);
    expect(result).toMatchObject({ stage: 'sf-verify-qa', rolledBack: true });
    expect(ctx.sh.calls).toContain(ROLLBACK);
    expect(ctx.sh.opts[ctx.sh.calls.indexOf(ROLLBACK)].env.FOREMAN_STORY).toBe('S-1');
    expect(ctx.halts).toHaveLength(2);
    expect(ctx.halts[0].reason).toMatch(/^Rolling back/);
  });
});

describe('through foreman health', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-verify-health-'));
    fs.writeFileSync(path.join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'Acme' }, pack: 'salesforce', slots: 1, salesforce: LAYOUT_A }));
    writeDeployed(state, { stage: 'dev', org: 'acme-dev1', orgId: ACME_DEV1_ID, jobId: JOB, story: 'S-1', commit: COMMIT, at: '2026-10-15T12:00:00.000Z' });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  async function run(head) {
    const sh = fakeSh([
      ['git rev-parse --verify refs/remotes/origin/main', `${head}\n`],
      [BY_ID, byId('Succeeded')],
    ]);
    let out = '';
    const code = await makeHealthCommand({ sh }).run([], {
      cwd: dir,
      root: dir,
      env: { FOREMAN_PROJECT_DIR: dir, FOREMAN_STATE_DIR: state, FOREMAN_SF_HOME: sfHome },
      now: () => new Date(Date.UTC(2026, 9, 15, 12)),
      stdout: { write: (s) => (out += s) },
    });
    return { code, json: JSON.parse(out.trim().split('\n').at(-1)) };
  }

  it("passes when the org has Foreman's last deploy of the branch head", async () => {
    const { code, json } = await run(COMMIT);
    expect(code).toBe(0);
    expect(json.checks).toEqual([{ step: 'sf-verify-dev', ok: true, reason: "acme-dev1 (dev) has Foreman's last deploy, c0ffee1." }]);
  });

  it('fails when the branch head differs', async () => {
    const { code, json } = await run(NEWER);
    expect(code).toBe(1);
    expect(json.checks).toEqual([{ step: 'sf-verify-dev', ok: false, reason: 'main is at beef000 but acme-dev1 (dev) last got c0ffee1 from Foreman. Once it is fixed by hand, run: foreman sf fixed dev' }]);
  });
});
