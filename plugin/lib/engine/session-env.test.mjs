import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSessionEnv, sessionEnvPath } from './session-env.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foreman-session-env-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sessionEnv = () => ({ PATH: '/bin', ACME_SESSION_VAR: 'yes', FOREMAN_RUN: '1', FOREMAN_SLOT: 'w2', FOREMAN_STORY: 'ACME-7', FOREMAN_STATE_DIR: dir });
const put = (text, slot = 'w2') => {
  mkdirSync(join(dir, 'session-config'), { recursive: true });
  writeFileSync(sessionEnvPath(dir, slot), text);
};

describe('sessionEnvPath', () => {
  it('sits next to the slot settings and MCP files', () => {
    expect(sessionEnvPath('/repo/.foreman', 'w2')).toBe('/repo/.foreman/session-config/w2-env.json');
  });
});

describe('readSessionEnv', () => {
  it('returns the file as a copy when it belongs to this session', () => {
    const env = sessionEnv();
    put(JSON.stringify(env));
    const got = readSessionEnv({ ...env, ACME_SHELL_ONLY: '1' });
    expect(got).toEqual({ env, why: null });
    expect(got.env).not.toBe(env);
    expect(got.env.ACME_SHELL_ONLY).toBeUndefined();
  });

  it('is silent outside a session', () => {
    const env = sessionEnv();
    put(JSON.stringify(env));
    expect(readSessionEnv({ ...env, FOREMAN_RUN: undefined })).toEqual({ env: null, why: null });
    expect(readSessionEnv({})).toEqual({ env: null, why: null });
    expect(readSessionEnv({ ...env, FOREMAN_RUN: '0' })).toEqual({ env: null, why: null });
  });

  it('gives a reason and no env when the file is missing', () => {
    const got = readSessionEnv(sessionEnv());
    expect(got.env).toBeNull();
    expect(got.why).toContain(`cannot read ${sessionEnvPath(dir, 'w2')}`);
  });

  it('gives a reason for text that is not JSON', () => {
    put('{not json');
    const got = readSessionEnv(sessionEnv());
    expect(got.env).toBeNull();
    expect(got.why).toContain('cannot read');
  });

  it.each([
    ['a non-string value', { ...sessionEnv(), N: 3 }],
    ['an array', ['a']],
    ['a string', 'text'],
    ['null', null],
  ])('says it is not an environment for %s', (_, value) => {
    put(JSON.stringify(value));
    expect(readSessionEnv(sessionEnv())).toEqual({ env: null, why: 'it is not an environment' });
  });

  it.each(['FOREMAN_RUN', 'FOREMAN_SLOT', 'FOREMAN_STATE_DIR', 'FOREMAN_STORY'])('says it belongs to another session when %s differs', (key) => {
    const caller = sessionEnv();
    put(JSON.stringify({ ...caller, [key]: 'other' }));
    const got = readSessionEnv(caller);
    expect(got.env).toBeNull();
    expect(got.why).toContain('belongs to another session');
  });

  it('names the story and slot of a file for another session', () => {
    put(JSON.stringify({ ...sessionEnv(), FOREMAN_STORY: 'ACME-9' }));
    expect(readSessionEnv(sessionEnv()).why).toContain('for ACME-9 in w2');
  });

  it.each([
    [{ FOREMAN_STATE_DIR: undefined }],
    [{ FOREMAN_SLOT: undefined }],
    [{ FOREMAN_SLOT: '../x' }],
    [{ FOREMAN_SLOT: 'a/b' }],
    [{ FOREMAN_SLOT: '' }],
    [{ FOREMAN_SLOT: 'w'.repeat(42) }],
  ])('names the missing or bad slot or state folder: %j', (change) => {
    expect(readSessionEnv({ ...sessionEnv(), ...change })).toEqual({ env: null, why: 'FOREMAN_SLOT or FOREMAN_STATE_DIR is not set' });
  });

  it('never reads a path outside session-config for a slot like ../x', () => {
    writeFileSync(join(dir, 'x-env.json'), JSON.stringify({ ...sessionEnv(), FOREMAN_SLOT: '../x' }));
    expect(readSessionEnv({ ...sessionEnv(), FOREMAN_SLOT: '../x' }).env).toBeNull();
  });

  it('reads through an injected readFile', () => {
    const seen = [];
    const env = sessionEnv();
    const got = readSessionEnv(env, { readFile: (p) => { seen.push(p); return JSON.stringify(env); } });
    expect(got.why).toBeNull();
    expect(seen).toEqual([sessionEnvPath(dir, 'w2')]);
  });
});
