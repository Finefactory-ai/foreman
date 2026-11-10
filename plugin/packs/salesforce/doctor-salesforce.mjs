// The Salesforce group of `foreman doctor`. doctorChecks(config, ctx) returns the checks the
// doctor runs after its env and Jira checks, each { name, step, run } with the doctor's results
// ({ ok, level: 'error' | 'warn', detail, fix? }). `step` is the set-up step the check belongs
// to (lib/setup/steps.mjs): sf-tools (tools, plugin, telemetry), sf-layout (layout, test level,
// production branch, workflows, CONFIRM_PROD), sf-orgs (each org, the isolation, source
// tracking, baselines and Agentforce), sf-skills and sf-gearset. Every result that is not ok carries
// fix: { hint, step?, action? }, a short plain hint: the check's own when the result has none.
//
//   salesforce tools                    sf and the plugins the pack needs, at their minimum versions
//   salesforce layout                   where each step runs: the build orgs, the test org, each
//                                       stage's org and branch, the slots, each stage org that
//                                       is also a build org (shared), and each production org:
//                                       connected, deployments blocked, data changes not blocked.
//                                       Runs no sf and no git. An alias that is not a valid org
//                                       alias shows as `<invalid alias>`.
//   salesforce org <alias> (<roles>)    each org once, in order: the build orgs, each stage's,
//                                       then the rest of salesforce.orgs ("not used"). Roles are
//                                       "build", "stage <name>" and "stories" (the org the Cases
//                                       come from; it is no role for the baseline and Agentforce
//                                       checks, so an org that only holds Cases gets neither).
//                                       Signed in to the isolated sf
//                                       home, a sandbox, and the org ID the config names.
//                                       Deployments to production are blocked. An alias
//                                       not in salesforce.orgs fails without running sf. An alias
//                                       that the isolated home's `sf org list` maps to an org ID
//                                       not in salesforce.orgs, or a home that cannot be listed,
//                                       fails without any query. An org marked "production": true
//                                       is named "(production)", or "(production, scratch dev
//                                       hub)", and must be a production org with that org ID; it
//                                       has no role, so no baseline, Agentforce or source
//                                       tracking check touches it. An unmarked scratch dev hub is
//                                       not checked.
//   salesforce sf isolation             the isolated sf home the sessions use (isolation.mjs)
//                                       holds only orgs in salesforce.orgs, each a sandbox or a
//                                       production org salesforce.orgs marks, plus in scratch mode
//                                       the scratch orgs the state folder records for stories,
//                                       each naming the configured Dev Hub, which must list it
//                                       as an active scratch org
//   salesforce plugin                   the salesforce-development plugin, which Foreman turns off
//                                       for its own runs
//   salesforce source tracking <alias>  each build sandbox tracks source changes; stage-only orgs
//                                       are not checked
//   salesforce stories options          only when stories.adapter is "salesforce": the stories
//                                       options pass the story source's own check, and stories.org
//                                       is in salesforce.orgs and not a production org. When it
//                                       fails, the next two fail with "skipped: fix the stories
//                                       options first" and no Case is read
//   salesforce stories filter           the filter (stories.where, or the SOQL of stories.listView)
//                                       runs in the stories org and finds N Cases; a query the org
//                                       refuses fails with sf's message; warns "skipped" when the
//                                       org did not pass its org check
//   salesforce stories statuses         every stories.statuses value is an active Status of Case
//                                       (a near match in another case is named), and doneWhenField,
//                                       dependsOnField and ownerField are fields of Case; one
//                                       `sf sobject describe`. "none set" when there are none
//   salesforce baseline <alias> (<roles>)
//                                       each org with a role, once: what it already fails before
//                                       any story (baseline.mjs). The first run starts its local
//                                       tests without waiting and saves the run; later runs read
//                                       it until it ends, then reuse the result until
//                                       `foreman sf baseline --refresh`. A stage org with failing
//                                       tests or coverage under 75% warns that RunLocalTests
//                                       cannot pass there; a build-only org warns only on failing
//                                       tests, which the tester then reports as inherited.
//   salesforce agentforce               unless salesforce.agentforce is "off" (then ok, no sf
//                                       call): each org with a role that passed its org check
//                                       has Agentforce (GenAiPlannerDefinition, the object the
//                                       agent eval needs, can be queried) and an active Data Cloud
//                                       permission set licence. When one misses either, it turns
//                                       Agentforce off with the reason (agentforce.mjs), so the
//                                       release refuses agent bundles; when all have both, it
//                                       turns it back on. A skipped org or a failed query warns and
//                                       leaves the switch as it was.
//   salesforce test level               reads only the saved baselines: warns when
//                                       testLevel.deploy (release sf, each stage's org) or
//                                       testLevel.validate (stage 1's org) is RunLocalTests or
//                                       RunAllTestsInOrg on an org whose baseline cannot pass it
//   salesforce production branch        no pull request, and no stage's own branch, merges into
//                                       it, and it is on the remote. Unset passes as "none set"
//                                       unless a stage has its own branch or release is gearset.
//   salesforce gearset token            release gearset only: GEARSET_API_TOKEN is set in the
//                                       environment, .env.foreman or the env file. Its value is
//                                       never shown.
//   salesforce gearset branch           release gearset only: ship.merge.keepBranch is on
//   salesforce gearset merge method     release gearset only: ship.pr.mergeMethod is merge
//   salesforce gearset environments     release gearset only: each stage's org is the target org
//                                       of a Gearset environment that is not production, read
//                                       through the Gearset Reporting API (ctx.fetch), in the
//                                       pipeline salesforce.gearset.pipelineId names, or in every
//                                       pipeline when it is unset (as every Gearset check). A
//                                       rate limit or no answer only warns.
//   salesforce gearset ci job           release gearset only: each stage's Gearset environment
//                                       has a CI job (CiJobId) that is not turned off
//                                       (IsJobEnabled). A stage with no environment is left to
//                                       the environments check. A rate limit or no answer warns.
//   salesforce gearset ci tests         release gearset only: Gearset's newest successful deploy
//                                       to each stage in the last 30 days ran Apex tests, read
//                                       from the Reporting API and the deploy's DeployRequest in
//                                       the stage's org. No tests warns: the CI job has no test
//                                       level, and only sf-validate's run before each merge tests
//                                       the change. A deploy ID that is not a deploy job ID is
//                                       never put in a query. Never fails, only warns. Its result
//                                       also carries stages: [{ name, state, tests }], state ran,
//                                       none, no-deploy or unknown, for the Set up screen: the
//                                       Gearset API shows no CI job's test level, so a stage it
//                                       cannot show is confirmed there by the owner.
//   salesforce workflows                every release path: no .github/workflows file that runs
//                                       on push to the PR target or a stage branch deploys to an
//                                       org not in salesforce.orgs, or to a target it cannot
//                                       read (workflows.mjs). Reads files only; the detail names
//                                       only the file and the branch.
//   salesforce ci                       every release path: ok when a workflow runs on pull
//                                       requests into the PR target (the file names are the
//                                       detail) or when none does and ship.steps has no ci;
//                                       warns when ship.steps names ci with no such workflow
//                                       (the ci step would wait ship.ci.timeoutMinutes, then fail
//                                       every release), or when the folder cannot be read.
//                                       Reads files only.
//   salesforce skills lock              skills-lock.json pins the skills from the configured source
//                                       at the configured tag, and each one is installed in
//                                       .agents/skills, linked from .claude/skills and unchanged
//   salesforce skills named             every skill a Foreman agent in the roles names in its
//                                       `skills:` frontmatter is in skills-lock.json
//   salesforce telemetry                the Salesforce CLI does not send telemetry
//   salesforce CONFIRM_PROD             nothing confirms a production deploy for Foreman
//
// toolsCheck(b, sh) is the first of them on its own, for `foreman cloud doctor`, which runs it
// on the runner when the pack is on.
//
// `config` is the resolved config with the merged block at config.salesforce; the orgs, stages and
// branches are read through layout() in config.mjs. Every sf call goes through runSf (sf.mjs), with
// each configured value as its own argument. The org, isolation and source tracking checks run sf
// in the isolated sf home, so they check the logins the sessions will see; the tools and telemetry
// checks run it as the owner. A detail names only aliases, org IDs, branch names, versions,
// variable names, skill names, agent names, test names, coverage percentages, dates, test run IDs
// and the isolated sf home's path: never a variable's value, never a file's contents, never a
// username, and never anything from an sf result but the fields read here. The skills lock check
// fails, without naming the source, when salesforce.skills.source holds a user name or token (see
// hasCredentials in skills.mjs).

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { ALIAS, BLOCK_DEFAULTS, BRANCH, RELEASES, TEST_LEVELS, layout } from './config.mjs';
import { LIST_LIMIT, SF_TIMEOUT_MS, caseDescribe, listQuery, listViewTail, whereTail } from './cases.mjs';
import { checkOptions as checkStoriesOptions } from '../../lib/adapters/stories/salesforce.mjs';
import { coolingDown, isNotSignedIn, isUnreachable, runSf } from './sf.mjs';
import { SF_PLUGIN, activeScratchQuery, aliasStray, binDir, findRealSf, homeProblem, homeVerdict, isolatedSh, listOrgs, sfHome } from './isolation.mjs';
import { parsePluginList } from '../../lib/engine/plugin-list.mjs';
import { CREDENTIALS_REASON, SKILL_NAME, hasCredentials, hashSkillDir, namedSkills, readLock } from './skills.mjs';
import { SUCCESSFUL, TOKEN_VAR, environmentFor, gearsetDeployments, gearsetEnvironments, gearsetToken } from './gearset.mjs';
import { JOB_ID } from './deploy-result.mjs';
import { pullRequestCiCheck, workflowsCheck } from './workflows.mjs';
import { CANNOT_PASS, advanceBaseline, describe as describeProblems, problemsOf, readBaseline, startBaseline, writeBaseline } from './baseline.mjs';
import { stateDir } from '../../lib/engine/paths.mjs';
import { readScratchOrgs } from './scratch-orgs.mjs';
import { writeAgentforceSwitch } from './agentforce.mjs';
import { foremanEnvName, foremanFileKeys } from '../../lib/engine/foreman-keys.mjs';

