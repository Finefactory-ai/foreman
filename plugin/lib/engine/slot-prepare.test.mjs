import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { git, makeRepos, sh } from '../../../test/state-repos.mjs';
import { envAdapterContract } from '../adapters/env/contract.mjs';
import { addItem, undoItem, updateItem } from './learning-store.mjs';
import { envSweepDue, envVerdict, isPending, learnedSkills, learnedSkillsByRole, notStartedPatch, PENDING, pendingPrepares, prepareEnv, prepareSlot, runEnvSweep, sessionStartPatch, STATES, syncLearnedSkills } from './slot-prepare.mjs';
import { readSlot, redact, setSlot } from './state.mjs';
import { releaseHeld } from './scheduler.mjs';
import { storiesInSlots } from '../../packs/salesforce/scratch-orgs.mjs';

// A promise with its resolve and reject on the outside.
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

// An adapter whose prepare answers each value of `answers` in turn.
function adapterOf(...answers) {
  const prepare = vi.fn(() => {
    const a = answers.shift();
    if (a instanceof Error) throw a;
    return a;
  });
  return { prepare };
}

describe('STATES', () => {
  it('are the four states', () => {
    expect(STATES).toEqual(['up', 'restarted', 'reset', 'down']);
  });
});

describe('isPending', () => {
  it('is true only for a thenable', () => {
    expect(isPending(Promise.resolve('up'))).toBe(true);
    expect(isPending({ then: () => {} })).toBe(true);
    expect(isPending('up')).toBe(false);
    expect(isPending(null)).toBe(false);
    expect(isPending(undefined)).toBe(false);
    expect(isPending({ state: 'up' })).toBe(false);
  });
});

describe('prepareEnv', () => {
  it('answers a sync up at once, as a plain object', () => {
    const out = prepareEnv({ adapter: adapterOf('up'), n: 1, path: '/wt' });
    expect(isPending(out)).toBe(false);
    expect(out).toEqual({ state: 'up', error: null, repair: null });
  });

  it('passes restarted and reset through', () => {
    expect(prepareEnv({ adapter: adapterOf('restarted'), n: 1, path: '/wt' })).toEqual({ state: 'restarted', error: null, repair: null });
    expect(prepareEnv({ adapter: adapterOf('reset'), n: 1, path: '/wt' })).toEqual({ state: 'reset', error: null, repair: null });
  });

  it('gives the arguments to prepare', () => {
    const adapter = adapterOf('up');
    prepareEnv({ adapter, n: 3, path: '/wt/3' });
    expect(adapter.prepare).toHaveBeenCalledWith(3, '/wt/3');
  });

  it('turns a sync throw into down with its message, and never repairs', () => {
    const repair = vi.fn(() => true);
    const out = prepareEnv({ adapter: adapterOf(new Error('Acme stack would not start')), n: 1, path: '/wt', repair });
    expect(out).toEqual({ state: 'down', error: 'Acme stack would not start', repair: null });
    expect(repair).not.toHaveBeenCalled();
  });

  it('gives a throw with no message a fixed text, and never repairs', () => {
    const repair = vi.fn(() => true);
    const out = prepareEnv({ adapter: adapterOf(new Error()), n: 1, path: '/wt', repair });
    expect(out).toEqual({ state: 'down', error: 'failed with no message', repair: null });
    expect(repair).not.toHaveBeenCalled();
    expect(envVerdict(out)).toMatchObject({ action: 'down', reason: 'Its environment would not start: failed with no message' });
  });

  it('gives a rejection with no message a fixed text, and never repairs', async () => {
    const repair = vi.fn(() => true);
    const out = prepareEnv({ adapter: adapterOf(Promise.reject(new Error(''))), n: 1, path: '/wt', repair });
    await expect(out).resolves.toEqual({ state: 'down', error: 'failed with no message', repair: null });
    expect(repair).not.toHaveBeenCalled();
  });

  it('gives a thrown empty string the fixed text, and never repairs', () => {
    const repair = vi.fn(() => true);
    const adapter = {
      prepare: vi.fn(() => {
        throw '';
      }),
    };
    const out = prepareEnv({ adapter, n: 1, path: '/wt', repair });
    expect(out).toEqual({ state: 'down', error: 'failed with no message', repair: null });
    expect(repair).not.toHaveBeenCalled();
  });

  it('counts a repair that throws with no message as failed, with the fixed text', () => {
    const out = prepareEnv({
      adapter: adapterOf('down'),
      n: 1,
      path: '/wt',
      repair: () => {
        throw new Error();
      },
    });
    expect(out).toEqual({ state: 'down', error: 'failed with no message', repair: false });
  });

  it('answers a promise of up with a promise of the outcome', async () => {
    const out = prepareEnv({ adapter: adapterOf(Promise.resolve('up')), n: 1, path: '/wt' });
    expect(isPending(out)).toBe(true);
    await expect(out).resolves.toEqual({ state: 'up', error: null, repair: null });
  });

  it('turns a rejection into down with its message, never rejects, and never repairs', async () => {
    const repair = vi.fn(() => true);
    const out = prepareEnv({ adapter: adapterOf(Promise.reject(new Error('Acme org limit reached'))), n: 1, path: '/wt', repair });
    await expect(out).resolves.toEqual({ state: 'down', error: 'Acme org limit reached', repair: null });
    expect(repair).not.toHaveBeenCalled();
  });

  it('turns a value outside the four states into down, naming the value', async () => {
    const sync = prepareEnv({ adapter: adapterOf('ok'), n: 1, path: '/wt' });
    expect(sync.state).toBe('down');
    expect(sync.error).toContain('"ok"');
    const later = await prepareEnv({ adapter: adapterOf(Promise.resolve(undefined)), n: 1, path: '/wt' });
    expect(later.state).toBe('down');
    expect(later.error).toContain('undefined');
  });

  it('repairs a sync down and prepares again', () => {
    const adapter = adapterOf('down', 'up');
    const repair = vi.fn(() => true);
    const out = prepareEnv({ adapter, n: 1, path: '/wt', repair });
    expect(isPending(out)).toBe(false);
    expect(out).toEqual({ state: 'up', error: null, repair: true });
    expect(adapter.prepare).toHaveBeenCalledTimes(2);
    expect(repair).toHaveBeenCalledTimes(1);
  });

  it('repairs an async down and prepares again', async () => {
    const adapter = adapterOf(Promise.resolve('down'), Promise.resolve('up'));
    const repair = vi.fn(() => true);
    const out = prepareEnv({ adapter, n: 1, path: '/wt', repair });
    expect(isPending(out)).toBe(true);
    await expect(out).resolves.toEqual({ state: 'up', error: null, repair: true });
    expect(adapter.prepare).toHaveBeenCalledTimes(2);
  });

  it('stays down when the repair fails, without preparing again', () => {
    const adapter = adapterOf('down', 'up');
    const out = prepareEnv({ adapter, n: 1, path: '/wt', repair: () => false });
    expect(out).toEqual({ state: 'down', error: null, repair: false });
    expect(adapter.prepare).toHaveBeenCalledTimes(1);
  });

  it('counts a repair that throws as failed, with its message', () => {
    const out = prepareEnv({
      adapter: adapterOf('down'),
      n: 1,
      path: '/wt',
      repair: () => {
        throw new Error('Acme runtime missing');
      },
    });
    expect(out).toEqual({ state: 'down', error: 'Acme runtime missing', repair: false });
  });

  it('stays down with no repair to try', () => {
    expect(prepareEnv({ adapter: adapterOf('down'), n: 1, path: '/wt', repair: null })).toEqual({ state: 'down', error: null, repair: null });
  });
});

