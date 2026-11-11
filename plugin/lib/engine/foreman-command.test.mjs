import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FIX_HINT, overrideText, readType, selfCheck } from './foreman-command.mjs';

const typed = (stdout, extra = {}) => readType({ status: 0, stdout, stderr: '', ...extra });

describe('readType', () => {
  it('reads an alias in zsh and bash', () => {
    expect(typed('foreman is an alias for node /home/acme/x/bin/foreman\n')).toEqual({ kind: 'alias' });
    expect(typed("foreman is aliased to `node /home/acme/x'\n")).toEqual({ kind: 'alias' });
  });

  it('reads a function in zsh, bash and fish', () => {
    expect(typed('foreman is a shell function from /home/acme/.zshrc\n')).toEqual({ kind: 'function' });
    expect(typed('foreman is a function\nforeman () \n{ \n  node /home/acme/x\n}\n')).toEqual({ kind: 'function' });
  });

  it('reads a file, plain or hashed', () => {
    expect(typed('foreman is /usr/local/bin/foreman\n')).toEqual({ kind: 'file', path: '/usr/local/bin/foreman' });
    expect(typed('foreman is hashed (/usr/local/bin/foreman)\n')).toEqual({ kind: 'file', path: '/usr/local/bin/foreman' });
  });

  it('skips noise lines before the foreman line', () => {
    expect(typed('Welcome back\nnvm loaded\nforeman is /usr/local/bin/foreman\n')).toEqual({ kind: 'file', path: '/usr/local/bin/foreman' });
    expect(typed('hello\nforeman is an alias for node /home/acme/x\n')).toEqual({ kind: 'alias' });
  });

  it('says missing when the shell cannot find it', () => {
    expect(readType({ status: 1, stdout: 'foreman not found\n', stderr: '' })).toEqual({ kind: 'missing' });
    expect(readType({ status: 1, stdout: '', stderr: 'bash: type: foreman: not found\n' })).toEqual({ kind: 'missing' });
  });

  it('says failed when the shell could not be run, with the first stderr line', () => {
    const t = readType({ status: 127, stdout: '', stderr: 'spawn /nope/acme-sh ENOENT\nmore\n' });
    expect(t.kind).toBe('failed');
    expect(t.reason).toContain('spawn /nope/acme-sh ENOENT');
    expect(t.reason).not.toContain('more');
    expect(readType({ status: 2, stdout: '', stderr: '' })).toEqual({ kind: 'failed', reason: 'exit 2' });
  });

  it('blanks secrets in the failed reason', () => {
    const failed = (stderr, env) => readType({ status: 1, stdout: '', stderr }, env ? { env } : undefined);
    const a = failed(`acme-init: token sk-ant-${'a'.repeat(30)}\n`);
    expect(a.kind).toBe('failed');
    expect(a.reason).not.toContain('aaaaaaaaaa');
    expect(a.reason).toContain('•••');
    expect(failed('export ACME_TOKEN=plain-acme-42 printed by init\n').reason).not.toContain('plain-acme-42');
    expect(failed(`acme: ghp_${'b'.repeat(36)}\n`).reason).not.toContain('bbbbbbbbbb');
    const named = failed('loaded acme-value-77\n', { GH_TOKEN: 'acme-value-77' });
    expect(named.kind).toBe('failed');
    expect(named.reason).not.toContain('acme-value-77');
  });

  it('cuts a long failed reason', () => {
    const t = readType({ status: 1, stdout: '', stderr: 'x'.repeat(500) });
    expect(t.kind).toBe('failed');
    expect(t.reason.length).toBeLessThanOrEqual(120);
    expect(t.reason.endsWith('…')).toBe(true);
  });

  it('says unknown when nothing says what it is', () => {
    expect(typed('')).toEqual({ kind: 'unknown' });
    expect(readType({})).toEqual({ kind: 'unknown' });
  });

  it('never carries an alias or function body', () => {
    const alias = typed('foreman is an alias for node /home/acme/x --token sk-secret-1\n');
    expect(JSON.stringify(alias)).not.toContain('sk-secret-1');
    const fn = typed('foreman is a function\nforeman () { TOKEN=sk-secret-2 node x; }\n');
    expect(JSON.stringify(fn)).not.toContain('sk-secret-2');
  });
});

describe('overrideText', () => {
  it('names what runs and what should', () => {
    expect(overrideText({ found: 'a shell alias', expected: '/home/acme/p/bin/foreman' }))
      .toBe("`foreman` in story sessions runs a shell alias, not the plugin's CLI at /home/acme/p/bin/foreman, so the run's steps use other code than its agents");
  });
});

