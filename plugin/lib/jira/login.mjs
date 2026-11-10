// The Jira sign-in mechanics, shared by `foreman jira login` and the set-up API
// (lib/setup/jira.mjs): the one-shot callback server, the pasted callback address, the code
// swap, the match against the wanted site, and the token file.
//
//   callbackServer({ port, state, timeoutMs, again })
//       a one-shot server on 127.0.0.1:<port>. Resolves { port, wait, close } once listening;
//       wait() resolves { code, finish(status, html) } for a valid callback, or rejects. `again`
//       is the last sentence of the browser page when the state does not match.
//   pastedCode(text, { state, port })   the code from a pasted callback address, after the same
//                                       checks the server makes
//   exchangeForSites({ code, redirectUri, env, fetch, now }) -> { tokens, sites }
//       sites: [{ cloudId, site, name }], site the lower-case host; one without a host is dropped
//   siteFor(sites, wanted)              the entry for `wanted`, or throws code 'site-unreachable'
//   saveSignIn({ site, cloudId, tokens, env, fetch, now }) -> { accountId, displayName }
//       writes the token file, asks Jira who signed in, and writes it again with the account
//   callbackPage(title, text)  the small page the browser is answered with; both are HTML-escaped
//
// Every rejection carries err.code: 'state-mismatch', 'denied' (with err.reason, reduced to
// [\w.-]), 'no-code', 'timeout', 'port-in-use' or 'listen'; a pasted address that is not the
// callback is 'not-an-address' or 'not-callback'; a refused code swap is 'token-request'.
// Nothing here logs, and no error carries a token, a code or the client secret.

import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { exchangeCode, readToken, resources, writeToken } from './auth.mjs';
import { jiraClient } from './client.mjs';

export const DEFAULT_PORT = 8765;
export const LOGIN_TIMEOUT_MS = 5 * 60_000;

const coded = (message, code, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const reasonOf = (value) => String(value).replace(/[^\w.-]/g, '');

const sameText = (a, b) => {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
};

const escapeHtml = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const callbackPage = (title, text) =>
  `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><p>${escapeHtml(text)}</p>\n`;

export function callbackServer({ port, state, timeoutMs, again = 'Run foreman jira login again.' }) {
  let settle;
  const result = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  let done = false;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/callback' || done) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found\n');
      return;
    }
    done = true;
    const finish = (status, html) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
      res.end(html);
    };
    const q = url.searchParams;
    if (!sameText(q.get('state'), state)) {
      finish(400, callbackPage('Sign-in refused', `The sign-in was refused: its state did not match. ${again}`));
      settle.reject(coded('Sign-in refused: the callback state did not match. Run `foreman jira login` again.', 'state-mismatch'));
      return;
    }
    if (q.get('error')) {
      const reason = reasonOf(q.get('error'));
      finish(400, callbackPage('Sign-in failed', `Atlassian said: ${reason}.`));
      settle.reject(coded(`Atlassian did not sign you in (${reason}).`, 'denied', { reason }));
      return;
    }
    if (!q.get('code')) {
      finish(400, callbackPage('Sign-in failed', 'The callback had no code.'));
      settle.reject(coded('The sign-in callback had no code.', 'no-code'));
      return;
    }
    settle.resolve({ code: q.get('code'), finish });
  });
  const timer = setTimeout(() => {
    done = true;
    settle.reject(coded('No sign-in arrived in time. Run `foreman jira login` again.', 'timeout'));
  }, timeoutMs);
  timer.unref?.();
  const close = () => {
    clearTimeout(timer);
    server.closeAllConnections?.();
    server.close();
  };
  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      clearTimeout(timer);
      reject(err?.code === 'EADDRINUSE'
        ? coded(`Port ${port} is in use; pick another with --port.`, 'port-in-use')
        : coded(`Could not start the sign-in server: ${err.message}`, 'listen'));
    });
    server.listen(port, '127.0.0.1', () => resolve({ port: server.address().port, wait: () => result, close }));
  });
}

export function pastedCode(text, { state, port }) {
  const raw = String(text ?? '').trim().replace(/^["'<]+|["'>]+$/g, '');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw coded('That is not an address. Paste the whole address the browser landed on, starting http://localhost.', 'not-an-address');
  }
  if (url.pathname !== '/callback' || !['localhost', '127.0.0.1'].includes(url.hostname) || (url.port || '80') !== String(port)) {
    throw coded(`That is not the sign-in callback; it starts http://localhost:${port}/callback.`, 'not-callback');
  }
  const q = url.searchParams;
  if (!sameText(q.get('state'), state)) throw coded('Sign-in refused: the callback state did not match. Run `foreman jira login --paste` again.', 'state-mismatch');
  if (q.get('error')) {
    const reason = reasonOf(q.get('error'));
    throw coded(`Atlassian did not sign you in (${reason}).`, 'denied', { reason });
  }
  if (!q.get('code')) throw coded('The pasted address had no code.', 'no-code');
  return q.get('code');
}

const hostOf = (u) => {
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return '';
  }
};

export async function exchangeForSites({ code, redirectUri, env, fetch, now }) {
  let tokens;
  try {
    tokens = await exchangeCode({ code, redirectUri, env, fetch, now });
  } catch (err) {
    // A refusal from the token endpoint has its HTTP status; its message carries no secret.
    if (Number.isInteger(err?.status)) throw coded(err.message, 'token-request', { status: err.status });
    throw err;
  }
  const list = await resources(tokens.accessToken, { env, fetch });
  const sites = list.map((r) => ({ cloudId: r.id, site: hostOf(r.url), name: r.name })).filter((s) => s.site);
  return { tokens, sites };
}

export function siteFor(sites, wanted) {
  const match = sites.find((s) => s.site === wanted);
  if (match) return match;
  const known = sites.map((s) => s.site);
  throw coded(
    `This sign-in cannot reach ${wanted}${known.length ? `; it can reach ${known.join(', ')}` : ''}. Check stories.site, or grant the app access to ${wanted}.`,
    'site-unreachable',
  );
}

export async function saveSignIn({ site, cloudId, tokens, env, fetch, now }) {
  writeToken(site, { cloudId, site, ...tokens, account: null }, { env });
  const me = await jiraClient({ site, env, fetch, now }).request('GET', '/myself');
  const account = { accountId: me?.accountId ?? null, displayName: me?.displayName ?? me?.accountId ?? 'unknown' };
  writeToken(site, { ...readToken(site, { env }), account }, { env });
  return account;
}
