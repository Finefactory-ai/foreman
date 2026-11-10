// gearset-promote in owner mode, end to end through `foreman release watch`: the step parks
// S-1 ready to promote, a watch with the promotion PR still open keeps the park, and a later
// watch, after the owner clicked Promote and the qa org shows the deploy, moves S-1 to Done and
// removes the park. The watch finds gearset-promote-qa through the real pack's step table.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gearsetPromote } from './gearset-promote.mjs';
import { makeReleaseCommand } from '../../../lib/cli/commands/release.mjs';
import { loadResolved } from '../../../lib/settings/load.mjs';
import { stateDir } from '../../../lib/engine/paths.mjs';
import { READY, parkStory, readPark } from '../../../lib/engine/parks.mjs';
import { openStorySource } from '../../../lib/engine/story-source.mjs';
import { PACKS } from '../../index.mjs';
import { fakeCtx, fakeSh } from '../../../../test/ship-fakes.mjs';
import { ACME_DEV1_ID, ACME_QA_ID, ACME_UAT_ID, sfOk } from '../../../../test/fake-sf.mjs';

const NOW = new Date(Date.UTC(2026, 9, 15, 13, 0, 0));
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const PROMO = 'https://github.com/acme/app/pull/2';
const QA_LIST = 'gh pr list --head gs-pipeline/story/s-1_-_qa --base qa --state all --json number,url,state,headRefOid,mergedAt,isCrossRepository';
const SF_QUERY = /^sf data query --use-tooling-api --query SELECT Id, Status, CheckOnly, CompletedDate, NumberTestsCompleted FROM DeployRequest .* --target-org acme-qa /;

const promo = (over = {}) => ({ number: 2, url: PROMO, state: 'OPEN', headRefOid: SHA, mergedAt: null, isCrossRepository: false, ...over });
const list = (...prs) => JSON.stringify(prs);
const deployed = sfOk({ records: [{ Id: '0Af000000000001AAA', Status: 'Succeeded', CheckOnly: false, CompletedDate: '2026-10-15T12:31:00.000+0000', NumberTestsCompleted: 4 }], totalSize: 1, done: true });

let root;
let sfHome;
let env;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-gspromote-watch-'));
  sfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-gspromote-watch-sf-'));
  fs.mkdirSync(path.join(root, 'stories'));
  fs.writeFileSync(path.join(root, 'stories', 'S-1.md'), '---\nid: S-1\ntitle: Acme sign in\nstatus: in-progress\n---\n\n# S-1\n\n## Progress notes\n\n_Newest first._\n');
  fs.writeFileSync(
    path.join(root, 'foreman.config.json'),
    JSON.stringify({
      version: 1,
      project: { name: 'Acme' },
      baseBranch: 'main',
      pack: 'salesforce',
      stories: { adapter: 'markdown', dir: 'stories' },
      salesforce: {
        productionBranch: 'main',
        orgs: { 'acme-dev1': { orgId: ACME_DEV1_ID }, 'acme-qa': { orgId: ACME_QA_ID }, 'acme-uat': { orgId: ACME_UAT_ID } },
        build: ['acme-dev1'],
        stages: [{ name: 'qa', org: 'acme-qa', branch: 'qa' }, { name: 'uat', org: 'acme-uat', branch: 'uat' }],
        stopAt: 'qa',
        release: 'gearset',
        gearset: { promote: 'owner' },
      },
    }),
  );
  env = { FOREMAN_PROJECT_DIR: root, HOME: path.join(root, 'home'), GEARSET_API_TOKEN: '', FOREMAN_SF_HOME: sfHome };
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(sfHome, { recursive: true, force: true });
});

const io = () => {
  const o = { out: '', err: '' };
  o.ctx = { cwd: root, root, env, now: () => NOW, stdout: { write: (s) => { o.out += s; } }, stderr: { write: (s) => { o.err += s; } } };
  o.last = () => JSON.parse(o.out.trim().split('\n').at(-1));
  return o;
};

const watch = async (rules) => {
  const sh = fakeSh(rules);
  const o = io();
  const code = await makeReleaseCommand({ sh, packs: PACKS }).run(['watch'], o.ctx);
  return { code, last: o.last(), sh };
};

describe('gearset-promote in owner mode through foreman release watch', () => {
  it('keeps the park while the promotion PR is open, then finishes the release once qa is deployed', async () => {
    const { config, errors } = loadResolved(root, { env, packs: PACKS });
    expect(errors).toEqual([]);
    const dir = stateDir(root, config, env);
    const statusOf = (id) => openStorySource({ root, config, now: () => NOW, env }).list().find((s) => s.id === id).status;

    // The step parks S-1 for the owner's Promote click.
    const ctx = fakeCtx({ config, rules: [[QA_LIST, list(promo())]], env, branch: 'story/s-1', root });
    const r = await gearsetPromote('qa').run(ctx);
    expect(r).toMatchObject({ ok: true, parked: { check: { branch: 'story/s-1', stages: [{ name: 'qa', org: 'acme-qa' }] } } });
    const parked = await parkStory({ dir, root, config, env, now: () => NOW }, { id: 'S-1', step: 'gearset-promote-qa', reason: r.parked.reason, check: r.parked.check, pr: PROMO });
    expect(parked).toEqual({ parkSaved: true, storyUpdated: true });
    expect(statusOf('S-1')).toBe(READY);

    // Not promoted yet: the park stays.
    const waiting = await watch([[QA_LIST, list(promo())]]);
    expect(waiting.code).toBe(0);
    expect(waiting.last).toMatchObject({ ok: true, checked: 1, results: [{ id: 'S-1', step: 'gearset-promote-qa', outcome: 'waiting', detail: 'waiting for you to click Promote for qa in Gearset (pull request #2)' }] });
    expect(readPark(dir, 'S-1')).toMatchObject({ id: 'S-1', lastCheck: { outcome: 'waiting' } });
    expect(statusOf('S-1')).toBe(READY);

    // Promoted and deployed: S-1 is done and the park is gone.
    const done = await watch([[QA_LIST, list(promo({ state: 'MERGED', mergedAt: '2026-10-15T12:30:00Z' }))], [SF_QUERY, deployed]]);
    expect(done.code).toBe(0);
    expect(done.last).toMatchObject({ ok: true, checked: 1, results: [{ id: 'S-1', outcome: 'done' }] });
    expect(done.sh.calls.some((l) => l.startsWith('gh pr merge'))).toBe(false);
    expect(statusOf('S-1')).toBe('done');
    expect(readPark(dir, 'S-1')).toBeNull();
  });
});
