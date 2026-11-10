// The branch state store (config `state.store: "branch"`): the state folder is a git worktree
// of an orphan branch (`state.branch`, default foreman-state) that holds only Foreman's run
// state, so a laptop and a cloud runner share one copy through the project's remote.
//
//   ensureStateWorktree({ root, stateDir, branch, remote, sh })
//       makes the state folder that worktree. The first clone to use it creates the branch,
//       with no history shared with the project, and pushes it. Files already in the state
//       folder are moved into the worktree once; a file the branch already has keeps the
//       branch's copy, and the local one is left in <stateDir>.local-<stamp>.
//   syncState({ ...same, direction: 'pull' | 'push', message, writes, sleep })
//       pull: commit local state changes, fetch, rebase onto the remote.
//       push: commit local state changes as `message`, push. A rejected push fetches and
//       rebases again; when the rebase conflicts, the remote's copy is taken and this
//       process's own writes (`writes`, else what its unpushed commits changed) are put back
//       on top. Up to 5 tries, with a short jittered wait (`sleep`) between them.
//   changedFiles({ stateDir, sh })   the state files changed since the last commit: path ->
//       content, or null for a deleted file. After a pull these are this process's writes.
//
// Only committable() paths are ever staged: claims, locks (file locks included), file waits, decisions, story overlays, parked
// releases, the learn ledger and findings, the learning ledger and learned items with their
// history (learning.jsonl, learned/), the learner's spend (learner.jsonl), control, settings, run records, the supervisor's
// state, who stopped the run (STOP, last-stop), and which Claude sign-in the sessions use (claude-signin.json, never a key). Logs, slot worktrees, raw console copies, the lessons scan (lessons.json), caches and temp files stay on this machine;
// the branch's own .gitignore keeps them out of `git status` too. A file holding something
// that looks like a token is never committed (it is reported in `refused`).
//
// Git runs with hooks off and signing off, as the project's user, or as "Foreman" when the
// machine has no git identity (a fresh cloud runner). Syncs on one machine take turns through
// a lock in the project's git folder.

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { matchesGlob } from '../engine/glob.mjs';
import { breakIfStale, release, take } from '../engine/locks.mjs';

export const TRIES = 5;

// What may be committed, as globs relative to the state folder.
const KEEP = [
  '.gitignore',
  '.gitattributes',
  'state.json',
  'control.json',
  'settings.json',
  'learn.json',
  'schema-stories.json',
  'events.jsonl',
  'findings.jsonl',
  'STOP',
  'last-stop',
  'HALT',
  'decisions/*.json',
  'claims/*.json',
  'locks/*.json',
  'stories/*.json',
  'parks/*.json',
  'stories/new/*.md',
  'runs/*.json',
  'slots/*.json',
  'jira-outbox/*.json',
  'waits/*.json',
  'learning.jsonl',
  'learner.jsonl',
  'learned/**',
  'claude-signin.json',
];

const SECRET_NAME = /^(\.env.*|.*\.(pem|key|p12|pfx)|id_(rsa|dsa|ecdsa|ed25519).*|(credentials|secrets?|tokens?)(\.[a-z]+)?)$/i;
export const SECRET_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{36,}/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/,
  /\bsk_live_[A-Za-z0-9]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export const GITIGNORE = `# Foreman's state branch keeps only small state files. These stay on each machine.
logs/
worktrees/
sync/
jira/
session-config/
briefs/
outbox/
/stories/*.md
slots/*/
slots/*.install
status.json
sync.log
*.tmp
*.log
*.lock
.env*
*.pem
*.key
`;

// Lines appended from two machines both survive a rebase.
export const GITATTRIBUTES = '*.jsonl merge=union\n';

/** True when `path` (relative to the state folder, `/`-separated) may go on the branch. */
export function committable(path) {
  const p = String(path);
  if (!p || p.startsWith('/') || p.split('/').some((part) => part === '..' || part === '')) return false;
  if (p.endsWith('.tmp') || SECRET_NAME.test(p.slice(p.lastIndexOf('/') + 1))) return false;
  return KEEP.some((glob) => matchesGlob(p, glob));
}

export const looksSecret = (text) => typeof text === 'string' && SECRET_PATTERNS.some((re) => re.test(text));

export function defaultSh(cmd, args, opts = {}) {
  const env = { ...process.env, ...(opts.env ?? {}) };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[key];
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts, env });
  return { status: r.status ?? (r.error?.code === 'ENOENT' ? 127 : 1), stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? String(r.error.message) : '') };
}

const realOr = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

