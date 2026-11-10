import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localFile, readLocal, resetLocal, setLocal } from './local.mjs';

let dir;
beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'foreman-local-')), '.foreman');
});
afterEach(() => rmSync(join(dir, '..'), { recursive: true, force: true }));

describe('the local settings layer', () => {
  it('lives in <stateDir>/settings.json', () => expect(localFile(dir)).toBe(join(dir, 'settings.json')));

  it('reads as empty when there is no file yet', () => {
    expect(readLocal(dir)).toEqual({ values: {}, warnings: [] });
  });

  it('sets values, keeping the others, as 2-space JSON', () => {
    setLocal(dir, 'rounds', 2);
    setLocal(dir, 'features.followUps', false);
    setLocal(dir, 'rounds', 4);
    expect(readLocal(dir)).toEqual({ values: { rounds: 4, 'features.followUps': false }, warnings: [] });
    expect(readFileSync(localFile(dir), 'utf8')).toBe('{\n  "rounds": 4,\n  "features.followUps": false\n}\n');
  });

  it('writes atomically, leaving no temp file behind', () => {
    setLocal(dir, 'rounds', 2);
    expect(readdirSync(dir)).toEqual(['settings.json']);
  });

  it('resets one value and says whether there was one', () => {
    setLocal(dir, 'rounds', 2);
    setLocal(dir, 'slots', 2);
    expect(resetLocal(dir, 'rounds')).toBe(true);
    expect(resetLocal(dir, 'rounds')).toBe(false);
    expect(readLocal(dir).values).toEqual({ slots: 2 });
  });

  it('resetting with no file writes nothing', () => {
    expect(resetLocal(dir, 'rounds')).toBe(false);
    expect(existsSync(localFile(dir))).toBe(false);
  });

  it('reads a broken file as empty, with a warning, and refuses to write over it', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(localFile(dir), '{ nope');
    const { values, warnings } = readLocal(dir);
    expect(values).toEqual({});
    expect(warnings).toEqual([expect.stringContaining('is not valid JSON')]);
    expect(() => setLocal(dir, 'rounds', 2)).toThrow(/not valid JSON/);
    expect(readFileSync(localFile(dir), 'utf8')).toBe('{ nope');
  });

  it('reads a file that is not an object as empty, with a warning', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(localFile(dir), '[1]');
    expect(readLocal(dir)).toEqual({ values: {}, warnings: [expect.stringContaining('expected an object')] });
  });
});
