// The Gearset set-up step behind the dashboard's /api/setup/gearset/ routes: picking the
// pipeline that promotes this repo, its environments beside salesforce.orgs and the stages, and
// the owner's word that each stage's CI job has a test level, which the Gearset API cannot show.
// Every word the owner sees is in lib/setup/gearset-screen.mjs GEARSET_SCREEN.
//
//   const gs = gearsetSetup({ root, env, fetch, now, tokenOf, setupFirst });
//   gs.current()         { pipelineId, stages: [{ name, org, orgId }] }: salesforce.gearset.pipelineId
//                        (or null) and the stages as layout() resolves them. No network.
//   gs.read(body)        {} or { pipelineId }: reads the pipelines with GEARSET_API_TOKEN
//                        (tokenOf(), the stored value or null), picks one (the body's, else the
//                        config's, else the only one, else none) and, with one, reads its
//                        environments and matches them (packs/salesforce/gearset.mjs
//                        matchEnvironments). Answers { ok: true, pipelines, pipelineId, saved,
//                        rows, missing }, saved being the config's pipeline; rows and missing are
//                        [] with none picked. A Gearset failure answers { ok: false, error } in
//                        the screen's words, picked by the HTTP status; a pipeline Gearset does
//                        not list answers badPipeline, with the pipelines.
//   gs.save(body)        { pipelineId }, exactly: writes salesforce.gearset.pipelineId to
//                        foreman.config.json through the team layer, keeping the file's
//                        salesforce.gearset.promote (the pack's default when it has none). Answers { ok, lines, gearset: current() };
//                        lines end with the commit reminder, or are [nothingChanged] when the
//                        file has that pipeline already, and then nothing is written. No network.
//   gs.confirm(body, { stateDir })
//                        { stage, confirmed }, exactly: records (true) or removes (false) the
//                        owner's confirmation that stage's CI job has a test level, as
//                        sf-gearset's confirmedByYou item ci-tests-<stage> in setup.json, apart
//                        from what Foreman checked. Answers { ok, stage, confirmedAt } (null when
//                        removed).
//
// The project is read afresh on each call. A failure is an Error with .status, the HTTP code to
// answer with: 409 with no config, 400 when the project does not release through Gearset or the
// body is wrong, 500 notSaved when foreman.config.json cannot be written, and no fs text in it.
// A refused value is never repeated, and no answer carries the token, a header or Gearset's own
// text.

import { BLOCK_DEFAULTS, PIPELINE_ID, layout } from '../../packs/salesforce/config.mjs';
import { gearsetEnvironments, gearsetPipelines, matchEnvironments } from '../../packs/salesforce/gearset.mjs';
import { COMMIT_REMINDER } from '../settings/change.mjs';
import { loadResolved } from '../settings/load.mjs';
import { readTeam, teamSet } from '../settings/team.mjs';
import { GEARSET_SCREEN } from './gearset-screen.mjs';
import { clearConfirmedByYou, markConfirmedByYou } from './record.mjs';

const E = GEARSET_SCREEN.errors;
const STEP = 'sf-gearset';
const BY_STATUS = { 401: E.badToken, 403: E.tier, 429: E.tooMany };

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = (status, message) => Object.assign(new Error(message), { status });
const isPipelineId = (v) => typeof v === 'string' && PIPELINE_ID.test(v);
const hasKeys = (body, keys) => isPlain(body) && Object.keys(body).length === keys.length && keys.every((k) => Object.hasOwn(body, k));

// A failed Gearset call in the screen's words: never Gearset's own text.
function words(r) {
  if (r.status === null || r.status === undefined) return E.unreachable;
  return BY_STATUS[r.status] ?? E.other.split('{status}').join(String(r.status));
}

