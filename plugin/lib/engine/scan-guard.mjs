// Whether a story session's search or read reaches outside the folders it may use. A scan of the
// whole disk or of the owner's home folder (`find /`, `du -sh ~`, `rg x /`, `mdfind foo`) walks
// the owner's private folders (Desktop, Documents, Photos, network volumes), and when the run is
// started by launchd (`foreman service install`) macOS then asks the owner, on behalf of `node`,
// to allow access. A story only ever needs the project, so bash-guard.mjs denies the command and
// the hook (lib/hooks/agent-events.mjs) denies a Read, Glob or Grep call there. Pure apart from
// the `resolve` it is given (run-guard.mjs canonicalPath, which follows symlinks): the hook does
// the I/O.
//
//   SCAN_HELP -> the sentence every denial ends with
//   scanRoots({ anchor, stateDirPath, home, claudeConfigDir, tmpDirs, pluginRoot }) -> the folders
//       a session may search: the project (its worktrees live in its state folder), the Claude
//       config folder, ~/.claude, the temp folders and the plugin. A root that is '/', the home
//       folder or a parent of it is dropped, or a stray TMPDIR=/ would allow everything.
//   sessionScanRoots({ anchor, config, env, homedir, tmpdir, pluginRoot }) -> scanRoots for a
//       session: the state folder from stateDir(anchor, config, env), the home folder from
//       env.HOME, else homedir, and the temp folders tmpdir and /tmp.
//   scanStarts(words) -> null when the simple command (its wrappers removed) does not search a
//       tree; { name, starts } with the folders (or files) it starts from, '.' when it names
//       none; { name, whole: true } for `mdfind` without -onlyin. Covers find, du, ls -R,
//       grep -r (and egrep, fgrep), rg and mdfind, with each command's own option syntax; find's
//       `--` ends its options, so the words after it are starts.
//   scanCommandReason({ command, cwd, vars, roots, resolve }) -> null, or why Foreman denies the
//       command. Every start must sit in a root as written (checked first, with no file-system
//       call: a symlink under a private folder is never followed, because that alone could raise
//       the prompt) and again once `resolve` has followed its symlinks. A start with a `$`
//       (a variable or substitution not expanded), or a relative one after a `cd` into one, is
//       unknown and skipped. No roots, no guard. The commands come from commandSteps, so shell
//       keywords (then, do, { ...), wrappers (nice, env -C ...), eval and a cd, pushd or env -C
//       first are followed; xargs is read here (the command after its options); and a for loop's
//       variable is replaced by the loop's values when it is the only variable in the start.
//   scanToolReason({ tool, input, cwd, roots, home, resolve }) -> the same for a Read (file_path),
//       Grep (path, else cwd) or Glob (path, else cwd, and the literal prefix of the pattern,
//       relative ones included, so `../../x/**` is checked) call; null for any other tool. A
//       leading ~ in a path or pattern is `home`; with no home it is left as it is.

import path from 'node:path';
import { commandSteps } from './anchor-files.mjs';
import { stripTimeout } from './check-guard.mjs';
import { stateDir } from './paths.mjs';

export const SCAN_HELP =
  'Search only inside the project (its worktree and state folder), ~/.claude and the temp folder; start at `.` or a folder in the project instead. A search of the whole disk or the home folder reaches the owner\'s private folders, and macOS then asks the owner for access.';

const clean = (v) => (typeof v === 'string' && v !== '' ? path.resolve(v) : null);
const inside = (p, root) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

export function scanRoots({ anchor, stateDirPath, home, claudeConfigDir, tmpDirs = [], pluginRoot } = {}) {
  const homeDir = clean(home);
  const all = [anchor, stateDirPath, claudeConfigDir, homeDir ? path.join(homeDir, '.claude') : null, ...(Array.isArray(tmpDirs) ? tmpDirs : []), pluginRoot];
  const roots = all.map(clean).filter(Boolean);
  const keep = (r) => r !== path.parse(r).root && !(homeDir && (r === homeDir || inside(homeDir, r)));
  return [...new Set(roots.filter(keep))];
}

// A small getopt: the options as { name, value } (name '-x' or '--long'), and the operands.
// A short letter in `shortValue` takes the rest of its cluster, or the next word; a long option
// in `longValue` takes `=value` or the next word; '--' ends the options.
function getopt(args, shortValue, longValue) {
  const opts = [];
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (eq !== -1) opts.push({ name: `--${name}`, value: a.slice(eq + 1) });
      else if (longValue.has(name)) opts.push({ name: `--${name}`, value: args[++i] });
      else opts.push({ name: `--${name}` });
    } else if (a.startsWith('-') && a !== '-') {
      for (let k = 1; k < a.length; k++) {
        if (shortValue.includes(a[k])) {
          opts.push({ name: `-${a[k]}`, value: k + 1 < a.length ? a.slice(k + 1) : args[++i] });
          break;
        }
        opts.push({ name: `-${a[k]}` });
      }
    } else {
      rest.push(a);
    }
  }
  return { opts, rest };
}

