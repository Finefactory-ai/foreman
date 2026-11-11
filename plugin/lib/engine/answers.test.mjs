import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ANSWER_RETRY_MS, answerRetryMs, answerSkips, answersToApply, applyAnswers, EVERY_TICK, failedAnswer, failedStoryOf, heldForAnswer, kindOf, learnedNote, mayApplyAnswers, OPTIONS, RELEASE_RETRY_NOTE, releaseTitle, requeueKind, slotHolds, STORYLESS, supervisorApplies, waitsForAnswer } from './answers.mjs';
import { openProjectStories } from './story-source.mjs';
import { addItem, readLedger, updateItem } from './learning-store.mjs';
import { main } from '../cli/main.mjs';
import * as decisions from '../console/decisions.mjs';
import { CLOSE_TASK, RETRY_STORY, TASK_OPTIONS } from '../console/decisions.mjs';

const REVIEW = ['Retry with a note to the architect', "I'll take it", 'Drop'];

let seq = 0;
const item = ({ story = 'ACME-1', title = `${story} could not pass review`, options = REVIEW, option = null, note = '', kind = 'decision', appliedAt = null, answered = true } = {}) => ({
  id: `d-20261023100000-${String(++seq).padStart(4, '0')}`,
  story,
  kind,
  title,
  options,
  urgent: false,
  body: '',
  createdAt: '2026-10-23T10:00:00.000Z',
  answer: answered ? { option, note, at: '2026-10-23T11:00:00.000Z' } : null,
  appliedAt,
});
const review = (option, note = '') => item({ option, note });
const depends = (option, title = 'Add depends_on: ACME-3, ACME-1 to ACME-2?') => item({ story: 'ACME-2', title, options: ['Apply', 'Ignore'], option });
const trait = (option) => item({ story: 'ACME-3', title: 'Add a trait for developer: Every route needs a test?', options: ['Add as a trait', 'Ignore'], option });
const followUp = (option) => item({ story: 'ACME-1', title: 'Follow up on ACME-1: 2 minor finding(s)?', options: ['Create a follow-up story', 'Ignore'], option });
const waits = (option, title = 'S-3 now waits for S-1, S-2') => item({ story: 'S-3', title, options: ['Undo', 'Keep'], option });
const LEARNED = ['Undo the change', 'Keep the change'];
const learned = (option, title = 'Foreman learned L-1 for developer') => item({ story: 'S-2', title, options: LEARNED, option });
const CREATED = ['Undo and close them', 'Keep them'];
const created = (option, title = 'Foreman created 2 follow-up stories') => item({ story: 'S-4', title, options: CREATED, option });
const DELETES = ['Allow the deletes', 'Keep them out'];
const deletes = (option, note = '', title = 'Allow deletes for S-1?') => item({ story: 'S-1', title, options: DELETES, option, note });

// Fake runners that record every argv; `answer(argv)` gives the result, default status 0.
function runners(answers = {}) {
  const calls = [];
  const make = (name) => (args) => {
    calls.push([name, ...args]);
    const key = Object.keys(answers).find((k) => [name, ...args].join(' ').startsWith(k));
    return key ? answers[key] : { status: 0, stdout: '' };
  };
  return { calls, deps: { foreman: make('foreman'), gh: make('gh'), git: make('git'), branchPrefix: 'story/', remote: 'origin', today: '2026-10-23' } };
}

describe('supervisorApplies', () => {
  it('is true for each kind it applies, with each of its options', () => {
    for (const option of REVIEW) expect(supervisorApplies(review(option))).toBe(true);
    for (const option of ['Apply', 'Ignore']) expect(supervisorApplies(depends(option))).toBe(true);
    for (const option of ['Add as a trait', 'Ignore']) expect(supervisorApplies(trait(option))).toBe(true);
    for (const option of ['Create a follow-up story', 'Ignore']) expect(supervisorApplies(followUp(option))).toBe(true);
    for (const option of DELETES) expect(supervisorApplies(deletes(option))).toBe(true);
  });

  it('applies a deletes answer only when the title names the item\'s own story', () => {
    expect(supervisorApplies(deletes('Allow the deletes', '', 'Allow deletes for S-2?'))).toBe(false);
    expect(supervisorApplies(deletes('Allow the deletes', '', 'Allow deletes for S-1'))).toBe(false);
    expect(supervisorApplies(deletes('Drop'))).toBe(false);
  });

  it('leaves everything else for the sessions', () => {
    expect(supervisorApplies(item({ answered: false }))).toBe(false);
    expect(supervisorApplies(item({ option: 'Drop', appliedAt: '2026-10-23T12:00:00.000Z' }))).toBe(false);
    expect(supervisorApplies(item({ kind: 'task', options: [], option: null, note: 'done it' }))).toBe(false);
    expect(supervisorApplies(item({ title: 'ACME-1 could not pass review', options: [], option: null, note: 'Drop' }))).toBe(false);
    expect(supervisorApplies(item({ title: 'Which colour for the button?', options: ['Drop'], option: 'Drop' }))).toBe(false);
    expect(supervisorApplies(item({ options: [...REVIEW, 'Retry'], option: 'Retry' }))).toBe(false);
    expect(supervisorApplies(item({ title: 'ACME-9 could not pass review', option: 'Drop' }))).toBe(false);
  });
});

