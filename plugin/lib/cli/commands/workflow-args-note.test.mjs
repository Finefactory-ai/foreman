import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../main.mjs';
import { startStory } from '../../engine/state.mjs';

// No real slot can be made to refuse the note for every user (chmod does not stop root), so the
// real state module is kept and only its noteLearned is swapped for one that throws. vi.mock is
// hoisted, hence its own file.
const noteLearned = vi.hoisted(() =>
  vi.fn(() => {
    throw Object.assign(new Error("EACCES: permission denied, open 'slots/w1.json'"), { code: 'EACCES' });
  }),
);

vi.mock('../../engine/state.mjs', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, noteLearned };
});

let dir;
const state = () => path.join(dir, '.foreman');

beforeEach(() => {
  noteLearned.mockClear();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-wa-note-'));
  fs.mkdirSync(path.join(dir, 'stories'));
  fs.writeFileSync(path.join(dir, 'stories', 'S-1.md'), '---\nid: S-1\ntitle: Add it\n---\nbody\n');
  fs.writeFileSync(
    path.join(dir, 'foreman.config.json'),
    JSON.stringify({
      version: 1,
      project: { name: 'Acme' },
      checks: [{ run: 'npm test', when: 'always' }],
      stories: { adapter: 'markdown', dir: 'stories' },
      roles: { builders: { developer: { agent: 'foreman:builder', use: 'everything' } } },
    }),
  );
  fs.mkdirSync(path.join(state(), 'learned', 'traits'), { recursive: true });
  fs.writeFileSync(path.join(state(), 'learned', 'traits', 'developer.md'), '[L-1] Acme: test every error path.\n');
  startStory(state(), { id: 'S-1', title: 'Add it' }, new Date(), 'w1');
});

async function run(argv) {
  let out = '';
  let err = '';
  const code = await main(argv, {
    cwd: dir,
    env: { FOREMAN_PROJECT_DIR: dir, FOREMAN_SLOT: 'w1' },
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
  });
  return { code, out, err };
}

describe('foreman workflow-args when noting the learned ids fails', () => {
  it('warns on stderr, still prints one line of args and exits 0', async () => {
    const { code, out, err } = await run(['workflow-args', 'S-1']);
    expect(code).toBe(0);
    expect(out.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(out).traits.developer).toContain('[L-1]');
    expect(err).toContain('warning: learned items not recorded: EACCES');
    expect(err).not.toContain('workflow-args:');
    expect(noteLearned).toHaveBeenCalledTimes(1);
    expect(noteLearned).toHaveBeenCalledWith(state(), 'w1', 'S-1', ['L-1'], expect.any(Date));
  });
});
