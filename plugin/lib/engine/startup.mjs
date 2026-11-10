// Start-up decisions the supervisor makes from config and facts. Pure; supervisor.mjs gathers
// the facts and carries the answers out.

import { stepTableFor, stepsFor } from '../adapters/ship/registry.mjs';

// A Mac is kept awake while the supervisor builds (caffeinate exits with it, and keepAwake
// below lets go of it on standby); elsewhere, nothing.
// -i stops idle sleep; -s stops system sleep too, and caffeinate itself honours -s only on AC
// power, so on battery it is idle sleep alone. macOS may still sleep with the lid closed and no
// external display; the supervisor's late-wake check (wake.mjs) handles that.
// `config` is the resolved config (features.keepAwake, read once at start).
export function keepAwakeCommand(config, platform, pid) {
  if (config?.features?.keepAwake !== true || platform !== 'darwin') return null;
  return { cmd: 'caffeinate', args: ['-i', '-s', '-w', String(pid)] };
}

// Holds the computer awake with `command` (keepAwakeCommand's answer) and lets go of it again:
// the supervisor lets go on standby and takes it again when a story starts. take() starts the
// command when nothing is held, detached so it never holds this process up; release() stops it
// with SIGTERM. Both may be called any number of times. A child that fails to start is passed to
// onError, and one that ends on its own is forgotten, so the next take() starts a fresh one.
// With a null command nothing is ever started.
export function keepAwake(command, { spawn, onError = () => {} }) {
  let child = null;
  return {
    take() {
      if (!command || child) return;
      const c = spawn(command.cmd, command.args, { detached: true, stdio: 'ignore' });
      child = c;
      c.on('error', (err) => {
        if (child === c) child = null;
        onError(err);
      });
      c.on('exit', () => {
        if (child === c) child = null;
      });
      c.unref();
    },
    release() {
      if (!child) return;
      const c = child;
      child = null;
      try {
        c.kill('SIGTERM');
      } catch {
        // already gone
      }
    },
    held: () => child !== null,
  };
}

// The stories whose branches are among `branches` (merged pull requests' head branches). A
// story's branch is the prefix plus its id in lower case; a branch that names no story is ignored.
export function mergedStoryIds(branches, stories, branchPrefix) {
  const byBranch = new Map(stories.map((s) => [`${branchPrefix}${s.id.toLowerCase()}`, s.id]));
  const ids = [];
  for (const b of branches) {
    const id = byBranch.get(b);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

// The merged stories start-up may still close: not done, not retired, and not ready to
// promote (a parked release whose pull request merged; it is finished later, not closed).
// statusOf(id) gives a story's status.
export function closableIds(ids, statusOf) {
  return ids.filter((id) => !['done', 'retired', 'ready-to-promote'].includes(statusOf(id)));
}

// The stories start-up closes from the merged pull requests' head branches: those `branches`
// name (mergedStoryIds) that closableIds still lets it close. `stories` are { id, status }.
export function closableMergedIds(branches, stories, branchPrefix) {
  const statusOf = new Map(stories.map((s) => [s.id, s.status]));
  return closableIds(mergedStoryIds(branches, stories, branchPrefix), (id) => statusOf.get(id));
}

// Ship-lock stages after which a cut-off release is finished, not redone: the configured steps
// that pass (`pointOfNoReturn`) or may pass (`mayMarkNoReturn`) the point of no return, plus
// the `mustFinish` stages of every step the config can resolve, configured or not, since a
// stale lock may come from an older release or config. `packs` stands in for the real
// registry in tests.
export function mustFinishFor(config, { packs } = {}) {
  const opts = packs ? { packs } : {};
  const configured = stepsFor(config, opts).filter((s) => s.pointOfNoReturn || s.mayMarkNoReturn).map((s) => s.name);
  const legacy = Object.values(stepTableFor(config, opts)).flatMap((s) => (Array.isArray(s.mustFinish) ? s.mustFinish : []));
  return [...new Set([...configured, ...legacy])];
}

// Whether `git ls-remote --heads` output lists the branch, by its whole ref (story/s-1 is not
// story/s-10).
export function remoteHasBranch(lsRemote, branch) {
  const ref = `refs/heads/${branch}`;
  return String(lsRemote ?? '')
    .split('\n')
    .some((line) => line.split('\t')[1]?.trim() === ref);
}
