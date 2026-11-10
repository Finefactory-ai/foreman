import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAIM_WAIT_MS, claimAlive, claimKey, claimPath, dropStaleClaim, releaseClaim, takeClaim } from './check-claims.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foreman-claims-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const T = 'a'.repeat(40);
const mine = (extra = {}) => ({ run: 'npm test', tree: T, slot: 'w1', story: 'ACME-1', at: '2026-10-31T10:00:00.000Z', pid: 4242, script: '/p/checks.mjs', ...extra });
const files = () => (existsSync(join(dir, 'check-claims')) ? readdirSync(join(dir, 'check-claims')) : []);

describe('claimKey', () => {
  it('is 40 hex characters, stable, and differs by run and by tree', () => {
    expect(claimKey('npm test', T)).toMatch(/^[0-9a-f]{40}$/);
    expect(claimKey('npm test', T)).toBe(claimKey('npm test', T));
    expect(claimKey('npm test', T)).not.toBe(claimKey('npm run lint', T));
    expect(claimKey('npm test', T)).not.toBe(claimKey('npm test', 'b'.repeat(40)));
    expect(claimKey('a', 'bc')).not.toBe(claimKey('ab', 'c'));
  });
});

describe('takeClaim', () => {
  it('first take succeeds, a second reports the holder', () => {
    const first = takeClaim(dir, mine());
    expect(first.ok).toBe(true);
    expect(first.claim).toMatchObject({ pid: 4242, script: '/p/checks.mjs', run: 'npm test', tree: T, slot: 'w1', story: 'ACME-1', at: '2026-10-31T10:00:00.000Z' });
    expect(first.claim.token).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.parse(readFileSync(claimPath(dir, { run: 'npm test', tree: T }), 'utf8'))).toEqual(first.claim);
    const second = takeClaim(dir, mine({ slot: 'w2', pid: 99 }));
    expect(second.ok).toBe(false);
    expect(second.holder).toEqual(first.claim);
  });

  it('leaves no temp file behind, taken or not', () => {
    takeClaim(dir, mine());
    takeClaim(dir, mine({ slot: 'w2' }));
    expect(files()).toEqual([`${claimKey('npm test', T)}.json`]);
  });

  it('a different run or tree is a different claim', () => {
    expect(takeClaim(dir, mine()).ok).toBe(true);
    expect(takeClaim(dir, mine({ run: 'npm run lint' })).ok).toBe(true);
    expect(takeClaim(dir, mine({ tree: 'b'.repeat(40) })).ok).toBe(true);
  });

  it('reports a holder of null when the file cannot be parsed', () => {
    writeJunk();
    expect(takeClaim(dir, mine())).toEqual({ ok: false, holder: null });
  });

  it('reports an error for any other failure', () => {
    writeFileSync(join(dir, 'blocked'), 'a file');
    const bad = takeClaim(join(dir, 'blocked'), mine());
    expect(bad.ok).toBe(false);
    expect(typeof bad.error).toBe('string');
    expect(bad.error).not.toBe('');
  });

  it('reports a file where the claims folder goes as an error, not as a holder', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'check-claims'), 'a file');
    const bad = takeClaim(dir, mine());
    expect(bad.ok).toBe(false);
    expect(bad).not.toHaveProperty('holder');
    expect(typeof bad.error).toBe('string');
  });
});

function writeJunk() {
  mkdirSync(join(dir, 'check-claims'), { recursive: true });
  writeFileSync(claimPath(dir, { run: 'npm test', tree: T }), 'not json');
}

describe('releaseClaim', () => {
  it('leaves the file for a wrong token and removes it for the right one', () => {
    const { claim } = takeClaim(dir, mine());
    releaseClaim(dir, { ...claim, token: 'ffffffffffffffff' });
    expect(files()).toHaveLength(1);
    releaseClaim(dir, claim);
    expect(files()).toEqual([]);
  });

  it('never throws, for no file or an unreadable one', () => {
    expect(() => releaseClaim(dir, { ...mine(), token: 'x' })).not.toThrow();
    writeJunk();
    expect(() => releaseClaim(dir, { ...mine(), token: 'x' })).not.toThrow();
    expect(files()).toHaveLength(1);
  });
});

describe('dropStaleClaim', () => {
  it('removes the claim it read', () => {
    const { claim } = takeClaim(dir, mine());
    dropStaleClaim(dir, { run: 'npm test', tree: T }, claim);
    expect(files()).toEqual([]);
  });

  it('does not remove a claim replaced by a new token', () => {
    const { claim: old } = takeClaim(dir, mine());
    releaseClaim(dir, old);
    const { claim: fresh } = takeClaim(dir, mine({ slot: 'w2' }));
    dropStaleClaim(dir, { run: 'npm test', tree: T }, old);
    expect(files()).toHaveLength(1);
    expect(JSON.parse(readFileSync(claimPath(dir, { run: 'npm test', tree: T }), 'utf8')).token).toBe(fresh.token);
  });

  it('removes an unreadable claim when it was unreadable both times', () => {
    writeJunk();
    dropStaleClaim(dir, { run: 'npm test', tree: T }, null);
    expect(files()).toEqual([]);
  });

  it('keeps a claim that became readable since an unreadable first read', () => {
    takeClaim(dir, mine());
    dropStaleClaim(dir, { run: 'npm test', tree: T }, null);
    expect(files()).toHaveLength(1);
  });

  it('never throws when there is nothing to remove', () => {
    expect(() => dropStaleClaim(dir, { run: 'npm test', tree: T }, null)).not.toThrow();
  });
});

