import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildWaiting, headline, isFyiNote, SLOT_LABELS, standbyNews, strandedStories, waitingCount } from './waiting.mjs';
import { actionsFor } from '../engine/scheduler.mjs';
import { creditsOutFyi, hhmm } from '../engine/claude-fallback.mjs';
import { nextWaitWhy } from '../engine/next-request.mjs';
import { anchorWaitWhy } from '../engine/anchor-pull.mjs';

const ID = '[A-Z]+-\\d+';
const ROOT = join(tmpdir(), 'acme');
const s = (id, over = {}) => ({
  id, title: `Story ${id}`, ref: join(ROOT, 'stories', `${id}.md`), status: 'todo', group: '', groupName: '', order: 0,
  dependsOn: [], blockedBy: '', ownerTask: false, resources: [], ...over,
});
const decision = (over = {}) => ({
  id: 'd-20261015090000-abcd', story: 'ABC-1', kind: 'decision', title: 'Which login?', options: [], urgent: false,
  body: '', createdAt: '2026-10-15T09:00:00.000Z', answer: null, appliedAt: null, ...over,
});
const build = (over = {}) => buildWaiting({ decisions: null, stories: [], idPattern: ID, slots: [], halt: null, parks: [], root: ROOT, ...over });

// Today's FM spikes and what waits on them, with Acme ids: 14 open stories, 6 owner tasks that
// can start now and 9 that wait on open stories.
function fmStories() {
  const n = (k) => `ACME-${k}`;
  const story = (k, deps = [], over = {}) => s(n(k), { dependsOn: deps.map(n), ...over });
  const owner = (k, deps = [], over = {}) => story(k, deps, { ownerTask: true, ...over });
  return [
    ...[21, 23, 24, 27, 28, 29, 30, 36, 39, 58].map((k) => story(k, [], { status: 'done' })),
    story(31, [12, 30]),
    story(32, [29, 18]),
    story(33, [23, 29, 14]),
    story(34, [33]),
    story(35, [34]),
    story(37, [28, 36, 13]),
    story(38, [37]),
    story(42, [34]),
    story(43, [35, 42]),
    story(45, [21, 33, 15]),
    story(46, [24, 45]),
    story(53, [35, 38, 17]),
    story(54, [53]),
    story(57, [27, 32]),
    ...[12, 13, 14, 15, 17, 18].map((k) => owner(k, [], k === 14 ? { title: 'Spike: one story by hand on the direct path' } : {})),
    owner(40, [30, 31, 32, 35, 38, 39]),
    owner(41, [40]),
    owner(44, [43, 41]),
    owner(47, [46]),
    owner(48, [44, 47]),
    owner(55, [54, 41]),
    owner(56, [55, 48]),
    owner(59, [57, 58, 56]),
    owner(60, [59]),
  ];
}

describe('decisions', () => {
  it('a files decision with options offers each option, and blocks its story and what waits on it', () => {
    const stories = [s('ABC-1'), s('ABC-2', { dependsOn: ['ABC-1'] })];
    const [item] = build({ stories, decisions: { source: 'files', items: [decision({ options: ['yes', 'no'], body: '  Pick one.  ' })] } });
    expect(item).toEqual({
      id: 'd-20261015090000-abcd',
      kind: 'decision',
      title: 'Which login?',
      why: 'Pick one.',
      blocks: ['ABC-1', 'ABC-2'],
      frees: ['ABC-1'],
      details: 'Pick one.',
      actions: [{ id: 'option-0', label: 'yes', hint: null, recommended: false }, { id: 'option-1', label: 'no', hint: null, recommended: false }],
      group: 'now',
    });
  });

  const files = (over) => build({ decisions: { source: 'files', items: [decision(over)] } })[0];

  it('summary becomes why, body becomes details', () => {
    const item = files({ summary: 'Pick the login.', body: 'Long text.\n\nMore.' });
    expect(item.why).toBe('Pick the login.');
    expect(item.details).toBe('Long text.\n\nMore.');
    expect(files({ summary: ` ${'x'.repeat(200)} ` }).why).toBe('x'.repeat(160));
    expect(files({})).not.toHaveProperty('details');
  });

  it('carries the explanation, trimmed and cut, after details', () => {
    const explain = { purpose: '  Keeps the keys apart.  ', happened: ` ${'h'.repeat(300)} `, damage: 'No.', recommendation: 'Retry: the fix is small.' };
    const item = files({ summary: 'A test step could change the real key file.', body: 'FOREMAN_PROJECT_DIR anchors .env.local.\n\nMore.', options: ['Retry', 'Drop'], explain });
    expect(item.explain).toEqual({ purpose: 'Keeps the keys apart.', happened: 'h'.repeat(280), damage: 'No.', recommendation: 'Retry: the fix is small.' });
    expect(item.details).toBe('FOREMAN_PROJECT_DIR anchors .env.local.\n\nMore.');
    expect(item.why).toBe('A test step could change the real key file.');
    const keys = Object.keys(item);
    expect(keys.indexOf('explain')).toBe(keys.indexOf('details') + 1);
    const { damage, ...rest } = explain;
    expect(files({ explain: rest }).explain).not.toHaveProperty('damage');
    expect(files({ explain: { purpose: 'Only this.', happened: 42 } }).explain).toEqual({ purpose: 'Only this.' });
  });

  it('a decision without an explanation, or with no text in it, has no explain key', () => {
    expect(files({})).not.toHaveProperty('explain');
    for (const explain of [{}, { purpose: '  ', happened: 3 }, 'Keeps the keys apart.', null, ['a']]) expect(files({ explain }), JSON.stringify(explain)).not.toHaveProperty('explain');
  });

  it("with no summary, why is the body's first paragraph, cut at a sentence end, never mid-word", () => {
    expect(files({ body: 'One. Two.\n\nThree.' }).why).toBe('One. Two.');
    expect(files({ body: 'One\n  two.\n \nThree.' }).why).toBe('One two.');

    const sentences = Array.from({ length: 40 }, (_, i) => `Line ${String(i).padStart(2, '0')} ok.`).join(' ');
    expect(sentences.length).toBeGreaterThanOrEqual(400);
    const why = files({ body: sentences }).why;
    expect(why.length).toBeLessThanOrEqual(300);
    expect(why.endsWith('.')).toBe(true);
    expect(why).not.toContain('…');
    expect(sentences.startsWith(why)).toBe(true);

    const words = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
    expect(words.length).toBeGreaterThanOrEqual(400);
    const cutWhy = files({ body: words }).why;
    expect(cutWhy.endsWith('…')).toBe(true);
    const before = cutWhy.slice(0, -1);
    expect(before.length).toBeLessThanOrEqual(300);
    expect(words.startsWith(before)).toBe(true);
    expect(words[before.length]).toBe(' ');

    const punct = `${'abc '.repeat(72)}tail, ${'x'.repeat(20)} more`;
    expect(files({ body: punct }).why).toBe(`${'abc '.repeat(72)}tail…`);

    const long = 'x'.repeat(400);
    expect(files({ body: long }).why.replace('…', '').length).toBeLessThanOrEqual(300);

    expect(files({}).why).toBe('ABC-1 needs your decision');
  });

  it('the recommended option comes first with its hint', () => {
    const item = files({ options: ['yes', 'no'], hints: ['Ships.', 'Stops.'], recommend: 'no' });
    expect(item.actions).toEqual([
      { id: 'option-1', label: 'no', hint: 'Stops.', recommended: true },
      { id: 'option-0', label: 'yes', hint: 'Ships.', recommended: false },
    ]);
    const three = files({ options: ['a', 'b', 'c'], recommend: 'c' });
    expect(three.actions.map((a) => a.id)).toEqual(['option-2', 'option-0', 'option-1']);
    expect(files({ options: ['a'], hints: [` ${'h'.repeat(120)} `] }).actions[0].hint).toBe('h'.repeat(100));
    expect(files({ options: ['a', 'b'], hints: 'nope' }).actions.map((a) => a.hint)).toEqual([null, null]);
  });

  it('with duplicate labels only the first matching option is recommended', () => {
    expect(files({ options: ['a', 'b', 'a'], recommend: 'a' }).actions).toEqual([
      { id: 'option-0', label: 'a', hint: null, recommended: true },
      { id: 'option-1', label: 'b', hint: null, recommended: false },
      { id: 'option-2', label: 'a', hint: null, recommended: false },
    ]);
    const later = files({ options: ['b', 'a', 'a'], recommend: 'a' }).actions;
    expect(later.filter((a) => a.recommended).map((a) => a.id)).toEqual(['option-1']);
    expect(later.map((a) => a.id)).toEqual(['option-1', 'option-0', 'option-2']);
  });

  it('a follow-up decision on a shipped story blocks nothing', () => {
    const stories = [s('ABC-1', { status: 'done' }), s('ABC-2', { dependsOn: ['ABC-1'] })];
    const [item] = build({ stories, decisions: { source: 'files', items: [decision({ options: ['yes', 'no'] })] } });
    expect(item.blocks).toEqual([]);
    expect(item.frees).toEqual([]);
  });

  it('a task with no options takes one answer in words', () => {
    const [item] = build({ decisions: { source: 'files', items: [decision({ kind: 'task', title: 'Add the key' })] } });
    expect(item.actions).toEqual([{ id: 'answer', label: 'Send answer' }]);
    expect(item.why).toBe('ABC-1 needs your answer');
  });

  it('a copy decision counts, with no action here', () => {
    const items = build({ decisions: { source: 'copy', items: [{ id: 'c-1', title: 'Pick a scheduler', kind: 'decision' }] } });
    expect(items).toEqual([{ id: 'c-1', kind: 'decision', title: 'Pick a scheduler', why: 'Answer it on your decisions page.', blocks: [], frees: [], actions: [], group: 'now' }]);
  });
});

describe('bundles', () => {
  it('follow-ups share a bundle and count as one', () => {
    const FOLLOW = ['Create a follow-up story', 'Ignore'];
    const follow = (n) => decision({ id: `d-2026101509000${n}-fu0${n}`, story: `ABC-${n}`, title: `Follow up on ABC-${n}: 2 minor finding(s)?`, options: FOLLOW, summary: '2 minor: a; b' });
    const plain = decision({ id: 'd-20261015090004-plan', story: 'ABC-4', title: 'Which login?', options: ['yes', 'no'] });
    const trait = decision({ id: 'd-20261015090005-trai', story: 'ABC-5', title: 'Add a trait for developer: Check inputs?', options: ['Add as a trait', 'Ignore'] });
    const stories = [s('ABC-6', { ownerTask: true, dependsOn: ['ABC-7'] }), s('ABC-7')];
    const items = build({ stories, decisions: { source: 'files', items: [follow(1), follow(2), follow(3), plain, trait] } });
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));

    for (const n of [1, 2, 3]) {
      expect(byId[`d-2026101509000${n}-fu0${n}`]).toMatchObject({ bundle: 'follow-ups', story: `ABC-${n}`, minor: 2, group: 'now', why: '2 minor: a; b' });
    }
    expect(byId['d-20261015090005-trai'].bundle).toBe('traits');
    expect(byId['d-20261015090005-trai']).not.toHaveProperty('minor');
    for (const k of ['bundle', 'story', 'minor']) expect(byId['d-20261015090004-plan']).not.toHaveProperty(k);
    expect(byId['task:ABC-6'].group).toBe('later');

    // 1 plain + 1 follow-ups bundle + 1 traits bundle; the later owner task is not counted.
    expect(waitingCount(items)).toBe(3);
    expect(waitingCount([])).toBe(0);

    const copy = build({ decisions: { source: 'copy', items: [{ id: 'c-1', title: 'Follow up on ABC-1: 2 minor finding(s)?', kind: 'decision' }] } });
    expect(copy[0]).not.toHaveProperty('bundle');
    expect(waitingCount(copy)).toBe(1);

    const close = build({ decisions: { source: 'files', items: [decision({ title: 'Follow up on ABC-1?', options: FOLLOW })] } });
    expect(close[0]).not.toHaveProperty('bundle');
    const noOptions = build({ decisions: { source: 'files', items: [decision({ title: 'Follow up on ABC-1: 2 minor finding(s)?', options: [] })] } });
    expect(noOptions[0]).not.toHaveProperty('bundle');
    // A trait proposal with no options stays a plain item: Add all could never answer it.
    const traitNoOptions = build({ decisions: { source: 'files', items: [decision({ title: 'Add a trait for developer: Check inputs?', options: [] })] } });
    expect(traitNoOptions[0]).not.toHaveProperty('bundle');
    expect(waitingCount(traitNoOptions)).toBe(1);
  });
});

