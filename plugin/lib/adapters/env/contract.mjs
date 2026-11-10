// The checks every slot environment adapter must pass. An adapter's own test file calls
// envAdapterContract({ name, make }) to register them. `make()` builds a fresh adapter. Its
// prepare(n, path) may answer a state now or a promise of one, an optional repair() may
// answer a boolean now or a promise of one, and an optional sweep() may answer { warnings }
// now or a promise of it (engine/slot-prepare.mjs).

import { describe, expect, it } from 'vitest';

const STATES = ['up', 'restarted', 'reset', 'down'];

export function envAdapterContract({ name, make }) {
  describe(`env adapter contract: ${name}`, () => {
    it('env(n) returns string values and names the slot', () => {
      const env = make().env(2);
      expect(env.FOREMAN_SLOT).toBe('w2');
      for (const [k, v] of Object.entries(env)) {
        expect(typeof k).toBe('string');
        expect(typeof v).toBe('string');
      }
    });
    it('prepare returns one of the four states, or a promise of one', async () => {
      expect(STATES).toContain(await make().prepare(1, process.cwd()));
    });
    it('repair, sweep and hostedEnv are functions when present', () => {
      const a = make();
      if ('repair' in a) expect(typeof a.repair).toBe('function');
      if ('sweep' in a) expect(typeof a.sweep).toBe('function');
      if ('hostedEnv' in a) {
        expect(typeof a.hostedEnv).toBe('function');
        const out = a.hostedEnv({ FOREMAN_SLOT: 'w1', PATH: '/bin' });
        expect(out && typeof out).toBe('object');
      }
    });
  });
}
