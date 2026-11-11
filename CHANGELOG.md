# Changelog

What changed in each release of Foreman. Install a release with
`/plugin marketplace add finefactory-ai/foreman#vX.Y.Z`, then `/plugin install foreman@foreman`.

## 0.12.0 — 2026-11-11

The Salesforce pack is no longer a preview. Stories have now shipped through it unattended on live Salesforce sandboxes: through the `sf` path straight to a QA org, through the `ci` path to a QA org and then a UAT org, in scratch mode inside the runner container, and with an Agentforce agent published and tested in both QA and UAT. The Gearset path is built but still unproven: it has not run against a live Gearset pipeline.

When `foreman sf rollback` reverts a story that was merged into a stage branch such as qa, it now keeps the story files that the merge brought in from the base branch, so a later change to a story file on the base branch (a status change, for example) no longer makes every later pull request into that stage conflict. The story's own `.shipped` record is still removed, so the story no longer reads as shipped on the stage. This applies to stories kept as markdown files in the project and to stories merged with a merge commit.

With the Salesforce pack, `foreman sf rollback` can now undo a story that created an Agentforce agent. It puts the agents back before it deploys: a new agent is deactivated, and an existing one gets its previous version active again. It keeps out of the deletes what Salesforce will not remove while the agent is published: the agent's authoring bundle, and the Apex classes its `.agent` file targets. Then it deploys the rest, pushes the revert and marks the story rolled back. The steps left for you in Setup (delete the agent, then its bundle, then those classes) are printed as `by hand:` lines, returned in the result's `manualSteps`, and added to the HALT reason of a rolled-back release. If an agent cannot be put back, nothing is deployed or pushed, and the message gives the command to run and says to run the rollback again.

Every task Foreman asks of you now offers two choices, "Retry the story" and "Close the task", each with a short hint. Only "Retry the story" puts the story back in line with your note. "Close the task" marks the task done and leaves the story exactly as it is, even when it is blocked, so closing a task you only meant to dismiss no longer starts the story again. A task asked before these choices, and answered in words, is treated as closed. Tasks are added without options. When you change your answer to a task under Answered, the button now reads "Save answer" rather than "Mark done", whichever choice you pick.

When your pull requests merge into a stage branch such as qa, a story that has shipped now reads as done from a fresh clone, so a cloud runner or a laptop with cleared state no longer builds it again. The story's commit no longer edits its story file: it adds a small record, `<stories folder>/.shipped/<ID>.json`, which only Foreman writes, so your own edits to the story file on the base branch never conflict with the stage branches. Foreman reads those records from the stage branch, and fetches that branch when the run starts. Projects whose pull requests merge into the base branch work as before.

The log of `foreman cloud run` now also blanks the values of the project's keys wherever they appear in an event, even when they do not look like a token. It drops control characters from event text, so an event cannot clear or rewrite the log's lines, and it keeps accented letters and emoji intact.

With the Salesforce pack in scratch mode, `foreman doctor` now checks how the Dev Hub is signed in to Foreman's sf home. A Dev Hub signed in by JWT (as Connect an org does) fails, because Salesforce cannot make scratch orgs through it, and the doctor gives the `sf org login web` line to sign it in with the Salesforce CLI's own app. A Dev Hub that is not signed in fails the same way. The set-up guide says the same. When the check fails because Foreman's sf home path is not absolute, the org list cannot be read, or the Dev Hub alias points at an org not in salesforce.orgs, the doctor now gives the fix for that problem rather than the sign-in line.

The README and the user guide now say where Foreman runs: macOS and Linux, and Windows through WSL2. A new page, Foreman on Windows, gives the steps. Running straight on Windows is not supported yet.