describe('owner tasks', () => {
  const task = (ref) => build({ stories: [s('ABC-1', { ownerTask: true, title: 'Add the key (owner task)', ref })] })[0];

  it('lists an open owner task with what it blocks and Mark done', () => {
    const stories = [s('ABC-1', { ownerTask: true, title: 'Add the key (owner task)' }), s('ABC-2', { dependsOn: ['ABC-1'] }), s('ABC-3', { ownerTask: true, status: 'done' })];
    expect(build({ stories })).toEqual([
      { id: 'task:ABC-1', kind: 'owner-task', title: 'Add the key (owner task)', why: 'Frees ABC-2 now. 1 story waits on it.', blocks: ['ABC-2'], frees: ['ABC-2'], link: join('stories', 'ABC-1.md'), actions: [{ id: 'done', label: 'Mark done' }], group: 'now' },
    ]);
  });

  it('says why when blocked, and when nothing waits on it', () => {
    expect(build({ stories: [s('ABC-1', { ownerTask: true, status: 'blocked', blockedBy: 'Waiting for the vendor' })] })[0].why).toBe('Waiting for the vendor');
    expect(build({ stories: [s('ABC-1', { ownerTask: true })] })[0].why).toBe('An open owner task.');
  });

  it('links a Jira issue as is and a file inside the root relatively, and never a local path outside it', () => {
    expect(task('https://acme.atlassian.net/browse/ABC-1').link).toBe('https://acme.atlassian.net/browse/ABC-1');
    expect(task(join(ROOT, 'stories', 'ABC-1.md')).link).toBe('stories/ABC-1.md');
    expect(task(join(tmpdir(), 'elsewhere', 'ABC-1.md'))).not.toHaveProperty('link');
    const noRoot = (ref) => buildWaiting({ stories: [s('ABC-1', { ownerTask: true, ref })], idPattern: ID })[0];
    expect(noRoot(join(ROOT, 'stories', 'ABC-1.md'))).not.toHaveProperty('link');
    expect(noRoot('https://acme.atlassian.net/browse/ABC-1').link).toBe('https://acme.atlassian.net/browse/ABC-1');
  });

  it('an owner task with an open blocker is later, with waitsOn', () => {
    const stories = [s('ABC-1', { ownerTask: true, dependsOn: ['ABC-2', 'ABC-3'] }), s('ABC-2'), s('ABC-3', { status: 'done' })];
    const item = build({ stories }).find((i) => i.id === 'task:ABC-1');
    expect(item).toMatchObject({ group: 'later', waitsOn: ['ABC-2'], why: 'Can start after ABC-2.', actions: [{ id: 'done', label: 'Mark done' }] });

    const outside = build({ stories: [s('ABC-1', { ownerTask: true, dependsOn: ['ABC-9'], externalDeps: { 'ABC-9': 'not done' } })] })[0];
    expect(outside).toMatchObject({ group: 'later', waitsOn: ['ABC-9'] });

    const after = (ids) => {
      const list = [s('ABC-1', { ownerTask: true, dependsOn: ids }), ...ids.map((id) => s(id))];
      return build({ stories: list }).find((i) => i.id === 'task:ABC-1').why;
    };
    expect(after(['ABC-31', 'ABC-32', 'ABC-33', 'ABC-34', 'ABC-35', 'ABC-36'])).toBe('Can start after ABC-31, ABC-32 and 4 more.');
    expect(after(['ABC-31', 'ABC-32'])).toBe('Can start after ABC-31 and ABC-32.');
    expect(after(['ABC-31', 'ABC-32', 'ABC-33'])).toBe('Can start after ABC-31, ABC-32 and ABC-33.');
  });

  it('an owner task that depends on itself is now, and only its other open blockers hold it', () => {
    const self = build({ stories: [s('ABC-1', { ownerTask: true, dependsOn: ['ABC-1'] })] })[0];
    expect(self.group).toBe('now');
    expect(self).not.toHaveProperty('waitsOn');
    expect(self.why).toBe('An open owner task.');

    const both = build({ stories: [s('ABC-1', { ownerTask: true, dependsOn: ['ABC-1', 'ABC-2'] }), s('ABC-2')] }).find((i) => i.id === 'task:ABC-1');
    expect(both).toMatchObject({ group: 'later', waitsOn: ['ABC-2'], why: 'Can start after ABC-2.' });
  });

  it('two owner tasks that depend on each other are both now', () => {
    const items = build({ stories: [s('ABC-1', { ownerTask: true, dependsOn: ['ABC-2'] }), s('ABC-2', { ownerTask: true, dependsOn: ['ABC-1'] })] });
    for (const id of ['task:ABC-1', 'task:ABC-2']) {
      const item = items.find((i) => i.id === id);
      expect(item.group).toBe('now');
      expect(item).not.toHaveProperty('waitsOn');
    }
    expect(waitingCount(items)).toBe(2);
  });

  it('an owner task in a cycle through plain stories is now, and still blocks them', () => {
    const stories = [s('ABC-1', { ownerTask: true, dependsOn: ['ABC-5'] }), s('ABC-5', { dependsOn: ['ABC-6'] }), s('ABC-6', { dependsOn: ['ABC-1'] })];
    const item = build({ stories }).find((i) => i.id === 'task:ABC-1');
    expect(item.group).toBe('now');
    expect(item).not.toHaveProperty('waitsOn');
    expect(item.blocks).toEqual(expect.arrayContaining(['ABC-5', 'ABC-6']));

    const direct = build({ stories: [s('ABC-1', { ownerTask: true, dependsOn: ['ABC-7'] }), s('ABC-7', { dependsOn: ['ABC-1'] })] }).find((i) => i.id === 'task:ABC-1');
    expect(direct.group).toBe('now');
  });

  it('a task in a cycle with an outside open blocker is later on that blocker alone', () => {
    const stories = [s('ABC-1', { ownerTask: true, dependsOn: ['ABC-2', 'ABC-3'] }), s('ABC-2', { ownerTask: true, dependsOn: ['ABC-1'] }), s('ABC-3')];
    const items = build({ stories });
    expect(items.find((i) => i.id === 'task:ABC-1')).toMatchObject({ group: 'later', waitsOn: ['ABC-3'], why: 'Can start after ABC-3.' });
    expect(items.find((i) => i.id === 'task:ABC-2')).toMatchObject({ group: 'later', waitsOn: ['ABC-1'], why: 'Can start after ABC-1.' });

    const doneLink = build({ stories: [s('ABC-1', { ownerTask: true, dependsOn: ['ABC-4'] }), s('ABC-4', { status: 'done', dependsOn: ['ABC-1'] })] })[0];
    expect(doneLink.group).toBe('now');
    expect(doneLink).not.toHaveProperty('waitsOn');
  });

  it('a task waiting on a loop that never reaches it stays later on that loop', () => {
    const loop = [s('ABC-1', { ownerTask: true, dependsOn: ['ABC-2'] }), s('ABC-2', { dependsOn: ['ABC-3'] }), s('ABC-3', { dependsOn: ['ABC-2'] })];
    expect(build({ stories: loop })[0]).toMatchObject({ group: 'later', waitsOn: ['ABC-2'], why: 'Can start after ABC-2.' });

    const selfLoop = [s('ABC-1', { ownerTask: true, dependsOn: ['ABC-2'] }), s('ABC-2', { dependsOn: ['ABC-2'] })];
    expect(build({ stories: selfLoop })[0]).toMatchObject({ group: 'later', waitsOn: ['ABC-2'] });

    // ABC-1 is in the cycle ABC-1 -> ABC-2 -> ABC-1, and ABC-2's other blocker only loops back to it.
    const loopAndTask = [s('ABC-1', { ownerTask: true, dependsOn: ['ABC-2'] }), s('ABC-2', { dependsOn: ['ABC-3', 'ABC-1'] }), s('ABC-3', { dependsOn: ['ABC-2'] })];
    expect(build({ stories: loopAndTask })[0].group).toBe('now');
  });

  it('an owner task whose blockers are done, or outside the filter and done, is now', () => {
    const done = build({ stories: [s('ABC-1', { ownerTask: true, dependsOn: ['ABC-3'] }), s('ABC-3', { status: 'done' })] })[0];
    expect(done.group).toBe('now');
    expect(done).not.toHaveProperty('waitsOn');
    expect(done.why).toBe('An open owner task.');

    const outside = build({ stories: [s('ABC-1', { ownerTask: true, dependsOn: ['ABC-9'] })] })[0];
    expect(outside.group).toBe('now');
    expect(outside).not.toHaveProperty('waitsOn');

    const retired = build({ stories: [s('ABC-1', { ownerTask: true, dependsOn: ['ABC-4'] }), s('ABC-4', { status: 'retired' })] })[0];
    expect(retired.group).toBe('now');
    expect(retired).not.toHaveProperty('waitsOn');
  });
});

describe('slots', () => {
  it('lists parked and down slots with their actions and labels, and leaves the rest out', () => {
    const slots = [
      { id: 'w1', state: 'idle', reason: '', parkedFor: null, since: null, story: null },
      { id: 'w2', state: 'parked', parkedFor: 'crash', reason: 'The session stopped twice.', since: '2026-10-15T08:00:00.000Z', story: { id: 'ABC-1' } },
      { id: 'w3', state: 'parked', parkedFor: 'dirty', reason: '', since: null, story: null },
      { id: 'w4', state: 'down', parkedFor: null, reason: '', since: null, story: null },
      { id: 'w5', state: 'building', parkedFor: null, reason: '', since: null, story: { id: 'ABC-2' } },
      { id: 'w6', state: 'held', parkedFor: null, reason: '', since: null, story: { id: 'ABC-3' } },
    ];
    const items = build({ slots, stories: [s('ABC-1'), s('ABC-2', { dependsOn: ['ABC-1'] })] });
    expect(items.map((i) => i.id).sort()).toEqual(['slot:w2', 'slot:w3', 'slot:w4']);
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    for (const slot of slots.filter((x) => ['w2', 'w3', 'w4'].includes(x.id))) {
      expect(byId[`slot:${slot.id}`].actions).toEqual(actionsFor(slot).map((a) => ({ id: a, label: SLOT_LABELS[a] })));
    }
    expect(byId['slot:w2']).toMatchObject({ kind: 'slot', title: 'Slot w2 is parked', why: 'The session stopped twice.', blocks: ['ABC-1', 'ABC-2'] });
    expect(byId['slot:w2'].actions.map((a) => a.label)).toEqual(['Resume', 'Restart fresh from main', 'Skip story', 'Take over']);
    expect(byId['slot:w3'].actions.map((a) => a.label)).toEqual(['Resume as is', 'Discard changes and reset']);
    expect(byId['slot:w3'].why).toBe('The slot is parked.');
    expect(byId['slot:w4']).toMatchObject({ title: 'Slot w4 is down', why: 'The slot is down.', blocks: [] });
    expect(byId['slot:w4'].actions.map((a) => a.label)).toEqual(['Resume', 'Park']);
  });
});

describe('releases ready to promote', () => {
  it('gives the reason, the last check outcome (never its detail), the pull request and Check now', () => {
    const parks = [{ id: 'ABC-4', title: 'Ship the invoice page', reason: 'waiting for the promotion to QA', pr: 'https://github.com/acme/app/pull/4', parkedAt: '2026-10-15T08:00:00.000Z', lastCheck: { at: '2026-10-15T08:30:00.000Z', outcome: 'waiting', detail: 'still deploying' } }];
    expect(build({ parks, stories: [s('ABC-4', { status: 'ready-to-promote' }), s('ABC-5', { dependsOn: ['ABC-4'] })] })).toEqual([
      {
        id: 'release:ABC-4',
        kind: 'release',
        title: 'ABC-4 Ship the invoice page is ready to promote',
        why: 'waiting for the promotion to QA Last check: waiting.',
        blocks: ['ABC-5'],
        frees: ['ABC-5'],
        link: 'https://github.com/acme/app/pull/4',
        actions: [{ id: 'check', label: 'Check now' }],
        group: 'now',
      },
    ]);
  });

  it('never carries the check detail, which can hold what a tool printed', () => {
    const parks = [{ id: 'ABC-4', title: '', reason: 'waiting for the promotion to QA', pr: null, parkedAt: null, lastCheck: { at: '2026-10-15T08:30:00.000Z', outcome: 'error', detail: 'acme-promote check failed: https://bot:s3cret@acme.example/deploy?token=abc' } }];
    const items = build({ parks });
    expect(items[0].why).toBe('waiting for the promotion to QA Last check: error.');
    expect(JSON.stringify(items)).not.toContain('s3cret');
  });

  it('leaves out the link and the last check when there are none', () => {
    const [item] = build({ parks: [{ id: 'ABC-4', title: '', reason: 'waiting for the promotion', pr: null, parkedAt: null }] });
    expect(item.title).toBe('ABC-4 is ready to promote');
    expect(item.why).toBe('waiting for the promotion');
    expect(item).not.toHaveProperty('link');
  });
});

