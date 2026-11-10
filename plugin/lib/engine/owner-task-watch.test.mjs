// How long an owner task has held a story, and the one time it is told to the owner.
import { describe, expect, it } from 'vitest';
import { buildEmail } from '../notify/email.mjs';
import { OWNER_TASK_HOURS, ownerTaskHours, ownerTaskText, ownerTaskWatch } from './owner-task-watch.mjs';

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 25, 9, 0, 0);
const at = (ms) => new Date(T0 + ms);
const task = (id = 'ACME-1', over = {}) => ({ id: `task:${id}`, kind: 'owner-task', title: 'Add the key (owner task)', group: 'now', blocks: ['ACME-2'], frees: ['ACME-2'], ...over });

describe('ownerTaskWatch', () => {
  it('records the first sight and tells nothing', () => {
    const r = ownerTaskWatch({ seen: {}, items: [task()], now: at(0), hours: 24 });
    expect(r.seen).toEqual({ 'ACME-1': { since: at(0).toISOString(), told: false } });
    expect(r.tell).toEqual([]);
    expect(r.changed).toBe(true);
  });

  it('tells nothing a minute before the limit', () => {
    const first = ownerTaskWatch({ items: [task()], now: at(0), hours: 24 });
    const r = ownerTaskWatch({ seen: first.seen, items: [task()], now: at(24 * H - 60_000), hours: 24 });
    expect(r.tell).toEqual([]);
    expect(r.changed).toBe(false);
  });

  it('tells once at the limit, and nothing after', () => {
    const first = ownerTaskWatch({ items: [task()], now: at(0), hours: 24 });
    const r = ownerTaskWatch({ seen: first.seen, items: [task()], now: at(24 * H), hours: 24 });
    expect(r.tell).toEqual([{ task: 'ACME-1', title: 'Add the key (owner task)', holds: ['ACME-2'], since: at(0).toISOString() }]);
    expect(r.seen['ACME-1']).toEqual({ since: at(0).toISOString(), told: true });
    expect(r.changed).toBe(true);
    const later = ownerTaskWatch({ seen: r.seen, items: [task()], now: at(30 * H), hours: 24 });
    expect(later.tell).toEqual([]);
    expect(later.changed).toBe(false);
    expect(later.seen).toEqual(r.seen);
  });

  it('drops a task that is gone, and starts a fresh clock when it returns', () => {
    const first = ownerTaskWatch({ items: [task()], now: at(0), hours: 24 });
    const told = ownerTaskWatch({ seen: first.seen, items: [task()], now: at(25 * H), hours: 24 });
    const gone = ownerTaskWatch({ seen: told.seen, items: [], now: at(26 * H), hours: 24 });
    expect(gone.seen).toEqual({});
    expect(gone.changed).toBe(true);
    const back = ownerTaskWatch({ seen: gone.seen, items: [task()], now: at(27 * H), hours: 24 });
    expect(back.seen['ACME-1']).toEqual({ since: at(27 * H).toISOString(), told: false });
    expect(back.tell).toEqual([]);
  });

  it('never watches a later task, a task that blocks nothing, or another kind of item', () => {
    const items = [task('ACME-1', { group: 'later' }), task('ACME-3', { blocks: [], frees: [] }), task('ACME-4', { kind: 'decision' }), { id: 'x', kind: 'owner-task', group: 'now' }];
    const r = ownerTaskWatch({ seen: {}, items, now: at(0), hours: 24 });
    expect(r.seen).toEqual({});
    expect(r.changed).toBe(false);
  });

  it('resets a broken since to now', () => {
    for (const since of ['yesterday', '', 42, null]) {
      const r = ownerTaskWatch({ seen: { 'ACME-1': { since, told: true } }, items: [task()], now: at(5 * H), hours: 24 });
      expect(r.seen['ACME-1'], String(since)).toEqual({ since: at(5 * H).toISOString(), told: false });
      expect(r.tell).toEqual([]);
    }
  });

  it('honours the hours, fractions too', () => {
    const first = ownerTaskWatch({ items: [task()], now: at(0), hours: 0.5 });
    expect(ownerTaskWatch({ seen: first.seen, items: [task()], now: at(29 * 60_000), hours: 0.5 }).tell).toEqual([]);
    expect(ownerTaskWatch({ seen: first.seen, items: [task()], now: at(30 * 60_000), hours: 0.5 }).tell).toHaveLength(1);
    expect(ownerTaskWatch({ seen: first.seen, items: [task()], now: at(2 * H), hours: 3 }).tell).toEqual([]);
  });

  it('does not change what it was given', () => {
    const seen = { 'ACME-1': { since: at(0).toISOString(), told: false } };
    ownerTaskWatch({ seen, items: [task()], now: at(25 * H), hours: 24 });
    expect(seen['ACME-1'].told).toBe(false);
  });
});

