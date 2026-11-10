// Ship step `ci-deploy-watch-<stage>`, on the ci release path: the project's own GitHub Actions
// workflow deploys the merge to the stage's org, and this step watches it, after the merge.
// ciDeployWatch(stageName) gives the step for that stage, the same module on every call;
// ciDeployWatch(stageName, { later: true }) gives a later stage's (any stage after the first),
// marked noRollback and needing git too, so a failure from it on halts and never rolls back.
// A later stage with a branch of its own first gets the story branch merged into that branch
// (stage-merge.mjs; a failure is code 5), and its CI deploy of that merge is watched. Any other
// stage can be watched only when its branch is the one ctx.sha is on: ctx.shaBranch, given by
// the later stage before it, else the pull request target (ship.pr.into, else baseBranch). It
// halts on failure and marks the release as deployed.
//
//   1. the commit: the merge into the stage's own branch, else ctx.sha (from merge, or the
//      stage before), and its committer date, which is the merge time.
//   2. the runs: `gh api repos/{owner}/{repo}/actions/runs?head_sha=<sha>&branch=<branch>
//      &event=push`, every 20 seconds, for up to 30 minutes. Only runs whose head_sha and
//      head_branch match count. Every one must end as success, skipped or neutral, and the
//      finished runs must look the same on two polls in a row, so a workflow queued after the
//      first one finished is watched too. Runs first seen finished at the deadline still go on.
//   3. the org: a Tooling API query of DeployRequest rows created after the merge, through the
//      isolated sf home, every 20 seconds until the same deadline. A Succeeded deploy that is
//      not check-only, finished after the merge, and was created while the CI runs ran (between
//      the first run's start and the last run's update, with one minute of slack) confirms the
//      release. A check-only row (a validation or dry run) never counts, nor does a deploy made
//      outside that window, such as a manual one. Runs that give no times leave that side open.
//
// It only reads: no sf call deploys or passes --ignore-* or `quick`. Reasons name run pages
// and the org alias, never tokens or sf results. It imports neither the core pr nor merge step
// (both lead back to the config validator, which loads this pack), so the target is a copy of
// the pr step's rule.
//
// A stage it cannot watch is code 1; every other failure is code 5. Facts: ciDeploys, with
// { org, sha, runs: [{ name, url, conclusion }], deployId } added under the stage's name, and
// for a later stage on its own branch, sha and shaBranch: the merge it watched, and that branch.

import os from 'node:os';
import { layout } from '../config.mjs';
import { isolatedSh, sfHome } from '../isolation.mjs';
import { runSf, stopsRetry } from '../sf.mjs';
import { mergeIntoStage } from '../stage-merge.mjs';

const MINUTES = 30;
const POLL_MS = 20_000;
// Slack around the CI runs' window, for clock drift between GitHub and Salesforce.
const SKEW_MS = 60_000;
const SHA = /^[0-9a-f]{7,64}$/i;
const PASSED = ['success', 'skipped', 'neutral'];
const PENDING = ['Pending', 'InProgress', 'Canceling'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v : '');
const said = (r) => String(r.stderr || r.stdout || '').trim().split('\n').pop().slice(0, 200);
// sf gives dates as 2026-10-15T12:01:00.000+0000, which Date.parse reads only with the colon.
const sfTime = (v) => Date.parse(text(v).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));

// The runs in gh's answer for `sha` on `branch`, or null when the answer cannot be read.
function readRuns(stdout, sha, branch) {
  let body;
  try {
    body = JSON.parse(String(stdout ?? ''));
  } catch {
    return null;
  }
  if (!isObject(body) || !Array.isArray(body.workflow_runs)) return null;
  return body.workflow_runs.filter((r) => isObject(r) && r.head_sha === sha && r.head_branch === branch);
}

