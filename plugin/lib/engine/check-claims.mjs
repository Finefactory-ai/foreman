// The checks `foreman checks` is running right now, so a second slot on the same tree waits for
// the result instead of running the same check again (cli/commands/checks.mjs). One file per run
// and tree, <stateDir>/check-claims/<key>.json, where key is claimKey(run, tree):
//
//   { token, pid, script, started, run, tree, slot, story, at }
//
// `token` tells this claim from a later one on the same key, `pid` and `script` are the process
// that holds it (process.argv[1]), `started` is that process's start time (check-slots.mjs
// processStart), or null when ps could not tell, `at` is when it was taken. A claim is taken by writing the
// JSON to a temp file and hard-linking it to the claim's name: that is atomic and exclusive (the
// link fails when the name exists) and a reader never sees half a file.
//
//   claimKey(run, tree) -> 40 hex characters
//   claimPath(stateDirPath, { run, tree })
//   takeClaim(stateDirPath, { run, tree, slot, story, at, pid, script, started })
//       -> { ok: true, claim } | { ok: false, holder } (holder is the parsed file, or null when
//          it cannot be read) | { ok: false, error }
//   releaseClaim(stateDirPath, claim)  removes the file only when its token is claim.token
//   dropStaleClaim(stateDirPath, { run, tree }, holder)  removes the file the caller found dead,
//       only if it is still that claim (or unreadable both times), never a newer one
//   claimAlive(claim, { kill, ps }) -> whether the holder still runs
//
// A claim whose holder was killed stays on disk, so claimAlive checks that the pid exists, that
// its command line names the holder's script, and that its start time is the one the claim was
// taken with. A claim with an empty script is never alive, with or without ps. For a foreground
// run the script is just `foreman`, which the supervisor's command line also holds, so the start
// time is what tells a reused pid from the holder; a claim with no `started` (an old or a
// hand-written one) is dead while ps works. When ps cannot run, the pid check alone decides (for a
// claim that names a script). A false "dead" only costs a duplicate run, and neither answer can
// give a wrong result, since a waiter only ever uses a record `foreman checks` itself wrote.
// CLAIM_WAIT_MS caps one waiter's wait on a live holder (checks.mjs then runs the check itself),
// so a holder whose check hangs cannot stall the others for good. releaseClaim and dropStaleClaim
// never throw.

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pidAlive } from './check-jobs.mjs';
import { processStart } from './check-slots.mjs';

export const CHECK_CLAIMS_DIR = 'check-claims';

// How long one waiter waits on a live holder before it runs the check itself: longer than
// merge-main's 20-minute cap on a single check.
export const CLAIM_WAIT_MS = 30 * 60_000;

export const claimKey = (run, tree) => createHash('sha256').update(`${run}\0${tree}`).digest('hex').slice(0, 40);

export const claimPath = (stateDirPath, { run, tree }) => join(stateDirPath, CHECK_CLAIMS_DIR, `${claimKey(run, tree)}.json`);

function readClaim(file) {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export function takeClaim(stateDirPath, { run, tree, slot = null, story = null, at, pid = process.pid, script = process.argv[1] ?? '', started = null }) {
  const file = claimPath(stateDirPath, { run, tree });
  const claim = { token: randomBytes(8).toString('hex'), pid, script, started, run, tree, slot, story, at };
  const tmp = `${file}.${pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    mkdirSync(join(stateDirPath, CHECK_CLAIMS_DIR), { recursive: true });
  } catch (err) {
    // also EEXIST: a file where the folder goes is an error, not a holder
    return { ok: false, error: err?.message ?? String(err) };
  }
  try {
    writeFileSync(tmp, `${JSON.stringify(claim)}\n`);
    linkSync(tmp, file);
    return { ok: true, claim };
  } catch (err) {
    if (err?.code === 'EEXIST') return { ok: false, holder: readClaim(file) };
    return { ok: false, error: err?.message ?? String(err) };
  } finally {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // the temp name was never made
    }
  }
}

export function releaseClaim(stateDirPath, claim) {
  try {
    const file = claimPath(stateDirPath, claim);
    if (readClaim(file)?.token === claim.token) rmSync(file, { force: true });
  } catch {
    // a claim left behind is cleared by the next run that finds it dead
  }
}

export function dropStaleClaim(stateDirPath, { run, tree }, holder) {
  try {
    const file = claimPath(stateDirPath, { run, tree });
    const now = readClaim(file);
    const was = holder?.token;
    if ((now === null && !holder) || (was !== undefined && now?.token === was)) rmSync(file, { force: true });
  } catch {
    // leave it
  }
}

const realPs = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

export function claimAlive(claim, { kill = process.kill, ps = realPs } = {}) {
  if (!claim || !pidAlive(claim.pid, kill)) return false;
  const name = basename(String(claim.script ?? ''));
  if (name === '') return false; // an empty script never names a real holder, even with no ps
  const r = ps('ps', ['-p', String(claim.pid), '-o', 'command=']);
  if (r.error) return true; // no ps: the kill check decides
  if (r.status !== 0 || !` ${String(r.stdout ?? '').trim()} `.includes(name)) return false;
  // The script name alone also fits the supervisor or any run in a Foreman checkout, so the pid
  // must still have the start time the claim was taken with.
  return typeof claim.started === 'string' && claim.started !== '' && processStart(claim.pid, { ps }) === claim.started;
}