describe('applyAnswers', () => {
  it('Retry puts the story back to todo with the note, then marks the item applied', async () => {
    const r = runners();
    const it1 = review('Retry with a note to the architect', 'Use the cache');
    const out = await applyAnswers([it1], r.deps);
    expect(r.calls).toEqual([
      ['foreman', 'story', 'todo', 'ACME-1', '--note', 'Note for the architect: Use the cache'],
      ['foreman', 'decide', 'applied', it1.id],
    ]);
    expect(out).toEqual([{ id: it1.id, story: 'ACME-1', title: 'ACME-1 could not pass review', ok: true, text: 'Applied your answer to "ACME-1 could not pass review": Retry with a note to the architect.' }]);
  });

  it('Retry with no note says the owner retried it', async () => {
    const r = runners();
    await applyAnswers([review('Retry with a note to the architect', '  ')], r.deps);
    expect(r.calls[0]).toEqual(['foreman', 'story', 'todo', 'ACME-1', '--note', 'Retried by the owner.']);
  });

  it("I'll take it claims the story for the owner and blocks it", async () => {
    const r = runners();
    const it1 = review("I'll take it");
    await applyAnswers([it1], r.deps);
    expect(r.calls).toEqual([
      ['foreman', 'lock', 'owner-claim', 'ACME-1'],
      ['foreman', 'story', 'block', 'ACME-1', '--reason', 'Taken by the owner'],
      ['foreman', 'decide', 'applied', it1.id],
    ]);
  });

  it('Drop closes the open pull requests, deletes the branch, and blocks the story', async () => {
    const r = runners({ 'gh pr list': { status: 0, stdout: '[{"number":12},{"number":15}]' } });
    const it1 = review('Drop');
    const [res] = await applyAnswers([it1], r.deps);
    expect(r.calls).toEqual([
      ['gh', 'pr', 'list', '--head', 'story/acme-1', '--state', 'open', '--json', 'number'],
      ['gh', 'pr', 'close', '12'],
      ['gh', 'pr', 'close', '15'],
      ['git', 'push', 'origin', '--delete', 'story/acme-1'],
      ['foreman', 'story', 'block', 'ACME-1', '--reason', 'Dropped by the owner on 2026-10-23'],
      ['foreman', 'decide', 'applied', it1.id],
    ]);
    expect(res.ok).toBe(true);
  });

  it('Drop carries on when the branch is not there to delete', async () => {
    const r = runners({ 'gh pr list': { status: 0, stdout: '[]' }, 'git push': { status: 1, stdout: '' } });
    const [res] = await applyAnswers([review('Drop')], r.deps);
    expect(res.ok).toBe(true);
    expect(r.calls.map((c) => c.slice(0, 3).join(' '))).toContain('foreman decide applied');
  });

  it('Drop fails, and changes nothing more, when the pull requests cannot be listed', async () => {
    for (const answer of [{ status: 1, stdout: '' }, { status: 0, stdout: 'not json' }]) {
      const r = runners({ 'gh pr list': answer });
      const [res] = await applyAnswers([review('Drop')], r.deps);
      expect(res.ok).toBe(false);
      expect(res.text).toMatch(/^Could not apply your answer to "ACME-1 could not pass review": /);
      expect(r.calls.some((c) => c[1] === 'story')).toBe(false);
      expect(r.calls.some((c) => c[1] === 'decide')).toBe(false);
    }
  });

  it('depends_on Apply adds the new ids to the current ones', async () => {
    const r = runners({ 'foreman story next --id ACME-2': { status: 0, stdout: '{"id":"ACME-2","dependsOn":["ACME-1"]}' } });
    const it1 = depends('Apply');
    const [res] = await applyAnswers([it1], r.deps);
    expect(r.calls).toEqual([
      ['foreman', 'story', 'next', '--id', 'ACME-2'],
      ['foreman', 'story', 'set', 'ACME-2', '--depends-on', 'ACME-1,ACME-3'],
      ['foreman', 'decide', 'applied', it1.id],
    ]);
    expect(res.ok).toBe(true);
  });

  it('depends_on Ignore only marks the item applied', async () => {
    const r = runners();
    const it1 = depends('Ignore');
    await applyAnswers([it1], r.deps);
    expect(r.calls).toEqual([['foreman', 'decide', 'applied', it1.id]]);
  });

  it('depends_on Apply fails when the story is not there', async () => {
    const r = runners({ 'foreman story next --id ACME-2': { status: 0, stdout: '{"none":true}' } });
    const [res] = await applyAnswers([depends('Apply')], r.deps);
    expect(res.ok).toBe(false);
    expect(r.calls.some((c) => c[1] === 'decide' || c[2] === 'set')).toBe(false);
  });

  it('knows a dependency note by its title and its own story, and applies Undo and Keep', () => {
    expect(kindOf({ title: 'S-3 now waits for S-1, S-2', story: 'S-3' })).toBe('waits');
    expect(kindOf({ title: 'S-3 now waits for S-1, S-2', story: 'S-4' })).toBeNull();
    expect(supervisorApplies(waits('Undo'))).toBe(true);
    expect(supervisorApplies(waits('Keep'))).toBe(true);
    expect(supervisorApplies(waits('Apply'))).toBe(false);
  });

  it('dependency note Undo takes the ids it names off, keeping the rest', async () => {
    const r = runners({ 'foreman story next --id S-3': { status: 0, stdout: '{"id":"S-3","dependsOn":["S-0","S-1","S-2"]}' } });
    const it1 = waits('Undo');
    const [res] = await applyAnswers([it1], r.deps);
    expect(r.calls).toEqual([
      ['foreman', 'story', 'next', '--id', 'S-3'],
      ['foreman', 'story', 'set', 'S-3', '--depends-on', 'S-0'],
      ['foreman', 'decide', 'applied', it1.id],
    ]);
    expect(res).toMatchObject({ ok: true, text: 'Applied your answer to "S-3 now waits for S-1, S-2": Undo.' });
  });

  it('dependency note Undo that leaves nothing sets an empty list', async () => {
    const r = runners({ 'foreman story next --id S-3': { status: 0, stdout: '{"id":"S-3","dependsOn":["S-1","S-2"]}' } });
    const it1 = waits('Undo');
    await applyAnswers([it1], r.deps);
    expect(r.calls[1]).toEqual(['foreman', 'story', 'set', 'S-3', '--depends-on', '']);
  });

  it('dependency note Keep only marks the item applied', async () => {
    const r = runners();
    const it1 = waits('Keep');
    await applyAnswers([it1], r.deps);
    expect(r.calls).toEqual([['foreman', 'decide', 'applied', it1.id]]);
  });

  it('dependency note Undo whose set fails leaves the item pending', async () => {
    const r = runners({
      'foreman story next --id S-3': { status: 0, stdout: '{"id":"S-3","dependsOn":["S-1"]}' },
      'foreman story set': { status: 1, stdout: '' },
    });
    const [res] = await applyAnswers([waits('Undo')], r.deps);
    expect(res).toMatchObject({ ok: false, text: 'Could not apply your answer to "S-3 now waits for S-1, S-2": setting the depends_on of S-3 failed.' });
    expect(r.calls.some((c) => c[1] === 'decide')).toBe(false);
  });

  it('knows a learned-change note by its title, and applies only its own options', () => {
    expect(kindOf({ title: 'Foreman learned L-1 for developer', story: 'S-2' })).toBe('learned');
    expect(kindOf({ title: 'Foreman changed L-12 for tester', story: 'S-2' })).toBe('learned');
    expect(kindOf({ title: 'Foreman learned X for developer', story: 'S-2' })).toBeNull();
    expect(supervisorApplies(learned('Undo the change'))).toBe(true);
    expect(supervisorApplies(learned('Keep the change'))).toBe(true);
    expect(supervisorApplies(learned('Undo'))).toBe(false);
  });

  it('knows a learned-change note for several roles, and its Undo the change runs foreman learning undo', async () => {
    const title = 'Foreman learned L-3 for developer, tester';
    expect(kindOf({ title, story: 'S-2' })).toBe('learned');
    expect(kindOf({ title: 'Foreman learned L-3 for developer,tester', story: 'S-2' })).toBeNull();
    const r = runners();
    const it1 = learned('Undo the change', title);
    await applyAnswers([it1], r.deps);
    expect(r.calls).toEqual([
      ['foreman', 'learning', 'undo', 'L-3', '--told-at', '2026-10-23T10:00:00.000Z'],
      ['foreman', 'decide', 'applied', it1.id],
    ]);
  });

  it('learned-change Undo runs foreman learning undo, then marks the item applied', async () => {
    const r = runners();
    const it1 = learned('Undo the change');
    const [res] = await applyAnswers([it1], r.deps);
    expect(r.calls).toEqual([
      ['foreman', 'learning', 'undo', 'L-1', '--told-at', '2026-10-23T10:00:00.000Z'],
      ['foreman', 'decide', 'applied', it1.id],
    ]);
    expect(res).toMatchObject({ ok: true, text: 'Applied your answer to "Foreman learned L-1 for developer": Undo the change.' });
  });

  it('learned-change Keep runs foreman learning keep, then marks the item applied', async () => {
    const r = runners();
    const it1 = learned('Keep the change', 'Foreman changed L-3 for tester');
    await applyAnswers([it1], r.deps);
    expect(r.calls).toEqual([
      ['foreman', 'learning', 'keep', 'L-3', '--told-at', '2026-10-23T10:00:00.000Z'],
      ['foreman', 'decide', 'applied', it1.id],
    ]);
  });

  it('knows a rolled-back note by its title, for a rollback and a retire', () => {
    expect(kindOf({ title: 'Foreman rolled back L-1 for developer', story: 'S-2' })).toBe('rolledBack');
    expect(kindOf({ title: 'Foreman retired L-12 for developer, tester', story: 'S-2' })).toBe('rolledBack');
    expect(kindOf({ title: 'Foreman rolled back X-1 for developer', story: 'S-2' })).toBeNull();
    expect(kindOf({ title: 'Foreman retired L-1 for developer,tester', story: 'S-2' })).toBeNull();
  });

  it('a rolled-back note\'s Got it only marks it applied', async () => {
    const r = runners();
    const it1 = item({ story: 'S-2', title: 'Foreman rolled back L-1 for developer', options: ['Got it'], option: 'Got it' });
    expect(supervisorApplies(it1)).toBe(true);
    const [res] = await applyAnswers([it1], r.deps);
    expect(r.calls).toEqual([['foreman', 'decide', 'applied', it1.id]]);
    expect(res).toMatchObject({ ok: true });
    expect(supervisorApplies({ ...it1, answer: { option: 'Undo the change' } })).toBe(false);
  });

  it('knows a did-not-undo note as a rolled-back one: Got it only marks it applied', async () => {
    const title = 'Foreman did not undo L-3 for developer, tester';
    expect(kindOf({ title, story: 'S-2' })).toBe('rolledBack');
    expect(learnedNote({ title })).toEqual({ id: 'L-3', change: 'notUndone', roles: ['developer', 'tester'] });
    expect(kindOf({ title: 'Foreman did not undo X-1 for developer', story: 'S-2' })).toBeNull();
    expect(learnedNote({ title: 'Foreman did not undo X-1 for developer' })).toBeNull();
    const r = runners();
    const it1 = item({ story: 'S-2', title, options: ['Got it'], option: 'Got it' });
    expect(supervisorApplies(it1)).toBe(true);
    expect(requeueKind(it1)).toBeNull();
    await applyAnswers([it1], r.deps);
    expect(r.calls).toEqual([['foreman', 'decide', 'applied', it1.id]]);
  });

  it('learnedNote reads the id, the change and the roles of each learned and rolled-back title', () => {
    expect(learnedNote({ title: 'Foreman learned L-1 for developer' })).toEqual({ id: 'L-1', change: 'add', roles: ['developer'] });
    expect(learnedNote({ title: 'Foreman changed L-12 for developer, tester' })).toEqual({ id: 'L-12', change: 'update', roles: ['developer', 'tester'] });
    expect(learnedNote({ title: 'Foreman rolled back L-3 for tester' })).toEqual({ id: 'L-3', change: 'rollback', roles: ['tester'] });
    expect(learnedNote({ title: 'Foreman retired L-4 for developer, tester, reviewer-2' })).toEqual({ id: 'L-4', change: 'retire', roles: ['developer', 'tester', 'reviewer-2'] });
  });

  it('learnedNote is null for any other title', () => {
    for (const title of ['ABC-2 now waits for ABC-1', 'Foreman learned X-1 for developer', 'Foreman learned L-1 for developer,tester', 'Foreman forgot L-1 for developer', 'ACME-1 could not pass review', '', undefined]) {
      expect(learnedNote({ title, story: 'ABC-2' }), String(title)).toBeNull();
    }
    expect(learnedNote(null)).toBeNull();
  });

  it.each([[null], ['']])('a learned-change answer on a note with createdAt %j runs nothing and stays pending', async (createdAt) => {
    const r = runners();
    const [res] = await applyAnswers([{ ...learned('Undo the change'), createdAt }], r.deps);
    expect(res).toMatchObject({ ok: false, text: 'Could not apply your answer to "Foreman learned L-1 for developer": running foreman learning undo L-1 failed.' });
    expect(r.calls).toEqual([]);
  });

  it('learned-change Undo that fails leaves the item pending', async () => {
    const r = runners({ 'foreman learning undo': { status: 1, stdout: '' } });
    const [res] = await applyAnswers([learned('Undo the change')], r.deps);
    expect(res.ok).toBe(false);
    expect(res.text).toContain('Could not apply your answer to "Foreman learned L-1 for developer"');
    expect(r.calls.some((c) => c[1] === 'decide')).toBe(false);
  });

  it('trait and follow-up answers go through foreman learn, which marks the item itself', async () => {
    const r = runners();
    const items = [trait('Add as a trait'), trait('Ignore'), followUp('Create a follow-up story'), followUp('Ignore')];
    const out = await applyAnswers(items, r.deps);
    expect(r.calls).toEqual([
      ['foreman', 'learn', 'apply', items[0].id],
      ['foreman', 'learn', 'ignore', items[1].id],
      ['foreman', 'learn', 'apply', items[2].id],
      ['foreman', 'learn', 'ignore', items[3].id],
    ]);
    expect(out.every((x) => x.ok)).toBe(true);
  });

  it('Allow the deletes records the allow, puts the story back to todo with the note, then marks the item applied', async () => {
    const r = runners();
    const it1 = deletes('Allow the deletes', 'Old is unused');
    const [res] = await applyAnswers([it1], r.deps);
    expect(r.calls).toEqual([
      ['foreman', 'sf', 'deletes', 'allow', 'S-1'],
      ['foreman', 'story', 'todo', 'S-1', '--note', 'The owner allowed the deletes. Old is unused'],
      ['foreman', 'decide', 'applied', it1.id],
    ]);
    expect(res).toMatchObject({ ok: true, text: 'Applied your answer to "Allow deletes for S-1?": Allow the deletes.' });
  });

  it('Allow the deletes with no note says only that the owner allowed them', async () => {
    const r = runners();
    await applyAnswers([deletes('Allow the deletes', ' ')], r.deps);
    expect(r.calls[1]).toEqual(['foreman', 'story', 'todo', 'S-1', '--note', 'The owner allowed the deletes.']);
  });

  it('Keep them out records the keep-out and tells the architect to delete nothing', async () => {
    const r = runners();
    const it1 = deletes('Keep them out', 'Old is still used by Acme reports');
    await applyAnswers([it1], r.deps);
    expect(r.calls).toEqual([
      ['foreman', 'sf', 'deletes', 'keep-out', 'S-1'],
      ['foreman', 'story', 'todo', 'S-1', '--note', 'Note for the architect: the owner wants nothing deleted in this story; keep every delete out. Old is still used by Acme reports'],
      ['foreman', 'decide', 'applied', it1.id],
    ]);
    expect(r.calls[1][5]).toMatch(/^Note for the architect: the owner wants nothing deleted/);
  });

  it('a deletes answer whose first step fails stays pending', async () => {
    const r = runners({ 'foreman sf deletes': { status: 1, stdout: '{"ok":false,"reason":"no deletes wait for S-1"}' } });
    const [res] = await applyAnswers([deletes('Allow the deletes')], r.deps);
    expect(res.ok).toBe(false);
    expect(r.calls).toEqual([['foreman', 'sf', 'deletes', 'allow', 'S-1']]);
  });

  it('a failing step stops that item, and the next item is still handled', async () => {
    const r = runners({ 'foreman story todo': { status: 1, stdout: '' } });
    const first = review('Retry with a note to the architect', 'x');
    const second = depends('Ignore');
    const out = await applyAnswers([first, second], r.deps);
    expect(out.map((x) => x.ok)).toEqual([false, true]);
    expect(r.calls).toEqual([
      ['foreman', 'story', 'todo', 'ACME-1', '--note', 'Note for the architect: x'],
      ['foreman', 'decide', 'applied', second.id],
    ]);
  });

  it('with kinds, applies only those kinds, in order, and calls nothing for the rest', async () => {
    const r = runners({
      'foreman story next --id ACME-2': { status: 0, stdout: '{"id":"ACME-2","dependsOn":[]}' },
      'foreman story next --id S-3': { status: 0, stdout: '{"id":"S-3","dependsOn":["S-1","S-2"]}' },
    });
    const items = [
      review('Retry with a note to the architect', 'x'),
      depends('Apply'),
      waits('Undo'),
      trait('Add as a trait'),
      followUp('Create a follow-up story'),
      deletes('Allow the deletes'),
      learned('Keep the change'),
      item({ story: 'S-2', title: 'Foreman rolled back L-2 for developer', options: ['Got it'], option: 'Got it' }),
    ];
    const [, dep, wait, , , , learn, back] = items;
    const out = await applyAnswers(items, { ...r.deps, kinds: STORYLESS });
    expect(r.calls).toEqual([
      ['foreman', 'story', 'next', '--id', 'ACME-2'],
      ['foreman', 'story', 'set', 'ACME-2', '--depends-on', 'ACME-3,ACME-1'],
      ['foreman', 'decide', 'applied', dep.id],
      ['foreman', 'story', 'next', '--id', 'S-3'],
      ['foreman', 'story', 'set', 'S-3', '--depends-on', ''],
      ['foreman', 'decide', 'applied', wait.id],
      ['foreman', 'learning', 'keep', 'L-1', '--told-at', '2026-10-23T10:00:00.000Z'],
      ['foreman', 'decide', 'applied', learn.id],
      ['foreman', 'decide', 'applied', back.id],
    ]);
    expect(out.map((x) => x.id)).toEqual([dep.id, wait.id, learn.id, back.id]);
    expect(out.every((x) => x.ok)).toBe(true);
  });

  it('kinds and skip combine: a skipped learned item is not run', async () => {
    const r = runners();
    const skipped = learned('Keep the change');
    const other = learned('Undo the change', 'Foreman learned L-2 for tester');
    const out = await applyAnswers([skipped, other, review('Drop')], { ...r.deps, kinds: STORYLESS, skip: new Set([skipped.id]) });
    expect(r.calls).toEqual([
      ['foreman', 'learning', 'undo', 'L-2', '--told-at', '2026-10-23T10:00:00.000Z'],
      ['foreman', 'decide', 'applied', other.id],
    ]);
    expect(out.map((x) => x.id)).toEqual([other.id]);
  });

  it('leaves the skipped, unanswered and unknown items alone, calling nothing', async () => {
    const r = runners();
    const skipped = review('Drop');
    const out = await applyAnswers([skipped, item({ answered: false }), item({ title: 'Which colour?', options: ['Red'], option: 'Red' }), task('x')], { ...r.deps, skip: new Set([skipped.id]) });
    expect(out).toEqual([]);
    expect(r.calls).toEqual([]);
  });
});

