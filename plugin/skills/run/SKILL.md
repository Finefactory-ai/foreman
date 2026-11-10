---
name: run
description: Start, watch, steer or stop a Foreman run from this Claude session — 'start foreman', 'run 3 stories two at a time', 'is it running?', 'pause', 'take over S-4', 'I've fixed it', 'stop'.
---

# Running Foreman from a Claude session

A run is `foreman run`, which starts the supervisor: it builds up to `slots` stories at
once (the number in `foreman.config.json`), each in a fresh unattended Claude session inside
its own **slot** (w1, w2 …: a worktree under the state folder with its own environment), and
releases them one at a time. Everything you do here goes through the `foreman` command; it is
on your PATH. Not for building a single story by hand: that is `/foreman:story <ID>`.

## Start

1. Pre-flight, and stop to tell the owner if any check fails:
   - One run at a time: `foreman run` refuses when one is already running, and says its pid.
   - `foreman status`: if it says paused, the run will start paused; tell the owner it waits
     for `foreman resume`.
   - Read `foreman config show` for `stateDir`, `baseBranch` and `slots`. If
     `<stateDir>/HALT` exists, a release failed earlier: tell the owner the run will start
     held, and why (the file says).
   - `git status --porcelain` must be empty. Then check out the base branch and
     `git pull --ff-only`.
   - `foreman decide list`: name any open items to the owner. Applying their answers is the
     story sessions' job, not yours.
2. Start it with the Bash tool, as a plain command: `foreman run <N> --workers <W>`. N is the
   number of stories the owner asked for (no number: it runs until stopped, and when nothing
   is buildable it waits on standby and starts new stories as they come). W is how many at
   once, 1 to `slots`; when the owner does not say, use 1. It returns at once, printing the
   supervisor's pid, the dashboard and the log (`<stateDir>/logs/supervisor.out`); the run
   lives on in its own session after this one closes.
   The story sessions load this plugin from the folder the supervisor itself runs: it passes
   `--plugin-dir <its own plugin folder>` to each session when the installed copy is elsewhere,
   missing, or the project is Foreman's own repo. Nothing to set. `foreman doctor` and the run
   log say when the installed copy differs.
   - With the background service installed (`foreman service status` says so), `foreman run`
     takes no story or worker count: it starts the service, which runs until stopped, on
     standby when nothing is buildable. For a count, tell the owner to run
     `foreman run --foreground N` in their own terminal; `foreman workers W` changes the
     workers while it runs.
   - When the owner wants the factory always on, after a crash and each time they log in,
     suggest they run `foreman service install` themselves.
3. After about 30 seconds read the end of `<stateDir>/logs/supervisor.out` and
   `foreman status`. If it printed an error or stopped, tell the owner what it said.
4. Reply in a few lines: started, for how many stories and how many at once, the first story
   (`foreman story next`), and that `foreman status` and the emails report progress.

With the `artifacts` console only, this session must stay open (the editor running, the
computer awake) for as long as the run lasts: say so when you start it. With any other
console the run carries on without this session.

A run with no N lasts until `foreman stop`: on standby it waits for new stories and never
ends by itself. With the `artifacts` console that means keeping this session open until then;
for a run that ends, start it with N, or with `--exit-when-idle` so it stops once nothing is
left to build.

The run outlives this session, so nothing tells you when it ends. When the owner asks, read
`foreman status` and tell them in a few lines what shipped, what was blocked and why, and
anything waiting on them. Do not start another run unless asked.

## Watch

"Is it running?", "how is it going?": run `foreman status` and answer in a few lines, one per
busy slot. A parked or down slot's reason says what it needs. `foreman status --json` has
everything, including the recent events.

## Stop

- **After the stories in progress:** `foreman stop`. Every slot finishes its story, then the
  run stops and emails. `foreman pause` does the same but waits instead of stopping.
- **Now:** only if the owner says so explicitly. Run `foreman stop --now`. It signals the
  supervisor only when `<stateDir>/supervisor.pid` names a live Foreman supervisor; never kill
  a pid yourself. The marker it leaves keeps the service, if installed, from starting it
  again. The stories in progress were cut off mid-way; their claims stay, so the next start
  resumes them by priority, in any free slot. Say so.

Never clear a halt (remove `HALT` or run `foreman fixed`) without the owner's say-so, and
never weaken a stage, a test or CI to get a story through.

## Steer

The owner may give these in words here. Run the command, then say the run acts on it within
a few seconds (at its next tick).

- "pause" / "resume": `foreman pause`, `foreman resume`. Resume also clears a pause the run
  made by itself.
- "two at a time": `foreman workers 2` (1 to `slots`; applied at the next pick).
- "resume w2", "skip w1", "take over w3", "park w2", "unpark w2", "restart w1":
  `foreman slot <wN> <action>`, with action `resume`, `skip`, `takeover`, `park`, `unpark`,
  `restart`, `resume-as-is` or `discard`. Given a story id instead of a slot, find its slot
  in `foreman status`. `discard` throws work away: confirm with the owner first, naming the
  slot and the story.
  A skip lasts for the rest of the run, standby included; `foreman status` lists skipped
  stories, and `foreman next <id>` builds one again.
- "hand back S-4": `foreman handback S-4`.
- "build S-7 next": `foreman next S-7`; the run starts it if it can be built now.
- "I've fixed it": `foreman fixed`, only on the owner's word. The run clears the halt and
  releases the held stories, oldest first.
- An answer to an open item: `foreman decide answer <id> "<option>"`, with the option the
  owner chose and `--note "<their words>"` when they added any.
