import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { aliveIn, breakIfStale, claimFile, claims, dropOwnerClaim, forceSet, holderOf, holdsResource, holdsSchema, letGoClaim, ownerClaim, release, SCHEMA, setStage, take, takeSchema } from './locks.mjs';
import { ADOPTED_FILE, writeAdopted } from './supervisor-pid.mjs';

let dir;
const live = new Set([100, 200]);
const isAlive = (pid) => pid === null || live.has(pid);
const h = (pid, extra = {}) => ({ pid, slot: 'w1', story: 'P7-01', by: 'factory', at: '2026-10-15T10:00:00Z', ...extra });

beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'factory-locks-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('take', () => {
  it('takes a free lock and writes the holder', () => {
    const r = take(SCHEMA(dir), h(100), isAlive);
    expect(r.ok).toBe(true);
    expect(JSON.parse(readFileSync(SCHEMA(dir), 'utf8')).pid).toBe(100);
  });
  it('refuses a held lock and says whether it is stale', () => {
    take(SCHEMA(dir), h(100), isAlive);
    expect(take(SCHEMA(dir), h(200), isAlive)).toMatchObject({ ok: false, stale: false, holder: { pid: 100 } });
    live.delete(100);
    expect(take(SCHEMA(dir), h(200), isAlive)).toMatchObject({ ok: false, stale: true });
    live.add(100);
  });
  it('never treats an owner claim as stale', () => {
    forceSet(claimFile(dir, 'P7-01'), h(null, { by: 'owner', slot: null }));
    expect(holderOf(claimFile(dir, 'P7-01'), isAlive).stale).toBe(false);
  });
});

describe('release and stale locks', () => {
  it('releases only for the holder', () => {
    take(SCHEMA(dir), h(100), isAlive);
    expect(release(SCHEMA(dir), 200)).toBe(false);
    expect(existsSync(SCHEMA(dir))).toBe(true);
    expect(release(SCHEMA(dir), 100)).toBe(true);
    expect(existsSync(SCHEMA(dir))).toBe(false);
  });
  it('breaks a stale lock and returns who held it', () => {
    take(SCHEMA(dir), h(999), isAlive);
    expect(breakIfStale(SCHEMA(dir), isAlive)).toMatchObject({ pid: 999 });
    expect(existsSync(SCHEMA(dir))).toBe(false);
    take(SCHEMA(dir), h(100), isAlive);
    expect(breakIfStale(SCHEMA(dir), isAlive)).toBe(null);
  });
  it('records the release stage on a lock it holds', () => {
    const ship = join(dir, 'locks', 'ship.json');
    take(ship, h(100), isAlive);
    setStage(ship, 100, 'ci');
    expect(holderOf(ship, isAlive).stage).toBe('ci');
    setStage(ship, 200, 'merge');
    expect(holderOf(ship, isAlive).stage).toBe('ci');
  });
});

describe('claims', () => {
  it('lists claims with their story ids', () => {
    take(claimFile(dir, 'P8-02'), h(100, { story: 'P8-02' }), isAlive);
    take(claimFile(dir, 'P7-01'), h(999), isAlive);
    expect(claims(dir, isAlive).map((c) => [c.id, c.stale])).toEqual([
      ['P7-01', true],
      ['P8-02', false],
    ]);
  });
  it('is empty when nothing was ever claimed', () => {
    expect(claims(dir, isAlive)).toEqual([]);
  });
  it('works out stale on every call, so an unchanged file turns stale when its pid exits', () => {
    take(claimFile(dir, 'P8-02'), h(100, { story: 'P8-02' }), isAlive);
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(claimFile(dir, 'P8-02'), past, past);
    utimesSync(join(dir, 'claims'), past, past);
    const running = new Set([100]);
    const check = (pid) => running.has(pid);
    expect(claims(dir, check).map((c) => [c.id, c.stale])).toEqual([['P8-02', false]]);
    running.delete(100);
    expect(claims(dir, check).map((c) => [c.id, c.stale])).toEqual([['P8-02', true]]);
  });
  it('drops a claim that was removed between two calls, and shows one added', () => {
    take(claimFile(dir, 'P8-02'), h(100, { story: 'P8-02' }), isAlive);
    expect(claims(dir, isAlive).map((c) => c.id)).toEqual(['P8-02']);
    rmSync(claimFile(dir, 'P8-02'));
    expect(claims(dir, isAlive)).toEqual([]);
    ownerClaim(dir, 'P8-03');
    expect(claims(dir, isAlive).map((c) => c.id)).toEqual(['P8-03']);
  });
  it('reads a file that is not JSON as stale', () => {
    mkdirSync(join(dir, 'claims'), { recursive: true });
    writeFileSync(claimFile(dir, 'P8-04'), '{nope');
    expect(claims(dir, isAlive).map((c) => [c.id, c.stale])).toEqual([['P8-04', true]]);
  });
});

