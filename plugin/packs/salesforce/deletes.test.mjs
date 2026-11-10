import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { answerDeletes, askDeletes, deletesFile, readDeletes } from './deletes.mjs';

const ASKED = new Date('2026-10-24T10:00:00.000Z');
const ANSWERED = new Date('2026-10-24T11:00:00.000Z');
const SHA = 'a'.repeat(64);
const DELETES = [{ type: 'ApexClass', member: 'AcmeOld' }];

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-deletes-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('the deletes approval record', () => {
  it('reads back the record it wrote, unanswered', () => {
    const written = askDeletes(dir, { story: 'ACME-1', sha256: SHA, deletes: DELETES }, ASKED);
    const want = { story: 'ACME-1', sha256: SHA, deletes: DELETES, askedAt: ASKED.toISOString(), answer: null, answeredAt: null };
    expect(written).toEqual(want);
    expect(readDeletes(dir, 'ACME-1')).toEqual(want);
    expect(deletesFile(dir, 'ACME-1')).toBe(path.join(dir, 'salesforce', 'deletes', 'ACME-1.json'));
  });

  it('reads a missing or broken file as null', () => {
    expect(readDeletes(dir, 'ACME-1')).toBeNull();
    fs.mkdirSync(path.join(dir, 'salesforce', 'deletes'), { recursive: true });
    fs.writeFileSync(deletesFile(dir, 'ACME-1'), '{ not json');
    expect(readDeletes(dir, 'ACME-1')).toBeNull();
    fs.writeFileSync(deletesFile(dir, 'ACME-1'), '[1, 2]');
    expect(readDeletes(dir, 'ACME-1')).toBeNull();
  });

  it('a fresh ask replaces an older record, answer and all', () => {
    askDeletes(dir, { story: 'ACME-1', sha256: SHA, deletes: DELETES }, ASKED);
    answerDeletes(dir, 'ACME-1', 'allow', ANSWERED);
    askDeletes(dir, { story: 'ACME-1', sha256: 'b'.repeat(64), deletes: DELETES }, ANSWERED);
    expect(readDeletes(dir, 'ACME-1')).toMatchObject({ sha256: 'b'.repeat(64), answer: null, answeredAt: null });
  });

  for (const answer of ['allow', 'keep-out']) {
    it(`answering ${answer} keeps the sha256 and records the answer and when`, () => {
      askDeletes(dir, { story: 'ACME-1', sha256: SHA, deletes: DELETES }, ASKED);
      const r = answerDeletes(dir, 'ACME-1', answer, ANSWERED);
      const want = { story: 'ACME-1', sha256: SHA, deletes: DELETES, askedAt: ASKED.toISOString(), answer, answeredAt: ANSWERED.toISOString() };
      expect(r).toEqual(want);
      expect(readDeletes(dir, 'ACME-1')).toEqual(want);
    });
  }

  it('refuses to answer with no record, or with an answer it does not know', () => {
    expect(() => answerDeletes(dir, 'ACME-1', 'allow', ANSWERED)).toThrow(/no deletes wait for ACME-1/);
    askDeletes(dir, { story: 'ACME-1', sha256: SHA, deletes: DELETES }, ASKED);
    for (const bad of ['maybe', '', null, undefined]) expect(() => answerDeletes(dir, 'ACME-1', bad, ANSWERED)).toThrow();
    expect(readDeletes(dir, 'ACME-1').answer).toBeNull();
  });

  it('keeps a story id with / or .. inside the deletes folder', () => {
    const folder = path.join(dir, 'salesforce', 'deletes');
    for (const id of ['../../ACME-1', 'a/b', '..']) {
      const file = deletesFile(dir, id);
      expect(path.dirname(file)).toBe(folder);
      askDeletes(dir, { story: id, sha256: SHA, deletes: DELETES }, ASKED);
      expect(readDeletes(dir, id)).toMatchObject({ story: id });
    }
    expect(fs.readdirSync(dir)).toEqual(['salesforce']);
  });
});
