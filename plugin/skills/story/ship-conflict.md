# Ship exit 6

- **6** — the branch conflicts with `<base>` in real code; nothing was pushed. The JSON's
  `conflicts` lists the files. Write the fix file with one `blocker` finding, `stage:
  "merge"`, whose `fix` reads "merge `<remote>/<base>` into this branch and resolve the
  conflicts in <files>, keeping both sides' intent". That is a conflict-only round. Read
  the limit once with `foreman settings get rounds`, or use 3 when it fails. Each exit 6
  gets a fix round (`fix-round.md`), then `foreman checks --changed`, a new commit (never amend), and
  `foreman ship --story <ID>` again, up to that many conflict rounds in this run. Take the
  failed path (`failed.md`) when the fix round returns `failed` (the builder could not resolve it), when
  `foreman checks --changed` fails after the round, or when exit 6 comes back after the
  last allowed round. Main moving without a conflict is brought in by `foreman ship`
  itself and never counts as a round.

When a conflict takes the failed path because the fix round returned `failed`, or exit 6 came
back after the last round, the failed path ends with `--cause environment`
(`foreman story end failed --cause environment`). A `foreman checks --changed` failure after
the round follows the checks rule in `failed.md`.
