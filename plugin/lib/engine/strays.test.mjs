import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { endStrays, findStrays, kindOf, listProcesses, parseEtime, processKind, STRAY_AGE_MS, strayPatch, straysText } from './strays.mjs';
import { writePid } from './supervisor-pid.mjs';

const SUP = '/opt/acme/plugin/lib/engine/supervisor.mjs';
const HOOK = '/tmp/foreman-plugin-x/plugin/lib/hooks/agent-events.mjs';
const OWNER = '/tmp/foreman-owner-commands-x/foreman.cjs';

describe('kindOf', () => {
  it.each([
    [`node ${SUP} --max 0`, 'supervisor'],
    [`/usr/local/bin/node ${SUP}`, 'supervisor'],
    ['node /tmp/acme/plugin/lib/hooks/agent-events.mjs --decide', 'hook'],
    ['node /tmp/acme/plugin/lib/hooks/agent-events.mjs', 'hook'],
    [`node ${OWNER} learn`, 'owner'],
    ['/usr/local/bin/node /opt/acme/plugin/bin/foreman notify --kind stopped', 'owner'],
    ['node /opt/acme/plugin/bin/foreman run --foreground', null],
    ['node foreman.cjs status', null],
    ['node foreman.mjs learn', 'owner'],
    ['/bin/zsh -c ps -axo command= | grep /tmp/acme/plugin/lib/hooks/agent-events.mjs', null],
    [`grep ${HOOK}`, null],
    [`grep ${SUP}`, null],
    [`/bin/zsh ${OWNER} learn`, null],
    ['vim notes.txt', null],
    ['', null],
  ])('%s -> %s', (command, kind) => {
    expect(kindOf(command)).toBe(kind);
  });
});

describe('parseEtime', () => {
  it('reads mm:ss, hh:mm:ss and dd-hh:mm:ss', () => {
    expect(parseEtime('03:04')).toBe((3 * 60 + 4) * 1000);
    expect(parseEtime('02:03:04')).toBe(((2 * 60 + 3) * 60 + 4) * 1000);
    expect(parseEtime('1-02:03:04')).toBe((((24 + 2) * 60 + 3) * 60 + 4) * 1000);
    expect(parseEtime('  20:00 ')).toBe(20 * 60 * 1000);
  });

  it('gives null for anything else', () => {
    for (const t of ['', 'abc', '1-03:04', '3:4:5:6', null, undefined, '12']) expect(parseEtime(t), String(t)).toBeNull();
  });
});

// A fake shell answering ps and lsof.
function fakeSh({ ps = { status: 0, stdout: '' }, lsof = { status: 0, stdout: '' } } = {}) {
  const calls = [];
  const sh = (cmd, args = []) => {
    calls.push([cmd, ...args]);
    if (cmd === 'ps') return ps;
    if (cmd === 'lsof') return lsof;
    return { status: 1, stdout: '' };
  };
  sh.calls = calls;
  return sh;
}
const row = (pid, rss, etime, command) => `${String(pid).padStart(6)} ${String(rss).padStart(7)} ${etime.padStart(11)} ${command}`;

