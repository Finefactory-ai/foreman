export const meta = {
  name: 'pipeline',
  description: 'Take one story through architect, build, test and review',
  whenToUse: 'Run by the foreman skill with the args `foreman workflow-args <id>` prints: {story: {id, title, brief, group, groupName, groupLabel?}, base?, rounds, roles: {architect: {agent, model?}, builders: {<name>: {agent, use, model?, fullChecks?}}, tester: {agent, model?}, reviewers: [{name, agent, prompt?, model?, engine?: {name, model, minutes?}}]}, checks: [{run, when, quick?}], resources: {<name>: <describe>}, holds: [<resource names this slot holds>], filesHeld?: <true when this slot has claimed every file the plan names>, traits: {<role>: <text>}, skills?: {<role>: [{id, name, use, path}]}, plan?, designFile?: <path of the design and test plan, with plan holding only ready, builder, resources, files, done_when>, startAt?: "fix", findings?, earlier?: [{stage, severity, rule, where, observed, fix, round?, at?}], rethink?: {round, findings, cause?: "story", line?}, resume?: {build: {summary, files}, verdicts?: {tester?: {findings}, <reviewer name>?: {findings}}}}. Leaves the reviewed change uncommitted in the working tree. Returns the plan with passed and failed, for a later fix round, and with deferred, only when the architect ran in that launch (a plan given in args is not returned). Returns deferred, with the plan, the resources it needs (needs) and the files it names (files), when the plan needs a resource the slot does not hold or names files the slot has not claimed (filesHeld not true). With startAt "fix", plan and findings ({stage, severity, rule, where, observed, fix}), it skips the architect and starts with a fix round, so a change made after review is reviewed again. With resume and a plan (a session stopped before it finished), it skips the architect and the build, takes resume.build as built, and in round 1 does not run again the tester and reviewers given in verdicts (a verdict counts only when all its findings are minor, a reviewer\'s only with the tester\'s). A string args or {file} is refused with one line: the JSON object itself is the args. Every result also returns history: [{round, findings}], the stopping findings each round sent back to be fixed. A builder with fullChecks true is told to run the full checks, not the quick ones, in its build and fix prompts. A role\'s model, when set, is passed to agent(); unset, the agent runs on the session\'s model. earlier is the story\'s blocker and major findings from earlier sessions, oldest first: the tester and reviewers see them as [E1], [E2] and so on, and a finding of theirs may carry repeats, the id of an earlier finding it is another case of (the same mistake in a new form). When a blocker or major finding in a round is the same kind of bug as an earlier one (the same file and rule, or its repeats names one), the pipeline stops patching and returns {status: "rethink", id, round, builder, reason, kind: [every finding of that kind, earlier ones too], findings, history}, with no plan: the foreman runs the pipeline again with rethink: {round, findings: the kind} and no plan, so the architect designs a new approach (its plan then carries approach, one or two sentences on why the new approach ends the whole kind) and the builder reads the approach first. A build with complete false and blocked_by "story" (the plan or a Done-when line cannot hold) returns {status: "rethink", cause: "story", line?, round, kind: [the builder\'s finding], findings, history} with no fix round, only where a same-kind rethink is allowed. rethink: {round, findings, cause: "story"} then gives the architect a `## Correct the story` section, and its plan carries approach. A launch with rethink, startAt, or a plan that carries an approach never returns rethink. There, a build with blocked_by "story" returns {status: "failed", cause: "story", line?, rounds, reason, findings: [the builder\'s finding], history} at once, with no fix round. Without earlier or rethink the prompts are unchanged. A reviewer with an engine is relayed to that CLI by the foreman:review-relay agent (`foreman review`); when the relay answers engine "unavailable", the reviewer\'s own agent runs instead.',
  phases: [
    { title: 'Architect', detail: 'can it be built now; design and test plan' },
    { title: 'Build', detail: 'tests first, then the implementation; fix rounds land here' },
    { title: 'Test', detail: 'independent re-run of every check and the Done-when line' },
    { title: 'Review', detail: 'every configured reviewer, side by side' },
  ],
}

