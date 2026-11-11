// The jobs the supervisor starts in the background and never waits on: the release watch, the slot environment's sweep
// and the learning tick. sweepAtStop is the exception: stop() awaits it, once, so the scratch
// orgs of closed stories are deleted before the run ends (60 s at most; it never throws).
//
// Learning: after each run record, with `learning.auto` on, it starts `foreman learning tick` in
// the background (detached), which may write a learned trait and tell the owner with an FYI. The
// loop never waits on it. One runs at a time: a record while one runs starts another once it
// ends (the tick also takes its own lock). Stopping waits for it within the same 10 s as the
// sessions, but never kills it; being detached, it can outlive this process. Each tick writes its
// output to `logs/learning-tick-<time>.log` (the last 5 kept, and the Node reports below too;
// tick-log.mjs). A Node that knows the flags gets `--report-on-fatalerror --report-exclude-env
// --report-exclude-network --report-directory` in NODE_OPTIONS, so a fatal error leaves a
// diagnostic report in that folder with the environment and the network interfaces left out; an
// older Node gets none, as it would not start. The tick takes the flags off again for its own
// children (tick-log.mjs untickEnv). A tick that exits
// non-zero logs one warn event that names its log and quotes the end of it, redacted
// (learning-ticks.mjs). Two such failures in a row set state.json's learningFailed { count, since,
// why, log }, an FYI on Waiting on you; a tick that works, a start and a stop clear it. A dry run and --once start none (`foreman
// cloud tick` runs it at the end of its job instead). It runs without the FOREMAN_RUN=1 `foreman
// run` gives this process, since the tick refuses to run in a story session and this is not one.
// `foreman learn` (proposals from repeated and minor findings), after each shipped story's run
// record (queued, one more at most while one runs, so a ship during a learn is not lost), on
// entering standby and when stopping, and `foreman notify` (every email) run in children of their own too, each within 60 s
// (owner-commands.mjs), so neither holds the loop: at most one learn runs at a time, the loop
// never waits on either, a stop runs its learn and its stopped or halted email side by side, and
// stopping or restarting on new code waits for those still running before it exits (detached,
// they would outlive it).

import { spawn } from 'node:child_process';
import { runEnvSweep } from './slot-prepare.mjs';
import { childNodeText, probeNode, spawnSh } from './node-path.mjs';
import { heldSpawnSync } from './loop-holds.mjs';
import { learningTicks, streakRecord } from './learning-ticks.mjs';
import { pruneTickLogs, reportSupported, tickEnv, tickLogTail } from './tick-log.mjs';
import { ownerEnv } from './run-guard.mjs';
import * as session from './session.mjs';

// `foreman release watch` checks the parked releases in a child of its own, which loads the
// env file itself. It runs while paused or halted too: a check changes nothing live.
export const PARK_CHECK_MS = 5 * 60_000;
// An env adapter with a sweep() tidies what closed stories left, such as their scratch orgs
// (slot-prepare.mjs runEnvSweep). It runs every minute, while paused or halted too, and is
// never counted as busy: it touches only stories that are in no slot.
export const ENV_SWEEP_MS = 60_000;
// The one sweep at a stop, which deletes the environments of closed stories (the supervisor's
// stop() awaits it): the most time its calls may take, before runEnvSweep's own backstop.
export const STOP_SWEEP_MS = 60_000;

