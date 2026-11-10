import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CRASH_SHOWN, checksForStep, envNames, readCache, resolveStep, runChecks, shareable, stepStatus, writeCache } from './status.mjs';
import { stepById } from './steps.mjs';
import { withDefaults } from '../config/defaults.mjs';

const SECRET = 're_acme-very-secret-77';
const markdown = (over = {}) => withDefaults({ version: 1, project: { name: 'Acme' }, ...over });
const jira = () => markdown({ stories: { adapter: 'jira', site: 'acme.atlassian.net', jql: 'project = ACME' } });
const resend = (over = {}) => markdown({ notify: { adapter: 'email-resend', ...over } });

const resolved = (id, config, names = []) => resolveStep(stepById(id), { config, envNames: names });
const result = (name, step, over = {}) => ({ name, step, ok: false, level: 'error', detail: 'broken', ...over });
const passing = (name, step) => ({ name, step, ok: true, level: 'error', detail: '' });

describe('stepStatus', () => {
  it('is skipped for a step that does not apply', () => {
    for (const id of ['jira-site', 'jira-app', 'jira-signin']) {
      const step = resolved(id, markdown());
      expect(step.applies).toBe(false);
      expect(stepStatus(step, [result('jira app keys', 'jira-app')])).toBe('skipped');
    }
  });

  it('is optional for notifications with no adapter, or with none', () => {
    const none = markdown({ notify: { adapter: 'none' } });
    const absent = { ...markdown() };
    delete absent.notify;
    for (const config of [none, absent]) {
      const step = resolved('notifications', config);
      expect(step.optional).toBe(true);
      expect(stepStatus(step, [])).toBe('optional');
    }
  });

  it('is needs-you when a required key is missing, even while the env check fails against it', () => {
    const step = resolved('notifications', resend(), ['RESEND_FROM_EMAIL']);
    const env = result('env variables', 'project-keys', { fix: { step: 'notifications', hint: 'add RESEND_API_KEY to .env.local or the environment' } });
    expect(step.inputs.find((i) => i.name === 'RESEND_API_KEY')).toMatchObject({ required: true, present: false });
    expect(stepStatus(step, [env])).toBe('needs-you');
  });

  it('is broken when the inputs are there but an error-level check fails', () => {
    const step = resolved('jira-app', jira(), ['JIRA_CLIENT_ID', 'JIRA_CLIENT_SECRET']);
    expect(stepStatus(step, [result('jira app keys', 'jira-app')])).toBe('broken');
  });

  it('counts a failure against the step its fix names, not the step that ran it', () => {
    const env = result('env variables', 'project-keys', { fix: { step: 'notifications', hint: 'add it' } });
    const names = ['RESEND_API_KEY', 'RESEND_FROM_EMAIL'];
    expect(stepStatus(resolved('notifications', resend(), names), [env])).toBe('broken');
    const keys = resolved('project-keys', resend(), names);
    expect(stepStatus(keys, [env])).not.toBe('broken');
  });

  it('is done with only warnings, with an input that is not required, and with a passing check', () => {
    const github = resolved('github', markdown());
    expect(stepStatus(github, [result('branch protection', 'github', { level: 'warn', detail: 'branch protection is off' })])).toBe('done');
    const from = resolved('notifications', resend({ from: 'bot@acme.test' }), ['RESEND_API_KEY']);
    expect(from.inputs.find((i) => i.name === 'RESEND_FROM_EMAIL').required).toBe(false);
    expect(stepStatus(from, [])).toBe('done');
    expect(stepStatus(resolved('tools', markdown()), [passing('tools', 'tools')])).toBe('done');
  });
});

describe('resolveStep', () => {
  it('marks a config input absent when its value is undefined, empty text or an empty list', () => {
    const present = (config) => resolved('project', config).inputs.find((i) => i.configPath === 'project.name').present;
    expect(present(markdown())).toBe(true);
    expect(present({ ...markdown(), project: {} })).toBe(false);
    expect(present({ ...markdown(), project: { name: '' } })).toBe(false);
    expect(present({ ...markdown(), project: { name: [] } })).toBe(false);
    expect(present({ ...markdown(), project: { name: {} } })).toBe(false);
  });
});

