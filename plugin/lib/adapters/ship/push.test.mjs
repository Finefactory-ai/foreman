import { describe, expect, it } from 'vitest';
import push from './push.mjs';
import { fakeCtx } from '../../../../test/ship-fakes.mjs';

describe('push step', () => {
  it('pushes the branch to the remote', async () => {
    const ctx = fakeCtx({ branch: 'story/s-1' });
    expect(await push.run(ctx)).toEqual({ ok: true });
    expect(ctx.sh.calls).toContain('git push --quiet -u origin story/s-1');
  });
  it('a failed push exits 1', async () => {
    const ctx = fakeCtx({ branch: 'story/s-1', rules: [['git push', { status: 1, stderr: 'fatal: https://user:tok3n@github.com/x rejected\n' }]] });
    const r = await push.run(ctx);
    expect(r).toEqual({ ok: false, code: 1, stage: 'push', reason: 'git push failed.' });
  });
});