describe('STORYLESS', () => {
  it('is the kinds that need no story context: learned, rolled back, waits, depends and created', () => {
    expect(STORYLESS).toEqual(['learned', 'rolledBack', 'waits', 'depends', 'created']);
  });
});

describe('a note about follow-ups Foreman created', () => {
  it('is known by its title', () => {
    expect(kindOf({ title: 'Foreman created 2 follow-up stories', story: 'S-4' })).toBe('created');
    expect(kindOf({ title: 'Foreman created 1 follow-up story', story: 'S-4' })).toBe('created');
    expect(kindOf({ title: 'Foreman created stories', story: 'S-4' })).toBeNull();
    expect(kindOf({ title: 'Foreman created 2 follow-up stories?', story: 'S-4' })).toBeNull();
    expect(supervisorApplies(created('Undo and close them'))).toBe(true);
    expect(supervisorApplies(created('Keep them'))).toBe(true);
    expect(supervisorApplies(created('Undo'))).toBe(false);
  });

  it('Undo and close them runs foreman learn undo, which marks the item itself', async () => {
    const r = runners();
    const it1 = created('Undo and close them');
    const [res] = await applyAnswers([it1], r.deps);
    expect(r.calls).toEqual([['foreman', 'learn', 'undo', it1.id]]);
    expect(res).toMatchObject({ ok: true, text: 'Applied your answer to "Foreman created 2 follow-up stories": Undo and close them.' });
  });

  it('Keep them only marks the item applied', async () => {
    const r = runners();
    const it1 = created('Keep them', 'Foreman created 1 follow-up story');
    await applyAnswers([it1], r.deps);
    expect(r.calls).toEqual([['foreman', 'decide', 'applied', it1.id]]);
  });

  it('is applied on every tick, while sessions run', async () => {
    const r = runners();
    const it1 = created('Undo and close them');
    const out = await applyAnswers([review('Drop'), it1], { ...r.deps, kinds: EVERY_TICK });
    expect(out.map((x) => x.id)).toEqual([it1.id]);
    expect(r.calls).toEqual([['foreman', 'learn', 'undo', it1.id]]);
  });

  it('a learn undo that fails leaves the item pending', async () => {
    const r = runners({ 'foreman learn undo': { status: 1, stdout: '' } });
    const [res] = await applyAnswers([created('Undo and close them')], r.deps);
    expect(res).toMatchObject({ ok: false, text: 'Could not apply your answer to "Foreman created 2 follow-up stories": running foreman learn undo failed.' });
    expect(r.calls.some((c) => c[1] === 'decide')).toBe(false);
  });

  it('is not a story answer', () => {
    expect(requeueKind(created('Keep them'))).toBeNull();
    expect(requeueKind(created('Undo and close them'))).toBeNull();
  });
});

// The answers that put a story back in line: a task, a "Decide for" question or a "Close …:
// nothing to build?" proposal about a story that is blocked in words or in progress.
const CLOSE = ['Close it as Done', 'Build it anyway'];
const STORES = ['The database', 'The cache'];
const task = (note, over = {}) => item({ kind: 'task', title: 'ACME-1: which store?', options: TASK_OPTIONS, option: RETRY_STORY, note, ...over });
const closed = (note, over = {}) => task(note, { option: CLOSE_TASK, ...over });
// A task asked before tasks had the two options, answered in words.
const oldTask = (note, over = {}) => item({ kind: 'task', title: 'ACME-1: which store?', options: [], option: null, note, ...over });
const decideFor = (option, note = '') => item({ story: 'ACME-2', title: 'Decide for ACME-2: Which store?', options: STORES, option, note });
const closeIt = (option, note = '') => ({ ...item({ title: 'Close ACME-1: nothing to build?', options: CLOSE, option, note }), body: 'The login\nalready works.' });
const ID = '[A-Z]+-\\d+';
const story = (over = {}) => ({ id: 'ACME-1', title: 'Story ACME-1', status: 'blocked', blockedBy: 'Owner decision needed: x', dependsOn: [], ownerTask: false, ...over });

