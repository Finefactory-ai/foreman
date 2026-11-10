import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import {
  FOREMAN_KEYS,
  SESSION_KEYS,
  addIgnoreLine,
  foremanEnvName,
  foremanEnvPath,
  foremanFileKeys,
  foremanKeysIn,
  isForemanKey,
  isIgnored,
  isTracked,
  linkedTargetSafe,
  loadForemanKeys,
  migrateKeys,
  projectEnvName,
  projectEnvPath,
  sessionKeys,
  withSessionKeys,
} from './foreman-keys.mjs';

let root;
const config = { envFile: '.env.local', foremanEnvFile: '.env.foreman' };
const at = (rel) => path.join(root, rel);
const put = (rel, text) => fs.writeFileSync(at(rel), text);
const read = (rel) => fs.readFileSync(at(rel), 'utf8');
const mode = (rel) => fs.statSync(at(rel)).mode & 0o777;

// The real git, for a temp repo, with no global or system config (so no global excludes file).
const gitEnv = () => ({ PATH: process.env.PATH, HOME: path.join(root, '.home'), XDG_CONFIG_HOME: path.join(root, '.home'), GIT_CONFIG_NOSYSTEM: '1' });
const gitSh = (cmd, args = [], opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(), ...opts });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};
// A shell whose `git check-ignore` always exits with `status`.
const fixedSh = (status) => () => ({ status, stdout: '', stderr: '' });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-keys-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const gitRepo = () => {
  expect(gitSh('git', ['init', '-q'], { cwd: root }).status).toBe(0);
};

describe('the registry', () => {
  it("names Foreman's own keys, and the two a session may take", () => {
    expect(FOREMAN_KEYS).toEqual([
      'JIRA_CLIENT_ID', 'JIRA_CLIENT_SECRET', 'RESEND_API_KEY', 'RESEND_FROM_EMAIL', 'FOREMAN_NOTIFY_EMAIL',
      'FACTORY_NOTIFY_EMAIL', 'FOREMAN_DASHBOARD_TOKEN', 'GEARSET_API_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
    ]);
    expect(Object.isFrozen(FOREMAN_KEYS)).toBe(true);
    expect(SESSION_KEYS).toEqual(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);
    expect(isForemanKey('JIRA_CLIENT_SECRET')).toBe(true);
    expect(isForemanKey('ACME_DB_URL')).toBe(false);
  });

  it('finds the two files from the config, with the defaults', () => {
    expect(foremanEnvName({})).toBe('.env.foreman');
    expect(projectEnvName(undefined)).toBe('.env.local');
    expect(foremanEnvPath('/r', {})).toBe(path.join('/r', '.env.foreman'));
    expect(projectEnvPath('/r', {})).toBe(path.join('/r', '.env.local'));
    expect(foremanEnvPath('/r', { foremanEnvFile: 'k/.env.f' })).toBe(path.join('/r', 'k', '.env.f'));
    expect(projectEnvPath('/r', { envFile: '.env' })).toBe(path.join('/r', '.env'));
  });
});

describe('foremanFileKeys', () => {
  it('takes only the registry names from .env.foreman', () => {
    put('.env.foreman', 'JIRA_CLIENT_ID=acme-id\nACME_DB_URL=postgres://acme\nRESEND_API_KEY=re_acme\n');
    expect(foremanFileKeys({ root, config })).toEqual({ JIRA_CLIENT_ID: 'acme-id', RESEND_API_KEY: 're_acme' });
  });

  it('is {} with no file', () => {
    expect(foremanFileKeys({ root, config })).toEqual({});
  });
});

describe('sessionKeys', () => {
  it('returns only the two Claude names, even with other registry names in the file', () => {
    put('.env.foreman', 'ANTHROPIC_API_KEY=sk-acme\nCLAUDE_CODE_OAUTH_TOKEN=tok-acme\nJIRA_CLIENT_SECRET=x\nRESEND_API_KEY=re_acme\n');
    expect(sessionKeys({ root, config })).toEqual({ ANTHROPIC_API_KEY: 'sk-acme', CLAUDE_CODE_OAUTH_TOKEN: 'tok-acme' });
  });

  it('never reads .env.local for them', () => {
    put('.env.local', 'ANTHROPIC_API_KEY=sk-acme\nCLAUDE_CODE_OAUTH_TOKEN=tok-acme\n');
    expect(sessionKeys({ root, config })).toEqual({});
  });

  it('leaves out an empty value', () => {
    put('.env.foreman', 'ANTHROPIC_API_KEY=\nCLAUDE_CODE_OAUTH_TOKEN=tok-acme\n');
    expect(sessionKeys({ root, config })).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'tok-acme' });
  });
});

