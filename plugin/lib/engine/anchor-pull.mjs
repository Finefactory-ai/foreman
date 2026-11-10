// Bringing new code into the checkout a supervisor runs from, so a merged story of the repo
// Foreman builds needs no hand pull. Pure logic over an injected `sh(cmd, args, { cwd })` that
// returns { status, stdout }. No side effects at import time.
//
//   ownCheckout({ pluginDir, root, sh })
//                       true only when the plugin folder sits in the root's own checkout: both
//                       have the same git top-level. False for a plugin in a repo of its own, an
//                       installed copy outside git, or another worktree of the root
//   anchorStep({ root, remote, baseBranch, sh })
//                       what to do about the root checkout, from the tracking ref the merge step's
//                       fetch moved (it never fetches itself): { action: 'none' } when there is
//                       nothing to bring in, { action: 'moved', from, to } after a fast-forward,
//                       or { action: 'wait', why, from, to } when it left the checkout alone, why
//                       being 'branch' (not on the base branch; `branch` names it, '' when
//                       detached), 'dirty' (a tracked change, staged or not, to a file the
//                       incoming commits also change; `files` names them by their real path names, unquoted, sorted; a tracked
//                       change to any other file is kept across the move, and untracked files
//                       never count), 'diverged' (commits the tracking ref lacks) or 'failed'
//                       (git refused: the status check, a diff or the merge failed, so a tree
//                       whose state is unknown is never moved)
//   anchorText(step, { remote, baseBranch })
//                       the event sentence for a step, or null for none
//   anchorEvent(step, warnedTo, opts)
//                       { event: { text, kind } | null, warnedTo }: an info event for a move, a
//                       warn for a wait only when its base sha is not the one already warned
//                       about, nothing for none
//   anchorWaitOf(step, prev, { remote, baseBranch, at })
//                       { wait, changed }: the record of a wait for state.json (`anchorWait`:
//                       why, from, to, remote, baseBranch, since, plus `branch` for a branch
//                       wait and `files` for a dirty one), or null for a move or none. `since`
//                       is kept from `prev` while the run keeps waiting; `changed` says whether
//                       the record differs from `prev`, so it is written only on a change
//   anchorWaitWhy(wait)
//                       the sentence the owner reads for a recorded wait, naming the files for a
//                       dirty one and what to do about it

const short = (sha) => String(sha).slice(0, 7);

// `git diff -z` prints each path raw and ends it with a NUL, so no name is quoted or trimmed.
const names = (stdout) => stdout.split('\0').filter(Boolean);

export function ownCheckout({ pluginDir, root, sh }) {
  const top = (cwd) => {
    const r = sh('git', ['rev-parse', '--show-toplevel'], { cwd });
    return r.status === 0 ? r.stdout.trim() : '';
  };
  const plugin = top(pluginDir);
  return plugin !== '' && plugin === top(root);
}

export function anchorStep({ root, remote, baseBranch, sh }) {
  const git = (...args) => sh('git', args, { cwd: root });
  const ref = `refs/remotes/${remote}/${baseBranch}`;
  const heads = git('rev-parse', 'HEAD', ref);
  const [head, to] = heads.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (heads.status !== 0 || !head || !to || head === to) return { action: 'none' };
  if (git('merge-base', '--is-ancestor', to, 'HEAD').status === 0) return { action: 'none' };
  const branch = git('symbolic-ref', '--quiet', '--short', 'HEAD');
  const name = branch.status === 0 ? branch.stdout.trim() : '';
  if (name !== baseBranch) return { action: 'wait', why: 'branch', branch: name, from: head, to };
  const status = git('status', '--porcelain', '--untracked-files=no');
  if (status.status !== 0) return { action: 'wait', why: 'failed', from: head, to };
  if (status.stdout.trim() !== '') {
    const local = git('diff', '--name-only', '-z', '--no-renames', 'HEAD');
    const incoming = git('diff', '--name-only', '-z', '--no-renames', 'HEAD', to);
    if (local.status !== 0 || incoming.status !== 0) return { action: 'wait', why: 'failed', from: head, to };
    const theirs = new Set(names(incoming.stdout));
    const files = [...new Set(names(local.stdout).filter((f) => theirs.has(f)))].sort();
    if (files.length > 0) return { action: 'wait', why: 'dirty', files, from: head, to };
  }
  if (git('merge-base', '--is-ancestor', 'HEAD', to).status !== 0) return { action: 'wait', why: 'diverged', from: head, to };
  if (git('merge', '--ff-only', '--quiet', to).status !== 0) return { action: 'wait', why: 'failed', from: head, to };
  return { action: 'moved', from: head, to };
}