describe('requeueKind', () => {
  it('is answer for a task answered Retry the story and for a Decide for question answered with one of its options', () => {
    expect(requeueKind(task('(A) fresh'))).toBe('answer');
    expect(requeueKind(decideFor('The cache'))).toBe('answer');
  });

  it('is closeTask for a task answered Close the task, and for an old task answered in words', () => {
    expect(requeueKind(closed('handled'))).toBe('closeTask');
    expect(requeueKind(closed(''))).toBe('closeTask');
    expect(requeueKind(oldTask('(A) fresh'))).toBe('closeTask');
  });

  it('is null for an old task with a blank note, a task whose option is not in its options, and a task with options of its own', () => {
    expect(requeueKind(oldTask('   \n '))).toBeNull();
    expect(requeueKind(oldTask(undefined))).toBeNull();
    expect(requeueKind(task('x', { option: 'Something else' }))).toBeNull();
    expect(requeueKind(task('x', { options: ['Red'], option: 'Red' }))).toBeNull();
    expect(requeueKind(task('x', { options: [CLOSE_TASK], option: RETRY_STORY }))).toBeNull();
  });

  it('is close for a nothing-to-build proposal answered with either of its options', () => {
    for (const option of CLOSE) expect(requeueKind(closeIt(option)), option).toBe('close');
  });

  it('is null for unanswered, applied and storyless items', () => {
    expect(requeueKind(task('x', { answered: false }))).toBeNull();
    expect(requeueKind(task('x', { appliedAt: '2026-10-23T12:00:00.000Z' }))).toBeNull();
    expect(requeueKind(task('x', { story: '' }))).toBeNull();
    expect(requeueKind({ ...task('x'), story: undefined })).toBeNull();
    expect(requeueKind(null)).toBeNull();
  });

  it('is null for every titled kind the supervisor applies by its own rules', () => {
    const titled = [
      review('Drop'),
      depends('Apply'),
      trait('Add as a trait'),
      followUp('Ignore'),
      deletes('Allow the deletes'),
      waits('Keep'),
      learned('Keep the change'),
      item({ story: 'S-2', title: 'Foreman rolled back L-1 for developer', options: ['Got it'], option: 'Got it' }),
    ];
    for (const it1 of titled) expect(requeueKind(it1), it1.title).toBeNull();
    // A task with a review title is still a review.
    expect(requeueKind(item({ kind: 'task', options: [], option: null, note: 'x' }))).toBeNull();
  });

  it('is null for an option not in the options, a Close answered otherwise, and an empty note', () => {
    expect(requeueKind(decideFor('The disk'))).toBeNull();
    expect(requeueKind(closeIt('Drop'))).toBeNull();
    expect(requeueKind({ ...closeIt('Close it as Done'), options: ['Build it anyway'] })).toBeNull();
  });

  it('is null for any other kind of item', () => {
    expect(requeueKind(task('x', { kind: 'fyi' }))).toBeNull();
  });
});

describe('waitsForAnswer', () => {
  it('is true for a story blocked for a reason in words, and for one in progress', () => {
    expect(waitsForAnswer(story(), { idPattern: ID })).toBe(true);
    expect(waitsForAnswer(story({ status: 'in-progress', blockedBy: '' }), { idPattern: ID })).toBe(true);
  });

  it('is false for a held story, one blocked on another story, an owner task, or no story', () => {
    expect(waitsForAnswer(story(), { held: new Set(['ACME-1']), idPattern: ID })).toBe(false);
    expect(waitsForAnswer(story({ status: 'in-progress' }), { held: new Set(['ACME-1']), idPattern: ID })).toBe(false);
    expect(waitsForAnswer(story({ blockedBy: 'ACME-3 must land first' }), { idPattern: ID })).toBe(false);
    expect(waitsForAnswer(story({ ownerTask: true }), { idPattern: ID })).toBe(false);
    expect(waitsForAnswer(undefined, { idPattern: ID })).toBe(false);
  });

  it('is false for todo, done, ready-to-promote and retired stories', () => {
    for (const status of ['todo', 'done', 'ready-to-promote', 'retired']) expect(waitsForAnswer(story({ status }), { idPattern: ID }), status).toBe(false);
  });
});

describe('heldForAnswer', () => {
  const MAYBE = { blockedBy: 'Release stopped: the smoke test failed' };

  it('slotHolds gives the story, held story and parked story, and skips empty ones', () => {
    expect(slotHolds({ story: { id: 'ACME-1' }, heldStory: 'ACME-2', parkedStory: '' })).toEqual(['ACME-1', 'ACME-2']);
    expect(slotHolds({ story: null, heldStory: null, parkedStory: 'ACME-3' })).toEqual(['ACME-3']);
    expect(slotHolds(undefined)).toEqual([]);
  });

  it('holds the story of a held slot after a restart, when its claim reads stale', () => {
    const held = heldForAnswer({
      claims: [{ id: 'ACME-1', slot: 'w1', stale: true }],
      slots: [{ state: 'held', heldStory: 'ACME-1', haltedBy: true, story: null }],
    });
    expect(held.has('ACME-1')).toBe(true);
    expect(waitsForAnswer(story(MAYBE), { held, idPattern: ID })).toBe(false);
  });

  it('holds the story of a parked slot', () => {
    const held = heldForAnswer({ slots: [{ state: 'parked', parkedFor: 'crash', parkedStory: 'ACME-1', story: null }] });
    expect(held.has('ACME-1')).toBe(true);
  });

  it('holds the story a slot is running', () => {
    expect(heldForAnswer({ slots: [{ state: 'running', story: { id: 'ACME-1' } }] }).has('ACME-1')).toBe(true);
  });

  it('does not hold a story for a stale claim alone, with idle slots', () => {
    const held = heldForAnswer({ claims: [{ id: 'ACME-1', stale: true }], slots: [{ state: 'idle', story: null }, null] });
    expect(held.has('ACME-1')).toBe(false);
    expect(waitsForAnswer(story(MAYBE), { held, idPattern: ID })).toBe(true);
  });

  it('holds a live claim, a session and a queued work item', () => {
    expect(heldForAnswer({ claims: [{ id: 'ACME-1', stale: false }] }).has('ACME-1')).toBe(true);
    expect(heldForAnswer({ claims: [{ id: 'ACME-1' }] }).has('ACME-1')).toBe(true);
    expect(heldForAnswer({ sessions: [{ id: 'ACME-2' }] }).has('ACME-2')).toBe(true);
    expect(heldForAnswer({ work: [{ id: 'ACME-3' }] }).has('ACME-3')).toBe(true);
  });

  it('skips empty ids and tolerates missing or odd arguments', () => {
    expect(heldForAnswer()).toEqual(new Set());
    expect(heldForAnswer({ claims: null, sessions: 'x', work: undefined, slots: {} })).toEqual(new Set());
    expect(heldForAnswer({ claims: [{ id: '' }, null, {}], sessions: [{ id: null }], work: [undefined] })).toEqual(new Set());
  });

  it('is what the supervisor uses to decide whether a story can be put back', () => {
    const src = readFileSync(new URL('./supervisor.mjs', import.meta.url), 'utf8');
    expect(src).toContain('const held = heldForAnswer({ claims: claims(DIR), sessions: inHandSessions(), work, slots: SLOT_IDS.map((s) => readSlot(DIR, s)) });');
    expect(src).not.toContain('claims(DIR).filter((c) => !c.stale)');
  });
});

describe('EVERY_TICK', () => {
  it('is the storyless kinds plus the story answers, close and answer, and closeTask', () => {
    expect(EVERY_TICK).toEqual([...STORYLESS, 'close', 'answer', 'closeTask']);
  });
});

describe('applyAnswers on a story answer', () => {
  const yes = { canRequeue: () => true };

  it('puts the story back to todo with the answer, folded to one line, then marks the item applied', async () => {
    const r = runners();
    const it1 = task('(A) fresh\nOwner:  always run fresh');
    const out = await applyAnswers([it1], { ...r.deps, ...yes });
    expect(r.calls).toEqual([
      ['foreman', 'story', 'todo', 'ACME-1', '--note', 'Note for the architect: the owner answered "ACME-1: which store?" with "Retry the story". (A) fresh Owner: always run fresh'],
      ['foreman', 'decide', 'applied', it1.id],
    ]);
    expect(out).toEqual([{ id: it1.id, story: 'ACME-1', title: 'ACME-1: which store?', ok: true, text: 'Applied your answer to "ACME-1: which store?": ACME-1 is back to todo with your answer.' }]);
  });

  it('a Decide for answer names the option, then the note', async () => {
    const r = runners();
    const it1 = decideFor('The cache', 'Speed matters');
    await applyAnswers([it1], { ...r.deps, ...yes });
    expect(r.calls).toEqual([
      ['foreman', 'story', 'todo', 'ACME-2', '--note', 'Note for the architect: the owner answered "Decide for ACME-2: Which store?" with "The cache". Speed matters'],
      ['foreman', 'decide', 'applied', it1.id],
    ]);
  });

  it('a Decide for answer with no note names only the option', async () => {
    const r = runners();
    await applyAnswers([decideFor('The database', '  ')], { ...r.deps, ...yes });
    expect(r.calls[0]).toEqual(['foreman', 'story', 'todo', 'ACME-2', '--note', 'Note for the architect: the owner answered "Decide for ACME-2: Which store?" with "The database".']);
  });

  it('Close it as Done closes the story with the body and the note, then marks the item applied', async () => {
    const r = runners();
    const it1 = closeIt('Close it as Done', 'Checked it');
    const [res] = await applyAnswers([it1], { ...r.deps, ...yes });
    expect(r.calls).toEqual([
      ['foreman', 'story', 'done', 'ACME-1', '--note', 'Closed by the owner: nothing to build. The login already works. Checked it'],
      ['foreman', 'decide', 'applied', it1.id],
    ]);
    expect(res).toMatchObject({ ok: true, text: 'Applied your answer to "Close ACME-1: nothing to build?": Close it as Done.' });
  });

  it('Close it as Done never writes two full stops in a row', async () => {
    const plain = runners();
    await applyAnswers([{ ...closeIt('Close it as Done', 'Checked it'), body: 'The login already works' }], { ...plain.deps, ...yes });
    expect(plain.calls[0]).toEqual(['foreman', 'story', 'done', 'ACME-1', '--note', 'Closed by the owner: nothing to build. The login already works. Checked it']);
    const two = runners();
    await applyAnswers([{ ...closeIt('Close it as Done', 'Checked it'), body: 'The login already works..' }], { ...two.deps, ...yes });
    expect(two.calls[0]).toEqual(['foreman', 'story', 'done', 'ACME-1', '--note', 'Closed by the owner: nothing to build. The login already works.. Checked it']);
  });

  it('Close it as Done with no note leaves the note out', async () => {
    const r = runners();
    await applyAnswers([closeIt('Close it as Done')], { ...r.deps, ...yes });
    expect(r.calls[0]).toEqual(['foreman', 'story', 'done', 'ACME-1', '--note', 'Closed by the owner: nothing to build. The login already works.']);
  });

  it('Build it anyway puts the story back to todo for the architect, then marks the item applied', async () => {
    const r = runners();
    const it1 = closeIt('Build it anyway', 'The logout is missing');
    await applyAnswers([it1], { ...r.deps, ...yes });
    expect(r.calls).toEqual([
      ['foreman', 'story', 'todo', 'ACME-1', '--note', 'Note for the architect: the owner wants it built anyway. The logout is missing'],
      ['foreman', 'decide', 'applied', it1.id],
    ]);
    const bare = runners();
    await applyAnswers([closeIt('Build it anyway')], { ...bare.deps, ...yes });
    expect(bare.calls[0]).toEqual(['foreman', 'story', 'todo', 'ACME-1', '--note', 'Note for the architect: the owner wants it built anyway.']);
  });

  it('leaves the item pending, calling nothing, when the story may not be put back', async () => {
    for (const extra of [{}, { canRequeue: () => false }]) {
      const r = runners();
      expect(await applyAnswers([task('(A) fresh'), decideFor('The cache'), closeIt('Close it as Done')], { ...r.deps, ...extra })).toEqual([]);
      expect(r.calls).toEqual([]);
    }
  });

  it('asks canRequeue about the item\'s own story', async () => {
    const r = runners();
    const asked = [];
    const out = await applyAnswers([task('x'), decideFor('The cache')], { ...r.deps, canRequeue: (id) => (asked.push(id), id === 'ACME-2') });
    expect(asked).toEqual(['ACME-1', 'ACME-2']);
    expect(out.map((x) => x.story)).toEqual(['ACME-2']);
  });

  it('with kinds STORYLESS skips a story answer; with EVERY_TICK applies it, still skipping a review', async () => {
    const story1 = task('(A) fresh');
    const retry = review('Retry with a note to the architect', 'x');
    const busy = runners();
    expect(await applyAnswers([retry, story1], { ...busy.deps, ...yes, kinds: STORYLESS })).toEqual([]);
    expect(busy.calls).toEqual([]);

    const r = runners();
    const out = await applyAnswers([retry, story1], { ...r.deps, ...yes, kinds: EVERY_TICK });
    expect(out.map((x) => x.id)).toEqual([story1.id]);
    expect(r.calls).toEqual([
      ['foreman', 'story', 'todo', 'ACME-1', '--note', 'Note for the architect: the owner answered "ACME-1: which store?" with "Retry the story". (A) fresh'],
      ['foreman', 'decide', 'applied', story1.id],
    ]);
  });

  it('a story answer whose todo fails stays pending', async () => {
    const r = runners({ 'foreman story todo': { status: 1, stdout: '' } });
    const [res] = await applyAnswers([task('(A) fresh')], { ...r.deps, ...yes });
    expect(res).toMatchObject({ ok: false, text: 'Could not apply your answer to "ACME-1: which store?": putting ACME-1 back to todo failed.' });
    expect(r.calls.some((c) => c[1] === 'decide')).toBe(false);
  });

  it('a failed apply names the step that failed, and a good one has none', async () => {
    const bad = runners({ 'foreman story todo': { status: 1, stdout: '' } });
    const [failed] = await applyAnswers([task('(A) fresh')], { ...bad.deps, ...yes });
    expect(failed.step).toBe('putting ACME-1 back to todo');
    const good = runners();
    const [worked] = await applyAnswers([task('(A) fresh')], { ...good.deps, ...yes });
    expect(worked.ok).toBe(true);
    expect(worked.step).toBeUndefined();
  });

  it('a skipped story answer is not run', async () => {
    const r = runners();
    const it1 = task('x');
    expect(await applyAnswers([it1], { ...r.deps, ...yes, skip: new Set([it1.id]) })).toEqual([]);
    expect(r.calls).toEqual([]);
  });
});

