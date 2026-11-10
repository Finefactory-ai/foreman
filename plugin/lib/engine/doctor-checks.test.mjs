import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildChecks, parsePluginList, requirements } from './doctor-checks.mjs';
import { copyWarning, ownCopy } from './plugin-copy.mjs';
import { withDefaults } from '../config/defaults.mjs';
import { fakePack } from '../../../test/fake-pack.mjs';
import { stepById } from '../setup/steps.mjs';
import { openService } from './service.mjs';
import { ADOPTED_FILE, markStopped, writeAdopted } from './supervisor-pid.mjs';
import { nextStory, readControl } from '../console/control.mjs';
import { saveState } from './state.mjs';
import { writeInterrupt } from './signal-source.mjs';
import { claimFile, forceSet, ownerClaim } from './locks.mjs';
import { writeRun } from './run-record.mjs';
import { GEARSET_STEPS } from '../../packs/salesforce/config.mjs';

const SECRET = 'sk-super-secret-value-123';
let dir;
let source;
let plugins;

const PLUGIN_LIST = (extra = '') => `Installed plugins:\n\n  ❯ foreman@foreman\n    Version: 0.1.0\n    Scope: project\n    Status: ✔ enabled\n${extra}\n`;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-doctor-'));
  source = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-src-'));
  plugins = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-plugins-'));
  fs.mkdirSync(path.join(source, '.claude-plugin'));
  fs.writeFileSync(path.join(source, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'foreman', version: '0.1.0' }));
});

// A fake shell: `answers` maps "cmd arg arg" (prefix match) to a result.
function fakeSh(answers = {}) {
  const calls = [];
  const sh = (cmd, args = []) => {
    const line = [cmd, ...args].join(' ');
    calls.push(line);
    const key = Object.keys(answers).find((k) => line === k || line.startsWith(`${k} `));
    const hit = key !== undefined ? answers[key] : { status: 0, stdout: '', stderr: '' };
    return { status: 0, stdout: '', stderr: '', ...hit };
  };
  sh.calls = calls;
  return sh;
}

const HAPPY = () => ({ 'claude plugin list': { stdout: PLUGIN_LIST() }, 'claude --version': { stdout: '2.0.0' } });

function ctxFor(answers, extra = {}) {
  return { root: dir, env: {}, sh: fakeSh({ ...HAPPY(), ...answers }), fs, sourceRoot: source, pluginsDir: plugins, ...extra };
}

async function results(config, ctx) {
  const out = {};
  for (const check of buildChecks(config, ctx)) out[check.name] = await check.run(ctx);
  return out;
}
const named = (res, part) => Object.entries(res).find(([n]) => n.includes(part))?.[1];
const cfg = (over = {}) => withDefaults({ version: 1, project: { name: 'P' }, checks: [{ run: 'npm test', when: 'always' }], ...over });

