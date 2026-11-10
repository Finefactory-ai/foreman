// `foreman doctor` with the Jira story source, against the fake Jira, and the local settings
// layer's warnings.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { doctorContext, makeDoctorCommand } from './doctor.mjs';
import { buildChecks } from '../../engine/doctor-checks.mjs';
import { readToken, tokenPath, writeToken } from '../../jira/auth.mjs';
import { startFakeJiraHere } from '../../../../test/fake-jira.mjs';

const SITE = 'acme.atlassian.net';
const JQL = 'project = ACME AND labels = foreman ORDER BY Rank';
const NOW = new Date('2026-10-18T12:00:00Z');
const daysAgo = (n) => new Date(+NOW - n * 86_400_000).toISOString();
const LIST = 'Installed plugins:\n\n  ❯ foreman@foreman\n    Version: 0.1.0\n    Scope: project\n    Status: ✔ enabled\n';

let dir;
let home;
let source;
let jira;
let output;

const sh = () => (cmd, args = []) => {
  const line = [cmd, ...args].join(' ');
  if (line === 'claude plugin list') return { status: 0, stdout: LIST, stderr: '' };
  return { status: 0, stdout: '', stderr: '' };
};

function writeConfig(stories = {}) {
  fs.writeFileSync(path.join(dir, 'foreman.config.json'), JSON.stringify({
    version: 1,
    project: { name: 'P' },
    stories: { adapter: 'jira', site: SITE, jql: JQL, ...stories },
  }));
}

const envFile = (text) => fs.writeFileSync(path.join(dir, '.env.local'), text);
const keys = () => envFile(`JIRA_CLIENT_ID=${jira.fake.clientId}\nJIRA_CLIENT_SECRET=${jira.fake.clientSecret}\n`);

function signIn(patch = {}) {
  const record = {
    cloudId: jira.cloudId,
    site: SITE,
    ...jira.tokens,
    expiresAt: new Date(+NOW + 3_600_000).toISOString(),
    savedAt: daysAgo(3),
    account: { accountId: 'x', displayName: 'Ada Lovelace' },
    ...patch,
  };
  for (const [k, v] of Object.entries(record)) if (v === undefined) delete record[k];
  writeToken(SITE, record, { env: { HOME: home } });
  return record;
}

async function doctor(env = {}) {
  output = '';
  const command = makeDoctorCommand({ sh, sourceRoot: source });
  const code = await command.run([], {
    cwd: dir,
    root: dir,
    now: () => NOW,
    env: { HOME: home, FOREMAN_JIRA_AUTH_BASE: jira.url, FOREMAN_JIRA_API_BASE: jira.url, ...env },
    stdout: { write: (s) => { output += s; } },
    stderr: { write: (s) => { output += s; } },
  });
  return { code, out: output };
}

const line = (out, name) => out.split('\n').find((l) => l.slice(6).startsWith(`${name}`)) ?? '';

beforeEach(async () => {
  output = '';
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-doctor-jira-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-doctor-home-'));
  source = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-doctor-src-'));
  fs.mkdirSync(path.join(source, '.claude-plugin'));
  fs.writeFileSync(path.join(source, '.claude-plugin', 'plugin.json'), '{"version":"0.1.0"}');
  jira = await startFakeJiraHere();
  jira.addIssue({ key: 'ACME-1', summary: 'One', status: 'todo', labels: ['foreman'] });
  jira.addIssue({ key: 'ACME-2', summary: 'Two', status: 'in-progress', labels: ['foreman'] });
  writeConfig();
  keys();
});

afterEach(async () => {
  // No code, token or the client secret ever reaches the output.
  for (const s of jira.fake.secrets()) expect(output ?? '').not.toContain(s);
  await jira.close();
  for (const d of [dir, home, source]) fs.rmSync(d, { recursive: true, force: true });
});

