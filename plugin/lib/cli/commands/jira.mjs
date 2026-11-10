// `foreman jira`: sign in to Jira Cloud with OAuth 2.0 (3LO), and check or end the sign-in.
//
//   foreman jira login [--port 8765] [--no-open | --paste]
//       Starts a one-shot server on 127.0.0.1:<port>, opens the Atlassian consent page (or,
//       with --no-open, prints its address), waits for the callback, checks `state`, swaps
//       the code for tokens, finds the cloud id of config `stories.site`, and saves the token
//       file (~/.config/foreman/jira-<site>.json, mode 600). The OAuth app's callback URL must
//       be http://localhost:<port>/callback.
//       --paste is for a machine with no browser, such as a container: it starts no server and
//       prints the consent address; you approve anywhere, the browser lands on the callback
//       address (which does not load), and you paste that whole address back. Its `state` is
//       checked and its code swapped exactly as above.
//   foreman jira status   the site, the account, the token's expiry and, when `stories.jql` is
//                         set, whether the JQL runs
//   foreman jira logout   deletes the token file
//
// JIRA_CLIENT_ID and JIRA_CLIENT_SECRET come from the environment, then Foreman's own keys file
// (config `foremanEnvFile`, .env.foreman), then the project's env file (config `envFile`).
// No token, code or secret is ever printed. Exits 0 on success, 1 on failure, 64 on bad usage.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadResolved } from '../../settings/load.mjs';
import { foremanEnvName, loadForemanKeys } from '../../engine/foreman-keys.mjs';
import {
  SCOPES,
  JiraLoginExpired,
  authorizeUrl,
  deleteToken,
  newState,
  normalizeSite,
  readToken,
} from '../../jira/auth.mjs';
import { jiraClient } from '../../jira/client.mjs';
import {
  DEFAULT_PORT,
  LOGIN_TIMEOUT_MS,
  callbackPage,
  callbackServer,
  exchangeForSites,
  pastedCode,
  saveSignIn,
  siteFor,
} from '../../jira/login.mjs';
import { openBrowser } from '../open-browser.mjs';

export { pastedCode } from '../../jira/login.mjs';

const EXIT_USAGE = 64;
const USAGE = 'usage: foreman jira login [--port 8765] [--no-open | --paste] | foreman jira status | foreman jira logout\n';

// One line from stdin, for --paste.
function readStdinLine() {
  return new Promise((resolve, reject) => {
    let text = '';
    const done = (fn, value) => {
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.pause();
      fn(value);
    };
    const onData = (chunk) => {
      text += chunk;
      const end = text.indexOf('\n');
      if (end !== -1) done(resolve, text.slice(0, end));
    };
    const onEnd = () => (text.trim() ? done(resolve, text) : done(reject, new Error('No address was pasted.')));
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.resume();
  });
}

// The project's config and env, with Foreman's keys from .env.foreman and then the env file
// loaded. Returns { error } on failure.
function setup(root, env) {
  const { config, errors } = loadResolved(root, { env });
  if (errors.length) return { error: errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join('; ') };
  try {
    loadForemanKeys({ root, config, target: env });
  } catch {
    return { error: `Could not read ${foremanEnvName(config)}.` };
  }
  const envFile = join(root, config.envFile);
  if (existsSync(envFile)) {
    try {
      process.loadEnvFile(envFile);
    } catch {
      return { error: `Could not read ${config.envFile}.` };
    }
  }
  const merged = env === process.env ? process.env : { ...process.env, ...env };
  if (!config.stories?.site) return { error: 'Set stories.site in foreman.config.json to your Jira site, such as acme.atlassian.net.' };
  let site;
  try {
    site = normalizeSite(config.stories.site);
  } catch (err) {
    return { error: `stories.site: ${err.message}` };
  }
  return { config, env: merged, site };
}

function parseLogin(args) {
  let port = DEFAULT_PORT;
  let open = true;
  let paste = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--no-open') open = false;
    else if (a === '--paste') paste = true;
    else if (a === '--port' || a.startsWith('--port=')) {
      const v = a === '--port' ? args[++i] : a.slice('--port='.length);
      if (!/^\d+$/.test(v ?? '') || Number(v) > 65535) return null;
      port = Number(v);
    } else return null;
  }
  if (paste && !open) return null;
  return { port, open, paste };
}

// The code swap and the token file, shared by both ways of signing in. `finish` answers the
// browser when there is one.
async function completeLogin({ code, redirectUri, s, fetch, now, stdout, stderr, finish = () => {} }) {
  const { site } = s;
  try {
    const { tokens, sites } = await exchangeForSites({ code, redirectUri, env: s.env, fetch, now });
    const { cloudId } = siteFor(sites, site);
    const account = await saveSignIn({ site, cloudId, tokens, env: s.env, fetch, now });
    finish(200, callbackPage('Signed in', `Signed in to ${site} as ${account.displayName}. You can close this tab.`));
    stdout.write(`Signed in to ${site} as ${account.displayName}\n`);
    return 0;
  } catch (err) {
    finish(500, callbackPage('Sign-in failed', 'The sign-in failed. See the terminal.'));
    stderr.write(`${err.message}\n`);
    return 1;
  }
}

