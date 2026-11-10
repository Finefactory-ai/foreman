---
name: init
description: Set Foreman up in this project: detect the stack, hand set-up to the Set up page (foreman setup), or walk it in the chat when the machine has no browser.
---

# Foreman: set up this project

You are setting Foreman up in the project you are in. The Set up page (`foreman setup`) walks
every step, keys included. Your part is to detect the stack, ask a pack's own questions, give
the owner the page, and walk the same steps in the chat only when there is no browser.

## Rules

- Ask one question at a time, and wait for the answer before the next. Offer the detected
  value as the default, so a plain "yes" is enough.
- Never ask for the value of a key, password or token in the chat, and never write one into
  any file or command line.
- Keys go in only on the Set up page's key cards, or with `foreman keys set` and the key's
  name. The owner runs that in a terminal of their own, in the project folder, and pastes the
  value into it; it reads the value hidden.
- Never name or open an env file.
- Take every word you show the owner about a step from the set-up model
  (`foreman setup steps --step <id> --json`, `foreman setup next`). Pass those lines on in
  plain words and add no instructions of your own.

## Steps

1. Run `foreman init detect`. It prints one JSON line: `suggested` (a starting config) and
   `found` (what it saw). When `found.pack` is set, say which pack claimed the project and
   show `found.packFindings` as plain lines (for example "package folders: force-app"), not
   JSON. When `found.packErrors` is present, mention each one in a line (the pack and its
   message) and carry on. If `foreman.config.json` already exists, say so and go to step 3:
   set-up never replaces it.
2. If `found.pack` is set, this is a `<pack>` project, and the Set up page has no screen for
   the pack's block, so the config is written here:
   1. Run `foreman setup steps --step project --json`. It prints every step: take
      the entry in `steps` whose id is `project`, and ask the fields of its `form.fields`, one
      at a time: the field's `label` as the question, its `help` under it, and its `options`
      for a choice. Ask only the fields whose `when` matches the answers so far, and offer the
      detected values as defaults. The pack section may say which fields to skip.
   2. Follow the `## Pack: <name>` section under Packs below and ask the pack's own questions,
      one at a time. If there is no section for the pack, ask no extra questions.
   3. Build the config from `suggested` plus the answers: the stories block
      `{ "adapter": "markdown", "dir": "<folder>" }` or
      `{ "adapter": "jira", "site": "<host>", "jql": "<filter>" }`, `project.name`, and the
      pack's block, the top-level key named like the pack (for pack `acme`,
      `"acme": { ... }`). Keep `"pack"` from `suggested`, and leave out what the pack section
      says to leave out.
   4. Pipe it to `foreman init write`. It validates the config, writes `foreman.config.json`,
      enables the plugin, adds the state folder to `.gitignore` and, for markdown stories,
      adds an example story. If it prints errors, ask again for what each names, and write
      again.
   5. Do the pack section's "After the write" steps, in order (for salesforce:
      `foreman sf skills`, and the org sign-in that the set-up step from
      `foreman setup steps --step sf-orgs --json` walks during the hand-off).
3. Hand-off. Start `foreman setup` with the Bash tool and `run_in_background: true`. After a
   few seconds, read its `Set up: <url>` line, or relay its error in plain words. Give the
   owner the link, and say the page walks every step, keys included. Then ask one question:
   did the page open, or does this machine have no browser? When the owner says the page shows
   every step done, stop the background `foreman setup` and go to step 5.