// Task 13: "I'll take it" on the decisions page hands the story to the owner.
describe('ownerClaim', () => {
  it('passes a factory claim to the owner, and the claim never goes stale', () => {
    take(claimFile(dir, 'P7-01'), h(999), isAlive);
    const holder = ownerClaim(dir, 'P7-01', new Date('2026-10-15T12:00:00Z'));
    expect(holder).toEqual({ pid: null, slot: null, story: 'P7-01', by: 'owner', at: '2026-10-15T12:00:00.000Z' });
    expect(holderOf(claimFile(dir, 'P7-01'), isAlive)).toEqual({ ...holder, stale: false });
    expect(take(claimFile(dir, 'P7-01'), h(100), isAlive)).toMatchObject({ ok: false, stale: false, holder: { by: 'owner' } });
  });
  it('claims a story nobody held', () => {
    ownerClaim(dir, 'P8-03');
    expect(claims(dir, isAlive)).toMatchObject([{ id: 'P8-03', by: 'owner', pid: null, stale: false }]);
  });
});

describe('letGoClaim', () => {
  const acme = (pid, extra = {}) => h(pid, { story: 'ACME-1', ...extra });

  it('removes a factory claim held under one of its own pids, and returns the holder', () => {
    forceSet(claimFile(dir, 'ACME-1'), acme(100));
    expect(letGoClaim(dir, 'ACME-1', new Set([100]), isAlive)).toEqual(acme(100));
    expect(existsSync(claimFile(dir, 'ACME-1'))).toBe(false);
  });
  it('removes a factory claim whose pid is gone', () => {
    forceSet(claimFile(dir, 'ACME-1'), acme(999));
    expect(letGoClaim(dir, 'ACME-1', new Set([100]), () => false)).toEqual(acme(999));
    expect(existsSync(claimFile(dir, 'ACME-1'))).toBe(false);
  });
  it('removes a claim file that cannot be read', () => {
    mkdirSync(join(dir, 'claims'), { recursive: true });
    writeFileSync(claimFile(dir, 'ACME-1'), 'not json');
    expect(letGoClaim(dir, 'ACME-1', new Set([100]), isAlive)).toEqual({});
    expect(existsSync(claimFile(dir, 'ACME-1'))).toBe(false);
  });
  it('leaves an owner claim', () => {
    ownerClaim(dir, 'ACME-1');
    expect(letGoClaim(dir, 'ACME-1', new Set([100]), isAlive)).toBeNull();
    expect(existsSync(claimFile(dir, 'ACME-1'))).toBe(true);
  });
  it('leaves a factory claim another live pid holds', () => {
    forceSet(claimFile(dir, 'ACME-1'), acme(200));
    expect(letGoClaim(dir, 'ACME-1', new Set([100]), isAlive)).toBeNull();
    expect(existsSync(claimFile(dir, 'ACME-1'))).toBe(true);
  });
  it('returns null when there is no claim', () => expect(letGoClaim(dir, 'ACME-1', new Set([100]), isAlive)).toBeNull());
  it('leaves a claim file that is JSON without a pid, whatever its by says', () => {
    mkdirSync(join(dir, 'claims'), { recursive: true });
    for (const by of ['owner', 'factory']) {
      writeFileSync(claimFile(dir, 'ACME-1'), JSON.stringify({ by, story: 'ACME-1' }));
      expect(letGoClaim(dir, 'ACME-1', new Set([100]), isAlive)).toBeNull();
      expect(existsSync(claimFile(dir, 'ACME-1'))).toBe(true);
    }
  });
  it('leaves the claim when the owner takes it after it was read', () => {
    forceSet(claimFile(dir, 'ACME-1'), acme(999));
    const late = (pid) => {
      if (pid === 999) ownerClaim(dir, 'ACME-1');
      return false;
    };
    expect(letGoClaim(dir, 'ACME-1', new Set([100]), late)).toBeNull();
    expect(holderOf(claimFile(dir, 'ACME-1'), isAlive).by).toBe('owner');
  });
  it('leaves the claim when another factory claim replaces it after it was read', () => {
    forceSet(claimFile(dir, 'ACME-1'), acme(999));
    const late = (pid) => {
      if (pid === 999) forceSet(claimFile(dir, 'ACME-1'), acme(200, { at: '2026-10-15T11:00:00Z' }));
      return false;
    };
    expect(letGoClaim(dir, 'ACME-1', new Set([100]), late)).toBeNull();
    expect(JSON.parse(readFileSync(claimFile(dir, 'ACME-1'), 'utf8')).pid).toBe(200);
  });
});

