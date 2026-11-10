import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { parseEnv } from 'node:util';
import { main } from '../main.mjs';
import { makeKeysCommand, readAll, readSecretFromTerminal } from './keys.mjs';

const LOCAL = '# acme app\nJIRA_CLIENT_ID=acme-id\nJIRA_CLIENT_SECRET=acme-secret\nACME_URL=http://localhost\n';
const VALUES = ['acme-id', 'acme-secret'];
const USAGE = 'usage: foreman keys list | set <NAME> | remove <NAME> | test <NAME> | migrate [--project <path>]\n';
const refusal = (sub, anchor) =>
  `foreman keys ${sub} would change ${anchor}, the project this Foreman run builds, so it does not run inside a story session (FOREMAN_RUN=1); run it in a scratch git repo instead.\n`;

let tmp;
let home;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-keys-cli-'));
  home = path.join(tmp, 'home');
  fs.mkdirSync(home);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

// No global or system git config, so no global excludes file decides what is ignored.
const baseEnv = (extra = {}) => ({ PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1', ...extra });

// A scratch git repo holding the Acme config and an .env.local with the Jira keys.
function repo(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  spawnSync('git', ['init', '-q'], { cwd: dir, env: baseEnv() });
  fs.writeFileSync(path.join(dir, 'foreman.config.json'), '{"version":1,"project":{"name":"Acme"}}\n');
  fs.writeFileSync(path.join(dir, '.env.local'), LOCAL);
  return dir;
}

// The bytes of the files migrate could touch; null for a missing one.
const files = (dir) => Object.fromEntries(['.env.local', '.env.foreman', '.gitignore'].map((f) => {
  const file = path.join(dir, f);
  return [f, fs.existsSync(file) ? fs.readFileSync(file).toString('base64') : null];
}));

async function run(argv, { cwd, env }) {
  let out = '';
  let err = '';
  const code = await main(argv, { cwd, env, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } });
  return { code, out, err };
}

const migrated = (dir) => {
  expect(parseEnv(fs.readFileSync(path.join(dir, '.env.foreman'), 'utf8'))).toEqual({ JIRA_CLIENT_ID: 'acme-id', JIRA_CLIENT_SECRET: 'acme-secret' });
  expect(fs.readFileSync(path.join(dir, '.env.local'), 'utf8')).toBe('# acme app\nACME_URL=http://localhost\n');
};

describe('foreman keys migrate', () => {
  it('refuses inside a story session when the project is the one the run builds, before changing any file', async () => {
    const here = repo('here');
    const before = files(here);
    const r = await run(['keys', 'migrate'], { cwd: here, env: baseEnv({ FOREMAN_RUN: '1', FOREMAN_PROJECT_DIR: here }) });
    expect(r.code).toBe(1);
    expect(r.err).toBe(refusal('migrate', here));
    expect(r.out).toBe('');
    expect(files(here)).toEqual(before);
  });

  it('refuses --project naming the run\'s project from another folder', async () => {
    const here = repo('here');
    const scratch = repo('scratch');
    const before = [files(here), files(scratch)];
    const r = await run(['keys', 'migrate', '--project', here], { cwd: scratch, env: baseEnv({ FOREMAN_RUN: '1', FOREMAN_PROJECT_DIR: here }) });
    expect(r.code).toBe(1);
    expect(r.err).toBe(refusal('migrate', here));
    expect([files(here), files(scratch)]).toEqual(before);
  });

  it('works on a scratch repo inside a story session, and leaves the run\'s project alone', async () => {
    const here = repo('here');
    const other = repo('other');
    const before = files(other);
    const r = await run(['keys', 'migrate'], { cwd: here, env: baseEnv({ FOREMAN_RUN: '1', FOREMAN_PROJECT_DIR: other }) });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    migrated(here);
    expect(files(other)).toEqual(before);
  });

  it('acts on the project in the current folder, never on FOREMAN_PROJECT_DIR', async () => {
    const here = repo('here');
    const other = repo('other');
    const before = files(other);
    const r = await run(['keys', 'migrate'], { cwd: here, env: baseEnv({ FOREMAN_PROJECT_DIR: other }) });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    migrated(here);
    expect(files(other)).toEqual(before);
  });

  it('resolves a relative --project against the current folder', async () => {
    const acme = repo('acme');
    const r = await run(['keys', 'migrate', '--project', 'acme'], { cwd: tmp, env: baseEnv() });
    expect(r.code).toBe(0);
    migrated(acme);
  });

  it('acts on the repo root when run from a subfolder', async () => {
    const acme = repo('acme');
    const sub = path.join(acme, 'src', 'app');
    fs.mkdirSync(sub, { recursive: true });
    const r = await run(['keys', 'migrate'], { cwd: sub, env: baseEnv() });
    expect(r.code).toBe(0);
    migrated(acme);
    expect(fs.existsSync(path.join(sub, '.env.foreman'))).toBe(false);
  });

  it('prints names only, one line each, and never a value', async () => {
    const acme = repo('acme');
    fs.writeFileSync(path.join(acme, '.env.local'), `${LOCAL}RESEND_API_KEY=re_acme_secret\nGEARSET_API_TOKEN=a ' " \` b\n`);
    fs.writeFileSync(path.join(acme, '.env.foreman'), 'RESEND_API_KEY=re_kept\n');
    const r = await run(['keys', 'migrate'], { cwd: acme, env: baseEnv() });
    expect(r.code).toBe(0);
    expect(r.out).toBe([
      'moved JIRA_CLIENT_ID, JIRA_CLIENT_SECRET to .env.foreman',
      'removed RESEND_API_KEY from .env.local: .env.foreman already has it',
      'left GEARSET_API_TOKEN in .env.local: its value cannot be written safely',
      'added .env.foreman to .gitignore',
      '',
    ].join('\n'));
    for (const value of [...VALUES, 're_acme_secret', 're_kept', 'a \' "']) expect(r.out + r.err).not.toContain(value);
  });

  it('says so when there is nothing to move', async () => {
    const acme = repo('acme');
    fs.writeFileSync(path.join(acme, '.env.local'), 'ACME_URL=http://localhost\n');
    const r = await run(['keys', 'migrate'], { cwd: acme, env: baseEnv() });
    expect(r.code).toBe(0);
    expect(r.out).toBe("nothing to move: .env.local has none of Foreman's keys\n");
    expect(fs.existsSync(path.join(acme, '.env.foreman'))).toBe(false);
  });

  it.each([[['keys']], [['keys', 'foo']], [['keys', 'migrate', 'extra']], [['keys', 'migrate', '--force']], [['keys', 'set']], [['keys', 'set', 'RESEND_API_KEY', 're_x', 'extra']], [['keys', 'list', 'extra']], [['keys', 'remove']], [['keys', 'test']]])('shows the usage for %j', async (argv) => {
    const acme = repo('acme');
    const before = files(acme);
    const r = await run(argv, { cwd: acme, env: baseEnv() });
    expect(r.code).toBe(64);
    expect(r.err).toBe(USAGE);
    expect(files(acme)).toEqual(before);
  });

  it('stops with one line at a config error', async () => {
    const acme = repo('acme');
    fs.writeFileSync(path.join(acme, 'foreman.config.json'), '{"version":1}\n');
    const before = files(acme);
    const r = await run(['keys', 'migrate'], { cwd: acme, env: baseEnv() });
    expect(r.code).toBe(1);
    expect(r.err.trim().split('\n')).toHaveLength(1);
    expect(files(acme)).toEqual(before);
  });
});

// The command with a fake paste, run as main runs it.
async function runWith(deps, argv, { cwd, env }) {
  let out = '';
  let err = '';
  const command = makeKeysCommand(deps);
  const code = await command.run(argv, { cwd, env, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } });
  return { code, out, err };
}

