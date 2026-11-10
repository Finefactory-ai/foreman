import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../main.mjs';
import { makeHealthCommand } from './health.mjs';
import { fakeSh } from '../../../../test/ship-fakes.mjs';

const SITE = 'https://acme-app.vercel.app';
const TOKEN = 'very-secret-token';
const ACME = {
  steps: ['merge-main', 'prepare-migrations', 'resources', 'supabase-credentials', 'push', 'pr', 'ci', 'migrate-supabase', 'merge', 'deploy-github', 'smoke'],
  'migrate-supabase': { projectRef: 'uoizcnvpsbrzcvkxdjez' },
  'deploy-github': { environment: 'Production' },
  smoke: { urls: [SITE] },
};
const LS_TREE = 'supabase/migrations/20261013000000_a.sql\nsupabase/migrations/20261014000000_b.sql\n';

let dir;
const writeConfig = (ship) => fs.writeFileSync(path.join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'T' }, ...(ship ? { ship } : {}) }));
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-health-'));
  writeConfig(ACME);
  fs.writeFileSync(path.join(dir, '.env.local'), `SUPABASE_ACCESS_TOKEN=${TOKEN}\n`);
});
afterEach(() => {
  delete process.env.SUPABASE_ACCESS_TOKEN;
});

const MAIN = 'cd1a5ac9c2e3f00d';
const LIVE = 'The newest main (cd1a5ac) is live.';

// site: the status the live site answers ('down' for none); rows: the hosted migrations, or a
// status number for the Supabase API to answer with; live: the state of main's newest deployment.
function harness({ site = 200, rows = [{ version: '20261013000000' }, { version: '20261014000000' }], live = 'success', rules = [] } = {}) {
  const sh = fakeSh([
    ...rules,
    ['git ls-tree --name-only origin/main supabase/migrations/', LS_TREE],
    ['git rev-parse origin/main', `${MAIN}\n`],
    [`gh api repos/{owner}/{repo}/deployments?sha=${MAIN}&environment=Production --jq .[].id`, '42\n'],
    ['gh api repos/{owner}/{repo}/deployments/42/statuses', `${live}\n`],
  ]);
  const seen = [];
  const fetch = (url, init) => {
    seen.push({ url, init });
    if (url.startsWith('https://api.supabase.com')) {
      return Promise.resolve(typeof rows === 'number' ? { status: rows, json: async () => ({}) } : { status: 200, json: async () => rows });
    }
    return site === 'down' ? Promise.reject(new Error('ECONNREFUSED')) : Promise.resolve({ status: site });
  };
  const command = makeHealthCommand({ sh, fetch });
  const run = async (args = []) => {
    let out = '';
    let err = '';
    const code = await command.run(args, {
      cwd: dir,
      root: dir,
      env: { FOREMAN_PROJECT_DIR: dir },
      now: () => new Date(Date.UTC(2026, 9, 15, 12)),
      stdout: { write: (s) => { out += s; } },
      stderr: { write: (s) => { err += s; } },
    });
    const lines = out.trim().split('\n');
    return { code, out, err, lines, last: JSON.parse(lines[lines.length - 1]) };
  };
  return { run, sh, seen };
}

