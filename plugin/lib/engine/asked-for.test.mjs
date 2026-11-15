// How `foreman run N` counts, and the words that say so.
import { describe, expect, it } from 'vitest';
import { askedOf, askedText, inHandAtStart, leftInHand, reachedLine, resumedLine } from './asked-for.mjs';

describe('inHandAtStart', () => {
  it('lists the adopted live sessions first, then the queued work, each story once', () => {
    const kept = [{ id: 'ACME-2', slot: 'w1', pid: 11 }, { id: 'ACME-4', slot: 'w2', pid: 12 }];
    const work = [{ id: 'ACME-1' }, { id: 'ACME-2' }, { id: 'ACME-3' }];
    expect(inHandAtStart({ kept, work })).toEqual(['ACME-2', 'ACME-4', 'ACME-1', 'ACME-3']);
  });

  it('is the queued work, once each, when no session was adopted', () => {
    expect(inHandAtStart({ kept: [], work: [{ id: 'ACME-1' }, { id: 'ACME-1' }, { id: 'ACME-3' }] })).toEqual(['ACME-1', 'ACME-3']);
  });

  it('is the adopted sessions alone when no work was queued', () => {
    expect(inHandAtStart({ kept: [{ id: 'ACME-2', slot: 'w1', pid: 11 }], work: [] })).toEqual(['ACME-2']);
  });

  it('is empty for bad input and skips entries without a string id', () => {
    for (const bad of [null, undefined, 'ACME-1']) expect(inHandAtStart({ kept: bad, work: bad })).toEqual([]);
    expect(inHandAtStart({})).toEqual([]);
    expect(inHandAtStart({ kept: [null, { id: 7 }, 'ACME-5', { id: 'ACME-2' }], work: [{ id: 7 }, null, { id: 'ACME-1' }] })).toEqual(['ACME-2', 'ACME-1']);
  });
});

describe('leftInHand', () => {
  it('lists the stories start-up recovery queues, once each, in plan order', () => {
    const plan = [
      { type: 'finish-release', id: 'ACME-1' },
      { type: 'close', id: 'ACME-2' },
      { type: 'resume', id: 'ACME-3' },
      { type: 'release-claim', id: 'ACME-9' },
      { type: 'clear-stale' },
      { type: 'resume', id: 'ACME-1' },
    ];
    expect(leftInHand(plan)).toEqual(['ACME-1', 'ACME-2', 'ACME-3']);
  });

  it('is empty for no plan', () => {
    expect(leftInHand([])).toEqual([]);
    expect(leftInHand(null)).toEqual([]);
    expect(leftInHand(undefined)).toEqual([]);
    expect(leftInHand('resume')).toEqual([]);
  });
});

describe('resumedLine', () => {
  it('says the stories left in hand come on top of the number asked for', () => {
    expect(resumedLine({ max: 1, count: 3 })).toBe('3 stories left in hand are resumed first, on top of the 1 asked for: they do not count towards it.');
    expect(resumedLine({ max: 2, count: 1 })).toBe('1 story left in hand is resumed first, on top of the 2 asked for: it does not count towards them.');
  });

  it('says nothing with nothing in hand or no number', () => {
    expect(resumedLine({ max: 1, count: 0 })).toBeNull();
    expect(resumedLine({ max: 0, count: 3 })).toBeNull();
  });
});

describe('reachedLine', () => {
  it('is the plain stop text when no resumed story shipped', () => {
    expect(reachedLine({ max: 1, resumedShipped: 0 })).toBe('Reached the 1 story asked for.');
    expect(reachedLine({ max: 2, resumedShipped: 0 })).toBe('Reached the 2 stories asked for.');
  });

  it('names the resumed stories that also shipped', () => {
    expect(reachedLine({ max: 1, resumedShipped: 3 })).toBe('Reached the 1 story asked for; 3 resumed stories also shipped.');
    expect(reachedLine({ max: 1, resumedShipped: 1 })).toBe('Reached the 1 story asked for; 1 resumed story also shipped.');
  });
});

describe('askedOf', () => {
  const running = { loop: { state: 'running' } };

  it('is null once the loop is stopped, with no asked, or with a malformed one', () => {
    expect(askedOf({ loop: { state: 'stopped' }, asked: { max: 1, resumed: ['ACME-1'] } })).toBeNull();
    expect(askedOf(running)).toBeNull();
    expect(askedOf({ ...running, asked: null })).toBeNull();
    expect(askedOf({ ...running, asked: { max: '1', resumed: [] } })).toBeNull();
    expect(askedOf({ ...running, asked: { max: 1.5, resumed: [] } })).toBeNull();
    expect(askedOf({ ...running, asked: { max: -1, resumed: [] } })).toBeNull();
    expect(askedOf({ ...running, asked: { max: 1, resumed: 'ACME-1' } })).toBeNull();
    expect(askedOf({ ...running, asked: { max: 1, resumed: [1] } })).toBeNull();
  });

  it('carries max and the resumed stories while the run goes', () => {
    expect(askedOf({ ...running, asked: { max: 1, resumed: ['ACME-2'], extra: true } })).toEqual({ max: 1, resumed: ['ACME-2'] });
  });
});

describe('askedText', () => {
  it('shows the split', () => {
    expect(askedText({ max: 1, resumed: ['ACME-1', 'ACME-2', 'ACME-3'] })).toBe('Stories: 1 asked for, 3 resumed on top (ACME-1, ACME-2, ACME-3)');
  });

  it('shows nothing without a number or without stories resumed on top', () => {
    expect(askedText({ max: 1, resumed: [] })).toBeNull();
    expect(askedText({ max: 0, resumed: ['ACME-1'] })).toBeNull();
    expect(askedText(null)).toBeNull();
  });
});