function make(stageName, later) {
  const name = `ci-deploy-watch-${stageName}`;
  const label = `watching the CI deploy to ${stageName}`;
  const fail = (code, reason, extra = {}) => ({ ok: false, code, stage: name, reason, ...extra });

  return {
    name,
    label,
    needs: later ? ['gh', 'sf', 'git'] : ['gh', 'sf'],
    halts: true,
    deploys: true,
    ...(later ? { noRollback: true } : {}),

    async run(ctx) {
      const stages = layout(ctx.config.salesforce, ctx.config).stages;
      const stage = stages.find((s) => s.name === stageName);
      if (!stage) return fail(1, `The salesforce block has no stage named ${stageName}.`);
      if (!stage.orgId) return fail(1, `The org ${stage.org} of stage ${stageName} has no org ID in salesforce.orgs.`);
      let sha;
      let moved = {};
      if (stages.indexOf(stage) > 0 && !stage.follows) {
        const m = await mergeIntoStage(ctx, stage);
        if (!m.ok) return fail(5, `The merge for ${stageName} failed: ${m.reason}.`);
        sha = String(m.sha ?? '');
        moved = { sha, shaBranch: stage.branch };
      } else {
        const into = ctx.shaBranch ?? ctx.config.ship?.pr?.into ?? ctx.config.baseBranch;
        if (stage.branch !== into) {
          return fail(1, `Stage ${stageName} is on branch ${stage.branch ?? 'none'}, but pull requests merge into ${into}; only the stage on ${into} can have its CI deploy watched.`);
        }
        sha = String(ctx.sha ?? '');
      }

      if (!SHA.test(sha)) return fail(5, `No merge commit is known on ${stage.branch}, so its CI run cannot be found.`);
      const short = sha.slice(0, 7);
      const shown = ctx.sh('git', ['show', '-s', '--format=%cI', sha]) ?? {};
      const mergedAt = new Date(String(shown.stdout ?? '').trim());
      if (shown.status !== 0 || Number.isNaN(mergedAt.getTime())) return fail(5, `The step could not read the time of merge commit ${short}.`);
      const since = mergedAt.toISOString().replace(/\.\d{3}Z$/, 'Z');

      const deadline = ctx.now().getTime() + MINUTES * 60_000;
      const where = `${short} on ${stage.branch}`;
      const withError = (reason, lastError) => (lastError ? `${reason} (${lastError})` : reason);

      // The CI runs for the merge commit.
      let runs = null;
      let lastError = '';
      let doneKey = null;
      const completed = (run) => run.status === 'completed';
      for (;;) {
        ctx.report?.(label);
        const url = `repos/{owner}/{repo}/actions/runs?head_sha=${encodeURIComponent(sha)}&branch=${encodeURIComponent(stage.branch)}&event=push&per_page=100`;
        const r = ctx.sh('gh', ['api', url]) ?? {};
        const read = r.status === 0 ? readRuns(r.stdout, sha, stage.branch) : null;
        if (read) {
          runs = read;
          lastError = '';
        } else {
          lastError = r.status === 0 ? 'gh api answered something unreadable' : said(r);
        }
        const failed = (runs ?? []).find((run) => completed(run) && !PASSED.includes(run.conclusion));
        if (failed) return fail(5, `CI run ${text(failed.name) || 'unnamed'} for ${where} ended as ${failed.conclusion ?? 'no conclusion'}: ${text(failed.html_url)}`);
        // Finished runs count only when a second fresh read shows the same set.
        if (read) {
          const key = read.length && read.every(completed) ? read.map((run) => String(run.id ?? run.html_url)).sort().join(',') : null;
          if (key && key === doneKey) break;
          doneKey = key;
        }
        if (ctx.now().getTime() >= deadline) {
          if (runs?.length && runs.every(completed)) break;
          const going = (runs ?? []).find((run) => run.status !== 'completed');
          if (!going) {
            return fail(5, withError(`No GitHub Actions run started for ${where} within ${MINUTES} minutes; check that a workflow deploys pushes to ${stage.branch}`, lastError));
          }
          return fail(5, withError(`CI run ${text(going.name) || 'unnamed'} for ${where} did not finish within ${MINUTES} minutes (last seen ${text(going.status) || 'no status'})`, lastError));
        }
        await ctx.sleep(POLL_MS);
      }
      const ran = runs.map((run) => ({ name: text(run.name), url: text(run.html_url), conclusion: run.conclusion }));

      // When the runs ran: the earliest start to the latest update. A side no run gives is open.
      const from = Math.min(...runs.map((run) => Date.parse(text(run.run_started_at) || text(run.created_at))).filter(Number.isFinite));
      const to = Math.max(...runs.map((run) => Date.parse(text(run.updated_at))).filter(Number.isFinite));
      const hasFrom = Number.isFinite(from);
      const hasTo = Number.isFinite(to);
      const inWindow = (row) => {
        if (!hasFrom && !hasTo) return true;
        const at = sfTime(row.CreatedDate);
        if (Number.isNaN(at)) return false;
        return (!hasFrom || at >= from - SKEW_MS) && (!hasTo || at <= to + SKEW_MS);
      };
      const isoOf = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

      // The deploy those runs made, in the stage's org.
      const env = ctx.env ?? process.env;
      const iso = isolatedSh(ctx.sh, env, sfHome(env, os.homedir()), os.homedir());
      const query = `SELECT Id, Status, CheckOnly, CreatedDate, StartDate, CompletedDate FROM DeployRequest WHERE CreatedDate > ${since} ORDER BY CreatedDate DESC LIMIT 20`;
      const org = `${stage.org} (${stageName})`;
      let lastStatus = '';
      lastError = '';
      for (;;) {
        ctx.report?.(label);
        const q = runSf(iso, ['data', 'query', '--use-tooling-api', '--query', query, '--target-org', stage.org]);
        if (stopsRetry(q)) return fail(5, `Stopped watching the deploy of ${short} to ${org}: ${q.error.message}`);
        if (q.ok) {
          lastError = '';
          const records = isObject(q.result) && Array.isArray(q.result.records) ? q.result.records : [];
          const real = records.filter((row) => isObject(row) && row.CheckOnly !== true);
          const ours = real.filter(inWindow);
          const done = ours.find((row) => row.Status === 'Succeeded' && sfTime(row.CompletedDate) > mergedAt.getTime());
          if (done) {
            return { ok: true, ...moved, ciDeploys: { ...(ctx.ciDeploys ?? {}), [stageName]: { org: stage.org, sha, runs: ran, deployId: text(done.Id) } } };
          }
          const pending = ours.find((row) => PENDING.includes(row.Status));
          if (!pending) {
            const newest = real[0] ? `; the newest was ${text(real[0].Status) || 'unknown'}` : '';
            if (!hasFrom && !hasTo) {
              return fail(5, `The CI runs for ${short} passed, but ${org} shows no successful deploy that finished after the merge at ${since}${newest}`);
            }
            const span = `${hasFrom ? isoOf(from) : since} to ${hasTo ? isoOf(to) : 'now'}`;
            return fail(5, `The CI runs for ${short} passed, but ${org} shows no successful deploy made while they ran (${span})${newest}`);
          }
          lastStatus = pending.Status;
        } else {
          lastError = q.error.message;
        }
        if (ctx.now().getTime() >= deadline) {
          return fail(5, withError(`The deploy of ${short} to ${org} did not finish within ${MINUTES} minutes${lastStatus ? ` (last seen ${lastStatus})` : ''}`, lastError));
        }
        await ctx.sleep(POLL_MS);
      }
    },
  };
}

const made = new Map();

export function ciDeployWatch(stageName, { later = false } = {}) {
  const key = later ? `${stageName}:later` : stageName;
  if (!made.has(key)) made.set(key, make(stageName, later));
  return made.get(key);
}
