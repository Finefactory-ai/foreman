import { describe, expect, it } from 'vitest';
import { guardBash, productionHosts } from './production-hosts.mjs';

const cfg = (ship) => ({ ship });

describe('productionHosts', () => {
  it('uses the configured list, lowercased', () => {
    expect(productionHosts(cfg({ productionHosts: ['API.Example.com'], smoke: { urls: ['https://other.com'] } }))).toEqual(['api.example.com']);
  });
  it('defaults to the smoke url hosts and the Supabase hosts', () => {
    const c = cfg({ smoke: { urls: ['https://app.example.com/health', 'https://app.example.com/x', 'http://localhost:3000'] }, 'migrate-supabase': { projectRef: 'abcd' } });
    expect(productionHosts(c)).toEqual(['app.example.com', 'abcd.supabase.co', 'db.abcd.supabase.co']);
  });
  it('is empty when nothing is configured, and survives a null config', () => {
    expect(productionHosts(cfg({ steps: ['pr'] }))).toEqual([]);
    expect(productionHosts(null)).toEqual([]);
  });
  it('skips smoke urls it cannot parse', () => {
    expect(productionHosts(cfg({ smoke: { urls: ['not a url', 'https://a.com'] } }))).toEqual(['a.com']);
  });
});

describe('guardBash', () => {
  const hosts = ['api.example.com', 'db.abcd.supabase.co'];
  const deny = (command, stage = 'test') => guardBash({ command, stage, hosts });
  it('denies a url, a bare host and a connection string for the tester and reviewers', () => {
    expect(deny('curl https://api.example.com/v1')).toBe('Foreman keeps the tester and reviewers off production (api.example.com). Test against the local or slot environment instead.');
    expect(deny('ping api.example.com', 'review')).toContain('(api.example.com)');
    expect(deny('psql postgresql://u:p@db.abcd.supabase.co:5432/postgres')).toContain('(db.abcd.supabase.co)');
    expect(deny('psql -h db.abcd.supabase.co')).toContain('db.abcd.supabase.co');
    expect(deny('curl https://API.EXAMPLE.COM:8443/x')).not.toBeNull();
    expect(deny('curl "https://sub.api.example.com/"')).not.toBeNull();
  });
  it('respects host boundaries', () => {
    expect(deny('curl myapi.example.community')).toBeNull();
    expect(deny('curl https://api.example.community')).toBeNull();
    expect(deny('curl https://my-api.example.com')).toBeNull();
    expect(deny('curl https://api.example.com.evil.org')).toBeNull();
    expect(deny('echo api.example.com.')).not.toBeNull();
  });
  it('never limits other stages', () => {
    for (const stage of ['build', 'architect', null]) expect(deny('curl https://api.example.com', stage)).toBeNull();
  });
  it('allows when there are no hosts or no command', () => {
    expect(guardBash({ command: 'curl https://api.example.com', stage: 'test', hosts: [] })).toBeNull();
    expect(guardBash({ command: undefined, stage: 'test', hosts })).toBeNull();
  });
});
