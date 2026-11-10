// `foreman lock held|take|release|files|owner-claim`: exclusive resources, file locks and owner
// claims, for the agents. The holder's pid is FOREMAN_SUPERVISOR_PID (or this process) and its
// slot is FOREMAN_SLOT.
//
//   lock held <name>        exit 0 when this slot holds the resource, else 1 with one line why
//   lock take <name> <id>   exit 0 when taken now or already held by this slot, else 1
//   lock release <name>     free the resource if this slot holds it; exit 0 either way, and
//                           never touch another slot's lock
//   lock files <id> --plan <file>
//                           claim every file the plan's `files` names (lib/engine/file-locks.mjs),
//                           made relative to the repository root, less fileLocks.ignore and the
//                           generated paths. Prints one JSON line. Exit 0 when this slot holds
//                           them all: {ok, files, ignored, dropped}, and the story's wait record is
//                           cleared. Exit 7 when another slot holds one, or when one is kept for a
//                           higher-priority story that waited for it: {ok: false, heldBy, reason}
//                           (a heldBy entry for a kept file has slot null and reserved: true),
//                           nothing is kept, and the wait record is written for the picker, with every file the plan
//                           claims under `needs`. Either way the story's own reservations are
//                           dropped: it has made its claim.
//                           Exit 1 for a usage error, a plan it cannot read or a config error. The
//                           first stderr line of an exit 1 never carries a local path, so a story
//                           source may be given it.
//   lock owner-claim <id>   hand the story to the owner ("I'll take it")

import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, rmSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../../config/load.mjs';
import { currentSlot, stateDir } from '../../engine/paths.mjs';
import { adoptLegacySchemaLock, breakIfStale, holderOf, holdsResource, ownerClaim, RESOURCE, take } from '../../engine/locks.mjs';
import { claimable, clearWait, dropReservations, normaliseFiles, takeFiles, waitReason, writeWait } from '../../engine/file-locks.mjs';

const USAGE = 'usage: foreman lock held <name> | take <name> <id> | release <name> | files <id> --plan <file> | owner-claim <id>\n';

// Exit 7, as `foreman ship` uses it: a resource is held by another slot.
const HELD = 7;
// A story id as it may name a file: letters, digits, dots, dashes and underscores.
const STORY_ID = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/;

const realOr = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

// The files a plan claims, as { files, ignored, dropped }: the plan's `files` relative to the
// repository root (the git top level of `cwd`, or the project root), less the ones the config
// leaves out (`ignored`). `dropped` lists what names no file in the repository.
export function planFiles(plan, { cwd, root, config }) {
  const git = spawnSync('git', ['-C', cwd ?? root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  const top = git.status === 0 ? String(git.stdout).trim() : '';
  const tops = [top, root].filter(Boolean).flatMap((t) => [t, realOr(t)]);
  const { files, dropped } = normaliseFiles(Array.isArray(plan?.files) ? plan.files : [], tops);
  const claimed = claimable(files, config);
  return { files: claimed, ignored: files.filter((f) => !claimed.includes(f)), dropped };
}

// The supervisor's pid when one runs this session, else null (a by-hand run).
export function supervisorPid(env) {
  const pid = Number(env.FOREMAN_SUPERVISOR_PID);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

const mePid = (env) => supervisorPid(env) ?? process.pid;

async function files(args, { root, env, cwd, stdout, stderr, now }) {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: { plan: { type: 'string' } } });
  } catch (err) {
    stderr.write(`${err.message}\n${USAGE}`);
    return 1;
  }
  const { values, positionals } = parsed;
  const [id] = positionals;
  if (!id || positionals.length > 1 || !values.plan) {
    stderr.write(USAGE);
    return 1;
  }
  if (!STORY_ID.test(id)) {
    stderr.write(`not a story id: ${id}\n`);
    return 1;
  }
  const { config, errors } = loadConfig(root);
  if (errors.length) {
    stderr.write('lock: foreman.config.json has errors\n');
    stderr.write(`${errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join('\n')}\n`);
    return 1;
  }
  // The plan by its file name only: these lines may reach the story source.
  const name = basename(values.plan);
  let text;
  try {
    text = readFileSync(resolve(cwd ?? root, values.plan), 'utf8');
  } catch {
    stderr.write(`could not read the plan ${name}\n`);
    return 1;
  }
  let plan;
  try {
    plan = JSON.parse(text);
  } catch {
    stderr.write(`the plan ${name} is not valid JSON\n`);
    return 1;
  }
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    stderr.write(`the plan ${name} is not a JSON object\n`);
    return 1;
  }
  try {
    const dir = stateDir(root, config, env);
    const at = (now ?? (() => new Date()))();
    const claim = planFiles(plan, { cwd, root, config });
    const r = takeFiles(dir, { id, files: claim.files, me: { pid: mePid(env), slot: currentSlot(env) }, now: at });
    dropReservations(dir, id);
    if (r.ok) {
      clearWait(dir, id);
      stdout.write(`${JSON.stringify({ ok: true, ...claim })}\n`);
      return 0;
    }
    writeWait(dir, id, r.conflicts, at, claim.files);
    stdout.write(`${JSON.stringify({ ok: false, heldBy: r.conflicts, reason: waitReason(r.conflicts) })}\n`);
    return HELD;
  } catch (err) {
    // The error code only (ENOTDIR, EACCES): err.message names local paths.
    const code = typeof err?.code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(err.code) ? ` (${err.code})` : '';
    stderr.write(`lock: could not claim the files${code}\n`);
    return 1;
  }
}

