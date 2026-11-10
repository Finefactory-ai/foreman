// The Salesforce set-up API: GET/POST /api/setup/salesforce/key, POST
// /api/setup/salesforce/connect and POST /api/setup/salesforce/org-id. No response ever carries
// the private key, the username or the client ID. Never the real sf, openssl, ~/.config or sf home.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardServer } from './server.mjs';
import { loadConfig } from '../config/load.mjs';
import { SETUP_FIRST } from '../setup/steps.mjs';
import { ERRORS, WORDS } from '../setup/salesforce.mjs';
import { SF_SCREEN } from '../setup/salesforce-screen.mjs';
import { keyPaths } from '../../packs/salesforce/setup.mjs';
import { ACME_DEV1_ID, ACME_QA_ID, fakeSfShell, orgRecord, orgRoute, sfError, sfOk } from '../../../test/fake-sf.mjs';
import { fakeOpenssl, makePair } from '../../../test/fake-openssl.mjs';

const TOKEN = 'acme-dashboard-token-0123456789abcdef';
const NOW = '2026-10-24T09:00:00.000Z';
const USER = 'admin@acme-dev1.acme.example';
const CLIENT_ID = '3MVG9AcmeConsumerKey0123456789';
const LOGIN = 'org login jwt';
const LOGOUT = 'org logout';
const FOUND_ID = '00D000000000042AAA';

let dir;
let homedir;
let sfHomeDir;
let servers;
let seen; // the text of every response a test got
let routes; // the fake sf's answers, changed by each test
let pair; // what the fake openssl makes
let uploaded; // a second pair, for uploads
let sh;

const configFile = () => join(dir, 'foreman.config.json');
const savedText = () => readFileSync(configFile(), 'utf8');
const saved = () => JSON.parse(savedText());

const SF_BLOCK = () => ({
  productionBranch: 'main',
  orgs: { 'acme-dev1': { orgId: ACME_DEV1_ID }, 'acme-qa': { orgId: ACME_QA_ID } },
  build: ['acme-dev1'],
  stages: [{ name: 'qa', org: 'acme-qa', branch: 'qa' }],
});

function project(file = { version: 1, project: { name: 'Acme' }, pack: 'salesforce', salesforce: SF_BLOCK() }) {
  writeFileSync(configFile(), `${JSON.stringify(file, null, 2)}\n`);
  const { config, errors } = loadConfig(dir);
  expect(errors ?? []).toEqual([]);
  return config;
}

const paths = () => keyPaths({ root: dir, config: loadConfig(dir).config, homedir });

async function start({ host = '127.0.0.1', env = {}, config = loadConfig(dir).config, now = () => new Date(NOW), ...rest } = {}) {
  const cfg = config ? { ...config, console: { ...config.console, host } } : null;
  const server = createDashboardServer({
    root: dir,
    config: cfg,
    host,
    env: { HOME: homedir, FOREMAN_SF_HOME: sfHomeDir, FOREMAN_STATE_DIR: join(dir, '.foreman'), ...env },
    now,
    setupSh: sh,
    homedir,
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

function raw(base, path, { method = 'GET', headers = {} } = {}) {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        seen += text;
        resolve({ status: res.statusCode, headers: res.headers, body: text });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const CONNECT = (over = {}) => ({ alias: 'acme-dev1', username: USER, clientId: CLIENT_ID, ...over });
const sfLines = () => sh.sfLines();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foreman-setup-sf-'));
  homedir = mkdtempSync(join(tmpdir(), 'foreman-setup-sf-home-'));
  sfHomeDir = join(homedir, 'sf-home');
  servers = [];
  seen = '';
  pair ??= makePair({ cn: 'Foreman acme' });
  uploaded ??= makePair({ cn: 'Acme upload' });
  routes = { [LOGIN]: sfOk({ username: USER, orgId: ACME_DEV1_ID }), [orgRoute('acme-dev1')]: orgRecord(ACME_DEV1_ID), [LOGOUT]: sfOk({}) };
  sh = fakeSfShell(routes, fakeOpenssl({ pair }));
});
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((resolve) => (s.listening ? s.close(() => resolve()) : resolve()))));
  // Nothing the responses held gives away the key, the username or the client ID.
  expect(seen).not.toContain('PRIVATE KEY');
  // The key's text also holds its public half, which the certificate rightly shows.
  for (const p of [pair, uploaded]) {
    const body = p.keyPem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    const certText = p.certPem.replace(/\s+/g, '');
    for (let i = 0; i + 24 <= body.length; i += 24) {
      const slice = body.slice(i, i + 24);
      if (!certText.includes(slice)) expect(seen).not.toContain(slice);
    }
  }
  expect(seen).not.toContain(USER);
  expect(seen).not.toContain(CLIENT_ID);
  rmSync(dir, { recursive: true, force: true });
  rmSync(homedir, { recursive: true, force: true });
});

