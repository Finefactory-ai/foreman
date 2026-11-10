import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LOCAL_SAFE, localRunnerChecks, projectChecks, runChecks, runnerChecks } from './doctor.mjs';
import { foremanVersion, runnerImage } from './versions.mjs';
import { defaultSh } from '../state-store/branch.mjs';
import { withDefaults } from '../config/defaults.mjs';
import { acmePlugins, sfCall, sfRaw } from '../../../test/fake-sf.mjs';

const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789AB';
const KEY = 'sk-ant-api03-secret-key-value-123456';
let work;
let plugin;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-cloud-doctor-'));
  plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-cloud-plugin-'));
  fs.mkdirSync(path.join(plugin, '.claude-plugin'));
  fs.writeFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'foreman', version: foremanVersion() }));
});

// A fake shell: `answers` maps a command line prefix to a result, the longest matching prefix
// answering; the rest succeed silently. An sf call made through runSf's watcher reads as `sf ...`.
function fakeSh(answers = {}) {
  const calls = [];
  const sh = (rawCmd, rawArgs = []) => {
    const { cmd, args } = sfCall(rawCmd, rawArgs);
    const line = [cmd, ...args].join(' ');
    calls.push(line);
    const key = Object.keys(answers).filter((k) => line.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    return { status: 0, stdout: '', stderr: '', ...(key ? answers[key] : {}) };
  };
  sh.calls = calls;
  return sh;
}

const HAPPY = {
  'gh api user': { stdout: 'octo\n' },
  'gh api repos/acme/app': { stdout: 'true\n' },
  'gh api repos/acme/app/pulls?state=all&per_page=1': { stdout: '5\n' },
  'gh pr view 5 --repo acme/app --json statusCheckRollup': { stdout: JSON.stringify({ statusCheckRollup: [] }) },
  'claude -p': { stdout: JSON.stringify({ type: 'result', is_error: false, result: 'ok' }) },
};
const ENV = () => ({ FOREMAN_REPO: 'acme/app', GH_TOKEN: SECRET, ANTHROPIC_API_KEY: KEY, FOREMAN_PLUGIN_DIR: plugin, FOREMAN_WORK: work });
const ctxFor = (answers = {}, env = ENV()) => ({ env, sh: fakeSh({ ...HAPPY, ...answers }), fs });

async function results(checks, ctx) {
  const out = {};
  for (const c of checks) out[c.name] = await c.run(ctx);
  return out;
}

describe('the runner checks', () => {
  it('pass on a healthy runner', async () => {
    const res = await results(runnerChecks(), ctxFor());
    expect(Object.entries(res).filter(([, r]) => !r.ok)).toEqual([]);
    expect(Object.keys(res)).toEqual(['FOREMAN_REPO', 'GH_TOKEN', 'claude sign-in', 'github token', 'pull request checks', 'claude answers', 'plugin', 'work folder', 'dashboard token']);
    expect(res['claude sign-in'].detail).toBe('Console API key: per-token billing');
  });

  it('need FOREMAN_REPO as owner/name, and GH_TOKEN', async () => {
    const res = await results(runnerChecks(), ctxFor({}, { ...ENV(), FOREMAN_REPO: 'just-a-name', GH_TOKEN: '' }));
    expect(res.FOREMAN_REPO).toMatchObject({ ok: false, level: 'error' });
    expect(res.FOREMAN_REPO.detail).toMatch(/owner\/name/);
    expect(res.GH_TOKEN).toMatchObject({ ok: false, level: 'error' });
  });

  it('need a Claude sign-in', async () => {
    const env = { ...ENV() };
    delete env.ANTHROPIC_API_KEY;
    const res = await results(runnerChecks(), ctxFor({ 'claude auth status': { stdout: '{"loggedIn":false}' } }, env));
    expect(res['claude sign-in']).toMatchObject({ ok: false, level: 'error' });
  });

  it('check that the token works and can reach the repository', async () => {
    let res = await results(runnerChecks(), ctxFor({ 'gh api user': { status: 1, stderr: 'HTTP 401: Bad credentials' } }));
    expect(res['github token']).toMatchObject({ ok: false, level: 'error' });
    expect(res['github token'].detail).toMatch(/Bad credentials/);
    res = await results(runnerChecks(), ctxFor({ 'gh api repos/acme/app': { status: 1, stderr: 'HTTP 404: Not Found' } }));
    expect(res['github token'].detail).toMatch(/cannot read acme\/app/);
    res = await results(runnerChecks(), ctxFor({ 'gh api repos/acme/app': { stdout: 'false\n' } }));
    expect(res['github token'].detail).toMatch(/cannot push to acme\/app/);
  });

  describe('check that the token can read the checks of the newest pull request', () => {
    const REFUSED = { status: 1, stderr: 'GraphQL: Resource not accessible by personal access token (repository.pullRequest.commits.nodes.0.commit.statusCheckRollup.contexts)' };
    const FINE_GRAINED = {
      'gh pr view 5 --repo acme/app --json statusCheckRollup': REFUSED,
      'gh api repos/acme/app/pulls/5': { stdout: JSON.stringify({ head: { sha: 'abc123' } }) },
      'gh api repos/acme/app/actions/runs?head_sha=abc123': { stdout: JSON.stringify({ workflow_runs: [{ id: 9, name: 'CI', status: 'completed', conclusion: 'success' }] }) },
      'gh api repos/acme/app/actions/runs/9/jobs': { stdout: JSON.stringify({ jobs: [{ name: 'test', status: 'completed', conclusion: 'success' }] }) },
      'gh api repos/acme/app/commits/abc123/status': { stdout: JSON.stringify({ statuses: [] }) },
    };

    it('passes when the token reads check runs', async () => {
      const ctx = ctxFor();
      const res = await results(runnerChecks(), ctx);
      expect(res['pull request checks']).toMatchObject({ ok: true });
      expect(ctx.sh.calls).toContain('gh pr view 5 --repo acme/app --json statusCheckRollup');
    });

    it('passes a fine-grained token that reads Actions and commit statuses, saying what it cannot see', async () => {
      const ctx = ctxFor(FINE_GRAINED);
      const res = await results(runnerChecks(), ctx);
      expect(res['pull request checks']).toMatchObject({ ok: true });
      expect(res['pull request checks'].detail).toMatch(/GitHub Actions and commit statuses/);
      expect(res['pull request checks'].detail).toMatch(/other apps/);
      expect(ctx.sh.calls).toContain('gh api repos/acme/app/actions/runs/9/jobs?per_page=100');
    });

    it('fails a fine-grained token without Actions read, naming the permissions', async () => {
      const res = await results(runnerChecks(), ctxFor({ ...FINE_GRAINED, 'gh api repos/acme/app/actions/runs?head_sha=abc123': { status: 1, stderr: 'gh: Resource not accessible by personal access token (HTTP 403)' } }));
      expect(res['pull request checks']).toMatchObject({ ok: false, level: 'error' });
      expect(res['pull request checks'].detail).toMatch(/#5/);
      expect(res['pull request checks'].detail).toMatch(/HTTP 403/);
      expect(res['pull request checks'].detail).toMatch(/Pull requests, Actions and Commit statuses read/);
    });

    it('fails when the checks cannot be read for another reason', async () => {
      const res = await results(runnerChecks(), ctxFor({ 'gh pr view 5 --repo acme/app --json statusCheckRollup': { status: 1, stderr: 'HTTP 502: Bad Gateway' } }));
      expect(res['pull request checks']).toMatchObject({ ok: false, level: 'error' });
      expect(res['pull request checks'].detail).toMatch(/Bad Gateway/);
    });

    it('fails when the token cannot list pull requests', async () => {
      const res = await results(runnerChecks(), ctxFor({ 'gh api repos/acme/app/pulls?state=all&per_page=1': { status: 1, stderr: 'HTTP 403: Resource not accessible by personal access token' } }));
      expect(res['pull request checks']).toMatchObject({ ok: false, level: 'error' });
      expect(res['pull request checks'].detail).toMatch(/pull requests/);
    });

    it('warns when the repository has no pull request to try yet', async () => {
      const res = await results(runnerChecks(), ctxFor({ 'gh api repos/acme/app/pulls?state=all&per_page=1': { stdout: '' } }));
      expect(res['pull request checks']).toMatchObject({ ok: false, level: 'warn' });
      expect(res['pull request checks'].detail).toMatch(/no pull request/);
    });
  });

  it('check that Claude answers, with the reason when it does not', async () => {
    const res = await results(runnerChecks(), ctxFor({ 'claude -p': { status: 1, stdout: JSON.stringify({ type: 'result', is_error: true, result: 'Invalid API key · Please run /login' }) } }));
    expect(res['claude answers']).toMatchObject({ ok: false, level: 'error' });
    expect(res['claude answers'].detail).toMatch(/Invalid API key/);
  });

  it('check the plugin folder holds this version of Foreman', async () => {
    fs.writeFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'foreman', version: '0.0.1' }));
    let res = await results(runnerChecks(), ctxFor());
    expect(res.plugin.detail).toMatch(/0\.0\.1/);
    expect(res.plugin.ok).toBe(false);
    res = await results(runnerChecks(), ctxFor({}, { ...ENV(), FOREMAN_PLUGIN_DIR: '' }));
    expect(res.plugin.detail).toMatch(/FOREMAN_PLUGIN_DIR/);
  });

  it('check the work folder can be written', async () => {
    const res = await results(runnerChecks(), ctxFor({}, { ...ENV(), FOREMAN_WORK: path.join(work, 'no', 'such') }));
    expect(res['work folder']).toMatchObject({ ok: false, level: 'error' });
  });

  it('need the dashboard token only when the dashboard listens beyond loopback', async () => {
    let res = await results(runnerChecks(), ctxFor({}, { ...ENV(), FOREMAN_DASHBOARD_HOST: '0.0.0.0' }));
    expect(res['dashboard token']).toMatchObject({ ok: false, level: 'error' });
    expect(res['dashboard token'].detail).toMatch(/FOREMAN_DASHBOARD_TOKEN/);
    res = await results(runnerChecks(), ctxFor({}, { ...ENV(), FOREMAN_DASHBOARD_HOST: '0.0.0.0', FOREMAN_DASHBOARD_TOKEN: 'x'.repeat(32) }));
    expect(res['dashboard token'].ok).toBe(true);
    res = await results(runnerChecks(), ctxFor({}, { ...ENV(), FOREMAN_DASHBOARD_HOST: '127.0.0.1' }));
    expect(res['dashboard token'].ok).toBe(true);
  });

  it('never print a value', async () => {
    const res = await results(runnerChecks(), ctxFor({ 'gh api user': { status: 1, stderr: `bad token ${SECRET}` }, 'gh pr view 5 --repo acme/app --json statusCheckRollup': { status: 1, stderr: `bad token ${SECRET}` } }));
    expect(res['pull request checks'].ok).toBe(false);
    expect(JSON.stringify(res)).not.toContain(SECRET);
    expect(JSON.stringify(res)).not.toContain(KEY);
  });
});

