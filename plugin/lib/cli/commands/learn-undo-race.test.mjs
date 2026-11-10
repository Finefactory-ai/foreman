import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../main.mjs';

// `learn undo` waits on the story source (list, then one update per story) between reading the
// ledger and saving it. A `learn` that saves in that window (a story it created, its applied keys,
// its note) must survive the undo's save. `race.during` runs a hook inside the first update, the
// way a concurrent learn would land. vi.mock is hoisted, hence its own file.
const race = vi.hoisted(() => ({ during: null }));

vi.mock('../../engine/story-source.mjs', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    openStorySource: (...a) => {
      const s = real.openStorySource(...a);
      return {
        ...s,
        update: (...u) => {
          const hook = race.during;
          if (!hook) return s.update(...u);
          race.during = null;
          return Promise.resolve(hook()).then(() => s.update(...u));
        },
      };
    },
  };
});

let dir;
const state = () => join(dir, '.foreman');
const ledger = () => JSON.parse(readFileSync(join(state(), 'learn.json'), 'utf8'));
const waiting = (id) => join(state(), 'stories', 'new', `${id}.md`);

async function run(argv, extraEnv = {}) {
  let out = '';
  let err = '';
  const code = await main(argv, {
    cwd: dir,
    env: { FOREMAN_PROJECT_DIR: dir, ...extraEnv },
    now: () => new Date('2026-10-15T09:00:00Z'),
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
  });
  return { code, out, err };
}

const pending = async () => JSON.parse((await run(['decide', 'pending'])).out);
const line = (story, rule, extra = {}) => JSON.stringify({ at: '2026-10-15T08:00:00Z', story, result: 'failed', builder: 'developer', stage: 'review', severity: 'major', rule, where: `${story}.js`, observed: 'o', fix: 'add a test', ...extra });
const minor = (story, rule, extra = {}) => line(story, rule, { result: 'shipped', severity: 'minor', where: 'src/a.js', observed: 'no test for the empty case', fix: 'add one', ...extra });
const storyFile = (id, title) => writeFileSync(join(dir, 'stories', `${id}.md`), `---\nid: ${id}\ntitle: ${title}\nstatus: done\n---\n\n# ${id}\n`);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foreman-cli-learn-undo-race-'));
  writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'Acme' }, checks: [{ run: 'true', when: 'always' }], learning: { auto: false } }));
  mkdirSync(join(dir, 'stories'), { recursive: true });
  storyFile('S-3', 'Three');
  storyFile('S-4', 'Four');
  storyFile('S-5', 'Five');
  mkdirSync(state(), { recursive: true });
  writeFileSync(join(state(), 'settings.json'), JSON.stringify({ 'features.autoCreateFollowUps': true }));
  writeFileSync(join(state(), 'findings.jsonl'), `${[minor('S-3', 'Cover the empty case'), minor('S-4', 'Log errors')].join('\n')}\n`);
});
afterEach(() => {
  race.during = null;
  rmSync(dir, { recursive: true, force: true });
});

// Creates F-1 and F-2, answers the note "Undo and close them", and gives the note.
async function answeredNote() {
  const first = await run(['learn']);
  expect(first.code).toBe(0);
  expect(first.out).toContain('Created F-1: Follow-ups from S-3\n');
  expect(first.out).toContain('Created F-2: Follow-ups from S-4\n');
  const [note] = await pending();
  expect(note.title).toBe('Foreman created 2 follow-up stories');
  expect((await run(['decide', 'answer', note.id, 'Undo and close them'])).code).toBe(0);
  return note;
}

// A learn that lands while the undo waits on the story source: a new minor finding on S-5.
const concurrentLearn = () => {
  race.during = async () => {
    appendFileSync(join(state(), 'findings.jsonl'), `${minor('S-5', 'Log errors')}\n`);
    const r = await run(['learn']);
    expect(r.out).toContain('Created F-3: Follow-ups from S-5\n');
  };
};

const S5_KEY = 'followup:S-5:log errors';
const f3Detail = { kind: 'followup-created', stories: [{ id: 'F-3', story: 'S-5', findings: 1, keys: [S5_KEY] }] };

describe('foreman learn undo while a learn saves the ledger', () => {
  it('learn undo keeps a follow-up story a learn created while it waited on the story source', async () => {
    const note = await answeredNote();
    concurrentLearn();
    const { code, out } = await run(['learn', 'undo', note.id]);
    expect(code).toBe(0);
    expect(out).toContain('Closed F-1 and F-2.\n');

    expect(ledger().applied).toContain(S5_KEY);
    const noteF3 = (await pending()).find((i) => i.title === 'Foreman created 1 follow-up story');
    expect(noteF3).toBeTruthy();
    expect(ledger().details[noteF3.id]).toEqual(f3Detail);
    expect(ledger().details[note.id].closed).toEqual(['F-1', 'F-2']);

    expect((await run(['learn'])).out).toContain('Created 0 follow-up story(s) from minor findings.');
    expect(existsSync(waiting('F-4'))).toBe(false);
  });

  it('a learn undo that fails to close a story still keeps what a concurrent learn saved', async () => {
    const note = await answeredNote();
    // F-2's overlay cannot be written: its path is a folder.
    mkdirSync(join(state(), 'stories', 'F-2.json', 'x'), { recursive: true });
    concurrentLearn();
    const { code, err } = await run(['learn', 'undo', note.id]);
    expect(code).toBe(1);
    expect(err).toContain('could not close F-2: ');

    expect(ledger().applied).toContain(S5_KEY);
    expect(ledger().details[note.id].closed).toEqual(['F-1']);
    const noteF3 = (await pending()).find((i) => i.title === 'Foreman created 1 follow-up story');
    expect(noteF3).toBeTruthy();
    expect(ledger().details[noteF3.id]).toEqual(f3Detail);

    expect((await run(['learn'])).code).toBe(0);
    expect(existsSync(waiting('F-4'))).toBe(false);
  });
});
