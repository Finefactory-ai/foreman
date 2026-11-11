// `foreman cloud tick`: one scheduled job's worth of work, for GitHub Actions. It needs the
// branch state store, since nothing on the runner outlives the job.
//
//   1. git is signed in through gh, with an identity (git-setup.mjs)
//   2. the state branch is pulled; a failed pull builds nothing, rather than build on a stale
//      copy
//   3. --story asks for that story next, as `foreman next` does
//   4. when nothing can happen (idleReason), it stops here, so an idle job costs seconds. An
//      answered owner decision the supervisor applies itself (lib/engine/answers.mjs) counts
//      as something to do, so a retried story is put back and built; so does a task
//      answered "Retry the story", or a question about a story blocked for a reason in words
//      (answers.mjs requeueKind and waitsForAnswer), which the supervisor puts back to todo; and
//      so does a task answered "Close the task", which a run marks applied. Answers are read through
//      the project's console (openConsole), as the supervisor reads them; with `artifacts` that
//      is the page's local copy, <stateDir>/sync/decisions, and sync/ stays on each machine,
//      off the state branch (state-store/branch.mjs GITIGNORE). A pause Foreman made itself
//      for a usage limit or an empty balance, whose retry time (state.json's autoResumeAt) has
//      come, is not idle either: the supervisor runs, probes Claude and clears it by itself
//   5. otherwise the project's keys go to the envFile (only when git ignores it) and out of
//      the environment (env-file.mjs), and the supervisor runs with `--max 1 --workers 1 --once`: at most one
//      new story, end to end, and it stops as soon as nothing can start. Its children run
//      with FOREMAN_STATE_SYNC=off, so the state is synced once, around the whole run, rather
//      than by each command a session calls
//   6. when the supervisor ran and `learning.auto` is on, `foreman learning tick` runs (with the
//      same environment), so what the job's story taught is learned in this job; it writes its
//      output through, and a failure is a warning that never changes the exit code. An idle job
//      does not run it
//   7. the state is pushed, whatever the supervisor's exit code
//
// `foreman stop` holds the scheduled jobs: a STOP seen at the start becomes a pause once the
// stories in progress are finished (at once when there are none), until `foreman resume`.
// A plain STOP would only skip one job, and the next would build again.

import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadResolved } from '../settings/load.mjs';
import { ownerCommand } from '../console/commands.mjs';
import { pause, readControl } from '../console/control.mjs';
import { requeueKind, supervisorApplies, waitsForAnswer } from '../engine/answers.mjs';
import { openConsole } from '../engine/console.mjs';
import { claims, SHIP } from '../engine/locks.mjs';
import { nextStory } from '../engine/pick.mjs';
import { pendingCommands } from '../engine/scheduler.mjs';
import { readSlot, readState } from '../engine/state.mjs';
import { openProjectStories } from '../engine/story-source.mjs';
import { slotIds } from '../engine/worktree.mjs';
import { changedFiles as realChangedFiles, defaultSh, syncState as realSyncState } from '../state-store/branch.mjs';
import { setUpGit } from './git-setup.mjs';
import { placeKeys } from './env-file.mjs';

export const SUPERVISOR_ARGS = ['--max', '1', '--workers', '1', '--once'];
const IN_PROGRESS_SLOTS = ['building', 'waiting', 'held'];
const FOREMAN_BIN = fileURLToPath(new URL('../../bin/foreman', import.meta.url));
const LEARNING_MS = 15 * 60_000;

// The last non-empty line of a result's stderr, else its stdout.
const lastLineOf = (r) => [r?.stderr, r?.stdout].map((t) => String(t ?? '').trim().split('\n').filter(Boolean).at(-1)).find(Boolean) ?? `exit ${r?.status ?? 'unknown'}`;

// A credit pause whose retry time has come is not a reason to idle: the supervisor runs, probes and
// clears it by itself. The owner's own pause always is one.
const pausedBy = (control, state, nowMs) => {
  if (control.paused === true) return 'paused with `foreman pause`; `foreman resume` starts it again';
  const at = state.autoPausedAt;
  if (at && !(control.resumeAt && control.resumeAt > at)) {
    if (typeof state.autoResumeAt === 'string' && Date.parse(state.autoResumeAt) <= nowMs) return null;
    return `paused by Foreman: ${state.autoPauseReason || 'see `foreman status`'}; \`foreman resume\` starts it again`;
  }
  return null;
};

// Anything a run would carry on with: a claim, the ship lock, a slot mid-story, a story
// marked in progress.
function inProgress({ dir, config, list }) {
  if (claims(dir).length || existsSync(SHIP(dir))) return true;
  if (slotIds(config).some((slot) => IN_PROGRESS_SLOTS.includes(readSlot(dir, slot).state))) return true;
  return (list ?? []).some((s) => s.status === 'in-progress');
}

