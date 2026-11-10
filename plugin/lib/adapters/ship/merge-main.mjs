// Ship step `merge-main`: bring in anything that landed on the base branch since the story
// branch was cut, so the release tests the branch on top of the newest base. A branch that
// already contains the base runs nothing. Conflicts in generated files (config `generated`)
// settle themselves: each conflicted entry's `regenerate` command is run and the merge is
// committed. A conflict in anything else aborts the merge and stops the release (code 6) for
// the builder to resolve.
//
// After a merge that brought in new commits (clean, or settled by regenerating), the project's
// checks (config `checks`) run on the merged tree, unless a step of this release tests the
// merged code: projects whose release has a step marked testsMergedCode (ci, sf-validate)
// leave it to that step (ctx.testedBy, set by the runner). The checks chosen are those whose
// `when` is "always" or matches a file changed between the fork point (taken before the
// merge) and the merged HEAD; when that cannot be diffed, every check runs. When any check
// is chosen, `install.run` runs first if a changed file matches `install.when`, or when the
// change cannot be diffed.
// Each command runs with `sh -c`, for at most CHECK_LIMIT_MS, with a beat before and after:
// the shell blocks the runner's beat timer, and the scheduler's quiet watchdog must never see
// a gap longer than one capped command. Each install and check runs with the release's
// environment less Foreman's own keys (FOREMAN_KEYS), keeping only SESSION_KEYS.
//
// A failed install or check stops the release with code 2 (nothing pushed or merged), and
// `failures` lists each as { run, exit, timedOut, tail }: exit is null for a command that ran
// too long, and tail is the last 4000 characters of its output with secrets blanked. The merge
// is kept on the branch, so the fix starts from the merged code. When everything passes, the
// fact `mergeChecks` lists the checks chosen.
//
// A check is not run again when `foreman checks` already ran it, in the session's own
// environment, on this exact merged tree: the working tree is clean (`git status --porcelain` is
// empty, so its tree is HEAD^{tree}, what check-runs.mjs treeHash gives a clean checkout) and the
// state folder's check-runs.jsonl holds a real run of the command with env 'session' on that
// tree (findCheckRun). That record's exit decides, a failure stopping the release as a run would
// (code 2, the failure carrying the record's tail and reused: true), and the reuse is recorded as
// a line with by: 'merge-main' (best effort, quietly). The facts add `mergeChecksReused`, the
// commands reused, when there are any. `install` runs only when a check really runs. Records are
// read only from the run's own state folder, the project's folder (FOREMAN_PROJECT_DIR) plus
// config.stateDir, or, with no FOREMAN_STATE_DIR, the folder under the context's root. A run
// whose state folder is set elsewhere (the cloud runner, an owner's FOREMAN_STATE_DIR) always
// runs the checks on the merged code, and so does a context with neither. A record appended
// through an interpreter is still trusted: the anchor guard that protects the file is best
// effort, and the release reuse was asked for. The runs of this step itself are not recorded.

import { resolve } from 'node:path';
import { findCheckRun, readCheckRuns, recordCheckRun, TREE_ID } from '../../engine/check-runs.mjs';
import { matchesGlob } from '../../engine/glob.mjs';
import { lines, out } from '../../engine/git.mjs';
import { stateDir } from '../../engine/paths.mjs';
import { isForemanKey, SESSION_KEYS } from '../../engine/foreman-keys.mjs';
import { redact } from '../../secrets/redact.mjs';
import { redact as redactLooksSecret } from '../../engine/state.mjs';

// patterns: the `path` of each config `generated` entry (globs allowed).
export function classifyConflicts(files, patterns = []) {
  const isGenerated = (f) => patterns.some((p) => matchesGlob(f, p));
  return { generated: files.filter(isGenerated), code: files.filter((f) => !isGenerated(f)) };
}

