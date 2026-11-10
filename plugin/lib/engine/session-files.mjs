// The files Claude Code keeps for one story session, read for each agent's tokens and then
// removed. Story sessions run with persistence on (session.mjs), so Claude Code writes, under
// <CLAUDE_CONFIG_DIR or ~/.claude>/projects/<encoded cwd>/:
//
//   <sessionId>.jsonl     the session's own transcript
//   <sessionId>/          its subagents (subagents/workflows/<wf>/agent-<id>.jsonl with
//                         agent-<id>.meta.json beside each, or subagents/agent-<id>.jsonl for a
//                         plain Agent-tool subagent), journal.jsonl, tool-results/ and so on
//
//   claudeProjectsDir(env, home)   that projects folder
//   sessionProjectsDir(env, home)  where Claude Code writes for a session started with `env`:
//                                  its CLAUDE_CONFIG_DIR, else its own HOME's .claude, else home's
//   sessionPaths(projects, id)     the two entries above in every project folder, for an id
//                                  shaped as a session UUID only; never the projects folder, a
//                                  project folder, or anything through a symlinked one
//   readSubagents(paths, read)     [{ meta, text }] for every agent-*.jsonl under <id>/subagents,
//                                  through real folders only, never a symlinked subagents folder
//                                  (meta {} when its .meta.json is missing or bad)
//   findAgentTranscript(paths, id) the agent-<id>.jsonl under <path>/subagents, through real
//                                  folders only (never a symlink), for an id shaped as AGENT_ID,
//                                  else null; for the command centre's conversation view
//   sessionTranscript(paths, id)   the session's own <id>.jsonl among `paths` when it is a regular
//                                  file (not a symlink), else null
//   readModel(file, { max })       the model of the first real assistant line in the first `max`
//                                  bytes (2 MB; api-request lines are skipped unparsed), else
//                                  null; never throws
//   isProjectsDir(path)           whether it is an absolute path to a folder named `projects`
//   markedProjects(mark, log)      the mark's projects folder when the mark's log is `log` and the
//                                  folder passes isProjectsDir, else null; never throws
//   markedSession(dir, slot)       { sessionId, projects, paths } of the session a slot's mark
//                                  names (its log inside <dir>/logs, a projects path that is an
//                                  absolute path to a folder named `projects`, a session id read
//                                  from the log's first 64 KB), else null
//   removeSessionFiles(paths)      removes them; returns what it removed
//   collectSessionTokens({ logText, projects, read, record, keep, withSubagents })
//                                  { agents, removed, kept }: the session's id from its log, the
//                                  agents' tokens (tokens.mjs storyAgents) when record is on,
//                                  then the files removed whatever happened. agents is null
//                                  when record is off, the log has no session id, or reading
//                                  failed. With keep (a session that ended in an interrupt, so
//                                  its transcripts can be read for the cause) nothing is removed
//                                  and kept lists the files; otherwise kept is []. With
//                                  withSubagents it also gives `subagents`, readSubagents' list
//                                  read once before the removal, record on or off ([] when the
//                                  log has no session id, null when a transcript cannot be
//                                  read), for the checkpoint (checkpoint.mjs).
//
// The marks: while a session runs, the supervisor keeps one machine-local mark per slot at
// <stateDir>/session-files/<slot>.json, { story, pid, log, projects, keep }, naming where its
// files are, so a session whose ending was never handled (the supervisor died first) does not
// leave its transcripts behind. The folder is not on the state branch (state-store/branch.mjs).
//
//   MARKS(dir)                     that folder
//   markSession(dir, slot, { story, pid, log, projects })
//                                  writes the slot's mark (atomically), keep false; throws for a
//                                  slot that is not w<n>. An existing mark of another pid is moved
//                                  to <slot>-<pid>.json first, so the start-up sweep still covers a
//                                  session from an earlier run
//   readMark(dir, slot)            the mark, or null when it is missing, bad JSON or not an object
//   keepMark(dir, slot)            sets keep on an existing mark (the session is being
//                                  interrupted, so its files stay to be read); no mark, nothing
//   unmarkSession(dir, slot)       removes the mark
//   sweepSessionFiles({ dir, skip, alive, read })
//                                  at start: for each w<n>.json and kept-aside w<n>-<pid>.json mark,
//                                  unless the slot is in skip (which covers only w<n>.json) or
//                                  alive({ pid, id: story }) says the session still runs, removes
//                                  the session's files (the id read from its log) or, with keep,
//                                  leaves them and lists them as kept, then removes that mark file
//                                  only. A mark whose projects is not an absolute path to a folder
//                                  named `projects`, whose log is not inside <dir>/logs (real
//                                  paths), or whose log cannot be read is only removed. One
//                                  mark's error does not stop the others. Returns
//                                  [{ slot, story, removed, kept }] for the marks it handled, with
//                                  error: message on one that failed.

import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { readSessionLog } from './session-log.mjs';
import { storyAgents } from './tokens.mjs';