const VALUE = 're_acme_value_123';
const pasting = (value = VALUE) => {
  const calls = [];
  return { calls, readSecret: async (prompt) => { calls.push(prompt); return value; } };
};

describe('foreman keys, in a story session', () => {
  it.each([['list'], ['set', 'RESEND_API_KEY'], ['remove', 'RESEND_API_KEY'], ['test', 'RESEND_API_KEY']])('refuses %s against the run\'s project before reading any file', async (...sub) => {
    const anchor = repo('anchor');
    fs.writeFileSync(path.join(anchor, '.env.foreman'), `RESEND_API_KEY=${VALUE}\n`);
    const before = files(anchor);
    const paste = pasting();
    const r = await runWith({ readSecret: paste.readSecret }, sub, { cwd: anchor, env: baseEnv({ FOREMAN_RUN: '1', FOREMAN_PROJECT_DIR: anchor }) });
    expect(r.code).toBe(1);
    expect(r.err).toBe(refusal(sub[0], anchor));
    expect(r.out).toBe('');
    expect(paste.calls).toEqual([]);
    expect(files(anchor)).toEqual(before);
  });

  it('sets a pasted key and removes it on a scratch repo, and leaves the run\'s project alone', async () => {
    const other = repo('other');
    const scratch = repo('scratch');
    fs.writeFileSync(path.join(scratch, '.gitignore'), '.env.foreman\n');
    const before = files(other);
    const env = baseEnv({ FOREMAN_RUN: '1', FOREMAN_PROJECT_DIR: other });
    const set = await runWith(pasting(), ['set', 'RESEND_API_KEY'], { cwd: scratch, env });
    expect(set.err).toBe('');
    expect(set.code).toBe(0);
    expect(parseEnv(fs.readFileSync(path.join(scratch, '.env.foreman'), 'utf8'))).toEqual({ RESEND_API_KEY: VALUE });
    const removed = await runWith({}, ['remove', 'RESEND_API_KEY'], { cwd: scratch, env });
    expect(removed).toEqual({ code: 0, out: 'removed RESEND_API_KEY from .env.foreman\n', err: '' });
    expect(files(other)).toEqual(before);
  });
});

