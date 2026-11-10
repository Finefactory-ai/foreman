// Foreman's supervisor: runs up to config.slots stories at once, one per slot, each in a fresh
// Claude session (`claude -p "/foreman:story <ID>"`, built by session.mjs) inside the slot's
// own worktree and environment. Started by `foreman run` from the main checkout, which it
// never builds in. A slot environment's prepare may answer later (slot-prepare.mjs): the slot
// shows building, 'preparing the slot', and is skipped until it settles; a rejection puts the
// slot down with the reason.
//
//   node lib/engine/supervisor.mjs [--workers 1-<slots>] [--max N] [--once] [--exit-when-idle] [--dry-run]
//
// It owns: picking (with claims, the schema token, and skipping a story deferred on files
// another running story holds, file-locks.mjs; a file a story lets go of is kept for 30 minutes for
// the highest-priority story waiting on it, and a lower-priority story whose design names a file
// that story waits on is left alone meanwhile), starting and watching sessions, the
// watchdog, what each ending means (scheduler.mjs), the owner's commands (control.json), the
// halt and "I've fixed it", automatic pauses, emails, publishing the state to the console,
// start-up reconciliation after a run that died, and applying the owner's answers (answers.mjs):
// those that need no story on every tick, the rest when no session runs. Decisions live in the
// small modules it imports; this file wires them together.
//
// --dry-run prints what each slot would start and writes nothing.
//
// A slot's folder after its story: a story that ends (the slot goes idle, or parked by the
// owner) leaves the folder clean and detached at base, with any uncommitted changes first saved
// on a local leftover/<slot>-<story>-<date> branch and an event naming the branch
// (leftovers.mjs), and any new key files deleted, not saved. A resumed, held or crash-parked story keeps its folder. At the pick, a dirty
// folder on the branch of a story nothing holds any longer (no claim, session, queued work or
// slot) is saved and cleaned the same way and the pick carries on; any other dirty folder, or
// one whose save fails, parks the slot as before. A folder's story is recognised by its branch
// name (the branch prefix plus an id the source's idPattern accepts), so a story no longer in the
// open list (Done in Jira) counts as ended. Skip, Take over and Restart tidy the folder the same
// way (leftovers saved on a leftover branch). Every dirty park writes a warn event naming the
// slot, the reason and the folder's branch.
//
// Session files and check runs: see session-records.mjs.
//
// Standby and the owner task watch: see standby.mjs.
//
// Leash and strays: a supervisor that belongs to a test or a scratch copy ends on its own
// (leash.mjs). With FOREMAN_LEASH_PID set (tests set it through test/supervisors.mjs, and
// `foreman run` in a story session sets it to the shell that ran it), it stops with "Stopped:
// the process that started this run (pid N) has ended." within a tick or two of that process
// going. With a leash pid, or a state folder under the temp folder, it also stops after
// FOREMAN_IDLE_EXIT_MS (5 min) on standby, "Stopped: on standby for N min, and this run belongs
// to a test or a scratch copy.". Both are a normal stop (exit 0, the loop 'stopped'). The two
// variables are read once at start and taken out of this process's environment, so no session
// or child inherits them; a restart on new code gets them again from startSupervisor's own
// environment. A real run (no leash, state outside the temp folder) has neither limit. A run
// with no leash, not --once and not --dry-run, looks for stray supervisors (strays.mjs, not this
// run's, in temp folders or this project's folders) at its first loop and every 10 minutes, and
// keeps their pids in state.json's strays { pids, mb, at } (null when there are none), written
// only when the list changes (the decision is strays.mjs strayPatch); no event and no
// notification. It keeps the last list when ps cannot run. Waiting on you shows them as the run:strays FYI, and `foreman doctor --end-strays`
// or the dashboard's End them ends them.
//
// A real run writes its pid to <stateDir>/supervisor.pid and removes it as it exits
// (supervisor-pid.mjs), so `foreman run` and `foreman service install` can tell one is going.
// `foreman run` starts this process in its own session, the service manager through
// `foreman run --service` (service.mjs); the exit codes are the same either way, and a clean
// exit (0) is one the service does not restart.
//
// FOREMAN_DASHBOARD_HOST, when set, is the address the dashboard listens on instead of
// console.host (the container runner sets 0.0.0.0).
//
// The loop rests 5 s between ticks. FOREMAN_TICK_MS, for tests, can shorten that (to 50 ms at
// the least, never longer than 5 s; tickMs in wake.mjs). FOREMAN_CPU_SAMPLE_MS, for tests, can
// shorten the progress watchdog's once-a-minute CPU sample (to 500 ms at the least; cpuSampleMs in
// session-cpu.mjs). FOREMAN_BACKOFF_MS, for tests, can shorten the 15-minute backoff after a rate
// limit or outage (to 1 s at the least, never longer; backoffMs in scheduler.mjs).
// FOREMAN_CREDIT_RETRY_MS, for tests, can shorten the 30 minutes between probes of a credit pause
// that keeps failing (to 1 s at the least, never longer; creditRetryMs in credit-resume.mjs).
//
// --once is for a scheduled job (`foreman cloud tick`): no dashboard, no "stopped" email at
// the end of each job, and it stops as soon as nothing is running and nothing may start
// (paused, halted, picking held, or no slot free to pick), where a normal run waits for that
// to change.
//
// Settings: the config is read with the local settings layer on top. `slots`, the console and
// keep-awake are read once, at start. Before every pick the config and the local layer are
// re-read when either file changed (live-settings.mjs), for `workers`, the watchdog limits and
// the switches this process acts on (costMetrics); `rounds` and the ship timeouts are read by
// `foreman workflow-args` and `foreman ship` themselves. live-settings.mjs says how --workers,
// `foreman workers` and a settings change to `workers` take turns. A slot picks a new story only
// while fewer than `workers` stories run across all slots; slots above the limit finish their
// story first. Work queued for a slot above the limit (a crash resume) is rehomed to any slot
// under it (slot-work.mjs rehome), with its claim, its locks and its folder: once the claim is
// known to be this factory's, the story's unfinished work is committed on its branch and the old
// folder is detached, so the new slot can check the branch out; the work then no longer carries
// where it came from, so a start that fails is retried as a plain resume (move-work.mjs).
// state.json's queued lists what waits.
//
// Start-up resumes (the stories a dead run or `foreman stop --now` left in hand) are not pinned to
// the slot they were in. They are queued in priority order (pick.mjs byPriority) and marked
// `ranked`: a free slot under the limit first asks the picker, and starts a story it ranks above
// the queued one before resuming. At start-up each one's old folder is freed (leftovers.mjs
// freeStoryFolder: its unfinished work committed on the story branch, the folder detached), so a
// pick into that slot never parks it as dirty; when a folder cannot be freed the story resumes in
// its old slot. A session stopped by `foreman stop --now` ends `interrupted`, not failed.
//
// An invalid config at start stops the run. One that turns invalid while it runs does not: the
// stories are picked with the last good config (the settings in effect), live-settings.mjs logs
// one warning per reason, and this process records state.json's configProblem { since, reason }
// (the run:config item on Waiting on you and in `foreman status`) and sends one `config`
// notification. Each valid config is saved as <stateDir>/config.last-good.json
// (config-health.mjs), which `foreman status` and `foreman notify` read meanwhile. Every
// notification other than `config` re-reads the settings first (applySettings), so it goes out
// on the last good config even in the tick the file turned invalid, such as the outcome email of
// the session that broke it. A valid file clears the problem from the next pick; so does the run
// stopping.
//
// Node: every command this process starts (the learning tick, `foreman notify` and `learn`, the
// park watch, the health and config checks, the owner's answers) runs on NODE.node()
// (node-path.mjs nodeWatch), not simply the Node this process started on: on a Homebrew install
// that is the versioned keg, which can stop loading after `brew upgrade` replaces a library it
// needs.
// NODE.node() is this process's own Node while that starts, else one that does (the background
// service's, Homebrew's link, the PATH node). main() checks it once at start and the tick every
// minute (a `node --version`, through heldSpawnSync). When this process's Node stops starting
// and another does, one warn event says so and names the new Node, and the run restarts onto
// it like a restart on new code (below; a STOP wins over it): "Restarted onto Node <path>
// (<version>): <old> no longer starts." The sessions are handed over, never stopped, and
// startSupervisor (run.mjs) starts the next process on a Node that starts. When no Node starts
// there is one warn event and no restart, since it would fail. A learning tick that fails is
// checked against the same Node: if it cannot start, the event says that is a set-up problem
// (with the load error line, and Homebrew when likely) instead of "failed (exit 134)", and the
// Node is checked again at once. The dashboard runs in this process, so its children move to
// the new Node with the restart, within a minute.
//
// New code: when the plugin sits in the project's own checkout (ownCheckout), each tick first
// fast-forwards that checkout's base branch to the tracking ref the merge step's fetch moved
// (anchor-pull.mjs), so a merged story of this repo needs no hand pull. It does so only on the
// base branch, and with no tracked change that the incoming commits also change (any other
// tracked change is kept across the move); otherwise it logs one warn per new base sha and
// leaves the checkout alone. Any such wait is also kept in state.json as anchorWait, the
// run:anchor item on Waiting on you, until the checkout moves. It never fetches, and is skipped
// while stopping.
// When the plugin code this process was loaded from changes under it (a commit to
// plugin/ when Foreman builds its own repo, or a new plugin version; code-version.mjs), it
// starts no new story and restarts in the tick that sees the change, before any pick, or in the
// first tick after the slots being set up are ready, the sessions being stopped have ended
// (neither can be handed over), the sessions whose result is already in their log have exited
// and had their ending handled (handover.mjs resultArrived: they are ending, so "Kept N" never
// names a story that just ended) and the park watch's check has ended. It checks that the new code accepts the config (`foreman
// config check`, else it logs why and carries on with the code it has), saves the run's counts
// in state.json's `restart` with the sessions still running, the queued work and the crash
// counts (handover.mjs), logs one "Restarted on new code (<old> -> <new>)." event (a restart
// onto another Node, above, is the same handover with its own event text) and exits 75
// (RESTART_EXIT), leaving the sessions running: it never stops them, and records no ending after
// the handover. Only `startSupervisor` (run.mjs, so `foreman run`, `cloud tick` and `cloud run`)
// starts it again, with FOREMAN_RESTART=1: the new process carries on the run (its counts,
// --max, skipped stories, totals) with no "started" event, adopts the sessions (one "Kept N
// running across the restart" event) as the first thing main() does once it has written its pid,
// before state.json's `restart` is cleared and before the console, the dashboard and Jira, so a
// stop or a crash from then on cannot leave them unwatched. A handed-over session it cannot adopt
// (a slot its config no longer has, or a second one for a slot) is ended with a warning, and its
// claim and locks are let go for start-up recovery. It queues the work, and polls each adopted
// session's pid every tick and while stopping (handover.mjs sessionAlive, which also checks the
// pid is still that story's session). The watchdogs cover adopted sessions as their own, and an adopted
// session's ending is handled as any other's, from its log. The sessions keep the old
// supervisor's pid as FOREMAN_SUPERVISOR_PID, so their claims and locks name it:
// supervisor-adopted.json (supervisor-pid.mjs) vouches for those pids, written by the old
// process before it exits (vouched for by its parent, startSupervisor's loop, which outlives it)
// and again by the new one for itself, so those locks never look stale (locks.mjs). A fresh
// start (not FOREMAN_RESTART) removes a supervisor-adopted.json left behind (a hard kill, a crash
// before the adoption): no handover is in flight, so nothing is vouched for. The new
// process holds those claims and locks as its own. A STOP wins over a pending restart, and a dry
// run never watches the code. Until it restarts, state.json's restartPending { from, to, since }
// says so (`since` is when the first change was seen): the run:restart FYI on Waiting on you, a
// line in `foreman status`, and idle slots reading "waiting for restart". It is cleared on the
// restart, a refusal, a stop or a start. While supervisor.pid names a process that is no longer a
// supervisor (a hard kill), status, Waiting on you and the page do not show it (state.mjs
// restartPendingOf). A signal (Ctrl-C, kill, a closed terminal) that arrives while it exits for
// the restart ends the run instead: it stops the sessions it was handing over, exits 130
// (INTERRUPT_EXIT) with the loop stopped, and startSupervisor does not start it again.
//
// Live sessions: whatever the reason a supervisor starts (a restart whose handover did not reach
// it, a hard kill, a crash, the service starting it again), start-up looks for story sessions
// already running in the slots' folders (live-sessions.mjs: `ps` and each one's folder) after the
// handed-over ones are adopted, and adopts them the same way: one "Kept N running across the
// restart" event covering the handed-over sessions and those found, the pid their claims name
// vouched for in supervisor-adopted.json, and no "Start-up: resuming" for their stories. Every
// slot folder is scanned, the handed-over slots too. A folder with two sessions keeps the oldest
// (the handed-over one, for a slot already in hand) and gets one warn event naming both pids and a
// `kill <pid>` for each other (`foreman doctor` reports the same in its 'story sessions' check);
// none is ended from here. A session whose story another live run or the owner holds is said so
// once and left alone. The scan is guarded: a failure in it is a warn event and the start goes on.
//
// A loop error that repeats is logged once, then once more with its count when it clears
// (repeats.mjs).
//
// A STOP names who asked (console/stopper.mjs): the event says so, and a stop that came from
// neither the owner's terminal, a browser on the dashboard nor the cloud runner (a story
// session's, say) emails the owner at once (`unexpected-stop`). Once taken, the record is kept
// in last-stop, so status and the dashboard still name who stopped a cloud run; a fresh start
// removes it, and a restart on new code keeps it. A session ended by an interrupt
// keeps its Claude Code transcripts (session-files.mjs), with an event naming them. An interrupt
// that comes while an agent of a session had just run a kill, pkill or killall (the last minute)
// says so instead of "Ctrl-C, kill or a closed terminal": the event names the story and the slot,
// and last-interrupt keeps it for `foreman doctor` (signal-source.mjs).
//
// The watchdog (watch(), scheduler.mjs hung): before its commit, a session with no progress (no
// stage or detail change and no agent starting or finishing, the slot's story.progressAt, and no
// agent tool step, the newest lastAt in the slot's agent files) for watchdog.buildMinutes (120)
// is stopped and resumed, its event naming the last progress seen, as is one with no activity
// at all for watchdog.quietMinutes (30); both count as a crash (a miss, the noresult email, the
// slot parked on the second). A story that keeps progressing is never stopped for its age alone,
// up to the hard ceiling at 4 times the build limit: then it is stopped and its slot parked as a
// crash (Resume, Restart, Skip, Take over) for the owner to decide, with no miss and one
// `parked` email. The release after the commit has its own timeouts, and a session in the
// release stage gets RELEASE_GRACE_MS (15 min) past the build limit and the ceiling. The build
// limit and the ceiling never stop a session whose `foreman story end` has run, or whose story
// is done, retired or ready-to-promote, or whose story/* pull request merged; the status and the
// pull request are looked up only when a stop is about to happen, at most once per session. Only
// the quiet limit still applies to such a session: with no activity for watchdog.quietMinutes it
// is ended with one warn event and no resume, and counts as no crash and no miss. Its own
// `story end` counts as its result when it printed none; otherwise the slot is closed as for a
// settled resume. A session that ended with no result is resumed only if its story is not
// settled and its pull request did not merge; otherwise the slot is closed (the story marked
// done first when only the pull request merged).
// The run record of a watchdog stop says why, the stages kept and the work redone
// (run-record.mjs, `foreman report`).
//
// Claims while the run goes on: a slot parked for crashes keeps its story's claim only while it
// stays parked on that story (the slot's parkedStory); Unpark, Discard and Skip let it go. Every
// tick, before the picks, a factory claim whose slot is idle, parked without that story, or
// building another story is let go with a warn event, even under this process's live pid
// (sweepClaims, scheduler.mjs looseClaims); stories running, being set up or queued keep theirs,
// as do held and down slots. The picker then takes an In Progress story with no claim first, so
// a story let go is picked again by priority in the same tick. Every tick, before the picks, an
// owner claim whose story is done or retired, or has been missing from a non-empty story list for
// longer than a poll (stories.pollSeconds, default 60 s, at least one tick), is removed with one
// info event (sweepOwnerClaims, scheduler.mjs settledOwnerClaims).
//
// A story that had committed when its session died on a rate limit, an outage or an empty balance
// is held for the Claude API (the slot's heldFor 'api', reading "held until the API is back
// (retry at HH:MM)"). Every tick, before the picks, releaseApiHeld releases such slots once the
// backoff has ended and nothing is paused or halted, and queues their stories as automatic
// resumes: no command needed. Resume in the command centre queues one sooner. A slot a halt
// holds (a failed release) waits for "I've fixed it", as before. A stop leaves such a slot held,
// with its claim, so the stop does not wait on a story that is not running; the next run's first
// tick releases it.
// After Unpark, a folder the crash left dirty is saved on a leftover/ branch at the next pick and
// cleaned (leftovers.mjs), and the story restarts from its committed branch.
//
// A skip from the command centre lasts for the run, standby included: state.json's skipped lists
// the stories for status and the page, and a "build next" request for a skipped story clears the
// skip and starts it.
//
// A "build next" request stays pending until its story has started in a slot (next-request.mjs):
// every pick tries it first, and "You asked for X next; starting it." is written only then. While
// the story's brief is fetched, no other story starts and one idle slot reads "Starting X next:
// fetching its brief from Jira". A claim held elsewhere, a failed fetch or checkout of the base
// branch, the schema token held by another story, or a wait on files or resources another running
// story holds (file-locks.mjs waitOf) leaves it pending; after 3 failed starts it
// is logged once and shown on Waiting on you (run:next), and it is still tried first. That
// request never gives way to a higher-priority waiter (yieldsTo): only the automatic pick does.
// A request whose story already runs in a slot (this factory's claim or session, adopted ones
// included) is settled as started, with no warning, at the next tick.
//
// File reservations: see story-claims.mjs.
//
// Checkpoints: see session-records.mjs.
//
// Outlived sessions: a session still alive watchdog.outliveMinutes (1) after its log's last event,
// when that event is a final result with FACTORY_RESULT and no background task is open
// (session-outlive.mjs), is ended (SIGTERM, then SIGKILL after 10 s, its whole process group)
// with one warn event, and its result counts. A session still alive watchdog.outliveMinutes after
// its own `foreman story end` (the slot's result for its story, no story in the slot) is ended
// the same way, with one warn event naming the story, and its recorded result counts.
//
// Progress: after every loop the progress watchdog (progress-watch.mjs) checks that the run is
// moving: no loop error repeating for watchdog.errorMinutes (5), no buildable story left
// unstarted with a slot free for watchdog.idleMinutes (10), and no session without activity (a
// stage event, output in its session log, a hook step, or CPU use, session-cpu.mjs) for
// watchdog.activityMinutes (20). When one holds it records state.json's stuck { kind, since,
// reason } (the run:stuck item on Waiting on you, "running, but stuck" in `foreman status`), logs
// one warn event and sends one `stuck` notification per episode; it logs once more when work
// moves again. A session with activity whose stage is older than watchdog.progressMinutes (45)
// is slow: state.json's slow (an FYI on Waiting on you and in `foreman status`), with no event
// and no notification. It never stops a session (that is watch()). A late wake restarts its
// clocks, and a run that starts or stops clears stuck and slow.
//
// Learning: see background-jobs.mjs.
//
// Held loop: no child that can take long holds the loop. A slot's install and the fetch of a new
// pick (and the base fetch of a new folder) run in children of the slot (worktree.mjs
// prepareWorktree, runAsync), while the slot says "preparing the slot" and counts as preparing;
// the owner's answers apply one step at a time in children, and while they do no story starts
// (an answer that failed is tried again after 1, 2, 5, 15 and then 30 minutes, or when the owner
// presses Retry: startAnswers);
// a session that ended is read (log, transcripts, the working tree hash a session with no result
// needs) in a child of its own (session-close.mjs), the slot saying "closing the session" and
// counting as in hand; `foreman health` after "I've fixed it" and the merged pull request
// look-ups (the watchdog's, a resume's) run in children too. A stop ends the slots' children at
// once and the loop's after the 10 s wait (a restart on new code ends them before it exits).
// What still runs synchronously is short git bookkeeping through `sh` (the dirty check, a
// checkout, leftovers), the start-up recovery and the new-code check; the gh calls and `git
// ls-remote` end within 30 s (NET_LIMIT), the dashboard's git within 5 s and its key tests and
// set-up shells within 2 minutes. loop-holds.mjs recordSyncChildren times every synchronous child
// of this process, whichever module starts it, and keeps any that took a second or more; a late
// wake's event then names the command that held the loop (wake.mjs). The dashboard's step checks
// run in a child of their own and hold nothing.
//
// Packs: when the config names a pack with a prepareSessions hook (pack-session.mjs), it runs
// once at start, before any session; a refusal stops the run with its reason. What it hands back
// (environment, PATH folders, --settings) goes into every story session. --dry-run skips it.
//
// Session scope: every story session is lean (session.mjs): Foreman, the pack's plugins and the
// MCP servers session.mcpServers names, and none of the owner's user-level CLAUDE.md, memory,
// hooks, skills, agents or plugins unless session.userSettings is true. What it is given is
// worked out once at start (session-scope.mjs), from the user, project and local Claude Code
// settings and the project's .mcp.json as they are then; a refusal (a server .mcp.json does
// not define, a .mcp.json that cannot be read, a pack's sessionNeeds Foreman cannot use) stops
// the run with its reason. --dry-run skips it.
//
// Plugin copy: a story session loads the Foreman code this process runs (PLUGIN_DIR, the code the
// restart above watches), not whatever Claude Code has installed. At start it reads the installed
// copies (plugin-copy.mjs, from <config dir>/plugins/installed_plugins.json) and passes
// `--plugin-dir <PLUGIN_DIR>` to every session when an installed copy is elsewhere, when none is
// installed, or when the project is Foreman's own repo; when the installed copy is PLUGIN_DIR it
// passes nothing. FOREMAN_PLUGIN_DIR plays no part. When an installed copy is elsewhere, one warn
// event at start (not after a restart) says so, the same sentence `foreman doctor` shows. A
// session's init event, read once from the head of its log, is then checked: a warn event on its
// slot says when it loaded Foreman from anywhere but PLUGIN_DIR, or not at all. A session kept
// across a restart is not checked again. A restart on new code moves the sessions too.
//
// Secrets: this process loads neither the project's env file nor Foreman's own keys file
// (.env.foreman). Only the children that need keys load them (`foreman notify` and the
// dashboard's `foreman setup steps` do it themselves), so the Claude sessions never carry those
// keys in their environment. (The Jira refresher reads both files for its own client only.) At
// each session start the two Claude sign-in names (ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN)
// are read from .env.foreman and passed to that session where this process's environment has
// none; nothing else from it is, and .env.local is never read for them.
//
// Platform credits, a sign-in that stops working, a usage limit or an empty balance: see account-checks.mjs.
//
// A rate limit or an outage never pauses the run: the wait grows 15, 30, 60, then 120 minutes and
// stays there (scheduler.mjs BACKOFF_STEPS), a session that dies inside a running wait joins it, and
// anything else that ends starts the ladder again. Each step is one warn event, and state.json's
// apiWait ({ since, until, step }) shows while it lasts, as a "stuck waiting" FYI.
// state.json's backoffUntil (the ISO time of the API or the environment backoff, backoffShown) is
// kept after each ending, so an idle slot reads "Picking held: backing off after failed sessions
// until HH:MM". The environment wait has its own end time (counters.envUntil), never the API
// wait's, so a slot held for the API keeps its own retry time and is released only when the API
// wait ends; state.json's envWait ({ since, until, step }) shows while it lasts, as an FYI.
//
// Only a story the pipeline rejected counts toward the three-in-a-row pause. A crash, a watchdog
// stop and a failed end with `foreman story end failed --cause environment` (CI that never started,
// a conflict, a test file that would not load) are the environment's: three in a row wait 15, 30
// and then 60 minutes (scheduler.mjs ENV_BACKOFF_STEPS), each wait one warn event naming them, and
// the run pauses only after that. The cause is read from the slot's own `story end` record, and a
// run record keeps `cause: 'environment'`, which the learning evaluation leaves out.
//
// Jira: with `stories.adapter: "jira"` this process never waits on Jira. Every story source it
// opens (its own, the state snapshot's, the dashboard's) reads only the poll cache and queues
// its Jira writes; the refresher (lib/jira/refresher.mjs) polls, sends and fetches briefs with
// await on its own timer. Salesforce Cases (`stories.adapter: "salesforce"`) work the same way,
// with adapters/stories/salesforce-refresher.mjs, which does the sf calls in a child process, so
// the loop never calls sf itself; "Jira" below reads "Salesforce" for them. While the last poll failed, or the cache is older than 5 polls,
// picking holds with the reason as the loop's state; stories in progress carry on. A story
// whose brief is not fetched yet waits a tick while the refresher fetches it (a story the owner
// asked for next is waited for, with nothing else started before it). After a late wake
// (the computer slept or the loop was held), the loop logs a warn event, naming the command that
// held the loop when one was recorded (see Held loop), and asks the refresher for a fresh poll
// (wake.mjs) before the next tick judges the cache, so a sleep does not show "Jira not
// reachable" and a real outage still does.
//
// Story notes (engine/story-notes.mjs, features.jiraComments, or salesforceComments for Cases): the
// supervisor writes on the story itself how a session that ended with no result stopped (the watchdog, a crash, a sign-in, a
// credit or rate limit, an outage) and what is kept for the resume; each tick posts the notes other
// processes queued (the dashboard's answers, a command's, a hook's); an answer found while applying
// the owner's answers is queued too. All through the cache-only source, so a Jira note only joins the
// outbox, and none of it can stop the loop: a failure is a warn event.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adoptLegacySchemaLock, breakIfStale, claimFile, claims, dropOwnerClaim, holderOf, letGoClaim, ownerClaim, release, SCHEMA, SHIP, take } from './locks.mjs';
import { byPriority, needsExclusive, nextStory, waitsOnStories } from './pick.mjs';
import { dropReservations, reserveForStart, spendWait, waitOf, waitsOnFiles } from './file-locks.mjs';
import { reconcile, recoverySteps } from './reconcile.mjs';
import { afterFixCheck, afterOutcome, apiHeldText, backoffMs, backoffShown, canPick, canResume, envWhy, failCauseOf, hung, LET_GO_PATCH, looseClaims, looseClaimText, lastProgressText, newestStep, NOTHING_LEFT, outcome, OWNER_CLAIM_POLL_SECONDS, ownerClaimText, pendingCommands, releaseAfterWait, releaseHeld, resumeHeld, SETTLED, settledOwnerClaims, signinRun, slotStoryId, spentResult, STANDBY, whenNothingLeft } from './scheduler.mjs';
import { closeInstead, mergedPrOfAsync } from './resume-close.mjs';
import { doneChange, openStorySource, preferCachedStories, storyUpdate } from './story-source.mjs';
import { EXPIRED_MESSAGE } from '../jira/auth.mjs';
import { jiraEnv } from '../jira/cache.mjs';
import { foremanEnvName, sessionKeys } from './foreman-keys.mjs';
import { creditPauseReason, fallbackOf, hhmm, readSignIn, useSubscription } from './claude-fallback.mjs';
import { creditProbeDue, creditRetryMs, resumeAtFor, retrySentence, retryWhen } from './credit-resume.mjs';
import { PROBE_EVERY_TICKS, probeDue, SIGNIN_PAUSE } from './signin-probe.mjs';
import { jiraRefresher } from '../jira/refresher.mjs';
import { SF_EXPIRED_MESSAGE, salesforceRefresher } from '../adapters/stories/salesforce-refresher.mjs';
import { loadResolved } from '../settings/load.mjs';
import { liveSettings, recordsRuns, watchdogLimits } from './live-settings.mjs';
import { saveLastGood } from './config-health.mjs';
import { progressWatch, stuckLimits, stuckTitle } from './progress-watch.mjs';
import { cpuSampleMs, cpuWatch } from './session-cpu.mjs';
import { anchorEvent, anchorStep, anchorWaitOf, ownCheckout } from './anchor-pull.mjs';
import { afterSignal, codeChange, codeVersionWatch, INTERRUPT_EXIT, nextPending, PLUGIN_DIR, RESTART_EXIT, restartStep } from './code-version.mjs';
import { adoptable, adoptedPids, handoverSessions, keptText, leftOut, resultArrived, sessionAlive } from './handover.mjs';
import { repeatGate } from './repeats.mjs';
import { projectRoot } from './paths.mjs';
import { openEnvAdapter } from './env-adapter.mjs';
import { preparePackSessions } from './pack-session.mjs';
import { configDir, sessionScope } from './session-scope.mjs';
import { copyWarning, initPluginWarning, installedCopies, ownCopy, sessionPlugin } from './plugin-copy.mjs';
import { openConsole } from './console.mjs';
import { flushStoryNotes, noteOnStory } from './story-notes.mjs';
import { sessionEnding } from './story-note-text.mjs';
import { answerNote, queueStoryNote } from './story-notes-queue.mjs';
import { startDashboard } from '../dashboard/server.mjs';
import { accountChecks } from './account-checks.mjs';
import { backgroundJobs, ENV_SWEEP_MS, PARK_CHECK_MS } from './background-jobs.mjs';
import { dryRun } from './dry-run.mjs';
import { sessionRecords } from './session-records.mjs';
import { standbyWatch } from './standby.mjs';
import { storyClaims } from './story-claims.mjs';
import * as session from './session.mjs';
import { closableMergedIds, keepAwake, keepAwakeCommand, mustFinishFor, remoteHasBranch } from './startup.mjs';
import { loopRest, tickMs } from './wake.mjs';
import { takeOver } from './move-work.mjs';
import { renameWritten } from './read-cache.mjs';
import { groupSummaryWork, hasWork, peekWork, pickFirst, rehome, slotNumber, takeable, takeWork } from './slot-work.mjs';
import { envSweepDue, envVerdict, notStartedPatch, PENDING, pendingPrepares, prepareSlot, sessionStartPatch, syncLearnedSkills } from './slot-prepare.mjs';
import { ensureWorktree, prepareWorktree, slotIds, worktreeDirty, worktreeNeeds, worktreeOf } from './worktree.mjs';
import { freeStoryFolder, heldIds, leftoverEvents, saveLeftovers, storyOfBranch } from './leftovers.mjs';
import { readInit } from './session-log.mjs';
import { keepMark, markSession, readMark, sessionProjectsDir } from './session-files.mjs';
import { fallbackAnswer, runSessionClose } from './session-close.mjs';
import { runAsync } from './run-async.mjs';
import { learnedOf } from './run-record.mjs';
import { heldSpawnSync, recordSyncChildren } from './loop-holds.mjs';
import { ownerCommands } from './owner-commands.mjs';
import { NODE_CHECK_MS, nodeWatch, restartFor, serviceNodeOf, spawnSh } from './node-path.mjs';
import { doubleText, holderFor, listStorySessions, logFor, planLive } from './live-sessions.mjs';
import { answerSkips, answersToApply, applyAnswers, EVERY_TICK, failedAnswer, heldForAnswer, mayApplyAnswers, waitsForAnswer } from './answers.mjs';
import { endedLate, outlived, outliveMs, readHead, readTail } from './session-outlive.mjs';
import { ownerEnv } from './run-guard.mjs';
import { clearAdopted, clearPid, dropAdopted, writeAdopted, writePid } from './supervisor-pid.mjs';
import { interruptReason, signalSource, SIGNAL_WINDOW_MS, writeInterrupt } from './signal-source.mjs';
import { alive, IDLE_ENV, LEASH_ENV, leashOf, leashVerdict, tempRoots } from './leash.mjs';
import { findStrays, strayPatch } from './strays.mjs';
import { briefNote, failedTry, isStoryId, requestVerdict, runningSlot } from './next-request.mjs';
import { clearLastStop, stopperDetail, takeStop, unexpectedStop } from '../console/stopper.mjs';
import { parkWatchDue, READY, readPark, readParks, sessionResult } from './parks.mjs';
import {
  addEvent,
  clearAgents,
  clearSpans,
  endStory,
  openNextRequest,
  readSlot,
  readState,
  recordResult,
  redact,
  rotateEvents,
  runningAgents,
  setLoop,
  setSlot,
  setWorkers,
  stageMap,
  setNextWait,
  settleNextRequest,
  startTotals,
} from './state.mjs';

