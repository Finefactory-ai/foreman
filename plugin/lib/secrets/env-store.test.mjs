import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { checkName, fileFor, ignoreKeyFile, keyState, mask, removeKey, secretValue, setKey, writeKeys } from './env-store.mjs';

let tmp;
let home;
let root;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-env-store-'));
  home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  root = path.join(tmp, 'acme');
  fs.mkdirSync(root);
  spawnSync('git', ['init', '-q'], { cwd: root, env: baseEnv() });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

// No global or system git config, so no global excludes file decides what is ignored.
const baseEnv = () => ({ PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1' });
const sh = (cmd, args = [], opts = {}) => {
  const r = spawnSync(cmd, args, { env: baseEnv(), encoding: 'utf8', ...opts });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};
const config = { project: { name: 'Acme' } };
const ctx = (extra = {}) => ({ root, config, env: {}, sh, ...extra });
const ignoreAll = () => fs.writeFileSync(path.join(root, '.gitignore'), '.env.local\n.env.foreman\n');
const at = (f) => path.join(root, f);
const read = (f) => fs.readFileSync(at(f), 'utf8');
const modeOf = (f) => fs.statSync(at(f)).mode & 0o777;
const tmpLeft = () => fs.readdirSync(root).filter((f) => f.endsWith('.tmp'));

describe('setKey and removeKey', () => {
  beforeEach(ignoreAll);

  it('leaves the old file when the write fails between the temp file and the rename', async () => {
    fs.writeFileSync(at('.env.foreman'), 'RESEND_API_KEY=re_old\n', { mode: 0o600 });
    const failing = { ...fs, renameSync: () => { throw new Error('acme crash'); } };
    await expect(setKey('RESEND_API_KEY', 're_acme_new', ctx({ fs: failing }))).rejects.toThrow('acme crash');
    expect(read('.env.foreman')).toBe('RESEND_API_KEY=re_old\n');
    expect(tmpLeft()).toEqual([]);
  });

  it('leaves the file at mode 600 after every write', async () => {
    fs.writeFileSync(at('.env.foreman'), 'ACME=1\n', { mode: 0o644 });
    fs.chmodSync(at('.env.foreman'), 0o644);
    expect((await setKey('RESEND_API_KEY', 're_acme_1', ctx())).file).toBe('.env.foreman');
    expect(modeOf('.env.foreman')).toBe(0o600);
    await setKey('RESEND_FROM_EMAIL', 'acme@example.com', ctx());
    expect(modeOf('.env.foreman')).toBe(0o600);
    expect(await removeKey('RESEND_API_KEY', ctx())).toEqual({ file: '.env.foreman', removed: true });
    expect(modeOf('.env.foreman')).toBe(0o600);
    await setKey('ACME_DB_URL', 'postgres://acme', ctx());
    expect(modeOf('.env.local')).toBe(0o600);
  });

  it('keeps comments and other lines and replaces only the old line', async () => {
    fs.writeFileSync(at('.env.foreman'), '# acme\nACME_URL=http://localhost\nRESEND_API_KEY=old\n');
    await setKey('RESEND_API_KEY', 're_acme_new', ctx());
    expect(read('.env.foreman')).toBe("# acme\nACME_URL=http://localhost\nRESEND_API_KEY='re_acme_new'\n");
  });

  it('writes a multi-line value that parseEnv reads back', async () => {
    await setKey('ACME_CERT', 'line1\nline2 "q"', ctx());
    expect(parseEnv(read('.env.local'))).toEqual({ ACME_CERT: 'line1\nline2 "q"' });
  });

  it('refuses a value no quoting keeps intact, without saying it', async () => {
    fs.writeFileSync(at('.env.local'), 'ACME_URL=u\n');
    const value = 'acme \' " ` value';
    const err = await setKey('ACME_KEY', value, ctx()).catch((e) => e);
    expect(err.message).toBe('the value of ACME_KEY cannot be written safely');
    expect(err.message).not.toContain('acme \'');
    expect(read('.env.local')).toBe('ACME_URL=u\n');
  });

  it('refuses a bad name and an empty value', async () => {
    const bad = await setKey('1ACME', 'x', ctx()).catch((e) => e);
    expect(bad.message).toBe('that is not a key name: use letters, digits and _, not starting with a digit');
    expect(bad.message).not.toContain('1ACME');
    await expect(setKey('ACME_KEY', '', ctx())).rejects.toThrow('ACME_KEY is empty');
    await expect(setKey('ACME_KEY', 3, ctx())).rejects.toThrow('ACME_KEY is empty');
  });

  it('refuses a name that looks like a key value, never saying it, and writes nothing', async () => {
    const name = 'ghp_acmeacmeacmeacmeacme0001';
    const said = "that looks like a key's value, not its name: give the name only, and paste the value when asked";
    const set = await setKey(name, 'x', ctx()).catch((e) => e);
    expect(set.message).toBe(said);
    expect(set.message).not.toContain(name);
    const removed = await removeKey(name, ctx()).catch((e) => e);
    expect(removed.message).toBe(said);
    expect(removed.message).not.toContain(name);
    expect(fs.existsSync(at('.env.local'))).toBe(false);
    expect(fs.existsSync(at('.env.foreman'))).toBe(false);
  });

  it('takes a normal name', () => {
    expect(() => checkName('ACME_KEY')).not.toThrow();
  });

  it('says when the name is not in the file', async () => {
    expect(await removeKey('RESEND_API_KEY', ctx())).toEqual({ file: '.env.foreman', removed: false });
    expect(fs.existsSync(at('.env.foreman'))).toBe(false);
  });

  it('refuses a name set in the environment', async () => {
    const env = { RESEND_API_KEY: 're_env' };
    const set = await setKey('RESEND_API_KEY', 're_acme', ctx({ env })).catch((e) => e);
    expect(set.code).toBe('environment');
    expect(set.message).toBe('RESEND_API_KEY is set outside Foreman, in the environment, so Foreman cannot change it');
    const removed = await removeKey('RESEND_API_KEY', ctx({ env })).catch((e) => e);
    expect(removed.code).toBe('environment');
    expect(keyState(['RESEND_API_KEY'], ctx({ env }))[0]).toMatchObject({ name: 'RESEND_API_KEY', set: true, source: 'environment' });
    expect(fs.existsSync(at('.env.foreman'))).toBe(false);
  });

  it('loses no write when many run at once', async () => {
    const names = Array.from({ length: 20 }, (_, i) => `ACME_K${i}`);
    await Promise.all(names.map((name, i) => setKey(name, `acme-value-${i}`, ctx())));
    const back = parseEnv(read('.env.local'));
    for (const [i, name] of names.entries()) expect(back[name]).toBe(`acme-value-${i}`);
  });

  it('waits for a live lock, then gives up', async () => {
    const lockFile = path.join(tmp, 'locks', 'keys.json');
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid, by: 'keys', at: new Date().toISOString() }));
    await expect(setKey('RESEND_API_KEY', 're_acme', ctx({ lockFile, lockWaitMs: 100 }))).rejects.toThrow('another Foreman command is changing the keys; try again');
    expect(fs.existsSync(at('.env.foreman'))).toBe(false);
    expect(fs.existsSync(lockFile)).toBe(true);
  });

  it('breaks a stale lock and writes', async () => {
    const lockFile = path.join(tmp, 'locks', 'keys.json');
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 2147483646, by: 'keys', at: new Date().toISOString() }));
    await setKey('RESEND_API_KEY', 're_acme', ctx({ lockFile }));
    expect(parseEnv(read('.env.foreman'))).toEqual({ RESEND_API_KEY: 're_acme' });
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('takes its lock in the state folder by default and lets it go', async () => {
    await setKey('RESEND_API_KEY', 're_acme', ctx());
    expect(fs.existsSync(path.join(root, '.foreman', 'locks', 'keys.json'))).toBe(false);
  });
});