describe('foreman keys set', () => {
  it('refuses a value on the command line without repeating it', async () => {
    const acme = repo('acme');
    const before = files(acme);
    const r = await run(['keys', 'set', 'RESEND_API_KEY', VALUE], { cwd: acme, env: baseEnv() });
    expect(r.code).toBe(64);
    expect(r.err).toBe('foreman keys set takes no value on the command line, where it would stay in your shell history; run `foreman keys set NAME` and paste the value\n');
    expect(r.out + r.err).not.toContain(VALUE);
    expect(files(acme)).toEqual(before);
  });

  it('writes the pasted value to .env.foreman, mode 600, and never prints it', async () => {
    const acme = repo('acme');
    const local = fs.readFileSync(path.join(acme, '.env.local'), 'utf8');
    const paste = pasting();
    const r = await runWith({ readSecret: paste.readSecret }, ['set', 'RESEND_API_KEY'], { cwd: acme, env: baseEnv() });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toBe('added .env.foreman to .gitignore\nset RESEND_API_KEY in .env.foreman\n');
    expect(paste.calls).toEqual(['Paste Resend API key (it will not show), then press Enter: ']);
    const file = path.join(acme, '.env.foreman');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(parseEnv(fs.readFileSync(file, 'utf8'))).toEqual({ RESEND_API_KEY: VALUE });
    expect(r.out + r.err).not.toContain(VALUE);
    expect(fs.readFileSync(path.join(acme, '.env.local'), 'utf8')).toBe(local);
  });

  it('refuses a value of the wrong shape and writes nothing', async () => {
    const acme = repo('acme');
    const before = files(acme);
    const r = await runWith(pasting('acme_not_resend'), ['set', 'RESEND_API_KEY'], { cwd: acme, env: baseEnv() });
    expect(r.code).toBe(1);
    expect(r.err).toBe('This does not look like a Resend API key: it starts with re_.\n');
    expect(files(acme)).toEqual(before);
  });

  it('refuses a name set in the environment without asking for it', async () => {
    const acme = repo('acme');
    const before = files(acme);
    const paste = pasting();
    const r = await runWith({ readSecret: paste.readSecret }, ['set', 'RESEND_API_KEY'], { cwd: acme, env: baseEnv({ RESEND_API_KEY: 're_env_value' }) });
    expect(r.code).toBe(1);
    expect(r.err).toContain('set outside Foreman');
    expect(r.out + r.err).not.toContain('re_env_value');
    expect(paste.calls).toEqual([]);
    expect(files(acme)).toEqual(before);
  });
});

