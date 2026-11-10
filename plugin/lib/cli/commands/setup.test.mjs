import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { makeSetupCommand } from './setup.mjs';

const SECRET = 're_acme-top-secret-31';
const LIST = 'Installed plugins:\n\n  ❯ foreman@foreman\n    Version: 0.1.0\n    Scope: project\n    Status: ✔ enabled\n';
const FIRST = new Date('2026-10-24T09:00:00Z');
const LATER = new Date('2026-10-24T10:30:00Z');

let dir;
let source;
let calls;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-setup-cmd-'));
  source = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-setup-src-'));
  fs.mkdirSync(path.join(source, '.claude-plugin'));
  fs.writeFileSync(path.join(source, '.claude-plugin', 'plugin.json'), '{"version":"0.1.0"}');
  fs.writeFileSync(path.join(dir, '.env.local'), `OTHER=${SECRET}\n`);
  calls = [];
  config();
});

// The Acme project: email notifications, one always check.
function config(over = { notify: { adapter: 'email-resend' } }) {
  fs.writeFileSync(path.join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'Acme' }, checks: [{ run: 'npm test', when: 'always' }], ...over }));
}

const sh = () => (cmd, args = []) => {
  const line = [cmd, ...args].join(' ');
  calls.push(line);
  if (line === 'claude plugin list') return { status: 0, stdout: LIST, stderr: '' };
  return { status: 0, stdout: '', stderr: '' };
};

async function setup(args, { now = FIRST, env = { RESEND_FROM_EMAIL: 'bot@acme.test' } } = {}) {
  let out = '';
  let err = '';
  const command = makeSetupCommand({ sh, sourceRoot: source, pluginsDir: path.join(dir, 'plugins') });
  const code = await command.run(args, {
    cwd: dir,
    root: dir,
    env,
    now: () => now,
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
  });
  return { code, out, err };
}

const cacheFile = () => path.join(dir, '.foreman', 'setup-checks.json');
const byId = (json) => Object.fromEntries(JSON.parse(json).steps.map((s) => [s.id, s]));

