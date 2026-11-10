# Agent-events hook: golden replies

These fixtures pin what the agent-events hook (`plugin/lib/hooks/agent-events.mjs`) says to
Claude Code. The goldens are the exact stdout bytes Claude Code reads from the hook. Every case
also expects exit code 0 and an empty stderr, and a stdout that is empty or exactly one compact
JSON object. The test is `plugin/lib/hooks/agent-events-contract.test.mjs`; it runs the command
from `plugin/hooks/hooks.json` as a real process, with the case's JSON on stdin.

## Layout

- `cases.json`: the list of cases, each `{ name, event, run, why }`. `event` is the hooks.json
  event whose command runs the case; `run` is true when `FOREMAN_RUN=1` is set, false when it is
  unset.
- `<name>.stdin`: the exact bytes piped to the hook.
- `<name>.stdout`: the golden, the exact stdout. It has no trailing newline, so write it with
  `printf`, never with an editor that adds one.
- `foreman.config.json`: the sample project "Acme", copied into the temp project. Its smoke URL
  makes `app.acme.example` a production host.

In both files the token `<PROJECT>` stands for the canonical path of the temp project the test
creates (JSON-escaped), because the real path differs from machine to machine.

## Changing a golden

A golden changes only on purpose, when the hook's reply must change. Name the Claude Code hooks
documentation (https://code.claude.com/docs/en/hooks) that the new shape comes from in the
commit.

A new event in `plugin/hooks/hooks.json` needs a case here, or the coverage test fails.
