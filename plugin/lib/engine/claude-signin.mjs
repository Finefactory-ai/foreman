// Which Claude sign-in the sessions will use, for `foreman doctor` and `foreman cloud doctor`.
// It follows Claude Code's own order: a cloud provider, then ANTHROPIC_AUTH_TOKEN, then
// ANTHROPIC_API_KEY, then CLAUDE_CODE_OAUTH_TOKEN, then the login stored on this machine (read
// with `claude auth status --json`, only when no variable decides).
//
// claudeSignIn({ env, sh }) -> { kind, ok, level, detail }, kind one of 'cloud-provider',
// 'gateway-token', 'api-key', 'subscription-token', 'login', 'none', 'unknown'. It reads variable
// NAMES only; no value, and nothing `claude auth status` prints, is put into a result.
//
// signInCheck(config) is the doctor check. With a config, the two sign-in names in Foreman's
// own keys file (.env.foreman) count where ctx.env has none, as they do for the sessions
// (foreman-keys.mjs sessionKeys); the project's env file is never read for them.
//
// When the platform credits ran out or the key reached its usage limit, and the sessions moved to
// the subscription (claude-fallback.mjs, <stateDir>/claude-signin.json), the check leaves
// ANTHROPIC_API_KEY out, as the sessions do, so it names the sign-in they really use, and says
// since when; after a usage limit the detail names that limit and when access returns, if Claude
// Code said. After `foreman claude use-key` it says since when the key is back. With no record it
// is as before.
//
// subscriptionSignIn({ env, sh }) -> 'token' | 'login' | null: the subscription sign-in a run
// can switch to when the Console key runs out of credit. CLAUDE_CODE_OAUTH_TOKEN set
// is 'token'; else `claude auth status --json`, run without ANTHROPIC_API_KEY in its
// environment, showing a claude.ai login is 'login'. Names only. It runs the command
// synchronously. Nothing in Foreman calls it now: the supervisor uses subscriptionSignInAsync.
// It is kept for synchronous callers and its tests.
//
// subscriptionSignInAsync({ env, run }) -> Promise<'token' | 'login' | null>: the same answer
// without holding the caller, for the supervisor, which checks after a session ran out of credit
// while its loop keeps ticking. `run(cmd, args, { env, timeout })` resolves { status, stdout,
// timedOut }, as signin-probe.mjs's does; the command gets 30 s (STATUS_TIMEOUT_MS). A rejection,
// a timeout, a non-zero status or an answer that is not a JSON object is null. The caller's env is
// not changed.
//
// machineLogin(sh) -> 'signed-in' | 'signed-out' | 'unknown': whether Claude Code is signed in
// on this computer, from `claude auth status --json`; never the email or any other field.
// SELLING is the sentence that says a subscription is not for selling Foreman; the set-up
// screen (lib/setup/claude.mjs) reuses it.

import { sessionKeys, withSessionKeys } from './foreman-keys.mjs';
import { localStamp, readSignIn } from './claude-fallback.mjs';
import { stateDir } from './paths.mjs';
import { STATUS_TIMEOUT_MS } from './signin-probe.mjs';

export const SELLING = 'A subscription is for your own projects only: selling Foreman, or running it for others, needs a Console API key (ANTHROPIC_API_KEY).';

const PROVIDERS = [
  ['CLAUDE_CODE_USE_BEDROCK', 'Amazon Bedrock'],
  ['CLAUDE_CODE_USE_VERTEX', 'Google Vertex AI'],
  ['CLAUDE_CODE_USE_FOUNDRY', 'Microsoft Foundry'],
];

const isSet = (env, name) => typeof env?.[name] === 'string' && env[name] !== '';
const isOn = (env, name) => isSet(env, name) && !/^(0|false|no|off)$/i.test(env[name].trim());

const result = (kind, ok, level, detail) => ({ kind, ok, level, detail });

// The answer of `claude auth status --json`, parsed, or null when it is not a JSON object.
function parseStatus(stdout) {
  try {
    const status = JSON.parse(String(stdout));
    return status && typeof status === 'object' ? status : null;
  } catch {
    return null;
  }
}

// `claude auth status --json`, parsed, or null when it cannot be read.
function authStatus(sh, opts) {
  const r = opts ? sh('claude', ['auth', 'status', '--json'], opts) : sh('claude', ['auth', 'status', '--json']);
  if (r.status !== 0) return null;
  return parseStatus(r.stdout);
}

export function machineLogin(sh) {
  const status = authStatus(sh);
  if (!status) return 'unknown';
  return status.loggedIn === true ? 'signed-in' : 'signed-out';
}

// A login status that is a Console API key rather than a claude.ai login.
const consoleLogin = (status) => Boolean(status.apiKeySource) || /console|api.?key/i.test(String(status.authMethod ?? ''));

// The login stored on this machine, from `claude auth status --json`.
function storedLogin(sh) {
  const status = authStatus(sh);
  if (!status) {
    return result('unknown', false, 'warn', 'no ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN is set, and `claude auth status` could not be read to find the login on this machine');
  }
  if (status.loggedIn !== true) {
    return result('none', false, 'error', 'no Claude sign-in: set ANTHROPIC_API_KEY (a Console API key) or CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`), or run `claude auth login`');
  }
  if (consoleLogin(status)) {
    return result('api-key', true, 'error', 'Console API key on this machine: per-token billing');
  }
  return result('login', false, 'warn', `claude.ai login on this machine: counts against your plan's limits. ${SELLING}`);
}