describe('doctor checks', () => {
  it('passes on a healthy setup, with warnings only for what cannot be detected', async () => {
    const res = await results(cfg(), ctxFor({}));
    const failed = Object.entries(res).filter(([, r]) => !r.ok && r.level === 'error');
    expect(failed).toEqual([]);
    expect(named(res, 'workflows').ok).toBe(false);
    expect(named(res, 'workflows').level).toBe('warn');
    expect(named(res, 'workflows').detail).toMatch(/paid plan|API/);
    expect(named(res, 'workflows').detail).toMatch(/\/config/);
  });

  it('fails when the config is invalid', async () => {
    const ctx = ctxFor({}, { configErrors: [{ path: 'slots', message: 'must be a number' }] });
    const res = await results(null, ctx);
    const r = named(res, 'config');
    expect(r).toMatchObject({ ok: false, level: 'error' });
    expect(r.detail).toContain('slots: must be a number');
  });

  it('fails when the remote is missing', async () => {
    const res = await results(cfg(), ctxFor({ 'git remote get-url origin': { status: 2 } }));
    expect(named(res, 'remote')).toMatchObject({ ok: false, level: 'error' });
    expect(named(res, 'remote').detail).toContain('origin');
  });

  it('fails when gh is not signed in', async () => {
    const res = await results(cfg(), ctxFor({ 'gh auth status': { status: 1 } }));
    expect(named(res, 'gh')).toMatchObject({ ok: false, level: 'error' });
  });

  it('fails when claude is not on the PATH', async () => {
    const res = await results(cfg(), ctxFor({ 'claude --version': { status: 127 } }));
    expect(named(res, 'claude on PATH')).toMatchObject({ ok: false, level: 'error' });
  });

  it('checks the review engine CLI only when a reviewer has an engine', async () => {
    const none = await results(cfg(), ctxFor({}));
    expect(named(none, 'review engine')).toBeUndefined();
    const config = cfg({ roles: { reviewers: [{ name: 'security', agent: 'foreman:security-reviewer', engine: { name: 'antigravity', model: 'm' } }] } });
    expect(named(await results(config, ctxFor({ 'agy --version': { status: 0, stdout: '1.4.12' } })), 'review engine')).toMatchObject({ ok: true });
    const res = await results(config, ctxFor({ 'agy --version': { status: 1, error: new Error('not found') } }));
    expect(named(res, 'review engine')).toMatchObject({ ok: false, level: 'warn' });
    expect(named(res, 'review engine').detail).toMatch(/agy/);
  });

  it('fails when an always check fails, and skips non-always ones', async () => {
    const config = cfg({ checks: [{ run: 'npm test', when: 'always' }, { run: 'npm run e2e', when: 'e2e/**' }] });
    const ctx = ctxFor({ 'sh -c npm test': { status: 3, stdout: SECRET } });
    const res = await results(config, ctx);
    expect(named(res, 'npm test')).toMatchObject({ ok: false, level: 'error' });
    expect(JSON.stringify(res)).not.toContain(SECRET);
    expect(ctx.sh.calls.some((c) => c.includes('e2e'))).toBe(false);
  });

  describe('env variables', () => {
    const notify = { notify: { adapter: 'email-resend' } };

    it('names the missing variable and never prints a value', async () => {
      fs.writeFileSync(path.join(dir, '.env.local'), `RESEND_API_KEY=${SECRET}\nOTHER=1\n`);
      const res = await results(cfg(notify), ctxFor({}));
      const r = named(res, 'env');
      expect(r).toMatchObject({ ok: false, level: 'error' });
      expect(r.detail).toContain('RESEND_FROM_EMAIL');
      expect(r.detail).not.toContain('RESEND_API_KEY');
      expect(JSON.stringify(res)).not.toContain(SECRET);
    });

    it('is satisfied by the envFile, the process environment, or both', async () => {
      fs.writeFileSync(path.join(dir, '.env.local'), `# note\nexport RESEND_API_KEY="${SECRET}"\n`);
      const res = await results(cfg(notify), ctxFor({}, { env: { RESEND_FROM_EMAIL: 'a@b.c' } }));
      expect(named(res, 'env').ok).toBe(true);
      expect(JSON.stringify(res)).not.toContain(SECRET);
    });

    it('does not need RESEND_FROM_EMAIL when the config sets from', async () => {
      const config = cfg({ notify: { adapter: 'email-resend', from: 'a@b.c' } });
      const res = await results(config, ctxFor({}, { env: { RESEND_API_KEY: 'x' } }));
      expect(named(res, 'env').ok).toBe(true);
    });

    it('passes when no adapter needs variables', async () => {
      expect(named(await results(cfg(), ctxFor({})), 'env').ok).toBe(true);
    });

    it("is satisfied by Foreman's keys in .env.foreman", async () => {
      fs.writeFileSync(path.join(dir, '.env.foreman'), `RESEND_API_KEY=${SECRET}\nRESEND_FROM_EMAIL=acme@example.com\n`);
      const res = await results(cfg(notify), ctxFor({}));
      expect(named(res, 'env').ok).toBe(true);
      expect(JSON.stringify(res)).not.toContain(SECRET);
    });

    it("says which file each missing name belongs in", async () => {
      const packs = { acme: fakePack() };
      const config = withDefaults({ version: 1, project: { name: 'Acme' }, pack: 'acme', env: { adapter: 'acme-org' }, ...notify }, { packs });
      const r = named(await results(config, ctxFor({}, { packs, env: { ACME_ORG_KEY: 'x', RESEND_FROM_EMAIL: 'a@b.c' } })), 'env variables');
      expect(r).toMatchObject({ ok: false, level: 'error' });
      expect(r.detail).toBe('missing: RESEND_API_KEY (set in .env.foreman or the environment); ACME_TOKEN (set in .env.local or the environment)');
    });
  });

  describe("Foreman's own keys", () => {
    const local = () => path.join(dir, '.env.local');
    const own = () => path.join(dir, '.env.foreman');
    const gitignore = () => path.join(dir, '.gitignore');
    const notIgnored = { 'git check-ignore -q --no-index .env.foreman': { status: 1 } };

    it('warns, naming them, when .env.local holds the Jira app keys', async () => {
      fs.writeFileSync(local(), `JIRA_CLIENT_ID=${SECRET}\nJIRA_CLIENT_SECRET=${SECRET}\nACME_URL=x\n`);
      const res = await results(cfg(), ctxFor({}));
      expect(res['foreman keys placement']).toMatchObject({
        ok: false,
        level: 'warn',
        detail: 'move JIRA_CLIENT_ID, JIRA_CLIENT_SECRET to .env.foreman: agents can read .env.local; run `foreman keys migrate`',
        fix: { step: 'project-keys', hint: "run `foreman keys migrate` from the project's folder" },
      });
      expect(JSON.stringify(res)).not.toContain(SECRET);
    });

    it('is ok when the keys are only in .env.foreman', async () => {
      fs.writeFileSync(own(), `JIRA_CLIENT_ID=${SECRET}\nJIRA_CLIENT_SECRET=${SECRET}\n`, { mode: 0o600 });
      fs.writeFileSync(local(), 'ACME_URL=x\n');
      const res = await results(cfg(), ctxFor({}));
      expect(res['foreman keys placement'].ok).toBe(true);
      expect(res['foreman keys file'].ok).toBe(true);
    });

    it('uses the configured file names', async () => {
      fs.writeFileSync(path.join(dir, '.env'), 'RESEND_API_KEY=x\n');
      const res = await results(cfg({ envFile: '.env', foremanEnvFile: 'keys.env' }), ctxFor({}));
      expect(res['foreman keys placement'].detail).toBe('move RESEND_API_KEY to keys.env: agents can read .env; run `foreman keys migrate`');
    });

    it('adds .env.foreman to .gitignore when git does not ignore it, outside a story session', async () => {
      fs.writeFileSync(gitignore(), 'node_modules\n');
      const res = await results(cfg(), ctxFor(notIgnored));
      expect(res['foreman keys file']).toEqual({ ok: true, level: 'error', detail: 'added .env.foreman to .gitignore' });
      expect(fs.readFileSync(gitignore(), 'utf8')).toBe('node_modules\n.env.foreman\n');
    });

    it('only warns, and writes nothing, inside a story session', async () => {
      fs.writeFileSync(gitignore(), 'node_modules\n');
      const res = await results(cfg(), ctxFor(notIgnored, { env: { FOREMAN_RUN: '1' } }));
      expect(res['foreman keys file']).toMatchObject({ ok: false, level: 'warn', detail: '.env.foreman is not ignored by git', fix: { step: 'project-keys' } });
      expect(fs.readFileSync(gitignore(), 'utf8')).toBe('node_modules\n');
    });

    it('warns when git cannot say', async () => {
      const res = await results(cfg(), ctxFor({ 'git check-ignore -q --no-index .env.foreman': { status: 128 } }));
      expect(res['foreman keys file']).toMatchObject({ ok: false, level: 'warn' });
      expect(fs.existsSync(gitignore())).toBe(false);
    });

    it('warns when other users can read .env.foreman', async () => {
      fs.writeFileSync(own(), 'RESEND_API_KEY=x\n');
      fs.chmodSync(own(), 0o644);
      const res = await results(cfg(), ctxFor({}));
      expect(res['foreman keys file']).toMatchObject({ ok: false, level: 'warn', detail: '.env.foreman can be read by other users; run chmod 600 .env.foreman', fix: { hint: 'run `chmod 600 .env.foreman`' } });
    });

    it('has neither check without a config', async () => {
      const res = await results(null, ctxFor({}));
      expect(res['foreman keys file']).toBeUndefined();
      expect(res['foreman keys placement']).toBeUndefined();
    });
  });

  describe('claude sign-in', () => {
    const loggedOut = { 'claude auth status --json': { status: 0, stdout: '{"loggedIn":false}' } };

    it('counts ANTHROPIC_API_KEY in .env.foreman', async () => {
      fs.writeFileSync(path.join(dir, '.env.foreman'), `ANTHROPIC_API_KEY=${SECRET}\n`);
      const res = await results(cfg(), ctxFor(loggedOut));
      expect(res['claude sign-in']).toEqual({ ok: true, level: 'error', detail: 'Console API key: per-token billing', kind: 'api-key', login: 'signed-out', fromKey: 'ANTHROPIC_API_KEY' });
      expect(JSON.stringify(res)).not.toContain(SECRET);
    });

    it('never counts one only in .env.local', async () => {
      fs.writeFileSync(path.join(dir, '.env.local'), `ANTHROPIC_API_KEY=${SECRET}\n`);
      const res = await results(cfg(), ctxFor(loggedOut));
      expect(res['claude sign-in'].ok).toBe(false);
    });
  });

  it('fails when a tool the adapters need is missing', async () => {
    const res = await results(cfg(), ctxFor({ 'sh -c command -v gh': { status: 1 } }));
    const r = named(res, 'tools');
    expect(r).toMatchObject({ ok: false, level: 'error' });
    expect(r.detail).toContain('gh');
    expect(r.detail).not.toContain('git');
  });

  describe('docker compose', () => {
    const docker = () => cfg({ env: { adapter: 'docker', projectPrefix: 'app' } });
    it('fails when docker compose is not installed', async () => {
      const res = await results(docker(), ctxFor({ 'docker compose version': { status: 1 } }));
      expect(named(res, 'docker compose')).toMatchObject({ ok: false, level: 'error', detail: 'docker compose is not installed' });
    });
    it('passes when docker compose works', async () => {
      expect(named(await results(docker(), ctxFor({})), 'docker compose').ok).toBe(true);
    });
    it('is not checked for other adapters', async () => {
      const ctx = ctxFor({});
      const res = await results(cfg(), ctx);
      expect(named(res, 'docker compose')).toBeUndefined();
      expect(ctx.sh.calls).not.toContain('docker compose version');
    });
  });

  describe('vercel story previews', () => {
    const vercelCfg = (over = {}) => cfg({ ship: { steps: ['deploy-github'], 'deploy-github': { statusContext: 'Vercel' } }, ...over });
    const write = (body) => fs.writeFileSync(path.join(dir, 'vercel.json'), typeof body === 'string' ? body : JSON.stringify(body));
    const off = { git: { deploymentEnabled: { 'story/*': false } } };

    it('warns when vercel.json lets story branches deploy, and gives the JSON to add', async () => {
      write({ buildCommand: 'npm run build' });
      const res = await results(cfg(), ctxFor({}));
      expect(named(res, 'vercel')).toMatchObject({ ok: false, level: 'warn' });
      expect(named(res, 'vercel').detail).toMatch(/two deployments/);
      expect(named(res, 'vercel').detail).toMatch(/refuses production deployments/);
      expect(named(res, 'vercel').detail).toContain('{"git":{"deploymentEnabled":{"story/*":false}}}');
    });
    it('is ok when story branches are turned off', async () => {
      write(off);
      const res = await results(cfg(), ctxFor({}));
      expect(named(res, 'vercel')).toMatchObject({ ok: true });
    });
    it('uses the configured branch prefix', async () => {
      write(off);
      const res = await results(cfg({ branchPrefix: 'wip/' }), ctxFor({}));
      expect(named(res, 'vercel')).toMatchObject({ ok: false, level: 'warn' });
      expect(named(res, 'vercel').detail).toContain('"wip/*":false');
    });
    it('warns when a Vercel statusContext is set but there is no vercel.json', async () => {
      const res = await results(vercelCfg(), ctxFor({}));
      expect(named(res, 'vercel')).toMatchObject({ ok: false, level: 'warn' });
      expect(named(res, 'vercel').detail).toContain('"story/*":false');
    });
    it('is ok with the statusContext set and the setting present', async () => {
      write(off);
      const res = await results(vercelCfg(), ctxFor({}));
      expect(named(res, 'vercel')).toMatchObject({ ok: true });
    });
    it('warns when vercel.json cannot be parsed', async () => {
      write('{ not json');
      const res = await results(cfg(), ctxFor({}));
      expect(named(res, 'vercel')).toMatchObject({ ok: false, level: 'warn' });
    });
    it('is skipped when the project is not on Vercel', async () => {
      const res = await results(cfg(), ctxFor({}));
      expect(named(res, 'vercel')).toBeUndefined();
    });
  });

  describe('branch protection', () => {
    const api = 'gh api repos/{owner}/{repo}/branches/main/protection';
    it('warns on 404', async () => {
      const res = await results(cfg(), ctxFor({ [api]: { status: 1, stderr: 'gh: Branch not protected (HTTP 404)' } }));
      expect(named(res, 'branch protection')).toMatchObject({ ok: false, level: 'warn' });
      expect(named(res, 'branch protection').detail).toBe('branch protection is off');
    });
    it('says plainly when the plan does not offer it', async () => {
      const res = await results(cfg(), ctxFor({ [api]: { status: 1, stderr: 'Upgrade to GitHub Pro or make this repository public (HTTP 403)' } }));
      expect(named(res, 'branch protection')).toMatchObject({ ok: false, level: 'warn' });
      expect(named(res, 'branch protection').detail).toMatch(/plan/);
    });
    it('warns when the check itself fails', async () => {
      const res = await results(cfg(), ctxFor({ [api]: { status: 1, stderr: 'HTTP 500' } }));
      expect(named(res, 'branch protection')).toMatchObject({ ok: false, level: 'warn' });
      expect(named(res, 'branch protection').detail).toMatch(/could not check/);
    });
    it('is ok when protection is on', async () => {
      expect(named(await results(cfg(), ctxFor({})), 'branch protection').ok).toBe(true);
    });
  });

  describe('plugin', () => {
    it('fails when foreman is not installed', async () => {
      const res = await results(cfg(), ctxFor({ 'claude plugin list': { stdout: 'Installed plugins:\n\n  ❯ other@x\n    Version: 1\n    Status: ✔ enabled\n' } }));
      expect(named(res, 'plugin installed')).toMatchObject({ ok: false, level: 'error' });
    });
    it('fails when foreman is disabled', async () => {
      const list = PLUGIN_LIST().replace('✔ enabled', '✘ disabled');
      const res = await results(cfg(), ctxFor({ 'claude plugin list': { stdout: list } }));
      expect(named(res, 'plugin installed')).toMatchObject({ ok: false, level: 'error' });
      expect(named(res, 'plugin installed').detail).toMatch(/disabled/);
    });
    it('warns, not fails, when plugin list fails', async () => {
      const res = await results(cfg(), ctxFor({ 'claude plugin list': { status: 1 } }));
      expect(named(res, 'plugin installed')).toMatchObject({ ok: false, level: 'warn' });
      expect(named(res, 'plugin fresh')).toMatchObject({ ok: false, level: 'warn' });
    });
  });

  describe('plugin freshness', () => {
    const fakeRepo = () => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-repo-'));
      fs.mkdirSync(path.join(repo, '.git'));
      return repo;
    };
    const cacheDir = () => path.join(plugins, 'cache', 'foreman', 'foreman', '0.1.0');
    const installedAt = (installPath) =>
      fs.writeFileSync(path.join(plugins, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'foreman@foreman': [{ scope: 'user', installPath, version: '0.0.1' }] } }));
    it('warns, in the supervisor\'s words, when the installed copy is not this source', async () => {
      const copyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-copy-'));
      installedAt(copyDir);
      const res = await results(cfg(), ctxFor({}));
      const r = named(res, 'plugin fresh');
      expect(r).toMatchObject({ ok: false, level: 'warn' });
      expect(r.detail).toBe(copyWarning({ copy: { path: copyDir, version: '0.0.1' }, own: ownCopy({ pluginDir: source }) }));
      expect(r.detail).toContain('story sessions load this one with --plugin-dir');
    });
    it('falls through to the usual freshness check when the installed copy is this source', async () => {
      installedAt(source);
      const res = await results(cfg(), ctxFor({}));
      expect(named(res, 'plugin fresh').ok).toBe(true);
      fs.writeFileSync(path.join(source, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '0.2.0' }));
      expect(named(await results(cfg(), ctxFor({})), 'plugin fresh').detail).toMatch(/installed plugin is 0\.1\.0, this source is 0\.2\.0/);
    });
    it('warns when the installed version differs from the source', async () => {
      fs.writeFileSync(path.join(source, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '0.2.0' }));
      const res = await results(cfg(), ctxFor({}));
      expect(named(res, 'plugin fresh')).toMatchObject({ ok: false, level: 'warn' });
      expect(named(res, 'plugin fresh').detail).toContain('0.1.0');
    });
    it('is ok when the plugin is linked to a source folder', async () => {
      const list = PLUGIN_LIST('    Read from: /somewhere\n');
      fs.writeFileSync(path.join(source, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '0.2.0' }));
      const res = await results(cfg(), ctxFor({ 'claude plugin list': { stdout: list } }));
      expect(named(res, 'plugin fresh').ok).toBe(true);
    });
    it('warns when the source has commits newer than the installed copy', async () => {
      const repo = fakeRepo();
      fs.mkdirSync(cacheDir(), { recursive: true });
      const old = new Date(Date.now() - 3600_000);
      fs.utimesSync(cacheDir(), old, old);
      const newer = String(Math.floor(Date.now() / 1000));
      const res = await results(cfg(), ctxFor({ 'git log -1': { stdout: `${newer}\n` } }, { repoRoot: repo }));
      expect(named(res, 'plugin fresh')).toMatchObject({ ok: false, level: 'warn' });
      expect(named(res, 'plugin fresh').detail).toMatch(/older than this source/);
    });
    it('is ok when the installed copy is newer than the last commit', async () => {
      const repo = fakeRepo();
      fs.mkdirSync(cacheDir(), { recursive: true });
      const res = await results(cfg(), ctxFor({ 'git log -1': { stdout: '1000\n' } }, { repoRoot: repo }));
      expect(named(res, 'plugin fresh').ok).toBe(true);
    });
  });

  it('parses plugin list output', () => {
    const list = parsePluginList(`Installed plugins:\n\n  ❯ foreman@mk\n    Version: 1.2.3\n    Read from: /x\n    Scope: project\n    Status: ✘ disabled\n\n  ❯ b@c\n    Version: 2\n    Status: ✔ enabled\n`);
    expect(list).toEqual([
      { id: 'foreman@mk', name: 'foreman', market: 'mk', version: '1.2.3', readFrom: '/x', enabled: false },
      { id: 'b@c', name: 'b', market: 'c', version: '2', readFrom: null, enabled: true },
    ]);
  });
});

