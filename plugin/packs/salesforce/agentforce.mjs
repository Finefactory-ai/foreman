// Agentforce in a Salesforce release: the post-deploy check that publishes, activates and tests
// the agents a story changed (agentforceCheck, one of sf-verify's POST_DEPLOY_CHECKS), the
// rollback of those agents (restoreAgents, for rollback.mjs), and the switch the doctor turns off
// when an org lacks Agentforce or Data Cloud (readAgentforceSwitch, writeAgentforceSwitch:
// <state>/salesforce/agentforce.json, { off: true, reason, at }; no file means on).
//
// agentforceCheck applies unless salesforce.agentforce is "off". The agents are the
// AiAuthoringBundle members of the story's delta manifest (ctx.sfDelta.manifest); with none it
// passes with no sf call, even with the switch off. Every name must match AGENT_API_NAME, because
// it goes into SOQL. Then, before any sf call, it fails when the switch is off ("Agentforce is
// off: <reason>"), when an agent's eval spec (tests/<Api>-eval.json at the stage's commit, read with
// git show through ctx.sh) is missing or malformed, when the story changed more agents than the
// suite limit, or when the stage org has no room for one more suite per agent in the suite counter
// (agent-eval.mjs). Then, in the stage's org:
//
//   0. the commit is ctx.sha, the commit sf-deploy deployed (the merge for the stage's own branch,
//      else the merge step's). The eval specs are read at that commit, and sf finds a bundle only
//      in the folder it runs in, so validate and publish run in a temporary git worktree of that
//      commit, never the slot's checkout (which is on whatever the merge left). The worktree is
//      removed right after the last publish, on every path, and git's record of it is pruned when
//      the remove fails. A commit that is not a full sha, or a checkout that fails, fails before
//      any sf call, with no changedOrg.
//   1. every bundle is validated: `sf agent validate authoring-bundle`
//   2. for each bundle in order: read its versions (versionsQuery: the active one is the
//      rollback target, previous, or null for a new agent); `sf agent publish authoring-bundle
//      --skip-retrieve`, so the new Bot and GenAi metadata never land in the checkout;
//      read the versions again, where the new highest is the story's version; record
//      { stage, org, apiName, previous, version, at } on the story's release record
//      (releases.mjs) before the activate, so a later failure can be rolled back; `sf agent
//      activate --version <version>`; and read the versions once more: that version must be
//      Active. A publish deploys the bundle, so once one publish succeeded the result says
//      changedOrg, on success and on every later failure, and sf-verify re-reads the org's
//      newest deploy. A failure before the first publish (a bad name, the switch, too many agents,
//      an eval spec, the room, the validate, or that publish itself) has no changedOrg.
//   3. one agent session for the org (agentSession in agent-eval.mjs), then for each agent: the
//      planner of the activated version (plannerQuery: exactly one GenAiPlannerDefinition
//      <Api>_v<version>), one suite recorded on the counter, the suite run, and one re-run of
//      only the cases whose routing failed. The response and its JUnit go to
//      <state>/salesforce/evals/<story>/<stage>-<Api>.{json,junit.xml}. A routing failure that
//      fails again on the re-run fails the check; the agents are already on the release record,
//      so the rollback restores them. An outcome the judge scored below its threshold, and a
//      routing case that passed only on the re-run, are notes: plain lines sf-verify adds to the
//      story's manual steps.
//
// apexTargets reads the Apex classes an Agent Script (.agent) text names as action targets
// (`target: "apex://Name"`), sorted and unique; [] for text that is not a string. rollback.mjs
// holds those classes back from its deletes, because a published agent still uses them.
//
// restoreAgents puts each recorded agent back (rollback.mjs calls it before the reverse deploy): it activates the previous version when that is
// not already active (no deactivate first), deactivates an agent the story created (previous
// null), and otherwise does nothing. It stops at the first failure with the command to run by
// hand. A recorded name that is not an agent API name, or a previous that is neither an integer
// nor null, fails with no sf call and "none: restore the agent in Setup" as the command.
//
// Every sf call goes through the caller's sh, which is the isolated sf home, and through
// runSf, which adds --json. It never passes --ignore-*, `quick`, NoTestRun or --version-number,
// and never runs `sf agent test`. A message names only agents, versions, aliases, stages, case
// and check ids and HTTP statuses, plus sf's own error message and the redacted snippet of
// Salesforce's error answer; never an sf result, a session token or a JWT.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redact } from '../../lib/secrets/redact.mjs';
import { safeId, writeAtomic } from '../../lib/adapters/stories/overlay.mjs';
import { stateDir } from '../../lib/engine/paths.mjs';
import { EVAL_LIMIT, agentSession, evalRoom, gradeEval, junit, loadEvalSpec, recordSuite, runSuite } from './agent-eval.mjs';
import { manifestTypes } from './env/sandbox-pool.mjs';
import { recordAgent } from './releases.mjs';
import { runSf } from './sf.mjs';
import { removeTempTree } from './temp-tree.mjs';