describe('withSessionKeys', () => {
  it('fills in the Claude names only where env has no value', () => {
    const fileKeys = { ANTHROPIC_API_KEY: 'from-file', CLAUDE_CODE_OAUTH_TOKEN: 'tok-file' };
    expect(withSessionKeys({ PATH: '/bin' }, fileKeys)).toEqual({ PATH: '/bin', ...fileKeys });
    expect(withSessionKeys({ ANTHROPIC_API_KEY: 'from-env' }, fileKeys)).toEqual({ ANTHROPIC_API_KEY: 'from-env', CLAUDE_CODE_OAUTH_TOKEN: 'tok-file' });
    expect(withSessionKeys({ ANTHROPIC_API_KEY: '' }, fileKeys).ANTHROPIC_API_KEY).toBe('from-file');
  });

  it('takes no other name, and never changes env itself', () => {
    const env = { PATH: '/bin' };
    expect(withSessionKeys(env, { RESEND_API_KEY: 're_acme', JIRA_CLIENT_SECRET: 's' })).toEqual({ PATH: '/bin' });
    expect(env).toEqual({ PATH: '/bin' });
  });
});

describe('foremanKeysIn', () => {
  it('lists the registry names in a file, names only', () => {
    put('.env.local', 'ACME_DB_URL=x\nJIRA_CLIENT_SECRET=s\nJIRA_CLIENT_ID=i\n');
    expect(foremanKeysIn(at('.env.local'))).toEqual(['JIRA_CLIENT_ID', 'JIRA_CLIENT_SECRET']);
    expect(foremanKeysIn(at('missing'))).toEqual([]);
  });
});

describe('loadForemanKeys', () => {
  it('sets the missing registry names from .env.foreman and keeps the ones already set', () => {
    put('.env.foreman', 'RESEND_API_KEY=re_file\nJIRA_CLIENT_ID=id_file\nACME_URL=http://acme\n');
    const target = { JIRA_CLIENT_ID: 'id_env' };
    loadForemanKeys({ root, config, target });
    expect(target).toEqual({ JIRA_CLIENT_ID: 'id_env', RESEND_API_KEY: 're_file' });
  });

  it('does nothing with no file', () => {
    const target = {};
    loadForemanKeys({ root, config, target });
    expect(target).toEqual({});
  });

  it('throws when the file is there but cannot be read', () => {
    fs.mkdirSync(at('.env.foreman'));
    expect(() => loadForemanKeys({ root, config, target: {} })).toThrow();
  });

  it('sets only the registry names it is asked for, and returns them', () => {
    put('.env.foreman', 'GEARSET_API_TOKEN=g\nRESEND_API_KEY=r\nACME_X=1\n');
    const target = {};
    expect(loadForemanKeys({ root, config, target, names: ['GEARSET_API_TOKEN', 'ACME_X'] })).toEqual(['GEARSET_API_TOKEN']);
    expect(target).toEqual({ GEARSET_API_TOKEN: 'g' });
    const all = {};
    expect(loadForemanKeys({ root, config, target: all }).sort()).toEqual(['GEARSET_API_TOKEN', 'RESEND_API_KEY']);
    expect(all).toEqual({ GEARSET_API_TOKEN: 'g', RESEND_API_KEY: 'r' });
  });

  it('still throws for a file it cannot read when no names are wanted', () => {
    fs.mkdirSync(at('.env.foreman'));
    expect(() => loadForemanKeys({ root, config, target: {}, names: [] })).toThrow();
  });
});

describe('isIgnored', () => {
  it('asks git in the root', () => {
    gitRepo();
    expect(isIgnored({ root, file: '.env.foreman', sh: gitSh })).toBe('not-ignored');
    put('.gitignore', '.env.foreman\n');
    expect(isIgnored({ root, file: '.env.foreman', sh: gitSh })).toBe('ignored');
  });

  it('is unknown when git answers anything but 0 or 1', () => {
    expect(isIgnored({ root, file: '.env.foreman', sh: fixedSh(128) })).toBe('unknown');
  });
});

