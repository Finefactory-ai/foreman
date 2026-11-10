// Checks a parsed foreman.config.json by hand, with no schema library. It returns a
// list of { path, message } and never throws, so the caller can show every problem at once.
//
//   - unknown keys are errors, so a typo like `slot` shows up instead of being ignored
//   - types and enums are checked, and each error names its JSON path (`checks[1].when`)
//   - `version: 1` is required, so a later version can migrate old files
//   - the options inside an adapter block (stories, env, ship, notify, console) pass through;
//     each adapter checks its own in a later story
//   - `features` holds only the known switches, each a boolean (jiraCommentDetail is summary or full); `workers` is at most `slots`
//   - `learning` holds only its known keys: auto and apply are booleans, model and skillModel
//     name a Claude model (LEARNING_MODELS), window is a whole number of at least 3, the max*
//     caps whole numbers of at least 0 (0 adds none), maxUsdPerDay a number of at least 0, and
//     redact a list of non-empty strings
//   - the top-level `keepAwake` is still accepted but deprecated (configWarnings says so); it is
//     read as features.keepAwake
//   - `pack` names a pack in `packs` (plugin/packs/index.mjs); that pack's own block, the
//     top-level key named like it, is then allowed and checked by the pack's checkConfig, which
//     also gets the whole file; `stories.adapter: "salesforce"` needs `pack: "salesforce"`
//   - `session` holds only extraTools, mcpServers, userSettings and model. `model`, one of
//     AGENT_MODELS, is the model the story session itself runs on (session.mjs). `extraTools` lists tool
//     names added to every story session's allowed tools; each is one argv item for `claude`,
//     so it must have no spaces and not start with "-". `mcpServers` lists the servers from the
//     project's .mcp.json that story sessions load (MCP_NAME: a letter or digit first, then
//     letters, digits, `_`, `.` and `-`). `userSettings` is a boolean: whether story sessions
//     load the user-level Claude Code settings, CLAUDE.md and memory (engine/session-scope.mjs)
//   - `foremanEnvFile` (Foreman's own keys) must not name the same file as `envFile` (the
//     project's keys, linked into every slot worktree)
//   - `claude` holds only `fallback`: what sessions do when the Console API key runs out of
//     credit, one of CLAUDE_FALLBACKS (subscription or none)
//   - `checkRuns` holds only `maxParallel`: how many full test runs may go at once across all
//     slots, a whole number from 1 to 64 (it is not under `checks`, which is the list of commands)
//   - each role (architect, tester, each builder, each reviewer) may name a `model`, one of
//     AGENT_MODELS; unset, the agent runs on the story session's model. Pack roles take it too:
//     a project overrides them through the same `roles` block
//   - a check may carry `quick`, a non-empty string: the project's faster command for a change in
//     progress (`foreman checks --quick`); a builder may carry `fullChecks`, a boolean: true makes
//     it run the full checks instead of the quick ones
//   - `fileLocks` holds only `ignore`: a list of non-empty globs for files no story claims

import path from 'node:path';
import { DEFAULTS } from './defaults.mjs';
import { PACKS, packNames } from '../../packs/index.mjs';

export const SUPPORTED_VERSION = 1;

const SLUG = /^[a-z][a-z0-9-]*$/;
const TOP_KEYS = [
  'version', 'project', 'baseBranch', 'remote', 'branchPrefix', 'stateDir', 'envFile', 'foremanEnvFile', 'slots', 'rounds',
  'install', 'checks', 'generated', 'roles', 'resources', 'stories', 'env', 'ship', 'notify', 'console',
  'watchdog', 'keepAwake', 'workers', 'features', 'learning', 'state', 'cloud', 'pack', 'session', 'claude', 'fileLocks', 'checkRuns',
];
const FEATURES = Object.keys(DEFAULTS.features);
const STRING_KEYS = ['baseBranch', 'remote', 'branchPrefix', 'stateDir', 'envFile', 'foremanEnvFile'];
const ADAPTER_BLOCKS = ['stories', 'env', 'notify', 'console'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.length > 0;
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const isSlug = (v) => typeof v === 'string' && SLUG.test(v) && !(v in Object.prototype);
const at = (path, key) => (path ? `${path}.${key}` : key);

function expectObject(v, path, errors) {
  if (isObject(v)) return true;
  errors.push({ path, message: 'expected object' });
  return false;
}

function noUnknownKeys(obj, allowed, path, errors) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) errors.push({ path: at(path, key), message: 'unknown key' });
  }
}