export const AGENT_API_NAME = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
export const AGENTFORCE_FILE = path.join('salesforce', 'agentforce.json');

const PUBLISH_TIMEOUT_MS = 600_000;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const firstLine = (text) => String(text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? 'git gave no reason';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const members = (manifest, type) => [...new Set(manifest ? manifestTypes(manifest)[type] ?? [] : [])].sort(compare);

// Both queries paste the name into SOQL, so they throw for anything that is not an agent API
// name (and plannerQuery for a version that is not an integer). Callers check names first; this
// is the backstop.
const agentName = (api) => {
  if (typeof api !== 'string' || !AGENT_API_NAME.test(api)) throw new Error(`${String(api)} is not an agent API name`);
  return api;
};

export const versionsQuery = (api) => `SELECT VersionNumber, Status FROM BotVersion WHERE BotDefinition.DeveloperName = '${agentName(api)}'`;
export const plannerQuery = (api, version) => {
  agentName(api);
  if (!Number.isInteger(version)) throw new Error(`${String(version)} is not an agent version`);
  return `SELECT Id FROM GenAiPlannerDefinition WHERE DeveloperName = '${api}_v${version}'`;
};

const PLANNER_ID = /^[A-Za-z0-9]{15,18}$/;

// The switch record, or null when Agentforce is on (also for a missing or broken file).
export function readAgentforceSwitch(state) {
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(state, AGENTFORCE_FILE), 'utf8'));
    if (!isObject(rec) || rec.off !== true || typeof rec.reason !== 'string') return null;
    return { off: true, reason: rec.reason, at: typeof rec.at === 'string' ? rec.at : null };
  } catch {
    return null;
  }
}

// Writes the switch record; null deletes the file, which turns Agentforce back on.
export function writeAgentforceSwitch(state, record) {
  const file = path.join(state, AGENTFORCE_FILE);
  if (record === null) {
    fs.rmSync(file, { force: true });
    return;
  }
  writeAtomic(file, `${JSON.stringify({ off: true, reason: String(record.reason ?? ''), at: record.at ?? null }, null, 2)}\n`);
}

// The AiAuthoringBundle members of a manifest, sorted and unique; [] for a missing file.
export const agentBundles = (manifest) => members(manifest, 'AiAuthoringBundle');

// The AiEvaluationDefinition members of a manifest, sorted and unique; [] for a missing file.
export const evalDefinitions = (manifest) => members(manifest, 'AiEvaluationDefinition');

// The agent's versions as { ok, versions: [{ number, status }] } or { ok: false, error }.
function readVersions(sh, api, org) {
  const q = runSf(sh, ['data', 'query', '--query', versionsQuery(api), '--target-org', org]);
  if (!q.ok) return { ok: false, error: q.error };
  const records = isObject(q.result) && Array.isArray(q.result.records) ? q.result.records : [];
  const versions = records
    .filter(isObject)
    .map((r) => ({ number: Number(r.VersionNumber), status: r.Status }))
    .filter((v) => Number.isInteger(v.number));
  return { ok: true, versions };
}

