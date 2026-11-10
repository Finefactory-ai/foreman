// Who stopped a run. `foreman stop`, the dashboard's Stop and the cloud runner's first SIGTERM
// each leave one JSON line in <stateDir>/STOP (and `foreman stop` in service-stopped too), so
// `foreman status`, the dashboard and the supervisor can say who asked, and the supervisor can
// tell the owner at once when it was not them. STOP and last-stop are synced to the state branch
// (state-store/branch.mjs KEEP), so the parent command line and the folder are cleaned and cut:
// redact() with the env's secret values (SECRET_NAMES, plus every env value of 8 characters or
// more whose name matches token|secret|key|pass|auth), then the value of each NAME=value,
// --flag value, --flag=value and -flag value pair whose name matches that word, what follows the
// ':' of -u, --user and --user= credentials, and the password of scheme://user:pass@, each
// becoming •••. The line is cut to 4096 characters before it is cleaned, and to its limit after.
//
//   stopperOf({ via, env, cwd, at, pid, ppid, agent, sh }) -> the record:
//       { at, via: 'cli'|'dashboard'|'cloud'|'unknown', pid, ppid, parent, cwd, run, story, slot,
//         agent? }
//       parent is `ps -p <ppid> -o command=` ('' when ps fails). run is FOREMAN_RUN=1, story and
//       slot FOREMAN_STORY and FOREMAN_SLOT, from env. For the dashboard there is no ps and no
//       pids: the request's user agent instead, cut to 120 characters.
//   readStopRecord(file) -> the record, null when there is no file. Fields of the wrong type are
//       dropped; an old ISO-only file reads as { at }, anything else as {}. Any process can write
//       STOP, so the text fields kept are cleaned and cut as stopperOf does: parent and cwd to
//       200 characters, agent to 120, story to 80 and slot to 20 (a null stays null).
//   LAST_STOP -> 'last-stop', the file in the state folder that keeps the record once the
//       supervisor has taken STOP, so a cloud run's stop stays named while it finishes and after
//   takeStop(dir) -> the record in <dir>/STOP, read as readStopRecord does, null when there is no
//       STOP; it writes that record to <dir>/last-stop and removes STOP
//   clearLastStop(dir) -> removes <dir>/last-stop, if there is one (the supervisor's fresh start)
//   stopperText(rec) -> "<who> at HH:MM UTC" (no time without `at`): "ACME-9's session", "a
//       Foreman run process", "the dashboard" (a browser), "a request to the dashboard (<agent>)",
//       "the cloud runner", "your terminal", or "an unknown process"
//   stopperDetail(rec) -> stopperText plus " (pid N, parent "<parent>", in <cwd>)", the parts there
//   unexpectedStop(rec) -> false only for the owner's terminal (cli, not from a run or a story), a
//       browser on the dashboard, and the cloud runner; true for anything else, an old record too

import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from '../secrets/redact.mjs';

const defaultSh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });

const VIA = ['cli', 'dashboard', 'cloud', 'unknown'];
const LONG = 200;
const AGENT = 120;
const STORY = 80;
const SLOT = 20;
const SCAN = 4096;
const SECRET_WORD = /token|secret|key|pass|auth/i;
const BLANK = '•••';

export const LAST_STOP = 'last-stop';

