import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { failedAsk, releaseAsksFor, resumesByItself } from './failed-ask.mjs';
import * as decisions from '../console/decisions.mjs';

const PR = 'https://github.com/acme/acme/pull/7';
const REASON = 'CI never started on the pull request; PR left open, code not at fault';
const ci = (extra = {}) => failedAsk({ id: 'ACME-1', title: 'Add the export', reason: REASON, pr: PR, cause: 'environment', pending: [], ...extra });
const open = (title, story = 'ACME-1', extra = {}) => ({ id: 'd-20261110100000-0001', story, kind: 'decision', title, options: [], answer: null, appliedAt: null, ...extra });

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'failed-ask-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('failedAsk', () => {
  it('asks to retry the release when CI never started and the code is not at fault', () => {
    const item = ci();
    expect(item.story).toBe('ACME-1');
    expect(item.kind).toBe('decision');
    expect(item.title).toBe('ACME-1 could not be released');
    expect(item.options).toEqual(['Retry the release', "I'll take it", 'Drop']);
    expect(item.recommend).toBe('Retry the release');
    expect(item.summary.length).toBeLessThanOrEqual(160);
    expect(item.summary.startsWith('ACME-1 failed: CI never started')).toBe(true);
    expect(item.body).toContain(PR);
    expect(item.body).toContain('Reason: ' + REASON);
    expect(item.body).toContain('Cause: the environment; the code is not at fault');
    expect(item.hints).toHaveLength(3);
    for (const hint of item.hints) expect(hint.length).toBeLessThanOrEqual(100);
    expect(decisions.explainProblems(item.explain)).toEqual([]);
    expect(item.explain.purpose).toBe('Story ACME-1: Add the export.');
  });

  it('is accepted by decisions.add, so the decision limits hold', () => {
    expect(() => decisions.add(dir, ci())).not.toThrow();
    expect(() => decisions.add(dir, failedAsk({ id: 'ACME-1', reason: 'x'.repeat(300), cause: 'story', earlierFailures: 1 }))).not.toThrow();
    expect(() => decisions.add(dir, failedAsk({ id: 'ACME-1' }))).not.toThrow();
  });

  it('follows the failed-review rule when the cause is the story', () => {
    const base = { reason: 'A test file would not load', cause: 'story' };
    expect(ci({ ...base, earlierFailures: 0 }).recommend).toBe('Retry the release');
    const again = ci({ ...base, earlierFailures: 1 });
    expect(again.recommend).toBe("I'll take it");
    expect(again.body).toContain('Cause: the story');
    expect(again.explain.recommendation).toMatch(/^I'll take it/);
    expect(decisions.explainProblems(again.explain)).toEqual([]);
  });

  it('still recommends the retry when the reason says not at fault, whatever the cause', () => {
    expect(ci({ cause: 'story', earlierFailures: 3 }).recommend).toBe('Retry the release');
  });

  it('says so when no reason or pull request was given', () => {
    const item = failedAsk({ id: 'ACME-1', cause: 'story' });
    expect(item.summary).toBe('ACME-1 failed: no reason given');
    expect(item.body).toContain('Reason: none given');
    expect(item.body).not.toContain('Pull request');
  });

  it('cuts a long reason so the summary stays within 160 characters', () => {
    const item = ci({ reason: 'r'.repeat(300) });
    expect(item.summary.length).toBeLessThanOrEqual(160);
  });

  it('is null when an item about the story is already open', () => {
    for (const title of ['ACME-1 could not pass review', 'Decide for ACME-1: which store?', 'ACME-1 could not be released']) {
      expect(ci({ pending: [open(title)] }), title).toBeNull();
    }
    expect(ci({ pending: [open('Which store for ACME-1?', 'ACME-1', { kind: 'task' })] })).toBeNull();
  });

  it('is not null for an applied item, another story, or the proposals about the story', () => {
    expect(ci({ pending: [open('ACME-1 could not pass review', 'ACME-1', { appliedAt: '2026-11-10T11:00:00.000Z' })] })).not.toBeNull();
    expect(ci({ pending: [open('Follow up on ACME-1: 2 minor finding(s)?')] })).not.toBeNull();
    expect(ci({ pending: [open('Foreman learned L-1 for developer')] })).not.toBeNull();
    expect(ci({ pending: [open('ACME-2 could not pass review', 'ACME-2')] })).not.toBeNull();
  });
});

describe('resumesByItself', () => {
  const idPattern = 'ACME-\\d+';

  it('is true for a story the picker takes again: to do, in progress or done', () => {
    for (const status of ['todo', 'in-progress', 'done']) expect(resumesByItself({ status }, { idPattern }), status).toBe(true);
    expect(resumesByItself({ status: 'todo' })).toBe(true);
  });

  it('is false for a story blocked for a reason in words', () => {
    expect(resumesByItself({ status: 'blocked', blockedBy: 'Factory could not pass review; see draft PR x' }, { idPattern })).toBe(false);
  });

  it('is true for a story blocked on another story, which the run picks again once that ships', () => {
    expect(resumesByItself({ status: 'blocked', blockedBy: 'ACME-2 must land first' }, { idPattern })).toBe(true);
  });

  it('is false, and does not throw, for a blocked story with no idPattern', () => {
    const story = { status: 'blocked', blockedBy: 'ACME-2 must land first' };
    expect(() => resumesByItself(story)).not.toThrow();
    expect(resumesByItself(story)).toBe(false);
    expect(resumesByItself(story, { idPattern: '' })).toBe(false);
  });

  it('is false for no story or an unknown status', () => {
    expect(resumesByItself(null)).toBe(false);
    expect(resumesByItself(undefined)).toBe(false);
    expect(resumesByItself({ status: 'parked' }, { idPattern })).toBe(false);
    expect(resumesByItself({}, { idPattern })).toBe(false);
  });
});

describe('releaseAsksFor', () => {
  const a = open('ACME-1 could not be released', 'ACME-1', { id: 'd-a' });
  const b = open('ACME-1 could not be released', 'ACME-1', { id: 'd-b', answer: { option: 'Drop' } });
  const c = open('ACME-1 could not be released', 'ACME-1', { id: 'd-c', appliedAt: '2026-11-10T10:00:00.000Z' });
  const d = open('ACME-2 could not be released', 'ACME-2', { id: 'd-d' });
  const e = open('ACME-1 could not pass review', 'ACME-1', { id: 'd-e' });

  it('returns the story\'s release items not yet applied, answered or not', () => {
    expect(releaseAsksFor([a, b, c, d, e], 'ACME-1')).toEqual([a, b]);
    expect(releaseAsksFor([a, b, c, d, e], 'ACME-2')).toEqual([d]);
  });

  it('gives an empty list when pending is not a list', () => {
    expect(releaseAsksFor(undefined, 'ACME-1')).toEqual([]);
    expect(releaseAsksFor({}, 'ACME-1')).toEqual([]);
    expect(releaseAsksFor([null, undefined], 'ACME-1')).toEqual([]);
  });
});
