import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as stepsModule from './steps.mjs';
import { AREAS, DOCS_URL, OFF_WORDS, STEPS, offAreas, serializeStep, stepById } from './steps.mjs';
import { stepForKey } from './keys.mjs';
import { resolveStep } from './status.mjs';
import { buildChecks } from '../engine/doctor-checks.mjs';
import { loadResolved } from '../settings/load.mjs';
import { SCOPES } from '../jira/auth.mjs';
import { PROJECT_FORM } from './project.mjs';
import { ERRORS as SF_ERRORS } from './salesforce.mjs';
import { SIGNIN } from './claude.mjs';
import { JIRA_SCREEN } from './jira-screen.mjs';
import { NOTIFY_SCREEN } from './notify-screen.mjs';
import { SF_SCREEN } from './salesforce-screen.mjs';
import { GEARSET_SCREEN } from './gearset-screen.mjs';
import { CLOUD_SCREEN } from './cloud-screen.mjs';
import { doctorChecks } from '../../packs/salesforce/doctor-salesforce.mjs';

// Acme configs, each written as foreman.config.json and loaded as the doctor loads it, so the
// pack's defaults apply.
const MARKDOWN = { version: 1, project: { name: 'Acme' }, notify: { adapter: 'email-resend' } };
const JIRA = { version: 1, project: { name: 'Acme' }, stories: { adapter: 'jira', site: 'acme.atlassian.net', jql: 'project = ACME AND labels = foreman ORDER BY Rank' } };
const salesforce = (release) => ({
  version: 1,
  project: { name: 'Acme' },
  pack: 'salesforce',
  salesforce: {
    productionBranch: 'main',
    orgs: { 'acme-dev1': { orgId: '00D000000000001AAA' }, 'acme-qa': { orgId: '00D000000000002AAA' } },
    build: ['acme-dev1'],
    stages: [{ name: 'qa', org: 'acme-qa', branch: 'qa' }],
    release,
  },
});

function load(file) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-steps-'));
  fs.writeFileSync(path.join(root, 'foreman.config.json'), JSON.stringify(file));
  const { config, errors } = loadResolved(root, { env: { FOREMAN_STATE_DIR: path.join(root, '.foreman') } });
  expect(errors ?? []).toEqual([]);
  expect(config).toBeTruthy();
  return { root, config };
}

function fakeCtx(root) {
  return { root, env: {}, sh: () => ({ status: 0, stdout: '', stderr: '' }), fs, sourceRoot: root, pluginsDir: root, now: () => new Date('2026-10-24T09:00:00Z') };
}

const CONFIGS = {
  markdown: () => load(MARKDOWN),
  jira: () => load(JIRA),
  salesforce: () => load(salesforce('gearset')),
};

const ids = STEPS.map((s) => s.id);
const SF = ['sf-tools', 'sf-layout', 'sf-orgs', 'sf-skills', 'sf-gearset'];
const JIRA_STEPS = ['jira-site', 'jira-app', 'jira-signin'];
const ALWAYS = ['project', 'claude-code', 'claude-signin', 'github', 'tools', 'project-keys', 'notifications', 'cloud-runner'];

const inputsOf = (step, config) => (typeof step.inputs === 'function' ? step.inputs(config) : step.inputs);
const guideText = (step) => step.guide.map((g) => `${g.text} ${(g.click ?? []).join(' ')}`).join('\n');

