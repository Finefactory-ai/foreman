import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { keptLines, parseEnvFile, serialize, writeSecretFile } from './env-text.mjs';

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-env-text-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('serialize', () => {
  it('writes values that Node reads back exactly', () => {
    const values = ['plain', 'has space', 'a#b', "it's", 'say "hi"', 'multi\nline', 'back\\slash', 'dollar $HOME', 'both \' and "', ' lead', 'x=y', ''];
    for (const v of values) expect(parseEnv(`${serialize('K', v)}\nNEXT=1\n`)).toEqual({ K: v, NEXT: '1' });
  });

  it('returns null for a value no quoting keeps intact', () => {
    expect(serialize('K', 'all \' " ` three')).toBeNull();
  });
});

describe('keptLines', () => {
  it('drops the named lines and keeps comments and other names', () => {
    const text = '# acme app\nACME_URL=http://localhost\nJIRA_CLIENT_ID=acme-id\nexport JIRA_CLIENT_SECRET="acme-secret"\n';
    expect(keptLines(text, new Set(['JIRA_CLIENT_ID', 'JIRA_CLIENT_SECRET']))).toEqual(['# acme app', 'ACME_URL=http://localhost']);
  });

  it('drops every line of a multi-line quoted value', () => {
    const text = 'ACME_URL=u\nACME_KEY="line one\nline two"\n\nACME_OTHER=1\n';
    expect(keptLines(text, new Set(['ACME_KEY']))).toEqual(['ACME_URL=u', '', 'ACME_OTHER=1']);
  });

  it('drops the trailing blank lines', () => {
    expect(keptLines('A=1\n\n\n', new Set())).toEqual(['A=1']);
  });

  it('keeps a comment directly below a dropped line', () => {
    expect(keptLines('JIRA_CLIENT_ID=a\n# acme db below\nACME_DB=x\n', new Set(['JIRA_CLIENT_ID']))).toEqual(['# acme db below', 'ACME_DB=x']);
  });

  it('drops the whole multi-line value even when a line inside looks like NAME=', () => {
    expect(keptLines('JIRA_CLIENT_SECRET="line1\nACME_LEAK=part2\nline3"\nB=1\n', new Set(['JIRA_CLIENT_SECRET']))).toEqual(['B=1']);
  });

  it("keeps a kept variable's multi-line value whole when a line inside looks like a dropped name", () => {
    expect(keptLines('ACME_X="a\nJIRA_CLIENT_ID=inside\nb"\nJIRA_CLIENT_ID=real\n', new Set(['JIRA_CLIENT_ID']))).toEqual(['ACME_X="a', 'JIRA_CLIENT_ID=inside', 'b"']);
  });

  it('does not end the drop at a blank line inside a backtick value', () => {
    expect(keptLines('A=`x\n\nB=2\n`\nC=3', new Set(['A']))).toEqual(['C=3']);
  });

  it('counts an unclosed quote as one line, as Node reads it', () => {
    expect(keptLines('A="unterminated\nB=2\n', new Set(['A']))).toEqual(['B=2']);
  });
});

describe('parseEnvFile', () => {
  it('reads a file as Node does', () => {
    fs.writeFileSync(path.join(dir, '.env'), 'A=1\n# note\nB="two"\n');
    expect(parseEnvFile(path.join(dir, '.env'))).toEqual({ A: '1', B: 'two' });
  });

  it('is {} for a missing file', () => {
    expect(parseEnvFile(path.join(dir, 'nope'))).toEqual({});
  });

  it('is {} for no file name or a folder', () => {
    expect(parseEnvFile(undefined)).toEqual({});
    expect(parseEnvFile(dir)).toEqual({});
  });
});

describe('writeSecretFile', () => {
  it('writes the text at mode 600 and leaves no tmp file behind', () => {
    const file = path.join(dir, '.env.foreman');
    writeSecretFile(file, 'A=1\n');
    expect(fs.readFileSync(file, 'utf8')).toBe('A=1\n');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(['.env.foreman']);
  });

  it('tightens an existing file to 600', () => {
    const file = path.join(dir, '.env.foreman');
    fs.writeFileSync(file, 'OLD=1\n', { mode: 0o644 });
    writeSecretFile(file, 'NEW=1\n');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, 'utf8')).toBe('NEW=1\n');
  });

  it('keeps another mode when asked', () => {
    const file = path.join(dir, '.env.local');
    writeSecretFile(file, 'A=1\n', 0o644);
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);
  });
});

describe('writeSecretFile, when something fails', () => {
  it('leaves the old file and no tmp file when the rename fails', () => {
    const file = path.join(dir, '.env.foreman');
    fs.writeFileSync(file, 'OLD=1\n', { mode: 0o600 });
    const failing = { ...fs, renameSync: () => { throw new Error('acme disk full'); } };
    expect(() => writeSecretFile(file, 'NEW=1\n', 0o600, failing)).toThrow('acme disk full');
    expect(fs.readFileSync(file, 'utf8')).toBe('OLD=1\n');
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('uses a different tmp name for each write', () => {
    const file = path.join(dir, '.env.foreman');
    const names = [];
    const spy = { ...fs, writeFileSync: (f, ...rest) => { names.push(String(f)); return fs.writeFileSync(f, ...rest); } };
    writeSecretFile(file, 'A=1\n', 0o600, spy);
    writeSecretFile(file, 'A=2\n', 0o600, spy);
    expect(names).toHaveLength(2);
    expect(names[0]).not.toBe(names[1]);
    for (const name of names) expect(path.dirname(name)).toBe(dir);
    expect(fs.readFileSync(file, 'utf8')).toBe('A=2\n');
  });
});
