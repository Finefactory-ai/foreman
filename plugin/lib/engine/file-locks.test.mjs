import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { withDefaults } from '../config/defaults.mjs';
import { PLAN_FILE } from './plan-file.mjs';
import { nextStory } from './pick.mjs';
import { claimFile, forceSet, RESOURCE } from './locks.mjs';
import { writeAdopted } from './supervisor-pid.mjs';
import { claimable, claimedFiles, clearWait, dropReservations, FILE_LOCK, fileLockFiles, fileWaits, holdsFiles, normaliseFiles, RESERVE, RESERVE_MS, reservationOf, reserveFreed, reserveForStart, reserveText, spendWait, takeFiles, topFileWait, WAIT, waitBlocks, waitOf, waitReason, waitsOnFiles, writeWait, yieldsTo } from './file-locks.mjs';

const DEAD = 999999;
const NOW = new Date('2026-10-26T12:00:00Z');
let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foreman-file-locks-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const w1 = { pid: process.pid, slot: 'w1' };
const w2 = { pid: process.pid, slot: 'w2' };
const holder = (path) => JSON.parse(readFileSync(FILE_LOCK(dir, path), 'utf8'));

describe('FILE_LOCK', () => {
  it('is a file under locks/, named by a hash of the path', () => {
    const f = FILE_LOCK('/s', 'src/a.mjs');
    expect(f).toMatch(/^\/s\/locks\/file-[0-9a-f]{16}\.json$/);
    expect(FILE_LOCK('/s', 'src/a.mjs')).toBe(f);
    expect(FILE_LOCK('/s', 'src/b.mjs')).not.toBe(f);
  });
});

describe('normaliseFiles', () => {
  const top = '/repo/acme';
  it('makes every path relative to the repository root, sorted and without duplicates', () => {
    const { files, dropped } = normaliseFiles(['./src/a.mjs', `${top}/src/a.mjs`, 'src/b/../c.mjs', 'README.md', '/other/top/x.mjs'], [top, '/other/top']);
    expect(files).toEqual(['README.md', 'src/a.mjs', 'src/c.mjs', 'x.mjs']);
    expect(dropped).toEqual([]);
  });

  it('drops escapes, paths outside every top, empty entries and non-strings', () => {
    const { files, dropped } = normaliseFiles(['../x', '/elsewhere/y', '', 'src/../../z', 7, null, 'src/ok.mjs', top], [top]);
    expect(files).toEqual(['src/ok.mjs']);
    expect(dropped).toEqual(['../x', '/elsewhere/y', '', 'src/../../z', 7, null, top]);
  });

  it('takes a top with a trailing slash, and no list at all', () => {
    expect(normaliseFiles([`${top}/src/a.mjs`], [`${top}/`]).files).toEqual(['src/a.mjs']);
    expect(normaliseFiles(undefined, [top])).toEqual({ files: [], dropped: [] });
  });

  it('drops folder entries (ending in /), relative or absolute, as given', () => {
    const { files, dropped } = normaliseFiles(['src/', `${top}/lib/`, 'src/a.mjs', 'docs//'], [top]);
    expect(files).toEqual(['src/a.mjs']);
    expect(dropped).toEqual(['src/', `${top}/lib/`, 'docs//']);
  });
});

describe('claimable', () => {
  it('leaves out CHANGELOG.md under the defaults, generated paths and ignore globs', () => {
    const files = ['CHANGELOG.md', 'docs/a.md', 'docs/b/c.md', 'gen/types.d.ts', 'src/a.mjs'];
    expect(claimable(files, withDefaults({ version: 1, project: { name: 'Acme' } }))).toEqual(['docs/a.md', 'docs/b/c.md', 'gen/types.d.ts', 'src/a.mjs']);
    const config = withDefaults({ version: 1, project: { name: 'Acme' }, generated: [{ path: 'gen/types.d.ts', regenerate: 'npm run gen' }], fileLocks: { ignore: ['docs/**'] } });
    // A project's list replaces the default one, so CHANGELOG.md is claimed here.
    expect(claimable(files, config)).toEqual(['CHANGELOG.md', 'src/a.mjs']);
  });
});

describe('takeFiles', () => {
  it('defers a second slot that names a held file, rolls back what it took, and lets disjoint files through', () => {
    expect(takeFiles(dir, { id: 'ACME-1', files: ['src/a.mjs', 'src/b.mjs'], me: w1, now: NOW })).toEqual({ ok: true, files: ['src/a.mjs', 'src/b.mjs'] });
    expect(holder('src/a.mjs')).toEqual({ pid: process.pid, slot: 'w1', story: 'ACME-1', by: 'factory', at: NOW.toISOString(), path: 'src/a.mjs' });

    const r = takeFiles(dir, { id: 'ACME-2', files: ['src/b.mjs', 'src/c.mjs'], me: w2, now: NOW });
    expect(r).toEqual({ ok: false, conflicts: [{ story: 'ACME-1', slot: 'w1', files: ['src/b.mjs'] }] });
    expect(existsSync(FILE_LOCK(dir, 'src/c.mjs'))).toBe(false);
    expect(holder('src/b.mjs')).toMatchObject({ slot: 'w1', story: 'ACME-1' });

    expect(takeFiles(dir, { id: 'ACME-3', files: ['src/c.mjs'], me: w2, now: NOW })).toEqual({ ok: true, files: ['src/c.mjs'] });
  });

  it('groups the conflicts by holder story, sorted', () => {
    takeFiles(dir, { id: 'ACME-4', files: ['src/d.mjs', 'src/b.mjs'], me: { pid: process.pid, slot: 'w3' }, now: NOW });
    takeFiles(dir, { id: 'ACME-1', files: ['src/a.mjs'], me: w1, now: NOW });
    const r = takeFiles(dir, { id: 'ACME-2', files: ['src/a.mjs', 'src/b.mjs', 'src/d.mjs', 'src/e.mjs'], me: w2, now: NOW });
    expect(r.conflicts).toEqual([
      { story: 'ACME-1', slot: 'w1', files: ['src/a.mjs'] },
      { story: 'ACME-4', slot: 'w3', files: ['src/b.mjs', 'src/d.mjs'] },
    ]);
    expect(existsSync(FILE_LOCK(dir, 'src/e.mjs'))).toBe(false);
  });

  it('is ok when the same slot takes the same files again, and leaves its locks alone on a conflict', () => {
    takeFiles(dir, { id: 'ACME-1', files: ['src/a.mjs'], me: w1, now: NOW });
    expect(takeFiles(dir, { id: 'ACME-1', files: ['src/a.mjs', 'src/b.mjs'], me: w1, now: NOW }).ok).toBe(true);
    takeFiles(dir, { id: 'ACME-9', files: ['src/z.mjs'], me: w2, now: NOW });
    expect(takeFiles(dir, { id: 'ACME-1', files: ['src/a.mjs', 'src/z.mjs'], me: w1, now: NOW }).ok).toBe(false);
    // src/a.mjs was held before the call, so the rollback keeps it.
    expect(holder('src/a.mjs')).toMatchObject({ slot: 'w1', story: 'ACME-1' });
  });

  it("breaks another slot's stale holder and takes the file", () => {
    forceSet(FILE_LOCK(dir, 'src/a.mjs'), { pid: DEAD, slot: 'w1', story: 'ACME-1', by: 'factory', at: 'x', path: 'src/a.mjs' });
    expect(takeFiles(dir, { id: 'ACME-2', files: ['src/a.mjs'], me: w2, now: NOW }).ok).toBe(true);
    expect(holder('src/a.mjs')).toMatchObject({ pid: process.pid, slot: 'w2', story: 'ACME-2' });
  });

  it("takes back this slot's own lock left by a supervisor that died", () => {
    forceSet(FILE_LOCK(dir, 'src/a.mjs'), { pid: DEAD, slot: 'w1', story: 'ACME-1', by: 'factory', at: 'x', path: 'src/a.mjs' });
    expect(takeFiles(dir, { id: 'ACME-1', files: ['src/a.mjs'], me: w1, now: NOW }).ok).toBe(true);
    expect(holder('src/a.mjs')).toMatchObject({ pid: process.pid, slot: 'w1' });
    expect(holdsFiles(dir, ['src/a.mjs'], 'w1')).toBe(true);
  });

  it('treats a live holder in another slot as a conflict even with the same pid', () => {
    forceSet(FILE_LOCK(dir, 'src/a.mjs'), { pid: process.pid, slot: 'w1', story: 'ACME-1', by: 'factory', at: 'x', path: 'src/a.mjs' });
    expect(takeFiles(dir, { id: 'ACME-2', files: ['src/a.mjs'], me: w2, now: NOW }).ok).toBe(false);
  });
});

