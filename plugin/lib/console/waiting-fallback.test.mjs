import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildWaiting } from './waiting.mjs';

// No real story list gives an owner task that blocks stories but has no direct waiter, so only
// waitersOf is swapped: 'empty' gives each id an empty list, 'missing' gives no entry at all.
// freedBy calls the real waitersOf inside pick.mjs, so frees is still the real one.
// vi.mock is hoisted, hence its own file.
const mode = vi.hoisted(() => ({ value: 'empty' }));

vi.mock('../engine/pick.mjs', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    waitersOf: (stories, ids) => (mode.value === 'empty' ? new Map(ids.map((id) => [id, []])) : new Map()),
  };
});

const s = (id, over = {}) => ({ id, title: `Story ${id}`, status: 'todo', dependsOn: [], blockedBy: '', ownerTask: false, ...over });
const stories = (...extra) => [
  s('ACME-1', { ownerTask: true }),
  s('ACME-2', { dependsOn: ['ACME-1', 'ACME-3'] }),
  s('ACME-3'),
  ...extra,
];
const build = (list) => buildWaiting({ decisions: { source: 'files', items: [] }, stories: list, idPattern: 'ACME-\\d+' });
const task = (items) => items.find((i) => i.id === 'task:ACME-1');

beforeEach(() => {
  mode.value = 'empty';
});

describe('an owner task that blocks stories but has no direct waiter', () => {
  it('says how many stories wait on it when its waiter list is empty', () => {
    const item = task(build(stories()));
    expect(item).toMatchObject({ why: '1 story waits on it.', blocks: ['ACME-2'], frees: [], group: 'now' });
  });

  it('says the same when it has no waiter entry at all', () => {
    mode.value = 'missing';
    const item = task(build(stories()));
    expect(item).toMatchObject({ why: '1 story waits on it.', blocks: ['ACME-2'], frees: [], group: 'now' });
  });

  it('counts in the plural', () => {
    const item = task(build(stories(s('ACME-4', { dependsOn: ['ACME-2'] }))));
    expect(item).toMatchObject({ why: '2 stories wait on it.', blocks: ['ACME-2', 'ACME-4'], frees: [], group: 'now' });
  });
});
