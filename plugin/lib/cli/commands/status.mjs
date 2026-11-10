// `foreman status [--json]`: what the run is doing, from the same snapshot a console is sent.
// With no run active, the loop reads as stopped, or paused when the console's controls say so
// (the next run then starts paused). The console is opened first, so one set up wrongly is
// reported here.
//
// The Waiting on you block reads like the dashboard's tab, from the whole ranked list
// (state.mjs ownerWaiting, lib/console/waiting.mjs), not the snapshot's first five:
//
//   Waiting on you: N (M later)   the count, a bundle once; M is the owner tasks for later
//     <headline>                  why the factory is idle and the one thing to do first; it
//                                 ends with the stories left In Progress with nothing running
//                                 them, and shows for them even when the run is stopped
//     Needs you now (N):          each item but owner tasks and bundles, with its why under it
//     Your tasks (N):             one line per owner task: what it frees, and what it takes
//                                 (its brief's Effort or Takes section, read from the cache)
//     Quick decisions (B):        one line per bundle, with the `foreman decide` command that
//                                 answers it whole
//     Later: N (first after <id>) the owner tasks still waiting on an open story
//     FYI: <why>                  read-only notes, such as Jira not reachable for a while, or
//                                 a slow story ("slow: ACME-1 in its fix round for 1 h 45 min
//                                 (129 steps)"): active, but one stage past watchdog.progressMinutes;
//                                 or the Claude API limited or down ("The Claude API is limited or
//                                 down (wait 2); Foreman tries again at 14:05 by itself.")
//
// A pause that tries again by itself (a usage limit or an empty balance) says when: the headline
// reads "Paused: <reason>. Foreman tries again at HH:MM by itself; Resume starts it sooner." and
// the Needs you now item's why ends "Foreman tries again at HH:MM by itself."
//
// A slot held for the Claude API reads "w1  held until the API is back (retry at 14:05)  ACME-1 T ·
// release" in place of "held" and the reason in brackets.
//
// A slot whose test run waits for a free check slot (the snapshot's checkWait) reads "... · check
// queued: waiting for a free check slot" after its story, so a queued run is not taken for a stalled one.
//
// Each section shows only when it has something in it. `--json` prints the snapshot as is.
// Before the block, once Foreman has learned anything (lib/console/learned.mjs learningCounts),
// "Learning: N active, M in evaluation": the learned items in force and those still on trial. A
// ledger that cannot be read leaves the line out; status never fails on it.
// While the run is not making progress (the snapshot's stuck), the first line reads "Foreman:
// running, but stuck: <reason>" and the run:stuck item shows under Needs you now. A slow story
// (the snapshot's slow) is only an FYI line: the first line still reads "Foreman: running".
// While the run is about to restart on new plugin code (the snapshot's restartPending), each idle
// slot reads "waiting for restart" and one line after the slots says why ("New code (a1b2c3d →
// e4f5a6b): restarting as soon as the slots being set up are ready; the stories in progress keep
// running."); the run:restart item is left out of the FYI lines, so the sentence shows once.
// Who stopped the run (the snapshot's stoppedBy, console/stopper.mjs) is named: a stopped run
// reads "Foreman: stopped by ACME-9's session at 04:01 UTC", and while a run still finishes its
// stories after a stop, the line after the first reads "  Stop requested by <who>: the run
// finishes the stories in progress, then stops."
// While a run is on the last good config (foreman.config.json turned invalid under it), status
// reads that config, says so on stderr, and the run:config item shows under Needs you now; with
// no run on it, an invalid file is refused as by every other command.
// While more stories run than the worker count (it was lowered while they ran; the snapshot's
// draining), the Workers line says so: "Workers: 3 of 5 slots · 4 running, limit 3: draining".
// The stories skipped from the command centre this run (the snapshot's skipped) get one line after
// the slots: "  Skipped this run: ACME-1, ACME-2 (`foreman next <id>` builds one again)".
// Queued work (the snapshot's queued) follows it under "  Queued:", one line of its text each:
// "    ACME-4 queued for w4, which is over the worker count; w1 takes it next".
// Stories kept out of the picker because a running story holds their files (the snapshot's
// fileWaits) follow under "  Waiting on running stories:": "    ACME-2 waits for ACME-1: src/a.mjs".

import { readFileSync } from 'node:fs';
import { BUNDLES } from '../../console/bundles.mjs';
import { taskDetails } from '../../console/task-details.mjs';
import { learningCounts } from '../../console/learned.mjs';
import { headline, waitingCount } from '../../console/waiting.mjs';
import { restartWhy } from '../../engine/code-version.mjs';
import { openConsole } from '../../engine/console.mjs';
import { ownerWaiting, snapshot } from '../../engine/state.mjs';
import { openStorySource } from '../../engine/story-source.mjs';
import { openProject } from './console-shared.mjs';

const RECENT = 5;

