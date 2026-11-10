import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createdSummary, createdTitle, followUpDoneWhen, followUpKey, followUps, followUpSummary, followUpTitle, followUpWhat, keyOf, learnEvent, normaliseRule, parseFindings, proposals, traitExplain, traitHints, traitSummary } from './learn.mjs';
import { explainProblems } from '../console/decisions.mjs';

const f = (story, rule, extra = {}) => ({ story, result: 'failed', builder: 'developer', stage: 'review', severity: 'major', rule, where: `${story}.js`, observed: 'o', fix: 'add a test', ...extra });

describe('normaliseRule', () => {
  it('lower-cases, trims, collapses whitespace and strips trailing punctuation and quotes', () => {
    expect(normaliseRule('  Every route needs   a test.  ')).toBe('every route needs a test');
    expect(normaliseRule('"Every route needs a test!"')).toBe('every route needs a test');
    expect(normaliseRule('every\nroute needs a test;')).toBe('every route needs a test');
    expect(normaliseRule(undefined)).toBe('');
  });
});

describe('parseFindings', () => {
  it('reads JSON lines and skips the bad ones', () => {
    expect(parseFindings('{"a":1}\nnope\n\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe('proposals', () => {
  it('groups near-identical rules by builder', () => {
    const lines = [f('S-1', 'Every route needs a test.'), f('S-2', 'every  route needs a test'), f('S-3', '"Every route needs a test"')];
    const out = proposals(lines);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ key: keyOf('developer', 'every route needs a test'), builder: 'developer', rule: 'Every route needs a test', stories: ['S-1', 'S-2', 'S-3'] });
    expect(out[0].examples).toEqual([
      { story: 'S-1', where: 'S-1.js', fix: 'add a test' },
      { story: 'S-2', where: 'S-2.js', fix: 'add a test' },
      { story: 'S-3', where: 'S-3.js', fix: 'add a test' },
    ]);
    expect(out[0].trait).toBe('Every route needs a test (the usual fix: add a test).');
  });

  it('counts distinct stories: the same story twice counts once', () => {
    expect(proposals([f('S-1', 'r'), f('S-1', 'r'), f('S-2', 'r')])).toEqual([]);
    expect(proposals([f('S-1', 'r'), f('S-1', 'r'), f('S-2', 'r'), f('S-3', 'r')])[0].stories).toEqual(['S-1', 'S-2', 'S-3']);
  });

  it('honours the threshold', () => {
    const lines = [f('S-1', 'r'), f('S-2', 'r')];
    expect(proposals(lines)).toEqual([]);
    expect(proposals(lines, { minStories: 2 })).toHaveLength(1);
  });

  it('counts only blocker and major findings', () => {
    const lines = ['S-1', 'S-2', 'S-3'].map((s) => f(s, 'r', { severity: 'minor' }));
    expect(proposals(lines)).toEqual([]);
    expect(proposals(['S-1', 'S-2', 'S-3'].map((s) => f(s, 'r', { severity: 'blocker' })))).toHaveLength(1);
  });

  it('keeps builders apart and puts lines without a builder under "all"', () => {
    const lines = [f('S-1', 'r'), f('S-2', 'r'), f('S-3', 'r', { builder: 'ui-builder' }), f('S-4', 'r', { builder: undefined }), f('S-5', 'r', { builder: '' }), f('S-6', 'r', { builder: undefined })];
    const out = proposals(lines);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ builder: 'all', key: keyOf('all', 'r'), stories: ['S-4', 'S-5', 'S-6'] });
  });

  it('builds the trait from the most common fix', () => {
    const lines = [f('S-1', 'Use the logger.', { fix: 'Call log.info.' }), f('S-2', 'use the logger', { fix: 'call log.info' }), f('S-3', 'use the logger', { fix: 'something else' })];
    expect(proposals(lines)[0].trait).toBe('Use the logger (the usual fix: Call log.info).');
    expect(proposals(['S-1', 'S-2', 'S-3'].map((s) => f(s, 'use the logger', { fix: '' })))[0].trait).toBe('Use the logger.');
  });

  it('keeps at most three examples', () => {
    const lines = ['S-1', 'S-2', 'S-3', 'S-4'].map((s) => f(s, 'r'));
    expect(proposals(lines)[0].examples).toHaveLength(3);
  });

  it('skips ignored keys', () => {
    const lines = ['S-1', 'S-2', 'S-3'].map((s) => f(s, 'r'));
    expect(proposals(lines, { ignored: [keyOf('developer', 'R.')] })).toEqual([]);
  });

  it("skips a rule already in that builder's traits, or in all", () => {
    const lines = ['S-1', 'S-2', 'S-3'].map((s) => f(s, 'Every route needs a test.'));
    expect(proposals(lines, { existingTraits: { developer: 'Be kind.\n\nEvery route   needs a test (the usual fix: x).' } })).toEqual([]);
    expect(proposals(lines, { existingTraits: { all: 'EVERY ROUTE NEEDS A TEST' } })).toEqual([]);
    expect(proposals(lines, { existingTraits: { 'ui-builder': 'every route needs a test' } })).toHaveLength(1);
  });

  it('counts resolved round findings like any other', () => {
    const lines = [f('S-1', 'r', { round: 1, resolved: true }), f('S-2', 'r', { round: 1, resolved: true }), f('S-3', 'r')];
    const out = proposals(lines);
    expect(out).toHaveLength(1);
    expect(out[0].stories).toEqual(['S-1', 'S-2', 'S-3']);
  });

  it('skips findings with no rule or no story', () => {
    const lines = [f('S-1', ''), f('S-2', ''), f('S-3', ''), f('', 'r'), f(undefined, 'r'), f('S-9', 'r')];
    expect(proposals(lines, { minStories: 2 })).toEqual([]);
  });
});

