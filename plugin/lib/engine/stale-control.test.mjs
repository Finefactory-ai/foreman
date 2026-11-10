import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nextStory, readControl, writeControl } from '../console/control.mjs';
import { saveState } from './state.mjs';
import { clearStaleControl, staleControl } from './stale-control.mjs';
import { ADOPTED_FILE, writeAdopted } from './supervisor-pid.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foreman-stale-control-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const t = (s) => new Date(`2026-11-01T09:00:${String(s).padStart(2, '0')}Z`);
const events = () => (existsSync(join(dir, 'events.jsonl')) ? readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const adoptedFile = () => join(dir, ADOPTED_FILE);
const dead = () => false;
const live = () => true;

// A request the supervisor has handled: control.json asks, state.json says it was settled.
function handledRequest(id = 'ACME-1') {
  nextStory(dir, id, t(1));
  const { requestedAt } = readControl(dir);
  saveState(dir, { loop: { state: 'running' }, handledNextAt: requestedAt });
  return requestedAt;
}

describe('staleControl', () => {
  it('finds a request the supervisor already handled', () => {
    const requestedAt = handledRequest();
    expect(staleControl(dir, { alive: live })).toEqual({ nextStory: { id: 'ACME-1', requestedAt }, adopted: null });
  });

  it('leaves an open request alone', () => {
    nextStory(dir, 'ACME-1', t(1));
    saveState(dir, { loop: { state: 'running' }, handledNextAt: 'an older request' });
    expect(staleControl(dir, { alive: live })).toEqual({ nextStory: null, adopted: null });
  });

  it('finds a nextStory with no requestedAt: nothing could ever settle it', () => {
    writeControl(dir, { nextStory: 'ACME-2' });
    expect(staleControl(dir, { alive: live }).nextStory).toEqual({ id: 'ACME-2', requestedAt: undefined });
  });

  it('ignores an empty nextStory and a missing control.json', () => {
    expect(staleControl(dir, { alive: live })).toEqual({ nextStory: null, adopted: null });
    writeControl(dir, { nextStory: '', requestedAt: 'x' });
    expect(staleControl(dir, { alive: live }).nextStory).toBeNull();
  });

  it('finds an adopted file whose voucher is gone', () => {
    writeAdopted(dir, { by: 15565, pids: [15500] });
    const seen = [];
    expect(staleControl(dir, { alive: (pid) => (seen.push(pid), false) }).adopted).toEqual({ by: 15565 });
    expect(seen).toEqual([15565]);
  });

  it('keeps an adopted file whose voucher lives', () => {
    writeAdopted(dir, { by: process.pid, pids: [15500] });
    expect(staleControl(dir).adopted).toBeNull();
    expect(staleControl(dir, { alive: live }).adopted).toBeNull();
  });

  it('finds an adopted file that cannot be read', () => {
    writeFileSync(adoptedFile(), '{not json');
    expect(staleControl(dir, { alive: live }).adopted).toEqual({ by: null });
    writeFileSync(adoptedFile(), JSON.stringify({ by: 'x', pids: [] }));
    expect(staleControl(dir, { alive: live }).adopted).toEqual({ by: null });
  });
});

describe('clearStaleControl', () => {
  it('removes both, keeps requestedAt, and writes exactly one info event naming both', () => {
    const requestedAt = handledRequest();
    writeAdopted(dir, { by: 15565, pids: [15500] });
    const r = clearStaleControl(dir, { alive: dead, now: t(5) });
    expect(readControl(dir)).toEqual({ requestedAt });
    expect(existsSync(adoptedFile())).toBe(false);
    expect(r.cleared).toHaveLength(2);
    expect(events()).toEqual([
      {
        at: t(5).toISOString(),
        text: 'Cleared stale control: the build-next request for ACME-1, already handled; supervisor-adopted.json, which vouched for pid 15565 that is gone.',
        kind: 'info',
        slot: null,
      },
    ]);
  });

  it('clears an unreadable adopted file and says so', () => {
    writeFileSync(adoptedFile(), 'garbage');
    clearStaleControl(dir, { alive: live, now: t(5) });
    expect(existsSync(adoptedFile())).toBe(false);
    expect(events().map((e) => e.text)).toEqual(['Cleared stale control: supervisor-adopted.json, which could not be read.']);
  });

  it('writes nothing and no event when nothing is stale', () => {
    nextStory(dir, 'ACME-1', t(1));
    writeAdopted(dir, { by: process.pid, pids: [] });
    const before = readFileSync(join(dir, 'control.json'), 'utf8');
    expect(clearStaleControl(dir, { alive: live, now: t(5) })).toEqual({ cleared: [] });
    expect(readFileSync(join(dir, 'control.json'), 'utf8')).toBe(before);
    expect(existsSync(adoptedFile())).toBe(true);
    expect(events()).toEqual([]);
  });

  it('writes nothing in an empty folder', () => {
    expect(clearStaleControl(dir, { alive: dead, now: t(5) })).toEqual({ cleared: [] });
    expect(existsSync(join(dir, 'control.json'))).toBe(false);
    expect(existsSync(join(dir, 'events.jsonl'))).toBe(false);
  });

  it('keeps a newer request written before the clear, and does not claim to have cleared it', () => {
    handledRequest('ACME-1');
    writeAdopted(dir, { by: 15565, pids: [] });
    // The owner asks for ACME-2 between the check of the request and the clear.
    const alive = () => {
      nextStory(dir, 'ACME-2', t(3));
      return false;
    };
    const r = clearStaleControl(dir, { alive, now: t(5) });
    expect(readControl(dir).nextStory).toBe('ACME-2');
    expect(r.cleared).toHaveLength(1);
    expect(events().map((e) => e.text)).toEqual(['Cleared stale control: supervisor-adopted.json, which vouched for pid 15565 that is gone.']);
  });
});