describe('the order', () => {
  it('puts the halt first, then slots, then what frees most, then the most blocking, then the newest', () => {
    const stories = [
      s('ABC-1', { ownerTask: true }),
      s('ABC-2', { dependsOn: ['ABC-1'] }),
      s('ABC-3', { dependsOn: ['ABC-2'] }),
      s('ABC-7', { ownerTask: true }),
    ];
    const decisions = {
      source: 'files',
      items: [
        decision({ id: 'd-20261015080000-aaaa', story: 'ABC-8', createdAt: '2026-10-15T08:00:00.000Z', options: ['a'] }),
        decision({ id: 'd-20261015090000-bbbb', story: 'ABC-9', createdAt: '2026-10-15T09:00:00.000Z', options: ['a'] }),
      ],
    };
    const halt = { reason: 'smoke failed on /health', at: '2026-10-14T09:00:00.000Z', fixProblem: 'still failing', held: [] };
    const slots = [{ id: 'w2', state: 'down', reason: '', since: '2026-10-13T09:00:00.000Z', story: null }];
    const items = build({ stories, decisions, halt, slots });
    expect(items.map((i) => i.id)).toEqual(['halt', 'slot:w2', 'task:ABC-1', 'd-20261015090000-bbbb', 'd-20261015080000-aaaa', 'task:ABC-7']);
    expect(items[0]).toEqual({ id: 'halt', kind: 'halt', title: 'The run is halted', why: 'smoke failed on /health Last check: still failing', blocks: [], frees: [], actions: [{ id: 'fixed', label: 'I fixed it' }], group: 'now' });
  });

  it('puts an urgent decision right after the halt, ahead of the most blocking', () => {
    const stories = [s('ABC-1', { ownerTask: true }), s('ABC-2', { dependsOn: ['ABC-1'] }), s('ABC-3', { dependsOn: ['ABC-1'] })];
    const decisions = {
      source: 'files',
      items: [
        decision({ id: 'd-20261015090000-newr', story: null, createdAt: '2026-10-15T09:00:00.000Z', options: ['a'] }),
        decision({ id: 'd-20261015070000-urgt', story: null, createdAt: '2026-10-15T07:00:00.000Z', options: ['a'], urgent: true }),
      ],
    };
    const halt = { reason: 'smoke failed', at: '2026-10-14T09:00:00.000Z', fixProblem: null, held: [] };
    const items = build({ stories, decisions, halt });
    expect(items.find((i) => i.id === 'd-20261015070000-urgt').blocks).toEqual([]);
    expect(items.find((i) => i.id === 'task:ABC-1').blocks).toHaveLength(2);
    expect(items.map((i) => i.id)).toEqual(['halt', 'd-20261015070000-urgt', 'task:ABC-1', 'd-20261015090000-newr']);
  });

  it('an item that frees a story ranks above one that only blocks more', () => {
    const stories = [
      s('ABC-1', { ownerTask: true }),
      s('ABC-4', { dependsOn: ['ABC-1', 'ABC-5'] }),
      s('ABC-5'),
      s('ABC-6', { dependsOn: ['ABC-4'] }),
      s('ABC-7', { dependsOn: ['ABC-4'] }),
      s('ABC-2', { ownerTask: true }),
      s('ABC-3', { dependsOn: ['ABC-2'] }),
    ];
    const items = build({ stories });
    expect(items.map((i) => i.id)).toEqual(['task:ABC-2', 'task:ABC-1']);
    expect(items[0]).toMatchObject({ frees: ['ABC-3'], blocks: ['ABC-3'], why: 'Frees ABC-3 now. 1 story waits on it.' });
    expect(items[1]).toMatchObject({ frees: [], blocks: ['ABC-4', 'ABC-6', 'ABC-7'], why: 'Frees nothing by itself: ABC-4 also waits on ABC-5.' });
  });

  it("today's FM spikes rank by what they free", () => {
    const stories = fmStories();
    const items = build({ stories });
    expect(items.filter((i) => i.group === 'now').map((i) => i.id)).toEqual(['task:ACME-14', 'task:ACME-13', 'task:ACME-18', 'task:ACME-12', 'task:ACME-15', 'task:ACME-17']);
    expect(items.filter((i) => i.group === 'later')).toHaveLength(9);
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(byId['task:ACME-14'].frees).toEqual(['ACME-33']);
    expect(byId['task:ACME-14'].blocks).toHaveLength(9);
    expect(byId['task:ACME-14'].why).toBe('Frees ACME-33 now. 9 stories wait on it.');
    expect(byId['task:ACME-15'].frees).toEqual([]);
    expect(byId['task:ACME-15'].why).toBe('Frees nothing by itself: ACME-45 also waits on ACME-33.');
    expect(byId['task:ACME-17'].why).toBe('Frees nothing by itself: ACME-53 also waits on ACME-35 and ACME-38.');
  });

  it('later items come after now items', () => {
    const stories = [
      s('ABC-1', { ownerTask: true }),
      s('ABC-2', { ownerTask: true, dependsOn: ['ABC-5', 'ABC-6'] }),
      s('ABC-3', { ownerTask: true, dependsOn: ['ABC-5'] }),
      s('ABC-5'),
      s('ABC-6'),
    ];
    const decisions = { source: 'files', items: [decision({ id: 'd-20261015090000-aaaa', story: null, options: ['a'] })] };
    const halt = { reason: 'smoke failed', at: '2026-10-14T09:00:00.000Z', fixProblem: null, held: [] };
    const items = build({ stories, decisions, halt });
    expect(items.map((i) => i.id)).toEqual(['halt', 'd-20261015090000-aaaa', 'task:ABC-1', 'task:ABC-3', 'task:ABC-2']);
    for (const item of items) expect(item).toHaveProperty('group');
    expect(items.map((i) => i.group)).toEqual(['now', 'now', 'now', 'later', 'later']);
  });

  it('carries no at or urgent, and every id is plain', () => {
    const items = build({
      stories: [s('ABC-1', { ownerTask: true })],
      decisions: { source: 'files', items: [decision({ options: ['a'], urgent: true })] },
      halt: { reason: 'x', at: '2026-10-15T09:00:00.000Z', fixProblem: null, held: ['ABC-2'] },
      parks: [{ id: 'ABC-4', title: '', reason: 'r', parkedAt: '2026-10-15T09:00:00.000Z' }],
      slots: [{ id: 'w2', state: 'down', reason: '', since: '2026-10-15T09:00:00.000Z', story: null }],
    });
    expect(items).toHaveLength(5);
    for (const item of items) {
      expect(item).not.toHaveProperty('at');
      expect(item).not.toHaveProperty('urgent');
      expect(item.id).toMatch(/^[A-Za-z0-9._:-]+$/);
    }
    expect(items.find((i) => i.id === 'halt').blocks).toEqual(['ABC-2']);
  });
});

