import { describe, expect, it } from 'vitest';
import { fingerprint } from './sync.mjs';

describe('whether anything changed', () => {
  const snap = (quietFor, stage) => ({
    updatedAt: String(quietFor),
    slots: [{ id: 'w1', state: 'building', story: { id: 'P5-04', stage }, agents: [{ id: 'a', role: 'developer', quietFor }] }],
  });
  it('ignores the clock and how long agents have been quiet', () => {
    expect(fingerprint(snap(1, 'build'))).toBe(fingerprint(snap(7, 'build')));
  });
  it('sees a real change in a slot', () => {
    expect(fingerprint(snap(1, 'build'))).not.toBe(fingerprint(snap(1, 'test')));
  });
  it('copes with a snapshot that has no slots', () => {
    expect(() => fingerprint({ updatedAt: 'x' })).not.toThrow();
  });
});
