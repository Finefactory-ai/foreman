// Claude Code hook (SubagentStart, SubagentStop, PreToolUse; see hooks/hooks.json).
// Records which agents are running and what each is doing, for the command centre: the tool call
// in short (`doing`), in plain words (`says`), a Bash call's redacted command (`raw`), and the
// model each runs on, read once from its transcript under CLAUDE_CONFIG_DIR or ~/.claude.
// Acts only inside a factory run (FOREMAN_RUN=1, set by the supervisor) and always exits 0.
// On a Bash or file-tool call it decides first and records state second, so a state write that fails
// cannot skip the decision; recording is best effort. It blocks (lib/engine/bash-guard.mjs
// decides) a Bash command from the tester or a reviewer that names a production host
// (roadmap 2.2), unless features.productionGuard is off (the config with the local settings
// layer on top); a Bash command from any agent, the foreman included, that writes the config,
// local settings or key files of the project the run builds (FOREMAN_PROJECT_DIR), or the check
// records in its state folder (check-runs.jsonl, which `foreman checks` writes; the files are
// lib/engine/anchor-files.mjs protectedFiles, with symlinks resolved, so a slot's linked
// .env.local counts), or runs a Foreman command that writes them (run-guard.mjs ownerFilesWrite)
// from that project or a worktree of it, whatever the command does to the FOREMAN_* variables;
// a Bash command from any agent that runs one of the project's configured checks by hand (its
// command, with or without variables, redirects or pipes; a targeted run of single tests is
// free), because only `foreman checks` records a run, and the denial itself is recorded, best
// effort and after the decision, as a `denied: true` line in the run's check-runs.jsonl
// (lib/engine/check-guard.mjs, check-runs.mjs); and whatever the active pack's guard denies, in
// any stage. It also blocks a Write, Edit,
// MultiEdit or NotebookEdit call, from any agent, whose file (resolved the same way) is one of
// those protected files. On Bash and those file tools it fails closed: a config that cannot be
// loaded denies, and so does any other failure after the event is parsed, including a module
// that will not load and a step that throws. A step can also hang, and a hung synchronous call
// would stop any timer in this process, so on those tools the work runs in a child process
// (this file with --decide) and this process only waits for its answer, for 8 s at most
// (FOREMAN_GUARD_TIMEOUT_MS can shorten it), inside hooks.json's 10 s. No decision in time
// means deny, and the child is killed. A decision already made holds even if the recording
// after it hangs: once the decision is in, the recording gets 0.5 s more, then the child is
// killed. If this process is stopped (SIGTERM, SIGINT or SIGHUP), it kills the child and
// answers before it exits: the decision already made, or deny. Other events and tools are only
// recorded, in this process. The --decide child ends itself when the hook that started it is
// gone (killed hard, or a lost worker), or after the guard limit plus 2 s, from a watchdog
// thread, because a hung step stops the child's own timers; the parent's own limit wins first.
//
// The scan guard (lib/engine/scan-guard.mjs) keeps a story session off the owner's disk: the
// folders it may search or read are the project (FOREMAN_PROJECT_DIR), its state folder (the
// slot worktrees are inside it), ~/.claude (or CLAUDE_CONFIG_DIR), the temp folder and the
// plugin, because a scan of the disk or the home folder makes macOS ask the owner for access
// to private folders when launchd started the run. For Bash it is one more step of the guard
// above (a `find`, `du`, `ls -R`, `grep -r`, `rg` or `mdfind` starting elsewhere is denied, for
// every agent), so it fails closed with it. A Read, Glob or Grep call outside those folders is
// denied in this process (a leading ~ in the path counts as the home folder), with no child: that guard fails OPEN, so a broken hook never stops
// every Read.
//
// The kill guard (lib/engine/kill-guard.mjs) is one more step of the Bash guard, for every
// agent: a `pkill`, `killall`, `xargs kill` or any kill that is not
// `kill [-TERM|-KILL|-9|-15|-s TERM|-s KILL] <numeric pid>` is denied, and an allowed kill goes
// through only for a process the session started (a descendant of the session's own
// `claude -p /foreman:story` process, or running in the slot's worktree or its folder under the
// temp folder). The Foreman supervisor (supervisor.pid, FOREMAN_SUPERVISOR_PID), its parents (the
// service) and the adopted voucher are never allowed, and nothing is listed unless a command has
// a kill with a pid; the --decide child asks `ps` for the processes then, and its own ancestors
// lead to the session.

if (process.env.FOREMAN_RUN !== '1') process.exit(0);

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const CONFIG_DENY = 'Foreman could not load foreman.config.json, so it denies Bash commands in this run until the config loads.';
const GUARD_FAILED = 'The Foreman Bash guard failed, so Foreman denies this command.';
const FILE_CONFIG_DENY = 'Foreman could not load foreman.config.json, so it denies file edits in this run until the config loads.';
const FILE_GUARD_FAILED = 'The Foreman file guard failed, so Foreman denies this edit.';
// The tools that write a file by path (tool_input.file_path, or notebook_path for a notebook).
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
// The tools that read by path: decided in this process by the scan guard, which fails open.
const SCAN_TOOLS = new Set(['Read', 'Glob', 'Grep']);

