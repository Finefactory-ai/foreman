// Whether a story session's Bash command would stop a process it does not own. A session that
// runs a `pkill -f` on the factory's own command line matches the real service, the supervisor
// reads the signal as Ctrl-C and every story stops (the work is lost and paid for twice).
// bash-guard.mjs denies the command and the hook (lib/hooks/agent-events.mjs) supplies the
// process list. Pure apart from the `sh`, `proc` and `readlink` it is given.
//
//   KILL_HELP -> the sentence every denial ends with: stop only a process the session started,
//       by the PID it recorded (`cmd > log 2>&1 & echo $!`, then `kill <pid>`), and `ps -p <pid>` to
//       see whether it still runs
//   allowedKill(args) -> the PIDs of the one allowed shape of `kill` (args are the words after
//       `kill`): an optional `-TERM`, `-KILL`, `-9`, `-15`, `-s TERM` or `-s KILL`, then one or
//       more plain numbers; else null. Every other kill is refused: `kill $!`, `kill %1`,
//       `kill -0`, `kill -s 0 -TERM 5`, `kill --`, a group, a name, a substitution.
//   killReason({ command, cwd, vars, signals }) -> null, or why Foreman denies it. Every text the
//       command runs is read step by step (see the rules R1 to R5 above killReason): the scripts
//       of sh/bash/zsh -c, here-strings, $( ) and backticks (also inside double quotes), and a
//       heredoc body unless it is one of the three data forms (D1, D2, D3, in heredocs.mjs).
//       The words of a `foreman` command and the message of `git commit|tag|merge` (`-m`, `-am`,
//       `--message`) are data and are not read as scripts. With `signals` ({ verdict(pid) -> null |
//       reason }) each pid of an allowed kill is asked about; without it a pid is allowed.
//       Scope: the guard reads the Bash command text only. It does not read a script file the
//       command runs or a language's own kill call (`node -e process.kill`), and it does not
//       undo deliberate string-building. The traits and doctor's 'last interrupt' cover those.
//   protectedPids({ stateDir, env, table }) -> Map pid -> label of the processes no session may
//       signal: supervisor.pid, FOREMAN_SUPERVISOR_PID, the voucher in supervisor-adopted.json,
//       and every ancestor of a supervisor in `table` (its service wrapper, the run command, the
//       terminal). The dashboard is served inside the supervisor process, so it is covered. The
//       pid is not checked for life: a stale one only refuses more.
//   sessionRoot({ table, self, story }) -> the nearest process at or above `self` that is a story
//       session (live-sessions.mjs storySessionOf) for `story` (any when empty), or null
//   pidVerdict({ pid, table, self, story, protect, places, cwdOf }) -> null, or why the session
//       may not signal pid (no command line is ever printed: argv can hold secrets). Only the
//       session's own processes are allowed. In order: protected; no process list; no session
//       root; the session itself or a process its commands run in; unknown to the list (not
//       running, or not one this session started); a descendant of the session; running in one
//       of `places`; else refused. A process started with `cmd &` loses
//       its parent when the shell of that Bash call ends, so a folder inside the slot's worktree
//       or its temp folder also counts as the session's own.
//   processSnapshot({ sh, proc }) -> Map pid -> { ppid, command } from one `ps`, else from /proc
//       (the runner image has no ps), else null
//   killLook({ stateDir, env, self, tmpdir, sh, platform, proc, readlink }) -> { verdict(pid) }
//       the full reason or null. Lazy: the process list and the protected pids are read once, on
//       the first verdict, and a process's folder (/proc/<pid>/cwd, else lsof) only for a pid
//       that gets that far. The places are the slot's worktree and <tmpdir>/<slot>, only for a
//       valid FOREMAN_SLOT (w<n>): with none, the whole temp folder is never allowed.

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandSteps } from './anchor-files.mjs';
import { stripTimeout } from './check-guard.mjs';
import { gitMessageWords, heredocParts, rawText } from './heredocs.mjs';
import { storySessionOf } from './live-sessions.mjs';
import { canonicalPath } from './run-guard.mjs';
import { lsofFolders } from './strays.mjs';
import { readAdopted, readPid } from './supervisor-pid.mjs';
import { worktreeOf } from './worktree.mjs';

export const KILL_HELP =
  "Stop only a process this session started, by the PID you recorded when you started it: start it with `<command> > <log> 2>&1 & echo $!` (or Bash's background option), then run `kill <that pid>`. Never stop processes by name or pattern. To see whether a process is still running, use `ps -p <pid>`.";

