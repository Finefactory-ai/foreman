// The notifications set-up API: POST /api/setup/notify/test and POST /api/setup/notify/save,
// plus the notifications step's notify and notifyConfig in GET /api/setup. The fake Resend is the
// injected keyFetch. No key value ever comes back out.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardServer } from './server.mjs';
import { loadConfig } from '../config/load.mjs';
import { SETUP_FIRST } from '../setup/steps.mjs';
import { NOTIFY_SCREEN } from '../setup/notify-screen.mjs';
import { COMMIT_REMINDER } from '../settings/change.mjs';

const TOKEN = 'acme-dashboard-token-0123456789abcdef';
const NOW = '2026-10-24T09:00:00.000Z';
const W = NOTIFY_SCREEN.results;
const secret = (kind) => `re_acme_${kind}_${randomBytes(12).toString('hex')}`;
const FULL = secret('full');
const SENDONLY = secret('sendonly');
const INACTIVE = secret('inactive');
const WRONG = secret('wrong');
const ENV_KEY = secret('full');
const ALL_KEYS = [FULL, SENDONLY, INACTIVE, WRONG, ENV_KEY];

let dir;
let servers;
let seen; // the text of every response a test got
let resend;

const configFile = () => join(dir, 'foreman.config.json');
const savedConfig = () => JSON.parse(readFileSync(configFile(), 'utf8'));
const stateDir = () => join(dir, '.foreman');
const record = () => JSON.parse(readFileSync(join(stateDir(), 'setup.json'), 'utf8'));

function project(extra = { notify: { adapter: 'email-resend' } }) {
  writeFileSync(configFile(), `${JSON.stringify({ version: 1, project: { name: 'Acme' }, ...extra }, null, 2)}\n`);
  return loadConfig(dir).config;
}

function keys(values = { RESEND_API_KEY: FULL, RESEND_FROM_EMAIL: 'bot@acme.test', FOREMAN_NOTIFY_EMAIL: 'owner@acme.test' }) {
  const text = Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join('');
  writeFileSync(join(dir, '.env.foreman'), text, { mode: 0o600 });
}

// A fake Resend, answering by the key in Authorization and by the from address.
function fakeResend() {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const auth = String(init.headers?.authorization ?? '');
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    const reply = (status, json) => ({ ok: status >= 200 && status < 300, status, json: async () => json });
    if (auth.includes('re_acme_wrong_')) return reply(401, { name: 'validation_error', message: 'API key is invalid' });
    if (auth.includes('re_acme_inactive_')) return reply(403, { name: 'restricted_api_key', message: 'API key is not active' });
    if (auth.includes('re_acme_sendonly_') && !String(url).endsWith('/emails')) {
      return reply(401, { name: 'restricted_api_key', message: 'This API key is restricted to only send emails' });
    }
    if (body.from === 'bot@unverified.test') {
      return reply(403, { name: 'validation_error', message: 'The unverified.test domain is not verified. Please, add and verify your domain on https://resend.com/domains' });
    }
    if (body.from === 'bot@echo.test') return reply(500, { name: 'internal_server_error', message: `could not use ${auth.replace(/^Bearer /, '')}` });
    return reply(200, { id: 'acme-email-1' });
  };
  return { calls, fetch, sent: () => calls.filter((c) => c.url === 'https://api.resend.com/emails' && c.init.method === 'POST') };
}

async function start({ host = '127.0.0.1', env = {}, config = loadConfig(dir).config, now = () => new Date(NOW), ...rest } = {}) {
  const cfg = config ? { ...config, console: { ...config.console, host } } : null;
  const server = createDashboardServer({
    root: dir,
    config: cfg,
    host,
    env,
    now,
    keyFetch: resend.fetch,
    gitEmail: () => '',
    doctor: () => Promise.resolve({ config: cfg, ctx: {}, checks: [] }),
    ...rest,
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, host, resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, server };
}

async function call(url, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  seen += text;
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, body: json };
}
const post = (url, body = {}, headers) => call(url, { method: 'POST', body, headers });
const sendTest = (base, headers) => post(`${base}/api/setup/notify/test`, {}, headers);

// A request whose path and headers go out exactly as written.
function raw(base, path, { method = 'GET', headers = {}, body } = {}) {
  const { port } = new URL(base);
  const sent = body === undefined ? {} : { 'content-length': Buffer.byteLength(body) };
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers: { ...sent, ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        seen += text;
        resolve({ status: res.statusCode, headers: res.headers, body: text });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const outbox = () => {
  try {
    return readdirSync(join(stateDir(), 'outbox')).filter((f) => f.endsWith('-test.json'));
  } catch {
    return [];
  }
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foreman-setup-notify-'));
  servers = [];
  seen = '';
  resend = fakeResend();
  spawnSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, '.gitignore'), '.env.foreman\n.foreman/\n');
});
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((resolve) => (s.listening ? s.close(() => resolve()) : resolve()))));
  for (const k of ALL_KEYS) expect(seen).not.toContain(k);
  rmSync(dir, { recursive: true, force: true });
});