describe('doctor: merged code tested', () => {
  const NO_CI = ['merge-main', 'push', 'pr', 'merge'];

  it('says the ci step tests the merged code when the release has one', async () => {
    const r = named(await results(cfg(), ctxFor({})), 'merged code tested');
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('ci');
  });

  it('says Foreman runs the checks on the merged code when there is no CI step', async () => {
    const r = named(await results(cfg({ ship: { steps: NO_CI } }), ctxFor({})), 'merged code tested');
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('no CI step');
  });

  it('warns when there is no CI step and no checks', async () => {
    const r = named(await results(cfg({ ship: { steps: NO_CI }, checks: [] }), ctxFor({})), 'merged code tested');
    expect(r).toMatchObject({ ok: false, level: 'warn' });
    expect(r.fix.hint).toBeTruthy();
    expect(stepById(r.fix.step)).toBeDefined();
  });

  it('says sf-validate tests the merged code on a Salesforce Gearset release', async () => {
    const r = named(await results(cfg({ pack: 'salesforce', ship: { steps: [...GEARSET_STEPS] } }), ctxFor({})), 'merged code tested');
    expect(r.ok).toBe(true);
    expect(r.detail).toBe('sf-validate tests the merged code at release');
  });

  it('warns when ship.steps cannot be read', async () => {
    const r = named(await results(cfg({ ship: { steps: ['merge-main', 'no-such-step'] } }), ctxFor({})), 'merged code tested');
    expect(r).toMatchObject({ ok: false, level: 'warn' });
    expect(r.detail).toContain('could not read ship.steps');
    expect(stepById(r.fix.step)).toBeDefined();
  });
});

describe('doctor: role agents', () => {
  const DEFAULT_AGENTS = ['architect', 'builder', 'tester', 'compliance-reviewer', 'security-reviewer'];
  const put = (folder, name) => {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, `${name}.md`), '---\nname: x\n---\n');
  };
  const shipped = (names = DEFAULT_AGENTS) => names.forEach((n) => put(path.join(source, 'agents'), n));
  const roleAgents = async (config, extra = {}) => named(await results(config, ctxFor({}, extra)), 'role agents');
  const withBuilder = (agent) => cfg({ roles: { builders: { developer: { agent: 'foreman:builder', use: 'x' }, omnistudio: { agent, use: 'x' } } } });

  it('is ok when every default agent ships', async () => {
    shipped();
    expect(await roleAgents(cfg())).toMatchObject({ ok: true });
  });

  it('warns about a builder whose foreman agent is not in the plugin, and says the architect can still pick it', async () => {
    shipped();
    const r = await roleAgents(withBuilder('foreman:sf-omnistudio'));
    expect(r).toMatchObject({ ok: false, level: 'warn' });
    expect(r.detail).toContain('roles.builders.omnistudio names foreman:sf-omnistudio (no agents/sf-omnistudio.md in Foreman)');
    expect(r.detail).toContain('the architect can still pick that builder');
    expect(r.fix.step).toBe('project');
    expect(r.fix.hint).toContain('foreman.config.json');
  });

  it('warns about a missing tester without the builder sentence', async () => {
    shipped(DEFAULT_AGENTS.filter((n) => n !== 'tester'));
    const r = await roleAgents(cfg());
    expect(r).toMatchObject({ ok: false, level: 'warn' });
    expect(r.detail).toContain('roles.tester names foreman:tester');
    expect(r.detail).not.toContain('the architect can still pick');
  });

  it('warns about a missing reviewer and architect, naming each', async () => {
    shipped(['builder', 'tester', 'security-reviewer']);
    const r = await roleAgents(cfg());
    expect(r.detail).toContain('roles.architect names foreman:architect');
    expect(r.detail).toContain('roles.reviewers.compliance names foreman:compliance-reviewer');
    expect(r.detail).toContain('; ');
  });

  it('looks for a plain agent in the project, and is ok once it is there', async () => {
    shipped();
    const config = withBuilder('acme-api');
    const missing = await roleAgents(config);
    expect(missing).toMatchObject({ ok: false, level: 'warn' });
    expect(missing.detail).toContain('(no .claude/agents/acme-api.md in the project)');
    put(path.join(dir, '.claude', 'agents'), 'acme-api');
    expect((await roleAgents(config)).ok).toBe(true);
  });

  it('looks in the home folder only when session.userSettings is true', async () => {
    shipped();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-home-'));
    put(path.join(home, '.claude', 'agents'), 'acme-api');
    const without = await roleAgents(withBuilder('acme-api'), { home });
    expect(without).toMatchObject({ ok: false, level: 'warn' });
    const withUser = await roleAgents({ ...withBuilder('acme-api'), session: { userSettings: true } }, { home });
    expect(withUser.ok).toBe(true);
  });

  it('never checks an agent of another plugin', async () => {
    shipped();
    expect((await roleAgents(withBuilder('acme:reviewer'))).ok).toBe(true);
  });

  it('counts a name that would leave the folder as missing', async () => {
    shipped();
    put(path.join(source, 'agents'), 'x');
    fs.writeFileSync(path.join(source, 'x.md'), 'x');
    for (const agent of ['foreman:../x', 'foreman:..', 'foreman:.', 'foreman:a/b', '../x']) {
      const r = await roleAgents(withBuilder(agent));
      expect(r, agent).toMatchObject({ ok: false, level: 'warn' });
      expect(r.detail, agent).toContain(`roles.builders.omnistudio names ${agent}`);
    }
  });

  it('skips an entry with no agent string', async () => {
    shipped();
    expect((await roleAgents(withBuilder(''))).ok).toBe(true);
    expect((await roleAgents(withBuilder(5))).ok).toBe(true);
  });

  it('runs after merged code tested, and only with a config', () => {
    const names = buildChecks(cfg(), ctxFor({})).map((c) => c.name);
    expect(names.indexOf('role agents')).toBe(names.indexOf('merged code tested') + 1);
    expect(buildChecks(null, ctxFor({})).map((c) => c.name)).not.toContain('role agents');
  });
});