describe('foreman health', () => {
  it('is a registered command', async () => {
    let out = '';
    await main(['--help'], { cwd: dir, env: {}, stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } });
    expect(out).toMatch(/^health\s/m);
  });

  it('passes when every configured check passes, printing one JSON line', async () => {
    const h = harness();
    const r = await h.run();
    expect(r.code).toBe(0);
    expect(r.lines).toHaveLength(1);
    expect(r.last).toEqual({
      ok: true,
      reason: `The hosted database matches main. ${LIVE} The live site answers (${SITE}).`,
      checks: [
        { step: 'migrate-supabase', ok: true, reason: 'The hosted database matches main.' },
        { step: 'deploy-github', ok: true, reason: LIVE },
        { step: 'smoke', ok: true, reason: `The live site answers (${SITE}).` },
      ],
    });
  });

  it("fails while main's newest commit is not live, naming it (merged but never deployed)", async () => {
    const r = await harness({ live: 'error' }).run();
    expect(r.code).toBe(1);
    expect(r.last.reason).toBe('The newest main (cd1a5ac) is not live yet: Production still runs an older version. Redeploy it, then press "I\'ve fixed it" again.');
    expect(r.last.checks.map((c) => [c.step, c.ok])).toEqual([['migrate-supabase', true], ['deploy-github', false], ['smoke', true]]);
  });

  it('fails when the live site is down, saying which check failed', async () => {
    const r = await harness({ site: 503 }).run();
    expect(r.code).toBe(1);
    expect(r.last).toMatchObject({ ok: false, reason: `${SITE} answered 503.` });
    expect(r.last.checks.map((c) => [c.step, c.ok])).toEqual([['migrate-supabase', true], ['deploy-github', true], ['smoke', false]]);
  });

  it('fails when the hosted database does not match the base', async () => {
    const r = await harness({ rows: [{ version: '20261013000000' }] }).run();
    expect(r.code).toBe(1);
    expect(r.last.reason).toContain('20261014000000');
  });

  it('joins every failing reason', async () => {
    const r = await harness({ site: 'down', rows: 401 }).run();
    expect(r.code).toBe(1);
    expect(r.last.reason).toBe(`The hosted database could not be checked: the Supabase API answered 401. ${SITE} did not answer.`);
  });

  it('reads the token from the env file and never prints it', async () => {
    const h = harness({ rows: 401 });
    const r = await h.run();
    const api = h.seen.find((s) => s.url.startsWith('https://api.supabase.com'));
    expect(api.init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(r.out + r.err).not.toContain(TOKEN);
  });

  it('loads no registry name from .env.foreman that no step declares', async () => {
    fs.writeFileSync(path.join(dir, '.env.foreman'), 'RESEND_API_KEY=re_acme_file\n');
    const saved = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    const env = { FOREMAN_PROJECT_DIR: dir };
    let out = '';
    try {
      await makeHealthCommand({ sh: fakeSh([]), fetch: () => Promise.resolve({ status: 200 }) }).run([], {
        cwd: dir,
        root: dir,
        env,
        now: () => new Date(Date.UTC(2026, 9, 15, 12)),
        stdout: { write: (s) => { out += s; } },
        stderr: { write: () => {} },
      });
      expect('RESEND_API_KEY' in env).toBe(false);
      expect('RESEND_API_KEY' in process.env).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = saved;
    }
    expect(out).not.toContain('re_acme_file');
  });

  it('a check that throws fails, and the others still run', async () => {
    const h = harness({ rules: [['git fetch', () => { throw new Error('spawn git ENOENT'); }]] });
    const r = await h.run();
    expect(r.code).toBe(1);
    expect(r.last.checks).toEqual([
      { step: 'migrate-supabase', ok: false, reason: 'The migrate-supabase check failed: spawn git ENOENT' },
      { step: 'deploy-github', ok: false, reason: 'The deploy-github check failed: spawn git ENOENT' },
      { step: 'smoke', ok: true, reason: `The live site answers (${SITE}).` },
    ]);
  });

  it('with no health checks configured passes and says so', async () => {
    writeConfig(null);
    const r = await harness().run();
    expect(r.code).toBe(0);
    expect(r.last).toEqual({ ok: true, reason: 'no health checks are configured', checks: [] });
  });

  it('a smoke step with no urls is not a check', async () => {
    writeConfig({ steps: ['push', 'smoke'], smoke: { urls: [] } });
    expect((await harness().run()).last).toEqual({ ok: true, reason: 'no health checks are configured', checks: [] });
  });

  describe('--site', () => {
    it('runs only the live-site check', async () => {
      const h = harness();
      const r = await h.run(['--site']);
      expect(r.code).toBe(0);
      expect(r.last).toEqual({ ok: true, reason: `The live site answers (${SITE}).`, checks: [{ step: 'smoke', ok: true, reason: `The live site answers (${SITE}).` }] });
      expect(h.sh.calls).toEqual([]);
      expect(h.seen.map((s) => s.url)).toEqual([SITE]);
    });

    it('exits 1 when the live site is down', async () => {
      const r = await harness({ site: 502 }).run(['--site']);
      expect(r.code).toBe(1);
      expect(r.last).toMatchObject({ ok: false, reason: `${SITE} answered 502.` });
    });

    it('with no live site configured passes and says there is no check', async () => {
      writeConfig(null);
      const r = await harness().run(['--site']);
      expect(r.code).toBe(0);
      expect(r.last.reason).toBe('no health checks are configured');
    });
  });

  describe('with watch and rollback configured', () => {
    const WATCH = './scripts/errors-since-deploy.sh';
    const ROLLBACK = 'vercel rollback --yes';
    beforeEach(() => writeConfig({ ...ACME, steps: [...ACME.steps, 'watch'], watch: { command: WATCH }, rollback: { command: ROLLBACK } }));

    it('runs the watch command once as one more check, in the project root, and never the rollback', async () => {
      const h = harness();
      const r = await h.run();
      expect(r.code).toBe(0);
      expect(r.last.checks.map((c) => c.step)).toEqual(['migrate-supabase', 'deploy-github', 'smoke', 'watch']);
      expect(r.last.checks[3]).toEqual({ step: 'watch', ok: true, reason: `${WATCH} reports no problems.` });
      expect(h.sh.calls.filter((c) => c === `sh -c ${WATCH}`)).toHaveLength(1);
      expect(h.sh.opts[h.sh.calls.indexOf(`sh -c ${WATCH}`)]).toMatchObject({ cwd: dir });
      expect(h.sh.calls.some((c) => c.includes(ROLLBACK))).toBe(false);
    });

    it('fails when the watch command reports a problem', async () => {
      const h = harness({ rules: [[`sh -c ${WATCH}`, { status: 1, stdout: '4 new errors' }]] });
      const r = await h.run();
      expect(r.code).toBe(1);
      expect(r.last.reason).toBe(`${WATCH} reported a problem: 4 new errors`);
    });

    it('leaves the watch check out when features.watchRollback is off in the local layer', async () => {
      fs.mkdirSync(path.join(dir, '.foreman'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.foreman', 'settings.json'), JSON.stringify({ 'features.watchRollback': false }));
      const h = harness();
      const r = await h.run();
      expect(r.last.checks.map((c) => c.step)).toEqual(['migrate-supabase', 'deploy-github', 'smoke']);
      expect(h.sh.calls.some((c) => c.startsWith('sh -c'))).toBe(false);
    });

    it('--site leaves the watch check out', async () => {
      const h = harness();
      const r = await h.run(['--site']);
      expect(r.last.checks.map((c) => c.step)).toEqual(['smoke']);
      expect(h.sh.calls.some((c) => c.startsWith('sh -c'))).toBe(false);
    });
  });

  it('an invalid config exits 1 with a JSON line', async () => {
    fs.writeFileSync(path.join(dir, 'foreman.config.json'), '{}');
    const r = await harness().run();
    expect(r.code).toBe(1);
    expect(r.last).toMatchObject({ ok: false, checks: [] });
  });

  it('an unknown ship step exits 1 naming it', async () => {
    writeConfig({ steps: ['nope'] });
    const r = await harness().run();
    expect(r.code).toBe(1);
    expect(r.last.reason).toContain('unknown ship step: nope');
  });
});
