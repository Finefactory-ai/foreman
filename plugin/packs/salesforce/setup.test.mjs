// The Salesforce set-up mechanics: the JWT key pair Foreman keeps for the project, and signing
// an org in to the isolated sf home. Never the real sf, openssl, ~/.config or sf home.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  canonicalUrl,
  checkPair,
  classifyLoginError,
  connectOrg,
  generateKeyPair,
  isClientId,
  isUsername,
  keyPaths,
  projectId,
  readCertificate,
  saveKeyPair,
} from './setup.mjs';
import { keyRoot } from './isolation.mjs';
import { recordCooldown, runSf } from './sf.mjs';
import { ACME_DEV1_ID, ACME_PROD_ID, ACME_QA_ID, fakeSfShell, orgRecord, orgRoute, sfError, sfOk } from '../../../test/fake-sf.mjs';
import { fakeOpenssl, makePair } from '../../../test/fake-openssl.mjs';

const NOW = new Date('2026-10-24T09:00:00.000Z');
const USER = 'admin@acme-dev1.acme.example';
const CLIENT_ID = '3MVG9AcmeConsumerKey0123456789';
const LOGIN = 'org login jwt';
const LOGOUT = 'org logout';

let tmp;
let root;
let homedir;
let sfHomeDir;
let pair;

const config = () => ({
  version: 1,
  project: { name: 'Acme Shop' },
  pack: 'salesforce',
  salesforce: {
    productionBranch: 'main',
    orgs: { 'acme-dev1': { orgId: ACME_DEV1_ID }, 'acme-qa': { orgId: ACME_QA_ID } },
    build: ['acme-dev1'],
    stages: [{ name: 'qa', org: 'acme-qa', branch: 'qa' }],
  },
});
const paths = () => keyPaths({ root, config: config(), homedir });
const mode = (file) => fs.statSync(file).mode & 0o777;
const env = () => ({ FOREMAN_SF_HOME: sfHomeDir, PATH: '/usr/bin:/bin' });

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-sfsetup-'));
  root = path.join(tmp, 'acme-shop');
  homedir = path.join(tmp, 'home');
  sfHomeDir = path.join(tmp, 'sf-home');
  fs.mkdirSync(root);
  fs.mkdirSync(homedir);
  pair ??= makePair({ cn: 'Foreman acme' });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('projectId and keyPaths', () => {
  it('is stable for one root, differs between roots, and is safe in a path', () => {
    const other = path.join(tmp, 'acme-other');
    fs.mkdirSync(other);
    const id = projectId(root, config());
    expect(projectId(root, config())).toBe(id);
    expect(projectId(other, config())).not.toBe(id);
    expect(id).toMatch(/^acme-shop-[0-9a-f]{8}$/);
    expect(projectId(root, { project: { name: '../../Ünïcode  Shop!! ' } })).toMatch(/^n-code-shop-[0-9a-f]{8}$/);
    expect(projectId(root, { project: { name: '' } })).toMatch(/^project-[0-9a-f]{8}$/);
    expect(projectId(root, {})).toMatch(/^project-[0-9a-f]{8}$/);
    const long = projectId(root, { project: { name: 'a'.repeat(100) } });
    expect(long.length).toBe(40 + 1 + 8);
    for (const name of ['-acme-', 'acme..', '/etc/passwd']) expect(projectId(root, { project: { name } })).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?-[0-9a-f]{8}$/);
  });

  it('puts the key and certificate under ~/.config/foreman/sf/<project id>', () => {
    const p = paths();
    expect(p.dir).toBe(path.join(homedir, '.config', 'foreman', 'sf', projectId(root, config())));
    expect(p.key).toBe(path.join(p.dir, 'server.key'));
    expect(p.cert).toBe(path.join(p.dir, 'server.crt'));
    expect(path.dirname(p.dir)).toBe(keyRoot(homedir));
  });
});

