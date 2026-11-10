// The Actions helpers the CLI, the Set up step and the doctor share. The fake gh records every
// call; a secret's value only ever goes in as opts.input.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GH_TIMEOUT_MS, WORKFLOW, listSecrets, missingSecrets, repoOf, setSecret, writeWorkflow } from './actions.mjs';
import { actionsWorkflow } from './workflow-template.mjs';
import { withDefaults } from '../config/defaults.mjs';
import { fakeGh } from '../../../test/fake-gh.mjs';

const GH = `ghp_acme_${randomBytes(16).toString('hex')}`;
const KEY = `sk-ant-api03-acme${randomBytes(16).toString('hex')}`;
const cfg = (cloud = {}) => withDefaults({ version: 1, project: { name: 'Acme' }, state: { store: 'branch' }, cloud });

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'foreman-cloud-actions-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// No arg and no opts.env value of any call holds a value.
function clean(sh, values = [GH, KEY]) {
  for (const { args, opts } of sh.calls) {
    for (const v of values) {
      expect(args.join(' ')).not.toContain(v);
      for (const e of Object.values(opts.env ?? {})) expect(String(e)).not.toContain(v);
    }
  }
}

describe('setSecret', () => {
  it('passes the value only as opts.input, with stdio pipe, and the exact gh args', () => {
    const sh = fakeGh();
    const r = setSecret({ repo: 'acme/app', name: 'FOREMAN_GH_TOKEN', value: GH, sh, cwd: root });
    expect(r).toEqual({ ok: true, detail: '' });
    expect(sh.calls).toHaveLength(1);
    const [call] = sh.calls;
    expect(call.cmd).toBe('gh');
    expect(call.args).toEqual(['secret', 'set', 'FOREMAN_GH_TOKEN', '--repo', 'acme/app', '--app', 'actions']);
    expect(call.opts.input).toBe(GH);
    expect(call.opts.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(call.opts.cwd).toBe(root);
    expect(call.opts.env).toBeUndefined();
    expect(GH_TIMEOUT_MS).toBe(30_000);
    expect(call.opts.timeout).toBe(GH_TIMEOUT_MS);
    clean(sh);
    expect(sh.secrets.has('FOREMAN_GH_TOKEN')).toBe(true);
  });

  it('redacts a failure that echoes the value', () => {
    const sh = fakeGh({ setError: { ANTHROPIC_API_KEY: (v) => `HTTP 422: bad value ${v} for acme/app` } });
    const r = setSecret({ repo: 'acme/app', name: 'ANTHROPIC_API_KEY', value: KEY, sh, cwd: root });
    expect(r.ok).toBe(false);
    expect(r.detail).not.toContain(KEY);
    expect(r.detail).toContain('HTTP 422');
    expect(r.detail).toContain('•••');
  });

  it('redacts a value that is not token-shaped', () => {
    const plain = `acme-${randomBytes(8).toString('hex')}`;
    const sh = fakeGh({ setError: { RESEND_API_KEY: (v) => `refused ${v}` } });
    const r = setSecret({ repo: 'acme/app', name: 'RESEND_API_KEY', value: plain, sh, cwd: root });
    expect(r).toEqual({ ok: false, detail: 'refused •••' });
  });
});

describe('listSecrets', () => {
  it("parses gh's --json name answer", () => {
    const sh = fakeGh({ secrets: ['FOREMAN_GH_TOKEN', 'RESEND_API_KEY'] });
    expect(listSecrets({ repo: 'acme/app', sh, cwd: root })).toEqual({ ok: true, names: ['FOREMAN_GH_TOKEN', 'RESEND_API_KEY'] });
    expect(sh.calls[0].args).toEqual(['secret', 'list', '--repo', 'acme/app', '--app', 'actions', '--json', 'name']);
    expect(sh.calls[0].opts.cwd).toBe(root);
    expect(sh.calls[0].opts.timeout).toBe(GH_TIMEOUT_MS);
  });

  it('gives ok false, redacted, when gh fails or answers nonsense', () => {
    // A token as GitHub makes them, which lastLine blanks wherever it appears.
    const real = `ghp_${randomBytes(18).toString('hex').slice(0, 36)}`;
    const r = listSecrets({ repo: 'acme/app', sh: fakeGh({ listError: `HTTP 403: token ${real} cannot read secrets` }), cwd: root });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('HTTP 403');
    expect(r.detail).not.toContain(real);
    const junk = () => ({ status: 0, stdout: 'not json', stderr: '' });
    expect(listSecrets({ repo: 'acme/app', sh: junk, cwd: root }).ok).toBe(false);
  });
});

describe('repoOf', () => {
  const of = (remote, config = {}) => repoOf({ root, config, sh: fakeGh({ remote }) });

  it('parses https and ssh GitHub URLs', () => {
    expect(of('https://github.com/acme/app.git')).toBe('acme/app');
    expect(of('https://github.com/acme/app')).toBe('acme/app');
    expect(of('https://x-access-token@github.com/acme/app.git')).toBe('acme/app');
    expect(of('git@github.com:acme/app.git')).toBe('acme/app');
    expect(of('ssh://git@github.com/acme/my.app.git')).toBe('acme/my.app');
  });

  it('gives null for another host, or no remote', () => {
    expect(of('https://gitlab.com/acme/app.git')).toBeNull();
    expect(of('git@bitbucket.org:acme/app.git')).toBeNull();
    expect(of(null)).toBeNull();
  });

  it("asks git for the config's remote, in root", () => {
    const sh = fakeGh();
    repoOf({ root, config: { remote: 'upstream' }, sh });
    expect(sh.calls[0]).toMatchObject({ cmd: 'git', args: ['remote', 'get-url', 'upstream'], opts: { cwd: root } });
  });
});

describe('missingSecrets', () => {
  const config = cfg({ envVars: ['RESEND_API_KEY', 'SUPABASE_URL', 'GH_TOKEN', 'ANTHROPIC_API_KEY'] });

  it('counts the sign-in pair as set when either name is', () => {
    expect(missingSecrets(config, ['FOREMAN_GH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'RESEND_API_KEY', 'SUPABASE_URL'])).toEqual([]);
    expect(missingSecrets(config, ['FOREMAN_GH_TOKEN', 'ANTHROPIC_API_KEY', 'RESEND_API_KEY', 'SUPABASE_URL'])).toEqual([]);
    expect(missingSecrets(config, ['FOREMAN_GH_TOKEN', 'RESEND_API_KEY', 'SUPABASE_URL'])).toEqual(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);
  });

  it('lists FOREMAN_GH_TOKEN when it is not set', () => {
    expect(missingSecrets(config, ['ANTHROPIC_API_KEY', 'RESEND_API_KEY', 'SUPABASE_URL'])).toEqual(['FOREMAN_GH_TOKEN']);
  });

  it('lists each cloud.envVars name that is not set, without the sign-ins or GH_TOKEN', () => {
    expect(missingSecrets(config, ['FOREMAN_GH_TOKEN', 'ANTHROPIC_API_KEY'])).toEqual(['RESEND_API_KEY', 'SUPABASE_URL']);
    expect(missingSecrets(cfg(), [])).toEqual(['FOREMAN_GH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);
  });
});

describe('writeWorkflow', () => {
  const file = () => join(root, WORKFLOW);

  it("writes exactly actionsWorkflow's text", () => {
    const config = cfg({ envVars: ['RESEND_API_KEY'] });
    expect(WORKFLOW).toBe('.github/workflows/foreman.yml');
    expect(writeWorkflow({ root, config })).toEqual({ file: file(), written: true, exists: false });
    expect(readFileSync(file(), 'utf8')).toBe(actionsWorkflow({ config }));
  });

  it('refuses to overwrite without force', () => {
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(file(), 'mine\n');
    expect(writeWorkflow({ root, config: cfg() })).toEqual({ file: file(), written: false, exists: true });
    expect(readFileSync(file(), 'utf8')).toBe('mine\n');
    expect(writeWorkflow({ root, config: cfg(), force: true })).toEqual({ file: file(), written: true, exists: true });
    expect(readFileSync(file(), 'utf8')).toBe(actionsWorkflow({ config: cfg() }));
  });

  describe('refuses to write through a link, even with force', () => {
    let outside;
    beforeEach(() => {
      outside = mkdtempSync(join(tmpdir(), 'foreman-cloud-outside-'));
    });
    afterEach(() => rmSync(outside, { recursive: true, force: true }));
    const linked = { written: false, exists: true, link: true };

    it('when foreman.yml links to another file', () => {
      const theirs = join(outside, 'theirs.yml');
      writeFileSync(theirs, 'theirs\n');
      mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
      symlinkSync(theirs, file());
      expect(writeWorkflow({ root, config: cfg(), force: true })).toEqual({ file: file(), ...linked });
      expect(readFileSync(theirs, 'utf8')).toBe('theirs\n');
    });

    it('when .github links to another folder', () => {
      symlinkSync(outside, join(root, '.github'));
      expect(writeWorkflow({ root, config: cfg(), force: true })).toEqual({ file: file(), ...linked });
      expect(readdirSync(outside)).toEqual([]);
    });

    it('when .github/workflows links to another folder', () => {
      mkdirSync(join(root, '.github'));
      symlinkSync(outside, join(root, '.github', 'workflows'));
      expect(writeWorkflow({ root, config: cfg(), force: true })).toEqual({ file: file(), ...linked });
      expect(readdirSync(outside)).toEqual([]);
    });

    it('when foreman.yml is a dangling link', () => {
      const missing = join(outside, 'missing.yml');
      mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
      symlinkSync(missing, file());
      expect(writeWorkflow({ root, config: cfg(), force: true })).toEqual({ file: file(), ...linked });
      expect(existsSync(missing)).toBe(false);
    });
  });
});
