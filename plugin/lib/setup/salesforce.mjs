// The Salesforce set-up steps behind the dashboard's /api/setup/salesforce/ routes: the key and
// certificate Foreman signs in with, signing each org in salesforce.orgs in to Foreman's own sf
// home, and saving an org ID that differs from the config. The mechanics are in
// packs/salesforce/setup.mjs; every word the owner sees is here, in WORDS and ERRORS.
//
//   const sf = salesforceSetup({ root, env, now, sh, homedir });
//   sf.key()             { status: 'none' } or { status: 'ready', certificate, fingerprint,
//                        expires, subject, keyFile }: the public certificate only
//   sf.saveKey(body)     { generate: true } makes a key with openssl; { key, certificate } saves
//                        an uploaded PEM pair; replace: true puts either in place of a saved key.
//                        Answers as key().
//   sf.connect(body)     { alias, username, clientId, instanceUrl? }: signs the org in
//                        (instanceUrl https://test.salesforce.com by default). Always answers
//                        { ok, status, alias, orgId?, configured?, update?, code?, error?, guide?,
//                        field? }: status connected, refused, org-id-differs or failed; guide is
//                        the sf-orgs guide entry (or the step) that fixes it, field the input to
//                        look at. An org whose ID differs is remembered here, in memory, until
//                        applyOrgId saves it or the org connects as configured. `begin()`, when
//                        given, is called once the inputs pass and before sf runs, and its
//                        result's done() after: the dashboard's rate limit, which may throw.
//   sf.applyOrgId(body)  { alias }: writes the remembered org ID into salesforce.orgs.<alias>
//                        in foreman.config.json; answers { ok, alias, orgId, lines }
//   sf.current()         { orgs: [{ alias, orgId, roles }], scratch, key }: what the Set up
//                        screen starts from. The orgs are those in salesforce.orgs, in the
//                        doctor's order (the build orgs, each stage's, then the rest), never the
//                        scratch dev hub, each with its roles ('build', 'stage <name>'; none when
//                        no step uses it). key is as key() without the key file's path. Runs no
//                        sf and no openssl.
//
// The project is read afresh on each call. A failure is an Error with .status, the HTTP code to
// answer with. No answer and no error carries the private key, the username, the client ID or
// sf's own message, and a refused input is never repeated.

import { layout } from '../../packs/salesforce/config.mjs';
import {
  DEFAULT_INSTANCE_URL,
  canonicalUrl,
  connectOrg,
  generateKeyPair,
  isClientId,
  isUsername,
  keyPaths,
  readCertificate,
  saveKeyPair,
} from '../../packs/salesforce/setup.mjs';
import { sfHome } from '../../packs/salesforce/isolation.mjs';
import { planOf } from '../../packs/salesforce/doctor-salesforce.mjs';
import { loadResolved } from '../settings/load.mjs';
import { readTeam, teamSet } from '../settings/team.mjs';
import { SETUP_FIRST } from './steps.mjs';

// HOME is always quoted, so the line runs as printed whatever the home's path holds (the same
// rule as isolation.mjs's quote). The alias needs none: config.mjs's ALIAS checks it.
const shellQuote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
const logoutLine = (home, alias) => `HOME=${shellQuote(home)} sf org logout --target-org ${alias} --no-prompt`;

export const WORDS = Object.freeze({
  setupFirst: SETUP_FIRST,
  notSalesforce: 'This project does not use the Salesforce pack.',
  localOnly:
    'Salesforce keys and sign-ins work only on a dashboard that listens on this computer alone (127.0.0.1). To use it from another machine, open it through an SSH tunnel.',
  keyBody: 'Send generate: true to make a key, or the key and certificate as PEM text to upload them. replace, when sent, must be true or false.',
  keyFirst: 'Make or upload the key first.',
  pickOrg: 'Pick an org from salesforce.orgs.',
  badUsername: "That is not a Salesforce username: it looks like an email address, with no spaces.",
  badClientId: "That is not a consumer key: copy it whole from the app's OAuth settings, with no spaces.",
  badInstanceUrl: 'Give the login URL as https:// and a salesforce.com or force.com host only, such as https://test.salesforce.com.',
  connectFirst: 'Connect the org first: Foreman saves an org ID only after it found a different one when it signed in.',
  notInFile: 'foreman.config.json has no such org in salesforce.orgs, so there is nothing to update. Add it there first.',
  notSaved: (reasons) => `foreman.config.json was left as it is: ${reasons.join('; ')}`,
  codes: Object.freeze({
    passphrase: 'That key has a passphrase. Foreman needs one without: take it off with `openssl rsa -in <key file> -out <new file>`, then upload the new file.',
    'bad-key': "Foreman cannot read that key. Paste the key file's PEM text whole, from its first line to its last.",
    'not-rsa': 'That key is not an RSA key. Salesforce signs in with RSA keys: make a key here, or upload an RSA one.',
    'bad-cert': "Foreman cannot read that certificate. Paste the certificate's PEM text whole, from -----BEGIN CERTIFICATE----- to its last line.",
    mismatch: 'That certificate was not made from that key. Upload the certificate that goes with the key.',
    expired: 'That certificate has expired. Make a new key here, or upload a pair whose certificate is still valid.',
    exists: 'A key is saved for this project already. Send replace: true to put the new one in its place; then upload the new certificate to the app.',
    'openssl-failed': "openssl could not make the key. Check that openssl is installed (the doctor's tools check says), then try again.",
    'write-failed': 'Foreman could not save the key in ~/.config/foreman/sf. Check that folder can be written, then try again.',
  }),
});

