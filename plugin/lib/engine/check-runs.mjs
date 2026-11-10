// What `foreman checks` ran, kept in <stateDir>/check-runs.jsonl so a check is run once per tree
// and its result shared (cli/commands/checks.mjs, `--reuse`). One line per real run:
//
//   { at, story, slot, run, full, tree, exit, ms, tail, env }
//
// and, for a run of the check's `quick` command (`foreman checks --quick`):
//
//   { at, story, slot, run, quick: true, cmd, full, tree, exit, ms, tail, env }
//
// where `run` is still the check's own `run`, which names the check, and `cmd` the quick command
// that ran. A quick run is never reused and never reuses anything: findCheckRun skips it, so
// `--reuse`, a wait on a claim and merge-main only ever see full runs.
//
// One line per reuse of a record:
//
//   { at, story, slot, run, full, tree, reused: true, from }
//
// A reuse line may also carry `waited: true` (the run was in progress in another slot and this one
// waited for its result, checks.mjs) or `by: 'merge-main'` (the ship step reused it).
//
// and one line per hand run of a check the Bash guard denied (hooks/agent-events.mjs):
//
//   { at, story, slot, run, full, denied: true }
//
// `story` and `slot` are FOREMAN_STORY and FOREMAN_SLOT, null outside a story session. `full` is
// true for a check whose `when` is "always" (the full suite). `tree` is treeHash's id of the
// working tree the check ran on, `exit` its exit code, `ms` how long it took, `tail` the last
// lines of its output with secrets blanked (outputTail), `from` the `at` of the record a reuse
// printed, and `env` which environment the check ran in: 'session' for the story session's own
// (session-env.mjs), 'caller' for the calling shell's. The file is a cache local to this machine:
// it is not kept on the state branch. In a run it sits in the anchor's state folder, shared by
// every slot. A record made under the session env is what the reviewers, the commit and
// merge-main reuse: a check run in that env does not depend on what an agent set in its shell
// (PATH, NODE_OPTIONS and the like). Only the session env counts, so findCheckRun skips every line
// without env 'session', old lines included. The anchor guard (anchor-files.mjs protectedFiles)
// denies the plain ways an agent could write the file or the env file, but it is a blocklist and
// best effort, which is the protection this relies on.
//
//   treeHash({ cwd, sh }) -> the tree id of the working tree, or null
//   outputTail(text, { env, secrets }) -> the last 30 lines, at most 3000 characters, redacted
//   recordCheckRun(stateDirPath, entry, { maxBytes }) appends a line, and refuses a link or a
//       file that is not a regular file
//   readCheckRuns(stateDirPath) -> the lines, oldest first
//   findCheckRun(entries, { run, tree }) -> the newest real full run of `run` on `tree` made under
//       the session env (a quick run, a reuse and a denied line are skipped), or null. The key is
//       the run plus the tree, never the folder the check ran in.
//   TREE_ID -> the pattern a tree id matches
//   checkTotals(entries, { since, runs }) -> full-suite runs and minutes, quick runs and minutes
//       (counted apart, never in the full-suite figures), reuses, waits on a run in progress,
//       denied hand runs and rounds per story
//
// outputTail, findCheckRun and checkTotals are pure; the others touch the disk.
// `foreman report` (cli/commands/report.mjs) prints checkTotals.

import { spawnSync } from 'node:child_process';
import { closeSync, constants, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { redact } from '../secrets/redact.mjs';
import { redact as redactLooksSecret } from './state.mjs';

export const CHECK_RUNS_FILE = 'check-runs.jsonl';
export const checkRunsPath = (stateDirPath) => join(stateDirPath, CHECK_RUNS_FILE);

const TAIL_LINES = 30;
const TAIL_CHARS = 3000;
const MAX_BYTES = 4 * 1024 * 1024;
export const TREE_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

const defaultSh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });

