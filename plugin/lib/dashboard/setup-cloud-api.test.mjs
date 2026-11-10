// The Cloud runner set-up API: the routes under /api/setup/cloud/, plus the cloud-runner step's
// cloud and cloudConfig in GET /api/setup. The fake gh and git are the injected keySh. No
// response ever carries a value, and the pasted GitHub token reaches no file but .env.runner.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createDashboardServer } from './server.mjs';
import { loadConfig } from '../config/load.mjs';
import { CLOUD_SCREEN } from '../setup/cloud-screen.mjs';
import { LOCAL_SAFE } from '../cloud/doctor.mjs';
import { WORKFLOW } from '../cloud/actions.mjs';
import { COMMIT_REMINDER } from '../settings/change.mjs';
import { fakeGh } from '../../../test/fake-gh.mjs';

const TOKEN = 'acme-dashboard-token-0123456789abcdef';
const NOW = '2026-10-24T09:00:00.000Z';
const hex = () => randomBytes(12).toString('hex');
const GH = `ghp_acme_${hex()}`;
const KEY = `sk-ant-api03-acme${hex()}`;
const RESEND = `re_acme_${hex()}`;
const E = CLOUD_SCREEN.errors;

let dir;
let servers;
let seen; // the text of every response a test got
let gh;

const configFile = () => join(dir, 'foreman.config.json');
const stateDir = () => join(dir, '.foreman');
const record = () => JSON.parse(readFileSync(join(stateDir(), 'setup.json'), 'utf8'));

function project(extra = {}) {
  writeFileSync(configFile(), `${JSON.stringify({ version: 1, project: { name: 'Acme' }, state: { store: 'branch' }, ...extra }, null, 2)}\n`);
  return loadConfig(dir).config;
}
const keys = (text = `ANTHROPIC_API_KEY=${KEY}\nRESEND_API_KEY=${RESEND}\n`) => writeFileSync(join(dir, '.env.foreman'), text, { mode: 0o600 });

async function start({ host = '127.0.0.1', env = {}, config = loadConfig(dir).config, now = () => new Date(NOW), ...rest } = {}) {
  const cfg = config ? { ...config, console: { ...config.console, host } } : null;
  const server = createDashboardServer({
    root: dir,
    config: cfg,
    host,
    env: { FOREMAN_STATE_DIR: stateDir(), ...env },
    now,
    keySh: gh,
    doctor: () => Promise.resolve({ config: cfg, ctx: {}, checks: [] }),
    ...rest,
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, host, resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, server };
}

async function call(url, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  seen += text;
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, body: json };
}
const post = (url, body = {}, headers) => call(url, { method: 'POST', body, headers });
const stepOf = async (base) => (await call(`${base}/api/setup`)).body.steps.find((s) => s.id === 'cloud-runner');
const setCalls = () => gh.calls.filter((c) => c.cmd === 'gh' && c.args[0] === 'secret' && c.args[1] === 'set');
const ghCalls = () => gh.calls.filter((c) => c.cmd === 'gh');
const filesIn = (d) => readdirSync(d, { withFileTypes: true }).flatMap((x) => (x.isDirectory() ? (x.name === '.git' ? [] : filesIn(join(d, x.name))) : [join(d, x.name)]));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foreman-setup-cloud-'));
  servers = [];
  seen = '';
  gh = fakeGh({ root: dir });
  spawnSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, '.gitignore'), '.env.foreman\n.foreman/\n');
});
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((resolve) => (s.listening ? s.close(() => resolve()) : resolve()))));
  for (const v of [GH, KEY, RESEND]) expect(seen).not.toContain(v);
  for (const c of gh.calls) for (const v of [GH, KEY, RESEND]) expect(c.args.join(' ')).not.toContain(v);
  for (const f of filesIn(dir)) if (relative(dir, f) !== '.env.runner') expect(readFileSync(f, 'utf8'), relative(dir, f)).not.toContain(GH);
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/setup', () => {
  it("gives cloud-runner its screen's words and cloudConfig, booleans only, with no value and no gh call", async () => {
    project({ cloud: { envVars: ['RESEND_API_KEY'] } });
    keys();
    const { base } = await start();
    const step = await stepOf(base);
    expect(step.cloud).toEqual(CLOUD_SCREEN);
    expect(step.cloudConfig).toMatchObject({
      mode: null,
      stateBranch: true,
      workflow: { exists: false, current: false },
      runnerFile: { file: '.env.runner', exists: false, ignored: 'not-ignored' },
      repo: 'acme/app',
      names: {
        token: 'FOREMAN_GH_TOKEN',
        signIn: [{ name: 'ANTHROPIC_API_KEY', stored: true, step: 'claude-signin' }, { name: 'CLAUDE_CODE_OAUTH_TOKEN', stored: false, step: 'claude-signin' }],
        keys: [{ name: 'RESEND_API_KEY', stored: true, step: 'notifications' }],
        runner: [{ name: 'FOREMAN_DASHBOARD_TOKEN', stored: false, step: 'project-keys' }, { name: 'RESEND_API_KEY', stored: true, step: 'notifications' }],
      },
    });
    expect(step.optional).toBe(true);
    expect(step.status).toBe('optional');
    expect(ghCalls()).toEqual([]);
    const body = (await call(`${base}/api/setup`)).body;
    for (const s of body.steps) if (s.id !== 'cloud-runner') expect(Object.hasOwn(s, 'cloudConfig'), s.id).toBe(false);
  });
});