describe('after a restart on new code', () => {
  // An adopted session's locks name the old supervisor's pid, which has exited:
  // supervisor-adopted.json vouches for it while the new supervisor lives.
  const old = { pid: DEAD, slot: 'w1', story: 'ACME-1', by: 'factory', at: 'x', path: 'src/a.mjs' };

  it("keeps an adopted session's file lock live: another slot is refused and waits on it", () => {
    forceSet(FILE_LOCK(dir, 'src/a.mjs'), old);
    writeAdopted(dir, { by: process.pid, pids: [DEAD] });
    const r = takeFiles(dir, { id: 'ACME-2', files: ['src/a.mjs'], me: w2, now: NOW });
    expect(r).toEqual({ ok: false, conflicts: [{ story: 'ACME-1', slot: 'w1', files: ['src/a.mjs'] }] });
    expect(holder('src/a.mjs')).toMatchObject({ pid: DEAD, slot: 'w1', story: 'ACME-1' });
    expect(holdsFiles(dir, ['src/a.mjs'], 'w1')).toBe(true);
    writeWait(dir, 'ACME-2', r.conflicts, NOW);
    expect(waitBlocks(dir, 'ACME-2')).toBe(true);
  });

  it('lets the adopted session claim its files again under the old pid it still runs with', () => {
    forceSet(FILE_LOCK(dir, 'src/a.mjs'), old);
    writeAdopted(dir, { by: process.pid, pids: [DEAD] });
    expect(takeFiles(dir, { id: 'ACME-1', files: ['src/a.mjs', 'src/b.mjs'], me: { pid: DEAD, slot: 'w1' }, now: NOW }).ok).toBe(true);
    expect(holdsFiles(dir, ['src/a.mjs', 'src/b.mjs'], 'w1')).toBe(true);
  });

  it('is stale again once nothing vouches for the old pid', () => {
    forceSet(FILE_LOCK(dir, 'src/a.mjs'), old);
    writeAdopted(dir, { by: DEAD, pids: [DEAD] });
    writeWait(dir, 'ACME-2', [{ story: 'ACME-1', slot: 'w1', files: ['src/a.mjs'] }], NOW);
    expect(waitBlocks(dir, 'ACME-2')).toBe(false);
    expect(holdsFiles(dir, ['src/a.mjs'], 'w1')).toBe(false);
    expect(takeFiles(dir, { id: 'ACME-2', files: ['src/a.mjs'], me: w2, now: NOW }).ok).toBe(true);
  });
});

describe('holdsFiles', () => {
  it('is true for the holding slot only, and for no files', () => {
    takeFiles(dir, { id: 'ACME-1', files: ['src/a.mjs', 'src/b.mjs'], me: w1, now: NOW });
    expect(holdsFiles(dir, ['src/a.mjs', 'src/b.mjs'], 'w1')).toBe(true);
    expect(holdsFiles(dir, ['src/a.mjs', 'src/c.mjs'], 'w1')).toBe(false);
    expect(holdsFiles(dir, ['src/a.mjs'], 'w2')).toBe(false);
    expect(holdsFiles(dir, [], 'w2')).toBe(true);
    expect(holdsFiles(dir, ['src/a.mjs'], 'w1', () => false)).toBe(false);
  });
});

describe('claimedFiles', () => {
  const lock = (path, slot, story) => forceSet(FILE_LOCK(dir, path), { pid: DEAD, slot, story, by: 'factory', at: 'x', path });

  it('is true when every file has a lock naming this slot and story, though its pid is dead', () => {
    lock('src/a.mjs', 'w1', 'ACME-1');
    expect(claimedFiles(dir, ['src/a.mjs'], { slot: 'w1', story: 'ACME-1' })).toBe(true);
    expect(claimedFiles(dir, ['src/a.mjs'], { slot: 'w2', story: 'ACME-1' })).toBe(false);
    expect(claimedFiles(dir, ['src/a.mjs'], { slot: 'w1', story: 'ACME-2' })).toBe(false);
  });

  it('is false for a file with no lock or an unreadable one, and true for no files', () => {
    lock('src/a.mjs', 'w1', 'ACME-1');
    expect(claimedFiles(dir, ['src/a.mjs', 'src/b.mjs'], { slot: 'w1', story: 'ACME-1' })).toBe(false);
    writeFileSync(FILE_LOCK(dir, 'src/a.mjs'), '{x');
    expect(claimedFiles(dir, ['src/a.mjs'], { slot: 'w1', story: 'ACME-1' })).toBe(false);
    expect(claimedFiles(dir, [], { slot: 'w1', story: 'ACME-1' })).toBe(true);
  });
});