describe('doctor background service', () => {
  let home;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-home-'));
  });
  const mac = (answers = {}, extra = {}) => ctxFor(answers, { platform: 'darwin', home, uid: 501, ...extra });
  const install = (over = {}) =>
    openService({ platform: 'darwin', home, uid: 501, env: {}, sh: fakeSh(), fs, config: cfg(), root: dir, dir: path.join(dir, '.foreman'), ...over }).install();
  const service = async (ctx) => (await results(cfg(), ctx))['background service'];

  it('warns, with the command, when the service is not installed', async () => {
    const r = await service(mac());
    expect(r).toMatchObject({ ok: false, level: 'warn', fix: { step: 'tools', hint: 'run `foreman service install`' } });
    expect(r.detail).toBe('not installed: the factory stops when the terminal or session that started it closes, and after a reboot');
  });

  it('is ok when it runs as a service', async () => {
    install();
    const r = await service(mac({ 'launchctl print gui/501/ai.foreman.p': { stdout: '\tstate = running\n\tpid = 7\n' } }));
    expect(r).toMatchObject({ ok: true, detail: 'runs as a service (ai.foreman.p, pid 7)' });
  });

  it('is ok when `foreman stop` stopped it', async () => {
    install();
    markStopped(path.join(dir, '.foreman'), new Date());
    const r = await service(mac({ 'launchctl print': { stdout: '\tstate = not running\n' } }));
    expect(r).toMatchObject({ ok: true, detail: 'installed (ai.foreman.p), stopped with `foreman stop`' });
  });

  it('warns when it is installed but not running', async () => {
    install();
    const r = await service(mac({ 'launchctl print': { status: 113 } }));
    expect(r).toMatchObject({ ok: false, level: 'warn', fix: { hint: 'run `foreman run`, or read the log' } });
    expect(r.detail).toBe(`installed (ai.foreman.p) but not running; see ${path.join(dir, '.foreman', 'logs', 'supervisor.out')}`);
  });

  it('on macOS, says why the privacy prompts come when the service is installed', async () => {
    install();
    const p = (await results(cfg(), mac({ 'launchctl print gui/501/ai.foreman.p': { stdout: '\tstate = running\n\tpid = 7\n' } })))['macOS privacy prompts'];
    expect(p.ok).toBe(true);
    expect(p.detail).toContain('launchd');
    expect(p.detail).toContain('node');
    expect(p.detail).toContain("Don't Allow");
  });

  it('on macOS, says nothing when the service is not installed', async () => {
    const p = (await results(cfg(), mac()))['macOS privacy prompts'];
    expect(p).toMatchObject({ ok: true, detail: '' });
  });

  it('has no privacy-prompt check off macOS', async () => {
    const out = await results(cfg(), ctxFor({}, { platform: 'linux', home, uid: 501 }));
    expect(out['macOS privacy prompts']).toBeUndefined();
  });

  it('warns when the service runs another copy of Foreman', async () => {
    install({ bin: '/opt/old-foreman/bin/foreman' });
    const r = await service(mac({ 'launchctl print': { stdout: '\tstate = running\n\tpid = 7\n' } }));
    expect(r).toMatchObject({ ok: false, level: 'warn', detail: 'the service runs Foreman from /opt/old-foreman/bin/foreman, not this copy', fix: { hint: 'run `foreman service install` again' } });
  });

  it('warns when the service starts a Node that is not there any more', async () => {
    const gone = '/opt/gone/Cellar/node/26.9.0/bin/node';
    install({ node: gone });
    const r = await service(mac({ 'launchctl print': { stdout: '\tstate = running\n\tpid = 7\n' } }));
    expect(r).toMatchObject({ ok: false, level: 'warn', fix: { hint: 'run `foreman service install` again' } });
    expect(r.detail).toContain(gone);
    expect(r.detail).toContain('not there any more');
  });

  it("warns when the service's Node does not start, naming Homebrew", async () => {
    const node = path.join(dir, 'Cellar', 'node', '26.9.0', 'bin', 'node');
    fs.mkdirSync(path.dirname(node), { recursive: true });
    fs.writeFileSync(node, '');
    install({ node });
    const dyld = 'dyld[4242]: Library not loaded: /opt/homebrew/opt/simdjson/lib/libsimdjson.33.dylib';
    const r = await service(
      mac({
        [`${node} --version`]: { status: 134, stderr: `${dyld}\n  Referenced from: <ACME> ${node}\n` },
        'launchctl print': { stdout: '\tstate = running\n\tpid = 7\n' },
      }),
    );
    expect(r).toMatchObject({ ok: false, level: 'warn' });
    expect(r.detail).toContain(node);
    expect(r.detail).toContain('does not start');
    expect(r.detail).toContain(dyld);
    expect(r.detail).toContain('Homebrew');
    expect(r.fix.hint).toContain('brew reinstall node');
    expect(r.fix.hint).toContain('foreman service install');
  });

  it("does not name Homebrew for a Node that fails for another reason, and checks the bin after the probe", async () => {
    const node = path.join(dir, 'opt', 'acme', 'bin', 'node');
    fs.mkdirSync(path.dirname(node), { recursive: true });
    fs.writeFileSync(node, '');
    install({ node, bin: '/opt/old-foreman/bin/foreman' });
    const r = await service(mac({ [`${node} --version`]: { status: 3, stderr: 'boom' } }));
    expect(r.detail).toBe(`the service starts Node from ${node}, which does not start: exit 3`);
    install({ node, bin: '/opt/old-foreman/bin/foreman' });
    const other = await service(mac({}));
    expect(other.detail).toContain('not this copy');
  });

  it('is ok with no service manager', async () => {
    expect(await service(ctxFor({}, { platform: 'win32', home }))).toMatchObject({ ok: true, detail: 'no service manager on this computer' });
    expect(await service(ctxFor({ 'systemctl --user --version': { status: 1 } }, { platform: 'linux', home, uid: 1000 }))).toMatchObject({ ok: true, detail: 'no service manager on this computer' });
  });
});

describe('doctor stray processes', () => {
  let tmpRoot;
  beforeEach(() => {
    tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-strays-')));
  });
  const stray = async (ctx) => (await results(cfg(), ctx))['stray processes'];
  const SUP = 'node /opt/acme/plugin/lib/engine/supervisor.mjs --max 0';
  const row = (pid, rss, etime) => `${pid} ${rss} ${etime} ${SUP}`;

  it('is ok when ps lists no supervisor', async () => {
    expect(await stray(ctxFor({}))).toEqual({ ok: true, level: 'error', detail: '' });
  });

  it('is ok, saying so, when ps cannot run', async () => {
    expect(await stray(ctxFor({ 'ps -axo': { status: 1 } }))).toMatchObject({ ok: true, detail: 'could not list the running processes' });
  });

  it("warns with the count, where they are, the memory and the command that ends them", async () => {
    const root = fs.realpathSync(dir);
    fs.mkdirSync(path.join(root, '.foreman', 'worktrees', 'w1'), { recursive: true });
    fs.writeFileSync(path.join(root, '.foreman', 'supervisor.pid'), '111\n');
    const rows = [
      [111, 1000, '30:00', root],
      [222, 1024 * 1024, '20:00', path.join(tmpRoot, 'foreman-state-x', 'acme')],
      [333, 512 * 1024, '11:00', path.join(root, '.foreman', 'worktrees', 'w1')],
      [444, 1000, '02:00', path.join(tmpRoot, 'young')],
      [555, 1000, '1-00:00:00', '/srv/other-project'],
      [666, 1000, '1-00:00:00', null],
    ];
    const ps = rows.map(([pid, rss, etime]) => row(pid, rss, etime)).join('\n');
    const lsof = rows.filter(([, , , cwd]) => cwd).map(([pid, , , cwd]) => `p${pid}\nfcwd\nn${cwd}`).join('\n');
    const ctx = ctxFor({ 'ps -axo': { stdout: ps }, 'lsof -a -d cwd': { stdout: lsof } }, { root, platform: 'darwin', home: tmpRoot, uid: 501, strayRoots: [tmpRoot] });
    const r = await stray(ctx);
    expect(r).toMatchObject({ ok: false, level: 'warn' });
    expect(r.detail.startsWith("2 supervisors that are not this run's")).toBe(true);
    expect(r.detail).toBe("2 supervisors that are not this run's (1 in temp folders, 1 in this project's folders), holding about 1.5 GB; tests or manual checks left them, and they slow the run. A run kept in a temp folder counts as one too");
    expect(r.fix.hint).toContain('`foreman doctor --end-strays`');
    expect(r.fix.step).toBe('tools');
  });

  it('warns about an old hook run in a temp folder, with the same hint', async () => {
    const root = fs.realpathSync(dir);
    const hook = `node ${tmpRoot}/foreman-plugin-x/plugin/lib/hooks/agent-events.mjs --decide`;
    const ps = `777 2048 1-00:00:00 ${hook}\n888 2048 1-00:00:00 node ${tmpRoot}/foreman-owner-commands-x/foreman.cjs learn`;
    const lsof = `p777\nfcwd\nn${tmpRoot}/foreman-plugin-x\np888\nfcwd\nn${tmpRoot}/foreman-owner-commands-x`;
    const ctx = ctxFor({ 'ps -axo': { stdout: ps }, 'lsof -a -d cwd': { stdout: lsof } }, { root, platform: 'darwin', home: tmpRoot, uid: 501, strayRoots: [tmpRoot] });
    const r = await stray(ctx);
    expect(r).toMatchObject({ ok: false, level: 'warn' });
    expect(r.detail.startsWith("2 processes that are not this run's (1 hook run, 1 learn or notify run; 2 in temp folders), holding about 4 MB")).toBe(true);
    expect(r.fix.hint).toContain('`foreman doctor --end-strays`');
  });
});