describe('generateKeyPair', () => {
  it('writes the pair with openssl into a 0700 folder, the key 0600, leaving no temp files', () => {
    const p = paths();
    fs.mkdirSync(p.dir, { recursive: true, mode: 0o755 });
    fs.chmodSync(p.dir, 0o755);
    const sh = fakeOpenssl({ pair });
    const r = generateKeyPair(p, { sh, now: NOW });
    expect(r.ok).toBe(true);
    expect(mode(p.dir)).toBe(0o700);
    expect(mode(path.dirname(p.dir))).toBe(0o700);
    expect(mode(p.key)).toBe(0o600);
    expect(fs.readFileSync(p.key, 'utf8')).toBe(pair.keyPem);
    expect(fs.readFileSync(p.cert, 'utf8')).toBe(pair.certPem);
    expect(fs.readdirSync(p.dir).sort()).toEqual(['server.crt', 'server.key']);

    expect(sh.calls).toHaveLength(1);
    const { cmd, args } = sh.calls[0];
    expect(cmd).toBe('openssl');
    expect(args.slice(0, 8)).toEqual(['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '730']);
    expect(args).toContain('-subj');
    expect(args[args.indexOf('-subj') + 1]).toBe(`/CN=Foreman ${projectId(root, config())}`);
    for (const flag of ['-keyout', '-out']) {
      const file = args[args.indexOf(flag) + 1];
      expect(path.dirname(file)).toBe(p.dir);
      expect([p.key, p.cert]).not.toContain(file);
    }
    expect(JSON.stringify(r)).not.toContain('+++++');
  });

  it("gives 'openssl-failed' when openssl exits non-zero, and leaves no files", () => {
    const p = paths();
    const r = generateKeyPair(p, { sh: fakeOpenssl({ pair, status: 1 }), now: NOW });
    expect(r).toEqual({ ok: false, code: 'openssl-failed' });
    expect(fs.readdirSync(p.dir)).toEqual([]);
    expect(JSON.stringify(r)).not.toContain('acme openssl');
  });

  it("gives 'exists' for a saved key without replace, and overwrites it with replace", () => {
    const p = paths();
    expect(generateKeyPair(p, { sh: fakeOpenssl({ pair }), now: NOW }).ok).toBe(true);
    const other = makePair({ cn: 'Foreman acme 2' });
    const sh = fakeOpenssl({ pair: other });
    expect(generateKeyPair(p, { sh, now: NOW })).toEqual({ ok: false, code: 'exists' });
    expect(sh.calls).toHaveLength(0);
    expect(fs.readFileSync(p.key, 'utf8')).toBe(pair.keyPem);
    expect(generateKeyPair(p, { sh, replace: true, now: NOW }).ok).toBe(true);
    expect(fs.readFileSync(p.key, 'utf8')).toBe(other.keyPem);
  });

  it('removes the temp files when what openssl wrote does not check out', () => {
    const p = paths();
    const expired = makePair({ notAfter: new Date('2026-01-01T00:00:00Z') });
    expect(generateKeyPair(p, { sh: fakeOpenssl({ pair: expired }), now: NOW })).toEqual({ ok: false, code: 'expired' });
    expect(fs.readdirSync(p.dir)).toEqual([]);
  });
});

describe('checkPair', () => {
  it('takes a matching RSA pair', () => {
    const r = checkPair(pair.keyPem, pair.certPem, { now: NOW });
    expect(r.ok).toBe(true);
    expect(r.cert).toBeInstanceOf(crypto.X509Certificate);
  });

  it('gives each code for what is wrong', () => {
    const other = makePair();
    const ec = makePair({ keyType: 'ec' });
    const expired = makePair({ notAfter: new Date('2026-01-01T00:00:00Z') });
    const locked = pair.key.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'acme' });
    const lockedOld = pair.key.export({ type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'acme' });
    const check = (k, c) => checkPair(k, c, { now: NOW });
    expect(check(other.keyPem, pair.certPem)).toEqual({ ok: false, code: 'mismatch' });
    expect(check('not a key', pair.certPem)).toEqual({ ok: false, code: 'bad-key' });
    expect(check(pair.keyPem, 'not a certificate')).toEqual({ ok: false, code: 'bad-cert' });
    expect(check(ec.keyPem, ec.certPem)).toEqual({ ok: false, code: 'not-rsa' });
    expect(check(expired.keyPem, expired.certPem)).toEqual({ ok: false, code: 'expired' });
    expect(check(locked, pair.certPem)).toEqual({ ok: false, code: 'passphrase' });
    expect(check(lockedOld, pair.certPem)).toEqual({ ok: false, code: 'passphrase' });
    expect(check(undefined, undefined)).toEqual({ ok: false, code: 'bad-key' });
  });
});

