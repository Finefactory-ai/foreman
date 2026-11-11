import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noteKey } from '../../engine/story-notes-queue.mjs';
import { main } from '../main.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foreman-cli-decide-'));
  writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'T' }, checks: [{ run: 'true', when: 'always' }] }));
  // The stories the items are about: a decision is also written on its story, and a story the source
  // does not know would leave an event of its own, which these tests count.
  mkdirSync(join(dir, 'stories'));
  for (const id of ['S-1', 'ACME-12']) writeFileSync(join(dir, 'stories', `${id}.md`), `---\nid: ${id}\ntitle: Story ${id}\nstatus: todo\n---\n\n## Progress notes\n`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function run(argv, at = '2026-10-15T09:00:00Z') {
  let out = '';
  let err = '';
  const code = await main(argv, {
    cwd: dir,
    env: { FOREMAN_PROJECT_DIR: dir },
    now: () => new Date(at),
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
  });
  return { code, out, err };
}

const addFailed = () =>
  run(['decide', 'add', '--story', 'S-1', '--kind', 'decision', '--title', 'S-1 could not pass review', '--body', 'two findings; draft PR https://x/pr/1', '--option', 'Retry with a note to the architect', '--option', "I'll take it", '--option', 'Drop']);

describe('foreman decide: the story hears of it', () => {
  const overlay = () => {
    const file = join(dir, '.foreman', 'stories', 'S-1.json');
    try {
      return JSON.parse(readFileSync(file, 'utf8')).notes.map((n) => n.text);
    } catch {
      return [];
    }
  };

  it('add and answer each leave one progress line on the story, and print only what they always did', async () => {
    const a = await addFailed();
    expect(a.out).toMatch(/^d-\d{14}-[0-9a-f]{4}\n$/);
    expect(a.err).toBe('');
    expect(overlay()).toEqual(['The owner was asked: S-1 could not pass review']);
    const answered = await run(['decide', 'answer', a.out.trim(), 'Drop', '--note', 'not needed']);
    expect(answered.out).toBe(`${a.out.trim()} answered: Drop\n`);
    expect(overlay()).toHaveLength(2);
    expect(overlay()[0]).toMatch(/^The owner answered: S-1 could not pass review: They chose "Drop"/);
  });

  it('answer --bundle leaves exactly one answer note per bundled item, posted by the command', async () => {
    const follow = (at) =>
      run(['decide', 'add', '--story', 'S-1', '--kind', 'decision', '--title', 'Follow up on S-1: 3 minor finding(s)?', '--option', 'Create a follow-up story', '--option', 'Ignore'], at);
    const a = (await follow('2026-10-15T09:00:00Z')).out.trim();
    const b = (await follow('2026-10-15T09:00:01Z')).out.trim();
    const r = await run(['decide', 'answer', '--bundle', 'follow-ups', 'Create a follow-up story']);
    expect(r.code).toBe(0);
    const starting = (text) => overlay().filter((l) => l.startsWith(text));
    expect(starting('The owner answered: Follow up on S-1')).toHaveLength(2);
    expect(starting('The owner was asked:')).toHaveLength(2);
    const keys = JSON.parse(readFileSync(join(dir, '.foreman', 'story-notes', 'posted', 'S-1.json'), 'utf8')).keys;
    for (const id of [a, b]) {
      const key = noteKey('answer', { id, option: 'Create a follow-up story', note: '' });
      expect(keys.filter((k) => k === key)).toHaveLength(1);
    }
    let queued = [];
    try {
      queued = readdirSync(join(dir, '.foreman', 'story-notes', 'pending'));
    } catch {
      // no folder: nothing is queued
    }
    expect(queued).toEqual([]);
    const again = await run(['decide', 'answer', '--bundle', 'follow-ups', 'Create a follow-up story']);
    expect(again.out).toBe('Nothing left to answer here.\n');
    expect(overlay()).toHaveLength(4);
  });

  it('writes nothing on the story with jiraComments off', async () => {
    writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'T' }, checks: [{ run: 'true', when: 'always' }], features: { jiraComments: false } }));
    await addFailed();
    expect(overlay()).toEqual([]);
  });
});

