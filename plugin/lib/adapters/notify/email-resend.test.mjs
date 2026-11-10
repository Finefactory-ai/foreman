import { describe, expect, it } from 'vitest';
import { notifierContract } from './contract.mjs';
import { create } from './email-resend.mjs';

const KEY = 're_secret_key_123';
const mail = { kind: 'stopped', subject: 'Factory stopped', text: 'text body', html: '<p>html</p>' };

function setup(env = {}, options = {}, project = { name: 'Acme' }) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200 };
  };
  const notifier = create({ adapter: 'email-resend', ...options }, { env, fetch, project, gitEmail: () => 'git@example.com' });
  return { notifier, calls };
}
const FULL = { RESEND_API_KEY: KEY, RESEND_FROM_EMAIL: 'from@example.com', FOREMAN_NOTIFY_EMAIL: 'me@example.com' };

notifierContract({ name: 'email-resend', make: () => setup(FULL).notifier });
notifierContract({ name: 'email-resend (not configured)', make: () => setup({}).notifier });

describe('email-resend notifier', () => {
  it('posts once to Resend with the default [project factory] prefix', async () => {
    const { notifier, calls } = setup(FULL);
    const r = await notifier.send(mail);
    expect(r).toEqual({ sent: true, to: 'me@example.com' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.resend.com/emails');
    const body = JSON.parse(calls[0].init.body);
    expect(body).toEqual({ from: 'from@example.com', to: ['me@example.com'], subject: '[Acme factory] Factory stopped', html: '<p>html</p>', text: 'text body' });
    expect(calls[0].init.headers.authorization).toBe(`Bearer ${KEY}`);
  });
  it('subjectPrefix overrides the prefix', async () => {
    const { notifier, calls } = setup(FULL, { subjectPrefix: '[Mine]' });
    await notifier.send(mail);
    expect(JSON.parse(calls[0].init.body).subject).toBe('[Mine] Factory stopped');
  });
  it('takes to and from from options before the environment', async () => {
    const { notifier, calls } = setup(FULL, { to: 'opt@example.com', from: 'opt-from@example.com' });
    await notifier.send(mail);
    const body = JSON.parse(calls[0].init.body);
    expect(body.to).toEqual(['opt@example.com']);
    expect(body.from).toBe('opt-from@example.com');
  });
  it('falls back from FOREMAN_NOTIFY_EMAIL to FACTORY_NOTIFY_EMAIL to git user.email', async () => {
    const base = { RESEND_API_KEY: KEY, RESEND_FROM_EMAIL: 'f@example.com' };
    expect((await setup({ ...base, FACTORY_NOTIFY_EMAIL: 'old@example.com' }).notifier.send(mail)).to).toBe('old@example.com');
    expect((await setup(base).notifier.send(mail)).to).toBe('git@example.com');
  });
  it('never puts the key in the result, even when Resend fails', async () => {
    const calls = [];
    const fetch = async () => {
      calls.push(1);
      return { ok: false, status: 401 };
    };
    const n = create({ adapter: 'email-resend' }, { env: FULL, fetch, project: { name: 'P' } });
    const r = await n.send(mail);
    expect(r.sent).toBe(false);
    expect(r.reason).toContain('401');
    expect(JSON.stringify(r)).not.toContain(KEY);
  });
  it('a network failure is a not-sent result', async () => {
    const n = create({ adapter: 'email-resend' }, { env: FULL, fetch: async () => { throw new Error('boom'); }, project: { name: 'P' } });
    expect((await n.send(mail)).sent).toBe(false);
  });
  it('names what is missing and does not call Resend', async () => {
    const { notifier, calls } = setup({ RESEND_FROM_EMAIL: 'f@example.com' }, {});
    const gitless = create({ adapter: 'email-resend' }, { env: { RESEND_FROM_EMAIL: 'f@example.com' }, fetch: async () => { calls.push(1); }, gitEmail: () => '', project: { name: 'P' } });
    const r = await gitless.send(mail);
    expect(r.sent).toBe(false);
    expect(r.reason).toContain('needs RESEND_API_KEY, RESEND_FROM_EMAIL and a recipient');
    expect(r.reason).toContain('missing: RESEND_API_KEY, a recipient');
    expect(calls).toHaveLength(0);
    expect((await notifier.send(mail)).reason).toContain('missing: RESEND_API_KEY');
  });
  it("carries Resend's own name and message on a refusal, never the key", async () => {
    const fetch = async () => ({
      ok: false,
      status: 403,
      json: async () => ({ name: 'validation_error', message: 'The `acme.test` domain is not verified. Please, add and verify your domain.' }),
    });
    const r = await create({ adapter: 'email-resend' }, { env: FULL, fetch, project: { name: 'Acme' } }).send(mail);
    expect(r).toMatchObject({ sent: false, status: 403, code: 'validation_error' });
    expect(r.reason).toContain('403');
    expect(r.reason).toContain('not verified');
    expect(JSON.stringify(r)).not.toContain(KEY);
  });
  it('a refusal with no body to read is still a not-sent result with its status', async () => {
    const r = await create({ adapter: 'email-resend' }, { env: FULL, fetch: async () => ({ ok: false, status: 401 }), project: { name: 'Acme' } }).send(mail);
    expect(r.sent).toBe(false);
    expect(r.status).toBe(401);
    expect(r.reason).toBe('Resend answered 401');
  });
  it('a body that is not JSON keeps the plain reason', async () => {
    const fetch = async () => ({ ok: false, status: 500, json: async () => { throw new SyntaxError('bad json'); } });
    const r = await create({ adapter: 'email-resend' }, { env: FULL, fetch, project: { name: 'Acme' } }).send(mail);
    expect(r).toMatchObject({ sent: false, status: 500, reason: 'Resend answered 500' });
  });
  it('no answer at all has no status', async () => {
    const r = await create({ adapter: 'email-resend' }, { env: FULL, fetch: async () => null, project: { name: 'Acme' } }).send(mail);
    expect(r.sent).toBe(false);
    expect(r.reason).toBe('Resend answered nothing');
    expect(r.status).toBeUndefined();
  });
  it('lists the missing names', async () => {
    const n = create({ adapter: 'email-resend' }, { env: { RESEND_FROM_EMAIL: 'f@acme.test' }, fetch: async () => ({ ok: true }), gitEmail: () => '', project: { name: 'Acme' } });
    expect((await n.send(mail)).missing).toEqual(['RESEND_API_KEY', 'a recipient']);
  });
  it('gives up after a time limit', async () => {
    const { notifier, calls } = setup(FULL);
    await notifier.send(mail);
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });
  it('refuses unknown options', () => {
    expect(() => create({ adapter: 'email-resend', bcc: 'x' }, {})).toThrow(/bcc/);
  });
});