describe('listProcesses', () => {
  const PS = [
    row(111, 2048, '20:00', `node ${SUP} --max 0`),
    row(222, 4096, '1-00:00:00', '/usr/local/bin/node /tmp/acme/plugin/lib/engine/supervisor.mjs'),
    row(333, 1024, '05:00', 'node /opt/acme/plugin/bin/foreman run --foreground'),
    row(444, 512, '05:00', 'vim notes.txt'),
    row(555, 512, '30:00', `/bin/zsh -c ps -axo command= | grep ${SUP}`),
    row(666, 512, '30:00', `grep ${SUP}`),
    row(777, 256, '15:00', `node ${HOOK} --decide`),
    row(888, 128, '16:00', `node ${OWNER} learn`),
  ].join('\n');

  it('keeps the supervisor, hook and owner-command rows with their kind, and reads their folders from lsof on macOS', () => {
    const sh = fakeSh({ ps: { status: 0, stdout: PS }, lsof: { status: 0, stdout: 'p111\nfcwd\nn/private/tmp/acme one\np222\nfcwd\nn/srv/acme\np777\nfcwd\nn/tmp/hook\n' } });
    const list = listProcesses({ sh, platform: 'darwin' });
    expect(list).toEqual([
      { pid: 111, rssKb: 2048, ageMs: 20 * 60_000, cwd: '/private/tmp/acme one', kind: 'supervisor' },
      { pid: 222, rssKb: 4096, ageMs: 24 * 3600_000, cwd: '/srv/acme', kind: 'supervisor' },
      { pid: 777, rssKb: 256, ageMs: 15 * 60_000, cwd: '/tmp/hook', kind: 'hook' },
      { pid: 888, rssKb: 128, ageMs: 16 * 60_000, cwd: null, kind: 'owner' },
    ]);
    expect(sh.calls).toContainEqual(['ps', '-axo', 'pid=,rss=,etime=,command=']);
    expect(sh.calls).toContainEqual(['lsof', '-a', '-d', 'cwd', '-Fn', '-p', '111,222,777,888']);
  });

  it('reads /proc/<pid>/cwd on Linux, null where it cannot', () => {
    const sh = fakeSh({ ps: { status: 0, stdout: PS } });
    const readlink = (p) => {
      if (p === '/proc/111/cwd') return '/tmp/acme';
      throw new Error('EACCES');
    };
    const list = listProcesses({ sh, platform: 'linux', readlink });
    expect(list.map((s) => [s.pid, s.cwd, s.kind])).toEqual([[111, '/tmp/acme', 'supervisor'], [222, null, 'supervisor'], [777, null, 'hook'], [888, null, 'owner']]);
    expect(sh.calls.some(([c]) => c === 'lsof')).toBe(false);
  });

  it('gives every folder null when lsof fails', () => {
    const sh = fakeSh({ ps: { status: 0, stdout: PS }, lsof: { status: 1, stdout: '' } });
    expect(listProcesses({ sh, platform: 'darwin' }).map((s) => s.cwd)).toEqual([null, null, null, null]);
  });

  it('gives null when ps fails, and an empty list when none of them runs', () => {
    expect(listProcesses({ sh: fakeSh({ ps: { status: 1, stdout: '' } }), platform: 'darwin' })).toBeNull();
    const none = fakeSh({ ps: { status: 0, stdout: row(444, 512, '05:00', 'vim notes.txt') } });
    expect(listProcesses({ sh: none, platform: 'darwin' })).toEqual([]);
    expect(none.calls.some(([c]) => c === 'lsof')).toBe(false);
  });
});

