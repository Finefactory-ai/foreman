// GET and POST /api/settings: the settings panel's API, through the same
// module as `foreman settings` (lib/settings/change.mjs).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardServer } from './server.mjs';
import { loadConfig } from '../config/load.mjs';
import { settingsView } from '../settings/change.mjs';
import { liveSettings } from '../engine/live-settings.mjs';

const TOKEN = 'sekret-token-0123456789abcdef';
const BASE = { version: 1, project: { name: 'T' }, slots: 3, checks: [{ run: 'true', when: 'always' }] };

let dir;
let state;
let servers;

const configFile = () => join(dir, 'foreman.config.json');
const localFile = () => join(state, 'settings.json');
const teamRaw = () => JSON.parse(readFileSync(configFile(), 'utf8'));
const local = () => JSON.parse(readFileSync(localFile(), 'utf8'));

function project(extra = {}) {
  writeFileSync(configFile(), `${JSON.stringify({ ...BASE, ...extra }, null, 2)}\n`);
  return loadConfig(dir).config;
}

async function start({ host = '127.0.0.1', env = {}, config = project(), sh } = {}) {
  const cfg = { ...config, console: { ...config.console, host } };
  const server = createDashboardServer({ root: dir, config: cfg, stateDir: state, env, sh, now: () => new Date('2026-10-17T09:00:00Z') });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, host, resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

const post = (url, body, headers = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const getSettings = async (base, headers = {}) => (await fetch(`${base}/api/settings`, { headers })).json();
const row = (body, name) => body.settings.find((s) => s.name === name);
const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foreman-settings-api-'));
  state = join(dir, '.foreman');
  servers = [];
});
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((resolve) => (s.listening ? s.close(() => resolve()) : resolve()))));
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/settings', () => {
  it('lists the settings that apply, with value, source, limits and when each applies', async () => {
    const base = await start({ config: project({ rounds: 5 }) });
    const res = await fetch(`${base}/api/settings`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body.groups.map((g) => g.name)).toEqual(['run', 'models', 'features', 'learning', 'release', 'console']);
    expect(body.groups[0]).toEqual({ name: 'run', label: 'Run' });
    expect(body.groups[3]).toEqual({ name: 'learning', label: 'Learning' });
    expect(row(body, 'learning.auto')).toMatchObject({ type: 'boolean', value: true, source: 'default', group: 'learning' });
    expect(row(body, 'workers')).toEqual({
      name: 'workers',
      label: 'Workers',
      description: expect.any(String),
      type: 'integer',
      default: 1,
      limits: { min: 1, max: 3 },
      applies: 'next-story',
      group: 'run',
      value: 1,
      source: 'default',
    });
    expect(row(body, 'rounds')).toMatchObject({ value: 5, source: 'team', limits: { min: 1, max: 10 } });
    expect(row(body, 'features.followUps')).toMatchObject({ type: 'boolean', value: true, source: 'default', limits: {} });
    expect(row(body, 'watchdog.quietMinutes').limits).toEqual({ above: 0 });
    // The Jira, watch and email settings mean nothing for this project, so they are left out.
    expect(body.settings.some((s) => s.group === 'jira' || s.name.startsWith('ship.watch') || s.name === 'notify.to')).toBe(false);
    expect(body.configDirty).toBe(false);
    expect(body.warnings).toEqual([]);
  });

  it('shows the Jira settings, with the allowed map keys, when the stories come from Jira', async () => {
    const base = await start({ config: project({ stories: { adapter: 'jira', site: 'acme.atlassian.net', jql: 'project = X' } }) });
    const body = await getSettings(base);
    expect(body.groups.map((g) => g.name)).toContain('jira');
    expect(row(body, 'stories.transitions')).toMatchObject({ type: 'map', limits: { keys: ['started', 'blocked', 'review', 'failed', 'shipped'] }, value: {} });
    expect(row(body, 'stories.jql')).toMatchObject({ value: 'project = X', source: 'team' });
  });

  it('marks a local value that is ignored, and says why', async () => {
    project();
    mkdirSync(state, { recursive: true });
    writeFileSync(localFile(), JSON.stringify({ workers: 9, 'features.followUps': false }));
    const base = await start();
    const body = await getSettings(base);
    expect(row(body, 'workers')).toMatchObject({ value: 1, source: 'default', warning: 'must be a whole number from 1 to 3' });
    expect(row(body, 'features.followUps')).toMatchObject({ value: false, source: 'local' });
    expect(row(body, 'features.followUps')).not.toHaveProperty('warning');
    expect(body.warnings).toEqual(['local setting workers ignored: must be a whole number from 1 to 3']);
  });

  it('agrees with what `foreman settings list` reads', async () => {
    const base = await start({ config: project({ rounds: 4 }) });
    const body = await getSettings(base);
    const cli = settingsView({ root: dir, env: {} });
    expect(body.settings.map((s) => [s.name, s.value, s.source])).toEqual(cli.rows.map((r) => [r.name, r.value, r.source]));
  });
});

