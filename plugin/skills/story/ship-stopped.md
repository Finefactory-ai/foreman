# Ship exits 1, 3, 4 or 5, 7, 8 and 9

- **3** — the hosted credentials the release needs are missing; nothing merged. Leave the
  pull request open, go back, run `foreman story block <ID> --reason "Hosted credentials
  needed (owner task)"`, then `foreman decide add --story <ID> --kind task --title "Hosted
  credentials needed for <ID>" --body "<the credentials the JSON names>"`. Say the same in
  your reply and stop with `blocked`.
- **4 or 5** — a release step failed (4: the migration; 5: the deployment or its check, or
  a failure after the merge). `foreman ship` has written `HALT`. Do not retry, revert or
  repair production on your own. Run `foreman story block <ID> --reason "<what failed, from
  the JSON>"`, then `foreman decide add --story <ID> --kind task --urgent --title "<ID>
  stopped the release line" --body '<the ship JSON line>'` (single quotes, with each `'`
  inside written as `'\''`, so the shell passes the JSON whole). Put the JSON line in your reply marked urgent, and stop with
  `halted`.
- **1** — the branch was not in a shippable state; the JSON says why. When the JSON's
  `stage` is `mergeable-recheck`, main kept moving during the release. That costs no
  round: run `foreman ship --story <ID>` once more. If it exits 1 at `mergeable-recheck`
  again, leave the pull request open, go back, run
  `foreman story block <ID> --reason '<the reason>'` and stop with `failed` (the code is
  not at fault, as with CI that never started). Otherwise fix that if it is yours to fix
  (uncommitted files, a missing commit), or else stop with `failed`.
- **1, at `mergeable-recheck` a second time** — stopping with `failed` passes
  `--cause environment` to `foreman story end`.
- **7** — the branch needs an exclusive resource another slot holds; nothing was pushed.
  Leave the branch committed, go back, run `foreman story todo <ID> --note "waiting for
  <resource> to be free; branch committed"`, and stop with `deferred`.
- **8** — releases are frozen by a halt; nothing was done. The branch stays committed. Go
  back and stop with `held`. The supervisor releases it when the owner says the cause is
  fixed.
- **9** — parked; the release finishes later. `foreman ship` has already marked the story
  ready-to-promote, told the story source and saved the park. Do not run
  `foreman story done`. When the JSON has `parkSaved: false` or `storyUpdated: false`, first
  run `foreman decide add --story <ID> --kind task --title "<ID> is ready to promote but was
  not fully recorded" --body '<the ship JSON line>'`. Go back. Run
  `foreman story end ready-to-promote "<pull request url>" "<the JSON's parked.reason>"`
  (with `--findings` and `--builder` as usual). Say the reason in your reply as what the
  owner must do, and stop with `ready-to-promote`.