describe('the key', () => {
  it('makes a key on request, and gives the certificate back', async () => {
    project();
    const { base } = await start();
    expect((await call(`${base}/api/setup/salesforce/key`)).body).toEqual({ status: 'none' });
    const made = await post(`${base}/api/setup/salesforce/key`, { generate: true });
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ status: 'ready', subject: 'CN=Foreman acme', expires: '2030-01-01T00:00:00.000Z', keyFile: paths().key });
    expect(made.body.certificate).toContain('-----BEGIN CERTIFICATE-----');
    expect(made.body.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    const again = await call(`${base}/api/setup/salesforce/key`);
    expect(again.body).toEqual(made.body);
    expect(paths().key.startsWith(homedir)).toBe(true);
    expect(readdirSync(dir).filter((n) => /server\.(key|crt)/.test(n))).toEqual([]);
  });

  it('saves an uploaded pair, and refuses a pair that does not match without writing', async () => {
    project();
    const { base } = await start();
    const wrong = await post(`${base}/api/setup/salesforce/key`, { key: pair.keyPem, certificate: uploaded.certPem });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe(WORDS.codes.mismatch);
    expect(existsSync(paths().key)).toBe(false);
    const ok = await post(`${base}/api/setup/salesforce/key`, { key: uploaded.keyPem, certificate: uploaded.certPem });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'ready', subject: 'CN=Acme upload' });
  });

  it('refuses to replace a saved key unless asked', async () => {
    project();
    const { base } = await start();
    expect((await post(`${base}/api/setup/salesforce/key`, { generate: true })).status).toBe(200);
    const again = await post(`${base}/api/setup/salesforce/key`, { key: uploaded.keyPem, certificate: uploaded.certPem });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe(WORDS.codes.exists);
    expect(readFileSync(paths().key, 'utf8')).toBe(pair.keyPem);
    const replaced = await post(`${base}/api/setup/salesforce/key`, { key: uploaded.keyPem, certificate: uploaded.certPem, replace: true });
    expect(replaced.status).toBe(200);
    expect(replaced.body.subject).toBe('CN=Acme upload');
  });

  it('takes only generate: true or a key and certificate', async () => {
    project();
    const { base } = await start();
    for (const body of [{}, { generate: false }, { generate: true, key: 'x', certificate: 'y' }, { key: 'x' }, { key: 1, certificate: 2 }, { generate: true, replace: 'yes' }]) {
      const r = await post(`${base}/api/setup/salesforce/key`, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error).toBe(WORDS.keyBody);
    }
  });

  it('says so in words when openssl fails', async () => {
    project();
    sh = fakeSfShell(routes, fakeOpenssl({ pair, status: 1 }));
    const { base } = await start();
    const r = await post(`${base}/api/setup/salesforce/key`, { generate: true });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe(WORDS.codes['openssl-failed']);
    expect(r.text).not.toContain('acme openssl');
  });
});

