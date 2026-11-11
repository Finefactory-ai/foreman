// The ship runner: takes the committed story branch you are on to production by running the
// project's ship steps (config `ship.steps`, lib/adapters/ship/) in order, and stops at the
// first one that is not right. `foreman ship` (lib/cli/commands/ship.mjs) builds the real
// ctx and calls runShip; tests pass fakes.
//
// Several slots may build at once, but releases go one at a time: the ship lock is held from
// the first step to the last, so CI always tests this branch on top of the newest base. The
// name of each step is recorded on the lock before it runs, so start-up recovery
// (reconcile.mjs) can finish a release cut off at a point of no return.
//
// A step is { name, run(ctx), label?, needs?, requires?, pointOfNoReturn?, mayMarkNoReturn?,
// beforeNoReturn?, mustFinish?, halts?, deploys?, noRollback?, testsMergedCode?, healthy?(ctx) }.
// healthy() is what `foreman health` runs after a halt. label is the words reported when the step
// starts, or a function of ctx that gives them (the watch and rollback steps name the stage a
// pack says the release is live on); a function that throws or gives no text reports the step's
// name. testsMergedCode: the step tests the
// code as merged with the base (ci, sf-validate). Before any step runs, the runner sets
// ctx.testedBy to the first such step's name, or null when the release has none; merge-main
// runs the project's checks on the merged code itself only when it is null. beforeNoReturn:
// the preflight wants mergeable-recheck right before the first such step. mustFinish: other
// lock stages, left by older releases, after which a cut-off release is finished on startup
// (startup.mjs mustFinishFor). noRollback: once a step with noRollback starts, a failure from it or any
// later step never calls onFailure; it halts.
// run returns { ok: true, ...facts } or { ok: false, code, stage, reason, ...facts }; a reason
// that is not text is reduced to its `reason` text, else "The release failed at <stage>."
// (halt-reason.mjs), so HALT never holds an object there; the facts
// are added to ctx for later steps and to the final result (never replacing the runner's own
// ctx keys, the RESERVED set below). A later step's facts may replace an earlier step's: a
// Salesforce later stage with a branch of its own (sf-deploy-<stage>, ci-deploy-watch-<stage>)
// replaces `sha`, and adds `shaBranch`, with its merge into that branch, so the shipped
// result's `sha` is the last stage's commit, not always the pull request's merge commit.
// A step passes the point of no return when it has `pointOfNoReturn`, or when its
// result says `noReturn: true` (for a step that only sometimes changes something live; such a
// step says `mayMarkNoReturn`). run may also return { ok: true, parked: { reason, check } }: the
// release finishes later, outside this run. No later step runs and nothing halts; `reason` says
// what is left to do and `check` is plain data, stored and run later to see it finished. The
// park is never a fact. A park without a reason, or with a check that is not plain data, is a
// failure of that step. A failure may say `again: true`: the base moved under the release
// (mergeable-recheck), so the runner brings it in again itself. Still holding the ship lock,
// it drops the facts of that pass and runs the steps again from the first, at most
// BASE_MOVES times in one run; after that the step's own failure is returned, saying the
// base kept moving. The runner sets ctx.pass (1 for the first pass, one more on each
// loop-back) so a step with side effects outside the release (the pr step's `review` event)
// can do them once. `again` is never a fact, and it is ignored once a point of no return
// has passed, a deploy has passed or a noRollback step has started: that failure is
// handled as any other.
//
// Exit codes (a contract the per-story skill depends on):
//   0 shipped   1 nothing to ship or wrong state
//   2 CI, the Salesforce validation, or the project's checks on the merged code failed (nothing merged)
//   3 hosted credentials missing (nothing merged)  4 migration failed (nothing merged)
//   5 deploy or smoke failed, or a failure after a point of no return
//   6 the branch conflicts with the base in real code   7 a resource is held by another slot
//   8 releases are frozen by HALT
//   9 parked: ready to promote; the release finishes later (nothing halted)
//   10 the owner must allow metadata deletes (nothing pushed, nothing halted)
// A failing step marked `halts`, a failure after a point of no return, and codes 4 and 5
// write HALT, which stops releases until the owner clears it. When the new build is live (a
// step after a successful deploy failed) and the project set a rollback, the runner also
// rolls production back and says so in the HALT reason (`rolledBack`), unless a noRollback
// step has started: then it halts, and the reason says it was not rolled back.

