import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../main.mjs';
import { readLedger } from './learn.mjs';
import { openProjectStories } from '../../engine/story-source.mjs';

let dir;
const state = () => join(dir, '.foreman');
const ledger = () => JSON.parse(readFileSync(join(state(), 'learn.json'), 'utf8'));
const traitFile = (role) => join(dir, '.claude', 'foreman', 'traits', `${role}.md`);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foreman-cli-learn-'));
  writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'T' }, checks: [{ run: 'true', when: 'always' }], learning: { auto: false } }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

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

const line = (story, rule, extra = {}) => JSON.stringify({ at: '2026-10-15T08:00:00Z', story, result: 'failed', builder: 'developer', stage: 'review', severity: 'major', rule, where: `${story}.js`, observed: 'o', fix: 'add a test', ...extra });
function findings(...lines) {
  mkdirSync(state(), { recursive: true });
  writeFileSync(join(state(), 'findings.jsonl'), `${lines.join('\n')}\n`);
}
const repeated = () => findings(line('S-1', 'Every route needs a test.'), line('S-2', 'every route needs a test'), line('S-3', 'Every route needs a test'), line('S-4', 'a one-off'));
const pending = async () => JSON.parse((await run(['decide', 'pending'])).out);

describe('foreman learn', () => {
  it('proposes a trait for a rule repeated on three stories, as a decision', async () => {
    repeated();
    const { code, out } = await run(['learn']);
    expect(code).toBe(0);
    expect(out).toContain('Proposed 1 trait(s) from repeated findings.');
    const items = await pending();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'decision', title: 'Add a trait for developer: Every route needs a test?', options: ['Add as a trait', 'Ignore'], story: 'S-3' });
    expect(items[0].body).toContain('S-1, S-2, S-3');
    expect(items[0].body).toContain('S-2.js');
    expect(items[0].body).toContain('Every route needs a test (the usual fix: add a test).');
    expect(ledger().proposed).toEqual({ 'developer::every route needs a test': items[0].id });
  });

  it('never proposes the same key twice', async () => {
    repeated();
    await run(['learn']);
    const again = await run(['learn']);
    expect(again.out).toContain('Proposed 0 trait(s) from repeated findings.');
    expect(await pending()).toHaveLength(1);
  });

  it('--min-stories changes the threshold', async () => {
    findings(line('S-1', 'r'), line('S-2', 'r'));
    expect((await run(['learn'])).out).toContain('Proposed 0 trait(s)');
    expect((await run(['learn', '--min-stories', '2'])).out).toContain('Proposed 1 trait(s)');
  });

  it('--dry-run prints the proposals and writes nothing', async () => {
    repeated();
    const { code, out } = await run(['learn', '--dry-run']);
    expect(code).toBe(0);
    expect(out).toContain('Add a trait for developer: Every route needs a test?');
    expect(out).toContain('Every route needs a test (the usual fix: add a test).');
    expect(existsSync(join(state(), 'learn.json'))).toBe(false);
    expect(existsSync(join(state(), 'decisions'))).toBe(false);
  });

  it('says so when there are no findings yet', async () => {
    const { code, out } = await run(['learn']);
    expect(code).toBe(0);
    expect(out).toContain('Proposed 0 trait(s) from repeated findings.');
  });

  it('skips a rule already in the traits', async () => {
    repeated();
    mkdirSync(join(dir, '.claude', 'foreman', 'traits'), { recursive: true });
    writeFileSync(traitFile('developer'), 'Every route needs a test.\n');
    expect((await run(['learn'])).out).toContain('Proposed 0 trait(s)');
  });

  it('rejects a bad --min-stories', async () => {
    expect((await run(['learn', '--min-stories', 'x'])).code).toBe(64);
  });

  describe('features.learnTraits', () => {
    const localSettings = (values) => {
      mkdirSync(state(), { recursive: true });
      writeFileSync(join(state(), 'settings.json'), JSON.stringify(values));
    };

    it('off in the local layer: proposes no trait, and says why', async () => {
      repeated();
      localSettings({ 'features.learnTraits': false });
      const { code, out } = await run(['learn']);
      expect(code).toBe(0);
      expect(out).toContain('Trait proposals are off (features.learnTraits).');
      expect(out).toContain('Proposed 0 trait(s) from repeated findings.');
      expect(await pending()).toEqual([]);
      expect(existsSync(join(state(), 'learn.json'))).toBe(false);
    });

    it('off in the config file: the dry run proposes none either', async () => {
      repeated();
      writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'T' }, features: { learnTraits: false }, learning: { auto: false } }));
      const { out } = await run(['learn', '--dry-run']);
      expect(out).not.toContain('Would ask: Add a trait');
      expect(out).toContain('0 proposal(s); nothing written (dry run).');
    });

    it('a local on beats a team off', async () => {
      repeated();
      writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'T' }, features: { learnTraits: false }, learning: { auto: false } }));
      localSettings({ 'features.learnTraits': true });
      expect((await run(['learn'])).out).toContain('Proposed 1 trait(s) from repeated findings.');
    });
  });
});

