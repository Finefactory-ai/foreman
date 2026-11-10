// The architect's plan as files, so a story session never retypes it. A Workflow-tool script
// cannot read files, so what the pipeline takes in its args stays a JSON object; the plan's long
// parts (the design and the test plan) reach the agents as a file they read.
//
//   PLAN_FILE(dir, id)           <dir>/plans/<id>.json, the id reduced to a safe file name as
//                                checkpoint.mjs CHECKPOINT does: the full plan as JSON
//   DESIGN_FILE(dir, id)         the same path ending in .md: the design, the test plan and the
//                                done-when line as markdown (the Read tool cuts lines over 2000
//                                characters, and a JSON plan's design is one long line)
//   shortPlan(plan)              only the plan's short fields (ready, builder, resources, files,
//                                done_when, approach) that it has, in that order: what the args
//                                carry. `approach`, only on a plan the architect rethought, says why
//                                the new approach ends a whole kind of bug; its presence tells the
//                                pipeline the story went back once already
//   designText(plan)             the markdown DESIGN_FILE holds, starting with the approach when the
//                                plan has one
//   writePlanFiles(dir, id, plan)
//                                writes both files, each atomically, creating <dir>/plans;
//                                returns { planFile, designFile }
//   readPlanFile(dir, id)        the saved plan, or null when there is none or it is not an object
//   stampPlan(plan, { cwd, remote, base, now, sh })
//                                the plan with `baseCommit` (the commit <remote>/<base> is at in
//                                `cwd`) and `plannedAt` added, when it has no baseCommit yet; the
//                                plan as given when it has one or git cannot say
//   planStaleness(plan, { cwd, remote, base, sh })
//                                { fresh: true }, or { fresh: false, reason } when the plan records
//                                no base commit, that commit is not in the repository, or one of the
//                                files the plan names changed on <remote>/<base> since. A later
//                                session reuses a fresh plan instead of running the architect again
//   sessionPlan({ dir, slot, id, roles, read })
//                                { plan } the last ready architect plan for story `id` among the
//                                answers in the transcripts of the session the slot's mark names
//                                (what the checkpoint reads), or { reason }; never throws

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resumePoint, stageOutputs } from './checkpoint.mjs';
import { markedSession, readMark, readSubagents } from './session-files.mjs';

const fileName = (id) => String(id ?? '').replace(/[^A-Za-z0-9._-]/g, '').replace(/^[.]+/, '') || 'none';

export const PLAN_FILE = (dir, id) => join(dir, 'plans', `${fileName(id)}.json`);
export const DESIGN_FILE = (dir, id) => join(dir, 'plans', `${fileName(id)}.md`);

const SHORT = ['ready', 'builder', 'resources', 'files', 'done_when', 'approach'];

export const shortPlan = (plan) => Object.fromEntries(SHORT.filter((key) => Object.hasOwn(plan, key)).map((key) => [key, plan[key]]));

export const designText = (plan) => `${typeof plan.approach === 'string' && plan.approach.trim() ? `## Approach\n${plan.approach}\n\n` : ''}## Design\n${plan.design ?? ''}\n\n## Test plan\n${plan.test_plan ?? ''}\n\n## Done when\n${plan.done_when ?? ''}\n`;

const writeAtomic = (file, text) => {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
};

export function writePlanFiles(dir, id, plan) {
  mkdirSync(join(dir, 'plans'), { recursive: true });
  const planFile = PLAN_FILE(dir, id);
  const designFile = DESIGN_FILE(dir, id);
  writeAtomic(planFile, `${JSON.stringify(plan, null, 2)}\n`);
  writeAtomic(designFile, designText(plan));
  return { planFile, designFile };
}

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function readPlanFile(dir, id) {
  try {
    const v = JSON.parse(readFileSync(PLAN_FILE(dir, id), 'utf8'));
    return isPlain(v) ? v : null;
  } catch {
    return null;
  }
}

// One git call in `cwd`, its trimmed stdout, or null when it failed.
function gitOut(sh, cwd, args) {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[key];
  const r = sh('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, env });
  return r && !r.error && r.status === 0 ? String(r.stdout ?? '').trim() : null;
}

const hasBase = (plan) => typeof plan?.baseCommit === 'string' && plan.baseCommit !== '';

export function stampPlan(plan, { cwd, remote, base, now = new Date(), sh = spawnSync }) {
  if (!isPlain(plan) || hasBase(plan)) return plan;
  const head = gitOut(sh, cwd, ['rev-parse', '--verify', '--quiet', `${remote}/${base}^{commit}`]);
  if (!head) return plan;
  return { ...plan, baseCommit: head, plannedAt: now.toISOString() };
}

export function planStaleness(plan, { cwd, remote, base, sh = spawnSync }) {
  if (!hasBase(plan)) return { fresh: false, reason: 'it records no base commit' };
  const tip = `${remote}/${base}`;
  const short = plan.baseCommit.slice(0, 10);
  if (gitOut(sh, cwd, ['cat-file', '-e', `${plan.baseCommit}^{commit}`]) === null) return { fresh: false, reason: `its base commit ${short} is not in this repository` };
  const files = Array.isArray(plan.files) ? plan.files.filter((f) => typeof f === 'string' && f) : [];
  if (files.length === 0) return { fresh: true };
  const changed = gitOut(sh, cwd, ['diff', '--name-only', plan.baseCommit, tip, '--', ...files]);
  if (changed === null) return { fresh: false, reason: `git could not compare ${short} with ${tip}` };
  const list = changed.split('\n').filter(Boolean);
  if (list.length === 0) return { fresh: true };
  return { fresh: false, reason: `${list.length} of its files changed on ${tip} since it was written: ${list.slice(0, 3).join(', ')}${list.length > 3 ? ', …' : ''}` };
}

export function sessionPlan({ dir, slot, id, roles, read = readFileSync }) {
  try {
    const none = { reason: 'no story session in this slot' };
    const mark = readMark(dir, slot);
    if (!mark) return none;
    if (mark.story !== id) return { reason: `this slot's session is for ${mark.story}` };
    const session = markedSession(dir, slot);
    if (!session) return none;
    let subagents;
    try {
      subagents = readSubagents(session.paths, read);
    } catch {
      return { reason: 'its transcripts could not be read' };
    }
    const { plan } = resumePoint({ entries: stageOutputs(subagents, id, roles) });
    return plan ? { plan } : { reason: `no ready architect plan for ${id} in this slot's session` };
  } catch (err) {
    return { reason: `the session could not be read: ${err.message}` };
  }
}
