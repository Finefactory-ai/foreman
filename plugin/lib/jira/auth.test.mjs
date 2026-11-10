import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  authorizeUrl,
  exchangeCode,
  refresh,
  resources,
  readToken,
  writeToken,
  deleteToken,
  tokenPath,
  tokenFor,
  normalizeSite,
  signedInSites,
  JiraLoginExpired,
  SCOPES,
} from './auth.mjs';
import { startFakeAtlassian } from '../../../test/fake-atlassian.mjs';

const SITE = 'acme.atlassian.net';
let home;
let fake;
let env;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-jira-home-'));
  fake = await startFakeAtlassian();
  env = {
    HOME: home,
    FOREMAN_JIRA_AUTH_BASE: fake.url,
    FOREMAN_JIRA_API_BASE: fake.url,
    JIRA_CLIENT_ID: fake.clientId,
    JIRA_CLIENT_SECRET: fake.clientSecret,
  };
});
afterEach(async () => {
  await fake.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const at = (iso) => () => new Date(iso);

function signedIn({ expiresAt = '2026-10-17T13:00:00.000Z' } = {}) {
  const { accessToken, refreshToken } = fake.issueTokens();
  const record = { cloudId: 'cloud-acme-1', site: SITE, accessToken, refreshToken, expiresAt, account: { accountId: 'x', displayName: 'Ada Lovelace' } };
  writeToken(SITE, record, { env });
  return record;
}

describe('authorizeUrl', () => {
  it('carries every parameter Atlassian requires, with scopes space-separated', () => {
    const u = new URL(authorizeUrl({ clientId: 'abc', scopes: SCOPES, redirectUri: 'http://localhost:8765/callback', state: 's1' }));
    expect(u.origin + u.pathname).toBe('https://auth.atlassian.com/authorize');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      audience: 'api.atlassian.com',
      client_id: 'abc',
      scope: 'read:jira-work write:jira-work read:jira-user offline_access',
      redirect_uri: 'http://localhost:8765/callback',
      state: 's1',
      response_type: 'code',
      prompt: 'consent',
    });
    expect(u.search).toContain('scope=read%3Ajira-work%20write');
  });

  it('uses FOREMAN_JIRA_AUTH_BASE when it is set', () => {
    const u = authorizeUrl({ clientId: 'abc', scopes: SCOPES, redirectUri: 'http://x/cb', state: 's', env: { FOREMAN_JIRA_AUTH_BASE: 'http://127.0.0.1:9/' } });
    expect(u.startsWith('http://127.0.0.1:9/authorize?')).toBe(true);
  });
});

describe('normalizeSite', () => {
  it('reduces a site to its host', () => {
    expect(normalizeSite('https://Acme.atlassian.net/')).toBe('acme.atlassian.net');
    expect(normalizeSite('acme.atlassian.net')).toBe('acme.atlassian.net');
  });
  it('refuses anything that is not a host name', () => {
    expect(() => normalizeSite('../../etc')).toThrow(/site/);
    expect(() => normalizeSite('')).toThrow(/site/);
  });
});

describe('the token file', () => {
  it('lives at ~/.config/foreman/jira-<site>.json under HOME, mode 600 in a 700 folder', () => {
    signedIn();
    const file = tokenPath(SITE, { env });
    expect(file).toBe(path.join(home, '.config', 'foreman', `jira-${SITE}.json`));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(readToken(SITE, { env }).site).toBe(SITE);
  });

  it('reads as null when missing, and deleteToken says whether there was one', () => {
    expect(readToken(SITE, { env })).toBeNull();
    expect(deleteToken(SITE, { env })).toBe(false);
    signedIn();
    expect(deleteToken(SITE, { env })).toBe(true);
    expect(readToken(SITE, { env })).toBeNull();
  });

  it('leaves no temporary files behind', () => {
    signedIn();
    signedIn();
    expect(fs.readdirSync(path.join(home, '.config', 'foreman'))).toEqual([`jira-${SITE}.json`]);
  });
});

