// `foreman run [N] [--workers W] [--exit-when-idle] [--foreground] [--dry-run]`: starts the
// supervisor. N is how many new stories to start; with no N it runs until stopped: with nothing
// to build it stays on standby and starts new stories as they come; --exit-when-idle stops
// instead, with "Nothing left to build.". W is how many slots build at once, 1 to config.slots,
// for this run (default: the `workers` setting, which `foreman workers` and the settings can
// change while it runs). --dry-run prints what each slot would start and changes nothing; it
// may run alongside a live run.
//
// By default the supervisor starts in its own session (a detached child, so closing the terminal
// or the Claude session that ran this command does not stop it), with its output appended to
// <stateDir>/logs/supervisor.out. This command waits until the supervisor has written its pid
// (supervisor-pid.mjs), prints the pid, the dashboard and the log, and returns. A supervisor that
// ends before it writes its pid is reported with the end of its log: a clean exit (exit 0, such
// as nothing left to build) prints "The supervisor finished as it started:" and returns 0, any
// other early end prints "The supervisor stopped as it started:" and returns 1. One that has
// written no pid when the wait (5 s) runs out is still starting: the command prints no pid, only
// where to look, so every pid it prints is the supervisor's own. --foreground keeps it attached
// instead, passing Ctrl-C, kill and a closed terminal on to it, and returns its exit code. When the
// background service is installed (`foreman service install`, engine/service.mjs), a plain run
// asks the service manager to start it instead, and takes no story or worker count.
//
// --service is the service manager's program line only: the foreground, plus two rules. A
// running supervisor makes it exit 0 rather than 1 (so the service is not restarted against
// it), and so does the marker `foreman stop` leaves (service-stopped), which only a plain
// `foreman run` clears: a stopped service stays stopped across crashes and log-ins.
//
// A story session (FOREMAN_RUN=1, which run-guard.mjs keeps to
// scratch repos or plain temporary folders) always runs in the foreground, never detached and
// never through the service, so nothing it starts outlives it.
// Its supervisor is leashed (engine/leash.mjs): FOREMAN_LEASH_PID is the process that ran this
// command (the session's shell, `parentPid`), unless a valid leash is already set, so the
// supervisor ends once that shell ends, or after 5 minutes on standby. Outside a story session
// the environment passes through unchanged.
//
// A start also clears what an earlier run left that nothing will settle: a build-next request
// already handled and a supervisor-adopted.json whose voucher is gone, with one event
// (engine/stale-control.mjs). A dry run clears nothing.
//
// A second run while a supervisor runs is refused. `foreman stop` asks the run to finish the
// stories in progress and stop. A new run clears an old STOP. With the branch state store that
// removal is synced too (pull, remove, push), so another machine's STOP cannot stop this run,
// and a run never starts from a copy of the state it could not fetch.
//
// startSupervisor({ root, env, args, stderr, proc?, spawn?, execPath?, node? }) starts
// lib/engine/supervisor.mjs with `args` in the foreground and resolves with its exit code;
// `foreman cloud tick` and `cloud run` use it too. The signals `proc` (default: this process)
// are passed on to it. Each start, the first and every restart, runs on `execPath` (this
// process's own Node) when it answers `--version`, and otherwise on the first that answers from
// engine/node-path.mjs chooseNode (Homebrew's link, the PATH node), so a Homebrew upgrade of Node
// does not stop the restart; `node()` stands in for that choice in tests.
// A supervisor that exits with RESTART_EXIT (75, engine/code-version.mjs) saw its own code
// change and asks to be started again on the new code: it is, with the same arguments, folder
// and terminal, and FOREMAN_RESTART=1 so it carries the run on rather than starting a new one.
// startDetached({ root, env, args, dir, config, stdout, stderr, spawn?, sleep?, waitMs? }) starts
// it in the background as above and resolves with this command's exit code. The detached child
// is lib/cli/run-in-background.mjs, which runs startSupervisor, so a background run restarts on
// new code too; the pid it waits for is the supervisor's own. makeRunCommand's pollSleep and
// serviceWaitMs set how a run waits for the service's pid (100 ms polls, 5 s).