// Another repo next to root, holding `files`, with `committed` added and committed.
const otherRepo = (files, committed = []) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-keys-other-'));
  others.push(dir);
  expect(gitSh('git', ['init', '-q'], { cwd: dir }).status).toBe(0);
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text);
  if (committed.length) {
    expect(gitSh('git', ['add', '-f', '--', ...committed], { cwd: dir }).status).toBe(0);
    expect(gitSh('git', ['-c', 'user.name=acme', '-c', 'user.email=acme@example.com', 'commit', '-q', '-m', 'acme'], { cwd: dir }).status).toBe(0);
  }
  return dir;
};
let others = [];
afterEach(() => {
  for (const dir of others) fs.rmSync(dir, { recursive: true, force: true });
  others = [];
});

describe('linkedTargetSafe', () => {
  const safe = () => linkedTargetSafe({ root, file: '.env.foreman', sh: gitSh });
  beforeEach(gitRepo);

  it('is true for a missing file and a dangling link', () => {
    expect(safe()).toBe(true);
    fs.symlinkSync(at('nowhere.env'), at('.env.foreman'));
    expect(safe()).toBe(true);
  });

  it('is true for a plain file', () => {
    put('.env.foreman', 'ACME=1\n');
    expect(safe()).toBe(true);
  });

  it('is true for a link to a file outside any repo', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-keys-outside-'));
    others.push(outside);
    fs.writeFileSync(path.join(outside, 'shared.env'), '');
    fs.symlinkSync(path.join(outside, 'shared.env'), at('.env.foreman'));
    expect(safe()).toBe(true);
  });

  it('is false for a link to a file another repo tracks', () => {
    const other = otherRepo({ 'tracked.env': 'ACME=1\n' }, ['tracked.env']);
    fs.symlinkSync(path.join(other, 'tracked.env'), at('.env.foreman'));
    expect(safe()).toBe(false);
  });

  it('is false for a link to a file git does not ignore, and true once it does', () => {
    const other = otherRepo({ 'keys.env': 'ACME=1\n' });
    fs.symlinkSync(path.join(other, 'keys.env'), at('.env.foreman'));
    expect(safe()).toBe(false);
    fs.writeFileSync(path.join(other, '.gitignore'), 'keys.env\n');
    expect(safe()).toBe(true);
  });
});

describe('isTracked', () => {
  it('asks git whether the file is in the index', () => {
    gitRepo();
    put('.env.foreman', '# mine\n');
    expect(isTracked({ root, file: '.env.foreman', sh: gitSh })).toBe('untracked');
    expect(gitSh('git', ['add', '-f', '.env.foreman'], { cwd: root }).status).toBe(0);
    expect(isTracked({ root, file: '.env.foreman', sh: gitSh })).toBe('tracked');
  });

  it('is unknown when git cannot say', () => {
    expect(isTracked({ root, file: '.env.foreman', sh: fixedSh(128) })).toBe('unknown');
  });
});

describe('addIgnoreLine', () => {
  it('appends the entry once', () => {
    put('.gitignore', 'node_modules');
    addIgnoreLine(root, '.env.foreman');
    addIgnoreLine(root, '.env.foreman');
    expect(read('.gitignore')).toBe('node_modules\n.env.foreman\n');
  });

  it('counts /entry and a trailing slash as the entry', () => {
    for (const line of ['/.env.foreman', '.env.foreman/', '/.env.foreman/']) {
      put('.gitignore', `${line}\n`);
      addIgnoreLine(root, '.env.foreman');
      expect(read('.gitignore')).toBe(`${line}\n`);
    }
  });

  it('creates the file, and writes to another ignore file when asked', () => {
    addIgnoreLine(root, '.env.foreman', fs, path.join('.git', 'info', 'exclude'));
    expect(read(path.join('.git', 'info', 'exclude'))).toBe('.env.foreman\n');
    expect(fs.existsSync(at('.gitignore'))).toBe(false);
  });
});

