// The Jira set-up steps behind the dashboard's /api/setup/jira/ routes: signing in through the
// browser, picking the site when the sign-in reaches several, and the reads that help write the
// filter (projects, a preview of the filter, a project's statuses). Every word the owner sees
// is in WORDS.
//
//   const jira = jiraSetup({ root, env, now, fetch, sleep, port, timeoutMs });
//   jira.start()          { ok, status: 'waiting', url }: starts the one-shot callback server
//                         (lib/jira/login.mjs) and gives the consent address. The rest happens
//                         when the browser comes back: with stories.site set, that site is
//                         signed in; without it, the only site the sign-in reaches is signed in
//                         and saved as stories.site, and several are kept to pick from.
//   jira.current()        { status: 'idle' | 'waiting' | 'signed-in' | 'pick-site' | 'failed' }
//                         with site and account, the sites to pick ({ site, name }) or the error
//   jira.pickSite(site)   signs in to one of the sites to pick and saves it as stories.site
//   jira.projects()       { projects: [{ key, name }], more }
//   jira.preview(jql)     { issues: [{ key, title, status }], count }: 10 issues and Jira's
//                         approximate count (null when that fails)
//   jira.statuses(key)    { statuses: [{ name, category }], suggested }, each name once;
//                         suggested is the moves lib/setup/jira-screen.mjs suggestTransitions
//                         picks from them
//   jira.currentStories() { site, jql, ownerLabel, transitions, transitionsSaved } as the
//                         project has them now (null when not set; the owner label and
//                         transitions fall back to their defaults); transitionsSaved is true
//                         when the project's stories block, team or local, has a transitions
//                         key at all, even {}; never a token
//   jira.save(body)       { jql, ownerLabel, transitions }, exactly those keys: writes each one
//                         that changed to foreman.config.json through the team layer
//                         (lib/settings/change.mjs), and answers { ok, lines, stories }. lines
//                         end with the commit reminder once when anything was written, and are
//                         [WORDS.nothingChanged] when nothing was. An event left out of
//                         transitions moves nothing. Synchronous.
//   jira.close()          stops a waiting sign-in and forgets the tokens of one not picked yet
//
// The project is read afresh on each call. The Jira app's keys come from the env, then
// .env.foreman, then the env file (lib/jira/cache.mjs jiraEnv); nothing is put into
// process.env. A failure is an Error with .status, the HTTP code to answer with. Tokens live
// only in the token file and, while a site waits to be picked, in this object's memory; no
// answer and no error carries a token, a code or the client secret. Tokens kept for a site to
// pick are forgotten after timeoutMs, and the session becomes failed with WORDS.pickTimeout.

import { join } from 'node:path';
import { foremanEnvName, projectEnvName } from '../engine/foreman-keys.mjs';
import { SCOPES, JiraLoginExpired, authorizeUrl, newState, normalizeSite, readToken } from '../jira/auth.mjs';
import { jiraEnv } from '../jira/cache.mjs';
import { JiraError, jiraClient } from '../jira/client.mjs';
import { DEFAULT_PORT, LOGIN_TIMEOUT_MS, callbackPage, callbackServer, exchangeForSites, saveSignIn, siteFor } from '../jira/login.mjs';
import { DEFAULT_OWNER_LABEL, checkOptions } from '../adapters/stories/jira.mjs';
import { COMMIT_REMINDER, changeSetting } from '../settings/change.mjs';
import { loadResolved } from '../settings/load.mjs';
import { TRANSITION_EVENTS } from '../settings/registry.mjs';
import { readTeam, teamSet } from '../settings/team.mjs';
import { JIRA_SCREEN, suggestTransitions } from './jira-screen.mjs';
import { SETUP_FIRST } from './steps.mjs';

