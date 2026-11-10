// The Salesforce set-up mechanics behind the dashboard's /api/setup/salesforce/ routes: the key
// pair Foreman signs in with (JWT bearer), and signing an org in to the isolated sf home. Every
// word the owner sees is in lib/setup/salesforce.mjs; this module answers with codes only.
//
//   projectId(root, config)            the slug of project.name, '-', then 8 hex characters of
//                                      sha256 of the project's real path: stable for one root
//   keyPaths({ root, config, homedir }) { dir, key, cert }: ~/.config/foreman/sf/<project id>/
//                                      server.key and server.crt. Never inside the repo, an env
//                                      file or a worktree. Story sessions are denied the Read
//                                      tool on ~/.config/foreman/sf (isolation.mjs setUp), and the
//                                      Salesforce guard denies a Bash command that names the
//                                      folder. A command that reaches it without naming it is an
//                                      accepted limit (guard.mjs).
//   checkPair(keyPem, certPem, { now }) { ok: true, cert } or { ok: false, code }, code one of
//                                      passphrase, bad-key, not-rsa, bad-cert, mismatch, expired
//   readCertificate(paths)             the public certificate { pem, fingerprint256, validTo,
//                                      subject, keyFile }, or null unless both files are there.
//                                      It never reads the key.
//   saveKeyPair(paths, keyPem, certPem, { replace, now })
//   generateKeyPair(paths, { sh, replace, now })
//                                      { ok: true } or { ok: false, code }: a checkPair code,
//                                      exists (a key is saved and replace is not true),
//                                      openssl-failed or write-failed. The folder ends 0700, its
//                                      parent ~/.config/foreman/sf too, and both files 0600; each
//                                      is written under a temp name in the folder, then renamed.
//                                      openssl's output is never returned.
//   connectOrg({ config, env, homedir, sh, alias, username, clientId, instanceUrl, keyFile, now })
//                                      `sf org login jwt` into the isolated sf home, then the
//                                      Organization query. Answers one of
//                                        { status: 'connected', orgId }
//                                        { status: 'refused', code: 'production' | 'not-checked', loggedOut }
//                                        { status: 'org-id-differs', orgId, configured }
//                                        { status: 'failed', code, errorName?, until? }
//                                      An org that is not a sandbox, or that the query cannot
//                                      check, is signed out at once, except a production org that
//                                      salesforce.orgs marks "production": true with the same org
//                                      ID: that one stays connected (deployments to it are never
//                                      possible). A sandbox whose ID differs from salesforce.orgs
//                                      stays signed in: the isolation check keeps runs refused
//                                      until the ID is fixed.
//   classifyLoginError(r)              a failed sign-in's code, from runSf's result
//   isUsername, isClientId, canonicalUrl  the connect inputs' checks
//
// No answer carries the key, the username, the client ID or sf's own message: a failed sign-in
// is a code, plus sf's error name when the code is 'sign-in'.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { layout } from './config.mjs';
import { homeProblem, isolatedSh, keyRoot, orgQuery, sfHome } from './isolation.mjs';
import { coolingDown, isUnreachable, recordCooldown, runSf } from './sf.mjs';

export const DEFAULT_INSTANCE_URL = 'https://test.salesforce.com';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const id15 = (v) => (typeof v === 'string' ? v.slice(0, 15) : '');
const msOf = (now) => (now instanceof Date ? now.getTime() : now === undefined ? Date.now() : Number(now));

function slug(name) {
  const s = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return s || 'project';
}

export function projectId(root, config) {
  let real;
  try {
    real = fs.realpathSync(root);
  } catch {
    real = path.resolve(root);
  }
  const hash = crypto.createHash('sha256').update(real).digest('hex').slice(0, 8);
  return `${slug(config?.project?.name)}-${hash}`;
}

export function keyPaths({ root, config, homedir }) {
  const dir = path.join(keyRoot(homedir), projectId(root, config));
  return { dir, key: path.join(dir, 'server.key'), cert: path.join(dir, 'server.crt') };
}

const ENCRYPTED = /-----BEGIN ENCRYPTED PRIVATE KEY-----|Proc-Type:\s*4,ENCRYPTED/;
// Node names a PEM key that needs a passphrase in either way, by version.
const PASSPHRASE_CODES = new Set(['ERR_MISSING_PASSPHRASE', 'ERR_OSSL_CRYPTO_INTERRUPTED_OR_CANCELLED']);
const spki = (publicKey) => publicKey.export({ type: 'spki', format: 'der' });

