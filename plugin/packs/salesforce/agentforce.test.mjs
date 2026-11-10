import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGENTFORCE_FILE, AGENT_API_NAME, agentBundles, agentforceCheck, evalDefinitions, plannerQuery, readAgentforceSwitch, restoreAgents, versionsQuery, writeAgentforceSwitch } from './agentforce.mjs';
import { isolatedSh } from './isolation.mjs';
import { readRelease } from './releases.mjs';
import { fakeCtx, fakeSh } from '../../../test/ship-fakes.mjs';
import { ACME_QA_ID, sfError, sfOk } from '../../../test/fake-sf.mjs';
import { evalRules, failing, fakeFetch } from '../../../test/fake-agent-eval.mjs';

const API = 'Acme_Order_Helper';
const OTHER = 'Acme_Case_Helper';
const STAGE = { name: 'qa', org: 'acme-qa', orgId: ACME_QA_ID, branch: 'qa' };
const LAYOUT = {
  productionBranch: 'main',
  orgs: { 'acme-dev1': { orgId: '00D000000000001AAA' }, 'acme-qa': { orgId: ACME_QA_ID } },
  build: ['acme-dev1'],
  stages: [{ name: 'qa', org: 'acme-qa', branch: 'qa' }],
};

const xml = (types) =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
    ...Object.entries(types).map(([name, members]) => `    <types>\n${members.map((m) => `        <members>${m}</members>`).join('\n')}\n        <name>${name}</name>\n    </types>`),
    '    <version>62.0</version>',
    '</Package>',
    '',
  ].join('\n');

// The answer to the BotVersion query: [[1, 'Active'], [2, 'Inactive']] and the like.
const versions = (list) =>
  sfOk({ records: list.map(([n, status]) => ({ attributes: { type: 'BotVersion' }, VersionNumber: n, Status: status })), totalSize: list.length, done: true });

// Answers each of `answers` in turn, then the last.
const inTurn = (...answers) => {
  let n = 0;
  return () => answers[Math.min(n++, answers.length - 1)];
};

const queryLine = (api = API) => `sf data query --query ${versionsQuery(api)} --target-org acme-qa --json`;
const validateLine = (api = API) => `sf agent validate authoring-bundle --api-name ${api} --target-org acme-qa --json`;
const publishLine = (api = API) => `sf agent publish authoring-bundle --api-name ${api} --target-org acme-qa --skip-retrieve --json`;
const activateLine = (api = API, n = 2) => `sf agent activate --api-name ${api} --version ${n} --target-org acme-qa --json`;
const deactivateLine = (api = API) => `sf agent deactivate --api-name ${api} --target-org acme-qa --json`;
// The eval suite's sf calls after the activates: one sign-in read, then each agent's planner.
const displayLine = 'sf org display --target-org acme-qa --json';
const plannerLine = (api = API, n = 2) => `sf data query --query SELECT Id FROM GenAiPlannerDefinition WHERE DeveloperName = '${api}_v${n}' --target-org acme-qa --json`;

let dir;
let sfHome;
let state;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-agentforce-'));
  sfHome = path.join(dir, 'sf-home');
  state = path.join(dir, 'state');
  fs.mkdirSync(sfHome);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const seen = [];
afterEach(() => {
  for (const sh of seen.splice(0)) {
    for (const line of sh.calls.filter((l) => l.startsWith('sf '))) {
      expect(line).not.toContain('--ignore');
      expect(line).not.toContain(' quick');
      expect(line).not.toContain('NoTestRun');
      expect(line).not.toContain('--version-number');
    }
  }
});

const ENV = () => ({ FOREMAN_SF_HOME: sfHome, FOREMAN_STATE_DIR: state });

function pkg(types) {
  const file = path.join(dir, 'package.xml');
  fs.writeFileSync(file, xml(types));
  return file;
}