With the Salesforce pack, a deploy to a stage no longer fails with "No source-backed components present in the package" when the pull request merged into a stage branch. Each `sf-deploy` step now starts `sf project deploy start` in a temporary checkout of the stage's commit (the merge into the stage's own branch, else the commit the pull request merged into), and removes the checkout as soon as the start returns, whether it worked or not. If the commit is not known or cannot be checked out, the deploy stops with no deploy started and says so. When sf still finds no source, the message names the commit and the folder it looked in. Every deploy step now needs `git` as well as `sf`.

A release that stops now shows the failing step's own reason, never the raw release data. `foreman status`, the dashboard's halted headline, the "The run is halted" item on Waiting on you and the "stopped the release line" decision all give one sentence, for a rollback saying whether it worked, instead of text that began `{"sfDelta":...`. A reason that is not text is reduced to its `reason` field, else "The release failed at watch." With the Salesforce pack, the watch and rollback steps name the stage and its org ("watching qa (acme-qa) after the deploy", "rolling ACME-1 back on qa (acme-qa)", "qa (acme-qa) was rolled back with ..."), and say "production" only when the project has no pack stage.

A story that ends failed with nothing else open for it, such as "CI never started on the pull request; code not at fault", now raises a "could not be released" decision on Waiting on you, with the reason and the pull request. Its options are "Retry the release" (back to todo with a note; the next session resumes from the built branch and ships it again), "I'll take it" and "Drop". "Retry the release" is recommended when the reason says the code is not at fault. Before, such a story only blocked, and the run sat on standby saying "Nothing waits on you". Standby now says which story failed and how many it holds up: "Standby: nothing to build. <ID> failed and holds up 2 stories." A story that fails but goes back in line by itself, because it is still in progress or to do, no longer raises it. A "could not be released" decision still open when its story ships is closed.

With the Salesforce pack in scratch mode, stopping the run now deletes the scratch orgs of stories that are closed. It keeps the scratch org of a story that was interrupted, is held, or that you have taken, so the story can carry on with it. When a scratch org cannot be deleted in time, or sf refuses, the stop warns with the command to delete it by hand, which works even when Foreman's sf home path has spaces in it.

A story that was rolled back after its pull request merged is now built and released again, instead of being read as done on the next start. A merged pull request counts as shipped only when it merged after the story's last rollback. When the rebuilt story is ready, Foreman opens a new pull request from the same branch. After you clear a halt, a rolled-back story is rebuilt without asking you anything, and if its release fails again the decision on Waiting on you is "could not be released", not "could not pass review".

With the Salesforce pack, agent tests now run on projects that list a production org. Before, every agent test on such a project failed with HTTP 403 ("Missing_OAuth_Token"). The tests still never reach a production org: an org listed as production is refused by name. Reading the test user and sending each batch of tests now retries once, after 10 seconds, on a 403, a server error or a network failure, and a failure quotes a short piece of what Salesforce answered, with tokens blanked. The Agentforce check also finds the agent's bundle when the pull request merged into a stage branch.

With the Salesforce pack in scratch mode, a story that has already shipped is closed before any scratch org is made for it. `foreman cloud run` now echoes the run's events to its output, with secrets masked, so `docker logs` shows stories starting and ending, halts, and slots that go down.

With the Salesforce pack, cleaning a shared build sandbox between stories now also removes what a story left behind when it failed before its first commit, and no longer fails again and again when the failed story never deployed anything. It deletes only what the sandbox holds, and deploys nothing when there is nothing to undo. When it cannot work out what the last story left, it stops and names the org and the story. A failed clean-up names up to five failed components and what Salesforce said about them.

When you clear a halt, a held or queued story that was skipped this run, is now blocked or is done is no longer started again; the event says it was not resumed.

A markdown story file with no `status:` line, or an empty one, is now read as to do, as Jira stories already are. Before, it was silently ignored.

`foreman doctor` now warns when your shell has an alias, a function or another program named `foreman` that would run instead of the plugin's, and gives the fix. Inside a story session, Foreman warns once on the dashboard when the `foreman` command it finds is not its own.