const STAGE = 'merge-main';
// The longest one install or check may run on the merged code.
export const CHECK_LIMIT_MS = 20 * 60_000;
const TAIL_CHARS = 4000;
const LOOKS_SECRET = /KEY|SECRET|TOKEN|PASSWORD/i;

// The output's end, every secret value in the environment blanked before it is cut: the known
// secret names, then any value of 8 or more characters whose name looks secret (longest
// first, so a value holding another is blanked whole), then token-shaped text.
function tailOf(r, env = {}) {
  const values = Object.entries(env ?? {})
    .filter(([name, v]) => typeof v === 'string' && v.length >= 8 && LOOKS_SECRET.test(name))
    .map(([, v]) => v)
    .sort((a, b) => b.length - a.length);
  const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim();
  return redactLooksSecret(redact(text, { env, values })).slice(-TAIL_CHARS);
}

// The environment for the project's commands: env (else the process's) less Foreman's own
// keys, keeping SESSION_KEYS. A new object each time.
const checkEnv = (env) => Object.fromEntries(Object.entries(env ?? process.env).filter(([k]) => !isForemanKey(k) || SESSION_KEYS.includes(k)));

// Runs one command on the merged tree; returns its failure, or null when it passed.
function runOne(ctx, run) {
  ctx.beat?.();
  ctx.report?.(`checking the merged code: ${run}`);
  const r = ctx.sh('sh', ['-c', run], { timeout: CHECK_LIMIT_MS, env: checkEnv(ctx.env) });
  ctx.beat?.();
  if (r.status === 0 && !r.timedOut) return null;
  return { run, exit: r.timedOut ? null : r.status, timedOut: !!r.timedOut, tail: tailOf(r, ctx.env) };
}

// The folder whose records may be reused, or null. A run's state folder is the project's folder
// plus config.stateDir, so a FOREMAN_STATE_DIR that names anything else (set by the caller's
// shell, as `foreman ship` runs from the agent's own Bash) is not trusted and nothing is reused.
// Without FOREMAN_STATE_DIR it is the folder under the project root (an owner running the ship).
function recordsDir(ctx) {
  const env = ctx.env ?? {};
  if (env.FOREMAN_STATE_DIR) {
    if (!env.FOREMAN_PROJECT_DIR) return null;
    const own = resolve(env.FOREMAN_PROJECT_DIR, ctx.config?.stateDir ?? '.foreman');
    return resolve(env.FOREMAN_STATE_DIR) === own ? own : null;
  }
  return typeof ctx.root === 'string' ? stateDir(ctx.root, ctx.config, {}) : null;
}

// The records `foreman checks` made under the session env for each chosen check on this merged
// tree: Map of run -> { hit, tree }. Empty when there is no trusted state folder, the tree is not
// clean or its id cannot be read.
function reusable(ctx, chosen) {
  const found = new Map();
  const dir = recordsDir(ctx);
  if (!dir) return found;
  try {
    if (out(ctx, 'git', ['status', '--porcelain']) !== '') return found;
    const tree = out(ctx, 'git', ['rev-parse', 'HEAD^{tree}']);
    if (!tree || !TREE_ID.test(tree)) return found;
    const entries = readCheckRuns(dir);
    for (const c of chosen) {
      const hit = findCheckRun(entries, { run: c.run, tree });
      if (hit) found.set(c.run, { hit, tree, dir });
    }
  } catch {
    // no record: the check runs
  }
  return found;
}

// Reports and records the reuse of one check; returns its failure, or null when the record passed.
function reuseOne(ctx, c, { hit, tree, dir }) {
  ctx.report?.(`checking the merged code: reusing the record of ${c.run}`);
  try {
    recordCheckRun(dir, { at: ctx.now().toISOString(), story: ctx.story, slot: ctx.slot, run: c.run, full: c.when === 'always', tree, reused: true, from: hit.at, by: STAGE });
  } catch {
    // the reuse is not lost for want of a line
  }
  if (hit.exit === 0) return null;
  return { run: c.run, exit: hit.exit, timedOut: false, tail: String(hit.tail ?? ''), reused: true };
}

