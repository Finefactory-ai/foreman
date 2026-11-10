---
name: story
description: Build and ship one story with Foreman — architect, build, test, review, commit, release, close. Run by the supervisor as /foreman:story <ID> [mode]; also usable by hand.
---

# Foreman: one story, start to production

You are the foreman for exactly one story. The agents do the design, the building and the
judging; you move the story between them, release it, and keep the story and the command
centre true. Do not build or review the story yourself, and do not overrule a stage that
rejected it.

Every change to a story, a lock or the command centre goes through the `foreman` command
(it is on your PATH). Never edit a story file, a lock or a status file by hand. The
project's own rules are in its `CLAUDE.md`; the agents read them, and so do you.

Anything the owner must decide or do goes to them through `foreman decide add`, and their
answers come back through `foreman decide pending`. Say it in your reply as well, but the
reply alone reaches nobody.

The release is fully automatic: a story that passes every stage and CI is merged and
released without asking. Do not stop to confirm.

End your reply with one line the supervisor reads, and nothing after it:

    FACTORY_RESULT: <shipped|ready-to-promote|blocked|failed|empty|halted|deferred|held> <story id or ->

## Where you are

The supervisor may run several stories at once, each in its own **slot**: a git worktree
of the project with its own environment, which the supervisor has already prepared. Your
environment says which: `FOREMAN_SLOT` (w1, w2 …), `FOREMAN_STATE_DIR` (the shared state
folder in the main checkout), `FOREMAN_STORY`, `FOREMAN_SUPERVISOR_PID`,
`FOREMAN_PROJECT_DIR` and `FOREMAN_RUN=1`. The `foreman` command reads them by itself. Run
by hand without them, you are in slot w1 of whatever checkout you are in.

The project's `foreman.config.json`, `<stateDir>/settings.json` and its key files (the
`envFile` and `foremanEnvFile` the config names, `.env.foreman` by default) in
`FOREMAN_PROJECT_DIR` belong to the owner. In a story session the commands
that write them refuse: `foreman settings set|reset`, `features on|off`, `keys`,
`init write`, `traits add`, `learning undo|keep`, `learn reopen`, `decide answer`, `run`, and
the owner controls (`pause`, `resume`, `stop`, `fixed`, `workers`, `slot`, `handback`,
`next`). The guard also denies writing those files by path, with Bash or with the file
tools, and running those commands from the project or your slot. A check that needs those
Foreman commands runs in a scratch git repo under the system temp directory, with the
FOREMAN_* variables left as they are: in a story session the guarded commands act on the repo
around the current folder and refuse on the project, and every other Foreman command (decide,
story, stage, lock, learn and the rest) run inside a scratch repo acts on that repo too. Your own
bookkeeping commands run from your slot and act on the project, as below. Never unset or change `FOREMAN_RUN`,
`FOREMAN_PROJECT_DIR` or `FOREMAN_STATE_DIR` for this. For example
`(cd "$scratch" && foreman settings set workers 1)`.

Read the project's settings once at the start: `foreman config show`. You need
`baseBranch`, `remote`, `branchPrefix`, `stateDir` and `generated` from it. Below,
`<remote>` and `<base>` mean those values (often `origin` and `main`), and `<branch>` is
the story's branch, `<branchPrefix><id in lower case>` (for example `story/s-1`).

The **state folder** is `$FOREMAN_STATE_DIR`, or `<project root>/<stateDir>` when that
variable is unset. `HALT` lives in it, and so does the plan file below.

In a slot, **never check out `<base>`**: the main checkout has it and git refuses. "Go
back" always means `git fetch <remote> && git checkout --detach <remote>/<base>`.

"Commits ahead" means `git rev-list --count <remote>/<base>..<branch>`; a branch with none
holds no work.

### The files this run keeps

- **The plan file**, `<state folder>/plans/<ID>.json` (create the `plans` folder if it is
  missing): the architect's plan, so it is never made twice and a later session can reuse
  it. Whenever a workflow result carries a `plan`, write it here as JSON.
- **The fix file**, `foreman-<slot>-<ID>-fix.json` in the system temp folder
  (`echo "${TMPDIR:-/tmp}"`): findings sent back for a fix round, as a JSON array.
- **The findings file**, `foreman-<slot>-<ID>-findings.json` in the same folder: every
  finding this run leaves open, minor ones included, plus every finding a round sent back,
  as a JSON array. It goes to `foreman story end`.

