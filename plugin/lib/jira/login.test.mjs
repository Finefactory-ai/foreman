// The Jira sign-in mechanics shared by `foreman jira login` and the set-up API: the one-shot
// callback server, the code swap, the site match and the token file.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { authorizeUrl, newState, readToken, tokenPath } from './auth.mjs';
import { callbackPage, callbackServer, exchangeForSites, saveSignIn, siteFor } from './login.mjs';
import { startFakeAtlassian } from '../../../test/fake-atlassian.mjs';

const NOW = () => new Date('2026-10-24T09:00:00Z');
let home;
let fake;
let env;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-jira-login-'));
  fake = await startFakeAtlassian();
  env = { HOME: home, FOREMAN_JIRA_AUTH_BASE: fake.url, FOREMAN_JIRA_API_BASE: fake.url, JIRA_CLIENT_ID: fake.clientId, JIRA_CLIENT_SECRET: fake.clientSecret };
});
afterEach(async () => {
  await fake.close();
  fs.rmSync(home, { recursive: true, force: true });
});

// A code from the fake, as the browser would bring back.
async function codeFor(redirectUri) {
  const res = await fetch(authorizeUrl({ clientId: fake.clientId, redirectUri, state: newState(), env }), { redirect: 'manual' });
  return new URL(res.headers.get('location')).searchParams.get('code');
}

describe('exchangeForSites', () => {
  it('swaps the code for tokens and lists the sites by host', async () => {
    const redirectUri = 'http://localhost:8765/callback';
    const { tokens, sites } = await exchangeForSites({ code: await codeFor(redirectUri), redirectUri, env, fetch: globalThis.fetch, now: NOW });
    expect(tokens.accessToken).toMatch(/^at-/);
    expect(tokens.refreshToken).toMatch(/^rt-/);
    expect(tokens.expiresAt).toBe('2026-10-24T10:00:00.000Z');
    expect(sites).toEqual([{ cloudId: 'cloud-acme-1', site: 'acme.atlassian.net', name: 'Acme' }]);
  });
});

describe('siteFor', () => {
  const sites = [
    { cloudId: 'cloud-acme-1', site: 'acme.atlassian.net', name: 'Acme' },
    { cloudId: 'cloud-acme-2', site: 'acme-labs.atlassian.net', name: 'Acme Labs' },
  ];

  it('finds the site', () => {
    expect(siteFor(sites, 'acme-labs.atlassian.net')).toEqual(sites[1]);
  });

  it('names both hosts when the sign-in cannot reach the wanted one', () => {
    let err;
    try {
      siteFor(sites.slice(0, 1), 'other.atlassian.net');
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe('site-unreachable');
    expect(err.message).toBe(
      'This sign-in cannot reach other.atlassian.net; it can reach acme.atlassian.net. Check stories.site, or grant the app access to other.atlassian.net.',
    );
  });
});

describe('callbackServer', () => {
  const caught = (promise) => promise.then(() => null, (e) => e);

  it('refuses a forged state with 400, the given last sentence and code state-mismatch', async () => {
    const server = await callbackServer({ port: 0, state: 'right-state', timeoutMs: 5000, again: 'Go back to Acme and try again.' });
    const waited = caught(server.wait());
    const res = await fetch(`http://127.0.0.1:${server.port}/callback?code=c&state=forged`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('its state did not match. Go back to Acme and try again.');
    expect((await waited).code).toBe('state-mismatch');
    server.close();
  });

  it('rejects an error the user chose with code denied and the reason', async () => {
    const server = await callbackServer({ port: 0, state: 's1', timeoutMs: 5000 });
    const waited = caught(server.wait());
    await fetch(`http://127.0.0.1:${server.port}/callback?error=access_denied&state=s1`);
    const err = await waited;
    expect(err.code).toBe('denied');
    expect(err.reason).toBe('access_denied');
    server.close();
  });

  it('rejects with code timeout when no callback comes', async () => {
    const server = await callbackServer({ port: 0, state: 's1', timeoutMs: 30 });
    expect((await caught(server.wait())).code).toBe('timeout');
    server.close();
  });

  it('rejects with code port-in-use on a busy port', async () => {
    const busy = net.createServer();
    await new Promise((resolve) => busy.listen(0, '127.0.0.1', resolve));
    const err = await caught(callbackServer({ port: busy.address().port, state: 's1', timeoutMs: 1000 }));
    expect(err.code).toBe('port-in-use');
    await new Promise((resolve) => busy.close(resolve));
  });
});

describe('saveSignIn', () => {
  it('writes the token file at mode 600 with the cloud id and the account', async () => {
    const tokens = { ...fake.issueTokens(), expiresAt: '2026-10-24T10:00:00.000Z', savedAt: '2026-10-24T09:00:00.000Z' };
    const account = await saveSignIn({ site: 'acme.atlassian.net', cloudId: 'cloud-acme-1', tokens, env, fetch: globalThis.fetch, now: NOW });
    expect(account).toEqual({ accountId: fake.account.accountId, displayName: 'Ada Lovelace' });
    const saved = readToken('acme.atlassian.net', { env });
    expect(saved).toMatchObject({ cloudId: 'cloud-acme-1', site: 'acme.atlassian.net', account: { displayName: 'Ada Lovelace' } });
    expect(fs.statSync(tokenPath('acme.atlassian.net', { env })).mode & 0o777).toBe(0o600);
  });
});

describe('callbackPage', () => {
  it('escapes the title and the text', () => {
    const html = callbackPage('<T&>', `a & b <script>"x"</script> 'y'`);
    expect(html).toContain('<title>&lt;T&amp;&gt;</title>');
    expect(html).toContain('<p>a &amp; b &lt;script&gt;&quot;x&quot;&lt;/script&gt; &#39;y&#39;</p>');
    expect(html).not.toContain('<script>');
  });
});