describe('envVerdict', () => {
  it('starts on up with no note, and notes any other state', () => {
    expect(envVerdict({ state: 'up', error: null, repair: null })).toEqual({ action: 'start', reason: '', note: null, events: [] });
    expect(envVerdict({ state: 'reset', error: null, repair: null })).toMatchObject({ action: 'start', note: 'environment reset' });
  });

  it('puts the slot down with the error as the reason', () => {
    expect(envVerdict({ state: 'down', error: 'Acme org limit reached', repair: null })).toMatchObject({
      action: 'down',
      reason: 'Its environment would not start: Acme org limit reached',
      events: [],
    });
  });

  it('puts the slot down with a plain reason when there is no error', () => {
    expect(envVerdict({ state: 'down', error: null, repair: null }).reason).toBe('Its environment would not start.');
  });

  it('pauses when down after a repair, whether the repair worked or not', () => {
    const failed = envVerdict({ state: 'down', error: null, repair: false });
    expect(failed).toMatchObject({ action: 'pause', reason: 'The slot environment would not start, even after a repair.' });
    expect(failed.events).toEqual([{ text: 'The slot environment was down and could not be repaired.', kind: 'warn' }]);
    const worked = envVerdict({ state: 'down', error: null, repair: true });
    expect(worked).toMatchObject({ action: 'pause', reason: 'The slot environment would not start, even after a repair.' });
    expect(worked.events).toEqual([{ text: 'The slot environment was down; repaired it.', kind: 'warn' }]);
  });

  it('starts after a repair that worked, and says so', () => {
    const v = envVerdict({ state: 'up', error: null, repair: true });
    expect(v.action).toBe('start');
    expect(v.events).toEqual([{ text: 'The slot environment was down; repaired it.', kind: 'warn' }]);
  });
});

describe('pendingPrepares', () => {
  it('tracks a slot once added', () => {
    const p = pendingPrepares();
    p.add('w1', { id: 'ACME-1' });
    expect(p.has('w1')).toBe(true);
    expect(p.has('w2')).toBe(false);
    expect(p.size).toBe(1);
  });

  it('settles only the current token, once', () => {
    const p = pendingPrepares();
    const t = p.add('w1', { id: 'ACME-1' });
    expect(p.settle('w1', t)).toBe(true);
    expect(p.has('w1')).toBe(false);
    expect(p.size).toBe(0);
    expect(p.settle('w1', t)).toBe(false);
  });

  it('does not settle a cancelled slot', () => {
    const p = pendingPrepares();
    const t = p.add('w1', { id: 'ACME-1' });
    expect(p.cancel('w1')).toBe(true);
    expect(p.cancel('w1')).toBe(false);
    expect(p.settle('w1', t)).toBe(false);
  });

  it('does not settle an old token after the slot was added again', () => {
    const p = pendingPrepares();
    const old = p.add('w1', { id: 'ACME-1' });
    p.cancel('w1');
    p.add('w1', { id: 'ACME-2' });
    expect(p.settle('w1', old)).toBe(false);
    expect(p.has('w1')).toBe(true);
  });

  it('settles nothing once closed', () => {
    const p = pendingPrepares();
    const t = p.add('w1', { id: 'ACME-1' });
    p.close();
    expect(p.size).toBe(0);
    expect(p.settle('w1', t)).toBe(false);
  });

  it('live() is true for the current token only while the tracker is open', () => {
    const p = pendingPrepares();
    const t = p.add('w1', { id: 'ACME-1' });
    expect(p.live('w1', t)).toBe(true);
    expect(p.live('w2', t)).toBe(false);
  });

  it('live() is false after settle, cancel or close, and after a newer add', () => {
    const settled = pendingPrepares();
    const a = settled.add('w1');
    settled.settle('w1', a);
    expect(settled.live('w1', a)).toBe(false);

    const cancelled = pendingPrepares();
    const b = cancelled.add('w1');
    cancelled.cancel('w1');
    expect(cancelled.live('w1', b)).toBe(false);

    const newer = pendingPrepares();
    const old = newer.add('w1');
    newer.cancel('w1');
    const fresh = newer.add('w1');
    expect(newer.live('w1', old)).toBe(false);
    expect(newer.live('w1', fresh)).toBe(true);

    const closed = pendingPrepares();
    const c = closed.add('w1');
    closed.close();
    expect(closed.live('w1', c)).toBe(false);
  });

  it('refuses a slot that is still preparing', () => {
    const p = pendingPrepares();
    p.add('w1', { id: 'ACME-1' });
    expect(() => p.add('w1', { id: 'ACME-2' })).toThrow('slot w1 is still preparing');
  });
});