describe('saveKeyPair and readCertificate', () => {
  it('saves an uploaded pair with the same modes, and refuses a bad one without writing', () => {
    const p = paths();
    expect(saveKeyPair(p, makePair().keyPem, pair.certPem, { now: NOW })).toEqual({ ok: false, code: 'mismatch' });
    expect(fs.existsSync(p.key)).toBe(false);
    expect(saveKeyPair(p, pair.keyPem, pair.certPem, { now: NOW })).toMatchObject({ ok: true });
    expect(mode(p.dir)).toBe(0o700);
    expect(mode(path.dirname(p.dir))).toBe(0o700);
    expect(mode(p.key)).toBe(0o600);
    expect(mode(p.cert)).toBe(0o600);
    expect(fs.readdirSync(p.dir).sort()).toEqual(['server.crt', 'server.key']);
    expect(saveKeyPair(p, pair.keyPem, pair.certPem, { now: NOW })).toEqual({ ok: false, code: 'exists' });
    const other = makePair();
    expect(saveKeyPair(p, other.keyPem, other.certPem, { replace: true, now: NOW })).toMatchObject({ ok: true });
    expect(fs.readFileSync(p.key, 'utf8')).toBe(other.keyPem);
  });

  it('gives the certificate, its fingerprint and expiry, and nothing of the key', () => {
    const p = paths();
    expect(readCertificate(p)).toBeNull();
    saveKeyPair(p, pair.keyPem, pair.certPem, { now: NOW });
    const c = readCertificate(p);
    const x = new crypto.X509Certificate(pair.certPem);
    expect(c).toEqual({ pem: x.toString(), fingerprint256: x.fingerprint256, validTo: '2030-01-01T00:00:00.000Z', subject: 'CN=Foreman acme', keyFile: p.key });
    const text = JSON.stringify(c);
    expect(text).not.toContain('PRIVATE KEY');
    // The key's text also holds its public half, which the certificate rightly shows.
    const body = pair.keyPem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    const certText = pair.certPem.replace(/\s+/g, '');
    for (let i = 0; i + 24 <= body.length; i += 24) {
      const slice = body.slice(i, i + 24);
      if (!certText.includes(slice)) expect(text).not.toContain(slice);
    }
  });

  it('keeps only the certificate when the upload puts the key in the certificate too', () => {
    const p = paths();
    saveKeyPair(p, pair.keyPem, `${pair.keyPem}${pair.certPem}`, { now: NOW });
    expect(fs.readFileSync(p.cert, 'utf8')).not.toContain('PRIVATE KEY');
    expect(JSON.stringify(readCertificate(p))).not.toContain('PRIVATE KEY');
  });

  it('gives null while only one of the files is there', () => {
    const p = paths();
    saveKeyPair(p, pair.keyPem, pair.certPem, { now: NOW });
    fs.rmSync(p.key);
    expect(readCertificate(p)).toBeNull();
  });
});