describe('foreman setup steps', () => {
  it('prints one JSON line with every step, its status and its checked results', async () => {
    const { code, out } = await setup(['steps', '--json']);
    expect(code).toBe(0);
    expect(out.trim().split('\n')).toHaveLength(1);
    const steps = byId(out);
    expect(Object.keys(steps)).toHaveLength(16);
    for (const step of Object.values(steps)) {
      expect(typeof step.applies, step.id).toBe('boolean');
      expect(typeof step.status, step.id).toBe('string');
      expect(Array.isArray(step.results), step.id).toBe(true);
      for (const r of step.results) expect(r.checkedAt, `${step.id} ${r.name}`).toBe(FIRST.toISOString());
    }
    expect(steps.notifications.status).toBe('needs-you');
    expect(steps.notifications.inputs.find((i) => i.name === 'RESEND_API_KEY')).toMatchObject({ kind: 'key', required: true, present: false });
    for (const id of ['jira-site', 'jira-app', 'jira-signin', 'sf-tools']) {
      expect(steps[id]).toMatchObject({ applies: false, status: 'skipped' });
    }
    expect(steps.github.status).toBe('done');
    expect(steps['cloud-runner']).toMatchObject({ applies: true, optional: true, status: 'optional' });
    expect(steps.github.results.map((r) => r.name)).toEqual(expect.arrayContaining(['git remote', 'gh signed in', 'branch protection']));
    expect(out).not.toContain(SECRET);
  });

  it('prints one line per step without --json', async () => {
    const { code, out } = await setup(['steps']);
    expect(code).toBe(0);
    expect(out).toMatch(/^needs-you Notifications$/m);
    expect(out).toMatch(/^skipped {3}Jira app$/m);
    expect(out).toMatch(/^done {6}GitHub$/m);
    expect(out.trim().split('\n')).toHaveLength(16);
  });

  it('with --step runs only that step, and keeps the cached results of the others', async () => {
    await setup(['steps', '--json']);
    calls = [];
    const { code, out } = await setup(['steps', '--step', 'github', '--json'], { now: LATER });
    expect(code).toBe(0);
    expect(calls).not.toContain('claude plugin list');
    expect(calls).toContain('gh auth status');
    const steps = byId(out);
    for (const r of steps.github.results) expect(r.checkedAt, r.name).toBe(LATER.toISOString());
    expect(steps['claude-code'].results.length).toBeGreaterThan(0);
    for (const r of steps['claude-code'].results) expect(r.checkedAt, r.name).toBe(FIRST.toISOString());
    expect(steps.notifications.status).toBe('needs-you');
  });

  it('with --step re-runs a cached check that counts against the step, so a key added since gives a current status', async () => {
    await setup(['steps', '--json']);
    const before = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')).results['env variables'];
    expect(before).toMatchObject({ ok: false, fix: { step: 'notifications' } });
    const { code, out } = await setup(['steps', '--step', 'notifications', '--json'], { now: LATER, env: { RESEND_FROM_EMAIL: 'bot@acme.test', RESEND_API_KEY: SECRET } });
    expect(code).toBe(0);
    const steps = byId(out);
    expect(steps.notifications.status).not.toBe('broken');
    expect(steps.notifications.status).toBe('done');
    expect(steps['project-keys'].results.find((r) => r.name === 'env variables')).toMatchObject({ ok: true, checkedAt: LATER.toISOString() });
    expect(out).not.toContain(SECRET);
  });

  it('with --step prints the current status of the step once a missing key is added', async () => {
    await setup(['steps']);
    const { code, out } = await setup(['steps', '--step', 'notifications'], { now: LATER, env: { RESEND_FROM_EMAIL: 'bot@acme.test', RESEND_API_KEY: SECRET } });
    expect(code).toBe(0);
    expect(out).toMatch(/^done {6}Notifications$/m);
    expect(out).not.toMatch(/^broken +Notifications$/m);
    expect(out).not.toContain(SECRET);
  });

  it('with --step drops a cached result of a check the config no longer has', async () => {
    await setup(['steps', '--json']);
    const file = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    file.results['acme retired check'] = { name: 'acme retired check', step: 'github', ok: false, level: 'error', detail: 'acme check that is gone', checkedAt: FIRST.toISOString() };
    fs.writeFileSync(cacheFile(), JSON.stringify(file));
    const { code, out } = await setup(['steps', '--step', 'github', '--json'], { now: LATER });
    expect(code).toBe(0);
    const github = byId(out).github;
    expect(github.status).toBe('done');
    expect(github.results.map((r) => r.name)).not.toContain('acme retired check');
    expect(JSON.parse(fs.readFileSync(cacheFile(), 'utf8')).results).not.toHaveProperty('acme retired check');
  });

  it('caches the results with mode 600 and no value', async () => {
    await setup(['steps', '--json'], { env: { RESEND_FROM_EMAIL: 'bot@acme.test', RESEND_API_KEY: SECRET } });
    const text = fs.readFileSync(cacheFile(), 'utf8');
    expect(fs.statSync(cacheFile()).mode & 0o777).toBe(0o600);
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text)).toMatchObject({ version: 1 });
    expect(JSON.parse(text).results['gh signed in']).toMatchObject({ ok: true, step: 'github', checkedAt: FIRST.toISOString() });
  });

  it('refuses an unknown step or subcommand with exit 64', async () => {
    for (const args of [['steps', '--step', 'nope'], ['nope'], ['steps', '--bogus'], ['--bogus'], ['--port', 'abc']]) {
      const { code, err } = await setup(args);
      expect(code, args.join(' ')).toBe(64);
      expect(err, args.join(' ')).toMatch(/usage: foreman setup/);
    }
  });
});

