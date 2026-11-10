import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { confirmedResult, parkFile, parkStory, parkWatchDue, READY, readPark, readParks, removePark, savePark, sessionResult, UNPARKED, watchParks } from './parks.mjs';
import { openStorySource } from './story-source.mjs';

let root;
let dir;
const config = { version: 1, project: { name: 'Acme' }, stories: { adapter: 'markdown', dir: 'stories' } };
const env = {};
const T = new Date(2026, 9, 23, 12, 0, 0);
const now = () => T;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'foreman-parks-'));
  dir = join(root, '.foreman');
  mkdirSync(join(root, 'stories'));
  writeFileSync(join(root, 'stories', 'S-1.md'), '---\nid: S-1\ntitle: Sign in to Acme\nstatus: in-progress\n---\n\n# S-1\n\n## Progress notes\n\n_Newest first._\n');
  writeFileSync(join(root, 'stories', 'S-2.md'), '---\nid: S-2\ntitle: Sign out of Acme\nstatus: todo\n---\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const park = (over = {}) => ({ id: 'S-1', step: 'acme-promote', reason: 'click Promote', check: { deployId: 'D-1' }, parkedAt: '2026-10-23T11:00:00.000Z', ...over });
const events = () => readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

describe('the ready status', () => {
  it('is ready-to-promote', () => expect(READY).toBe('ready-to-promote'));
});

describe('savePark and readPark', () => {
  it('writes parks/<id>.json with exactly the record, and reads it back', () => {
    const record = savePark(dir, park({ pr: 'https://github.com/acme/app/pull/1', slot: 'w1' }));
    const want = { id: 'S-1', step: 'acme-promote', reason: 'click Promote', check: { deployId: 'D-1' }, pr: 'https://github.com/acme/app/pull/1', slot: 'w1', parkedAt: '2026-10-23T11:00:00.000Z' };
    expect(record).toEqual(want);
    expect(parkFile(dir, 'S-1')).toBe(join(dir, 'parks', 'S-1.json'));
    const text = readFileSync(join(dir, 'parks', 'S-1.json'), 'utf8');
    expect(text).toBe(`${JSON.stringify(want, null, 2)}\n`);
    expect(readPark(dir, 'S-1')).toEqual(want);
  });

  it('gives pr and slot null when not given', () => {
    expect(savePark(dir, park())).toMatchObject({ pr: null, slot: null });
  });

  it('readPark is null for a story with no park', () => {
    expect(readPark(dir, 'S-9')).toBeNull();
  });

  it.each([
    ['a missing id', { id: '' }],
    ['a missing step', { step: '' }],
    ['a missing reason', { reason: undefined }],
    ['a missing check', { check: undefined }],
    ['a check that is not an object', { check: 'D-1' }],
    ['a check that is a list', { check: ['D-1'] }],
  ])('throws for %s', (_, over) => {
    expect(() => savePark(dir, park(over))).toThrow();
    expect(existsSync(join(dir, 'parks'))).toBe(false);
  });
});

describe('readParks', () => {
  it('reads straight from disk, sorted by parkedAt then id, skipping corrupt and temp files', () => {
    savePark(dir, park({ id: 'S-3', parkedAt: '2026-10-23T12:00:00.000Z' }));
    savePark(dir, park({ id: 'S-2', parkedAt: '2026-10-23T10:00:00.000Z' }));
    savePark(dir, park({ id: 'S-1', parkedAt: '2026-10-23T12:00:00.000Z' }));
    writeFileSync(join(dir, 'parks', 'S-4.json'), '{ not json');
    writeFileSync(join(dir, 'parks', 'S-5.json.1.2.tmp'), JSON.stringify(park({ id: 'S-5' })));
    expect(readParks(dir).map((p) => p.id)).toEqual(['S-2', 'S-1', 'S-3']);
  });

  it('is empty when there is no parks folder', () => {
    expect(readParks(dir)).toEqual([]);
    expect(readParks(join(root, 'nowhere'))).toEqual([]);
  });
});

describe('parkStory', () => {
  const ctx = () => ({ dir, root, config, env, now, slot: 'w1' });

  it('marks the story ready-to-promote with one note, saves the park and adds a good event', async () => {
    const answer = await parkStory(ctx(), { id: 'S-1', step: 'acme-promote', reason: 'click Promote', check: { deployId: 'D-1' }, pr: 'https://github.com/acme/app/pull/1' });
    expect(answer).toEqual({ parkSaved: true, storyUpdated: true });
    const source = openStorySource({ root, config, now, env });
    expect(Object.fromEntries(source.list().map((s) => [s.id, s.status]))).toEqual({ 'S-1': 'ready-to-promote', 'S-2': 'todo' });
    const dated = readFileSync(source.brief('S-1').path, 'utf8').split('\n').filter((l) => /^- \*\*\d{4}-\d{2}-\d{2}\*\* — /.test(l));
    expect(dated).toEqual(['- **2026-10-23** — ready to promote: click Promote']);
    expect(readPark(dir, 'S-1')).toEqual({ id: 'S-1', step: 'acme-promote', reason: 'click Promote', check: { deployId: 'D-1' }, pr: 'https://github.com/acme/app/pull/1', slot: 'w1', parkedAt: T.toISOString() });
    expect(events()).toEqual([{ at: T.toISOString(), text: 'S-1 is ready to promote: click Promote', kind: 'good', slot: 'w1' }]);
  });

  it('for an unknown id says the story was not updated, still saves the park, and does not throw', async () => {
    const answer = await parkStory(ctx(), { id: 'S-9', step: 'acme-promote', reason: 'click Promote', check: {} });
    expect(answer).toMatchObject({ parkSaved: true, storyUpdated: false });
    expect(readPark(dir, 'S-9')).toMatchObject({ id: 'S-9', step: 'acme-promote' });
  });

  it('when the park cannot be written says parkSaved false with the error, and does not throw', async () => {
    const file = join(root, 'a-file');
    writeFileSync(file, 'x');
    const answer = await parkStory({ ...ctx(), dir: file }, { id: 'S-1', step: 'acme-promote', reason: 'click Promote', check: { deployId: 'D-1' } });
    expect(answer.parkSaved).toBe(false);
    expect(typeof answer.parkError).toBe('string');
    expect(answer.parkError).not.toBe('');
  });

  it('when the story source cannot be opened says storyUpdated false with the error, and does not throw', async () => {
    const answer = await parkStory({ ...ctx(), config: { ...config, stories: { adapter: 'nowhere' } } }, { id: 'S-1', step: 'acme-promote', reason: 'click Promote', check: {} });
    expect(answer).toMatchObject({ parkSaved: true, storyUpdated: false });
    expect(answer.storyError).toMatch(/nowhere/);
  });
});

describe('savePark with lastCheck, and removePark', () => {
  it('stores lastCheck when given, and leaves the record with exactly the old keys when not', () => {
    const lastCheck = { at: T.toISOString(), outcome: 'waiting', detail: 'still in review' };
    expect(savePark(dir, park({ lastCheck }))).toMatchObject({ lastCheck });
    expect(readPark(dir, 'S-1').lastCheck).toEqual(lastCheck);
    savePark(dir, park());
    expect(Object.keys(readPark(dir, 'S-1'))).toEqual(['id', 'step', 'reason', 'check', 'pr', 'slot', 'parkedAt']);
  });

  it('removePark deletes the file, and removing a missing park does not throw', () => {
    savePark(dir, park());
    removePark(dir, 'S-1');
    expect(existsSync(parkFile(dir, 'S-1'))).toBe(false);
    expect(() => removePark(dir, 'S-1')).not.toThrow();
    expect(() => removePark(join(root, 'nowhere'), 'S-9')).not.toThrow();
  });
});

describe('watchParks', () => {
  const statusOf = (id) => openStorySource({ root, config, now, env }).list().find((s) => s.id === id);
  // The story as Foreman sees it: the note with what state holds for it on top.
  const storyText = (id) => readFileSync(openStorySource({ root, config, now, env }).brief(id).path, 'utf8');
  const dated = (id) => storyText(id).split('\n').filter((l) => /^- \*\*\d{4}-\d{2}-\d{2}\*\* — /.test(l));
  const readEvents = () => (existsSync(join(dir, 'events.jsonl')) ? events() : []);
  const parkS1 = async (over = {}) => {
    await parkStory({ dir, root, config, env, now, slot: 'w1' }, { id: 'S-1', step: 'acme-promote', reason: 'click Promote', check: { deployId: 'D-1' }, pr: 'https://github.com/acme/app/pull/1', ...over });
    rmSync(join(dir, 'events.jsonl'), { force: true });
  };
  const watch = (table, ctxFor = (p) => ({ check: p.check, park: p, story: p.id, slot: p.slot, pr: p.pr })) => watchParks({ dir, root, config, env, now, table, ctxFor });
  const stepWith = (check) => ({ 'acme-promote': { name: 'acme-promote', run: async () => ({ ok: true }), check } });

  it('moves a finished release to done with a dated note, removes the park and adds a good event', async () => {
    await parkS1();
    const { results } = await watch(stepWith(async () => ({ ok: true, done: true, note: 'promoted to Acme production' })));
    expect(results).toEqual([expect.objectContaining({ id: 'S-1', step: 'acme-promote', outcome: 'done' })]);
    expect(statusOf('S-1').status).toBe('done');
    expect(storyText('S-1')).toMatch(/^completed: 2026-10-23$/m);
    expect(dated('S-1')[0]).toBe('- **2026-10-23** — Released: promoted to Acme production');
    expect(readPark(dir, 'S-1')).toBeNull();
    expect(readEvents()).toEqual([{ at: T.toISOString(), text: 'S-1 shipped: the release finished', kind: 'good', slot: 'w1' }]);
  });

  it('uses the park reason in the note when the check gives no note', async () => {
    await parkS1();
    await watch(stepWith(async () => ({ ok: true, done: true })));
    expect(dated('S-1')[0]).toBe('- **2026-10-23** — Released: click Promote');
  });

  it.each([
    ['plain ok', { ok: true }, undefined],
    ['done false with a detail', { ok: true, done: false, detail: 'still in review' }, 'still in review'],
  ])('keeps a waiting release (%s) with its lastCheck, and adds no event', async (_, answer, detail) => {
    await parkS1();
    const { results } = await watch(stepWith(async () => answer));
    expect(results[0]).toMatchObject({ id: 'S-1', outcome: 'waiting' });
    expect(statusOf('S-1').status).toBe(READY);
    const kept = readPark(dir, 'S-1');
    expect(kept).toMatchObject({ id: 'S-1', check: { deployId: 'D-1' }, lastCheck: { at: T.toISOString(), outcome: 'waiting' } });
    expect(kept.lastCheck.detail).toBe(detail);
    expect(readEvents()).toEqual([]);
  });

  it('blocks a release that failed hard, removes the park, adds a warn event and writes no HALT', async () => {
    await parkS1();
    const { results } = await watch(stepWith(async () => ({ ok: false, reason: 'Acme refused the promotion' })));
    expect(results[0]).toMatchObject({ id: 'S-1', outcome: 'failed', detail: 'Acme refused the promotion' });
    const s = statusOf('S-1');
    expect(s.status).toBe('blocked');
    expect(s.blockedBy).toBe('Acme refused the promotion');
    expect(dated('S-1')[0]).toBe('- **2026-10-23** — Release failed: Acme refused the promotion');
    expect(readPark(dir, 'S-1')).toBeNull();
    expect(readEvents()).toEqual([expect.objectContaining({ text: 'S-1 release failed: Acme refused the promotion', kind: 'warn' })]);
    expect(existsSync(join(dir, 'HALT'))).toBe(false);
  });

  it('keeps the park and reports an error when a finished release cannot be moved to Done', async () => {
    savePark(dir, park({ id: 'S-9' }));
    const { results } = await watch(stepWith(async () => ({ ok: true, done: true })));
    const detail = 'the release finished but S-9 could not be moved to Done';
    expect(results[0]).toMatchObject({ id: 'S-9', outcome: 'error', detail });
    expect(readPark(dir, 'S-9')).toMatchObject({ lastCheck: { at: T.toISOString(), outcome: 'error', detail } });
    const seen = readEvents();
    expect(seen.filter((e) => e.kind === 'good')).toEqual([]);
    const warns = seen.filter((e) => e.kind === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0].text).toContain('could not be moved to Done');
  });

  it('keeps the park and reports an error when a failed release cannot be blocked', async () => {
    savePark(dir, park({ id: 'S-9' }));
    const table = stepWith(async () => ({ ok: false, reason: 'Acme refused the promotion' }));
    const { results } = await watch(table);
    expect(results[0]).toMatchObject({ id: 'S-9', outcome: 'error', detail: 'the release failed but S-9 could not be blocked: Acme refused the promotion' });
    expect(readPark(dir, 'S-9')).toMatchObject({ id: 'S-9', lastCheck: { at: T.toISOString(), outcome: 'error' } });
    expect(readEvents().some((e) => e.text.includes('release failed:'))).toBe(false);
    expect(readEvents().filter((e) => e.kind === 'warn')).toHaveLength(1);
    await watch(table);
    expect(readEvents().filter((e) => e.kind === 'warn')).toHaveLength(1);
    expect(readPark(dir, 'S-9')).toMatchObject({ lastCheck: { outcome: 'error' } });
  });

  it.each([
    ['finished', { ok: true, done: true }],
    ['failed', { ok: false, reason: 'x' }],
  ])('keeps the park and leaves the story alone when the story source throws (%s)', async (_, answer) => {
    await parkS1();
    const before = storyText('S-1');
    const { results } = await watchParks({ dir, root, config: { ...config, stories: { adapter: 'nowhere' } }, env, now, table: stepWith(async () => answer), ctxFor: () => ({}) });
    expect(results[0].outcome).toBe('error');
    expect(results[0].detail).toMatch(/could not be recorded: unknown story source: nowhere/);
    expect(readPark(dir, 'S-1')).toMatchObject({ lastCheck: { at: T.toISOString(), outcome: 'error' } });
    expect(storyText('S-1')).toBe(before);
    expect(statusOf('S-1').status).toBe(READY);
  });

  it.each([
    ['a check that throws', stepWith(async () => { throw new Error('Acme timed out'); }), /Acme timed out/],
    ['a check that returns nothing', stepWith(async () => undefined), /./],
    ['an unknown step', {}, /^unknown ship step acme-promote$/],
    ['a step with no check', { 'acme-promote': { name: 'acme-promote', run: async () => ({ ok: true }) } }, /^acme-promote has no check$/],
  ])('keeps the park and leaves the story alone for %s', async (_, table, detail) => {
    await parkS1();
    const before = storyText('S-1');
    const { results } = await watch(table);
    expect(results[0]).toMatchObject({ id: 'S-1', outcome: 'error' });
    expect(results[0].detail).toMatch(detail);
    expect(storyText('S-1')).toBe(before);
    expect(readPark(dir, 'S-1')).toMatchObject({ id: 'S-1', lastCheck: { outcome: 'error', detail: results[0].detail } });
  });

  it('adds one warn event for a repeated error, and another when the detail changes', async () => {
    await parkS1();
    let detail = 'Acme timed out';
    const table = stepWith(async () => { throw new Error(detail); });
    await watch(table);
    await watch(table);
    expect(readEvents().map((e) => [e.kind, e.text])).toEqual([['warn', expect.stringContaining('Acme timed out')]]);
    detail = 'Acme said 503';
    await watch(table);
    expect(readEvents().map((e) => e.text)).toEqual([expect.stringContaining('Acme timed out'), expect.stringContaining('Acme said 503')]);
  });

  it('still checks the second park when the first one throws', async () => {
    await parkS1();
    writeFileSync(join(root, 'stories', 'S-2.md'), '---\nid: S-2\ntitle: Sign out of Acme\nstatus: todo\n---\n\n# S-2\n\n## Progress notes\n\n_Newest first._\n');
    const later = new Date(T.getTime() + 60_000);
    await parkStory({ dir, root, config, env, now: () => later, slot: 'w2' }, { id: 'S-2', step: 'acme-promote', reason: 'click Promote', check: { deployId: 'D-2' } });
    const table = stepWith(async (ctx) => {
      if (ctx.check.deployId === 'D-1') throw new Error('Acme timed out');
      return { ok: true, done: true };
    });
    const { results } = await watch(table);
    expect(results.map((r) => [r.id, r.outcome])).toEqual([['S-1', 'error'], ['S-2', 'done']]);
    expect(statusOf('S-2').status).toBe('done');
  });

  it('gives the check the stored check, and the story, pull request and slot from the park', async () => {
    await parkS1();
    const seen = [];
    await watch(stepWith(async (ctx) => { seen.push(ctx); return { ok: true }; }));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ check: { deployId: 'D-1' }, story: 'S-1', pr: 'https://github.com/acme/app/pull/1', slot: 'w1' });
    expect(seen[0].park).toMatchObject({ id: 'S-1', step: 'acme-promote' });
  });

  it('is empty with no parks', async () => {
    expect(await watch({})).toEqual({ results: [] });
  });
});

