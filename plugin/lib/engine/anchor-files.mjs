// The project's own Foreman files, and whether a Bash command would write one. The project the
// run builds (the anchor, FOREMAN_PROJECT_DIR) keeps its config, local settings and key files
// for the owner, and its state folder keeps the check records `foreman checks` writes
// (check-runs.mjs) and each slot's session environment file (session-env.mjs): a story session
// never writes them by hand, whatever the agent. This is a best-effort blocklist (an
// interpreter's own file calls get past it). The commit step reuses a record made under the
// session env (check-runs.mjs findCheckRun), so the commit does rest on this guard, and best
// effort is the protection the design relies on. Pure: no file is read here; the hook passes a
// `resolve` that follows symlinks (run-guard.mjs canonicalPath).
//
//   protectedFiles({ anchor, stateDirPath, config }) -> the files, deduped: the config, the
//       local settings, the env and key files, then <stateDirPath>/check-runs.jsonl and each
//       session-config folder (everything inside it is protected, whatever the name) and each
//       slot's session-config/w<n>-env.json (n up to config.slots, one when it is not a positive
//       whole number)
//   anchorWriteReason({ command, cwd, protect, vars, resolve, foreman }) -> null, or why Foreman
//       denies it; with foreman ({ anchor, guarded, isAnchorDir }) a Foreman CLI call that writes
//       the owner's files is denied when it runs in the anchor or a worktree of it, and from any
//       folder at all when the command changes the FOREMAN_* run variables: with FOREMAN_RUN
//       cleared and FOREMAN_PROJECT_DIR or FOREMAN_STATE_DIR still set, the CLI writes the
//       anchor whatever folder it runs in
//   anchorEditReason({ filePath, cwd, protect, resolve }) -> null, or why Foreman denies a file
//       tool's write
//   commandWords(command, vars, depth) -> the simple commands a shell command runs, as word
//       arrays: split as below, NAME=value prefixes and wrappers removed, redirect targets and
//       empty commands left out, and the commands of a sh/bash/zsh -c script (up to depth 3)
//       added after it. [] for a non-string or empty command. check-guard.mjs reads it.
//   pipelineHeads(command, vars) -> the same commands, in order, without those that read a pipe
//       (`tee log` in `npm test | tee log`): the first command of each pipeline. `||` separates
//       commands like `;`. The commands of a sh/bash/zsh -c script count as heads. [] for a
//       non-string or empty command. check-guard.mjs reads it.
//   commandSteps(command, cwd, vars, depth) -> the same simple commands, in order, as
//       { words, dir, known }: the folder each runs in, from cwd and the `cd`s before it
//       (firstWrite's rules: a bare cd goes to vars.HOME, `cd -` changes nothing, a target with a
//       `$` makes the folder unknown, `known` false, and parentheses scope a cd), and the cd
//       steps themselves. The cd options -L -P -e -@ -q -s and `--` are skipped; pushd moves like
//       cd (`-n` stays), and a popd, or a pushd with no folder or +N/-N, makes the folder unknown.
//       A wrapper that sets the folder (`env -C DIR`, `env --chdir=DIR`, `sudo -D DIR`) sets it for
//       its own step only. A sh/bash/zsh -c script's, or an eval's, steps follow it, from that
//       step's folder. scan-guard.mjs reads it. A step is marked `unreadable: true` when it is an
//       `env -S` whose string holds a backslash or a `$`, when the splits nest past 7, or when env
//       is given an option it is not known to have (a long option may be abbreviated, and an
//       unknown one may hide a string). For a bad -S string the words then start at `env`, as
//       written; for an unknown option they stay the command after env, as before, and only the
//       kill guard refuses the step.
//
// The command is split as a shell would, closely enough: quotes and backslashes, the command
// separators (; && || | & newline and parentheses), $NAME and ${NAME} from `vars` (an unknown
// one stays as it is), a leading ~ (vars.HOME), output redirects, NAME=value prefixes, the shell
// words if, then, else, elif, do, while, until, ! and { (the command is the word after them) and
// the wrappers env, sudo, command, nohup, time, exec, nice, builtin, setsid, stdbuf, ionice,
// caffeinate and doas (xargs is not one: the scan guard reads it itself). `env -S STRING` (also
// `--split-string` or any prefix of it of 3 characters or more such as `--sp=`, `-S` joined to its
// string, and a cluster such as `-iS`) is split into words
// where it stands, so the command it holds is the command. What counts as a write: a redirect's
// target, tee's files, cp/install/ln's destination, mv's every path, rm/unlink/truncate's files,
// sed -i and perl -i's files, and the script of sh/bash/zsh -c and of eval, checked the same way
// (a redirect resolves in the shell's folder, even after `env -C`). A `cd`
// (or pushd) moves the folder later relative paths start from, inside its parentheses only. A read
// (cat, grep, source, diff, a copy from a protected file) is never a write.