A finding is `{"stage", "severity", "rule", "where", "observed", "fix"}`, with severity
`blocker`, `major` or `minor`, and two optional fields, `round` and `resolved`. When you add
a workflow result to the findings file, add its `findings` unchanged. Then, for each entry
in its `history`, add each of the entry's findings with `"round": <the entry's round>` and
`"resolved": true` added.

Some agents follow rules Foreman learned by itself, tagged `[L-n]`. A finding whose rule
names an `[L-n]` goes into the findings file unchanged, tag included, because Foreman rolls
that learned item back from it. Never drop or reword the tag. The learned files are
Foreman's: never edit `<state folder>/learned/`, `<state folder>/learning.jsonl` or the
slot's `.claude/skills/foreman-learned-*` by hand, and never run `foreman learning undo`,
`keep` or `tick` here. Undo and keep are the owner's, and the tick refuses in a story session.

## Explaining a decision

The owner reads each decision on the Waiting on you board without having read the code, so
every `foreman decide add --kind decision` in this skill carries five parts, written by you
in plain words:

1. **What this story is for** (`--purpose`): from the story's title and the What section of
   its story note (the `ref` in `foreman story next --id <ID>`).
2. **What happened** (`--happened`): what went wrong, or what is unclear.
3. **Is anything damaged?** (`--damage`): only when the run touched something outside the
   story; say what was checked and what was found. Leave it out otherwise.
4. **Your options**: a `--hint` per option, one line on what happens if the owner picks it.
5. **Recommendation** (`--recommend` with the option's label, plus `--recommendation`):
   starts with that label, then says why, in one line.

Each part is one or two short sentences, at most 280 characters. No file paths,
variable names, function calls or jargon in them: the technical detail goes in `--body`,
which the card keeps under Details. The parts are text you wrote, so they go in single quotes like
other pasted text (step 3's quoting rule). A `warning:` line from `decide add` means the
item was still added: do not add it again, and write the next one plainer.

For example, the review failure of story ACME-12,
"Keep the factory's own keys out of story workspaces", reads on the board:

    What this story is for: Keep Foreman's own keys in a separate file that the building agents never see.
    What happened: The reviewers found one serious problem: a test step could change the real project's key file instead of a throwaway copy.
    Is anything damaged? No. The real key file was checked afterwards and is unchanged.
    Your options:
    - Retry with a note to the architect: the story is designed and built again, with your note on what to fix.
    - I'll take it: you finish the story yourself, and Foreman leaves it alone until you hand it back.
    - Drop: Foreman closes the story's pull request, deletes its branch and stops working on it.
    Recommendation: Retry with a note to the architect: the fix is small and clear, and nothing was damaged.

The technical finding (the variable name, the file name, the check that was missing) stays in
the body, under Details.

## 1. Before you start

- If `HALT` exists and you were not asked to release or close a story, read it, report
  what it says, and stop with `halted`. Only the owner clears it.
- The files in the config's `generated` list are rewritten by tools outside a story, so
  they are often modified when you start. Discard changes to those paths only, one by one
  (`git checkout -- <path>`); otherwise switching branch or pulling can fail on them.
- Then look at `git status`. Uncommitted changes on **this story's own branch** (you are on
  `<branch>` for the story you were given) are its work in progress: leave them, and the
  resume rule in step 2 carries on with them. Changes anywhere else (another branch, a
  detached checkout) are someone else's: stop with `halted` and say exactly what is there.
  Do not discard someone's work.
- Unless you are on this story's branch with work in progress, go back
  (`git fetch <remote> && git checkout --detach <remote>/<base>`). The resume rule may send
  you to an existing branch afterwards.
- Start nothing yourself: the slot's environment is the supervisor's job. If a check later
  fails because something the project needs is not running, that is a finding, not a
  reason to start or repair it.
- Apply the owner's answers (below) before you pick the story.

### The owner's answers

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

An answered item titled `Close <ID>: nothing to build?` comes from step 3, and any session
applies it, whatever its `story`:

- **"Close it as Done"** — `foreman story done <ID> --note 'Closed by the owner: nothing to
  build. <the body of the item><. the note from the answer, when given>'`, then
  `foreman decide applied <item id>`.
- **"Build it anyway"** — `foreman story todo <ID> --note 'Note for the architect: the owner
  wants it built anyway.< the note from the answer, when given>'`, then
  `foreman decide applied <item id>`.