// Why a job would do nothing now, or null when the supervisor should run. Unsure is null: the
// supervisor knows best, and with --once it stops by itself when nothing can start.
export async function idleReason({ root, dir, config, env = process.env, now = () => new Date() }) {
  try {
    const control = readControl(dir);
    const state = readState(dir);
    if (pendingCommands(control, state.handled ?? {}, slotIds(config)).length) return null;
    if (existsSync(join(dir, 'HALT'))) return 'halted: a release failed; `foreman fixed` once the cause is fixed';
    const paused = pausedBy(control, state, now().getTime());
    if (paused) return paused;
    // Only stories kept in the repo can be read without asking a service.
    const markdown = (config.stories?.adapter ?? 'markdown') === 'markdown';
    const source = markdown ? openProjectStories({ root, now, env: { ...env, FOREMAN_STATE_DIR: dir } }) : null;
    const list = source ? source.list() : null;
    if (inProgress({ dir, config, list })) return null;
    if (existsSync(join(dir, 'STOP'))) return 'stopped with `foreman stop`';
    const pending = await openConsole({ config, ctx: { stateDir: dir, now } }).decisions.pending();
    if (pending.some(supervisorApplies)) return null;
    if (!source) return null;
    // An answered task or question about a story the supervisor would put back in line, or a task
    // answered "Close the task", which the supervisor marks applied whatever its story waits on, so
    // a run clears it. No claim is held here: inProgress() returned above.
    if (pending.some((i) => {
      const kind = requeueKind(i);
      return kind === 'closeTask' || (kind && waitsForAnswer(list.find((s) => s.id === i.story), { idPattern: source.idPattern }));
    })) return null;
    return nextStory(list, { idPattern: source.idPattern }) ? null : 'nothing can be built (every story is done, blocked or waiting on another)';
  } catch {
    return null;
  }
}

const branchOptions = (root, config, dir) => ({ root, stateDir: dir, branch: config.state.branch, remote: config.remote });

export async function tick({
  root,
  env = process.env,
  story = null,
  stdout,
  stderr,
  now = () => new Date(),
  sh = defaultSh,
  syncState = realSyncState,
  changedFiles = realChangedFiles,
  startSupervisor,
  learningTick = ({ root: at, env: childEnv }) => defaultSh(process.execPath, [FOREMAN_BIN, 'learning', 'tick'], { cwd: at, env: childEnv, timeout: LEARNING_MS }),
}) {
  const { config, errors, dir } = loadResolved(root, { env });
  if (!config) {
    stderr.write(`${errors.map((e) => (e.path ? `foreman.config.json ${e.path}: ${e.message}` : e.message)).join('\n')}\n`);
    return 1;
  }
  if (config.state?.store !== 'branch') {
    stderr.write('foreman cloud tick needs state.store "branch", since nothing on the runner outlives the job: set "state": { "store": "branch" } in foreman.config.json.\n');
    return 1;
  }
  const store = { ...branchOptions(root, config, dir), sh };
  const where = `${store.remote}/${store.branch}`;

  for (const w of setUpGit({ root, sh }).warnings) stderr.write(`warning: ${w}\n`);
  try {
    const pulled = await syncState({ ...store, direction: 'pull' });
    if (pulled.setup?.leftover) stderr.write(`warning: some state files were already on ${where}; this machine's copies are in ${pulled.setup.leftover}\n`);
  } catch (err) {
    stderr.write(`foreman: cannot get the state from ${where}, so nothing was built: ${err.message}\n`);
    return 1;
  }

  let code = 0;
  if (story) {
    try {
      stdout.write(`${ownerCommand(dir, config, { action: 'next', id: story }, now())}\n`);
    } catch (err) {
      stderr.write(`${err.message}\n`);
      code = 1;
    }
  }

  const stopAsked = existsSync(join(dir, 'STOP'));
  if (code === 0) {
    const reason = await idleReason({ root, dir, config, env, now });
    if (reason) stdout.write(`Nothing to do: ${reason}.\n`);
    else {
      const keys = placeKeys({ root, config, env, sh });
      for (const w of keys.warnings) stderr.write(`warning: ${w}\n`);
      stdout.write('Building one story.\n');
      const childEnv = { ...keys.env, FOREMAN_STATE_SYNC: 'off' };
      code = await startSupervisor({ root, env: childEnv, args: SUPERVISOR_ARGS });
      if (config.learning?.auto !== false) {
        const learned = await learningTick({ root, env: childEnv });
        if (learned?.stdout) stdout.write(learned.stdout);
        if (learned?.status !== 0) stderr.write(`warning: learning tick failed: ${lastLineOf(learned)}\n`);
      }
    }
  }

  if (stopAsked) {
    rmSync(join(dir, 'STOP'), { force: true });
    pause(dir, now());
    stdout.write('Stopped with `foreman stop`: the scheduled jobs start no new stories until `foreman resume`.\n');
  }

  try {
    const pushed = await syncState({ ...store, direction: 'push', message: 'foreman cloud tick', writes: changedFiles(store) });
    if (pushed.refused?.length) stderr.write(`warning: not sent to the state branch, because they look like they hold a secret: ${pushed.refused.join(', ')}\n`);
  } catch (err) {
    stderr.write(`foreman: the state is kept on this runner but did not reach ${where}: ${err.message}\n`);
    return code || 1;
  }
  return code;
}