describe('foreman doctor: Jira', () => {
  it('passes every Jira check when signed in, and shows the approximate count', async () => {
    signIn();
    writeConfig({ transitions: { started: 'In Progress', shipped: 'done' } });
    const { code, out } = await doctor();
    expect(code).toBe(0);
    expect(out).toMatch(/^ok {4}jira signed in — acme\.atlassian\.net as Ada Lovelace$/m);
    expect(out).toMatch(/^ok {4}jira sign-in age — renewed 3 days ago$/m);
    expect(out).toMatch(/^ok {4}jira JQL — runs \(about 3 issues\)$/m);
    expect(out).toMatch(/^ok {4}jira transitions$/m);
    expect(out).toMatch(/^ok {4}jira app keys$/m);
    // Real Jira refuses maxResults 0, so the check asks for one issue and only its id.
    const search = (await jira.requests()).find((r) => r.path === '/rest/api/3/search/jql');
    expect(search.body).toEqual({ jql: JQL, maxResults: 1, fields: ['id'] });
  });

  it('fails "signed in" with the login hint when there is no token file, and skips the calls', async () => {
    const { code, out } = await doctor();
    expect(code).toBe(1);
    expect(line(out, 'jira signed in')).toMatch(/^FAIL {2}jira signed in — not signed in to acme\.atlassian\.net; run `foreman jira login`$/);
    expect(line(out, 'jira JQL')).toMatch(/^warn {2}jira JQL — skipped: not signed in$/);
    expect(await jira.requests()).toEqual([]);
  });

  it('warns when the refresh token is older than 80 days', async () => {
    signIn({ savedAt: daysAgo(85) });
    const { code, out } = await doctor();
    expect(code).toBe(0);
    expect(line(out, 'jira sign-in age')).toMatch(/^warn {2}jira sign-in age — .*85 days ago.*90 days.*foreman jira login/);
  });

  it('falls back to the token file\'s time when the file has no savedAt', async () => {
    signIn({ savedAt: undefined });
    const file = tokenPath(SITE, { env: { HOME: home } });
    const old = new Date(daysAgo(81));
    fs.utimesSync(file, old, old);
    const { out } = await doctor();
    expect(line(out, 'jira sign-in age')).toMatch(/^warn {2}jira sign-in age — .*81 days ago/);
  });

  it('refreshes an expired access token with the keys from the env file', async () => {
    const before = signIn({ expiresAt: daysAgo(1) });
    const { code, out } = await doctor();
    expect(code).toBe(0);
    expect(out).toMatch(/^ok {4}jira JQL — runs/m);
    expect(readToken(SITE, { env: { HOME: home } }).refreshToken).not.toBe(before.refreshToken);
  });

  it('fails the JQL check with the login hint when the sign-in has expired', async () => {
    signIn({ expiresAt: daysAgo(1), refreshToken: 'rt-retired' });
    const { code, out } = await doctor();
    expect(code).toBe(1);
    expect(line(out, 'jira JQL')).toMatch(/^FAIL {2}jira JQL — Jira sign-in expired; run `foreman jira login`$/);
  });

  it('fails the JQL check when Jira refuses the query', async () => {
    signIn();
    writeConfig({ jql: 'project = INVALID' });
    const { code, out } = await doctor();
    expect(code).toBe(1);
    expect(line(out, 'jira JQL')).toMatch(/^FAIL {2}jira JQL — the JQL fails: .*400/);
  });

  it('matches transitions by name or by the status they lead to, any case, and warns on the rest', async () => {
    signIn();
    // ACME-1 is in To Do, which offers "In Progress" and "Done"; "In Review" is a status of the
    // project, so it counts; "Nope" is neither.
    writeConfig({ transitions: { started: 'in progress', review: 'In Review', blocked: 'Nope', shipped: 'DONE' } });
    const { code, out } = await doctor();
    expect(code).toBe(0);
    expect(line(out, 'jira transitions')).toMatch(/^warn {2}jira transitions — not found from ACME-1 \(To Do\): blocked "Nope"/);
    expect(line(out, 'jira transitions')).not.toMatch(/In Review|in progress|DONE/);
    const looked = (await jira.requests()).filter((r) => r.path === '/rest/api/3/issue/ACME-1/transitions');
    expect(looked).toHaveLength(1);
  });

  it('warns when the JQL finds no issue to check transitions on', async () => {
    signIn();
    jira.reset();
    writeConfig({ transitions: { started: 'In Progress' } });
    const { out } = await doctor();
    expect(line(out, 'jira transitions')).toMatch(/^warn {2}jira transitions — no issue to check transitions on$/);
  });

  it('has no transitions check when the map is empty', async () => {
    signIn();
    const { out } = await doctor();
    expect(out).not.toMatch(/jira transitions/);
  });

  it('fails when JIRA_CLIENT_ID or JIRA_CLIENT_SECRET is missing, naming only the names', async () => {
    signIn();
    envFile('JIRA_CLIENT_ID=only-the-id-value\n');
    const { code, out } = await doctor();
    expect(code).toBe(1);
    expect(line(out, 'jira app keys')).toMatch(/^FAIL {2}jira app keys — missing: JIRA_CLIENT_SECRET \(set in \.env\.foreman or the environment/);
    expect(out).not.toContain('only-the-id-value');
  });

  it("takes the app keys from Foreman's own keys file", async () => {
    signIn();
    fs.rmSync(path.join(dir, '.env.local'));
    fs.writeFileSync(path.join(dir, '.env.foreman'), `JIRA_CLIENT_ID=${jira.fake.clientId}\nJIRA_CLIENT_SECRET=${jira.fake.clientSecret}\n`, { mode: 0o600 });
    const { out } = await doctor();
    expect(out).toMatch(/^ok {4}jira app keys$/m);
    expect(out).toMatch(/^ok {4}foreman keys placement$/m);
    expect(out).not.toContain(jira.fake.clientSecret);
  });

  it('takes the app keys from the environment too', async () => {
    signIn();
    fs.rmSync(path.join(dir, '.env.local'));
    const { out } = await doctor({ JIRA_CLIENT_ID: jira.fake.clientId, JIRA_CLIENT_SECRET: jira.fake.clientSecret });
    expect(out).toMatch(/^ok {4}jira app keys$/m);
  });

  it('fails on bad Jira options instead of crashing', async () => {
    writeConfig({ site: 'not a host' });
    const { code, out } = await doctor();
    expect(code).toBe(1);
    expect(line(out, 'jira options')).toMatch(/^FAIL {2}jira options — stories\.site: /);
    expect(out).not.toMatch(/crashed/);
  });

  it('has no Jira checks for the markdown source', async () => {
    fs.writeFileSync(path.join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'P' } }));
    const { out } = await doctor();
    // The keys placement warning may name JIRA_CLIENT_ID in .env.local; no check is about Jira.
    expect(out).not.toMatch(/^(ok|warn|FAIL) +jira/im);
  });
});

