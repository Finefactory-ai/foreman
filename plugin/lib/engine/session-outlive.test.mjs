import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { endedLate, finalResult, outlived, outliveMs, readHead, readTail } from './session-outlive.mjs';

const resultEvent = (text) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, result: text, session_id: 'acme' });
const assistant = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Building ACME-1.' }] } });
const taskStarted = JSON.stringify({ type: 'system', subtype: 'task_started', task_id: 't-1' });
const bg = (tasks) => JSON.stringify({ type: 'system', subtype: 'background_tasks_changed', tasks });
const tail = (...lines) => `${lines.join('\n')}\n`;

describe('finalResult', () => {
  it('reads the result and story of a last result event that carries FACTORY_RESULT', () => {
    expect(finalResult(tail(assistant, resultEvent('All done.\nFACTORY_RESULT: shipped ACME-1')))).toEqual({ result: 'shipped', story: 'ACME-1' });
  });

  it('is still final with a plain stderr line after the result', () => {
    expect(finalResult(tail(assistant, resultEvent('FACTORY_RESULT: shipped ACME-1'), 'Warning: an MCP server did not close'))).toEqual({ result: 'shipped', story: 'ACME-1' });
  });

  it('is null for a result without FACTORY_RESULT, such as a mid-run "pipeline is running" result', () => {
    expect(finalResult(tail(assistant, resultEvent('The pipeline is running; I will wait for it.')))).toBeNull();
  });

  it('is null when a later JSON event follows the final result', () => {
    expect(finalResult(tail(resultEvent('FACTORY_RESULT: shipped ACME-1'), taskStarted))).toBeNull();
  });

  it('is null for an empty tail or a cut-off JSON line', () => {
    expect(finalResult('')).toBeNull();
    expect(finalResult(undefined)).toBeNull();
    expect(finalResult(resultEvent('FACTORY_RESULT: shipped ACME-1').slice(0, 60))).toBeNull();
    // A cut-off result after a whole assistant event: the last whole event is not a result.
    expect(finalResult(`${assistant}\n${resultEvent('FACTORY_RESULT: shipped ACME-1').slice(0, 60)}`)).toBeNull();
  });

  it('is null for an unknown result word', () => {
    expect(finalResult(tail(resultEvent('FACTORY_RESULT: maybe ACME-1')))).toBeNull();
  });

  it('is null when the last event is not a result', () => {
    expect(finalResult(tail(resultEvent('FACTORY_RESULT: shipped ACME-1'), assistant))).toBeNull();
  });

  it('is null while the nearest earlier background_tasks_changed lists a task', () => {
    expect(finalResult(tail(bg([{ task_id: 't-1' }]), resultEvent('FACTORY_RESULT: shipped ACME-1')))).toBeNull();
  });

  it('is final again once a later background_tasks_changed lists none', () => {
    expect(finalResult(tail(bg([{ task_id: 't-1' }]), bg([]), resultEvent('FACTORY_RESULT: shipped ACME-1')))).toEqual({ result: 'shipped', story: 'ACME-1' });
  });

  it('gives a null story for FACTORY_RESULT: empty -', () => {
    expect(finalResult(tail(resultEvent('FACTORY_RESULT: empty -')))).toEqual({ result: 'empty', story: null });
  });
});

describe('outlived', () => {
  const now = 1_000_000;
  const done = tail(resultEvent('FACTORY_RESULT: blocked ACME-1'));

  it('is null within the grace', () => {
    expect(outlived({ tail: done, quietSince: now - 59_000, now, graceMs: 60_000 })).toBeNull();
  });

  it('gives the result, the story and how long it has outlived it at or after the grace', () => {
    expect(outlived({ tail: done, quietSince: now - 60_000, now, graceMs: 60_000 })).toEqual({ result: 'blocked', story: 'ACME-1', forMs: 60_000 });
    expect(outlived({ tail: done, quietSince: now - 90_000, now, graceMs: 60_000 })).toEqual({ result: 'blocked', story: 'ACME-1', forMs: 90_000 });
  });

  it('is null after the grace when there is no final result', () => {
    expect(outlived({ tail: tail(assistant), quietSince: now - 600_000, now, graceMs: 60_000 })).toBeNull();
    expect(outlived({ tail: tail(resultEvent('Still working.')), quietSince: now - 600_000, now, graceMs: 60_000 })).toBeNull();
    expect(outlived({ tail: '', quietSince: now - 600_000, now, graceMs: 60_000 })).toBeNull();
  });
});