describe('the validators', () => {
  it('isUsername', () => {
    expect(isUsername(USER)).toBe(true);
    for (const v of ['admin acme@x', 'admin', '-admin@acme.example', `${'a'.repeat(200)}@x`, '', null, 42]) expect(isUsername(v), String(v)).toBe(false);
  });
  it('isClientId', () => {
    expect(isClientId(CLIENT_ID)).toBe(true);
    expect(isClientId('3MVG9.Acme_key.0123')).toBe(true);
    for (const v of ['short', '-3MVG9AcmeConsumerKey', '3MVG9 Acme Consumer', 'x'.repeat(300), '', undefined]) expect(isClientId(v), String(v)).toBe(false);
  });
  it('canonicalUrl', () => {
    expect(canonicalUrl('https://test.salesforce.com')).toBe('https://test.salesforce.com');
    expect(canonicalUrl('https://test.salesforce.com/')).toBe('https://test.salesforce.com');
    expect(canonicalUrl('https://acme--dev1.sandbox.my.salesforce.com')).toBe('https://acme--dev1.sandbox.my.salesforce.com');
    expect(canonicalUrl('https://acme.my.site.force.com')).toBe('https://acme.my.site.force.com');
    for (const v of ['http://test.salesforce.com', 'https://evil.com', 'https://salesforce.com.evil.com', 'https://user@test.salesforce.com', 'https://test.salesforce.com/path', 'https://test.salesforce.com/?a=1', 'https://test.salesforce.com/#x', 'test.salesforce.com', '', null]) {
      expect(canonicalUrl(v), String(v)).toBeNull();
    }
  });
});