describe('doctor story sessions', () => {
  const PS_KEY = 'ps -axo pid=,ppid=,etime=,command=';
  const claude = (pid, etime, id) => `${pid} 1 ${etime} claude -p /foreman:story ${id} --output-format stream-json --verbose`;
  const sessions = async (answers, extra) => (await results(cfg({ slots: 3, workers: 3 }), ctxFor(answers, extra)))['story sessions'];
  const folder = (n) => {
    const where = path.join(fs.realpathSync(dir), '.foreman', 'worktrees', `w${n}`);
    fs.mkdirSync(where, { recursive: true });
    return where;
  };
  const darwin = () => ({ platform: 'darwin', home: dir, uid: 501 });
  const lsof = (rows) => rows.map(([pid, cwd]) => `p${pid}\nfcwd\nn${cwd}`).join('\n');

  it('is ok when no story session runs, and says so when ps cannot run', async () => {
    expect(await sessions({})).toEqual({ ok: true, level: 'error', detail: '' });
    expect(await sessions({ [PS_KEY]: { status: 1 } })).toMatchObject({ ok: true, detail: 'could not list the running processes' });
  });

  it('is ok with one session in each slot folder', async () => {
    const ps = [claude(21, '10:00', 'ACME-1'), claude(22, '09:00', 'ACME-2')].join('\n');
    const r = await sessions({ [PS_KEY]: { stdout: ps }, 'lsof -a -d cwd': { stdout: lsof([[21, folder(1)], [22, folder(2)]]) } }, darwin());
    expect(r).toEqual({ ok: true, level: 'error', detail: '' });
  });

  it('warns, naming the slot, the stories, the pids and a kill for the newer one, when a folder has two', async () => {
    const ps = [claude(21, '17:00', 'ACME-1'), claude(22, '00:40', 'ACME-1'), claude(23, '09:00', 'ACME-2')].join('\n');
    const r = await sessions({ [PS_KEY]: { stdout: ps }, 'lsof -a -d cwd': { stdout: lsof([[21, folder(1)], [22, folder(1)], [23, folder(2)]]) } }, darwin());
    expect(r).toMatchObject({ ok: false, level: 'warn' });
    expect(r.detail).toBe('w1 has 2 story sessions in its folder: ACME-1 (pid 21), ACME-1 (pid 22); both edit the same worktree, and each is paid for');
    expect(r.fix.hint).toBe('end the newer one with `kill 22`');
    expect(r.fix.step).toBe('tools');
  });

  it('names every folder that has two, and each kill', async () => {
    const ps = [claude(21, '17:00', 'ACME-1'), claude(22, '00:40', 'ACME-3'), claude(23, '09:00', 'ACME-2'), claude(24, '08:00', 'ACME-4'), claude(25, '07:00', 'ACME-5')].join('\n');
    const r = await sessions({ [PS_KEY]: { stdout: ps }, 'lsof -a -d cwd': { stdout: lsof([[21, folder(1)], [22, folder(1)], [23, folder(2)], [24, folder(2)], [25, folder(2)]]) } }, darwin());
    expect(r.detail).toContain('w1 has 2 story sessions in its folder: ACME-1 (pid 21), ACME-3 (pid 22)');
    expect(r.detail).toContain('w2 has 3 story sessions in its folder: ACME-2 (pid 23), ACME-4 (pid 24), ACME-5 (pid 25)');
    expect(r.fix.hint).toBe('end the newer ones with `kill 22`, `kill 24` and `kill 25`');
  });

  it('counts only the config\'s slots', async () => {
    const ps = [claude(21, '17:00', 'ACME-1'), claude(22, '00:40', 'ACME-1')].join('\n');
    const r = (await results(cfg({ slots: 1 }), ctxFor({ [PS_KEY]: { stdout: ps }, 'lsof -a -d cwd': { stdout: lsof([[21, folder(2)], [22, folder(2)]]) } }, darwin())))['story sessions'];
    expect(r).toEqual({ ok: true, level: 'error', detail: '' });
  });
});

