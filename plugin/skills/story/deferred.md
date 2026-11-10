# The pipeline returned deferred

- **`deferred`** — the plan needs exclusive resources this slot does not hold (`needs`
  names them; only one story at a time may hold each), names files this slot has not
  claimed (`files`; two stories running at once never change the same file), or both. Run
  `foreman lock take <resource> <ID>` for each resource in `needs`. When one cannot be
  taken: `foreman lock release <resource>` for every resource this run took, go back,
  delete `<branch>` only when it has no commits ahead, run `foreman story todo <ID> --note
  "waiting for <resource> to be free"`, and stop with `deferred`.
  When every one is taken and `files` is not empty, run
  `foreman lock files <ID> --plan <plan file>`. The plan file is `<state folder>/plans/<ID>.json`:
  when the result carried a `plan`, save it first with `foreman workflow-args <ID> --save-plan`,
  as SKILL.md says; when it carried none, an earlier session saved it and `workflow-args` reused
  it, so it is already there. It prints one line of JSON and exits:
  - **0** — this slot holds every file. Go on.
  - **7** — another running story is changing some of those files, or they are kept for a
    higher-priority story that waited for them; the JSON's `reason` names it and them.
    Release every resource this run took, go back, delete `<branch>` only when it has no commits
    ahead, run `foreman story todo <ID> --note '<reason>'`, and stop with `deferred`, passing the same reason to `foreman story end deferred ""
    '<reason>'`. The reason holds file paths, so it goes in single quotes, with each `'`
    written as `'\''`, as the quoting rule in SKILL.md says. The story is picked again once
    those files are free.
  - **anything else** — release every resource this run took, go back, run `foreman story
    block <ID> --reason 'Could not claim the files: <the first line of its stderr>'`, and stop
    with `failed`. Only the first line goes in: it says what went wrong without local paths.
    The reason goes in single quotes, with each `'` written as `'\''`, as the quoting rule in
    SKILL.md says.
  With every resource taken and the files claimed (when there were any), run `foreman
  workflow-args <ID> --plan <plan file>` and call the workflow again with the object it
  printed, so the architect does not run twice. The plan reaches the agents by file: never
  paste it into the call, and the result carries none to save.
