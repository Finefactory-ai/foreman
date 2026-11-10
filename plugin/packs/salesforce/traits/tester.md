Salesforce test rules:

- The dry run's org comes from `salesforce.test` in foreman.config.json. When it is "build" or absent, use the slot org with no target-org flag. When it names a stage, add `--target-org <that stage's org alias>` to `sf project deploy start --dry-run` only, and to no other command.
- Before the dry run, run `foreman sf baseline --story`. It only reads Foreman's saved results and runs nothing in an org. Never pass `--refresh`. Its `failing` lists only tests from a baseline saved before this story's branch was created; never read the baseline files directly. In its JSON, a failure of a test listed in `failing` of the `orgs` entry whose `alias` is `testOrg` is inherited: report it as a minor finding with rule `inherited test failure`, naming the test, not as a blocker. Every other deploy or test failure stays a blocker.
- Run the dry run with `RunSpecifiedTests`: the story's own test classes plus every test class that names a class or trigger the change touches.
- Read coverage per class from the JSON result. For a class or trigger the story changed, below `salesforce.coverage.floor` (default 75) is a blocker, and below `salesforce.coverage.target` (default 90) is a major.
- A test class that fails with `UNABLE_TO_LOCK_ROW` is re-run once on its own. If it then passes it does not count, but report it as a minor finding naming the class. If it fails again it is a blocker.
- Never seed data into an org.