import path from 'node:path';
import { SETTINGS_FILE } from '../settings/local.mjs';
import { CHECK_RUNS_FILE } from './check-runs.mjs';
import { SESSION_CONFIG_DIR, sessionEnvPath } from './session-env.mjs';

const DEFAULT_ENV_FILE = '.env.local';
const DEFAULT_FOREMAN_ENV_FILE = '.env.foreman';

const nameOr = (value, fallback) => (typeof value === 'string' && value !== '' ? value : fallback);

export function protectedFiles({ anchor, stateDirPath, config }) {
  const files = [
    path.join(anchor, 'foreman.config.json'),
    path.join(stateDirPath, SETTINGS_FILE),
    path.join(anchor, nameOr(config?.envFile, DEFAULT_ENV_FILE)),
    path.join(anchor, nameOr(config?.foremanEnvFile, DEFAULT_FOREMAN_ENV_FILE)),
    path.join(anchor, DEFAULT_ENV_FILE),
    path.join(anchor, DEFAULT_FOREMAN_ENV_FILE),
    path.join(stateDirPath, CHECK_RUNS_FILE),
  ];
  // The whole folder, not only the slots' env files, on purpose: the slots' settings and MCP files
  // in it set the next session's permissions, hooks and MCP servers (session.mjs), and only the
  // supervisor writes them. A session env file for any other slot name would be read just the same
  // (covered() below).
  files.push(path.join(stateDirPath, SESSION_CONFIG_DIR));
  const slots = Number.isInteger(config?.slots) && config.slots > 0 ? config.slots : 1;
  for (let n = 1; n <= slots; n++) files.push(sessionEnvPath(stateDirPath, `w${n}`));
  return [...new Set(files)];
}

// Whether `file` is a protected file, or anything inside the protected session-config folder.
const covered = (protect, file) =>
  protect.some((p) => p === file || (path.basename(p) === SESSION_CONFIG_DIR && file.startsWith(p + path.sep)));

const reasonFor = (file, what = 'command') =>
  `Foreman denies this ${what}: it would change ${file}, which belongs to the project this run builds. Story sessions never write the real project's config, settings or keys; check Foreman commands in a scratch git repo, with the FOREMAN_* variables left set.`;
const inAnchorFor = (what, anchor) =>
  `${what} would change ${anchor}, the project this Foreman run builds, so it does not run inside a story session (FOREMAN_RUN=1); run it in a scratch git repo instead.`;
const varsChangedFor = (what, anchor) =>
  `Foreman denies this command: it runs ${what} with the Foreman run variables changed, so it could change ${anchor}, the project this run builds, whatever folder it runs in. Keep the FOREMAN_* variables set and run it in a scratch git repo: inside a run it then acts on that repo.`;