// Everything project-specific arrives in args, because a workflow script cannot read files.
// `foreman workflow-args <id>` builds them from foreman.config.json.
const fail = (what) => {
  throw new Error(`pipeline needs ${what} (args: {story: {id, title, brief, group, groupName, groupLabel?}, base?, rounds, roles, checks, resources, holds, filesHeld?, traits, skills?, plan?, designFile?, startAt?, findings?, earlier?: [{stage, severity, rule, where, observed, fix}], rethink?: {round, findings, cause?}, resume?})`)
}
// A string (the JSON quoted, or retyped) and {file} (a script reads no file) are refused in one line
// that names the fix, before fail()'s long signature.
if (typeof args === 'string') throw new Error('pipeline args is a string: pass the JSON object `foreman workflow-args <id>` printed as args itself, not quoted')
if (args && typeof args === 'object' && Object.hasOwn(args, 'file') && !args.story) throw new Error('pipeline cannot read files: pass the JSON object `foreman workflow-args <id>` printed as args, not {file}')
if (!args || typeof args !== 'object') fail('args')
const story = args.story
if (!story || typeof story !== 'object') fail('args.story')
if (!story.id) fail('args.story.id')
if (!story.brief) fail('args.story.brief, the path of the story file')
const roles = args.roles
if (!roles || typeof roles !== 'object') fail('args.roles')
if (!roles.architect || !roles.architect.agent) fail('args.roles.architect.agent')
if (!roles.tester || !roles.tester.agent) fail('args.roles.tester.agent')
if (!roles.builders || Object.keys(roles.builders).length === 0) fail('at least one builder in args.roles.builders')
const reviewers = roles.reviewers || []
if (!Array.isArray(reviewers) || reviewers.some((r) => !r || !r.name || !r.agent)) fail('args.roles.reviewers as [{name, agent, prompt?}]')
// A story gets this many build attempts (the first build plus the fix rounds) before the
// factory gives up on it and hands it to the owner.
const ROUNDS = args.rounds
if (!Number.isInteger(ROUNDS) || ROUNDS < 1) fail('args.rounds, a whole number of at least 1')
if (args.startAt !== undefined && args.startAt !== 'fix') fail('args.startAt to be "fix" when set')
// designFile: the markdown copy of the plan's design and test plan, which the agents read; the
// plan in args is then the short one (plan-file.mjs).
if (args.designFile !== undefined && (typeof args.designFile !== 'string' || !args.designFile)) fail('args.designFile to be the path of the design file when set')
if (args.designFile !== undefined && !args.plan) fail('args.plan when designFile is set')
if (args.startAt === 'fix' && !args.plan) fail('args.plan when startAt is "fix"')
if (args.startAt === 'fix' && (!Array.isArray(args.findings) || args.findings.length === 0)) fail('args.findings when startAt is "fix"')
// resume: the build and the approvals a stopped session had finished, from its checkpoint.
const resume = args.resume
if (resume !== undefined) {
  if (!resume || typeof resume !== 'object') fail('args.resume to be an object when set')
  if (!args.plan) fail('args.plan when resume is set')
  if (args.startAt !== undefined) fail('args.resume without startAt')
  if (!resume.build || typeof resume.build.summary !== 'string' || !Array.isArray(resume.build.files)) fail('args.resume.build as {summary, files}')
}
// earlier: what the story was sent back for in earlier sessions. rethink: the findings of one kind of
// bug that came back, for the architect to design an approach that ends it.
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
if (args.earlier !== undefined && (!Array.isArray(args.earlier) || !args.earlier.every(isPlainObject))) fail('args.earlier as [{stage, severity, rule, where, observed, fix}]')
const rethink = args.rethink
if (rethink !== undefined) {
  if (!isPlainObject(rethink) || !Number.isInteger(rethink.round) || rethink.round < 1 || !Array.isArray(rethink.findings) || rethink.findings.length === 0 || !rethink.findings.every(isPlainObject)) {
    fail('args.rethink as {round, findings}: a whole number of at least 1 and a non-empty list of findings')
  }
  if (rethink.cause !== undefined && rethink.cause !== 'story') fail('args.rethink.cause to be "story" when set')
  if (args.plan || args.startAt !== undefined || resume !== undefined) fail('args.rethink without plan, startAt or resume')
}

const builders = roles.builders
const resources = args.resources || {}
const holds = args.holds || []
const filesHeld = args.filesHeld === true
const checks = args.checks || []
const traits = args.traits || {}
const skills = args.skills || {}
const resourceNames = Object.keys(resources)
// A role's model goes into its agent() options only when set, so an unset role runs on the
// session's model and its options carry no model key at all.
const withModel = (role, opts) => (typeof role.model === 'string' && role.model ? { ...opts, model: role.model } : opts)

