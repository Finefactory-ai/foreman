// The owner's answers the supervisor applies itself: some when no session is running, the
// ones that need no story context on every tick. Without this, a run whose every story is
// blocked or failed stops with "Nothing left to build" and the answers wait for a session that
// never comes.
//
//   review      "<ID> could not pass review": Retry with a note to the architect | I'll take it | Drop
//   depends     "Add depends_on: <ids> to <ID>?": Apply | Ignore
//   waits       "<ID> now waits for <ids>": Undo | Keep (a dependency Foreman added itself,
//               `foreman story depend`; Undo takes the ids off the story's depends_on again)
//   learned     "Foreman learned <L-n> for <roles>" or "Foreman changed <L-n> for <roles>"
//               (one role, or several joined by ", "): Undo the change | Keep the change
//               (a trait or skill Foreman wrote itself, `foreman learning tick`; they run
//               `foreman learning undo|keep <L-n> --told-at <the note's createdAt>`, which the
//               CLI refuses unless the note is about a change Foreman made to <L-n>, so a
//               note with that title added any other way is never applied; a note whose version
//               Foreman replaced since is applied without acting (an Undo on it raises a
//               "did not undo" note), and so is one replaced and then removed)
//   rolledBack  "Foreman rolled back <L-n> for <roles>", "Foreman retired <L-n> for <roles>" or
//               "Foreman did not undo <L-n> for <roles>": Got it (a change Foreman took out itself
//               after evaluating it, `foreman learning tick`, or an Undo that undid nothing because
//               the version was replaced; Got it only marks the note applied)
//   created     "Foreman created <n> follow-up story" or "... stories": Undo and close them | Keep
//               them (follow-up stories `foreman learn` created itself, features.autoCreateFollowUps;
//               Undo runs `foreman learn undo <item id>`, which closes them and marks the note
//               applied itself; Keep only marks it applied)
//   trait       "Add a trait for <builder>: <rule>?": Add as a trait | Ignore
//   follow-up   "Follow up on <ID>: <n> minor finding(s)?": Create a follow-up story | Ignore
//   deletes     "Allow deletes for <ID>?": Allow the deletes | Keep them out (the Salesforce
//               pack's `foreman sf deletes`, then the story back to todo with a note)
//   close       "Close <ID>: nothing to build?": Close it as Done | Build it anyway (the story
//               skill's blocked.md; the story done with the item's body as the evidence, or back
//               to todo with a note for the architect)
//   answer      any other task or decision about a story, by none of the titles above: a
//               "Decide for <ID>: ..." question answered with one of its options, or a task
//               answered in words (requeueKind). The story goes back to todo with the answer in
//               a note for the architect, so the next pick takes it
//
// The titles and the commands are the story skill's ("The owner's answers") and `foreman
// learn`'s. Anything else is left for the sessions: unanswered items, the items requeueKind
// gives null, and close and answer items whose story waitsForAnswer refuses (one blocked on
// other stories, which the picker takes when they land, or one a claim, a session, queued work
// or a slot's story, held story or parked story holds; the caller's canRequeue says which).
// Review, trait, follow-up and deletes answers are applied only when nothing runs
// (mayApplyAnswers). The EVERY_TICK kinds (STORYLESS, close and answer) are applied on every
// tick, even while sessions run. Nothing is applied twice, because:
//   - sessions cannot run `foreman learning keep|undo` (run-guard GUARDED.learning), and a
//     learned answer passes the note's createdAt: the tick gives its note the time of the ledger
//     line, so a note a session added (`foreman decide add`) is refused and stays pending;
//   - rolledBack only marks the note applied;
//   - a created Undo closes only stories still todo that no live claim holds, so it never closes
//     a story a session builds, and the tick applies answers before it picks, so a story it
//     closes is not picked on that tick; sessions cannot run `foreman learn undo` (run-guard
//     GUARDED.learn), and learn refuses an id whose ledger detail is not one it created;
//   - a depends or waits apply is the same union or difference of the same ids, so a session
//     racing the supervisor cannot change a story twice;
//   - close and answer touch only a story that no live claim, session, queued work, or slot's
//     story, held story or parked story holds, so no session of that story is running; the only racer is a session for another story
//     applying the same answer from answers.md, which re-reads `decide pending` right before;
//   - every apply ends by marking the item applied, and an applied item never comes back from
//     pending().
//
// Pure apart from the runners passed in: foreman(args), gh(args) and git(args), each giving
// { status, stdout }, at once or as a promise.