describe('foreman learn apply / ignore', () => {
  it('apply writes the trait, marks the key applied and the decision applied', async () => {
    repeated();
    await run(['learn']);
    const [item] = await pending();
    await run(['decide', 'answer', item.id, 'Add as a trait']);
    const { code, out } = await run(['learn', 'apply', item.id]);
    expect(code).toBe(0);
    expect(out).toContain('developer');
    expect(readFileSync(traitFile('developer'), 'utf8')).toBe('Every route needs a test (the usual fix: add a test).\n');
    expect(ledger().applied).toEqual(['developer::every route needs a test']);
    expect(await pending()).toEqual([]);
    // Applied traits are not proposed again, even with new findings.
    findings(line('S-1', 'every route needs a test'), line('S-2', 'every route needs a test'), line('S-3', 'every route needs a test'), line('S-5', 'every route needs a test'));
    expect((await run(['learn'])).out).toContain('Proposed 0 trait(s)');
  });

  it('apply puts a proposal from findings without a builder in all.md', async () => {
    findings(...['S-1', 'S-2', 'S-3'].map((s) => line(s, 'Log errors', { builder: undefined })));
    await run(['learn']);
    const [item] = await pending();
    expect(item.title).toBe('Add a trait for all: Log errors?');
    await run(['decide', 'answer', item.id, 'Add as a trait']);
    expect((await run(['learn', 'apply', item.id])).code).toBe(0);
    expect(readFileSync(traitFile('all'), 'utf8')).toContain('Log errors');
  });

  it('apply refuses when the owner did not choose "Add as a trait"', async () => {
    repeated();
    await run(['learn']);
    const [item] = await pending();
    const unanswered = await run(['learn', 'apply', item.id]);
    expect(unanswered.code).toBe(1);
    expect(unanswered.err).toContain('the owner did not choose Add as a trait');
    await run(['decide', 'answer', item.id, 'Ignore']);
    const wrong = await run(['learn', 'apply', item.id]);
    expect(wrong.code).toBe(1);
    expect(wrong.err).toContain('the owner did not choose Add as a trait');
    expect(existsSync(traitFile('developer'))).toBe(false);
    expect(ledger().applied).toEqual([]);
    expect(await pending()).toHaveLength(1);
  });

  it('ignore refuses when the owner did not choose "Ignore"', async () => {
    repeated();
    await run(['learn']);
    const [item] = await pending();
    expect((await run(['learn', 'ignore', item.id])).code).toBe(1);
    await run(['decide', 'answer', item.id, 'Add as a trait']);
    const wrong = await run(['learn', 'ignore', item.id]);
    expect(wrong.code).toBe(1);
    expect(wrong.err).toContain('the owner did not choose Ignore');
    expect(ledger().ignored).toEqual([]);
  });

  it('skips the answer check, with a note, when the console has no local copy of the item', async () => {
    repeated();
    await run(['learn']);
    const [item] = await pending();
    rmSync(join(state(), 'decisions', `${item.id}.json`));
    const { code, err } = await run(['learn', 'ignore', item.id]);
    expect(code).toBe(0);
    expect(err).toContain('could not check the answer');
    expect(ledger().ignored).toEqual(['developer::every route needs a test']);
  });

  it('apply adds the trait to all.md, and says so, when the builder is no longer in the config', async () => {
    findings(...['S-1', 'S-2', 'S-3'].map((s) => line(s, 'Use the cache', { builder: 'old-builder' })));
    await run(['learn']);
    const [item] = await pending();
    await run(['decide', 'answer', item.id, 'Add as a trait']);
    const { code, out } = await run(['learn', 'apply', item.id]);
    expect(code).toBe(0);
    expect(out).toContain('old-builder is no longer in the config');
    expect(readFileSync(traitFile('all'), 'utf8')).toContain('Use the cache');
    expect(existsSync(traitFile('old-builder'))).toBe(false);
    expect(ledger().applied).toEqual(['old-builder::use the cache']);
    expect(await pending()).toEqual([]);
  });

  it('ignore marks the key ignored and the decision applied, and it is not proposed again', async () => {
    repeated();
    await run(['learn']);
    const [item] = await pending();
    await run(['decide', 'answer', item.id, 'Ignore']);
    const { code } = await run(['learn', 'ignore', item.id]);
    expect(code).toBe(0);
    expect(ledger().ignored).toEqual(['developer::every route needs a test']);
    expect(existsSync(traitFile('developer'))).toBe(false);
    expect(await pending()).toEqual([]);
    rmSync(join(state(), 'learn.json'));
    writeFileSync(join(state(), 'learn.json'), JSON.stringify({ proposed: {}, ignored: ['developer::every route needs a test'], applied: [] }));
    expect((await run(['learn'])).out).toContain('Proposed 0 trait(s)');
  });

  it('apply or ignore of an unknown decision fails', async () => {
    const a = await run(['learn', 'apply', 'd-20261015090000-abcd']);
    expect(a.code).toBe(1);
    expect(a.err).toContain('not a trait or follow-up proposal');
    expect((await run(['learn', 'ignore'])).code).toBe(64);
  });

  it('an unknown sub prints usage', async () => {
    expect((await run(['learn', 'wat'])).code).toBe(64);
  });
});