async function pasteLogin(opts, s, { stdout, stderr, now }, { timeoutMs, fetch, readLine }) {
  const state = newState();
  const redirectUri = `http://localhost:${opts.port}/callback`;
  const url = authorizeUrl({ clientId: s.env.JIRA_CLIENT_ID, scopes: SCOPES, redirectUri, state, env: s.env });
  stdout.write(
    `Open this address in any browser and approve the sign-in to ${s.site}:\n  ${url}\n`
      + `The browser then lands on ${redirectUri}?code=… . That page does not load, which is expected.\n`
      + 'Paste that whole address here and press Enter:\n',
  );
  let code;
  try {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('No address was pasted in time. Run `foreman jira login --paste` again.')), timeoutMs);
      timer.unref?.();
    });
    const line = await Promise.race([readLine(), timeout]).finally(() => clearTimeout(timer));
    code = pastedCode(line, { state, port: opts.port });
  } catch (err) {
    stderr.write(`${err.message}\n`);
    return 1;
  }
  return completeLogin({ code, redirectUri, s, fetch, now, stdout, stderr });
}

async function login(args, { root, env, stdout, stderr, now }, { open, timeoutMs, fetch, readLine }) {
  const opts = parseLogin(args);
  if (!opts) {
    stderr.write(USAGE);
    return EXIT_USAGE;
  }
  const s = setup(root, env);
  if (s.error) {
    stderr.write(`${s.error}\n`);
    return 1;
  }
  const { config, site } = s;
  const missing = ['JIRA_CLIENT_ID', 'JIRA_CLIENT_SECRET'].filter((k) => !s.env[k]);
  if (missing.length) {
    stderr.write(`${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set. Put JIRA_CLIENT_ID and JIRA_CLIENT_SECRET in ${foremanEnvName(config)}.\n`);
    return 1;
  }
  if (opts.paste) return pasteLogin(opts, s, { stdout, stderr, now }, { timeoutMs, fetch, readLine });

  const state = newState();
  let server;
  try {
    server = await callbackServer({ port: opts.port, state, timeoutMs });
  } catch (err) {
    stderr.write(`${err.message}\n`);
    return 1;
  }
  const redirectUri = `http://localhost:${server.port}/callback`;
  const url = authorizeUrl({ clientId: s.env.JIRA_CLIENT_ID, scopes: SCOPES, redirectUri, state, env: s.env });
  if (opts.open) {
    stdout.write(`Opening the browser to sign in to ${site}. If it does not open, visit:\n  ${url}\n`);
    open(url);
  } else {
    stdout.write(`Open this address in a browser to sign in to ${site}:\n  ${url}\n`);
  }

  let callback;
  try {
    callback = await server.wait();
  } catch (err) {
    server.close();
    stderr.write(`${err.message}\n`);
    return 1;
  }

  try {
    return await completeLogin({ code: callback.code, redirectUri, s, fetch, now, stdout, stderr, finish: callback.finish });
  } finally {
    server.close();
  }
}

async function status(args, { root, env, stdout, stderr, now }, { fetch, sleep }) {
  if (args.length) {
    stderr.write(USAGE);
    return EXIT_USAGE;
  }
  const s = setup(root, env);
  if (s.error) {
    stderr.write(`${s.error}\n`);
    return 1;
  }
  const { config, site } = s;
  const record = readToken(site, { env: s.env });
  if (!record) {
    stderr.write(`Not signed in to ${site}. Run \`foreman jira login\`.\n`);
    return 1;
  }
  const clock = now ?? (() => new Date());
  const left = Date.parse(record.expiresAt) - +clock();
  stdout.write(`Site: ${site}\n`);
  stdout.write(`Account: ${record.account?.displayName ?? 'unknown'}\n`);
  stdout.write(left > 0
    ? `Token: expires ${record.expiresAt} (in ${Math.round(left / 60_000)} min; refreshed automatically)\n`
    : `Token: expired ${record.expiresAt} (refreshed on next use)\n`);

  const jql = config.stories?.jql;
  if (!jql) return 0;
  const jira = jiraClient({ site, env: s.env, fetch, sleep, now });
  try {
    // One issue's id: real Jira refuses maxResults 0.
    await jira.request('POST', '/rest/api/3/search/jql', { jql, maxResults: 1, fields: ['id'] });
  } catch (err) {
    if (err instanceof JiraLoginExpired) {
      stderr.write(`${err.message}\n`);
      return 1;
    }
    stdout.write('JQL: fails\n');
    stderr.write(`${err.message}\n`);
    return 1;
  }
  let count = null;
  try {
    const r = await jira.request('POST', '/rest/api/3/search/approximate-count', { jql });
    if (Number.isFinite(r?.count)) count = r.count;
  } catch {
    // The count is a nicety; the search above already ran.
  }
  stdout.write(count === null ? 'JQL: runs\n' : `JQL: runs (about ${count} issue${count === 1 ? '' : 's'})\n`);
  return 0;
}

function logout(args, { root, env, stdout, stderr }) {
  if (args.length) {
    stderr.write(USAGE);
    return EXIT_USAGE;
  }
  const s = setup(root, env);
  if (s.error) {
    stderr.write(`${s.error}\n`);
    return 1;
  }
  stdout.write(deleteToken(s.site, { env: s.env }) ? `Signed out of ${s.site}.\n` : `Not signed in to ${s.site}.\n`);
  return 0;
}

export function makeJiraCommand({ open = openBrowser, timeoutMs = LOGIN_TIMEOUT_MS, fetch = globalThis.fetch, sleep, readLine = readStdinLine } = {}) {
  return {
    name: 'jira',
    summary: 'sign in to Jira Cloud and check the sign-in (jira login [--port 8765] [--no-open | --paste] | status | logout)',

    async run(args, ctx) {
      const [sub, ...rest] = args;
      const deps = { open, timeoutMs, fetch, sleep, readLine };
      if (sub === 'login') return login(rest, ctx, deps);
      if (sub === 'status') return status(rest, ctx, deps);
      if (sub === 'logout') return logout(rest, ctx);
      ctx.stderr.write(USAGE);
      return EXIT_USAGE;
    },
  };
}

export default makeJiraCommand();