function failed(ctx, failures, facts) {
  const runs = failures.map((f) => (f.timedOut ? `${f.run} (ran longer than ${CHECK_LIMIT_MS / 60_000} minutes)` : f.run));
  const reason = `The checks failed on this branch merged with ${ctx.config.baseBranch}: ${runs.join(', ')}. The merge is kept on the branch, so the fix starts from the merged code.`;
  return { ok: false, code: 2, stage: STAGE, reason, failures, ...facts };
}

// fork: the commit the branch and the base shared before the merge, or null.
function checkMerged(ctx, fork, facts) {
  if (ctx.testedBy) return { ok: true, ...facts };
  const all = ctx.config.checks ?? [];
  if (all.length === 0) return { ok: true, ...facts };

  const d = fork ? ctx.sh('git', ['diff', '--name-only', fork, 'HEAD']) : null;
  const files = d?.status === 0 ? lines(d.stdout) : null;

  const chosen = files === null ? all : all.filter((c) => c.when === 'always' || files.some((f) => matchesGlob(f, c.when)));
  if (chosen.length === 0) return { ok: true, ...facts };

  const reused = reusable(ctx, chosen);
  const install = ctx.config.install;
  if (install?.run && chosen.some((c) => !reused.has(c.run)) && (files === null || files.some((f) => matchesGlob(f, install.when)))) {
    ctx.report?.('installing dependencies for the merged code');
    const failure = runOne(ctx, install.run);
    if (failure) return failed(ctx, [failure], facts);
  }

  const failures = chosen.map((c) => (reused.has(c.run) ? reuseOne(ctx, c, reused.get(c.run)) : runOne(ctx, c.run))).filter(Boolean);
  if (failures.length > 0) return failed(ctx, failures, facts);
  return { ok: true, ...facts, mergeChecks: chosen.map((c) => c.run), ...(reused.size ? { mergeChecksReused: chosen.filter((c) => reused.has(c.run)).map((c) => c.run) } : {}) };
}

export default {
  name: 'merge-main',
  label: 'bringing in the latest base branch',
  needs: ['git'],

  async run(ctx) {
    const { remote, baseBranch, generated = [] } = ctx.config;
    const target = `${remote}/${baseBranch}`;
    const sh = ctx.sh;
    if (sh('git', ['merge-base', '--is-ancestor', target, 'HEAD']).status === 0) return { ok: true };
    const fork = out(ctx, 'git', ['merge-base', 'HEAD', target]);
    if (sh('git', ['merge', '--no-edit', '--quiet', target]).status === 0) return checkMerged(ctx, fork, {});

    const abort = (code, reason, extra = {}) => {
      sh('git', ['merge', '--abort']);
      return { ok: false, code, stage: STAGE, reason, ...extra };
    };
    const conflicted = lines(sh('git', ['diff', '--name-only', '--diff-filter=U']).stdout);
    if (conflicted.length === 0) return abort(1, `git merge ${target} failed with no conflicted files.`);
    const { generated: settle, code } = classifyConflicts(conflicted, generated.map((g) => g.path));
    if (code.length > 0) return abort(6, `The branch conflicts with ${baseBranch} in: ${code.join(', ')}`, { conflicts: code });

    for (const entry of generated) {
      if (!settle.some((f) => matchesGlob(f, entry.path))) continue;
      ctx.report?.(`regenerating ${entry.path}`);
      if (sh('sh', ['-c', entry.regenerate]).status !== 0) {
        return abort(1, `Could not regenerate ${entry.path} (${entry.regenerate}) while merging ${baseBranch}.`);
      }
    }
    if (sh('git', ['add', '--', ...settle]).status !== 0 || sh('git', ['commit', '--quiet', '--no-edit']).status !== 0) {
      return abort(1, `Could not finish merging ${baseBranch} after regenerating generated files.`);
    }
    return checkMerged(ctx, fork, { regenerated: settle });
  },
};