function text(obj, key, path, errors, { required = true } = {}) {
  const v = obj[key];
  if (v === undefined) {
    if (required) errors.push({ path: at(path, key), message: 'required' });
  } else if (!isText(v)) {
    errors.push({ path: at(path, key), message: 'expected non-empty string' });
  }
}

function stringList(v, path, errors, { nonEmpty = false } = {}) {
  if (!Array.isArray(v)) {
    errors.push({ path, message: 'expected array' });
    return;
  }
  if (nonEmpty && v.length === 0) errors.push({ path, message: 'must not be empty' });
  v.forEach((item, i) => {
    if (!isText(item)) errors.push({ path: `${path}[${i}]`, message: 'expected non-empty string' });
  });
}

function each(v, path, errors, check) {
  if (!Array.isArray(v)) {
    errors.push({ path, message: 'expected array' });
    return;
  }
  v.forEach((item, i) => {
    const here = `${path}[${i}]`;
    if (expectObject(item, here, errors)) check(item, here);
  });
}

function install(v, path, errors) {
  if (v === null || !expectObject(v, path, errors)) return;
  noUnknownKeys(v, ['run', 'when', 'creates'], path, errors);
  text(v, 'run', path, errors);
  text(v, 'when', path, errors);
  text(v, 'creates', path, errors, { required: false });
}

function checks(v, path, errors) {
  each(v, path, errors, (c, here) => {
    noUnknownKeys(c, ['run', 'when', 'quick'], here, errors);
    text(c, 'run', here, errors);
    text(c, 'quick', here, errors, { required: false });
    if (c.when === undefined) errors.push({ path: at(here, 'when'), message: 'required' });
    else if (!isText(c.when)) {
      errors.push({ path: at(here, 'when'), message: 'must be "always" or a glob string' });
    }
  });
}

function generated(v, path, errors) {
  each(v, path, errors, (g, here) => {
    noUnknownKeys(g, ['path', 'regenerate'], here, errors);
    text(g, 'path', here, errors);
    text(g, 'regenerate', here, errors);
  });
}

function fileLocks(v, path, errors) {
  if (!expectObject(v, path, errors)) return;
  noUnknownKeys(v, ['ignore'], path, errors);
  if (v.ignore !== undefined) stringList(v.ignore, at(path, 'ignore'), errors);
}

function traits(role, path, errors) {
  if (role.traits !== undefined) stringList(role.traits, at(path, 'traits'), errors);
}

function roleModel(role, path, errors) {
  if (role.model !== undefined && !AGENT_MODELS.includes(role.model)) {
    errors.push({ path: at(path, 'model'), message: `must be one of ${AGENT_MODELS.join(', ')}` });
  }
}

function singleRole(v, path, errors) {
  if (!expectObject(v, path, errors)) return;
  noUnknownKeys(v, ['agent', 'traits', 'model'], path, errors);
  text(v, 'agent', path, errors);
  traits(v, path, errors);
  roleModel(v, path, errors);
}

function builders(v, path, errors) {
  if (!expectObject(v, path, errors)) return;
  for (const [name, b] of Object.entries(v)) {
    const here = at(path, name);
    if (!isSlug(name)) errors.push({ path: here, message: 'name must be a slug (lowercase letters, digits, hyphens), and not a reserved word' });
    if (!expectObject(b, here, errors)) continue;
    noUnknownKeys(b, ['agent', 'use', 'traits', 'model', 'fullChecks'], here, errors);
    text(b, 'agent', here, errors);
    text(b, 'use', here, errors);
    traits(b, here, errors);
    roleModel(b, here, errors);
    if (b.fullChecks !== undefined && typeof b.fullChecks !== 'boolean') errors.push({ path: at(here, 'fullChecks'), message: 'expected boolean' });
  }
}

function reviewers(v, path, errors) {
  const seen = new Set();
  each(v, path, errors, (r, here) => {
    noUnknownKeys(r, ['name', 'agent', 'prompt', 'traits', 'model', 'engine'], here, errors);
    if (r.name === undefined) errors.push({ path: at(here, 'name'), message: 'required' });
    else if (!isSlug(r.name)) {
      errors.push({ path: at(here, 'name'), message: 'must be a slug (lowercase letters, digits, hyphens), and not a reserved word' });
    } else if (seen.has(r.name)) errors.push({ path: at(here, 'name'), message: 'duplicate' });
    else seen.add(r.name);
    text(r, 'agent', here, errors);
    if (r.prompt !== undefined && typeof r.prompt !== 'string') errors.push({ path: at(here, 'prompt'), message: 'expected string' });
    traits(r, here, errors);
    roleModel(r, here, errors);
    if (r.engine !== undefined) reviewEngine(r.engine, at(here, 'engine'), errors);
  });
}