describe('waits', () => {
  const conflicts = [{ story: 'ACME-1', slot: 'w1', files: ['src/b.mjs'] }];

  it('blocks a story only while another story holds one of the files it waits on', () => {
    expect(waitBlocks(dir, 'ACME-2')).toBe(false);
    takeFiles(dir, { id: 'ACME-1', files: ['src/b.mjs'], me: w1, now: NOW });
    writeWait(dir, 'ACME-2', conflicts, NOW);
    expect(JSON.parse(readFileSync(WAIT(dir, 'ACME-2'), 'utf8'))).toEqual({ story: 'ACME-2', on: ['ACME-1'], files: ['src/b.mjs'], at: NOW.toISOString(), deferrals: { 'ACME-1': 1 } });
    writeWait(dir, 'ACME-2', conflicts, NOW);
    expect(JSON.parse(readFileSync(WAIT(dir, 'ACME-2'), 'utf8')).deferrals).toEqual({ 'ACME-1': 2 });
    expect(waitBlocks(dir, 'ACME-2')).toBe(true);
    expect(waitBlocks(dir, 'ACME-2', () => false)).toBe(false);
    rmSync(FILE_LOCK(dir, 'src/b.mjs'));
    expect(waitBlocks(dir, 'ACME-2')).toBe(false);
  });

  it('does not block on a file the waiting story holds itself', () => {
    takeFiles(dir, { id: 'ACME-2', files: ['src/b.mjs'], me: w2, now: NOW });
    writeWait(dir, 'ACME-2', conflicts, NOW);
    expect(waitBlocks(dir, 'ACME-2')).toBe(false);
  });

  it('clears a wait, and reads an unreadable one as no wait', () => {
    writeWait(dir, 'ACME-2', conflicts, NOW);
    clearWait(dir, 'ACME-2');
    expect(existsSync(WAIT(dir, 'ACME-2'))).toBe(false);
    clearWait(dir, 'ACME-2');
    mkdirSync(join(dir, 'waits'), { recursive: true });
    writeFileSync(WAIT(dir, 'ACME-2'), 'not json');
    expect(waitBlocks(dir, 'ACME-2')).toBe(false);
  });
});

const live = { pid: process.pid, slot: 'w1', story: 'ACME-1', by: 'factory', at: NOW.toISOString() };
const writePlan = (id, plan) => {
  mkdirSync(join(dir, 'plans'), { recursive: true });
  writeFileSync(PLAN_FILE(dir, id), typeof plan === 'string' ? plan : JSON.stringify(plan));
};
const claimStory = (id, slot = 'w1') => forceSet(claimFile(dir, id), { ...live, story: id, slot });

describe('waitOf', () => {
  it('blocks on a file the saved plan names, with no wait record', () => {
    writePlan('ACME-2', { files: ['src/a.mjs'] });
    takeFiles(dir, { id: 'ACME-1', files: ['src/a.mjs'], me: w1, now: NOW });
    expect(waitBlocks(dir, 'ACME-2')).toBe(true);
    expect(waitOf(dir, 'ACME-2')).toEqual({
      id: 'ACME-2',
      on: [{ story: 'ACME-1', files: ['src/a.mjs'], resources: [], deferrals: 0 }],
      text: 'ACME-2 waits for ACME-1: src/a.mjs',
    });
    expect(waitOf(dir, 'ACME-2', () => false)).toBeNull();
    rmSync(FILE_LOCK(dir, 'src/a.mjs'));
    expect(waitOf(dir, 'ACME-2')).toBeNull();
    expect(waitBlocks(dir, 'ACME-2')).toBe(false);
  });

  it('blocks on a resource the plan names that another story holds, not on its own or an odd name', () => {
    forceSet(RESOURCE(dir, 'db'), live);
    writePlan('ACME-2', { resources: ['db', '../x', '..', 5] });
    const w = waitOf(dir, 'ACME-2');
    expect(w.on).toEqual([{ story: 'ACME-1', files: [], resources: ['db'], deferrals: 0 }]);
    expect(w.text).toBe('ACME-2 waits for ACME-1: db');
    forceSet(RESOURCE(dir, 'db'), { ...live, story: 'ACME-2' });
    expect(waitOf(dir, 'ACME-2')).toBeNull();
    forceSet(RESOURCE(dir, 'db'), live);
    writePlan('ACME-2', { resources: ['../x', '..', '.'] });
    expect(waitOf(dir, 'ACME-2')).toBeNull();
  });

  it('does not block on a file the waiting story holds, an unreadable plan or an unreadable record', () => {
    takeFiles(dir, { id: 'ACME-2', files: ['src/a.mjs'], me: w2, now: NOW });
    writePlan('ACME-2', { files: ['src/a.mjs'] });
    expect(waitOf(dir, 'ACME-2')).toBeNull();
    writePlan('ACME-2', 'not json');
    expect(waitOf(dir, 'ACME-2')).toBeNull();
    mkdirSync(join(dir, 'waits'), { recursive: true });
    writeFileSync(WAIT(dir, 'ACME-2'), '[1]');
    expect(waitOf(dir, 'ACME-2')).toBeNull();
    writeFileSync(WAIT(dir, 'ACME-2'), 'not json');
    expect(waitOf(dir, 'ACME-2')).toBeNull();
  });

  it('waits for a holder it was deferred on twice while that story runs, even when it holds none of the files', () => {
    const conflicts = [{ story: 'ACME-1', slot: 'w1', files: ['src/a.mjs'] }];
    writeWait(dir, 'ACME-2', conflicts, NOW);
    expect(waitOf(dir, 'ACME-2')).toBeNull();
    writeWait(dir, 'ACME-2', conflicts, NOW);
    expect(waitOf(dir, 'ACME-2')).toBeNull();
    claimStory('ACME-1');
    expect(waitOf(dir, 'ACME-2')).toEqual({
      id: 'ACME-2',
      on: [{ story: 'ACME-1', files: [], resources: [], deferrals: 2 }],
      text: 'ACME-2 waits for ACME-1 to ship or end: deferred on it twice',
    });
    expect(waitBlocks(dir, 'ACME-2')).toBe(true);
    writeWait(dir, 'ACME-2', conflicts, NOW);
    expect(waitOf(dir, 'ACME-2').text).toBe('ACME-2 waits for ACME-1 to ship or end: deferred on it 3 times');
    rmSync(claimFile(dir, 'ACME-1'));
    expect(waitOf(dir, 'ACME-2')).toBeNull();
  });

  it('counts a story running when a live file lock names it, with no claim', () => {
    const conflicts = [{ story: 'ACME-1', slot: 'w1', files: ['src/a.mjs'] }];
    writeWait(dir, 'ACME-2', conflicts, NOW);
    writeWait(dir, 'ACME-2', conflicts, NOW);
    takeFiles(dir, { id: 'ACME-1', files: ['src/z.mjs'], me: w1, now: NOW });
    expect(waitOf(dir, 'ACME-2').text).toBe('ACME-2 waits for ACME-1 to ship or end: deferred on it twice');
    expect(waitOf(dir, 'ACME-2', () => false)).toBeNull();
  });

  it('does not wait once on a holder that holds none of the files while it runs', () => {
    writeWait(dir, 'ACME-2', [{ story: 'ACME-1', slot: 'w1', files: ['src/a.mjs'] }], NOW);
    claimStory('ACME-1');
    expect(waitOf(dir, 'ACME-2')).toBeNull();
  });

  it('joins several holders, and cuts a long text to 200 characters', () => {
    takeFiles(dir, { id: 'ACME-1', files: ['src/a.mjs'], me: w1, now: NOW });
    takeFiles(dir, { id: 'ACME-2', files: ['src/b.mjs'], me: w2, now: NOW });
    writeWait(dir, 'ACME-3', [{ story: 'ACME-2', slot: 'w2', files: ['src/b.mjs'] }, { story: 'ACME-1', slot: 'w1', files: ['src/a.mjs'] }], NOW);
    expect(waitOf(dir, 'ACME-3').text).toBe('ACME-3 waits for ACME-1 (src/a.mjs) and ACME-2 (src/b.mjs)');
    expect(waitOf(dir, 'ACME-3').on.map((o) => o.story)).toEqual(['ACME-1', 'ACME-2']);
    for (let i = 0; i < 6; i++) {
      const file = `src/${'deep/'.repeat(8)}file-${i}.mjs`;
      takeFiles(dir, { id: `ACME-${i + 10}`, files: [file], me: { pid: process.pid, slot: `w${i + 3}` }, now: NOW });
      writeWait(dir, 'ACME-9', [{ story: `ACME-${i + 10}`, slot: `w${i + 3}`, files: [file] }], NOW);
    }
    writePlan('ACME-9', { files: Array.from({ length: 6 }, (_, i) => `src/${'deep/'.repeat(8)}file-${i}.mjs`) });
    const text = waitOf(dir, 'ACME-9').text;
    expect(text.length).toBe(200);
    expect(text.endsWith('…')).toBe(true);
  });
});