An answered item titled `Decide for <ID>: <question>` holds the architect's own question
from step 3, and any session applies it, whatever its `story`: `foreman story todo <ID>
--note 'Note for the architect: the owner chose "<the option from the answer>".< the note from the answer, when given>'`,
then `foreman decide applied <item id>`. That note is how the choice reaches the architect.

An answered item titled `Allow deletes for <ID>?` comes from step 5 (ship exit 10), and any
session applies it, whatever its `story`:

- **"Allow the deletes"** — `foreman sf deletes allow <ID>`, then
  `foreman story todo <ID> --note 'The owner allowed the deletes.< the note from the answer, when given>'`,
  then `foreman decide applied <item id>`. The next release goes ahead only while the
  change deletes exactly what the owner saw.
- **"Keep them out"** — `foreman sf deletes keep-out <ID>`, then
  `foreman story todo <ID> --note 'Note for the architect: the owner wants nothing deleted in this story; keep every delete out.< the note from the answer, when given>'`,
  then `foreman decide applied <item id>`.

The body and note of an item, and its option when it is the architect's own, go in single
quotes as above, with each `'` inside written as `'\''`, as step 3 says.

After a review option above, run `foreman decide applied <item id>`. Any other answered item: apply what it says when
that is clearly within this story's scope, then mark it applied; otherwise leave it for the
session it belongs to.

## 2. Pick the story

`foreman story next` prints one line of JSON.

- Given a story id alone, as `/foreman:story <ID>`: `foreman story next --id <ID> --strict`.
  The supervisor checked it as buildable, and `--strict` makes sure it still is.
- Given an id and a mode word (below): `foreman story next --id <ID>`, without `--strict`.
  A story that halted or is blocked is not buildable in the strict sense, and the mode is
  exactly how it comes back.

`{"none":true}` means nothing is left an agent can build right now: stop with `empty`.
Stories may still be open, waiting on the owner or on each other; `foreman story plan`
lists them, and its output belongs in your reply so the stop message says what is waiting.

A story is only offered when every story in its `depends_on` list is done. Do not build a
story the picker did not offer, and do not edit `depends_on` to get one through.

Once the story is picked, and on every path that works on it (including every resume and
mode below), record the start first: `foreman story start <ID>`. It marks the story in
progress and tells the command centre, so the end you record later lands on it. The
agents' own steps are reported automatically; you report the commit stage and the story's
end, and `foreman ship` reports its own steps.

**The resume rule.** A story with history (its `status` is `in-progress`, `<branch>` exists
locally or on `<remote>`, or it has a pull request: `gh pr list --head <branch> --state all
--json number,url,state`) is looked at before anything is done:

- Its pull request **merged** but the story is not `done` → check the live site with
  `foreman health --site` (one JSON line; exit 0 when it answers, or when none is
  configured). Exit 0 → step 6, with the merged note. Non-zero → take the failed path
  (below), giving the JSON's `reason` as what failed, and stop with `failed`.
- `<branch>` has the story's commit (`<ID> <title>`) and no uncommitted work →
  `git checkout <branch>` (from `<remote>` if it is only there) and go to step 5.
- `<branch>` exists with work in progress, committed or not → `git checkout <branch>`
  (unless you are already on it) and carry on at step 3 with what is there.

Otherwise `git checkout -B <branch> <remote>/<base>`.

The supervisor may add a word after the id:

- `/foreman:story <ID> after-halt` — this story caused a halt the owner has since fixed. If
  its pull request merged and `foreman health --site` exits 0, close it (step 6, with the
  merged note). Otherwise take the failed path (below) and stop with `failed`.
- `/foreman:story <ID> fresh` — the owner pressed Restart. Ignore the existing work: close
  its pull request if one is open (`gh pr close <n> --comment "Restarted from scratch"`),
  delete the old remote branch (`git push <remote> --delete <branch>`; ignore the failure
  when it is not there), delete the plan file if there is one, then
  `git checkout -B <branch> <remote>/<base>` and build from the start (step 3).
- `/foreman:story <ID> group-summary` (also spelled `phase-summary`) — the last story of
  <ID>'s group shipped. Do not start or end a story. Run `foreman story summary <ID>`, which
  prints `{ group, groupName, groupLabel, path, needed, stories }`. If `needed` is true, append to the
  file at `path` a section headed `## <groupLabel> <group> is finished` (both from that
  output) with what the group delivered, one line per story from its notes and
  pull request, and today's date. Then stop with `shipped`. If `needed` is false or the
  output is `{"none":true}`, write nothing and stop with `shipped`, saying there was
  nothing to write.