describe('foreman keys list and remove', () => {
  it('shows each key masked, where it is set, and never a value', async () => {
    const acme = repo('acme');
    fs.writeFileSync(path.join(acme, '.gitignore'), '.env.foreman\n');
    const long = 'acme_gearset_token_0123456789_abcd';
    fs.writeFileSync(path.join(acme, '.env.foreman'), `GEARSET_API_TOKEN=${long}\nRESEND_API_KEY=${VALUE}\n`);
    const r = await run(['keys', 'list'], { cwd: acme, env: baseEnv({ GH_TOKEN: 'ghp_acme_env_value' }) });
    expect(r.code).toBe(0);
    const lines = r.out.trimEnd().split('\n');
    const line = (name) => lines.find((l) => l.startsWith(`${name} `)).replace(/\s+/, ' ');
    expect(line('GEARSET_API_TOKEN')).toBe('GEARSET_API_TOKEN •••• abcd (.env.foreman)');
    expect(line('RESEND_API_KEY')).toBe('RESEND_API_KEY set (.env.foreman)');
    expect(line('GH_TOKEN')).toBe('GH_TOKEN set outside Foreman');
    expect(line('JIRA_CLIENT_ID')).toBe('JIRA_CLIENT_ID not set');
    for (const value of [long.slice(0, 20), VALUE, 'ghp_acme_env_value', ...VALUES]) expect(r.out + r.err).not.toContain(value);
  });

  it('removes a key, then says it is not there', async () => {
    const acme = repo('acme');
    fs.writeFileSync(path.join(acme, '.gitignore'), '.env.foreman\n');
    fs.writeFileSync(path.join(acme, '.env.foreman'), `RESEND_API_KEY=${VALUE}\n`);
    const first = await run(['keys', 'remove', 'RESEND_API_KEY'], { cwd: acme, env: baseEnv() });
    expect(first).toEqual({ code: 0, out: 'removed RESEND_API_KEY from .env.foreman\n', err: '' });
    const again = await run(['keys', 'remove', 'RESEND_API_KEY'], { cwd: acme, env: baseEnv() });
    expect(again).toEqual({ code: 0, out: 'RESEND_API_KEY is not in .env.foreman\n', err: '' });
  });

  it('will not remove a name set in the environment', async () => {
    const acme = repo('acme');
    const r = await run(['keys', 'remove', 'RESEND_API_KEY'], { cwd: acme, env: baseEnv({ RESEND_API_KEY: 're_env_value' }) });
    expect(r.code).toBe(1);
    expect(r.err).toContain('set outside Foreman');
  });
});

describe('foreman keys test', () => {
  const answering = (status, body = {}) => {
    const seen = [];
    const fetch = async (url, init) => {
      seen.push({ url: String(url), init });
      return new Response(JSON.stringify({ ...body, echo: init.headers.Authorization }), { status, headers: { 'content-type': 'application/json' } });
    };
    return { fetch, seen };
  };

  it('says ok when the service takes the key, and FAIL when it does not', async () => {
    const acme = repo('acme');
    fs.writeFileSync(path.join(acme, '.env.foreman'), `RESEND_API_KEY=${VALUE}\n`);
    const good = answering(200);
    const ok = await runWith({ fetch: good.fetch, base: { resend: 'http://resend.acme.test' } }, ['test', 'RESEND_API_KEY'], { cwd: acme, env: baseEnv() });
    expect(ok).toEqual({ code: 0, out: 'ok    RESEND_API_KEY — Resend accepted the key\n', err: '' });
    expect(good.seen[0].url).toBe('http://resend.acme.test/domains');

    const bad = answering(401);
    const no = await runWith({ fetch: bad.fetch, base: { resend: 'http://resend.acme.test' } }, ['test', 'RESEND_API_KEY'], { cwd: acme, env: baseEnv() });
    expect(no).toEqual({ code: 1, out: 'FAIL  RESEND_API_KEY — Resend did not accept the key\n', err: '' });
    expect(ok.out + no.out).not.toContain(VALUE);
  });

  it('says when the key is not set', async () => {
    const acme = repo('acme');
    const r = await runWith({ fetch: answering(200).fetch }, ['test', 'GEARSET_API_TOKEN'], { cwd: acme, env: baseEnv() });
    expect(r.code).toBe(1);
    expect(r.err).toBe('GEARSET_API_TOKEN is not set\n');
  });
});

describe('a value given as the name', () => {
  const BAD_NAME = 'that is not a key name: use letters, digits and _, not starting with a digit\n';
  const VALUE_NAME = "that looks like a key's value, not its name: give the name only, and paste the value when asked\n";
  const GH = 'ghp_acmeacmeacmeacmeacme0001';

  it('set refuses a name that is not a key name without printing it or asking for a value', async () => {
    const acme = repo('acme');
    const before = files(acme);
    const paste = pasting();
    const r = await runWith({ readSecret: paste.readSecret }, ['set', 'sk-ant-api03-acmeacmeacme'], { cwd: acme, env: baseEnv() });
    expect(r.code).toBe(1);
    expect(r.err).toBe(BAD_NAME);
    expect(r.out + r.err).not.toContain('sk-ant-api03-acmeacmeacme');
    expect(paste.calls).toEqual([]);
    expect(files(acme)).toEqual(before);
  });

  it('set refuses a token-shaped name without printing it or asking for a value', async () => {
    const acme = repo('acme');
    const before = files(acme);
    const paste = pasting();
    const r = await runWith({ readSecret: paste.readSecret }, ['set', GH], { cwd: acme, env: baseEnv() });
    expect(r.code).toBe(1);
    expect(r.err).toBe(VALUE_NAME);
    expect(r.out).toBe('');
    expect(r.out + r.err).not.toContain(GH);
    expect(paste.calls).toEqual([]);
    expect(files(acme)).toEqual(before);
  });

  it('remove refuses a token-shaped name without printing it', async () => {
    const acme = repo('acme');
    const before = files(acme);
    const r = await runWith({}, ['remove', GH], { cwd: acme, env: baseEnv() });
    expect(r.code).toBe(1);
    expect(r.err).toBe(VALUE_NAME);
    expect(r.out + r.err).not.toContain(GH);
    expect(files(acme)).toEqual(before);
  });

  it('test refuses a token-shaped name without printing it or asking any service', async () => {
    const acme = repo('acme');
    const seen = [];
    const fetch = async (url) => {
      seen.push(String(url));
      return new Response('{}', { status: 200 });
    };
    const r = await runWith({ fetch }, ['test', GH], { cwd: acme, env: baseEnv() });
    expect(r.code).toBe(1);
    expect(r.err).toBe(VALUE_NAME);
    expect(r.out + r.err).not.toContain(GH);
    expect(seen).toEqual([]);
  });

  it('still takes a normal name', async () => {
    const acme = repo('acme');
    fs.writeFileSync(path.join(acme, '.gitignore'), '.env.foreman\n');
    const r = await runWith(pasting(), ['set', 'RESEND_API_KEY'], { cwd: acme, env: baseEnv() });
    expect(r).toEqual({ code: 0, out: 'set RESEND_API_KEY in .env.foreman\n', err: '' });
  });
});

