import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addItem, keepItem, readLedger, undoItem, updateItem } from '../engine/learning-store.mjs';
import { OPTIONS } from '../engine/answers.mjs';
import { add, list, pending } from './decisions.mjs';
import { NO_ITEM, hasLearned, keepLearned, learnedRows, learningCounts, undoLearned } from './learned.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foreman-learned-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const now = new Date('2026-10-25T09:00:00Z');
const later = new Date('2026-10-25T10:00:00Z');
const ROLE = 'learned/traits/developer.md';
const V1 = 'Acme: give every new route a test.';
const V2 = 'Acme: give every new route and every error path a test.';
const read = (rel) => readFileSync(join(dir, rel), 'utf8');
const ledgerText = () => (existsSync(join(dir, 'learning.jsonl')) ? read('learning.jsonl') : '');
const trait = (text = V1, role = 'developer', reason = 'two stories shipped untested routes') => addItem(dir, { kind: 'trait', roles: [role], text, source: { key: 'untested-routes', stories: ['ACME-1', 'ACME-2'] }, reason }, { now });
const update = (id = 'L-1', text = V2) => updateItem(dir, id, { text, reason: 'a third story missed the error path' }, { now });
const note = (title, options = OPTIONS.learned) => add(dir, { story: 'ACME-2', kind: 'decision', title, options, hints: options.map((o) => `${o}.`) }, now);
const saved = (id) => list(dir).find((d) => d.id === id);

describe('learnedRows', () => {
  it("reads 'on trial' after an add, 'kept' after a keep, and 'undone' after the owner's undo", () => {
    trait();
    expect(learnedRows(dir)).toEqual([{ id: 'L-1', kind: 'trait', roles: ['developer'], v: 1, status: 'on trial', reason: 'two stories shipped untested routes', by: 'foreman', at: now.toISOString() }]);
    keepItem(dir, 'L-1', { now: later, by: 'owner' });
    expect(learnedRows(dir)[0]).toMatchObject({ v: 1, status: 'kept', reason: 'two stories shipped untested routes', by: 'owner', at: later.toISOString() });
    undoItem(dir, 'L-1', { now: later, by: 'owner' });
    expect(learnedRows(dir)[0]).toMatchObject({ v: 0, status: 'undone', reason: 'Undone by you', by: 'owner' });
  });

  it("reads 'rolled back' with the rollback's reason, and 'retired' for a rollback that retires", () => {
    trait();
    trait('Acme: name each test after its route.', 'tester', 'tests are hard to find');
    trait('Acme: keep each route under 50 lines.', 'reviewer', 'routes grow too long');
    undoItem(dir, 'L-1', { now: later, by: 'foreman', action: 'rollback', reason: 'Stories got worse: rounds 1.0 → 1.6', metrics: { decision: 'rollback' } });
    undoItem(dir, 'L-2', { now: later, by: 'foreman', action: 'rollback', reason: 'No effect: the finding came back', metrics: { decision: 'retire' } });
    undoItem(dir, 'L-3', { now: later, by: 'foreman', action: 'rollback', reason: '', metrics: null });
    const rows = learnedRows(dir);
    expect(rows.map((r) => [r.id, r.status, r.reason, r.by])).toEqual([
      ['L-3', 'rolled back', 'Rolled back by Foreman', 'foreman'],
      ['L-2', 'retired', 'No effect: the finding came back', 'foreman'],
      ['L-1', 'rolled back', 'Stories got worse: rounds 1.0 → 1.6', 'foreman'],
    ]);
  });

  it('comes newest id first, at most 50, and never carries the text, path or snapshot', () => {
    for (let i = 1; i <= 12; i += 1) trait(`Acme rule ${i}.`, `role-${i}`);
    update('L-3', 'Acme rule 3, again.');
    const rows = learnedRows(dir);
    expect(rows.map((r) => r.id)).toEqual(['L-12', 'L-11', 'L-10', 'L-9', 'L-8', 'L-7', 'L-6', 'L-5', 'L-4', 'L-3', 'L-2', 'L-1']);
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(['at', 'by', 'id', 'kind', 'reason', 'roles', 'status', 'v']);
      expect(JSON.stringify(r)).not.toContain('Acme rule');
      expect(JSON.stringify(r)).not.toContain('learned/');
    }
    expect(rows.find((r) => r.id === 'L-3')).toMatchObject({ v: 2, status: 'on trial', reason: 'a third story missed the error path' });
  });

  it('keeps to the newest 50', () => {
    for (let i = 1; i <= 52; i += 1) trait(`Acme rule ${i}.`, `role-${i}`);
    const rows = learnedRows(dir);
    expect(rows).toHaveLength(50);
    expect(rows[0].id).toBe('L-52');
    expect(rows.at(-1).id).toBe('L-3');
  });

  it('is empty with no ledger', () => {
    expect(learnedRows(dir)).toEqual([]);
  });
});