describe('doctor machine load', () => {
  const PID = 4242;
  const going = () => {
    fs.mkdirSync(path.join(dir, '.foreman'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.foreman', 'supervisor.pid'), `${PID}\n`);
  };
  const isSupervisor = (pid) => pid === PID;
  const load = async (answers, extra) => (await results(cfg(), ctxFor(answers, extra)))['machine load'];
  const PS = ['101 250.0 /opt/acme/node', '102 5.0 /bin/zsh', '103 90.5 claude', '104 1.0 /usr/sbin/acmed', '105 0.5 launchd', '106 40.0 /Applications/Acme.app/Contents/MacOS/Acme', '107 0.0 ps'].join('\n');

  it('runs only with a config', () => {
    expect(buildChecks(null, ctxFor({})).map((c) => c.name)).not.toContain('machine load');
    expect(buildChecks(cfg(), ctxFor({})).map((c) => c.name)).toContain('machine load');
  });

  it('is ok with no run going, however busy the machine', async () => {
    const r = await load({}, { loadavg: () => [100, 100, 100], cores: 18, alive: isSupervisor });
    expect(r).toEqual({ ok: true, level: 'error', detail: 'no run going' });
  });

  it('is ok during a run with the load at or below twice the cores', async () => {
    going();
    const r = await load({}, { loadavg: () => [36, 0, 0], cores: 18, alive: isSupervisor });
    expect(r).toEqual({ ok: true, level: 'error', detail: 'load 36.0 on 18 cores' });
  });

  it('warns during a run with the load over twice the cores, naming the five busiest processes', async () => {
    going();
    const ctx = ctxFor({ 'ps -Ao': { stdout: `${PS}\n` } }, { loadavg: () => [87, 80, 70], cores: 18, alive: isSupervisor });
    const r = (await results(cfg(), ctx))['machine load'];
    expect(r).toMatchObject({ ok: false, level: 'warn' });
    expect(r.detail.startsWith('load 87.0 on 18 cores during the run, over twice the cores; busiest: node (pid 101, 250.0% CPU), claude (pid 103, 90.5% CPU)')).toBe(true);
    expect(r.detail).toBe(
      'load 87.0 on 18 cores during the run, over twice the cores; busiest: node (pid 101, 250.0% CPU), claude (pid 103, 90.5% CPU), Acme (pid 106, 40.0% CPU), zsh (pid 102, 5.0% CPU), acmed (pid 104, 1.0% CPU)',
    );
    expect(r.detail.split('% CPU)')).toHaveLength(6);
    expect(r.fix.step).toBe('tools');
    expect(r.fix.hint).toContain('`foreman workers <n>`');
    expect(ctx.sh.calls).toContain('ps -Ao pid=,pcpu=,comm=');
  });

  it('just over twice the cores warns', async () => {
    going();
    const r = await load({ 'ps -Ao': { stdout: PS } }, { loadavg: () => [36.1, 0, 0], cores: 18, alive: isSupervisor });
    expect(r).toMatchObject({ ok: false, level: 'warn' });
    expect(r.detail.startsWith('load 36.1 on 18 cores during the run')).toBe(true);
  });

  it('still warns when ps fails or lists nothing', async () => {
    going();
    for (const answer of [{ status: 1, stdout: PS }, { stdout: '' }, { stdout: 'PID %CPU COMMAND\n' }]) {
      const r = await load({ 'ps -Ao': answer }, { loadavg: () => [87, 80, 70], cores: 18, alive: isSupervisor });
      expect(r).toMatchObject({ ok: false, level: 'warn' });
      expect(r.detail.endsWith('busiest: could not list the processes')).toBe(true);
    }
  });

  it('never warns for a dead run: a pid file whose process is not a supervisor is no run going', async () => {
    going();
    const r = await load({ 'ps -Ao': { stdout: PS } }, { loadavg: () => [87, 80, 70], cores: 18, alive: () => false });
    expect(r).toEqual({ ok: true, level: 'error', detail: 'no run going' });
  });
});

describe('doctor fix hints', () => {
  // Every command fails, and the environment is empty.
  const failingSh = () => {
    const sh = () => ({ status: 1, stdout: '', stderr: 'nope' });
    sh.calls = [];
    return sh;
  };
  const failingFetch = async () => { throw new Error('offline'); };
  const failCtx = (extra = {}) => ({ root: dir, env: {}, sh: failingSh(), fs, sourceRoot: source, pluginsDir: plugins, fetch: failingFetch, ...extra });
  const notOk = (res) => Object.entries(res).filter(([, r]) => !r.ok);

  it('gives every failure and warning a known step and a plain hint', async () => {
    fs.writeFileSync(path.join(dir, '.env.local'), `OTHER=${SECRET}\n`);
    fs.writeFileSync(path.join(dir, 'vercel.json'), '{}');
    const configs = [
      cfg({ notify: { adapter: 'email-resend' }, env: { adapter: 'docker', projectPrefix: 'app' } }),
      cfg({ stories: { adapter: 'jira', site: 'acme.atlassian.net', jql: 'project = ACME', transitions: { started: 'In Progress' } } }),
    ];
    for (const config of configs) {
      const res = await results(config, failCtx({ localWarnings: ['local setting workers ignored: too many'] }));
      expect(notOk(res).length).toBeGreaterThan(5);
      for (const [name, r] of notOk(res)) {
        expect(stepById(r.fix?.step), `${name} step ${r.fix?.step}`).toBeDefined();
        expect(typeof r.fix.hint === 'string' && r.fix.hint.length > 0, `${name} hint`).toBe(true);
      }
      expect(JSON.stringify(res)).not.toContain(SECRET);
    }
    const crashed = await results(null, failCtx({ configErrors: [{ path: 'slots', message: 'must be a number' }] }));
    for (const [name, r] of notOk(crashed)) expect(r.fix?.hint, name).toBeTruthy();
  });

  it('points a missing key at the step that owns it', async () => {
    const res = await results(cfg({ notify: { adapter: 'email-resend' } }), ctxFor({}, { env: { RESEND_FROM_EMAIL: 'bot@acme.test' } }));
    const env = res['env variables'];
    expect(env).toMatchObject({ ok: false, level: 'error', fix: { step: 'notifications' } });
    expect(env.fix.hint).toContain('RESEND_API_KEY');
    expect(env.fix.hint).toContain('.env.foreman');
    expect(env.detail).toBe('missing: RESEND_API_KEY (set in .env.foreman or the environment)');

    const packs = { acme: fakePack() };
    const acme = withDefaults({ version: 1, project: { name: 'Acme' }, pack: 'acme', env: { adapter: 'acme-org' } }, { packs });
    const r = (await results(acme, ctxFor({}, { packs, env: { ACME_ORG_KEY: 'x' } })))['env variables'];
    expect(r.fix.step).toBe('project-keys');
    expect(r.fix.hint).toContain('ACME_TOKEN');
  });

  it('tags every check with a step, the pack ones too', () => {
    const packs = { acme: fakePack() };
    const acme = withDefaults({ version: 1, project: { name: 'Acme' }, pack: 'acme', env: { adapter: 'acme-org' } }, { packs });
    for (const check of buildChecks(acme, ctxFor({}, { packs }))) expect(stepById(check.step), check.name).toBeDefined();
    expect(buildChecks(acme, ctxFor({}, { packs })).find((c) => c.name === 'acme org').step).toBe('project');
  });
});

describe('doctor checks with a pack', () => {
  const packs = { acme: fakePack() };
  const acme = (over = {}) => withDefaults({ version: 1, project: { name: 'Acme' }, pack: 'acme', env: { adapter: 'acme-org' }, ...over }, { packs });
  const names = (config, ctx) => buildChecks(config, ctx).map((c) => c.name);

  it('adds the pack checks right after the env check when the config names the pack', async () => {
    const list = names(acme(), ctxFor({}, { packs }));
    expect(list).toContain('acme org');
    expect(list.indexOf('acme org')).toBe(list.indexOf('env variables') + 1);
    expect(named(await results(acme(), ctxFor({}, { packs })), 'acme org')).toEqual({ ok: true, level: 'error', detail: '' });
  });
  it('changes nothing for a config without pack', () => {
    expect(names(cfg(), ctxFor({}, { packs }))).toEqual(names(cfg(), ctxFor({})));
    expect(names(cfg(), ctxFor({}, { packs }))).not.toContain('acme org');
  });
  it('counts the pack steps and env adapter in what the doctor requires', () => {
    expect(requirements(acme(), { packs })).toEqual({ env: ['ACME_ORG_KEY', 'ACME_TOKEN'], tools: ['git', 'acme-cli'] });
    const loose = { env: { adapter: 'acme-org' }, ship: { steps: ['merge-main', 'push', 'acme-deploy'] } };
    const r = requirements(loose, { packs });
    expect(r.tools).not.toContain('acme-cli');
    expect(r.env).not.toContain('ACME_TOKEN');
    expect(r.env).not.toContain('ACME_ORG_KEY');
  });
  it('counts the tools a pack declares in requires', () => {
    const declaring = { acme: fakePack({ requires: { tools: ['acme-keytool'] } }) };
    const r = requirements(acme(), { packs: declaring });
    expect(r.tools).toEqual(['git', 'acme-cli', 'acme-keytool']);
    expect(() => requirements(acme(), { packs: {} })).not.toThrow();
  });
  it('fails the tools check naming openssl for a Salesforce project without it', async () => {
    const sf = withDefaults({
      version: 1,
      project: { name: 'Acme' },
      pack: 'salesforce',
      salesforce: { productionBranch: 'main', orgs: { 'acme-dev1': { orgId: '00D000000000001AAA' } }, build: ['acme-dev1'], stages: [] },
    });
    expect(requirements(sf).tools).toContain('openssl');
    const r = (await results(sf, ctxFor({ 'sh -c command -v openssl': { status: 1 } }))).tools;
    expect(r).toMatchObject({ ok: false, level: 'error' });
    expect(r.detail).toBe('not on PATH: openssl');
  });
  it('fails the env check for a missing pack variable', async () => {
    const r = named(await results(acme(), ctxFor({}, { packs, env: { ACME_ORG_KEY: 'x' } })), 'env variables');
    expect(r).toMatchObject({ ok: false, level: 'error' });
    expect(r.detail).toContain('ACME_TOKEN');
    expect(r.detail).not.toContain('ACME_ORG_KEY');
  });
  it('turns pack checks that throw into one failing check, and keeps the others', async () => {
    const broken = { acme: fakePack({ doctorChecks: () => { throw new Error('boom'); } }) };
    const res = await results(acme(), ctxFor({}, { packs: broken }));
    expect(res['pack acme']).toMatchObject({ ok: false, level: 'error' });
    expect(res['pack acme'].detail).toContain('boom');
    expect(Object.keys(res)).toEqual(expect.arrayContaining(['config', 'env variables', 'tools', 'branch protection', 'workflows']));
  });
  it('fails one check when the config names a pack that is not installed', async () => {
    const res = await results(acme(), ctxFor({}));
    expect(res['pack acme']).toMatchObject({ ok: false, level: 'error' });
    expect(res['pack acme'].detail).toContain('unknown pack: acme');
    expect(res.tools).toBeDefined();
  });
  describe('a pack env adapter named like a core one', () => {
    const clash = { acme: fakePack({ envAdapters: { none: { create: () => ({}), requires: { env: ['ACME_SHADOW'] } } } }) };
    const config = () => withDefaults({ version: 1, project: { name: 'Acme' }, pack: 'acme', env: { adapter: 'none' } }, { packs: clash });
    it('fails the doctor with the clash openEnvAdapter reports, and keeps the other checks', async () => {
      const res = await results(config(), ctxFor({}, { packs: clash }));
      expect(res['pack acme env adapters']).toMatchObject({ ok: false, level: 'error' });
      expect(res['pack acme env adapters'].detail).toContain('pack acme env adapter none clashes with a core env adapter');
      expect(res['env variables']).toBeDefined();
      expect(res.tools).toBeDefined();
      expect(res['acme org']).toBeDefined();
    });
    it('adds no env adapter requirements, neither the core nor the pack one', () => {
      let r;
      expect(() => { r = requirements(config(), { packs: clash }); }).not.toThrow();
      expect(r.env).not.toContain('ACME_SHADOW');
    });
    it('adds no clash check when the pack adapters do not clash', () => {
      expect(names(acme(), ctxFor({}, { packs }))).not.toContain('pack acme env adapters');
    });
  });
  // Core 'none' needs nothing, so the clash above cannot tell a quiet core pick from no pick.
  // Core 'docker' and 'supabase' each need their tool, so a quiet core pick shows up here.
  describe('a pack env adapter named like a core one with real needs', () => {
    const clashOn = (name) => ({ acme: fakePack({ envAdapters: { [name]: { create: () => ({}), requires: { env: ['ACME_SHADOW'], tools: ['acme-shadow'] } } } }) });
    const configOn = (name, clash) => withDefaults({ version: 1, project: { name: 'Acme' }, pack: 'acme', env: { adapter: name } }, { packs: clash });
    it.each(['docker', 'supabase'])('counts neither the core nor the pack %s adapter, and keeps the other needs', (name) => {
      const clash = clashOn(name);
      let r;
      expect(() => { r = requirements(configOn(name, clash), { packs: clash }); }).not.toThrow();
      expect(r.tools).not.toContain(name);
      expect(r.tools).not.toContain('acme-shadow');
      expect(r.env).not.toContain('ACME_SHADOW');
      expect(r.tools).toEqual(['git', 'acme-cli']);
      expect(r.env).toContain('ACME_TOKEN');
    });
    it.each(['docker', 'supabase'])('fails the doctor on a clash with core %s, and keeps the other checks', async (name) => {
      const clash = clashOn(name);
      const res = await results(configOn(name, clash), ctxFor({}, { packs: clash }));
      expect(res['pack acme env adapters']).toMatchObject({ ok: false, level: 'error' });
      expect(res['pack acme env adapters'].detail).toContain(`pack acme env adapter ${name} clashes with a core env adapter`);
      expect(res.tools).toBeDefined();
      expect(res['env variables']).toBeDefined();
    });
  });
});

describe('story session scope', () => {
  let home;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-doctor-home-'));
  });
  const scopeOf = async (over, extra = {}) => (await results(cfg(over), ctxFor({}, { home, ...extra })))['story session scope'];
  const LEAVE_OUT = 'story sessions leave out your user-level CLAUDE.md, auto memory, hooks, skills, agents and plugins; set session.userSettings to true to load them';

  it('is ok and says what sessions leave out, in the Claude Code step', async () => {
    expect(await scopeOf()).toEqual({ ok: true, level: 'error', detail: LEAVE_OUT });
    expect(buildChecks(cfg(), ctxFor({}, { home })).find((c) => c.name === 'story session scope').step).toBe('claude-code');
    fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { acmeDb: { command: 'acme-db' } } }));
    expect(await scopeOf({ session: { mcpServers: ['acmeDb'], extraTools: ['mcp__acmeDb__query'] } })).toEqual({ ok: true, level: 'error', detail: LEAVE_OUT });
  });

  it('has an empty detail with userSettings on', async () => {
    expect(await scopeOf({ session: { userSettings: true } })).toEqual({ ok: true, level: 'error', detail: '' });
  });

  it('fails, naming the server, when .mcp.json does not define it', async () => {
    const r = await scopeOf({ session: { mcpServers: ['ghost'] } });
    expect(r).toMatchObject({ ok: false, level: 'error', fix: { hint: 'add it to .mcp.json', step: 'claude-code' } });
    expect(r.detail).toContain('ghost');
    expect(r.detail).toContain('.mcp.json');
    expect(r.detail).not.toContain('user level');
    fs.writeFileSync(path.join(dir, '.mcp.json'), '{ nope');
    const broken = await scopeOf({ session: { mcpServers: ['ghost'] } });
    expect(broken).toMatchObject({ ok: false, level: 'error' });
    expect(broken.detail).toContain('could not read .mcp.json');
  });

  it('says when the server is defined only at user level', async () => {
    const note = '(defined only at user level in ~/.claude.json; story sessions do not load it)';
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { ghost: { command: 'g' } } }));
    const r = await scopeOf({ session: { mcpServers: ['ghost', 'other'] } });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain(`ghost ${note}`);
    expect(r.detail).not.toContain(`other ${note}`);
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { [dir]: { mcpServers: { ghost: { command: 'g' } } } } }));
    expect((await scopeOf({ session: { mcpServers: ['ghost'] } })).detail).toContain(`ghost ${note}`);
  });

  it('warns when an extra MCP tool names a server sessions do not load', async () => {
    const r = await scopeOf({ session: { extraTools: ['mcp__acmeDb__query', 'Workflow(acme:x)'] } });
    expect(r).toMatchObject({ ok: false, level: 'warn', fix: { hint: 'name the server in session.mcpServers' } });
    expect(r.detail).toContain('acmeDb');
  });

  it('is absent with no config', () => {
    expect(buildChecks(null, ctxFor({}, { home })).map((c) => c.name)).not.toContain('story session scope');
  });
});

