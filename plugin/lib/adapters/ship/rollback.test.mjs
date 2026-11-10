import { describe, expect, it } from 'vitest';
import rollback from './rollback.mjs';
import { fakeCtx } from '../../../../test/ship-fakes.mjs';

const CMD = 'vercel rollback --yes';
const ENV = { VERCEL_TOKEN: 'tok' };
const ctxFor = (answer = 0, options = {}) =>
  fakeCtx({ config: { ship: { steps: ['merge'], rollback: { command: CMD, ...options } } }, rules: [[`sh -c ${CMD}`, answer]], env: ENV, root: '/project' });

describe('rollback step', () => {
  it('needs sh and has no health check', () => {
    expect(rollback.name).toBe('rollback');
    expect(rollback.needs).toEqual(['sh']);
    expect(rollback.healthy).toBeUndefined();
  });

  it('names its command, redacted, before it runs', () => {
    expect(rollback.commandFor({ ship: { rollback: { command: CMD } } })).toBe(CMD);
    expect(rollback.commandFor({ ship: { rollback: { command: 'deploy --key sk_live_0123456789abcdef' } } })).not.toContain('0123456789abcdef');
  });

  it('runs the command once with the project env in the project root, for at most 300 s', async () => {
    const ctx = ctxFor();
    expect(await rollback.run(ctx)).toEqual({ ok: true, command: CMD });
    expect(ctx.sh.calls.filter((c) => c.startsWith('sh -c'))).toEqual([`sh -c ${CMD}`]);
    expect(ctx.sh.opts[ctx.sh.calls.indexOf(`sh -c ${CMD}`)]).toEqual({ env: { ...ENV, FOREMAN_STORY: 'S-1' }, cwd: '/project', timeout: 300_000 });
  });

  it('follows timeoutSeconds', async () => {
    const ctx = ctxFor(0, { timeoutSeconds: 60 });
    await rollback.run(ctx);
    expect(ctx.sh.opts[ctx.sh.calls.indexOf(`sh -c ${CMD}`)].timeout).toBe(60_000);
  });

  it('reports the exit code and the end of the output when the command fails', async () => {
    expect(await rollback.run(ctxFor({ status: 2, stderr: 'no previous deployment\n' }))).toEqual({
      ok: false,
      command: CMD,
      exitCode: 2,
      why: 'exited 2',
      tail: 'no previous deployment',
    });
  });

  it('a command that takes too long is a failed rollback', async () => {
    expect(await rollback.run(ctxFor({ status: 1, timedOut: true }, { timeoutSeconds: 60 }))).toMatchObject({ ok: false, command: CMD, why: 'did not finish within 60 s' });
  });

  it("gives the command the story's id as FOREMAN_STORY, over one already in the env", async () => {
    const ctx = fakeCtx({ config: { ship: { steps: ['merge'], rollback: { command: CMD } } }, env: { ...ENV, FOREMAN_STORY: 'S-0' }, root: '/project' });
    await rollback.run(ctx);
    expect(ctx.sh.opts[ctx.sh.calls.indexOf(`sh -c ${CMD}`)].env).toEqual({ ...ENV, FOREMAN_STORY: 'S-1' });
  });

  it('leaves the env as it is without a story', async () => {
    const ctx = ctxFor();
    ctx.story = '';
    await rollback.run(ctx);
    expect(ctx.sh.opts[ctx.sh.calls.indexOf(`sh -c ${CMD}`)].env).toBe(ENV);
  });
});