describe('dropOwnerClaim', () => {
  const at = '2026-10-24T09:00:00.000Z';
  const owner = (id = 'ACME-1') => ownerClaim(dir, id, new Date(at));

  it('removes an owner claim whose at matches, and returns the holder', () => {
    const holder = owner();
    expect(dropOwnerClaim(dir, 'ACME-1', at)).toEqual(holder);
    expect(existsSync(claimFile(dir, 'ACME-1'))).toBe(false);
  });
  it('leaves the claim when the owner took the story again (at differs)', () => {
    owner();
    expect(dropOwnerClaim(dir, 'ACME-1', '2026-10-23T09:00:00.000Z')).toBeNull();
    expect(existsSync(claimFile(dir, 'ACME-1'))).toBe(true);
  });
  it('leaves a factory claim with a live pid', () => {
    forceSet(claimFile(dir, 'ACME-1'), h(100, { story: 'ACME-1', at }));
    expect(dropOwnerClaim(dir, 'ACME-1', at)).toBeNull();
    expect(existsSync(claimFile(dir, 'ACME-1'))).toBe(true);
  });
  it('returns null for a missing file', () => expect(dropOwnerClaim(dir, 'ACME-1', at)).toBeNull());
  it('leaves a file that cannot be read', () => {
    mkdirSync(join(dir, 'claims'), { recursive: true });
    writeFileSync(claimFile(dir, 'ACME-1'), 'not json');
    expect(dropOwnerClaim(dir, 'ACME-1', at)).toBeNull();
    expect(existsSync(claimFile(dir, 'ACME-1'))).toBe(true);
  });
});

describe('the schema token, as the foreman sees it', () => {
  const me = { pid: 100, slot: 'w2' };
  it('is held only by the slot that took it', () => {
    expect(holdsSchema(dir, me, isAlive)).toBe(false);
    expect(takeSchema(dir, 'P6-02', me, new Date(), isAlive)).toBe(true);
    expect(holdsSchema(dir, me, isAlive)).toBe(true);
    expect(holdsSchema(dir, { pid: 100, slot: 'w1' }, isAlive)).toBe(false);
    expect(holderOf(SCHEMA(dir), isAlive)).toMatchObject({ pid: 100, slot: 'w2', story: 'P6-02', by: 'factory' });
  });
  it('taking again from the same slot succeeds, from another slot fails', () => {
    takeSchema(dir, 'P6-02', me, new Date(), isAlive);
    expect(takeSchema(dir, 'P6-02', me, new Date(), isAlive)).toBe(true);
    expect(takeSchema(dir, 'P6-03', { pid: 100, slot: 'w3' }, new Date(), isAlive)).toBe(false);
  });
});

