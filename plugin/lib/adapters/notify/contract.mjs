// The checks every notifier adapter must pass. An adapter's own test file calls
// notifierContract({ name, make }) to register them. `make()` builds a fresh notifier that
// can send without touching the network or the real state folder.

import { describe, expect, it } from 'vitest';

export function notifierContract({ name, make }) {
  describe(`notifier contract: ${name}`, () => {
    it('send answers { sent: boolean } and a reason when not sent', async () => {
      const r = await make().send({ kind: 'stopped', subject: 'Factory stopped', text: 't', html: '<p>t</p>' });
      expect(typeof r.sent).toBe('boolean');
      if (!r.sent) expect(typeof r.reason).toBe('string');
    });
    it('never throws for an ordinary email', async () => {
      await expect(make().send({ kind: 'blocked', subject: 's', text: 't', html: 'h' })).resolves.toBeTypeOf('object');
    });
  });
}
