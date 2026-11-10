// `foreman release watch` end to end against the fake Atlassian: `foreman ship` parks APP-12
// through an Acme pack step, the dashboard lists it as ready to promote, and a brand-new
// command (a restart: nothing shared in memory) checks the park until the release finishes and
// APP-12 is Done in Jira.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeShipCommand } from './ship.mjs';
import { makeReleaseCommand } from './release.mjs';
import { writeToken } from '../../jira/auth.mjs';
import { adfToMarkdown } from '../../jira/adf.mjs';
import { snapshot } from '../../engine/state.mjs';
import { readPark, savePark } from '../../engine/parks.mjs';
import { createDashboardServer } from '../../dashboard/server.mjs';
import { loadResolved } from '../../settings/load.mjs';
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-release-'));
  state = path.join(dir, '.foreman');
  env = { FOREMAN_PROJECT_DIR: dir, FOREMAN_SLOT: 'w1', HOME: path.join(dir, 'home'), FOREMAN_JIRA_API_BASE: jira.url, FOREMAN_JIRA_AUTH_BASE: jira.url };
  writeToken(SITE, { cloudId: jira.cloudId, site: SITE, ...jira.tokens, expiresAt: '2999-01-01T00:00:00.000Z' }, { env });
  fs.writeFileSync(
    path.join(dir, 'foreman.config.json'),
    JSON.stringify({
      version: 1,
      project: { name: 'Acme' },
      pack: 'acme',
      ship: { steps: ['acme-promote'] },
      stories: { adapter: 'jira', site: SITE, jql: 'project = APP ORDER BY rank', transitions: { shipped: 'Done' } },
    }),
  );
  jira.addIssue({ key: 'APP-12', summary: 'Sign in' });
});

// A fresh Acme pack each time, as a new process would load it. `check` answers the watch. Its
// step declares GEARSET_API_TOKEN, the one registry name a release step needs.
const acmePacks = (check) => ({
  acme: fakePack({
    steps: {
      'acme-promote': {
        name: 'acme-promote',
        requires: { env: ['GEARSET_API_TOKEN'] },
        run: async () => ({ ok: true, parked: { reason: REASON, check: { deployId: 'D-1' } } }),
        ...(check ? { check } : {}),
      },
    },
  }),
});

const io = () => {
  const o = { out: '', err: '' };
  o.ctx = { cwd: dir, root: dir, env, now: () => NOW, stdout: { write: (s) => { o.out += s; } }, stderr: { write: (s) => { o.err += s; } } };
  o.last = () => JSON.parse(o.out.trim().split('\n').at(-1));
  return o;
};

const ship = async () => {
  const command = makeShipCommand({
    sh: fakeSh([['git rev-parse --abbrev-ref HEAD', 'story/app-12\n'], ['git status --porcelain', ''], ['git rev-list --count', '1\n']]),
    packs: acmePacks(),
  });
  const o = io();
  const code = await command.run(['--story', 'APP-12'], o.ctx);
  return { code, last: o.last() };
};

const watch = async (check, args = ['watch']) => {
  const o = io();
  const code = await makeReleaseCommand({ sh: fakeSh(), packs: acmePacks(check) }).run(args, o.ctx);
  return { code, o };
};

const comments = () => jira.comments('APP-12').map((c) => adfToMarkdown(c.body));

