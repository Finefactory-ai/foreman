# The resume rule

SKILL.md sent you here because the story has history. Look at it before anything is done;
the steps named below are SKILL.md's.

- Its pull request **merged** but the story is not `done` → check the live site with
  `foreman health --site` (one JSON line; exit 0 when it answers, or when none is
  configured). Exit 0 → step 6, with the merged note. Non-zero → take the failed path
  (`failed.md`), giving the JSON's `reason` as what failed, and stop with `failed`.
- `<branch>` has the story's commit (`<ID> <title>`) and no uncommitted work →
  `git checkout <branch>` (from `<remote>` if it is only there) and go to step 5.
- `<branch>` exists with work in progress, committed or not → `git checkout <branch>`
  (unless you are already on it) and carry on at step 3 with what is there.

When none of these fits, carry on as SKILL.md says: `git checkout -B <branch> <remote>/<base>`.
