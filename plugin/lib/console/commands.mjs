// The owner's commands, checked and applied in one place for every console that takes them:
// `foreman pause` and friends, and the dashboard's POST /api/control. Each goes through
// control.mjs, the one writer of control.json (stop touches the STOP file).
//
//   { action: 'pause' | 'resume' | 'stop' | 'fixed' }
//   { action: 'workers', n }                 1 to config.slots
//   { action: 'slot', slot, slotAction }     slot w1 to w<config.slots>; slotAction one of ACTIONS
//   { action: 'handback', id }               a story id
//   { action: 'next', id }                   a story id
//   { action: 'retry-answer', id }           a decision id (control.ANSWER_ID): try its failed
//                                            answer again at the next check
//
// ownerCommand answers the line to show the owner, or throws with the reason the input is wrong.
// Its `by` is who sent the command (console/stopper.mjs stopperOf), recorded by stop only.

import * as control from './control.mjs';
import { ACTIONS } from '../engine/scheduler.mjs';

// A story id is plain: letters, digits, dots, dashes and underscores, at most 40.
export const STORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

export const OWNER_ACTIONS = ['pause', 'resume', 'stop', 'fixed', 'workers', 'slot', 'handback', 'next', 'retry-answer'];

export function validSlot(value, slots) {
  const m = /^w([1-9]\d*)$/.exec(value ?? '');
  return Boolean(m) && Number(m[1]) <= slots;
}

const storyId = (id) => {
  if (id === undefined || id === null || id === '') throw new Error('Which story? This needs a story id.');
  if (typeof id !== 'string' || !STORY_ID.test(id)) throw new Error(`${id} is not a story id.`);
  return id;
};

export function ownerCommand(dir, config, request, now = new Date(), by) {
  const { action } = request ?? {};
  switch (action) {
    case 'pause':
      control.pause(dir, now);
      return 'Paused: no new stories start until `foreman resume`; stories in progress carry on.';
    case 'resume':
      control.resume(dir, now);
      return 'Resumed.';
    case 'stop':
      control.stop(dir, now, by);
      return 'Stop requested: the run finishes the stories in progress, then stops.';
    case 'fixed':
      control.fixed(dir, now);
      return 'Marked fixed: the run checks and clears the halt.';
    case 'workers': {
      const raw = typeof request.n === 'number' || typeof request.n === 'string' ? String(request.n) : '';
      const n = Number(raw);
      if (!/^\d+$/.test(raw) || n < 1 || n > config.slots) throw new Error(`The worker count must be 1 to ${config.slots}, not ${raw || 'nothing'}.`);
      control.setWorkers(dir, n, now);
      return `Workers set to ${n}; the run applies it at the next pick.`;
    }
    case 'slot': {
      const { slot, slotAction } = request;
      if (typeof slot !== 'string' || !validSlot(slot, config.slots)) throw new Error(`There is no slot ${slot}; slots are w1 to w${config.slots}.`);
      if (typeof slotAction !== 'string' || !ACTIONS.has(slotAction)) throw new Error(`Unknown slot action ${slotAction}; one of ${[...ACTIONS].join(', ')}.`);
      control.slotAction(dir, slot, slotAction, now);
      return `Slot ${slot}: ${slotAction} requested.`;
    }
    case 'handback': {
      const id = storyId(request.id);
      control.handBack(dir, id, now);
      return `${id} handed back to the factory.`;
    }
    case 'next': {
      const id = storyId(request.id);
      control.nextStory(dir, id, now);
      return `${id} asked for next; the run starts it if it can be built now.`;
    }
    case 'retry-answer': {
      const id = request.id;
      if (typeof id !== 'string' || !control.ANSWER_ID.test(id)) throw new Error(`${id ?? 'nothing'} is not an answer id.`);
      control.retryAnswer(dir, id, now);
      return 'Retrying that answer at the next check.';
    }
    default:
      throw new Error(`Unknown action; one of ${OWNER_ACTIONS.join(', ')}.`);
  }
}