export const WORDS = Object.freeze({
  setupFirst: SETUP_FIRST,
  notJira: 'This project does not take its stories from Jira.',
  missingKeys: (names, file) =>
    `${names.join(' and ')} ${names.length > 1 ? 'are' : 'is'} not set. Save the Jira app's client ID and secret in ${file} first.`,
  portInUse: (port) => `Port ${port} is in use, so the sign-in cannot start. Close what uses it and try again.`,
  cannotListen: 'The sign-in could not start on this computer. Try again.',
  again: 'Go back to Foreman and sign in again.',
  pageSignedIn: (site, name) => `Signed in to ${site} as ${name}. You can close this tab.`,
  pagePickSite: 'Signed in. Go back to Foreman to pick your Jira site.',
  pageFailed: 'The sign-in failed. Go back to Foreman to see why.',
  stateMismatch: 'The sign-in was refused: it did not match the one Foreman started. Sign in again.',
  denied: (reason) => `Atlassian did not sign you in (${reason}).`,
  noCode: 'Atlassian sent the sign-in back without a code. Sign in again.',
  timeout: 'No sign-in arrived in time. Sign in again.',
  pickTimeout: 'No site was picked in time. Sign in again.',
  tokenRefused: "Atlassian refused the sign-in. Check the Jira app's client ID and secret, then sign in again.",
  noSites: 'This sign-in cannot reach any Jira site. Give the app access to your site, then sign in again.',
  signInBroke: 'The sign-in did not finish. Sign in again.',
  siteNotSaved: 'Signed in, but Foreman could not save the site in foreman.config.json.',
  signInFirst: 'Sign in to Jira first.',
  pickOne: 'Pick one of the sites the sign-in can reach.',
  expired: 'The Jira sign-in has expired. Sign in to Jira again.',
  jiraOdd: (status) => `Jira did not answer as expected (${status}). Try again in a moment.`,
  unreachable: 'Jira could not be reached. Try again in a moment.',
  typeFilter: 'Type a JQL filter first.',
  filterTooLong: 'That filter is too long.',
  badFilter: (reasons) => (reasons.length ? `Jira cannot run that filter: ${reasons.join('; ')}` : 'Jira cannot run that filter.'),
  pickProject: 'Pick a project from the list.',
  noProject: 'Jira has no project with that key, or you cannot see it.',
  badSave: 'Send the JQL filter, the owner label and the moves, and nothing else.',
  badOwnerLabel: 'The owner label must be one word, with no spaces.',
  badMoves: 'Each move must be a story event and the name of a Jira status or transition.',
  nothingChanged: JIRA_SCREEN.filter.nothing,
});

export const MAX_JQL = 4000;
const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9_]{0,99}$/;
const SAVE_KEYS = ['jql', 'ownerLabel', 'transitions'];

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
// Equal as settings: an object's keys in any order.
const same = (a, b) => {
  if (isPlain(a) && isPlain(b)) return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => Object.hasOwn(b, k) && same(a[k], b[k]));
  return a === b;
};

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

// The session's error for a sign-in that did not finish, in WORDS only.
function failureWords(err) {
  switch (err?.code) {
    case 'state-mismatch':
      return WORDS.stateMismatch;
    case 'denied':
      return WORDS.denied(err.reason);
    case 'no-code':
      return WORDS.noCode;
    case 'timeout':
      return WORDS.timeout;
    case 'token-request':
      return WORDS.tokenRefused;
    case 'site-unreachable':
      return err.message;
    case 'no-sites':
      return WORDS.noSites;
    case 'site-not-saved':
      return WORDS.siteNotSaved;
    default:
      return WORDS.signInBroke;
  }
}

