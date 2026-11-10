# Explaining a decision

The owner reads each decision on the Waiting on you board without having read the code, so
every `foreman decide add --kind decision` in this skill carries five parts, written by you
in plain words:

1. **What this story is for** (`--purpose`): from the story's title and the What section of
   its story note (the `ref` in `foreman story next --id <ID>`).
2. **What happened** (`--happened`): what went wrong, or what is unclear.
3. **Is anything damaged?** (`--damage`): only when the run touched something outside the
   story; say what was checked and what was found. Leave it out otherwise.
4. **Your options**: a `--hint` per option, one line on what happens if the owner picks it.
5. **Recommendation** (`--recommend` with the option's label, plus `--recommendation`):
   starts with that label, then says why, in one line.

Each part is one or two short sentences, at most 280 characters. No file paths,
variable names, function calls or jargon in them: the technical detail goes in `--body`,
which the card keeps under Details. The parts are text you wrote, so they go in single quotes like
other pasted text (the quoting rule in SKILL.md). A `warning:` line from `decide add` means the
item was still added: do not add it again, and write the next one plainer.

For example, the review failure of story ACME-12,
"Keep the factory's own keys out of story workspaces", reads on the board:

    What this story is for: Keep Foreman's own keys in a separate file that the building agents never see.
    What happened: The reviewers found one serious problem: a test step could change the real project's key file instead of a throwaway copy.
    Is anything damaged? No. The real key file was checked afterwards and is unchanged.
    Your options:
    - Retry with a note to the architect: the story is designed and built again, with your note on what to fix.
    - I'll take it: you finish the story yourself, and Foreman leaves it alone until you hand it back.
    - Drop: Foreman closes the story's pull request, deletes its branch and stops working on it.
    Recommendation: Retry with a note to the architect: the fix is small and clear, and nothing was damaged.

The technical finding (the variable name, the file name, the check that was missing) stays in
the body, under Details.
