// The Salesforce pack. It claims a project with sfdx-project.json and reports what `foreman init`
// needs to suggest its config: the package folders, the API version, the LWC tools in
// package.json, and whether OmniStudio or Agentforce metadata is in the source. Its block, the
// config it fills in and the slot limit its layout sets are in config.mjs, its `foreman doctor`
// checks in doctor-salesforce.mjs, and its `foreman sf` command in sf-command.mjs. Its Bash
// guard, which keeps sf and sfdx calls off orgs other than the slot's, is in guard.mjs. Its
// prepareSessions hook, in isolation.mjs, gives every story session an sf home of its own that
// holds only the orgs in salesforce.orgs. Its sandbox-pool slot environment, in env/sandbox-pool.mjs,
// gives each slot its own build sandbox and cleans up after a story that did not ship. Its
// scratch slot environment, in env/scratch.mjs, makes each story a scratch org of its own
// through the Dev Hub, within the Dev Hub's limits, and deletes it once the story closes; the
// records in scratch-orgs.mjs let the isolated sf home accept that org for its story only. Its
// traits, in traits/, go before the project's own: all.md for every agent, security.md for the
// security reviewer and tester.md for the tester. Its ship steps are in steps/, and steps(config)
// gives them by name, because a deploy step is named after its stage: sf-org-guard, first in
// every release, refuses any org that is not an allow-listed sandbox and any pull request into
// productionBranch; sf-delta works out the story's delta with sfdx-git-delta and stops with
// code 10 until the owner allows its metadata deletes (deletes.mjs keeps the answer);
// sf-validate dry-runs the delta on the first stage's org before the merge; sf-deploy-<stage>
// deploys it to the first stage after the merge, and resumes a job a dead run of the same
// release left (deploy-jobs.mjs keeps it); sf-verify-<stage> then checks the org's newest deploy is
// Foreman's and runs the post-deploy checks, and its healthy() feeds `foreman health`
// (releases.mjs keeps what each stage last got). A failure after that deploy rolls stage 1 back
// through `foreman sf rollback` (rollback.mjs), the pack's ship.rollback.command, which refuses
// once a story reached a later stage. ci-deploy-watch-<stage>, on the ci release path, waits for
// the GitHub Actions run of the merge commit on the first stage's branch and confirms in its org
// that a deploy succeeded after the merge. Later stages (stage 2 on) get the same three steps;
// a later stage with a branch of its own first gets the story branch merged into that branch
// (stage-merge.mjs). Their steps are noRollback, so a failure from the first of them on halts
// and never calls the rollback: people share those orgs.
// gearset-pr, on the gearset release path, opens the pull request into the first stage's branch
// and follows the promotion PR Gearset opens in its place until Gearset's validation passes;
// gearset-promote-<stage>, for every stage, merges that stage's promotion PR and confirms
// Gearset deployed it, or parks the story for the owner's Promote click. CI jobs are listed by
// core detect, so this reads no workflow files; the doctor's workflow check,
// which refuses a workflow deploying to an org off the allow-list, is in workflows.mjs. What
// each org already fails before any story (its local tests and coverage), which the doctor
// records and sf-validate and sf-deploy read to call such a failure inherited, is in
// baseline.mjs. Its liveStage hook says which stage the release is live on, so the core watch and
// rollback steps name that stage and its org, not production. Its rolledBackAt hook gives the time
// a story's last release was rolled back, so a pull request merged before it is not called shipped.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STAGE_NAME, checkConfig, defaults, layout, slotLimit } from './config.mjs';
import { doctorChecks } from './doctor-salesforce.mjs';
import { guard } from './guard.mjs';
import { setUp } from './isolation.mjs';
import { rolledBackAt } from './releases.mjs';
import * as sandboxPool from './env/sandbox-pool.mjs';
import * as scratch from './env/scratch.mjs';
import sfCommand from './sf-command.mjs';
import sfOrgGuard from './steps/sf-org-guard.mjs';
import sfDelta from './steps/sf-delta.mjs';
import sfValidate from './steps/sf-validate.mjs';
import { sfDeploy } from './steps/sf-deploy.mjs';
import { sfVerify } from './steps/sf-verify.mjs';
import { ciDeployWatch } from './steps/ci-deploy-watch.mjs';
import gearsetPr from './steps/gearset-pr.mjs';
import { gearsetPromote } from './steps/gearset-promote.mjs';

const OMNISTUDIO_FOLDERS = ['omniScripts', 'omniIntegrationProcedures', 'omniDataTransforms', 'omniUiCard'];
const AGENTFORCE_FOLDERS = ['aiAuthoringBundles', 'bots', 'genAiPlannerBundles', 'genAiPlugins', 'genAiFunctions'];
const MAX_DEPTH = 8;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Whether `p` is `root` or inside it. A folder named "..x" is inside; "../x" is not.
function inside(root, p) {
  const rel = path.relative(root, p);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function realPath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

// The folder names found under `dir`, up to MAX_DEPTH levels down, skipping node_modules and
// dot-folders. A folder that cannot be read counts as empty. detect() only walks package folders
// inside the project: one outside it, by its path or through a symlink, is never read.
function folderNames(dir, into, depth = 1) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return into;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    into.add(entry.name);
    if (depth < MAX_DEPTH) folderNames(path.join(dir, entry.name), into, depth + 1);
  }
  return into;
}

