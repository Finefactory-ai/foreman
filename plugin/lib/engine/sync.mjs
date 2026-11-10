// The loop that keeps the artifacts console's pages up to date. The push itself lives in the
// adapter (lib/adapters/console/artifacts.mjs); this file decides when. It is a child of its own
// because each push is a Claude call that takes several seconds.
//
//   node lib/engine/sync.mjs --loop [--parent <pid>]
//        every console.everySeconds (default 60) while something changed or the console has
//        work queued, and every 5 min regardless; with --parent, pushes once more and exits
//        when that process (the supervisor) ends
//   node lib/engine/sync.mjs --once     one push now (the supervisor calls it at start)
//
// A failed push is logged by the adapter and retried next round; it never stops the run.

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config/load.mjs';
import { openConsole } from './console.mjs';
import { projectRoot, stateDir } from './paths.mjs';
import { snapshot } from './state.mjs';

const HEARTBEAT_MS = 5 * 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Everything but the clock: the timestamp and how long each slot's agents have been quiet, so
// an unchanged run does not push every minute.
export const fingerprint = (snap) =>
  createHash('sha1')
    .update(JSON.stringify({ ...snap, updatedAt: null, slots: (snap.slots ?? []).map((s) => ({ ...s, agents: (s.agents ?? []).map((a) => ({ ...a, quietFor: null })) })) }))
    .digest('hex');

// One round: pushes when the snapshot changed, the heartbeat is due, or the console has work.
// Returns the new `last`, or null after a failed push (the error is logged by the adapter).
async function once({ con, root, dir, slots }, last) {
  const snap = await snapshot(dir, new Date(), null, { root, slots });
  const print = fingerprint(snap);
  if (last && print === last.print && Date.now() - last.at < HEARTBEAT_MS && !con.due()) return last;
  await con.publish(snap);
  return { print, at: Date.now() };
}

function open() {
  const root = projectRoot();
  const { config, errors } = loadConfig(root);
  if (!config) throw new Error(errors.map((e) => `foreman.config.json${e.path ? ` ${e.path}` : ''}: ${e.message}`).join('\n'));
  if (config.console?.adapter !== 'artifacts') throw new Error('sync.mjs runs only with the artifacts console.');
  const dir = stateDir(root, config, process.env);
  mkdirSync(dir, { recursive: true });
  return { con: openConsole({ config, ctx: { stateDir: dir } }), root, dir, slots: config.slots };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let run;
  try {
    run = open();
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const log = (line) => appendFileSync(join(run.dir, 'sync.log'), `${new Date().toISOString()} ${line}\n`);
  if (process.argv.includes('--once')) {
    // Exit 1 when the page did not take the update, so the supervisor can warn at start.
    try {
      await once(run, null);
      process.exit(0);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  } else if (process.argv.includes('--loop')) {
    const everyMs = run.con.everySeconds * 1000;
    const at = process.argv.indexOf('--parent');
    const parent = at === -1 ? 0 : Number(process.argv[at + 1]);
    const alive = () => {
      try {
        process.kill(parent, 0);
        return true;
      } catch {
        return false;
      }
    };
    let last = null;
    for (;;) {
      try {
        last = await once(run, last);
      } catch (err) {
        last = null;
        if (!/^(push failed|no readable answer|write refused)/.test(err.message)) log(`sync error: ${err.message}`);
      }
      for (let waited = 0; waited < everyMs; waited += 5000) {
        if (parent && !alive()) {
          await sleep(3000); // let the supervisor finish writing its final state
          await once(run, null).catch(() => {});
          process.exit(0);
        }
        await sleep(5000);
      }
    }
  } else {
    console.error('usage: sync.mjs --loop | --once');
    process.exit(2);
  }
}
