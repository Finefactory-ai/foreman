// The sessions a supervisor hands to the next one when it restarts on new code (supervisor.mjs):
// the old process lists them in state.json's `restart`, and the new one adopts them, polls their
// pids and handles each ending as its own. Pure apart from sessionAlive's defaults.
//
//   handoverSessions(entries, me) -> [{ slot, id, mode, pid, startedAt, log, usedKey, holderPid }]
//       from the supervisor's [slot, session] pairs, leaving out any session being stopped.
//       holderPid is the pid its claims and locks are held under: the session's own, else `me`.
//   resultArrived(s, { tail }) -> whether the session's log already ends with its final result
//       (FACTORY_RESULT, no background task open: session-outlive.mjs finalResult). Such a session
//       is ending, not running on: the supervisor holds a restart until its exit is handled, so
//       handoverSessions never lists it and "Kept N" never names a story that just ended.
//   adoptable(list, slotIds) -> the entries the new process may adopt: a slot it has (the first
//       entry for each), a string id and log, a positive-integer pid and holderPid, and a finite
//       startedAt. Anything else, or a list that is not one, is dropped.
//   leftOut(list, kept) -> the entries of `list` that are not in `kept` (by identity) and still
//       name a session: an object with a string id and a positive-integer pid. These are the
//       sessions the new process could not adopt (a slot it no longer has, a second entry for a
//       slot), which it ends. Anything but a list gives [].
//   keptText(list, slotIds) -> the "Kept N running across the restart: ID (slot), ..." event
//       text, the sessions in slot order whatever order they started in (slots prepare in
//       parallel, so a handover's or ps's order varies from run to run).
//   adoptedPids(fromPid, sessions) -> the unique positive integers among fromPid and every
//       holderPid: the pids supervisor-adopted.json vouches for.
//   sessionAlive({ pid, id }, { kill, ps, procStat }) -> the process exists (EPERM counts) and
//       `ps` shows it is that story's session (`/foreman:story <id>`), so a pid reused by another
//       program is never watched or signalled. When ps itself cannot run, the kill check decides,
//       except that a process /proc/<pid>/stat shows as a zombie (Z) or dead (X) has ended: a
//       container whose PID 1 reaps no orphans keeps them. With no /proc (macOS), the kill check
//       alone decides.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { finalResult, readTail } from './session-outlive.mjs';

const isPid = (v) => Number.isInteger(v) && v > 0;

export function handoverSessions(entries, me) {
  const list = [];
  for (const [slot, s] of entries) {
    if (s.stop) continue;
    list.push({ slot, id: s.id, mode: s.mode, pid: s.pid, startedAt: s.startedAt, log: s.log, usedKey: s.usedKey, holderPid: s.holderPid ?? me });
  }
  return list;
}

export function resultArrived(s, { tail = readTail } = {}) {
  if (typeof s?.log !== 'string' || !s.log) return false;
  return finalResult(tail(s.log)) !== null;
}

export function adoptable(list, slotIds) {
  if (!Array.isArray(list)) return [];
  const taken = new Set();
  const kept = [];
  for (const e of list) {
    if (!e || typeof e !== 'object' || !slotIds.includes(e.slot) || taken.has(e.slot)) continue;
    if (typeof e.id !== 'string' || typeof e.log !== 'string' || !isPid(e.pid) || !isPid(e.holderPid) || !Number.isFinite(e.startedAt)) continue;
    taken.add(e.slot);
    kept.push(e);
  }
  return kept;
}

export function leftOut(list, kept) {
  if (!Array.isArray(list)) return [];
  const keep = new Set(Array.isArray(kept) ? kept : []);
  return list.filter((e) => e && typeof e === 'object' && typeof e.id === 'string' && isPid(e.pid) && !keep.has(e));
}

export function keptText(list, slotIds) {
  const at = (s) => {
    const i = slotIds.indexOf(s.slot);
    return i === -1 ? slotIds.length : i;
  };
  const names = [...list].sort((a, b) => at(a) - at(b)).map((a) => `${a.id} (${a.slot})`);
  return `Kept ${list.length} running across the restart: ${names.join(', ')}.`;
}

export function adoptedPids(fromPid, sessions) {
  const pids = [fromPid, ...(Array.isArray(sessions) ? sessions.map((s) => s?.holderPid) : [])].filter(isPid);
  return [...new Set(pids)];
}

const realPs = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const realProcStat = (pid) => {
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
};

// The state letter in /proc/<pid>/stat: the first one after the last ')', since the command
// name in parentheses may hold one itself.
const procState = (text) => text.slice(text.lastIndexOf(')') + 1).trim()[0];

export function sessionAlive({ pid, id }, { kill = (p, sig) => process.kill(p, sig), ps = realPs, procStat = realProcStat } = {}) {
  try {
    kill(pid, 0);
  } catch (err) {
    if (err?.code !== 'EPERM') return false;
  }
  const r = ps('ps', ['-p', String(pid), '-o', 'command=']);
  if (r.error) {
    const stat = procStat(pid);
    return typeof stat === 'string' ? !['Z', 'X'].includes(procState(stat)) : true;
  }
  // The prompt is the story id and, after it, the mode or nothing.
  const command = ` ${String(r.stdout ?? '').trim()} `;
  return r.status === 0 && command.includes(` /foreman:story ${id} `);
}