describe('POST /api/setup/notify/test', () => {
  it('sends one test email through Resend and records the confirmation', async () => {
    project();
    keys();
    const { base } = await start();
    const r = await sendTest(base);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, result: { sent: true, outbox: false, to: 'owner@acme.test' } });
    expect(r.body.result.detail).toBe(W.sent.replace('{to}', 'owner@acme.test'));
    expect(resend.calls).toHaveLength(1);
    expect(resend.sent()).toHaveLength(1);
    const body = JSON.parse(resend.calls[0].init.body);
    expect(body.from).toBe('bot@acme.test');
    expect(body.to).toEqual(['owner@acme.test']);
    expect(body.subject.startsWith('[Acme factory] Test email')).toBe(true);
    expect(record().steps.notifications.confirmedAt).toBe(NOW);
  });

  it('sends with a restricted send-only key', async () => {
    project();
    keys({ RESEND_API_KEY: SENDONLY, RESEND_FROM_EMAIL: 'bot@acme.test', FOREMAN_NOTIFY_EMAIL: 'owner@acme.test' });
    const { base } = await start();
    const r = await sendTest(base);
    expect(r.body.result).toMatchObject({ sent: true, to: 'owner@acme.test' });
  });

  it('an inactive key gives its words and confirms nothing', async () => {
    project();
    keys({ RESEND_API_KEY: INACTIVE, RESEND_FROM_EMAIL: 'bot@acme.test', FOREMAN_NOTIFY_EMAIL: 'owner@acme.test' });
    const { base } = await start();
    const r = await sendTest(base);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, result: { sent: false, outbox: false, detail: W.inactiveKey } });
    let confirmed = null;
    try {
      confirmed = record().steps.notifications?.confirmedAt ?? null;
    } catch {
      confirmed = null;
    }
    expect(confirmed).toBeNull();
  });

  it('a wrong key gives the badKey words', async () => {
    project();
    keys({ RESEND_API_KEY: WRONG, RESEND_FROM_EMAIL: 'bot@acme.test', FOREMAN_NOTIFY_EMAIL: 'owner@acme.test' });
    const { base } = await start();
    expect((await sendTest(base)).body.result.detail).toBe(W.badKey);
  });

  it('a sender on an unverified domain gives the unverified words', async () => {
    project();
    keys({ RESEND_API_KEY: FULL, RESEND_FROM_EMAIL: 'bot@unverified.test', FOREMAN_NOTIFY_EMAIL: 'owner@acme.test' });
    const { base } = await start();
    expect((await sendTest(base)).body.result.detail).toBe(W.unverified);
  });

  it('blanks the key when Resend repeats it', async () => {
    project();
    keys({ RESEND_API_KEY: FULL, RESEND_FROM_EMAIL: 'bot@echo.test', FOREMAN_NOTIFY_EMAIL: 'owner@acme.test' });
    const { base } = await start();
    const r = await sendTest(base);
    expect(r.body.result.detail.startsWith(W.other.split('{reason}')[0])).toBe(true);
    expect(r.body.result.detail).toContain('•••');
  });

  it('with notifications off, in the config or on this machine, writes to the outbox and asks Resend nothing', async () => {
    project({ notify: { adapter: 'email-resend' }, features: { notifications: false } });
    keys();
    let { base } = await start();
    let r = await sendTest(base);
    expect(r.body).toEqual({ ok: true, result: { sent: false, outbox: true, detail: W.outboxOff } });
    expect(resend.calls).toHaveLength(0);
    expect(outbox()).toHaveLength(1);

    rmSync(join(stateDir(), 'outbox'), { recursive: true, force: true });
    project();
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(join(stateDir(), 'settings.json'), JSON.stringify({ 'features.notifications': false }));
    ({ base } = await start());
    r = await sendTest(base);
    expect(r.body.result).toEqual({ sent: false, outbox: true, detail: W.outboxOff });
    expect(resend.calls).toHaveLength(0);
    expect(outbox()).toHaveLength(1);
  });

  it('with adapter none, writes to the outbox', async () => {
    project({ notify: { adapter: 'none' } });
    keys();
    const { base } = await start();
    const r = await sendTest(base);
    expect(r.body.result).toEqual({ sent: false, outbox: true, detail: W.outboxNone });
    expect(resend.calls).toHaveLength(0);
  });

  it('names a missing key, and asks Resend nothing', async () => {
    project();
    keys({ RESEND_FROM_EMAIL: 'bot@acme.test', FOREMAN_NOTIFY_EMAIL: 'owner@acme.test' });
    const { base } = await start();
    const r = await sendTest(base);
    expect(r.body.result.sent).toBe(false);
    expect(r.body.result.detail).toBe(W.missing.replace('{missing}', 'RESEND_API_KEY'));
    expect(resend.calls).toHaveLength(0);
  });

  it('takes the key from the environment before the file', async () => {
    project();
    keys();
    const { base } = await start({ env: { RESEND_API_KEY: ENV_KEY } });
    expect((await sendTest(base)).body.result.sent).toBe(true);
    expect(resend.calls[0].init.headers.authorization).toBe(`Bearer ${ENV_KEY}`);
  });

  it('allows 5 tries a minute, shared with the step check, then 429 with retry-after', async () => {
    project();
    keys();
    let clock = Date.parse(NOW);
    const { base } = await start({ now: () => new Date(clock) });
    for (let i = 0; i < 5; i += 1) {
      clock += 1000;
      expect((await sendTest(base)).status, `try ${i + 1}`).toBe(200);
    }
    clock += 1000;
    const sixth = await sendTest(base);
    expect(sixth.status).toBe(429);
    expect(sixth.body).toEqual({ error: 'Too many tries for this step. Try again in 55 seconds.', retryAfter: 55 });
    expect(sixth.headers.get('retry-after')).toBe('55');
    expect((await post(`${base}/api/setup/steps/notifications/check`, {})).status).toBe(429);
    expect(resend.calls).toHaveLength(5);
  });

  it('works only on a dashboard on this computer, behind the usual gates', async () => {
    project();
    keys();
    const remote = await start({ host: '0.0.0.0', env: { FOREMAN_DASHBOARD_TOKEN: TOKEN } });
    const refused = await sendTest(remote.base, { authorization: `Bearer ${TOKEN}` });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe(NOTIFY_SCREEN.localOnly);
    expect((await sendTest(remote.base)).status).toBe(401);

    const { base } = await start();
    const json = { 'content-type': 'application/json' };
    expect((await raw(base, '/api/setup/notify/test', { method: 'POST', headers: { ...json, origin: 'https://evil.example' }, body: '{}' })).status).toBe(403);
    expect((await raw(base, '/api/setup/notify/test', { method: 'POST', headers: { ...json, host: 'evil.example' }, body: '{}' })).status).toBe(403);
    const get = await raw(base, '/api/setup/notify/test');
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe('POST');
    expect(resend.calls).toHaveLength(0);
  });

  it('is a 409 in set-up mode', async () => {
    const { base } = await start({ config: null });
    const r = await sendTest(base);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe(SETUP_FIRST);
    expect(resend.calls).toHaveLength(0);
  });
});