describe('endedLate', () => {
  const endedAt = '2026-10-30T10:00:00.000Z';
  const at = Date.parse(endedAt);
  const slotResult = { id: 'ACME-1', result: 'blocked', endedAt };
  const base = { slotResult, slotStory: null, id: 'ACME-1', graceMs: 60_000 };

  it('gives the result and how long ago it was recorded once the grace has passed, also at exactly the grace', () => {
    expect(endedLate({ ...base, now: at + 61_000 })).toEqual({ result: 'blocked', forMs: 61_000 });
    expect(endedLate({ ...base, now: at + 60_000 })).toEqual({ result: 'blocked', forMs: 60_000 });
  });

  it('is null inside the grace', () => {
    expect(endedLate({ ...base, now: at + 59_000 })).toBeNull();
  });

  it('is null when the result belongs to another story', () => {
    expect(endedLate({ ...base, slotResult: { ...slotResult, id: 'ACME-2' }, now: at + 61_000 })).toBeNull();
  });

  it('is null when the slot holds a story again', () => {
    expect(endedLate({ ...base, slotStory: { id: 'ACME-1' }, now: at + 61_000 })).toBeNull();
  });

  it('is null without a result, for a result word that is not known, and for an endedAt that does not parse', () => {
    expect(endedLate({ ...base, slotResult: null, now: at + 61_000 })).toBeNull();
    expect(endedLate({ ...base, slotResult: { ...slotResult, result: 'interrupted' }, now: at + 61_000 })).toBeNull();
    expect(endedLate({ ...base, slotResult: { ...slotResult, endedAt: 'nope' }, now: at + 61_000 })).toBeNull();
  });

  it('is null past the grace when the log tail holds a printed final result', () => {
    const tailOf = () => tail(resultEvent('FACTORY_RESULT: blocked ACME-1'));
    expect(endedLate({ ...base, tailOf, now: at + 61_000 })).toBeNull();
  });

  it('still ends it past the grace when the tail has no final result', () => {
    const ended = { result: 'blocked', forMs: 61_000 };
    expect(endedLate({ ...base, tailOf: () => tail(resultEvent('Still working.')), now: at + 61_000 })).toEqual(ended);
    // The result was printed but a task is still open: the workflow case.
    expect(endedLate({ ...base, tailOf: () => tail(bg([{ task_id: 't-1' }]), resultEvent('FACTORY_RESULT: blocked ACME-1')), now: at + 61_000 })).toEqual(ended);
    expect(endedLate({ ...base, tailOf: () => '', now: at + 61_000 })).toEqual(ended);
  });

  it('reads the tail only once the grace has passed', () => {
    const tailOf = vi.fn(() => '');
    expect(endedLate({ ...base, tailOf, now: at + 59_000 })).toBeNull();
    expect(tailOf).not.toHaveBeenCalled();
    expect(endedLate({ ...base, tailOf, now: at + 61_000 })).toEqual({ result: 'blocked', forMs: 61_000 });
    expect(tailOf).toHaveBeenCalledTimes(1);
  });
});

describe('outliveMs', () => {
  it('is a minute by default', () => {
    expect(outliveMs({})).toBe(60_000);
    expect(outliveMs(undefined)).toBe(60_000);
    expect(outliveMs({ watchdog: { quietMinutes: 30 } })).toBe(60_000);
  });

  it('follows watchdog.outliveMinutes', () => {
    expect(outliveMs({ watchdog: { outliveMinutes: 0.05 } })).toBe(3000);
  });
});

describe('readTail', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-outlive-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('gives the whole of a small file', () => {
    const file = join(dir, 'w1.log');
    writeFileSync(file, 'one\ntwo\nthree\n');
    expect(readTail(file)).toBe('one\ntwo\nthree\n');
  });

  it('drops the partial first line of a file larger than the bytes asked for', () => {
    const file = join(dir, 'w1.log');
    writeFileSync(file, `${'a'.repeat(100)}\nsecond line\nthird line\n`);
    expect(readTail(file, 30)).toBe('second line\nthird line\n');
    expect(readTail(file, 20)).toBe('third line\n');
  });

  it("gives '' for a missing file", () => {
    expect(readTail(join(dir, 'missing.log'))).toBe('');
  });
});

describe('readHead', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-outlive-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('gives the whole lines of a small file, not cut', () => {
    const file = join(dir, 'w1.log');
    writeFileSync(file, 'one\ntwo\nthree');
    expect(readHead(file)).toEqual({ text: 'one\ntwo\n', cut: false });
    writeFileSync(file, 'one\ntwo\n');
    expect(readHead(file)).toEqual({ text: 'one\ntwo\n', cut: false });
  });

  it('gives only the whole lines within the bytes of a larger file, and says it is cut', () => {
    const file = join(dir, 'w1.log');
    writeFileSync(file, 'first line\nsecond line\nthird line\n');
    expect(readHead(file, 25)).toEqual({ text: 'first line\nsecond line\n', cut: true });
    expect(readHead(file, 22)).toEqual({ text: 'first line\n', cut: true });
    expect(readHead(file, 5)).toEqual({ text: '', cut: true });
  });

  it('is not cut when the file is exactly the bytes asked for', () => {
    const file = join(dir, 'w1.log');
    writeFileSync(file, 'one\ntwo\n');
    expect(readHead(file, 8)).toEqual({ text: 'one\ntwo\n', cut: false });
  });

  it("gives { text: '', cut: false } for a missing file", () => {
    expect(readHead(join(dir, 'missing.log'))).toEqual({ text: '', cut: false });
  });
});
