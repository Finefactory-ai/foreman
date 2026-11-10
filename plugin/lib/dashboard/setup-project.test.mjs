// The "This project" step behind the Set up tab: POST /api/setup/project/write with the form's
// answers writes the same files as `foreman init write`, and POST /api/setup/project/check-run
// runs the check command once, on loopback only, with a time limit, its output tail redacted and
// never stored.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardServer } from './server.mjs';
import { loadConfig } from '../config/load.mjs';
import { makeInitCommand } from '../cli/commands/init.mjs';
import { WORDS } from '../setup/project.mjs';

const FIXTURE = new URL('../../../test/fixtures/acme-init/', import.meta.url);
const CASES = JSON.parse(readFileSync(new URL('cases.json', FIXTURE), 'utf8'));
const TOKEN = 'acme-dashboard-token-0123456789abcdef';
const NOW = '2026-10-24T09:00:00.000Z';

let made;
let servers;

const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'foreman-setup-project-'));
  made.push(d);
  return d;
};
const gitInit = (d) => spawnSync('git', ['init', '-q'], { cwd: d });
function acmeRepo() {
  const d = tempDir();
  cpSync(new URL('repo', FIXTURE), d, { recursive: true });
  gitInit(d);
  return d;
}
function emptyRepo() {
  const d = tempDir();
  gitInit(d);
  return d;
}

// Doctor checks for the project step only.
const fakeDoctor = () => Promise.resolve({ config: null, ctx: {}, checks: [] });

async function start(root, { host = '127.0.0.1', env = {}, config = null, ...rest } = {}) {
  const server = createDashboardServer({ root, config, stateDir: join(root, '.foreman'), host, env, doctor: fakeDoctor, ...rest });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, host, resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

const post = (url, body, headers = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

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

const RUN = '/api/setup/project/check-run';
const WRITE = '/api/setup/project/write';

beforeEach(() => {
  made = [];
  servers = [];
});
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((resolve) => (s.listening ? s.close(() => resolve()) : resolve()))));
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

describe('POST /api/setup/project/write { answers }: the same files as `foreman init write`', () => {
  it.each(CASES.map((c) => [c.name, c]))('%s', async (name, c) => {
    const a = acmeRepo();
    const b = acmeRepo();
    let out = '';
    let err = '';
    const code = await makeInitCommand().run(['write'], { root: a, cwd: a, stdout: { write: (s) => (out += s) }, stderr: { write: (s) => (err += s) }, readStdin: () => JSON.stringify(c.config) });
    expect(code, err).toBe(0);

    const base = await start(b);
    const res = await post(`${base}${WRITE}`, { answers: c.answers });
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.ok).toBe(true);

    const files = ['foreman.config.json', '.claude/settings.json', '.gitignore', ...(name === 'markdown' ? ['docs/stories/S-1.md'] : [])];
    for (const f of files) expect(readFileSync(join(b, f)).equals(readFileSync(join(a, f))), f).toBe(true);
  });
});

describe('an empty Acme repo reaches a valid config from the page alone', () => {
  it('detects, writes, and switches to full mode', async () => {
    const d = emptyRepo();
    const base = await start(d);
    expect((await (await fetch(`${base}/api/setup`)).json()).hasConfig).toBe(false);
    expect((await post(`${base}/api/setup/project/detect`, {})).status).toBe(200);

    const res = await post(`${base}${WRITE}`, { answers: { name: 'Acme', source: 'markdown', dir: 'stories', check: 'true', ci: [] } });
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.lines).toContain('wrote foreman.config.json');

    expect(loadConfig(d).errors ?? []).toEqual([]);
    expect((await fetch(`${base}/api/status`)).status).toBe(200);
    expect((await (await fetch(`${base}/api/setup`)).json()).hasConfig).toBe(true);
  });
});

