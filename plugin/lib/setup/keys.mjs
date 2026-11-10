// The keys Foreman knows: which set-up step owns each, what each is called, what a good value
// looks like, and how to test one. A key Foreman itself knows belongs to the step that explains
// it; any other key an adapter or a pack asks for belongs to "Project keys".
//
// Statically this file imports only Node built-ins, so the doctor checks and the set-up steps
// can use it without a cycle. testKey loads ../secrets/redact.mjs, and for the subscription
// and GitHub tests ../cloud/doctor.mjs, with a dynamic import when it runs.
//
//   KEY_STEPS, stepForKey(name)        the set-up step for a key
//   KEYS                               one entry per name (frozen): { name, label, secret,
//                                      shape(value) -> null | message, test, testLabel,
//                                      generate? }
//   keyInfo(name)                      the entry, or a one-word secret with no test for a name
//                                      Foreman does not know
//   checkShape(name, value)            null, or what is wrong, never with the value
//   generateKey(name)                  a new value, for a key Foreman makes itself
//   testKey(name, value, { fetch, sh, env, base, timeoutMs, tests }) -> { ok, detail }
//                                      asks the service (Anthropic, Resend, Gearset), runs the
//                                      cloud doctor's check (subscription, GitHub), or checks
//                                      the shape; the detail never holds the value. tests: the
//                                      table of tests by kind, for the tests of this file only
//   KEY_CARD                           the words of the dashboard's key card, one card for every
//                                      key (frozen, plain strings); the page fills in {file},
//                                      which only setIn, notIgnored and removeAsk carry

import { randomBytes } from 'node:crypto';

export const KEY_STEPS = Object.freeze({
  RESEND_API_KEY: 'notifications',
  RESEND_FROM_EMAIL: 'notifications',
  FOREMAN_NOTIFY_EMAIL: 'notifications',
  JIRA_CLIENT_ID: 'jira-app',
  JIRA_CLIENT_SECRET: 'jira-app',
  GEARSET_API_TOKEN: 'sf-gearset',
  ANTHROPIC_API_KEY: 'claude-signin',
  CLAUDE_CODE_OAUTH_TOKEN: 'claude-signin',
});

export const stepForKey = (name) => (Object.hasOwn(KEY_STEPS, name) ? KEY_STEPS[name] : 'project-keys');

// ── the key card's words ──────────────────────────────────────────────────────────────────

export const KEY_CARD = Object.freeze({
  notSet: 'Not set yet',
  setIn: 'Saved in {file}',
  outside: 'Set outside Foreman, in the environment, so it can be changed only there',
  localOnly: 'Keys can be changed only on a dashboard that runs on this computer.',
  notIgnored: 'git does not ignore {file}, so this key could be committed.',
  save: 'Save the key',
  saving: 'Saving the key…',
  replace: 'Replace the key',
  cancel: 'Keep the old key',
  remove: 'Remove the key',
  removeAsk: 'Remove this key from {file}? Foreman stops using it at once.',
  removeYes: 'Yes, remove it',
  generate: 'Make one for me',
  ignore: 'Add to .gitignore',
  works: 'It works',
  notWorking: 'It does not work',
  testing: 'Testing the key…',
});

// ── shapes ────────────────────────────────────────────────────────────────────────────────

// Every shape first refuses an empty value and whitespace inside one.
const shaped = (check) => (value) => {
  if (typeof value !== 'string' || value === '') return 'This is empty.';
  if (value.length > 4096) return 'This is too long: 4096 characters at most.';
  if (/\s/.test(value)) return 'This has spaces in it; paste the value only.';
  return check(value);
};

const oneWord = shaped(() => null);
const email = shaped((v) => (v.length > 320 ? 'This is too long for an email address: 320 characters at most.' : /^[^@]+@[^@.]+(\.[^@.]+)+$/.test(v) ? null : 'This is not an email address.'));
const jira = (what) => shaped((v) => (/^[A-Za-z0-9_-]{20,}$/.test(v) ? null : `This does not look like a Jira app ${what}: copy it from the app's Settings page.`));

const apiKey = shaped((v) => {
  if (v.startsWith('sk-ant-oat')) return 'This looks like a subscription token (sk-ant-oat…); put it under Subscription.';
  if (!v.startsWith('sk-ant-')) return 'This does not look like a Console API key: it starts with sk-ant-api.';
  return null;
});

const subscription = shaped((v) => {
  if (v.startsWith('sk-ant-api')) return 'This looks like a Console API key (sk-ant-api…); put it under Console API key.';
  if (!v.startsWith('sk-ant-oat')) return 'This does not look like a subscription token: run `claude setup-token` and paste what it prints.';
  return null;
});

const GITHUB_PREFIXES = ['ghp_', 'gho_', 'ghu_', 'ghs_', 'github_pat_'];

const entry = (name, label, shape, test, more = {}) => Object.freeze({ name, label, secret: true, shape, test, testLabel: 'Test it', ...more });

