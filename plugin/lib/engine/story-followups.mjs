// What an ending leaves on the story and on Waiting on you: the summary of a finished group, the
// notes written on the story itself and posted each tick, and the questions asked about a story
// that failed or that shipped. A part of the supervisor (supervisor.mjs is the entry point and
// lists the parts); it depends on run-context.mjs only, and session-lifecycle.mjs calls it. The
// paragraphs below were part of supervisor.mjs's header.
//
// Every failed ending whose story will not be picked again by itself (blocked for a reason in
// words, or unreadable) raises '<ID> could not be released' on Waiting on you unless an item about
// the story is already open (engine/failed-ask.mjs). A shipped ending closes any open one, and also
// the story's halt task ("<ID> stopped the release line"). Clearing a halt closes the unanswered
// halt tasks raised by then. Once no halt stands, a story that is done by any other path (Mark done,
// `foreman story done`, a park release, an undo, a move by hand) has its halt task closed within a
// minute.
//
// Story notes (engine/story-notes.mjs, features.jiraComments, or salesforceComments for Cases): the
// supervisor writes on the story itself how a session that ended with no result stopped (the watchdog, a crash, a sign-in, a
// credit or rate limit, an outage) and what is kept for the resume; each tick posts the notes other
// processes queued (the dashboard's answers, a command's, a hook's); an answer found while applying
// the owner's answers is queued too. All through the cache-only source, so a Jira note only joins the
// outbox, and none of it can stop the loop: a failure is a warn event.

import { existsSync } from 'node:fs';
import { openConsole } from './console.mjs';
import { failedAsk, haltTasksFor, releaseAsksFor, resumesByItself } from './failed-ask.mjs';
import { flushStoryNotes, noteOnStory } from './story-notes.mjs';
import { groupSummaryWork } from './slot-work.mjs';
import { CONFIG, DIR, event, guarded, HALT, inHandSessions, LIVE, now, ROOT, state, stories, work } from './run-context.mjs';

// After a story shipped: queue the summary of its group when that was the group's last story.
export function queueGroupSummary(slot, id) {
  try {
    const source = stories();
    const all = source.list();
    const group = all.find((s) => s.id === id)?.group;
    if (!group) return;
    const groupOf = (x) => all.find((s) => s.id === x)?.group;
    const w = groupSummaryWork({ source, group, slot, id, queue: work, running: inHandSessions(), groupOf });
    if (w) work.push(w);
  } catch (err) {
    event(`Could not check the group summary after ${id} (${err.message}).`, 'warn', slot);
  }
}

// The story's own record of what happened to it (engine/story-notes.mjs): through the cache-only
// story source, so a Jira note only joins the outbox the refresher sends and the loop never waits.
// A failure is an event, never the end of the handler that asked.
export const tellStory = guarded('a story note', (slot, id, kind, data) => {
  noteOnStory({ root: ROOT, config: LIVE, env: process.env, now, source: stories(), slot }, id, kind, data);
});

// Posts the notes other processes queued (the dashboard's answers, a command's, a hook's), each tick.
export const flushNotes = guarded('the story notes', () => {
  flushStoryNotes({ dir: DIR, config: LIVE, root: ROOT, now, cacheOnly: true });
});

// A story ended failed: raise "<ID> could not be released" on Waiting on you unless an item about
// the story is already open (the session's own "could not pass review", a "Decide for <ID>"), or
// the story goes back in line by itself (to do, in progress, done, or waiting on another story),
// where the decision would outlive it. Not awaited: a throw is one warn event, never the end of
// the loop.
export function askAboutFailed(slot, id, done, cause) {
  (async () => {
    let story = null;
    let idPattern;
    try {
      const source = stories();
      story = source.list().find((x) => x.id === id) ?? null;
      idPattern = source.idPattern;
    } catch {
      // unreadable: still ask
    }
    if (resumesByItself(story, { idPattern })) {
      event(`${id} failed; its story is ${story.status}, so nothing was asked on Waiting on you.`, 'info', slot);
      return;
    }
    const con = openConsole({ config: CONFIG, ctx: { stateDir: DIR, now } });
    const pending = await con.decisions.pending();
    const earlierFailures = (state().recent ?? []).filter((r) => r.id === id && r.result === 'failed' && r.endedAt !== done?.endedAt).length;
    const mine = done?.id === id;
    const item = failedAsk({ id, title: done?.title ?? '', reason: mine ? done.note : '', pr: mine ? done.pr : '', cause, pending, earlierFailures });
    if (!item) return;
    await con.decisions.add(item);
    event(`${id} failed; asked you what to do with it on Waiting on you.`, 'info', slot);
  })().catch((err) => {
    try {
      event(`Could not ask you about ${id}: ${String(err?.message ?? err).slice(0, 200)}`, 'warn', slot);
    } catch {
      // nothing more to do
    }
  });
}

