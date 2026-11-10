import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mergeMain, { CHECK_LIMIT_MS, classifyConflicts } from './merge-main.mjs';
import { runShip } from '../../engine/ship.mjs';
import { fakeCtx } from '../../../../test/ship-fakes.mjs';
import { readCheckRuns, recordCheckRun } from '../../engine/check-runs.mjs';

const generated = [
  { path: 'tracker/dashboard.html', regenerate: 'node tracker/build-dashboard.mjs' },
  { path: 'src/lib/db/*.types.ts', regenerate: 'npm run -s db:types' },
  { path: 'never/conflicts.txt', regenerate: 'echo nope' },
];
const behind = [['git merge-base --is-ancestor origin/main HEAD', 1]];
const conflict = (files) => [
  ...behind,
  ['git merge --no-edit', 1],
  ['git diff --name-only --diff-filter=U', `${files.join('\n')}\n`],
];

describe('classifyConflicts', () => {
  it('separates generated files from real code, using the patterns given', () => {
    expect(classifyConflicts(['tracker/dashboard.html', 'src/app.ts'], ['tracker/dashboard.html'])).toEqual({ generated: ['tracker/dashboard.html'], code: ['src/app.ts'] });
    expect(classifyConflicts(['src/lib/db/database.types.ts'], ['src/lib/db/*.types.ts'])).toEqual({ generated: ['src/lib/db/database.types.ts'], code: [] });
    expect(classifyConflicts(['a'], [])).toEqual({ generated: [], code: ['a'] });
  });
});

describe('merge-main step', () => {
  it('does nothing when the base is already in the branch', async () => {
    const ctx = fakeCtx({ branch: 'story/s-1' });
    expect(await mergeMain.run(ctx)).toEqual({ ok: true });
    expect(ctx.sh.calls.some((c) => c.startsWith('git merge '))).toBe(false);
  });

  it('merges the base when it is behind', async () => {
    const ctx = fakeCtx({ branch: 'story/s-1', rules: behind });
    expect((await mergeMain.run(ctx)).ok).toBe(true);
    expect(ctx.sh.calls).toContain('git merge --no-edit --quiet origin/main');
  });

  it('uses the configured remote and base branch', async () => {
    const ctx = fakeCtx({ branch: 'story/s-1', config: { remote: 'up', baseBranch: 'trunk' }, rules: [['git merge-base --is-ancestor up/trunk HEAD', 1]] });
    await mergeMain.run(ctx);
    expect(ctx.sh.calls).toContain('git merge --no-edit --quiet up/trunk');
  });

  it('a conflict only in generated files regenerates each one and commits the merge', async () => {
    const ctx = fakeCtx({ branch: 'story/s-1', config: { generated }, rules: conflict(['tracker/dashboard.html', 'src/lib/db/database.types.ts']) });
    const r = await mergeMain.run(ctx);
    expect(r.ok).toBe(true);
    expect(ctx.sh.calls).toContain('sh -c node tracker/build-dashboard.mjs');
    expect(ctx.sh.calls).toContain('sh -c npm run -s db:types');
    expect(ctx.sh.calls).not.toContain('sh -c echo nope');
    expect(ctx.sh.calls).toContain('git add -- tracker/dashboard.html src/lib/db/database.types.ts');
    expect(ctx.sh.calls).toContain('git commit --quiet --no-edit');
    expect(ctx.sh.calls).not.toContain('git merge --abort');
  });

  it('a conflict in real code aborts the merge and exits 6 listing the files', async () => {
    const ctx = fakeCtx({ branch: 'story/s-1', config: { generated }, rules: conflict(['tracker/dashboard.html', 'src/app/page.tsx', 'README.md']) });
    const r = await mergeMain.run(ctx);
    expect(r).toMatchObject({ ok: false, code: 6, stage: 'merge-main', conflicts: ['src/app/page.tsx', 'README.md'] });
    expect(r.reason).toContain('src/app/page.tsx');
    expect(ctx.sh.calls).toContain('git merge --abort');
    expect(ctx.sh.calls.some((c) => c.startsWith('sh -c'))).toBe(false);
  });

  it('a regeneration that fails aborts the merge and exits 1', async () => {
    const ctx = fakeCtx({ branch: 'story/s-1', config: { generated }, rules: [['sh -c node tracker', 1], ...conflict(['tracker/dashboard.html'])] });
    const r = await mergeMain.run(ctx);
    expect(r).toMatchObject({ ok: false, code: 1, stage: 'merge-main' });
    expect(ctx.sh.calls).toContain('git merge --abort');
  });

  it('a merge that fails with no conflicted files aborts and exits 1', async () => {
    const ctx = fakeCtx({ branch: 'story/s-1', rules: conflict([]) });
    expect(await mergeMain.run(ctx)).toMatchObject({ ok: false, code: 1 });
    expect(ctx.sh.calls).toContain('git merge --abort');
  });
});

