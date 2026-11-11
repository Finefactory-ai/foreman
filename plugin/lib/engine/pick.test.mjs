import { describe, expect, it } from 'vitest';
import { blockedNow, buildOrder, byPriority, dependentsOf, eligible, freedBy, needsExclusive, nextStory, progress, waitersOf, waitsOnStories } from './pick.mjs';

const ID = '[A-Z]+-\\d+';
const s = (id, over = {}) => ({
  id, title: `Story ${id}`, ref: '', status: 'todo', group: '', groupName: '', order: 0,
  dependsOn: [], blockedBy: '', ownerTask: false, resources: [], ...over,
});

describe('plain ids', () => {
  it('picks a story with no group, and waits for dependsOn', () => {
    const list = [s('S-1'), s('S-2', { dependsOn: ['S-1'] })];
    expect(nextStory(list, { idPattern: ID }).id).toBe('S-1');
    expect(eligible(list, { idPattern: ID }).map((x) => x.id)).toEqual(['S-1']);
    expect(nextStory([{ ...list[0], status: 'done' }, list[1]], { idPattern: ID }).id).toBe('S-2');
  });

  it('orders in-progress first, then group order, then the number, then the id', () => {
    const list = [s('S-10', { order: 1 }), s('S-2', { order: 1 }), s('S-30', { order: 2 }), s('S-40', { order: 3, status: 'in-progress' })];
    expect(eligible(list, { idPattern: ID }).map((x) => x.id)).toEqual(['S-40', 'S-2', 'S-10', 'S-30']);
  });
});

describe('byPriority', () => {
  it('sorts by order, then the number at the end of the id, then the id', () => {
    const list = [s('S-10', { order: 1 }), s('S-2', { order: 1 }), s('S-30', { order: 0 }), s('T-2', { order: 1 })];
    expect([...list].sort(byPriority).map((x) => x.id)).toEqual(['S-30', 'S-2', 'T-2', 'S-10']);
  });
  it('ignores status: an in-progress story with order 2 sorts after a todo with order 1', () => {
    const list = [s('S-1', { order: 2, status: 'in-progress' }), s('S-2', { order: 1 })];
    expect([...list].sort(byPriority).map((x) => x.id)).toEqual(['S-2', 'S-1']);
  });
  it('leaves eligible putting In Progress first', () => {
    const list = [s('S-1', { order: 2, status: 'in-progress' }), s('S-2', { order: 1 })];
    expect(eligible(list, { idPattern: ID }).map((x) => x.id)).toEqual(['S-1', 'S-2']);
  });
});

describe('idPattern', () => {
  it('recognises ids in blockedBy with the given pattern', () => {
    const list = [s('A.1', { status: 'done' }), s('A.2', { status: 'blocked', blockedBy: 'A.1 must land first' })];
    expect(nextStory(list, { idPattern: 'A\\.\\d+' }).id).toBe('A.2');
    expect(waitsOnStories('A.1 first', { idPattern: 'A\\.\\d+' })).toBe(true);
    expect(waitsOnStories('Waits on A.1', { idPattern: 'A\\.\\d+' })).toBe(false);
    expect(buildOrder(list, { idPattern: 'A\\.\\d+' }).order).toEqual(['A.2']);
  });
});

describe('buildOrder labels', () => {
  it('names a missing story, an owner task, and a known dependency outside the source', () => {
    const list = [
      s('S-1', { ownerTask: true }),
      s('S-2', { dependsOn: ['S-1', 'S-9', 'OLD-4'], externalDeps: { 'OLD-4': 'not done' } }),
    ];
    const { waiting } = buildOrder(list, { idPattern: ID });
    expect(waiting).toEqual([{ id: 'S-2', title: 'Story S-2', on: ['S-1 (owner task)', 'S-9 (no such story)', 'OLD-4 (outside the filter, not done)'] }]);
  });
});

describe('idPattern is required', () => {
  it('throws instead of guessing', () => {
    expect(() => nextStory([])).toThrow('idPattern is required');
    expect(() => eligible([])).toThrow('idPattern is required');
    expect(() => buildOrder([])).toThrow('idPattern is required');
    expect(() => waitsOnStories('S-1 first')).toThrow('idPattern is required');
  });
});

describe('needsExclusive', () => {
  it('is true for stories with resources and for extra ids', () => {
    expect(needsExclusive(s('S-1', { resources: ['schema'] }))).toBe(true);
    expect(needsExclusive(s('S-1'))).toBe(false);
    expect(needsExclusive(s('S-1'), ['S-1'])).toBe(true);
  });
});