const PREFIX = 'Foreman denies this command: ';
const base = (word) => path.basename(String(word ?? ''));
const NAME_VALUE = /^[A-Za-z_][A-Za-z0-9_]*=/;

// Shell reserved words that can stand in front of a command (`if a; then kill 1; fi`,
// `for p in x; do kill $p; done`, `{ kill 1; }`, `! kill 1`): commandSteps splits on `;` but
// leaves them as the first word of the step.
const RESERVED = new Set(['if', 'then', 'elif', 'else', 'do', 'while', 'until', '{', '!']);

// Removes a leading reserved word, builtin, nice (with -n N or -N), timeout and the wrappers
// commandSteps knows (which can follow a builtin), as often as they come.
function bare(words) {
  let w = words.map(String);
  for (let guard = 0; guard < 24 && w.length; guard++) {
    const name = base(w[0]);
    if (RESERVED.has(w[0])) w = w.slice(1);
    else if (name === 'builtin') w = w.slice(1);
    else if (['command', 'exec', 'nohup', 'time', 'sudo', 'env'].includes(name)) {
      w = w.slice(1);
      while (w.length && (w[0].startsWith('-') || NAME_VALUE.test(w[0])) && w[0] !== '-') w = w.slice(1);
    } else if (name === 'nice') w = w.slice(/^-n$/.test(w[1] ?? '') ? 3 : /^-\d+$/.test(w[1] ?? '') ? 2 : 1);
    else if (name === 'timeout') {
      const next = stripTimeout(w);
      if (next.length === w.length) break;
      w = next;
    } else break;
  }
  return w;
}

// The one shape of `kill` that Foreman allows. `args` are the words after `kill`: an optional
// signal (`-TERM`, `-KILL`, `-9`, `-15`, or the two words `-s TERM` or `-s KILL`), then one or
// more PIDs, each a plain number. Returns the PIDs, else null. Nothing else is read: no `--`,
// `-n`, `--signal`, `-sTERM`, `-SIGTERM`, `-0`, `-l`, no second signal word, no `0`, no negative
// number, and no `$!`, `%job` or `$VAR`, because none of them is a number the guard can check.
const SIGNAL_ONE = new Set(['-TERM', '-KILL', '-9', '-15']);
const SIGNAL_NAME = new Set(['TERM', 'KILL']);
const PID_WORD = /^[1-9]\d{0,9}$/;

export function allowedKill(args) {
  const a = Array.isArray(args) ? args.map(String) : [];
  let at = 0;
  if (SIGNAL_ONE.has(a[0])) at = 1;
  else if (a[0] === '-s' && SIGNAL_NAME.has(a[1])) at = 2;
  const operands = a.slice(at);
  if (!operands.length || !operands.every((op) => PID_WORD.test(op))) return null;
  return operands.map(Number);
}

// The text inside each $( ) and pair of backticks (not inside single quotes), outermost only.
function substitutions(text) {
  const spans = [];
  let doubleQuoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') i++;
    else if (c === '"') doubleQuoted = !doubleQuoted;
    else if (c === "'" && !doubleQuoted) {
      const end = text.indexOf("'", i + 1);
      i = end === -1 ? text.length : end;
    } else if (c === '`') {
      const end = text.indexOf('`', i + 1);
      const stop = end === -1 ? text.length : end;
      spans.push(text.slice(i + 1, stop));
      i = stop;
    } else if (c === '$' && text[i + 1] === '(') {
      let depth = 0;
      let j = i + 1;
      for (; j < text.length; j++) {
        if (text[j] === '(') depth++;
        else if (text[j] === ')' && --depth === 0) break;
      }
      spans.push(text.slice(i + 2, j));
      i = j;
    }
  }
  return spans;
}

// The command with each backtick span (not inside single quotes) written as `$(x)`, so that
// commandSteps reads a backtick operand the way it reads `$(...)`: a word the guard cannot name
// (`kill \`cat supervisor.pid\``). commandSteps alone splits on the backtick and leaves the
// kill with no operand. The span's own commands are read separately, by texts().
function maskBackticks(text) {
  let out = '';
  let doubleQuoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') {
      out += text.slice(i, i + 2);
      i++;
    } else if (c === '"') {
      doubleQuoted = !doubleQuoted;
      out += c;
    } else if (c === "'" && !doubleQuoted) {
      const end = text.indexOf("'", i + 1);
      const stop = end === -1 ? text.length - 1 : end;
      out += text.slice(i, stop + 1);
      i = stop;
    } else if (c === '`') {
      const end = text.indexOf('`', i + 1);
      out += '$(x)';
      i = end === -1 ? text.length : end;
    } else out += c;
  }
  return out;
}

