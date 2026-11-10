// The changes a story leaves in its slot's folder. When a story's session ends, or at the pick
// when a dirty folder is on the branch of a story nothing holds any longer (the story is recognised
// by the branch pattern, not by the open list), saveLeftovers commits
// whatever is uncommitted (staged, unstaged and untracked; not ignored files) to a local branch
// leftover/<slot>-<story>-<YYYYMMDD> (-2, -3 when the day already has one), then resets and cleans
// the folder and detaches it at base. `clean` means the folder has no changes and is detached at
// base. New key files (.env* other than the templates, *.pem, id_rsa-style keys, and the config's
// env file names) are never committed to the leftover branch, and are deleted with the rest. Changes only under the `generated` paths are dropped with
// no branch, as the dirty check ignores them. The branch is never pushed. The commit carries its
// own identity and skips the project's hooks, so neither a missing git identity nor a hook can
// stop the save. When the branch or the commit cannot be made, the folder is left as it was (its
// HEAD, index and files) and nothing is reset. It runs git through worktree.mjs's shell, whose
// output is not trimmed, so the porcelain status reads right. Nothing here throws.
//
// freeStoryFolder is for a story that moves to another slot because the slot it was in is over
// the worker count. The folder is on the story's branch, maybe with unfinished work, and the
// branch cannot be checked out in two worktrees. It commits whatever is uncommitted onto the
// story's own branch (with the checkpoint's excludes for the `generated` paths, so the commit's
// tree is the tree the checkpoint saved and the resume keeps its finished stages), then detaches
// the folder at base so the new slot can check the branch out. A folder not on the branch is left
// alone. Changes only under `generated` are dropped with no commit. When the commit cannot be
// made the folder is left as it was. It is also used at start-up, for a story a dead run left in a
// slot (`message` then words the commit). It returns { freed, committed, problem } and never throws.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defaultSh, worktreeDirty } from './worktree.mjs';

const IDENTITY = ['-c', 'user.name=Foreman', '-c', 'user.email=foreman@localhost', '-c', 'commit.gpgsign=false'];

// leftover/<slot>-<id lowercased>-<UTC date>, with -2, -3 and so on while `taken(name)` is true.
export function leftoverName({ slot, id, now, taken = () => false }) {
  const day = now.toISOString().slice(0, 10).replace(/-/g, '');
  const first = `leftover/${slot}-${String(id).toLowerCase()}-${day}`;
  let name = first;
  for (let n = 2; taken(name); n++) name = `${first}-${n}`;
  return name;
}

// The story whose branch `head` is (prefix + id lowercased): one listed in `ids`, or, given the
// source's `idPattern`, any id that pattern accepts. A story that is no longer open (Done in Jira,
// outside the JQL) is still recognised. Null when `head` is no story's branch.
export function storyOfBranch(head, ids, prefix, idPattern = null) {
  const listed = ids.find((id) => `${prefix}${String(id).toLowerCase()}` === head);
  if (listed !== undefined) return listed;
  if (!idPattern || typeof head !== 'string' || !head.startsWith(prefix)) return null;
  // branchOf always lowercases the id, so a branch with capitals is not Foreman's.
  const rest = head.slice(prefix.length);
  if (!rest || rest !== rest.toLowerCase()) return null;
  let whole;
  try {
    whole = new RegExp(`^(?:${idPattern})$`);
  } catch {
    return null;
  }
  return [rest.toUpperCase(), rest].find((candidate) => whole.test(candidate)) ?? null;
}

// Every story id still live: claimed by anyone (stale claims too), in a session, queued, or in a slot.
export function heldIds({ claims = [], sessions = [], work = [], slots = [] } = {}) {
  const ids = [...claims.map((c) => c?.id), ...sessions.map((s) => s?.id), ...work.map((w) => w?.id), ...slots.flatMap((s) => [s?.story?.id, s?.heldStory])];
  return new Set(ids.filter((id) => id !== null && id !== undefined && id !== ''));
}

const TEMPLATES = new Set(['.env.example', '.env.sample', '.env.template', '.env.dist']);
const SSH_KEYS = new Set(['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519']);

// Whether `file` (a path in the repo) looks like a key file: an env file other than the templates,
// a .pem, a private ssh key, or one of `names` (full path or file name).
export function isKeyFile(file, names = []) {
  const b = String(file).split('/').pop();
  if (b === '.env' || b === '.envrc') return true;
  if (/^\.env\..+$/.test(b) && !TEMPLATES.has(b)) return true;
  if (b.endsWith('.pem') || SSH_KEYS.has(b)) return true;
  return names.some((n) => n && (n === file || String(n).split('/').pop() === b));
}

// The warn events for a saveLeftovers result, in order.
export function leftoverEvents({ slot, id, base, result }) {
  const { branch, clean, problem, dropped = [] } = result;
  const events = [];
  if (branch && clean) events.push(`Slot ${slot}: ${id} left changes in its folder; they are on the branch ${branch}, and the folder is clean again.`);
  if (branch && !clean) events.push(`Slot ${slot}: ${id} left changes in its folder; they are on the branch ${branch}, but the folder could not be put back at ${base}.`);
  if (dropped.length) events.push(`Slot ${slot}: ${id} left key files in its folder (${dropped.join(', ')}); they are not on any branch and were deleted.`);
  if (problem) events.push(`Slot ${slot}: could not save the leftover changes of ${id} (${problem}); the folder is left as it was.`);
  return events;
}