4. **No browser.** Stop the background `foreman setup`. Then:
   1. If no config was written yet, ask the project form's fields as in step 2.1, and pipe the
      answers as one JSON object (`name`, `source`, `dir`, `site`, `jql`, `check`, `ci`) to
      `foreman init write --answers`. It writes the same file the Set up page does. If it
      prints errors, ask again for the field each error names, and write again.
   2. Run `foreman setup next` and give the owner its lines, one at a time, in plain words.
   3. When the step needs a key, run `foreman setup steps --step <id> --json`, where <id> is
      the id of the step `foreman setup next` named (it prints `Next:` and the step's title;
      the step's entry has the same `title`). It prints every step: take
      the entry in `steps` whose id is <id>, and find its `inputs` with `kind: 'key'`. Ask the
      owner to run, in a terminal of their own in the project folder, with the key's name in
      place of NAME:
      `foreman keys set <NAME>`
      Wait until they say it is done.
   4. Run `foreman setup next` again, and loop. Stop when it prints `All set`.
5. Run `foreman doctor`. For each FAIL, explain in plain words what is wrong and what to do,
   from its own fix line. Warnings only need a mention.
6. Finish with how to start: `/foreman:story <id>` to build one story by hand, or
   `/foreman:run` to let Foreman work through the stories on its own. Later,
   `foreman traits add <role> "<text>"` adds a rule for one agent (the role is `tester`,
   `all`, or a builder role named in the config).

## Packs

A pack is Foreman's support for one kind of project. Each pack adds its own
`## Pack: <name>` section here, with the questions step 2 asks for that pack.

## Pack: salesforce

A Salesforce DX project: `sfdx-project.json` is at the root.

**What to show.** Show `found.packFindings` as plain lines, never JSON: the package folders
(and which one is the default), `sourceApiVersion`, the LWC tools found (jest, eslint,
prettier), whether OmniStudio metadata was found, and whether Agentforce metadata was found.
If the findings say `invalid`, `sfdx-project.json` is broken: say so and carry on.

**The questions.** Ask these one at a time, in this order. They fill the `"salesforce"`
block. Never ask for a password, key or token, and never connect to an org.

1. **Sandboxes.** The sandboxes Foreman may use: the alias and org ID of each. The org ID is
   in Setup > Company Information, or in the output of `sf org display` when the owner runs
   it. An org ID starts with `00D` and is 15 or 18 letters and digits. An alias is letters,
   digits, ".", "_", "@" or "-", and does not start with "-". An alias may not be `prod` or
   `production`, and two aliases may not share an org ID (the first 15 characters are
   compared). If a value does not fit, say why and ask again. This writes
   `orgs: { "<alias>": { "orgId": "..." } }`.
2. **Branches.** One branch, or environment branches (for example `qa` and `uat`)?
   - One branch: ask which branch. Default: `main`. This writes `baseBranch`; leave it out
     for `main`.
   - Environment branches: nothing is written here.
3. **Production deploys.** Single-branch layout only. Ask exactly:
   "Does anything deploy <branch> to production: a CI job, Gearset or another tool?"
   - If yes: stop and explain that this layout needs environment branches, because every
     merge into <branch> would reach production. Then ask question 2 again. If they still
     want one branch, stop init without writing anything.
   - If no: go on.
4. **Build sandboxes.** Which of the question 1 sandboxes build stories. This writes `build`:
   the alias as a string when there is one, else a list of aliases. If a build sandbox will
   also receive releases (every sandbox is a build sandbox, or they plan to use one as the
   first stage), say this means one story at a time and only that one build sandbox.
5. **Release stages.** One to four stages, in release order. Each has a name, an org from
   question 1 and, in the environment-branch layout only, a branch (default: the stage
   name). A name is a lowercase letter, then up to 15 lowercase letters or digits.
   Never offer production as a stage. Say why and ask again for any of these:
   - a stage named prod or production (production is never a target);
   - a name used twice;
   - two stages on one org;
   - a build sandbox on any stage but the first;
   - a build sandbox as the first stage while more than one sandbox builds.

   Every sandbox from question 1 must build stories or be a stage's org: Foreman
   keeps only the orgs a step uses. If one is neither, say so and ask whether to use it or
   drop it from `orgs`.

   This writes `stages: [{ "name": "...", "org": "...", "branch": "..." }]`. In the
   single-branch layout, leave `branch` out.
6. **Production branch.** Environment-branch layout only, and required there. The branch that
   holds what is in production. Default: `main`. It must not be any stage's branch, because
   nothing merges into production. This writes `productionBranch`. In the single-branch
   layout, skip this question and never write `productionBranch`.
7. **Release path.** How changes reach the stages after review:
   - `sf` (default): Foreman deploys with `sf`.
   - `ci`: the repo's own CI deploys after the merge, and Foreman watches it.
   - `gearset`: Gearset promotes the environment branches. Offer it
     only with environment branches and when no stage is on a build sandbox.

   DevOps Center is not supported yet. This writes `release`; leave it out for `sf`.
8. **Where to stop.** Ask only when there is more than one stage. Offer the stage names;
   the default is the last stage. This writes `stopAt`; leave it out for the last stage.
   Production is never a target: do not offer it, and if they ask for it, say Foreman never
   deploys to production.

**The general questions.** From the project form, ask only the name and the story source
(with its folder, or its Jira site and filter); skip the check command and the CI jobs. Tell
the owner the pack sets the checks, the install step, the ship steps and the pull request
target from the release path, that every CI check on the pull request must pass, and that
`foreman config show` prints them all. Set `slots` to the number of build sandboxes,
because each slot leases one sandbox: 1 when the first stage shares a build sandbox, and
leave it out when it is 1. Never ask about or write `test`: the default, `build`, is right.

**The config.** Leave out `ship`, `checks` and `install`, and `roles`, even though
`suggested` has some of them: the pack fills them, and a file's own `ship` replaces the
pack's as a whole and loses the pull request target, so the write is refused. The shape,
with sample values for Acme (environment branches, one build sandbox, QA then UAT):

```json
{
  "version": 1,
  "project": { "name": "acme" },
  "pack": "salesforce",
  "stories": { "adapter": "markdown", "dir": "stories" },
  "salesforce": {
    "productionBranch": "main",
    "orgs": { "acme-dev1": { "orgId": "00D000000000001" }, "acme-qa": { "orgId": "00D000000000002" }, "acme-uat": { "orgId": "00D000000000003" } },
    "build": "acme-dev1",
    "stages": [{ "name": "qa", "org": "acme-qa", "branch": "qa" }, { "name": "uat", "org": "acme-uat", "branch": "uat" }]
  }
}
```

**After the write**, in this order:

1. The pack brings its own traits for every agent, the security reviewer and the tester, so add
   none of them with `foreman traits add`.
2. Run `foreman sf skills`. It installs the pinned Salesforce skills. On success, tell the
   owner to commit `skills-lock.json`, `.agents/skills` and `.claude/skills`. If its last
   line is `{ "ok": false, "reason": ... }`, give the reason in plain words and carry on;
   the doctor reports it again.
3. Never log in to an org, and never run `sf org login` yourself. The owner signs each
   configured org in to Foreman's own sf home, with its alias from the config, on the set-up
   step `sf-orgs` (Set up › Salesforce org sign-in) during the hand-off, so story sessions
   never see the owner's other orgs. Its words come from
   `foreman setup steps --step sf-orgs --json`; with no browser, `foreman setup next` gives
   them in turn. Never ask for the key file or the consumer key. The doctor (step 5) then
   checks that each org is signed in, is a sandbox, and has the configured org ID.