const DESIGN = {
  type: 'object',
  required: ['ready', 'blocker', 'needs_owner', 'builder', 'resources', 'files', 'design', 'test_plan', 'done_when'],
  properties: {
    ready: { type: 'boolean', description: 'true only if the whole story can be built now' },
    blocker: { type: 'string', description: 'empty when ready; otherwise what is missing, starting with story ids when stories block it' },
    needs_owner: { type: 'boolean', description: 'true when only the owner can clear the blocker' },
    builder: { type: 'string', enum: Object.keys(builders) },
    resources:
      resourceNames.length === 0
        ? { type: 'array', maxItems: 0, items: { type: 'string' } }
        : {
            type: 'array',
            items: { type: 'string', enum: resourceNames },
            description: `the exclusive resources this story needs, empty when none. ${resourceNames
              .map((name) => `${name}: ${resources[name]}`)
              .join('; ')}`,
          },
    files: {
      type: 'array',
      items: { type: 'string' },
      description:
        'every file this story will create, change or delete, tests included, as paths from the repository root; no folders or globs. Foreman claims them before the build, and a story running at the same time that names one waits until this one ships',
    },
    design: { type: 'string', description: 'what changes, file by file, and what must not' },
    test_plan: { type: 'string', description: 'each behaviour and the test that proves it' },
    done_when: { type: 'string', description: "the story's Done-when line as a check someone can run" },
    owner_question: {
      type: 'object',
      required: ['summary', 'options', 'recommend'],
      description: 'only when ready is false, needs_owner is true and the owner must choose between options; leave it out otherwise',
      properties: {
        summary: { type: 'string', description: 'the question in one line, at most 160 characters' },
        options: {
          type: 'array',
          minItems: 2,
          items: {
            type: 'object',
            required: ['label', 'hint'],
            properties: {
              label: { type: 'string' },
              hint: { type: 'string', description: 'what choosing it does, at most 100 characters' },
            },
          },
        },
        recommend: { type: 'string', description: 'the label of the option you recommend' },
        explain: {
          type: 'object',
          required: ['purpose', 'happened', 'recommendation'],
          description: 'the question in plain words for an owner who has not read the code; the technical detail stays in blocker',
          properties: {
            purpose: { type: 'string', description: 'what the story is for; plain words, at most 280 characters, no file paths or variable names' },
            happened: { type: 'string', description: 'what is unclear; plain words, at most 280 characters, no file paths or variable names' },
            damage: { type: 'string', description: 'only when something outside the story was touched: what was checked; plain words, at most 280 characters, no file paths or variable names' },
            recommendation: { type: 'string', description: 'the option you recommend and why; plain words, at most 280 characters, no file paths or variable names' },
          },
        },
      },
    },
  },
}

const BUILD = {
  type: 'object',
  required: ['complete', 'summary', 'files', 'commands', 'problem'],
  properties: {
    complete: { type: 'boolean', description: 'true only if everything is built and every check you ran passed' },
    summary: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    commands: {
      type: 'array',
      items: {
        type: 'object',
        required: ['command', 'passed'],
        properties: { command: { type: 'string' }, passed: { type: 'boolean' } },
      },
    },
    problem: { type: 'string', description: 'empty when complete; otherwise what does not work or what you disagree with' },
    blocked_by: { type: 'string', enum: ['code', 'story'], description: 'only when complete is false. "story" when the plan or a Done-when line cannot hold as written, so no code change can meet it; "code" for anything else: unfinished work, a failing or flaky check, a finding you could not fix' },
    done_when_line: { type: 'integer', minimum: 1, description: 'only with blocked_by "story", when one Done-when line is the cause: its number, counting from 1' },
  },
}

const VERDICT = {
  type: 'object',
  required: ['approved', 'findings', 'checked'],
  properties: {
    approved: { type: 'boolean', description: 'true only with no blocker and no major finding' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'rule', 'where', 'observed', 'fix'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          rule: { type: 'string' },
          where: { type: 'string', description: 'file:line' },
          observed: { type: 'string' },
          fix: { type: 'string' },
          repeats: { type: 'string', description: 'only when this finding is another case of the same kind of bug as an earlier finding listed in the prompt: that finding\'s id, such as E2' },
        },
      },
    },
    checked: { type: 'string', description: 'what you ran or read, and what you observed' },
  },
}

// What the review relay answers: the engine's verdict, or `engine: "unavailable"` with the reason.
const RELAY = {
  ...VERDICT,
  required: [...VERDICT.required, 'engine'],
  properties: {
    ...VERDICT.properties,
    engine: { type: 'string', enum: ['antigravity', 'unavailable'] },
    reason: { type: 'string' },
  },
}
// The relay only copies text and runs foreman, so it runs on a cheap model (state.mjs sets the
// same RELAY_MODEL; test/workflow.test.mjs checks the two match).
const RELAY_MODEL = 'sonnet'