describe('spendWait', () => {
  const conflicts = [{ story: 'ACME-1', slot: 'w1', files: ['src/a.mjs'] }];

  it('keeps the count for a holder that still runs, with no files', () => {
    writeWait(dir, 'ACME-2', conflicts, NOW);
    claimStory('ACME-1');
    spendWait(dir, 'ACME-2');
    expect(JSON.parse(readFileSync(WAIT(dir, 'ACME-2'), 'utf8'))).toEqual({ story: 'ACME-2', on: [], files: [], at: NOW.toISOString(), deferrals: { 'ACME-1': 1 } });
    expect(waitsOnFiles(dir, 'ACME-2')).toBe(false);
    writeWait(dir, 'ACME-2', conflicts, NOW);
    expect(waitOf(dir, 'ACME-2').text).toBe('ACME-2 waits for ACME-1 to ship or end: deferred on it twice');
  });

  it('removes the record when no holder runs', () => {
    writeWait(dir, 'ACME-2', conflicts, NOW);
    spendWait(dir, 'ACME-2');
    expect(existsSync(WAIT(dir, 'ACME-2'))).toBe(false);
  });

  it('does nothing with no record', () => {
    spendWait(dir, 'ACME-2');
    expect(existsSync(WAIT(dir, 'ACME-2'))).toBe(false);
    expect(existsSync(join(dir, 'waits'))).toBe(false);
  });
});

describe('waitsOnFiles', () => {
  it('is true right after a wait with files, false with no record or no files', () => {
    expect(waitsOnFiles(dir, 'ACME-2')).toBe(false);
    writeWait(dir, 'ACME-2', [{ story: 'ACME-1', slot: 'w1', files: ['src/a.mjs'] }], NOW);
    expect(waitsOnFiles(dir, 'ACME-2')).toBe(true);
    writeFileSync(WAIT(dir, 'ACME-2'), 'not json');
    expect(waitsOnFiles(dir, 'ACME-2')).toBe(false);
  });
});

describe('fileWaits', () => {
  const conflicts = [{ story: 'ACME-1', slot: 'w1', files: ['src/a.mjs'] }];

  it('lists the waits that still block, sorted', () => {
    expect(fileWaits(dir)).toEqual([]);
    takeFiles(dir, { id: 'ACME-1', files: ['src/a.mjs'], me: w1, now: NOW });
    writeWait(dir, 'ACME-3', conflicts, NOW);
    writeWait(dir, 'ACME-2', conflicts, NOW);
    writeWait(dir, 'ACME-4', [{ story: 'ACME-9', slot: 'w9', files: ['src/q.mjs'] }], NOW);
    const waits = fileWaits(dir);
    expect(waits.map((w) => w.id)).toEqual(['ACME-2', 'ACME-3']);
    expect(waits[0]).toEqual({ id: 'ACME-2', on: waitOf(dir, 'ACME-2').on, text: 'ACME-2 waits for ACME-1: src/a.mjs' });
  });

  it('drops a story with a live claim, the owner is included', () => {
    takeFiles(dir, { id: 'ACME-1', files: ['src/a.mjs'], me: w1, now: NOW });
    writeWait(dir, 'ACME-2', conflicts, NOW);
    writeWait(dir, 'ACME-3', conflicts, NOW);
    claimStory('ACME-2', 'w2');
    forceSet(claimFile(dir, 'ACME-3'), { pid: null, slot: null, story: 'ACME-3', by: 'owner', at: 'x' });
    expect(fileWaits(dir)).toEqual([]);
  });

  it('adds plan-only waits when given the stories, and drops done and unlisted ones', () => {
    takeFiles(dir, { id: 'ACME-1', files: ['src/a.mjs'], me: w1, now: NOW });
    writePlan('ACME-2', { files: ['src/a.mjs'] });
    writePlan('ACME-3', { files: ['src/a.mjs'] });
    writePlan('ACME-4', { files: ['src/a.mjs'] });
    writeWait(dir, 'ACME-5', conflicts, NOW);
    writeWait(dir, 'ACME-6', conflicts, NOW);
    writeFileSync(join(dir, 'plans', 'ACME-4.md'), 'x');
    const stories = [
      { id: 'ACME-2', status: 'todo' },
      { id: 'ACME-3', status: 'done' },
      { id: 'ACME-5', status: 'in-progress' },
    ];
    expect(fileWaits(dir, { stories }).map((w) => w.id)).toEqual(['ACME-2', 'ACME-5']);
    expect(fileWaits(dir).map((w) => w.id)).toEqual(['ACME-5', 'ACME-6']);
    expect(fileWaits(dir, { stories: [] })).toEqual([]);
  });
});

describe('waitReason', () => {
  it('names one holder and its files', () => {
    expect(waitReason([{ story: 'ACME-1', slot: 'w1', files: ['src/a.mjs'] }])).toBe('waiting for ACME-1 to ship: it is changing src/a.mjs');
    expect(waitReason([{ story: 'ACME-1', slot: 'w1', files: ['src/a.mjs', 'src/b.mjs'] }])).toBe('waiting for ACME-1 to ship: it is changing src/a.mjs and src/b.mjs');
  });

  it('names each of several holders with its files', () => {
    expect(
      waitReason([
        { story: 'ACME-1', slot: 'w1', files: ['src/a.mjs'] },
        { story: 'ACME-4', slot: 'w3', files: ['src/b.mjs'] },
      ]),
    ).toBe('waiting for ACME-1 (src/a.mjs) and ACME-4 (src/b.mjs) to ship');
  });

  it('shows at most 3 files per holder, and stays within 200 characters', () => {
    const files = ['src/a.mjs', 'src/b.mjs', 'src/c.mjs', 'src/d.mjs', 'src/e.mjs'];
    expect(waitReason([{ story: 'ACME-1', slot: 'w1', files }])).toBe('waiting for ACME-1 to ship: it is changing src/a.mjs, src/b.mjs, src/c.mjs and 2 more');
    const long = Array.from({ length: 6 }, (_, i) => ({ story: `ACME-${i + 10}`, slot: `w${i + 1}`, files: [`src/${'deep/'.repeat(8)}file-${i}.mjs`] }));
    const text = waitReason(long);
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text.startsWith('waiting for ACME-10 (')).toBe(true);
  });
});

