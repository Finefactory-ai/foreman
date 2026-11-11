import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eventLine, followEvents, secretValues } from './event-echo.mjs';

let dir;
let file;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-event-echo-'));
  file = path.join(dir, 'events.jsonl');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const ev = (text, extra = {}) => ({ at: '2026-10-18T10:00:00.000Z', kind: 'info', slot: null, text, ...extra });
const append = (...events) => fs.appendFileSync(file, events.map((e) => JSON.stringify(e) + '\n').join(''));
const follower = (extra = {}) => {
  const out = [];
  const f = followEvents({ file, write: (s) => out.push(s), fs, ...extra });
  return { f, out };
};

describe('eventLine', () => {
  it('gives at, kind, slot and text', () => {
    expect(eventLine(ev('Slot w1: ACME-1', { kind: 'story', slot: 'w1' }))).toBe('2026-10-18T10:00:00.000Z story w1 Slot w1: ACME-1');
  });

  it('uses - when there is no slot', () => {
    expect(eventLine(ev('Factory halted: CI is red', { kind: 'warn' }))).toBe('2026-10-18T10:00:00.000Z warn - Factory halted: CI is red');
  });

  it('puts a multi-line text on one line', () => {
    expect(eventLine(ev('line one\n  line two\r\n\tline three  '))).toBe('2026-10-18T10:00:00.000Z info - line one line two line three');
  });

  it('masks a key in the text', () => {
    const line = eventLine(ev('pushed with GH_TOKEN=ghp_x now'));
    expect(line).toContain('GH_TOKEN=•••');
    expect(line).not.toContain('ghp_x');
  });

  it('drops control characters from the text, at, kind and slot', () => {
    const line = eventLine(ev('red \x1b[31mALERT\x1b[0m\x07 done\x00\x9b', { at: '2026-10-18T10:00:00.000Z\x1b[2J', kind: 'warn\x1b', slot: 'w1\x07' }));
    expect(line).toBe('2026-10-18T10:00:00.000Z[2J warn w1 red [31mALERT[0m done');
    expect(line).not.toMatch(/[\x00-\x08\x0e-\x1f\x7f-\x9f]/);
  });

  it('a lone carriage return becomes a space', () => {
    expect(eventLine(ev('a\rb'))).toMatch(/ a b$/);
  });

  it('uses - for a slot that is only control characters', () => {
    expect(eventLine(ev('x', { slot: '\x07' }))).toBe('2026-10-18T10:00:00.000Z info - x');
  });

  it('masks a known value with the mask, also one split by a control character', () => {
    const mask = (t) => t.split('AcmeRefresh0123').join('•••');
    const line = eventLine(ev('sign-in https://auth.acme.example/cb?refresh=Acme\x1bRefresh0123 refused'), { mask });
    expect(line).toContain('refresh=•••');
    expect(line).not.toContain('Refresh0123');
  });

  it.each([[{ kind: 'info' }], [{ text: 5 }], [null], ['text'], [undefined]])('gives null for %j', (e) => {
    expect(eventLine(e)).toBeNull();
  });
});