// The run variables a guarded Foreman command reads to tell the project apart: a command that
// unsets, sets or drops them (unset, NAME=value, env -u, env -i) can point Foreman anywhere.
const RUN_VARS = /(^|[^$\w{])FOREMAN_(RUN|PROJECT_DIR|STATE_DIR)\b/;
const ENV_CLEARED = /(^|[\s;&|(])env\s+(?:[^;&|]*\s)?(-[A-Za-z]*i[A-Za-z]*|--ignore-environment|-)(?=\s|$)/;
const changesRunVars = (command) => RUN_VARS.test(command) || ENV_CLEARED.test(command);

// The arguments of a Foreman CLI call (`foreman ...`, `node <path>/foreman ...`, `npx foreman
// ...`), or null when the command is not one.
function foremanArgs(name, args) {
  if (name === 'foreman') return args;
  if (name !== 'node' && name !== 'npx') return null;
  const at = args.findIndex((a) => !a.startsWith('-'));
  return at !== -1 && path.basename(args[at]) === 'foreman' ? args.slice(at + 1) : null;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// $NAME or ${NAME} at s[i] ('$'): [text, next index].
function expand(s, i, vars) {
  if (s[i + 1] === '{') {
    const end = s.indexOf('}', i + 2);
    const name = end === -1 ? '' : s.slice(i + 2, end);
    if (end !== -1 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      return [Object.hasOwn(vars, name) ? String(vars[name]) : s.slice(i, end + 1), end + 1];
    }
    return ['$', i + 1];
  }
  const m = NAME.exec(s.slice(i + 1));
  if (!m) return ['$', i + 1];
  return [Object.hasOwn(vars, m[0]) ? String(vars[m[0]]) : `$${m[0]}`, i + 1 + m[0].length];
}

// Tokens: { t: 'w', v } a word, { t: 'sep', v } a separator ('(' and ')' kept apart),
// { t: 'out', dup } an output redirect, { t: 'in' } an input redirect.
function tokenize(s, vars) {
  const tokens = [];
  let cur = '';
  let has = false;
  let quoted = false;
  const push = () => {
    if (has) tokens.push({ t: 'w', v: cur });
    cur = '';
    has = false;
    quoted = false;
  };
  const sep = (v) => {
    push();
    tokens.push({ t: 'sep', v });
  };
  const out = (i) => {
    // `>&2` and `2>&1` copy a descriptor: no file.
    let dup = false;
    if (s[i + 1] === '&') {
      dup = true;
      i++;
    }
    tokens.push({ t: 'out', dup });
    return i;
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      if (s[i + 1] === '\n') {
        i++;
      } else if (i + 1 < s.length) {
        cur += s[++i];
        has = true;
        quoted = true;
      }
    } else if (c === "'") {
      const end = s.indexOf("'", i + 1);
      const stop = end === -1 ? s.length : end;
      cur += s.slice(i + 1, stop);
      has = true;
      quoted = true;
      i = stop;
    } else if (c === '"') {
      has = true;
      quoted = true;
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && '"\\$`\n'.includes(s[i + 1] ?? '')) {
          if (s[i + 1] !== '\n') cur += s[i + 1];
          i += 2;
        } else if (s[i] === '$') {
          const [text, next] = expand(s, i, vars);
          cur += text;
          i = next;
        } else {
          cur += s[i++];
        }
      }
    } else if (c === '$') {
      const [text, next] = expand(s, i, vars);
      cur += text;
      has = true;
      i = next - 1;
    } else if (c === ' ' || c === '\t') {
      push();
    } else if (c === '\n' || c === ';' || c === '`') {
      sep(';');
    } else if (c === '(' || c === ')') {
      sep(c);
    } else if (c === '&') {
      if (s[i + 1] === '&') {
        sep(';');
        i++;
      } else if (s[i + 1] === '>') {
        push();
        i += s[i + 2] === '>' ? 2 : 1;
        tokens.push({ t: 'out', dup: false });
      } else {
        sep(';');
      }
    } else if (c === '|') {
      if (s[i + 1] === '|') {
        sep(';');
        i++;
      } else {
        sep('|');
        if (s[i + 1] === '&') i++;
      }
    } else if (c === '>') {
      // `2>file`: the digits name a descriptor, not a word.
      if (has && !quoted && /^\d+$/.test(cur)) {
        cur = '';
        has = false;
      } else {
        push();
      }
      if (s[i + 1] === '>' || s[i + 1] === '|') i++;
      i = out(i);
    } else if (c === '<') {
      if (has && !quoted && /^\d+$/.test(cur)) {
        cur = '';
        has = false;
      } else {
        push();
      }
      while (s[i + 1] === '<' || s[i + 1] === '&' || s[i + 1] === '>' || s[i + 1] === '-') i++;
      tokens.push({ t: 'in' });
    } else if (c === '#' && !has) {
      const end = s.indexOf('\n', i);
      i = end === -1 ? s.length : end - 1;
    } else if (c === '~' && !has && (i + 1 === s.length || /[\s/;&|()<>]/.test(s[i + 1]))) {
      cur += Object.hasOwn(vars, 'HOME') ? String(vars.HOME) : '~';
      has = true;
    } else {
      cur += c;
      has = true;
    }
  }
  push();
  return tokens;
}

