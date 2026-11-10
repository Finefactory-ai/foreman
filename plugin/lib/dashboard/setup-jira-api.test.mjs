// The Jira set-up API: POST/GET /api/setup/jira/login, POST /api/setup/jira/site,
// GET /api/setup/jira/projects, POST /api/setup/jira/preview, GET /api/setup/jira/statuses and
// POST /api/setup/jira/save, plus the jira-site step's jiraConfig in GET /api/setup.
// No token, code or client secret ever comes back out.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardServer } from './server.mjs';
import { loadConfig } from '../config/load.mjs';
import { readToken, tokenPath, writeToken } from '../jira/auth.mjs';
import { SETUP_FIRST } from '../setup/steps.mjs';
import { MAX_JQL, WORDS } from '../setup/jira.mjs';
import { checkOptions } from '../adapters/stories/jira.mjs';
import { COMMIT_REMINDER } from '../settings/change.mjs';
import { startFakeAtlassian } from '../../../test/fake-atlassian.mjs';

const TOKEN = 'acme-dashboard-token-0123456789abcdef';
const NOW = '2026-10-24T09:00:00.000Z';
const SITE = 'acme.atlassian.net';
const LABS = 'acme-labs.atlassian.net';
const LOCAL_ONLY =
  'Jira sign-in works only on a dashboard that listens on this computer alone (127.0.0.1). To use it from another machine, open it through an SSH tunnel.';

let dir;
let home;
let fake;
let servers;
let fakes;
let seen; // the text of every response a test got

const configFile = () => join(dir, 'foreman.config.json');
const savedConfig = () => JSON.parse(readFileSync(configFile(), 'utf8'));
const tokenEnv = () => ({ HOME: home });

function project(stories = { adapter: 'jira' }) {
  writeFileSync(configFile(), `${JSON.stringify({ version: 1, project: { name: 'Acme' }, stories }, null, 2)}\n`);
  return loadConfig(dir).config;
}

const keys = (text = `JIRA_CLIENT_ID=${fake.clientId}\nJIRA_CLIENT_SECRET=${fake.clientSecret}\n`) =>
  writeFileSync(join(dir, '.env.foreman'), text, { mode: 0o600 });

async function useFake(options) {
  fake = await startFakeAtlassian(options);
  fakes.push(fake);
  keys();
  return fake;
}