// Every synchronous child this process still runs is timed from here on, so a late wake can name it.
recordSyncChildren();

const ROOT = projectRoot();
// Started again by startSupervisor after new code (see the header); never passed to sessions.
const RESTARTED = process.env.FOREMAN_RESTART === '1';
delete process.env.FOREMAN_RESTART;

// The project's config with the local settings layer on top, as it was at start; an invalid one
// stops the run. What it fixes for the run (slots, the console, the state folder) stays; the
// settings that apply at the next story come from `live` before each pick.
const loaded = loadResolved(ROOT, { env: process.env });
if (!loaded.config) {
  for (const e of loaded.errors) console.error(`foreman.config.json${e.path ? ` ${e.path}` : ''}: ${e.message}`);
  process.exit(1);
}
const CONFIG = loaded.config;
const SLOT_IDS = slotIds(CONFIG);
// The state folder the config names (FOREMAN_STATE_DIR wins), passed on to every child so the
// sessions, `foreman notify` and the owner's commands all use the same one.
const DIR = loaded.dir;
process.env.FOREMAN_PROJECT_DIR = ROOT;
process.env.FOREMAN_STATE_DIR = DIR;
// The leash (see the header), read once; no session or child inherits it.
const LEASH = leashOf({ dir: DIR, env: process.env, roots: tempRoots() });
delete process.env[LEASH_ENV];
delete process.env[IDLE_ENV];
const LEASHED = LEASH.parent !== null || LEASH.idleMs !== null;
const ARTIFACTS = CONFIG.console?.adapter === 'artifacts';
const BASE_REF = `${CONFIG.remote}/${CONFIG.baseBranch}`;

let envAdapter;
try {
  envAdapter = openEnvAdapter({ config: CONFIG, ctx: { root: ROOT, stateDir: DIR, config: CONFIG } });
} catch (err) {
  console.error(`foreman.config.json env: ${err.message}`);
  process.exit(1);
}

// The artifacts console is pushed by its own child (sync.mjs); a wrong setting stops the run
// here rather than failing quietly there.
if (ARTIFACTS) {
  try {
    openConsole({ config: CONFIG, ctx: { stateDir: DIR } });
  } catch (err) {
    console.error(`foreman.config.json console: ${err.message}`);
    process.exit(1);
  }
}

const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const DRY = process.argv.includes('--dry-run');

// What the project's pack adds to every story session; a pack that cannot set it up stops the run.
let PACK_SESSION = null;
if (!DRY) {
  const r = preparePackSessions({ config: CONFIG, env: process.env });
  if (!r.ok) {
    console.error(`Foreman cannot start: ${r.reason}`);
    process.exit(1);
  }
  PACK_SESSION = r.session;
}
// What every story session loads besides Foreman (session-scope.mjs); a refusal stops the run.
let SESSION_SCOPE = null;
if (!DRY) {
  const s = sessionScope({ config: CONFIG, root: ROOT, env: process.env });
  if (!s.ok) {
    console.error(`Foreman cannot start: ${s.reason}`);
    process.exit(1);
  }
  SESSION_SCOPE = s.scope;
}
// Which plugin folder every story session loads (plugin-copy.mjs; see "Plugin copy" in the header).
const SESSION_PLUGIN = sessionPlugin({
  pluginDir: PLUGIN_DIR,
  root: ROOT,
  copies: installedCopies({ pluginsDir: join(configDir(process.env, os.homedir()), 'plugins'), root: ROOT }),
});
const ONCE = process.argv.includes('--once');
const MAX = Math.max(0, Number(arg('max', 0)) || 0);
// With nothing to build, stop with NOTHING_LEFT rather than wait on standby (`foreman cloud run`).
const EXIT_WHEN_IDLE = process.argv.includes('--exit-when-idle');

// What the run before the restart left in state.json's `restart`, when this is a restart.
const CARRIED = RESTARTED ? (readJson(join(DIR, 'state.json'), {}).restart ?? null) : null;
// The plugin code this process runs; a change to it restarts the run (see the header).
// Asks git only when something it reads changed (code-version.mjs), so a tick runs no child.
const CODE = DRY ? null : codeVersionWatch();
const CODE_AT_START = CODE?.version() ?? null;
let restartPending = null; // { from, to, id, since } once the code changed (setRestartPending)
let refusedCode = null; // the code id whose config check failed: not tried again