export function claudeSignIn({ env = {}, sh }) {
  const provider = PROVIDERS.find(([name]) => isOn(env, name));
  if (provider) return result('cloud-provider', true, 'error', `${provider[1]} (${provider[0]}): billed by your cloud account`);
  if (isSet(env, 'ANTHROPIC_AUTH_TOKEN')) return result('gateway-token', true, 'error', 'gateway or proxy token (ANTHROPIC_AUTH_TOKEN): billed by whoever runs the gateway');
  if (isSet(env, 'ANTHROPIC_API_KEY')) {
    const also = isSet(env, 'CLAUDE_CODE_OAUTH_TOKEN') ? ' (CLAUDE_CODE_OAUTH_TOKEN is also set; the API key wins)' : '';
    return result('api-key', true, 'error', `Console API key: per-token billing${also}`);
  }
  if (isSet(env, 'CLAUDE_CODE_OAUTH_TOKEN')) {
    return result('subscription-token', false, 'warn', `Claude subscription token: counts against your plan's limits. ${SELLING}`);
  }
  return storedLogin(sh);
}

export function subscriptionSignIn({ env = {}, sh }) {
  if (isSet(env, 'CLAUDE_CODE_OAUTH_TOKEN')) return 'token';
  const rest = { ...env };
  delete rest.ANTHROPIC_API_KEY;
  const status = authStatus(sh, { env: rest });
  return status && status.loggedIn === true && !consoleLogin(status) ? 'login' : null;
}

export async function subscriptionSignInAsync({ env = {}, run }) {
  if (isSet(env, 'CLAUDE_CODE_OAUTH_TOKEN')) return 'token';
  const rest = { ...env };
  delete rest.ANTHROPIC_API_KEY;
  let r;
  try {
    r = await run('claude', ['auth', 'status', '--json'], { env: rest, timeout: STATUS_TIMEOUT_MS });
  } catch {
    return null;
  }
  if (!r || r.timedOut || r.status !== 0) return null;
  const status = parseStatus(r.stdout);
  return status && status.loggedIn === true && !consoleLogin(status) ? 'login' : null;
}

// What to do about each sign-in that is not ok, in plain words.
const HINTS = {
  none: 'set ANTHROPIC_API_KEY or run `claude auth login`',
  login: 'use a Console API key (ANTHROPIC_API_KEY) if you sell Foreman or run it for others',
  'subscription-token': 'use a Console API key (ANTHROPIC_API_KEY) if you sell Foreman or run it for others',
  unknown: 'check the sign-in with `claude auth status`',
};

// sh, with the answer to `claude auth status --json` kept after its first run.
function onceForStatus(sh) {
  let answer;
  return (cmd, args = [], ...rest) => {
    if (cmd !== 'claude' || args.join(' ') !== 'auth status --json') return sh(cmd, args, ...rest);
    answer ??= sh(cmd, args, ...rest);
    return answer;
  };
}

// The doctor check: { name, step, run(ctx) -> { ok, level, detail, kind, login, fromKey, since?,
// fix? } }. A result that is not ok carries fix.hint for its kind; login is machineLogin's answer,
// so the set-up screen can say whether this computer is signed in. fromKey names the variable
// that decided ('ANTHROPIC_API_KEY' for an 'api-key' result from the variable,
// 'CLAUDE_CODE_OAUTH_TOKEN' for 'subscription-token'), or is null when no key decided (the login
// on this computer, a cloud provider, a gateway token, none, unknown): a name, never a value.
// `claude auth status` runs at most once per check. claudeSignIn's own result stays as it is, for
// `foreman cloud doctor`. With a config, the two Claude names in .env.foreman count where the
// environment lacks them; .env.local never does.
export function signInCheck(config) {
  return {
    name: 'claude sign-in',
    step: 'claude-signin',
    run(ctx) {
      let env = config ? withSessionKeys(ctx.env ?? {}, sessionKeys({ root: ctx.root, config, fs: ctx.fs })) : ctx.env;
      // No project root (the cloud doctor's own checks): no switch to read.
      const signIn = typeof ctx.root === 'string' ? readSignIn(stateDir(ctx.root, config, ctx.env ?? {})) : { using: 'key', since: null };
      const switched = signIn.using === 'subscription';
      if (switched) {
        env = { ...env };
        delete env.ANTHROPIC_API_KEY;
      }
      const sh = onceForStatus(ctx.sh);
      const login = machineLogin(sh);
      const said = claudeSignIn({ env, sh });
      const { kind, ok, level } = said;
      let { detail } = said;
      const more = {};
      if (switched) {
        const back = '(`foreman claude use-key` goes back to the key)';
        if (signIn.limit === 'usage') {
          const returns = signIn.resetAt ? ` (access returns ${signIn.resetAt})` : '';
          detail = `Since ${localStamp(signIn.since)} the Console API key has been at its usage limit${returns}, so sessions use your subscription ${back}. ${detail}`;
        } else {
          detail = `Since ${localStamp(signIn.since)} the platform credits ran out, so sessions use your subscription ${back}. ${detail}`;
        }
        more.since = signIn.since;
      } else if (signIn.since) {
        detail = `${detail} (back on the Console API key since ${localStamp(signIn.since)})`;
      }
      let fromKey = null;
      if (kind === 'api-key' && isSet(env, 'ANTHROPIC_API_KEY')) fromKey = 'ANTHROPIC_API_KEY';
      if (kind === 'subscription-token') fromKey = 'CLAUDE_CODE_OAUTH_TOKEN';
      if (ok || !Object.hasOwn(HINTS, kind)) return { ok, level, detail, kind, login, fromKey, ...more };
      return { ok, level, detail, kind, login, fromKey, ...more, fix: { hint: HINTS[kind] } };
    },
  };
}
