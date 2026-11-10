import { describe, expect, it } from 'vitest';
import { groupSummaryWork, hasWork, movable, ownsLock, peekWork, pickFirst, rehome, slotLockFiles, slotNumber, takeable, takeWork } from './slot-work.mjs';

describe('takeWork', () => {
  it('takes work meant for the slot before work meant for any slot', () => {
    const queue = [{ slot: null, id: 'A' }, { slot: 'w2', id: 'B' }];
    expect(takeWork(queue, 'w2')).toEqual({ slot: 'w2', id: 'B' });
    expect(queue).toEqual([{ slot: null, id: 'A' }]);
  });
  it('treats a missing slot as any slot', () => {
    const queue = [{ id: 'A' }, { slot: undefined, id: 'B' }];
    expect(hasWork(queue, 'w1')).toBe(true);
    expect(takeWork(queue, 'w1').id).toBe('A');
    expect(takeWork(queue, 'w3').id).toBe('B');
    expect(queue).toEqual([]);
  });
  it('leaves another slot\'s work alone', () => {
    const queue = [{ slot: 'w1', id: 'A' }];
    expect(hasWork(queue, 'w2')).toBe(false);
    expect(takeWork(queue, 'w2')).toBeNull();
    expect(queue).toHaveLength(1);
  });
});

describe('peekWork', () => {
  it('returns what takeWork would take and leaves the queue as it was', () => {
    for (const [queue, slot] of [
      [[{ slot: null, id: 'A' }, { slot: 'w2', id: 'B' }], 'w2'],
      [[{ slot: 'w1', id: 'A' }, { slot: null, id: 'B' }, { id: 'C' }], 'w3'],
      [[{ slot: 'w1', id: 'A' }], 'w2'],
      [[], 'w1'],
    ]) {
      const copy = structuredClone(queue);
      const peeked = peekWork(queue, slot);
      expect(queue).toEqual(copy);
      expect(takeWork(queue, slot)).toEqual(peeked);
    }
  });
  it('is the pinned work first, else the first for any slot, else null', () => {
    const queue = [{ slot: null, id: 'A' }, { slot: 'w2', id: 'B' }];
    expect(peekWork(queue, 'w2').id).toBe('B');
    expect(peekWork(queue, 'w1').id).toBe('A');
    expect(peekWork([{ slot: 'w1', id: 'A' }], 'w2')).toBeNull();
  });
});

describe('pickFirst', () => {
  const stories = [{ id: 'ACME-1', order: 0 }, { id: 'ACME-2', order: 2 }, { id: 'ACME-3', order: 1 }];
  const ranked = (id) => ({ slot: null, id, mode: '', ranked: true });
  it('is true for ranked work whose rival has a better order', () => {
    expect(pickFirst(ranked('ACME-3'), stories[0], stories)).toBe(true);
  });
  it('is true on the same order when the rival id number is lower', () => {
    const same = [{ id: 'ACME-1', order: 1 }, { id: 'ACME-3', order: 1 }];
    expect(pickFirst(ranked('ACME-3'), same[0], same)).toBe(true);
    expect(pickFirst(ranked('ACME-1'), same[1], same)).toBe(false);
  });
  it('is false for a worse rival', () => {
    expect(pickFirst(ranked('ACME-3'), stories[1], stories)).toBe(false);
  });
  it('is false for work that is not ranked', () => {
    expect(pickFirst({ slot: null, id: 'ACME-3', mode: '' }, stories[0], stories)).toBe(false);
    expect(pickFirst({ slot: null, id: 'ACME-3', mode: '', ranked: false }, stories[0], stories)).toBe(false);
    expect(pickFirst(null, stories[0], stories)).toBe(false);
  });
  it('is false with no rival or a rival with the same id', () => {
    expect(pickFirst(ranked('ACME-3'), null, stories)).toBe(false);
    expect(pickFirst(ranked('ACME-3'), stories[2], stories)).toBe(false);
  });
  it('is false when the queued story is missing from the list', () => {
    expect(pickFirst(ranked('ACME-9'), stories[0], stories)).toBe(false);
  });
});

describe('slotLockFiles', () => {
  it('names the schema token and every configured resource, once each', () => {
    expect(slotLockFiles('/s', { resources: { db: {}, schema: {}, queue: {} } })).toEqual([
      '/s/locks/schema.json',
      '/s/locks/resource-db.json',
      '/s/locks/resource-queue.json',
    ]);
    expect(slotLockFiles('/s', {})).toEqual(['/s/locks/schema.json']);
  });
});

describe('ownsLock', () => {
  it('is the slot\'s when this supervisor holds it, or a dead one did', () => {
    expect(ownsLock({ slot: 'w1', pid: 7, stale: false }, 'w1', 7)).toBe(true);
    expect(ownsLock({ slot: 'w1', pid: 9, stale: true }, 'w1', 7)).toBe(true);
  });
  it('is not when another slot or a live other process holds it', () => {
    expect(ownsLock({ slot: 'w2', pid: 7, stale: false }, 'w1', 7)).toBe(false);
    expect(ownsLock({ slot: 'w1', pid: 9, stale: false }, 'w1', 7)).toBe(false);
    expect(ownsLock(null, 'w1', 7)).toBe(false);
  });
});