// The settings read fresh before each pick, and the config they come from (LIVE).
const live = liveSettings({ root: ROOT, dir: DIR, env: process.env, slots: SLOT_IDS.length });
let LIVE = live.config ?? CONFIG;
// --workers when given, else the `workers` setting; capped at the slots.
const flagWorkers = Number(arg('workers', ''));
const START = live.startWorkers(CARRIED?.workers ?? (Number.isInteger(flagWorkers) && flagWorkers >= 1 ? flagWorkers : null));
let workers = START.workers;
const workerChanges = []; // control.json worker changes since the last pick: { value, at }

const ME = process.pid;
// The supervisor pids whose claims and locks this process holds as its own: its own and, after a
// restart on new code, those its adopted sessions' locks name (see the header).
const OWN = new Set([ME]);
const TICK_MS = tickMs(process.env.FOREMAN_TICK_MS);
const BACKOFF = backoffMs(process.env.FOREMAN_BACKOFF_MS);
const CREDIT_RETRY = creditRetryMs(process.env.FOREMAN_CREDIT_RETRY_MS);
const NODE_CHECK_TICKS = 12; // a minute at the real 5 s tick
const HALT = join(DIR, 'HALT');
const STOP = join(DIR, 'STOP');
const EXTRA = join(DIR, 'schema-stories.json');

// slot -> { child, pid, id, mode, startedAt, log, usedKey, holderPid, adopted, shipped, stop: null|'watchdog'|'outlived'|'skip'|'takeover'|'restart'|'interrupt', watchdog: why the watchdog stopped it (hung(): too-long, quiet, ceiling or ended-quiet; or 'ended-alive' from watch()) }.
// An adopted session (see the header) has no child; holderPid is the supervisor pid its locks name.
// `shipped` is set once the watchdog has found the story settled or its pull request merged.
const sessions = new Map();
const preparing = pendingPrepares(); // slots whose folder or env adapter's prepare has not settled
const loopChildren = new Set(); // the loop's own async children (answers, health, gh, the session close): ended when the run stops
const slotChildrenOf = new Map(); // slot -> Set of the children preparing its folder (install, fetch)
const slotChildren = (slot) => {
  if (!slotChildrenOf.has(slot)) slotChildrenOf.set(slot, new Set());
  return slotChildrenOf.get(slot);
};
// SIGKILL to each child's group (runAsync leads one for every child it starts).
function endChildren(set) {
  for (const child of set ?? []) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // gone already
    }
  }
}
const closing = new Map(); // slot -> the ended session whose files a child reads (see onExit)
let answersRun = null; // the promise of the owner answers being applied, or null
let fixCheck = null; // the promise of the health check after the owner says the cause is fixed, or null
const lookups = new Map(); // story id -> the promise of its merged pull request look-up
const mergedFor = new WeakMap(); // queued work -> { pr } once the look-up for its resume is back
const pickFetches = new Map(); // slot -> the story id whose base is being fetched
// The sessions in hand: running, or ended and being read (a held set counts both).
const inHandSessions = () => [...sessions.values(), ...closing.values()];
const work = []; // queued work: { slot: 'wN'|null, id, mode, resume?, from?, ranked? } (resume: an automatic resume after a session ended with no result; from: the slot it was in before, see rehome and reconcileStart; ranked: a start-up resume that yields to a higher-priority pick, see resumeYields)
const crashes = new Map(); // story id -> crashes this run
const signins = new Map(); // story id -> sign-in deaths in a row this run while the check passed
const skipped = new Set(CARRIED?.skipped ?? []); // stories skipped by the owner this run
const answerFailures = new Map(); // decision id -> failedAnswer (answers.mjs): an answer that could not be applied, tried again after a growing wait or when the owner presses Retry
const downs = new Map(); // slot -> environment failures in a row
let counters = CARRIED?.counters ?? { misses: 0, missed: [], backoffs: 0, backoffUntil: 0, envUntil: 0, envEndings: 0, envList: [], envWaits: 0 };
let started = CARRIED?.started ?? 0; // new stories begun this run
let finished = CARRIED?.finished ?? 0;
let shipped = CARRIED?.shipped ?? 0;
let nothingLeft = false;
let awake = null; // keep-awake (startup.mjs keepAwake), set in main()
let stopping = false;
let haltSeen = CARRIED?.haltSeen ?? false;
let repaired = false; // the env adapter's repair() runs at most once per run
let exiting = null; // null, 'stop' or 'restart'
let interrupted = false; // a signal came while exiting for a restart
let interruptSource = null; // the session whose agent had just run a kill when the signal came (signal-source.mjs)
let handedOver = false; // the sessions went to the next process: no ending is handled here
let configProblem = null; // { since, reason } while the run is on the last good config
let savedTeam = null; // the config last saved as the last good one
const loopErrors = repeatGate();
const progress = progressWatch();
const cpu = cpuWatch({ sampleMs: cpuSampleMs(process.env.FOREMAN_CPU_SAMPLE_MS) }); // the progress watchdog's CPU sign of activity, sampled once a minute per slot
let launches = 0; // sessions started or pending, this process
let starvedId = null; // the story the last tick could have started and did not

const now = () => new Date();

// The session whose agent ran a kill command in the last minute, or null. Never throws: a signal
// is already being handled. Read before stop(), which clears the agents.
function sourceNow() {
  try {
    const agents = SLOT_IDS.flatMap((slot) => runningAgents(DIR, slot).map((a) => ({ slot, story: sessions.get(slot)?.id ?? a.story ?? null, raw: a.raw, lastAt: a.lastAt })));
    return signalSource({ agents, now: now(), windowMs: SIGNAL_WINDOW_MS });
  } catch {
    return null;
  }
}

// The interrupt reason, kept in last-interrupt for `foreman doctor` (a file that cannot be written
// costs only that line).
function interruptNow() {
  try {
    writeInterrupt(DIR, { at: now().toISOString(), ...(interruptSource ? { story: interruptSource.story, slot: interruptSource.slot, command: interruptSource.command } : {}) });
  } catch {
    // the stop goes on
  }
  return interruptReason(interruptSource);
}

// The project's story source, opened fresh each time from the settings in effect (LIVE), so a
// config edit is picked up at the next pick and a config that turned invalid keeps the last good one.
const stories = () => openStorySource({ root: ROOT, config: LIVE, now });
// The picking rules over the source's stories.
const pickStory = (opts = {}) => {
  const source = stories();
  return nextStory(source.list(), { idPattern: source.idPattern, ...opts });
};
// Records a change on one story: `fields.status` sets the status, `progress` is the dated note.
const updateStory = (id, change) => stories().update(id, storyUpdate(change));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const event = (text, kind = 'info', slot = null) => addEvent(DIR, text, kind, now(), slot);
const slotIndex = (slot) => SLOT_IDS.indexOf(slot);
// The slots with a story running: a session (adopted ones too) or a prepare not yet settled.
const runningCount = () => SLOT_IDS.filter((s) => sessions.has(s) || closing.has(s) || preparing.has(s)).length;
const branchOf = (id) => `${CONFIG.branchPrefix}${id.toLowerCase()}`;
// A gh or `git ls-remote` call that hangs would hold the loop with no end, so it gets 30 s, and
// SIGKILL because gh can ignore SIGTERM.
const NET_LIMIT = { timeout: 30_000, killSignal: 'SIGKILL' };
const sh = (cmd, args, opts = {}) => {
  const r = heldSpawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  return { status: r.status ?? 1, stdout: (r.stdout ?? '').trim() };
};
// Bringing new code into the checkout this run's plugin sits in (anchor-pull.mjs): git with no
// repository named by the environment, so the cwd decides, and the same limit as the other
// network-free-but-hangable calls.
const GIT_ENV = { ...process.env };
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete GIT_ENV[key];
const anchorSh = (cmd, args, opts = {}) => sh(cmd, args, { ...opts, env: GIT_ENV, ...NET_LIMIT });
const OWN_CHECKOUT = !DRY && ownCheckout({ pluginDir: PLUGIN_DIR, root: ROOT, sh: anchorSh });
let anchorWarned = null; // the base sha the one warning was logged for
const pullAnchor = guarded('bringing in new code', () => {
  const text = { remote: CONFIG.remote, baseBranch: CONFIG.baseBranch };
  const step = anchorStep({ root: ROOT, ...text, sh: anchorSh });
  const r = anchorEvent(step, anchorWarned, text);
  anchorWarned = r.warnedTo;
  if (r.event) event(r.event.text, r.event.kind);
  // The wait is kept in state.json for Waiting on you, written only when it changes.
  const w = anchorWaitOf(step, state().anchorWait ?? null, { ...text, at: now().toISOString() });
  if (w.changed) saveRun({ anchorWait: w.wait });
});
// The merged pull request of a story's branch, asked in a child of its own: a promise of its url
// (the branch when gh gives none), or null when none merged or gh cannot tell. It never rejects
// (resume-close.mjs). One look-up per story id at a time, so a caller that starts it and carries
// on next tick never starts a second.
const lookUpMerged = (id) => {
  if (!lookups.has(id)) {
    lookups.set(
      id,
      mergedPrOfAsync(branchOf(id), (args) => runAsync('gh', args, { cwd: ROOT, timeoutMs: 30_000, track: loopChildren })).finally(() => lookups.delete(id)),
    );
  }
  return lookups.get(id);
};
// A story's status in the story source, or null when it cannot be read.
function statusOf(id) {
  try {
    return stories().list().find((x) => x.id === id)?.status ?? null;
  } catch {
    return null;
  }
}
const git = (cwd, ...args) => sh('git', args, { cwd });

// The refresher of the stories' service, when they come from Jira or Salesforce Cases (not for
// --dry-run, which may wait). The const keeps its name: both have the same interface.
const jira =
  DRY
    ? null
    : CONFIG.stories?.adapter === 'jira'
      ? jiraRefresher({
          stories: () => (LIVE.stories?.adapter === 'jira' ? LIVE.stories : CONFIG.stories),
          stateDir: DIR,
          env: jiraEnv(process.env, CONFIG.envFile ? resolve(ROOT, CONFIG.envFile) : undefined, resolve(ROOT, foremanEnvName(CONFIG))),
          now,
          writeBrief: (id, b) => stories().writeBrief?.(id, b),
          onLoginExpired: () => notify('paused', { reason: EXPIRED_MESSAGE }),
        })
      : CONFIG.stories?.adapter === 'salesforce'
        ? salesforceRefresher({
            stories: () => (LIVE.stories?.adapter === 'salesforce' ? LIVE.stories : CONFIG.stories),
            stateDir: DIR,
            root: ROOT,
            env: process.env,
            features: CONFIG.features,
            salesforceOrgs: CONFIG.salesforce?.orgs,
            now,
            onLoginExpired: () => notify('paused', { reason: SF_EXPIRED_MESSAGE }),
          })
        : null;
if (jira) preferCachedStories({ onQueued: () => jira.drain() });

// ── run-wide state ────────────────────────────────────────────────────────────────────────

const state = () => readState(DIR);
// Through a temp file, as state.mjs writes, so the sync never reads half a file.
function saveRun(patch) {
  const file = join(DIR, 'state.json');
  const text = JSON.stringify({ ...state(), ...patch });
  const tmp = `${file}.${ME}.tmp`;
  writeFileSync(tmp, text);
  renameWritten(tmp, file, text);
}
// The queued work, kept in state.json for status and the page when it changed.
let savedQueued = '';
function saveQueued() {
  const queued = work.map((w) => ({ id: w.id, slot: w.slot ?? null, from: w.from ?? null, mode: w.mode ?? '', ranked: w.ranked === true }));
  const json = JSON.stringify(queued);
  if (json === savedQueued) return;
  savedQueued = json;
  saveRun({ queued });
}
// The stories skipped this run, kept in state.json for status and the page.
function saveSkipped() {
  saveRun({ skipped: [...skipped] });
}
// The pending restart, kept in state.json (without its code id) for status and the page.
function setRestartPending(next) {
  if (next === restartPending || (!next && !restartPending)) return;
  restartPending = next;
  saveRun({ restartPending: next ? { from: next.from, to: next.to, since: next.since } : null });
}
const handled = () => state().handled ?? {};
const markHandled = (key, at) => saveRun({ handled: { ...handled(), [key]: at } });

const schemaExtra = () => readJson(EXTRA, []);
function addSchemaStory(id) {
  const list = schemaExtra();
  if (!list.includes(id)) writeFileSync(EXTRA, JSON.stringify([...list, id]));
}

const control = () => readJson(join(DIR, 'control.json'), {});

// The factory paused itself; a Resume pressed on the page after that clears it.
function autoPaused() {
  const at = state().autoPausedAt;
  if (!at) return false;
  const resumeAt = control().resumeAt;
  if (resumeAt && resumeAt > at) {
    saveRun({ autoPausedAt: null, autoPauseReason: '', autoResumeAt: null });
    event('Resumed from the command centre.');
    return false;
  }
  return true;
}
// `resumeAt` (an ISO time) makes it a credit pause that tries again by itself (checkCredit); the
// stored reason stays plain, the notification says when. A pause already there is left as it is.
function autoPause(reason, { resumeAt = null } = {}) {
  if (state().autoPausedAt) return;
  saveRun({ autoPausedAt: now().toISOString(), autoPauseReason: reason, autoResumeAt: resumeAt });
  setLoop(DIR, 'paused', reason);
  notify('paused', { reason: resumeAt ? `${reason} ${retrySentence(resumeAt, Date.now())}` : reason });
}

// ── email ───────────────────────────────────────────────────────────────────────────────────

// `foreman notify` loads the project's env file itself, so no --env-file here. It and `foreman
// learn` run in children of their own with a time limit (owner-commands.mjs), so neither holds
// the loop; notify() returns the send's promise, which nothing awaits (stop() sends its last
// email through owner.finish).
const FOREMAN_BIN = fileURLToPath(new URL('../../bin/foreman', import.meta.url));
// Every child runs on NODE.node(), a Node that starts (node-path.mjs; see the header).
const NODE = nodeWatch({ execPath: process.execPath, serviceNode: serviceNodeOf({ config: CONFIG, root: ROOT, dir: DIR, env: process.env, fs }), env: process.env, fs, sh: spawnSh(heldSpawnSync), everyMs: Math.min(NODE_CHECK_MS, NODE_CHECK_TICKS * TICK_MS) });
const owner = ownerCommands({ bin: FOREMAN_BIN, root: ROOT, event, node: () => NODE.node() });

function notify(kind, fields = {}) {
  // A config that turned invalid since the last tick is recorded first (configProblem), so
  // `foreman notify` falls back to the last good config. configHealth() sends `config` itself.
  if (kind !== 'config') {
    try {
      applySettings();
    } catch {
      // the email goes out regardless
    }
  }
  return owner.notify(kind, { ...fields, stories: finished, shipped });
}

// ── background jobs ───────────────────────────────────────────────────────────────────────

// `foreman release watch`, the slot environment's sweep and the learning tick, none of which the loop waits on.
const { parkWatch, startParkWatch, envSweep, startEnvSweep, learning } = backgroundJobs({ root: ROOT, dir: DIR, bin: FOREMAN_BIN, node: NODE, envAdapter, settings: () => LIVE, dry: DRY, once: ONCE, state, saveRun, event, guarded, now });

// ── the Claude account checks ─────────────────────────────────────────────────────────────

const { runProbe, signInCheck, checkSignIn, creditCheck, checkCredit, subscriptionCheck, switchToSubscription, checkSubscription } = accountChecks({ root: ROOT, config: CONFIG, dir: DIR, creditRetryMs: CREDIT_RETRY, state, saveRun, event, notify, autoPause, guarded, signins, now });

// ── the schema token and claims ────────────────────────────────────────────────────────────

const { holder, schemaFree, releaseToken, fileWaiters, keptOut, releaseClaim, moveHolds, claim, takeTokenFor } = storyClaims({ dir: DIR, config: CONFIG, own: OWN, me: ME, skipped, stories, event, now });

// ── starting a session ───────────────────────────────────────────────────────────────────────

function slotDown(slot, reason) {
  setSlot(DIR, slot, { state: 'down', reason }, now());
  event(`Slot ${slot} is down: ${reason}`, 'warn', slot);
  notify('down', { slot, reason });
}

// The slot's worktree when worktreeNeeds says nothing must be created or installed, so no child
// runs. Returns its path, or null with the slot put down.
function slotWorktree(slot) {
  try {
    return ensureWorktree({ anchor: ROOT, stateDir: DIR, n: slotIndex(slot) + 1, config: CONFIG }).path;
  } catch (err) {
    slotDown(slot, `Its worktree could not be prepared: ${err.message}`);
    return null;
  }
}

// Acts on the outcome of the slot environment's prepare (slot-prepare.mjs). The environment
// itself may be gone (a container runtime that stopped): one repair per run, then a pause.
// Returns true when the session may start.
function envReady(slot, id, outcome) {
  const v = envVerdict(outcome);
  for (const e of v.events) event(e.text, e.kind);
  if (v.action === 'pause') {
    releaseClaim(id);
    releaseToken(slot);
    autoPause(v.reason);
    return false;
  }
  if (v.action === 'down') {
    downs.set(slot, (downs.get(slot) ?? 0) + 1);
    slotDown(slot, v.reason);
    return false;
  }
  if (v.note) event(`Slot ${slot}: ${v.note}.`, 'info', slot);
  downs.delete(slot);
  return true;
}

// Prepares the slot and starts the story's session. Returns 'started', 'failed', or 'pending'
// when the folder or the environment answers later; then the session starts when it settles, and
// `onFail` is called if it does not. A folder that must be created or installed (a few minutes of
// git and `npm ci`) is prepared by children (prepareWorktree), so the loop keeps ticking.
function launch(slot, id, mode = '', { onFail } = {}) {
  // Preparing a new slot (worktree, npm ci, its stack) can take a few minutes; show it.
  setSlot(DIR, slot, { state: 'building', reason: '', story: readSlot(DIR, slot).story ?? { id, title: '', stage: 'starting', detail: 'preparing the slot', startedAt: now().toISOString(), rounds: 0, committedAt: null } }, now());
  const notStarted = () => {
    const patch = notStartedPatch(readSlot(DIR, slot));
    if (patch) setSlot(DIR, slot, patch, now());
  };
  const n = slotIndex(slot) + 1;
  const needs = worktreeNeeds({ stateDir: DIR, n, config: CONFIG });
  if (!needs.create && !needs.install) {
    const path = slotWorktree(slot);
    if (!path) {
      notStarted();
      return 'failed';
    }
    return afterWorktree(slot, id, mode, path, onFail, notStarted);
  }
  const token = preparing.add(slot, { id });
  launches++;
  event(`Slot ${slot}: preparing its folder for ${id}.`, 'info', slot);
  prepareWorktree({ anchor: ROOT, stateDir: DIR, n, config: CONFIG, track: slotChildren(slot), live: () => preparing.live(slot, token) }).then(
    guarded('a slot folder', (r) => {
      if (!preparing.settle(slot, token)) return;
      if (afterWorktree(slot, id, mode, r.path, onFail, notStarted) === 'failed') onFail?.();
    }),
    guarded('a slot folder', (err) => {
      if (!preparing.settle(slot, token)) return;
      slotDown(slot, `Its worktree could not be prepared: ${err.message}`);
      notStarted();
      onFail?.();
    }),
  );
  return 'pending';
}