describe('parkWatchDue', () => {
  const base = { running: false, lastAt: 0, count: 1, now: 1_000_000, everyMs: 300_000 };
  it('is true at lastAt 0 with parks', () => expect(parkWatchDue(base)).toBe(true));
  it('is false while a watch runs', () => expect(parkWatchDue({ ...base, running: true })).toBe(false));
  it('is false with no parks', () => expect(parkWatchDue({ ...base, count: 0 })).toBe(false));
  it('is false before everyMs has passed', () => expect(parkWatchDue({ ...base, lastAt: 800_000 })).toBe(false));
  it('is true at or after everyMs', () => {
    expect(parkWatchDue({ ...base, lastAt: 700_000 })).toBe(true);
    expect(parkWatchDue({ ...base, lastAt: 600_000 })).toBe(true);
  });
});

describe('confirmedResult', () => {
  const park = { id: 'S-1', step: 'acme-promote', reason: 'click Promote', check: { deployId: 'D-1' } };
  it('keeps ready-to-promote when the park is recorded', () => {
    expect(confirmedResult(READY, { park, status: 'in-progress' })).toBe(READY);
  });
  it('downgrades ready-to-promote to failed with no park', () => {
    expect(confirmedResult(READY, { park: null, status: 'in-progress' })).toBe('failed');
    expect(confirmedResult(READY, { park: null, status: null })).toBe('failed');
    expect(confirmedResult(READY)).toBe('failed');
  });
  it('keeps ready-to-promote when the park watch already finished the story', () => {
    expect(confirmedResult(READY, { park: null, status: 'done' })).toBe(READY);
  });
  it('passes other results through untouched', () => {
    for (const r of ['shipped', 'blocked', 'failed']) expect(confirmedResult(r, { park: null, status: null })).toBe(r);
  });
});

