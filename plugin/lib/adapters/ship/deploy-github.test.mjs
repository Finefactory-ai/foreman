import { describe, expect, it } from 'vitest';
import deploy from './deploy-github.mjs';
import { runShip } from '../../engine/ship.mjs';
import { fakeCtx } from '../../../../test/ship-fakes.mjs';

const LIST = 'gh api repos/{owner}/{repo}/deployments?sha=';
const STATUSES = 'gh api repos/{owner}/{repo}/deployments/77/statuses';

// states: the deployment's state at each poll ('' = no deployment yet); the last repeats.
const ctxFor = (states, { options, sha = 'abc1234def', rules = [] } = {}) => {
  let i = -1;
  const now = () => states[Math.max(0, Math.min(i, states.length - 1))];
  return fakeCtx({
    sha,
    config: options ? { ship: { steps: ['deploy-github'], 'deploy-github': options } } : {},
    rules: [
      ...rules,
      [LIST, () => (i++, now() === '' ? '' : '77\n')],
      [STATUSES, () => `${now()}\n`],
    ],
  });
};
const waited = (ctx) => ctx.sleeps.reduce((a, b) => a + b, 0);

describe('deploy-github step', () => {
  it('needs gh and halts on failure', () => {
    expect(deploy.name).toBe('deploy-github');
    expect(deploy.needs).toEqual(['gh']);
    expect(deploy.halts).toBe(true);
  });

  it('is the deploy: once it passes, a later failure may roll production back', () => {
    expect(deploy.deploys).toBe(true);
  });

  it('waits for the merge sha\'s Production deployment to succeed, polling every 15 s', async () => {
    const ctx = ctxFor(['', 'pending', 'in_progress', 'success']);
    expect(await deploy.run(ctx)).toEqual({ ok: true });
    expect(ctx.sh.calls[0]).toBe(`${LIST}abc1234def&environment=Production --jq .[0].id // empty`);
    expect(ctx.sh.calls).toContain(`${STATUSES} --jq .[0].state // "pending"`);
    expect(ctx.sleeps).toEqual([15_000, 15_000, 15_000]);
  });

  it.each(['failure', 'error', 'inactive'])('a deployment that ends as %s exits 5 at stage deploy', async (state) => {
    const ctx = ctxFor(['pending', state]);
    const r = await deploy.run(ctx);
    expect(r).toEqual({ ok: false, code: 5, stage: 'deploy', reason: `Production deployment of abc1234 ended as "${state}".` });
    expect(ctx.sleeps).toEqual([15_000]);
  });

  it('gives up after the timeout with code 5', async () => {
    const ctx = ctxFor(['pending'], { options: { timeoutMinutes: 2 } });
    const r = await deploy.run(ctx);
    expect(r).toMatchObject({ ok: false, code: 5, stage: 'deploy' });
    expect(r.reason).toBe('Production deployment of abc1234 did not finish within 2 minutes (last seen "pending").');
    expect(waited(ctx)).toBeGreaterThanOrEqual(2 * 60_000);
    expect(waited(ctx)).toBeLessThan(2 * 60_000 + 15_000);
  });

  it('defaults to a 15-minute timeout, and a deployment that never appears times out', async () => {
    const ctx = ctxFor(['']);
    expect(await deploy.run(ctx)).toMatchObject({ ok: false, code: 5 });
    expect(waited(ctx)).toBeGreaterThanOrEqual(15 * 60_000);
    expect(waited(ctx)).toBeLessThan(15 * 60_000 + 15_000);
  });

  it('a gh call that fails counts as not ready yet', async () => {
    let n = 0;
    const ctx = ctxFor(['success'], { rules: [[LIST, () => (++n === 1 ? { status: 1, stderr: 'HTTP 502' } : '77\n')]] });
    expect(await deploy.run(ctx)).toEqual({ ok: true });
    expect(ctx.sleeps).toEqual([15_000]);
  });

  it('uses the configured environment, encoded for the URL', async () => {
    const ctx = ctxFor(['success'], { options: { environment: 'Preview – EU' } });
    await deploy.run(ctx);
    expect(ctx.sh.calls[0]).toContain(`environment=${encodeURIComponent('Preview – EU')}`);
  });

  it('leaves the rollback hint out of its reason: the halt email adds it', async () => {
    const ctx = ctxFor(['failure'], { options: { rollbackHint: 'Promote the previous deployment in Vercel.' } });
    expect((await deploy.run(ctx)).reason).toBe('Production deployment of abc1234 ended as "failure".');
  });

  describe('a host that refuses the deployment (statusContext)', () => {
    // Seen on a real run: Vercel's daily cap refused a deployment. No deployment is created then,
    // so the refusal shows only in the commit status the host posts under its own name.
    const COMMIT = 'gh api repos/{owner}/{repo}/commits/abc1234def/statuses';
    const REFUSED = [
      { context: 'ci', state: 'success', description: 'fine' },
      { context: 'Vercel', state: 'failure', description: 'Deployment rate limited — retry in 24 hours.' },
    ];

    it.each(['failure', 'error'])('stops at once when the named commit status is %s, giving the host\'s reason', async (state) => {
      const statuses = REFUSED.map((s) => (s.context === 'Vercel' ? { ...s, state } : s));
      const ctx = ctxFor([''], { options: { statusContext: 'Vercel' }, rules: [[COMMIT, JSON.stringify(statuses)]] });
      expect(await deploy.run(ctx)).toEqual({
        ok: false,
        code: 5,
        stage: 'deploy',
        reason: 'Vercel refused the deployment: Deployment rate limited — retry in 24 hours. Production still runs the previous version.',
      });
      expect(ctx.sleeps).toEqual([]);
    });

    it('names the state when the host gives no description', async () => {
      const ctx = ctxFor([''], { options: { statusContext: 'Vercel' }, rules: [[COMMIT, JSON.stringify([{ context: 'Vercel', state: 'error' }])]] });
      expect((await deploy.run(ctx)).reason).toBe('Vercel refused the deployment ("error"). Production still runs the previous version.');
    });

    it('keeps waiting while the status is pending, missing, unreadable or another context\'s', async () => {
      const answers = [
        JSON.stringify([{ context: 'Vercel', state: 'pending', description: 'Building' }]),
        JSON.stringify([{ context: 'ci', state: 'failure', description: 'x' }]),
        '[]',
        { status: 1, stderr: 'HTTP 502' },
        'not json',
      ];
      let n = 0;
      const ctx = ctxFor(['', '', '', '', '', 'success'], { options: { statusContext: 'Vercel' }, rules: [[COMMIT, () => answers[n++]]] });
      expect(await deploy.run(ctx)).toEqual({ ok: true });
      expect(n).toBe(5);
    });

    it('reads the commit status only while no deployment exists', async () => {
      const ctx = ctxFor(['pending', 'success'], { options: { statusContext: 'Vercel' }, rules: [[COMMIT, JSON.stringify(REFUSED)]] });
      expect(await deploy.run(ctx)).toEqual({ ok: true });
      expect(ctx.sh.calls.some((c) => c.startsWith(COMMIT))).toBe(false);
    });

    it('without statusContext never reads commit statuses', async () => {
      const ctx = ctxFor(['', 'success'], { rules: [[COMMIT, JSON.stringify(REFUSED)]] });
      expect(await deploy.run(ctx)).toEqual({ ok: true });
      expect(ctx.sh.calls.some((c) => c.startsWith(COMMIT))).toBe(false);
    });

    it('in a release, a refusal exits 5 and writes HALT', async () => {
      const ctx = ctxFor([''], { sha: null, options: { statusContext: 'Vercel' }, rules: [[COMMIT, JSON.stringify(REFUSED)]] });
      const merge = { name: 'merge', pointOfNoReturn: true, run: () => ({ ok: true, sha: 'abc1234def' }) };
      const { code, result } = await runShip({ steps: [merge, deploy], ctx });
      expect(code).toBe(5);
      expect(result).toMatchObject({ stage: 'deploy', reason: expect.stringContaining('Deployment rate limited') });
      expect(ctx.halts).toHaveLength(1);
    });
  });

  it('without a merge sha it exits 5 without asking GitHub', async () => {
    const ctx = ctxFor(['success'], { sha: null });
    expect(await deploy.run(ctx)).toMatchObject({ ok: false, code: 5, stage: 'deploy' });
    expect(ctx.sh.calls.some((c) => c.startsWith('gh api'))).toBe(false);
  });

  it('in a release, a failed deployment exits 5 and writes HALT', async () => {
    const ctx = ctxFor(['error'], { sha: null });
    const merge = { name: 'merge', pointOfNoReturn: true, run: () => ({ ok: true, sha: 'abc1234def' }) };
    const { code, result } = await runShip({ steps: [merge, deploy], ctx });
    expect(code).toBe(5);
    expect(result).toMatchObject({ stage: 'deploy', sha: 'abc1234def' });
    expect(ctx.halts).toHaveLength(1);
  });
});

