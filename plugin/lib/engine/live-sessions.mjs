// The story sessions running now in the slots' folders, found from the machine itself rather than
// from what a supervisor wrote down. A supervisor that starts (after a hard kill, a crash, or a
// restart whose hand-over did not reach it) adopts these instead of starting each story again
// beside its live session (supervisor.mjs), and `foreman doctor` warns when one folder has two
// (doctor-checks.mjs). Pure apart from the `sh` and `readlink` passed in.
//
//   parseStorySessions(psText) -> [{ pid, ppid, ageMs, id, mode }]
//       from `ps -axo pid=,ppid=,etime=,command=`: every row that runs `<program> ... -p
//       /foreman:story <id> [mode] ...` (session.mjs command), the program not a shell, grep or
//       ps. A process whose parent is a session of the same story is that session's child, and
//       left out. mode is the word after the id that is not a flag, else ''. A row whose id is not
//       a plain story id (next-request.mjs isStoryId) or whose mode is not in SESSION_MODES is
//       dropped: the id reaches claim and lock paths. storySessionOf itself reads any words
//       (kill-guard.mjs depends on that).
//   storySessionOf(command) -> { id, mode } when one command line is such a session, else null
//   listStorySessions({ sh, platform, readlink }) -> [{ pid, ppid, ageMs, id, mode, cwd }], or
//       null when ps cannot run. cwd is the session's folder: /proc/<pid>/cwd on Linux, else one
//       lsof call (a Linux session or a folder it cannot read has null).
//   planLive({ list, folders, held?, own?, canon? }) -> { keep, doubles }
//       folders is { slot: path }; own are pids already in hand; held is { slot: { pid, id } }, the
//       session already in hand for a slot. keep is, in slot order, one { slot, pid, id, mode,
//       ageMs } for each folder with a session in it (the folder itself, not a place under it),
//       the oldest, the lower pid on a tie; a held slot gets none. doubles is { slot, kept, extra }
//       for each folder with more than one session: extra are the others, oldest first. For a held
//       slot, kept is the held session, any other session in the folder is extra, and held is true.
//   doubleText({ slot, kept, extra, held? }) -> the one warning for such a folder, with a
//       `kill <pid>` for each session left over. held words kept as "the one kept across the
//       restart" rather than "the oldest".
//   newestLog({ folder, slot, readdir?, stat? }) -> the slot's newest `<slot>-*.log` in folder,
//       else `<slot>-live.log` (a name no log has, which reads as an empty log). A log that goes
//       between the listing and its stat is skipped.
//   logFor({ mark, kept, doubled, folder, newest? }) -> the log an adopted session's ending is read
//       from: the slot's mark when it names the kept pid and story; else, in a folder with a
//       double (the mark and the newest log may be the other session's), the empty log; else the
//       newest.
//   killText(sessions) -> "`kill 7`, `kill 8` and `kill 9`"
//   holderFor({ claim, slot, ours, me }) -> { holderPid } | { heldBy }
//       whose claim the session's story is under: `claim` is the story's claim from locks.mjs
//       claims() (or none), ours the pids this process counts as its own. heldBy ('pid 7' or
//       'the owner') when a live claim of someone else holds it, so the session is left alone;
//       else holderPid: the pid a claim in this slot names (a dead supervisor's, which this
//       process will vouch for), else me.
//   foldersText({ slot, sessions }) -> "w1 has 2 story sessions in its folder: ACME-1 (pid 7), ..."

import { spawnSync } from 'node:child_process';
import { readdirSync, readlinkSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { canonical } from './leash.mjs';
import { isStoryId } from './next-request.mjs';
import { lsofFolders, parseEtime } from './strays.mjs';

const PROMPT = '/foreman:story';
// The words a story session may carry after its id: what the supervisor passes (scheduler.mjs
// 'after-halt', supervisor.mjs 'fresh', slot-work.mjs 'group-summary') and the story skill's
// 'phase-summary'. '' is no mode.
export const SESSION_MODES = new Set(['', 'after-halt', 'fresh', 'group-summary', 'phase-summary']);
const NOT_A_SESSION = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'grep', 'egrep', 'rg', 'ps', 'pgrep', 'less', 'tail', 'cat']);

const localSh = (cmd, args = []) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 });
  return { status: r.status ?? 1, stdout: r.stdout ?? '' };
};

// { id, mode } when the command line is a story session (`<program> ... -p /foreman:story <id>
// [mode] ...`, the program not a shell, grep or ps), else null.
export function storySessionOf(command) {
  const words = String(command ?? '').trim().split(/\s+/);
  const at = words.findIndex((w, i) => w === '-p' && words[i + 1] === PROMPT);
  if (at < 1 || NOT_A_SESSION.has(basename(words[0]))) return null;
  const id = words[at + 2];
  if (!id || id.startsWith('-')) return null;
  const mode = words[at + 3] && !words[at + 3].startsWith('-') ? words[at + 3] : '';
  return { id, mode };
}