const activeOf = (versions) => versions.find((v) => v.status === 'Active')?.number ?? null;
const highestOf = (versions) => versions.reduce((max, v) => Math.max(max, v.number), 0);

const activateArgs = (api, version, org) => ['agent', 'activate', '--api-name', api, '--version', String(version), '--target-org', org];
const deactivateArgs = (api, org) => ['agent', 'deactivate', '--api-name', api, '--target-org', org];

function publishOne({ ctx, sh, stage, api, state, cwd }) {
  const { org } = stage;
  const where = `${org} (${stage.name})`;
  const no = (reason) => ({ ok: false, reason });
  const unread = (error) => no(`could not read the versions of agent ${api} in ${where}: ${error.message}`);

  const before = readVersions(sh, api, org);
  if (!before.ok) return unread(before.error);
  const previous = activeOf(before.versions);
  const highest = highestOf(before.versions);

  const published = runSf(sh, ['agent', 'publish', 'authoring-bundle', '--api-name', api, '--target-org', org, '--skip-retrieve'], { cwd, timeoutMs: PUBLISH_TIMEOUT_MS });
  if (!published.ok) return no(`could not publish agent ${api} in ${where}: ${published.error.message}`);

  // From here the org has the published bundle, so every failure says so.
  const changed = (r) => ({ ...r, published: true });
  const after = readVersions(sh, api, org);
  if (!after.ok) return changed(unread(after.error));
  const version = highestOf(after.versions);
  if (version <= highest) return changed(no(`publishing ${api} in ${where} made no new version`));

  recordAgent(state, ctx.story, { stage: stage.name, org, apiName: api, previous, version, at: (ctx.now?.() ?? new Date()).toISOString() });

  const activated = runSf(sh, activateArgs(api, version, org));
  if (!activated.ok) return changed(no(`could not activate agent ${api} version ${version} in ${where}: ${activated.error.message}`));

  const now = readVersions(sh, api, org);
  if (!now.ok) return changed(unread(now.error));
  if (now.versions.find((v) => v.number === version)?.status !== 'Active') return changed(no(`${api} version ${version} is not active in ${where}`));
  return { ok: true, published: true, agent: { apiName: api, previous, version } };
}

// The Id of the activated version's planner, or { error }.
function plannerOf(sh, api, version, org) {
  const q = runSf(sh, ['data', 'query', '--query', plannerQuery(api, version), '--target-org', org]);
  if (!q.ok) return { error: `could not read the planner of agent ${api} version ${version}: ${q.error.message}` };
  const records = isObject(q.result) && Array.isArray(q.result.records) ? q.result.records.filter(isObject) : [];
  if (records.length !== 1) return { error: `found ${records.length} planners for agent ${api} version ${version}, not one` };
  const id = records[0].Id;
  if (typeof id !== 'string' || !PLANNER_ID.test(id)) return { error: `the planner of agent ${api} version ${version} has no usable Id` };
  return { id };
}

