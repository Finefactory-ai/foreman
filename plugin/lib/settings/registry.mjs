// Every setting the settings panel and `foreman settings` can change.
// Each entry is { name, label, description, type, default, applies, group, secret } plus the
// limits its type takes:
//
//   name      a dotted path into foreman.config.json ("features.followUps", "ship.ci.timeoutMinutes")
//   description  one plain sentence, at most 100 characters, with no semicolons, ending in a
//             full stop: the dashboard shows it as the setting's hint (settingHelp in
//             dashboard/help.mjs), which is where the limit comes from
//   type      boolean | integer | number | string | string[] | enum | map
//             integer/number take min and max (max may be a function of the config) and number
//             takes `above` (the value must be more than it); enum takes `values`; map takes
//             `keys` (the allowed keys; any key when unset), its values are non-empty text
//   default   the value when neither layer sets one; null means "not set, the reader decides"
//   applies   next-story (read fresh before each pick), next-run (read when the supervisor
//             starts) or restart (the server or slots must restart)
//   group     run, models, features, learning, release, jira, notify or console
//   secret    always false: secrets never enter the registry, they stay in the env file
//   when      optional (config) -> boolean: the setting means something only for some projects
//             (the Jira ones only with the Jira story source). Hidden from `list` otherwise, and
//             neither layer may set it then, so an adapter never sees an option it does not know.
//   whenText  what `when` asks, said to the user
//   check     optional (value, config) -> why | null: a further rule, applied once the type is
//             right (ship.pr.into must be a branch name, on every layer, because git and gh get
//             it, and must not be the pack block's productionBranch when the block sets one:
//             nothing merges into production; slots must not be more than the pack's slotLimit
//             allows, such as one slot per Salesforce build org)
//
//   get       optional (config) -> value: reads the setting where a dotted path cannot (a
//             reviewer inside the roles.reviewers array); getPath(config, name) otherwise
//   put       optional (obj, value) -> obj: writes it in place on a loaded config, the same way
//   team      optional { set(raw, value, config), remove(raw) }: how the team layer edits
//             foreman.config.json for it, instead of setting or removing the dotted path
//   unset     optional text for "no value" in the dashboard's dropdown; choosing it resets
//
// Settings inside an adapter's block (stories.*, notify.*, console.*, ship.smoke, ship.watch)
// are checked here by type only; the adapter checks its own block when it opens.
//
// REGISTRY is the fixed list. Each agent role's model is a setting too, made per project from its
// roles (role-models.mjs): settingsFor(config) lists them after REGISTRY, and findSetting finds
// one by name.

import { DEFAULTS } from '../config/defaults.mjs';
import { AGENT_MODELS, BRANCH, CLAUDE_FALLBACKS, COMMENT_DETAILS, LEARNING_MODELS } from '../config/validate.mjs';
import { PACKS } from '../../packs/index.mjs';
import { roleModelEntries, roleModelEntry } from './role-models.mjs';

export const TYPES = ['boolean', 'integer', 'number', 'string', 'string[]', 'enum', 'map'];
export const APPLIES = ['next-story', 'next-run', 'restart'];
export const GROUPS = ['run', 'models', 'features', 'learning', 'release', 'jira', 'notify', 'console'];

const SWITCHES = {
  learnTraits: ['Trait proposals', 'When one finding keeps sending stories back, `foreman learn` suggests a trait. You approve each one.'],
  followUps: ['Follow-up proposals', '`foreman learn` suggests a new story to fix the minor findings a shipped story left behind.'],
  followUpsOfFollowUps: ['Follow-ups of follow-ups', 'Also suggest follow-ups for stories that were themselves follow-ups. Off stops them chaining.'],
  autoCreateFollowUps: ['Create follow-ups without asking', 'Creates each follow-up story at once and tells you, with an Undo. Off asks you first.'],
  dependsOnProposals: ['depends_on proposals', 'Proposes a depends_on a story is missing. You approve each, unless Apply depends_on proposals is on.'],
  autoApplyDependsOn: ['Apply depends_on proposals', 'Adds a dependency the architect asks for at once and tells you, with an Undo. Off asks you first.'],
  productionGuard: ['Production guard', 'Stops the tester and reviewers from reaching production servers while they check a story.'],
  watchRollback: ['Watch and rollback', 'After a deploy, watches for errors and rolls back if any appear. Needs watch and rollback set up.'],
  mergeableRecheck: ['Mergeable recheck', 'Just before release, checks again that the pull request still merges cleanly.'],
  notifications: ['Notifications', 'Sends notifications through your notifier, for example email. Off writes them to the outbox only.'],
  costMetrics: ['Run records', 'Records each story\'s cost, rounds, time per stage and tokens per agent, for `foreman report`.'],
  keepAwake: ['Keep awake', 'Stops a Mac from sleeping while the run is going.'],
  jiraComments: ['Jira comments', 'Posts Foreman\'s notes as comments on the Jira issue.'],
  jiraTransitions: ['Jira transitions', 'Moves the Jira issue along its workflow as the story moves.'],
  salesforceComments: ['Salesforce comments', "Posts Foreman's notes as private comments on the Salesforce Case."],
  salesforceStatuses: ['Salesforce statuses', 'Sets the Case status as the story moves.'],
};