import { spawn, spawnSync } from 'node:child_process';
import fs, { closeSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESTART_EXIT } from '../../engine/code-version.mjs';
import { openProject } from './console-shared.mjs';
import { withState } from '../../state-store/with-state.mjs';
import { openService as realOpenService } from '../../engine/service.mjs';
import { chooseNode, probeNode, spawnSh } from '../../engine/node-path.mjs';
import { clearStopped, defaultAlive, isStopped, pidExists as realPidExists, readPid, runningSupervisor } from '../../engine/supervisor-pid.mjs';
import { clearStaleControl } from '../../engine/stale-control.mjs';
import { LEASH_ENV } from '../../engine/leash.mjs';

const SUPERVISOR = fileURLToPath(new URL('../../engine/supervisor.mjs', import.meta.url));
const IN_BACKGROUND = fileURLToPath(new URL('../run-in-background.mjs', import.meta.url));
const EXIT_USAGE = 64;
const USAGE = 'usage: foreman run [stories] [--workers 1-<slots>] [--exit-when-idle] [--foreground] [--dry-run]\n';
const POLL_MS = 100;
const WAIT_MS = 5000;
const TAIL_LINES = 20;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const logFile = (dir) => join(dir, 'logs', 'supervisor.out');

const realSh = (cmd, args = []) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? String(r.error.message) : '') };
};

// This computer's background service for the project, or null where there is none.
const defaultOpenService = ({ env, config, root, dir }) =>
  realOpenService({ platform: process.platform, home: os.homedir(), uid: process.getuid?.(), env, sh: realSh, fs, config, root, dir });

// { max, workers, dry, exitWhenIdle, foreground, service } or { error }.
function parse(args) {
  let max = 0;
  let workers = null;
  let dry = false;
  let exitWhenIdle = false;
  let foreground = false;
  let service = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') dry = true;
    else if (a === '--exit-when-idle') exitWhenIdle = true;
    else if (a === '--foreground') foreground = true;
    else if (a === '--service') service = true;
    else if (a === '--workers') {
      const v = args[++i];
      if (!/^\d+$/.test(v ?? '')) return { error: `--workers needs a whole number, not ${v ?? 'nothing'}.` };
      workers = Number(v);
    } else if (/^\d+$/.test(a)) max = Number(a);
    else return { error: `unknown argument: ${a}` };
  }
  return { max, workers, dry, exitWhenIdle, foreground: foreground || service, service };
}

export async function startSupervisor({
  root,
  env,
  args,
  stderr,
  proc = process,
  spawn: spawnChild = spawn,
  execPath = process.execPath,
  node = () => {
    const sh = spawnSh();
    return probeNode(execPath, sh).ok ? execPath : chooseNode({ execPath, env, fs, sh }).node;
  },
}) {
  const base = { ...env };
  delete base.FOREMAN_RESTART;
  for (let restart = false; ; restart = true) {
    const child = spawnChild(node(), [SUPERVISOR, ...args], {
      cwd: root,
      env: { ...base, FOREMAN_RUN: '1', FOREMAN_PROJECT_DIR: root, ...(restart ? { FOREMAN_RESTART: '1' } : {}) },
      stdio: 'inherit',
    });
    const code = await superviseChild(child, { stderr, proc });
    if (code !== RESTART_EXIT) return code;
  }
}

function dashboardUrl(config, env) {
  const host = env?.FOREMAN_DASHBOARD_HOST || config.console?.host || '127.0.0.1';
  return `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${config.console?.port ?? 4317}/`;
}

// What a run that is going prints: the pid, the dashboard when there is one, and the log.
function startedLines({ pid, by = '', config, env, dir }) {
  const lines = [`Foreman is running in the background (pid ${pid}${by}).`];
  if ((config.console?.adapter ?? 'dashboard') === 'dashboard') lines.push(`Dashboard: ${dashboardUrl(config, env)}`);
  lines.push(`Log: ${logFile(dir)}`, '`foreman status` shows progress; `foreman stop` stops it after the stories in progress.');
  return `${lines.join('\n')}\n`;
}

