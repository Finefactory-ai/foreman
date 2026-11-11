import { describe, expect, it } from 'vitest';
import { liveWhere } from './live-stage.mjs';

const packs = (liveStage) => ({ acme: { name: 'acme', ...(liveStage ? { liveStage } : {}) } });
const ctx = { config: { pack: 'acme' } };

describe('liveWhere', () => {
  it('gives the stage, org and words the pack names', () => {
    expect(liveWhere(ctx, packs(() => ({ name: 'qa', org: 'acme-qa' })))).toEqual({ stage: 'qa', org: 'acme-qa', text: 'qa (acme-qa)' });
  });

  it('hands the pack the config and the ctx', () => {
    let seen;
    liveWhere({ ...ctx, sfDeploys: { qa: {} } }, packs((config, c) => { seen = [config, c.sfDeploys]; return null; }));
    expect(seen).toEqual([{ pack: 'acme' }, { qa: {} }]);
  });

  it('gives null with no pack, no hook, an unknown pack, a throw or an unusable answer', () => {
    expect(liveWhere({ config: {} }, packs(() => ({ name: 'qa', org: 'x' })))).toBeNull();
    expect(liveWhere(ctx, packs())).toBeNull();
    expect(liveWhere({ config: { pack: 'nope' } }, packs(() => ({ name: 'qa', org: 'x' })))).toBeNull();
    expect(liveWhere(ctx, packs(() => { throw new Error('no'); }))).toBeNull();
    for (const answer of [null, undefined, {}, { name: 'qa' }, { org: 'x' }, { name: '', org: 'x' }, { name: 'qa', org: 7 }, 'qa']) {
      expect(liveWhere(ctx, packs(() => answer))).toBeNull();
    }
    expect(liveWhere(undefined)).toBeNull();
  });
});