## 0.11.0 — 2026-11-10

The runner image no longer contains Claude Code, which is Anthropic's. The first time a container starts, it fetches the pinned version from npm into `/work/.foreman-tools` on your volume, which takes a few seconds, and later starts are immediate. The runner must be able to reach `registry.npmjs.org`; when it cannot, it stops and says so. Nothing changes in how you start the runner.

Foreman now comes with a licence, in `LICENSE` and inside the installed plugin: the Functional Source License (FSL-1.1-ALv2). Foreman is free to use, change and share, at work included. You may not offer it, or something built from it, to others as a commercial product or service that replaces Foreman or does much the same job. If you share it, keep the licence and copyright notices. Two years after a release is published, that release also becomes available under the Apache License 2.0. The README has a short Licence section and a new "Before you run it" section on what Foreman can reach. `CONTRIBUTING.md` says how to send a fix or an idea, and the runner image now lists the other software in it, in `THIRD-PARTY.md`.

An answer to a "Foreman changed L-n" note whose version Foreman has replaced since no longer fails and retries forever. "Keep the change" on the older note is simply done, and the event says "L-8 v5 was replaced by v6 since; its own note covers it." "Undo the change" on it never undoes the newer version: the answer is marked applied, and one "Foreman did not undo L-8 for developer" note tells you nothing was undone and how to undo the newer version, with a Got it to clear it. That note now names the version in force, not a newer one that was undone since. When the item was removed altogether after the newer version, either answer is simply done, and the event says "L-8 v5 is no longer in force: L-8 was removed since; nothing to undo." A note added by hand is still refused.

When the builder still finds that a story cannot be met as written after the architect has corrected it, the story now stops at once instead of using up its build rounds. The decision it raises recommends "I'll take it" and says what the builder found. When the builder finds this during a fix after review, before the architect has corrected the story, the decision now says so and recommends "Retry with a note to the architect" instead.

A story whose Done-when line cannot hold as written no longer burns its build rounds. When the builder finds that a Done-when line (or the plan) claims something the code shows is false, or asks for something no code change can give, it says so instead of reporting an unfinished build, and the story goes back to the architect once to correct the plan and the Done-when line, keeping the work already in the tree, or to ask you what the story should prove. The story's notes say "The builder found Done-when 1 cannot hold; sent back to the architect to correct it." A story that has already been back to the architect, and any build that is unfinished or failing a check for another reason, is handled as before.

The run no longer stops taking new code because of a local edit to a file the merge does not touch. When the main checkout has an uncommitted change to a tracked file, Foreman now fast-forwards it anyway unless the new commits change that same file, and keeps your edit. When it does wait, the "Waiting on you" list now shows "The run is not taking new code" and names the files (or says the checkout is on another branch or has commits of its own), instead of leaving it to one line in the feed. The item goes away once the checkout catches up. File names with accents or other non-English letters are shown as they are, not as escaped codes.

When `foreman run` starts, whether after a crash, a hard kill or a restart, it takes over the story sessions still running in the slots' folders instead of starting those stories again, and says so in one "Kept N running across the restart" event. Start-up, like the 'story sessions' check in `foreman doctor`, warns when one slot folder has two story sessions, with a `kill <pid>` for each extra one. A session whose story id or mode word is not one Foreman uses is ignored. A failure in this scan is now a warning and the start carries on.

A check that waits on another slot's run of the same code now gives up after 30 minutes and runs itself, and a leftover or half-written claim no longer keeps it waiting: a claim counts only while the process that took it is still the same one. `foreman checks` no longer passes the Claude sign-in keys to a project's checks. The release step reuses a recorded check run only from the run's own state folder, so a state folder set to somewhere else always has the checks run on the merged code. `foreman doctor` warns when the first word of a check's command is not on the PATH, because story sessions run the checks with the PATH the run starts with, not the one an agent's shell has.

