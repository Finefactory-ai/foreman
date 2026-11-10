import { describe, it, expect } from 'vitest';
import { EARLIER_LIMIT, earlierFindings, failedSince, rethinkNote, rethinkOf } from './finding-history.mjs';

const line = (over = {}) => ({ at: '2026-11-01T10:00:00.000Z', story: 'S-1', result: 'failed', builder: 'developer', stage: 'security', severity: 'major', rule: 'bounds read from raw text', where: 'src/a.mjs:4', observed: 'seen', fix: 'do it', ...over });

describe('earlierFindings', () => {
  it("keeps only the story's blocker and major findings, oldest first", () => {
    const lines = [
      line({ rule: 'first' }),
      line({ story: 'S-2', rule: 'other story' }),
      line({ severity: 'minor', rule: 'a nit' }),
      line({ severity: 'Blocker', rule: 'second' }),
    ];
    expect(earlierFindings(lines, 'S-1').map((f) => f.rule)).toEqual(['first', 'second']);
  });

  it('maps the fields and drops result, builder, resolved, story and repeats', () => {
    const [f] = earlierFindings([line({ round: 2, resolved: true, repeats: 'E1' })], 'S-1');
    expect(f).toEqual({ stage: 'security', severity: 'major', rule: 'bounds read from raw text', where: 'src/a.mjs:4', observed: 'seen', fix: 'do it', round: 2, at: '2026-11-01T10:00:00.000Z' });
  });

  it('writes missing fields as empty strings and leaves out a round that is not a whole number', () => {
    const [f] = earlierFindings([{ story: 'S-1', severity: 'major', rule: 'r', round: 'x' }], 'S-1');
    expect(f).toEqual({ stage: '', severity: 'major', rule: 'r', where: '', observed: '', fix: '' });
  });

  it('caps at the newest 60 and skips lines with no rule', () => {
    expect(EARLIER_LIMIT).toBe(60);
    const lines = Array.from({ length: 70 }, (_, i) => line({ rule: `rule ${i}` }));
    const out = earlierFindings([...lines, line({ rule: '' }), line({ rule: undefined })], 'S-1');
    expect(out).toHaveLength(60);
    expect(out[0].rule).toBe('rule 10');
    expect(out[59].rule).toBe('rule 69');
    expect(earlierFindings(lines, 'S-1', { limit: 2 }).map((f) => f.rule)).toEqual(['rule 68', 'rule 69']);
  });
});

describe('failedSince', () => {
  const lines = [line({ at: '2026-11-02T00:00:00.000Z' })];
  it('is true for a failed line after since, false before it', () => {
    expect(failedSince(lines, 'S-1', '2026-11-01T00:00:00.000Z')).toBe(true);
    expect(failedSince(lines, 'S-1', '2026-11-03T00:00:00.000Z')).toBe(false);
  });
  it('ignores another story and lines that did not fail', () => {
    expect(failedSince(lines, 'S-2', '2026-11-01T00:00:00.000Z')).toBe(false);
    expect(failedSince([line({ result: 'passed', at: '2026-11-02T00:00:00.000Z' })], 'S-1', '2026-11-01T00:00:00.000Z')).toBe(false);
  });
  it('counts any failed line when since is not a date', () => {
    expect(failedSince(lines, 'S-1', undefined)).toBe(true);
    expect(failedSince(lines, 'S-1', 'soon')).toBe(true);
    expect(failedSince([], 'S-1', 'soon')).toBe(false);
  });
});

describe('rethinkOf', () => {
  const f = [{ stage: 'security', severity: 'major', rule: 'r', where: 'a.mjs:1', observed: 'o', fix: 'f' }];
  it('accepts a valid object', () => {
    expect(rethinkOf({ round: 2, findings: f })).toEqual({ round: 2, findings: f });
  });
  it('accepts a story cause and a line', () => {
    expect(rethinkOf({ round: 2, findings: f, cause: 'story', line: 1 })).toEqual({ round: 2, findings: f, cause: 'story', line: 1 });
    expect(rethinkOf({ round: 2, findings: f, cause: 'story' })).toEqual({ round: 2, findings: f, cause: 'story' });
  });
  it('returns exactly round and findings for today\'s input, whatever else the file holds', () => {
    expect(Object.keys(rethinkOf({ round: 2, findings: f, extra: 1 }))).toEqual(['round', 'findings']);
  });
  it('throws on a cause that is not story, and on a bad line or a line without the cause', () => {
    expect(() => rethinkOf({ round: 1, findings: f, cause: 'bug' })).toThrow('cause must be "story" when set');
    expect(() => rethinkOf({ round: 1, findings: f, cause: 'story', line: 0 })).toThrow('line must be a whole number of at least 1, with cause "story"');
    expect(() => rethinkOf({ round: 1, findings: f, cause: 'story', line: 1.5 })).toThrow('line must be a whole number');
    expect(() => rethinkOf({ round: 1, findings: f, line: 1 })).toThrow('line must be a whole number of at least 1, with cause "story"');
  });
  it('throws on a missing or zero round, empty findings or a non-object', () => {
    expect(() => rethinkOf({ findings: f })).toThrow('round must be a whole number of at least 1');
    expect(() => rethinkOf({ round: 0, findings: f })).toThrow('round must be a whole number of at least 1');
    expect(() => rethinkOf({ round: 1.5, findings: f })).toThrow('round must be a whole number');
    expect(() => rethinkOf({ round: 1, findings: [] })).toThrow('findings must be a non-empty list');
    expect(() => rethinkOf({ round: 1, findings: ['x'] })).toThrow('findings must be a non-empty list');
    expect(() => rethinkOf([1])).toThrow();
    expect(() => rethinkOf(null)).toThrow();
    expect(() => rethinkOf('x')).toThrow();
  });
});

describe('rethinkNote', () => {
  it('says what happened', () => {
    expect(rethinkNote(2)).toBe('Round 2 found the same kind of bug again; sent back to the architect to change the approach.');
    expect(rethinkNote(2, {})).toBe(rethinkNote(2));
  });
  it('says the builder found the Done-when line cannot hold', () => {
    expect(rethinkNote(1, { cause: 'story', line: 1 })).toBe('The builder found Done-when 1 cannot hold; sent back to the architect to correct it.');
  });
  it('says the story cannot hold as written when no line is named', () => {
    expect(rethinkNote(1, { cause: 'story' })).toBe('The builder found the story cannot hold as written; sent back to the architect to correct it.');
  });
});