// What follows a slot's folder being ready: learned skills, the environment's prepare and the
// session. 'started', 'failed' or 'pending' as launch.
function afterWorktree(slot, id, mode, path, onFail, notStarted) {
  // Learned skills as the settings stand now, so an apply change counts from the next story.
  for (const w of syncLearnedSkills({ path, stateDir: DIR, config: LIVE }).warnings) event(`Slot ${slot}: ${w}`, 'warn', slot);
  const repair =
    envAdapter.repair && !repaired
      ? () => {
          repaired = true;
          return envAdapter.repair();
        }
      : null;
  const finish = (outcome) => {
    if (envReady(slot, id, outcome)) {
      startSession(slot, id, mode, path);
      return true;
    }
    notStarted();
    return false;
  };
  const r = prepareSlot({
    slot,
    id,
    adapter: envAdapter,
    n: slotIndex(slot) + 1,
    path,
    repair,
    pending: preparing,
    later: guarded('a slot environment', (o) => {
      if (!finish(o)) onFail?.();
    }),
    onError: (err) => event(`Supervisor error in a slot environment: ${String(err?.message ?? err).slice(0, 200)}`, 'warn'),
  });
  if (r === PENDING) {
    launches++;
    event(`Slot ${slot}: preparing its environment for ${id}.`, 'info', slot);
    return 'pending';
  }
  return finish(r) ? 'started' : 'failed';
}

function startSession(slot, id, mode, path) {
  const log = session.logPath({ stateDir: DIR, slot, now: now() });
  clearAgents(DIR, slot);
  clearSpans(DIR, slot);
  setSlot(DIR, slot, sessionStartPatch(readSlot(DIR, slot), id, now().toISOString()), now());
  // After the platform credits ran out, every session leaves ANTHROPIC_API_KEY out.
  const signIn = readSignIn(DIR);
  const run = session.command({ id, mode, config: CONFIG, slot, n: slotIndex(slot) + 1, root: ROOT, stateDir: DIR, supervisorPid: ME, envAdapter, baseEnv: process.env, packSession: PACK_SESSION, scope: SESSION_SCOPE, pluginDir: SESSION_PLUGIN.dir, fileKeys: sessionKeys({ root: ROOT, config: CONFIG }), useSubscription: signIn.using === 'subscription', testCores: session.testCoreShare(os.availableParallelism(), workers) });
  // Where Claude Code writes this session's files: from its own env, which may differ from ours.
  const projects = sessionProjectsDir(run.env);
  const child = session.start({ ...run, cwd: path, logFile: log });
  // usedKey: whether the session had a Console key, never the key.
  const entry = { child, pid: child.pid, id, mode, startedAt: Date.now(), log, stop: null, usedKey: Boolean(run.env.ANTHROPIC_API_KEY), holderPid: ME, adopted: false, projects };
  sessions.set(slot, entry);
  if (Number.isInteger(child.pid)) {
    try {
      markSession(DIR, slot, { story: id, pid: child.pid, log, projects });
    } catch (err) {
      event(`Could not note the session files of ${id} (${String(err?.message ?? err).slice(0, 200)}).`, 'warn', slot);
    }
  }
  launches++;
  child.on('exit', () => onExit(slot, entry));
  child.on('error', (err) => {
    event(`Slot ${slot}: the session could not start (${err.message}).`, 'warn', slot);
    onExit(slot, entry);
  });
  event(`Slot ${slot}: ${mode ? `${mode} ` : ''}${id}`, 'story', slot);
  // The owner's "build next" for this story, whose slot was being prepared: it has started now.
  if (nextStarting?.slot === slot) {
    const { asked } = nextStarting;
    nextStarting = null;
    nextStarted(asked);
  }
}