describe('a damaged lock file', () => {
  it('counts as a stale holder and can be broken', () => {
    mkdirSync(join(dir, 'locks'), { recursive: true });
    writeFileSync(SCHEMA(dir), '{not json');
    expect(take(SCHEMA(dir), h(100), isAlive)).toMatchObject({ ok: false, stale: true, holder: null });
    expect(holderOf(SCHEMA(dir), isAlive)).toMatchObject({ stale: true });
    expect(breakIfStale(SCHEMA(dir), isAlive)).not.toBe(null);
    expect(take(SCHEMA(dir), h(100), isAlive).ok).toBe(true);
  });
});

// A supervisor restarted on new code (supervisor.mjs) leaves its sessions running; their locks
// name the old supervisor's pid, which supervisor-adopted.json vouches for while its voucher lives.
describe('locks held for an adopted session, with the default liveness', () => {
  const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;
  let old;
  beforeEach(() => {
    old = deadPid();
    forceSet(SCHEMA(dir), h(old));
  });

  it('are stale with no lineage, and live once the lineage vouches for the pid', () => {
    expect(holderOf(SCHEMA(dir)).stale).toBe(true);
    expect(holdsSchema(dir, { pid: old, slot: 'w1' })).toBe(false);
    writeAdopted(dir, { by: process.pid, pids: [old] });
    expect(holderOf(SCHEMA(dir)).stale).toBe(false);
    expect(holdsSchema(dir, { pid: old, slot: 'w1' })).toBe(true);
    expect(holdsResource(dir, 'schema', 'w1')).toBe(true);
    expect(takeSchema(dir, 'P7-01', { pid: old, slot: 'w1' })).toBe(true);
  });

  it('list a claim by that pid as live', () => {
    forceSet(claimFile(dir, 'P7-01'), h(old));
    expect(claims(dir)).toMatchObject([{ id: 'P7-01', stale: true }]);
    writeAdopted(dir, { by: process.pid, pids: [old] });
    expect(claims(dir)).toMatchObject([{ id: 'P7-01', pid: old, stale: false }]);
  });

  it('refuse another slot and are not broken while vouched for', () => {
    writeAdopted(dir, { by: process.pid, pids: [old] });
    expect(take(SCHEMA(dir), h(process.pid, { slot: 'w2' }))).toMatchObject({ ok: false, stale: false, holder: { pid: old } });
    expect(takeSchema(dir, 'P7-02', { pid: process.pid, slot: 'w2' })).toBe(false);
    expect(breakIfStale(SCHEMA(dir))).toBeNull();
    expect(existsSync(SCHEMA(dir))).toBe(true);
  });

  it('go stale once the voucher is dead', () => {
    writeAdopted(dir, { by: deadPid(), pids: [old] });
    expect(breakIfStale(SCHEMA(dir))).toMatchObject({ pid: old });
    expect(existsSync(SCHEMA(dir))).toBe(false);
  });

  it('leave an explicit isAlive as it is', () => {
    writeAdopted(dir, { by: process.pid, pids: [old] });
    expect(holderOf(SCHEMA(dir), isAlive).stale).toBe(true);
    expect(aliveIn(dir)(old)).toBe(true);
    expect(aliveIn(dir)(null)).toBe(true);
    expect(aliveIn(join(dir, 'elsewhere'))(old)).toBe(false);
    expect(existsSync(join(dir, ADOPTED_FILE))).toBe(true);
  });
});
