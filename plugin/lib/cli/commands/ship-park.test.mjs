// `foreman ship` end to end for a release that finishes later: a pack step parks it, against
// the fake Atlassian, with the real runner. The story is left ready-to-promote with its slot
// free, the Jira comment written and no move to Done, and the park stored in state.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeShipCommand } from './ship.mjs';
import { writeToken } from '../../jira/auth.mjs';
import { adfToMarkdown } from '../../jira/adf.mjs';
import { endStory, readSlot, startStory } from '../../engine/state.mjs';
import { readPark } from '../../engine/parks.mjs';
import { classifyRun } from '../../engine/classify.mjs';
import { outcome } from '../../engine/scheduler.mjs';
import { startFakeJira } from '../../../../test/fake-jira.mjs';
import { fakeSh } from '../../../../test/ship-fakes.mjs';
import { fakePack } from '../../../../test/fake-pack.mjs';

const SITE = 'acme.atlassian.net';
const NOW = new Date(2026, 9, 23, 12, 0, 0);
const REASON = 'click Promote in Acme';
let jira;
let dir;
let env;
let state;

beforeAll(async () => {
  jira = await startFakeJira();
});
afterAll(async () => {
  await jira.close();
});

beforeEach(() => {
  jira.reset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-ship-park-'));
  state = path.join(dir, '.foreman');
  env = { FOREMAN_PROJECT_DIR: dir, FOREMAN_SLOT: 'w1', HOME: path.join(dir, 'home'), FOREMAN_JIRA_API_BASE: jira.url, FOREMAN_JIRA_AUTH_BASE: jira.url };
  writeToken(SITE, { cloudId: jira.cloudId, site: SITE, ...jira.tokens, expiresAt: '2999-01-01T00:00:00.000Z' }, { env });
  fs.writeFileSync(
    path.join(dir, 'foreman.config.json'),
    JSON.stringify({
      version: 1,
      project: { name: 'Acme' },
      pack: 'acme',
      ship: { steps: ['acme-promote', 'acme-after'] },
      stories: { adapter: 'jira', site: SITE, jql: 'project = APP ORDER BY rank', transitions: { shipped: 'Done' } },
    }),
  );
  jira.addIssue({ key: 'APP-12', summary: 'Sign in' });
});

describe('foreman ship with a step that parks the release', () => {
  it('leaves the story ready-to-promote with its slot free, the comment written and the park stored', async () => {
    const after = { name: 'acme-after', ran: 0, async run() { this.ran++; return { ok: true }; } };
    const command = makeShipCommand({
      sh: fakeSh([['git rev-parse --abbrev-ref HEAD', 'story/app-12\n'], ['git status --porcelain', ''], ['git rev-list --count', '1\n']]),
      packs: {
        acme: fakePack({
          steps: {
            'acme-promote': { name: 'acme-promote', run: async () => ({ ok: true, parked: { reason: REASON, check: { deployId: 'D-1' } } }) },
            'acme-after': after,
          },
        }),
      },
    });
    startStory(state, { id: 'APP-12', title: 'Sign in' }, NOW, 'w1');

    let out = '';
    const code = await command.run(['--story', 'APP-12'], {
      cwd: dir,
      root: dir,
      env,
      now: () => NOW,
      stdout: { write: (s) => { out += s; } },
      stderr: { write: () => {} },
    });
    const last = JSON.parse(out.trim().split('\n').at(-1));

    // The release stopped at the park, and nothing is left holding the release line.
    expect(code).toBe(9);
    expect(last).toMatchObject({ ok: true, code: 9, stage: 'parked', step: 'acme-promote', parkSaved: true, storyUpdated: true });
    expect(after.ran).toBe(0);
    expect(fs.existsSync(path.join(state, 'HALT'))).toBe(false);
    expect(fs.existsSync(path.join(state, 'locks', 'ship.json'))).toBe(false);

    // (4) The park, with its step and check.
    expect(readPark(state, 'APP-12')).toMatchObject({ id: 'APP-12', step: 'acme-promote', reason: REASON, check: { deployId: 'D-1' }, slot: 'w1' });
    expect(fs.existsSync(path.join(state, 'parks', 'APP-12.json'))).toBe(true);

    // (3) The comment, and no move to Done.
    expect(jira.comments('APP-12').map((c) => adfToMarkdown(c.body))).toEqual([`Foreman: ready to promote: ${REASON}`]);
    expect(jira.issue('APP-12').status).not.toBe('done');

    // (1) The story is ready-to-promote.
    const overlay = JSON.parse(fs.readFileSync(path.join(state, 'stories', 'APP-12.json'), 'utf8'));
    expect(overlay.status).toBe('ready-to-promote');

    // (2) The session ends the story, which frees its slot.
    endStory(state, 'ready-to-promote', '', REASON, NOW, 'w1');
    expect(readSlot(state, 'w1').story).toBeNull();
    const o = outcome({ result: classifyRun('FACTORY_RESULT: ready-to-promote APP-12').result });
    expect(o).toMatchObject({ slot: 'idle', claim: 'release' });
  });
});