describe('doctor last interrupt', () => {
  const NOW = new Date('2026-11-01T10:00:00.000Z');
  const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const interrupt = async (rec) => {
    if (rec) writeInterrupt(path.join(dir, '.foreman'), rec);
    return (await results(cfg(), ctxFor({}, { now: () => NOW })))['last interrupt'];
  };

  it('is ok when no run was interrupted', async () => {
    expect(await interrupt(null)).toEqual({ ok: true, level: 'error', detail: '' });
  });

  it("warns, naming the story's session, the slot and the command, when a session's signal stopped the run", async () => {
    const r = await interrupt({ at: ago(HOUR), story: 'ACME-2', slot: 'w1', command: 'pkill -f "acme.*run"' });
    expect(r.ok).toBe(false);
    expect(r.level).toBe('warn');
    expect(r.detail).toBe('the run was stopped at 2026-11-01 09:00 UTC by a signal from ACME-2\'s session in w1, which had just run `pkill -f "acme.*run"`');
    expect(r.detail).not.toContain('Ctrl-C');
    expect(r.fix.hint).toContain('foreman run');
  });

  it('is ok, naming Ctrl-C, for an interrupt with no session behind it', async () => {
    const r = await interrupt({ at: ago(HOUR) });
    expect(r.ok).toBe(true);
    expect(r.detail).toBe('the run was interrupted (Ctrl-C, kill or a closed terminal) at 2026-11-01 09:00 UTC');
  });

  it('forgets a record older than a week', async () => {
    expect(await interrupt({ at: ago(8 * DAY), story: 'ACME-2', slot: 'w1', command: 'pkill x' })).toEqual({ ok: true, level: 'error', detail: '' });
  });

  it('is not built without a config', () => {
    expect(buildChecks(null, ctxFor({})).map((c) => c.name)).not.toContain('last interrupt');
    expect(buildChecks(cfg(), ctxFor({})).map((c) => c.name)).toContain('last interrupt');
  });
});

describe('doctor owner claims', () => {
  const STATE = () => path.join(dir, '.foreman');
  const stories = (statuses) => {
    fs.mkdirSync(path.join(dir, 'stories'), { recursive: true });
    for (const [id, status] of Object.entries(statuses)) fs.writeFileSync(path.join(dir, 'stories', `${id}.md`), `---\nid: ${id}\ntitle: Story ${id}\nstatus: ${status}\n---\n`);
  };
  const owned = (...ids) => ids.forEach((id) => ownerClaim(STATE(), id, new Date('2026-10-24T09:00:00Z')));
  const claimsCheck = async (config = cfg()) => (await results(config, ctxFor({})))['owner claims'];

  it('is ok with no owner claims, and reads no stories', async () => {
    expect(await claimsCheck()).toEqual({ ok: true, level: 'error', detail: '' });
  });

  it('is ok for an owner claim on an open story', async () => {
    stories({ 'ACME-3': 'in-progress' });
    owned('ACME-3');
    expect(await claimsCheck()).toEqual({ ok: true, level: 'error', detail: '' });
  });

  it('warns about claims on done, retired and missing stories, and says how to clear them', async () => {
    stories({ 'ACME-1': 'done', 'ACME-2': 'retired', 'ACME-3': 'todo' });
    owned('ACME-1', 'ACME-2', 'ACME-3', 'ACME-9');
    const r = await claimsCheck();
    expect(r.ok).toBe(false);
    expect(r.level).toBe('warn');
    expect(r.detail).toBe('3 owner claims on finished stories: ACME-1 (done), ACME-2 (retired), ACME-9 (not in the story source)');
    expect(r.fix.hint).toContain('foreman run');
  });

  it('says claim in the singular for one', async () => {
    stories({ 'ACME-1': 'done' });
    owned('ACME-1');
    expect((await claimsCheck()).detail).toBe('1 owner claim on finished stories: ACME-1 (done)');
  });

  it('does not report a factory claim on a done story', async () => {
    stories({ 'ACME-1': 'done' });
    forceSet(claimFile(STATE(), 'ACME-1'), { pid: process.pid, slot: 'w1', story: 'ACME-1', by: 'factory', at: '2026-10-24T09:00:00Z' });
    expect(await claimsCheck()).toEqual({ ok: true, level: 'error', detail: '' });
  });

  it('reports nothing when the story list is empty', async () => {
    fs.mkdirSync(path.join(dir, 'stories'), { recursive: true });
    owned('ACME-1');
    expect(await claimsCheck()).toEqual({ ok: true, level: 'error', detail: '' });
  });

  it("says it could not read the stories when the source's list throws (a missing stories folder)", async () => {
    owned('ACME-1');
    expect(await claimsCheck(cfg({ stories: { adapter: 'markdown', dir: 'missing' } }))).toEqual({ ok: true, level: 'error', detail: 'could not read the stories' });
  });

  it('says it could not read the stories when the source cannot be opened (an unknown adapter)', async () => {
    owned('ACME-1');
    const ctx = ctxFor({});
    const check = buildChecks(cfg({ stories: { adapter: 'nope' } }), ctx).find((c) => c.name === 'owner claims');
    expect(await check.run(ctx)).toEqual({ ok: true, level: 'error', detail: 'could not read the stories' });
  });

  it('removes nothing: the claim file is still there after the check', async () => {
    stories({ 'ACME-1': 'done' });
    owned('ACME-1');
    await claimsCheck();
    expect(fs.existsSync(claimFile(STATE(), 'ACME-1'))).toBe(true);
  });

  it('is not built without a config and is built with one', () => {
    expect(buildChecks(null, ctxFor({})).map((c) => c.name)).not.toContain('owner claims');
    expect(buildChecks(cfg(), ctxFor({})).map((c) => c.name)).toContain('owner claims');
  });
});