import { isDeepStrictEqual } from 'node:util';
import { fetchBase, mergeInProgress, out } from './git.mjs';
import { reasonOf } from './halt-reason.mjs';
import { adoptLegacySchemaLock, breakIfStale, holderOf, release, RESOURCE, setStage as setLockStage, SHIP, take } from './locks.mjs';

const WAITING = 'waiting for the ship lock';
const HALT_CODES = new Set([4, 5]);
// The most times one run brings the base in again because it moved under the release.
const BASE_MOVES = 5;
// ctx keys a step's facts may not replace.
const RESERVED = new Set(['sh', 'env', 'fetch', 'root', 'config', 'story', 'branch', 'locks', 'report', 'halt', 'sleep', 'now', 'pid', 'slot', 'holderPid', 'isHalted', 'event', 'beat', 'testedBy', 'pass', 'rolledBackAt']);

// The lock files behind the keys the runner and steps use: `ship` and `resource:<name>`.
export function lockStore(dir) {
  const file = (key) => {
    if (key === 'ship') return SHIP(dir);
    if (typeof key === 'string' && key.startsWith('resource:') && key.length > 9) return RESOURCE(dir, key.slice(9));
    throw new Error(`unknown lock: ${key}`);
  };
  adoptLegacySchemaLock(dir);
  return {
    take: (key, holder) => take(file(key), holder),
    release: (key, pid) => release(file(key), pid),
    holderOf: (key) => holderOf(file(key)),
    breakIfStale: (key) => breakIfStale(file(key)),
    setStage: (key, pid, stage) => setLockStage(file(key), pid, stage),
  };
}

// A park that can be stored: a reason, and a check that is plain data (it survives JSON).
function validPark(parked) {
  if (typeof parked?.reason !== 'string' || !parked.reason.trim()) return false;
  const { check } = parked;
  if (check === null || typeof check !== 'object' || Array.isArray(check)) return false;
  try {
    return isDeepStrictEqual(JSON.parse(JSON.stringify(check)), check);
  } catch {
    return false;
  }
}

// The words reported when a step starts: its label (a function of ctx is called, and used only
// when it gives text), else its name.
function labelOf(step, ctx) {
  let label = step.label;
  if (typeof label === 'function') {
    try {
      label = label(ctx);
    } catch {
      label = null;
    }
  }
  return typeof label === 'string' && label.trim() ? label : step.name;
}

const quiet = (fn) => {
  try {
    fn();
  } catch {
    // status keeping is best effort; it never fails the release
  }
};

// One release at a time. A lock left by a release process that died is broken, and said so.
// Returns false when a halt appears while waiting.
async function waitForShipLock(ctx, report) {
  const me = { pid: ctx.pid, slot: ctx.slot, story: ctx.story, by: 'factory', at: ctx.now().toISOString(), stage: 'waiting' };
  for (;;) {
    if (ctx.isHalted()) return false;
    const got = ctx.locks.take('ship', me);
    if (got.ok) return true;
    if (got.stale) {
      const old = ctx.locks.breakIfStale('ship');
      if (old) quiet(() => ctx.event(`Broke a ship lock left by a release that died (${old.story ?? 'unknown story'} at ${old.stage ?? 'an unknown step'}).`, 'warn'));
      continue;
    }
    report(WAITING);
    await ctx.sleep(20_000);
  }
}

// Writes HALT for a failed release. A HALT that cannot be written is said loudly: releases
// are then not frozen.
function writeHalt(ctx, result) {
  try {
    ctx.halt(result);
  } catch (err) {
    result.haltWritten = false;
    quiet(() => ctx.event(`Could not write HALT after ${result.stage} failed (${err?.message ?? err}); releases are NOT frozen.`, 'warn'));
  }
}

