import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// renameSync counted, so a test can see how many times a decision file was written.
vi.mock('node:fs', async (load) => {
  const fs = await load();
  return { ...fs, renameSync: vi.fn(fs.renameSync) };
});

import { pendingNotes } from '../engine/story-notes-queue.mjs';
import { add, answer, applied, EXPLAIN_LABELS, EXPLAIN_PARTS, explainLine, explainProblems, list, pending } from './decisions.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foreman-decisions-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const t = (s) => new Date(`2026-10-15T09:00:${String(s).padStart(2, '0')}Z`);
const failed = { story: 'S-1', kind: 'decision', title: 'S-1 could not pass review', options: ['Retry with a note to the architect', "I'll take it", 'Drop'], body: 'findings' };

describe('decisions: the note on the story', () => {
  const entries = () => pendingNotes(dir).map((p) => p.entry);

  it('add leaves one decision note for its story, without the body', () => {
    const id = add(dir, { ...failed, summary: 'It failed review.', hints: ['a', 'b', 'c'], recommend: 'Drop', urgent: true, body: 'SECRET LONG BODY' }, t(1));
    const [entry] = entries();
    expect(entries()).toHaveLength(1);
    expect(entry).toMatchObject({ story: 'S-1', kind: 'decision', data: { id, kind: 'decision', title: failed.title, summary: 'It failed review.', options: failed.options, hints: ['a', 'b', 'c'], recommend: 'Drop', urgent: true } });
    expect(JSON.stringify(entry)).not.toContain('SECRET LONG BODY');
  });

  it('answer leaves one answer note with the option and the note', () => {
    const id = add(dir, failed, t(1));
    answer(dir, id, { option: 'Drop', note: 'not needed' }, t(2));
    const [, second] = entries();
    expect(entries()).toHaveLength(2);
    expect(second).toMatchObject({ story: 'S-1', kind: 'answer', data: { id, title: failed.title, option: 'Drop', note: 'not needed' } });
  });

  it('keeps the slot of the session that asked', () => {
    process.env.FOREMAN_SLOT = 'w3';
    try {
      add(dir, failed, t(1));
    } finally {
      delete process.env.FOREMAN_SLOT;
    }
    expect(entries()[0].slot).toBe('w3');
  });

  it('a broken story-notes folder (a file in its place) stops neither add nor answer', () => {
    writeFileSync(join(dir, 'story-notes'), 'not a folder');
    const id = add(dir, failed, t(1));
    expect(answer(dir, id, { option: 'Drop' }, t(2))).toEqual({ option: 'Drop', note: '' });
    expect(pending(dir)[0].answer.option).toBe('Drop');
  });
});

