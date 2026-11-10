// A fake Atlassian for tests, on node:http port 0. It plays both hosts: auth.atlassian.com
// (authorize, token) and api.atlassian.com (accessible-resources, the Jira REST API under
// /ex/jira/<cloudId>/). Point Foreman at it with FOREMAN_JIRA_AUTH_BASE and
// FOREMAN_JIRA_API_BASE set to `fake.url`.
//
// Like the real one, refresh tokens rotate: each refresh returns a new pair and retires the
// old refresh token, and using a retired one answers 403 `invalid_grant`. (The real service
// lets an old refresh token be reused for 10 minutes; the fake is strict so the expired
// path can be tested.)
//
//   const fake = await startFakeAtlassian();
//   fake.failNext({ status: 429, headers: { 'retry-after': '7' } });  // the next API call
//   fake.revokeAccessTokens();          // every access token issued so far now gets a 401
//   fake.route('GET', /^\/rest\/api\/3\/issue\/(.+)$/, (req, match, body) => ({ body: {...} }));
//   fake.secrets()                      // every code and token it has handed out
//   await fake.close();
//
// Routes added with route() match the path after /ex/jira/<cloudId>, and run after the
// bearer token is checked. A handler returns { status = 200, headers, body }.
//
// `projects` answers GET /rest/api/3/project/search, and `statuses` (by project key) answers
// GET /rest/api/3/project/<key>/statuses, a 404 for a key it does not have.

import http from 'node:http';
import { randomBytes } from 'node:crypto';

export const CLIENT_ID = 'fake-client-id';
export const CLIENT_SECRET = 'fake-client-secret-value';

const id = (prefix) => `${prefix}-${randomBytes(8).toString('hex')}`;

