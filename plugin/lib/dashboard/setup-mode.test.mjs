// Set-up mode: a dashboard started with no foreman.config.json answers only the set-up routes,
// writes the config through POST /api/setup/project/write, and switches to full mode without a
// restart once a valid config is on disk.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createDashboardServer, startDashboard } from './server.mjs';
import { AREAS, SETUP_FIRST, STEPS } from '../setup/steps.mjs';
import { writeToken } from '../jira/auth.mjs';
import { startFakeJira } from '../../../test/fake-jira.mjs';

const ACME = { version: 1, project: { name: 'Acme' }, checks: [{ run: 'true', when: 'always' }] };

let dir;
let state;
let servers;

const configFile = () => join(dir, 'foreman.config.json');

// Doctor checks for the project step only.
const fakeDoctor = () =>
  Promise.resolve({ config: null, ctx: {}, checks: [{ name: 'config', step: 'project', run: () => ({ ok: false, level: 'error', detail: 'no foreman.config.json' }) }] });

async function start({ host = '127.0.0.1', env = {}, ...rest } = {}) {
  const server = createDashboardServer({ root: dir, config: null, stateDir: state, env, doctor: fakeDoctor, ...rest });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, host, resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

const post = (url, body, headers = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

// A request whose path and headers go out exactly as written.
function raw(base, path, { method = 'GET', headers = {}, body } = {}) {
  const { port } = new URL(base);
  const sent = body === undefined ? {} : { 'content-length': Buffer.byteLength(body) };
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers: { ...sent, ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const acmePackage = () => writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'acme', scripts: { test: 'vitest' } }));
const detected = async (base) => (await (await post(`${base}/api/setup/project/detect`, {})).json()).suggested;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foreman-setup-mode-'));
  state = join(dir, '.foreman');
  servers = [];
  spawnSync('git', ['init', '-q'], { cwd: dir });
});
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((resolve) => (s.listening ? s.close(() => resolve()) : resolve()))));
  rmSync(dir, { recursive: true, force: true });
});

describe('set-up mode: the set-up routes answer with no config', () => {
  it('serves the page, the help and the set-up steps', async () => {
    const base = await start();
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/^text\/html/);
    expect((await fetch(`${base}/api/help`)).status).toBe(200);

    const res = await fetch(`${base}/api/setup`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.steps.map((s) => s.id)).toEqual(STEPS.map((s) => s.id));
    expect(body.steps.find((s) => s.id === 'project').applies).toBe(true);
    expect(body.areas).toEqual(AREAS);
    expect('readme' in body).toBe(false);
  });

  it('checks the project step', async () => {
    const base = await start();
    const res = await post(`${base}/api/setup/steps/project/check`, {});
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.step.id).toBe('project');
  });
});

describe('set-up mode: everything else is 409', () => {
  it('refuses every other path, known or not, and writes no state', async () => {
    const base = await start();
    for (const path of ['/api/status', '/api/events', '/api/waiting', '/api/settings', '/api/decisions', ['/api/help', 'guide'].join('/'), '/nope']) {
      const res = await raw(base, path);
      expect(res.status, path).toBe(409);
      expect(JSON.parse(res.body), path).toEqual({ error: SETUP_FIRST });
    }
    for (const path of ['/api/control', '/api/decisions/x']) {
      const res = await post(`${base}${path}`, { action: 'pause' });
      expect(res.status, path).toBe(409);
      expect(await res.json(), path).toEqual({ error: SETUP_FIRST });
    }
    expect(existsSync(join(state, 'control.json'))).toBe(false);
  });
});

describe('set-up mode: the safety checks still come first', () => {
  it('refuses another Host', async () => {
    const base = await start();
    expect((await raw(base, '/api/setup', { headers: { host: 'evil.test' } })).status).toBe(403);
  });

  it('refuses a write from another site and writes nothing', async () => {
    const base = await start();
    const res = await post(`${base}/api/setup/project/write`, { config: ACME }, { origin: 'http://evil.test' });
    expect(res.status).toBe(403);
    expect(existsSync(configFile())).toBe(false);
  });

  it('will not build on another host without a token', () => {
    expect(() => createDashboardServer({ root: dir, config: null, stateDir: state, env: {}, host: '0.0.0.0' })).toThrow(/FOREMAN_DASHBOARD_TOKEN/);
  });
});