import { waitsOnStories } from './pick.mjs';

const RETRY = 'Retry with a note to the architect';
const TAKE = "I'll take it";
const DROP = 'Drop';
const DEPENDS = /^Add depends_on: (.+) to (\S+)\?$/;
const WAITS = /^(\S+) now waits for (.+)$/;
const FOLLOW_UP = /^Follow up on \S+: \d+ minor finding\(s\)\?$/;
const LEARNED = /^Foreman (learned|changed) (L-\d+) for ([a-z][a-z0-9-]*(?:, [a-z][a-z0-9-]*)*)$/;
const ROLLED_BACK = /^Foreman (rolled back|retired|did not undo) (L-\d+) for ([a-z][a-z0-9-]*(?:, [a-z][a-z0-9-]*)*)$/;
const CREATED = /^Foreman created \d+ follow-up stor(?:y|ies)$/;
const UNDO_CREATED = 'Undo and close them';
const CHANGES = { learned: 'add', changed: 'update', 'rolled back': 'rollback', retired: 'retire', 'did not undo': 'notUndone' };
const UNDO_CHANGE = 'Undo the change';
const KEEP_CHANGE = 'Keep the change';
const ALLOW_DELETES = 'Allow the deletes';
const KEEP_OUT = 'Keep them out';
const CLOSE_DONE = 'Close it as Done';
const BUILD_ANYWAY = 'Build it anyway';

export const OPTIONS = {
  review: [RETRY, TAKE, DROP],
  depends: ['Apply', 'Ignore'],
  waits: ['Undo', 'Keep'],
  trait: ['Add as a trait', 'Ignore'],
  followUp: ['Create a follow-up story', 'Ignore'],
  deletes: [ALLOW_DELETES, KEEP_OUT],
  learned: [UNDO_CHANGE, KEEP_CHANGE],
  rolledBack: ['Got it'],
  created: [UNDO_CREATED, 'Keep them'],
};

// Which kind of question the item is, by its title, or null. The Waiting on you list bundles
// the trait and follow-up proposals by it (lib/console/waiting.mjs bundleOf).
export function kindOf(item) {
  const title = String(item.title ?? '');
  if (title === `${item.story} could not pass review`) return 'review';
  if (DEPENDS.test(title)) return 'depends';
  if (title.startsWith('Add a trait for ') && title.endsWith('?')) return 'trait';
  if (FOLLOW_UP.test(title)) return 'followUp';
  if (title === `Allow deletes for ${item.story}?`) return 'deletes';
  if (WAITS.exec(title)?.[1] === item.story) return 'waits';
  if (LEARNED.test(title)) return 'learned';
  if (ROLLED_BACK.test(title)) return 'rolledBack';
  if (CREATED.test(title)) return 'created';
  return null;
}

// What a learned or rolled-back note is about, by its title: { id: 'L-n', change, roles }, change
// being add (learned), update (changed), rollback (rolled back), retire (retired) or notUndone (did
// not undo); else null.
// The one place that reads these titles apart (the dashboard's Undo, lib/console/learned.mjs).
export function learnedNote(item) {
  const m = LEARNED.exec(String(item?.title ?? '')) ?? ROLLED_BACK.exec(String(item?.title ?? ''));
  return m ? { id: m[2], change: CHANGES[m[1]], roles: m[3].split(', ') } : null;
}

// The kinds that need no story context, which the supervisor applies even while sessions run.
export const STORYLESS = ['learned', 'rolledBack', 'waits', 'depends', 'created'];

export function supervisorApplies(item) {
  if (!item?.answer || item.appliedAt || item.kind !== 'decision' || !item.options?.length) return false;
  const kind = kindOf(item);
  return Boolean(kind) && OPTIONS[kind].includes(item.answer.option);
}

// The kinds about one story, which the supervisor applies only to a story waitsForAnswer allows.
export const STORY_KINDS = ['close', 'answer'];
// The kinds the supervisor applies on every tick, even while sessions run.
export const EVERY_TICK = [...STORYLESS, ...STORY_KINDS];

const isText = (v) => typeof v === 'string' && v.trim() !== '';
const oneLine = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