describe('the supervisor', () => {
  it('runs foreman learn once while stopping, through its owner commands', () => {
    const src = readFileSync(new URL('./supervisor.mjs', import.meta.url), 'utf8');
    const stop = src.slice(src.indexOf('async function stop('), src.indexOf('function tick('));
    expect(stop.match(/owner\.finish\(/g)).toHaveLength(1);
    expect(stop).not.toContain('owner.learn(');
    expect(stop).toContain('await owner.finish(');
    expect(src).toContain('const owner = ownerCommands({ bin: FOREMAN_BIN, root: ROOT, event, node: () => NODE.node() });');
    const own = readFileSync(new URL('./owner-commands.mjs', import.meta.url), 'utf8');
    expect(own).toContain("call(['learn'], learnMs)");
  });
});

describe('followUps', () => {
  const m = (story, rule, extra = {}) => f(story, rule, { result: 'shipped', severity: 'minor', where: 'a.js', observed: 'no test', fix: 'add one', ...extra });

  it('groups the minor findings of each shipped story into one proposal', () => {
    const out = followUps([m('S-3', 'Every route needs a test.'), m('S-4', 'Log errors'), m('S-3', 'Name the constant', { where: 'b.js' })]);
    expect(out).toEqual([
      {
        story: 'S-3',
        keys: [followUpKey('S-3', 'every route needs a test'), followUpKey('S-3', 'name the constant')],
        findings: [
          { rule: 'Every route needs a test', where: 'a.js', observed: 'no test', fix: 'add one' },
          { rule: 'Name the constant', where: 'b.js', observed: 'no test', fix: 'add one' },
        ],
      },
      { story: 'S-4', keys: ['followup:S-4:log errors'], findings: [{ rule: 'Log errors', where: 'a.js', observed: 'no test', fix: 'add one' }] },
    ]);
    expect(followUpKey('S-3', ' Every route needs a test. ')).toBe('followup:S-3:every route needs a test');
  });

  it('takes only minor findings, and only from stories that shipped', () => {
    const lines = [m('S-1', 'r', { severity: 'major' }), m('S-2', 'r', { result: 'failed' }), m('S-3', 'r', { result: 'blocked' }), m('S-4', 'r', { severity: 'MINOR' })];
    expect(followUps(lines).map((p) => p.story)).toEqual(['S-4']);
  });

  it('followUps ignores resolved serious lines', () => {
    expect(followUps([m('S-1', 'r', { severity: 'major', round: 1, resolved: true })])).toEqual([]);
  });

  it('keeps one finding per rule within a story', () => {
    expect(followUps([m('S-3', 'Log errors'), m('S-3', 'log errors.', { where: 'b.js' })])[0].findings).toHaveLength(1);
  });

  it('skips findings already proposed, and stories left with none', () => {
    const lines = [m('S-3', 'Log errors'), m('S-3', 'Name it'), m('S-4', 'Log errors')];
    const out = followUps(lines, { seen: [followUpKey('S-3', 'log errors'), followUpKey('S-4', 'log errors')] });
    expect(out).toEqual([expect.objectContaining({ story: 'S-3', keys: [followUpKey('S-3', 'name it')] })]);
  });

  it("skips a finding whose rule an existing story's title already covers", () => {
    const lines = [m('S-3', 'Log errors'), m('S-3', 'Name the constant')];
    const out = followUps(lines, { titles: ['Log errors.', 'Something else'] });
    expect(out[0].findings.map((x) => x.rule)).toEqual(['Name the constant']);
    expect(followUps(lines, { titles: ['Make every handler log errors'] })[0].findings.map((x) => x.rule)).toEqual(['Name the constant']);
  });

  it('skips findings with no story or no rule', () => {
    expect(followUps([m('', 'r'), m('S-3', ''), m(undefined, 'r')])).toEqual([]);
  });

  it('words the question and the new story', () => {
    const [p] = followUps([m('S-3', 'Log errors'), m('S-3', 'Name it', { where: '', observed: '', fix: '' })]);
    expect(followUpTitle(p)).toBe('Follow up on S-3: 2 minor finding(s)?');
    expect(followUpWhat(p)).toBe('- Log errors (`a.js`): no test — fix: add one\n- Name it');
    expect(followUpDoneWhen([{ run: 'npm test', when: 'always' }, { run: 'npm run lint', when: 'src/**' }])).toBe('Each listed finding is fixed, with a test where it is a behaviour, and `npm test` passes.');
    expect(followUpDoneWhen([{ run: 'a', when: 'always' }, { run: 'b', when: 'always' }])).toBe('Each listed finding is fixed, with a test where it is a behaviour, and `a` and `b` pass.');
    expect(followUpDoneWhen([])).toBe("Each listed finding is fixed, with a test where it is a behaviour, and the project's checks pass.");
  });
});

describe('learnEvent', () => {
  it('names follow-up proposals too', () => {
    expect(learnEvent('Proposed 0 trait(s) from repeated findings.\nProposed 2 follow-up(s) from minor findings.\n')).toBe('Proposed 2 follow-up(s) from minor findings');
    expect(learnEvent('Proposed 1 trait(s) from repeated findings.\nProposed 2 follow-up(s) from minor findings.\n')).toBe('Proposed 1 trait(s) from repeated findings; proposed 2 follow-up(s) from minor findings');
  });

  it('turns the command output into the event text, or null', () => {
    expect(learnEvent('x\nProposed 2 trait(s) from repeated findings.\n')).toBe('Proposed 2 trait(s) from repeated findings');
    expect(learnEvent('Proposed 0 trait(s) from repeated findings.\n')).toBeNull();
    expect(learnEvent('')).toBeNull();
    expect(learnEvent(undefined)).toBeNull();
  });

  it('names the follow-up stories Foreman created itself', () => {
    const created = 'Proposed 0 trait(s) from repeated findings.\nCreated 16 follow-up story(s) from minor findings.\nProposed 0 follow-up(s) from minor findings.\n';
    expect(learnEvent(created)).toBe('Created 16 follow-up story(s) from minor findings');
    expect(learnEvent('Proposed 1 trait(s) from repeated findings.\nCreated 2 follow-up story(s) from minor findings.\nProposed 1 follow-up(s) from minor findings.\n')).toBe(
      'Proposed 1 trait(s) from repeated findings; created 2 follow-up story(s) from minor findings; proposed 1 follow-up(s) from minor findings',
    );
    expect(learnEvent('Created 2 follow-up story(s) from minor findings.\nProposed 1 follow-up(s) from minor findings.\n')).toBe('Created 2 follow-up story(s) from minor findings; proposed 1 follow-up(s) from minor findings');
    expect(learnEvent('Proposed 0 trait(s) from repeated findings.\nCreated 0 follow-up story(s) from minor findings.\nProposed 0 follow-up(s) from minor findings.\n')).toBeNull();
  });
});

describe('createdTitle and createdSummary', () => {
  it('names how many follow-up stories Foreman created', () => {
    expect(createdTitle(1)).toBe('Foreman created 1 follow-up story');
    expect(createdTitle(16)).toBe('Foreman created 16 follow-up stories');
  });

  it('names the new stories and their origins', () => {
    expect(createdSummary([{ id: 'F-1', story: 'S-3' }])).toBe('F-1 to fix the minor findings of S-3');
    expect(createdSummary([{ id: 'F-1', story: 'S-3' }, { id: 'F-2', story: 'S-4' }])).toBe('F-1 and F-2 to fix the minor findings of S-3 and S-4');
  });

  it('stays within 160 characters for 16 stories', () => {
    const stories = Array.from({ length: 16 }, (_, i) => ({ id: `ACME-${300 + i}`, story: `ACME-${200 + i}` }));
    const line = createdSummary(stories);
    expect(line.length).toBeLessThanOrEqual(160);
    expect(line).toBe('ACME-300, ACME-301 and 14 more to fix the minor findings of ACME-200, ACME-201 and 14 more');
  });

  it('cuts very long ids at a word, within 160 characters', () => {
    const long = (n) => `ACME-${'9'.repeat(70)}${n}`;
    const line = createdSummary([{ id: long(1), story: long(2) }, { id: long(3), story: long(4) }]);
    expect(line.length).toBeLessThanOrEqual(160);
    expect(line.endsWith('…')).toBe(true);
  });
});

describe('followUpSummary', () => {
  const p = (...rules) => ({ story: 'S-3', findings: rules.map((rule) => ({ rule, where: '', observed: '', fix: '' })) });

  it('counts the findings and joins their rules, each starting lower-case', () => {
    expect(followUpSummary(p('LoadConfig can throw', 'A test passes without the fix', 'Doctor misses an adapter clash'))).toBe(
      '3 minor: loadConfig can throw; a test passes without the fix; doctor misses an adapter clash',
    );
  });

  it('keeps an acronym as written', () => {
    expect(followUpSummary(p('CSRF token missing'))).toBe('1 minor: CSRF token missing');
  });

  it('keeps whole rules within 160 characters and says how many more there are', () => {
    const rules = Array.from({ length: 12 }, (_, i) => `Rule number ${i + 1} says something long enough to matter here`);
    const out = followUpSummary(p(...rules));
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out).toMatch(/^12 minor: rule number 1 says/);
    expect(out).toMatch(/; and \d+ more$/);
    const shown = out.replace(/; and \d+ more$/, '').split('; ').length;
    expect(out.endsWith(`; and ${12 - shown} more`)).toBe(true);
  });

  it('cuts a single long rule at a word and ends it with an ellipsis', () => {
    const rule = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ').slice(0, 300);
    const out = followUpSummary(p(rule.padEnd(300, 'x')));
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out.endsWith('…')).toBe(true);
    expect(out.startsWith('1 minor: word0 word1')).toBe(true);
    expect(out.slice(0, -1)).toMatch(/word\d+$/);
  });

  it('keeps a long rule with no spaces instead of cutting it to the head', () => {
    const out = followUpSummary(p('x'.repeat(300)));
    expect(out).toBe(`1 minor: ${'x'.repeat(150)}…`);
    expect(out).toHaveLength(160);
  });

  it('hard-cuts a long URL with no spaces', () => {
    const out = followUpSummary(p(`https://acme.example/${'a/'.repeat(150)}`));
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out.startsWith('1 minor: https://acme.example/a/')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
  });

  it('never splits an emoji', () => {
    const out = followUpSummary(p('😀'.repeat(100)));
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out.endsWith('…')).toBe(true);
    expect(out.startsWith('1 minor: 😀')).toBe(true);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(out.isWellFormed()).toBe(true);
    expect(out.slice(9, -1)).toBe('😀'.repeat(75));
  });

  // The 'a' shifts the emoji by one unit, so a plain slice at max-1 would land inside a pair.
  it('never splits an emoji when the cut falls inside a surrogate pair', () => {
    const out = followUpSummary(p(`a${'😀'.repeat(100)}`));
    expect(out.isWellFormed()).toBe(true);
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out).toBe(`1 minor: a${'😀'.repeat(74)}…`);
  });

  it('never splits an emoji before the "and N more" tail', () => {
    const out = followUpSummary(p(`a${'😀'.repeat(100)}`, 'x'));
    expect(out.isWellFormed()).toBe(true);
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out).toBe(`2 minor: a${'😀'.repeat(68)}…; and 1 more`);
  });

  it('keeps the "and N more" tail when the first rule alone is too long', () => {
    const out = followUpSummary(p('A'.repeat(150), 'Second rule'));
    expect(out).toBe(`2 minor: ${'A'.repeat(138)}…; and 1 more`);
    expect(out).toHaveLength(160);
  });

  it('cuts the first rule at a word before the "and N more" tail', () => {
    const first = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ').slice(0, 150);
    const out = followUpSummary(p(first, 'Second rule'));
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out.endsWith('; and 1 more')).toBe(true);
    expect(out.startsWith('2 minor: word0 word1')).toBe(true);
    expect(out.slice(0, -'; and 1 more'.length)).toMatch(/word\d+…$/);
  });
});

