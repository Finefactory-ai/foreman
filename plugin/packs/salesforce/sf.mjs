// The one way the Salesforce pack runs the Salesforce CLI. runSf(sh, args) runs `sf <args> --json`
// through the caller's sh (never through a shell string) and returns { ok, result, error }.
// With the option jsonFlag: false it adds no --json: for a command that prints its own JSON body
// and does not take the flag (`sf api request rest`), whose body is then the result as it is,
// since it has no { status, result } envelope. The default is true.
//
//   ok     true when sf exited 0 and its JSON does not report a failing status
//   result the JSON's `result` when sf wrapped it in its { status, result } envelope, else the
//          parsed JSON as it is (`sf plugins --core` prints an array, `sf version` an object)
//   error  { name, message, exitCode }: never sf's `actions` or `stack`, which can name the
//          aliases of other orgs signed in on this machine
//
// result is returned as sf printed it and can hold an access token (`sf org display` does).
// Callers must never put result, or anything copied from it whole, into a doctor detail or a log.
//
// A failing call gives result null, unless the caller passes keepResult and sf's envelope holds
// a plain-object `result`: then that object is kept. A deploy that fails exits 1 with its whole
// deploy response there. Such a result is read only through deploy-result.mjs, never logged whole.
//
// sf prints its JSON on stdout or, for some errors, on stderr, sometimes after warning lines
// such as " ›   Warning: @salesforce/cli update available". runSf never throws and never retries.
//
// Time limits. sf runs under sf-watch.mjs: the call is `node sf-watch.mjs <limitMs> sf <args>`
// through the same sh, with sh's own timeout 15 seconds past the limit as a backstop. The
// watcher kills sf's whole process group at the limit. The limit is the timeoutMs option when it
// is a positive whole number, else limitFor(args): agent commands 10 minutes, deploys,
// retrieves, Apex and sgd 30 minutes, everything else 2 minutes. No call is ever unlimited.
//
// Login trouble. The watcher also stops sf at once when its output shows a login-rate error
// ("login rate exceeded", REQUEST_LIMIT_EXCEEDED) or a sign-in error (invalid_grant, or "Invalid
// token" three times), which sf can otherwise retry until the org locks its user out. It reads
// stderr, and from stdout only the error sf printed as JSON: its name, message, code, stack and
// cause (an expired refresh token says invalid_grant only in the cause). A successful answer's
// data is never read for it, so text in records cannot stop a call or cool an org down. Those
// results, and the timeout, carry a top-level `code` that ordinary results do not have:
//
//   code 'timeout'     error SfTimeout, "timed out after <time>"
//   code 'login-rate'  error SfLoginRate, "stopped at once: ..."
//   code 'auth'        error SfAuthError, "stopped at once: ..."; isNotSignedIn is true for it.
//                      Its error also has sfMessage, sf's own words (such as "user hasn't
//                      approved this consumer"), which the message above hides. sfMessage
//                      exists only to tell sign-in errors apart; it can name a username, so
//                      it is never shown or logged.
//   code 'cooldown'    error SfCoolingDown: the call was refused and sf never ran
//
// result is null for all four, even with keepResult. stopsRetry(r) is true for the last three:
// a poll loop that gets one stops at once.
//
// Cool-down. After a login-rate result for a target org (--target-org, --target-org= or -o),
// runSf records the org in <sf home>/.foreman/cooldown for COOLDOWN_MS (an hour) and refuses
// every further call to it until then, before starting anything. This applies only through an sh
// that names its sf home in sh.sfHome, as isolatedSh does; calls with no target are never refused.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeId, writeAtomic } from '../../lib/adapters/stories/overlay.mjs';

export const SF_WATCH = fileURLToPath(new URL('./sf-watch.mjs', import.meta.url));
export const TIME_LIMITS = Object.freeze({ agent: 600_000, deploy: 1_800_000, other: 120_000 });
export const COOLDOWN_MS = 3_600_000;

