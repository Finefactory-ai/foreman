// Scrubbing text that goes to or comes back from the learner session: secrets, emails and the
// owner's paths. Pure.
//
//   scrub(text, { env, values, redact, root, home }) -> text, in this order:
//       1. the env's secret variables and the exact `values` (the project's file secrets),
//          longest first, then token-shaped text (secrets/redact.mjs)
//       2. each `learning.redact` entry: `/src/flags` is a regex (always global; one that does
//          not compile is literal text), anything else literal
//       3. the looks-secret patterns of state-store/branch.mjs
//       4. the looks-secret patterns of engine/state.mjs (JWTs, NAME_KEY=value, ...)
//       5. emails become <email>
//       6. `root/` is dropped, so paths are project-relative; a bare root becomes .
//       7. the home folder becomes ~
//       8. any other /home/<name> or macOS user folder becomes ~
//   Blanked text becomes •••. Running it twice gives the same text.
//   scrubDeep(value, opts)   scrub on every string inside plain objects and arrays
//   holdsSecret(value)       true when any string or key, at any depth, looks like a secret

import os from 'node:os';
import { redact as redactValues } from '../secrets/redact.mjs';
import { SECRET_PATTERNS, looksSecret } from '../state-store/branch.mjs';
import { redact as redactLooksSecret } from './state.mjs';

const BLANK = '•••';
const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
const OTHER_HOME = /\/(?:Users|home)\/[\w.-]+/g;
const PATTERNS = SECRET_PATTERNS.map((re) => new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`));
const AS_REGEX = /^\/(.+)\/([a-z]*)$/;

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// `path` where it is not the start of a longer name (/home/acme, not /home/acme2).
const whole = (path) => new RegExp(`${escape(path)}(?![\\w.-])`, 'g');
const usable = (path) => typeof path === 'string' && path.length > 1 && path.startsWith('/');

// A learning.redact entry as the thing to blank: a global RegExp, or the literal text.
function entryOf(entry) {
  const m = AS_REGEX.exec(entry);
  if (!m) return entry;
  try {
    return new RegExp(m[1], [...new Set(`${m[2]}g`)].join(''));
  } catch {
    return entry;
  }
}

export function scrub(text, { env = {}, values = [], redact = [], root = '', home = os.homedir() } = {}) {
  const exact = [...values].filter((v) => typeof v === 'string' && v !== '').sort((a, b) => b.length - a.length);
  let out = redactValues(String(text ?? ''), { env, values: exact });
  for (const entry of redact ?? []) {
    if (typeof entry !== 'string' || !entry) continue;
    const what = entryOf(entry);
    out = typeof what === 'string' ? out.split(what).join(BLANK) : out.replace(what, BLANK);
  }
  for (const re of PATTERNS) out = out.replace(re, BLANK);
  out = redactLooksSecret(out);
  out = out.replace(EMAIL, '<email>');
  const top = usable(root) ? root.replace(/\/+$/, '') : '';
  if (top) out = out.split(`${top}/`).join('').replace(whole(top), '.');
  const own = usable(home) ? home.replace(/\/+$/, '') : '';
  if (own) out = out.replace(whole(own), '~');
  return out.replace(OTHER_HOME, '~');
}

const isPlain = (v) => v !== null && typeof v === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(v));

export function scrubDeep(value, opts) {
  if (typeof value === 'string') return scrub(value, opts);
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, opts));
  if (isPlain(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubDeep(v, opts)]));
  return value;
}

// Each raw string is checked on its own: JSON.stringify would turn a line break before a token
// into `\n`, and the `\b` in the patterns would then miss it.
export function holdsSecret(value) {
  const seen = new Set();
  const walk = (v) => {
    if (typeof v === 'string') return looksSecret(v);
    if (!v || typeof v !== 'object' || seen.has(v)) return false;
    seen.add(v);
    return Object.entries(v).some(([k, x]) => looksSecret(k) || walk(x));
  };
  return walk(value);
}
