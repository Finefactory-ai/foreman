// The doctor checks of the Cloud runner step: each runs only when its file is there.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs, { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloudChecks } from './doctor-cloud.mjs';
import { buildChecks } from './doctor-checks.mjs';
import { WORKFLOW } from '../cloud/actions.mjs';
import { actionsWorkflow } from '../cloud/workflow-template.mjs';
import { withDefaults } from '../config/defaults.mjs';
import { stepById } from '../setup/steps.mjs';
import { fakeGh } from '../../../test/fake-gh.mjs';

let root;
const cfg = (over = {}) => withDefaults({ version: 1, project: { name: 'Acme' }, state: { store: 'branch' }, cloud: { envVars: ['RESEND_API_KEY'] }, ...over });
const ctxFor = (sh = fakeGh({ root })) => ({ root, env: {}, sh, fs });

const writeFlow = (text) => {
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(root, WORKFLOW), text);
};

async function results(config, ctx) {
  const out = {};
  for (const c of cloudChecks(config, ctx)) out[c.name] = await c.run(ctx);
  return out;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'foreman-doctor-cloud-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('cloudChecks', () => {
  it('adds no check with no workflow and no .env.runner', () => {
    const sh = fakeGh({ root });
    expect(cloudChecks(cfg(), ctxFor(sh))).toEqual([]);
    expect(sh.calls).toEqual([]);
  });

  it('ties every check to the cloud-runner step', () => {
    writeFlow(actionsWorkflow({ config: cfg() }));
    writeFileSync(join(root, '.env.runner'), 'FOREMAN_REPO=acme/app\n', { mode: 0o600 });
    const checks = cloudChecks(cfg(), ctxFor());
    expect(checks.map((c) => c.name)).toEqual(['cloud workflow', 'cloud secrets', 'cloud runner file']);
    for (const c of checks) expect(c.step).toBe('cloud-runner');
    expect(stepById('cloud-runner')).toBeDefined();
  });

  it("goes through buildChecks, before 'workflows', with withFix", async () => {
    writeFlow(actionsWorkflow({ config: cfg({ state: { store: 'files' } }) }));
    const config = cfg({ state: { store: 'files' } });
    const ctx = { ...ctxFor(), sourceRoot: root, pluginsDir: root };
    const checks = buildChecks(config, ctx);
    const names = checks.map((c) => c.name);
    expect(names.indexOf('cloud workflow')).toBeGreaterThan(-1);
    expect(names.indexOf('cloud workflow')).toBeLessThan(names.indexOf('workflows'));
    const r = await checks.find((c) => c.name === 'cloud workflow').run(ctx);
    expect(r.fix.step).toBe('cloud-runner');
  });
});

describe("'cloud workflow'", () => {
  it('fails when the state store is not a branch', async () => {
    const config = cfg({ state: { store: 'files' } });
    writeFlow(actionsWorkflow({ config }));
    const r = (await results(config, ctxFor()))['cloud workflow'];
    expect(r).toMatchObject({ ok: false, level: 'error' });
    expect(r.fix.hint).toMatch(/Set up/);
  });

  it('warns when the text is not what this Foreman writes', async () => {
    writeFlow(`${actionsWorkflow({ config: cfg() })}# changed by hand\n`);
    const r = (await results(cfg(), ctxFor()))['cloud workflow'];
    expect(r).toMatchObject({ ok: false, level: 'warn' });
    expect(r.fix.hint).toMatch(/Set up/);
  });

  it('is ok when current', async () => {
    writeFlow(actionsWorkflow({ config: cfg() }));
    expect((await results(cfg(), ctxFor()))['cloud workflow']).toMatchObject({ ok: true });
  });
});

