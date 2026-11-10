Salesforce rules for every agent:

- Use `sf`, never `sfdx`.
- The slot org is the worktree's default org, so give no target-org flag. The one exception is the tester's dry run, under the tester's own rules.
- Never run `org login` or `org logout`, `sf project retrieve`, `deploy quick`, `--ignore-conflicts` or `--ignore-errors`.
- Never create, update or delete records in an org.
- Take the API version from `sfdx-project.json`.
- Production is never a target.