describe('decisions', () => {
  it('add writes one file named by its id, with no answer yet', () => {
    const id = add(dir, failed, t(1));
    expect(id).toMatch(/^d-20261015090001-[0-9a-f]{4}$/);
    expect(readdirSync(join(dir, 'decisions'))).toEqual([`${id}.json`]);
    const item = JSON.parse(readFileSync(join(dir, 'decisions', `${id}.json`), 'utf8'));
    expect(item).toMatchObject({ id, story: 'S-1', kind: 'decision', title: failed.title, options: failed.options, urgent: false, body: 'findings', createdAt: t(1).toISOString(), answer: null, appliedAt: null });
  });

  it('pending lists unapplied items oldest first, each with its answer or null', () => {
    const b = add(dir, { story: 'S-2', kind: 'task', title: 'Add the key' }, t(2));
    const a = add(dir, failed, t(1));
    expect(pending(dir).map((i) => [i.id, i.answer])).toEqual([
      [a, null],
      [b, null],
    ]);
  });

  it('an answer shows in pending until it is applied', () => {
    const id = add(dir, failed, t(1));
    answer(dir, id, { option: 'Drop', note: 'not needed' }, t(2));
    expect(pending(dir)[0].answer).toEqual({ option: 'Drop', note: 'not needed', at: t(2).toISOString() });
    applied(dir, id, t(3));
    expect(pending(dir)).toEqual([]);
    expect(list(dir)[0]).toMatchObject({ id, appliedAt: t(3).toISOString() });
  });

  it('answer with applied: true saves the answer and appliedAt in one write', () => {
    const id = add(dir, failed, t(1));
    const file = join(dir, 'decisions', `${id}.json`);
    renameSync.mockClear();
    expect(answer(dir, id, { option: 'Drop' }, t(2), { applied: true })).toEqual({ option: 'Drop', note: '' });
    expect(renameSync.mock.calls.filter(([, to]) => to === file)).toHaveLength(1);
    const item = JSON.parse(readFileSync(file, 'utf8'));
    expect(item.answer).toEqual({ option: 'Drop', note: '', at: t(2).toISOString() });
    expect(item.appliedAt).toBe(t(2).toISOString());
    expect(pending(dir)).toEqual([]);
    expect(() => answer(dir, id, { option: 'Drop' }, t(3))).toThrow(/already applied/);
    expect(() => answer(dir, id, { option: 'Drop' }, t(3), { applied: true })).toThrow(/already applied/);
  });

  it('answer without applied leaves appliedAt null, as before', () => {
    const id = add(dir, failed, t(1));
    answer(dir, id, { option: 'Drop' }, t(2), { applied: false });
    answer(dir, id, { option: "I'll take it" }, t(3));
    expect(pending(dir)[0]).toMatchObject({ id, appliedAt: null, answer: { option: "I'll take it" } });
  });

  it('answer with applied: true still refuses an option the item does not offer, and writes nothing', () => {
    const id = add(dir, failed, t(1));
    expect(() => answer(dir, id, { option: 'Maybe' }, t(2), { applied: true })).toThrow(/Maybe/);
    expect(pending(dir)[0]).toMatchObject({ answer: null, appliedAt: null });
  });

  it('refuses an option the item does not offer', () => {
    const id = add(dir, failed, t(1));
    expect(() => answer(dir, id, { option: 'Maybe' }, t(2))).toThrow(/Maybe/);
    expect(pending(dir)[0].answer).toBeNull();
  });

  it('a task takes a free note', () => {
    const id = add(dir, { story: 'S-2', kind: 'task', title: 'Add the key' }, t(1));
    answer(dir, id, { option: 'Added it to the env file' }, t(2));
    expect(pending(dir)[0].answer).toEqual({ option: null, note: 'Added it to the env file', at: t(2).toISOString() });
  });

  it('checks what it is given', () => {
    expect(() => add(dir, { ...failed, kind: 'wish' }, t(1))).toThrow(/kind/);
    expect(() => add(dir, { ...failed, title: '' }, t(1))).toThrow(/title/);
    expect(() => add(dir, { ...failed, options: ['ok', ''] }, t(1))).toThrow(/option/);
    expect(() => answer(dir, 'd-20261015090001-abcd', { option: 'Drop' }, t(2))).toThrow(/no decision/);
    expect(() => answer(dir, '../control', { option: 'Drop' }, t(2))).toThrow(/no decision/);
    expect(() => applied(dir, 'nope', t(2))).toThrow(/no decision/);
  });

  it('an empty or missing folder has nothing pending', () => {
    expect(list(dir)).toEqual([]);
    expect(pending(dir)).toEqual([]);
  });

  it('stores summary, hints and recommend', () => {
    const id = add(dir, { story: 'S-1', kind: 'decision', title: 'Which login?', options: ['Keep', 'Swap', 'Drop'], summary: ' Pick the login. ', hints: [' Fast.', 'Safe. ', 'Gone.'], recommend: ' Drop ' }, t(1));
    const item = JSON.parse(readFileSync(join(dir, 'decisions', `${id}.json`), 'utf8'));
    expect(item).toMatchObject({ summary: 'Pick the login.', hints: ['Fast.', 'Safe.', 'Gone.'], recommend: 'Drop' });
  });

  it('a plain add writes no new keys', () => {
    const id = add(dir, failed, t(1));
    const item = JSON.parse(readFileSync(join(dir, 'decisions', `${id}.json`), 'utf8'));
    for (const key of ['summary', 'hints', 'recommend']) expect(item, key).not.toHaveProperty(key);
    expect(Object.keys(item)).toEqual(['id', 'story', 'kind', 'title', 'options', 'urgent', 'body', 'createdAt', 'answer', 'appliedAt']);
  });

  it('checks summary, hints and recommend', () => {
    const three = { ...failed, options: ['A', 'B', 'C'] };
    expect(() => add(dir, { ...three, summary: 'x'.repeat(161) }, t(1))).toThrow(/160/);
    expect(() => add(dir, { ...three, summary: 'One line\nand another' }, t(1))).toThrow(/one line/);
    expect(() => add(dir, { ...three, summary: '   ' }, t(1))).toThrow(/one line/);
    expect(() => add(dir, { ...three, hints: ['a', 'b'] }, t(1))).toThrow(/one hint per option/);
    expect(() => add(dir, { ...three, hints: ['a', 'b'] }, t(1))).toThrow('Give one hint per option, or none: 3 options and 2 hints.');
    expect(() => add(dir, { ...failed, options: [], hints: ['a'] }, t(1))).toThrow(/one hint per option/);
    expect(() => add(dir, { ...three, hints: ['a', 'x'.repeat(101), 'c'] }, t(1))).toThrow(/100/);
    expect(() => add(dir, { ...three, hints: ['a', 'x'.repeat(101), 'c'] }, t(1))).toThrow(/^Hint 2 is 101 characters/);
    expect(() => add(dir, { ...three, hints: ['a', '', 'c'] }, t(1))).toThrow(/hint/);
    expect(() => add(dir, { ...three, hints: 'a' }, t(1))).toThrow(/hint/);
    expect(() => add(dir, { ...three, recommend: 'Maybe' }, t(1))).toThrow(/not one of the options/);
    expect(() => add(dir, { ...three, options: ['A', 'B'], recommend: 'Maybe' }, t(1))).toThrow('"Maybe" is not one of the options; recommend one of "A", "B".');
    expect(() => add(dir, { ...failed, options: [], recommend: 'A' }, t(1))).toThrow(/no options to recommend/);
    expect(existsSync(join(dir, 'decisions')) ? readdirSync(join(dir, 'decisions')) : []).toEqual([]);
  });

  it('an old file without the new fields still loads and answers', () => {
    const id = 'd-20261015090000-abcd';
    mkdirSync(join(dir, 'decisions'));
    const old = { id, story: 'S-1', kind: 'decision', title: 'Retry?', options: ['Retry', 'Drop'], urgent: false, body: 'findings', createdAt: t(0).toISOString(), answer: null, appliedAt: null };
    writeFileSync(join(dir, 'decisions', `${id}.json`), JSON.stringify(old, null, 2));
    expect(list(dir)).toEqual([old]);
    expect(answer(dir, id, { option: 'Drop' }, t(2))).toEqual({ option: 'Drop', note: '' });
    applied(dir, id, t(3));
    const [item] = list(dir);
    expect(item).toEqual({ ...old, answer: { option: 'Drop', note: '', at: t(2).toISOString() }, appliedAt: t(3).toISOString() });
  });

  const explained = {
    story: 'ACME-12',
    kind: 'decision',
    title: 'ACME-12 could not pass review',
    options: ['Retry with a note to the architect', "I'll take it", 'Drop'],
    hints: ['Builds it again with your note.', 'You finish it yourself.', 'Stops all work on it.'],
    recommend: 'Retry with a note to the architect',
  };
  const plain = { purpose: ' Keeps the keys apart. ', happened: ' A test step could change the real key file. ', damage: ' No; the real file is unchanged. ', recommendation: ' Retry: the fix is small. ' };
  const folder = () => (existsSync(join(dir, 'decisions')) ? readdirSync(join(dir, 'decisions')) : []);

  it('stores explain', () => {
    const id = add(dir, { ...explained, explain: plain }, t(1));
    const item = JSON.parse(readFileSync(join(dir, 'decisions', `${id}.json`), 'utf8'));
    expect(item.explain).toEqual({ purpose: 'Keeps the keys apart.', happened: 'A test step could change the real key file.', damage: 'No; the real file is unchanged.', recommendation: 'Retry: the fix is small.' });
    expect(Object.keys(item.explain)).toEqual(['purpose', 'happened', 'damage', 'recommendation']);
    expect(Object.keys(item).at(-1)).toBe('explain');
    const { damage, ...noDamage } = plain;
    const other = add(dir, { ...explained, explain: noDamage }, t(2));
    const second = JSON.parse(readFileSync(join(dir, 'decisions', `${other}.json`), 'utf8'));
    expect(second.explain).not.toHaveProperty('damage');
    expect(Object.keys(second.explain)).toEqual(['purpose', 'happened', 'recommendation']);
  });

  it('checks explain', () => {
    const bad = (explain, more = {}) => () => add(dir, { ...explained, ...more, explain }, t(1));
    expect(bad('Keeps the keys apart.')).toThrow(/explanation/i);
    expect(bad(['a'])).toThrow(/explanation/i);
    expect(bad({ ...plain, why: 'x' })).toThrow(/why/);
    for (const part of ['purpose', 'happened', 'recommendation']) {
      const { [part]: gone, ...rest } = plain;
      expect(bad(rest), part).toThrow(new RegExp(part));
      expect(bad({ ...rest, [part]: '  ' }), part).toThrow(new RegExp(part));
    }
    expect(bad({ damage: 'x' })).toThrow(/purpose.*happened.*recommendation/);
    expect(bad({ ...plain, damage: 42 })).toThrow(/damage/);
    expect(bad({ ...plain, happened: 'One line\nand another' })).toThrow(/one line/);
    expect(bad({ ...plain, purpose: 'One line\rand another' })).toThrow(/one line/);
    expect(bad({ ...plain, happened: 'x'.repeat(281) })).toThrow(/280/);
    expect(bad({ ...plain, happened: 'x'.repeat(281) })).toThrow('The explain part "happened" is 281 characters; keep each part to 280 or fewer.');
    expect(bad(plain, { options: ['A', 'B', 'C'], hints: [], recommend: undefined })).toThrow(/one hint per option/);
    expect(folder()).toEqual([]);
    expect(add(dir, { ...explained, explain: { ...plain, happened: 'x'.repeat(280) } }, t(1))).toMatch(/^d-/);
  });

  it('names the explain parts and labels them', () => {
    expect(EXPLAIN_PARTS).toEqual(['purpose', 'happened', 'damage', 'recommendation']);
    expect(EXPLAIN_LABELS).toEqual({ purpose: 'What this story is for', happened: 'What happened', damage: 'Is anything damaged?', recommendation: 'Recommendation' });
    expect(explainLine('happened', 'It broke.')).toBe('What happened: It broke.');
    expect(explainLine('damage', 'No.')).toBe('Is anything damaged? No.');
  });

  it('explainProblems flags a path, a variable name, a call and an over-long part', () => {
    const one = (text, part = 'happened') => explainProblems({ [part]: text });
    for (const found of ['.env.local', 'plugin/lib/x.mjs', 'decisions.mjs', '/etc/hosts', './run', '~/notes', 'src/app/main', 'docs/plan.txt']) {
      expect(one(`It changed ${found} today.`), found).toEqual([expect.objectContaining({ part: 'happened', kind: 'path', found })]);
    }
    expect(one('It read .gitignore first.')[0]).toMatchObject({ kind: 'path', found: '.gitignore' });
    for (const found of ['FOREMAN_PROJECT_DIR', '$HOME']) {
      expect(one(`It used ${found} there.`, 'purpose'), found).toEqual([expect.objectContaining({ part: 'purpose', kind: 'variable', found })]);
    }
    expect(one('It calls keysMigrate() first.', 'damage')).toEqual([expect.objectContaining({ part: 'damage', kind: 'call', found: 'keysMigrate()' })]);
    expect(one('It calls fs.readFile(x) first.')).toEqual([expect.objectContaining({ kind: 'call', found: 'fs.readFile(x)' })]);
    expect(one('x'.repeat(281), 'recommendation')).toEqual([expect.objectContaining({ part: 'recommendation', kind: 'long' })]);
    expect(one('x'.repeat(280))).toEqual([]);
    expect(one('It changed .env.local today.')[0].message).toBe('What happened has a file path (".env.local"); say it in plain words and keep the detail in the body.');
    const both = explainProblems({ happened: 'FOREMAN_PROJECT_DIR pointed at .env.local.' });
    expect(both.map((p) => p.kind).sort()).toEqual(['path', 'variable']);
    for (const p of both) expect(p.message).toContain(p.found);
    for (const found of ['README.md', 'CLAUDE.md', 'app.js', 'src/Node.js', './Node.js', '.env']) {
      expect(one(`It changed ${found} today.`), found).toEqual([expect.objectContaining({ kind: 'path', found })]);
    }
    expect(explainProblems({ happened: 'The Node.js check changed .env.local.' })).toEqual([expect.objectContaining({ kind: 'path', found: '.env.local' })]);
  });

  it('explainProblems lets plain words through', () => {
    for (const text of ['Pick one and/or the other.', 'ACME-12 is next.', 'Use a sandbox, e.g. the QA one.', 'It takes 3.5 hours.', 'CI and the PR are green.', 'Two finding(s) and three fix(es) stay open.',
      'The Node.js app is fine.', 'It moved to .NET and ASP.NET.', "It's a .NET project (.NET 8).", 'Built on Next.js, Vue.js and Express.js.', 'It uses node.js too.']) {
      expect(explainProblems({ purpose: text, happened: text, damage: text, recommendation: text }), text).toEqual([]);
    }
    expect(explainProblems({
      purpose: "Keep Foreman's own keys in a separate file that the building agents never see.",
      happened: "The reviewers found one serious problem: a test step could change the real project's key file instead of a throwaway copy.",
      damage: 'No. The real key file was checked afterwards and is unchanged.',
      recommendation: 'Retry with a note to the architect: the fix is small and clear, and nothing was damaged.',
    })).toEqual([]);
    expect(explainProblems(undefined)).toEqual([]);
    expect(explainProblems({ happened: 42 })).toEqual([]);
  });

  it('two items added in the same second get different ids', () => {
    const ids = new Set(Array.from({ length: 20 }, () => add(dir, failed, t(1))));
    expect(ids.size).toBe(20);
  });
});