describe('a symlinked key file', () => {
  beforeEach(ignoreAll);

  const LINK_REFUSAL = '.env.foreman links to a file git could commit, so nothing was written';
  const git = (cwd, ...args) => expect(sh('git', args, { cwd }).status).toBe(0);
  const commit = (cwd) => git(cwd, '-c', 'user.name=acme', '-c', 'user.email=acme@example.com', 'commit', '-q', '-m', 'acme');
  // Another repo at tmp/<name> holding `files`, with `committed` added and committed.
  const otherRepo = (name, files, committed = []) => {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir);
    git(dir, 'init', '-q');
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text);
    if (committed.length) {
      git(dir, 'add', '-f', '--', ...committed);
      commit(dir);
    }
    return dir;
  };
  const isLink = () => fs.lstatSync(at('.env.foreman')).isSymbolicLink();
  const refused = async (target) => {
    const before = fs.readFileSync(target);
    const err = await setKey('RESEND_API_KEY', 're_acme', ctx()).catch((e) => e);
    expect(err.code).toBe('link-not-ignored');
    expect(err.message).toBe(LINK_REFUSAL);
    expect(fs.readFileSync(target)).toEqual(before);
    expect(isLink()).toBe(true);
  };

  it('refuses a link to a file another repo tracks', async () => {
    const other = otherRepo('other', { 'tracked.env': 'ACME_URL=u\n' }, ['tracked.env']);
    fs.symlinkSync(path.join(other, 'tracked.env'), at('.env.foreman'));
    await refused(path.join(other, 'tracked.env'));
  });

  it('refuses a link to a tracked file even when a .gitignore pattern matches it', async () => {
    const other = otherRepo('other', { 'tracked.env': 'ACME_URL=u\n', '.gitignore': '*.env\n' }, ['tracked.env', '.gitignore']);
    fs.symlinkSync(path.join(other, 'tracked.env'), at('.env.foreman'));
    await refused(path.join(other, 'tracked.env'));
  });

  it('refuses a link to a file in its own repo that git does not ignore', async () => {
    fs.mkdirSync(at('real'));
    fs.writeFileSync(at('real/keys.env'), 'ACME_URL=u\n');
    fs.symlinkSync(at('real/keys.env'), at('.env.foreman'));
    await refused(at('real/keys.env'));
  });

  it('writes through a link to a file another repo ignores, and keeps the link', async () => {
    const main = otherRepo('main', { '.env.foreman': 'ACME_URL=u\n', '.gitignore': '.env.foreman\n' });
    fs.symlinkSync(path.join(main, '.env.foreman'), at('.env.foreman'));
    await setKey('RESEND_API_KEY', 're_acme', ctx());
    expect(parseEnv(fs.readFileSync(path.join(main, '.env.foreman'), 'utf8'))).toEqual({ ACME_URL: 'u', RESEND_API_KEY: 're_acme' });
    expect(isLink()).toBe(true);
  });

  it('writes through a link to a file outside any repo', async () => {
    const shared = path.join(tmp, 'shared.env');
    fs.writeFileSync(shared, '');
    fs.symlinkSync(shared, at('.env.foreman'));
    await setKey('RESEND_API_KEY', 're_acme', ctx());
    expect(parseEnv(fs.readFileSync(shared, 'utf8'))).toEqual({ RESEND_API_KEY: 're_acme' });
    expect(isLink()).toBe(true);
  });
});

