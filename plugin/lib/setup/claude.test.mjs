import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SIGNIN, signInUse } from './claude.mjs';
import { SELLING, signInCheck } from '../engine/claude-signin.mjs';

const API = 'sk-ant-api03-acme-key-0123';
const OAT = 'sk-ant-oat01-acme-token-4567';
const LOGGED_IN = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' };

// A fake shell answering `claude auth status --json` with `status`.
const fakeSh = (status) => () => ({ status: 0, stdout: JSON.stringify(status), stderr: '' });

// The key rows GET /api/setup carries for the two names: names and places only.
const row = (name, source = null) => ({ name, set: source !== null, source, file: '.env.foreman' });
const rows = (api = null, oat = null) => [row('ANTHROPIC_API_KEY', api), row('CLAUDE_CODE_OAUTH_TOKEN', oat)];

// Where each key is: 'file', 'environment' or null.
const PAIRINGS = [
  { name: 'API key in the file', api: 'file', oat: null, uses: 'api-key' },
  { name: 'API key in the environment', api: 'environment', oat: null, uses: 'api-key' },
  { name: 'token in the file', api: null, oat: 'file', uses: 'subscription' },
  { name: 'token in the environment', api: null, oat: 'environment', uses: 'subscription' },
  { name: 'both in the file', api: 'file', oat: 'file', uses: 'api-key' },
  { name: 'API key in the environment, token in the file', api: 'environment', oat: 'file', uses: 'api-key' },
  { name: 'token in the environment, API key in the file', api: 'file', oat: 'environment', uses: 'api-key' },
];