// 'bash', 'file' or null: which guard a hook event needs.
const guardOf = (hook) => {
  if (hook?.hook_event_name !== 'PreToolUse') return null;
  if (hook?.tool_name === 'Bash') return 'bash';
  return FILE_TOOLS.has(hook?.tool_name) ? 'file' : null;
};

const DECIDE = process.argv.includes('--decide');
const guardLimit = (v) => (typeof v === 'string' && /^[1-9]\d*$/.test(v) ? Math.min(8000, Number(v)) : 8000);
const LIMIT_MS = guardLimit(process.env.FOREMAN_GUARD_TIMEOUT_MS);
const RECORD_GRACE_MS = 500;
// The --decide child's own limit: the parent's plus 2 s, so the parent's answer stands.
const DECIDE_LIMIT_MS = LIMIT_MS + 2000;

// The watchdog thread of a --decide child: SIGKILLs the process when the hook that started it is
// gone (its ppid changed) or the limit is over. It runs off the main thread, which a hung step
// blocks.
const WATCHDOG = `
const { workerData } = require('node:worker_threads');
const started = Date.now();
setInterval(() => {
  if (process.ppid !== workerData.ppid || Date.now() - started >= workerData.limitMs) process.kill(workerData.pid, 'SIGKILL');
}, 100);
`;

// A watchdog that fails is ignored, at start (the catch) or later (the 'error' listener: with none,
// the event is an uncaught exception that kills this child and so denies an allowed command). The
// parent's own kill stays the fallback.
function startWatchdog() {
  try {
    new Worker(WATCHDOG, { eval: true, workerData: { pid: process.pid, ppid: process.ppid, limitMs: DECIDE_LIMIT_MS } })
      .on('error', () => {})
      .unref();
  } catch {
    // the parent still kills this child, as it always did
  }
}

const denyJson = (reason) =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

// The folders a story session may search or read (scan-guard.mjs scanRoots).
async function scanRootsFor(anchor, config) {
  const { sessionScanRoots } = await import('../engine/scan-guard.mjs');
  return sessionScanRoots({ anchor, config, env: process.env, homedir: os.homedir(), tmpdir: os.tmpdir(), pluginRoot: PLUGIN_ROOT });
}

// Best effort: when the check guard (and not an earlier one) denied this Bash command, adds a
// `denied: true` line to the run's check-runs.jsonl. Never changes the decision.
async function recordHandRun({ hook, config, anchor, reason, stateDir }) {
  try {
    const { handRun, handRunReason } = await import('../engine/check-guard.mjs');
    const hit = handRun({ command: hook.tool_input?.command, checks: config.checks, vars: process.env });
    if (!hit || reason !== handRunReason(hit.run) || !anchor) return;
    const { recordCheckRun } = await import('../engine/check-runs.mjs');
    recordCheckRun(stateDir(anchor, config), {
      at: new Date().toISOString(),
      story: process.env.FOREMAN_STORY || null,
      slot: process.env.FOREMAN_SLOT || null,
      run: hit.run,
      full: hit.full,
      denied: true,
    });
  } catch {
    // a record that cannot be written leaves the decision as it is
  }
}

