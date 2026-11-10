// Reads the log of one factory session and says how it ended. A session that finished
// prints `FACTORY_RESULT: <result> <story id or ->`; the last such line wins. A session
// that died before printing one is checked for why: its Claude sign-in stopped working
// (signin), the Console API key ran out of credit (api-credit), the subscription hit its usage
// limit (credit), the Claude API rate-limited it, or the API was down. Anything else is a plain
// crash.
//
// Pure: takes the log text, returns facts. The supervisor decides what to do with them.
//
// Sessions log stream-json (session.mjs); classifySession reads such a log with
// session-log.mjs and gives classifyRun the session's own words: the readable tail, then the
// final message, so the final message's result line wins. API errors in the stream are written
// there as `API Error: <status> <category>`, the categories being Claude Code's own
// (rate_limit, overloaded, server_error, billing_error, ...).
//
// A Console key whose balance is empty ("Credit balance is too low") is api-credit with limit
// 'balance'. A Console key can also hit a usage limit its owner set on it ("You have reached your
// specified API usage limits"). That is api-credit too, with limit 'usage' and the time access
// returns as resetAt. Both are read only from the session's own error text (session-log.mjs
// errorText, given as { errorText }: an assistant event made from an API error, or a result that
// is an error), never from the log, so a story brief, the conversation, a plain line or a result
// that is not an error that quotes the message does not trip it, nor does a billing_error marker
// that does not name the credit balance. No other cause carries `limit`.
//
// A sign-in that no longer works (an expired or refreshed claude.ai login, a revoked token) is
// signin. It is read only from the session's own error text (Failed to authenticate, an expired
// OAuth session or token, invalid_grant, authentication_error, a 401), or from the category of a
// main-conversation assistant event made from an `authentication_failed` API error
// (session-log.mjs errorCategories, given as { errorCategories }). It is never read from the log or
// the conversation, so a story whose own login fails (a Salesforce invalid_grant, the app's 401), or
// a session that says or quotes `API Error: 401 authentication_failed`, does not trip it.

import { readSessionLog } from './session-log.mjs';

export const RESULTS = ['shipped', 'ready-to-promote', 'blocked', 'failed', 'empty', 'halted', 'deferred', 'held'];

const RESULT_LINE = /FACTORY_RESULT: (\S+)(?:[ \t]+(\S+))?/g;
const TAIL_LINES = 60;

// Read from the log's end. Order matters: an out-of-credit message can arrive as a 429, so the
// subscription's usage limit (credit) is checked first; it only pauses. The Console key's empty
// balance (api-credit) is not here: it is read from the error text before these, so it wins over
// a 429 too.
const CAUSES = [
  // Claude's own wording only: the app has an AI budget of its own that a story may log about.
  ['credit', /You(?:'|\u2019)ve hit your (?:usage )?limit|usage limit reached/i],
  ['rate-limit', /API Error: 429|rate_limit_error|Rate limit reached|Too Many Requests|API Error: \S+ rate_limit\b/],
  ['outage', /API Error: 5\d\d|overloaded_error|\bOverloaded\b|API Error: \S+ (?:overloaded|server_error)\b/],
];
const RESET = /resets? (?:at )?([^\n.]+)/i;
const CREDIT_BALANCE = /Credit balance is too low/i;
const USAGE_LIMIT = /reached your specified API usage limits/i;
const ACCESS_RETURNS = /regain access on ([^\n]+?)\.?\s*$/im;
const SIGNIN_ERROR = /Failed to authenticate|OAuth (?:session|token) (?:has )?expired|invalid_grant|authentication_error|API Error: 401\b/i;

// The last result line that names a known result, or null.
export function lastResult(log) {
  let found = null;
  for (const [, result, id] of log.matchAll(RESULT_LINE)) {
    if (RESULTS.includes(result)) found = { result, story: id && id !== '-' ? id : null };
  }
  return found;
}

const tail = (log, n) => log.split('\n').slice(-n).join('\n');

export function classifyRun(log, { errorText = '', errorCategories = [] } = {}) {
  const text = String(log ?? '');
  const found = lastResult(text);
  if (found) return { ...found, cause: null, resetAt: null };

  const errors = String(errorText ?? '');
  const end = tail(text.trimEnd(), TAIL_LINES);
  if (SIGNIN_ERROR.test(errors) || (Array.isArray(errorCategories) && errorCategories.includes('authentication_failed'))) return { result: null, story: null, cause: 'signin', resetAt: null };

  if (USAGE_LIMIT.test(errors)) {
    const back = errors.match(ACCESS_RETURNS);
    return { result: null, story: null, cause: 'api-credit', resetAt: back ? back[1].trim().slice(0, 60) : null, limit: 'usage' };
  }
  if (CREDIT_BALANCE.test(errors)) return { result: null, story: null, cause: 'api-credit', resetAt: null, limit: 'balance' };

  const hit = CAUSES.find(([, pattern]) => pattern.test(end));
  if (!hit) return { result: null, story: null, cause: null, resetAt: null };
  const reset = end.match(RESET);
  return { result: null, story: null, cause: hit[0], resetAt: reset ? reset[1].trim().slice(0, 60) : null };
}

export function classifySession(logText) {
  const log = readSessionLog(logText);
  return classifyRun(`${log.rawTextTail}\n${log.finalText}`, { errorText: log.errorText, errorCategories: log.errorCategories });
}
