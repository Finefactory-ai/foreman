# Security

Foreman holds keys, runs agents with shell access and deploys code, so a security problem in it
matters more than a bug. Please report one privately.

## Reporting

Email hello@finefactory.ai with the subject "Foreman security". Say what you found, how to see
it, and which release you saw it on. We aim to reply within three working days, and to have a fix
or a stated plan within thirty.

Please do not open a public issue for a security problem, and do not test against a project,
org or account you do not own.

## What counts

Anything that lets a story's agents or an outsider do what Foreman is built to prevent:

- read a key from `.env.foreman`, the adapter env files or the set-up pages from inside a
  story session
- reach a production host, a Salesforce production org or an org that is not in the allow-list
- deploy, merge or release past a failed check, review or approval
- run a command the Bash guard should refuse
- see another project's state, tokens or conversations through the dashboard

## Supported releases

Fixes go into the latest release only. Install with the newest tag on the
[releases page](https://github.com/Finefactory-ai/foreman/releases).