Foreman's guard against running a check by hand is more exact. Of a check made of several commands, only its last command counts as the check, so set-up steps such as `npm ci` stay free. A check written with a `timeout` prefix is now guarded. Text written to a file through a quoted heredoc (`cat > notes.md <<'EOF'`) is not counted as a run.

The run does less reading on a long-running project. Each tick reads a decision, story, claim or `state.json` file again only when it changed, and the snapshot behind the dashboard and `foreman status` is rebuilt only when something in the state folder moved, and at least every five minutes. The event log, `events.jsonl`, is now rotated at 5 MB into a dated `events-<date>.jsonl` file in the same folder; the dashboard still shows the 40 newest events, and the rotated files stay on your machine.

The 0.9.0 notes said the dashboard is yellow on black by default. It is not. The dashboard has a light and a dark theme, and the header's Theme picker offers System, Light and Dark. System, the default, follows your computer's light or dark setting. Light or Dark is remembered in that browser only. The 0.9.0 entry below now says so.

Stories you took over no longer stay taken after they are finished. The run now hands back a story you took over once it is done or retired, or once it has been missing from the story source for longer than a poll, and logs an event when it does. The dashboard's "Taken by you" list now shows each story's title and when you took it. `foreman doctor` has a new "owner claims" check that names any taken story that is already finished; it changes nothing, and the next `foreman run` clears them.

"Build next" no longer says a story cannot be built when it is already running. If the run restarted between starting the story and recording the request, the request is now marked as started, with no warning, and the story is not started twice.

A file kept for the highest-priority story waiting on it is now kept from the moment that story is picked, so a lower-priority story that plans the same file is no longer started next to it while the first slot is still fetching. When a slot cannot start that story (its folder or its environment fails to prepare), the file goes free at once instead of staying kept for up to 30 minutes.

For Salesforce Cases, reading a Case for a story's brief now asks the org whether it is the named sandbox first, as polls do. Every write, and the replay of queued writes, is checked against the org the same way first. When the org is not the named sandbox, the writes are held in `.foreman/salesforce-outbox/`, not sent, and the feed says "not sending N queued writes". The brief now carries only comments written by people in your company (Salesforce users whose `UserType` is `Standard`). Comments from customers, partners, portal or site users, guests and automated processes are left out, so text from outside the company never reaches an agent.

## 0.10.0 — 2026-11-09