describe('connecting an org', () => {
  async function ready() {
    project();
    const started = await start();
    expect((await post(`${started.base}/api/setup/salesforce/key`, { generate: true })).status).toBe(200);
    return started;
  }

  it('connects a sandbox with the configured org ID', async () => {
    const { base } = await ready();
    const r = await post(`${base}/api/setup/salesforce/connect`, CONNECT());
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, status: 'connected', alias: 'acme-dev1', orgId: ACME_DEV1_ID });
    expect(sfLines()[0]).toContain('--instance-url https://test.salesforce.com');
    expect(sfLines()[0]).toContain(`--jwt-key-file ${paths().key}`);
    for (const c of sh.calls.filter((x) => x.cmd === 'sf')) expect(c.opts.env.HOME).toBe(sfHomeDir);
  });

  it('signs production out at once and refuses it', async () => {
    const { base } = await ready();
    routes[orgRoute('acme-dev1')] = orgRecord(ACME_DEV1_ID, false);
    const r = await post(`${base}/api/setup/salesforce/connect`, CONNECT());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: false, status: 'refused', code: 'production', alias: 'acme-dev1' });
    expect(r.body.error).toContain('Foreman never connects to production');
    expect(r.body.error).toContain('It signed acme-dev1 out again.');
    expect(sfLines().at(-1)).toBe('org logout --target-org acme-dev1 --no-prompt --json');
  });

  it('gives the logout command when signing production out fails', async () => {
    const { base } = await ready();
    routes[orgRoute('acme-dev1')] = orgRecord(ACME_DEV1_ID, false);
    routes[LOGOUT] = sfError('SfError', 'could not');
    const r = await post(`${base}/api/setup/salesforce/connect`, CONNECT());
    expect(r.body).toMatchObject({ ok: false, status: 'refused', code: 'production' });
    expect(r.body.error).toContain('Foreman never connects to production');
    expect(r.body.error).toContain(`HOME='${sfHomeDir}' sf org logout --target-org acme-dev1 --no-prompt`);
  });

  it('offers a different org ID, and saves it into foreman.config.json on request', async () => {
    const { base } = await ready();
    const before = Object.keys(saved());
    const blockKeys = Object.keys(saved().salesforce);
    const none = await post(`${base}/api/setup/salesforce/org-id`, { alias: 'acme-dev1' });
    expect(none.status).toBe(409);
    expect(none.body.error).toBe(WORDS.connectFirst);

    routes[orgRoute('acme-dev1')] = orgRecord(FOUND_ID);
    const r = await post(`${base}/api/setup/salesforce/connect`, CONNECT());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: false, status: 'org-id-differs', alias: 'acme-dev1', orgId: FOUND_ID, configured: ACME_DEV1_ID, update: { alias: 'acme-dev1', orgId: FOUND_ID } });
    expect(sfLines().some((l) => l.includes(LOGOUT))).toBe(false);

    const applied = await post(`${base}/api/setup/salesforce/org-id`, { alias: 'acme-dev1' });
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({ ok: true, alias: 'acme-dev1', orgId: FOUND_ID });
    expect(applied.body.lines).toEqual([`set salesforce.orgs.acme-dev1.orgId to ${FOUND_ID} in foreman.config.json`]);
    expect(saved().salesforce.orgs).toEqual({ 'acme-dev1': { orgId: FOUND_ID }, 'acme-qa': { orgId: ACME_QA_ID } });
    expect(Object.keys(saved())).toEqual(before);
    expect(Object.keys(saved().salesforce)).toEqual(blockKeys);

    // Used once: a second apply needs a new connect.
    expect((await post(`${base}/api/setup/salesforce/org-id`, { alias: 'acme-dev1' })).status).toBe(409);
  });

  it('refuses an org ID another org in salesforce.orgs already has', async () => {
    const { base } = await ready();
    routes[orgRoute('acme-dev1')] = orgRecord(ACME_QA_ID);
    expect((await post(`${base}/api/setup/salesforce/connect`, CONNECT())).body.update).toEqual({ alias: 'acme-dev1', orgId: ACME_QA_ID });
    const r = await post(`${base}/api/setup/salesforce/org-id`, { alias: 'acme-dev1' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/same org as acme-(dev1|qa)/);
    expect(saved().salesforce.orgs['acme-dev1'].orgId).toBe(ACME_DEV1_ID);
  });

  it('forgets the offered org ID once the org connects as configured', async () => {
    const { base } = await ready();
    routes[orgRoute('acme-dev1')] = orgRecord(FOUND_ID);
    await post(`${base}/api/setup/salesforce/connect`, CONNECT());
    routes[orgRoute('acme-dev1')] = orgRecord(ACME_DEV1_ID);
    expect((await post(`${base}/api/setup/salesforce/connect`, CONNECT())).body.status).toBe('connected');
    expect((await post(`${base}/api/setup/salesforce/org-id`, { alias: 'acme-dev1' })).status).toBe(409);
  });

  it.each([
    ['not-approved', "invalid_grant: user hasn't approved this consumer", 'policies', undefined],
    ['client-id', 'invalid_client_id: client identifier invalid', 'consumer-key', 'clientId'],
    ['audience', 'invalid_grant: audience is invalid', 'connect', 'instanceUrl'],
    ['assertion', 'invalid_grant: invalid assertion', 'oauth', undefined],
  ])('maps %s to its guide step', async (code, message, guide, field) => {
    const { base } = await ready();
    routes[LOGIN] = sfError('SfError', `${message} for ${USER} with ${CLIENT_ID}`);
    const r = await post(`${base}/api/setup/salesforce/connect`, CONNECT());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: false, status: 'failed', alias: 'acme-dev1', code, guide, error: ERRORS[code].words });
    if (field) expect(r.body.field).toBe(field);
    else expect(r.body).not.toHaveProperty('field');
    expect(r.text).not.toContain('invalid_grant');
  });

  it('says to wait a few minutes, or check the whole key, for an unknown consumer key', () => {
    expect(ERRORS['client-id'].words).toMatch(/whole/);
    expect(ERRORS['client-id'].words).toMatch(/few minutes/);
  });

  it('names an unknown failure by its error name only', async () => {
    const { base } = await ready();
    routes[LOGIN] = sfError('JwtGrantError', `odd failure for ${USER}`);
    const r = await post(`${base}/api/setup/salesforce/connect`, CONNECT());
    expect(r.body).toMatchObject({ ok: false, status: 'failed', code: 'sign-in' });
    expect(r.body.error).toContain('JwtGrantError');
    expect(r.text).not.toContain('odd failure');
  });

  it('refuses a bad alias, username, consumer key or login URL without repeating it', async () => {
    const { base } = await ready();
    const cases = [
      [{ alias: 'acme-uat' }, WORDS.pickOrg, 'acme-uat'],
      [{ alias: 'constructor' }, WORDS.pickOrg, 'constructor'],
      [{ username: 'not a user' }, WORDS.badUsername, 'not a user'],
      [{ clientId: 'bad key!' }, WORDS.badClientId, 'bad key!'],
      [{ instanceUrl: 'http://test.salesforce.com' }, WORDS.badInstanceUrl, 'http://'],
      [{ instanceUrl: 'https://evil.com' }, WORDS.badInstanceUrl, 'evil'],
    ];
    for (const [over, words, echo] of cases) {
      const r = await post(`${base}/api/setup/salesforce/connect`, CONNECT(over));
      expect(r.status, JSON.stringify(over)).toBe(400);
      expect(r.body.error).toBe(words);
      expect(r.text).not.toContain(echo);
    }
    expect(sfLines()).toEqual([]);
  });

  it('needs the key first', async () => {
    project();
    const { base } = await start();
    const r = await post(`${base}/api/setup/salesforce/connect`, CONNECT());
    expect(r.status).toBe(409);
    expect(r.body.error).toBe(WORDS.keyFirst);
    expect(sfLines()).toEqual([]);
  });

  it('limits connects to 5 a minute, with 429 and retry-after', async () => {
    project();
    let clock = Date.parse(NOW);
    const { base } = await start({ now: () => new Date(clock) });
    expect((await post(`${base}/api/setup/salesforce/key`, { generate: true })).status).toBe(200);
    for (let i = 0; i < 5; i += 1) {
      clock += 1000;
      expect((await post(`${base}/api/setup/salesforce/connect`, CONNECT())).status).toBe(200);
    }
    clock += 1000;
    const sixth = await post(`${base}/api/setup/salesforce/connect`, CONNECT());
    expect(sixth.status).toBe(429);
    expect(sixth.body.retryAfter).toBe(55);
    expect(sixth.headers.get('retry-after')).toBe('55');
    expect(sfLines().filter((l) => l.startsWith(LOGIN))).toHaveLength(5);
  });
});

