import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS } from '../config/defaults.mjs';
import { addItem, keepItem, readLedger, refuseItem, undoItem, updateItem } from './learning-store.mjs';
import { learningStatus, learningTotals, movedPackSkills, packRefs } from './learning-health.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const NOW = new Date('2026-10-25T12:00:00Z');
const DAY = 24 * 3600 * 1000;
const ago = (days) => ({ now: new Date(NOW.getTime() - days * DAY) });

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foreman-learning-health-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const skillText = (names) => `---\nname: foreman-learned-acme\ndescription: "Use when Acme work uses ${names}."\n---\n\n## Steps\n\n1. Run ${names}.\n`;
const addSkill = (slug, packs, at = ago(1), names = Object.keys(packs ?? {}).join(' and ') || 'nothing') =>
  addItem(dir, { kind: 'skill', roles: ['developer'], slug, text: skillText(names), source: { key: 'f-000000000001', stories: ['S-1'] }, reason: 'Acme', metrics: packs ? { packs } : null }, at);
const addTrait = (role, at = ago(1)) => addItem(dir, { kind: 'trait', roles: [role], text: `Acme: a ${role} rule ${Math.random()}`, reason: 'Acme' }, at);

describe('packRefs', () => {
  const lock = { 'sf-apex': { ref: 'v1.0.0', commit: A }, 'sf-flow': { ref: 'v1.0.0', commit: 'not-a-commit' } };

  it('finds a lock skill named as a whole word, a full stop after it included', () => {
    expect(packRefs('Run sf-apex.', lock)).toEqual({ 'sf-apex': { ref: 'v1.0.0', commit: A } });
  });

  it('ignores a longer name that only starts with a lock name', () => {
    expect(packRefs('Run sf-apex-extra first', { 'sf-apex': { ref: 'v1.0.0', commit: A } })).toBeNull();
    expect(packRefs('Run xsf-apex first', { 'sf-apex': { ref: 'v1.0.0', commit: A } })).toBeNull();
  });

  it('turns a commit that is not a full hex id into null', () => {
    expect(packRefs('Use sf-flow here', lock)).toEqual({ 'sf-flow': { ref: 'v1.0.0', commit: null } });
    expect(packRefs('Use sf-apex', { 'sf-apex': { ref: 7 } })).toEqual({ 'sf-apex': { ref: '7', commit: null } });
  });

  it('returns null with no lock, or when nothing matches', () => {
    expect(packRefs('Run sf-apex.', undefined)).toBeNull();
    expect(packRefs('Run sf-apex.', null)).toBeNull();
    expect(packRefs('Nothing named here', lock)).toBeNull();
  });

  it('treats a name with regex characters literally', () => {
    expect(packRefs('Run sfXapex', { 'sf.apex': { ref: 'v1', commit: A } })).toBeNull();
    expect(packRefs('Run sf.apex', { 'sf.apex': { ref: 'v1', commit: A } })).toEqual({ 'sf.apex': { ref: 'v1', commit: A } });
  });
});