The user guide has moved to the website, [finefactory.ai/apps/foreman/docs](https://finefactory.ai/apps/foreman/docs/). The dashboard's Help tab is now a Help link that opens it in a new tab. Set up's "Read the guide" and `foreman setup next` link to each step's page or section there, and the Set up and Salesforce set-up steps that had no link before now have one. The guide no longer ships inside the plugin, so it does not open offline.

A story that comes back to a slot after a deferral, a stop or a restart no longer pays the architect again. The design an earlier session saved is reused while none of the files it names has changed on the base branch since; when one has, the architect runs again and the session's log says why. Plans saved before this release are planned once more, then kept.

When the review engine's CLI reports its quota is used up, Foreman notes when it resets and sends every review until then straight to the Claude reviewer, instead of starting a relay for each review only to be told the engine is unavailable.

A new setting, `session.model`, sets the model of the story session itself, the one that moves a story between stages and ships it. The agents keep their own models. Set it with `foreman settings set session.model sonnet` or in the dashboard's models settings.

A reviewer's engine is now a setting. The Agent models settings get an engine row per reviewer, written as `engine:model` such as `antigravity:claude-opus-4-6-thinking`, so the Antigravity CLI can be turned on, changed or turned off from the dashboard or with `foreman settings`, locally or for the team. The reviewer's model row says it is the model the reviewer falls back to when its engine cannot run. While a review runs through an engine, the slot's agent card names the reviewer and its engine, on the engine's model, instead of a bare relay.

A story session can no longer stop the whole run with a signal. Foreman now denies `pkill`, `killall` and any command that runs `kill` for you, such as `xargs kill`. It allows only `kill <pid>`, `kill -TERM`, `-KILL`, `-9`, `-15` or `-s TERM` or `KILL` before a PID written as a number, and only for a process that session started (a child of the session, or one running in its worktree or its own folder under the temp folder). Any other `kill`, including `kill $!`, `kill %1` and `kill -0`, is denied. The Foreman supervisor, the service that started it and the dashboard are never allowed, whatever the PID. Commit messages and Foreman's own notes may still mention kill. The agents are told to record the PID when they start a background process and to keep scratch files in the worktree or `$TMPDIR/<slot>`. If a signal from inside a session still stops the run, `foreman doctor` names the story, the slot and the command instead of reporting a Ctrl-C.

## 0.9.0 — 2026-11-09

Everything built since 0.5.2, in one release. The Salesforce pack is new and is a preview: its
release paths pass their own tests, but Foreman has not yet shipped a story through them on a live
org. Everything else here has been running Foreman's own backlog for weeks.

Foreman now builds Salesforce projects. A project with `sfdx-project.json` turns the Salesforce
pack on with `"pack"` in its config, and `foreman init` suggests the block from the source it finds.

- `salesforce.orgs` is the allow-list, each org by its org ID. Stories are built in a pool of
  sandboxes (one per slot) or in scratch orgs made from a Dev Hub and deleted when the story
  closes. Every story session gets an `sf` home of its own that holds only those orgs, and the
  Bash guard keeps `sf` and `sfdx` off every other org.
- Deployments to production are blocked, in Foreman's `sf` wrapper and in the guard, however
  the org is named. A production org can still be listed, with `"production": true`, for
  queries, record changes, describes and as the scratch Dev Hub. Every deploy runs tests.
- Three release paths, 1 to 4 stages each and `stopAt` for the last one a story reaches, QA or
  UAT and never production. `sf` works out the story's delta, dry-runs it on the first stage
  before the merge, deploys after it, verifies the org's newest deploy is Foreman's, and rolls
  stage 1 back when a later step fails. `ci` waits for the repository's own GitHub Actions deploy
  and confirms it in the org. `gearset` follows Gearset's promotion pull request. Later stages
  halt and never roll back, because people share those orgs. Metadata deletes wait for your
  approval.
- Six Salesforce agents: sf-architect, sf-admin, sf-developer, sf-tester, sf-code-reviewer and
  sf-agentforce, with the official Salesforce skills pinned by `foreman sf skills`. Agentforce
  agents are built, published, activated and tested, within the org's licences and job limits.
- `foreman doctor` gets a Salesforce group: the orgs, the layout, the workflows (a workflow that
  deploys a Foreman branch to an org off the list is refused), and a baseline of the tests and
  coverage each org already fails, so an inherited failure is never blamed on a story.
- The Set up tab gets the Salesforce screens: Foreman's own key and certificate, one row per
  org to connect, and where each step runs. The container image includes the Salesforce tools.

The Set up tab walks through making Foreman ready on a project: one step per screen the first
time, then a checklist by area with a Test it button on each step, what is wrong and what to do.
Every key a step needs has its own card, saved to `.env.foreman` or the adapter's env file at
mode 600 and kept out of git, so you never edit an env file by hand. Jira gets its app keys,
sign-in and project screens, notifications a test email, and the cloud runner step writes the
workflow or `.env.runner` for you. `/foreman:init` hands off to the page. Foreman's own keys stay
in `.env.foreman` and never reach a story's workspace.

Waiting on you is now one tab: everything the run waits on, counted only when you can act on it
now, ranked by what each answer frees, in sections with a card that says what to do. Decisions
carry a one-line summary, option hints and a recommendation, follow-ups can be answered in one
go, and the header says why the factory is idle and the one thing that unblocks most. `foreman
status` and `foreman decide list` show the same list. Settings are described in plain words with
an info popup for each, and the dashboard has a light and a dark theme, with a Theme picker in the
header (System, Light or Dark) whose default, System, follows your computer.
A Tokens panel shows token use per agent, per story and over time, and the command centre says
what each agent is doing in plain words, on which model, with its conversation.

Foreman keeps running. It can run as a background service that survives sessions and reboots,
stands by instead of stopping when there is nothing to build, uses platform credits first and
switches to your subscription when they run out or the key hits its limit, without failing the
stories in flight, and resumes a credit or back-off pause at the known reset time. It keeps
running when its config or its own code changes under it, fast-forwards its own checkout after
each merge, resumes interrupted stories by priority after a restart, and alerts at once when it
is not making progress, telling slow from stuck by session activity. Two stories are kept off
the same files at the same time. A story waiting on you never counts toward the auto-pause. A
story session can never stop the real run, change the real project's config, settings or keys,
or kill the supervisor.

The Gearset release path (its ship steps, the Set up Gearset screen and its doctor checks) is
built but not proven: it has not shipped a story through a live Gearset
pipeline, and Foreman's own Gearset access ended before that run could happen. Treat it as
experimental until a release says otherwise. The `sf` and CI paths are unaffected.

Salesforce Cases can now be a project's stories. With the Salesforce pack on, `stories.adapter: "salesforce"` takes each Case a filter finds in one sandbox of `salesforce.orgs` as a story: the Case number is its id, the Subject its title and the Description its brief, with the "Done when" from a heading or a field you name, dependencies from a field, and owner tasks from a field value or "(owner task)" in the Subject. Foreman writes back private Case comments and Status changes as the story moves (the `salesforceComments` and `salesforceStatuses` switches turn them off), keeps a write the org does not take in `.foreman/salesforce-outbox/` until it answers, and never reads or writes a production org. `foreman doctor` checks the org, the filter and the Status names, Set up › This project offers "Salesforce Cases", and the guide has a new "Stories from Salesforce" section.

A file a story lets go of now goes to the highest-priority story waiting on it, not to whichever story plans first. The file is kept for that story for up to 30 minutes, until it claims its files or its session ends, and a lower-priority story that wants it is deferred with "kept for it". The picker also leaves out a lower-priority story whose earlier design names a file a higher-priority story is waiting on. Waiting on you and `foreman status` now name the top waiting story and the story holding its file.

A story deferred because a file it needs is held is no longer started again, and no longer re-designed at a cost, while another running story holds that file or plans to change it. `foreman status` names the story it waits for.

The container runner now includes `ps`, so a newer check run stops an older one in its worktree and the limit on parallel check runs holds there too; where `ps` is missing, `foreman checks` now warns that it cannot. A `foreman checks` run that is stopped for a newer run in its worktree now says so.

The story itself now records why it took the path it did. With `features.jiraComments` on,
Foreman writes a short comment on the issue (or a progress line, for markdown stories) for each
question it asks you and your answer, the architect's design (in numbered parts when long, and
a "design (revised)" listing only what changed), each round of review, how a session stopped and
what is kept for the resume, a release that stopped and why, and each follow-up it creates. They
are plain sentences with the time and slot, never the same note twice, and never a secret or a
folder on your computer. `features.jiraCommentDetail` (`summary` or `full`) chooses whether a
round's findings are counted or listed, and `foreman story note <id> --kind design --file <plan>`
records a design by hand. The pull-request comment now also names the commit.