// Which story answer the item is ('close' or 'answer'), or null: an answered, unapplied task or
// decision about a story, by none of kindOf's titles. A "Close <ID>: nothing to build?" item
// counts only with one of its two options; an item with options only with one of them; an item
// without only with a note in words.
export function requeueKind(item) {
  if (!item?.answer || item.appliedAt) return null;
  if (item.kind !== 'task' && item.kind !== 'decision') return null;
  if (!isText(item.story) || kindOf(item) !== null) return null;
  const { option } = item.answer;
  const options = Array.isArray(item.options) ? item.options : [];
  if (item.title === `Close ${item.story}: nothing to build?`) {
    return (option === CLOSE_DONE || option === BUILD_ANYWAY) && options.includes(option) ? 'close' : null;
  }
  if (options.length) return options.includes(option) ? 'answer' : null;
  return isText(item.answer.note) ? 'answer' : null;
}

// Whether a story answer may put this story back in line now: an open story, not an owner task,
// that nothing in `held` (claims, sessions, queued work, slots) has, and that is in progress or blocked
// for a reason in words. A story blocked on other stories stays blocked: the picker takes it when
// they land, and its session applies the answer.
export function waitsForAnswer(story, { held = new Set(), idPattern } = {}) {
  if (!story || story.ownerTask || held.has(story.id)) return false;
  if (story.status === 'in-progress') return true;
  return story.status === 'blocked' && !waitsOnStories(story.blockedBy, { idPattern });
}

// The story ids a slot holds. A held or parked slot keeps its story after a supervisor restart
// even when its claim reads stale.
export function slotHolds(slot) {
  return [slot?.story?.id, slot?.heldStory, slot?.parkedStory].filter(isText);
}

// The ids of the stories something holds, for waitsForAnswer's `held`: claims that are not stale
// (an owner claim never goes stale), sessions, queued work, and each slot's story, held story and
// parked story. The one definition the supervisor's canRequeue uses.
export function heldForAnswer({ claims = [], sessions = [], work = [], slots = [] } = {}) {
  const list = (v) => (Array.isArray(v) ? v : []);
  const held = new Set();
  for (const c of list(claims)) if (!c?.stale && isText(c?.id)) held.add(c.id);
  for (const x of [...list(sessions), ...list(work)]) if (isText(x?.id)) held.add(x.id);
  for (const slot of list(slots)) for (const id of slotHolds(slot)) held.add(id);
  return held;
}

// Whether the supervisor may apply answers now: no session running or preparing, no work
// queued, and the run neither halted, held (paused or waiting on Jira) nor stopping.
export function mayApplyAnswers({ running, preparing, queued, halted, held, stopping }) {
  return !running && !preparing && !queued && !halted && !held && !stopping;
}

