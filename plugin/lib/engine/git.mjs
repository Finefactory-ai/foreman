// Small git helpers over an injected shell (ctx.sh), shared by the ship runner and its steps.

export const lines = (text) => String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);

// stdout of a command that succeeded, trimmed, or null.
export function out(ctx, cmd, args) {
  const r = ctx.sh(cmd, args);
  return r.status === 0 ? String(r.stdout ?? '').trim() : null;
}

// True while a merge is staged but not committed (MERGE_HEAD is set).
export function mergeInProgress(ctx) {
  return Boolean(out(ctx, 'git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD']));
}

// Several worktrees share one repository; a fetch can trip over another's ref lock.
export async function fetchBase(ctx) {
  const { remote, baseBranch } = ctx.config;
  for (let i = 0; i < 3; i++) {
    if (ctx.sh('git', ['fetch', '--quiet', remote, baseBranch]).status === 0) return true;
    if (i < 2) await ctx.sleep(3_000);
  }
  return false;
}