let dirs = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('signInUse', () => {
  it('names the Console API key saved in .env.foreman', () => {
    const r = signInUse({ rows: rows('file'), result: undefined });
    expect(r.uses).toBe('api-key');
    expect(r.line).toContain('Console API key');
    expect(r.line).toContain('saved in .env.foreman');
    expect(r.line).not.toMatch(/wins/);
  });

  it('names the Console API key set in the environment', () => {
    const r = signInUse({ rows: rows('environment'), result: undefined });
    expect(r.uses).toBe('api-key');
    expect(r.line).toContain('set in the environment');
    expect(r.line).not.toContain('saved in');
  });

  it.each(PAIRINGS.filter((p) => p.api && p.oat))('lets the API key win when both are set: $name', ({ api, oat }) => {
    const r = signInUse({ rows: rows(api, oat), result: undefined });
    expect(r.uses).toBe('api-key');
    expect(r.line).toMatch(/API key wins/);
    expect(r.line).toMatch(/subscription/i);
  });

  it('names the subscription token, with the selling warning', () => {
    for (const source of ['file', 'environment']) {
      const r = signInUse({ rows: rows(null, source), result: undefined });
      expect(r.uses).toBe('subscription');
      expect(r.line).toContain(SELLING);
      expect(r.line).toContain(source === 'file' ? 'saved in .env.foreman' : 'set in the environment');
    }
  });

  it('names the sign-in on this computer, with the selling warning for a claude.ai login', () => {
    const r = signInUse({ rows: rows(), result: { kind: 'login', login: 'signed-in', detail: 'claude.ai login' } });
    expect(r).toMatchObject({ uses: 'login', login: true });
    expect(r.line).toContain(SELLING);
    const consoleLogin = signInUse({ rows: rows(), result: { kind: 'api-key', login: 'signed-in', fromKey: null, detail: 'Console API key on this machine' } });
    expect(consoleLogin).toMatchObject({ uses: 'login', login: true });
    expect(consoleLogin.line).not.toContain(SELLING);
    const claudeAi = signInUse({ rows: rows(), result: { kind: 'login', login: 'signed-in', fromKey: null, detail: 'claude.ai login' } });
    expect(claudeAi).toMatchObject({ uses: 'login', login: true });
    expect(claudeAi.line).toContain(SELLING);
  });

  it('says the last check is out of date when a key kind is cached but no key is saved', () => {
    const results = [
      { kind: 'api-key', login: 'signed-in', fromKey: 'ANTHROPIC_API_KEY', detail: 'Console API key' },
      { kind: 'subscription-token', login: 'signed-in', fromKey: 'CLAUDE_CODE_OAUTH_TOKEN', detail: 'x' },
      // An older setup-checks.json, written before the check named its key.
      { kind: 'api-key', login: 'signed-in', detail: 'Console API key' },
    ];
    for (const result of results) {
      const r = signInUse({ rows: rows(), result });
      expect(r, JSON.stringify(result)).toEqual({ uses: 'unknown', line: SIGNIN.words.stale, switchBack: false, login: true });
      expect(r.line).not.toContain('In use: the sign-in on this computer');
    }
    expect(signInUse({ rows: rows(), result: { ...results[0], login: 'signed-out' } }).login).toBe(false);
  });

  it('never lets an out-of-date check override a saved key', () => {
    const api = signInUse({ rows: rows('file'), result: { kind: 'subscription-token', login: 'signed-in', fromKey: 'CLAUDE_CODE_OAUTH_TOKEN', detail: 'x' } });
    expect(api.uses).toBe('api-key');
    const sub = signInUse({ rows: rows(null, 'file'), result: { kind: 'api-key', login: 'signed-in', fromKey: 'ANTHROPIC_API_KEY', detail: 'Console API key' } });
    expect(sub.uses).toBe('subscription');
    expect(sub.line).toContain(SELLING);
  });

  it('keeps the fallback and a cloud provider ahead of an out-of-date check', () => {
    const since = new Date(2026, 9, 25, 14, 32).toISOString();
    const fallback = { using: 'subscription', since, reason: 'API credits used up' };
    const cached = { kind: 'subscription-token', login: 'signed-in', fromKey: 'CLAUDE_CODE_OAUTH_TOKEN', detail: 'x' };
    expect(signInUse({ rows: rows(), result: cached, fallback })).toMatchObject({ uses: 'fallback', switchBack: true });
    expect(signInUse({ rows: rows(), result: { kind: 'cloud-provider', login: 'signed-in', fromKey: null, detail: 'Amazon Bedrock' } }).uses).toBe('other');
  });

  it('asks for Test it when nothing is saved and the sign-in on this computer is not known', () => {
    for (const result of [undefined, { kind: 'unknown', login: 'unknown', detail: 'x' }]) {
      const r = signInUse({ rows: rows(), result });
      expect(r).toMatchObject({ uses: 'unknown', login: false });
      expect(r.line).toBe('No key or token saved. Press Test it to see whether this computer is signed in.');
    }
  });

  it('says what to do when nothing signs Claude in', () => {
    const r = signInUse({ rows: rows(), result: { kind: 'none', login: 'signed-out', detail: 'no sign-in' } });
    expect(r).toMatchObject({ uses: 'none', login: false });
    expect(r.line).toContain('`claude auth login`');
    expect(r.line).toMatch(/Console API key/);
    expect(r.line).toMatch(/subscription token/);
  });

  it('puts a cloud provider or a gateway token before both cards', () => {
    for (const kind of ['cloud-provider', 'gateway-token']) {
      const detail = kind === 'cloud-provider' ? 'Amazon Bedrock (CLAUDE_CODE_USE_BEDROCK): billed by your cloud account' : 'gateway or proxy token (ANTHROPIC_AUTH_TOKEN)';
      const r = signInUse({ rows: rows('file', 'file'), result: { kind, login: 'signed-in', detail } });
      expect(r.uses).toBe('other');
      expect(r.line).toContain(detail);
      expect(r.line).toMatch(/before both/);
    }
  });

  it('says login only when the computer is signed in, and never carries a value', () => {
    expect(signInUse({ rows: rows('file'), result: { kind: 'api-key', login: 'signed-in', detail: 'Console API key' } }).login).toBe(true);
    expect(signInUse({ rows: rows('file'), result: { kind: 'api-key', login: 'signed-out', detail: 'Console API key' } }).login).toBe(false);
    const withValues = [{ ...row('ANTHROPIC_API_KEY', 'file'), masked: '•••• 0123' }, { ...row('CLAUDE_CODE_OAUTH_TOKEN', 'file'), masked: '•••• 4567' }];
    const text = JSON.stringify(signInUse({ rows: withValues, result: undefined }));
    expect(text).not.toContain('0123');
    expect(text).not.toContain('4567');
    expect(Object.keys(signInUse({ rows: rows(), result: undefined })).sort()).toEqual(['line', 'login', 'switchBack', 'uses']);
  });

  it('says the subscription is in use since the credits ran out, and offers the way back', () => {
    const since = new Date(2026, 9, 25, 14, 32).toISOString();
    const fallback = { using: 'subscription', since, reason: 'API credits used up' };
    const r = signInUse({ rows: rows('file', 'file'), result: { kind: 'subscription-token', login: 'signed-in', detail: 'x' }, fallback });
    expect(r).toEqual({ uses: 'fallback', line: 'In use: your subscription since 14:32, because the platform credits ran out. Use the API key again once they are topped up.', login: true, switchBack: true });
    expect(SIGNIN.words.fallback).toBe('In use: your subscription since {time}, because the platform credits ran out. Use the API key again once they are topped up.');
  });

  it('says the key reached its usage limit, and when access returns', () => {
    const since = new Date(2026, 9, 25, 14, 32).toISOString();
    const fallback = { using: 'subscription', since, reason: 'API key usage limit reached', limit: 'usage', resetAt: '2026-11-01 at 00:00 UTC' };
    const r = signInUse({ rows: rows('file', 'file'), result: { kind: 'subscription-token', login: 'signed-in', detail: 'x' }, fallback });
    expect(r).toEqual({
      uses: 'fallback',
      line: 'In use: your subscription since 14:32, because the Console API key reached its usage limit (access returns 2026-11-01 at 00:00 UTC). Use the API key again once its limit is raised or access returns.',
      login: true,
      switchBack: true,
    });
    expect(SIGNIN.words.usage).toBe('In use: your subscription since {time}, because the Console API key reached its usage limit. Use the API key again once its limit is raised or access returns.');
    expect(SIGNIN.words.usageBack).toBe('In use: your subscription since {time}, because the Console API key reached its usage limit (access returns {resetAt}). Use the API key again once its limit is raised or access returns.');
  });

  it('says the usage limit with no return time', () => {
    const since = new Date(2026, 9, 25, 14, 32).toISOString();
    const fallback = { using: 'subscription', since, reason: 'API key usage limit reached', limit: 'usage', resetAt: null };
    const r = signInUse({ rows: rows('file', 'file'), result: { kind: 'subscription-token', login: 'signed-in', detail: 'x' }, fallback });
    expect(r).toEqual({
      uses: 'fallback',
      line: 'In use: your subscription since 14:32, because the Console API key reached its usage limit. Use the API key again once its limit is raised or access returns.',
      login: true,
      switchBack: true,
    });
  });

  it('puts a cloud provider before a usage-limit record', () => {
    const fallback = { using: 'subscription', since: new Date(2026, 9, 25, 14, 32).toISOString(), reason: 'API key usage limit reached', limit: 'usage', resetAt: '2026-11-01 at 00:00 UTC' };
    const r = signInUse({ rows: rows('file', 'file'), result: { kind: 'cloud-provider', login: 'signed-in', detail: 'Amazon Bedrock' }, fallback });
    expect(r.uses).toBe('other');
    expect(r.switchBack).toBe(false);
  });

  it('offers no way back on the key, or with no record', () => {
    const cases = [
      { rows: rows('file'), result: undefined },
      { rows: rows('file'), result: undefined, fallback: { using: 'key', since: null, reason: '' } },
      { rows: rows('file'), result: undefined, fallback: { using: 'key', since: '2026-10-26T09:00:00.000Z', reason: 'switched back by you' } },
      { rows: rows(null, 'file'), result: undefined },
      { rows: rows(), result: { kind: 'login', login: 'signed-in', detail: 'claude.ai login' } },
      { rows: rows(), result: { kind: 'none', login: 'signed-out', detail: 'no sign-in' } },
      { rows: rows(), result: undefined },
      { rows: rows('file'), result: { kind: 'cloud-provider', login: 'signed-in', detail: 'Amazon Bedrock' } },
    ];
    for (const c of cases) expect(signInUse(c).switchBack, JSON.stringify(c)).toBe(false);
  });

  it.each(PAIRINGS)('agrees with the doctor: $name', ({ api, oat, uses }) => {
    const root = mkdtempSync(join(tmpdir(), 'foreman-signin-'));
    dirs.push(root);
    const env = {};
    const file = [];
    if (api === 'environment') env.ANTHROPIC_API_KEY = API;
    if (api === 'file') file.push(`ANTHROPIC_API_KEY=${API}`);
    if (oat === 'environment') env.CLAUDE_CODE_OAUTH_TOKEN = OAT;
    if (oat === 'file') file.push(`CLAUDE_CODE_OAUTH_TOKEN=${OAT}`);
    writeFileSync(join(root, '.env.foreman'), `${file.join('\n')}\n`, { mode: 0o600 });
    const config = { version: 1, project: { name: 'Acme' } };
    const result = signInCheck(config).run({ root, env, sh: fakeSh(LOGGED_IN) });
    expect(result.kind).toBe(uses === 'api-key' ? 'api-key' : 'subscription-token');
    expect(signInUse({ rows: rows(api, oat), result: { name: 'claude sign-in', ...result } }).uses).toBe(uses);
  });
});