describe('fileLockFiles', () => {
  it('lists only the file locks', () => {
    expect(fileLockFiles(dir)).toEqual([]);
    takeFiles(dir, { id: 'ACME-1', files: ['src/a.mjs', 'src/b.mjs'], me: w1, now: NOW });
    mkdirSync(join(dir, 'locks'), { recursive: true });
    writeFileSync(join(dir, 'locks', 'schema.json'), '{}');
    writeFileSync(join(dir, 'locks', 'resource-db.json'), '{}');
    writeFileSync(join(dir, 'locks', 'file-0000.json.1.tmp'), '{}');
    expect(fileLockFiles(dir).sort()).toEqual([FILE_LOCK(dir, 'src/a.mjs'), FILE_LOCK(dir, 'src/b.mjs')].sort());
  });
});

// ── reservations: a freed file is kept for the highest-priority story waiting on it ──────────

const story = (id, order) => ({ id, order, status: 'todo', dependsOn: [] });
const ACME_2 = story('ACME-2', 1);
const ACME_5 = story('ACME-5', 5);
const ACME_9 = story('ACME-9', 9);
const later = (ms) => new Date(NOW.getTime() + ms);
const waitOn = (id, files, on = 'ACME-1') => writeWait(dir, id, [{ story: on, slot: 'w1', files }], NOW);
const reserveFile = (path, record) => {
  mkdirSync(join(dir, 'locks'), { recursive: true });
  writeFileSync(RESERVE(dir, path), JSON.stringify({ path, from: null, at: NOW.toISOString(), until: later(RESERVE_MS).toISOString(), ...record }));
};
const reserveFiles = () => (existsSync(join(dir, 'locks')) ? readdirSync(join(dir, 'locks')).filter((f) => f.startsWith('reserve-')) : []);

describe('RESERVE', () => {
  it('is a file under locks/ named by the same hash as the file lock, and is no file lock', () => {
    const f = RESERVE('/s', 'src/a.mjs');
    expect(f).toMatch(/^\/s\/locks\/reserve-[0-9a-f]{16}\.json$/);
    expect(basename(f).slice('reserve-'.length)).toBe(basename(FILE_LOCK('/s', 'src/a.mjs')).slice('file-'.length));
    reserveFile('src/a.mjs', { story: 'ACME-2' });
    expect(fileLockFiles(dir)).toEqual([]);
  });
});

describe('a freed file goes to the highest-priority story waiting on it', () => {
  it('a Low story planning after the release does not take the file from a waiting Highest story', () => {
    takeFiles(dir, { id: 'ACME-1', files: ['src/a.mjs'], me: w1, now: NOW });
    waitOn('ACME-2', ['src/a.mjs']);
    const kept = reserveFreed(dir, { freed: [{ path: 'src/a.mjs', from: 'ACME-1' }], waiters: [ACME_2, ACME_9], now: NOW });
    expect(kept).toEqual([{ path: 'src/a.mjs', story: 'ACME-2' }]);
    rmSync(FILE_LOCK(dir, 'src/a.mjs'));

    const low = takeFiles(dir, { id: 'ACME-9', files: ['src/a.mjs'], me: w2, now: later(60_000) });
    expect(low).toEqual({ ok: false, conflicts: [{ story: 'ACME-2', slot: null, files: ['src/a.mjs'], reserved: true }] });
    expect(existsSync(FILE_LOCK(dir, 'src/a.mjs'))).toBe(false);
    expect(waitReason(low.conflicts)).toBe('waiting for ACME-2 to start: src/a.mjs is kept for it');

    expect(takeFiles(dir, { id: 'ACME-2', files: ['src/a.mjs'], me: w1, now: later(60_000) })).toEqual({ ok: true, files: ['src/a.mjs'] });
  });

  it('lets go after RESERVE_MS: the file can be taken and the reservation no longer counts', () => {
    reserveFile('src/a.mjs', { story: 'ACME-2' });
    expect(reservationOf(dir, 'src/a.mjs', later(RESERVE_MS - 1))).toMatchObject({ story: 'ACME-2' });
    expect(takeFiles(dir, { id: 'ACME-9', files: ['src/a.mjs'], me: w2, now: later(RESERVE_MS - 1) }).ok).toBe(false);
    expect(reservationOf(dir, 'src/a.mjs', later(RESERVE_MS))).toBeNull();
    expect(takeFiles(dir, { id: 'ACME-9', files: ['src/a.mjs'], me: w2, now: later(RESERVE_MS) }).ok).toBe(true);
  });

  it('keeps a conflict without a reservation in today shape, and merges a held and a reserved file of one story', () => {
    takeFiles(dir, { id: 'ACME-2', files: ['src/b.mjs'], me: w1, now: NOW });
    reserveFile('src/a.mjs', { story: 'ACME-2' });
    const r = takeFiles(dir, { id: 'ACME-9', files: ['src/a.mjs', 'src/b.mjs', 'src/c.mjs'], me: w2, now: later(1000) });
    expect(r).toEqual({ ok: false, conflicts: [{ story: 'ACME-2', slot: 'w1', files: ['src/a.mjs', 'src/b.mjs'] }] });
    expect(existsSync(FILE_LOCK(dir, 'src/c.mjs'))).toBe(false);
    // The reserved file seen first, the held one later: the same merged entry.
    rmSync(FILE_LOCK(dir, 'src/b.mjs'));
    takeFiles(dir, { id: 'ACME-2', files: ['src/z.mjs'], me: w1, now: NOW });
    const r2 = takeFiles(dir, { id: 'ACME-9', files: ['src/a.mjs', 'src/z.mjs'], me: w2, now: later(1000) });
    expect(r2.conflicts).toEqual([{ story: 'ACME-2', slot: 'w1', files: ['src/a.mjs', 'src/z.mjs'] }]);
  });

  it('does not hold a file back from the story it is kept for, and ignores an unreadable reservation', () => {
    reserveFile('src/a.mjs', { story: 'ACME-2' });
    expect(takeFiles(dir, { id: 'ACME-2', files: ['src/a.mjs'], me: w1, now: later(1000) }).ok).toBe(true);
    writeFileSync(RESERVE(dir, 'src/b.mjs'), 'not json');
    expect(takeFiles(dir, { id: 'ACME-9', files: ['src/b.mjs'], me: w2, now: later(1000) }).ok).toBe(true);
    writeFileSync(RESERVE(dir, 'src/c.mjs'), JSON.stringify({ story: 7, until: later(5000).toISOString() }));
    expect(reservationOf(dir, 'src/c.mjs', NOW)).toBeNull();
    writeFileSync(RESERVE(dir, 'src/c.mjs'), '[1]');
    expect(reservationOf(dir, 'src/c.mjs', NOW)).toBeNull();
  });

  it('does not take a file kept for another story even when a stale holder is left on it', () => {
    forceSet(FILE_LOCK(dir, 'src/a.mjs'), { pid: DEAD, slot: 'w1', story: 'ACME-1', by: 'factory', at: 'x', path: 'src/a.mjs' });
    reserveFile('src/a.mjs', { story: 'ACME-2' });
    expect(takeFiles(dir, { id: 'ACME-9', files: ['src/a.mjs'], me: w2, now: later(1000) })).toEqual({ ok: false, conflicts: [{ story: 'ACME-2', slot: null, files: ['src/a.mjs'], reserved: true }] });
  });
});