describe('foreman decide', () => {
  it('add prints the id, pending lists the item', async () => {
    const a = await addFailed();
    expect(a.code).toBe(0);
    const id = a.out.trim();
    expect(id).toMatch(/^d-20261015090000-[0-9a-f]{4}$/);
    const p = await run(['decide', 'pending']);
    expect(p.code).toBe(0);
    const items = JSON.parse(p.out);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id, story: 'S-1', kind: 'decision', options: ['Retry with a note to the architect', "I'll take it", 'Drop'], urgent: false, answer: null });
  });

  it('after answer, pending carries the answer; after applied, nothing', async () => {
    const id = (await addFailed()).out.trim();
    const ans = await run(['decide', 'answer', id, 'Retry with a note to the architect', '--note', 'Use the existing table']);
    expect(ans.code).toBe(0);
    expect(ans.out.trim().split('\n')).toHaveLength(1);
    const items = JSON.parse((await run(['decide', 'pending'])).out);
    expect(items[0].answer).toMatchObject({ option: 'Retry with a note to the architect', note: 'Use the existing table' });
    const done = await run(['decide', 'applied', id]);
    expect(done.code).toBe(0);
    expect(JSON.parse((await run(['decide', 'pending'])).out)).toEqual([]);
  });

  it('answering with an option not in the list exits 1', async () => {
    const id = (await addFailed()).out.trim();
    const r = await run(['decide', 'answer', id, 'Maybe later']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Maybe later/);
    expect(JSON.parse((await run(['decide', 'pending'])).out)[0].answer).toBeNull();
  });

  it('a task, urgent, answered with free text', async () => {
    const a = await run(['decide', 'add', '--story', 'S-2', '--kind', 'task', '--urgent', '--title', 'S-2 stopped the release line', '--body', '{"stage":"deploy"}']);
    const id = a.out.trim();
    expect((await run(['decide', 'answer', id, 'Rolled back by hand'])).code).toBe(1);
    expect(JSON.parse((await run(['decide', 'pending'])).out)[0].answer).toBeNull();
    expect((await run(['decide', 'answer', id, 'Close the task', '--note', 'Rolled back by hand'])).code).toBe(0);
    const [item] = JSON.parse((await run(['decide', 'pending'])).out);
    expect(item).toMatchObject({ kind: 'task', urgent: true, body: 'The release failed at deploy.', answer: { option: 'Close the task', note: 'Rolled back by hand' } });
  });

  it('a task offers both options, and list prints each with its hint under it', async () => {
    const a = await run(['decide', 'add', '--story', 'S-2', '--kind', 'task', '--title', 'Add the key']);
    expect(a.code).toBe(0);
    const lines = (await run(['decide', 'list'])).out.split('\n');
    const retry = lines.indexOf('      - Retry the story');
    const close = lines.indexOf('      - Close the task');
    expect(retry).toBeGreaterThan(-1);
    expect(close).toBe(retry + 2);
    expect(lines[retry + 1]).toContain('Puts the story back in line with your note, so it is built again.');
    expect(lines[close + 1]).toContain('Marks this task done and leaves the story as it is, even when it is blocked.');
  });

  it('a task added with an option exits 1', async () => {
    const r = await run(['decide', 'add', '--story', 'S-2', '--kind', 'task', '--title', 'Add the key', '--option', 'x']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/always offers/);
    expect((await run(['decide', 'list'])).out).toBe('Nothing has been asked of you.\n');
  });

  it('a body that is a ship JSON line is stored as its reason and pull request, with no brace', async () => {
    const R = 'qa (acme-qa) was rolled back with `foreman sf rollback "$FOREMAN_STORY"`. ./watch.sh reported a problem after the deploy: 3 new errors';
    const line = JSON.stringify({ ok: false, code: 5, sfDelta: { dir: '/tmp/acme-delta', from: 'a'.repeat(40), to: 'b'.repeat(40) }, stage: 'watch', reason: R, rolledBack: true, pr: 'https://github.com/acme/acme/pull/5' });
    const a = await run(['decide', 'add', '--story', 'S-1', '--kind', 'task', '--urgent', '--title', 'S-1 stopped the release line', '--body', line]);
    expect(a.code).toBe(0);
    const [item] = JSON.parse((await run(['decide', 'pending'])).out);
    expect(item.body).toBe(`${R}\n\nPull request: https://github.com/acme/acme/pull/5`);
    expect(item.body).not.toContain('{');
  });

  it('a plain-text body is stored unchanged', async () => {
    const a = await run(['decide', 'add', '--story', 'S-1', '--kind', 'task', '--title', 'S-1 stopped the release line', '--body', 'Rolled back {by hand}; see the PR.']);
    expect(a.code).toBe(0);
    expect(JSON.parse((await run(['decide', 'pending'])).out)[0].body).toBe('Rolled back {by hand}; see the PR.');
  });

  it('list shows each item in words', async () => {
    const id = (await addFailed()).out.trim();
    const r = await run(['decide', 'list']);
    expect(r.code).toBe(0);
    expect(r.out).toContain(id);
    expect(r.out).toContain('S-1 could not pass review');
    expect(r.out).toMatch(/waiting/i);
  });

  const addHinted = (...more) =>
    run(['decide', 'add', '--story', 'S-1', '--kind', 'decision', '--title', 'S-1 could not pass review', '--summary', 'Two findings.', '--option', 'A', '--hint', 'Ships it.', '--option', 'B', '--hint', 'Drops it.', '--recommend', 'B', ...more]);

  it('add takes --summary, --hint and --recommend', async () => {
    const a = await addHinted();
    expect(a.code).toBe(0);
    const [item] = JSON.parse((await run(['decide', 'pending'])).out);
    expect(item).toMatchObject({ id: a.out.trim(), options: ['A', 'B'], summary: 'Two findings.', hints: ['Ships it.', 'Drops it.'], recommend: 'B' });
  });

  it('list prints the summary, (recommended) and each hint', async () => {
    await addHinted();
    const lines = (await run(['decide', 'list'])).out.split('\n');
    expect(lines).toContain('    Two findings.');
    expect(lines).toContain('      - B (recommended)');
    expect(lines).toContain('      - A');
    expect(lines[lines.indexOf('      - A') + 1]).toContain('Ships it.');
    expect(lines[lines.indexOf('      - B (recommended)') + 1]).toContain('Drops it.');
    expect(lines).not.toContain('    options: A | B');
  });

  it('a bad hint count or recommend exits 1 in words', async () => {
    const once = await run(['decide', 'add', '--story', 'S-1', '--kind', 'decision', '--title', 'Pick', '--option', 'A', '--hint', 'Ships it.', '--option', 'B']);
    expect(once.code).toBe(1);
    expect(once.err).toMatch(/one hint per option/);
    const c = await run(['decide', 'add', '--story', 'S-1', '--kind', 'decision', '--title', 'Pick', '--option', 'A', '--option', 'B', '--recommend', 'C']);
    expect(c.code).toBe(1);
    expect(c.err).toMatch(/not one of the options/);
    expect((await run(['decide', 'list'])).out).toBe('Nothing has been asked of you.\n');
  });

  const explainArgs = (...more) => [
    'decide', 'add', '--story', 'ACME-12', '--kind', 'decision', '--title', 'ACME-12 could not pass review', '--summary', 'A test step could change the real key file.',
    '--body', 'keys migrate resolves the root from FOREMAN_PROJECT_DIR',
    '--option', 'Retry with a note to the architect', '--hint', 'Builds it again with your note.',
    '--option', "I'll take it", '--hint', 'You finish it yourself.',
    '--option', 'Drop', '--hint', 'Stops all work on it.',
    '--recommend', 'Retry with a note to the architect',
    '--purpose', 'Keeps the factory keys away from the building agents.',
    '--happened', 'A test step could change the real key file.',
    '--damage', 'No; the real key file is unchanged.',
    '--recommendation', 'Retry with a note to the architect: the fix is small.',
    ...more,
  ];
  const events = () => {
    try {
      return readFileSync(join(dir, '.foreman', 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  const without = (args, flag) => {
    const at = args.indexOf(flag);
    return [...args.slice(0, at), ...args.slice(at + 2)];
  };

  it('add takes --purpose, --happened, --damage and --recommendation as explain', async () => {
    const a = await run(explainArgs());
    expect(a.code).toBe(0);
    expect(a.err).toBe('');
    expect(a.out).toMatch(/^d-\S+\n$/);
    const [item] = await pending();
    expect(item.explain).toEqual({ purpose: 'Keeps the factory keys away from the building agents.', happened: 'A test step could change the real key file.', damage: 'No; the real key file is unchanged.', recommendation: 'Retry with a note to the architect: the fix is small.' });
    expect(events()).toEqual([]);
  });

  it('list prints the explanation under the summary, then Your options', async () => {
    await run(explainArgs());
    const lines = (await run(['decide', 'list'])).out.split('\n');
    const at = lines.indexOf('    A test step could change the real key file.');
    expect(at).toBeGreaterThan(-1);
    expect(lines.slice(at + 1, at + 13)).toEqual([
      '    What this story is for: Keeps the factory keys away from the building agents.',
      '    What happened: A test step could change the real key file.',
      '    Is anything damaged? No; the real key file is unchanged.',
      '    Recommendation: Retry with a note to the architect: the fix is small.',
      '    Your options:',
      '      - Retry with a note to the architect (recommended)',
      '          Builds it again with your note.',
      "      - I'll take it",
      '          You finish it yourself.',
      '      - Drop',
      '          Stops all work on it.',
      '',
    ]);
    expect(lines).not.toContain('    options:');
  });

  it('an explanation without damage leaves its line out', async () => {
    await run(without(explainArgs(), '--damage'));
    const out = (await run(['decide', 'list'])).out;
    expect(out).not.toContain('Is anything damaged?');
    expect(out).toContain('    What happened: A test step could change the real key file.\n    Recommendation: ');
    expect((await pending())[0].explain).not.toHaveProperty('damage');
  });

  it('warns about a path or a variable name in the explanation, and still adds it', async () => {
    const args = explainArgs();
    args[args.indexOf('--happened') + 1] = 'The check read FOREMAN_PROJECT_DIR and changed .env.local.';
    const a = await run(args, '2026-10-15T09:00:00Z');
    expect(a.code).toBe(0);
    expect(a.out).toMatch(/^d-\S+\n$/);
    const warnings = a.err.trim().split('\n');
    expect(warnings).toHaveLength(2);
    for (const w of warnings) expect(w).toMatch(/^warning: What happened has /);
    expect(a.err).toContain('FOREMAN_PROJECT_DIR');
    expect(a.err).toContain('.env.local');
    expect(await pending()).toHaveLength(1);
    const warns = events().filter((e) => e.kind === 'warn');
    expect(warns).toHaveLength(2);
    for (const e of warns) expect(e.text).toMatch(/^ACME-12: What happened has /);
  });

  it('stays quiet about product names such as Node.js and .NET in the explanation', async () => {
    const args = explainArgs();
    args[args.indexOf('--happened') + 1] = 'The Node.js app on .NET failed its check.';
    const a = await run(args);
    expect(a.code).toBe(0);
    expect(a.err).toBe('');
    expect(events().filter((e) => e.kind === 'warn')).toEqual([]);
    expect(await pending()).toHaveLength(1);
  });

  it('refuses an explanation that is incomplete, too long, or has no hints', async () => {
    const missing = await run(without(explainArgs(), '--happened'));
    expect(missing.code).toBe(1);
    expect(missing.err).toMatch(/happened/);
    const long = explainArgs();
    long[long.indexOf('--purpose') + 1] = 'x'.repeat(281);
    const tooLong = await run(long);
    expect(tooLong.code).toBe(1);
    expect(tooLong.err).toMatch(/280/);
    const bare = explainArgs().filter((a, i, all) => a !== '--hint' && all[i - 1] !== '--hint');
    const noHints = await run(bare);
    expect(noHints.code).toBe(1);
    expect(noHints.err).toMatch(/one hint per option/);
    expect(await pending()).toEqual([]);
    expect(events()).toEqual([]);
  });

  it('an old decision file lists and answers exactly as before', async () => {
    const id = 'd-20261015090000-abcd';
    const folder = join(dir, '.foreman', 'decisions');
    mkdirSync(folder, { recursive: true });
    const title = 'S-1 could not pass review';
    writeFileSync(join(folder, `${id}.json`), JSON.stringify({ id, story: 'S-1', kind: 'decision', title, options: ['Retry', 'Drop'], urgent: false, body: 'two findings', createdAt: '2026-10-15T09:00:00.000Z', answer: null, appliedAt: null }, null, 2));
    const text = `${id}  decision for S-1: ${title}  [waiting]\n    options: Retry | Drop\n`;
    const l = await run(['decide', 'list', '--all']);
    expect(l.code).toBe(0);
    expect(l.out).toBe(text);
    const open = await run(['decide', 'list']);
    expect(open.code).toBe(0);
    expect(open.out).toBe(`Needs you now (1):\n${text}`);
    const a = await run(['decide', 'answer', id, 'Drop']);
    expect(a.code).toBe(0);
    expect(a.out).toContain('answered: Drop');
    const [item] = JSON.parse((await run(['decide', 'pending'])).out);
    expect(item.id).toBe(id);
    for (const key of ['summary', 'hints', 'recommend']) expect(item, key).not.toHaveProperty(key);
  });

  const addFollowUp = (story, options = ['Create a follow-up story', 'Ignore']) =>
    run(['decide', 'add', '--story', story, '--kind', 'decision', '--title', `Follow up on ${story}: 3 minor finding(s)?`, ...options.flatMap((o) => ['--option', o])]);
  const plainArgs = (...more) => ['decide', 'add', '--story', 'S-7', '--kind', 'decision', '--title', 'Which login?', '--option', 'Email', '--option', 'SSO', ...more];
  const addPlain = (...more) => run(plainArgs(...more));
  const addPlainAt = (at, ...more) => run(plainArgs(...more), at);
  const pending = async () => JSON.parse((await run(['decide', 'pending'])).out);

  it('list hides applied items unless --all', async () => {
    const one = (await addFailed()).out.trim();
    const two = (await addPlain()).out.trim();
    await run(['decide', 'answer', one, 'Drop']);
    await run(['decide', 'applied', one]);
    const l = await run(['decide', 'list']);
    expect(l.code).toBe(0);
    expect(l.out).not.toContain(one);
    expect(l.out).toContain(two);
    expect(l.out).toContain('Needs you now (1):\n');
    const all = await run(['decide', 'list', '--all']);
    expect(all.out).toContain(two);
    expect(all.out).toMatch(new RegExp(`${one} .*\\[applied\\]`));
    await run(['decide', 'answer', two, 'SSO']);
    await run(['decide', 'applied', two]);
    expect((await run(['decide', 'list'])).out).toBe('Nothing waits on you. `foreman decide list --all` shows the 2 answered before.\n');
  });

  it('list says "the one answered before" when one item was answered', async () => {
    const id = (await addFailed()).out.trim();
    await run(['decide', 'answer', id, 'Drop']);
    await run(['decide', 'applied', id]);
    const l = await run(['decide', 'list']);
    expect(l.code).toBe(0);
    expect(l.out).toBe('Nothing waits on you. `foreman decide list --all` shows the one answered before.\n');
  });

  it('list groups follow-ups under Quick decisions with the command', async () => {
    await addFollowUp('S-1');
    await addFollowUp('S-2');
    const review = (await addFailed()).out.trim();
    const out = (await run(['decide', 'list'])).out;
    const now = out.indexOf('Needs you now (1):\n');
    const quick = out.indexOf('Quick decisions (1):\n');
    expect(now).toBeGreaterThan(-1);
    expect(quick).toBeGreaterThan(now);
    expect(out.indexOf(review)).toBeGreaterThan(now);
    expect(out.indexOf(review)).toBeLessThan(quick);
    const lines = out.split('\n');
    const bundle = lines[lines.indexOf('Quick decisions (1):') + 1];
    expect(bundle).toContain('2 follow-ups');
    expect(bundle).toContain('foreman decide answer --bundle follow-ups "Create a follow-up story"');
    expect(out.slice(quick)).toContain('Follow up on S-1: 3 minor finding(s)?');
    expect(out.slice(quick)).toContain('Follow up on S-2: 3 minor finding(s)?');
  });

  it('list shows a dependency note Foreman added under FYI, not under Needs you now', async () => {
    const review = (await addFailed()).out.trim();
    const answered = (await addPlain()).out.trim();
    expect((await run(['decide', 'answer', answered, 'Email'])).code).toBe(0);
    const note = (await run(['decide', 'add', '--story', 'S-3', '--kind', 'decision', '--title', 'S-3 now waits for S-1', '--summary', 'S-3 now waits for S-1: S-1 must land first', '--option', 'Undo', '--option', 'Keep'])).out.trim();
    const out = (await run(['decide', 'list'])).out;
    const now = out.indexOf('Needs you now (1):\n');
    const fyi = out.indexOf('FYI (1):\n');
    const done = out.indexOf('Answered, not yet applied (1):\n');
    expect(now).toBeGreaterThan(-1);
    expect(fyi).toBeGreaterThan(now);
    expect(done).toBeGreaterThan(fyi);
    expect(out.indexOf(review)).toBeLessThan(fyi);
    expect(out.slice(fyi, done)).toContain(`${note}  decision for S-3: S-3 now waits for S-1  [waiting]`);
    expect(out.slice(fyi, done)).toContain('options: Undo | Keep');
  });

  it('list shows a change Foreman learned under FYI, not under Needs you now', async () => {
    const review = (await addFailed()).out.trim();
    const note = (await run(['decide', 'add', '--story', 'S-3', '--kind', 'decision', '--title', 'Foreman learned L-1 for developer', '--summary', 'developer: Acme: test every route', '--option', 'Undo the change', '--option', 'Keep the change'])).out.trim();
    const out = (await run(['decide', 'list'])).out;
    const now = out.indexOf('Needs you now (1):\n');
    const fyi = out.indexOf('FYI (1):\n');
    expect(now).toBeGreaterThan(-1);
    expect(fyi).toBeGreaterThan(now);
    expect(out.indexOf(review)).toBeLessThan(fyi);
    expect(out.slice(fyi)).toContain(`${note}  decision for S-3: Foreman learned L-1 for developer  [waiting]`);
    expect(out.slice(fyi)).toContain('options: Undo the change | Keep the change');
  });

  it('list puts answered, not yet applied, items last', async () => {
    const answered = (await addFailed()).out.trim();
    const waiting = (await addPlain()).out.trim();
    await run(['decide', 'answer', answered, 'Drop']);
    const out = (await run(['decide', 'list'])).out;
    const at = out.indexOf('Answered, not yet applied (1):\n');
    expect(at).toBeGreaterThan(out.indexOf(waiting));
    expect(out.slice(at)).toMatch(new RegExp(`${answered} .*\\[answered: Drop\\]`));
  });

  it('list ranks like the tab', async () => {
    // The urgent one is added a second later, so list() alone puts it second;
    // only the tab's ranking can put it first.
    const plain = (await addPlain()).out.trim();
    const urgent = (await addPlainAt('2026-10-15T09:00:01Z', '--urgent')).out.trim();
    const all = (await run(['decide', 'list', '--all'])).out;
    expect(all.indexOf(plain)).toBeLessThan(all.indexOf(urgent));
    const out = (await run(['decide', 'list'])).out;
    expect(out.startsWith('Needs you now (2):\n')).toBe(true);
    expect(out.indexOf(plain)).toBeGreaterThan(-1);
    expect(out.indexOf(urgent)).toBeGreaterThan(-1);
    expect(out.indexOf(urgent)).toBeLessThan(out.indexOf(plain));
  });

  it('answer --bundle answers every item and reports failures', async () => {
    const a = (await addFollowUp('S-1')).out.trim();
    const bad = (await addFollowUp('S-2', ['Yes', 'No'])).out.trim();
    const b = (await addFollowUp('S-3')).out.trim();
    const plain = (await addPlain()).out.trim();
    const r = await run(['decide', 'answer', '--bundle', 'follow-ups', 'Create a follow-up story']);
    expect(r.code).toBe(1);
    expect(r.out.startsWith('Answered 2; 1 could not be answered.\n')).toBe(true);
    expect(r.out).toContain(`  ${a} answered: Create a follow-up story\n`);
    expect(r.out).toContain(`  ${b} answered: Create a follow-up story\n`);
    expect(r.err).toContain(bad);
    const byId = new Map((await pending()).map((i) => [i.id, i]));
    expect(byId.get(a).answer.option).toBe('Create a follow-up story');
    expect(byId.get(b).answer.option).toBe('Create a follow-up story');
    expect(byId.get(bad).answer).toBeNull();
    expect(byId.get(plain).answer).toBeNull();
    const again = await run(['decide', 'answer', '--bundle', 'follow-ups', 'Create a follow-up story']);
    expect(again.code).toBe(1);
    expect(again.out).toBe('Answered 0; 1 could not be answered.\n');
  });

  it('answer --bundle with no failures answers each, then finds nothing left', async () => {
    const ids = [];
    for (const story of ['S-1', 'S-2', 'S-3']) ids.push((await addFollowUp(story)).out.trim());
    const r = await run(['decide', 'answer', '--bundle', 'follow-ups', 'Create a follow-up story']);
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
    // Answered in the list's order: oldest first, then by id (these share one clock).
    expect(r.out).toBe(`Answered 3.\n${[...ids].sort().map((id) => `  ${id} answered: Create a follow-up story\n`).join('')}`);
    const again = await run(['decide', 'answer', '--bundle', 'follow-ups', 'Create a follow-up story']);
    expect(again.code).toBe(0);
    expect(again.out).toBe('Nothing left to answer here.\n');
  });

  it('answer --bundle follow-ups Ignore answers them with Ignore', async () => {
    await addFollowUp('S-1');
    await addFollowUp('S-2');
    const r = await run(['decide', 'answer', '--bundle', 'follow-ups', 'Ignore']);
    expect(r.code).toBe(0);
    expect(r.out.startsWith('Answered 2.\n')).toBe(true);
    expect((await pending()).map((i) => i.answer?.option)).toEqual(['Ignore', 'Ignore']);
  });

  it('answer --bundle refuses', async () => {
    await addFollowUp('S-1');
    await addFollowUp('S-2');
    const before = await pending();
    const nope = await run(['decide', 'answer', '--bundle', 'nope', 'Ignore']);
    expect(nope.code).toBe(1);
    expect(nope.err).toMatch(/Unknown bundle/);
    const maybe = await run(['decide', 'answer', '--bundle', 'follow-ups', 'Maybe']);
    expect(maybe.code).toBe(1);
    expect(maybe.err).toContain('"Create a follow-up story"');
    expect(maybe.err).toContain('"Ignore"');
    expect((await run(['decide', 'answer', '--bundle', 'follow-ups', 'Ignore', 'extra'])).code).toBe(1);
    expect((await run(['decide', 'answer', '--bundle', 'follow-ups', 'Ignore', '--note', 'x'])).code).toBe(1);
    expect((await run(['decide', 'list', '--bundle', 'follow-ups'])).code).toBe(1);
    expect((await run(['decide', 'pending', '--all'])).code).toBe(1);
    expect(await pending()).toEqual(before);
  });

  it('refuses a bad add and an unknown sub-command', async () => {
    expect((await run(['decide', 'add', '--story', 'S-1', '--kind', 'wish', '--title', 'x'])).code).toBe(1);
    expect((await run(['decide', 'add', '--story', 'S-1', '--kind', 'task'])).code).toBe(1);
    expect((await run(['decide', 'add', '--kind', 'task', '--title', 'x'])).code).toBe(1);
    expect((await run(['decide', 'answer', 'd-20261015090000-ffff', 'x'])).code).toBe(1);
    expect((await run(['decide', 'frobnicate'])).code).toBe(1);
  });
});

describe('foreman decide with the artifacts console', () => {
  beforeEach(() => {
    writeFileSync(
      join(dir, 'foreman.config.json'),
      JSON.stringify({ version: 1, project: { name: 'T' }, checks: [{ run: 'true', when: 'always' }], console: { adapter: 'artifacts', commandCenterUrl: 'https://pages.example/artifact/cc', decisionsUrl: 'https://pages.example/artifact/dp' } }),
    );
  });
  const outbox = () => readdirSync(join(dir, '.foreman', 'sync', 'outbox')).map((f) => JSON.parse(readFileSync(join(dir, '.foreman', 'sync', 'outbox', f), 'utf8')));

  it('add and applied queue for the next push; pending shows the queued item', async () => {
    const id = (await addFailed()).out.trim();
    expect(outbox()).toMatchObject([{ type: 'add', item: { id, story: 'S-1', kind: 'decision' } }]);
    const items = JSON.parse((await run(['decide', 'pending'])).out);
    expect(items).toMatchObject([{ id, story: 'S-1', answer: null }]);
    expect((await run(['decide', 'applied', id])).code).toBe(0);
    expect(outbox().map((o) => o.type).sort()).toEqual(['add', 'applied']);
    expect(JSON.parse((await run(['decide', 'pending'])).out)).toEqual([]);
  });

  it('answer says to use the decisions page', async () => {
    const r = await run(['decide', 'answer', 'd-a', 'Yes']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/answer on the decisions page/i);
  });

  it('answer --bundle says to use the decisions page', async () => {
    const r = await run(['decide', 'answer', '--bundle', 'follow-ups', 'Create a follow-up story']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/answer on the decisions page/i);
  });

  it('a console without its urls is a clear error', async () => {
    writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'T' }, checks: [{ run: 'true', when: 'always' }], console: { adapter: 'artifacts' } }));
    const r = await run(['decide', 'pending']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/commandCenterUrl/);
  });
});