describe('movedPackSkills', () => {
  const moved = (lock) => movedPackSkills(readLedger(dir), lock);

  it('reports a ref that changed', () => {
    addSkill('acme-flow', { 'sf-flow': { ref: 'v1.0.0', commit: A } });
    expect(moved({ 'sf-flow': { ref: 'v1.1.0', commit: B } })).toEqual([{ id: 'L-1', name: 'sf-flow', was: { ref: 'v1.0.0', commit: A }, now: { ref: 'v1.1.0', commit: B } }]);
  });

  it('reports the same ref pointing at another commit', () => {
    addSkill('acme-flow', { 'sf-flow': { ref: 'v1.0.0', commit: A } });
    expect(moved({ 'sf-flow': { ref: 'v1.0.0', commit: B } })).toEqual([{ id: 'L-1', name: 'sf-flow', was: { ref: 'v1.0.0', commit: A }, now: { ref: 'v1.0.0', commit: B } }]);
  });

  it('does not report the same ref when either commit is not a full id', () => {
    addSkill('acme-flow', { 'sf-flow': { ref: 'v1.0.0', commit: null } });
    expect(moved({ 'sf-flow': { ref: 'v1.0.0', commit: B } })).toEqual([]);
    expect(moved({ 'sf-flow': { ref: 'v1.0.0', commit: 'short' } })).toEqual([]);
  });

  it('reports a name the lock no longer lists with now null', () => {
    addSkill('acme-flow', { 'sf-flow': { ref: 'v1.0.0', commit: A } });
    expect(moved({ 'sf-apex': { ref: 'v1.0.0', commit: A } })).toEqual([{ id: 'L-1', name: 'sf-flow', was: { ref: 'v1.0.0', commit: A }, now: null }]);
  });

  it('does not report an unchanged ref and commit', () => {
    addSkill('acme-flow', { 'sf-flow': { ref: 'v1.0.0', commit: A } });
    expect(moved({ 'sf-flow': { ref: 'v1.0.0', commit: A } })).toEqual([]);
  });

  it('does not report an item without metrics.packs', () => {
    addSkill('acme-flow', null, ago(1), 'sf-flow');
    expect(moved({ 'sf-flow': { ref: 'v9.0.0', commit: B } })).toEqual([]);
  });

  it('does not report a rolled-back, retired or undone skill', () => {
    addSkill('acme-one', { 'sf-flow': { ref: 'v1.0.0', commit: A } });
    addSkill('acme-two', { 'sf-flow': { ref: 'v1.0.0', commit: A } });
    addSkill('acme-three', { 'sf-flow': { ref: 'v1.0.0', commit: A } });
    undoItem(dir, 'L-1', { by: 'foreman', action: 'rollback' });
    undoItem(dir, 'L-2', { by: 'foreman', action: 'rollback', metrics: { decision: 'retire' } });
    undoItem(dir, 'L-3', { by: 'owner' });
    expect(moved({ 'sf-flow': { ref: 'v1.1.0', commit: B } })).toEqual([]);
  });

  it('reads the version in force, not v1', () => {
    addSkill('acme-flow', { 'sf-flow': { ref: 'v1.0.0', commit: A } });
    updateItem(dir, 'L-1', { text: skillText('sf-flow'), reason: 'Acme', metrics: { packs: { 'sf-flow': { ref: 'v1.1.0', commit: B } } } }, ago(0));
    expect(moved({ 'sf-flow': { ref: 'v1.1.0', commit: B } })).toEqual([]);
    undoItem(dir, 'L-1', { by: 'owner' });
    expect(moved({ 'sf-flow': { ref: 'v1.1.0', commit: B } })).toEqual([{ id: 'L-1', name: 'sf-flow', was: { ref: 'v1.0.0', commit: A }, now: { ref: 'v1.1.0', commit: B } }]);
  });

  it('returns nothing with no lock', () => {
    addSkill('acme-flow', { 'sf-flow': { ref: 'v1.0.0', commit: A } });
    expect(moved(undefined)).toEqual([]);
  });
});

