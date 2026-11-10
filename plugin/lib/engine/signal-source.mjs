// Who sent the signal that stopped the run. The supervisor takes SIGINT, SIGTERM and SIGHUP as
// Ctrl-C, a kill or a closed terminal, but when a story session's agent had just run a `kill`,
// `pkill` or `killall` the signal most likely came from it (the kill guard, kill-guard.mjs,
// refuses such a command, so this is the record of one that got through). The supervisor reads
// the agents' last Bash commands (state.mjs rawCommand, already redacted) when the signal
// arrives, before stop() clears them, and writes the finding to `last-interrupt` in the state
// folder; `foreman doctor` reads it (doctor-checks.mjs). The file stays on this machine: it is
// not in the branch store's KEEP list.
//
//   INTERRUPTED -> the plain reason: 'Interrupted (Ctrl-C, kill or a closed terminal).'
//   SIGNAL_WINDOW_MS -> how recent the command must be: 60 s
//   signalSource({ agents, now, windowMs }) -> { story, slot, command, at } for the agent
//       ({ slot, story, raw, lastAt }) with the latest lastAt in [now - windowMs, now + 5 s]
//       whose raw command runs kill, pkill or killall (or calls process.kill or os.kill); null
//       when none does. command is cut to 200.
//   interruptReason(source) -> "Interrupted by a signal from <story>'s session in <slot>, which
//       had just run `<command>`.", or INTERRUPTED for a null source
//   LAST_INTERRUPT -> 'last-interrupt'
//   writeInterrupt(dir, rec) -> one JSON line, { at } or { at, story, slot, command }
//   readInterrupt(dir) -> the record with its fields checked (at an ISO time; story, slot and
//       command text, cut to 80, 20 and 200), or null when the file is missing or unreadable

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const INTERRUPTED = 'Interrupted (Ctrl-C, kill or a closed terminal).';
export const SIGNAL_WINDOW_MS = 60_000;
export const LAST_INTERRUPT = 'last-interrupt';

const AHEAD_MS = 5000;
const SENDS_SIGNAL = /(?:^|[\s;&|(`'"/])(?:pkill|killall|kill)(?=\s|$)|\b(?:process|os)\.kill\s*\(/m;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export function signalSource({ agents, now, windowMs = SIGNAL_WINDOW_MS } = {}) {
  const at = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(at)) return null;
  let best = null;
  let bestAt = -Infinity;
  for (const a of Array.isArray(agents) ? agents : []) {
    const last = Date.parse(a?.lastAt);
    if (typeof a?.raw !== 'string' || !Number.isFinite(last) || last < at - windowMs || last > at + AHEAD_MS) continue;
    if (!SENDS_SIGNAL.test(a.raw) || last <= bestAt) continue;
    best = { story: a.story ?? null, slot: a.slot ?? null, command: a.raw.slice(0, 200), at: a.lastAt };
    bestAt = last;
  }
  return best;
}

export function interruptReason(source) {
  if (!source) return INTERRUPTED;
  return `Interrupted by a signal from ${source.story ?? 'a story'}'s session in ${source.slot ?? 'a slot'}, which had just run \`${source.command}\`.`;
}

export function writeInterrupt(dir, rec) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, LAST_INTERRUPT), `${JSON.stringify(rec)}\n`);
}

const TEXT = { story: 80, slot: 20, command: 200 };

export function readInterrupt(dir) {
  let value;
  try {
    value = JSON.parse(readFileSync(join(dir, LAST_INTERRUPT), 'utf8'));
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || typeof value.at !== 'string' || !ISO.test(value.at) || Number.isNaN(Date.parse(value.at))) return null;
  const rec = { at: value.at };
  for (const [key, cut] of Object.entries(TEXT)) if (typeof value[key] === 'string' && value[key] !== '') rec[key] = value[key].slice(0, cut);
  return rec;
}
