// What a story was sent back for before, from findings.jsonl, so a later session can tell that
// review keeps finding the same kind of bug. Pure; the callers read the file.
//
//   EARLIER_LIMIT                      how many earlier findings a launch carries at most (60)
//   earlierFindings(lines, id, { limit })
//                                      the story's blocker and major findings that have a rule,
//                                      oldest first, the newest `limit` of them, each as
//                                      { stage, severity, rule, where, observed, fix, round?, at? };
//                                      result, builder, resolved, story and repeats are dropped
//   failedSince(lines, id, since)      true when the story has a failed line written after `since`;
//                                      with a `since` that is no date, any failed line counts
//   rethinkOf(value)                   { round, findings, cause?, line? } from the file the story skill
//                                      writes when the pipeline returns `rethink`; cause is "story"
//                                      when the builder found the story cannot hold as written, and
//                                      line (a whole number of at least 1) only goes with it; throws
//                                      an Error whose message is the reason when it is not one
//   rethinkNote(round, { cause, line }) the line the story is told when it goes back to the architect:
//                                      the same-kind text, or with cause "story" that the builder
//                                      found Done-when <line> (or the story) cannot hold

import { SERIOUS } from './learn.mjs';

export const EARLIER_LIMIT = 60;

const str = (v) => (typeof v === 'string' ? v : '');

export function earlierFindings(lines, id, { limit = EARLIER_LIMIT } = {}) {
  const mine = (Array.isArray(lines) ? lines : []).filter(
    (l) => l && l.story === id && SERIOUS.includes(String(l.severity ?? '').toLowerCase()) && str(l.rule).trim() !== '',
  );
  return mine.slice(Math.max(0, mine.length - limit)).map((l) => ({
    stage: str(l.stage),
    severity: str(l.severity),
    rule: str(l.rule),
    where: str(l.where),
    observed: str(l.observed),
    fix: str(l.fix),
    ...(Number.isInteger(l.round) ? { round: l.round } : {}),
    ...(typeof l.at === 'string' ? { at: l.at } : {}),
  }));
}

export function failedSince(lines, id, since) {
  const t = Date.parse(since);
  return (Array.isArray(lines) ? lines : []).some((l) => l && l.story === id && l.result === 'failed' && (Number.isNaN(t) || Date.parse(l.at) > t));
}

export function rethinkOf(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('it must be an object with round and findings');
  if (!Number.isInteger(value.round) || value.round < 1) throw new Error('round must be a whole number of at least 1');
  const { findings } = value;
  if (!Array.isArray(findings) || findings.length === 0 || findings.some((f) => f === null || typeof f !== 'object' || Array.isArray(f))) {
    throw new Error('findings must be a non-empty list');
  }
  const { cause, line } = value;
  if (cause !== undefined && cause !== 'story') throw new Error('cause must be "story" when set');
  if (line !== undefined && (cause !== 'story' || !Number.isInteger(line) || line < 1)) throw new Error('line must be a whole number of at least 1, with cause "story"');
  return { round: value.round, findings, ...(cause ? { cause } : {}), ...(line !== undefined ? { line } : {}) };
}

export function rethinkNote(round, { cause, line } = {}) {
  if (cause !== 'story') return `Round ${round} found the same kind of bug again; sent back to the architect to change the approach.`;
  return `The builder found ${line === undefined ? 'the story cannot hold as written' : `Done-when ${line} cannot hold`}; sent back to the architect to correct it.`;
}