describe('followEvents', () => {
  it('does not echo the lines that were there at the start, and echoes later ones once each, in order', () => {
    append(ev('old one'), ev('old two'));
    const { f, out } = follower();
    f.poll();
    expect(out).toEqual([]);
    append(ev('new one'), ev('new two'));
    f.poll();
    f.poll();
    expect(out).toEqual(['2026-10-18T10:00:00.000Z info - new one\n', '2026-10-18T10:00:00.000Z info - new two\n']);
    f.close();
  });

  it('picks up a file that appears later from its first line', () => {
    const { f, out } = follower();
    f.poll();
    expect(out).toEqual([]);
    append(ev('first'), ev('second'));
    f.poll();
    expect(out.map((l) => l.trim().split(' ').slice(3).join(' '))).toEqual(['first', 'second']);
    f.close();
  });

  it('holds a half-written line until its newline arrives', () => {
    const { f, out } = follower();
    f.poll();
    const text = JSON.stringify(ev('whole'));
    fs.appendFileSync(file, text.slice(0, 20));
    f.poll();
    expect(out).toEqual([]);
    fs.appendFileSync(file, text.slice(20) + '\n');
    f.poll();
    expect(out).toEqual(['2026-10-18T10:00:00.000Z info - whole\n']);
    f.close();
  });

  it('skips a line that is not JSON and still echoes the next', () => {
    const { f, out } = follower();
    f.poll();
    fs.appendFileSync(file, 'not json\n');
    append(ev('after'));
    f.poll();
    expect(out).toEqual(['2026-10-18T10:00:00.000Z info - after\n']);
    f.close();
  });

  it('reads the old log to its end, then the new one, when the log is rotated', () => {
    append(ev('before'));
    const { f, out } = follower();
    f.poll();
    append(ev('A'));
    fs.renameSync(file, path.join(dir, 'events-x.jsonl'));
    append(ev('B'));
    f.poll();
    expect(out.map((l) => l.trim().split(' ').pop())).toEqual(['A', 'B']);
    append(ev('C'));
    f.poll();
    expect(out.map((l) => l.trim().split(' ').pop())).toEqual(['A', 'B', 'C']);
    f.close();
  });

  it('flushes the last lines on close, and writes nothing after it', () => {
    const { f, out } = follower();
    f.poll();
    append(ev('last'));
    f.close();
    expect(out).toEqual(['2026-10-18T10:00:00.000Z info - last\n']);
    append(ev('later'));
    f.poll();
    f.close();
    expect(out).toHaveLength(1);
  });

  it('writes characters intact when a read ends inside one', () => {
    const slow = { ...fs, readSync: (fd, b, o, l, p) => fs.readSync(fd, b, o, Math.min(l, 1), p) };
    const out = [];
    const f = followEvents({ file, write: (s) => out.push(s), fs: slow });
    f.poll();
    append(ev('café — 日本 ✓ 🚀'));
    f.poll();
    expect(out).toEqual(['2026-10-18T10:00:00.000Z info - café — 日本 ✓ 🚀\n']);
    expect(out.join('')).not.toContain('\ufffd');
    f.close();
  });

  it('applies the mask to every line', () => {
    const { f, out } = follower({ mask: (t) => t.split('AcmeSecret99').join('•••') });
    f.poll();
    append(ev('first AcmeSecret99 here'), ev('second AcmeSecret99'));
    f.poll();
    expect(out).toEqual(['2026-10-18T10:00:00.000Z info - first ••• here\n', '2026-10-18T10:00:00.000Z info - second •••\n']);
    f.close();
  });

  it('writes nothing for a line whose mask throws, and never throws', () => {
    const { f, out } = follower({
      mask: () => {
        throw new Error('mask gone');
      },
    });
    f.poll();
    append(ev('AcmeSecret99'));
    expect(() => {
      f.poll();
      f.close();
    }).not.toThrow();
    expect(out).toEqual([]);
  });

  it('never throws when the folder is missing', () => {
    const f = followEvents({ file: path.join(dir, 'nope', 'events.jsonl'), write: () => {}, fs });
    expect(() => {
      f.poll();
      f.close();
    }).not.toThrow();
  });

  it('never throws when the fs does, or when write does', () => {
    const boom = () => {
      throw new Error('disk gone');
    };
    const broken = { existsSync: boom, openSync: boom, readSync: boom, fstatSync: boom, statSync: boom, closeSync: boom };
    const f = followEvents({ file, write: () => {}, fs: broken });
    expect(() => {
      f.poll();
      f.close();
    }).not.toThrow();

    append(ev('x'));
    const g = followEvents({
      file,
      write: boom,
      fs,
    });
    append(ev('y'));
    expect(() => {
      g.poll();
      g.close();
    }).not.toThrow();
  });
});

describe('secretValues', () => {
  it('gives the unique long values of the named variables, longest first', () => {
    const env = { A: 'AcmeLongValue1', B: 'short', C: '', D: 'AcmeLongValue1', E: 'AcmeLongValue1Longer', F: 5 };
    expect(secretValues(env, ['A', 'B', 'C', 'D', 'E', 'F', 'MISSING'])).toEqual(['AcmeLongValue1Longer', 'AcmeLongValue1']);
  });
});