// A shell word: a "…" string, a '…' string, or a run up to a space or ; & | ).
const VALUE = String.raw`"[^"]*"|'[^']*'|[^\s;&|)]+`;
// NAME=value, the name not part of a longer word.
const NAME_PAIR = new RegExp(String.raw`(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)=(${VALUE})`, 'g');
// --flag=value, --flag value or -flag value, the value not starting with '-'.
const FLAG_PAIR = new RegExp(String.raw`(?<![^\s"'])(--?([A-Za-z][\w-]*))(=|\s+(?!-))(${VALUE})`, 'g');
// -u user:pass (attached too), --user user:pass and --user=user:pass.
const USER_PAIR = /(?<![^\s"'])(-u\s*|--user(?:=|\s+))(["']?)([^\s:"']*):([^\s"';&|)]+)/g;
// scheme://user:pass@
const URL_PAIR = /([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^\s:@/]*):([^\s@/]+)@/g;

function blankPairs(text) {
  return text
    .replace(NAME_PAIR, (m, name) => (SECRET_WORD.test(name) ? `${name}=${BLANK}` : m))
    .replace(FLAG_PAIR, (m, flag, name, sep) => (SECRET_WORD.test(name) ? `${flag}${sep}${BLANK}` : m))
    .replace(USER_PAIR, (m, flag, quote, user) => `${flag}${quote}${user}:${BLANK}`)
    .replace(URL_PAIR, (m, scheme, user) => `${scheme}${user}:${BLANK}@`);
}

// The env's values under a secret-looking name, 8 characters or more (so a '1' blanks nothing),
// longest first.
function secretValues(env) {
  return Object.entries(env ?? {})
    .filter(([name, value]) => SECRET_WORD.test(name) && typeof value === 'string' && value.length >= 8)
    .map(([, value]) => value)
    .sort((a, b) => b.length - a.length);
}

const clip = (text, env, max) => blankPairs(redact(String(text).slice(0, SCAN), { env, values: secretValues(env) })).slice(0, max);

function parentOf(ppid, sh, env) {
  try {
    const r = sh('ps', ['-p', String(ppid), '-o', 'command=']);
    if (r?.error || r?.status !== 0) return '';
    return clip(String(r.stdout ?? '').trim(), env, LONG);
  } catch {
    return '';
  }
}

export function stopperOf({ via, env = {}, cwd = null, at = new Date(), pid = process.pid, ppid = process.ppid, agent, sh = defaultSh } = {}) {
  const how = VIA.includes(via) ? via : 'unknown';
  const rec = { at: at.toISOString(), via: how };
  if (how !== 'dashboard') {
    rec.pid = pid;
    rec.ppid = ppid;
    rec.parent = parentOf(ppid, sh, env);
  }
  rec.cwd = cwd === null || cwd === undefined ? null : clip(cwd, env, LONG);
  rec.run = env?.FOREMAN_RUN === '1';
  rec.story = env?.FOREMAN_STORY ? String(env.FOREMAN_STORY).slice(0, STORY) : null;
  rec.slot = env?.FOREMAN_SLOT ? String(env.FOREMAN_SLOT).slice(0, SLOT) : null;
  if (how === 'dashboard' && typeof agent === 'string') rec.agent = clip(agent, env, AGENT);
  return rec;
}

const isPid = (v) => Number.isInteger(v) && v > 0;
const isText = (v) => typeof v === 'string';
const isTime = (v) => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(v) && !Number.isNaN(Date.parse(v));
const textOrNull = (v) => v === null || typeof v === 'string';

// Each field and the check its value must pass to be kept.
const FIELDS = {
  at: isTime,
  via: (v) => VIA.includes(v),
  pid: isPid,
  ppid: isPid,
  parent: isText,
  cwd: textOrNull,
  run: (v) => typeof v === 'boolean',
  story: textOrNull,
  slot: textOrNull,
  agent: isText,
};

// How each kept text field is cleaned and cut, as stopperOf does.
const CLEAN = {
  parent: (v) => clip(v, {}, LONG),
  cwd: (v) => clip(v, {}, LONG),
  agent: (v) => clip(v, {}, AGENT),
  story: (v) => v.slice(0, STORY),
  slot: (v) => v.slice(0, SLOT),
};

export function readStopRecord(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const rec = {};
    for (const [key, ok] of Object.entries(FIELDS)) if (Object.hasOwn(value, key) && ok(value[key])) rec[key] = CLEAN[key] && typeof value[key] === 'string' ? CLEAN[key](value[key]) : value[key];
    return rec;
  }
  return isTime(text) ? { at: text } : {};
}

export function takeStop(dir) {
  const rec = readStopRecord(join(dir, 'STOP'));
  if (rec === null) return null;
  writeFileSync(join(dir, LAST_STOP), `${JSON.stringify(rec)}\n`);
  rmSync(join(dir, 'STOP'), { force: true });
  return rec;
}

export function clearLastStop(dir) {
  rmSync(join(dir, LAST_STOP), { force: true });
}

function who(rec) {
  if (rec?.story) return `${rec.story}'s session`;
  if (rec?.run === true) return 'a Foreman run process';
  if (rec?.via === 'dashboard') return typeof rec.agent === 'string' && rec.agent.startsWith('Mozilla/') ? 'the dashboard' : `a request to the dashboard (${rec.agent || 'no user agent'})`;
  if (rec?.via === 'cloud') return 'the cloud runner';
  if (rec?.via === 'cli') return 'your terminal';
  return 'an unknown process';
}

export function stopperText(rec) {
  const at = typeof rec?.at === 'string' ? rec.at.slice(11, 16) : '';
  return at ? `${who(rec)} at ${at} UTC` : who(rec);
}

export function stopperDetail(rec) {
  const parts = [];
  if (isPid(rec?.pid)) parts.push(`pid ${rec.pid}`);
  if (typeof rec?.parent === 'string' && rec.parent) parts.push(`parent "${rec.parent}"`);
  if (typeof rec?.cwd === 'string' && rec.cwd) parts.push(`in ${rec.cwd}`);
  return parts.length ? `${stopperText(rec)} (${parts.join(', ')})` : stopperText(rec);
}

export function unexpectedStop(rec) {
  if (!rec || typeof rec !== 'object') return true;
  if (rec.via === 'cli' && rec.run !== true && !rec.story) return false;
  if (rec.via === 'dashboard' && typeof rec.agent === 'string' && rec.agent.startsWith('Mozilla/')) return false;
  if (rec.via === 'cloud') return false;
  return true;
}