// Decides a Bash or file-tool call (through onDecision, once; null allows) and records the event.
async function work(raw, onDecision) {
  let guard = null;
  let decided = false;
  const decide = (reason) => {
    decided = true;
    onDecision(reason);
  };
  try {
    const hook = JSON.parse(raw);
    guard = guardOf(hook);
    const { loadResolved } = await import('../settings/load.mjs');
    const { currentSlot, projectRoot, stateDir } = await import('../engine/paths.mjs');
    const { applyHookEvent, stageMap } = await import('../engine/state.mjs');
    const root = projectRoot({ cwd: typeof hook.cwd === 'string' ? hook.cwd : process.cwd() });
    let config = null;
    try {
      config = loadResolved(root).config;
    } catch {
      // the default roles will do
    }
    const stages = stageMap(config);
    if (guard) {
      let reason = null;
      let anchor = null;
      try {
        if (!config) {
          reason = guard === 'bash' ? CONFIG_DENY : FILE_CONFIG_DENY;
        } else {
          const { canonicalPath, isAnchorTarget, ownerFilesWrite } = await import('../engine/run-guard.mjs');
          const { anchorEditReason, protectedFiles } = await import('../engine/anchor-files.mjs');
          anchor = process.env.FOREMAN_PROJECT_DIR || root;
          const protect = protectedFiles({ anchor, stateDirPath: stateDir(anchor, config), config }).map(canonicalPath);
          const cwd = typeof hook.cwd === 'string' ? hook.cwd : process.cwd();
          if (guard === 'bash') {
            const { bashDecision } = await import('../engine/bash-guard.mjs');
            const foreman = { anchor, guarded: ownerFilesWrite, isAnchorDir: (dir) => isAnchorTarget(dir, anchor) };
            const roots = await scanRootsFor(anchor, config);
            const { killLook } = await import('../engine/kill-guard.mjs');
            const signals = killLook({ stateDir: stateDir(anchor, config), env: process.env });
            reason = bashDecision({ command: hook.tool_input?.command, agentType: hook.agent_type, config, stages, slot: currentSlot(), cwd, protect, vars: process.env, resolve: canonicalPath, foreman, roots, signals });
          } else {
            const input = hook.tool_input ?? {};
            const filePath = typeof input.file_path === 'string' ? input.file_path : input.notebook_path;
            reason = anchorEditReason({ filePath, cwd, protect, resolve: canonicalPath });
          }
        }
      } catch {
        reason = guard === 'bash' ? GUARD_FAILED : FILE_GUARD_FAILED;
      }
      decide(reason);
      if (reason && guard === 'bash' && config) await recordHandRun({ hook, config, anchor, reason, stateDir });
    } else if (SCAN_TOOLS.has(hook?.tool_name) && hook?.hook_event_name === 'PreToolUse') {
      // Fails open: a scan guard that breaks must not stop every Read.
      try {
        const { canonicalPath } = await import('../engine/run-guard.mjs');
        const { scanToolReason } = await import('../engine/scan-guard.mjs');
        const anchor = process.env.FOREMAN_PROJECT_DIR || root;
        const roots = await scanRootsFor(anchor, config);
        const cwd = typeof hook.cwd === 'string' ? hook.cwd : process.cwd();
        const home = process.env.HOME || os.homedir();
        const reason = scanToolReason({ tool: hook.tool_name, input: hook.tool_input, cwd, roots, home, resolve: canonicalPath });
        if (reason) decide(reason);
      } catch {
        // allowed
      }
    }
    try {
      applyHookEvent(stateDir(root, config), hook, new Date(), currentSlot(), root, stages);
    } catch {
      // a monitor that fails must not fail the build
    }
    // What the session has finished goes on the story itself; best effort, never a decision.
    if (hook?.hook_event_name === 'SubagentStop' && config && ['architect', 'test', 'review'].includes(stages[hook.agent_type])) {
      try {
        const { noteSessionProgress } = await import('../engine/story-notes.mjs');
        noteSessionProgress({ root: process.env.FOREMAN_PROJECT_DIR || root, config, env: process.env, slot: currentSlot() });
      } catch {
        // a note on the story is never worth failing the build
      }
    }
  } catch {
    // A monitor that fails must not fail the build, but a guarded call must not fail open from
    // any step: deny it unless a decision was already made. Input that is not JSON never gets
    // here as guarded, so the main block's answer for it stands.
    if (guard && !decided) decide(guard === 'bash' ? GUARD_FAILED : FILE_GUARD_FAILED);
  }
}

// Runs the guarded work in a child and answers for it: its reason, or deny (`failed`) if none
// comes in time.
function supervise(raw, failed) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--decide'], { stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '';
  let done = false;
  let graced = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    child.kill('SIGKILL');
    let reason = failed;
    try {
      const answer = JSON.parse(buf.split('\n')[0]);
      if (answer && typeof answer === 'object' && 'reason' in answer) {
        if (answer.reason === null) reason = null;
        else if (typeof answer.reason === 'string' && answer.reason) reason = answer.reason;
      }
    } catch {
      // no answer, or not one we can read: deny
    }
    if (reason) process.stdout.write(denyJson(reason));
    process.exit(0);
  };
  const deadline = Date.now() + LIMIT_MS;
  let timer = setTimeout(finish, LIMIT_MS);
  // A cancelled hook takes its child with it, and still answers before it exits.
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, finish);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    // The decision is in: give the recording after it a short grace, not the rest of the limit.
    if (!graced && buf.includes('\n')) {
      graced = true;
      clearTimeout(timer);
      timer = setTimeout(finish, Math.max(0, Math.min(RECORD_GRACE_MS, deadline - Date.now())));
    }
  });
  child.stdout.on('error', () => {});
  child.on('close', finish); // after exit and after its stdout has closed, so no answer is lost
  child.on('error', finish);
  child.stdin.on('error', () => {});
  child.stdin.end(raw);
}

if (DECIDE) startWatchdog();

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', async () => {
  if (DECIDE) {
    await work(raw, (reason) => process.stdout.write(JSON.stringify({ reason }) + '\n'));
    process.exit(0);
  }
  let guard = null;
  try {
    guard = guardOf(JSON.parse(raw));
  } catch {
    // not JSON: only recorded, which work() skips
  }
  if (!guard) {
    await work(raw, (reason) => {
      if (reason) process.stdout.write(denyJson(reason));
    });
    process.exit(0);
  }
  supervise(raw, guard === 'bash' ? GUARD_FAILED : FILE_GUARD_FAILED);
});