// The steps for one answer, each { what, run(): result → true when it worked }.
function steps(item, kind, { foreman, gh, git, branchPrefix, remote, today }) {
  const { id, story } = item;
  const option = item.answer.option;
  const ok = (r) => r.status === 0;
  const markApplied = { what: 'marking it applied', run: async () => ok(await foreman(['decide', 'applied', id])) };
  // The step that reads a story's depends_on (from `foreman story next --id`) and hands it to keep.
  const readDependsOn = (target, keep) => ({
    what: `reading the depends_on of ${target}`,
    run: async () => {
      const r = await foreman(['story', 'next', '--id', target]);
      if (!ok(r)) return false;
      try {
        const found = JSON.parse(r.stdout);
        if (found.none || !found.id) return false;
        keep(Array.isArray(found.dependsOn) ? found.dependsOn : []);
        return true;
      } catch {
        return false;
      }
    },
  });

  if (kind === 'review' && option === RETRY) {
    const note = String(item.answer.note ?? '').trim();
    return [
      { what: `putting ${story} back to todo`, run: async () => ok(await foreman(['story', 'todo', story, '--note', note ? `Note for the architect: ${note}` : 'Retried by the owner.'])) },
      markApplied,
    ];
  }
  if (kind === 'review' && option === TAKE) {
    return [
      { what: `claiming ${story} for you`, run: async () => ok(await foreman(['lock', 'owner-claim', story])) },
      { what: `blocking ${story}`, run: async () => ok(await foreman(['story', 'block', story, '--reason', 'Taken by the owner'])) },
      markApplied,
    ];
  }
  if (kind === 'review') {
    const branch = `${branchPrefix}${story.toLowerCase()}`;
    let numbers = [];
    return [
      {
        what: `listing the open pull requests of ${branch}`,
        run: async () => {
          const r = await gh(['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number']);
          if (!ok(r)) return false;
          try {
            numbers = JSON.parse(r.stdout).map((p) => p.number);
            return true;
          } catch {
            return false;
          }
        },
      },
      {
        what: `closing the pull requests of ${branch}`,
        run: async () => {
          for (const n of numbers) if (!ok(await gh(['pr', 'close', String(n)]))) return false;
          return true;
        },
      },
      // The branch may not be there; that is fine.
      { what: `deleting ${branch}`, run: async () => (await git(['push', remote, '--delete', branch]), true) },
      { what: `blocking ${story}`, run: async () => ok(await foreman(['story', 'block', story, '--reason', `Dropped by the owner on ${today}`])) },
      markApplied,
    ];
  }
  if (kind === 'depends' && option === 'Apply') {
    const [, ids, target] = item.title.match(DEPENDS);
    const added = ids.split(/[\s,]+/).filter(Boolean);
    let current = [];
    return [
      readDependsOn(target, (list) => { current = list; }),
      { what: `setting the depends_on of ${target}`, run: async () => ok(await foreman(['story', 'set', target, '--depends-on', [...new Set([...current, ...added])].join(',')])) },
      markApplied,
    ];
  }
  if (kind === 'depends') return [markApplied];
  if (kind === 'waits' && option === 'Undo') {
    const named = item.title.match(WAITS)[2].split(/[\s,]+/).filter(Boolean);
    let current = [];
    return [
      readDependsOn(story, (list) => { current = list; }),
      { what: `setting the depends_on of ${story}`, run: async () => ok(await foreman(['story', 'set', story, '--depends-on', current.filter((d) => !named.includes(d)).join(',')])) },
      markApplied,
    ];
  }
  if (kind === 'waits') return [markApplied];
  if (kind === 'deletes') {
    const note = String(item.answer.note ?? '').trim();
    const allow = option === ALLOW_DELETES;
    const said = allow ? 'The owner allowed the deletes.' : 'Note for the architect: the owner wants nothing deleted in this story; keep every delete out.';
    return [
      { what: `recording your answer on the deletes of ${story}`, run: async () => ok(await foreman(['sf', 'deletes', allow ? 'allow' : 'keep-out', story])) },
      { what: `putting ${story} back to todo`, run: async () => ok(await foreman(['story', 'todo', story, '--note', note ? `${said} ${note}` : said])) },
      markApplied,
    ];
  }
  if (kind === 'answer') {
    const note = oneLine(item.answer.note);
    const text = isText(option)
      ? `Note for the architect: the owner answered "${item.title}" with "${option}".${note ? ` ${note}` : ''}`
      : `Note for the architect: the owner answered "${item.title}": ${note}`;
    return [{ what: `putting ${story} back to todo`, run: async () => ok(await foreman(['story', 'todo', story, '--note', text])) }, markApplied];
  }
  if (kind === 'close' && option === CLOSE_DONE) {
    const note = oneLine(item.answer.note);
    const body = oneLine(item.body);
    const text = `Closed by the owner: nothing to build. ${note ? `${body.replace(/\.$/, '')}. ${note}` : body}`;
    return [{ what: `closing ${story} as done`, run: async () => ok(await foreman(['story', 'done', story, '--note', text])) }, markApplied];
  }
  if (kind === 'close') {
    const note = oneLine(item.answer.note);
    const text = `Note for the architect: the owner wants it built anyway.${note ? ` ${note}` : ''}`;
    return [{ what: `putting ${story} back to todo`, run: async () => ok(await foreman(['story', 'todo', story, '--note', text])) }, markApplied];
  }
  if (kind === 'rolledBack') return [markApplied];
  // `foreman learn undo` marks the item applied itself.
  if (kind === 'created' && option === UNDO_CREATED) return [{ what: 'running foreman learn undo', run: async () => ok(await foreman(['learn', 'undo', id])) }];
  if (kind === 'created') return [markApplied];
  if (kind === 'learned') {
    const learnedId = item.title.match(LEARNED)[2];
    const sub = option === UNDO_CHANGE ? 'undo' : 'keep';
    const toldAt = item.createdAt;
    const run = async () => typeof toldAt === 'string' && toldAt !== '' && ok(await foreman(['learning', sub, learnedId, '--told-at', toldAt]));
    return [{ what: `running foreman learning ${sub} ${learnedId}`, run }, markApplied];
  }
  // trait or follow-up: `foreman learn` marks the item applied itself.
  const sub = option === 'Ignore' ? 'ignore' : 'apply';
  return [{ what: `running foreman learn ${sub}`, run: async () => ok(await foreman(['learn', sub, id])) }];
}

