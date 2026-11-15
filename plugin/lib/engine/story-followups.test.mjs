// What a shipped ending, a cleared halt and a story done by another path close on Waiting on you
// (story-followups.mjs): the wiring around the pure helpers, with a stubbed run context and the real
// files console over a temp folder.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { OPTIONS } from './answers.mjs';
import * as ctx from './run-context.mjs';
import { closeDoneHaltTasks, closeHaltTasks, closeShippedAsks } from './story-followups.mjs';
import * as decisions from '../console/decisions.mjs';

vi.mock('./run-context.mjs', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const DIR = mkdtempSync(join(tmpdir(), 'acme-followups-'));
  const fake = { list: [], inHand: [], throws: false };
  return {
    DIR,
    HALT: join(DIR, 'HALT'),
    CONFIG: {},
    LIVE: {},
    ROOT: DIR,
    now: () => new Date(),
    state: () => ({}),
    guarded: (_what, fn) => fn,
    event: vi.fn(),
    fake,
    stories: () => {
      if (fake.throws) throw new Error('the story source is down');
      return { list: () => fake.list, idPattern: 'ACME-\\d+' };
    },
    inHandSessions: () => fake.inHand,
    work: [],
  };
});

const { DIR, HALT, event, fake, work } = ctx;

const HALT_TITLE = (id) => `${id} stopped the release line`;
const T0 = Date.parse('2026-11-10T10:00:00.000Z');
const at = (ms) => new Date(ms);
const addTask = (story, title = HALT_TITLE(story), createdAt = T0 - 1000) => ({ id: decisions.add(DIR, { story, kind: 'task', urgent: true, title, body: 'Deploy failed.' }, at(createdAt)) });
const answerIt = (item) => decisions.answer(DIR, item.id, { option: 'Retry the story', note: 'x' });
const byId = (item) => decisions.list(DIR).find((d) => d.id === item.id);
const events = () => event.mock.calls.map((c) => c[0]);
const warns = () => event.mock.calls.filter((c) => c[1] === 'warn').map((c) => c[0]);

let sweepAt = 10 ** 13;
const nextSweep = () => (sweepAt += 61_000);

beforeEach(() => {
  rmSync(`${DIR}/decisions`, { recursive: true, force: true });
  rmSync(HALT, { force: true });
  fake.list = [];
  fake.inHand = [];
  fake.throws = false;
  work.length = 0;
  event.mockClear();
});
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

describe('closeHaltTasks: a halt was cleared', () => {
  it("closes the unanswered halt tasks of every story created by then, and says so", async () => {
    const one = addTask('ACME-1');
    const two = addTask('ACME-2');
    await closeHaltTasks(at(T0));
    expect(byId(one).appliedAt).toBeTruthy();
    expect(byId(two).appliedAt).toBeTruthy();
    expect(events()).toContain('Closed "ACME-1 stopped the release line" on Waiting on you: the halt is cleared.');
    expect(events()).toContain('Closed "ACME-2 stopped the release line" on Waiting on you: the halt is cleared.');
  });

  it('leaves a halt task created after the clear open', async () => {
    const later = addTask('ACME-1', HALT_TITLE('ACME-1'), T0 + 1);
    await closeHaltTasks(at(T0));
    expect(byId(later).appliedAt).toBeNull();
    expect(events()).toEqual([]);
  });

  it('leaves an answered halt task open, its answer kept', async () => {
    const item = addTask('ACME-1');
    answerIt(item);
    await closeHaltTasks(at(T0));
    expect(byId(item).appliedAt).toBeNull();
    expect(byId(item).answer.option).toBe('Retry the story');
    expect(events()).toEqual([]);
  });

  it("leaves an urgent task that is not the halt's open", async () => {
    const key = addTask('ACME-1', 'ACME-1 needs a key');
    await closeHaltTasks(at(T0));
    expect(byId(key).appliedAt).toBeNull();
  });
});