describe('applyAnswers on an owner task', () => {
  const closedText = 'Applied your answer to "ACME-1: which store?": the task is closed and ACME-1 is left as it is.';

  it('Close the task only marks the item applied, even when the story may not be put back', async () => {
    const r = runners();
    const it1 = closed('handled');
    const out = await applyAnswers([it1], { ...r.deps, canRequeue: () => false });
    expect(r.calls).toEqual([['foreman', 'decide', 'applied', it1.id]]);
    expect(r.calls.some((c) => c[1] === 'story')).toBe(false);
    expect(out).toEqual([{ id: it1.id, story: 'ACME-1', title: 'ACME-1: which store?', ok: true, text: closedText }]);
  });

  it('Close the task is applied on every tick while busy, and not on the storyless ticks', async () => {
    const busy = runners();
    const it1 = closed('handled');
    const out = await applyAnswers([it1], { ...busy.deps, kinds: EVERY_TICK });
    expect(out.map((x) => x.id)).toEqual([it1.id]);
    expect(busy.calls).toEqual([['foreman', 'decide', 'applied', it1.id]]);
    const none = runners();
    expect(await applyAnswers([it1], { ...none.deps, kinds: STORYLESS })).toEqual([]);
    expect(none.calls).toEqual([]);
  });

  it('an old task answered in words is closed, leaving the story alone', async () => {
    const r = runners();
    const it1 = oldTask('done it');
    const [res] = await applyAnswers([it1], r.deps);
    expect(r.calls).toEqual([['foreman', 'decide', 'applied', it1.id]]);
    expect(res.text).toBe(closedText);
  });

  it('a close whose marking fails stays pending', async () => {
    const r = runners({ 'foreman decide applied': { status: 1, stdout: '' } });
    const [res] = await applyAnswers([closed('x')], r.deps);
    expect(res).toMatchObject({ ok: false, step: 'marking it applied', text: 'Could not apply your answer to "ACME-1: which store?": marking it applied failed.' });
  });

  it('Retry the story puts the story back to todo with the note, then marks the item applied', async () => {
    const r = runners();
    const it1 = task('use it');
    const [res] = await applyAnswers([it1], { ...r.deps, canRequeue: () => true });
    expect(r.calls).toEqual([
      ['foreman', 'story', 'todo', 'ACME-1', '--note', 'Note for the architect: the owner answered "ACME-1: which store?" with "Retry the story". use it'],
      ['foreman', 'decide', 'applied', it1.id],
    ]);
    expect(res.text).toBe('Applied your answer to "ACME-1: which store?": ACME-1 is back to todo with your answer.');
  });

  it('Retry the story is skipped and stays pending when the story may not be put back', async () => {
    const r = runners();
    expect(await applyAnswers([task('use it')], { ...r.deps, canRequeue: () => false })).toEqual([]);
    expect(r.calls).toEqual([]);
  });
});

describe('mayApplyAnswers', () => {
  const idle = { running: 0, preparing: 0, queued: 0, halted: false, held: false, stopping: false };
  it('is true only when nothing runs, waits or holds', () => {
    expect(mayApplyAnswers(idle)).toBe(true);
  });
  it('refuses while a session runs, a slot prepares, work is queued, or the run is halted, held or stopping', () => {
    for (const patch of [{ running: 1 }, { preparing: 1 }, { queued: 2 }, { halted: true }, { held: true }, { stopping: true }]) {
      expect(mayApplyAnswers({ ...idle, ...patch })).toBe(false);
    }
  });
  it("is what the supervisor's tick asks, with the live counts, and failed answers are skipped", () => {
    const src = readFileSync(new URL('./supervisor.mjs', import.meta.url), 'utf8');
    expect(src).toContain('const answersIdle = mayApplyAnswers({ running: sessions.size + closing.size, preparing: preparing.size, queued: takeable(work, workers), halted, held: pickHeld, stopping });');
    expect(src).toContain('await startAnswers(answersIdle ? null : EVERY_TICK);');
    expect(src).toContain('const skip = answerSkips(answerFailures, Date.now());');
    expect(src).toContain('answersToApply(items, { skip, kinds, canRequeue })');
    expect(src).toContain('        skip,\n');
    expect(src).toContain('answerFailures.set(r.id, failedAnswer(');
    expect(src).not.toContain('answerFailed');
    // The wiring that supervisor-answer-retry.test.mjs runs end to end.
    expect(src).toContain("else if (cmd.kind === 'answer-retry') retryAnswer(cmd.id);");
    expect(src).toContain('if (results.length) saveAnswerFailures();');
    expect(src).toContain('answerFailures.set(id, { ...failure, retryAt: now().toISOString() });');
    // The prune that supervisor-answer-retry.test.mjs runs end to end.
    expect(src).toContain('const pending = new Set(items.map((i) => i.id));');
    expect(src).toContain('for (const id of [...answerFailures.keys()]) if (!pending.has(id)) changed = answerFailures.delete(id) || changed;');
    expect(src).toContain('if (changed) saveAnswerFailures();');
  });

  it('runs the answers and the learning tick without FOREMAN_RUN, as the owner', () => {
    const src = readFileSync(new URL('./supervisor.mjs', import.meta.url), 'utf8');
    expect(src).toContain('runAsync(NODE.node(), [FOREMAN_BIN, ...args], { cwd: ROOT, env: ownerEnv(process.env), timeoutMs: 120_000, track: loopChildren })');
    // The learning tick is started in background-jobs.mjs.
    const jobs = readFileSync(new URL('./background-jobs.mjs', import.meta.url), 'utf8');
    expect(jobs).toContain('const env = ownerEnv(process.env);');
    expect(jobs).not.toContain('delete env.FOREMAN_RUN;');
  });
});