describe('undoLearned', () => {
  it('goes back to v1, writes an undo line by the owner and closes the open note in the same write', () => {
    trait();
    update();
    const d = note('Foreman changed L-1 for developer');
    const r = undoLearned(dir, 'L-1', { now: later });
    expect(r).toEqual({ ok: true, message: 'Undid L-1: back to v1.' });
    expect(read(ROLE)).toBe(`[L-1] ${V1}\n`);
    expect(readLedger(dir).at(-1)).toMatchObject({ id: 'L-1', action: 'undo', by: 'owner', v: 1 });
    expect(saved(d)).toMatchObject({ answer: { option: 'Undo the change' }, appliedAt: later.toISOString() });
    expect(pending(dir)).toEqual([]);
  });

  it('removes the trait file when the item had one version', () => {
    trait();
    expect(undoLearned(dir, 'L-1', { now: later })).toEqual({ ok: true, message: 'Undid L-1: removed.' });
    expect(existsSync(join(dir, ROLE))).toBe(false);
  });

  it("closes every open learned or changed note for that id, and leaves other notes alone", () => {
    trait();
    trait('Acme: name each test after its route.', 'tester');
    update();
    const first = note('Foreman learned L-1 for developer');
    const second = note('Foreman changed L-1 for developer');
    const other = note('Foreman learned L-2 for tester');
    const gotIt = note('Foreman rolled back L-1 for developer', OPTIONS.rolledBack);
    undoLearned(dir, 'L-1', { now: later });
    expect(saved(first).appliedAt).toBe(later.toISOString());
    expect(saved(second).appliedAt).toBe(later.toISOString());
    expect(saved(other)).toMatchObject({ answer: null, appliedAt: null });
    expect(saved(gotIt)).toMatchObject({ answer: null, appliedAt: null });
  });

  it('marks a note applied even when it does not offer Undo the change, so no second undo can follow', () => {
    trait();
    const odd = note('Foreman learned L-1 for developer', ['Fine']);
    expect(undoLearned(dir, 'L-1', { now: later }).ok).toBe(true);
    expect(saved(odd).appliedAt).toBe(later.toISOString());
  });

  it('clears the note of an item already taken out, and says so', () => {
    trait();
    undoItem(dir, 'L-1', { now, by: 'foreman', action: 'rollback', reason: 'Stories got worse' });
    const d = note('Foreman learned L-1 for developer');
    const before = ledgerText();
    expect(undoLearned(dir, 'L-1', { now: later })).toEqual({ ok: true, message: 'L-1 was already taken out; the note is cleared.' });
    expect(ledgerText()).toBe(before);
    expect(saved(d).appliedAt).toBe(later.toISOString());
  });

  it("refuses with the store's words when a snapshot was changed, touching neither the file nor the note", () => {
    trait();
    update();
    const d = note('Foreman changed L-1 for developer');
    writeFileSync(join(dir, 'learned/.history/L-1/v1.md'), 'something else');
    const file = read(ROLE);
    const before = ledgerText();
    expect(undoLearned(dir, 'L-1', { now: later })).toEqual({ ok: false, status: 409, error: 'the snapshot of L-1 v1 is missing or changed; nothing was undone' });
    expect(read(ROLE)).toBe(file);
    expect(ledgerText()).toBe(before);
    expect(saved(d)).toMatchObject({ answer: null, appliedAt: null });
  });

  it('answers 409 with the store\'s words while another process holds the lock', () => {
    trait();
    const d = note('Foreman learned L-1 for developer');
    writeFileSync(join(dir, 'learning.lock'), JSON.stringify({ pid: process.pid, at: now.toISOString() }));
    const r = undoLearned(dir, 'L-1', { now: later });
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(r.error).toMatch(/another Foreman process/);
    expect(existsSync(join(dir, ROLE))).toBe(true);
    expect(saved(d).appliedAt).toBeNull();
  });

  it('refuses a malformed or unknown id with 404, echoing nothing and calling no store', () => {
    trait();
    const d = note('Foreman learned L-1 for developer');
    const before = ledgerText();
    for (const id of ['../x', 'L-x', 'L-1/../../x', '', undefined, 'L-99']) {
      const r = undoLearned(dir, id, { now: later });
      expect(r, String(id)).toMatchObject({ ok: false, status: 404 });
      if (id) expect(JSON.stringify(r)).not.toContain(id);
    }
    expect(ledgerText()).toBe(before);
    expect(saved(d).appliedAt).toBeNull();
  });
  it('clears the open note of a well-formed id the ledger no longer has, writing no line', () => {
    trait();
    const d = note('Foreman learned L-1 for developer');
    const file = read(ROLE);
    rmSync(join(dir, 'learning.jsonl'));
    expect(undoLearned(dir, 'L-1', { now: later })).toEqual({ ok: true, message: 'L-1 is no longer in the learned list; the note is cleared.' });
    expect(saved(d)).toMatchObject({ answer: { option: 'Undo the change' }, appliedAt: later.toISOString() });
    expect(existsSync(join(dir, 'learning.jsonl'))).toBe(false);
    expect(read(ROLE)).toBe(file);
  });

  it('is still a 404 for a well-formed id missing from the ledger with no open learned or changed note', () => {
    trait();
    const gotIt = note('Foreman rolled back L-5 for developer', OPTIONS.rolledBack);
    const before = ledgerText();
    for (const id of ['L-5', 'L-7']) {
      const r = undoLearned(dir, id, { now: later });
      expect(r, id).toEqual({ ok: false, status: 404, error: NO_ITEM });
      expect(JSON.stringify(r)).not.toContain(id);
    }
    expect(saved(gotIt)).toMatchObject({ answer: null, appliedAt: null });
    expect(ledgerText()).toBe(before);
  });

  it('turns an unknown plain error from the store into a fixed 409 that names no path, touching nothing', () => {
    trait();
    const d = note('Foreman learned L-1 for developer');
    const tampered = ledgerText().split('\n').filter(Boolean).map((raw) => JSON.stringify({ ...JSON.parse(raw), path: '../acme-escape.md' }));
    writeFileSync(join(dir, 'learning.jsonl'), `${tampered.join('\n')}\n`);
    const before = ledgerText();
    const r = undoLearned(dir, 'L-1', { now: later });
    expect(r).toEqual({ ok: false, status: 409, error: 'The learned item could not be changed; run foreman learning undo or keep for it from the command line to see why.' });
    for (const word of ['acme-escape', 'outside', 'learned/']) expect(JSON.stringify(r)).not.toContain(word);
    expect(saved(d)).toMatchObject({ answer: null, appliedAt: null });
    expect(ledgerText()).toBe(before);
    expect(existsSync(join(dir, ROLE))).toBe(true);
  });
});

