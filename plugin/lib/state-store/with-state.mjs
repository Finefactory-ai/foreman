// Runs one CLI command against the project's state store (config `state.store`).
//
//   withState(ctx, { write, message }, fn)
//       files store: just fn().
//       branch store: pull the state branch first, then fn(); for a write, push what fn
//       changed afterwards, as one commit named `message`. A write whose pull fails does not
//       run (its change would be made on a stale copy); a read carries on with this machine's
//       copy and says so. A push that keeps failing leaves the change committed here, for the
//       next command to send, and fails the command.
//   stateMode(argv)   'write' | 'read' | null: what a `foreman` command line does to state.
//
// The supervisor does not come through here: `foreman cloud tick` syncs around a whole run,
// and sets FOREMAN_STATE_SYNC=off for the run's children, so the commands its sessions call
// work on this machine's copy without syncing each time.

import { loadConfig } from '../config/load.mjs';
import { stateDir } from '../engine/paths.mjs';
import { changedFiles, defaultSh, syncState } from './branch.mjs';

const WHOLE = { pause: 'write', resume: 'write', stop: 'write', workers: 'write', slot: 'write', handback: 'write', next: 'write', fixed: 'write', learn: 'write', status: 'read', report: 'read' };
const BY_SUB = {
  decide: { answer: 'write', applied: 'write', add: 'write', list: 'read', pending: 'read' },
  story: { start: 'write', block: 'write', done: 'write', todo: 'write', end: 'write', set: 'write', depend: 'write', finalize: 'write', next: 'read', plan: 'read' },
  settings: { set: 'write', reset: 'write' },
  release: { watch: 'write' },
  claude: { 'use-key': 'write' },
  // scan only writes <stateDir>/lessons.json, a derived local file committable() never stages, so it counts as a read.
  learning: { list: 'read', show: 'read', undo: 'write', keep: 'write', scan: 'read', run: 'write', tick: 'write' },
};

export function stateMode([name, ...args] = []) {
  if (Object.hasOwn(WHOLE, name)) return WHOLE[name];
  if (!Object.hasOwn(BY_SUB, name)) return null;
  // --team settings edit foreman.config.json, which is the project's, not state.
  if (name === 'settings' && args.includes('--team')) return null;
  const sub = args.find((a) => !a.startsWith('-'));
  return Object.hasOwn(BY_SUB[name], sub) ? BY_SUB[name][sub] : null;
}

// The branch store's options for the project at `root`, or null for the files store (or a
// config that cannot be read, which the command itself reports).
export function branchStore(root, env = process.env) {
  let config;
  try {
    config = loadConfig(root).config;
  } catch {
    return null;
  }
  if (config?.state?.store !== 'branch') return null;
  return { root, stateDir: stateDir(root, config, env), branch: config.state.branch, remote: config.remote };
}

export async function withState(ctx, { write = false, message = 'Update Foreman state' } = {}, fn) {
  const store = ctx.env?.FOREMAN_STATE_SYNC === 'off' ? null : branchStore(ctx.root, ctx.env);
  if (!store) return fn();
  const opts = { ...store, sh: ctx.sh ?? defaultSh, ...(ctx.sleep ? { sleep: ctx.sleep } : {}) };
  const where = `${store.remote}/${store.branch}`;
  try {
    const pulled = await syncState({ ...opts, direction: 'pull' });
    warnRefused(ctx, pulled.refused);
    if (pulled.setup?.leftover) ctx.stderr.write(`warning: some state files were already on ${where}; this machine's copies are in ${pulled.setup.leftover}\n`);
  } catch (err) {
    if (write) {
      ctx.stderr.write(`foreman: cannot get the state from ${where}, so nothing was changed: ${err.message}\n`);
      return 1;
    }
    ctx.stderr.write(`warning: cannot get the state from ${where}; showing this machine's copy: ${err.message}\n`);
  }
  const code = await fn();
  if (!write) return code;
  try {
    // After the pull nothing was left uncommitted, so what changed now is this command's.
    const pushed = await syncState({ ...opts, direction: 'push', message, writes: changedFiles(opts) });
    warnRefused(ctx, pushed.refused);
  } catch (err) {
    ctx.stderr.write(`foreman: the change is kept on this machine but did not reach ${where}; the next command sends it: ${err.message}\n`);
    return code || 1;
  }
  return code;
}

function warnRefused(ctx, refused = []) {
  if (refused.length) ctx.stderr.write(`warning: not sent to the state branch, because they look like they hold a secret: ${refused.join(', ')}\n`);
}
