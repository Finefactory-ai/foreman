// The owner's "build next" request as plain data (no files): when one is open, how a story that
// cannot start yet is counted, and the sentences shown for it. state.mjs keeps the request and
// its wait in files; the supervisor decides when a try failed.
//
// A request is open from control.json's nextStory and requestedAt until the story has started in
// a slot (or the picker says it cannot be built). A try that fails (the claim is held, the fetch
// or checkout fails, the schema token is held, or the story waits on files or resources another
// running story holds) leaves it open, so the next pick tries it first. A request whose story
// already runs in a slot of this factory is settled as started (runningSlot), and only a story that
// is not running and cannot start is refused.
// After NEXT_TRIES failed tries in a row it is logged once and shown on Waiting on you.

export const NEXT_TRIES = 3;

// A story id is plain: letters, digits, dots, dashes and underscores. The picker checks the rest.
export const isStoryId = (id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(id);

export const briefNote = (id) => `Starting ${id} next: fetching its brief from Jira`;

// The open request, { id, at }, or null: no story, no time, or one already handled.
export function openRequest(control, handledNextAt) {
  const id = typeof control?.nextStory === 'string' ? control.nextStory.trim() : '';
  const at = control?.requestedAt;
  if (!id || !at || at === handledNextAt) return null;
  return { id, at };
}

// One more failed try of `req`. `track` is what the last call returned ({ at, tries, since,
// logged }), or null. `log` is the warn line, only the first time the limit is reached; `wait` is
// what the owner is shown from the limit on.
export function failedTry(track, req, reason, now = new Date(), limit = NEXT_TRIES) {
  const base = track && track.at === req.at ? track : { at: req.at, tries: 0, since: now.toISOString(), logged: false };
  const tries = base.tries + 1;
  const reached = tries >= limit;
  const log = reached && !base.logged ? `You asked for ${req.id} next, but it could not start after ${tries} tries (${reason}); it stays first in line.` : null;
  return {
    track: { at: req.at, tries, since: base.since, logged: base.logged || reached },
    log,
    wait: reached ? { id: req.id, at: req.at, since: base.since, tries, reason } : null,
  };
}

// The slot where story `id` runs in this factory, or null. `sessions` is [{ slot, id }]: the
// sessions in hand (adopted and closing ones too). A claim counts when the factory holds it live
// (not an owner claim, not stale, a pid of this factory, a slot this config has).
export function runningSlot({ id, sessions = [], claims = [], ours = () => false, slots = [] }) {
  const session = sessions.find((s) => s.id === id);
  if (session) return session.slot;
  const claim = claims.find((c) => c.id === id && c.by === 'factory' && !c.stale && ours(c.pid) && slots.includes(c.slot));
  return claim ? claim.slot : null;
}

// What the picker does with an open request: 'running' (its story already runs in the slot
// `running`: settled as started, whatever else holds), 'refuse' (no such story to build, it is
// claimed, or it needs the schema token and the token is not free), 'wait' (only a wait on files or
// resources stops it: a failed try with `reason`, the request stays open) or 'take'.
export function requestVerdict({ story, taken, exclusiveBlocked, wait, running = null }) {
  if (running) return { verdict: 'running', slot: running };
  if (!story || taken || exclusiveBlocked) return { verdict: 'refuse' };
  if (wait) return { verdict: 'wait', reason: wait.text };
  return { verdict: 'take' };
}

export const nextWaitWhy = (wait) =>
  `It could not start after ${wait.tries} tries: ${wait.reason}. Foreman keeps trying it first, and no other story starts before it. Ask for another story next to replace the request.`.slice(0, 300);
