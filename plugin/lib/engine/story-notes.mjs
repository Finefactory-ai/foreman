// Writes the notes Foreman keeps on a story itself (FM-333): every decision it asks of the owner
// and the answer, the architect's design (and a revised one), each round's verdict, how a
// session ended, a release that stopped, and the follow-ups made from the story. With the
// story source's comment switch on (storyCommentsOn in story-source.mjs: features.jiraComments,
// or features.salesforceComments when the stories are Salesforce Cases), each goes to the source's
// note() as words for a person (story-note-text.mjs): a Jira comment, a private Case comment,
// one progress line for the markdown source.
//
// A note is queued first (story-notes-queue.mjs) and posted by whoever flushes next, under a
// lock, oldest first, so nobody waits and every note is posted once: the ledger beside the
// queue remembers what each story already has. A story source that cannot take the note now
// (Jira down) queues the write in its own outbox, so a note is never lost to a failed call.
//
//   flushStoryNotes({ dir, config, root, env, now, source, cacheOnly })
//       { [file]: 'posted'|'revised'|'repeat'|'off'|'unknown'|'failed' }, never throws. Takes the
//       lock (another process holds it: {}, and the entries stay for it or the next flush); with
//       nothing queued it returns {} before the lock, so no folder is made. With
//       the comment switch off every entry is dropped ('off') and the ledger is left alone. A source
//       that throws keeps the entry and ends the flush, so the order holds
//   noteOnStory({ root, config, env, now, source, slot, cacheOnly }, id, kind, data)
//       queues one note and flushes; the status of that note: the flush's, 'off' (nothing is
//       queued), 'repeat' (already posted), 'queued' (another process is flushing) or 'failed'
//   roundsOf(entries, reviewers)   the pipeline rounds in a session's agent answers (pure): one key
//       per round, from its number and its tester entry, so a reviewer arriving later never
//       posts the round again; `waiting` lists the engine reviewers still to answer an approved round
//   noteSessionProgress({ root, config, env, slot })
//       what a running session has finished, from its agents' transcripts: the design, and each
//       round that is complete. Only queued and sent to the source's own outbox (cacheOnly), so
//       the hook that calls it never waits on a service. Never throws
//
// The supervisor never waits either: it passes its cache-only source, so a Jira note only joins
// the outbox that the refresher sends.