describe('closeShippedAsks: a story shipped', () => {
  it("closes the story's release decision and its halt task, answered or not, and nothing else", async () => {
    const release = { id: decisions.add(DIR, { story: 'ACME-1', kind: 'decision', title: 'ACME-1 could not be released', options: OPTIONS.release }, at(T0)) };
    const halt = addTask('ACME-1');
    answerIt(halt);
    const otherHalt = addTask('ACME-2');
    const key = addTask('ACME-1', 'ACME-1 needs a key');
    await closeShippedAsks('w1', 'ACME-1');
    expect(byId(release).appliedAt).toBeTruthy();
    expect(byId(halt).appliedAt).toBeTruthy();
    expect(byId(otherHalt).appliedAt).toBeNull();
    expect(byId(key).appliedAt).toBeNull();
    expect(events()).toContain('ACME-1 shipped; closed "ACME-1 stopped the release line" on Waiting on you.');
    expect(events()).toContain('ACME-1 shipped; closed "ACME-1 could not be released" on Waiting on you.');
  });
});

describe('closeDoneHaltTasks: a story done by another path', () => {
  const done = (id) => ({ id, status: 'done' });
  const blocked = (id) => ({ id, status: 'blocked' });

  it("closes the halt task of a done story, answered or not, and no other item", async () => {
    fake.list = [done('ACME-1'), blocked('ACME-2'), done('ACME-3')];
    const one = addTask('ACME-1');
    const two = addTask('ACME-2');
    const three = addTask('ACME-3');
    answerIt(three);
    const key = addTask('ACME-1', 'ACME-1 needs a key');
    await closeDoneHaltTasks(nextSweep());
    expect(byId(one).appliedAt).toBeTruthy();
    expect(byId(three).appliedAt).toBeTruthy();
    expect(byId(two).appliedAt).toBeNull();
    expect(byId(key).appliedAt).toBeNull();
    expect(events()).toContain('ACME-1 is done; closed "ACME-1 stopped the release line" on Waiting on you.');
    expect(events()).toContain('ACME-3 is done; closed "ACME-3 stopped the release line" on Waiting on you.');
    expect(events()).toHaveLength(2);
  });

  it('closes nothing while the release line is still halted', async () => {
    fake.list = [done('ACME-1')];
    const one = addTask('ACME-1');
    writeFileSync(HALT, 'A release failed.\n');
    await closeDoneHaltTasks(nextSweep());
    expect(byId(one).appliedAt).toBeNull();
  });

  it('leaves the task of a story a session or queued work holds', async () => {
    fake.list = [done('ACME-1')];
    const one = addTask('ACME-1');
    fake.inHand = [{ id: 'ACME-1' }];
    await closeDoneHaltTasks(nextSweep());
    expect(byId(one).appliedAt).toBeNull();
    fake.inHand = [];
    work.push({ id: 'ACME-1' });
    await closeDoneHaltTasks(nextSweep());
    expect(byId(one).appliedAt).toBeNull();
    work.length = 0;
    await closeDoneHaltTasks(nextSweep());
    expect(byId(one).appliedAt).toBeTruthy();
  });

  it('sweeps at most once a minute', async () => {
    fake.list = [done('ACME-1')];
    const t = nextSweep();
    const first = addTask('ACME-1');
    await closeDoneHaltTasks(t);
    expect(byId(first).appliedAt).toBeTruthy();
    const second = addTask('ACME-1');
    await closeDoneHaltTasks(t + 1000);
    expect(byId(second).appliedAt).toBeNull();
    await closeDoneHaltTasks(t + 60_000);
    expect(byId(second).appliedAt).toBeTruthy();
    sweepAt = t + 60_000; // the shared clock moves past the last sweep, so the next test is not throttled
  });

  it('warns and resolves when the story source cannot be read, and sweeps again after the interval', async () => {
    const one = addTask('ACME-1');
    fake.throws = true;
    await expect(closeDoneHaltTasks(nextSweep())).resolves.toBeUndefined();
    expect(warns()).toHaveLength(1);
    expect(warns()[0]).toMatch(/^Could not close the halt tasks of done stories on Waiting on you: the story source is down/);
    expect(byId(one).appliedAt).toBeNull();
    fake.throws = false;
    fake.list = [done('ACME-1')];
    await closeDoneHaltTasks(nextSweep());
    expect(byId(one).appliedAt).toBeTruthy();
  });
});
