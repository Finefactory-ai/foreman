import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const text = readFileSync(fileURLToPath(new URL('../plugin/skills/run/SKILL.md', import.meta.url)), 'utf8');

describe('skills/run/SKILL.md', () => {
  it('is the run skill', () => {
    expect(text).toMatch(/^---\nname: run\ndescription: .+\n---\n/);
  });

  it('drives the run through the foreman command', () => {
    for (const cmd of ['foreman run', 'foreman status', 'foreman stop', 'foreman pause', 'foreman resume', 'foreman workers', 'foreman slot', 'foreman handback', 'foreman next', 'foreman fixed', 'foreman decide answer', 'foreman decide list', 'foreman story next']) {
      expect(text).toContain(cmd);
    }
    expect(text).toContain('foreman service install');
    expect(text).toContain('supervisor.out');
    expect(text).not.toContain('run_in_background');
    expect(text).not.toContain('pgrep');
  });

  it('stops at once through `foreman stop --now`, never by killing a pid itself', () => {
    expect(text).toContain('foreman stop --now');
    expect(text).not.toMatch(/kill <pid>/);
  });

  it('keeps the owner in charge of halts and discards', () => {
    expect(text).toMatch(/never .*halt/i);
    expect(text).toMatch(/discard[\s\S]*confirm|confirm[\s\S]*discard/i);
  });

  it('names no project-specific service and no page address', () => {
    for (const word of ['supabase', 'vercel', 'colima', 'obsidian', 'vault', '.env.local', 'claude.ai', 'run.sh', 'scripts/factory', '.factory/']) {
      expect(text.toLowerCase()).not.toContain(word);
    }
  });

  it('asks for an open session only with the artifacts console', () => {
    const lines = text.split('\n').filter((l) => /stay open/i.test(l));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).toContain('artifacts');
  });

  it('says a story that ends blocked does not use up one of the N', () => {
    const flat = text.replace(/\s+/g, ' ');
    expect(flat).toContain('a story that ends blocked and built nothing does not use up one of the N');
  });

  it('says the stories an earlier run left in hand come on top of the N', () => {
    const flat = text.replace(/\s+/g, ' ');
    expect(flat).toContain('stories an earlier run left in hand are resumed first, on top of the N, and do not count towards it');
  });

  it('keeps the no-number note next to the sentence it explains', () => {
    const flat = text.replace(/\s+/g, ' ');
    expect(flat).toContain('does not use up one of the N (no number: it runs until stopped');
    expect(flat).not.toMatch(/\) \(/);
  });

  it('says a run with no N lasts until foreman stop', () => {
    expect(text).toMatch(/no N lasts until `foreman stop`/);
    expect(text).toContain('--exit-when-idle');
    expect(text).toContain('foreman next <id>');
  });
});