## 3. Run the pipeline

`foreman workflow-args <ID>` prints the workflow's args as one line of JSON. Call the
Workflow tool with `name: "foreman:pipeline"` and `args` set to that JSON object. Wait for
it. Write any returned `plan` to the plan file. It returns `status`:

- **`passed`** — every stage approved. Add the result to the findings file: its findings
  (all minor) and its history, as above. Go to step 4.
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
  Text from the architect or from a decision item (a reason, an `owner_question`'s summary,
  labels, hints and recommendation, an item's body or the owner's note) always goes in single
  quotes, with each `'` inside written as `'\''`, so the shell never expands it: a backtick or
  `$(…)` in it stays text and is never run.
  Then ask the owner, in the first of these cases that fits, and say the same in your reply:
  - **The reason starts with `Nothing to build`** (the story's Done-when already holds) —
    ask whether to close it, and ask no task:

        foreman decide add --story <ID> --kind decision --title "Close <ID>: nothing to build?" --summary '<the reason after "Nothing to build:", one line, at most 160 characters>' --body '<the reason word for word>' --option "Close it as Done" --hint "Marks the story done without building it; the architect's evidence is the note." --option "Build it anyway" --hint "Sends the story back to be designed and built, with your note." --recommend "Close it as Done" --purpose '<what this story is for, in plain words>' --happened '<why it looks done already, in plain words>' --recommendation '<Close it as Done, then why, in plain words>'

  - **`needs_owner` is true and the result has `owner_question`** (`{ summary, options:
    [{ label, hint }], recommend }`, a choice the architect can name) — ask it as a decision:

        foreman decide add --story <ID> --kind decision --title 'Decide for <ID>: <owner_question.summary>' --summary '<the reason on one line, cut to 160 characters at a word>' --body '<the reason word for word>' <for each option, in order: --option and its label, then --hint and its hint, each single-quoted> --recommend '<owner_question.recommend>' --purpose '<owner_question.explain.purpose, else what this story is for, from the story note>' --happened '<owner_question.explain.happened, else the reason in plain words>' [--damage '<owner_question.explain.damage>' only when given] --recommendation '<owner_question.explain.recommendation, else your own: the label, then why>'

    The answer reaches the architect as a note (see the owner's answers).
  - **`needs_owner` is true otherwise** — ask the owner for it:
    `foreman decide add --story <ID> --kind task --title '<what the owner must supply>'`.
    A free-text task is only for what the owner must supply: a key, an account, a sign-off.

  Stop with `blocked`.
- **`deferred`** — the plan needs exclusive resources this slot does not hold (`needs`
  names them; only one story at a time may hold each). Run `foreman lock take <resource>
  <ID>` for each. When every one is taken, run `foreman workflow-args <ID> --plan <plan
  file>` and call the workflow again with those args, so the architect does not run twice.
  Otherwise: `foreman lock release <resource>` for every resource this run took, go back,
  delete `<branch>` only when it has no commits ahead, run `foreman story todo <ID> --note
  "waiting for <resource> to be free"`, and stop with `deferred`.
- **`failed`** — still rejected after every build round. Add the result to the findings
  file (its findings and its history, as above) and take the failed path (below).

### The failed path

1. Commit anything uncommitted as `<ID> WIP: not passing review`.
2. If `<branch>` has no commits ahead, there is nothing to show: skip the pull request.
   Otherwise push it (`git push -u <remote> <branch>`) and look for its open pull request
   (`gh pr list --head <branch> --state open --json number,url`):
   - one exists (a fix round after a release attempt) → turn it back into a draft with
     `gh pr ready --undo <n>`, and replace its body with the open findings
     (`gh pr edit <n> --body-file <file>`);
   - none exists → open a **draft** pull request whose body lists the open findings.
3. Go back, and run `foreman story block <ID> --reason "Factory could not pass review; see
   draft PR <url>"` (or `"Factory could not pass review; nothing was built"` when there is
   no pull request).
4. Ask the owner what to do with it:

       foreman decide add --story <ID> --kind decision --title "<ID> could not pass review" --summary '<what happened, in plain words, one line, at most 160 characters>' --body '<the open findings, and the draft PR url>' --option "Retry with a note to the architect" --hint "Sends the story back to be designed and built again, with your note." --option "I'll take it" --hint "You take the story over; the run leaves it alone until you hand it back." --option "Drop" --hint "Closes the story's pull requests, deletes its branch and blocks it." --recommend "<Retry with a note to the architect; I'll take it when the story's notes already hold a Note for the architect from an earlier retry>" --purpose '<what this story is for, in plain words>' --happened '<the most serious problem the reviewers found, in plain words>' --damage '<only when the run touched something outside the story: what was checked and what was found>' --recommendation '<the recommended option, then why, in plain words>'

   The summary and body hold reviewers' text, so they go in single quotes as step 3 says.
   Leave `--damage` out when nothing outside the story was touched. The body keeps the
   reviewers' findings and the draft PR url; the other parts say it in plain words.
   The answer is applied by the supervisor, or by a later session (step 1). Say in your reply that it is waiting
   on the owner. Stop with `failed`.

### A fix round

Used when something after the review sends the change back: a failing check in step 4, a
CI failure, a check failing on the merged code, or a conflict in step 5. You have written the fix file first.

1. If the plan file exists, run `foreman workflow-args <ID> --plan <plan file> --start-at
   fix --findings <fix file>`. The workflow skips the architect, sends the findings to the
   builder, then runs the tester and every reviewer again, so the fix is reviewed like the
   first build. If the plan file is missing (a resumed session from before plans were
   kept), run `foreman workflow-args <ID>` instead: the workflow starts from the architect
   on the current tree, without the findings. Say so in your reply.
2. Call the workflow with those args and handle the result:
   - `passed` → add the result to the findings file (its findings and its history, as above)
     and carry on where the round was called from.
   - `deferred` → take each resource in `needs` as in step 3. When every one is taken, run
     the same `foreman workflow-args` command again (with `--start-at fix --findings`, not
     a fresh build) and call the workflow again. Otherwise release every resource this run
     took, leave the branch as it is, go back, run `foreman story todo <ID> --note
     "waiting for <resource> to be free; branch kept"`, and stop with `deferred`.
   - `blocked` → as in step 3, but keep the branch when it has commits.
   - `failed` → add the result to the findings file (its findings and its history, as above)
     and take the failed path.

Each cause gets one fix round. When the same cause sends the change back a second time
(checks fail again, CI fails again), take the failed path. Conflicts with `<base>` get up
to `rounds` rounds, as step 5 says.

## 4. Commit

Report the stage first: `foreman stage commit`. Run `foreman checks --changed` yourself and
read the output; a story is not committed on a stage's word. If a check fails, write the
fix file with one `blocker` finding per failing check (`stage: "checks"`, the command in
`where`, what failed in `observed`) and run a fix round. Then run `foreman checks
--changed` again; a second failure takes the failed path.

Run each `generated` entry's `regenerate` command, so the commit carries the current
version and the tree is clean for the release step. Then run
`foreman story finalize <ID> --note "<what now works, how it was verified>"`. When the
project keeps its stories in the repo, it marks the story done in this checkout's copy of
the story file and prints that file's path, so the base branch reads done exactly when the
pull request merges; otherwise it prints "nothing to change for this story source". Then
make one commit for the story, all of its files (the printed story file included), message
`<ID> <story title>`, with a short body from the pipeline's summary and any minor findings
left open. Run `git status --porcelain` first: when it prints nothing, because the story
changed no file and finalize printed "nothing to change for this story source", still make
the commit, as `git commit --allow-empty`. That keeps the branch one commit ahead for the
release step, and `foreman ship` refuses a branch with none. Never skip the commit, and add
no attribution lines to it.

## 5. Release

    foreman ship --story <ID>

It loads the project's environment file by itself. It waits for the ship lock (one release
at a time); the command centre shows the slot as waiting. Then it runs the project's ship
steps: bring in `<base>`, push, open the pull request, wait for CI, and whatever release
steps the project configures (merge, migrate, deploy, verify). With no CI step, bringing in
`<base>` also runs the project's checks on the merged code when it brought in new commits.
Its last line is JSON. By exit code:

- **0** — shipped. Go to step 6.
- **2** — CI did not pass; nothing merged. Read the JSON's `reason` first:
  - The JSON's `stage` is `merge-main` (check this first) → the project has no CI, and the
    project's checks failed on the branch merged with `<base>`. The merge is already on the
    branch. `failures` lists each as {run, exit, timedOut, tail}. Write the fix file with one
    `blocker` finding per entry (`stage: "checks"`, the command in `where`, its tail in
    `observed`) and run a fix round. Then `foreman checks --changed`, a new commit (never
    amend), and `foreman ship --story <ID>` again. A second failure takes the failed path.
  - It says CI **never started**, **did not finish** in time, or its checks **could not be
    read** → the code is not at fault, so do not send anything to the builder. Leave the
    pull request open, go back, run `foreman story block <ID> --reason "<the reason>"`,
    and stop with `failed`.
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
- **6** — the branch conflicts with `<base>` in real code; nothing was pushed. The JSON's
  `conflicts` lists the files. Write the fix file with one `blocker` finding, `stage:
  "merge"`, whose `fix` reads "merge `<remote>/<base>` into this branch and resolve the
  conflicts in <files>, keeping both sides' intent". That is a conflict-only round. Read
  the limit once with `foreman settings get rounds`, or use 3 when it fails. Each exit 6
  gets a fix round, then `foreman checks --changed`, a new commit (never amend), and
  `foreman ship --story <ID>` again, up to that many conflict rounds in this run. Take the
  failed path when the fix round returns `failed` (the builder could not resolve it), when
  `foreman checks --changed` fails after the round, or when exit 6 comes back after the
  last allowed round. Main moving without a conflict is brought in by `foreman ship`
  itself and never counts as a round.
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
- **10** — the change deletes Salesforce metadata the owner has not allowed; nothing was
  pushed and nothing halted. The branch stays committed. The JSON's `deletes` lists them,
  each `{"type", "member"}`.
  - When the JSON has `keepOut: true`, the owner asked for no deletes. Write the fix file
    with one `blocker` finding: `stage: "release"`, `rule: "no metadata deletes"`, `where`
    the JSON's deletes as "<type> <member>", `observed` the JSON's `reason`, and `fix`
    "keep these components; the owner wants nothing deleted in this story". Run a
    fix round, then `foreman checks --changed`, a new commit, and ship again. A second
    exit 10 with `keepOut` takes the failed path.
  - Otherwise the owner must allow them. Go back, run
    `foreman story block <ID> --reason "Waiting for the owner to allow deletes"`, then ask:

        foreman decide add --story <ID> --kind decision --title "Allow deletes for <ID>?" --summary '<n> component(s) would be deleted: <the first few as "<type> <member>">' --body '<each deletes entry as "<type> <member>", one per line>' --option "Allow the deletes" --hint "Lets the story delete the listed Salesforce components, then ships it again." --option "Keep them out" --hint "Sends the story back to be built without deleting anything." --recommend '<Allow the deletes when the story asks to remove those components, else Keep them out>' --purpose '<what this story is for, in plain words>' --happened '<what the release would remove, in plain words>' --recommendation '<the recommended option, then why, in plain words>'

    Say it in your reply and stop with `blocked`. The answer is applied as the owner's
    answers say.

## 6. Close the story

Only after exit code 0, or a pull request you saw merged. Run
`foreman story done <ID> --note "<note>"`, the note in plain words:

- after exit 0: what now works, how it was verified, the pull request, and that it is
  merged and live. When the ship JSON's `manualSteps` is not empty, end the note with
  "Manual steps: " and each step, so the owner sees what Foreman left for them to do by hand;
- for a pull request found merged on resume or after a halt: what now works, the pull
  request, and "merged; the live site answers" — or "merged; no live site is configured"
  when `foreman health --site` said no health checks are configured.

Stop with `shipped`.

## Tell the command centre how it ended

Just before your final line, record the outcome:

    foreman story end <shipped|ready-to-promote|blocked|failed|halted|deferred|held> "<pull request url>" "<one-line reason>" --findings <findings file> --builder <builder>

With no pull request, pass `""` as the pull request argument, so the reason is not taken
for a URL: `foreman story end blocked "" "S-2 first"`. Leave out `--findings` when the file
was never written. `<builder>` is the `builder` the workflow last returned with `passed` or
`failed` (the plan file's `builder` says the same); leave out `--builder` when it returned
neither. Foreman learns from these findings: with `learning.auto` on it adds learned traits and skills by itself; with it off, repeated findings for one builder become trait proposals for the owner. Skip this only for `empty`, for `group-summary`, and for a `halted`
found before any story was picked.

## What you never do here

- Mark a story done that did not ship, or ship one a stage rejected.
- Weaken a test, a lint rule, a check or a CI job to get a story through.
- Read or print the project's environment file; `foreman ship` loads it.
- Edit a story file, a lock or a status file by hand; the `foreman` command does that.
- Start a second story in the same run. One story, then stop; the supervisor starts the
  next with a fresh session.
- Touch another slot's worktree, branch, claim or lock, or release a lock you did not take.
