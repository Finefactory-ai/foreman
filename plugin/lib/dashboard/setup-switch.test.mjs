// Switching what Foreman uses from the Set up tab, on a project that has a config already:
// POST /api/setup/project/write { change } picks the story source and the Salesforce pack, GET
// /api/setup lists the areas that are off with Turn on (off) and what the project uses now
// (projectNow), and the server reads foreman.config.json and the local settings again whenever
// they change, so the steps follow without a restart. Every server here starts in full mode, on
// an Acme repo with a markdown config, and is never restarted; HOME is a temporary folder, so no
// real Jira sign-in is ever read.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardServer } from './server.mjs';
import { loadConfig } from '../config/load.mjs';
import { detect } from '../engine/init-helpers.mjs';
import { writeToken } from '../jira/auth.mjs';
import { PACKS } from '../../packs/index.mjs';
import { SETUP_FIRST } from '../setup/steps.mjs';
import { STARTER_JQL, WORDS, projectConfig } from '../setup/project.mjs';
import { COMMIT_REMINDER } from '../settings/change.mjs';
import { startFakeAtlassian } from '../../../test/fake-atlassian.mjs';

const TOKEN = 'acme-dashboard-token-0123456789abcdef';
const NOW = '2026-10-25T09:00:00.000Z';
const SITE = 'acme.atlassian.net';
const WRITE = '/api/setup/project/write';
const JIRA_STEPS = ['jira-app', 'jira-signin', 'jira-site'];
const SF_STEPS = ['sf-tools', 'sf-layout', 'sf-orgs', 'sf-skills'];
const JIRA_OFF = {
  id: 'jira',
  area: 'stories',
  title: 'Jira',
  line: 'Jira: off, because stories come from markdown files.',
  turnOn: { label: 'Turn on', step: 'project', choice: { field: 'source', value: 'jira' } },
};

let dir;
let home;
let fake;
let servers;
let seen; // the text of every response a test got

const configFile = () => join(dir, 'foreman.config.json');
const bytes = () => readFileSync(configFile());
const writeConfig = (raw) => writeFileSync(configFile(), `${JSON.stringify(raw, null, 2)}\n`);

// The markdown config the Set up form writes for an Acme repo with no pack.
function markdownProject() {
  const r = projectConfig(detect(dir, { packs: PACKS }), { name: 'Acme', source: 'markdown', dir: 'stories', check: 'true', ci: [] });
  expect(r.ok, JSON.stringify(r)).toBe(true);
  writeConfig(r.config);
  const loaded = loadConfig(dir);
  expect(loaded.errors ?? []).toEqual([]);
  return loaded.config;
}
// The same, then sfdx-project.json beside it: a Salesforce project with the pack not on yet.
function sfdxProject() {
  markdownProject();
  writeFileSync(join(dir, 'sfdx-project.json'), JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }] }));
}

// Doctor checks for no step: the step checks here only need to run.
const fakeDoctor = () => Promise.resolve({ config: null, ctx: {}, checks: [] });

async function start({ host = '127.0.0.1', env = {}, config = loadConfig(dir).config, ...rest } = {}) {
  const cfg = config ? { ...config, console: { ...config.console, host } } : null;
  const server = createDashboardServer({
    root: dir,
    config: cfg,
    host,
    env: { HOME: home, FOREMAN_JIRA_AUTH_BASE: fake.url, FOREMAN_JIRA_API_BASE: fake.url, ...env },
    now: () => new Date(NOW),
    jiraPort: 0,
    doctor: fakeDoctor,
    ...rest,
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, host, resolve));
  return `http://127.0.0.1:${server.address().port}`;
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
  return { status: res.status, text, body: json };
}
const post = (url, body = {}, headers) => call(url, { method: 'POST', body, headers });
const setup = async (base, headers) => {
  const r = await call(`${base}/api/setup`, { headers });
  expect(r.status, r.text).toBe(200);
  return r.body;
};
const statusOf = (body, id) => body.steps.find((s) => s.id === id).status;
const offIds = (body) => body.off.map((e) => e.id);

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

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'foreman-setup-switch-'));
  home = mkdtempSync(join(tmpdir(), 'foreman-setup-switch-home-'));
  servers = [];
  seen = '';
  // App keys shaped as Jira's are, so the key card's shape check takes them.
  fake = await startFakeAtlassian({ clientId: 'acmeJiraClientId0123456789', clientSecret: 'acme-jira-client-secret-0123456789' });
  spawnSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, '.gitignore'), '.env.foreman\n.foreman/\n');
});
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((resolve) => (s.listening ? s.close(() => resolve()) : resolve()))));
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('a markdown project lists the Jira area as off, with Turn on', () => {
  it('shows the off entry, the Jira steps skipped and what the project uses now', async () => {
    markdownProject();
    const base = await start();
    const body = await setup(base);
    expect(body.off).toEqual([JIRA_OFF]);
    for (const id of JIRA_STEPS) expect(statusOf(body, id), id).toBe('skipped');
    const project = body.steps.find((s) => s.id === 'project');
    expect(project.projectNow).toEqual({ source: 'markdown', pack: 'none', sfdx: false });
    expect(project.form.change.fields.map((f) => f.id)).toEqual(['source', 'pack', 'alias', 'orgId']);
    for (const s of body.steps) if (s.id !== 'project') expect(Object.hasOwn(s, 'projectNow'), s.id).toBe(false);
  });
});