// { branch, clean, problem, dropped }: the leftover branch made (or null), whether the folder is
// clean and detached at base after, why the changes could not be saved (or null), and the new key
// files deleted instead of saved.
export function saveLeftovers({ path, slot, id, base, generated = [], keyFiles = [], now, sh = defaultSh }) {
  try {
    const run = (...args) => sh('git', args, { cwd: path });
    if (worktreeDirty(path, { generated, sh })) {
      const saved = commitLeftovers({ run, slot, id, now, keyFiles });
      if (saved.problem) return { branch: null, clean: false, problem: saved.problem, dropped: [] };
      const detached = tidy(run, base);
      return { branch: saved.branch, clean: detached && isClean(run), problem: null, dropped: saved.dropped };
    }
    const detached = tidy(run, base);
    return { branch: null, clean: detached && isClean(run), problem: null, dropped: [] };
  } catch (err) {
    return { branch: null, clean: false, problem: `could not save them: ${String(err?.message ?? err).slice(0, 200)}`, dropped: [] };
  }
}

// { freed, committed, problem }: the folder at `path` no longer holds the story's branch, and the
// story's unfinished work (if any) was committed on that branch; see the header.
export function freeStoryFolder({ path, id, branch, from, to, base, generated = [], message = `${id} WIP: moved from slot ${from} to ${to}`, sh = defaultSh }) {
  try {
    if (!existsSync(join(path, '.git'))) return { freed: true, committed: false, problem: null };
    const run = (...args) => sh('git', args, { cwd: path });
    if (run('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim() !== branch) return { freed: true, committed: false, problem: null };
    let committed = false;
    if (worktreeDirty(path, { generated, sh })) {
      const excludes = generated.filter((g) => typeof g?.path === 'string' && g.path).map((g) => `:(exclude,glob)${g.path}`);
      let ok = run('add', '-A', '--', '.', ...excludes).status === 0;
      if (ok && run('diff', '--cached', '--quiet').status !== 0) {
        ok = run(...IDENTITY, 'commit', '--quiet', '--no-verify', '-m', message).status === 0;
        committed = ok;
      }
      if (!ok) {
        run('reset', '--quiet');
        return { freed: false, committed: false, problem: `could not commit its changes to ${branch}` };
      }
    }
    tidy(run, base);
    const detached = run('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim() === 'HEAD';
    if (!isClean(run) || !detached) return { freed: false, committed, problem: `could not detach it at ${base}` };
    return { freed: true, committed, problem: null };
  } catch (err) {
    return { freed: false, committed: false, problem: `could not free it: ${String(err?.message ?? err).slice(0, 200)}` };
  }
}

// Commits everything uncommitted to a new leftover branch; on a failure puts HEAD and the index
// back as they were and removes the branch.
function commitLeftovers({ run, slot, id, now, keyFiles }) {
  const abbrev = run('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
  const was = abbrev === 'HEAD' ? run('rev-parse', 'HEAD').stdout.trim() : abbrev;
  const index = run('write-tree');
  const tree = index.status === 0 ? index.stdout.trim() : null;
  const branch = leftoverName({ slot, id, now, taken: (name) => run('rev-parse', '--verify', '--quiet', `refs/heads/${name}`).status === 0 });
  const undo = (made) => {
    if (tree) run('read-tree', tree);
    run('checkout', '--quiet', was);
    if (made) run('branch', '-D', branch);
  };
  if (run('checkout', '--quiet', '-b', branch).status !== 0) {
    undo(false);
    return { problem: `could not make the branch ${branch}` };
  }
  const problem = `could not commit them to ${branch}`;
  if (run('add', '-A').status !== 0) {
    undo(true);
    return { problem };
  }
  // Only files new to the index are dropped: a tracked key file that was edited is committed, as
  // its earlier contents are already in history. The dropped files are untracked, so tidy deletes them.
  const added = run('diff', '--cached', '--name-only', '--no-renames', '--diff-filter=A', '-z');
  if (added.status !== 0) {
    undo(true);
    return { problem };
  }
  const dropped = added.stdout.split('\0').filter((f) => f && isKeyFile(f, keyFiles)).sort();
  if (dropped.length && run('rm', '--cached', '--quiet', '--', ...dropped).status !== 0) {
    undo(true);
    return { problem };
  }
  if (run('diff', '--cached', '--quiet').status === 0) {
    undo(true);
    return { branch: null, problem: null, dropped };
  }
  if (run(...IDENTITY, 'commit', '--quiet', '--no-verify', '-m', `${id} leftovers from slot ${slot}`).status !== 0) {
    undo(true);
    return { problem };
  }
  return { branch, problem: null, dropped };
}

// Clean and detached at base; whether the detach worked. clean -fd without -x keeps ignored files (node_modules, the env link).
function tidy(run, base) {
  run('reset', '--quiet', '--hard');
  run('clean', '-fdq');
  return run('checkout', '--quiet', '--detach', base).status === 0;
}

const isClean = (run) => {
  const r = run('status', '--porcelain');
  return r.status === 0 && r.stdout.trim() === '';
};