// Shell reserved words that start a command: the word after one is the command name. Matched as
// written (a path named `then` is a command).
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{']);

// Wrappers that run the command after their own options: { options that take a value }.
const WRAPPERS = {
  env: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']),
  sudo: new Set(['-u', '-g', '-p', '-C', '-D', '-r', '-t', '-U', '-h', '-T']),
  command: new Set(),
  nohup: new Set(),
  time: new Set(['-f', '-o']),
  exec: new Set(['-a']),
  nice: new Set(['-n', '--adjustment']),
  builtin: new Set(),
  setsid: new Set(),
  stdbuf: new Set(['-i', '-o', '-e', '--input', '--output', '--error']),
  ionice: new Set(['-c', '-n', '-p', '-P', '-u', '--class', '--classdata', '--pid', '--pgid', '--uid']),
  caffeinate: new Set(['-t', '-w']),
  doas: new Set(['-u', '-C']),
};

// The options of a wrapper that run the command in another folder.
const CHDIR = { env: new Set(['-C', '--chdir']), sudo: new Set(['-D', '--chdir']) };

// The folder after entering `d` from `here` ({ dir, known }); a `$` left in it makes it unknown.
const into = (here, d) => ({ dir: path.resolve(here.dir, String(d)), known: here.known && !String(d).includes('$') });

// The string of an `env -S` option at words[i], and how many words the option takes: { value, used },
// or null when the word is no such option or has no string. env's flag letters (-i -0 -v) may
// come before the S. env reads a long option by any unique prefix (GNU getopt_long), so `--s`,
// `--sp=` and `--split-str` all mean `--split-string`: any `--` word that is a prefix of it of at
// least 3 characters counts, with or without `=`.
function splitString(words, i) {
  const w = words[i];
  const long = /^(--[a-z-]*)(=(.*))?$/s.exec(w);
  if (long && long[1].length >= 3 && '--split-string'.startsWith(long[1])) {
    if (long[2] !== undefined) return { value: long[3], used: 1 };
    return words[i + 1] === undefined ? null : { value: words[i + 1], used: 2 };
  }
  if (w === '-S' || /^-[i0v]*S$/.test(w)) return words[i + 1] === undefined ? null : { value: words[i + 1], used: 2 };
  const joined = /^-[i0v]*S(.+)$/s.exec(w);
  return joined ? { value: joined[1], used: 1 } : null;
}

// How many words an option of env takes when it is one env is known to have, else null. Any other
// option may hide a string env splits (a long option abbreviated, a letter this list lacks), so
// the step is marked unreadable (the kill guard refuses it) while its words stay the command after
// env, skipping the option, so the other guards read it as they always did.
function envOption(w) {
  if (/^-[i0v]+$/.test(w) || ['--ignore-environment', '--null', '--debug', '--help', '--version', '--list-signal-handling'].includes(w)) return 1;
  if (/^--(?:unset|chdir|argv0|block-signal|default-signal|ignore-signal)=/.test(w)) return 1;
  if (/^-[uCaP]./s.test(w)) return 1;
  // -S or --split-string with no string after it: nothing to read
  if (/^-[i0v]*S$/.test(w) || (w.length >= 3 && '--split-string'.startsWith(w))) return 1;
  if (['-u', '--unset', '-a', '--argv0', '-P'].includes(w)) return 2;
  if (['--block-signal', '--default-signal', '--ignore-signal'].includes(w)) return 1;
  return null;
}

// env -S strings split this many times at most; a deeper nest is unreadable.
const MAX_SPLITS = 7;

// The command itself, with no NAME=value prefix, keyword or wrapper, and the folders its
// wrappers (env -C, sudo -D) run it in, in order. An `env -S` string is split in place. With a
// backslash or a `$` in the string (env expands them itself), or past MAX_SPLITS splits, the
// result is { cmd: the words from env on, unreadable: true }. An unknown env option marks the step
// unreadable too, but cmd is still the command after env.
function unwrapped(words) {
  let i = 0;
  let splits = 0;
  let unknownOption = false;
  const chdirs = [];
  for (;;) {
    while (i < words.length && ASSIGNMENT.test(words[i])) i++;
    if (i < words.length && KEYWORDS.has(words[i])) {
      i++;
      continue;
    }
    const name = path.basename(words[i] ?? '');
    if (!Object.hasOwn(WRAPPERS, name)) break;
    const nameAt = i;
    i++;
    const dirOptions = CHDIR[name];
    while (i < words.length && words[i].startsWith('-') && words[i] !== '-') {
      const w = words[i];
      if (w === '--') {
        i++;
        break;
      }
      const split = name === 'env' ? splitString(words, i) : null;
      if (split) {
        if (/[\\$]/.test(split.value) || splits >= MAX_SPLITS) return { cmd: words.slice(nameAt), chdirs, unreadable: true };
        const parts = tokenize(split.value, {})
          .filter((t) => t.t === 'w')
          .map((t) => t.v);
        words = [...words.slice(0, i), ...parts, ...words.slice(i + split.used)];
        splits++;
        continue;
      }
      if (dirOptions) {
        const short = [...dirOptions].find((o) => !o.startsWith('--') && w.startsWith(o) && w.length > o.length);
        if (dirOptions.has(w)) {
          if (words[i + 1] !== undefined) chdirs.push(words[i + 1]);
          i += 2;
          continue;
        }
        if (w.startsWith('--chdir=')) {
          chdirs.push(w.slice('--chdir='.length));
          i++;
          continue;
        }
        if (short) {
          chdirs.push(w.slice(short.length));
          i++;
          continue;
        }
      }
      if (name === 'env') {
        const used = envOption(w);
        if (used === null) {
          // the other guards go on as they did, skipping the option; the kill guard refuses the step
          unknownOption = true;
          i++;
          continue;
        }
        i += used;
        continue;
      }
      if (WRAPPERS[name].has(w)) i++;
      i++;
    }
  }
  return { cmd: words.slice(i), chdirs, ...(unknownOption ? { unreadable: true } : {}) };
}
const unwrap = (words) => unwrapped(words).cmd;

// Where a cd, pushd or popd leaves the folder: null when it stays, else { dir, known }. Options
// are skipped (cd -L -P -e -@ -q -s; pushd and popd -n, which leaves the folder alone), then one
// `--`. A popd, or a pushd with no folder or a +N/-N argument, goes somewhere unknown.
function moveOf(name, args, here, vars) {
  if (name !== 'cd' && name !== 'pushd' && name !== 'popd') return null;
  let k = 0;
  let stay = false;
  while (k < args.length && (name === 'cd' ? /^-[LPe@qs]+$/.test(args[k]) : args[k] === '-n')) {
    if (args[k] === '-n') stay = true;
    k++;
  }
  if (args[k] === '--') k++;
  if (stay) return null;
  if (name === 'popd' || (name === 'pushd' && (args[k] === undefined || /^[+-]\d+$/.test(args[k])))) return { dir: here.dir, known: false };
  const target = args[k] === undefined ? vars?.HOME : args[k];
  if (target === undefined || target === '-') return null;
  return into(here, target);
}

// The non-option arguments, skipping each option in `takesValue` and its value; `--` ends options.
function operands(args, takesValue = new Set()) {
  const out = [];
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (options && a === '--') options = false;
    else if (options && a.startsWith('-') && a !== '-') {
      if (takesValue.has(a)) i++;
    } else out.push(a);
  }
  return out;
}