// A reviewer run through another agent CLI (engine/review-engine.mjs): which one, on which of
// its models, and how long it may take.
export const REVIEW_ENGINES = ['antigravity'];

function reviewEngine(v, path, errors) {
  if (!expectObject(v, path, errors)) return;
  noUnknownKeys(v, ['name', 'model', 'minutes'], path, errors);
  if (!REVIEW_ENGINES.includes(v.name)) errors.push({ path: at(path, 'name'), message: `must be one of ${REVIEW_ENGINES.join(', ')}` });
  text(v, 'model', path, errors);
  if (v.minutes !== undefined && !isInt(v.minutes, 1, 180)) errors.push({ path: at(path, 'minutes'), message: 'expected a whole number of minutes from 1 to 180' });
}

function roles(v, path, errors) {
  if (!expectObject(v, path, errors)) return;
  noUnknownKeys(v, ['architect', 'builders', 'tester', 'reviewers'], path, errors);
  if (v.architect !== undefined) singleRole(v.architect, at(path, 'architect'), errors);
  if (v.builders !== undefined) builders(v.builders, at(path, 'builders'), errors);
  if (v.tester !== undefined) singleRole(v.tester, at(path, 'tester'), errors);
  if (v.reviewers !== undefined) reviewers(v.reviewers, at(path, 'reviewers'), errors);
}

function resources(v, path, errors) {
  if (!expectObject(v, path, errors)) return;
  for (const [name, r] of Object.entries(v)) {
    const here = at(path, name);
    if (!isSlug(name)) errors.push({ path: here, message: 'name must be a slug (lowercase letters, digits, hyphens), and not a reserved word' });
    if (!expectObject(r, here, errors)) continue;
    noUnknownKeys(r, ['paths', 'describe'], here, errors);
    if (r.paths === undefined) errors.push({ path: at(here, 'paths'), message: 'required' });
    else stringList(r.paths, at(here, 'paths'), errors, { nonEmpty: true });
    if (r.describe === undefined) errors.push({ path: at(here, 'describe'), message: 'required' });
    else if (!isText(r.describe)) errors.push({ path: at(here, 'describe'), message: 'expected non-empty string' });
  }
}

function adapterBlock(v, path, errors) {
  if (!expectObject(v, path, errors)) return;
  text(v, 'adapter', path, errors);
}

const MERGE_METHODS = ['merge', 'squash', 'rebase'];

function positive(obj, key, path, errors) {
  const v = obj[key];
  if (v !== undefined && !(typeof v === 'number' && Number.isFinite(v) && v > 0)) {
    errors.push({ path: at(path, key), message: 'must be a positive number' });
  }
}

function smoke(v, path, errors) {
  if (!expectObject(v, path, errors)) return;
  noUnknownKeys(v, ['urls', 'expect'], path, errors);
  if (v.urls !== undefined) stringList(v.urls, at(path, 'urls'), errors);
  const exp = at(path, 'expect');
  if (v.expect !== undefined && expectObject(v.expect, exp, errors)) {
    for (const [url, status] of Object.entries(v.expect)) {
      if (!isInt(status, 100, 599)) errors.push({ path: `${exp}[${JSON.stringify(url)}]`, message: 'must be an integer from 100 to 599' });
    }
  }
}

export const ROLLBACK_IN_STEPS = 'rollback runs only on failure; set ship.rollback.command and leave it out of ship.steps';

function watch(v, path, errors) {
  if (!expectObject(v, path, errors)) return;
  noUnknownKeys(v, ['command', 'minutes', 'everySeconds', 'timeoutSeconds'], path, errors);
  text(v, 'command', path, errors);
  positive(v, 'minutes', path, errors);
  positive(v, 'everySeconds', path, errors);
  positive(v, 'timeoutSeconds', path, errors);
}

function rollback(v, path, errors) {
  if (!expectObject(v, path, errors)) return;
  noUnknownKeys(v, ['command', 'timeoutSeconds'], path, errors);
  text(v, 'command', path, errors);
  positive(v, 'timeoutSeconds', path, errors);
}

