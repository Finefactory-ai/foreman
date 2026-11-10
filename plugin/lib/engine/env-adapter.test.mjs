import { describe, expect, it } from 'vitest';
import { envAdaptersFor, openEnvAdapter } from './env-adapter.mjs';
import { fakePack } from '../../../test/fake-pack.mjs';

const ctx = { root: '/repo', config: {}, sh: () => ({ status: 0, stdout: '' }) };

describe('openEnvAdapter', () => {
  it('opens none', () => {
    const a = openEnvAdapter({ config: { env: { adapter: 'none', ports: { P: 10 } } }, ctx });
    expect(a.env(1)).toEqual({ FOREMAN_SLOT: 'w1', P: '11' });
  });
  it('opens supabase', () => {
    const a = openEnvAdapter({ config: { env: { adapter: 'supabase', projectPrefix: 'x' } }, ctx });
    expect(a.env(1).SUPABASE_PROJECT_ID).toBe('x-w1');
  });
  it('opens docker', () => {
    const a = openEnvAdapter({ config: { env: { adapter: 'docker', projectPrefix: 'x' } }, ctx });
    expect(a.env(1).COMPOSE_PROJECT_NAME).toBe('x-w1');
  });
  it('refuses an unknown adapter', () => {
    expect(() => openEnvAdapter({ config: { env: { adapter: 'x' } }, ctx })).toThrow('unknown slot environment: x');
  });
});

describe('openEnvAdapter with a pack', () => {
  const packs = { acme: fakePack() };
  it('opens the pack adapter when the config names the pack', () => {
    const a = openEnvAdapter({ config: { pack: 'acme', env: { adapter: 'acme-org' } }, ctx, packs });
    expect(a.env(2)).toEqual({ FOREMAN_SLOT: 'w2' });
    expect(a.prepare()).toBe('up');
  });
  it('does not know the pack adapter when the config names no pack', () => {
    expect(() => openEnvAdapter({ config: { env: { adapter: 'acme-org' } }, ctx, packs })).toThrow('unknown slot environment: acme-org');
  });
  it('refuses a pack adapter named like a core one', () => {
    const clash = { acme: fakePack({ envAdapters: { docker: { create: () => ({}) } } }) };
    expect(() => openEnvAdapter({ config: { pack: 'acme', env: { adapter: 'docker' } }, ctx, packs: clash })).toThrow('pack acme env adapter docker clashes with a core env adapter');
  });
  it('exports the adapter table, which throws the same clash', () => {
    const clash = { acme: fakePack({ envAdapters: { none: { create: () => ({}) } } }) };
    expect(() => envAdaptersFor({ pack: 'acme' }, clash)).toThrow('pack acme env adapter none clashes with a core env adapter');
    expect(Object.keys(envAdaptersFor({ pack: 'acme' }, packs))).toEqual(['none', 'supabase', 'docker', 'acme-org']);
  });
});

describe('openEnvAdapter with the salesforce pack', () => {
  it('opens sandbox-pool, with no clash with a core adapter', () => {
    const config = {
      pack: 'salesforce',
      slots: 1,
      env: { adapter: 'sandbox-pool' },
      salesforce: { orgs: { 'acme-dev1': { orgId: '00D000000000001AAA' } }, build: ['acme-dev1'], stages: [{ name: 'dev', org: 'acme-dev1' }] },
    };
    const a = openEnvAdapter({ config, ctx: { ...ctx, stateDir: '/repo/.foreman', config } });
    expect(a.env(1).FOREMAN_SLOT).toBe('w1');
    expect(Object.keys(envAdaptersFor(config))).toEqual(['none', 'supabase', 'docker', 'sandbox-pool', 'scratch']);
  });
  it('opens scratch for a scratch layout', () => {
    const config = {
      pack: 'salesforce',
      slots: 2,
      env: { adapter: 'scratch' },
      salesforce: {
        orgs: { 'acme-hub': { orgId: '00D000000000004AAA', production: true } },
        build: { scratch: { devHub: 'acme-hub', definition: 'config/project-scratch-def.json' } },
        stages: [],
      },
    };
    const a = openEnvAdapter({ config, ctx: { ...ctx, stateDir: '/repo/.foreman', config } });
    expect(a.env(1).FOREMAN_SLOT).toBe('w1');
    expect(typeof a.sweep).toBe('function');
  });
});