describe('doctor stale control', () => {
  const STATE = () => path.join(dir, '.foreman');
  const dead = () => false;
  const check = async (env = {}, pidExists = dead) => (await results(cfg(), ctxFor({}, { env, pidExists })))['stale control'];
  const adopted = () => path.join(STATE(), ADOPTED_FILE);
  const events = () => (fs.existsSync(path.join(STATE(), 'events.jsonl')) ? fs.readFileSync(path.join(STATE(), 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).text) : []);
  const leave = () => {
    nextStory(STATE(), 'ACME-1', new Date('2026-11-01T09:00:00Z'));
    saveState(STATE(), { loop: { state: 'stopped' }, handledNextAt: readControl(STATE()).requestedAt });
    writeAdopted(STATE(), { by: 15565, pids: [] });
  };
  const BOTH = 'the build-next request for ACME-1, already handled; supervisor-adopted.json, which vouched for pid 15565 that is gone';

  it('is ok with nothing stale, and writes nothing', async () => {
    expect(await check()).toEqual({ ok: true, level: 'error', detail: '' });
    expect(fs.existsSync(STATE())).toBe(false);
  });

  it('clears a handled request and a dead voucher outside a story session, with one event', async () => {
    leave();
    expect(await check()).toEqual({ ok: true, level: 'error', detail: `cleared ${BOTH}` });
    expect(readControl(STATE()).nextStory).toBeUndefined();
    expect(fs.existsSync(adopted())).toBe(false);
    expect(events()).toEqual([`Cleared stale control: ${BOTH}.`]);
    // A second look finds nothing.
    expect(await check()).toEqual({ ok: true, level: 'error', detail: '' });
    expect(events()).toHaveLength(1);
  });

  it('only warns inside a story session, and clears nothing', async () => {
    leave();
    const r = await check({ FOREMAN_RUN: '1' });
    expect(r.ok).toBe(false);
    expect(r.level).toBe('warn');
    expect(r.detail).toBe(BOTH);
    expect(r.fix.hint).toContain('foreman doctor');
    expect(readControl(STATE()).nextStory).toBe('ACME-1');
    expect(fs.existsSync(adopted())).toBe(true);
    expect(events()).toEqual([]);
  });

  it('leaves a voucher whose process lives', async () => {
    writeAdopted(STATE(), { by: 15565, pids: [15500] });
    expect(await check({}, () => true)).toEqual({ ok: true, level: 'error', detail: '' });
    expect(fs.existsSync(adopted())).toBe(true);
    expect(events()).toEqual([]);
  });

  it('is not built without a config and is built with one', () => {
    expect(buildChecks(null, ctxFor({})).map((c) => c.name)).not.toContain('stale control');
    expect(buildChecks(cfg(), ctxFor({})).map((c) => c.name)).toContain('stale control');
  });
});

describe('agent models', () => {
  const NOW = new Date('2026-10-20T12:00:00Z');
  const TEXT = 'test (foreman:tester) is set to Haiku but ran on Opus 5.5';
  const mismatch = { role: 'tester', name: 'test', agent: 'foreman:tester', set: 'haiku', ran: 'claude-opus-5-5', text: TEXT };
  const rec = (story, endedAt, extra = {}) => writeRun(path.join(dir, '.foreman'), { story, slot: 'w1', result: 'shipped', startedAt: new Date(Date.parse(endedAt) - 600000).toISOString(), endedAt, agents: [], ...extra });
  const modelsOf = async () => (await results(cfg(), ctxFor({}, { now: () => NOW })))['agent models'];

  it('is in the Claude Code step, and absent with no config', () => {
    expect(buildChecks(cfg(), ctxFor({})).find((c) => c.name === 'agent models').step).toBe('claude-code');
    expect(buildChecks(null, ctxFor({})).map((c) => c.name)).not.toContain('agent models');
  });

  it('is ok when no session in the last 7 days recorded its agents', async () => {
    expect(await modelsOf()).toEqual({ ok: true, level: 'error', detail: "no story session in the last 7 days recorded its agents' models" });
    rec('ACME-1', '2026-10-20T10:00:00Z', { agents: null });
    expect((await modelsOf()).detail).toMatch(/no story session/);
  });

  it('is ok when the newest session ran on the models its roles are set to', async () => {
    rec('ACME-1', '2026-10-20T10:00:00Z');
    expect(await modelsOf()).toEqual({ ok: true, level: 'error', detail: "the agents of ACME-1's session ran on the models their roles are set to" });
  });

  it('warns about the mismatches of the newest session, with the way to check', async () => {
    rec('ACME-1', '2026-10-20T10:00:00Z', { modelMismatches: [mismatch, { ...mismatch, name: 'fix', text: 'fix (foreman:builder) is set to Sonnet but ran on Opus 5.5' }] });
    const r = await modelsOf();
    expect(r).toMatchObject({ ok: false, level: 'warn' });
    expect(r.detail).toBe(`in ACME-1's session (ended 2026-10-20 10:00 UTC): ${TEXT}; fix (foreman:builder) is set to Sonnet but ran on Opus 5.5`);
    expect(r.fix.hint).toContain('foreman settings list --group models');
    expect(r.fix.step).toBe('claude-code');
  });

  it('clears once a later session ran on the right models', async () => {
    rec('ACME-1', '2026-10-19T10:00:00Z', { modelMismatches: [mismatch] });
    rec('ACME-2', '2026-10-20T10:00:00Z');
    expect((await modelsOf()).ok).toBe(true);
  });

  it('ignores a mismatch older than 7 days', async () => {
    rec('ACME-1', '2026-10-10T10:00:00Z', { modelMismatches: [mismatch] });
    const r = await modelsOf();
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/no story session/);
  });
});

describe('doctor: check commands on PATH', () => {
  const onPath = async (checks, answers = {}) => {
    const ctx = ctxFor(answers);
    const check = buildChecks(cfg({ checks }), ctx).find((c) => c.name === 'check commands on PATH');
    return { r: await check.run(ctx), ctx };
  };
  const probes = (ctx) => ctx.sh.calls.filter((c) => c.startsWith('sh -c command -v'));

  it('is ok when every first word is found', async () => {
    const { r, ctx } = await onPath([{ run: 'npm test', when: 'always' }, { run: 'eslint .', when: 'src/**' }]);
    expect(r.ok).toBe(true);
    expect(probes(ctx)).toEqual(['sh -c command -v npm', 'sh -c command -v eslint']);
  });

  it('warns for a first word that is not on the PATH, after the NAME=value words', async () => {
    const { r } = await onPath([{ run: 'ACME_MODE=ci lint-tool --all', when: 'src/**' }], { 'sh -c command -v lint-tool': { status: 127 } });
    expect(r).toMatchObject({ ok: false, level: 'warn' });
    expect(r.detail).toContain('lint-tool');
    expect(r.detail).toContain('story sessions run the checks with the PATH the run starts with');
    expect(r.fix.step).toBe('tools');
    expect(r.fix.hint).toContain('foreman run');
  });

  it('names every missing word once, and none that was found', async () => {
    const { r } = await onPath([{ run: 'npm test', when: 'always' }, { run: 'lint-tool a', when: 'always' }, { run: 'fmt-tool b', when: 'src/**' }], {
      'sh -c command -v lint-tool': { status: 127 },
      'sh -c command -v fmt-tool': { status: 1 },
    });
    expect(r.detail).toContain('not found on this shell\'s PATH: lint-tool, fmt-tool;');
  });

  it("probes a quick command's first word too", async () => {
    const { r, ctx } = await onPath([{ run: 'npm test', quick: 'vitest-quick --changed', when: 'always' }], { 'sh -c command -v vitest-quick': { status: 127 } });
    expect(probes(ctx)).toContain('sh -c command -v vitest-quick');
    expect(r.detail).toContain('vitest-quick');
  });

  it('does not probe a path or a substitution', async () => {
    const { r, ctx } = await onPath([{ run: './scripts/test.sh', when: 'always' }, { run: '$(npm bin)/x --all', when: 'src/**' }, { run: '/usr/bin/env true', when: 'always' }]);
    expect(r.ok).toBe(true);
    expect(probes(ctx)).toEqual([]);
  });

  it('probes the same word once', async () => {
    const { ctx } = await onPath([{ run: 'npm test', when: 'always' }, { run: 'npm run lint', quick: 'npm run lint:quick', when: 'src/**' }]);
    expect(probes(ctx)).toEqual(['sh -c command -v npm']);
  });

  it('is ok, with no probe, when no check is configured', async () => {
    const { r, ctx } = await onPath([]);
    expect(r.ok).toBe(true);
    expect(probes(ctx)).toEqual([]);
  });
});
