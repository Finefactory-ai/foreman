// The story skill keeps its main path in SKILL.md and each rare path in a file next to it,
// which the session reads only when that path happens. These tests hold the split to its
// promises: SKILL.md stays small, every rule the skill held before the split is still in one
// of its files, a shipped story needs SKILL.md alone, and the rare paths are reachable.

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RARE, SKILL_DIR, allText, skillFile } from './story-skill.mjs';

const BEFORE = readFileSync(fileURLToPath(new URL('./fixtures/story-skill-before-split.md', import.meta.url)), 'utf8');
const collapse = (s) => s.replace(/\s+/g, ' ').trim();
const DIR = '${CLAUDE_SKILL_DIR}/';

// The skill before the split, cut into units: paragraphs, then list items, without their
// markers, with whitespace collapsed. Headings are left out: they only name sections.
const units = (md) =>
  md
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .split(/\n\s*\n/)
    .flatMap((b) => b.split(/\n(?=\s*(?:- |\d+\. ))/))
    .map((u) => u.replace(/^\s*(?:- |\d+\. )/, '').replace(/\s+/g, ' ').trim())
    .filter((u) => u && !u.startsWith('#'));

// Units whose wording changed in the split: only pointers to text that moved, and the
// quoting rule taken out of the blocked bullet into SKILL.md. Rules changed by a later story
// are listed too, with the story that changed them. Old unit → its new text.
// Since FM-277 the fix round and the failed path point at the file holding the text, not
// "as above" or a step number.
const REWORDED = {
  // Step 2: since FM-348 the start runs as a command of its own; the plan check went when
  // workflow-args began reusing the saved plan by itself.
  "Once the story is picked, and on every path that works on it (including every resume and mode below), record the start first: `foreman story start <ID>`. It marks the story in progress and tells the command centre, so the end you record later lands on it. The agents' own steps are reported automatically; you report the commit stage and the story's end, and `foreman ship` reports its own steps.":
    "Once the story is picked, and on every path that works on it (including every resume and mode below), record the start first, never chained: `foreman story start <ID>`. It marks the story in progress and tells the command centre, so your end lands on it. Agents and `foreman ship` report their own steps; you report the commit stage and the end.",
  // Where you are: the owner's files moved out, so "as below" now means SKILL.md.
  "The project's `foreman.config.json`, `<stateDir>/settings.json` and its key files (the `envFile` and `foremanEnvFile` the config names, `.env.foreman` by default) in `FOREMAN_PROJECT_DIR` belong to the owner. In a story session the commands that write them refuse: `foreman settings set|reset`, `features on|off`, `keys`, `init write`, `traits add`, `learning undo|keep`, `learn reopen`, `decide answer`, `run`, and the owner controls (`pause`, `resume`, `stop`, `fixed`, `workers`, `slot`, `handback`, `next`). The guard also denies writing those files by path, with Bash or with the file tools, and running those commands from the project or your slot. A check that needs those Foreman commands runs in a scratch git repo under the system temp directory, with the FOREMAN_* variables left as they are: in a story session the guarded commands act on the repo around the current folder and refuse on the project, and every other Foreman command (decide, story, stage, lock, learn and the rest) run inside a scratch repo acts on that repo too. Your own bookkeeping commands run from your slot and act on the project, as below. Never unset or change `FOREMAN_RUN`, `FOREMAN_PROJECT_DIR` or `FOREMAN_STATE_DIR` for this. For example `(cd \"$scratch\" && foreman settings set workers 1)`.":
    "The project's `foreman.config.json`, `<stateDir>/settings.json` and its key files (the `envFile` and `foremanEnvFile` the config names, `.env.foreman` by default) in `FOREMAN_PROJECT_DIR` belong to the owner. In a story session the commands that write them refuse: `foreman settings set|reset`, `features on|off`, `keys`, `init write`, `traits add`, `learning undo|keep`, `learn reopen`, `decide answer`, `run`, and the owner controls (`pause`, `resume`, `stop`, `fixed`, `workers`, `slot`, `handback`, `next`). The guard also denies writing those files by path, with Bash or with the file tools, and running those commands from the project or your slot. A check that needs those Foreman commands runs in a scratch git repo under the system temp directory, with the FOREMAN_* variables left as they are: in a story session the guarded commands act on the repo around the current folder and refuse on the project, and every other Foreman command (decide, story, stage, lock, learn and the rest) run inside a scratch repo acts on that repo too. Your own bookkeeping commands run from your slot and act on the project, as SKILL.md says. Never unset or change `FOREMAN_RUN`, `FOREMAN_PROJECT_DIR` or `FOREMAN_STATE_DIR` for this. For example `(cd \"$scratch\" && foreman settings set workers 1)`.",
  // Explaining a decision: the quoting rule now sits in SKILL.md.
  "Each part is one or two short sentences, at most 280 characters. No file paths, variable names, function calls or jargon in them: the technical detail goes in `--body`, which the card keeps under Details. The parts are text you wrote, so they go in single quotes like other pasted text (step 3's quoting rule). A `warning:` line from `decide add` means the item was still added: do not add it again, and write the next one plainer.":
    "Each part is one or two short sentences, at most 280 characters. No file paths, variable names, function calls or jargon in them: the technical detail goes in `--body`, which the card keeps under Details. The parts are text you wrote, so they go in single quotes like other pasted text (the quoting rule in SKILL.md). A `warning:` line from `decide add` means the item was still added: do not add it again, and write the next one plainer.",
  // Step 1: the answers are read from their own file, only when there are any.
  "Apply the owner's answers (below) before you pick the story.":
    "Run `foreman decide pending`. When any item has an `answer`, read `${CLAUDE_SKILL_DIR}/answers.md` and apply them before you pick the story.",
  // The owner's answers: the quoting rule now sits in SKILL.md. Since FM-312 the title goes in the
  // Decide-for note too.
  "The body and note of an item, and its option when it is the architect's own, go in single quotes as above, with each `'` inside written as `'\\''`, as step 3 says.":
    "The body, title and note of an item, and its option when it is the architect's own, go in single quotes as above, with each `'` inside written as `'\\''`, as the quoting rule in SKILL.md says.",
  // Step 1: the branch is the story's own, so the clause saying so went (FM-341 made room).
  "Then look at `git status`. Uncommitted changes on **this story's own branch** (you are on `<branch>` for the story you were given) are its work in progress: leave them, and the resume rule in step 2 carries on with them. Changes anywhere else (another branch, a detached checkout) are someone else's: stop with `halted` and say exactly what is there. Do not discard someone's work.":
    "Then look at `git status`. Uncommitted changes on **this story's own branch** (you are on `<branch>`) are its work in progress: leave them, and the resume rule in step 2 carries on with them. Changes anywhere else (another branch, a detached checkout) are someone else's: stop with `halted` and say exactly what is there. Do not discard someone's work.",
  // Step 2: the resume rule and the after-halt mode name the failed path by file.
  // Since FM-406 the resume rule's cases sit in resume.md, which names files plainly.
  // Since FM-449 a rolled-back release is rebuilt after a halt, and a release failure is never a
  // review decision. Since FM-451 the block reason is quoted as the quoting rule says.
  "Its pull request **merged** but the story is not `done` → check the live site with `foreman health --site` (one JSON line; exit 0 when it answers, or when none is configured). Exit 0 → step 6, with the merged note. Non-zero → take the failed path (below), giving the JSON's `reason` as what failed, and stop with `failed`.":
    "Its pull request **merged** but the story is not `done` → check the live site with `foreman health --site` (one JSON line; exit 0 when it answers, or when none is configured). Exit 0 → step 6, with the merged note. Non-zero → the release failed, not the review: go back, run `foreman story block <ID> --reason '<the JSON's reason>'`, with the reason in single quotes and each `'` inside written as `'\\''`, as the quoting rule in SKILL.md says, and stop with `failed`, ending with that reason. Never take the failed path (`failed.md`) for it, and file no decision yourself: the supervisor asks the owner \"<ID> could not be released\" from that reason.",
  // Since FM-441 a rolled-back release is never closed; since FM-445 that case comes before the
  // close rule. Since FM-449 a rolled-back release is rebuilt after a halt, and a release failure is
  // never a review decision. Since FM-451 the rolled-back rebuild defers to resume.md's branch
  // condition, and the block reason is quoted as the quoting rule says.
  "`/foreman:story <ID> after-halt` — this story caused a halt the owner has since fixed. If its pull request merged and `foreman health --site` exits 0, close it (step 6, with the merged note). Otherwise take the failed path (below) and stop with `failed`.":
    "`/foreman:story <ID> after-halt` — this story caused a halt the owner has since fixed; the run cleared it only after `foreman health` passed. Act on what is true now, never on the earlier run's failure text: its blocked reason, its ship JSON and any earlier decision may be stale. When the story JSON has `rolledBackAt` and its pull request merged before that time (`resume.md` says how to tell), the release was rolled back: do not close it, and ask the owner nothing. Follow `resume.md`'s rolled-back paragraph: when `<branch>` is missing or holds only the merged work, it builds the story again from scratch and has you go to step 3; when `<branch>` holds the new build's own work, it keeps that work. Otherwise, if its pull request merged and `foreman health --site` exits 0, close it (step 6, with the merged note). Otherwise the release did not go through: go back, run `foreman story block <ID> --reason '<what is true now: the pull request is not merged, or the health JSON's reason>'`, with the reason in single quotes and each `'` inside written as `'\\''`, as the quoting rule in SKILL.md says, and stop with `failed`, ending with that reason. A release failure must never take the failed path (`failed.md`) or be filed as \"could not pass review\": file no decision yourself, because the supervisor asks the owner \"<ID> could not be released\" from the reason you end with.",
  // Step 3: the quoting rule left the blocked bullet for SKILL.md; the answers have a file.
  "When it prints anything else, or fails, propose nothing. Never edit `depends_on` yourself. Text from the architect or from a decision item (a reason, an `owner_question`'s summary, labels, hints and recommendation, an item's body or the owner's note) always goes in single quotes, with each `'` inside written as `'\\''`, so the shell never expands it: a backtick or `$(…)` in it stays text and is never run. Then ask the owner, in the first of these cases that fits, and say the same in your reply:":
    "When it prints anything else, or fails, propose nothing. Never edit `depends_on` yourself. Then ask the owner, in the first of these cases that fits, and say the same in your reply:",
  "The answer reaches the architect as a note (see the owner's answers).":
    "The answer reaches the architect as a note (see `answers.md`).",
  // Step 3's blocked task bullet: since FM-442 every task offers "Retry the story" and "Close the
  // task", so the bullet says to give a task no option instead of calling it free-text.
  "**`needs_owner` is true otherwise** — ask the owner for it: `foreman decide add --story <ID> --kind task --title '<what the owner must supply>'`. A free-text task is only for what the owner must supply: a key, an account, a sign-off.":
    "**`needs_owner` is true otherwise** — ask the owner for it: `foreman decide add --story <ID> --kind task --title '<what the owner must supply>'`. A task is only for what the owner must supply: a key, an account, a sign-off. Give a task no `--option`: every task offers \"Retry the story\" and \"Close the task\", and the story is retried only when the owner picks the first.",
  // Step 3's deferred bullet: since FM-259 the plan may also name files, claimed with
  // `foreman lock files`.
  "**`deferred`** — the plan needs exclusive resources this slot does not hold (`needs` names them; only one story at a time may hold each). Run `foreman lock take <resource> <ID>` for each. When every one is taken, run `foreman workflow-args <ID> --plan <plan file>` and call the workflow again with those args, so the architect does not run twice. Otherwise: `foreman lock release <resource>` for every resource this run took, go back, delete `<branch>` only when it has no commits ahead, run `foreman story todo <ID> --note \"waiting for <resource> to be free\"`, and stop with `deferred`.":
    "**`deferred`** — the plan needs exclusive resources this slot does not hold (`needs` names them; only one story at a time may hold each), names files this slot has not claimed (`files`; two stories running at once never change the same file), or both. Run `foreman lock take <resource> <ID>` for each resource in `needs`. When one cannot be taken: `foreman lock release <resource>` for every resource this run took, go back, delete `<branch>` only when it has no commits ahead, run `foreman story todo <ID> --note \"waiting for <resource> to be free\"`, and stop with `deferred`. When every one is taken and `files` is not empty, run `foreman lock files <ID> --plan <plan file>`. The plan file is `<state folder>/plans/<ID>.json`: when the result carried a `plan`, save it first with `foreman workflow-args <ID> --save-plan`, as SKILL.md says; when it carried none, an earlier session saved it and `workflow-args` reused it, so it is already there. It prints one line of JSON and exits:",
  // Since FM-342 the plan goes by file and is saved with --save-plan: SKILL.md's plan file
  // bullet and step 3, and the fix round's call.
  "**The plan file**, `<state folder>/plans/<ID>.json` (create the `plans` folder if it is missing): the architect's plan, so it is never made twice and a later session can reuse it. Whenever a workflow result carries a `plan`, write it here as JSON.":
    "**The plan file**, `<state folder>/plans/<ID>.json`: the architect's plan. When a workflow result carries a `plan`, save it with `foreman workflow-args <ID> --save-plan` (if that fails, write it here as JSON). Later calls of `workflow-args <ID>` reuse it while current; pass `--plan` only where `deferred.md` or `fix-round.md` say.",
  // Since FM-347 step 3 waits for the workflow before ending the story, saving a plan or asking the owner.
  "`foreman workflow-args <ID>` prints the workflow's args as one line of JSON. Call the Workflow tool with `name: \"foreman:pipeline\"` and `args` set to that JSON object. Wait for it. Write any returned `plan` to the plan file. It returns `status`:":
    "`foreman workflow-args <ID>` prints the workflow's args as one line of JSON. Call the Workflow tool with `name: \"foreman:pipeline\"` and `args` set to that JSON object, not a string. Wait for its result and act only on it: while it runs, never end the story, save a plan or ask the owner. To stop sooner, stop the workflow first. It returns `status`:",
  "Call the workflow with those args and handle the result:":
    "Call the workflow with the object it printed (the plan reaches the agents by file; the result carries none to save) and handle the result:",
  // Step 3's failed bullet names the failed path's file.
  "**`failed`** — still rejected after every build round. Add the result to the findings file (its findings and its history, as above) and take the failed path (below).":
    "**`failed`** — still rejected after every build round. Add the result to the findings file (its findings and its history, as above) and take the failed path (`${CLAUDE_SKILL_DIR}/failed.md`).",
  // The failed path: the fix round by file, the quoting rule in SKILL.md.
  "one exists (a fix round after a release attempt) → turn it back into a draft with `gh pr ready --undo <n>`, and replace its body with the open findings (`gh pr edit <n> --body-file <file>`);":
    "one exists (a fix round after a release attempt, `fix-round.md`) → turn it back into a draft with `gh pr ready --undo <n>`, and replace its body with the open findings (`gh pr edit <n> --body-file <file>`);",
  "The summary and body hold reviewers' text, so they go in single quotes as step 3 says. Leave `--damage` out when nothing outside the story was touched. The body keeps the reviewers' findings and the draft PR url; the other parts say it in plain words. The answer is applied by the supervisor, or by a later session (step 1). Say in your reply that it is waiting on the owner. Stop with `failed`.":
    "The summary and body hold reviewers' text, so they go in single quotes as the quoting rule in SKILL.md says. Leave `--damage` out when nothing outside the story was touched. The body keeps the reviewers' findings and the draft PR url; the other parts say it in plain words. The answer is applied by the supervisor, or by a later session (see `answers.md`). Say in your reply that it is waiting on the owner. Stop with `failed`.",
  // A fix round: deferred, blocked and the failed path by file; deferred also claims
  // files since FM-259.
  "`passed` → add the result to the findings file (its findings and its history, as above) and carry on where the round was called from.":
    "`passed` → add the result to the findings file (its findings and its history, as SKILL.md says) and carry on where the round was called from.",
  "`deferred` → take each resource in `needs` as in step 3. When every one is taken, run the same `foreman workflow-args` command again (with `--start-at fix --findings`, not a fresh build) and call the workflow again. Otherwise release every resource this run took, leave the branch as it is, go back, run `foreman story todo <ID> --note \"waiting for <resource> to be free; branch kept\"`, and stop with `deferred`.":
    "`deferred` → take each resource in `needs` as in `deferred.md`. When one cannot be taken, release every resource this run took, leave the branch as it is, go back, run `foreman story todo <ID> --note \"waiting for <resource> to be free; branch kept\"`, and stop with `deferred`. When every one is taken and `files` is not empty, run `foreman lock files <ID> --plan <plan file>` as in `deferred.md`: on exit 7, release every resource this run took, leave the branch as it is, go back, run `foreman story todo <ID> --note '<reason>; branch kept'`, and stop with `deferred`, passing the same note to `foreman story end deferred \"\" '<reason>; branch kept'`; on any other exit but 0, release them and block the story as `deferred.md` says. Then run the same `foreman workflow-args` command again (with `--start-at fix --findings`, not a fresh build) and call the workflow again.",
  "`blocked` → as in step 3, but keep the branch when it has commits.":
    "`blocked` → as in `blocked.md`, but keep the branch when it has commits.",
  "`failed` → add the result to the findings file (its findings and its history, as above) and take the failed path.":
    "`failed` → add the result to the findings file (its findings and its history, as SKILL.md says) and take the failed path (`failed.md`).",
  "Each cause gets one fix round. When the same cause sends the change back a second time (checks fail again, CI fails again), take the failed path. Conflicts with `<base>` get up to `rounds` rounds, as step 5 says.":
    "Each cause gets one fix round. When the same cause sends the change back a second time (checks fail again, CI fails again), take the failed path. Conflicts with `<base>` get up to `rounds` rounds, as `ship-conflict.md` says.",
  // Step 4: the fix round and the failed path by file. Since FM-255 the commit says it never
  // reuses a recorded run; since FM-339 it starts the checks and waits for them; since FM-341 it
  // reuses the tester's run of the same tree, in the session env.
  "Report the stage first: `foreman stage commit`. Run `foreman checks --changed` yourself and read the output; a story is not committed on a stage's word. If a check fails, write the fix file with one `blocker` finding per failing check (`stage: \"checks\"`, the command in `where`, what failed in `observed`) and run a fix round. Then run `foreman checks --changed` again; a second failure takes the failed path.":
    "Report the stage first: `foreman stage commit`. Run `foreman checks --changed --reuse --start`, then `foreman checks --wait <id>` until it prints the result (exit 75 is still running), and read the output; a story is not committed on a stage's word. Never run a check's command by hand or background it to a file. `--reuse` prints the tester's run when the tree is the one it recorded and runs the checks when anything changed since (a fix round, a regenerated file); a story is never committed without a passing full-suite result for its exact tree. If a check fails, write the fix file with one `blocker` finding per failing check (`stage: \"checks\"`, the command in `where`, what failed in `observed`) and run a fix round (`${CLAUDE_SKILL_DIR}/fix-round.md`). Then run the checks again the same way; a second failure takes the failed path (`${CLAUDE_SKILL_DIR}/failed.md`).",
  // Since FM-436 finalize may write the story's shipped record instead of the story file, when
  // pull requests merge into a stage branch other than the base.
  "Run each `generated` entry's `regenerate` command, so the commit carries the current version and the tree is clean for the release step. Then run `foreman story finalize <ID> --note \"<what now works, how it was verified>\"`. When the project keeps its stories in the repo, it marks the story done in this checkout's copy of the story file and prints that file's path, so the base branch reads done exactly when the pull request merges; otherwise it prints \"nothing to change for this story source\". Then make one commit for the story, all of its files (the printed story file included), message `<ID> <story title>`, with a short body from the pipeline's summary and any minor findings left open. Run `git status --porcelain` first: when it prints nothing, because the story changed no file and finalize printed \"nothing to change for this story source\", still make the commit, as `git commit --allow-empty`. That keeps the branch one commit ahead for the release step, and `foreman ship` refuses a branch with none. Never skip the commit, and add no attribution lines to it.":
    "Run each `generated` entry's `regenerate` command, so the commit carries the current version and the tree is clean for the release step. Then run `foreman story finalize <ID> --note \"<what now works, how it was verified>\"`. When the project keeps its stories in the repo, it marks the story done in this checkout and prints the path of the file it wrote: the story file or, when pull requests merge into a branch other than `<base>`, the story's shipped record (`<stories dir>/.shipped/<ID>.json`), which leaves the story file alone. Either way the story reads done exactly when the pull request merges. Otherwise it prints \"nothing to change for this story source\". Then make one commit for the story, all of its files (the printed file included), message `<ID> <story title>`, with a short body from the pipeline's summary and any minor findings left open. Run `git status --porcelain` first: when it prints nothing, because the story changed no file and finalize printed \"nothing to change for this story source\", still make the commit, as `git commit --allow-empty`. That keeps the branch one commit ahead for the release step, and `foreman ship` refuses a branch with none. Never skip the commit, and add no attribution lines to it.",
  // Step 5's rare exits: the fix round, the failed path and the answers by file. Since FM-276
  // the merge-main exit re-runs each failed command before shipping again; since FM-340 it runs
  // `foreman checks --all` instead, because Foreman denies a check's command run by hand.
  "The JSON's `stage` is `merge-main` (check this first) → the project has no CI, and the project's checks failed on the branch merged with `<base>`. The merge is already on the branch. `failures` lists each as {run, exit, timedOut, tail}. Write the fix file with one `blocker` finding per entry (`stage: \"checks\"`, the command in `where`, its tail in `observed`) and run a fix round. Then `foreman checks --changed`, a new commit (never amend), and `foreman ship --story <ID>` again. A second failure takes the failed path.":
    "The JSON's `stage` is `merge-main` (check this first) → the project has no CI, and the project's checks failed on the branch merged with `<base>`. The merge is already on the branch. `failures` lists each as {run, exit, timedOut, tail}. Write the fix file with one `blocker` finding per entry (`stage: \"checks\"`, the command in `where`, its tail in `observed`) and run a fix round (`fix-round.md`). Then run `foreman checks --all --start`, then `foreman checks --wait <id>` until it prints the result, and read the output; an entry whose `run` is the install command, not a check, you run yourself. The next `foreman ship` finds `<base>` already merged and does not run the checks again, and `--all` also runs a check that only `<base>`'s files chose, which `--changed` would skip. Never run a check's command by hand: Foreman denies it. If any of them still fails, take the failed path (`failed.md`). Otherwise make a new commit (never amend) and run `foreman ship --story <ID>` again. A second failure takes the failed path.",
  "**6** — the branch conflicts with `<base>` in real code; nothing was pushed. The JSON's `conflicts` lists the files. Write the fix file with one `blocker` finding, `stage: \"merge\"`, whose `fix` reads \"merge `<remote>/<base>` into this branch and resolve the conflicts in <files>, keeping both sides' intent\". That is a conflict-only round. Read the limit once with `foreman settings get rounds`, or use 3 when it fails. Each exit 6 gets a fix round, then `foreman checks --changed`, a new commit (never amend), and `foreman ship --story <ID>` again, up to that many conflict rounds in this run. Take the failed path when the fix round returns `failed` (the builder could not resolve it), when `foreman checks --changed` fails after the round, or when exit 6 comes back after the last allowed round. Main moving without a conflict is brought in by `foreman ship` itself and never counts as a round.":
    "**6** — the branch conflicts with `<base>` in real code; nothing was pushed. The JSON's `conflicts` lists the files. Write the fix file with one `blocker` finding, `stage: \"merge\"`, whose `fix` reads \"merge `<remote>/<base>` into this branch and resolve the conflicts in <files>, keeping both sides' intent\". That is a conflict-only round. Read the limit once with `foreman settings get rounds`, or use 3 when it fails. Each exit 6 gets a fix round (`fix-round.md`), then `foreman checks --changed`, a new commit (never amend), and `foreman ship --story <ID>` again, up to that many conflict rounds in this run. Take the failed path (`failed.md`) when the fix round returns `failed` (the builder could not resolve it), when `foreman checks --changed` fails after the round, or when exit 6 comes back after the last allowed round. Main moving without a conflict is brought in by `foreman ship` itself and never counts as a round.",
  "When the JSON has `keepOut: true`, the owner asked for no deletes. Write the fix file with one `blocker` finding: `stage: \"release\"`, `rule: \"no metadata deletes\"`, `where` the JSON's deletes as \"<type> <member>\", `observed` the JSON's `reason`, and `fix` \"keep these components; the owner wants nothing deleted in this story\". Run a fix round, then `foreman checks --changed`, a new commit, and ship again. A second exit 10 with `keepOut` takes the failed path.":
    "When the JSON has `keepOut: true`, the owner asked for no deletes. Write the fix file with one `blocker` finding: `stage: \"release\"`, `rule: \"no metadata deletes\"`, `where` the JSON's deletes as \"<type> <member>\", `observed` the JSON's `reason`, and `fix` \"keep these components; the owner wants nothing deleted in this story\". Run a fix round (`fix-round.md`), then `foreman checks --changed`, a new commit, and ship again. A second exit 10 with `keepOut` takes the failed path (`failed.md`).",
  "Say it in your reply and stop with `blocked`. The answer is applied as the owner's answers say.":
    "Say it in your reply and stop with `blocked`. The answer is applied as `answers.md` says.",
  // Where you are: since FM-288 the session also gets FOREMAN_TEST_CORES, its share of the cores.
  "The supervisor may run several stories at once, each in its own **slot**: a git worktree of the project with its own environment, which the supervisor has already prepared. Your environment says which: `FOREMAN_SLOT` (w1, w2 …), `FOREMAN_STATE_DIR` (the shared state folder in the main checkout), `FOREMAN_STORY`, `FOREMAN_SUPERVISOR_PID`, `FOREMAN_PROJECT_DIR` and `FOREMAN_RUN=1`. The `foreman` command reads them by itself. Run by hand without them, you are in slot w1 of whatever checkout you are in.":
    "The supervisor may run several stories at once, each in its own **slot**: a git worktree of the project with its own environment, which the supervisor has already prepared. Your environment says which: `FOREMAN_SLOT` (w1, w2 …), `FOREMAN_STATE_DIR` (the shared state folder in the main checkout), `FOREMAN_STORY`, `FOREMAN_SUPERVISOR_PID`, `FOREMAN_PROJECT_DIR`, `FOREMAN_TEST_CORES` (the cores this slot's test runs may use, its share of the machine) and `FOREMAN_RUN=1`. The `foreman` command reads them by itself. Run by hand without them, you are in slot w1 of whatever checkout you are in.",
  // The learned files: since FM-272 it says undo and keep refuse on the project in a story
  // session.
  "Some agents follow rules Foreman learned by itself, tagged `[L-n]`. A finding whose rule names an `[L-n]` goes into the findings file unchanged, tag included, because Foreman rolls that learned item back from it. Never drop or reword the tag. The learned files are Foreman's: never edit `<state folder>/learned/`, `<state folder>/learning.jsonl` or the slot's `.claude/skills/foreman-learned-*` by hand, and never run `foreman learning undo`, `keep` or `tick` here. Undo and keep are the owner's, and the tick refuses in a story session.":
    "Some agents follow rules Foreman learned by itself, tagged `[L-n]`. A finding whose rule names an `[L-n]` goes into the findings file unchanged, tag included, because Foreman rolls that learned item back from it. Never drop or reword the tag. The learned files are Foreman's: never edit `<state folder>/learned/`, `<state folder>/learning.jsonl` or the slot's `.claude/skills/foreman-learned-*` by hand, and never run `foreman learning undo`, `keep` or `tick` here. Undo and keep are the owner's and refuse on the project in a story session; the tick refuses in any story session.",
  // Since FM-312 a note given with the body drops the body's last full stop, so the two never meet as `..`.
  "**\"Close it as Done\"** — `foreman story done <ID> --note 'Closed by the owner: nothing to build. <the body of the item><. the note from the answer, when given>'`, then `foreman decide applied <item id>`.":
    "**\"Close it as Done\"** — `foreman story done <ID> --note 'Closed by the owner: nothing to build. <the body of the item><. the note from the answer, when given>'` (when a note is given and the body ends with a full stop, leave that one full stop out, so the two never meet as `..`), then `foreman decide applied <item id>`.",
  // Since FM-312 the Decide-for note reads as the supervisor writes it.
  "An answered item titled `Decide for <ID>: <question>` holds the architect's own question from step 3, and any session applies it, whatever its `story`: `foreman story todo <ID> --note 'Note for the architect: the owner chose \"<the option from the answer>\".< the note from the answer, when given>'`, then `foreman decide applied <item id>`. That note is how the choice reaches the architect.":
    "An answered item titled `Decide for <ID>: <question>` holds the architect's own question from step 3, and any session applies it, whatever its `story`: `foreman story todo <ID> --note 'Note for the architect: the owner answered \"<the title of the item>\" with \"<the option from the answer>\".< the note from the answer, when given>'`, then `foreman decide applied <item id>`. That note is how the choice reaches the architect, in the words the supervisor uses when it applies the answer itself.",
  // Since FM-347 the learning sentence is shorter, to make room in SKILL.md.
  "With no pull request, pass `\"\"` as the pull request argument, so the reason is not taken for a URL: `foreman story end blocked \"\" \"S-2 first\"`. Leave out `--findings` when the file was never written. `<builder>` is the `builder` the workflow last returned with `passed` or `failed` (the plan file's `builder` says the same); leave out `--builder` when it returned neither. Foreman learns from these findings: with `learning.auto` on it adds learned traits and skills by itself; with it off, repeated findings for one builder become trait proposals for the owner. Skip this only for `empty`, for `group-summary`, and for a `halted` found before any story was picked.":
    "With no pull request, pass `\"\"` as the pull request argument, so the reason is not taken for a URL: `foreman story end blocked \"\" \"S-2 first\"`. Leave out `--findings` when the file was never written. `<builder>` is the `builder` the workflow last returned with `passed` or `failed` (the plan file's `builder` says the same); leave out `--builder` when it returned neither. Foreman learns from these findings (`learning.auto`). Skip this only for `empty`, for `group-summary`, and for a `halted` found before any story was picked.",
};