describe('applyAnswers with the real CLI', () => {
  let dir;
  const state = () => join(dir, '.foreman');
  const NOW = new Date('2026-10-23T09:00:00Z');
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-answers-'));
    writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'Acme' }, checks: [{ run: 'true', when: 'always' }], learning: { auto: false } }));
    mkdirSync(join(dir, 'stories'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const storyFile = (id, status, extra = '') => writeFileSync(join(dir, 'stories', `${id}.md`), `---\nid: ${id}\ntitle: Story ${id}\nstatus: ${status}\n${extra}---\n\n# ${id}\n\n## Progress notes\n`);
  const calls = [];
  const foreman = async (args) => {
    calls.push(args);
    let out = '';
    const status = await main(args, { cwd: dir, env: { FOREMAN_PROJECT_DIR: dir }, now: () => NOW, stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } });
    return { status, stdout: out.trim() };
  };
  const deps = () => ({ foreman, gh: () => ({ status: 1, stdout: '' }), git: () => ({ status: 1, stdout: '' }), branchPrefix: 'story/', remote: 'origin', today: '2026-10-23' });
  const line = (story, rule, extra = {}) => JSON.stringify({ at: '2026-10-15T08:00:00Z', story, result: 'failed', builder: 'developer', stage: 'review', severity: 'major', rule, where: `${story}.js`, observed: 'o', fix: 'add a test', ...extra });
  const findings = (...lines) => {
    mkdirSync(state(), { recursive: true });
    writeFileSync(join(state(), 'findings.jsonl'), `${lines.join('\n')}\n`);
  };
  // Every file under the folder, recursively.
  const filesIn = (folder) => {
    let out = [];
    try {
      for (const name of readdirSync(folder)) {
        const p = join(folder, name);
        out = statSync(p).isDirectory() ? out.concat(filesIn(p)) : out.concat(p);
      }
    } catch {
      // no folder
    }
    return out;
  };
  const countIn = (files, text) => files.reduce((n, f) => n + readFileSync(f, 'utf8').split(text).length - 1, 0);

  it('creates the follow-up story once over two passes', async () => {
    calls.length = 0;
    storyFile('ACME-1', 'done');
    const minor = (rule) => line('ACME-1', rule, { result: 'shipped', severity: 'minor', where: 'src/a.js', observed: 'no test', fix: 'add one' });
    findings(minor('Cover the empty case'), minor('Name the constant'));
    expect((await foreman(['learn'])).status).toBe(0);
    const [proposal] = decisions.pending(state());
    expect(proposal.title).toBe('Follow up on ACME-1: 2 minor finding(s)?');
    expect((await foreman(['decide', 'answer', proposal.id, 'Create a follow-up story'])).status).toBe(0);
    calls.length = 0;

    const first = await applyAnswers(decisions.pending(state()), deps());
    expect(first).toMatchObject([{ id: proposal.id, ok: true }]);
    const second = await applyAnswers(decisions.pending(state()), deps());
    expect(second).toEqual([]);

    const storyFiles = [...filesIn(join(dir, 'stories')), ...filesIn(join(state(), 'stories'))];
    expect(countIn(storyFiles, 'title: Follow-ups from ACME-1')).toBe(1);
    expect(decisions.list(state()).find((d) => d.id === proposal.id).appliedAt).toBeTruthy();
    expect(calls.filter((c) => c[0] === 'learn' && c[1] === 'apply')).toHaveLength(1);
  });

  it('closes the follow-ups Foreman created once over two passes, after Undo and close them', async () => {
    storyFile('ACME-1', 'done');
    writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'Acme' }, checks: [{ run: 'true', when: 'always' }], learning: { auto: false }, features: { autoCreateFollowUps: true } }));
    findings(line('ACME-1', 'Cover the empty case', { result: 'shipped', severity: 'minor', where: 'src/a.js' }));
    expect((await foreman(['learn'])).status).toBe(0);
    const [note] = decisions.pending(state());
    expect(note.title).toBe('Foreman created 1 follow-up story');
    expect((await foreman(['decide', 'answer', note.id, 'Undo and close them'])).status).toBe(0);
    calls.length = 0;

    expect(await applyAnswers(decisions.pending(state()), { ...deps(), kinds: EVERY_TICK })).toMatchObject([{ id: note.id, ok: true }]);
    expect(await applyAnswers(decisions.pending(state()), { ...deps(), kinds: EVERY_TICK })).toEqual([]);
    expect(calls).toEqual([['learn', 'undo', note.id]]);
    const source = openProjectStories({ root: dir, env: { FOREMAN_PROJECT_DIR: dir } });
    expect(source.list().find((s) => s.title === 'Follow-ups from ACME-1').status).toBe('done');
    expect(decisions.list(state()).find((d) => d.id === note.id).appliedAt).toBeTruthy();
  });

  it('adds the trait once over two passes', async () => {
    for (const id of ['ACME-1', 'ACME-2', 'ACME-3']) storyFile(id, 'blocked', 'blocked_by: Factory could not pass review\n');
    findings(line('ACME-1', 'Every route needs a test.'), line('ACME-2', 'every route needs a test'), line('ACME-3', 'Every route needs a test'));
    expect((await foreman(['learn'])).status).toBe(0);
    const [proposal] = decisions.pending(state());
    expect(proposal.title).toBe('Add a trait for developer: Every route needs a test?');
    expect((await foreman(['decide', 'answer', proposal.id, 'Add as a trait'])).status).toBe(0);

    expect(await applyAnswers(decisions.pending(state()), deps())).toMatchObject([{ ok: true }]);
    expect(await applyAnswers(decisions.pending(state()), deps())).toEqual([]);

    const traits = readFileSync(join(dir, '.claude', 'foreman', 'traits', 'developer.md'), 'utf8');
    expect(traits.split('Every route needs a test').length - 1).toBe(1);
    expect(decisions.list(state()).find((d) => d.id === proposal.id).appliedAt).toBeTruthy();
  });

  it('a review decision with hints is still applied by the supervisor', async () => {
    storyFile('ACME-1', 'blocked', 'blocked_by: Factory could not pass review; nothing was built\n');
    const added = await foreman([
      'decide', 'add', '--story', 'ACME-1', '--kind', 'decision', '--title', 'ACME-1 could not pass review', '--summary', 'One blocker open.',
      '--option', 'Retry with a note to the architect', '--hint', 'Sends the story back to be designed and built again, with your note.',
      '--option', "I'll take it", '--hint', 'You take the story over; the run leaves it alone until you hand it back.',
      '--option', 'Drop', '--hint', "Closes the story's pull requests, deletes its branch and blocks it.",
      '--recommend', 'Retry with a note to the architect',
    ]);
    expect(added.status).toBe(0);
    const id = added.stdout;
    expect((await foreman(['decide', 'answer', id, 'Retry with a note to the architect', '--note', 'Use the cache'])).status).toBe(0);
    const [answered] = decisions.pending(state());
    expect(answered).toMatchObject({ id, summary: 'One blocker open.', recommend: 'Retry with a note to the architect' });
    expect(answered.hints).toHaveLength(3);
    expect(supervisorApplies(answered)).toBe(true);

    expect(await applyAnswers(decisions.pending(state()), deps())).toMatchObject([{ id, ok: true }]);
    const notes = [...filesIn(join(dir, 'stories')), ...filesIn(join(state(), 'stories'))].map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(notes).toContain('Note for the architect: Use the cache');
    expect(decisions.list(state()).find((d) => d.id === id).appliedAt).toBeTruthy();
  });

  it('leaves the nothing-to-build and architect questions to the sessions without canRequeue', async () => {
    storyFile('ACME-1', 'blocked', 'blocked_by: Nothing to build\n');
    storyFile('ACME-2', 'blocked', 'blocked_by: Which store\n');
    const close = await foreman([
      'decide', 'add', '--story', 'ACME-1', '--kind', 'decision', '--title', 'Close ACME-1: nothing to build?', '--summary', 'The login already works.',
      '--option', 'Close it as Done', '--hint', "Marks the story done without building it; the architect's evidence is the note.",
      '--option', 'Build it anyway', '--hint', 'Sends the story back to be designed and built, with your note.',
      '--recommend', 'Close it as Done',
    ]);
    const choose = await foreman([
      'decide', 'add', '--story', 'ACME-2', '--kind', 'decision', '--title', 'Decide for ACME-2: Which store keeps the sessions?', '--summary', 'The plan names no store.',
      '--option', 'The database', '--hint', 'Keeps them with the rest of the data.',
      '--option', 'The cache', '--hint', 'Faster, but lost on restart.',
      '--recommend', 'The database',
    ]);
    expect([close.status, choose.status]).toEqual([0, 0]);
    await foreman(['decide', 'answer', close.stdout, 'Close it as Done']);
    await foreman(['decide', 'answer', choose.stdout, 'The cache', '--note', 'Speed matters']);
    const items = decisions.pending(state());
    expect(items).toHaveLength(2);
    for (const it of items) expect(supervisorApplies(it), it.title).toBe(false);

    calls.length = 0;
    expect(await applyAnswers(items, deps())).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('closes the nothing-to-build story and puts the architect question back, with canRequeue from the stories', async () => {
    storyFile('ACME-1', 'blocked', 'blocked_by: Nothing to build\n');
    storyFile('ACME-2', 'blocked', 'blocked_by: Which store\n');
    const close = await foreman([
      'decide', 'add', '--story', 'ACME-1', '--kind', 'decision', '--title', 'Close ACME-1: nothing to build?', '--summary', 'The login already works.', '--body', 'The login already works',
      '--option', 'Close it as Done', '--option', 'Build it anyway', '--recommend', 'Close it as Done',
    ]);
    const choose = await foreman([
      'decide', 'add', '--story', 'ACME-2', '--kind', 'decision', '--title', 'Decide for ACME-2: Which store keeps the sessions?', '--summary', 'The plan names no store.',
      '--option', 'The database', '--option', 'The cache', '--recommend', 'The database',
    ]);
    expect([close.status, choose.status]).toEqual([0, 0]);
    await foreman(['decide', 'answer', close.stdout, 'Close it as Done']);
    await foreman(['decide', 'answer', choose.stdout, 'The cache', '--note', 'Speed matters']);
    const items = decisions.pending(state());
    for (const it of items) expect(supervisorApplies(it), it.title).toBe(false);

    const canRequeue = (id) => {
      const source = openProjectStories({ root: dir, env: { FOREMAN_PROJECT_DIR: dir } });
      return waitsForAnswer(source.list().find((s) => s.id === id), { idPattern: source.idPattern });
    };
    const out = await applyAnswers(items, { ...deps(), canRequeue });
    expect(out.map((x) => [x.id, x.ok]).sort()).toEqual([[close.stdout, true], [choose.stdout, true]].sort());

    const source = openProjectStories({ root: dir, env: { FOREMAN_PROJECT_DIR: dir } });
    const byId = new Map(source.list().map((s) => [s.id, s]));
    expect(byId.get('ACME-1').status).toBe('done');
    expect(byId.get('ACME-2').status).toBe('todo');
    const notes = (id) => [...filesIn(join(dir, 'stories')), ...filesIn(join(state(), 'stories'))].filter((f) => f.includes(id)).map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(notes('ACME-1')).toContain('Closed by the owner: nothing to build. The login already works');
    expect(notes('ACME-2')).toContain('with \\"The cache\\". Speed matters');
    expect(decisions.pending(state())).toEqual([]);
  });

  describe('a learned-change note', () => {
    const TRAIT = { kind: 'trait', roles: ['developer'], text: 'Acme: test every route.' };
    const roleFile = () => join(state(), 'learned', 'traits', 'developer.md');
    const answerUndo = async (id) => expect((await foreman(['decide', 'answer', id, 'Undo the change'])).status).toBe(0);

    it('added by a story session with `foreman decide add` is refused, and changes nothing', async () => {
      expect(addItem(state(), TRAIT, { now: new Date('2026-10-23T08:00:00Z') })).toMatchObject({ ok: true, id: 'L-1' });
      const added = await foreman(['decide', 'add', '--story', 'ACME-1', '--kind', 'decision', '--title', 'Foreman learned L-1 for developer', '--option', 'Undo the change', '--option', 'Keep the change']);
      expect(added.status).toBe(0);
      const id = added.stdout;
      await answerUndo(id);
      const ledger = readFileSync(join(state(), 'learning.jsonl'), 'utf8');
      const role = readFileSync(roleFile(), 'utf8');

      calls.length = 0;
      const out = await applyAnswers(decisions.pending(state()), deps());
      expect(out).toMatchObject([{ id, ok: false }]);
      expect(out[0].text.startsWith('Could not apply your answer to "Foreman learned L-1 for developer"')).toBe(true);
      expect(readLedger(state()).some((l) => l.action === 'undo')).toBe(false);
      expect(readFileSync(join(state(), 'learning.jsonl'), 'utf8')).toBe(ledger);
      expect(readFileSync(roleFile(), 'utf8')).toBe(role);
      expect(role).toContain('[L-1]');
      expect(decisions.list(state()).find((d) => d.id === id).appliedAt).toBeNull();
    });

    it('that Foreman added at the time of its change is applied', async () => {
      const T = new Date('2026-10-23T08:00:00Z');
      addItem(state(), TRAIT, { now: T });
      const id = decisions.add(state(), { story: 'ACME-1', kind: 'decision', title: 'Foreman learned L-1 for developer', options: ['Undo the change', 'Keep the change'] }, T);
      await answerUndo(id);
      const out = await applyAnswers(decisions.pending(state()), deps());
      expect(out).toMatchObject([{ id, ok: true }]);
      expect(readLedger(state()).at(-1)).toMatchObject({ action: 'undo', id: 'L-1', by: 'owner' });
      expect(decisions.list(state()).find((d) => d.id === id).appliedAt).toBeTruthy();
    });

    describe('whose version was replaced since', () => {
      const T1 = new Date('2026-10-23T08:00:00Z');
      const T2 = new Date('2026-10-23T08:30:00Z');
      const ledgerText = () => readFileSync(join(state(), 'learning.jsonl'), 'utf8');
      const setup = () => {
        addItem(state(), TRAIT, { now: T1 });
        const id1 = decisions.add(state(), { story: 'ACME-1', kind: 'decision', title: 'Foreman learned L-1 for developer', options: ['Undo the change', 'Keep the change'] }, T1);
        updateItem(state(), 'L-1', { text: 'Acme: test every route and its errors.' }, { now: T2, by: 'foreman' });
        const id2 = decisions.add(state(), { story: 'ACME-1', kind: 'decision', title: 'Foreman changed L-1 for developer', options: ['Undo the change', 'Keep the change'] }, T2);
        return { id1, id2 };
      };
      const appliedAt = (id) => decisions.list(state()).find((d) => d.id === id).appliedAt;
      const didNotUndo = () => decisions.list(state()).filter((d) => d.title === 'Foreman did not undo L-1 for developer');

      it('both answered Keep the change: both apply, one keep line at v2, nothing left to retry', async () => {
        const { id1, id2 } = setup();
        for (const id of [id1, id2]) expect((await foreman(['decide', 'answer', id, 'Keep the change'])).status).toBe(0);
        const before = readLedger(state()).length;
        const out = await applyAnswers(decisions.pending(state()), { ...deps(), kinds: EVERY_TICK });
        expect(out).toHaveLength(2);
        expect(out).toEqual(expect.arrayContaining([expect.objectContaining({ id: id1, ok: true }), expect.objectContaining({ id: id2, ok: true })]));
        const added = readLedger(state()).slice(before);
        expect(added).toHaveLength(1);
        expect(added[0]).toMatchObject({ action: 'keep', v: 2, by: 'owner' });
        expect(readLedger(state()).some((l) => l.action === 'undo')).toBe(false);
        expect(appliedAt(id1)).toBeTruthy();
        expect(appliedAt(id2)).toBeTruthy();
        expect(await applyAnswers(decisions.pending(state()), { ...deps(), kinds: EVERY_TICK })).toEqual([]);
        expect(readFileSync(join(state(), 'events.jsonl'), 'utf8')).toContain('L-1 v1 was replaced by v2 since; its own note covers it.');
      });

      it('the old note answered Undo the change leaves v2, is applied, and raises one Got-it note', async () => {
        const { id1, id2 } = setup();
        await answerUndo(id1);
        const ledger = ledgerText();
        const role = readFileSync(roleFile(), 'utf8');
        const out = await applyAnswers(decisions.pending(state()), { ...deps(), kinds: EVERY_TICK });
        expect(out).toMatchObject([{ id: id1, ok: true }]);
        expect(out).toHaveLength(1);
        expect(ledgerText()).toBe(ledger);
        expect(readLedger(state()).some((l) => l.action === 'undo')).toBe(false);
        expect(readFileSync(roleFile(), 'utf8')).toBe(role);
        expect(role).toContain('every route and its errors');
        expect(appliedAt(id1)).toBeTruthy();
        const waiting = decisions.pending(state()).find((d) => d.id === id2);
        expect(waiting).toBeTruthy();
        expect(waiting.answer).toBeNull();
        expect(didNotUndo()).toHaveLength(1);
        expect(didNotUndo()[0]).toMatchObject({ story: 'ACME-1', options: ['Got it'] });

        expect(await applyAnswers(decisions.pending(state()), { ...deps(), kinds: EVERY_TICK })).toEqual([]);
        expect(didNotUndo()).toHaveLength(1);

        const note = didNotUndo()[0];
        expect((await foreman(['decide', 'answer', note.id, 'Got it'])).status).toBe(0);
        calls.length = 0;
        const last = await applyAnswers(decisions.pending(state()), { ...deps(), kinds: EVERY_TICK });
        expect(last).toMatchObject([{ id: note.id, ok: true }]);
        expect(calls).toEqual([['decide', 'applied', note.id]]);
      });

      it('a note added by `foreman decide add` is still refused, and the ledger is unchanged', async () => {
        addItem(state(), TRAIT, { now: T1 });
        updateItem(state(), 'L-1', { text: 'Acme: test every route and its errors.' }, { now: T2, by: 'foreman' });
        const added = await foreman(['decide', 'add', '--story', 'ACME-1', '--kind', 'decision', '--title', 'Foreman learned L-1 for developer', '--option', 'Undo the change', '--option', 'Keep the change']);
        expect(added.status).toBe(0);
        const id = added.stdout;
        expect((await foreman(['decide', 'answer', id, 'Keep the change'])).status).toBe(0);
        const ledger = ledgerText();
        const out = await applyAnswers(decisions.pending(state()), { ...deps(), kinds: EVERY_TICK });
        expect(out).toMatchObject([{ id, ok: false }]);
        expect(ledgerText()).toBe(ledger);
        expect(appliedAt(id)).toBeNull();
      });
    });
  });

  it('runs nothing for an answer a session already applied', async () => {
    storyFile('ACME-1', 'blocked', 'blocked_by: Factory could not pass review; nothing was built\n');
    const id = decisions.add(state(), { story: 'ACME-1', kind: 'decision', title: 'ACME-1 could not pass review', options: REVIEW }, NOW);
    decisions.answer(state(), id, { option: 'Retry with a note to the architect', note: 'Use the cache' }, NOW);
    decisions.applied(state(), id, NOW);
    expect(decisions.pending(state())).toEqual([]);

    calls.length = 0;
    const before = readFileSync(join(dir, 'stories', 'ACME-1.md'), 'utf8');
    expect(await applyAnswers(decisions.list(state()), deps())).toEqual([]);
    expect(calls).toEqual([]);
    expect(readFileSync(join(dir, 'stories', 'ACME-1.md'), 'utf8')).toBe(before);
    expect(filesIn(join(state(), 'stories')).some((f) => readFileSync(f, 'utf8').includes('Note for the architect'))).toBe(false);
  });
});