describe('foreman learn: follow-ups from minor findings', () => {
  const minor = (story, rule, extra = {}) => line(story, rule, { result: 'shipped', severity: 'minor', where: 'src/a.js', observed: 'no test for the empty case', fix: 'add one', ...extra });
  const storyFile = (id, title, status = 'done') => {
    mkdirSync(join(dir, 'stories'), { recursive: true });
    writeFileSync(join(dir, 'stories', `${id}.md`), `---\nid: ${id}\ntitle: ${title}\nstatus: ${status}\n---\n\n# ${id}\n`);
  };
  beforeEach(() => {
    storyFile('S-3', 'Three');
    storyFile('S-4', 'Four');
  });
  const waiting = (id = 'F-1') => join(state(), 'stories', 'new', `${id}.md`);

  it('asks once per shipped story about its minor findings', async () => {
    findings(minor('S-3', 'Cover the empty case.'), minor('S-3', 'Name the constant', { where: 'src/b.js' }), minor('S-4', 'Log errors'), minor('S-5', 'r', { result: 'failed' }));
    const { code, out } = await run(['learn']);
    expect(code).toBe(0);
    expect(out).toContain('Proposed 0 trait(s) from repeated findings.');
    expect(out).toContain('Proposed 2 follow-up(s) from minor findings.');
    const items = await pending();
    expect(items.map((i) => i.title).sort()).toEqual(['Follow up on S-3: 2 minor finding(s)?', 'Follow up on S-4: 1 minor finding(s)?']);
    const s3 = items.find((i) => i.story === 'S-3');
    expect(s3).toMatchObject({ kind: 'decision', options: ['Create a follow-up story', 'Ignore'] });
    expect(s3.body).toContain('- Cover the empty case (`src/a.js`): no test for the empty case — fix: add one');
    expect(s3.body).toContain('- Name the constant (`src/b.js`)');
    expect(ledger().proposed).toMatchObject({ 'followup:S-3:cover the empty case': s3.id, 'followup:S-3:name the constant': s3.id });
  });

  it('does not ask again about findings already proposed, but asks about new ones', async () => {
    findings(minor('S-3', 'Cover the empty case'));
    await run(['learn']);
    expect((await run(['learn'])).out).toContain('Proposed 0 follow-up(s) from minor findings.');
    findings(minor('S-3', 'Cover the empty case'), minor('S-3', 'Name the constant'));
    await run(['learn']);
    const titles = (await pending()).map((i) => i.title);
    expect(titles).toEqual(['Follow up on S-3: 1 minor finding(s)?', 'Follow up on S-3: 1 minor finding(s)?']);
    expect((await pending()).filter((i) => i.body.includes('Name the constant'))).toHaveLength(1);
  });

  describe('features.followUps', () => {
    it('off: proposes no follow-up, and says why', async () => {
      mkdirSync(state(), { recursive: true });
      writeFileSync(join(state(), 'settings.json'), JSON.stringify({ 'features.followUps': false }));
      findings(minor('S-3', 'Cover the empty case'));
      const { code, out } = await run(['learn']);
      expect(code).toBe(0);
      expect(out).toContain('Follow-up proposals are off (features.followUps).');
      expect(out).toContain('Proposed 0 follow-up(s) from minor findings.');
      expect(await pending()).toEqual([]);
    });

    it('off: the dry run proposes none either, while traits still come', async () => {
      writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'T' }, features: { followUps: false }, learning: { auto: false } }));
      findings(minor('S-3', 'Cover the empty case'), line('S-1', 'r'), line('S-2', 'r'), line('S-3', 'r'));
      const { out } = await run(['learn', '--dry-run']);
      expect(out).not.toContain('Would ask: Follow up on');
      expect(out).toContain('Would ask: Add a trait for developer: R?');
      expect(out).toContain('1 proposal(s); nothing written (dry run).');
    });
  });

  describe('follow-ups of follow-ups (features.followUpsOfFollowUps)', () => {
    const followUpFile = () => {
      writeFileSync(join(dir, 'stories', 'F-1.md'), '---\nid: F-1\ntitle: Follow-ups from S-3\nstatus: done\nfollow_up_of: S-3\n---\n\n# F-1\n');
    };
    const localSettings = (values) => {
      mkdirSync(state(), { recursive: true });
      writeFileSync(join(state(), 'settings.json'), JSON.stringify(values));
    };

    it('by default, proposes nothing from a story that is itself a follow-up, and says so', async () => {
      followUpFile();
      findings(minor('F-1', 'Cover the empty case'), minor('S-4', 'Log errors'));
      const { code, out } = await run(['learn']);
      expect(code).toBe(0);
      expect(out).toContain('Proposed 1 follow-up(s) from minor findings.');
      expect(out).toContain('F-1 is itself a follow-up; not proposing follow-ups from it (features.followUpsOfFollowUps is off)');
      expect((await pending()).map((i) => i.story)).toEqual(['S-4']);
      expect(Object.keys(ledger().proposed)).toEqual(['followup:S-4:log errors']);
    });

    it('--dry-run skips it too', async () => {
      followUpFile();
      findings(minor('F-1', 'Cover the empty case'));
      const { out } = await run(['learn', '--dry-run']);
      expect(out).not.toContain('Would ask: Follow up on F-1');
      expect(out).toContain('0 proposal(s); nothing written (dry run).');
    });

    it('proposes it when the switch is on in the local layer', async () => {
      followUpFile();
      localSettings({ 'features.followUpsOfFollowUps': true });
      findings(minor('F-1', 'Cover the empty case'));
      const { out } = await run(['learn']);
      expect(out).toContain('Proposed 1 follow-up(s) from minor findings.');
      expect((await pending()).map((i) => i.story)).toEqual(['F-1']);
    });

    it('proposes it when the switch is on in the config file', async () => {
      followUpFile();
      writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'T' }, features: { followUpsOfFollowUps: true } }));
      findings(minor('F-1', 'Cover the empty case'));
      expect((await run(['learn'])).out).toContain('Proposed 1 follow-up(s) from minor findings.');
    });

    it('a local off beats a team on', async () => {
      followUpFile();
      writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'T' }, features: { followUpsOfFollowUps: true } }));
      localSettings({ 'features.followUpsOfFollowUps': false });
      findings(minor('F-1', 'Cover the empty case'));
      expect((await run(['learn'])).out).toContain('Proposed 0 follow-up(s) from minor findings.');
    });
  });

  it("skips a finding an existing story's title already covers", async () => {
    storyFile('S-6', 'Cover the empty case', 'todo');
    findings(minor('S-3', 'Cover the empty case'));
    expect((await run(['learn'])).out).toContain('Proposed 0 follow-up(s) from minor findings.');
  });

  it('a follow-up proposal carries a one-line summary of its findings', async () => {
    findings(minor('S-3', 'LoadConfig can throw'), minor('S-3', 'A test passes without the fix'), minor('S-3', 'Doctor misses an adapter clash'));
    expect((await run(['learn'])).code).toBe(0);
    const [item] = await pending();
    expect(item.summary).toBe('3 minor: loadConfig can throw; a test passes without the fix; doctor misses an adapter clash');
    expect(item).toMatchObject({ kind: 'decision', title: 'Follow up on S-3: 3 minor finding(s)?', options: ['Create a follow-up story', 'Ignore'] });
    expect(item.body).toBe(
      [
        'S-3 shipped with 3 minor finding(s) still open:',
        '',
        '- LoadConfig can throw (`src/a.js`): no test for the empty case — fix: add one',
        '- A test passes without the fix (`src/a.js`): no test for the empty case — fix: add one',
        '- Doctor misses an adapter clash (`src/a.js`): no test for the empty case — fix: add one',
        '',
        '"Create a follow-up story" adds a story, "Follow-ups from S-3", to fix them.',
      ].join('\n'),
    );
  });

  it('a trait proposal is explained in plain words, with a hint per option', async () => {
    repeated();
    await run(['learn']);
    const [item] = await pending();
    expect(item).toMatchObject({ title: 'Add a trait for developer: Every route needs a test?', options: ['Add as a trait', 'Ignore'], recommend: 'Add as a trait' });
    expect(item.hints).toHaveLength(2);
    expect(Object.keys(item.explain)).toEqual(['purpose', 'happened', 'recommendation']);
    expect(item.explain.happened).toContain('S-1, S-2 and S-3');
    expect(item.explain.recommendation).toMatch(/^Add as a trait/);
    expect(ledger().proposed).toEqual({ 'developer::every route needs a test': item.id });
    expect(ledger().details[item.id]).toMatchObject({ key: 'developer::every route needs a test', builder: 'developer' });
    const out = (await run(['decide', 'list'])).out;
    expect(out).toMatch(/Quick decisions \(1\):\n {2}1 trait proposal · answer all/);
    expect(out).toContain('    Your options:\n      - Add as a trait (recommended)\n');
  });

  it('a trait proposal carries a summary', async () => {
    repeated();
    await run(['learn']);
    const items = await pending();
    expect(items[0].summary).toBe('Stopped 3 stories for developer: S-1, S-2 and S-3');
  });

  it('--dry-run prints a summary per proposal', async () => {
    findings(line('S-1', 'Every route needs a test.'), line('S-2', 'every route needs a test'), line('S-3', 'Every route needs a test'), minor('S-3', 'Cover the empty case'), minor('S-3', 'Name the constant'));
    const { code, out } = await run(['learn', '--dry-run']);
    expect(code).toBe(0);
    const lines = out.split('\n');
    const asks = lines.map((l, i) => [l, i]).filter(([l]) => l.startsWith('Would ask: '));
    expect(asks).toHaveLength(2);
    for (const [, i] of asks) expect(lines[i + 1]).toMatch(/^ {2}summary: \S/);
    expect(lines.filter((l) => l.startsWith('  summary: '))).toHaveLength(asks.length);
    expect(out).toContain('  summary: Stopped 3 stories for developer: S-1, S-2 and S-3\n');
    expect(out).toContain('  summary: 2 minor: cover the empty case; name the constant\n');
    expect(existsSync(join(state(), 'learn.json'))).toBe(false);
    expect(existsSync(join(state(), 'decisions'))).toBe(false);
  });

  it('still proposes a follow-up whose rules run past 160 characters, with a summary that fits', async () => {
    const rules = Array.from({ length: 8 }, (_, i) => `Rule ${i + 1} is a rather long minor finding about the code`);
    findings(...rules.map((r) => minor('S-3', r)));
    const { code, out, err } = await run(['learn']);
    expect(code).toBe(0);
    expect(err).toBe('');
    expect(out).toContain('Proposed 1 follow-up(s) from minor findings.');
    const [item] = await pending();
    expect(item.summary.length).toBeLessThanOrEqual(160);
    expect(item.summary).toMatch(/^8 minor: rule 1 is/);
  });

  it('--dry-run prints the follow-up proposals and writes nothing', async () => {
    findings(minor('S-3', 'Cover the empty case'));
    const { code, out } = await run(['learn', '--dry-run']);
    expect(code).toBe(0);
    expect(out).toContain('Would ask: Follow up on S-3: 1 minor finding(s)?');
    expect(out).toContain('- Cover the empty case (`src/a.js`)');
    expect(existsSync(join(state(), 'learn.json'))).toBe(false);
    expect(existsSync(join(state(), 'decisions'))).toBe(false);
  });

  it('apply creates the follow-up story after "Create a follow-up story"', async () => {
    findings(minor('S-3', 'Cover the empty case'), minor('S-3', 'Name the constant', { where: 'src/b.js', fix: '' }));
    await run(['learn']);
    const [item] = await pending();
    const early = await run(['learn', 'apply', item.id]);
    expect(early.code).toBe(1);
    expect(early.err).toContain('the owner did not choose Create a follow-up story');
    expect(existsSync(waiting())).toBe(false);

    await run(['decide', 'answer', item.id, 'Create a follow-up story']);
    const { code, out } = await run(['learn', 'apply', item.id]);
    expect(code).toBe(0);
    expect(out).toContain('Created F-1: Follow-ups from S-3');
    const text = readFileSync(waiting(), 'utf8');
    expect(text).toContain('title: Follow-ups from S-3\nstatus: todo\ndepends_on: []\nfollow_up_of: S-3\n');
    expect(text).toContain('## What\n\n- Cover the empty case (`src/a.js`): no test for the empty case — fix: add one\n- Name the constant (`src/b.js`): no test for the empty case\n');
    expect(text).toContain('## Done when\n\nEach listed finding is fixed, with a test where it is a behaviour, and `true` passes.\n');
    expect(ledger().applied).toEqual(['followup:S-3:cover the empty case', 'followup:S-3:name the constant']);
    expect(await pending()).toEqual([]);
    // Applied again, it makes no second story.
    expect((await run(['learn', 'apply', item.id])).out).toContain('F-1');
    expect(existsSync(waiting('F-2'))).toBe(false);
    expect((await run(['learn'])).out).toContain('Proposed 0 follow-up(s)');
  });

  it('ignore marks the findings ignored, after "Ignore"', async () => {
    findings(minor('S-3', 'Cover the empty case'));
    await run(['learn']);
    const [item] = await pending();
    expect((await run(['learn', 'ignore', item.id])).code).toBe(1);
    await run(['decide', 'answer', item.id, 'Ignore']);
    const { code, out } = await run(['learn', 'ignore', item.id]);
    expect(code).toBe(0);
    expect(out).toContain('Ignored the follow-ups from S-3');
    expect(ledger().ignored).toEqual(['followup:S-3:cover the empty case']);
    expect(existsSync(waiting())).toBe(false);
    expect(await pending()).toEqual([]);
    expect((await run(['learn'])).out).toContain('Proposed 0 follow-up(s)');
  });

  describe('features.autoCreateFollowUps', () => {
    const localSettings = (values) => {
      mkdirSync(state(), { recursive: true });
      writeFileSync(join(state(), 'settings.json'), JSON.stringify(values));
    };
    const on = (more = {}) => localSettings({ 'features.autoCreateFollowUps': true, ...more });
    const S3_KEYS = ['followup:S-3:cover the empty case', 'followup:S-3:name the constant'];
    const S4_KEYS = ['followup:S-4:log errors'];
    const twoStories = () => findings(minor('S-3', 'Cover the empty case'), minor('S-3', 'Name the constant', { where: 'src/b.js' }), minor('S-4', 'Log errors'));
    const CREATED = ['Undo and close them', 'Keep them'];
    const learnFile = () => join(state(), 'learn.json');
    const statusOf = (id) => openProjectStories({ root: dir, env: { FOREMAN_PROJECT_DIR: dir } }).list().find((st) => st.id === id)?.status;
    // Everything the stories folders hold about a story: its file and its overlay.
    const storyText = (id) =>
      [join(dir, 'stories'), join(state(), 'stories'), join(state(), 'stories', 'new')]
        .flatMap((folder) => (existsSync(folder) ? readdirSync(folder).filter((f) => f.startsWith(`${id}.`)).map((f) => join(folder, f)) : []))
        .map((f) => readFileSync(f, 'utf8'))
        .join('\n');
    // Creates F-1 (from S-3) and F-2 (from S-4) and gives the note's id.
    async function created() {
      on();
      twoStories();
      expect((await run(['learn'])).code).toBe(0);
      const [note] = await pending();
      expect(note.title).toBe('Foreman created 2 follow-up stories');
      return note;
    }

    it('on: creates each follow-up at once, tells the owner once, and the next pick takes one', async () => {
      on();
      twoStories();
      const { code, out, err } = await run(['learn']);
      expect(err).toBe('');
      expect(code).toBe(0);
      expect(out).toContain('Created F-1: Follow-ups from S-3\n');
      expect(out).toContain('Created F-2: Follow-ups from S-4\n');
      expect(out).toContain('Created 2 follow-up story(s) from minor findings.\n');
      expect(out).toContain('Proposed 0 follow-up(s) from minor findings.\n');
      expect(out).not.toContain('Follow up on');
      expect(readFileSync(waiting('F-1'), 'utf8')).toContain('title: Follow-ups from S-3\nstatus: todo\ndepends_on: []\nfollow_up_of: S-3\n');
      expect(readFileSync(waiting('F-1'), 'utf8')).toContain('- Cover the empty case (`src/a.js`)');
      expect(readFileSync(waiting('F-2'), 'utf8')).toContain('follow_up_of: S-4\n');
      expect(ledger().applied).toEqual([...S3_KEYS, ...S4_KEYS]);
      expect(ledger().proposed).toEqual({});
      expect(readLedger(state()).unannounced).toEqual([]);

      const items = await pending();
      expect(items).toHaveLength(1);
      const [note] = items;
      expect(note).toMatchObject({ kind: 'decision', story: 'S-4', title: 'Foreman created 2 follow-up stories', options: CREATED, urgent: false });
      expect(note.hints).toEqual(['Closes the new stories not started yet; nothing is built for them.', 'Keeps the stories and clears this note.']);
      expect(note.body).toBe(
        [
          '- F-1: Follow-ups from S-3 (2 minor finding(s))',
          '- F-2: Follow-ups from S-4 (1 minor finding(s))',
          '',
          'The run picks them up like any other story. "Undo and close them" closes the ones not started yet; a story already started is left as it is.',
        ].join('\n'),
      );
      expect(note.summary).toBe('F-1 and F-2 to fix the minor findings of S-3 and S-4');
      expect(note.summary.length).toBeLessThan(160);
      expect(out).toContain(`${note.id}  Foreman created 2 follow-up stories\n`);
      expect(ledger().details[note.id]).toEqual({
        kind: 'followup-created',
        stories: [
          { id: 'F-1', story: 'S-3', findings: 2, keys: S3_KEYS },
          { id: 'F-2', story: 'S-4', findings: 1, keys: S4_KEYS },
        ],
      });

      const next = await run(['story', 'next']);
      expect(next.code).toBe(0);
      expect(JSON.parse(next.out).id).toBe('F-1');
    });

    it('on, run twice: the second run creates nothing and leaves the one note', async () => {
      on();
      twoStories();
      await run(['learn']);
      const again = await run(['learn']);
      expect(again.code).toBe(0);
      expect(again.out).toContain('Created 0 follow-up story(s) from minor findings.');
      expect(existsSync(waiting('F-3'))).toBe(false);
      expect(await pending()).toHaveLength(1);
    });

    it('off, the default: the same findings are asked about as today, and nothing is created', async () => {
      twoStories();
      const { code, out } = await run(['learn']);
      expect(code).toBe(0);
      expect(out).toContain('Proposed 2 follow-up(s) from minor findings.');
      expect(out).not.toContain('Created');
      expect(existsSync(waiting('F-1'))).toBe(false);
      expect((await pending()).map((i) => i.title).sort()).toEqual(['Follow up on S-3: 2 minor finding(s)?', 'Follow up on S-4: 1 minor finding(s)?']);
      const raw = JSON.parse(readFileSync(learnFile(), 'utf8'));
      expect(Object.keys(raw)).toEqual(['proposed', 'ignored', 'applied', 'details']);
      expect(raw.applied).toEqual([]);
    });

    it('on, with followUpsOfFollowUps off: a follow-up still gets no follow-up story', async () => {
      on();
      writeFileSync(join(dir, 'stories', 'F-1.md'), '---\nid: F-1\ntitle: Follow-ups from S-3\nstatus: done\nfollow_up_of: S-3\n---\n\n# F-1\n');
      findings(minor('F-1', 'Cover the empty case'));
      const { code, out } = await run(['learn']);
      expect(code).toBe(0);
      expect(out).toContain('F-1 is itself a follow-up; not proposing follow-ups from it (features.followUpsOfFollowUps is off)');
      expect(out).toContain('Created 0 follow-up story(s) from minor findings.');
      expect(existsSync(waiting('F-2'))).toBe(false);
      expect(await pending()).toEqual([]);
    });

    it('on, with --dry-run: says what it would create and writes nothing', async () => {
      on();
      twoStories();
      const { code, out } = await run(['learn', '--dry-run']);
      expect(code).toBe(0);
      expect(out).toContain('Would create: Follow-ups from S-3\n  summary: 2 minor: cover the empty case; name the constant\n  - Cover the empty case (`src/a.js`)');
      expect(out).toContain('Would create: Follow-ups from S-4\n');
      expect(out).not.toContain('Would ask: Follow up on');
      expect(out).toContain('2 proposal(s); nothing written (dry run).');
      expect(existsSync(learnFile())).toBe(false);
      expect(existsSync(join(state(), 'decisions'))).toBe(false);
      expect(existsSync(waiting('F-1'))).toBe(false);
    });

    it('a create that fails falls back to asking, so no proposal is lost', async () => {
      on();
      // S-3 is gone from the stories, so the source cannot make a follow-up of it.
      rmSync(join(dir, 'stories', 'S-3.md'));
      twoStories();
      const { code, out, err } = await run(['learn']);
      expect(code).toBe(0);
      expect(err).toContain('could not create the follow-up from S-3 (unknown origin story: S-3); asking you instead');
      expect(out).toContain('Created F-1: Follow-ups from S-4\n');
      expect(out).toContain('Created 1 follow-up story(s) from minor findings.');
      expect(out).toContain('Proposed 1 follow-up(s) from minor findings.');
      expect((await pending()).map((i) => i.title).sort()).toEqual(['Follow up on S-3: 2 minor finding(s)?', 'Foreman created 1 follow-up story']);
      expect(ledger().applied).toEqual(S4_KEYS);
      expect(Object.keys(ledger().proposed)).toEqual(S3_KEYS);
    });

    it('announces stories a killed run created but did not tell, even with the switch off', async () => {
      mkdirSync(state(), { recursive: true });
      const left = { id: 'F-1', story: 'S-3', findings: 1, keys: ['followup:S-3:cover the empty case'] };
      writeFileSync(learnFile(), JSON.stringify({ proposed: {}, ignored: [], applied: left.keys, details: {}, unannounced: [left] }));
      const { code, out } = await run(['learn']);
      expect(code).toBe(0);
      const items = await pending();
      expect(items.map((i) => i.title)).toEqual(['Foreman created 1 follow-up story']);
      expect(items[0]).toMatchObject({ story: 'S-3', summary: 'F-1 to fix the minor findings of S-3' });
      expect(out).toContain(`${items[0].id}  Foreman created 1 follow-up story\n`);
      expect(readLedger(state()).unannounced).toEqual([]);
      expect(ledger().details[items[0].id]).toEqual({ kind: 'followup-created', stories: [left] });
    });

    it('keeps the stories to announce when the owner cannot be told, and tries again next time', async () => {
      mkdirSync(state(), { recursive: true });
      const left = { id: 'F-1', story: 'S-3', findings: 1, keys: ['followup:S-3:cover the empty case'] };
      writeFileSync(learnFile(), JSON.stringify({ proposed: {}, ignored: [], applied: left.keys, details: {}, unannounced: [left] }));
      // The console cannot write its items: decisions is a file.
      writeFileSync(join(state(), 'decisions'), '');
      const failed = await run(['learn']);
      expect(failed.code).toBe(0);
      expect(failed.err).toContain('created F-1, but the owner was not told: ');
      expect(readLedger(state()).unannounced).toEqual([left]);
      expect(ledger().details).toEqual({});
      rmSync(join(state(), 'decisions'));
      expect((await run(['learn'])).code).toBe(0);
      expect((await pending()).map((i) => i.title)).toEqual(['Foreman created 1 follow-up story']);
      expect(readLedger(state()).unannounced).toEqual([]);
    });

    it('saves each story it creates at once, so a learn that cannot tell the owner never makes it twice', async () => {
      on();
      twoStories();
      // The console cannot write its items: decisions is a file.
      mkdirSync(state(), { recursive: true });
      writeFileSync(join(state(), 'decisions'), '');
      const failed = await run(['learn']);
      expect(failed.code).toBe(0);
      expect(failed.out).toContain('Created F-1: Follow-ups from S-3\n');
      expect(failed.out).toContain('Created F-2: Follow-ups from S-4\n');
      expect(failed.err).toContain('created F-1, F-2, but the owner was not told: ');
      expect(readLedger(state()).unannounced.map((c) => c.id)).toEqual(['F-1', 'F-2']);
      expect(ledger().applied).toEqual([...S3_KEYS, ...S4_KEYS]);

      rmSync(join(state(), 'decisions'));
      const again = await run(['learn']);
      expect(again.out).toContain('Created 0 follow-up story(s) from minor findings.');
      expect(existsSync(waiting('F-3'))).toBe(false);
      expect((await pending()).map((i) => i.title)).toEqual(['Foreman created 2 follow-up stories']);
    });

    it('learn undo closes the stories not started, after "Undo and close them", and leaves the rest', async () => {
      const note = await created();
      const early = await run(['learn', 'undo', note.id]);
      expect(early.code).toBe(1);
      expect(early.err).toContain(`${note.id}: the owner did not choose Undo and close them.`);
      expect(statusOf('F-1')).toBe('todo');

      writeFileSync(waiting('F-2'), readFileSync(waiting('F-2'), 'utf8').replace('status: todo', 'status: in-progress'));
      await run(['decide', 'answer', note.id, 'Undo and close them']);
      const { code, out } = await run(['learn', 'undo', note.id]);
      expect(code).toBe(0);
      expect(out).toContain('Left F-2: in-progress.\n');
      expect(out).toContain('Closed F-1.\n');
      expect(statusOf('F-1')).toBe('done');
      expect(storyText('F-1')).toContain('Closed: the owner undid this follow-up, which Foreman created by itself (Undo on Waiting on you).');
      expect(storyText('F-2')).not.toContain('Closed: the owner undid');
      expect(statusOf('F-2')).toBe('in-progress');
      expect(ledger().details[note.id].closed).toEqual(['F-1']);
      expect(await pending()).toEqual([]);
      // The findings stay applied: learn proposes nothing again for them.
      const again = await run(['learn']);
      expect(again.out).toContain('Created 0 follow-up story(s) from minor findings.');
      expect(again.out).toContain('Proposed 0 follow-up(s) from minor findings.');
      expect(await pending()).toEqual([]);
    });

    it('learn undo that cannot close a story stops before marking the note applied, and runs again', async () => {
      const note = await created();
      // F-2's overlay cannot be written: its path is a folder.
      mkdirSync(join(state(), 'stories', 'F-2.json', 'x'), { recursive: true });
      await run(['decide', 'answer', note.id, 'Undo and close them']);
      const failed = await run(['learn', 'undo', note.id]);
      expect(failed.code).toBe(1);
      expect(failed.err).toContain('could not close F-2: ');
      expect(failed.out).not.toContain('Closed');
      expect(statusOf('F-1')).toBe('done');
      expect(ledger().details[note.id].closed).toEqual(['F-1']);
      expect(await pending()).toHaveLength(1);

      rmSync(join(state(), 'stories', 'F-2.json'), { recursive: true });
      const again = await run(['learn', 'undo', note.id]);
      expect(again.code).toBe(0);
      expect(again.out).toContain('Left F-1: done.\n');
      expect(again.out).toContain('Closed F-2.\n');
      expect(ledger().details[note.id].closed).toEqual(['F-1', 'F-2']);
      expect(await pending()).toEqual([]);
    });

    it('learn undo leaves a story a live claim holds', async () => {
      const note = await created();
      mkdirSync(join(state(), 'claims'), { recursive: true });
      writeFileSync(join(state(), 'claims', 'F-2.json'), JSON.stringify({ pid: process.pid, slot: 'w1', story: 'F-2', by: 'factory', at: '2026-10-15T09:00:00Z' }));
      await run(['decide', 'answer', note.id, 'Undo and close them']);
      const { code, out } = await run(['learn', 'undo', note.id]);
      expect(code).toBe(0);
      expect(out).toContain('Left F-2: claimed.\n');
      expect(out).toContain('Closed F-1.\n');
      expect(statusOf('F-1')).toBe('done');
      expect(statusOf('F-2')).toBe('todo');
    });

    it('learn undo closes a story whose claim is stale', async () => {
      const note = await created();
      mkdirSync(join(state(), 'claims'), { recursive: true });
      writeFileSync(join(state(), 'claims', 'F-2.json'), JSON.stringify({ pid: 2 ** 30, slot: 'w1', story: 'F-2', by: 'factory', at: '2026-10-15T09:00:00Z' }));
      await run(['decide', 'answer', note.id, 'Undo and close them']);
      const { code, out } = await run(['learn', 'undo', note.id]);
      expect(code).toBe(0);
      expect(out).toContain('Closed F-1 and F-2.\n');
      expect(statusOf('F-2')).toBe('done');
    });

    it('learn undo says when a story is not found, and closes none', async () => {
      const note = await created();
      rmSync(waiting('F-1'));
      writeFileSync(waiting('F-2'), readFileSync(waiting('F-2'), 'utf8').replace('status: todo', 'status: blocked'));
      await run(['decide', 'answer', note.id, 'Undo and close them']);
      const { code, out } = await run(['learn', 'undo', note.id]);
      expect(code).toBe(0);
      expect(out).toContain('Left F-1: not found.\n');
      expect(out).toContain('Left F-2: blocked.\n');
      expect(out).toContain('Closed none.\n');
      expect(await pending()).toEqual([]);
    });

    it('learn undo refuses an unknown id and a follow-up proposal', async () => {
      const unknown = await run(['learn', 'undo', 'd-20261015090000-abcd']);
      expect(unknown.code).toBe(1);
      expect(unknown.err).toContain('d-20261015090000-abcd is not a note about follow-ups Foreman created.');
      findings(minor('S-3', 'Cover the empty case'));
      await run(['learn']);
      const [proposal] = await pending();
      await run(['decide', 'answer', proposal.id, 'Create a follow-up story']);
      const wrong = await run(['learn', 'undo', proposal.id]);
      expect(wrong.code).toBe(1);
      expect(wrong.err).toContain(`${proposal.id} is not a note about follow-ups Foreman created.`);
      expect(existsSync(waiting('F-1'))).toBe(false);
      expect((await run(['learn', 'undo'])).code).toBe(64);
    });

    it('learn undo does not run inside a story session', async () => {
      const note = await created();
      await run(['decide', 'answer', note.id, 'Undo and close them']);
      // On the run's own project: the run guard refuses it.
      const anchor = await run(['learn', 'undo', note.id], { FOREMAN_RUN: '1' });
      expect(anchor.code).toBe(1);
      expect(anchor.err).toContain('foreman learn undo would change');
      // On another project too: a story session never closes stories.
      const other = mkdtempSync(join(tmpdir(), 'foreman-cli-learn-anchor-'));
      try {
        const elsewhere = await run(['learn', 'undo', note.id], { FOREMAN_RUN: '1', FOREMAN_PROJECT_DIR: other });
        expect(elsewhere.code).toBe(1);
        expect(elsewhere.err).toContain('foreman learn undo does not run inside a Foreman story session (FOREMAN_RUN=1)');
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
      expect(statusOf('F-1')).toBe('todo');
      expect(await pending()).toHaveLength(1);
    });

    it.each([['apply'], ['ignore'], ['reopen']])('learn %s refuses the note about created follow-ups', async (sub) => {
      const note = await created();
      await run(['decide', 'answer', note.id, sub === 'apply' ? 'Undo and close them' : 'Keep them']);
      const before = readFileSync(learnFile(), 'utf8');
      const { code, err } = await run(['learn', sub, note.id]);
      expect(code).toBe(1);
      expect(err).toContain(`${note.id} is not a trait or follow-up proposal.`);
      expect(readFileSync(learnFile(), 'utf8')).toBe(before);
      expect(existsSync(waiting('F-3'))).toBe(false);
      expect(statusOf('F-1')).toBe('todo');
    });
  });
});