describe('migrateKeys, in a git repo', () => {
  const LOCAL = '# acme app\nJIRA_CLIENT_ID=acme-id\nJIRA_CLIENT_SECRET=acme-secret\nACME_URL=http://localhost\nRESEND_API_KEY=re_acme\n';
  beforeEach(gitRepo);

  it("moves Foreman's names to .env.foreman at mode 600 and keeps the rest of .env.local and its mode", () => {
    put('.env.local', LOCAL);
    fs.chmodSync(at('.env.local'), 0o644);
    const r = migrateKeys({ root, config, sh: gitSh });
    expect(r).toEqual({ moved: ['JIRA_CLIENT_ID', 'JIRA_CLIENT_SECRET', 'RESEND_API_KEY'], alreadyThere: [], refused: [], ignore: 'added' });
    expect(parseEnv(read('.env.foreman'))).toEqual({ JIRA_CLIENT_ID: 'acme-id', JIRA_CLIENT_SECRET: 'acme-secret', RESEND_API_KEY: 're_acme' });
    expect(mode('.env.foreman')).toBe(0o600);
    expect(read('.env.local')).toBe('# acme app\nACME_URL=http://localhost\n');
    expect(mode('.env.local')).toBe(0o644);
    expect(isIgnored({ root, file: '.env.foreman', sh: gitSh })).toBe('ignored');
  });

  it('carries no value in its result', () => {
    put('.env.local', LOCAL);
    const r = migrateKeys({ root, config, sh: gitSh });
    for (const value of ['acme-id', 'acme-secret', 're_acme']) expect(JSON.stringify(r)).not.toContain(value);
  });

  it('moves a multi-line quoted value intact', () => {
    put('.env.local', 'ACME_URL=u\nJIRA_CLIENT_SECRET="line one\nline two"\n\nACME_OTHER=1\n');
    migrateKeys({ root, config, sh: gitSh });
    expect(parseEnv(read('.env.foreman'))).toEqual({ JIRA_CLIENT_SECRET: 'line one\nline two' });
    expect(parseEnv(read('.env.local'))).toEqual({ ACME_URL: 'u', ACME_OTHER: '1' });
  });

  it('keeps the value already in .env.foreman and removes the name from .env.local', () => {
    put('.env.local', 'JIRA_CLIENT_ID=old-id\nACME_URL=x\n');
    put('.env.foreman', '# mine\nJIRA_CLIENT_ID=kept-id\n');
    const r = migrateKeys({ root, config, sh: gitSh });
    expect(r.alreadyThere).toEqual(['JIRA_CLIENT_ID']);
    expect(r.moved).toEqual([]);
    expect(read('.env.foreman')).toBe('# mine\nJIRA_CLIENT_ID=kept-id\n');
    expect(read('.env.local')).toBe('ACME_URL=x\n');
  });

  it('adds the .gitignore line once, not twice', () => {
    put('.env.local', LOCAL);
    expect(migrateKeys({ root, config, sh: gitSh }).ignore).toBe('added');
    put('.env.local', 'RESEND_FROM_EMAIL=acme@example.com\n');
    expect(migrateKeys({ root, config, sh: gitSh }).ignore).not.toBe('added');
    expect(read('.gitignore').split('\n').filter((l) => l === '.env.foreman')).toHaveLength(1);
  });

  it('keeps a symlinked .env.local a symlink, and edits its target', () => {
    fs.mkdirSync(at('real'));
    put('real/.env.local', 'JIRA_CLIENT_SECRET=s\nACME_URL=x\n');
    fs.symlinkSync(at('real/.env.local'), at('.env.local'));
    migrateKeys({ root, config, sh: gitSh });
    expect(fs.lstatSync(at('.env.local')).isSymbolicLink()).toBe(true);
    expect(read('real/.env.local')).toBe('ACME_URL=x\n');
    expect(parseEnv(read('.env.foreman'))).toEqual({ JIRA_CLIENT_SECRET: 's' });
  });

  it('never moves a name outside the registry', () => {
    put('.env.local', 'ACME_DB_URL=x\nSUPABASE_URL=y\n');
    const r = migrateKeys({ root, config, sh: gitSh });
    expect(r.moved).toEqual([]);
    expect(r.alreadyThere).toEqual([]);
    expect(read('.env.local')).toBe('ACME_DB_URL=x\nSUPABASE_URL=y\n');
    expect(fs.existsSync(at('.env.foreman'))).toBe(false);
    expect(fs.existsSync(at('.gitignore'))).toBe(false);
  });

  it('does nothing when .env.local is missing', () => {
    expect(migrateKeys({ root, config, sh: gitSh })).toMatchObject({ moved: [], alreadyThere: [], refused: [] });
    expect(fs.existsSync(at('.env.foreman'))).toBe(false);
  });

  it('leaves a value it cannot write intact in .env.local, by name', () => {
    put('.env.local', 'GEARSET_API_TOKEN=a \' " ` b\nRESEND_API_KEY=r\n');
    const r = migrateKeys({ root, config, sh: gitSh });
    expect(r.refused).toEqual(['GEARSET_API_TOKEN']);
    expect(r.moved).toEqual(['RESEND_API_KEY']);
    expect(read('.env.local')).toBe('GEARSET_API_TOKEN=a \' " ` b\n');
  });

  it('throws when git cannot say, and changes neither file', () => {
    put('.env.local', LOCAL);
    put('.env.foreman', 'RESEND_FROM_EMAIL=acme@example.com\n');
    expect(() => migrateKeys({ root, config, sh: fixedSh(128) })).toThrow('could not make git ignore .env.foreman; nothing was moved');
    expect(read('.env.local')).toBe(LOCAL);
    expect(read('.env.foreman')).toBe('RESEND_FROM_EMAIL=acme@example.com\n');
    expect(fs.existsSync(at('.gitignore'))).toBe(false);
  });

  it('moves nothing when .env.foreman links to a file another repo tracks', () => {
    put('.env.local', LOCAL);
    const other = otherRepo({ 'tracked.env': 'ACME=1\n' }, ['tracked.env']);
    const target = path.join(other, 'tracked.env');
    fs.symlinkSync(target, at('.env.foreman'));
    expect(() => migrateKeys({ root, config, sh: gitSh })).toThrow('.env.foreman links to a file git could commit; nothing was moved');
    expect(read('.env.local')).toBe(LOCAL);
    expect(fs.readFileSync(target, 'utf8')).toBe('ACME=1\n');
    expect(fs.lstatSync(at('.env.foreman')).isSymbolicLink()).toBe(true);
  });

  it('keeps a comment directly below a moved key', () => {
    put('.env.local', 'JIRA_CLIENT_ID=a\n# acme db below\nACME_DB=x\n');
    migrateKeys({ root, config, sh: gitSh });
    expect(read('.env.local')).toBe('# acme db below\nACME_DB=x\n');
  });

  it('leaves no part of a moved multi-line value behind', () => {
    put('.env.local', 'JIRA_CLIENT_SECRET="line1\nACME_LEAK=part2\nline3"\nACME_URL=u\n');
    const r = migrateKeys({ root, config, sh: gitSh });
    expect(r.moved).toEqual(['JIRA_CLIENT_SECRET']);
    expect(parseEnv(read('.env.foreman'))).toEqual({ JIRA_CLIENT_SECRET: 'line1\nACME_LEAK=part2\nline3' });
    expect(read('.env.local')).toBe('ACME_URL=u\n');
    expect(read('.env.local')).not.toContain('part2');
    expect(read('.env.local')).not.toContain('line3');
  });

  it('refuses, and writes nothing, when the cut would change another variable', () => {
    put('.gitignore', '.env.foreman\n');
    const LEFT = 'ACME.X="a\nJIRA_CLIENT_ID=inside\nb"\nJIRA_CLIENT_ID=real\n';
    put('.env.local', LEFT);
    let err;
    try {
      migrateKeys({ root, config, sh: gitSh });
    } catch (e) {
      err = e;
    }
    expect(err?.message).toMatch(/cleanly; nothing was moved/);
    expect(err.message).not.toContain('inside');
    expect(err.message).not.toContain('real');
    expect(read('.env.local')).toBe(LEFT);
    expect(fs.existsSync(at('.env.foreman'))).toBe(false);
  });

  it('refuses, and writes nothing, when rewriting .env.foreman would change another of its variables', () => {
    put('.gitignore', '.env.foreman\n');
    const OWN = 'ACME.X="a\nJIRA_CLIENT_ID=\nb"\n';
    put('.env.foreman', OWN);
    put('.env.local', 'JIRA_CLIENT_ID=acme-id\n');
    expect(() => migrateKeys({ root, config, sh: gitSh })).toThrow('could not write .env.foreman cleanly; nothing was moved');
    expect(read('.env.foreman')).toBe(OWN);
    expect(read('.env.local')).toBe('JIRA_CLIENT_ID=acme-id\n');
  });

  it('refuses a .env.foreman that git tracks, and changes neither file', () => {
    put('.gitignore', '.env.foreman\n');
    put('.env.foreman', '# mine\n');
    expect(gitSh('git', ['add', '-f', '.env.foreman'], { cwd: root }).status).toBe(0);
    put('.env.local', 'JIRA_CLIENT_ID=acme-id\n');
    expect(() => migrateKeys({ root, config, sh: gitSh })).toThrow(/is tracked by git; remove it from the index first/);
    expect(read('.env.foreman')).toBe('# mine\n');
    expect(read('.env.local')).toBe('JIRA_CLIENT_ID=acme-id\n');
  });

  it('throws when git still does not ignore the file after the line is added', () => {
    put('.env.local', LOCAL);
    expect(() => migrateKeys({ root, config, sh: fixedSh(1) })).toThrow(/nothing was moved/);
    expect(read('.env.local')).toBe(LOCAL);
    expect(fs.existsSync(at('.env.foreman'))).toBe(false);
  });
});