// The supervisor passes `settings()` (the config in effect, replaced when the settings change); the objects
// returned here are the ones its tick reads.
export function backgroundJobs({ root: ROOT, dir: DIR, bin: FOREMAN_BIN, node: NODE, envAdapter, settings, dry: DRY, once: ONCE, state, saveRun, event, guarded, now }) {
  const parkWatch = { child: null, lastAt: 0 };

  function startParkWatch() {
    parkWatch.lastAt = Date.now();
    const child = spawn(NODE.node(), [FOREMAN_BIN, 'release', 'watch'], { cwd: ROOT, stdio: 'ignore', env: process.env });
    parkWatch.child = child;
    const done = () => {
      if (parkWatch.child === child) parkWatch.child = null;
    };
    child.on('exit', done);
    child.on('error', (err) => {
      done();
      event(`Could not check the releases ready to promote: ${err?.message ?? err}`, 'warn');
    });
  }

  const envSweep = { running: false, lastAt: 0 };

  function startEnvSweep() {
    envSweep.running = true;
    envSweep.lastAt = Date.now();
    runEnvSweep(envAdapter)
      .then(({ warnings }) => {
        for (const w of warnings) event(`Slot environment: ${w}`, 'warn');
      })
      .catch(() => {})
      .finally(() => {
        envSweep.running = false;
      });
  }

  // The sweep at a stop, awaited by the supervisor's stop(): the environments of stories that
  // closed are deleted, for up to STOP_SWEEP_MS. Never throws; its warnings are events.
  async function sweepAtStop() {
    if (DRY || typeof envAdapter?.sweep !== 'function') return;
    try {
      const { warnings } = await runEnvSweep(envAdapter, { limitMs: STOP_SWEEP_MS });
      for (const w of warnings) event(`Slot environment: ${w}`, 'warn');
    } catch {
      // a failed sweep never holds the stop
    }
  }

  let learningNode = NODE.node(); // the Node the last learning tick ran on
  let learningSince = null; // when the current run of failed learning ticks began
  const reportOk = new Map(); // node path -> whether that Node knows the diagnostic report flags
  // A report holds the environment unless --report-exclude-env is given, and a Node that does not
  // know that flag does not start with it in NODE_OPTIONS: so only a Node that does gets the flags.
  function reportFlags(node) {
    if (reportOk.has(node)) return reportOk.get(node);
    const version = probeNode(node, spawnSh(heldSpawnSync)).version; // one `node --version` per Node path
    const ok = reportSupported(version);
    if (version) reportOk.set(node, ok); // a Node that did not answer is asked again next time
    return ok;
  }
  const learning = learningTicks({
    newLog: () => {
      pruneTickLogs(DIR);
      return session.logPath({ stateDir: DIR, slot: 'learning-tick', now: now() });
    },
    spawnTick: (log) => {
      // Without FOREMAN_RUN, which `foreman run` gives this process: the tick refuses inside a story
      // session, and it is this process's own work, not a session's.
      const env = ownerEnv(process.env);
      learningNode = NODE.node();
      const withReport = tickEnv(env, DIR, { report: reportFlags(learningNode) });
      const args = [FOREMAN_BIN, 'learning', 'tick'];
      const child = log ? session.start({ cmd: learningNode, args, env: withReport, cwd: ROOT, logFile: log }) : spawn(learningNode, args, { cwd: ROOT, stdio: 'ignore', env: withReport, detached: true });
      child.unref();
      return child;
    },
    readLog: (log, pid) => tickLogTail(log, { pid, env: process.env }),
    // Two failed ticks in a row are an FYI on Waiting on you (state.json learningFailed); one stays an
    // event, and a tick that worked clears it.
    streak: guarded('the learning tick record', (n, last) => {
      const step = streakRecord(n, last, { since: learningSince, at: now().toISOString(), recorded: () => Boolean(state().learningFailed) });
      learningSince = step.since;
      if (step.save) saveRun(step.save);
    }),
    // A tick that failed because its Node could not start is a set-up problem: say so, and look at
    // this process's Node again at once, so the next tick and the restart use one that starts.
    explain: () => {
      const p = probeNode(learningNode, spawnSh(heldSpawnSync));
      if (p.ok) return null;
      const c = NODE.check({ force: true });
      if (c.event) event(c.event.text, c.event.kind);
      return childNodeText('The learning tick failed', p);
    },
    enabled: !DRY && !ONCE,
    // A closure: the settings are replaced when the settings change.
    auto: () => settings().learning?.auto,
    event,
  });
  return { parkWatch, startParkWatch, envSweep, startEnvSweep, sweepAtStop, learning };
}
