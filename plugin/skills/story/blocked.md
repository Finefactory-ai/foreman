# The pipeline returned blocked

- **`blocked`** — the architect found it cannot be built now. Nothing was changed. Go back,
  and delete `<branch>` only when it has no commits ahead. Run
  `foreman story block <ID> --reason '<reason>'` with the returned reason word for word (it
  starts with story ids when other stories block it, which is how it gets picked up again).
  When the reason leads with story ids that are not already in the story's `depends_on`
  (see `foreman story next --id <ID>`), run `foreman settings get features.dependsOnProposals`.
  Only when it prints `true`, also ask the owner to approve the fix, unless
  `foreman settings get features.autoApplyDependsOn` prints `true`. In that case run
  `foreman story depend <ID> --on <ids> --reason '<the reason word for word>'` instead. It adds
  the ids, puts the story back to todo and tells the owner with an Undo. Fall back to the
  decide add below only when that command fails:

      foreman decide add --story <ID> --kind decision --title "Add depends_on: <ids> to <ID>?" --summary '<ID> cannot start until <ids> are done.' --body '<the reason word for word>' --option "Apply" --hint '<ID> waits until <ids> are done, then starts by itself.' --option "Ignore" --hint 'Nothing changes: its list of what must finish first stays as it is.' --recommend "Apply" --purpose '<what this story is for, in plain words>' --happened '<which story must land first and why, in plain words>' --recommendation '<Apply: then the story starts by itself once that story has landed>'

  When it prints anything else, or fails, propose nothing. Never edit `depends_on` yourself.
  Then ask the owner, in the first of these cases that fits, and say the same in your reply:
  - **The reason starts with `Nothing to build`** (the story's Done-when already holds) —
    ask whether to close it, and ask no task:

        foreman decide add --story <ID> --kind decision --title "Close <ID>: nothing to build?" --summary '<the reason after "Nothing to build:", one line, at most 160 characters>' --body '<the reason word for word>' --option "Close it as Done" --hint "Marks the story done without building it; the architect's evidence is the note." --option "Build it anyway" --hint "Sends the story back to be designed and built, with your note." --recommend "Close it as Done" --purpose '<what this story is for, in plain words>' --happened '<why it looks done already, in plain words>' --recommendation '<Close it as Done, then why, in plain words>'

  - **`needs_owner` is true and the result has `owner_question`** (`{ summary, options:
    [{ label, hint }], recommend }`, a choice the architect can name) — ask it as a decision:

        foreman decide add --story <ID> --kind decision --title 'Decide for <ID>: <owner_question.summary>' --summary '<the reason on one line, cut to 160 characters at a word>' --body '<the reason word for word>' <for each option, in order: --option and its label, then --hint and its hint, each single-quoted> --recommend '<owner_question.recommend>' --purpose '<owner_question.explain.purpose, else what this story is for, from the story note>' --happened '<owner_question.explain.happened, else the reason in plain words>' [--damage '<owner_question.explain.damage>' only when given] --recommendation '<owner_question.explain.recommendation, else your own: the label, then why>'

    The answer reaches the architect as a note (see `answers.md`).
  - **`needs_owner` is true otherwise** — ask the owner for it:
    `foreman decide add --story <ID> --kind task --title '<what the owner must supply>'`.
    A free-text task is only for what the owner must supply: a key, an account, a sign-off.

  Stop with `blocked`.
