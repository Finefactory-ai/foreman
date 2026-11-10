import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COOLDOWN_MS, SF_WATCH, TIME_LIMITS, cooldownFile, coolingDown, isNotSignedIn, isUnreachable, limitFor, loginTrouble, recordCooldown, runSf, stopsRetry, troubleText } from './sf.mjs';
import { isolatedSh } from './isolation.mjs';
import { sfCall, sfError, sfOk, sfRaw } from '../../../test/fake-sf.mjs';

// A fake sh that records each call and answers with `answer`, a result or a function of the call.
function recorder(answer) {
  const calls = [];
  const sh = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return typeof answer === 'function' ? answer(cmd, args, opts) : answer;
  };
  sh.calls = calls;
  return sh;
}

const NOT_FOUND = 'Parsing --target-org \n\tNo authorization information found for acme-qa.\n\tSee more details with --help';

describe('runSf: the call', () => {
  it('adds --json once and calls sh with sf, the args and a timeout', () => {
    const sh = recorder(sfOk({}));
    runSf(sh, ['org', 'display', '--target-org', 'acme-qa']);
    runSf(sh, ['version', '--json'], { timeoutMs: 5000, cwd: '/tmp/acme' });
    const read = (c) => ({ ...sfCall(c.cmd, c.args), opts: c.opts });
    expect(read(sh.calls[0])).toEqual({ cmd: 'sf', args: ['org', 'display', '--target-org', 'acme-qa', '--json'], limitMs: 120_000, opts: { timeout: 135_000 } });
    expect(read(sh.calls[1])).toEqual({ cmd: 'sf', args: ['version', '--json'], limitMs: 5000, opts: { timeout: 20_000, cwd: '/tmp/acme' } });
  });
  it('passes no env, and does not change the caller\'s args', () => {
    const sh = recorder(sfOk({}));
    const args = ['plugins', '--core'];
    runSf(sh, args);
    expect(args).toEqual(['plugins', '--core']);
    expect(sh.calls[0].opts).not.toHaveProperty('env');
  });
  it('runs sf through the watcher: node, the watcher, the limit, sf, the args and --json', () => {
    const sh = recorder(sfOk({}));
    runSf(sh, ['data', 'query', '--query', 'SELECT Id FROM Organization', '--target-org', 'acme-qa']);
    const [{ cmd, args, opts }] = sh.calls;
    expect(cmd).toBe(process.execPath);
    expect(args).toEqual([SF_WATCH, '120000', 'sf', 'data', 'query', '--query', 'SELECT Id FROM Organization', '--target-org', 'acme-qa', '--json']);
    expect(opts).toEqual({ timeout: 135_000 });
    expect(path.basename(SF_WATCH)).toBe('sf-watch.mjs');
    expect(fs.existsSync(SF_WATCH)).toBe(true);
  });
  it('passes the other options of a wrapping sh through unchanged', () => {
    const inner = recorder(sfOk({}));
    const roomy = (cmd, args, opts = {}) => inner(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts });
    expect(runSf(roomy, ['plugins', '--core'])).toMatchObject({ ok: true });
    expect(inner.calls[0].opts).toEqual({ maxBuffer: 64 * 1024 * 1024, timeout: 135_000 });
  });
});

describe('runSf: jsonFlag', () => {
  it('sends no --json with jsonFlag false, and returns the raw body as the result', () => {
    const body = { id: '00B000000000001AAA', query: 'SELECT Id FROM Case' };
    const sh = recorder(sfRaw(body));
    const r = runSf(sh, ['api', 'request', 'rest', '/services/data/v62.0/sobjects/Case/listviews/00B000000000001AAA/describe', '--target-org', 'acme-qa'], { jsonFlag: false });
    expect(sfCall(sh.calls[0].cmd, sh.calls[0].args).args).not.toContain('--json');
    expect(r).toEqual({ ok: true, result: body, error: null });
  });
  it('still adds --json by default and when jsonFlag is true', () => {
    const sh = recorder(sfOk({}));
    runSf(sh, ['org', 'list']);
    runSf(sh, ['org', 'list'], { jsonFlag: true });
    for (const c of sh.calls) expect(sfCall(c.cmd, c.args).args).toEqual(['org', 'list', '--json']);
  });
  it('keeps the failure handling with jsonFlag false', () => {
    const sh = recorder(sfError('NOT_FOUND', 'no such view'));
    expect(runSf(sh, ['api', 'request', 'rest', '/x'], { jsonFlag: false })).toMatchObject({ ok: false, error: { name: 'NOT_FOUND', message: 'no such view' } });
  });
});