describe('envNames', () => {
  it('reads the names from the env file and the environment, never a value', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-setup-env-'));
    fs.writeFileSync(path.join(root, '.env.local'), `RESEND_API_KEY=${SECRET}\nexport ACME_TOKEN="${SECRET}"\n`);
    const names = envNames({ root, config: markdown(), env: { RESEND_FROM_EMAIL: 'bot@acme.test', EMPTY: '' }, fs });
    expect(names).toEqual(expect.arrayContaining(['RESEND_API_KEY', 'ACME_TOKEN', 'RESEND_FROM_EMAIL']));
    expect(names).not.toContain('EMPTY');
    expect(JSON.stringify(names)).not.toContain(SECRET);
    expect(JSON.stringify(names)).not.toContain('bot@acme.test');
  });

  it("reads Foreman's own names from .env.foreman, and no other name there", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-setup-env-'));
    fs.writeFileSync(path.join(root, '.env.foreman'), `JIRA_CLIENT_ID=${SECRET}\nACME_DB_URL=${SECRET}\n`);
    const names = envNames({ root, config: markdown(), env: {}, fs });
    expect(names).toContain('JIRA_CLIENT_ID');
    expect(names).not.toContain('ACME_DB_URL');
    expect(JSON.stringify(names)).not.toContain(SECRET);
  });
});

describe('runChecks', () => {
  const now = () => new Date('2026-10-24T09:00:00Z');

  it('turns a throwing check into an error result with a fix', async () => {
    const [r] = await runChecks([{ name: 'acme', step: 'tools', run: () => { throw new Error('boom'); } }], {}, { now });
    expect(r).toMatchObject({ name: 'acme', step: 'tools', ok: false, level: 'error' });
    expect(r.detail).toBe('the check crashed: boom');
    expect(r.fix.step).toBe('tools');
    expect(r.fix.hint).toMatch(/foreman doctor/);
  });

  it('stamps each result with its name, step and checkedAt, and awaits async checks', async () => {
    const checks = [
      { name: 'a', step: 'github', run: () => ({ ok: true, level: 'error', detail: '' }) },
      { name: 'b', step: 'tools', run: async (ctx) => ({ ok: false, level: 'warn', detail: ctx.root }) },
    ];
    const out = await runChecks(checks, { root: '/acme' }, { now });
    expect(out).toEqual([
      { name: 'a', step: 'github', ok: true, level: 'error', detail: '', checkedAt: '2026-10-24T09:00:00.000Z' },
      { name: 'b', step: 'tools', ok: false, level: 'warn', detail: '/acme', checkedAt: '2026-10-24T09:00:00.000Z' },
    ]);
  });
});

describe('shareable', () => {
  const now = () => new Date('2026-10-24T09:00:00Z');

  it("swaps a crashed check's detail for a plain line, and leaves the rest and the input alone", async () => {
    const [r] = await runChecks([{ name: 'gh signed in', step: 'github', run: () => { throw new Error('spawn /home/acme/private/gh ENOENT'); } }], {}, { now });
    const before = structuredClone(r);
    const shown = shareable(r);
    expect(shown.detail).toBe(CRASH_SHOWN);
    expect(JSON.stringify(shown)).not.toContain('/home/acme');
    const { detail: _a, ...rest } = shown;
    const { detail: _b, ...restBefore } = before;
    expect(rest).toEqual(restBefore);
    expect(rest).toMatchObject({ name: 'gh signed in', step: 'github', ok: false, level: 'error', checkedAt: '2026-10-24T09:00:00.000Z' });
    expect(r).toEqual(before);
    expect(r.detail).toBe('the check crashed: spawn /home/acme/private/gh ENOENT');
  });

  it('swaps a crash already in the cache', () => {
    const cached = { name: 'acme', step: 'tools', ok: false, level: 'error', detail: 'the check crashed: EACCES /home/acme/x', fix: { step: 'tools', hint: 'again' }, checkedAt: '2026-10-24T09:00:00.000Z' };
    expect(shareable(cached)).toEqual({ ...cached, detail: CRASH_SHOWN });
    expect(cached.detail).toBe('the check crashed: EACCES /home/acme/x');
  });

  it('leaves a normal result as it is, and undefined as undefined', () => {
    const failing = { name: 'env variables', step: 'project-keys', ok: false, level: 'error', detail: 'RESEND_API_KEY is not set', fix: { step: 'notifications', hint: 'add it' }, checkedAt: '2026-10-24T09:00:00.000Z' };
    const passing = { name: 'config', step: 'project', ok: true, level: 'error', detail: '', checkedAt: '2026-10-24T09:00:00.000Z' };
    expect(shareable(failing)).toEqual(failing);
    expect(shareable(passing)).toEqual(passing);
    expect(shareable(undefined)).toBeUndefined();
  });
});