// The target directory of cp/install/ln/mv given with -t DIR, -tDIR or --target-directory=DIR.
function targetDir(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') return null;
    if (a === '-t' || a === '--target-directory') return args[i + 1] ?? null;
    if (a.startsWith('--target-directory=')) return a.slice('--target-directory='.length);
    if (/^-t./.test(a)) return a.slice(2);
  }
  return null;
}

const COPY_VALUE_OPTIONS = {
  cp: new Set(['-t', '--target-directory', '-S', '--suffix']),
  install: new Set(['-t', '--target-directory', '-S', '--suffix', '-m', '--mode', '-o', '--owner', '-g', '--group']),
  ln: new Set(['-t', '--target-directory', '-S', '--suffix']),
  mv: new Set(['-t', '--target-directory', '-S', '--suffix']),
};

// The paths a command (its words, wrappers removed) writes, and the scripts it runs.
function writes(name, args) {
  if (name === 'tee') return { paths: operands(args) };
  if (Object.hasOwn(COPY_VALUE_OPTIONS, name)) {
    const ops = operands(args, COPY_VALUE_OPTIONS[name]);
    const dir = targetDir(args);
    const dest = dir ?? ops.at(-1);
    if (dest === undefined) return { paths: [] };
    const sources = dir === null ? ops.slice(0, -1) : ops;
    const into = sources.map((src) => path.join(dest, path.basename(src)));
    return { paths: [dest, ...into, ...(name === 'mv' ? sources : [])] };
  }
  if (name === 'rm' || name === 'unlink') return { paths: operands(args) };
  if (name === 'truncate') return { paths: operands(args, new Set(['-s', '--size', '-r', '--reference'])) };
  if (name === 'sed' && args.some((a) => /^(-[A-Za-z]*i|--in-place)/.test(a))) return { paths: operands(args) };
  if (name === 'perl' && args.some((a) => /^-[A-Za-z]*i/.test(a))) return { paths: operands(args) };
  if (name === 'eval') return { paths: [], scripts: args.length ? [args.join(' ')] : [] };
  if (name === 'sh' || name === 'bash' || name === 'zsh') {
    const at = args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
    if (at !== -1 && args[at + 1] !== undefined) return { paths: [], scripts: [args[at + 1]] };
  }
  return { paths: [] };
}