describe('sessionResult', () => {
  const ready = { result: READY, cause: null, story: 'S-1' };

  it('passes a result other than ready-to-promote through without reading anything', () => {
    for (const result of ['shipped', 'blocked', 'failed', null]) {
      const parkOf = vi.fn(() => null);
      const statusOf = vi.fn(() => null);
      const run = { result, cause: null };
      expect(sessionResult(run, { id: 'S-1', parkOf, statusOf, storyOpen: true })).toEqual({ run, warn: null, endReason: null });
      expect(parkOf).not.toHaveBeenCalled();
      expect(statusOf).not.toHaveBeenCalled();
    }
  });

  it('trusts the claim when a release is parked, without reading the status', () => {
    const statusOf = vi.fn(() => 'in-progress');
    const r = sessionResult(ready, { id: 'S-1', parkOf: () => park(), statusOf, storyOpen: true });
    expect(r).toEqual({ run: ready, warn: null, endReason: null });
    expect(statusOf).not.toHaveBeenCalled();
  });

  it('trusts the claim with no park when the story is already done', () => {
    const r = sessionResult(ready, { id: 'S-1', parkOf: () => null, statusOf: () => 'done', storyOpen: true });
    expect(r).toEqual({ run: ready, warn: null, endReason: null });
  });

  it('counts an unparked claim as failed, warns, and ends the story still in the slot', () => {
    const r = sessionResult(ready, { id: 'S-1', parkOf: () => null, statusOf: () => 'in-progress', storyOpen: true });
    expect(r.run).toEqual({ result: 'failed', cause: null, story: 'S-1' });
    expect(r.warn).toBe('S-1 said ready-to-promote, but no release is parked; counted as failed.');
    expect(r.endReason).toBe(UNPARKED);
  });

  it('does not end the story again when story end already freed the slot', () => {
    const r = sessionResult(ready, { id: 'S-1', parkOf: () => null, statusOf: () => 'in-progress', storyOpen: false });
    expect(r.run.result).toBe('failed');
    expect(r.warn).toBe('S-1 said ready-to-promote, but no release is parked; counted as failed.');
    expect(r.endReason).toBeNull();
  });

  it('leaves the claim unconfirmed when the status cannot be read', () => {
    const statusOf = vi.fn(() => {
      throw new Error('vault unreadable');
    });
    const r = sessionResult(ready, { id: 'S-1', parkOf: () => null, statusOf, storyOpen: true });
    expect(statusOf).toHaveBeenCalled();
    expect(r.run.result).toBe('failed');
  });
});