Follow-up proposals no longer wait for the run to reach standby: `foreman learn` now also runs
in the background after each shipped story, so the proposals are there while other stories still
build. When the run does reach standby with things waiting on you, it now emails you once, saying
what waits and what an answer would start. An owner task that has held a story for more than
`watchdog.ownerTaskHours` (24 by default) is repeated once in an email naming that story.

When a story waiting for a slot over the worker count moves to a free slot, Foreman now checks
the story is still its own before it saves and cleans the old slot's folder, and a start that
fails after the move is retried as a plain resume, without moving the story again.

A story session that has recorded how its story ended but is still running a minute later, for
example with its pipeline still going, is now ended with a warning, and its slot and story are
freed at once instead of after half an hour of quiet.

A check now runs once for a tree. `foreman checks` in a story session runs each check in the
environment Foreman gave the session, not the calling shell's, so what an agent happened to set
(`PATH`, `NODE_OPTIONS`, a key) no longer changes the result, and only such a run is ever reused.
When a second slot reaches a check another slot is already running on the same tree, it says it
is waiting and prints that run's result when it ends instead of running the suite again. The
commit step reuses the tester's run when nothing changed after it (and runs the checks again when
something did), and the release's check of the merged code reuses a record of that same merged
tree. `foreman report` counts the waits on a run in progress next to the reuses.