describe('decisions read through the cache', () => {
  const file = (id) => join(dir, 'decisions', `${id}.json`);
  const backdate = (path) => utimesSync(path, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));

  it('shows an answer another writer put in a decision file by temp file and rename', () => {
    const id = add(dir, failed, t(1));
    backdate(file(id));
    backdate(join(dir, 'decisions'));
    expect(pending(dir)[0].answer).toBeNull();
    const item = JSON.parse(readFileSync(file(id), 'utf8'));
    writeFileSync(`${file(id)}.7.tmp`, JSON.stringify({ ...item, answer: { option: 'Drop', note: '', at: t(2).toISOString() } }, null, 2));
    renameSync(`${file(id)}.7.tmp`, file(id));
    expect(pending(dir)[0].answer.option).toBe('Drop');
  });

  it('shows a decision added after a list', () => {
    const first = add(dir, failed, t(1));
    backdate(file(first));
    backdate(join(dir, 'decisions'));
    expect(list(dir)).toHaveLength(1);
    add(dir, failed, t(2));
    expect(list(dir)).toHaveLength(2);
  });

  it('leaves out a file that is not JSON, and gives each call its own objects', () => {
    const id = add(dir, failed, t(1));
    writeFileSync(file('d-20261015090000-ffff'), '{nope');
    backdate(file(id));
    backdate(join(dir, 'decisions'));
    list(dir)[0].options.push('mutated');
    expect(list(dir).map((i) => i.id)).toEqual([id]);
    expect(list(dir)[0].options).toEqual(failed.options);
  });
});