const ok = (detail = '') => ({ ok: true, level: 'error', detail });
const fail = (detail, fix) => ({ ok: false, level: 'error', detail, ...(fix ? { fix } : {}) });
const warn = (detail, fix) => ({ ok: false, level: 'warn', detail, ...(fix ? { fix } : {}) });

// The fix a result that is not ok gets when it says nothing more itself.
const withHint = (r, fix) => (r && r.ok === false && !r.fix?.hint ? { ...r, fix: { ...fix, ...(r.fix ?? {}) } } : r);
const SIGN_IN = { hint: "sign the org in to Foreman's sf home" };
const SKILLS = { action: 'sf-skills', hint: 'run `foreman sf skills`' };
const AFTER_ORG = { step: 'sf-orgs', hint: 'get the org check passing first' };
const AGAIN = { hint: 'run `foreman doctor` again when the tests finish' };

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.length > 0;
// An alias as the layout detail shows it: anything that fails ALIAS is never printed as written.
const shownAlias = (alias) => (typeof alias === 'string' && ALIAS.test(alias) ? alias : '<invalid alias>');

export const MIN_VERSIONS = Object.freeze({
  '@salesforce/cli': '2.0.0',
  'sfdx-git-delta': '6.0.0',
  '@salesforce/plugin-code-analyzer': '5.0.0',
});
const AGENT_PLUGIN = '@salesforce/plugin-agent';

const ORG_QUERY = 'SELECT Id, IsSandbox FROM Organization';
const TRACKING_QUERY = 'SELECT Id FROM SourceMember LIMIT 1';
const TRACKING_OFF = /INVALID_TYPE|SourceMember.*not supported/i;
const AGENTFORCE_QUERY = 'SELECT Id FROM GenAiPlannerDefinition LIMIT 1';
const DATA_CLOUD_QUERY = "SELECT DeveloperName FROM PermissionSetLicense WHERE Status = 'Active' AND (DeveloperName LIKE 'GenieDataPlatform%' OR MasterLabel = 'Data Cloud')";
const NO_AGENTFORCE = /INVALID_TYPE|not supported/i;
const AGENTFORCE_FIX = { hint: 'turn on Agentforce and Data Cloud in that org, then run the doctor again' };
const GIT_TIMEOUT_MS = 30_000;
const MAX_NAMED = 5;
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const AGENT_NAME = /^[a-z0-9-]+$/;
const RERUN = 'run `foreman sf skills`';

const named = (names) => `${names.slice(0, MAX_NAMED).join(', ')}${names.length > MAX_NAMED ? ` and ${names.length - MAX_NAMED} more` : ''}`;

const numbers = (version) => {
  const m = String(version ?? '').trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return m ? [m[1], m[2] ?? '0', m[3] ?? '0'].map(Number) : null;
};

