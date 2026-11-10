import { describe, expect, it } from 'vitest';
import { envAdapterContract } from './contract.mjs';
import { create } from './none.mjs';

const ctx = { root: '/repo', config: {}, sh: () => ({ status: 0, stdout: '' }) };

envAdapterContract({ name: 'none', make: () => create({ adapter: 'none', ports: { UI_PORT: 3000 } }, ctx) });

describe('none adapter', () => {
  it('names the slot and shifts ports by n', () => {
    const a = create({ adapter: 'none', ports: { UI_PORT: 3000, API_PORT: 8000 } }, ctx);
    expect(a.env(2)).toEqual({ FOREMAN_SLOT: 'w2', UI_PORT: '3002', API_PORT: '8002' });
  });
  it('is just the slot name without ports', () => {
    expect(create({ adapter: 'none' }, ctx).env(1)).toEqual({ FOREMAN_SLOT: 'w1' });
  });
  it('prepare is always up', () => {
    expect(create({}, ctx).prepare(3, '/wt')).toBe('up');
  });
  it('refuses unknown options', () => {
    expect(() => create({ adapter: 'none', port: {} }, ctx)).toThrow(/port/);
  });
  it('refuses a non-integer port base', () => {
    expect(() => create({ ports: { UI_PORT: '3000' } }, ctx)).toThrow(/UI_PORT/);
    expect(() => create({ ports: { UI_PORT: 30.5 } }, ctx)).toThrow(/UI_PORT/);
  });
});
