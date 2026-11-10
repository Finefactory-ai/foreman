// Builds the args object the pipeline workflow takes (it cannot read files itself). `skills`
// lists each role's learned skills ({id, name, use, path}), as learnedSkillsByRole gives them.
// Each role's `model`, when the config sets one, passes through to the pipeline's agent() call.
// `filesHeld` says whether this slot has claimed every file the plan names (file-locks.mjs).
// `resume`, from a checkpoint (checkpoint.mjs resumePoint), is the finished build and approvals
// the pipeline carries on from; it goes with a plan. `designFile`, with a plan, is the path of
// the markdown copy of the plan's design and test plan (plan-file.mjs); the plan is then the short
// plan, and the agents read the file instead of getting the text in their prompts.
// `earlier`, when it is a non-empty list, is what the story was sent back for in earlier sessions
// (finding-history.mjs earlierFindings); `rethink`, when given, is {round, findings, cause?, line?}: the same kind of
// bug came back (or, with cause "story", the builder found the story cannot hold as written), and the
// architect designs again from these findings (it goes with no plan).

const withoutTraits = ({ traits, ...rest }) => rest;

export function workflowArgs({ story, briefPath, groupLabel, config, traits = {}, skills = {}, holds = [], filesHeld = false, plan, designFile, startAt, findings, earlier, rethink, resume }) {
  const r = config.roles;
  const roles = {
    architect: withoutTraits(r.architect),
    builders: Object.fromEntries(Object.entries(r.builders).map(([k, b]) => [k, withoutTraits(b)])),
    tester: withoutTraits(r.tester),
    reviewers: r.reviewers.map(withoutTraits),
  };
  return {
    story: { id: story.id, title: story.title, brief: briefPath, group: story.group, groupName: story.groupName, groupLabel },
    // The stages diff against where the branch left this, never a local base branch,
    // which a worktree does not keep up to date.
    base: `${config.remote}/${config.baseBranch}`,
    rounds: config.rounds,
    roles,
    checks: config.checks,
    resources: Object.fromEntries(Object.entries(config.resources ?? {}).map(([name, v]) => [name, v.describe])),
    holds,
    filesHeld,
    traits,
    skills,
    ...(plan === undefined ? {} : { plan }),
    ...(designFile === undefined ? {} : { designFile }),
    ...(startAt === undefined ? {} : { startAt }),
    ...(findings === undefined ? {} : { findings }),
    ...(Array.isArray(earlier) && earlier.length > 0 ? { earlier } : {}),
    ...(rethink === undefined ? {} : { rethink }),
    ...(resume === undefined ? {} : { resume }),
  };
}
