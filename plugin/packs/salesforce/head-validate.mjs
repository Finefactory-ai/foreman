// A check-only deploy of a pull request's head against a stage's org, for the gearset-promote steps.
// Gearset validates a pull request into the first stage by itself and never one into a later stage,
// so for a later stage Foreman runs the validation itself, with the pack's one way to validate
// (sf-validate's dry run), then merges exactly the head it validated. The dry run covers everything
// the merge sends to the stage, not only this story's change: a promotion pull request can carry
// other changes queued on the pipeline branch.
//
// validateHead(ctx, { stage, head, sha, what, label }) is async and never throws for an expected
// failure. `stage` is a layout stage { name, org, orgId, branch }, `head` the promotion branch,
// `sha` the pull request's head commit, `what` how the reason names the pull request ("pull
// request #3") and `label` the slot's heartbeat text. In this order, each refusal returning before
// any later call:
//
//   1. code 1, with no sf or git call: the stage's org is marked "production": true in
//      salesforce.orgs, it has no org ID, its branch is productionBranch, or `head` or the stage's
//      branch is not a branch name (they go to git, so they may not start with "-").
//   2. the org guard, through the isolated sf home: the Organization query of the stage's org. A
//      query that fails is code 2, "never started". An org that is not a sandbox, or has another
//      org ID than salesforce.orgs gives, is code 1: production is never a target.
//   3. `sha` must be a full commit id (code 2, "never started").
//   4. the sfdx-git-delta pin (sf-delta's sgdProblem): a problem is code 2, "never started", with no
//      git call.
//   5. the pull request's own delta, in a temporary folder removed on every path: `git fetch --quiet
//      <remote> +refs/heads/<head>:refs/remotes/<remote>/<head>` (so the commit is here), the same
//      fetch of the stage's branch, `git merge-base refs/remotes/<remote>/<stage branch> <sha>`, then
//      `git worktree add --detach <tmp>/tree <sha>` and sfdx-git-delta (sf-delta's buildDelta) from
//      the merge base to `sha`, in that checkout, into <tmp>/delta. A failed fetch, merge base,
//      checkout or delta is code 2, "never started", with git's or sf's first line, redacted. No
//      <types> and no deletes is { ok: true, skipped: true }: nothing to dry-run. A Flow or
//      RecordType delete is left out, as sf-delta leaves it out. Nothing is read from ctx.sfDelta.
//   6. `sf project deploy start --dry-run --manifest <that package.xml> [--post-destructive-changes
//      <file>] --test-level <testLevel.validate> --target-org <org> --async` run in that checkout,
//      with the isolated sf home. It never passes --ignore-*, `quick` or NoTestRun. No job ID is
//      code 2, "never started". The folder is removed as soon as the job is started.
//   7. the job, read every 10 seconds for up to 30 minutes (deploy-result.mjs).
//
// Succeeded gives { ok: true, jobId, components, tests }. Everything else that is not code 1 is
// code 2, the code for a failed check with nothing merged: a failed job (with `failures`, and
// `inherited: true` when only what the org already failed before this story fails, as the doctor's
// baseline recorded it), a job that did not finish, and one stopped by a login-rate or sign-in
// answer. Every reason starts "Foreman's validation of <what> on <org> (<stage>)", so it is plain
// that Foreman, not Gearset, validated the pull request. Reasons name aliases, org IDs, branches and
// sf's own message: never a username or a token.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stateDir } from '../../lib/engine/paths.mjs';
import { redact } from '../../lib/secrets/redact.mjs';
import { describe, isInherited, problemsOf, readBaseline } from './baseline.mjs';
import { BLOCK_DEFAULTS, BRANCH, TEST_LEVELS, layout } from './config.mjs';
import { FINAL, JOB_ID, summary, waitForJob } from './deploy-result.mjs';
import { manifestTypes } from './env/sandbox-pool.mjs';
import { isolatedSh, orgQuery, sfHome } from './isolation.mjs';
import { runSf } from './sf.mjs';
import { buildDelta, sgdProblem } from './steps/sf-delta.mjs';
import { problems } from './steps/sf-validate.mjs';
import { removeTempTree } from './temp-tree.mjs';