describe('FYI: why the run is idle', () => {
  const REASON = 'Jira not reachable since 17:07: fetch failed; picking paused, stories in progress carry on';
  const at = (h, m, day = 24) => new Date(2026, 9, day, h, m);
  const paused = (reason = REASON, since = at(17, 7)) => ({ state: 'paused', reason, since: since.toISOString() });
  const nothingLeft = { state: 'stopped', reason: 'Nothing left to build.', since: at(17, 0).toISOString() };
  const runItems = (items) => items.filter((i) => i.kind === 'run');
  const CALM = 'Picking paused since 17:07: Jira not reachable. Often the computer slept or the network dropped; it retries every minute. Stories in progress carry on.';
  const LATE = 'Still not reachable after 30 minutes: check the network or `foreman jira status`';

  it('nothing-left with open stories gives one FYI item', () => {
    const stories = [s('ABC-1', { ownerTask: true }), s('ABC-2', { dependsOn: ['ABC-1'] }), s('ABC-3', { dependsOn: ['ABC-1'] }), s('ABC-4', { status: 'done' })];
    const items = build({ stories, loop: nothingLeft, now: at(17, 30) });
    expect(runItems(items)).toEqual([
      { id: 'run:nothing-left', kind: 'run', title: 'The run stopped', why: 'Nothing left to build: 2 stories wait on your tasks.', blocks: [], frees: [], actions: [], group: 'fyi' },
    ]);
    expect(items.map((i) => i.id)).toEqual(['task:ABC-1', 'run:nothing-left']);

    const one = build({ stories: [s('ABC-1', { ownerTask: true }), s('ABC-2', { dependsOn: ['ABC-1'] })], loop: nothingLeft, now: at(17, 30) });
    expect(runItems(one)[0].why).toBe('Nothing left to build: 1 story waits on your tasks.');

    const finished = [s('ABC-1', { ownerTask: true }), s('ABC-2', { status: 'done' }), s('ABC-3', { status: 'retired' })];
    expect(runItems(build({ stories: finished, loop: nothingLeft, now: at(17, 30) }))).toEqual([]);
    expect(runItems(build({ stories, loop: { ...nothingLeft, reason: 'Stopped on request.' }, now: at(17, 30) }))).toEqual([]);
    expect(runItems(build({ stories, loop: { state: 'running', reason: '', since: at(17, 0).toISOString() }, now: at(17, 30) }))).toEqual([]);
    expect(runItems(build({ stories }))).toEqual([]);
  });

  it('a Jira pause under 30 minutes is FYI', () => {
    const item = runItems(build({ loop: paused(), now: at(17, 30) }));
    expect(item).toEqual([{ id: 'run:jira', kind: 'run', title: 'Picking paused', why: CALM, blocks: [], frees: [], actions: [], group: 'fyi' }]);

    const once = runItems(build({ loop: paused(`Nothing can start now: ${REASON}`), now: at(17, 30) }));
    expect(once).toMatchObject([{ id: 'run:jira', group: 'fyi', why: CALM, actions: [] }]);

    expect(runItems(build({ loop: paused('paused from the command centre'), now: at(17, 30) }))).toEqual([]);
  });

  it('over 30 minutes it is now', () => {
    const late = runItems(build({ loop: paused(), now: at(17, 37) }));
    expect(late).toEqual([{ id: 'run:jira', kind: 'run', title: 'Jira still not reachable', why: LATE, blocks: [], frees: [], actions: [], group: 'now' }]);

    // The reason's <why> changed, so setLoop reset since; the clock still starts at 17:07.
    const reset = runItems(build({ loop: paused(REASON, at(17, 30)), now: at(17, 40) }));
    expect(reset).toMatchObject([{ id: 'run:jira', group: 'now', why: LATE }]);

    const midnight = 'Jira not reachable since 23:50: fetch failed; picking paused, stories in progress carry on';
    const overnight = runItems(build({ loop: paused(midnight, at(0, 5, 25)), now: at(0, 25, 25) }));
    expect(overnight).toMatchObject([{ id: 'run:jira', group: 'now', why: LATE }]);
  });

  it('run FYI items carry no actions and never count', () => {
    const stories = [s('ABC-1', { ownerTask: true }), s('ABC-5', { ownerTask: true, dependsOn: ['ABC-6'] }), s('ABC-6')];
    const jira = build({ stories, loop: paused(), now: at(17, 30) });
    const stopped = build({ stories, loop: nothingLeft, now: at(17, 30) });
    for (const items of [jira, stopped]) {
      const fyi = items.filter((i) => i.group === 'fyi');
      expect(fyi).toHaveLength(1);
      for (const item of fyi.filter((i) => i.kind === 'run')) expect(item.actions).toEqual([]);
      expect(waitingCount(items)).toBe(1);
      expect(items.map((i) => i.group)).toEqual(['now', 'later', 'fyi']);
    }
    expect(waitingCount([...jira, ...stopped.filter((i) => i.group === 'fyi')])).toBe(1);

    const escalated = build({ loop: paused(), now: at(17, 40) });
    expect(escalated).toHaveLength(1);
    expect(waitingCount(escalated)).toBe(1);
  });

  it('a dependency Foreman added itself is FYI with Undo and Keep, after the rest, and never counts', () => {
    const stories = [s('ABC-1'), s('ABC-2', { dependsOn: ['ABC-1'] }), s('ABC-3', { ownerTask: true }), s('ABC-5', { ownerTask: true, dependsOn: ['ABC-6'] }), s('ABC-6')];
    const note = decision({
      id: 'd-20261015100000-aaaa', story: 'ABC-2', title: 'ABC-2 now waits for ABC-1', summary: 'ABC-2 now waits for ABC-1: ABC-1 must land first',
      body: 'ABC-1 must land first', options: ['Undo', 'Keep'], hints: ['Takes the dependency off again.', 'Keeps it.'], createdAt: '2026-10-15T10:00:00.000Z',
    });
    const later = decision({ id: 'd-20261015110000-bbbb', story: 'ABC-2', title: 'ABC-2 now waits for ABC-6', options: ['Undo', 'Keep'], createdAt: '2026-10-15T11:00:00.000Z' });
    const items = build({ stories, decisions: { source: 'files', items: [note, later] }, loop: nothingLeft, now: at(17, 30) });
    expect(items.map((i) => [i.id, i.group])).toEqual([
      ['task:ABC-3', 'now'],
      ['task:ABC-5', 'later'],
      ['run:nothing-left', 'fyi'],
      ['d-20261015100000-aaaa', 'fyi'],
      ['d-20261015110000-bbbb', 'fyi'],
    ]);
    expect(items.find((i) => i.id === note.id)).toEqual({
      id: note.id, kind: 'decision', title: 'ABC-2 now waits for ABC-1', why: 'ABC-2 now waits for ABC-1: ABC-1 must land first', details: 'ABC-1 must land first',
      blocks: [], frees: [],
      actions: [
        { id: 'option-0', label: 'Undo', hint: 'Takes the dependency off again.', recommended: false },
        { id: 'option-1', label: 'Keep', hint: 'Keeps it.', recommended: false },
      ],
      group: 'fyi',
    });
    expect(waitingCount(items)).toBe(1);
    expect(headline({ items, loop: nothingLeft }).best).toBe('task:ABC-3');
    const alone = build({ stories, decisions: { source: 'files', items: [note] } });
    expect(waitingCount(alone)).toBe(1);
    expect(headline({ items: alone.filter((i) => i.kind === 'decision') }).best).toBeNull();
  });

  it('a change Foreman learned itself is a learned FYI with Undo and Keep, and never counts', () => {
    const stories = [s('ABC-1'), s('ABC-2')];
    const note = decision({
      id: 'd-20261015100000-cccc', story: 'ABC-2', title: 'Foreman learned L-1 for developer', summary: 'developer: Acme: give every new route a test.',
      body: '[L-1] Acme: give every new route a test.', options: ['Undo the change', 'Keep the change'], hints: ['Takes it out.', 'Keeps it.'], createdAt: '2026-10-15T10:00:00.000Z',
    });
    const items = build({ stories, decisions: { source: 'files', items: [note] } });
    expect(items.find((i) => i.id === note.id)).toEqual({
      id: note.id, kind: 'learned', learned: { id: 'L-1', change: 'add', roles: ['developer'] },
      title: 'Foreman learned L-1 for developer', why: 'developer: Acme: give every new route a test.', details: '[L-1] Acme: give every new route a test.',
      blocks: [], frees: [],
      actions: [
        { id: 'undo', label: 'Undo the change', hint: 'Takes it out.' },
        { id: 'keep', label: 'Keep the change', hint: 'Keeps it.' },
      ],
      group: 'fyi',
    });
    expect(waitingCount(items)).toBe(0);
    expect(headline({ items }).best).toBeNull();
    expect(isFyiNote(note)).toBe(true);
    expect(isFyiNote({ ...note, options: [] })).toBe(false);
  });

  it('a changed note is a learned FYI with change update, and a hint over 100 characters is cut', () => {
    const long = 'x'.repeat(130);
    const note = decision({ id: 'd-20261015100000-eeee', story: 'ABC-2', title: 'Foreman changed L-12 for developer, tester', options: ['Undo the change', 'Keep the change'], hints: [long, 'Keeps it.'] });
    const [got] = build({ decisions: { source: 'files', items: [note] } });
    expect(got).toMatchObject({ kind: 'learned', learned: { id: 'L-12', change: 'update', roles: ['developer', 'tester'] }, group: 'fyi' });
    expect(got.actions).toEqual([{ id: 'undo', label: 'Undo the change', hint: 'x'.repeat(100) }, { id: 'keep', label: 'Keep the change', hint: 'Keeps it.' }]);
    const bare = build({ decisions: { source: 'files', items: [{ ...note, hints: undefined }] } })[0];
    expect(bare.actions.map((a) => a.hint)).toEqual([null, null]);
    expect(bare.actions.some((a) => 'recommended' in a)).toBe(false);
  });

  it('a change Foreman rolled back itself is a learned FYI with Got it only, and never counts', () => {
    const stories = [s('ABC-1'), s('ABC-2')];
    const note = decision({
      id: 'd-20261015100000-dddd', story: 'ABC-2', title: 'Foreman rolled back L-1 for developer', summary: 'Rolled back L-1: Stories got worse: rounds 1.0 → 1.6',
      body: 'Stories got worse: rounds 1.0 → 1.6', options: ['Got it'], hints: ['Clears this note.'], createdAt: '2026-10-15T10:00:00.000Z',
    });
    const items = build({ stories, decisions: { source: 'files', items: [note] } });
    const got = items.find((i) => i.id === note.id);
    expect(got).toMatchObject({ kind: 'learned', learned: { id: 'L-1', change: 'rollback', roles: ['developer'] }, group: 'fyi', blocks: [], frees: [] });
    expect(got.actions).toEqual([{ id: 'ok', label: 'Got it', hint: 'Clears this note.' }]);
    expect(waitingCount(items)).toBe(0);
    expect(headline({ items }).best).toBeNull();
    expect(isFyiNote(note)).toBe(true);
    const retired = build({ decisions: { source: 'files', items: [{ ...note, title: 'Foreman retired L-1 for developer' }] } })[0];
    expect(retired).toMatchObject({ kind: 'learned', learned: { change: 'retire' }, actions: [{ id: 'ok', label: 'Got it' }] });
  });

  it('a note about follow-ups Foreman created is FYI with Undo and close them and Keep them, and never counts', () => {
    const stories = [s('ABC-3', { status: 'done' }), s('ABC-4', { status: 'done' }), s('ABC-8'), s('ABC-9')];
    const note = decision({
      id: 'd-20261015100000-ffff', story: 'ABC-4', title: 'Foreman created 2 follow-up stories', summary: 'ABC-8 and ABC-9 to fix the minor findings of ABC-3 and ABC-4',
      body: '- ABC-8: Follow-ups from ABC-3 (2 minor finding(s))\n- ABC-9: Follow-ups from ABC-4 (1 minor finding(s))', options: ['Undo and close them', 'Keep them'],
      hints: ['Closes the new stories not started yet; nothing is built for them.', 'Keeps the stories and clears this note.'],
    });
    const items = build({ stories, decisions: { source: 'files', items: [note] } });
    expect(items).toEqual([
      {
        id: note.id, kind: 'decision', title: 'Foreman created 2 follow-up stories', why: 'ABC-8 and ABC-9 to fix the minor findings of ABC-3 and ABC-4', details: note.body,
        blocks: [], frees: [],
        actions: [
          { id: 'option-0', label: 'Undo and close them', hint: 'Closes the new stories not started yet; nothing is built for them.', recommended: false },
          { id: 'option-1', label: 'Keep them', hint: 'Keeps the stories and clears this note.', recommended: false },
        ],
        group: 'fyi',
      },
    ]);
    expect(items[0]).not.toHaveProperty('bundle');
    expect(waitingCount(items)).toBe(0);
    expect(headline({ items }).best).toBeNull();
    expect(isFyiNote(note)).toBe(true);
    expect(isFyiNote({ ...note, options: [] })).toBe(false);
  });

  it('a title that only looks like a dependency note for another story, and a depends_on proposal, stay now', () => {
    const stories = [s('ABC-1'), s('ABC-2')];
    const proposal = decision({ id: 'd-1', story: 'ABC-2', title: 'Add depends_on: ABC-1 to ABC-2?', options: ['Apply', 'Ignore'] });
    const other = decision({ id: 'd-2', story: 'ABC-1', title: 'ABC-2 now waits for ABC-1', options: ['Undo', 'Keep'] });
    const items = build({ stories, decisions: { source: 'files', items: [proposal, other] } });
    expect(items.map((i) => [i.id, i.group]).sort()).toEqual([['d-1', 'now'], ['d-2', 'now']]);
  });

  it('run items carry no at, and their ids are plain', () => {
    const stories = [s('ABC-1', { ownerTask: true }), s('ABC-2', { dependsOn: ['ABC-1'] })];
    const items = [...build({ stories, loop: nothingLeft, now: at(17, 30) }), ...build({ loop: paused(), now: at(17, 30) }), ...build({ loop: paused(), now: at(17, 40) })];
    expect(runItems(items)).toHaveLength(3);
    for (const item of runItems(items)) {
      expect(item).not.toHaveProperty('at');
      expect(item).not.toHaveProperty('urgent');
      expect(item).not.toHaveProperty('link');
      expect(item).not.toHaveProperty('details');
      expect(item).not.toHaveProperty('bundle');
      expect(item.id).toMatch(/^[A-Za-z0-9._:-]+$/);
    }
  });
});

