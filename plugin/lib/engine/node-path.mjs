// Which Node the supervisor's children run on, and whether this process's own Node still starts.
//
// On a Homebrew install process.execPath is the versioned keg
// (<prefix>/Cellar/node/26.9.0/bin/node). `brew upgrade` can leave that Node unable to load a
// library it needs (simdjson, say), or remove it, while the supervisor keeps running: every
// child it starts, and its own restart, would then fail. This module finds a Node that starts,
// so the children and the next process use it, and says in plain words when none does. Pure
// apart from the `sh` and `fs` passed in.
//
//   PROBE_MS = 10 s       the limit on one `node --version`
//   NODE_CHECK_MS = 60 s  how often nodeWatch checks again
//   loadErrorLine(text)   the first line of `text`, trimmed and cut to 300 characters, that is a
//                         library load error (the macOS dyld "Library not loaded", or Linux
//                         ld.so "error while loading shared libraries"), else null
//   homebrewLink(execPath)
//                         <prefix>/bin/node, Homebrew's link that an upgrade keeps, when execPath
//                         is a Cellar path (service.mjs CELLAR_NODE), else null
//   pathNode(env, fs)     the first <dir>/node that exists in the absolute folders of env.PATH,
//                         else null
//   nodeCandidates({ execPath, serviceNode?, env, fs })
//                         the Nodes to try, best first: the Node the background service starts,
//                         Homebrew's link, the PATH node, then execPath; no empty entry, no repeat
//   spawnSh(run = spawnSync)
//                         a (cmd, args, opts) -> { status, signal, stdout, stderr, error } over
//                         `run`, with utf8 text and piped output; `error` is the message of a
//                         spawn error. The supervisor passes heldSpawnSync.
//   probeNode(node, sh)   runs `<node> --version` within PROBE_MS: { ok: true, node, version }, or
//                         { ok: false, node, cause } where cause is, in this order, the load
//                         error line, "could not start (<error>)", "killed by <signal>", or
//                         "exit <status>"
//   chooseNode({ execPath, serviceNode?, env, fs, sh })
//                         probes the candidates in order: { ok: true, node, version, tried } for
//                         the first that starts, else { ok: false, node: execPath, version: null,
//                         tried }; tried is [{ node, cause }] for each probe that failed
//   likelyHomebrew(node, cause)
//                         whether the path or the cause points at Homebrew (/Cellar/ or "homebrew")
//   childNodeText(what, { node, cause })
//                         "<what>: Node (<node>) could not start: <cause>. This is a problem with
//                         this computer's set-up, not with a story" plus, when likely, a note
//                         that Homebrew probably upgraded Node or a library it needs, and a
//                         pointer to `foreman doctor`. For a child that failed on a load error.
//   serviceNodeOf({ config, root, dir, env, fs, platform?, home?, uid? })
//                         the Node the installed background service starts, else null; it only
//                         reads files and never throws
//   nodeWatch({ execPath, serviceNode?, env, fs, sh, now?, everyMs? })
//                         { node(), check({ force }?) -> { event }, broken() }
//       node()    the Node the last check chose, or execPath before the first
//       check()   does nothing until everyMs has passed since the last check, unless forced. It
//                 probes execPath, then runs chooseNode. A failure whose cause is not a load
//                 error or a missing file (a timeout under load, say) counts only when the next
//                 check fails as well; a Node that resolves to the same file as execPath
//                 (Homebrew's link to the keg) counts as execPath answering. When execPath does
//                 not start and another Node does, broken() becomes
//                 { id: 'node', from, to, version, cause } and the check returns one warn event,
//                 only on that first finding; broken() stays set (the process is about to
//                 restart). When no Node starts, the check returns one warn event, logged again
//                 only after a check has found a working Node in between, and broken() stays
//                 null, because a restart would fail.
//   restartFor({ code, node, stopping, accepts })
//                         which restart applies: the pending code restart first, with the check
//                         `accepts` and its text "Restarted on new code (<from> -> <to>).", else
//                         the Node one (not while stopping), whose check always passes, else null.
//                         Both are { pending, check, text }.

import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { CELLAR_NODE, openService } from './service.mjs';

export const PROBE_MS = 10_000;
export const NODE_CHECK_MS = 60_000;

const LOAD_ERROR = /Library not loaded|error while loading shared libraries/;
const LINE_MAX = 300;

export function loadErrorLine(text) {
  const line = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => LOAD_ERROR.test(l));
  return line === undefined ? null : line.slice(0, LINE_MAX);
}

export function homebrewLink(execPath) {
  const prefix = String(execPath ?? '').match(CELLAR_NODE)?.[1];
  return prefix === undefined ? null : `${prefix}/bin/node`;
}

