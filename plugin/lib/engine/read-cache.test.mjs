import fs from 'node:fs';
import { mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_ENTRIES, RACY_MS, cacheSize, forget, listNames, readTailLines, readText, renameWritten } from './read-cache.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'read-cache-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const HOUR = 3600;
const old = (path) => {
  const t = Date.now() / 1000 - HOUR;
  utimesSync(path, t, t);
};
const readsOf = (spy, path) => spy.mock.calls.filter(([p]) => p === path).length;

describe('readText', () => {
  it('reads an old file once however often it is asked for', () => {
    const file = join(dir, 'a.json');
    writeFileSync(file, '{"a":1}');
    old(file);
    const spy = vi.spyOn(fs, 'readFileSync');
    expect([readText(file), readText(file), readText(file)]).toEqual(['{"a":1}', '{"a":1}', '{"a":1}']);
    expect(readsOf(spy, file)).toBe(1);
  });

  it('sees a file replaced by temp file and rename at once', () => {
    const file = join(dir, 'a.json');
    writeFileSync(file, 'one');
    old(file);
    expect(readText(file)).toBe('one');
    writeFileSync(`${file}.tmp`, 'two!');
    old(`${file}.tmp`);
    renameSync(`${file}.tmp`, file);
    expect(readText(file)).toBe('two!');
  });

  it('sees an in-place overwrite of the same size', () => {
    const file = join(dir, 'a.json');
    writeFileSync(file, 'aaaa');
    old(file);
    expect(readText(file)).toBe('aaaa');
    writeFileSync(file, 'bbbb');
    expect(readText(file)).toBe('bbbb');
  });

  it('reads a file younger than RACY_MS on every call', () => {
    const file = join(dir, 'a.json');
    writeFileSync(file, 'new');
    const spy = vi.spyOn(fs, 'readFileSync');
    readText(file);
    readText(file);
    expect(readsOf(spy, file)).toBe(2);
    expect(RACY_MS).toBe(2000);
  });

  it('gives null for a missing file, and the text once it exists', () => {
    const file = join(dir, 'a.json');
    expect(readText(file)).toBeNull();
    writeFileSync(file, 'here');
    expect(readText(file)).toBe('here');
    rmSync(file);
    expect(readText(file)).toBeNull();
  });

  it('throws an error other than a missing file', () => {
    expect(() => readText(dir)).toThrow();
  });

  it('does not read back the process own write after renameWritten', () => {
    const file = join(dir, 'a.json');
    writeFileSync(`${file}.tmp`, 'mine');
    renameWritten(`${file}.tmp`, file, 'mine');
    const spy = vi.spyOn(fs, 'readFileSync');
    expect(readText(file)).toBe('mine');
    expect(readsOf(spy, file)).toBe(0);
  });

  it('reads again after another writer replaces a file that was noted', () => {
    const file = join(dir, 'a.json');
    writeFileSync(`${file}.tmp`, 'mine');
    renameWritten(`${file}.tmp`, file, 'mine');
    writeFileSync(`${file}.o.tmp`, 'theirs!');
    renameSync(`${file}.o.tmp`, file);
    expect(readText(file)).toBe('theirs!');
  });

  it('does not key its own text to another writer file renamed in between', () => {
    const file = join(dir, 'a.json');
    const real = fs.renameSync;
    writeFileSync(`${file}.mine.tmp`, 'mine');
    writeFileSync(`${file}.theirs.tmp`, 'them');
    vi.spyOn(fs, 'renameSync').mockImplementationOnce((a, b) => {
      real(a, b);
      real(`${file}.theirs.tmp`, b);
    });
    renameWritten(`${file}.mine.tmp`, file, 'mine');
    expect(readText(file)).toBe('them');
  });

  it('throws the rename error and keeps no entry', () => {
    const file = join(dir, 'a.json');
    writeFileSync(file, 'old');
    old(file);
    expect(readText(file)).toBe('old');
    expect(() => renameWritten(join(dir, 'no-such.tmp'), file, 'x')).toThrow(expect.objectContaining({ code: 'ENOENT' }));
    const spy = vi.spyOn(fs, 'readFileSync');
    expect(readText(file)).toBe('old');
    expect(readsOf(spy, file)).toBe(1);
  });

  it('drops the entry when the text does not match the size written', () => {
    const file = join(dir, 'a.json');
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, 'abc');
    old(tmp);
    renameWritten(tmp, file, 'abcdef');
    const spy = vi.spyOn(fs, 'readFileSync');
    expect(readText(file)).toBe('abc');
    expect(readsOf(spy, file)).toBe(1);
  });

  it('forget drops the entry', () => {
    const file = join(dir, 'a.json');
    writeFileSync(file, 'x');
    old(file);
    readText(file);
    forget(file);
    const spy = vi.spyOn(fs, 'readFileSync');
    readText(file);
    expect(readsOf(spy, file)).toBe(1);
  });

  it('keeps at most MAX_ENTRIES entries', () => {
    for (let i = 0; i < MAX_ENTRIES + 10; i++) {
      const file = join(dir, `f${i}`);
      writeFileSync(file, String(i));
      readText(file);
    }
    expect(cacheSize()).toBeLessThanOrEqual(MAX_ENTRIES);
  }, 30_000);
});

