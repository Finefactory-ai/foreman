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

Files named below sit in this skill's folder (`${CLAUDE_SKILL_DIR}`, the base directory
shown when the skill loaded). Read one only when its path happens, and read it whole. A
plain name like `failed.md` inside them is in the same folder.

Before any `foreman decide add --kind decision`, read `${CLAUDE_SKILL_DIR}/decisions.md`.

Text from the architect or from a decision item (a reason, an `owner_question`'s summary,
labels, hints and recommendation, an item's body or the owner's note) always goes in
single quotes, with each `'` inside written as `'\''`, so the shell never expands it: a
backtick or `$(…)` in it stays text and is never run. The other files call this the
quoting rule.

The release is fully automatic: a story that passes every stage and CI is merged and
released without asking. Do not stop to confirm.

End your reply with one line the supervisor reads, and nothing after it:

    FACTORY_RESULT: <shipped|ready-to-promote|blocked|failed|empty|halted|deferred|held> <story id or ->

## Where you are

The supervisor may run several stories at once, each in its own **slot**: a git worktree
of the project with its own environment, which the supervisor has already prepared. Your
environment says which: `FOREMAN_SLOT` (w1, w2 …), `FOREMAN_STATE_DIR` (the shared state
folder in the main checkout), `FOREMAN_STORY`, `FOREMAN_SUPERVISOR_PID`,
`FOREMAN_PROJECT_DIR`, `FOREMAN_TEST_CORES` (the cores this slot's test runs may use, its
share of the machine) and `FOREMAN_RUN=1`. The `foreman` command reads them by itself. Run
by hand without them, you are in slot w1 of whatever checkout you are in.

The project's `foreman.config.json`, its settings and its key files belong to the owner,
and the guard refuses a story session's writes to them. Before you run any Foreman command
for a check, or when one is refused, read `${CLAUDE_SKILL_DIR}/owner-files.md`.

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

- **The plan file**, `<state folder>/plans/<ID>.json`: the architect's plan. When a workflow
  result carries a `plan`, save it with `foreman workflow-args <ID> --save-plan` (if that
  fails, write it here as JSON). Later calls of `workflow-args <ID>` reuse it while current;
  pass `--plan` only where `deferred.md` or `fix-round.md` say.
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
`keep` or `tick` here. Undo and keep are the owner's and
refuse on the project in a story session; the tick refuses in any story session.

## 1. Before you start

- If `HALT` exists and you were not asked to release or close a story, read it, report
  what it says, and stop with `halted`. Only the owner clears it.
- The files in the config's `generated` list are rewritten by tools outside a story, so
  they are often modified when you start. Discard changes to those paths only, one by one
  (`git checkout -- <path>`); otherwise switching branch or pulling can fail on them.
- Then look at `git status`. Uncommitted changes on **this story's own branch** (you are on
  `<branch>`) are its work in progress: leave them, and the
  resume rule in step 2 carries on with them. Changes anywhere else (another branch, a
  detached checkout) are someone else's: stop with `halted` and say exactly what is there.
  Do not discard someone's work.
- Unless you are on this story's branch with work in progress, go back
  (`git fetch <remote> && git checkout --detach <remote>/<base>`). The resume rule may send
  you to an existing branch afterwards.
- Start nothing yourself: the slot's environment is the supervisor's job. If a check later
  fails because something the project needs is not running, that is a finding, not a
  reason to start or repair it. A manual check's supervisor runs only in a scratch repo under
  the system temp directory, through `foreman run --foreground`; stop it there with
  `foreman stop` before going on.
- Run `foreman decide pending`. When any item has an `answer`, read
  `${CLAUDE_SKILL_DIR}/answers.md` and apply them before you pick the story.

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
mode below), record the start first, never chained: `foreman story start <ID>`. It marks
the story in progress and tells the command centre, so your end lands on it. Agents and
`foreman ship` report their own steps; you report the commit stage and the end.

**The resume rule.** A story with history (its `status` is `in-progress`, `<branch>` exists
locally or on `<remote>`, or it has a pull request: `gh pr list --head <branch> --state all
--json number,url,state`) is looked at before anything is done: read
`${CLAUDE_SKILL_DIR}/resume.md`.