describe('the agent models', () => {
  const NAMES = ['roles.architect.model', 'roles.builders.developer.model', 'roles.tester.model', 'roles.reviewers.compliance.model', 'roles.reviewers.security.model'];

  it('lists one model dropdown per configured role, under Agent models', async () => {
    const base = await start();
    const body = await getSettings(base);
    expect(body.groups[1]).toEqual({ name: 'models', label: 'Agent models' });
    const rows = body.settings.filter((s) => s.group === 'models');
    expect(rows.map((s) => [s.name, s.label])).toEqual([
      ['session.model', 'Story session model'],
      ['roles.architect.model', 'Architect'],
      ['roles.builders.developer.model', 'Builder: developer'],
      ['roles.tester.model', 'Tester'],
      ['roles.reviewers.compliance.model', 'Reviewer: compliance'],
      ['roles.reviewers.compliance.engine', 'Reviewer: compliance engine'],
      ['roles.reviewers.security.model', 'Reviewer: security'],
      ['roles.reviewers.security.engine', 'Reviewer: security engine'],
    ]);
    const models = rows.filter((s) => s.name.endsWith('.model'));
    for (const s of models) {
      const unset = s.name === 'session.model' ? 'The Claude CLI default' : 'Same as the story session';
      expect(s, s.name).toMatchObject({ type: 'enum', default: null, value: null, source: 'default', unset, limits: { values: ['haiku', 'sonnet', 'opus', 'fable'] } });
    }
    for (const s of rows.filter((s) => s.name.endsWith('.engine'))) {
      expect(s, s.name).toMatchObject({ type: 'string', default: null, value: null, source: 'default', inFile: `the reviewer named ${s.name.split('.')[2]} in roles.reviewers` });
      expect(s).not.toHaveProperty('unset');
    }
    expect(row(body, 'workers')).not.toHaveProperty('unset');
  });

  it('lists the roles the project names, and no others', async () => {
    const base = await start({ config: project({ roles: { reviewers: [{ name: 'perf', agent: 'acme:perf' }] } }) });
    const names = (await getSettings(base)).settings.filter((s) => s.group === 'models').map((s) => s.name);
    expect(names).toEqual(['session.model', 'roles.architect.model', 'roles.builders.developer.model', 'roles.tester.model', 'roles.reviewers.perf.model', 'roles.reviewers.perf.engine']);
    expect(names).not.toContain(NAMES[4]);
  });

  it("saves a reviewer's engine for the team as its engine block, shows it as engine:model, and a reset removes the block", async () => {
    const base = await start();
    let res = await post(`${base}/api/settings`, { name: 'roles.reviewers.security.engine', value: 'antigravity:claude-opus-4-6-thinking', layer: 'team' });
    expect(res.status).toBe(200);
    expect((await res.json()).setting).toMatchObject({ name: 'roles.reviewers.security.engine', value: 'antigravity:claude-opus-4-6-thinking', source: 'team' });
    expect(teamRaw().roles.reviewers[1]).toEqual({ name: 'security', agent: 'foreman:security-reviewer', engine: { name: 'antigravity', model: 'claude-opus-4-6-thinking' } });
    expect(row(await getSettings(base), 'roles.reviewers.security.engine')).toMatchObject({ value: 'antigravity:claude-opus-4-6-thinking', source: 'team' });

    res = await post(`${base}/api/settings`, { name: 'roles.reviewers.security.engine', value: 'cursor:gpt-5', layer: 'team' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('roles.reviewers.security.engine: expected engine:model, the engine being antigravity, such as antigravity:claude-opus-4-6-thinking');

    res = await post(`${base}/api/settings`, { name: 'roles.reviewers.security.engine', reset: true, layer: 'team' });
    expect(res.status).toBe(200);
    expect(teamRaw().roles.reviewers[1]).toEqual({ name: 'security', agent: 'foreman:security-reviewer' });
  });

  it('saves a team model as only that role model, and a reset removes it', async () => {
    const base = await start();
    let res = await post(`${base}/api/settings`, { name: 'roles.architect.model', value: 'opus', layer: 'team' });
    expect(res.status).toBe(200);
    expect((await res.json()).setting).toMatchObject({ name: 'roles.architect.model', value: 'opus', source: 'team' });
    expect(teamRaw()).toEqual({ ...BASE, roles: { architect: { agent: 'foreman:architect', model: 'opus' } } });

    res = await post(`${base}/api/settings`, { name: 'roles.architect.model', reset: true, layer: 'team' });
    expect(res.status).toBe(200);
    expect((await res.json()).setting).toMatchObject({ value: null, source: 'default' });
    expect(teamRaw()).toEqual({ ...BASE, roles: { architect: { agent: 'foreman:architect' } } });
  });

  it('saves and resets a local model', async () => {
    const base = await start();
    expect((await post(`${base}/api/settings`, { name: 'roles.reviewers.security.model', value: 'haiku', layer: 'local' })).status).toBe(200);
    expect(local()).toEqual({ 'roles.reviewers.security.model': 'haiku' });
    expect((await post(`${base}/api/settings`, { name: 'roles.reviewers.security.model', reset: true, layer: 'local' })).status).toBe(200);
    expect(local()).toEqual({});
  });

  it('refuses a role the project lacks, and a model that is not allowed, with 400', async () => {
    const base = await start();
    const before = readFileSync(configFile(), 'utf8');
    for (const [body, why] of [
      [{ name: 'roles.reviewers.ux.model', value: 'opus', layer: 'team' }, /applies only when the project has a reviewer named ux/],
      [{ name: 'roles.builders.ghost.model', reset: true, layer: 'local' }, /applies only when the project has a builder named ghost/],
      [{ name: 'roles.tester.model', value: 'gpt', layer: 'team' }, /must be one of haiku, sonnet, opus, fable/],
    ]) {
      const res = await post(`${base}/api/settings`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).error, JSON.stringify(body)).toMatch(why);
    }
    expect(readFileSync(configFile(), 'utf8')).toBe(before);
    expect(existsSync(localFile())).toBe(false);
  });
});

describe('POST /api/settings', () => {
  it('sets and resets a local value, in the local layer only', async () => {
    const base = await start();
    const before = readFileSync(configFile(), 'utf8');
    let res = await post(`${base}/api/settings`, { name: 'features.followUps', value: false, layer: 'local' });
    expect(res.status).toBe(200);
    let body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.setting).toMatchObject({ name: 'features.followUps', value: false, source: 'local' });
    expect(body.lines).toEqual(['features.followUps = false (local; applies next-story)']);
    expect(local()).toEqual({ 'features.followUps': false });
    expect(readFileSync(configFile(), 'utf8')).toBe(before);
    expect(settingsView({ root: dir, env: {} }).rows.find((r) => r.name === 'features.followUps')).toMatchObject({ value: false, source: 'local' });

    res = await post(`${base}/api/settings`, { name: 'features.followUps', reset: true, layer: 'local' });
    expect(res.status).toBe(200);
    body = await res.json();
    expect(body.setting).toMatchObject({ value: true, source: 'default' });
    expect(local()).toEqual({});
  });

  it('sets and resets a team value in foreman.config.json, keeping 2-space formatting', async () => {
    const base = await start();
    let res = await post(`${base}/api/settings`, { name: 'workers', value: 2, layer: 'team' });
    expect(res.status).toBe(200);
    let body = await res.json();
    expect(body.setting).toMatchObject({ name: 'workers', value: 2, source: 'team' });
    expect(body.lines).toContain('foreman.config.json changed; commit it so the team gets it');
    expect(teamRaw()).toEqual({ ...BASE, workers: 2 });
    expect(readFileSync(configFile(), 'utf8')).toBe(`${JSON.stringify({ ...BASE, workers: 2 }, null, 2)}\n`);
    expect(existsSync(localFile())).toBe(false);

    res = await post(`${base}/api/settings`, { name: 'workers', reset: true, layer: 'team' });
    expect(res.status).toBe(200);
    body = await res.json();
    expect(body.setting).toMatchObject({ value: 1, source: 'default' });
    expect(teamRaw()).toEqual(BASE);
  });

  it('takes every type the panel edits', async () => {
    const base = await start({ config: project({ stories: { adapter: 'jira', site: 'acme.atlassian.net', jql: 'project = X' } }) });
    for (const [name, value] of [
      ['watchdog.quietMinutes', 12.5],
      ['ship.smoke.urls', ['https://a.example/', 'https://b.example/health']],
      ['stories.transitions', { started: 'In Progress', shipped: 'Done' }],
      ['console.host', 'localhost'],
    ]) {
      const res = await post(`${base}/api/settings`, { name, value, layer: 'local' });
      expect(res.status, name).toBe(200);
      expect((await res.json()).setting, name).toMatchObject({ value, source: 'local' });
    }
  });

  it('refuses what the CLI refuses with 400 and the reason, and writes nothing', async () => {
    const base = await start();
    const before = readFileSync(configFile(), 'utf8');
    for (const [body, why] of [
      [{ name: 'nope', value: 1, layer: 'local' }, /unknown setting: nope/],
      [{ name: 'jira.apiToken', value: 'x', layer: 'local' }, /looks like a secret/],
      [{ name: 'stories.jql', value: 'project = X', layer: 'local' }, /applies only when stories.adapter is "jira"/],
      [{ name: 'stories.jql', reset: true, layer: 'local' }, /applies only when stories.adapter is "jira"/],
      [{ name: 'features.followUps', value: 'off', layer: 'local' }, /expected true or false/],
      [{ name: 'workers', value: '2', layer: 'local' }, /whole number/],
      [{ name: 'workers', value: 9, layer: 'local' }, /from 1 to 3/],
      [{ name: 'workers', value: 1.5, layer: 'team' }, /whole number/],
      [{ name: 'rounds', layer: 'local' }, /whole number/],
      [{ name: 'ship.smoke.urls', value: ['ok', ''], layer: 'local' }, /list of non-empty text/],
      [{ name: 'workers', value: 2, layer: 'everyone' }, /layer must be local or team/],
      [{ name: 'workers', value: 2 }, /layer must be local or team/],
      [{ value: 2, layer: 'local' }, /which setting/i],
      [{ name: ['workers'], value: 2, layer: 'local' }, /which setting/i],
    ]) {
      const res = await post(`${base}/api/settings`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).error, JSON.stringify(body)).toMatch(why);
    }
    expect(existsSync(localFile())).toBe(false);
    expect(readFileSync(configFile(), 'utf8')).toBe(before);
  });

  it('refuses a team change that would make the config invalid', async () => {
    const base = await start();
    expect((await post(`${base}/api/settings`, { name: 'workers', value: 3, layer: 'team' })).status).toBe(200);
    const before = readFileSync(configFile(), 'utf8');
    const res = await post(`${base}/api/settings`, { name: 'slots', value: 1, layer: 'team' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/foreman.config.json would be invalid: workers/);
    expect(readFileSync(configFile(), 'utf8')).toBe(before);
  });

  it('keeps the rules /api/control has: JSON only, same origin, 64 KB, POST or GET', async () => {
    const base = await start();
    let res = await fetch(`${base}/api/settings`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"name":"workers","value":2,"layer":"local"}' });
    expect(res.status).toBe(415);
    res = await post(`${base}/api/settings`, { name: 'workers', value: 2, layer: 'local' }, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    res = await fetch(`${base}/api/settings`, { headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
    res = await post(`${base}/api/settings`, { name: 'workers', value: 2, layer: 'local', pad: 'x'.repeat(70 * 1024) });
    expect(res.status).toBe(413);
    expect((await post(`${base}/api/settings`, '{not json')).status).toBe(400);
    expect((await post(`${base}/api/settings`, [])).status).toBe(400);
    res = await fetch(`${base}/api/settings`, { method: 'PUT' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, POST');
    expect(existsSync(localFile())).toBe(false);
  });

  it('refuses a request addressed to another host name on 127.0.0.1', async () => {
    const base = await start();
    const { request } = await import('node:http');
    const status = await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: new URL(base).port, path: '/api/settings', headers: { host: 'evil.example' } }, (r) => { r.resume(); resolve(r.statusCode); });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it('on another host, needs the bearer token for both, and never as ?token= on a POST', async () => {
    const base = await start({ host: '0.0.0.0', env: { FOREMAN_DASHBOARD_TOKEN: TOKEN } });
    const auth = { authorization: `Bearer ${TOKEN}` };
    expect((await fetch(`${base}/api/settings`)).status).toBe(401);
    expect((await fetch(`${base}/api/settings`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await post(`${base}/api/settings`, { name: 'workers', value: 2, layer: 'local' })).status).toBe(401);
    expect((await post(`${base}/api/settings?token=${TOKEN}`, { name: 'workers', value: 2, layer: 'local' })).status).toBe(401);
    expect(existsSync(localFile())).toBe(false);

    const got = await fetch(`${base}/api/settings`, { headers: auth });
    expect(got.status).toBe(200);
    expect(await got.text()).not.toContain(TOKEN);
    const res = await post(`${base}/api/settings`, { name: 'workers', value: 2, layer: 'local' }, auth);
    expect(res.status).toBe(200);
    expect(local()).toEqual({ workers: 2 });
  });
});

describe('configDirty', () => {
  it('follows git status for foreman.config.json in a real repository', async () => {
    project();
    expect(git('init', '-q').status).toBe(0);
    git('-c', 'user.email=t@example.com', '-c', 'user.name=T', 'add', 'foreman.config.json');
    expect(git('-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'config').status).toBe(0);
    const base = await start({ config: loadConfig(dir).config });
    expect((await getSettings(base)).configDirty).toBe(false);

    // A local change leaves the file alone.
    let res = await post(`${base}/api/settings`, { name: 'features.followUps', value: false, layer: 'local' });
    expect((await res.json()).configDirty).toBe(false);
    expect((await getSettings(base)).configDirty).toBe(false);

    // A team change shows until the file is committed.
    res = await post(`${base}/api/settings`, { name: 'workers', value: 2, layer: 'team' });
    expect((await res.json()).configDirty).toBe(true);
    expect((await getSettings(base)).configDirty).toBe(true);
    git('-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-am', 'workers');
    expect((await getSettings(base)).configDirty).toBe(false);
  });

  it('is false outside a git repository', async () => {
    const base = await start();
    expect((await getSettings(base)).configDirty).toBe(false);
  });

  it('asks git through the injected sh, in the project root, for that one file', async () => {
    const calls = [];
    const sh = (cmd, args, opts) => {
      calls.push([cmd, args, opts.cwd]);
      return { status: 0, stdout: ' M foreman.config.json\n' };
    };
    const base = await start({ sh });
    expect((await getSettings(base)).configDirty).toBe(true);
    expect(calls).toEqual([['git', ['status', '--porcelain', '--', 'foreman.config.json'], dir]]);
  });

  it('is false when git fails', async () => {
    const base = await start({ sh: () => ({ status: 128, stdout: '' }) });
    expect((await getSettings(base)).configDirty).toBe(false);
    const thrower = await start({ sh: () => { throw new Error('no git'); } });
    expect((await getSettings(thrower)).configDirty).toBe(false);
  });
});

// The dashboard's worker control now writes the `workers` setting's local layer; the
// supervisor reloads the settings before each pick (lib/engine/live-settings.mjs).
describe('workers from the dashboard reach the supervisor', () => {
  it('a local workers change made on the dashboard applies at the next pick', async () => {
    const base = await start();
    const live = liveSettings({ root: dir, dir: state, env: {}, slots: 3 });
    let { workers } = live.startWorkers(null);
    expect(workers).toBe(1);
    expect(live.beforePick({ current: workers }).workers).toBe(1);

    const res = await post(`${base}/api/settings`, { name: 'workers', value: 2, layer: 'local' });
    expect(res.status).toBe(200);
    const later = new Date(Date.now() + 5000);
    utimesSync(localFile(), later, later);

    const tick = live.beforePick({ current: workers });
    expect(tick.workers).toBe(2);
    expect(tick.events).toContainEqual({ text: 'Worker count set to 2 in the settings; applied at the next pick.', kind: 'info' });
    workers = tick.workers;

    // and a team change on the dashboard does too, once the local value is gone
    await post(`${base}/api/settings`, { name: 'workers', reset: true, layer: 'local' });
    await post(`${base}/api/settings`, { name: 'workers', value: 3, layer: 'team' });
    const evenLater = new Date(Date.now() + 10000);
    utimesSync(localFile(), evenLater, evenLater);
    utimesSync(configFile(), evenLater, evenLater);
    expect(live.beforePick({ current: workers }).workers).toBe(3);
  });

  it('`foreman workers` through /api/control still works for the CLI and old pages', async () => {
    const base = await start();
    const res = await post(`${base}/api/control`, { action: 'workers', n: 2 });
    expect(res.status).toBe(200);
    expect(JSON.parse(readFileSync(join(state, 'control.json'), 'utf8')).workers).toBe(2);
  });
});