const groupLabel = story.groupLabel || 'Group'
const hasGroup = story.group !== undefined && story.group !== null && String(story.group) !== ''
// base is the remote base branch the story's branch left, such as origin/main.
const base = args.base
const header = [
  `Story ${story.id} · ${story.title}`,
  ...(hasGroup ? [`${groupLabel} ${story.group} — ${story.groupName}`] : []),
  `Story note: ${story.brief}`,
  ...(base ? [`Base: ${base}. The change is the working tree against where this branch left it: \`git status\` and \`git diff --merge-base ${base}\`.`] : []),
].join('\n')

const describe = (findings) =>
  findings
    .map((f) => `- [${f.stage} · ${f.severity}] ${f.rule} — ${f.where}\n  Observed: ${f.observed}\n  Fix: ${f.fix}`)
    .join('\n')

// A stage that died or was skipped has not approved anything.
const verdictOf = (stage, v) =>
  v
    ? { approved: v.approved, findings: v.findings.map((f) => ({ ...f, stage })) }
    : {
        approved: false,
        findings: [{ stage, severity: 'blocker', rule: 'stage did not report', where: '-', observed: `The ${stage} stage returned nothing.`, fix: 'Run the stage again.' }],
      }

// The same kind of bug. A finding is another case of an earlier one when it is the same file and the
// same rule (the rule's wording normalised as learn.mjs normaliseRule does), or when the reviewer
// marked it with the earlier finding's id in `repeats`. Only the tester's and the reviewers' findings
// are compared: a build, checks, merge or release finding is not a kind of bug.
const normRule = (rule) =>
  String(rule ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'`“”‘’]+/, '')
    .replace(/[\s.,;:!?"'`“”‘’]+$/, '')
    .trim()
    .toLowerCase()
const fileOf = (where) => {
  const first = String(where ?? '').trim().split(/[\s,;()]+/)[0] ?? ''
  const file = first.replace(/^[`'"]+|[`'"]+$/g, '').replace(/^\.\//, '').replace(/(?::\d+(?:-\d+)?)+$/, '')
  return file === '' || file === '-' ? null : file
}
const comparable = (f) => !!f && (f.stage === 'tester' || reviewers.some((r) => r.name === f.stage))
const sameFileAndRule = (a, b) => comparable(a) && comparable(b) && fileOf(a.where) !== null && fileOf(a.where) === fileOf(b.where) && normRule(a.rule) !== '' && normRule(a.rule) === normRule(b.rule)
const repeatsOf = (f) => {
  const m = /^E(\d+)$/.exec(String(f.repeats ?? '').trim().toUpperCase())
  return m ? Number(m[1]) - 1 : -1
}
const withoutRepeats = ({ repeats, ...rest }) => rest

// Every blocker and major finding this story was sent back for before, in this launch's earlier
// sessions and (growing) in this launch's own rounds. known[i] is E<i+1>.
const known = []
const knownKeys = new Set()
for (const f of [...(args.earlier || []), ...(rethink ? rethink.findings : [])]) {
  const item = withoutRepeats(f)
  const key = [item.stage, item.severity, item.rule, item.where, item.observed].join('|')
  if (knownKeys.has(key)) continue
  knownKeys.add(key)
  known.push(item)
}
const matchesKnown = (c, i) => comparable(c) && comparable(known[i]) && (repeatsOf(c) === i || sameFileAndRule(c, known[i]))

// The findings of the kind: every finding that links to a matched one by file and rule or by a repeats mark.
const kindOf = (stopping) => {
  const all = [...known, ...stopping]
  const parent = all.map((_, i) => i)
  const find = (i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]]
    return i
  }
  const link = (a, b) => {
    parent[find(a)] = find(b)
  }
  all.forEach((a, i) => {
    for (let j = i + 1; j < all.length; j++) if (sameFileAndRule(a, all[j])) link(i, j)
    const r = repeatsOf(a)
    if (r >= 0 && r < known.length && comparable(a) && comparable(known[r])) link(i, r)
  })
  const roots = new Set(stopping.map((c, k) => [c, known.length + k]).filter(([c]) => known.some((_, i) => matchesKnown(c, i))).map(([, i]) => find(i)))
  return all.filter((_, i) => roots.has(find(i))).map(withoutRepeats)
}

// The project's checks, the role's traits and its learned skills go at the end of every
// prompt, so the text above them reads the same for every project.
const CHECKS_NOTE =
  "`foreman checks` runs these and records every run. Run them only through it, with the flags your instructions give (for a long suite, `--start` and then `foreman checks --wait <id>`). Foreman denies a check's command run by hand; targeted runs of single tests stay free.\n"
const checksText =
  checks.length === 0
    ? ''
    : `\n\n## Checks\n${CHECKS_NOTE}${checks
        .map((c) => `- \`${c.run}\` ${!c.when || c.when === 'always' ? '(every time)' : `(when files matching ${c.when} changed)`}${c.quick ? `, quick: \`${c.quick}\`` : ''}`)
        .join('\n')}`
// A role's learned skills are copied into the slot by the supervisor; the prompt lists them.
const skillsOf = (role) => (Array.isArray(skills[role]) ? skills[role] : [])
const skillsText = (role) =>
  skillsOf(role).length === 0
    ? ''
    : `\n\n## Learned skills\nSkills Foreman learned by itself. Before doing the kind of work a skill's use-when names, read its SKILL.md and follow it unless CLAUDE.md or the Project traits say otherwise.\n${skillsOf(role)
        .map((k) => `- ${k.name} [${k.id}]: ${k.use} (\`${k.path}\`)`)
        .join('\n')}`
// A builder with fullChecks true runs the full checks while it builds: the note goes before the
// checks, only in the builder's build and fix prompts.
const FULL_CHECKS_NOTE =
  '\n\nThis project runs the full checks in the build: run `foreman checks --changed` (for a long suite `foreman checks --changed --start`, then `foreman checks --wait <id>`) instead of `--quick`, while you build and before you hand over.'
const fullNote = (b) => (b && b.fullChecks === true ? FULL_CHECKS_NOTE : '')
const extras = (role) => `${checksText}${traits[role] ? `\n\n## Project traits\n${traits[role]}` : ''}${skillsText(role)}`

// When any role has learned traits (traits.mjs puts them under this heading) or learned
// skills, the tester and the reviewers are asked to name a bad one. The heading is written out here because a
// workflow script imports nothing; test/workflow.test.mjs checks the two copies match.
const LEARNED_HEADING = 'Learned by Foreman (CLAUDE.md and the traits above win)'
const anyLearned = Object.values(traits).some((t) => String(t).includes(LEARNED_HEADING)) || Object.keys(skills).some((role) => skillsOf(role).length > 0)
const learnedNote = anyLearned
  ? "\n\nSome agents follow rules Foreman learned by itself, tagged [L-n]. When a learned rule is wrong, or conflicts with CLAUDE.md or the project's own traits, raise a finding and put its [L-n] in the rule."
  : ''

const builderList = `\n\n## Builders\n${Object.entries(builders)
  .map(([name, b]) => `- ${name}: ${b.use}`)
  .join('\n')}`

// The reviewer's own prompt, or today's defaults: security has its own, every other
// reviewer gets the compliance text.
const reviewPrompt = (r) =>
  r.prompt ||
  (r.name === 'security'
    ? base
      ? `Review this story's changes: the working tree against where this branch left ${base} (\`git status\`, \`git diff --merge-base ${base}\`, untracked files included). Grade each finding blocker, major or minor.`
      : "Review this story's changes: the working tree against main (`git status`, `git diff main`, untracked files included). Grade each finding blocker, major or minor."
    : "Review this story's changes against the plan and the project's rules.")

