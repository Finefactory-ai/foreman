// Jira Cloud sign-in with OAuth 2.0 (3LO): the authorize URL, the code exchange, refresh with
// rotating refresh tokens, the list of sites a token can reach, and the token file.
//
// The token file is personal, so it lives in the home folder, never in the project:
// $HOME/.config/foreman/jira-<site>.json, mode 600, in a folder at mode 700. It holds
// { cloudId, site, accessToken, refreshToken, expiresAt, savedAt, scope, account }. savedAt is
// when the refresh token was issued: Atlassian retires one left unused for 90 days, and
// `foreman doctor` warns as that nears.
//
// Atlassian rotates refresh tokens: every refresh returns a new refresh token and retires the
// one used. Both new tokens are written back together (a temporary file, then a rename). A
// refresh refused with `invalid_grant` means the sign-in has expired: JiraLoginExpired.
//
// Nothing here logs, and no error message carries a token, a code or the client secret.
//
// Hosts: FOREMAN_JIRA_AUTH_BASE (default https://auth.atlassian.com) for authorize and token,
// FOREMAN_JIRA_API_BASE (default https://api.atlassian.com) for accessible-resources and the
// API. Tests point both at test/fake-atlassian.mjs.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const SCOPES = ['read:jira-work', 'write:jira-work', 'read:jira-user', 'offline_access'];
export const EXPIRED_MESSAGE = 'Jira sign-in expired; run `foreman jira login`';
export const REFRESH_MARGIN_MS = 60_000;

export class JiraLoginExpired extends Error {
  constructor(message = EXPIRED_MESSAGE) {
    super(message);
    this.name = 'JiraLoginExpired';
  }
}

const trim = (base) => String(base).replace(/\/+$/, '');
export const authBase = (env = process.env) => trim(env.FOREMAN_JIRA_AUTH_BASE || 'https://auth.atlassian.com');
export const apiBase = (env = process.env) => trim(env.FOREMAN_JIRA_API_BASE || 'https://api.atlassian.com');
const nowMs = (now) => +(now ? now() : new Date());

/** `https://Acme.atlassian.net/` -> `acme.atlassian.net`. Throws on anything else. */
export function normalizeSite(site) {
  let host = String(site ?? '').trim().toLowerCase();
  if (/^[a-z]+:\/\//.test(host)) {
    try {
      host = new URL(host).host;
    } catch {
      host = '';
    }
  }
  host = host.replace(/\/+$/, '');
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?::\d+)?$/.test(host)) {
    throw new Error(`The Jira site must be a host name such as acme.atlassian.net, not "${site ?? ''}".`);
  }
  return host;
}

export function newState() {
  return randomBytes(16).toString('hex');
}

export function authorizeUrl({ clientId, scopes = SCOPES, redirectUri, state, env = process.env }) {
  const params = {
    audience: 'api.atlassian.com',
    client_id: clientId,
    scope: scopes.join(' '),
    redirect_uri: redirectUri,
    state,
    response_type: 'code',
    prompt: 'consent',
  };
  const query = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return `${authBase(env)}/authorize?${query}`;
}

function clientCredentials(env) {
  const missing = ['JIRA_CLIENT_ID', 'JIRA_CLIENT_SECRET'].filter((k) => !env[k]);
  if (missing.length) throw new Error(`${missing.join(' and ')} must be set (in Foreman's own keys file).`);
  return { clientId: env.JIRA_CLIENT_ID, clientSecret: env.JIRA_CLIENT_SECRET };
}

async function postToken(body, { env, fetch: fetchImpl = globalThis.fetch }) {
  const res = await fetchImpl(`${authBase(env)}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (res.ok && data.access_token) return data;
  const err = new Error(`Atlassian refused the token request (${res.status}${data.error ? ` ${data.error}` : ''}).`);
  err.status = res.status;
  err.code = data.error;
  throw err;
}

const tokensFrom = (data, now) => ({
  accessToken: data.access_token,
  refreshToken: data.refresh_token,
  expiresAt: new Date(nowMs(now) + Number(data.expires_in ?? 3600) * 1000).toISOString(),
  savedAt: new Date(nowMs(now)).toISOString(),
  scope: data.scope,
});

/** Swaps an authorization code for { accessToken, refreshToken, expiresAt, savedAt, scope }. */
export async function exchangeCode({ code, redirectUri, env = process.env, fetch, now }) {
  const { clientId, clientSecret } = clientCredentials(env);
  const data = await postToken(
    { grant_type: 'authorization_code', client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri },
    { env, fetch },
  );
  if (!data.refresh_token) throw new Error('Atlassian returned no refresh token; add the offline_access scope to the app.');
  return tokensFrom(data, now);
}

/** The sites the token can reach: [{ id, url, name, scopes, avatarUrl }]. `id` is the cloud id. */
export async function resources(accessToken, { env = process.env, fetch: fetchImpl = globalThis.fetch } = {}) {
  const res = await fetchImpl(`${apiBase(env)}/oauth/token/accessible-resources`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Could not list the Atlassian sites (${res.status}).`);
  const list = await res.json();
  return Array.isArray(list) ? list : [];
}