function logTail(dir) {
  try {
    const lines = readFileSync(logFile(dir), 'utf8').split('\n');
    while (lines.length && lines.at(-1) === '') lines.pop();
    return lines.slice(-TAIL_LINES).join('\n');
  } catch {
    return '(no log was written)';
  }
}

export async function startDetached({ root, env, args, dir, config, stdout, stderr, spawn: launch = spawn, sleep = pause, waitMs = WAIT_MS }) {
  mkdirSync(dirname(logFile(dir)), { recursive: true });
  const fd = openSync(logFile(dir), 'a');
  // A pid file a crash left behind names no supervisor of this run.
  const stale = readPid(dir);
  const started = () => {
    const pid = readPid(dir);
    return pid !== null && pid !== stale ? pid : null;
  };
  let child;
  try {
    child = launch(process.execPath, [IN_BACKGROUND, ...args], {
      cwd: root,
      env: { ...env, FOREMAN_RUN: '1', FOREMAN_PROJECT_DIR: root },
      detached: true,
      stdio: ['ignore', fd, fd],
    });
  } catch (err) {
    closeSync(fd);
    stderr.write(`could not start the supervisor: ${err.message}\n`);
    return 1;
  }
  let ended = null;
  child.on('exit', (code, signal) => {
    ended = { code, signal };
  });
  child.on('error', (err) => {
    ended = { error: err };
  });
  child.unref();
  closeSync(fd);
  for (let waited = 0; ; waited += POLL_MS) {
    if (started() !== null) break;
    if (ended || waited >= waitMs) break;
    await sleep(POLL_MS);
  }
  const pid = started();
  if (pid === null && ended) {
    if (ended.error) {
      stderr.write(`could not start the supervisor: ${ended.error.message}\n`);
      return 1;
    }
    // A clean exit this early is a run with nothing to do; its log says so.
    if (ended.code === 0) {
      stdout.write(`The supervisor finished as it started:\n${logTail(dir)}\n`);
      return 0;
    }
    stderr.write(`The supervisor stopped as it started:\n${logTail(dir)}\n`);
    return 1;
  }
  if (pid === null) {
    stdout.write(`Started the supervisor in the background; it has not written its pid yet. \`foreman status\` says when it runs, and ${logFile(dir)} says what it did.\n`);
    return 0;
  }
  stdout.write(startedLines({ pid, config, env, dir }));
  return 0;
}

// The pid of the supervisor the service manager started, once it has written it, or null.
async function serviceSupervisor(dir, { alive, sleep = pause, waitMs = WAIT_MS }) {
  for (let waited = 0; ; waited += POLL_MS) {
    const pid = runningSupervisor(dir, { alive });
    if (pid !== null || waited >= waitMs) return pid;
    await sleep(POLL_MS);
  }
}

// A story session's env with its leash (see the header): one already set when it is a pid above
// 1, else the process that ran `foreman run`.
function leashed(env, parentPid) {
  const given = String(env[LEASH_ENV] ?? '');
  return { ...env, [LEASH_ENV]: /^\d+$/.test(given) && Number(given) > 1 ? given : String(parentPid) };
}

const SERVICE_COUNT =
  'The service runs until stopped, on standby when there is nothing to build: for a story count or --exit-when-idle use `foreman run --foreground N` in your own terminal, and `foreman workers W` changes the workers while it runs.\n';