describe('foreman doctor: Jira fix hints', () => {
  // The Jira results as the doctor builds them, by check name.
  async function results() {
    const env = { HOME: home, FOREMAN_JIRA_AUTH_BASE: jira.url, FOREMAN_JIRA_API_BASE: jira.url };
    const { config, ctx } = doctorContext({ root: dir, cwd: dir, env, sh, sourceRoot: source, fetch: globalThis.fetch, now: () => NOW });
    const out = {};
    for (const check of buildChecks(config, ctx)) if (check.name.startsWith('jira')) out[check.name] = { step: check.step, ...(await check.run(ctx)) };
    return out;
  }

  it('sends a missing sign-in to the Jira sign-in step, with the login action', async () => {
    const res = await results();
    expect(res['jira signed in'].fix).toMatchObject({ step: 'jira-signin', action: 'jira-login' });
    expect(res['jira signed in'].fix.hint).toMatch(/foreman jira login/);
    expect(res['jira JQL']).toMatchObject({ level: 'warn', fix: { step: 'jira-signin' } });
    expect(res['jira JQL'].fix.hint).toMatch(/sign in to Jira first/);
    expect(res['jira sign-in age'].fix.step).toBe('jira-signin');
  });

  it('sends missing app keys to the Jira app step, naming the names only', async () => {
    signIn();
    envFile('JIRA_CLIENT_ID=only-the-id-value\n');
    const res = await results();
    expect(res['jira app keys'].fix.step).toBe('jira-app');
    expect(res['jira app keys'].fix.hint).toBe('add JIRA_CLIENT_ID and JIRA_CLIENT_SECRET to .env.foreman');
    expect(res['jira app keys'].detail).not.toMatch(/README/);
    expect(JSON.stringify(res)).not.toContain('only-the-id-value');
  });

  it('sends a failing JQL to the Jira site step', async () => {
    signIn();
    writeConfig({ jql: 'project = INVALID' });
    const res = await results();
    expect(res['jira JQL']).toMatchObject({ ok: false, level: 'error', fix: { step: 'jira-site' } });
    expect(res['jira JQL'].fix.hint).toMatch(/stories\.jql/);
  });

  it('prints the fix line under the FAIL, naming the set-up step', async () => {
    const { out } = await doctor();
    expect(out).toMatch(/^FAIL {2}jira signed in — .*\n {6}fix: sign in with `foreman jira login` \(dashboard: Set up › Jira sign-in\)$/m);
  });
});

describe('foreman doctor: local settings', () => {
  const md = () => fs.writeFileSync(path.join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'P' } }));
  const local = (text) => {
    fs.mkdirSync(path.join(dir, '.foreman'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.foreman', 'settings.json'), text);
  };

  it('is ok with no local settings', async () => {
    md();
    const { out } = await doctor();
    expect(out).toMatch(/^ok {4}local settings$/m);
  });

  it('warns once for each ignored local value, naming the setting and why', async () => {
    md();
    local(JSON.stringify({ workers: 99, 'no.such': 1, 'features.followUps': false, 'stories.jql': 'x' }));
    const { code, out } = await doctor();
    expect(code).toBe(0);
    const warns = out.split('\n').filter((l) => l.startsWith('warn  local settings'));
    expect(warns).toHaveLength(3);
    expect(out).toMatch(/^warn {2}local settings — local setting workers ignored: .+$/m);
    expect(out).toMatch(/^warn {2}local settings — local setting no\.such ignored: unknown setting$/m);
    expect(out).toMatch(/^warn {2}local settings — local setting stories\.jql ignored: applies only when .+$/m);
    expect(out).not.toMatch(/followUps/);
  });

  it('warns when the settings file is broken', async () => {
    md();
    local('{ nope');
    const { out } = await doctor();
    expect(out).toMatch(/^warn {2}local settings — .*settings\.json is not valid JSON/m);
  });

  it('reads the config through the local layer', async () => {
    signIn();
    local(JSON.stringify({ 'stories.jql': 'project = INVALID' }));
    const { code, out } = await doctor();
    expect(code).toBe(1);
    expect(line(out, 'jira JQL')).toMatch(/^FAIL {2}jira JQL — the JQL fails/);
  });
});
