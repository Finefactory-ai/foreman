import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { checkShape, generateKey, KEY_CARD, KEY_STEPS, KEYS, keyInfo, stepForKey, testKey } from './keys.mjs';

describe('KEY_STEPS', () => {
  it('still ties each key to its set-up step', () => {
    expect(KEY_STEPS.RESEND_API_KEY).toBe('notifications');
    expect(KEY_STEPS.FOREMAN_NOTIFY_EMAIL).toBe('notifications');
    expect(stepForKey('ACME_DB_URL')).toBe('project-keys');
  });
});

describe('KEYS and keyInfo', () => {
  it('describes every key Foreman owns, plus GH_TOKEN, frozen', () => {
    expect(Object.isFrozen(KEYS)).toBe(true);
    expect(KEYS.map((k) => k.name).sort()).toEqual([
      'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'FACTORY_NOTIFY_EMAIL', 'FOREMAN_DASHBOARD_TOKEN', 'FOREMAN_NOTIFY_EMAIL',
      'GEARSET_API_TOKEN', 'GH_TOKEN', 'JIRA_CLIENT_ID', 'JIRA_CLIENT_SECRET', 'RESEND_API_KEY', 'RESEND_FROM_EMAIL',
    ]);
    expect(keyInfo('RESEND_API_KEY')).toMatchObject({ label: 'Resend API key', secret: true, test: 'resend' });
    expect(keyInfo('RESEND_FROM_EMAIL')).toMatchObject({ secret: false, test: 'format' });
    expect(keyInfo('CLAUDE_CODE_OAUTH_TOKEN').testLabel).toBe('Test it (uses a few tokens)');
  });

  it('treats any other name as a one-word secret with no test', () => {
    expect(keyInfo('ACME_X')).toMatchObject({ name: 'ACME_X', label: 'ACME_X', secret: true, test: null });
    expect(checkShape('ACME_X', 'acme-value')).toBeNull();
    expect(checkShape('ACME_X', 'acme value')).toBe('This has spaces in it; paste the value only.');
  });
});

describe('checkShape', () => {
  it('sends each Claude sign-in to the right place', () => {
    expect(checkShape('ANTHROPIC_API_KEY', 'sk-ant-oat01-acme')).toBe('This looks like a subscription token (sk-ant-oat…); put it under Subscription.');
    expect(checkShape('CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-api03-acme')).toBe('This looks like a Console API key (sk-ant-api…); put it under Console API key.');
    expect(checkShape('ANTHROPIC_API_KEY', 'acme-key')).toBe('This does not look like a Console API key: it starts with sk-ant-api.');
    expect(checkShape('CLAUDE_CODE_OAUTH_TOKEN', 'acme-token')).toBe('This does not look like a subscription token: run `claude setup-token` and paste what it prints.');
    expect(checkShape('ANTHROPIC_API_KEY', 'sk-ant-api03-acme')).toBeNull();
    expect(checkShape('CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat01-acme')).toBeNull();
  });

  it.each([
    ['RESEND_API_KEY', 'acme_resend_value', 'This does not look like a Resend API key: it starts with re_.'],
    ['RESEND_FROM_EMAIL', 'acme-at-example', 'This is not an email address.'],
    ['FOREMAN_NOTIFY_EMAIL', 'acme@', 'This is not an email address.'],
    ['JIRA_CLIENT_ID', 'acmeshortid', "This does not look like a Jira app client ID: copy it from the app's Settings page."],
    ['JIRA_CLIENT_SECRET', 'acme!secret!value!long!', "This does not look like a Jira app secret: copy it from the app's Settings page."],
    ['FOREMAN_DASHBOARD_TOKEN', 'acme-short-dashboard', 'This is not long enough for a dashboard token: it needs 32 characters or more.'],
    ['GH_TOKEN', 'acme_github_value', 'This does not look like a GitHub token: it starts with ghp_ or github_pat_.'],
    ['RESEND_API_KEY', '', 'This is empty.'],
    ['GEARSET_API_TOKEN', 'acme gearset', 'This has spaces in it; paste the value only.'],
    ['RESEND_API_KEY', 're_acme\nvalue', 'This has spaces in it; paste the value only.'],
  ])('%s %j says so without the value', (name, value, message) => {
    const said = checkShape(name, value);
    expect(said).toBe(message);
    if (value) expect(said).not.toContain(value);
  });

  it('passes good values', () => {
    expect(checkShape('RESEND_API_KEY', 're_acme_123')).toBeNull();
    expect(checkShape('RESEND_FROM_EMAIL', 'acme@example.com')).toBeNull();
    expect(checkShape('JIRA_CLIENT_ID', 'AcmeClientId0123456789')).toBeNull();
    expect(checkShape('GH_TOKEN', 'github_pat_acme')).toBeNull();
    expect(checkShape('GEARSET_API_TOKEN', 'acme-gearset')).toBeNull();
  });

  it('caps each value before any regex, and checks emails in linear time', () => {
    const started = performance.now();
    const said = checkShape('RESEND_FROM_EMAIL', `a@${'.'.repeat(50000)}@`);
    expect(performance.now() - started).toBeLessThan(50);
    expect(typeof said).toBe('string');
    expect(checkShape('RESEND_FROM_EMAIL', `${'a'.repeat(311)}@acme.test`)).toBe('This is too long for an email address: 320 characters at most.');
    expect(checkShape('GEARSET_API_TOKEN', 'x'.repeat(4097))).toBe('This is too long: 4096 characters at most.');
    expect(checkShape('GEARSET_API_TOKEN', 'x'.repeat(4096))).toBeNull();
    expect(checkShape('FOREMAN_NOTIFY_EMAIL', 'owner@acme.test')).toBeNull();
    expect(checkShape('FOREMAN_NOTIFY_EMAIL', 'first.last@mail.acme.co.uk')).toBeNull();
    for (const bad of ['a@b', 'a@.acme', 'a@acme.', 'a@acme..test']) expect(checkShape('FOREMAN_NOTIFY_EMAIL', bad), bad).toBe('This is not an email address.');
  });
});

