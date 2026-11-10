// Ship step `ci`: wait for the pull request's checks, then require them to pass.
//
//   ship.ci.required: [names]  only these checks count; each must appear, finish and pass
//                              (every run of a name, when several share it). Other checks,
//                              such as a Vercel preview, are ignored: on 2026-10-14 a pull
//                              request got only Vercel's check and no CI, and that was
//                              mistaken for CI passing.
//   ship.ci.required: []       every check counts. CI is detected by settling: the checks
//                              must all be finished, and stay finished with no new check
//                              appearing, for ship.ci.settleSeconds (default 90), so a fast
//                              check that finishes before CI registers does not pass alone.
//                              Skipped and neutral checks count as passed here. None ever
//                              appearing means CI never started.
//   ship.ci.timeoutMinutes     how long to wait in all (default 30).
//
// The checks come from `gh pr view --json statusCheckRollup`. A fine-grained token has no
// Checks permission (only GitHub Apps get one), so GitHub refuses it that call ("Resource not
// accessible by personal access token", seen on 2026-10-19). The step then reads the head
// commit's GitHub Actions jobs and commit statuses through the REST API instead, for the rest
// of its run; the token needs Pull requests, Actions and Commit statuses read for that. Check
// runs that other apps post are not seen that way, so they don't count; a classic token with
// the `repo` scope sees them.

const STAGE = 'ci';
const POLL_MS = 20_000;
const REFUSED = /Resource not accessible by/i;
const UNSEEN = 'This token cannot read check runs, so only GitHub Actions jobs and commit statuses were read: a check that other apps post is not seen. A classic token with the `repo` scope sees it.';
const NEEDS = 'This token cannot read check runs, so Foreman reads GitHub Actions jobs and commit statuses instead: a fine-grained token needs Pull requests, Actions and Commit statuses read.';

const said = (r) => String(r.stderr || r.stdout || '').trim().split('\n').pop().slice(0, 200);
const check = (name, done, succeeded, skipped = false) => ({ name, done, succeeded, skipped });

function viaRollup(sh, pr, repo) {
  const r = sh('gh', ['pr', 'view', String(pr), ...(repo ? ['--repo', repo] : []), '--json', 'statusCheckRollup']);
  if (r.status !== 0) return { checks: null, refused: REFUSED.test(r.stderr ?? ''), error: `gh pr view failed: ${said(r)}` };
  try {
    const checks = (JSON.parse(r.stdout).statusCheckRollup ?? []).map((c) => {
      const state = c.state ?? '';
      const conclusion = c.conclusion ?? '';
      return check(
        c.name ?? c.context ?? '',
        (c.status ?? '') === 'COMPLETED' || ['SUCCESS', 'FAILURE', 'ERROR'].includes(state),
        conclusion === 'SUCCESS' || state === 'SUCCESS',
        ['NEUTRAL', 'SKIPPED'].includes(conclusion),
      );
    });
    return { checks };
  } catch {
    return { checks: null, error: 'gh pr view answered something unreadable' };
  }
}

// The head commit's Actions jobs, each run's latest attempt, and its commit statuses, the
// newest per context. A run with no jobs stands for itself: queued, or a broken workflow file.
function viaRest(sh, pr, repo) {
  const get = (path) => {
    const what = `gh api ${path.split('?')[0]}`;
    const r = sh('gh', ['api', `repos/${repo ?? '{owner}/{repo}'}/${path}`]);
    if (r.status !== 0) throw new Error(`${what} failed: ${said(r)}`);
    try {
      return JSON.parse(r.stdout);
    } catch {
      throw new Error(`${what} answered something unreadable`);
    }
  };
  try {
    const sha = get(`pulls/${pr}`).head?.sha;
    if (!sha) throw new Error(`gh api pulls/${pr} gave no head commit`);
    const checks = [];
    for (const run of get(`actions/runs?head_sha=${sha}&per_page=100`).workflow_runs ?? []) {
      const jobs = get(`actions/runs/${run.id}/jobs?per_page=100`).jobs ?? [];
      for (const j of jobs.length ? jobs : [run]) {
        checks.push(check(j.name ?? '', j.status === 'completed', j.conclusion === 'success', ['neutral', 'skipped'].includes(j.conclusion)));
      }
    }
    for (const s of get(`commits/${sha}/status?per_page=100`).statuses ?? []) {
      checks.push(check(s.context ?? '', s.state !== 'pending', s.state === 'success'));
    }
    return { checks };
  } catch (err) {
    return { checks: null, error: err.message };
  }
}