describe('POST /api/setup/notify/save', () => {
  it('writes the choice to foreman.config.json and says to commit it', async () => {
    project({ notify: { adapter: 'email-resend', to: 'a@acme.test' } });
    const { base } = await start();
    const r = await post(`${base}/api/setup/notify/save`, { adapter: 'none' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, lines: ['set notify.adapter to none', COMMIT_REMINDER], notify: { adapter: 'none' } });
    expect(typeof r.body.configDirty).toBe('boolean');
    expect(savedConfig().notify).toEqual({ adapter: 'none' });
  });

  it('works on a dashboard other computers reach, with the token', async () => {
    project({ notify: { adapter: 'none' } });
    const { base } = await start({ host: '0.0.0.0', env: { FOREMAN_DASHBOARD_TOKEN: TOKEN } });
    const r = await post(`${base}/api/setup/notify/save`, { adapter: 'email-resend' }, { authorization: `Bearer ${TOKEN}` });
    expect(r.status).toBe(200);
    expect(savedConfig().notify).toEqual({ adapter: 'email-resend' });
    expect((await post(`${base}/api/setup/notify/save`, { adapter: 'none' })).status).toBe(401);
  });

  it('refuses another choice without repeating it', async () => {
    project();
    const { base } = await start();
    const r = await post(`${base}/api/setup/notify/save`, { adapter: 'bogus' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe(NOTIFY_SCREEN.badChoice);
    expect(r.text).not.toContain('bogus');
    expect(savedConfig().notify).toEqual({ adapter: 'email-resend' });
  });
});

describe('GET /api/setup', () => {
  it("gives the notifications step its screen's words, the config's choice and the three key rows", async () => {
    project();
    keys();
    const { base } = await start();
    const r = await call(`${base}/api/setup`);
    const step = r.body.steps.find((s) => s.id === 'notifications');
    expect(step.notify).toEqual(NOTIFY_SCREEN);
    expect(step.notifyConfig).toEqual({ adapter: 'email-resend', from: null, to: null, notifications: true });
    expect(step.keys.map((k) => k.name)).toEqual(['RESEND_API_KEY', 'RESEND_FROM_EMAIL', 'FOREMAN_NOTIFY_EMAIL']);
    for (const s of r.body.steps) if (s.id !== 'notifications') expect(Object.hasOwn(s, 'notifyConfig'), s.id).toBe(false);
  });
});
