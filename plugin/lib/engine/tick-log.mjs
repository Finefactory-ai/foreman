// What a background learning tick leaves behind, so a failed one can say why. Pure apart from the
// fs calls. Each tick's output goes to `<stateDir>/logs/learning-tick-<time>.log` (session.mjs
// logPath), and the Node it runs on writes a diagnostic report to the same folder if it dies of a
// fatal error.
//
//   KEEP                          5: the logs (and the reports) kept, the one being made included
//   reportSupported(version)      whether a Node of that version ("v22.13.0") knows the report flags
//                                 used below (--report-exclude-env came in 22.13 and 23.3); false
//                                 for null or a version that does not read
//   tickEnv(env, dir, { report }) a copy of env for the tick, with NODE_OPTIONS ending in
//                                 `--report-on-fatalerror --report-exclude-env
//                                 --report-exclude-network --report-directory="<dir>/logs"`. A
//                                 diagnostic report holds every environment variable unless
//                                 --report-exclude-env is there, and the network interfaces (IP and
//                                 MAC addresses) unless --report-exclude-network is there. A report
//                                 still holds the host name and the cwd; it stays local, in
//                                 <stateDir>/logs, which the state branch ignores. The flags are set
//                                 only with report true (the default), and never when dir has a
//                                 double quote in it. An unknown flag in NODE_OPTIONS stops Node
//                                 from starting, which is why `report` is false for a Node that does
//                                 not support them (reportSupported)
//   untickEnv(env)                a copy of env with the exact suffix tickEnv appended taken off
//                                 NODE_OPTIONS again, for the tick's own children (the learner's
//                                 `claude`, which may run on an older Node). Nothing left gives
//                                 NODE_OPTIONS undefined (present, so it overrides process.env); any
//                                 other value, or none, is left as it is. Children the tick starts
//                                 without its env (git, through the state store) still inherit the
//                                 flags, and git does not read NODE_OPTIONS
//   pruneTickLogs(dir, keep)      removes the oldest learning-tick logs and report files in
//                                 <dir>/logs, leaving the newest keep - 1, so that the log about to
//                                 be made brings them to keep. Never touches any other file; never
//                                 throws
//   tickLogTail(log, { pid, env }) { quote, report } for a tick's log, or null when it cannot be
//                                 read. quote is the last 3 meaningful lines (the text before a
//                                 native stack trace, without stack frames, carets or the Node
//                                 version line) joined with " / ", redacted and cut to 300
//                                 characters ('' when nothing is left); report is the path of the
//                                 Node report of that pid in the log's folder, or null

import { closeSync, fstatSync, openSync, readdirSync, readSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { redact as redactSecrets } from '../secrets/redact.mjs';
import { redact } from './state.mjs';

export const KEEP = 5;

const TAIL_BYTES = 64 * 1024;
const QUOTE_LINES = 3;
const QUOTE_MAX = 300;
const TICK_LOG = /^learning-tick-.*\.log$/;
const REPORT = /^report\.\d{8}\.\d{6}\.\d+\.\d+\.\d+\.json$/;
const NATIVE_TRACE = '----- Native stack trace -----';

export function reportSupported(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? ''));
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major >= 24 || (major === 23 && minor >= 3) || (major === 22 && minor >= 13);
}

const FLAGS = '--report-on-fatalerror --report-exclude-env --report-exclude-network';
const TICKED = new RegExp(`(?:^|\\s+)${FLAGS} --report-directory="[^"]*"$`);

export function tickEnv(env, dir, { report = true } = {}) {
  if (!report || String(dir).includes('"')) return { ...env };
  const flags = `${FLAGS} --report-directory="${join(dir, 'logs')}"`;
  const existing = typeof env?.NODE_OPTIONS === 'string' ? env.NODE_OPTIONS.trim() : '';
  return { ...env, NODE_OPTIONS: existing ? `${existing} ${flags}` : flags };
}

export function untickEnv(env) {
  const out = { ...env };
  if (typeof out.NODE_OPTIONS === 'string' && TICKED.test(out.NODE_OPTIONS)) {
    out.NODE_OPTIONS = out.NODE_OPTIONS.replace(TICKED, '').trim() || undefined;
  }
  return out;
}

function removeOld(folder, names, keep) {
  const dated = [];
  for (const name of names) {
    try {
      dated.push({ name, at: statSync(join(folder, name)).mtimeMs });
    } catch {
      // gone, or cannot be read: leave it
    }
  }
  dated.sort((a, b) => b.at - a.at || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  for (const { name } of dated.slice(Math.max(0, keep - 1))) {
    try {
      rmSync(join(folder, name), { force: true });
    } catch {
      // left for the next tick
    }
  }
}

export function pruneTickLogs(dir, keep = KEEP) {
  try {
    const folder = join(dir, 'logs');
    const names = readdirSync(folder);
    removeOld(folder, names.filter((n) => TICK_LOG.test(n)), keep);
    removeOld(folder, names.filter((n) => REPORT.test(n)), keep);
  } catch {
    // no logs folder yet
  }
}

function readEnd(file) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got);
      if (n === 0) break;
      got += n;
    }
    return buf.subarray(0, got).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function reportOf(log, pid) {
  if (!Number.isInteger(pid)) return null;
  try {
    const folder = dirname(log);
    const mine = new RegExp(`^report\\.\\d{8}\\.\\d{6}\\.${pid}\\.\\d+\\.\\d+\\.json$`);
    const found = readdirSync(folder).filter((n) => mine.test(n)).sort();
    return found.length ? join(folder, found[found.length - 1]) : null;
  } catch {
    return null;
  }
}

export function tickLogTail(log, { pid, env = {} } = {}) {
  let text;
  try {
    text = readEnd(log);
  } catch {
    return null;
  }
  let lines = text.split('\n');
  const trace = lines.findIndex((l) => l.trim() === NATIVE_TRACE);
  if (trace >= 0) lines = lines.slice(0, trace);
  const kept = lines.map((l) => l.trim()).filter((l) => l !== '' && !/^at\s/.test(l) && !/^\^+$/.test(l) && !/^Node\.js v\d/.test(l));
  let quote = redact(redactSecrets(kept.slice(-QUOTE_LINES).join(' / '), { env }));
  if (quote.length > QUOTE_MAX) quote = `…${quote.slice(-(QUOTE_MAX - 1))}`;
  return { quote, report: reportOf(log, pid) };
}