describe('generateKey', () => {
  it('makes a new dashboard token each time', () => {
    const a = generateKey('FOREMAN_DASHBOARD_TOKEN');
    const b = generateKey('FOREMAN_DASHBOARD_TOKEN');
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(checkShape('FOREMAN_DASHBOARD_TOKEN', a)).toBeNull();
  });

  it('generates nothing for a key someone else issues', () => {
    expect(() => generateKey('RESEND_API_KEY')).toThrow();
  });
});

describe('KEY_CARD', () => {
  it("holds the key card's words, frozen, each a non-empty string", () => {
    expect(Object.isFrozen(KEY_CARD)).toBe(true);
    const words = Object.values(KEY_CARD);
    expect(words.length).toBeGreaterThan(10);
    for (const [id, text] of Object.entries(KEY_CARD)) expect(typeof text === 'string' && text.length > 0, id).toBe(true);
  });

  it('leaves a {file} for the page to fill in only where the words name the file', () => {
    const withFile = Object.entries(KEY_CARD).filter(([, text]) => text.includes('{file}')).map(([id]) => id);
    expect(withFile.sort()).toEqual(['notIgnored', 'removeAsk', 'setIn']);
  });
});

// A fake service on 127.0.0.1 that records each request and echoes the key in its body.
let server;
afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  server = null;
});

