import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import watch from './watch.mjs';
import deployGithub from './deploy-github.mjs';
import { onFailureFor } from './registry.mjs';
import { runShip } from '../../engine/ship.mjs';
import { fakeCtx } from '../../../../test/ship-fakes.mjs';

const CMD = './scripts/errors-since-deploy.sh';
const ENV = { VERCEL_TOKEN: 'tok', PATH: '/bin' };

// answers: the exit status (or { status, stdout, stderr }) of each run of the command, in
// order; runs past the end pass.
const ctxFor = (answers = [], watchOptions = {}) => {
  let n = 0;
  return fakeCtx({
    config: { ship: { steps: ['watch'], watch: { command: CMD, ...watchOptions } } },
    rules: [[`sh -c ${CMD}`, () => (n < answers.length ? answers[n++] : 0)]],
    env: ENV,
    root: '/project',
  });
};
const runs = (ctx) => ctx.sh.calls.filter((c) => c === `sh -c ${CMD}`).length;

describe('watch step', () => {
  it('needs sh and halts on failure', () => {
    expect(watch.name).toBe('watch');
    expect(watch.needs).toEqual(['sh']);
    expect(watch.halts).toBe(true);
    expect(typeof watch.label).toBe('string');
  });

  it('by default runs the command every 60 s for 10 minutes and passes when it never complains', async () => {
    const ctx = ctxFor();
    expect(await watch.run(ctx)).toEqual({ ok: true });
    expect(runs(ctx)).toBe(11);
    expect(ctx.sleeps).toEqual(Array(10).fill(60_000));
  });

  it('follows minutes and everySeconds', async () => {
    const ctx = ctxFor([], { minutes: 1, everySeconds: 20 });
    expect(await watch.run(ctx)).toEqual({ ok: true });
    expect(runs(ctx)).toBe(4);
    expect(ctx.sleeps).toEqual([20_000, 20_000, 20_000]);
  });

  it('runs the command with the project env, env file values included, in the project root, for at most 120 s', async () => {
    const ctx = ctxFor([], { minutes: 1, everySeconds: 60 });
    await watch.run(ctx);
    const i = ctx.sh.calls.indexOf(`sh -c ${CMD}`);
    expect(ctx.sh.opts[i]).toEqual({ env: ENV, cwd: '/project', timeout: 120_000 });
  });

  it('follows timeoutSeconds', async () => {
    const ctx = ctxFor([], { minutes: 1, everySeconds: 60, timeoutSeconds: 30 });
    await watch.run(ctx);
    expect(ctx.sh.opts[ctx.sh.calls.indexOf(`sh -c ${CMD}`)].timeout).toBe(30_000);
  });

  it('a run that takes too long is a failure', async () => {
    const r = await watch.run(ctxFor([{ status: 1, timedOut: true, stdout: 'still checking' }], { timeoutSeconds: 30 }));
    expect(r).toEqual({ ok: false, code: 5, stage: 'watch', reason: `${CMD} did not finish within 30 s, so production could not be checked.` });
  });

  it('fails with code 5 at the first non-zero exit, quoting the end of its output', async () => {
    const ctx = ctxFor([0, { status: 1, stdout: 'checking\n', stderr: '3 new errors: TypeError in /api/orders\n' }], { minutes: 5, everySeconds: 60 });
    const r = await watch.run(ctx);
    expect(r).toEqual({
      ok: false,
      code: 5,
      stage: 'watch',
      reason: `${CMD} reported a problem after the deploy: checking 3 new errors: TypeError in /api/orders`,
    });
    expect(runs(ctx)).toBe(2);
  });

  it('keeps only the last 300 characters of the output', async () => {
    const long = `${'a'.repeat(400)}END`;
    const r = await watch.run(ctxFor([{ status: 2, stdout: long }]));
    const tail = r.reason.split('after the deploy: ')[1];
    expect(tail).toHaveLength(300);
    expect(tail.endsWith('END')).toBe(true);
  });

  it('redacts secrets in the output', async () => {
    const r = await watch.run(ctxFor([{ status: 1, stdout: 'auth failed with key sk_live_0123456789abcdef' }]));
    expect(r.reason).not.toContain('0123456789abcdef');
    expect(r.reason).toContain('auth failed');
  });

  it('says the exit code when the command prints nothing', async () => {
    const r = await watch.run(ctxFor([3]));
    expect(r.reason).toBe(`${CMD} reported a problem after the deploy: it exited 3 with no output.`);
  });

  it('in a release, a problem after the deploy exits 5 and writes HALT', async () => {
    const ctx = ctxFor([1]);
    const { code, result } = await runShip({ steps: [watch], ctx });
    expect(code).toBe(5);
    expect(result.stage).toBe('watch');
    expect(ctx.halts).toHaveLength(1);
  });
});