describe('headline', () => {
  const REASON = 'Jira not reachable since 17:07: fetch failed; picking paused, stories in progress carry on';
  const at = (h, m) => new Date(2026, 9, 24, h, m);
  const paused = (reason = REASON) => ({ state: 'paused', reason, since: at(17, 7).toISOString() });
  const stopped = { state: 'stopped', reason: 'Nothing left to build.', since: at(17, 0).toISOString() };
  const running = { state: 'running', reason: '', since: at(17, 0).toISOString() };
  const slot = (id, state, story = null) => ({ id, state, story: story ? { id: story } : null });
  const idle = [slot('w1', 'idle'), slot('w2', 'idle')];

  it('halted: the halt is the best item, whatever is building', () => {
    const halt = { reason: 'smoke failed on /health', at: '2026-10-24T09:00:00.000Z', fixProblem: null, held: [] };
    const slots = [slot('w1', 'building', 'ABC-2')];
    const items = build({ halt, slots, stories: [s('ABC-1', { ownerTask: true })] });
    expect(headline({ items, loop: { state: 'halted', reason: '', since: null }, slots })).toEqual({
      state: 'halted',
      text: 'Halted: a release failed. Nothing ships until you fix it.',
      best: 'halt',
    });
    expect(headline({ items: [], loop: { state: 'halted' }, slots })).toMatchObject({ state: 'halted', best: null });
    expect(headline({ items, loop: running, slots }).state).toBe('halted');
  });

  it('paused for Jira: says since when, and that stories in progress carry on', () => {
    const items = build({ stories: [s('ABC-1', { ownerTask: true })], loop: paused(), now: at(17, 30) });
    expect(headline({ items, loop: paused(), slots: idle })).toEqual({
      state: 'paused',
      text: 'Paused: Jira not reachable since 17:07. New stories start when it answers; stories in progress carry on.',
      best: 'task:ABC-1',
    });
    expect(headline({ items: [], loop: paused(`Nothing can start now: ${REASON}`) }).text).toBe(
      'Paused: Jira not reachable since 17:07. New stories start when it answers; stories in progress carry on.',
    );
    expect(headline({ items: [], loop: paused('paused from the command centre') }).text).toBe('Paused from the Command centre. Nothing new starts until you resume.');
    expect(headline({ items: [], loop: paused('') }).text).toBe('Paused from the Command centre. Nothing new starts until you resume.');
    expect(headline({ items: [], loop: paused('Three stories missed in a row.') }).text).toBe('Paused: Three stories missed in a row. Nothing new starts until you resume.');
    expect(headline({ items: [], loop: paused('Three stories missed in a row') }).text).toBe('Paused: Three stories missed in a row. Nothing new starts until you resume.');
  });

  it('idle with owner tasks: names the best task, what it frees and how many wait on it', () => {
    const items = build({ stories: fmStories(), loop: stopped });
    expect(headline({ items, loop: stopped, slots: idle })).toEqual({
      state: 'idle',
      text: 'Idle: the 14 stories left all wait on your tasks. Do Spike: one story by hand on the direct path first: it frees ACME-33 now and 9 stories in all.',
      best: 'task:ACME-14',
    });
    expect(headline({ items, loop: running, slots: idle })).toMatchObject({ state: 'idle', best: 'task:ACME-14' });
    expect(headline({ items, loop: running, slots: [slot('w1', 'parked', 'ACME-31')] }).state).toBe('idle');
  });

  it('running with items: names what is building and says nothing is stopping it', () => {
    const items = build({ stories: fmStories() });
    const slots = [slot('w1', 'building', 'ACME-117'), slot('w2', 'building', 'ACME-116')];
    expect(headline({ items, loop: running, slots })).toEqual({
      state: 'running',
      text: 'Building ACME-117 and ACME-116. 6 things need you; none is stopping the run.',
      best: 'task:ACME-14',
    });
    const one = build({ stories: [s('ABC-1', { ownerTask: true })] });
    expect(headline({ items: one, loop: running, slots: [slot('w1', 'waiting', 'ABC-2'), slot('w2', 'idle')] })).toEqual({
      state: 'running',
      text: 'Building ABC-2. 1 thing needs you; it is not stopping the run.',
      best: 'task:ABC-1',
    });
  });

  it('running with nothing waiting', () => {
    expect(headline({ items: [], loop: running, slots: [slot('w1', 'building', 'ACME-117')] })).toEqual({
      state: 'running',
      text: 'Building ACME-117. Nothing needs you.',
      best: null,
    });
  });

  it('the best item: a down slot outranks an urgent decision; else the first now item, never later or fyi', () => {
    const slots = [slot('w1', 'building', 'ABC-7'), { id: 'w2', state: 'down', reason: '', since: null, story: null }];
    const decisions = { source: 'files', items: [decision({ story: null, options: ['a'], urgent: true })] };
    const items = build({ decisions, slots });
    expect(items.map((i) => i.id)).toEqual(['d-20261015090000-abcd', 'slot:w2']);
    expect(headline({ items, loop: running, slots }).best).toBe('slot:w2');
    // A down slot whose item is not in the list is passed over.
    expect(headline({ items: items.slice(0, 1), loop: running, slots }).best).toBe('d-20261015090000-abcd');

    const item = (id, group, over = {}) => ({ id, kind: 'owner-task', title: id, why: '', blocks: [], frees: [], actions: [], ...(group ? { group } : {}), ...over });
    expect(headline({ items: [item('a', 'later'), item('b', 'fyi'), item('c', 'now')], loop: stopped }).best).toBe('c');
    expect(headline({ items: [item('a', 'later'), item('b', 'fyi'), item('c')], loop: stopped }).best).toBe('c');
    expect(headline({ items: [item('a', 'later'), item('b', 'fyi')], loop: stopped }).best).toBeNull();
  });

  it('idle edge cases', () => {
    const later = build({ stories: [s('ABC-1', { ownerTask: true, dependsOn: ['ABC-5'] }), s('ABC-2', { ownerTask: true, dependsOn: ['ABC-5'] }), s('ABC-5')], loop: stopped });
    expect(headline({ items: later, loop: stopped, slots: idle })).toEqual({ state: 'idle', text: 'Idle: nothing you can do yet. 2 tasks open up as stories ship.', best: null });
    expect(headline({ items: later.slice(0, 1), loop: stopped }).text).toBe('Idle: nothing you can do yet. 1 task opens up as stories ship.');
    expect(headline({ items: [], loop: stopped, slots: idle })).toEqual({ state: 'idle', text: 'Idle: nothing left to build and nothing waits on you.', best: null });
    expect(headline()).toEqual({ state: 'idle', text: 'Idle: nothing left to build and nothing waits on you.', best: null });

    const mixed = build({
      stories: [s('ABC-1'), s('ABC-2', { dependsOn: ['ABC-1'] }), s('ABC-3', { ownerTask: true }), s('ABC-4', { dependsOn: ['ABC-3'] })],
      decisions: { source: 'files', items: [decision({ options: ['yes', 'no'] })] },
    });
    expect(headline({ items: mixed, loop: stopped })).toEqual({
      state: 'idle',
      text: 'Idle: the 3 stories left all wait on you. Do Which login? first: it frees ABC-1 now and 2 stories in all.',
      best: 'd-20261015090000-abcd',
    });

    const one = build({ stories: [s('ABC-1', { ownerTask: true }), s('ABC-2', { dependsOn: ['ABC-1'] })] });
    expect(headline({ items: one, loop: stopped }).text).toBe('Idle: the 1 story left waits on your tasks. Do Story ABC-1 first: it frees ABC-2 now and 1 story in all.');

    const none = build({ stories: [s('ABC-1', { ownerTask: true }), s('ABC-3', { ownerTask: true })] });
    expect(headline({ items: none, loop: stopped }).text).toBe('Idle: 2 things need you. Do Story ABC-1 first.');
    expect(headline({ items: none.slice(0, 1), loop: stopped }).text).toBe('Idle: 1 thing needs you. Do Story ABC-1 first.');

    const blocksOnly = [{ id: 'task:X', kind: 'owner-task', title: 'Add the key', why: '', blocks: ['A', 'B'], frees: [], actions: [], group: 'now' }];
    expect(headline({ items: blocksOnly, loop: stopped }).text).toBe('Idle: the 2 stories left all wait on your tasks. Do Add the key first: 2 stories wait on it.');
    expect(headline({ items: [{ ...blocksOnly[0], blocks: ['A'] }], loop: stopped }).text).toBe('Idle: the 1 story left waits on your tasks. Do Add the key first: 1 story waits on it.');
  });
});

describe('headline on standby', () => {
  const standby = { state: 'standby', reason: 'Nothing to build; picks up new stories automatically.', since: '2026-10-25T09:00:00.000Z' };
  const idle = [{ id: 'w1', state: 'idle', story: null }];
  const text = (items) => headline({ items, loop: standby, slots: idle }).text;

  it('two stories blocked by owner tasks', () => {
    const items = build({ stories: [s('ABC-1', { ownerTask: true }), s('ABC-2', { dependsOn: ['ABC-1'] }), s('ABC-3', { dependsOn: ['ABC-1'] })] });
    expect(headline({ items, loop: standby, slots: idle })).toEqual({
      state: 'standby',
      text: 'Standby: nothing to build. 2 stories wait on your tasks. Picks up new stories automatically.',
      best: 'task:ABC-1',
    });
  });

  it('one story blocked by a decision', () => {
    const items = build({ stories: [s('ABC-1', { status: 'blocked' })], decisions: { source: 'files', items: [decision({ options: ['yes', 'no'] })] } });
    expect(text(items)).toBe('Standby: nothing to build. 1 story waits on you. Picks up new stories automatically.');
  });

  it('a non-blocking item', () => {
    const items = build({ stories: [s('ABC-1', { ownerTask: true })] });
    expect(text(items)).toBe('Standby: nothing to build. 1 thing needs you. Picks up new stories automatically.');
  });

  it('a later task only', () => {
    const items = build({ stories: [s('ABC-1', { ownerTask: true, dependsOn: ['ABC-5'] }), s('ABC-5', { status: 'blocked' })] }).filter((i) => i.group === 'later');
    expect(items).toHaveLength(1);
    expect(text(items)).toBe('Standby: nothing to build. 1 task opens up as stories ship. Picks up new stories automatically.');
  });

  it('nothing waiting', () => {
    expect(headline({ items: [], loop: standby, slots: idle })).toEqual({ state: 'standby', text: 'Standby: nothing to build. Nothing waits on you. Picks up new stories automatically.', best: null });
  });

  it('a halt still wins', () => {
    const items = build({ halt: { reason: 'smoke failed', at: '2026-10-24T09:00:00.000Z', fixProblem: null, held: [] } });
    expect(headline({ items, loop: standby, slots: idle }).state).toBe('halted');
  });

  describe('while follow-up proposals wait on the owner', () => {
    const FOLLOW = ['Create a follow-up story', 'Ignore'];
    const ids = (n) => Array.from({ length: n }, (_, i) => `ABC-${100 + i}`);
    const follow = (id, i) => decision({ id: `d-20261015${String(90000 + i).padStart(6, '0')}-fu${String(i).padStart(2, '0')}`, story: id, title: `Follow up on ${id}: 2 minor finding(s)?`, options: FOLLOW, summary: '2 minor: a; b' });
    const shipped = (n) => ids(n).map((id) => s(id, { status: 'done' }));
    const follows = (n) => ids(n).map(follow);

    it('names them, not "nothing to build"', () => {
      const items = build({ stories: shipped(16), decisions: { source: 'files', items: follows(16) } });
      expect(headline({ items, loop: standby, slots: idle }).text).toBe('Standby: 16 follow-up proposals wait on you. Picks up new stories automatically.');
    });

    it('says one in the singular', () => {
      const items = build({ stories: shipped(1), decisions: { source: 'files', items: follows(1) } });
      expect(text(items)).toBe('Standby: 1 follow-up proposal waits on you. Picks up new stories automatically.');
    });

    it('adds the stories an owner task holds', () => {
      const stories = [...shipped(3), s('ABC-1', { ownerTask: true }), s('ABC-2', { dependsOn: ['ABC-1'] })];
      const items = build({ stories, decisions: { source: 'files', items: follows(3) } });
      expect(text(items)).toBe('Standby: 3 follow-up proposals wait on you. 1 story waits on your tasks. Picks up new stories automatically.');
    });

    it('adds the stories other things hold, in the plural', () => {
      const stories = [...shipped(2), s('ABC-1', { ownerTask: true }), s('ABC-2', { dependsOn: ['ABC-1'] }), s('ABC-3', { dependsOn: ['ABC-1'] })];
      const items = build({ stories, decisions: { source: 'files', items: follows(2) } });
      expect(text(items)).toBe('Standby: 2 follow-up proposals wait on you. 2 stories wait on your tasks. Picks up new stories automatically.');
    });

    it('adds one other thing that blocks nothing', () => {
      const items = build({ stories: [...shipped(2), s('ABC-1', { ownerTask: true })], decisions: { source: 'files', items: follows(2) } });
      expect(text(items)).toBe('Standby: 2 follow-up proposals wait on you. 1 other thing needs you. Picks up new stories automatically.');
    });

    it('adds several other things that block nothing', () => {
      const items = build({ stories: [...shipped(2), s('ABC-1', { ownerTask: true }), s('ABC-2', { ownerTask: true })], decisions: { source: 'files', items: follows(2) } });
      expect(text(items)).toBe('Standby: 2 follow-up proposals wait on you. 2 other things need you. Picks up new stories automatically.');
    });

    it('still names them when their stories are not in the list, as with Jira', () => {
      const items = build({ stories: [s('ABC-1')], decisions: { source: 'files', items: follows(16) } });
      expect(items.filter((i) => i.bundle === 'follow-ups').every((i) => i.blocks.length === 1)).toBe(true);
      expect(text(items)).toBe('Standby: 16 follow-up proposals wait on you. Picks up new stories automatically.');
    });

    it('names the stranded stories after it', () => {
      const items = build({ stories: shipped(1), decisions: { source: 'files', items: follows(1) } });
      expect(headline({ items, loop: standby, slots: idle, stranded: ['ABC-7'] }).text).toBe(
        'Standby: 1 follow-up proposal waits on you. Picks up new stories automatically. ABC-7 is In Progress with nothing running it.',
      );
    });

    it('leaves the note about follow-ups Foreman created out of it', () => {
      const note = decision({ id: 'd-1', story: 'ABC-4', title: 'Foreman created 2 follow-up stories', options: ['Undo and close them', 'Keep them'] });
      expect(text(build({ decisions: { source: 'files', items: [note] } }))).toBe('Standby: nothing to build. Nothing waits on you. Picks up new stories automatically.');
    });
  });

  it('the stopped and idle texts are unchanged', () => {
    const stopped = { state: 'stopped', reason: 'Nothing left to build.' };
    expect(headline({ items: [], loop: stopped, slots: idle }).text).toBe('Idle: nothing left to build and nothing waits on you.');
    expect(headline({ items: [], loop: { state: 'running', reason: '' }, slots: idle }).text).toBe('Idle: nothing left to build and nothing waits on you.');
  });
});