describe('checksForStep', () => {
  const check = (name, step) => ({ name, step, run: () => ({ ok: true, level: 'error', detail: '' }) });
  const checks = [check('own', 'notifications'), check('env variables', 'project-keys'), check('gh signed in', 'github'), check('jira signed in', 'jira-signin'), check('config', 'project')];
  const names = (list) => list.map((c) => c.name);

  it("gives the step's own checks plus any whose cached result counts against it through fix.step", () => {
    const cache = { 'env variables': result('env variables', 'project-keys', { fix: { step: 'notifications', hint: 'add RESEND_API_KEY' } }) };
    expect(names(checksForStep('notifications', checks, cache))).toEqual(['own', 'env variables']);
  });

  it('leaves out a check whose cached result is ok, or counts against another step', () => {
    const cache = {
      'env variables': { ...passing('env variables', 'project-keys'), fix: { step: 'notifications', hint: 'stale' } },
      'gh signed in': result('gh signed in', 'github', { fix: { step: 'github', hint: 'gh auth login' } }),
      'jira signed in': result('jira signed in', 'jira-signin', { fix: { step: 'jira-app', hint: 'add the keys' } }),
      config: passing('config', 'project'),
    };
    expect(names(checksForStep('notifications', checks, cache))).toEqual(['own']);
    expect(names(checksForStep('jira-app', checks, cache))).toEqual(['jira signed in']);
  });

  it('with an empty or missing cache gives only the step\'s own checks', () => {
    expect(names(checksForStep('notifications', checks, {}))).toEqual(['own']);
    expect(names(checksForStep('github', checks))).toEqual(['gh signed in']);
  });

  it('reads only the cache\'s own entries', () => {
    const cache = Object.create({ 'env variables': result('env variables', 'project-keys', { fix: { step: 'notifications' } }) });
    expect(names(checksForStep('notifications', checks, cache))).toEqual(['own']);
  });
});

describe('the check cache', () => {
  const dir = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-setup-cache-')), '.foreman');

  it('round-trips and merges by name', () => {
    const d = dir();
    expect(readCache(d)).toEqual({});
    writeCache(d, [passing('tools', 'tools'), result('gh signed in', 'github')]);
    writeCache(d, [{ ...passing('gh signed in', 'github'), checkedAt: 'later' }]);
    const cache = readCache(d);
    expect(Object.keys(cache).sort()).toEqual(['gh signed in', 'tools']);
    expect(cache['gh signed in']).toMatchObject({ ok: true, checkedAt: 'later' });
    const file = JSON.parse(fs.readFileSync(path.join(d, 'setup-checks.json'), 'utf8'));
    expect(file.version).toBe(1);
  });

  it('drops the results of checks not kept, and still writes the new ones', () => {
    const d = dir();
    writeCache(d, [passing('tools', 'tools'), result('acme retired check', 'github')]);
    writeCache(d, [passing('gh signed in', 'github')], { keep: ['tools', 'gh signed in'] });
    expect(Object.keys(readCache(d)).sort()).toEqual(['gh signed in', 'tools']);
  });

  it('writes the file with mode 600', () => {
    const d = dir();
    writeCache(d, [passing('tools', 'tools')]);
    expect(fs.statSync(path.join(d, 'setup-checks.json')).mode & 0o777).toBe(0o600);
  });

  it('reads a corrupt or odd file as empty', () => {
    const d = dir();
    fs.mkdirSync(d, { recursive: true });
    for (const text of ['{ nope', '[]', '{"version":1,"results":7}']) {
      fs.writeFileSync(path.join(d, 'setup-checks.json'), text);
      expect(readCache(d), text).toEqual({});
    }
  });
});
