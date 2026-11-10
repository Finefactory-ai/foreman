// `foreman workflow-args <id> [--plan <file>] [--start-at fix --findings <file>]` prints the
// args the pipeline workflow takes, as one line of JSON. The config is read fresh, with the
// local settings layer on top, so a `rounds` change applies to the next story. The traits
// include Foreman's learned ones unless `learning.apply` is off, and so do the skills: each
// role's learned skills that the slot folder (the cwd) holds, as the supervisor copied them.
// The learned ids given, traits and skills, are noted on the slot's story for its run record.
// With --plan, `filesHeld` says whether this slot holds every file the plan claims (`foreman lock
// files`); a plan whose files are all left out, or which names none, holds them all. Without
// --plan it is false. By hand (no FOREMAN_SUPERVISOR_PID), with --plan, it is true when every
// claimable file has a lock naming this slot and this story, live or not, because the lock's pid
// is the exited `foreman lock files` process. So a by-hand run builds only after `foreman lock
// files` claimed the files. Under the supervisor the check is holdsFiles: a live holder in this slot.
// After a session stopped without a result (the watchdog, a crash), the supervisor leaves a
// checkpoint of the stages its agents finished (checkpoint.mjs). Without --start-at, when there
// is one, the args carry its plan (unless --plan gives one; filesHeld is then worked out for
// whichever plan is used) and, when the slot's working tree is still the one it saw, `resume`:
// the finished build and approvals, so the pipeline skips the architect, the build and every
// stage already approved. A note naming the stages kept goes to stderr.
// The plan goes by file (plan-file.mjs), because a Workflow-tool script reads no file and a plan
// retyped into its args is slow and can be miswritten. With a plan (--plan, or the checkpoint's),
// the args carry the short plan (ready, builder, resources, files, done_when) and `designFile`,
// the path of a markdown copy of the design and test plan that the agents read; both files are
// written to <state folder>/plans first (the .json one is the plan the story skill reuses), and
// the args stay the same size however long the design is. filesHeld is worked out on the full plan.
// Without --plan and without a checkpoint, the plan an earlier session saved (<state folder>/
// plans/<id>.json) is reused when it is still current: it records the base commit it was written
// against (`baseCommit`, stamped when a plan is first written), and none of the files it names
// changed on <remote>/<base> since (plan-file.mjs planStaleness). A stale plan, or one from before
// base commits were recorded, is left alone and the architect runs again; stderr says which.
// While the review engine is out of quota (review-engine.mjs readEngineDown), the reviewers'
// `engine` is left out of the args, so the pipeline runs their Claude agents without a relay.
// `foreman workflow-args <id> --save-plan` saves the architect's plan without anyone retyping it:
// it reads the architect's own answer from the transcripts of the session in this slot, writes
// both files and prints the path of the JSON one. It builds no args. When the slot's session has
// no ready plan for the story, or the plan files cannot be written (a plans folder it cannot write
// to, say), it exits 1 with one line naming the file to write by hand.
// Whenever the plan files are written (--save-plan, or the args of a plan), the design is also
// recorded on the story itself when features.jiraComments is on, or salesforceComments for a Case
// (engine/story-notes.mjs): once per design, and a changed plan as a revision. A failure there is at most a warning on stderr and
// never changes stdout or the exit code.
// Every story's blocker and major findings from findings.jsonl (finding-history.mjs earlierFindings)
// go in the args as `earlier`, so the pipeline can tell when review finds the same kind of bug again
// and the architect of a retried story sees what the earlier attempts were sent back for. A saved plan
// is not reused when the story failed review after the plan was written (finding-history.mjs
// failedSince): the architect runs again, with that history.
// `foreman workflow-args <id> --rethink <file>` is the launch after the pipeline returned `rethink`.
// The file is {round, findings, cause?, line?}: the round and the result's `kind` (the story skill writes
// it), and, when the builder found the story cannot hold as written, `cause: "story"` and the result's
// `line` (the Done-when line it named, when it named one). The args carry it as `rethink` and no plan:
// neither the checkpoint nor the saved plan is used, so the architect designs a new approach, or with
// cause "story" corrects the plan and the Done-when line. The story is told in its notes that it went back to the architect only once
// the args are built, just before they are printed: a launch that exits 1 tells the story nothing.
// Failing to say so is a warning on stderr and nothing else. It cannot be combined with --plan, --start-at,
// --findings or --save-plan. A file that is not a rethink file exits 1 with one line naming it.
// Warnings go to stderr, never stdout.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { adoptLegacySchemaLock, holdsResource } from '../../engine/locks.mjs';
import { claimedFiles, holdsFiles } from '../../engine/file-locks.mjs';
import { planFiles, supervisorPid } from './lock.mjs';
import { currentSlot } from '../../engine/paths.mjs';
import { noteLearned } from '../../engine/state.mjs';
import { loadResolved } from '../../settings/load.mjs';
import { openStorySource } from '../../engine/story-source.mjs';
import { learnedSkillsByRole } from '../../engine/slot-prepare.mjs';
import { resolveTraits, roleNames } from '../../engine/traits.mjs';
import { workflowArgs } from '../../engine/workflow-args.mjs';
import { PLAN_FILE, planStaleness, readPlanFile, sessionPlan, shortPlan, stampPlan, writePlanFiles } from '../../engine/plan-file.mjs';
import { readEngineDown } from '../../engine/review-engine.mjs';
import { readCheckpoint, resumePoint, worktreeTree } from '../../engine/checkpoint.mjs';
import { noteOnStory } from '../../engine/story-notes.mjs';
import { earlierFindings, failedSince, rethinkNote, rethinkOf } from '../../engine/finding-history.mjs';
import { readFindingsLines } from '../../engine/run-record.mjs';
import { designData } from '../../engine/story-notes-queue.mjs';