describe('the set-up steps', () => {
  it('have unique ids, and each a title, why, hint, area and the Test it action', () => {
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['project', 'claude-code', 'claude-signin', 'github', 'tools', 'project-keys', 'jira-app', 'jira-signin', 'jira-site', 'notifications', 'sf-tools', 'sf-layout', 'sf-orgs', 'sf-skills', 'sf-gearset', 'cloud-runner']);
    for (const step of STEPS) {
      for (const key of ['title', 'why', 'hint', 'area']) expect(typeof step[key] === 'string' && step[key].length > 0, `${step.id} ${key}`).toBe(true);
      expect(step.actions, step.id).toContainEqual({ id: 'check', label: 'Test it' });
      expect(Array.isArray(step.checks), step.id).toBe(true);
      expect(Array.isArray(step.guide), step.id).toBe(true);
      expect(stepById(step.id)).toBe(step);
    }
    expect(stepById('nope')).toBeUndefined();
  });

  it.each(Object.keys(CONFIGS))('names only checks the doctor has, on the %s config', (kind) => {
    const { root, config } = CONFIGS[kind]();
    const names = buildChecks(config, fakeCtx(root)).map((c) => c.name);
    for (const step of STEPS) {
      if (!step.applies(config)) continue;
      for (const name of step.checks) expect(names, `${step.id}: ${name}`).toContain(name);
    }
  });

  it.each(Object.keys(CONFIGS))('ties every doctor check to a known step, on the %s config', (kind) => {
    const { root, config } = CONFIGS[kind]();
    for (const check of buildChecks(config, fakeCtx(root))) {
      expect(stepById(check.step), `${check.name}: ${check.step}`).toBeDefined();
    }
  });

  it('applies each step to the right configs', () => {
    const applies = (config) => Object.fromEntries(STEPS.map((s) => [s.id, s.applies(config)]));
    const md = applies(CONFIGS.markdown().config);
    for (const id of [...JIRA_STEPS, ...SF]) expect(md[id], id).toBe(false);
    const jira = applies(CONFIGS.jira().config);
    for (const id of JIRA_STEPS) expect(jira[id], id).toBe(true);
    for (const id of SF) expect(jira[id], id).toBe(false);
    const sf = applies(CONFIGS.salesforce().config);
    for (const id of ['sf-tools', 'sf-layout', 'sf-orgs', 'sf-skills', 'sf-gearset']) expect(sf[id], id).toBe(true);
    for (const id of JIRA_STEPS) expect(sf[id], id).toBe(false);
    expect(applies(load(salesforce('sf')).config)['sf-gearset']).toBe(false);
    for (const all of [md, jira, sf]) for (const id of ALWAYS) expect(all[id], id).toBe(true);
  });

  it('gives each key input to the step that owns the key', () => {
    for (const kind of Object.keys(CONFIGS)) {
      const { config } = CONFIGS[kind]();
      for (const step of STEPS) {
        for (const input of inputsOf(step, config)) {
          if (input.kind === 'key') expect(stepForKey(input.name), `${kind} ${step.id} ${input.name}`).toBe(step.id);
        }
      }
    }
  });

  it.each(Object.keys(CONFIGS))('ends the project keys with the dashboard token, optional, on the %s config', (kind) => {
    const { config } = CONFIGS[kind]();
    const inputs = inputsOf(stepById('project-keys'), config);
    expect(inputs.at(-1)).toMatchObject({ kind: 'key', name: 'FOREMAN_DASHBOARD_TOKEN', required: false });
    expect(inputs.filter((i) => i.name === 'FOREMAN_DASHBOARD_TOKEN')).toHaveLength(1);
  });

  it('walks through the Jira app with every scope and the callback', () => {
    const text = guideText(stepById('jira-app'));
    for (const scope of SCOPES) expect(text).toContain(scope);
    expect(text).toContain('http://localhost:8765/callback');
    expect(text).toContain('JIRA_CLIENT_ID');
    expect(text).toContain('JIRA_CLIENT_SECRET');
  });

  it("gives the org sign-in into Foreman's own sf home", () => {
    const step = stepById('sf-orgs');
    const text = guideText(step);
    for (const s of ['sf org login jwt --alias', 'FOREMAN_SF_HOME', 'SF_USE_GENERIC_UNIX_KEYCHAIN=true', 'https://test.salesforce.com']) expect(text).toContain(s);
    const jwt = step.guide.find((g) => g.text.includes('sf org login jwt --alias'));
    expect(jwt.id).toBe('connect');
    for (const s of ['FOREMAN_SF_HOME', 'SF_USE_GENERIC_UNIX_KEYCHAIN=true', 'https://test.salesforce.com']) expect(jwt.text).toContain(s);
    expect(text).toMatch(/FOREMAN_SF_HOME must be an absolute path/);
  });

  it('gives the org sign-in guide ids, unique and in order, and the key and connect actions', () => {
    const step = stepById('sf-orgs');
    const guideIds = step.guide.map((g) => g.id);
    expect(guideIds).toEqual(['certificate', 'app', 'oauth', 'policies', 'consumer-key', 'connect', 'source-tracking', 'sf-home']);
    expect(new Set(guideIds).size).toBe(guideIds.length);
    expect(step.actions).toEqual([{ id: 'check', label: 'Test it' }, { id: 'sf-key', label: 'Make the key' }, { id: 'sf-connect', label: 'Connect an org' }]);
    expect(step.inputs).toEqual([]);
    expect(step.checks).toEqual(['salesforce sf isolation']);
  });

  it("walks through the External Client App with a click path for each Setup step", () => {
    const step = stepById('sf-orgs');
    const entry = (id) => step.guide.find((g) => g.id === id);
    for (const id of ['app', 'oauth', 'policies', 'consumer-key', 'source-tracking']) {
      const click = entry(id).click;
      expect(Array.isArray(click) && click.length > 0, id).toBe(true);
      for (const label of click) expect(typeof label === 'string' && label.length > 0, `${id} ${label}`).toBe(true);
    }
    expect(entry('app').click.slice(0, 4)).toEqual(['Setup', 'Apps', 'External Client Apps', 'External Client App Manager']);
    const oauth = entry('oauth').text;
    for (const s of ['JWT Bearer Flow', '(api)', 'refresh_token', 'http://localhost:1717/OauthRedirect']) expect(oauth).toContain(s);
    expect(entry('policies').text).toContain('Admin approved users are pre-authorized');
    expect(entry('consumer-key').text).toMatch(/Consumer Key/);
    expect(entry('source-tracking').click).toEqual(['Setup', 'Dev Hub', 'Enable Source Tracking in Developer and Developer Pro Sandboxes']);
    expect(entry('source-tracking').text).toMatch(/production/);
  });

  it('carries SF_SCREEN, which goes out with the serialized step', () => {
    const step = stepById('sf-orgs');
    expect(step.salesforce).toBe(SF_SCREEN);
    const { config } = CONFIGS.salesforce();
    expect(serializeStep(resolveStep(step, { config, envNames: [] })).salesforce).toEqual(SF_SCREEN);
    for (const other of STEPS) if (other.id !== 'sf-orgs') expect(Object.hasOwn(other, 'salesforce'), other.id).toBe(false);
  });

  it("names a real doctor check of sf-orgs in every guide entry's check", () => {
    const { root, config } = load(salesforce('sf'));
    expect(config.salesforce.build).toEqual(['acme-dev1']);
    const checks = doctorChecks(config, { sh: () => ({}), env: {}, root });
    const withCheck = STEPS.flatMap((step) => step.guide.filter((g) => g.check !== undefined).map((g) => ({ step, g })));
    expect(withCheck.map(({ g }) => g.id)).toEqual(['source-tracking']);
    for (const { step, g } of withCheck) {
      expect(typeof g.check === 'string' && g.check.length > 0, g.id).toBe(true);
      const found = checks.filter((c) => c.name === g.check || c.name.startsWith(`${g.check} `));
      expect(found.length, g.check).toBeGreaterThan(0);
      for (const c of found) expect(c.step, c.name).toBe(step.id);
    }
    expect(checks.some((c) => c.name.startsWith('salesforce source tracking ') && c.step === 'sf-orgs')).toBe(true);
  });

  it('points every Salesforce connect error at a guide id of sf-orgs, or at a step', () => {
    const guideIds = new Set(stepById('sf-orgs').guide.map((g) => g.id));
    for (const [code, entry] of Object.entries(SF_ERRORS)) {
      if (entry.guide === undefined || entry.guide === null) continue;
      expect(guideIds.has(entry.guide) || stepById(entry.guide) !== undefined, `${code}: ${entry.guide}`).toBe(true);
    }
    expect(SF_ERRORS['not-approved'].guide).toBe('policies');
    expect(SF_ERRORS['no-sf'].guide).toBe('sf-tools');
    expect(SF_ERRORS.assertion.guide).toBe('oauth');
  });

  it('validates each input: a good Acme sample passes, an empty value does not', () => {
    const SAMPLES = {
      RESEND_API_KEY: 're_acme123',
      RESEND_FROM_EMAIL: 'bot@acme.test',
      FOREMAN_NOTIFY_EMAIL: 'owner@acme.test',
      ANTHROPIC_API_KEY: 'sk-ant-acme123',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-acme',
      JIRA_CLIENT_ID: 'acme-client-id',
      JIRA_CLIENT_SECRET: 'acme-client-secret',
      GEARSET_API_TOKEN: 'acme-gearset-token',
      FOREMAN_DASHBOARD_TOKEN: 'acme-dashboard-token-0123456789abcdef',
      SUPABASE_ACCESS_TOKEN: 'sbp_acme',
      SUPABASE_DB_PASSWORD: 'acme-db-password',
      'project.name': 'Acme',
      'stories.site': 'acme.atlassian.net',
      'stories.jql': 'project = ACME',
      'notify.adapter': 'email-resend',
    };
    const supabase = { ...MARKDOWN, ship: { steps: ['merge-main', 'migrate-supabase', 'push'] } };
    const configs = [...Object.values(CONFIGS).map((c) => c().config), load(supabase).config];
    let checked = 0;
    for (const config of configs) {
      for (const step of STEPS) {
        for (const input of inputsOf(step, config)) {
          if (!input.validate) continue;
          const key = input.configPath ?? input.name;
          expect(Object.hasOwn(SAMPLES, key), `a sample for ${key}`).toBe(true);
          expect(input.validate(SAMPLES[key]), key).toBeNull();
          expect(typeof input.validate(''), key).toBe('string');
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(8);
    const steps = Object.fromEntries(STEPS.map((s) => [s.id, s]));
    const input = (id, name, config = {}) => inputsOf(steps[id], config).find((i) => i.name === name);
    expect(input('notifications', 'RESEND_API_KEY').validate('acme-key')).toMatch(/re_/);
    expect(input('claude-signin', 'ANTHROPIC_API_KEY').validate('acme-key')).toMatch(/sk-ant-/);
    expect(input('claude-signin', 'CLAUDE_CODE_OAUTH_TOKEN').validate('sk-ant-api03-acme')).toBe('This looks like a Console API key (sk-ant-api…); put it under Console API key.');
    expect(input('notifications', 'RESEND_FROM_EMAIL').validate('acme')).toBeTypeOf('string');
    expect(input('jira-site', 'stories.site').validate('https://acme.atlassian.net')).toBeTypeOf('string');
    expect(input('jira-app', 'JIRA_CLIENT_ID').validate('has space')).toBeTypeOf('string');
  });

  it('points at the user guide on finefactory.ai', () => {
    expect(DOCS_URL).toBe('https://finefactory.ai/apps/foreman/docs/');
    expect(Object.fromEntries(STEPS.map((s) => [s.id, s.more]))).toEqual({
      project: DOCS_URL + 'set-up-tab/',
      'claude-code': DOCS_URL + '#install',
      'claude-signin': DOCS_URL + '#install',
      github: DOCS_URL + '#release-safety',
      tools: DOCS_URL + 'set-up-tab/',
      'project-keys': DOCS_URL + 'set-up-tab/',
      'jira-app': DOCS_URL + '#signing-in-to-jira',
      'jira-signin': DOCS_URL + '#signing-in-to-jira',
      'jira-site': DOCS_URL + '#stories-from-jira',
      notifications: DOCS_URL + '#set-up',
      'sf-tools': DOCS_URL + 'salesforce-set-up/',
      'sf-layout': DOCS_URL + 'salesforce-set-up/',
      'sf-orgs': null,
      'sf-skills': DOCS_URL + 'salesforce-set-up/',
      'sf-gearset': null,
      'cloud-runner': DOCS_URL + '#run-in-the-cloud',
    });
    for (const step of STEPS) {
      if (step.more === null) continue;
      expect(step.more.startsWith(DOCS_URL), step.id).toBe(true);
      expect(new URL(step.more).protocol, step.id).toBe('https:');
    }
    for (const id of ['tools', 'project-keys', 'project', 'sf-tools', 'sf-layout', 'sf-skills']) expect(stepById(id).more, id).not.toBeNull();
  });

  it('serializes a resolved step to plain JSON, with no functions', () => {
    for (const kind of Object.keys(CONFIGS)) {
      const { config } = CONFIGS[kind]();
      for (const step of STEPS) {
        const out = serializeStep(resolveStep(step, { config, envNames: [] }));
        expect(JSON.parse(JSON.stringify(out)), step.id).toEqual(out);
        const walk = (v) => {
          expect(typeof v).not.toBe('function');
          if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
        };
        walk(out);
        expect(out.id).toBe(step.id);
        expect(typeof out.applies).toBe('boolean');
      }
    }
  });
});

describe('the validators', () => {
  const inputOf = (id, name) => stepById(id).inputs.find((i) => i.name === name);

  it('caps each value before any regex, and checks emails in linear time', () => {
    const email = inputOf('notifications', 'RESEND_FROM_EMAIL').validate;
    const long = `${'a'.repeat(311)}@acme.test`;
    expect(long).toHaveLength(321);
    expect(email(long)).toMatch(/too long/);
    expect(email(`${'a'.repeat(310)}@acme.test`)).toBeNull();
    const hostile = `a@${'.'.repeat(50000)}@`;
    const started = performance.now();
    const said = email(hostile);
    expect(performance.now() - started).toBeLessThan(50);
    expect(typeof said).toBe('string');
    expect(email('bot@acme.test')).toBeNull();
    expect(email('first.last@mail.acme.co.uk')).toBeNull();
    for (const bad of ['a@b', 'a@.acme', 'a@acme.', 'a b@acme.test', 'a@acme..test']) expect(typeof email(bad), bad).toBe('string');
    const clientId = inputOf('jira-app', 'JIRA_CLIENT_ID').validate;
    expect(clientId('x'.repeat(4097))).toMatch(/too long/);
    expect(clientId('x'.repeat(4096))).toBeNull();
  });
});

describe("the project step's form", () => {
  it('is on the project step only', () => {
    expect(stepById('project').form).toBe(PROJECT_FORM);
    for (const step of STEPS) if (step.id !== 'project') expect(Object.hasOwn(step, 'form'), step.id).toBe(false);
  });

  it('is plain data, deep-frozen, with no functions', () => {
    const walk = (v, at) => {
      expect(typeof v, at).not.toBe('function');
      if (v && typeof v === 'object') {
        expect(Object.isFrozen(v), at).toBe(true);
        for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`);
      }
    };
    walk(PROJECT_FORM, 'form');
    expect(JSON.parse(JSON.stringify(PROJECT_FORM))).toEqual(PROJECT_FORM);
  });

  it('has the fields name, source, dir, site, jql, check and ci', () => {
    expect(PROJECT_FORM.fields.map((f) => f.id)).toEqual(['name', 'source', 'dir', 'site', 'jql', 'check', 'ci']);
  });

  it('goes out with the serialized step', () => {
    const out = serializeStep(resolveStep(stepById('project'), { config: null, envNames: [] }));
    expect(out.form).toEqual(PROJECT_FORM);
  });
});

describe('the Claude sign-in step', () => {
  it('takes the Console API key and the subscription token, both optional', () => {
    const inputs = stepById('claude-signin').inputs;
    expect(inputs.map(({ kind, name, required }) => ({ kind, name, required }))).toEqual([
      { kind: 'key', name: 'ANTHROPIC_API_KEY', required: false },
      { kind: 'key', name: 'CLAUDE_CODE_OAUTH_TOKEN', required: false },
    ]);
    for (const input of inputs) expect(typeof input.validate, input.name).toBe('function');
  });

  it("carries the sign-in screen's data, which goes out with the serialized step", () => {
    expect(stepById('claude-signin').signin).toBe(SIGNIN);
    const out = serializeStep(resolveStep(stepById('claude-signin'), { config: null, envNames: [] }));
    expect(out.signin).toEqual(SIGNIN);
  });

  it('is the only step with sign-in data', () => {
    for (const step of STEPS) if (step.id !== 'claude-signin') expect(Object.hasOwn(step, 'signin'), step.id).toBe(false);
  });
});

describe('the Jira screens', () => {
  it('run in order: the app keys, the sign-in, then the site and filter', () => {
    const at = (id) => ids.indexOf(id);
    expect(at('jira-app')).toBeLessThan(at('jira-signin'));
    expect(at('jira-signin')).toBeLessThan(at('jira-site'));
  });

  it("carry each screen's data, which goes out with the serialized step", () => {
    const PARTS = { 'jira-app': JIRA_SCREEN.app, 'jira-signin': JIRA_SCREEN.signin, 'jira-site': JIRA_SCREEN.filter };
    const { config } = CONFIGS.jira();
    for (const [id, part] of Object.entries(PARTS)) {
      expect(stepById(id).jira, id).toBe(part);
      const out = serializeStep(resolveStep(stepById(id), { config, envNames: [] }));
      expect(out.jira, id).toEqual(part);
    }
    expect(stepById('jira-app').jira.part).toBe('app');
    expect(stepById('jira-signin').jira.part).toBe('signin');
    expect(stepById('jira-site').jira.part).toBe('filter');
  });

  it('are the only steps with Jira screen data', () => {
    for (const step of STEPS) if (!JIRA_STEPS.includes(step.id)) expect(Object.hasOwn(step, 'jira'), step.id).toBe(false);
  });
});

describe('the notifications screen', () => {
  it("carries NOTIFY_SCREEN, which goes out with the serialized step", () => {
    const step = stepById('notifications');
    expect(step.notify).toBe(NOTIFY_SCREEN);
    const { config } = CONFIGS.markdown();
    expect(serializeStep(resolveStep(step, { config, envNames: [] })).notify).toEqual(NOTIFY_SCREEN);
  });

  it('takes the recipient as an optional key after the sender, checked as an email address', () => {
    const names = stepById('notifications').inputs.map((i) => i.name);
    expect(names.indexOf('FOREMAN_NOTIFY_EMAIL')).toBe(names.indexOf('RESEND_FROM_EMAIL') + 1);
    const to = stepById('notifications').inputs.find((i) => i.name === 'FOREMAN_NOTIFY_EMAIL');
    expect(to).toMatchObject({ kind: 'key', required: false });
    expect(to.validate('acme')).toBeTypeOf('string');
    expect(to.validate('owner@acme.test')).toBeNull();
  });

  it('is the only step with notify screen data', () => {
    for (const step of STEPS) if (step.id !== 'notifications') expect(Object.hasOwn(step, 'notify'), step.id).toBe(false);
  });
});

describe('the Gearset screen', () => {
  const step = stepById('sf-gearset');

  it('carries GEARSET_SCREEN, which goes out with the serialized step', () => {
    expect(step.gearset).toBe(GEARSET_SCREEN);
    expect(step.gearset.part).toBe('gearset');
    expect(Object.isFrozen(step.gearset)).toBe(true);
    const { config } = CONFIGS.salesforce();
    expect(serializeStep(resolveStep(step, { config, envNames: [] })).gearset).toEqual(GEARSET_SCREEN);
    for (const other of STEPS) if (other.id !== 'sf-gearset') expect(Object.hasOwn(other, 'gearset'), other.id).toBe(false);
  });

  it('keeps the token key and adds the optional pipeline ID from the config', () => {
    expect(step.inputs[0]).toMatchObject({ kind: 'key', name: 'GEARSET_API_TOKEN' });
    expect(step.inputs).toContainEqual({ kind: 'config', name: 'salesforce.gearset.pipelineId', configPath: 'salesforce.gearset.pipelineId', required: false });
    const { config } = CONFIGS.salesforce();
    const resolved = resolveStep(step, { config, envNames: ['GEARSET_API_TOKEN'] });
    expect(resolved.inputs.find((i) => i.name === 'salesforce.gearset.pipelineId')).toMatchObject({ required: false, present: false });
  });

  it("runs the CI job check with the others", () => {
    expect(step.checks).toEqual(['salesforce gearset token', 'salesforce gearset branch', 'salesforce gearset merge method', 'salesforce gearset environments', 'salesforce gearset ci job']);
  });

  it('guides the pipeline, the CI job and the test level, keeping the token and environment entries', () => {
    const text = guideText(step);
    expect(step.guide[0].click).toEqual(['Gearset', 'My account', 'Team security', 'Access token management']);
    expect(text).toContain('Make each stage org the target of a Gearset environment that is not production.');
    expect(text).toMatch(/pipeline that promotes this repo/);
    const job = step.guide.find((g) => Array.isArray(g.click) && g.click.includes('Edit CI job'));
    expect(job.click).toEqual(['Gearset', 'Pipelines', '<pipeline>', '<environment>', 'Edit CI job']);
    expect(job.text).toMatch(/CI job/);
    expect(text).toMatch(/RunLocalTests/);
    expect(text).toMatch(/confirm it here/);
  });
});

describe('the set-up areas', () => {
  it('name every area a step is in, once each, frozen', () => {
    const areaIds = AREAS.map((a) => a.id);
    expect(areaIds).toEqual(['project', 'claude', 'github', 'stories', 'notify', 'salesforce', 'cloud']);
    expect(new Set(areaIds).size).toBe(areaIds.length);
    for (const step of STEPS) expect(areaIds, step.id).toContain(step.area);
    expect(Object.isFrozen(AREAS)).toBe(true);
    for (const area of AREAS) {
      expect(Object.isFrozen(area), area.id).toBe(true);
      expect(typeof area.title === 'string' && area.title.length > 0, area.id).toBe(true);
    }
  });
});

describe('the README address', () => {
  it('is gone: the steps point at the guide that ships with the plugin', () => {
    expect('readmeUrl' in stepsModule).toBe(false);
  });
});

describe('the cloud runner screen', () => {
  const step = stepById('cloud-runner');

  it('is the last step, in the last area, Running in the cloud', () => {
    expect(STEPS.at(-1)).toBe(step);
    expect(AREAS.at(-1)).toEqual({ id: 'cloud', title: 'Running in the cloud' });
    expect(step.area).toBe('cloud');
    expect(step.title).toBe('Cloud runner');
    expect(step.hint).toBe('set the runner up on this screen');
    expect(step.why).toMatch(/laptop/);
    expect(step.checks).toEqual([]);
    expect(step.inputs).toEqual([]);
    expect(step.actions).toEqual([{ id: 'check', label: 'Test it' }, { id: 'cloud-secrets', label: 'Set the secrets' }, { id: 'cloud-runner-file', label: 'Write the runner file' }]);
  });

  it('carries CLOUD_SCREEN, which goes out with the serialized step, and is the only step with cloud data', () => {
    expect(step.cloud).toBe(CLOUD_SCREEN);
    expect(step.cloud.part).toBe('cloud');
    const { config } = CONFIGS.markdown();
    expect(serializeStep(resolveStep(step, { config, envNames: [] })).cloud).toEqual(CLOUD_SCREEN);
    for (const other of STEPS) if (other.id !== 'cloud-runner') expect(Object.hasOwn(other, 'cloud'), other.id).toBe(false);
  });

  it('applies and is optional on every config, with none too', () => {
    for (const kind of Object.keys(CONFIGS)) {
      const { config } = CONFIGS[kind]();
      expect(step.applies(config), kind).toBe(true);
      expect(step.optional(config), kind).toBe(true);
    }
    expect(step.applies(null)).toBe(true);
    expect(step.optional(null)).toBe(true);
  });

  it("has unique guide ids that cover CLOUD_SCREEN's per-mode lists", () => {
    const guideIds = step.guide.map((g) => g.id);
    expect(guideIds).toEqual(['state-branch', 'workflow', 'token', 'secrets', 'runner-file', 'docker-run']);
    expect(new Set(guideIds).size).toBe(guideIds.length);
    for (const mode of CLOUD_SCREEN.modes) for (const id of CLOUD_SCREEN.guides[mode.value]) expect(guideIds, `${mode.value} ${id}`).toContain(id);
    expect(step.guide.find((g) => g.id === 'token').click).toEqual(['GitHub', 'Settings', 'Developer settings', 'Personal access tokens']);
    for (const g of step.guide) expect(typeof g.text === 'string' && g.text.length > 0, g.id).toBe(true);
  });
});

describe('offAreas: the areas that are off, and how to turn each on', () => {
  const ids = (list) => list.map((e) => e.id);

  it('says Jira is off on a markdown project, with Turn on pointing at the story source', () => {
    expect(offAreas(CONFIGS.markdown().config, { sfdx: false })).toEqual([
      {
        id: 'jira',
        area: 'stories',
        title: 'Jira',
        line: 'Jira: off, because stories come from markdown files.',
        turnOn: { label: 'Turn on', step: 'project', choice: { field: 'source', value: 'jira' } },
      },
    ]);
    expect(OFF_WORDS.turnOn).toBe('Turn on');
  });

  it('has no Jira entry on a Jira project', () => {
    expect(ids(offAreas(CONFIGS.jira().config, { sfdx: false }))).not.toContain('jira');
  });

  it('offers the Salesforce pack only on a project with sfdx-project.json', () => {
    const md = CONFIGS.markdown().config;
    expect(ids(offAreas(md, { sfdx: false }))).not.toContain('salesforce');
    const sf = offAreas(md, { sfdx: true }).find((e) => e.id === 'salesforce');
    expect(sf).toEqual({
      id: 'salesforce',
      area: 'salesforce',
      title: 'Salesforce',
      line: 'Salesforce: off, because the Salesforce pack is not on for this project.',
      turnOn: { label: 'Turn on', step: 'project', choice: { field: 'pack', value: 'salesforce' } },
    });
  });

  it('says Gearset is off when the pack releases another way, pointing at the environments step', () => {
    const list = offAreas(load(salesforce('sf')).config, { sfdx: true });
    expect(ids(list)).not.toContain('salesforce');
    expect(list.find((e) => e.id === 'gearset')).toEqual({
      id: 'gearset',
      area: 'salesforce',
      title: 'Gearset',
      line: 'Gearset: off, because releases go through the Salesforce CLI.',
      turnOn: { label: 'Turn on', step: 'sf-layout' },
    });
    expect(offAreas(load(salesforce('ci')).config, { sfdx: true }).find((e) => e.id === 'gearset').line).toBe('Gearset: off, because releases go through your CI.');
    expect(ids(offAreas(CONFIGS.salesforce().config, { sfdx: true }))).not.toContain('gearset');
  });

  it('is empty with no config', () => {
    expect(offAreas(null, { sfdx: true })).toEqual([]);
  });

  it('points every Turn on at a real step, and gives sf-layout the Gearset guide entry', () => {
    for (const e of offAreas(CONFIGS.markdown().config, { sfdx: true })) expect(stepById(e.turnOn.step), e.id).toBeDefined();
    const release = stepById('sf-layout').guide.find((g) => g.id === 'release');
    expect(release.text).toBe(
      'To release through Gearset, set salesforce.release to "gearset", give the last stage a sandbox and a branch of its own, and set salesforce.productionBranch. The Gearset step then appears.',
    );
    expect(stepById('sf-layout').guide).toHaveLength(3);
  });
});
