// The Jira Cloud REST client. Every call goes to
//   ${FOREMAN_JIRA_API_BASE || 'https://api.atlassian.com'}/ex/jira/<cloudId>/rest/api/3/...
// with the signed-in token from auth.mjs.
//
//   const jira = jiraClient({ site: 'acme.atlassian.net', env, fetch, sleep, now });
//   await jira.request('GET', '/myself');                       // -> /rest/api/3/myself
//   await jira.request('POST', '/rest/api/3/search/jql', { jql });  // a full /rest/ path as is
//
// - The token is refreshed before a call when it has under 60 s left, and once more after a
//   401. A second 401 is an error.
// - On 429 or 503 it waits `Retry-After` seconds (5 when missing) and tries again, 3 tries in all.
// - Errors are JiraError { status, errorMessages, errors }. They never carry a token.
// - A sign-in that can no longer refresh throws JiraLoginExpired (from auth.mjs).

import { apiBase, freshRecord, normalizeSite } from './auth.mjs';

export const TRIES = 3;
export const DEFAULT_RETRY_AFTER_S = 5;

export class JiraError extends Error {
  constructor({ method, path, status, errorMessages = [], errors = {} }) {
    const detail = [...errorMessages, ...Object.entries(errors).map(([k, v]) => `${k}: ${v}`)].join('; ');
    super(`Jira ${method} ${path} failed (${status})${detail ? `: ${detail}` : ''}`);
    this.name = 'JiraError';
    this.status = status;
    this.errorMessages = errorMessages;
    this.errors = errors;
  }
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retry-After as milliseconds: whole seconds or an HTTP date; 5 s when missing or unreadable. */
export function retryAfterMs(value, now = () => new Date()) {
  if (value == null || value === '') return DEFAULT_RETRY_AFTER_S * 1000;
  const s = Number(value);
  if (Number.isFinite(s) && s >= 0) return Math.round(s * 1000);
  const at = Date.parse(value);
  if (Number.isFinite(at)) return Math.max(0, at - +now());
  return DEFAULT_RETRY_AFTER_S * 1000;
}

export function jiraClient({ site, env = process.env, fetch: fetchImpl = globalThis.fetch, sleep = realSleep, now = () => new Date() }) {
  const host = normalizeSite(site);
  const opts = { env, fetch: fetchImpl, now };

  async function request(method, path, body) {
    const rest = path.startsWith('/rest/') ? path : `/rest/api/3${path.startsWith('/') ? '' : '/'}${path}`;
    let record = await freshRecord(host, opts);
    let refreshed = false;
    let tries = 0;
    for (;;) {
      tries += 1;
      const headers = { authorization: `Bearer ${record.accessToken}`, accept: 'application/json' };
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await fetchImpl(`${apiBase(env)}/ex/jira/${record.cloudId}${rest}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });

      if (res.status === 401 && !refreshed) {
        refreshed = true;
        record = await freshRecord(host, { ...opts, force: true });
        continue;
      }
      if ((res.status === 429 || res.status === 503) && tries < TRIES) {
        await sleep(retryAfterMs(res.headers?.get?.('retry-after'), now));
        continue;
      }

      const text = await res.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      if (res.ok) return data;
      const errorMessages = Array.isArray(data?.errorMessages) ? data.errorMessages.map(String) : [];
      if (!errorMessages.length && typeof data?.message === 'string') errorMessages.push(data.message);
      const errors = data?.errors && typeof data.errors === 'object' ? data.errors : {};
      throw new JiraError({ method, path: rest, status: res.status, errorMessages, errors });
    }
  }

  return { site: host, request };
}