// The first protected file the command writes, or null.
// With `foreman` ({ anchor, guarded, isAnchorDir }), a Foreman call that writes the owner's files
// (guarded(name, args) gives its label) is a write too, when it runs in the anchor, inside it or
// in a worktree of it (isAnchorDir), or from any folder while the command changes the run
// variables (`changed`). Returns { file } or { reason }, or null.
function firstWrite(command, cwd, protect, vars, resolve, depth, foreman, changed) {
  const tokens = tokenize(command, vars);
  const dirs = [{ dir: cwd, known: true }];
  let words = [];
  let targets = [];
  let pending = null; // 'out' | 'dup' | 'in': what the next word is

  const hit = (candidate, base) => {
    const file = resolve(path.resolve(base, candidate));
    return covered(protect, file) ? file : null;
  };
  const finish = () => {
    const { dir: base, known } = dirs.at(-1);
    const found = targets.map((t) => hit(t, base)).find(Boolean);
    const { cmd, chdirs } = unwrapped(words);
    words = [];
    targets = [];
    pending = null;
    if (found) return { file: found };
    if (!cmd.length) return null;
    // The redirect targets above resolve against `base`: the shell opens them before env runs.
    const run = chdirs.reduce(into, { dir: base, known });
    const name = path.basename(cmd[0]);
    const args = cmd.slice(1);
    if (name === 'cd' || name === 'pushd' || name === 'popd') {
      // A variable left unexpanded (`cd "$scratch"`, `cd $(mktemp -d)`) may be empty: unknown.
      const moved = moveOf(name, args, { dir: base, known }, vars);
      if (moved) dirs[dirs.length - 1] = moved;
      return null;
    }
    if (foreman) {
      const fargs = foremanArgs(name, args);
      const what = fargs && fargs.length ? foreman.guarded(fargs[0], fargs.slice(1)) : null;
      if (what) {
        // `--project DIR` (foreman keys) names the project instead of the current folder.
        const at = fargs.findIndex((a) => a === '--project' || a.startsWith('--project='));
        const project = at === -1 ? null : fargs[at] === '--project' ? fargs[at + 1] : fargs[at].slice('--project='.length);
        const dir = typeof project === 'string' ? path.resolve(run.dir, project) : run.dir;
        const sure = typeof project === 'string' ? (run.known || path.isAbsolute(project)) && !project.includes('$') : run.known;
        if (sure && foreman.isAnchorDir(dir)) return { reason: inAnchorFor(what, foreman.anchor) };
        // Outside a run the CLI follows FOREMAN_PROJECT_DIR and FOREMAN_STATE_DIR, not the folder,
        // so a known scratch folder is no safer than an unknown one.
        if (changed) return { reason: varsChangedFor(what, foreman.anchor) };
      }
    }
    const { paths, scripts = [] } = writes(name, args);
    for (const p of paths) {
      const file = hit(p, run.dir);
      if (file) return { file };
    }
    if (depth < 3) {
      for (const script of scripts) {
        const found = firstWrite(script, run.dir, protect, vars, resolve, depth + 1, foreman, changed);
        if (found) return found;
      }
    }
    return null;
  };

  for (const tok of tokens) {
    if (tok.t === 'w') {
      if (pending === 'out') targets.push(tok.v);
      else if (pending === null) words.push(tok.v);
      pending = null;
    } else if (tok.t === 'out') {
      pending = tok.dup ? 'dup' : 'out';
    } else if (tok.t === 'in') {
      pending = 'in';
    } else {
      const found = finish();
      if (found) return found;
      if (tok.v === '(') dirs.push({ ...dirs.at(-1) });
      else if (tok.v === ')' && dirs.length > 1) dirs.pop();
    }
  }
  return finish();
}

