import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { notifySetup, testResult } from './notify.mjs';
import { NOTIFY_SCREEN } from './notify-screen.mjs';
import { COMMIT_REMINDER } from '../settings/change.mjs';

const W = NOTIFY_SCREEN.results;
const KEY = 're_acme_secret_0123456789';
const NOW = new Date('2026-10-24T09:00:00.000Z');
const ON = { features: { notifications: true } };
const OFF = { features: { notifications: false } };

let root;
const file = () => join(root, 'foreman.config.json');
const saved = () => JSON.parse(readFileSync(file(), 'utf8'));
function project(extra = {}) {
  writeFileSync(file(), `${JSON.stringify({ version: 1, project: { name: 'Acme' }, ...extra }, null, 2)}\n`);
}
const setup = (over = {}) => notifySetup({ root, env: {}, now: () => NOW, gitEmail: () => '', ...over });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'foreman-notify-setup-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('testResult', () => {
  it('maps an outbox file to the outbox words: off in Settings, or set to no email', () => {
    expect(testResult({ sent: true, file: '/x/outbox/a-test.json' }, OFF)).toEqual({ sent: false, outbox: true, detail: W.outboxOff });
    expect(testResult({ sent: true, file: '/x/outbox/a-test.json' }, ON)).toEqual({ sent: false, outbox: true, detail: W.outboxNone });
  });

  it('says where a sent email went', () => {
    expect(testResult({ sent: true, to: 'owner@acme.test' }, ON)).toEqual({
      sent: true,
      outbox: false,
      to: 'owner@acme.test',
      detail: W.sent.replace('{to}', 'owner@acme.test'),
    });
  });

  it('names what is missing', () => {
    const r = testResult({ sent: false, reason: 'needs …', missing: ['RESEND_API_KEY', 'a recipient'] }, ON);
    expect(r).toEqual({ sent: false, outbox: false, detail: W.missing.replace('{missing}', 'RESEND_API_KEY and a recipient') });
  });

  it("maps each of Resend's refusals to its own words", () => {
    const cases = [
      [{ status: 401, code: 'validation_error', reason: 'Resend answered 401: API key is invalid' }, W.badKey],
      [{ status: 403, code: 'restricted_api_key', reason: 'Resend answered 403: API key is not active' }, W.inactiveKey],
      [{ status: 403, code: 'validation_error', reason: 'Resend answered 403: The acme.test domain is not verified.' }, W.unverified],
      [{ status: 403, code: 'validation_error', reason: 'Resend answered 403: You can only send testing emails to your own email address (owner@acme.test).' }, W.testingOnly],
      [{ status: 429, code: 'rate_limit_exceeded', reason: 'Resend answered 429' }, W.tooMany],
      [{ reason: 'Resend answered nothing' }, W.unreachable],
      [{ status: 500, code: 'internal_server_error', reason: 'Resend answered 500: boom' }, W.other.replace('{reason}', 'Resend answered 500: boom')],
    ];
    for (const [r, words] of cases) expect(testResult({ sent: false, ...r }, ON), String(r.status)).toEqual({ sent: false, outbox: false, detail: words });
  });

  it('never gives the key back, even when Resend repeats it', () => {
    const r = testResult({ sent: false, status: 500, reason: `Resend answered 500: bad key ${KEY}` }, ON, [KEY]);
    expect(r.detail).not.toContain(KEY);
    expect(r.detail).toContain('•••');
  });
});

describe('notifySetup().current', () => {
  it('reports the adapter, from, to and whether notifications are on', () => {
    project({ notify: { adapter: 'email-resend', from: 'bot@acme.test', to: 'owner@acme.test' } });
    expect(setup().current()).toEqual({ adapter: 'email-resend', from: 'bot@acme.test', to: 'owner@acme.test', notifications: true });
    project();
    expect(setup().current()).toEqual({ adapter: 'none', from: null, to: null, notifications: true });
  });

  it('counts features.notifications off from this machine’s local settings', () => {
    project({ notify: { adapter: 'email-resend' } });
    mkdirSync(join(root, '.foreman'), { recursive: true });
    writeFileSync(join(root, '.foreman', 'settings.json'), JSON.stringify({ 'features.notifications': false }));
    expect(setup().current()).toMatchObject({ adapter: 'email-resend', notifications: false });
  });

  it('is null with no config', () => {
    expect(setup().current()).toBeNull();
  });
});