describe('connectOrg', () => {
  const connect = (sh, over = {}) =>
    connectOrg({ config: config(), env: env(), homedir, sh, alias: 'acme-dev1', username: USER, clientId: CLIENT_ID, instanceUrl: 'https://test.salesforce.com', keyFile: paths().key, now: NOW, ...over });

  it('signs the org in to the isolated home, then checks it is the configured sandbox', () => {
    const sh = fakeSfShell({ [LOGIN]: sfOk({ username: USER, orgId: ACME_DEV1_ID }), [orgRoute('acme-dev1')]: orgRecord(ACME_DEV1_ID) });
    expect(connect(sh)).toEqual({ status: 'connected', orgId: ACME_DEV1_ID });
    const lines = sh.sfLines();
    expect(lines[0]).toBe(`org login jwt --alias acme-dev1 --username ${USER} --jwt-key-file ${paths().key} --client-id ${CLIENT_ID} --instance-url https://test.salesforce.com --json`);
    expect(lines[1]).toContain('data query --query SELECT Id, IsSandbox FROM Organization --target-org acme-dev1');
    expect(lines).toHaveLength(2);
    for (const c of sh.calls) {
      expect(c.opts.env.HOME).toBe(sfHomeDir);
      expect(c.opts.env.SF_USE_GENERIC_UNIX_KEYCHAIN).toBe('true');
    }
    expect(mode(sfHomeDir)).toBe(0o700);
  });

  it('tightens a home that already exists to 700', () => {
    fs.mkdirSync(sfHomeDir, { recursive: true });
    fs.chmodSync(sfHomeDir, 0o755);
    const sh = fakeSfShell({ [LOGIN]: sfOk({ username: USER, orgId: ACME_DEV1_ID }), [orgRoute('acme-dev1')]: orgRecord(ACME_DEV1_ID) });
    expect(connect(sh)).toEqual({ status: 'connected', orgId: ACME_DEV1_ID });
    expect(mode(sfHomeDir)).toBe(0o700);
  });

  it('signs a production org out at once and refuses it', () => {
    const sh = fakeSfShell({ [LOGIN]: sfOk({}), [orgRoute('acme-dev1')]: orgRecord(ACME_DEV1_ID, false), [LOGOUT]: sfOk({}) });
    expect(connect(sh)).toEqual({ status: 'refused', code: 'production', loggedOut: true });
    const lines = sh.sfLines();
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('org logout --target-org acme-dev1 --no-prompt --json');
    expect(sh.calls[2].opts.env.HOME).toBe(sfHomeDir);
  });

  it('refuses and signs out a record whose IsSandbox is anything but true', () => {
    const records = [{ Id: ACME_DEV1_ID }, { Id: ACME_DEV1_ID, IsSandbox: null }, { Id: ACME_DEV1_ID, IsSandbox: 'true' }, { Id: ACME_DEV1_ID, IsSandbox: 1 }];
    for (const rec of records) {
      const sh = fakeSfShell({ [LOGIN]: sfOk({}), [orgRoute('acme-dev1')]: sfOk({ records: [rec], totalSize: 1, done: true }), [LOGOUT]: sfOk({}) });
      expect(connect(sh), JSON.stringify(rec)).toEqual({ status: 'refused', code: 'production', loggedOut: true });
      expect(sh.sfLines().at(-1)).toBe('org logout --target-org acme-dev1 --no-prompt --json');
      expect(sh.calls.at(-1).opts.env.HOME).toBe(sfHomeDir);
    }
  });

  describe('a production org marked "production": true', () => {
    const marked = () => {
      const cfg = config();
      cfg.salesforce.orgs['acme-main'] = { orgId: ACME_PROD_ID, production: true };
      return cfg;
    };
    const main = (sh, cfg = marked()) => connect(sh, { config: cfg, alias: 'acme-main', instanceUrl: 'https://login.salesforce.com' });

    it('connects it, and stays signed in', () => {
      const sh = fakeSfShell({ [LOGIN]: sfOk({}), [orgRoute('acme-main')]: orgRecord(ACME_PROD_ID, false), [LOGOUT]: sfOk({}) });
      expect(main(sh)).toEqual({ status: 'connected', orgId: ACME_PROD_ID });
      expect(sh.sfLines().some((l) => l.includes(LOGOUT))).toBe(false);
    });
    it('still signs out and refuses it when it is not marked', () => {
      const cfg = marked();
      delete cfg.salesforce.orgs['acme-main'].production;
      const sh = fakeSfShell({ [LOGIN]: sfOk({}), [orgRoute('acme-main')]: orgRecord(ACME_PROD_ID, false), [LOGOUT]: sfOk({}) });
      expect(main(sh, cfg)).toEqual({ status: 'refused', code: 'production', loggedOut: true });
      expect(sh.sfLines().at(-1)).toBe('org logout --target-org acme-main --no-prompt --json');
    });
    it('signs out and refuses a marked alias whose server gives another org ID', () => {
      const sh = fakeSfShell({ [LOGIN]: sfOk({}), [orgRoute('acme-main')]: orgRecord('00D000000000042AAA', false), [LOGOUT]: sfOk({}) });
      expect(main(sh)).toEqual({ status: 'refused', code: 'production', loggedOut: true });
    });
  });

  it('signs the org out when the check fails, or finds no record', () => {
    const failing = fakeSfShell({ [LOGIN]: sfOk({}), [orgRoute('acme-dev1')]: sfError('INVALID_TYPE', 'sObject type Organization is not supported'), [LOGOUT]: sfError('SfError', 'no') });
    expect(connect(failing)).toEqual({ status: 'refused', code: 'not-checked', loggedOut: false });
    expect(failing.sfLines()[2]).toBe('org logout --target-org acme-dev1 --no-prompt --json');
    const empty = fakeSfShell({ [LOGIN]: sfOk({}), [orgRoute('acme-dev1')]: sfOk({ records: [], totalSize: 0, done: true }), [LOGOUT]: sfOk({}) });
    expect(connect(empty)).toEqual({ status: 'refused', code: 'not-checked', loggedOut: true });
  });

  it('offers the org ID it found when it differs from the config, and stays signed in', () => {
    const found = '00D000000000042AAA';
    const sh = fakeSfShell({ [LOGIN]: sfOk({}), [orgRoute('acme-dev1')]: orgRecord(found) });
    expect(connect(sh)).toEqual({ status: 'org-id-differs', orgId: found, configured: ACME_DEV1_ID });
    expect(sh.sfLines().some((l) => l.includes(LOGOUT))).toBe(false);
  });

  it('takes a 15-character org ID in the config as the same org', () => {
    const cfg = config();
    cfg.salesforce.orgs['acme-dev1'].orgId = ACME_DEV1_ID.slice(0, 15);
    const sh = fakeSfShell({ [LOGIN]: sfOk({}), [orgRoute('acme-dev1')]: orgRecord(ACME_DEV1_ID) });
    expect(connect(sh, { config: cfg })).toEqual({ status: 'connected', orgId: ACME_DEV1_ID });
  });

  it("refuses a relative FOREMAN_SF_HOME, and an org cooling down, without calling sf", () => {
    const sh = fakeSfShell({});
    expect(connect(sh, { env: { FOREMAN_SF_HOME: '~/sf-home' } })).toMatchObject({ status: 'failed', code: 'home' });
    fs.mkdirSync(sfHomeDir, { recursive: true });
    recordCooldown(sfHomeDir, 'acme-dev1', { reason: 'login rate exceeded', now: NOW.getTime() - 60_000 });
    expect(connect(sh)).toMatchObject({ status: 'failed', code: 'cooldown' });
    expect(sh.calls).toHaveLength(0);
  });

  it('cools the org down when the sign-in hits the login rate', () => {
    const sh = fakeSfShell({ [LOGIN]: sfError('SfError', 'login rate exceeded') });
    expect(connect(sh)).toMatchObject({ status: 'failed', code: 'login-rate' });
    expect(connect(sh)).toMatchObject({ status: 'failed', code: 'cooldown' });
    expect(sh.calls).toHaveLength(1);
  });

  it('maps a failed sign-in to its code, and never answers with sf\'s words, the username or the client ID', () => {
    const sh = fakeSfShell({ [LOGIN]: sfError('SfError', `invalid_grant: user hasn't approved this consumer (${USER})`) });
    const r = connect(sh);
    expect(r).toMatchObject({ status: 'failed', code: 'not-approved' });
    const text = JSON.stringify(r);
    for (const s of [USER, CLIENT_ID, "hasn't approved", 'invalid_grant']) expect(text).not.toContain(s);
  });

  it('names an unknown failure by its sf error name only', () => {
    const sh = fakeSfShell({ [LOGIN]: sfError('JwtGrantError', `something odd for ${USER}`) });
    expect(connect(sh)).toEqual({ status: 'failed', code: 'sign-in', errorName: 'JwtGrantError' });
    const odd = fakeSfShell({ [LOGIN]: sfError(`Bad name ${USER}`, 'x') });
    expect(connect(odd)).toEqual({ status: 'failed', code: 'sign-in', errorName: 'SfError' });
  });
});

