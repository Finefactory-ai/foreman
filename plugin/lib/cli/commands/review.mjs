// `foreman review` hands one review to the engine a reviewer is set to run through
// (`roles.reviewers[i].engine`, engine/review-engine.mjs) and collects its verdict. The
// review-relay agent runs it; the Bash tool ends a call that runs too long, so the engine runs
// detached and is collected in calls that each return in time:
//
//   foreman review --start --reviewer <name> --prompt <file> --chars <n>
//                          checks the reviewer has an engine and its CLI answers, that the prompt
//                          file's length is within 2% of <n> (the relay copies the text; a short
//                          copy would review less than Foreman asked), copies the prompt into the
//                          state folder, starts the worker detached (cli/review-engine-job.mjs,
//                          in its own process group) and prints its id, exit 0
//                          While the engine is noted as out of quota (engine/review-engine.mjs
//                          readEngineDown), it answers unavailable at once, naming the reset time
//   foreman review --wait <id> [--for <seconds>]
//                          polls the relay for up to <seconds> (default 90). Finished with a
//                          verdict: prints it as JSON with `engine` and `model`, exit 0. Failed,
//                          or its process gone with no result: prints the unavailable JSON,
//                          exit 1. Time used up: "still running", exit 75 (EX_TEMPFAIL)
//
// Every refusal is the unavailable JSON on stdout, exit 1, so the relay agent can answer with
// it as it is and the pipeline runs the Claude reviewer instead:
//   { "engine": "unavailable", "reason": "...", "approved": false, "findings": [], "checked": "" }

import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig } from '../../config/load.mjs';
import { stateDir } from '../../engine/paths.mjs';
import { ENGINE_CLI, newRelayId, pruneRelays, readEngineDown, readRelay, readRelayResult, RELAY_ID, relayAlive, relayDir, relayFiles, removeRelay, writeRelay } from '../../engine/review-engine.mjs';
import { duration } from './status.mjs';

const EXIT_USAGE = 64;
const EXIT_STILL_RUNNING = 75;
const USAGE = 'usage: foreman review --start --reviewer <name> --prompt <file> --chars <n>\n       foreman review --wait <id> [--for <seconds>]\n';
const DEFAULT_WAIT_SECONDS = 90;
const POLL_MS = 1000;
const CHARS_TOLERANCE = 0.02;
const WORKER = fileURLToPath(new URL('../review-engine-job.mjs', import.meta.url));