describe('SIGNIN', () => {
  it('puts the selling warning on the Subscription card only', () => {
    const [apiKey, subscription] = SIGNIN.cards;
    expect(subscription.note).toContain(SELLING);
    expect(apiKey.note).not.toContain(SELLING);
    expect(subscription.note).toContain('`claude setup-token`');
  });

  it('is deep-frozen plain JSON, with the two cards in order', () => {
    const walk = (v, at) => {
      expect(typeof v, at).not.toBe('function');
      if (v && typeof v === 'object') {
        expect(Object.isFrozen(v), at).toBe(true);
        for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`);
      }
    };
    walk(SIGNIN, 'SIGNIN');
    expect(JSON.parse(JSON.stringify(SIGNIN))).toEqual(SIGNIN);
    expect(SIGNIN.cards.map((c) => c.key)).toEqual(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);
    expect(SIGNIN.cards.map((c) => c.title)).toEqual(['Console API key', 'Subscription']);
    expect(SIGNIN.login.title).toBe('Already signed in on this computer');
    expect(JSON.stringify(SIGNIN)).not.toMatch(/this Mac/);
    expect(SIGNIN.words.stale).toBe('The last check is out of date: no key or token is saved now. Press Test it to see which sign-in is in use.');
    expect(Object.isFrozen(SIGNIN.words)).toBe(true);
  });
});
