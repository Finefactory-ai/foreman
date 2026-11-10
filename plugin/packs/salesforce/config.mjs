// The salesforce block of foreman.config.json: what it may hold (checkConfig), what the pack
// fills in from it (defaults), and the one resolved view of where each step runs (layout).
//
//   - orgs is the allow-list: alias -> { orgId, production? }. Every org is identified by its
//     org ID; the alias is only how `sf` finds it. Every alias used elsewhere must be in it, once
//     per org, and every alias in it must be used, as a build org, a stage's org or the scratch
//     dev hub, unless it is marked "production": true.
//   - a production org is marked "production": true (its server must say IsSandbox false). It
//     may be the scratch dev hub, or the target of the commands on the production allow-list
//     (prod-block.mjs). It is never a build org, a test org or a stage: deployments to
//     production are blocked.
//   - build names where stories are built: one alias, a list (a pool, one org per slot), or
//     { scratch: { devHub, definition } }. test is "build" (the slot's own org) or a stage name.
//   - stages are 1 to 4 release steps in order, each { name, org, branch? }; a stage without a
//     branch follows the previous one's, and stage 1 follows the PR target. stopAt names the
//     last stage a story goes to, the last stage by default.
//   - the stories can come from Cases in one org of the block (`stories.adapter: "salesforce"` in
//     the project's file, `stories.org` the alias): that org must be in orgs and a sandbox, and
//     it counts as used even when no step uses it. A stories org named prod/production or marked
//     "production": true is refused here, and again when the story source opens and when it polls.
//   - production is never a target: no alias or stage named prod or production, no pull
//     request or stage branch is productionBranch, no build org or stage on an org marked
//     production, and no stage on the scratch dev hub. A project's own ship.steps must run
//     sf-org-guard before sf-validate or any sf-deploy-<stage>.
//     productionBranch is optional, except when a stage has its own branch or release is gearset.
//   - only stage 1 may use a build org, and then that org is the only one and slots is 1.
//   - the project names a release path (release, stopAt) rather than a list of ship steps. The
//     sf and ci paths use COMMON_STEPS, without `ci` when a project folder is given and no
//     workflow runs on pull requests into the PR target (a PR with no check would wait out
//     ship.ci.timeoutMinutes and fail; sf-validate is the check then); the gearset path uses GEARSET_STEPS, where gearset-pr
//     follows Gearset's promotion PR in place of pr, ci, mergeable-recheck and merge.
//   - the sf path with a stage rolls back with `foreman sf rollback` (ROLLBACK_COMMAND) when a
//     step fails after its deploy; the ci and gearset paths set no rollback.
//
// It imports nothing from lib/config, which imports the pack registry: that would be a cycle.
// It reads the project's workflow files only through workflows.mjs, which imports node:path alone.
// So BRANCH is a copy of the core rule, and a test keeps the two the same.

import { pullRequestWorkflows } from './workflows.mjs';

const deepFreeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

export const BRANCH = /^(?!-)(?!\/)(?!.*\.\.)(?!.*\/$)(?!.*\.lock$)[A-Za-z0-9._/-]+$/;

export const RELEASES = ['sf', 'ci', 'gearset'];
// No NoTestRun: every deploy runs tests.
export const TEST_LEVELS = ['RunLocalTests', 'RunAllTestsInOrg', 'RunRelevantTests'];
export const OMNISTUDIO = ['auto', 'standard', 'managed', 'off'];
export const AGENTFORCE = ['auto', 'off'];
export const DESTRUCTIVE = ['ask', 'allow'];
export const PROMOTE = ['owner', 'merge'];
// Values the documentation names that are not supported yet, so the error can say so.
const LATER = { release: 'devops-center', omnistudio: 'datapacks' };

