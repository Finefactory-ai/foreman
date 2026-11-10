// What held this process's event loop: every synchronous child that took HOLD_MIN_MS or more,
// kept for the late-wake check (wake.mjs), so "The supervisor woke 8 min 0 s late" can name the
// command that held it instead of guessing between a held loop and a sleeping computer.
//
//   heldSpawnSync(cmd, args, opts, { run, clock, minMs })
//                              run(cmd, args, opts) (spawnSync by default), its result unchanged;
//                              a call that took minMs or more is recorded
//   recordSyncChildren({ clock, minMs }) -> undo()
//                              hooks node:child_process (spawnSync, execFileSync, execSync) so
//                              every synchronous child of this process is timed and recorded as
//                              heldSpawnSync records one, whichever module made the call (a named
//                              `import { spawnSync }` follows the patch, as syncBuiltinESMExports
//                              updates the module's bindings). A second install is a no-op. The
//                              supervisor installs it at once, so the late-wake text names any
//                              synchronous child it still has
//   heldList()                 a copy of the kept holds (for tests)
//   noteHold({ command, startedAt, endedAt })
//                              records a hold directly (wall-clock epoch ms)
//   holdDuring(from, to)       the longest kept hold whose window overlaps [from, to], as
//                              { command, ms }, or null
//   clearHolds()               forgets them all (for tests)
//   commandLabel(cmd, args)    how a hold names its command: the script of `sh -c <script>`,
//                              `foreman <subcommand>` (and a second lower-case word, as in `foreman
//                              config check`) for this plugin's bin run by node, this process's or
//                              any on the PATH, `node <script>` for another node script, else the
//                              command's base name and its leading words (`gh pr list`, `sf org
//                              login jwt`), which stop at the first flag, path, number or email.
//                              Redacted (the known secret names' values from this environment,
//                              then anything that looks like a key) and cut to 80 characters
//                              with "…", so it never carries a value, a path or an email.
//
// The record is process-wide and holds only the last HOLDS_KEPT, oldest dropped first. Times are
// wall-clock (Date.now()), as wake.mjs reads them.

import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';
import { redact as redactNamed } from '../secrets/redact.mjs';
import { redact as redactLooksSecret } from './state.mjs';

export const HOLD_MIN_MS = 1000;
export const HOLDS_KEPT = 20;
const LABEL_MAX = 80;

const holds = [];

// The functions as node shipped them, taken before any hook: heldSpawnSync calls the original so
// a call under the hook is recorded once, by the hook or by heldSpawnSync, never both.
const ORIGINAL = { spawnSync: childProcess.spawnSync, execFileSync: childProcess.execFileSync, execSync: childProcess.execSync };

// This process's Node, or any node on the PATH or Homebrew's link: the supervisor runs its
// children on the Node node-path.mjs chose, which need not be process.execPath.
const isNode = (cmd) => String(cmd) === process.execPath || ['node', 'node.exe'].includes(basename(String(cmd)));

// A word of a subcommand (`config check`, `pr list`), not a flag, a path, an id or a value.
const SUBCOMMAND = /^[a-z][a-z-]*$/;

export function commandLabel(cmd, args = []) {
  const list = Array.isArray(args) ? args.map(String) : [];
  const name = basename(String(cmd ?? ''));
  let text;
  if (name === 'sh' && list[0] === '-c' && list.length > 1) text = list[1];
  else if (isNode(cmd) && /(^|[\\/])bin[\\/]foreman$/.test(list[0] ?? '')) text = ['foreman', list[1], SUBCOMMAND.test(list[2] ?? '') ? list[2] : ''].filter(Boolean).join(' ');
  else if (isNode(cmd) && list[0] && !list[0].startsWith('-')) text = `node ${basename(list[0])}`;
  else {
    const words = [];
    for (const arg of list) {
      if (!SUBCOMMAND.test(arg)) break;
      words.push(arg);
    }
    text = [name, ...words].join(' ');
  }
  const clean = redactLooksSecret(redactNamed(text, { env: process.env })).replace(/\s+/g, ' ').trim();
  return clean.length > LABEL_MAX ? `${clean.slice(0, LABEL_MAX - 1)}…` : clean;
}

export function noteHold({ command, startedAt, endedAt }) {
  holds.push({ command: String(command), startedAt, endedAt });
  while (holds.length > HOLDS_KEPT) holds.shift();
}

export function heldSpawnSync(cmd, args = [], opts = {}, { run = ORIGINAL.spawnSync, clock = Date.now, minMs = HOLD_MIN_MS } = {}) {
  const startedAt = clock();
  try {
    return run(cmd, args, opts);
  } finally {
    const endedAt = clock();
    if (endedAt - startedAt >= minMs) noteHold({ command: commandLabel(cmd, args), startedAt, endedAt });
  }
}

export function holdDuring(from, to) {
  let best = null;
  for (const h of holds) {
    if (h.endedAt < from || h.startedAt > to) continue;
    const ms = h.endedAt - h.startedAt;
    if (!best || ms > best.ms) best = { command: h.command, ms };
  }
  return best;
}

export function clearHolds() {
  holds.length = 0;
}

export function heldList() {
  return holds.map((h) => ({ ...h }));
}

let undoHook = null;

export function recordSyncChildren({ clock = Date.now, minMs = HOLD_MIN_MS } = {}) {
  if (undoHook) return () => {};
  const timed = (original, label) =>
    function timedChild(...args) {
      const startedAt = clock();
      try {
        return original.apply(this, args);
      } finally {
        const endedAt = clock();
        if (endedAt - startedAt >= minMs) noteHold({ command: label(args), startedAt, endedAt });
      }
    };
  childProcess.spawnSync = timed(ORIGINAL.spawnSync, ([cmd, args]) => commandLabel(cmd, Array.isArray(args) ? args : []));
  childProcess.execFileSync = timed(ORIGINAL.execFileSync, ([cmd, args]) => commandLabel(cmd, Array.isArray(args) ? args : []));
  childProcess.execSync = timed(ORIGINAL.execSync, ([command]) => commandLabel('sh', ['-c', String(command)]));
  syncBuiltinESMExports();
  const undo = () => {
    if (undoHook !== undo) return;
    undoHook = null;
    childProcess.spawnSync = ORIGINAL.spawnSync;
    childProcess.execFileSync = ORIGINAL.execFileSync;
    childProcess.execSync = ORIGINAL.execSync;
    syncBuiltinESMExports();
  };
  undoHook = undo;
  return undo;
}