export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const AGENT_FILE = /^agent-.+\.jsonl$/;
const SLOT = /^w[1-9]\d*$/;
const MARK_FILE = /^(w[1-9]\d*)(?:-([1-9]\d*))?\.json$/;

export const claudeProjectsDir = (env = process.env, home = homedir()) => join(env?.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects');
export const sessionProjectsDir = (env, home = homedir()) => claudeProjectsDir(env, env?.HOME || home);
// Every folder Foreman writes into a mark comes from the two above, so it ends in `projects`.
export const isProjectsDir = (p) => typeof p === 'string' && isAbsolute(p) && basename(p) === 'projects';

const exists = (path) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

const isDir = (path) => {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
};

export function sessionPaths(projects, sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return [];
  let entries;
  try {
    entries = readdirSync(projects, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const d of entries) {
    // A Dirent describes the entry itself, so a symlinked folder is not a directory here.
    if (!d.isDirectory()) continue;
    const dir = join(projects, d.name);
    for (const p of [join(dir, `${sessionId}.jsonl`), join(dir, sessionId)]) {
      const parts = relative(projects, p).split(sep);
      if (parts.length !== 2 || parts.includes('..') || parts.some((x) => !x)) continue;
      if (exists(p)) out.push(p);
    }
  }
  return out;
}

// Every agent-*.jsonl under `dir`, through real folders only.
function agentFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const d of entries) {
    if (d.isSymbolicLink()) continue;
    const p = join(dir, d.name);
    if (AGENT_FILE.test(d.name)) out.push(p);
    else if (d.isDirectory()) out.push(...agentFiles(p));
  }
  return out;
}

export function readSubagents(paths, read = readFileSync) {
  const subagents = [];
  for (const p of paths ?? []) {
    if (!isDir(p)) continue;
    // isDir looks at the entry itself, so a symlinked subagents folder is never read.
    const sub = join(p, 'subagents');
    if (!isDir(sub)) continue;
    for (const file of agentFiles(sub)) {
      let meta = {};
      try {
        const m = JSON.parse(read(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
        if (m && typeof m === 'object' && !Array.isArray(m)) meta = m;
      } catch {
        meta = {};
      }
      // A transcript that cannot be read throws: the caller records the agents as unknown.
      subagents.push({ meta, text: String(read(file, 'utf8')) });
    }
  }
  return subagents;
}

// The file `agent-<id>.jsonl` under `paths`' subagents folders (the same walk as readSubagents),
// or null. The id is checked first, so nothing the caller sends is ever part of a path.
export function findAgentTranscript(paths, agentId) {
  if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) return null;
  const want = `agent-${agentId}.jsonl`;
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const d of entries) {
      if (d.isSymbolicLink()) continue;
      const p = join(dir, d.name);
      if (d.name === want && d.isFile()) return p;
      if (d.isDirectory()) {
        const found = walk(p);
        if (found) return found;
      }
    }
    return null;
  };
  for (const p of paths ?? []) {
    if (!isDir(p)) continue;
    const sub = join(p, 'subagents');
    if (!isDir(sub)) continue;
    const found = walk(sub);
    if (found) return found;
  }
  return null;
}

export function sessionTranscript(paths, sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return null;
  for (const p of paths ?? []) {
    if (basename(p) !== `${sessionId}.jsonl`) continue;
    try {
      if (lstatSync(p).isFile()) return p;
    } catch {
      // gone since it was listed
    }
  }
  return null;
}

const MODEL_MAX = 2 * 1024 * 1024;
const CHUNK = 256 * 1024;

export function readModel(file, { max = MODEL_MAX } = {}) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(CHUNK);
    const decoder = new StringDecoder('utf8');
    let rest = '';
    let at = 0;
    const model = (text) => {
      if (!text.startsWith('{') || text.startsWith('{"type":"api-request')) return null;
      try {
        const e = JSON.parse(text);
        const m = e?.type === 'assistant' ? e.message?.model : null;
        return typeof m === 'string' && m !== '' && m !== '<synthetic>' ? m : null;
      } catch {
        return null;
      }
    };
    while (at < max) {
      const n = readSync(fd, buf, 0, Math.min(CHUNK, max - at), at);
      if (n <= 0) break;
      at += n;
      const lines = (rest + decoder.write(buf.subarray(0, n))).split('\n');
      rest = lines.pop();
      for (const l of lines) {
        const m = model(l);
        if (m) return m;
      }
    }
    // The last line counts when the file ended there (a cut at `max` fails to parse and is skipped).
    return model(rest + decoder.end());
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function removeSessionFiles(paths) {
  const removed = [];
  for (const p of paths ?? []) {
    rmSync(p, { recursive: true, force: true });
    removed.push(p);
  }
  return removed;
}