// Every text the command runs: itself without its heredoc bodies, each body, each here-string's
// content (`bash <<< 'x'` runs x), and each $( ) and backtick span of all of these, to depth 4.
// A text heredocParts cannot parse (its `unsure`) is pushed to `unsure` for the raw check.
function texts(command, depth = 0, unsure = []) {
  const parts = heredocParts(command);
  const { outer, bodies } = parts;
  if (parts.unsure !== null) unsure.push(parts.unsure);
  const out = [];
  const own = [outer];
  for (const m of outer.matchAll(/<<<[ \t]*('[^']*'|"[^"]*"|\S+)/g)) own.push(m[1].replace(/^(['"])(.*)\1$/s, '$2'));
  own.push(...bodies);
  for (const text of own) {
    out.push(text);
    if (depth < 4) for (const span of substitutions(text)) out.push(...texts(span, depth + 1, unsure));
  }
  return out;
}

const reasonOf = (detail) => `${PREFIX}${detail} ${KILL_HELP}`;
const SCRIPT_LIKE = /[\s;&|<>()`]|\$\(/;

// The indexes of the words of a step that are only text, never a command Foreman's own CLI or git
// would run: every argument of `foreman` (the story skill passes --note, --reason, --title, --body
// and the like), and the message of `git commit|tag|merge` (gitMessageWords). A git command with
// any other option or subcommand has no data word: `git bisect run sh -c -m x` runs its words.
function dataWords(w) {
  const name = base(w[0]);
  if (name === 'foreman') return new Set(w.map((_, i) => i).filter((i) => i >= 1));
  if (name === 'git') return gitMessageWords(w)?.messages ?? new Set();
  return new Set();
}
const KILL_NAMES = new Set(['kill', 'pkill', 'killall']);
const KILL_TOKEN = /(?:^|[^\w./-])(?:kill|pkill|killall)(?:[^\w./-]|$)/;

// Null, or why Foreman denies the command. The guard reads the Bash command text only. It does
// not read a script file the command runs or a language's own kill call (`node -e
// process.kill`), and it does not undo deliberate string-building. The traits and doctor's
// 'last interrupt' cover those. Each text of the command is read step by step, and the first
// reason found wins:
//   R1  pkill and killall: they stop processes by name or pattern.
//   R2  kill: only the allowedKill form, then each PID goes to signals.verdict.
//   R3  any other word after the first that is exactly kill, pkill or killall (`xargs kill`,
//       `find -exec kill`, `eval kill`, even `echo kill`), and any word, the first too, that holds
//       one of them as a token (KILL_TOKEN: `[pkill,-f]`, `alias.k=!pkill`) and that R5 does not
//       read: the command runs a kill the guard cannot read. A path or a file name
//       (`scripts/pkill.sh`, `kill-guard.mjs`) is not a token.
//   R4  a command name held in a variable or substitution (`$k 5`) next to a kill or a signal.
//   R5  a word that looks like a script (spaces, quotes, ; | & < > ( ) or `$(`), the first too, is
//       read whole as one more text (sh -c, eval "...", watch '...', perl -e, `env -S`), to depth 4.
// A step that commandSteps marks unreadable (an `env -S` string with a backslash, a `$` or too many
// nested splits) is refused first, before any rule.
//   R6  after every text is read: when a `<<` is not proven a heredoc (heredocParts `unsure`),
//       the text from its line on is searched raw (rawText) for KILL_TOKEN, and a hit is refused.
export function killReason({ command, cwd, vars = {}, signals } = {}) {
  if (typeof command !== 'string' || command === '') return null;
  const dir = typeof cwd === 'string' && cwd ? cwd : process.cwd();
  const mentionsKill = command.includes('kill');
  const unsure = [];

  const readText = (text, depth) => {
    for (const step of commandSteps(maskBackticks(text), dir, vars ?? {})) {
      if (step.unreadable) {
        return reasonOf('Foreman cannot read the string of `env -S` (it holds a backslash, a `$` or too many nested splits), and it may run a kill.');
      }
      const w = bare(step.words);
      if (!w.length) continue;
      const name = base(w[0]);
      if (name === 'pkill' || name === 'killall') {
        return reasonOf(`\`${name}\` stops processes by name or pattern, which can match the Foreman factory itself (its supervisor, its service or another story's session) and stop every story.`);
      }
      if (name === 'kill') {
        const pids = allowedKill(w.slice(1));
        if (!pids) {
          return reasonOf(`Foreman allows only \`kill <pid>\`, \`kill -TERM|-KILL|-9|-15 <pid>\` and \`kill -s TERM|KILL <pid>\`, each PID written as a number (the one \`echo $!\` printed); \`${w.join(' ').slice(0, 80)}\` is not one of them.`);
        }
        if (signals) {
          for (const pid of pids) {
            const answer = signals.verdict(pid);
            if (answer) return answer;
          }
        }
        continue;
      }
      const data = dataWords(w);
      for (let i = 0; i < w.length; i++) {
        if (data.has(i)) continue;
        if ((i >= 1 && KILL_NAMES.has(base(w[i]))) || (!(depth < 4 && SCRIPT_LIKE.test(w[i])) && KILL_TOKEN.test(w[i]))) {
          return reasonOf(`\`${name}\` runs \`kill\`, \`pkill\` or \`killall\` for you (as \`xargs kill\` or \`find -exec kill\` do), and Foreman cannot tell what it would stop. If the word is only text (a search or a message), use the Grep or Write tool instead.`);
        }
      }
      // A bare `$` is the start of a `$(...)` inside a word read as a script: its commands are read as texts.
      if (w[0].includes('$') && !(depth > 0 && w[0] === '$') && (mentionsKill || w.slice(1).some((a) => /^-?\d+$|^-s$|^-[A-Z]+$/.test(a)))) {
        return reasonOf(`Foreman cannot read the name of the command \`${w[0]}\`, and it may be a kill.`);
      }
      if (depth < 4) {
        for (let i = 0; i < w.length; i++) {
          if (data.has(i) || !SCRIPT_LIKE.test(w[i])) continue;
          for (const inner of texts(w[i], 0, unsure)) {
            const why = readText(inner, depth + 1);
            if (why) return why;
          }
        }
      }
    }
    return null;
  };

  for (const text of texts(command, 0, unsure)) {
    const why = readText(text, 0);
    if (why) return why;
  }
  if (unsure.some((text) => KILL_TOKEN.test(rawText(text)))) {
    return reasonOf('A `<<` in it may sit inside a quote or a comment, so Foreman cannot tell which lines after it run, and they mention `kill`, `pkill` or `killall`. Put the heredoc first, before anything quoted on its line, or split the command into separate Bash calls.');
  }
  return null;
}

export function protectedPids({ stateDir, env = {}, table } = {}) {
  const out = new Map();
  const supervisors = [];
  const add = (pid, label) => {
    if (Number.isInteger(pid) && pid > 0 && !out.has(pid)) out.set(pid, label);
  };
  const filePid = readPid(stateDir);
  if (filePid !== null) supervisors.push(filePid);
  const envPid = Number(env?.FOREMAN_SUPERVISOR_PID);
  if (Number.isInteger(envPid) && envPid > 0) supervisors.push(envPid);
  for (const pid of supervisors) add(pid, 'the Foreman supervisor');
  add(readAdopted(stateDir)?.by, 'the Foreman service or `foreman run` that started the supervisor');
  if (table) {
    for (const pid of supervisors) {
      const seen = new Set([pid]);
      let up = table.get(pid)?.ppid;
      for (let n = 0; n < 64 && Number.isInteger(up) && up > 1 && !seen.has(up); n++) {
        seen.add(up);
        add(up, 'a process that started the Foreman supervisor (its service, `foreman run` or the terminal)');
        up = table.get(up)?.ppid;
      }
    }
  }
  return out;
}

export function sessionRoot({ table, self, story } = {}) {
  const seen = new Set();
  let pid = self;
  while (table?.has(pid) && !seen.has(pid)) {
    seen.add(pid);
    const session = storySessionOf(table.get(pid).command);
    if (session && (!story || session.id === story)) return pid;
    pid = table.get(pid).ppid;
  }
  return null;
}

const inside = (p, root) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

export function pidVerdict({ pid, table, self, story, protect, places = [], cwdOf = () => null } = {}) {
  const label = protect?.get(pid);
  if (label) return `pid ${pid} is ${label}; a story session never signals the Foreman supervisor, its service or the dashboard, whatever the PID.`;
  if (!table) return `Foreman could not list the processes on this machine, so it cannot tell whether pid ${pid} is one this session started.`;
  const root = sessionRoot({ table, self, story });
  if (root === null) return `Foreman cannot find this story session's own process, so it cannot tell whether pid ${pid} is one this session started.`;
  // self, and the processes between it and the root: the session and what its commands run in
  for (let p = self, seen = new Set(); table.has(p) && !seen.has(p); p = table.get(p).ppid) {
    seen.add(p);
    if (p === pid) return `pid ${pid} is this story session itself (or a process its commands run in), so it would stop the session.`;
    if (p === root) break;
  }
  if (!table.has(pid)) return `pid ${pid} is not running, or not one this session started.`;
  for (let p = pid, seen = new Set(); table.has(p) && !seen.has(p); p = table.get(p).ppid) {
    if (p === root) return null;
    seen.add(p);
  }
  const cwd = cwdOf(pid);
  if (typeof cwd === 'string' && cwd && places.some((place) => inside(cwd, place))) return null;
  return `pid ${pid} is not a process this session started: it is neither a child of the session nor running in its worktree or its temp folder.`;
}

const localSh = (cmd, args = []) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024, timeout: 5000 });
  return { status: r.status ?? 1, stdout: r.stdout ?? '' };
};