export default {
  name: 'lock',
  summary: 'exclusive resources and file locks (held <name> | take <name> <id> | release <name> | files <id> --plan <file> | owner-claim <id>)',

  async run(args, ctx) {
    const { root, env, stderr, now } = ctx;
    if (args[0] === 'files') return files(args.slice(1), ctx);
    const [sub, a, b] = args;
    const needs = { held: !!a, take: !!a && !!b, release: !!a, 'owner-claim': !!a };
    if (!(sub in needs) || !needs[sub]) {
      stderr.write(USAGE);
      return 1;
    }
    const { config, errors } = loadConfig(root);
    if (errors.length) {
      stderr.write(`${errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join('\n')}\n`);
      return 1;
    }
    try {
      const dir = stateDir(root, config, env);
      adoptLegacySchemaLock(dir);
      if (sub === 'owner-claim') {
        ownerClaim(dir, a, (now ?? (() => new Date()))());
        return 0;
      }
      if (!Object.hasOwn(config.resources ?? {}, a)) {
        stderr.write(`no resource named ${a}\n`);
        return 1;
      }
      const file = RESOURCE(dir, a);
      const slot = currentSlot(env);
      const holder = holderOf(file);
      const mine = holdsResource(dir, a, slot);
      if (sub === 'release') {
        // This slot's lock, live or left by a dead supervisor; never another slot's.
        if (holder && holder.slot === slot) rmSync(file, { force: true });
        else if (holder && !holder.stale) stderr.write(`${a} is held by slot ${holder.slot ?? '?'} (${holder.story ?? 'a story'}); left alone\n`);
        return 0;
      }
      if (sub === 'held') {
        if (mine) return 0;
        stderr.write(holder && !holder.stale ? `${a} is held by slot ${holder.slot ?? '?'} (${holder.story ?? 'a story'})\n` : `${a} is not held\n`);
        return 1;
      }
      if (mine) return 0;
      const pid = Number(env.FOREMAN_SUPERVISOR_PID);
      const me = { pid: Number.isInteger(pid) && pid > 0 ? pid : process.pid, slot, story: b, by: 'factory', at: (now ?? (() => new Date()))().toISOString() };
      let r = take(file, me);
      if (!r.ok && r.stale) {
        breakIfStale(file);
        r = take(file, me);
      }
      if (r.ok) return 0;
      stderr.write(`${a} is held by slot ${r.holder?.slot ?? '?'} (${r.holder?.story ?? 'a story'})\n`);
      return 1;
    } catch (err) {
      stderr.write(`lock: ${err.message}\n`);
      return 1;
    }
  },
};
