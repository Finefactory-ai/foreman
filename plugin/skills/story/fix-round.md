# A fix round

Used when something after the review sends the change back: a failing check in step 4, a
CI failure, a check failing on the merged code, or a conflict in step 5. You have written the fix file first.

1. If the plan file exists, run `foreman workflow-args <ID> --plan <plan file> --start-at
   fix --findings <fix file>`. The workflow skips the architect, sends the findings to the
   builder, then runs the tester and every reviewer again, so the fix is reviewed like the
   first build. If the plan file is missing (a resumed session from before plans were
   kept), run `foreman workflow-args <ID>` instead: the workflow starts from the architect
   on the current tree, without the findings. Say so in your reply.
2. Call the workflow with the object it printed (the plan reaches the agents by file; the
   result carries none to save) and handle the result:
   - `passed` → add the result to the findings file (its findings and its history, as
     SKILL.md says) and carry on where the round was called from.
   - `deferred` → take each resource in `needs` as in `deferred.md`. When one cannot be
     taken, release every resource this run took, leave the branch as it is, go back, run
     `foreman story todo <ID> --note "waiting for <resource> to be free; branch kept"`, and
     stop with `deferred`. When every one is taken and `files` is not empty, run
     `foreman lock files <ID> --plan <plan file>` as in `deferred.md`: on exit 7, release
     every resource this run took, leave the branch as it is, go back, run `foreman story
     todo <ID> --note '<reason>; branch kept'`, and stop with `deferred`, passing the same
     note to `foreman story end deferred "" '<reason>; branch kept'`; on any other exit but
     0, release them and block the story as `deferred.md` says. Then run the same `foreman
     workflow-args` command again (with `--start-at fix --findings`, not a fresh build) and
     call the workflow again.
   - `blocked` → as in `blocked.md`, but keep the branch when it has commits.
   - `rethink` → as in `rethink.md`.
   - `failed` → add the result to the findings file (its findings and its history, as
     SKILL.md says) and take the failed path (`failed.md`).

Each cause gets one fix round. When the same cause sends the change back a second time
(checks fail again, CI fails again), take the failed path. Conflicts with `<base>` get up
to `rounds` rounds, as `ship-conflict.md` says.