const START_TIMEOUT_MS = 600_000;
const MINUTES = 30;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const id15 = (v) => (typeof v === 'string' ? v.slice(0, 15) : '');
const firstLine = (text) => String(text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? 'git gave no reason';

export async function validateHead(ctx, { stage, head, sha, what, label }) {
  const fail = (code, reason, extra = {}) => ({ ok: false, code, reason, ...extra });
  const l = layout(ctx.config.salesforce, ctx.config);
  const where = `${stage.org} (${stage.name})`;
  const lead = `Foreman's validation of ${what} on ${where}`;
  const never = (why) => fail(2, `${lead} never started: ${why}`);

  if (l.orgs[stage.org]?.production === true) return fail(1, `${stage.org} is marked "production": true in salesforce.orgs; production is never a target.`);
  if (!stage.orgId) return fail(1, `The org ${stage.org} of stage ${stage.name} has no org ID in salesforce.orgs.`);
  if (stage.branch === l.productionBranch) return fail(1, `Stage ${stage.name} is on ${stage.branch}, the production branch; production is never a target.`);
  if (typeof head !== 'string' || !BRANCH.test(head)) return fail(1, `The promotion branch of ${what} is not a branch name Foreman will pass to git.`);
  if (typeof stage.branch !== 'string' || !BRANCH.test(stage.branch)) return fail(1, `The branch of stage ${stage.name} is not a branch name Foreman will pass to git.`);

  const env = ctx.env ?? process.env;
  const iso = isolatedSh(ctx.sh, env, sfHome(env, os.homedir()), os.homedir());
  const q = orgQuery(iso, stage.org);
  if (!q.ok) return never(`could not check ${stage.org}: ${q.error.message}`);
  const records = isObject(q.result) && Array.isArray(q.result.records) ? q.result.records : [];
  const record = isObject(records[0]) ? records[0] : null;
  if (record?.IsSandbox !== true) return fail(1, `${stage.org} is not a sandbox; production is never a target.`);
  if (id15(record.Id) !== id15(stage.orgId)) return fail(1, `${stage.org} is org ${id15(record.Id)}, not ${stage.orgId}.`);

  if (typeof sha !== 'string' || !SHA.test(sha)) return never(`${what} has no full head commit id to check out`);
  const pin = sgdProblem(iso);
  if (pin) return never(pin);
  const git = (args, cwd = ctx.root) => ctx.sh('git', args, { cwd }) ?? {};
  const remote = ctx.config.remote ?? 'origin';
  const level = TEST_LEVELS.includes(ctx.config.salesforce?.testLevel?.validate) ? ctx.config.salesforce.testLevel.validate : BLOCK_DEFAULTS.testLevel.validate;

  // sf reads the source from the folder it runs in, so it runs in a temporary checkout of exactly
  // the commit that is to be merged, never the project's own checkout. The manifest is the pull
  // request's own diff against the stage branch, so the dry run covers all that the merge sends.
  let jobId = null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-sf-validate-head-'));
  const tree = path.join(tmp, 'tree');
  try {
    const fetched = git(['fetch', '--quiet', remote, `+refs/heads/${head}:refs/remotes/${remote}/${head}`]);
    if (fetched.status !== 0) return never(`could not fetch ${head} from ${remote}: ${redact(firstLine(fetched.stderr || fetched.stdout), { env })}`);
    const fetchedStage = git(['fetch', '--quiet', remote, `+refs/heads/${stage.branch}:refs/remotes/${remote}/${stage.branch}`]);
    if (fetchedStage.status !== 0) return never(`could not fetch ${stage.branch} from ${remote}: ${redact(firstLine(fetchedStage.stderr || fetchedStage.stdout), { env })}`);
    const base = String(git(['merge-base', `refs/remotes/${remote}/${stage.branch}`, sha]).stdout ?? '').trim();
    if (!SHA.test(base)) return never(`could not find where ${what} left ${stage.branch}`);
    const added = git(['worktree', 'add', '--detach', tree, sha]);
    if (added.status !== 0) return never(`could not check out ${sha} (the head of ${what}) to validate it: ${redact(firstLine(added.stderr || added.stdout), { env })}`);
    const built = buildDelta(iso, { from: base, to: sha, dir: path.join(tmp, 'delta'), cwd: tree });
    if (!built.ok) return never(redact(built.reason, { env }));
    if (!Object.keys(manifestTypes(built.manifest)).length && !built.deletes.length) return { ok: true, skipped: true };
    const args = ['project', 'deploy', 'start', '--dry-run', '--manifest', built.manifest, ...(built.deletes.length ? ['--post-destructive-changes', built.postDestructive] : []), '--test-level', level, '--target-org', stage.org, '--async'];
    const start = runSf(iso, args, { cwd: tree, timeoutMs: START_TIMEOUT_MS });
    jobId = start.ok && typeof start.result?.id === 'string' && JOB_ID.test(start.result.id) ? start.result.id : null;
    if (!jobId) return never(start.ok ? 'sf gave no deploy job ID' : start.error.message);
  } finally {
    removeTempTree(git, tree, tmp);
  }

  const job = await waitForJob(ctx, iso, { jobId, org: stage.org, minutes: MINUTES, label });
  const { components, tests, failures } = summary(job.result);
  if (job.status === 'Succeeded') return { ok: true, jobId, components, tests };
  if (FINAL.includes(job.status)) {
    const rec = readBaseline(stateDir(ctx.root, ctx.config, env), { alias: stage.org, orgId: stage.orgId });
    if (isInherited(failures, rec)) {
      return fail(2, `${lead} failed only in what ${stage.org} already fails before this story (${problems(failures, job.status)}): not this story's change. ${stage.org} ${describe(problemsOf(rec))}; set salesforce.testLevel.validate to RunRelevantTests, or fix the org.`, { failures, inherited: true });
    }
    return fail(2, `${lead} failed: ${problems(failures, job.status)}`, { failures });
  }
  if (job.stopped) return fail(2, `${lead}: stopped watching job ${jobId}: ${job.stopped}`);
  return fail(2, `${lead} did not finish within ${MINUTES} minutes (last seen "${job.status ?? job.lastError ?? 'nothing'}").`);
}