describe('answersToApply', () => {
  const yes = () => true;
  const no = () => false;

  it('gives each item the supervisor applies with its kind, in order', () => {
    const a = review('Drop');
    const b = depends('Apply');
    expect(answersToApply([a, b], {}).map((t) => [t.item, t.kind])).toEqual([
      [a, 'review'],
      [b, 'depends'],
    ]);
  });

  it('leaves out the skipped ids and any kind not asked for', () => {
    const a = review('Drop');
    const b = depends('Apply');
    expect(answersToApply([a, b], { skip: new Set([a.id]) }).map((t) => t.item)).toEqual([b]);
    expect(answersToApply([a, b], { kinds: ['depends'] }).map((t) => t.item)).toEqual([b]);
    expect(answersToApply([a, b], { kinds: null }).map((t) => t.item)).toEqual([a, b]);
  });

  it('leaves out a story answer canRequeue refuses, and keeps it when it agrees', () => {
    const t = task('(A) fresh');
    expect(answersToApply([t], { canRequeue: no })).toEqual([]);
    expect(answersToApply([t], {})).toEqual([]);
    expect(answersToApply([t], { canRequeue: yes })).toEqual([{ item: t, kind: 'answer' }]);
  });

  it('keeps a closed task whatever canRequeue says', () => {
    const c = closed('handled');
    expect(answersToApply([c], { canRequeue: no })).toEqual([{ item: c, kind: 'closeTask' }]);
    expect(answersToApply([c], {})).toEqual([{ item: c, kind: 'closeTask' }]);
  });

  it('leaves out unanswered and unknown items', () => {
    expect(answersToApply([item({ answered: false })], {})).toEqual([]);
  });
});

