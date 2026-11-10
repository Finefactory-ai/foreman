import { describe, expect, it } from 'vitest';
import { repeatGate } from './repeats.mjs';

const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const t = (min) => new Date(2026, 9, 24, 23, min);

describe('repeatGate', () => {
  it('passes the first occurrence of a text on', () => {
    expect(repeatGate().seen('Supervisor error: boom', t(1))).toEqual(['Supervisor error: boom']);
  });

  it('logs a repeated text once, then its count when it clears', () => {
    const g = repeatGate();
    const text = 'Supervisor error: cannot open stories: bogus: unknown key';
    expect(g.seen(text, t(49))).toEqual([text]);
    expect(g.seen(text, t(50))).toEqual([]);
    expect(g.seen(text, t(51))).toEqual([]);
    expect(g.clear(t(52))).toEqual([`${text} (3 times since ${hhmm(t(49))})`]);
  });

  it('says nothing more when a text was seen once', () => {
    const g = repeatGate();
    g.seen('Supervisor error: once', t(1));
    expect(g.clear(t(2))).toEqual([]);
  });

  it('closes the old count when a different text comes', () => {
    const g = repeatGate();
    g.seen('Supervisor error: a', t(10));
    g.seen('Supervisor error: a', t(11));
    expect(g.seen('Supervisor error: b', t(12))).toEqual([`Supervisor error: a (2 times since ${hhmm(t(10))})`, 'Supervisor error: b']);
    expect(g.clear(t(13))).toEqual([]);
  });

  it('clears to nothing when nothing is open', () => {
    expect(repeatGate().clear(t(1))).toEqual([]);
  });
});