describe('the Actions routes', () => {
  it('state writes state.store to branch', async () => {
    project({ state: { store: 'files' } });
    const { base } = await start();
    const r = await post(`${base}/api/setup/cloud/state`, {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, lines: ['set state.store to branch', COMMIT_REMINDER] });
    expect((await stepOf(base)).cloudConfig.stateBranch).toBe(true);
  });

  it('workflow writes the workflow, and is a 409 when it is there unless replace', async () => {
    project();
    const { base } = await start();
    const r = await post(`${base}/api/setup/cloud/workflow`, { replace: false });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(existsSync(join(dir, WORKFLOW))).toBe(true);
    const again = await post(`${base}/api/setup/cloud/workflow`, { replace: false });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe(E.workflowExists);
    expect((await post(`${base}/api/setup/cloud/workflow`, { replace: true })).status).toBe(200);
    expect((await stepOf(base)).cloudConfig).toMatchObject({ mode: 'actions', workflow: { exists: true, current: true } });
  });

  it('secrets lists the names on GitHub', async () => {
    project();
    keys();
    gh = fakeGh({ root: dir, secrets: ['FOREMAN_GH_TOKEN'] });
    const { base } = await start();
    const r = await post(`${base}/api/setup/cloud/secrets`, {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, repo: 'acme/app', missing: [] });
    expect(r.body.rows.map((x) => [x.name, x.set, x.stored])).toEqual([['FOREMAN_GH_TOKEN', true, false], ['ANTHROPIC_API_KEY', false, true], ['CLAUDE_CODE_OAUTH_TOKEN', false, false]]);
  });

  it('secrets/set checks the token, sets every secret with the value on stdin, and records the confirmation', async () => {
    project();
    keys();
    const { base } = await start();
    const r = await post(`${base}/api/setup/cloud/secrets/set`, { ghToken: GH });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, set: ['FOREMAN_GH_TOKEN', 'ANTHROPIC_API_KEY'], failed: [], missing: [] });
    expect(r.body.results.map((x) => x.name)).toEqual([...LOCAL_SAFE]);
    expect(setCalls().map((c) => c.opts.input)).toEqual([GH, KEY]);
    for (const c of setCalls()) expect(c.opts.env?.GH_TOKEN).not.toBe(GH);
    expect(record().steps['cloud-runner'].confirmedAt).toBe(NOW);
  });

  it('secrets/set confirms nothing while a name is missing', async () => {
    project({ cloud: { envVars: ['RESEND_API_KEY', 'SUPABASE_URL'] } });
    keys();
    const { base } = await start();
    const r = await post(`${base}/api/setup/cloud/secrets/set`, { ghToken: GH });
    expect(r.status).toBe(200);
    expect(r.body.missing).toEqual(['SUPABASE_URL']);
    let confirmed = null;
    try {
      confirmed = record().steps['cloud-runner']?.confirmedAt ?? null;
    } catch {
      confirmed = null;
    }
    expect(confirmed).toBeNull();
  });

  it('secrets/set refuses a bad token shape with a 400 that does not repeat it', async () => {
    project();
    const { base } = await start();
    const r = await post(`${base}/api/setup/cloud/secrets/set`, { ghToken: 'acme-wrong-shape' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe(E.badToken);
    expect(r.text).not.toContain('acme-wrong-shape');
    expect(ghCalls()).toEqual([]);
  });

  it('allows 5 secrets reads a minute, as a step check, then 429', async () => {
    project();
    let clock = Date.parse(NOW);
    const { base } = await start({ now: () => new Date(clock) });
    for (let i = 0; i < 5; i += 1) {
      clock += 1000;
      expect((await post(`${base}/api/setup/cloud/secrets`, {})).status, `read ${i + 1}`).toBe(200);
    }
    clock += 1000;
    const sixth = await post(`${base}/api/setup/cloud/secrets`, {});
    expect(sixth.status).toBe(429);
    expect(sixth.body.retryAfter).toBe(55);
  });
});

