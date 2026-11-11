# The resume rule

SKILL.md sent you here because the story has history. Look at it before anything is done;
the steps named below are SKILL.md's.

When the story JSON from step 2 has `rolledBackAt`, one of its releases was rolled back. First
read `gh pr list --head <branch> --state merged --json url,mergedAt,headRefOid --limit 10`.
When every pull request listed merged before `rolledBackAt`, none of that work is live: the
merged case below does not apply, and you never close the story or mark it done for those pull
requests. Then, when `<branch>` exists neither locally nor on `<remote>`, or each one that
exists points at the `headRefOid` of one of those pull requests, build it again from scratch:
delete the plan file if there is one, run `git push <remote> --delete <branch>` (ignore the
failure when it is not there), run `git checkout -B <branch> <remote>/<base>`, and go to step 3.
Otherwise `<branch>` holds the new build's own work: go on with the cases below as if nothing
had merged. When a pull request merged after `rolledBackAt`, the cases below apply as usual.

- Its pull request **merged** but the story is not `done` → check the live site with
  `foreman health --site` (one JSON line; exit 0 when it answers, or when none is
  configured). Exit 0 → step 6, with the merged note. Non-zero → the release failed, not the
  review: go back, run `foreman story block <ID> --reason '<the JSON's reason>'`, with the
  reason in single quotes and each `'` inside written as `'\''`, as the quoting rule in
  SKILL.md says, and stop with `failed`, ending with that reason. Never take the failed path (`failed.md`) for it, and file
  no decision yourself: the supervisor asks the owner "<ID> could not be released" from that
  reason.
- `<branch>` has the story's commit (`<ID> <title>`) and no uncommitted work →
  `git checkout <branch>` (from `<remote>` if it is only there) and go to step 5.
- `<branch>` exists with work in progress, committed or not → `git checkout <branch>`
  (unless you are already on it) and carry on at step 3 with what is there.

When none of these fits, carry on as SKILL.md says: `git checkout -B <branch> <remote>/<base>`.