describe('a ready-to-promote story', () => {
  const list = [s('S-1', { status: 'ready-to-promote' }), s('S-2', { dependsOn: ['S-1'] })];

  it('is never picked again, not even by an explicit id with strict', () => {
    expect(nextStory([list[0]], { idPattern: ID })).toBeNull();
    expect(eligible(list, { idPattern: ID }).map((x) => x.id)).toEqual([]);
    expect(nextStory(list, { id: 'S-1', strict: true, idPattern: ID })).toBeNull();
  });

  it('keeps the stories that depend on it waiting', () => {
    expect(eligible(list, { idPattern: ID }).map((x) => x.id)).not.toContain('S-2');
    expect(buildOrder(list, { idPattern: ID }).waiting.find((w) => w.id === 'S-2')).toEqual({ id: 'S-2', title: 'Story S-2', on: ['S-1'] });
  });

  it('counts in the total but not as done', () => {
    expect(progress(list)).toMatchObject({ done: 0, total: 2 });
  });
});

describe('progress', () => {
  it('has byGroup with group and name, and leaves retired out', () => {
    const p = progress([s('S-1', { group: 'a', groupName: 'Alpha', status: 'done' }), s('S-2', { group: 'a', groupName: 'Alpha', status: 'retired' })]);
    expect(p).toMatchObject({ done: 1, total: 1, byGroup: [{ group: 'a', name: 'Alpha', done: 1, total: 1 }] });
  });
});

describe('dependentsOf', () => {
  it('lists the open stories that wait on an id, directly or through other stories', () => {
    const list = [
      s('S-1', { ownerTask: true }),
      s('S-2', { dependsOn: ['S-1'] }),
      s('S-3', { dependsOn: ['S-2'] }),
      s('S-4', { status: 'blocked', blockedBy: 'S-1 must land first' }),
      s('S-5', { status: 'done', dependsOn: ['S-1'] }),
    ];
    expect(dependentsOf(list, ['S-1'], { idPattern: ID }).get('S-1')).toEqual(['S-2', 'S-3', 'S-4']);
  });

  it('leaves out an owner task that depends on the id', () => {
    const list = [s('S-1', { ownerTask: true }), s('S-2', { ownerTask: true, dependsOn: ['S-1'] })];
    expect(dependentsOf(list, ['S-1'], { idPattern: ID }).get('S-1')).toEqual([]);
  });

  it('ends on a cycle, and never lists the start id', () => {
    const list = [s('S-1', { ownerTask: true }), s('S-2', { dependsOn: ['S-1', 'S-3'] }), s('S-3', { dependsOn: ['S-2'] })];
    const map = dependentsOf(list, ['S-1', 'S-2'], { idPattern: ID });
    expect(map.get('S-1')).toEqual(['S-2', 'S-3']);
    expect(map.get('S-2')).toEqual(['S-3']);
  });

  it('needs the id pattern', () => {
    expect(() => dependentsOf([], ['S-1'], {})).toThrow('idPattern is required');
  });
});

describe('freedBy', () => {
  const freed = (list, id = 'S-1') => freedBy(list, [id], { idPattern: ID }).get(id);

  it('one open blocker is freed', () => {
    const list = [
      s('S-1', { ownerTask: true }),
      s('S-2', { dependsOn: ['S-1'] }),
      s('S-9', { status: 'blocked', blockedBy: 'S-1 must land first' }),
    ];
    expect(freed(list)).toEqual(['S-2', 'S-9']);
  });

  it('two open blockers are not', () => {
    const list = [
      s('S-1', { ownerTask: true }),
      s('S-3', { dependsOn: ['S-1', 'S-4'] }),
      s('S-4'),
      s('S-8', { status: 'blocked', blockedBy: 'S-1, S-4 must land first' }),
    ];
    expect(freed(list)).toEqual([]);
  });

  it('a done blocker outside the filter counts as done', () => {
    const one = (story, more = []) => freed([s('S-1', { ownerTask: true }), story, ...more]);
    expect(one(s('S-2', { dependsOn: ['S-1', 'OLD-4'] }))).toEqual(['S-2']);
    expect(one(s('S-2', { dependsOn: ['S-1', 'OLD-5'], externalDeps: { 'OLD-5': 'not done' } }))).toEqual([]);
    expect(one(s('S-2', { dependsOn: ['S-1', 'S-7'] }), [s('S-7', { status: 'done' })])).toEqual(['S-2']);
  });

  it('owner tasks are never in frees', () => {
    expect(freed([s('S-1', { ownerTask: true }), s('S-2', { ownerTask: true, dependsOn: ['S-1'] })])).toEqual([]);
  });

  it('leaves out a story blocked in words and a done story, and gives [] when nothing waits', () => {
    const list = [
      s('S-1', { ownerTask: true }),
      s('S-2', { status: 'blocked', blockedBy: 'Waiting for the vendor', dependsOn: ['S-1'] }),
      s('S-3', { status: 'done', dependsOn: ['S-1'] }),
      s('S-6'),
    ];
    expect(freed(list)).toEqual([]);
    expect(freed(list, 'S-6')).toEqual([]);
  });

  it('needs the id pattern', () => {
    expect(() => freedBy([], ['S-1'], {})).toThrow('idPattern is required');
  });
});