describe('foreman setup next', () => {
  it('names the first step waiting on the owner, with its guide, fix and user guide pointer', async () => {
    const { code, out } = await setup(['next']);
    expect(code).toBe(0);
    const lines = out.split('\n');
    expect(lines[0]).toBe('Next: Notifications (needs-you)');
    expect(lines[1]).toBe(JSON.parse((await setup(['steps', '--json'])).out).steps.find((s) => s.id === 'notifications').why);
    expect(out).toMatch(/^1\. .+$/m);
    expect(out).toMatch(/\(click: resend\.com › API Keys › Create API key\)/);
    expect(out).toMatch(/^fix: .*RESEND_API_KEY.*$/m);
    expect(out).toMatch(/^More: https:\/\/finefactory\.ai\/apps\/foreman\/docs\/#set-up$/m);
    expect(out).not.toContain('guide.md');
    expect(out).not.toContain('README.md');
    expect(out).not.toContain(SECRET);
  });

  it('runs the checks step by step, and stops at the waiting one', async () => {
    config({ notify: { adapter: 'email-resend' }, stories: { adapter: 'jira', site: 'acme.atlassian.net', jql: 'project = ACME' } });
    await setup(['next']);
    expect(calls.some((c) => c.startsWith('gh auth status'))).toBe(true);
    expect(fs.existsSync(cacheFile())).toBe(true);
    const cached = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')).results;
    expect(cached['jira signed in']).toBeUndefined();
  });

  it('says all set when every step is done', async () => {
    config({});
    const { code, out } = await setup(['next'], { env: {} });
    expect(code).toBe(0);
    expect(out).toBe('All set: every step is done.\n');
  });
});

describe('foreman setup (the page)', () => {
  let running;
  afterEach(async () => {
    running?.stop();
    await running?.done;
    running = null;
  });

  // Runs `foreman setup <args>` until the test calls stop(); `opened` holds every url opened.
  function serve(args, { env = {} } = {}) {
    let out = '';
    let err = '';
    let stop;
    const until = new Promise((resolve) => { stop = resolve; });
    const opened = [];
    const command = makeSetupCommand({ sh, sourceRoot: source, pluginsDir: path.join(dir, 'plugins'), open: (url) => opened.push(url) });
    const done = command.run(args, {
      cwd: dir,
      root: dir,
      env,
      now: () => FIRST,
      stdout: { write: (s) => { out += s; } },
      stderr: { write: (s) => { err += s; } },
      until,
    });
    running = { done, stop };
    return { done, stop, opened, out: () => out, err: () => err };
  }
  const address = async (run) => {
    for (let i = 0; i < 200 && !/Set up: http:\/\/\S+/.test(run.out()) && !run.err(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    return /Set up: (http:\/\/\S+)/.exec(run.out())?.[1];
  };
  const emptyAcme = () => {
    fs.rmSync(path.join(dir, 'foreman.config.json'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'acme' }));
  };

  it('serves set-up mode in an empty repo, opens the page, and stops when asked', async () => {
    emptyAcme();
    const run = serve(['--port', '0']);
    const url = await address(run);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(run.opened).toEqual([url]);
    expect(run.out()).toContain(`Set up: ${url}`);
    const setup = await fetch(`${url}api/setup`);
    expect(setup.status).toBe(200);
    expect(Array.isArray((await setup.json()).steps)).toBe(true);
    expect((await fetch(`${url}api/status`)).status).toBe(409);
    run.stop();
    expect(await run.done).toBe(0);
    await expect(fetch(`${url}api/setup`)).rejects.toThrow();
    expect(run.out() + run.err()).not.toContain(SECRET);
  });

  it('only prints the address with --no-open', async () => {
    emptyAcme();
    const run = serve(['--no-open', '--port', '0']);
    const url = await address(run);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(run.opened).toEqual([]);
  });

  it('serves full mode with a config, always on 127.0.0.1 and with no token', async () => {
    config({ console: { adapter: 'dashboard', host: '0.0.0.0' } });
    const run = serve(['--no-open', '--port', '0']);
    const url = await address(run);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const res = await fetch(`${url}api/status`);
    expect(res.status).toBe(200);
    expect((await res.json()).project.name).toBe('Acme');
    expect(run.out() + run.err()).not.toContain(SECRET);
  });

  it('says it did not start when the port is in use', async () => {
    emptyAcme();
    const holder = http.createServer();
    await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve));
    try {
      const run = serve(['--no-open', '--port', String(holder.address().port)]);
      expect(await run.done).toBe(1);
      expect(run.err()).toMatch(/did not start/);
      expect(run.opened).toEqual([]);
    } finally {
      await new Promise((resolve) => holder.close(resolve));
    }
  });
});
