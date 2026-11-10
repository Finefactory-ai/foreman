// The checks every console adapter must pass. An adapter's own test file calls
// consoleContract({ name, make }) to register them. `make()` builds a fresh console over an
// empty state folder, touching no network.
//
//   publish(snapshot)                 state out
//   controls() -> control             pause, workers, slot actions, fixed, hand-back, next story
//   decisions.add(item) -> id · decisions.pending() -> item[] · decisions.applied(id)

import { describe, expect, it } from 'vitest';

const snap = { updatedAt: '2026-10-15T09:00:00.000Z', loop: { state: 'running', since: null, reason: '' }, workers: 1, slots: [], events: [], recent: [] };

export function consoleContract({ name, make }) {
  describe(`console contract: ${name}`, () => {
    it('publish takes a snapshot', async () => {
      await make().publish(snap); // a rejection fails the test
    });
    it('controls answer an object, empty before the owner has done anything', async () => {
      const c = await make().controls();
      expect(c && typeof c === 'object' && !Array.isArray(c)).toBe(true);
    });
    it('a decision added is pending, with no answer, until applied', async () => {
      const con = make();
      const id = await con.decisions.add({ story: 'S-1', kind: 'decision', title: 'S-1 could not pass review', options: ['Retry', 'Drop'] });
      expect(typeof id).toBe('string');
      const items = await con.decisions.pending();
      expect(items.map((i) => i.id)).toEqual([id]);
      expect(items[0]).toMatchObject({ story: 'S-1', kind: 'decision', title: 'S-1 could not pass review', options: ['Retry', 'Drop'], answer: null });
      await con.decisions.applied(id);
      expect(await con.decisions.pending()).toEqual([]);
    });
  });
}