describe('foreman learn reopen', () => {
  const minor = (story, rule, extra = {}) => line(story, rule, { result: 'shipped', severity: 'minor', where: 'src/a.js', observed: 'no test', fix: 'add one', ...extra });
  const storyFile = (id, title) => {
    mkdirSync(join(dir, 'stories'), { recursive: true });
    writeFileSync(join(dir, 'stories', `${id}.md`), `---\nid: ${id}\ntitle: ${title}\nstatus: done\n---\n\n# ${id}\n`);
  };
  async function ignoreFirst() {
    await run(['learn']);
    const [item] = await pending();
    await run(['decide', 'answer', item.id, 'Ignore']);
    await run(['learn', 'ignore', item.id]);
    return item;
  }

  it('brings an ignored follow-up back as a new decision with the same findings', async () => {
    storyFile('S-3', 'Three');
    findings(minor('S-3', 'Cover the empty case'), minor('S-3', 'Name the constant'));
    const old = await ignoreFirst();
    const { code, out } = await run(['learn', 'reopen', old.id]);
    expect(code).toBe(0);
    expect(out).toContain('Reopened Follow up on S-3: 2 minor finding(s)?; run `foreman learn` to ask again.');
    expect(ledger().ignored).toEqual([]);
    expect(ledger().proposed).toEqual({});
    expect(ledger().details[old.id]).toBeDefined();
    await run(['learn']);
    const [again] = await pending();
    expect(again.id).not.toBe(old.id);
    expect(again.body).toContain('Cover the empty case');
    expect(again.body).toContain('Name the constant');
  });

  it('brings an ignored trait proposal back', async () => {
    repeated();
    const old = await ignoreFirst();
    const { code, out } = await run(['learn', 'reopen', old.id]);
    expect(code).toBe(0);
    expect(out).toContain('Reopened Add a trait for developer: Every route needs a test?');
    await run(['learn']);
    const [again] = await pending();
    expect(again.id).not.toBe(old.id);
    expect(again.title).toBe(old.title);
  });

  it('refuses a proposal that was applied', async () => {
    repeated();
    await run(['learn']);
    const [item] = await pending();
    await run(['decide', 'answer', item.id, 'Add as a trait']);
    await run(['learn', 'apply', item.id]);
    const { code, err } = await run(['learn', 'reopen', item.id]);
    expect(code).toBe(1);
    expect(err).toContain('already applied');
    expect(ledger().applied).toEqual(['developer::every route needs a test']);
  });

  it('refuses an unknown decision', async () => {
    const { code, err } = await run(['learn', 'reopen', 'd-20261015090000-abcd']);
    expect(code).toBe(1);
    expect(err).toContain('not a trait or follow-up proposal');
    expect((await run(['learn', 'reopen'])).code).toBe(64);
  });

  it('leaves a proposal that is still waiting alone', async () => {
    repeated();
    await run(['learn']);
    const [item] = await pending();
    const before = ledger();
    const { code, out } = await run(['learn', 'reopen', item.id]);
    expect(code).toBe(0);
    expect(out).toContain(`${item.id} is still waiting for an answer; nothing to reopen`);
    expect(ledger()).toEqual(before);
  });

  it('reopens only the ignored keys of a partly applied follow-up', async () => {
    storyFile('S-3', 'Three');
    findings(minor('S-3', 'Cover the empty case'), minor('S-3', 'Name the constant'));
    await run(['learn']);
    const [item] = await pending();
    const l = ledger();
    l.applied = ['followup:S-3:cover the empty case'];
    l.ignored = ['followup:S-3:name the constant'];
    writeFileSync(join(state(), 'learn.json'), JSON.stringify(l));
    const { code } = await run(['learn', 'reopen', item.id]);
    expect(code).toBe(0);
    expect(ledger().ignored).toEqual([]);
    expect(ledger().applied).toEqual(['followup:S-3:cover the empty case']);
    expect(Object.keys(ledger().proposed)).toEqual(['followup:S-3:cover the empty case']);
    await run(['learn']);
    const items = (await pending()).filter((i) => i.id !== item.id);
    expect(items).toHaveLength(1);
    expect(items[0].body).toContain('Name the constant');
    expect(items[0].body).not.toContain('Cover the empty case');
  });
});

