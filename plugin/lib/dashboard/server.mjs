// The local dashboard: a node:http server over the files console. Started by
// `foreman dashboard`, by `foreman setup`, and by the supervisor when config.console.adapter is
// `dashboard`.
//
// Set-up mode. Started with config: null (a project with no working foreman.config.json), it
// answers only GET /, GET /api/help, GET /api/setup and the routes under /api/setup/; every
// other path, known or not, is a 409 that says to finish set-up first. On each request, after
// the safety checks below, it loads the config again; once a valid one is on disk (written by
// POST /api/setup/project/write or by hand) it serves everything, with no restart. A file
// that is there but does not load keeps it in set-up mode: GET /api/setup lists what is wrong
// with it (configErrors), and the write route may replace it. The host, and so whether a
// token is needed, is fixed when it starts.
// Full mode. On each request it stats foreman.config.json and the local settings
// (<stateDir>/settings.json), as the supervisor does (lib/engine/live-settings.mjs), and loads
// the config again when either changed, so the set-up steps follow an edit made by hand or from
// another screen. A file that is invalid now keeps the config from before. The state folder,
// the host, the token and the port stay as they started.
//
//   GET  /                     page.html, the only file it ever serves
//   GET  /api/status           the snapshot: status.json while the run keeps it fresh, else
//                              worked out here (as `foreman status` does), each agent's raw,
//                              says and doing redacted with every known secret value, as the
//                              conversations are; the pause always
//                              read from control.json, so a Pause shows at once, plus
//                              `project` { name, slots, rounds }, `requested` (control.json as
//                              written), control.stopRequested (the STOP file is there) and
//                              stoppedBy (who stopped the run or asked it to, with its text),
//                              both read fresh
//   GET  /api/events           server-sent events: `event: status` with the snapshot on
//                              connect and whenever status.json or control.json changes,
//                              and a comment every 15 s to keep the connection open
//   POST /api/control          { action, ... }, through lib/console/commands.mjs, the checks
//                              and the writer the CLI uses; a stop records the dashboard and
//                              the request's user agent as who asked (console/stopper.mjs)
//   GET  /api/decisions        every item waiting on the owner (and answered ones)
//   POST /api/decisions/<id>   { option, note }: the owner's answer
//   GET  /api/waiting          every item waiting on the owner, in order (lib/console/waiting.mjs):
//                              decisions, owner tasks, the halt, releases ready to promote and
//                              slots needing attention, each with its actions, its group
//                              (now or later), blocks (what waits on it) and frees (what it
//                              makes buildable now); a later owner task also has waitsOn, its
//                              open blockers
//   GET  /api/waiting/<id>/details  for an owner task: { need, steps, effort, doneWhen } read
//                              from its brief (lib/console/task-details.mjs), plus missing: true
//                              when it has no Steps and no What you need. A brief file under 10
//                              minutes old is used as it is; else the Jira source's brief is
//                              fetched with await (never the story source's synchronous brief(),
//                              which would hold the server), and { pending: true } answers when
//                              that takes over briefWaitMs and there is no file yet. Only the
//                              brief's first 256 KB is read. The list above never reads briefs.
//   POST /api/waiting/<id>     { action, note? }: one of that item's actions (<id> may be
//                              percent-encoded), through the path the CLI takes:
//                              decisions.answer, the story source's update with the
//                              `foreman story done` change, ownerCommand (fixed, slot, resume), or
//                              `foreman release watch`. The run:strays FYI's end ends the stray
//                              processes (supervisors, hook runs, learn or notify runs) found at
//                              that moment (engine/strays.mjs findStrays and
//                              endStrays, as `foreman doctor --end-strays`): "Ended N stray
//                              processes." plus " Still running: pid …" for any left; it is
//                              the run item's only action besides the self-pause's Resume and
//                              a failed answer's Retry (run:answer:<decision id>, which writes
//                              control.json's answerRetry through ownerCommand's retry-answer, so
//                              the supervisor applies the answer again at its next check).
//                              Any other action on run:strays (resume, say) is refused by the
//                              route's action check before actOn runs: 400 "Unknown action for
//                              run:strays; one of end", and nothing is ended.
//                              A learned FYI's undo and keep act at once
//                              through the learning store (lib/console/learned.mjs undoLearned,
//                              keepLearned), which closes its notes answered and applied in one
//                              write; its ok (Got it) answers and applies the note in one write.
//                              A note whose item the ledger no longer has is cleared the same way,
//                              with no ledger line. A refusal from the store is a 409: its own
//                              words for the lock busy or a snapshot changed, else a fixed line
//                              that names no path
//   POST /api/waiting/bundle/<name>  { action: create-all | ignore-all }: answers every
//                              unanswered decision in that bundle (follow-ups or traits), through
//                              lib/console/bundles.mjs, which answers each with decisions.answer;
//                              answers { ok, answered: [ids], failed: [{ id, error }], message },
//                              200 even when some failed. An unknown bundle or action is a 400
//                              that does not repeat it.
//   GET  /api/learned          { items }: what Foreman learned by itself, one row per item,
//                              newest first (lib/console/learned.mjs learnedRows): id, kind,
//                              roles, version, status and reason, never the text or a path
//   POST /api/learned/<id>     { action: 'undo' }: the owner's Undo from the Learned list
//                              (undoLearned), which also closes the item's open learned notes.
//                              Answers { ok, id, message }. The id is checked first: one that is
//                              not L-<n> or not in the ledger is a 404 that does not repeat it,
//                              whatever the action (the id is only looked up, never joined onto a
//                              path); then any action but undo is a 400, and a store refusal a 409.
//                              Owner changes on the branch state store. POST /api/control, a local
//                              POST /api/settings, /api/decisions/<id>, /api/waiting/<id> (not a
//                              release check, which `foreman release watch` syncs, nor ending the
//                              strays), /api/waiting/bundle/<name>, /api/learned/<id> and
//                              /api/setup/claude/use-key each pull the state branch first and
//                              push after, as one commit with a fixed message, as the CLI's write
//                              commands do (changeState, through state-store/with-state.mjs), one
//                              change at a time. A state branch that cannot be fetched is a 503
//                              and nothing changes; a push that fails keeps the change here and
//                              adds `warning` to the answer. git's words go to stderr only. The
//                              syncs run git synchronously, as configDirty does. With the files
//                              store or FOREMAN_STATE_SYNC=off nothing syncs.
//   GET  /api/settings         { groups, settings, configDirty, warnings }: the registry's
//                              settings that apply here, each with its value, source (default,
//                              team or local), limits and when it applies; configDirty is true
//                              while `git status` shows foreman.config.json changed
//   POST /api/settings         { name, value, layer } or { name, reset: true, layer }, layer
//                              local or team: through lib/settings/change.mjs, the code
//                              `foreman settings` uses; answers { ok, setting, lines, configDirty }
//   GET  /api/setup            { checkedAt, canChangeKeys, hasConfig, configErrors, areas,
//                              keyCard, off, steps }: whether foreman.config.json is there;
//                              configErrors, in set-up mode with a file that does not load, what
//                              is wrong with it in plain words, else null; the checklist's areas
//                              and the key card's words
//                              (lib/setup/keys.mjs KEY_CARD), from the model; off, the parts of an
//                              area that are off here, each with the line that says why and its
//                              Turn on (lib/setup/steps.mjs offAreas); and every set-up step
//                              (lib/setup/steps.mjs), skipped ones too, each with its status and
//                              results from the last checks on this machine (setup-checks.json),
//                              a crashed check's detail replaced by a plain line pointing to
//                              `foreman setup steps`, checkedAt and confirmedAt (setup.json), and
//                              keys: one row per key input { name, label, set, masked, source, file, testable,
//                              testLabel, generate, ignored }: generate is whether Foreman can make
//                              the key, ignored whether git ignores its file (true, false, or null
//                              when git cannot say). The project step carries projectNow { source,
//                              pack, sfdx }: the story adapter, pack salesforce or none, and whether
//                              sfdx-project.json is there, or null with no config, for its change
//                              form (lib/setup/project.mjs PROJECT_FORM.change). The claude-signin step also carries signin
//                              (lib/setup/claude.mjs SIGNIN) and inUse { uses, line, login,
//                              switchBack }: which sign-in the sessions will use, from its key
//                              rows, the cached 'claude sign-in' result and claude-signin.json
//                              (engine/claude-fallback.mjs); switchBack is true while the run is
//                              on the subscription because the platform credits ran out. The three Jira steps carry jira,
//                              their screen's words (lib/setup/jira-screen.mjs JIRA_SCREEN), and
//                              the one whose jira.part is filter (jira-site) also carries
//                              jiraConfig { site, jql, ownerLabel, transitions, transitionsSaved } as the project
//                              has them now, or null when they cannot be read. The notifications
//                              step carries notify, its screen's words (lib/setup/notify-screen.mjs
//                              NOTIFY_SCREEN), and notifyConfig { adapter, from, to, notifications }
//                              as the project has them now, or null. The sf-orgs step carries
//                              salesforce, its screen's words (lib/setup/salesforce-screen.mjs
//                              SF_SCREEN), and, when it applies, salesforceConfig { orgs: [{ alias,
//                              orgId, roles }], scratch, key } (lib/setup/salesforce.mjs current):
//                              the orgs in salesforce.orgs in the doctor's order, and the key card
//                              as GET /api/setup/salesforce/key without the key file, or null when
//                              the project cannot say. The sf-gearset step carries gearset, its
//                              screen's words (lib/setup/gearset-screen.mjs GEARSET_SCREEN), and,
//                              when it applies, gearsetConfig { pipelineId, stages: [{ name, org,
//                              orgId }], confirmed: { [stage]: iso } } (lib/setup/gearset.mjs
//                              current, plus the owner's test-level confirmations from setup.json),
//                              or null when the project cannot say. The cloud-runner step carries
//                              cloud, its screen's words (lib/setup/cloud-screen.mjs CLOUD_SCREEN),
//                              and cloudConfig { mode, stateBranch, workflow: { exists, current },
//                              runnerFile: { file, exists, ignored }, repo, names, dockerRun }
//                              (lib/setup/cloud.mjs current), or null when the project cannot say:
//                              names and booleans only, from git and the files, with no gh call.
//                              Each step also carries checking: true while its check runs or
//                              waits its turn (POST .../check below), so a page loaded since still
//                              shows it. It runs no check, no sf, no openssl, no gh and no Gearset
//                              call, and no value is ever in it.
//   POST /api/setup/keys       { name, value } or { name, remove: true }: saves or removes a key
//                              in its env file through lib/secrets/env-store.mjs, the code
//                              `foreman keys` uses, after its shape check (lib/setup/keys.mjs);
//                              adds the file to .gitignore first when git does not ignore it.
//                              Answers { ok, key: <its row>, lines }. A key set in the
//                              environment is a 409.
//   POST /api/setup/keys/test  { name }: asks the key's service whether it takes the stored
//                              value; answers { ok, name, result: { ok, detail } }, the detail
//                              without the value. A pass records the step's confirmedAt.
//   POST /api/setup/keys/generate  { name }: makes a new value for a key Foreman makes itself
//                              (FOREMAN_DASHBOARD_TOKEN) and saves it as POST /api/setup/keys
//                              does. Answers { ok, key: <its row>, lines }; the value goes only
//                              into the file, never into the answer. A key Foreman does not make
//                              is a 400, one set in the environment a 409.
//   POST /api/setup/keys/ignore  { name }: the fix for a key file git does not ignore: adds it to
//                              .gitignore (env-store ignoreKeyFile). Answers { ok, key, lines }.
//   POST /api/setup/steps/<id>/check  {}: runs that step's doctor checks only, caches their
//                              results and records checkedAt (confirmedAt too when the step is
//                              done); answers { ok, step } shaped as in GET /api/setup. The
//                              checks run in a child of their own (`foreman setup steps --step
//                              <id>`, which writes setup-checks.json itself), so a slow one (the
//                              project's `npm test`) never holds this process, which may be the
//                              supervisor's. One step's checks run at a time, across steps: a
//                              check for another step waits for the running one. The child gets
//                              STEP_CHECK_MS (15 minutes, setup/status.mjs); past that its whole
//                              group is killed, nothing is recorded, and the answer is a 504 that
//                              says to run `foreman doctor` in a terminal. A child that fails is a
//                              500 in fixed words; its redacted stderr goes to the log only.
//                              Closing the dashboard ends a check still running.
//                              Keys are saved and tested only on a dashboard on loopback (an SSH
//                              tunnel to it counts), else a 403 in plain words. Each step allows
//                              one try at a time, 5 a minute and 30 an hour, key tests counting
//                              against the key's step (lib/setup/record.mjs); more is a 429 with
//                              retry-after and { error, retryAfter }. Only names from the key
//                              registry and the project's steps are taken, and an unknown one is
//                              a 400 that does not repeat it. The step id is only looked up in the
//                              model, never joined onto a path or echoed. setup.json holds step
//                              ids and times only. No GET and no event ever carries a key's value.
//   POST /api/setup/project/detect  {}: what `foreman init` suggests for this project, from its
//                              files and the packs (lib/engine/init-helpers.mjs detect):
//                              { suggested, found }
//   POST /api/setup/project/write   { config, example? } or { answers, example? }: writes
//                              foreman.config.json and the files that go with it, through
//                              writeInit (the checks `foreman init write` makes), plus
//                              stories/S-1.md unless example is false. The answers are the Set up
//                              tab's form (lib/setup/project.mjs projectConfig), made into the
//                              config /foreman:init would write; sending both is a 400.
//                              Answers { ok, lines }; a config or answers that fail the checks are
//                              a 400 { error, errors: [plain words] }, as is a markdown stories
//                              folder outside the project while the example story is on. In
//                              set-up mode it replaces a foreman.config.json that does not load
//                              (a write that fails the checks leaves it as it is); a project
//                              whose foreman.config.json loads is a 409 that leaves it alone.
//                              { change: { source?, pack?, alias?, orgId? } }, alone, is for a
//                              project that has one: it switches the story source (markdown or
//                              jira, with the one signed-in site, if any, and a starter filter) and
//                              the Salesforce pack (on with one sandbox, needing sfdx-project.json;
//                              or off), through lib/setup/project.mjs projectChange and the team
//                              layer, checked as a whole config before one write. Answers { ok,
//                              lines, configDirty }; a change that fails the checks is a 400
//                              { error, errors } that writes nothing, and with no config it is a
//                              409. Config only: any host the dashboard serves, no limit.
//   POST /api/setup/project/check-run  { run }: runs that check command once in the project
//                              (lib/setup/project.mjs runCheckCommand) and answers { ok, result:
//                              { passed, exitCode, timedOut, seconds, tail, detail } }, 200 when
//                              the command fails too. Only on a dashboard on loopback, as the keys
//                              are, and limited as a check of the project step. It is stopped,
//                              with everything it started, after checkRunTimeoutMs (3 minutes),
//                              and answers at most about 2 s after that even if something keeps
//                              the output open, so the step's slot is always freed; its output
//                              tail is redacted before it is cut and is never stored, and a
//                              refused command is never echoed.
//   POST /api/setup/jira/login {}: starts a Jira sign-in (lib/setup/jira.mjs): a one-shot
//                              callback server on 127.0.0.1 (port 8765 by default), and answers
//                              { ok, status: 'waiting', url } with the consent address. Without
//                              stories.site, the only site the sign-in reaches is saved as
//                              stories.site; several are kept to pick from.
//   GET  /api/setup/jira/login { status }: idle, waiting, signed-in (with site and account),
//                              pick-site (with sites [{ site, name }]) or failed (with error)
//   POST /api/setup/jira/site  { site }: signs in to one of the sites to pick and saves it as
//                              stories.site; any other is a 400 that does not repeat it
//   GET  /api/setup/jira/projects   { projects: [{ key, name }], more }
//   POST /api/setup/jira/preview    { jql }: { issues: [{ key, title, status }], count }, 10
//                              issues and Jira's approximate count; a filter Jira cannot run is a
//                              400 in plain words. Limited as a step check, against jira-site.
//   GET  /api/setup/jira/statuses?project=<key>  { statuses: [{ name, category }], suggested }:
//                              suggested is { started, blocked, review, failed, shipped }, each
//                              a status name or null, picked by status category
//   POST /api/setup/jira/save  { jql, ownerLabel, transitions }, exactly those keys: writes the
//                              ones that changed to foreman.config.json through the team layer,
//                              as POST /api/settings does; an event left out of transitions moves
//                              nothing. Answers { ok, lines, stories, configDirty }; lines end
//                              with the commit reminder when anything was written. It writes
//                              config only, so it works on any host the dashboard serves, with
//                              no limit beyond the gates below.
//                              The sign-in POSTs (login and site) work only on a dashboard on
//                              loopback, as the keys do. Tokens stay in the token file, and in memory while a site
//                              waits to be picked: no response carries a token, a code or the
//                              client secret.
//   POST /api/setup/notify/save  { adapter }, exactly that key, none or email-resend: writes the
//                              notify block to foreman.config.json through the team layer
//                              (lib/setup/notify.mjs) as { adapter } alone. Answers { ok, lines,
//                              notify, configDirty }; lines end with the commit reminder when it
//                              wrote. Config only, so it works on any host the dashboard serves,
//                              with no limit beyond the gates below. Any other body is a 400 that
//                              does not repeat it.
//   POST /api/setup/notify/test  {}: sends a test email through the project's notifier
//                              (lib/engine/notifier.mjs openNotifier), with the stored Resend key
//                              and addresses (the environment wins over the file), so
//                              features.notifications off or adapter none writes to the outbox
//                              only. Always 200 { ok, result: { sent, outbox, to?, detail } } once
//                              it ran; a sent email records the step's confirmedAt. Only on a
//                              dashboard on loopback, as the keys are, and limited as a check of
//                              the notifications step. The detail never holds the key.
//   GET  /api/setup/salesforce/key  { status: 'none' } or { status: 'ready', certificate,
//                              fingerprint, expires, subject, keyFile } (lib/setup/salesforce.mjs):
//                              the public certificate only, never the key
//   POST /api/setup/salesforce/key  { generate: true } or { key, certificate }, with replace:
//                              true to put a new pair in place of a saved one: makes the key with
//                              openssl, or checks and saves the uploaded PEM pair, in
//                              ~/.config/foreman/sf/<project id>/ (folder 700, files 600, never in
//                              the repo or an env file). Answers as the GET; a saved key without
//                              replace is a 409.
//   POST /api/setup/salesforce/connect  { alias, username, clientId, instanceUrl? }: signs one
//                              org in salesforce.orgs in to Foreman's own sf home with
//                              `sf org login jwt`, then asks it whether it is a sandbox; one that
//                              is not is signed out at once. Always 200 { ok, status, alias, ... }
//                              once the inputs pass, with the guide entry that fixes a failure.
//                              Limited as a step check, against sf-orgs, once the inputs pass,
//                              so retries cannot lock the org's user out. sf runs synchronously, so a connect holds the
//                              server until sf answers (up to runSf's 2-minute limit).
//   POST /api/setup/salesforce/org-id  { alias }: saves the org ID the last connect of that alias
//                              found, when it differed, as salesforce.orgs.<alias>.orgId
//                              The three Salesforce POSTs work only on a dashboard on loopback, as
//                              the keys do. No response carries the private key, the username or
//                              the client ID.
//   POST /api/setup/gearset/read  {} or { pipelineId }: lists the Gearset pipelines with the stored
//                              GEARSET_API_TOKEN and, for the chosen one (the body's, the config's,
//                              or the only one), its environments beside salesforce.orgs and the
//                              stages (lib/setup/gearset.mjs read): { ok, pipelines, pipelineId,
//                              saved, rows, missing }, or { ok: false, error } in the screen's
//                              words. Limited as a step check, against sf-gearset.
//   POST /api/setup/gearset/save  { pipelineId }, exactly: writes salesforce.gearset.pipelineId to
//                              foreman.config.json through the team layer. Answers { ok, lines,
//                              gearset, configDirty }; config only, no Gearset call and no limit.
//   POST /api/setup/gearset/confirm  { stage, confirmed }: records or removes the owner's word that
//                              the stage's Gearset CI job has a test level, as sf-gearset's
//                              confirmedByYou in setup.json, never as checked. No limit.
//                              Like the Jira read and save routes, the three Gearset POSTs work on
//                              any host the dashboard serves, behind the gates below. None returns
//                              the token, a header or Gearset's own text.
//   POST /api/setup/claude/use-key  {}: back to the Console API key after the credits ran out,
//                              as `foreman claude use-key` does (engine/claude-fallback.mjs
//                              useKey): refused, with nothing changed, when neither the
//                              environment nor .env.foreman has ANTHROPIC_API_KEY. Answers
//                              { ok, lines }, 200 either way. It reads whether the key is there,
//                              never its value. Any host, no limit.
//   POST /api/setup/cloud/state  {}: writes state.store branch to foreman.config.json through the
//                              team layer (lib/setup/cloud.mjs stateBranch). Answers { ok, lines,
//                              configDirty }. Config only: any host, no limit.
//   POST /api/setup/cloud/workflow  { replace }: writes .github/workflows/foreman.yml, as
//                              `foreman cloud actions init` does; a 409 while the state is in files,
//                              or when the file is there and replace is false. Answers { ok, lines }.
//                              Any host, no limit.
//   POST /api/setup/cloud/secrets  {}: the repository's Actions secrets from `gh secret list`:
//                              { ok, repo, rows: [{ name, set, stored }], missing }, or { ok: false,
//                              error }. A 409 with no GitHub remote. Any host, limited as a check of
//                              cloud-runner.
//   POST /api/setup/cloud/secrets/set  {} or { ghToken }: checks the pasted token with the cloud
//                              doctor's local-safe checks (GH_TOKEN in their environment only), then
//                              sets FOREMAN_GH_TOKEN, the stored Claude sign-in and the stored
//                              project keys with `gh secret set`, each value on stdin. Answers
//                              { ok, set, failed, missing, results }, or { ok: false, error,
//                              results } when the checks refuse the token and nothing is set. All
//                              set with nothing missing records the step's confirmedAt. Limited as a
//                              check of cloud-runner.
//   POST /api/setup/cloud/runner-file  {} or { ghToken }: writes .env.runner (mode 600, its other
//                              lines kept) for a container runner. Answers { ok, file, written,
//                              missing, dockerRun, lines }; a 409 { error, fix: 'ignore' } that
//                              writes nothing while git does not ignore it.
//   POST /api/setup/cloud/runner-file/ignore  {}: adds .env.runner to .gitignore. { ok, lines }.
//   POST /api/setup/cloud/check  {}: the local-safe runner checks against .env.runner's values.
//                              Answers { ok, results: [{ name, ok, level, detail }] }; all passing
//                              records the step's confirmedAt. Limited as a check of cloud-runner.
//                              secrets/set, runner-file, its ignore and check move values, so they
//                              work only on a dashboard on loopback, as the keys do. No answer, gh
//                              argument or log carries a value: every detail is redacted.
//   GET  /api/tokens           the token view (engine/token-report.mjs tokenView), as `foreman
//                              report --tokens --json` prints it: from runs/, learner.jsonl and
//                              findings.jsonl in the state folder, `this run` from state.json's
//                              totals.since. Tokens only, never money.
//   GET  /api/history          the run history for the Insights tab (engine/history.mjs
//                              historyView): per UTC day, stories shipped and not and their
//                              cost; for the last 7 days, the headline numbers and the average
//                              minutes per stage. From runs/ in the state folder.
//   GET  /api/agents/<id>/transcript   a running (or just ended) agent's conversation, and
//   GET  /api/slots/<slot>/transcript  the story session's own: { id, slot, role, label,
//                              running, model, modelName, total, first, entries, skipped? }. The
//                              last 200 entries; ?after=<i> gives those after index i (what is
//                              new), ?before=<i> up to 200 before it (older); sending both is a
//                              400, and other keys (?token=) are ignored. Each entry is a task,
//                              text, tool (says in plain words, raw input), result or user line,
//                              long texts cut with `cut`; once the agent has ended its last
//                              words are marked report. The files are found only through the
//                              session marks the supervisor keeps (engine/session-files.mjs
//                              markedSession), so only a story running now has a conversation;
//                              nothing from the URL is joined onto a path (the id must be
//                              letters, digits, - or _, up to 64, and a slot w<n> within
//                              config.slots), and anything else is the same 404, which never
//                              repeats it. Redacted with every known secret value (the role
//                              and label too), then cut. Only on a dashboard on loopback, as the keys are (a 403
//                              otherwise, token or not); any method but GET is a 405.
//   GET  /api/help             what every action and setting does, in plain words (help.mjs):
//                              { decision, waiting, learned, control, slot, form, settings }, each entry
//                              { hint, more }
//
// Safety. On 127.0.0.1, ::1 or localhost it needs no token, but takes only requests addressed
// to this computer (a Host check against DNS rebinding). On any other host it needs
// FOREMAN_DASHBOARD_TOKEN, from the environment, .env.foreman or the env file, and will not start
// without it; every request then carries `Authorization: Bearer <token>` (a GET may carry
// ?token= instead, because EventSource cannot set headers). A request from another page's
// origin is refused, and a POST must be JSON, so a page elsewhere cannot send a plain form.
// Bodies are capped at 64 KB. Nothing from the URL is ever joined onto a path.

