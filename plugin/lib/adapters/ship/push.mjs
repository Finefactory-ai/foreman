// Ship step `push`: push the story branch to the remote.

export default {
  name: 'push',
  label: 'pushing the branch',
  needs: ['git'],

  async run(ctx) {
    const r = ctx.sh('git', ['push', '--quiet', '-u', ctx.config.remote, ctx.branch]);
    if (r.status === 0) return { ok: true };
    // git's own message is left out: it can show the remote URL, credentials and all.
    return { ok: false, code: 1, stage: 'push', reason: 'git push failed.' };
  },
};