// The tree the working tree would commit as: tracked, staged, unstaged and untracked files that
// are not ignored. It stages everything into a copy of the index in a temp folder, so the real
// index and the files are never touched; the copy keeps git's stat cache, so this stays fast. A
// clean checkout of commit C hashes to C^{tree}, the same in every worktree. Null when cwd is not
// in a git repo, is missing, or git fails.
export function treeHash({ cwd, sh = defaultSh } = {}) {
  if (typeof cwd !== 'string' || cwd === '' || !existsSync(cwd)) return null;
  let tmp = null;
  try {
    const at = sh('git', ['rev-parse', '--git-path', 'index'], { cwd });
    if (at.status !== 0) return null;
    const realIndex = resolve(cwd, String(at.stdout).trim());
    tmp = mkdtempSync(join(tmpdir(), 'foreman-tree-'));
    const index = join(tmp, 'index');
    if (existsSync(realIndex)) copyFileSync(realIndex, index);
    const env = { ...process.env, GIT_INDEX_FILE: index };
    if (sh('git', ['add', '-A'], { cwd, env }).status !== 0) return null;
    const tree = sh('git', ['write-tree'], { cwd, env });
    if (tree.status !== 0) return null;
    const id = String(tree.stdout).trim();
    return TREE_ID.test(id) ? id : null;
  } catch {
    return null;
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

// The output's last lines, with each secret value (longest first), the env's known secrets and
// the token-shaped text blanked before it is cut.
export function outputTail(text, { env = {}, secrets = [] } = {}) {
  const longestFirst = [...secrets].filter((s) => typeof s === 'string' && s !== '').sort((a, b) => b.length - a.length);
  const clean = redactLooksSecret(redact(String(text ?? ''), { env, values: longestFirst }));
  const tail = clean.replace(/\s+$/, '').split(/\r?\n/).slice(-TAIL_LINES).join('\n');
  return tail.length > TAIL_CHARS ? tail.slice(-TAIL_CHARS) : tail;
}

// Over maxBytes the file is first cut to its newest half of whole lines, through a temp file in a
// fresh folder (a name nobody can predict) renamed into place. Slots append at the same time
// without a lock: a line lost to a race with the cut is only a cache miss, and the check runs
// again. It refuses to write through a link or onto anything but a regular file (a folder, a
// FIFO), and throws, which the callers report as "could not record". Throws too when the folder
// or file cannot be written.
export function recordCheckRun(stateDirPath, entry, { maxBytes = MAX_BYTES } = {}) {
  mkdirSync(stateDirPath, { recursive: true });
  const file = checkRunsPath(stateDirPath);
  const notRegular = () => new Error(`${file} is not a regular file; not written`);
  let size = 0;
  try {
    const st = lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile()) throw notRegular();
    size = st.size;
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  if (size > maxBytes) {
    const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
    const kept = lines.slice(Math.floor(lines.length / 2));
    const tmpDir = mkdtempSync(join(stateDirPath, '.check-runs-'));
    try {
      const tmp = join(tmpDir, CHECK_RUNS_FILE);
      writeFileSync(tmp, kept.length ? `${kept.join('\n')}\n` : '', { flag: 'wx' });
      renameSync(tmp, file);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
  const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o666);
  try {
    if (!fstatSync(fd).isFile()) throw notRegular();
    writeSync(fd, `${JSON.stringify(entry)}\n`);
  } finally {
    closeSync(fd);
  }
}

export function readCheckRuns(stateDirPath) {
  let text;
  try {
    text = readFileSync(checkRunsPath(stateDirPath), 'utf8');
  } catch {
    return [];
  }
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e === 'object' && !Array.isArray(e)) entries.push(e);
    } catch {
      // half written, or not ours
    }
  }
  return entries;
}

export function findCheckRun(entries, { run, tree }) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || typeof e !== 'object' || e.reused === true || e.denied === true || e.quick === true) continue;
    if (e.env === 'session' && e.run === run && e.tree === tree && Number.isInteger(e.exit) && typeof e.at === 'string') return e;
  }
  return null;
}

const dayOf = (at) => {
  const t = Date.parse(at);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
};

// Per story with a string id, from `since` (YYYY-MM-DD, UTC day) on, the full-suite lines only:
// the real runs, their minutes, the reuses and the waits on a run in progress (a reuse line with
// waited: true counts in `waited`, not in `reused`), and the hand runs denied (a denied line counts,
// full or not, toward `denied` only); `rounds` is the build rounds of the story's run
// records (run-record.mjs readRuns) that ended from `since` on, or null when it has none.
export function checkTotals(entries, { since = '', runs = [] } = {}) {
  const inRange = (at) => !since || (dayOf(at) ?? '') >= since;
  const byStory = new Map();
  for (const e of entries ?? []) {
    if (!e || typeof e !== 'object' || typeof e.story !== 'string' || !inRange(e.at)) continue;
    if (e.full !== true && e.denied !== true) continue;
    const t = byStory.get(e.story) ?? { story: e.story, fullRuns: 0, ms: 0, quickRuns: 0, quickMs: 0, reused: 0, waited: 0, denied: 0 };
    if (e.denied === true) t.denied++;
    else if (e.quick === true) {
      t.quickRuns++;
      t.quickMs += Number(e.ms) || 0;
    }
    else if (e.reused === true && e.waited === true) t.waited++;
    else if (e.reused === true) t.reused++;
    else {
      t.fullRuns++;
      t.ms += Number(e.ms) || 0;
    }
    byStory.set(e.story, t);
  }
  return [...byStory.values()]
    .sort((a, b) => a.story.localeCompare(b.story, 'en', { numeric: true }))
    .map(({ story, fullRuns, ms, quickRuns, quickMs, reused, waited, denied }) => {
      const mine = (runs ?? []).filter((r) => r?.story === story && inRange(r.endedAt));
      const rounds = mine.length ? mine.reduce((n, r) => n + (Number(r.rounds) || 0), 0) : null;
      return { story, fullRuns, minutes: Math.round(ms / 6000) / 10, quickRuns, quickMinutes: Math.round(quickMs / 6000) / 10, reused, waited, denied, rounds };
    });
}
