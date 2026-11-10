import { describe, expect, it } from 'vitest';
import { PACKS, packCommands, packFor, packNames } from './index.mjs';
import { fakePack } from '../../test/fake-pack.mjs';

describe('packFor', () => {
  const packs = { acme: fakePack() };
  it('returns null when the config names no pack', () => {
    expect(packFor({}, packs)).toBeNull();
    expect(packFor(undefined, packs)).toBeNull();
    expect(packFor(null)).toBeNull();
  });
  it('returns the named pack', () => {
    expect(packFor({ pack: 'acme' }, packs)).toBe(packs.acme);
  });
  it('throws for a pack that is not registered', () => {
    expect(() => packFor({ pack: 'x' }, packs)).toThrow('unknown pack: x');
    expect(() => packFor({ pack: 'toString' }, packs)).toThrow('unknown pack: toString');
    expect(() => packFor({ pack: 'acme' })).toThrow('unknown pack: acme');
  });
});

describe('packNames', () => {
  it('lists the names, sorted', () => {
    expect(packNames({ zeta: fakePack({ name: 'zeta' }), acme: fakePack() })).toEqual(['acme', 'zeta']);
    expect(packNames()).toEqual(Object.keys(PACKS).sort());
  });
});

describe('packCommands', () => {
  it('flattens the commands of every pack, in name order', () => {
    const a = { name: 'a', summary: 'a', run: () => 0 };
    const z = { name: 'z', summary: 'z', run: () => 0 };
    expect(packCommands({ zeta: fakePack({ name: 'zeta', commands: [z] }), acme: fakePack({ commands: [a] }) })).toEqual([a, z]);
  });
  it('is [] when no pack has commands', () => {
    expect(packCommands({ acme: fakePack() })).toEqual([]);
    expect(packCommands({})).toEqual([]);
  });
  it('includes the salesforce sf command', () => {
    expect(packCommands().map((c) => c.name)).toContain('sf');
  });
});

describe('PACKS', () => {
  it('is frozen', () => expect(Object.isFrozen(PACKS)).toBe(true));
  it('names each pack by its key, and each one checks its own block', () => {
    for (const [key, pack] of Object.entries(PACKS)) {
      expect(pack.name).toBe(key);
      expect(typeof pack.checkConfig).toBe('function');
      if (pack.guard !== undefined) expect(typeof pack.guard).toBe('function');
    }
  });
});