const has = (opts, ...names) => opts.some((o) => names.includes(o.name));
// --recursive, or an unambiguous abbreviation of it (GNU accepts --rec).
const longRecursive = (o) => o.name.startsWith('--') && o.name.length >= 5 && '--recursive'.startsWith(o.name);

const FIND_START_END = new Set(['(', '!', ')', ',']);
function findStarts(args) {
  const starts = [];
  let i = 0;
  while (i < args.length) {
    if (/^-[EHLPXdsx]+$/.test(args[i]) || /^-O\d*$/.test(args[i])) i++;
    else if (args[i] === '-D') i += 2;
    else if (args[i] === '-f') {
      if (args[i + 1] !== undefined) starts.push(args[i + 1]);
      i += 2;
    } else if (args[i] === '--') {
      i++;
      break;
    } else break;
  }
  while (i < args.length && !args[i].startsWith('-') && !FIND_START_END.has(args[i])) starts.push(args[i++]);
  return starts;
}

const DU_LONG = new Set(['block-size', 'max-depth', 'threshold', 'exclude', 'exclude-from', 'files0-from', 'time-style']);
const GREP_LONG = new Set(['regexp', 'file', 'max-count', 'after-context', 'before-context', 'context', 'directories', 'devices', 'include', 'exclude', 'exclude-dir', 'exclude-from', 'label', 'binary-files']);
const RG_LONG = new Set([
  'regexp', 'file', 'glob', 'iglob', 'type', 'type-not', 'type-add', 'type-clear', 'max-count', 'after-context', 'before-context', 'context', 'max-columns', 'threads', 'encoding',
  'replace', 'max-depth', 'maxdepth', 'ignore-file', 'pre', 'pre-glob', 'sort', 'sortr', 'color', 'colors', 'path-separator', 'max-filesize', 'dfa-size-limit', 'regex-size-limit',
  'context-separator', 'field-match-separator', 'field-context-separator', 'engine',
]);
const MDFIND_VALUE = new Set(['-name', '-s', '-attr']);

// With a pattern operand first (unless an option gave the pattern), the rest are starts.
const patternThenStarts = (opts, rest, patternOptions) => (has(opts, ...patternOptions) ? rest : rest.slice(1));
const orHere = (starts) => (starts.length ? starts : ['.']);

export function scanStarts(words) {
  if (!Array.isArray(words) || words.length === 0) return null;
  const name = path.basename(String(words[0]));
  const args = words.slice(1).map(String);
  switch (name) {
    case 'find':
      return { name, starts: orHere(findStarts(args)) };
    case 'du': {
      const { rest } = getopt(args, 'BdItX', DU_LONG);
      return { name, starts: orHere(rest) };
    }
    case 'ls': {
      const { opts, rest } = getopt(args, '', new Set());
      return has(opts, '-R') || opts.some(longRecursive) ? { name, starts: orHere(rest) } : null;
    }
    case 'grep':
    case 'egrep':
    case 'fgrep': {
      const { opts, rest } = getopt(args, 'efmABCdD', GREP_LONG);
      const recursive =
        has(opts, '-r', '-R', '--dereference-recursive') ||
        opts.some(longRecursive) ||
        opts.some((o) => (o.name === '-d' || o.name === '--directories') && o.value === 'recurse');
      if (!recursive) return null;
      return { name, starts: orHere(patternThenStarts(opts, rest, ['-e', '--regexp', '-f', '--file'])) };
    }
    case 'rg':
    case 'ripgrep': {
      const { opts, rest } = getopt(args, 'efgtTmABCMjErd', RG_LONG);
      return { name, starts: orHere(patternThenStarts(opts, rest, ['--files', '-e', '--regexp', '-f', '--file'])) };
    }
    case 'mdfind': {
      const starts = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '-onlyin') {
          if (args[i + 1] !== undefined) starts.push(args[i + 1]);
          i++;
        } else if (MDFIND_VALUE.has(args[i])) i++;
      }
      return starts.length ? { name, starts } : { name, whole: true };
    }
    default:
      return null;
  }
}

// xargs runs the command it is given: its options are skipped, and what is left is that command.
const XARGS_VALUE = new Set([
  '-a', '-d', '-E', '-I', '-J', '-L', '-n', '-P', '-R', '-S', '-s', '--arg-file', '--delimiter', '--eof', '--replace', '--max-lines', '--max-args', '--max-procs', '--max-chars',
  '--process-slot-var',
]);
function stripXargs(words) {
  if (!Array.isArray(words) || words.length === 0 || path.basename(String(words[0])) !== 'xargs') return words;
  let i = 1;
  while (i < words.length && String(words[i]).startsWith('-') && words[i] !== '-') {
    if (words[i] === '--') {
      i++;
      break;
    }
    i += XARGS_VALUE.has(words[i]) ? 2 : 1;
  }
  return words.slice(i);
}

