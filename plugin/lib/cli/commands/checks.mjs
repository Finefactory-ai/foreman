// `foreman checks [--changed | --all] [--reuse | --quick] [--start]` runs the project's checks (config `checks`) in the
// current folder, which in a slot is the slot's worktree, streaming each one's output. It prints
// `PASS <run>` or `FAIL <run>` per check and exits 1 when any failed.
//
//   foreman checks             the checks whose `when` is "always"
//   foreman checks --changed   those, plus each check whose `when` glob matches a file this
//                              branch changed against <remote>/<base>, an untracked file, or
//                              an uncommitted change
//   foreman checks --all       every configured check, whatever its `when`, also one that only a
//                              file of the base chose (a merge of the base into the branch);
//                              not with --changed
//   --reuse                    for each chosen check with a record of a real run on this exact
//                              tree, prints that record (when, for which story, how long, the
//                              last lines of output, PASS or FAIL) instead of running it, and
//                              counts its exit code; a check with no record runs. A record is
//                              matched on the check's command and the tree only, not on the
//                              folder it ran in, so run it from the repo root, as Foreman's
//                              agents do: from a subfolder it could print a run made at the root,
//                              and the other way round
//   --quick                    runs each chosen check's `quick` command where it has one (config
//                              `checks[].quick`: the project's faster run for a change in
//                              progress), else its `run`. A quick run is recorded as quick and is
//                              never reused, takes no claim and waits for nothing; so it cannot be
//                              combined with --reuse. A check with no `quick` runs as without the
//                              flag: a full run, recorded, claimed and reused as ever.
//   --recorded                 for each chosen check prints its record of this exact tree (the same
//                              block as a reuse, headed "recorded:") and runs nothing: a check with
//                              no record says so, and the exit code is 1 only for a recorded
//                              failure. It starts no run, takes no claim and writes no record, so
//                              it cannot be combined with --reuse, --quick, --start or --wait.
//                              Like --reuse it matches on the command and the tree, not the
//                              folder, so it assumes the repo root too.
//
// When the base cannot be diffed, every check runs: running too many is safer than too few.
//
// Every real run is recorded in <stateDir>/check-runs.jsonl (engine/check-runs.mjs) against the
// working tree's hash, taken before the run, with its exit code, time, redacted output tail and
// which environment it ran in; a reuse adds a line too. A run is not recorded when the tree could
// not be hashed or changed while the check ran. In a run the state folder is the anchor's
// (FOREMAN_STATE_DIR), shared by every slot, so slots on the same commit share a record. A record
// that cannot be written is a warning, never a change to the exit code.
//
// The run env. In a story session (FOREMAN_RUN=1) the checks run in the environment the
// supervisor gave the session, read from its file (engine/session-env.mjs), not in the calling
// shell's: whatever the caller set (PATH, NODE_OPTIONS, a key) is not visible to the check. The
// file holds the session env less the Claude sign-in keys (SESSION_KEYS), so a check never sees
// those either. Such a
// run is recorded with env 'session', and only those records are ever reused (findCheckRun), so
// `--reuse` no longer trusts whoever ran it, but it does not say who ran it either: it prints the
// newest session-env record of the tree. That is normally the tester's run, but any session-env
// run of that tree counts, so a reviewer must not take it as proof of who ran it. When the file cannot be used the checks run in the caller's env with a
// warning, are recorded with env 'caller' and are never reused; so does a slot name the supervisor
// never makes (anything but w1 to w<config.slots>), whatever file sits in the folder. Outside a session that is the
// plain case: caller env, no warning.
//
// One run per tree. Before a real run in the session env a check takes a claim on its command and
// tree (engine/check-claims.mjs, <stateDir>/check-claims/). When another process holds one, it
// says so and waits for that run's record, then prints it as a reuse (a `waited` line in the
// record file); when that run ends with no record, it takes the claim and runs the check itself.
// A claim is alive only while its process shows the holder's script and the start time the claim
// recorded (a reused pid has another start time; a claim with no script or no start time is
// dead). A dead claim is dropped and the check runs. A waiter gives up after CLAIM_WAIT_MS (30
// minutes, counted from its own start, never from the claim's date), says "stopped waiting" and
// runs the check itself without a claim, recorded as usual; the holder's claim stays. A claim that
// cannot be made is a warning and the check runs unclaimed. The commit step runs `--changed --reuse`: the tester's run
// of the unchanged tree is reused, and anything changed since runs again, so a story is never
// committed without a passing full-suite result for its exact tree.
//
// The Bash tool ends a call that runs too long, and a full suite can outlast it. So the same run
// can be started and collected in calls that each return in time:
//
//   foreman checks [--changed | --all] [--reuse | --quick] --start
//                          checks the flags and the config, starts the run detached
//                          (cli/check-job.mjs, in its own process group, its output in files, in
//                          the session env) and prints its id at once, exit 0
//   foreman checks --wait <id> [--for <seconds>]
//                          polls the run for up to <seconds> (default 90). Finished: prints the
//                          run's saved stdout and stderr, byte for byte what a foreground run
//                          prints, and exits with its exit code. Its process gone with no result:
//                          FAIL, exit 1. Time used up: "still running", exit 75 (EX_TEMPFAIL),
//                          non-zero so `--wait && git commit` can never go ahead early.
//
// One full run per worktree, and a cap across slots (engine/check-slots.mjs). Both apply only to a
// run inside a story session (FOREMAN_SLOT set); outside one nothing changes.
//
//   Superseding. Each such run registers itself in <stateDir>/check-running/. A run that finds an
//   older run of its own slot on a different tree stops it (the older result would be stale): it
//   writes the older job's result with `supersededBy` (this run's job id, or null for a foreground
//   run), ends the older process and everything under it, and says so. `--wait` on the stopped
//   job's id follows the newer job ("superseded: ... following ..."); with nothing to follow it
//   fails with "superseded". So at most one full suite runs per worktree. Runs on the same tree
//   never supersede each other: they share one run (the claims above). Quick runs supersede too.
//   A foreground run that is stopped this way says why before it ends: stopRun leaves a note for it
//   (check-slots.mjs takeStopNote), and its SIGTERM handler, or the loop when the check's own exit
//   was seen first, prints "superseded: stopped for a newer run in this worktree ..." on stdout,
//   frees its seat and its register entry, records nothing and exits 143 (the handler) or 1 (the
//   loop). A SIGTERM with no note (a timeout, the supervisor) exits 143 and prints nothing about a
//   newer run. A job run has no handler: its waiter reports the supersede.
//   Only a run that is positively the registered one is signalled or counted: a job run must show
//   its worker and job id in its command line, a foreground run the start time it registered with
//   (check-slots.mjs runAlive). A leftover file whose pid was reused is dropped, never signalled.
//   The cap. At most `checkRuns.maxParallel` full runs go at once across all slots (default one
//   per 8 cores, at least 1; config `checkRuns`, because `checks` is the list of commands). A full
//   run takes a seat after it has its claim, so a run that only waits for another's result takes
//   none. A run over the cap prints "waiting for a free check slot: N of M in use (w2 for ACME-2)",
//   shows as queued in the register, and beats its slot's heartbeat at once and every 30 s while it
//   waits, which the supervisor's watchdogs read as activity; `foreman status` and the dashboard
//   show "check queued". When time is up, `--wait` on a queued run says it is waiting for a free
//   check slot. Quick runs and runs outside a session never queue.
//
// The files of a run live in <stateDir>/check-jobs/ (engine/check-jobs.mjs). The supervisor ends
// the runs a session leaves behind. A run is recorded and reused exactly as a foreground one. The
// .out and .err files are owner-only, because they hold a check's raw output, which may include a key.