// The learning block: [key, label, description, type and limits].
const LEARNING = [
  ['auto', 'Learning on its own', 'Foreman learns traits and skills from repeated mistakes by itself and says so in Waiting on you.', { type: 'boolean' }],
  ['apply', 'Use what it learns', 'The agents get learned traits and skills from the next story. Off still learns but uses none of it.', { type: 'boolean' }],
  ['model', 'Learner model', 'The Claude model that proposes learned traits.', { type: 'enum', values: LEARNING_MODELS }],
  ['skillModel', 'Skill learner model', 'The Claude model that writes learned skills.', { type: 'enum', values: LEARNING_MODELS }],
  ['window', 'Evaluation window (stories)', 'How many stories using a learned item Foreman watches before keeping or rolling it back. At least 3.', { type: 'integer', min: 3 }],
  ['maxPerRole', 'Learned traits per role', 'The most learned traits one role can hold.', { type: 'integer', min: 0 }],
  ['maxSkills', 'Learned skills', 'The most learned skills Foreman keeps.', { type: 'integer', min: 0 }],
  ['maxEvaluating', 'Evaluating at once', 'How many learned items can be on trial at the same time.', { type: 'integer', min: 0 }],
  ['maxPerDay', 'Changes a day', 'The most learned changes Foreman makes in one day.', { type: 'integer', min: 0 }],
  ['maxUsdPerDay', 'Learning budget (USD a day)', 'The most the learner sessions may spend in one day, in US dollars.', { type: 'number', min: 0 }],
  ['redact', 'Redact', 'Words or patterns removed from findings before the learner sees them.', { type: 'string[]' }],
];

const isJira = (config) => config?.stories?.adapter === 'jira';
const JIRA = { group: 'jira', when: isJira, whenText: 'stories.adapter is "jira"' };
const WATCH = { when: (config) => config?.ship?.watch !== undefined, whenText: 'ship.watch is configured' };
const EMAIL = { when: (config) => config?.notify?.adapter === 'email-resend', whenText: 'notify.adapter is "email-resend"' };
const DASHBOARD = { when: (config) => (config?.console?.adapter ?? 'dashboard') === 'dashboard', whenText: 'console.adapter is "dashboard"' };

export const TRANSITION_EVENTS = ['started', 'blocked', 'review', 'failed', 'shipped'];

const entry = (name, label, description, rest) => ({ name, label, description, secret: false, ...rest });

const branchName = (value) => (BRANCH.test(value) ? null : 'expected a branch name');

// ship.pr.into: a branch name, and not the production branch the config's pack block names.
function prInto(value, config) {
  const problem = branchName(value);
  if (problem) return problem;
  const block = isPlain(config) && typeof config.pack === 'string' ? config[config.pack] : undefined;
  if (isPlain(block) && block.productionBranch === value) {
    return `must not be ${config.pack}.productionBranch: nothing merges into production`;
  }
  return null;
}

// slots: no more than the config's pack allows for its block (packs/index.mjs, slotLimit).
function packSlots(value, config) {
  const pack = isPlain(config) && typeof config.pack === 'string' && Object.hasOwn(PACKS, config.pack) ? PACKS[config.pack] : null;
  const lim = typeof pack?.slotLimit === 'function' ? pack.slotLimit(config[pack.name]) : null;
  return lim && value > lim.max ? `must be at most ${lim.max}: ${lim.why}` : null;
}