// The check's arguments: a ctx whose delta manifest holds `types`, and the isolated sh. ctx.sh is
// the raw sh under it, as in sf-verify; it also answers git show for each agent's eval spec, and
// ctx.fetch answers the eval caller with every check passing.
function setup({ types = { AiAuthoringBundle: [API], ApexClass: ['AcmeOrderStatusAction'] }, rules = [] } = {}) {
  const raw = fakeSh([...rules, ...evalRules()]);
  seen.push(raw);
  const ctx = fakeCtx({ config: { pack: 'salesforce', salesforce: LAYOUT, slots: 1 }, root: '/acme/repo', env: ENV() });
  ctx.sh = raw;
  ctx.fetch = fakeFetch();
  ctx.sfDelta = { to: 'bbb', manifest: types ? pkg(types) : undefined };
  const sh = isolatedSh(raw, ENV(), sfHome, os.homedir());
  return { ctx, raw, run: () => agentforceCheck.run({ ctx, sh, stage: STAGE }) };
}
const sfLines = (raw) => raw.calls.filter((l) => l.startsWith('sf '));

const happyRules = (over = []) => [
  ...over,
  [/^sf agent validate authoring-bundle /, sfOk({ success: true })],
  [/^sf agent publish authoring-bundle /, sfOk({ success: true })],
  [/^sf agent activate /, sfOk({ success: true, version: 2 })],
  [/^sf data query --query SELECT VersionNumber, Status FROM BotVersion/, inTurn(versions([[1, 'Active']]), versions([[1, 'Active'], [2, 'Inactive']]), versions([[1, 'Inactive'], [2, 'Active']]))],
];

describe('the manifest readers', () => {
  it('agentBundles and evalDefinitions give the sorted, unique members, and [] for a missing file', () => {
    const file = pkg({ AiAuthoringBundle: ['Acme_Zeta', 'Acme_Alpha', 'Acme_Zeta'], AiEvaluationDefinition: ['Acme_Tests_B', 'Acme_Tests_A'], ApexClass: ['AcmeNew'] });
    expect(agentBundles(file)).toEqual(['Acme_Alpha', 'Acme_Zeta']);
    expect(evalDefinitions(file)).toEqual(['Acme_Tests_A', 'Acme_Tests_B']);
    expect(agentBundles(path.join(dir, 'missing.xml'))).toEqual([]);
    expect(evalDefinitions(path.join(dir, 'missing.xml'))).toEqual([]);
    expect(agentBundles(undefined)).toEqual([]);
  });

  it('AGENT_API_NAME accepts an agent API name and nothing that could break the SOQL', () => {
    expect(AGENT_API_NAME.test('Acme_Order_Helper')).toBe(true);
    for (const bad of ["x' OR Id != '", '1Acme', '', 'Acme Order', `A${'b'.repeat(80)}`]) expect(AGENT_API_NAME.test(bad), bad).toBe(false);
  });

  it('versionsQuery reads the BotVersions of the agent', () => {
    expect(versionsQuery(API)).toBe("SELECT VersionNumber, Status FROM BotVersion WHERE BotDefinition.DeveloperName = 'Acme_Order_Helper'");
  });

  it('versionsQuery and plannerQuery refuse a name that is not an agent API name', () => {
    for (const bad of ["x' OR Id != '", '1Acme', '', undefined, 42]) {
      expect(() => versionsQuery(bad), String(bad)).toThrow(/not an agent API name/);
      expect(() => plannerQuery(bad, 2), String(bad)).toThrow(/not an agent API name/);
    }
    expect(() => plannerQuery(API, '2')).toThrow();
    expect(() => plannerQuery(API, 1.5)).toThrow();
    expect(plannerQuery(API, 2)).toBe("SELECT Id FROM GenAiPlannerDefinition WHERE DeveloperName = 'Acme_Order_Helper_v2'");
  });
});

