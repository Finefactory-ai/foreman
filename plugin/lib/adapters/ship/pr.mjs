// Ship step `pr`: find the branch's pull request, or open one, and wait for GitHub to work
// out whether it can merge. A pull request that cannot merge gets no CI run, so the release
// stops here rather than waiting for one. Facts: `pr` (url) and `prNumber`.
// The pull request merges into `ship.pr.into` when set, else into `baseBranch` (prTarget).
//
// Once the pull request is open it raises `review` on the story through the story source,
// with the pull request's URL in the note, and the short commit it was opened at when git says
// it (a Jira source comments and moves the issue). It
// raises it once per release run: on the runner's first pass (ctx.pass 1, or unset when the
// step runs on its own), not again when the runner brings the base in again. A
// story source that fails never fails the step; it is an event.
//
// A pull request reused from an earlier run can be a draft (the failed path turns it into one):
// it is marked ready, and its body, which still holds the findings of the failed run, is rebuilt
// from its commits. The step fails only when the pull request cannot be marked ready.

import { raiseStoryEvent } from '../../engine/story-events.mjs';

const STAGE = 'pr';
const MERGEABLE_TRIES = 18;

// The branch pull requests merge into. Stories are still cut from baseBranch.
export const prTarget = (config) => config.ship?.pr?.into ?? config.baseBranch;

export default {
  name: 'pr',
  label: 'opening the pull request',
  needs: ['gh'],

  async run(ctx, { raiseStoryEvent: raise = raiseStoryEvent } = {}) {
    const { sh, branch } = ctx;
    const view = () => {
      const r = sh('gh', ['pr', 'view', branch, '--json', 'number,url,state,isDraft']);
      if (r.status !== 0) return null;
      try {
        return JSON.parse(r.stdout);
      } catch {
        return null;
      }
    };
    let pr = view();
    if (!pr) {
      if (sh('gh', ['pr', 'create', '--base', prTarget(ctx.config), '--head', branch, '--fill']).status !== 0) {
        return { ok: false, code: 1, stage: STAGE, reason: 'Could not open the pull request.' };
      }
      pr = view();
      if (!pr) return { ok: false, code: 1, stage: STAGE, reason: 'Opened the pull request but cannot find it.' };
    }
    if (pr.state !== 'OPEN') return { ok: false, code: 1, stage: STAGE, reason: `Pull request #${pr.number} is ${pr.state}.`, pr: pr.url };
    if (pr.isDraft === true) {
      if (sh('gh', ['pr', 'ready', String(pr.number)]).status !== 0) {
        return { ok: false, code: 1, stage: STAGE, reason: `Pull request #${pr.number} is a draft and could not be marked ready.`, pr: pr.url };
      }
      refreshBody(ctx, pr.number);
    }
    ctx.report?.(pr.url);
    if (!(ctx.pass > 1)) tellReview(ctx, pr.url, raise);

    let mergeable = 'UNKNOWN';
    for (let i = 0; i < MERGEABLE_TRIES; i++) {
      const r = sh('gh', ['pr', 'view', String(pr.number), '--json', 'mergeable', '--jq', '.mergeable']);
      mergeable = (r.status === 0 && String(r.stdout ?? '').trim()) || 'UNKNOWN';
      if (mergeable !== 'UNKNOWN' || i === MERGEABLE_TRIES - 1) break;
      await ctx.sleep(10_000);
    }
    if (mergeable !== 'MERGEABLE') {
      return { ok: false, code: 1, stage: STAGE, reason: `Pull request #${pr.number} cannot merge (${mergeable}); CI will not run on it.`, pr: pr.url };
    }
    return { ok: true, pr: pr.url, prNumber: pr.number };
  },
};

// Best effort: the body of pull request n as a list of its commits' headlines. A failure is an
// event, never a failed step.
function refreshBody(ctx, n) {
  let done = false;
  try {
    const log = ctx.sh('gh', ['pr', 'view', String(n), '--json', 'commits', '--jq', '.commits[].messageHeadline']);
    const lines = log.status === 0 ? String(log.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean) : [];
    if (lines.length) done = ctx.sh('gh', ['pr', 'edit', String(n), '--body', lines.map((l) => `- ${l}`).join('\n')]).status === 0;
  } catch {
    // reported below
  }
  if (done) return;
  try {
    ctx.event?.(`Could not refresh the body of pull request #${n}; it still holds the findings of an earlier failed run.`, 'warn');
  } catch {
    // an event is never worth failing the release over
  }
}

// The short sha of HEAD, or '' when git does not give one.
function commitOf(sh) {
  try {
    const r = sh('git', ['rev-parse', '--short', 'HEAD']);
    const sha = r?.status === 0 ? String(r.stdout ?? '').trim() : '';
    return /^[0-9a-f]{4,40}$/.test(sha) ? sha : '';
  } catch {
    return '';
  }
}

function tellReview(ctx, url, raise) {
  let r;
  try {
    const sha = commitOf(ctx.sh);
    r = raise({ root: ctx.root, env: ctx.env, now: ctx.now }, ctx.story, 'review', `Pull request ready for review: ${url}${sha ? ` (commit ${sha})` : ''}`);
  } catch (err) {
    r = { ok: false, error: String(err?.message ?? err) };
  }
  if (r?.ok === false) {
    try {
      ctx.event?.(`Could not tell the story source ${ctx.story} is in review (${r.error}).`, 'warn');
    } catch {
      // an event is never worth failing the release over
    }
  }
}