async function apiStatus() {
  const { config } = loadResolved(dir, { env, packs: acmePacks() });
  const server = createDashboardServer({ root: dir, config, stateDir: state, env: {}, now: () => NOW });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await (await fetch(`http://127.0.0.1:${server.address().port}/api/status`)).json();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('foreman release watch', () => {
  it('finishes a parked release after a restart, and APP-12 ends Done in Jira', async () => {
    // foreman ship parks APP-12.
    const shipped = await ship();
    expect(shipped.code).toBe(9);
    expect(shipped.last).toMatchObject({ stage: 'parked', step: 'acme-promote', parkSaved: true });

    // The dashboard lists it while it is parked.
    const snap = await snapshot(state, NOW, null, { root: dir });
    expect(snap.parked).toEqual([expect.objectContaining({ id: 'APP-12', step: 'acme-promote', reason: REASON })]);
    const served = await apiStatus();
    expect(served.parked).toEqual([expect.objectContaining({ id: 'APP-12', step: 'acme-promote', reason: REASON, lastCheck: null })]);

    // A brand-new command: the promotion is not clicked yet.
    const seen = [];
    const waiting = await watch(async (ctx) => {
      seen.push(ctx);
      return { ok: true, done: false, detail: 'waiting for the click' };
    });
    expect(waiting.code).toBe(0);
    expect(waiting.o.last()).toMatchObject({ ok: true, checked: 1, results: [{ id: 'APP-12', step: 'acme-promote', outcome: 'waiting' }] });
    expect(seen[0]).toMatchObject({ story: 'APP-12', slot: 'w1', check: { deployId: 'D-1' } });
    expect(typeof seen[0].sh).toBe('function');
    expect(jira.issue('APP-12').status).not.toBe('done');
    expect(readPark(state, 'APP-12')).toMatchObject({ id: 'APP-12', lastCheck: { outcome: 'waiting', detail: 'waiting for the click' } });

    // Another new command: the promotion went through.
    const done = await watch(async () => ({ ok: true, done: true, note: 'promoted to Acme production' }));
    expect(done.code).toBe(0);
    expect(done.o.last()).toMatchObject({ ok: true, checked: 1, results: [{ id: 'APP-12', outcome: 'done' }] });
    const overlay = JSON.parse(fs.readFileSync(path.join(state, 'stories', 'APP-12.json'), 'utf8'));
    expect(overlay.status).toBe('done');
    expect(jira.issue('APP-12').status).toBe('done');
    expect(comments().at(-1)).toBe('Foreman: Released: promoted to Acme production');
    expect(readPark(state, 'APP-12')).toBeNull();
    expect((await snapshot(state, NOW, null, { root: dir })).parked).toEqual([]);
    expect((await apiStatus()).parked).toEqual([]);
  });

  it('a hard failure comments on the issue, leaves it not done and removes the park', async () => {
    expect((await ship()).code).toBe(9);
    const { code, o } = await watch(async () => ({ ok: false, reason: 'Acme refused the promotion' }));
    expect(code).toBe(0);
    expect(o.last().results).toEqual([expect.objectContaining({ id: 'APP-12', outcome: 'failed' })]);
    expect(comments().at(-1)).toBe('Foreman: Release failed: Acme refused the promotion');
    expect(jira.issue('APP-12').status).not.toBe('done');
    expect(readPark(state, 'APP-12')).toBeNull();
    expect(fs.existsSync(path.join(state, 'HALT'))).toBe(false);
  });

  it('gives the check only the registry names the steps declare, from .env.foreman', async () => {
    fs.writeFileSync(path.join(dir, '.env.foreman'), 'GEARSET_API_TOKEN=gs_acme_file\nRESEND_API_KEY=re_acme_file\n');
    const NAMES = ['GEARSET_API_TOKEN', 'RESEND_API_KEY'];
    const saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
    for (const n of NAMES) delete process.env[n];
    const before = { ...env };
    try {
      expect((await ship()).code).toBe(9);
      env = { ...before };
      const seen = [];
      const { code, o } = await watch(async (ctx) => {
        seen.push({ gearset: ctx.env.GEARSET_API_TOKEN === 'gs_acme_file', resend: 'RESEND_API_KEY' in ctx.env });
        return { ok: true, done: false };
      });
      expect(code).toBe(0);
      expect(seen).toEqual([{ gearset: true, resend: false }]);
      expect(o.out).not.toContain('acme_file');
    } finally {
      env = before;
      for (const n of NAMES) {
        if (saved[n] === undefined) delete process.env[n];
        else process.env[n] = saved[n];
      }
    }
  });

  it('says busy and checks nothing while another watch holds the lock', async () => {
    savePark(state, { id: 'APP-12', step: 'acme-promote', reason: REASON, check: {}, parkedAt: NOW.toISOString() });
    fs.mkdirSync(path.join(state, 'locks'), { recursive: true });
    fs.writeFileSync(path.join(state, 'locks', 'release-watch.json'), JSON.stringify({ pid: process.pid, by: 'release-watch', at: NOW.toISOString() }));
    let ran = 0;
    const { code, o } = await watch(async () => { ran++; return { ok: true }; });
    expect(code).toBe(0);
    expect(o.last()).toEqual({ ok: true, busy: true, reason: 'another release watch is running' });
    expect(ran).toBe(0);
    expect(fs.existsSync(path.join(state, 'locks', 'release-watch.json'))).toBe(true);
  });

  it('breaks a lock left by a watch that died, runs, and lets go of it', async () => {
    savePark(state, { id: 'APP-12', step: 'acme-promote', reason: REASON, check: {}, parkedAt: NOW.toISOString() });
    fs.mkdirSync(path.join(state, 'locks'), { recursive: true });
    fs.writeFileSync(path.join(state, 'locks', 'release-watch.json'), JSON.stringify({ pid: 99999999, by: 'release-watch', at: NOW.toISOString() }));
    let ran = 0;
    const { code, o } = await watch(async () => { ran++; return { ok: true }; });
    expect(code).toBe(0);
    expect(o.last()).toMatchObject({ ok: true, checked: 1 });
    expect(ran).toBe(1);
    expect(fs.existsSync(path.join(state, 'locks', 'release-watch.json'))).toBe(false);
  });

  it('the status API gives the last check time and outcome, never its detail', async () => {
    const lastCheck = { at: NOW.toISOString(), outcome: 'error', detail: 'acme-promote check failed: https://bot:s3cret@acme.example/deploy?token=abc' };
    savePark(state, { id: 'APP-12', step: 'acme-promote', reason: REASON, check: {}, parkedAt: NOW.toISOString(), lastCheck });
    const want = { at: NOW.toISOString(), outcome: 'error' };
    expect((await snapshot(state, NOW, null, { root: dir })).parked[0].lastCheck).toEqual(want);
    const served = await apiStatus();
    expect(served.parked[0].lastCheck).toEqual(want);
    expect(JSON.stringify(served)).not.toContain('s3cret');
  });

  it.each([[[]], [['nope']], [['watch', 'extra']], [['--x', 'watch']], [['watch', '--x']]])('%j prints usage and exits 64', async (args) => {
    const { code, o } = await watch(null, args);
    expect(code).toBe(64);
    expect(o.err).toMatch(/usage: foreman release watch/);
    expect(o.out).toBe('');
  });

  it('a bad config exits 1 with ok false', async () => {
    fs.writeFileSync(path.join(dir, 'foreman.config.json'), '{');
    const { code, o } = await watch(null);
    expect(code).toBe(1);
    expect(o.last()).toMatchObject({ ok: false });
    expect(typeof o.last().reason).toBe('string');
  });

  it('with no parks checks nothing', async () => {
    const { code, o } = await watch(null);
    expect(code).toBe(0);
    expect(o.last()).toEqual({ ok: true, checked: 0, results: [] });
  });
});