describe('waitersOf', () => {
  it('lists what waits directly on an id with its other unmet blockers', () => {
    const list = [
      s('S-15', { ownerTask: true }),
      s('S-21', { status: 'done' }),
      s('S-33'),
      s('S-45', { dependsOn: ['S-21', 'S-33', 'S-15'] }),
    ];
    expect(waitersOf(list, ['S-15'], { idPattern: ID }).get('S-15')).toEqual([{ id: 'S-45', on: ['S-33'], inWords: false }]);
  });

  it('marks a story blocked in words, sorts by id, and never lists the id itself', () => {
    const list = [
      s('S-1', { ownerTask: true, dependsOn: ['S-1'] }),
      s('S-10', { dependsOn: ['S-1'] }),
      s('S-2', { status: 'blocked', blockedBy: 'Waiting for the vendor', dependsOn: ['S-1'] }),
      s('S-3', { status: 'blocked', blockedBy: 'S-1 and S-4 must land first', dependsOn: ['S-5', 'S-4'] }),
      s('S-4'),
      s('S-5', { status: 'retired' }),
    ];
    expect(waitersOf(list, ['S-1'], { idPattern: ID }).get('S-1')).toEqual([
      { id: 'S-2', on: [], inWords: true },
      { id: 'S-3', on: ['S-5', 'S-4'], inWords: false },
      { id: 'S-10', on: [], inWords: false },
    ]);
  });

  it('needs the id pattern', () => {
    expect(() => waitersOf([], ['S-1'], {})).toThrow('idPattern is required');
  });
});

describe('blockedNow', () => {
  it('is true for a story blocked in words', () => {
    const list = [s('S-1', { status: 'blocked', blockedBy: 'Deploy failed.' })];
    expect(blockedNow(list[0], list, { idPattern: ID })).toBe(true);
  });
  it('is true for a story blocked on an unfinished story', () => {
    const list = [s('S-1'), s('S-2', { status: 'blocked', blockedBy: 'S-1 must land first' })];
    expect(blockedNow(list[1], list, { idPattern: ID })).toBe(true);
  });
  it('is false once every story it waits on is done', () => {
    const list = [s('S-1', { status: 'done' }), s('S-2', { status: 'blocked', blockedBy: 'S-1 must land first' })];
    expect(blockedNow(list[1], list, { idPattern: ID })).toBe(false);
  });
  it('is false for todo and in-progress stories', () => {
    const list = [s('S-1'), s('S-2', { status: 'in-progress' })];
    expect(blockedNow(list[0], list, { idPattern: ID })).toBe(false);
    expect(blockedNow(list[1], list, { idPattern: ID })).toBe(false);
  });
  it('needs an idPattern', () => {
    const list = [s('S-1')];
    expect(() => blockedNow(list[0], list)).toThrow('idPattern is required');
  });

  it('agrees with nextStory: a blocked story is never picked, even alone and first', () => {
    const inWords = [s('S-1', { status: 'blocked', blockedBy: 'Deploy failed.', order: -1 })];
    const onStory = [s('S-1', { status: 'blocked', blockedBy: 'S-2 must land first', order: -1 }), s('S-2', { status: 'todo', ownerTask: true })];
    for (const list of [inWords, onStory]) {
      expect(nextStory(list, { idPattern: ID })).toBeNull();
      expect(nextStory(list, { id: 'S-1', strict: true, idPattern: ID })).toBeNull();
    }
  });
});