// The answers applyAnswers would apply, as [{ item, kind }] in the order given: those not in
// `skip`, of a kind the supervisor applies (`kinds`, an array, narrows it; null: every kind),
// and, for a close or answer item, whose story canRequeue(story) says may be put back. The
// supervisor asks first, so it starts an apply (and says so) only when there is one.
export function answersToApply(items, { skip = new Set(), kinds = null, canRequeue = () => false } = {}) {
  const todo = [];
  for (const item of items) {
    if (skip.has(item?.id)) continue;
    const kind = supervisorApplies(item) ? kindOf(item) : requeueKind(item);
    if (!kind) continue;
    if (Array.isArray(kinds) && !kinds.includes(kind)) continue;
    if (STORY_KINDS.includes(kind) && !canRequeue(item.story)) continue;
    todo.push({ item, kind });
  }
  return todo;
}

// A failed answer is tried again by the supervisor after a growing wait (ANSWER_RETRY_MS by
// the number of tries, the last wait from the fifth on), and the owner can ask for it at once
// (the Retry button; control.json answerRetry):
//   answerRetryMs(tries)                the wait after the n-th failed try
//   failedAnswer(prev, result, nowMs)   the failure to keep for an applyAnswers result that is not
//                                       ok: { id, story, title, step, tries, at, retryAt }; `at` is
//                                       the first failure's time, `prev` the failure kept before
//   answerSkips(failures, nowMs)        the ids in a Map of failures whose retryAt is still ahead:
//                                       what answersToApply and applyAnswers skip
export const ANSWER_RETRY_MS = [60_000, 120_000, 300_000, 900_000, 1_800_000];

export const answerRetryMs = (tries) => ANSWER_RETRY_MS[Math.min(Math.max(tries, 1), ANSWER_RETRY_MS.length) - 1];

export function failedAnswer(prev, result, nowMs) {
  const tries = (prev?.tries ?? 0) + 1;
  return {
    id: result.id,
    story: result.story,
    title: result.title,
    step: result.step,
    tries,
    at: prev?.at ?? new Date(nowMs).toISOString(),
    retryAt: new Date(nowMs + answerRetryMs(tries)).toISOString(),
  };
}

export function answerSkips(failures, nowMs) {
  const skip = new Set();
  for (const [id, f] of failures) if (Date.parse(f?.retryAt) > nowMs) skip.add(id);
  return skip;
}

// Applies each answer the supervisor applies, oldest first as given (answersToApply says which),
// reading canRequeue just before each close or answer item, not once up front: an earlier item's
// apply may have changed what holds the story. `onItem(item)` is called just before an applied item's first step (a throw is
// ignored). A failed step stops that item, which stays pending. Returns [{ id, story, title,
// ok, text }], a failed one with `step`, the step's words ("putting ACME-1 back to todo").
export async function applyAnswers(items, { foreman, gh, git, branchPrefix, remote, today, skip = new Set(), kinds = null, canRequeue = () => false, onItem }) {
  const results = [];
  for (const { item, kind } of answersToApply(items, { skip, kinds, canRequeue: () => true })) {
    if (STORY_KINDS.includes(kind) && !canRequeue(item.story)) continue;
    try {
      onItem?.(item);
    } catch {
      // a note about the apply is not worth stopping it
    }
    let failed = null;
    for (const step of steps(item, kind, { foreman, gh, git, branchPrefix, remote, today })) {
      let worked;
      try {
        worked = await step.run();
      } catch {
        worked = false;
      }
      if (!worked) {
        failed = step.what;
        break;
      }
    }
    const base = { id: item.id, story: item.story, title: item.title };
    results.push(
      failed
        ? { ...base, ok: false, step: failed, text: `Could not apply your answer to "${item.title}": ${failed} failed.` }
        : kind === 'answer'
          ? { ...base, ok: true, text: `Applied your answer to "${item.title}": ${item.story} is back to todo with your answer.` }
          : { ...base, ok: true, text: `Applied your answer to "${item.title}": ${item.answer.option}.` },
    );
  }
  return results;
}