// The suite for one activated agent, with its one re-run: { ok: true, notes } or { ok: false,
// reason }. It writes the merged response and its JUnit before it returns.
async function testAgent({ ctx, sh, stage, state, session, fetch, now, sleep, agent, spec }) {
  const { apiName: api, version } = agent;
  const where = `${stage.org} (${stage.name})`;
  const no = (reason) => ({ ok: false, reason: `agent ${api} in ${where}: ${reason}` });

  const planner = plannerOf(sh, api, version, stage.org);
  if (planner.error) return no(planner.error);

  recordSuite(state, stage.org, now);
  const first = await runSuite({ session, fetch, plannerId: planner.id, spec, sleep });
  if (!first.ok) return no(first.reason);
  const firstGrade = gradeEval(spec, first.response);

  let response = first.response;
  const failed = [...new Set(firstGrade.routing.map((f) => f.case))];
  if (failed.length) {
    const again = await runSuite({ session, fetch, plannerId: planner.id, spec: { ...spec, tests: spec.tests.filter((t) => failed.includes(t.id)) }, sleep });
    if (!again.ok) return no(again.reason);
    const rerun = new Map(again.response.results.filter(isObject).map((r) => [r.id, r]));
    response = { results: [...first.response.results.filter((r) => !failed.includes(r?.id)), ...failed.filter((id) => rerun.has(id)).map((id) => rerun.get(id))] };
  }
  const grade = gradeEval(spec, response);

  const base = path.join(state, 'salesforce', 'evals', safeId(ctx.story), `${safeId(stage.name)}-${api}`);
  writeAtomic(`${base}.json`, `${JSON.stringify(response, null, 2)}\n`);
  writeAtomic(`${base}.junit.xml`, junit(api, spec, response, grade));

  const blocked = grade.routing[0];
  if (blocked) return no(`routing failed in case ${blocked.case} (${blocked.check}: expected ${blocked.expected}), also on the re-run`);

  const thresholdOf = (id) => spec.tests.find((t) => t.id === id)?.outcome?.threshold ?? 3;
  const notes = [
    ...grade.outcome.map((f) => `Check agent ${api} in ${stage.name}: the judge scored case ${f.case} below ${thresholdOf(f.case)}`),
    ...failed.map((id) => `Agent ${api} in ${stage.name}: routing case ${id} passed only on the re-run`),
  ];
  return { ok: true, notes };
}

export const agentforceCheck = {
  name: 'agentforce',
  applies: (config) => (config?.salesforce?.agentforce ?? 'auto') !== 'off',

  async run({ ctx, sh, stage }) {
    const bundles = agentBundles(ctx.sfDelta?.manifest);
    if (bundles.length === 0) return { ok: true };
    const bad = bundles.find((api) => !AGENT_API_NAME.test(api));
    if (bad !== undefined) return { ok: false, reason: `AiAuthoringBundle ${bad} is not an agent API name` };

    const env = ctx.env ?? process.env;
    const state = stateDir(ctx.root, ctx.config, env);
    const off = readAgentforceSwitch(state);
    if (off) return { ok: false, reason: `Agentforce is off: ${off.reason}` };
    if (bundles.length > EVAL_LIMIT.suites) {
      return {
        ok: false,
        reason: `${bundles.length} agents changed, but ${stage.org} runs at most ${EVAL_LIMIT.suites} eval suites in ${EVAL_LIMIT.hours} hours, one per agent: split the story so a release changes at most ${EVAL_LIMIT.suites} agents`,
      };
    }

    const commit = ctx.sha;
    if (typeof commit !== 'string' || !SHA.test(commit)) {
      return { ok: false, reason: `could not check the agents in ${stage.org} (${stage.name}): the ${stage.name} commit is not known, so there is nothing to check out` };
    }

    const specs = new Map();
    for (const api of bundles) {
      const read = loadEvalSpec(ctx.sh, commit, api);
      if (!read.ok) return { ok: false, reason: read.reason };
      specs.set(api, read.spec);
    }

    const now = ctx.now?.() ?? new Date();
    const room = evalRoom(state, stage.org, { now, wanted: bundles.length });
    if (!room.ok) {
      const next = room.next ? `; the next can run after ${room.next}` : '';
      return { ok: false, reason: `agent eval limit: ${room.used} suites ran in ${stage.org} in the last ${EVAL_LIMIT.hours} hours (limit ${EVAL_LIMIT.suites})${next}` };
    }

    const agents = [];
    let published = false;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-sf-agent-'));
    const tree = path.join(tmp, 'tree');
    const git = (args, cwd = ctx.root) => ctx.sh('git', args, { cwd }) ?? {};
    try {
      const added = git(['worktree', 'add', '--detach', tree, commit]);
      if (added.status !== 0) {
        return { ok: false, reason: `could not check the agents in ${stage.org} (${stage.name}): could not check out ${commit} (the ${stage.name} commit): ${redact(firstLine(added.stderr || added.stdout), { env })}` };
      }

      for (const api of bundles) {
        const v = runSf(sh, ['agent', 'validate', 'authoring-bundle', '--api-name', api, '--target-org', stage.org], { cwd: tree });
        if (!v.ok) return { ok: false, reason: `could not validate agent ${api} in ${stage.org} (${stage.name}): ${v.error.message}` };
      }

      for (const api of bundles) {
        const r = publishOne({ ctx, sh, stage, api, state, cwd: tree });
        if (r.published) published = true;
        if (!r.ok) return { ok: false, reason: r.reason, ...(published ? { changedOrg: true } : {}) };
        agents.push(r.agent);
      }
    } finally {
      removeTempTree(git, tree, tmp);
    }

    const fetch = ctx.fetch ?? globalThis.fetch;
    const opened = await agentSession({ sh, rawSh: ctx.sh, env, block: ctx.config?.salesforce, org: stage.org, orgId: stage.orgId, fetch, now, sleep: ctx.sleep });
    if (!opened.ok) return { ok: false, reason: `could not test the agents in ${stage.org} (${stage.name}): ${opened.reason}`, changedOrg: true };

    const notes = [];
    for (const agent of agents) {
      const r = await testAgent({ ctx, sh, stage, state, session: opened.session, fetch, now, sleep: ctx.sleep, agent, spec: specs.get(agent.apiName) });
      if (!r.ok) return { ok: false, reason: r.reason, changedOrg: true };
      notes.push(...r.notes);
    }
    return { ok: true, changedOrg: true, agents, ...(notes.length ? { notes } : {}) };
  },
};