describe('findStrays', () => {
  let tmpRoot;
  let root;
  beforeEach(() => {
    tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-strays-tmp-')));
    root = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-strays-acme-')));
    mkdirSync(join(root, '.foreman', 'worktrees', 'w1'), { recursive: true });
    writePid(join(root, '.foreman'), 111);
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  // The fixture: this run's supervisor, this process, a temp stray, a slot's stray, a young one,
  // another project's run, one whose folder is unknown, an old hook and an old learn in temp, a
  // young hook and an old hook in another project.
  const HOOK_SCRIPT = `${HOOK} --decide`;
  const fixture = (selfPid) => {
    const rows = [
      [111, 1000, '30:00', root],
      [selfPid, 1000, '30:00', root],
      [222, 1024 * 1024, '20:00', join(tmpRoot, 'foreman-state-x', 'acme')],
      [333, 512 * 1024, '11:00', join(root, '.foreman', 'worktrees', 'w1')],
      [444, 1000, '02:00', join(tmpRoot, 'young')],
      [555, 1000, '1-00:00:00', '/srv/other-project'],
      [666, 1000, '1-00:00:00', null],
      [777, 1024, '1-00:00:00', join(tmpRoot, 'foreman-plugin-x'), HOOK_SCRIPT],
      [888, 1024, '1-00:00:00', join(tmpRoot, 'foreman-owner-commands-x'), `${OWNER} learn`],
      [999111, 1000, '00:30', join(tmpRoot, 'young-hook'), HOOK_SCRIPT],
      [999222, 1000, '1-00:00:00', '/srv/other-project', HOOK_SCRIPT],
    ];
    const ps = rows.map(([pid, rss, etime, , script]) => row(pid, rss, etime, `node ${script ?? SUP}`)).join('\n');
    const lsof = rows.filter(([, , , cwd]) => cwd).map(([pid, , , cwd]) => `p${pid}\nfcwd\nn${cwd}`).join('\n');
    return fakeSh({ ps: { status: 0, stdout: ps }, lsof: { status: 0, stdout: `${lsof}\n` } });
  };

  it("counts only old supervisors in temp folders or this project's folders that are not this run's", () => {
    const selfPid = 999;
    const r = findStrays({ root, dir: join(root, '.foreman'), sh: fixture(selfPid), platform: 'darwin', roots: [tmpRoot], selfPid });
    expect(r.listed).toBe(true);
    expect(r.strays.map((s) => [s.pid, s.where, s.kind])).toEqual([
      [222, 'temp', 'supervisor'],
      [333, 'project', 'supervisor'],
      [777, 'temp', 'hook'],
      [888, 'temp', 'owner'],
    ]);
    expect(r.mb).toBe(1024 + 512 + 1 + 1);
    expect(STRAY_AGE_MS).toBe(10 * 60_000);
  });

  it('says it could not list them when ps fails', () => {
    const r = findStrays({ root, dir: join(root, '.foreman'), sh: fakeSh({ ps: { status: 1, stdout: '' } }), platform: 'darwin', roots: [tmpRoot] });
    expect(r).toEqual({ listed: false, strays: [], mb: 0 });
  });
});

describe('straysText', () => {
  it('names the count, where they are and the memory, singular or plural, MB or GB', () => {
    expect(straysText({ strays: [{ where: 'temp' }, { where: 'project' }], mb: 1228.8 })).toBe(
      "2 supervisors that are not this run's (1 in temp folders, 1 in this project's folders), holding about 1.2 GB",
    );
    expect(straysText({ strays: [{ where: 'temp' }], mb: 300.4 })).toBe("1 supervisor that is not this run's (1 in temp folders), holding about 300 MB");
    expect(straysText({ strays: [{ where: 'project' }, { where: 'project' }, { where: 'project' }], mb: 1023 })).toBe(
      "3 supervisors that are not this run's (3 in this project's folders), holding about 1023 MB",
    );
  });
});

describe('straysText with hooks and owner commands', () => {
  it('names each kind, in the order supervisor, hook, owner', () => {
    const strays = [
      { where: 'temp', kind: 'owner' },
      { where: 'project', kind: 'supervisor' },
      { where: 'temp', kind: 'hook' },
    ];
    expect(straysText({ strays, mb: 2 })).toBe(
      "3 processes that are not this run's (1 supervisor, 1 hook run, 1 learn or notify run; 2 in temp folders, 1 in this project's folders), holding about 2 MB",
    );
    expect(straysText({ strays: [{ where: 'temp', kind: 'hook' }], mb: 40 })).toBe("1 process that is not this run's (1 hook run; 1 in temp folders), holding about 40 MB");
    expect(straysText({ strays: [{ where: 'temp', kind: 'hook' }, { where: 'temp', kind: 'hook' }, { where: 'temp', kind: 'supervisor' }, { where: 'temp', kind: 'supervisor' }], mb: 1 })).toBe(
      "4 processes that are not this run's (2 supervisors, 2 hook runs; 4 in temp folders), holding about 1 MB",
    );
  });

  it('keeps the supervisor-only text when every stray is a supervisor', () => {
    expect(straysText({ strays: [{ where: 'temp', kind: 'supervisor' }], mb: 300.4 })).toBe("1 supervisor that is not this run's (1 in temp folders), holding about 300 MB");
  });
});

describe('processKind', () => {
  it('reads the kind of what a pid runs now from ps', () => {
    const sh = fakeSh({ ps: { status: 0, stdout: `node ${HOOK} --decide\n` } });
    expect(processKind(222, { sh })).toBe('hook');
    expect(sh.calls).toContainEqual(['ps', '-o', 'command=', '-p', '222']);
  });

  it('gives null when ps fails or the pid runs something else', () => {
    expect(processKind(222, { sh: fakeSh({ ps: { status: 1, stdout: '' } }) })).toBeNull();
    expect(processKind(222, { sh: fakeSh({ ps: { status: 0, stdout: 'vim notes.txt\n' } }) })).toBeNull();
  });
});

describe('endStrays', () => {
  // A fake kill over a set of live pids; `survives` lives through SIGTERM.
  const world = (live, survives = []) => {
    const pids = new Set(live);
    const calls = [];
    const kill = (pid, signal) => {
      calls.push([pid, signal]);
      if (!pids.has(pid)) {
        const err = new Error('no such process');
        err.code = 'ESRCH';
        throw err;
      }
      if (signal === 'SIGKILL' || (signal === 'SIGTERM' && !survives.includes(pid))) pids.delete(pid);
      return true;
    };
    return { kill, calls };
  };
  const sleep = async () => {};

  it('skips pid 1, this process and a pid that no longer runs a supervisor, and ends the rest', async () => {
    const w = world([1, process.pid, 222, 333, 444]);
    const stillRuns = (pid) => pid !== 444;
    const r = await endStrays([{ pid: 1 }, { pid: process.pid }, { pid: 222 }, { pid: 333 }, { pid: 444 }], { stillRuns, kill: w.kill, sleep });
    expect(r).toEqual({ ended: [222, 333], left: [] });
    const signalled = w.calls.filter(([, s]) => s !== 0).map(([p]) => p);
    expect(new Set(signalled)).toEqual(new Set([222, 333]));
  });

  it('kills a survivor after waitMs and reports one that is still there', async () => {
    const w = world([222, 333], [333]);
    const r = await endStrays([{ pid: 222 }, { pid: 333 }], { stillRuns: () => true, kill: w.kill, sleep, waitMs: 300 });
    expect(r).toEqual({ ended: [222, 333], left: [] });
    expect(w.calls).toContainEqual([333, 'SIGKILL']);
    expect(w.calls).not.toContainEqual([222, 'SIGKILL']);

    const stuck = { calls: [], kill: (pid, signal) => stuck.calls.push([pid, signal]) };
    const r2 = await endStrays([{ pid: 555 }], { stillRuns: () => true, kill: stuck.kill, sleep, waitMs: 200 });
    expect(r2).toEqual({ ended: [], left: [555] });
    expect(stuck.calls).toContainEqual([555, 'SIGKILL']);
  });
});

describe('endStrays by kind', () => {
  const world = () => {
    const calls = [];
    return { calls, kill: (pid, signal) => calls.push([pid, signal]) };
  };

  it('does not signal a pid that now runs another kind, and hands stillRuns the kind', async () => {
    const w = world();
    const asked = [];
    const stillRuns = (pid, kind) => {
      asked.push([pid, kind]);
      return pid === 555;
    };
    await endStrays([{ pid: 444, kind: 'hook' }, { pid: 555, kind: 'owner' }, { pid: 666 }], { stillRuns, kill: w.kill, sleep: async () => {}, waitMs: 0 });
    expect(asked).toEqual([[444, 'hook'], [555, 'owner'], [666, undefined]]);
    expect(w.calls.filter(([, s]) => s === 'SIGTERM').map(([p]) => p)).toEqual([555]);
  });
});

describe('strayPatch', () => {
  const AT = '2026-10-31T10:00:00.000Z';
  const found = (pids, mb = 1.5) => ({ listed: true, strays: pids.map((pid) => ({ pid })), mb });

  it('writes the first list found, with mb rounded', () => {
    expect(strayPatch(undefined, found([222, 333]), AT)).toEqual({ strays: { pids: [222, 333], mb: 2, at: AT } });
  });

  it('writes nothing when the pids are the same, whatever their memory or time', () => {
    expect(strayPatch({ pids: [222, 333], mb: 9, at: 'old' }, found([222, 333], 700), AT)).toBeNull();
  });

  it('writes the new list when it changes', () => {
    expect(strayPatch({ pids: [222, 333], mb: 2, at: 'old' }, found([333, 444], 3.4), AT)).toEqual({ strays: { pids: [333, 444], mb: 3, at: AT } });
  });

  it('writes null when they have all gone', () => {
    expect(strayPatch({ pids: [222, 333], mb: 2, at: 'old' }, found([], 0), AT)).toEqual({ strays: null });
  });

  it('writes nothing when there were none and are none', () => {
    expect(strayPatch(null, found([], 0), AT)).toBeNull();
    expect(strayPatch(undefined, found([], 0), AT)).toBeNull();
  });

  it('keeps the last list when ps failed', () => {
    expect(strayPatch({ pids: [222, 333], mb: 2, at: 'old' }, { listed: false, strays: [], mb: 0 }, AT)).toBeNull();
  });
});
