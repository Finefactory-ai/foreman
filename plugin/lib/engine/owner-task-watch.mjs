// How long an owner task has held back a story, and the one time the owner is told. Pure: the
// supervisor reads the waiting list (state.mjs ownerWaiting) and keeps the result in state.json.
//
//   ownerTaskHours(config) -> hours
//       config.watchdog.ownerTaskHours, else OWNER_TASK_HOURS (24). Fractions are fine.
//   ownerTaskWatch({ seen, items, now, hours }) -> { seen, tell, changed }
//       Watches the items of kind 'owner-task' that are now (not later) and block something.
//       Stories carry no created time, so the clock starts when the task is first seen:
//       seen[<task id>] = { since: ISO, told: boolean }. since is kept while it is a valid ISO
//       time, else set to now. A task whose clock has run hours is in `tell` once, as
//       { task, title, holds, since }, and marked told. An entry for a task no longer watched is
//       dropped, so a task that blocks again later starts a fresh clock. `changed` says whether
//       seen differs from the one given.
//   ownerTaskText({ task, title, holds, since }, now) -> text
//       'Owner task ACME-1 "Add the key" has held ACME-2 for 5 days.'
//       Square brackets in the title become parentheses, so the title cannot form a markdown
//       link in the email lead.

import { names } from '../console/waiting.mjs';

export const OWNER_TASK_HOURS = 24;

export const ownerTaskHours = (config) => config?.watchdog?.ownerTaskHours ?? OWNER_TASK_HOURS;

const HOUR_MS = 3_600_000;
const validIso = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v));

export function ownerTaskWatch({ seen = {}, items = [], now, hours } = {}) {
  const at = new Date(now);
  const nowMs = at.getTime();
  const limit = hours * HOUR_MS;
  const before = seen && typeof seen === 'object' && !Array.isArray(seen) ? seen : {};
  const next = {};
  const tell = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.kind !== 'owner-task' || item.group !== 'now' || !Array.isArray(item.blocks) || !item.blocks.length) continue;
    const task = String(item.id).replace(/^task:/, '');
    const old = before[task];
    const since = validIso(old?.since) ? old.since : at.toISOString();
    let told = validIso(old?.since) && old?.told === true;
    if (!told && nowMs - Date.parse(since) >= limit) {
      tell.push({ task, title: item.title ?? '', holds: [...item.blocks], since });
      told = true;
    }
    next[task] = { since, told };
  }
  return { seen: next, tell, changed: JSON.stringify(next) !== JSON.stringify(before) };
}

function duration(ms) {
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(ms / HOUR_MS);
  return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} days`;
}

const plain = (s) => String(s ?? '').replace(/\[/g, '(').replace(/\]/g, ')');

export function ownerTaskText({ task, title, holds, since }, now) {
  const held = duration(new Date(now).getTime() - Date.parse(since));
  return `Owner task ${task}${title ? ` "${plain(title)}"` : ''} has held ${names(holds)} for ${held}.`;
}
