// Where the release is live, in the words the core watch and rollback steps use. A pack may say
// it (its optional `liveStage(config, ctx)` hook, documented in packs/index.mjs): the Salesforce pack
// gives the stage the release deployed to and that stage's org, a sandbox. Without a pack, a
// pack with no hook, a hook that gives nothing usable or one that throws, the answer is null and
// the steps say "production", as they always did.
//
//   liveWhere(ctx, packs?) -> { stage, org, text } | null     text is "<stage> (<org>)"
//
// Never throws. The pack is looked up inside the function only, never at load time.

import { PACKS, packFor } from '../../../packs/index.mjs';

const text = (value) => typeof value === 'string' && value.trim() !== '';

export function liveWhere(ctx, packs = PACKS) {
  try {
    const pack = packFor(ctx?.config, packs);
    if (typeof pack?.liveStage !== 'function') return null;
    const live = pack.liveStage(ctx.config, ctx);
    if (!text(live?.name) || !text(live?.org)) return null;
    return { stage: live.name, org: live.org, text: `${live.name} (${live.org})` };
  } catch {
    return null;
  }
}
