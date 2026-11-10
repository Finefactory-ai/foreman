// The story sessions already running in the slots' folders (live-sessions.mjs): found from ps and
// each one's folder, the oldest of several in a folder chosen, the rest named.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doubleText, holderFor, listStorySessions, logFor, newestLog, parseStorySessions, planLive, storySessionOf } from './live-sessions.mjs';

const FLAGS = '--output-format stream-json --verbose --permission-prompts none';
const row = (pid, ppid, etime, command) => `${pid} ${ppid} ${etime} ${command}`;
const CLAUDE = (id, mode = '') => `claude -p /foreman:story ${id}${mode ? ` ${mode}` : ''} ${FLAGS}`;

describe('parseStorySessions', () => {
  it('reads the story, the mode, the age and the parent of each claude -p /foreman:story row', () => {
    const text = [
      row(101, 1, '17:04', CLAUDE('ACME-1')),
      row(102, 1, '01-02:03:04', CLAUDE('ACME-2', 'fresh')),
      row(103, 1, '00:09', `node /opt/acme/bin/claude -p /foreman:story ACME-3 ${FLAGS}`),
    ].join('\n');
    expect(parseStorySessions(text)).toEqual([
      { pid: 101, ppid: 1, ageMs: (17 * 60 + 4) * 1000, id: 'ACME-1', mode: '' },
      { pid: 102, ppid: 1, ageMs: ((24 + 2) * 3600 + 3 * 60 + 4) * 1000, id: 'ACME-2', mode: 'fresh' },
      { pid: 103, ppid: 1, ageMs: 9000, id: 'ACME-3', mode: '' },
    ]);
  });

  it('skips a shell, grep or ps that only names the prompt, and any other program', () => {
    const text = [
      row(201, 1, '10:00', `/bin/zsh -c claude -p /foreman:story ACME-1 ${FLAGS}`),
      row(202, 1, '10:00', 'grep -p /foreman:story ACME-1'),
      row(203, 1, '10:00', 'ps -axo command= -p /foreman:story ACME-1'),
      row(204, 1, '10:00', 'claude -p /foreman:other ACME-1'),
      row(205, 1, '10:00', 'claude --version'),
      'garbage',
      row(206, 1, 'nonsense', CLAUDE('ACME-9')),
    ].join('\n');
    expect(parseStorySessions(text)).toEqual([]);
  });

  it('drops a process whose parent is a session of the same story, and keeps one of another story', () => {
    const text = [row(301, 1, '20:00', CLAUDE('ACME-1')), row(302, 301, '19:00', CLAUDE('ACME-1')), row(303, 301, '19:00', CLAUDE('ACME-2'))].join('\n');
    expect(parseStorySessions(text).map((s) => s.pid)).toEqual([301, 303]);
  });

  it('drops a row whose story id is not a plain id', () => {
    const text = [
      row(401, 1, '10:00', CLAUDE('../x')),
      row(402, 1, '10:00', CLAUDE('../../x')),
      row(403, 1, '10:00', CLAUDE('ACME-1/../y')),
      row(404, 1, '10:00', CLAUDE(`A${'1'.repeat(40)}`)),
    ].join('\n');
    expect(parseStorySessions(text)).toEqual([]);
    expect(parseStorySessions(`${text}\n${row(405, 1, '10:00', CLAUDE('ACME-1'))}`).map((s) => s.pid)).toEqual([405]);
  });

  it('keeps only the modes the supervisor passes', () => {
    const modes = ['after-halt', 'fresh', 'group-summary', 'phase-summary'];
    const kept = parseStorySessions(modes.map((m, i) => row(501 + i, 1, '10:00', CLAUDE('ACME-1', m))).join('\n'));
    expect(kept.map((s) => s.mode)).toEqual(modes);
    expect(parseStorySessions([row(510, 1, '10:00', CLAUDE('ACME-1', 'evil')), row(511, 1, '10:00', CLAUDE('ACME-1', '../x'))].join('\n'))).toEqual([]);
    expect(parseStorySessions(row(512, 1, '10:00', CLAUDE('ACME-1')))[0].mode).toBe('');
  });

  it('gives [] for no text', () => {
    expect(parseStorySessions(undefined)).toEqual([]);
    expect(parseStorySessions('')).toEqual([]);
  });
});