async function fake(answer) {
  const seen = [];
  server = http.createServer((req, res) => {
    seen.push({ path: req.url, headers: req.headers });
    const r = answer(req);
    if (!r) return; // never answers
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(r.body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

const echo = (status, extra = {}) => (req) => ({ status, body: { ...extra, said: `${req.headers['x-api-key'] ?? ''} ${req.headers.authorization ?? ''}` } });

describe('testKey against Anthropic', () => {
  const KEY = 'sk-ant-api03-acmeacmeacme0001';
  it.each([
    [200, true, 'Anthropic accepted the key'],
    [401, false, 'Anthropic did not accept the key'],
    [403, false, 'Anthropic did not accept the key'],
    [500, false, 'Anthropic answered 500'],
  ])('%i', async (status, ok, detail) => {
    const s = await fake(echo(status));
    const r = await testKey('ANTHROPIC_API_KEY', KEY, { base: { anthropic: s.url } });
    expect(r).toEqual({ ok, detail });
    expect(s.seen[0].path).toBe('/v1/models');
    expect(s.seen[0].headers['x-api-key']).toBe(KEY);
    expect(s.seen[0].headers['anthropic-version']).toBe('2023-06-01');
  });

  it('says when it does not answer in time', async () => {
    const s = await fake(() => null);
    expect(await testKey('ANTHROPIC_API_KEY', KEY, { base: { anthropic: s.url }, timeoutMs: 50 })).toEqual({ ok: false, detail: 'Anthropic did not answer in time' });
  });

  it('says when it cannot be reached', async () => {
    const fetch = async () => { throw new TypeError(`fetch failed for ${KEY}`); };
    expect(await testKey('ANTHROPIC_API_KEY', KEY, { fetch })).toEqual({ ok: false, detail: 'could not reach Anthropic' });
  });
});

describe('testKey against Resend', () => {
  const KEY = 're_acme_value_0001';
  it.each([
    [200, {}, true, 'Resend accepted the key'],
    [401, { name: 'restricted_api_key' }, true, 'a send-only key: it can send email'],
    [401, { name: 'validation_error' }, false, 'Resend did not accept the key'],
    [403, {}, false, 'Resend did not accept the key'],
  ])('%i %j', async (status, extra, ok, detail) => {
    const s = await fake(echo(status, extra));
    const r = await testKey('RESEND_API_KEY', KEY, { base: { resend: s.url } });
    expect(r).toEqual({ ok, detail });
    expect(r.detail).not.toContain(KEY);
    expect(s.seen[0].path).toBe('/domains');
    expect(s.seen[0].headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it('says when it does not answer in time', async () => {
    const s = await fake(() => null);
    expect(await testKey('RESEND_API_KEY', KEY, { base: { resend: s.url }, timeoutMs: 50 })).toEqual({ ok: false, detail: 'Resend did not answer in time' });
  });
});

describe('testKey against Gearset', () => {
  const KEY = 'acme-gearset-token-0001';
  it.each([
    [200, true, 'Gearset accepted the token'],
    [401, false, 'Gearset did not accept the token'],
    [403, false, "the Gearset Reporting API is not on for this token's team (Teams or Enterprise tier)"],
  ])('%i', async (status, ok, detail) => {
    const s = await fake(echo(status));
    const r = await testKey('GEARSET_API_TOKEN', KEY, { base: { gearset: s.url } });
    expect(r).toEqual({ ok, detail });
    expect(s.seen[0].path).toBe('/public/reporting/pipelines');
    expect(s.seen[0].headers.authorization).toBe(`token ${KEY}`);
    expect(s.seen[0].headers['api-version']).toBe('3.0');
    expect(s.seen[0].headers.accept).toBe('application/json');
  });

  it('says when it does not answer in time', async () => {
    const s = await fake(() => null);
    expect(await testKey('GEARSET_API_TOKEN', KEY, { base: { gearset: s.url }, timeoutMs: 50 })).toEqual({ ok: false, detail: 'Gearset did not answer in time' });
  });
});

describe('testKey through the runner checks', () => {
  const TOKEN = 'sk-ant-oat01-acmeacmeacme0001';
  const recorder = (answer) => {
    const calls = [];
    const sh = (cmd, args, opts = {}) => {
      calls.push({ cmd, args, env: opts.env });
      return answer(cmd, args);
    };
    return { sh, calls };
  };

  it('asks Claude with the subscription token and no API key', async () => {
    const { sh, calls } = recorder(() => ({ status: 0, stdout: '{"type":"result","is_error":false,"result":"ok"}\n', stderr: '' }));
    const env = { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant-api03-acmeother', ANTHROPIC_AUTH_TOKEN: 'acme', CLAUDE_CODE_USE_BEDROCK: '1' };
    const r = await testKey('CLAUDE_CODE_OAUTH_TOKEN', TOKEN, { sh, env });
    expect(r.ok).toBe(true);
    expect(calls[0].cmd).toBe('claude');
    expect(calls[0].env).toEqual({ PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
  });

  it('fails without saying the token', async () => {
    const { sh } = recorder(() => ({ status: 1, stdout: '', stderr: `invalid token ${TOKEN}\n` }));
    const r = await testKey('CLAUDE_CODE_OAUTH_TOKEN', TOKEN, { sh });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('did not answer');
    expect(r.detail).not.toContain(TOKEN);
  });

  it('checks a GitHub token with gh', async () => {
    const GH = 'ghp_acmeacmeacmeacmeacme0001';
    const good = recorder(() => ({ status: 0, stdout: 'acme\n', stderr: '' }));
    const r = await testKey('GH_TOKEN', GH, { sh: good.sh, env: { PATH: '/usr/bin' } });
    expect(r.ok).toBe(true);
    expect(good.calls[0]).toMatchObject({ cmd: 'gh', args: ['api', 'user', '--jq', '.login'], env: { PATH: '/usr/bin', GH_TOKEN: GH } });

    const bad = recorder(() => ({ status: 1, stdout: '', stderr: `HTTP 401: Bad credentials ${GH}\n` }));
    const no = await testKey('GH_TOKEN', GH, { sh: bad.sh });
    expect(no.ok).toBe(false);
    expect(no.detail).not.toContain(GH);
  });
});

describe('testKey by format', () => {
  it('passes good values and names a key it has no test for', async () => {
    expect(await testKey('JIRA_CLIENT_ID', 'AcmeClientId0123456789', {})).toEqual({ ok: true, detail: 'looks right' });
    expect(await testKey('RESEND_FROM_EMAIL', 'acme@example.com', {})).toEqual({ ok: true, detail: 'looks right' });
    expect(await testKey('RESEND_FROM_EMAIL', 'acme', {})).toEqual({ ok: false, detail: 'This is not an email address.' });
    expect(await testKey('ACME_X', 'acme', {})).toEqual({ ok: false, detail: 'Foreman has no test for ACME_X' });
  });
});

describe('testKey blanks the value from any detail', () => {
  // The value is not token-shaped and not in env, so only testKey's own redact blanks it.
  const VALUE = 'acme-plain-value-01';

  it('blanks it from a failing detail', async () => {
    const tests = { github: async (v) => ({ ok: false, detail: `gh said ${v} twice: ${v}` }) };
    expect(await testKey('GH_TOKEN', VALUE, { tests })).toEqual({ ok: false, detail: 'gh said ••• twice: •••' });
  });

  it('blanks it from a passing detail', async () => {
    const tests = { resend: async (v) => ({ ok: true, detail: `Resend took ${v}` }) };
    expect(await testKey('RESEND_API_KEY', VALUE, { tests })).toEqual({ ok: true, detail: 'Resend took •••' });
  });
});