export function makeRunCommand({
  startSupervisor: start = startSupervisor,
  startDetached: detach = startDetached,
  openService = defaultOpenService,
  alive = defaultAlive,
  pidExists = realPidExists,
  pollSleep = pause,
  serviceWaitMs = WAIT_MS,
  parentPid = process.ppid,
} = {}) {
  return {
    name: 'run',
    summary:
      'start the supervisor in the background: build stories, several at once, on standby when there are none (run [N] [--workers W] [--exit-when-idle] [--foreground] [--dry-run])',
    async run(args, { root, env, stdout, stderr, sh, sleep }) {
      const opts = parse(args);
      if (opts.error) {
        stderr.write(`${opts.error}\n${USAGE}`);
        return EXIT_USAGE;
      }
      const project = openProject({ root, env, stderr });
      if (!project) return 1;
      const { config, dir } = project;
      if (opts.workers !== null && (opts.workers < 1 || opts.workers > config.slots)) {
        stderr.write(`The worker count must be 1 to ${config.slots} (slots in foreman.config.json), not ${opts.workers}.\n`);
        return EXIT_USAGE;
      }
      if (!opts.dry) {
        const running = runningSupervisor(dir, { alive });
        if (running !== null) {
          stderr.write(`Foreman is already running (pid ${running}). \`foreman status\` shows what it is doing; \`foreman stop\` stops it.\n`);
          return opts.service ? 0 : 1;
        }
      }
      if (opts.service && isStopped(dir)) {
        stdout.write('Stopped with `foreman stop`; the service waits for `foreman run`.\n');
        return 0;
      }
      // A story session's run must end with the session: never detached, never the service.
      if (env.FOREMAN_RUN === '1' && !opts.dry && !opts.foreground) {
        opts.foreground = true;
        stderr.write('A story session runs Foreman in the foreground, so it stops when the session ends.\n');
      }
      const svc = opts.dry || opts.foreground ? null : openService({ env, config, root, dir });
      const viaService = Boolean(svc?.installed());
      if (viaService && (opts.max > 0 || opts.workers !== null || opts.exitWhenIdle)) {
        stderr.write(SERVICE_COUNT);
        return EXIT_USAGE;
      }
      // A dry run leaves the state folder alone, including a STOP meant for a live run.
      if (!opts.dry) {
        const cleared = await withState({ root, env, stderr, sh, sleep }, { write: true, message: 'foreman run' }, () => {
          mkdirSync(join(dir, 'logs'), { recursive: true });
          rmSync(join(dir, 'STOP'), { force: true });
          if (!opts.service) clearStopped(dir);
          clearStaleControl(dir, { alive: pidExists });
          return 0;
        });
        if (cleared !== 0) return cleared;
      }
      const argv = ['--max', String(opts.max), ...(opts.workers === null ? [] : ['--workers', String(opts.workers)])];
      if (opts.exitWhenIdle) argv.push('--exit-when-idle');
      if (opts.dry) argv.push('--dry-run');
      if (opts.dry || opts.foreground) return start({ root, env: env.FOREMAN_RUN === '1' && !opts.dry ? leashed(env, parentPid) : env, args: argv, stderr });
      if (viaService) {
        const started = svc.start();
        if (!started.ok) {
          stderr.write(`The service ${svc.label} did not start: ${started.error}\n`);
          return 1;
        }
        const pid = await serviceSupervisor(dir, { alive, sleep: pollSleep, waitMs: serviceWaitMs });
        if (pid === null) {
          stdout.write(`Asked the service ${svc.label} to start; it has not written its pid yet. \`foreman service status\` says when it runs, and ${logFile(dir)} says what it did.\n`);
          return 0;
        }
        stdout.write(startedLines({ pid, by: `, the service ${svc.label}`, config, env, dir }));
        return 0;
      }
      return detach({ root, env, args: argv, dir, config, stdout, stderr });
    },
  };
}

export default makeRunCommand();

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

// Passes Ctrl-C, kill and a closed terminal on to the supervisor, which stops its sessions
// before it exits, and resolves with its exit code once it has.
export function superviseChild(child, { proc = process, stderr }) {
  const forward = (signal) => {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  };
  for (const s of SIGNALS) proc.on(s, forward);
  const done = () => {
    for (const s of SIGNALS) proc.off(s, forward);
  };
  return new Promise((resolve) => {
    child.on('error', (err) => {
      done();
      stderr.write(`could not start the supervisor: ${err.message}\n`);
      resolve(1);
    });
    child.on('exit', (code, signal) => {
      done();
      resolve(code ?? (signal ? 130 : 1));
    });
  });
}