describe('POST /api/setup/project/write { answers }: errors', () => {
  it('lists bad answers in plain words and writes nothing', async () => {
    const d = acmeRepo();
    const base = await start(d);
    const res = await post(`${base}${WRITE}`, { answers: { name: '', source: 'markdown', dir: '../x', check: 'npm test' } });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors).toContain(WORDS.needName);
    expect(body.errors).toContain(WORDS.badDir);
    expect(body.error).toBe(body.errors.join('; '));
    expect(existsSync(join(d, 'foreman.config.json'))).toBe(false);
  });

  it('takes the config or the answers, not both', async () => {
    const d = acmeRepo();
    const base = await start(d);
    const res = await post(`${base}${WRITE}`, { config: CASES[0].config, answers: CASES[0].answers });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: WORDS.oneOf });
    expect(existsSync(join(d, 'foreman.config.json'))).toBe(false);
  });

  it('wants the answers as an object', async () => {
    const d = acmeRepo();
    const base = await start(d);
    for (const answers of ['x', [], null]) expect((await post(`${base}${WRITE}`, { answers })).status, JSON.stringify(answers)).toBe(400);
    expect(existsSync(join(d, 'foreman.config.json'))).toBe(false);
  });

  // A config that loads is left alone; one that does not load may be replaced (setup-mode.test).
  it('leaves an existing config that loads as it is', async () => {
    const d = acmeRepo();
    writeFileSync(join(d, 'foreman.config.json'), '{ "version": 1, "project": { "name": "Acme as it was" } }\n');
    const before = readFileSync(join(d, 'foreman.config.json'));
    const base = await start(d);
    const res = await post(`${base}${WRITE}`, { answers: CASES[0].answers });
    expect(res.status).toBe(409);
    expect(readFileSync(join(d, 'foreman.config.json')).equals(before)).toBe(true);
  });
});

describe('POST /api/setup/project/check-run', () => {
  it('runs the command once and answers its result', async () => {
    const d = emptyRepo();
    const base = await start(d);
    const res = await post(`${base}${RUN}`, { run: 'echo acme-ok' });
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.result.passed).toBe(true);
    expect(body.result.tail).toContain('acme-ok');
    expect(body.result.detail).toBe(WORDS.passed(body.result.seconds));
  });

  it('answers 200 with passed false for a failing command', async () => {
    const base = await start(emptyRepo());
    const res = await post(`${base}${RUN}`, { run: 'exit 2' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result).toMatchObject({ passed: false, exitCode: 2 });
  });

  it('stops the command at the time limit', async () => {
    const base = await start(emptyRepo(), { checkRunTimeoutMs: 300 });
    const started = Date.now();
    // `sleep 30 & wait` keeps sh alive as the parent of sleep, so only a group kill ends it in time.
    const res = await post(`${base}${RUN}`, { run: 'sleep 30 & wait' });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(res.status).toBe(200);
    expect((await res.json()).result).toMatchObject({ timedOut: true, passed: false });
  });

  it("never shows the environment's keys or the key files' values", async () => {
    const d = emptyRepo();
    writeFileSync(join(d, '.env.foreman'), 'JIRA_CLIENT_SECRET=acme-client-secret-77\n');
    const base = await start(d, { env: { ANTHROPIC_API_KEY: 'sk-ant-acme-env-value' } });
    // `cut` prints the file's value bare, so only the route's fileSecrets can blank it.
    const res = await post(`${base}${RUN}`, { run: 'echo $ANTHROPIC_API_KEY; cat .env.foreman; cut -d= -f2 .env.foreman; echo acme-end' });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain('sk-ant-acme-env-value');
    expect(text).not.toContain('acme-client-secret-77');
    expect(text).toContain('acme-end');
  });

  it('answers at the time limit and frees the slot even when something keeps the output open', async () => {
    const d = emptyRepo();
    const base = await start(d, { checkRunTimeoutMs: 3000 });
    // Node's detached spawn calls setsid, so the sleep 20 leaves the group but keeps the pipes.
    // It writes its pid to "ready" once it is running, and sh waits for that file, so the
    // holder exists well before the 3 s limit fires. With the default 2 s grace the answer
    // comes by about 5 s; without the grace timer it waits for the sleep 20.
    const holder = "const c=require('child_process').spawn('sleep',['20'],{detached:true,stdio:['ignore','inherit','inherit']});c.unref();require('fs').writeFileSync('ready',String(c.pid))";
    const run = `${JSON.stringify(process.execPath)} -e "${holder}"; while [ ! -f ready ]; do sleep 0.05; done; sleep 30`;
    const started = Date.now();
    try {
      const res = await post(`${base}${RUN}`, { run });
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(existsSync(join(d, 'ready'))).toBe(true);
      expect(res.status).toBe(200);
      expect((await res.json()).result.timedOut).toBe(true);
      expect((await post(`${base}${RUN}`, { run: 'true' })).status).toBe(200);
    } finally {
      try {
        process.kill(Number(readFileSync(join(d, 'ready'), 'utf8')), 'SIGKILL');
      } catch {
        // the holder never started or has gone
      }
    }
  });

  it('never shows other secrets from the dashboard\'s environment', async () => {
    const d = emptyRepo();
    const base = await start(d, { env: { ACME_DATABASE_URL: 'postgres://u:acme-db-pass@h/db', JIRA_CLIENT_SECRET: 'acme-jira-secret-value-1234' } });
    const res = await post(`${base}${RUN}`, { run: 'echo "$ACME_DATABASE_URL"; echo "$JIRA_CLIENT_SECRET"; echo acme-end' });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain('acme-db-pass');
    expect(text).not.toContain('acme-jira-secret-value-1234');
    expect(text).toContain('acme-end');
  });

  it('kills a command still running when the server closes', async () => {
    const d = emptyRepo();
    const base = await start(d, { checkRunTimeoutMs: 60_000 });
    // The subshell outlives sh if only sh is killed, so only a group kill stops the touch.
    const pending = post(`${base}${RUN}`, { run: '(sleep 1; touch late) & wait' }).catch(() => null);
    await new Promise((r) => setTimeout(r, 200));
    await new Promise((r) => servers.pop().close(() => r()));
    await pending;
    await new Promise((r) => setTimeout(r, 1300));
    expect(existsSync(join(d, 'late'))).toBe(false);
  });
});