import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, statSync, watch } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { answerBundle, bundleMessage } from '../console/bundles.mjs';
import { ownerCommand } from '../console/commands.mjs';
import { readControl, stopFile } from '../console/control.mjs';
import * as decisions from '../console/decisions.mjs';
import { NO_ITEM, hasLearned, keepLearned, learnedRows, undoLearned } from '../console/learned.mjs';
import { taskDetails } from '../console/task-details.mjs';
import { CONFIG_FILE } from '../config/load.mjs';
import { modelName, ownerWaiting, readState, redact as redactLooksSecret, runningAgents, snapshot, stoppedByOf } from '../engine/state.mjs';
import { heldSpawnSync } from '../engine/loop-holds.mjs';
import { AGENT_ID, findAgentTranscript, markedSession, readModel, sessionTranscript } from '../engine/session-files.mjs';
import { cutEntries, fingerprint, markReport, pageOf, transcriptReader } from '../engine/transcript.mjs';
import { runAsync } from '../engine/run-async.mjs';
import { redact as redactNamed } from '../secrets/redact.mjs';
import { stopperOf } from '../console/stopper.mjs';
import { readFindingsLines, readRuns } from '../engine/run-record.mjs';
import { readLearnerCalls } from '../engine/learner.mjs';
import { tokenView } from '../engine/token-report.mjs';
import { historyView } from '../engine/history.mjs';
import { stateDir as stateDirOf } from '../engine/paths.mjs';
import { detect, writeInit } from '../engine/init-helpers.mjs';
import { PACKS } from '../../packs/index.mjs';
import { loadResolved } from '../settings/load.mjs';
import { helpBody } from './help.mjs';
import { doneChange, openStorySource } from '../engine/story-source.mjs';
import { changeSetting, LAYERS, settingsView } from '../settings/change.mjs';
import { findSetting, GROUPS } from '../settings/registry.mjs';
import { jiraEnv } from '../jira/cache.mjs';
import { foremanEnvName, foremanFileKeys, isIgnored, sessionKeys } from '../engine/foreman-keys.mjs';
import { readSignIn, useKey } from '../engine/claude-fallback.mjs';
import { jiraRefresher } from '../jira/refresher.mjs';
import { salesforceRefresher } from '../adapters/stories/salesforce-refresher.mjs';
import { endStrays, findStrays } from '../engine/strays.mjs';
import { AREAS, SETUP_FIRST, STEPS, offAreas, serializeStep, stepById } from '../setup/steps.mjs';
import { signInUse } from '../setup/claude.mjs';
import { jiraSetup } from '../setup/jira.mjs';
import { JIRA_SCREEN } from '../setup/jira-screen.mjs';
import { notifySetup } from '../setup/notify.mjs';
import { NOTIFY_SCREEN } from '../setup/notify-screen.mjs';
import { CHECK_RUN_MS, WORDS as PROJECT_WORDS, checkRunError, envSecrets, fileSecrets, projectChange, projectConfig, runCheckCommand } from '../setup/project.mjs';
import { readTeam, teamApply } from '../settings/team.mjs';
import { changed, fileStamps } from '../engine/live-settings.mjs';
import { configWithLocal } from '../settings/resolve.mjs';
import { readLocal } from '../settings/local.mjs';
import { signedInSites } from '../jira/auth.mjs';
import { WORDS as SF_WORDS, salesforceSetup } from '../setup/salesforce.mjs';
import { gearsetSetup } from '../setup/gearset.mjs';
import { cloudSetup } from '../setup/cloud.mjs';
import { CLOUD_SCREEN } from '../setup/cloud-screen.mjs';
import { STEP_CHECK_MS, checksForStep, envNames, readCache, resolveStep, runChecks, shareable, stepStatus, writeCache } from '../setup/status.mjs';
import { KEYS, KEY_CARD, checkShape, generateKey, keyInfo, stepForKey, testKey } from '../setup/keys.mjs';
import { makeLimiter, markChecked, markConfirmed, readRecord } from '../setup/record.mjs';
import { changeable, fileFor, ignoreKeyFile, keyState, removeKey, secretValue, setKey } from '../secrets/env-store.mjs';
import { withState } from '../state-store/with-state.mjs';