// What each connect code means for the owner: the words, the guide entry of sf-orgs (or the
// step) that fixes it, and the input to look at. A function gets { alias, home, until, errorName,
// loggedOut }.
export const ERRORS = Object.freeze({
  'not-approved': {
    words: 'Salesforce says the user is not approved for the app. In the app\'s Policies, set Permitted Users to "Admin approved users are pre-authorized" and add the user\'s profile or permission set.',
    guide: 'policies',
  },
  'client-id': {
    words: 'Salesforce does not know that consumer key. Copy the whole key from the app again; a new app can also take a few minutes before it works, so wait a few minutes and try again.',
    guide: 'consumer-key',
    field: 'clientId',
  },
  audience: {
    words: 'Salesforce refused the login URL for this org. Use https://test.salesforce.com for a sandbox, or the sandbox\'s own My Domain address.',
    guide: 'connect',
    field: 'instanceUrl',
  },
  assertion: {
    words: "Salesforce could not check the sign-in against the app's certificate. Upload the certificate Foreman shows here to the app, then try again.",
    guide: 'oauth',
  },
  production: {
    words: ({ alias, home, loggedOut }) =>
      loggedOut
        ? `Foreman never connects to production unless salesforce.orgs marks the org "production": true with its org ID, and it never deploys there. It signed ${alias} out again.`
        : `Foreman never connects to production unless salesforce.orgs marks the org "production": true with its org ID, and it never deploys there. It could not sign ${alias} out again: run \`${logoutLine(home, alias)}\`.`,
    guide: 'connect',
  },
  'not-checked': {
    words: ({ alias, home, loggedOut }) =>
      loggedOut
        ? `Foreman could not check that ${alias} is a sandbox, so it signed it out again. Check that the user can use the API, then try again.`
        : `Foreman could not check that ${alias} is a sandbox, and could not sign it out again: run \`${logoutLine(home, alias)}\`. Check that the user can use the API, then try again.`,
  },
  'login-rate': {
    words: ({ alias }) => `Salesforce is limiting sign-ins for this user, so Foreman will not try ${alias} again for an hour. Retrying sooner can lock the user out.`,
  },
  cooldown: {
    words: ({ alias, until }) => `Salesforce limited sign-ins to ${alias} a short while ago, so Foreman waits${until ? ` until ${until}` : ''} before it tries again.`,
  },
  timeout: { words: 'sf took too long to answer. Try again in a moment.' },
  unreachable: { words: 'Salesforce could not be reached from this computer. Check the login URL and the network, then try again.', field: 'instanceUrl' },
  'no-sf': { words: 'The Salesforce CLI (sf) is not on PATH, so Foreman cannot sign in. Install it, then try again.', guide: 'sf-tools' },
  home: { words: 'FOREMAN_SF_HOME must be an absolute path, and a folder Foreman can create: `~` is not expanded there.', guide: 'sf-home' },
  'sign-in': { words: ({ errorName }) => `sf could not sign in (${errorName ?? 'SfError'}). Check the username, the consumer key and the app, then try again.` },
});

