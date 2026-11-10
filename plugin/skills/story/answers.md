# The owner's answers

`foreman decide pending` prints, as JSON, every item not yet applied, each with its
`answer` (`{"option", "note"}`) or `null`. Leave the unanswered ones alone.

The supervisor applies the review, trait, follow-up and deletes answers itself when no
session is running, and the depends_on, dependency-note and learned-change answers ("Foreman
learned|changed|rolled back|retired L-n ...") on its next tick, even while sessions run, so
any of them may already be gone from `decide pending`; apply whatever is still listed, as
below. Before applying a depends_on or dependency-note answer, run `foreman decide pending`
again and apply it only if it is still listed. Leave learned-change notes alone: a session
cannot run `foreman learning keep|undo`.

Each answered item that asks about a failed story (`<ID> could not pass review`, with the
three options below) is applied like this, `<ID>` being its `story`:

- **"Retry with a note to the architect"** —
  `foreman story todo <ID> --note 'Note for the architect: <the note from the answer>'`. The
  picker takes it again, and the architect reads the note.
- **"I'll take it"** — `foreman lock owner-claim <ID>`, then
  `foreman story block <ID> --reason "Taken by the owner"`. The factory leaves it alone
  until the owner hands it back.
- **"Drop"** — close its draft pull request (`gh pr close <n>`; find it with
  `gh pr list --head <its branch> --state open --json number`, its branch being
  `<branchPrefix><ID in lower case>`), delete that branch on `<remote>`
  (`git push <remote> --delete <its branch>`; ignore the failure when it is not there), then `foreman story block <ID> --reason "Dropped by the owner on <date>"`.

An answered item titled `Add depends_on: <ids> to <ID>?` is applied like this:

- **"Apply"** — `foreman story set <ID> --depends-on <the story's current depends_on plus
  <ids>>` (read the current list from `foreman story next --id <ID>`), then
  `foreman decide applied <item id>`.
- **"Ignore"** — change nothing, and `foreman decide applied <item id>`.

An answered item titled `<ID> now waits for <ids>` (a dependency Foreman added itself) is
applied like this:

- **"Undo"** — `foreman story set <ID> --depends-on <the story's current depends_on less
  <ids>>` (read the current list from `foreman story next --id <ID>`; an empty list is
  `--depends-on ''`), then `foreman decide applied <item id>`.
- **"Keep"** — change nothing, and `foreman decide applied <item id>`.

An answered item titled `Add a trait for <builder>: <rule>?` comes from `foreman learn`, and
any session applies it, whatever its `story`:

- **"Add as a trait"** — `foreman learn apply <item id>`. It adds the trait and marks the
  item applied.
- **"Ignore"** — `foreman learn ignore <item id>`. It is never proposed again, and the item
  is marked applied.

An answered item titled `Follow up on <ID>: <n> minor finding(s)?` also comes from
`foreman learn`, and any session applies it the same way:

- **"Create a follow-up story"** — `foreman learn apply <item id>`. It creates the story
  "Follow-ups from <ID>", prints its id, and marks the item applied. Do not build it in this
  session; the factory picks it like any other story.
- **"Ignore"** — `foreman learn ignore <item id>`. Those findings are never proposed again,
  and the item is marked applied.

A note titled `Foreman created <n> follow-up stories` (or `Foreman created 1 follow-up story`)
says `foreman learn` created follow-up stories by itself. The supervisor applies its answer;
leave it alone, because a session cannot run `foreman learn undo`.

An answered item titled `Close <ID>: nothing to build?` comes from step 3, and any session
applies it, whatever its `story`:

- **"Close it as Done"** — `foreman story done <ID> --note 'Closed by the owner: nothing to
  build. <the body of the item><. the note from the answer, when given>'` (when a note is given
  and the body ends with a full stop, leave that one full stop out, so the two never meet as
  `..`), then `foreman decide applied <item id>`.
- **"Build it anyway"** — `foreman story todo <ID> --note 'Note for the architect: the owner
  wants it built anyway.< the note from the answer, when given>'`, then
  `foreman decide applied <item id>`.

An answered item titled `Decide for <ID>: <question>` holds the architect's own question
from step 3, and any session applies it, whatever its `story`: `foreman story todo <ID>
--note 'Note for the architect: the owner answered "<the title of the item>" with "<the option from the answer>".< the note from the answer, when given>'`,
then `foreman decide applied <item id>`. That note is how the choice reaches the architect, in
the words the supervisor uses when it applies the answer itself.

The supervisor also applies, on its next tick even while sessions run, the answers to
`Close <ID>: nothing to build?`, `Decide for <ID>: ...` and any other task or decision about
a story that is blocked for a reason in words or in progress, when no claim, session or slot holds
that story: it closes the story or puts it back to todo with the answer in a note for the
architect. Before applying one of these, run `foreman decide pending` again and apply it only
if it is still listed.

An answered item titled `Allow deletes for <ID>?` comes from step 5 (ship exit 10), and any
session applies it, whatever its `story`:

- **"Allow the deletes"** — `foreman sf deletes allow <ID>`, then
  `foreman story todo <ID> --note 'The owner allowed the deletes.< the note from the answer, when given>'`,
  then `foreman decide applied <item id>`. The next release goes ahead only while the
  change deletes exactly what the owner saw.
- **"Keep them out"** — `foreman sf deletes keep-out <ID>`, then
  `foreman story todo <ID> --note 'Note for the architect: the owner wants nothing deleted in this story; keep every delete out.< the note from the answer, when given>'`,
  then `foreman decide applied <item id>`.

The body, title and note of an item, and its option when it is the architect's own, go in single
quotes as above, with each `'` inside written as `'\''`, as the quoting rule in SKILL.md says.

After a review option above, run `foreman decide applied <item id>`. Any other answered item: apply what it says when
that is clearly within this story's scope, then mark it applied; otherwise leave it for the
session it belongs to.