export function checkPair(keyPem, certPem, { now } = {}) {
  let key;
  try {
    key = crypto.createPrivateKey(keyPem);
  } catch (err) {
    const locked = PASSPHRASE_CODES.has(err?.code) || (typeof keyPem === 'string' && ENCRYPTED.test(keyPem));
    return { ok: false, code: locked ? 'passphrase' : 'bad-key' };
  }
  // JWT bearer signs with RS256.
  if (key.asymmetricKeyType !== 'rsa') return { ok: false, code: 'not-rsa' };
  let cert;
  try {
    cert = new crypto.X509Certificate(certPem);
  } catch {
    return { ok: false, code: 'bad-cert' };
  }
  let matches = false;
  try {
    matches = spki(cert.publicKey).equals(spki(crypto.createPublicKey(key))) && cert.checkPrivateKey(key);
  } catch {
    matches = false;
  }
  if (!matches) return { ok: false, code: 'mismatch' };
  if (Date.parse(cert.validTo) < msOf(now)) return { ok: false, code: 'expired' };
  return { ok: true, cert };
}

export function readCertificate(paths) {
  if (!fs.existsSync(paths.key) || !fs.existsSync(paths.cert)) return null;
  let cert;
  try {
    cert = new crypto.X509Certificate(fs.readFileSync(paths.cert));
  } catch {
    return null;
  }
  return { pem: cert.toString(), fingerprint256: cert.fingerprint256, validTo: new Date(Date.parse(cert.validTo)).toISOString(), subject: cert.subject, keyFile: paths.key };
}

// The folder 0700, and ~/.config/foreman/sf above it, even when they were there already.
function privateDir(paths) {
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(paths.dir), 0o700);
  fs.chmodSync(paths.dir, 0o700);
}

