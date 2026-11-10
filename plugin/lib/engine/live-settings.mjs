// The settings the supervisor reads fresh before every pick:
// foreman.config.json and the local layer (<stateDir>/settings.json) are re-read only when
// either file's mtime or size changed, so a tick with no change costs two stats.
//
// What a reload changes, from the next pick on:
//   workers           how many slots build at once, capped at the slots this run started with
//                     (`slots` applies on restart)
//   watchdog.*        the watchdog's limits (watchdogLimits)
//   features.*        the switches the supervisor itself acts on (costMetrics: recordsRuns)
// rounds and the ship timeouts are read by `foreman workflow-args` and `foreman ship`
// themselves, each run, so they need nothing from here.
//
// The worker count, in order of precedence:
//   1. At start, `foreman run --workers N` when given, else the `workers` setting in effect.
//   2. Later, each change counts once, when it is made: a `foreman workers N` or dashboard
//      change (control.json workersAt), or a settings change that alters `workers` (the
//      changed file's mtime). The newest change wins and applies at the next pick; on the same
//      millisecond the settings change wins. A settings reload that leaves `workers` as it was
//      changes nothing, so it never undoes a newer `foreman workers`.
//   3. Whatever wins is capped at the run's slots, with a warning when it asked for more.
//
// An invalid foreman.config.json keeps the settings from before. The warning comes once per
// reason, not at every change to the file; `problem` holds the reason until a valid reload,
// which says the file is valid again. `team` is the config without the local layer from the
// last valid load, the copy the supervisor saves as the last good config (config-health.mjs).
//
// The decisions are pure functions; liveSettings() wraps them around the two files, with the
// stat and the load injectable for tests. fileStamps() is the same two stats on their own, for
// a reader that reloads by itself (the dashboard).

import { statSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_FILE } from '../config/load.mjs';
import { localFile } from '../settings/local.mjs';
import { loadResolved } from '../settings/load.mjs';
import { CEILING_FACTOR } from './scheduler.mjs';

// ── pure ─────────────────────────────────────────────────────────────────────────────────────

const stampOf = (s) => (s ? `${s.mtimeMs}:${s.size}` : null);

// Whether either file changed since `prev` ({ config, local } stamps, null for a missing file).
export const changed = (prev, next) => prev?.config !== next?.config || prev?.local !== next?.local;

// The newest mtime among the files that changed: when the settings change was made.
export function changedAt(prev, next, mtimes) {
  const at = [];
  if (prev?.config !== next?.config && mtimes.config !== null) at.push(mtimes.config);
  if (prev?.local !== next?.local && mtimes.local !== null) at.push(mtimes.local);
  return at.length ? Math.max(...at) : 0;
}

const capWarning = (asked, slots) => ({ text: `Workers ${asked} is more than the ${slots} ${slots === 1 ? 'slot' : 'slots'} this run has; using ${slots}.`, kind: 'warn' });

// The worker count a run starts with: the --workers flag when given, else the setting.
export function startWorkers({ flag, config, slots }) {
  const asked = Number.isInteger(flag) && flag >= 1 ? flag : Number.isInteger(config?.workers) && config.workers >= 1 ? config.workers : 1;
  const workers = Math.min(asked, slots);
  return { workers, from: asked === flag ? 'flag' : 'settings', events: asked > slots ? [capWarning(asked, slots)] : [] };
}

// The worker count for the next pick. `changes` are the worker changes seen since the last
// pick, each { from: 'control' | 'settings', value, at (ms) }; the newest wins, settings on a tie.
export function nextWorkers({ current, changes = [], slots }) {
  const valid = changes.filter((c) => Number.isInteger(c.value) && c.value >= 1);
  if (!valid.length) return { workers: current, events: [] };
  const newest = valid.reduce((a, b) => (b.at > a.at || (b.at === a.at && b.from === 'settings') ? b : a));
  const workers = Math.min(newest.value, slots);
  const events = newest.value > slots ? [capWarning(newest.value, slots)] : [];
  if (workers !== current) {
    events.push({ text: `Worker count set to ${workers}${newest.from === 'settings' ? ' in the settings' : ''}; applied at the next pick.`, kind: 'info' });
  }
  return { workers, from: newest.from, events };
}