// A pull request's checks: { checks: [{ name, done, succeeded, skipped }], rest } or, when
// they could not be read, { checks: null, rest, error }. rest is true once statusCheckRollup
// was refused: pass it back to go straight to the REST API. repo is owner/name; without it gh
// takes the repository from the clone it runs in. `foreman cloud doctor` reads one too.
export function readChecks(sh, pr, { repo = null, rest = false } = {}) {
  if (!rest) {
    const r = viaRollup(sh, pr, repo);
    if (!r.refused) return { ...r, rest: false };
  }
  return { ...viaRest(sh, pr, repo), rest: true };
}

const names = (checks) => [...new Set(checks.filter((c) => !c.succeeded).map((c) => c.name))].join(', ');

export default {
  name: 'ci',
  label: 'waiting for CI',
  needs: ['gh'],
  testsMergedCode: true,

  async run(ctx) {
    const required = ctx.config.ship?.ci?.required ?? [];
    const minutes = ctx.config.ship?.ci?.timeoutMinutes ?? 30;
    const settleMs = (ctx.config.ship?.ci?.settleSeconds ?? 90) * 1000;
    const deadline = ctx.now().getTime() + minutes * 60_000;
    const fail = (reason) => ({ ok: false, code: 2, stage: STAGE, reason, pr: ctx.pr });
    const failed = (bad) => fail(`CI failed: ${names(bad)}. Read it with: gh run view --log-failed`);

    let seen = new Set(); // check names seen so far (settling mode)
    let seenCount = 0;
    let settledSince = null; // when every check first looked finished, with nothing new since
    let missing = true;
    let unreadable = false;
    let rest = false; // statusCheckRollup was refused: read Actions and commit statuses instead
    let error = '';

    for (;;) {
      const read = readChecks(ctx.sh, ctx.prNumber, { rest });
      const { checks } = read;
      rest = read.rest;
      unreadable = checks === null;
      if (unreadable) error = read.error;
      if (!unreadable) {
        if (required.length > 0) {
          const counted = required.map((name) => checks.filter((c) => c.name === name));
          missing = counted.some((runs) => runs.length === 0);
          const all = counted.flat();
          if (!missing && all.every((c) => c.done)) {
            const bad = all.filter((c) => !c.succeeded);
            return bad.length === 0 ? { ok: true } : failed(bad);
          }
        } else {
          missing = checks.length === 0;
          const grown = checks.length > seenCount || checks.some((c) => !seen.has(c.name));
          seen = new Set(checks.map((c) => c.name));
          seenCount = checks.length;
          if (!missing && checks.every((c) => c.done)) {
            const bad = checks.filter((c) => !(c.succeeded || c.skipped));
            if (bad.length > 0) return failed(bad);
            if (grown || settledSince === null) settledSince = ctx.now().getTime();
            if (ctx.now().getTime() - settledSince >= settleMs) return { ok: true };
          } else {
            settledSince = null;
          }
        }
      }
      if (ctx.now().getTime() >= deadline) {
        if (unreadable) return fail(`Could not read the pull request's checks: ${error} (waited ${minutes} minute${minutes === 1 ? '' : 's'}).${rest ? ` ${NEEDS}` : ''}`);
        if (missing) return fail(`CI never started on the pull request.${rest ? ` ${UNSEEN}` : ''}`);
        return fail(`CI did not finish within ${minutes} minute${minutes === 1 ? '' : 's'}.`);
      }
      await ctx.sleep(POLL_MS);
    }
  },
};