export async function startFakeAtlassian({
  clientId = CLIENT_ID,
  clientSecret = CLIENT_SECRET,
  sites = [{ id: 'cloud-acme-1', name: 'Acme', url: 'https://acme.atlassian.net' }],
  account = { accountId: '5b10ac8d82e05b22cc7d4ef5', displayName: 'Ada Lovelace', emailAddress: 'ada@example.com' },
  expiresIn = 3600,
  approximateCount = 3,
  projects = [{ id: '10000', key: 'ACME', name: 'Acme' }],
  statuses = {
    ACME: [
      {
        name: 'Story',
        statuses: [
          { id: '1', name: 'To Do', statusCategory: { key: 'new' } },
          { id: '3', name: 'In Progress', statusCategory: { key: 'indeterminate' } },
          { id: '2', name: 'Done', statusCategory: { key: 'done' } },
        ],
      },
      { name: 'Bug', statuses: [{ id: '1', name: 'To Do', statusCategory: { key: 'new' } }] },
    ],
  },
} = {}) {
  const codes = new Map(); // code -> redirect_uri
  const access = new Set(); // valid access tokens
  const revoked = new Set();
  const current = new Set(); // refresh tokens that work
  const retired = new Set(); // refresh tokens already used
  const issued = []; // every code and token handed out
  const failures = [];
  const routes = [];
  const requests = [];
  const authorizeCalls = [];
  let tokenCalls = 0;

  const issuePair = () => {
    const a = id('at');
    const r = id('rt');
    access.add(a);
    current.add(r);
    issued.push(a, r);
    return { a, r };
  };

  const send = (res, status, body, headers = {}) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(text);
  };

  const bearer = (req) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    return m && access.has(m[1]) && !revoked.has(m[1]) ? m[1] : null;
  };

  const handle = async (req, res, raw) => {
    const url = new URL(req.url, 'http://fake');
    const p = url.pathname;
    requests.push({ method: req.method, path: p });

    if (req.method === 'GET' && p === '/authorize') {
      const q = Object.fromEntries(url.searchParams);
      authorizeCalls.push(q);
      const bad = (msg) => send(res, 400, { error: 'invalid_request', error_description: msg });
      if (q.audience !== 'api.atlassian.com') return bad('audience');
      if (q.client_id !== clientId) return bad('client_id');
      if (q.response_type !== 'code') return bad('response_type');
      if (q.prompt !== 'consent') return bad('prompt');
      if (!q.redirect_uri || !q.state || !q.scope) return bad('redirect_uri, state and scope are required');
      const code = id('code');
      codes.set(code, q.redirect_uri);
      issued.push(code);
      const to = new URL(q.redirect_uri);
      to.searchParams.set('code', code);
      to.searchParams.set('state', q.state);
      res.writeHead(302, { location: to.toString() });
      return res.end();
    }

    if (req.method === 'POST' && p === '/oauth/token') {
      tokenCalls += 1;
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
        return send(res, 415, { error: 'unsupported_media_type' });
      }
      let b;
      try {
        b = JSON.parse(raw);
      } catch {
        return send(res, 400, { error: 'invalid_request' });
      }
      if (b.client_id !== clientId || b.client_secret !== clientSecret) {
        return send(res, 401, { error: 'access_denied', error_description: 'Unauthorized' });
      }
      if (b.grant_type === 'authorization_code') {
        if (!codes.has(b.code) || codes.get(b.code) !== b.redirect_uri) {
          return send(res, 403, { error: 'invalid_grant', error_description: 'Invalid authorization code' });
        }
        codes.delete(b.code);
        const { a, r } = issuePair();
        return send(res, 200, { access_token: a, refresh_token: r, expires_in: expiresIn, scope: 'read:jira-work write:jira-work read:jira-user offline_access', token_type: 'Bearer' });
      }
      if (b.grant_type === 'refresh_token') {
        if (!current.has(b.refresh_token)) {
          return send(res, 403, { error: 'invalid_grant', error_description: 'Unknown or invalid refresh token.' });
        }
        current.delete(b.refresh_token);
        retired.add(b.refresh_token);
        const { a, r } = issuePair();
        return send(res, 200, { access_token: a, refresh_token: r, expires_in: expiresIn, scope: 'read:jira-work write:jira-work read:jira-user offline_access', token_type: 'Bearer' });
      }
      return send(res, 400, { error: 'unsupported_grant_type' });
    }

    // Everything below is the API host and needs a bearer token.
    const failure = failures.length ? failures.shift() : null;
    if (failure) return send(res, failure.status, failure.body ?? {}, failure.headers ?? {});
    if (!bearer(req)) return send(res, 401, { code: 401, message: 'Unauthorized' });

    if (req.method === 'GET' && p === '/oauth/token/accessible-resources') {
      return send(res, 200, sites.map((s) => ({ scopes: ['read:jira-work', 'write:jira-work', 'read:jira-user'], avatarUrl: '', ...s })));
    }

    const m = /^\/ex\/jira\/([^/]+)(\/.*)$/.exec(p);
    if (!m) return send(res, 404, { errorMessages: ['Not found'] });
    if (!sites.some((s) => s.id === m[1])) return send(res, 404, { errorMessages: ['Site not found'] });
    const rest = m[2];
    let body = null;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        return send(res, 400, { errorMessages: ['Invalid JSON'] });
      }
    }

    for (const r of routes) {
      if (r.method !== req.method) continue;
      const hit = r.pattern.exec(rest);
      if (!hit) continue;
      const out = (await r.handler({ method: req.method, path: rest, query: url.searchParams, headers: req.headers }, hit, body)) ?? {};
      return send(res, out.status ?? 200, out.body, out.headers);
    }

    if (req.method === 'GET' && rest === '/rest/api/3/myself') {
      return send(res, 200, { accountType: 'atlassian', active: true, ...account });
    }
    if (req.method === 'POST' && rest === '/rest/api/3/search/jql') {
      if (!body?.jql) return send(res, 400, { errorMessages: ['JQL query is required.'] });
      if (/INVALID/.test(body.jql)) return send(res, 400, { errorMessages: [`Error in the JQL Query: '${body.jql}'`] });
      // As real Jira: maxResults 0 is refused.
      if (body.maxResults !== undefined && !(body.maxResults >= 1 && body.maxResults <= 5000)) {
        return send(res, 400, { errorMessages: ['The max results parameter has to be between 1 and 5,000.'], errors: {} });
      }
      return send(res, 200, { issues: [], isLast: true });
    }
    if (req.method === 'POST' && rest === '/rest/api/3/search/approximate-count') {
      return send(res, 200, { count: approximateCount });
    }
    if (req.method === 'GET' && rest === '/rest/api/3/project/search') {
      return send(res, 200, { values: projects, isLast: true });
    }
    const projectStatuses = /^\/rest\/api\/3\/project\/([^/]+)\/statuses$/.exec(rest);
    if (req.method === 'GET' && projectStatuses) {
      const key = decodeURIComponent(projectStatuses[1]);
      if (!Object.hasOwn(statuses, key)) return send(res, 404, { errorMessages: [`No project could be found with key '${key}'.`] });
      return send(res, 200, statuses[key]);
    }
    return send(res, 404, { errorMessages: ['Not found'] });
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      handle(req, res, raw).catch((err) => send(res, 500, { errorMessages: [String(err?.message ?? err)] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    clientId,
    clientSecret,
    sites,
    account,
    requests,
    authorizeCalls,
    get tokenCalls() {
      return tokenCalls;
    },
    /** Make the next API-host request (not authorize or token) answer with this. */
    failNext({ status, headers = {}, body = {}, times = 1 }) {
      for (let i = 0; i < times; i += 1) failures.push({ status, headers, body });
    },
    /** Every access token issued so far stops working (as after a server-side expiry). */
    revokeAccessTokens() {
      for (const a of access) revoked.add(a);
    },
    /** Issue a working pair without the browser flow, for tests that start signed in. */
    issueTokens() {
      const { a, r } = issuePair();
      return { accessToken: a, refreshToken: r };
    },
    isRetired: (refreshToken) => retired.has(refreshToken),
    route(method, pattern, handler) {
      routes.push({ method, pattern, handler });
    },
    /** Every code, access token and refresh token handed out, plus the client secret. */
    secrets: () => [...issued, clientSecret],
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}