describe('groupSummaryWork', () => {
  const source = (needed) => ({ groupSummary: () => ({ path: 'x.md', needed }) });
  const groupOf = (id) => ({ A: 'g1', B: 'g1', C: 'g2' })[id];

  it('queues the summary when the source says it is needed', () => {
    expect(groupSummaryWork({ source: source(true), group: 'g1', slot: 'w1', id: 'A', queue: [], running: [], groupOf })).toEqual({ slot: 'w1', id: 'A', mode: 'group-summary' });
  });
  it('queues nothing when it is not needed or the source has no summaries', () => {
    expect(groupSummaryWork({ source: source(false), group: 'g1', slot: 'w1', id: 'A', queue: [], running: [], groupOf })).toBeNull();
    expect(groupSummaryWork({ source: {}, group: 'g1', slot: 'w1', id: 'A', queue: [], running: [], groupOf })).toBeNull();
  });
  it('queues once when two slots finish the last two stories of a group', () => {
    const queue = [];
    const first = groupSummaryWork({ source: source(true), group: 'g1', slot: 'w1', id: 'A', queue, running: [], groupOf });
    queue.push(first);
    expect(groupSummaryWork({ source: source(true), group: 'g1', slot: 'w2', id: 'B', queue, running: [], groupOf })).toBeNull();
  });
  it('does not queue while a summary for the group is running, but does for another group', () => {
    const running = [{ id: 'A', mode: 'group-summary' }];
    expect(groupSummaryWork({ source: source(true), group: 'g1', slot: 'w2', id: 'B', queue: [], running, groupOf })).toBeNull();
    expect(groupSummaryWork({ source: source(true), group: 'g2', slot: 'w2', id: 'C', queue: [], running, groupOf })).not.toBeNull();
  });
});

describe('slotNumber', () => {
  it('reads the number of a slot id, and gives null for anything else', () => {
    expect(slotNumber('w3')).toBe(3);
    expect(slotNumber('w12')).toBe(12);
    for (const bad of ['w0', 'x', null, undefined, 'w1x', 'W1', 3, 'w01']) expect(slotNumber(bad)).toBeNull();
  });
});

describe('rehome', () => {
  const queue = () => [{ slot: 'w4', id: 'A', resume: true }, { slot: 'w2', id: 'B' }, { slot: null, id: 'C' }, { slot: 'w5', id: 'D', mode: 'group-summary' }];

  it('sets work pinned above the worker count free, remembering where it was pinned', () => {
    const q = queue();
    expect(rehome(q, 3)).toEqual([{ id: 'A', from: 'w4' }, { id: 'D', from: 'w5' }]);
    expect(q[0]).toEqual({ slot: null, id: 'A', resume: true, from: 'w4' });
    expect(q[1]).toEqual({ slot: 'w2', id: 'B' });
    expect(q[2]).toEqual({ slot: null, id: 'C' });
    expect(q[3]).toEqual({ slot: null, id: 'D', mode: 'group-summary', from: 'w5' });
  });
  it('moves nothing the second time', () => {
    const q = queue();
    rehome(q, 3);
    expect(rehome(q, 3)).toEqual([]);
  });
  it('rehomes a slot that is not a slot id, and leaves a missing slot alone', () => {
    const q = [{ slot: 'w9', id: 'A' }, { slot: 'x', id: 'B' }, { id: 'C' }];
    expect(rehome(q, 3)).toEqual([{ id: 'A', from: 'w9' }, { id: 'B', from: 'x' }]);
    expect(q[2]).toEqual({ id: 'C' });
  });
  it('leaves work alone when every slot is under the count', () => {
    const q = [{ slot: 'w3', id: 'A' }];
    expect(rehome(q, 3)).toEqual([]);
    expect(q[0].slot).toBe('w3');
  });
  it('lets a slot under the limit take work that was queued for w4 (the story reproduction)', () => {
    const q = [{ slot: 'w4', id: 'A', resume: true }];
    expect(hasWork(q, 'w1')).toBe(false);
    rehome(q, 3);
    expect(hasWork(q, 'w1')).toBe(true);
    expect(takeWork(q, 'w1')).toEqual({ slot: null, id: 'A', resume: true, from: 'w4' });
  });
});

describe('takeable', () => {
  it('counts the work some slot under the limit may take', () => {
    expect(takeable([{ slot: 'w4' }], 3)).toBe(0);
    expect(takeable([{ slot: 'w2' }], 3)).toBe(1);
    expect(takeable([{}], 3)).toBe(1);
    expect(takeable([{ slot: 'w4' }, { slot: null }], 3)).toBe(1);
    expect(takeable([{ slot: 'x' }], 3)).toBe(0);
    expect(takeable([], 3)).toBe(0);
  });
});

describe('movable', () => {
  const ours = (pid) => pid === 7;
  const args = { from: 'w4', id: 'ACME-1', ours };
  it("is true for the factory's own holder under the slot it left, and for a stale one", () => {
    expect(movable({ slot: 'w4', pid: 7, story: 'ACME-1', by: 'factory' }, args)).toBe(true);
    expect(movable({ slot: 'w4', pid: 99, stale: true, by: 'factory', story: 'ACME-1' }, args)).toBe(true);
    expect(movable({ slot: 'w4', pid: 7 }, args)).toBe(true);
  });
  it("is false for the owner's claim, another slot, another story, a live pid that is not ours and no holder", () => {
    expect(movable({ slot: 'w4', pid: 7, by: 'owner' }, args)).toBe(false);
    expect(movable({ slot: 'w2', pid: 7 }, args)).toBe(false);
    expect(movable({ slot: 'w4', pid: 7, story: 'ACME-2' }, args)).toBe(false);
    expect(movable({ slot: 'w4', pid: 99 }, args)).toBe(false);
    expect(movable(null, args)).toBe(false);
  });
});
