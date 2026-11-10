// The Gearset set-up step: the pipeline picker, its environment table and the owner's
// test-level confirmations. The fake Gearset is the injected fetch; no token ever comes back.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gearsetSetup } from './gearset.mjs';
import { GEARSET_SCREEN } from './gearset-screen.mjs';
import { readRecord } from './record.mjs';
import { COMMIT_REMINDER } from '../settings/change.mjs';
import { ACME_DEV1_ID, ACME_QA_ID, ACME_UAT_ID } from '../../../test/fake-sf.mjs';
import { PIPELINES, acmeGearset, acmeTwoPipelines, environmentsOf, fakeGearset } from '../../../test/fake-gearset.mjs';

// teamSet passes through to the real one unless a test sets teamSetHook.fn.
const teamSetHook = vi.hoisted(() => ({ fn: null }));
vi.mock('../settings/team.mjs', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, teamSet: (...a) => (teamSetHook.fn ?? real.teamSet)(...a) };
});

const E = GEARSET_SCREEN.errors;
const TOKEN = 'gs-acme-secret-0123456789';
const NOW = new Date('2026-10-24T09:00:00.000Z');

let root;
let stateDir;
const file = () => join(root, 'foreman.config.json');
const saved = () => JSON.parse(readFileSync(file(), 'utf8'));

const block = (over = {}) => ({
  productionBranch: 'main',
  orgs: { 'acme-dev1': { orgId: ACME_DEV1_ID }, 'acme-qa': { orgId: ACME_QA_ID }, 'acme-uat': { orgId: ACME_UAT_ID } },
  build: ['acme-dev1'],
  stages: [{ name: 'qa', org: 'acme-qa', branch: 'qa' }, { name: 'uat', org: 'acme-uat', branch: 'uat' }],
  release: 'gearset',
  ...over,
});
function project(salesforce = block(), extra = {}) {
  writeFileSync(file(), `${JSON.stringify({ version: 1, project: { name: 'Acme' }, pack: 'salesforce', salesforce, ...extra }, null, 2)}\n`);
}
const setup = ({ fetch = fakeGearset(), token = TOKEN } = {}) => ({
  fetch,
  gs: gearsetSetup({ root, env: { FOREMAN_STATE_DIR: stateDir }, fetch, now: () => NOW, tokenOf: () => token }),
});
const refused = (fn) => {
  try {
    fn();
  } catch (err) {
    return { status: err.status, message: err.message };
  }
  throw new Error('expected a refusal');
};
const refusedAsync = async (fn) => {
  try {
    await fn();
  } catch (err) {
    return { status: err.status, message: err.message };
  }
  throw new Error('expected a refusal');
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'foreman-gearset-setup-'));
  stateDir = join(root, '.foreman');
});
afterEach(() => {
  teamSetHook.fn = null;
  rmSync(root, { recursive: true, force: true });
});

describe('current', () => {
  it('reads the pipeline ID and the stages, with no network', () => {
    project(block({ gearset: { promote: 'merge', pipelineId: 'pipe-1' } }));
    const { fetch, gs } = setup();
    expect(gs.current()).toEqual({
      pipelineId: 'pipe-1',
      stages: [{ name: 'qa', org: 'acme-qa', orgId: ACME_QA_ID }, { name: 'uat', org: 'acme-uat', orgId: ACME_UAT_ID }],
    });
    expect(fetch.calls).toEqual([]);
    project();
    expect(gs.current().pipelineId).toBeNull();
  });

  it('is a 409 with no config, and a 400 on a project that does not release through Gearset', () => {
    const { gs } = setup();
    expect(refused(() => gs.current())).toEqual({ status: 409, message: E.setupFirst });
    project(block({ release: 'sf' }));
    expect(refused(() => gs.current())).toEqual({ status: 400, message: E.notGearset });
    writeFileSync(file(), JSON.stringify({ version: 1, project: { name: 'Acme' } }));
    expect(refused(() => gs.current())).toEqual({ status: 400, message: E.notGearset });
  });
});