const PAGE = new URL('./page.html', import.meta.url);
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const MAX_BODY = 64 * 1024;
// The supervisor publishes on every change and at least every 5 minutes.
const FRESH_MS = 6 * 60_000;
const KEEP_ALIVE_MS = 15_000;
const DEBOUNCE_MS = 150;
// Check now starts at most one release watch in this long.
const WATCH_GAP_MS = 10_000;
// A task's brief file younger than this is read as it is; an older one is fetched again.
const BRIEF_FRESH_MS = 10 * 60_000;
// How long the details wait for a brief fetch before answering { pending: true }.
const BRIEF_WAIT_MS = 3000;
// Only this much of a brief is read for a task's details; the parser reads no more either.
const BRIEF_MAX_BYTES = 256 * 1024;

// The first `max` bytes of a file as text.
function readHead(path, max) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(max);
    return buf.toString('utf8', 0, readSync(fd, buf, 0, max, 0));
  } finally {
    closeSync(fd);
  }
}

const COMMON = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' };
const JSON_HEADERS = { ...COMMON, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const PAGE_HEADERS = {
  ...COMMON,
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

const KEYS_LOCAL_ONLY =
  'Keys can be saved and tested only on a dashboard that listens on this computer alone (127.0.0.1). To use it from another machine, open it through an SSH tunnel.';
const JIRA_LOCAL_ONLY = JIRA_SCREEN.signin.localOnly;
const TRANSCRIPT_LOCAL_ONLY =
  'Conversations can be read only on a dashboard that listens on this computer alone (127.0.0.1). To use it from another machine, open it through an SSH tunnel.';
// One answer for every id that is not a known agent, whatever is wrong with it; it never repeats the id.
const NO_AGENT = 'Foreman knows no agent with that id in a story running now.';
const SLOT_NAME = /^w[1-9]\d*$/;
const INDEX = /^\d{1,9}$/;
// The answers of an owner change on the branch state store (changeState): never git's output or the remote.
const STATE_UNREACHABLE = 'Could not get the state from the state branch, so nothing was changed. Try again; foreman status says why.';
const STATE_NOT_SENT = 'Saved on this machine, but it did not reach the state branch yet; the next change sends it.';

const GROUP_LABELS = { run: 'Run', models: 'Agent models', features: 'Features', learning: 'Learning', release: 'Release', jira: 'Jira', notify: 'Notify', console: 'Dashboard' };

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const realSh = (cmd, args, opts) => heldSpawnSync(cmd, args, { ...opts, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
const bare = (host) => String(host ?? '').replace(/^\[(.*)\]$/, '$1');

export const isLoopback = (host) => LOOPBACK.has(bare(host).toLowerCase());

// Whether a request may save or test keys: the dashboard listens on loopback only and the request came from this computer.
export const fromThisComputer = (req, local) => Boolean(local) && isLoopback(String(req?.socket?.remoteAddress ?? '').replace(/^::ffff:/, ''));

// The token from the environment, else from Foreman's own keys file (.env.foreman), else from
// the project's env file; '' when none has it. The files are parsed here, not loaded, so
// nothing else in them reaches this process's env.
export function dashboardToken({ root, config, env = process.env }) {
  if (env?.FOREMAN_DASHBOARD_TOKEN) return env.FOREMAN_DASHBOARD_TOKEN;
  const own = foremanFileKeys({ root, config }).FOREMAN_DASHBOARD_TOKEN;
  if (own) return own;
  if (!config?.envFile) return '';
  try {
    return parseEnv(readFileSync(join(root, config.envFile), 'utf8')).FOREMAN_DASHBOARD_TOKEN || '';
  } catch {
    return '';
  }
}

const digest = (text) => createHash('sha256').update(String(text)).digest();
const sameToken = (given, token) => timingSafeEqual(digest(given), digest(token));

// The hostname part of a Host header: "127.0.0.1:4317", "[::1]:4317", "localhost".
function hostName(header) {
  const h = String(header ?? '');
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']'));
  return h.split(':')[0];
}

class HttpError extends Error {
  constructor(status, message, { retryAfter, allow, fix } = {}) {
    super(message);
    this.status = status;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
    if (allow !== undefined) this.allow = allow;
    // The fix the page offers for this refusal, such as 'ignore'; a plain word, never a value.
    if (typeof fix === 'string') this.fix = fix;
  }
}

function sendJson(res, status, body, extra = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(text), ...extra });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > MAX_BODY) {
      reject(new HttpError(413, 'The request body is over 64 KB.'));
      return;
    }
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) over = true;
      if (!over) chunks.push(chunk);
    });
    req.on('end', () => (over ? reject(new HttpError(413, 'The request body is over 64 KB.')) : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

async function readJsonObject(req) {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'Send JSON, with content-type application/json.');
  const text = await readBody(req);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'The body is not valid JSON.');
  }
  if (!isPlain(value)) throw new HttpError(400, 'The body must be a JSON object.');
  return value;
}

// An error the owner's input caused (a plain Error from the console modules) is a 400 with its
// reason; a system error (it has a code, like EACCES) is a 500 that says nothing more.
function inputError(err) {
  if (err instanceof HttpError) return err;
  if (err?.code) return new HttpError(500, 'The dashboard could not do that; see the run log.');
  return new HttpError(400, String(err?.message ?? err));
}

// `foreman release watch` in the background, as the supervisor starts it; the watch takes its own
// lock, and the dashboard starts at most one every WATCH_GAP_MS.
const FOREMAN_BIN = fileURLToPath(new URL('../../bin/foreman', import.meta.url));
function spawnReleaseWatch({ root, env }) {
  const child = spawn(process.execPath, [FOREMAN_BIN, 'release', 'watch'], { cwd: root, stdio: 'ignore', env });
  child.on('error', () => {});
  child.unref();
}

// How a step check's time limit reads: whole minutes from a minute up, else seconds.
const limitWords = (ms) => {
  const n = ms >= 60_000 ? Math.round(ms / 60_000) : Math.max(1, Math.round(ms / 1000));
  return `${n} ${ms >= 60_000 ? 'minute' : 'second'}${n === 1 ? '' : 's'}`;
};
export const STEP_CHECK_WORDS = Object.freeze({
  timedOut: (ms) => `The checks for this step took longer than ${limitWords(ms)} and were stopped. Run \`foreman doctor\` in a terminal to see which one hangs.`,
  failed: 'The checks could not run; run `foreman setup steps` on this computer for the detail.',
});