describe('reserveFreed', () => {
  const freed = [{ path: 'src/a.mjs', from: 'ACME-1' }];
  const run = (waiters, list = freed) => reserveFreed(dir, { freed: list, waiters, now: NOW });

  it('never keeps a file for the story that let it go', () => {
    waitOn('ACME-1', ['src/a.mjs'], 'ACME-7');
    expect(run([story('ACME-1', 1)])).toEqual([]);
    expect(reserveFiles()).toEqual([]);
  });

  it('skips a waiter whose record lacks the path, and keeps it for the next', () => {
    waitOn('ACME-2', ['src/other.mjs']);
    waitOn('ACME-5', ['src/a.mjs']);
    expect(run([ACME_2, ACME_5])).toEqual([{ path: 'src/a.mjs', story: 'ACME-5' }]);
    expect(JSON.parse(readFileSync(RESERVE(dir, 'src/a.mjs'), 'utf8'))).toEqual({ path: 'src/a.mjs', story: 'ACME-5', from: 'ACME-1', at: NOW.toISOString(), until: later(RESERVE_MS).toISOString() });
  });

  it('skips a waiter that another running story also blocks, and a lower waiter that would give way to it', () => {
    takeFiles(dir, { id: 'ACME-1', files: ['src/a.mjs'], me: w1, now: NOW });
    takeFiles(dir, { id: 'ACME-4', files: ['src/b.mjs'], me: { pid: process.pid, slot: 'w3' }, now: NOW });
    writeWait(dir, 'ACME-2', [{ story: 'ACME-1', slot: 'w1', files: ['src/a.mjs'] }, { story: 'ACME-4', slot: 'w3', files: ['src/b.mjs'] }], NOW);
    waitOn('ACME-5', ['src/a.mjs']);
    // ACME-2 is held up by ACME-4 as well, so nothing is kept for it. ACME-5 names the file too, but the
    // picker holds it back for ACME-2 (yieldsTo), so the file is not kept for it either.
    expect(run([ACME_2, ACME_5])).toEqual([]);
    expect(reserveFiles()).toEqual([]);
    // Without ACME-4 in the way, ACME-2 gets it.
    rmSync(FILE_LOCK(dir, 'src/b.mjs'));
    expect(run([ACME_2, ACME_5])).toEqual([{ path: 'src/a.mjs', story: 'ACME-2' }]);
  });

  it('skips a waiter that yields to a higher one, returns [] when no one waits, and removes expired reservations', () => {
    waitOn('ACME-2', ['src/b.mjs']);
    waitOn('ACME-9', ['src/a.mjs']);
    writePlan('ACME-9', { files: ['src/b.mjs'] });
    expect(run([ACME_2, ACME_9])).toEqual([]);
    expect(run([])).toEqual([]);
    reserveFile('src/old.mjs', { story: 'ACME-2', until: later(-1).toISOString() });
    reserveFile('src/live.mjs', { story: 'ACME-2' });
    writeFileSync(RESERVE(dir, 'src/junk.mjs'), 'not json');
    run([]);
    expect(reserveFiles().sort()).toEqual([basename(RESERVE(dir, 'src/live.mjs'))]);
  });

  it('keeps several freed files for their own waiters', () => {
    waitOn('ACME-2', ['src/a.mjs']);
    waitOn('ACME-5', ['src/b.mjs']);
    expect(run([ACME_2, ACME_5], [...freed, { path: 'src/b.mjs', from: 'ACME-1' }])).toEqual([
      { path: 'src/a.mjs', story: 'ACME-2' },
      { path: 'src/b.mjs', story: 'ACME-5' },
    ]);
  });
});

describe('dropReservations', () => {
  it("removes only the story's reserve files and returns their paths; a missing folder gives []", () => {
    expect(dropReservations(dir, 'ACME-2')).toEqual([]);
    reserveFile('src/a.mjs', { story: 'ACME-2' });
    reserveFile('src/b.mjs', { story: 'ACME-5' });
    reserveFile('src/c.mjs', { story: 'ACME-2' });
    takeFiles(dir, { id: 'ACME-1', files: ['src/d.mjs'], me: w1, now: NOW });
    expect(dropReservations(dir, 'ACME-2').sort()).toEqual([RESERVE(dir, 'src/a.mjs'), RESERVE(dir, 'src/c.mjs')].sort());
    expect(reserveFiles()).toEqual([basename(RESERVE(dir, 'src/b.mjs'))]);
    expect(existsSync(FILE_LOCK(dir, 'src/d.mjs'))).toBe(true);
  });
});

describe('waitOf with a reservation', () => {
  it('names the story a free file is kept for, from the plan or the record', () => {
    reserveFile('src/a.mjs', { story: 'ACME-2' });
    writePlan('ACME-9', { files: ['src/a.mjs'] });
    const w = waitOf(dir, 'ACME-9', undefined, later(1000));
    expect(w).toEqual({ id: 'ACME-9', on: [{ story: 'ACME-2', files: [], resources: [], kept: ['src/a.mjs'], deferrals: 0 }], text: 'ACME-9 waits for ACME-2: src/a.mjs (kept for it)' });
    expect(waitBlocks(dir, 'ACME-9', undefined, later(1000))).toBe(true);
    rmSync(PLAN_FILE(dir, 'ACME-9'));
    waitOn('ACME-9', ['src/a.mjs']);
    expect(waitOf(dir, 'ACME-9', undefined, later(1000)).on[0].kept).toEqual(['src/a.mjs']);
  });

  it("does not block a story on its own reservation or an expired one, and adds no kept key otherwise", () => {
    reserveFile('src/a.mjs', { story: 'ACME-2' });
    writePlan('ACME-2', { files: ['src/a.mjs'] });
    expect(waitOf(dir, 'ACME-2', undefined, later(1000))).toBeNull();
    writePlan('ACME-9', { files: ['src/a.mjs'] });
    expect(waitOf(dir, 'ACME-9', undefined, later(RESERVE_MS))).toBeNull();
    takeFiles(dir, { id: 'ACME-1', files: ['src/b.mjs'], me: w1, now: NOW });
    writePlan('ACME-7', { files: ['src/b.mjs'] });
    expect(waitOf(dir, 'ACME-7', undefined, later(1000)).on).toEqual([{ story: 'ACME-1', files: ['src/b.mjs'], resources: [], deferrals: 0 }]);
  });

  it('does not count a file as kept while a live story holds it', () => {
    takeFiles(dir, { id: 'ACME-1', files: ['src/a.mjs'], me: w1, now: NOW });
    reserveFile('src/a.mjs', { story: 'ACME-2' });
    writePlan('ACME-9', { files: ['src/a.mjs'] });
    expect(waitOf(dir, 'ACME-9', undefined, later(1000)).on).toEqual([{ story: 'ACME-1', files: ['src/a.mjs'], resources: [], deferrals: 0 }]);
  });
});