describe('notifySetup().save', () => {
  it('switching to none writes the adapter alone, dropping the email options', () => {
    project({ notify: { adapter: 'email-resend', to: 'a@acme.test', from: 'b@acme.test' } });
    const r = setup().save({ adapter: 'none' });
    expect(saved().notify).toEqual({ adapter: 'none' });
    expect(r.ok).toBe(true);
    expect(r.lines).toEqual(['set notify.adapter to none', COMMIT_REMINDER]);
    expect(r.notify).toEqual({ adapter: 'none', from: null, to: null, notifications: true });
  });

  it('switching to email writes { adapter: email-resend }', () => {
    project({ notify: { adapter: 'none' } });
    const r = setup().save({ adapter: 'email-resend' });
    expect(saved().notify).toEqual({ adapter: 'email-resend' });
    expect(r.lines.at(-1)).toBe(COMMIT_REMINDER);
    project();
    setup().save({ adapter: 'email-resend' });
    expect(saved().notify).toEqual({ adapter: 'email-resend' });
  });

  it('the same adapter writes nothing', () => {
    project({ notify: { adapter: 'email-resend', to: 'a@acme.test' } });
    const before = readFileSync(file(), 'utf8');
    const r = setup().save({ adapter: 'email-resend' });
    expect(r.lines).toEqual([NOTIFY_SCREEN.nothingChanged]);
    expect(readFileSync(file(), 'utf8')).toBe(before);
    project();
    const plain = readFileSync(file(), 'utf8');
    expect(setup().save({ adapter: 'none' }).lines).toEqual([NOTIFY_SCREEN.nothingChanged]);
    expect(readFileSync(file(), 'utf8')).toBe(plain);
  });

  it('refuses anything but exactly { adapter: none | email-resend }, without repeating it', () => {
    project();
    const before = readFileSync(file(), 'utf8');
    for (const body of [{ adapter: 'x' }, { adapter: 'toString' }, { adapter: 3 }, { adapter: 'none', extra: 1 }, {}, null, ['none']]) {
      let err = null;
      try {
        setup().save(body);
      } catch (e) {
        err = e;
      }
      expect(err?.status, JSON.stringify(body)).toBe(400);
      expect(err.message).toBe(NOTIFY_SCREEN.badChoice);
      expect(err.message).not.toContain('toString');
    }
    expect(readFileSync(file(), 'utf8')).toBe(before);
  });

  it('is a 409 with no config file', () => {
    expect(() => setup().save({ adapter: 'none' })).toThrow(expect.objectContaining({ status: 409 }));
  });
});

describe('notifySetup().test', () => {
  it('goes through the notifier: with notifications off, only the outbox, and no fetch', async () => {
    project({ notify: { adapter: 'email-resend' }, features: { notifications: false } });
    const calls = [];
    const stateDir = join(root, '.foreman');
    const r = await setup({ fetch: async (...a) => { calls.push(a); return { ok: true }; } }).test({ stateDir, values: { RESEND_API_KEY: KEY } });
    expect(r).toEqual({ sent: false, outbox: true, detail: W.outboxOff });
    expect(calls).toEqual([]);
  });

  it('sends the test email through Resend with the project prefix', async () => {
    project({ notify: { adapter: 'email-resend' } });
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ id: 'acme-1' }) };
    };
    const values = { RESEND_API_KEY: KEY, RESEND_FROM_EMAIL: 'bot@acme.test', FOREMAN_NOTIFY_EMAIL: 'owner@acme.test' };
    const r = await setup({ fetch }).test({ stateDir: join(root, '.foreman'), values });
    expect(r).toMatchObject({ sent: true, outbox: false, to: 'owner@acme.test' });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].init.body).subject).toBe('[Acme factory] Test email');
  });

  it('a notify block the adapter refuses is the badBlock words', async () => {
    project({ notify: { adapter: 'none', to: 'a@acme.test' } });
    const r = await setup().test({ stateDir: join(root, '.foreman'), values: {} });
    expect(r.sent).toBe(false);
    expect(r.detail.startsWith(W.badBlock.split('{reason}')[0])).toBe(true);
    expect(r.detail).toContain('to');
  });

  it('is a 409 with no config', async () => {
    await expect(setup().test({ stateDir: join(root, '.foreman'), values: {} })).rejects.toMatchObject({ status: 409 });
  });
});