import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadResolved } from '../../settings/load.mjs';
import { CLAIM_WAIT_MS, claimAlive as realClaimAlive, dropStaleClaim, releaseClaim, takeClaim } from '../../engine/check-claims.mjs';
import { findCheckRun, outputTail, readCheckRuns, recordCheckRun, treeHash } from '../../engine/check-runs.mjs';
import { jobFiles, jobsDir, JOB_ID, newJobId, pruneJobs, readJob, readResult, removeJob, workerAlive, writeJob } from '../../engine/check-jobs.mjs';
import { checkSlotLimit, enterRun, killTree, leaveRun, liveRuns, olderInWorktree, processStart, queuedFor, releaseSeatsOf, releaseSlot, runAlive as realRunAlive, setRun, stopRun, takeSlot, takeStopNote } from '../../engine/check-slots.mjs';
import { matchesGlob } from '../../engine/glob.mjs';
import { stateDir } from '../../engine/paths.mjs';
import { readSessionEnv } from '../../engine/session-env.mjs';
import { slotIds } from '../../engine/worktree.mjs';
import { envSecrets, fileSecrets } from '../../setup/project.mjs';
import { duration } from './status.mjs';

const EXIT_USAGE = 64;
const EXIT_STILL_RUNNING = 75;
const USAGE = 'usage: foreman checks [--changed] [--reuse] [--start] [--all] [--quick]\n       foreman checks [--changed | --all] --recorded\n       foreman checks --wait <id> [--for <seconds>]\n';
const DEFAULT_WAIT_SECONDS = 90;
const POLL_MS = 1000;
const WORKER = fileURLToPath(new URL('../check-job.mjs', import.meta.url));
const KEEP_BYTES = 64 * 1024;
const BEAT_MS = 30_000;
const SUPERSEDED_LINE = "superseded: stopped for a newer run in this worktree on a changed tree; this run's result would be stale\n";
const NO_PS_WARNING = 'warning: cannot read processes here (ps is missing or failing), so the check slots cannot verify any run: older runs in this worktree are not stopped and the cap on parallel full runs does not hold\n';