export function pathNode(env, fs) {
  for (const dir of String(env?.PATH ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const node = path.join(dir, 'node');
    if (fs.existsSync(node)) return node;
  }
  return null;
}

export function nodeCandidates({ execPath, serviceNode = null, env, fs }) {
  const all = [serviceNode, homebrewLink(execPath), pathNode(env, fs), execPath].filter(Boolean);
  return [...new Set(all)];
}

export const spawnSh = (run = spawnSync) => (cmd, args = [], opts = {}) => {
  const r = run(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  return {
    status: r.status ?? null,
    signal: r.signal ?? null,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    error: r.error ? String(r.error.message ?? r.error) : undefined,
  };
};

export function probeNode(node, sh) {
  const r = sh(node, ['--version'], { timeout: PROBE_MS }) ?? {};
  if (r.status === 0 && !r.error) return { ok: true, node, version: String(r.stdout ?? '').trim() };
  const cause = loadErrorLine(r.stderr) ?? (r.error ? `could not start (${r.error})` : r.signal ? `killed by ${r.signal}` : `exit ${r.status}`);
  return { ok: false, node, cause };
}

export function chooseNode({ execPath, serviceNode = null, env, fs, sh }) {
  const tried = [];
  for (const node of nodeCandidates({ execPath, serviceNode, env, fs })) {
    const p = probeNode(node, sh);
    if (p.ok) return { ok: true, node, version: p.version, tried };
    tried.push({ node, cause: p.cause });
  }
  return { ok: false, node: execPath, version: null, tried };
}

export const likelyHomebrew = (node, cause) => /\/Cellar\/|homebrew/i.test(String(node)) || /\/Cellar\/|homebrew/i.test(String(cause));

export function childNodeText(what, { node, cause }) {
  const brew = likelyHomebrew(node, cause) ? '; Homebrew probably upgraded Node or a library it needs' : '';
  return `${what}: Node (${node}) could not start: ${cause}. This is a problem with this computer's set-up, not with a story${brew}. \`foreman doctor\` checks it.`;
}

// installed() and info() only read files, so the service manager is never called.
const NO_SH = () => ({ status: 1, stdout: '', stderr: '' });

export function serviceNodeOf({ config, root, dir, env, fs, platform = process.platform, home = os.homedir(), uid = process.getuid?.() }) {
  try {
    const svc = openService({ platform, home, uid, env, sh: NO_SH, fs, config, root, dir });
    return svc?.installed() ? (svc.info()?.node ?? null) : null;
  } catch {
    return null;
  }
}

// The same file: equal paths, or paths that resolve to one file (Homebrew's link and its keg).
// A path that cannot be resolved (a removed keg, a fake fs) stands for itself.
function sameNode(a, b, fs) {
  const real = (p) => {
    try {
      return fs.realpathSync?.(p) ?? p;
    } catch {
      return p;
    }
  };
  return a === b || real(a) === real(b);
}

// A cause that proves the Node itself is broken: a library that will not load, or a binary that
// is gone. A timeout, a kill or an exit code can be load or chance.
const brokenCause = (cause) => loadErrorLine(cause) !== null || /\bENOENT\b/.test(String(cause));

export function nodeWatch({ execPath, serviceNode = null, env, fs, sh, now = Date.now, everyMs = NODE_CHECK_MS }) {
  let chosen = execPath;
  let lastAt = null;
  let broken = null;
  let noneLogged = false;
  let suspect = false;

  function check({ force = false } = {}) {
    const at = now();
    if (!force && lastAt !== null && at - lastAt < everyMs) return { event: null };
    lastAt = at;
    // Found already: the process is about to restart onto it.
    if (broken) return { event: null };
    const self = probeNode(execPath, sh);
    if (self.ok) {
      chosen = execPath;
      noneLogged = false;
      suspect = false;
      return { event: null };
    }
    if (!brokenCause(self.cause) && !suspect) {
      // The first strike: this may be load or chance. Decide at the next check.
      suspect = true;
      return { event: null };
    }
    const c = chooseNode({ execPath, serviceNode, env, fs, sh });
    if (c.ok && sameNode(c.node, execPath, fs)) {
      // It answered this time, or is the same file: it was not down.
      chosen = execPath;
      noneLogged = false;
      suspect = false;
      return { event: null };
    }
    if (c.ok) {
      chosen = c.node;
      broken = { id: 'node', from: execPath, to: c.node, version: c.version, cause: self.cause };
      const brew = likelyHomebrew(execPath, self.cause) ? ' Homebrew probably upgraded Node or a library it needs.' : '';
      const text = `This supervisor's Node (${execPath}) no longer starts: ${self.cause}.${brew} Foreman's commands now use ${c.node}${c.version ? ` (${c.version})` : ''}, and the run restarts onto it as soon as the slots being set up are ready; the stories in progress keep running.`;
      return { event: { text, kind: 'warn' } };
    }
    chosen = execPath;
    if (noneLogged) return { event: null };
    noneLogged = true;
    const tried = c.tried.map((t) => `${t.node}: ${t.cause}`).join('; ');
    const text = `No Node on this computer starts (${tried}); Foreman's commands will fail until Node is repaired (\`brew reinstall node\` with Homebrew). \`foreman doctor\` checks it.`;
    return { event: { text, kind: 'warn' } };
  }

  return { node: () => chosen, check, broken: () => broken };
}

export function restartFor({ code, node, stopping, accepts }) {
  if (code) return { pending: code, check: accepts, text: `Restarted on new code (${code.from} -> ${code.to}).` };
  if (node && !stopping) {
    return { pending: node, check: () => ({ ok: true }), text: `Restarted onto Node ${node.to}${node.version ? ` (${node.version})` : ''}: ${node.from} no longer starts.` };
  }
  return null;
}