describe('watch with rollback, in a release', () => {
  const ROLLBACK = 'vercel rollback --yes';
  const merge = { name: 'merge', pointOfNoReturn: true, needs: [], run: () => ({ ok: true, sha: 'abc' }) };
  // The real deploy-github step, told by fake gh that the deployment of abc succeeded.
  const DEPLOYED = [
    ['gh api repos/{owner}/{repo}/deployments?sha=abc', '42\n'],
    ['gh api repos/{owner}/{repo}/deployments/42/statuses', 'success\n'],
  ];
  // The HALT goes to a real file, so the fake rollback command can look at it while it runs.
  const releaseCtx = (rollbackAnswer) => {
    const haltFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-watch-')), 'HALT');
    const ctx = fakeCtx({
      config: { ship: { steps: ['merge', 'deploy-github', 'watch'], watch: { command: CMD, minutes: 2 }, rollback: { command: ROLLBACK } } },
      rules: [
        ...DEPLOYED,
        [`sh -c ${CMD}`, (line, calls) => (calls.filter((c) => c === line).length >= 2 ? { status: 1, stdout: '5xx rate 12%' } : 0)],
        [`sh -c ${ROLLBACK}`, () => {
          ctx.haltDuringRollback = fs.existsSync(haltFile) ? fs.readFileSync(haltFile, 'utf8') : null;
          return rollbackAnswer;
        }],
      ],
      env: ENV,
      root: '/project',
    });
    ctx.halt = (result) => {
      ctx.halts.push(result);
      fs.writeFileSync(haltFile, `${JSON.stringify(result)}\n`);
    };
    ctx.haltFile = haltFile;
    return ctx;
  };
  const release = (ctx) => runShip({ steps: [merge, deployGithub, watch], ctx, onFailure: onFailureFor(ctx.config) });

  it('writes HALT before the rollback runs, rolls back once, then rewrites HALT with rolledBack true', async () => {
    const ctx = releaseCtx(0);
    const { code, result } = await release(ctx);
    expect(code).toBe(5);
    expect(JSON.parse(ctx.haltDuringRollback).reason).toBe(`Rolling back with \`${ROLLBACK}\`… ${CMD} reported a problem after the deploy: 5xx rate 12%`);
    expect(ctx.sh.calls.filter((c) => c === `sh -c ${ROLLBACK}`)).toHaveLength(1);
    expect(ctx.sh.opts[ctx.sh.calls.indexOf(`sh -c ${ROLLBACK}`)].timeout).toBe(300_000);
    expect(result).toMatchObject({ stage: 'watch', rolledBack: true });
    expect(result.reason).toBe(`Production was rolled back with \`${ROLLBACK}\`. ${CMD} reported a problem after the deploy: 5xx rate 12%`);
    expect(JSON.parse(fs.readFileSync(ctx.haltFile, 'utf8'))).toEqual(result);
  });

  it('says production may be broken when the rollback fails, and HALT stays written', async () => {
    const ctx = releaseCtx(1);
    const { code, result } = await release(ctx);
    expect(code).toBe(5);
    expect(result.rolledBack).toBe(false);
    expect(result.reason).toMatch(/^Rollback failed \(`vercel rollback --yes` exited 1\); production may be broken\. /);
    expect(JSON.parse(fs.readFileSync(ctx.haltFile, 'utf8'))).toEqual(result);
  });

  it('a rollback that runs out of time is a failed rollback', async () => {
    const { result } = await release(releaseCtx({ status: 1, timedOut: true }));
    expect(result.rolledBack).toBe(false);
    expect(result.reason).toMatch(/^Rollback failed \(`vercel rollback --yes` did not finish within 300 s\); production may be broken\. /);
  });
});

describe('watch healthy', () => {
  it('runs the command once and passes when it exits 0', async () => {
    const ctx = ctxFor();
    expect(await watch.healthy(ctx)).toEqual({ ok: true, reason: `${CMD} reports no problems.` });
    expect(runs(ctx)).toBe(1);
    expect(ctx.sleeps).toEqual([]);
  });

  it('fails with the end of the output when it exits non-zero', async () => {
    expect(await watch.healthy(ctxFor([{ status: 1, stdout: '2 errors in the last minute\n' }]))).toEqual({
      ok: false,
      reason: `${CMD} reported a problem: 2 errors in the last minute`,
    });
  });

  it('runs within timeoutSeconds and calls a run that takes too long unhealthy', async () => {
    const ctx = ctxFor([{ status: 1, timedOut: true }], { timeoutSeconds: 45 });
    expect(await watch.healthy(ctx)).toEqual({ ok: false, reason: `${CMD} did not finish within 45 s, so production could not be checked.` });
    expect(ctx.sh.opts[ctx.sh.calls.indexOf(`sh -c ${CMD}`)].timeout).toBe(45_000);
  });

  it('with no command configured has nothing to check', async () => {
    expect(await watch.healthy(fakeCtx())).toBeNull();
  });
});
