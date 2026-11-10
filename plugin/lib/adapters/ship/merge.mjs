// Ship step `merge`: merge the pull request, then tidy up: delete the remote branch, move
// the checkout to the newest base, delete the local branch, and record the sha of the
// branch the pull request merged into (the base, or `ship.pr.into` when that differs).
// A later step may replace that sha (a Salesforce stage merging into its own branch does).
// With `ship.merge.keepBranch` it deletes no branch, remote or local. The checkout still
// goes back to the base, because the next story is cut from it.
// Past this step the target has the story's code, so a release cut off here is finished,
// never redone.
//
// No --delete-branch: it switches the local checkout to the base, which git refuses in a
// worktree, and a non-zero exit after a merge that did happen must not read as a failure,
// so the pull request's state decides.

import { fetchBase, out } from '../../engine/git.mjs';
import { prTarget } from './pr.mjs';

const STAGE = 'merge';

export default {
  name: 'merge',
  label: 'merging',
  needs: ['gh', 'git'],
  pointOfNoReturn: true,
  // The preflight wants mergeable-recheck right before it.
  beforeNoReturn: true,

  async run(ctx) {
    const { sh, branch } = ctx;
    const { remote, baseBranch } = ctx.config;
    const method = ctx.config.ship?.pr?.mergeMethod ?? 'merge';
    const n = String(ctx.prNumber);
    const keep = ctx.config.ship?.merge?.keepBranch === true;
    const into = prTarget(ctx.config);

    sh('gh', ['pr', 'merge', n, `--${method}`]);
    const state = out(ctx, 'gh', ['pr', 'view', n, '--json', 'state', '--jq', '.state']) || 'UNKNOWN';
    if (state !== 'MERGED') return { ok: false, code: 1, stage: STAGE, reason: `The merge failed (pull request is ${state}).`, pr: ctx.pr };

    // From here on the release has happened; tidying up is best effort.
    if (!keep) sh('git', ['push', '--quiet', remote, '--delete', branch]);
    await fetchBase(ctx);
    // In a worktree the base is checked out elsewhere, so detach; when unsure, detach too.
    const gitDir = out(ctx, 'git', ['rev-parse', '--path-format=absolute', '--git-dir']);
    const commonDir = out(ctx, 'git', ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (!gitDir || !commonDir || gitDir !== commonDir) {
      sh('git', ['checkout', '--quiet', '--detach', `${remote}/${baseBranch}`]);
    } else {
      sh('git', ['checkout', '--quiet', baseBranch]);
      sh('git', ['pull', '--quiet', '--ff-only', remote, baseBranch]);
    }
    if (!keep) sh('git', ['branch', '-D', branch]);
    // Deploys read this sha; the story's code is on the target, which may not be the base.
    // Full ref names, so a target that starts with "-" or holds ":" cannot read as an option
    // or a refspec, whatever let it through.
    if (into === baseBranch) return { ok: true, sha: out(ctx, 'git', ['rev-parse', `${remote}/${baseBranch}`]) };
    const tracking = `refs/remotes/${remote}/${into}`;
    // "+" because qa/uat branches get reset: without it git refuses the update and the stale
    // tracking ref would be read as the target's sha.
    const fetched = sh('git', ['fetch', '--quiet', remote, `+refs/heads/${into}:${tracking}`]);
    if (fetched.status !== 0) {
      ctx.event?.(`Could not fetch ${into} from ${remote}, so its sha is not known; a deploy step after this one will stop.`, 'warn');
      return { ok: true, sha: null };
    }
    return { ok: true, sha: out(ctx, 'git', ['rev-parse', '--verify', tracking]) };
  },
};