const realOnTerm = (fn) => {
  process.on('SIGTERM', fn);
  return () => process.off('SIGTERM', fn);
};
// On macOS a pipe write is asynchronous, so the last line gets a chance to flush before the exit.
const realExit = (code) => {
  const done = () => process.exit(code);
  process.stdout.write('', done);
  setTimeout(done, 1000);
};

const realGit = (cwd) => (args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? 1, stdout: r.stdout ?? '' };
};

// Runs one check with `sh -c`, passing its output through as it comes. Resolves to the exit code
// and the last 64 KB of stdout and stderr together.
const realExec = (run, { cwd, env, stdout, stderr }) =>
  new Promise((resolve) => {
    let kept = Buffer.alloc(0);
    const keep = (chunk) => {
      kept = Buffer.concat([kept, chunk]);
      if (kept.length > KEEP_BYTES) kept = kept.subarray(kept.length - KEEP_BYTES);
    };
    const child = spawn('sh', ['-c', run], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => {
      keep(chunk);
      stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      keep(chunk);
      stderr.write(chunk);
    });
    child.on('error', (err) => {
      stderr.write(`${err.message}\n`);
      resolve({ code: 1, output: kept.toString('utf8') });
    });
    child.on('close', (code) => resolve({ code: code ?? 1, output: kept.toString('utf8') }));
  });

// What an exec answered: a bare exit code, or { code, output }.
const outcome = (r) => (typeof r === 'number' ? { code: r, output: '' } : { code: r?.code ?? 1, output: String(r?.output ?? '') });

// Prints a record of a real run: when, for which story, how long, its last lines and PASS or FAIL,
// worded as `word` ('reused' or 'recorded'). Answers whether the run passed.
function showRecord(stdout, check, tree, hit, word) {
  const forWhom = typeof hit.story === 'string' && hit.story ? ` for ${hit.story}` : '';
  const took = duration((Number(hit.ms) || 0) / 60000);
  stdout.write(`${word}: Foreman's run of this tree (${tree.slice(0, 12)}) at ${hit.at}${forWhom}, took ${took}; last lines:\n`);
  if (typeof hit.tail === 'string' && hit.tail) stdout.write(`${hit.tail}\n`);
  if (hit.exit === 0) {
    stdout.write(`PASS ${check.run} (${word})\n`);
    return true;
  }
  stdout.write(`FAIL ${check.run} (exit ${hit.exit}, ${word})\n`);
  return false;
}

const lines = (text) => String(text).split('\n').map((l) => l.trim()).filter(Boolean);

