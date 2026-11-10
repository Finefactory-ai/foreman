// What every action on the dashboard does, in plain words: the one place for the help texts,
// served as GET /api/help. Each entry is { hint, more }:
//
//   hint   one sentence, at most 100 characters, shown under the action
//   more   the fuller text, shown on hover and focus: what happens next
//
// Groups, each keyed as the page looks them up:
//
//   decision   by the exact option label (the story skill's review, nothing-to-build and
//              deletes questions, answers.mjs OPTIONS, `foreman learn`'s TRAIT_OPTIONS and
//              FOLLOW_UP_OPTIONS)
//   waiting    by the Waiting on you action id (lib/console/waiting.mjs), and the Quick
//              decisions bundle action ids (lib/console/bundles.mjs BUNDLE_ACTIONS)
//   learned    by the action id of a learned FYI on Waiting on you (undo, keep, ok;
//              lib/console/waiting.mjs) and the Learned list's Undo
//   control    by OWNER_ACTIONS (lib/console/commands.mjs), slot actions aside
//   slot       by scheduler ACTIONS, plus park-after (Park on a building slot)
//   form       the save buttons of the decision cards and the settings rows
//   settings   by setting name, from the registry's descriptions (settingHelp)
//
// A decision option with no entry here shows the option's own hint (`decide add --hint`), else no hint.

import { REGISTRY } from '../settings/registry.mjs';

const h = (hint, more) => ({ hint, more });

const FIXED = h(
  'Checks the problem is gone, then lets held stories ship.',
  'Runs `foreman health`. Only if its checks pass does the halt clear and the held stories ship, oldest first. Otherwise the run stays halted and shows what still fails.',
);