describe('claimAlive', () => {
  const STARTED = 'Sun Nov 1 10:00:00 2026';
  const claim = { pid: 4242, script: '/p/lib/cli/main.mjs', started: STARTED };
  const kill = () => true;
  // 'command=' answers a command line, 'lstart=' a start time (the claim's own by default).
  const psShows = (command, status = 0, started = STARTED) => (cmd, args) => (args.includes('lstart=') ? { status: started === null ? 1 : 0, stdout: `${started ?? ''}\n` } : { status, stdout: `${command}\n` });

  it('is false for a dead pid', () => {
    const dead = () => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    };
    expect(claimAlive(claim, { kill: dead, ps: psShows('node /p/lib/cli/main.mjs checks') })).toBe(false);
  });

  it('is false when ps shows another program', () => {
    expect(claimAlive(claim, { kill, ps: psShows('vim notes.txt') })).toBe(false);
  });

  it('is false when ps finds no such process', () => {
    expect(claimAlive(claim, { kill, ps: psShows('', 1) })).toBe(false);
  });

  it('is true when ps shows the script', () => {
    expect(claimAlive(claim, { kill, ps: psShows('node /elsewhere/main.mjs checks --changed') })).toBe(true);
  });

  it('lets the kill check decide when ps cannot run', () => {
    expect(claimAlive(claim, { kill, ps: () => ({ error: new Error('ENOENT') }) })).toBe(true);
  });

  it('is false for a claim with no usable pid', () => {
    expect(claimAlive({ pid: 'x', script: 'a' }, { kill, ps: psShows('a') })).toBe(false);
    expect(claimAlive(null, { kill, ps: psShows('a') })).toBe(false);
  });

  it('an empty script name is dead, whatever the live pid runs', () => {
    expect(claimAlive({ pid: 4242, script: '', started: STARTED }, { kill, ps: psShows('node anything') })).toBe(false);
    expect(claimAlive({ pid: 4242, started: STARTED }, { kill, ps: psShows('node anything') })).toBe(false);
  });

  it('a missing or empty script is dead even when ps cannot run', () => {
    const noPs = () => ({ error: new Error('ENOENT') });
    expect(claimAlive({ pid: 4242, script: '' }, { kill, ps: noPs })).toBe(false);
    expect(claimAlive({ pid: 4242 }, { kill, ps: noPs })).toBe(false);
    expect(claimAlive({ pid: 4242, script: '/' }, { kill, ps: noPs })).toBe(false);
  });

  it('is true for the same script and the same start time', () => {
    expect(claimAlive(claim, { kill, ps: psShows('node /p/lib/cli/main.mjs checks') })).toBe(true);
  });

  it('is false when the pid was reused by another process with the same script name', () => {
    expect(claimAlive(claim, { kill, ps: psShows('node /p/lib/cli/main.mjs run', 0, 'Mon Nov 2 09:00:00 2026') })).toBe(false);
  });

  it('is false when the claim has no start time, while ps works', () => {
    const ps = psShows('node /p/lib/cli/main.mjs checks');
    expect(claimAlive({ pid: 4242, script: '/p/lib/cli/main.mjs' }, { kill, ps })).toBe(false);
    expect(claimAlive({ ...claim, started: null }, { kill, ps })).toBe(false);
    expect(claimAlive({ ...claim, started: '' }, { kill, ps })).toBe(false);
  });

  it('is false when the start time cannot be read', () => {
    expect(claimAlive(claim, { kill, ps: psShows('node /p/lib/cli/main.mjs checks', 0, null) })).toBe(false);
  });
});

describe('the holder start time and the wait limit', () => {
  it('takeClaim stores started, and null by default', () => {
    const a = takeClaim(dir, mine({ started: 'Sun Nov 1 10:00:00 2026' }));
    expect(a.claim.started).toBe('Sun Nov 1 10:00:00 2026');
    expect(JSON.parse(readFileSync(claimPath(dir, { run: 'npm test', tree: T }), 'utf8')).started).toBe('Sun Nov 1 10:00:00 2026');
    rmSync(join(dir, 'check-claims'), { recursive: true });
    const b = takeClaim(dir, mine());
    expect(b.claim.started).toBeNull();
    expect(JSON.parse(readFileSync(claimPath(dir, { run: 'npm test', tree: T }), 'utf8')).started).toBeNull();
  });

  it('a waiter waits 30 minutes at most', () => {
    expect(CLAIM_WAIT_MS).toBe(30 * 60_000);
  });
});