// One reviewer's verdict. A reviewer with an engine goes to the relay first, which hands the
// same review text to that CLI through `foreman review`; when the relay says the engine is
// unavailable (not installed, no verdict, out of time), or answers nothing, the reviewer's own
// agent runs as it would have.
const review = async (r, round, built) => {
  const text = `${built}\n\n${reviewPrompt(r)}${learnedNote}${extras(r.name)}`
  const label = `${r.name}:${story.id}#${round}`
  if (r.engine && r.engine.name) {
    const relayed = await agent(
      `Relay this review for the reviewer "${r.name}" to its engine: write the text between the markers to a file byte for byte, then run \`foreman review --start --reviewer ${r.name} --prompt <file> --chars ${text.length}\` and \`foreman review --wait <id>\` until it answers. Do not review the change yourself.\n\n<<<REVIEW\n${text}\n>>>REVIEW`,
      { agentType: 'foreman:review-relay', label, phase: 'Review', schema: RELAY, model: RELAY_MODEL },
    )
    if (relayed && relayed.engine && relayed.engine !== 'unavailable') {
      return { approved: relayed.approved, findings: relayed.findings, checked: relayed.checked }
    }
    log(`${story.id}: the ${r.engine.name} engine was unavailable for the ${r.name} reviewer (${(relayed && relayed.reason) || 'the relay answered nothing'}); running its own agent`)
  }
  return agent(text, withModel(r, { agentType: r.agent, label, phase: 'Review', schema: VERDICT }))
}