// The Apex classes the Agent Script text targets with apex://, sorted and unique.
export function apexTargets(source) {
  if (typeof source !== 'string') return [];
  return [...new Set([...source.matchAll(/apex:\/\/([A-Za-z][A-Za-z0-9_]*)/g)].map((m) => m[1]))].sort();
}

// Puts each recorded agent back in `org`, for `foreman sf rollback`. Returns { ok: true,
// restored: [{ apiName, version: previous }] }, or { ok: false, apiName, command, reason } at the
// first failure, where command is the sf command that restores the agent by hand.
export function restoreAgents(sh, { org, agents }) {
  const restored = [];
  for (const entry of Array.isArray(agents) ? agents : []) {
    const api = entry?.apiName;
    const previous = entry?.previous;
    if (typeof api !== 'string' || !AGENT_API_NAME.test(api)) {
      return { ok: false, apiName: String(api), command: 'none: restore the agent in Setup', reason: `${api} is not an agent API name` };
    }
    if (!Number.isInteger(previous) && previous !== null) {
      return { ok: false, apiName: api, command: 'none: restore the agent in Setup', reason: `agent ${api} has no usable previous version on the release record` };
    }
    const args = Number.isInteger(previous) ? activateArgs(api, previous, org) : deactivateArgs(api, org);
    const command = `sf ${args.join(' ')}`;
    const failed = (reason) => ({ ok: false, apiName: api, command, reason });

    const read = readVersions(sh, api, org);
    if (!read.ok) return failed(`could not read the versions of agent ${api} in ${org}: ${read.error.message}`);
    const active = activeOf(read.versions);

    const run = Number.isInteger(previous) ? active !== previous : active !== null;
    if (run) {
      const r = runSf(sh, args);
      if (!r.ok) {
        const what = Number.isInteger(previous) ? `activate version ${previous} of agent ${api}` : `deactivate agent ${api}`;
        return failed(`could not ${what} in ${org}: ${r.error.message}`);
      }
    }
    restored.push({ apiName: api, version: previous });
  }
  return { ok: true, restored };
}