describe('prepareSlot', () => {
  // prepare(1) answers later, through `slow`; every other slot answers up at once.
  function slowFirstSlot() {
    const slow = deferred();
    const adapter = { prepare: vi.fn((n) => (n === 1 ? slow.promise : 'up')) };
    return { slow, adapter };
  }

  it('a slow prepare does not delay a story on another slot', async () => {
    const { slow, adapter } = slowFirstSlot();
    const pending = pendingPrepares();
    const later = vi.fn();

    const w1 = prepareSlot({ slot: 'w1', id: 'ACME-1', adapter, n: 1, path: '/wt/1', repair: null, pending, later });
    expect(w1).toBe(PENDING);
    expect(later).not.toHaveBeenCalled();
    expect(pending.has('w1')).toBe(true);

    const w2 = prepareSlot({ slot: 'w2', id: 'ACME-2', adapter, n: 2, path: '/wt/2', repair: null, pending, later });
    expect(w2).toEqual({ state: 'up', error: null, repair: null });
    expect(pending.has('w2')).toBe(false);
    expect(pending.has('w1')).toBe(true);
    expect(later).not.toHaveBeenCalled();

    slow.resolve('up');
    await flush();
    expect(later).toHaveBeenCalledTimes(1);
    expect(later).toHaveBeenCalledWith({ state: 'up', error: null, repair: null });
    expect(pending.has('w1')).toBe(false);
  });

  it('keeps the slot out until it settles, and a rejection gives a down verdict with the reason', async () => {
    const { slow, adapter } = slowFirstSlot();
    const pending = pendingPrepares();
    const later = vi.fn();
    expect(prepareSlot({ slot: 'w1', id: 'ACME-1', adapter, n: 1, path: '/wt/1', repair: null, pending, later })).toBe(PENDING);
    await flush();
    expect(pending.has('w1')).toBe(true);
    expect(later).not.toHaveBeenCalled();

    slow.reject(new Error('Acme org limit reached'));
    await flush();
    expect(pending.has('w1')).toBe(false);
    expect(later).toHaveBeenCalledTimes(1);
    const outcome = later.mock.calls[0][0];
    expect(outcome).toMatchObject({ state: 'down', error: 'Acme org limit reached' });
    const v = envVerdict(outcome);
    expect(v.action).toBe('down');
    expect(v.reason).toContain('Acme org limit reached');
  });

  it('never calls later for a cancelled slot', async () => {
    const { slow, adapter } = slowFirstSlot();
    const pending = pendingPrepares();
    const later = vi.fn();
    prepareSlot({ slot: 'w1', id: 'ACME-1', adapter, n: 1, path: '/wt/1', repair: null, pending, later });
    pending.cancel('w1');
    slow.resolve('up');
    await flush();
    expect(later).not.toHaveBeenCalled();
  });

  it('never calls later once the tracker is closed', async () => {
    const { slow, adapter } = slowFirstSlot();
    const pending = pendingPrepares();
    const later = vi.fn();
    prepareSlot({ slot: 'w1', id: 'ACME-1', adapter, n: 1, path: '/wt/1', repair: null, pending, later });
    pending.close();
    slow.resolve('up');
    await flush();
    expect(later).not.toHaveBeenCalled();
  });

  it('passes a throw from later to onError, with no unhandled rejection', async () => {
    const { slow, adapter } = slowFirstSlot();
    const pending = pendingPrepares();
    const boom = new Error('Acme later failed');
    const onError = vi.fn();
    prepareSlot({
      slot: 'w1',
      id: 'ACME-1',
      adapter,
      n: 1,
      path: '/wt/1',
      repair: null,
      pending,
      later: () => {
        throw boom;
      },
      onError,
    });
    slow.resolve('up');
    await flush();
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it('swallows a throw from later when there is no onError', async () => {
    const { slow, adapter } = slowFirstSlot();
    prepareSlot({
      slot: 'w1',
      id: 'ACME-1',
      adapter,
      n: 1,
      path: '/wt/1',
      repair: null,
      pending: pendingPrepares(),
      later: () => {
        throw new Error('Acme later failed');
      },
    });
    slow.resolve('up');
    await flush();
  });
});

describe('prepareEnv bounds what it shows of a bad answer', () => {
  const HEAD = 'prepare answered ';
  const TAIL = ', not up, restarted, reset or down';
  const bounded = (error) => {
    expect(error.startsWith(`${HEAD}"xxx`)).toBe(true);
    expect(error.length).toBeLessThanOrEqual(HEAD.length + 200 + TAIL.length);
    expect(error.endsWith('not up, restarted, reset or down')).toBe(true);
  };

  it('clips a huge sync answer to 200 characters', () => {
    const out = prepareEnv({ adapter: adapterOf('x'.repeat(5000)), n: 1, path: '/wt' });
    expect(out.state).toBe('down');
    bounded(out.error);
  });

  it('clips a huge async answer to 200 characters', async () => {
    const out = await prepareEnv({ adapter: adapterOf(Promise.resolve('x'.repeat(5000))), n: 1, path: '/wt' });
    expect(out.state).toBe('down');
    bounded(out.error);
  });

  it('names an answer JSON cannot show without throwing, sync or async', async () => {
    const o = {};
    o.self = o;
    let sync;
    expect(() => {
      sync = prepareEnv({ adapter: adapterOf(o), n: 1, path: '/wt' });
    }).not.toThrow();
    expect(sync.state).toBe('down');
    expect(sync.error).toContain('object');
    const later = prepareEnv({ adapter: adapterOf(Promise.resolve(o)), n: 1, path: '/wt' });
    await expect(later).resolves.toMatchObject({ state: 'down' });
    expect((await later).error).toContain('object');
  });
});

describe('prepareEnv with an async repair', () => {
  it('waits for the repair before preparing again', async () => {
    const adapter = adapterOf('down', 'up');
    const fix = deferred();
    const repair = vi.fn(() => fix.promise);
    const out = prepareEnv({ adapter, n: 1, path: '/wt', repair });
    expect(isPending(out)).toBe(true);
    await flush();
    expect(adapter.prepare).toHaveBeenCalledTimes(1);
    fix.resolve(true);
    await expect(out).resolves.toEqual({ state: 'up', error: null, repair: true });
    expect(adapter.prepare).toHaveBeenCalledTimes(2);
    expect(repair).toHaveBeenCalledTimes(1);
  });

  it('counts a repair resolving false as failed, without preparing again', async () => {
    const adapter = adapterOf('down', 'up');
    const out = prepareEnv({ adapter, n: 1, path: '/wt', repair: () => Promise.resolve(false) });
    await expect(out).resolves.toEqual({ state: 'down', error: null, repair: false });
    expect(adapter.prepare).toHaveBeenCalledTimes(1);
  });

  it('counts a repair that rejects as failed, with its message, and never rejects', async () => {
    const adapter = adapterOf('down', 'up');
    const out = prepareEnv({ adapter, n: 1, path: '/wt', repair: () => Promise.reject(new Error('Acme runtime missing')) });
    await expect(out).resolves.toEqual({ state: 'down', error: 'Acme runtime missing', repair: false });
    expect(adapter.prepare).toHaveBeenCalledTimes(1);
  });

  it('keeps a sync repair sync', () => {
    expect(isPending(prepareEnv({ adapter: adapterOf('down', 'up'), n: 1, path: '/wt', repair: () => true }))).toBe(false);
    expect(isPending(prepareEnv({ adapter: adapterOf('down'), n: 1, path: '/wt', repair: () => false }))).toBe(false);
  });

  it('holds the slot in pending until the repair settles, then calls later once', async () => {
    const adapter = adapterOf('down', 'up');
    const fix = deferred();
    const pending = pendingPrepares();
    const later = vi.fn();
    const r = prepareSlot({ slot: 'w1', id: 'ACME-1', adapter, n: 1, path: '/wt/1', repair: () => fix.promise, pending, later });
    expect(r).toBe(PENDING);
    await flush();
    expect(pending.has('w1')).toBe(true);
    expect(later).not.toHaveBeenCalled();
    fix.resolve(true);
    await flush();
    expect(pending.has('w1')).toBe(false);
    expect(later).toHaveBeenCalledTimes(1);
    expect(later).toHaveBeenCalledWith({ state: 'up', error: null, repair: true });
  });
});

describe('prepareEnv redacts secrets from its errors', () => {
  it('redacts a token= and a Bearer from a sync throw', () => {
    const out = prepareEnv({ adapter: adapterOf(new Error('acme cli failed: token=abc123secret Bearer xyz.789')), n: 1, path: '/wt' });
    expect(out.state).toBe('down');
    expect(out.error).toContain('acme cli failed');
    expect(out.error).not.toContain('abc123secret');
    expect(out.error).not.toContain('xyz.789');
  });

  it('redacts an sk- key from an async rejection', async () => {
    const out = await prepareEnv({ adapter: adapterOf(Promise.reject(new Error('Acme said no to sk-ant-api03-ABCDEFGHIJKLMNOP'))), n: 1, path: '/wt' });
    expect(out.error).not.toContain('ABCDEFGHIJKLMNOP');
    expect(out.error).toContain('Acme said no');
  });

  it('redacts before it cuts, so no part of a secret at the cut is shown', () => {
    const text = 'a'.repeat(189) + ' sk-ant-api03-ZYXWVUTSRQPONMLK ' + 'b'.repeat(600 - 190 - 30);
    expect(text.length).toBe(600);
    const out = prepareEnv({ adapter: adapterOf(new Error(text)), n: 1, path: '/wt' });
    expect(out.error.length).toBeLessThanOrEqual(200);
    expect(out.error).not.toContain('sk-ant');
    expect(out.error).not.toContain('ZYXW');
  });

  it('keeps the secret out of the reason sent to notify', () => {
    const out = prepareEnv({ adapter: adapterOf(new Error('Acme login: api_key=zzz999 STRIPE_KEY=sk_test_51Habc123456')), n: 1, path: '/wt' });
    const v = envVerdict(out);
    expect(v.action).toBe('down');
    expect(v.reason.startsWith('Its environment would not start: ')).toBe(true);
    expect(v.reason).not.toContain('zzz999');
    expect(v.reason).not.toContain('sk_test_51Habc');
  });

  it('caps a huge error before redacting it, so a long word cannot stall it', () => {
    const text = 'key'.repeat(100_000);
    const start = performance.now();
    const out = prepareEnv({ adapter: adapterOf(new Error(text)), n: 1, path: '/wt' });
    const elapsed = performance.now() - start;
    expect(out.state).toBe('down');
    expect(out.error.length).toBeLessThanOrEqual(200);
    expect(elapsed).toBeLessThan(1000);
  });

  it('redacts all of a quoted secret whose closing quote is past the cap', () => {
    for (const q of ['"', "'"]) {
      const out = prepareEnv({ adapter: adapterOf(new Error(`failed ACME_TOKEN=${q}part1 part2 ${'X'.repeat(4100)}${q}`)), n: 1, path: '/wt' });
      expect(out.state).toBe('down');
      expect(out.error).toContain('failed ACME_TOKEN=');
      expect(out.error).not.toContain('part2');
      expect(out.error).not.toContain('XXXX');
      expect(out.error.length).toBeLessThanOrEqual(200);
    }
  });

  it('never shows part of a key the cap cut, even when redaction pulls it into view', () => {
    const pre = 'Acme failed ';
    const pad = 'c'.repeat(20) + ' ';
    const text = pre + 'eyJ' + 'a'.repeat(1975) + ' ' + 'eyJ' + 'b'.repeat(1975) + ' ' + pad + 'sk-ant-api03-ZYXWVUTSRQPONMLK tail';
    expect(text.indexOf('sk-ant-ap') + 9).toBe(4000);
    const out = prepareEnv({ adapter: adapterOf(new Error(text)), n: 1, path: '/wt' });
    expect(out.error).not.toContain('sk-ant');
    expect(out.error).toContain('Acme failed');
  });

  it('shows nothing of one cut word that redaction shortened', () => {
    const out = prepareEnv({ adapter: adapterOf(new Error('eyJ' + 'a'.repeat(3990) + ',sk-ant-ap' + 'q'.repeat(100))), n: 1, path: '/wt' });
    expect(out.error).toBe('•••');
    expect(out.error).not.toContain('sk-ant');
  });

  it('never empties a cut error, so a throw still never triggers a repair', () => {
    const repair = vi.fn();
    const out = prepareEnv({ adapter: adapterOf(new Error('z'.repeat(5000))), n: 1, path: '/wt', repair });
    expect(out.state).toBe('down');
    expect(out.error).toBeTruthy();
    expect(out.error.length).toBeLessThanOrEqual(200);
    expect(out.repair).toBeNull();
    expect(repair).not.toHaveBeenCalled();
  });

  it('never repairs after a throw whose one cut word redaction shortened', () => {
    const repair = vi.fn(() => true);
    const out = prepareEnv({ adapter: adapterOf(new Error('eyJ' + 'a'.repeat(3990) + ',sk-ant-ap' + 'q'.repeat(100))), n: 1, path: '/wt', repair });
    expect(out).toEqual({ state: 'down', error: '•••', repair: null });
    expect(repair).not.toHaveBeenCalled();
  });

  it('keeps a JSON-escaped quoted secret out of a bad answer', () => {
    const out = prepareEnv({ adapter: adapterOf({ t: 'ACME_TOKEN="alpha bravo charlie"' }), n: 1, path: '/wt' });
    expect(out.state).toBe('down');
    expect(out.error).toContain('ACME_TOKEN=•••');
    for (const word of ['alpha', 'bravo', 'charlie']) expect(out.error).not.toContain(word);
  });

  it('keeps a JSON-escaped quoted secret out when the cap cuts it', () => {
    const out = prepareEnv({ adapter: adapterOf({ t: 'ACME_TOKEN="part1 part2 ' + 'X'.repeat(4100) + '"' }), n: 1, path: '/wt' });
    expect(out.state).toBe('down');
    for (const word of ['part1', 'part2', 'XXXX']) expect(out.error).not.toContain(word);
    expect(out.error.length).toBeLessThanOrEqual('prepare answered '.length + 200 + ', not up, restarted, reset or down'.length);
  });
});

describe('envSweepDue', () => {
  const at = 1_000_000;
  it('is false while a sweep runs', () => {
    expect(envSweepDue({ running: true, lastAt: 0, now: at, everyMs: 60_000 })).toBe(false);
    expect(envSweepDue({ running: true, lastAt: at - 120_000, now: at, everyMs: 60_000 })).toBe(false);
  });
  it('is true before the first sweep', () => {
    expect(envSweepDue({ running: false, lastAt: 0, now: at, everyMs: 60_000 })).toBe(true);
  });
  it('is true once everyMs has passed since the last, and false before', () => {
    expect(envSweepDue({ running: false, lastAt: at - 59_999, now: at, everyMs: 60_000 })).toBe(false);
    expect(envSweepDue({ running: false, lastAt: at - 60_000, now: at, everyMs: 60_000 })).toBe(true);
    expect(envSweepDue({ running: false, lastAt: at - 90_000, now: at, everyMs: 60_000 })).toBe(true);
  });
});

describe('runEnvSweep', () => {
  it('passes the warnings through, redacted and cut to 200 characters', async () => {
    const long = 'x'.repeat(500);
    const adapter = { sweep: async () => ({ deleted: ['ACME-1'], warnings: ['could not delete: api_key=zzz999 STRIPE_KEY=sk_test_51Habc123456', long] }) };
    const { warnings } = await runEnvSweep(adapter);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('could not delete');
    expect(warnings[0]).not.toContain('zzz999');
    expect(warnings[0]).not.toContain('sk_test_51Habc123456');
    expect(warnings[1]).toHaveLength(200);
  });
  it('gives no warning for a clean sweep, sync or async', async () => {
    expect(await runEnvSweep({ sweep: async () => ({ deleted: [], warnings: [] }) })).toEqual({ warnings: [] });
    expect(await runEnvSweep({ sweep: () => ({ deleted: [] }) })).toEqual({ warnings: [] });
  });
  it('turns a throw, a rejection or a non-object answer into one warning, and never rejects', async () => {
    const answers = [
      () => {
        throw new Error('boom sk-ant-api03-ABCDEFGHIJKLMNOP');
      },
      () => Promise.reject(new Error('later boom')),
      () => Promise.reject(undefined),
      () => 'done',
      () => null,
      async () => 42,
      () => {
        throw new Error('y'.repeat(500));
      },
      async () => ['z'.repeat(500)],
    ];
    for (const sweep of answers) {
      const r = await runEnvSweep({ sweep });
      expect(r.warnings, String(sweep)).toHaveLength(1);
      expect(r.warnings[0].length).toBeLessThanOrEqual(200);
      expect(r.warnings[0]).not.toContain('ABCDEFGHIJKLMNOP');
    }
    expect((await runEnvSweep({ sweep: () => { throw new Error('boom'); } })).warnings[0]).toContain('boom');
  });
  it('skips warnings that are not text, and an adapter with no sweep', async () => {
    expect(await runEnvSweep({ sweep: async () => ({ warnings: [5, null, 'ok'] }) })).toEqual({ warnings: ['ok'] });
    expect(await runEnvSweep({})).toEqual({ warnings: [] });
  });

  describe('at a stop', () => {
    it('calls sweep with no arguments without a stop argument, and with { stopping, limitMs } with one', async () => {
      const sweep = vi.fn(async () => ({ warnings: [] }));
      await runEnvSweep({ sweep });
      expect(sweep).toHaveBeenCalledWith();
      sweep.mockClear();
      await runEnvSweep({ sweep }, { limitMs: 5000 });
      expect(sweep).toHaveBeenCalledWith({ stopping: true, limitMs: 5000 });
      expect(sweep).toHaveBeenCalledTimes(1);
    });
    it('keeps a warning of 450 characters whole, cuts one of 900 to 600, and redacts both', async () => {
      const mid = `${'m'.repeat(430)} api_key=zzz999`;
      const adapter = { sweep: async () => ({ warnings: [mid, 'x'.repeat(900)] }) };
      const { warnings } = await runEnvSweep(adapter, { limitMs: 5000 });
      expect(redact(mid).length).toBeGreaterThan(400);
      expect(warnings[0]).toBe(redact(mid));
      expect(warnings[0]).not.toContain('zzz999');
      expect(warnings[1]).toHaveLength(600);
      expect((await runEnvSweep(adapter)).warnings[1]).toHaveLength(200);
      expect((await runEnvSweep(adapter)).warnings[0]).toBe(redact(mid).slice(0, 200));
    });
    it('gives one warning, and no rejection, when the sweep never settles', async () => {
      const sweep = vi.fn(() => new Promise(() => {}));
      const r = await runEnvSweep({ sweep }, { limitMs: 20, backstopMs: 10 });
      expect(r.warnings).toHaveLength(1);
      expect(r.warnings[0]).toMatch(/did not finish within/);
    });
    it('does not wait for the backstop once the sweep has answered', async () => {
      vi.useFakeTimers();
      try {
        const r = await runEnvSweep({ sweep: async () => ({ warnings: ['one'] }) }, { limitMs: 60_000 });
        expect(r).toEqual({ warnings: ['one'] });
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
    it('turns a throw, a rejection or a non-object answer into one warning, never a rejection', async () => {
      const answers = [
        () => {
          throw new Error('boom');
        },
        () => Promise.reject(new Error('later boom')),
        () => 'done',
        () => null,
        async () => ['z'.repeat(900)],
      ];
      for (const sweep of answers) {
        const r = await runEnvSweep({ sweep }, { limitMs: 5000 });
        expect(r.warnings, String(sweep)).toHaveLength(1);
        expect(r.warnings[0].length).toBeLessThanOrEqual(600);
      }
      expect((await runEnvSweep({ sweep: () => { throw new Error('boom'); } }, { limitMs: 5000 })).warnings[0]).toContain('boom');
    });
  });
});

describe('notStartedPatch', () => {
  it('parks a down slot the owner asked to park, keeping its story', () => {
    expect(notStartedPatch({ state: 'down', parkAfter: true, story: { id: 'ACME-1' } })).toEqual({ state: 'parked', parkedFor: 'owner', parkAfter: false, reason: 'Parked by you.' });
  });

  it('parks a building slot the owner asked to park, clearing its story', () => {
    expect(notStartedPatch({ state: 'building', parkAfter: true, story: { id: 'ACME-1' } })).toEqual({ state: 'parked', parkedFor: 'owner', parkAfter: false, reason: 'Parked by you.', story: null });
  });

  it('puts a building slot back to idle', () => {
    expect(notStartedPatch({ state: 'building', story: { id: 'ACME-1' } })).toEqual({ state: 'idle', story: null });
  });

  it('leaves a down slot down', () => {
    expect(notStartedPatch({ state: 'down', story: { id: 'ACME-1' } })).toBeNull();
  });

  it('parks an idle slot the owner asked to park', () => {
    expect(notStartedPatch({ state: 'idle', parkAfter: true, story: null })).toEqual({ state: 'parked', parkedFor: 'owner', parkAfter: false, reason: 'Parked by you.' });
  });

  it('re-parks a parked slot for the owner and clears parkAfter', () => {
    expect(notStartedPatch({ state: 'parked', parkedFor: 'owner', parkAfter: true, story: { id: 'ACME-1' } })).toEqual({ state: 'parked', parkedFor: 'owner', parkAfter: false, reason: 'Parked by you.' });
  });

  it('leaves idle and parked slots alone without parkAfter', () => {
    expect(notStartedPatch({ state: 'idle', story: null })).toBeNull();
    expect(notStartedPatch({ state: 'parked', parkedFor: 'owner', story: null })).toBeNull();
  });

  it('is what the supervisor applies when a session does not start', () => {
    const src = readFileSync(new URL('./supervisor.mjs', import.meta.url), 'utf8');
    expect(src).toContain('notStartedPatch(readSlot(DIR, slot))');
  });
});

describe('sessionStartPatch', () => {
  const AT = '2026-10-30T10:00:00.000Z';
  it('makes the slot building and clears the held story', () => {
    expect(sessionStartPatch({ state: 'idle', heldStory: 'ACME-2', story: null }, 'ACME-2', AT)).toEqual({
      state: 'building',
      reason: '',
      parkedFor: null,
      parkedStory: null,
      result: null,
      heldStory: null,
      lastBeat: AT,
      story: { id: 'ACME-2', title: '', stage: 'starting', detail: '', startedAt: AT, rounds: 0, committedAt: null },
    });
  });
  it('clears the story a crash park kept its claim for', () => {
    const patch = sessionStartPatch({ state: 'idle', parkedFor: null, parkedStory: 'ACME-1', story: null }, 'ACME-2', AT);
    expect(patch).toMatchObject({ state: 'building', parkedFor: null, parkedStory: null, story: { id: 'ACME-2' } });
  });
  it('keeps a story the slot already has, as it is', () => {
    const story = { id: 'ACME-1', title: 'Acme routes', stage: 'build', detail: 'x', startedAt: '2026-10-29T09:00:00.000Z', rounds: 2, committedAt: null };
    expect(sessionStartPatch({ state: 'idle', story }, 'ACME-1', AT).story).toBe(story);
  });

  describe('applied after a held slot is released', () => {
    let dir;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'foreman-session-start-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('clears heldStory and still counts the story, through story.id', () => {
      setSlot(dir, 'w1', { state: 'held', heldStory: 'ACME-2', haltedBy: true, story: { id: 'ACME-2' } });
      setSlot(dir, 'w1', releaseHeld([{ slot: 'w1', st: readSlot(dir, 'w1') }])[0].patch);
      setSlot(dir, 'w1', sessionStartPatch(readSlot(dir, 'w1'), 'ACME-2', AT));
      const st = readSlot(dir, 'w1');
      expect(st.heldStory).toBeNull();
      expect(st).toMatchObject({ state: 'building', story: { id: 'ACME-2', stage: 'starting' } });
      expect(storiesInSlots(dir).has('ACME-2')).toBe(true);
    });
  });

  it('is what the supervisor applies when a session starts', () => {
    const src = readFileSync(new URL('./supervisor.mjs', import.meta.url), 'utf8');
    const start = src.slice(src.indexOf('function startSession('), src.indexOf('function killSession('));
    expect(start).toContain('sessionStartPatch(readSlot(DIR, slot), id, now().toISOString())');
  });
});

envAdapterContract({
  name: 'async fake',
  make: () => ({ env: (n) => ({ FOREMAN_SLOT: `w${n}` }), prepare: async () => 'up' }),
});

// Learned skills, copied from the state folder into a slot worktree. Real temp git repos.
describe('learned skills in a slot', () => {
  const SKILL = '---\nname: foreman-learned-acme-routes\ndescription: Use when adding an Acme route\n---\n## Steps\n...\n';
  const NAME = 'foreman-learned-acme-routes';
  let repos;
  let wt;
  let stateDir;
  const skillFile = (name = NAME) => join(wt, '.claude', 'skills', name, 'SKILL.md');
  const add = (over = {}) => addItem(stateDir, { kind: 'skill', roles: ['developer'], slug: 'acme-routes', text: SKILL, ...over });
  const sync = (config = {}) => syncLearnedSkills({ path: wt, stateDir, config, sh });

  beforeEach(() => {
    repos = makeRepos({ version: 1, project: { name: 'Acme' } });
    const clone = repos.clone('acme');
    wt = join(repos.base, 'w1');
    git(clone, 'worktree', 'add', '-q', '--detach', wt);
    stateDir = join(repos.base, 'state');
  });
  afterEach(() => repos.cleanup());

  describe('copy', () => {
    it('writes a developer skill in force byte for byte, and names it in copied', () => {
      expect(add().ok).toBe(true);
      const r = sync();
      expect(r.warnings).toEqual([]);
      expect(r.copied).toEqual([NAME]);
      expect(readFileSync(skillFile(), 'utf8')).toBe(SKILL);
    });
  });

  describe('refresh', () => {
    it('holds v2 after an update, and removes the folder once the add is undone', () => {
      const { id } = add();
      sync();
      const v2 = SKILL.replace('...', 'Add the route to routes.js.');
      expect(updateItem(stateDir, id, { text: v2 }).ok).toBe(true);
      sync();
      expect(readFileSync(skillFile(), 'utf8')).toBe(v2);
      expect(undoItem(stateDir, id).ok).toBe(true);
      expect(undoItem(stateDir, id).ok).toBe(true);
      const r = sync();
      expect(existsSync(join(wt, '.claude', 'skills', NAME))).toBe(false);
      expect(r.removed).toEqual([NAME]);
      expect(r.copied).toEqual([]);
    });

    it('removes a stale learned folder with no ledger item', () => {
      mkdirSync(join(wt, '.claude', 'skills', 'foreman-learned-old'), { recursive: true });
      writeFileSync(join(wt, '.claude', 'skills', 'foreman-learned-old', 'SKILL.md'), 'old\n');
      const r = sync();
      expect(r.removed).toEqual(['foreman-learned-old']);
      expect(existsSync(join(wt, '.claude', 'skills', 'foreman-learned-old'))).toBe(false);
    });

    it('removes a learned symlink as a link, never following it', () => {
      const target = join(repos.base, 'outside');
      mkdirSync(target);
      writeFileSync(join(target, 'keep.md'), 'keep\n');
      mkdirSync(join(wt, '.claude', 'skills'), { recursive: true });
      symlinkSync(target, join(wt, '.claude', 'skills', 'foreman-learned-link'));
      const r = sync();
      expect(r.removed).toEqual(['foreman-learned-link']);
      expect(readFileSync(join(target, 'keep.md'), 'utf8')).toBe('keep\n');
    });
  });

  describe('excluded from git', () => {
    it('leaves git status empty, with the exclude line written once after two syncs', () => {
      add();
      sync();
      sync();
      expect(existsSync(skillFile())).toBe(true);
      expect(git(wt, 'status', '--porcelain')).toBe('');
      const common = git(wt, 'rev-parse', '--path-format=absolute', '--git-common-dir');
      const lines = readFileSync(join(common, 'info', 'exclude'), 'utf8').split('\n');
      expect(lines.filter((l) => l === '/.claude/skills/foreman-learned-*')).toHaveLength(1);
      expect(lines.filter((l) => l === "# Foreman's learned skills")).toHaveLength(1);
    });
  });

  describe('a pack-locked folder', () => {
    it('is neither rewritten nor removed, with a warning, and a non-prefixed folder is untouched', () => {
      add();
      writeFileSync(join(wt, 'skills-lock.json'), JSON.stringify({ version: 1, skills: { [NAME]: { source: 'acme/skills' } } }));
      mkdirSync(join(wt, '.claude', 'skills', NAME), { recursive: true });
      writeFileSync(skillFile(), 'pack text\n');
      mkdirSync(join(wt, '.claude', 'skills', 'platform-x'), { recursive: true });
      writeFileSync(join(wt, '.claude', 'skills', 'platform-x', 'SKILL.md'), 'platform\n');
      const r = sync();
      expect(readFileSync(skillFile(), 'utf8')).toBe('pack text\n');
      expect(readFileSync(join(wt, '.claude', 'skills', 'platform-x', 'SKILL.md'), 'utf8')).toBe('platform\n');
      expect(r.copied).toEqual([]);
      expect(r.removed).toEqual([]);
      expect(r.warnings).toEqual([`${NAME} is a pack skill; learned skill L-1 not copied`]);
    });
  });

  describe('an unreadable lock', () => {
    it('removes and copies nothing, with one warning', () => {
      add();
      writeFileSync(join(wt, 'skills-lock.json'), '{ not json');
      mkdirSync(join(wt, '.claude', 'skills', 'foreman-learned-old'), { recursive: true });
      const r = sync();
      expect(r).toEqual({ copied: [], removed: [], warnings: ['skills-lock.json could not be read; learned skills not refreshed'] });
      expect(existsSync(join(wt, '.claude', 'skills', 'foreman-learned-old'))).toBe(true);
      expect(existsSync(skillFile())).toBe(false);
    });
  });

  describe('not a git repo', () => {
    it('copies nothing and warns, without throwing', () => {
      add();
      const plain = join(repos.base, 'plain');
      mkdirSync(plain);
      const r = syncLearnedSkills({ path: plain, stateDir, config: {}, sh });
      expect(r.copied).toEqual([]);
      expect(r.warnings).toHaveLength(1);
      expect(existsSync(join(plain, '.claude', 'skills', NAME))).toBe(false);
    });

    it('never throws, even when the shell does', () => {
      add();
      const r = syncLearnedSkills({ path: wt, stateDir, config: {}, sh: () => { throw new Error('boom'); } });
      expect(r.copied).toEqual([]);
      expect(r.warnings).toHaveLength(1);
    });
  });

  describe('apply off', () => {
    it('gives no skills, and sync removes an existing learned folder', () => {
      add();
      sync();
      const off = { learning: { apply: false } };
      expect(learnedSkills({ stateDir, config: off }).skills).toEqual([]);
      const r = sync(off);
      expect(r.removed).toEqual([NAME]);
      expect(existsSync(join(wt, '.claude', 'skills', NAME))).toBe(false);
    });
  });

  describe('fail closed', () => {
    it('does not copy a snapshot edited after the add, and warns', () => {
      const { id, line } = add();
      writeFileSync(join(stateDir, line.after.snapshot), `${SKILL}edited\n`);
      const r = sync();
      expect(r.copied).toEqual([]);
      expect(r.warnings).toHaveLength(1);
      expect(r.warnings[0]).toContain(id);
      expect(existsSync(skillFile())).toBe(false);
    });

    it('skips a skill with no description, with a warning', () => {
      add({ text: '---\nname: foreman-learned-acme-routes\n---\n## Steps\n' });
      const s = learnedSkills({ stateDir, config: {} });
      expect(s.skills).toEqual([]);
      expect(s.warnings).toEqual([`${NAME} has no description`]);
    });

    it('reads the use-when, unquoted and cut to 300 characters', () => {
      add({ text: `---\nname: foreman-learned-acme-routes\ndescription: "Use when ${'a'.repeat(400)}"\n---\n` });
      const [s] = learnedSkills({ stateDir, config: {} }).skills;
      expect(s.use).toHaveLength(300);
      expect(s.use.startsWith('Use when aaa')).toBe(true);
      expect(s).toMatchObject({ id: 'L-1', name: NAME, roles: ['developer'] });
    });
  });

  describe('a block-scalar description', () => {
    const useOf = (text) => {
      add({ text });
      return learnedSkills({ stateDir, config: {} });
    };

    it('joins the indented lines of a folded description into one use-when', () => {
      const r = useOf(`---\nname: ${NAME}\ndescription: >\n  Use when adding\n  an Acme route\n---\n`);
      expect(r.warnings).toEqual([]);
      expect(r.skills[0].use).toBe('Use when adding an Acme route');
    });

    it('reads a literal description', () => {
      const r = useOf(`---\nname: ${NAME}\ndescription: |\n    Use when adding an Acme route  \n---\n`);
      expect(r.skills[0].use).toBe('Use when adding an Acme route');
    });

    it('stops at the next key', () => {
      const r = useOf(`---\ndescription: >-\n  Use when adding\n\n  an Acme route\nname: foo\n---\n`);
      expect(r.skills[0].use).toBe('Use when adding an Acme route');
    });

    it('skips a block scalar with no indented lines, with a warning', () => {
      const r = useOf(`---\ndescription: >\nname: ${NAME}\n---\n`);
      expect(r.skills).toEqual([]);
      expect(r.warnings).toEqual([`${NAME} has no description`]);
    });
  });

  describe('a ledger line with a bad folder name', () => {
    // A hand-made ledger line whose snapshot is valid, so only the folder-name guard stops it.
    const handLine = (path) => {
      mkdirSync(join(stateDir, 'learned', '.history', 'L-1'), { recursive: true });
      writeFileSync(join(stateDir, 'learned', '.history', 'L-1', 'v1.md'), SKILL);
      const line = { at: new Date().toISOString(), id: 'L-1', v: 1, action: 'add', kind: 'skill', roles: ['developer'], path, before: null, after: { snapshot: 'learned/.history/L-1/v1.md', sha256: createHash('sha256').update(SKILL).digest('hex') }, source: null, reason: '', by: 'owner', metrics: null };
      appendFileSync(join(stateDir, 'learning.jsonl'), `${JSON.stringify(line)}\n`);
    };

    it("skips a '..' folder and writes nothing outside .claude/skills", () => {
      handLine('learned/skills/x/../SKILL.md');
      const s = learnedSkills({ stateDir, config: {} });
      expect(s.skills).toEqual([]);
      expect(s.warnings).toEqual(['L-1 has no learned skill folder name; skipped']);
      const r = sync();
      expect(r.copied).toEqual([]);
      expect(existsSync(join(wt, '.claude', 'SKILL.md'))).toBe(false);
      expect(existsSync(join(wt, '.claude', 'skills', '..', 'SKILL.md'))).toBe(false);
    });

    it('skips a folder name that is not lower case', () => {
      handLine('learned/skills/Foreman-Learned-X/SKILL.md');
      const s = learnedSkills({ stateDir, config: {} });
      expect(s.skills).toEqual([]);
      expect(s.warnings).toEqual(['L-1 has no learned skill folder name; skipped']);
      const r = sync();
      expect(r.copied).toEqual([]);
      expect(existsSync(join(wt, '.claude', 'skills', 'Foreman-Learned-X'))).toBe(false);
    });
  });

  describe('a symlinked or odd skills parent', () => {
    const REFUSED = (rel) => `${rel} is a symlink or not a folder; learned skills not refreshed`;
    let outside;
    beforeEach(() => {
      outside = join(repos.base, 'outside');
    });
    const victim = (root) => {
      mkdirSync(join(root, 'foreman-learned-victim'), { recursive: true });
      writeFileSync(join(root, 'foreman-learned-victim', 'SKILL.md'), 'victim\n');
    };

    it('touches nothing when .claude/skills is a symlink', () => {
      victim(outside);
      mkdirSync(join(wt, '.claude'));
      symlinkSync(outside, join(wt, '.claude', 'skills'));
      add();
      const r = sync();
      expect(r).toEqual({ copied: [], removed: [], warnings: [REFUSED('.claude/skills')] });
      expect(existsSync(join(outside, 'foreman-learned-victim', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(outside, NAME))).toBe(false);
    });

    it('touches nothing when .claude is a symlink', () => {
      victim(join(outside, 'skills'));
      symlinkSync(outside, join(wt, '.claude'));
      add();
      const r = sync();
      expect(r).toEqual({ copied: [], removed: [], warnings: [REFUSED('.claude')] });
      expect(existsSync(join(outside, 'skills', 'foreman-learned-victim', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(outside, 'skills', NAME))).toBe(false);
    });

    it('removes nothing through a symlinked .claude/skills with no skills in the ledger', () => {
      victim(outside);
      mkdirSync(join(wt, '.claude'));
      symlinkSync(outside, join(wt, '.claude', 'skills'));
      const r = sync();
      expect(r.removed).toEqual([]);
      expect(existsSync(join(outside, 'foreman-learned-victim', 'SKILL.md'))).toBe(true);
    });

    it('does not throw when .claude/skills is a file', () => {
      mkdirSync(join(wt, '.claude'));
      writeFileSync(join(wt, '.claude', 'skills'), 'not a folder\n');
      add();
      const r = sync();
      expect(r.copied).toEqual([]);
      expect(r.warnings).toEqual([REFUSED('.claude/skills')]);
    });
  });

  describe('learnedSkillsByRole', () => {
    const roles = ['architect', 'tester', 'developer', 'compliance'];
    const entry = (id, name) => ({ id, name, use: name === NAME ? 'Use when adding an Acme route' : 'Use when adding an Acme page', path: `.claude/skills/${name}/SKILL.md` });

    it('lists a developer-only skill under developer only, and an all skill under every role', () => {
      add();
      add({ roles: ['all'], slug: 'acme-pages', text: '---\ndescription: Use when adding an Acme page\n---\n' });
      sync();
      const r = learnedSkillsByRole({ stateDir, config: {}, roles, dir: wt });
      expect(r.byRole.developer).toEqual([entry('L-1', NAME), entry('L-2', 'foreman-learned-acme-pages')]);
      expect(r.byRole.tester).toEqual([entry('L-2', 'foreman-learned-acme-pages')]);
      expect(r.byRole.architect).toEqual([entry('L-2', 'foreman-learned-acme-pages')]);
      expect(r.ids).toEqual(['L-1', 'L-2']);
    });

    it('lists no skill whose file is missing from dir, and leaves out roles with none', () => {
      add();
      const r = learnedSkillsByRole({ stateDir, config: {}, roles, dir: wt });
      expect(r.byRole).toEqual({});
      expect(r.ids).toEqual([]);
      expect(r.warnings.filter((w) => w.includes('not the version in force'))).toEqual([]);
    });

    it('lists a skill only when its slot file is the version in force', () => {
      const { id } = add();
      sync();
      const v2 = SKILL.replace('Use when adding an Acme route', 'Use when adding or moving an Acme route');
      expect(updateItem(stateDir, id, { text: v2 }).ok).toBe(true);
      const stale = learnedSkillsByRole({ stateDir, config: {}, roles, dir: wt });
      expect(stale.byRole).toEqual({});
      expect(stale.ids).toEqual([]);
      expect(stale.warnings).toContain(`${NAME} in the slot is not the version in force; not listed`);
      sync();
      const fresh = learnedSkillsByRole({ stateDir, config: {}, roles, dir: wt });
      expect(fresh.byRole.developer).toEqual([{ id, name: NAME, use: 'Use when adding or moving an Acme route', path: `.claude/skills/${NAME}/SKILL.md` }]);
      expect(fresh.warnings).toEqual([]);
    });

    it('lists nothing with apply off', () => {
      add();
      sync();
      expect(learnedSkillsByRole({ stateDir, config: { learning: { apply: false } }, roles, dir: wt }).byRole).toEqual({});
    });
  });
});