describe('which projects and dashboards it serves', () => {
  it('refuses a project that does not use the Salesforce pack', async () => {
    project({ version: 1, project: { name: 'Acme' } });
    const { base } = await start();
    const r = await call(`${base}/api/setup/salesforce/key`);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe(WORDS.notSalesforce);
  });

  it('says to finish set-up first in set-up mode', async () => {
    const { base } = await start({ config: null });
    for (const r of [await call(`${base}/api/setup/salesforce/key`), await post(`${base}/api/setup/salesforce/key`, { generate: true })]) {
      expect(r.status).toBe(409);
      expect(r.body.error).toBe(SETUP_FIRST);
    }
  });

  it('refuses keys and sign-ins on a dashboard other computers can reach, even with the token', async () => {
    project();
    const { base } = await start({ host: '0.0.0.0', env: { FOREMAN_DASHBOARD_TOKEN: TOKEN } });
    const auth = { authorization: `Bearer ${TOKEN}` };
    for (const [path, body] of [['/api/setup/salesforce/key', { generate: true }], ['/api/setup/salesforce/connect', CONNECT()], ['/api/setup/salesforce/org-id', { alias: 'acme-dev1' }]]) {
      const r = await post(`${base}${path}`, body, auth);
      expect(r.status, path).toBe(403);
      expect(r.body.error).toBe(WORDS.localOnly);
    }
    expect(sh.calls).toEqual([]);
    const got = await call(`${base}/api/setup/salesforce/key`, { headers: auth });
    expect(got.status).toBe(200);
    expect(got.body).toEqual({ status: 'none' });
  });

  it('answers other methods with 405 and the allowed ones', async () => {
    project();
    const { base } = await start();
    const key = await raw(base, '/api/setup/salesforce/key', { method: 'PUT' });
    expect(key.status).toBe(405);
    expect(key.headers.allow).toBe('GET, POST');
    for (const path of ['/api/setup/salesforce/connect', '/api/setup/salesforce/org-id']) {
      const r = await raw(base, path);
      expect(r.status, path).toBe(405);
      expect(r.headers.allow, path).toBe('POST');
    }
  });
});