describe('POST /api/setup/project/detect', () => {
  it('suggests a config from the project', async () => {
    acmePackage();
    const base = await start();
    const res = await post(`${base}/api/setup/project/detect`, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      suggested: { project: { name: 'acme' }, checks: [{ run: 'npm test', when: 'always' }] },
      found: { node: true },
    });
  });

  it('takes only a JSON POST', async () => {
    const base = await start();
    const get = await raw(base, '/api/setup/project/detect');
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe('POST');
    const text = await raw(base, '/api/setup/project/detect', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    expect(text.status).toBe(415);
  });
});

describe('POST /api/setup/project/write: validation', () => {
  it('reports what is wrong in plain words and writes nothing', async () => {
    const base = await start();
    const res = await post(`${base}/api/setup/project/write`, { config: { version: 1, checks: 'x' } });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors.length).toBeGreaterThan(0);
    for (const e of body.errors) expect(typeof e).toBe('string');
    expect(body.errors.some((e) => e.includes('checks'))).toBe(true);
    expect(body.error).toBe(body.errors.join('; '));
    expect(existsSync(configFile())).toBe(false);
  });

  it('wants the config as an object and example as a boolean', async () => {
    const base = await start();
    for (const config of ['x', []]) {
      const res = await post(`${base}/api/setup/project/write`, { config });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Send the config as a JSON object.' });
    }
    const res = await post(`${base}/api/setup/project/write`, { config: ACME, example: 'yes' });
    expect(res.status).toBe(400);
    expect(existsSync(configFile())).toBe(false);
  });

  it('takes only a JSON POST', async () => {
    const base = await start();
    const get = await raw(base, '/api/setup/project/write');
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe('POST');
    const text = await raw(base, '/api/setup/project/write', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    expect(text.status).toBe(415);
  });
});

describe('POST /api/setup/project/write: the switch to full mode', () => {
  it('writes the config and its files, then serves everything without a restart', async () => {
    acmePackage();
    const base = await start();
    expect((await fetch(`${base}/api/status`)).status).toBe(409);

    const res = await post(`${base}/api/setup/project/write`, { config: await detected(base) });
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.lines).toContain('wrote foreman.config.json');
    expect(existsSync(configFile())).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8')).enabledPlugins['foreman@foreman']).toBe(true);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toContain('.foreman/');
    expect(existsSync(join(dir, 'stories', 'S-1.md'))).toBe(true);

    const status = await fetch(`${base}/api/status`);
    expect(status.status).toBe(200);
    expect((await status.json()).project.name).toBe('acme');
    expect((await fetch(`${base}/api/settings`)).status).toBe(200);

    const before = readFileSync(configFile());
    const again = await post(`${base}/api/setup/project/write`, { config: { ...ACME, project: { name: 'Other' } } });
    expect(again.status).toBe(409);
    expect((await again.json()).error).toMatch(/already has foreman\.config\.json/);
    expect(readFileSync(configFile()).equals(before)).toBe(true);
  });

  it('writes no example story with example: false', async () => {
    acmePackage();
    const base = await start();
    const res = await post(`${base}/api/setup/project/write`, { config: await detected(base), example: false });
    expect(res.status).toBe(200);
    expect(existsSync(join(dir, 'stories', 'S-1.md'))).toBe(false);
  });
});

describe('POST /api/setup/project/write: a stories folder outside the project', () => {
  const escaped = () => join(dir, '..', `${basename(dir)}-escaped`);
  afterEach(() => rmSync(escaped(), { recursive: true, force: true }));

  it('refuses it with a 400 and writes nothing, in the project or outside it', async () => {
    const base = await start();
    const res = await post(`${base}/api/setup/project/write`, { config: { ...ACME, stories: { adapter: 'markdown', dir: `../${basename(dir)}-escaped` } } });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors.join('; ')).toMatch(/outside the project/);
    expect(existsSync(configFile())).toBe(false);
    expect(existsSync(escaped())).toBe(false);
  });
});