describe('yieldsTo', () => {
  const waiters = [ACME_2, ACME_5];

  it("gives the waiter whose record names a file in the story's plan or record", () => {
    waitOn('ACME-2', ['src/a.mjs']);
    writePlan('ACME-9', { files: ['src/a.mjs'] });
    expect(yieldsTo(dir, ACME_9, waiters)).toBe('ACME-2');
    rmSync(PLAN_FILE(dir, 'ACME-9'));
    expect(yieldsTo(dir, ACME_9, waiters)).toBeNull();
    waitOn('ACME-9', ['src/a.mjs']);
    expect(yieldsTo(dir, ACME_9, waiters)).toBe('ACME-2');
  });

  it('is null for a story ranked above the waiter, with no overlap, or when only the waiter plan names the file', () => {
    waitOn('ACME-5', ['src/a.mjs']);
    writePlan('ACME-2', { files: ['src/a.mjs'] });
    expect(yieldsTo(dir, ACME_2, waiters)).toBeNull();
    expect(yieldsTo(dir, ACME_9, waiters)).toBeNull();
    writePlan('ACME-9', { files: ['src/other.mjs'] });
    expect(yieldsTo(dir, ACME_9, waiters)).toBeNull();
    // ACME-2 only has a plan naming the file, no record: ACME-5 does not yield to it.
    expect(yieldsTo(dir, ACME_5, [ACME_2])).toBeNull();
    writePlan('ACME-5', { files: ['src/a.mjs'] });
    expect(yieldsTo(dir, ACME_5, [ACME_2])).toBeNull();
  });

  it('never yields to itself', () => {
    waitOn('ACME-9', ['src/a.mjs']);
    writePlan('ACME-9', { files: ['src/a.mjs'] });
    expect(yieldsTo(dir, ACME_9, [ACME_9])).toBeNull();
  });
});

describe('reserveForStart', () => {
  const run = (id = 'ACME-2') => reserveForStart(dir, id, { now: NOW });
  const kept = (path) => reservationOf(dir, path, NOW);

  it('keeps the free recorded files for the story, from null', () => {
    waitOn('ACME-2', ['src/a.mjs', 'src/b.mjs']);
    run();
    expect(JSON.parse(readFileSync(RESERVE(dir, 'src/a.mjs'), 'utf8'))).toEqual({ path: 'src/a.mjs', story: 'ACME-2', from: null, at: NOW.toISOString(), until: later(RESERVE_MS).toISOString() });
    expect(kept('src/b.mjs')).toMatchObject({ story: 'ACME-2' });
  });

  it('skips a file a live story holds and a file kept for another story, and leaves its own alone', () => {
    takeFiles(dir, { id: 'ACME-1', files: ['src/a.mjs'], me: w1, now: NOW });
    reserveFile('src/b.mjs', { story: 'ACME-5' });
    reserveFile('src/c.mjs', { story: 'ACME-2', from: 'ACME-1', at: later(-1000).toISOString() });
    waitOn('ACME-2', ['src/a.mjs', 'src/b.mjs', 'src/c.mjs']);
    run();
    expect(kept('src/a.mjs')).toBeNull();
    expect(kept('src/b.mjs')).toMatchObject({ story: 'ACME-5' });
    expect(kept('src/c.mjs')).toMatchObject({ story: 'ACME-2', from: 'ACME-1', at: later(-1000).toISOString() });
  });

  it('takes an expired reservation over, and does nothing with no record', () => {
    reserveFile('src/a.mjs', { story: 'ACME-5', until: later(-1).toISOString() });
    waitOn('ACME-2', ['src/a.mjs']);
    run();
    expect(kept('src/a.mjs')).toMatchObject({ story: 'ACME-2' });
    run('ACME-7');
    expect(reserveFiles()).toHaveLength(1);
  });
});

describe('reserveText', () => {
  it('names one file, and says them for two or more', () => {
    expect(reserveText('ACME-2', ['src/a.mjs'])).toBe('Kept src/a.mjs for ACME-2, the highest-priority story waiting on it.');
    expect(reserveText('ACME-2', ['src/a.mjs', 'src/b.mjs'])).toBe('Kept src/a.mjs and src/b.mjs for ACME-2, the highest-priority story waiting on them.');
  });
});

describe('waitReason with a reserved conflict', () => {
  it('says the file is kept for the story, one file or several', () => {
    expect(waitReason([{ story: 'ACME-2', slot: null, files: ['src/a.mjs'], reserved: true }])).toBe('waiting for ACME-2 to start: src/a.mjs is kept for it');
    expect(waitReason([{ story: 'ACME-2', slot: null, files: ['src/a.mjs', 'src/b.mjs'], reserved: true }])).toBe('waiting for ACME-2 to start: src/a.mjs and src/b.mjs are kept for it');
  });

  it('marks the reserved part of several conflicts and drops " to ship"', () => {
    const text = waitReason([
      { story: 'ACME-1', slot: 'w1', files: ['src/b.mjs'] },
      { story: 'ACME-2', slot: null, files: ['src/a.mjs'], reserved: true },
    ]);
    expect(text).toBe('waiting for ACME-1 (src/b.mjs) and ACME-2 (src/a.mjs kept for it)');
    expect(text).not.toContain(' to ship');
  });
});

describe('topFileWait', () => {
  it('is the wait of the highest-priority story, not the lowest id, and null when nothing waits', () => {
    expect(topFileWait(dir, { stories: [ACME_2, ACME_9] })).toBeNull();
    takeFiles(dir, { id: 'ACME-1', files: ['src/a.mjs'], me: w1, now: NOW });
    waitOn('ACME-2', ['src/a.mjs']);
    waitOn('ACME-9', ['src/a.mjs']);
    const first = story('ACME-9', 1);
    const second = story('ACME-2', 5);
    expect(topFileWait(dir, { stories: [second, first] })).toEqual({ id: 'ACME-9', on: waitOf(dir, 'ACME-9').on, text: 'ACME-9 waits for ACME-1: src/a.mjs' });
    expect(topFileWait(dir, { stories: [story('ACME-2', 1), story('ACME-9', 5)] }).id).toBe('ACME-2');
    expect(topFileWait(dir, { stories: [] })).toBeNull();
    expect(topFileWait(dir, {})).toBeNull();
  });
});

