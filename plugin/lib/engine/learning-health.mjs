// How Foreman's self-learning is doing, for `foreman doctor` and `foreman report`. Pure helpers
// over the learning ledger (learning-store.mjs) and skills-lock.json's `skills`; nothing here
// reads or writes a file.
//
//   packRefs(text, lockSkills)    { <name>: {ref, commit} } for each lock skill `text` names as a
//                                 whole name (a full stop after it still counts), or null when it
//                                 names none or there is no lock. commit is null unless it is a
//                                 full hex commit id. The learning tick writes it as
//                                 metrics.packs on a learned skill's add and update lines.
//   movedPackSkills(ledger, lockSkills)
//                                 [{ id, name, was: {ref, commit}, now: {ref, commit} | null }]:
//                                 each learned skill in force whose version in force names a pack
//                                 skill the lock dropped (now null), moved to another tag, or whose
//                                 tag now points at another commit (both full ids). A version
//                                 written without metrics.packs is never reported.
//   learningStatus({ learning, ledger, spentToday, now })
//                                 { auto, apply, active, evaluating, rolledBack7d, refused7d, caps }.
//                                 `learning` is the config's learning block over its defaults.
//                                 A retire (rollback with metrics.decision 'retire') is not a
//                                 rollback. caps lists each cap reached, { label, n, max }, in the
//                                 order: each role's traits, learned skills, on trial, changes
//                                 today (Foreman's add and update lines on now's UTC day, as
//                                 learner.mjs capProblem counts them), learner spend today. A cap
//                                 of 0 is reached.
//   learningTotals({ ledger, calls, since })
//                                 { calls, costUsd, added, kept, rolledBack, retired, undone } over
//                                 the ledger lines and learner calls (learner.jsonl) whose UTC day is
//                                 on or after `since` (YYYY-MM-DD, or '' for all).

import { currentItems } from './learning-store.mjs';

const COMMIT = /^[0-9a-f]{40,64}$/;
const DAY_MS = 24 * 3600 * 1000;
const WEEK_MS = 7 * DAY_MS;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const idNumber = (id) => Number(/^L-(\d+)$/.exec(String(id))?.[1] ?? 0);
const dayOf = (at) => {
  const t = Date.parse(at);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
};
const isRetire = (line) => line.metrics?.decision === 'retire';
const commitOf = (v) => (typeof v === 'string' && COMMIT.test(v) ? v : null);

export function packRefs(text, lockSkills) {
  if (!isObject(lockSkills)) return null;
  const body = String(text ?? '');
  const out = {};
  for (const [name, entry] of Object.entries(lockSkills)) {
    if (!name || !new RegExp(`(?<![A-Za-z0-9_.-])${escape(name)}(?![A-Za-z0-9_-])`).test(body)) continue;
    out[name] = { ref: String(entry?.ref ?? ''), commit: commitOf(entry?.commit) };
  }
  return Object.keys(out).length ? out : null;
}

const inForce = (ledger) => [...currentItems(ledger).values()].filter((i) => i.v > 0).sort((a, b) => idNumber(a.id) - idNumber(b.id));

export function movedPackSkills(ledger, lockSkills) {
  if (!isObject(lockSkills)) return [];
  const out = [];
  for (const item of inForce(ledger)) {
    if (item.kind !== 'skill') continue;
    const written = item.lines.filter((l) => (l.action === 'add' || l.action === 'update') && l.v === item.v).at(-1);
    const packs = written?.metrics?.packs;
    if (!isObject(packs)) continue;
    for (const [name, was] of Object.entries(packs)) {
      const then = { ref: String(was?.ref ?? ''), commit: commitOf(was?.commit) };
      const entry = Object.hasOwn(lockSkills, name) ? lockSkills[name] : undefined;
      const now = entry === undefined ? null : { ref: String(entry?.ref ?? ''), commit: commitOf(entry?.commit) };
      const moved = !now || now.ref !== then.ref || (then.commit && now.commit && then.commit !== now.commit);
      if (moved) out.push({ id: item.id, name, was: then, now });
    }
  }
  return out;
}

export function learningStatus({ learning = {}, ledger = [], spentToday = 0, now = new Date() } = {}) {
  const at = now instanceof Date ? now : new Date();
  const live = inForce(ledger);
  const recent = (line) => {
    const t = Date.parse(line.at);
    return Number.isFinite(t) && t <= at.getTime() && at.getTime() - t <= WEEK_MS;
  };
  const caps = [];
  const cap = (label, n, max) => {
    if (!(n < Number(max))) caps.push({ label, n, max: Number(max) });
  };
  const roles = [...new Set(live.filter((i) => i.kind === 'trait').map((i) => i.roles[0]))].sort();
  for (const role of roles) cap(`${role} traits`, live.filter((i) => i.kind === 'trait' && i.roles[0] === role).length, learning.maxPerRole);
  cap('learned skills', live.filter((i) => i.kind === 'skill').length, learning.maxSkills);
  const evaluating = live.filter((i) => i.status === 'evaluating').length;
  cap('on trial', evaluating, learning.maxEvaluating);
  const day = at.toISOString().slice(0, 10);
  cap('changes today', ledger.filter((l) => (l.action === 'add' || l.action === 'update') && l.by === 'foreman' && dayOf(l.at) === day).length, learning.maxPerDay);
  cap('learner spend today', Math.max(0, Number(spentToday) || 0), learning.maxUsdPerDay);
  return {
    auto: learning.auto !== false,
    apply: learning.apply !== false,
    active: live.length,
    evaluating,
    rolledBack7d: ledger.filter((l) => l.action === 'rollback' && !isRetire(l) && recent(l)).length,
    refused7d: ledger.filter((l) => l.action === 'refused' && recent(l)).length,
    caps,
  };
}

export function learningTotals({ ledger = [], calls = [], since = '' } = {}) {
  const kept = (line) => !since || (dayOf(line?.at) ?? '') >= since;
  const lines = ledger.filter(kept);
  const counted = calls.filter(kept);
  const count = (test) => lines.filter(test).length;
  return {
    calls: counted.length,
    costUsd: Math.round(counted.reduce((sum, c) => sum + Math.max(0, Number(c?.costUsd) || 0), 0) * 1e6) / 1e6,
    added: count((l) => l.action === 'add'),
    kept: count((l) => l.action === 'keep'),
    rolledBack: count((l) => l.action === 'rollback' && !isRetire(l)),
    retired: count((l) => l.action === 'rollback' && isRetire(l)),
    undone: count((l) => l.action === 'undo'),
  };
}