// ---- the token file ----

const homeOf = (env) => env.HOME || os.homedir();
export const tokenDir = ({ env = process.env } = {}) => path.join(homeOf(env), '.config', 'foreman');
export const tokenPath = (site, { env = process.env } = {}) => path.join(tokenDir({ env }), `jira-${normalizeSite(site)}.json`);

// The sites with a token file in tokenDir, as hosts, sorted. Only the file names are read, never
// the files; a temporary file, or a name that is not a site, is skipped.
export function signedInSites({ env = process.env } = {}) {
  let names;
  try {
    names = fs.readdirSync(tokenDir({ env }));
  } catch {
    return [];
  }
  const sites = [];
  for (const name of names.sort()) {
    const m = /^jira-(.+)\.json$/.exec(name);
    if (!m) continue;
    try {
      sites.push(normalizeSite(m[1]));
    } catch {
      // not a site's token file
    }
  }
  return [...new Set(sites)].sort();
}

export function readToken(site, { env = process.env } = {}) {
  let text;
  try {
    text = fs.readFileSync(tokenPath(site, { env }), 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Writes the whole record at once: a mode-600 temporary file in the same folder, then a rename. */
export function writeToken(site, record, { env = process.env } = {}) {
  const dir = tokenDir({ env });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const file = tokenPath(site, { env });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return record;
}

export function deleteToken(site, { env = process.env } = {}) {
  const file = tokenPath(site, { env });
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file);
  return true;
}

// ---- refresh ----

/**
 * Refreshes the token for `site` and saves both new tokens. `record` is the copy this process
 * holds (read from the file when not given). If Atlassian says `invalid_grant` but the file
 * now holds a different refresh token, another process has rotated meanwhile, so that one is
 * tried once before giving up with JiraLoginExpired.
 */
export async function refresh(site, { env = process.env, fetch, now, record } = {}) {
  let held = record ?? readToken(site, { env });
  if (!held?.refreshToken) throw new JiraLoginExpired();
  const { clientId, clientSecret } = clientCredentials(env);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const data = await postToken(
        { grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret, refresh_token: held.refreshToken },
        { env, fetch },
      );
      const t = tokensFrom(data, now);
      const next = {
        ...held,
        accessToken: t.accessToken,
        refreshToken: t.refreshToken || held.refreshToken,
        expiresAt: t.expiresAt,
        savedAt: t.savedAt,
        ...(t.scope ? { scope: t.scope } : {}),
      };
      return writeToken(site, next, { env });
    } catch (err) {
      if (err?.code !== 'invalid_grant') throw err;
      const onDisk = readToken(site, { env });
      if (attempt === 0 && onDisk?.refreshToken && onDisk.refreshToken !== held.refreshToken) {
        held = onDisk;
        continue;
      }
      throw new JiraLoginExpired();
    }
  }
  throw new JiraLoginExpired();
}

/** The full token record with at least 60 s left on the access token, refreshing if needed. */
export async function freshRecord(site, { env = process.env, fetch, now, force = false } = {}) {
  const record = readToken(site, { env });
  if (!record?.accessToken) throw new JiraLoginExpired();
  const left = Date.parse(record.expiresAt) - nowMs(now);
  if (!force && Number.isFinite(left) && left >= REFRESH_MARGIN_MS) return record;
  return refresh(site, { env, fetch, now, record });
}

/** An access token for `site` with at least 60 s left. */
export async function tokenFor(site, opts = {}) {
  return (await freshRecord(site, opts)).accessToken;
}