export const KEYS = Object.freeze([
  entry('ANTHROPIC_API_KEY', 'Claude Console API key', apiKey, 'anthropic'),
  entry('CLAUDE_CODE_OAUTH_TOKEN', 'Claude subscription token', subscription, 'subscription', { testLabel: 'Test it (uses a few tokens)' }),
  entry('RESEND_API_KEY', 'Resend API key', shaped((v) => (v.startsWith('re_') ? null : 'This does not look like a Resend API key: it starts with re_.')), 'resend'),
  entry('RESEND_FROM_EMAIL', 'Sender email address', email, 'format', { secret: false }),
  entry('FOREMAN_NOTIFY_EMAIL', 'Email address for notifications', email, 'format', { secret: false }),
  entry('FACTORY_NOTIFY_EMAIL', 'Email address for notifications (old name)', email, 'format', { secret: false }),
  entry('JIRA_CLIENT_ID', 'Jira app client ID', jira('client ID'), 'format'),
  entry('JIRA_CLIENT_SECRET', 'Jira app secret', jira('secret'), 'format'),
  entry('FOREMAN_DASHBOARD_TOKEN', 'Dashboard access token', shaped((v) => (v.length >= 32 ? null : 'This is not long enough for a dashboard token: it needs 32 characters or more.')), 'format', {
    generate: () => randomBytes(32).toString('base64url'),
  }),
  entry('GEARSET_API_TOKEN', 'Gearset API token', oneWord, 'gearset'),
  entry('GH_TOKEN', 'GitHub token', shaped((v) => (GITHUB_PREFIXES.some((p) => v.startsWith(p)) ? null : 'This does not look like a GitHub token: it starts with ghp_ or github_pat_.')), 'github'),
]);

const BY_NAME = new Map(KEYS.map((k) => [k.name, k]));

export const keyInfo = (name) => BY_NAME.get(name) ?? { name, label: name, secret: true, shape: oneWord, test: null };

export const checkShape = (name, value) => keyInfo(name).shape(value);

export function generateKey(name) {
  const info = keyInfo(name);
  if (typeof info.generate !== 'function') throw new Error(`Foreman does not make ${name}; it comes from its service`);
  return info.generate();
}

// ── tests ─────────────────────────────────────────────────────────────────────────────────

const yes = (detail) => ({ ok: true, detail });
const no = (detail) => ({ ok: false, detail });

// One GET to a service: the response, or the failure to show.
async function ask(service, url, headers, { fetch, timeoutMs }) {
  try {
    return { res: await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) }) };
  } catch (err) {
    const late = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { failed: no(late ? `${service} did not answer in time` : `could not reach ${service}`) };
  }
}

const bodyOf = async (res) => {
  try {
    return await res.json();
  } catch {
    return null;
  }
};

const TESTS = {
  async anthropic(value, opts) {
    const { res, failed } = await ask('Anthropic', `${opts.base.anthropic ?? 'https://api.anthropic.com'}/v1/models`, { 'x-api-key': value, 'anthropic-version': '2023-06-01' }, opts);
    if (failed) return failed;
    if (res.status === 200) return yes('Anthropic accepted the key');
    if (res.status === 401 || res.status === 403) return no('Anthropic did not accept the key');
    return no(`Anthropic answered ${res.status}`);
  },

  // A send-only key cannot list domains: Resend says 401 restricted_api_key, and it can send.
  async resend(value, opts) {
    const { res, failed } = await ask('Resend', `${opts.base.resend ?? 'https://api.resend.com'}/domains`, { Authorization: `Bearer ${value}` }, opts);
    if (failed) return failed;
    if (res.status === 200) return yes('Resend accepted the key');
    if (res.status === 401 && (await bodyOf(res))?.name === 'restricted_api_key') return yes('a send-only key: it can send email');
    if (res.status >= 400 && res.status < 500) return no('Resend did not accept the key');
    return no(`Resend answered ${res.status}`);
  },

  // The headers packs/salesforce/gearset.mjs sends.
  async gearset(value, opts) {
    const headers = { Authorization: `token ${value}`, 'api-version': '3.0', Accept: 'application/json' };
    const { res, failed } = await ask('Gearset', `${opts.base.gearset ?? 'https://api.gearset.com'}/public/reporting/pipelines`, headers, opts);
    if (failed) return failed;
    if (res.status === 200) return yes('Gearset accepted the token');
    if (res.status === 401) return no('Gearset did not accept the token');
    if (res.status === 403) return no("the Gearset Reporting API is not on for this token's team (Teams or Enterprise tier)");
    return no(`Gearset answered ${res.status}`);
  },

  // The cloud doctor's own check, signed in with this token only.
  async subscription(value, opts) {
    const childEnv = Object.fromEntries(Object.entries(opts.env).filter(([n]) => !['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'].includes(n) && !n.startsWith('CLAUDE_CODE_USE_')));
    childEnv.CLAUDE_CODE_OAUTH_TOKEN = value;
    return runnerCheck('claude answers', childEnv, opts, 'Claude answered');
  },

  async github(value, opts) {
    return runnerCheck('github token', { ...opts.env, GH_TOKEN: value }, opts, 'GitHub accepted the token');
  },
};

async function runnerCheck(name, childEnv, { sh }, okDetail) {
  const { runnerChecks } = await import('../cloud/doctor.mjs');
  const wrapped = (cmd, args, o = {}) => sh(cmd, args, { ...o, env: childEnv });
  const r = await runnerChecks().find((c) => c.name === name).run({ env: childEnv, sh: wrapped });
  return r.ok ? yes(r.detail || okDetail) : no(r.detail);
}

export async function testKey(name, value, { fetch = globalThis.fetch, sh, env = {}, base = {}, timeoutMs = 10_000, tests = TESTS } = {}) {
  const { redact } = await import('../secrets/redact.mjs');
  const kind = keyInfo(name).test;
  let r;
  if (kind === 'format') {
    const wrong = checkShape(name, value);
    r = wrong === null ? yes('looks right') : no(wrong);
  } else if (Object.hasOwn(tests, kind ?? '')) {
    r = await tests[kind](value, { fetch, sh, env, base, timeoutMs });
  } else {
    r = no(`Foreman has no test for ${name}`);
  }
  return { ok: r.ok, detail: redact(r.detail, { values: [value] }) };
}
