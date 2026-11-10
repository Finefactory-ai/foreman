// The Claude sign-in screen of Set up: its words, and which sign-in the sessions will use.
//
//   SIGNIN                         plain data, deep-frozen: { cards, login, words }. cards are the
//                                  two key cards in order, each { id, key, title, note }; login is
//                                  the "signed in on this computer" card; words are the lines
//                                  signInUse fills in ({where}, {file}, {detail}, {time})
//   signInUse({ rows, result, fallback }) -> { uses, line, login, switchBack }
//                                  rows are GET /api/setup's key rows of the two names ({ name,
//                                  set, source, file }); result is the cached 'claude sign-in'
//                                  doctor result, or undefined; fallback is claude-signin.json's
//                                  record (engine/claude-fallback.mjs readSignIn), or undefined.
//                                  uses is one of 'other', 'fallback', 'api-key', 'subscription',
//                                  'login', 'unknown', 'none'. switchBack is true only for
//                                  'fallback': the run moved to the subscription when the platform
//                                  credits ran out or the key reached its usage limit, and the
//                                  screen offers to use the key again. fallback's limit 'usage'
//                                  picks words.usageBack (with {resetAt}, the time Claude Code
//                                  said access returns) or words.usage (no time said)
//
// signInUse follows Claude Code's order, as claudeSignIn (lib/engine/claude-signin.mjs) does: a
// cloud provider or a gateway token, then ANTHROPIC_API_KEY, then CLAUDE_CODE_OAUTH_TOKEN, then
// the login on this computer. The API key wins wherever each key comes from, because the sessions
// merge the environment and .env.foreman before Claude Code chooses (foreman-keys.mjs
// withSessionKeys). It reads names, places and the cached result only: no value goes in.
//
// A cached 'api-key' or 'subscription-token' result that a key decided (fromKey not null, or
// missing in an older setup-checks.json), with no key row set now, reads as out of date
// ('unknown', words.stale): the key it came from has gone, so it says nothing about the login on
// this computer. Only fromKey null, a Console key stored on this computer, reads as 'login'.

import { SELLING } from '../engine/claude-signin.mjs';
import { hhmm } from '../engine/claude-fallback.mjs';

const freeze = (v) => {
  if (v && typeof v === 'object') {
    for (const x of Object.values(v)) freeze(x);
    Object.freeze(v);
  }
  return v;
};

export const SIGNIN = freeze({
  cards: [
    { id: 'api-key', key: 'ANTHROPIC_API_KEY', title: 'Console API key', note: 'Pay per use. Needed to sell Foreman or run it for others.' },
    {
      id: 'subscription',
      key: 'CLAUDE_CODE_OAUTH_TOKEN',
      title: 'Subscription',
      note: `For your own projects. Run \`claude setup-token\` in a terminal and paste the token it prints. ${SELLING}`,
    },
  ],
  login: {
    title: 'Already signed in on this computer',
    note: 'Claude Code is signed in here with `claude auth login`. Foreman uses that sign-in when no key or token is saved.',
  },
  words: {
    other: 'In use: {detail}. It comes before both cards, so neither is used.',
    fallback: 'In use: your subscription since {time}, because the platform credits ran out. Use the API key again once they are topped up.',
    usage: 'In use: your subscription since {time}, because the Console API key reached its usage limit. Use the API key again once its limit is raised or access returns.',
    usageBack: 'In use: your subscription since {time}, because the Console API key reached its usage limit (access returns {resetAt}). Use the API key again once its limit is raised or access returns.',
    apiKey: 'In use: the Console API key, {where}.',
    both: 'The subscription token is set too, but the API key wins, as it does in Claude Code. Remove the API key to switch to the subscription.',
    subscription: 'In use: the subscription token, {where}.',
    login: 'In use: the sign-in on this computer.',
    unknown: 'No key or token saved. Press Test it to see whether this computer is signed in.',
    stale: 'The last check is out of date: no key or token is saved now. Press Test it to see which sign-in is in use.',
    none: 'Nothing signs Claude in yet: save a Console API key or a subscription token, or run `claude auth login`.',
    inEnvironment: 'set in the environment',
    inFile: 'saved in {file}',
  },
});

const W = SIGNIN.words;
const OTHER = new Set(['cloud-provider', 'gateway-token']);
const KEY_KINDS = new Set(['api-key', 'subscription-token']);

const fill = (text, values) => text.replace(/\{(\w+)\}/g, (all, name) => (Object.hasOwn(values, name) ? String(values[name]) : all));
const where = (row) => (row.source === 'environment' ? W.inEnvironment : fill(W.inFile, { file: row.file }));

export function signInUse({ rows = [], result, fallback } = {}) {
  const byName = (name) => (Array.isArray(rows) ? rows : []).find((r) => r?.name === name && r.set === true);
  const apiKey = byName('ANTHROPIC_API_KEY');
  const token = byName('CLAUDE_CODE_OAUTH_TOKEN');
  const login = result?.login === 'signed-in';
  const said = (uses, line) => ({ uses, line, login, switchBack: false });

  if (OTHER.has(result?.kind)) return said('other', fill(W.other, { detail: result.detail }));
  // The sessions leave the API key out since the credits ran out or the key reached its usage
  // limit, whatever the rows say.
  if (fallback?.using === 'subscription') {
    const time = hhmm(fallback.since);
    let line = fill(W.fallback, { time });
    if (fallback.limit === 'usage') line = fallback.resetAt ? fill(W.usageBack, { time, resetAt: fallback.resetAt }) : fill(W.usage, { time });
    return { ...said('fallback', line), switchBack: true };
  }
  if (apiKey) {
    const line = fill(W.apiKey, { where: where(apiKey) });
    return said('api-key', token ? `${line} ${W.both}` : line);
  }
  if (token) return said('subscription', `${fill(W.subscription, { where: where(token) })} ${SELLING}`);
  if (KEY_KINDS.has(result?.kind) && result.fromKey !== null) return said('unknown', W.stale);
  if (login) return said('login', result.kind === 'login' ? `${W.login} ${SELLING}` : W.login);
  if (!result || result.login === 'unknown' || result.login === undefined) return said('unknown', W.unknown);
  return said('none', W.none);
}
