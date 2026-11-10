// The `foreman doctor` checks for the Jira story source, in order:
//
//   jira options     the stories block passes the adapter's own check (else nothing else runs)
//   jira signed in   the token file for stories.site is there
//   jira sign-in age the refresh token was renewed less than 80 days ago; Atlassian retires one
//                    left unused for 90 days. From the file's savedAt, else the file's time.
//   jira JQL         the JQL runs (search/jql for one issue's id; real Jira refuses maxResults
//                    0), with the approximate count
//   jira transitions every name in stories.transitions is offered by one issue the JQL finds,
//                    by transition name or the status it leads to, or is a status of that
//                    issue's project; any case. Only when the map has names. A warning, never
//                    an error: one issue's status shows only the moves open from it.
//   jira app keys    JIRA_CLIENT_ID and JIRA_CLIENT_SECRET are in the environment, .env.foreman
//                    (config `foremanEnvFile`) or the env file (names only)
//
// The calls go through jiraClient with await, which refreshes the access token with the keys
// from those files when it needs to. No result carries a token, a key's value or a secret.
//
// Each check has its set-up step (lib/setup/steps.mjs): options, JQL and transitions belong to
// 'jira-site', the two sign-in checks to 'jira-signin', the app keys to 'jira-app'. Every result
// that is not ok carries fix: { hint, step?, action? }; a check skipped because Jira is not
// signed in points at 'jira-signin'.

import fs from 'node:fs';
import path from 'node:path';
import { checkOptions } from '../adapters/stories/jira.mjs';
import { EXPIRED_MESSAGE, JiraLoginExpired, normalizeSite, readToken, tokenPath } from '../jira/auth.mjs';
import { jiraEnv } from '../jira/cache.mjs';
import { foremanEnvName } from './foreman-keys.mjs';
import { jiraClient } from '../jira/client.mjs';

export const RENEW_WARN_DAYS = 80;
export const IDLE_EXPIRY_DAYS = 90;
const DAY_MS = 86_400_000;
const KEYS = ['JIRA_CLIENT_ID', 'JIRA_CLIENT_SECRET'];

const ok = (detail = '') => ({ ok: true, level: 'error', detail });
const fail = (detail, fix) => ({ ok: false, level: 'error', detail, ...(fix ? { fix } : {}) });
const warn = (detail, fix) => ({ ok: false, level: 'warn', detail, ...(fix ? { fix } : {}) });

const LOGIN = { step: 'jira-signin', action: 'jira-login', hint: 'sign in with `foreman jira login`' };
const SIGN_IN_FIRST = { step: 'jira-signin', hint: 'sign in to Jira first' };