export const dollars = (n) => `$${(Number(n) || 0).toFixed(2)}`;
export function duration(minutes) {
  const m = Number(minutes) || 0;
  if (m < 1) return '<1 min';
  if (m < 90) return `${Math.round(m)} min`;
  return `${Math.floor(m / 60)} h ${Math.round(m % 60)} min`;
}

// "$2.46 · 42 min" for a story whose session recorded them; empty when it did not.
function costLine(r) {
  const parts = [];
  if (typeof r.costUsd === 'number') parts.push(dollars(r.costUsd));
  if (typeof r.minutes === 'number') parts.push(duration(r.minutes));
  return parts.join(' · ');
}

function loopLine(snap) {
  const loop = snap.loop?.state ?? 'stopped';
  const paused = snap.control?.paused === true;
  if (loop === 'stopped') {
    if (paused) return 'paused (no run active; the next run starts paused)';
    return snap.stoppedBy?.text ? `stopped by ${snap.stoppedBy.text}` : 'stopped';
  }
  if (loop === 'running' && paused) return 'running, pause requested';
  if (loop === 'running' && snap.stuck?.reason) return `running, but stuck: ${snap.stuck.reason}`;
  // The headline under Waiting on you carries the whole Standby sentence.
  if (loop === 'standby') return paused ? 'standby, pause requested' : 'standby';
  return snap.loop?.reason ? `${loop}: ${snap.loop.reason}` : loop;
}

const isText = (v) => typeof v === 'string' && v.trim() !== '';
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// One line per bundle, in the words of the dashboard's bundle card, with the command that
// answers it whole.
function bundleLine(name, list) {
  const command = `foreman decide answer --bundle ${name} "${BUNDLES[name]['create-all']}"`;
  if (name === 'follow-ups') {
    const minor = list.reduce((m, i) => m + (Number(i.minor) || 0), 0);
    return `    ${plural(list.length, 'follow-up', 'follow-ups')} from recent runs: ${plural(minor, 'minor finding', 'minor findings')} · ${command}`;
  }
  return `    ${plural(list.length, 'trait proposal', 'trait proposals')} · ${command}`;
}

function taskLine(item, takes) {
  const frees = Array.isArray(item.frees) ? item.frees : [];
  const blocks = Array.isArray(item.blocks) ? item.blocks : [];
  let line = `    ${item.title}`;
  if (frees.length) line += ` · frees ${frees.join(', ')}`;
  else if (blocks.length) line += ' · frees nothing by itself';
  const effort = takes.get(item.id);
  if (isText(effort)) line += ` · takes ${effort}`;
  return line;
}

// The Waiting on you block (see the header), split as the tab splits it (page.html waitingCardView).
function waitingLines(snap, items, takes, stranded) {
  const later = items.filter((i) => i.group === 'later');
  const now = items.filter((i) => i.group === 'now');
  const lines = [`Waiting on you: ${waitingCount(items)}${later.length ? ` (${later.length} later)` : ''}`];
  if (items.length || stranded.length || (snap.loop?.state ?? 'stopped') !== 'stopped') lines.push(`  ${headline({ items, loop: snap.loop, slots: snap.slots ?? [], stranded }).text}`);
  const needs = now.filter((i) => !isText(i.bundle) && i.kind !== 'owner-task');
  if (needs.length) {
    lines.push(`  Needs you now (${needs.length}):`);
    for (const i of needs) {
      lines.push(`    ${i.title}`);
      if (isText(i.why)) lines.push(`      ${i.why}`);
    }
  }
  const tasks = now.filter((i) => i.kind === 'owner-task');
  if (tasks.length) {
    lines.push(`  Your tasks (${tasks.length}):`);
    for (const i of tasks) lines.push(taskLine(i, takes));
  }
  const bundles = new Map();
  for (const i of now.filter((i) => isText(i.bundle))) bundles.set(i.bundle, [...(bundles.get(i.bundle) ?? []), i]);
  if (bundles.size) {
    lines.push(`  Quick decisions (${bundles.size}):`);
    for (const [name, list] of bundles) lines.push(bundleLine(name, list));
  }
  if (later.length) {
    const first = Array.isArray(later[0].waitsOn) && later[0].waitsOn.length ? ` (first after ${later[0].waitsOn[0]})` : '';
    lines.push(`  Later: ${later.length}${first}`);
  }
  // The pending restart has its own line under the slots.
  for (const i of items.filter((i) => i.group === 'fyi' && i.id !== 'run:restart')) lines.push(`  FYI: ${i.why}`);
  return lines;
}

