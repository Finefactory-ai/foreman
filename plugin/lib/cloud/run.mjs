// `foreman cloud run`: the container runner's entrypoint. Settings come
// from the environment; runner/README.md lists them.
//
//   1. the runner checks (doctor.mjs runnerChecks); any failure stops here
//   2. `gh auth setup-git`, so git can clone and push with GH_TOKEN
//   3. clone FOREMAN_REPO (or FOREMAN_REPO_URL) at FOREMAN_BRANCH into <work>/repo, or fetch and
//      fast-forward the clone already there; then git's identity (git-setup.mjs)
//   4. the project checks (doctor.mjs projectChecks), with the project's config
//   5. the project's keys to its envFile and out of the environment (env-file.mjs placeKeys)
//   6. the supervisor, with the state folder at <work>/state; FOREMAN_WORKERS and FOREMAN_MAX
//      become --workers and --max. With no FOREMAN_MAX it also gets --exit-when-idle, so it
//      exits with NOTHING_LEFT rather than staying on standby, and step 7 pulls the clone
//   7. when the backlog runs out (NOTHING_LEFT), wait cloud.idleMinutes with the dashboard up,
//      pull, and go to 5. Any other ending ends the run: a stop request, the FOREMAN_MAX
//      stories, or a failure (its exit code).
//
// Signals: the first SIGTERM asks the run to finish the stories in progress (a STOP naming the
// cloud runner as who asked, console/stopper.mjs), the second, or SIGINT or SIGHUP, is passed to
// the supervisor, which stops now. While idle, any of them ends the run at once. A fresh start
// clears an old STOP, as `foreman run` does.
//
// deps: { sh, fs, proc, startSupervisor, startDashboard, wait(ms, { signal }), now }; `wait`
// ends early when its signal aborts.

import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadResolved } from '../settings/load.mjs';
import { readState } from '../engine/state.mjs';
import { NOTHING_LEFT } from '../engine/scheduler.mjs';
import { projectChecks, runChecks, runnerChecks, workDir } from './doctor.mjs';
import { setUpGit } from './git-setup.mjs';
import { placeKeys } from './env-file.mjs';
import { writeStopFile } from '../console/control.mjs';
import { stopperOf } from '../console/stopper.mjs';

const EXIT_USAGE = 64;
const SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'];
const why = (r) => String(r.stderr || r.stdout || '').trim().split('\n').pop().slice(0, 200);
const wholeNumber = (v) => /^\d+$/.test(String(v));

// Fetches and fast-forwards the clone; null when it worked, else the reason.
function update(sh, repo, branch) {
  const fetch = sh('git', ['fetch', '--quiet', 'origin', branch], { cwd: repo });
  if (fetch.status !== 0) return `cannot fetch origin ${branch}: ${why(fetch)}`;
  sh('git', ['checkout', '--quiet', branch], { cwd: repo });
  const ff = sh('git', ['merge', '--ff-only', '--quiet', `origin/${branch}`], { cwd: repo });
  return ff.status === 0 ? null : `cannot fast-forward ${branch} to origin/${branch}: ${why(ff)}`;
}

