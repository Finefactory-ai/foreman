// The picking rules: which story the factory builds next. Pure functions over a list of
// stories (the shape every story source returns), so they work the same for any source.
//
// Order: a story left in progress first (a run that died), then by priority: the story's `order`
// (its source's position: the earliest group, for Jira priority then rank), then the lowest number
// at the end of the id, then the id. byPriority is that second part alone, with status ignored; the
// supervisor ranks the stories a dead run left by it. A story is taken only when every story in
// its `dependsOn` is done, whatever group it is in. Owner tasks are never picked. A blocked
// story is picked again only when its `blockedBy` starts with story ids and every one of them
// is done. blockedNow is that same rule as a question about one story: is it blocked, and would
// the picker leave it alone?
//
// `exclude` is a test that drops stories from the automatic pick (the parallel factory keeps
// a second story that needs an exclusive resource out while one is in flight). It never stops
// an explicit id. `idPattern` is the source's id pattern as a RegExp source string; it is how
// ids are recognised inside `blockedBy` text.

// The id pattern comes from the story source; there is no default here, so a caller cannot
// quietly pick with the wrong one.
const need = (idPattern) => {
  if (typeof idPattern !== 'string' || idPattern === '') throw new Error('idPattern is required');
  return idPattern;
};

const isOpen = (s) => ['todo', 'in-progress', 'blocked'].includes(s.status);
const number = (id) => Number(id.split('-').pop()) || 0;
// Priority, then rank: the story's order, then the number at the end of the id, then the id.
export const byPriority = (a, b) => a.order - b.order || number(a.id) - number(b.id) || a.id.localeCompare(b.id);
const doneIds = (stories) => new Set(stories.filter((s) => s.status === 'done').map((s) => s.id));

// "P4-01, P4-03 must land first" -> ['P4-01', 'P4-03']; a reason in words -> [].
function blockingStories(blockedBy, idPattern) {
  const lead = String(blockedBy ?? '').match(new RegExp(`^(?:(?:${idPattern})[,\\s]*(?:and\\s+)?)+`))?.[0] ?? '';
  return lead.match(new RegExp(idPattern, 'g')) ?? [];
}

// A story blocked only because other stories must land first ("P6-05 must land first. ...").
// The picker takes it again once they are done; nothing is wanted from the owner.
export const waitsOnStories = (blockedBy, { idPattern } = {}) => blockingStories(blockedBy, need(idPattern)).length > 0;

// True for a story that needs a resource only one slot may hold at a time. Today every resource
// maps to the single exclusive lock; story 8 generalises it to one lock per resource.
export const needsExclusive = (story, extraIds = []) => (story.resources ?? []).length > 0 || extraIds.includes(story.id);

// A blocked story the picker takes again: its `blockedBy` starts with story ids and every one is done.
const unblocked = (story, done, idPattern) => {
  const ids = blockingStories(story.blockedBy, idPattern);
  return ids.length > 0 && ids.every((b) => done.has(b));
};

// True when the story's status is blocked and the picker would not take it again.
export function blockedNow(story, stories, { idPattern } = {}) {
  need(idPattern);
  return story.status === 'blocked' && !unblocked(story, doneIds(stories), idPattern);
}

// The stories an agent could start now, best first.
export function eligible(stories, { skip = [], exclude = () => false, idPattern } = {}) {
  need(idPattern);
  return eligibleGiven(stories, doneIds(stories), { skip, exclude, idPattern });
}

function eligibleGiven(stories, done, { skip = [], exclude = () => false, idPattern } = {}) {
  return stories
    .filter((s) => !done.has(s.id) && !skip.includes(s.id) && !s.ownerTask)
    .filter((s) => !exclude(s))
    .filter((s) => s.status === 'todo' || s.status === 'in-progress' || (s.status === 'blocked' && unblocked(s, done, idPattern)))
    .filter((s) => s.dependsOn.every((d) => done.has(d)))
    .sort((a, b) => Number(b.status === 'in-progress') - Number(a.status === 'in-progress') || byPriority(a, b));
}

// With `strict`, an explicit id is returned only if the factory could build it right now (the
// command centre's "build this next" goes through this). `exclude` never applies to an explicit id.
export function nextStory(stories, { id, strict = false, skip = [], exclude = () => false, idPattern } = {}) {
  need(idPattern);
  if (id) {
    return (strict ? eligible(stories, { idPattern }) : stories).find((s) => s.id === id) ?? null;
  }
  return eligible(stories, { skip, exclude, idPattern })[0] ?? null;
}

