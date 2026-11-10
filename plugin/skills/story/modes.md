# Mode words

The supervisor may add a word after the id:

- `/foreman:story <ID> after-halt` — this story caused a halt the owner has since fixed. If
  its pull request merged and `foreman health --site` exits 0, close it (step 6, with the
  merged note). Otherwise take the failed path (`failed.md`) and stop with `failed`.
- `/foreman:story <ID> fresh` — the owner pressed Restart. Ignore the existing work: close
  its pull request if one is open (`gh pr close <n> --comment "Restarted from scratch"`),
  delete the old remote branch (`git push <remote> --delete <branch>`; ignore the failure
  when it is not there), delete the plan file if there is one, then
  `git checkout -B <branch> <remote>/<base>` and build from the start (step 3).
- `/foreman:story <ID> group-summary` (also spelled `phase-summary`) — the last story of
  <ID>'s group shipped. Do not start or end a story. Run `foreman story summary <ID>`, which
  prints `{ group, groupName, groupLabel, path, needed, stories }`. If `needed` is true, append to the
  file at `path` a section headed `## <groupLabel> <group> is finished` (both from that
  output) with what the group delivered, one line per story from its notes and
  pull request, and today's date. Then stop with `shipped`. If `needed` is false or the
  output is `{"none":true}`, write nothing and stop with `shipped`, saying there was
  nothing to write.