// True when `version` is at least `min`, comparing major.minor.patch as numbers. A pre-release
// suffix ("5.0.0-beta.3") is ignored; a version that is not a number is never enough.
export function atLeast(version, min) {
  const a = numbers(version);
  const b = numbers(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

// What the doctor checks, read once from layout(): the build orgs, and every org once with its
// roles, each { alias, orgId, inOrgs, roles, production?, stories? }: the build orgs, then each
// stage's, then the rest of salesforce.orgs. production: true marks an org salesforce.orgs marks
// that has no role (checkConfig refuses one with a role). stories: true marks the org the Cases
// come from, which is no role. The scratch dev hub is left out unless it is marked. Scratch mode
// has no build orgs yet. Exported for the Set up screen's org rows (lib/setup/salesforce.mjs
// current), which list the orgs in the same order as the org checks.
export function planOf(b, config) {
  const l = layout(b, config);
  const orgs = new Map();
  const add = (alias, role) => {
    if (!orgs.has(alias)) {
      orgs.set(alias, { alias, orgId: l.orgs[alias]?.orgId ?? null, inOrgs: Object.hasOwn(l.orgs, alias), roles: [] });
    }
    if (role) orgs.get(alias).roles.push(role);
  };
  for (const alias of l.build.aliases) add(alias, 'build');
  for (const s of l.stages) add(s.org, `stage ${s.name}`);
  const devHub = l.build.mode === 'scratch' ? l.build.devHub : null;
  for (const [alias, org] of Object.entries(l.orgs)) if (alias !== devHub || org.production === true) add(alias, null);
  // The org the stories come from is checked like any other, but it is no role: the baseline and
  // Agentforce checks skip an org that only holds Cases.
  const stories = isObject(config?.stories) && config.stories.adapter === 'salesforce' && isText(config.stories.org) ? config.stories.org : null;
  if (stories !== null) {
    add(stories, null);
    orgs.get(stories).stories = true;
  }
  for (const org of orgs.values()) if (l.orgs[org.alias]?.production === true && org.roles.length === 0) org.production = true;
  return {
    scratch: l.build.mode === 'scratch',
    devHub,
    build: l.build.aliases.map((alias) => orgs.get(alias)),
    orgs: [...orgs.values()],
    // The branches pull requests merge into: the stages' own, not the ones they follow.
    branches: l.stages.filter((s) => !s.follows).map((s) => s.branch),
    layout: l,
  };
}

// Where each step runs, in one line of aliases, branches and counts.
function layoutCheck(cfg, plan) {
  const l = plan.layout;
  const parts = [];
  if (plan.scratch) parts.push(`build scratch orgs from ${plan.devHub == null ? 'no dev hub' : shownAlias(plan.devHub)}`);
  else parts.push(`build ${l.build.aliases.length ? l.build.aliases.map(shownAlias).join(', ') : 'none'}`);
  parts.push(l.test.org ? `test ${shownAlias(l.test.org)} (stage ${l.test.stage})` : "test the slot's build org");
  for (const s of l.stages) parts.push(`stage ${s.name} ${shownAlias(s.org)} on ${s.branch}`);
  const slots = Number.isInteger(cfg.slots) ? cfg.slots : 1;
  parts.push(`${slots} ${slots === 1 ? 'slot' : 'slots'}`);
  for (const s of l.stages) if (s.shared) parts.push(`${shownAlias(s.org)} is shared: what is in it is not only shipped work`);
  for (const org of plan.orgs) if (org.production) parts.push(`production ${shownAlias(org.alias)}: connected; deployments blocked, data changes not blocked`);
  return ok(parts.join('; '));
}

// ctx.env over Foreman's keys in .env.foreman (foremanFileKeys: registry names only) over the
// project's env file. A file that is missing or cannot be read counts as empty.
function projectEnv(config, ctx) {
  let fromFile = {};
  try {
    fromFile = parseEnv(String(ctx.fs.readFileSync(path.join(ctx.root, config.envFile ?? '.env.local'), 'utf8')));
  } catch {
    fromFile = {};
  }
  return { ...fromFile, ...foremanFileKeys({ root: ctx.root, config, fs: ctx.fs }), ...(isObject(ctx.env) ? ctx.env : {}) };
}

export function toolsCheck(b, sh) {
  const r = runSf(sh, ['plugins', '--core']);
  if (!r.ok && r.error.name === 'SfNotFound') return fail('sf is not on PATH; install the Salesforce CLI');
  if (!r.ok) return fail(`could not read \`sf plugins --core\`: ${r.error.message}`);
  if (!Array.isArray(r.result)) return fail('could not read the plugin list from `sf plugins --core`');
  const versions = new Map();
  for (const entry of r.result) {
    if (isObject(entry) && isText(entry.name) && !versions.has(entry.name)) versions.set(entry.name, String(entry.version ?? ''));
  }
  const problems = [];
  for (const [name, min] of Object.entries(MIN_VERSIONS)) {
    if (!versions.has(name)) problems.push(`${name} missing`);
    else if (!atLeast(versions.get(name), min)) problems.push(`${name} ${versions.get(name)} < ${min}`);
  }
  if (problems.length) return fail(problems.join(', '));
  if (b.agentforce !== 'off' && !versions.has(AGENT_PLUGIN)) {
    return warn(`${AGENT_PLUGIN} missing; Agentforce work needs it (or set salesforce.agentforce to "off")`);
  }
  return ok(`@salesforce/cli ${versions.get('@salesforce/cli')}`);
}

// What the org check makes of the Organization query for `org`: ok only for a signed-in sandbox
// with the configured org ID, or, for an org marked production, a signed-in production org with
// that org ID.
function judgeOrg(org, query, home) {
  const alias = org.alias;
  const orgId = typeof org.orgId === 'string' ? org.orgId : '';
  if (!query.ok) {
    if (isNotSignedIn(query.error)) {
      const url = org.production ? 'https://login.salesforce.com' : 'https://test.salesforce.com';
      return fail(`not signed in to the isolated sf home; run \`HOME=${home} SF_USE_GENERIC_UNIX_KEYCHAIN=true sf org login jwt --alias ${alias} --username <user> --jwt-key-file <key file> --client-id <consumer key> --instance-url ${url}\``, SIGN_IN);
    }
    if (isUnreachable(query.error)) return warn(`could not reach ${alias}; its identity is not checked`, { hint: "check this machine's network, then run the doctor again" });
    return fail(`could not check ${alias}: ${query.error.message}`);
  }
  const records = isObject(query.result) && Array.isArray(query.result.records) ? query.result.records : [];
  const record = isObject(records[0]) ? records[0] : null;
  if (org.production) {
    if (record?.IsSandbox === true) return fail(`${alias} is marked "production": true in salesforce.orgs, but it is a sandbox`, { hint: `remove "production": true from ${alias} in salesforce.orgs` });
    if (record?.IsSandbox !== false) return fail(`could not check that ${alias} is a production org: its server gave no IsSandbox`);
  } else if (!record || record.IsSandbox !== true) return fail(`${alias} is not a sandbox; production is never a target`, { hint: `point ${alias} at a sandbox in salesforce.orgs` });
  const id = typeof record.Id === 'string' ? record.Id.slice(0, 15) : '';
  if (id !== orgId.slice(0, 15)) return fail(`${alias} is org ${id}, not ${orgId}`, { hint: `fix the org ID of ${alias} in salesforce.orgs, or sign the right org in` });
  return ok(org.production ? 'production (connected; deployments blocked)' : `sandbox ${orgId}`);
}

function productionBranchCheck(config, b, plan, ctx) {
  const production = b.productionBranch;
  const target = config.ship?.pr?.into ?? config.baseBranch ?? 'main';
  if (!isText(production)) {
    if (plan.branches.length || b.release === 'gearset') {
      return fail('salesforce.productionBranch is not set; it is needed when a stage has its own branch or release is "gearset"');
    }
    return ok(`none set: pull requests go into ${target}`);
  }
  if (!BRANCH.test(production)) return fail('salesforce.productionBranch is not a branch name');
  if ([target, ...plan.branches].includes(production)) {
    return fail(`pull requests would merge into ${production}, the production branch`);
  }
  const remote = isText(config.remote) ? config.remote : 'origin';
  if (remote.startsWith('-')) return warn(`could not check ${remote}`);
  const r = ctx.sh('git', ['ls-remote', '--heads', remote, production], { cwd: ctx.root, timeout: GIT_TIMEOUT_MS }) ?? {};
  if (r.status !== 0) return warn(`could not check ${remote}`);
  if (!String(r.stdout ?? '').trim()) return warn(`${production} is not a branch on ${remote}; check salesforce.productionBranch`);
  return ok(`${production}; pull requests go into ${target}`);
}

const isDir = (fs, p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function skillsLockCheck(b, ctx) {
  const skills = isObject(b.skills) ? b.skills : {};
  if (hasCredentials(skills.source)) return fail(CREDENTIALS_REASON, { hint: 'take the user name or token out of salesforce.skills.source' });
  const read = readLock(ctx.root, ctx.fs);
  if (read.missing) return warn(`no skills-lock.json; the pack's agents need ${skills.source} at tag ${skills.tag}`, SKILLS);
  if (read.error) return fail(read.error);
  const { lock } = read;
  if (!isObject(lock.skills) || Object.keys(lock.skills).length === 0) return fail('skills-lock.json lists no skills');
  const names = Object.keys(lock.skills);
  const others = names.filter((name) => !isObject(lock.skills[name]) || lock.skills[name].source !== skills.source);
  if (others.length) return fail(`not from ${skills.source}: ${named(others)}`);

  const refs = [...new Set(names.map((name) => lock.skills[name].ref).filter((ref) => ref !== undefined && ref !== skills.tag))];
  if (refs.length) return fail(`skills-lock.json is at tag ${named(refs.map(String))}, salesforce.skills.tag is ${skills.tag}; ${RERUN}`);

  const agentsDir = (name) => path.join(ctx.root, '.agents', 'skills', name);
  const claudeDir = (name) => path.join(ctx.root, '.claude', 'skills', name);
  const absent = names.filter((name) => !SKILL_NAME.test(name) || (!isDir(ctx.fs, agentsDir(name)) && !isDir(ctx.fs, claudeDir(name))));
  if (absent.length) return fail(`not installed: ${named(absent)}; ${RERUN}`);
  const unlinked = names.filter((name) => !isDir(ctx.fs, claudeDir(name)));
  if (unlinked.length) return fail(`not in .claude/skills: ${named(unlinked)}; ${RERUN}`);

  const changed = names.filter((name) => {
    const dir = isDir(ctx.fs, agentsDir(name)) ? agentsDir(name) : claudeDir(name);
    try {
      return hashSkillDir(dir, ctx.fs) !== lock.skills[name].computedHash;
    } catch {
      return true;
    }
  });
  if (changed.length) return fail(`changed since install: ${named(changed)}; ${RERUN} to restore them`);
  return ok(`${names.length} skills from ${skills.source}`);
}

// The `agent` of every role in the resolved config.
function roleAgents(config) {
  const roles = isObject(config.roles) ? config.roles : {};
  const agentOf = (role) => (isObject(role) && typeof role.agent === 'string' ? [role.agent] : []);
  return [
    ...agentOf(roles.architect),
    ...(isObject(roles.builders) ? Object.values(roles.builders).flatMap(agentOf) : []),
    ...agentOf(roles.tester),
    ...(Array.isArray(roles.reviewers) ? roles.reviewers.flatMap(agentOf) : []),
  ];
}

function skillsNamedCheck(config, ctx) {
  const agentsDir = path.join(isText(ctx.sourceRoot) ? ctx.sourceRoot : PLUGIN_ROOT, 'agents');
  const agents = [...new Set(roleAgents(config)
    .filter((agent) => agent.startsWith('foreman:'))
    .map((agent) => agent.slice('foreman:'.length))
    .filter((rest) => AGENT_NAME.test(rest)))];
  const pairs = [];
  for (const agent of agents) {
    let text;
    try {
      text = String(ctx.fs.readFileSync(path.join(agentsDir, `${agent}.md`), 'utf8'));
    } catch {
      continue;
    }
    for (const skill of namedSkills(text)) pairs.push({ agent, skill });
  }
  if (!pairs.length) return ok('no pack agent names a skill');
  const unique = new Set(pairs.map((p) => p.skill)).size;
  const read = readLock(ctx.root, ctx.fs);
  if (read.missing) return fail(`pack agents name ${unique} skills but skills-lock.json is missing; ${RERUN}`);
  if (read.error) return fail(`pack agents name ${unique} skills but ${read.error}; ${RERUN}`);
  const locked = isObject(read.lock.skills) ? read.lock.skills : {};
  const missing = pairs.filter((p) => !Object.hasOwn(locked, p.skill)).map((p) => `${p.agent}: ${p.skill}`);
  if (missing.length) return fail(`missing from skills-lock.json: ${named(missing)}`);
  return ok(`${unique} named skills, all in skills-lock.json`);
}

function telemetryCheck(config, env, sh) {
  if (/^(true|1)$/i.test(String(env.SF_DISABLE_TELEMETRY ?? ''))) return ok();
  if (env.DO_NOT_TRACK !== undefined && env.DO_NOT_TRACK !== '' && env.DO_NOT_TRACK !== '0') return ok();
  const r = runSf(sh, ['config', 'get', 'disable-telemetry']);
  const value = r.ok && Array.isArray(r.result) && isObject(r.result[0]) ? r.result[0].value : undefined;
  if (value === true || value === 'true') return ok();
  const envFile = config.envFile ?? '.env.local';
  return warn(`Salesforce CLI telemetry is on; set SF_DISABLE_TELEMETRY=true in ${envFile} or run \`sf config set disable-telemetry true --global\``);
}

// The isolated sf home: there, and holding only allow-listed sandboxes. `list` and `query` are
// the doctor's shared `sf org list` and Organization query, so each runs once across the checks.
// `scratch` is the state folder's scratch org records, so a running story's org is no stray, and
// `hub` asks the Dev Hub which of those orgs are active scratch orgs.
function isolationCheck(b, ctx, home, list, query, scratch, hub) {
  const problem = homeProblem(ctx.env, home);
  if (problem) return fail(problem);
  if (!findRealSf(ctx.env, ctx.fs, binDir(home))) return fail('sf is not on PATH, so Foreman cannot set up the isolated sf home; install the Salesforce CLI');
  if (!isDir(ctx.fs, home)) return warn(`the isolated sf home ${home} does not exist yet; sign each org in there (see the org checks)`, SIGN_IN);
  const verdict = homeVerdict({ home, block: b, list: list(), query, scratch, hub });
  return verdict.ok ? ok(`${home}: ${verdict.detail}`) : fail(verdict.reason);
}

function pluginCheck(sh) {
  const r = sh('claude', ['plugin', 'list']) ?? {};
  if (r.status !== 0) return warn('could not read `claude plugin list`', { hint: 'check that `claude plugin list` works in this project' });
  if (parsePluginList(r.stdout ?? '').some((p) => p.id === SF_PLUGIN && p.enabled)) {
    return warn('salesforce-development is enabled for you; Foreman turns it off for its own runs', { hint: 'nothing to do: Foreman turns the plugin off for its own runs' });
  }
  return ok();
}

function confirmProdCheck(config, env) {
  const envFile = config.envFile ?? '.env.local';
  if (Object.hasOwn(env, 'CONFIRM_PROD')) return fail(`CONFIRM_PROD is set in the environment or ${envFile}; Foreman never sets it, remove it`);
  const checks = Array.isArray(config.checks) ? config.checks : [];
  // A check's `run` and its `quick` command both count: a quick command must not slip past this.
  for (const key of ['run', 'quick']) {
    const at = checks.findIndex((c) => isObject(c) && typeof c[key] === 'string' && (c[key].includes('CONFIRM_PROD') || c[key].includes('--I-CONFIRM-PROD')));
    if (at >= 0) return fail(`checks[${at}].${key} confirms a production deploy (CONFIRM_PROD or --I-CONFIRM-PROD); Foreman never does, remove it`);
  }
  return ok();
}

const CI_DAYS = 30;
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The pipeline the project names (salesforce.gearset.pipelineId), or undefined for every one.
const pipelineOf = (b) => (isObject(b.gearset) && isText(b.gearset.pipelineId) ? b.gearset.pipelineId : undefined);

// Whether Gearset's CI jobs run Apex tests: for each stage, the newest Successful deploy in the
// last CI_DAYS days, and its NumberTestsCompleted in the stage's org. The result also carries
// stages: [{ name, state, tests }], state 'ran', 'none' (0 tests), 'no-deploy' or 'unknown',
// which the Set up screen reads.
async function gearsetCiTestsCheck(cfg, b, plan, ctx, iso) {
  const states = new Map(plan.layout.stages.map((s) => [s.name, { name: s.name, state: 'unknown', tests: null }]));
  const done = (r) => ({ ...r, stages: [...states.values()] });
  const mark = (name, state, tests = null) => states.set(name, { name, state, tests });
  const token = gearsetToken(projectEnv(cfg, ctx));
  if (!token) return done(warn(`skipped: ${TOKEN_VAR} is not set`));
  const fetch = ctx.fetch ?? globalThis.fetch;
  const sleep = typeof ctx.sleep === 'function' ? ctx.sleep : realSleep;
  const read = await gearsetEnvironments({ fetch, token, pipelineId: pipelineOf(b) });
  if (!read.ok) return done(warn(read.error));
  const now = typeof ctx.now === 'function' ? ctx.now() : new Date();
  const from = new Date(now.getTime() - CI_DAYS * 24 * 60 * 60_000);
  const validate = pick(isObject(b.testLevel) ? b.testLevel.validate : undefined, TEST_LEVELS, BLOCK_DEFAULTS.testLevel.validate);
  const warnings = [];
  const fine = [];
  for (const stage of plan.layout.stages) {
    const found = environmentFor(read.environments, stage.orgId);
    if (!found.ok) {
      warnings.push(`stage ${stage.name}: ${found.error}`);
      continue;
    }
    const env = found.environment;
    const listed = await gearsetDeployments({ fetch, token, pipelineId: env.pipelineId, environmentId: env.environmentId, from, to: now, sleep });
    if (!listed.ok) {
      warnings.push(`stage ${stage.name}: ${listed.error}`);
      continue;
    }
    const newest = listed.deployments
      .filter((d) => d.status === SUCCESSFUL && d.environmentId === env.environmentId && isText(d.salesforceDeploymentId))
      .sort((x, y) => String(y.date ?? '').localeCompare(String(x.date ?? '')))[0];
    if (!newest) {
      mark(stage.name, 'no-deploy');
      fine.push(`no Gearset deploy to ${stage.name} in the last ${CI_DAYS} days`);
      continue;
    }
    const id = newest.salesforceDeploymentId;
    const date = String(newest.date ?? '').slice(0, 10) || 'no date';
    if (!JOB_ID.test(id)) {
      warnings.push(`stage ${stage.name}: Gearset's last deploy (${date}) has a Salesforce deploy ID Foreman cannot read, so its tests were not checked (unreadable)`);
      continue;
    }
    const q = runSf(iso, ['data', 'query', '--use-tooling-api', '--query', `SELECT Id, NumberTestsCompleted FROM DeployRequest WHERE Id = '${id}'`, '--target-org', stage.org]);
    if (!q.ok) {
      warnings.push(`stage ${stage.name}: could not read deploy ${id} in ${stage.org}: ${q.error.message}`);
      continue;
    }
    const row = isObject(q.result) && Array.isArray(q.result.records) ? q.result.records.find(isObject) : null;
    const tests = row && row.NumberTestsCompleted !== null && Number.isFinite(Number(row.NumberTestsCompleted)) ? Number(row.NumberTestsCompleted) : null;
    if (tests === null) {
      warnings.push(`stage ${stage.name}: ${stage.org} shows no test count for Gearset's last deploy (${id}, ${date})`);
    } else if (tests === 0) {
      mark(stage.name, 'none', 0);
      warnings.push(`Gearset's last deploy to ${stage.name} (${id}, ${date}) ran no Apex tests; set a test level on the Gearset ${env.name} CI job. Foreman's sf-validate still runs ${validate} before each merge`);
    } else {
      mark(stage.name, 'ran', tests);
      fine.push(`${stage.name}: ${tests} Apex tests in Gearset's last deploy`);
    }
  }
  return done(warnings.length ? warn(warnings.join('; ')) : ok(fine.join('; ')));
}

// Whether each stage's Gearset environment has a CI job that is on: Gearset deploys every
// promotion through it. A stage with no environment is left to the environments check.
async function gearsetCiJobCheck(cfg, b, plan, ctx) {
  const token = gearsetToken(projectEnv(cfg, ctx));
  if (!token) return warn(`skipped: ${TOKEN_VAR} is not set`, { hint: `add ${TOKEN_VAR} first` });
  const read = await gearsetEnvironments({ fetch: ctx.fetch ?? globalThis.fetch, token, pipelineId: pipelineOf(b) });
  if (!read.ok) return read.transient ? warn(read.error, { hint: 'run the doctor again later' }) : fail(read.error);
  const problems = [];
  const fine = [];
  for (const stage of plan.layout.stages) {
    const found = environmentFor(read.environments, stage.orgId);
    if (!found.ok) continue;
    const env = found.environment;
    if (!isText(env.ciJobId)) problems.push(`stage ${stage.name}: Gearset environment ${env.name} has no CI job; Gearset deploys each promotion through it`);
    else if (env.jobEnabled === false) problems.push(`stage ${stage.name}: Gearset environment ${env.name}: its CI job is turned off; turn it on in Gearset`);
    else fine.push(`${stage.name} → ${env.name} CI job on`);
  }
  return problems.length ? fail(problems.join('; ')) : ok(fine.join(', '));
}

// The checks the gearset release path adds. The token check names Foreman's own keys file
// (.env.foreman), where the token belongs, never the value.
function gearsetChecks(cfg, b, plan, ctx, add, iso) {
  const ownFile = foremanEnvName(cfg);
  add('salesforce gearset token', 'sf-gearset', () => (gearsetToken(projectEnv(cfg, ctx))
    ? ok(`${TOKEN_VAR} is set`)
    : fail(`${TOKEN_VAR} is not set in ${ownFile}; create a Gearset API access token (My account → Team security → Access token management) and add it`)), { hint: `add ${TOKEN_VAR} to ${ownFile}` });
  add('salesforce gearset branch', 'sf-gearset', () => (cfg.ship?.merge?.keepBranch === true
    ? ok()
    : fail('ship.merge.keepBranch is off; Gearset needs the story branch until the last stage and back-propagation')), { hint: 'turn on ship.merge.keepBranch in foreman.config.json' });
  add('salesforce gearset merge method', 'sf-gearset', () => {
    const method = cfg.ship?.pr?.mergeMethod ?? 'merge';
    return method === 'merge' ? ok() : fail(`ship.pr.mergeMethod is ${method}; Gearset supports merge commits only`);
  }, { hint: 'set ship.pr.mergeMethod to merge in foreman.config.json' });
  add('salesforce gearset environments', 'sf-gearset', async () => {
    const token = gearsetToken(projectEnv(cfg, ctx));
    if (!token) return warn(`skipped: ${TOKEN_VAR} is not set`, { hint: `add ${TOKEN_VAR} first` });
    const read = await gearsetEnvironments({ fetch: ctx.fetch ?? globalThis.fetch, token, pipelineId: pipelineOf(b) });
    if (!read.ok) return read.transient ? warn(read.error, { hint: 'run the doctor again later' }) : fail(read.error);
    const found = [];
    for (const stage of plan.layout.stages) {
      const r = environmentFor(read.environments, stage.orgId);
      if (!r.ok) return fail(`stage ${stage.name} (${stage.org}): ${r.error}`);
      found.push(`stage ${stage.name} → Gearset ${r.environment.name}`);
    }
    return ok(found.join(', '));
  }, { hint: 'make each stage org a Gearset environment that is not production, and check the token' });
  add('salesforce gearset ci job', 'sf-gearset', () => gearsetCiJobCheck(cfg, b, plan, ctx), { hint: "turn on the CI job of each stage's Gearset environment" });
  add('salesforce gearset ci tests', 'sf-gearset', () => gearsetCiTestsCheck(cfg, b, plan, ctx, iso), { hint: 'set a test level on each Gearset CI job' });
}

const pick = (v, list, fallback) => (list.includes(v) ? v : fallback);
const REFRESH = 'run `foreman sf baseline --refresh`';
const minute = (iso) => `${String(iso).slice(0, 16).replace('T', ' ')} UTC`;

// One org's baseline: start it, follow it, or judge it. `identity` is the org check's verdict.
function baselineCheck(org, { identity, iso, dir, now }) {
  if (!identity(org).ok) return warn(`skipped: ${org.alias} did not pass its org check`, AFTER_ORG);
  try {
    let rec = readBaseline(dir, org);
    if (!rec) {
      const started = startBaseline(iso, org, now);
      if (!started.ok) return warn(`could not start the org's local tests: ${started.reason}`);
      writeBaseline(dir, started.record);
      return warn(`started the org's local tests (test run ${started.record.testRunId}) to record what already fails there; run \`foreman doctor\` again when they finish, which can take a long time`, AGAIN);
    }
    if (rec.state === 'running') {
      const next = advanceBaseline(iso, rec, now);
      if (next.record !== rec) writeBaseline(dir, next.record);
      if (next.error) return warn(`could not read test run ${rec.testRunId}: ${next.error}`);
      rec = next.record;
      if (rec.state === 'running') return warn(`the org's local tests are still running (test run ${rec.testRunId}, started ${minute(rec.startedAt)})`, AGAIN);
    }
    if (rec.state === 'aborted') return warn(`test run ${rec.testRunId} was aborted; ${REFRESH}`);
    const stage = org.roles.some((role) => role.startsWith('stage '));
    if (stage) {
      const p = problemsOf(rec);
      if (p) return warn(`${org.alias} ${describeProblems(p)}: RunLocalTests deploys there will fail whatever the story does. Use RunRelevantTests in salesforce.testLevel, or fix the org, then ${REFRESH}`);
    } else {
      const p = problemsOf(rec, { coverage: false });
      if (p) return warn(`${org.alias} ${describeProblems(p)}; the tester reports failures in these tests as inherited, not as the story's`);
    }
    const coverage = typeof rec.coverage === 'number' ? `${rec.coverage}% Apex coverage` : 'no Apex';
    return ok(`no failing tests, ${coverage}, recorded ${String(rec.finishedAt ?? rec.startedAt).slice(0, 10)}`);
  } catch (err) {
    return warn(`could not save the baseline: ${err?.message ?? err}`);
  }
}

// Whether every org with a role has Agentforce and a Data Cloud licence, and the switch to match.
function agentforceDoctorCheck(b, orgs, { identity, iso, dir, now }) {
  if (b.agentforce === 'off') return ok('off in foreman.config.json');
  const missing = [];
  const unknown = [];
  for (const org of orgs) {
    if (!identity(org).ok) {
      unknown.push(`skipped: ${org.alias} did not pass its org check`);
      continue;
    }
    const lacks = [];
    const agentforce = runSf(iso, ['data', 'query', '--query', AGENTFORCE_QUERY, '--target-org', org.alias]);
    if (!agentforce.ok) {
      if (!NO_AGENTFORCE.test(`${agentforce.error.name} ${agentforce.error.message}`)) {
        unknown.push(`could not check Agentforce in ${org.alias}: ${agentforce.error.message}`);
        continue;
      }
      lacks.push('Agentforce');
    }
    const dataCloud = runSf(iso, ['data', 'query', '--query', DATA_CLOUD_QUERY, '--target-org', org.alias]);
    if (!dataCloud.ok) {
      unknown.push(`could not check the Data Cloud licence in ${org.alias}: ${dataCloud.error.message}`);
      continue;
    }
    const rows = isObject(dataCloud.result) && Array.isArray(dataCloud.result.records) ? dataCloud.result.records.filter(isObject) : [];
    if (rows.length === 0) lacks.push('Data Cloud licence');
    if (lacks.length) missing.push(`${org.alias} (${org.roles.join(', ')}) has no ${lacks.join(' and no ')}`);
  }
  try {
    if (missing.length) {
      const reason = missing.join('; ');
      writeAgentforceSwitch(dir, { off: true, reason, at: now.toISOString() });
      return warn(`Agentforce is off: ${reason}`, AGENTFORCE_FIX);
    }
    if (unknown.length) return warn(unknown.join('; '), unknown.every((u) => u.startsWith('skipped:')) ? AFTER_ORG : undefined);
    writeAgentforceSwitch(dir, null);
  } catch (err) {
    return warn(`could not save the Agentforce switch: ${err?.message ?? err}`);
  }
  return ok(`on in ${orgs.map((o) => o.alias).join(', ')}`);
}

// The test levels against the saved baselines. It runs no sf.
function testLevelCheck(b, plan, dir) {
  const stages = plan.layout.stages;
  const levels = isObject(b.testLevel) ? b.testLevel : {};
  const pairs = [];
  if (pick(b.release, RELEASES, BLOCK_DEFAULTS.release) === 'sf') {
    const level = pick(levels.deploy, TEST_LEVELS, BLOCK_DEFAULTS.testLevel.deploy);
    for (const stage of stages) pairs.push({ key: 'testLevel.deploy', level, stage });
  }
  if (stages[0]) pairs.push({ key: 'testLevel.validate', level: pick(levels.validate, TEST_LEVELS, BLOCK_DEFAULTS.testLevel.validate), stage: stages[0] });

  const clauses = [];
  const none = [];
  for (const { key, level, stage } of pairs) {
    if (!CANNOT_PASS.includes(level)) continue;
    const rec = readBaseline(dir, { alias: stage.org, orgId: stage.orgId });
    if (rec?.state !== 'done') {
      if (!none.includes(stage.org)) none.push(stage.org);
      continue;
    }
    const p = problemsOf(rec);
    if (p) clauses.push(`${key} is ${level}, but ${stage.org} (stage ${stage.name}) ${describeProblems(p)}, so it cannot pass there`);
  }
  if (clauses.length) return warn(`${clauses.join('; ')}; set it to RunRelevantTests, or fix the org`);
  return ok(none.length ? `no baseline yet for ${none.join(', ')}` : '');
}

const PRODUCTION_NAME = /^(prod|production)$/i;
const SKIPPED_OPTIONS = 'skipped: fix the stories options first';
const STORIES_OPTIONS_FIX = { hint: 'fix the stories block in foreman.config.json, and the stories org in salesforce.orgs' };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The stories options as the story source would take them, and the rules about the org: it is in
// salesforce.orgs, and it is not production. Returns the options (without `adapter`) when fine.
function storiesOptions(cfg, b) {
  const { adapter: _adapter, ...options } = cfg.stories;
  try {
    checkStoriesOptions(options);
  } catch (err) {
    return { error: err.message };
  }
  if (!isObject(b.orgs) || !Object.hasOwn(b.orgs, options.org)) return { error: `stories.org: ${options.org} is not in salesforce.orgs` };
  if (PRODUCTION_NAME.test(options.org) || (isObject(b.orgs[options.org]) && b.orgs[options.org].production === true)) {
    return { error: `stories.org: ${options.org} is a production org; Foreman reads stories only from a sandbox` };
  }
  return { options };
}

// The Cases source: its options, its filter and its status names. Nothing here is read until the
// options pass, and nothing but the filter's Case Ids and the names of Case's fields comes back
// from an org; a detail names no username and no token.
function storiesChecks(cfg, b, plan, add, { identity, iso, clock }) {
  const checked = storiesOptions(cfg, b);
  const entry = checked.options ? plan.orgs.find((o) => o.alias === checked.options.org) : null;
  const skipped = (alias) => warn(`skipped: ${alias} did not pass its org check`, AFTER_ORG);

  add('salesforce stories options', 'sf-orgs', () => (checked.error ? fail(checked.error) : ok(`Cases in ${checked.options.org}`)), STORIES_OPTIONS_FIX);

  add('salesforce stories filter', 'sf-orgs', () => {
    if (checked.error || !entry) return fail(SKIPPED_OPTIONS);
    const { options } = checked;
    if (!identity(entry).ok) return skipped(options.org);
    let tail;
    if (options.where !== undefined) tail = whereTail({ where: options.where, orderBy: options.orderBy });
    else {
      const view = listViewTail(iso, options.org, options.listView);
      if (!view.ok) return fail(`the list view could not be read in ${options.org}: ${view.error}`);
      tail = view.tail;
    }
    const r = runSf(iso, ['data', 'query', '--query', listQuery({ fields: ['Id', 'CaseNumber'], tail }), '--target-org', options.org], { timeoutMs: SF_TIMEOUT_MS, now: clock() });
    if (!r.ok) return fail(`the filter did not run in ${options.org}: ${r.error.message}`);
    const n = isObject(r.result) && Array.isArray(r.result.records) ? r.result.records.length : 0;
    return ok(`finds ${plural(n, 'Case')}${n >= LIST_LIMIT ? ` (Foreman reads the first ${LIST_LIMIT})` : ''}`);
  }, { hint: 'fix stories.where (or the list view) so it runs in the stories org' });

  add('salesforce stories statuses', 'sf-orgs', () => {
    if (checked.error || !entry) return fail(SKIPPED_OPTIONS);
    const { options } = checked;
    const statuses = Object.entries(options.statuses ?? {});
    const fields = [['doneWhenField', options.doneWhenField], ['dependsOnField', options.dependsOnField], ['ownerField', options.ownerField]].filter(([, name]) => name !== undefined);
    if (!statuses.length && !fields.length) return ok('none set');
    if (!identity(entry).ok) return skipped(options.org);
    const d = caseDescribe(iso, options.org);
    if (!d.ok) return fail(`could not read the fields and Status values of Case in ${options.org}: ${d.error}`);
    const problems = [];
    for (const [event, name] of statuses) {
      if (d.statuses.includes(name)) continue;
      const near = d.statuses.find((v) => v.toLowerCase() === name.toLowerCase());
      problems.push(`statuses.${event} "${name}" is not an active Case Status${near ? ` (did you mean "${near}"?)` : ''}`);
    }
    for (const [key, name] of fields) if (!d.fields.has(name)) problems.push(`${key} ${name} is not a field of Case`);
    if (problems.length) return fail(problems.join('; '));
    return ok([statuses.length ? plural(statuses.length, 'Status name') : '', fields.length ? plural(fields.length, 'field') : ''].filter(Boolean).join(', '));
  }, { hint: 'use a Status that Case has and active, and fields that exist on Case' });
}

export function doctorChecks(config, ctx) {
  const cfg = isObject(config) ? config : {};
  const b = isObject(cfg.salesforce) ? cfg.salesforce : {};
  const sh = ctx.sh;
  const env = isObject(ctx.env) ? ctx.env : {};
  const homedir = ctx.homedir ?? os.homedir();
  const home = sfHome(env, homedir);
  const iso = isolatedSh(sh, env, home, homedir);
  const plan = planOf(b, cfg);
  const checks = [];
  // `fix` is what a result that is not ok gets when it carries no hint of its own.
  const add = (name, step, run, fix) => checks.push({
    name,
    step,
    run(c) {
      const r = run(c);
      return r && typeof r.then === 'function' ? r.then((x) => withHint(x, fix)) : withHint(r, fix);
    },
  });

  // The doctor's clock, which also decides whether an org is still cooling down.
  const clock = () => (typeof ctx.now === 'function' ? ctx.now() : Date.now());
  // One Organization query per target, in the isolated sf home, shared by the org, isolation and
  // source tracking checks.
  const queries = new Map();
  const query = (target) => {
    if (!queries.has(target)) queries.set(target, runSf(iso, ['data', 'query', '--query', ORG_QUERY, '--target-org', target], { now: clock() }));
    return queries.get(target);
  };
  // The home's `sf org list`, once per doctor run, shared by the org and isolation checks.
  let listed;
  const list = () => (listed ??= listOrgs(iso));
  const identity = (org) => {
    if (!(typeof org.alias === 'string' && ALIAS.test(org.alias))) return fail('not a valid org alias', { hint: 'use letters, digits, dots, dashes and underscores in the org alias' });
    if (!org.inOrgs) return fail(`${org.alias} is not in salesforce.orgs`, { hint: `add ${org.alias} and its org ID to salesforce.orgs` });
    // Checked before any sf call, so an org that refused logins gets none until its cool-down ends.
    const cool = coolingDown(home, org.alias, clock());
    if (cool) {
      return fail(`${org.alias} is cooling down until ${cool.until}: it answered "${cool.reason}"; Foreman makes no sf call to it until then`, { hint: 'wait for the cool-down to end; the org can lock out logins for up to an hour' });
    }
    // From the home's org list alone: an alias pointing at an org outside salesforce.orgs gets no query.
    const problem = homeProblem(env, home);
    if (problem) return fail(problem);
    const stray = aliasStray({ home, block: b, list: list(), alias: org.alias });
    if (stray) return fail(stray, { hint: "keep only the sandboxes in salesforce.orgs in Foreman's sf home" });
    return judgeOrg(org, query(org.alias), home);
  };

  add('salesforce tools', 'sf-tools', () => toolsCheck(b, sh), { hint: 'install or update the Salesforce CLI and the plugins it names' });
  add('salesforce layout', 'sf-layout', () => layoutCheck(cfg, plan), { hint: 'fix the salesforce block in foreman.config.json' });

  if (plan.scratch) {
    add('salesforce org build', 'sf-orgs', () => warn('scratch mode: build orgs are made per story and are not checked here'), { hint: 'nothing to do: each story checks the scratch org it makes' });
  }
  const rolesOf = (org) => {
    if (org.production) return org.alias === plan.devHub ? 'production, scratch dev hub' : 'production';
    const roles = [...org.roles, ...(org.stories ? ['stories'] : [])];
    return roles.length ? roles.join(', ') : 'not used';
  };
  for (const org of plan.orgs) {
    add(`salesforce org ${org.alias} (${rolesOf(org)})`, 'sf-orgs', () => identity(org), { hint: `check ${org.alias} in salesforce.orgs and its sign-in` });
  }
  const scratchOrgs = () => (typeof ctx.root === 'string' ? readScratchOrgs(stateDir(ctx.root, cfg, env)) : []);
  const hub = (ids) => activeScratchQuery(iso, layout(b).build.devHub, ids);
  add('salesforce sf isolation', 'sf-orgs', () => isolationCheck(b, { ...ctx, env }, home, list, query, scratchOrgs(), hub), { hint: "keep only the sandboxes in salesforce.orgs in Foreman's sf home" });
  add('salesforce plugin', 'sf-tools', () => pluginCheck(sh));

  for (const org of plan.build) {
    add(`salesforce source tracking ${org.alias}`, 'sf-orgs', () => {
      if (!identity(org).ok) return warn(`skipped: ${org.alias} did not pass its org check`, AFTER_ORG);
      const r = runSf(iso, ['data', 'query', '--use-tooling-api', '--query', TRACKING_QUERY, '--target-org', org.alias]);
      if (r.ok) return ok();
      if (TRACKING_OFF.test(`${r.error.name} ${r.error.message}`)) {
        return fail(`source tracking is off in ${org.alias}; turn on source tracking for Developer sandboxes in the production org's Dev Hub settings, then refresh the sandbox`, { hint: 'turn on source tracking for Developer sandboxes, then refresh the sandbox' });
      }
      return warn(`could not check: ${r.error.message}`);
    }, { hint: 'run the doctor again; if it repeats, check the org in Salesforce' });
  }

  if (cfg.stories?.adapter === 'salesforce') storiesChecks(cfg, b, plan, add, { identity, iso, clock });

  // Each org with a role once, then the test levels against what they recorded.
  const dir = () => stateDir(ctx.root, cfg, env);
  const now = () => (typeof ctx.now === 'function' ? ctx.now() : new Date());
  for (const org of plan.orgs.filter((o) => o.roles.length)) {
    add(`salesforce baseline ${org.alias} (${org.roles.join(', ')})`, 'sf-orgs', () => baselineCheck(org, { identity, iso, dir: dir(), now: now() }), {
      hint: 'fix the org or salesforce.testLevel, then run `foreman sf baseline --refresh`',
    });
  }
  const roleOrgs = plan.orgs.filter((o) => o.roles.length);
  add('salesforce agentforce', 'sf-orgs', () => agentforceDoctorCheck(b, roleOrgs, { identity, iso, dir: dir(), now: now() }), {
    hint: 'run the doctor again; if it repeats, check Agentforce and Data Cloud in the org',
  });
  add('salesforce test level', 'sf-layout', () => testLevelCheck(b, plan, dir()), { hint: 'set salesforce.testLevel to RunRelevantTests, or fix the org' });

  add('salesforce production branch', 'sf-layout', () => productionBranchCheck(cfg, b, plan, ctx), { hint: 'fix salesforce.productionBranch in foreman.config.json' });
  if (b.release === 'gearset') gearsetChecks(cfg, b, plan, ctx, add, iso);
  add('salesforce workflows', 'sf-layout', () => workflowsCheck(plan.layout, ctx), { hint: 'make the workflow deploy only to orgs in salesforce.orgs' });
  add('salesforce ci', 'sf-layout', () => pullRequestCiCheck(cfg, plan.layout, ctx), { hint: 'take ci out of ship.steps, or add a workflow that runs on pull_request' });
  add('salesforce skills lock', 'sf-skills', () => skillsLockCheck(b, ctx), SKILLS);
  add('salesforce skills named', 'sf-skills', () => skillsNamedCheck(cfg, ctx), SKILLS);
  add('salesforce telemetry', 'sf-tools', () => telemetryCheck(cfg, projectEnv(cfg, ctx), sh), { hint: `set SF_DISABLE_TELEMETRY=true in ${cfg.envFile ?? '.env.local'}` });
  add('salesforce CONFIRM_PROD', 'sf-layout', () => confirmProdCheck(cfg, projectEnv(cfg, ctx)), { hint: 'remove CONFIRM_PROD wherever it is set' });
  return checks;
}
