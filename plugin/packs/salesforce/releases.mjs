// What Foreman's Salesforce releases reached, for sf-verify's health check and for
// `foreman sf rollback` (rollback.mjs). Two kinds of JSON file in the state folder:
//
//   <stateDir>/salesforce/releases/<story id>.json, one per story:
//     { story, to, reached: [stage name...], first, rolledBack, agents? }
//     to is the story's commit (sfDelta.to) for this release attempt; a new `to` starts a fresh
//     record, so a new attempt never inherits an old one's stages. reached lists each stage a
//     deploy step got to, in order, skipped deploys included. first is null or the deploy to
//     stage 1, { stage, org, orgId, branch, merge, method, jobId, deployedAt }, which is what a
//     rollback reverts. rolledBack is null or { revert, jobId, at }; a new first deploy
//     (recordFirstDeploy) clears it, so a story shipped again with the same `to` after a
//     rollback can be rolled back again. agents, once an agent was published, lists
//     [{ stage, org, apiName, previous, version, at }]: previous is the version that was active
//     before the story (null for a new agent), which a rollback reactivates. A missing agents
//     key means none.
//
//   <stateDir>/salesforce/deployed/<stage>.json, one per stage:
//     { stage, org, orgId, jobId, story, commit, at }
//     the last thing Foreman deployed to that stage: a story's merge, or a rollback's revert.
//
// steps/sf-deploy.mjs and steps/sf-verify.mjs mark stages reached; sf-deploy writes the stage
// record and the first deploy, agentforce.mjs the agents, and rollback.mjs the rollback. Like
// deploy-jobs.mjs, it imports only node built-ins and the two helpers below, and never throws
// on a read.

import fs from 'node:fs';
import { join } from 'node:path';
import { safeId, writeAtomic } from '../../lib/adapters/stories/overlay.mjs';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const write = (file, record) => writeAtomic(file, `${JSON.stringify(record, null, 2)}\n`);

function readJson(file) {
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isObject(record) ? record : null;
  } catch {
    return null;
  }
}

const fresh = (story, to) => ({ story, to, reached: [], first: null, rolledBack: null });

export const releaseFile = (dir, story) => join(dir, 'salesforce', 'releases', `${safeId(story)}.json`);
export const deployedFile = (dir, stage) => join(dir, 'salesforce', 'deployed', `${safeId(stage)}.json`);

// The story's record, or null for a missing or broken file.
export const readRelease = (dir, story) => readJson(releaseFile(dir, story));

// Adds `stage` to the stages the story reached, once, and returns the record. A stored record
// for another `to` is replaced by a fresh one.
export function markReached(dir, story, stage, to) {
  const was = readRelease(dir, story);
  const base = was && was.to === to ? was : fresh(story, to);
  const reached = Array.isArray(base.reached) ? base.reached.filter((s) => typeof s === 'string') : [];
  const record = { ...base, reached: reached.includes(stage) ? reached : [...reached, stage] };
  write(releaseFile(dir, story), record);
  return record;
}

function update(dir, story, patch) {
  const record = { ...(readRelease(dir, story) ?? fresh(story, null)), ...patch };
  write(releaseFile(dir, story), record);
  return record;
}

export const recordFirstDeploy = (dir, story, first) => update(dir, story, { first, rolledBack: null });
export const recordRollback = (dir, story, rolledBack) => update(dir, story, { rolledBack });

// Records an agent the story published on a stage and returns the record. An entry for the same
// stage and apiName is replaced, keeping its earlier previous, so a retried publish never makes
// the story's own version the rollback target.
export function recordAgent(dir, story, entry) {
  const was = readRelease(dir, story);
  const agents = Array.isArray(was?.agents) ? was.agents.filter(isObject) : [];
  const same = (a) => a.stage === entry.stage && a.apiName === entry.apiName;
  const old = agents.find(same);
  const next = old ? { ...entry, previous: old.previous } : entry;
  return update(dir, story, { agents: old ? agents.map((a) => (same(a) ? next : a)) : [...agents, next] });
}

// The stage's record, or null for a missing or broken file.
export const readDeployed = (dir, stage) => readJson(deployedFile(dir, stage));

// Replaces the stage's record and returns it.
export function writeDeployed(dir, { stage, org, orgId, jobId, story, commit, at }) {
  const record = { stage, org, orgId, jobId, story, commit, at };
  write(deployedFile(dir, stage), record);
  return record;
}
