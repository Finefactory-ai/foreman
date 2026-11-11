import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { checkBeforeEnv, closeInstead, mergedAfter, mergedPrOf, mergedPrOfAsync, rolledBackAtOf } from './resume-close.mjs';

const PR = 'https://example.com/acme/pull/1';
const BRANCH = 'story/acme-1';

describe('mergedPrOf', () => {
  it('asks gh for the merged pull request of the branch', () => {
    const seen = [];
    mergedPrOf(BRANCH, (args) => {
      seen.push(args);
      return { status: 0, stdout: '[]' };
    });
    expect(seen).toEqual([['pr', 'list', '--head', BRANCH, '--state', 'merged', '--json', 'url,mergedAt', '--limit', '10']]);
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

describe('checkBeforeEnv', () => {
  it.each(['docker', 'scratch', 'sandbox-pool'])('is true for the %s adapter with no mode', (adapter) => {
    expect(checkBeforeEnv({ adapter, mode: '' })).toBe(true);
    expect(checkBeforeEnv({ adapter })).toBe(true);
  });

  it.each([['none'], [undefined]])('is false for the adapter %s, which makes nothing', (adapter) => {
    expect(checkBeforeEnv({ adapter, mode: '' })).toBe(false);
  });

  it.each(['group-summary', 'fresh', 'after-halt'])('is false for the mode %s, even with scratch', (mode) => {
    expect(checkBeforeEnv({ adapter: 'scratch', mode })).toBe(false);
  });
});

describe('closeInstead before an environment', () => {
  const NO_ENV = 'ACME-1: its pull request merged; marked it done with no environment made.';

  it('marks a story done when its pull request merged, then closes the slot', () => {
    const { did, deps } = recorder({ status: 'todo', pr: PR });
    expect(closeInstead('ACME-1', { ...deps, instead: 'environment' })).toBe(true);
    expect(did).toEqual([['mergedPr'], ['markDone', PR], ['close'], ['event', NO_ENV, 'info']]);
  });

  it('closes the slot of a settled story without asking gh or marking it done', () => {
    const { did, deps } = recorder({ status: 'done', pr: PR });
    expect(closeInstead('ACME-1', { ...deps, instead: 'environment' })).toBe(true);
    expect(did).toEqual([['close'], ['event', 'ACME-1 is already done; closed it with no environment made.', 'info']]);
  });

  it('gives false, touching nothing, when nothing merged and the story is todo', () => {
    const { did, deps } = recorder({ status: 'todo', pr: null });
    expect(closeInstead('ACME-1', { ...deps, instead: 'environment' })).toBe(false);
    expect(did).toEqual([['mergedPr']]);
  });

  it('warns when marking done throws, and still closes the slot', () => {
    const { did, deps } = recorder({
      status: 'todo',
      pr: PR,
      markDone: () => {
        throw new Error('jira down');
      },
    });
    expect(closeInstead('ACME-1', { ...deps, instead: 'environment' })).toBe(true);
    expect(did).toEqual([['mergedPr'], ['markDone', PR], ['event', 'ACME-1: could not mark it done: jira down', 'warn'], ['close'], ['event', NO_ENV, 'info']]);
  });

  it('keeps the resume texts when instead is not given', () => {
    const { did, deps } = recorder({ status: 'in-progress', pr: PR });
    closeInstead('ACME-1', deps);
    expect(did.at(-1)).toEqual(['event', MERGED, 'info']);
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

const MERGED_AT = '2026-11-01T10:00:00Z';
const ROLLED_BACK_AT = '2026-11-01T11:00:00Z';
const listOf = (...entries) => JSON.stringify(entries);

describe('mergedAfter', () => {
  it('is true when no rollback is recorded', () => {
    expect(mergedAfter(MERGED_AT, null)).toBe(true);
    expect(mergedAfter(MERGED_AT, undefined)).toBe(true);
    expect(mergedAfter(undefined, null)).toBe(true);
  });

  it('is true when the merge came after the rollback', () => {
    expect(mergedAfter('2026-11-01T12:00:00Z', ROLLED_BACK_AT)).toBe(true);
  });

  it('is false when the merge came before or at the rollback', () => {
    expect(mergedAfter(MERGED_AT, ROLLED_BACK_AT)).toBe(false);
    expect(mergedAfter(ROLLED_BACK_AT, ROLLED_BACK_AT)).toBe(false);
  });

  it('is false for a missing or unparseable merge time when a rollback is recorded', () => {
    expect(mergedAfter(undefined, ROLLED_BACK_AT)).toBe(false);
    expect(mergedAfter('soon', ROLLED_BACK_AT)).toBe(false);
  });
});

describe('rolledBackAtOf', () => {
  it('gives null for no pack, or a pack without the member', () => {
    expect(rolledBackAtOf(null, { dir: '/d', story: 'ACME-1' })).toBeNull();
    expect(rolledBackAtOf({}, { dir: '/d', story: 'ACME-1' })).toBeNull();
  });

  it('gives null when the hook throws', () => {
    const pack = {
      rolledBackAt: () => {
        throw new Error('disk gone');
      },
    };
    expect(rolledBackAtOf(pack, { dir: '/d', story: 'ACME-1' })).toBeNull();
  });

  it.each([[5], [{}], ['not a time'], [''], [undefined], [null]])('gives null for the return %j', (value) => {
    expect(rolledBackAtOf({ rolledBackAt: () => value }, { dir: '/d', story: 'ACME-1' })).toBeNull();
  });

  it('passes a valid ISO time through, and hands the hook { dir, story }', () => {
    const seen = [];
    const pack = { rolledBackAt: (arg) => (seen.push(arg), ROLLED_BACK_AT) };
    expect(rolledBackAtOf(pack, { dir: '/d', story: 'ACME-1' })).toBe(ROLLED_BACK_AT);
    expect(seen).toEqual([{ dir: '/d', story: 'ACME-1' }]);
  });
});

describe('mergedPrOf and mergedPrOfAsync after a rollback', () => {
  describe.each([['sync'], ['async']])('%s', (kind) => {
    const run = async (stdout, opts) => (kind === 'sync' ? mergedPrOf(BRANCH, () => ({ status: 0, stdout }), opts) : mergedPrOfAsync(BRANCH, async () => ({ status: 0, stdout }), opts));

    it('gives null for a pull request merged before the rollback', async () => {
      expect(await run(listOf({ url: PR, mergedAt: MERGED_AT }), { rolledBackAt: ROLLED_BACK_AT })).toBeNull();
    });

    it('gives the url for a pull request merged after the rollback', async () => {
      expect(await run(listOf({ url: PR, mergedAt: '2026-11-01T12:00:00Z' }), { rolledBackAt: ROLLED_BACK_AT })).toBe(PR);
    });

    it('lets the newest merge decide, in either list order', async () => {
      const old = { url: 'https://example.com/acme/pull/0', mergedAt: MERGED_AT };
      const fresh = { url: PR, mergedAt: '2026-11-01T12:00:00Z' };
      expect(await run(listOf(old, fresh), { rolledBackAt: ROLLED_BACK_AT })).toBe(PR);
      expect(await run(listOf(fresh, old), { rolledBackAt: ROLLED_BACK_AT })).toBe(PR);
      expect(await run(listOf(old), { rolledBackAt: ROLLED_BACK_AT })).toBeNull();
    });

    it('is as before with no rolledBackAt', async () => {
      expect(await run(listOf({ url: PR, mergedAt: MERGED_AT }))).toBe(PR);
      expect(await run(listOf({ url: PR, mergedAt: MERGED_AT }), { rolledBackAt: null })).toBe(PR);
      expect(await run('[{}]')).toBe(BRANCH);
    });

    it('treats a merge with no time as not after a rollback', async () => {
      expect(await run('[{}]', { rolledBackAt: ROLLED_BACK_AT })).toBeNull();
    });
  });
});

describe('a story rolled back after its merge is built again', () => {
  const NO_ENV = 'ACME-1: its pull request merged; marked it done with no environment made.';
  const ghAnswer = async () => ({ status: 0, stdout: listOf({ url: PR, mergedAt: MERGED_AT }) });

  it('does not close it instead of making its environment', async () => {
    const pr = await mergedPrOfAsync(BRANCH, ghAnswer, { rolledBackAt: ROLLED_BACK_AT });
    const { did, deps } = recorder({ status: 'todo', pr });
    expect(closeInstead('ACME-1', { ...deps, instead: 'environment' })).toBe(false);
    expect(did).toEqual([['mergedPr']]);
  });

  it('still marks it done with no rollback recorded', async () => {
    const pr = await mergedPrOfAsync(BRANCH, ghAnswer, { rolledBackAt: null });
    const { did, deps } = recorder({ status: 'todo', pr });
    expect(closeInstead('ACME-1', { ...deps, instead: 'environment' })).toBe(true);
    expect(did).toEqual([['mergedPr'], ['markDone', PR], ['close'], ['event', NO_ENV, 'info']]);
  });
});

describe('the supervisor passes the rollback on', () => {
  const source = readFileSync(new URL('./supervisor.mjs', import.meta.url), 'utf8');

  it("gives lookUpMerged's look-up the story's rollback time", () => {
    expect(source).toMatch(/mergedPrOfAsync\(branchOf\(id\), \(args\) => [^\n]*\{ rolledBackAt: rolledBackOf\(id\) \}\)/);
  });

  it('has the start-up plan ask for merge times and drop rolled-back stories', () => {
    const plan = source.slice(source.indexOf('function recoveryPlan()'));
    expect(plan.slice(0, plan.indexOf('\n}\n'))).toContain("'headRefName,mergedAt'");
    expect(plan.slice(0, plan.indexOf('\n}\n'))).toContain('shippedBranches(');
  });
});