describe('runSf: time limits', () => {
  it('limitFor gives each command family its limit', () => {
    expect(TIME_LIMITS).toEqual({ agent: 600_000, deploy: 1_800_000, other: 120_000 });
    for (const args of [['data', 'query'], ['org', 'list'], ['plugins'], ['config', 'get', 'disable-telemetry'], ['version'], []]) {
      expect(limitFor(args), args.join(' ')).toBe(120_000);
    }
    for (const args of [['project', 'deploy', 'start'], ['project', 'deploy', 'report'], ['project', 'retrieve', 'start'], ['apex', 'run', 'test'], ['sgd', 'source', 'delta']]) {
      expect(limitFor(args), args.join(' ')).toBe(1_800_000);
    }
    expect(limitFor(['agent', 'publish', 'authoring-bundle'])).toBe(600_000);
    expect(limitFor(undefined)).toBe(120_000);
  });
  it('falls back to the family limit when timeoutMs is not a positive whole number, and keeps 5000', () => {
    for (const timeoutMs of [undefined, 0, -1, NaN, Infinity, '5000', 1.5]) {
      const sh = recorder(sfOk({}));
      runSf(sh, ['project', 'deploy', 'report'], { timeoutMs });
      expect(sfCall(sh.calls[0].cmd, sh.calls[0].args).limitMs, String(timeoutMs)).toBe(1_800_000);
      expect(sh.calls[0].opts.timeout).toBe(1_815_000);
    }
    const sh = recorder(sfOk({}));
    runSf(sh, ['project', 'deploy', 'report'], { timeoutMs: 5000 });
    expect(sfCall(sh.calls[0].cmd, sh.calls[0].args).limitMs).toBe(5000);
  });
  it('reads the watcher\'s timeout verdict, and strips its line from the output', () => {
    const answer = { status: 124, stdout: '', stderr: 'foreman-sf-watch: {"stop":"timeout","limitMs":120000}\n' };
    expect(runSf(recorder(answer), ['data', 'query'])).toEqual({ ok: false, code: 'timeout', result: null, error: { name: 'SfTimeout', message: 'timed out after 2 min', exitCode: 124 } });
    const short = { status: 124, stdout: '', stderr: ' ›   Warning: x\nforeman-sf-watch: {"stop":"timeout","limitMs":45000}\n' };
    expect(runSf(recorder(short), ['data', 'query']).error.message).toBe('timed out after 45 s');
  });
});

// The error sf printed when it ran into the login loop.
const LOOP_TEXT = 'Failed to execute tests: Error authenticating with JWT.\nErrors encountered:\nlogin rate exceeded\nExternal client app is not installed in this org\naudience is invalid  [audience=https://login.salesforce.com login=https://test.salesforce.com/]';

// What real sf prints with --json when a refresh token has expired: the inner jsforce error,
// named invalid_grant, is only in `cause`, written as inspect() of that error.
const REFRESH_EXPIRED = {
  status: 1,
  name: 'RefreshTokenAuthError',
  message: 'Error authenticating with the refresh token due to: expired access/refresh token',
  cause: 'invalid_grant: expired access/refresh token\n    at OAuth2._postParams (/acme/node_modules/jsforce/lib/oauth2.js:205:19)',
  warnings: [],
};