describe('foreman learn while Foreman learns traits itself (learning.auto)', () => {
  const autoOn = () => writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'T' }, checks: [{ run: 'true', when: 'always' }] }));
  const shippedMinor = () => {
    mkdirSync(join(dir, 'stories'), { recursive: true });
    writeFileSync(join(dir, 'stories', 'S-5.md'), '---\nid: S-5\ntitle: Five\nstatus: done\n---\n\n# S-5\n');
    return line('S-5', 'Name the constant', { result: 'shipped', severity: 'minor', where: 'src/a.js' });
  };

  it('by default proposes no trait, says why, and still proposes follow-ups', async () => {
    autoOn();
    findings(line('S-1', 'Every route needs a test.'), line('S-2', 'every route needs a test'), line('S-3', 'Every route needs a test'), shippedMinor());
    const { code, out } = await run(['learn']);
    expect(code).toBe(0);
    expect(out).toContain('Trait proposals are off while Foreman learns traits itself (learning.auto).');
    expect(out).toContain('Proposed 1 follow-up(s) from minor findings.');
    const items = await pending();
    expect(items.map((i) => i.title)).toEqual(['Follow up on S-5: 1 minor finding(s)?']);
    expect(items.some((i) => i.title.startsWith('Add a trait'))).toBe(false);
  });

  it('proposes the trait again with learning.auto off', async () => {
    autoOn();
    repeated();
    mkdirSync(state(), { recursive: true });
    writeFileSync(join(state(), 'settings.json'), JSON.stringify({ 'learning.auto': false }));
    const { out } = await run(['learn']);
    expect(out).not.toContain('learning.auto');
    expect(out).toContain('Proposed 1 trait(s) from repeated findings.');
  });
});
