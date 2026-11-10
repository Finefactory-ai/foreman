// The detached worker of `foreman checks --start` (cli/commands/checks.mjs):
//
//   node check-job.mjs <root> <stateDirPath> <id> [--changed | --all] [--reuse | --quick]
//
// It runs the checks exactly as a foreground `foreman checks` does, in the folder it was started
// in, with its stdout and stderr files (<stateDir>/check-jobs/<id>.out and .err), then writes the
// exit code to <id>.result.json (engine/check-jobs.mjs) for `foreman checks --wait`. The runs are
// recorded in check-runs.jsonl inside checks.run, as in the foreground: the tree is hashed when
// the run starts and again after, and nothing is recorded if it changed. Because its output is
// two files, Node writes it synchronously and nothing is lost when it exits.
//
// The worker starts with the session's own environment (checks.mjs startRun gives it that, not
// the caller's) and runs `checks.run` exactly as a foreground run does: it reads the same env
// file, takes and waits on claims for the same checks, and records the same lines. It passes its
// job id to `checks.run`, so a newer run in the same worktree can name it in the result it writes
// for this one (engine/check-slots.mjs stopRun). The worker writes its own result only when none
// is there, so a run that was stopped for a newer one keeps its `supersededBy` result.

import { readResult, writeResult } from '../engine/check-jobs.mjs';
import checks from './commands/checks.mjs';

const [root, stateDirPath, id, ...args] = process.argv.slice(2);

let code;
try {
  code = await checks.run(args, { root, cwd: process.cwd(), env: process.env, job: id, stdout: process.stdout, stderr: process.stderr });
} catch (err) {
  process.stderr.write(`${err?.stack ?? err}\n`);
  code = 1;
}
if (!Number.isInteger(code)) code = 1;
if (!readResult(stateDirPath, id)) writeResult(stateDirPath, id, { exit: code, endedAt: new Date().toISOString() });
process.exitCode = code;
