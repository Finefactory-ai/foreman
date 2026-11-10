// The Gearset set-up API: POST /api/setup/gearset/read, /save and /confirm, plus the sf-gearset
// step's gearset and gearsetConfig in GET /api/setup. The fake Gearset is the injected keyFetch,
// and the token is in .env.foreman. No response ever carries the token.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardServer } from './server.mjs';
import { loadConfig } from '../config/load.mjs';
import { GEARSET_SCREEN } from '../setup/gearset-screen.mjs';
import { COMMIT_REMINDER } from '../settings/change.mjs';
import { ACME_DEV1_ID, ACME_QA_ID, ACME_UAT_ID } from '../../../test/fake-sf.mjs';
import { PIPELINES, acmeGearset, fakeGearset } from '../../../test/fake-gearset.mjs';

const TOKEN = 'acme-dashboard-token-0123456789abcdef';
const GEARSET_TOKEN = 'gs-acme-secret-9876543210';
const NOW = '2026-10-24T09:00:00.000Z';

let dir;
let servers;
let seen; // the text of every response a test got
let gearset;

const configFile = () => join(dir, 'foreman.config.json');
const savedConfig = () => JSON.parse(readFileSync(configFile(), 'utf8'));
const stateDir = () => join(dir, '.foreman');

const SF_BLOCK = () => ({
  productionBranch: 'main',
  orgs: { 'acme-dev1': { orgId: ACME_DEV1_ID }, 'acme-qa': { orgId: ACME_QA_ID }, 'acme-uat': { orgId: ACME_UAT_ID } },
  build: ['acme-dev1'],
  stages: [{ name: 'qa', org: 'acme-qa', branch: 'qa' }, { name: 'uat', org: 'acme-uat', branch: 'uat' }],
  release: 'gearset',
});

function project(salesforce = SF_BLOCK()) {
  writeFileSync(configFile(), `${JSON.stringify({ version: 1, project: { name: 'Acme' }, pack: 'salesforce', salesforce }, null, 2)}\n`);
  const { config, errors } = loadConfig(dir);
  expect(errors ?? []).toEqual([]);
  return config;
}
const token = () => writeFileSync(join(dir, '.env.foreman'), `GEARSET_API_TOKEN=${GEARSET_TOKEN}\n`, { mode: 0o600 });

async function start({ host = '127.0.0.1', env = {}, config = loadConfig(dir).config, now = () => new Date(NOW), ...rest } = {}) {
  const cfg = config ? { ...config, console: { ...config.console, host } } : null;
  const server = createDashboardServer({
    root: dir,
    config: cfg,
    host,
    env: { FOREMAN_STATE_DIR: stateDir(), ...env },
    now,
    keyFetch: gearset,
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

const stepOf = async (base) => (await call(`${base}/api/setup`)).body.steps.find((s) => s.id === 'sf-gearset');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foreman-setup-gearset-'));
  servers = [];
  seen = '';
  gearset = fakeGearset(acmeGearset());
  spawnSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, '.gitignore'), '.env.foreman\n.foreman/\n');
});
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((resolve) => (s.listening ? s.close(() => resolve()) : resolve()))));
  expect(seen).not.toContain(GEARSET_TOKEN);
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/setup', () => {
  it("gives sf-gearset its screen's words and gearsetConfig, asking Gearset nothing", async () => {
    project();
    token();
    const { base } = await start();
    const step = await stepOf(base);
    expect(step.gearset).toEqual(GEARSET_SCREEN);
    expect(step.gearsetConfig).toEqual({
      pipelineId: null,
      stages: [{ name: 'qa', org: 'acme-qa', orgId: ACME_QA_ID }, { name: 'uat', org: 'acme-uat', orgId: ACME_UAT_ID }],
      confirmed: {},
    });
    expect(step.keys.map((k) => k.name)).toEqual(['GEARSET_API_TOKEN']);
    expect(gearset.calls).toEqual([]);
    const body = (await call(`${base}/api/setup`)).body;
    for (const s of body.steps) if (s.id !== 'sf-gearset') expect(Object.hasOwn(s, 'gearsetConfig'), s.id).toBe(false);
  });

  it('carries no gearsetConfig when the step does not apply', async () => {
    project({ ...SF_BLOCK(), release: 'sf' });
    const { base } = await start();
    const step = await stepOf(base);
    expect(step.applies).toBe(false);
    expect(Object.hasOwn(step, 'gearsetConfig')).toBe(false);
  });
});