// Rolls production back once for a release that failed after its new build went live. HALT
// is written first, saying a rollback is under way, so a crash mid-rollback still leaves
// releases frozen; then it is written again with what happened: rolledBack, and a sentence
// before the reason. A rollback that returns manualSteps (strings) has them listed there as
// "By hand: a; b.".
async function rollBack(ctx, onFailure, result, report) {
  const planned = onFailure.commandFor?.(ctx.config) ?? onFailure.name;
  writeHalt(ctx, { ...result, reason: `Rolling back with \`${planned}\`… ${result.reason}` });
  quiet(() => ctx.locks.setStage('ship', ctx.pid, onFailure.name));
  report(labelOf(onFailure, ctx));
  // Where it was rolled back, when the rollback can say (a Salesforce sandbox stage); else production.
  let where = null;
  try {
    const named = onFailure.whereFor?.(ctx);
    where = typeof named === 'string' && named.trim() ? named : null;
  } catch {
    where = null;
  }
  let r;
  try {
    r = (await onFailure.run(ctx)) ?? { ok: false };
  } catch (err) {
    r = { ok: false, why: `could not run: ${err?.message ?? err}` };
  }
  const command = r.command ?? planned;
  result.rolledBack = r.ok === true;
  const why = r.why ?? (Number.isInteger(r.exitCode) ? `exited ${r.exitCode}` : 'failed');
  const steps = Array.isArray(r.manualSteps) && r.manualSteps.length && r.manualSteps.every((x) => typeof x === 'string') ? r.manualSteps : [];
  const byHand = steps.length ? ` By hand: ${steps.join('; ')}.` : '';
  const said = result.rolledBack ? `${where ?? 'Production'} was rolled back with \`${command}\`.${byHand}` : `Rollback failed (\`${command}\` ${why}); ${where ?? 'production'} may be broken.`;
  result.reason = `${said} ${result.reason}`;
  writeHalt(ctx, result);
}