describe('when git does not ignore the file', () => {
  it('refuses, writes nothing, and offers to add it to .gitignore', async () => {
    const err = await setKey('RESEND_API_KEY', 're_acme', ctx()).catch((e) => e);
    expect(err.code).toBe('not-ignored');
    expect(err.message).toBe('git does not ignore .env.foreman, so nothing was written');
    expect(err.fix).toEqual({ action: 'add-to-gitignore', file: '.env.foreman' });
    expect(fs.existsSync(at('.env.foreman'))).toBe(false);

    expect(ignoreKeyFile('RESEND_API_KEY', ctx())).toBe('added');
    expect(read('.gitignore')).toBe('.env.foreman\n');
    expect(ignoreKeyFile('RESEND_API_KEY', ctx())).toBe('ignored');
    await setKey('RESEND_API_KEY', 're_acme', ctx());
    expect(parseEnv(read('.env.foreman'))).toEqual({ RESEND_API_KEY: 're_acme' });
  });

  it('refuses a file git tracks, and writes nothing', async () => {
    ignoreAll();
    fs.writeFileSync(at('.env.foreman'), '# mine\n');
    expect(sh('git', ['add', '-f', '.env.foreman'], { cwd: root }).status).toBe(0);
    const err = await setKey('RESEND_API_KEY', 're_acme_tracked', ctx()).catch((e) => e);
    expect(err.code).toBe('tracked');
    expect(err.message).toBe('.env.foreman is tracked by git, so nothing was written; remove it from the index first (git rm --cached .env.foreman)');
    expect(err.message).not.toContain('re_acme_tracked');
    expect(read('.env.foreman')).toBe('# mine\n');
  });

  it('throws when the line does not make git ignore it', () => {
    const neverIgnored = (cmd, args, opts) => (args[0] === 'check-ignore' ? { status: 1, stdout: '', stderr: '' } : sh(cmd, args, opts));
    expect(() => ignoreKeyFile('RESEND_API_KEY', ctx({ sh: neverIgnored }))).toThrow('could not make git ignore .env.foreman');
  });
});