describe('the sf-orgs step in GET /api/setup', () => {
  const sfOrgs = (body) => body.steps.find((s) => s.id === 'sf-orgs');
  const ORGS = [
    { alias: 'acme-dev1', orgId: ACME_DEV1_ID, roles: ['build'] },
    { alias: 'acme-qa', orgId: ACME_QA_ID, roles: ['stage qa'] },
  ];

  it("carries the screen's words and the orgs and key as they are now, with no sf or openssl call", async () => {
    project();
    const { base } = await start();
    const r = await call(`${base}/api/setup`);
    expect(r.status).toBe(200);
    const step = sfOrgs(r.body);
    expect(step.salesforce).toEqual(SF_SCREEN);
    expect(step.salesforceConfig).toEqual({ orgs: ORGS, scratch: false, key: { status: 'none' } });
    expect(sfLines()).toEqual([]);
    expect(sh.calls).toEqual([]);
    for (const s of r.body.steps) if (s.id !== 'sf-orgs') expect(Object.hasOwn(s, 'salesforceConfig'), s.id).toBe(false);
  });

  it('shows the saved key: the certificate and fingerprint, never the key or its file', async () => {
    project();
    const { base } = await start();
    expect((await post(`${base}/api/setup/salesforce/key`, { generate: true })).status).toBe(200);
    const r = await call(`${base}/api/setup`);
    const { key } = sfOrgs(r.body).salesforceConfig;
    expect(key).toMatchObject({ status: 'ready', subject: 'CN=Foreman acme', expires: '2030-01-01T00:00:00.000Z' });
    expect(key.certificate).toContain('-----BEGIN CERTIFICATE-----');
    expect(key.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(key).not.toHaveProperty('keyFile');
    expect(r.text).not.toContain('PRIVATE KEY');
    expect(r.text).not.toContain(paths().key);
  });

  it('leaves the scratch dev hub out, which is normally production', async () => {
    const block = {
      productionBranch: 'main',
      orgs: { 'acme-hub': { orgId: '00D000000000009AAA' }, 'acme-qa': { orgId: ACME_QA_ID } },
      build: { scratch: { devHub: 'acme-hub', definition: 'config/project-scratch-def.json' } },
      stages: [{ name: 'qa', org: 'acme-qa', branch: 'qa' }],
    };
    project({ version: 1, project: { name: 'Acme' }, pack: 'salesforce', salesforce: block });
    const { base } = await start();
    const r = await call(`${base}/api/setup`);
    expect(sfOrgs(r.body).salesforceConfig).toEqual({ orgs: [{ alias: 'acme-qa', orgId: ACME_QA_ID, roles: ['stage qa'] }], scratch: true, key: { status: 'none' } });
  });

  it('skips the step on a project that does not use the Salesforce pack', async () => {
    project({ version: 1, project: { name: 'Acme' } });
    const { base } = await start();
    const r = await call(`${base}/api/setup`);
    expect(r.status).toBe(200);
    const step = sfOrgs(r.body);
    expect(step.status).toBe('skipped');
    expect(Object.hasOwn(step, 'salesforceConfig')).toBe(false);
  });

  it('answers without the orgs when the salesforce block is broken, or there is no config', async () => {
    project();
    const { base } = await start();
    writeFileSync(configFile(), `${JSON.stringify({ version: 1, project: { name: 'Acme' }, pack: 'salesforce', salesforce: { orgs: 'acme' } }, null, 2)}\n`);
    const broken = await call(`${base}/api/setup`);
    expect(broken.status).toBe(200);
    expect(sfOrgs(broken.body).salesforceConfig ?? null).toBeNull();

    const none = await start({ config: null });
    const r = await call(`${none.base}/api/setup`);
    expect(r.status).toBe(200);
    expect(sfOrgs(r.body).salesforceConfig ?? null).toBeNull();
  });

  it('still shows the screen on a dashboard other computers can reach, which cannot change anything', async () => {
    project();
    const { base } = await start({ host: '0.0.0.0', env: { FOREMAN_DASHBOARD_TOKEN: TOKEN } });
    const auth = { authorization: `Bearer ${TOKEN}` };
    const r = await call(`${base}/api/setup`, { headers: auth });
    expect(r.status).toBe(200);
    expect(r.body.canChangeKeys).toBe(false);
    expect(sfOrgs(r.body).salesforceConfig).toEqual({ orgs: ORGS, scratch: false, key: { status: 'none' } });
    for (const [path, body] of [['/api/setup/salesforce/key', { generate: true }], ['/api/setup/salesforce/connect', CONNECT()], ['/api/setup/salesforce/org-id', { alias: 'acme-dev1' }]]) {
      const refused = await post(`${base}${path}`, body, auth);
      expect(refused.status, path).toBe(403);
      expect(refused.body.error).toBe(WORDS.localOnly);
    }
    expect(sh.calls).toEqual([]);
  });
});