function killSession(slot, why) {
  const s = sessions.get(slot);
  if (!s) return;
  s.stop = why;
  // An interrupted session's files stay to be read, even if it outlives this process.
  if (why === 'interrupt') {
    try {
      keepMark(DIR, slot);
    } catch {
      // onExit keeps them all the same; only a later sweep could miss it
    }
  }
  try {
    process.kill(-s.pid, 'SIGTERM');
  } catch {
    // already gone
  }
  setTimeout(() => {
    try {
      process.kill(-s.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }, 10_000).unref();
}

// ── picking ─────────────────────────────────────────────────────────────────────────────────

// The "build next" request being tried: failedTry's track, and the one slot that says it is
// fetching the story's brief.
let nextTrack = null;
let nextNote = null; // { slot, id }
// The slot whose start is still being prepared for the owner's "build next", and the request it
// answers: { slot, asked }. No other slot picks a story meanwhile, and the request is marked
// started only once the session starts (startSession), so the story asked for starts first and is
// reported after it, as it was when the folder was ready at once.
let nextStarting = null;

function clearNextNote() {
  if (nextNote && readSlot(DIR, nextNote.slot).reason === briefNote(nextNote.id)) setSlot(DIR, nextNote.slot, { reason: '' }, now());
  nextNote = null;
}
// Only one slot says it, however many are free.
function noteNext(slot, id) {
  if (nextNote && nextNote.slot !== slot && readSlot(DIR, nextNote.slot).reason === briefNote(nextNote.id)) return;
  setSlot(DIR, slot, { reason: briefNote(id) }, now());
  nextNote = { slot, id };
}
function nextFailed(req, reason) {
  const r = failedTry(nextTrack, req, reason, now());
  nextTrack = r.track;
  if (r.log) event(r.log, 'warn');
  if (r.wait) setNextWait(DIR, r.wait);
}
function nextStarted(req) {
  settleNextRequest(DIR, req, 'started', now());
  nextTrack = null;
  clearNextNote();
}
// The slot that runs the story asked for, or null (next-request.mjs runningSlot): a session of
// this process or one adopted across a restart, or this factory's claim for one of its slots.
const requestRunningIn = (id) => runningSlot({ id, sessions: [...sessions, ...closing].map(([slot, s]) => ({ slot, id: s.id })), claims: claims(DIR), ours: (pid) => OWN.has(pid), slots: SLOT_IDS });
// A "build next" whose story already runs in a slot is settled as started, with no warning: a
// restart between the pick and the settlement leaves it open (FM-366). A start this process is
// still preparing for the request (pickFetches, nextStarting) settles itself.
function settleRunningRequest() {
  const req = openNextRequest(DIR);
  if (!req || [...pickFetches.values()].includes(req.id) || nextStarting?.asked.id === req.id) return;
  if (requestRunningIn(req.id)) nextStarted(req);
}

// False after parking the slot when its folder has changes that do not belong to a story.
function folderReady(slot) {
  const path = worktreeOf(DIR, slotIndex(slot) + 1);
  if (existsSync(join(path, '.git')) && worktreeDirty(path, { generated: CONFIG.generated })) {
    // Changes left by a story that has ended are saved and cleaned; any others park the slot.
    const ended = endedFolderStory(path);
    if (!ended || !tidyFolder(slot, ended)) {
      setSlot(DIR, slot, { state: 'parked', parkedFor: 'dirty', reason: 'Its folder has changes that do not belong to a story.' }, now());
      const head = git(path, 'rev-parse', '--abbrev-ref', 'HEAD');
      const on = head.status === 0 && head.stdout && head.stdout !== 'HEAD' ? `The folder is on the branch ${head.stdout}.` : 'The folder is on no branch.';
      event(`Slot ${slot} parked: its folder has changes that do not belong to a story. ${on}`, 'warn', slot);
      notify('parked', { slot, parkedFor: 'dirty', reason: 'Its folder has changes that do not belong to a story.' });
      return false;
    }
  }
  return true;
}

// What pick returns when the story it found only waits on running stories (held files or
// resources, or the schema token): nothing could start, so the tick loop does not count it as starved.
const PICK_WAITS = Symbol('pick waits');

// Returns the id of the story it found, started or not. Returns PICK_WAITS when that story only
// waits on running stories, and null when there was none.
function pick(slot) {
  const taken = claims(DIR).map((c) => c.id);
  const free = schemaFree();
  const extra = schemaExtra();
  // A story waiting on files or resources another running story holds is left out of a normal
  // pick (waitBlocks). A skip does not stand in the way of the owner asking for the story by name.

  // The owner's "build this next", if it can be built now and nobody has it. It clears a skip. It
  // stays open until its story has started (see the header), so every pick tries it first; a
  // story that only waits on held files counts as a failed try and keeps its place.
  const req = openNextRequest(DIR);
  if (nextNote && (!req || req.id !== nextNote.id)) clearNextNote();
  let story = null;
  if (req) {
    // Its story is being fetched for, or prepared, in another slot: nothing to decide yet.
    if ([...pickFetches.values()].includes(req.id) || nextStarting?.asked.id === req.id) {
      nothingLeft = false;
      return req.id;
    }
    const s = isStoryId(req.id) ? pickStory({ id: req.id, strict: true }) : null;
    const v = requestVerdict({
      story: s,
      taken: !!s && taken.includes(s.id),
      exclusiveBlocked: !!s && needsExclusive(s, extra) && !free,
      wait: s ? waitOf(DIR, s.id) : null,
      running: s || isStoryId(req.id) ? requestRunningIn(req.id) : null,
    });
    if (v.verdict === 'running') {
      // It runs already (a slot earlier in this tick resumed it): started, and the pick carries on to the normal order.
      nextStarted(req);
    } else if (v.verdict === 'wait') {
      nothingLeft = false;
      nextFailed(req, v.reason);
      return PICK_WAITS;
    } else if (v.verdict === 'take') {
      story = s;
      if (skipped.has(s.id)) {
        skipped.delete(s.id);
        saveSkipped();
        event(`${s.id} is no longer skipped.`, 'info');
      }
    } else if (v.verdict === 'refuse') {
      settleNextRequest(DIR, req, 'refused', now());
      nextTrack = null;
      clearNextNote();
    }
  }
  // Queued work is in hand: the picker must not start a queued, unclaimed In Progress story as a new one.
  story ??= pickStory({ skip: [...taken, ...skipped, ...work.map((w) => w.id)], exclude: keptOut({ extra, free, waiters: fileWaiters() }) });
  if (!story) {
    nothingLeft = true;
    return null;
  }
  nothingLeft = false;
  // The story the owner asked for, when this pick has it.
  const asked = req && story.id === req.id ? req : null;

  const path = worktreeOf(DIR, slotIndex(slot) + 1);
  if (!folderReady(slot)) return story.id;
  // The brief comes from Jira: fetched with await, and the pick tried again next tick.
  if (jira && !jira.briefTried(story.id) && !stories().brief(story.id)) {
    jira.fetchBrief(story.id);
    if (asked) noteNext(slot, story.id);
    return story.id;
  }
  if (!claim(slot, story.id)) {
    if (asked) nextFailed(asked, 'its claim is held elsewhere');
    return story.id;
  }
  // The free files its wait record names are kept for it from the claim on (before the fetch and
  // before spendWait), so a story picked in the next slot this tick cannot take them.
  reserveForStart(DIR, story.id, { now: now() });
  // A new story starts from the newest main, and so does its session's copy of the factory's
  // own skill and scripts (a worktree made before a change to them would run the old ones).
  // The fetch runs in a child, so the loop keeps ticking; the start follows when it is back.
  if (existsSync(join(path, '.git'))) fetchThenStart(slot, story, asked, path);
  else if (!startPicked(slot, story, asked)) return PICK_WAITS;
  return story.id;
}

// The rest of a pick once the slot's folder is at the newest main: the schema token, the spent
// wait record (its files are kept for the story from the claim, in pick), then launch. With `counted` the start was counted when the fetch began, so
// a failure (at once or later) takes it back and a start adds nothing. False when the schema token
// is held by another story, so nothing started.
function startPicked(slot, story, asked, { counted = false } = {}) {
  if (needsExclusive(story, schemaExtra()) && !takeTokenFor(slot, story.id)) {
    releaseClaim(story.id);
    // The story is not started and is kept out of the pick until the token is free.
    dropReservations(DIR, story.id);
    if (counted) started--;
    if (asked) nextFailed(asked, 'the schema token is held by another story');
    return false;
  }
  // An earlier deferral's wait is spent (its files were free to pick it), so a wait at the end
  // of this session is one this session wrote. The count of a holder that still runs stays, so a
  // second deferral on it is counted.
  spendWait(DIR, story.id);
  // A pending start counts toward --max, and stops counting if it then fails.
  // No session will end for a start that fails (onExit drops reservations), so the files kept for
  // the story go free now instead of after RESERVE_MS.
  const unkeep = () => dropReservations(DIR, story.id);
  const r = launch(slot, story.id, '', {
    onFail: () => {
      started--;
      unkeep();
      if (asked && nextStarting?.slot === slot) {
        nextStarting = null;
        nextFailed(asked, readSlot(DIR, slot).reason || 'its slot could not be prepared');
      }
    },
  });
  if (r === 'failed') {
    unkeep();
    if (counted) started--;
  } else if (!counted) started++;
  if (asked) {
    if (r === 'failed') nextFailed(asked, readSlot(DIR, slot).reason || 'its slot could not be prepared');
    else if (r === 'pending') nextStarting = { slot, asked };
    else nextStarted(asked);
  }
  return true;
}

const FETCH_TRIES = 3;

// Fetches the base into the slot's folder in a child (three tries, 3 s apart, 60 s each), checks it
// out, and starts the story. The slot is preparing meanwhile, so no pick and no command treats it
// as free; the claim is held, and the owner's "build next" request for this story stays open
// (pick answers it). A fetch that fails, or a slot cancelled or stopped meanwhile, takes the start
// back, as the synchronous fetch did.
function fetchThenStart(slot, story, asked, path) {
  const id = story.id;
  const token = preparing.add(slot, { id });
  started++;
  launches++;
  pickFetches.set(slot, id);
  setSlot(DIR, slot, { state: 'building', reason: '', story: { id, title: '', stage: 'starting', detail: 'preparing the slot', startedAt: now().toISOString(), rounds: 0, committedAt: null } }, now());
  (async () => {
    for (let i = 0; i < FETCH_TRIES; i++) {
      if (!preparing.live(slot, token)) return false;
      const r = await runAsync('git', ['fetch', '--quiet', CONFIG.remote, CONFIG.baseBranch], { cwd: path, timeoutMs: 60_000, track: slotChildren(slot) });
      if (r.status === 0) return true;
      if (i < FETCH_TRIES - 1 && preparing.live(slot, token)) await sleep(3000);
    }
    return false;
  })().then(
    guarded('a slot fetch', (fetched) => {
      pickFetches.delete(slot);
      if (!preparing.settle(slot, token)) {
        started--;
        return;
      }
      if (fetched && git(path, 'checkout', '--quiet', '--detach', BASE_REF).status === 0) {
        startPicked(slot, story, asked, { counted: true });
        return;
      }
      started--;
      releaseClaim(id);
      const patch = notStartedPatch(readSlot(DIR, slot));
      if (patch) setSlot(DIR, slot, patch, now());
      event(`Slot ${slot}: could not ${fetched ? `check out ${BASE_REF}` : `fetch ${BASE_REF}`}; ${id} not started, trying again next round.`, 'warn', slot);
      if (asked) nextFailed(asked, fetched ? `could not check out ${BASE_REF}` : `could not fetch ${BASE_REF}`);
    }),
  );
}

// ── a slot's folder after its story ──────────────────────────────────────────────────────────

// Saves what a story left uncommitted in its slot's folder on a leftover branch, and leaves the
// folder clean and detached at base (leftovers.mjs). True when the folder is clean after.
function tidyFolder(slot, id) {
  const path = worktreeOf(DIR, slotIndex(slot) + 1);
  if (!existsSync(join(path, '.git'))) return true;
  const r = saveLeftovers({ path, slot, id, base: BASE_REF, generated: CONFIG.generated, keyFiles: [CONFIG.envFile, foremanEnvName(CONFIG)], now: now() });
  for (const text of leftoverEvents({ slot, id, base: BASE_REF, result: r })) event(text, 'warn', slot);
  return r.clean;
}

// The story whose branch a folder is on, when nothing holds it any longer (no claim, session,
// queued work or slot names it), or null. The story is found by the branch name, so one that is
// no longer open (Done in Jira) is still found. It only reads.
function endedFolderStory(path) {
  const head = git(path, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (head.status !== 0) return null;
  let source;
  try {
    source = stories();
  } catch {
    return null;
  }
  let ids = [];
  try {
    ids = source.list().map((s) => s.id);
  } catch {
    // the branch pattern alone
  }
  const id = storyOfBranch(head.stdout, ids, CONFIG.branchPrefix, source.idPattern);
  if (!id) return null;
  const held = heldIds({ claims: claims(DIR), sessions: inHandSessions(), work, slots: SLOT_IDS.map((s) => readSlot(DIR, s)) });
  return held.has(id) ? null : id;
}

// ── a session ended ──────────────────────────────────────────────────────────────────────────

// A child-event handler: an exception here must never take the supervisor down.
function guarded(what, fn) {
  return (...args) => {
    try {
      return fn(...args);
    } catch (err) {
      try {
        event(`Supervisor error in ${what}: ${String(err?.message ?? err).slice(0, 200)}`, 'warn');
      } catch {
        // nothing more to do
      }
      return undefined;
    }
  };
}

// After a story shipped: queue the summary of its group when that was the group's last story.
function queueGroupSummary(slot, id) {
  try {
    const source = stories();
    const all = source.list();
    const group = all.find((s) => s.id === id)?.group;
    if (!group) return;
    const groupOf = (x) => all.find((s) => s.id === x)?.group;
    const w = groupSummaryWork({ source, group, slot, id, queue: work, running: inHandSessions(), groupOf });
    if (w) work.push(w);
  } catch (err) {
    event(`Could not check the group summary after ${id} (${err.message}).`, 'warn', slot);
  }
}

// ── what each session cost ───────────────────────────────────────────────────────────────────

const { takeSpans, saveCheckpoint, dropCheckpoint, recordRun, projectsOf, forgetMark, sweepLeftSessionFiles, endSlotCheckJobs, sweepLeftCheckJobs } = sessionRecords({ dir: DIR, config: CONFIG, settings: () => LIVE, sessions, event, guarded, now });

// The story's own record of what happened to it (engine/story-notes.mjs): through the cache-only
// story source, so a Jira note only joins the outbox the refresher sends and the loop never waits.
// A failure is an event, never the end of the handler that asked.
const tellStory = guarded('a story note', (slot, id, kind, data) => {
  noteOnStory({ root: ROOT, config: LIVE, env: process.env, now, source: stories(), slot }, id, kind, data);
});

// Posts the notes other processes queued (the dashboard's answers, a command's, a hook's), each tick.
const flushNotes = guarded('the story notes', () => {
  flushStoryNotes({ dir: DIR, config: LIVE, root: ROOT, now, cacheOnly: true });
});

const onExit = guarded('a session ending', (slot, entry) => {
  // Handed to the next process, which handles it (see the header).
  if (handedOver) return;
  const s = sessions.get(slot);
  if (!s || s !== entry) return; // already handled (an error and an exit, or a newer session)
  sessions.delete(slot);
  closing.set(slot, s);
  endSlotCheckJobs(slot);
  const spans = takeSpans(slot);
  clearAgents(DIR, slot);
  const id = s.id;
  const shown = readSlot(DIR, slot);
  if (shown.story?.id === id) setSlot(DIR, slot, { story: { ...shown.story, detail: 'closing the session' } }, now());
  // The log and the session's files (megabytes of transcripts) are read in a child of its own, and
  // so is the working tree hash a session with no result needs, so the loop keeps ticking. The
  // child removes the files, unless the session ended in an interrupt (see session-close.mjs).
  const request = { logFile: s.log, projects: projectsOf(slot, s), record: recordsRuns(LIVE), keep: s.stop === 'interrupt', id, worktree: worktreeOf(DIR, slotIndex(slot) + 1), generated: CONFIG.generated, roles: CONFIG.roles };
  runSessionClose({ node: NODE.node(), request, track: loopChildren })
    .then(
      guarded('a session ending', (r) => {
        let answer = r.answer;
        if (!r.ok) {
          answer = fallbackAnswer(s.log);
          event(`Could not read the session files of ${id} in a child of its own (${r.why}); read the end of its log instead.`, 'warn', slot);
        }
        endSession(slot, s, spans, answer);
      }),
    )
    .finally(() => {
      if (closing.get(slot) === s) closing.delete(slot);
    });
});

// The rest of a session's ending, once its log and files are read (the child's answer, see
// session-close.mjs): the result, the checkpoint, the run record, and what the slot and the run do
// next. A failure here is an event, never the end of the supervisor.
function endSession(slot, s, spans, answer) {
  const id = s.id;
  if (answer.kept.length) event(`Kept the session files of ${id} (it ended in an interrupt): ${answer.kept.join(', ')}`, 'warn', slot);
  if (answer.filesError) event(`Could not read or remove the session files of ${id} (${answer.filesError}).`, 'warn', slot);
  const agents = answer.agents;
  forgetMark(slot, s);
  const slotState = readSlot(DIR, slot);

  // Ended by the owner's command, not by the story: handled where the command is.
  if (['skip', 'takeover', 'restart', 'interrupt'].includes(s.stop)) {
    // An interrupt is the run stopping (`foreman stop --now`, a signal): the story resumes at the next start.
    const interrupt = s.stop === 'interrupt';
    if (slotState.story) {
      if (interrupt) endStory(DIR, 'interrupted', '', 'stopped with the run; it resumes at the next start', now(), slot);
      else endStory(DIR, 'failed', '', `stopped: ${s.stop}`, now(), slot);
    }
    const stopped = readSlot(DIR, slot).result;
    recordResult(DIR, stopped, recordRun({ slot, s, log: answer.log, result: interrupt ? 'interrupted' : 'stopped', rounds: stopped?.rounds ?? slotState.story?.rounds ?? 0, spans, learned: learnedOf(slotState, stopped), agents }));
    learning.start();
    afterOwnerStop(slot, id, s.stop);
    return;
  }

  // The watchdog ended it after its story ended (hung's 'ended-quiet', or watch()'s 'ended-alive'):
  // with no result printed, its own `foreman story end` result counts; with none, the resume
  // check closes the slot.
  const spent = s.stop === 'watchdog' && (s.watchdog === 'ended-quiet' || s.watchdog === 'ended-alive');
  // A ready-to-promote claim is trusted only with the park `foreman ship` saved, or the story already done.
  const checked = sessionResult(spentResult(answer.result, { spent, slotResult: slotState.result, id }), { id, parkOf: () => readPark(DIR, id), statusOf: () => stories().list().find((x) => x.id === id)?.status ?? null, storyOpen: Boolean(slotState.story) });
  const capped = signinRun({ cause: checked.run.cause, before: signins.get(id) ?? 0 });
  if (capped.streak > 0) signins.set(id, capped.streak);
  else signins.delete(id);
  const run = capped.gaveUp ? { ...checked.run, cause: null } : checked.run;
  if (capped.gaveUp) event(`${id}: its session died on the Claude sign-in ${capped.streak} times in a row while the sign-in check passed; counting it as a crash.`, 'warn', slot);
  if (checked.warn) event(checked.warn, 'warn', slot);
  if (checked.endReason) endStory(DIR, 'failed', '', checked.endReason, now(), slot);
  // No result: keep what its agents finished for the next session; a result spends the checkpoint.
  const saved = run.result === null ? saveCheckpoint(slot, s, answer) : null;
  if (run.result !== null) dropCheckpoint(slot, id);
  const ceiling = s.stop === 'watchdog' && s.watchdog === 'ceiling';
  const crash = run.result === null && !run.cause && !spent;
  let waiting = false;
  if (run.result === 'blocked') {
    try {
      const source = stories();
      waiting = waitsOnStories(source.list().find((s) => s.id === id)?.blockedBy, { idPattern: source.idPattern });
    } catch {
      // the vault may be briefly unreadable; then it counts as an ordinary block
    }
  }
  // The Console key ran out of credit: may later sessions use the subscription instead?
  const fallback = fallbackOf(LIVE);
  const outOfCredit = run.cause === 'api-credit' && s.usedKey;
  // It may switch: the subscription check that follows says whether a sign-in is there.
  const switchable = outOfCredit && fallback === 'subscription';
  // A story deferred on files (`foreman lock files` wrote its wait) does not need the schema token.
  const deferredOnFiles = run.result === 'deferred' && waitsOnFiles(DIR, id);
  const failCause = failCauseOf({ result: run.result, slotResult: slotState.result, id });
  const o = outcome({ result: run.result, failCause, cause: run.cause, crashesOfStory: crashes.get(id) ?? 0, committed: Boolean(slotState.story?.committedAt), waitsOnStories: waiting, waitsOnFiles: deferredOnFiles, switchable, ceiling, spent });
  if (crash) {
    crashes.set(id, (crashes.get(id) ?? 0) + 1);
    const why = ceiling ? 'stopped at the hard limit' : s.stop === 'watchdog' ? 'stopped by the watchdog' : 'the session ended without reporting a result';
    if (slotState.story) endStory(DIR, 'failed', '', why, now(), slot);
  }
  const done = readSlot(DIR, slot).result;
  const label = run.result ?? run.cause ?? (spent ? 'stopped' : 'crashed');
  const watchdog = s.stop === 'watchdog' ? { why: s.watchdog ?? null, kept: saved?.kept ?? [], redoneTokens: saved?.tokens ?? 0, redoneMinutes: saved?.minutes ?? 0 } : undefined;
  recordResult(DIR, done, recordRun({ slot, s, log: answer.log, result: label, rounds: done?.rounds ?? slotState.story?.rounds ?? 0, spans, learned: learnedOf(slotState, done), agents, cause: failCause === 'environment' && run.result === 'failed' ? 'environment' : undefined, watchdog }));
  learning.start();
  // The ship's findings are in findings.jsonl already; its follow-ups should exist while others build.
  if (run.result === 'shipped') owner.learn({ queue: true });
  finished++;
  if (run.result === 'shipped') shipped++;
  if (run.result === 'empty') nothingLeft = true;

  if (o.claim === 'release') releaseClaim(id);
  // Files kept for this story that it never claimed go free at once, not after 30 minutes.
  if (o.claim === 'release') dropReservations(DIR, id);
  if (o.token === 'release') releaseToken(slot);
  if (o.schemaStory) addSchemaStory(id);

  if (run.result === 'shipped') queueGroupSummary(slot, id);

  const parkAfter = slotState.parkAfter === true;
  const parkedWhy = o.reason === 'ceiling' ? ceilingReason(id) : `The session crashed twice on ${id}.`;
  // A session that ended with no result: say why on the story, and what is kept for the resume.
  if (run.result === null) {
    const ending = sessionEnding({ stop: s.stop, watchdog: s.watchdog, cause: run.cause, resetAt: run.resetAt ?? null, next: o.slot, kept: saved?.kept ?? [], reason: o.slot === 'parked' ? parkedWhy : '', session: s.startedAt });
    if (ending) tellStory(slot, id, 'session', ending);
  }
  if (o.slot === 'resume') {
    // An automatic resume: startWork checks first that the story still needs a session.
    work.unshift({ slot, id, mode: '', resume: true });
    setSlot(DIR, slot, { state: 'idle', reason: '', story: null, result: null }, now());
  } else if (o.slot === 'parked') {
    setSlot(DIR, slot, { state: 'parked', parkedFor: 'crash', parkedStory: id, reason: parkedWhy, story: null, result: null }, now());
  } else if (o.slot === 'held') {
    const why = run.result === 'halted' ? 'This story stopped the release line; waiting for you to fix the cause.' : run.cause ? apiHeldText(null) : 'Committed; releases are frozen by a halt.';
    setSlot(DIR, slot, { state: 'held', reason: why, heldStory: id, haltedBy: run.result === 'halted', heldFor: run.cause ? 'api' : null, story: { id, title: done?.title ?? '', stage: 'release', detail: why }, result: null }, now());
  } else {
    tidyFolder(slot, id);
    setSlot(DIR, slot, { state: parkAfter ? 'parked' : 'idle', parkedFor: parkAfter ? 'owner' : null, parkAfter: false, reason: parkAfter ? 'Parked by you.' : '', story: null, result: null }, now());
  }

  const why = o.env ? envWhy({ reason: o.reason, watchdog: s.stop === 'watchdog', note: slotState.result?.id === id ? slotState.result.note : '' }) : '';
  const after = afterOutcome(counters, o, Date.now(), id, { backoffMs: BACKOFF, why });
  counters = after.counters;
  // The time picking is held for a backoff, for the page's idle slots.
  const backoffAt = backoffShown(counters, Date.now());
  if (backoffAt !== (state().backoffUntil ?? null)) saveRun({ backoffUntil: backoffAt });
  retimeApiHeld();
  // The sign-in failed: check it before the story resumes (see the header).
  if (after.global === 'signin') {
    signInCheck.ids.add(id);
    checkSignIn();
  }
  if (after.global === 'backoff' && after.reason) {
    event(after.reason, 'warn');
    saveRun({ apiWait: { since: state().apiWait?.since ?? now().toISOString(), until: new Date(counters.backoffUntil).toISOString(), step: counters.backoffs } });
  } else if (counters.backoffs === 0 && state().apiWait) {
    saveRun({ apiWait: null });
  }
  // Three endings in a row were the environment: wait (held through counters.envUntil, never the
  // API wait's backoffUntil), say so, and show it as state.json's envWait. Not apiWait, which tells
  // the owner the Claude API is down.
  if (after.global === 'env-backoff') {
    event(after.reason, 'warn');
    saveRun({ envWait: { since: now().toISOString(), until: new Date(counters.envUntil).toISOString(), step: counters.envWaits } });
  } else if (state().envWait && !(counters.envUntil > Date.now())) {
    saveRun({ envWait: null });
  }
  // Already on the subscription (a session still on the key when it switched), or a check
  // already running whose answer covers this story too: nothing more to do.
  if (after.global === 'switch' && readSignIn(DIR).using !== 'subscription' && !subscriptionCheck.running) {
    Object.assign(subscriptionCheck, { since: now().toISOString(), limit: run.limit, resetAt: run.resetAt, fallback, slot });
    checkSubscription();
  }
  if (after.global === 'pause') {
    // A credit pause tries again by itself; the miss pause waits for the owner.
    const again = o.global === 'pause-credit' ? { resumeAt: resumeAtFor({ resetAt: run.resetAt, now: Date.now() }) } : {};
    if (outOfCredit) autoPause(creditPauseReason({ since: now().toISOString(), fallback, limit: run.limit, resetAt: run.resetAt }), again);
    else autoPause(run.cause === 'credit' && run.resetAt ? `${after.reason} It resets ${run.resetAt}.` : after.reason, again);
  }

  if (o.notify === 'parked') notify('parked', { slot, story: id, parkedFor: 'crash', reason: parkedWhy, log: s.log });
  else if (o.notify) notify(o.notify, { slot, story: id, log: s.log });
}

// ── the owner's commands ─────────────────────────────────────────────────────────────────────

const afterOwnerStop = guarded('an owner command', (slot, id, why) => {
  if (why === 'skip') {
    skipped.add(id);
    saveSkipped();
    dropCheckpoint(slot, id);
    letGoClaim(DIR, id, OWN);
    releaseToken(slot);
    updateStory(id, { progress: `Skipped from the command centre for the rest of this run; its branch is kept. \`foreman next ${id}\` (Build next) builds it again.` });
    tidyFolder(slot, id);
    setSlot(DIR, slot, LET_GO_PATCH, now());
    event(`${id} skipped for this run.`, 'warn', slot);
  } else if (why === 'takeover') {
    dropCheckpoint(slot, id);
    handOver(slot, id);
  } else if (why === 'restart') {
    restartFresh(slot, id);
  } else {
    setSlot(DIR, slot, { state: 'idle', story: null, result: null }, now());
  }
});

// Take over: whatever the slot has is committed and pushed, and the story is the owner's.
function handOver(slot, id) {
  const path = worktreeOf(DIR, slotIndex(slot) + 1);
  const branch = branchOf(id);
  const onBranch = git(path, 'rev-parse', '--abbrev-ref', 'HEAD').stdout === branch;
  if (onBranch) {
    if (git(path, 'status', '--porcelain').stdout) {
      git(path, 'add', '-A');
      git(path, 'commit', '--quiet', '-m', `${id} WIP: handed to the owner`);
    }
    git(path, 'push', '--quiet', '-u', CONFIG.remote, branch);
  }
  ownerClaim(DIR, id);
  releaseToken(slot);
  updateStory(id, { fields: { status: 'blocked', blocked_by: 'Taken by the owner' }, progress: `Taken over from the command centre. ${onBranch ? `Its work is on the branch ${branch}.` : 'No work had started.'} Hand it back on the command centre when the factory should carry on.` });
  tidyFolder(slot, id);
  setSlot(DIR, slot, LET_GO_PATCH, now());
  event(`${id} handed to you.`, 'info', slot);
}

function restartFresh(slot, id) {
  const path = worktreeOf(DIR, slotIndex(slot) + 1);
  if (!tidyFolder(slot, id)) {
    git(path, 'reset', '--quiet', '--hard');
    git(path, 'clean', '-fdq');
    git(path, 'checkout', '--quiet', '--detach', BASE_REF);
    event(`Slot ${slot}: the changes in its folder could not be saved, so restarting ${id} fresh discarded them.`, 'warn', slot);
  }
  git(path, 'branch', '-D', branchOf(id));
  crashes.delete(id);
  signins.delete(id);
  dropCheckpoint(slot, id);
  setSlot(DIR, slot, { state: 'idle', reason: '', story: null, result: null, parkedFor: null, parkedStory: null }, now());
  work.unshift({ slot, id, mode: 'fresh' });
}

function slotCommand(slot, action) {
  const st = readSlot(DIR, slot);
  const running = sessions.get(slot);
  const pending = preparing.has(slot);
  const id = slotStoryId({ st, running, claims: claims(DIR), slot });
  const path = worktreeOf(DIR, slotIndex(slot) + 1);
  switch (action) {
    case 'skip':
    case 'takeover':
    case 'restart':
      if (!id) return;
      if (running) killSession(slot, action);
      else {
        // A prepare still in flight never starts a session for a story the owner moved.
        preparing.cancel(slot);
        endChildren(slotChildren(slot));
        afterOwnerStop(slot, id, action);
      }
      return;
    case 'park':
      if (running || pending) setSlot(DIR, slot, { parkAfter: true }, now());
      else if (st.state === 'idle' || st.state === 'down') setSlot(DIR, slot, { state: 'parked', parkedFor: 'owner', reason: 'Parked by you.' }, now());
      return;
    case 'unpark': {
      // The slot lets go of the story it was parked on; the picker takes it again by priority
      // (In Progress first), so no work is queued for it.
      if (st.state !== 'parked') return;
      const gone = id ? letGoClaim(DIR, id, OWN) : null;
      if (id) crashes.delete(id);
      if (id) signins.delete(id);
      releaseToken(slot);
      setSlot(DIR, slot, { state: 'idle', parkedFor: null, parkedStory: null, reason: '' }, now());
      if (gone) event(`Slot ${slot} unparked; let go of ${id}, which is picked again by priority.`, 'info', slot);
      return;
    }
    case 'resume':
      if (st.state === 'down') {
        downs.delete(slot);
        setSlot(DIR, slot, { state: 'idle', reason: '' }, now());
        if (id) work.unshift({ slot, id, mode: '' });
      } else if (st.state === 'parked' && id) {
        crashes.delete(id);
        signins.delete(id);
        setSlot(DIR, slot, { state: 'idle', parkedFor: null, parkedStory: null, reason: '' }, now());
        work.unshift({ slot, id, mode: '' });
      } else if (st.state === 'held') {
        // A story held for the Claude API: queue it now. A backoff still running holds the work
        // back through canPick; a halt's held slot waits for "I've fixed it".
        for (const r of resumeHeld([{ slot, st }])) {
          setSlot(DIR, slot, r.patch, now());
          if (!work.some((w) => w.id === r.work.id)) work.unshift(r.work);
          event(`${r.work.id}: resumed from the command centre.`, 'info', slot);
        }
      }
      return;
    case 'resume-as-is':
      // Keep the changes. With a story they are that story's work; without one they are put
      // aside in a git stash, so nothing is lost and the slot can take a new story.
      if (!id) git(path, 'stash', 'push', '--include-untracked', '--quiet', '-m', `slot ${slot} leftovers ${now().toISOString()}`);
      setSlot(DIR, slot, { state: 'idle', parkedFor: null, reason: '' }, now());
      if (id) work.unshift({ slot, id, mode: '' });
      return;
    case 'discard': {
      git(path, 'reset', '--quiet', '--hard');
      git(path, 'clean', '-fdq');
      git(path, 'checkout', '--quiet', '--detach', BASE_REF);
      // With nothing running or being set up here, the slot lets go of its story too; the picker
      // takes it again by priority.
      const gone = id && !running && !pending ? letGoClaim(DIR, id, OWN) : null;
      if (!running && !pending) releaseToken(slot);
      setSlot(DIR, slot, { state: 'idle', parkedFor: null, parkedStory: null, reason: '' }, now());
      if (gone) event(`Slot ${slot} reset; let go of ${id}, which is picked again by priority.`, 'info', slot);
      return;
    }
    default:
  }
}

// The slots held for the Claude API show when the wait ends. A later backoff can move that time,
// so the shown text follows counters.backoffUntil.
function retimeApiHeld() {
  const why = apiHeldText(counters.backoffUntil > Date.now() ? hhmm(counters.backoffUntil) : null);
  for (const slot of SLOT_IDS) {
    const st = readSlot(DIR, slot);
    if (st.state !== 'held' || st.heldFor !== 'api') continue;
    if (st.reason === why && st.story?.detail === why) continue;
    setSlot(DIR, slot, { reason: why, story: st.story ? { ...st.story, detail: why } : st.story }, now());
  }
}

// Once the Claude API wait is over (and nothing is paused, halted or stopping), the slots held
// for it are released and their stories queued, as an automatic resume, to start again this tick. A slot a
// halt holds waits for "I've fixed it" (fixed). On a fresh start the counters are zero, so a slot
// an earlier run held is released at the first tick; a story already queued or running is not
// queued twice.
function releaseApiHeld({ halted, paused, stopping }) {
  const inHand = new Set([...work.map((w) => w.id), ...inHandSessions().map((s) => s.id)]);
  const slots = SLOT_IDS.map((slot) => ({ slot, st: readSlot(DIR, slot) }));
  for (const r of releaseAfterWait(slots, { halted, paused, stopping, backoffUntil: counters.backoffUntil, now: Date.now(), inHand })) {
    setSlot(DIR, r.slot, r.patch, now());
    if (r.work) work.push(r.work);
    const id = r.work?.id ?? slots.find((x) => x.slot === r.slot).st.heldStory;
    event(`${id}: the Claude API wait is over; carrying on from where it stopped.`, 'info', r.slot);
  }
}

// "I've fixed it": run `foreman health` (the configured ship steps' checks, such as the live
// site and the hosted database); only when it passes, clear the halt and release what was
// held, oldest first. The check loads the project's env file itself. A released slot keeps
// heldStory until the story's session starts (startSession), so the env sweep keeps its org.
function fixed() {
  // A press while a check runs is folded into it.
  if (!existsSync(HALT) || fixCheck) return;
  fixCheck = runAsync(NODE.node(), [FOREMAN_BIN, 'health'], { cwd: ROOT, timeoutMs: 120_000, track: loopChildren })
    .then(
      guarded('the health check', (res) => {
        // Cleared meanwhile (the halt file removed by hand): nothing to judge.
        if (!existsSync(HALT)) return;
        const answer = afterFixCheck({ status: res.status, stdout: res.stdout.trim() });
        if (!answer.clear) {
          saveRun({ fixProblem: answer.fixProblem });
          event(answer.event.text, answer.event.kind);
          return;
        }
        rmSync(HALT, { force: true });
        haltSeen = false;
        saveRun({ fixProblem: null });
        event(answer.event.text, answer.event.kind);
        for (const r of releaseHeld(SLOT_IDS.map((slot) => ({ slot, st: readSlot(DIR, slot) })))) {
          setSlot(DIR, r.slot, r.patch, now());
          work.push(r.work);
        }
      }),
    )
    .finally(() => {
      fixCheck = null;
    });
}

function handBack(id) {
  const c = holderOf(claimFile(DIR, id));
  if (c?.by !== 'owner') return;
  rmSync(claimFile(DIR, id), { force: true });
  updateStory(id, { fields: { status: 'todo', blocked_by: '' }, progress: 'Handed back to the factory from the command centre.' });
  event(`${id} handed back to the factory.`, 'info');
}

function commands() {
  const c = control();
  for (const cmd of pendingCommands(c, handled(), SLOT_IDS)) {
    // The slot's session is being read: the command is left unmarked, so it applies once that ends.
    if (cmd.kind === 'slot' && closing.has(cmd.slot)) continue;
    markHandled(cmd.key, cmd.at);
    // Applied with any settings change in applySettings(), the newer one winning.
    if (cmd.kind === 'workers') workerChanges.push({ value: cmd.value, at: Date.parse(cmd.at) || Date.now() });
    else if (cmd.kind === 'slot') slotCommand(cmd.slot, cmd.action);
    else if (cmd.kind === 'fixed') fixed();
    else if (cmd.kind === 'handback') handBack(cmd.id);
    else if (cmd.kind === 'answer-retry') retryAnswer(cmd.id);
  }
}

// The owner pressed Retry on a failed answer: due now, applied by the next startAnswers.
function retryAnswer(id) {
  const failure = answerFailures.get(id);
  if (!failure) return;
  answerFailures.set(id, { ...failure, retryAt: now().toISOString() });
  saveAnswerFailures();
  event(`Retrying your answer to "${failure.title}" now.`, 'info');
}

// Re-reads the settings when a file changed, and sets the worker count for the next pick.
function applySettings() {
  const step = live.beforePick({ current: workers, control: workerChanges.splice(0) });
  LIVE = step.config ?? LIVE;
  for (const e of step.events) event(e.text, e.kind);
  if (step.workers !== workers) {
    workers = step.workers;
    setWorkers(DIR, workers);
  }
  configHealth();
}

// Records whether the run is on the last good config (state.json configProblem, one `config`
// notification per episode, saved first because the notifier falls back to it) and saves each
// valid config as the last good one. The warning event itself comes from live-settings.mjs.
function configHealth() {
  const problem = live.problem;
  if (typeof problem === 'string' && problem !== configProblem?.reason) {
    const fresh = configProblem === null;
    configProblem = { since: configProblem?.since ?? now().toISOString(), reason: problem };
    saveRun({ configProblem });
    if (fresh) notify('config', { reason: problem });
  } else if (problem === null && configProblem) {
    configProblem = null;
    saveRun({ configProblem: null });
  }
  if (problem === null && live.team && live.team !== savedTeam) {
    saveLastGood(DIR, live.team);
    savedTeam = live.team;
  }
}

// ── the watchdog ─────────────────────────────────────────────────────────────────────────────

function lastActivity(slot, s) {
  const times = [s.startedAt];
  for (const a of runningAgents(DIR, slot)) times.push(Date.parse(a.lastAt) || 0);
  const beat = readSlot(DIR, slot).lastBeat;
  if (beat) times.push(Date.parse(beat) || 0);
  // The session writes a stream-json event to its log for every message and tool result
  // (session.mjs), so a growing log is activity, the main conversation's own included.
  try {
    times.push(statSync(s.log).mtimeMs);
  } catch {
    // no log yet
  }
  return Math.max(...times);
}

// The watchdog's limits, from watchdog.* in the settings in effect.
const minutes = (m) => (m % 60 === 0 ? `${m / 60} ${m === 60 ? 'hour' : 'hours'}` : `${m} ${m === 1 ? 'minute' : 'minutes'}`);
// Why a slot is parked after the hard ceiling (Waiting on you, the email).
const ceilingReason = (id) =>
  `${id} was still building after ${minutes(watchdogLimits(LIVE).ceilingMinutes)} (4 times the build limit) while still making progress. Resume carries on from its last finished stage; Restart begins it again from main.`;

// Once per session, from the head of its log: a warn event when its init event shows Foreman
// loaded from anywhere but PLUGIN_DIR. The init is not written yet: try again next tick. A log
// that is cut at the bytes read and has no init is not looked at again.
function checkSessionPlugin(slot, s) {
  const head = readHead(s.log);
  const init = readInit(head.text);
  if (!init && !head.cut) return;
  s.pluginChecked = true;
  const w = initPluginWarning({ id: s.id, init, expected: PLUGIN_DIR });
  if (w) event(w, 'warn', slot);
}

function watch() {
  const limits = watchdogLimits(LIVE);
  const graceMs = outliveMs(LIVE);
  for (const [slot, s] of sessions) {
    if (s.stop) continue;
    if (!s.pluginChecked) checkSessionPlugin(slot, s);
    const st = readSlot(DIR, slot);
    // A session still up a while after printing its final result (session-outlive.mjs).
    // No log yet: only the outlive check is skipped, the watchdog below still runs.
    let quietSince = null;
    try {
      quietSince = statSync(s.log).mtimeMs;
    } catch {
      // no log yet
    }
    if (quietSince !== null && Date.now() - quietSince >= graceMs) {
      const o = outlived({ tail: readTail(s.log), quietSince, now: Date.now(), graceMs });
      if (o) {
        event(`${s.id}: its session printed its result (${o.result}) ${Math.round(o.forMs / 1000)} s ago but is still running; ending it.`, 'warn', slot);
        killSession(slot, 'outlived');
        continue;
      }
    }
    // Its own `foreman story end` ran graceMs ago and it is still up (a workflow it started still
    // running): end it as one that printed its result; its own end stands (onExit's spent). When
    // the log already holds a printed final result, `outlived` above ends it once the log has been
    // quiet for the grace, so this stands down.
    const late = endedLate({ slotResult: st.result, slotStory: st.story, id: s.id, now: Date.now(), graceMs, tailOf: () => readTail(s.log) });
    if (late) {
      event(`${s.id}: its story ended (${late.result}) ${Math.round(late.forMs / 1000)} s ago, but its session is still running; ending it.`, 'warn', slot);
      s.watchdog = 'ended-alive';
      killSession(slot, 'watchdog');
      continue;
    }
    const committedAt = st.story?.committedAt;
    // Progress: a stage or detail change, or an agent starting or finishing (state.mjs), or an
    // agent's tool step (the newest lastAt in the slot's agent files; one older than the session
    // does no harm, hung takes the max with the start).
    const progressAt = Math.max(s.startedAt, Date.parse(st.story?.progressAt) || 0);
    const step = newestStep(runningAgents(DIR, slot));
    // startSession clears the slot's result, so a result for this story is this session's own
    // `foreman story end`.
    const input = {
      startedAt: s.startedAt,
      committedAt: committedAt ? Date.parse(committedAt) : null,
      lastActivity: lastActivity(slot, s),
      progressAt,
      stepAt: step?.at ?? null,
      stage: st.story?.stage ?? null,
      ended: st.result?.id === s.id,
    };
    const t = Date.now();
    let why = hung(input, t, limits);
    // A session whose story is settled or whose pull request merged is judged as an ended one:
    // only the quiet limit applies. s.shipped is kept, so gh is asked at most once per session;
    // it is asked in a child, and the session is judged again on the tick that has the answer.
    if (why && why !== 'ended-quiet') {
      if (s.shipped === undefined && SETTLED.includes(statusOf(s.id))) s.shipped = true;
      else if (s.shipped === undefined) {
        s.shippedLookup ??= lookUpMerged(s.id).then((pr) => {
          s.shipped = pr !== null;
        });
        continue;
      }
      if (s.shipped) why = hung({ ...input, ended: true }, t, limits);
    }
    if (!why) continue;
    if (why === 'ended-quiet') {
      event(`${s.id}: its story has ended, but its session has had no activity for ${minutes(limits.quietMinutes)}; ending it without a resume.`, 'warn', slot);
      s.watchdog = 'ended-quiet';
      killSession(slot, 'watchdog');
      continue;
    }
    const text = {
      'too-long': `no progress for ${minutes(limits.buildMinutes)} (no stage change, no agent starting or finishing and no agent step; ${lastProgressText({ startedAt: s.startedAt, progressAt: Date.parse(st.story?.progressAt) || null, step }, t)}); stopping the session to resume it.`,
      quiet: `no activity for ${minutes(limits.quietMinutes)}; stopping the session to resume it.`,
      ceiling: `still building after ${minutes(limits.ceilingMinutes)} although it is making progress; stopping it and asking you what to do.`,
    }[why];
    event(`${s.id}: ${text}`, 'warn', slot);
    s.watchdog = why;
    killSession(slot, 'watchdog');
  }
}

// An adopted session is not this process's child, so no exit event comes for it: its pid is
// polled instead (handover.mjs sessionAlive).
function pollAdopted() {
  for (const [slot, s] of sessions) if (s.adopted && !sessionAlive(s)) onExit(slot, s);
}

// ── the progress watchdog ────────────────────────────────────────────────────────────────────

// After each loop: whether the run is making progress (see the header). `error` is the loop's
// error text, or null when it ran clean; a throwing loop leaves the idle clock as it is.
const checkProgress = guarded('the progress watchdog', (error) => {
  const stages = stageMap(LIVE);
  const list = [...sessions]
    .filter(([, s]) => !s.stop)
    .map(([slot, s]) => {
      const story = readSlot(DIR, slot).story;
      const agents = runningAgents(DIR, slot);
      // Log output, hook steps and agents' last steps (lastActivity), or the session's CPU.
      const pid = s.pid;
      const busyAt = pid ? cpu.activeAt(slot, pid, Date.now()) : null;
      return {
        slot,
        id: s.id,
        progressAt: Math.max(s.startedAt, Date.parse(story?.progressAt) || 0),
        activeAt: Math.max(lastActivity(slot, s), busyAt ?? 0),
        // The same stage snapshot() shows: a running agent's, else the story's.
        stage: agents.map((a) => stages[a.role]).find(Boolean) ?? story?.stage,
        rounds: story?.rounds ?? 0,
        steps: agents.reduce((sum, a) => sum + (Number(a.tools) || 0), 0),
      };
    });
  const r = progress.loop({ now: Date.now(), error, starved: error ? undefined : starvedId, sessions: list }, stuckLimits(LIVE));
  if (r.changed) saveRun({ stuck: r.stuck });
  if (r.slowChanged) saveRun({ slow: r.slow });
  if (r.fresh) {
    const text = `${stuckTitle(r.stuck.since, now())}: ${r.stuck.reason}`;
    event(text, 'warn');
    notify('stuck', { reason: text });
  }
  if (r.cleared) event('Making progress again.', 'info');
});

// ── start-up reconciliation ──────────────────────────────────────────────────────────────────

// What start-up must do, from the ship lock, the claims, merged pull requests and the stories.
// Reads only.
function recoveryPlan() {
  const ship = holderOf(SHIP(DIR));
  const all = stories().list();
  let merged = [];
  const prs = sh('gh', ['pr', 'list', '--state', 'merged', '--limit', '50', '--json', 'headRefName'], { cwd: ROOT, ...NET_LIMIT });
  if (prs.status === 0) {
    try {
      merged = closableMergedIds(JSON.parse(prs.stdout).map((p) => p.headRefName), all, CONFIG.branchPrefix);
    } catch {
      // carry on without it
    }
  }
  const remote = sh('git', ['ls-remote', '--heads', CONFIG.remote, `${CONFIG.branchPrefix}*`], { cwd: ROOT, ...NET_LIMIT }).stdout;
  const hasBranch = (id) => remoteHasBranch(remote, branchOf(id)) || git(ROOT, 'rev-parse', '--verify', '--quiet', branchOf(id)).status === 0;
  const inProgress = all.filter((s) => s.status === 'in-progress').map((s) => ({ id: s.id, branch: hasBranch(s.id) }));
  return reconcile({
    shipLock: ship ? { story: ship.story, slot: ship.slot, stage: ship.stage, stale: ship.stale } : null,
    claims: claims(DIR),
    mergedNotDone: merged,
    inProgress,
    mustFinish: mustFinishFor(CONFIG),
    readyToPromote: all.filter((s) => s.status === READY).map((s) => s.id),
    priority: [...all].sort(byPriority).map((s) => s.id),
  });
}

function reconcileStart() {
  const plan = recoveryPlan();
  // A story an adopted session runs, or one already queued, is not queued again (nor its event).
  const inHand = new Set([...[...sessions.values()].map((s) => s.id), ...work.map((w) => w.id)]);
  let quiet = false;
  const ranked = [];
  for (const e of recoverySteps(plan)) {
    if (e.do === 'break-ship') breakIfStale(SHIP(DIR));
    else if (e.do === 'break-claim') breakIfStale(claimFile(DIR, e.id));
    else if (e.do === 'queue') {
      quiet = inHand.has(e.id);
      if (quiet) continue;
      const w = { slot: e.slot, id: e.id, mode: e.mode, ...(e.from ? { from: e.from } : {}), ...(e.ranked ? { ranked: true } : {}) };
      work.push(w);
      if (w.ranked) ranked.push(w);
    } else if (e.do === 'event') {
      if (!quiet) event(e.text, e.kind, e.slot);
      quiet = false;
    }
  }
  // A start-up resume is not pinned to its old slot, and a pick into that slot would find the
  // story's branch checked out and its changes in the way. So each old folder is freed now: its
  // unfinished work committed on the story branch (the checkpoint's tree, so the finished stages
  // are kept) and the folder detached and clean. The story skill's resume rule checks the branch
  // out again. An adopted session's folder is never touched.
  for (const w of ranked) {
    if (!w.from || !slotNumber(w.from) || sessions.has(w.from)) continue;
    const branch = branchOf(w.id);
    const r = freeStoryFolder({ path: worktreeOf(DIR, slotNumber(w.from)), id: w.id, branch, from: w.from, to: null, base: BASE_REF, generated: CONFIG.generated, message: `${w.id} WIP: kept at start-up from slot ${w.from}` });
    if (r.freed) {
      if (r.committed) event(`Start-up: ${w.id}'s unfinished work in ${w.from} is committed on ${branch}.`, 'info', w.from);
    } else {
      w.slot = w.from;
      delete w.ranked;
      event(`Start-up: could not free ${w.from}'s folder for ${w.id} (${r.problem}); it resumes in ${w.from}.`, 'warn', w.from);
    }
  }
  // A stale schema token whose story is not being resumed is let go.
  const token = holderOf(SCHEMA(DIR));
  if (token?.stale && !work.some((w) => w.id === token.story)) breakIfStale(SCHEMA(DIR));
  // Slots of a run that died are idle now unless parked, held or down (parked and down wait for the owner; held ones for the API's wait or a halt).
  for (const slot of SLOT_IDS) {
    if (sessions.has(slot)) continue; // an adopted session's slot keeps its story
    const st = readSlot(DIR, slot);
    if (['building', 'waiting'].includes(st.state)) setSlot(DIR, slot, { state: 'idle', story: null }, now());
  }
  return plan;
}

// After a restart on new code: the sessions, queued work and crash counts the old process handed
// over (see the header). This process vouches for the pids their locks name from now on. The
// adopted sessions are in `sessions` before the first await, so a stop from then on ends them. A
// handed-over session it cannot adopt (a slot this config does not have, a second one for a slot)
// is ended, SIGTERM then SIGKILL, and its claim and locks let go, so start-up recovery can resume
// its story in a slot this process has. adoptCarried is synchronous: it adopts, pushes what it kept
// onto `kept` (main() words the one "Kept N" event) and returns the sessions it could not adopt,
// which endDropped ends once the live scan has run.
function adoptCarried(kept) {
  const list = adoptable(CARRIED?.sessions, SLOT_IDS);
  const dropped = leftOut(CARRIED?.sessions, list);
  for (const pid of adoptedPids(CARRIED?.pid, [...list, ...dropped])) OWN.add(pid);
  const vouched = [...OWN].filter((p) => p !== ME);
  if (vouched.length) writeAdopted(DIR, { by: ME, pids: vouched });
  for (const a of list) {
    sessions.set(a.slot, { child: null, pid: a.pid, id: a.id, mode: a.mode, startedAt: a.startedAt, log: a.log, usedKey: a.usedKey, holderPid: a.holderPid, stop: null, adopted: true, pluginChecked: true });
  }
  for (const w of Array.isArray(CARRIED?.work) ? CARRIED.work : []) if (typeof w?.id === 'string') work.push(w);
  const carriedCrashes = CARRIED?.crashes && typeof CARRIED.crashes === 'object' ? CARRIED.crashes : {};
  for (const [id, n] of Object.entries(carriedCrashes)) if (Number.isInteger(n) && n > 0) crashes.set(id, n);
  kept.push(...list);
  return dropped;
}

async function endDropped(dropped) {
  for (const d of dropped) {
    event(`${d.id}: its session in ${d.slot} could not be kept across the restart; ending it.`, 'warn', null);
    // Signalled only while ps shows it is still that story's session, never a reused pid.
    if (sessionAlive(d)) {
      try {
        process.kill(-d.pid, 'SIGTERM');
      } catch {
        // already gone
      }
      for (let waited = 0; sessionAlive(d) && waited < STOP_WAIT_MS; waited += 250) await sleep(250);
      if (sessionAlive(d)) {
        try {
          process.kill(-d.pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
    releaseClaim(d.id);
    if (typeof d.slot === 'string') releaseToken(d.slot);
  }
}

// Story sessions already running in the slots' folders that neither a start-up nor a handover
// brought in (live-sessions.mjs): after a hard kill or a crash, or a restart whose handover did
// not reach this process. Every slot folder is scanned. For a slot with no session in hand, the
// oldest session running in its folder is adopted as a handed-over one is, so start-up recovery
// does not start its story again beside it. Its claim names the supervisor that started it; this
// process vouches for that pid (supervisor-adopted.json), as it does after a handover. A claim a
// live run of someone else holds is said so once and left alone. A slot already in hand (a
// handed-over session, say) only gets the double warning when its folder has a second session.
// The second session is never ended from here. An unmarked session in a folder with a double gets
// an empty log, never the other session's transcript. usedKey is not known for a session found
// this way, so it reads as no key. The caller owns `found` ({ kept, doubles }) and words the
// events; `skip` are pids being ended. A failure is a warn event and the start goes on.
const adoptLive = guarded('the live sessions scan', (found, skip = []) => {
  const list = listStorySessions();
  if (!list?.length) return;
  const folders = Object.fromEntries(SLOT_IDS.map((slot) => [slot, worktreeOf(DIR, slotIndex(slot) + 1)]));
  const held = Object.fromEntries([...sessions].map(([slot, s]) => [slot, { pid: s.pid, id: s.id }]));
  const { keep, doubles } = planLive({ list, folders, held, own: [...[...sessions.values()].map((s) => s.pid), ...skip] });
  found.doubles.push(...doubles);
  const doubled = new Set(doubles.map((d) => d.slot));
  try {
    for (const a of keep) {
      const { holderPid, heldBy } = holderFor({ claim: claims(DIR).find((c) => c.id === a.id), slot: a.slot, ours: OWN, me: ME });
      if (heldBy) {
        event(`${a.id}: a session (pid ${a.pid}) is running in ${a.slot}, but ${heldBy} holds the story; leaving it alone.`, 'warn', a.slot);
        continue;
      }
      const log = logFor({ mark: readMark(DIR, a.slot), kept: a, doubled: doubled.has(a.slot), folder: join(DIR, 'logs') });
      OWN.add(holderPid);
      sessions.set(a.slot, { child: null, pid: a.pid, id: a.id, mode: a.mode, startedAt: Date.now() - a.ageMs, log, usedKey: false, holderPid, stop: null, adopted: true, pluginChecked: true });
      found.kept.push(a);
    }
  } finally {
    const vouched = [...OWN].filter((p) => p !== ME);
    if (vouched.length) writeAdopted(DIR, { by: ME, pids: vouched });
  }
});

function startWork(slot, w) {
  // Work rehomed from a slot over the worker count: this slot's folder must be fit to use, and the
  // claim and locks follow the work. The claim is checked before the old folder is freed, and once
  // the work has moved it no longer carries `from`, so a retry is a plain resume (move-work.mjs).
  // An automatic resume of a story that needs no session closes the slot instead, marking the
  // story done first when only its pull request merged (resume-close.mjs). The old folder still
  // has the story branch checked out: its unfinished work goes onto the branch and the folder is
  // detached, so this slot's session can check the branch out.
  const step = takeOver(w, slot, {
    workers,
    branch: branchOf(w.id),
    folderReady: () => folderReady(slot),
    moveHolds: (from) => moveHolds(from, slot, w.id),
    claim: () => claim(slot, w.id),
    closed: () =>
      Boolean(
        w.resume &&
          closeInstead(w.id, {
            statusOf,
            mergedPr: () => mergedFor.get(w)?.pr ?? null,
            markDone: (pr) => stories().update(w.id, doneChange(`Its pull request ${pr} merged; marked done by Foreman without a new session after its session ended.`, now())),
            close: () => {
              releaseClaim(w.id);
              releaseToken(slot);
              crashes.delete(w.id);
              signins.delete(w.id);
              dropCheckpoint(slot, w.id);
              setSlot(DIR, slot, { state: 'idle', reason: '', story: null, result: null }, now());
            },
            event: (text, kind) => event(text, kind, slot),
          }),
      ),
    freeFolder: (from) => freeStoryFolder({ path: worktreeOf(DIR, slotNumber(from)), id: w.id, branch: branchOf(w.id), from, to: slot, base: BASE_REF, generated: CONFIG.generated }),
    letGo: () => {
      releaseClaim(w.id);
      releaseToken(slot);
    },
    event: (text, kind) => event(text, kind, slot),
  });
  if (step === 'wait') {
    work.unshift(w);
    return;
  }
  if (step !== 'start') return;
  const t = holderOf(SCHEMA(DIR));
  if (t?.story === w.id) takeTokenFor(slot, w.id);
  const r = launch(slot, w.id, w.mode, { onFail: () => work.unshift(w) });
  if (r === 'failed') work.unshift(w);
}

// Lets go of the factory claims whose slot moved on (scheduler.mjs looseClaims), even under this
// process's live pid, with a warn event each: the stories running, being set up or queued keep
// theirs. Runs every tick before the picks, so a story let go is picked in the same tick.
const sweepClaims = guarded('the claim sweep', () => {
  const inHand = new Set(inHandSessions().map((s) => s.id));
  for (const w of work) inHand.add(w.id);
  for (const slot of SLOT_IDS) {
    const id = preparing.has(slot) ? readSlot(DIR, slot).story?.id : null;
    if (id) inHand.add(id);
  }
  const slots = Object.fromEntries(SLOT_IDS.map((slot) => [slot, readSlot(DIR, slot)]));
  for (const r of looseClaims({ claims: claims(DIR), slots, inHand, ours: (c) => OWN.has(c.pid) || c.stale })) {
    if (letGoClaim(DIR, r.id, OWN)) event(looseClaimText(r), 'warn', r.slot);
  }
});

// Removes the owner claims on stories that are done or retired, or have been missing from the
// source's (non-empty) list for more than a poll (scheduler.mjs settledOwnerClaims), with an info
// event each. The list is read only while an owner claim exists, from the cache (the supervisor's
// sources are cache-only), so the tick never waits on Jira or sf. When each missing story was
// first seen missing is kept in state.json (ownerClaimsAbsent), written only when it changed, so
// a restart does not reset the clock.
const sweepOwnerClaims = guarded('the owner claim sweep', () => {
  const owned = claims(DIR).filter((c) => c.by === 'owner');
  const before = state().ownerClaimsAbsent ?? {};
  let list = null;
  if (owned.length) {
    try {
      list = stories().list();
    } catch {
      list = null;
    }
  }
  const r = settledOwnerClaims({ claims: owned, stories: list, absentSince: before, now: now().getTime(), absentMs: Math.max(TICK_MS, (LIVE.stories?.pollSeconds ?? OWNER_CLAIM_POLL_SECONDS) * 1000) });
  for (const d of r.drop) if (dropOwnerClaim(DIR, d.id, d.at)) event(ownerClaimText(d), 'info');
  if (JSON.stringify(r.absentSince) !== JSON.stringify(before)) saveRun({ ownerClaimsAbsent: r.absentSince });
});

// ── the loop ─────────────────────────────────────────────────────────────────────────────────

// ── the console ──────────────────────────────────────────────────────────────────────────────

// The artifacts console is pushed by sync.mjs, a child of its own, because each push is a
// Claude call that takes seconds; the push itself is in lib/adapters/console/artifacts.mjs.
// Every other console is sent the snapshot from here, when it changed and at least every few
// minutes.
const SYNC = fileURLToPath(new URL('./sync.mjs', import.meta.url));
let consoleAdapter = null;
let dashboard = null; // the dashboard's server, when console.adapter is `dashboard`

const { publish, enterStandby, checkOwnerTasks, leaveStandby, standbyOn, standbySince } = standbyWatch({
  root: ROOT,
  config: CONFIG,
  dir: DIR,
  tickMs: TICK_MS,
  dry: DRY,
  settings: () => LIVE,
  consoleAdapter: () => consoleAdapter,
  awake: () => awake,
  stopping: () => stopping,
  exiting: () => exiting,
  owner,
  notify,
  state,
  saveRun,
  event,
  now,
});

// ── the loop ─────────────────────────────────────────────────────────────────────────────────

const STOP_WAIT_MS = 10_000;

// The stray supervisors (see the header), at the first loop and every STRAY_CHECK_MS after,
// for a run with no leash; state.json's strays changes only when the pids do.
const STRAY_CHECK_MS = 10 * 60_000;
let strayCheckAt = 0;
function checkStrays() {
  if (LEASHED || ONCE || DRY || Date.now() < strayCheckAt) return;
  strayCheckAt = Date.now() + STRAY_CHECK_MS;
  try {
    const patch = strayPatch(state().strays, findStrays({ root: ROOT, dir: DIR }), now().toISOString());
    if (patch) saveRun(patch);
  } catch {
    // a look that fails changes nothing; the next one tries again
  }
}

// Stops the sessions still running (SIGTERM, then SIGKILL for any still there after 10 s),
// records why, emails, and exits. `loop` is the state left for the console.
async function stop(code, reason, { loop = code === 2 ? 'halted' : 'stopped' } = {}) {
  if (exiting) return;
  exiting = 'stop';
  stopping = true;
  // Nothing launches after stopping begins; a slot being set up loses its install or fetch.
  preparing.close();
  for (const set of slotChildrenOf.values()) endChildren(set);
  try {
    const running = [...sessions.entries()];
    for (const [slot] of running) killSession(slot, 'interrupt');
    for (let waited = 0; (sessions.size > 0 || closing.size > 0 || answersRun || parkWatch.child || learning.running()) && waited < STOP_WAIT_MS; waited += 250) {
      await sleep(250);
      pollAdopted();
    }
    // What the loop still has running (an answer step, a session read) is not waited for any longer.
    endChildren(loopChildren);
    for (const [, s] of running) {
      try {
        process.kill(-s.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    for (const t of loopErrors.clear(now())) event(t, 'warn');
    awake?.release();
    setLoop(DIR, loop, reason);
    clearAgents(DIR);
    jira?.stop();
    console.log(reason);
    // The last `foreman learn` (a problem there only costs the proposals) and the stopped or
    // halted email, side by side, so the stop waits for the slower and not for both in turn. A
    // scheduled job ending is not news; a halt is.
    await owner.finish(code === 2 || !ONCE ? (code === 2 ? 'halted' : 'stopped') : null, { reason, stories: finished, shipped });
    // After the email, which may still need the last good config: a stopped run is on no config,
    // and is never stuck.
    saveRun({ configProblem: null, stuck: null, slow: [], restartPending: null, skipped: [], apiWait: null, envWait: null, anchorWait: null, backoffUntil: null, answerFailures: [], learningFailed: null });
    await publish(true).catch(() => {});
    // The emails still on their way: their children are detached, so they would outlive this
    // process, but an exit before they end would lose their warnings.
    await owner.settled();
    dashboard?.close();
  } catch (err) {
    console.error(`Supervisor error while stopping: ${err?.message ?? err}`);
  } finally {
    process.exit(code);
  }
}

// Exits for startSupervisor to start this run again on the new code (see the header): no slot
// is being set up and no session is being stopped by now. The run's counts, the sessions still
// running, the queued work and the crash counts go into state.json's `restart` for the new
// process, and supervisor-adopted.json vouches for this pid before it exits. The sessions keep
// running; their endings are the new process's. No email and no `foreman learn`: the run
// carries on.
async function restartOnNewCode({ from, to }, text = `Restarted on new code (${from} -> ${to}).`) {
  if (exiting) return;
  handedOver = true;
  exiting = 'restart';
  preparing.close();
  try {
    for (const t of loopErrors.clear(now())) event(t, 'warn');
    const handed = handoverSessions([...sessions], ME);
    saveRun({ restart: { at: now().toISOString(), from, to, started, finished, shipped, workers, counters, skipped: [...skipped], haltSeen, pid: ME, sessions: handed, work: [...work], crashes: Object.fromEntries(crashes) }, restartPending: null, stuck: null, slow: [] });
    // Vouched for by startSupervisor's loop, which outlives this process (see the header). The
    // pids adopted earlier stay listed: a held story's claim may still name one.
    writeAdopted(DIR, { by: process.ppid > 1 ? process.ppid : ME, pids: [...new Set([...adoptedPids(ME, [...sessions.values()]), ...OWN])] });
    event(text);
    jira?.stop();
    await publish(true).catch(() => {});
    await owner.settled();
    dashboard?.close();
  } catch (err) {
    console.error(`Supervisor error while restarting: ${err?.message ?? err}`);
  } finally {
    endChildren(loopChildren);
    // A signal during the restart ends the run as any Ctrl-C does (see the header): no next
    // process adopts the sessions, so the handover is taken back and stop() ends them. A session
    // that ended while handed over was ignored by onExit: it is handled now, so stop() does not
    // wait on it. stop() exits the process itself.
    if (interrupted) {
      try {
        saveRun({ restart: null });
        dropAdopted(DIR);
      } catch {
        // stopping anyway
      }
      handedOver = false;
      exiting = null;
      for (const [slot, s] of [...sessions]) if (!sessionAlive(s)) onExit(slot, s);
      await stop(INTERRUPT_EXIT, interruptNow());
      return;
    }
    process.exit(RESTART_EXIT);
  }
}

// Whether the code on disk accepts the config: `foreman config check` run by the new code.
function newCodeAccepts() {
  const r = sh(NODE.node(), [FOREMAN_BIN, 'config', 'check'], { cwd: ROOT });
  return r.status === 0 ? { ok: true } : { ok: false, reason: r.stdout.split('\n')[0] || `exit ${r.status}` };
}

// The local date, YYYY-MM-DD.
const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// The failures as the page reads them, kept in state.json.
function saveAnswerFailures() {
  saveRun({ answerFailures: [...answerFailures.values()] });
}

// Starts applying the owner's answers the supervisor applies (answers.mjs): every kind when no
// session runs, or only `kinds` (EVERY_TICK while sessions run; answers.mjs says why those are
// safe). The steps run in children (`foreman`, gh, git; none holds the loop), one apply at a time:
// while answersRun is set no new apply starts and the tick starts no story anywhere, so an answer
// is never applied twice and no pick runs beside one. A story answer (close or answer) is applied
// only to a story that waitsForAnswer allows, read fresh for each item with what holds a story
// now: a live claim (an owner claim never goes stale), a session, queued work, or a slot held or
// parked on it (its claim may read stale after a restart). So a second answer for a story the
// first just put back to todo is left to that story's session. A problem here is an event, never
// the end of the run; an answer that failed is kept in answerFailures (state.json's
// answerFailures, which the page shows on Waiting on you as "could not apply: <step>" with a
// Retry) and tried again after a growing wait (answers.mjs ANSWER_RETRY_MS: 1, 2, 5, 15, then 30
// minutes), or at once when the owner presses Retry (control.json's answerRetry, the
// answer-retry command). Only this function applies answers, one apply at a time, so a retry
// never applies one twice.
async function startAnswers(kinds = null) {
  if (answersRun) return;
  try {
    const items = await openConsole({ config: CONFIG, ctx: { stateDir: DIR, now } }).decisions.pending();
    // An answer given anywhere (the page of the artifacts console, say) is written on its story too;
    // the ledger drops the ones already posted.
    for (const item of items) if (item.answer) queueStoryNote(DIR, { ...answerNote(item), at: now(), slot: null });
    const canRequeue = (id) => {
      try {
        const source = stories();
        const held = heldForAnswer({ claims: claims(DIR), sessions: inHandSessions(), work, slots: SLOT_IDS.map((s) => readSlot(DIR, s)) });
        return waitsForAnswer(source.list().find((s) => s.id === id), { held, idPattern: source.idPattern });
      } catch {
        return false;
      }
    };
    // A failure whose answer is no longer pending (applied by hand, or gone) is forgotten.
    const pending = new Set(items.map((i) => i.id));
    let changed = false;
    for (const id of [...answerFailures.keys()]) if (!pending.has(id)) changed = answerFailures.delete(id) || changed;
    if (changed) saveAnswerFailures();
    const skip = answerSkips(answerFailures, Date.now());
    const todo = answersToApply(items, { skip, kinds, canRequeue });
    if (todo.length === 0) return;
    // runAsync's { status, stdout } with the output trimmed, as the steps read it; a time-out is status null.
    const owned = (run) => run.then((r) => ({ status: r.status, stdout: r.stdout.trim() }));
    answersRun = applyAnswers(
      todo.map((t) => t.item),
      {
        foreman: (args) => owned(runAsync(NODE.node(), [FOREMAN_BIN, ...args], { cwd: ROOT, env: ownerEnv(process.env), timeoutMs: 120_000, track: loopChildren })),
        gh: (args) => owned(runAsync('gh', args, { cwd: ROOT, timeoutMs: 30_000, track: loopChildren })),
        git: (args) => owned(runAsync('git', args, { cwd: ROOT, timeoutMs: 60_000, track: loopChildren })),
        branchPrefix: CONFIG.branchPrefix,
        remote: CONFIG.remote,
        today: localDate(now()),
        skip,
        kinds,
        canRequeue,
        onItem: (item) => event(`Applying your answer to "${item.title}".`, 'info'),
      },
    )
      .then((results) => {
        const at = Date.now();
        for (const r of results) {
          if (r.ok) {
            event(r.text, 'info');
            answerFailures.delete(r.id);
          } else {
            answerFailures.set(r.id, failedAnswer(answerFailures.get(r.id), r, at));
            event(`${r.text} Foreman tries it again at ${retryWhen(answerFailures.get(r.id).retryAt, at)}.`, 'warn');
          }
        }
        if (results.length) saveAnswerFailures();
      })
      .catch((err) => event(`Could not apply the owner's answers: ${String(err?.message ?? err).slice(0, 200)}`, 'warn'))
      .finally(() => {
        answersRun = null;
      });
  } catch (err) {
    event(`Could not apply the owner's answers: ${String(err?.message ?? err).slice(0, 200)}`, 'warn');
  }
}

// Whether the work this slot would take is a start-up resume that gives way to a story the picker
// would start now (slot-work.mjs pickFirst). Never throws: when the stories cannot be read the
// resume goes ahead.
const resumeYields = (slot) => {
  try {
    const w = peekWork(work, slot);
    if (w?.ranked !== true) return false;
    const source = stories();
    const list = source.list();
    const free = schemaFree();
    const extra = schemaExtra();
    const rival = nextStory(list, {
      idPattern: source.idPattern,
      skip: [...claims(DIR).map((c) => c.id), ...skipped, ...work.map((x) => x.id)],
      exclude: keptOut({ extra, free, waiters: fileWaiters() }),
    });
    return pickFirst(w, rival, list);
  } catch {
    return false;
  }
};

async function tick() {
  const before = launches;
  commands();
  applySettings();
  if (!DRY) flushNotes();
  for (const m of rehome(work, workers)) event(`${m.id} was queued for ${m.from}, which is over the worker count (${workers}); a slot under it takes it.`, 'info', m.from);
  if (existsSync(STOP)) {
    const by = takeStop(DIR) ?? {};
    stopping = true;
    event(`Stop requested by ${stopperDetail(by)}: finishing the stories in progress.`, 'warn');
    if (unexpectedStop(by)) notify('unexpected-stop', { reason: `Stop requested by ${stopperDetail(by)}, not from your terminal or the dashboard.` });
  }
  // New plugin code: no new story starts until the run restarts on it (STOP wins).
  if (CODE_AT_START && !stopping) {
    if (OWN_CHECKOUT) pullAnchor();
    const change = codeChange(CODE_AT_START, CODE.version({ label: false }), refusedCode);
    // The label costs a second git call: only for code not seen yet.
    const to = change && change.id !== restartPending?.id ? (CODE.version().label ?? change.id) : null;
    setRestartPending(nextPending(restartPending, change, { to, at: now().toISOString() }));
  } else if (stopping) setRestartPending(null);
  const halted = existsSync(HALT);
  if (halted && !haltSeen) {
    haltSeen = true;
    setLoop(DIR, 'halted', readFileSync(HALT, 'utf8').slice(0, 300));
    notify('halted', { reason: 'A release failed; releases are frozen until you press "I\'ve fixed it".' });
  }
  // Paused for the sign-in: probe it now and then, and at once after a restart.
  if (state().autoPausedAt && state().autoPauseReason === SIGNIN_PAUSE && probeDue({ running: signInCheck.running, lastAt: signInCheck.lastAt, now: Date.now(), everyMs: PROBE_EVERY_TICKS * TICK_MS })) checkSignIn();
  const paused = control().paused === true || autoPaused();
  // A credit pause whose time has come: probe, and let the pause go once Claude answers.
  if (creditProbeDue({ pausedAt: state().autoPausedAt, resumeAt: state().autoResumeAt, running: creditCheck.running || signInCheck.running, now: Date.now() })) checkCredit();
  // Jira not answering holds new picks only; a quiet hold (no answer yet) is not shown.
  const jiraHold = !halted && !paused ? (jira?.hold() ?? null) : null;
  const shownHold = jiraHold && !jiraHold.quiet ? jiraHold.reason : '';
  if (!halted) {
    const loopState = paused || shownHold ? 'paused' : standbyOn() ? 'standby' : 'running';
    setLoop(DIR, loopState, paused ? state().autoPauseReason || 'paused from the command centre' : shownHold ? shownHold : standbyOn() ? STANDBY : '');
  }
  // A sign-in check, or the subscription check, holds every start until it answers.
  const pickHeld = paused || !!jiraHold || signInCheck.running || subscriptionCheck.running;
  releaseApiHeld({ halted, paused, stopping });
  pollAdopted();
  watch();
  if (parkWatchDue({ running: !!parkWatch.child, lastAt: parkWatch.lastAt, count: readParks(DIR).length, now: Date.now(), everyMs: PARK_CHECK_MS })) startParkWatch();
  void checkOwnerTasks();
  if (!DRY && typeof envAdapter.sweep === 'function' && envSweepDue({ running: envSweep.running, lastAt: envSweep.lastAt, now: Date.now(), everyMs: ENV_SWEEP_MS })) startEnvSweep();
  // New code: restart now, before any pick, unless a slot is being set up, a session is being
  // stopped or the park watch checks; the sessions running and the queued work are handed over
  // (see the header).
  const nc = NODE.check();
  if (nc.event) event(nc.event.text, nc.event.kind);
  let restartNow = restartFor({ code: restartPending, node: NODE.broken(), stopping, accepts: newCodeAccepts });
  if (restartNow) {
    const restart = restartStep({ pending: restartNow.pending, busy: preparing.size > 0 || [...sessions.values()].some((s) => s.stop || resultArrived(s)) || closing.size > 0 || !!answersRun || !!fixCheck || !!parkWatch.child || signInCheck.running || subscriptionCheck.running || creditCheck.running, check: restartNow.check });
    if (restart.action === 'refuse') {
      event(restart.event.text, restart.event.kind);
      refusedCode = restartPending.id;
      setRestartPending(null);
      restartNow = null;
    } else if (restart.action === 'restart') {
      return restartOnNewCode(restartNow.pending, restartNow.text);
    }
  }

  const answersIdle = mayApplyAnswers({ running: sessions.size + closing.size, preparing: preparing.size, queued: takeable(work, workers), halted, held: pickHeld, stopping });
  await startAnswers(answersIdle ? null : EVERY_TICK);
  sweepClaims();
  sweepOwnerClaims();

  let couldPick = false;
  let found = null; // the first story a free slot found
  if (nextStarting && !preparing.has(nextStarting.slot)) nextStarting = null;
  // Before the slot loop: a story that runs already settles its request even when no slot is free.
  settleRunningRequest();
  for (const slot of SLOT_IDS) {
    // A slot whose session is being read, or any slot while owner answers apply, starts nothing.
    if (sessions.has(slot) || closing.has(slot) || preparing.has(slot) || answersRun) continue;
    // The story the owner asked for next is still being prepared in another slot: no other pick yet.
    const nextFirst = nextStarting !== null && nextStarting.slot !== slot;
    const st = readSlot(DIR, slot).state;
    // Counted per slot, so a story an earlier slot started this tick counts.
    const base = { halted, stopping, paused: paused || signInCheck.running || subscriptionCheck.running, backoffUntil: counters.backoffUntil, envUntil: counters.envUntil, now: Date.now(), slotIndex: slotIndex(slot), workers, slotState: st, running: runningCount() };
    // Queued work resumes a story already in hand, not a new one: the running count limits new picks only.
    if (hasWork(work, slot) && canResume(base)) {
      // A start-up resume gives way to a story the picker ranks above it, if this slot may pick.
      const pickOk = !nextFirst && canPick({ ...base, stopping: stopping || !!restartNow, paused: pickHeld, max: MAX, started });
      if (pickOk && resumeYields(slot)) {
        couldPick = true;
        const id = pick(slot);
        if (id !== PICK_WAITS) found ??= id;
      } else {
        // An automatic resume may need no session (resume-close.mjs): the merged pull request is
        // asked for in a child, and the work waits for the next tick that has the answer.
        const w = peekWork(work, slot);
        if (w?.resume && !mergedFor.has(w) && !SETTLED.includes(statusOf(w.id))) {
          void lookUpMerged(w.id).then((pr) => mergedFor.set(w, { pr }));
          continue;
        }
        startWork(slot, takeWork(work, slot));
      }
    } else if (!nextFirst && canPick({ ...base, stopping: stopping || !!restartNow, paused: pickHeld, max: MAX, started })) {
      couldPick = true;
      const id = pick(slot);
      if (id !== PICK_WAITS) found ??= id;
    }
  }
  saveQueued();

  // The park watch is a short check every few minutes: it delays a stop, but never counts for
  // standby, which would then flap.
  const running = sessions.size > 0 || closing.size > 0 || preparing.size > 0;
  if (running || takeable(work, workers) > 0) leaveStandby();
  const idle = whenNothingLeft({ nothingLeft, halted, held: pickHeld, running, queued: takeable(work, workers), once: ONCE, max: MAX, exitWhenIdle: EXIT_WHEN_IDLE });
  const busy = running || !!answersRun || !!fixCheck || !!parkWatch.child || signInCheck.running || subscriptionCheck.running || creditCheck.running;
  if (!busy && takeable(work, workers) === 0) {
    if (stopping) return stop(0, 'Stopped on request.');
    if (MAX > 0 && started >= MAX) return stop(0, `Reached the ${MAX} ${MAX === 1 ? 'story' : 'stories'} asked for.`);
    if (idle === 'exit') return stop(0, NOTHING_LEFT);
    if (ONCE && halted) return stop(0, 'Halted: nothing can start until `foreman fixed`.', { loop: 'halted' });
    if (ONCE && pickHeld) return stop(0, `Nothing can start now: ${paused ? 'paused' : jiraHold.reason || 'waiting for Jira'}.`, { loop: 'paused' });
    if (ONCE && !couldPick) return stop(0, 'Nothing can start now: no slot is free (parked, held or down), or the run is backing off.');
  }
  // Starved: a free slot found a story and nothing started this tick (the progress watchdog). A
  // story that only waits on running stories is not starved.
  starvedId = couldPick && found && launches === before ? found : null;
  if (idle === 'standby') enterStandby();
  return null;
}

async function main() {
  if (DRY) {
    dryRun({ loaded, START, workers, MAX, SLOT_IDS, DIR, CONFIG, slotIndex, stories, pickStory, recoveryPlan, endedFolderStory, schemaExtra, schemaFree, keptOut, fileWaiters });
    process.exit(0);
  }
  mkdirSync(join(DIR, 'logs'), { recursive: true });
  writePid(DIR, ME);
  process.on('exit', () => {
    clearPid(DIR, ME);
    // Only a file this process vouches for: the one written at a restart is its parent's.
    clearAdopted(DIR, ME);
  });
  // Does this process's own Node start? Its children use one that does (see the header).
  const nodeAtStart = NODE.check({ force: true });
  if (nodeAtStart.event) event(nodeAtStart.event.text, nodeAtStart.event.kind);
  // No handover is in flight on a fresh start, so a voucher left behind (a hard kill, a crash
  // before the adoption) must not keep any claim or lock alive.
  if (!RESTARTED) dropAdopted(DIR);
  // A fresh start forgets who stopped the last run; a restart on new code keeps it.
  if (!RESTARTED) clearLastStop(DIR);
  // From here a stop ends every session in hand, the adopted ones included (see the header).
  // A signal while it exits for a restart is kept, and ends the run once the handover is done.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
    process.on(signal, () => {
      const a = afterSignal(exiting);
      if (a === 'stop' || a === 'interrupt') interruptSource = sourceNow();
      if (a === 'stop') stop(INTERRUPT_EXIT, interruptNow());
      else if (a === 'interrupt') interrupted = true;
    });
  // The handed-over sessions are adopted first, while state.json still lists them in `restart`.
  // Then every slot folder is scanned for sessions that no handover named (a hard kill, a crash),
  // skipping the handed-over ones being ended. One "Kept N" event covers both, then the double
  // warnings; the handed-over sessions that could not be kept are ended last.
  const found = { kept: [], doubles: [] };
  const dropped = RESTARTED ? adoptCarried(found.kept) : [];
  adoptLive(found, dropped.map((d) => d.pid));
  if (found.kept.length) event(keptText(found.kept, SLOT_IDS));
  for (const d of found.doubles) event(doubleText(d), 'warn', d.slot);
  if (dropped.length) await endDropped(dropped);
  adoptLegacySchemaLock(DIR);
  sweepLeftSessionFiles();
  sweepLeftCheckJobs();
  setWorkers(DIR, workers);
  // A restart carries on the run's totals.
  if (!RESTARTED) startTotals(DIR, now());
  saveRun({ handled: handled(), anchorWait: null, learningFailed: null, configProblem: null, stuck: null, slow: [], restartPending: null, backoffUntil: backoffShown(counters, Date.now()), answerFailures: [], skipped: [...skipped], ...(RESTARTED ? { restart: null } : { apiWait: null, envWait: null }) });
  savedTeam = live.team ?? loaded.team;
  saveLastGood(DIR, savedTeam);
  // caffeinate's -w pid still ends it with this process; standby lets go of it meanwhile.
  awake = keepAwake(keepAwakeCommand(CONFIG, process.platform, ME), { spawn, onError: () => event('Could not keep the computer awake.', 'warn') });
  awake.take();
  // A run restarted while halted is still halted (its halt was seen, so the tick will not say so again).
  if (haltSeen && existsSync(HALT)) setLoop(DIR, 'halted', readFileSync(HALT, 'utf8').slice(0, 300));
  else setLoop(DIR, 'running', '');
  for (const w of loaded.localWarnings) event(w, 'warn');
  for (const e of START.events) event(e.text, e.kind);
  if (!RESTARTED) event(`Foreman started with ${workers} ${workers === 1 ? 'slot' : 'slots'}${MAX ? `, for ${MAX} ${MAX === 1 ? 'story' : 'stories'}` : ''}.`);
  if (!RESTARTED && SESSION_PLUGIN.copy) event(copyWarning({ copy: SESSION_PLUGIN.copy, own: { ...ownCopy({ pluginDir: PLUGIN_DIR }), label: CODE_AT_START?.label } }), 'warn');
  if (control().paused === true || autoPaused()) {
    const reason = control().paused === true ? 'paused with `foreman pause`' : state().autoPauseReason || 'Foreman paused itself';
    const line = `Starting paused: ${reason}; run \`foreman resume\` to continue.`;
    console.log(line);
    event(line, 'warn');
  }
  // The start count wins at start: a count already in control.json is history.
  markHandled('workers', control().workersAt ?? null);
  if (ARTIFACTS) {
    if (sh(NODE.node(), [SYNC, '--once'], { cwd: ROOT }).status !== 0) {
      console.log("Note: the command centre cannot be updated from here (writes need a Claude session's approval).");
      console.log('      Foreman will still build. To watch it live, start it from Claude in VS Code instead.');
    }
    spawn(NODE.node(), [SYNC, '--loop', '--parent', String(ME)], { cwd: ROOT, stdio: 'ignore' }).unref();
  } else {
    try {
      consoleAdapter = openConsole({ config: CONFIG, ctx: { stateDir: DIR, now } });
    } catch (err) {
      event(`The console could not be opened (${err.message}); \`foreman status\` still works.`, 'warn');
    }
    // The dashboard runs in this process. A failure to start (a port in use, a host with no
    // token) is an event; the run carries on and `foreman status` still works.
    if ((CONFIG.console?.adapter ?? 'dashboard') === 'dashboard' && !ONCE) {
      startDashboard({ root: ROOT, config: CONFIG, stateDir: DIR, env: process.env, now, host: process.env.FOREMAN_DASHBOARD_HOST || undefined })
        .then(({ server, url }) => {
          dashboard = server;
          console.log(`Dashboard: ${url}`);
          event(`Dashboard at ${url}`);
        })
        .catch((err) => {
          const why = err.code === 'EADDRINUSE' ? `port ${CONFIG.console?.port ?? 4317} is in use` : err.message;
          event(`The dashboard did not start (${why}); the run carries on, and \`foreman status\` still works.`, 'warn');
        });
    }
  }
  if (jira) {
    // The first answer before start-up recovery reads the stories; never more than 30 s.
    await Promise.race([jira.refresh(), sleep(30_000)]);
    jira.start();
  }
  reconcileStart();
  while (!exiting) {
    let loopError = null;
    try {
      await tick();
      rotateEvents(DIR);
      await publish();
      for (const t of loopErrors.clear(now())) event(t, 'warn');
    } catch (err) {
      for (const t of loopErrors.seen(`Supervisor error: ${String(err.message).slice(0, 200)}`, now())) event(t, 'warn');
      loopError = redact(String(err.message).slice(0, 200));
    }
    if (!exiting) checkProgress(loopError);
    if (!exiting) {
      // A test's or a scratch copy's run ends on its own (see the header).
      const verdict = leashVerdict({ leash: LEASH, alive, standbySince: standbySince(), now: Date.now() });
      if (verdict) await stop(0, verdict.reason);
    }
    if (!exiting) checkStrays();
    // wait: sleep leaves a ref'd 30 s timer after a wake poll. That is harmless because stop()
    // ends in process.exit, and a ref'd timer keeps the process alive while a poll is out.
    // A late wake (the computer slept) is not a stall: the progress clocks start again.
    await loopRest({ intervalMs: TICK_MS, sleep, jira, event, wait: sleep, progress });
  }
}

await main();