describe('a deferred story is not started while any running story holds its files', () => {
  const ID = '^ACME-\\d+$';
  const defer = (id, on, files, needs) => writeWait(dir, id, [{ story: on, slot: 'w1', files }], NOW, needs);
  const record = (id) => JSON.parse(readFileSync(WAIT(dir, id), 'utf8'));

  it('writeWait records the needed files, sorted, without repeats or non-strings, and no key without them', () => {
    defer('ACME-2', 'ACME-1', ['src/a.mjs'], ['src/b.mjs', 'src/a.mjs', 'src/a.mjs', 7]);
    expect(record('ACME-2')).toEqual({ story: 'ACME-2', on: ['ACME-1'], files: ['src/a.mjs'], needs: ['src/a.mjs', 'src/b.mjs'], at: NOW.toISOString(), deferrals: { 'ACME-1': 1 } });
    expect(Object.keys(record('ACME-2'))).toEqual(['story', 'on', 'files', 'needs', 'at', 'deferrals']);
    defer('ACME-3', 'ACME-1', ['src/a.mjs']);
    expect(record('ACME-3')).not.toHaveProperty('needs');
  });

  it('keeps a story deferred on a file out while the next holder has it, by lock, and picks it once the file is free', () => {
    takeFiles(dir, { id: 'ACME-1', files: ['src/a.mjs'], me: w1, now: NOW });
    defer('ACME-2', 'ACME-1', ['src/a.mjs'], ['src/a.mjs']);
    rmSync(FILE_LOCK(dir, 'src/a.mjs'));
    takeFiles(dir, { id: 'ACME-3', files: ['src/a.mjs'], me: w2, now: NOW });
    expect(waitBlocks(dir, 'ACME-2')).toBe(true);
    expect(waitOf(dir, 'ACME-2').text).toBe('ACME-2 waits for ACME-3: src/a.mjs');
    expect(nextStory([story('ACME-2', 1)], { idPattern: ID, exclude: (s) => waitBlocks(dir, s.id) })).toBeNull();
    rmSync(FILE_LOCK(dir, 'src/a.mjs'));
    expect(waitBlocks(dir, 'ACME-2')).toBe(false);
    expect(nextStory([story('ACME-2', 1)], { idPattern: ID, exclude: (s) => waitBlocks(dir, s.id) })?.id).toBe('ACME-2');
  });

  describe('through a running story\'s saved plan, with no lock', () => {
    const setUp = () => {
      defer('ACME-2', 'ACME-1', ['src/a.mjs'], ['src/a.mjs', 'src/b.mjs']);
      claimStory('ACME-3', 'w2');
      writePlan('ACME-3', { files: ['src/b.mjs'] });
    };
    const expected = { id: 'ACME-2', on: [{ story: 'ACME-3', files: ['src/b.mjs'], resources: [], deferrals: 0 }], text: 'ACME-2 waits for ACME-3: src/b.mjs' };

    it('keeps the story out, and nothing counts once the claim is dead, gone or the owner\'s', () => {
      setUp();
      expect(waitOf(dir, 'ACME-2')).toEqual(expected);
      expect(waitOf(dir, 'ACME-2', () => false)).toBeNull();
      forceSet(claimFile(dir, 'ACME-3'), { ...live, story: 'ACME-3', pid: DEAD });
      expect(waitOf(dir, 'ACME-2', (pid) => pid === process.pid)).toBeNull();
      forceSet(claimFile(dir, 'ACME-3'), { ...live, story: 'ACME-3', by: 'owner' });
      expect(waitOf(dir, 'ACME-2')).toBeNull();
      rmSync(claimFile(dir, 'ACME-3'));
      expect(waitOf(dir, 'ACME-2')).toBeNull();
    });

    it('keeps the story out of nextStory while the running plan names the file, and picks it once the claim is gone', () => {
      setUp();
      expect(nextStory([story('ACME-2', 1)], { idPattern: ID, exclude: (s) => waitBlocks(dir, s.id) })).toBeNull();
      rmSync(claimFile(dir, 'ACME-3'));
      expect(nextStory([story('ACME-2', 1)], { idPattern: ID, exclude: (s) => waitBlocks(dir, s.id) })?.id).toBe('ACME-2');
    });

    it('counts a running story that has a lock but no claim', () => {
      defer('ACME-2', 'ACME-1', ['src/a.mjs'], ['src/a.mjs', 'src/b.mjs']);
      takeFiles(dir, { id: 'ACME-3', files: ['src/c.mjs'], me: w2, now: NOW });
      writePlan('ACME-3', { files: ['src/b.mjs'] });
      expect(waitOf(dir, 'ACME-2')).toEqual(expected);
    });

    it('is listed by fileWaits with the holder id', () => {
      setUp();
      expect(fileWaits(dir)).toEqual([{ id: 'ACME-2', on: expected.on, text: expected.text }]);
    });
  });

  it('still blocks on an old record without needs', () => {
    defer('ACME-2', 'ACME-1', ['src/a.mjs']);
    claimStory('ACME-3', 'w2');
    writePlan('ACME-3', { files: ['src/a.mjs'] });
    expect(waitOf(dir, 'ACME-2')).toMatchObject({ on: [{ story: 'ACME-3', files: ['src/a.mjs'] }] });
  });

  it('counts only recorded files against plans, and never names the story itself', () => {
    writePlan('ACME-2', { files: ['src/a.mjs'] });
    claimStory('ACME-3', 'w2');
    writePlan('ACME-3', { files: ['src/a.mjs'] });
    expect(waitOf(dir, 'ACME-2')).toBeNull();
    defer('ACME-2', 'ACME-9', ['src/a.mjs'], ['src/a.mjs']);
    claimStory('ACME-2', 'w1');
    expect(waitOf(dir, 'ACME-2').on.map((e) => e.story)).toEqual(['ACME-3']);
    rmSync(claimFile(dir, 'ACME-3'));
    expect(waitOf(dir, 'ACME-2')).toBeNull();
  });

  it('lets a reservation for the waiter win over a running plan, and names another story it is kept for', () => {
    defer('ACME-2', 'ACME-1', ['src/a.mjs'], ['src/a.mjs']);
    claimStory('ACME-3', 'w2');
    writePlan('ACME-3', { files: ['src/a.mjs'] });
    reserveFile('src/a.mjs', { story: 'ACME-2' });
    expect(waitOf(dir, 'ACME-2', undefined, later(1000))).toBeNull();
    expect(nextStory([ACME_2], { idPattern: ID, exclude: (s) => waitBlocks(dir, s.id, undefined, later(1000)) })?.id).toBe('ACME-2');
    reserveFile('src/a.mjs', { story: 'ACME-9' });
    expect(waitOf(dir, 'ACME-2', undefined, later(1000)).on).toEqual([{ story: 'ACME-9', files: [], resources: [], kept: ['src/a.mjs'], deferrals: 0 }]);
  });

  it('reserveFreed still gives the waiter first claim, unless another running story plans a file it needs', () => {
    takeFiles(dir, { id: 'ACME-1', files: ['src/a.mjs'], me: w1, now: NOW });
    claimStory('ACME-1', 'w1');
    writePlan('ACME-1', { files: ['src/a.mjs'] });
    defer('ACME-2', 'ACME-1', ['src/a.mjs'], ['src/a.mjs', 'src/b.mjs']);
    const freed = [{ path: 'src/a.mjs', from: 'ACME-1' }];
    expect(reserveFreed(dir, { freed, waiters: [ACME_2], now: NOW })).toEqual([{ path: 'src/a.mjs', story: 'ACME-2' }]);
    rmSync(RESERVE(dir, 'src/a.mjs'));
    claimStory('ACME-3', 'w2');
    writePlan('ACME-3', { files: ['src/b.mjs'] });
    expect(reserveFreed(dir, { freed, waiters: [ACME_2], now: NOW })).toEqual([]);
  });
});
