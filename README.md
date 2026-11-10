# Foreman

An autonomous story-to-production pipeline for Claude Code. Foreman picks the next story
whose dependencies are done and runs it through five stages:

1. An **architect** designs it.
2. A **builder** writes the tests first, then the code.
3. An independent **tester** re-runs everything.
4. **Reviewers** check it side by side.

A story gets a set number of build rounds. When review finds the same kind of bug a second time, the story goes back to the architect to change the approach instead of getting one more patch. When the builder finds that the story itself cannot be met as written, the story goes back to the architect once to correct the plan or the Done-when line, instead of using up its build rounds; if the builder still finds it cannot be met, the story stops and asks you. Once it passes, Foreman commits it and ships it:
pull request, CI, merge. It can build several stories at once, each in its own git
worktree, and it releases them one at a time.

Foreman is a Claude Code plugin. Everything about your project lives in one file,
`foreman.config.json`, or behind a small adapter: the story source, the slot environment,
the ship steps, the notifier and the console.

## Install

```
/plugin marketplace add finefactory-ai/foreman#v0.11.0
/plugin install foreman@foreman
```

Then run `/foreman:init` in your project. The user guide is at
[finefactory.ai/apps/foreman/docs](https://finefactory.ai/apps/foreman/docs/), and the dashboard's
Help link opens it.

Foreman's home is [finefactory.ai/apps/foreman](https://finefactory.ai/apps/foreman/), with a page
on [Foreman for Salesforce](https://finefactory.ai/apps/foreman/salesforce/).

## Before you run it

Foreman runs AI agents unattended, with your keys. It can change, merge and deploy code and
call the services you connect. You decide what it can reach: use least-privilege tokens, branch
protection, backups and a target that is not production until you trust it, and review what it
ships.

Foreman runs on your machines and sends none of your code or data to us. What it sends to Claude,
GitHub, Jira, Salesforce and the other services you connect is between you and them, including
any personal data in your stories and records.

Foreman is provided as is, without warranty, as the [LICENSE](LICENSE) says. Nothing in the
licence limits liability that cannot be limited by law.

## Getting help

1. Run `foreman doctor`. It finds and explains most set-up problems and says what to do.
2. Read the [user guide](https://finefactory.ai/apps/foreman/docs/). Every command, setting and screen is in it.
3. Still stuck, or Foreman did something wrong?
   [Open an issue](https://github.com/Finefactory-ai/foreman/issues/new/choose). The bug form
   asks for the version, where Foreman runs and the doctor output, so a fix can start at once.
4. For a security problem, keys, the production guard or anything an attacker could use, follow
   [SECURITY.md](SECURITY.md) instead of opening a public issue.
5. For anything else, email [hello@finefactory.ai](mailto:hello@finefactory.ai).

Fixes ship in the next release and are named in [CHANGELOG.md](CHANGELOG.md).

## Licence

Foreman is free to use, change and share, at work included, under the
[Functional Source License](LICENSE) (FSL-1.1-ALv2). You may not offer it, or something built
from it, to others as a commercial product or service that replaces Foreman or does much the same job.
If you share it, keep the licence and copyright notices. Two years after a release is published,
that release also becomes available under the Apache License 2.0.

We claim no rights in the code Foreman writes in your projects. The files Foreman copies in from
itself, such as agents and templates, stay under this licence. A copy of the licence is installed
with the plugin. This is a summary; the LICENSE file governs.

Foreman is made by Peak Force Limited, trading as finefactory.ai. Claude Code, GitHub, Jira,
Salesforce and Gearset are trade marks of their owners, and Foreman is not affiliated with or endorsed by
them. To send a fix or an idea, see [CONTRIBUTING.md](CONTRIBUTING.md).

## What's here

```
plugin/                  everything that installs
  .claude-plugin/        plugin manifest
  skills/                /foreman:story, /foreman:run, /foreman:init
  agents/                architect, builder, tester, compliance-reviewer, security-reviewer,
                         review-relay (hands a review to another CLI);
                         sf-architect, sf-admin, sf-developer, sf-agentforce, sf-tester,
                         sf-code-reviewer for the Salesforce pack
  workflows/pipeline.js  the stage loop: architect → build → test → review
  hooks/                 agent activity → run state
  bin/foreman            the CLI
  lib/                   config, engine (supervisor, picking, locks, ship), adapters, console,
                         setup (the set-up steps behind `foreman setup` and doctor's fix lines)
  packs/                 the pack registry: extra steps, env adapters, checks and defaults a
                         project turns on with `"pack"` in its config. It ships the salesforce
                         pack: detect, config block and defaults, doctor checks (among them
                         that CI workflows deploy Foreman's branches only to orgs in
                         salesforce.orgs; doctor cannot see where a CI secret points), Bash guard,
                         ship steps that include `ci` only when a workflow runs on pull requests
                         into the PR target (a repo with none never waits on a check),
                         `foreman sf`, the isolated sf home that keeps story sessions to
                         the configured orgs, two slot environments (sandbox-pool: a build
                         sandbox per slot; scratch: a scratch org per story from the Dev
                         Hub, within its daily limit, deleted once the story closes), and
                         traits for every agent, the security
                         reviewer and the tester, and the ship steps: sf-org-guard (only
                         allow-listed sandboxes as deploy targets, a production org marked
                         "production": true never a deploy target and reached only by the
                         allow-listed commands, never a pull request into production),
                         sf-delta (the sfdx-git-delta manifests; metadata deletes wait for
                         the owner's `foreman sf deletes allow`), sf-validate (a dry run on
                         stage 1's org before the merge), sf-deploy-<stage> (an async
                         deploy after the merge, which resumes from the stored job ID),
                         sf-verify-<stage> (the org's newest deploy is Foreman's, plus the
                         post-deploy checks; feeds `foreman health`; after a fix by hand,
                         `foreman sf fixed <stage>` records the branch head so the halt can
                         clear; on a later stage such as UAT, both run after the story
                         branch is merged into the stage's own branch, and a failure there
                         halts and never rolls back), `foreman sf rollback`
                         (stage 1 only: reverts the merge and deploys the reverse delta; the
                         sf path's ship.rollback.command), and gearset-pr (on the gearset path, built but not yet proven on a live
                         pipeline: opens the pull request and waits for Gearset's validation
                         on the promotion PR it opens; needs GEARSET_API_TOKEN)
.claude-plugin/          marketplace.json (points at plugin/)
runner/                  the container runner: Dockerfile, compose and Fly examples, guide
test/                    cross-module tests
examples/plain-node/     the smallest config, with a story and a tester trait
```

## Develop

`npm test` runs the unit tests. Node built-ins and vitest only. It runs vitest's two projects at
the same time: `waits`, the files that mostly wait on child processes (a child supervisor, git
against a local remote, the hook or sf wrapper run for real, the fake Atlassian), and `unit`, all
the others. The two share the machine's cores: one worker per core in all, a third for `unit` and
the rest for `waits`. Each one's output is printed when it ends. On macOS, `npm test` puts the
real git (`xcrun --find git`) ahead of /usr/bin, whose git is a launcher that starts it on every
call. `npm test -- <file>` runs one plain `vitest run <file>`. A test that takes over 5 s fails,
unless `test/slow-tests.mjs` lists it with the reason it waits. When the machine has more runnable
processes than cores, the 5 s stretches with the load (load 36 on 18 cores gives 10 s);
`SLOW_TEST_LIMIT_MS` sets an exact limit instead. A test over the limit fails only when the
machine is idle (under 0.5 load per core); on a busy machine it is printed as a
`slow-test guard warning:` line instead. `SLOW_TEST_GUARD=report npm test` prints every slow test
as a warning and fails none; use it for checks that must not fail on a slow test alone, such as
the checks Foreman runs on each story. A plain `npm test` stays strict. `TEST_WAIT_SCALE=3 npm test`
stretches the waits and time limits of the tests that run a real supervisor three times, for a loaded
machine such as a CI runner; values under 1 are ignored.

The Docker slot environment also has a test against real Docker (needs Docker with Compose and free ports 8100-8300): `FOREMAN_DOCKER_IT=1 npm test`.

The dashboard page also has a test in a real browser (needs Chrome or Chromium; set CHROME_PATH to pick one): `FOREMAN_BROWSER_IT=1 npm test`.

The installed plugin is a copy keyed by `version` in `plugin/.claude-plugin/plugin.json`, so bump
the version for a release. While developing, reinstall the plugin in your test project
instead.