// What each owner task that can start now takes, from its brief's Effort or Takes section:
// a Map of the text by item id (task:<id>). The source is opened cache-only, so status never waits
// on Jira; a task whose brief cannot be read has no entry.
function takesOf(items, { root, config, env, clock }) {
  const takes = new Map();
  const tasks = items.filter((i) => i.kind === 'owner-task' && i.group === 'now');
  if (!tasks.length) return takes;
  let source;
  try {
    source = openStorySource({ root, config, env, now: () => clock, cacheOnly: true });
  } catch {
    return takes;
  }
  for (const item of tasks) {
    try {
      const path = source.brief(item.id.slice('task:'.length))?.path;
      if (!path) continue;
      const effort = taskDetails(readFileSync(path, 'utf8')).effort;
      if (isText(effort)) takes.set(item.id, effort);
    } catch {
      // no takes for this task
    }
  }
  return takes;
}

export function describeStatus(snap, slots, { items = snap.waiting?.items ?? [], takes = new Map(), learning = null, stranded = [] } = {}) {
  const lines = [`Foreman: ${loopLine(snap)}`];
  if ((snap.loop?.state ?? 'stopped') !== 'stopped' && snap.stoppedBy?.text) {
    lines.push(`  Stop requested by ${snap.stoppedBy.text}: the run finishes the stories in progress, then stops.`);
  }
  lines.push(`Workers: ${snap.workers} of ${slots} ${slots === 1 ? 'slot' : 'slots'}${snap.draining?.text ? ` · ${snap.draining.text}` : ''}`);
  const pending = snap.restartPending ?? null;
  for (const s of snap.slots ?? []) {
    const story = s.story ? `${s.story.id}${s.story.title ? ` ${s.story.title}` : ''} · ${s.story.stage}` : '';
    // A slot held for the Claude API shows its words ("held until the API is back (retry at
    // 14:05)") as its state; every other reason follows in brackets.
    const apiHeld = s.state === 'held' && s.heldFor === 'api' && typeof s.reason === 'string' && s.reason.trim() !== '';
    const why = s.reason && !apiHeld ? ` (${s.reason})` : '';
    const state = pending && s.state === 'idle' ? 'waiting for restart' : apiHeld ? s.reason : s.state;
    const queued = s.checkWait?.text ? ` · ${s.checkWait.text}` : '';
    lines.push(`  ${s.id.padEnd(3)} ${state.padEnd(9)} ${story}${queued}${why}`.trimEnd());
  }
  if (pending) lines.push(`  ${restartWhy(pending)}`);
  if (snap.skipped?.length) lines.push(`  Skipped this run: ${snap.skipped.join(', ')} (\`foreman next <id>\` builds one again)`);
  if (snap.queued?.length) lines.push('  Queued:', ...snap.queued.map((q) => `    ${q.text}`));
  if (snap.fileWaits?.length) lines.push('  Waiting on running stories:', ...snap.fileWaits.map((w) => `    ${w.text}`));
  const recent = (snap.recent ?? []).slice(0, RECENT);
  if (recent.length) {
    lines.push('Recent:');
    for (const r of recent) {
      const cost = costLine(r);
      lines.push(`  ${r.id} ${r.result}${cost ? `  ${cost}` : ''}${r.pr ? `  ${r.pr}` : ''}${r.note ? `  ${r.note}` : ''}`);
    }
  }
  const t = snap.totals;
  if (t && (t.stories || t.costUsd || t.minutes)) {
    lines.push(`This run: ${t.stories} ${t.stories === 1 ? 'story' : 'stories'}, ${t.shipped} shipped, ${dollars(t.costUsd)}, ${duration(t.minutes)}`);
  }
  if (learning) lines.push(`Learning: ${learning.active} active, ${learning.evaluating} in evaluation`);
  lines.push(...waitingLines(snap, items, takes, Array.isArray(stranded) ? stranded : []));
  return `${lines.join('\n')}\n`;
}

export default {
  name: 'status',
  summary: 'what the run is doing (status [--json])',

  async run(args, { root, env, stdout, stderr, now }) {
    const extra = args.filter((a) => a !== '--json');
    if (extra.length) {
      stderr.write('usage: foreman status [--json]\n');
      return 1;
    }
    const project = openProject({ root, env, stderr, lastGood: true });
    if (!project) return 1;
    const clock = (now ?? (() => new Date()))();
    let controls;
    try {
      controls = await openConsole({ config: project.config, ctx: { stateDir: project.dir, now: () => clock } }).controls();
    } catch (err) {
      stderr.write(`foreman.config.json console: ${err.message}\n`);
      return 1;
    }
    const snap = await snapshot(project.dir, clock, null, { root, slots: project.config.slots, env });
    snap.control = { ...snap.control, paused: controls.paused === true };
    if (args.includes('--json')) {
      stdout.write(`${JSON.stringify(snap, null, 2)}\n`);
      return 0;
    }
    const { items, stranded } = await ownerWaiting(project.dir, clock, { root, env, slots: project.config.slots, loop: snap.loop });
    const takes = takesOf(items, { root, config: project.config, env, clock });
    let learning = null;
    try {
      learning = learningCounts(project.dir);
    } catch {
      // a ledger that cannot be read: no Learning line
    }
    stdout.write(describeStatus(snap, project.config.slots, { items, takes, learning, stranded }));
    return 0;
  },
};