describe('ownerTaskHours', () => {
  it('is 24 unless the config says otherwise', () => {
    expect(OWNER_TASK_HOURS).toBe(24);
    expect(ownerTaskHours({})).toBe(24);
    expect(ownerTaskHours(null)).toBe(24);
    expect(ownerTaskHours({ watchdog: { ownerTaskHours: 2 } })).toBe(2);
    expect(ownerTaskHours({ watchdog: { ownerTaskHours: 0.001 } })).toBe(0.001);
  });
});

describe('ownerTaskText', () => {
  const since = (ms) => at(0 - ms).toISOString();
  const t = (over = {}) => ({ task: 'ACME-1', title: 'Add the key', holds: ['ACME-2'], since: since(0), ...over });

  it('gives days, hours and minutes', () => {
    expect(ownerTaskText(t({ since: since(5 * 24 * H + H) }), at(0))).toBe('Owner task ACME-1 "Add the key" has held ACME-2 for 5 days.');
    expect(ownerTaskText(t({ since: since(26 * H + 59 * 60_000) }), at(0))).toBe('Owner task ACME-1 "Add the key" has held ACME-2 for 26 h.');
    expect(ownerTaskText(t({ since: since(3 * 60_000) }), at(0))).toBe('Owner task ACME-1 "Add the key" has held ACME-2 for 3 min.');
    expect(ownerTaskText(t({ since: since(5000) }), at(0))).toContain('for 1 min.');
    expect(ownerTaskText(t({ since: since(47 * H) }), at(0))).toContain('for 47 h.');
    expect(ownerTaskText(t({ since: since(48 * H) }), at(0))).toContain('for 2 days.');
  });

  it('leaves out an empty title, and names several holds', () => {
    expect(ownerTaskText(t({ title: '', holds: ['ACME-2', 'ACME-3'], since: since(30 * H) }), at(0))).toBe('Owner task ACME-1 has held ACME-2 and ACME-3 for 30 h.');
    expect(ownerTaskText(t({ holds: ['A-1', 'A-2', 'A-3', 'A-4', 'A-5'], since: since(30 * H) }), at(0))).toContain('has held A-1, A-2 and 3 more for');
  });

  const LINK = '[Fix it](https://evil.example)';

  it('turns square brackets in the title into parentheses, so it cannot form a link', () => {
    expect(ownerTaskText(t({ title: LINK, since: since(30 * H) }), at(0))).toBe('Owner task ACME-1 "(Fix it)(https://evil.example)" has held ACME-2 for 30 h.');
    expect(ownerTaskText(t({ title: '[Spike] Add the key', since: since(30 * H) }), at(0))).toBe('Owner task ACME-1 "(Spike) Add the key" has held ACME-2 for 30 h.');
    expect(ownerTaskText(t({ title: '[[a](b)](https://evil.example)', since: since(30 * H) }), at(0))).not.toMatch(/[[\]]/);
  });

  it('gives an owner-task email with no link from the title', () => {
    for (const title of [LINK, '[[a](b)](https://evil.example)']) {
      const reason = ownerTaskText(t({ title, since: since(30 * H) }), at(0));
      const mail = buildEmail({ kind: 'owner-task', reason, story: { id: 'ACME-2' }, project: { name: 'Acme' }, now: at(0) });
      expect(mail.html).not.toMatch(/<a [^>]*evil\.example/);
    }
    const reason = ownerTaskText(t({ title: LINK, since: since(30 * H) }), at(0));
    const mail = buildEmail({ kind: 'owner-task', reason, story: { id: 'ACME-2' }, project: { name: 'Acme' }, now: at(0) });
    expect(mail.html).toContain('(Fix it)(https://evil.example)');
  });
});