describe('listStorySessions', () => {
  const ps = [row(101, 1, '17:04', CLAUDE('ACME-1')), row(102, 1, '16:00', CLAUDE('ACME-2'))].join('\n');

  it('takes each folder from /proc on Linux', () => {
    const sh = () => ({ status: 0, stdout: ps });
    const readlink = (p) => ({ '/proc/101/cwd': '/acme/w1', '/proc/102/cwd': '/acme/w2' })[p];
    const list = listStorySessions({ sh, platform: 'linux', readlink });
    expect(list.map((s) => [s.pid, s.id, s.cwd])).toEqual([[101, 'ACME-1', '/acme/w1'], [102, 'ACME-2', '/acme/w2']]);
  });

  it('takes the folders from one lsof call elsewhere, and null where it says none', () => {
    const calls = [];
    const sh = (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      return cmd === 'ps' ? { status: 0, stdout: ps } : { status: 1, stdout: 'p101\nfcwd\nn/acme/w1\n' };
    };
    const list = listStorySessions({ sh, platform: 'darwin' });
    expect(list.map((s) => [s.pid, s.cwd])).toEqual([[101, '/acme/w1'], [102, null]]);
    expect(calls.filter((c) => c.startsWith('lsof'))).toEqual(['lsof -a -d cwd -Fn -p 101,102']);
  });

  it('makes no second call when no session is running', () => {
    const calls = [];
    const sh = (cmd) => {
      calls.push(cmd);
      return { status: 0, stdout: '' };
    };
    expect(listStorySessions({ sh, platform: 'darwin' })).toEqual([]);
    expect(calls).toEqual(['ps']);
  });

  it('is null when ps cannot run, and has no folders when lsof throws', () => {
    expect(listStorySessions({ sh: () => ({ status: 1, stdout: '' }), platform: 'darwin' })).toBeNull();
    expect(listStorySessions({ sh: () => { throw new Error('no ps'); }, platform: 'darwin' })).toBeNull();
    const sh = (cmd) => {
      if (cmd === 'lsof') throw new Error('no lsof');
      return { status: 0, stdout: ps };
    };
    expect(listStorySessions({ sh, platform: 'darwin' }).map((s) => s.cwd)).toEqual([null, null]);
  });
});

describe('planLive', () => {
  const folders = { w1: '/acme/w1', w2: '/acme/w2', w3: '/acme/w3' };
  const s = (pid, id, ageMs, cwd, mode = '') => ({ pid, ppid: 1, ageMs, id, mode, cwd });

  it('keeps one session for each slot folder it runs in, in slot order', () => {
    const plan = planLive({ list: [s(12, 'ACME-2', 2000, '/acme/w2'), s(11, 'ACME-1', 5000, '/acme/w1', 'resume')], folders });
    expect(plan.keep).toEqual([
      { slot: 'w1', pid: 11, id: 'ACME-1', mode: 'resume', ageMs: 5000 },
      { slot: 'w2', pid: 12, id: 'ACME-2', mode: '', ageMs: 2000 },
    ]);
    expect(plan.doubles).toEqual([]);
  });

  it('ignores a session in another folder, with no folder, or already in hand', () => {
    const plan = planLive({ list: [s(1, 'ACME-1', 5, '/elsewhere'), s(2, 'ACME-2', 5, null), s(3, 'ACME-3', 5, '/acme/w3'), s(4, 'ACME-4', 5, '/acme/w1/src')], folders, own: [3] });
    expect(plan).toEqual({ keep: [], doubles: [] });
  });

  it('keeps the oldest of two in one folder (the lower pid on a tie) and names the others', () => {
    const plan = planLive({ list: [s(22, 'ACME-1', 30_000, '/acme/w1'), s(21, 'ACME-1', 900_000, '/acme/w1'), s(23, 'ACME-3', 900_000, '/acme/w1')], folders });
    expect(plan.keep.map((k) => [k.slot, k.pid])).toEqual([['w1', 21]]);
    expect(plan.doubles).toHaveLength(1);
    expect(plan.doubles[0].slot).toBe('w1');
    expect(plan.doubles[0].kept.pid).toBe(21);
    expect(plan.doubles[0].extra.map((e) => e.pid)).toEqual([23, 22]);
  });

  it('compares folders as the same place whatever the path spelling', () => {
    const plan = planLive({ list: [s(1, 'ACME-1', 5, '/acme/w1/')], folders, canon: (p) => p.replace(/\/$/, '') });
    expect(plan.keep.map((k) => k.slot)).toEqual(['w1']);
  });
});