export function anchorWriteReason({ command, cwd, protect, vars = {}, resolve = path.resolve, foreman }) {
  if (typeof command !== 'string' || command === '' || !Array.isArray(protect) || protect.length === 0) return null;
  const base = typeof cwd === 'string' && cwd ? cwd : process.cwd();
  const calls = foreman && typeof foreman.guarded === 'function' && typeof foreman.isAnchorDir === 'function' ? foreman : null;
  const found = firstWrite(command, base, protect, vars ?? {}, resolve, 0, calls, calls ? changesRunVars(command) : false);
  if (!found) return null;
  return found.reason ?? reasonFor(found.file);
}

// Whether a file tool (Write, Edit, MultiEdit, NotebookEdit) writing filePath would change a
// protected file: null, or why Foreman denies it. A relative path starts from cwd.
export function anchorEditReason({ filePath, cwd, protect, resolve = path.resolve }) {
  if (typeof filePath !== 'string' || filePath === '' || !Array.isArray(protect) || protect.length === 0) return null;
  const base = typeof cwd === 'string' && cwd ? cwd : process.cwd();
  const file = resolve(path.resolve(base, filePath));
  return covered(protect, file) ? reasonFor(file, 'edit') : null;
}

// The simple commands `command` runs, as word arrays (see the header). The script of a
// sh/bash/zsh -c is searched too, so `bash -c "npm test"` also gives ['npm', 'test'].
export const commandWords = (command, vars = {}, depth = 0) => simpleCommands(command, vars, depth).map((c) => c.words);

