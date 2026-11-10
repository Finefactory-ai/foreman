// Ship step `resources`: one story at a time may change an exclusive resource (config
// `resources`, such as the database schema). Normally the slot took the resource when it
// picked the story; a branch that grew changes to one without it takes it now if it is free,
// and stops (code 7) when another live slot holds it.

import { matchesGlob } from '../../engine/glob.mjs';
import { lines } from '../../engine/git.mjs';

const STAGE = 'resources';

export default {
  name: 'resources',
  label: 'checking exclusive resources',
  needs: ['git'],

  async run(ctx) {
    const { remote, baseBranch, resources = {} } = ctx.config;
    const entries = Object.entries(resources);
    if (entries.length === 0) return { ok: true, resources: [] };

    const diff = ctx.sh('git', ['diff', '--name-only', `${remote}/${baseBranch}...HEAD`]);
    if (diff.status !== 0) return { ok: false, code: 1, stage: STAGE, reason: `Could not list the files the branch changes against ${remote}/${baseBranch}.` };
    const changed = lines(diff.stdout);

    const taken = [];
    for (const [name, r] of entries) {
      if (!changed.some((f) => r.paths.some((p) => matchesGlob(f, p)))) continue;
      const key = `resource:${name}`;
      const holder = ctx.locks.holderOf(key);
      const heldElsewhere = (h) => ({
        ok: false,
        code: 7,
        stage: STAGE,
        resource: name,
        reason: `The branch changes ${name} (${r.describe}) and slot ${h?.slot ?? '?'} holds it (${h?.story ?? 'a story'}).`,
      });
      if (holder && !holder.stale && holder.slot !== ctx.slot) return heldElsewhere(holder);
      if (!holder || holder.stale) {
        if (holder?.stale) ctx.locks.breakIfStale(key);
        const got = ctx.locks.take(key, { pid: ctx.holderPid, slot: ctx.slot, story: ctx.story, by: 'factory', at: ctx.now().toISOString() });
        if (!got.ok) return heldElsewhere(got.holder);
      }
      taken.push(name);
    }
    return { ok: true, resources: taken };
  },
};