const lower = (s) => String(s ?? '').trim().toLowerCase();
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function jiraChecks(config, ctx) {
  const checks = [];
  const add = (name, step, run) => checks.push({ name, step, run });
  const { adapter: _adapter, ...options } = config.stories ?? {};
  try {
    checkOptions(options);
  } catch (err) {
    add('jira options', 'jira-site', () => fail(err.message, { hint: 'fix the stories block in foreman.config.json' }));
    return checks;
  }

  const site = normalizeSite(options.site);
  const ownName = foremanEnvName(config);
  const env = jiraEnv(ctx.env ?? {}, path.join(ctx.root, config.envFile ?? '.env.local'), path.join(ctx.root, ownName));
  const now = ctx.now ?? (() => new Date());
  const client = jiraClient({ site, env, fetch: ctx.fetch ?? globalThis.fetch, now });
  const names = Object.entries(options.transitions ?? {});

  let token;
  const signedIn = () => {
    if (token === undefined) token = readToken(site, { env });
    return Boolean(token?.accessToken && token?.refreshToken);
  };
  let jqlRan = false;

  add('jira signed in', 'jira-signin', () =>
    signedIn() ? ok(`${site} as ${token.account?.displayName ?? 'unknown'}`) : fail(`not signed in to ${site}; run \`foreman jira login\``, LOGIN));

  add('jira sign-in age', 'jira-signin', () => {
    if (!signedIn()) return warn('skipped: not signed in', SIGN_IN_FIRST);
    let saved = Date.parse(token.savedAt);
    if (!Number.isFinite(saved)) {
      try {
        saved = (ctx.fs ?? fs).statSync(tokenPath(site, { env })).mtimeMs;
      } catch {
        return warn('could not tell when the sign-in was renewed', { ...LOGIN, hint: 'renew the sign-in with `foreman jira login`' });
      }
    }
    const days = Math.max(0, Math.floor((+now() - saved) / DAY_MS));
    const when = `renewed ${plural(days, 'day')} ago`;
    if (days < RENEW_WARN_DAYS) return ok(when);
    return warn(`${when}; Atlassian ends a sign-in left unused for ${IDLE_EXPIRY_DAYS} days. Run \`foreman jira login\` to renew it`, { ...LOGIN, hint: 'renew the sign-in with `foreman jira login`' });
  });

  add('jira JQL', 'jira-site', async () => {
    if (!signedIn()) return warn('skipped: not signed in', SIGN_IN_FIRST);
    try {
      await client.request('POST', '/rest/api/3/search/jql', { jql: options.jql, maxResults: 1, fields: ['id'] });
    } catch (err) {
      if (err instanceof JiraLoginExpired) return fail(EXPIRED_MESSAGE, { ...LOGIN, hint: 'sign in again with `foreman jira login`' });
      if (err?.name === 'JiraError') return fail(`the JQL fails: ${err.message}`, { hint: 'fix stories.jql so it runs in Jira' });
      return fail(`could not reach Jira: ${err?.message ?? err}`, { hint: `check stories.site (${site}) and this machine's network` });
    }
    jqlRan = true;
    try {
      const r = await client.request('POST', '/rest/api/3/search/approximate-count', { jql: options.jql });
      if (Number.isFinite(r?.count)) return ok(`runs (about ${plural(r.count, 'issue')})`);
    } catch {
      // The count is a nicety; the search above already ran.
    }
    return ok('runs');
  });

  if (names.length) {
    add('jira transitions', 'jira-site', async () => {
      if (!jqlRan) return warn('skipped: the JQL did not run', { hint: 'get the JQL check passing first' });
      const found = await client.request('POST', '/rest/api/3/search/jql', { jql: options.jql, maxResults: 1, fields: ['status'] });
      const issue = found?.issues?.[0];
      if (!issue?.key) return warn('no issue to check transitions on', { hint: 'run the doctor again once the JQL finds an issue' });
      const key = issue.key;
      const res = await client.request('GET', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions?includeUnavailableTransitions=true`);
      const known = new Set();
      for (const t of res?.transitions ?? []) {
        known.add(lower(t?.name));
        known.add(lower(t?.to?.name));
      }
      const project = key.replace(/-\d+$/, '');
      try {
        const types = await client.request('GET', `/rest/api/3/project/${encodeURIComponent(project)}/statuses`);
        for (const type of Array.isArray(types) ? types : []) for (const s of type?.statuses ?? []) known.add(lower(s?.name));
      } catch {
        // The project's statuses only widen the match; the issue's transitions are enough.
      }
      const missing = names.filter(([, name]) => !known.has(lower(name)));
      if (!missing.length) return ok();
      const from = issue.fields?.status?.name ? ` (${issue.fields.status.name})` : '';
      const list = missing.map(([event, name]) => `${event} "${name}"`).join(', ');
      return warn(`not found from ${key}${from}: ${list}. Check the names in stories.transitions; a move open only from another status cannot be seen from here`, { hint: 'check the names in stories.transitions against your Jira workflow' });
    });
  }

  add('jira app keys', 'jira-app', () => {
    const missing = KEYS.filter((k) => !env[k]);
    return missing.length
      ? fail(`missing: ${missing.join(', ')} (set in ${ownName} or the environment)`, { hint: `add JIRA_CLIENT_ID and JIRA_CLIENT_SECRET to ${ownName}` })
      : ok();
  });

  return checks;
}