describe('the container routes', () => {
  it("runner-file is a 409 with fix 'ignore' until git ignores it, then ignore and runner-file write it", async () => {
    project();
    keys();
    const { base } = await start();
    const refused = await post(`${base}/api/setup/cloud/runner-file`, { ghToken: GH });
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ error: E.notIgnored.split('{file}').join('.env.runner'), fix: 'ignore' });
    expect(existsSync(join(dir, '.env.runner'))).toBe(false);
    const ignored = await post(`${base}/api/setup/cloud/runner-file/ignore`, {});
    expect(ignored.status).toBe(200);
    expect(ignored.body).toEqual({ ok: true, lines: ['added .env.runner to .gitignore'] });
    const r = await post(`${base}/api/setup/cloud/runner-file`, { ghToken: GH });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, file: '.env.runner', missing: ['FOREMAN_DASHBOARD_TOKEN'] });
    expect(r.body.dockerRun).toMatch(/^docker run -d --name foreman .* --env-file \.env\.runner .*ghcr\.io\/finefactory-ai\/foreman-runner:/);
    expect(readFileSync(join(dir, '.env.runner'), 'utf8')).toContain(GH);
    expect((await stepOf(base)).cloudConfig).toMatchObject({ mode: 'container', runnerFile: { exists: true, ignored: 'ignored' } });
  });

  it('check runs the local-safe checks on the runner file and records the confirmation when all pass', async () => {
    project();
    writeFileSync(join(dir, '.gitignore'), '.env.foreman\n.foreman/\n.env.runner\n');
    writeFileSync(join(dir, '.env.runner'), `FOREMAN_REPO=acme/app\nGH_TOKEN=${GH}\nFOREMAN_DASHBOARD_TOKEN=${TOKEN}\n`, { mode: 0o600 });
    const { base } = await start();
    const r = await post(`${base}/api/setup/cloud/check`, {});
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.results.map((x) => x.name)).toEqual([...LOCAL_SAFE]);
    expect(r.text).not.toContain(TOKEN);
    expect(record().steps['cloud-runner'].confirmedAt).toBe(NOW);
  });
});

describe('the gates', () => {
  const LOCAL_ONLY = [
    ['/api/setup/cloud/secrets/set', { ghToken: GH }],
    ['/api/setup/cloud/runner-file', { ghToken: GH }],
    ['/api/setup/cloud/runner-file/ignore', {}],
    ['/api/setup/cloud/check', {}],
  ];
  const ANY_HOST = [
    ['/api/setup/cloud/state', {}],
    ['/api/setup/cloud/workflow', { replace: false }],
    ['/api/setup/cloud/secrets', {}],
  ];

  it('refuses the value-moving routes on a dashboard beyond this computer, even with its token', async () => {
    project();
    keys();
    const { base } = await start({ host: '0.0.0.0', env: { FOREMAN_DASHBOARD_TOKEN: TOKEN } });
    const auth = { authorization: `Bearer ${TOKEN}` };
    for (const [path, body] of LOCAL_ONLY) {
      const r = await post(`${base}${path}`, body, auth);
      expect(r.status, path).toBe(403);
      expect(r.body.error, path).toBe(CLOUD_SCREEN.localOnly);
    }
    expect(gh.calls).toEqual([]);
    expect(existsSync(join(dir, '.env.runner'))).toBe(false);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('.env.foreman\n.foreman/\n');
  });

  it('needs the token beyond this computer for state, workflow and secrets, and works with it', async () => {
    project();
    const { base } = await start({ host: '0.0.0.0', env: { FOREMAN_DASHBOARD_TOKEN: TOKEN } });
    for (const [path, body] of ANY_HOST) expect((await post(`${base}${path}`, body)).status, path).toBe(401);
    for (const [path, body] of ANY_HOST) {
      expect((await post(`${base}${path}`, body, { authorization: `Bearer ${TOKEN}` })).status, path).toBe(200);
    }
  });

  it('answers 409 setupFirst with no config, and 400 for an extra key', async () => {
    project();
    const { base } = await start();
    const extra = await post(`${base}/api/setup/cloud/state`, { store: 'branch' });
    expect(extra.status).toBe(400);
    expect(extra.body.error).toBe(E.badBody);
    rmSync(configFile());
    const r = await post(`${base}/api/setup/cloud/workflow`, { replace: false });
    expect(r.status).toBe(409);
  });
});
