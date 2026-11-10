import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../main.mjs';

// No real adapter can be made to throw from followUpOf, so the real markdown source is kept
// and only its followUpOf is swapped for one that throws. vi.mock is hoisted, hence its own file.
const followUpOf = vi.hoisted(() => vi.fn(() => { throw new Error('lookup failed'); }));

vi.mock('../../engine/story-source.mjs', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, openStorySource: (args) => ({ ...real.openStorySource(args), followUpOf }) };
});

let dir;
const state = () => join(dir, '.foreman');

beforeEach(() => {
  followUpOf.mockClear();
  dir = mkdtempSync(join(tmpdir(), 'foreman-cli-learn-lookup-'));
  writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'Acme' }, checks: [{ run: 'true', when: 'always' }] }));
  mkdirSync(join(dir, 'stories'), { recursive: true });
  writeFileSync(join(dir, 'stories', 'S-3.md'), '---\nid: S-3\ntitle: Three\nstatus: done\n---\n\n# S-3\n');
  mkdirSync(state(), { recursive: true });
  const finding = { at: '2026-10-15T08:00:00Z', story: 'S-3', result: 'shipped', builder: 'developer', stage: 'review', severity: 'minor', rule: 'Cover the empty case', where: 'src/a.js', observed: 'no test for the empty case', fix: 'add one' };
  writeFileSync(join(state(), 'findings.jsonl'), `${JSON.stringify(finding)}\n`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function run(argv) {
  let out = '';
  let err = '';
  const code = await main(argv, {
    cwd: dir,
    env: { FOREMAN_PROJECT_DIR: dir },
    now: () => new Date('2026-10-15T09:00:00Z'),
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
  });
  return { code, out, err };
}

describe("foreman learn when the source's followUpOf lookup throws", () => {
  it('counts the throw as no origin and proposes the follow-up', async () => {
    const { code, out, err } = await run(['learn']);
    expect(code).toBe(0);
    expect(err).toBe('');
    expect(out).toContain('Proposed 1 follow-up(s) from minor findings.');
    expect(out).not.toContain('is itself a follow-up');
    expect(followUpOf).toHaveBeenCalledWith('S-3');
    const items = JSON.parse((await run(['decide', 'pending'])).out);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ story: 'S-3', title: 'Follow up on S-3: 1 minor finding(s)?' });
  });

  it('carries on in a dry run too', async () => {
    const { code, out, err } = await run(['learn', '--dry-run']);
    expect(code).toBe(0);
    expect(err).toBe('');
    expect(out).toContain('Would ask: Follow up on S-3');
    expect(out).toContain('1 proposal(s); nothing written (dry run).');
    expect(followUpOf).toHaveBeenCalledWith('S-3');
  });
});
