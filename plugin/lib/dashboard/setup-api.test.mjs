// The set-up API: GET /api/setup, POST /api/setup/keys, POST /api/setup/keys/test,
// POST /api/setup/keys/generate, POST /api/setup/keys/ignore and
// POST /api/setup/steps/<id>/check. A key's value goes in and never comes back out.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { createDashboardServer, fromThisComputer } from './server.mjs';
import { loadConfig } from '../config/load.mjs';
import { AREAS, STEPS } from '../setup/steps.mjs';
import { KEY_CARD } from '../setup/keys.mjs';
import { CRASH_SHOWN, writeCache } from '../setup/status.mjs';
import { SIGNIN } from '../setup/claude.mjs';
import { SELLING } from '../engine/claude-signin.mjs';
import { readSignIn, useSubscription } from '../engine/claude-fallback.mjs';
import { doctorContext } from '../cli/commands/doctor.mjs';
import { buildChecks } from '../engine/doctor-checks.mjs';

const TOKEN = 'acme-dashboard-token-0123456789abcdef';
const NOW = '2026-10-24T09:00:00.000Z';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BASE = { version: 1, project: { name: 'Acme' }, slots: 2, checks: [{ run: 'true', when: 'always' }], notify: { adapter: 'email-resend' } };

let dir;
let state;
let servers;
let resend;
let SENTINEL;

const ownFile = () => join(dir, '.env.foreman');
const recordFile = () => join(state, 'setup.json');
const record = () => JSON.parse(readFileSync(recordFile(), 'utf8'));

function project(extra = {}) {
  writeFileSync(join(dir, 'foreman.config.json'), `${JSON.stringify({ ...BASE, ...extra }, null, 2)}\n`);
  return loadConfig(dir).config;
}

async function start({ host = '127.0.0.1', env = {}, config = project(), now = () => new Date(NOW), ...rest } = {}) {
  const cfg = { ...config, console: { ...config.console, host } };
  const server = createDashboardServer({ root: dir, config: cfg, stateDir: state, env, now, keyBase: { resend: resend.url }, keyTimeoutMs: 3000, ...rest });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, host, resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

// A fake Resend: it records the Authorization header it is sent, and answers `status`; a
// refusal repeats the key it was given, so a leak through the detail would show.
function fakeResend() {
  const fake = { seen: [], status: 401, url: '' };
  fake.server = createServer((req, res) => {
    const auth = String(req.headers.authorization ?? '');
    fake.seen.push(auth);
    const body = fake.status === 200 ? { data: [] } : { name: 'validation_error', message: `API key is invalid: ${auth.replace(/^Bearer /, '')}` };
    res.writeHead(fake.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve) => fake.server.listen(0, '127.0.0.1', () => {
    fake.url = `http://127.0.0.1:${fake.server.address().port}`;
    resolve(fake);
  }));
}

const post = (url, body, headers = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const getJson = async (url, headers = {}) => (await fetch(url, { headers })).json();

// A request whose path and headers go out exactly as written.
function raw(base, path, { method = 'GET', headers = {}, body } = {}) {
  const { port } = new URL(base);
  const sent = body === undefined ? {} : { 'content-length': Buffer.byteLength(body) };
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers: { ...sent, ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// Every file under a folder, recursively.
function walk(folder) {
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(folder, e.name)) : [join(folder, e.name)]));
}

const leaks = (text) => String(text).includes(SENTINEL) || String(text).includes(SENTINEL.slice(0, 20));
const keyRow = (body, name) => body.steps.flatMap((s) => s.keys).find((k) => k.name === name);
const stepOf = (body, id) => body.steps.find((s) => s.id === id);

// Doctor checks for three steps, each counting its runs; the env check's failure counts against
// notifications. `gate`, when given, holds the GitHub check until it resolves; `gh`, when given,
// is what the GitHub check does once it runs.
function fakeDoctor(config, { gate, gh } = {}) {
  const runs = { config: 0, gh: 0, env: 0 };
  let started;
  const begun = new Promise((resolve) => { started = resolve; });
  const checks = [
    { name: 'config', step: 'project', run: () => { runs.config += 1; return { ok: true, level: 'error', detail: '' }; } },
    {
      name: 'gh signed in',
      step: 'github',
      run: async () => {
        runs.gh += 1;
        started();
        if (gate) await gate;
        if (gh) return gh();
        return { ok: true, level: 'error', detail: '' };
      },
    },
    {
      name: 'env variables',
      step: 'project-keys',
      run: () => {
        runs.env += 1;
        return { ok: false, level: 'error', detail: 'RESEND_API_KEY is not set', fix: { step: 'notifications', hint: 'add RESEND_API_KEY' } };
      },
    },
  ];
  return { runs, begun, calls: 0, doctor() { this.calls += 1; return Promise.resolve({ config, ctx: {}, checks }); } };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'foreman-setup-api-'));
  state = join(dir, '.foreman');
  servers = [];
  spawnSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, '.gitignore'), '.env.foreman\n.env.local\n');
  resend = await fakeResend();
  SENTINEL = `re_SENTINEL${randomBytes(16).toString('hex')}`;
});
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((resolve) => (s.listening ? s.close(() => resolve()) : resolve()))));
  await new Promise((resolve) => resend.server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/setup', () => {
  it('lists every step, skipped ones too, with its status, keys and times, and runs no check', async () => {
    const fake = fakeDoctor(project());
    const base = await start({ doctor: () => fake.doctor() });
    const res = await fetch(`${base}/api/setup`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body.canChangeKeys).toBe(true);
    expect(body.checkedAt).toBeNull();
    expect(body.steps.map((s) => s.id)).toEqual(STEPS.map((s) => s.id));
    expect(stepOf(body, 'jira-site')).toMatchObject({ applies: false, status: 'skipped' });
    expect(stepOf(body, 'notifications')).toMatchObject({ applies: true, status: 'needs-you', results: [], checkedAt: null, confirmedAt: null });
    expect(keyRow(body, 'RESEND_API_KEY')).toEqual({
      name: 'RESEND_API_KEY',
      label: 'Resend API key',
      set: false,
      masked: null,
      source: null,
      file: '.env.foreman',
      testable: true,
      testLabel: 'Test it',
      generate: false,
      ignored: true,
    });
    expect(fake.calls).toBe(0);
    expect(walk(state)).toEqual([]);
  });

  it('carries the areas from the model, and no address on GitHub', async () => {
    const base = await start();
    const body = await getJson(`${base}/api/setup`);
    expect(body.areas).toEqual(AREAS);
    expect('readme' in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain('github.com');
  });
});