// A story shipped: close the "<ID> could not be released" items and the urgent halt task still
// open for it. The halt task is closed answered or not: once the story shipped a "Retry the story"
// answer would rebuild a shipped story, and "Close the task" is what closing does, so no answer is
// lost. A stale Retry or Drop never runs against a shipped story, and nothing left on Waiting on you
// says its release line is stopped. Callers do not await it, like the above; it never rejects.
export function closeShippedAsks(slot, id) {
  return (async () => {
    const con = openConsole({ config: CONFIG, ctx: { stateDir: DIR, now } });
    const pending = await con.decisions.pending();
    const items = [...releaseAsksFor(pending, id), ...haltTasksFor(pending, { story: id })];
    for (const item of items) await con.decisions.applied(item.id);
    for (const title of new Set(items.map((item) => item.title))) event(`${id} shipped; closed "${title}" on Waiting on you.`, 'info', slot);
  })().catch((err) => {
    try {
      event(`Could not close the open items of ${id} on Waiting on you: ${String(err?.message ?? err).slice(0, 200)}`, 'warn', slot);
    } catch {
      // nothing more to do
    }
  });
}

// A halt was cleared (`foreman fixed`, once the health check passed): close the halt's urgent tasks
// the owner has not answered, so none says the release line is stopped after it was cleared. Only
// those created by then, so a halt raised after the clear keeps its task. An answered one is left:
// its note is applied by the answers path and a shipped ending closes it. Callers do not await it;
// it never rejects.
export function closeHaltTasks(clearedAt) {
  return (async () => {
    const con = openConsole({ config: CONFIG, ctx: { stateDir: DIR, now } });
    const items = haltTasksFor(await con.decisions.pending(), { before: clearedAt.getTime(), unanswered: true });
    for (const item of items) {
      await con.decisions.applied(item.id);
      event(`Closed "${item.title}" on Waiting on you: the halt is cleared.`, 'info');
    }
  })().catch((err) => {
    try {
      event(`Could not close the halt's task on Waiting on you: ${String(err?.message ?? err).slice(0, 200)}`, 'warn');
    } catch {
      // nothing more to do
    }
  });
}

// Each tick: a story that is done, whatever path made it so (Mark done, `foreman story done`, a park
// release, an undo, a move on the tracker by hand), must not leave its halt task open. It works by
// status, so every path is covered at once. Nothing while the line is still halted (the task is
// still true), and nothing for a story a session or queued work holds (its own ending closes the
// task). At most one sweep a minute. The tick does not await it; it never rejects.
const DONE_SWEEP_MS = 60_000;
let doneSweep = { running: false, nextAt: 0 };

export function closeDoneHaltTasks(at = Date.now()) {
  if (doneSweep.running || at < doneSweep.nextAt) return Promise.resolve();
  doneSweep = { running: true, nextAt: at + DONE_SWEEP_MS };
  return (async () => {
    try {
      if (existsSync(HALT)) return;
      const con = openConsole({ config: CONFIG, ctx: { stateDir: DIR, now } });
      const pending = await con.decisions.pending();
      const done = new Set(stories().list().filter((s) => s.status === 'done').map((s) => s.id));
      const inHand = new Set([...inHandSessions().map((s) => s.id), ...work.map((w) => w.id)]);
      for (const item of haltTasksFor(pending)) {
        if (!done.has(item.story) || inHand.has(item.story)) continue;
        await con.decisions.applied(item.id);
        event(`${item.story} is done; closed "${item.title}" on Waiting on you.`, 'info');
      }
    } finally {
      doneSweep.running = false;
    }
  })().catch((err) => {
    try {
      event(`Could not close the halt tasks of done stories on Waiting on you: ${String(err?.message ?? err).slice(0, 200)}`, 'warn');
    } catch {
      // nothing more to do
    }
  });
}