// Linux without ps: the same table from /proc/<n>/stat and /proc/<n>/cmdline.
function procTable(proc) {
  let names;
  try {
    names = readdirSync(proc).filter((n) => /^[1-9]\d*$/.test(n));
  } catch {
    return null;
  }
  const table = new Map();
  for (const n of names) {
    try {
      const stat = readFileSync(path.join(proc, n, 'stat'), 'utf8');
      // The fields after the last ')' are the state, then the parent's pid.
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[1]);
      if (!Number.isInteger(ppid)) continue;
      let command = '';
      try {
        command = readFileSync(path.join(proc, n, 'cmdline'), 'utf8').replace(/\0/g, ' ').trim();
      } catch {
        // a process that went away: no command
      }
      table.set(Number(n), { ppid, command });
    } catch {
      // gone between the listing and the read
    }
  }
  return table.size ? table : null;
}

export function processSnapshot({ sh = localSh, proc = '/proc' } = {}) {
  try {
    const r = sh('ps', ['-axo', 'pid=,ppid=,command=']);
    if (r && r.status === 0) {
      const table = new Map();
      for (const line of String(r.stdout ?? '').split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s*(.*)$/);
        if (m) table.set(Number(m[1]), { ppid: Number(m[2]), command: m[3] });
      }
      if (table.size) return table;
    }
  } catch {
    // no ps: /proc
  }
  return procTable(proc);
}

