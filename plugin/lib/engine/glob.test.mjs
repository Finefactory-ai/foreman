import { describe, expect, it } from 'vitest';
import { matchesGlob } from './glob.mjs';

describe('matchesGlob', () => {
  it('** matches files at any depth under a folder', () => {
    expect(matchesGlob('supabase/migrations/2026_x.sql', 'supabase/migrations/**')).toBe(true);
    expect(matchesGlob('supabase/migrations/a/b/c.sql', 'supabase/migrations/**')).toBe(true);
    expect(matchesGlob('supabase/seed.sql', 'supabase/migrations/**')).toBe(false);
    expect(matchesGlob('other/supabase/migrations/x.sql', 'supabase/migrations/**')).toBe(false);
  });
  it('**/ in the middle matches zero or more folders', () => {
    expect(matchesGlob('src/a.ts', 'src/**/*.ts')).toBe(true);
    expect(matchesGlob('src/x/y/a.ts', 'src/**/*.ts')).toBe(true);
    expect(matchesGlob('src/x/a.js', 'src/**/*.ts')).toBe(false);
  });
  it('**/x matches x at the root and at any depth', () => {
    expect(matchesGlob('x.md', '**/x.md')).toBe(true);
    expect(matchesGlob('a/b/x.md', '**/x.md')).toBe(true);
    expect(matchesGlob('a/bx.md', '**/x.md')).toBe(false);
  });
  it('regex special characters in paths and patterns are literal', () => {
    expect(matchesGlob('src/app/[id]/page.tsx', 'src/app/[id]/page.tsx')).toBe(true);
    expect(matchesGlob('src/app/i/page.tsx', 'src/app/[id]/page.tsx')).toBe(false);
    expect(matchesGlob('a+b(c)/x$.ts', 'a+b(c)/*.ts')).toBe(true);
    expect(matchesGlob('a^b|c{1}.ts', 'a^b|c{1}.ts')).toBe(true);
    expect(matchesGlob('ab.ts', 'a^b|c{1}.ts')).toBe(false);
    expect(matchesGlob('back\\slash', 'back\\slash')).toBe(true);
  });
  it('* does not cross /', () => {
    expect(matchesGlob('README.md', '*.md')).toBe(true);
    expect(matchesGlob('docs/README.md', '*.md')).toBe(false);
  });
  it('? is one character, never /', () => {
    expect(matchesGlob('a1.sql', 'a?.sql')).toBe(true);
    expect(matchesGlob('a12.sql', 'a?.sql')).toBe(false);
    expect(matchesGlob('a/.sql', 'a?.sql')).toBe(false);
  });
  it('a plain path matches only itself, and regex characters are literal', () => {
    expect(matchesGlob('tracker/dashboard.html', 'tracker/dashboard.html')).toBe(true);
    expect(matchesGlob('tracker/dashboardXhtml', 'tracker/dashboard.html')).toBe(false);
    expect(matchesGlob('a+b(c).txt', 'a+b(c).txt')).toBe(true);
  });
  it('{a,b} matches any one of its comma-separated globs', () => {
    const p = '{src/app/**/route.ts,tests/integration/**,next.config.ts}';
    expect(matchesGlob('src/app/api/health/route.ts', p)).toBe(true);
    expect(matchesGlob('tests/integration/a/b.test.ts', p)).toBe(true);
    expect(matchesGlob('next.config.ts', p)).toBe(true);
    expect(matchesGlob('src/app/page.tsx', p)).toBe(false);
    expect(matchesGlob('next.config.tsx', p)).toBe(false);
    expect(matchesGlob('src/lib/db/clients.ts', 'src/lib/{db,api}/*.ts')).toBe(true);
    expect(matchesGlob('src/lib/api/route.ts', 'src/lib/{db,api}/*.ts')).toBe(true);
    expect(matchesGlob('src/lib/ai/x.ts', 'src/lib/{db,api}/*.ts')).toBe(false);
  });
  it('braces without a comma, or never closed, are literal', () => {
    expect(matchesGlob('a{1}.ts', 'a{1}.ts')).toBe(true);
    expect(matchesGlob('a1.ts', 'a{1}.ts')).toBe(false);
    expect(matchesGlob('a{b,c.ts', 'a{b,c.ts')).toBe(true);
  });
});