const fail = (status, message) => Object.assign(new Error(message), { status });
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function salesforceSetup({ root, env = process.env, now = () => new Date(), sh, homedir }) {
  const pending = new Map(); // alias -> the org ID a connect found, different from the config

  function project() {
    const { config } = loadResolved(root, { env });
    if (!config) throw fail(409, WORDS.setupFirst);
    if (config.pack !== 'salesforce') throw fail(400, WORDS.notSalesforce);
    return { config, paths: keyPaths({ root, config, homedir }) };
  }

  function keyBody(paths) {
    const c = readCertificate(paths);
    if (!c) return { status: 'none' };
    return { status: 'ready', certificate: c.pem, fingerprint: c.fingerprint256, expires: c.validTo, subject: c.subject, keyFile: c.keyFile };
  }

  function key() {
    return keyBody(project().paths);
  }

  function current() {
    const { config, paths } = project();
    const plan = planOf(config.salesforce, config);
    const { keyFile, ...shown } = keyBody(paths);
    return {
      orgs: plan.orgs.filter((o) => o.inOrgs).map((o) => ({ alias: o.alias, orgId: o.orgId, roles: [...o.roles] })),
      scratch: plan.scratch,
      key: shown,
    };
  }

  function saveKey(body) {
    const { paths } = project();
    const b = isPlain(body) ? body : {};
    const generate = Object.hasOwn(b, 'generate');
    const upload = Object.hasOwn(b, 'key') || Object.hasOwn(b, 'certificate');
    const goodGenerate = generate && !upload && b.generate === true;
    const goodUpload = upload && !generate && typeof b.key === 'string' && b.key !== '' && typeof b.certificate === 'string' && b.certificate !== '';
    const goodReplace = !Object.hasOwn(b, 'replace') || typeof b.replace === 'boolean';
    if (!(goodGenerate || goodUpload) || !goodReplace) throw fail(400, WORDS.keyBody);
    const opts = { replace: b.replace === true, now: now() };
    const r = goodGenerate ? generateKeyPair(paths, { sh, ...opts }) : saveKeyPair(paths, b.key, b.certificate, opts);
    if (!r.ok) throw fail(r.code === 'exists' ? 409 : r.code === 'write-failed' ? 500 : 400, WORDS.codes[r.code] ?? WORDS.codes['bad-key']);
    return keyBody(paths);
  }

  function connect(body, { begin } = {}) {
    const { config, paths } = project();
    const b = isPlain(body) ? body : {};
    const { alias } = b;
    if (typeof alias !== 'string' || !Object.hasOwn(layout(config.salesforce, config).orgs, alias)) throw fail(400, WORDS.pickOrg);
    if (!isUsername(b.username)) throw fail(400, WORDS.badUsername);
    if (!isClientId(b.clientId)) throw fail(400, WORDS.badClientId);
    const instanceUrl = b.instanceUrl === undefined ? DEFAULT_INSTANCE_URL : canonicalUrl(b.instanceUrl);
    if (!instanceUrl) throw fail(400, WORDS.badInstanceUrl);
    const cert = readCertificate(paths);
    if (!cert) throw fail(409, WORDS.keyFirst);

    const attempt = begin?.();
    let r;
    try {
      r = connectOrg({ config, env, homedir, sh, alias, username: b.username, clientId: b.clientId, instanceUrl, keyFile: cert.keyFile, now: now() });
    } finally {
      attempt?.done();
    }
    if (r.status === 'connected') {
      pending.delete(alias);
      return { ok: true, status: 'connected', alias, orgId: r.orgId };
    }
    if (r.status === 'org-id-differs') {
      pending.set(alias, r.orgId);
      return {
        ok: false,
        status: 'org-id-differs',
        alias,
        orgId: r.orgId,
        configured: r.configured,
        update: { alias, orgId: r.orgId },
        error: `${alias} is org ${r.orgId}, but salesforce.orgs says ${r.configured ?? 'no org ID'}. Save the new org ID if this is the right sandbox.`,
      };
    }
    const entry = ERRORS[r.code] ?? ERRORS['sign-in'];
    const words = typeof entry.words === 'function' ? entry.words({ alias, home: sfHome(env, homedir), until: r.until, errorName: r.errorName, loggedOut: r.loggedOut }) : entry.words;
    return {
      ok: false,
      status: r.status,
      alias,
      code: r.code,
      error: words,
      ...(entry.guide ? { guide: entry.guide } : {}),
      ...(entry.field ? { field: entry.field } : {}),
    };
  }

  function applyOrgId(body) {
    project();
    const alias = isPlain(body) ? body.alias : undefined;
    if (typeof alias !== 'string' || !pending.has(alias)) throw fail(409, WORDS.connectFirst);
    const orgId = pending.get(alias);
    const { raw, errors } = readTeam(root);
    if (errors) throw fail(400, WORDS.notSaved(errors));
    const orgs = isPlain(raw.salesforce) && isPlain(raw.salesforce.orgs) ? raw.salesforce.orgs : null;
    if (!orgs || !Object.hasOwn(orgs, alias) || !isPlain(orgs[alias])) throw fail(409, WORDS.notInFile);
    // The whole object: an alias may hold dots, which a dotted path would split.
    let result;
    try {
      result = teamSet(root, 'salesforce.orgs', { ...orgs, [alias]: { ...orgs[alias], orgId } });
    } catch (err) {
      result = { errors: [err?.message ?? String(err)] };
    }
    if (result.errors.length) throw fail(400, WORDS.notSaved(result.errors));
    pending.delete(alias);
    return { ok: true, alias, orgId, lines: [`set salesforce.orgs.${alias}.orgId to ${orgId} in foreman.config.json`] };
  }

  return { key, saveKey, connect, applyOrgId, current };
}