const ENTRIES = [
  // run
  entry('workers', 'Workers', 'How many stories build at the same time. `foreman run --workers N` overrides it for that run.', { type: 'integer', min: 1, max: (config) => config?.slots ?? DEFAULTS.slots, default: 1, applies: 'next-story', group: 'run' }),
  entry('slots', 'Slots', 'How many repo copies (git worktrees) Foreman keeps, one per story building. Workers can\'t exceed it.', { type: 'integer', min: 1, max: 8, default: 1, applies: 'restart', group: 'run', check: packSlots }),
  entry('rounds', 'Rounds', 'How many times the builder can fix what the tester or reviewers found before the story fails.', { type: 'integer', min: 1, max: 10, default: 3, applies: 'next-story', group: 'run' }),
  entry('watchdog.quietMinutes', 'Quiet limit (minutes)', 'Stops an agent session that has printed nothing for this many minutes, as it is probably stuck.', { type: 'number', above: 0, default: 30, applies: 'next-story', group: 'run' }),
  entry('watchdog.buildMinutes', 'Build limit (minutes)', 'Stops a story with no stage change or agent start, end or step for this long, and any at 4 times it.', { type: 'number', above: 0, default: 120, applies: 'next-story', group: 'run' }),
  entry('claude.fallback', 'When credits run out', 'What sessions do when the Console API key runs out of credit: use your subscription, or pause.', { type: 'enum', values: CLAUDE_FALLBACKS, default: 'subscription', applies: 'next-story', group: 'run' }),
  // models (the agent roles' models follow, from role-models.mjs)
  entry('session.model', 'Story session model', 'The model the story session itself runs on. It moves the story between stages and ships it.', { type: 'enum', values: AGENT_MODELS, default: null, applies: 'next-story', group: 'models', unset: 'The Claude CLI default' }),
  entry('checkRuns.maxParallel', 'Parallel full test runs', 'How many full test runs may go at once across all slots. Unset, one per 8 cores, at least 1.', { type: 'integer', min: 1, max: 64, default: null, applies: 'next-story', group: 'run' }),
  // features
  ...Object.entries(SWITCHES).map(([key, [label, description]]) =>
    entry(`features.${key}`, label, description, { type: 'boolean', default: DEFAULTS.features[key], applies: key === 'keepAwake' ? 'next-run' : 'next-story', group: 'features' })),
  entry('features.jiraCommentDetail', 'Comment detail', "Whether Foreman's story comments list each finding in full or only count them.", { type: 'enum', values: COMMENT_DETAILS, default: 'summary', applies: 'next-story', group: 'features' }),
  // learning
  ...LEARNING.map(([key, label, description, kind]) =>
    entry(`learning.${key}`, label, description, { ...kind, default: DEFAULTS.learning[key], applies: 'next-story', group: 'learning' })),
  // release
  entry('ship.ci.timeoutMinutes', 'CI timeout (minutes)', 'How long to wait in total for the pull request\'s checks to finish.', { type: 'number', above: 0, default: 30, applies: 'next-story', group: 'release' }),
  entry('ship.ci.settleSeconds', 'CI settle time (seconds)', 'How long checks must stay finished, with no new one, so a fast check cannot pass before the real CI.', { type: 'number', above: 0, default: 90, applies: 'next-story', group: 'release' }),
  entry('ship.deploy-github.timeoutMinutes', 'Deploy timeout (minutes)', 'How long to wait for the GitHub deployment to finish.', { type: 'number', above: 0, default: 15, applies: 'next-story', group: 'release' }),
  entry('ship.watch.minutes', 'Watch length (minutes)', 'How long to watch for errors after a deploy.', { type: 'number', above: 0, default: 10, applies: 'next-story', group: 'release', ...WATCH }),
  entry('ship.watch.everySeconds', 'Watch interval (seconds)', 'How often the watch runs its command.', { type: 'number', above: 0, default: 60, applies: 'next-story', group: 'release', ...WATCH }),
  entry('ship.smoke.urls', 'Smoke-test URLs', 'Live pages to load after a deploy, to check the site is up.', { type: 'string[]', default: [], applies: 'next-story', group: 'release' }),
  entry('ship.pr.into', 'Pull request target', 'The branch pull requests merge into. Leave empty to use baseBranch, the branch stories start from.', { type: 'string', default: null, applies: 'next-story', group: 'release', check: prInto }),
  entry('ship.merge.keepBranch', 'Keep the branch', 'Keeps the story branch after its pull request merges, instead of deleting it.', { type: 'boolean', default: false, applies: 'next-story', group: 'release' }),
  // jira
  entry('stories.jql', 'JQL filter', 'The Jira search (JQL) that picks which issues are stories. Its ORDER BY sets the build order.', { type: 'string', default: null, applies: 'next-story', ...JIRA }),
  entry('stories.pollSeconds', 'Poll interval (seconds)', 'How long Foreman reuses the story list before asking Jira again. 0 asks every time.', { type: 'integer', min: 0, default: 60, applies: 'next-story', ...JIRA }),
  entry('stories.ownerLabel', 'Owner label', 'Issues with this label are tasks for you. Foreman never picks them.', { type: 'string', default: 'foreman-owner', applies: 'next-story', ...JIRA }),
  entry('stories.transitions', 'Transitions', 'The Jira transition for started, blocked, review, failed, shipped. An event left out moves nothing.', { type: 'map', keys: TRANSITION_EVENTS, default: {}, applies: 'next-story', ...JIRA }),
  // notify
  entry('notify.to', 'Notify address', 'Where notifications are emailed. Leave empty to use FOREMAN_NOTIFY_EMAIL, then your git email.', { type: 'string', default: null, applies: 'next-story', group: 'notify', ...EMAIL }),
  // console
  entry('console.port', 'Dashboard port', 'The port the dashboard runs on.', { type: 'integer', min: 1, max: 65535, default: 4317, applies: 'restart', group: 'console', ...DASHBOARD }),
  entry('console.host', 'Dashboard host', 'The address the dashboard listens on. 127.0.0.1 keeps it on this computer only.', { type: 'string', default: '127.0.0.1', applies: 'restart', group: 'console', ...DASHBOARD }),
];

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

