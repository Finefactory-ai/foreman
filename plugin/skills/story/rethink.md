# The same kind of bug came back

The pipeline returned `rethink`: round `round` found a blocker or major finding of the same
kind as one sent back before, in this run or an earlier attempt. Another patch round would fix
one more case, so the story goes back to the architect to change the approach.

A result with `cause: "story"` means the builder found the plan or a Done-when line cannot hold
as written, so the builder got no further round. Step 2's file is then `{"round": <the result's round>,
"findings": <the result's kind, unchanged>, "cause": "story", "line": <the result's line, only
when it has one>}`, and step 3's note reads "The builder found Done-when <n> cannot hold; sent
back to the architect to correct it." Steps 1 and 4 are unchanged.

1. Add the result to the findings file (its findings and its history, as SKILL.md says).
2. Write the rethink file, `foreman-<slot>-<ID>-rethink.json` in the system temp folder, as
   `{"round": <the result's round>, "findings": <the result's kind, unchanged>}`.
3. Run `foreman workflow-args <ID> --rethink <rethink file>`. It prints args with no plan, so
   the architect designs again with every finding of that kind, and it tells the story "Round
   <n> found the same kind of bug again; sent back to the architect to change the approach."
4. Call the workflow with the object it printed (an object, not a string). Handle its result
   as step 3 of SKILL.md says. The result carries the new plan: save it with `foreman
   workflow-args <ID> --save-plan`. This launch never returns `rethink` again.
