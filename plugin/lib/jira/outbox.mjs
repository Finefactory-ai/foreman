// The Jira outbox: writes Jira did not take yet, one JSON file per write in
// <stateDir>/jira-outbox/<time>-<rand>.json, replayed in name order (so in the order they were
// made) before any new write. A write never fails the caller: it is sent, queued, or dropped,
// and each queue, replay and drop is an event in <stateDir>/events.jsonl.
//
// The Salesforce story source keeps the same queue in its own folder, with its own name in the
// events: outbox(stateDir, { folder: 'salesforce-outbox', label: 'Salesforce', describe }), where
// describe(op) puts a write in words. The defaults are Jira's: jira-outbox, "Jira:", describeOp.
//
//   const box = outbox(stateDir, { now, slot, folder, label, describe });
//   box.entries()         [{ file, op }], oldest first
//   box.add(op)           queue one write (see writes.mjs for the ops)
//   box.lock()            a release function, or null when another process is sending
//   box.settle(batch, results)
//                         batch is [{ op, file? }] (file for a queued write), results what
//                         sendWrites gave for it: sent and dropped writes leave the queue,
//                         failed new writes join it.
//
// Events are written here directly, in the line format of state.mjs addEvent (importing
// state.mjs would make a cycle through the story sources).

import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeAtomic } from '../adapters/stories/overlay.mjs';

// A lock older than this was left by a process that died.
export const STALE_LOCK_MS = 5 * 60_000;

const linkWords = { Blocks: 'blocks', Relates: 'relates to' };

/** A write in words, for events: "a comment on APP-1", "the move of APP-1 to Done". */
export function describeOp(op) {
  if (op?.kind === 'comment') return `a comment on ${op.key}`;
  if (op?.kind === 'transition') return `the move of ${op.key} to ${op.name}`;
  if (op?.kind === 'link') return `the link ${op.outward} ${linkWords[op.type] ?? op.type} ${op.inward}`;
  if (op?.kind === 'unlink') return `the removal of the link ${op.outward} ${linkWords[op.type] ?? op.type} ${op.inward}`;
  return 'a write';
}

/** Appends one event line, as state.mjs addEvent does. Never throws. */
export function jiraEvent(stateDir, text, kind = 'info', { now = () => new Date(), slot = null } = {}) {
  try {
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(join(stateDir, 'events.jsonl'), `${JSON.stringify({ at: now().toISOString(), text, kind, slot })}\n`);
  } catch {
    // an event is never worth failing a story over
  }
}

export function outbox(stateDir, { now = () => new Date(), slot = null, folder = 'jira-outbox', label = 'Jira', describe = describeOp } = {}) {
  const dir = join(stateDir, folder);
  const lockFile = join(dir, '.lock');
  const event = (text, kind) => jiraEvent(stateDir, text, kind, { now, slot });

  const names = () => {
    try {
      return readdirSync(dir).filter((f) => /^\d+-[0-9a-f]+\.json$/.test(f)).sort();
    } catch {
      return [];
    }
  };

  function entries() {
    const out = [];
    for (const name of names()) {
      const file = join(dir, name);
      try {
        out.push({ file, op: JSON.parse(readFileSync(file, 'utf8')) });
      } catch {
        // A torn file: it can never be sent.
        rmSync(file, { force: true });
        event(`${label}: dropped a queued write that could not be read (${name}).`, 'warn');
      }
    }
    return out;
  }

  function add(op) {
    // The time in the name orders the queue; it never goes backwards, even with a frozen clock.
    const last = Number(names().at(-1)?.split('-')[0] ?? 0);
    const at = Math.max(+now(), last + 1);
    writeAtomic(join(dir, `${String(at).padStart(15, '0')}-${randomBytes(4).toString('hex')}.json`), `${JSON.stringify(op)}\n`);
  }

  function lock() {
    mkdirSync(dir, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        closeSync(openSync(lockFile, 'wx'));
        return () => rmSync(lockFile, { force: true });
      } catch (err) {
        if (err?.code !== 'EEXIST') return null;
        try {
          if (Date.now() - statSync(lockFile).mtimeMs < STALE_LOCK_MS) return null;
          rmSync(lockFile, { force: true });
        } catch {
          // gone meanwhile: try again
        }
      }
    }
    return null;
  }

  function settle(batch, results) {
    batch.forEach(({ op, file }, i) => {
      const r = results?.[i] ?? { status: 'failed', error: `no answer from ${label}` };
      const what = describe(op);
      if (r.status === 'sent' || r.status === 'unavailable') {
        if (file) {
          rmSync(file, { force: true });
          event(`${label}: sent ${what} from the queue.`, 'info');
        }
        if (r.status === 'unavailable') event(`${label}: could not move ${op.key} to ${op.name} from ${r.from}.`, 'warn');
      } else if (r.status === 'dropped') {
        if (file) rmSync(file, { force: true });
        event(`${label}: dropped ${what}: ${r.error}`, 'warn');
      } else if (!file) {
        add(op);
        event(`${label}: could not send ${what} (${r.error}); queued to retry.`, 'warn');
      }
    });
  }

  return { dir, entries, add, lock, settle, isEmpty: () => names().length === 0 };
}