describe('traitSummary', () => {
  it('names the builder and up to three stories', () => {
    expect(traitSummary({ builder: 'developer', stories: ['S-1', 'S-2', 'S-3'] })).toBe('Stopped 3 stories for developer: S-1, S-2 and S-3');
  });

  it('names two stories and how many more past three', () => {
    expect(traitSummary({ builder: 'developer', stories: ['S-1', 'S-2', 'S-3', 'S-4', 'S-5'] })).toBe('Stopped 5 stories for developer: S-1, S-2 and 3 more');
  });

  it('says the builders for findings without one', () => {
    expect(traitSummary({ builder: 'all', stories: ['S-1', 'S-2', 'S-3'] })).toBe('Stopped 3 stories for the builders: S-1, S-2 and S-3');
  });

  it('stays within 160 characters', () => {
    const out = traitSummary({ builder: 'b'.repeat(200), stories: ['S-1', 'S-2', 'S-3'] });
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('traitExplain and traitHints', () => {
  const stories = ['ACME-1', 'ACME-2', 'ACME-3', 'ACME-4', 'ACME-5'];
  for (const builder of ['developer', 'all']) {
    it(`say a trait proposal for ${builder} in plain words`, () => {
      const p = { builder, rule: 'Every route needs a test', stories, trait: 'Every route needs a test (the usual fix: add a test).' };
      const explain = traitExplain(p);
      expect(Object.keys(explain)).toEqual(['purpose', 'happened', 'recommendation']);
      expect(explain.purpose).toMatch(/every story/);
      expect(explain.purpose).toContain(builder === 'all' ? 'every builder' : 'developer');
      expect(explain.happened).toContain('5 stories');
      expect(explain.happened).toContain('ACME-1, ACME-2 and 3 more');
      expect(explain.recommendation).toMatch(/^Add as a trait/);
      for (const part of Object.values(explain)) expect(part.length, part).toBeLessThanOrEqual(280);
      expect(explainProblems(explain)).toEqual([]);
      const hints = traitHints(p);
      expect(hints).toHaveLength(2);
      for (const h of hints) expect(h.length, h).toBeLessThanOrEqual(100);
      for (const h of hints) expect(explainProblems({ happened: h }), h).toEqual([]);
      expect(hints[0]).toMatch(/every story/);
      expect(hints[1]).toMatch(/Nothing changes/);
    });
  }

  it('names up to three stories in full and stays within 280 for a long builder name', () => {
    expect(traitExplain({ builder: 'developer', stories: ['ACME-1', 'ACME-2', 'ACME-3'] }).happened).toContain('ACME-1, ACME-2 and ACME-3');
    const long = traitExplain({ builder: 'b'.repeat(400), stories });
    for (const part of Object.values(long)) expect(part.length).toBeLessThanOrEqual(280);
    for (const h of traitHints({ builder: 'b'.repeat(400), stories })) expect(h.length).toBeLessThanOrEqual(100);
  });
});