describe('agentforceCheck', () => {
  it('is named agentforce and applies unless salesforce.agentforce is off', () => {
    expect(agentforceCheck.name).toBe('agentforce');
    expect(agentforceCheck.applies({ salesforce: { agentforce: 'off' } })).toBe(false);
    expect(agentforceCheck.applies({ salesforce: { agentforce: 'auto' } })).toBe(true);
    expect(agentforceCheck.applies({ salesforce: {} })).toBe(true);
    expect(agentforceCheck.applies({})).toBe(true);
    expect(agentforceCheck.applies(undefined)).toBe(true);
  });

  it('passes with no sf call when the manifest has no agent bundle, or there is no manifest', async () => {
    const a = setup({ types: { ApexClass: ['AcmeNew'] } });
    expect(await a.run()).toEqual({ ok: true });
    expect(sfLines(a.raw)).toEqual([]);
    const b = setup({ types: null });
    expect(await b.run()).toEqual({ ok: true });
    expect(sfLines(b.raw)).toEqual([]);
  });

  it('validates, publishes without a retrieve, records the versions, activates and checks the new version', async () => {
    const { ctx, raw, run } = setup({ rules: happyRules() });
    const r = await run();
    expect(r).toEqual({ ok: true, changedOrg: true, agents: [{ apiName: API, previous: 1, version: 2 }] });
    expect(sfLines(raw)).toEqual([validateLine(), queryLine(), publishLine(), queryLine(), activateLine(), queryLine(), displayLine, plannerLine()]);
    expect(raw.limits[raw.calls.indexOf(publishLine())]).toBe(600000);
    for (let i = 0; i < raw.calls.length; i += 1) if (raw.calls[i].startsWith('sf ')) expect(raw.opts[i].env.HOME).toBe(sfHome);
    expect(readRelease(state, 'S-1').agents).toEqual([{ stage: 'qa', org: 'acme-qa', apiName: API, previous: 1, version: 2, at: ctx.now().toISOString() }]);
  });

  it('records the versions before it activates, so a failed activate can be rolled back', async () => {
    const { raw, run } = setup({ rules: happyRules([[/^sf agent activate /, sfError('ActivateError', 'Acme activation broke')]]) });
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain(API);
    expect(r.reason).toContain('version 2');
    expect(r.reason).toContain('Acme activation broke');
    expect(sfLines(raw).at(-1)).toBe(activateLine());
    expect(readRelease(state, 'S-1').agents).toMatchObject([{ stage: 'qa', org: 'acme-qa', apiName: API, previous: 1, version: 2 }]);
  });

  it('gives a new agent previous null', async () => {
    const rules = happyRules([[/FROM BotVersion/, inTurn(versions([]), versions([[1, 'Inactive']]), versions([[1, 'Active']]))]]);
    const { raw, run } = setup({ rules });
    expect(await run()).toEqual({ ok: true, changedOrg: true, agents: [{ apiName: API, previous: null, version: 1 }] });
    expect(sfLines(raw)).toContain(activateLine(API, 1));
    expect(readRelease(state, 'S-1').agents[0]).toMatchObject({ previous: null, version: 1 });
  });

  it('stops before any publish when validation fails, with sf\'s message only', async () => {
    const { raw, run } = setup({ rules: happyRules([[/^sf agent validate /, sfError('ValidationError', 'Acme agent script has 2 errors')]]) });
    const r = await run();
    expect(r).toEqual({ ok: false, reason: 'could not validate agent Acme_Order_Helper in acme-qa (qa): Acme agent script has 2 errors' });
    expect(sfLines(raw).some((l) => l.includes('agent publish'))).toBe(false);
    expect(r.reason).not.toContain('Did you mean');
    expect(r.reason).not.toContain('stack');
  });

  it('fails with no activate when the publish made no new version', async () => {
    const rules = happyRules([[/FROM BotVersion/, versions([[1, 'Active']])]]);
    const { raw, run } = setup({ rules });
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('made no new version');
    expect(r.reason).toContain(API);
    expect(sfLines(raw).some((l) => l.includes('agent activate'))).toBe(false);
  });

  it('fails when the publish fails, with no activate', async () => {
    const { raw, run } = setup({ rules: happyRules([[/^sf agent publish /, sfError('PublishError', 'Acme publish broke')]]) });
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('Acme publish broke');
    expect(sfLines(raw).some((l) => l.includes('agent activate'))).toBe(false);
  });

  it('fails when the version is not active after the activate', async () => {
    const rules = happyRules([[/FROM BotVersion/, inTurn(versions([[1, 'Active']]), versions([[1, 'Active'], [2, 'Inactive']]))]]);
    const r = await setup({ rules }).run();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('is not active');
    expect(r.reason).toContain('Acme_Order_Helper version 2');
  });

  it('fails when the versions cannot be read, with sf\'s message only', async () => {
    const r = await setup({ rules: happyRules([[/FROM BotVersion/, sfError('NoAuthInfoFound', 'No authorization information found for acme-qa.')]]) }).run();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('No authorization information found for acme-qa.');
    expect(r.reason).not.toContain('Did you mean');
  });

  it('refuses a bundle name that is not an agent API name, with no sf call', async () => {
    const { raw, run } = setup({ types: { AiAuthoringBundle: [API, '1Acme'] }, rules: happyRules() });
    expect(await run()).toEqual({ ok: false, reason: 'AiAuthoringBundle 1Acme is not an agent API name' });
    expect(sfLines(raw)).toEqual([]);
  });

  describe('says the org changed when it fails after a publish', () => {
    it('when the activate fails', async () => {
      const r = await setup({ rules: happyRules([[/^sf agent activate /, sfError('ActivateError', 'Acme activation broke')]]) }).run();
      expect(r).toMatchObject({ ok: false, changedOrg: true });
    });

    it('when the publish made no new version', async () => {
      const r = await setup({ rules: happyRules([[/FROM BotVersion/, versions([[1, 'Active']])]]) }).run();
      expect(r).toMatchObject({ ok: false, changedOrg: true });
      expect(r.reason).toContain('made no new version');
    });

    it('when the versions cannot be read after the publish, or the version is not active', async () => {
      const unread = await setup({ rules: happyRules([[/FROM BotVersion/, inTurn(versions([[1, 'Active']]), sfError('SfError', 'Acme query broke'))]]) }).run();
      expect(unread).toMatchObject({ ok: false, changedOrg: true });
      expect(unread.reason).toContain('Acme query broke');
      const inactive = await setup({ rules: happyRules([[/FROM BotVersion/, inTurn(versions([[1, 'Active']]), versions([[1, 'Active'], [2, 'Inactive']]))]]) }).run();
      expect(inactive).toMatchObject({ ok: false, changedOrg: true });
      expect(inactive.reason).toContain('is not active');
    });

    it("when a second bundle's publish fails after the first succeeded", async () => {
      const answers = {
        [API]: inTurn(versions([[1, 'Active']])),
        [OTHER]: inTurn(versions([[3, 'Active']]), versions([[3, 'Active'], [4, 'Inactive']]), versions([[3, 'Inactive'], [4, 'Active']])),
      };
      const rules = happyRules([
        [`sf agent publish authoring-bundle --api-name ${API} --target-org acme-qa --skip-retrieve --json`, sfError('PublishError', 'Acme publish broke')],
        [/FROM BotVersion/, (line) => answers[line.includes(API) ? API : OTHER]()],
      ]);
      const { raw, run } = setup({ types: { AiAuthoringBundle: [API, OTHER] }, rules });
      const r = await run();
      expect(r).toMatchObject({ ok: false, changedOrg: true });
      expect(r.reason).toContain('Acme publish broke');
      expect(sfLines(raw)).toContain(activateLine(OTHER, 4));
      expect(sfLines(raw).at(-1)).toBe(publishLine(API));
    });

    it('when a routing case fails again on the re-run', async () => {
      const { ctx, run } = setup({ rules: happyRules() });
      ctx.fetch = fakeFetch({ evals: (call) => failing(call.body, { 'order-status': ['routing_1'] }) });
      const r = await run();
      expect(r).toMatchObject({ ok: false, changedOrg: true });
      expect(r.reason).toContain('routing failed in case order-status');
      expect(ctx.fetch.posts()).toHaveLength(2);
    });

    it('when the agent session cannot be opened', async () => {
      const raw = [[/^sf org display /, sfError('NoAuthInfoFound', 'No authorization information found for acme-qa.')], ...happyRules()];
      const r = await setup({ rules: raw }).run();
      expect(r).toMatchObject({ ok: false, changedOrg: true });
      expect(r.reason).toContain('could not test the agents');
    });
  });

  it('has no changedOrg when it fails before any publish', async () => {
    const validation = await setup({ rules: happyRules([[/^sf agent validate /, sfError('ValidationError', 'Acme agent script has 2 errors')]]) }).run();
    const publish = await setup({ rules: happyRules([[/^sf agent publish /, sfError('PublishError', 'Acme publish broke')]]) }).run();
    const badName = await setup({ types: { AiAuthoringBundle: [API, '1Acme'] }, rules: happyRules() }).run();
    writeAgentforceSwitch(state, { reason: 'acme-qa (stage qa) has no Data Cloud licence', at: '2026-10-15T11:00:00.000Z' });
    const off = await setup({ rules: happyRules() }).run();
    for (const [what, r] of Object.entries({ validation, publish, badName, off })) {
      expect(r.ok, what).toBe(false);
      expect(r, what).not.toHaveProperty('changedOrg');
    }
  });

  it('validates every bundle first, then publishes and activates each in order', async () => {
    const answers = {
      [API]: inTurn(versions([[1, 'Active']]), versions([[1, 'Active'], [2, 'Inactive']]), versions([[1, 'Inactive'], [2, 'Active']])),
      [OTHER]: inTurn(versions([[3, 'Active']]), versions([[3, 'Active'], [4, 'Inactive']]), versions([[3, 'Inactive'], [4, 'Active']])),
    };
    const rules = happyRules([[/FROM BotVersion/, (line) => answers[line.includes(API) ? API : OTHER]()]]);
    const { raw, run } = setup({ types: { AiAuthoringBundle: [API, OTHER] }, rules });
    const r = await run();
    expect(r).toEqual({ ok: true, changedOrg: true, agents: [{ apiName: OTHER, previous: 3, version: 4 }, { apiName: API, previous: 1, version: 2 }] });
    expect(sfLines(raw)).toEqual([
      validateLine(OTHER),
      validateLine(API),
      queryLine(OTHER),
      publishLine(OTHER),
      queryLine(OTHER),
      activateLine(OTHER, 4),
      queryLine(OTHER),
      queryLine(API),
      publishLine(API),
      queryLine(API),
      activateLine(API, 2),
      queryLine(API),
      displayLine,
      plannerLine(OTHER, 4),
      plannerLine(API, 2),
    ]);
    expect(readRelease(state, 'S-1').agents.map((a) => a.apiName)).toEqual([OTHER, API]);
  });
});