// What a step check's child (runAsync's result) answers when it did not finish: { status: 504,
// error } past the time limit, { status: 500, error } when it failed or could not start, else
// null. Fixed words only: never the child's output or the step id.
export function stepCheckRefusal(r, limitMs) {
  if (r?.timedOut) return { status: 504, error: STEP_CHECK_WORDS.timedOut(limitMs) };
  if (!r || r.error || r.status !== 0) return { status: 500, error: STEP_CHECK_WORDS.failed };
  return null;
}

// `sh(cmd, args, { cwd })` -> { status, stdout } runs git for configDirty and the key files'
// ignore check; tests pass their own.
// `releaseWatch()` starts `foreman release watch` for "Check now"; tests pass their own.
// `fetchBrief(id)` fetches a task's brief and writes its file, resolving true when it did; on a
// Jira project it is a refresher's (lib/jira/refresher.mjs), on a Salesforce Cases project the
// Salesforce one's (adapters/stories/salesforce-refresher.mjs), built on first use and never
// started, else null. `briefWaitMs` is how long the details wait for it.
// `doctor()` -> { config, ctx, checks } builds the doctor's checks afresh for a step check and runs
// them in this process; for tests. Without it a step check runs `foreman setup steps --step <id>`
// in a child, within `setupCheckTimeoutMs` (STEP_CHECK_MS).
// `config` null starts it in set-up mode; `host` is where it listens when config.console has no
// host (127.0.0.1 by default).
// `keyFetch`, `keySh`, `keyBase` and `keyTimeoutMs` are what the key tests ask services with;
// keySh also runs the Cloud runner step's git and gh.
// `checkRunTimeoutMs` is how long a check command run from the Set up tab may take.
// `jiraPort`, `jiraLoginTimeoutMs`, `jiraFetch` and `jiraSleep` are the Jira sign-in's callback
// port and wait, and what it asks Atlassian with.
// `gitEmail()` is the test email's last-resort recipient (git user.email when not given); it is
// sent with keyFetch and keyTimeoutMs.
// `setupSh` runs openssl and sf for the Salesforce set-up (the key tests' shell by default), and
// `homedir` is where its key folder and default sf home live (os.homedir() by default).
// `strays` ({ find() -> { strays }, end(strays) -> { ended, left } }) is what the run:strays
// item's End them uses: findStrays over this project and its state folder, and endStrays.
// `stateSh` and `stateSleep` are the git shell and the wait between push tries for the branch
// state store's syncs around each owner change (withState's sh and sleep; its own defaults when
// not given). Not `sh`, which only answers configDirty and the ignore checks. `stderr` gets the
// syncs' detail, git's words included, which no response ever carries (process.stderr).
export function createDashboardServer({
  root,
  config: givenConfig,
  stateDir: givenStateDir,
  host: givenHost,
  env = process.env,
  now = () => new Date(),
  sh = realSh,
  releaseWatch = () => spawnReleaseWatch({ root, env }),
  briefWaitMs = BRIEF_WAIT_MS,
  fetchBrief,
  doctor,
  setupCheckTimeoutMs = STEP_CHECK_MS,
  keyFetch = globalThis.fetch,
  keyBase = {},
  keyTimeoutMs = 10_000,
  keySh,
  checkRunTimeoutMs = CHECK_RUN_MS,
  jiraPort = 8765,
  jiraLoginTimeoutMs,
  jiraFetch: jiraHttp = globalThis.fetch,
  jiraSleep,
  gitEmail,
  setupSh,
  homedir = os.homedir(),
  strays: givenStrays = null,
  stateSh,
  stateSleep,
  stderr = process.stderr,
}) {
  // Both change once, when set-up mode finds a valid config (refresh below).
  let config = givenConfig ?? null;
  let stateDir = givenStateDir ?? stateDirOf(root, config, env);
  const host = config?.console?.host ?? givenHost ?? '127.0.0.1';
  const local = isLoopback(host);
  const token = local ? '' : dashboardToken({ root, config, env });
  // Reads stateDir when called: set-up mode may move it once a config is found.
  const strays = givenStrays ?? { find: () => findStrays({ root, dir: stateDir }), end: endStrays };
  if (!local && !token) {
    throw new Error(
      `The dashboard is set to listen on ${host}, which other computers can reach, so it needs FOREMAN_DASHBOARD_TOKEN in the environment or in ${foremanEnvName(config)}. It was not started.`,
    );
  }

  // One owner change through the state store, as a CLI write command goes (withState): on the
  // branch store the state branch is pulled first and fn's writes pushed after as one commit named
  // `message`, a fixed text and never the owner's input. With the files store, FOREMAN_STATE_SYNC
  // off or no config, fn just runs. A pull that fails runs nothing (503); a push that fails keeps
  // the change here and answers `warning`. Changes run one at a time, in the order they came.
  // Resolves { result, warning }; an error fn throws comes back as it is.
  let stateQueue = Promise.resolve();
  function changeState(message, fn) {
    const run = async () => {
      let ran = false;
      let result;
      const ctx = { root, env, stderr, ...(stateSh ? { sh: stateSh } : {}), ...(stateSleep ? { sleep: stateSleep } : {}) };
      const code = await withState(ctx, { write: true, message }, async () => {
        ran = true;
        result = await fn();
        return 0;
      });
      if (!ran) throw new HttpError(503, STATE_UNREACHABLE);
      return { result, warning: code === 0 ? null : STATE_NOT_SENT };
    };
    const next = stateQueue.then(run, run);
    stateQueue = next.catch(() => {});
    return next;
  }
  // A response body with the warning added only when there is one.
  const warned = (body, warning) => (warning ? { ...body, warning } : body);

  async function currentStatus() {
    let snap = null;
    try {
      const file = join(stateDir, 'status.json');
      if (Date.now() - statSync(file).mtimeMs < FRESH_MS) snap = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      // no run publishing: work it out below
    }
    if (!isPlain(snap)) snap = await snapshot(stateDir, now(), null, { root, slots: config.slots, env });
    // An agent's command and words may hold a secret the agent used: blank every known value,
    // for any viewer, before the snapshot leaves here.
    const { clean } = secretCleaner();
    for (const s of Array.isArray(snap.slots) ? snap.slots : [])
      for (const a of Array.isArray(s?.agents) ? s.agents : [])
        for (const k of ['raw', 'says', 'doing']) if (typeof a?.[k] === 'string') a[k] = clean(a[k]);
    // What the page adds to the snapshot: the project, the owner's commands as written (so it can
    // show which are still on their way), and whether a stop is waiting.
    const requested = readControl(stateDir);
    snap.control = { ...(isPlain(snap.control) ? snap.control : {}), paused: requested.paused === true, stopRequested: existsSync(stopFile(stateDir)) };
    snap.stoppedBy = stoppedByOf(stateDir);
    snap.requested = requested;
    snap.project = { name: config?.project?.name ?? '', slots: config?.slots ?? 1, rounds: config?.rounds ?? null };
    return snap;
  }

  // ── settings ──
  const settingsCtx = { root, env, dir: stateDir };

  // Whether foreman.config.json has changes not yet committed; false outside a repository.
  function configDirty() {
    try {
      const r = sh('git', ['status', '--porcelain', '--', CONFIG_FILE], { cwd: root });
      return r?.status === 0 && String(r.stdout ?? '').trim() !== '';
    } catch {
      return false;
    }
  }

  function openView() {
    const view = settingsView(settingsCtx);
    if (view.error) throw new HttpError(409, view.error);
    return view;
  }

  function settingsBody() {
    const view = openView();
    const groups = GROUPS.filter((g) => view.rows.some((r) => r.group === g)).map((name) => ({ name, label: GROUP_LABELS[name] ?? name }));
    return { groups, settings: view.rows, configDirty: configDirty(), warnings: view.warnings };
  }

  function changeSettings(body) {
    const { name, layer } = body;
    if (typeof name !== 'string' || !name) throw new HttpError(400, 'Which setting? Send its name.');
    if (!LAYERS.includes(layer)) throw new HttpError(400, `layer must be local or team, not ${typeof layer === 'string' ? layer : 'nothing'}`);
    const reset = body.reset === true;
    // A setting this project hides cannot be changed here, not even reset: the panel never shows it.
    const e = findSetting(name);
    if (e && !openView().rows.some((r) => r.name === name)) throw new HttpError(400, `${name} applies only when ${e.whenText}`);
    const result = changeSetting(settingsCtx, reset ? { name, layer, reset } : { name, value: body.value, layer });
    if (result.error) throw new HttpError(400, result.error);
    const setting = openView().rows.find((r) => r.name === name) ?? null;
    return { ok: true, setting, lines: result.lines, configDirty: configDirty() };
  }

  // ── set-up ──
  const shellEnv = env === process.env ? process.env : { ...process.env, ...env };
  // Synchronous, so each call holds this process; the 2-minute limit (a call's own timeout wins,
  // as the cloud check's `claude -p` sets) caps that, and the late-wake event names a long one.
  const runKeySh =
    keySh ??
    ((cmd, args = [], opts = {}) => {
      const r = heldSpawnSync(cmd, args, { env: shellEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, killSignal: 'SIGKILL', ...opts });
      return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    });
  let limiter = makeLimiter({ dir: stateDir, now });
  const store = { root, config, env, sh };

  // The two files' stamps when the config in use was read; null in set-up mode.
  let seen = config ? fileStamps({ root, dir: stateDir }) : null;

  // In set-up mode, loads the config again; once it is valid the server is in full mode for good.
  // A config file that is there but invalid leaves it in set-up mode.
  // In full mode, loads it again only when foreman.config.json or the local settings changed,
  // keeping the console block the server started with; an invalid file keeps the config from
  // before. The local layer is the one in the state folder this server serves.
  function refresh() {
    if (config === null) {
      const r = loadResolved(root, { env });
      if (!r.config) return;
      config = r.config;
      store.config = config;
      if (r.dir !== stateDir) {
        stateDir = r.dir;
        settingsCtx.dir = stateDir;
        limiter = makeLimiter({ dir: stateDir, now });
      }
      seen = fileStamps({ root, dir: stateDir });
      return;
    }
    // Stamps first, then the load: a write in between is seen at the next request, never lost.
    const stamps = fileStamps({ root, dir: stateDir });
    if (!changed(seen, stamps)) return;
    seen = stamps;
    const r = loadResolved(root, { env });
    if (!r.config) return;
    const resolved = r.dir === stateDir ? r.config : configWithLocal(r.team, readLocal(stateDir).values);
    config = { ...resolved, console: config.console };
    store.config = config;
  }

  const setupPath = (path) => path === '/' || path === '/api/help' || path === '/api/setup' || path.startsWith('/api/setup/');

  // The change form's switch of story source or pack, on a project that has a config.
  function changeProject(body) {
    if (Object.keys(body).some((k) => k !== 'change')) throw new HttpError(400, PROJECT_WORDS.badChange);
    if (!existsSync(join(root, CONFIG_FILE))) throw new HttpError(409, SETUP_FIRST);
    const { raw, errors } = readTeam(root);
    if (errors) throw new HttpError(409, SETUP_FIRST);
    const sfdx = hasSfdx();
    const sites = signedInSites({ env: shellEnv });
    const r = projectChange(raw, body.change, { sfdx, site: sites.length === 1 ? sites[0] : null, packs: PACKS, root });
    if (!r.ok) return { ok: false, errors: r.errors };
    const applied = teamApply(root, r.edits);
    if (applied.errors.length) return { ok: false, errors: applied.errors };
    return { ok: true, lines: r.lines, configDirty: configDirty() };
  }

  // The config as sent, or the form's answers made into one.
  function writeProject(body) {
    if (Object.hasOwn(body, 'change')) return changeProject(body);
    const givesAnswers = Object.hasOwn(body, 'answers');
    if (givesAnswers && Object.hasOwn(body, 'config')) throw new HttpError(400, PROJECT_WORDS.oneOf);
    if (givesAnswers ? !isPlain(body.answers) : !isPlain(body.config)) throw new HttpError(400, givesAnswers ? PROJECT_WORDS.badAnswers : 'Send the config as a JSON object.');
    if (Object.hasOwn(body, 'example') && typeof body.example !== 'boolean') throw new HttpError(400, 'example must be true or false.');
    // In set-up mode a file that is there does not load (refresh ran first), so it may be
    // replaced; in full mode the file is the project's, even one broken by hand since.
    const replace = existsSync(join(root, CONFIG_FILE));
    if (replace && config !== null) throw new HttpError(409, 'This project already has foreman.config.json, so set-up left it as it is.');
    try {
      let config = body.config;
      if (givesAnswers) {
        const r = projectConfig(detect(root, { packs: PACKS }), body.answers);
        if (!r.ok) return { ok: false, errors: r.errors };
        config = r.config;
      }
      return writeInit(root, config, { example: body.example ?? true, marketplace: 'foreman', force: replace });
    } catch (err) {
      throw inputError(err);
    }
  }

  // Whether the project looks like Salesforce: the change form offers the pack only then.
  const hasSfdx = () => existsSync(join(root, 'sfdx-project.json'));

  // Check commands run from the Set up tab and not finished yet, the step checks' children too;
  // closing kills their groups.
  const runningChecks = new Set();
  // The step ids whose check runs or waits its turn, for GET /api/setup's checking.
  const checking = new Set();
  // Step checks run one at a time, in the order they came, as changeState's changes do.
  let checkQueue = Promise.resolve();

  const resolvedSteps = () => {
    const names = envNames({ root, config, env });
    return STEPS.map((s) => resolveStep(s, { config, envNames: names }));
  };
  const keyNames = (step) => step.inputs.filter((i) => i.kind === 'key').map((i) => i.name);

  // A key's row: whether it is set and where, masked, and whether git ignores its file; never
  // its value. git is asked once per file.
  const IGNORED = { ignored: true, 'not-ignored': false };
  function keyRows(names) {
    const ignored = new Map();
    const ignoredOf = (file) => {
      if (!ignored.has(file)) ignored.set(file, IGNORED[isIgnored({ root, file, sh: store.sh })] ?? null);
      return ignored.get(file);
    };
    return keyState(names, store).map(({ name, set, masked, source }) => {
      const info = keyInfo(name);
      const file = fileFor(name, config);
      return {
        name,
        label: info.label,
        set,
        masked,
        source,
        file,
        testable: info.test !== null,
        testLabel: info.testLabel ?? 'Test it',
        generate: typeof info.generate === 'function',
        ignored: ignoredOf(file),
      };
    });
  }

  function stepEntry(step, results, record) {
    const own = results.filter((r) => r.step === step.id || r.fix?.step === step.id);
    const newest = own.map((r) => r.checkedAt).filter((t) => typeof t === 'string').sort().at(-1) ?? null;
    const keys = keyRows(keyNames(step));
    const entry = {
      ...serializeStep(step),
      status: stepStatus(step, results),
      results: own.map(shareable),
      checkedAt: record.steps[step.id]?.checkedAt ?? newest,
      confirmedAt: record.steps[step.id]?.confirmedAt ?? null,
      keys,
      checking: checking.has(step.id),
    };
    if (step.form) entry.projectNow = config ? { source: config.stories?.adapter ?? null, pack: config.pack === 'salesforce' ? 'salesforce' : 'none', sfdx: hasSfdx() } : null;
    if (step.signin) entry.inUse = signInUse({ rows: keys, result: shareable(results.find((r) => r.name === 'claude sign-in')), fallback: readSignIn(stateDir) });
    if (step.jira?.part === 'filter') entry.jiraConfig = storiesNow();
    if (step.notify) entry.notifyConfig = notifyNow();
    if (step.salesforce && step.applies) entry.salesforceConfig = salesforceNow();
    if (step.gearset && step.applies) {
      const current = gearsetNow();
      // The owner's confirmations, by stage name: the record keeps them as ci-tests-<stage>.
      const byYou = record.steps[step.id]?.confirmedByYou ?? {};
      const confirmed = Object.fromEntries(Object.entries(byYou).filter(([item]) => item.startsWith(CI_TESTS)).map(([item, at]) => [item.slice(CI_TESTS.length), at]));
      entry.gearsetConfig = current ? { ...current, confirmed } : null;
    }
    if (step.cloud) entry.cloudConfig = cloudNow();
    return entry;
  }

  function setupBody() {
    const results = Object.values(readCache(stateDir));
    const record = readRecord(stateDir);
    const steps = resolvedSteps().map((s) => stepEntry(s, results, record));
    const checkedAt = steps.map((s) => s.checkedAt).filter(Boolean).sort().at(-1) ?? null;
    const off = offAreas(config, { sfdx: hasSfdx() });
    const hasConfig = existsSync(join(root, CONFIG_FILE));
    // Why the file does not load, in set-up mode only; full mode keeps the last good config.
    const configErrors = config === null && hasConfig ? loadResolved(root, { env }).errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)) : null;
    return { checkedAt, canChangeKeys: local, hasConfig, configErrors, areas: AREAS, keyCard: KEY_CARD, off, steps };
  }

  // The registry's names and the key inputs of the steps that apply here (an adapter's keys).
  function knownKeys() {
    const known = new Set(KEYS.map((k) => k.name));
    for (const s of resolvedSteps()) if (s.applies) for (const n of keyNames(s)) known.add(n);
    return known;
  }
  // The body's key name, when Foreman knows it; the refusal never repeats it.
  const keyName = (body) => {
    if (typeof body.name !== 'string' || !knownKeys().has(body.name)) throw new HttpError(400, 'Foreman does not know that key.');
    return body.name;
  };

  function keysAllowed(req, message = KEYS_LOCAL_ONLY) {
    if (!fromThisComputer(req, local)) throw new HttpError(403, message);
  }

  // ── Jira set-up ──
  const jira = jiraSetup({ root, env, now, fetch: jiraHttp, sleep: jiraSleep, port: jiraPort, ...(jiraLoginTimeoutMs !== undefined ? { timeoutMs: jiraLoginTimeoutMs } : {}) });
  // The filter screen's starting values; null when the project cannot say (no config, not Jira).
  function storiesNow() {
    try {
      return jira.currentStories();
    } catch {
      return null;
    }
  }
  // Its errors, and the Salesforce set-up's, carry the status to answer with.
  async function jiraCall(fn) {
    try {
      return await fn();
    } catch (err) {
      if (Number.isInteger(err?.status)) throw new HttpError(err.status, err.message, { retryAfter: err.retryAfter, fix: err.fix });
      throw inputError(err);
    }
  }

  // ── notifications set-up ──
  const notify = notifySetup({ root, env, now, fetch: keyFetch, gitEmail, timeoutMs: keyTimeoutMs, setupFirst: SETUP_FIRST });
  // The notifications screen's starting values; null when the project cannot say.
  function notifyNow() {
    try {
      return notify.current();
    } catch {
      return null;
    }
  }
  // What the notifier reads: the stored Resend key and addresses, the environment before the file.
  const NOTIFY_KEYS = ['RESEND_API_KEY', 'RESEND_FROM_EMAIL', 'FOREMAN_NOTIFY_EMAIL', 'FACTORY_NOTIFY_EMAIL'];
  function notifyValues() {
    const values = {};
    for (const name of NOTIFY_KEYS) {
      const value = secretValue(name, store);
      if (value !== null) values[name] = value;
    }
    return values;
  }
  async function testNotify() {
    if (config === null) throw new HttpError(409, SETUP_FIRST);
    const attempt = startTry('notifications');
    try {
      const result = await jiraCall(() => notify.test({ stateDir, values: notifyValues() }));
      if (result.sent && !result.outbox) markConfirmed(stateDir, 'notifications', now().toISOString());
      return { ok: true, result };
    } finally {
      attempt.done();
    }
  }

  // ── Salesforce set-up ──
  const salesforce = salesforceSetup({ root, env: shellEnv, now, sh: setupSh ?? runKeySh, homedir });
  // The Salesforce screen's starting values; null when the project cannot say.
  function salesforceNow() {
    try {
      return salesforce.current();
    } catch {
      return null;
    }
  }

  // ── Gearset set-up ──
  const gearset = gearsetSetup({ root, env, fetch: keyFetch, now, tokenOf: () => secretValue('GEARSET_API_TOKEN', store), setupFirst: SETUP_FIRST });
  const CI_TESTS = 'ci-tests-';
  // The Gearset screen's starting values; null when the project cannot say.
  function gearsetNow() {
    try {
      return gearset.current();
    } catch {
      return null;
    }
  }
  async function readGearset(body) {
    const attempt = startTry('sf-gearset');
    try {
      return await jiraCall(() => gearset.read(body));
    } finally {
      attempt.done();
    }
  }

  // ── Cloud runner set-up ──
  // git and gh through the key tests' shell: setupSh is the Salesforce set-up's sf and openssl.
  const cloud = cloudSetup({ root, env: shellEnv, sh: runKeySh, valueOf: (n) => secretValue(n, store), setupFirst: SETUP_FIRST });
  // The Cloud runner screen's starting values; null when the project cannot say.
  function cloudNow() {
    try {
      return cloud.current();
    } catch {
      return null;
    }
  }
  // A call limited as a check of the cloud-runner step; `confirmed(result)` says when it records
  // the step's confirmedAt.
  async function cloudTry(fn, confirmed) {
    const attempt = startTry('cloud-runner');
    try {
      const result = await jiraCall(fn);
      if (confirmed?.(result)) markConfirmed(stateDir, 'cloud-runner', now().toISOString());
      return result;
    } finally {
      attempt.done();
    }
  }

  function startTry(stepId) {
    const r = limiter.begin(stepId);
    if (r.ok) return r;
    const message =
      r.why === 'busy'
        ? 'This step is being checked already. Try again in a moment.'
        : `Too many tries for this step. Try again in ${r.retryAfter} second${r.retryAfter === 1 ? '' : 's'}.`;
    throw new HttpError(429, message, { retryAfter: r.retryAfter });
  }

  // A key to stop on when the environment has it: Foreman cannot change it there.
  function mustChange(name) {
    try {
      changeable(name, env);
    } catch (err) {
      if (err?.code === 'environment') throw new HttpError(409, err.message);
      throw inputError(err);
    }
  }

  // Saves a value through env-store, adding its file to .gitignore first when git does not
  // ignore it, as `foreman keys set` does; the lines say what happened, never the value.
  async function saveValue(name, value, lines) {
    let r;
    try {
      r = await setKey(name, value, store);
    } catch (err) {
      if (err?.code === 'tracked') throw new HttpError(409, err.message);
      if (err?.code !== 'not-ignored') throw err;
      if (ignoreKeyFile(name, store) === 'added') lines.push(`added ${err.fix.file} to .gitignore`);
      r = await setKey(name, value, store);
    }
    lines.push(`set ${name} in ${r.file}`);
  }

  async function changeKey(body) {
    const name = keyName(body);
    const givesValue = Object.hasOwn(body, 'value');
    const givesRemove = Object.hasOwn(body, 'remove');
    if (givesValue === givesRemove || (givesValue && typeof body.value !== 'string') || (givesRemove && body.remove !== true)) {
      throw new HttpError(400, "Send the key's value, or remove: true.");
    }
    mustChange(name);
    const lines = [];
    try {
      if (givesValue) {
        const wrong = checkShape(name, body.value);
        if (wrong) throw new HttpError(400, wrong);
        await saveValue(name, body.value, lines);
      } else {
        const r = await removeKey(name, store);
        lines.push(r.removed ? `removed ${name} from ${r.file}` : `${name} is not in ${r.file}`);
      }
    } catch (err) {
      if (err?.code === 'environment') throw new HttpError(409, err.message);
      throw inputError(err);
    }
    return { ok: true, key: keyRows([name])[0], lines };
  }

  // A new value for a key Foreman makes itself, saved and never answered. A key Foreman does not
  // make gets generateKey's own refusal, which names a key Foreman knows.
  async function generateOneKey(body) {
    const name = keyName(body);
    let value;
    try {
      value = generateKey(name);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    mustChange(name);
    const lines = [];
    try {
      await saveValue(name, value, lines);
    } catch (err) {
      if (err?.code === 'environment') throw new HttpError(409, err.message);
      throw inputError(err);
    }
    return { ok: true, key: keyRows([name])[0], lines };
  }

  function ignoreOneKey(body) {
    const name = keyName(body);
    let r;
    try {
      r = ignoreKeyFile(name, store);
    } catch (err) {
      throw inputError(err);
    }
    const file = fileFor(name, config);
    return { ok: true, key: keyRows([name])[0], lines: [r === 'added' ? `added ${file} to .gitignore` : `git already ignores ${file}`] };
  }

  async function testOneKey(body) {
    const name = keyName(body);
    const value = secretValue(name, store);
    if (value === null) throw new HttpError(400, 'That key is not set.');
    const step = stepForKey(name);
    const attempt = startTry(step);
    try {
      const r = await testKey(name, value, { fetch: keyFetch, sh: runKeySh, env: shellEnv, base: keyBase, timeoutMs: keyTimeoutMs });
      if (r.ok) markConfirmed(stateDir, step, now().toISOString());
      return { ok: true, name, result: { ok: r.ok, detail: r.detail } };
    } finally {
      attempt.done();
    }
  }

  async function checkStep(encoded) {
    let id = null;
    try {
      id = decodeURIComponent(encoded);
    } catch {
      // a malformed escape: no step has it
    }
    const model = id === null ? undefined : stepById(id);
    if (!model) throw new HttpError(404, 'No set-up step has that id.');
    if (!resolveStep(model, { config }).applies) throw new HttpError(400, "That step is not part of this project's set-up.");
    const attempt = startTry(model.id);
    checking.add(model.id);
    try {
      const work = async () => {
        const results = doctor ? await checkInProcess(model.id) : await checkInChild(model.id);
        markChecked(stateDir, model.id, now().toISOString());
        const step = resolvedSteps().find((s) => s.id === model.id);
        if (stepStatus(step, results) === 'done') markConfirmed(stateDir, model.id, now().toISOString());
        return { step, results };
      };
      const next = checkQueue.then(work, work);
      checkQueue = next.catch(() => {});
      const { step, results } = await next;
      // Done: the answer's step is no longer being checked.
      checking.delete(model.id);
      return { ok: true, step: stepEntry(step, results, readRecord(stateDir)) };
    } finally {
      checking.delete(model.id);
      attempt.done();
    }
  }

  // A step's checks run here, with the injected doctor (tests): fresh results, plus the cached
  // ones of the other checks, as `foreman setup steps --step` gives them.
  async function checkInProcess(id) {
    const { ctx, checks } = await doctor();
    const cachedBefore = readCache(stateDir);
    const fresh = await runChecks(checksForStep(id, checks, cachedBefore), ctx, { now });
    try {
      writeCache(stateDir, fresh, { keep: checks.map((c) => c.name) });
    } catch {
      // the answer still has the fresh results; the next check saves again
    }
    const cache = readCache(stateDir);
    const ran = new Set(fresh.map((r) => r.name));
    const kept = [...new Set(checks.map((c) => c.name))].filter((n) => !ran.has(n) && Object.hasOwn(cache, n)).map((n) => cache[n]);
    return [...fresh, ...kept];
  }

  // A step's checks run by `foreman setup steps --step <id>` in a child of its own, which writes
  // setup-checks.json itself; the results are then read from it. It runs with this process's
  // environment (a supervisor's FOREMAN_RUN=1 included: `setup` is neither synced nor an owner
  // control) and this dashboard's state folder.
  async function checkInChild(id) {
    const r = await runAsync(process.execPath, [FOREMAN_BIN, 'setup', 'steps', '--step', id], {
      cwd: root,
      env: { ...shellEnv, FOREMAN_STATE_DIR: stateDir },
      timeoutMs: setupCheckTimeoutMs,
      track: runningChecks,
    });
    const refusal = stepCheckRefusal(r, setupCheckTimeoutMs);
    if (refusal) {
      if (refusal.status === 500) stderr.write(`foreman setup steps could not run: ${childText(`${r.error ?? `exit ${r.status ?? r.signal}`}: ${r.stderr}`)}\n`);
      throw new HttpError(refusal.status, refusal.error);
    }
    // The child's save has already dropped the results of checks the config no longer has
    // (setup.mjs), so this reads back only the current checks' results, as checkInProcess gives.
    return Object.values(readCache(stateDir));
  }

  // A child's words, redacted before they reach the log: the secret names' values in this
  // environment, the key files' values and the environment's secret-looking ones (longest first),
  // then anything that looks like a key.
  function childText(text) {
    return secretCleaner().clean(String(text ?? '').trim());
  }

  // Every known secret value, longest first, and a cleaner that blanks them and anything that looks like a key.
  function secretCleaner() {
    const values = [...new Set([...fileSecrets({ root, config }), ...envSecrets(shellEnv)])].sort((a, b) => b.length - a.length);
    return { values, clean: (t) => redactLooksSecret(redactNamed(String(t ?? ''), { env: shellEnv, values })) };
  }

  // ── conversations ──
  const transcripts = transcriptReader({ root });

  // The meta file beside an agent's transcript, as readSubagents reads it: a plain object, else {}.
  function agentMeta(file) {
    try {
      const metaFile = file.replace(/\.jsonl$/, '.meta.json');
      if (!lstatSync(metaFile).isFile()) return {};
      const m = JSON.parse(readFileSync(metaFile, 'utf8'));
      return isPlain(m) ? m : {};
    } catch {
      return {};
    }
  }

  // The conversation in `file` as the routes answer it. Nothing here comes from the request but
  // the validated index numbers.
  function conversation({ id, slot, file, role, label, running, query }) {
    const { values, clean } = secretCleaner();
    let read;
    try {
      read = transcripts.read(file, clean, fingerprint(values));
    } catch {
      throw new HttpError(404, NO_AGENT);
    }
    const marked = markReport(read.entries, running);
    const page = pageOf(marked, query);
    const model = readModel(file);
    return {
      id,
      slot,
      role: clean(role),
      label: clean(label),
      running,
      model,
      modelName: modelName(model),
      total: page.total,
      first: page.first,
      entries: cutEntries(page.entries),
      ...(read.skipped ? { skipped: true } : {}),
    };
  }

  // ?after= / ?before=: whole numbers up to 9 digits, not both. Other keys are ignored.
  function pageQuery(query) {
    const out = {};
    for (const key of ['after', 'before']) {
      if (!query.has(key)) continue;
      const v = query.get(key);
      if (!INDEX.test(v)) throw new HttpError(400, `${key} must be a whole number.`);
      out[key] = Number(v);
    }
    if (out.after !== undefined && out.before !== undefined) throw new HttpError(400, 'Send after or before, not both.');
    return out;
  }

  function agentTranscript(id, query) {
    for (let n = 1; n <= config.slots; n++) {
      const slot = `w${n}`;
      const session = markedSession(stateDir, slot);
      const file = session ? findAgentTranscript(session.paths, id) : null;
      if (!file) continue;
      const meta = agentMeta(file);
      const live = runningAgents(stateDir, slot);
      const mine = live.find((a) => a.id === id);
      const role = (typeof meta.agentType === 'string' && meta.agentType) || mine?.role || 'agent';
      const label = typeof meta.description === 'string' ? meta.description : '';
      return conversation({ id, slot, file, role, label, running: Boolean(mine), query });
    }
    throw new HttpError(404, NO_AGENT);
  }

  function slotTranscript(slot, query) {
    const session = markedSession(stateDir, slot);
    const file = session ? sessionTranscript(session.paths, session.sessionId) : null;
    if (!file) throw new HttpError(404, NO_AGENT);
    return conversation({ id: slot, slot, file, role: 'foreman', label: '', running: true, query });
  }

  // ── what waits on the owner ──
  const waitingList = async () => (await ownerWaiting(stateDir, now(), { root, slots: config.slots, env })).items;

  let lastWatchAt = -Infinity;

  // ── an owner task's details ──
  // Worked out on each use, so a Jira config that set-up mode finds after the start is seen.
  let refresher = null;
  const jiraFetch = (id) =>
    (refresher ??= jiraRefresher({
      stories: () => config.stories,
      stateDir,
      env: jiraEnv(env, config.envFile ? resolve(root, config.envFile) : undefined, resolve(root, foremanEnvName(config))),
      now,
      writeBrief: (k, b) => openStorySource({ root, config, now, env, cacheOnly: true }).writeBrief(k, b),
    })).fetchBrief(id);
  // The same for Salesforce Cases: the brief is read in the refresher's worker process, never here.
  let sfRefresher = null;
  const salesforceFetch = (id) =>
    (sfRefresher ??= salesforceRefresher({
      stories: () => config.stories,
      stateDir,
      root,
      env,
      features: config.features,
      salesforceOrgs: config.salesforce?.orgs,
      now,
    })).fetchBrief(id);
  const fetcher = () => {
    if (fetchBrief !== undefined) return fetchBrief;
    if (config?.stories?.adapter === 'jira') return jiraFetch;
    return config?.stories?.adapter === 'salesforce' ? salesforceFetch : null;
  };

  const fresh = (path) => {
    try {
      return now().getTime() - statSync(path).mtimeMs < BRIEF_FRESH_MS;
    } catch {
      return false;
    }
  };

  // The brief file, fetched again when it is absent or old and there is a fetcher; the old one
  // stands in when the fetch is slow or fails, and with none at all the answer is pending.
  async function taskBody(storyId) {
    const cached = openStorySource({ root, config, now, env, cacheOnly: true });
    let path = cached.brief(storyId)?.path ?? null;
    const fetchOne = fetcher();
    if (fetchOne && (!path || !fresh(path))) {
      const fetching = Promise.resolve().then(() => fetchOne(storyId));
      fetching.catch(() => {}); // a slow fetch that fails later must not go unhandled
      let timer;
      const late = new Promise((done) => {
        timer = setTimeout(() => done(false), briefWaitMs);
        timer.unref?.();
      });
      let fetched = false;
      try {
        fetched = await Promise.race([fetching, late]);
      } catch {
        fetched = false;
      } finally {
        clearTimeout(timer);
      }
      if (fetched === true) path = cached.brief(storyId)?.path ?? null;
      else if (!path) return { pending: true };
    }
    let text = null;
    try {
      if (path) text = readHead(path, BRIEF_MAX_BYTES);
    } catch {
      text = null;
    }
    if (text === null) return { need: [], steps: [], effort: '', doneWhen: '', missing: true };
    const details = taskDetails(text);
    return details.need.length || details.steps.length ? details : { ...details, missing: true };
  }

  // One action on one item, through the writer the CLI uses; answers the line to show.
  async function actOn(item, action, note) {
    const at = now();
    switch (item.kind) {
      case 'decision': {
        const label = item.actions.find((a) => a.id === action)?.label;
        decisions.answer(stateDir, item.id, action === 'answer' ? { note } : { option: label, note }, at);
        return `Answer recorded for ${item.id}.`;
      }
      case 'owner-task': {
        const storyId = item.id.slice('task:'.length);
        const source = openStorySource({ root, config, now, env });
        const updated = await source.update(storyId, doneChange(isText(note) ? note.trim() : 'Marked done from the dashboard.', at));
        if (updated === false) throw new HttpError(400, `${storyId} is not in the story source.`);
        return `${storyId} marked done.`;
      }
      case 'halt':
        return ownerCommand(stateDir, config, { action: 'fixed' }, at);
      case 'release': {
        const t = now().getTime();
        if (t - lastWatchAt < WATCH_GAP_MS) return 'A check started moments ago; the page shows the result shortly.';
        lastWatchAt = t;
        releaseWatch();
        return 'Checking the releases ready to promote now; the page shows the result shortly.';
      }
      case 'slot':
        return ownerCommand(stateDir, config, { action: 'slot', slot: item.id.slice('slot:'.length), slotAction: action }, at);
      case 'learned': {
        // Undo and Keep act at once through the store, and close the note in the same write;
        // Got it on a note about a change Foreman took out only clears it.
        if (action === 'ok') {
          decisions.answer(stateDir, item.id, { option: 'Got it' }, at, { applied: true });
          return 'Note cleared.';
        }
        const r = (action === 'undo' ? undoLearned : keepLearned)(stateDir, item.learned?.id, { now: at });
        if (!r.ok) throw new HttpError(r.status, r.error);
        return r.message;
      }
      case 'run':
        // The self-pause's Resume clears it as `foreman resume` does.
        if (item.id === 'run:paused' && action === 'resume') return ownerCommand(stateDir, config, { action: 'resume' }, at);
        // End them on the strays: the processes (supervisors, hook runs, learn and notify runs) that are not this run's, as found now.
        if (item.id === 'run:strays' && action === 'end') {
          const r = await strays.end((await strays.find()).strays ?? []);
          const n = r.ended.length;
          return `Ended ${n} stray process${n === 1 ? '' : 'es'}.${r.left.length ? ` Still running: pid ${r.left.join(', ')}.` : ''}`;
        }
        // Retry on a failed answer asks the supervisor to apply it again at its next check
        // (control.json's answerRetry), through the path `foreman` commands take.
        if (item.id.startsWith('run:answer:') && action === 'retry') return ownerCommand(stateDir, config, { action: 'retry-answer', id: item.id.slice('run:answer:'.length) }, at);
        // Not reached for run:strays: the route's action check refuses its other actions first.
        throw new HttpError(400, `Nothing to do for ${item.id}.`);
      default:
        throw new HttpError(400, `Nothing to do for ${item.id}.`);
    }
  }

  // ── server-sent events ──
  const clients = new Set();
  let watcher = null;
  let keepAlive = null;
  let pending = null;
  const frame = (snap) => `event: status\ndata: ${JSON.stringify(snap)}\n\n`;

  async function broadcast() {
    pending = null;
    if (!clients.size) return;
    try {
      const text = frame(await currentStatus());
      for (const res of clients) res.write(text);
    } catch {
      // the next change sends again
    }
  }

  function startWatching() {
    if (keepAlive) return;
    keepAlive = setInterval(() => {
      for (const res of clients) res.write(': keep-alive\n\n');
    }, KEEP_ALIVE_MS);
    try {
      mkdirSync(stateDir, { recursive: true });
      watcher = watch(stateDir, (type, name) => {
        if (name && !String(name).startsWith('status.json') && !String(name).startsWith('control.json')) return;
        clearTimeout(pending);
        pending = setTimeout(broadcast, DEBOUNCE_MS);
      });
      watcher.on('error', () => {
        watcher?.close();
        watcher = null;
      });
    } catch {
      watcher = null;
    }
  }

  function stopWatching() {
    clearInterval(keepAlive);
    clearTimeout(pending);
    keepAlive = null;
    pending = null;
    watcher?.close();
    watcher = null;
  }

  function openEvents(req, res) {
    res.writeHead(200, { ...COMMON, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
    clients.add(res);
    startWatching();
    req.on('close', () => {
      clients.delete(res);
      if (!clients.size) stopWatching();
    });
    currentStatus()
      .then((snap) => res.write(frame(snap)))
      .catch(() => {});
  }

  // ── requests ──
  function authorized(req, query) {
    if (!token) return true;
    const m = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''));
    const given = m ? m[1] : req.method === 'GET' ? query.get('token') : null;
    return given !== null && sameToken(given, token);
  }

  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    try {
      return new URL(origin).host === String(req.headers.host ?? '');
    } catch {
      return false;
    }
  }

  async function handle(req, res) {
    const url = String(req.url ?? '/');
    const q = url.indexOf('?');
    const path = q === -1 ? url : url.slice(0, q);
    const query = new URLSearchParams(q === -1 ? '' : url.slice(q + 1));

    if (local && !isLoopback(hostName(req.headers.host))) throw new HttpError(403, 'This dashboard answers only requests addressed to this computer.');
    if (!authorized(req, query)) throw new HttpError(401, 'Unauthorized.');
    if (!sameOrigin(req)) throw new HttpError(403, 'Requests from other sites are refused.');

    refresh();
    if (config === null && !setupPath(path)) throw new HttpError(409, SETUP_FIRST);

    const only = (method) => {
      if (req.method !== method) throw new HttpError(405, `Use ${method}.`, { allow: method });
    };

    if (path === '/') {
      only('GET');
      const page = readFileSync(PAGE);
      res.writeHead(200, { ...PAGE_HEADERS, 'content-length': page.length });
      res.end(page);
      return;
    }
    if (path === '/api/status') {
      only('GET');
      sendJson(res, 200, await currentStatus());
      return;
    }
    if (path === '/api/events') {
      only('GET');
      openEvents(req, res);
      return;
    }
    if (path === '/api/tokens') {
      only('GET');
      sendJson(res, 200, tokenView({ runs: readRuns(stateDir), learner: readLearnerCalls(stateDir), findings: readFindingsLines(stateDir), now: now(), runSince: readState(stateDir).totals?.since ?? null }));
      return;
    }
    if (path === '/api/history') {
      only('GET');
      sendJson(res, 200, historyView(readRuns(stateDir), { now: now().getTime() }));
      return;
    }
    if (path === '/api/control') {
      only('POST');
      const body = await readJsonObject(req);
      try {
        const at = now();
        const by = body?.action === 'stop' ? stopperOf({ via: 'dashboard', agent: req.headers['user-agent'], at }) : undefined;
        const { result: message, warning } = await changeState('foreman dashboard control', () => ownerCommand(stateDir, config, body, at, by));
        sendJson(res, 200, warned({ ok: true, message }, warning));
      } catch (err) {
        throw inputError(err);
      }
      return;
    }
    if (path === '/api/settings') {
      if (req.method === 'GET') {
        sendJson(res, 200, settingsBody());
        return;
      }
      if (req.method !== 'POST') throw new HttpError(405, 'Use GET or POST.');
      const body = await readJsonObject(req);
      try {
        // The team layer edits foreman.config.json, the project's file, not state.
        if (body.layer !== 'local') {
          sendJson(res, 200, changeSettings(body));
        } else {
          const { result, warning } = await changeState('foreman dashboard settings', () => changeSettings(body));
          sendJson(res, 200, warned(result, warning));
        }
      } catch (err) {
        throw inputError(err);
      }
      return;
    }
    // The id and the slot are checked by shape before anything is looked up, and never decoded.
    const agentRoute = /^\/api\/agents\/([^/]+)\/transcript$/.exec(path);
    const slotRoute = agentRoute ? null : /^\/api\/slots\/([^/]+)\/transcript$/.exec(path);
    if (agentRoute || slotRoute) {
      only('GET');
      keysAllowed(req, TRANSCRIPT_LOCAL_ONLY);
      const name = (agentRoute ?? slotRoute)[1];
      const slotNumber = slotRoute && SLOT_NAME.test(name) ? Number(name.slice(1)) : 0;
      if (agentRoute ? !AGENT_ID.test(name) : slotNumber < 1 || slotNumber > config.slots) throw new HttpError(404, NO_AGENT);
      const page = pageQuery(query);
      sendJson(res, 200, agentRoute ? agentTranscript(name, page) : slotTranscript(name, page));
      return;
    }
    if (path === '/api/decisions') {
      only('GET');
      sendJson(res, 200, decisions.list(stateDir));
      return;
    }
    const decision = /^\/api\/decisions\/([^/]+)$/.exec(path);
    if (decision) {
      only('POST');
      const body = await readJsonObject(req);
      try {
        const at = now();
        const { result: answer, warning } = await changeState('foreman dashboard decide answer', () => decisions.answer(stateDir, decision[1], { option: body.option, note: body.note }, at));
        sendJson(res, 200, warned({ ok: true, id: decision[1], answer }, warning));
      } catch (err) {
        throw inputError(err);
      }
      return;
    }
    if (path === '/api/waiting') {
      only('GET');
      sendJson(res, 200, await waitingList());
      return;
    }
    const taskInfo = /^\/api\/waiting\/([^/]+)\/details$/.exec(path);
    if (taskInfo) {
      only('GET');
      // As below: the id is only compared with the list's ids, never joined onto a path or echoed.
      let id = null;
      try {
        id = decodeURIComponent(taskInfo[1]);
      } catch {
        // a malformed escape: no item has it
      }
      const item = id !== null && (await waitingList()).find((i) => i.id === id);
      if (!item || item.kind !== 'owner-task') throw new HttpError(404, 'Nothing waiting on you has that id; reload the list.');
      sendJson(res, 200, await taskBody(id.slice('task:'.length)));
      return;
    }
    const bundle = /^\/api\/waiting\/bundle\/([^/]+)$/.exec(path);
    if (bundle) {
      only('POST');
      const body = await readJsonObject(req);
      // The name is only looked up among the bundles' names: never joined onto a path, never echoed.
      let name = null;
      try {
        name = decodeURIComponent(bundle[1]);
      } catch {
        // a malformed escape: no bundle has it
      }
      try {
        const at = now();
        const { result: r, warning } = await changeState('foreman dashboard bundle', () => answerBundle(stateDir, name, body.action, at));
        sendJson(res, 200, warned({ ok: true, answered: r.answered, failed: r.failed, message: bundleMessage(r) }, warning));
      } catch (err) {
        throw inputError(err);
      }
      return;
    }
    const waiting = /^\/api\/waiting\/([^/]+)$/.exec(path);
    if (waiting) {
      only('POST');
      const body = await readJsonObject(req);
      // The id is only compared with the list's ids: never joined onto a path, never echoed.
      let id = null;
      try {
        id = decodeURIComponent(waiting[1]);
      } catch {
        // a malformed escape: no item has it
      }
      const item = id !== null && (await waitingList()).find((i) => i.id === id);
      if (!item) throw new HttpError(404, 'Nothing waiting on you has that id; reload the list.');
      const ids = item.actions.map((a) => a.id);
      if (typeof body.action !== 'string' || !ids.includes(body.action)) throw new HttpError(400, `Unknown action for ${item.id}; one of ${ids.join(', ') || 'none here'}`);
      try {
        // A release check starts `foreman release watch`, which syncs itself, and ending the
        // strays writes no state: both run as they are.
        const unsynced = item.kind === 'release' || item.id === 'run:strays';
        const { result: message, warning } = unsynced ? { result: await actOn(item, body.action, body.note), warning: null } : await changeState('foreman dashboard waiting', () => actOn(item, body.action, body.note));
        sendJson(res, 200, warned({ ok: true, id: item.id, action: body.action, message }, warning));
      } catch (err) {
        throw inputError(err);
      }
      return;
    }
    if (path === '/api/learned') {
      only('GET');
      sendJson(res, 200, { items: learnedRows(stateDir) });
      return;
    }
    const learnedPath = /^\/api\/learned\/([^/]+)$/.exec(path);
    if (learnedPath) {
      only('POST');
      const body = await readJsonObject(req);
      // As for the waiting ids: only looked up in the ledger, never joined onto a path or echoed.
      // The id is checked before the action, so a bad one is a 404 whatever was asked.
      let id = null;
      try {
        id = decodeURIComponent(learnedPath[1]);
      } catch {
        // a malformed escape: no learned item has it
      }
      if (!hasLearned(stateDir, id)) throw new HttpError(404, NO_ITEM);
      if (body.action !== 'undo') throw new HttpError(400, 'The Learned list takes action undo only.');
      try {
        const at = now();
        const { result: r, warning } = await changeState('foreman dashboard learning undo', () => undoLearned(stateDir, id, { now: at }));
        if (!r.ok) throw new HttpError(r.status, r.error);
        sendJson(res, 200, warned({ ok: true, id, message: r.message }, warning));
      } catch (err) {
        throw inputError(err);
      }
      return;
    }
    if (path === '/api/setup') {
      only('GET');
      sendJson(res, 200, setupBody());
      return;
    }
    if (path === '/api/setup/keys') {
      only('POST');
      keysAllowed(req);
      const body = await readJsonObject(req);
      sendJson(res, 200, await changeKey(body));
      return;
    }
    if (path === '/api/setup/keys/test') {
      only('POST');
      keysAllowed(req);
      const body = await readJsonObject(req);
      sendJson(res, 200, await testOneKey(body));
      return;
    }
    if (path === '/api/setup/keys/generate') {
      only('POST');
      keysAllowed(req);
      const body = await readJsonObject(req);
      sendJson(res, 200, await generateOneKey(body));
      return;
    }
    if (path === '/api/setup/keys/ignore') {
      only('POST');
      keysAllowed(req);
      const body = await readJsonObject(req);
      sendJson(res, 200, ignoreOneKey(body));
      return;
    }
    if (path === '/api/setup/project/detect') {
      only('POST');
      await readJsonObject(req);
      try {
        sendJson(res, 200, detect(root, { packs: PACKS }));
      } catch (err) {
        throw inputError(err);
      }
      return;
    }
    if (path === '/api/setup/project/write') {
      only('POST');
      const r = writeProject(await readJsonObject(req));
      // Sent as it is, so the list of what is wrong reaches the page.
      if (!r.ok) {
        sendJson(res, 400, { error: r.errors.join('; '), errors: r.errors });
        return;
      }
      refresh();
      sendJson(res, 200, { ok: true, lines: r.lines, ...(r.configDirty !== undefined ? { configDirty: r.configDirty } : {}) });
      return;
    }
    if (path === '/api/setup/project/check-run') {
      only('POST');
      keysAllowed(req, PROJECT_WORDS.localOnly);
      const body = await readJsonObject(req);
      // The reason only: the command is never repeated.
      const wrong = checkRunError(body.run);
      if (wrong) throw new HttpError(400, wrong);
      const attempt = startTry('project');
      try {
        const result = await runCheckCommand(body.run.trim(), { cwd: root, env: shellEnv, timeoutMs: checkRunTimeoutMs, secrets: fileSecrets({ root, config }), track: runningChecks });
        sendJson(res, 200, { ok: true, result });
      } finally {
        attempt.done();
      }
      return;
    }
    if (path === '/api/setup/jira/login') {
      if (req.method === 'GET') {
        sendJson(res, 200, await jiraCall(() => jira.current()));
        return;
      }
      if (req.method !== 'POST') throw new HttpError(405, 'Use GET or POST.', { allow: 'GET, POST' });
      keysAllowed(req, JIRA_LOCAL_ONLY);
      await readJsonObject(req);
      sendJson(res, 200, await jiraCall(() => jira.start()));
      return;
    }
    if (path === '/api/setup/jira/site') {
      only('POST');
      keysAllowed(req, JIRA_LOCAL_ONLY);
      const body = await readJsonObject(req);
      sendJson(res, 200, await jiraCall(() => jira.pickSite(body.site)));
      return;
    }
    if (path === '/api/setup/jira/projects') {
      only('GET');
      sendJson(res, 200, await jiraCall(() => jira.projects()));
      return;
    }
    if (path === '/api/setup/jira/preview') {
      only('POST');
      const body = await readJsonObject(req);
      const attempt = startTry('jira-site');
      try {
        sendJson(res, 200, await jiraCall(() => jira.preview(body.jql)));
      } finally {
        attempt.done();
      }
      return;
    }
    if (path === '/api/setup/jira/statuses') {
      only('GET');
      sendJson(res, 200, await jiraCall(() => jira.statuses(query.get('project'))));
      return;
    }
    if (path === '/api/setup/jira/save') {
      only('POST');
      const body = await readJsonObject(req);
      const result = await jiraCall(() => jira.save(body));
      sendJson(res, 200, { ...result, configDirty: configDirty() });
      return;
    }
    if (path === '/api/setup/notify/save') {
      only('POST');
      const body = await readJsonObject(req);
      const result = await jiraCall(() => notify.save(body));
      sendJson(res, 200, { ...result, configDirty: configDirty() });
      return;
    }
    if (path === '/api/setup/notify/test') {
      only('POST');
      keysAllowed(req, NOTIFY_SCREEN.localOnly);
      await readJsonObject(req);
      sendJson(res, 200, await testNotify());
      return;
    }
    if (path === '/api/setup/salesforce/key') {
      if (req.method === 'GET') {
        sendJson(res, 200, await jiraCall(() => salesforce.key()));
        return;
      }
      if (req.method !== 'POST') throw new HttpError(405, 'Use GET or POST.', { allow: 'GET, POST' });
      keysAllowed(req, SF_WORDS.localOnly);
      const body = await readJsonObject(req);
      sendJson(res, 200, await jiraCall(() => salesforce.saveKey(body)));
      return;
    }
    if (path === '/api/setup/salesforce/connect') {
      only('POST');
      keysAllowed(req, SF_WORDS.localOnly);
      const body = await readJsonObject(req);
      // The limit starts once the inputs pass: a typo never costs a try.
      sendJson(res, 200, await jiraCall(() => salesforce.connect(body, { begin: () => startTry('sf-orgs') })));
      return;
    }
    if (path === '/api/setup/salesforce/org-id') {
      only('POST');
      keysAllowed(req, SF_WORDS.localOnly);
      const body = await readJsonObject(req);
      sendJson(res, 200, await jiraCall(() => salesforce.applyOrgId(body)));
      return;
    }
    if (path === '/api/setup/gearset/read') {
      only('POST');
      sendJson(res, 200, await readGearset(await readJsonObject(req)));
      return;
    }
    if (path === '/api/setup/gearset/save') {
      only('POST');
      const body = await readJsonObject(req);
      const result = await jiraCall(() => gearset.save(body));
      sendJson(res, 200, { ...result, configDirty: configDirty() });
      return;
    }
    if (path === '/api/setup/gearset/confirm') {
      only('POST');
      const body = await readJsonObject(req);
      sendJson(res, 200, await jiraCall(() => gearset.confirm(body, { stateDir })));
      return;
    }
    if (path === '/api/setup/claude/use-key') {
      only('POST');
      await readJsonObject(req);
      const isSet = (v) => typeof v === 'string' && v !== '';
      const hasKey = isSet(env.ANTHROPIC_API_KEY) || isSet(sessionKeys({ root, config }).ANTHROPIC_API_KEY);
      const at = now();
      const { result: r, warning } = await changeState('foreman dashboard claude use-key', () => useKey(stateDir, { now: at, hasKey }));
      sendJson(res, 200, warned({ ok: r.ok, lines: [r.line] }, warning));
      return;
    }
    if (path === '/api/setup/cloud/state') {
      only('POST');
      const body = await readJsonObject(req);
      const result = await jiraCall(() => cloud.stateBranch(body));
      sendJson(res, 200, { ...result, configDirty: configDirty() });
      return;
    }
    if (path === '/api/setup/cloud/workflow') {
      only('POST');
      const body = await readJsonObject(req);
      sendJson(res, 200, await jiraCall(() => cloud.workflow(body)));
      return;
    }
    if (path === '/api/setup/cloud/secrets') {
      only('POST');
      const body = await readJsonObject(req);
      sendJson(res, 200, await cloudTry(() => cloud.secrets(body)));
      return;
    }
    if (path === '/api/setup/cloud/secrets/set') {
      only('POST');
      keysAllowed(req, CLOUD_SCREEN.localOnly);
      const body = await readJsonObject(req);
      sendJson(res, 200, await cloudTry(() => cloud.setSecrets(body), (r) => r.ok === true && r.failed?.length === 0 && r.missing?.length === 0));
      return;
    }
    if (path === '/api/setup/cloud/runner-file') {
      only('POST');
      keysAllowed(req, CLOUD_SCREEN.localOnly);
      const body = await readJsonObject(req);
      sendJson(res, 200, await jiraCall(() => cloud.runnerFile(body)));
      return;
    }
    if (path === '/api/setup/cloud/runner-file/ignore') {
      only('POST');
      keysAllowed(req, CLOUD_SCREEN.localOnly);
      const body = await readJsonObject(req);
      sendJson(res, 200, await jiraCall(() => cloud.ignoreRunnerFile(body)));
      return;
    }
    if (path === '/api/setup/cloud/check') {
      only('POST');
      keysAllowed(req, CLOUD_SCREEN.localOnly);
      const body = await readJsonObject(req);
      sendJson(res, 200, await cloudTry(() => cloud.check(body), (r) => r.ok === true));
      return;
    }
    const stepCheck = /^\/api\/setup\/steps\/([^/]+)\/check$/.exec(path);
    if (stepCheck) {
      only('POST');
      await readJsonObject(req);
      sendJson(res, 200, await checkStep(stepCheck[1]));
      return;
    }
    if (path === '/api/help') {
      only('GET');
      sendJson(res, 200, helpBody());
      return;
    }
    throw new HttpError(404, 'Not found.');
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      const e = err instanceof HttpError ? err : new HttpError(500, 'The dashboard could not do that; see the run log.');
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const extra = {};
      if (e.status === 401) extra['www-authenticate'] = 'Bearer';
      if (e.status === 405 && e.allow !== undefined) extra.allow = e.allow;
      else if (e.status === 405) {
        const u = String(req.url);
        extra.allow = /^\/api\/settings(\?|$)/.test(u) ? 'GET, POST' : /^\/api\/waiting\/[^/]+\/details(\?|$)/.test(u) ? 'GET' : /^\/api\/(control|decisions\/|waiting\/|setup\/)/.test(u) ? 'POST' : 'GET';
      }
      if (e.status === 413) extra.connection = 'close';
      if (e.retryAfter !== undefined) extra['retry-after'] = String(e.retryAfter);
      const body = { error: e.message };
      if (e.retryAfter !== undefined) body.retryAfter = e.retryAfter;
      if (e.fix !== undefined) body.fix = e.fix;
      sendJson(res, e.status, body, extra);
      // A body too big is left unread; drain it so the client sees the answer.
      if (e.status === 413) req.resume();
    });
  });

  // Event streams never end on their own, so closing ends them first.
  const close = server.close.bind(server);
  server.close = (callback) => {
    for (const res of clients) res.end();
    clients.clear();
    stopWatching();
    jira.close();
    for (const child of runningChecks) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // the group is gone already
      }
    }
    close(callback);
    server.closeAllConnections();
    return server;
  };
  return server;
}

// Starts a dashboard and resolves with { server, url } once it listens, or rejects (a port in
// use, a host without a token). host and port default to config.console's. config: null starts
// it in set-up mode.
export async function startDashboard({ root, config, stateDir, env = process.env, now, host, port, sh, releaseWatch, briefWaitMs, fetchBrief }) {
  const options = { ...(config?.console ?? {}) };
  options.host = host ?? options.host ?? '127.0.0.1';
  options.port = port ?? options.port ?? 4317;
  const server = createDashboardServer({ root, config: config ? { ...config, console: options } : null, host: options.host, stateDir, env, now, ...(sh ? { sh } : {}), ...(releaseWatch ? { releaseWatch } : {}), ...(briefWaitMs !== undefined ? { briefWaitMs } : {}), ...(fetchBrief !== undefined ? { fetchBrief } : {}) });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const shown = options.host.includes(':') ? `[${options.host}]` : options.host;
  return { server, url: `http://${shown}:${server.address().port}/` };
}
