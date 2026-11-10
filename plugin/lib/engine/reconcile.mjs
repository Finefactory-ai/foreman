// What the supervisor does first after the whole run died (Mac slept, VS Code closed), before
// it picks any new story. Spec §9.4. This file only decides; supervisor.mjs gathers the
// facts (ship lock, claims, merged pull requests, the vault) and carries out the actions.
//
// Order: finish a release cut off after the hosted database changed but before main did;
// close stories whose pull request merged but are not done; let go of a parked story's stale
// claim (its release finishes later); resume stories that a dead slot was building; last, clear
// the stale locks. A story appears in one action at most.
//
// A resume is not pinned to a slot: `slot` is null and `from` is the slot the dead run had it in
// (or null). The resumes come in the order of the `priority` input, the story ids in priority
// order (pick.mjs byPriority); an id not in it keeps its found order, after the ones in it.
//
// No CLI: supervisor.mjs imports reconcile() and recoverySteps().

// The ship lock carries the name of the ship step that is running (ship.mjs), or `waiting`.
// A release cut off at one of these stages is finished, not redone: past them the live
// database or main may already have changed. The caller passes the names of its ship steps
// that are a point of no return; the default also covers `hosted-db`, the name an older
// release script gave that stage, so a lock it left still carries over.
export const DEFAULT_MUST_FINISH = ['hosted-db', 'merge', 'migrate-supabase'];

// shipLock: null | { story, slot, stage, stale }
// claims: [{ id, slot, by, stale }]
// mergedNotDone: [story ids whose story/* PR merged but vault status != done]
// inProgress: [{ id, branch: boolean }]   (vault status in-progress)
// mustFinish: ship-lock stages after which a cut-off release is finished
// readyToPromote: [story ids whose status is ready-to-promote (a parked release)]
export function reconcile({ shipLock, claims = [], mergedNotDone = [], inProgress = [], mustFinish = DEFAULT_MUST_FINISH, readyToPromote = [], priority = [] }) {
  const actions = [];
  const resumes = [];
  const seen = new Set();
  const add = (action) => {
    if (seen.has(action.id)) return;
    seen.add(action.id);
    (action.type === 'resume' ? resumes : actions).push(action);
  };

  if (shipLock?.stale && shipLock.story && mustFinish.includes(shipLock.stage)) {
    add({ type: 'finish-release', id: shipLock.story, slot: shipLock.slot ?? null });
  }
  for (const id of mergedNotDone) add({ type: 'close', id, slot: null });

  const liveClaim = new Set(claims.filter((c) => !c.stale).map((c) => c.id));
  const parked = new Set(readyToPromote);
  for (const c of claims) {
    if (!c.stale || c.by !== 'factory') continue;
    add(parked.has(c.id) ? { type: 'release-claim', id: c.id, slot: c.slot ?? null } : { type: 'resume', id: c.id, slot: null, from: c.slot ?? null });
  }
  for (const s of inProgress) {
    if (s.branch && !liveClaim.has(s.id)) add({ type: 'resume', id: s.id, slot: null, from: null });
  }

  const rank = (a) => {
    const i = priority.indexOf(a.id);
    return i === -1 ? priority.length : i;
  };
  // Array.prototype.sort is stable, so ids outside the list keep their found order.
  actions.push(...resumes.sort((a, b) => rank(a) - rank(b)), { type: 'clear-stale' });
  return actions;
}

// The words the start-up event and the dry run use for each action that becomes work.
export const recoveryWords = { 'finish-release': 'finishing the release of', close: 'closing', resume: 'resuming' };

// What the supervisor does with a plan: one list of effects, in plan order, which the
// supervisor runs in that order. A parked story's claim is broken just before its start-up
// event; work is queued just before its event; the stale ship lock is broken last. A resume is
// queued with no slot, `from` (the slot the dead run had it in) and `ranked: true`, so it yields to
// a higher-priority pick; its event names `from`.
export function recoverySteps(plan) {
  const effects = [];
  for (const a of plan) {
    const slot = a.slot ?? null;
    if (a.type === 'clear-stale') {
      effects.push({ do: 'break-ship' });
    } else if (a.type === 'release-claim') {
      effects.push({ do: 'break-claim', id: a.id, slot });
      effects.push({ do: 'event', text: `Start-up: letting go of ${a.id}; its release is parked and finishes later.`, kind: 'info', slot });
    } else if (a.type === 'resume') {
      effects.push({ do: 'queue', slot: null, id: a.id, mode: '', from: a.from ?? null, ranked: true });
      effects.push({ do: 'event', text: `Start-up: ${recoveryWords[a.type]} ${a.id}.`, kind: 'info', slot: a.from ?? a.slot ?? null });
    } else {
      effects.push({ do: 'queue', slot, id: a.id, mode: '' });
      effects.push({ do: 'event', text: `Start-up: ${recoveryWords[a.type]} ${a.id}.`, kind: 'info', slot });
    }
  }
  return effects;
}