const sinceText = (ms) => (ms < 60_000 ? `${Math.floor(ms / 1000)} s` : duration(ms / 60000));
const pauseFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const realSh = (cmd, args, env) => spawnSync(cmd, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function unavailable(stdout, reason) {
  stdout.write(`${JSON.stringify({ engine: 'unavailable', reason, approved: false, findings: [], checked: '' })}\n`);
  return 1;
}

function startRelay({ values, root, config, here, runEnv, clock, sh, stdout }) {
  const reviewer = (config.roles?.reviewers ?? []).find((r) => r?.name === values.reviewer);
  if (!reviewer) return unavailable(stdout, `the config has no reviewer named ${values.reviewer}`);
  if (!reviewer.engine) return unavailable(stdout, `the reviewer ${values.reviewer} has no engine set`);
  const engine = reviewer.engine;
  const cli = ENGINE_CLI[engine.name];
  if (!cli) return unavailable(stdout, `unknown review engine ${engine.name}`);
  let prompt;
  try {
    prompt = readFileSync(values.prompt, 'utf8');
  } catch (err) {
    return unavailable(stdout, `could not read the prompt file ${values.prompt}: ${err.message}`);
  }
  const expected = Number(values.chars);
  if (!Number.isInteger(expected) || expected <= 0) return unavailable(stdout, `--chars must be a whole number, not ${values.chars}`);
  if (Math.abs(prompt.length - expected) > expected * CHARS_TOLERANCE) {
    return unavailable(stdout, `the prompt copy is ${prompt.length} characters; the review text is ${expected}, so the copy is not byte for byte`);
  }
  const dir = stateDir(root, config, runEnv);
  const down = readEngineDown(dir, clock());
  if (down) return unavailable(stdout, `the ${engine.name} engine is out of quota until ${down.until}: ${down.reason}`);
  const probe = sh(cli, ['--version'], runEnv);
  if (probe.error || probe.status !== 0) return unavailable(stdout, `the ${engine.name} CLI did not answer: \`${cli} --version\` ${probe.error ? probe.error.message : `exited ${probe.status}`}`);

  const slot = runEnv.FOREMAN_SLOT || null;
  let id;
  let outFd = null;
  let errFd = null;
  try {
    mkdirSync(relayDir(dir), { recursive: true });
    pruneRelays(dir, { now: clock() });
    id = newRelayId({ slot, now: clock() });
    const files = relayFiles(dir, id);
    writeFileSync(files.prompt, prompt);
    outFd = openSync(files.out, 'w');
    errFd = openSync(files.err, 'w');
    writeRelay(dir, { id, pid: null, slot, story: runEnv.FOREMAN_STORY || null, reviewer: reviewer.name, engine, cwd: here, startedAt: clock().toISOString() });
    const child = spawn(process.execPath, [WORKER, dir, id], { cwd: here, env: runEnv, detached: true, stdio: ['ignore', outFd, errFd] });
    let spawnError = null;
    child.on('error', (err) => {
      spawnError = err;
    });
    child.unref();
    if (!child.pid) {
      removeRelay(dir, id);
      return unavailable(stdout, `could not start the review worker: ${spawnError?.message ?? 'no process'}`);
    }
    writeRelay(dir, { id, pid: child.pid, slot, story: runEnv.FOREMAN_STORY || null, reviewer: reviewer.name, engine, cwd: here, startedAt: clock().toISOString() });
  } catch (err) {
    if (id) removeRelay(dir, id);
    return unavailable(stdout, `could not start the review: ${err.message}`);
  } finally {
    for (const fd of [outFd, errFd]) if (fd !== null) closeSync(fd);
  }
  stdout.write(`started the review as ${id}; collect the result with: foreman review --wait ${id}\n`);
  return 0;
}

function finishRelay({ job, result, stdout }) {
  if (!result.ok) return unavailable(stdout, result.reason ?? 'the engine gave no verdict');
  const { approved, findings, checked } = result.verdict;
  stdout.write(`${JSON.stringify({ engine: job.engine.name, model: job.engine.model, seconds: result.seconds ?? null, usage: result.usage ?? null, approved, findings, checked })}\n`);
  return 0;
}

async function waitForRelay({ id, seconds, root, config, runEnv, clock, alive, pause, stdout }) {
  const dir = stateDir(root, config, runEnv);
  const job = readRelay(dir, id);
  if (!job) return unavailable(stdout, `no review relay named ${id}`);
  const limitMs = seconds * 1000;
  const begun = clock().getTime();
  for (;;) {
    const result = readRelayResult(dir, id);
    if (result) return finishRelay({ job, result, stdout });
    if (!alive(job)) return unavailable(stdout, `the review ${id} ended without a result: its process (pid ${job.pid}) is gone`);
    const at = clock().getTime();
    if (at - begun >= limitMs) {
      const started = Date.parse(job.startedAt);
      stdout.write(`still running: ${id}, ${sinceText(Number.isFinite(started) ? Math.max(0, at - started) : 0)} so far; wait again with: foreman review --wait ${id}\n`);
      return EXIT_STILL_RUNNING;
    }
    await pause(Math.min(POLL_MS, limitMs - (at - begun)));
  }
}

export default {
  name: 'review',
  summary: 'hand a review to the engine a reviewer is set to run through, then collect its verdict (review --start --reviewer <name> --prompt <file> --chars <n> | review --wait <id>)',
  async run(args, { root, cwd, env, stdout, stderr, now, pause, alive }) {
    let values;
    try {
      ({ values } = parseArgs({
        args,
        options: { start: { type: 'boolean' }, reviewer: { type: 'string' }, prompt: { type: 'string' }, chars: { type: 'string' }, wait: { type: 'string' }, for: { type: 'string' } },
        strict: true,
      }));
    } catch (err) {
      stderr.write(`${err.message}\n${USAGE}`);
      return EXIT_USAGE;
    }
    const usage = (why) => {
      stderr.write(`${why}\n${USAGE}`);
      return EXIT_USAGE;
    };
    if (values.wait !== undefined) {
      if (values.start || values.reviewer || values.prompt || values.chars) return usage('--wait cannot be combined with --start');
      if (!RELAY_ID.test(values.wait)) return usage(`not a review relay id: ${values.wait}`);
    } else if (values.start) {
      if (!values.reviewer || !values.prompt || !values.chars) return usage('--start needs --reviewer, --prompt and --chars');
      if (values.for !== undefined) return usage('--for needs --wait');
    } else {
      return usage('say --start or --wait');
    }
    const seconds = values.for === undefined ? DEFAULT_WAIT_SECONDS : Number(values.for);
    if (!Number.isInteger(seconds) || seconds < 0) return usage(`--for must be a whole number of seconds, not ${values.for}`);

    const runEnv = env ?? process.env;
    const { config, errors } = loadConfig(root);
    if (errors.length) return unavailable(stdout, `the config could not be loaded: ${errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join('; ')}`);
    const clock = () => new Date(typeof now === 'function' ? now() : Date.now());
    if (values.wait !== undefined) {
      return waitForRelay({ id: values.wait, seconds, root, config, runEnv, clock, alive: alive ?? ((j) => relayAlive(j)), pause: pause ?? pauseFor, stdout });
    }
    return startRelay({ values, root, config, here: cwd, runEnv, clock, sh: realSh, stdout });
  },
};