export function collectSessionTokens({ logText, projects, read = readFileSync, record = true, keep = false, withSubagents = false } = {}) {
  const log = readSessionLog(logText);
  const paths = sessionPaths(projects, log.sessionId);
  let agents = null;
  let subagents = [];
  let removed = [];
  try {
    if ((record || withSubagents) && SESSION_ID.test(log.sessionId ?? '')) {
      subagents = readSubagents(paths, read);
      if (record) agents = storyAgents({ subagents, total: log.tokens, model: log.model });
    }
  } catch {
    agents = null;
    // Unknown, not none: the checkpoint then leaves the tree unknown too.
    subagents = null;
  } finally {
    if (!keep) removed = removeSessionFiles(paths);
  }
  return { agents, ...(withSubagents ? { subagents } : {}), removed, kept: keep ? paths : [] };
}

export const MARKS = (dir) => join(dir, 'session-files');
const markFile = (dir, slot) => {
  if (!SLOT.test(String(slot))) throw new Error(`There is no slot ${slot}.`);
  return join(MARKS(dir), `${slot}.json`);
};

function writeMark(dir, slot, mark) {
  const file = markFile(dir, slot);
  mkdirSync(MARKS(dir), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(mark)}\n`);
  renameSync(tmp, file);
}

export function markSession(dir, slot, { story, pid, log, projects }) {
  // A mark of another session is kept aside, so the start-up sweep still covers that session.
  const old = readMark(dir, slot);
  if (Number.isSafeInteger(old?.pid) && old.pid > 0 && old.pid !== pid) {
    try {
      renameSync(markFile(dir, slot), join(MARKS(dir), `${slot}-${old.pid}.json`));
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }
  writeMark(dir, slot, { story, pid, log, projects, keep: false });
}

function readMarkFile(file) {
  try {
    const m = JSON.parse(readFileSync(file, 'utf8'));
    return m && typeof m === 'object' && !Array.isArray(m) ? m : null;
  } catch {
    return null;
  }
}

export function readMark(dir, slot) {
  try {
    return readMarkFile(markFile(dir, slot));
  } catch {
    return null;
  }
}

// The mark's projects folder when the mark is the one for `log` and the folder is a Claude
// projects folder, else null. Never throws.
export function markedProjects(mark, log) {
  return mark && typeof mark === 'object' && mark.log === log && isProjectsDir(mark.projects) ? mark.projects : null;
}

export function keepMark(dir, slot) {
  const m = readMark(dir, slot);
  if (m) writeMark(dir, slot, { ...m, keep: true });
}

export function unmarkSession(dir, slot) {
  rmSync(markFile(dir, slot), { force: true });
}

// Whether `log` is a file inside <dir>/logs, so a mark can never point the sweep elsewhere. Real
// paths on both sides: the same folder spelt through a symlink counts, a symlink out of it does
// not. A log that is not there is not inside.
function inLogs(dir, log) {
  if (typeof log !== 'string' || !log) return false;
  try {
    const rel = relative(realpathSync(resolve(dir, 'logs')), realpathSync(resolve(log)));
    return Boolean(rel) && !isAbsolute(rel) && rel.split(sep)[0] !== '..';
  } catch {
    return false;
  }
}

const LOG_HEAD = 64 * 1024;

// The session a slot's mark names, or null: where its files are and the id from its log's init
// event. Only a log inside <dir>/logs is read, and only its first 64 KB.
export function markedSession(dir, slot) {
  try {
    const m = readMark(dir, slot);
    if (!m || !isProjectsDir(m.projects) || !inLogs(dir, m.log)) return null;
    const fd = openSync(m.log, 'r');
    let head;
    try {
      const buf = Buffer.alloc(LOG_HEAD);
      head = buf.toString('utf8', 0, readSync(fd, buf, 0, LOG_HEAD, 0));
    } finally {
      closeSync(fd);
    }
    const sessionId = readSessionLog(head).sessionId;
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return null;
    return { sessionId, projects: m.projects, paths: sessionPaths(m.projects, sessionId) };
  } catch {
    return null;
  }
}

export function sweepSessionFiles({ dir, skip = [], alive, read = readFileSync }) {
  let entries;
  try {
    entries = readdirSync(MARKS(dir), { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const d of entries) {
    const found = d.isFile() ? MARK_FILE.exec(d.name) : null;
    if (!found) continue;
    const [, slot, parked] = found;
    // skip names a slot's current session, so it never covers a mark kept aside.
    if (!parked && skip.includes(slot)) continue;
    const file = join(MARKS(dir), d.name);
    const m = readMarkFile(file);
    const entry = { slot, story: m?.story ?? null, removed: [], kept: [] };
    try {
      if (m && alive({ pid: m.pid, id: m.story })) continue;
      out.push(entry);
      if (!m || !isProjectsDir(m.projects) || !inLogs(dir, m.log)) {
        rmSync(file, { force: true });
        continue;
      }
      let text;
      try {
        text = String(read(m.log, 'utf8'));
      } catch {
        rmSync(file, { force: true });
        continue;
      }
      const paths = sessionPaths(m.projects, readSessionLog(text).sessionId);
      if (m.keep === true) entry.kept = paths;
      else entry.removed = removeSessionFiles(paths);
      rmSync(file, { force: true });
    } catch (err) {
      entry.error = String(err?.message ?? err);
      if (!out.includes(entry)) out.push(entry);
    }
  }
  return out;
}