describe('selfCheck', () => {
  let tmp;
  let env;
  let state;
  let other;
  const lines = () => (fs.existsSync(path.join(state, 'events.jsonl'))
    ? fs.readFileSync(path.join(state, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []);

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-selfcheck-'));
    state = path.join(tmp, 'state');
    other = path.join(tmp, 'other');
    fs.mkdirSync(state);
    env = {
      FOREMAN_RUN: '1',
      FOREMAN_PLUGIN_ROOT: path.join(tmp, 'expected'),
      FOREMAN_STATE_DIR: state,
      FOREMAN_SLOT: 'w2',
      FOREMAN_STORY: 'ACME-7',
      FOREMAN_SUPERVISOR_PID: '123',
      FOREMAN_PROJECT_DIR: path.join(tmp, 'project'),
    };
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('writes one warn event on the slot, once per session', () => {
    const text = selfCheck({ env, self: other });
    const events = lines();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'warn', slot: 'w2', text });
    expect(text.startsWith('ACME-7: ')).toBe(true);
    expect(text).toContain(path.join(other, 'bin', 'foreman'));
    expect(text).toContain(path.join(tmp, 'expected', 'bin', 'foreman'));
    expect(text).toContain('if [[ -z "$FOREMAN_RUN" ]]; then … fi');
    expect(text).toContain(FIX_HINT);
    expect(selfCheck({ env, self: other })).toBeNull();
    expect(lines()).toHaveLength(1);
    expect(selfCheck({ env: { ...env, FOREMAN_STORY: 'ACME-8' }, self: other })).not.toBeNull();
    expect(lines()).toHaveLength(2);
  });

  it('writes nothing, anywhere, for a slot that is not a plain name', () => {
    for (const slot of ['../x', '../../x', 'a/b', '/abs', '..', '.', 'w 2']) {
      expect(selfCheck({ env: { ...env, FOREMAN_SLOT: slot }, self: other })).toBeNull();
    }
    expect(lines()).toEqual([]);
    expect(fs.existsSync(path.join(state, 'slots'))).toBe(false);
    expect(fs.readdirSync(state)).toEqual([]);
    expect(fs.readdirSync(tmp)).toEqual(['state']);
  });

  it('warns again for another supervisor or another folder', () => {
    selfCheck({ env, self: other });
    selfCheck({ env: { ...env, FOREMAN_SUPERVISOR_PID: '124' }, self: other });
    selfCheck({ env, self: path.join(tmp, 'third') });
    expect(lines()).toHaveLength(3);
  });

  it('leaves the text without a story prefix when there is no story', () => {
    const { FOREMAN_STORY, ...rest } = env;
    expect(selfCheck({ env: rest, self: other }).startsWith('`foreman`')).toBe(true);
  });

  it('writes nothing when it is the expected plugin, with or without a trailing slash', () => {
    for (const self of [env.FOREMAN_PLUGIN_ROOT, `${env.FOREMAN_PLUGIN_ROOT}/`]) {
      expect(selfCheck({ env, self })).toBeNull();
    }
    expect(lines()).toEqual([]);
    expect(fs.existsSync(path.join(state, 'slots'))).toBe(false);
  });

  it('writes nothing when it is inside the project', () => {
    expect(selfCheck({ env, self: path.join(tmp, 'project', '.foreman', 'worktrees', 'w1', 'plugin') })).toBeNull();
    expect(lines()).toEqual([]);
    expect(fs.existsSync(path.join(state, 'slots'))).toBe(false);
  });

  it('writes nothing outside a story session or without the variables it needs', () => {
    for (const drop of ['FOREMAN_RUN', 'FOREMAN_PLUGIN_ROOT', 'FOREMAN_STATE_DIR', 'FOREMAN_SLOT']) {
      const { [drop]: gone, ...rest } = env;
      expect(selfCheck({ env: rest, self: other }), drop).toBeNull();
    }
    expect(selfCheck({ env: { ...env, FOREMAN_RUN: '0' }, self: other })).toBeNull();
    expect(selfCheck({ env: { ...env, FOREMAN_PLUGIN_ROOT: '' }, self: other })).toBeNull();
    expect(lines()).toEqual([]);
    expect(fs.existsSync(path.join(state, 'slots'))).toBe(false);
  });

  it('never creates a state folder', () => {
    const missing = path.join(tmp, 'nope');
    expect(selfCheck({ env: { ...env, FOREMAN_STATE_DIR: missing }, self: other })).toBeNull();
    expect(fs.existsSync(missing)).toBe(false);
  });

  it('returns null without throwing when the state folder is a file', () => {
    const file = path.join(tmp, 'file');
    fs.writeFileSync(file, 'x');
    expect(selfCheck({ env: { ...env, FOREMAN_STATE_DIR: file }, self: other })).toBeNull();
  });
});