describe('deploy-github healthy() (part of "I\'ve fixed it")', () => {
  // Seen on a real run: a story merged but never deployed passed the check and would have been
  // marked done while not live. The newest base commit must have a successful deployment.
  const MAIN = 'cd1a5ac9c2e3f00d';
  const DEPLOYS = `gh api repos/{owner}/{repo}/deployments?sha=${MAIN}&environment=Production --jq .[].id`;
  const statusOf = (id) => `gh api repos/{owner}/{repo}/deployments/${id}/statuses --jq .[0].state // ""`;
  const healthCtx = (rules, options) =>
    fakeCtx({
      config: options ? { ship: { steps: ['deploy-github'], 'deploy-github': options } } : {},
      rules: [['git rev-parse origin/main', `${MAIN}\n`], ...rules],
    });

  it('passes when any deployment of the newest base commit succeeded (a redeploy makes a new one)', async () => {
    const ctx = healthCtx([[DEPLOYS, '91\n90\n'], [statusOf(91), 'failure\n'], [statusOf(90), 'success\n']]);
    expect(await deploy.healthy(ctx)).toEqual({ ok: true, reason: 'The newest main (cd1a5ac) is live.' });
    expect(ctx.sh.calls[0]).toBe('git fetch --quiet origin main');
  });

  it('fails when no deployment of it succeeded, naming the commit', async () => {
    for (const rules of [[[DEPLOYS, '']], [[DEPLOYS, '91\n'], [statusOf(91), 'in_progress\n']], [[DEPLOYS, '91\n'], [statusOf(91), { status: 1 }]]]) {
      const r = await deploy.healthy(healthCtx(rules));
      expect(r).toEqual({ ok: false, reason: 'The newest main (cd1a5ac) is not live yet: Production still runs an older version. Redeploy it, then press "I\'ve fixed it" again.' });
    }
  });

  it('uses the configured environment', async () => {
    const ctx = healthCtx([[`gh api repos/{owner}/{repo}/deployments?sha=${MAIN}&environment=Live --jq .[].id`, '5\n'], [statusOf(5), 'success\n']], { environment: 'Live' });
    expect((await deploy.healthy(ctx)).ok).toBe(true);
  });

  it('fails, saying why, when the base or the deployments cannot be read', async () => {
    const noFetch = healthCtx([['git fetch', 1]]);
    expect(await deploy.healthy(noFetch)).toEqual({ ok: false, reason: 'Could not read the newest main from origin.' });
    const noList = healthCtx([[DEPLOYS, { status: 1, stderr: 'HTTP 502' }]]);
    expect(await deploy.healthy(noList)).toEqual({ ok: false, reason: 'Could not read the Production deployments from GitHub.' });
  });
});