describe('choosing Jira on This project', () => {
  it('writes a valid stories block, and the Jira steps then apply with no restart', async () => {
    markdownProject();
    const base = await start();
    const r = await post(`${base}${WRITE}`, { change: { source: 'jira' } });
    expect(r.status, r.text).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.lines).toEqual(['set stories.adapter to jira', 'set stories.jql to a starter filter; narrow it on the Jira site and filter screen', COMMIT_REMINDER]);
    expect(typeof r.body.configDirty).toBe('boolean');
    const loaded = loadConfig(dir);
    expect(loaded.errors ?? []).toEqual([]);
    expect(JSON.parse(bytes()).stories).toEqual({ adapter: 'jira', jql: STARTER_JQL });

    const after = await setup(base);
    for (const id of JIRA_STEPS) expect(statusOf(after, id), id).not.toBe('skipped');
    expect(offIds(after)).not.toContain('jira');
    expect(after.steps.find((s) => s.id === 'project').projectNow).toEqual({ source: 'jira', pack: 'none', sfdx: false });
  });

  it('saves the one site this machine is signed in to', async () => {
    markdownProject();
    const { accessToken, refreshToken } = fake.issueTokens();
    writeToken(SITE, { cloudId: 'cloud-acme-1', site: SITE, accessToken, refreshToken, expiresAt: '2026-10-25T10:00:00.000Z' }, { env: { HOME: home } });
    const base = await start();
    const r = await post(`${base}${WRITE}`, { change: { source: 'jira' } });
    expect(r.status, r.text).toBe(200);
    expect(r.body.lines).toContain(`set stories.site to ${SITE}`);
    expect(JSON.parse(bytes()).stories).toEqual({ adapter: 'jira', site: SITE, jql: STARTER_JQL });
    expect(seen).not.toContain(accessToken);
    expect(seen).not.toContain(refreshToken);
  });

  it('then takes the Jira app keys and starts the sign-in, from the Set up API alone', async () => {
    markdownProject();
    const base = await start();
    const first = await setup(base);
    expect(first.off).toContainEqual(JIRA_OFF);

    expect((await post(`${base}${WRITE}`, { change: { source: 'jira' } })).status).toBe(200);
    for (const [name, value] of [['JIRA_CLIENT_ID', fake.clientId], ['JIRA_CLIENT_SECRET', fake.clientSecret]]) {
      const k = await post(`${base}/api/setup/keys`, { name, value });
      expect(k.status, k.text).toBe(200);
    }
    const login = await post(`${base}/api/setup/jira/login`, {});
    expect(login.status, login.text).toBe(200);
    expect(login.body).toMatchObject({ status: 'waiting' });
    expect(login.body.url.startsWith(`${fake.url}/authorize?`)).toBe(true);
    expect(new URL(login.body.url).searchParams.get('client_id')).toBe(fake.clientId);
    expect(seen).not.toContain(fake.clientSecret);
  });
});