// The simple commands `command` runs that do not read a pipe, as word arrays, in order (see the
// header). In `a | b; c` they are a and c.
export const pipelineHeads = (command, vars = {}) =>
  simpleCommands(command, vars, 0)
    .filter((c) => !c.piped)
    .map((c) => c.words);

// Each simple command as { words, piped }: piped when a `|` or `|&` feeds it. A `;`, `&&`, `||`,
// `&` or newline ends the pipeline; parentheses leave it as it is. The commands of a script run
// by sh/bash/zsh -c follow their command and do not count as piped.
function simpleCommands(command, vars, depth) {
  if (typeof command !== 'string' || command === '') return [];
  const found = [];
  let words = [];
  let pending = false; // the next word is a redirect's target
  let piped = false;
  const finish = () => {
    const cmd = unwrap(words);
    words = [];
    pending = false;
    if (!cmd.length) return;
    found.push({ words: cmd, piped });
    if (depth < 3) {
      const { scripts = [] } = writes(path.basename(cmd[0]), cmd.slice(1));
      for (const script of scripts) {
        for (const inner of simpleCommands(script, vars, depth + 1)) found.push({ words: inner.words, piped: false });
      }
    }
  };
  for (const tok of tokenize(command, vars ?? {})) {
    if (tok.t === 'w') {
      if (!pending) words.push(tok.v);
      pending = false;
    } else if (tok.t === 'out' || tok.t === 'in') {
      pending = true;
    } else {
      finish();
      if (tok.v === '|') piped = true;
      else if (tok.v === ';') piped = false;
    }
  }
  finish();
  return found;
}

// The simple commands `command` runs, in order, each with the folder it runs in (see the header).
// `known` starts true; a script's steps start from the step that runs it.
export function commandSteps(command, cwd, vars = {}, depth = 0, known = true) {
  if (typeof command !== 'string' || command === '') return [];
  const steps = [];
  const dirs = [{ dir: cwd, known }];
  let words = [];
  let pending = false; // the next word is a redirect's target
  const finish = () => {
    const { cmd, chdirs, unreadable } = unwrapped(words);
    words = [];
    pending = false;
    if (!cmd.length) return;
    const here = dirs.at(-1);
    // A wrapper's folder (env -C) is for its own command only; it does not last.
    const run = chdirs.reduce(into, here);
    steps.push({ words: cmd, dir: run.dir, known: run.known, ...(unreadable ? { unreadable: true } : {}) });
    const name = path.basename(cmd[0]);
    if (name === 'cd' || name === 'pushd' || name === 'popd') {
      const moved = moveOf(name, cmd.slice(1), here, vars);
      if (moved) dirs[dirs.length - 1] = moved;
    } else if (depth < 3) {
      const { scripts = [] } = writes(name, cmd.slice(1));
      for (const script of scripts) steps.push(...commandSteps(script, run.dir, vars, depth + 1, run.known));
    }
  };
  for (const tok of tokenize(command, vars ?? {})) {
    if (tok.t === 'w') {
      if (!pending) words.push(tok.v);
      pending = false;
    } else if (tok.t === 'out' || tok.t === 'in') {
      pending = true;
    } else {
      finish();
      if (tok.v === '(') dirs.push({ ...dirs.at(-1) });
      else if (tok.v === ')' && dirs.length > 1) dirs.pop();
    }
  }
  finish();
  return steps;
}