describe('the Agentforce switch', () => {
  const OFF = { off: true, reason: 'acme-qa (stage qa) has no Data Cloud licence', at: '2026-10-15T11:00:00.000Z' };

  it('is null with no file or a broken one, and writing null deletes the file', () => {
    expect(readAgentforceSwitch(state)).toBeNull();
    const file = path.join(state, AGENTFORCE_FILE);
    expect(file).toBe(path.join(state, 'salesforce', 'agentforce.json'));
    writeAgentforceSwitch(state, OFF);
    expect(readAgentforceSwitch(state)).toEqual(OFF);
    for (const broken of ['{not json', '[]', '{"off":false,"reason":"x"}', '{"off":true}']) {
      fs.writeFileSync(file, broken);
      expect(readAgentforceSwitch(state), broken).toBeNull();
    }
    writeAgentforceSwitch(state, OFF);
    writeAgentforceSwitch(state, null);
    expect(fs.existsSync(file)).toBe(false);
    expect(() => writeAgentforceSwitch(state, null)).not.toThrow();
  });

  it('refuses agent bundles with the reason and no sf call while it is off', async () => {
    writeAgentforceSwitch(state, OFF);
    const { raw, ctx, run } = setup({ rules: happyRules() });
    expect(await run()).toEqual({ ok: false, reason: 'Agentforce is off: acme-qa (stage qa) has no Data Cloud licence' });
    expect(sfLines(raw)).toEqual([]);
    expect(ctx.fetch.calls).toEqual([]);
  });

  it('still passes a story with no agent bundle while it is off', async () => {
    writeAgentforceSwitch(state, OFF);
    const { raw, run } = setup({ types: { ApexClass: ['AcmeNew'] } });
    expect(await run()).toEqual({ ok: true });
    expect(raw.calls).toEqual([]);
  });
});