describe('a config edited on disk changes /api/setup without a restart', () => {
  it('follows foreman.config.json to Jira and back', async () => {
    const config = markdownProject();
    const file = JSON.parse(bytes());
    const base = await start({ config });
    expect(statusOf(await setup(base), 'jira-app')).toBe('skipped');

    writeConfig({ ...file, stories: { adapter: 'jira', site: SITE, jql: 'project = ACME ORDER BY Rank' } });
    const jira = await setup(base);
    for (const id of JIRA_STEPS) expect(statusOf(jira, id), id).not.toBe('skipped');
    expect(offIds(jira)).not.toContain('jira');

    writeConfig(file);
    const back = await setup(base);
    for (const id of JIRA_STEPS) expect(statusOf(back, id), id).toBe('skipped');
    expect(back.off).toEqual([JIRA_OFF]);
  });

  it('keeps the last valid config while foreman.config.json is broken', async () => {
    const config = markdownProject();
    const base = await start({ config });
    expect((await setup(base)).off).toEqual([JIRA_OFF]);

    writeFileSync(configFile(), '{ "version": 1, "project": ');
    const broken = await setup(base);
    for (const id of JIRA_STEPS) expect(statusOf(broken, id), id).toBe('skipped');
    expect(broken.off).toEqual([JIRA_OFF]);
  });

  it('follows the local settings too', async () => {
    markdownProject();
    writeConfig({ ...JSON.parse(bytes()), stories: { adapter: 'jira', site: SITE } });
    const base = await start();
    const jql = (body) => body.steps.find((s) => s.id === 'jira-site').inputs.find((i) => i.name === 'stories.jql');
    expect(jql(await setup(base)).present).toBe(false);
    mkdirSync(join(dir, '.foreman'), { recursive: true });
    writeFileSync(join(dir, '.foreman', 'settings.json'), JSON.stringify({ 'stories.jql': 'project = ACME ORDER BY Rank' }));
    expect(jql(await setup(base)).present).toBe(true);
  });
});

describe('the Salesforce pack switch, on a project with sfdx-project.json', () => {
  it('turns the pack on with one sandbox, then off again', async () => {
    sfdxProject();
    const base = await start();
    const before = await setup(base);
    expect(offIds(before)).toEqual(['jira', 'salesforce']);
    for (const id of SF_STEPS) expect(statusOf(before, id), id).toBe('skipped');
    expect(before.steps.find((s) => s.id === 'project').projectNow).toEqual({ source: 'markdown', pack: 'none', sfdx: true });

    const on = await post(`${base}${WRITE}`, { change: { pack: 'salesforce', alias: 'dev', orgId: '00D000000000001' } });
    expect(on.status, on.text).toBe(200);
    expect(on.body.lines.at(-1)).toBe(COMMIT_REMINDER);
    const loaded = loadConfig(dir);
    expect(loaded.errors ?? []).toEqual([]);
    expect(loaded.config.pack).toBe('salesforce');
    expect(loaded.config.ship.steps).toContain('sf-org-guard');

    const after = await setup(base);
    for (const id of SF_STEPS) expect(statusOf(after, id), id).not.toBe('skipped');
    expect(offIds(after)).toContain('gearset');
    expect(offIds(after)).not.toContain('salesforce');
    expect(after.off.find((e) => e.id === 'gearset').turnOn).toEqual({ label: 'Turn on', step: 'sf-layout' });

    const off = await post(`${base}${WRITE}`, { change: { pack: 'none' } });
    expect(off.status, off.text).toBe(200);
    const back = loadConfig(dir);
    expect(back.errors ?? []).toEqual([]);
    expect(back.config.pack).toBeUndefined();
    expect(back.config.ship.steps).not.toContain('sf-org-guard');
    const last = await setup(base);
    for (const id of SF_STEPS) expect(statusOf(last, id), id).toBe('skipped');
    expect(offIds(last)).toEqual(['jira', 'salesforce']);
  });
});

describe('a change that cannot be made writes nothing', () => {
  const refused = async (base, body, status) => {
    const before = bytes();
    const r = await post(`${base}${WRITE}`, body);
    expect(r.status, r.text).toBe(status);
    expect(bytes().equals(before)).toBe(true);
    return r.body;
  };

  it('refuses the pack without sfdx-project.json', async () => {
    markdownProject();
    const base = await start();
    const r = await refused(base, { change: { pack: 'salesforce', alias: 'dev', orgId: '00D000000000001' } }, 400);
    expect(r.errors).toEqual([WORDS.noSalesforce]);
  });

  it("passes on the config's own errors: a bad org ID, a production alias", async () => {
    sfdxProject();
    const base = await start();
    const bad = await refused(base, { change: { pack: 'salesforce', alias: 'dev', orgId: '00Dnope' } }, 400);
    expect(bad.errors.some((e) => e.startsWith('salesforce.orgs.dev.orgId'))).toBe(true);
    const prod = await refused(base, { change: { pack: 'salesforce', alias: 'prod', orgId: '00D000000000001' } }, 400);
    expect(prod.error).toMatch(/production/);
  });

  it('refuses a change sent with answers, and an unknown change without repeating it', async () => {
    markdownProject();
    const base = await start();
    expect((await refused(base, { change: { source: 'jira' }, answers: {} }, 400)).error).toBe(WORDS.badChange);
    expect((await refused(base, { change: { source: 'jira' }, config: {} }, 400)).error).toBe(WORDS.badChange);
    const unknown = await refused(base, { change: { acmeHidden: 'x' } }, 400);
    expect(unknown.errors).toEqual([WORDS.unknownChange]);
    expect(JSON.stringify(unknown)).not.toContain('acmeHidden');
  });

  it('refuses a change that is not text, in words that fit the change form', async () => {
    markdownProject();
    const base = await start();
    expect((await refused(base, { change: { source: ['jira'] } }, 400)).errors).toEqual([WORDS.changeNotText]);
  });

  it('keeps the 409 for answers on a project that has a config', async () => {
    markdownProject();
    const base = await start();
    const r = await refused(base, { answers: { name: 'Acme', source: 'markdown', dir: 'stories', check: 'true', ci: [] } }, 409);
    expect(r.error).toMatch(/already has foreman\.config\.json/);
  });

  it('answers a change in set-up mode with finish set-up first', async () => {
    const base = await start({ config: null });
    const r = await post(`${base}${WRITE}`, { change: { source: 'jira' } });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe(SETUP_FIRST);
  });
});