// The files this branch touches, or null when the base cannot be diffed.
function changedFiles(git, base) {
  const committed = git(['diff', '--name-only', `${base}...HEAD`]);
  if (committed.status !== 0) return null;
  const files = new Set(lines(committed.stdout));
  const untracked = git(['ls-files', '--others', '--exclude-standard']);
  if (untracked.status === 0) lines(untracked.stdout).forEach((f) => files.add(f));
  // Staged and unstaged changes alike; fails harmlessly before the first commit.
  const dirty = git(['diff', '--name-only', 'HEAD']);
  if (dirty.status === 0) lines(dirty.stdout).forEach((f) => files.add(f));
  return [...files];
}

// "12 s" under a minute, else "5 min" or "1 h 5 min".
const sinceText = (ms) => (ms < 60_000 ? `${Math.floor(ms / 1000)} s` : duration(ms / 60000));

const pauseFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The session env for this caller, or why not. Only the slots the supervisor makes (w1 to
// w<config.slots>) have an env file, so a file for any other slot name is never trusted: such a run
// is a caller-env run, which is never reused.
function sessionFor(callerEnv, config) {
  const known = readSessionEnv(callerEnv);
  if (known.env && !slotIds(config).includes(callerEnv.FOREMAN_SLOT)) {
    return { env: null, why: `${callerEnv.FOREMAN_SLOT} is not one of this project's slots` };
  }
  return known;
}

// A claim's text as one printable line.
const plain = (v) => String(v).replace(/[^\x20-\x7e]/g, '?').slice(0, 80);

// Starts the run detached and prints its id. The worker's output goes to files and its stdin is
// closed: with 'inherit' or a pipe the Bash tool would wait for the worker to close them.
function startRun({ values, root, config, here, runEnv, clock, stdout, stderr }) {
  const dir = stateDir(root, config, runEnv);
  const slot = runEnv.FOREMAN_SLOT || null;
  const forwarded = [...(values.changed ? ['--changed'] : []), ...(values.reuse ? ['--reuse'] : []), ...(values.all ? ['--all'] : []), ...(values.quick ? ['--quick'] : [])];
  let id;
  let outFd = null;
  let errFd = null;
  try {
    mkdirSync(jobsDir(dir), { recursive: true });
    pruneJobs(dir, { now: clock() });
    const made = newJobId({ slot, now: clock() });
    if (!JOB_ID.test(made)) {
      stderr.write(`could not start the checks: not a check run id: ${made}\n`);
      return 1;
    }
    id = made;
    const files = jobFiles(dir, id);
    outFd = openSync(files.out, 'w', 0o600);
    errFd = openSync(files.err, 'w', 0o600);
    // The worker starts in the session env (it reads the file itself), so the caller's variables do not reach it.
    const child = spawn(process.execPath, [WORKER, root, dir, id, ...forwarded], { cwd: here, env: sessionFor(runEnv, config).env ?? runEnv, detached: true, stdio: ['ignore', outFd, errFd] });
    let spawnError = null;
    child.on('error', (err) => {
      spawnError = err;
    });
    child.unref();
    if (!child.pid) {
      removeJob(dir, id);
      stderr.write(`could not start the checks: ${spawnError?.message ?? 'no process'}\n`);
      return 1;
    }
    writeJob(dir, { id, pid: child.pid, slot, story: runEnv.FOREMAN_STORY || null, cwd: here, args: forwarded, startedAt: clock().toISOString() });
  } catch (err) {
    if (id) removeJob(dir, id);
    stderr.write(`could not start the checks: ${err.message}\n`);
    return 1;
  } finally {
    for (const fd of [outFd, errFd]) if (fd !== null) closeSync(fd);
  }
  stdout.write(`started the checks as ${id}; collect the result with: foreman checks --wait ${id}\n`);
  return 0;
}

// Prints the saved output of a finished run and answers its exit code.
function finishRun({ dir, id, result, stdout, stderr }) {
  const files = jobFiles(dir, id);
  for (const [file, to] of [[files.out, stdout], [files.err, stderr]]) {
    try {
      const bytes = readFileSync(file);
      if (bytes.length) to.write(bytes);
    } catch {
      // no output saved
    }
  }
  return Number.isInteger(result.exit) ? result.exit : 1;
}

async function waitForRun({ id: first, seconds, root, config, runEnv, clock, alive, pause, stdout, stderr }) {
  const dir = stateDir(root, config, runEnv);
  let id = first;
  let job = readJob(dir, id);
  if (!job) {
    stderr.write(`no check run ${id} here\n`);
    return 1;
  }
  // The runs followed so far: a result that points back at one of them is a cycle.
  const seen = new Set([id]);
  const limitMs = seconds * 1000;
  const begun = clock().getTime();
  for (;;) {
    const result = readResult(dir, id);
    if (result) {
      if (!Object.hasOwn(result, 'supersededBy')) return finishRun({ dir, id, result, stdout, stderr });
      const next = result.supersededBy;
      if (typeof next !== 'string' || !JOB_ID.test(next) || seen.has(next)) {
        stderr.write(`FAIL ${id} was superseded by a newer run in its worktree on a changed tree; its result would be stale, so start the checks again\n`);
        return 1;
      }
      stdout.write(`superseded: ${id} was stopped for a newer run in its worktree (${next}); following ${next}\n`);
      seen.add(next);
      id = next;
      job = readJob(dir, id);
      continue;
    }
    // The newer run may not have written its job file yet: read it again, and check no process.
    if (!job) job = readJob(dir, id);
    if (job && !alive(job.pid, job)) {
      // The result may have landed as the process ended.
      if (readResult(dir, id)) continue;
      stderr.write(`FAIL the check run ${id} ended without a result: its process (pid ${job.pid}) is gone; start the checks again\n`);
      return 1;
    }
    const at = clock().getTime();
    if (at - begun >= limitMs) {
      const started = Date.parse(job?.startedAt);
      const so = Number.isFinite(started) ? Math.max(0, at - started) : 0;
      const queued = queuedFor(dir, id) ? ', waiting for a free check slot' : '';
      stdout.write(`still running: ${id}, ${sinceText(so)} so far${queued}; wait again with: foreman checks --wait ${id}\n`);
      return EXIT_STILL_RUNNING;
    }
    await pause(Math.min(POLL_MS, limitMs - (at - begun)));
  }
}

export default {
  name: 'checks',
  summary: 'run the project checks here (--all: every one, whatever its condition), reusing the record of an unchanged tree with --reuse, running the quick command of each with --quick, printing the record without running with --recorded, or start them and collect the result with --wait (checks [--changed | --all] [--reuse | --quick] [--start] | checks [--changed | --all] --recorded | checks --wait <id>)',

  async run(args, { root, cwd, env, stdout, stderr, git, exec, now, hashTree, alive, pause, claimAlive, job = null, cores, runAlive, stopTree, beat, startOf, onTerm, exit }) {
    let values;
    try {
      ({ values } = parseArgs({
        args,
        options: { all: { type: 'boolean' }, changed: { type: 'boolean' }, reuse: { type: 'boolean' }, start: { type: 'boolean' }, quick: { type: 'boolean' }, recorded: { type: 'boolean' }, wait: { type: 'string' }, for: { type: 'string' } },
      }));
    } catch (err) {
      stderr.write(`${err.message}\n${USAGE}`);
      return EXIT_USAGE;
    }
    const usage = (why) => {
      stderr.write(`${why}\n${USAGE}`);
      return EXIT_USAGE;
    };
    if (values.all && values.changed) return usage('--all cannot be combined with --changed');
    if (values.wait !== undefined) {
      if (values.start || values.changed || values.reuse || values.all || values.quick || values.recorded) {
        return usage('--wait cannot be combined with --start, --changed, --reuse, --all, --quick or --recorded');
      }
      if (!JOB_ID.test(values.wait)) return usage(`not a check run id: ${values.wait}`);
    }
    if (values.quick && values.reuse) return usage('--quick cannot be combined with --reuse: a quick run is never reused');
    if (values.recorded && (values.reuse || values.quick || values.start)) return usage('--recorded cannot be combined with --reuse, --quick, --start or --wait: it only prints a record');
    if (values.for !== undefined) {
      if (values.wait === undefined) return usage('--for needs --wait');
      if (!/^[1-9][0-9]*$/.test(values.for)) return usage('--for takes a whole number of seconds above 0');
    }
    const { config, errors } = loadResolved(root, { env: env ?? process.env });
    if (errors.length) {
      stderr.write(`${errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join('\n')}\n`);
      return 1;
    }
    const here = cwd ?? process.cwd();
    const clock = () => new Date(typeof now === 'function' ? now() : Date.now());
    if (values.wait !== undefined) {
      const seconds = values.for === undefined ? DEFAULT_WAIT_SECONDS : Number(values.for);
      return waitForRun({ id: values.wait, seconds, root, config, runEnv: env ?? process.env, clock, alive: alive ?? ((_pid, j) => workerAlive(j)), pause: pause ?? pauseFor, stdout, stderr });
    }
    if (values.start) return startRun({ values, root, config, here, runEnv: env ?? process.env, clock, stdout, stderr });
    const all = config.checks ?? [];
    if (all.length === 0) {
      stdout.write('No checks configured; nothing to run.\n');
      return 0;
    }

    let chosen = values.all ? all : all.filter((c) => c.when === 'always');
    if (values.changed) {
      const base = `${config.remote}/${config.baseBranch}`;
      const files = changedFiles(git ?? realGit(here), base);
      if (files === null) {
        stderr.write(`cannot diff against ${base}; running every check\n`);
        chosen = all;
      } else {
        chosen = all.filter((c) => c.when === 'always' || files.some((f) => matchesGlob(f, c.when)));
      }
    }
    if (chosen.length === 0) {
      stdout.write('No checks apply; nothing to run.\n');
      return 0;
    }

    const hash = typeof hashTree === 'function' ? hashTree : () => treeHash({ cwd: here });
    if (values.recorded) {
      // Read only: no session env, no claim, no exec and no line written.
      const tree = hash();
      if (!tree) {
        stderr.write('cannot hash this tree; not run\n');
        return 0;
      }
      const readDir = stateDir(root, config, env ?? process.env);
      let bad = 0;
      for (const check of chosen) {
        stdout.write(`$ ${check.run}\n`);
        const hit = findCheckRun(readCheckRuns(readDir), { run: check.run, tree });
        if (!hit) stdout.write(`no record of ${check.run} on this tree (${tree.slice(0, 12)}); not run\n`);
        else if (!showRecord(stdout, check, tree, hit, 'recorded')) bad++;
      }
      return bad > 0 ? 1 : 0;
    }

    const callerEnv = env ?? process.env;
    const known = sessionFor(callerEnv, config);
    if (known.why) stderr.write(`could not use this session's environment (${known.why}); running with this shell's, and this run will not be reused\n`);
    const runEnv = known.env ?? callerEnv;
    const envKind = known.env ? 'session' : 'caller';
    const runOne = exec ?? realExec;
    const dir = stateDir(root, config, runEnv);
    const who = { story: runEnv.FOREMAN_STORY || null, slot: runEnv.FOREMAN_SLOT || null };
    const holderAlive = claimAlive ?? ((claim) => realClaimAlive(claim));
    const sleep = pause ?? pauseFor;
    let secrets = null;
    const hidden = () => (secrets ??= [...fileSecrets({ root, config }), ...envSecrets(runEnv)]);
    const record = (entry) => {
      try {
        recordCheckRun(dir, entry);
      } catch (err) {
        stderr.write(`could not record the check run in ${dir}: ${err.message}\n`);
      }
    };

    let current = hash();
    let failed = 0;
    const alivePs = runAlive ?? realRunAlive;

    // A run in a story session registers itself, and stops the older runs of its worktree that are
    // on another tree. A register that cannot be made means no supersede and no cap.
    let me = null;
    if (who.slot) {
      const begun = clock().toISOString();
      const got = enterRun(dir, { pid: process.pid, script: process.argv[1] ?? '', job, slot: who.slot, story: who.story, tree: current, at: begun, state: 'started', since: begun, started: (startOf ?? processStart)(process.pid) });
      if (got.error !== undefined) stderr.write(`could not mark this run for the check slots: ${got.error}; running without them\n`);
      else {
        me = got.entry;
        if (me.started === null) stderr.write(NO_PS_WARNING);
        if (current) {
          for (const old of olderInWorktree(liveRuns(dir, { alive: alivePs }), me)) {
            stopRun(dir, old, { supersededBy: job, now: clock(), alive: alivePs, stopTree: stopTree ?? killTree });
            stdout.write(`superseded: stopped the older run ${old.job ?? `pid ${old.pid}`} in this worktree, on tree ${plain(String(old.tree).slice(0, 12))}; this tree (${current.slice(0, 12)}) has changed since\n`);
          }
        }
      }
    }

    const myStart = me ? me.started : (startOf ?? processStart)(process.pid);

    // Prints a record as a reuse, counts its exit and records the reuse.
    const reuse = (check, full, hit, extra = {}) => {
      if (!showRecord(stdout, check, current, hit, 'reused')) failed++;
      record({ at: clock().toISOString(), ...who, run: check.run, full, tree: current, reused: true, ...extra, from: hit.at });
    };

    // Takes the claim on this check and tree, or waits for the run that holds it. Answers
    // { hit } (the record of the run waited for), { claim } (this run holds it) or {} (run
    // without one).
    const claimOrWait = async (check) => {
      let since = null;
      let waitBegan = null;
      let stale = 0;
      const newer = () => {
        const hit = findCheckRun(readCheckRuns(dir), { run: check.run, tree: current });
        return hit && Date.parse(hit.at) >= Date.parse(since) ? hit : null;
      };
      for (;;) {
        if (since) {
          const hit = newer();
          if (hit) return { hit };
        }
        const got = takeClaim(dir, { run: check.run, tree: current, slot: who.slot, story: who.story, at: clock().toISOString(), started: myStart });
        if (got.ok) {
          if (since) {
            const hit = newer();
            if (hit) {
              releaseClaim(dir, got.claim);
              return { hit };
            }
          }
          return { claim: got.claim };
        }
        if (got.error !== undefined) {
          stderr.write(`could not mark this run as in progress: ${got.error}\n`);
          return {};
        }
        if (!got.holder || !holderAlive(got.holder)) {
          if (++stale > 3) return {};
          dropStaleClaim(dir, { run: check.run, tree: current }, got.holder);
          continue;
        }
        const holderWho = typeof got.holder.slot === 'string' && got.holder.slot ? plain(got.holder.slot) : 'another run';
        const holderStory = typeof got.holder.story === 'string' && got.holder.story ? ` for ${plain(got.holder.story)}` : '';
        if (!since) {
          since = Number.isFinite(Date.parse(got.holder.at)) ? got.holder.at : clock().toISOString();
          waitBegan = clock().getTime();
          stdout.write(`waiting: ${holderWho}${holderStory} is running this check on this tree (${current.slice(0, 12)}) since ${plain(since)}; its result is used when it ends\n`);
        } else if (clock().getTime() - waitBegan >= CLAIM_WAIT_MS) {
          // Counted from this waiter's own start, never from the claim's `at`, which is only text on disk.
          stdout.write(`stopped waiting: ${holderWho}${holderStory} has held this check on this tree (${current.slice(0, 12)}) for ${sinceText(clock().getTime() - waitBegan)}; running it here without a claim\n`);
          return {};
        }
        await sleep(POLL_MS);
      }
    };

    // Takes a seat among the machine's full runs, or waits for one. Answers the seat, or null when
    // the seats cannot be made (the run goes ahead without one).
    const takeSeat = async () => {
      const max = checkSlotLimit(config, cores ?? availableParallelism());
      let queuedAt = null;
      let lastBeat = null;
      const beatNow = async () => {
        lastBeat = clock().getTime();
        try {
          await (beat ?? (async (d, slot, at) => (await import('../../engine/state.mjs')).beat(d, slot, at)))(dir, who.slot, clock());
        } catch {
          // a missed beat only costs the watchdog a little patience
        }
      };
      for (;;) {
        const got = takeSlot(dir, { max, holder: { token: me.token, pid: process.pid, script: process.argv[1] ?? '', job: me.job, started: me.started, slot: who.slot, story: who.story, at: me.at }, alive: alivePs });
        if (got.ok) {
          if (queuedAt !== null) stdout.write(`got a free check slot after ${sinceText(clock().getTime() - queuedAt)}\n`);
          me = setRun(dir, me, queuedAt === null ? { state: 'running' } : { state: 'running', since: clock().toISOString() });
          return got.seat;
        }
        if (got.error !== undefined) {
          stderr.write(`could not take a check slot: ${got.error}; running without one\n`);
          return null;
        }
        if (queuedAt === null) {
          queuedAt = clock().getTime();
          me = setRun(dir, me, { state: 'queued', since: clock().toISOString() });
          const names = got.busy.map((h) => `${typeof h.slot === 'string' && h.slot ? plain(h.slot) : 'another run'}${typeof h.story === 'string' && h.story ? ` for ${plain(h.story)}` : ''}`);
          stdout.write(`waiting for a free check slot: ${got.busy.length} of ${max} in use (${names.join(', ')}); this run starts when it gets one\n`);
          await beatNow();
        } else if (clock().getTime() - lastBeat >= BEAT_MS) await beatNow();
        await sleep(POLL_MS);
      }
    };

    // A foreground run in a session ends on SIGTERM, which stopRun sends for a newer run: it says why
    // (when a stop note was left), frees its seat and its register entry, and exits 143.
    let ended = false;
    let unhook = null;
    if (me && job === null) {
      unhook = (onTerm ?? realOnTerm)(() => {
        try {
          if (ended) return;
          ended = true;
          if (takeStopNote(dir, me.token)) stdout.write(SUPERSEDED_LINE);
          releaseSeatsOf(dir, me.token);
          leaveRun(dir, me);
        } catch {
          // the exit below still happens
        }
        (exit ?? realExit)(143);
      });
    }

    try {
      for (const check of chosen) {
        const full = check.when === 'always';
        const isQuick = values.quick === true && typeof check.quick === 'string' && check.quick !== '';
        const cmd = isQuick ? check.quick : check.run;
        stdout.write(`$ ${cmd}\n`);
        if (values.reuse && current) {
          const hit = findCheckRun(readCheckRuns(dir), { run: check.run, tree: current });
          if (hit) {
            reuse(check, full, hit);
            continue;
          }
        }
        if (values.reuse && !current) stderr.write(`cannot hash this tree; running ${check.run}\n`);
        let claim = null;
        if (!isQuick && envKind === 'session' && current) {
          const got = await claimOrWait(check);
          if (got.hit) {
            reuse(check, full, got.hit, { waited: true });
            continue;
          }
          claim = got.claim ?? null;
        }
        let seat = null;
        try {
          if (me && !isQuick) seat = await takeSeat();
          const t0 = clock();
          const { code, output } = outcome(await runOne(cmd, { cwd: here, env: runEnv, stdout, stderr }));
          const t1 = clock();
          // The run was stopped for a newer one: its child's exit may be seen before the signal.
          if (me && job === null && (ended || takeStopNote(dir, me.token))) {
            if (!ended) {
              ended = true;
              stdout.write(SUPERSEDED_LINE);
            }
            failed++;
            break;
          }
          if (code === 0) stdout.write(`PASS ${cmd}${isQuick ? ' (quick)' : ''}\n`);
          else {
            failed++;
            stdout.write(`FAIL ${cmd} (exit ${code}${isQuick ? ', quick' : ''})\n`);
          }
          const after = hash();
          if (current && after === current) {
            let tail = '';
            try {
              tail = outputTail(output, { env: runEnv, secrets: hidden() });
            } catch {
              // a tail that cannot be cleaned is left out
            }
            record({ at: t1.toISOString(), ...who, run: check.run, ...(isQuick ? { quick: true, cmd } : {}), full, tree: current, exit: code, ms: Math.max(0, t1.getTime() - t0.getTime()), tail, env: envKind });
          }
          current = after;
          if (me && me.tree !== current) me = setRun(dir, me, { tree: current });
        } finally {
          if (seat) releaseSlot(dir, seat);
          if (me) me = setRun(dir, me, { state: 'started' });
          if (claim) releaseClaim(dir, claim);
        }
      }
    } finally {
      if (unhook) unhook();
      if (me) leaveRun(dir, me);
    }
    return failed > 0 ? 1 : 0;
  },
};