describe('a self-pause', () => {
  const REASON = 'Three stories in a row did not ship: ACME-1, ACME-2 and ACME-3.';
  const AT = '2026-10-25T09:00:00.000Z';

  it('a self-pause is a now item with Resume', () => {
    const items = build({ autoPause: { at: AT, reason: REASON } });
    expect(items).toEqual([
      { id: 'run:paused', kind: 'run', title: 'Foreman paused itself', why: REASON, blocks: [], frees: [], actions: [{ id: 'resume', label: 'Resume' }], group: 'now' },
    ]);
    expect(waitingCount(items)).toBe(1);
  });

  it('it comes after the halt and before decisions and slots', () => {
    const halt = { reason: 'smoke failed', at: '2026-10-14T09:00:00.000Z', fixProblem: null, held: [] };
    const decisions = { source: 'files', items: [decision({ id: 'd-20261025100000-aaaa', story: null, createdAt: '2026-10-25T10:00:00.000Z', options: ['a'] })] };
    const slots = [{ id: 'w2', state: 'parked', parkedFor: 'crash', reason: 'The session stopped twice.', since: '2026-10-25T08:00:00.000Z', story: null }];
    const autoPause = { at: AT, reason: REASON };
    const items = build({ halt, decisions, slots, autoPause });
    expect(items.map((i) => i.id)).toEqual(['halt', 'run:paused', 'slot:w2', 'd-20261025100000-aaaa']);
    expect(headline({ items, loop: { state: 'paused', reason: REASON } }).best).toBe('halt');
    const noHalt = build({ decisions, slots, autoPause });
    expect(noHalt.map((i) => i.id)).toEqual(['run:paused', 'slot:w2', 'd-20261025100000-aaaa']);
    expect(headline({ items: noHalt, loop: { state: 'paused', reason: REASON } }).best).toBe('run:paused');
  });

  it('an empty reason reads Foreman paused itself.', () => {
    const items = build({ autoPause: { at: AT, reason: '  ' } });
    expect(items[0]).toMatchObject({ id: 'run:paused', why: 'Foreman paused itself.' });
  });

  it('no autoPause, no item', () => {
    expect(build({ autoPause: null })).toEqual([]);
    expect(build()).toEqual([]);
  });

  describe('that tries again by itself', () => {
    const now = new Date(2026, 9, 25, 10, 0, 0);
    const retryAt = new Date(2026, 9, 25, 15, 30, 0).toISOString();
    const R = 'The account is out of credit or hit its usage limit. Resume once it is back.';

    it('says when in the why and carries the retry time', () => {
      const items = build({ autoPause: { at: AT, reason: R, retryAt }, now });
      expect(items[0]).toMatchObject({ id: 'run:paused', retryAt, why: `${R} Foreman tries again at ${hhmm(retryAt)} by itself.` });
      expect(items[0].why.endsWith(`Foreman tries again at ${hhmm(retryAt)} by itself.`)).toBe(true);
    });
    it('names the day when it is not today', () => {
      const tomorrow = new Date(2026, 9, 26, 0, 5, 0).toISOString();
      const items = build({ autoPause: { at: AT, reason: R, retryAt: tomorrow }, now });
      expect(items[0].why).toMatch(/Foreman tries again at 2026-10-26 00:05 by itself\.$/);
    });
    it('is unchanged without a retry time, or with one that does not read', () => {
      for (const retryAt of [null, undefined, '', 'later']) {
        const [item] = build({ autoPause: { at: AT, reason: R, retryAt }, now });
        expect(item.why).toBe(R);
        expect(item).not.toHaveProperty('retryAt');
      }
    });
    it('changes the paused headline', () => {
      const items = build({ autoPause: { at: AT, reason: R, retryAt }, now });
      const loop = { state: 'paused', reason: R };
      expect(headline({ items, loop, clock: now }).text).toBe(`Paused: ${R.replace(/\.+$/, '')}. Foreman tries again at ${hhmm(retryAt)} by itself; Resume starts it sooner.`);
      const plain = build({ autoPause: { at: AT, reason: R }, now });
      expect(headline({ items: plain, loop, clock: now }).text).toBe(`Paused: ${R.replace(/\.+$/, '')}. Nothing new starts until you resume.`);
    });
    it('leaves the Jira pause headline alone', () => {
      const items = build({ autoPause: { at: AT, reason: R, retryAt }, now });
      const loop = { state: 'paused', reason: 'Jira not reachable since 17:07: fetch failed' };
      expect(headline({ items, loop, clock: now }).text).toMatch(/^Paused: Jira not reachable since 17:07\./);
    });
  });
});

describe('the run is on the last good config', () => {
  const since = new Date(2026, 9, 24, 23, 49);
  const configProblem = { since: since.toISOString(), reason: 'bogusKey: unknown key' };
  const running = { state: 'running', reason: '', since: since.toISOString() };

  it('is one now item with no actions, counted once', () => {
    const items = build({ loop: running, configProblem, now: new Date(2026, 9, 25, 7, 0) });
    expect(items).toEqual([
      {
        id: 'run:config',
        kind: 'run',
        title: 'foreman.config.json is invalid',
        why: 'config invalid since 23:49: bogusKey: unknown key; running on the last good config',
        group: 'now',
        blocks: [],
        frees: [],
        actions: [],
      },
    ]);
    expect(waitingCount(items)).toBe(1);
  });

  it('is not there once the run stopped, or with no problem', () => {
    expect(build({ loop: { state: 'stopped', reason: 'Stopped on request.' }, configProblem }).filter((i) => i.id === 'run:config')).toEqual([]);
    expect(build({ loop: running, configProblem: null }).filter((i) => i.id === 'run:config')).toEqual([]);
    expect(build({ loop: running }).filter((i) => i.id === 'run:config')).toEqual([]);
  });
});

describe('a build-next request that cannot start', () => {
  const since = new Date(2026, 9, 30, 10, 0);
  const nextWait = { id: 'ACME-2', at: since.toISOString(), since: since.toISOString(), tries: 3, reason: 'could not fetch origin/main' };
  const running = { state: 'running', reason: '', since: since.toISOString() };

  it('is one now item with no actions, counted once', () => {
    const items = build({ loop: running, nextWait });
    expect(items).toEqual([
      { id: 'run:next', kind: 'run', title: 'ACME-2 cannot start next', why: nextWaitWhy(nextWait), group: 'now', blocks: [], frees: [], actions: [] },
    ]);
    expect(waitingCount(items)).toBe(1);
  });

  it('is not there once the run stopped, or with no wait', () => {
    expect(build({ loop: { state: 'stopped', reason: 'Stopped on request.' }, nextWait })).toEqual([]);
    expect(build({ loop: running, nextWait: null })).toEqual([]);
    expect(build({ loop: running, nextWait: { tries: 3, reason: 'x' } })).toEqual([]);
    expect(build({ loop: running })).toEqual([]);
  });
});

describe('the main checkout not taking new code', () => {
  const running = { state: 'running' };
  const anchorWait = { why: 'dirty', files: ['.claude/settings.json'], from: '1111111aaaa', to: '2222222bbbb', remote: 'origin', baseBranch: 'main', since: '2026-11-09T10:00:00.000Z' };

  it('is one now item with no actions, counted once and the headline best', () => {
    const items = build({ anchorWait, loop: running });
    expect(items).toEqual([
      { id: 'run:anchor', kind: 'run', title: 'The run is not taking new code', why: anchorWaitWhy(anchorWait), group: 'now', blocks: [], frees: [], actions: [] },
    ]);
    expect(waitingCount(items)).toBe(1);
    expect(headline({ items, loop: running }).best).toBe('run:anchor');
  });

  it.each([
    ['the loop is stopped', { loop: { state: 'stopped' }, anchorWait }],
    ['there is no wait', { loop: running, anchorWait: null }],
    ['the why is empty', { loop: running, anchorWait: { ...anchorWait, why: '' } }],
    ['the base sha is missing', { loop: running, anchorWait: { ...anchorWait, to: undefined } }],
  ])('is not shown when %s', (_name, input) => {
    expect(build(input).map((i) => i.id)).not.toContain('run:anchor');
  });
});

describe('the run is not making progress', () => {
  const now = new Date(2026, 9, 25, 9, 12, 30);
  const REASON = 'the supervisor fails every loop: ENOENT: no such file or directory';
  const stuck = { kind: 'error', since: new Date(2026, 9, 25, 9, 0).toISOString(), reason: REASON };
  const running = { state: 'running', reason: '', since: new Date(2026, 9, 25, 8, 0).toISOString() };
  const slot = (id, state, story = null) => ({ id, state, story: story ? { id: story } : null });

  it('is one now item with no actions, titled with how long', () => {
    const items = build({ loop: running, stuck, now });
    expect(items).toEqual([
      { id: 'run:stuck', kind: 'run', title: 'Not building for 12 minutes', why: REASON, group: 'now', blocks: [], frees: [], actions: [] },
    ]);
    expect(waitingCount(items)).toBe(1);
  });

  it('cuts a long reason to 300 characters', () => {
    const items = build({ loop: running, stuck: { ...stuck, reason: 'x'.repeat(400) }, now });
    expect(items[0].why).toHaveLength(300);
  });

  it('is not there once the run stopped, or with nothing stuck', () => {
    expect(build({ loop: { state: 'stopped', reason: 'Stopped on request.' }, stuck, now })).toEqual([]);
    expect(build({ loop: running, stuck: null, now })).toEqual([]);
    expect(build({ loop: running, now })).toEqual([]);
  });

  it('comes after the halt and the self-pause, before slots and decisions', () => {
    const halt = { reason: 'smoke failed', at: '2026-10-14T09:00:00.000Z', fixProblem: null, held: [] };
    const decisions = { source: 'files', items: [decision({ id: 'd-20261025100000-aaaa', story: null, createdAt: '2026-10-25T10:00:00.000Z', options: ['a'], urgent: true })] };
    const slots = [{ id: 'w2', state: 'down', reason: 'The stack would not start.', since: '2026-10-25T08:00:00.000Z', story: null }];
    const autoPause = { at: '2026-10-25T09:00:00.000Z', reason: 'Three stories in a row did not ship.' };
    expect(build({ halt, decisions, slots, autoPause, loop: running, stuck, now }).map((i) => i.id)).toEqual(['halt', 'run:paused', 'run:stuck', 'd-20261025100000-aaaa', 'slot:w2']);
    const items = build({ decisions, slots, loop: running, stuck, now });
    expect(items.map((i) => i.id)).toEqual(['run:stuck', 'd-20261025100000-aaaa', 'slot:w2']);
    expect(headline({ items, loop: running, slots }).best).toBe('run:stuck');
  });

  it('the headline says running, but stuck, and never Building', () => {
    const items = build({ loop: running, stuck, now });
    const building = [slot('w1', 'building', 'ACME-7')];
    expect(headline({ items, loop: running, slots: building })).toEqual({ state: 'running', text: `Running, but stuck: ${REASON}.`, best: 'run:stuck' });
    expect(headline({ items, loop: running, slots: [slot('w1', 'idle')] })).toEqual({ state: 'running', text: `Running, but stuck: ${REASON}.`, best: 'run:stuck' });
    const dotted = build({ loop: running, stuck: { ...stuck, reason: 'it broke...' }, now });
    expect(headline({ items: dotted, loop: running, slots: building }).text).toBe('Running, but stuck: it broke.');
    expect(headline({ items: [], loop: running, slots: building }).text).toBe('Building ACME-7. Nothing needs you.');
  });
});

describe('the run moved to the subscription', () => {
  const since = new Date(2026, 9, 25, 14, 32).toISOString();
  const switched = { using: 'subscription', since, reason: 'API credits used up' };

  it('is one fyi item with no actions, whatever the loop does', () => {
    for (const loop of [null, { state: 'running', reason: '' }, { state: 'stopped', reason: 'Stopped on request.' }, { state: 'paused', reason: 'paused from the command centre' }]) {
      const items = build({ loop, claudeSignIn: switched });
      expect(items, JSON.stringify(loop)).toHaveLength(1);
      const [item] = items;
      expect(item).toEqual({ id: 'run:subscription', kind: 'run', title: 'Using your subscription', why: item.why, group: 'fyi', blocks: [], frees: [], actions: [] });
      expect(item.why.startsWith(creditsOutFyi(switched))).toBe(true);
      expect(item.why).toContain('`foreman claude use-key`');
      expect(waitingCount(items)).toBe(0);
    }
  });

  it('names the usage limit and how to go back when access returns', () => {
    const usage = { using: 'subscription', since, reason: 'API key usage limit reached', limit: 'usage', resetAt: '2026-11-01 at 00:00 UTC' };
    const items = build({ claudeSignIn: usage });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toEqual({ id: 'run:subscription', kind: 'run', title: 'Using your subscription', why: item.why, group: 'fyi', blocks: [], frees: [], actions: [] });
    expect(item.why.startsWith(creditsOutFyi(usage))).toBe(true);
    expect(item.why).toContain('2026-11-01 at 00:00 UTC');
    expect(item.why).toContain('When access returns');
    expect(item.why).toContain('`foreman claude use-key`');
    expect(item.why).not.toContain('topping up');
  });

  it('keeps the top-up words for an empty balance', () => {
    expect(build({ claudeSignIn: switched })[0].why).toBe(`${creditsOutFyi(switched)} After topping up, run \`foreman claude use-key\` to go back to the key.`);
  });

  it('is not there on the key', () => {
    expect(build({ claudeSignIn: { using: 'key', since: null, reason: '' } })).toEqual([]);
    expect(build({ claudeSignIn: { using: 'key', since, reason: 'switched back by you' } })).toEqual([]);
    expect(build({})).toEqual([]);
  });

  it('comes after the now items', () => {
    const autoPause = { at: since, reason: 'Three stories in a row did not ship.' };
    expect(build({ autoPause, claudeSignIn: switched }).map((i) => i.id)).toEqual(['run:paused', 'run:subscription']);
  });
});