describe('restoreAgents', () => {
  const restore = (rules, agents = [{ apiName: API, previous: 1, version: 2 }]) => {
    const raw = fakeSh(rules);
    seen.push(raw);
    const sh = isolatedSh(raw, ENV(), sfHome, os.homedir());
    return { raw, r: restoreAgents(sh, { org: 'acme-qa', agents }) };
  };
  const agentLines = (raw) => sfLines(raw).filter((l) => l.startsWith('sf agent '));

  it('reactivates the previous version when another is active', () => {
    const { raw, r } = restore([[/FROM BotVersion/, versions([[1, 'Inactive'], [2, 'Active']])], [/^sf agent activate /, sfOk({ success: true })]]);
    expect(r).toEqual({ ok: true, restored: [{ apiName: API, version: 1 }] });
    expect(sfLines(raw)).toEqual([queryLine(), activateLine(API, 1)]);
    for (const o of raw.opts) expect(o.env.HOME).toBe(sfHome);
  });

  it('runs no activate when the previous version is already active', () => {
    const { raw, r } = restore([[/FROM BotVersion/, versions([[1, 'Active'], [2, 'Inactive']])]]);
    expect(r).toEqual({ ok: true, restored: [{ apiName: API, version: 1 }] });
    expect(agentLines(raw)).toEqual([]);
  });

  it('deactivates a new agent that is active', () => {
    const { raw, r } = restore([[/FROM BotVersion/, versions([[1, 'Active']])], [/^sf agent deactivate /, sfOk({ success: true })]], [{ apiName: API, previous: null, version: 1 }]);
    expect(r).toEqual({ ok: true, restored: [{ apiName: API, version: null }] });
    expect(agentLines(raw)).toEqual([deactivateLine()]);
  });

  it('does nothing for a new agent with no version active', () => {
    const { raw, r } = restore([[/FROM BotVersion/, versions([[1, 'Inactive']])]], [{ apiName: API, previous: null, version: 1 }]);
    expect(r).toEqual({ ok: true, restored: [{ apiName: API, version: null }] });
    expect(agentLines(raw)).toEqual([]);
  });

  it('gives the command to run by hand when the activate fails, with sf\'s message only', () => {
    const { r } = restore([[/FROM BotVersion/, versions([[2, 'Active']])], [/^sf agent activate /, sfError('ActivateError', 'Acme activation broke')]]);
    expect(r).toMatchObject({ ok: false, apiName: API, command: 'sf agent activate --api-name Acme_Order_Helper --version 1 --target-org acme-qa' });
    expect(r.reason).toContain('Acme activation broke');
    expect(r.reason).not.toContain('Did you mean');
    expect(r.reason).not.toContain('stack');
  });

  it('gives the command to run by hand when the versions cannot be read', () => {
    const { raw, r } = restore([[/FROM BotVersion/, sfError('SfError', 'Acme query broke')]], [{ apiName: API, previous: null, version: 1 }]);
    expect(r).toMatchObject({ ok: false, apiName: API, command: 'sf agent deactivate --api-name Acme_Order_Helper --target-org acme-qa' });
    expect(r.reason).toContain('Acme query broke');
    expect(agentLines(raw)).toEqual([]);
  });

  it('refuses a recorded name that is not an agent API name, with no sf call', () => {
    const { raw, r } = restore([], [{ apiName: "x' OR Id != '", previous: 1, version: 2 }]);
    expect(r.ok).toBe(false);
    expect(sfLines(raw)).toEqual([]);
  });

  it('fails with the Setup command for a previous that is not an integer or null, with no sf call', () => {
    for (const previous of ['1', 1.5, undefined, {}]) {
      const { raw, r } = restore([], [{ apiName: API, previous, version: 2 }]);
      expect(r, String(previous)).toEqual({ ok: false, apiName: API, command: 'none: restore the agent in Setup', reason: expect.stringContaining(API) });
      expect(sfLines(raw)).toEqual([]);
    }
  });

  it('restores the agents before a bad entry, then stops', () => {
    const { raw, r } = restore([[/FROM BotVersion/, versions([[3, 'Active']])]], [{ apiName: OTHER, previous: 3, version: 4 }, { apiName: API, previous: '1', version: 2 }]);
    expect(r.ok).toBe(false);
    expect(r.apiName).toBe(API);
    expect(sfLines(raw)).toEqual([queryLine(OTHER)]);
    expect(agentLines(raw).some((l) => l.includes(API))).toBe(false);
  });

  it('restores nothing for no agents', () => {
    const { raw, r } = restore([], []);
    expect(r).toEqual({ ok: true, restored: [] });
    expect(raw.calls).toEqual([]);
  });
});
