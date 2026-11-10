# Ship exit 10

- **10** — the change deletes Salesforce metadata the owner has not allowed; nothing was
  pushed and nothing halted. The branch stays committed. The JSON's `deletes` lists them,
  each `{"type", "member"}`.
  - When the JSON has `keepOut: true`, the owner asked for no deletes. Write the fix file
    with one `blocker` finding: `stage: "release"`, `rule: "no metadata deletes"`, `where`
    the JSON's deletes as "<type> <member>", `observed` the JSON's `reason`, and `fix`
    "keep these components; the owner wants nothing deleted in this story". Run a
    fix round (`fix-round.md`), then `foreman checks --changed`, a new commit, and ship again. A second
    exit 10 with `keepOut` takes the failed path (`failed.md`).
  - Otherwise the owner must allow them. Go back, run
    `foreman story block <ID> --reason "Waiting for the owner to allow deletes"`, then ask:

        foreman decide add --story <ID> --kind decision --title "Allow deletes for <ID>?" --summary '<n> component(s) would be deleted: <the first few as "<type> <member>">' --body '<each deletes entry as "<type> <member>", one per line>' --option "Allow the deletes" --hint "Lets the story delete the listed Salesforce components, then ships it again." --option "Keep them out" --hint "Sends the story back to be built without deleting anything." --recommend '<Allow the deletes when the story asks to remove those components, else Keep them out>' --purpose '<what this story is for, in plain words>' --happened '<what the release would remove, in plain words>' --recommendation '<the recommended option, then why, in plain words>'

    Say it in your reply and stop with `blocked`. The answer is applied as `answers.md`
    says.