describe('the change keeps the dashboard gates', () => {
  const body = JSON.stringify({ change: { source: 'jira' } });
  const send = (base, headers = {}, method = 'POST') =>
    raw(base, WRITE, { method, headers: method === 'POST' ? { 'content-type': 'application/json', ...headers } : headers, body: method === 'POST' ? body : undefined });

  it('needs the token on another host, and then works there: it writes config only', async () => {
    markdownProject();
    const before = bytes();
    const base = await start({ host: '0.0.0.0', env: { FOREMAN_DASHBOARD_TOKEN: TOKEN } });
    const no = await send(base);
    expect(no.status).toBe(401);
    expect(bytes().equals(before)).toBe(true);
    const yes = await send(base, { authorization: `Bearer ${TOKEN}` });
    expect(yes.status, yes.body).toBe(200);
    expect(JSON.parse(bytes()).stories.adapter).toBe('jira');
  });

  it('refuses a reserved org alias from another host, with the token too, and writes nothing', async () => {
    sfdxProject();
    const before = bytes();
    const base = await start({ host: '0.0.0.0', env: { FOREMAN_DASHBOARD_TOKEN: TOKEN } });
    const proto = JSON.stringify({ change: { pack: 'salesforce', alias: '__proto__', orgId: '00D000000000001' } });
    const sendProto = (headers = {}) => raw(base, WRITE, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: proto });
    const yes = await sendProto({ authorization: `Bearer ${TOKEN}` });
    expect(yes.status, yes.body).toBe(400);
    const errors = JSON.parse(yes.body).errors;
    expect(errors.some((e) => e.startsWith('salesforce.orgs.__proto__')), JSON.stringify(errors)).toBe(true);
    expect(bytes().equals(before)).toBe(true);
    const no = await sendProto();
    expect(no.status).toBe(401);
    expect(bytes().equals(before)).toBe(true);
  });

  it('refuses another origin, plain text, a GET and another Host on 127.0.0.1', async () => {
    markdownProject();
    const before = bytes();
    const base = await start();
    expect((await send(base, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await send(base, { 'content-type': 'text/plain' })).status).toBe(415);
    const get = await send(base, {}, 'GET');
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe('POST');
    expect((await send(base, { host: 'evil.example' })).status).toBe(403);
    expect(bytes().equals(before)).toBe(true);
  });
});

describe('no secret in any answer', () => {
  it('never carries a saved key or a token file', async () => {
    markdownProject();
    const { accessToken, refreshToken } = fake.issueTokens();
    writeToken(SITE, { cloudId: 'cloud-acme-1', site: SITE, accessToken, refreshToken, expiresAt: '2026-10-25T10:00:00.000Z' }, { env: { HOME: home } });
    const tokenText = readFileSync(join(home, '.config', 'foreman', `jira-${SITE}.json`), 'utf8');
    const base = await start();
    await setup(base);
    expect((await post(`${base}${WRITE}`, { change: { source: 'jira' } })).status).toBe(200);
    expect((await post(`${base}/api/setup/keys`, { name: 'JIRA_CLIENT_SECRET', value: fake.clientSecret })).status).toBe(200);
    await setup(base);
    await post(`${base}${WRITE}`, { change: { source: 'markdown' } });
    await setup(base);
    for (const s of [fake.clientSecret, accessToken, refreshToken, tokenText.trim()]) expect(seen).not.toContain(s);
  });
});
