import { spawnSync } from 'node:child_process';
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../main.mjs';
import { savePark } from '../../engine/parks.mjs';
import { applyAnswers } from '../../engine/answers.mjs';
import { ownerWaiting, setStage } from '../../engine/state.mjs';
import { markSession } from '../../engine/session-files.mjs';
import storyCommand from './story.mjs';
import { waitingCount } from '../../console/waiting.mjs';

let dir;
const story = (id, status, extra = '') =>
  `---\nid: ${id}\ntitle: Story ${id}\nstatus: ${status}\n${extra}---\n\n## Progress notes\n\n_Newest first._\n`;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-story-'));
  fs.mkdirSync(path.join(dir, 'stories'));
  fs.writeFileSync(
    path.join(dir, 'foreman.config.json'),
    JSON.stringify({ version: 1, project: { name: 'T' }, checks: [{ run: 'npm test', when: 'always' }], stories: { adapter: 'markdown', dir: 'stories' } }),
  );
  fs.writeFileSync(path.join(dir, 'stories', 'S-1.md'), story('S-1', 'todo', 'depends_on: []\n'));
  fs.writeFileSync(path.join(dir, 'stories', 'S-2.md'), story('S-2', 'todo', 'depends_on: [S-1]\n'));
});

const NOW = new Date(2026, 9, 15, 12, 0, 0);
async function run(argv, env = {}) {
  let out = '';
  let err = '';
  const code = await main(argv, { cwd: dir, env: { FOREMAN_PROJECT_DIR: dir, ...env }, now: () => NOW, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } });
  return { code, out, err };
}
const note = (id) => fs.readFileSync(path.join(dir, 'stories', `${id}.md`), 'utf8');
const slot = () => JSON.parse(fs.readFileSync(path.join(dir, '.foreman', 'slots', 'w1.json'), 'utf8'));
const findings = () => fs.readFileSync(path.join(dir, '.foreman', 'findings.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

describe('foreman story next after a rollback', () => {
  const SF = {
    productionBranch: 'main',
    orgs: { 'acme-dev1': { orgId: '00D000000000001AAA' }, 'acme-qa': { orgId: '00D000000000002AAA' } },
    build: ['acme-dev1'],
    stages: [{ name: 'qa', org: 'acme-qa', branch: 'qa' }],
  };
  const AT = '2026-10-24T11:00:00.000Z';
  const useSalesforce = () =>
    fs.writeFileSync(
      path.join(dir, 'foreman.config.json'),
      JSON.stringify({ version: 1, project: { name: 'Acme' }, pack: 'salesforce', salesforce: SF, checks: [{ run: 'npm test', when: 'always' }], stories: { adapter: 'markdown', dir: 'stories' } }),
    );
  const record = (rolledBack) => {
    const file = path.join(dir, '.foreman', 'salesforce', 'releases', 'S-1.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ story: 'S-1', to: 'aaa', reached: ['qa'], first: null, rolledBack }));
  };

  it('adds rolledBackAt when the story release was rolled back', async () => {
    useSalesforce();
    record({ revert: 'r1', jobId: null, at: AT });
    const { code, out } = await run(['story', 'next', '--id', 'S-1']);
    expect(code).toBe(0);
    expect(out.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(out)).toMatchObject({ id: 'S-1', rolledBackAt: AT });
  });

  it('has no rolledBackAt without a record, or once it is cleared', async () => {
    useSalesforce();
    expect(JSON.parse((await run(['story', 'next', '--id', 'S-1'])).out)).not.toHaveProperty('rolledBackAt');
    record(null);
    expect(JSON.parse((await run(['story', 'next', '--id', 'S-1'])).out)).not.toHaveProperty('rolledBackAt');
  });

  it('prints no rolledBackAt for a project with no pack, even with a record on disk', async () => {
    record({ revert: 'r1', jobId: null, at: AT });
    expect(JSON.parse((await run(['story', 'next', '--id', 'S-1'])).out)).not.toHaveProperty('rolledBackAt');
  });
});

describe('foreman story next / plan', () => {
  it('prints the first buildable story as one JSON line', async () => {
    const { code, out } = await run(['story', 'next']);
    expect(code).toBe(0);
    expect(out.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(out).id).toBe('S-1');
  });

  it('prints {"none":true} when everything is done', async () => {
    fs.writeFileSync(path.join(dir, 'stories', 'S-1.md'), story('S-1', 'done'));
    fs.writeFileSync(path.join(dir, 'stories', 'S-2.md'), story('S-2', 'done'));
    expect(await run(['story', 'next'])).toMatchObject({ code: 0, out: '{"none":true}\n' });
  });

  it('--id --strict gives none for a story whose dependencies are not done', async () => {
    expect((await run(['story', 'next', '--id', 'S-2', '--strict'])).out).toBe('{"none":true}\n');
    expect(JSON.parse((await run(['story', 'next', '--id', 'S-2'])).out).id).toBe('S-2');
  });

  it('--skip passes over a story', async () => {
    expect(JSON.parse((await run(['story', 'next', '--skip', 'S-1'])).out)).toEqual({ none: true });
  });

  it('plan lists the build order', async () => {
    const { code, out } = await run(['story', 'plan']);
    expect(code).toBe(0);
    expect(out).toContain('The factory can build 2 stories, in this order:\n  S-1 S-2');
    expect(out).toContain('0 open stories it cannot reach yet:');
    expect(out).toContain('0 open owner tasks:');
  });
});

describe('foreman story start / block / done / todo', () => {
  // Stories inside the project: the changes go to the overlay in the state folder and the
  // story files stay as committed.
  const S1 = () => story('S-1', 'todo', 'depends_on: []\n');
  const overlay = (id) => JSON.parse(fs.readFileSync(path.join(dir, '.foreman', 'stories', `${id}.json`), 'utf8'));

  it('start sets in-progress, started date, a note and records state', async () => {
    const { code } = await run(['story', 'start', 'S-1']);
    expect(code).toBe(0);
    expect(overlay('S-1')).toMatchObject({ status: 'in-progress', fields: { started: '2026-10-15' }, notes: [{ date: '2026-10-15', text: 'Started.' }] });
    expect(note('S-1')).toBe(S1());
    expect(slot().story).toMatchObject({ id: 'S-1', title: 'Story S-1' });
  });

  it('start exits 1 for an unknown id', async () => {
    const { code, err } = await run(['story', 'start', 'S-99']);
    expect(code).toBe(1);
    expect(err).toContain('S-99');
  });

  it('block records the reason, and the story is no longer offered', async () => {
    expect((await run(['story', 'block', 'S-1', '--reason', 'needs a key'])).code).toBe(0);
    expect(overlay('S-1')).toMatchObject({ status: 'blocked', blockedBy: 'needs a key', notes: [{ text: 'Blocked: needs a key' }] });
    expect(note('S-1')).toBe(S1());
    expect(JSON.parse((await run(['story', 'next'])).out)).toEqual({ none: true });
  });

  it('done needs --note and writes completed date', async () => {
    expect((await run(['story', 'done', 'S-1'])).code).toBe(64);
    expect((await run(['story', 'done', 'S-1', '--note', 'Shipped in #4'])).code).toBe(0);
    expect(overlay('S-1')).toMatchObject({ status: 'done', fields: { completed: '2026-10-15' }, notes: [{ text: 'Shipped in #4' }] });
    expect(JSON.parse((await run(['story', 'next'])).out).id).toBe('S-2');
  });

  it('done folds a note over several lines to one', async () => {
    expect((await run(['story', 'done', 'S-1', '--note', 'a\nb'])).code).toBe(0);
    expect(overlay('S-1').notes[0]).toMatchObject({ text: 'a b' });
  });

  it('done refuses a note that is only whitespace', async () => {
    const r = await run(['story', 'done', 'S-1', '--note', ' \n ']);
    expect(r.code).toBe(64);
    expect(r.err).toContain('done needs --note <text>');
    expect(fs.existsSync(path.join(dir, '.foreman', 'stories', 'S-1.json'))).toBe(false);
    expect(JSON.parse((await run(['story', 'next'])).out).id).toBe('S-1');
  });

  it('todo needs --note and resets status', async () => {
    await run(['story', 'start', 'S-1']);
    expect((await run(['story', 'todo', 'S-1'])).code).toBe(64);
    expect((await run(['story', 'todo', 'S-1', '--note', 'Put back'])).code).toBe(0);
    expect(overlay('S-1')).toMatchObject({ status: 'todo', notes: [{ text: 'Put back' }, { text: 'Started.' }] });
  });

  it('with track: "file" the story file itself is edited', async () => {
    fs.writeFileSync(
      path.join(dir, 'foreman.config.json'),
      JSON.stringify({ version: 1, project: { name: 'T' }, checks: [{ run: 'npm test', when: 'always' }], stories: { adapter: 'markdown', dir: 'stories', track: 'file' } }),
    );
    expect((await run(['story', 'block', 'S-1', '--reason', 'needs a key'])).code).toBe(0);
    const text = note('S-1');
    expect(text).toContain('status: blocked');
    expect(text).toContain('blocked_by: needs a key');
    expect(text).toContain('Blocked: needs a key');
    expect(fs.existsSync(path.join(dir, '.foreman', 'stories'))).toBe(false);
  });
});

describe('foreman story set --depends-on', () => {
  const overlay = (id) => JSON.parse(fs.readFileSync(path.join(dir, '.foreman', 'stories', `${id}.json`), 'utf8'));
  const dependsOf = async (id) => JSON.parse((await run(['story', 'next', '--id', id])).out).dependsOn;
  beforeEach(() => {
    fs.writeFileSync(path.join(dir, 'stories', 'S-3.md'), story('S-3', 'todo', 'depends_on: []\n'));
  });

  it('adds dependencies in the overlay and prints the new list', async () => {
    const { code, out } = await run(['story', 'set', 'S-3', '--depends-on', 'S-1,S-2']);
    expect(code).toBe(0);
    expect(out.trim()).toBe('S-3 depends on: S-1, S-2');
    expect(overlay('S-3').fields.depends_on).toEqual(['S-1', 'S-2']);
    expect(note('S-3')).toBe(story('S-3', 'todo', 'depends_on: []\n'));
    expect((await run(['story', 'next', '--id', 'S-3', '--strict'])).out).toBe('{"none":true}\n');
  });

  it('edits the note itself with track: "file"', async () => {
    fs.writeFileSync(
      path.join(dir, 'foreman.config.json'),
      JSON.stringify({ version: 1, project: { name: 'T' }, checks: [{ run: 'npm test', when: 'always' }], stories: { adapter: 'markdown', dir: 'stories', track: 'file' } }),
    );
    expect((await run(['story', 'set', 'S-3', '--depends-on', 'S-1'])).code).toBe(0);
    expect(note('S-3')).toContain('depends_on: [S-1]');
  });

  it('refuses an unknown id', async () => {
    const { code, err } = await run(['story', 'set', 'S-3', '--depends-on', 'S-1,S-99']);
    expect(code).toBe(1);
    expect(err).toContain('S-99');
    expect(fs.existsSync(path.join(dir, '.foreman', 'stories', 'S-3.json'))).toBe(false);
  });

  it('refuses something that is not an id', async () => {
    expect((await run(['story', 'set', 'S-3', '--depends-on', 'banana'])).code).toBe(1);
  });

  it('refuses a dependency on itself', async () => {
    const { code, err } = await run(['story', 'set', 'S-3', '--depends-on', 'S-3']);
    expect(code).toBe(1);
    expect(err).toContain('itself');
  });

  it('refuses a cycle', async () => {
    // S-2 already depends on S-1, so S-1 depending on S-2 closes a loop.
    const { code, err } = await run(['story', 'set', 'S-1', '--depends-on', 'S-2']);
    expect(code).toBe(1);
    expect(err).toContain('cycle');
  });

  it('needs a story id and --depends-on', async () => {
    expect((await run(['story', 'set', '--depends-on', 'S-1'])).code).toBe(64);
    expect((await run(['story', 'set', 'S-3'])).code).toBe(64);
  });

  it('replaces the list, and an empty one clears it', async () => {
    await run(['story', 'set', 'S-3', '--depends-on', 'S-1,S-2']);
    await run(['story', 'set', 'S-3', '--depends-on', 'S-2']);
    expect(await dependsOf('S-3')).toEqual(['S-2']);
    expect((await run(['story', 'set', 'S-3', '--depends-on', ''])).code).toBe(0);
    expect(await dependsOf('S-3')).toEqual([]);
  });
});

describe('foreman story depend', () => {
  const CONFIG = { version: 1, project: { name: 'T' }, checks: [{ run: 'npm test', when: 'always' }], stories: { adapter: 'markdown', dir: 'stories' } };
  const config = (features) => fs.writeFileSync(path.join(dir, 'foreman.config.json'), JSON.stringify({ ...CONFIG, ...(features ? { features } : {}) }));
  const S3 = (deps = '[]') => story('S-3', 'blocked', `depends_on: ${deps}\nblocked_by: "S-1 must land first"\n`);
  const overlayFile = (id) => path.join(dir, '.foreman', 'stories', `${id}.json`);
  const overlay = (id) => JSON.parse(fs.readFileSync(overlayFile(id), 'utf8'));
  const found = async (id) => JSON.parse((await run(['story', 'next', '--id', id])).out);
  const pending = async () => JSON.parse((await run(['decide', 'pending'])).out);
  const events = () => {
    const file = path.join(dir, '.foreman', 'events.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  const DEPEND = ['story', 'depend', 'S-3', '--on', 'S-1', '--reason', 'S-1 must land first'];
  beforeEach(() => {
    config({ autoApplyDependsOn: true });
    fs.writeFileSync(path.join(dir, 'stories', 'S-3.md'), S3());
  });

  it('records the dependency, puts the story back to todo and tells the owner, with no proposal', async () => {
    const r = await run(DEPEND);
    expect(r.code).toBe(0);
    expect(await found('S-3')).toMatchObject({ id: 'S-3', status: 'todo', dependsOn: ['S-1'] });
    expect(overlay('S-3').notes[0].text).toBe('Now waits for S-1: S-1 must land first');
    const items = await pending();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ story: 'S-3', kind: 'decision', title: 'S-3 now waits for S-1', options: ['Undo', 'Keep'], summary: 'S-3 now waits for S-1: S-1 must land first', body: 'S-1 must land first', answer: null });
    expect(items[0].hints).toEqual(['Takes the dependency off again, so the story no longer waits for it.', 'Keeps the dependency and clears this note.']);
    expect(items[0]).not.toHaveProperty('recommend');
    expect(items[0]).not.toHaveProperty('explain');
    expect(items.some((i) => i.title.startsWith('Add depends_on:'))).toBe(false);
    expect(r.out).toBe(`S-3 now waits for S-1. Told the owner: ${items[0].id}.\n`);
    expect(events()).toContainEqual(expect.objectContaining({ kind: 'info', text: 'S-3 now waits for S-1 (added by Foreman; Undo on Waiting on you)' }));
  });

  it('keeps the summary to one line of at most 160 characters, and the reason whole in the body', async () => {
    const reason = `S-1 must land first:\n${'the login form it builds '.repeat(10)}`;
    expect((await run(['story', 'depend', 'S-3', '--on', 'S-1', '--reason', reason])).code).toBe(0);
    const [item] = await pending();
    expect(item.summary.length).toBeLessThanOrEqual(160);
    expect(item.summary).toMatch(/^S-3 now waits for S-1: S-1 must land first: the login form it builds [^\n]*\S…$/);
    expect(item.body).toBe(reason);
  });

  it('puts an FYI with Undo and Keep on Waiting on you, which counts nothing', async () => {
    await run(DEPEND);
    const { items } = await ownerWaiting(path.join(dir, '.foreman'), NOW, { root: dir });
    const fyi = items.find((i) => i.title === 'S-3 now waits for S-1');
    expect(fyi).toMatchObject({ group: 'fyi', blocks: [], frees: [] });
    expect(fyi.actions.map((a) => a.label)).toEqual(['Undo', 'Keep']);
    expect(waitingCount(items)).toBe(0);
  });

  it('keeps the dependencies the story already had', async () => {
    fs.writeFileSync(path.join(dir, 'stories', 'S-3.md'), S3('[S-2]'));
    expect((await run(DEPEND)).code).toBe(0);
    expect((await found('S-3')).dependsOn).toEqual(['S-2', 'S-1']);
    expect((await pending())[0].title).toBe('S-3 now waits for S-1');
  });

  it('changes nothing when the ids are there already', async () => {
    fs.writeFileSync(path.join(dir, 'stories', 'S-3.md'), S3('[S-1, S-2]'));
    const before = note('S-3');
    const r = await run(['story', 'depend', 'S-3', '--on', 'S-2, S-1,S-2', '--reason', 'S-1 must land first']);
    expect(r).toMatchObject({ code: 0, out: 'S-3 already waits for S-2, S-1; nothing changed.\n' });
    expect(note('S-3')).toBe(before);
    expect(fs.existsSync(overlayFile('S-3'))).toBe(false);
    expect(await pending()).toEqual([]);
  });

  it('refuses when features.autoApplyDependsOn is off, the default, and writes nothing', async () => {
    config();
    const before = note('S-3');
    const r = await run(DEPEND);
    expect(r.code).toBe(1);
    expect(r.err).toBe('features.autoApplyDependsOn is off: ask the owner with a decision instead.\n');
    expect(note('S-3')).toBe(before);
    expect(fs.existsSync(overlayFile('S-3'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.foreman', 'decisions'))).toBe(false);
  });

  it('refuses what set refuses, with its words, and changes nothing', async () => {
    const before = note('S-3');
    const cases = [
      [['story', 'depend', 'S-3', '--on', 'S-1,S-99', '--reason', 'x'], 1, 'no such story: S-99\n'],
      [['story', 'depend', 'S-3', '--on', 'banana', '--reason', 'x'], 1, 'no such story: banana\n'],
      [['story', 'depend', 'S-3', '--on', 'S-3', '--reason', 'x'], 1, 'S-3 cannot depend on itself\n'],
      [['story', 'depend', 'S-1', '--on', 'S-2', '--reason', 'x'], 1, 'that would make a cycle: S-1 is already needed by S-2\n'],
      [['story', 'depend', 'S-3', '--reason', 'x'], 64, 'depend needs --on <ids> and --reason <text>\n'],
      [['story', 'depend', 'S-3', '--on', 'S-1'], 64, 'depend needs --on <ids> and --reason <text>\n'],
      [['story', 'depend', 'S-3', '--on', ' , ', '--reason', 'x'], 64, 'depend needs --on <ids> and --reason <text>\n'],
      [['story', 'depend', 'S-3', '--on', ',', '--reason', 'x'], 64, 'depend needs --on <ids> and --reason <text>\n'],
      [['story', 'depend', 'S-3', '--on', '   ', '--reason', 'x'], 64, 'depend needs --on <ids> and --reason <text>\n'],
      [['story', 'depend', 'S-99', '--on', 'S-1', '--reason', 'x'], 1, 'no such story: S-99\n'],
    ];
    for (const [argv, code, err] of cases) expect(await run(argv), argv.join(' ')).toMatchObject({ code, err });
    // set says the same for the same input.
    expect((await run(['story', 'set', 'S-1', '--depends-on', 'S-2'])).err).toBe('that would make a cycle: S-1 is already needed by S-2\n');
    expect((await run(['story', 'set', 'S-3', '--depends-on', 'S-3'])).err).toBe('S-3 cannot depend on itself\n');
    expect(note('S-3')).toBe(before);
    expect(fs.existsSync(path.join(dir, '.foreman', 'stories'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.foreman', 'decisions'))).toBe(false);
  });

  it('Undo, answered and applied, takes the dependency off again', async () => {
    await run(DEPEND);
    const [item] = await pending();
    expect((await run(['decide', 'answer', item.id, 'Undo'])).code).toBe(0);
    const foreman = async (args) => {
      const r = await run(args);
      return { status: r.code, stdout: r.out };
    };
    const results = await applyAnswers(await pending(), { foreman, gh: () => ({ status: 1 }), git: () => ({ status: 1 }), branchPrefix: 'story/', remote: 'origin', today: '2026-10-15' });
    expect(results).toMatchObject([{ id: item.id, ok: true }]);
    expect((await found('S-3')).dependsOn).toEqual([]);
    expect(await pending()).toEqual([]);
    const { items } = await ownerWaiting(path.join(dir, '.foreman'), NOW, { root: dir });
    expect(items.some((i) => i.id === item.id)).toBe(false);

    expect((await run(['story', 'set', 'S-3', '--depends-on', 'S-1'])).code).toBe(0);
    expect((await run(['story', 'set', 'S-3', '--depends-on', ''])).code).toBe(0);
    expect((await found('S-3')).dependsOn).toEqual([]);
  });
});

describe('foreman story in a git project', () => {
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  beforeEach(() => {
    fs.writeFileSync(path.join(dir, '.gitignore'), '.foreman/\n');
    git('init', '-q', '-b', 'main');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  });

  it('start and block leave the working tree clean', async () => {
    expect((await run(['story', 'start', 'S-1'])).code).toBe(0);
    expect((await run(['story', 'block', 'S-1', '--reason', 'x'])).code).toBe(0);
    expect(git('status', '--porcelain')).toBe('');
    expect(JSON.parse((await run(['story', 'next'])).out)).toEqual({ none: true });
  });

  it('finalize marks the story done in this checkout and prints the path', async () => {
    await run(['story', 'start', 'S-1']);
    const { code, out } = await run(['story', 'finalize', 'S-1', '--note', 'It works; tested.']);
    expect(code).toBe(0);
    const file = path.join(fs.realpathSync(dir), 'stories', 'S-1.md');
    expect(out).toBe(`${file}\n`);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('status: done\n');
    expect(text).toContain('completed: 2026-10-15\n');
    expect(text).toContain('- **2026-10-15** — It works; tested.\n\n- **2026-10-15** — Started.');
  });

  it('finalize needs --note and a known id', async () => {
    expect((await run(['story', 'finalize', 'S-1'])).code).toBe(64);
    expect((await run(['story', 'finalize', 'S-99', '--note', 'x'])).code).toBe(1);
  });

  it('finalize says so when the story source has nothing to change', async () => {
    fs.writeFileSync(
      path.join(dir, 'foreman.config.json'),
      JSON.stringify({ version: 1, project: { name: 'T' }, checks: [{ run: 'npm test', when: 'always' }], stories: { adapter: 'markdown', dir: 'stories', track: 'file' } }),
    );
    const before = note('S-1');
    expect(await run(['story', 'finalize', 'S-1', '--note', 'x'])).toMatchObject({ code: 0, out: 'nothing to change for this story source\n' });
    expect(note('S-1')).toBe(before);
  });
});

describe('foreman story end', () => {
  it('writes the result into state', async () => {
    await run(['story', 'start', 'S-1']);
    const { code } = await run(['story', 'end', 'shipped', 'https://x/pr/1', 'all', 'good']);
    expect(code).toBe(0);
    expect(slot().result).toMatchObject({ id: 'S-1', result: 'shipped', pr: 'https://x/pr/1', note: 'all good' });
  });

  it('accepts ready-to-promote: the slot is freed and the event is good news', async () => {
    await run(['story', 'start', 'S-1']);
    savePark(path.join(dir, '.foreman'), { id: 'S-1', step: 'acme-promote', reason: 'click Promote', check: { deployId: 'D-1' }, parkedAt: NOW.toISOString() });
    const { code } = await run(['story', 'end', 'ready-to-promote', 'https://x/pr/1', 'click', 'Promote']);
    expect(code).toBe(0);
    expect(slot().story).toBeNull();
    expect(slot().result).toMatchObject({ id: 'S-1', result: 'ready-to-promote', pr: 'https://x/pr/1', note: 'click Promote' });
    const events = fs.readFileSync(path.join(dir, '.foreman', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(events.at(-1)).toMatchObject({ text: 'S-1 ready-to-promote: click Promote', kind: 'good' });
  });

  it('refuses ready-to-promote with no park: exits 1 and records failed', async () => {
    await run(['story', 'start', 'S-1']);
    const { code, err } = await run(['story', 'end', 'ready-to-promote', 'https://x/pr/1', 'click', 'Promote']);
    expect(code).toBe(1);
    expect(err).toContain('no release is parked for S-1');
    expect(slot().story).toBeNull();
    expect(slot().result).toMatchObject({ id: 'S-1', result: 'failed' });
    const events = fs.readFileSync(path.join(dir, '.foreman', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(events.at(-1)).toMatchObject({ text: 'S-1 failed: claimed ready-to-promote, but no release is parked', kind: 'warn' });
    // The markdown source ignores the failed event; it still knew the story, so no warning.
    expect(err).not.toContain('warning');
  });

  it('accepts ready-to-promote with no park when the story is already done (the park watch finished it)', async () => {
    await run(['story', 'start', 'S-1']);
    await run(['story', 'done', 'S-1', '--note', 'Released']);
    const { code, err } = await run(['story', 'end', 'ready-to-promote', 'https://x/pr/1', 'click', 'Promote']);
    expect(code).toBe(0);
    expect(err).not.toContain('no release is parked');
    expect(slot().result).toMatchObject({ id: 'S-1', result: 'ready-to-promote' });
  });

  it('--findings on an unparked ready-to-promote claim records the lines as failed', async () => {
    await run(['story', 'start', 'S-1']);
    const f = path.join(dir, 'f.json');
    fs.writeFileSync(f, JSON.stringify([{ stage: 'review', severity: 'minor', rule: 'r' }]));
    expect((await run(['story', 'end', 'ready-to-promote', '--findings', f])).code).toBe(1);
    expect(findings()).toEqual([expect.objectContaining({ story: 'S-1', result: 'failed' })]);
  });

  it('refuses ready-to-promote with no story known: exits 1, says so, tells no source', async () => {
    const { code, err } = await run(['story', 'end', 'ready-to-promote']);
    expect(code).toBe(1);
    expect(err).toContain('no story id is known');
    expect(err).not.toContain('warning');
    expect(fs.existsSync(path.join(dir, '.foreman', 'stories'))).toBe(false);
    const file = path.join(dir, '.foreman', 'slots', 'w1.json');
    if (fs.existsSync(file)) expect(slot().result ?? null).toBeNull();
  });

  it('--findings with no story known records the lines as failed', async () => {
    const f = path.join(dir, 'f.json');
    fs.writeFileSync(f, JSON.stringify([{ stage: 'review', severity: 'minor', rule: 'r' }]));
    expect((await run(['story', 'end', 'ready-to-promote', '--findings', f])).code).toBe(1);
    expect(findings()).toEqual([expect.objectContaining({ story: '', result: 'failed' })]);
  });

  it('--cause environment records the cause on a failed end', async () => {
    await run(['story', 'start', 'S-1']);
    const { code } = await run(['story', 'end', 'failed', '', 'CI never started', '--cause', 'environment']);
    expect(code).toBe(0);
    expect(slot().result).toMatchObject({ id: 'S-1', result: 'failed', cause: 'environment', note: 'CI never started' });
  });

  it('--cause story records story', async () => {
    await run(['story', 'start', 'S-1']);
    expect((await run(['story', 'end', 'failed', '--cause', 'story'])).code).toBe(0);
    expect(slot().result.cause).toBe('story');
  });

  it('rejects a cause that is not story or environment, and one on a result that is not failed, recording nothing', async () => {
    await run(['story', 'start', 'S-1']);
    const bad = await run(['story', 'end', 'failed', '--cause', 'banana']);
    expect(bad).toMatchObject({ code: 64, err: '--cause must be story or environment\n' });
    const wrong = await run(['story', 'end', 'shipped', '--cause', 'environment']);
    expect(wrong).toMatchObject({ code: 64, err: '--cause goes only with failed\n' });
    expect(slot().result ?? null).toBeNull();
  });

  it('rejects an unknown result', async () => {
    expect((await run(['story', 'end', 'banana'])).code).toBe(64);
  });

  it('--findings appends one line per finding', async () => {
    await run(['story', 'start', 'S-1']);
    const f = path.join(dir, 'f.json');
    const item = { stage: 'review', severity: 'minor', rule: 'r', where: 'a.js', observed: 'o', fix: 'x' };
    fs.writeFileSync(f, JSON.stringify([item, item, item]));
    expect((await run(['story', 'end', 'blocked', '--findings', f])).code).toBe(0);
    const lines = findings();
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ story: 'S-1', result: 'blocked', stage: 'review', rule: 'r' });
    expect(lines[0].at).toBeTruthy();
  });

  it('--findings keeps round and resolved', async () => {
    await run(['story', 'start', 'S-1']);
    const f = path.join(dir, 'f.json');
    const item = { stage: 'tester', severity: 'minor', rule: 'r', where: 'a.js', observed: 'o', fix: 'x' };
    fs.writeFileSync(f, JSON.stringify([{ ...item, severity: 'blocker', round: 1, resolved: true }, item]));
    expect((await run(['story', 'end', 'shipped', '', 'ok', '--findings', f, '--builder', 'developer'])).code).toBe(0);
    const lines = findings();
    expect(lines[0]).toMatchObject({ story: 'S-1', result: 'shipped', severity: 'blocker', round: 1, resolved: true, builder: 'developer' });
    expect(lines[1]).not.toHaveProperty('round');
    expect(lines[1]).not.toHaveProperty('resolved');
  });

  it('--builder writes the builder into each line', async () => {
    await run(['story', 'start', 'S-1']);
    const f = path.join(dir, 'f.json');
    fs.writeFileSync(f, JSON.stringify([{ stage: 'review', severity: 'major', rule: 'r' }, { stage: 'test', severity: 'minor', rule: 'q' }]));
    expect((await run(['story', 'end', 'failed', '', 'no', '--findings', f, '--builder', 'ui-builder'])).code).toBe(0);
    expect(findings().map((l) => l.builder)).toEqual(['ui-builder', 'ui-builder']);
  });

  it('without --builder the lines carry no builder', async () => {
    const f = path.join(dir, 'f.json');
    fs.writeFileSync(f, JSON.stringify([{ stage: 's' }]));
    await run(['story', 'end', 'failed', '--findings', f, '--story', 'S-7']);
    expect(findings()[0]).not.toHaveProperty('builder');
  });

  it('--story overrides the story id', async () => {
    const f = path.join(dir, 'f.json');
    fs.writeFileSync(f, JSON.stringify([{ stage: 's' }]));
    await run(['story', 'end', 'failed', '--findings', f, '--story', 'S-7']);
    expect(findings()[0].story).toBe('S-7');
  });

  it('a missing findings file warns but still records the end', async () => {
    await run(['story', 'start', 'S-1']);
    const { code, err } = await run(['story', 'end', 'failed', '--findings', path.join(dir, 'nope.json')]);
    expect(code).toBe(0);
    expect(err).toContain('findings');
    expect(slot().result.result).toBe('failed');
  });
});

describe('errors', () => {
  it('invalid config exits 1 with the error text', async () => {
    fs.writeFileSync(path.join(dir, 'foreman.config.json'), '{ nope');
    const { code, out } = await run(['story', 'next']);
    expect(code).toBe(1);
    expect(out.length).toBeGreaterThan(0);
  });

  it('unknown or missing sub prints usage and exits 64', async () => {
    expect((await run(['story'])).code).toBe(64);
    expect((await run(['story', 'wat'])).code).toBe(64);
  });
});

describe('foreman stage', () => {
  it('writes the stage to state', async () => {
    await run(['story', 'start', 'S-1']);
    expect((await run(['stage', 'build', 'round', '1'])).code).toBe(0);
    expect(slot().story).toMatchObject({ stage: 'build', detail: 'round 1' });
  });

  it('records the stages the page shows, commit and review among them', async () => {
    await run(['story', 'start', 'S-1']);
    for (const name of ['architect', 'build', 'test', 'review', 'commit', 'release']) {
      const { code, err } = await run(['stage', name]);
      expect(code).toBe(0);
      expect(err).toBe('');
      expect(slot().story.stage).toBe(name);
    }
  });

  it('records nothing for a name that is not a stage, says so and still exits 0', async () => {
    await run(['story', 'start', 'S-1']);
    await run(['stage', 'build', 'round', '1']);
    const before = fs.readFileSync(path.join(dir, '.foreman', 'slots', 'w1.json'), 'utf8');
    const eventsBefore = fs.existsSync(path.join(dir, '.foreman', 'events.jsonl')) ? fs.readFileSync(path.join(dir, '.foreman', 'events.jsonl'), 'utf8') : '';
    for (const name of ['x', 'Build', 'ship']) {
      const { code, err } = await run(['stage', name, 'detail']);
      expect(code).toBe(0);
      expect(err).toContain(`unknown stage "${name}"`);
      expect(err).toContain('architect, build, commit, release, review, test');
    }
    expect(fs.readFileSync(path.join(dir, '.foreman', 'slots', 'w1.json'), 'utf8')).toBe(before);
    expect(slot().story).toMatchObject({ stage: 'build', detail: 'round 1' });
    expect(fs.existsSync(path.join(dir, '.foreman', 'events.jsonl')) ? fs.readFileSync(path.join(dir, '.foreman', 'events.jsonl'), 'utf8') : '').toBe(eventsBefore);
  });

  it('never fails the caller', async () => {
    fs.writeFileSync(path.join(dir, 'foreman.config.json'), '{ nope');
    const { code, err } = await run(['stage', 'build']);
    expect(code).toBe(0);
    expect(err.length).toBeGreaterThan(0);
  });
});

describe('foreman story summary', () => {
  const withEpic = (extra = {}) => {
    fs.writeFileSync(
      path.join(dir, 'foreman.config.json'),
      JSON.stringify({ version: 1, project: { name: 'T' }, checks: [{ run: 'npm test', when: 'always' }], stories: { adapter: 'markdown', dir: 'stories', groupSummary: '../epics/{groupLabel} {group} - {groupName}.md', groupLabel: 'Phase', ...extra } }),
    );
    fs.mkdirSync(path.join(dir, 'epics'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'epics', 'Phase 1 - Start.md'), '# Phase 1\n');
    for (const id of ['S-1', 'S-2']) fs.writeFileSync(path.join(dir, 'stories', `${id}.md`), story(id, 'done', 'group: 1\ngroup_name: Start\n'));
  };

  it('prints the group, its summary file and its stories as one JSON line', async () => {
    withEpic();
    const { code, out } = await run(['story', 'summary', 'S-2']);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({
      group: '1',
      groupName: 'Start',
      groupLabel: 'Phase',
      path: path.join(dir, 'epics', 'Phase 1 - Start.md'),
      needed: true,
      stories: [{ id: 'S-1', title: 'Story S-1' }, { id: 'S-2', title: 'Story S-2' }],
    });
  });

  it('prints {"none":true} when summaries are not configured', async () => {
    expect((await run(['story', 'summary', 'S-1'])).out).toBe('{"none":true}\n');
  });
});

describe('foreman story start run again (FM-348)', () => {
  const stateDir = () => path.join(dir, '.foreman');
  const logOf = (slotName, stamp = '20261015-120000') => path.join(stateDir(), 'logs', `${slotName}-${stamp}.log`);
  const mark = (slotName, log, id = 'S-1') => markSession(stateDir(), slotName, { story: id, pid: 4242, log, projects: '/acme/projects' });
  async function start(argv, { slotName = 'w1', run: inRun = true, id = 'S-1' } = {}) {
    let out = '';
    let err = '';
    const env = { FOREMAN_PROJECT_DIR: dir, FOREMAN_SLOT: slotName, FOREMAN_STORY: id, ...(inRun ? { FOREMAN_RUN: '1' } : {}) };
    const code = await storyCommand.run(argv.slice(1), { root: dir, cwd: dir, env, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } }, now: () => NOW });
    return { code, out, err };
  }
  const events = () => fs.readFileSync(path.join(stateDir(), 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const starts = () => events().filter((e) => e.text.startsWith('Started S-1'));
  const slotOf = (name) => JSON.parse(fs.readFileSync(path.join(stateDir(), 'slots', `${name}.json`), 'utf8'));
  const notes = () => JSON.parse(fs.readFileSync(path.join(stateDir(), 'stories', 'S-1.json'), 'utf8')).notes;

  it('does nothing the second time in the same session', async () => {
    mark('w1', logOf('w1'));
    const first = await start(['story', 'start', 'S-1']);
    setStage(stateDir(), 'build', 'round 1', NOW, 'w1');
    const second = await start(['story', 'start', 'S-1']);
    expect(first).toEqual({ code: 0, out: '', err: '' });
    expect(second).toEqual({ code: 0, out: '', err: '' });
    expect(starts()).toHaveLength(1);
    expect(notes().filter((n) => n.text === 'Started.')).toHaveLength(1);
    expect(slotOf('w1').story).toMatchObject({ id: 'S-1', stage: 'build', detail: 'round 1', session: 'w1-20261015-120000.log' });
  });

  it('starts again in a different session of the same slot', async () => {
    mark('w1', logOf('w1'));
    await start(['story', 'start', 'S-1']);
    mark('w1', logOf('w1', '20261015-130000'));
    await start(['story', 'start', 'S-1']);
    expect(starts()).toHaveLength(2);
    expect(slotOf('w1').story).toMatchObject({ stage: 'architect', session: 'w1-20261015-130000.log' });
  });

  it('starts again from another slot', async () => {
    mark('w1', logOf('w1'));
    mark('w2', logOf('w2'));
    await start(['story', 'start', 'S-1']);
    await start(['story', 'start', 'S-1'], { slotName: 'w2' });
    expect(starts()).toHaveLength(2);
    expect(starts()[1].slot).toBe('w2');
    expect(slotOf('w1').story.id).toBe('S-1');
    expect(slotOf('w2').story.id).toBe('S-1');
  });

  it('starts again by hand, even with a mark naming the story', async () => {
    mark('w1', logOf('w1'));
    await start(['story', 'start', 'S-1'], { run: false });
    await start(['story', 'start', 'S-1'], { run: false });
    expect(starts()).toHaveLength(2);
    expect(slotOf('w1').story).not.toHaveProperty('session');
  });

  it('starts again when the mark names another story', async () => {
    mark('w1', logOf('w1'), 'S-2');
    await start(['story', 'start', 'S-1']);
    await start(['story', 'start', 'S-1']);
    expect(starts()).toHaveLength(2);
  });

  it('still exits 1 for an unknown id in a marked session, and writes no event', async () => {
    mark('w1', logOf('w1'));
    const { code, err } = await start(['story', 'start', 'S-99']);
    expect(code).toBe(1);
    expect(err).toContain('S-99');
    expect(fs.existsSync(path.join(stateDir(), 'events.jsonl'))).toBe(false);
  });
});

describe('foreman story note', () => {
  const PLAN = { ready: true, blocker: '', needs_owner: false, builder: 'developer', resources: [], files: ['plugin/lib/acme/orders.mjs'], design: 'Add an order queue.', test_plan: 'orders.test.mjs', done_when: 'npm test' };
  const planFile = (plan = PLAN) => {
    const file = path.join(dir, 'plan.json');
    fs.writeFileSync(file, JSON.stringify(plan));
    return file;
  };
  const lines = (id = 'S-1') => {
    const file = path.join(dir, '.foreman', 'stories', `${id}.json`);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).notes.map((n) => n.text) : [];
  };

  it('records the design once: a first run adds one line, a second adds none', async () => {
    const first = await run(['story', 'note', 'S-1', '--kind', 'design', '--file', planFile()]);
    expect(first).toMatchObject({ code: 0, out: 'Recorded the design on S-1.\n', err: '' });
    expect(lines()).toEqual(['Design: The architect chose the developer builder, whose work is: everything.']);
    const second = await run(['story', 'note', 'S-1', '--kind', 'design', '--file', planFile()]);
    expect(second).toMatchObject({ code: 0, out: 'The design on S-1 is already recorded.\n' });
    expect(lines()).toHaveLength(1);
  });

  it('records a changed plan as a revised design', async () => {
    await run(['story', 'note', 'S-1', '--kind', 'design', '--file', planFile()]);
    const revised = await run(['story', 'note', 'S-1', '--kind', 'design', '--file', planFile({ ...PLAN, design: 'Add an order queue.\nKeep it sorted.' })]);
    expect(revised).toMatchObject({ code: 0, out: 'Recorded the revised design on S-1.\n' });
    expect(lines()).toHaveLength(2);
    expect(lines()[0]).toMatch(/^Design \(revised\): /);
  });

  it('refuses a kind other than design (64), a missing kind or file, and an id with nothing to name', async () => {
    expect((await run(['story', 'note', 'S-1', '--kind', 'rounds', '--file', planFile()])).code).toBe(64);
    expect((await run(['story', 'note', 'S-1', '--file', planFile()])).code).toBe(64);
    expect((await run(['story', 'note', 'S-1', '--kind', 'design'])).code).toBe(64);
    expect((await run(['story', 'note', '--kind', 'design', '--file', planFile()])).code).toBe(64);
    expect(lines()).toEqual([]);
  });

  it('exits 1 for a file that is missing, is not JSON, or has no design', async () => {
    const missing = await run(['story', 'note', 'S-1', '--kind', 'design', '--file', path.join(dir, 'nope.json')]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('cannot read the plan');
    fs.writeFileSync(path.join(dir, 'bad.json'), 'not json');
    expect((await run(['story', 'note', 'S-1', '--kind', 'design', '--file', path.join(dir, 'bad.json')])).code).toBe(1);
    expect((await run(['story', 'note', 'S-1', '--kind', 'design', '--file', planFile({ ready: true })])).code).toBe(1);
    expect((await run(['story', 'note', 'S-1', '--kind', 'design', '--file', planFile([1])])).code).toBe(1);
    expect(lines()).toEqual([]);
  });

  it('exits 1 for a story the source does not know, and records nothing', async () => {
    const { code, err } = await run(['story', 'note', 'S-99', '--kind', 'design', '--file', planFile()]);
    expect(code).toBe(1);
    expect(err).toContain('does not know S-99');
    expect(lines('S-99')).toEqual([]);
  });

  it('says comments are off, exits 0 and adds no line', async () => {
    const file = path.join(dir, 'foreman.config.json');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), features: { jiraComments: false } }));
    const { code, out } = await run(['story', 'note', 'S-1', '--kind', 'design', '--file', planFile()]);
    expect(code).toBe(0);
    expect(out).toBe('Comments are off (features.jiraComments); nothing recorded.\n');
    expect(lines()).toEqual([]);
  });

  it('works for a session of the same story (FOREMAN_RUN=1), as the story skill runs it', async () => {
    let err = '';
    const env = { FOREMAN_PROJECT_DIR: dir, FOREMAN_SLOT: 'w1', FOREMAN_STORY: 'S-1', FOREMAN_RUN: '1' };
    const code = await storyCommand.run(['note', 'S-1', '--kind', 'design', '--file', planFile()], { root: dir, cwd: dir, env, stdout: { write: () => {} }, stderr: { write: (s) => { err += s; } }, now: () => NOW });
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(lines()).toHaveLength(1);
  });
});