// A story whose architect ran in this launch comes back with its plan, so the architect does not
// run twice; the foreman saves it (`foreman workflow-args <id> --save-plan`). A plan given in args
// is not returned: the foreman already has it as a file.
const planned = !args.plan
let plan = args.plan
if (!plan) {
  phase('Architect')
  // A story that came back for the same kind of bug gets the whole kind, and a schema that asks why the
  // new approach ends it; a retried story gets every earlier finding. The label stays the same, so the
  // checkpoint and --save-plan find the newest plan.
  const storyRethink = !!rethink && rethink.cause === 'story'
  const approachSchema = {
    type: 'string',
    description: storyRethink
      ? 'one or two sentences: what in the plan or the Done-when line could not hold, and what the corrected plan changes'
      : 'one or two sentences: why the new approach ends the whole kind of bug, not one more case',
  }
  const design = rethink ? { ...DESIGN, required: [...DESIGN.required, 'approach'], properties: { ...DESIGN.properties, approach: approachSchema } } : DESIGN
  const architectHistory = storyRethink
    ? `\n\n## Correct the story\nRound ${rethink.round}'s builder found that the story cannot hold as written, so it comes back to you instead of going to more build rounds. What the builder found:\n${describe(rethink.findings)}\n\nCheck the evidence against the code. When it shows the plan or a Done-when line is wrong, correct them: write a design, test plan and \`done_when\` the builder can meet, keeping the work already in the working tree (say what to keep). When only the owner can decide what the story should prove, return \`ready: false\` with \`needs_owner: true\` and an \`owner_question\`. Say in \`approach\`, in one or two sentences, what could not hold and what you changed.`
    : rethink
    ? `\n\n## Change the approach\nRound ${rethink.round} found the same kind of bug again, so the story comes back to you instead of getting one more patch round. Every finding of that kind so far, across all attempts:\n${describe(rethink.findings)}\n\nEach fix so far handled one more case and the reviewers found another. Design an approach that ends this whole kind of bug, not one that handles one more case. The working tree holds the build that kept failing: say what to keep, replace and remove. Say in \`approach\`, in one or two sentences, why the new approach closes the whole kind (for example "fail closed on anything not proven" rather than "handle form X").`
    : known.length > 0
      ? `\n\n## Earlier findings\nThis story was built before and sent back. Every blocker and major finding so far, across all attempts:\n${describe(known)}\n\nDesign so that none of them comes back. Where several are the same kind of bug, change the approach instead of handling one more case.`
      : ''
  plan = await agent(
    `${header}

Decide whether this story can be built now and, if it can, write the design and test plan
its builder will follow.${architectHistory}${builderList}${extras('architect')}`,
    withModel(roles.architect, { agentType: roles.architect.agent, label: `architect:${story.id}`, schema: design }),
  )
}

if (!plan) return { status: 'failed', id: story.id, reason: 'The architect stage returned nothing.', rounds: 0, findings: [], history: [] }
if (!plan.ready) {
  log(`${story.id} cannot be built now: ${plan.blocker}`)
  // owner_question, when the architect gives one, is the choice the story skill asks the owner.
  return {
    status: 'blocked',
    id: story.id,
    reason: plan.blocker,
    needs_owner: plan.needs_owner,
    ...(plan.owner_question ? { owner_question: plan.owner_question } : {}),
    rounds: 0,
    findings: [],
    history: [],
  }
}

const builder = Object.hasOwn(builders, plan.builder) ? builders[plan.builder] : null
if (!builder) {
  log(`${story.id}: the architect chose an unknown builder, ${plan.builder}`)
  return { status: 'failed', id: story.id, reason: `The architect chose an unknown builder: ${plan.builder}`, rounds: 0, findings: [], history: [] }
}

// One story at a time per exclusive resource, and per file. Without every resource it needs
// and a claim on every file it names, nothing is built yet: the foreman takes them and runs
// this again with the plan, or defers. A plan with no files claims none.
const needs = (plan.resources || []).filter((name) => !holds.includes(name))
const files = Array.isArray(plan.files) && plan.files.length > 0 && !filesHeld ? plan.files : []
if (needs.length > 0 || files.length > 0) {
  if (needs.length > 0) log(`${story.id} needs ${needs.join(', ')} and this slot does not hold ${needs.length === 1 ? 'it' : 'them'}`)
  if (files.length > 0) log(`${story.id} names ${files.length} file${files.length === 1 ? '' : 's'} this slot has not claimed`)
  return { status: 'deferred', id: story.id, ...(planned ? { plan } : {}), needs, files, rounds: 0, findings: [], history: [] }
}