const ACTIONS = {
  decision: {
    'Retry with a note to the architect': h(
      'Sends the story back to be designed and built again, with your note.',
      'The story goes back to todo with "Note for the architect: <your note>". The architect designs it again, then it is built and reviewed again.',
    ),
    "I'll take it": h(
      'You take the story over; the run leaves it alone until you hand it back.',
      'Foreman claims the story for you (`foreman lock owner-claim`) and blocks it with "Taken by the owner". Its branch and draft pull request stay. Hand it back under Taken by you when the run should carry on.',
    ),
    Drop: h(
      'Closes the story\'s pull requests, deletes its branch and blocks it.',
      'Closes the open pull requests of the story branch, deletes the remote branch, and blocks the story with "Dropped by the owner". Nothing is built for it again unless you unblock it.',
    ),
    Apply: h(
      'Adds the listed stories to this story\'s depends_on.',
      'The listed ids join the story\'s depends_on, keeping the ones it already has. The story is not picked until they are done.',
    ),
    Undo: h(
      'Takes the dependency off again; the story no longer waits for it.',
      'The stories Foreman added come off this story\'s depends_on (for Jira, the "is blocked by" links are removed). Anything it waited on before stays. The story can then be picked without them.',
    ),
    Keep: h(
      'Keeps the dependency and clears this note.',
      'Nothing changes: the story still waits for those stories and starts by itself once they are done. The note leaves the list.',
    ),
    'Undo the change': h(
      "Takes Foreman's learned rule out again; later stories go without it.",
      'Runs `foreman learning undo <id>`: the rule goes back one version, or is removed when it was new. Stories that start after that follow the rule as it is then.',
    ),
    'Keep the change': h(
      'Keeps the learned rule and clears this note.',
      'Runs `foreman learning keep <id>`: the rule stays as it is and is no longer on trial. The note leaves the list. `foreman learning undo <id>` still takes it out later.',
    ),
    'Got it': h(
      'Clears this note; Foreman already took the change out.',
      'Changes nothing: Foreman already rolled the learned change back or retired it after watching the stories that used it. The note leaves the list. `foreman learning show <id>` has its history and the numbers.',
    ),
    Ignore: h(
      'Changes nothing; the proposal is closed.',
      'Nothing changes. An ignored trait or follow-up is not proposed again unless you run `foreman learn reopen <id>`.',
    ),
    'Add as a trait': h(
      'Adds the rule to that builder\'s traits, so later stories follow it.',
      'The rule is written into that builder\'s traits, or into all.md when the builder is no longer in the config. Every later story that builder works on follows it.',
    ),
    'Close it as Done': h(
      "Marks the story done without building it; the architect's evidence is the note.",
      'Runs `foreman story done <ID>` with your note and the architect\'s evidence. Nothing is built and no pull request is opened.',
    ),
    'Build it anyway': h(
      'Sends the story back to be designed and built, with your note.',
      'The story goes back to todo with "Note for the architect: the owner wants it built anyway" and your note. The architect designs it again, then it is built and reviewed.',
    ),
    'Allow the deletes': h(
      'Lets the story delete the listed Salesforce components, then ships it again.',
      'Runs `foreman sf deletes allow <ID>` and puts the story back to todo. On its next release the deletes go ahead only if the change still deletes exactly the same components; if they differ, you are asked again.',
    ),
    'Keep them out': h(
      'Sends the story back to be built without deleting anything.',
      'Runs `foreman sf deletes keep-out <ID>` and puts the story back to todo with "Note for the architect: the owner wants nothing deleted in this story". It is built again to keep those components.',
    ),
    'Create a follow-up story': h(
      'Creates a story to fix the minor findings this story shipped with.',
      'The story source gets a new story, "Follow-ups from <ID>", listing the minor findings. The run picks it up like any other story.',
    ),
    'Undo and close them': h(
      'Closes the follow-up stories Foreman created that have not started.',
      'Runs `foreman learn undo <id>`: each story still waiting to be built is closed as Done with a note, a story already started is left as it is, and the findings are not proposed again.',
    ),
    'Keep them': h(
      'Keeps the new stories and clears this note.',
      'Nothing changes: the run builds them like any other story. The note leaves the list.',
    ),
  },
  waiting: {
    answer: h(
      'Saves your words as the answer.',
      'The run picks your answer up at its next step. Until then you can change it under Answered.',
    ),
    fixed: FIXED,
    done: h(
      'Marks the owner task done in the story source.',
      'The task is marked done, so the stories waiting on it can be built.',
    ),
    retry: h(
      'Tries applying your answer again now.',
      'Foreman already tries a failed answer again by itself, after a wait that grows. This asks it to try at its next check instead.',
    ),
    check: h(
      'Checks the release now instead of waiting for the next check.',
      'Runs `foreman release watch` now. The page shows the result shortly; the story moves to Done when its release finishes.',
    ),
    'create-all': h(
      'Creates one follow-up story per shipped story listed, or adds each listed trait.',
      'Answers Create a follow-up story (or Add as a trait) on every item listed. The run applies the answers at its next check. Any that could not be saved stay listed.',
    ),
    'ignore-all': h(
      'Closes every proposal listed without changing anything.',
      'Answers Ignore on every item listed, and the run closes them at its next check. An ignored trait or follow-up is not proposed again unless you run `foreman learn reopen <id>`.',
    ),
  },
  learned: {
    undo: h(
      "Takes Foreman's learned rule out again, now; later stories go without it.",
      'Acts at once: the rule goes back one version, or is removed when it was new, and its notes leave the list. It applies from the next story a slot starts; a story already running keeps the rule it started with. `foreman learning show <id>` has its history.',
    ),
    keep: h(
      'Keeps the learned rule and clears this note.',
      'Acts at once: the rule stays as it is and is no longer on trial, so Foreman stops watching it. The note leaves the list. Undo in the Learned list still takes it out later.',
    ),
    ok: h(
      'Clears this note; Foreman already took the change out.',
      'Changes nothing: Foreman already rolled the learned change back or retired it after watching the stories that used it. The note leaves the list. `foreman learning show <id>` has its history and the numbers.',
    ),
  },
  control: {
    pause: h(
      'Starts no new stories; stories in progress carry on.',
      'Paused: no new stories start until you resume. Each slot finishes the story it has, then waits.',
    ),
    resume: h(
      'Lets the run start new stories again.',
      'The run picks the next story at its next check, for every free slot.',
    ),
    stop: h(
      'Stops the run once the stories in progress finish.',
      'It asks you to confirm first. The run finishes the stories in progress, then stops. Start it again with `foreman run`.',
    ),
    fixed: FIXED,
    workers: h(
      'Sets how many slots build at once.',
      'Saved for this computer as the workers setting and applied at the next pick. A slot above the new count finishes its story first.',
    ),
    next: h(
      'Asks the run to build this story next.',
      'It goes to the next free slot. Only stories that can be built now are listed.',
    ),
    handback: h(
      'Gives the story back to the run.',
      'Your claim is removed and the story goes back to todo, so the run can pick it again.',
    ),
    'retry-answer': h(
      'Tries applying a failed answer again now.',
      'Asks the run to apply the answer again at its next check, instead of waiting out the pause it keeps between tries.',
    ),
  },
  slot: {
    skip: h(
      'Stops this story and leaves it out for the rest of this run.',
      'The session stops and the branch is kept. The story is not picked again while this run lasts, standby included, unless you ask for it with Build next; the slot moves on. foreman status lists the skipped stories.',
    ),
    takeover: h(
      'Saves the work so far and hands the story to you.',
      'Any work in progress is committed and pushed to the story branch. The story is claimed for you and blocked, and the slot moves on to another story.',
    ),
    park: h(
      'Parks the slot now; it picks up no stories.',
      'An idle or down slot parks at once and picks up nothing until you unpark it.',
    ),
    'park-after': h(
      'Parks the slot once its current story is done.',
      'The story in progress carries on to the end. Then the slot parks and picks up nothing until you unpark it.',
    ),
    unpark: h(
      'Lets the slot pick up stories again.',
      'The slot goes back to idle and takes the next story that can be built.',
    ),
    resume: h(
      'Carries on the story from where it stopped.',
      'The slot goes back to work on the same story, keeping what was done so far.',
    ),
    restart: h(
      'Throws the story\'s work away and builds it again from main.',
      'The folder is reset, the local branch deleted, and the story built again from the start.',
    ),
    'resume-as-is': h(
      'Keeps the changes in the folder and carries on.',
      'With a story, the changes are that story\'s work and it carries on. With none, they are put aside in a git stash and the slot takes a new story.',
    ),
    discard: h(
      'Throws the folder\'s changes away and resets it to main.',
      'It asks you to confirm first. The folder is hard reset to main and the changes are gone for good.',
    ),
  },
  form: {
    'save-answer': h(
      'Saves your answer.',
      'The run picks it up at its next step. Until then you can change it under Answered.',
    ),
    'mark-done': h(
      'Marks the task done.',
      'The run picks it up at its next step. Anything you wrote goes with it as a note.',
    ),
    'change-answer': h(
      'Answers again; the run has not used this answer yet.',
      'Opens the question again with your answer filled in. Save to replace it, or keep the old one.',
    ),
    'keep-answer': h(
      'Keeps the answer you gave before.',
      'Closes the question again without changing your answer.',
    ),
    'save-local': h(
      'Saves the value for this computer only.',
      '"Save for me" changes this computer only. A value saved for you wins over the team\'s.',
    ),
    'save-team': h(
      'Writes the value into foreman.config.json for everyone.',
      '"Save for the team" writes foreman.config.json, which everyone gets once it is committed. A value saved on a computer still wins there.',
    ),
    'reset-local': h(
      'Removes your value on this computer.',
      'This computer goes back to the team\'s value, or Foreman\'s default when the team sets none.',
    ),
    'reset-team': h(
      'Removes the value from foreman.config.json.',
      'Everyone goes back to Foreman\'s default once the change is committed, unless a computer saved its own value.',
    ),
  },
};

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

export const ACTION_HELP = deepFreeze(ACTIONS);

const APPLIES_TEXT = {
  'next-story': 'Takes effect from the next story a slot picks.',
  'next-run': 'Takes effect when the run next starts.',
  restart: 'Takes effect once the run or dashboard restarts.',
};

// Every setting's help, from the registry: the hint is its description, the fuller text adds
// when it takes effect and, for a setting only some projects have, when it shows.
export function settingHelp(registry = REGISTRY) {
  const out = {};
  for (const e of registry) {
    const more = [e.description];
    if (APPLIES_TEXT[e.applies]) more.push(APPLIES_TEXT[e.applies]);
    if (e.when) more.push(`Shown only when ${e.whenText}.`);
    out[e.name] = { hint: e.description, more: more.join(' ') };
  }
  return out;
}

// The body GET /api/help serves.
export const helpBody = () => ({ ...ACTION_HELP, settings: settingHelp() });
