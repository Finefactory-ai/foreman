// Ship step `deploy-github`: wait for the production deployment of the merge commit. Hosts
// such as Vercel report each deployment to GitHub; this polls GitHub's deployments for the
// merge sha (ctx.sha, from `merge`) in the configured environment, and its newest status,
// every 15 s until the status is final or the time runs out. Anything but `success` exits 5
// and writes HALT: main has the code, so production must be repaired by hand.
//
// A host can refuse a deployment outright (Vercel's daily cap on the Hobby plan: "Deployment
// rate limited — retry in 24 hours."). No deployment is created then, so waiting would only
// time out. Hosts report each deployment to GitHub as a commit status under their own name
// too; with `statusContext` set to that name, while no deployment exists the step reads the
// commit's statuses, and that status as failure or error stops the release at once with the
// host's own description.
//
// healthy() is part of "I've fixed it" (`foreman health`): the base branch's newest commit
// must have a successful deployment in the environment, any of them, since a redeploy makes
// a new one. A story merged but never deployed is not live, so it is not fixed.
//
// Options: config.ship['deploy-github'] = { environment = 'Production', timeoutMinutes = 15,
// statusContext?, rollbackHint? } (statusContext: the commit status the host posts, such as
// "Vercel"; rollbackHint: how to roll back, which the halt email adds to a deploy or smoke
// halt; this step never puts it in its own reason, so the email says it once).

import { fetchBase, lines, out } from '../../engine/git.mjs';

const STAGE = 'deploy';
const POLL_MS = 15_000;
const FINAL = new Set(['success', 'failure', 'error', 'inactive']);
const REFUSED = new Set(['failure', 'error']);

// The host's refusal from the commit's statuses (GitHub lists the newest first), or null.
export function refusalOf(statusesJson, context) {
  let statuses;
  try {
    statuses = JSON.parse(statusesJson ?? '[]');
  } catch {
    return null;
  }
  const s = Array.isArray(statuses) ? statuses.find((x) => x?.context === context) : null;
  if (!s || !REFUSED.has(s.state)) return null;
  return s.description ? `${context} refused the deployment: ${s.description}` : `${context} refused the deployment ("${s.state}").`;
}

export default {
  name: 'deploy-github',
  label: 'waiting for the production deployment',
  needs: ['gh'],
  halts: true,
  // Once this passes the new build is live, so a later failure may roll it back (ship.mjs).
  deploys: true,

  async run(ctx) {
    const o = ctx.config.ship?.['deploy-github'] ?? {};
    const environment = o.environment ?? 'Production';
    const minutes = o.timeoutMinutes ?? 15;
    // The reason stays bare: the halt email adds rollbackHint itself (lib/notify/email.mjs).
    const fail = (reason) => ({ ok: false, code: 5, stage: STAGE, reason });
    const sha = ctx.sha ? String(ctx.sha) : '';
    if (!sha) return fail(`No merge commit is known, so the ${environment} deployment cannot be found.`);

    const deadline = ctx.now().getTime() + minutes * 60_000;
    const list = `repos/{owner}/{repo}/deployments?sha=${encodeURIComponent(sha)}&environment=${encodeURIComponent(environment)}`;
    let state = 'pending';
    for (;;) {
      const id = out(ctx, 'gh', ['api', list, '--jq', '.[0].id // empty']);
      state = (id && out(ctx, 'gh', ['api', `repos/{owner}/{repo}/deployments/${id}/statuses`, '--jq', '.[0].state // "pending"'])) || 'pending';
      if (FINAL.has(state)) break;
      if (!id && o.statusContext) {
        const refused = refusalOf(out(ctx, 'gh', ['api', `repos/{owner}/{repo}/commits/${encodeURIComponent(sha)}/statuses`]), o.statusContext);
        if (refused) return fail(`${refused} ${environment} still runs the previous version.`);
      }
      if (ctx.now().getTime() >= deadline) break;
      await ctx.sleep(POLL_MS);
    }
    const what = `${environment} deployment of ${sha.slice(0, 7)}`;
    if (state === 'success') return { ok: true };
    if (FINAL.has(state)) return fail(`${what} ended as "${state}".`);
    return fail(`${what} did not finish within ${minutes} minute${minutes === 1 ? '' : 's'} (last seen "${state}").`);
  },

  async healthy(ctx) {
    const { remote, baseBranch } = ctx.config;
    const environment = ctx.config.ship?.['deploy-github']?.environment ?? 'Production';
    const sha = (await fetchBase(ctx)) ? out(ctx, 'git', ['rev-parse', `${remote}/${baseBranch}`]) : null;
    if (!sha) return { ok: false, reason: `Could not read the newest ${baseBranch} from ${remote}.` };
    const list = `repos/{owner}/{repo}/deployments?sha=${encodeURIComponent(sha)}&environment=${encodeURIComponent(environment)}`;
    const ids = out(ctx, 'gh', ['api', list, '--jq', '.[].id']);
    if (ids === null) return { ok: false, reason: `Could not read the ${environment} deployments from GitHub.` };
    const live = lines(ids).some((id) => out(ctx, 'gh', ['api', `repos/{owner}/{repo}/deployments/${id}/statuses`, '--jq', '.[0].state // ""']) === 'success');
    const newest = `The newest ${baseBranch} (${sha.slice(0, 7)})`;
    if (live) return { ok: true, reason: `${newest} is live.` };
    return { ok: false, reason: `${newest} is not live yet: ${environment} still runs an older version. Redeploy it, then press "I've fixed it" again.` };
  },
};