export function killLook({ stateDir, env = process.env, self = process.pid, tmpdir = os.tmpdir(), sh = localSh, platform = process.platform, proc, readlink = readlinkSync } = {}) {
  const slot = /^w\d+$/.test(String(env?.FOREMAN_SLOT ?? '')) ? env.FOREMAN_SLOT : null;
  const story = env?.FOREMAN_STORY ?? '';
  let loaded = null;
  const load = () => {
    if (loaded) return loaded;
    const table = processSnapshot({ sh, ...(proc ? { proc } : {}) });
    const places = slot ? [canonicalPath(worktreeOf(stateDir, Number(slot.slice(1)))), canonicalPath(path.join(tmpdir, slot))] : [];
    loaded = { table, protect: protectedPids({ stateDir, env, table }), places };
    return loaded;
  };
  const cwdOf = (pid) => {
    try {
      if (platform === 'linux') return canonicalPath(String(readlink(`/proc/${pid}/cwd`)));
      const folder = lsofFolders(sh('lsof', ['-a', '-d', 'cwd', '-Fn', '-p', String(pid)])?.stdout).get(pid);
      return folder ? canonicalPath(folder) : null;
    } catch {
      return null;
    }
  };
  return {
    verdict(pid) {
      const { table, protect, places } = load();
      const why = pidVerdict({ pid, table, self, story, protect, places, cwdOf });
      return why ? `${PREFIX}${why} ${KILL_HELP}` : null;
    },
  };
}