export function jiraSetup({ root, env = process.env, now, fetch, sleep, port = DEFAULT_PORT, timeoutMs = LOGIN_TIMEOUT_MS }) {
  let session = null; // { status, ... } of the sign-in this dashboard started
  let pending = null; // { tokens, sites } while a site waits to be picked
  let pickTimer = null; // forgets pending when no site is picked in time
  let server = null; // the waiting callback server
  let generation = 0; // a sign-in started later wins over an earlier one still finishing

  // The project as it is now, with the env the Jira code sees.
  function project() {
    const { config } = loadResolved(root, { env });
    if (!config) throw fail(409, WORDS.setupFirst);
    if (config.stories?.adapter !== 'jira') throw fail(400, WORDS.notJira);
    const jenv = jiraEnv(env, join(root, projectEnvName(config)), join(root, foremanEnvName(config)));
    return { config, jenv };
  }

  // stories.site as a host, or null when it is not set; a bad one is a 400.
  function configuredSite(config) {
    const raw = config.stories?.site;
    if (raw === undefined || raw === null || raw === '') return null;
    try {
      return normalizeSite(raw);
    } catch (err) {
      throw fail(400, err.message);
    }
  }

  // Saves the site as stories.site; a failure is coded 'site-not-saved'.
  function saveSite(site) {
    let errors;
    try {
      ({ errors } = teamSet(root, 'stories.site', site));
    } catch {
      errors = ['write failed'];
    }
    if (errors.length) throw Object.assign(new Error(WORDS.siteNotSaved), { code: 'site-not-saved' });
  }

  function stopServer() {
    server?.close();
    server = null;
  }

  function clearPickTimer() {
    clearTimeout(pickTimer);
    pickTimer = null;
  }

  // Forgets the pending tokens of sign-in `gen` once timeoutMs passes without a pick.
  function armPickTimer(gen) {
    clearPickTimer();
    pickTimer = setTimeout(() => {
      if (gen !== generation || session?.status !== 'pick-site') return;
      pending = null;
      session = { status: 'failed', error: WORDS.pickTimeout };
      pickTimer = null;
    }, timeoutMs);
    pickTimer.unref?.();
  }

  // After the consent page: the code swap and the token file. The session is set before the
  // browser is answered, so the page's next look sees the outcome.
  async function complete(callbackSrv, gen, { site, jenv, redirectUri }) {
    const mine = () => gen === generation;
    let callback;
    try {
      callback = await callbackSrv.wait();
    } catch (err) {
      if (mine()) session = { status: 'failed', error: failureWords(err) };
      callbackSrv.close();
      if (mine()) server = null;
      return;
    }
    const opts = { env: jenv, fetch, now };
    try {
      const { tokens, sites } = await exchangeForSites({ code: callback.code, redirectUri, ...opts });
      if (site) {
        const match = siteFor(sites, site);
        const account = await saveSignIn({ site, cloudId: match.cloudId, tokens, ...opts });
        if (mine()) session = { status: 'signed-in', site, account: account.displayName };
        callback.finish(200, callbackPage('Signed in', WORDS.pageSignedIn(site, account.displayName)));
      } else if (sites.length === 0) {
        throw Object.assign(new Error(WORDS.noSites), { code: 'no-sites' });
      } else if (sites.length === 1) {
        const [only] = sites;
        const account = await saveSignIn({ site: only.site, cloudId: only.cloudId, tokens, ...opts });
        saveSite(only.site);
        if (mine()) session = { status: 'signed-in', site: only.site, account: account.displayName };
        callback.finish(200, callbackPage('Signed in', WORDS.pageSignedIn(only.site, account.displayName)));
      } else {
        if (mine()) {
          pending = { tokens, sites };
          session = { status: 'pick-site' };
          armPickTimer(gen);
        }
        callback.finish(200, callbackPage('Signed in', WORDS.pagePickSite));
      }
    } catch (err) {
      if (mine()) session = { status: 'failed', error: failureWords(err) };
      callback.finish(err?.code === 'site-unreachable' || err?.code === 'no-sites' ? 400 : 500, callbackPage('Sign-in failed', WORDS.pageFailed));
    } finally {
      callbackSrv.close();
      if (mine()) server = null;
    }
  }

  async function start() {
    const { config, jenv } = project();
    const missing = ['JIRA_CLIENT_ID', 'JIRA_CLIENT_SECRET'].filter((k) => !jenv[k]);
    if (missing.length) throw fail(400, WORDS.missingKeys(missing, foremanEnvName(config)));
    const site = configuredSite(config);

    generation += 1;
    const gen = generation;
    stopServer();
    clearPickTimer();
    pending = null;
    session = null;
    const state = newState();
    let callbackSrv;
    try {
      callbackSrv = await callbackServer({ port, state, timeoutMs, again: WORDS.again });
    } catch (err) {
      if (err?.code === 'port-in-use') throw fail(409, WORDS.portInUse(port));
      throw fail(500, WORDS.cannotListen);
    }
    if (gen !== generation) {
      // closed, or started again, while this one was opening its port
      callbackSrv.close();
      throw fail(409, WORDS.signInBroke);
    }
    server = callbackSrv;
    session = { status: 'waiting' };
    const redirectUri = `http://localhost:${callbackSrv.port}/callback`;
    const url = authorizeUrl({ clientId: jenv.JIRA_CLIENT_ID, scopes: SCOPES, redirectUri, state, env: jenv });
    complete(callbackSrv, gen, { site, jenv, redirectUri }).catch(() => {});
    return { ok: true, status: 'waiting', url };
  }

  function current() {
    const { config, jenv } = project();
    if (session?.status === 'pick-site') return { status: 'pick-site', sites: pending.sites.map(({ site, name }) => ({ site, name })) };
    if (session) return { ...session };
    let site = null;
    try {
      site = configuredSite(config);
    } catch {
      site = null;
    }
    const record = site ? readToken(site, { env: jenv }) : null;
    if (record) return { status: 'signed-in', site, account: record.account?.displayName ?? null };
    return { status: 'idle' };
  }

  // A read error in WORDS; `special(err)` may answer a JiraError first.
  function readError(err, special) {
    if (err instanceof JiraLoginExpired) return fail(409, WORDS.expired);
    if (err instanceof JiraError) return special?.(err) ?? fail(502, WORDS.jiraOdd(err.status));
    return fail(502, WORDS.unreachable);
  }

  async function pickSite(given) {
    const { jenv } = project();
    if (typeof given !== 'string' || session?.status !== 'pick-site' || !pending) throw fail(409, WORDS.signInFirst);
    let host = null;
    try {
      host = normalizeSite(given);
    } catch {
      host = null;
    }
    const match = host && pending.sites.find((s) => s.site === host);
    if (!match) throw fail(400, WORDS.pickOne);
    clearPickTimer();
    let account;
    try {
      account = await saveSignIn({ site: match.site, cloudId: match.cloudId, tokens: pending.tokens, env: jenv, fetch, now });
    } catch (err) {
      armPickTimer(generation);
      throw readError(err);
    }
    try {
      saveSite(match.site);
    } catch {
      armPickTimer(generation);
      throw fail(500, WORDS.siteNotSaved);
    }
    pending = null;
    session = { status: 'signed-in', site: match.site, account: account.displayName };
    return { ok: true, status: 'signed-in', site: match.site, account: account.displayName };
  }

  // A Jira client for the configured site, once signed in to it.
  function client() {
    const { config, jenv } = project();
    const site = configuredSite(config);
    if (!site || !readToken(site, { env: jenv })) throw fail(409, WORDS.signInFirst);
    return jiraClient({ site, env: jenv, fetch, sleep, now });
  }

  async function projects() {
    const jira = client();
    try {
      const r = await jira.request('GET', '/rest/api/3/project/search?maxResults=100&orderBy=key');
      const values = Array.isArray(r?.values) ? r.values : [];
      return { projects: values.map(({ key, name }) => ({ key, name })), more: r?.isLast === false };
    } catch (err) {
      throw readError(err);
    }
  }

  async function preview(jql) {
    if (typeof jql !== 'string' || jql.trim() === '') throw fail(400, WORDS.typeFilter);
    if (jql.length > MAX_JQL) throw fail(400, WORDS.filterTooLong);
    const jira = client();
    let found;
    try {
      found = await jira.request('POST', '/rest/api/3/search/jql', { jql, maxResults: 10, fields: ['summary', 'status'] });
    } catch (err) {
      throw readError(err, (e) =>
        e.status === 400 ? fail(400, WORDS.badFilter([...e.errorMessages, ...Object.values(e.errors ?? {})].map(String))) : null);
    }
    let count = null;
    try {
      const r = await jira.request('POST', '/rest/api/3/search/approximate-count', { jql });
      if (Number.isFinite(r?.count)) count = r.count;
    } catch {
      // the count is a nicety; the search above already ran
    }
    const issues = (Array.isArray(found?.issues) ? found.issues : []).map((i) => ({
      key: i.key,
      title: i.fields?.summary ?? '',
      status: i.fields?.status?.name ?? null,
    }));
    return { issues, count };
  }

  async function statuses(key) {
    if (typeof key !== 'string' || !PROJECT_KEY.test(key)) throw fail(400, WORDS.pickProject);
    const jira = client();
    let types;
    try {
      types = await jira.request('GET', `/rest/api/3/project/${encodeURIComponent(key)}/statuses`);
    } catch (err) {
      throw readError(err, (e) => (e.status === 404 ? fail(404, WORDS.noProject) : null));
    }
    const out = [];
    const names = new Set();
    for (const type of Array.isArray(types) ? types : []) {
      for (const s of Array.isArray(type?.statuses) ? type.statuses : []) {
        if (typeof s?.name !== 'string' || names.has(s.name)) continue;
        names.add(s.name);
        out.push({ name: s.name, category: s.statusCategory?.key ?? null });
      }
    }
    return { statuses: out, suggested: suggestTransitions(out) };
  }

  function currentStories() {
    const { config } = project();
    const stories = config.stories ?? {};
    const text = (v) => (typeof v === 'string' && v !== '' ? v : null);
    return {
      site: text(stories.site),
      jql: text(stories.jql),
      ownerLabel: text(stories.ownerLabel) ?? DEFAULT_OWNER_LABEL,
      transitions: isPlain(stories.transitions) ? { ...stories.transitions } : {},
      transitionsSaved: Object.hasOwn(stories, 'transitions'),
    };
  }

  // The body's three values, checked; a refusal never repeats what was sent.
  function saveBody(body) {
    if (!isPlain(body) || Object.keys(body).length !== SAVE_KEYS.length || !SAVE_KEYS.every((k) => Object.hasOwn(body, k))) throw fail(400, WORDS.badSave);
    const jql = typeof body.jql === 'string' ? body.jql.trim() : '';
    if (jql === '') throw fail(400, WORDS.typeFilter);
    if (jql.length > MAX_JQL) throw fail(400, WORDS.filterTooLong);
    const ownerLabel = typeof body.ownerLabel === 'string' ? body.ownerLabel.trim() : '';
    if (ownerLabel === '' || /\s/.test(ownerLabel)) throw fail(400, WORDS.badOwnerLabel);
    const { transitions } = body;
    if (!isPlain(transitions)) throw fail(400, WORDS.badMoves);
    const moves = {};
    for (const [event, name] of Object.entries(transitions)) {
      const trimmed = typeof name === 'string' ? name.trim() : '';
      if (!TRANSITION_EVENTS.includes(event) || trimmed === '') throw fail(400, WORDS.badMoves);
      moves[event] = trimmed;
    }
    return { jql, ownerLabel, transitions: moves };
  }

  function save(body) {
    const { config } = project();
    const wanted = saveBody(body);
    if (configuredSite(config) === null) throw fail(409, WORDS.signInFirst);
    const { adapter, ...options } = config.stories;
    try {
      checkOptions({ ...options, ...wanted });
    } catch (err) {
      throw fail(400, err.message);
    }
    const team = readTeam(root);
    if (team.errors) throw fail(409, WORDS.setupFirst);
    const file = isPlain(team.raw.stories) ? team.raw.stories : {};
    const had = {
      jql: file.jql,
      ownerLabel: file.ownerLabel ?? DEFAULT_OWNER_LABEL,
      // Undefined until the first save, so that save records the owner's moves even as {}.
      transitions: file.transitions,
    };
    const lines = [];
    let wrote = false;
    for (const key of SAVE_KEYS) {
      if (same(had[key], wanted[key])) continue;
      const r = changeSetting({ root, env }, { name: `stories.${key}`, value: wanted[key], layer: 'team' });
      if (r.error) throw fail(400, r.error);
      wrote = true;
      lines.push(...r.lines.filter((l) => l !== COMMIT_REMINDER));
    }
    if (wrote) lines.push(COMMIT_REMINDER);
    else lines.push(WORDS.nothingChanged);
    return { ok: true, lines, stories: currentStories() };
  }

  function close() {
    generation += 1;
    stopServer();
    clearPickTimer();
    pending = null;
    if (session?.status === 'waiting' || session?.status === 'pick-site') session = null;
  }

  return { start, current, pickSite, projects, preview, statuses, currentStories, save, close };
}
