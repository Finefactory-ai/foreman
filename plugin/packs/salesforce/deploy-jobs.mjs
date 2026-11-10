// The deploy job a story has under way on one stage: one JSON file per story and stage at
// <stateDir>/salesforce/deploys/<story id>/<stage>.json,
//
//   { story, stage, org, orgId, jobId, to, startedAt }
//
// steps/sf-deploy.mjs writes it as soon as `sf project deploy start --async` gives a job ID,
// before it first reads the job, and clears it when the job ends. A run that dies in between
// leaves it, and the next run for the same org (alias and org ID) and the same commit (`to`)
// reads that job rather than starting a second deploy.
//
// It imports only node built-ins and the two helpers below, which import nothing else of
// Foreman's, like deletes.mjs.

import fs from 'node:fs';
import { join } from 'node:path';
import { safeId, writeAtomic } from '../../lib/adapters/stories/overlay.mjs';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export const deployJobFile = (dir, story, stage) => join(dir, 'salesforce', 'deploys', safeId(story), `${safeId(stage)}.json`);

// The record, or null for a missing or broken file.
export function readDeployJob(dir, story, stage) {
  try {
    const record = JSON.parse(fs.readFileSync(deployJobFile(dir, story, stage), 'utf8'));
    return isObject(record) ? record : null;
  } catch {
    return null;
  }
}

// Writes the record, replacing any other for its story and stage, and returns it.
export function writeDeployJob(dir, { story, stage, org, orgId, jobId, to, startedAt }) {
  const record = { story, stage, org, orgId, jobId, to, startedAt };
  writeAtomic(deployJobFile(dir, story, stage), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export function clearDeployJob(dir, story, stage) {
  fs.rmSync(deployJobFile(dir, story, stage), { force: true });
}
