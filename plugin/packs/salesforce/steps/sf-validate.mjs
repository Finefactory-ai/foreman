// Ship step `sf-validate`: a dry run of the story's delta on the first stage's org, before the
// point of no return. It runs there even when that org is the build org. It deploys nothing and
// never halts.
//
//   1. the delta from sf-delta (ctx.sfDelta). A delta with no <types> in package.xml and no
//      deletes is skipped, with no sf call.
//   2. `sf project deploy start --dry-run --manifest <delta> [--post-destructive-changes <file>]
//      --test-level <testLevel.validate> --target-org <stage 1 org> --async`, through the
//      isolated sf home. It never passes --ignore-*, `quick` or NoTestRun.
//   3. the job is read every 10 seconds, for up to 30 minutes (deploy-result.mjs).
//
// A failed validation is code 2, the code for a CI failure with nothing merged, so the story
// gets a fix round: the result's `failures` lists each problem as { kind, name, message }.
// A validation that never started or did not finish is code 2 too, and its reason says so.
// A failure only in what the org already failed before this story, as the doctor's baseline
// for that org recorded it (baseline.mjs: tests it lists, plus org-wide coverage it already
// lacked), is still code 2, with inherited: true and a reason that says it is not the story's
// change, so the story is blocked for the owner rather than sent to a fix round.
// It is marked testsMergedCode: it validates the merged delta, so merge-main does not run the
// project's checks (by default an org dry run) a second time on a release without a ci step.
// Facts for later steps: sfValidate { stage, org, jobId, components, tests }, or
// { stage, org, skipped: true }.

import os from 'node:os';
import { stateDir } from '../../../lib/engine/paths.mjs';
import { describe, isInherited, problemsOf, readBaseline } from '../baseline.mjs';
import { BLOCK_DEFAULTS, TEST_LEVELS, layout } from '../config.mjs';
import { FINAL, JOB_ID, summary, waitForJob } from '../deploy-result.mjs';
import { manifestTypes } from '../env/sandbox-pool.mjs';
import { isolatedSh, sfHome } from '../isolation.mjs';
import { runSf } from '../sf.mjs';

const STAGE = 'sf-validate';
const START_TIMEOUT_MS = 600_000;
const MINUTES = 30;
const LABEL = "validating the Salesforce delta on the first stage's org";

const fail = (code, reason, extra = {}) => ({ ok: false, code, stage: STAGE, reason, ...extra });
const pick = (v, list, fallback) => (list.includes(v) ? v : fallback);

// "<n> problem(s): <the first three names>", or what sf said when it named none.
export function problems(failures, status) {
  if (!failures.length) return `status ${status}`;
  return `${failures.length} problem(s): ${failures.slice(0, 3).map((f) => f.name).join(', ')}`;
}

export default {
  name: STAGE,
  label: LABEL,
  needs: ['sf'],
  testsMergedCode: true,

  async run(ctx) {
    const block = ctx.config.salesforce;
    const stage = layout(block, ctx.config).stages[0];
    if (!stage) return fail(1, 'The salesforce block has no stage to validate on.');
    const delta = ctx.sfDelta;
    if (!delta?.manifest) return fail(1, 'There is no Salesforce delta to validate; sf-delta must run first.');

    const deletes = Array.isArray(delta.deletes) ? delta.deletes : [];
    const facts = { stage: stage.name, org: stage.org };
    if (!Object.keys(manifestTypes(delta.manifest)).length && !deletes.length) return { ok: true, sfValidate: { ...facts, skipped: true } };

    const level = pick(block?.testLevel?.validate, TEST_LEVELS, BLOCK_DEFAULTS.testLevel.validate);
    const env = ctx.env ?? process.env;
    const iso = isolatedSh(ctx.sh, env, sfHome(env, os.homedir()), os.homedir());
    const where = `${stage.org} (${stage.name})`;

    const args = ['project', 'deploy', 'start', '--dry-run', '--manifest', delta.manifest, ...(deletes.length ? ['--post-destructive-changes', delta.postDestructive] : []), '--test-level', level, '--target-org', stage.org, '--async'];
    const start = runSf(iso, args, { timeoutMs: START_TIMEOUT_MS });
    const jobId = start.ok && typeof start.result?.id === 'string' && JOB_ID.test(start.result.id) ? start.result.id : null;
    if (!jobId) {
      const why = start.ok ? 'sf gave no deploy job ID' : start.error.message;
      return fail(2, `The Salesforce validation on ${where} never started: ${why}`);
    }

    const job = await waitForJob(ctx, iso, { jobId, org: stage.org, minutes: MINUTES, label: LABEL });
    const { components, tests, failures } = summary(job.result);
    if (job.status === 'Succeeded') return { ok: true, sfValidate: { ...facts, jobId, components, tests } };
    if (FINAL.includes(job.status)) {
      const rec = readBaseline(stateDir(ctx.root, ctx.config, env), { alias: stage.org, orgId: stage.orgId });
      if (isInherited(failures, rec)) {
        return fail(2, `The Salesforce validation on ${where} failed only in what ${stage.org} already fails before this story (${problems(failures, job.status)}): not this story's change. ${stage.org} ${describe(problemsOf(rec))}; set salesforce.testLevel.validate to RunRelevantTests, or fix the org.`, { failures, inherited: true });
      }
      return fail(2, `The Salesforce validation on ${where} failed: ${problems(failures, job.status)}`, { failures });
    }
    if (job.stopped) return fail(2, `Stopped watching job ${jobId} on ${where}: ${job.stopped}`);
    const seen = job.status ?? job.lastError ?? 'nothing';
    return fail(2, `The Salesforce validation on ${where} did not finish within ${MINUTES} minutes (last seen "${seen}").`);
  },
};
