// Ship step `sf-deploy-<stage>`: deploys the story's delta to one stage's org, after the merge.
// sfDeploy(stageName) gives the step for that stage, the same module on every call; sfDeploy(
// stageName, { later: true }) gives a later stage's (any stage after the first), which is
// marked noRollback and needs git too, so a failure from it on never rolls back: it halts. A
// stage that shares the build org gets a real deploy too. It halts on failure and marks the
// release as deployed.
//
//   0. a later stage with a branch of its own first gets the story branch merged into that
//      branch (stage-merge.mjs). A merge that fails is code 5, and nothing is deployed. The
//      merge commit is then the stage's commit, and the step gives it as the facts sha and
//      shaBranch, so a later stage that follows this branch deploys this commit.
//
//   1. the delta from sf-delta (ctx.sfDelta). An empty delta is skipped, with no sf call, and
//      any job record left for the stage is cleared.
//   2. the job: when deploy-jobs.mjs holds a record for this story and stage with the same org
//      alias, the same org ID, the same non-empty commit (sfDelta.to), a real job ID and a
//      valid startedAt, the step resumes that job and starts nothing. A resumed job is refused,
//      and a new deploy starts, when sf reports it as checkOnly (a validation) or created more
//      than 15 minutes before startedAt. Otherwise `sf project deploy start --manifest <delta>
//      [--post-destructive-changes <file>] --test-level <testLevel.deploy> --target-org <org>
//      --async`, through the isolated sf home, and the record is written before the job is
//      first read. It never passes --ignore-*, `quick` or NoTestRun.
//   3. the job is read every 10 seconds, for up to 30 minutes (deploy-result.mjs). A job that
//      ends clears the record. One still running at the deadline keeps it, which a re-run of
//      the same release would resume; but the pull request is merged by then and nothing
//      re-runs it, so the failure tells the owner to finish by hand with `foreman sf fixed
//      <stage>`.
//
// Every failure is code 5. A failure only in what the org already failed before this story, as the
// doctor's baseline for that org recorded it (baseline.mjs), is code 5 too and still halts, with
// inherited: true and a reason that says it is not the story's change. Facts: sfDeploys, with
// { org, jobId, components, tests, resumed } (or { org, skipped: true }) added under the stage's
// name.
//
// The release records (releases.mjs): the stage is marked reached for the story before
// anything else, skipped or not. A deploy that succeeds becomes the stage's last deploy, with
// the stage's commit (the merge into its own branch, else the merge step's sha, ctx.sha) as its
// commit; a skipped one moves an existing stage record to that commit and keeps its job, since
// the org did not change. On stage 1 a deploy is also the
// story's first deploy, with the branch the pull request merged into and ship.pr.mergeMethod,
// which is what `foreman sf rollback` reverts. The branch is worked out here, as sf-org-guard
// does, rather than imported from the pr step.

import os from 'node:os';
import { stateDir } from '../../../lib/engine/paths.mjs';
import { BLOCK_DEFAULTS, TEST_LEVELS, layout } from '../config.mjs';
import { FINAL, JOB_ID, summary, waitForJob } from '../deploy-result.mjs';
import { clearDeployJob, readDeployJob, writeDeployJob } from '../deploy-jobs.mjs';
import { markReached, readDeployed, recordFirstDeploy, writeDeployed } from '../releases.mjs';
import { mergeIntoStage } from '../stage-merge.mjs';
import { describe, isInherited, problemsOf, readBaseline } from '../baseline.mjs';
import { manifestTypes } from '../env/sandbox-pool.mjs';
import { isolatedSh, sfHome } from '../isolation.mjs';
import { runSf } from '../sf.mjs';
import { problems } from './sf-validate.mjs';

const START_TIMEOUT_MS = 600_000;
const MINUTES = 30;
// startedAt is written only after `deploy start` returns, which can take up to
// START_TIMEOUT_MS (10 minutes), plus 5 minutes for clock skew.
const RESUME_SLACK_MS = 15 * 60_000;

