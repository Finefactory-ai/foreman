import { describe, expect, it } from 'vitest';
import ci from './ci.mjs';
import { fakeCtx } from '../../../../test/ship-fakes.mjs';

const run = (name, status, conclusion = '') => ({ __typename: 'CheckRun', name, status, conclusion });
const vercel = (state) => ({ __typename: 'StatusContext', context: 'Vercel', state });
const rollup = (...checks) => JSON.stringify({ statusCheckRollup: checks });

// polls: one answer per poll; the last one repeats.
const ctxFor = (polls, config = {}) => {
  let i = 0;
  return fakeCtx({
    branch: 'story/s-1',
    pr: 'https://gh/pull/12',
    prNumber: 12,
    config,
    rules: [['gh pr view 12 --json statusCheckRollup', () => polls[Math.min(i++, polls.length - 1)]]],
  });
};

describe('ci step', () => {
  it('is marked as testing the merged code, so merge-main leaves the checks to CI', () => {
    expect(ci.testsMergedCode).toBe(true);
  });
});

describe('ci step, with no required names', () => {
  const waited = (ctx) => ctx.sleeps.reduce((a, b) => a + b, 0);

  it('waits for every check to finish and settle, then passes', async () => {
    const ctx = ctxFor([rollup(), rollup(run('test', 'IN_PROGRESS'), vercel('PENDING')), rollup(run('test', 'COMPLETED', 'SUCCESS'), vercel('SUCCESS'))]);
    expect(await ci.run(ctx)).toEqual({ ok: true });
    // all done at 40 s; passes once 90 s have passed with nothing new
    expect(waited(ctx)).toBeGreaterThanOrEqual(40_000 + 90_000);
    expect(waited(ctx)).toBeLessThan(40_000 + 90_000 + 20_000);
  });

  it('does not pass on a lone finished Vercel check before CI shows up', async () => {
    const ctx = ctxFor([
      rollup(vercel('SUCCESS')),
      rollup(vercel('SUCCESS'), run('ci', 'IN_PROGRESS')),
      rollup(vercel('SUCCESS'), run('ci', 'COMPLETED', 'SUCCESS')),
    ]);
    expect(await ci.run(ctx)).toEqual({ ok: true });
    expect(ctx.sh.calls.length).toBeGreaterThanOrEqual(3);
    expect(waited(ctx)).toBeGreaterThanOrEqual(40_000 + 90_000);
  });

  it('a check that appears during the settle window restarts it, and its failure counts', async () => {
    const ctx = ctxFor([
      rollup(vercel('SUCCESS')),
      rollup(vercel('SUCCESS')),
      rollup(vercel('SUCCESS'), run('ci', 'COMPLETED', 'FAILURE')),
    ]);
    const r = await ci.run(ctx);
    expect(r).toMatchObject({ ok: false, code: 2 });
    expect(r.reason).toContain('ci');
  });

  it('a new finished check restarts the settle window', async () => {
    const ctx = ctxFor([rollup(vercel('SUCCESS')), rollup(vercel('SUCCESS'), run('ci', 'COMPLETED', 'SUCCESS'))]);
    expect(await ci.run(ctx)).toEqual({ ok: true });
    // without the restart it would pass at 100 s, 90 s after the first poll
    expect(waited(ctx)).toBeGreaterThanOrEqual(20_000 + 90_000);
  });

  it('uses ship.ci.settleSeconds', async () => {
    const ctx = ctxFor([rollup(run('test', 'COMPLETED', 'SUCCESS'))], { ship: { steps: ['ci'], ci: { settleSeconds: 20 } } });
    expect(await ci.run(ctx)).toEqual({ ok: true });
    expect(waited(ctx)).toBe(20_000);
  });

  it('counts skipped and neutral checks as passed', async () => {
    const ctx = ctxFor([rollup(run('test', 'COMPLETED', 'SUCCESS'), run('opt', 'COMPLETED', 'SKIPPED'), run('n', 'COMPLETED', 'NEUTRAL'))]);
    expect(await ci.run(ctx)).toEqual({ ok: true });
  });

  it('reports gh failing while polling as such, not as CI never starting', async () => {
    const ctx = fakeCtx({ branch: 'story/s-1', pr: 'u', prNumber: 12, config: { ship: { steps: ['ci'], ci: { timeoutMinutes: 1 } } }, rules: [['gh pr view 12', { status: 1, stderr: 'HTTP 502' }]] });
    const r = await ci.run(ctx);
    expect(r).toMatchObject({ ok: false, code: 2 });
    expect(r.reason).not.toBe('CI never started on the pull request.');
    expect(r.reason).toMatch(/could not read/i);
    // Only a refusal sends the step to the REST APIs; a 502 is retried as it is.
    expect(ctx.sh.calls.some((c) => c.startsWith('gh api'))).toBe(false);
  });

  it('fails when any check fails', async () => {
    const ctx = ctxFor([rollup(run('test', 'COMPLETED', 'FAILURE'), vercel('SUCCESS'))]);
    const r = await ci.run(ctx);
    expect(r).toMatchObject({ ok: false, code: 2, stage: 'ci', pr: 'https://gh/pull/12' });
    expect(r.reason).toContain('test');
  });

  it('fails when no check ever appears within the timeout', async () => {
    const ctx = ctxFor([rollup()], { ship: { steps: ['ci'], ci: { required: [], timeoutMinutes: 5 } } });
    const r = await ci.run(ctx);
    expect(r).toMatchObject({ ok: false, code: 2, reason: 'CI never started on the pull request.' });
    expect(ctx.sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(5 * 60_000);
    expect(ctx.sleeps.reduce((a, b) => a + b, 0)).toBeLessThan(6 * 60_000);
  });

  it('fails when checks never finish within the timeout', async () => {
    const ctx = ctxFor([rollup(run('test', 'IN_PROGRESS'))], { ship: { steps: ['ci'], ci: { timeoutMinutes: 1 } } });
    const r = await ci.run(ctx);
    expect(r).toMatchObject({ ok: false, code: 2 });
    expect(r.reason).toContain('1 minute');
  });

  it('defaults to a 30-minute timeout when ship.ci is absent', async () => {
    const ctx = ctxFor([rollup()], { ship: { steps: ['ci'] } });
    await ci.run(ctx);
    const waited = ctx.sleeps.reduce((a, b) => a + b, 0);
    expect(waited).toBeGreaterThanOrEqual(30 * 60_000);
    expect(waited).toBeLessThan(31 * 60_000);
  });
});

describe('ci step, with required names', () => {
  const config = { ship: { steps: ['ci'], ci: { required: ['unit tests', 'integration'] } } };

  it('only the named checks count: a passing Vercel check alone is not CI', async () => {
    const ctx = ctxFor([rollup(vercel('SUCCESS'), run('unit tests', 'COMPLETED', 'SUCCESS'))], { ship: { ...config.ship, ci: { ...config.ship.ci, timeoutMinutes: 2 } } });
    const r = await ci.run(ctx);
    expect(r).toMatchObject({ ok: false, code: 2, reason: 'CI never started on the pull request.' });
  });

  it('waits for each named check to appear and finish, and passes when all pass', async () => {
    const ctx = ctxFor([
      rollup(vercel('SUCCESS')),
      rollup(vercel('SUCCESS'), run('unit tests', 'IN_PROGRESS'), run('integration', 'QUEUED')),
      rollup(vercel('FAILURE'), run('unit tests', 'COMPLETED', 'SUCCESS'), run('integration', 'COMPLETED', 'SUCCESS'), run('other', 'COMPLETED', 'FAILURE')),
    ], config);
    expect(await ci.run(ctx)).toEqual({ ok: true });
  });

  it('every check sharing a required name must pass', async () => {
    const ctx = ctxFor([rollup(run('unit tests', 'COMPLETED', 'SUCCESS'), run('unit tests', 'COMPLETED', 'FAILURE'), run('integration', 'COMPLETED', 'SUCCESS'))], config);
    const r = await ci.run(ctx);
    expect(r).toMatchObject({ ok: false, code: 2 });
    expect(r.reason).toContain('unit tests');
  });

  it('waits for every check sharing a required name to finish', async () => {
    const ctx = ctxFor([
      rollup(run('unit tests', 'COMPLETED', 'SUCCESS'), run('unit tests', 'IN_PROGRESS'), run('integration', 'COMPLETED', 'SUCCESS')),
      rollup(run('unit tests', 'COMPLETED', 'SUCCESS'), run('unit tests', 'COMPLETED', 'SUCCESS'), run('integration', 'COMPLETED', 'SUCCESS')),
    ], config);
    expect(await ci.run(ctx)).toEqual({ ok: true });
    expect(ctx.sleeps).toEqual([20_000]);
  });

  it('fails when a named check fails', async () => {
    const ctx = ctxFor([rollup(run('unit tests', 'COMPLETED', 'SUCCESS'), run('integration', 'COMPLETED', 'FAILURE'))], config);
    const r = await ci.run(ctx);
    expect(r).toMatchObject({ ok: false, code: 2 });
    expect(r.reason).toContain('integration');
  });
});

// A fine-grained token has no Checks permission, so statusCheckRollup is refused (seen on a
// real run on 2026-10-19). The step then reads GitHub Actions and commit statuses.
describe('ci step, when the token cannot read check runs', () => {
  const REFUSED = { status: 1, stderr: 'GraphQL: Resource not accessible by personal access token (repository.pullRequest.commits.nodes.0.commit.statusCheckRollup.contexts)' };
  const API = 'gh api repos/{owner}/{repo}';
  const job = (name, status, conclusion = null) => ({ name, status, conclusion });
  const status = (context, state) => ({ context, state });
  // polls: one answer per poll, each { runs: [{ id, name, status, conclusion, jobs }], statuses }; the last repeats.
  const restCtx = (polls, config = {}, { sha = 'abc123', refuse = {} } = {}) => {
    let i = -1;
    const poll = () => polls[Math.min(i, polls.length - 1)];
    const answer = (what, body) => refuse[what] ?? JSON.stringify(body());
    return fakeCtx({
      branch: 'story/s-1',
      pr: 'https://gh/pull/12',
      prNumber: 12,
      config,
      rules: [
        ['gh pr view 12 --json statusCheckRollup', REFUSED],
        [`${API}/pulls/12`, () => (i++, answer('pulls', () => ({ number: 12, head: { sha } })))],
        [new RegExp(`^gh api repos/\\{owner\\}/\\{repo\\}/actions/runs/(\\d+)/jobs\\?per_page=100$`), (line) => {
          const id = Number(line.match(/runs\/(\d+)\/jobs/)[1]);
          return answer('jobs', () => ({ jobs: poll().runs.find((r) => r.id === id).jobs ?? [] }));
        }],
        [`${API}/actions/runs?head_sha=${sha}&per_page=100`, () => answer('runs', () => ({ workflow_runs: poll().runs.map(({ jobs, ...run }) => run) }))],
        [`${API}/commits/${sha}/status?per_page=100`, () => answer('statuses', () => ({ statuses: poll().statuses ?? [] }))],
      ],
    });
  };
  const ciRun = (status, conclusion, jobs) => ({ id: 7, name: 'CI', status, conclusion, jobs });
  const config = { ship: { steps: ['ci'], ci: { required: ['unit tests', 'integration'] } } };

  it('passes when the required Actions jobs pass, asking for statusCheckRollup only once', async () => {
    const ctx = restCtx([
      { runs: [] },
      { runs: [ciRun('in_progress', null, [job('unit tests', 'in_progress'), job('integration', 'queued')])] },
      { runs: [ciRun('completed', 'success', [job('unit tests', 'completed', 'success'), job('integration', 'completed', 'success')])] },
    ], config);
    expect(await ci.run(ctx)).toEqual({ ok: true });
    expect(ctx.sleeps).toEqual([20_000, 20_000]);
    expect(ctx.sh.calls.filter((c) => c.includes('statusCheckRollup'))).toHaveLength(1);
  });

  it('fails naming the Actions job that failed', async () => {
    const ctx = restCtx([{ runs: [ciRun('completed', 'failure', [job('unit tests', 'completed', 'success'), job('integration', 'completed', 'failure')])] }], config);
    const r = await ci.run(ctx);
    expect(r).toMatchObject({ ok: false, code: 2, stage: 'ci' });
    expect(r.reason).toContain('integration');
    expect(r.reason).not.toContain('unit tests');
  });

  it('with no required names, counts jobs and commit statuses, and settles before passing', async () => {
    const ctx = restCtx([
      { runs: [], statuses: [status('Vercel', 'success')] },
      { runs: [ciRun('in_progress', null, [job('test', 'in_progress'), job('lint', 'completed', 'skipped')])], statuses: [status('Vercel', 'success')] },
      { runs: [ciRun('completed', 'success', [job('test', 'completed', 'success'), job('lint', 'completed', 'skipped')])], statuses: [status('Vercel', 'success')] },
    ]);
    expect(await ci.run(ctx)).toEqual({ ok: true });
    const waited = ctx.sleeps.reduce((a, b) => a + b, 0);
    expect(waited).toBeGreaterThanOrEqual(40_000 + 90_000);
    expect(waited).toBeLessThan(40_000 + 90_000 + 20_000);
  });

  it('a failing commit status fails the step', async () => {
    const ctx = restCtx([{ runs: [ciRun('completed', 'success', [job('test', 'completed', 'success')])], statuses: [status('ci/circleci', 'failure')] }]);
    const r = await ci.run(ctx);
    expect(r).toMatchObject({ ok: false, code: 2 });
    expect(r.reason).toContain('ci/circleci');
  });

  it('a workflow run with no jobs yet keeps the step waiting', async () => {
    const ctx = restCtx([
      { runs: [ciRun('queued', null, [])], statuses: [status('Vercel', 'success')] },
      { runs: [ciRun('queued', null, [])], statuses: [status('Vercel', 'success')] },
      { runs: [ciRun('queued', null, [])], statuses: [status('Vercel', 'success')] },
      { runs: [ciRun('queued', null, [])], statuses: [status('Vercel', 'success')] },
      { runs: [ciRun('queued', null, [])], statuses: [status('Vercel', 'success')] },
      { runs: [ciRun('queued', null, [])], statuses: [status('Vercel', 'success')] },
      { runs: [ciRun('completed', 'failure', [job('test', 'completed', 'failure')])], statuses: [status('Vercel', 'success')] },
    ]);
    const r = await ci.run(ctx);
    expect(r).toMatchObject({ ok: false, code: 2 });
    expect(r.reason).toContain('test');
  });

  it('a workflow run that ended with no jobs counts as itself', async () => {
    const ctx = restCtx([{ runs: [ciRun('completed', 'startup_failure', [])] }]);
    const r = await ci.run(ctx);
    expect(r).toMatchObject({ ok: false, code: 2 });
    expect(r.reason).toContain('CI');
  });

  it('when a required check never appears, says that checks other apps post are not seen', async () => {
    const ctx = restCtx([{ runs: [ciRun('completed', 'success', [job('unit tests', 'completed', 'success')])] }], { ship: { steps: ['ci'], ci: { ...config.ship.ci, timeoutMinutes: 1 } } });
    const r = await ci.run(ctx);
    expect(r).toMatchObject({ ok: false, code: 2 });
    expect(r.reason).toMatch(/^CI never started on the pull request\./);
    expect(r.reason).toMatch(/cannot read check runs/);
    expect(r.reason).toMatch(/other apps/);
    expect(r.reason).toMatch(/classic token with the `repo` scope/);
  });

  it('when the Actions API is refused too, says which permissions a fine-grained token needs', async () => {
    const ctx = restCtx([{ runs: [] }], { ship: { steps: ['ci'], ci: { timeoutMinutes: 1 } } }, { refuse: { runs: { status: 1, stderr: 'gh: Resource not accessible by personal access token (HTTP 403)' } } });
    const r = await ci.run(ctx);
    expect(r).toMatchObject({ ok: false, code: 2 });
    expect(r.reason).toMatch(/could not read/i);
    expect(r.reason).toMatch(/Actions and Commit statuses read/);
    expect(r.reason).toContain('HTTP 403');
  });

  it('follows the head commit when it changes', async () => {
    let sha = 'old1';
    const ctx = fakeCtx({
      branch: 'story/s-1', pr: 'u', prNumber: 12, config,
      rules: [
        ['gh pr view 12 --json statusCheckRollup', REFUSED],
        [`${API}/pulls/12`, () => JSON.stringify({ head: { sha } })],
        [/actions\/runs\/7\/jobs/, () => JSON.stringify({ jobs: sha === 'old1' ? [job('unit tests', 'completed', 'failure')] : [job('unit tests', 'completed', 'success'), job('integration', 'completed', 'success')] })],
        [/actions\/runs\?head_sha=/, (line) => {
          const answer = JSON.stringify({ workflow_runs: line.includes('head_sha=new2') ? [{ id: 7, name: 'CI', status: 'completed', conclusion: 'success' }] : [] });
          sha = 'new2';
          return answer;
        }],
        [/commits\/\w+\/status/, JSON.stringify({ statuses: [] })],
      ],
    });
    expect(await ci.run(ctx)).toEqual({ ok: true });
    expect(ctx.sh.calls.some((c) => c.includes('head_sha=new2'))).toBe(true);
  });
});
