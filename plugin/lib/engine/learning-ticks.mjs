// The supervisor's background learning ticks (`foreman learning tick`), one at a time. Pure apart
// from what is passed in.
//
//   learningTicks({ spawnTick, enabled, auto, event, explain?, newLog?, readLog?, streak? })
//                                                                  { start(), running() }
//
//   spawnTick(log) starts a tick and returns the child, which emits 'exit' (code, signal) and
//                 'error'; log is newLog()'s path, or null
//   enabled       false for a dry run and for --once, which start none
//   auto()        learning.auto as it is now, read on every start(): false starts nothing, and
//                 turning learning off during a tick also drops the one pending
//   event(text, kind)
//                 writes to the supervisor's event log
//   explain()     optional; called first when a tick exits non-zero or is killed. A string it
//                 returns is the warn event instead of the generic one (the supervisor says the
//                 Node could not start, a set-up problem); null keeps the generic text.
//   newLog()      optional; the path the tick writes its output to, called before each spawnTick. A
//                 throw, or no newLog, gives spawnTick null
//   readLog(log, pid)
//                 optional; what a failed tick left: { quote, report } (quote the end of its log,
//                 report the path of Node's diagnostic report or null; tick-log.mjs tickLogTail),
//                 or null when the log cannot be read. pid is the child's, from when it started. A
//                 throw counts as null
//   streak(n, last)
//                 optional; called after every 'exit' of the current child, never on 'error': n is
//                 how many ticks in a row have failed (0 after one that exited 0, with last null;
//                 else last is { text, log }, the warn text just logged and the tick's log). A
//                 throw is ignored
//   streakRecord(n, last, { since, at, recorded })  { since, save }, what a streak handler does with
//                 streak's n and last: since is the ISO time the current run of failures began (or
//                 null), at is now as ISO, recorded() says whether state.json holds a learningFailed
//                 (called only for n 0). n 1 gives { since: at, save: null }; n 2 or more gives the
//                 run's start (since, else at) and save { learningFailed: { count: n, since, why:
//                 last.text, log: last.log } }; n 0 gives since null and save { learningFailed: null }
//                 when recorded() is true, else null. A caller saves `save` when it is not null
//
//   start     starts a tick, or, while one runs, notes that one more is wanted: however many
//             records arrive during a tick, only one more follows it. A spawnTick that throws is
//             one warn event, "Could not start learning: <msg>".
//   running   whether a tick is running (the stop waits for it, but never kills it)
//
// A tick that exits non-zero (or is killed) logs one warn event, and the pending tick still
// follows. The text is explain()'s string if it gave one. Else, with <what> "exit <code>" ("killed
// by <signal>" when there is no code): with no log, "The learning tick failed (<what>); run
// `foreman learning tick` to see why."; else readLog's answer, "The learning tick failed (<what>);
// its log <log> ends: "<quote>"." (or "... failed (<what>) with no output; its log is <log>." for an
// empty quote, "...; its log <log> could not be read." for null), and " Node's diagnostic report:
// <report>." added when there is one. A child that cannot start ('error') logs "Could not start
// learning: <msg>" and drops the pending tick; its exit, if one comes, changes nothing.

function failureText({ code, signal, log, pid, explain, readLog }) {
  try {
    const why = explain();
    if (typeof why === 'string') return why;
  } catch {
    // the generic text stands
  }
  const base = `The learning tick failed (${code === null ? `killed by ${signal}` : `exit ${code}`})`;
  if (!log) return `${base}; run \`foreman learning tick\` to see why.`;
  let read = null;
  try {
    read = readLog(log, pid) ?? null;
  } catch {
    // counts as a log that cannot be read
  }
  let text;
  if (!read) text = `${base}; its log ${log} could not be read.`;
  else if (!read.quote) text = `${base} with no output; its log is ${log}.`;
  else text = `${base}; its log ${log} ends: "${read.quote}".`;
  return read?.report ? `${text} Node's diagnostic report: ${read.report}.` : text;
}

export function streakRecord(n, last, { since, at, recorded }) {
  if (n >= 2) {
    const from = since ?? at;
    return { since: from, save: { learningFailed: { count: n, since: from, why: last?.text ?? null, log: last?.log ?? null } } };
  }
  if (n === 1) return { since: at, save: null };
  return { since: null, save: recorded() ? { learningFailed: null } : null };
}

export function learningTicks({ spawnTick, enabled, auto, event, explain = () => null, newLog = () => null, readLog = () => null, streak = () => {} }) {
  let child = null;
  let pending = false;
  let failed = 0;

  function start() {
    if (!enabled || auto() === false) return;
    if (child) {
      pending = true;
      return;
    }
    let log = null;
    try {
      log = newLog() ?? null;
    } catch {
      // no log: the tick runs without one
    }
    let started;
    try {
      started = spawnTick(log);
    } catch (err) {
      event(`Could not start learning: ${err?.message ?? err}`, 'warn');
      return;
    }
    child = started;
    started.on('exit', (code, signal) => {
      if (child !== started) return;
      child = null;
      let text = null;
      if (code !== 0) {
        text = failureText({ code, signal, log, pid: started.pid, explain, readLog });
        event(text, 'warn');
      }
      failed = code === 0 ? 0 : failed + 1;
      try {
        streak(failed, failed ? { text, log } : null);
      } catch {
        // the record of the streak is not the tick's business
      }
      if (pending) {
        pending = false;
        start();
      }
    });
    started.on('error', (err) => {
      if (child === started) child = null;
      pending = false;
      event(`Could not start learning: ${err?.message ?? err}`, 'warn');
    });
  }

  return { start, running: () => child !== null };
}