// The git calls for one store: in the project (`inRoot`) or in the state worktree (`inState`).
function gitFor({ root, stateDir, sh }) {
  let base = null;
  const prefix = () => {
    if (base) return base;
    base = ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false'];
    const email = sh('git', ['config', 'user.email'], { cwd: root });
    if (email.status !== 0 || !String(email.stdout).trim()) base.push('-c', 'user.name=Foreman', '-c', 'user.email=foreman@localhost');
    return base;
  };
  const run = (cwd, args, opts) => {
    const r = sh('git', [...prefix(), ...args], { cwd, ...opts });
    return { status: r.status ?? 1, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
  };
  return { inRoot: (args, opts) => run(root, args, opts), inState: (args, opts) => run(stateDir, args, opts) };
}

const why = (r) => (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ').slice(0, 300);

function fail(message, r) {
  throw new Error(r ? `${message}: ${why(r)}` : message);
}

// Is the state folder already this branch's worktree?
function isStateWorktree({ stateDir, branch }, git) {
  if (!existsSync(join(stateDir, '.git'))) return false;
  const top = git.inState(['rev-parse', '--show-toplevel']);
  if (top.status !== 0 || realOr(top.stdout.trim()) !== realOr(stateDir)) return false;
  // Mid-rebase HEAD is detached; the rebase's own state says which branch it was on.
  const head = git.inState(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (head.status === 0 && head.stdout.trim() !== branch) fail(`${stateDir} is a git worktree on ${head.stdout.trim()}, not the state branch ${branch}`);
  return true;
}

// The project must never see the state folder: exclude it in .git/info/exclude when it sits
// inside the project and nothing ignores it yet.
function excludeFromProject({ root, stateDir }, git) {
  const rel = relative(realOr(root), realOr(stateDir));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return;
  const entry = `/${rel.split(sep).join('/')}/`;
  if (git.inRoot(['check-ignore', '-q', '--no-index', entry.slice(1)]).status === 0) return;
  const r = git.inRoot(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (r.status !== 0) return;
  const file = join(r.stdout.trim(), 'info', 'exclude');
  const had = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (had.split('\n').includes(entry)) return;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${had && !had.endsWith('\n') ? '\n' : ''}# Foreman's state worktree\n${entry}\n`);
}

function writeIfChanged(file, text) {
  if (existsSync(file) && readFileSync(file, 'utf8') === text) return;
  writeFileSync(file, text);
}

const remoteRef = ({ remote, branch }) => `refs/remotes/${remote}/${branch}`;
const hasRef = (git, ref) => git.inRoot(['rev-parse', '--verify', '--quiet', ref]).status === 0;

// Fetches the remote branch into its remote-tracking ref. false when the remote has no such
// branch yet; throws when the remote cannot be reached.
function fetchState(o, git) {
  const r = git.inRoot(['fetch', '--quiet', o.remote, `+refs/heads/${o.branch}:${remoteRef(o)}`]);
  if (r.status === 0) return true;
  const ls = git.inRoot(['ls-remote', '--exit-code', '--heads', o.remote, o.branch]);
  if (ls.status === 2) return false;
  fail(`cannot fetch ${o.branch} from ${o.remote}`, r);
}

export function ensureStateWorktree({ root, stateDir, branch = 'foreman-state', remote = 'origin', sh = defaultSh, now = () => new Date() }) {
  const o = { root, stateDir, branch, remote };
  const git = gitFor({ root, stateDir, sh });
  if (isStateWorktree(o, git)) {
    writeIfChanged(join(stateDir, '.gitignore'), GITIGNORE);
    writeIfChanged(join(stateDir, '.gitattributes'), GITATTRIBUTES);
    excludeFromProject(o, git);
    return { created: false, moved: [], leftover: null };
  }

  const onRemote = fetchState(o, git);
  if (!hasRef(git, `refs/heads/${branch}`)) {
    if (onRemote) {
      const r = git.inRoot(['branch', '--no-track', branch, remoteRef(o)]);
      if (r.status !== 0) fail(`cannot create the local ${branch} branch`, r);
    } else {
      // One root commit holding the branch's .gitignore and .gitattributes.
      const blob = (text) => git.inRoot(['hash-object', '-w', '--stdin'], { input: text }).stdout.trim();
      const tree = git.inRoot(['mktree'], { input: `100644 blob ${blob(GITATTRIBUTES)}\t.gitattributes\n100644 blob ${blob(GITIGNORE)}\t.gitignore\n` });
      if (tree.status !== 0) fail('cannot start the state branch', tree);
      const c = git.inRoot(['commit-tree', tree.stdout.trim(), '-m', 'Start Foreman state']);
      if (c.status !== 0) fail('cannot start the state branch', c);
      const r = git.inRoot(['branch', branch, c.stdout.trim()]);
      if (r.status !== 0) fail(`cannot create the ${branch} branch`, r);
    }
  }

  // The worktree needs an empty folder: anything already there is moved aside, then back in.
  let aside = null;
  if (existsSync(stateDir) && readdirSync(stateDir).length) {
    aside = `${stateDir}.local-${now().toISOString().replace(/\D/g, '').slice(0, 14)}`;
    renameSync(stateDir, aside);
  }
  mkdirSync(dirname(stateDir), { recursive: true });
  git.inRoot(['worktree', 'prune']);
  const add = git.inRoot(['worktree', 'add', '--quiet', stateDir, branch]);
  if (add.status !== 0) {
    if (aside) {
      rmSync(stateDir, { recursive: true, force: true });
      renameSync(aside, stateDir);
    }
    fail(`cannot check out ${branch} in ${stateDir}`, add);
  }

  const moved = [];
  let leftover = null;
  if (aside) {
    for (const name of readdirSync(aside)) moved.push(...moveIn(join(aside, name), join(stateDir, name), name));
    if (dirIsEmpty(aside)) rmSync(aside, { recursive: true, force: true });
    else leftover = aside;
  }
  writeIfChanged(join(stateDir, '.gitignore'), GITIGNORE);
  writeIfChanged(join(stateDir, '.gitattributes'), GITATTRIBUTES);
  excludeFromProject(o, git);
  commitLocal(o, git, moved.length ? 'Move Foreman state onto the branch' : 'Start Foreman state');
  if (!onRemote) {
    // Another clone may have made the branch meanwhile; the next sync's rebase joins them.
    const p = git.inState(['push', '--quiet', '--no-verify', remote, `HEAD:refs/heads/${branch}`]);
    if (p.status === 0) git.inState(['update-ref', remoteRef(o), 'HEAD']);
  }
  return { created: true, moved: moved.filter((n) => !n.includes('/')), leftover };
}

const dirIsEmpty = (dir) => {
  try {
    return readdirSync(dir).every((name) => dirIsEmpty(join(dir, name)));
  } catch (err) {
    return err.code === 'ENOENT';
  }
};

// Moves one entry in by renaming (a slot worktree keeps its path). A folder the branch already
// has is merged entry by entry; a file the branch already has stays where it was.
function moveIn(from, to, name) {
  if (!existsSync(to)) {
    renameSync(from, to);
    return [name];
  }
  if (!lstatSync(from).isDirectory() || !lstatSync(to).isDirectory()) return [];
  const out = [];
  for (const child of readdirSync(from)) out.push(...moveIn(join(from, child), join(to, child), `${name}/${child}`));
  if (dirIsEmpty(from)) {
    rmSync(from, { recursive: true, force: true });
    out.push(name);
  }
  return out;
}

// The paths `git status` reports in the state worktree, relative and `/`-separated.
function statusPaths(git) {
  const r = git.inState(['status', '--porcelain', '-z', '--untracked-files=all']);
  if (r.status !== 0) fail('cannot read the state folder', r);
  const parts = r.stdout.split('\0').filter(Boolean);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].slice(0, 2);
    out.push(parts[i].slice(3));
    if (code.includes('R') || code.includes('C')) out.push(parts[++i]);
  }
  return [...new Set(out)];
}

const readOrNull = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

export function changedFiles({ root, stateDir, sh = defaultSh }) {
  const git = gitFor({ root: root ?? stateDir, stateDir, sh });
  return new Map(
    statusPaths(git)
      .filter(committable)
      .sort()
      .map((p) => [p, readOrNull(join(stateDir, p))]),
  );
}

// Commits the changed state files; { committed, refused }.
function commitLocal(o, git, message) {
  const refused = [];
  const files = statusPaths(git)
    .filter(committable)
    .filter((p) => {
      if (!looksSecret(readOrNull(join(o.stateDir, p)))) return true;
      refused.push(p);
      return false;
    });
  if (!files.length) return { committed: false, refused };
  git.inState(['reset', '--quiet']);
  const add = git.inState(['add', '-A', '--', ...files]);
  if (add.status !== 0) fail('cannot stage the state files', add);
  const c = git.inState(['commit', '--quiet', '--no-verify', '-m', message]);
  if (c.status !== 0) fail('cannot commit the state files', c);
  return { committed: true, refused };
}

// A rebase a crash left behind is dropped; its commits are still on the branch.
function abortStaleRebase(git) {
  for (const name of ['rebase-merge', 'rebase-apply']) {
    const r = git.inState(['rev-parse', '--path-format=absolute', '--git-path', name]);
    if (r.status === 0 && existsSync(r.stdout.trim())) {
      git.inState(['rebase', '--abort']);
      return;
    }
  }
}

// What this machine's unpushed commits changed: path -> content (null when deleted).
function unpushedWrites(o, git) {
  const mb = git.inState(['merge-base', 'HEAD', remoteRef(o)]);
  const r = mb.status === 0 ? git.inState(['diff', '--name-only', '-z', mb.stdout.trim(), 'HEAD']) : git.inState(['ls-tree', '-r', '--name-only', '-z', 'HEAD']);
  const paths = r.stdout.split('\0').filter(Boolean).filter(committable);
  return new Map(paths.map((p) => [p, readOrNull(join(o.stateDir, p))]));
}

// Puts this machine's commits on top of the remote's. On a conflict the remote's copy is
// taken and `writes` (else the unpushed commits' changes) are written back over it.
function integrate(o, git, writes) {
  if (!hasRef(git, remoteRef(o))) return;
  const r = git.inState(['rebase', '--quiet', '--no-verify', remoteRef(o)]);
  if (r.status === 0) return;
  git.inState(['rebase', '--abort']);
  const own = new Map([...unpushedWrites(o, git), ...(writes ?? new Map())]);
  const reset = git.inState(['reset', '--quiet', '--hard', remoteRef(o)]);
  if (reset.status !== 0) fail('cannot take the remote state', reset);
  for (const [path, text] of own) {
    if (!committable(path)) continue;
    const file = join(o.stateDir, path);
    if (text === null) rmSync(file, { force: true });
    else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
  }
}

// Syncs on one machine take turns. The lock is in the project's git folder, beside the
// worktree's own records, and is broken when its process is gone.
async function withLock(o, git, sleep, fn) {
  const r = git.inRoot(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (r.status !== 0) fail(`${o.root} is not a git repository`, r);
  const file = join(r.stdout.trim(), 'foreman-state.lock');
  const me = { pid: process.pid, at: new Date().toISOString() };
  for (let waited = 0; !take(file, me).ok; waited += 100) {
    if (breakIfStale(file)) continue;
    if (waited > 60_000) fail(`another Foreman command has held ${file} for a minute`);
    await sleep(100);
  }
  try {
    return await fn();
  } finally {
    release(file, me.pid);
  }
}

const jitter = (attempt, random) => 200 * attempt + Math.floor(random() * 200);

export async function syncState({ root, stateDir, branch = 'foreman-state', remote = 'origin', sh = defaultSh, sleep = (ms) => new Promise((done) => setTimeout(done, ms)), random = Math.random, direction, message = 'Update Foreman state', writes = null, now }) {
  if (direction !== 'pull' && direction !== 'push') throw new Error(`syncState direction must be pull or push, not ${direction}`);
  const o = { root, stateDir, branch, remote };
  const git = gitFor({ root, stateDir, sh });
  return withLock(o, git, sleep, async () => {
    if (existsSync(join(stateDir, '.git'))) abortStaleRebase(git);
    const setup = ensureStateWorktree({ root, stateDir, branch, remote, sh, ...(now ? { now } : {}) });
    const refused = new Set();
    const commit = (msg) => commitLocal(o, git, msg).refused.forEach((p) => refused.add(p));

    if (direction === 'pull') {
      fetchState(o, git);
      commit('Keep local Foreman state');
      integrate(o, git, null);
      commit('Keep local Foreman state');
      return { setup, pushed: false, attempts: 0, refused: [...refused] };
    }

    let last = null;
    for (let attempt = 1; attempt <= TRIES; attempt++) {
      commit(message);
      const known = hasRef(git, remoteRef(o));
      const ahead = known ? Number(git.inState(['rev-list', '--count', `${remoteRef(o)}..HEAD`]).stdout.trim()) : 1;
      if (!ahead) return { setup, pushed: false, attempts: attempt, refused: [...refused] };
      const p = git.inState(['push', '--quiet', '--no-verify', remote, `HEAD:refs/heads/${branch}`]);
      if (p.status === 0) {
        git.inState(['update-ref', remoteRef(o), 'HEAD']);
        return { setup, pushed: true, attempts: attempt, refused: [...refused] };
      }
      last = p;
      if (attempt === TRIES) break;
      await sleep(jitter(attempt, random));
      try {
        fetchState(o, git);
      } catch {
        continue; // counted as a try; the next one fetches again
      }
      integrate(o, git, writes);
    }
    fail(`cannot push ${branch} to ${remote} after ${TRIES} tries`, last);
  });
}