// A section of a markdown text: from its heading to the next heading of the same or a higher level.
function section(text, heading) {
  const start = text.indexOf(heading);
  expect(start, heading).toBeGreaterThan(-1);
  const level = heading.match(/^#+/)[0];
  const rest = text.slice(start + heading.length);
  const next = rest.search(new RegExp(`\\n#{1,${level.length}} `));
  return next === -1 ? rest : rest.slice(0, next);
}

describe('story skill split: the main file', () => {
  it('is under 15 KB', () => {
    expect(statSync(`${SKILL_DIR}SKILL.md`).size).toBeLessThan(15360);
  });

  it('leaves room under the 15 KB limit after FM-406', () => {
    expect(statSync(`${SKILL_DIR}SKILL.md`).size).toBeLessThanOrEqual(14960);
  });

  it("keeps a manual check's supervisor in a scratch repo, in the foreground, and stopped after", () => {
    const skill = collapse(skillFile());
    expect(skill).toContain("A manual check's supervisor runs only in a scratch repo under the system temp directory, through `foreman run --foreground`");
    expect(skill).toContain('`foreman stop`');
  });
});

describe('story skill split: the folder', () => {
  it('holds SKILL.md and the rare files, and nothing else', () => {
    expect(readdirSync(SKILL_DIR).sort()).toEqual(['SKILL.md', ...RARE].sort());
  });

  it('names every rare file from SKILL.md by the skill folder', () => {
    const skill = skillFile();
    for (const name of RARE) expect(skill, name).toContain(`${DIR}${name}`);
  });

  it('names only files that exist, from SKILL.md and from the rare files', () => {
    const skill = skillFile();
    const named = [...skill.matchAll(/\$\{CLAUDE_SKILL_DIR\}\/([\w.-]+\.md)/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    for (const name of named) expect(existsSync(`${SKILL_DIR}${name}`), name).toBe(true);
    for (const rare of RARE) {
      for (const [, name] of skillFile(rare).matchAll(/`([\w.-]+\.md)`/g)) {
        expect(existsSync(`${SKILL_DIR}${name}`), `${rare} names ${name}`).toBe(true);
      }
    }
  });

  it('keeps ${CLAUDE_SKILL_DIR} out of the rare files, which get no substitution', () => {
    for (const rare of RARE) expect(skillFile(rare), rare).not.toContain('${CLAUDE_SKILL_DIR}');
  });

  it('starts each rare file with a title and no frontmatter', () => {
    for (const rare of RARE) {
      expect(skillFile(rare), rare).toMatch(/^# \S/);
      expect(skillFile(rare).startsWith('---'), rare).toBe(false);
    }
  });

  it('says once where the named files are, before the first one is named', () => {
    const skill = collapse(skillFile());
    const where = skill.indexOf("Files named below sit in this skill's folder (`${CLAUDE_SKILL_DIR}`, the base directory shown when the skill loaded).");
    expect(where).toBeGreaterThan(-1);
    expect(skill.indexOf("Files named below sit in this skill's folder", where + 1)).toBe(-1);
    expect(where).toBeLessThan(skill.indexOf(DIR));
    expect(skill).toContain('Read one only when its path happens, and read it whole.');
    expect(skill).toContain('A plain name like `failed.md` inside them is in the same folder.');
  });
});

describe('story skill split: every rule kept', () => {
  const before = units(BEFORE);
  const all = () => collapse(allText());

  it('reads the snapshot of the skill before the split', () => {
    expect(BEFORE).toMatch(/^---\nname: story\n/);
    expect(before.length).toBeGreaterThan(100);
  });

  it('finds every unit of the old skill in the files, or its listed rewording', () => {
    const missing = before.filter((u) => !Object.hasOwn(REWORDED, u) && !all().includes(u));
    expect(missing).toEqual([]);
  });

  it('lists only real units that really changed, each with its new text in the files', () => {
    for (const [old, now] of Object.entries(REWORDED)) {
      expect(before, old.slice(0, 80)).toContain(old);
      expect(all(), old.slice(0, 80)).not.toContain(old);
      expect(all(), now.slice(0, 80)).toContain(collapse(now));
    }
  });
});

describe('story skill split: a shipped story needs SKILL.md alone', () => {
  it('holds every command from pick to close', () => {
    const skill = skillFile();
    for (const cmd of [
      'foreman config show',
      'foreman decide pending',
      'foreman story next --id <ID> --strict',
      'foreman story start <ID>',
      'foreman workflow-args <ID>',
      'foreman:pipeline',
      'foreman stage commit',
      'foreman checks --changed',
      'foreman story finalize <ID>',
      'git checkout -B <branch> <remote>/<base>',
      'git commit --allow-empty',
      'foreman ship --story <ID>',
      '- **0** — shipped. Go to step 6.',
      'foreman story done <ID>',
      'foreman story end',
      'FACTORY_RESULT: <shipped|ready-to-promote|blocked|failed|empty|halted|deferred|held> <story id or ->',
    ]) {
      expect(skill, cmd).toContain(cmd);
    }
  });
});

describe('story skill split: the resume rule', () => {
  it('points step 2 at resume.md and keeps the new-story path in SKILL.md', () => {
    const step2 = collapse(section(skillFile(), '## 2. Pick the story'));
    expect(step2).toContain('is looked at before anything is done: read `${CLAUDE_SKILL_DIR}/resume.md`');
    expect(step2).toContain('Otherwise `git checkout -B <branch> <remote>/<base>`.');
  });

  it('no longer holds the resume cases in SKILL.md', () => {
    expect(collapse(skillFile())).not.toContain("has the story's commit");
  });

  it('holds the three cases in resume.md, with no skill-folder variable', () => {
    const resume = collapse(skillFile('resume.md'));
    for (const part of ['foreman health --site', 'foreman story block <ID> --reason', 'go to step 5', 'carry on at step 3', 'git checkout -B <branch> <remote>/<base>']) {
      expect(resume, part).toContain(part);
    }
    expect(resume).not.toContain('${CLAUDE_SKILL_DIR}');
  });
});

const afterHaltBullet = () => {
  const modes = collapse(skillFile('modes.md'));
  return modes.slice(modes.indexOf('/foreman:story <ID> after-halt'), modes.indexOf('/foreman:story <ID> fresh'));
};

describe('story skill split: a rolled-back release is built again', () => {
  it('has resume.md read the merge times and rebuild from scratch when every merge came before the rollback', () => {
    const resume = collapse(skillFile('resume.md'));
    for (const part of ['rolledBackAt', '--json url,mergedAt,headRefOid', 'headRefOid', 'git push <remote> --delete <branch>', 'git checkout -B <branch> <remote>/<base>']) {
      expect(resume, part).toContain(part);
    }
    expect(resume).not.toContain('${CLAUDE_SKILL_DIR}');
  });

  it('puts the rolled-back paragraph before the cases, keeping their words', () => {
    const resume = collapse(skillFile('resume.md'));
    expect(resume.indexOf('rolledBackAt')).toBeLessThan(resume.indexOf('Its pull request **merged**'));
  });

  it('has the after-halt mode rebuild a rolled-back release and ask the owner nothing', () => {
    const bullet = afterHaltBullet();
    const at = bullet.indexOf('rolledBackAt');
    const rb = bullet.slice(at, bullet.indexOf('Otherwise', at));
    for (const part of ['do not close it', '`resume.md`', 'from scratch', 'go to step 3', 'ask the owner nothing']) {
      expect(rb, part).toContain(part);
    }
    for (const part of ['failed.md', 'failed path', 'foreman decide add', 'could not pass review', 'stop with `failed`']) {
      expect(rb, part).not.toContain(part);
    }
  });

  it("has the after-halt mode follow resume.md's rolled-back paragraph, rebuilding from scratch only when the branch is only the merged work", () => {
    const bullet = afterHaltBullet();
    const at = bullet.indexOf('rolledBackAt');
    const rb = bullet.slice(at, bullet.indexOf('Otherwise', at));
    for (const part of ["`resume.md`'s rolled-back paragraph", 'only the merged work', "the new build's own work"]) {
      expect(rb, part).toContain(part);
    }
    expect(rb).not.toContain('build it again from scratch as');
    expect(rb.indexOf('only the merged work')).toBeLessThan(rb.indexOf('from scratch'));
    expect(collapse(skillFile('resume.md'))).toContain("`<branch>` holds the new build's own work");
  });

  it('has the after-halt mode act on current state, not the earlier failure text', () => {
    const bullet = afterHaltBullet();
    expect(bullet).toContain("never on the earlier run's failure text");
    expect(bullet.slice(0, bullet.indexOf('rolledBackAt'))).toContain("never on the earlier run's failure text");
  });

  it('puts the rolled-back case before the close rule in the after-halt mode', () => {
    const modes = collapse(skillFile('modes.md'));
    const start = modes.indexOf('/foreman:story <ID> after-halt');
    const bullet = modes.slice(start, modes.indexOf('/foreman:story <ID> fresh'));
    const exception = bullet.indexOf('rolledBackAt');
    const close = bullet.indexOf('close it (step 6');
    expect(exception).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(-1);
    expect(exception).toBeLessThan(close);
    const before = bullet.slice(0, exception);
    expect(before).not.toContain('close');
    expect(before).not.toContain('foreman health --site');
    const between = bullet.slice(exception, close);
    expect(between).toContain('do not close it');
    expect(between).toContain('Otherwise');
  });

  it('leaves SKILL.md alone on the subject', () => {
    expect(skillFile()).not.toContain('rolledBackAt');
  });
});

describe('story skill split: a release failure is never a review decision', () => {
  const resume = collapse(skillFile('resume.md'));
  const releaseUnits = {
    'the after-halt mode': afterHaltBullet(),
    "resume.md's merged case": resume.slice(resume.indexOf('Its pull request **merged**'), resume.indexOf('`<branch>` has the story')),
  };
  for (const [name, unit] of Object.entries(releaseUnits)) {
    it(`has ${name} block the story with the reason and leave the decision to the supervisor`, () => {
      expect(unit.length).toBeGreaterThan(0);
      for (const part of ['foreman story block <ID> --reason', 'could not be released', 'file no decision yourself', 'stop with `failed`']) {
        expect(unit, part).toContain(part);
      }
      expect(unit).not.toContain('foreman decide add');
    });

    it(`has ${name} quote the block reason as the quoting rule says`, () => {
      const at = unit.indexOf('foreman story block <ID> --reason');
      const stop = unit.indexOf('stop with `failed`', at);
      expect(at).toBeGreaterThan(-1);
      expect(stop).toBeGreaterThan(-1);
      const slice = unit.slice(at, stop);
      expect(slice).toContain("in single quotes and each `'` inside written as `'\\''`");
      expect(slice).toContain('the quoting rule in SKILL.md');
    });

    it(`has ${name} never take the failed path for a release failure`, () => {
      const takes = unit.match(/take the failed path/gi) ?? [];
      const nevers = unit.match(/never take the failed path/gi) ?? [];
      expect(takes.length).toBe(nevers.length);
    });
  }
});

describe('story skill split: the plan goes by file', () => {
  it('has SKILL.md save the plan with --save-plan and pass the args as an object', () => {
    const skill = collapse(skillFile());
    expect(skill).toContain('foreman workflow-args <ID> --save-plan');
    expect(skill).toContain('not a string');
    expect(skill).not.toContain('Write any returned `plan`');
  });

  it('has deferred.md save the plan first and never paste it', () => {
    const deferred = collapse(skillFile('deferred.md'));
    expect(deferred).toContain('--save-plan');
    expect(deferred).toContain('never paste it');
  });

  it('has the fix round say the plan reaches the agents by file', () => {
    expect(collapse(skillFile('fix-round.md'))).toContain('the plan reaches the agents by file');
  });
});

describe('story skill split: the failed path is reachable', () => {
  it("names failed.md in step 3's failed bullet", () => {
    const step3 = section(skillFile(), '## 3. Run the pipeline');
    const at = step3.indexOf('- **`failed`**');
    expect(at).toBeGreaterThan(-1);
    const rest = step3.slice(at);
    const end = rest.search(/\n\s*\n|\n#/);
    expect(end === -1 ? rest : rest.slice(0, end)).toContain(`${DIR}failed.md`);
  });

  it('keeps the draft pull request, the block and the review decision in failed.md', () => {
    const failed = skillFile('failed.md');
    expect(failed).toContain('gh pr ready --undo');
    expect(failed).toContain('foreman story block <ID>');
    expect(failed.split('\n').some((l) => l.includes('foreman decide add') && l.includes('could not pass review'))).toBe(true);
    expect(failed).toContain('Stop with `failed`');
  });

  // Each file that sends the session somewhere names the file that holds it.
  for (const [phrase, target] of [['failed path', 'failed.md'], ['fix round', 'fix-round.md']]) {
    it(`names ${target} wherever a file says "${phrase}"`, () => {
      expect(skillFile()).toContain(phrase);
      expect(skillFile(), 'SKILL.md').toContain(`${DIR}${target}`);
      for (const rare of RARE.filter((name) => name !== target)) {
        if (skillFile(rare).includes(phrase)) expect(skillFile(rare), rare).toContain(`\`${target}\``);
      }
    });
  }

  it('points at moved text by file, not by "as above" or a step number', () => {
    expect(collapse(skillFile('fix-round.md'))).not.toMatch(/as above|as step \d says/);
    expect(collapse(skillFile('failed.md'))).not.toMatch(/\(step \d\)/);
  });

  it('names decisions.md before step 1, in the sentence about --kind decision', () => {
    const skill = skillFile();
    const pointer = `${DIR}decisions.md`;
    const at = skill.indexOf(pointer);
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(skill.indexOf('## 1. Before you start'));
    const sentence = collapse(skill).split(/(?<=\.)\s+(?=[A-Z])/).find((s) => s.includes(pointer));
    expect(sentence).toContain('--kind decision');
  });
});

describe('story skill split: safety stays in the main file', () => {
  it('has step 3 wait for the workflow before ending the story, saving a plan or asking the owner', () => {
    expect(collapse(section(skillFile(), '## 3. Run the pipeline'))).toContain('Wait for its result and act only on it: while it runs, never end the story, save a plan or ask the owner. To stop sooner, stop the workflow first.');
  });

  it('says in step 5 that a halted release is not retried, reverted or repaired', () => {
    const step5 = section(skillFile(), '## 5. Release');
    expect(step5).toMatch(/Do not retry, revert or repair production/i);
    expect(step5).toContain('HALT');
  });
});
