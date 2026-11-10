// Ship step `mergeable-recheck`: just before the first point of no return (the hosted
// migration, or the merge), check again that the pull request can still merge. The base may
// have moved while CI ran, and a migration that runs before a failed merge cannot be undone
// (P4-04). Two checks: the base branch is still an ancestor of this branch, and GitHub still
// reports the pull request MERGEABLE (an UNKNOWN answer is polled, 6 times 5 s).
//
// Either failure exits 1 with nothing migrated or merged. When the base moved, the result
// says `again: true` and the runner (engine/ship.mjs) brings the base in again itself: it
// restarts the steps, so merge-main merges it and CI runs again. Any other failure is left
// to the story session (a CONFLICTING pull request would merge cleanly here, so looping on
// it would only burn CI runs). Never a point of no return. Needs the `prNumber` fact from
// the `pr` step.

import { fetchBase } from '../../engine/git.mjs';

const STAGE = 'mergeable-recheck';
const TRIES = 6;
const WAIT_MS = 5_000;

const fail = (reason) => ({ ok: false, code: 1, stage: STAGE, reason });

export default {
  name: 'mergeable-recheck',
  label: 'checking the pull request can still merge',
  needs: ['git', 'gh'],

  async run(ctx) {
    const { remote, baseBranch } = ctx.config;
    if (!ctx.prNumber) return fail('No pull request number is known; place mergeable-recheck after the pr step.');
    if (!(await fetchBase(ctx))) return fail(`git fetch ${remote} ${baseBranch} failed three times.`);
    if (ctx.sh('git', ['merge-base', '--is-ancestor', `${remote}/${baseBranch}`, 'HEAD']).status !== 0) {
      return { ...fail(`${baseBranch} moved since this branch was tested; ship again to merge it in and re-run CI.`), again: true };
    }

    let state = 'UNKNOWN';
    for (let i = 0; i < TRIES; i++) {
      const r = ctx.sh('gh', ['pr', 'view', String(ctx.prNumber), '--json', 'mergeable', '--jq', '.mergeable']);
      state = (r.status === 0 && String(r.stdout ?? '').trim()) || 'UNKNOWN';
      if (state !== 'UNKNOWN' || i === TRIES - 1) break;
      await ctx.sleep(WAIT_MS);
    }
    if (state !== 'MERGEABLE') return fail(`Pull request #${ctx.prNumber} is no longer mergeable (${state}); ship again.`);
    return { ok: true };
  },
};