describe('a slow story', () => {
  const since = new Date(2026, 9, 25, 9, 0).toISOString();
  const now = new Date(Date.parse(since) + 105 * 60_000);
  const slow = [{ slot: 'w3', id: 'ACME-1', since, stage: 'build', rounds: 1, steps: 129 }];
  const running = { state: 'running', reason: '', since: new Date(2026, 9, 25, 8, 0).toISOString() };
  const stuck = { kind: 'story', since, reason: 'ACME-2 in w1 has shown no activity since 09:00 (no stage change, log output or CPU)' };

  it('is one FYI item with no actions, never counted, never best, never stuck', () => {
    const items = build({ loop: running, slow, now });
    expect(items).toEqual([
      { id: 'run:slow:w3', kind: 'run', title: 'ACME-1 is slow', why: 'slow: ACME-1 in its fix round for 1 h 45 min (129 steps)', group: 'fyi', blocks: [], frees: [], actions: [] },
    ]);
    expect(waitingCount(items)).toBe(0);
    const h = headline({ items, loop: running, slots: [{ id: 'w3', state: 'building', story: { id: 'ACME-1' } }] });
    expect(h.text).not.toMatch(/stuck/i);
    expect(h.best).toBeNull();
    expect(headline({ items, loop: running, slots: [] }).text).not.toMatch(/stuck/i);
  });

  it('is not there once the run stopped, or for an entry without an id or slot', () => {
    expect(build({ loop: { state: 'stopped', reason: 'Stopped on request.' }, slow, now })).toEqual([]);
    expect(build({ loop: running, slow: [{ ...slow[0], id: '' }, { ...slow[0], slot: null }], now })).toEqual([]);
  });

  it('sits beside a stuck item: one now, one FYI', () => {
    const items = build({ loop: running, stuck, slow, now });
    expect(items.map((i) => [i.id, i.group])).toEqual([['run:stuck', 'now'], ['run:slow:w3', 'fyi']]);
    expect(waitingCount(items)).toBe(1);
  });
});

describe('a restart pending on new code', () => {
  const since = new Date(2026, 9, 25, 9, 0).toISOString();
  const running = { state: 'running', reason: '', since: new Date(2026, 9, 25, 8, 0).toISOString() };
  const restartPending = { from: 'a1b2c3d', to: 'e4f5a6b', since };
  const slots = [
    { id: 'w1', state: 'building', story: { id: 'ACME-1' } },
    { id: 'w2', state: 'building', story: { id: 'ACME-2' } },
    { id: 'w3', state: 'waiting', story: { id: 'ACME-3' } },
    { id: 'w4', state: 'idle', story: null },
  ];

  it('is one FYI item saying the stories in progress keep running, never counted, never best', () => {
    const items = build({ loop: running, restartPending, slots });
    expect(items).toEqual([
      { id: 'run:restart', kind: 'run', title: 'Restarting on new code', why: 'New code (a1b2c3d → e4f5a6b): restarting as soon as the slots being set up are ready; the stories in progress keep running.', group: 'fyi', blocks: [], frees: [], actions: [] },
    ]);
    expect(waitingCount(items)).toBe(0);
    expect(headline({ items, loop: running, slots }).best).not.toBe('run:restart');
    expect(headline({ items, loop: running, slots: [] }).best).not.toBe('run:restart');
  });

  it('is not there with no restart pending, or once the run stopped', () => {
    expect(build({ loop: running, restartPending: null, slots })).toEqual([]);
    expect(build({ loop: { state: 'stopped', reason: 'Stopped on request.' }, restartPending, slots })).toEqual([]);
  });
});

describe('stray processes', () => {
  const running = { state: 'running', reason: '', since: new Date(2026, 9, 25, 8, 0).toISOString() };
  const WHY = "Not this run's: supervisors, hook runs or `foreman learn` and `notify` runs left by tests or manual checks, in temp folders or this project's folders (a run kept in a temp folder counts too). They hold memory and slow the run.";

  it('is one FYI item with an End them action, never counted, never best', () => {
    const items = build({ loop: running, strays: { count: 3 } });
    expect(items).toEqual([
      { id: 'run:strays', kind: 'run', title: '3 stray processes running', why: WHY, group: 'fyi', blocks: [], frees: [], actions: [{ id: 'end', label: 'End them' }] },
    ]);
    expect(waitingCount(items)).toBe(0);
    expect(headline({ items, loop: running, slots: [] }).best).not.toBe('run:strays');
  });

  it('says one in the singular', () => {
    expect(build({ loop: running, strays: { count: 1 } })[0].title).toBe('1 stray process running');
  });

  it('is not there once the run stopped, or with none', () => {
    expect(build({ loop: { state: 'stopped', reason: 'Stopped on request.' }, strays: { count: 2 } })).toEqual([]);
    expect(build({ loop: running, strays: { count: 0 } })).toEqual([]);
    expect(build({ loop: running, strays: null })).toEqual([]);
  });
});

describe('a story In Progress with nothing running it', () => {
  const going = (id, over = {}) => s(id, { status: 'in-progress', ...over });
  const slot = (id, state, over = {}) => ({ id, state, story: null, heldStory: null, parkedStory: null, ...over });

  it('strandedStories lists an in-progress story that no claim, slot or skip holds', () => {
    expect(strandedStories({ stories: [going('ACME-1')] })).toEqual(['ACME-1']);
    expect(strandedStories()).toEqual([]);
  });

  it('leaves out a story that is claimed, a slot holds, is skipped, or is an owner task', () => {
    const stories = [going('ACME-1'), going('ACME-2'), going('ACME-3'), going('ACME-4'), going('ACME-5'), going('ACME-6', { ownerTask: true }), going('ACME-7')];
    const slots = [slot('w1', 'building', { story: { id: 'ACME-2' } }), slot('w2', 'held', { heldStory: 'ACME-3' }), slot('w3', 'parked', { parkedStory: 'ACME-4' })];
    expect(strandedStories({ stories, claimed: ['ACME-1'], slots, skipped: ['ACME-5'] })).toEqual(['ACME-7']);
  });

  it('never lists a todo, blocked or done story', () => {
    expect(strandedStories({ stories: [s('ACME-1'), s('ACME-2', { status: 'blocked', blockedBy: 'Owner decision needed: x' }), s('ACME-3', { status: 'done' })] })).toEqual([]);
  });

  it('sorts the ids by number', () => {
    expect(strandedStories({ stories: [going('ACME-10'), going('ACME-9'), going('ACME-255')] })).toEqual(['ACME-9', 'ACME-10', 'ACME-255']);
  });

  const stopped = { state: 'stopped', reason: 'Nothing left to build.' };
  const running = { state: 'running', reason: '' };
  const standby = { state: 'standby', reason: 'Nothing to build; picks up new stories automatically.' };
  const idle = [{ id: 'w1', state: 'idle', story: null }];
  const ONE = 'ACME-255 is In Progress with nothing running it.';

  it('the headline names one after the idle, standby and running texts', () => {
    expect(headline({ items: [], loop: stopped, slots: idle, stranded: ['ACME-255'] })).toEqual({
      state: 'idle',
      text: `Idle: nothing left to build and nothing waits on you. ${ONE}`,
      best: null,
    });
    expect(headline({ items: [], loop: standby, slots: idle, stranded: ['ACME-255'] })).toEqual({
      state: 'standby',
      text: `Standby: nothing to build. Nothing waits on you. Picks up new stories automatically. ${ONE}`,
      best: null,
    });
    expect(headline({ items: [], loop: running, slots: [{ id: 'w1', state: 'building', story: { id: 'ACME-117' } }], stranded: ['ACME-255'] })).toEqual({
      state: 'running',
      text: `Building ACME-117. Nothing needs you. ${ONE}`,
      best: null,
    });
    const tasks = build({ stories: [s('ABC-1', { ownerTask: true }), s('ABC-2', { dependsOn: ['ABC-1'] })] });
    const plain = headline({ items: tasks, loop: stopped });
    expect(headline({ items: tasks, loop: stopped, stranded: ['ACME-255'] })).toEqual({ ...plain, text: `${plain.text} ${ONE}` });
  });

  it('names several in one sentence', () => {
    expect(headline({ items: [], loop: stopped, stranded: ['ACME-2', 'ACME-5'] }).text).toBe('Idle: nothing left to build and nothing waits on you. ACME-2 and ACME-5 are In Progress with nothing running them.');
  });

  it('leaves the halted, paused and stuck texts as they are', () => {
    const halt = { reason: 'smoke failed', at: '2026-10-24T09:00:00.000Z', fixProblem: null, held: [] };
    const halted = build({ halt });
    expect(headline({ items: halted, loop: stopped, stranded: ['ACME-2'] })).toEqual(headline({ items: halted, loop: stopped }));
    const paused = { state: 'paused', reason: 'Three stories missed in a row.' };
    expect(headline({ items: [], loop: paused, stranded: ['ACME-2'] })).toEqual(headline({ items: [], loop: paused }));
    const stuck = build({ loop: running, stuck: { kind: 'error', since: new Date(2026, 9, 25, 9, 0).toISOString(), reason: 'R' }, now: new Date(2026, 9, 25, 9, 12) });
    expect(headline({ items: stuck, loop: running, stranded: ['ACME-2'] })).toEqual(headline({ items: stuck, loop: running }));
  });

  it('an empty or missing list changes nothing', () => {
    for (const loop of [stopped, running, standby]) {
      expect(headline({ items: [], loop, slots: idle, stranded: [] })).toEqual(headline({ items: [], loop, slots: idle }));
    }
  });
});


describe('the Claude API wait', () => {
  const now = new Date(2026, 9, 25, 10, 0, 0);
  const until = new Date(2026, 9, 25, 12, 0, 0).toISOString();
  const apiWait = { since: new Date(2026, 9, 25, 9, 0, 0).toISOString(), until, step: 2 };
  const running = { state: 'running', reason: '', since: apiWait.since };

  it('is an fyi item with no actions while the wait lasts', () => {
    const items = build({ apiWait, loop: running, now });
    expect(items).toEqual([
      { id: 'run:api-wait', kind: 'run', title: 'Stuck waiting for the Claude API', why: `The Claude API is limited or down (wait 2); Foreman tries again at ${hhmm(until)} by itself.`, group: 'fyi', blocks: [], frees: [], actions: [] },
    ]);
  });
  it.each([
    ['the wait is over', { apiWait: { ...apiWait, until: new Date(2026, 9, 25, 9, 59, 0).toISOString() }, loop: running }],
    ['the loop is stopped', { apiWait, loop: { state: 'stopped', reason: '' } }],
    ['there is no apiWait', { apiWait: null, loop: running }],
    ['the until does not read', { apiWait: { ...apiWait, until: 'soon' }, loop: running }],
  ])('is not shown when %s', (_, over) => {
    expect(build({ ...over, now }).map((i) => i.id)).not.toContain('run:api-wait');
  });
  it('is never counted, and never the best item', () => {
    const items = build({ apiWait, loop: running, now });
    expect(waitingCount(items)).toBe(0);
    expect(headline({ items, loop: running, slots: [] }).best).toBeNull();
    const withPause = build({ apiWait, loop: running, autoPause: { at: apiWait.since, reason: 'R.' }, now });
    expect(headline({ items: withPause, loop: running }).best).toBe('run:paused');
    expect(waitingCount(withPause)).toBe(1);
  });
});