describe('the default paste reader', () => {
  const ended = (text) => {
    const pt = new PassThrough();
    pt.end(text);
    return pt;
  };
  const recorder = () => {
    const rec = { text: '', write: (s) => { rec.text += s; } };
    return rec;
  };
  // A PassThrough that says it is a terminal, recording each raw-mode switch.
  const fakeTty = (text) => {
    const pt = new PassThrough();
    const modes = [];
    pt.isTTY = true;
    pt.setRawMode = (on) => {
      modes.push(on);
      return pt;
    };
    if (text) pt.write(text);
    return { pt, modes };
  };

  it('readAll drops one trailing newline, and only one', async () => {
    expect(await readAll(ended('re_acme\n'))).toBe('re_acme');
    expect(await readAll(ended('re_acme\r\n'))).toBe('re_acme');
    expect(await readAll(ended('a\n\n'))).toBe('a\n');
  });

  it('reads stdin to its end, with no prompt, when it is not a terminal', async () => {
    const stderr = recorder();
    expect(await readSecretFromTerminal('Paste: ', { stdin: ended('re_acme\n'), stderr })).toBe('re_acme');
    expect(stderr.text).toBe('');
  });

  it('reads a terminal in raw mode, never echoes, and honours backspace', async () => {
    const { pt, modes } = fakeTty('re_acmX\u007fe\r');
    const stderr = recorder();
    expect(await readSecretFromTerminal('Paste: ', { stdin: pt, stderr })).toBe('re_acme');
    expect(modes).toEqual([true, false]);
    expect(stderr.text).toBe('Paste: \n');
  });

  it('ends the value at Ctrl-D', async () => {
    const { pt, modes } = fakeTty('re_acme\u0004');
    expect(await readSecretFromTerminal('Paste: ', { stdin: pt, stderr: recorder() })).toBe('re_acme');
    expect(modes.at(-1)).toBe(false);
  });

  it('rejects at Ctrl-C and turns raw mode off', async () => {
    const { pt, modes } = fakeTty('\u0003');
    await expect(readSecretFromTerminal('Paste: ', { stdin: pt, stderr: recorder() })).rejects.toMatchObject({ code: 'interrupted' });
    expect(modes.at(-1)).toBe(false);
  });

  it('exits 130 at Ctrl-C from the command and changes no file', async () => {
    const acme = repo('acme');
    const before = files(acme);
    const { pt, modes } = fakeTty('\u0003');
    const r = await runWith({ stdin: pt }, ['set', 'RESEND_API_KEY'], { cwd: acme, env: baseEnv() });
    expect(r.code).toBe(130);
    expect(r.out).toBe('');
    expect(modes.at(-1)).toBe(false);
    expect(files(acme)).toEqual(before);
  });

  it('is what the command uses when no reader is given', async () => {
    const acme = repo('acme');
    const r = await runWith({ stdin: ended(`${VALUE}\n`) }, ['set', 'RESEND_API_KEY'], { cwd: acme, env: baseEnv() });
    expect(r.code).toBe(0);
    expect(parseEnv(fs.readFileSync(path.join(acme, '.env.foreman'), 'utf8'))).toEqual({ RESEND_API_KEY: VALUE });
    expect(r.out + r.err).not.toContain(VALUE);
  });
});