describe('exchangeCode and resources', () => {
  it('swaps a code for tokens with a JSON body, then lists the sites', async () => {
    const redirectUri = 'http://localhost:8765/callback';
    const res = await fetch(authorizeUrl({ clientId: fake.clientId, scopes: SCOPES, redirectUri, state: 's', env }), { redirect: 'manual' });
    const code = new URL(res.headers.get('location')).searchParams.get('code');
    const t = await exchangeCode({ code, redirectUri, env, now: at('2026-10-17T12:00:00Z') });
    expect(t.accessToken).toMatch(/^at-/);
    expect(t.refreshToken).toMatch(/^rt-/);
    expect(t.expiresAt).toBe('2026-10-17T13:00:00.000Z');
    expect(t.savedAt).toBe('2026-10-17T12:00:00.000Z');
    const list = await resources(t.accessToken, { env });
    expect(list).toEqual([expect.objectContaining({ id: 'cloud-acme-1', url: 'https://acme.atlassian.net', name: 'Acme' })]);
  });

  it('a bad code fails without showing the code or the secret', async () => {
    const err = await exchangeCode({ code: 'code-wrong', redirectUri: 'http://x/cb', env }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toContain('code-wrong');
    expect(err.message).not.toContain(fake.clientSecret);
  });

  it("without the client keys says to set them in Foreman's own keys file, naming no file", async () => {
    const err = await exchangeCode({ code: 'c', redirectUri: 'http://x/cb', env: {} }).catch((e) => e);
    expect(err.message).toContain("Foreman's own keys file");
    expect(err.message).not.toContain('.env.foreman');
  });
});

describe('refresh', () => {
  it('rotates both tokens and writes them back', async () => {
    const before = signedIn();
    const after = await refresh(SITE, { env, now: at('2026-10-17T12:30:00Z') });
    expect(after.accessToken).not.toBe(before.accessToken);
    expect(after.refreshToken).not.toBe(before.refreshToken);
    expect(after.expiresAt).toBe('2026-10-17T13:30:00.000Z');
    expect(after.savedAt).toBe('2026-10-17T12:30:00.000Z');
    expect(after.account).toEqual(before.account);
    const saved = readToken(SITE, { env });
    expect(saved.accessToken).toBe(after.accessToken);
    expect(saved.refreshToken).toBe(after.refreshToken);
    expect(fs.statSync(tokenPath(SITE, { env })).mode & 0o777).toBe(0o600);
    expect(fake.isRetired(before.refreshToken)).toBe(true);
  });

  it('an old refresh token gives JiraLoginExpired with the "run foreman jira login" message', async () => {
    const before = signedIn();
    await refresh(SITE, { env });
    writeToken(SITE, before, { env }); // as if the rotated pair had never been saved
    const err = await refresh(SITE, { env }).catch((e) => e);
    expect(err).toBeInstanceOf(JiraLoginExpired);
    expect(err.message).toBe('Jira sign-in expired; run `foreman jira login`');
    expect(err.message).not.toContain(before.refreshToken);
  });

  it('picks up a pair another process rotated meanwhile instead of failing', async () => {
    const before = signedIn();
    const other = await refresh(SITE, { env }); // another process rotated and saved
    // This process still holds `before` in memory and tries with it.
    const mine = await refresh(SITE, { env, record: before });
    expect(mine.refreshToken).not.toBe(other.refreshToken);
    expect(readToken(SITE, { env }).refreshToken).toBe(mine.refreshToken);
  });

  it('with no token file says to sign in', async () => {
    await expect(refresh(SITE, { env })).rejects.toBeInstanceOf(JiraLoginExpired);
  });

  it('needs the client id and secret', async () => {
    signedIn();
    await expect(refresh(SITE, { env: { ...env, JIRA_CLIENT_SECRET: '' } })).rejects.toThrow(/JIRA_CLIENT_SECRET/);
  });
});

describe('tokenFor', () => {
  it('returns the stored access token while it has 60 s or more left', async () => {
    const r = signedIn({ expiresAt: '2026-10-17T13:00:00.000Z' });
    expect(await tokenFor(SITE, { env, now: at('2026-10-17T12:59:00Z') })).toBe(r.accessToken);
    expect(fake.tokenCalls).toBe(0);
  });

  it('refreshes when under 60 s are left', async () => {
    const r = signedIn({ expiresAt: '2026-10-17T13:00:00.000Z' });
    const t = await tokenFor(SITE, { env, now: at('2026-10-17T12:59:01Z') });
    expect(t).not.toBe(r.accessToken);
    expect(readToken(SITE, { env }).accessToken).toBe(t);
  });

  it('with no token file throws JiraLoginExpired', async () => {
    await expect(tokenFor(SITE, { env })).rejects.toBeInstanceOf(JiraLoginExpired);
  });
});

describe('signedInSites', () => {
  it('lists the sites with a token file, skipping temporary and other files, without reading them', () => {
    const dir = path.join(home, '.config', 'foreman');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'jira-acme.atlassian.net.json'), 'not even json');
    fs.writeFileSync(path.join(dir, 'jira-acme-labs.atlassian.net.json.123.abcd.tmp'), '{}');
    fs.writeFileSync(path.join(dir, 'jira-acme-labs.atlassian.net.json.tmp'), '{}');
    fs.writeFileSync(path.join(dir, 'gearset.json'), '{}');
    fs.writeFileSync(path.join(dir, 'jira-..json'), '{}');
    fs.mkdirSync(path.join(dir, 'sf'));
    expect(signedInSites({ env })).toEqual(['acme.atlassian.net']);
  });

  it('gives [] when the folder is missing', () => {
    expect(signedInSites({ env })).toEqual([]);
  });
});