describe('POST /api/setup/gearset/read', () => {
  it('answers the pipelines and the matched rows', async () => {
    project();
    token();
    const { base } = await start();
    const r = await post(`${base}/api/setup/gearset/read`, {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, pipelineId: 'pipe-1', saved: null, missing: [] });
    expect(r.body.rows.map((x) => [x.name, x.alias, x.stage])).toEqual([['QA', 'acme-qa', 'qa'], ['UAT', 'acme-uat', 'uat']]);
    expect(gearset.calls[0].headers.Authorization).toBe(`token ${GEARSET_TOKEN}`);
  });

  it('is a 409 with no token saved', async () => {
    project();
    const { base } = await start();
    const r = await post(`${base}/api/setup/gearset/read`, {});
    expect(r.status).toBe(409);
    expect(r.body.error).toBe(GEARSET_SCREEN.errors.tokenFirst);
    expect(gearset.calls).toEqual([]);
  });

  it("answers Gearset's refusal in the screen's words", async () => {
    project();
    token();
    gearset = fakeGearset(acmeGearset({ [PIPELINES]: { status: 401, body: { Message: `no ${GEARSET_TOKEN}` } } }));
    const { base } = await start();
    const r = await post(`${base}/api/setup/gearset/read`, {});
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: false, error: GEARSET_SCREEN.errors.badToken });
  });

  it('allows 5 reads a minute, as a step check, then 429 with retry-after', async () => {
    project();
    token();
    let clock = Date.parse(NOW);
    const { base } = await start({ now: () => new Date(clock) });
    for (let i = 0; i < 5; i += 1) {
      clock += 1000;
      expect((await post(`${base}/api/setup/gearset/read`, {})).status, `read ${i + 1}`).toBe(200);
    }
    clock += 1000;
    const sixth = await post(`${base}/api/setup/gearset/read`, {});
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get('retry-after')).toBe('55');
    expect(sixth.body.retryAfter).toBe(55);
    expect((await post(`${base}/api/setup/steps/sf-gearset/check`, {})).status).toBe(429);
  });
});

describe('POST /api/setup/gearset/save', () => {
  it('writes the pipeline ID and answers configDirty', async () => {
    project();
    const { base } = await start();
    const r = await post(`${base}/api/setup/gearset/save`, { pipelineId: 'pipe-1' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, lines: ['set salesforce.gearset.pipelineId to pipe-1', COMMIT_REMINDER], gearset: { pipelineId: 'pipe-1' } });
    expect(typeof r.body.configDirty).toBe('boolean');
    expect(savedConfig().salesforce.gearset).toEqual({ promote: 'merge', pipelineId: 'pipe-1' });
    expect(gearset.calls).toEqual([]);
    expect((await stepOf(base)).gearsetConfig.pipelineId).toBe('pipe-1');
  });

  it('refuses a bad ID without repeating it', async () => {
    project();
    const { base } = await start();
    const r = await post(`${base}/api/setup/gearset/save`, { pipelineId: 'evil id/..' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe(GEARSET_SCREEN.errors.badPipeline);
    expect(r.text).not.toContain('evil');
  });
});

describe('POST /api/setup/gearset/confirm', () => {
  it("is reflected in the next GET's gearsetConfig.confirmed, and false clears it", async () => {
    project();
    const { base } = await start();
    const r = await post(`${base}/api/setup/gearset/confirm`, { stage: 'qa', confirmed: true });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, stage: 'qa', confirmedAt: NOW });
    const step = await stepOf(base);
    expect(step.gearsetConfig.confirmed).toEqual({ qa: NOW });
    expect(step.checkedAt).toBeNull();
    expect(step.confirmedAt).toBeNull();
    await post(`${base}/api/setup/gearset/confirm`, { stage: 'qa', confirmed: false });
    expect((await stepOf(base)).gearsetConfig.confirmed).toEqual({});
  });

  it('refuses an unknown stage without naming it', async () => {
    project();
    const { base } = await start();
    const r = await post(`${base}/api/setup/gearset/confirm`, { stage: 'nosuch', confirmed: true });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe(GEARSET_SCREEN.errors.badStage);
    expect(r.text).not.toContain('nosuch');
  });
});

describe('the gates', () => {
  const ROUTES = [
    ['/api/setup/gearset/read', {}],
    ['/api/setup/gearset/save', { pipelineId: 'pipe-1' }],
    ['/api/setup/gearset/confirm', { stage: 'qa', confirmed: true }],
  ];

  it('needs the Bearer token on another host, and works with it', async () => {
    project();
    token();
    const { base } = await start({ host: '0.0.0.0', env: { FOREMAN_DASHBOARD_TOKEN: TOKEN } });
    for (const [path, body] of ROUTES) {
      expect((await post(`${base}${path}`, body)).status, path).toBe(401);
    }
    expect(gearset.calls).toEqual([]);
    for (const [path, body] of ROUTES) {
      expect((await post(`${base}${path}`, body, { authorization: `Bearer ${TOKEN}` })).status, path).toBe(200);
    }
  });

  it('refuses another origin, another Host, plain text and GET', async () => {
    project();
    token();
    const { base } = await start();
    const json = { 'content-type': 'application/json' };
    for (const [path, body] of ROUTES) {
      const text = JSON.stringify(body);
      expect((await raw(base, path, { method: 'POST', headers: { ...json, origin: 'https://evil.example' }, body: text })).status, path).toBe(403);
      expect((await raw(base, path, { method: 'POST', headers: { ...json, host: 'evil.example' }, body: text })).status, path).toBe(403);
      expect((await raw(base, path, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: text })).status, path).toBe(415);
      const get = await raw(base, path);
      expect(get.status, path).toBe(405);
      expect(get.headers.allow, path).toBe('POST');
    }
    expect(gearset.calls).toEqual([]);
    expect(savedConfig().salesforce.gearset).toBeUndefined();
  });
});