export function gearsetSetup({ root, env = process.env, fetch, now = () => new Date(), tokenOf = () => null, setupFirst = E.setupFirst }) {
  function project() {
    const { config } = loadResolved(root, { env });
    if (!config) throw fail(409, setupFirst);
    if (config.pack !== 'salesforce' || config.salesforce?.release !== 'gearset') throw fail(400, E.notGearset);
    return { config, layout: layout(config.salesforce, config) };
  }

  const savedOf = (config) => (isPipelineId(config.salesforce?.gearset?.pipelineId) ? config.salesforce.gearset.pipelineId : null);

  function current() {
    const { config, layout: l } = project();
    return { pipelineId: savedOf(config), stages: l.stages.map((s) => ({ name: s.name, org: s.org, orgId: s.orgId })) };
  }

  async function read(body) {
    const { config, layout: l } = project();
    const empty = hasKeys(body, []);
    if (!empty && !hasKeys(body, ['pipelineId'])) throw fail(400, E.badBody);
    if (!empty && !isPipelineId(body.pipelineId)) throw fail(400, E.badPipeline);
    const token = tokenOf();
    if (typeof token !== 'string' || token.trim() === '') throw fail(409, E.tokenFirst);

    const listed = await gearsetPipelines({ fetch, token: token.trim() });
    if (!listed.ok) return { ok: false, error: words(listed) };
    const { pipelines } = listed;
    const saved = savedOf(config);
    const chosen = (empty ? null : body.pipelineId) ?? saved ?? (pipelines.length === 1 ? pipelines[0].id : null);
    if (chosen === null) return { ok: true, pipelines, pipelineId: null, saved, rows: [], missing: [] };
    if (!pipelines.some((p) => p.id === chosen)) return { ok: false, error: E.badPipeline, pipelines };

    const envs = await gearsetEnvironments({ fetch, token: token.trim(), pipelineId: chosen, pipelineIds: pipelines.map((p) => p.id) });
    if (!envs.ok) return { ok: false, error: Object.hasOwn(envs, 'status') ? words(envs) : E.badPipeline };
    const { rows, missing } = matchEnvironments(envs.environments, { orgs: l.orgs, stages: l.stages });
    return { ok: true, pipelines, pipelineId: chosen, saved, rows, missing };
  }

  function save(body) {
    project();
    if (!hasKeys(body, ['pipelineId'])) throw fail(400, E.badBody);
    const id = body.pipelineId;
    if (!isPipelineId(id)) throw fail(400, E.badPipeline);
    const team = readTeam(root);
    if (team.errors) throw fail(409, setupFirst);
    const block = isPlain(team.raw.salesforce) ? team.raw.salesforce : {};
    const gearset = isPlain(block.gearset) ? block.gearset : {};
    if (gearset.pipelineId === id) return { ok: true, lines: [E.nothingChanged], gearset: current() };
    let errors;
    try {
      // The block starts from the pack's defaults, so promote is written as it resolves now.
      ({ errors } = teamSet(root, 'salesforce.gearset', { ...BLOCK_DEFAULTS.gearset, ...gearset, pipelineId: id }));
    } catch {
      // A failed write: the fs error names paths and codes, so it never reaches the answer.
      throw fail(500, E.notSaved);
    }
    if (errors.length) throw fail(400, errors.join('; '));
    return { ok: true, lines: [`set salesforce.gearset.pipelineId to ${id}`, COMMIT_REMINDER], gearset: current() };
  }

  function confirm(body, { stateDir }) {
    const { layout: l } = project();
    if (!hasKeys(body, ['stage', 'confirmed']) || typeof body.confirmed !== 'boolean') throw fail(400, E.badBody);
    const stage = l.stages.find((s) => s.name === body.stage);
    if (!stage) throw fail(400, E.badStage);
    const item = `ci-tests-${stage.name}`;
    if (!body.confirmed) {
      clearConfirmedByYou(stateDir, STEP, item);
      return { ok: true, stage: stage.name, confirmedAt: null };
    }
    const at = now().toISOString();
    markConfirmedByYou(stateDir, STEP, item, at);
    return { ok: true, stage: stage.name, confirmedAt: at };
  }

  return { current, read, save, confirm };
}