// Plays the whole run forward as if every story shipped: `order` is what the factory would
// build, in order; `waiting` is every open story it could never reach, with what each is
// waiting on (an owner task, a decision, a story that is itself waiting, a missing id).
export function buildOrder(stories, { idPattern } = {}) {
  need(idPattern);
  const byId = new Map(stories.map((s) => [s.id, s]));
  const done = doneIds(stories);
  const opts = { idPattern };
  const buildableNow = eligibleGiven(stories, done, opts).map((s) => ({ id: s.id, title: s.title, group: s.group }));
  const order = [];
  for (let next = eligibleGiven(stories, done, opts)[0]; next; next = eligibleGiven(stories, done, opts)[0]) {
    order.push(next.id);
    done.add(next.id);
  }

  // A dependency the source knows of but does not list (a Jira issue outside the filter)
  // carries its state in the waiting story's externalDeps.
  const label = (id, waiter) => {
    const s = byId.get(id);
    if (!s) {
      const outside = waiter.externalDeps?.[id];
      return outside ? `${id} (outside the filter, ${outside})` : `${id} (no such story)`;
    }
    return s.ownerTask ? `${id} (owner task)` : id;
  };
  const waiting = stories
    .filter((s) => isOpen(s) && !done.has(s.id) && !s.ownerTask)
    .map((s) => {
      const blockers = s.status === 'blocked' ? blockingStories(s.blockedBy, idPattern) : [];
      const unmet = [...new Set([...blockers, ...s.dependsOn])].filter((d) => !done.has(d));
      const inWords = s.status === 'blocked' && blockers.length === 0 ? [s.blockedBy || 'blocked, no reason given'] : [];
      return { id: s.id, title: s.title, on: [...inWords, ...unmet.map((d) => label(d, s))] };
    })
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

  const ownerTasks = stories.filter((s) => s.ownerTask && isOpen(s)).map((s) => ({ id: s.id, title: s.title }));
  return { order, buildableNow, waiting, ownerTasks };
}

// For each given id, the open stories that cannot be built while it is not done, directly or
// through other stories, sorted. Owner tasks and done stories are never listed, nor the id
// itself; a cycle ends because each story is visited once.
export function dependentsOf(stories, ids, { idPattern } = {}) {
  need(idPattern);
  const done = doneIds(stories);
  const waitedOnBy = new Map();
  for (const s of stories.filter((x) => isOpen(x) && !done.has(x.id) && !x.ownerTask)) {
    const blockers = s.status === 'blocked' ? blockingStories(s.blockedBy, idPattern) : [];
    for (const d of new Set([...s.dependsOn, ...blockers])) {
      if (done.has(d)) continue;
      if (!waitedOnBy.has(d)) waitedOnBy.set(d, []);
      waitedOnBy.get(d).push(s.id);
    }
  }
  const answer = new Map();
  for (const id of ids) {
    const seen = new Set([id]);
    const queue = [id];
    while (queue.length) {
      for (const next of waitedOnBy.get(queue.shift()) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    seen.delete(id);
    answer.set(id, [...seen].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
  }
  return answer;
}

// For each given id, the open stories that wait on it directly (in dependsOn, or among the ids
// a blocked story's blockedBy starts with), sorted: { id, on, inWords }. `on` is the story's
// other unmet blockers, dependsOn order first; `inWords` is true for a story blocked for a
// reason in words. A blocker is met when it is a done story in the list, or an id the list does
// not have and the story's externalDeps does not name (the Jira source drops a done blocker
// outside the filter and names an open one there). Owner tasks and done stories are never
// listed, nor the id itself; every id gets a list, empty when nothing waits on it.
export function waitersOf(stories, ids, { idPattern } = {}) {
  need(idPattern);
  const done = doneIds(stories);
  const known = new Set(stories.map((s) => s.id));
  const waiters = stories
    .filter((s) => isOpen(s) && !done.has(s.id) && !s.ownerTask)
    .map((s) => {
      const blockers = s.status === 'blocked' ? blockingStories(s.blockedBy, idPattern) : [];
      const met = (d) => done.has(d) || (!known.has(d) && !Object.hasOwn(s.externalDeps ?? {}, d));
      return { id: s.id, all: [...new Set([...s.dependsOn, ...blockers])], met, inWords: s.status === 'blocked' && blockers.length === 0 };
    });
  const answer = new Map();
  for (const id of ids) {
    const list = waiters
      .filter((w) => w.id !== id && w.all.includes(id))
      .map((w) => ({ id: w.id, on: w.all.filter((d) => d !== id && !w.met(d)), inWords: w.inWords }))
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    answer.set(id, list);
  }
  return answer;
}

// For each given id, the open stories that become buildable as soon as it is done: those that
// wait on it directly, have no other unmet blocker, and are not blocked for a reason in words.
// Owner tasks are never listed; every id gets a list, empty when nothing is freed.
export function freedBy(stories, ids, { idPattern } = {}) {
  const answer = new Map();
  for (const [id, list] of waitersOf(stories, ids, { idPattern })) {
    answer.set(id, list.filter((w) => w.on.length === 0 && !w.inWords).map((w) => w.id));
  }
  return answer;
}

// Story counts overall and per group, in group order. Retired stories are left out.
export function progress(stories) {
  const live = stories.filter((s) => s.status !== 'retired');
  const count = (list, status) => list.filter((s) => s.status === status).length;
  // A group sorts by its earliest order.
  const groups = new Map();
  for (const s of live) {
    if (!groups.has(s.group)) groups.set(s.group, { group: s.group, name: s.groupName, order: s.order, list: [] });
    const g = groups.get(s.group);
    g.order = Math.min(g.order, s.order);
    g.list.push(s);
  }
  return {
    done: count(live, 'done'),
    todo: count(live, 'todo') + count(live, 'in-progress'),
    blocked: count(live, 'blocked'),
    total: live.length,
    byGroup: [...groups.values()]
      .sort((a, b) => a.order - b.order)
      .map(({ group, name, list }) => ({ group, name, done: count(list, 'done'), total: list.length })),
  };
}