import { createHash } from 'node:crypto';
import { realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import { entryKey, stageOutputs } from './checkpoint.mjs';
import { stateDir as stateDirOf } from './paths.mjs';
import { markedSession, readMark, readSubagents } from './session-files.mjs';
import { jiraEvent } from '../jira/outbox.mjs';
import { envSecrets, fileSecrets } from '../setup/project.mjs';
import { openStorySource, storyCommentsOn } from './story-source.mjs';
import { clean, footer, renderNote } from './story-note-text.mjs';
import { alreadyPosted, designData, hasPendingNotes, lockNotes, noteKey, pendingNotes, queueStoryNote, readPosted, writePosted } from './story-notes-queue.mjs';

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

// The places whose prefix never goes into a comment: the project, its state folder, the slot's
// worktree around the process, and each by its real path.
function rootsOf({ root, dir, env }) {
  const all = [root, env?.FOREMAN_PROJECT_DIR, dir, process.cwd()].filter((p) => typeof p === 'string' && p !== '');
  return [...new Set([...all, ...all.map(real)])];
}

// Every known secret value, for clean(): the env's and the key files'.
function secretsOf({ root, config, env }) {
  const values = [];
  try {
    values.push(...envSecrets(env));
  } catch {
    // the looks-secret patterns still apply
  }
  try {
    if (root) values.push(...fileSecrets({ root, config }));
  } catch {
    // an unreadable key file is not a reason to skip the note
  }
  return values;
}

export function flushStoryNotes({ dir, config, root, env = process.env, now = () => new Date(), source, cacheOnly = false } = {}) {
  const result = {};
  let release = null;
  try {
    if (!hasPendingNotes(dir)) return result;
    release = lockNotes(dir);
    if (!release) return result;
    const pending = pendingNotes(dir);
    if (!pending.length) return result;
    if (!storyCommentsOn(config)) {
      for (const { file } of pending) {
        rmSync(file, { force: true });
        result[file] = 'off';
      }
      return result;
    }
    const event = (text, kind = 'info', slot = null) => jiraEvent(dir, text, kind, { now, slot });
    const opts = { roots: rootsOf({ root, dir, env }), home: env?.HOME || os.homedir(), env, values: secretsOf({ root, config, env }) };
    let src = source;
    try {
      src ??= openStorySource({ root, config, now, env, cacheOnly });
    } catch (err) {
      event(`Story notes: could not open the story source (${clean(String(err?.message ?? err), opts).slice(0, 200)}); the notes stay queued.`, 'warn');
      return result;
    }
    const detail = config.features.jiraCommentDetail === 'full' ? 'full' : 'summary';
    for (const { file, entry } of pending) {
      const posted = readPosted(dir, entry.story);
      const drop = (status) => {
        rmSync(file, { force: true });
        result[file] = status;
      };
      if (alreadyPosted(posted, entry.kind, entry.data)) {
        drop('repeat');
        continue;
      }
      const rendered = renderNote(entry, { config, previousDesign: entry.kind === 'design' ? posted.design : null, detail });
      if (!rendered) {
        drop('repeat');
        continue;
      }
      if (typeof src.note !== 'function') {
        drop('unknown');
        continue;
      }
      const say = (s) => clean(s, opts);
      let ok;
      try {
        ok = src.note(entry.story, {
          kind: entry.kind,
          title: say(rendered.title),
          summary: say(rendered.summary),
          text: [say(rendered.body), say(footer(entry.at, entry.slot))].filter(Boolean).join('\n\n'),
        });
      } catch (err) {
        event(`Story notes: could not post a note on ${entry.story} (${say(String(err?.message ?? err)).slice(0, 200)}); it stays queued.`, 'warn', entry.slot);
        result[file] = 'failed';
        return result;
      }
      if (ok !== true) {
        event(`Story notes: dropped a note for ${entry.story}: the story source does not know it.`, 'info', entry.slot);
        drop('unknown');
        continue;
      }
      const revised = entry.kind === 'design' && posted.design !== null;
      writePosted(dir, entry.story, {
        keys: [...posted.keys, noteKey(entry.kind, entry.data)],
        design: entry.kind === 'design' ? designData(entry.data) : posted.design,
      });
      drop(revised ? 'revised' : 'posted');
    }
  } catch {
    // a note is never worth failing a command, a hook or a step
  } finally {
    release?.();
  }
  return result;
}

export function noteOnStory({ root, config, env = process.env, now = () => new Date(), source, slot = env?.FOREMAN_SLOT || null, cacheOnly = false } = {}, id, kind, data) {
  try {
    if (!storyCommentsOn(config)) return 'off';
    const dir = stateDirOf(root, config, env);
    if (alreadyPosted(readPosted(dir, id), kind, data)) return 'repeat';
    const file = queueStoryNote(dir, { story: id, kind, data, at: now(), slot });
    if (!file) return 'failed';
    const result = flushStoryNotes({ dir, config, root, env, now, source, cacheOnly });
    const own = Object.entries(result).find(([f]) => f.endsWith(`/${file}`) || f === file)?.[1];
    if (own) return own;
    return Object.keys(result).length === 0 ? 'queued' : 'failed';
  } catch {
    return 'failed';
  }
}

// ---- the pipeline's rounds, from a session's agent answers ----

const time = (iso) => Date.parse(iso) || 0;
const plainVerdict = (e) => isPlain(e?.output) && Array.isArray(e.output.findings);
const findingsOf = (e) => e.output.findings.filter(isPlain).map((f) => ({ ...f, stage: e.name }));

export function roundsOf(entries, reviewers = []) {
  // A reviewer with an engine runs outside the session (the relay), so it is not waited for: its
  // transcript is left out, except for the fallback agent that runs when the engine is unavailable.
  const named = (Array.isArray(reviewers) ? reviewers : []).filter((r) => typeof r?.name === 'string');
  const waited = named.filter((r) => !r.engine).map((r) => r.name);
  const relayed = named.filter((r) => r.engine).map((r) => r.name);
  const open = [];
  for (const e of [...(Array.isArray(entries) ? entries : [])].sort((a, b) => time(a.at) - time(b.at))) {
    if (e.role === 'tester') open.push({ round: e.round, tester: e, reviewers: {} });
    else if (e.role === 'reviewer') {
      const round = open.findLast((r) => r.round === e.round);
      if (round && plainVerdict(e)) round.reviewers[e.name] = e;
    }
  }
  return open.map((r) => {
    const used = [r.tester, ...Object.values(r.reviewers)];
    const findings = plainVerdict(r.tester) ? used.flatMap((e) => (plainVerdict(e) ? findingsOf(e) : [])) : [];
    const rejected = plainVerdict(r.tester) && findingsOf(r.tester).some((f) => f.severity !== 'minor');
    const complete = plainVerdict(r.tester) && (rejected || waited.every((name) => Object.hasOwn(r.reviewers, name)));
    const approved = complete && findings.every((f) => f.severity === 'minor');
    return {
      round: r.round,
      tester: r.tester,
      reviewers: r.reviewers,
      complete,
      approved,
      findings,
      stages: used.map((e) => e.name),
      waiting: approved ? relayed.filter((name) => !Object.hasOwn(r.reviewers, name)) : [],
      key: createHash('sha256').update(JSON.stringify([r.round, entryKey(r.tester)])).digest('hex').slice(0, 16),
    };
  });
}

export function noteSessionProgress({ root, config, env = process.env, slot } = {}) {
  try {
    if (!storyCommentsOn(config)) return;
    const dir = stateDirOf(root, config, env);
    const mark = readMark(dir, slot);
    if (!mark || typeof mark.story !== 'string') return;
    const session = markedSession(dir, slot);
    if (!session) return;
    const entries = stageOutputs(readSubagents(session.paths), mark.story, config.roles);
    const now = () => new Date();
    const queue = (kind, data, at) => queueStoryNote(dir, { story: mark.story, kind, data, at: at ? new Date(at) : now(), slot });
    const plan = entries.findLast((e) => e.role === 'architect' && isPlain(e.output) && typeof e.output.design === 'string');
    if (plan) queue('design', designData(plan.output), plan.endAt);
    for (const r of roundsOf(entries, config.roles?.reviewers)) {
      if (!r.complete) continue;
      const last = [r.tester, ...Object.values(r.reviewers)].map((e) => e.endAt).filter(Boolean).sort().at(-1);
      queue('round', { round: r.round, approved: r.approved, findings: r.findings, stages: r.stages, key: r.key, waiting: r.waiting }, last);
    }
    flushStoryNotes({ dir, config, root, env, now, cacheOnly: true });
  } catch {
    // a note is never worth failing a hook
  }
}