async function start({ host = '127.0.0.1', env = {}, config = loadConfig(dir).config, now = () => new Date(NOW), ...rest } = {}) {
  const cfg = config ? { ...config, console: { ...config.console, host } } : null;
  const server = createDashboardServer({
    root: dir,
    config: cfg,
    host,
    env: { HOME: home, FOREMAN_JIRA_AUTH_BASE: fake.url, FOREMAN_JIRA_API_BASE: fake.url, ...env },
    now,
    jiraPort: 0,
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

// Plays the browser: follow the consent address to the fake, which redirects to the callback.
async function browse(authorize, { tamper } = {}) {
  const res = await fetch(authorize, { redirect: 'manual' });
  expect(res.status).toBe(302);
  const callback = new URL(res.headers.get('location'));
  if (tamper) tamper(callback);
  const answer = await fetch(callback);
  const text = await answer.text();
  seen += text;
  return { status: answer.status, text };
}

// GET /api/setup/jira/login until the sign-in is no longer waiting.
async function settled(base) {
  for (let i = 0; i < 100; i += 1) {
    const r = await call(`${base}/api/setup/jira/login`);
    if (r.body?.status !== 'waiting') return r;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the sign-in stayed waiting');
}

async function signInThroughBrowser(base, tamper) {
  const started = await post(`${base}/api/setup/jira/login`);
  expect(started.status).toBe(200);
  const page = await browse(started.body.url, { tamper });
  return { started, page, after: await settled(base) };
}

// As jira.test.mjs: a working token file without the browser.
function signIn(site = SITE, cloudId = 'cloud-acme-1') {
  const { accessToken, refreshToken } = fake.issueTokens();
  writeToken(site, {
    cloudId, site, accessToken, refreshToken,
    expiresAt: '2026-10-24T10:00:00.000Z',
    account: { accountId: fake.account.accountId, displayName: 'Ada Lovelace' },
  }, { env: tokenEnv() });
}

const assertNoSecrets = () => {
  for (const f of fakes) for (const s of f.secrets()) expect(seen).not.toContain(s);
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'foreman-setup-jira-'));
  home = mkdtempSync(join(tmpdir(), 'foreman-setup-jira-home-'));
  servers = [];
  fakes = [];
  seen = '';
  spawnSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, '.gitignore'), '.env.foreman\n');
});
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((resolve) => (s.listening ? s.close(() => resolve()) : resolve()))));
  await Promise.all(fakes.map((f) => f.close()));
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('signing in from the dashboard', () => {
  it('refuses a callback whose state does not match, and saves nothing', async () => {
    await useFake();
    project();
    const { base } = await start();
    const { page, after } = await signInThroughBrowser(base, (cb) => cb.searchParams.set('state', 'forged'));
    expect(page.status).toBe(400);
    expect(page.text).toContain('Go back to Foreman and sign in again.');
    expect(after.body.status).toBe('failed');
    expect(after.body.error).toMatch(/did not match/);
    expect(fake.tokenCalls).toBe(0);
    expect(readToken(SITE, { env: tokenEnv() })).toBeNull();
    expect(savedConfig().stories.site).toBeUndefined();
  });

  it('picks the only site the sign-in can reach, and saves it as stories.site', async () => {
    await useFake();
    project();
    const { base } = await start();
    const { started, page, after } = await signInThroughBrowser(base);
    expect(started.body).toMatchObject({ ok: true, status: 'waiting' });
    expect(started.body.url.startsWith(`${fake.url}/authorize?`)).toBe(true);
    expect(page.status).toBe(200);
    expect(page.text).toContain(`Signed in to ${SITE} as Ada Lovelace. You can close this tab.`);
    expect(after.status).toBe(200);
    expect(after.body).toEqual({ status: 'signed-in', site: SITE, account: 'Ada Lovelace' });
    expect(savedConfig().stories.site).toBe(SITE);
    expect(readToken(SITE, { env: tokenEnv() })).toMatchObject({ cloudId: 'cloud-acme-1', site: SITE });
    expect(statSync(tokenPath(SITE, { env: tokenEnv() })).mode & 0o777).toBe(0o600);
    assertNoSecrets();
  });

  it('lists several sites to pick from, keeps the tokens in memory, then saves the one picked', async () => {
    await useFake({
      sites: [
        { id: 'cloud-acme-1', name: 'Acme', url: 'https://acme.atlassian.net' },
        { id: 'cloud-acme-2', name: 'Acme Labs', url: 'https://acme-labs.atlassian.net' },
      ],
    });
    project();
    const { base } = await start();
    const { page, after } = await signInThroughBrowser(base);
    expect(page.text).toContain('Signed in. Go back to Foreman to pick your Jira site.');
    expect(after.body).toEqual({
      status: 'pick-site',
      sites: [{ site: SITE, name: 'Acme' }, { site: LABS, name: 'Acme Labs' }],
    });
    expect(after.text).not.toContain('cloud-acme');
    expect(existsSync(tokenPath(SITE, { env: tokenEnv() }))).toBe(false);
    expect(existsSync(tokenPath(LABS, { env: tokenEnv() }))).toBe(false);
    expect(savedConfig().stories.site).toBeUndefined();

    const wrong = await post(`${base}/api/setup/jira/site`, { site: 'nope.atlassian.net' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe('Pick one of the sites the sign-in can reach.');
    expect(wrong.text).not.toContain('nope');

    const picked = await post(`${base}/api/setup/jira/site`, { site: LABS });
    expect(picked.status).toBe(200);
    expect(picked.body).toEqual({ ok: true, status: 'signed-in', site: LABS, account: 'Ada Lovelace' });
    expect(readToken(LABS, { env: tokenEnv() })).toMatchObject({ cloudId: 'cloud-acme-2', site: LABS });
    expect(savedConfig().stories.site).toBe(LABS);
    expect((await call(`${base}/api/setup/jira/login`)).body).toEqual({ status: 'signed-in', site: LABS, account: 'Ada Lovelace' });
    assertNoSecrets();

    const { base: fresh } = await start();
    const none = await post(`${fresh}/api/setup/jira/site`, { site: LABS });
    expect(none.status).toBe(409);
    expect(none.body.error).toBe('Sign in to Jira first.');
  });

  it('fails in plain words when the configured site is not one the sign-in can reach', async () => {
    await useFake();
    project({ adapter: 'jira', site: 'other.atlassian.net' });
    const { base } = await start();
    const { page, after } = await signInThroughBrowser(base);
    expect(page.text).toContain('The sign-in failed. Go back to Foreman to see why.');
    expect(after.body.status).toBe('failed');
    expect(after.body.error).toContain('other.atlassian.net');
    expect(after.body.error).toContain(SITE);
    expect(readToken('other.atlassian.net', { env: tokenEnv() })).toBeNull();
    assertNoSecrets();
  });

  it('signs in to the configured site when it is set', async () => {
    await useFake();
    project({ adapter: 'jira', site: SITE });
    const { base } = await start();
    const { after } = await signInThroughBrowser(base);
    expect(after.body).toEqual({ status: 'signed-in', site: SITE, account: 'Ada Lovelace' });
    assertNoSecrets();
  });

  it('shows an earlier sign-in from the token file, and idle without one', async () => {
    await useFake();
    project({ adapter: 'jira', site: SITE });
    const { base } = await start();
    expect((await call(`${base}/api/setup/jira/login`)).body).toEqual({ status: 'idle' });
    signIn();
    expect((await call(`${base}/api/setup/jira/login`)).body).toEqual({ status: 'signed-in', site: SITE, account: 'Ada Lovelace' });
    assertNoSecrets();
  });

  it('names the missing client keys without any value', async () => {
    await useFake();
    project();
    keys(`JIRA_CLIENT_ID=${fake.clientId}\n`);
    const { base } = await start();
    const r = await post(`${base}/api/setup/jira/login`);
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('JIRA_CLIENT_SECRET');
    expect(r.text).not.toContain(fake.clientId);
    expect(fake.authorizeCalls).toEqual([]);
  });

  it('says the port is in use in plain words', async () => {
    await useFake();
    project();
    const busy = net.createServer();
    await new Promise((resolve) => busy.listen(0, '127.0.0.1', resolve));
    const { port } = busy.address();
    try {
      const { base } = await start({ jiraPort: port });
      const r = await post(`${base}/api/setup/jira/login`);
      expect(r.status).toBe(409);
      expect(r.body.error).toBe(`Port ${port} is in use, so the sign-in cannot start. Close what uses it and try again.`);
    } finally {
      await new Promise((resolve) => busy.close(resolve));
    }
  });

  it('says Atlassian refused the sign-in when the code swap fails', async () => {
    await useFake();
    project();
    const { base } = await start();
    const { page, after } = await signInThroughBrowser(base, (cb) => cb.searchParams.set('code', 'acme-bogus-code'));
    expect(page.status).toBe(500);
    expect(page.text).toContain(WORDS.pageFailed);
    expect(page.text).not.toContain(fake.clientSecret);
    expect(after.body).toEqual({ status: 'failed', error: WORDS.tokenRefused });
    expect(fake.tokenCalls).toBe(1);
    expect(readToken(SITE, { env: tokenEnv() })).toBeNull();
    expect(savedConfig().stories.site).toBeUndefined();
    assertNoSecrets();
  });

  it('says no sign-in arrived when the wait runs out', async () => {
    await useFake();
    project();
    const { base } = await start({ jiraLoginTimeoutMs: 60 });
    const started = await post(`${base}/api/setup/jira/login`);
    expect(started.status).toBe(200);
    expect(started.body.status).toBe('waiting');
    const after = await settled(base);
    expect(after.body).toEqual({ status: 'failed', error: WORDS.timeout });
    const callback = new URL(new URL(started.body.url).searchParams.get('redirect_uri'));
    callback.hostname = '127.0.0.1';
    await expect(fetch(`${callback.origin}/callback`)).rejects.toThrow();
    expect(fake.tokenCalls).toBe(0);
    assertNoSecrets();
  });

  it('says Atlassian did not sign you in, with the reason cleaned', async () => {
    await useFake();
    project();
    const { base } = await start();
    const { page, after } = await signInThroughBrowser(base, (cb) => {
      cb.searchParams.delete('code');
      cb.searchParams.set('error', 'access_denied<script>');
    });
    expect(page.status).toBe(400);
    expect(page.text).not.toContain('<script>');
    expect(after.body).toEqual({ status: 'failed', error: WORDS.denied('access_deniedscript') });
    expect(after.body.error).toBe('Atlassian did not sign you in (access_deniedscript).');
    expect(fake.tokenCalls).toBe(0);
    assertNoSecrets();
  });

  it('escapes the account name on the browser page', async () => {
    const name = '<img src=x onerror=alert(1)> & Co';
    await useFake({ account: { accountId: '5b10ac8d82e05b22cc7d4ef5', displayName: name } });
    project();
    const { base } = await start();
    const { page, after } = await signInThroughBrowser(base);
    expect(page.status).toBe(200);
    expect(page.text).toContain('as &lt;img src=x onerror=alert(1)&gt; &amp; Co. You can close this tab.');
    expect(page.text).not.toContain('<img');
    expect(after.body.account).toBe(name);
  });

  it('forgets the tokens of a sign-in whose site is not picked in time', async () => {
    await useFake({
      sites: [
        { id: 'cloud-acme-1', name: 'Acme', url: 'https://acme.atlassian.net' },
        { id: 'cloud-acme-2', name: 'Acme Labs', url: 'https://acme-labs.atlassian.net' },
      ],
    });
    project();
    const { base } = await start({ jiraLoginTimeoutMs: 2000 });
    const { after } = await signInThroughBrowser(base);
    expect(after.body.status).toBe('pick-site');
    let now = after;
    for (let waited = 0; now.body?.status === 'pick-site' && waited < 6000; waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      now = await call(`${base}/api/setup/jira/login`);
    }
    expect(now.body).toEqual({ status: 'failed', error: WORDS.pickTimeout });
    const late = await post(`${base}/api/setup/jira/site`, { site: LABS });
    expect(late.status).toBe(409);
    expect(late.body.error).toBe('Sign in to Jira first.');
    expect(existsSync(tokenPath(SITE, { env: tokenEnv() }))).toBe(false);
    expect(existsSync(tokenPath(LABS, { env: tokenEnv() }))).toBe(false);
    expect(savedConfig().stories.site).toBeUndefined();
    assertNoSecrets();
  }, 15_000);

  it('closes the waiting callback server when the dashboard closes', async () => {
    await useFake();
    project();
    const { base, server } = await start();
    const started = await post(`${base}/api/setup/jira/login`);
    const callback = new URL(new URL(started.body.url).searchParams.get('redirect_uri'));
    callback.hostname = '127.0.0.1';
    expect((await fetch(`${callback.origin}/nothing`)).status).toBe(404);
    await new Promise((resolve) => server.close(() => resolve()));
    await expect(fetch(`${callback.origin}/callback`)).rejects.toThrow();
  });
});

describe('reading Jira for set-up', () => {
  it('turns a bad JQL into plain words, without the request path', async () => {
    await useFake();
    project({ adapter: 'jira', site: SITE });
    signIn();
    const { base } = await start();
    const bad = await post(`${base}/api/setup/jira/preview`, { jql: 'INVALID' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("Jira cannot run that filter: Error in the JQL Query: 'INVALID'");
    expect(bad.text).not.toContain('/rest/');
    expect(bad.text).not.toContain('(400)');
    const empty = await post(`${base}/api/setup/jira/preview`, { jql: '  ' });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBe('Type a JQL filter first.');
    const long = await post(`${base}/api/setup/jira/preview`, { jql: `project = ACME ${'x'.repeat(4000)}` });
    expect(long.status).toBe(400);
    expect(long.body.error).toBe('That filter is too long.');
    assertNoSecrets();
  });

  it('previews the first 10 issues and the approximate count', async () => {
    await useFake();
    project({ adapter: 'jira', site: SITE });
    signIn();
    const sent = [];
    fake.route('POST', /^\/rest\/api\/3\/search\/jql$/, (req, m, body) => {
      sent.push(body);
      return {
        body: {
          issues: [
            { key: 'ACME-1', fields: { summary: 'Add the sign-in page', status: { name: 'To Do' } } },
            { key: 'ACME-2', fields: { summary: 'Fix the footer', status: { name: 'In Progress' } } },
          ],
          isLast: true,
        },
      };
    });
    const { base } = await start();
    const r = await post(`${base}/api/setup/jira/preview`, { jql: 'project = ACME' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      issues: [
        { key: 'ACME-1', title: 'Add the sign-in page', status: 'To Do' },
        { key: 'ACME-2', title: 'Fix the footer', status: 'In Progress' },
      ],
      count: 3,
    });
    expect(sent[0]).toMatchObject({ jql: 'project = ACME', maxResults: 10 });
    assertNoSecrets();
  });

  it('gives a null count when the approximate count fails', async () => {
    await useFake();
    project({ adapter: 'jira', site: SITE });
    signIn();
    fake.route('POST', /^\/rest\/api\/3\/search\/approximate-count$/, () => ({ status: 500, body: { errorMessages: ['boom'] } }));
    const { base } = await start();
    const r = await post(`${base}/api/setup/jira/preview`, { jql: 'project = ACME' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ issues: [], count: null });
    assertNoSecrets();
  });

  it('limits previews to 5 a minute, with 429 and retry-after', async () => {
    await useFake();
    project({ adapter: 'jira', site: SITE });
    signIn();
    let clock = Date.parse(NOW);
    const { base } = await start({ now: () => new Date(clock) });
    for (let i = 0; i < 5; i += 1) {
      clock += 1000;
      expect((await post(`${base}/api/setup/jira/preview`, { jql: 'project = ACME' })).status).toBe(200);
    }
    clock += 1000;
    const sixth = await post(`${base}/api/setup/jira/preview`, { jql: 'project = ACME' });
    expect(sixth.status).toBe(429);
    expect(sixth.body).toEqual({ error: 'Too many tries for this step. Try again in 55 seconds.', retryAfter: 55 });
    expect(sixth.headers.get('retry-after')).toBe('55');
    expect(fake.requests.filter((r) => r.path.endsWith('/search/jql'))).toHaveLength(5);
    clock += 61_000;
    expect((await post(`${base}/api/setup/jira/preview`, { jql: 'project = ACME' })).status).toBe(200);
    assertNoSecrets();
  });

  it('lists the projects and the statuses of one, without duplicates', async () => {
    await useFake();
    project({ adapter: 'jira', site: SITE });
    signIn();
    const { base } = await start();
    const projects = await call(`${base}/api/setup/jira/projects`);
    expect(projects.status).toBe(200);
    expect(projects.body).toEqual({ projects: [{ key: 'ACME', name: 'Acme' }], more: false });
    const statuses = await call(`${base}/api/setup/jira/statuses?project=ACME`);
    expect(statuses.status).toBe(200);
    expect(statuses.body).toEqual({
      statuses: [
        { name: 'To Do', category: 'new' },
        { name: 'In Progress', category: 'indeterminate' },
        { name: 'Done', category: 'done' },
      ],
      suggested: { started: 'In Progress', blocked: null, review: null, failed: null, shipped: 'Done' },
    });
    const missing = await call(`${base}/api/setup/jira/statuses?project=NOPE1`);
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('Jira has no project with that key, or you cannot see it.');
    const odd = await call(`${base}/api/setup/jira/statuses?project=${encodeURIComponent('../x')}`);
    expect(odd.status).toBe(400);
    expect(odd.body.error).toBe('Pick a project from the list.');
    expect(odd.text).not.toContain('../x');
    assertNoSecrets();
  });

  it('says to sign in first, or again when the sign-in has expired', async () => {
    await useFake();
    project({ adapter: 'jira', site: SITE });
    const { base } = await start();
    for (const r of [
      await call(`${base}/api/setup/jira/projects`),
      await post(`${base}/api/setup/jira/preview`, { jql: 'project = ACME' }),
      await call(`${base}/api/setup/jira/statuses?project=ACME`),
    ]) {
      expect(r.status).toBe(409);
      expect(r.body.error).toBe('Sign in to Jira first.');
    }
    signIn();
    writeToken(SITE, { ...readToken(SITE, { env: tokenEnv() }), refreshToken: 'rt-old', expiresAt: '2026-10-24T08:00:00.000Z' }, { env: tokenEnv() });
    const expired = await call(`${base}/api/setup/jira/projects`);
    expect(expired.status).toBe(409);
    expect(expired.body.error).toBe('The Jira sign-in has expired. Sign in to Jira again.');
  });

  it('says to sign in first when no site is set', async () => {
    await useFake();
    project();
    const { base } = await start();
    const r = await call(`${base}/api/setup/jira/projects`);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('Sign in to Jira first.');
  });
});

describe('the filter screen', () => {
  const SAVE = { jql: 'project = ACME AND labels = foreman ORDER BY Rank', ownerLabel: 'acme-owner', transitions: { started: 'In Progress', shipped: 'Done' } };
  const save = (base, body = SAVE) => post(`${base}/api/setup/jira/save`, body);
  const bytes = () => readFileSync(configFile(), 'utf8');

  it("gives the jira-site step the project's stories settings, and no other step", async () => {
    await useFake();
    project();
    const { base } = await start();
    await signInThroughBrowser(base);
    const r = await call(`${base}/api/setup`);
    expect(r.status).toBe(200);
    const site = r.body.steps.find((s) => s.id === 'jira-site');
    expect(site.jiraConfig).toEqual({ site: SITE, jql: null, ownerLabel: 'foreman-owner', transitions: {}, transitionsSaved: false });
    expect(site.jira.part).toBe('filter');
    for (const step of r.body.steps) if (step.id !== 'jira-site') expect(Object.hasOwn(step, 'jiraConfig'), step.id).toBe(false);
    expect(r.body.steps.find((s) => s.id === 'jira-app').jira.part).toBe('app');
    expect(r.body.steps.find((s) => s.id === 'jira-signin').jira.part).toBe('signin');
    expect(r.text).not.toContain(fake.clientSecret);
    assertNoSecrets();
  });

  it('saves the filter, the owner label and the moves through the team layer', async () => {
    await useFake();
    project({ adapter: 'jira', site: SITE });
    signIn();
    const { base } = await start();
    const r = await save(base);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const stories = savedConfig().stories;
    expect(stories).toMatchObject({ adapter: 'jira', site: SITE, jql: SAVE.jql, ownerLabel: 'acme-owner', transitions: { started: 'In Progress', shipped: 'Done' } });
    const { adapter, ...options } = stories;
    expect(adapter).toBe('jira');
    expect(() => checkOptions(options)).not.toThrow();
    expect(loadConfig(dir).errors ?? []).toEqual([]);
    expect(r.body.lines.at(-1)).toBe(COMMIT_REMINDER);
    expect(r.body.lines.filter((l) => l === COMMIT_REMINDER)).toHaveLength(1);
    expect(r.body.lines.length).toBeGreaterThan(1);
    expect(typeof r.body.configDirty).toBe('boolean');
    expect(r.body.stories).toEqual({ site: SITE, jql: SAVE.jql, ownerLabel: 'acme-owner', transitions: { started: 'In Progress', shipped: 'Done' }, transitionsSaved: true });
    assertNoSecrets();

    const before = bytes();
    const again = await save(base);
    expect(again.status).toBe(200);
    expect(again.body.lines).toEqual(['Nothing changed.']);
    expect(bytes()).toBe(before);
  });

  it('leaves an event where it is by leaving it out', async () => {
    await useFake();
    project({ adapter: 'jira', site: SITE, jql: SAVE.jql, ownerLabel: 'acme-owner', transitions: { started: 'In Progress', shipped: 'Done' } });
    signIn();
    const { base } = await start();
    const r = await save(base, { ...SAVE, transitions: { started: 'In Progress' } });
    expect(r.status).toBe(200);
    expect(savedConfig().stories.transitions).toEqual({ started: 'In Progress' });
    expect(r.body.lines.filter((l) => l === COMMIT_REMINDER)).toHaveLength(1);
    // The next visit knows moves were saved, so the page never re-suggests shipped.
    const setup = await call(`${base}/api/setup`);
    const site = setup.body.steps.find((s) => s.id === 'jira-site');
    expect(site.jiraConfig).toMatchObject({ transitions: { started: 'In Progress' }, transitionsSaved: true });
  });

  it('says moves were saved once the project has any', async () => {
    await useFake();
    project({ adapter: 'jira', site: SITE, jql: SAVE.jql, transitions: { started: 'In Progress' } });
    signIn();
    const { base } = await start();
    const r = await call(`${base}/api/setup`);
    expect(r.status).toBe(200);
    expect(r.body.steps.find((s) => s.id === 'jira-site').jiraConfig.transitionsSaved).toBe(true);
  });

  it('trims each move before comparing and writing', async () => {
    await useFake();
    project({ adapter: 'jira', site: SITE });
    signIn();
    const { base } = await start();
    const padded = { ...SAVE, transitions: { started: ' In Progress ', shipped: '\tDone ' } };
    const r = await save(base, padded);
    expect(r.status).toBe(200);
    expect(savedConfig().stories.transitions).toEqual({ started: 'In Progress', shipped: 'Done' });
    const before = bytes();
    const again = await save(base, padded);
    expect(again.status).toBe(200);
    expect(again.body.lines).toEqual(['Nothing changed.']);
    expect(bytes()).toBe(before);
  });

  it('records no moves once on a fresh project, and nothing on the second save', async () => {
    await useFake();
    project({ adapter: 'jira', site: SITE, jql: SAVE.jql });
    signIn();
    const { base } = await start();
    const body = { jql: SAVE.jql, ownerLabel: 'foreman-owner', transitions: {} };
    const r = await save(base, body);
    expect(r.status).toBe(200);
    const stories = savedConfig().stories;
    expect(stories.transitions).toEqual({});
    expect(Object.hasOwn(stories, 'ownerLabel')).toBe(false);
    expect(r.body.lines.at(-1)).toBe(COMMIT_REMINDER);
    expect(r.body.lines.filter((l) => l === COMMIT_REMINDER)).toHaveLength(1);
    expect(r.body.stories.transitionsSaved).toBe(true);

    const before = bytes();
    const again = await save(base, body);
    expect(again.status).toBe(200);
    expect(again.body.lines).toEqual(['Nothing changed.']);
    expect(bytes()).toBe(before);
  });

  it('refuses a body it cannot save, in plain words, and writes nothing', async () => {
    await useFake();
    project({ adapter: 'jira', site: SITE });
    signIn();
    const { base } = await start();
    const before = bytes();
    const cases = [
      [{ ...SAVE, extra: 1 }, WORDS.badSave],
      [{ jql: SAVE.jql, ownerLabel: 'acme-owner' }, WORDS.badSave],
      [{ ...SAVE, jql: '   ' }, WORDS.typeFilter],
      [{ ...SAVE, jql: 'x'.repeat(MAX_JQL + 1) }, WORDS.filterTooLong],
      [{ ...SAVE, ownerLabel: 'acme owner' }, WORDS.badOwnerLabel],
      [{ ...SAVE, ownerLabel: '' }, WORDS.badOwnerLabel],
      [{ ...SAVE, transitions: { merged: 'Done' } }, WORDS.badMoves],
      [{ ...SAVE, transitions: { shipped: 7 } }, WORDS.badMoves],
      [{ ...SAVE, transitions: { shipped: '' } }, WORDS.badMoves],
      [{ ...SAVE, transitions: { shipped: '   ' } }, WORDS.badMoves],
      [{ ...SAVE, transitions: ['Done'] }, WORDS.badMoves],
    ];
    for (const [body, error] of cases) {
      const r = await save(base, body);
      expect(r.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(r.body.error).toBe(error);
    }
    const merged = await save(base, { ...SAVE, transitions: { merged: 'Done' } });
    expect(merged.text).not.toContain('merged');
    const blank = await save(base, { ...SAVE, transitions: { shipped: '   ' } });
    expect(blank.text).not.toContain('shipped');
    expect(bytes()).toBe(before);
  });

  it('says to sign in first when no site is set', async () => {
    await useFake();
    project();
    const { base } = await start();
    const before = bytes();
    const r = await save(base);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('Sign in to Jira first.');
    expect(bytes()).toBe(before);
  });

  it('refuses a project whose stories are not in Jira, and set-up mode', async () => {
    await useFake();
    project({ adapter: 'markdown', dir: 'stories' });
    const { base } = await start();
    const r = await save(base);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('This project does not take its stories from Jira.');
    rmSync(configFile());
    const { base: bare } = await start({ config: null });
    const none = await save(bare);
    expect(none.status).toBe(409);
    expect(none.body.error).toBe(SETUP_FIRST);
  });
});

describe('which projects it serves', () => {
  it('refuses a project whose stories are not in Jira', async () => {
    await useFake();
    project({ adapter: 'markdown', dir: 'stories' });
    const { base } = await start();
    const r = await call(`${base}/api/setup/jira/login`);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('This project does not take its stories from Jira.');
  });

  it('says to finish set-up first in set-up mode', async () => {
    await useFake();
    const { base } = await start({ config: null });
    for (const r of [await call(`${base}/api/setup/jira/login`), await post(`${base}/api/setup/jira/login`)]) {
      expect(r.status).toBe(409);
      expect(r.body.error).toBe(SETUP_FIRST);
    }
  });
});

describe('every Jira set-up route keeps the dashboard gates', () => {
  const ROUTES = [
    { path: '/api/setup/jira/login', method: 'POST', body: () => ({}), wrong: 'PUT', allow: 'GET, POST' },
    { path: '/api/setup/jira/login', method: 'GET', wrong: 'DELETE', allow: 'GET, POST' },
    { path: '/api/setup/jira/site', method: 'POST', body: () => ({ site: SITE }), wrong: 'GET', allow: 'POST' },
    { path: '/api/setup/jira/projects', method: 'GET', wrong: 'POST', allow: 'GET' },
    { path: '/api/setup/jira/preview', method: 'POST', body: () => ({ jql: 'project = ACME' }), wrong: 'GET', allow: 'POST' },
    { path: '/api/setup/jira/statuses?project=ACME', method: 'GET', wrong: 'POST', allow: 'GET' },
    { path: '/api/setup/jira/save', method: 'POST', body: () => ({ jql: 'project = ACME', ownerLabel: 'foreman-owner', transitions: {} }), wrong: 'GET', allow: 'POST' },
  ];
  const send = (base, route, headers = {}, body) =>
    raw(base, route.path, {
      method: route.method,
      headers: route.method === 'POST' ? { 'content-type': 'application/json', ...headers } : headers,
      body: route.method === 'POST' ? (body ?? JSON.stringify(route.body())) : undefined,
    });

  it('refuses sign-in on a dashboard other computers can reach, even with the token', async () => {
    await useFake();
    project();
    const { base } = await start({ host: '0.0.0.0', env: { FOREMAN_DASHBOARD_TOKEN: TOKEN } });
    const auth = { authorization: `Bearer ${TOKEN}` };
    for (const [path, body] of [['/api/setup/jira/login', {}], ['/api/setup/jira/site', { site: SITE }]]) {
      const r = await post(`${base}${path}`, body, auth);
      expect(r.status, path).toBe(403);
      expect(r.body.error).toBe(LOCAL_ONLY);
    }
    const status = await call(`${base}/api/setup/jira/login`, { headers: auth });
    expect(status.status).toBe(200);
    expect(status.body).toEqual({ status: 'idle' });
    expect(existsSync(tokenPath(SITE, { env: tokenEnv() }))).toBe(false);
  });

  it('needs the token on another host', async () => {
    await useFake();
    project();
    const { base } = await start({ host: '0.0.0.0', env: { FOREMAN_DASHBOARD_TOKEN: TOKEN } });
    for (const route of ROUTES) {
      const res = await send(base, route);
      expect(res.status, route.path).toBe(401);
      expect(res.headers['www-authenticate'], route.path).toBe('Bearer');
    }
  });

  it('refuses another Host on 127.0.0.1, another origin, plain text, a big body and the wrong method', async () => {
    await useFake();
    project();
    const { base } = await start();
    for (const route of ROUTES) {
      expect((await send(base, route, { host: 'evil.example' })).status, `${route.path} host`).toBe(403);
      expect((await send(base, route, { origin: 'https://evil.example' })).status, `${route.path} origin`).toBe(403);
      if (route.method === 'POST') {
        expect((await send(base, route, { 'content-type': 'text/plain' })).status, `${route.path} text`).toBe(415);
        const big = JSON.stringify({ ...route.body(), pad: 'x'.repeat(70 * 1024) });
        expect((await send(base, route, {}, big)).status, `${route.path} big`).toBe(413);
      }
      const wrong = await raw(base, route.path, { method: route.wrong });
      expect(wrong.status, `${route.path} method`).toBe(405);
      expect(wrong.headers.allow, `${route.path} allow`).toBe(route.allow);
    }
    expect(fake.authorizeCalls).toEqual([]);
  });
});