describe('keepLearned', () => {
  it('keeps the version in force and closes the note with Keep the change', () => {
    trait();
    update();
    const d = note('Foreman changed L-1 for developer');
    expect(keepLearned(dir, 'L-1', { now: later })).toEqual({ ok: true, message: 'Kept L-1 at v2.' });
    expect(readLedger(dir).at(-1)).toMatchObject({ id: 'L-1', action: 'keep', by: 'owner', v: 2 });
    expect(saved(d)).toMatchObject({ answer: { option: 'Keep the change' }, appliedAt: later.toISOString() });
    expect(read(ROLE)).toBe(`[L-1] ${V2}\n`);
  });

  it('refuses a malformed id with 404', () => {
    expect(keepLearned(dir, 'L-x', { now: later })).toMatchObject({ ok: false, status: 404 });
  });

  it('clears the note of an item already taken out', () => {
    trait();
    undoItem(dir, 'L-1', { now, by: 'owner' });
    const d = note('Foreman learned L-1 for developer');
    expect(keepLearned(dir, 'L-1', { now: later })).toEqual({ ok: true, message: 'L-1 was already taken out; the note is cleared.' });
    expect(saved(d)).toMatchObject({ answer: { option: 'Keep the change' }, appliedAt: later.toISOString() });
  });
  it('clears the open note of a well-formed id the ledger no longer has, and leaves the others', () => {
    trait();
    const gone = note('Foreman changed L-3 for tester');
    const other = note('Foreman learned L-1 for developer');
    const before = ledgerText();
    expect(keepLearned(dir, 'L-3', { now: later })).toEqual({ ok: true, message: 'L-3 is no longer in the learned list; the note is cleared.' });
    expect(saved(gone)).toMatchObject({ answer: { option: 'Keep the change' }, appliedAt: later.toISOString() });
    expect(saved(other)).toMatchObject({ answer: null, appliedAt: null });
    expect(ledgerText()).toBe(before);
  });
});

describe('learningCounts', () => {
  it('is null with no ledger, or a ledger with no item', () => {
    expect(learningCounts(dir)).toBeNull();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'learning.jsonl'), 'not json\n');
    expect(learningCounts(dir)).toBeNull();
  });

  it('counts the items in force and those still in evaluation', () => {
    trait();
    trait('Acme: name each test after its route.', 'tester');
    trait('Acme: keep each route short.', 'reviewer');
    keepItem(dir, 'L-2', { now, by: 'owner' });
    undoItem(dir, 'L-3', { now, by: 'owner' });
    expect(learningCounts(dir)).toEqual({ active: 2, evaluating: 1 });
  });
});

describe('hasLearned', () => {
  it('is true only for a well-formed id the ledger has', () => {
    for (const id of ['L-1', 'L-99', 'L-x', '../x', '', undefined]) expect(hasLearned(dir, id), String(id)).toBe(false);
    trait();
    expect(hasLearned(dir, 'L-1')).toBe(true);
    for (const id of ['L-99', 'L-x', '../x', '', undefined, 'L-1/../../x']) expect(hasLearned(dir, id), String(id)).toBe(false);
  });
});