// ctx: { config, story, slot, pid, holderPid, sh, env?, fetch?, root?, locks, sleep, now, report,
// beat?, halt, isHalted, event, rolledBackAt? }; the runner adds branch, testedBy and pass.
// rolledBackAt is the time the pack says the story's last release was rolled back, or null; the
// pr step opens a new pull request instead of reusing one merged before it. sh(cmd, args,
// { env, cwd }?) runs a command; env is the environment it runs with (the project's env file
// loaded). onFailure: the project's rollback (registry.mjs onFailureFor), or null. It runs
// only when a step fails after a step marked `deploys` passed, so the new build is what
// production runs. A failed deploy, or a failure with no deploy before it, never rolls back:
// production still runs the previous version, and rolling back would put an even older one
// live. Nor does it run once a step marked `noRollback` has started (a later stage that
// people share): that failure halts, with a reason that starts "Not rolled back".
// Returns { code, result }; the caller prints and exits.
export async function runShip({ steps, ctx, onFailure = null }) {
  const { remote, baseBranch, branchPrefix } = ctx.config;
  const report = (detail) => quiet(() => ctx.report(detail));
  const frozen = { stage: 'start', reason: 'Releases are frozen by a halt.' };

  if (ctx.isHalted()) return { code: 8, result: frozen };

  const branch = out(ctx, 'git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch || !branch.startsWith(branchPrefix)) {
    return { code: 1, result: { stage: 'start', reason: `On ${branch ?? 'no branch'}; Foreman ships ${branchPrefix}* branches only.` } };
  }
  const status = ctx.sh('git', ['status', '--porcelain']);
  if (status.status !== 0 || String(status.stdout ?? '').trim()) {
    return { code: 1, result: { stage: 'start', reason: 'The working tree has uncommitted changes.' } };
  }
  if (mergeInProgress(ctx)) {
    return { code: 1, result: { stage: 'start', reason: 'A merge is in progress (MERGE_HEAD is set): commit it to conclude the merge, then ship again.' } };
  }
  ctx.branch = branch;
  ctx.testedBy = steps.find((s) => s.testsMergedCode === true)?.name ?? null;

  if (!(await waitForShipLock(ctx, report))) return { code: 8, result: frozen };

  const timer = ctx.beat ? setInterval(() => quiet(ctx.beat), 60_000) : null;
  timer?.unref?.();
  try {
    if (!(await fetchBase(ctx))) {
      return { code: 1, result: { stage: 'start', reason: `git fetch ${remote} ${baseBranch} failed three times.` } };
    }
    if (out(ctx, 'git', ['rev-list', '--count', `${remote}/${baseBranch}..HEAD`]) === '0') {
      return { code: 1, result: { stage: 'start', reason: `The branch has no commits ahead of ${baseBranch}.` } };
    }

    let moves = 0;
    pass: for (;;) {
      const facts = {};
      ctx.pass = moves + 1;
      let pastNoReturn = false;
      let deployed = false;
      let noRollbackFrom = null;
      for (const step of steps) {
        quiet(() => ctx.locks.setStage('ship', ctx.pid, step.name));
        report(labelOf(step, ctx));
        if (step.noRollback === true && !noRollbackFrom) noRollbackFrom = step.name;
        let r;
        try {
          r = await step.run(ctx);
        } catch (err) {
          r = { ok: false, code: 1, stage: step.name, reason: `${step.name} failed: ${err?.message ?? err}` };
        }
        let { ok, code, stage, reason, noReturn, parked, again, ...rest } = r ?? { ok: false, code: 1, reason: `${step.name} returned nothing.` };
        for (const [key, value] of Object.entries(rest)) {
          if (RESERVED.has(key)) continue;
          facts[key] = value;
          ctx[key] = value;
        }
        if (ok && parked !== undefined) {
          if (validPark(parked)) {
            return { code: 9, result: { ...facts, stage: 'parked', story: ctx.story, step: step.name, parked: { reason: parked.reason, check: parked.check } } };
          }
          ok = false;
          code = 1;
          stage = step.name;
          reason = `${step.name} parked the release without a reason and a check that can be stored.`;
        }
        if (ok) {
          if (step.pointOfNoReturn || noReturn === true) pastNoReturn = true;
          if (step.deploys) deployed = true;
          continue;
        }
        // The base moved under the release before anything live changed: bring it in again.
        if (again === true && !pastNoReturn && !deployed && !noRollbackFrom) {
          if (moves < BASE_MOVES) {
            moves += 1;
            for (const key of Object.keys(facts)) delete ctx[key];
            quiet(() => ctx.event(`${baseBranch} moved while ${ctx.story} was releasing; bringing it in again (${moves} of ${BASE_MOVES}).`, 'info'));
            report(`${baseBranch} moved; bringing it in again`);
            continue pass;
          }
          reason = `${baseBranch} kept moving: brought it in ${BASE_MOVES} times during this release. ${reason ?? `${step.name} failed.`}`;
        }
        // Past a point of no return the release must be finished by hand, whatever went wrong.
        const failCode = pastNoReturn ? 5 : Number.isInteger(code) && code > 0 ? code : 1;
        const result = { ...facts, stage: stage ?? step.name, reason: reason === undefined || reason === null ? `${step.name} failed.` : reasonOf(reason, stage ?? step.name) };
        if (deployed && onFailure && noRollbackFrom) {
          result.reason = `Not rolled back: Foreman never rolls back once ${noRollbackFrom} has started; put it right by hand. ${result.reason}`;
        }
        if (deployed && onFailure && !noRollbackFrom) await rollBack(ctx, onFailure, result, report);
        else if (step.halts || pastNoReturn || noRollbackFrom || HALT_CODES.has(failCode)) writeHalt(ctx, result);
        return { code: failCode, result };
      }
      return { code: 0, result: { stage: 'shipped', story: ctx.story, ...facts } };
    }
  } finally {
    if (timer) clearInterval(timer);
    quiet(() => ctx.locks.release('ship', ctx.pid));
  }
}
