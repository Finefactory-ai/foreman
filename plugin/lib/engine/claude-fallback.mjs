// Which Claude sign-in the story sessions use after the platform credits ran out. Sessions start
// on the Console API key (ANTHROPIC_API_KEY) when there is one. When a session dies because the
// key is out of credit or reached the usage limit set on it (classify.mjs api-credit, limit
// 'balance' or 'usage'), the supervisor records the switch here and
// starts every later session without the key, so Claude Code uses the subscription
// (CLAUDE_CODE_OAUTH_TOKEN, else the claude.ai login on this computer). Nothing switches back
// on its own: `foreman claude use-key` or the Set up tab's action does.
//
// It owns <stateDir>/claude-signin.json, { using: 'key' | 'subscription', since: ISO, reason },
// plus { limit: 'usage', resetAt: string | null } after a usage limit, and never holds a key's
// value. Apart from reading and writing that file it is pure.
//
//   SIGNIN_FILE                       'claude-signin.json'
//   readSignIn(dir)                   the record; { using: 'key', since: null, reason: '' }
//                                     when the file is missing or unreadable; limit and resetAt
//                                     only when the file says limit 'usage'
//   useSubscription(dir, now, { limit, resetAt })
//                                     records the switch, through a temp file and a rename;
//                                     { switched, record }, switched false (and nothing written)
//                                     when it already says subscription. limit 'usage' records
//                                     the usage limit and when access returns; anything else is
//                                     the empty balance
//   useKey(dir, { now, hasKey })      back to the key: { ok, changed, line }; refuses with no key
//   fallbackOf(config)                claude.fallback: 'subscription' (the default) or 'none'
//   hhmm(iso), localStamp(iso)        local time: 'HH:MM', 'YYYY-MM-DD HH:MM'
//   creditsOutFyi(record)             the line Waiting on you and the notification carry, naming
//                                     the usage limit and when access returns for limit 'usage'
//   creditPauseReason({ since, fallback, limit, resetAt })
//                                     why the run paused instead of switching, under 300 characters

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SIGNIN_FILE = 'claude-signin.json';

const DEFAULT = Object.freeze({ using: 'key', since: null, reason: '' });
const USING = ['key', 'subscription'];

export function readSignIn(dir) {
  try {
    const raw = JSON.parse(readFileSync(join(dir, SIGNIN_FILE), 'utf8'));
    if (!raw || typeof raw !== 'object' || !USING.includes(raw.using)) return { ...DEFAULT };
    const record = { using: raw.using, since: typeof raw.since === 'string' ? raw.since : null, reason: typeof raw.reason === 'string' ? raw.reason : '' };
    if (raw.limit === 'usage') Object.assign(record, { limit: 'usage', resetAt: typeof raw.resetAt === 'string' && raw.resetAt ? raw.resetAt : null });
    return record;
  } catch {
    return { ...DEFAULT };
  }
}

// Through a temp file, so a reader never sees half of it.
function write(dir, record) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, SIGNIN_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record)}\n`);
  renameSync(tmp, file);
}

const iso = (now) => (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString();

export function useSubscription(dir, now = new Date(), { limit, resetAt } = {}) {
  const current = readSignIn(dir);
  if (current.using === 'subscription') return { switched: false, record: current };
  const record =
    limit === 'usage'
      ? { using: 'subscription', since: iso(now), reason: 'API key usage limit reached', limit: 'usage', resetAt: typeof resetAt === 'string' && resetAt ? resetAt : null }
      : { using: 'subscription', since: iso(now), reason: 'API credits used up' };
  write(dir, record);
  return { switched: true, record };
}

export function useKey(dir, { now = new Date(), hasKey = false } = {}) {
  if (!hasKey) return { ok: false, changed: false, line: 'No ANTHROPIC_API_KEY in the environment or .env.foreman: add the key first.' };
  if (readSignIn(dir).using === 'key') return { ok: true, changed: false, line: 'Already using the Console API key.' };
  write(dir, { using: 'key', since: iso(now), reason: 'switched back by you' });
  return { ok: true, changed: true, line: 'Sessions use the Console API key again from the next story.' };
}

export const fallbackOf = (config) => (config?.claude?.fallback === 'none' ? 'none' : 'subscription');

const pad = (n) => String(n).padStart(2, '0');
const dateOf = (value) => {
  const d = new Date(value ?? Date.now());
  return Number.isNaN(d.getTime()) ? new Date() : d;
};

export function hhmm(value) {
  const d = dateOf(value);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function localStamp(value) {
  const d = dateOf(value);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hhmm(d)}`;
}

// The opening line for a key that reached the usage limit set on it; `cut` shortens the return time.
const usageLimitAt = (since, resetAt, cut = Infinity) =>
  `The Console API key reached its usage limit at ${hhmm(since)}${resetAt ? ` (access returns ${String(resetAt).slice(0, cut)})` : ''}`;

// "Claude subscription", never a plan's name: Foreman does not know which plan a user has.
export const creditsOutFyi = (record) =>
  record?.limit === 'usage'
    ? `${usageLimitAt(record.since, record.resetAt)}; now using your Claude subscription.`
    : `Platform credits ran out at ${hhmm(record?.since)}; now using your Claude subscription.`;

export function creditPauseReason({ since, fallback, limit, resetAt } = {}) {
  const at = hhmm(since);
  if (limit === 'usage') {
    const opening = usageLimitAt(since, resetAt, 40);
    const raise = "Raise the key's limit on console.anthropic.com or wait for access to return";
    if (fallback === 'none') return `${opening}. claude.fallback is "none", so Foreman paused instead of using your subscription. ${raise}, then press Resume.`;
    return `${opening}; no subscription sign-in was found (set CLAUDE_CODE_OAUTH_TOKEN or run \`claude auth login\`). ${raise}, then press Resume.`;
  }
  if (fallback === 'none') {
    return `Platform credits ran out at ${at}. claude.fallback is "none", so Foreman paused instead of using your subscription. Top up the credits, then press Resume.`;
  }
  return `Platform credits ran out at ${at}, and no subscription sign-in was found to switch to (set CLAUDE_CODE_OAUTH_TOKEN in .env.foreman or run \`claude auth login\`). Top up the credits or add a sign-in, then press Resume.`;
}
