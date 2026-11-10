# Ship exit 2

- **2** — CI did not pass; nothing merged. Read the JSON's `reason` first:
  - The JSON's `stage` is `merge-main` (check this first) → the project has no CI, and the
    project's checks failed on the branch merged with `<base>`. The merge is already on the
    branch. `failures` lists each as {run, exit, timedOut, tail}. Write the fix file with one
    `blocker` finding per entry (`stage: "checks"`, the command in `where`, its tail in
    `observed`) and run a fix round (`fix-round.md`). Then run `foreman checks --all --start`,
    then `foreman checks --wait <id>` until it prints the result, and read the output; an
    entry whose `run` is the install command, not a check, you run yourself. The next
    `foreman ship` finds `<base>` already merged and does not run the checks again, and
    `--all` also runs a check that only `<base>`'s files chose, which `--changed` would skip.
    Never run a check's command by hand: Foreman denies it. If any of them still
    fails, take the failed path (`failed.md`). Otherwise make a new commit (never amend) and
    run `foreman ship --story <ID>` again. A second failure takes the failed path.
  - It says CI **never started**, **did not finish** in time, or its checks **could not be
    read** → the code is not at fault, so do not send anything to the builder. Leave the
    pull request open, go back, run `foreman story block <ID> --reason "<the reason>"`,
    and stop with `failed`.
    - When you stop with `failed` because CI never started, did not finish, or its checks
      could not be read, pass `--cause environment` to `foreman story end`.
  - It says **CI failed** → find the failing runs:
    `gh run list --commit "$(git rev-parse HEAD)" --status failure --json databaseId,name`
    (checks that are not GitHub Actions runs show in `gh pr checks <n>`), then read each
    with `gh run view <id> --log-failed`. Write the fix file with one `blocker` finding per
    failure (`stage: "ci"`, the job and file in `where`, the error in `observed`) and run a
    fix round. Then `foreman checks --changed`, a **new** commit (never amend), and
    `foreman ship --story <ID>` again. A second CI failure takes the failed path, which
    turns the pull request back into a draft.
  - The JSON has `inherited: true` (check this first) → the validation failed only in tests
    or coverage the org already failed before this story, which the doctor's baseline
    recorded. The code is not at fault, so send nothing to the builder. Leave the pull
    request open, go back, and run `foreman story block <ID> --reason '<the reason>'`, then
    `foreman decide add --story <ID> --kind task --title "<org> cannot pass its own tests: fix the org or change salesforce.testLevel" --body '<the ship JSON line>'`.
    The reason and the JSON line always hold an apostrophe ("this story's"), so write each
    `'` inside them as `'\''`; the single quotes keep the shell from running a backtick or
    `$(…)` in them. Stop with `blocked`.
  - The JSON's `stage` is `sf-validate` and its reason says the validation **failed** →
    the JSON's `failures` lists each problem as {kind, name, message}. Write the fix file
    with one `blocker` finding per entry (`stage: "ci"`, the entry's name in `where`, its
    message in `observed`) and run a fix round. Then `foreman checks --changed`, a new
    commit, and ship again. A second failure takes the failed path.
  - The JSON's `stage` is `sf-delta` → the change puts files in the package folders that
    never go there (agent test definitions), and its `failures` lists each as {kind, name,
    message}. Write the fix file with one `blocker` finding per entry (`stage: "ci"`, the
    entry's name in `where`, its message in `observed`) and run a fix round. Then
    `foreman checks --changed`, a new commit, and ship again, as for `sf-validate`.