describe('fileFor', () => {
  it("puts Foreman's keys in .env.foreman and the project's in the env file", () => {
    expect(fileFor('RESEND_API_KEY', config)).toBe('.env.foreman');
    expect(fileFor('ACME_DB_URL', config)).toBe('.env.local');
  });

  it('honours the configured files', () => {
    const own = { ...config, envFile: '.env.acme', foremanEnvFile: 'secrets/.env.own' };
    expect(fileFor('RESEND_API_KEY', own)).toBe('secrets/.env.own');
    expect(fileFor('ACME_DB_URL', own)).toBe('.env.acme');
  });
});

describe('mask and keyState', () => {
  it('shows the last 4 only for a value of 24 or more characters', () => {
    expect(mask('a'.repeat(20) + 'a1B2')).toBe('•••• a1B2');
    expect(mask('a'.repeat(23))).toBe('set');
  });

  it('says where each key is set, and never its value', () => {
    ignoreAll();
    const sentinel = 'ACMESENTINELVALUE0123456789xyz';
    fs.writeFileSync(at('.env.foreman'), `RESEND_API_KEY=${sentinel}\nRESEND_FROM_EMAIL=acme@example.com\n`);
    const state = keyState(['RESEND_API_KEY', 'RESEND_FROM_EMAIL', 'GEARSET_API_TOKEN'], ctx());
    expect(state).toEqual([
      { name: 'RESEND_API_KEY', set: true, masked: '•••• 9xyz', source: 'file' },
      { name: 'RESEND_FROM_EMAIL', set: true, masked: 'set', source: 'file' },
      { name: 'GEARSET_API_TOKEN', set: false, masked: null, source: null },
    ]);
    expect(JSON.stringify(state)).not.toContain(sentinel.slice(0, 20));
  });

  it('reads the value for the key tests: the environment first, then the file', () => {
    fs.writeFileSync(at('.env.foreman'), 'RESEND_API_KEY=re_file\n');
    expect(secretValue('RESEND_API_KEY', ctx())).toBe('re_file');
    expect(secretValue('RESEND_API_KEY', ctx({ env: { RESEND_API_KEY: 're_env' } }))).toBe('re_env');
    expect(secretValue('GEARSET_API_TOKEN', ctx())).toBeNull();
  });
});

describe('writeKeys', () => {
  it('creates no file when there is nothing to write', () => {
    expect(writeKeys(at('.env.local'), {})).toEqual({ written: [], removed: [], refused: [] });
    expect(fs.existsSync(at('.env.local'))).toBe(false);
  });

  it('writes through a symlinked env file and keeps the link', () => {
    const real = path.join(tmp, 'shared.env');
    fs.writeFileSync(real, 'ACME_URL=u\n');
    fs.symlinkSync(real, at('.env.local'));
    expect(writeKeys(at('.env.local'), { ACME_KEY: 'k' }, { remove: ['ACME_URL'] })).toEqual({ written: ['ACME_KEY'], removed: ['ACME_URL'], refused: [] });
    expect(fs.lstatSync(at('.env.local')).isSymbolicLink()).toBe(true);
    expect(parseEnv(fs.readFileSync(real, 'utf8'))).toEqual({ ACME_KEY: 'k' });
  });

  it('refuses a value no quoting keeps intact and writes the rest', () => {
    expect(writeKeys(at('.env.local'), { ACME_A: 'a', ACME_B: 'x \' " ` y' })).toEqual({ written: ['ACME_A'], removed: [], refused: ['ACME_B'] });
    expect(parseEnv(read('.env.local'))).toEqual({ ACME_A: 'a' });
  });

  it('leaves an empty file when the last line is removed', () => {
    fs.writeFileSync(at('.env.local'), 'ACME_A=a\n');
    writeKeys(at('.env.local'), {}, { remove: ['ACME_A'] });
    expect(read('.env.local')).toBe('');
  });
});