function lwcTools(dir) {
  const pkg = readJson(path.join(dir, 'package.json'));
  if (!isObject(pkg)) return { jest: false, eslint: false, prettier: false };
  const deps = { ...(isObject(pkg.dependencies) ? pkg.dependencies : {}), ...(isObject(pkg.devDependencies) ? pkg.devDependencies : {}) };
  const scripts = isObject(pkg.scripts) ? Object.values(pkg.scripts).filter((s) => typeof s === 'string') : [];
  const has = (name) => Object.hasOwn(deps, name);
  return {
    jest: has('@salesforce/sfdx-lwc-jest') || scripts.some((s) => s.includes('sfdx-lwc-jest')),
    eslint: has('eslint') || Object.keys(deps).some((name) => name.startsWith('@salesforce/eslint-')),
    prettier: has('prettier'),
  };
}

// null when `dir` has no sfdx-project.json, else the findings. Never throws. A package folder
// outside the project is left out of the findings and never read.
export function detect(dir) {
  const root = path.resolve(dir);
  const file = path.join(dir, 'sfdx-project.json');
  if (!fs.existsSync(file)) return null;
  let project = null;
  let invalid;
  try {
    project = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isObject(project)) invalid = 'sfdx-project.json is not a JSON object';
  } catch (err) {
    invalid = err?.message ?? String(err);
  }
  if (invalid) project = {};

  const packageDirectories = (Array.isArray(project.packageDirectories) ? project.packageDirectories : [])
    .filter((d) => isObject(d) && typeof d.path === 'string' && d.path)
    .filter((d) => inside(root, path.resolve(root, d.path)))
    .map((d) => ({ path: d.path, default: d.default === true }));
  const realRoot = realPath(root) ?? root;
  const names = new Set();
  for (const d of packageDirectories) {
    const real = realPath(path.resolve(root, d.path));
    if (real !== null && inside(realRoot, real)) folderNames(real, names);
  }

  return {
    packageDirectories,
    sourceApiVersion: typeof project.sourceApiVersion === 'string' ? project.sourceApiVersion : null,
    lwc: lwcTools(dir),
    omnistudio: OMNISTUDIO_FOLDERS.some((name) => names.has(name)),
    agentforce: AGENTFORCE_FOLDERS.some((name) => names.has(name)),
    ...(invalid ? { invalid } : {}),
  };
}

// The ship steps by name for `config` (the resolved config, or undefined): the common ones
// (gearset-pr included); sf-deploy-<name>, sf-verify-<name> and ci-deploy-watch-<name> for
// every stage, those of the stages after the first marked noRollback; and gearset-promote-<name>
// for every stage, each only when the stage's name can be a step name. Every stage gets its
// promotion step, configured or not, so a park it left is still checked. Never throws.
export function steps(config) {
  const table = { 'sf-org-guard': sfOrgGuard, 'sf-delta': sfDelta, 'gearset-pr': gearsetPr, 'sf-validate': sfValidate };
  const stages = layout(config?.salesforce, config).stages;
  stages.forEach((stage, i) => {
    const n = stage.name;
    if (!STAGE_NAME.test(n)) return;
    const opts = { later: i > 0 };
    table[`sf-deploy-${n}`] = sfDeploy(n, opts);
    table[`sf-verify-${n}`] = sfVerify(n, opts);
    table[`ci-deploy-watch-${n}`] = ciDeployWatch(n, opts);
  });
  for (const stage of stages) {
    if (STAGE_NAME.test(stage.name)) table[`gearset-promote-${stage.name}`] = gearsetPromote(stage.name);
  }
  return table;
}

// The stage the release is live on, which the core watch and rollback steps name in their words
// and reasons instead of "production": { name, org }, or null when the layout has no stage. It is
// the last stage (in layout order) that a deploy fact of the release names (sfDeploys, ciDeploys,
// gearsetPromotions in ctx, each only when a plain object), else the first stage. Never throws.
export function liveStage(config, ctx = {}) {
  const stages = layout(config?.salesforce, config).stages;
  if (!stages.length) return null;
  const named = new Set();
  for (const key of ['sfDeploys', 'ciDeploys', 'gearsetPromotions']) {
    const facts = ctx?.[key];
    if (facts !== null && typeof facts === 'object' && !Array.isArray(facts)) for (const name of Object.keys(facts)) named.add(name);
  }
  const live = stages.findLast((stage) => named.has(stage.name)) ?? stages[0];
  return { name: live.name, org: live.org };
}

export { checkConfig, defaults, doctorChecks, guard, slotLimit };

export default { name: 'salesforce', requires: { tools: ['openssl'] }, detect, defaults, checkConfig, slotLimit, doctorChecks, guard, prepareSessions: setUp, commands: [sfCommand], steps, liveStage, rolledBackAt: ({ dir, story }) => rolledBackAt(dir, story), envAdapters: { 'sandbox-pool': sandboxPool, scratch }, traitsDir: fileURLToPath(new URL('./traits/', import.meta.url)) };
