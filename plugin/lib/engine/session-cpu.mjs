// Whether a story session is busy on the CPU: the progress watchdog's third sign of activity,
// beside stage events and the session log (supervisor.mjs checkProgress). A long test run can
// write nothing to the log for many minutes and still be working; its CPU shows it.
//
//   parseCpuTime(text)          ms from a ps `time` column, or null: macOS "M:SS.ss" (minutes
//                               and seconds, minutes any width), Linux "HH:MM:SS" with an
//                               optional "D-" days prefix; the seconds may have a fraction
//   groupCpuMs(rootPid, { ps }) the CPU ms used by a session's processes: every process in the
//                               group rootPid leads (sessions start detached, so the session's
//                               pid is its group id), plus rootPid and every descendant through
//                               ppid (one that called setsid included); null when ps fails or
//                               nothing matches. `ps` returns the text of
//                               `ps -A -o pid=,ppid=,pgid=,time=`, or null
//   CPU_SAMPLE_MS               how often one slot is sampled: once a minute
//   CPU_BUSY_SHARE              the share of one core between two samples that counts as busy:
//                               10%, so an idle Claude process ticking at about 1% never counts,
//                               and a test run does
//   cpuWatch({ probe, sampleMs }) { activeAt(slot, pid, nowMs) }: the last time (ms) the
//                               session's CPU counted as busy, or null; sampleMs is how often one
//                               slot is sampled, CPU_SAMPLE_MS unless given
//   MIN_CPU_SAMPLE_MS           the shortest sample interval cpuSampleMs gives: 500 ms
//   cpuSampleMs(value)          the sample interval from FOREMAN_CPU_SAMPLE_MS's value, for tests
//                               only: CPU_SAMPLE_MS unless it is a positive integer, which can
//                               only shorten it, to MIN_CPU_SAMPLE_MS at the least
//
// activeAt samples a slot at most once per sampleMs. The first sample for a slot and pid
// only sets the baseline; a later one is busy when the CPU used since the last sample is at least
// CPU_BUSY_SHARE of the time since it, and then activeAt is that sample's time. A new pid for the
// slot starts it again. A probe that answers null leaves the slot as it was: CPU is optional and
// the other signs of activity still count.
//
// Nothing here imports state.mjs, which runs git at import time.

import { spawnSync } from 'node:child_process';

export const CPU_SAMPLE_MS = 60_000;
export const CPU_BUSY_SHARE = 0.1;
export const MIN_CPU_SAMPLE_MS = 500;

// The sample interval in ms from FOREMAN_CPU_SAMPLE_MS's value: CPU_SAMPLE_MS unless it is a
// positive integer, which is capped at CPU_SAMPLE_MS and raised to MIN_CPU_SAMPLE_MS.
export function cpuSampleMs(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return CPU_SAMPLE_MS;
  return Math.max(MIN_CPU_SAMPLE_MS, Math.min(CPU_SAMPLE_MS, Number(value)));
}

const CPU_TIME = /^(?:(\d+)-)?(\d+(?::\d+){1,2}(?:\.\d+)?)$/;

export function parseCpuTime(text) {
  const m = typeof text === 'string' ? text.trim().match(CPU_TIME) : null;
  if (!m) return null;
  const parts = m[2].split(':').map(Number);
  // Two parts are minutes:seconds, three are hours:minutes:seconds.
  const [h, min, s] = parts.length === 3 ? parts : [0, ...parts];
  if (m[1] !== undefined && parts.length !== 3) return null;
  const days = m[1] === undefined ? 0 : Number(m[1]);
  return Math.round((((days * 24 + h) * 60 + min) * 60 + s) * 1000);
}

function defaultPs() {
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,time='], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 ? r.stdout : null;
}

export function groupCpuMs(rootPid, { ps = defaultPs } = {}) {
  let text;
  try {
    text = ps();
  } catch {
    return null;
  }
  if (typeof text !== 'string') return null;
  const rows = [];
  for (const line of text.split('\n')) {
    const [pid, ppid, pgid, time] = line.trim().split(/\s+/);
    const ms = parseCpuTime(time);
    if (ms === null || !/^\d+$/.test(pid ?? '')) continue;
    rows.push({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), ms });
  }
  const mine = new Set([rootPid]);
  // Descendants through ppid, until no new one turns up.
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of rows) {
      if (!mine.has(r.pid) && (r.pgid === rootPid || mine.has(r.ppid))) {
        mine.add(r.pid);
        grew = true;
      }
    }
  }
  const matched = rows.filter((r) => mine.has(r.pid));
  return matched.length ? matched.reduce((sum, r) => sum + r.ms, 0) : null;
}

export function cpuWatch({ probe = groupCpuMs, sampleMs = CPU_SAMPLE_MS } = {}) {
  const slots = new Map(); // slot -> { pid, triedAt, at, cpu, activeAt }
  return {
    activeAt(slot, pid, nowMs) {
      let s = slots.get(slot);
      if (!s || s.pid !== pid) {
        s = { pid, triedAt: -Infinity, at: null, cpu: null, activeAt: null };
        slots.set(slot, s);
      }
      if (nowMs - s.triedAt < sampleMs) return s.activeAt;
      s.triedAt = nowMs;
      const cpu = probe(pid);
      if (!Number.isFinite(cpu)) return s.activeAt;
      if (s.at !== null && cpu - s.cpu >= CPU_BUSY_SHARE * (nowMs - s.at)) s.activeAt = nowMs;
      s.at = nowMs;
      s.cpu = cpu;
      return s.activeAt;
    },
  };
}
