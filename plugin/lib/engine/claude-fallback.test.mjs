import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { creditPauseReason, creditsOutFyi, fallbackOf, hhmm, localStamp, readSignIn, SIGNIN_FILE, useKey, useSubscription } from './claude-fallback.mjs';

const KEY = 'sk-ant-acme-fake-0000000000000000000000';
const AT = '2026-10-25T14:32:00.000Z';
const BACK = '2026-11-01 at 00:00 UTC';
const pad = (n) => String(n).padStart(2, '0');
const local = (iso) => {
  const d = new Date(iso);
  return { hm: `${pad(d.getHours())}:${pad(d.getMinutes())}`, day: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` };
};

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foreman-fallback-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const file = () => join(dir, SIGNIN_FILE);
const saved = () => JSON.parse(readFileSync(file(), 'utf8'));

describe('readSignIn', () => {
  it('says key when there is no file, or one it cannot read', () => {
    expect(SIGNIN_FILE).toBe('claude-signin.json');
    expect(readSignIn(dir)).toEqual({ using: 'key', since: null, reason: '' });
    writeFileSync(file(), 'not json');
    expect(readSignIn(dir)).toEqual({ using: 'key', since: null, reason: '' });
    expect(readSignIn(join(dir, 'missing'))).toEqual({ using: 'key', since: null, reason: '' });
  });
});

describe('useSubscription', () => {
  it('writes the switch once and keeps the first time', () => {
    const first = useSubscription(dir, new Date(AT));
    expect(first).toEqual({ switched: true, record: { using: 'subscription', since: AT, reason: 'API credits used up' } });
    expect(saved()).toEqual(first.record);
    const second = useSubscription(dir, new Date('2026-10-25T16:00:00.000Z'));
    expect(second).toEqual({ switched: false, record: first.record });
    expect(saved().since).toBe(AT);
    expect(readSignIn(dir)).toEqual(first.record);
  });

  it('records a usage limit and when access returns, once', () => {
    const first = useSubscription(dir, new Date(AT), { limit: 'usage', resetAt: BACK });
    const record = { using: 'subscription', since: AT, reason: 'API key usage limit reached', limit: 'usage', resetAt: BACK };
    expect(first).toEqual({ switched: true, record });
    expect(saved()).toEqual(record);
    expect(readSignIn(dir)).toEqual(record);
    const second = useSubscription(dir, new Date('2026-10-25T16:00:00.000Z'), { limit: 'usage', resetAt: '2026-12-01 at 00:00 UTC' });
    expect(second).toEqual({ switched: false, record });
    expect(saved()).toEqual(record);
  });

  it('records a usage limit with no return time as null, and a balance as before', () => {
    expect(useSubscription(dir, new Date(AT), { limit: 'usage' }).record).toEqual({ using: 'subscription', since: AT, reason: 'API key usage limit reached', limit: 'usage', resetAt: null });
    expect(readSignIn(dir)).toEqual({ using: 'subscription', since: AT, reason: 'API key usage limit reached', limit: 'usage', resetAt: null });
    const other = join(dir, 'balance');
    expect(useSubscription(other, new Date(AT), { limit: 'balance', resetAt: BACK }).record).toEqual({ using: 'subscription', since: AT, reason: 'API credits used up' });
    expect(readSignIn(other)).toEqual({ using: 'subscription', since: AT, reason: 'API credits used up' });
  });

  it('makes the state folder when it is not there yet', () => {
    const inner = join(dir, 'state');
    expect(useSubscription(inner, new Date(AT)).switched).toBe(true);
    expect(readSignIn(inner).using).toBe('subscription');
  });
});

describe('useKey', () => {
  it('refuses with no key and writes nothing', () => {
    const r = useKey(dir, { now: new Date(AT), hasKey: false });
    expect(r).toEqual({ ok: false, changed: false, line: 'No ANTHROPIC_API_KEY in the environment or .env.foreman: add the key first.' });
    expect(existsSync(file())).toBe(false);
    useSubscription(dir, new Date(AT));
    expect(useKey(dir, { now: new Date(AT), hasKey: false }).ok).toBe(false);
    expect(readSignIn(dir).using).toBe('subscription');
  });

  it('says so when it is already on the key', () => {
    expect(useKey(dir, { now: new Date(AT), hasKey: true })).toEqual({ ok: true, changed: false, line: 'Already using the Console API key.' });
    expect(existsSync(file())).toBe(false);
  });

  it('goes back to the key after a switch', () => {
    useSubscription(dir, new Date(AT));
    const later = '2026-10-26T09:00:00.000Z';
    const r = useKey(dir, { now: new Date(later), hasKey: true });
    expect(r).toEqual({ ok: true, changed: true, line: 'Sessions use the Console API key again from the next story.' });
    expect(saved()).toEqual({ using: 'key', since: later, reason: 'switched back by you' });
    expect(useKey(dir, { now: new Date(later), hasKey: true }).changed).toBe(false);
  });
});

describe('fallbackOf', () => {
  it('is subscription unless the config says none', () => {
    expect(fallbackOf(undefined)).toBe('subscription');
    expect(fallbackOf({})).toBe('subscription');
    expect(fallbackOf({ claude: { fallback: 'subscription' } })).toBe('subscription');
    expect(fallbackOf({ claude: { fallback: 'none' } })).toBe('none');
  });
});

describe('the words', () => {
  it('gives local times', () => {
    expect(hhmm(AT)).toBe(local(AT).hm);
    expect(localStamp(AT)).toBe(`${local(AT).day} ${local(AT).hm}`);
  });

  it('tells the owner the run switched, at the local time', () => {
    expect(creditsOutFyi({ using: 'subscription', since: AT })).toBe(`Platform credits ran out at ${local(AT).hm}; now using your Claude subscription.`);
  });

  it('tells the owner the key hit its usage limit, and when access returns', () => {
    const usage = { using: 'subscription', since: AT, limit: 'usage', resetAt: BACK };
    expect(creditsOutFyi(usage)).toBe(`The Console API key reached its usage limit at ${local(AT).hm} (access returns ${BACK}); now using your Claude subscription.`);
    expect(creditsOutFyi({ ...usage, resetAt: null })).toBe(`The Console API key reached its usage limit at ${local(AT).hm}; now using your Claude subscription.`);
  });

  it('says why it paused at a usage limit, under 300 characters each', () => {
    for (const resetAt of [BACK, 'y'.repeat(120)]) {
      const none = creditPauseReason({ since: AT, fallback: 'none', limit: 'usage', resetAt });
      const missing = creditPauseReason({ since: AT, fallback: 'subscription', limit: 'usage', resetAt });
      expect(none).toContain('claude.fallback is "none"');
      expect(missing).toContain('CLAUDE_CODE_OAUTH_TOKEN');
      expect(missing).toContain('`claude auth login`');
      for (const text of [none, missing]) {
        expect(text.startsWith(`The Console API key reached its usage limit at ${local(AT).hm} (access returns ${resetAt.slice(0, 40)})`)).toBe(true);
        expect(text).toContain("Raise the key's limit on console.anthropic.com or wait for access to return");
        expect(text).not.toContain('Top up');
        expect(text).toMatch(/then press Resume\.$/);
        expect(text.length).toBeLessThan(300);
      }
    }
    expect(creditPauseReason({ since: AT, fallback: 'none', limit: 'usage' })).toMatch(new RegExp(`^The Console API key reached its usage limit at ${local(AT).hm}\\. `));
  });

  it('says why it paused instead, under 300 characters each', () => {
    const none = creditPauseReason({ since: AT, fallback: 'none' });
    expect(none).toBe(`Platform credits ran out at ${local(AT).hm}. claude.fallback is "none", so Foreman paused instead of using your subscription. Top up the credits, then press Resume.`);
    const missing = creditPauseReason({ since: AT, fallback: 'subscription' });
    expect(missing).toMatch(/no subscription sign-in was found/);
    expect(missing).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(missing).toContain('`claude auth login`');
    expect(missing).toMatch(/press Resume\.$/);
    for (const text of [none, missing]) expect(text.length).toBeLessThan(300);
  });

  it('never carries a key, even with one in .env.foreman beside it', () => {
    writeFileSync(join(dir, '.env.foreman'), `ANTHROPIC_API_KEY=${KEY}\n`, { mode: 0o600 });
    const out = [
      readSignIn(dir),
      useSubscription(dir, new Date(AT)),
      useKey(dir, { now: new Date(AT), hasKey: true }),
      useKey(dir, { now: new Date(AT), hasKey: false }),
      creditsOutFyi({ using: 'subscription', since: AT }),
      creditPauseReason({ since: AT, fallback: 'none' }),
      creditPauseReason({ since: AT, fallback: 'subscription' }),
      readFileSync(file(), 'utf8'),
      useSubscription(join(dir, 'usage'), new Date(AT), { limit: 'usage', resetAt: BACK }),
      readSignIn(join(dir, 'usage')),
      readFileSync(join(dir, 'usage', SIGNIN_FILE), 'utf8'),
      creditsOutFyi({ using: 'subscription', since: AT, limit: 'usage', resetAt: BACK }),
      creditPauseReason({ since: AT, fallback: 'none', limit: 'usage', resetAt: BACK }),
      creditPauseReason({ since: AT, fallback: 'subscription', limit: 'usage', resetAt: BACK }),
    ];
    expect(JSON.stringify(out)).not.toContain(KEY);
  });
});
