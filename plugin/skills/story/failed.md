# The failed path

1. Commit anything uncommitted as `<ID> WIP: not passing review`.
2. If `<branch>` has no commits ahead, there is nothing to show: skip the pull request.
   Otherwise push it (`git push -u <remote> <branch>`) and look for its open pull request
   (`gh pr list --head <branch> --state open --json number,url`):
   - one exists (a fix round after a release attempt, `fix-round.md`) → turn it back into a draft with
     `gh pr ready --undo <n>`, and replace its body with the open findings
     (`gh pr edit <n> --body-file <file>`);
   - none exists → open a **draft** pull request whose body lists the open findings.
3. Go back, and run `foreman story block <ID> --reason "Factory could not pass review; see
   draft PR <url>"` (or `"Factory could not pass review; nothing was built"` when there is
   no pull request).
4. Ask the owner what to do with it:

       foreman decide add --story <ID> --kind decision --title "<ID> could not pass review" --summary '<what happened, in plain words, one line, at most 160 characters>' --body '<the open findings, and the draft PR url>' --option "Retry with a note to the architect" --hint "Sends the story back to be designed and built again, with your note." --option "I'll take it" --hint "You take the story over; the run leaves it alone until you hand it back." --option "Drop" --hint "Closes the story's pull requests, deletes its branch and blocks it." --recommend "<Retry with a note to the architect; I'll take it when the story's notes already hold a Note for the architect from an earlier retry>" --purpose '<what this story is for, in plain words>' --happened '<the most serious problem the reviewers found, in plain words>' --damage '<only when the run touched something outside the story: what was checked and what was found>' --recommendation '<the recommended option, then why, in plain words>'

   The summary and body hold reviewers' text, so they go in single quotes as the quoting rule in SKILL.md says.
   Leave `--damage` out when nothing outside the story was touched. The body keeps the
   reviewers' findings and the draft PR url; the other parts say it in plain words.
   The answer is applied by the supervisor, or by a later session (see `answers.md`). Say in your reply that it is waiting
   on the owner. Stop with `failed`.

   When the pipeline's result has `cause: "story"`, the builder found the story itself cannot be met as written. The
   `--summary` says in plain words what the builder found (its evidence, naming Done-when <line> when the result has
   `line`). The recommendation depends on the result's `reason`:
   - a reason that says "after the architect corrected": the architect has already corrected the story once, so another
     retry would meet the same wall. Recommend "I'll take it" (`--recommend "I'll take it"`), not "Retry with a note to
     the architect". `--happened` says the builder found the story cannot be met as written, even after the architect
     corrected it. `--recommendation` starts with "I'll take it: " and says why: the architect has already had one go.
   - a reason that says "in a fix round after review": the builder found it in a fix round (after a failing check, CI, a
     conflict or a release attempt) and the architect has not corrected the story. Recommend
     `--recommend "Retry with a note to the architect"`, or "I'll take it" when the story's notes already hold a Note
     for the architect from an earlier retry. `--happened` says the builder found, in a fix round after review, that the
     story cannot be met as written; it never says the architect corrected the story. `--recommendation` starts with the
     recommended option and ": ", and says why (for Retry: the architect has not yet seen what the builder found and can
     correct the plan or the Done-when line).
   Everything else on the failed path stays the same.

When the failed path ends because the code is not at fault, end the story with
`--cause environment`: `foreman story end failed --cause environment` (with the pull request
and reason as usual). That is the case when:

- a conflict with `<base>` could not be settled by the conflict rounds (`ship-conflict.md`);
- the checks failed only because a test file the story did not change could not be loaded:
  the runner reports a load or import error before any of its tests ran, and
  `git diff --name-only <remote>/<base>...HEAD` does not list that file.

The run then counts it as the environment, not as a story that did not ship. When a stage
rejected the story after every round, or its checks failed on files it changed, pass nothing
(or `--cause story`).