describe('read', () => {
  it('picks the only pipeline, and matches QA to the qa stage and UAT to uat', async () => {
    project();
    const { fetch, gs } = setup();
    const r = await gs.read({});
    expect(r).toMatchObject({ ok: true, pipelines: [{ id: 'pipe-1', name: 'Acme', enabled: null }], pipelineId: 'pipe-1', saved: null, missing: [] });
    expect(r.rows.map((x) => [x.name, x.alias, x.stage, x.ciJob, x.flag])).toEqual([
      ['QA', 'acme-qa', 'qa', 'enabled', null],
      ['UAT', 'acme-uat', 'uat', 'enabled', null],
    ]);
    expect(fetch.calls.map((c) => c.path)).toEqual([PIPELINES, environmentsOf('pipe-1')]);
  });

  it("uses the config's pipeline, and the body's over it", async () => {
    project(block({ gearset: { pipelineId: 'pipe-2' } }));
    const { fetch, gs } = setup({ fetch: fakeGearset(acmeTwoPipelines()) });
    const listings = () => fetch.calls.filter((c) => c.path === PIPELINES).length;
    const r = await gs.read({});
    expect(listings()).toBe(1);
    expect(r).toMatchObject({ ok: true, pipelineId: 'pipe-2', saved: 'pipe-2', missing: ['uat'] });
    expect(r.pipelines.map((p) => p.id)).toEqual(['pipe-1', 'pipe-2']);
    expect(r.rows.map((x) => [x.name, x.flag])).toEqual([['Legacy QA', null], ['Scratch', 'unmatched'], ['Live', 'production']]);
    const picked = await gs.read({ pipelineId: 'pipe-1' });
    expect(listings()).toBe(2);
    expect(picked).toMatchObject({ ok: true, pipelineId: 'pipe-1', saved: 'pipe-2', missing: [] });
    expect(fetch.calls.some((c) => c.path === environmentsOf('pipe-1'))).toBe(true);
  });

  it('with several pipelines and none chosen, lists them and reads no environments', async () => {
    project();
    const { fetch, gs } = setup({ fetch: fakeGearset(acmeTwoPipelines()) });
    expect(await gs.read({})).toEqual({
      ok: true,
      pipelines: [{ id: 'pipe-1', name: 'Acme', enabled: true }, { id: 'pipe-2', name: 'Acme Legacy', enabled: false }],
      pipelineId: null,
      saved: null,
      rows: [],
      missing: [],
    });
    expect(fetch.calls.map((c) => c.path)).toEqual([PIPELINES]);
  });

  it('answers a pipeline Gearset does not list with badPipeline, still listing the pipelines', async () => {
    project();
    const { gs } = setup({ fetch: fakeGearset(acmeTwoPipelines()) });
    const r = await gs.read({ pipelineId: 'pipe-9' });
    expect(r).toMatchObject({ ok: false, error: E.badPipeline });
    expect(r.pipelines.map((p) => p.id)).toEqual(['pipe-1', 'pipe-2']);
  });

  it('is a 409 tokenFirst with no token, and asks Gearset nothing', async () => {
    project();
    const { fetch, gs } = setup({ token: null });
    expect(await refusedAsync(() => gs.read({}))).toEqual({ status: 409, message: E.tokenFirst });
    expect(fetch.calls).toEqual([]);
  });

  it("answers Gearset's refusals in the screen's words, never its text or the token", async () => {
    project();
    const cases = [
      [{ status: 401, body: { Message: `bad token ${TOKEN}` } }, E.badToken],
      [{ status: 403, body: { Message: 'tier' } }, E.tier],
      [{ status: 429, body: {} }, E.tooMany],
      [new Error(`ECONNRESET ${TOKEN}`), E.unreachable],
      [{ status: 500, body: { Message: 'Gearset broke' } }, E.other.replace('{status}', '500')],
    ];
    for (const [answer, error] of cases) {
      const { gs } = setup({ fetch: fakeGearset(acmeGearset({ [PIPELINES]: answer })) });
      const r = await gs.read({});
      expect(r, error).toEqual({ ok: false, error });
      expect(JSON.stringify(r)).not.toContain(TOKEN);
      expect(JSON.stringify(r)).not.toContain('Gearset broke');
    }
    const { gs } = setup({ fetch: fakeGearset(acmeGearset({ [environmentsOf('pipe-1')]: { status: 401, body: {} } })) });
    expect(await gs.read({})).toEqual({ ok: false, error: E.badToken });
  });

  it('refuses a bad pipelineId with a 400 that does not repeat it, and asks Gearset nothing', async () => {
    project();
    const { fetch, gs } = setup();
    for (const body of [{ pipelineId: '../evil' }, { pipelineId: 7 }, { pipelineId: '' }]) {
      const r = await refusedAsync(() => gs.read(body));
      expect(r).toEqual({ status: 400, message: E.badPipeline });
      expect(r.message).not.toContain('evil');
    }
    expect(await refusedAsync(() => gs.read({ other: 1 }))).toEqual({ status: 400, message: E.badBody });
    expect(fetch.calls).toEqual([]);
  });
});