describe("'cloud secrets'", () => {
  it('fails naming the missing names', async () => {
    writeFlow(actionsWorkflow({ config: cfg() }));
    const sh = fakeGh({ root, secrets: ['FOREMAN_GH_TOKEN'] });
    const r = (await results(cfg(), ctxFor(sh)))['cloud secrets'];
    expect(r).toMatchObject({ ok: false, level: 'error' });
    for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'RESEND_API_KEY']) expect(r.detail).toContain(name);
    expect(r.detail).not.toContain('FOREMAN_GH_TOKEN');
    expect(sh.calls.map((c) => [c.cmd, ...c.args].join(' '))).toEqual(['git remote get-url origin', 'gh secret list --repo acme/app --app actions --json name']);
  });

  it('is ok when every name is set', async () => {
    writeFlow(actionsWorkflow({ config: cfg() }));
    const sh = fakeGh({ root, secrets: ['FOREMAN_GH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'RESEND_API_KEY'] });
    expect((await results(cfg(), ctxFor(sh)))['cloud secrets']).toMatchObject({ ok: true });
  });

  it('warns when gh cannot list, or there is no GitHub remote', async () => {
    writeFlow(actionsWorkflow({ config: cfg() }));
    const listing = (await results(cfg(), ctxFor(fakeGh({ root, listError: 'HTTP 403: Resource not accessible' }))))['cloud secrets'];
    expect(listing).toMatchObject({ ok: false, level: 'warn' });
    expect(listing.detail).toContain('HTTP 403');
    const noRepo = (await results(cfg(), ctxFor(fakeGh({ root, remote: 'https://gitlab.com/acme/app.git' }))))['cloud secrets'];
    expect(noRepo).toMatchObject({ ok: false, level: 'warn' });
  });
});

describe("'cloud runner file'", () => {
  const runner = (mode = 0o600) => {
    writeFileSync(join(root, '.env.runner'), 'FOREMAN_REPO=acme/app\n', { mode });
    chmodSync(join(root, '.env.runner'), mode);
  };

  it('fails when git does not ignore the file', async () => {
    runner();
    const r = (await results(cfg(), ctxFor()))['cloud runner file'];
    expect(r).toMatchObject({ ok: false, level: 'error' });
    expect(r.detail).toContain('.env.runner');
  });

  it('warns at mode 644, and is ok at 600 when ignored', async () => {
    writeFileSync(join(root, '.gitignore'), '.env.runner\n');
    runner(0o644);
    const loose = (await results(cfg(), ctxFor()))['cloud runner file'];
    expect(loose).toMatchObject({ ok: false, level: 'warn' });
    expect(loose.detail).toMatch(/chmod 600/);
    chmodSync(join(root, '.env.runner'), 0o600);
    expect((await results(cfg(), ctxFor()))['cloud runner file']).toMatchObject({ ok: true });
  });

  it('fails when git tracks the file, even though it is ignored', async () => {
    writeFileSync(join(root, '.gitignore'), '.env.runner\n');
    runner();
    const r = (await results(cfg(), ctxFor(fakeGh({ root, tracked: ['.env.runner'] }))))['cloud runner file'];
    expect(r).toMatchObject({ ok: false, level: 'error' });
    expect(r.detail).toContain('git tracks');
    expect(r.fix.hint).toContain('git rm --cached');
  });

  describe('as a link', () => {
    let outside;
    beforeEach(() => {
      outside = mkdtempSync(join(tmpdir(), 'foreman-doctor-outside-'));
      writeFileSync(join(root, '.gitignore'), '.env.runner\n');
    });
    afterEach(() => rmSync(outside, { recursive: true, force: true }));

    it('fails when the file links to another file', async () => {
      const target = join(outside, 'runner.env');
      writeFileSync(target, 'FOREMAN_REPO=acme/app\n', { mode: 0o600 });
      symlinkSync(target, join(root, '.env.runner'));
      const r = (await results(cfg(), ctxFor()))['cloud runner file'];
      expect(r).toMatchObject({ ok: false, level: 'error' });
      expect(r.detail).toContain('link');
      expect(readFileSync(target, 'utf8')).toBe('FOREMAN_REPO=acme/app\n');
    });

    it('is still checked, and fails, when the link dangles', async () => {
      symlinkSync(join(outside, 'missing.env'), join(root, '.env.runner'));
      expect(cloudChecks(cfg(), ctxFor()).map((c) => c.name)).toContain('cloud runner file');
      const r = (await results(cfg(), ctxFor()))['cloud runner file'];
      expect(r).toMatchObject({ ok: false, level: 'error' });
      expect(r.detail).toContain('link');
    });
  });
});
