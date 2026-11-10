# The project's own Foreman files

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
bookkeeping commands run from your slot and act on the project, as SKILL.md says. Never unset or change `FOREMAN_RUN`,
`FOREMAN_PROJECT_DIR` or `FOREMAN_STATE_DIR` for this. For example
`(cd "$scratch" && foreman settings set workers 1)`.