// The values a start may take: itself, or, when its only variable is a for loop's, each value of
// the loop. A candidate that still holds a `$` is unknown and left out.
function candidatesOf(start, loops) {
  if (!start.includes('$')) return [start];
  const names = new Set([...start.matchAll(/\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g)].map((m) => m[1] ?? m[2]));
  if (names.size !== 1) return [];
  const [name] = names;
  if (!loops.has(name)) return [];
  const ref = new RegExp(`\\$(?:\\{${name}\\}|${name}(?![A-Za-z0-9_]))`, 'g');
  return loops.get(name).map((value) => start.replace(ref, () => value)).filter((c) => !c.includes('$'));
}

const commandReason = (name, where) =>
  `Foreman denies this command: \`${name}\` would search ${where}, outside the folders a story session may search. ${SCAN_HELP}`;
const toolReason = (tool, where) =>
  `Foreman denies this ${tool} call: ${where} is outside the folders a story session may read. ${SCAN_HELP}`;

const usable = (roots) => Array.isArray(roots) && roots.length > 0;
const forms = (roots, resolve) => [...new Set([...roots, ...roots.map((r) => resolve(r))])].filter((r) => r !== path.parse(r).root);

// Whether `lexical` (absolute) is inside the roots as written and once its symlinks are
// followed. The first check makes no file-system call.
function allowed(lexical, rootForms, resolve) {
  if (!rootForms.some((r) => inside(lexical, r))) return false;
  return rootForms.some((r) => inside(resolve(lexical), r));
}

export function scanCommandReason({ command, cwd, vars = {}, roots, resolve = path.resolve } = {}) {
  if (!usable(roots) || typeof command !== 'string' || command === '') return null;
  const base = typeof cwd === 'string' && cwd ? cwd : process.cwd();
  const rootForms = forms(roots, resolve);
  const loops = new Map();
  for (const step of commandSteps(command, base, vars ?? {})) {
    const w = step.words;
    if (w[0] === 'for' && w[2] === 'in' && /^[A-Za-z_]\w*$/.test(w[1])) loops.set(w[1], w.slice(3));
    const found = scanStarts(stripTimeout(stripXargs(stripTimeout(w))));
    if (!found) continue;
    if (found.whole) return `Foreman denies this command: \`${found.name}\` without -onlyin searches the whole disk. ${SCAN_HELP}`;
    for (const start of found.starts) {
      for (const candidate of candidatesOf(start, loops)) {
        if (!path.isAbsolute(candidate) && !step.known) continue;
        const lexical = path.resolve(step.dir, candidate);
        if (!allowed(lexical, rootForms, resolve)) return commandReason(found.name, lexical);
      }
    }
  }
  return null;
}

// The folder an absolute glob pattern is anchored at: the segments before the first one with a
// wildcard, or '/' when none is left.
function literalPrefix(pattern) {
  const literal = [];
  for (const segment of pattern.split('/')) {
    if (/[*?[{]/.test(segment)) break;
    literal.push(segment);
  }
  return literal.join('/') || (pattern.startsWith('/') ? '/' : '.');
}

// A leading ~ is the home folder, when there is one to give; nothing is guessed otherwise.
const expandHome = (p, home) => (typeof home === 'string' && home !== '' && (p === '~' || p.startsWith('~/')) ? path.join(home, p.slice(1)) : p);

export function scanToolReason({ tool, input, cwd, roots, home, resolve = path.resolve } = {}) {
  if (!usable(roots) || (tool !== 'Read' && tool !== 'Grep' && tool !== 'Glob')) return null;
  const base = typeof cwd === 'string' && cwd ? cwd : process.cwd();
  const given = input && typeof input === 'object' ? input : {};
  const targets = [];
  if (tool === 'Read') {
    if (typeof given.file_path === 'string' && given.file_path !== '') targets.push(expandHome(given.file_path, home));
  } else {
    let dir = null;
    if (given.path === undefined || given.path === null) dir = base;
    else if (typeof given.path === 'string' && given.path !== '') dir = path.resolve(base, expandHome(given.path, home));
    if (dir !== null) targets.push(dir);
    if (tool === 'Glob' && typeof given.pattern === 'string' && given.pattern !== '') {
      targets.push(path.resolve(dir ?? base, literalPrefix(expandHome(given.pattern, home))));
    }
  }
  if (targets.length === 0) return null;
  const rootForms = forms(roots, resolve);
  for (const target of targets) {
    const lexical = path.resolve(base, target);
    if (!allowed(lexical, rootForms, resolve)) return toolReason(tool, lexical);
  }
  return null;
}

// The folders a story session may search or read, from the project, its config and the session's
// environment (the hook's one call; pure, so a test can give it any folders).
export function sessionScanRoots({ anchor, config, env = {}, homedir, tmpdir, pluginRoot } = {}) {
  return scanRoots({
    anchor,
    stateDirPath: stateDir(anchor, config, env),
    home: env.HOME || homedir,
    claudeConfigDir: env.CLAUDE_CONFIG_DIR,
    tmpDirs: [tmpdir, '/tmp'],
    pluginRoot,
  });
}
