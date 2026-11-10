import { describe, expect, it } from 'vitest';
import { closeInstead, mergedPrOf, mergedPrOfAsync } from './resume-close.mjs';

const PR = 'https://example.com/acme/pull/1';
const BRANCH = 'story/acme-1';

describe('mergedPrOf', () => {
  it('asks gh for the merged pull request of the branch', () => {
    const seen = [];
    mergedPrOf(BRANCH, (args) => {
      seen.push(args);
      return { status: 0, stdout: '[]' };
    });
    expect(seen).toEqual([['pr', 'list', '--head', BRANCH, '--state', 'merged', '--json', 'url', '--limit', '1']]);
  });

  it('gives the url of the merged pull request, or the branch when it has none', () => {
    expect(mergedPrOf(BRANCH, () => ({ status: 0, stdout: `[{"url":"${PR}"}]` }))).toBe(PR);
    expect(mergedPrOf(BRANCH, () => ({ status: 0, stdout: '[{}]' }))).toBe(BRANCH);
  });

  it.each([
    ['none merged', () => ({ status: 0, stdout: '[]' })],
    ['gh answers an object, not a list', () => ({ status: 0, stdout: '{"url":"x"}' })],
    ['gh prints bad JSON', () => ({ status: 0, stdout: 'not json' })],
    ['gh exits 1', () => ({ status: 1, stdout: '[{"url":"x"}]' })],
    [
      'gh throws',
      () => {
        throw new Error('spawn gh ENOENT');
      },
    ],
  ])('gives null, without throwing, when %s', (_, gh) => {
    let got;
    expect(() => {
      got = mergedPrOf(BRANCH, gh);
    }).not.toThrow();
    expect(got).toBe(null);
  });
});

// What closeInstead did, in order: ['mergedPr'], ['markDone', pr], ['close'], ['event', text, kind].
const recorder = ({ status, pr = null, markDone = () => {} }) => {
  const did = [];
  const deps = {
    statusOf: () => status,
    mergedPr: () => {
      did.push(['mergedPr']);
      return pr;
    },
    markDone: (url) => {
      did.push(['markDone', url]);
      markDone(url);
    },
    close: () => did.push(['close']),
    event: (text, kind) => did.push(['event', text, kind]),
  };
  return { did, deps };
};

const MERGED = 'ACME-1: its pull request merged; marked it done instead of resuming it.';

describe('closeInstead', () => {
  it('closes the slot of a settled story without asking gh', () => {
    const { did, deps } = recorder({ status: 'done', pr: PR });
    expect(closeInstead('ACME-1', deps)).toBe(true);
    expect(did).toEqual([['close'], ['event', 'ACME-1 is already done; not resuming it.', 'info']]);
  });

  it('marks a story done when only its pull request merged, then closes the slot', () => {
    const { did, deps } = recorder({ status: 'in-progress', pr: PR });
    expect(closeInstead('ACME-1', deps)).toBe(true);
    expect(did).toEqual([['mergedPr'], ['markDone', PR], ['close'], ['event', MERGED, 'info']]);
  });

  it('still closes the slot when marking the story done fails, and cuts the error to 200 characters', () => {
    const { did, deps } = recorder({
      status: 'in-progress',
      pr: PR,
      markDone: () => {
        throw new Error('x'.repeat(300));
      },
    });
    expect(closeInstead('ACME-1', deps)).toBe(true);
    expect(did).toEqual([['mergedPr'], ['markDone', PR], ['event', `ACME-1: could not mark it done: ${'x'.repeat(200)}`, 'warn'], ['close'], ['event', MERGED, 'info']]);
  });

  it('says what a thrown string was', () => {
    const { did, deps } = recorder({
      status: 'in-progress',
      pr: PR,
      markDone: () => {
        throw 'down';
      },
    });
    expect(closeInstead('ACME-1', deps)).toBe(true);
    expect(did).toContainEqual(['event', 'ACME-1: could not mark it done: down', 'warn']);
  });

  it.each([['in-progress'], [null]])('starts the session when the story is %s and nothing merged, touching nothing', (status) => {
    const { did, deps } = recorder({ status, pr: null });
    expect(closeInstead('ACME-1', deps)).toBe(false);
    expect(did).toEqual([['mergedPr']]);
  });
});

describe('mergedPrOfAsync', () => {
  it('asks gh the same question as mergedPrOf', async () => {
    const sync = [];
    mergedPrOf(BRANCH, (args) => (sync.push(args), { status: 0, stdout: '[]' }));
    const seen = [];
    await mergedPrOfAsync(BRANCH, async (args) => (seen.push(args), { status: 0, stdout: '[]' }));
    expect(seen).toEqual(sync);
  });

  it('gives the url, or the branch when the url is empty', async () => {
    expect(await mergedPrOfAsync(BRANCH, async () => ({ status: 0, stdout: `[{"url":"${PR}"}]` }))).toBe(PR);
    expect(await mergedPrOfAsync(BRANCH, async () => ({ status: 0, stdout: '[{"url":""}]' }))).toBe(BRANCH);
    expect(await mergedPrOfAsync(BRANCH, async () => ({ status: 0, stdout: '[{}]' }))).toBe(BRANCH);
  });

  it.each([
    ['none merged', async () => ({ status: 0, stdout: '[]' })],
    ['an object, not a list', async () => ({ status: 0, stdout: '{"url":"x"}' })],
    ['bad JSON', async () => ({ status: 0, stdout: 'not json' })],
    ['a non-zero status', async () => ({ status: 1, stdout: '[{"url":"x"}]' })],
    ['a time-out (status null)', async () => ({ status: null, stdout: '' })],
    ['a rejection', async () => Promise.reject(new Error('spawn gh ENOENT'))],
    [
      'a throw',
      () => {
        throw new Error('boom');
      },
    ],
  ])('gives null for %s', async (_name, gh) => {
    expect(await mergedPrOfAsync(BRANCH, gh)).toBeNull();
  });
});