A reviewer can run through the Antigravity CLI instead of a Claude subagent, on that tool's
own plan and limits. Set `engine: { "name": "antigravity", "model": "<an agy model>" }` on a
reviewer in `roles.reviewers`; a small relay agent hands the review to `agy -p` and brings the
verdict back, and when the CLI is missing, out of quota, over time or answers no verdict, the
reviewer's own Claude agent runs as before. `foreman doctor` checks the CLI answers, and
`foreman review --start` and `--wait` are the commands the relay uses.

Story sessions now run a project's checks only through `foreman checks`. Foreman denies an agent
running a check's command by hand (`npm test`, `pytest` and the like, also with variables,
redirects or pipes), because only `foreman checks` records the run; a run of a single test
stays free, and so does your own terminal. `foreman report` shows how many hand runs it denied
per story. New `foreman checks --all` runs every configured check whatever its condition. The
prompts now say this too.

Foreman can create follow-up stories without asking. With `features.autoCreateFollowUps` on
(off by default), the minor findings a shipped story leaves become a follow-up story at once,
with priority Low on Jira where the project allows it. One note under FYI on Waiting on you
names them, with "Undo and close them" (closes the ones not started yet) and "Keep them".
While follow-up proposals wait on you, the standby line says how many instead of "nothing to
build".

The dashboard has a Help tab with the user guide, which now ships with the plugin, so it opens
offline and always matches your version.

- Contents grouped by part, with the section in view highlighted as you scroll, a search box
  that filters the contents and marks matches, and a Copy button on code and commands.
- Each heading has its own address, such as `#help/settings`, and Back returns to the last
  section. On a phone the contents are a menu at the top.
- Set up's "Read the guide" opens the Help tab at the step's section instead of GitHub, and
  `foreman setup next` names the section. Links that leave the dashboard open in a new tab and
  say so.
- The guide is `plugin/docs/guide.md`; the README keeps the install lines and links to it.

Foreman now learns from its own mistakes. On by default.

- When the same kind of problem keeps coming back (review findings that say the same thing
  in other words, failed stories, fixes that did not fix, your retry notes, repeated tool
  errors), Foreman writes a short rule for the agents (a learned trait) or a how-to they can
  follow (a learned skill), uses it from the next story, and tells you on Waiting on you.
- Each change is on trial for the next few stories that use it. Foreman takes it out again
  by itself if stories get worse or a reviewer says the rule is wrong, and keeps it if it
  helped.
- Undo any change with "Undo the change" on the dashboard, or `foreman learning undo <id>`.
  `foreman learning list` and `foreman learning show <id>` show what was learned and why.
- Turn it off with `foreman settings set learning.auto false`; `foreman learn` then asks you
  about repeated findings, as before. `foreman settings set learning.apply false` stops the
  agents using what was learned.
- At most 3 changes a day (`learning.maxPerDay`) and $2 a day of learner sessions
  (`learning.maxUsdPerDay`). `foreman doctor` and `foreman report` show what it is doing and
  what it spent.