describe('merge-main: checks on the merged code', () => {
  const checks = [{ run: 'npm test', when: 'always' }];
  const fork = ['git merge-base HEAD origin/main', 'abc\n'];
  const diff = (files) => ['git diff --name-only abc HEAD', `${files.join('\n')}\n`];
  const ctxFor = ({ config = {}, rules = [], ...rest } = {}) => fakeCtx({ branch: 'story/s-1', config: { checks, ...config }, rules, ...rest });
  const ranChecks = (ctx) => ctx.sh.calls.filter((c) => c.startsWith('sh -c'));

  it('runs nothing when the base is already in the branch', async () => {
    const ctx = ctxFor({ rules: [fork, diff(['src/a.js'])] });
    expect(await mergeMain.run(ctx)).toEqual({ ok: true });
    expect(ranChecks(ctx)).toEqual([]);
  });

  it('a clean merge that brings in commits runs the checks on the merged tree, capped', async () => {
    const ctx = ctxFor({ rules: [...behind, fork, diff(['src/a.js'])] });
    const r = await mergeMain.run(ctx);
    expect(r).toEqual({ ok: true, mergeChecks: ['npm test'] });
    const calls = ctx.sh.calls;
    expect(calls).toContain('sh -c npm test');
    const at = (line) => calls.indexOf(line);
    expect(at('git merge-base HEAD origin/main')).toBeGreaterThan(-1);
    expect(at('git merge-base HEAD origin/main')).toBeLessThan(at('git merge --no-edit --quiet origin/main'));
    expect(at('git merge --no-edit --quiet origin/main')).toBeLessThan(at('sh -c npm test'));
    expect(ctx.sh.opts[at('sh -c npm test')].timeout).toBe(CHECK_LIMIT_MS);
    expect(CHECK_LIMIT_MS).toBe(20 * 60_000);
    expect(ctx.reports).toContain('checking the merged code: npm test');
  });

  it('a failing check stops with code 2 and keeps the merge on the branch', async () => {
    const ctx = ctxFor({ rules: [['sh -c npm test', { status: 1, stdout: 'FAIL src/a.test.js\n' }], ...behind, fork, diff(['src/a.js'])] });
    const r = await mergeMain.run(ctx);
    expect(r).toMatchObject({ ok: false, code: 2, stage: 'merge-main', failures: [{ run: 'npm test', exit: 1, timedOut: false }] });
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].tail).toContain('FAIL src/a.test.js');
    expect(r.reason).toContain('npm test');
    expect(r.reason).toContain('main');
    for (const phrase of ['CI failed', 'never started', 'did not finish', 'could not be read']) expect(r.reason).not.toContain(phrase);
    expect(ctx.sh.calls).not.toContain('git merge --abort');
    expect(ctx.sh.calls.some((c) => c.startsWith('git reset'))).toBe(false);
  });

  it('the runner stops at a failing check: the next step never runs and nothing halts', async () => {
    const pushStep = () => ({ name: 'push', ran: 0, run() { this.ran += 1; return { ok: true }; } });
    const failing = ctxFor({ rules: [['sh -c npm test', { status: 1, stdout: 'FAIL src/a.test.js\n' }], ...behind, fork, diff(['src/a.js'])] });
    const push = pushStep();
    const { code, result } = await runShip({ steps: [mergeMain, push], ctx: failing });
    expect(code).toBe(2);
    expect(result.stage).toBe('merge-main');
    expect(result.failures[0].run).toBe('npm test');
    expect(push.ran).toBe(0);
    expect(failing.halts).toEqual([]);

    const passing = ctxFor({ rules: [...behind, fork, diff(['src/a.js'])] });
    const pushed = pushStep();
    const shipped = await runShip({ steps: [mergeMain, pushed], ctx: passing });
    expect(shipped.code).toBe(0);
    expect(pushed.ran).toBe(1);
    expect(passing.sh.calls).toContain('sh -c npm test');
  });

  it('runs no check when a step of the release tests the merged code (CI)', async () => {
    const ctx = ctxFor({ rules: [...behind, fork, diff(['src/a.js'])], testedBy: 'ci' });
    expect(await mergeMain.run(ctx)).toEqual({ ok: true });
    expect(ranChecks(ctx)).toEqual([]);
  });

  it('runs nothing when the project has no checks', async () => {
    const ctx = ctxFor({ config: { checks: [] }, rules: [...behind, fork, diff(['package-lock.json'])] });
    expect((await mergeMain.run(ctx)).ok).toBe(true);
    expect(ranChecks(ctx)).toEqual([]);
  });

  describe('which checks run', () => {
    const three = [
      { run: 'npm test', when: 'always' },
      { run: 'npm run e2e', when: 'e2e/**' },
      { run: 'npm run lint', when: 'src/**' },
    ];

    it('runs the always checks and those whose glob matches a file of the merged change', async () => {
      const ctx = ctxFor({ config: { checks: three }, rules: [...behind, fork, diff(['src/a.js'])] });
      expect(await mergeMain.run(ctx)).toEqual({ ok: true, mergeChecks: ['npm test', 'npm run lint'] });
      expect(ranChecks(ctx)).toEqual(['sh -c npm test', 'sh -c npm run lint']);
    });

    it('runs every check when the merged change cannot be diffed', async () => {
      const ctx = ctxFor({ config: { checks: three }, rules: [...behind, fork, ['git diff --name-only abc HEAD', 1]] });
      expect((await mergeMain.run(ctx)).mergeChecks).toEqual(['npm test', 'npm run e2e', 'npm run lint']);
      for (const run of ['npm test', 'npm run e2e', 'npm run lint']) expect(ranChecks(ctx)).toContain(`sh -c ${run}`);
      // and installs first (the default install, npm ci), since the change is unknown
      expect(ranChecks(ctx)[0]).toBe('sh -c npm ci');
    });

    it('runs every check when the fork point cannot be read', async () => {
      const ctx = ctxFor({ config: { checks: three }, rules: [...behind, ['git merge-base HEAD origin/main', 1], diff(['src/a.js'])] });
      expect((await mergeMain.run(ctx)).mergeChecks).toEqual(['npm test', 'npm run e2e', 'npm run lint']);
    });
  });

  describe('installing dependencies first', () => {
    const install = { run: 'npm ci', when: 'package-lock.json' };

    it('installs before the checks when the merged change touches install.when', async () => {
      const ctx = ctxFor({ config: { install }, rules: [...behind, fork, diff(['package-lock.json'])] });
      expect((await mergeMain.run(ctx)).ok).toBe(true);
      expect(ranChecks(ctx)).toEqual(['sh -c npm ci', 'sh -c npm test']);
      expect(ctx.reports).toContain('installing dependencies for the merged code');
    });

    it('does not install when it does not', async () => {
      const ctx = ctxFor({ config: { install }, rules: [...behind, fork, diff(['src/a.js'])] });
      expect((await mergeMain.run(ctx)).ok).toBe(true);
      expect(ranChecks(ctx)).toEqual(['sh -c npm test']);
    });

    it('a failing install stops with code 2 and runs no check', async () => {
      const ctx = ctxFor({ config: { install }, rules: [['sh -c npm ci', 1], ...behind, fork, diff(['package-lock.json'])] });
      const r = await mergeMain.run(ctx);
      expect(r).toMatchObject({ ok: false, code: 2, stage: 'merge-main' });
      expect(r.failures).toHaveLength(1);
      expect(r.failures[0].run).toBe('npm ci');
      expect(ranChecks(ctx)).toEqual(['sh -c npm ci']);
    });
  });

  it('a conflict only in generated files regenerates, commits, then runs the checks', async () => {
    const ctx = ctxFor({ config: { generated }, rules: [...conflict(['tracker/dashboard.html']), fork, diff(['tracker/dashboard.html', 'src/a.js'])] });
    const r = await mergeMain.run(ctx);
    expect(r).toEqual({ ok: true, regenerated: ['tracker/dashboard.html'], mergeChecks: ['npm test'] });
    const calls = ctx.sh.calls;
    expect(calls.indexOf('git commit --quiet --no-edit')).toBeLessThan(calls.indexOf('sh -c npm test'));
    expect(calls.indexOf('git commit --quiet --no-edit')).toBeGreaterThan(-1);
  });

  it('a failing check after regenerating keeps the regenerated files in the result', async () => {
    const ctx = ctxFor({ config: { generated }, rules: [['sh -c npm test', 1], ...conflict(['tracker/dashboard.html']), fork, diff(['src/a.js'])] });
    expect(await mergeMain.run(ctx)).toMatchObject({ ok: false, code: 2, regenerated: ['tracker/dashboard.html'] });
    expect(ctx.sh.calls).not.toContain('git merge --abort');
  });

  it('a check that runs too long fails as timed out', async () => {
    const ctx = ctxFor({ rules: [['sh -c npm test', { status: 1, timedOut: true }], ...behind, fork, diff(['src/a.js'])] });
    const r = await mergeMain.run(ctx);
    expect(r).toMatchObject({ ok: false, code: 2, failures: [{ run: 'npm test', exit: null, timedOut: true }] });
    expect(r.reason).toContain('ran longer than 20 minutes');
  });

  it('a check that exits 0 but timed out still fails', async () => {
    const ctx = ctxFor({ rules: [['sh -c npm test', { status: 0, timedOut: true }], ...behind, fork, diff(['src/a.js'])] });
    expect(await mergeMain.run(ctx)).toMatchObject({ ok: false, code: 2, failures: [{ timedOut: true, exit: null }] });
  });

  it('blanks secrets out of the output tail', async () => {
    const token = `ghp_${'a'.repeat(30)}`;
    const said = `using secret-value-123 and ${token} and service-role-value-456\nFAIL\n`;
    const ctx = ctxFor({
      env: { GH_TOKEN: 'secret-value-123', SUPABASE_SERVICE_ROLE_KEY: 'service-role-value-456' },
      rules: [['sh -c npm test', { status: 1, stdout: said, stderr: 'API_KEY=plain-value-789' }], ...behind, fork, diff(['src/a.js'])],
    });
    const { tail } = (await mergeMain.run(ctx)).failures[0];
    for (const secret of ['secret-value-123', token, 'service-role-value-456', 'plain-value-789']) expect(tail).not.toContain(secret);
    expect(tail).toContain('•••');
    expect(tail).toContain('FAIL');
  });

  describe("Foreman's own keys", () => {
    const env = () => ({
      PATH: '/usr/bin',
      GEARSET_API_TOKEN: 'gearset-token-value-1',
      JIRA_CLIENT_SECRET: 'jira-secret-value-1',
      RESEND_API_KEY: 're_value_123456',
      ANTHROPIC_API_KEY: 'sk-ant-value-1',
      ACME_API_URL: 'https://acme.test',
    });
    const optsFor = (ctx, line) => ctx.sh.opts[ctx.sh.calls.indexOf(line)];

    it("runs the checks without Foreman's own keys", async () => {
      const ctx = ctxFor({ env: env(), rules: [...behind, fork, diff(['src/a.js'])] });
      expect((await mergeMain.run(ctx)).ok).toBe(true);
      const opts = optsFor(ctx, 'sh -c npm test');
      for (const name of ['GEARSET_API_TOKEN', 'JIRA_CLIENT_SECRET', 'RESEND_API_KEY']) expect(opts.env).not.toHaveProperty(name);
      expect(opts.env).toMatchObject({ PATH: '/usr/bin', ACME_API_URL: 'https://acme.test', ANTHROPIC_API_KEY: 'sk-ant-value-1' });
      expect(opts.timeout).toBe(CHECK_LIMIT_MS);
    });

    it("runs the install without Foreman's own keys", async () => {
      const ctx = ctxFor({ env: env(), config: { install: { run: 'npm ci', when: 'package-lock.json' } }, rules: [...behind, fork, diff(['package-lock.json'])] });
      expect((await mergeMain.run(ctx)).ok).toBe(true);
      const opts = optsFor(ctx, 'sh -c npm ci');
      expect(opts.env).not.toHaveProperty('GEARSET_API_TOKEN');
      expect(opts.env).toMatchObject({ PATH: '/usr/bin' });
    });

    it("falls back to the process environment, still without Foreman's own keys", async () => {
      vi.stubEnv('GEARSET_API_TOKEN', 'gearset-token-value-1');
      vi.stubEnv('ACME_API_URL', 'https://acme.test');
      try {
        const ctx = ctxFor({ rules: [...behind, fork, diff(['src/a.js'])] });
        expect(ctx.env).toBeUndefined();
        await mergeMain.run(ctx);
        const opts = optsFor(ctx, 'sh -c npm test');
        expect(opts.env).not.toHaveProperty('GEARSET_API_TOKEN');
        expect(opts.env.ACME_API_URL).toBe('https://acme.test');
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("leaves the release's own environment alone", async () => {
      const ctx = ctxFor({ env: env(), rules: [...behind, fork, diff(['src/a.js'])] });
      await mergeMain.run(ctx);
      expect(ctx.env).toEqual(env());
    });

    it('still blanks a Foreman key out of the output tail', async () => {
      const ctx = ctxFor({ env: env(), rules: [['sh -c npm test', { status: 1, stdout: 'sent gearset-token-value-1\nFAIL\n' }], ...behind, fork, diff(['src/a.js'])] });
      const { tail } = (await mergeMain.run(ctx)).failures[0];
      expect(tail).not.toContain('gearset-token-value-1');
      expect(tail).toContain('•••');
    });
  });

  it('keeps only the last 4000 characters of the output', async () => {
    const ctx = ctxFor({ rules: [['sh -c npm test', { status: 1, stdout: `START${'x'.repeat(5000)}END` }], ...behind, fork, diff(['src/a.js'])] });
    const { tail } = (await mergeMain.run(ctx)).failures[0];
    expect(tail.length).toBeLessThanOrEqual(4000);
    expect(tail.endsWith('END')).toBe(true);
    expect(tail).not.toContain('START');
  });

  it('beats before and after each command, so a long check is not taken for a stall', async () => {
    let beats = 0;
    const ctx = ctxFor({ config: { install: { run: 'npm ci', when: 'package-lock.json' } }, rules: [...behind, fork, diff(['package-lock.json'])], beat: () => (beats += 1) });
    await mergeMain.run(ctx);
    expect(ranChecks(ctx)).toHaveLength(2);
    expect(beats).toBeGreaterThanOrEqual(4);
  });
});

describe('merge-main: reusing a record of the same merged tree', () => {
  const TREE = 'c'.repeat(40);
  const checks = [{ run: 'npm test', when: 'always' }];
  const fork = ['git merge-base HEAD origin/main', 'abc\n'];
  const diff = (files) => ['git diff --name-only abc HEAD', `${files.join('\n')}\n`];
  const clean = [['git status --porcelain', ''], ['git rev-parse HEAD^{tree}', `${TREE}\n`]];
  // The run's own state folder: the project's folder plus config.stateDir (default .foreman).
  let project;
  let state;
  let env;
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'foreman-merge-main-'));
    state = join(project, '.foreman');
    env = { FOREMAN_PROJECT_DIR: project, FOREMAN_STATE_DIR: state };
  });
  afterEach(() => rmSync(project, { recursive: true, force: true }));

  const record = (extra = {}) => ({ at: '2026-10-15T11:00:00.000Z', story: 'ACME-1', slot: 'w1', run: 'npm test', full: true, tree: TREE, exit: 0, ms: 1000, tail: 'all green', env: 'session', ...extra });
  const ctxFor = ({ config = {}, rules = [], ...rest } = {}) =>
    fakeCtx({ branch: 'story/s-1', env, config: { checks, ...config }, rules: [...rules, ...clean, ...behind, fork], ...rest });
  const ranChecks = (ctx) => ctx.sh.calls.filter((c) => c.startsWith('sh -c'));

  it('does not run a check with a session record for the merged tree, nor install, and records the reuse', async () => {
    recordCheckRun(state, record());
    const ctx = ctxFor({ config: { install: { run: 'npm ci', when: 'package-lock.json' } }, rules: [diff(['package-lock.json'])] });
    const r = await mergeMain.run(ctx);
    expect(r).toEqual({ ok: true, mergeChecks: ['npm test'], mergeChecksReused: ['npm test'] });
    expect(ranChecks(ctx)).toEqual([]);
    expect(ctx.reports).toContain('checking the merged code: reusing the record of npm test');
    const lines = readCheckRuns(state);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toEqual({ at: ctx.now().toISOString(), story: 'S-1', slot: 'w1', run: 'npm test', full: true, tree: TREE, reused: true, from: '2026-10-15T11:00:00.000Z', by: 'merge-main' });
  });

  it('uses the state folder under the project root when the env names none', async () => {
    const root = mkdtempSync(join(tmpdir(), 'foreman-merge-main-root-'));
    try {
      recordCheckRun(join(root, '.foreman'), record());
      const ctx = ctxFor({ env: {}, root, rules: [diff(['src/a.js'])] });
      expect((await mergeMain.run(ctx)).mergeChecksReused).toEqual(['npm test']);
      expect(ranChecks(ctx)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a reused failing record stops with code 2 and its tail', async () => {
    recordCheckRun(state, record({ exit: 4, tail: 'FAIL src/a.test.js' }));
    const ctx = ctxFor({ rules: [diff(['src/a.js'])] });
    const r = await mergeMain.run(ctx);
    expect(r).toMatchObject({ ok: false, code: 2, stage: 'merge-main', failures: [{ run: 'npm test', exit: 4, timedOut: false, tail: 'FAIL src/a.test.js', reused: true }] });
    expect(r.reason).toContain('npm test');
    expect(ranChecks(ctx)).toEqual([]);
    expect(readCheckRuns(state).at(-1)).toMatchObject({ reused: true, by: 'merge-main' });
  });

  it.each([
    ['no record', () => {}],
    ['a record made in the caller env', () => recordCheckRun(state, record({ env: 'caller' }))],
    ['a record with no env', () => recordCheckRun(state, record({ env: undefined }))],
    ['a record of another tree', () => recordCheckRun(state, record({ tree: 'd'.repeat(40) }))],
    ['a record of another command', () => recordCheckRun(state, record({ run: 'npm run lint' }))],
  ])('runs the check as before with %s', async (_, seed) => {
    seed();
    const ctx = ctxFor({ config: { install: { run: 'npm ci', when: 'package-lock.json' } }, rules: [diff(['package-lock.json'])] });
    const r = await mergeMain.run(ctx);
    expect(r).toEqual({ ok: true, mergeChecks: ['npm test'] });
    expect(ranChecks(ctx)).toEqual(['sh -c npm ci', 'sh -c npm test']);
  });

  it('runs the checks without a record, and installs for them, while reusing the one with a record', async () => {
    recordCheckRun(state, record());
    const two = [{ run: 'npm test', when: 'always' }, { run: 'npm run lint', when: 'always' }];
    const ctx = ctxFor({ config: { checks: two, install: { run: 'npm ci', when: 'package-lock.json' } }, rules: [diff(['package-lock.json'])] });
    const r = await mergeMain.run(ctx);
    expect(r).toEqual({ ok: true, mergeChecks: ['npm test', 'npm run lint'], mergeChecksReused: ['npm test'] });
    expect(ranChecks(ctx)).toEqual(['sh -c npm ci', 'sh -c npm run lint']);
  });

  it('keeps a real failure beside a reused pass', async () => {
    recordCheckRun(state, record());
    const two = [{ run: 'npm test', when: 'always' }, { run: 'npm run lint', when: 'always' }];
    const ctx = ctxFor({ config: { checks: two }, rules: [['sh -c npm run lint', { status: 1, stdout: 'lint bad\n' }], diff(['src/a.js'])] });
    const r = await mergeMain.run(ctx);
    expect(r).toMatchObject({ ok: false, code: 2, failures: [{ run: 'npm run lint', exit: 1 }] });
    expect(r.failures[0]).not.toHaveProperty('reused');
  });

  it('does not reuse when the working tree is not clean', async () => {
    recordCheckRun(state, record());
    const ctx = ctxFor({ rules: [['git status --porcelain', ' M src/a.js\n'], diff(['src/a.js'])] });
    const r = await mergeMain.run(ctx);
    expect(r).toEqual({ ok: true, mergeChecks: ['npm test'] });
    expect(ranChecks(ctx)).toEqual(['sh -c npm test']);
  });

  it.each([['git cannot say'], ['not-a-tree-id']])('does not reuse when HEAD has no usable tree id (%s)', async (answer) => {
    recordCheckRun(state, record());
    const bad = answer === 'git cannot say' ? ['git rev-parse HEAD^{tree}', 128] : ['git rev-parse HEAD^{tree}', 'nope\n'];
    const ctx = fakeCtx({ branch: 'story/s-1', env, config: { checks }, rules: [bad, ['git status --porcelain', ''], ...behind, fork, diff(['src/a.js'])] });
    expect((await mergeMain.run(ctx)).mergeChecksReused).toBeUndefined();
    expect(ranChecks(ctx)).toEqual(['sh -c npm test']);
  });

  it('a reuse that cannot be recorded is still a reuse, and says nothing', async () => {
    recordCheckRun(state, record());
    chmodSync(join(state, 'check-runs.jsonl'), 0o444);
    const ctx = ctxFor({ rules: [diff(['src/a.js'])] });
    const r = await mergeMain.run(ctx);
    expect(r).toEqual({ ok: true, mergeChecks: ['npm test'], mergeChecksReused: ['npm test'] });
    expect(ranChecks(ctx)).toEqual([]);
    expect(ctx.events).toEqual([]);
  });

  it('makes no extra git call without a state folder or a root, and runs as before', async () => {
    const ctx = fakeCtx({ branch: 'story/s-1', config: { checks }, rules: [...behind, fork, diff(['src/a.js'])] });
    expect(await mergeMain.run(ctx)).toEqual({ ok: true, mergeChecks: ['npm test'] });
    expect(ctx.sh.calls).not.toContain('git status --porcelain');
    expect(ctx.sh.calls).not.toContain('git rev-parse HEAD^{tree}');
    const other = fakeCtx({ branch: 'story/s-1', env: { GEARSET_TOKEN: 'x' }, config: { checks }, rules: [...behind, fork, diff(['src/a.js'])] });
    await mergeMain.run(other);
    expect(other.sh.calls.some((c) => c.startsWith('git status') || c.startsWith('git rev-parse HEAD'))).toBe(false);
  });

  describe('only from the run\'s own state folder', () => {
    let other;
    beforeEach(() => {
      other = mkdtempSync(join(tmpdir(), 'foreman-merge-main-other-'));
    });
    afterEach(() => rmSync(other, { recursive: true, force: true }));

    it('runs the check when FOREMAN_STATE_DIR names another folder holding a passing record', async () => {
      recordCheckRun(other, record());
      const ctx = ctxFor({ env: { FOREMAN_PROJECT_DIR: project, FOREMAN_STATE_DIR: other }, rules: [diff(['src/a.js'])] });
      const r = await mergeMain.run(ctx);
      expect(r).toEqual({ ok: true, mergeChecks: ['npm test'] });
      expect(ranChecks(ctx)).toEqual(['sh -c npm test']);
      expect(readCheckRuns(other)).toHaveLength(1);
      expect(readCheckRuns(state)).toEqual([]);
    });

    it('runs the check when FOREMAN_STATE_DIR is set without FOREMAN_PROJECT_DIR, and asks git nothing about the tree', async () => {
      recordCheckRun(state, record());
      const ctx = ctxFor({ env: { FOREMAN_STATE_DIR: state }, rules: [diff(['src/a.js'])] });
      const r = await mergeMain.run(ctx);
      expect(r).toEqual({ ok: true, mergeChecks: ['npm test'] });
      expect(ranChecks(ctx)).toEqual(['sh -c npm test']);
      expect(ctx.sh.calls).not.toContain('git status --porcelain');
      expect(readCheckRuns(state)).toHaveLength(1);
    });

    it('runs the check when FOREMAN_STATE_DIR is not the folder config.stateDir names', async () => {
      recordCheckRun(state, record());
      const ctx = ctxFor({ config: { stateDir: 'state/acme' }, rules: [diff(['src/a.js'])] });
      const r = await mergeMain.run(ctx);
      expect(r.mergeChecksReused).toBeUndefined();
      expect(ranChecks(ctx)).toEqual(['sh -c npm test']);
    });

    it('reuses from config.stateDir, comparing the paths after resolving them', async () => {
      const folder = join(project, 'state', 'acme');
      recordCheckRun(folder, record());
      const ctx = ctxFor({ env: { FOREMAN_PROJECT_DIR: project, FOREMAN_STATE_DIR: join(folder, '.') }, config: { stateDir: 'state/acme' }, rules: [diff(['src/a.js'])] });
      const r = await mergeMain.run(ctx);
      expect(r.mergeChecksReused).toEqual(['npm test']);
      expect(ranChecks(ctx)).toEqual([]);
      expect(readCheckRuns(folder)).toHaveLength(2);
    });
  });

  it('never runs reuse for a merge that brought in nothing', async () => {
    recordCheckRun(state, record());
    const ctx = fakeCtx({ branch: 'story/s-1', env, config: { checks }, rules: [fork, diff(['src/a.js']), ...clean] });
    expect(await mergeMain.run(ctx)).toEqual({ ok: true });
  });
});