export function parseStorySessions(text) {
  const rows = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const ageMs = parseEtime(m[3]);
    const session = ageMs === null ? null : storySessionOf(m[4]);
    if (!session || !isStoryId(session.id) || !SESSION_MODES.has(session.mode)) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), ageMs, ...session });
  }
  return rows.filter((r) => !rows.some((p) => p.pid === r.ppid && p.id === r.id));
}

export function listStorySessions({ sh = localSh, platform = process.platform, readlink = readlinkSync } = {}) {
  let r;
  try {
    r = sh('ps', ['-axo', 'pid=,ppid=,etime=,command=']);
  } catch {
    return null;
  }
  if (!r || r.status !== 0) return null;
  const list = parseStorySessions(r.stdout).map((s) => ({ ...s, cwd: null }));
  if (!list.length) return list;
  if (platform === 'linux') {
    for (const s of list) {
      try {
        s.cwd = String(readlink(`/proc/${s.pid}/cwd`)) || null;
      } catch {
        s.cwd = null;
      }
    }
    return list;
  }
  let folders = new Map();
  try {
    // lsof exits 1 when one of the pids has gone; what it printed for the others still counts.
    folders = lsofFolders(sh('lsof', ['-a', '-d', 'cwd', '-Fn', '-p', list.map((s) => s.pid).join(',')])?.stdout);
  } catch {
    // no lsof: no folders
  }
  for (const s of list) s.cwd = folders.get(s.pid) || null;
  return list;
}

const oldestFirst = (a, b) => b.ageMs - a.ageMs || a.pid - b.pid;

export function planLive({ list, folders, held = {}, own = [], canon = canonical }) {
  const where = new Map(Object.entries(folders ?? {}).map(([slot, path]) => [canon(path), slot]));
  const bySlot = new Map();
  for (const s of Array.isArray(list) ? list : []) {
    if (!s?.cwd || own.includes(s.pid) || Object.values(held).some((h) => h?.pid === s.pid)) continue;
    const slot = where.get(canon(s.cwd));
    if (!slot) continue;
    bySlot.set(slot, [...(bySlot.get(slot) ?? []), s]);
  }
  const keep = [];
  const doubles = [];
  for (const slot of Object.keys(folders ?? {})) {
    const sessions = (bySlot.get(slot) ?? []).sort(oldestFirst);
    if (!sessions.length) continue;
    if (held?.[slot]) {
      doubles.push({ slot, kept: held[slot], extra: sessions, held: true });
      continue;
    }
    const [first, ...extra] = sessions;
    keep.push({ slot, pid: first.pid, id: first.id, mode: first.mode, ageMs: first.ageMs });
    if (extra.length) doubles.push({ slot, kept: first, extra });
  }
  return { keep, doubles };
}

const one = (s) => `${s.id} (pid ${s.pid})`;

export function foldersText({ slot, sessions }) {
  return `${slot} has ${sessions.length} story sessions in its folder: ${sessions.map(one).join(', ')}`;
}

export function killText(sessions) {
  const kills = sessions.map((s) => `\`kill ${s.pid}\``);
  return kills.length > 1 ? `${kills.slice(0, -1).join(', ')} and ${kills.at(-1)}` : kills[0];
}

export function doubleText({ slot, kept, extra, held }) {
  return `${foldersText({ slot, sessions: [kept, ...extra] })}. Keeping ${one(kept)}, ${held ? 'the one kept across the restart' : 'the oldest'}; end ${extra.length > 1 ? 'the others' : 'the other'} with ${killText(extra)}.`;
}

export function holderFor({ claim, slot, ours, me }) {
  if (!claim) return { holderPid: me };
  if (!claim.stale && !ours.has(claim.pid)) return { heldBy: Number.isInteger(claim.pid) ? `pid ${claim.pid}` : 'the owner' };
  return { holderPid: claim.slot === slot && Number.isInteger(claim.pid) && claim.pid > 0 ? claim.pid : me };
}

export function newestLog({ folder, slot, readdir = readdirSync, stat = statSync }) {
  let names = [];
  try {
    names = readdir(folder).filter((n) => n.startsWith(`${slot}-`) && n.endsWith('.log'));
  } catch {
    // no logs yet
  }
  let newest = null;
  for (const name of names) {
    let mtimeMs;
    try {
      mtimeMs = stat(join(folder, name)).mtimeMs;
    } catch {
      continue; // removed since the listing
    }
    if (!newest || mtimeMs > newest.mtimeMs) newest = { name, mtimeMs };
  }
  return join(folder, newest?.name ?? `${slot}-live.log`);
}

export function logFor({ mark, kept, doubled, folder, newest = newestLog }) {
  if (mark?.pid === kept.pid && mark.story === kept.id && typeof mark.log === 'string') return mark.log;
  if (doubled) return join(folder, `${kept.slot}-live.log`);
  return newest({ folder, slot: kept.slot });
}