describe('runSf: login trouble', () => {
  it('loginTrouble knows login-rate and auth errors, login-rate first', () => {
    expect(loginTrouble(LOOP_TEXT)).toBe('login-rate');
    expect(loginTrouble('REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded.')).toBe('login-rate');
    expect(loginTrouble('Login Rate Exceeded')).toBe('login-rate');
    expect(loginTrouble('invalid_grant: authentication failure')).toBe('auth');
    expect(loginTrouble(`${LOOP_TEXT}\ninvalid_grant: expired access/refresh token`)).toBe('login-rate');
    expect(loginTrouble('Invalid token\nInvalid token')).toBeNull();
    expect(loginTrouble('Invalid token\ninvalid token\nInvalid token')).toBe('auth');
    expect(loginTrouble('MALFORMED_QUERY: unexpected token')).toBeNull();
    expect(loginTrouble(undefined)).toBeNull();
  });
  it('a failed answer holding REQUEST_LIMIT_EXCEEDED is login-rate, stopped at once', () => {
    const r = runSf(recorder(sfError('SfError', 'REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded.')), ['data', 'query']);
    expect(r).toMatchObject({ ok: false, code: 'login-rate', result: null, error: { name: 'SfLoginRate', exitCode: 1 } });
    expect(r.error.message).toMatch(/^stopped at once:.*REQUEST_LIMIT_EXCEEDED/);
    expect(stopsRetry(r)).toBe(true);
  });
  it('a failed answer holding invalid_grant is auth, and counts as not signed in', () => {
    const r = runSf(recorder(sfError('SfError', 'invalid_grant: expired access/refresh token for admin@acme-qa.acme.example')), ['data', 'query']);
    expect(r).toMatchObject({ ok: false, code: 'auth', result: null, error: { name: 'SfAuthError' } });
    expect(r.error.message).toMatch(/^stopped at once:.*invalid_grant/);
    expect(isNotSignedIn(r.error)).toBe(true);
    expect(stopsRetry(r)).toBe(true);
  });
  it('keeps sf\'s own message on an auth stop in sfMessage, for classifying only', () => {
    const r = runSf(recorder(sfError('SfError', "invalid_grant:   user hasn't approved\n this consumer")), ['org', 'login', 'jwt']);
    expect(r.code).toBe('auth');
    expect(r.error.message).toMatch(/^stopped at once:.*invalid_grant/);
    expect(r.error.sfMessage).toBe("invalid_grant: user hasn't approved this consumer");
    const plain = { status: 1, stdout: '', stderr: 'Warning: x\nError (1): invalid_grant audience is invalid\nmore\n' };
    expect(runSf(recorder(plain), ['org', 'login', 'jwt']).error.sfMessage).toBe('Error (1): invalid_grant audience is invalid');
    for (const other of [sfOk({}), sfError('MALFORMED_QUERY', 'unexpected token'), sfError('SfError', 'login rate exceeded')]) {
      const res = runSf(recorder(other), ['data', 'query']);
      expect(res.error?.sfMessage).toBeUndefined();
    }
  });
  it('login-rate wins when both appear, with the login loop\'s exact text', () => {
    const r = runSf(recorder(sfError('AcmeEvalError', `${LOOP_TEXT}\ninvalid_grant`)), ['agent', 'test', 'run', '--api-name', 'Acme_Agent']);
    expect(r).toMatchObject({ code: 'login-rate', error: { name: 'SfLoginRate' } });
    expect(r.error.message).toMatch(/"login rate exceeded"/);
  });
  it('keeps no result with keepResult on a login stop', () => {
    const answer = { status: 1, stdout: JSON.stringify({ status: 1, result: { status: 'InProgress' }, message: 'login rate exceeded' }), stderr: '' };
    expect(runSf(recorder(answer), ['project', 'deploy', 'report'], { keepResult: true })).toMatchObject({ code: 'login-rate', result: null });
  });
  it('reads the watcher\'s login verdicts', () => {
    const rate = { status: 125, stdout: '', stderr: 'login rate exceeded\nforeman-sf-watch: {"stop":"login-rate","limitMs":120000}\n' };
    expect(runSf(recorder(rate), ['data', 'query'])).toMatchObject({ ok: false, code: 'login-rate', error: { name: 'SfLoginRate', exitCode: 125 } });
    const auth = { status: 125, stdout: '', stderr: 'Invalid token\nInvalid token\nInvalid token\nforeman-sf-watch: {"stop":"auth","limitMs":120000}\n' };
    expect(runSf(recorder(auth), ['data', 'query'])).toMatchObject({ ok: false, code: 'auth', error: { name: 'SfAuthError' } });
  });
  it('troubleText reads stderr and only the name and message of sf\'s error envelope', () => {
    const records = (value) => sfOk({ records: [{ Name: value }] }).stdout;
    expect(loginTrouble(troubleText(records('login rate exceeded'), ''))).toBeNull();
    expect(loginTrouble(troubleText(records('invalid_grant'), ''))).toBeNull();
    expect(loginTrouble(troubleText(sfOk({ records: ['Invalid token', 'Invalid token', 'Invalid token'].map((Name) => ({ Name })) }).stdout, ''))).toBeNull();
    const deploy = JSON.stringify({ status: 1, name: 'DeployFailed', message: 'it broke', result: { problem: 'invalid_grant' } });
    expect(troubleText(deploy, '')).toContain('DeployFailed');
    expect(troubleText(deploy, '')).toContain('it broke');
    expect(troubleText(deploy, '')).not.toContain('invalid_grant');
    expect(loginTrouble(troubleText(sfError('SfError', 'login rate exceeded').stdout, ''))).toBe('login-rate');
    expect(loginTrouble(troubleText(JSON.stringify({ status: 1, message: 'invalid_grant' }), ''))).toBe('auth');
    expect(loginTrouble(troubleText(JSON.stringify({ status: 1, name: 'SfError', message: 'invalid_grant: expired' }), ''))).toBe('auth');
    expect(loginTrouble(troubleText('login rate exceeded', ''))).toBeNull();
    expect(loginTrouble(troubleText('', 'login rate exceeded'))).toBe('login-rate');
    expect(loginTrouble(troubleText(undefined, undefined))).toBeNull();
    expect(troubleText(sfRaw({ cliVersion: 'x' }).stdout, '')).toBe(troubleText('', ''));
    expect(troubleText(sfRaw({ name: 'login rate exceeded', message: 'x', status: 0 }).stdout, '')).toBe(troubleText('', ''));
  });
  it('troubleText reads the cause, code and stack of the envelope, never its result, data or warnings', () => {
    expect(loginTrouble(troubleText(JSON.stringify(REFRESH_EXPIRED), ''))).toBe('auth');
    expect(loginTrouble(troubleText(JSON.stringify({ ...REFRESH_EXPIRED, cause: { name: 'invalid_grant', message: 'expired access/refresh token' } }), ''))).toBe('auth');
    expect(loginTrouble(troubleText(JSON.stringify({ status: 1, name: 'SfError', message: 'x', code: 'REQUEST_LIMIT_EXCEEDED' }), ''))).toBe('login-rate');
    expect(loginTrouble(troubleText(JSON.stringify({ status: 1, name: 'SfError', message: 'x', stack: 'SfError: x\n    at login rate exceeded (/acme/a.js:1:1)' }), ''))).toBe('login-rate');
    const quiet = { status: 1, name: 'SfError', message: 'x', result: 'invalid_grant', data: 'login rate exceeded', warnings: ['REQUEST_LIMIT_EXCEEDED'] };
    expect(loginTrouble(troubleText(JSON.stringify(quiet), ''))).toBeNull();
    expect(loginTrouble(troubleText(JSON.stringify({ status: 0, result: {}, cause: 'invalid_grant' }), ''))).toBeNull();
  });
  it('an expired refresh token, as real sf prints it, is auth and stopped at once', () => {
    const r = runSf(recorder({ status: 1, stdout: JSON.stringify(REFRESH_EXPIRED), stderr: '' }), ['data', 'query', '--target-org', 'acme-qa']);
    expect(r).toMatchObject({ ok: false, code: 'auth', result: null, error: { name: 'SfAuthError' } });
    expect(r.error.message).toMatch(/^stopped at once:.*invalid_grant/);
    expect(isNotSignedIn(r.error)).toBe(true);
    expect(stopsRetry(r)).toBe(true);
  });
  it('a success whose data holds a login phrase stays ok, writes no cool-down and is called again', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-data-'));
    try {
      for (const phrase of ['login rate exceeded', 'invalid_grant', 'REQUEST_LIMIT_EXCEEDED']) {
        const records = [{ Id: '001000000000001AAA', Description: phrase }];
        const sh = recorder(sfOk({ records }));
        sh.sfHome = home;
        const r = runSf(sh, ['data', 'query', '--target-org', 'acme-qa']);
        expect(r, phrase).toEqual({ ok: true, result: { records }, error: null });
        expect(r).not.toHaveProperty('code');
        expect(fs.existsSync(cooldownFile(home, 'acme-qa'))).toBe(false);
        expect(runSf(sh, ['data', 'query', '--target-org', 'acme-qa']).ok).toBe(true);
        expect(sh.calls).toHaveLength(2);
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
  it('a failed deploy whose problems hold a login phrase keeps its result and cools nothing down', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-deploy-'));
    try {
      const result = { details: { componentFailures: [{ problem: 'login rate exceeded' }] } };
      const sh = recorder({ status: 1, stdout: JSON.stringify({ status: 1, name: 'DeployFailed', message: 'Deploy failed', result }), stderr: '' });
      sh.sfHome = home;
      const r = runSf(sh, ['project', 'deploy', 'start', '--target-org', 'acme-qa'], { keepResult: true });
      expect(r.code).toBeUndefined();
      expect(r.ok).toBe(false);
      expect(r.error.name).toBe('DeployFailed');
      expect(r.result).toEqual(result);
      expect(fs.existsSync(cooldownFile(home, 'acme-qa'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
  it('leaves ordinary results with no code key, and stopsRetry false', () => {
    const good = runSf(recorder(sfOk({})), ['data', 'query']);
    const bad = runSf(recorder(sfError('MALFORMED_QUERY', 'unexpected token')), ['data', 'query']);
    expect(good).not.toHaveProperty('code');
    expect(bad).not.toHaveProperty('code');
    expect(stopsRetry(good)).toBe(false);
    expect(stopsRetry(bad)).toBe(false);
    expect(stopsRetry(undefined)).toBe(false);
  });
});

describe('runSf: the cool-down store', () => {
  let home;
  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-cooldown-'));
  });
  afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

  it('records a cool-down of an hour and reads it back until it ends', () => {
    const now = Date.parse('2026-10-24T10:00:00.000Z');
    expect(COOLDOWN_MS).toBe(3_600_000);
    const rec = recordCooldown(home, 'acme-qa', { reason: 'login rate exceeded', now });
    expect(rec).toEqual({ org: 'acme-qa', reason: 'login rate exceeded', at: '2026-10-24T10:00:00.000Z', until: '2026-10-24T11:00:00.000Z' });
    expect(JSON.parse(fs.readFileSync(cooldownFile(home, 'acme-qa'), 'utf8'))).toEqual(rec);
    expect(coolingDown(home, 'acme-qa', now + 1000)).toEqual(rec);
    expect(coolingDown(home, 'acme-qa', now + COOLDOWN_MS)).toBeNull();
    expect(coolingDown(home, 'acme-dev1', now)).toBeNull();
  });
  it('gives null for a broken file', () => {
    const file = cooldownFile(home, 'acme-broken');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not json');
    expect(coolingDown(home, 'acme-broken')).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ org: 'acme-broken', until: 'soon' }));
    expect(coolingDown(home, 'acme-broken')).toBeNull();
  });
  it('keeps every file inside <home>/.foreman/cooldown', () => {
    const dir = path.join(home, '.foreman', 'cooldown');
    for (const org of ['..', '../..', 'a/b', '/etc/passwd']) {
      const file = cooldownFile(home, org);
      expect(path.dirname(file)).toBe(dir);
      expect(path.basename(file)).toMatch(/^org-/);
    }
  });
  it('a plain sh with no sfHome is never refused and writes no file', () => {
    const sh = recorder(sfError('SfError', 'login rate exceeded'));
    const first = runSf(sh, ['data', 'query', '--target-org', 'acme-qa']);
    expect(first.code).toBe('login-rate');
    expect(first.error.message).not.toMatch(/until/);
    expect(runSf(sh, ['data', 'query', '--target-org', 'acme-qa']).code).toBe('login-rate');
    expect(sh.calls).toHaveLength(2);
  });
  it('an sh with an sfHome records the cool-down after login-rate, reading -o and --target-org=', () => {
    const own = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-own-'));
    try {
      const sh = recorder(sfError('SfError', 'login rate exceeded'));
      sh.sfHome = own;
      const now = Date.parse('2026-10-24T10:00:00.000Z');
      const r = runSf(sh, ['data', 'query', '-o', 'acme-qa'], { now });
      expect(r.code).toBe('login-rate');
      expect(r.error.message).toContain('2026-10-24T11:00:00.000Z');
      const refused = runSf(sh, ['data', 'query', '--target-org=acme-qa'], { now: now + 60_000 });
      expect(refused).toEqual({
        ok: false,
        code: 'cooldown',
        result: null,
        error: { name: 'SfCoolingDown', exitCode: 1, message: 'Foreman makes no sf call to acme-qa until 2026-10-24T11:00:00.000Z: it answered "login rate exceeded" at 2026-10-24T10:00:00.000Z; the org can lock out logins for up to an hour' },
      });
      expect(stopsRetry(refused)).toBe(true);
      expect(sh.calls).toHaveLength(1);
      expect(runSf(sh, ['org', 'list'], { now }).code).toBe('login-rate');
      expect(sh.calls).toHaveLength(2);
    } finally {
      fs.rmSync(own, { recursive: true, force: true });
    }
  });
});

describe('runSf: reading the output', () => {
  it('gives the result of a success envelope', () => {
    const r = runSf(recorder(sfOk({ records: [{ Id: '00D000000000001AAA' }] })), ['data', 'query']);
    expect(r).toEqual({ ok: true, result: { records: [{ Id: '00D000000000001AAA' }] }, error: null });
  });
  it('gives raw output with no envelope as it is (plugins --core and version)', () => {
    const list = [{ name: '@salesforce/cli', version: '2.150.6', type: 'core' }];
    expect(runSf(recorder(sfRaw(list)), ['plugins', '--core'])).toEqual({ ok: true, result: list, error: null });
    const version = { cliVersion: '@salesforce/cli/2.150.6', architecture: 'darwin-arm64' };
    expect(runSf(recorder(sfRaw(version)), ['version'])).toEqual({ ok: true, result: version, error: null });
  });
  it('reads an error with no status field, without its actions or stack', () => {
    const r = runSf(recorder(sfError('NamedOrgNotFoundError', NOT_FOUND, 2)), ['org', 'display']);
    expect(r.ok).toBe(false);
    expect(r.result).toBeNull();
    expect(r.error).toEqual({
      name: 'NamedOrgNotFoundError',
      exitCode: 2,
      message: 'Parsing --target-org No authorization information found for acme-qa. See more details with --help',
    });
    expect(JSON.stringify(r.error)).not.toContain('Did you mean');
  });
  it('reads a JSON error on stderr after warning lines, when stdout is empty', () => {
    const body = JSON.stringify({ name: 'NoDefaultEnvError', message: 'No default environment found.', exitCode: 1 }, null, 2);
    const sh = recorder({ status: 1, stdout: '', stderr: ` ›   Warning: @salesforce/cli update available from 2.150.6 to 2.160.0.\n${body}\n` });
    expect(runSf(sh, ['org', 'display']).error).toEqual({ name: 'NoDefaultEnvError', message: 'No default environment found.', exitCode: 1 });
  });
  it('reads JSON on stdout after warning lines', () => {
    const sh = recorder({ status: 0, stdout: ` ›   Warning: update available\n[WARN] old plugin\n${JSON.stringify({ status: 0, result: [1] })}`, stderr: '' });
    expect(runSf(sh, ['x'])).toEqual({ ok: true, result: [1], error: null });
  });
  it('fails on exit 0 with a status that is not 0', () => {
    const sh = recorder({ status: 0, stdout: JSON.stringify({ status: 1, name: 'DeployFailed', message: 'it broke' }), stderr: '' });
    expect(runSf(sh, ['x'])).toEqual({ ok: false, result: null, error: { name: 'DeployFailed', message: 'it broke', exitCode: 1 } });
  });
  it('fails on a non-zero exit with a success-looking body, naming SfError', () => {
    const sh = recorder({ status: 3, stdout: JSON.stringify({ result: {} }), stderr: '' });
    expect(runSf(sh, ['x']).error).toMatchObject({ name: 'SfError', exitCode: 3 });
  });
  it('names a missing sf SfNotFound, and other output with no JSON NoJson', () => {
    const missing = runSf(recorder({ status: 1, stdout: '', stderr: 'spawnSync sf ENOENT' }), ['x']);
    expect(missing).toEqual({ ok: false, result: null, error: { name: 'SfNotFound', message: 'sf printed no JSON (exit 1)', exitCode: 1 } });
    const noise = runSf(recorder({ status: 0, stdout: 'Error: something odd\n', stderr: '' }), ['x']);
    expect(noise.error).toEqual({ name: 'NoJson', message: 'sf printed no JSON (exit 0)', exitCode: 0 });
  });
  it('cuts a long message to 300 characters', () => {
    const r = runSf(recorder(sfError('BigError', 'word '.repeat(200))), ['x']);
    expect(r.error.message.length).toBe(300);
    expect(r.error.message.startsWith('word word')).toBe(true);
  });
});

describe('runSf never throws', () => {
  it('on a null stdout and stderr, an odd status, or a throwing sh', () => {
    expect(runSf(recorder({ status: null, stdout: null, stderr: null }), ['x'])).toMatchObject({ ok: false, error: { name: 'NoJson' } });
    expect(runSf(recorder(undefined), ['x'])).toMatchObject({ ok: false, error: { name: 'NoJson' } });
    expect(runSf(recorder({ status: 0, stdout: 'null', stderr: '' }), ['x'])).toMatchObject({ ok: false, error: { name: 'NoJson' } });
    const thrower = () => {
      throw Object.assign(new Error('spawnSync sf ENOENT'), { code: 'ENOENT' });
    };
    expect(runSf(thrower, ['x'])).toMatchObject({ ok: false, error: { name: 'SfNotFound' } });
    expect(runSf(recorder(sfOk({})), undefined)).toMatchObject({ ok: true });
  });
});

describe('isNotSignedIn and isUnreachable', () => {
  const err = (name, message) => ({ name, message, exitCode: 1 });
  it('isNotSignedIn knows the sign-in errors by name or message', () => {
    for (const name of ['NamedOrgNotFoundError', 'NoAuthInfoFound', 'AuthInfoNotFound', 'RefreshTokenAuthError', 'NoDefaultEnvError']) {
      expect(isNotSignedIn(err(name, 'x')), name).toBe(true);
    }
    expect(isNotSignedIn(err('SfError', 'No authorization information found for acme-qa.'))).toBe(true);
    expect(isNotSignedIn(err('SfError', 'Error authenticating with the refresh token due to: expired access/refresh token'))).toBe(true);
    expect(isNotSignedIn(err('SfError', 'INVALID_SESSION_ID: Session expired or invalid'))).toBe(true);
    expect(isNotSignedIn(err('MALFORMED_QUERY', 'unexpected token'))).toBe(false);
    expect(isNotSignedIn(null)).toBe(false);
  });
  it('isUnreachable knows network errors by message', () => {
    expect(isUnreachable(err('SfError', 'getaddrinfo ENOTFOUND acme--qa.sandbox.my.salesforce.com'))).toBe(true);
    expect(isUnreachable(err('SfError', 'connect ECONNREFUSED 127.0.0.1:443'))).toBe(true);
    expect(isUnreachable(err('SfError', 'socket hang up'))).toBe(true);
    expect(isUnreachable(err('NamedOrgNotFoundError', 'No authorization information found'))).toBe(false);
    expect(isUnreachable(undefined)).toBe(false);
  });
});

describe('runSf: keepResult', () => {
  const failed = { status: 1, stdout: JSON.stringify({ status: 1, result: { status: 'Failed', numberComponentErrors: 1 }, warnings: [] }), stderr: '' };
  it('keeps the result of a failing envelope when asked', () => {
    const r = runSf(recorder(failed), ['project', 'deploy', 'report'], { keepResult: true });
    expect(r.ok).toBe(false);
    expect(r.result).toEqual({ status: 'Failed', numberComponentErrors: 1 });
    expect(r.error).toMatchObject({ name: 'SfError', exitCode: 1 });
  });
  it('gives a null result for the same answer without keepResult', () => {
    expect(runSf(recorder(failed), ['project', 'deploy', 'report'])).toEqual({ ok: false, result: null, error: { name: 'SfError', message: 'sf exited 1', exitCode: 1 } });
  });
  it('gives a null result when the failing result is not an object', () => {
    for (const result of [['a'], 'text', 3, null]) {
      const answer = { status: 1, stdout: JSON.stringify({ status: 1, result }), stderr: '' };
      expect(runSf(recorder(answer), ['x'], { keepResult: true }).result).toBeNull();
    }
    expect(runSf(recorder(sfError('NoAuthInfoFound', 'No authorization information found')), ['x'], { keepResult: true }).result).toBeNull();
  });
});

describe('runSf with a real sf', () => {
  let dir;
  let bin;
  let empty;
  let home;
  const count = () => Number(fs.readFileSync(path.join(dir, 'count'), 'utf8').trim());
  const writeSf = (body) => {
    const file = path.join(bin, 'sf');
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    fs.chmodSync(file, 0o755);
  };
  const shWith = (PATH) => (cmd, args, opts) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts, env: { ...process.env, PATH } });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  let realSh;
  let iso;
  const BUMP = () => `n=$(cat '${path.join(dir, 'count')}' 2>/dev/null || echo 0); echo $((n + 1)) > '${path.join(dir, 'count')}'`;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-realsf-'));
    bin = path.join(dir, 'bin');
    empty = path.join(dir, 'empty');
    home = path.join(dir, 'home');
    for (const d of [bin, empty, home]) fs.mkdirSync(d);
    realSh = shWith(`${bin}:${process.env.PATH}`);
    iso = isolatedSh(realSh, { ...process.env, PATH: `${bin}:${process.env.PATH}` }, home, os.homedir());
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('kills the whole process group at the time limit', () => {
    const pidFile = path.join(dir, 'pid');
    writeSf(`sleep 600 &\necho $! > '${pidFile}'\nwait`);
    const started = Date.now();
    const r = runSf(realSh, ['data', 'query', '--target-org', 'acme-qa'], { timeoutMs: 2000 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r).toMatchObject({ ok: false, code: 'timeout', result: null, error: { name: 'SfTimeout', message: 'timed out after 2 s' } });
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  }, 20_000);

  it('stops at once on login rate exceeded, and never retries', () => {
    writeSf(`${BUMP()}\nwhile true; do echo 'login rate exceeded' >&2; sleep 0.2; done`);
    const started = Date.now();
    const r = runSf(iso, ['data', 'query', '--target-org', 'acme-qa'], { timeoutMs: 60_000 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r).toMatchObject({ ok: false, code: 'login-rate', result: null, error: { name: 'SfLoginRate' } });
    expect(r.error.message.startsWith('stopped at once:')).toBe(true);
    expect(count()).toBe(1);
  }, 20_000);

  it('then refuses that org for the cool-down, and lets other orgs and later calls through', () => {
    const refused = runSf(iso, ['data', 'query', '--target-org', 'acme-qa']);
    expect(refused).toMatchObject({ ok: false, code: 'cooldown', result: null, error: { name: 'SfCoolingDown' } });
    expect(refused.error.message).toMatch(/^Foreman makes no sf call to acme-qa until /);
    expect(count()).toBe(1);
    expect(runSf(iso, ['data', 'query', '--target-org', 'acme-dev1'], { timeoutMs: 60_000 }).code).toBe('login-rate');
    expect(count()).toBe(2);
    const later = Date.parse(coolingDown(home, 'acme-qa').until) + 1;
    expect(runSf(iso, ['data', 'query', '--target-org', 'acme-qa'], { timeoutMs: 60_000, now: later }).code).toBe('login-rate');
    expect(count()).toBe(3);
  }, 30_000);

  it('gives a success as before, with no code key', () => {
    writeSf(`echo '{"status":0,"result":{"ok":true}}'`);
    expect(runSf(realSh, ['data', 'query', '--target-org', 'acme-qa'])).toEqual({ ok: true, result: { ok: true }, error: null });
  }, 20_000);

  it('lets a success whose records hold a login phrase finish, with no cool-down', () => {
    writeSf(`echo '{"status":0,"result":{"records":[{"Name":"login rate exceeded"}]}}'; sleep 1; exit 0`);
    const r = runSf(iso, ['data', 'query', '--target-org', 'acme-dev2'], { timeoutMs: 60_000 });
    expect(r).toEqual({ ok: true, result: { records: [{ Name: 'login rate exceeded' }] }, error: null });
    expect(r).not.toHaveProperty('code');
    expect(fs.existsSync(cooldownFile(home, 'acme-dev2'))).toBe(false);
  }, 20_000);

  it('still stops at once on a login error sf printed as JSON on stdout', () => {
    writeSf(`echo '{"status":1,"name":"SfError","message":"login rate exceeded"}'; sleep 600`);
    const started = Date.now();
    const r = runSf(iso, ['data', 'query', '--target-org', 'acme-uat2'], { timeoutMs: 60_000 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r).toMatchObject({ ok: false, code: 'login-rate', result: null, error: { name: 'SfLoginRate' } });
    expect(fs.existsSync(cooldownFile(home, 'acme-uat2'))).toBe(true);
  }, 20_000);

  it('stops at once on an expired refresh token as real sf prints it', () => {
    const out = path.join(home, 'refresh-expired.json');
    fs.writeFileSync(out, JSON.stringify(REFRESH_EXPIRED));
    writeSf(`cat '${out}'; echo; sleep 600`);
    const started = Date.now();
    const r = runSf(iso, ['data', 'query', '--target-org', 'acme-uat3'], { timeoutMs: 60_000 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r).toMatchObject({ ok: false, code: 'auth', result: null, error: { name: 'SfAuthError' } });
    expect(fs.existsSync(cooldownFile(home, 'acme-uat3'))).toBe(false);
  }, 20_000);

  it('stops on repeated Invalid token as an auth error, with no cool-down', () => {
    writeSf(`for i in 1 2 3; do echo 'Invalid token' >&2; done\nsleep 600`);
    const started = Date.now();
    const r = runSf(iso, ['data', 'query', '--target-org', 'acme-uat'], { timeoutMs: 60_000 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r).toMatchObject({ ok: false, code: 'auth', result: null, error: { name: 'SfAuthError' } });
    expect(isNotSignedIn(r.error)).toBe(true);
    expect(fs.existsSync(cooldownFile(home, 'acme-uat'))).toBe(false);
  }, 20_000);

  it('still names a missing sf SfNotFound', () => {
    const r = runSf(shWith(empty), ['version']);
    expect(r).toMatchObject({ ok: false, error: { name: 'SfNotFound' } });
  }, 20_000);
});
