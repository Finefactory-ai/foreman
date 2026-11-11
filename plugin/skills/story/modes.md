# Mode words

The supervisor may add a word after the id:

- `/foreman:story <ID> after-halt` — this story caused a halt the owner has since fixed; the
  run cleared it only after `foreman health` passed. Act on what is true now, never on the
  earlier run's failure text: its blocked reason, its ship JSON and any earlier decision may be
  stale. When the story JSON has `rolledBackAt` and its pull request merged before that time
  (`resume.md` says how to tell), the release was rolled back: do not close it, and ask the
  owner nothing. Follow `resume.md`'s rolled-back paragraph: when `<branch>` is missing or holds
  only the merged work, it builds the story again from scratch and has you go to step 3; when
  `<branch>` holds the new build's own work, it keeps that work. Otherwise, if its pull request
  merged and `foreman health --site` exits 0, close it (step 6, with the merged note).
  Otherwise the release did not go through: go back, run
  `foreman story block <ID> --reason '<what is true now: the pull request is not merged, or the
  health JSON's reason>'`, with the reason in single quotes and each `'` inside written as
  `'\''`, as the quoting rule in SKILL.md says, and stop with `failed`, ending with that
  reason. A release failure
  must never take the failed path (`failed.md`) or be filed as "could not pass review": file no
  decision yourself, because the supervisor asks the owner "<ID> could not be released" from
  the reason you end with.
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