const tempName = (paths, base) => path.join(paths.dir, `.${base}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);

function removeAll(files) {
  for (const f of files) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      // already gone, or the folder went with it
    }
  }
}

export function saveKeyPair(paths, keyPem, certPem, { replace = false, now } = {}) {
  const checked = checkPair(keyPem, certPem, { now });
  if (!checked.ok) return checked;
  if (!replace && fs.existsSync(paths.key)) return { ok: false, code: 'exists' };
  const temps = [];
  try {
    privateDir(paths);
    // Only the certificate as X509Certificate reads it: an upload that pasted the key into the
    // certificate field too never has that key saved where the certificate is served from.
    const files = [
      [paths.key, String(keyPem)],
      [paths.cert, checked.cert.toString()],
    ];
    const staged = files.map(([file, text]) => {
      const tmp = tempName(paths, path.basename(file));
      temps.push(tmp);
      fs.writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
      fs.chmodSync(tmp, 0o600);
      return [tmp, file];
    });
    for (const [tmp, file] of staged) fs.renameSync(tmp, file);
    return { ok: true };
  } catch {
    removeAll(temps);
    return { ok: false, code: 'write-failed' };
  }
}

export function generateKeyPair(paths, { sh, replace = false, now } = {}) {
  if (!replace && fs.existsSync(paths.key)) return { ok: false, code: 'exists' };
  const id = path.basename(paths.dir);
  const tmpKey = tempName(paths, 'server.key');
  const tmpCrt = tempName(paths, 'server.crt');
  try {
    privateDir(paths);
  } catch {
    return { ok: false, code: 'write-failed' };
  }
  try {
    let r;
    try {
      r = sh('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '730', '-subj', `/CN=Foreman ${id}`, '-keyout', tmpKey, '-out', tmpCrt]);
    } catch {
      r = { status: 1 };
    }
    if (r?.status !== 0) return { ok: false, code: 'openssl-failed' };
    let keyPem;
    let certPem;
    try {
      fs.chmodSync(tmpKey, 0o600);
      keyPem = fs.readFileSync(tmpKey, 'utf8');
      certPem = fs.readFileSync(tmpCrt, 'utf8');
    } catch {
      return { ok: false, code: 'openssl-failed' };
    }
    const checked = checkPair(keyPem, certPem, { now });
    if (!checked.ok) return checked;
    try {
      fs.chmodSync(tmpCrt, 0o600);
      fs.renameSync(tmpKey, paths.key);
      fs.renameSync(tmpCrt, paths.cert);
    } catch {
      return { ok: false, code: 'write-failed' };
    }
    return { ok: true };
  } finally {
    removeAll([tmpKey, tmpCrt]);
  }
}

const NOT_APPROVED = /user hasn't approved this consumer|not admin approved/i;
const CLIENT_ID = /invalid_client_id|client identifier invalid/i;
const AUDIENCE = /audience/i;
const ASSERTION = /invalid assertion|signature/i;

export function classifyLoginError(r) {
  if (['timeout', 'login-rate', 'cooldown'].includes(r?.code)) return r.code;
  const error = isObject(r?.error) ? r.error : {};
  if (error.name === 'SfNotFound') return 'no-sf';
  const text = String(error.sfMessage ?? error.message ?? '');
  if (NOT_APPROVED.test(text)) return 'not-approved';
  if (CLIENT_ID.test(text)) return 'client-id';
  if (AUDIENCE.test(text)) return 'audience';
  if (ASSERTION.test(text)) return 'assertion';
  if (isUnreachable({ message: text })) return 'unreachable';
  return 'sign-in';
}

// sf's error name when it is a plain name; anything else could carry what sf printed.
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const errorName = (error) => (typeof error?.name === 'string' && ERROR_NAME.test(error.name) ? error.name : 'SfError');

export function connectOrg({ config, env, homedir, sh, alias, username, clientId, instanceUrl = DEFAULT_INSTANCE_URL, keyFile, now }) {
  const home = sfHome(env, homedir);
  if (homeProblem(env, home)) return { status: 'failed', code: 'home' };
  const at = msOf(now);
  const cool = coolingDown(home, alias, at);
  if (cool) return { status: 'failed', code: 'cooldown', until: cool.until };
  try {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    // the login writes its key here, and mkdir's mode does not reach a home that already exists
    fs.chmodSync(home, 0o700);
  } catch {
    return { status: 'failed', code: 'home' };
  }
  const iso = isolatedSh(sh, env, home, homedir);

  const login = runSf(iso, ['org', 'login', 'jwt', '--alias', alias, '--username', username, '--jwt-key-file', keyFile, '--client-id', clientId, '--instance-url', instanceUrl], { now: at });
  if (!login.ok) {
    const code = classifyLoginError(login);
    // The login names no --target-org, so runSf keeps no cool-down for it: keep one here, so the
    // next try cannot push the org into locking its user out.
    if (code === 'login-rate') recordCooldown(home, alias, { reason: 'login rate exceeded', now: at });
    return code === 'sign-in' ? { status: 'failed', code, errorName: errorName(login.error) } : { status: 'failed', code };
  }

  const q = orgQuery(iso, alias);
  const records = q.ok && isObject(q.result) && Array.isArray(q.result.records) ? q.result.records : [];
  const record = isObject(records[0]) ? records[0] : null;
  const listed = layout(config?.salesforce, config).orgs[alias];
  const configured = listed?.orgId ?? null;
  if (record?.IsSandbox === false && listed?.production === true && configured && id15(record.Id) === id15(configured)) {
    return { status: 'connected', orgId: record.Id };
  }
  if (!record || record.IsSandbox !== true) {
    const out = runSf(iso, ['org', 'logout', '--target-org', alias, '--no-prompt'], { now: at });
    return { status: 'refused', code: record ? 'production' : 'not-checked', loggedOut: out.ok === true };
  }

  if (id15(record.Id) !== id15(configured)) return { status: 'org-id-differs', orgId: record.Id, configured };
  return { status: 'connected', orgId: record.Id };
}

export const isUsername = (v) => typeof v === 'string' && v.length > 0 && v.length <= 200 && v.includes('@') && !/\s/.test(v) && !v.startsWith('-');

export const isClientId = (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._]{9,255}$/.test(v);

// 'https://<host>' for a Salesforce login URL with nothing but the host, else null.
export function canonicalUrl(v) {
  if (typeof v !== 'string' || !v) return null;
  let u;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.port) return null;
  if (u.pathname !== '/' && u.pathname !== '') return null;
  // A bare '?' or '#' leaves search and hash empty; the text still had one.
  if (/[?#]/.test(v)) return null;
  const host = u.hostname.toLowerCase();
  if (!/\.(salesforce|force)\.com$/.test(host)) return null;
  return `https://${host}`;
}
