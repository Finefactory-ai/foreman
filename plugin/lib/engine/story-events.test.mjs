import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { raiseStoryEvent } from './story-events.mjs';

let root;
afterEach(() => root && rmSync(root, { recursive: true, force: true }));

const NOTE = '---\nid: S-1\ntitle: One\nstatus: in-progress\n---\n\n# S-1\n';
function project() {
  root = mkdtempSync(join(tmpdir(), 'story-events-'));
  mkdirSync(join(root, 'stories'));
  writeFileSync(join(root, 'stories', 'S-1.md'), NOTE);
  writeFileSync(join(root, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'T' }, checks: [{ run: 'true', when: 'always' }], stories: { adapter: 'markdown', dir: 'stories', track: 'file' } }));
  return root;
}

describe('raiseStoryEvent', () => {
  it('passes the event to the project story source, which a markdown source ignores', () => {
    const dir = project();
    expect(raiseStoryEvent({ root: dir, env: {} }, 'S-1', 'review', 'Pull request ready for review: https://gh/pull/1')).toEqual({ ok: true });
    expect(readFileSync(join(dir, 'stories', 'S-1.md'), 'utf8')).toBe(NOTE);
  });

  it('never throws: no config, an unknown story, or nothing to name', () => {
    root = mkdtempSync(join(tmpdir(), 'story-events-'));
    expect(raiseStoryEvent({ root, env: {} }, 'S-1', 'review', 'x')).toMatchObject({ ok: false, error: expect.stringMatching(/cannot open stories/) });
    const dir = project();
    expect(raiseStoryEvent({ root: dir, env: {} }, 'S-9', 'review', 'x')).toMatchObject({ ok: false, error: 'no such story: S-9' });
    expect(raiseStoryEvent({ root: dir, env: {} }, '', 'review', 'x')).toMatchObject({ ok: false });
    expect(raiseStoryEvent({ env: {} }, 'S-1', 'review', 'x')).toMatchObject({ ok: false });
  });
});
