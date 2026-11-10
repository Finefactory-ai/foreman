// The --dry-run report: what each slot would start now, from start-up recovery and the picking rules. It prints only.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { claims } from './locks.mjs';
import { needsExclusive, nextStory } from './pick.mjs';
import { recoveryWords } from './reconcile.mjs';
import { peekWork, pickFirst, rehome, slotNumber, takeWork } from './slot-work.mjs';
import { readSlot } from './state.mjs';
import { worktreeDirty, worktreeOf } from './worktree.mjs';

// What each slot would start now: start-up recovery first, then the picking rules. Prints
// only; no claim, token, slot or event is written.
export function dryRun({ loaded, START, workers, MAX, SLOT_IDS, DIR, CONFIG, slotIndex, stories, pickStory, recoveryPlan, endedFolderStory, schemaExtra, schemaFree, keptOut, fileWaiters }) {
  // Whether the story the picker would start ranks above the resume (a start-up resume is ranked).
  const dryYields = (a, skip, extra, tokenFree) => {
    const source = stories();
    const list = source.list();
    const rival = nextStory(list, { idPattern: source.idPattern, skip, exclude: keptOut({ extra, free: tokenFree, waiters: fileWaiters() }) });
    return pickFirst({ ...a, ranked: true }, rival, list);
  };
  for (const w of loaded.localWarnings) console.log(`warning: ${w}`);
  for (const e of START.events) console.log(e.kind === 'warn' ? `warning: ${e.text}` : e.text);
  console.log(`${workers} ${workers === 1 ? 'worker' : 'workers'} (${START.from === 'flag' ? '--workers' : 'the workers setting'})`);
  const queue = recoveryPlan().filter((a) => a.type !== 'clear-stale');
  rehome(queue, workers);
  const taken = new Set(claims(DIR).map((c) => c.id));
  const extra = schemaExtra();
  let tokenFree = schemaFree();
  let picked = 0;
  for (const slot of SLOT_IDS.slice(0, workers)) {
    // A real start sets building and waiting slots of a dead run back to idle.
    const st = readSlot(DIR, slot);
    if (!['idle', 'building', 'waiting'].includes(st.state)) {
      console.log(`${slot} is ${st.state}${st.reason ? ` (${st.reason})` : ''}; nothing starts there`);
      continue;
    }
    const a = peekWork(queue, slot);
    if (a && !(a.type === 'resume' && (MAX === 0 || picked < MAX) && dryYields(a, [...taken, ...queue.map((x) => x.id)], extra, tokenFree))) {
      takeWork(queue, slot);
      taken.add(a.id);
      const over = (slotNumber(a.from) ?? Infinity) > workers;
      console.log(`would start ${recoveryWords[a.type]} ${a.id} in ${slot}${a.from && a.from !== slot ? ` (moved from ${a.from}${over ? ', over the worker count' : ''})` : ''}`);
      continue;
    }
    const path = worktreeOf(DIR, slotIndex(slot) + 1);
    if (existsSync(join(path, '.git')) && worktreeDirty(path, { generated: CONFIG.generated })) {
      const ended = endedFolderStory(path);
      if (!ended) {
        console.log(`would park ${slot}: its folder has changes that do not belong to a story`);
        continue;
      }
      console.log(`would save ${slot}'s leftover changes from ${ended} on a leftover branch and clean its folder`);
    }
    if (MAX > 0 && picked >= MAX) {
      console.log(`nothing to start in ${slot} (${MAX === 1 ? 'the 1 story' : `the ${MAX} stories`} asked for ${MAX === 1 ? 'is' : 'are'} started)`);
      continue;
    }
    const story = pickStory({ skip: [...taken, ...queue.map((x) => x.id)], exclude: keptOut({ extra, free: tokenFree, waiters: fileWaiters() }) });
    if (!story) {
      console.log(`nothing to start in ${slot}`);
      continue;
    }
    picked++;
    taken.add(story.id);
    const exclusive = needsExclusive(story, extra);
    if (exclusive) tokenFree = false;
    console.log(`would start ${story.id} (${story.title}) in ${slot}${exclusive ? ', holding the schema token' : ''}`);
  }
}