// An org ID: 00D and 12 more characters, or 15 more for the 18-character form.
export const ORG_ID = /^00D[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$/;
// An alias becomes an argument to `sf`, so it must not start with "-".
export const ALIAS = /^[A-Za-z0-9._@][A-Za-z0-9._@-]*$/;
// A name every JavaScript object already has (__proto__, constructor, toString…), or prototype:
// never an org alias, so the orgs list cannot set an object's prototype or hide its methods.
export const reservedAlias = (alias) => typeof alias === 'string' && (alias === 'prototype' || alias in Object.prototype);
// A stage name becomes part of a ship step name (sf-deploy-<stage>).
export const STAGE_NAME = /^[a-z][a-z0-9]{0,15}$/;
// A Gearset pipeline ID (a GUID in practice) goes into a Reporting API query, so only these.
export const PIPELINE_ID = /^[A-Za-z0-9-]{1,100}$/;

// The ship steps the sf and ci release paths start with. Later stories write the step modules.
export const COMMON_STEPS = deepFreeze(['sf-org-guard', 'merge-main', 'sf-delta', 'push', 'pr', 'ci', 'sf-validate', 'mergeable-recheck', 'merge']);
// The ship steps the gearset path starts with. Gearset closes the story's pull request and opens
// its own promotion PR, which gearset-pr follows. Gearset never merges the story's pull request,
// and merging the promotion PR is gearset-promote's job, so there is no merge or recheck here.
export const GEARSET_STEPS = deepFreeze(['sf-org-guard', 'merge-main', 'sf-delta', 'push', 'gearset-pr', 'sf-validate']);
// The steps each release path adds for one stage.
const STAGE_STEPS = {
  sf: (name) => [`sf-deploy-${name}`, `sf-verify-${name}`],
  ci: (name) => [`ci-deploy-watch-${name}`],
  gearset: (name) => [`gearset-promote-${name}`],
};

// The sf path's ship.rollback.command. The quotes keep the story id one word that the shell
// never expands.
export const ROLLBACK_COMMAND = 'foreman sf rollback "$FOREMAN_STORY"';
// A rollback deploy runs tests and can take 30 minutes; the core default is 300 s.
const ROLLBACK_TIMEOUT_SECONDS = 3600;

export const BLOCK_DEFAULTS = deepFreeze({
  test: 'build',
  release: 'sf',
  testLevel: { validate: 'RunLocalTests', deploy: 'RunLocalTests' },
  coverage: { floor: 75, target: 90 },
  destructive: 'ask',
  omnistudio: 'auto',
  agentforce: 'auto',
  // Foreman merges Gearset's promotion PR itself; "owner" parks the story for a Promote click.
  // gearset.pipelineId has no default: unset, every pipeline the token sees is searched.
  gearset: { promote: 'merge' },
  skills: { source: 'forcedotcom/sf-skills', tag: '1.66.0' },
});

const BLOCK_KEYS = ['productionBranch', 'orgs', 'build', 'test', 'stages', 'stopAt', 'release', 'testLevel', 'coverage', 'destructive', 'omnistudio', 'agentforce', 'gearset', 'skills'];
const STAGE_KEYS = ['name', 'org', 'branch'];
const MAX_STAGES = 4;
const NEVER = 'production is never a target';
const NO_ORG_ID = 'required: every org is identified by its org ID';
const BAD_ALIAS = 'expected an org alias: letters, digits, ".", "_", "@" or "-", not starting with "-"';
const RESERVED_ALIAS = 'not an org alias: __proto__, constructor, prototype and the like are reserved names';
const BAD_BUILD = 'expected an org alias, a list of org aliases, or { "scratch": { "devHub", "definition" } }';
const PRODUCTION = /^(prod|production)$/i;
// The keys of an old-shape block's orgs (orgs by stage), and what their values held.
const OLD_STAGES = ['build', 'qa', 'uat'];
const OLD_FIELDS = ['alias', 'pool', 'mode', 'devHub'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.length > 0;
const isBranch = (v) => typeof v === 'string' && BRANCH.test(v);
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const at = (path, key) => (path ? `${path}.${key}` : key);
const pick = (v, list, fallback) => (list.includes(v) ? v : fallback);
const id15 = (v) => v.slice(0, 15);

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

function oneOf(obj, key, list, path, errors) {
  const v = obj[key];
  if (v === undefined || list.includes(v)) return;
  const later = LATER[key] === v ? ` (${v} is not supported yet)` : '';
  errors.push({ path: at(path, key), message: `must be one of ${list.join(', ')}${later}` });
}

function text(obj, key, path, errors, { required = false } = {}) {
  const v = obj[key];
  if (v === undefined) {
    if (required) errors.push({ path: at(path, key), message: 'required' });
  } else if (!isText(v)) errors.push({ path: at(path, key), message: 'expected non-empty string' });
}

function nested(block, key, allowed, errors, check) {
  const v = block[key];
  if (v === undefined || !expectObject(v, key, errors)) return;
  noUnknownKeys(v, allowed, key, errors);
  check(v);
}

// Whether `block` is the shape this pack had before stages: orgs keyed by build, qa and uat.
function isOldShape(block) {
  if (block.stages !== undefined || block.build !== undefined || !isObject(block.orgs)) return false;
  return OLD_STAGES.some((key) => isObject(block.orgs[key]) && OLD_FIELDS.some((field) => Object.hasOwn(block.orgs[key], field)));
}

// The old-shape block written in the new shape. Pure, and never throws. The old stopAt default
// was qa, so a block with a uat stage keeps stopAt qa unless it said otherwise.
export function fromOldShape(block) {
  const b = isObject(block) ? block : {};
  const old = isObject(b.orgs) ? b.orgs : {};
  const { orgs: _old, stopAt, productionBranch, ...rest } = b;
  const orgs = {};
  const add = (org) => {
    if (!isObject(org) || !isText(org.alias)) return null;
    orgs[org.alias] = org.orgId === undefined ? {} : { orgId: org.orgId };
    return org.alias;
  };

  let build;
  const oldBuild = isObject(old.build) ? old.build : null;
  if (oldBuild?.mode === 'scratch') {
    const devHub = add(oldBuild.devHub);
    build = { scratch: { ...(devHub ? { devHub } : {}), ...(oldBuild.definition !== undefined ? { definition: oldBuild.definition } : {}) } };
  } else if (oldBuild && Array.isArray(oldBuild.pool)) {
    build = oldBuild.pool.map(add).filter((alias) => alias !== null);
  }

  const stages = [];
  for (const name of ['qa', 'uat']) {
    const org = old[name];
    const alias = add(org);
    if (alias) stages.push({ name, org: alias, ...(org.branch !== undefined ? { branch: org.branch } : {}) });
  }
  const hasUat = stages.some((s) => s.name === 'uat');

  return {
    ...(productionBranch !== undefined ? { productionBranch } : {}),
    orgs,
    ...(build !== undefined ? { build } : {}),
    stages,
    ...(hasUat ? { stopAt: stopAt ?? 'qa' } : {}),
    ...rest,
  };
}

// The resolved view of the block: where each step runs. Pure; it never throws and skips what it
// cannot read, because the guard, the doctor and the sf isolation call it at run time.
// `config` is the project's file (or the resolved config) and may be undefined.
export function layout(block, config) {
  const b = isObject(block) ? block : {};
  const cfg = isObject(config) ? config : {};

  const orgs = {};
  if (isObject(b.orgs)) {
    for (const [alias, v] of Object.entries(b.orgs)) {
      if (isText(alias) && !PRODUCTION.test(alias) && !reservedAlias(alias) && isObject(v)) {
        orgs[alias] = { orgId: isText(v.orgId) ? v.orgId : null, ...(v.production === true ? { production: true } : {}) };
      }
    }
  }
  const hasOrg = (alias) => isText(alias) && Object.hasOwn(orgs, alias);

  let build;
  if (isObject(b.build) && isObject(b.build.scratch)) {
    const { devHub, definition } = b.build.scratch;
    build = { mode: 'scratch', aliases: [], devHub: isText(devHub) ? devHub : null, definition: isText(definition) ? definition : null };
  } else {
    const list = isText(b.build) ? [b.build] : Array.isArray(b.build) ? b.build : [];
    build = { mode: 'pool', aliases: [...new Set(list.filter(isText))] };
  }

  const raw = Array.isArray(b.stages) ? b.stages : [];
  const first = isObject(raw[0]) ? raw[0] : {};
  const ship = isObject(cfg.ship) ? cfg.ship : {};
  const pr = isObject(ship.pr) ? ship.pr : {};
  const prInto = [first.branch, pr.into, cfg.baseBranch].find(isText) ?? 'main';

  const stages = [];
  let previous = prInto;
  for (const s of raw) {
    if (!isObject(s) || !isText(s.name) || !isText(s.org) || PRODUCTION.test(s.name) || PRODUCTION.test(s.org)) continue;
    const own = isText(s.branch) ? s.branch : null;
    const branch = own ?? previous;
    previous = branch;
    stages.push({
      name: s.name,
      org: s.org,
      orgId: hasOrg(s.org) ? orgs[s.org].orgId : null,
      branch,
      follows: own === null,
      shared: build.aliases.includes(s.org),
    });
  }

  const stage = (name) => stages.find((s) => s.name === name) ?? null;
  const testStage = b.test !== 'build' ? stage(b.test) : null;
  const test = testStage ? { stage: testStage.name, org: testStage.org, orgId: testStage.orgId } : { stage: null, org: null, orgId: null };

  // The build org leased to `slot`: a 1-based number, or a slot name wN.
  const slotOrg = (slot) => {
    const named = typeof slot === 'string' ? /^w([1-9]\d*)$/.exec(slot) : null;
    const n = typeof slot === 'number' ? slot : named ? Number(named[1]) : NaN;
    if (build.mode !== 'pool' || !Number.isInteger(n) || n < 1) return null;
    const alias = build.aliases[n - 1];
    return hasOrg(alias) ? { alias, orgId: orgs[alias].orgId } : null;
  };

  return {
    orgs,
    build,
    slotOrg,
    test,
    stages,
    stopAt: stage(b.stopAt)?.name ?? stages.at(-1)?.name ?? null,
    prInto,
    productionBranch: isText(b.productionBranch) ? b.productionBranch : null,
  };
}

// How many slots the block's layout allows, and why: { max, why }, or null when it sets no limit
// (scratch mode, or a block it cannot read). The settings panel checks slots against it.
export function slotLimit(block) {
  if (!isObject(block)) return null;
  const l = layout(block);
  if (l.build.mode !== 'pool' || l.build.aliases.length === 0) return null;
  const first = l.stages[0];
  if (first?.shared) return { max: 1, why: `${first.org} builds and also takes the ${first.name} releases, so one story at a time` };
  return { max: l.build.aliases.length, why: 'one slot per build org' };
}

// orgs: the allow-list. Returns nothing; refuses production names, repeated org IDs and a
// production mark that is not a boolean.
function checkOrgs(v, errors) {
  if (v === undefined) {
    errors.push({ path: 'orgs', message: 'required' });
    return;
  }
  if (!expectObject(v, 'orgs', errors)) return;
  if (Object.keys(v).length === 0) errors.push({ path: 'orgs', message: 'must not be empty' });
  const seen = new Map();
  for (const [alias, org] of Object.entries(v)) {
    const path = `orgs.${alias}`;
    if (PRODUCTION.test(alias)) {
      errors.push({ path, message: `not an org: ${alias} names production; ${NEVER}` });
      continue;
    }
    if (reservedAlias(alias)) {
      errors.push({ path, message: RESERVED_ALIAS });
      continue;
    }
    if (!ALIAS.test(alias)) {
      errors.push({ path, message: BAD_ALIAS });
      continue;
    }
    if (!expectObject(org, path, errors)) continue;
    noUnknownKeys(org, ['orgId', 'production'], path, errors);
    if (org.production !== undefined && typeof org.production !== 'boolean') errors.push({ path: at(path, 'production'), message: 'expected true or false' });
    if (org.orgId === undefined) errors.push({ path: at(path, 'orgId'), message: NO_ORG_ID });
    else if (!(typeof org.orgId === 'string' && ORG_ID.test(org.orgId))) {
      errors.push({ path: at(path, 'orgId'), message: 'expected a Salesforce org ID (00D…, 15 or 18 characters)' });
    } else if (seen.has(id15(org.orgId))) {
      errors.push({ path: at(path, 'orgId'), message: `same org as ${seen.get(id15(org.orgId))}: list each org once` });
    } else seen.set(id15(org.orgId), alias);
  }
}

// build: an alias, a list of aliases, or { scratch: { devHub, definition } }. A build org is
// never one marked production; the scratch dev hub may be.
function checkBuild(v, known, marked, errors) {
  const inOrgs = (alias, path, buildOrg = true) => {
    if (!isText(alias)) errors.push({ path, message: 'expected an org alias' });
    else if (!known(alias)) errors.push({ path, message: `${alias} is not in orgs` });
    else if (buildOrg && marked(alias)) errors.push({ path, message: `${alias} is a production org; production is never a build org` });
  };
  if (v === undefined) errors.push({ path: 'build', message: 'required' });
  else if (typeof v === 'string') inOrgs(v, 'build');
  else if (Array.isArray(v)) {
    if (v.length === 0) errors.push({ path: 'build', message: 'must not be empty' });
    const seen = new Set();
    v.forEach((alias, i) => {
      if (isText(alias) && seen.has(alias)) errors.push({ path: `build[${i}]`, message: `${alias} is listed twice` });
      else inOrgs(alias, `build[${i}]`);
      seen.add(alias);
    });
  } else if (isObject(v)) {
    noUnknownKeys(v, ['scratch'], 'build', errors);
    if (v.scratch === undefined) errors.push({ path: 'build.scratch', message: 'required' });
    else if (expectObject(v.scratch, 'build.scratch', errors)) {
      noUnknownKeys(v.scratch, ['devHub', 'definition'], 'build.scratch', errors);
      if (v.scratch.devHub === undefined) errors.push({ path: 'build.scratch.devHub', message: 'required' });
      else inOrgs(v.scratch.devHub, 'build.scratch.devHub', false);
      text(v.scratch, 'definition', 'build.scratch', errors, { required: true });
    }
  } else errors.push({ path: 'build', message: BAD_BUILD });
}

// stages: 1 to 4 { name, org, branch? }, in order, each on its own org, only the first on a
// build org, and none on an org marked production or on the scratch dev hub (`devHub`, null in
// pool mode). The test org is a stage's org, so this covers it too.
function checkStages(v, known, marked, buildAliases, devHub, errors) {
  if (v === undefined) {
    errors.push({ path: 'stages', message: 'required' });
    return;
  }
  if (!Array.isArray(v)) {
    errors.push({ path: 'stages', message: 'expected array' });
    return;
  }
  if (v.length < 1 || v.length > MAX_STAGES) errors.push({ path: 'stages', message: `must have 1 to ${MAX_STAGES} stages` });
  const names = new Set();
  const orgs = new Map();
  v.forEach((s, i) => {
    const path = `stages[${i}]`;
    if (!expectObject(s, path, errors)) return;
    noUnknownKeys(s, STAGE_KEYS, path, errors);

    if (s.name === undefined) errors.push({ path: `${path}.name`, message: 'required' });
    else if (typeof s.name === 'string' && PRODUCTION.test(s.name)) {
      errors.push({ path: `${path}.name`, message: `not a stage: ${s.name} names production; ${NEVER}` });
    } else if (!(typeof s.name === 'string' && STAGE_NAME.test(s.name))) {
      errors.push({ path: `${path}.name`, message: 'expected a stage name: a lowercase letter, then up to 15 lowercase letters or digits' });
    } else if (names.has(s.name)) errors.push({ path: `${path}.name`, message: `${s.name} is used twice` });
    else names.add(s.name);

    if (s.org === undefined) errors.push({ path: `${path}.org`, message: 'required' });
    else if (!isText(s.org)) errors.push({ path: `${path}.org`, message: 'expected an org alias' });
    else if (!known(s.org)) errors.push({ path: `${path}.org`, message: `${s.org} is not in orgs` });
    else if (marked(s.org)) errors.push({ path: `${path}.org`, message: `${s.org} is a production org; deployments to production are blocked` });
    else if (devHub && s.org === devHub) errors.push({ path: `${path}.org`, message: `${s.org} is the scratch dev hub, often a production org; ${NEVER}` });
    else if (orgs.has(s.org)) errors.push({ path: `${path}.org`, message: `same org as stage ${orgs.get(s.org)}: give each stage its own org` });
    else if (i > 0 && buildAliases.includes(s.org)) errors.push({ path: `${path}.org`, message: 'only the first stage may use a build org' });
    if (isText(s.org) && !orgs.has(s.org)) orgs.set(s.org, typeof s.name === 'string' ? s.name : `${i + 1}`);

    if (s.branch !== undefined && !isBranch(s.branch)) errors.push({ path: `${path}.branch`, message: 'expected a branch name' });
  });
}

// Every org in orgs is signed in to every session's sf home, so each must be used by a step: a
// build org, a stage's org or the scratch dev hub. Skipped when build or stages already has an
// error, which would make every org look unused, for aliases checkOrgs already refused, and for
// an org marked production, which never deploys but may be the target of the allow-listed
// commands.
function checkUnused(block, l, config, errors) {
  if (!isObject(block.orgs)) return;
  if (errors.some((e) => ['build', 'stages'].some((key) => e.path === key || e.path.startsWith(key)))) return;
  const used = new Set(l.build.aliases);
  const stories = storiesOrg(config);
  if (stories !== null) used.add(stories);
  if (l.build.mode === 'scratch' && isText(l.build.devHub)) used.add(l.build.devHub);
  for (const org of block.stages.filter(isObject).map((s) => s.org).filter(isText)) used.add(org);
  for (const alias of Object.keys(block.orgs)) {
    if (PRODUCTION.test(alias) || !ALIAS.test(alias) || used.has(alias) || l.orgs[alias]?.production === true) continue;
    errors.push({ path: `orgs.${alias}`, message: `no step uses ${alias}: list only the build orgs, the stage orgs and the scratch dev hub` });
  }
}

// The org the project's stories come from when they are Salesforce Cases, else null.
function storiesOrg(config) {
  return isObject(config) && isObject(config.stories) && config.stories.adapter === 'salesforce' && isText(config.stories.org) ? config.stories.org : null;
}

// stories.org must be an org in orgs, and a sandbox: the story source reads Cases from it.
function checkStoriesOrg(config, known, marked, errors) {
  const alias = storiesOrg(config);
  if (alias === null) return;
  if (PRODUCTION.test(alias) || marked(alias)) errors.push({ path: 'orgs', message: `stories.org ${alias} is a production org; ${NEVER}` });
  else if (!known(alias)) errors.push({ path: 'orgs', message: `stories.org ${alias} is not in salesforce.orgs: add it with its org ID` });
}

// Slots and the build orgs: one slot per build org, and a build org that is also stage 1 means
// that org alone and one slot. Matches slotLimit.
function checkSlots(block, config, l, errors) {
  if (l.build.mode !== 'pool' || l.build.aliases.length === 0) return;
  const slots = (isObject(config) ? config.slots : undefined) ?? 1;
  const count = l.build.aliases.length;
  if (Number.isInteger(slots) && slots > count) {
    errors.push({ path: 'build', message: `slots is ${slots} but there are only ${count} build orgs: each slot needs its own` });
  }
  const first = Array.isArray(block.stages) && isObject(block.stages[0]) ? block.stages[0] : null;
  if (first && isText(first.org) && l.build.aliases.includes(first.org)) {
    const only = (typeof block.build === 'string' || (Array.isArray(block.build) && block.build.length === 1)) && slots === 1;
    if (!only) errors.push({ path: 'stages[0].org', message: `${first.org} is a build org: then build must be only ${first.org} and slots 1` });
  }
}

// No pull request and no stage branch may be productionBranch, and it is required when a stage
// has its own branch or release is gearset. `config` is the project's file as written; without
// one, only the stage branches can be checked.
function checkProduction(block, config, errors) {
  const stages = Array.isArray(block.stages) ? block.stages.filter(isObject) : [];
  const production = block.productionBranch;
  if (production === undefined) {
    if (stages.some((s) => s.branch !== undefined) || block.release === 'gearset') {
      errors.push({ path: 'productionBranch', message: 'required when a stage has its own branch or release is "gearset"' });
    }
    return;
  }
  if (!isBranch(production)) {
    errors.push({ path: 'productionBranch', message: 'expected a branch name' });
    return;
  }
  (Array.isArray(block.stages) ? block.stages : []).forEach((s, i) => {
    if (isObject(s) && s.branch === production) {
      errors.push({ path: `stages[${i}].branch`, message: 'must not be productionBranch: nothing merges into production' });
    }
  });
  if (!isObject(config)) return;
  // A file's own ship replaces the pack's as a whole, pr.into included.
  const ship = config.ship !== undefined ? config.ship : defaults(block).ship;
  const into = isObject(ship) && isObject(ship.pr) ? ship.pr.into : undefined;
  const effective = into ?? config.baseBranch ?? 'main';
  if (layout(block, config).prInto === production || effective === production) {
    errors.push({
      path: 'productionBranch',
      message: `pull requests would merge into ${production}, the production branch; set salesforce.stages[0].branch or ship.pr.into to another branch`,
    });
  }
}

// A project's own ship.steps must run sf-org-guard before the first real Salesforce run
// (sf-validate or any sf-deploy-<stage>). Without a ship of its own, the pack's COMMON_STEPS or
// GEARSET_STEPS apply, and both start with it: a file's own ship replaces the pack's as a whole.
function checkGuardFirst(config, errors) {
  if (!isObject(config) || !isObject(config.ship) || !Array.isArray(config.ship.steps)) return;
  const steps = config.ship.steps.filter((s) => typeof s === 'string');
  const first = steps.findIndex((s) => s === 'sf-validate' || s.startsWith('sf-deploy-'));
  if (first === -1) return;
  const guard = steps.indexOf('sf-org-guard');
  if (guard === -1 || guard > first) {
    errors.push({
      path: '',
      message: `ship.steps runs ${steps[first]} without sf-org-guard ahead of it; put sf-org-guard first: it checks every org is an allow-listed sandbox, and production is never a target`,
    });
  }
}

// Gearset promotes environment branches: every stage needs one, on an org no slot builds in.
function checkGearset(block, buildAliases, errors) {
  if (block.release !== 'gearset' || !Array.isArray(block.stages)) return;
  block.stages.forEach((s, i) => {
    if (!isObject(s)) return;
    if (s.branch === undefined) errors.push({ path: `stages[${i}].branch`, message: 'required for release "gearset"' });
    if (isText(s.org) && buildAliases.includes(s.org)) {
      errors.push({ path: `stages[${i}].org`, message: 'release "gearset" needs a stage org that is not a build org' });
    }
  });
}

// The errors in the project's salesforce block, with paths relative to it. `config` is the
// project's file as written, and may be undefined. Never throws.
export function checkConfig(block, config) {
  if (block === undefined) return [{ path: '', message: 'required: the salesforce block (orgs, build, stages)' }];
  if (!isObject(block)) return [{ path: '', message: 'expected object' }];
  if (isOldShape(block)) {
    return [{
      path: '',
      message: `the salesforce block has the old shape (orgs by stage); write it like this instead:\n${JSON.stringify(fromOldShape(block), null, 2)}`,
    }];
  }
  const errors = [];
  noUnknownKeys(block, BLOCK_KEYS, '', errors);

  const known = (alias) => isObject(block.orgs) && Object.hasOwn(block.orgs, alias);
  const marked = (alias) => known(alias) && isObject(block.orgs[alias]) && block.orgs[alias].production === true;
  const l = layout(block, config);
  checkOrgs(block.orgs, errors);
  checkBuild(block.build, known, marked, errors);
  checkStages(block.stages, known, marked, l.build.aliases, l.build.mode === 'scratch' ? l.build.devHub : null, errors);
  checkUnused(block, l, config, errors);
  checkStoriesOrg(config, known, marked, errors);
  checkSlots(block, config, l, errors);
  checkProduction(block, config, errors);
  checkGuardFirst(config, errors);
  oneOf(block, 'release', RELEASES, '', errors);
  checkGearset(block, l.build.aliases, errors);

  const names = (Array.isArray(block.stages) ? block.stages : []).filter((s) => isObject(s) && isText(s.name)).map((s) => s.name);
  if (block.test !== undefined && block.test !== 'build' && !names.includes(block.test)) {
    errors.push({ path: 'test', message: `must be "build" or a stage name (${names.join(', ')})` });
  }
  if (block.stopAt !== undefined && !names.includes(block.stopAt)) {
    errors.push({ path: 'stopAt', message: `must name a stage (${names.join(', ')}); ${NEVER}` });
  }

  nested(block, 'testLevel', ['validate', 'deploy'], errors, (v) => {
    for (const key of ['validate', 'deploy']) oneOf(v, key, TEST_LEVELS, 'testLevel', errors);
  });
  nested(block, 'coverage', ['floor', 'target'], errors, (v) => {
    if (v.floor !== undefined && !isInt(v.floor, 75, 100)) errors.push({ path: 'coverage.floor', message: 'must be an integer from 75 to 100' });
    const floor = isInt(v.floor, 75, 100) ? v.floor : BLOCK_DEFAULTS.coverage.floor;
    if (v.target !== undefined && !isInt(v.target, floor, 100)) {
      errors.push({ path: 'coverage.target', message: `must be an integer from ${floor} to 100` });
    }
  });
  oneOf(block, 'destructive', DESTRUCTIVE, '', errors);
  oneOf(block, 'omnistudio', OMNISTUDIO, '', errors);
  oneOf(block, 'agentforce', AGENTFORCE, '', errors);
  nested(block, 'gearset', ['promote', 'pipelineId'], errors, (v) => {
    oneOf(v, 'promote', PROMOTE, 'gearset', errors);
    if (v.pipelineId !== undefined && !(typeof v.pipelineId === 'string' && PIPELINE_ID.test(v.pipelineId))) {
      errors.push({ path: 'gearset.pipelineId', message: 'expected a Gearset pipeline ID' });
    }
  });
  nested(block, 'skills', ['source', 'tag'], errors, (v) => {
    text(v, 'source', 'skills', errors);
    text(v, 'tag', 'skills', errors);
  });
  return errors;
}

// Whether the project folder shows no workflow on pull requests into the PR target. False when
// there is no folder to read or it cannot be read: then `ci` stays.
function noPullRequestCi(b, project) {
  if (!isObject(project) || typeof project.root !== 'string' || !project.fs) return false;
  const r = pullRequestWorkflows(project.root, layout(b, project.file).prInto, project.fs);
  return r.error === null && r.names.length === 0;
}

// The partial config the pack puts between Foreman's defaults and the project's file. It never
// throws, and takes only listed values from the block, so nothing else reaches a check command.
// Stage names go into step names only while they match STAGE_NAME.
// `project` is undefined, or { root, fs, file }: the project folder, a read-only fs (readdirSync
// and readFileSync) and the project's raw config. With it, `ci` is left out of the steps when no
// workflow runs on pull requests into the PR target; a folder that cannot be read keeps it.
export function defaults(block, project) {
  const b = isObject(block) ? block : {};
  const release = pick(b.release, RELEASES, BLOCK_DEFAULTS.release);
  const level = pick(isObject(b.testLevel) ? b.testLevel.validate : undefined, TEST_LEVELS, BLOCK_DEFAULTS.testLevel.validate);

  const raw = Array.isArray(b.stages) ? b.stages : [];
  const stages = [];
  for (const s of raw) {
    if (!isObject(s) || typeof s.name !== 'string' || !STAGE_NAME.test(s.name)) break;
    stages.push(s);
  }
  const stopAt = stages.some((s) => s.name === b.stopAt) ? b.stopAt : stages.at(-1)?.name;
  const upTo = stages.slice(0, stages.findIndex((s) => s.name === stopAt) + 1);
  const firstBranch = isObject(raw[0]) && isBranch(raw[0].branch) ? raw[0].branch : undefined;
  const keepBranch = release === 'gearset' || upTo.slice(1).some((s) => isText(s.branch));

  const base = release === 'gearset' ? GEARSET_STEPS : COMMON_STEPS;
  const steps = release !== 'gearset' && noPullRequestCi(b, project) ? base.filter((s) => s !== 'ci') : base;

  // No OmniStudio builder ships yet, so OmniStudio work goes to `developer` whatever `salesforce.omnistudio` says; a later change adds the builder together with its agent.
  const builders = {
    admin: { agent: 'foreman:sf-admin', use: 'declarative work only: objects, fields, Flows, validation rules, permission sets, layouts' },
    developer: { agent: 'foreman:sf-developer', use: 'any story with Apex or LWC, plus the metadata it needs' },
  };
  if (b.agentforce !== 'off') {
    builders.agentforce = { agent: 'foreman:sf-agentforce', use: 'Agentforce: agent bundles, their actions and the Apex or Flows behind them' };
  }

  return {
    roles: {
      architect: { agent: 'foreman:sf-architect' },
      builders,
      tester: { agent: 'foreman:sf-tester' },
      reviewers: [
        { name: 'compliance', agent: 'foreman:compliance-reviewer' },
        { name: 'security', agent: 'foreman:security-reviewer' },
        { name: 'code', agent: 'foreman:sf-code-reviewer' },
      ],
    },
    install: { run: 'npm ci', when: 'package-lock.json', creates: 'node_modules' },
    // None runs always, so `foreman doctor` never reaches an org through them.
    checks: [
      { run: `sf project deploy start --dry-run --test-level ${level} --wait 60`, when: '**/*.{cls,trigger,xml}' },
      { run: 'npm run lint --if-present', when: '**/{lwc,aura}/**' },
      { run: 'npm run test:unit --if-present', when: '**/lwc/**' },
    ],
    ship: {
      steps: [...steps, ...upTo.flatMap((s) => STAGE_STEPS[release](s.name))],
      ci: { required: [] },
      ...(firstBranch ? { pr: { into: firstBranch } } : {}),
      ...(keepBranch ? { merge: { keepBranch: true } } : {}),
      ...(release === 'sf' && upTo.length > 0 ? { rollback: { command: ROLLBACK_COMMAND, timeoutSeconds: ROLLBACK_TIMEOUT_SECONDS } } : {}),
    },
    salesforce: JSON.parse(JSON.stringify(BLOCK_DEFAULTS)),
    // Build sandboxes get the sandbox-pool slot environment; scratch mode the scratch one.
    env: { adapter: layout(b).build.mode === 'scratch' ? 'scratch' : 'sandbox-pool' },
  };
}