// A plain branch name: no spaces, no leading dash or slash, no trailing slash, no "..", not
// ending in .lock. Close enough to git check-ref-format for a config check. The settings
// registry checks ship.pr.into with it too, so the local layer cannot pass git an option.
export const BRANCH = /^(?!-)(?!\/)(?!.*\.\.)(?!.*\/$)(?!.*\.lock$)[A-Za-z0-9._/-]+$/;

// A tool name for `--allowedTools`, such as mcp__acme__query or Workflow(acme:x): no spaces and
// no leading dash. Each name is its own argv item for `claude`, so one starting with "-" would be
// read as a flag. session.mjs filters with it too, since pack defaults are never validated.
export const TOOL_NAME = /^[^-\s][^\s]*$/;

// An MCP server name in session.mcpServers, as .mcp.json names it. engine/session-scope.mjs
// filters with it too, since pack defaults are never validated.
export const MCP_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

// The Claude CLI model aliases the learner sessions may use (learning.model, learning.skillModel).
export const LEARNING_MODELS = ['haiku', 'sonnet', 'opus'];

// The model aliases the Workflow agent() call takes, for roles.*.model.
export const AGENT_MODELS = ['haiku', 'sonnet', 'opus', 'fable'];

function ship(v, path, errors) {
  if (!expectObject(v, path, errors)) return;
  if (v.steps === undefined) errors.push({ path: at(path, 'steps'), message: 'required' });
  else stringList(v.steps, at(path, 'steps'), errors, { nonEmpty: true });
  const steps = Array.isArray(v.steps) ? v.steps : [];
  steps.forEach((name, i) => {
    if (name === 'rollback') errors.push({ path: `${at(path, 'steps')}[${i}]`, message: ROLLBACK_IN_STEPS });
  });
  if (v.watch !== undefined) watch(v.watch, at(path, 'watch'), errors);
  else if (steps.includes('watch')) errors.push({ path: at(at(path, 'watch'), 'command'), message: 'required' });
  if (v.rollback !== undefined) rollback(v.rollback, at(path, 'rollback'), errors);
  const ci = at(path, 'ci');
  if (v.ci !== undefined && expectObject(v.ci, ci, errors)) {
    if (v.ci.required !== undefined) stringList(v.ci.required, at(ci, 'required'), errors);
    positive(v.ci, 'timeoutMinutes', ci, errors);
    positive(v.ci, 'settleSeconds', ci, errors);
  }
  const hosts = at(path, 'productionHosts');
  if (v.productionHosts !== undefined) {
    stringList(v.productionHosts, hosts, errors, { nonEmpty: true });
    if (Array.isArray(v.productionHosts)) {
      v.productionHosts.forEach((h, i) => {
        if (isText(h) && /[/\s]/.test(h)) errors.push({ path: `${hosts}[${i}]`, message: 'expected a host name with no scheme or path' });
      });
    }
  }
  if (v.smoke !== undefined) smoke(v.smoke, at(path, 'smoke'), errors);
  const pr = at(path, 'pr');
  if (v.pr !== undefined && expectObject(v.pr, pr, errors)) {
    if (v.pr.mergeMethod !== undefined && !MERGE_METHODS.includes(v.pr.mergeMethod)) {
      errors.push({ path: at(pr, 'mergeMethod'), message: `must be one of ${MERGE_METHODS.join(', ')}` });
    }
    if (v.pr.into !== undefined && !(isText(v.pr.into) && BRANCH.test(v.pr.into))) {
      errors.push({ path: at(pr, 'into'), message: 'expected a branch name' });
    }
  }
  const merge = at(path, 'merge');
  if (v.merge !== undefined && expectObject(v.merge, merge, errors)) {
    noUnknownKeys(v.merge, ['keepBranch'], merge, errors);
    if (v.merge.keepBranch !== undefined && typeof v.merge.keepBranch !== 'boolean') {
      errors.push({ path: at(merge, 'keepBranch'), message: 'expected true or false' });
    }
  }
}

