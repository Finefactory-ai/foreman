import { describe, expect, it, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { keyNames, placeKeys, serialize, withoutKeys, writeEnvFile } from './env-file.mjs';
import { withDefaults } from '../config/defaults.mjs';

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-envfile-'));
});

const cfg = (over = {}) => withDefaults({ version: 1, project: { name: 'P' }, ...over });
const read = () => parseEnv(fs.readFileSync(path.join(root, '.env.local'), 'utf8'));

describe('keyNames', () => {
  it('is what the adapters declare plus cloud.envVars, without the sign-ins and the GitHub token', () => {
    const config = cfg({ notify: { adapter: 'email-resend' }, cloud: { envVars: ['SUPABASE_URL', 'RESEND_API_KEY', 'GH_TOKEN', 'ANTHROPIC_API_KEY'] } });
    expect(keyNames(config)).toEqual(['RESEND_API_KEY', 'RESEND_FROM_EMAIL', 'SUPABASE_URL']);
  });

  it('is empty for a project that needs no keys', () => {
    expect(keyNames(cfg())).toEqual([]);
  });
});

describe('serialize', () => {
  it('writes values that Node reads back exactly', () => {
    const values = ['plain', 'has space', 'a#b', "it's", 'say "hi"', 'multi\nline', 'back\\slash', 'dollar $HOME', 'both \' and "', ' lead', 'x=y', ''];
    for (const v of values) expect(parseEnv(`${serialize('K', v)}\nNEXT=1\n`)).toEqual({ K: v, NEXT: '1' });
  });

  it('returns null for a value no quoting keeps intact', () => {
    expect(serialize('K', 'all \' " ` three')).toBeNull();
  });
});

describe('writeEnvFile', () => {
  const config = cfg({ cloud: { envVars: ['RESEND_API_KEY', 'SUPABASE_URL', 'MISSING_ONE'] } });

  it('writes the named variables that are set, and says which were missing', () => {
    const r = writeEnvFile({ root, config, env: { RESEND_API_KEY: 're_secret', SUPABASE_URL: 'https://x.supabase.co', OTHER: 'no' } });
    expect(r).toEqual({ file: path.join(root, '.env.local'), written: ['RESEND_API_KEY', 'SUPABASE_URL'], missing: ['MISSING_ONE'], refused: [] });
    expect(read()).toEqual({ RESEND_API_KEY: 're_secret', SUPABASE_URL: 'https://x.supabase.co' });
  });

  it('keeps the other lines already in the file and replaces the named ones', () => {
    fs.writeFileSync(path.join(root, '.env.local'), '# mine\nLOCAL_ONLY=1\nRESEND_API_KEY=old\nexport SUPABASE_URL="old"\n');
    writeEnvFile({ root, config, env: { RESEND_API_KEY: 'new', SUPABASE_URL: 'u' } });
    const text = fs.readFileSync(path.join(root, '.env.local'), 'utf8');
    expect(text).toContain('# mine\nLOCAL_ONLY=1\n');
    expect(text).not.toContain('old');
    expect(read()).toEqual({ LOCAL_ONLY: '1', RESEND_API_KEY: 'new', SUPABASE_URL: 'u' });
  });

  it('treats an empty variable as missing, as an unset Actions secret is', () => {
    const r = writeEnvFile({ root, config, env: { RESEND_API_KEY: '', SUPABASE_URL: 'u' } });
    expect(r.missing).toEqual(['RESEND_API_KEY', 'MISSING_ONE']);
  });

  it('refuses a value it cannot write intact, by name only', () => {
    const r = writeEnvFile({ root, config, env: { RESEND_API_KEY: 'a \' " ` b', SUPABASE_URL: 'u' } });
    expect(r.refused).toEqual(['RESEND_API_KEY']);
    expect(fs.readFileSync(path.join(root, '.env.local'), 'utf8')).not.toContain('a \'');
  });

  it('writes nothing, and creates no file, when no variable is named', () => {
    const r = writeEnvFile({ root, config: cfg(), env: { RESEND_API_KEY: 'x' } });
    expect(r.written).toEqual([]);
    expect(fs.existsSync(path.join(root, '.env.local'))).toBe(false);
  });

  it('makes the file readable by its owner only', () => {
    writeEnvFile({ root, config, env: { RESEND_API_KEY: 'x' } });
    expect(fs.statSync(path.join(root, '.env.local')).mode & 0o777).toBe(0o600);
  });

  it('uses the configured envFile', () => {
    writeEnvFile({ root, config: cfg({ envFile: 'config/.env', cloud: { envVars: ['A'] } }), env: { A: '1' } });
    expect(fs.readFileSync(path.join(root, 'config', '.env'), 'utf8')).toContain('A=');
  });
});

describe('withoutKeys', () => {
  it('drops the written keys from an environment and leaves the rest', () => {
    expect(withoutKeys({ A: '1', B: '2', GH_TOKEN: 't' }, ['A'])).toEqual({ B: '2', GH_TOKEN: 't' });
  });
});