describe('GET /api/setup key rows', () => {
  it('puts the dashboard token on Project keys, as one Foreman can make', async () => {
    const body = await getJson(`${await start()}/api/setup`);
    const row = stepOf(body, 'project-keys').keys.find((k) => k.name === 'FOREMAN_DASHBOARD_TOKEN');
    expect(row).toMatchObject({ name: 'FOREMAN_DASHBOARD_TOKEN', set: false, source: null, file: '.env.foreman', generate: true, ignored: true });
  });

  it("carries the key card's words, from the model", async () => {
    const body = await getJson(`${await start()}/api/setup`);
    expect(body.keyCard).toEqual(KEY_CARD);
  });

  it('says when git does not ignore the key file', async () => {
    writeFileSync(join(dir, '.gitignore'), '.env.local\n');
    const body = await getJson(`${await start()}/api/setup`);
    expect(keyRow(body, 'RESEND_API_KEY').ignored).toBe(false);
  });
});

describe('POST /api/setup/keys/generate', () => {
  const NAME = 'FOREMAN_DASHBOARD_TOKEN';
  const saved = () => parseEnv(readFileSync(ownFile(), 'utf8'))[NAME];

  it('writes a new dashboard token to .env.foreman and never answers it', async () => {
    const base = await start();
    const res = await post(`${base}/api/setup/keys/generate`, { name: NAME });
    const text = await res.text();
    expect(res.status, text).toBe(200);
    const made = saved();
    expect(typeof made).toBe('string');
    expect(made.length).toBeGreaterThanOrEqual(32);
    expect(statSync(ownFile()).mode & 0o777).toBe(0o600);
    const body = JSON.parse(text);
    expect(body.ok).toBe(true);
    expect(body.lines).toEqual([`set ${NAME} in .env.foreman`]);
    expect(body.key).toMatchObject({ name: NAME, set: true, source: 'file', masked: `•••• ${made.slice(-4)}`, generate: true });
    const shows = (t) => String(t).includes(made) || String(t).includes(made.slice(0, 20));
    expect(shows(text)).toBe(false);
    for (const path of ['/api/setup', '/api/status', '/api/settings', '/api/waiting', '/api/help']) {
      const got = await fetch(`${base}${path}`);
      const answer = await got.text();
      expect(got.status, path).toBe(200);
      expect(shows(answer), path).toBe(false);
    }
    for (const file of walk(state)) expect(shows(readFileSync(file, 'utf8')), file).toBe(false);

    expect((await post(`${base}/api/setup/keys/generate`, { name: NAME })).status).toBe(200);
    expect(saved()).not.toBe(made);
  });

  it('adds .env.foreman to .gitignore first when git does not ignore it', async () => {
    writeFileSync(join(dir, '.gitignore'), '.env.local\n');
    const base = await start();
    const res = await post(`${base}/api/setup/keys/generate`, { name: NAME });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lines[0]).toBe('added .env.foreman to .gitignore');
    expect(body.lines).toEqual(['added .env.foreman to .gitignore', `set ${NAME} in .env.foreman`]);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('.env.local\n.env.foreman\n');
    expect(saved().length).toBeGreaterThanOrEqual(32);
  });

  it('refuses a key Foreman does not make, and writes nothing', async () => {
    const base = await start();
    const res = await post(`${base}/api/setup/keys/generate`, { name: 'RESEND_API_KEY' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Foreman does not make RESEND_API_KEY; it comes from its service');
    expect(existsSync(ownFile())).toBe(false);
  });

  it('refuses a name Foreman does not know without repeating it', async () => {
    const base = await start();
    for (const body of [{ name: 'NOT_A_KEY' }, { name: 42 }, {}, { name: '__proto__' }]) {
      const res = await post(`${base}/api/setup/keys/generate`, body);
      const text = await res.text();
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(JSON.parse(text).error).toBe('Foreman does not know that key.');
      expect(text).not.toContain('NOT_A_KEY');
    }
    expect(existsSync(ownFile())).toBe(false);
  });

  it('refuses a token set in the environment with 409', async () => {
    const base = await start({ env: { [NAME]: TOKEN } });
    const res = await post(`${base}/api/setup/keys/generate`, { name: NAME });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/set outside Foreman/);
    expect(existsSync(ownFile())).toBe(false);
  });

  it('refuses on a dashboard other computers can reach, even with the token', async () => {
    const base = await start({ host: '0.0.0.0', env: { FOREMAN_DASHBOARD_TOKEN: TOKEN } });
    const res = await post(`${base}/api/setup/keys/generate`, { name: NAME }, { authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(
      'Keys can be saved and tested only on a dashboard that listens on this computer alone (127.0.0.1). To use it from another machine, open it through an SSH tunnel.',
    );
    expect(existsSync(ownFile())).toBe(false);
  });
});

describe('POST /api/setup/keys/ignore', () => {
  it('adds the key file to .gitignore, then says git already ignores it', async () => {
    writeFileSync(join(dir, '.gitignore'), '.env.local\n');
    const base = await start();
    let res = await post(`${base}/api/setup/keys/ignore`, { name: 'RESEND_API_KEY' });
    expect(res.status).toBe(200);
    let body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.lines).toEqual(['added .env.foreman to .gitignore']);
    expect(body.key).toMatchObject({ name: 'RESEND_API_KEY', ignored: true });
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('.env.local\n.env.foreman\n');
    res = await post(`${base}/api/setup/keys/ignore`, { name: 'RESEND_API_KEY' });
    body = await res.json();
    expect(res.status).toBe(200);
    expect(body.lines).toEqual(['git already ignores .env.foreman']);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('.env.local\n.env.foreman\n');
    expect(existsSync(ownFile())).toBe(false);
  });

  it('refuses a name Foreman does not know without repeating it, and another host', async () => {
    writeFileSync(join(dir, '.gitignore'), '.env.local\n');
    const base = await start();
    const res = await post(`${base}/api/setup/keys/ignore`, { name: 'NOT_A_KEY' });
    const text = await res.text();
    expect(res.status).toBe(400);
    expect(JSON.parse(text).error).toBe('Foreman does not know that key.');
    expect(text).not.toContain('NOT_A_KEY');
    const remote = await start({ host: '0.0.0.0', env: { FOREMAN_DASHBOARD_TOKEN: TOKEN } });
    const refused = await post(`${remote}/api/setup/keys/ignore`, { name: 'RESEND_API_KEY' }, { authorization: `Bearer ${TOKEN}` });
    expect(refused.status).toBe(403);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('.env.local\n');
  });
});

describe('a key value never leaks', () => {
  it('is saved to .env.foreman, used for the test, and absent from every answer and file', async () => {
    const base = await start();
    let res = await post(`${base}/api/setup/keys`, { name: 'RESEND_API_KEY', value: SENTINEL });
    let text = await res.text();
    expect(res.status, text).toBe(200);
    expect(leaks(text)).toBe(false);
    const saved = JSON.parse(text);
    expect(saved.ok).toBe(true);
    expect(saved.lines).toEqual(['set RESEND_API_KEY in .env.foreman']);
    expect(saved.key).toMatchObject({ name: 'RESEND_API_KEY', set: true, masked: `•••• ${SENTINEL.slice(-4)}`, source: 'file', file: '.env.foreman' });
    expect(parseEnv(readFileSync(ownFile(), 'utf8')).RESEND_API_KEY).toBe(SENTINEL);
    expect(statSync(ownFile()).mode & 0o777).toBe(0o600);

    for (const path of ['/api/setup', '/api/status', '/api/settings', '/api/waiting', '/api/help']) {
      const got = await fetch(`${base}${path}`);
      const body = await got.text();
      expect(got.status, path).toBe(200);
      expect(leaks(body), path).toBe(false);
    }
    const setup = await getJson(`${base}/api/setup`);
    expect(keyRow(setup, 'RESEND_API_KEY')).toMatchObject({ set: true, masked: `•••• ${SENTINEL.slice(-4)}`, source: 'file' });

    res = await post(`${base}/api/setup/keys/test`, { name: 'RESEND_API_KEY' });
    text = await res.text();
    expect(res.status, text).toBe(200);
    expect(leaks(text)).toBe(false);
    const tested = JSON.parse(text);
    expect(tested).toMatchObject({ ok: true, name: 'RESEND_API_KEY', result: { ok: false } });
    expect(resend.seen).toEqual([`Bearer ${SENTINEL}`]);
    // Resend refused the key, so nothing is confirmed.
    expect(record().steps.notifications?.confirmedAt).toBeUndefined();
    expect(stepOf(await getJson(`${base}/api/setup`), 'notifications').confirmedAt).toBeNull();

    for (const file of walk(state)) expect(leaks(readFileSync(file, 'utf8')), file).toBe(false);

    const rec = record();
    expect(Object.keys(rec).sort()).toEqual(['steps', 'version']);
    for (const [id, entry] of Object.entries(rec.steps)) {
      expect(STEPS.some((s) => s.id === id), id).toBe(true);
      for (const [field, value] of Object.entries(entry)) {
        expect(['checkedAt', 'confirmedAt', 'runs'], field).toContain(field);
        for (const time of field === 'runs' ? value : [value]) expect(time).toMatch(ISO);
      }
    }
  });

  it('is not in the first event frame opened after the save', async () => {
    const base = await start();
    expect((await post(`${base}/api/setup/keys`, { name: 'RESEND_API_KEY', value: SENTINEL })).status).toBe(200);
    const res = await fetch(`${base}/api/events`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (!buffer.includes('\n\n')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
    }
    await reader.cancel().catch(() => {});
    expect(buffer).toMatch(/^event: status\ndata: /);
    expect(leaks(buffer)).toBe(false);
  });
});

describe('POST /api/setup/keys', () => {
  it('removes a key', async () => {
    const base = await start();
    await post(`${base}/api/setup/keys`, { name: 'RESEND_API_KEY', value: SENTINEL });
    const res = await post(`${base}/api/setup/keys`, { name: 'RESEND_API_KEY', remove: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lines).toEqual(['removed RESEND_API_KEY from .env.foreman']);
    expect(body.key).toMatchObject({ set: false, masked: null, source: null });
    expect(keyRow(await getJson(`${base}/api/setup`), 'RESEND_API_KEY').set).toBe(false);
    expect(readFileSync(ownFile(), 'utf8')).not.toContain(SENTINEL);
    const again = await (await post(`${base}/api/setup/keys`, { name: 'RESEND_API_KEY', remove: true })).json();
    expect(again.lines).toEqual(['RESEND_API_KEY is not in .env.foreman']);
  });

  it('keeps .env.foreman at mode 600 after every step: save, replace, generate and remove', async () => {
    writeFileSync(ownFile(), '# mine\n', { mode: 0o644 });
    expect(statSync(ownFile()).mode & 0o777).toBe(0o644);
    const base = await start();
    const second = `re_SECOND${randomBytes(16).toString('hex')}`;
    const steps = [
      ['save', '/api/setup/keys', { name: 'RESEND_API_KEY', value: SENTINEL }],
      ['replace', '/api/setup/keys', { name: 'RESEND_API_KEY', value: second }],
      ['generate', '/api/setup/keys/generate', { name: 'FOREMAN_DASHBOARD_TOKEN' }],
      ['remove', '/api/setup/keys', { name: 'RESEND_API_KEY', remove: true }],
    ];
    for (const [step, path, body] of steps) {
      const res = await post(`${base}${path}`, body);
      expect(res.status, `${step}: ${await res.text()}`).toBe(200);
      expect(statSync(ownFile()).mode & 0o777, step).toBe(0o600);
    }
    const env = parseEnv(readFileSync(ownFile(), 'utf8'));
    expect(env.RESEND_API_KEY).toBeUndefined();
    expect(typeof env.FOREMAN_DASHBOARD_TOKEN).toBe('string');
  });

  it('adds .env.foreman to .gitignore when git does not ignore it, as the CLI does', async () => {
    writeFileSync(join(dir, '.gitignore'), '.env.local\n');
    const base = await start();
    const res = await post(`${base}/api/setup/keys`, { name: 'RESEND_API_KEY', value: SENTINEL });
    expect(res.status).toBe(200);
    expect((await res.json()).lines).toEqual(['added .env.foreman to .gitignore', 'set RESEND_API_KEY in .env.foreman']);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('.env.local\n.env.foreman\n');
    expect(readFileSync(ownFile(), 'utf8')).toContain(SENTINEL);
  });

  it('refuses with 409 when git tracks .env.foreman, writes nothing and answers no value', async () => {
    writeFileSync(ownFile(), '# mine\n');
    expect(spawnSync('git', ['add', '-f', '.env.foreman'], { cwd: dir }).status).toBe(0);
    const base = await start();
    const res = await post(`${base}/api/setup/keys`, { name: 'RESEND_API_KEY', value: SENTINEL });
    const text = await res.text();
    expect(res.status, text).toBe(409);
    expect(JSON.parse(text).error).toBe('.env.foreman is tracked by git, so nothing was written; remove it from the index first (git rm --cached .env.foreman)');
    expect(leaks(text)).toBe(false);
    expect(readFileSync(ownFile(), 'utf8')).toBe('# mine\n');
  });

  it('refuses a value of the wrong shape and writes nothing', async () => {
    const base = await start();
    const res = await post(`${base}/api/setup/keys`, { name: 'RESEND_API_KEY', value: 'abc' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('This does not look like a Resend API key: it starts with re_.');
    expect(existsSync(ownFile())).toBe(false);
  });

  it('refuses a name Foreman does not know without repeating it', async () => {
    const base = await start();
    for (const body of [{ name: 'NOT_A_KEY', value: 'abc' }, { name: 42, value: 'abc' }, { value: 'abc' }, { name: '__proto__', remove: true }]) {
      for (const path of ['/api/setup/keys', '/api/setup/keys/test']) {
        const res = await post(`${base}${path}`, body);
        const text = await res.text();
        expect(res.status, `${path} ${JSON.stringify(body)}`).toBe(400);
        expect(JSON.parse(text).error).toBe('Foreman does not know that key.');
        expect(text).not.toContain('NOT_A_KEY');
      }
    }
    expect(existsSync(ownFile())).toBe(false);
    expect(existsSync(join(dir, '.env.local'))).toBe(false);
  });

  it('refuses a key set in the environment with 409, and a body that is not one value or one remove', async () => {
    const base = await start({ env: { RESEND_API_KEY: `re_${'e'.repeat(30)}` } });
    let res = await post(`${base}/api/setup/keys`, { name: 'RESEND_API_KEY', value: SENTINEL });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/set outside Foreman/);
    res = await post(`${base}/api/setup/keys`, { name: 'RESEND_API_KEY', remove: true });
    expect(res.status).toBe(409);
    for (const body of [
      { name: 'RESEND_FROM_EMAIL', value: 'team@acme.example', remove: true },
      { name: 'RESEND_FROM_EMAIL' },
      { name: 'RESEND_FROM_EMAIL', value: 7 },
      { name: 'RESEND_FROM_EMAIL', remove: 'yes' },
    ]) {
      res = await post(`${base}/api/setup/keys`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).error).toBe("Send the key's value, or remove: true.");
    }
    expect(existsSync(ownFile())).toBe(false);
  });

  it('takes a key the project asks for only when its step applies, into the project env file', async () => {
    const plain = await start();
    expect((await post(`${plain}/api/setup/keys`, { name: 'SUPABASE_ACCESS_TOKEN', value: 'sbp_acme-fake' })).status).toBe(400);
    const base = await start({ config: project({ ship: { steps: ['merge-main', 'migrate-supabase', 'push'] } }) });
    const res = await post(`${base}/api/setup/keys`, { name: 'SUPABASE_ACCESS_TOKEN', value: 'sbp_acme-fake' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lines).toEqual(['set SUPABASE_ACCESS_TOKEN in .env.local']);
    expect(body.key).toMatchObject({ name: 'SUPABASE_ACCESS_TOKEN', set: true, file: '.env.local', testable: false });
    expect(parseEnv(readFileSync(join(dir, '.env.local'), 'utf8')).SUPABASE_ACCESS_TOKEN).toBe('sbp_acme-fake');
  });

  it('refuses to save or test keys on a dashboard other computers can reach, in plain words', async () => {
    const base = await start({ host: '0.0.0.0', env: { FOREMAN_DASHBOARD_TOKEN: TOKEN } });
    const auth = { authorization: `Bearer ${TOKEN}` };
    const got = await fetch(`${base}/api/setup`, { headers: auth });
    expect(got.status).toBe(200);
    expect((await got.json()).canChangeKeys).toBe(false);
    for (const [path, body] of [['/api/setup/keys', { name: 'RESEND_API_KEY', value: SENTINEL }], ['/api/setup/keys/test', { name: 'RESEND_API_KEY' }]]) {
      const res = await post(`${base}${path}`, body, auth);
      expect(res.status, path).toBe(403);
      expect((await res.json()).error).toBe(
        'Keys can be saved and tested only on a dashboard that listens on this computer alone (127.0.0.1). To use it from another machine, open it through an SSH tunnel.',
      );
    }
    expect(existsSync(ownFile())).toBe(false);
    expect(resend.seen).toEqual([]);
  });
});

describe('fromThisComputer', () => {
  const req = (remoteAddress) => ({ socket: { remoteAddress } });

  it('allows a loopback request on a loopback-only dashboard', () => {
    for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) expect(fromThisComputer(req(addr), true), addr).toBe(true);
  });

  it('refuses a request from another computer, even on a loopback-only dashboard', () => {
    for (const addr of ['10.0.0.5', '::ffff:10.0.0.5']) expect(fromThisComputer(req(addr), true), addr).toBe(false);
  });

  it('refuses a request with no address', () => {
    expect(fromThisComputer({}, true)).toBe(false);
    expect(fromThisComputer(req(undefined), true)).toBe(false);
  });

  it('refuses everything on a dashboard other computers can reach', () => {
    expect(fromThisComputer(req('127.0.0.1'), false)).toBe(false);
  });
});

describe('every set-up route keeps the dashboard gates', () => {
  const ROUTES = [
    { path: '/api/setup', method: 'GET', wrong: 'POST', allow: 'GET' },
    { path: '/api/setup/keys', method: 'POST', body: () => ({ name: 'RESEND_API_KEY', value: SENTINEL }), wrong: 'GET', allow: 'POST' },
    { path: '/api/setup/keys/test', method: 'POST', body: () => ({ name: 'RESEND_API_KEY' }), wrong: 'GET', allow: 'POST' },
    { path: '/api/setup/keys/generate', method: 'POST', body: () => ({ name: 'FOREMAN_DASHBOARD_TOKEN' }), wrong: 'GET', allow: 'POST' },
    { path: '/api/setup/keys/ignore', method: 'POST', body: () => ({ name: 'RESEND_API_KEY' }), wrong: 'GET', allow: 'POST' },
    { path: '/api/setup/steps/github/check', method: 'POST', body: () => ({}), wrong: 'GET', allow: 'POST' },
  ];
  const send = (base, route, headers = {}, body) =>
    raw(base, route.path, {
      method: route.method,
      headers: route.method === 'POST' ? { 'content-type': 'application/json', ...headers } : headers,
      body: route.method === 'POST' ? (body ?? JSON.stringify(route.body())) : undefined,
    });
  const untouched = () => {
    expect(walk(state)).toEqual([]);
    expect(existsSync(ownFile())).toBe(false);
  };

  it('needs the token on another host', async () => {
    const fake = fakeDoctor(project());
    const base = await start({ host: '0.0.0.0', env: { FOREMAN_DASHBOARD_TOKEN: TOKEN }, doctor: () => fake.doctor() });
    for (const route of ROUTES) {
      const res = await send(base, route);
      expect(res.status, route.path).toBe(401);
      expect(res.headers['www-authenticate'], route.path).toBe('Bearer');
    }
    expect(fake.calls).toBe(0);
    untouched();
  });

  it('refuses another Host on 127.0.0.1, another origin, plain text, a big body and the wrong method', async () => {
    const fake = fakeDoctor(project());
    const base = await start({ doctor: () => fake.doctor() });
    for (const route of ROUTES) {
      expect((await send(base, route, { host: 'evil.example' })).status, `${route.path} host`).toBe(403);
      expect((await send(base, route, { origin: 'https://evil.example' })).status, `${route.path} origin`).toBe(403);
      if (route.method === 'POST') {
        expect((await send(base, route, { 'content-type': 'text/plain' })).status, `${route.path} text`).toBe(415);
        const big = JSON.stringify({ ...route.body(), pad: 'x'.repeat(70 * 1024) });
        expect((await send(base, route, {}, big)).status, `${route.path} big`).toBe(413);
      }
      const wrong = await raw(base, route.path, { method: route.wrong });
      expect(wrong.status, `${route.path} method`).toBe(405);
      expect(wrong.headers.allow, `${route.path} allow`).toBe(route.allow);
    }
    expect(fake.calls).toBe(0);
    untouched();
  });
});

describe('POST /api/setup/steps/<id>/check', () => {
  it("runs only that step's checks, caches the result and records the time", async () => {
    const config = project();
    const fake = fakeDoctor(config);
    const base = await start({ config, doctor: () => fake.doctor() });
    const res = await post(`${base}/api/setup/steps/github/check`, {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(fake.runs).toEqual({ config: 0, gh: 1, env: 0 });
    expect(body.ok).toBe(true);
    expect(body.step).toMatchObject({
      id: 'github',
      status: 'done',
      checkedAt: NOW,
      confirmedAt: NOW,
      results: [{ name: 'gh signed in', step: 'github', ok: true, checkedAt: NOW }],
      keys: [],
    });
    const cache = JSON.parse(readFileSync(join(state, 'setup-checks.json'), 'utf8'));
    expect(Object.keys(cache.results)).toEqual(['gh signed in']);
    expect(record().steps.github).toMatchObject({ checkedAt: NOW, confirmedAt: NOW });

    // The cached results of other checks still count: the env check's failure against notifications.
    await post(`${base}/api/setup/steps/project-keys/check`, {});
    const after = await getJson(`${base}/api/setup`);
    expect(stepOf(after, 'github')).toMatchObject({ status: 'done', checkedAt: NOW });
    expect(stepOf(after, 'notifications').results.map((r) => r.name)).toEqual(['env variables']);
    expect(after.checkedAt).toBe(NOW);
  });

  it('a cached result of a check the doctor no longer has stops counting', async () => {
    const config = project();
    const fake = fakeDoctor(config);
    writeCache(state, [{ name: 'acme retired check', step: 'github', ok: false, level: 'error', detail: 'acme check that is gone', checkedAt: NOW }]);
    const base = await start({ config, doctor: () => fake.doctor() });
    const res = await post(`${base}/api/setup/steps/github/check`, {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.step.status).toBe('done');
    expect(body.step.results.map((r) => r.name)).toEqual(['gh signed in']);
    expect(JSON.parse(readFileSync(join(state, 'setup-checks.json'), 'utf8')).results).not.toHaveProperty('acme retired check');
    const after = await getJson(`${base}/api/setup`);
    expect(stepOf(after, 'github').status).toBe('done');
    expect(stepOf(after, 'github').results.map((r) => r.name)).toEqual(['gh signed in']);
  });

  it('also re-runs a cached check whose fix names the step', async () => {
    const config = project();
    const fake = fakeDoctor(config);
    const base = await start({ config, doctor: () => fake.doctor() });
    expect((await post(`${base}/api/setup/steps/project-keys/check`, {})).status).toBe(200);
    expect(fake.runs.env).toBe(1);
    const res = await post(`${base}/api/setup/steps/notifications/check`, {});
    expect(res.status).toBe(200);
    expect(fake.runs).toEqual({ config: 0, gh: 0, env: 2 });
    const body = await res.json();
    expect(body.step.results.find((r) => r.name === 'env variables')).toMatchObject({ step: 'project-keys', checkedAt: NOW });
  });

  it("records checkedAt but not confirmedAt when the step's check fails", async () => {
    const config = project();
    const fake = fakeDoctor(config, { gh: () => ({ ok: false, level: 'error', detail: 'gh is not signed in' }) });
    const base = await start({ config, doctor: () => fake.doctor() });
    const res = await post(`${base}/api/setup/steps/github/check`, {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.step.status).toBe('broken');
    expect(body.step.confirmedAt).toBeNull();
    expect(record().steps.github.checkedAt).toBe(NOW);
    expect(record().steps.github.confirmedAt).toBeUndefined();
  });

  it("never sends a crashed check's message", async () => {
    const config = project();
    const fake = fakeDoctor(config, { gh: () => { throw new Error('spawn /home/acme/private/gh ENOENT'); } });
    const base = await start({ config, doctor: () => fake.doctor() });
    const res = await post(`${base}/api/setup/steps/github/check`, {});
    const text = await res.text();
    expect(res.status, text).toBe(200);
    expect(text).not.toContain('/home/acme');
    const body = JSON.parse(text);
    expect(body.step.results[0].detail).toBe(CRASH_SHOWN);
    expect(body.step.status).toBe('broken');
    expect(body.step.confirmedAt).toBeNull();

    const got = await fetch(`${base}/api/setup`);
    const setupText = await got.text();
    expect(got.status).toBe(200);
    expect(setupText).not.toContain('/home/acme');
    expect(stepOf(JSON.parse(setupText), 'github').results.find((r) => r.name === 'gh signed in').detail).toBe(CRASH_SHOWN);

    // The cache, which the CLI reads, keeps the raw detail.
    const cache = JSON.parse(readFileSync(join(state, 'setup-checks.json'), 'utf8'));
    expect(cache.results['gh signed in'].detail.startsWith('the check crashed: spawn /home/acme')).toBe(true);
  });

  it("runs the doctor's real checks when none are injected", async () => {
    const base = await start();
    const res = await post(`${base}/api/setup/steps/project/check`, {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.step.id).toBe('project');
    expect(body.step.results.find((r) => r.name === 'config')).toMatchObject({ ok: true, step: 'project' });
  });

  it('answers 404 for an id the model does not have, without repeating it, and 400 for a step that does not apply', async () => {
    const fake = fakeDoctor(project());
    const base = await start({ doctor: () => fake.doctor() });
    for (const id of ['nope', '..%2F..%2Fx', '%E0%A4%A', '__proto__', 'constructor']) {
      const res = await raw(base, `/api/setup/steps/${id}/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(res.status, id).toBe(404);
      expect(JSON.parse(res.body).error).toBe('No set-up step has that id.');
      expect(res.body).not.toContain(id.slice(0, 4));
    }
    expect(walk(state)).toEqual([]);
    const res = await post(`${base}/api/setup/steps/jira-site/check`, {});
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("That step is not part of this project's set-up.");
    expect(fake.calls).toBe(0);
    expect(walk(state)).toEqual([]);
  });
});

describe('the per-step limit', () => {
  it('refuses the 6th check in a minute with 429 and a retry time, and lets it through later', async () => {
    let clock = Date.parse(NOW);
    const config = project();
    const fake = fakeDoctor(config);
    const base = await start({ config, now: () => new Date(clock), doctor: () => fake.doctor() });
    for (let i = 0; i < 5; i += 1) {
      expect((await post(`${base}/api/setup/steps/github/check`, {})).status, `check ${i + 1}`).toBe(200);
      clock += 1000;
    }
    const res = await post(`${base}/api/setup/steps/github/check`, {});
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.retryAfter).toBe(55);
    expect(res.headers.get('retry-after')).toBe('55');
    expect(body.error).toBe('Too many tries for this step. Try again in 55 seconds.');
    expect(fake.runs.gh).toBe(5);
    expect((await post(`${base}/api/setup/steps/project/check`, {})).status).toBe(200);
    clock += 61_000;
    expect((await post(`${base}/api/setup/steps/github/check`, {})).status).toBe(200);
  });

  it('counts key tests against their step', async () => {
    const config = project();
    const fake = fakeDoctor(config);
    const base = await start({ config, doctor: () => fake.doctor() });
    await post(`${base}/api/setup/keys`, { name: 'RESEND_API_KEY', value: SENTINEL });
    for (let i = 0; i < 5; i += 1) expect((await post(`${base}/api/setup/keys/test`, { name: 'RESEND_API_KEY' })).status, `test ${i + 1}`).toBe(200);
    const sixth = await post(`${base}/api/setup/keys/test`, { name: 'RESEND_API_KEY' });
    expect(sixth.status).toBe(429);
    const res = await post(`${base}/api/setup/steps/notifications/check`, {});
    expect(res.status).toBe(429);
    expect(typeof (await res.json()).retryAfter).toBe('number');
    expect(resend.seen).toHaveLength(5);
  });

  it('checks a step one at a time', async () => {
    const config = project();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const fake = fakeDoctor(config, { gate });
    const base = await start({ config, doctor: () => fake.doctor() });
    const first = post(`${base}/api/setup/steps/github/check`, {});
    await fake.begun;
    const second = await post(`${base}/api/setup/steps/github/check`, {});
    expect(second.status).toBe(429);
    const body = await second.json();
    expect(body).toEqual({ error: 'This step is being checked already. Try again in a moment.', retryAfter: 1 });
    expect(second.headers.get('retry-after')).toBe('1');
    release();
    expect((await first).status).toBe(200);
    expect((await post(`${base}/api/setup/steps/github/check`, {})).status).toBe(200);
    expect(fake.runs.gh).toBe(2);
  });
});

describe('POST /api/setup/keys/test', () => {
  it('records the confirmation when the service takes the key', async () => {
    resend.status = 200;
    const base = await start();
    await post(`${base}/api/setup/keys`, { name: 'RESEND_API_KEY', value: SENTINEL });
    const res = await post(`${base}/api/setup/keys/test`, { name: 'RESEND_API_KEY' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: 'RESEND_API_KEY', result: { ok: true, detail: 'Resend accepted the key' } });
    expect(record().steps.notifications.confirmedAt).toBe(NOW);
    expect(stepOf(await getJson(`${base}/api/setup`), 'notifications').confirmedAt).toBe(NOW);
  });

  it('answers 400 for a key that is not set, and asks nobody', async () => {
    const base = await start();
    const res = await post(`${base}/api/setup/keys/test`, { name: 'RESEND_API_KEY' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('That key is not set.');
    expect(resend.seen).toEqual([]);
  });
});

// A fake Anthropic: it records the path and the x-api-key it is sent, and answers `status`; a
// refusal repeats the key it was given, so a leak through the detail would show.
function fakeAnthropic() {
  const fake = { seen: [], status: 401, url: '' };
  fake.server = createServer((req, res) => {
    const key = String(req.headers['x-api-key'] ?? '');
    fake.seen.push({ path: req.url, key });
    const body = fake.status === 200 ? { data: [{ id: 'claude-acme' }] } : { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key: ${key}` } };
    res.writeHead(fake.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve) => fake.server.listen(0, '127.0.0.1', () => {
    fake.url = `http://127.0.0.1:${fake.server.address().port}`;
    resolve(fake);
  }));
}

describe('the Claude sign-in step', () => {
  const API = () => `sk-ant-api03-ACME${SENTINEL.slice(11)}`;
  const OAT = () => `sk-ant-oat01-ACME${SENTINEL.slice(11)}`;
  const signin = (body) => stepOf(body, 'claude-signin');
  // Either value, or the random part they share.
  const shows = (text) => String(text).includes(SENTINEL.slice(11));
  const ownKeys = (lines) => writeFileSync(ownFile(), `${lines.join('\n')}\n`, { mode: 0o600 });

  let anthropic;
  beforeEach(async () => {
    anthropic = await fakeAnthropic();
  });
  afterEach(async () => {
    await new Promise((resolve) => anthropic.server.close(() => resolve()));
  });

  it.each([
    { name: 'API key in the file', env: {}, file: ['api'], sources: ['file', null], uses: 'api-key', says: ['saved in .env.foreman'] },
    { name: 'API key in the environment', env: { api: true }, file: [], sources: ['environment', null], uses: 'api-key', says: ['set in the environment'] },
    { name: 'token in the file', env: {}, file: ['oat'], sources: [null, 'file'], uses: 'subscription', says: ['saved in .env.foreman', SELLING] },
    { name: 'token in the environment', env: { oat: true }, file: [], sources: [null, 'environment'], uses: 'subscription', says: ['set in the environment', SELLING] },
    { name: 'API key in the environment, token in the file', env: { api: true }, file: ['oat'], sources: ['environment', 'file'], uses: 'api-key', says: ['set in the environment', 'API key wins'] },
    { name: 'token in the environment, API key in the file', env: { oat: true }, file: ['api'], sources: ['file', 'environment'], uses: 'api-key', says: ['saved in .env.foreman', 'API key wins'] },
    { name: 'both in the file', env: {}, file: ['api', 'oat'], sources: ['file', 'file'], uses: 'api-key', says: ['saved in .env.foreman', 'API key wins'] },
  ])('shows which sign-in wins: $name', async ({ env, file, sources, uses, says }) => {
    const value = { api: API(), oat: OAT() };
    const NAMES = { api: 'ANTHROPIC_API_KEY', oat: 'CLAUDE_CODE_OAUTH_TOKEN' };
    if (file.length) ownKeys(file.map((k) => `${NAMES[k]}=${value[k]}`));
    const base = await start({ env: Object.fromEntries(Object.keys(env).map((k) => [NAMES[k], value[k]])) });
    const res = await fetch(`${base}/api/setup`);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain(value.api);
    expect(text).not.toContain(value.oat);
    expect(shows(text)).toBe(false);
    const step = signin(JSON.parse(text));
    expect(step.keys.map((k) => [k.name, k.source])).toEqual([['ANTHROPIC_API_KEY', sources[0]], ['CLAUDE_CODE_OAUTH_TOKEN', sources[1]]]);
    expect(step.inUse.uses).toBe(uses);
    for (const words of says) expect(step.inUse.line).toContain(words);
    expect(step.inUse.login).toBe(false);
    expect(step.signin).toEqual(SIGNIN);
  });

  it('warns about selling on the subscription', async () => {
    ownKeys([`CLAUDE_CODE_OAUTH_TOKEN=${OAT()}`]);
    const step = signin(await getJson(`${await start()}/api/setup`));
    expect(step.inUse.uses).toBe('subscription');
    expect(step.inUse.line).toContain(SELLING);
    expect(step.signin.cards[1].note).toContain(SELLING);
    expect(step.signin.cards[0].note).not.toContain(SELLING);
  });

  it('carries signin and inUse on the claude-signin step only', async () => {
    const body = await getJson(`${await start()}/api/setup`);
    for (const step of body.steps) {
      if (step.id === 'claude-signin') continue;
      expect(Object.hasOwn(step, 'signin'), step.id).toBe(false);
      expect(Object.hasOwn(step, 'inUse'), step.id).toBe(false);
    }
    expect(signin(body).inUse).toEqual({ uses: 'unknown', login: false, switchBack: false, line: 'No key or token saved. Press Test it to see whether this computer is signed in.' });
  });

  it('offers the way back to the key while the run is on the subscription', async () => {
    ownKeys([`ANTHROPIC_API_KEY=${API()}`, `CLAUDE_CODE_OAUTH_TOKEN=${OAT()}`]);
    const base = await start();
    expect(signin(await getJson(`${base}/api/setup`)).inUse.switchBack).toBe(false);
    useSubscription(state, new Date('2026-10-25T14:32:00.000Z'));
    const text = await (await fetch(`${base}/api/setup`)).text();
    expect(shows(text)).toBe(false);
    expect(signin(JSON.parse(text)).inUse).toMatchObject({ uses: 'fallback', switchBack: true });
  });

  it('goes back to the key with POST /api/setup/claude/use-key', async () => {
    ownKeys([`ANTHROPIC_API_KEY=${API()}`]);
    useSubscription(state, new Date('2026-10-25T14:32:00.000Z'));
    const base = await start();
    const res = await post(`${base}/api/setup/claude/use-key`, {});
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(shows(text)).toBe(false);
    expect(JSON.parse(text)).toEqual({ ok: true, lines: ['Sessions use the Console API key again from the next story.'] });
    expect(readSignIn(state)).toMatchObject({ using: 'key', since: NOW, reason: 'switched back by you' });
    expect(signin(await getJson(`${base}/api/setup`)).inUse.switchBack).toBe(false);
  });

  it('takes the key from the environment too', async () => {
    useSubscription(state, new Date('2026-10-25T14:32:00.000Z'));
    const base = await start({ env: { ANTHROPIC_API_KEY: API() } });
    expect(await (await post(`${base}/api/setup/claude/use-key`, {})).json()).toEqual({ ok: true, lines: ['Sessions use the Console API key again from the next story.'] });
    expect(readSignIn(state).using).toBe('key');
  });

  it('refuses with no key, and changes nothing', async () => {
    useSubscription(state, new Date('2026-10-25T14:32:00.000Z'));
    const before = readFileSync(join(state, 'claude-signin.json'), 'utf8');
    const base = await start();
    const res = await post(`${base}/api/setup/claude/use-key`, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, lines: ['No ANTHROPIC_API_KEY in the environment or .env.foreman: add the key first.'] });
    expect(readFileSync(join(state, 'claude-signin.json'), 'utf8')).toBe(before);
  });

  it('takes only a POST', async () => {
    ownKeys([`ANTHROPIC_API_KEY=${API()}`]);
    useSubscription(state, new Date('2026-10-25T14:32:00.000Z'));
    const base = await start();
    expect((await fetch(`${base}/api/setup/claude/use-key`)).status).toBe(405);
    expect(readSignIn(state).using).toBe('subscription');
  });

  it('tests the Console API key against /v1/models, and records the confirmation when Anthropic takes it', async () => {
    anthropic.status = 200;
    const base = await start({ keyBase: { resend: resend.url, anthropic: anthropic.url } });
    expect((await post(`${base}/api/setup/keys`, { name: 'ANTHROPIC_API_KEY', value: API() })).status).toBe(200);
    const res = await post(`${base}/api/setup/keys/test`, { name: 'ANTHROPIC_API_KEY' });
    const text = await res.text();
    expect(res.status, text).toBe(200);
    expect(anthropic.seen).toEqual([{ path: '/v1/models', key: API() }]);
    expect(JSON.parse(text)).toEqual({ ok: true, name: 'ANTHROPIC_API_KEY', result: { ok: true, detail: 'Anthropic accepted the key' } });
    expect(record().steps['claude-signin'].confirmedAt).toBe(NOW);
    expect(shows(text)).toBe(false);
  });

  it('says plainly when Anthropic refuses the key, without the key', async () => {
    anthropic.status = 401;
    const base = await start({ keyBase: { resend: resend.url, anthropic: anthropic.url } });
    await post(`${base}/api/setup/keys`, { name: 'ANTHROPIC_API_KEY', value: API() });
    const res = await post(`${base}/api/setup/keys/test`, { name: 'ANTHROPIC_API_KEY' });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(text).result).toEqual({ ok: false, detail: 'Anthropic did not accept the key' });
    expect(text).not.toContain(API());
    expect(shows(text)).toBe(false);
    expect(anthropic.seen).toHaveLength(1);
  });

  it('refuses a subscription token saved as the API key, and writes nothing', async () => {
    const base = await start();
    const res = await post(`${base}/api/setup/keys`, { name: 'ANTHROPIC_API_KEY', value: OAT() });
    const text = await res.text();
    expect(res.status).toBe(400);
    expect(JSON.parse(text).error).toBe('This looks like a subscription token (sk-ant-oat…); put it under Subscription.');
    expect(text).not.toContain(OAT());
    expect(existsSync(ownFile())).toBe(false);
  });

  it('refuses the API key when the environment has it, with 409', async () => {
    const base = await start({ env: { ANTHROPIC_API_KEY: API() } });
    const res = await post(`${base}/api/setup/keys`, { name: 'ANTHROPIC_API_KEY', value: `${API()}x` });
    expect(res.status).toBe(409);
    expect(existsSync(ownFile())).toBe(false);
  });

  it('refuses to save the API key on a dashboard other computers can reach, even with the token', async () => {
    const base = await start({ host: '0.0.0.0', env: { FOREMAN_DASHBOARD_TOKEN: TOKEN }, keyBase: { resend: resend.url, anthropic: anthropic.url } });
    const auth = { authorization: `Bearer ${TOKEN}` };
    for (const [path, body] of [['/api/setup/keys', { name: 'ANTHROPIC_API_KEY', value: API() }], ['/api/setup/keys/test', { name: 'ANTHROPIC_API_KEY' }]]) {
      expect((await post(`${base}${path}`, body, auth)).status, path).toBe(403);
    }
    expect(existsSync(ownFile())).toBe(false);
    expect(anthropic.seen).toEqual([]);
  });

  it("saves the key on the page and the doctor's own check reports the Console API key", async () => {
    const config = project();
    // Every sign-in name blanked, so the machine running the tests decides nothing.
    const blank = Object.fromEntries(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].map((n) => [n, '']));
    const shell = () => (cmd, args = []) => (cmd === 'claude' && args.join(' ') === 'auth status --json' ? { status: 0, stdout: '{"loggedIn":false}', stderr: '' } : { status: 1, stdout: '', stderr: 'not here' });
    const doctor = async () => {
      const { config: cfg, ctx } = doctorContext({ root: dir, env: blank, sh: shell, now: () => new Date(NOW) });
      return { config: cfg, ctx, checks: buildChecks(cfg, ctx) };
    };
    const base = await start({ config, doctor });
    expect((await post(`${base}/api/setup/keys`, { name: 'ANTHROPIC_API_KEY', value: API() })).status).toBe(200);
    const res = await post(`${base}/api/setup/steps/claude-signin/check`, {});
    const text = await res.text();
    expect(res.status, text).toBe(200);
    expect(shows(text)).toBe(false);
    const { step } = JSON.parse(text);
    const result = step.results.find((r) => r.name === 'claude sign-in');
    expect(result.detail).toMatch(/^Console API key/);
    expect(result).toMatchObject({ ok: true, kind: 'api-key', login: 'signed-out' });
    expect(step.inUse.uses).toBe('api-key');
    expect(step.inUse.login).toBe(false);
    const cache = JSON.parse(readFileSync(join(state, 'setup-checks.json'), 'utf8'));
    expect(cache.results['claude sign-in']).toMatchObject({ kind: 'api-key', login: 'signed-out' });
    expect(shows(JSON.stringify(cache))).toBe(false);
  });

  it('says the last check is out of date once the key is removed, and the selling warning after the next check', async () => {
    const config = project();
    const blank = Object.fromEntries(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].map((n) => [n, '']));
    // This computer is signed in to claude.ai.
    const shell = () => (cmd, args = []) => (cmd === 'claude' && args.join(' ') === 'auth status --json' ? { status: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai"}', stderr: '' } : { status: 1, stdout: '', stderr: 'not here' });
    const doctor = async () => {
      const { config: cfg, ctx } = doctorContext({ root: dir, env: blank, sh: shell, now: () => new Date(NOW) });
      return { config: cfg, ctx, checks: buildChecks(cfg, ctx) };
    };
    const base = await start({ config, doctor });
    const texts = [];
    const send = async (res) => {
      const text = await res.text();
      texts.push(text);
      expect(res.status, text).toBe(200);
      return JSON.parse(text);
    };
    await send(await post(`${base}/api/setup/keys`, { name: 'ANTHROPIC_API_KEY', value: API() }));
    const first = (await send(await post(`${base}/api/setup/steps/claude-signin/check`, {}))).step;
    expect(first.inUse.uses).toBe('api-key');
    const cache = JSON.parse(readFileSync(join(state, 'setup-checks.json'), 'utf8'));
    expect(cache.results['claude sign-in']).toMatchObject({ kind: 'api-key', fromKey: 'ANTHROPIC_API_KEY' });
    texts.push(JSON.stringify(cache));
    await send(await post(`${base}/api/setup/keys`, { name: 'ANTHROPIC_API_KEY', remove: true }));
    const stale = signin(await send(await fetch(`${base}/api/setup`)));
    expect(stale.inUse).toEqual({ uses: 'unknown', login: true, switchBack: false, line: SIGNIN.words.stale });
    const again = (await send(await post(`${base}/api/setup/steps/claude-signin/check`, {}))).step;
    expect(again.inUse).toMatchObject({ uses: 'login', login: true });
    expect(again.inUse.line).toContain(SELLING);
    for (const text of texts) {
      expect(shows(text)).toBe(false);
      expect(text).not.toContain(API());
    }
  });

  it('shows the sign-in on this computer from the cached result', async () => {
    const config = project();
    const checks = [{ name: 'claude sign-in', step: 'claude-signin', run: () => ({ ok: false, level: 'warn', kind: 'login', login: 'signed-in', detail: `claude.ai login on this machine. ${SELLING}` }) }];
    const base = await start({ config, doctor: async () => ({ config, ctx: {}, checks }) });
    const res = await post(`${base}/api/setup/steps/claude-signin/check`, {});
    expect(res.status).toBe(200);
    const { step } = await res.json();
    expect(step.inUse).toMatchObject({ uses: 'login', login: true });
    expect(step.inUse.line).toContain(SELLING);
    expect(signin(await getJson(`${base}/api/setup`)).inUse.login).toBe(true);
  });
});