describe('the project checks', () => {
  const cfg = (over = {}) => withDefaults({ version: 1, project: { name: 'P' }, ...over });

  it('need the Docker socket for the docker and supabase slot environments only', async () => {
    const sock = path.join(work, 'docker.sock');
    const ctx = { ...ctxFor(), root: work, dockerSocket: sock };
    expect(projectChecks(cfg(), ctx).map((c) => c.name)).toEqual([]);
    let res = await results(projectChecks(cfg({ env: { adapter: 'docker', projectPrefix: 'app' } }), ctx), ctx);
    expect(res['docker socket']).toMatchObject({ ok: false, level: 'error' });
    expect(res['docker socket'].detail).toMatch(/\/var\/run\/docker\.sock/);
    fs.writeFileSync(sock, '');
    res = await results(projectChecks(cfg({ env: { adapter: 'supabase' } }), ctx), ctx);
    expect(res['docker socket'].ok).toBe(true);
  });

  it('check the state branch can be fetched and pushed, for the branch store', async () => {
    const ctx = { ...ctxFor(), root: work };
    let res = await results(projectChecks(cfg({ state: { store: 'branch' } }), ctx), ctx);
    expect(res['state branch'].ok).toBe(true);
    expect(ctx.sh.calls).toContain('git ls-remote --heads origin foreman-state');
    expect(ctx.sh.calls.some((c) => c.startsWith('git push --dry-run --quiet origin HEAD:refs/heads/foreman-doctor-'))).toBe(true);
    const noPush = { ...ctxFor({ 'git push': { status: 1, stderr: 'permission denied' } }), root: work };
    res = await results(projectChecks(cfg({ state: { store: 'branch' } }), noPush), noPush);
    expect(res['state branch']).toMatchObject({ ok: false, level: 'error' });
    expect(res['state branch'].detail).toMatch(/push/);
  });

  // A runner with the Salesforce image's tools.
  const SF_TOOLS = {
    'sf plugins --core': sfRaw(acmePlugins()),
    'python3 --version': { stdout: 'Python 3.11.2\n' },
    'java -version': { stderr: 'openjdk version "17.0.13" 2024-10-15\n' },
  };
  const SF_NAMES = ['salesforce tools', 'python', 'java'];
  const sfCtx = (answers = {}) => ctxFor({ ...SF_TOOLS, ...answers });

  it('check the Salesforce tools only when the pack is on', async () => {
    expect(projectChecks(cfg(), sfCtx()).map((c) => c.name)).toEqual([]);
    const ctx = sfCtx();
    const checks = projectChecks(cfg({ pack: 'salesforce' }), ctx);
    expect(checks.map((c) => c.name)).toEqual(expect.arrayContaining(SF_NAMES));
    const res = await results(checks, ctx);
    for (const name of SF_NAMES) expect(`${name}: ${res[name].ok}`).toBe(`${name}: true`);
    expect(res.python.detail).toBe('Python 3.11.2');
    expect(ctx.sh.calls).toContain('sf plugins --core --json');
  });

  it('fail a runner without the tools, and name the Salesforce image', async () => {
    const cases = [
      ['salesforce tools', { 'sf plugins --core': { status: 1, stdout: '', stderr: '' } }],
      ['salesforce tools', { 'sf plugins --core': sfRaw(acmePlugins({ 'sfdx-git-delta': null })) }],
      ['python', { 'python3 --version': { stdout: 'Python 3.9.18\n' } }, /python3 3\.9 < 3\.10/],
      ['python', { 'python3 --version': { status: 1, stdout: '', stderr: '' } }, /python3 is not on PATH/],
      ['java', { 'java -version': { stderr: 'openjdk version "1.8.0_402" 2024-01-16\n' } }, /java 1 < 11/],
      ['java', { 'java -version': { status: 1, stdout: '', stderr: '' } }, /java is not on PATH/],
    ];
    for (const [name, answers, why] of cases) {
      const ctx = sfCtx(answers);
      const res = await results(projectChecks(cfg({ pack: 'salesforce' }), ctx), ctx);
      expect(res[name]).toMatchObject({ ok: false, level: 'error' });
      expect(res[name].detail).toMatch(/foreman-runner:\d+\.\d+\.\d+-salesforce/);
      expect(res[name].detail).toContain(`foreman-runner:${foremanVersion()}-salesforce`);
      expect(res[name].detail).toMatch(/SALESFORCE=1/);
      if (why) expect(res[name].detail).toMatch(why);
    }
  });

  it('say sf is not on PATH when the real shell cannot find it', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-cloud-no-path-'));
    try {
      const ctx = { ...ctxFor(), sh: (cmd, args, opts = {}) => defaultSh(cmd, args, { ...opts, env: { PATH: empty } }) };
      const res = await results(projectChecks(cfg({ pack: 'salesforce' }), ctx), ctx);
      expect(res['salesforce tools']).toMatchObject({ ok: false, level: 'error' });
      expect(res['salesforce tools'].detail).toMatch(/^sf is not on PATH/);
      expect(res['salesforce tools'].detail).toContain(`foreman-runner:${foremanVersion()}-salesforce`);
      expect(res['salesforce tools'].detail).not.toContain('could not read');
      expect(res.python.detail).toMatch(/python3 is not on PATH/);
      expect(res.java.detail).toMatch(/java is not on PATH/);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('give sf room for its plugin list, which is 3.5 MB in the Salesforce image', async () => {
    const ctx = sfCtx();
    const sh = ctx.sh;
    const seen = [];
    ctx.sh = (rawCmd, rawArgs, opts = {}) => {
      const { cmd, args } = sfCall(rawCmd, rawArgs);
      seen.push({ cmd, opts });
      // spawnSync stops at 1 MB by default and cuts the JSON off, so sf seems to print none.
      if (cmd === 'sf' && !(opts.maxBuffer >= 16 * 1024 * 1024)) return { status: 1, stdout: '[{"name":', stderr: '' };
      return sh(rawCmd, rawArgs, opts);
    };
    const res = await results(projectChecks(cfg({ pack: 'salesforce' }), ctx), ctx);
    expect(res['salesforce tools'].ok).toBe(true);
    expect(seen.find((c) => c.cmd === 'sf').opts.timeout).toBeGreaterThan(0);
  });

  it('warn, not fail, when the agent plugin is missing and agentforce is auto', async () => {
    const ctx = sfCtx({ 'sf plugins --core': sfRaw(acmePlugins({ '@salesforce/plugin-agent': null })) });
    const res = await results(projectChecks(cfg({ pack: 'salesforce' }), ctx), ctx);
    expect(res['salesforce tools']).toMatchObject({ ok: false, level: 'warn' });
    expect(res['salesforce tools'].detail).toContain('@salesforce/plugin-agent');
  });
});

describe('runChecks', () => {
  it('prints one line per check and says whether any failed', async () => {
    let out = '';
    const ctx = ctxFor({}, { ...ENV(), GH_TOKEN: '' });
    const failed = await runChecks(runnerChecks(), ctx, { write: (s) => { out += s; } });
    expect(failed).toBe(true);
    expect(out).toMatch(/^FAIL {2}GH_TOKEN — /m);
    expect(out).toMatch(/^ok {4}FOREMAN_REPO$/m);
  });
});

describe('the local-safe runner checks', () => {
  it('are exactly LOCAL_SAFE, in runnerChecks order, frozen', () => {
    expect(LOCAL_SAFE).toEqual(['FOREMAN_REPO', 'GH_TOKEN', 'github token', 'pull request checks', 'dashboard token']);
    expect(Object.isFrozen(LOCAL_SAFE)).toBe(true);
    const names = localRunnerChecks().map((c) => c.name);
    expect(names).toEqual(runnerChecks().map((c) => c.name).filter((n) => LOCAL_SAFE.includes(n)));
    expect(names).toEqual([...LOCAL_SAFE]);
    for (const left of ['claude sign-in', 'claude answers', 'plugin', 'work folder']) expect(names).not.toContain(left);
  });
});

describe('runnerImage', () => {
  it("is this version's runner image, -salesforce with the pack", () => {
    expect(runnerImage({})).toBe(`ghcr.io/finefactory-ai/foreman-runner:${foremanVersion()}`);
    expect(runnerImage({ pack: 'salesforce' })).toBe(`ghcr.io/finefactory-ai/foreman-runner:${foremanVersion()}-salesforce`);
  });
});
