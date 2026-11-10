// The Salesforce scratch-org slot environment, for salesforce.build { scratch: { devHub,
// definition } }: each story builds in a scratch org of its own, made from the project's
// definition through the Dev Hub, and deleted once the story closes. It takes no options.
//
// prepare(n, path) answers a promise: a scratch org takes minutes to make. It reads the slot's
// story from <stateDir>/slots/wN.json and rejects with a short message on any refusal, which
// the engine turns into a down slot and a notice:
//
//   1. no story in the slot: refused, with no sf call
//   2. a ready record for the story: it must name the story's own alias, and the org behind
//      that alias must still be a sandbox with the recorded org ID; then the slot reuses it
//      ('up'), targeting the alias it checked. A record that fails that check, or a 'creating'
//      one a dead run left, is deleted first, and a new org made. A 'creating' record with a job
//      ID and no org ID is first resumed once (`--wait 0`), so an org sf can still sign in is
//      recorded and deleted, not left to count against the Dev Hub; one still being made is
//      kept, and the slot refuses with no second org.
//   3. the Dev Hub's limits (`sf org list limits`): none left today (DailyScratchOrgs) refuses
//      with no create call; none active left (ActiveScratchOrgs) first deletes the orgs of
//      stories in no slot, at once, then reads the limits again
//   4. a 'creating' record, written before `sf org create scratch --async`, so a run killed
//      while sf signs the org in leaves its username on record (isolation.mjs accepts it)
//   5. `sf org resume scratch --wait 0` every 30 seconds for up to 20 minutes; a timeout keeps
//      the record for the next prepare or the sweep, any other failure deletes the org
//   6. the identity check: the org must be a sandbox (a scratch org reports IsSandbox true)
//      with the org ID resume gave. Production is never a target.
//   7. the record, now 'ready', and target-org set in the worktree's own .sf/config.json.
//      It answers 'reset': a fresh org.
//
// sweep() deletes the org of every story that has been in no slot for 5 minutes, so a story
// that resumes at once (a crash, credits back) keeps its org. It answers a promise of
// { deleted: [story], warnings: [text] } and never rejects; a second call while one runs gets
// the same promise. A 'creating' record is resumed once first, as in step 2: while its org is
// still being made the sweep skips it with no warning and tries again next time. The supervisor
// runs it every minute, busy slots or not, while paused or halted too (supervisor.mjs,
// slot-prepare.mjs runEnvSweep).
//
// Records live in scratch-orgs.mjs. Every sf call runs through the isolated sf home
// (isolation.mjs), where the Dev Hub is signed in. A message names only aliases, story ids,
// the Dev Hub and org IDs; sf's own words go through a scrub that turns every word holding an
// @ into "an org", so no username and no sf result reaches a message.

import os from 'node:os';
import { join } from 'node:path';
import fs from 'node:fs';
import { defaultSh } from '../../../lib/engine/worktree.mjs';
import { layout } from '../config.mjs';
import { isolatedSh, orgQuery, sfHome } from '../isolation.mjs';
import { readScratchOrgs, removeScratchOrg, scratchAlias, storiesInSlots, writeScratchOrg } from '../scratch-orgs.mjs';
import { runSf, stopsRetry } from '../sf.mjs';

export const requires = { env: [], tools: ['sf'] };

const NAME = 'env adapter scratch';
const DURATION_DAYS = 2;
const POLL_MS = 30_000;
const CREATE_LIMIT_MS = 20 * 60_000;
const SWEEP_GRACE_MS = 5 * 60_000;
const RESUME_TIMEOUT_MS = 600_000;
const DELETE_TIMEOUT_MS = 120_000;
const IN_PROGRESS = 'StillInProgressError';
const SIGNED_OUT = /No authori[sz]ation information found/i;
const STILL_MAKING = 'its org is still being made';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.length > 0;
const id15 = (v) => (typeof v === 'string' ? v.slice(0, 15) : '');
// Every word holding an @ (a username, or an auth file named after one) becomes "an org".
const scrub = (text) => String(text ?? '').replace(/\S+@\S+/g, 'an org');
const sfMessage = (r) => scrub(r?.error?.message ?? 'no answer');