// The watchdog's limits from the resolved config. The hard ceiling is CEILING_FACTOR times the
// build limit; it has no setting of its own.
export function watchdogLimits(config) {
  const quietMinutes = config?.watchdog?.quietMinutes ?? 30;
  const buildMinutes = config?.watchdog?.buildMinutes ?? 120;
  const ceilingMinutes = buildMinutes * CEILING_FACTOR;
  return { quietMinutes, buildMinutes, quietMs: quietMinutes * 60_000, buildMs: buildMinutes * 60_000, ceilingMinutes, ceilingMs: ceilingMinutes * 60_000 };
}

// Whether the supervisor writes run records (features.costMetrics).
export const recordsRuns = (config) => config?.features?.costMetrics !== false;

// ── the files ────────────────────────────────────────────────────────────────────────────────

const realStat = (file) => {
  try {
    const s = statSync(file);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
};

// { config, local }: each file's stamp now, null for a missing file. `changed` compares two.
export function fileStamps({ root, dir }, stat = realStat) {
  return { config: stampOf(stat(join(root, CONFIG_FILE))), local: stampOf(stat(localFile(dir))) };
}

const errorText = (errors) => errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join('; ');

// Loads the config once now and keeps it current. `slots` is the run's slot count, fixed at
// start. Returns { config, team, problem, errors, startWorkers(flag), beforePick({ current, control }) }:
//   config       the resolved config in effect (null only when the first load failed)
//   team         the same without the local layer, from the last valid load
//   problem      why foreman.config.json is invalid now, or null
//   beforePick   reloads when a file changed and returns { workers, config, events } for the
//                next pick; `control` is the control.json worker changes since the last pick,
//                each { value, at (ms) }; events are { text, kind } for the run's event list
export function liveSettings({ root, dir, env = process.env, slots, stat = realStat, load = () => loadResolved(root, { env }) }) {
  const files = { config: join(root, CONFIG_FILE), local: localFile(dir) };
  const read = () => {
    const c = stat(files.config);
    const l = stat(files.local);
    return { stamps: { config: stampOf(c), local: stampOf(l) }, mtimes: { config: c ? c.mtimeMs : null, local: l ? l.mtimeMs : null } };
  };

  // Stamps first, then the load: a write in between is seen at the next pick, never lost.
  let { stamps } = read();
  const first = load();
  let config = first.config;
  let team = first.team ?? null;
  let problem = null;
  let shownSlots = config?.slots ?? slots;

  function reload() {
    const now = read();
    if (!changed(stamps, now.stamps)) return { settings: null, events: [] };
    const at = changedAt(stamps, now.stamps, now.mtimes);
    stamps = now.stamps;
    const r = load();
    if (!r.config) {
      const reason = errorText(r.errors ?? []);
      const events = reason === problem ? [] : [{ text: `foreman.config.json is invalid now (${reason}); keeping the settings from before.`, kind: 'warn' }];
      problem = reason;
      return { settings: null, events };
    }
    const events = (r.localWarnings ?? []).map((text) => ({ text, kind: 'warn' }));
    if (problem !== null) {
      events.push({ text: 'foreman.config.json is valid again; using it from the next pick.', kind: 'info' });
      problem = null;
    }
    team = r.team ?? null;
    const before = config;
    config = r.config;
    if (config.slots !== shownSlots) {
      shownSlots = config.slots;
      if (config.slots !== slots) events.push({ text: `slots is now ${config.slots} in the settings; it applies when the run restarts (this run keeps ${slots}).`, kind: 'info' });
    }
    const settings = before?.workers !== config.workers ? { from: 'settings', value: config.workers, at } : null;
    return { settings, events };
  }

  return {
    get config() {
      return config;
    },
    get team() {
      return team;
    },
    get problem() {
      return problem;
    },
    errors: first.errors ?? [],
    localWarnings: first.localWarnings ?? [],
    startWorkers: (flag) => startWorkers({ flag, config, slots }),
    beforePick({ current, control = [] }) {
      const r = reload();
      const changes = [...control.map((c) => ({ from: 'control', value: c.value, at: c.at })), ...(r.settings ? [r.settings] : [])];
      const w = nextWorkers({ current, changes, slots });
      return { workers: w.workers, config, events: [...r.events, ...w.events] };
    },
  };
}