export const REGISTRY = deepFreeze(ENTRIES);
const BY_NAME = new Map(REGISTRY.map((e) => [e.name, e]));

export const findSetting = (name) => BY_NAME.get(name) ?? roleModelEntry(name);

// Every setting for this project: the registry, then a model setting for each agent role it has.
export const settingsFor = (config) => [...REGISTRY, ...roleModelEntries(config)];

// Whether the setting means something for this project.
export const shown = (e, config) => (typeof e.when === 'function' ? Boolean(e.when(config)) : true);

// A name that looks like it holds a secret. Such a name is never a setting.
const SECRET = /(secret|token|password|passwd|credential|api[_-]?key|private[_-]?key|(^|[._-])key$)/i;
export const looksSecret = (name) => SECRET.test(String(name));

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.length > 0;
const limit = (v, config) => (typeof v === 'function' ? v(config) : v);

// Why `value` is not a valid value for setting `e`, or null when it is. `config` is the config
// the value would go into, for limits that depend on it (workers is at most slots).
export function checkValue(e, value, config) {
  const problem = checkType(e, value, config);
  if (problem || typeof e.check !== 'function') return problem;
  return e.check(value, config);
}

function checkType(e, value, config) {
  switch (e.type) {
    case 'boolean':
      return typeof value === 'boolean' ? null : 'expected true or false';
    case 'integer':
    case 'number': {
      const min = limit(e.min, config);
      const max = limit(e.max, config);
      const ok = typeof value === 'number' && Number.isFinite(value) && (e.type === 'number' || Number.isInteger(value))
        && (min === undefined || value >= min) && (max === undefined || value <= max) && (e.above === undefined || value > e.above);
      if (ok) return null;
      if (e.type === 'number' && e.above !== undefined) return `must be a number above ${e.above}`;
      const kind = e.type === 'integer' ? 'a whole number' : 'a number';
      if (min !== undefined && max !== undefined) return `must be ${kind} from ${min} to ${max}`;
      if (min !== undefined) return `must be ${kind} of at least ${min}`;
      if (max !== undefined) return `must be ${kind} of at most ${max}`;
      return `expected ${kind}`;
    }
    case 'string':
      return isText(value) ? null : 'expected non-empty text';
    case 'string[]':
      return Array.isArray(value) && value.every(isText) ? null : 'expected a list of non-empty text';
    case 'enum':
      return e.values.includes(value) ? null : `must be one of ${e.values.join(', ')}`;
    case 'map': {
      if (!isPlain(value)) return 'expected an object';
      for (const [k, v] of Object.entries(value)) {
        if (e.keys && !e.keys.includes(k)) return `unknown key ${k} (use ${e.keys.join(', ')})`;
        if (!isText(v)) return `${k}: expected non-empty text`;
      }
      return null;
    }
    default:
      return `unknown type ${e.type}`;
  }
}

const BOOLEAN_WORDS = { true: true, on: true, yes: true, false: false, off: false, no: false };

// A value typed on the command line, read as setting `e`'s type: { value } or { error }. It
// does not check the limits; checkValue does.
export function parseValue(e, text) {
  const t = String(text ?? '').trim();
  switch (e.type) {
    case 'boolean':
      return Object.hasOwn(BOOLEAN_WORDS, t.toLowerCase()) ? { value: BOOLEAN_WORDS[t.toLowerCase()] } : { error: 'expected true or false' };
    case 'integer':
    case 'number':
      return t !== '' && Number.isFinite(Number(t)) ? { value: Number(t) } : { error: 'expected a number' };
    case 'string[]':
      if (t.startsWith('[')) return json(t, 'a JSON list');
      return { value: t === '' ? [] : t.split(',').map((s) => s.trim()) };
    case 'map':
      return json(t, 'a JSON object such as {"started":"In Progress"}');
    default:
      return { value: String(text ?? '') };
  }
}

function json(t, what) {
  try {
    return { value: JSON.parse(t) };
  } catch {
    return { error: `expected ${what} (not valid JSON)` };
  }
}