describe('the environment wait', () => {
  const now = new Date(2026, 9, 25, 10, 0, 0);
  const until = new Date(2026, 9, 25, 12, 0, 0).toISOString();
  const envWait = { since: new Date(2026, 9, 25, 9, 0, 0).toISOString(), until, step: 1 };
  const running = { state: 'running', reason: '', since: envWait.since };

  it('is an fyi item with no actions while the wait lasts', () => {
    const items = build({ envWait, loop: running, now });
    expect(items).toEqual([
      { id: 'run:env-wait', kind: 'run', title: 'Waiting out environment failures', why: `Three endings in a row were the environment, not the stories (wait 1); Foreman tries again at ${hhmm(until)} by itself.`, group: 'fyi', blocks: [], frees: [], actions: [] },
    ]);
  });
  it.each([
    ['the wait is over', { envWait: { ...envWait, until: new Date(2026, 9, 25, 9, 59, 0).toISOString() }, loop: running }],
    ['the loop is stopped', { envWait, loop: { state: 'stopped', reason: '' } }],
    ['there is no envWait', { envWait: null, loop: running }],
    ['the until does not read', { envWait: { ...envWait, until: 'soon' }, loop: running }],
  ])('is not shown when %s', (_, over) => {
    expect(build({ ...over, now }).map((i) => i.id)).not.toContain('run:env-wait');
  });
  it('is never counted, and never the best item', () => {
    const items = build({ envWait, loop: running, now });
    expect(waitingCount(items)).toBe(0);
    expect(headline({ items, loop: running, slots: [] }).best).toBeNull();
  });
  it('shows next to the Claude API wait when both last', () => {
    const apiWait = { since: envWait.since, until, step: 2 };
    const ids = build({ apiWait, envWait, loop: running, now }).map((i) => i.id);
    expect(ids).toContain('run:api-wait');
    expect(ids).toContain('run:env-wait');
  });
});

describe('an answer that could not be applied', () => {
  const now = new Date(2026, 9, 25, 10, 0, 0);
  const retryAt = new Date(2026, 9, 25, 10, 5, 0).toISOString();
  const failure = { id: 'd-20261025090000-abcd', story: 'ACME-1', title: 'ACME-1: which store?', step: 'putting ACME-1 back to todo', tries: 2, at: new Date(2026, 9, 25, 9, 30, 0).toISOString(), retryAt };
  const running = { state: 'running', reason: '', since: failure.at };

  it('is a now item with a Retry, telling the step and when Foreman tries again', () => {
    expect(build({ answerFailures: [failure], loop: running, now })).toEqual([
      {
        id: 'run:answer:d-20261025090000-abcd',
        kind: 'run',
        title: 'Could not apply your answer to "ACME-1: which store?"',
        why: `could not apply: putting ACME-1 back to todo. Foreman tries again at ${hhmm(retryAt)} by itself.`,
        group: 'now',
        blocks: [],
        frees: [],
        actions: [{ id: 'retry', label: 'Retry' }],
      },
    ]);
  });

  it('says it tries at its next check once the time has come', () => {
    const [item] = build({ answerFailures: [{ ...failure, retryAt: new Date(2026, 9, 25, 9, 59, 0).toISOString() }], loop: running, now });
    expect(item.why).toBe('could not apply: putting ACME-1 back to todo. Foreman tries again at its next check.');
  });

  it('cuts a long title', () => {
    const [item] = build({ answerFailures: [{ ...failure, title: 'x'.repeat(300) }], loop: running, now });
    expect(item.title.length).toBeLessThan(170);
  });

  it('is counted, and shown while the run is paused or on standby', () => {
    const items = build({ answerFailures: [failure], loop: running, now });
    expect(waitingCount(items)).toBe(1);
    expect(build({ answerFailures: [failure], loop: { state: 'standby', reason: '' }, now })).toHaveLength(1);
  });

  it.each([
    ['the loop is stopped', { answerFailures: [failure], loop: { state: 'stopped', reason: '' } }],
    ['there are no failures', { answerFailures: [], loop: running }],
    ['the input is not a list', { answerFailures: 'x', loop: running }],
    ['an entry has no step', { answerFailures: [{ ...failure, step: '' }], loop: running }],
    ['an entry has no title', { answerFailures: [{ ...failure, title: undefined }], loop: running }],
    ['an entry has no id', { answerFailures: [{ ...failure, id: undefined }], loop: running }],
  ])('is not shown when %s', (_, over) => {
    expect(build({ ...over, now }).map((i) => i.id).filter((id) => id.startsWith('run:answer:'))).toEqual([]);
  });
});

describe('the failing learning tick', () => {
  const since = new Date(2026, 9, 31, 14, 56, 12).toISOString();
  const running = { state: 'running', reason: '', since };
  const why = 'The learning tick failed (exit 1); its log /acme/learning-tick-1.log ends: "x".';
  const learningFailed = { count: 2, since, why, log: '/acme/learning-tick-1.log' };

  it('is an fyi item with no actions after two failures in a row', () => {
    expect(build({ learningFailed, loop: running })).toEqual([
      { id: 'run:learning', kind: 'run', title: 'The learning tick failed 2 times in a row', why, group: 'fyi', blocks: [], frees: [], actions: [] },
    ]);
    expect(build({ learningFailed: { ...learningFailed, count: 5 }, loop: running })[0].title).toBe('The learning tick failed 5 times in a row');
  });
  it.each([
    ['there was one failure', { learningFailed: { ...learningFailed, count: 1 }, loop: running }],
    ['the loop is stopped', { learningFailed, loop: { state: 'stopped', reason: '' } }],
    ['there is no learningFailed', { learningFailed: null, loop: running }],
    ['the why is empty', { learningFailed: { ...learningFailed, why: '' }, loop: running }],
    ['the count is not a whole number', { learningFailed: { ...learningFailed, count: 2.5 }, loop: running }],
  ])('is not shown when %s', (_, over) => {
    expect(build(over).map((i) => i.id)).not.toContain('run:learning');
  });
  it('cuts a long why to 300 characters', () => {
    const [item] = build({ learningFailed: { ...learningFailed, why: 'a'.repeat(400) }, loop: running });
    expect(item.why).toHaveLength(300);
  });
  it('is never counted, and never the best item', () => {
    const items = build({ learningFailed, loop: running });
    expect(waitingCount(items)).toBe(0);
    expect(headline({ items, loop: running, slots: [] }).best).toBeNull();
  });
});

describe('the story waiting on files', () => {
  const running = { state: 'running', reason: '', since: new Date(2026, 9, 25, 9, 0, 0).toISOString() };
  const fileWait = { id: 'ACME-2', on: [{ story: 'ACME-1', files: ['src/a.mjs'], resources: [], deferrals: 1 }], text: 'ACME-2 waits for ACME-1: src/a.mjs' };

  it('is an fyi item with no actions that names the top waiting story and its holder', () => {
    const items = build({ fileWait, loop: running });
    expect(items).toEqual([
      { id: 'run:files', kind: 'run', title: 'ACME-2 waits for ACME-1', why: 'The highest-priority story waiting on files: ACME-2 waits for ACME-1: src/a.mjs', group: 'fyi', blocks: [], frees: [], actions: [] },
    ]);
  });
  it('names each holder once', () => {
    const on = [
      { story: 'ACME-1', files: ['src/a.mjs'], resources: [], deferrals: 0 },
      { story: 'ACME-4', files: ['src/b.mjs'], resources: [], deferrals: 0 },
      { story: 'ACME-1', files: [], resources: ['db'], deferrals: 0 },
    ];
    expect(build({ fileWait: { ...fileWait, on }, loop: running })[0].title).toBe('ACME-2 waits for ACME-1 and ACME-4');
  });
  it.each([
    ['the loop is stopped', { fileWait, loop: { state: 'stopped', reason: '' } }],
    ['there is no fileWait', { fileWait: null, loop: running }],
    ['the fileWait has no id', { fileWait: { ...fileWait, id: '' }, loop: running }],
  ])('is not shown when %s', (_, over) => {
    expect(build(over).map((i) => i.id)).not.toContain('run:files');
  });
  it('is never counted, and never the best item', () => {
    const items = build({ fileWait, loop: running });
    expect(waitingCount(items)).toBe(0);
    expect(headline({ items, loop: running, slots: [] }).best).toBeNull();
  });
});

describe('standbyNews', () => {
  const FOLLOW = ['Create a follow-up story', 'Ignore'];
  const follow = (n) => decision({ id: `d-2026101509000${n}-fu0${n}`, story: `ABC-${n + 10}`, title: `Follow up on ABC-${n + 10}: 2 minor finding(s)?`, options: FOLLOW });
  const files = (...items) => ({ source: 'files', items });

  it('is null when nothing waits now, and for an empty list', () => {
    expect(standbyNews([])).toBeNull();
    expect(standbyNews(undefined)).toBeNull();
    const later = build({ stories: [s('ABC-1', { ownerTask: true, dependsOn: ['ABC-2'] }), s('ABC-2')] });
    expect(later.find((i) => i.id === 'task:ABC-1').group).toBe('later');
    expect(standbyNews(later.filter((i) => i.group === 'later'))).toBeNull();
    expect(standbyNews([{ id: 'run:slow:w1', kind: 'run', group: 'fyi', blocks: [], frees: [] }])).toBeNull();
  });

  it('names follow-up proposals and an owner task, and what finishing the task starts', () => {
    const stories = [s('ABC-1', { ownerTask: true, title: 'Add the key (owner task)' }), s('ABC-2', { dependsOn: ['ABC-1'] })];
    const items = build({ stories, decisions: files(follow(1), follow(2), follow(3)) });
    expect(standbyNews(items)).toEqual({
      text: 'Standby: 3 follow-up proposals and 1 owner task wait on you; finishing ABC-1 starts ABC-2.',
      starts: ['ABC-2'],
    });
  });

  it('uses the singular, and says one answer starts the story', () => {
    const items = build({ stories: [s('ABC-1')], decisions: files(decision({ story: 'ABC-1' })) });
    expect(standbyNews(items)).toEqual({ text: 'Standby: 1 decision waits on you; one answer starts ABC-1.', starts: ['ABC-1'] });
    expect(standbyNews(build({ decisions: files(follow(1)) })).text).toBe('Standby: 1 follow-up proposal waits on you; answering the follow-up proposals creates their stories.');
  });

  it('says answering creates the stories when only follow-ups wait', () => {
    const news = standbyNews(build({ decisions: files(follow(1), follow(2)) }));
    expect(news).toEqual({ text: 'Standby: 2 follow-up proposals wait on you; answering the follow-up proposals creates their stories.', starts: [] });
  });

  it('says no answer starts a story when an owner task frees nothing', () => {
    const news = standbyNews(build({ stories: [s('ABC-1', { ownerTask: true })] }));
    expect(news).toEqual({ text: 'Standby: 1 owner task waits on you; no answer starts a story by itself.', starts: [] });
  });

  it('joins three kinds with commas and an and, and counts the rest as other things', () => {
    const stories = [s('ABC-1', { ownerTask: true }), s('ABC-2', { dependsOn: ['ABC-1'] }), s('ABC-3')];
    const items = build({ stories, decisions: files(follow(1), decision({ story: 'ABC-9' })) });
    expect(standbyNews(items).text).toBe('Standby: 1 follow-up proposal, 1 owner task and 1 decision wait on you; finishing ABC-1 starts ABC-2.');
    const parked = build({ slots: [{ id: 'w2', state: 'parked', parkedFor: 'crash', reason: 'Stopped.', since: null, story: { id: 'ABC-1' } }], stories: [s('ABC-1')] });
    expect(standbyNews(parked)).toEqual({ text: 'Standby: 1 other thing waits on you; one answer starts ABC-1.', starts: ['ABC-1'] });
    const many = [...parked, ...parked.map((i) => ({ ...i, id: `${i.id}b` }))];
    expect(standbyNews(many).text).toContain('2 other things wait on you');
  });

  it('chooses the item that frees most, the first on a tie', () => {
    const items = [
      { id: 'task:ABC-1', kind: 'owner-task', group: 'now', blocks: ['ABC-2'], frees: ['ABC-2'] },
      { id: 'task:ABC-3', kind: 'owner-task', group: 'now', blocks: ['ABC-4', 'ABC-5'], frees: ['ABC-4', 'ABC-5'] },
      { id: 'task:ABC-6', kind: 'owner-task', group: 'now', blocks: ['ABC-7', 'ABC-8'], frees: ['ABC-7', 'ABC-8'] },
    ];
    expect(standbyNews(items)).toEqual({ text: 'Standby: 3 owner tasks wait on you; finishing ABC-3 starts ABC-4 and ABC-5.', starts: ['ABC-4', 'ABC-5'] });
  });
});