// The org ID and username a successful `org resume scratch` gives: its own, then its
// authFields', then (for the username) the record's signup username.
function signedIn(result, record) {
  const res = isObject(result) ? result : {};
  const auth = isObject(res.authFields) ? res.authFields : {};
  return {
    orgId: [res.orgId, auth.orgId].find(isText) ?? null,
    username: [res.username, auth.username, record.username].find(isText) ?? null,
  };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// The story the supervisor gave slot n, read as env/sandbox-pool.mjs reads it.
function currentStory(stateDir, n) {
  const slot = readJson(join(stateDir, 'slots', `w${n}.json`));
  const id = isObject(slot) && isObject(slot.story) ? slot.story.id : undefined;
  return isText(id) ? id : undefined;
}

export function create(options = {}, ctx = {}) {
  const { adapter, ...rest } = options;
  const unknown = Object.keys(rest);
  if (unknown.length) throw new Error(`${NAME}: unknown option ${unknown.join(', ')}`);

  const {
    stateDir,
    config = {},
    sh = defaultSh,
    env: baseEnv = process.env,
    homedir = os.homedir(),
    wait = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = Date.now,
  } = ctx;
  const { build } = layout(config?.salesforce, config);
  if (build.mode !== 'scratch' || !build.devHub || !build.definition) {
    throw new Error(`${NAME}: salesforce.build must be { "scratch": { "devHub", "definition" } }`);
  }
  const { devHub, definition } = build;
  const iso = isolatedSh(sh, baseEnv, sfHome(baseEnv, homedir), homedir);
  const at = () => new Date(now()).toISOString();

  // Why `alias` is not the org `orgId`, or not a sandbox; null when it is both.
  const identityProblem = (alias, orgId) => {
    const q = orgQuery(iso, alias);
    if (!q.ok) return `could not check ${alias}: ${sfMessage(q)}`;
    const records = isObject(q.result) && Array.isArray(q.result.records) ? q.result.records : [];
    const record = isObject(records[0]) ? records[0] : {};
    if (record.IsSandbox !== true) return `${alias} is not a sandbox; production is never a target`;
    if (!isText(orgId) || id15(record.Id) !== id15(orgId)) return `${alias} is org ${id15(record.Id)}, not ${orgId}`;
    return null;
  };

  // Deletes the record's org, then its record. null when both are gone, else sf's scrubbed
  // message, or STILL_MAKING; the record stays when sf could not delete the org. With no
  // username and no org ID, sf never signed the org in, so only the record goes.
  //
  // A record with a job ID and no org ID (a 'creating' one) is first resumed once, unless
  // `resume` is false: a resume that signs the org in is recorded before the delete, so a
  // failed delete leaves it allow-listed by org ID rather than a stray. An org still being made,
  // or a login stop, keeps the record; a job that failed or is gone goes on to the delete.
  const deleteOrg = (given, { resume = true } = {}) => {
    let record = given;
    if (resume && isText(record.jobId) && !isText(record.orgId)) {
      const r = runSf(iso, ['org', 'resume', 'scratch', '--job-id', record.jobId, '--wait', '0'], { timeoutMs: RESUME_TIMEOUT_MS });
      if (r.ok) {
        record = { ...record, ...signedIn(r.result, record) };
        writeScratchOrg(stateDir, record);
      } else if (stopsRetry(r)) return sfMessage(r);
      else if (r.error?.name === IN_PROGRESS) return STILL_MAKING;
    }
    const target = isText(record.username) ? record.username : isText(record.orgId) ? record.alias : null;
    if (target) {
      const r = runSf(iso, ['org', 'delete', 'scratch', '--target-org', target, '--no-prompt'], { timeoutMs: DELETE_TIMEOUT_MS });
      const gone = r.ok || r.error?.name === 'NamedOrgNotFoundError' || SIGNED_OUT.test(String(r.error?.message ?? ''));
      if (!gone) return sfMessage(r);
    }
    removeScratchOrg(stateDir, record.story);
    return null;
  };
  const deleteRecord = (record, opts) => {
    const why = deleteOrg(record, opts);
    return why === null ? null : `could not delete the scratch org ${record.alias} of ${record.story}: ${why}`;
  };

  // When each story was first seen in no slot.
  const missingSince = new Map();

  const sweepClosed = ({ graceMs }) => {
    const deleted = [];
    const warnings = [];
    for (const record of readScratchOrgs(stateDir)) {
      // Read again for each record: a slot may take a story while the sweep runs.
      if (storiesInSlots(stateDir).has(record.story)) {
        missingSince.delete(record.story);
        continue;
      }
      const t = now();
      if (!missingSince.has(record.story)) missingSince.set(record.story, t);
      if (t - missingSince.get(record.story) < graceMs) continue;
      const why = deleteOrg(record);
      // Still being made: tried again next time, with no warning every minute.
      if (why === STILL_MAKING) continue;
      if (why !== null) {
        warnings.push(`could not delete the scratch org ${record.alias} of ${record.story}: ${why}`);
        continue;
      }
      missingSince.delete(record.story);
      deleted.push(record.story);
    }
    return { deleted, warnings };
  };

  let sweeping = null;
  const sweep = () => {
    if (sweeping) return sweeping;
    sweeping = Promise.resolve()
      .then(() => sweepClosed({ graceMs: SWEEP_GRACE_MS }))
      .catch((err) => ({ deleted: [], warnings: [`the scratch org sweep failed: ${scrub(err?.message ?? err)}`] }))
      .finally(() => {
        sweeping = null;
      });
    return sweeping;
  };

  // { daily, active } rows from the Dev Hub, or a thrown refusal.
  const readLimits = () => {
    const r = runSf(iso, ['org', 'list', 'limits', '--target-org', devHub]);
    if (!r.ok) throw new Error(`could not read the scratch org limits of ${devHub}: ${sfMessage(r)}`);
    const rows = Array.isArray(r.result) ? r.result.filter(isObject) : [];
    const row = (name) => rows.find((x) => x.name === name && Number.isFinite(x.remaining));
    const daily = row('DailyScratchOrgs');
    const active = row('ActiveScratchOrgs');
    if (!daily || !active) throw new Error(`${devHub} reports no scratch org limits; is Dev Hub turned on?`);
    return { daily, active };
  };

  const checkLimits = (story) => {
    let { daily, active } = readLimits();
    if (daily.remaining < 1) {
      throw new Error(`${devHub} has used its ${daily.max} scratch orgs for today (DailyScratchOrgs); no scratch org was made for ${story}. Resume the slot once the Dev Hub has more`);
    }
    if (active.remaining < 1) {
      const swept = sweepClosed({ graceMs: 0 });
      ({ active } = readLimits());
      if (active.remaining < 1) {
        const why = swept.warnings.length ? ` (${swept.warnings[0]})` : '';
        throw new Error(`${devHub} already has its ${active.max} active scratch orgs (ActiveScratchOrgs); no scratch org was made for ${story}. Resume the slot once one is deleted${why}`);
      }
    }
  };

  const env = (n) => ({ FOREMAN_SLOT: `w${n}` });

  const prepare = async (n, path) => {
    const slot = `w${n}`;
    const story = currentStory(stateDir, n);
    if (!story) throw new Error(`slot ${slot} has no story; scratch orgs are made per story`);
    const alias = scratchAlias(story);

    const setTarget = () => {
      const set = runSf(iso, ['config', 'set', 'target-org', alias], { cwd: path });
      if (!set.ok) throw new Error(`could not set target-org ${alias} in ${path}: ${sfMessage(set)}`);
    };

    const old = readScratchOrgs(stateDir).find((r) => r.story === story);
    if (old) {
      // The check runs on the alias setTarget sets, and a record naming another alias fails it.
      if (old.state === 'ready' && old.alias === alias && !identityProblem(alias, old.orgId)) {
        writeScratchOrg(stateDir, { ...old, slot });
        setTarget();
        return 'up';
      }
      const why = deleteOrg(old);
      if (why !== null) throw new Error(`could not replace the scratch org ${old.alias} of ${story}: ${why}`);
    }

    checkLimits(story);

    let record = { story, slot, alias, devHub, state: 'creating', jobId: null, username: null, orgId: null, createdAt: at() };
    writeScratchOrg(stateDir, record);

    const made = runSf(iso, ['org', 'create', 'scratch', '--definition-file', definition, '--target-dev-hub', devHub, '--alias', alias, '--duration-days', String(DURATION_DAYS), '--async'], { cwd: path });
    if (!made.ok) {
      removeScratchOrg(stateDir, story);
      throw new Error(`could not request a scratch org from ${devHub}: ${sfMessage(made)}`);
    }
    const jobId = isObject(made.result) && isObject(made.result.scratchOrgInfo) ? made.result.scratchOrgInfo.Id : undefined;
    if (!isText(jobId)) {
      removeScratchOrg(stateDir, story);
      throw new Error(`${devHub} gave no job ID for the scratch org of ${story}`);
    }
    record = { ...record, jobId, username: isText(made.result.username) ? made.result.username : null };
    writeScratchOrg(stateDir, record);

    // Fails with the org deleted, or with the warning that it could not be. The poll loop has
    // just resumed, so the delete does not resume again.
    const fail = (text) => {
      const warning = deleteRecord(record, { resume: false });
      throw new Error(warning ? `${text}; ${warning}` : text);
    };

    const deadline = now() + CREATE_LIMIT_MS;
    let result;
    for (;;) {
      const r = runSf(iso, ['org', 'resume', 'scratch', '--job-id', jobId, '--wait', '0'], { timeoutMs: RESUME_TIMEOUT_MS });
      if (r.ok) {
        result = isObject(r.result) ? r.result : {};
        break;
      }
      if (stopsRetry(r) || r.error?.name !== IN_PROGRESS) fail(`the scratch org for ${story} could not be created: ${sfMessage(r)}`);
      if (now() >= deadline) throw new Error(`the scratch org for ${story} was not ready within 20 minutes`);
      await wait(POLL_MS);
    }

    record = { ...record, ...signedIn(result, record) };
    writeScratchOrg(stateDir, record);

    const problem = identityProblem(alias, record.orgId);
    if (problem) fail(problem);

    record = { ...record, state: 'ready', readyAt: at() };
    writeScratchOrg(stateDir, record);
    setTarget();
    return 'reset';
  };

  return { env, prepare, sweep };
}
