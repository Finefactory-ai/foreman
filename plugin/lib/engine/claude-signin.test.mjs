import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeSignIn, machineLogin, SELLING, signInCheck, subscriptionSignIn, subscriptionSignInAsync } from './claude-signin.mjs';
import { localStamp, useKey, useSubscription } from './claude-fallback.mjs';

const SECRET = 'sk-ant-super-secret-value-123';
const TOKEN = 'sk-ant-oat01-secret-token-456';

// A fake shell that answers `claude auth status --json` with `status`, and records calls.
function fakeSh(status) {
  const calls = [];
  const sh = (cmd, args = []) => {
    calls.push([cmd, ...args].join(' '));
    if (status === undefined) return { status: 1, stdout: '', stderr: 'unknown command' };
    return { status: 0, stdout: typeof status === 'string' ? status : JSON.stringify(status), stderr: '' };
  };
  sh.calls = calls;
  return sh;
}

const LOGGED_IN = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' };

describe('claudeSignIn', () => {
  it('reports a Console API key as per-token billing', () => {
    const r = claudeSignIn({ env: { ANTHROPIC_API_KEY: SECRET }, sh: fakeSh(LOGGED_IN) });
    expect(r).toMatchObject({ kind: 'api-key', ok: true, level: 'error' });
    expect(r.detail).toBe('Console API key: per-token billing');
  });

  it('reports a subscription token as counting against the plan, and warns about selling', () => {
    const r = claudeSignIn({ env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, sh: fakeSh(LOGGED_IN) });
    expect(r).toMatchObject({ kind: 'subscription-token', ok: false, level: 'warn' });
    expect(r.detail).toMatch(/^Claude subscription token: counts against your plan's limits/);
    expect(r.detail).toMatch(/selling Foreman, or running it for others, needs a Console API key/);
  });

  it('lets the API key win when both are set, and says so', () => {
    const r = claudeSignIn({ env: { ANTHROPIC_API_KEY: SECRET, CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, sh: fakeSh(LOGGED_IN) });
    expect(r).toMatchObject({ kind: 'api-key', ok: true });
    expect(r.detail).toMatch(/CLAUDE_CODE_OAUTH_TOKEN is also set; the API key wins/);
  });

  it('falls back to the claude.ai login on this machine, and warns about selling', () => {
    const sh = fakeSh(LOGGED_IN);
    const r = claudeSignIn({ env: {}, sh });
    expect(sh.calls).toEqual(['claude auth status --json']);
    expect(r).toMatchObject({ kind: 'login', ok: false, level: 'warn' });
    expect(r.detail).toMatch(/^claude\.ai login on this machine: counts against your plan's limits/);
    expect(r.detail).toMatch(/needs a Console API key/);
  });

  it('reads a Console key stored on this machine as per-token billing', () => {
    const r = claudeSignIn({ env: {}, sh: fakeSh({ loggedIn: true, authMethod: 'oauth_token', apiKeySource: '/login managed key' }) });
    expect(r).toMatchObject({ kind: 'api-key', ok: true });
    expect(r.detail).toBe('Console API key on this machine: per-token billing');
  });

  it('fails when nothing signs Claude in', () => {
    const r = claudeSignIn({ env: {}, sh: fakeSh({ loggedIn: false }) });
    expect(r).toMatchObject({ kind: 'none', ok: false, level: 'error' });
    expect(r.detail).toMatch(/ANTHROPIC_API_KEY/);
    expect(r.detail).toMatch(/claude auth login/);
  });

  it('warns, not fails, when the login cannot be read', () => {
    for (const sh of [fakeSh(undefined), fakeSh('not json')]) {
      const r = claudeSignIn({ env: {}, sh });
      expect(r).toMatchObject({ kind: 'unknown', ok: false, level: 'warn' });
      expect(r.detail).toMatch(/claude auth status/);
    }
  });

  it('treats an empty variable as unset', () => {
    const r = claudeSignIn({ env: { ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, sh: fakeSh(LOGGED_IN) });
    expect(r.kind).toBe('subscription-token');
  });

  it('puts a cloud provider and a gateway token ahead of the API key, as Claude Code does', () => {
    const bedrock = claudeSignIn({ env: { CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_API_KEY: SECRET }, sh: fakeSh(LOGGED_IN) });
    expect(bedrock).toMatchObject({ kind: 'cloud-provider', ok: true });
    expect(bedrock.detail).toMatch(/Amazon Bedrock/);
    expect(claudeSignIn({ env: { CLAUDE_CODE_USE_VERTEX: '1' }, sh: fakeSh(LOGGED_IN) }).detail).toMatch(/Vertex/);
    expect(claudeSignIn({ env: { CLAUDE_CODE_USE_FOUNDRY: 'true' }, sh: fakeSh(LOGGED_IN) }).detail).toMatch(/Foundry/);
    expect(claudeSignIn({ env: { CLAUDE_CODE_USE_BEDROCK: '0', ANTHROPIC_API_KEY: SECRET }, sh: fakeSh(LOGGED_IN) }).kind).toBe('api-key');
    const gateway = claudeSignIn({ env: { ANTHROPIC_AUTH_TOKEN: TOKEN, ANTHROPIC_API_KEY: SECRET }, sh: fakeSh(LOGGED_IN) });
    expect(gateway).toMatchObject({ kind: 'gateway-token', ok: true });
    expect(gateway.detail).toMatch(/ANTHROPIC_AUTH_TOKEN/);
  });

  it('never puts a value into the result', () => {
    const envs = [
      { ANTHROPIC_API_KEY: SECRET },
      { CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
      { ANTHROPIC_API_KEY: SECRET, CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
      { ANTHROPIC_AUTH_TOKEN: TOKEN },
      {},
    ];
    for (const env of envs) {
      const text = JSON.stringify(claudeSignIn({ env, sh: fakeSh({ ...LOGGED_IN, email: 'me@example.com' }) }));
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain('me@example.com');
    }
  });

  it('does not run the CLI when a variable decides', () => {
    const sh = fakeSh(LOGGED_IN);
    claudeSignIn({ env: { ANTHROPIC_API_KEY: SECRET }, sh });
    claudeSignIn({ env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, sh });
    expect(sh.calls).toEqual([]);
  });
});

describe('machineLogin', () => {
  it('says whether Claude Code is signed in on this computer, and nothing else', () => {
    expect(machineLogin(fakeSh(LOGGED_IN))).toBe('signed-in');
    expect(machineLogin(fakeSh({ ...LOGGED_IN, email: 'me@example.com' }))).toBe('signed-in');
    expect(machineLogin(fakeSh({ loggedIn: false }))).toBe('signed-out');
    expect(machineLogin(fakeSh(undefined))).toBe('unknown');
    expect(machineLogin(fakeSh('not json'))).toBe('unknown');
  });
});

describe('SELLING', () => {
  it('is the sentence the subscription detail carries', () => {
    expect(typeof SELLING).toBe('string');
    expect(SELLING).toMatch(/needs a Console API key/);
    expect(claudeSignIn({ env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, sh: fakeSh(LOGGED_IN) }).detail).toContain(SELLING);
  });
});

describe('signInCheck', () => {
  it('is a doctor check named "claude sign-in"', () => {
    const check = signInCheck();
    expect(check.name).toBe('claude sign-in');
    expect(check.run({ env: { ANTHROPIC_API_KEY: SECRET }, sh: fakeSh(LOGGED_IN) })).toEqual({
      ok: true,
      level: 'error',
      detail: 'Console API key: per-token billing',
      kind: 'api-key',
      login: 'signed-in',
      fromKey: 'ANTHROPIC_API_KEY',
    });
  });

  it('names the key that decided, by name only', () => {
    const cases = [
      [{ ANTHROPIC_API_KEY: SECRET }, LOGGED_IN, 'api-key', 'ANTHROPIC_API_KEY'],
      [{ CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, LOGGED_IN, 'subscription-token', 'CLAUDE_CODE_OAUTH_TOKEN'],
      [{}, { loggedIn: true, apiKeySource: 'x' }, 'api-key', null],
      [{}, LOGGED_IN, 'login', null],
      [{ CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_API_KEY: SECRET }, LOGGED_IN, 'cloud-provider', null],
      [{ ANTHROPIC_AUTH_TOKEN: TOKEN, ANTHROPIC_API_KEY: SECRET }, LOGGED_IN, 'gateway-token', null],
      [{}, { loggedIn: false }, 'none', null],
      [{}, undefined, 'unknown', null],
    ];
    for (const [env, status, kind, fromKey] of cases) {
      const r = signInCheck().run({ env, sh: fakeSh(status) });
      const at = JSON.stringify({ env: Object.keys(env), status });
      expect(r.kind, at).toBe(kind);
      expect(r.fromKey, at).toBe(fromKey);
      expect(JSON.stringify(r), at).not.toContain(SECRET);
      expect(JSON.stringify(r), at).not.toContain(TOKEN);
    }
  });

  it('runs `claude auth status --json` exactly once, even when no variable is set', () => {
    for (const env of [{}, { ANTHROPIC_API_KEY: SECRET }, { CLAUDE_CODE_OAUTH_TOKEN: TOKEN }]) {
      for (const status of [LOGGED_IN, { loggedIn: false }, undefined]) {
        const sh = fakeSh(status);
        signInCheck().run({ env, sh });
        expect(sh.calls, JSON.stringify({ env, status })).toEqual(['claude auth status --json']);
      }
    }
  });

  it('carries the kind and the login on this computer, and never the email', () => {
    const sh = fakeSh({ ...LOGGED_IN, email: 'me@example.com' });
    const r = signInCheck().run({ env: {}, sh });
    expect(r).toMatchObject({ kind: 'login', login: 'signed-in' });
    expect(JSON.stringify(r)).not.toContain('me@example.com');
    const keyed = signInCheck().run({ env: { ANTHROPIC_API_KEY: SECRET }, sh: fakeSh({ ...LOGGED_IN, email: 'me@example.com' }) });
    expect(JSON.stringify(keyed)).not.toContain('me@example.com');
    expect(signInCheck().run({ env: {}, sh: fakeSh({ loggedIn: false }) })).toMatchObject({ kind: 'none', login: 'signed-out' });
    expect(signInCheck().run({ env: {}, sh: fakeSh(undefined) })).toMatchObject({ kind: 'unknown', login: 'unknown' });
  });

  it('belongs to the claude-signin step', () => {
    expect(signInCheck().step).toBe('claude-signin');
  });

  it('gives each kind of missing or limited sign-in a plain hint', () => {
    const run = (env, sh) => signInCheck().run({ env, sh });
    const none = run({}, fakeSh({ loggedIn: false }));
    expect(none).toMatchObject({ ok: false, level: 'error' });
    expect(none.fix.hint).toBe('set ANTHROPIC_API_KEY or run `claude auth login`');
    for (const r of [run({}, fakeSh(LOGGED_IN)), run({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, fakeSh(LOGGED_IN))]) {
      expect(r.fix.hint).toBe('use a Console API key (ANTHROPIC_API_KEY) if you sell Foreman or run it for others');
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    }
    expect(run({}, fakeSh(undefined)).fix.hint).toBe('check the sign-in with `claude auth status`');
  });

  it('leaves claudeSignIn returning exactly kind, ok, level and detail', () => {
    for (const status of [LOGGED_IN, { loggedIn: false }, undefined]) {
      expect(Object.keys(claudeSignIn({ env: {}, sh: fakeSh(status) })).sort()).toEqual(['detail', 'kind', 'level', 'ok']);
    }
  });
});

describe('subscriptionSignIn', () => {
  const FAKE_KEY = 'sk-ant-acme-fake-0000000000000000000000';
  // A fake shell that records the env it was given.
  const shWith = (status) => {
    const sh = fakeSh(status);
    const wrapped = (cmd, args = [], opts = {}) => {
      wrapped.envs.push(opts.env);
      return sh(cmd, args, opts);
    };
    wrapped.envs = [];
    wrapped.calls = sh.calls;
    return wrapped;
  };

  it('finds the subscription token without asking the CLI', () => {
    const sh = shWith(LOGGED_IN);
    expect(subscriptionSignIn({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'acme-oauth-fake', ANTHROPIC_API_KEY: FAKE_KEY }, sh })).toBe('token');
    expect(sh.calls).toEqual([]);
  });

  it('finds a claude.ai login, asking without the API key in the environment', () => {
    const sh = shWith({ loggedIn: true, authMethod: 'claude.ai' });
    const env = { ANTHROPIC_API_KEY: FAKE_KEY, PATH: '/usr/bin' };
    expect(subscriptionSignIn({ env, sh })).toBe('login');
    expect(sh.calls).toEqual(['claude auth status --json']);
    expect(sh.envs[0]).toEqual({ PATH: '/usr/bin' });
    expect(env.ANTHROPIC_API_KEY).toBe(FAKE_KEY);
  });

  it('finds nothing when signed out, on a Console login, or when the CLI cannot say', () => {
    expect(subscriptionSignIn({ env: {}, sh: shWith({ loggedIn: false }) })).toBeNull();
    expect(subscriptionSignIn({ env: {}, sh: shWith({ loggedIn: true, authMethod: 'oauth_token', apiKeySource: '/login managed key' }) })).toBeNull();
    expect(subscriptionSignIn({ env: {}, sh: shWith({ loggedIn: true, authMethod: 'console' }) })).toBeNull();
    expect(subscriptionSignIn({ env: {}, sh: shWith(undefined) })).toBeNull();
  });
});

describe('subscriptionSignInAsync', () => {
  const FAKE_KEY = 'sk-ant-acme-fake-0000000000000000000000';
  // A fake `run` that answers `claude auth status --json` with `answer` (or rejects), and records calls.
  const runWith = (answer) => {
    const run = async (cmd, args, opts) => {
      run.calls.push([cmd, args, opts]);
      if (answer instanceof Error) throw answer;
      return answer;
    };
    run.calls = [];
    return run;
  };
  const said = (status) => ({ status: 0, stdout: JSON.stringify(status), timedOut: false });

  it('finds the subscription token without asking the CLI', async () => {
    const run = runWith(said(LOGGED_IN));
    expect(await subscriptionSignInAsync({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'acme-oauth-fake', ANTHROPIC_API_KEY: FAKE_KEY }, run })).toBe('token');
    expect(run.calls).toEqual([]);
  });

  it('finds a claude.ai login, asking once without the API key and within 30 s', async () => {
    const run = runWith(said({ loggedIn: true, authMethod: 'claude.ai' }));
    const env = { ANTHROPIC_API_KEY: FAKE_KEY, PATH: '/usr/bin' };
    expect(await subscriptionSignInAsync({ env, run })).toBe('login');
    expect(run.calls).toEqual([['claude', ['auth', 'status', '--json'], { env: { PATH: '/usr/bin' }, timeout: 30_000 }]]);
    expect(env).toEqual({ ANTHROPIC_API_KEY: FAKE_KEY, PATH: '/usr/bin' });
  });

  it.each([
    ['signed out', said({ loggedIn: false })],
    ['a Console login by its method', said({ loggedIn: true, authMethod: 'console' })],
    ['a Console login by its key source', said({ loggedIn: true, authMethod: 'oauth_token', apiKeySource: '/login managed key' })],
    ['a check that timed out', { status: 0, stdout: JSON.stringify(LOGGED_IN), timedOut: true }],
    ['a check that failed', { status: 1, stdout: JSON.stringify(LOGGED_IN), timedOut: false }],
    ['an answer that is not JSON', { status: 0, stdout: 'unknown command', timedOut: false }],
    ['an answer that is not an object', { status: 0, stdout: 'true', timedOut: false }],
    ['a check that could not run', new Error('spawn claude ENOENT')],
  ])('finds nothing on %s', async (_, answer) => {
    expect(await subscriptionSignInAsync({ env: { PATH: '/usr/bin' }, run: runWith(answer) })).toBeNull();
  });
});

describe('signInCheck after the credits ran out', () => {
  const FAKE_KEY = 'sk-ant-acme-fake-0000000000000000000000';
  const AT = '2026-10-25T14:32:00.000Z';
  const config = { version: 1, project: { name: 'Acme' } };
  let roots = [];
  afterEach(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
    roots = [];
  });
  const project = () => {
    const root = mkdtempSync(join(tmpdir(), 'foreman-signin-fallback-'));
    roots.push(root);
    writeFileSync(join(root, '.env.foreman'), `ANTHROPIC_API_KEY=${FAKE_KEY}\nCLAUDE_CODE_OAUTH_TOKEN=acme-oauth-fake\n`, { mode: 0o600 });
    return root;
  };

  it('says the sessions use the subscription, and since when', () => {
    const root = project();
    useSubscription(join(root, '.foreman'), new Date(AT));
    const r = signInCheck(config).run({ root, env: {}, sh: fakeSh(LOGGED_IN) });
    expect(r.kind).toBe('subscription-token');
    expect(r.since).toBe(AT);
    expect(r.detail.startsWith(`Since ${localStamp(AT)} the platform credits ran out, so sessions use your subscription (\`foreman claude use-key\` goes back to the key). `)).toBe(true);
    expect(r.detail).toContain('Claude subscription token');
    expect(JSON.stringify(r)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(r)).not.toContain('acme-oauth-fake');
  });

  it('names the usage limit and when access returns', () => {
    const root = project();
    useSubscription(join(root, '.foreman'), new Date(AT), { limit: 'usage', resetAt: '2026-11-01 at 00:00 UTC' });
    const r = signInCheck(config).run({ root, env: {}, sh: fakeSh(LOGGED_IN) });
    expect(r.kind).toBe('subscription-token');
    expect(r.since).toBe(AT);
    expect(r.detail.startsWith(`Since ${localStamp(AT)} the Console API key has been at its usage limit (access returns 2026-11-01 at 00:00 UTC), so sessions use your subscription (\`foreman claude use-key\` goes back to the key). `)).toBe(true);
    expect(r.detail).not.toContain('platform credits');
    expect(JSON.stringify(r)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(r)).not.toContain('acme-oauth-fake');
  });

  it('names the usage limit with no return time', () => {
    const root = project();
    useSubscription(join(root, '.foreman'), new Date(AT), { limit: 'usage' });
    const r = signInCheck(config).run({ root, env: {}, sh: fakeSh(LOGGED_IN) });
    expect(r.kind).toBe('subscription-token');
    expect(r.since).toBe(AT);
    expect(r.detail.startsWith(`Since ${localStamp(AT)} the Console API key has been at its usage limit, so sessions use your subscription (\`foreman claude use-key\` goes back to the key). `)).toBe(true);
    expect(r.detail).not.toContain('(access returns');
    expect(r.detail).not.toContain('platform credits');
    expect(JSON.stringify(r)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(r)).not.toContain('acme-oauth-fake');
  });

  it('says when it went back to the key', () => {
    const root = project();
    const state = join(root, '.foreman');
    useSubscription(state, new Date(AT));
    const back = '2026-10-26T09:05:00.000Z';
    useKey(state, { now: new Date(back), hasKey: true });
    const r = signInCheck(config).run({ root, env: {}, sh: fakeSh(LOGGED_IN) });
    expect(r.kind).toBe('api-key');
    expect(r.detail.endsWith(` (back on the Console API key since ${localStamp(back)})`)).toBe(true);
  });

  it('is as before with no record', () => {
    const root = project();
    const r = signInCheck(config).run({ root, env: {}, sh: fakeSh(LOGGED_IN) });
    expect(r).toEqual({ ok: true, level: 'error', detail: 'Console API key: per-token billing (CLAUDE_CODE_OAUTH_TOKEN is also set; the API key wins)', kind: 'api-key', login: 'signed-in', fromKey: 'ANTHROPIC_API_KEY' });
  });

  it('names the token as the key that decided once the sessions moved to it', () => {
    const root = project();
    useSubscription(join(root, '.foreman'), new Date(AT));
    const r = signInCheck(config).run({ root, env: {}, sh: fakeSh(LOGGED_IN) });
    expect(r).toMatchObject({ kind: 'subscription-token', fromKey: 'CLAUDE_CODE_OAUTH_TOKEN' });
    expect(JSON.stringify(r)).not.toContain(FAKE_KEY);
  });
});
