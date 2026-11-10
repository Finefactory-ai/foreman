// The queue behind the notes Foreman writes on a story (story-notes.mjs posts them, in words
// from story-note-text.mjs). Pure files, so any process can queue a note and none waits: the
// files console (console/decisions.mjs) queues a decision and its answer, a command or a hook
// queues the rest, and whoever flushes next posts them. Only node built-ins and the overlay's
// file helpers are imported, so console/decisions.mjs can import this with no cycle.
//
// Layout under <stateDir>/story-notes/:
//   pending/<15-digit ms>-<8 hex>.json   one entry { story, kind, data, at (ISO), slot }; the
//                                        name orders the queue by time and never goes
//                                        backwards, as the Jira outbox's does
//   posted/<safe story id>.json          { keys: [last 1000 note keys], design: the last design
//                                        posted | null }, so a note is never posted twice
//   .lock                                taken with openSync 'wx' by whoever flushes; one older
//                                        than 5 minutes was left by a process that died
//
//   queueStoryNote(dir, { story, kind, data, at, slot })   the file name, or null; never throws;
//                                        skips a note already posted (its noteKey is in the
//                                        story's keys; a design is compared with the last one)
//   pendingNotes(dir)                    [{ file, entry }], oldest first; a torn file is removed
//   hasPendingNotes(dir)                 whether any note is queued; never throws, never makes a folder
//   readPosted(dir, id), writePosted(dir, id, value)
//   lockNotes(dir)                       a release function, or null while another process holds it
//   noteKey(kind, data)                  16 hex of sha256 over the kind and the data that
//                                        matters: what makes a note the same note again
//   decisionNote(item), answerNote(item) the entry for a decision, and for its answer; a
//                                        decision's body is never in it
//   designData(plan)                     the plan's parts a reader needs, copied, a missing text ''

import { createHash, randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { safeId, writeAtomic } from '../adapters/stories/overlay.mjs';

export const STALE_LOCK_MS = 5 * 60_000;
export const KEEP_KEYS = 1000;

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v : '');
const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

export const notesDir = (dir) => join(dir, 'story-notes');
const pendingDir = (dir) => join(notesDir(dir), 'pending');
const postedFile = (dir, id) => join(notesDir(dir), 'posted', `${safeId(id)}.json`);

export function designData(plan) {
  const p = isPlain(plan) ? plan : {};
  const q = isPlain(p.owner_question) ? p.owner_question : null;
  return {
    ready: p.ready === true,
    blocker: text(p.blocker),
    needs_owner: p.needs_owner === true,
    builder: text(p.builder),
    resources: list(p.resources),
    files: list(p.files),
    design: text(p.design),
    test_plan: text(p.test_plan),
    done_when: text(p.done_when),
    owner_question: q
      ? {
          summary: text(q.summary),
          options: (Array.isArray(q.options) ? q.options : []).filter(isPlain).map((o) => ({ label: text(o.label), hint: text(o.hint) })),
          recommend: text(q.recommend),
        }
      : null,
  };
}

export function noteKey(kind, data) {
  const d = isPlain(data) ? data : {};
  let significant;
  switch (kind) {
    case 'decision':
      significant = [d.id, d.title, d.summary, d.options, d.hints, d.recommend];
      break;
    case 'answer':
      significant = [d.id, d.option, d.note];
      break;
    case 'design':
      significant = designData(d);
      break;
    case 'round':
      significant = d.key;
      break;
    case 'session':
      significant = [d.why, d.next, d.kept, d.resetAt, d.reason, d.session];
      break;
    case 'release':
      significant = [d.code, d.stage, d.reason, d.pr];
      break;
    case 'follow-up':
      significant = [d.id];
      break;
    default:
      significant = d;
  }
  return createHash('sha256').update(JSON.stringify([kind, significant ?? null])).digest('hex').slice(0, 16);
}

export function decisionNote(item) {
  return {
    story: item?.story,
    kind: 'decision',
    data: {
      id: item?.id,
      kind: item?.kind === 'task' ? 'task' : 'decision',
      title: text(item?.title),
      summary: text(item?.summary),
      options: list(item?.options),
      hints: list(item?.hints),
      recommend: text(item?.recommend),
      urgent: item?.urgent === true,
    },
  };
}

export function answerNote(item) {
  return {
    story: item?.story,
    kind: 'answer',
    data: { id: item?.id, title: text(item?.title), option: item?.answer?.option ?? null, note: text(item?.answer?.note) },
  };
}

export function readPosted(dir, id) {
  try {
    const v = JSON.parse(readFileSync(postedFile(dir, id), 'utf8'));
    if (!isPlain(v)) return { keys: [], design: null };
    return { keys: list(v.keys), design: isPlain(v.design) ? v.design : null };
  } catch {
    return { keys: [], design: null };
  }
}

export function writePosted(dir, id, { keys = [], design = null } = {}) {
  writeAtomic(postedFile(dir, id), `${JSON.stringify({ keys: keys.slice(-KEEP_KEYS), design })}\n`);
}

// Whether the note is the one already posted: a design is the same as the last design posted
// (a design that went back to an earlier one is a change); any other kind by its key.
export function alreadyPosted(posted, kind, data) {
  if (kind === 'design') return posted.design !== null && noteKey('design', posted.design) === noteKey('design', data);
  return posted.keys.includes(noteKey(kind, data));
}

const names = (dir) => {
  try {
    return readdirSync(pendingDir(dir)).filter((f) => /^\d{15}-[0-9a-f]{8}\.json$/.test(f)).sort();
  } catch {
    return [];
  }
};

export function queueStoryNote(dir, { story, kind, data, at = new Date(), slot = null } = {}) {
  try {
    if (typeof story !== 'string' || story === '' || typeof kind !== 'string' || !isPlain(data)) return null;
    if (alreadyPosted(readPosted(dir, story), kind, data)) return null;
    const when = at instanceof Date ? at : new Date(at);
    const last = Number(names(dir).at(-1)?.split('-')[0] ?? 0);
    const name = `${String(Math.max(+when || Date.now(), last + 1)).padStart(15, '0')}-${randomBytes(4).toString('hex')}.json`;
    const entry = { story, kind, data, at: (Number.isNaN(+when) ? new Date() : when).toISOString(), slot: slot || null };
    writeAtomic(join(pendingDir(dir), name), `${JSON.stringify(entry)}\n`);
    return name;
  } catch {
    return null;
  }
}

export function hasPendingNotes(dir) {
  return names(dir).length > 0;
}

export function pendingNotes(dir) {
  const out = [];
  for (const name of names(dir)) {
    const file = join(pendingDir(dir), name);
    try {
      const entry = JSON.parse(readFileSync(file, 'utf8'));
      if (!isPlain(entry) || typeof entry.story !== 'string' || typeof entry.kind !== 'string' || !isPlain(entry.data)) throw new Error('not a note');
      out.push({ file, entry });
    } catch {
      // A torn file can never be posted.
      rmSync(file, { force: true });
    }
  }
  return out;
}

export function lockNotes(dir) {
  const lockFile = join(notesDir(dir), '.lock');
  try {
    mkdirSync(notesDir(dir), { recursive: true });
  } catch {
    return null;
  }
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