Otherwise `git checkout -B <branch> <remote>/<base>`.

A word after the id (`after-halt`, `fresh`, `group-summary` or `phase-summary`) is a mode:
read `${CLAUDE_SKILL_DIR}/modes.md` and do what it says.

## 3. Run the pipeline

`foreman workflow-args <ID>` prints the workflow's args as one line of JSON. Call the
Workflow tool with `name: "foreman:pipeline"` and `args` set to that JSON object, not a
string. Wait for its result and act only on it: while it runs, never end the story, save a
plan or ask the owner. To stop sooner, stop the workflow first. It returns `status`:

- **`passed`** — every stage approved. Add the result to the findings file: its findings
  (all minor) and its history, as above. Go to step 4.
- **`blocked`** — the architect found it cannot be built now: read
  `${CLAUDE_SKILL_DIR}/blocked.md`.
- **`deferred`** — the plan needs exclusive resources or files this slot does not hold:
  read `${CLAUDE_SKILL_DIR}/deferred.md`.
- **`rethink`** — the same kind of bug came back, or the builder found the story cannot hold
  as written: read `${CLAUDE_SKILL_DIR}/rethink.md`.
- **`failed`** — still rejected after every build round. Add the result to the findings
  file (its findings and its history, as above) and take the failed path
  (`${CLAUDE_SKILL_DIR}/failed.md`).

## 4. Commit

Report the stage first: `foreman stage commit`. Run `foreman checks --changed --reuse --start`,
then `foreman checks --wait <id>` until it prints the result (exit 75 is still running), and
read the output; a story is not committed on a stage's word. Never run a check's command by
hand or background it to a file. `--reuse` prints the tester's run when the tree is the one it
recorded and runs the checks when anything changed since (a fix round, a regenerated file); a
story is never committed without a passing full-suite result for its exact tree. If a check
fails, write the fix file with one `blocker` finding per failing check (`stage: "checks"`, the
command in `where`, what failed in `observed`) and run a fix round
(`${CLAUDE_SKILL_DIR}/fix-round.md`). Then run the checks again the same way; a second failure
takes the failed path (`${CLAUDE_SKILL_DIR}/failed.md`).

Run each `generated` entry's `regenerate` command, so the commit carries the current
version and the tree is clean for the release step. Then run
`foreman story finalize <ID> --note "<what now works, how it was verified>"`. When the
project keeps its stories in the repo, it marks the story done in this checkout and prints
the path of the file it wrote: the story file or, when pull requests merge into a branch
other than `<base>`, the story's shipped record (`<stories dir>/.shipped/<ID>.json`), which
leaves the story file alone. Either way the story reads done exactly when the pull request
merges. Otherwise it prints "nothing to change for this story source". Then
make one commit for the story, all of its files (the printed file included), message
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

For any other code, read its file whole and follow it:

- 2, CI or the checks failed: `${CLAUDE_SKILL_DIR}/ship-ci.md`
- 6, a conflict with `<base>`: `${CLAUDE_SKILL_DIR}/ship-conflict.md`
- 10, Salesforce deletes not allowed: `${CLAUDE_SKILL_DIR}/ship-deletes.md`
- 1, 3, 4 or 5, 7, 8 or 9: `${CLAUDE_SKILL_DIR}/ship-stopped.md`. On 4 or 5,
  `foreman ship` has written `HALT`: do not retry, revert or repair production.

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
neither. Foreman learns from these findings (`learning.auto`). Skip this only for `empty`,
for `group-summary`, and for a `halted` found before any story was picked.

## What you never do here

- Mark a story done that did not ship, or ship one a stage rejected.
- Weaken a test, a lint rule, a check or a CI job to get a story through.
- Read or print the project's environment file; `foreman ship` loads it.
- Edit a story file, a lock or a status file by hand; the `foreman` command does that.
- Start a second story in the same run. One story, then stop; the supervisor starts the
  next with a fresh session.
- Touch another slot's worktree, branch, claim or lock, or release a lock you did not take.