describe('learningStatus', () => {
  const status = (learning = {}, spentToday = 0) => learningStatus({ learning: { ...DEFAULTS.learning, ...learning }, ledger: readLedger(dir), spentToday, now: NOW });

  it('reads auto and apply from the learning block, with the defaults when it is missing', () => {
    expect(status()).toMatchObject({ auto: true, apply: true });
    expect(status({ auto: false })).toMatchObject({ auto: false, apply: true });
    expect(status({ apply: false })).toMatchObject({ auto: true, apply: false });
    expect(learningStatus({ ledger: [], spentToday: 0, now: NOW })).toMatchObject({ auto: true, apply: true });
  });

  it('counts the items in force and those on trial', () => {
    addTrait('developer');
    addTrait('tester');
    addSkill('acme-flow', null);
    keepItem(dir, 'L-2');
    undoItem(dir, 'L-3', { by: 'owner' });
    expect(status()).toMatchObject({ active: 2, evaluating: 1 });
  });

  it('counts rollbacks and refusals in the last 7 days only, and a retire is not a rollback', () => {
    addTrait('developer', ago(9));
    addTrait('tester', ago(9));
    addTrait('reviewer', ago(9));
    undoItem(dir, 'L-1', { ...ago(8), by: 'foreman', action: 'rollback' });
    undoItem(dir, 'L-2', { ...ago(1), by: 'foreman', action: 'rollback' });
    undoItem(dir, 'L-3', { ...ago(1), by: 'foreman', action: 'rollback', metrics: { decision: 'retire' } });
    refuseItem(dir, { kind: 'trait', roles: ['developer'], reason: 'Acme cap' }, ago(2));
    refuseItem(dir, { kind: 'trait', roles: ['developer'], reason: 'Acme cap' }, ago(10));
    expect(status()).toMatchObject({ rolledBack7d: 1, refused7d: 1 });
  });

  describe('caps', () => {
    it('lists on trial at maxEvaluating', () => {
      addTrait('developer', ago(2));
      addTrait('tester', ago(2));
      expect(status({ maxEvaluating: 2 }).caps).toEqual([{ label: 'on trial', n: 2, max: 2 }]);
    });

    it('lists a role at maxPerRole', () => {
      for (let i = 0; i < 8; i++) addTrait('builder', ago(2));
      expect(status({ maxEvaluating: 99 }).caps).toEqual([{ label: 'builder traits', n: 8, max: 8 }]);
    });

    it('lists learned skills at maxSkills', () => {
      addSkill('acme-one', null, ago(2));
      addSkill('acme-two', null, ago(2));
      expect(status({ maxSkills: 2, maxEvaluating: 99 }).caps).toEqual([{ label: 'learned skills', n: 2, max: 2 }]);
    });

    it("counts only Foreman's add and update lines from today against maxPerDay", () => {
      addTrait('developer', { now: new Date('2026-10-25T01:00:00Z') });
      addTrait('tester', { now: new Date('2026-10-25T02:00:00Z') });
      updateItem(dir, 'L-1', { text: 'Acme: a newer rule' }, { now: new Date('2026-10-25T03:00:00Z') });
      addItem(dir, { kind: 'trait', roles: ['reviewer'], text: 'Acme: by the owner' }, { now: new Date('2026-10-25T04:00:00Z'), by: 'owner' });
      addTrait('architect', { now: new Date('2026-10-24T23:00:00Z') });
      expect(status({ maxEvaluating: 99, maxPerDay: 3 }).caps).toEqual([{ label: 'changes today', n: 3, max: 3 }]);
      expect(status({ maxEvaluating: 99, maxPerDay: 4 }).caps).toEqual([]);
    });

    it('lists the learner spend at maxUsdPerDay', () => {
      expect(status({ maxUsdPerDay: 2 }, 2).caps).toEqual([{ label: 'learner spend today', n: 2, max: 2 }]);
      expect(status({ maxUsdPerDay: 2 }, 1.99).caps).toEqual([]);
    });

    it('counts a cap of 0 as reached', () => {
      expect(status({ maxSkills: 0 }).caps).toEqual([{ label: 'learned skills', n: 0, max: 0 }]);
    });

    it('lists the caps in order, and nothing when none is reached', () => {
      expect(status().caps).toEqual([]);
      addTrait('tester', ago(0));
      addTrait('developer', ago(0));
      addSkill('acme-one', null, ago(0));
      expect(status({ maxPerRole: 1, maxSkills: 1, maxEvaluating: 3, maxPerDay: 3, maxUsdPerDay: 1 }, 1).caps.map((c) => c.label)).toEqual(['developer traits', 'tester traits', 'learned skills', 'on trial', 'changes today', 'learner spend today']);
    });
  });
});

describe('learningTotals', () => {
  const call = (at, costUsd) => ({ at, key: 'f-000000000001', model: 'haiku', costUsd, verdict: 'trait', error: null, tokens: null });
  const seed = () => {
    addTrait('developer', { now: new Date('2026-10-20T09:00:00Z') });
    addTrait('tester', { now: new Date('2026-10-21T09:00:00Z') });
    addTrait('reviewer', { now: new Date('2026-10-22T09:00:00Z') });
    keepItem(dir, 'L-1', { now: new Date('2026-10-22T10:00:00Z') });
    undoItem(dir, 'L-2', { now: new Date('2026-10-23T09:00:00Z'), by: 'foreman', action: 'rollback' });
    undoItem(dir, 'L-3', { now: new Date('2026-10-23T10:00:00Z'), by: 'foreman', action: 'rollback', metrics: { decision: 'retire' } });
    undoItem(dir, 'L-1', { now: new Date('2026-10-24T09:00:00Z'), by: 'owner' });
  };
  const calls = [call('2026-10-20T08:00:00Z', 0.1), call('2026-10-23T08:00:00Z', 0.2), call('2026-10-24T08:00:00Z', 0.1000004)];

  it('counts each action, a retire as retired and not rolled back', () => {
    seed();
    expect(learningTotals({ ledger: readLedger(dir), calls, since: '' })).toEqual({ calls: 3, costUsd: 0.4, added: 3, kept: 1, rolledBack: 1, retired: 1, undone: 1 });
  });

  it('drops ledger lines and calls before --since', () => {
    seed();
    expect(learningTotals({ ledger: readLedger(dir), calls, since: '2026-10-23' })).toEqual({ calls: 2, costUsd: 0.3, added: 0, kept: 0, rolledBack: 1, retired: 1, undone: 1 });
  });

  it('sums the cost and rounds it', () => {
    const t = learningTotals({ ledger: [], calls: [call('2026-10-20T08:00:00Z', 0.1), call('2026-10-20T09:00:00Z', 0.2)], since: '' });
    expect(t.costUsd).toBe(0.3);
    expect(learningTotals({ ledger: [], calls: [], since: '' })).toEqual({ calls: 0, costUsd: 0, added: 0, kept: 0, rolledBack: 0, retired: 0, undone: 0 });
  });
});