describe('set-up mode: a foreman.config.json that does not load', () => {
  const setupNow = async (base) => (await fetch(`${base}/api/setup`)).json();

  it('lists its errors, and the write route replaces it', async () => {
    writeFileSync(configFile(), '{ not json');
    const base = await start();
    const before = await setupNow(base);
    expect(before.hasConfig).toBe(true);
    expect(Array.isArray(before.configErrors)).toBe(true);
    expect(before.configErrors.length).toBeGreaterThan(0);
    expect(before.configErrors.join('; ')).toMatch(/not valid JSON/);

    const res = await post(`${base}/api/setup/project/write`, { config: ACME });
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.lines).toContain('wrote foreman.config.json');
    expect(JSON.parse(readFileSync(configFile(), 'utf8'))).toEqual(ACME);
    const status = await fetch(`${base}/api/status`);
    expect(status.status).toBe(200);
    expect((await status.json()).project.name).toBe('Acme');
    expect((await setupNow(base)).configErrors).toBeNull();
  });

  it('keeps the broken file when the replacement fails the checks', async () => {
    writeFileSync(configFile(), '{ not json');
    const base = await start();
    const res = await post(`${base}/api/setup/project/write`, { config: { version: 1 } });
    expect(res.status).toBe(400);
    expect(readFileSync(configFile(), 'utf8')).toBe('{ not json');
  });

  it('still refuses a write from another site, and leaves the file', async () => {
    writeFileSync(configFile(), '{ not json');
    const base = await start();
    const res = await post(`${base}/api/setup/project/write`, { config: ACME }, { origin: 'http://evil.test' });
    expect(res.status).toBe(403);
    expect(readFileSync(configFile(), 'utf8')).toBe('{ not json');
  });

  it('does not replace a config the server has loaded, even once it is broken by hand', async () => {
    const base = await start();
    expect((await post(`${base}/api/setup/project/write`, { config: ACME })).status).toBe(200);
    writeFileSync(configFile(), '{ not json');
    const again = await post(`${base}/api/setup/project/write`, { config: ACME });
    expect(again.status).toBe(409);
    expect((await again.json()).error).toMatch(/already has foreman\.config\.json/);
    expect(readFileSync(configFile(), 'utf8')).toBe('{ not json');
    expect((await setupNow(base)).configErrors).toBeNull();
  });

  it('has no errors to list with no config at all', async () => {
    const base = await start();
    expect((await setupNow(base)).configErrors).toBeNull();
  });
});

describe('set-up mode: a config written by hand', () => {
  it('stays in set-up mode while the file is invalid, and switches once it is valid', async () => {
    const base = await start();
    writeFileSync(configFile(), '{ not json');
    expect((await fetch(`${base}/api/status`)).status).toBe(409);
    writeFileSync(configFile(), JSON.stringify(ACME));
    const res = await fetch(`${base}/api/status`);
    expect(res.status).toBe(200);
    expect((await res.json()).project.name).toBe('Acme');
  });

  describe('a Jira config written after start', () => {
    const SITE = 'acme.atlassian.net';
    const para = (t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
    const heading = (t) => ({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: t }] });
    let jira;

    beforeAll(async () => {
      jira = await startFakeJira();
    });
    afterAll(async () => {
      await jira.close();
    });

    it('fetches an owner task brief through Jira', async () => {
      jira.reset();
      const env = { HOME: join(dir, 'home'), FOREMAN_JIRA_API_BASE: jira.url, FOREMAN_JIRA_AUTH_BASE: jira.url };
      writeToken(SITE, { cloudId: jira.cloudId, site: SITE, ...jira.tokens, expiresAt: '2999-01-01T00:00:00.000Z' }, { env });
      jira.addIssue({
        key: 'ACME-1',
        summary: 'Make the sandbox',
        labels: ['foreman-owner'],
        description: { type: 'doc', version: 1, content: [heading('Steps'), { type: 'orderedList', content: [{ type: 'listItem', content: [para('Open Setup')] }] }] },
      });
      const base = await start({ env });
      writeFileSync(configFile(), JSON.stringify({ ...ACME, stories: { adapter: 'jira', site: SITE, jql: 'project = ACME ORDER BY rank', pollSeconds: 3600 } }));
      const list = await (await fetch(`${base}/api/waiting`)).json();
      expect(list.map((i) => i.id)).toContain('task:ACME-1');
      const before = (await jira.requests()).filter((r) => r.method === 'GET' && r.path === '/rest/api/3/issue/ACME-1').length;
      const details = await (await fetch(`${base}/api/waiting/task:ACME-1/details`)).json();
      expect(details.steps).toEqual(['Open Setup']);
      const after = (await jira.requests()).filter((r) => r.method === 'GET' && r.path === '/rest/api/3/issue/ACME-1').length;
      expect(after).toBe(before + 1);
    });
  });
});

describe('startDashboard with no config', () => {
  it('listens on 127.0.0.1 and answers /api/setup', async () => {
    const { server, url } = await startDashboard({ root: dir, config: null, stateDir: state, env: {}, port: 0 });
    servers.push(server);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect((await fetch(`${url}api/setup`)).status).toBe(200);
  });
});