// With a designFile the design and the test plan are read from it, so a long plan never travels
// in args or prompts.
const designFile = args.plan && args.designFile ? args.designFile : null
const designText = designFile
  ? `## Design and test plan
Read ${designFile} whole before you do anything else. It holds the architect's design and test plan for this story; follow it as if it were written here.`
  : `${typeof plan.approach === 'string' && plan.approach.trim() ? `## Approach\n${plan.approach}\n\n` : ''}## Design
${plan.design}

## Test plan
${plan.test_plan}`
const brief = `${header}

${designText}

## Done when
${plan.done_when}`

const fix = (findings, round) =>
  agent(
    `${brief}

This story was built and sent back. Fix every finding below in the current working tree,
re-run the checks, and say for each one what you changed.

## Findings
${describe(findings)}${fullNote(builder)}${extras(plan.builder)}`,
    withModel(builder, { agentType: builder.agent, label: `fix:${story.id}#${round}`, phase: 'Build', schema: BUILD }),
  )

// A carried verdict counts only when every finding in it is minor, and a reviewer's only when
// the tester's counts: reviewing is done on code the tester approved.
const onlyMinor = (v) => !!v && Array.isArray(v.findings) && v.findings.every((f) => f && f.severity === 'minor')
const given = (resume && resume.verdicts) || {}
const carriedTester = resume && onlyMinor(given.tester) ? given.tester : null
const carried = Object.fromEntries(carriedTester ? reviewers.filter((r) => onlyMinor(given[r.name])).map((r) => [r.name, given[r.name]]) : [])

// startAt "fix": the change is already built (CI or a merge sent it back), so round 1
// tests a fix instead of a fresh build. resume: it was built before the session stopped.
let build
if (resume) {
  build = { complete: true, summary: resume.build.summary, files: resume.build.files, commands: [], problem: '' }
} else {
  phase('Build')
  build =
    args.startAt === 'fix'
      ? await fix(args.findings, 0)
      : await agent(
          `${brief}

Build this story in the current working tree, tests first.${fullNote(builder)}${extras(plan.builder)}`,
          withModel(builder, { agentType: builder.agent, label: `build:${story.id}`, schema: BUILD }),
        )
}

// The earlier findings the tester and the reviewers are shown, each with the id a finding of theirs
// can name in `repeats`; nothing at all when the story has none.
const earlierSection = () =>
  known.length === 0
    ? ''
    : `\n\n## Earlier findings\nFindings this story was sent back for before, in this run or an earlier attempt:\n${known
        .map((k, i) => `- [E${i + 1}] [${k.stage} · ${k.severity}] ${k.rule} — ${k.where}\n  Observed: ${k.observed}`)
        .join('\n')}\n\nWhen a finding of yours is another case of the same kind of bug as one of these (the same mistake in a new form, even in other words or another place), set its \`repeats\` to that id, such as "E2". Leave \`repeats\` out otherwise.`

// A launch that is a fix after review, a rethink, or built on a rethought plan never goes back to the
// architect again, so a story goes back at most once in a session.
const rethinkAllowed = args.startAt === undefined && !rethink && !(typeof plan.approach === 'string' && plan.approach.trim())