const BACKSTOP_MS = 15_000;
const MAX_MESSAGE = 300;
const VERDICT = 'foreman-sf-watch:';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isJson = (v) => v !== null && typeof v === 'object';
const tidy = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE);

function tryParse(text) {
  try {
    const value = JSON.parse(text);
    return isJson(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

// The JSON in `text`: all of it, or from the first line that starts with "{" or "[" and parses.
function parseJson(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return undefined;
  const whole = tryParse(trimmed);
  if (whole !== undefined) return whole;
  const lines = trimmed.split('\n');
  for (let i = 1; i < lines.length; i += 1) {
    if (!/^[{[]/.test(lines[i])) continue;
    const rest = tryParse(lines.slice(i).join('\n'));
    if (rest !== undefined) return rest;
  }
  return undefined;
}

function call(sh, args, opts) {
  try {
    return sh(process.execPath, args, opts) ?? {};
  } catch (err) {
    return { status: 1, stdout: '', stderr: `${err?.code ?? ''} ${err?.message ?? err}` };
  }
}

// The time limit for `sf <args>`, by command family.
export function limitFor(args) {
  const [a, b] = Array.isArray(args) ? args : [];
  if (a === 'agent') return TIME_LIMITS.agent;
  if ((a === 'project' && (b === 'deploy' || b === 'retrieve')) || a === 'apex' || a === 'sgd') return TIME_LIMITS.deploy;
  return TIME_LIMITS.other;
}

const LOGIN_RATE = [/login rate exceeded/i, /REQUEST_LIMIT_EXCEEDED/];
const INVALID_GRANT = /invalid_grant/i;
const INVALID_TOKEN = /Invalid token/gi;
const TOKEN_REPEATS = 3;

// The login trouble in `text` and the phrase that shows it, or null.
function troubleIn(text) {
  const t = String(text ?? '');
  for (const re of LOGIN_RATE) {
    const m = re.exec(t);
    if (m) return { kind: 'login-rate', phrase: m[0] };
  }
  const grant = INVALID_GRANT.exec(t);
  if (grant) return { kind: 'auth', phrase: grant[0] };
  const tokens = t.match(INVALID_TOKEN) ?? [];
  if (tokens.length >= TOKEN_REPEATS) return { kind: 'auth', phrase: tokens[0], times: tokens.length };
  return null;
}

// 'login-rate' or 'auth' when sf's output shows it cannot sign in and would keep trying, else null.
export function loginTrouble(text) {
  return troubleIn(text)?.kind ?? null;
}

// The text login trouble is looked for in: all of stderr, and from stdout only the error part
// of sf's error envelope: its name, message, code, stack and cause. sf writes the cause as
// inspect() of the inner error, and that is the only place an expired refresh token says
// invalid_grant. A successful answer's data (query records, Apex test failure messages, deploy
// problems, agent replies) can hold any words, so result, data and warnings are never read for it.
export function troubleText(stdout, stderr) {
  const parsed = parseJson(stdout);
  const status = isObject(parsed) && typeof parsed.status === 'number' ? parsed.status : undefined;
  const envelope =
    isObject(parsed) && (status === undefined ? typeof parsed.name === 'string' && typeof parsed.message === 'string' : status !== 0);
  const cause = envelope && isObject(parsed.cause) ? [parsed.cause.name, parsed.cause.message] : [envelope ? parsed.cause : undefined];
  const told = envelope ? [parsed.name, parsed.message, parsed.code, parsed.stack, ...cause].filter((v) => typeof v === 'string').join('\n') : '';
  return `${told}\n${String(stderr ?? '')}`;
}

export const stopsRetry = (r) => ['login-rate', 'auth', 'cooldown'].includes(r?.code);

// The org `args` target, or null.
function targetOf(args) {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if ((a === '--target-org' || a === '-o') && typeof args[i + 1] === 'string' && args[i + 1]) return args[i + 1];
    if (typeof a === 'string' && a.startsWith('--target-org=') && a.length > '--target-org='.length) return a.slice('--target-org='.length);
  }
  return null;
}

const msOf = (now) => (now instanceof Date ? now.getTime() : Number(now));

// The 'org-' prefix keeps an org named '..' inside the folder.
export const cooldownFile = (home, org) => path.join(home, '.foreman', 'cooldown', `org-${safeId(org)}.json`);

export function recordCooldown(home, org, { reason, now = Date.now() } = {}) {
  const at = msOf(now);
  const record = { org, reason: String(reason ?? ''), at: new Date(at).toISOString(), until: new Date(at + COOLDOWN_MS).toISOString() };
  try {
    writeAtomic(cooldownFile(home, org), `${JSON.stringify(record, null, 2)}\n`);
  } catch {
    // The refusal is lost, not the result: runSf still reports the login-rate stop.
  }
  return record;
}

// The cool-down record of `org` while it lasts, else null (also for a missing or broken file).
export function coolingDown(home, org, now = Date.now()) {
  if (typeof home !== 'string' || !home || typeof org !== 'string' || !org) return null;
  try {
    const rec = JSON.parse(fs.readFileSync(cooldownFile(home, org), 'utf8'));
    const until = isObject(rec) && typeof rec.until === 'string' ? Date.parse(rec.until) : NaN;
    return Number.isFinite(until) && until > msOf(now) ? rec : null;
  } catch {
    return null;
  }
}

const duration = (ms) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);

// stderr without the watcher's verdict line, and the verdict it held.
function verdictOf(stderr) {
  let verdict = null;
  const kept = [];
  for (const line of String(stderr).split('\n')) {
    if (!line.trimStart().startsWith(VERDICT)) {
      kept.push(line);
      continue;
    }
    const v = tryParse(line.trimStart().slice(VERDICT.length).trim());
    if (isObject(v) && typeof v.stop === 'string') verdict = v;
  }
  return { verdict, stderr: kept.join('\n') };
}

const failed = (code, name, message, exitCode) => ({ ok: false, code, result: null, error: { name, message, exitCode } });

export function runSf(sh, args, { cwd, timeoutMs, keepResult = false, now, jsonFlag = true } = {}) {
  const list = Array.isArray(args) ? [...args] : [];
  if (jsonFlag !== false && !list.includes('--json')) list.push('--json');
  const target = targetOf(list);
  const home = typeof sh?.sfHome === 'string' && sh.sfHome ? sh.sfHome : null;
  const at = now === undefined ? Date.now() : msOf(now);

  if (home && target) {
    const cool = coolingDown(home, target, at);
    if (cool) {
      const message = `Foreman makes no sf call to ${target} until ${cool.until}: it answered "${cool.reason}" at ${cool.at}; the org can lock out logins for up to an hour`;
      return failed('cooldown', 'SfCoolingDown', message, 1);
    }
  }

  const limit = Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : limitFor(list);
  const r = call(sh, [SF_WATCH, String(limit), 'sf', ...list], { timeout: limit + BACKSTOP_MS, ...(cwd ? { cwd } : {}) });
  const exit = Number.isInteger(r.status) ? r.status : 1;
  const stdout = r.stdout ?? '';
  const { verdict, stderr } = verdictOf(r.stderr ?? '');

  if (verdict?.stop === 'timeout' || (!verdict && r.error?.code === 'ETIMEDOUT')) {
    const ms = Number.isInteger(verdict?.limitMs) && verdict.limitMs > 0 ? verdict.limitMs : limit;
    return failed('timeout', 'SfTimeout', `timed out after ${duration(ms)}`, exit);
  }

  const plain = read(stdout, stderr, exit, keepResult);
  const stopped = verdict?.stop === 'login-rate' || verdict?.stop === 'auth';
  if (!stopped && plain.ok) return plain;
  const text = troubleText(stdout, stderr);
  const trouble = troubleIn(text);
  const kind = stopped ? verdict.stop : trouble?.kind;
  if (!kind) return plain;

  const seen = trouble?.kind === kind ? trouble : { phrase: kind === 'login-rate' ? 'login rate exceeded' : 'Invalid token' };
  const phrase = seen.phrase;
  const answered = `sf answered "${phrase}"${seen.times > 1 ? ` ${seen.times} times` : ''}`;
  const exitCode = stopped ? exit : plain.error?.exitCode ?? exit;
  if (kind === 'auth') {
    const r = failed('auth', 'SfAuthError', `stopped at once: ${answered}, a sign-in error it would keep retrying; Foreman never retries it`, exitCode);
    r.error.sfMessage = sfMessageOf(plain, text, phrase);
    return r;
  }
  let message = `stopped at once: ${answered}, so the org is limiting logins; Foreman never retries it`;
  if (home && target) {
    const rec = recordCooldown(home, target, { reason: phrase, now: at });
    message += `, and makes no sf call to ${target} until ${rec.until}`;
  }
  return failed('login-rate', 'SfLoginRate', message, exitCode);
}

// sf's own words behind an auth stop: its error's message when it printed one as JSON, else the
// first output line holding the phrase. Only for telling sign-in errors apart (set-up's
// classifyLoginError): it can name a username, so it is never shown or logged.
function sfMessageOf(plain, text, phrase) {
  if (plain.error && plain.error.name !== 'NoJson' && plain.error.name !== 'SfNotFound') return tidy(plain.error.message);
  return tidy(text.split('\n').find((line) => line.includes(phrase)) ?? phrase);
}

// The { ok, result, error } that sf's output gives, as before the watcher.
function read(stdout, stderr, exit, keepResult) {
  const parsed = parseJson(stdout) ?? parseJson(stderr);

  if (parsed === undefined) {
    const name = /ENOENT/.test(`${stdout}\n${stderr}`) ? 'SfNotFound' : 'NoJson';
    return { ok: false, result: null, error: { name, message: `sf printed no JSON (exit ${exit})`, exitCode: exit } };
  }

  const status = isObject(parsed) && typeof parsed.status === 'number' ? parsed.status : undefined;
  if (exit === 0 && (status === undefined || status === 0)) {
    const result = status === 0 && Object.hasOwn(parsed, 'result') ? parsed.result : parsed;
    return { ok: true, result, error: null };
  }

  const body = isObject(parsed) ? parsed : {};
  const exitCode = [body.exitCode, status, exit].find((n) => Number.isInteger(n));
  const name = typeof body.name === 'string' && body.name ? body.name : 'SfError';
  const message = tidy(typeof body.message === 'string' && body.message ? body.message : `sf exited ${exit}`);
  const kept = keepResult && status !== undefined && isObject(body.result) ? body.result : null;
  return { ok: false, result: kept, error: { name, message, exitCode } };
}

const SIGNED_OUT_NAMES = ['NamedOrgNotFoundError', 'NoAuthInfoFound', 'AuthInfoNotFound', 'RefreshTokenAuthError', 'NoDefaultEnvError', 'SfAuthError'];
const SIGNED_OUT = /No authorization information|expired access\/refresh token|INVALID_SESSION_ID/i;
const UNREACHABLE = /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|getaddrinfo/i;

// True when sf failed because the org is not signed in on this machine, or its sign-in expired.
export function isNotSignedIn(error) {
  if (!isObject(error)) return false;
  return SIGNED_OUT_NAMES.includes(error.name) || SIGNED_OUT.test(String(error.message ?? ''));
}

// True when sf failed because it could not reach the org over the network.
export function isUnreachable(error) {
  return isObject(error) && UNREACHABLE.test(String(error.message ?? ''));
}