describe('POST /api/setup/project/check-run: refused actors run nothing', () => {
  const touch = JSON.stringify({ run: 'touch ran' });
  const json = { 'content-type': 'application/json' };
  let d;
  beforeEach(() => {
    d = emptyRepo();
  });
  afterEach(() => {
    expect(existsSync(join(d, 'ran'))).toBe(false);
  });

  it('on a dashboard other computers can reach, even with the token', async () => {
    const base = await start(d, { host: '0.0.0.0', env: { FOREMAN_DASHBOARD_TOKEN: TOKEN } });
    const res = await raw(base, RUN, { method: 'POST', headers: { ...json, authorization: `Bearer ${TOKEN}` }, body: touch });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: WORDS.localOnly });
  });

  it('without the token', async () => {
    const base = await start(d, { host: '0.0.0.0', env: { FOREMAN_DASHBOARD_TOKEN: TOKEN } });
    expect((await raw(base, RUN, { method: 'POST', headers: json, body: touch })).status).toBe(401);
  });

  it('from another site', async () => {
    const base = await start(d);
    expect((await raw(base, RUN, { method: 'POST', headers: { ...json, origin: 'http://evil.test' }, body: touch })).status).toBe(403);
  });

  it('as a plain-text body', async () => {
    const base = await start(d);
    expect((await raw(base, RUN, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: touch })).status).toBe(415);
  });

  it('addressed to another host', async () => {
    const base = await start(d);
    expect((await raw(base, RUN, { method: 'POST', headers: { ...json, host: 'evil.test' }, body: touch })).status).toBe(403);
  });

  it('with a bad command, never repeating it', async () => {
    const base = await start(d);
    for (const run of ['', 42, 'touch ran\necho acme-second-line', 'x'.repeat(1001), undefined]) {
      const res = await raw(base, RUN, { method: 'POST', headers: json, body: JSON.stringify({ run }) });
      expect(res.status, JSON.stringify(run)).toBe(400);
      expect(res.body).not.toContain('touch ran');
      expect(res.body).not.toContain('acme-second-line');
      expect(res.body).not.toContain('xxxxxxxx');
      expect(typeof JSON.parse(res.body).error).toBe('string');
    }
  });

  it('as a GET', async () => {
    const base = await start(d);
    const res = await raw(base, `${RUN}?run=touch%20ran`);
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe('POST');
  });
});

describe('POST /api/setup/project/check-run: limits', () => {
  it('runs one at a time', async () => {
    const base = await start(emptyRepo());
    const first = post(`${base}${RUN}`, { run: 'sleep 1' });
    await new Promise((r) => setTimeout(r, 150));
    const second = await post(`${base}${RUN}`, { run: 'true' });
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBe('1');
    expect((await first).status).toBe(200);
  });

  it('refuses the 6th run in a minute', async () => {
    const base = await start(emptyRepo(), { now: () => new Date(NOW) });
    for (let i = 0; i < 5; i += 1) expect((await post(`${base}${RUN}`, { run: 'true' })).status, `run ${i + 1}`).toBe(200);
    const sixth = await post(`${base}${RUN}`, { run: 'true' });
    expect(sixth.status).toBe(429);
    expect(Number(sixth.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});

describe('POST /api/setup/project/check-run: nothing is stored', () => {
  it('keeps the output out of every file and every GET', async () => {
    const d = emptyRepo();
    const base = await start(d);
    const res = await post(`${base}${RUN}`, { run: 'echo acme-sentinel-output' });
    expect((await res.json()).result.tail).toContain('acme-sentinel-output');
    for (const f of walk(join(d, '.foreman'))) expect(readFileSync(f, 'utf8'), f).not.toContain('acme-sentinel-output');
    expect(await (await fetch(`${base}/api/setup`)).text()).not.toContain('acme-sentinel-output');
  });
});
