// Fakes for the ship runner and its steps: a shell that records each call and answers from a
// script, in-memory locks, and a clock that `sleep` moves forward.

import { withDefaults } from '../plugin/lib/config/defaults.mjs';
import { sfCall } from './fake-sf.mjs';

// rules: [[match, answer], ...]. match is a string (the command line starts with it) or a
// RegExp. answer is a string (stdout, exit 0), a number (exit status), an object
// { status, stdout, stderr }, or a function (line, calls) returning one of those.
// The first rule that matches answers; with none, the command succeeds with no output.
// `sh.opts` holds the options each call got ({ env } and the like), in the order of `calls`.
// An sf call runSf makes through its watcher is read as the plain `sf ...` line (see sfCall),
// and `sh.limits` holds each call's time limit in ms (null for a call not through the watcher).
export function fakeSh(rules = []) {
  const calls = [];
  const opts = [];
  const limits = [];
  const sh = (rawCmd, rawArgs = [], options = {}) => {
    const { cmd, args, limitMs } = sfCall(rawCmd, rawArgs);
    const line = [cmd, ...args].join(' ');
    calls.push(line);
    opts.push(options);
    limits.push(limitMs ?? null);
    for (const [match, answer] of rules) {
      if (typeof match === 'string' ? line.startsWith(match) : match.test(line)) {
        const a = typeof answer === 'function' ? answer(line, calls) : answer;
        if (typeof a === 'string') return { status: 0, stdout: a, stderr: '' };
        if (typeof a === 'number') return { status: a, stdout: '', stderr: '' };
        return { status: 0, stdout: '', stderr: '', ...a };
      }
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  sh.calls = calls;
  sh.opts = opts;
  sh.limits = limits;
  return sh;
}

// initial: { key: holder } where a holder may carry `stale: true`.
export function fakeLocks(initial = {}) {
  const held = new Map(Object.entries(initial).map(([k, v]) => [k, { ...v }]));
  const log = [];
  const strip = (h) => {
    const rest = { ...h };
    delete rest.stale;
    return rest;
  };
  return {
    held,
    log,
    take(key, holder) {
      log.push(['take', key]);
      const h = held.get(key);
      if (h) return { ok: false, holder: strip(h), stale: !!h.stale };
      held.set(key, { ...holder });
      return { ok: true, holder };
    },
    release(key, pid) {
      log.push(['release', key]);
      const h = held.get(key);
      if (!h || h.pid !== pid) return false;
      held.delete(key);
      return true;
    },
    holderOf(key) {
      const h = held.get(key);
      return h ? { ...h, stale: !!h.stale } : null;
    },
    breakIfStale(key) {
      const h = held.get(key);
      if (!h?.stale) return null;
      held.delete(key);
      log.push(['break', key]);
      return strip(h);
    },
    setStage(key, pid, stage) {
      log.push(['stage', key, stage]);
      const h = held.get(key);
      if (!h || h.pid !== pid) return false;
      h.stage = stage;
      return true;
    },
  };
}

export const BASE_RULES = [
  ['git rev-parse --abbrev-ref HEAD', 'story/s-1\n'],
  ['git status --porcelain', ''],
  ['git rev-list --count', '2\n'],
];

export function fakeCtx({ config = {}, rules = [], locks = fakeLocks(), halted = false, ...rest } = {}) {
  let clock = Date.UTC(2026, 9, 15, 12, 0, 0);
  const ctx = {
    config: withDefaults({ version: 1, project: { name: 'T' }, ...config }),
    story: 'S-1',
    slot: 'w1',
    pid: 100,
    holderPid: 100,
    sh: fakeSh([...rules, ...BASE_RULES]),
    locks,
    sleeps: [],
    reports: [],
    halts: [],
    events: [],
    sleep: async (ms) => {
      ctx.sleeps.push(ms);
      clock += ms;
    },
    now: () => new Date(clock),
    report: (detail) => ctx.reports.push(detail),
    halt: (result) => {
      ctx.halts.push(result);
      ctx.halted = true;
    },
    halted,
    isHalted: () => ctx.halted,
    event: (text, kind) => ctx.events.push({ text, kind }),
    ...rest,
  };
  return ctx;
}