const USAGE = 'usage: foreman workflow-args <id> [--plan <file>] [--start-at fix --findings <file>]\n       foreman workflow-args <id> --save-plan\n       foreman workflow-args <id> --rethink <file>\n';

export default {
  name: 'workflow-args',
  summary: 'print the pipeline workflow args for a story (workflow-args <id>)',

  async run(args, { root, env, cwd, stderr, stdout, now }) {
    let parsed;
    try {
      parsed = parseArgs({ args, allowPositionals: true, options: { plan: { type: 'string' }, 'start-at': { type: 'string' }, findings: { type: 'string' }, 'save-plan': { type: 'boolean' }, rethink: { type: 'string' } } });
    } catch (err) {
      stderr.write(`${err.message}\n${USAGE}`);
      return 1;
    }
    const { values, positionals } = parsed;
    const [id] = positionals;
    if (!id || positionals.length > 1) {
      stderr.write(USAGE);
      return 1;
    }
    if (values['start-at'] !== undefined && values['start-at'] !== 'fix') {
      stderr.write('--start-at must be "fix"\n');
      return 1;
    }
    if (values['save-plan'] && (values.plan !== undefined || values['start-at'] !== undefined || values.findings !== undefined)) {
      stderr.write(USAGE);
      return 1;
    }
    if (values.rethink !== undefined && (values['save-plan'] || values.plan !== undefined || values['start-at'] !== undefined || values.findings !== undefined)) {
      stderr.write(USAGE);
      return 1;
    }
    const { config, errors, dir } = loadResolved(root, { env });
    if (errors.length) {
      stderr.write(`${errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join('\n')}\n`);
      return 1;
    }
    // Records the design on the story; a failure is a warning, never an error.
    const tell = (source, plan) => {
      try {
        noteOnStory({ root, config, env, now, ...(source ? { source } : {}) }, id, 'design', designData(plan));
      } catch (err) {
        stderr.write(`warning: the design was not recorded on the story: ${err.message}\n`);
      }
    };
    if (values['save-plan']) {
      try {
        const saved = sessionPlan({ dir, slot: currentSlot(env), id, roles: config.roles });
        if (saved.reason) {
          stderr.write(`workflow-args: ${saved.reason}; write the result's plan to ${PLAN_FILE(dir, id)} as JSON yourself\n`);
          return 1;
        }
        const plan = stampPlan(saved.plan, { cwd: cwd ?? root, remote: config.remote, base: config.baseBranch, now: (now ?? (() => new Date()))() });
        const { planFile } = writePlanFiles(dir, id, plan);
        tell(null, plan);
        stdout.write(`${planFile}\n`);
        return 0;
      } catch (err) {
        stderr.write(`workflow-args: ${err.message}; write the result's plan to ${PLAN_FILE(dir, id)} as JSON yourself\n`);
        return 1;
      }
    }
    try {
      const source = openStorySource({ root, config, now, env });
      const story = source.list().find((s) => s.id === id);
      const brief = story && source.brief(id);
      if (!story || !brief) {
        stderr.write(`no story ${id}\n`);
        return 1;
      }
      let rethink;
      if (values.rethink !== undefined) {
        try {
          rethink = rethinkOf(JSON.parse(readFileSync(resolve(cwd ?? root, values.rethink), 'utf8')));
        } catch (err) {
          stderr.write(`workflow-args: ${values.rethink} is not a rethink file: ${err.message}\n`);
          return 1;
        }
      }
      const t = resolveTraits({ root, config, stateDir: dir });
      if (t.errors.length) {
        stderr.write(`${t.errors.join('\n')}\n`);
        return 1;
      }
      for (const w of t.warnings) stderr.write(`warning: ${w}\n`);
      const skills = learnedSkillsByRole({ stateDir: dir, config, roles: roleNames(config), dir: cwd ?? root });
      for (const w of skills.warnings) stderr.write(`warning: ${w}\n`);
      adoptLegacySchemaLock(dir);
      const slot = currentSlot(env);
      const holds = Object.keys(config.resources ?? {}).filter((name) => holdsResource(dir, name, slot));
      const json = (file) => JSON.parse(readFileSync(resolve(cwd ?? root, file), 'utf8'));
      // A checkpoint from a stopped session; --start-at fix starts from its own findings instead.
      const cp = values['start-at'] === undefined && rethink === undefined ? readCheckpoint(dir, id) : null;
      const point = cp ? resumePoint(cp, { tree: worktreeTree(cwd ?? root, config.generated), reviewers: config.roles.reviewers.map((r) => r.name) }) : null;
      const at = new Date((now ?? (() => new Date()))());
      const gitOpts = { cwd: cwd ?? root, remote: config.remote, base: config.baseBranch };
      let plan = values.plan !== undefined ? json(values.plan) : (point?.plan ?? undefined);
      const resume = plan !== undefined && point?.resume ? point.resume : undefined;
      // A plan an earlier session saved (--save-plan) is reused while none of the files it names
      // changed on the base since, so a story that comes back after a deferral, a stop or a restart
      // never pays the architect again for the same design.
      const lines = readFindingsLines(dir);
      if (plan === undefined && values['start-at'] === undefined && rethink === undefined) {
        const saved = readPlanFile(dir, id);
        if (saved && saved.ready === true) {
          const s = failedSince(lines, id, saved.plannedAt) ? { fresh: false, reason: 'it failed review after it was written' } : planStaleness(saved, gitOpts);
          if (s.fresh) {
            plan = saved;
            stderr.write(`reusing the plan saved for ${id}${typeof saved.plannedAt === 'string' ? ` on ${saved.plannedAt.slice(0, 10)}` : ''}; the architect does not run again\n`);
          } else {
            stderr.write(`not reusing the plan saved for ${id}: ${s.reason}; the architect runs again\n`);
          }
        }
      }
      if (plan !== undefined) plan = stampPlan(plan, { ...gitOpts, now: at });
      // While the review engine is out of quota, the reviewers run on Claude straight away: no
      // relay agent is started only to be told the engine is unavailable.
      const down = readEngineDown(dir, at);
      const relayed = down && config.roles.reviewers.some((r) => r && r.engine);
      const cfg = relayed ? { ...config, roles: { ...config.roles, reviewers: config.roles.reviewers.map(({ engine, ...r }) => r) } } : config;
      if (relayed) stderr.write(`the ${down.engine ?? 'review'} engine is out of quota until ${down.until}; the reviewers run on Claude without a relay\n`);
      if (plan !== undefined && point?.kept.length) stderr.write(`resuming ${id} from its last finished stages: ${point.kept.join(', ')}\n`);
      const claim = plan !== undefined ? planFiles(plan, { cwd, root, config }).files : null;
      const filesHeld = claim !== null && (supervisorPid(env) === null ? claimedFiles(dir, claim, { slot, story: id }) : holdsFiles(dir, claim, slot));
      const designFile = plan === undefined ? undefined : writePlanFiles(dir, id, plan).designFile;
      if (plan !== undefined) tell(source, plan);
      const out = workflowArgs({
        story,
        briefPath: brief.path,
        groupLabel: source.groupLabel,
        config: cfg,
        traits: t.traits,
        skills: skills.byRole,
        holds,
        filesHeld,
        plan: plan === undefined ? undefined : shortPlan(plan),
        designFile,
        startAt: values['start-at'],
        findings: values.findings === undefined ? undefined : json(values.findings),
        earlier: earlierFindings(lines, id),
        rethink,
        resume,
      });
      try {
        noteLearned(dir, slot, id, [...new Set([...Object.values(t.learned).flat(), ...skills.ids])], at);
      } catch (err) {
        stderr.write(`warning: learned items not recorded: ${err.message}\n`);
      }
      // The story is told it went back to the architect only now, when nothing can exit 1 any more;
      // failing to say so changes nothing else.
      if (rethink !== undefined) {
        try {
          if ((await source.update(id, { note: rethinkNote(rethink.round, rethink) })) === false) throw new Error('the story source did not take the note');
        } catch (err) {
          stderr.write(`warning: the story was not told it went back to the architect: ${err.message}\n`);
        }
      }
      stdout.write(`${JSON.stringify(out)}\n`);
      return 0;
    } catch (err) {
      stderr.write(`workflow-args: ${err.message}\n`);
      return 1;
    }
  },
};