describe('placeKeys', () => {
  const config = cfg({ cloud: { envVars: ['RESEND_API_KEY', 'SUPABASE_URL'] } });
  const env = () => ({ RESEND_API_KEY: 're_acme_value', SUPABASE_URL: 'https://acme.supabase.co', GH_TOKEN: 'ghp_x', ANTHROPIC_API_KEY: 'sk-ant-x', PATH: '/bin' });
  const readFile = (name) => parseEnv(fs.readFileSync(path.join(root, name), 'utf8'));
  const exists = (name) => fs.existsSync(path.join(root, name));
  // A shell whose `git check-ignore` answers from `ignored(file)`.
  const fakeSh = (ignored) => (cmd, args) => ({ status: cmd === 'git' && args[0] === 'check-ignore' && !ignored(args[args.length - 1]) ? 1 : 0, stdout: '', stderr: '' });
  // The real git, with no global or system config.
  const gitEnv = () => ({ PATH: process.env.PATH, HOME: path.join(root, '.home'), XDG_CONFIG_HOME: path.join(root, '.home'), GIT_CONFIG_NOSYSTEM: '1' });
  const gitSh = (cmd, args = [], opts = {}) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(), ...opts });
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };

  it("writes Foreman's keys to .env.foreman at mode 600 and the project's to .env.local, and returns an env with neither", () => {
    const r = placeKeys({ root, config, env: env(), sh: fakeSh(() => true) });
    expect(readFile('.env.foreman')).toEqual({ RESEND_API_KEY: 're_acme_value' });
    expect(fs.statSync(path.join(root, '.env.foreman')).mode & 0o777).toBe(0o600);
    expect(readFile('.env.local')).toEqual({ SUPABASE_URL: 'https://acme.supabase.co' });
    expect(r.env).toEqual({ GH_TOKEN: 'ghp_x', ANTHROPIC_API_KEY: 'sk-ant-x', PATH: '/bin' });
    expect(r.warnings).toEqual([]);
  });

  it('adds .env.foreman to .git/info/exclude when git does not ignore it, then writes it, leaving .gitignore alone', () => {
    expect(gitSh('git', ['init', '-q'], { cwd: root }).status).toBe(0);
    fs.writeFileSync(path.join(root, '.gitignore'), '.env.local\n');
    const r = placeKeys({ root, config, env: env(), sh: (cmd, args, opts) => gitSh(cmd, args, opts) });
    expect(fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8').split('\n')).toContain('.env.foreman');
    expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')).toBe('.env.local\n');
    expect(readFile('.env.foreman')).toEqual({ RESEND_API_KEY: 're_acme_value' });
    expect(readFile('.env.local')).toEqual({ SUPABASE_URL: 'https://acme.supabase.co' });
    expect(r.warnings).toEqual([]);
  });

  it('writes nothing to .env.foreman when git still does not ignore it, and says so by name', () => {
    fs.mkdirSync(path.join(root, '.git', 'info'), { recursive: true });
    const r = placeKeys({ root, config, env: env(), sh: fakeSh((file) => file !== '.env.foreman') });
    expect(exists('.env.foreman')).toBe(false);
    expect(r.env.RESEND_API_KEY).toBeUndefined();
    expect(r.warnings).toEqual([".env.foreman is not ignored by git, so Foreman's keys were not written to it; add it to .gitignore"]);
    expect(readFile('.env.local')).toEqual({ SUPABASE_URL: 'https://acme.supabase.co' });
    expect(JSON.stringify(r)).not.toContain('re_acme_value');
  });

  // A real repo with both files ignored and `tracked` already in the index.
  const trackedRepo = (tracked) => {
    expect(gitSh('git', ['init', '-q'], { cwd: root }).status).toBe(0);
    fs.writeFileSync(path.join(root, '.gitignore'), '.env.local\n.env.foreman\n');
    fs.writeFileSync(path.join(root, tracked), '# mine\n');
    expect(gitSh('git', ['add', '-f', tracked], { cwd: root }).status).toBe(0);
  };

  it('writes nothing to a .env.foreman that git tracks, and says so by name', () => {
    trackedRepo('.env.foreman');
    const r = placeKeys({ root, config, env: env(), sh: gitSh });
    expect(r.warnings).toContain(".env.foreman is tracked by git, so Foreman's keys were not written to it; remove it from the index first");
    expect(fs.readFileSync(path.join(root, '.env.foreman'), 'utf8')).toBe('# mine\n');
    expect(r.env.RESEND_API_KEY).toBeUndefined();
    expect(readFile('.env.local')).toEqual({ SUPABASE_URL: 'https://acme.supabase.co' });
    expect(JSON.stringify(r)).not.toContain('re_acme_value');
  });

  it("writes nothing to a .env.local that git tracks, and says so by name", () => {
    trackedRepo('.env.local');
    const r = placeKeys({ root, config, env: env(), sh: gitSh });
    expect(r.warnings).toContain(".env.local is tracked by git, so the project's keys were not written to it; remove it from the index first");
    expect(fs.readFileSync(path.join(root, '.env.local'), 'utf8')).toBe('# mine\n');
    expect(r.env.SUPABASE_URL).toBeUndefined();
    expect(readFile('.env.foreman')).toEqual({ RESEND_API_KEY: 're_acme_value' });
    expect(JSON.stringify(r)).not.toContain('acme.supabase.co');
  });

  it('names the missing keys of both files in one warning', () => {
    const r = placeKeys({ root, config, env: { GH_TOKEN: 'ghp_x' }, sh: fakeSh(() => true) });
    expect(r.warnings).toEqual(["not set: RESEND_API_KEY, SUPABASE_URL (the project's keys, from cloud.envVars and the adapters)"]);
  });
});