describe('planLive with a session already in hand', () => {
  const folders = { w1: '/acme/w1', w2: '/acme/w2' };
  const s = (pid, id, ageMs, cwd) => ({ pid, ppid: 1, ageMs, id, mode: '', cwd });
  const held = { w1: { pid: 21, id: 'ACME-1' } };

  it('makes no keep for a held slot and names a second session in its folder', () => {
    const plan = planLive({ list: [s(21, 'ACME-1', 9000, '/acme/w1'), s(22, 'ACME-1', 1000, '/acme/w1')], folders, held, own: [21] });
    expect(plan.keep).toEqual([]);
    expect(plan.doubles).toHaveLength(1);
    expect(plan.doubles[0].slot).toBe('w1');
    expect(plan.doubles[0].kept).toEqual({ pid: 21, id: 'ACME-1' });
    expect(plan.doubles[0].extra.map((e) => e.pid)).toEqual([22]);
    expect(plan.doubles[0].held).toBe(true);
  });

  it('gives no keep and no double for a held slot with no other session', () => {
    const plan = planLive({ list: [s(21, 'ACME-1', 9000, '/acme/w1')], folders, held, own: [21] });
    expect(plan).toEqual({ keep: [], doubles: [] });
  });

  it('still keeps a free slot in the same call, and ignores an own pid there', () => {
    const list = [s(21, 'ACME-1', 9000, '/acme/w1'), s(22, 'ACME-1', 1000, '/acme/w1'), s(12, 'ACME-2', 2000, '/acme/w2'), s(13, 'ACME-3', 2000, '/acme/w2')];
    const plan = planLive({ list, folders, held, own: [21, 13] });
    expect(plan.keep).toEqual([{ slot: 'w2', pid: 12, id: 'ACME-2', mode: '', ageMs: 2000 }]);
    expect(plan.doubles.map((d) => d.slot)).toEqual(['w1']);
  });

  it('ignores a pid in own that sits in a free slot', () => {
    expect(planLive({ list: [s(13, 'ACME-3', 2000, '/acme/w2')], folders, held, own: [21, 13] })).toEqual({ keep: [], doubles: [] });
  });
});

describe('doubleText', () => {
  it('says the kept one was kept across the restart for a held slot', () => {
    const text = doubleText({ slot: 'w1', kept: { pid: 21, id: 'ACME-1' }, extra: [{ pid: 22, id: 'ACME-1' }], held: true });
    expect(text).toBe('w1 has 2 story sessions in its folder: ACME-1 (pid 21), ACME-1 (pid 22). Keeping ACME-1 (pid 21), the one kept across the restart; end the other with `kill 22`.');
  });

  it('names the slot, the kept session, the others and a kill hint for each', () => {
    const text = doubleText({ slot: 'w1', kept: { pid: 21, id: 'ACME-1' }, extra: [{ pid: 23, id: 'ACME-3' }, { pid: 22, id: 'ACME-1' }] });
    expect(text).toBe('w1 has 3 story sessions in its folder: ACME-1 (pid 21), ACME-3 (pid 23), ACME-1 (pid 22). Keeping ACME-1 (pid 21), the oldest; end the others with `kill 23` and `kill 22`.');
  });
});

describe('holderFor', () => {
  const ours = new Set([7, 8]);
  const args = (claim) => ({ claim, slot: 'w1', ours, me: 9 });

  it('is me when the story has no claim', () => {
    expect(holderFor(args(undefined))).toEqual({ holderPid: 9 });
  });

  it("takes the pid of a dead supervisor's claim in this slot, so its locks are vouched for", () => {
    expect(holderFor(args({ pid: 4242, slot: 'w1', stale: true }))).toEqual({ holderPid: 4242 });
  });

  it('takes a claim in the pids this process already counts as its own', () => {
    expect(holderFor(args({ pid: 7, slot: 'w1', stale: false }))).toEqual({ holderPid: 7 });
  });

  it("is me for a dead claim of another slot, or one with no usable pid", () => {
    expect(holderFor(args({ pid: 4242, slot: 'w2', stale: true }))).toEqual({ holderPid: 9 });
    expect(holderFor(args({ slot: 'w1', stale: true }))).toEqual({ holderPid: 9 });
  });

  it("leaves a session alone when a live run's claim, or the owner's, holds the story", () => {
    expect(holderFor(args({ pid: 4242, slot: 'w1', stale: false }))).toEqual({ heldBy: 'pid 4242' });
    expect(holderFor(args({ by: 'owner', stale: false }))).toEqual({ heldBy: 'the owner' });
  });
});