function watchdog(v, path, errors) {
  if (!expectObject(v, path, errors)) return;
  // idle, error, progress and activity are the progress watchdog's (engine/progress-watch.mjs stuckLimits);
  // outlive is engine/session-outlive.mjs (a session still up after its final result);
  // ownerTaskHours is engine/owner-task-watch.mjs (hours an owner task may hold a story before the
  // owner is told once; fractions allowed).
  const keys = ['quietMinutes', 'buildMinutes', 'idleMinutes', 'errorMinutes', 'progressMinutes', 'activityMinutes', 'outliveMinutes', 'ownerTaskHours'];
  noUnknownKeys(v, keys, path, errors);
  for (const key of keys) {
    if (v[key] !== undefined && !(Number.isFinite(v[key]) && v[key] > 0)) {
      errors.push({ path: at(path, key), message: 'must be a positive number' });
    }
  }
}

function state(v, path, errors, baseBranch) {
  if (!expectObject(v, path, errors)) return;
  noUnknownKeys(v, ['store', 'branch'], path, errors);
  if (v.store !== undefined && !['files', 'branch'].includes(v.store)) errors.push({ path: at(path, 'store'), message: 'must be "files" or "branch"' });
  if (v.branch === undefined) return;
  if (typeof v.branch !== 'string' || !BRANCH.test(v.branch)) errors.push({ path: at(path, 'branch'), message: 'must be a plain git branch name' });
  else if (v.branch === baseBranch) errors.push({ path: at(path, 'branch'), message: 'must not be the base branch' });
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Five cron fields of digits, `*`, `/`, `,` and `-`: what a GitHub Actions schedule takes,
// and nothing that could break out of the quoted YAML value it is written into.
const CRON = /^[0-9*/,-]+( [0-9*/,-]+){4}$/;

function cloud(v, path, errors) {
  if (!expectObject(v, path, errors)) return;
  noUnknownKeys(v, ['envVars', 'idleMinutes', 'actions'], path, errors);
  if (v.envVars !== undefined) {
    if (!Array.isArray(v.envVars)) errors.push({ path: at(path, 'envVars'), message: 'expected array' });
    else v.envVars.forEach((name, i) => {
      if (typeof name !== 'string' || !ENV_NAME.test(name)) errors.push({ path: `${at(path, 'envVars')}[${i}]`, message: 'must be an environment variable name' });
    });
  }
  if (v.idleMinutes !== undefined && !(typeof v.idleMinutes === 'number' && Number.isFinite(v.idleMinutes) && v.idleMinutes > 0)) {
    errors.push({ path: at(path, 'idleMinutes'), message: 'must be a positive number' });
  }
  if (v.actions === undefined) return;
  const actions = at(path, 'actions');
  if (!expectObject(v.actions, actions, errors)) return;
  noUnknownKeys(v.actions, ['cron'], actions, errors);
  if (v.actions.cron !== undefined && !(typeof v.actions.cron === 'string' && CRON.test(v.actions.cron))) {
    errors.push({ path: at(actions, 'cron'), message: 'must be five cron fields, such as "*/30 * * * *"' });
  }
}

function session(v, path, errors) {
  if (!expectObject(v, path, errors)) return;
  noUnknownKeys(v, ['extraTools', 'mcpServers', 'userSettings', 'model'], path, errors);
  if (v.model !== undefined && !AGENT_MODELS.includes(v.model)) errors.push({ path: at(path, 'model'), message: `must be one of ${AGENT_MODELS.join(', ')}` });
  if (v.extraTools !== undefined) {
    const tools = at(path, 'extraTools');
    stringList(v.extraTools, tools, errors);
    if (Array.isArray(v.extraTools)) {
      v.extraTools.forEach((name, i) => {
        if (isText(name) && !TOOL_NAME.test(name)) errors.push({ path: `${tools}[${i}]`, message: 'expected a tool name with no spaces, not starting with "-"' });
      });
    }
  }
  if (v.mcpServers !== undefined) {
    const servers = at(path, 'mcpServers');
    stringList(v.mcpServers, servers, errors);
    if (Array.isArray(v.mcpServers)) {
      v.mcpServers.forEach((name, i) => {
        if (isText(name) && !MCP_NAME.test(name)) errors.push({ path: `${servers}[${i}]`, message: 'expected an MCP server name from .mcp.json' });
      });
    }
  }
  if (v.userSettings !== undefined && typeof v.userSettings !== 'boolean') errors.push({ path: at(path, 'userSettings'), message: 'expected boolean' });
}

export const CLAUDE_FALLBACKS = ['subscription', 'none'];

function claude(v, path, errors) {
  if (!expectObject(v, path, errors)) return;
  noUnknownKeys(v, ['fallback'], path, errors);
  if (v.fallback !== undefined && !CLAUDE_FALLBACKS.includes(v.fallback)) {
    errors.push({ path: at(path, 'fallback'), message: `must be one of ${CLAUDE_FALLBACKS.join(', ')}` });
  }
}

function checkRuns(v, path, errors) {
  if (!expectObject(v, path, errors)) return;
  noUnknownKeys(v, ['maxParallel'], path, errors);
  if (v.maxParallel !== undefined && !isInt(v.maxParallel, 1, 64)) {
    errors.push({ path: at(path, 'maxParallel'), message: 'must be an integer from 1 to 64' });
  }
}

// How much of a round's findings the story's comments list: counted, or each in full.
export const COMMENT_DETAILS = ['summary', 'full'];

function features(v, path, errors) {
  if (!expectObject(v, path, errors)) return;
  noUnknownKeys(v, FEATURES, path, errors);
  for (const key of Object.keys(v)) {
    if (!FEATURES.includes(key)) continue;
    if (key === 'jiraCommentDetail') {
      if (!COMMENT_DETAILS.includes(v[key])) errors.push({ path: at(path, key), message: `must be one of ${COMMENT_DETAILS.join(', ')}` });
    } else if (typeof v[key] !== 'boolean') errors.push({ path: at(path, key), message: 'expected boolean' });
  }
}

const LEARNING = Object.keys(DEFAULTS.learning);
const LEARNING_CAPS = ['maxPerRole', 'maxSkills', 'maxEvaluating', 'maxPerDay'];

function learning(v, path, errors) {
  if (!expectObject(v, path, errors)) return;
  noUnknownKeys(v, LEARNING, path, errors);
  for (const key of ['auto', 'apply']) {
    if (v[key] !== undefined && typeof v[key] !== 'boolean') errors.push({ path: at(path, key), message: 'expected boolean' });
  }
  for (const key of ['model', 'skillModel']) {
    if (v[key] !== undefined && !LEARNING_MODELS.includes(v[key])) errors.push({ path: at(path, key), message: `must be one of ${LEARNING_MODELS.join(', ')}` });
  }
  if (v.window !== undefined && !isInt(v.window, 3, Infinity)) errors.push({ path: at(path, 'window'), message: 'must be an integer of at least 3' });
  for (const key of LEARNING_CAPS) {
    if (v[key] !== undefined && !isInt(v[key], 0, Infinity)) errors.push({ path: at(path, key), message: 'must be an integer of at least 0' });
  }
  const usd = v.maxUsdPerDay;
  if (usd !== undefined && !(typeof usd === 'number' && Number.isFinite(usd) && usd >= 0)) {
    errors.push({ path: at(path, 'maxUsdPerDay'), message: 'must be a number of at least 0' });
  }
  if (v.redact !== undefined) stringList(v.redact, at(path, 'redact'), errors);
}

// What is valid but should change, as lines for `foreman config check` to print as warnings.
export function configWarnings(raw) {
  if (!isObject(raw) || raw.keepAwake === undefined) return [];
  if (isObject(raw.features) && raw.features.keepAwake !== undefined) {
    return ['keepAwake is deprecated and ignored: features.keepAwake is set too; remove keepAwake'];
  }
  return [`keepAwake is deprecated; it is read as features.keepAwake (\`foreman settings set features.keepAwake ${raw.keepAwake === false ? 'false' : 'true'} --team\` moves it there)`];
}

// The pack `raw.pack` names, or null with an error when it names none that is installed.
function selectedPack(raw, packs, errors) {
  if (raw.pack === undefined) return null;
  if (!isText(raw.pack)) {
    errors.push({ path: 'pack', message: 'expected non-empty string' });
    return null;
  }
  if (Object.hasOwn(packs, raw.pack)) return packs[raw.pack];
  const names = packNames(packs);
  const known = names.length ? `known packs: ${names.join(', ')}` : 'no packs are installed';
  errors.push({ path: 'pack', message: `unknown pack ${JSON.stringify(raw.pack)}; ${known}` });
  return null;
}

// The pack checks its own block; a pack that throws is reported, never passed on.
function packBlock(pack, block, errors, raw) {
  try {
    for (const e of pack.checkConfig(block, raw)) errors.push({ path: e.path ? `${pack.name}.${e.path}` : pack.name, message: e.message });
  } catch (err) {
    errors.push({ path: pack.name, message: `the ${pack.name} pack could not check its block: ${err?.message ?? err}` });
  }
}

export function validate(raw, { packs = PACKS } = {}) {
  const errors = [];
  if (!isObject(raw)) return [{ path: '', message: 'config must be a JSON object' }];

  const pack = selectedPack(raw, packs, errors);
  noUnknownKeys(raw, pack ? [...TOP_KEYS, pack.name] : TOP_KEYS, '', errors);

  if (raw.version === undefined) errors.push({ path: 'version', message: 'required' });
  else if (raw.version !== SUPPORTED_VERSION) {
    errors.push({ path: 'version', message: `unsupported config version ${JSON.stringify(raw.version)}` });
  }

  if (raw.project === undefined) errors.push({ path: 'project.name', message: 'required' });
  else if (expectObject(raw.project, 'project', errors)) {
    noUnknownKeys(raw.project, ['name'], 'project', errors);
    const name = raw.project.name;
    if (name === undefined || name === '') errors.push({ path: 'project.name', message: 'required' });
    else if (!isText(name)) errors.push({ path: 'project.name', message: 'expected non-empty string' });
  }

  for (const key of STRING_KEYS) {
    if (raw[key] !== undefined && !isText(raw[key])) errors.push({ path: key, message: 'expected non-empty string' });
  }
  const envFile = isText(raw.envFile) ? raw.envFile : DEFAULTS.envFile;
  const foremanEnvFile = isText(raw.foremanEnvFile) ? raw.foremanEnvFile : DEFAULTS.foremanEnvFile;
  if (path.normalize(foremanEnvFile) === path.normalize(envFile)) errors.push({ path: 'foremanEnvFile', message: 'must not be the same file as envFile' });
  if (raw.slots !== undefined && !isInt(raw.slots, 1, 8)) errors.push({ path: 'slots', message: 'must be an integer from 1 to 8' });
  if (raw.rounds !== undefined && !isInt(raw.rounds, 1, 10)) errors.push({ path: 'rounds', message: 'must be an integer from 1 to 10' });
  if (raw.workers !== undefined) {
    const slots = isInt(raw.slots, 1, 8) ? raw.slots : DEFAULTS.slots;
    if (!isInt(raw.workers, 1, 8)) errors.push({ path: 'workers', message: 'must be an integer from 1 to 8' });
    else if (raw.workers > slots) errors.push({ path: 'workers', message: `must not be more than slots (${slots})` });
  }
  if (raw.keepAwake !== undefined && typeof raw.keepAwake !== 'boolean') errors.push({ path: 'keepAwake', message: 'expected boolean' });

  if (raw.install !== undefined) install(raw.install, 'install', errors);
  if (raw.checks !== undefined) checks(raw.checks, 'checks', errors);
  if (raw.generated !== undefined) generated(raw.generated, 'generated', errors);
  if (raw.fileLocks !== undefined) fileLocks(raw.fileLocks, 'fileLocks', errors);
  if (raw.roles !== undefined) roles(raw.roles, 'roles', errors);
  if (raw.resources !== undefined) resources(raw.resources, 'resources', errors);
  for (const key of ADAPTER_BLOCKS) if (raw[key] !== undefined) adapterBlock(raw[key], key, errors);
  if (raw.ship !== undefined) ship(raw.ship, 'ship', errors);
  if (raw.watchdog !== undefined) watchdog(raw.watchdog, 'watchdog', errors);
  if (raw.features !== undefined) features(raw.features, 'features', errors);
  if (raw.learning !== undefined) learning(raw.learning, 'learning', errors);
  if (raw.state !== undefined) state(raw.state, 'state', errors, isText(raw.baseBranch) ? raw.baseBranch : DEFAULTS.baseBranch);
  if (raw.cloud !== undefined) cloud(raw.cloud, 'cloud', errors);
  if (raw.session !== undefined) session(raw.session, 'session', errors);
  if (raw.claude !== undefined) claude(raw.claude, 'claude', errors);
  if (raw.checkRuns !== undefined) checkRuns(raw.checkRuns, 'checkRuns', errors);
  if (isObject(raw.stories) && raw.stories.adapter === 'salesforce' && raw.pack !== 'salesforce') {
    errors.push({ path: 'stories.adapter', message: '"salesforce" needs "pack": "salesforce", with the org that holds the Cases in salesforce.orgs' });
  }
  if (pack) packBlock(pack, raw[pack.name], errors, raw);

  return errors;
}