export function anchorText(step, { remote, baseBranch }) {
  if (step.action === 'moved') return `Fast-forwarded the main checkout's ${baseBranch} to ${remote}/${baseBranch} (${short(step.from)} -> ${short(step.to)}).`;
  if (step.action !== 'wait') return null;
  const head = `New code is on ${remote}/${baseBranch} (${short(step.to)}), but`;
  if (step.why === 'dirty') return `${head} the main checkout has uncommitted changes, so Foreman left it alone: the run keeps the code it has until you commit or stash them and pull.`;
  if (step.why === 'branch') return `${head} the main checkout is on ${step.branch || 'a detached HEAD'}, not ${baseBranch}, so Foreman left it alone: the run keeps the code it has until you switch back and pull.`;
  if (step.why === 'diverged') return `${head} the main checkout's ${baseBranch} has commits that ${remote}/${baseBranch} does not, so it cannot be fast-forwarded: the run keeps the code it has until you pull.`;
  return `${head} fast-forwarding the main checkout failed: the run keeps the code it has until you pull.`;
}

export function anchorEvent(step, warnedTo, opts) {
  if (step.action === 'moved') return { event: { text: anchorText(step, opts), kind: 'info' }, warnedTo: null };
  if (step.action !== 'wait' || step.to === warnedTo) return { event: null, warnedTo };
  return { event: { text: anchorText(step, opts), kind: 'warn' }, warnedTo: step.to };
}

export function anchorWaitOf(step, prev, { remote, baseBranch, at }) {
  if (step.action !== 'wait') return { wait: null, changed: prev != null };
  const wait = { why: step.why, from: step.from, to: step.to, remote, baseBranch, since: prev && typeof prev === 'object' && prev.since ? prev.since : at };
  if (step.why === 'branch') wait.branch = step.branch ?? '';
  if (step.why === 'dirty') wait.files = step.files ?? [];
  const changed = prev == null || ['why', 'branch', 'from', 'to'].some((k) => wait[k] !== prev[k]) || JSON.stringify(wait.files) !== JSON.stringify(prev.files);
  return { wait, changed };
}

// 1 file 'a'; 2 'a and b'; 3 'a, b and c'; more than 3 'a, b, c and N more'.
function fileList(files) {
  if (files.length <= 1) return files.join('');
  if (files.length <= 3) return `${files.slice(0, -1).join(', ')} and ${files[files.length - 1]}`;
  return `${files.slice(0, 3).join(', ')} and ${files.length - 3} more`;
}

export function anchorWaitWhy(wait) {
  const { remote, baseBranch } = wait;
  const head = `New code is on ${remote}/${baseBranch} (${short(wait.to)}), but`;
  if (wait.why === 'dirty') {
    const files = Array.isArray(wait.files) ? wait.files : [];
    return `${head} the main checkout has uncommitted changes${files.length > 0 ? ` to ${fileList(files)}` : ''} that the new code also changes. Commit or stash them, or move a per-machine setting to .claude/settings.local.json, then pull: the run keeps the code it has until then.`;
  }
  if (wait.why === 'branch') return `${head} the main checkout is on ${wait.branch || 'a detached HEAD'}, not ${baseBranch}. Switch back to ${baseBranch} and pull: the run keeps the code it has until then.`;
  if (wait.why === 'diverged') return `${head} the main checkout's ${baseBranch} has commits that ${remote}/${baseBranch} does not, so it cannot be fast-forwarded. Pull to bring them together, or move them to a branch: the run keeps the code it has until then.`;
  return `${head} fast-forwarding the main checkout failed, perhaps because a file git does not track is in the way. Run git pull there to see why: the run keeps the code it has until then.`;
}