// A stored record is resumed only for the same org (alias and org ID), the same non-empty
// commit, a real job ID and a valid startedAt.
const matches = (record, stage, delta) =>
  record?.org === stage.org &&
  record.orgId === stage.orgId &&
  typeof delta.to === 'string' &&
  delta.to !== '' &&
  record.to === delta.to &&
  typeof record.jobId === 'string' &&
  JOB_ID.test(record.jobId) &&
  Number.isFinite(Date.parse(record.startedAt));

// Why a resumed job is not the deploy the record says, or null when it is genuine. A missing
// result or missing fields count as genuine.
function whyNotGenuine(result, record) {
  // A validation (dry-run) job never stands in for a deploy.
  if (result?.checkOnly === true || result?.checkOnly === 'true') return 'it is a validation, not a deploy';
  const created = typeof result?.createdDate === 'string' ? Date.parse(result.createdDate) : NaN;
  if (Number.isFinite(created) && created < Date.parse(record.startedAt) - RESUME_SLACK_MS) return 'it was created before the record says the deploy started';
  return null;
}

const pick = (v, list, fallback) => (list.includes(v) ? v : fallback);

function make(stageName, later) {
  const name = `sf-deploy-${stageName}`;
  const label = `deploying the Salesforce delta to ${stageName}`;
  const fail = (code, reason, extra = {}) => ({ ok: false, code, stage: name, reason, ...extra });

  return {
    name,
    label,
    needs: later ? ['sf', 'git'] : ['sf'],
    halts: true,
    deploys: true,
    ...(later ? { noRollback: true } : {}),

    async run(ctx) {
      const block = ctx.config.salesforce;
      const l = layout(block, ctx.config);
      const stage = l.stages.find((s) => s.name === stageName);
      if (!stage) return fail(1, `The salesforce block has no stage named ${stageName}.`);
      if (!stage.orgId) return fail(1, `The org ${stage.org} of stage ${stageName} has no org ID in salesforce.orgs.`);
      const delta = ctx.sfDelta;
      if (!delta?.manifest) return fail(1, 'There is no Salesforce delta to deploy; sf-delta must run first.');

      const env = ctx.env ?? process.env;
      const state = stateDir(ctx.root, ctx.config, env);
      markReached(state, ctx.story, stageName, delta.to);
      let commit = ctx.sha ?? null;
      let moved = {};
      if (l.stages.indexOf(stage) > 0 && !stage.follows) {
        const m = await mergeIntoStage(ctx, stage);
        if (!m.ok) return fail(5, `The merge for ${stageName} failed: ${m.reason}.`);
        commit = m.sha;
        moved = { sha: commit, shaBranch: stage.branch };
      }
      const deploys = { ...(ctx.sfDeploys ?? {}) };
      const deletes = Array.isArray(delta.deletes) ? delta.deletes : [];
      if (!Object.keys(manifestTypes(delta.manifest)).length && !deletes.length) {
        clearDeployJob(state, ctx.story, stageName);
        // No metadata changed, so the org still matches: the stage record follows the merge
        // and keeps the job that is in the org.
        const last = readDeployed(state, stageName);
        if (last) writeDeployed(state, { ...last, story: ctx.story, commit, at: ctx.now().toISOString() });
        return { ok: true, ...moved, sfDeploys: { ...deploys, [stageName]: { org: stage.org, skipped: true } } };
      }

      const level = pick(block?.testLevel?.deploy, TEST_LEVELS, BLOCK_DEFAULTS.testLevel.deploy);
      const iso = isolatedSh(ctx.sh, env, sfHome(env, os.homedir()), os.homedir());
      const where = `${stage.org} (${stageName})`;

      // Starts the deploy and records its job; gives the job ID, or the failure.
      const startDeploy = () => {
        const args = ['project', 'deploy', 'start', '--manifest', delta.manifest, ...(deletes.length ? ['--post-destructive-changes', delta.postDestructive] : []), '--test-level', level, '--target-org', stage.org, '--async'];
        const start = runSf(iso, args, { timeoutMs: START_TIMEOUT_MS });
        const id = start.ok && typeof start.result?.id === 'string' && JOB_ID.test(start.result.id) ? start.result.id : null;
        if (!id) return { failure: fail(5, `The deploy to ${where} never started: ${start.ok ? 'sf gave no deploy job ID' : start.error.message}`) };
        writeDeployJob(state, { story: ctx.story, stage: stageName, org: stage.org, orgId: stage.orgId, jobId: id, to: delta.to, startedAt: ctx.now().toISOString() });
        return { id };
      };

      const record = readDeployJob(state, ctx.story, stageName);
      let resumed = matches(record, stage, delta);
      let jobId;
      if (resumed) {
        jobId = record.jobId;
        ctx.event?.(`Resuming the ${stageName} deploy of ${ctx.story} from job ${jobId}.`);
      } else {
        const started = startDeploy();
        if (started.failure) return started.failure;
        jobId = started.id;
      }

      let job = await waitForJob(ctx, iso, { jobId, org: stage.org, minutes: MINUTES, label });
      const why = resumed && job.result !== null && typeof job.result === 'object' ? whyNotGenuine(job.result, record) : null;
      if (why) {
        ctx.event?.(`Refused to resume job ${jobId} for the ${stageName} deploy of ${ctx.story}: ${why}; starting a new deploy.`, 'warn');
        clearDeployJob(state, ctx.story, stageName);
        resumed = false;
        const started = startDeploy();
        if (started.failure) return started.failure;
        jobId = started.id;
        job = await waitForJob(ctx, iso, { jobId, org: stage.org, minutes: MINUTES, label });
      }
      const { components, tests, failures } = summary(job.result);
      if (job.status === 'Succeeded') {
        clearDeployJob(state, ctx.story, stageName);
        const at = ctx.now().toISOString();
        writeDeployed(state, { stage: stageName, org: stage.org, orgId: stage.orgId, jobId, story: ctx.story, commit, at });
        if (stageName === l.stages[0].name) {
          const merge = ctx.sha ?? null;
          const branch = ctx.config.ship?.pr?.into ?? ctx.config.baseBranch;
          const method = ctx.config.ship?.pr?.mergeMethod ?? 'merge';
          recordFirstDeploy(state, ctx.story, { stage: stageName, org: stage.org, orgId: stage.orgId, branch, merge, method, jobId, deployedAt: at });
        }
        return { ok: true, ...moved, sfDeploys: { ...deploys, [stageName]: { org: stage.org, jobId, components, tests, resumed } } };
      }
      if (FINAL.includes(job.status)) {
        clearDeployJob(state, ctx.story, stageName);
        const rec = readBaseline(state, { alias: stage.org, orgId: stage.orgId });
        if (isInherited(failures, rec)) {
          return fail(5, `The deploy to ${where} failed only in what ${stage.org} already fails before this story (${problems(failures, job.status)}): not this story's change. ${stage.org} ${describe(problemsOf(rec))}; set salesforce.testLevel.deploy to RunRelevantTests, or fix the org.`, { failures, jobId, inherited: true });
        }
        return fail(5, `The deploy to ${where} failed: ${problems(failures, job.status)}`, { failures, jobId });
      }
      // A re-run of this release would resume the kept record, but after the merge nothing
      // re-runs it (`foreman ship` stops at "no commits ahead"), so the owner finishes by hand.
      const byHand = `; job ${jobId} may still be running. The pull request is already merged, so Foreman will not run this release again: check the job with \`sf project deploy report --job-id ${jobId} --target-org ${stage.org}\`, finish the ${stageName} deploy by hand if it failed, then run \`foreman sf fixed ${stageName}\` and clear the halt with "I've fixed it".`;
      if (job.stopped) return fail(5, `Stopped watching job ${jobId} on ${where}: ${job.stopped}${byHand}`, { jobId });
      const seen = job.status ?? job.lastError ?? 'nothing';
      return fail(5, `The deploy to ${where} did not finish within ${MINUTES} minutes (last seen "${seen}")${byHand}`, { jobId });
    },
  };
}

const made = new Map();

export function sfDeploy(stageName, { later = false } = {}) {
  const key = later ? `${stageName}:later` : stageName;
  if (!made.has(key)) made.set(key, make(stageName, later));
  return made.get(key);
}
