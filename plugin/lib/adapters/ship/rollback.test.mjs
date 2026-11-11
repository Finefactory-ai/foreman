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

  describe('manual steps on the last line of stdout', () => {
    const STEP = 'Delete agent Acme_Order_Helper in acme-qa by hand in Setup > Agentforce Agents: the rollback deactivated it';
    const out = (stdout) => ({ status: 0, stdout, stderr: '' });

    it('returns them when the command ends its stdout with a JSON line holding manualSteps', async () => {
      const stdout = `rolled S-1 back on acme-qa (qa)\n  by hand: ${STEP}\n${JSON.stringify({ ok: true, manualSteps: [STEP] })}\n`;
      expect(await rollback.run(ctxFor(out(stdout)))).toEqual({ ok: true, command: CMD, manualSteps: [STEP] });
    });

    it('returns exactly { ok, command } for output that is not JSON, JSON without manualSteps, or an empty list', async () => {
      for (const stdout of ['rolled back\n', '', '{"ok":true}\n', '{"ok":true,"manualSteps":[]}\n', '{"ok":true,"manualSteps":"a"}\n', '[1]\n', 'null\n', '{"manualSteps":[1,"",null]}\n']) {
        expect(await rollback.run(ctxFor(out(stdout)))).toEqual({ ok: true, command: CMD });
      }
    });

    it('reads only the last non-empty line', async () => {
      const first = JSON.stringify({ ok: true, manualSteps: ['not this one'] });
      expect(await rollback.run(ctxFor(out(`${first}\nrolled back\n\n`)))).toEqual({ ok: true, command: CMD });
    });

    it('redacts a secret-looking value inside a step and keeps only non-empty strings', async () => {
      const stdout = `${JSON.stringify({ ok: true, manualSteps: ['Delete the key sk_live_0123456789abcdef by hand', '', 7, 'Second step'] })}\n`;
      const r = await rollback.run(ctxFor(out(stdout)));
      expect(r.manualSteps).toHaveLength(2);
      expect(r.manualSteps[0]).not.toContain('0123456789abcdef');
      expect(r.manualSteps[1]).toBe('Second step');
    });

    it('parses the line before redacting, so a secret at the end of a step cannot break the JSON', async () => {
      const stdout = `${JSON.stringify({ ok: true, manualSteps: ['Second step', 'Rotate ACME_TOKEN=s3cr3tvalue'] })}\n`;
      const r = await rollback.run(ctxFor(out(stdout)));
      expect(r).toEqual({ ok: true, command: CMD, manualSteps: ['Second step', 'Rotate ACME_TOKEN=•••'] });
      expect(JSON.stringify(r)).not.toContain('s3cr3tvalue');
    });

    it('cuts the list to 20 steps and each step to 300 characters', async () => {
      const steps = Array.from({ length: 25 }, (_, i) => `Step ${i} ${'x'.repeat(400)}`);
      const r = await rollback.run(ctxFor(out(`${JSON.stringify({ ok: true, manualSteps: steps })}\n`)));
      expect(r.manualSteps).toHaveLength(20);
      expect(r.manualSteps[0]).toHaveLength(300);
      expect(r.manualSteps[19].startsWith('Step 19 ')).toBe(true);
    });

    it('returns no steps for a failed command, even with a JSON line', async () => {
      const r = await rollback.run(ctxFor({ status: 1, stdout: `${JSON.stringify({ ok: false, manualSteps: ['a'] })}\n`, stderr: '' }));
      expect(r).not.toHaveProperty('manualSteps');
      expect(r.ok).toBe(false);
    });
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
