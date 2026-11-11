// Cleans up a temporary git worktree: sf-deploy, stage-merge, rollback and the Agentforce check
// each make one in a temporary folder and drop it on every path.
//
// removeTempTree(git, tree, tmp): `git` is the caller's own runner, which runs in the project root
// and gives { status, ... } (or {}); `tree` is the worktree and `tmp` the folder that holds it.
// It runs `git worktree remove --force <tree>` and then deletes `tmp`. When the remove did not
// give status 0 (the worktree was never added, it is locked, or git itself failed), the folder is
// gone but git still lists the worktree as prunable, so it then runs `git worktree prune`. That
// runs only after the folder is deleted, because prune drops only records whose folder is gone.
// Plain prune takes no flags: it leaves live worktrees (the slots') and locked ones alone. A
// successful remove runs no prune. The prune's result is ignored, and nothing here throws for a
// git failure. It returns nothing.

import fs from 'node:fs';

export function removeTempTree(git, tree, tmp) {
  const removed = git(['worktree', 'remove', '--force', tree]);
  fs.rmSync(tmp, { recursive: true, force: true });
  if (removed?.status !== 0) git(['worktree', 'prune']);
}