describe('save', () => {
  it('writes salesforce.gearset.pipelineId, keeping promote, and says to commit it', () => {
    project();
    const { fetch, gs } = setup();
    const r = gs.save({ pipelineId: 'pipe-1' });
    expect(r).toEqual({ ok: true, lines: ['set salesforce.gearset.pipelineId to pipe-1', COMMIT_REMINDER], gearset: gs.current() });
    expect(saved().salesforce.gearset).toEqual({ promote: 'merge', pipelineId: 'pipe-1' });
    expect(gs.current().pipelineId).toBe('pipe-1');
    expect(fetch.calls).toEqual([]);
  });

  it("keeps the file's own promote", () => {
    project(block({ gearset: { promote: 'owner' } }));
    setup().gs.save({ pipelineId: 'pipe-2' });
    expect(saved().salesforce.gearset).toEqual({ promote: 'owner', pipelineId: 'pipe-2' });
  });

  it('writes nothing when the file already has that pipeline', () => {
    project(block({ gearset: { promote: 'merge', pipelineId: 'pipe-1' } }));
    const before = statSync(file()).mtimeMs;
    const text = readFileSync(file(), 'utf8');
    const r = setup().gs.save({ pipelineId: 'pipe-1' });
    expect(r.lines).toEqual([E.nothingChanged]);
    expect(statSync(file()).mtimeMs).toBe(before);
    expect(readFileSync(file(), 'utf8')).toBe(text);
  });

  it('refuses another body, or an ID that fails the rule, with a 400 that does not repeat it', () => {
    project();
    const { gs } = setup();
    expect(refused(() => gs.save({ pipelineId: 'pipe-1', promote: 'owner' }))).toEqual({ status: 400, message: E.badBody });
    expect(refused(() => gs.save({}))).toEqual({ status: 400, message: E.badBody });
    expect(refused(() => gs.save(null))).toEqual({ status: 400, message: E.badBody });
    const bad = refused(() => gs.save({ pipelineId: 'a b/../c' }));
    expect(bad).toEqual({ status: 400, message: E.badPipeline });
    expect(bad.message).not.toContain('a b');
    expect(saved().salesforce.gearset).toBeUndefined();
  });

  it('answers notSaved with a 500 when the file cannot be written, and never the fs text', () => {
    project();
    const { gs } = setup();
    teamSetHook.fn = () => {
      throw new Error("EACCES: permission denied, open '" + file() + "'");
    };
    const r = refused(() => gs.save({ pipelineId: 'pipe-1' }));
    expect(r).toEqual({ status: 500, message: E.notSaved });
    expect(r.message).not.toContain('EACCES');
    expect(r.message).not.toContain(root);
    expect(saved().salesforce.gearset).toBeUndefined();
  });

  it("still passes teamSet's own validation errors as a 400", () => {
    project();
    const { gs } = setup();
    teamSetHook.fn = () => ({ errors: ['salesforce.gearset.promote: must be merge or owner'] });
    expect(refused(() => gs.save({ pipelineId: 'pipe-1' }))).toEqual({ status: 400, message: 'salesforce.gearset.promote: must be merge or owner' });
  });

  it('is a 400 notGearset on another release, and a 409 with no config', () => {
    const { gs } = setup();
    expect(refused(() => gs.save({ pipelineId: 'pipe-1' }))).toEqual({ status: 409, message: E.setupFirst });
    project(block({ release: 'sf' }));
    expect(refused(() => gs.save({ pipelineId: 'pipe-1' }))).toEqual({ status: 400, message: E.notGearset });
  });
});

describe('confirm', () => {
  it("writes confirmed by you only, and false clears it", () => {
    project();
    const { gs } = setup();
    expect(gs.confirm({ stage: 'qa', confirmed: true }, { stateDir })).toEqual({ ok: true, stage: 'qa', confirmedAt: NOW.toISOString() });
    const step = readRecord(stateDir).steps['sf-gearset'];
    expect(step).toEqual({ runs: [], confirmedByYou: { 'ci-tests-qa': NOW.toISOString() } });
    expect(step.checkedAt).toBeUndefined();
    expect(step.confirmedAt).toBeUndefined();
    gs.confirm({ stage: 'uat', confirmed: true }, { stateDir });
    expect(gs.confirm({ stage: 'qa', confirmed: false }, { stateDir })).toEqual({ ok: true, stage: 'qa', confirmedAt: null });
    expect(readRecord(stateDir).steps['sf-gearset'].confirmedByYou).toEqual({ 'ci-tests-uat': NOW.toISOString() });
  });

  it('refuses an unknown stage without naming it, and any other body', () => {
    project();
    const { gs } = setup();
    const r = refused(() => gs.confirm({ stage: 'prodx', confirmed: true }, { stateDir }));
    expect(r).toEqual({ status: 400, message: E.badStage });
    expect(r.message).not.toContain('prodx');
    expect(refused(() => gs.confirm({ stage: 'qa', confirmed: 'yes' }, { stateDir }))).toEqual({ status: 400, message: E.badBody });
    expect(refused(() => gs.confirm({ stage: 'qa' }, { stateDir }))).toEqual({ status: 400, message: E.badBody });
    expect(refused(() => gs.confirm({ stage: 'qa', confirmed: true, at: 'x' }, { stateDir }))).toEqual({ status: 400, message: E.badBody });
    expect(readRecord(stateDir).steps['sf-gearset']).toBeUndefined();
  });
});