describe('newestLog', () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });
  const logs = (files) => {
    dir = mkdtempSync(join(tmpdir(), 'acme-logs-'));
    for (const [name, at] of Object.entries(files)) {
      writeFileSync(join(dir, name), '');
      utimesSync(join(dir, name), at, at);
    }
    return dir;
  };

  it("returns the slot's newest .log and ignores other slots and other files", () => {
    const folder = logs({ 'w1-a.log': 1000, 'w1-b.log': 3000, 'w2-c.log': 5000, 'w1-x.txt': 9000 });
    expect(newestLog({ folder, slot: 'w1' })).toBe(join(folder, 'w1-b.log'));
  });

  it('skips a log that vanished between the listing and the stat', () => {
    const folder = logs({ 'w1-a.log': 1000, 'w1-b.log': 3000 });
    const stat = (p) => {
      if (p.endsWith('w1-b.log')) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      return { mtimeMs: 1000 };
    };
    expect(newestLog({ folder, slot: 'w1', stat })).toBe(join(folder, 'w1-a.log'));
  });

  it('is the empty log name when the folder cannot be read', () => {
    const folder = join(tmpdir(), 'acme-no-such-folder-for-logs');
    mkdirSync(folder, { recursive: true });
    rmSync(folder, { recursive: true });
    expect(newestLog({ folder, slot: 'w1' })).toBe(join(folder, 'w1-live.log'));
  });
});

describe('logFor', () => {
  const kept = { slot: 'w1', pid: 21, id: 'ACME-1' };
  const folder = '/acme/logs';
  const newest = () => '/acme/logs/w1-newest.log';
  const spy = () => {
    throw new Error('newest must not be called');
  };

  it("is the mark's log when the mark names the kept session", () => {
    expect(logFor({ mark: { pid: 21, story: 'ACME-1', log: '/acme/logs/w1-mine.log' }, kept, doubled: true, folder, newest: spy })).toBe('/acme/logs/w1-mine.log');
  });

  it('gives the empty log in a doubled folder when the mark names another session, and never reads the newest', () => {
    expect(logFor({ mark: { pid: 22, story: 'ACME-1', log: '/acme/logs/w1-other.log' }, kept, doubled: true, folder, newest: spy })).toBe(join(folder, 'w1-live.log'));
  });

  it('is the newest log when the folder has no double', () => {
    expect(logFor({ mark: { pid: 22, story: 'ACME-1', log: '/acme/logs/w1-other.log' }, kept, doubled: false, folder, newest })).toBe('/acme/logs/w1-newest.log');
  });

  it('gives the empty log for no mark in a doubled folder', () => {
    expect(logFor({ mark: null, kept, doubled: true, folder, newest: spy })).toBe(join(folder, 'w1-live.log'));
  });
});

describe('storySessionOf', () => {
  it('reads the story and the mode of one story-session command line', () => {
    expect(storySessionOf('claude -p /foreman:story ACME-1 resume --verbose')).toEqual({ id: 'ACME-1', mode: 'resume' });
    expect(storySessionOf(CLAUDE('ACME-2'))).toEqual({ id: 'ACME-2', mode: '' });
  });

  it('gives null for a shell, a grep, a line with no story or something else', () => {
    expect(storySessionOf('zsh -c claude -p /foreman:story ACME-1')).toBeNull();
    expect(storySessionOf('grep -p /foreman:story ACME-1')).toBeNull();
    expect(storySessionOf('claude -p /foreman:story --verbose')).toBeNull();
    expect(storySessionOf('node server.js')).toBeNull();
    expect(storySessionOf(undefined)).toBeNull();
  });
});