describe('applyAnswers onItem and delayed runners', () => {
  it('calls onItem once before each applied item first step, never for a skipped or refused item', async () => {
    const order = [];
    const make = (name) => (args) => {
      order.push([name, ...args].join(' '));
      return { status: 0, stdout: '' };
    };
    const a = review('Drop');
    const skipped = review("I'll take it");
    const refused = task('(A) fresh');
    const seen = [];
    await applyAnswers([a, skipped, refused], {
      foreman: make('foreman'),
      gh: (args) => (order.push(['gh', ...args].join(' ')), { status: 0, stdout: '[]' }),
      git: make('git'),
      branchPrefix: 'story/',
      remote: 'origin',
      today: '2026-10-23',
      skip: new Set([skipped.id]),
      onItem: (it) => (seen.push(it.id), order.push('onItem')),
    });
    expect(seen).toEqual([a.id]);
    expect(order[0]).toBe('onItem');
    expect(order.filter((l) => l === 'onItem')).toHaveLength(1);
  });

  it('ignores a throw in onItem and still applies the item', async () => {
    const r = runners();
    const it1 = review('Retry with a note to the architect', 'x');
    const out = await applyAnswers([it1], { ...r.deps, onItem: () => { throw new Error('nope'); } });
    expect(out[0].ok).toBe(true);
    expect(r.calls).toHaveLength(2);
  });

  it('keeps the step order with runners that answer later', async () => {
    const calls = [];
    const later = (name, answer) => (args) =>
      new Promise((resolve) => {
        setTimeout(() => {
          calls.push([name, ...args].join(' '));
          resolve(answer(args));
        }, 5);
      });
    const it1 = review('Drop');
    const [res] = await applyAnswers([it1], {
      foreman: later('foreman', () => ({ status: 0, stdout: '' })),
      gh: later('gh', () => ({ status: 0, stdout: '[{"number":12}]' })),
      git: later('git', () => ({ status: 0, stdout: '' })),
      branchPrefix: 'story/',
      remote: 'origin',
      today: '2026-10-23',
    });
    expect(calls).toEqual([
      'gh pr list --head story/acme-1 --state open --json number',
      'gh pr close 12',
      'git push origin --delete story/acme-1',
      'foreman story block ACME-1 --reason Dropped by the owner on 2026-10-23',
      `foreman decide applied ${it1.id}`,
    ]);
    expect(res.ok).toBe(true);
  });
});

describe('a failed answer is tried again after a growing wait', () => {
  const MIN = 60_000;
  const NOW = Date.parse('2026-11-01T09:00:00Z');
  const result = { id: 'd-1', story: 'ACME-1', title: 'ACME-1: which store?', ok: false, step: 'putting ACME-1 back to todo', text: 'x' };

  it('waits 1, 2, 5, 15 and 30 minutes, then 30 again', () => {
    expect(ANSWER_RETRY_MS).toEqual([1, 2, 5, 15, 30].map((m) => m * MIN));
    expect([1, 2, 3, 4, 5, 6, 40].map(answerRetryMs)).toEqual([1, 2, 5, 15, 30, 30, 30].map((m) => m * MIN));
  });

  it('the first failure counts one try and sets when to try again', () => {
    expect(failedAnswer(undefined, result, NOW)).toEqual({
      id: 'd-1',
      story: 'ACME-1',
      title: 'ACME-1: which store?',
      step: 'putting ACME-1 back to todo',
      tries: 1,
      at: new Date(NOW).toISOString(),
      retryAt: new Date(NOW + MIN).toISOString(),
    });
  });

  it('each later failure adds a try, keeps the first time and waits longer', () => {
    const first = failedAnswer(undefined, result, NOW);
    const second = failedAnswer(first, { ...result, step: 'marking it applied' }, NOW + 2 * MIN);
    expect(second).toMatchObject({ tries: 2, at: first.at, step: 'marking it applied', retryAt: new Date(NOW + 2 * MIN + 2 * MIN).toISOString() });
    const third = failedAnswer(second, result, NOW + 10 * MIN);
    expect(third).toMatchObject({ tries: 3, at: first.at, retryAt: new Date(NOW + 10 * MIN + 5 * MIN).toISOString() });
  });

  it('skips only the ids that are not yet due', () => {
    const failures = new Map([
      ['d-wait', { retryAt: new Date(NOW + MIN).toISOString() }],
      ['d-due', { retryAt: new Date(NOW).toISOString() }],
      ['d-past', { retryAt: new Date(NOW - MIN).toISOString() }],
      ['d-odd', { retryAt: 'not a time' }],
    ]);
    expect([...answerSkips(failures, NOW)]).toEqual(['d-wait']);
    expect(answerSkips(new Map(), NOW).size).toBe(0);
  });

  it('a due failure is applied again, and one not due is left out', () => {
    const due = { ...item({ story: 'ACME-1', title: 'ACME-1: which store?', options: [], kind: 'task', option: null, note: 'use it' }) };
    const waiting = { ...item({ story: 'ACME-2', title: 'ACME-2: which store?', options: [], kind: 'task', option: null, note: 'use it' }) };
    const failures = new Map([[waiting.id, { retryAt: new Date(NOW + MIN).toISOString() }], [due.id, { retryAt: new Date(NOW - MIN).toISOString() }]]);
    const todo = answersToApply([due, waiting], { skip: answerSkips(failures, NOW), canRequeue: () => true });
    expect(todo.map((t) => t.item.id)).toEqual([due.id]);
  });
});

describe('the release decision ("<ID> could not be released")', () => {
  const RELEASE = ['Retry the release', "I'll take it", 'Drop'];
  const release = (option, note = '', story = 'ACME-1') => item({ story, title: releaseTitle(story), options: RELEASE, option, note });

  it('has the title, the options and the note the story skill uses', () => {
    expect(releaseTitle('ACME-1')).toBe('ACME-1 could not be released');
    expect(OPTIONS.release).toEqual(RELEASE);
    expect(RELEASE_RETRY_NOTE).toBe('The owner asked to retry the release: resume from the built branch and ship it again.');
  });

  it("kindOf is release for the item's own story only", () => {
    expect(kindOf({ story: 'ACME-1', title: 'ACME-1 could not be released' })).toBe('release');
    expect(kindOf({ story: 'ACME-1', title: 'ACME-9 could not be released' })).toBeNull();
  });

  it('supervisorApplies each of its options, and nothing a review has not', () => {
    for (const option of RELEASE) expect(supervisorApplies(release(option))).toBe(true);
    expect(supervisorApplies(release('Retry with a note to the architect'))).toBe(false);
    expect(supervisorApplies(item({ options: [...REVIEW, 'Retry the release'], option: 'Retry the release' }))).toBe(false);
  });

  it('requeueKind gives null, so the every-tick path never applies it', () => {
    for (const option of RELEASE) expect(requeueKind(release(option))).toBeNull();
    expect(answersToApply([release('Drop')], { kinds: EVERY_TICK, canRequeue: () => true })).toEqual([]);
  });

  it('Retry the release puts the story back to todo with the retry note, then marks it applied', async () => {
    const r = runners();
    const it1 = release('Retry the release');
    const out = await applyAnswers([it1], r.deps);
    expect(r.calls).toEqual([
      ['foreman', 'story', 'todo', 'ACME-1', '--note', RELEASE_RETRY_NOTE],
      ['foreman', 'decide', 'applied', it1.id],
    ]);
    expect(out).toEqual([{ id: it1.id, story: 'ACME-1', title: 'ACME-1 could not be released', ok: true, text: 'Applied your answer to "ACME-1 could not be released": Retry the release.' }]);
  });

  it("Retry the release adds the owner's note for the architect, on one line", async () => {
    const r = runners();
    await applyAnswers([release('Retry the release', ' CI is\n back ')], r.deps);
    expect(r.calls[0]).toEqual(['foreman', 'story', 'todo', 'ACME-1', '--note', RELEASE_RETRY_NOTE + ' Note for the architect: CI is back']);
  });

  it("I'll take it claims the story for the owner and blocks it", async () => {
    const r = runners();
    const it1 = release("I'll take it");
    await applyAnswers([it1], r.deps);
    expect(r.calls).toEqual([
      ['foreman', 'lock', 'owner-claim', 'ACME-1'],
      ['foreman', 'story', 'block', 'ACME-1', '--reason', 'Taken by the owner'],
      ['foreman', 'decide', 'applied', it1.id],
    ]);
  });

  it('Drop closes the pull requests, deletes the branch and blocks the story', async () => {
    const r = runners({ 'gh pr list': { status: 0, stdout: '[{"number":7}]' } });
    const it1 = release('Drop');
    const [res] = await applyAnswers([it1], r.deps);
    expect(r.calls).toEqual([
      ['gh', 'pr', 'list', '--head', 'story/acme-1', '--state', 'open', '--json', 'number'],
      ['gh', 'pr', 'close', '7'],
      ['git', 'push', 'origin', '--delete', 'story/acme-1'],
      ['foreman', 'story', 'block', 'ACME-1', '--reason', 'Dropped by the owner on 2026-10-23'],
      ['foreman', 'decide', 'applied', it1.id],
    ]);
    expect(res.ok).toBe(true);
  });

  it('Drop fails, and changes nothing more, when the pull requests cannot be listed', async () => {
    const r = runners({ 'gh pr list': { status: 1, stdout: '' } });
    const [res] = await applyAnswers([release('Drop')], r.deps);
    expect(res.ok).toBe(false);
    expect(r.calls.some((c) => c[1] === 'story' || c[1] === 'decide')).toBe(false);
  });
});

describe('failedStoryOf', () => {
  it('reads the id from both failed-story titles', () => {
    expect(failedStoryOf('ACME-1 could not pass review')).toBe('ACME-1');
    expect(failedStoryOf('ACME-4 could not be released')).toBe('ACME-4');
  });

  it('is null for any other title', () => {
    for (const title of ['Which login?', 'ACME-1 could not ship', '', undefined]) expect(failedStoryOf(title), String(title)).toBeNull();
  });
});