export async function cloudRun({ env, stdout, stderr, sh, fs, proc, startSupervisor, startDashboard, wait, now = () => new Date() }) {
  const ctx = { env, sh, fs };
  if (await runChecks(runnerChecks(), ctx, stdout)) {
    stderr.write('Not starting: fix the checks above.\n');
    return 1;
  }

  const work = workDir(env);
  const repo = join(work, 'repo');
  const branch = env.FOREMAN_BRANCH || 'main';
  const url = env.FOREMAN_REPO_URL || `https://github.com/${env.FOREMAN_REPO}.git`;
  const state = env.FOREMAN_STATE_DIR || join(work, 'state');

  sh('gh', ['auth', 'setup-git']);
  if (existsSync(join(repo, '.git'))) {
    const problem = update(sh, repo, branch);
    if (problem) {
      stderr.write(`foreman: ${problem}\n`);
      return 1;
    }
  } else {
    const r = sh('git', ['clone', '--quiet', '--branch', branch, url, repo]);
    if (r.status !== 0) {
      stderr.write(`foreman: cannot clone ${env.FOREMAN_REPO}: ${why(r)}\n`);
      return 1;
    }
  }
  for (const w of setUpGit({ root: repo, sh, auth: false }).warnings) stderr.write(`warning: ${w}\n`);

  const runEnv = { ...env, FOREMAN_STATE_DIR: state };
  const load = () => loadResolved(repo, { env: runEnv });
  let { config, errors } = load();
  if (!config) {
    stderr.write(`${errors.map((e) => (e.path ? `foreman.config.json ${e.path}: ${e.message}` : e.message)).join('\n')}\n`);
    return 1;
  }
  if (await runChecks(projectChecks(config, { ...ctx, root: repo }), { ...ctx, root: repo }, stdout)) {
    stderr.write('Not starting: fix the checks above.\n');
    return 1;
  }

  const args = [];
  if (env.FOREMAN_MAX !== undefined && env.FOREMAN_MAX !== '') {
    if (!wholeNumber(env.FOREMAN_MAX)) {
      stderr.write(`FOREMAN_MAX must be a whole number of stories, not ${env.FOREMAN_MAX}.\n`);
      return EXIT_USAGE;
    }
    args.push('--max', String(Number(env.FOREMAN_MAX)));
  }
  if (env.FOREMAN_WORKERS !== undefined && env.FOREMAN_WORKERS !== '') {
    const n = Number(env.FOREMAN_WORKERS);
    if (!wholeNumber(env.FOREMAN_WORKERS) || n < 1 || n > config.slots) {
      stderr.write(`FOREMAN_WORKERS must be 1 to ${config.slots} (slots in foreman.config.json), not ${env.FOREMAN_WORKERS}.\n`);
      return EXIT_USAGE;
    }
    args.push('--workers', String(n));
  }
  const once = Number(env.FOREMAN_MAX) > 0;
  if (!once) args.push('--exit-when-idle');

  mkdirSync(state, { recursive: true });
  rmSync(join(state, 'STOP'), { force: true });

  // Signals: see the header. `relay` is what the supervisor's launcher listens to.
  const relay = new EventEmitter();
  let phase = 'running';
  let stopping = false;
  let idle = new AbortController();
  const onSignal = (signal) => {
    if (phase === 'idle') {
      stopping = true;
      idle.abort();
      return;
    }
    if (signal === 'SIGTERM' && !stopping) {
      stopping = true;
      writeStopFile(state, stopperOf({ via: 'cloud', env, at: now() }));
      stdout.write('Stop asked for: finishing the stories in progress, then stopping. Send SIGTERM again to stop now.\n');
      return;
    }
    stopping = true;
    relay.emit(signal, signal);
  };
  for (const s of SIGNALS) proc.on(s, onSignal);

  try {
    for (;;) {
      const keys = placeKeys({ root: repo, config, env: runEnv, sh });
      for (const w of keys.warnings) stderr.write(`warning: ${w}\n`);
      phase = 'running';
      const code = await startSupervisor({ root: repo, env: keys.env, args, stderr, proc: relay });
      if (code !== 0 || stopping || once) return code;
      const reason = readState(state).loop?.reason;
      if (reason !== NOTHING_LEFT) return 0;

      const minutes = config.cloud?.idleMinutes ?? 10;
      stdout.write(`Nothing left to build; looking again in ${minutes} minutes.\n`);
      phase = 'idle';
      let dashboard = null;
      if ((config.console?.adapter ?? 'dashboard') === 'dashboard') {
        dashboard = await startDashboard({ root: repo, config, stateDir: state, env: runEnv, now, host: env.FOREMAN_DASHBOARD_HOST || undefined }).catch((err) => {
          stderr.write(`warning: the dashboard did not start while idle: ${err.message}\n`);
          return null;
        });
      }
      idle = new AbortController();
      await wait(minutes * 60_000, { signal: idle.signal });
      dashboard?.server.close();
      if (stopping) return 0;
      const problem = update(sh, repo, branch);
      if (problem) stderr.write(`warning: ${problem}; carrying on with the clone as it is\n`);
      const next = load();
      if (next.config) config = next.config;
      else stderr.write('warning: foreman.config.json no longer loads; carrying on with the config as it was\n');
    }
  } finally {
    for (const s of SIGNALS) proc.off(s, onSignal);
  }
}