- Learned items live in Foreman's state folder, never in your project's git history. See
  "How Foreman learns" in the user guide.

- A project with no CI now has its checks run on the code as merged with the newest base
  branch whenever the release brought in new commits from it. A failing check stops the
  release before the pull request merges and the story gets a fix round, so two stories
  that each pass alone are tested together. `foreman doctor` says whether CI or Foreman
  tests the merged code.

- A story that ships right at the 2-hour build limit is no longer stopped and started again,
  and a story that is already done, or whose pull request already merged, is never resumed.
  A session that has finished its story but then hangs is ended after the quiet limit and its
  slot freed, instead of holding the slot forever.

- Story sessions get `FOREMAN_TEST_CORES`, their share of the machine's cores, so several
  slots running tests at once no longer each take every core. Foreman's own test config uses
  it, and your project's test runner can read it too. `foreman doctor` warns when the load is
  over twice the cores during a run, and names the busiest processes.

Story sessions start smaller.

- They load Foreman, the plugins your project's pack needs and the MCP servers you name in
  `session.mcpServers` (from `.mcp.json`; none by default), and nothing else from your own
  Claude Code set-up: no user-level `CLAUDE.md`, auto memory, hooks, skills, agents or other
  plugins. Your model, effort, attribution and permission settings and your sign-in are kept.
  Set `session.userSettings` to `true` to load your user settings again.
- Story sessions keep your user-level sandbox setting.
- Story sessions get their settings and MCP servers from private files in the state folder
  instead of the command line, so other users of the machine cannot see them in the process
  list.
- `foreman doctor` says when `session.mcpServers` names a server `.mcp.json` does not define,
  or one defined only in your user-level settings.
- `foreman report` shows each day's average first-turn context size.

Choose the Claude model for each agent.

- Set `roles.<role>.model` to `haiku`, `sonnet`, `opus` or `fable` for the architect, each
  builder, the tester and each reviewer, for example cheaper reviewers and the strongest
  architect. Unset, an agent runs on the story session's model, as before.
- The dashboard's Settings tab has an Agent models group with one dropdown per role. "Same as
  the story session" removes the choice. `foreman settings set roles.tester.model haiku`
  does the same from the command line.
- `foreman report --tokens` and the dashboard's Tokens panel show the model each agent ran on.

Story sessions now stay off the rest of your disk. Foreman denies an agent's search (`find`, `du`,
`ls -R`, `grep -r`, `rg`, `mdfind` without `-onlyin`) that starts outside the project, its state
folder, `~/.claude` and the temp folder, and shell forms such as `if`/`then`, loops, `{ }`, `eval`,
`xargs`, `nice` and a `cd` or `pushd` first do not get round it. It also denies a Read, Glob or
Grep call outside those folders, `~` included. Such a search reaches your private folders, and when
Foreman runs as a service macOS asks you to allow it; on macOS, `foreman doctor` explains those
prompts when the service is installed.

## 0.5.2 — 2026-10-19

The first release from `finefactory-ai/foreman`.

Foreman takes stories from a folder of markdown files or from Jira Cloud and ships them
unattended. An architect designs each story, a builder works tests first, a tester and
reviewers check the change, and the release step pushes, waits for CI, merges and deploys.

- Runs on your machine (`foreman run`), on a schedule in GitHub Actions
  (`foreman cloud actions init`), or nonstop in the container runner,
  `ghcr.io/finefactory-ai/foreman-runner`.
- Works with a fine-grained GitHub token as well as a classic one. When a token can't read a
  pull request's check runs, the `ci` step reads its GitHub Actions jobs and commit statuses
  instead; checks that other apps post are then not seen.
- Reviews compare a story's change with where its branch left the base branch, so stories
  merged in the meantime no longer appear in it.
- To move to a later release, see "Install" in the README: `claude plugin update` stays on the
  release the marketplace was added with.