let open = []
// The stopping findings each round sent back to be fixed, so the ones the builder then fixed
// are not lost. The last round is never here: on a fail its findings are `findings`.
const history = []
for (let round = 1; round <= ROUNDS; round++) {
  open = []
  if (!build || !build.complete) {
    open.push({
      stage: 'build',
      severity: 'blocker',
      rule: 'the build is not complete',
      where: '-',
      observed: build ? build.problem : 'The build stage returned nothing.',
      fix: 'Finish the story and make every check pass.',
    })
  } else {
    const built = `${brief}

## What the builder says it did
${build.summary}
Files: ${build.files.join(', ')}${earlierSection()}`

    // Round 1 of a resume reuses the verdicts carried over; later rounds run every stage.
    const reuse = round === 1 && !!resume
    const test =
      reuse && carriedTester
        ? verdictOf('tester', { approved: true, findings: carriedTester.findings })
        : verdictOf(
            'tester',
            await agent(
              `${built}\n\nDecide whether this story works. Trust nothing above that you have not checked yourself.${learnedNote}${extras('tester')}`,
              withModel(roles.tester, {
                agentType: roles.tester.agent,
                label: `test:${story.id}#${round}`,
                phase: 'Test',
                schema: VERDICT,
              }),
            ),
          )
    open.push(...test.findings)

    // Reviewing code the tester has just rejected is wasted work: it is about to change.
    if (test.approved && reviewers.length > 0) {
      const toRun = reuse ? reviewers.filter((r) => !Object.hasOwn(carried, r.name)) : reviewers
      const verdicts =
        toRun.length === 0
          ? []
          : await parallel(toRun.map((r) => () => review(r, round, built)))
      reviewers.forEach((r) => {
        const i = toRun.indexOf(r)
        open.push(...verdictOf(r.name, i === -1 ? { approved: true, findings: carried[r.name].findings } : verdicts[i]).findings)
      })
    }
  }

  const stopping = open.filter((f) => f.severity !== 'minor')
  if (stopping.length === 0) {
    return {
      status: 'passed',
      id: story.id,
      rounds: round,
      builder: plan.builder,
      summary: build.summary,
      files: build.files,
      done_when: plan.done_when,
      findings: open,
      history,
      ...(planned ? { plan } : {}),
    }
  }
  // A builder that says the plan or a Done-when line cannot hold gets no fix round: no code change can
  // meet it, so the story goes back to the architect, once, as for the same kind of bug.
  const storyBlocked = !!build && build.complete !== true && build.blocked_by === 'story'
  if (storyBlocked) {
    const line = Number.isInteger(build.done_when_line) && build.done_when_line >= 1 ? build.done_when_line : undefined
    const evidence = build.problem || 'The builder gave no evidence.'
    if (rethinkAllowed) {
      const found = {
        stage: 'build',
        severity: 'blocker',
        rule: 'the story cannot hold as written',
        where: '-',
        observed: evidence,
        fix: 'Correct the plan or the Done-when line the builder names, or ask the owner what the story should prove.',
      }
      log(`${story.id} round ${round}: the builder found the story cannot hold as written; back to the architect to correct it`)
      return {
        status: 'rethink',
        id: story.id,
        round,
        builder: plan.builder,
        cause: 'story',
        ...(line ? { line } : {}),
        reason: line ? `Round ${round}: the builder found Done-when ${line} cannot hold as written.` : `Round ${round}: the builder found the story cannot hold as written.`,
        kind: [found],
        findings: [found],
        history,
      }
    }
    // The story has been corrected already, or this is a fix round: another retry meets the same wall.
    const found = {
      stage: 'build',
      severity: 'blocker',
      rule: 'the story cannot hold as written',
      where: '-',
      observed: evidence,
      fix: 'The architect has already corrected the story once; the owner decides what the story should prove, or takes it over.',
    }
    const corrected = !!rethink || (typeof plan.approach === 'string' && plan.approach.trim() !== '')
    const subject = line ? `Done-when ${line}` : 'the story'
    const reason = corrected
      ? line
        ? `Round ${round}: the builder still found Done-when ${line} cannot hold after the architect corrected the story.`
        : `Round ${round}: the builder still found the story cannot hold after the architect corrected it.`
      : `Round ${round}: the builder still found ${subject} cannot hold as written, in a fix round after review.`
    log(`${story.id} round ${round}: the builder still finds the story cannot hold as written; ending without more build rounds`)
    return {
      status: 'failed',
      id: story.id,
      reason,
      rounds: round,
      builder: plan.builder,
      cause: 'story',
      ...(line ? { line } : {}),
      findings: [found],
      history,
      ...(planned ? { plan } : {}),
    }
  }
  if (rethinkAllowed && stopping.some((c) => known.some((_, i) => matchesKnown(c, i)))) {
    log(`${story.id} round ${round}: the same kind of bug came back; back to the architect to change the approach`)
    return {
      status: 'rethink',
      id: story.id,
      round,
      builder: plan.builder,
      reason: `Round ${round} found the same kind of bug again.`,
      kind: kindOf(stopping),
      findings: stopping,
      history,
    }
  }
  if (round === ROUNDS) break

  log(`${story.id} round ${round}: sent back with ${stopping.length} finding(s)`)
  history.push({ round, findings: stopping })
  known.push(...stopping)
  build = await fix(stopping, round)
}

return {
  status: 'failed',
  id: story.id,
  reason: `Still rejected after ${ROUNDS} build rounds.`,
  rounds: ROUNDS,
  builder: plan.builder,
  findings: open.filter((f) => f.severity !== 'minor'),
  history,
  ...(planned ? { plan } : {}),
}
