import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { add, answer, applied, decisionsDir, list } from './decisions.mjs';
import { answerBundle, BUNDLE_ACTIONS, BUNDLES, bundleMessage } from './bundles.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foreman-bundles-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const at = (s) => new Date(`2026-10-15T09:00:${String(s).padStart(2, '0')}Z`);
const FOLLOW = ['Create a follow-up story', 'Ignore'];
const followUp = (n, options = FOLLOW) => add(dir, { story: `ACME-${n}`, kind: 'decision', title: `Follow up on ACME-${n}: 2 minor finding(s)?`, options, summary: '2 minor: a; b' }, at(n));
const trait = (n) => add(dir, { story: `ACME-${n}`, kind: 'decision', title: 'Add a trait for developer: Check inputs?', options: ['Add as a trait', 'Ignore'] }, at(n));
const plain = (n) => add(dir, { story: `ACME-${n}`, kind: 'decision', title: 'Which login?', options: ['yes', 'no'] }, at(n));
const saved = (id) => list(dir).find((i) => i.id === id);

describe('BUNDLES', () => {
  it('names the options `foreman learn` asks with, and is frozen', () => {
    expect(BUNDLES['follow-ups']).toEqual({ 'create-all': 'Create a follow-up story', 'ignore-all': 'Ignore' });
    expect(BUNDLES.traits).toEqual({ 'create-all': 'Add as a trait', 'ignore-all': 'Ignore' });
    expect(BUNDLE_ACTIONS).toEqual(['create-all', 'ignore-all']);
    expect(Object.isFrozen(BUNDLES)).toBe(true);
  });
});

describe('answerBundle', () => {
  it('create-all answers every follow-up with Create a follow-up story, and leaves the rest', () => {
    const ids = [followUp(1), followUp(2), followUp(3)];
    const t = trait(4);
    const p = plain(5);
    const r = answerBundle(dir, 'follow-ups', 'create-all', at(30));
    expect(r).toEqual({ answered: ids, failed: [] });
    for (const id of ids) expect(saved(id).answer).toMatchObject({ option: 'Create a follow-up story', at: at(30).toISOString() });
    expect(saved(t).answer).toBeNull();
    expect(saved(p).answer).toBeNull();
  });

  it('ignore-all answers Ignore', () => {
    const ids = [followUp(1), followUp(2)];
    expect(answerBundle(dir, 'follow-ups', 'ignore-all').answered).toEqual(ids);
    for (const id of ids) expect(saved(id).answer.option).toBe('Ignore');
  });

  it('traits create-all answers Add as a trait, and leaves the follow-ups', () => {
    const f = followUp(1);
    const t = trait(2);
    expect(answerBundle(dir, 'traits', 'create-all')).toEqual({ answered: [t], failed: [] });
    expect(saved(t).answer.option).toBe('Add as a trait');
    expect(saved(f).answer).toBeNull();
  });

  it('skips an item already answered, and one already applied', () => {
    const a = followUp(1);
    answer(dir, a, { option: 'Ignore' }, at(10));
    const b = followUp(2);
    answer(dir, b, { option: 'Create a follow-up story' }, at(11));
    applied(dir, b, at(12));
    const c = followUp(3);
    expect(answerBundle(dir, 'follow-ups', 'create-all', at(30))).toEqual({ answered: [c], failed: [] });
    expect(saved(a).answer).toMatchObject({ option: 'Ignore', at: at(10).toISOString() });
    expect(saved(b).answer.at).toBe(at(11).toISOString());
  });

  it('reports an item it could not answer, and answers the others', () => {
    const a = followUp(1);
    const bad = followUp(2, ['Yes', 'No']);
    const c = followUp(3);
    const r = answerBundle(dir, 'follow-ups', 'create-all');
    expect(r.answered).toEqual([a, c]);
    expect(r.failed).toEqual([{ id: bad, error: `"Create a follow-up story" is not one of the options for ${bad}: "Yes", "No".` }]);
    expect(saved(bad).answer).toBeNull();
  });

  it.skipIf(process.getuid?.() === 0)('reports a file it could not save without naming any path', () => {
    const a = followUp(1);
    chmodSync(decisionsDir(dir), 0o500);
    try {
      const r = answerBundle(dir, 'follow-ups', 'create-all');
      expect(r).toEqual({ answered: [], failed: [{ id: a, error: 'Could not save the answer; see the run log.' }] });
    } finally {
      chmodSync(decisionsDir(dir), 0o700);
    }
  });

  it('answers nothing when nothing is left', () => {
    expect(answerBundle(dir, 'follow-ups', 'ignore-all')).toEqual({ answered: [], failed: [] });
  });

  it('refuses an unknown bundle or action without repeating it', () => {
    followUp(1);
    for (const [name, action] of [['nope-<b>', 'create-all'], ['__proto__', 'create-all'], ['constructor', 'create-all'], ['follow-ups', 'make-all<i>'], ['follow-ups', '__proto__'], ['follow-ups', undefined], [null, 'create-all']]) {
      let err;
      try {
        answerBundle(dir, name, action);
      } catch (e) {
        err = e;
      }
      expect(err, `${name} ${action}`).toBeInstanceOf(Error);
      expect(err.code).toBeUndefined();
      if (typeof name === 'string' && name !== 'follow-ups') expect(err.message).not.toContain(name);
      if (typeof action === 'string' && action !== 'create-all') expect(err.message).not.toContain(action);
    }
    expect(() => answerBundle(dir, 'nope', 'create-all')).toThrow('Unknown bundle; one of follow-ups, traits.');
    expect(() => answerBundle(dir, 'follow-ups', 'make-all')).toThrow('Unknown action; one of create-all, ignore-all.');
    expect(list(dir).every((i) => i.answer === null)).toBe(true);
  });
});

describe('bundleMessage', () => {
  it('says how many were answered, and how many could not be', () => {
    expect(bundleMessage({ answered: ['a', 'b'], failed: [] })).toBe('Answered 2.');
    expect(bundleMessage({ answered: [], failed: [] })).toBe('Nothing left to answer here.');
    expect(bundleMessage({ answered: ['a'], failed: [{ id: 'b', error: 'x' }, { id: 'c', error: 'y' }] })).toBe('Answered 1; 2 could not be answered.');
  });
});