describe('listNames', () => {
  it('lists an old folder once over three calls, and sees a new file', () => {
    writeFileSync(join(dir, 'a'), '');
    old(dir);
    const spy = vi.spyOn(fs, 'readdirSync');
    listNames(dir);
    listNames(dir);
    expect(listNames(dir)).toEqual(['a']);
    expect(readsOf(spy, dir)).toBe(1);
    writeFileSync(join(dir, 'b'), '');
    old(dir);
    expect(listNames(dir).sort()).toEqual(['a', 'b']);
  });

  it('hands out a new array each time', () => {
    writeFileSync(join(dir, 'a'), '');
    writeFileSync(join(dir, 'b'), '');
    old(dir);
    const first = listNames(dir);
    first.reverse();
    first.push('z');
    expect(listNames(dir).sort()).toEqual(['a', 'b']);
  });

  it('gives [] for a missing folder, or throws ENOENT when strict', () => {
    expect(listNames(join(dir, 'nope'))).toEqual([]);
    expect(() => listNames(join(dir, 'nope'), { strict: true })).toThrow(expect.objectContaining({ code: 'ENOENT' }));
  });
});

describe('readTailLines', () => {
  it('reads the last 40 lines of a 6 MB file from the end', () => {
    const file = join(dir, 'events.jsonl');
    const lines = [];
    for (let i = 0; i < 60_000; i++) lines.push(JSON.stringify({ i, pad: 'x'.repeat(70) }));
    writeFileSync(file, `${lines.join('\n')}\n`);
    const spy = vi.spyOn(fs, 'readSync');
    const got = readTailLines(file, 40);
    expect(got).toEqual(lines.slice(-40));
    const bytes = spy.mock.calls.reduce((sum, c) => sum + c[3], 0);
    expect(bytes).toBeLessThanOrEqual(256 * 1024);
  });

  it('reads further back when the tail holds too few whole lines', () => {
    const file = join(dir, 'long.jsonl');
    const lines = [];
    for (let i = 0; i < 300; i++) lines.push(`${i} ${'y'.repeat(2000)}`);
    writeFileSync(file, `${lines.join('\n')}\n`);
    expect(readTailLines(file, 100)).toEqual(lines.slice(-100));
  });

  it('returns a short file whole, and [] for a missing one', () => {
    const file = join(dir, 'short.jsonl');
    writeFileSync(file, 'a\nb\nc\n');
    expect(readTailLines(file, 40)).toEqual(['a', 'b', 'c']);
    expect(readTailLines(join(dir, 'nope'), 40)).toEqual([]);
  });

  it('does not use the cache', () => {
    const file = join(dir, 'e.jsonl');
    writeFileSync(file, 'a\n');
    old(file);
    expect(readTailLines(file, 5)).toEqual(['a']);
    fs.appendFileSync(file, 'b\n');
    expect(readTailLines(file, 5)).toEqual(['a', 'b']);
  });
});