describe('classifyLoginError', () => {
  const login = (answer) => runSf(fakeSfShell({ [LOGIN]: answer }), ['org', 'login', 'jwt', '--alias', 'acme-dev1']);

  it('reads sf\'s own message behind the auth stop', () => {
    const r = login(sfError('SfError', "invalid_grant: user hasn't approved this consumer"));
    expect(r.code).toBe('auth');
    expect(classifyLoginError(r)).toBe('not-approved');
    expect(classifyLoginError(login(sfError('SfError', 'invalid_grant: audience is invalid')))).toBe('audience');
    expect(classifyLoginError(login(sfError('SfError', 'invalid_grant: invalid assertion')))).toBe('assertion');
    expect(classifyLoginError(login(sfError('SfError', 'invalid_grant: not admin approved')))).toBe('not-approved');
  });

  it('maps each case', () => {
    expect(classifyLoginError(login(sfError('SfError', 'invalid_client_id: client identifier invalid')))).toBe('client-id');
    expect(classifyLoginError(login(sfError('SfError', 'JWT signature does not match')))).toBe('assertion');
    expect(classifyLoginError(login(sfError('SfError', 'login rate exceeded')))).toBe('login-rate');
    expect(classifyLoginError({ ok: false, code: 'timeout', error: { name: 'SfTimeout', message: 'timed out after 2 min' } })).toBe('timeout');
    expect(classifyLoginError({ ok: false, code: 'cooldown', error: { name: 'SfCoolingDown', message: 'x' } })).toBe('cooldown');
    expect(classifyLoginError({ ok: false, error: { name: 'SfNotFound', message: 'sf printed no JSON (exit 127)' } })).toBe('no-sf');
    expect(classifyLoginError(login(sfError('SfError', 'getaddrinfo ENOTFOUND test.salesforce.com')))).toBe('unreachable');
    expect(classifyLoginError(login(sfError('SfError', 'something else entirely')))).toBe('sign-in');
    expect(classifyLoginError({})).toBe('sign-in');
  });
});
