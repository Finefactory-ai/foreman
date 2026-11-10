// The supervisor's Jira refresher: it polls on its own timer with await, so the
// supervisor's tick, which reads only the cache, never waits on Jira.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { writeToken } from './auth.mjs';
import { adfToMarkdown } from './adf.mjs';
import { jiraRefresher } from './refresher.mjs';
import { create } from '../adapters/stories/jira.mjs';
import { startFakeJiraHere } from '../../../test/fake-jira.mjs';

const SITE = 'acme.atlassian.net';
const JQL = 'project = APP ORDER BY rank';
const T0 = new Date('2026-10-17T12:00:00Z');
const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

let jira;
const dirs = [];
beforeAll(async () => {
  jira = await startFakeJiraHere();
});
afterAll(async () => {
  await jira.close();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
beforeEach(() => {
  jira.reset();
  jira.addIssue({ key: 'APP-1', summary: 'Sign in', description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Build it.' }] }] } });
  jira.addIssue({ key: 'APP-2', summary: 'Sign out' });
});

function setup({ pollSeconds = 60 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-jira-refresher-'));
  dirs.push(root);
  const env = { HOME: path.join(root, 'home'), FOREMAN_JIRA_API_BASE: jira.url, FOREMAN_JIRA_AUTH_BASE: jira.url };
  const signIn = () => writeToken(SITE, { cloudId: jira.cloudId, site: SITE, ...jira.tokens, expiresAt: '2999-01-01T00:00:00.000Z' }, { env });
  signIn();
  const stateDir = path.join(root, '.foreman');
  const options = { adapter: 'jira', site: SITE, jql: JQL, pollSeconds, transitions: { started: 'In Progress' } };
  const t = { clock: T0, expired: [] };
  const now = () => t.clock;
  // The supervisor's view: a story source that reads only the cache.
  const source = (extra = {}) => create(options, { root, stateDir, env, now, cacheOnly: true, features: { jiraComments: true, jiraTransitions: true }, ...extra });
  const refresher = jiraRefresher({
    stories: () => options,
    stateDir,
    env,
    now,
    writeBrief: (id, b) => source().writeBrief(id, b),
    onLoginExpired: (err) => t.expired.push(err.message),
  });
  return { root, env, stateDir, source, refresher, t, signIn };
}

describe('jira refresher', () => {
  it('a slow Jira never delays the tick: the tick reads the cache while the refresh waits', async () => {
    const { source, refresher } = setup();
    jira.setDelay(400);
    const started = performance.now();
    refresher.start();
    // What the supervisor's tick does: ask whether to hold picking, and read the stories.
    const hold = refresher.hold();
    const stories = source().list();
    expect(performance.now() - started).toBeLessThan(150);
    expect(hold).toMatchObject({ quiet: true });
    expect(stories).toEqual([]);
    await refresher.refresh();
    refresher.stop();
    expect(refresher.hold()).toBeNull();
    expect(source().list().map((s) => s.id)).toEqual(['APP-1', 'APP-2']);
    jira.setDelay(0);
  });

  it('pauses picking with the reason when the cache goes stale or a refresh fails, and resumes after a good one', async () => {
    const { refresher, t } = setup({ pollSeconds: 60 });
    await refresher.refresh();
    expect(refresher.hold()).toBeNull();

    t.clock = new Date(+T0 + 5 * 60_000 - 1000);
    expect(refresher.hold()).toBeNull();
    t.clock = new Date(+T0 + 5 * 60_000 + 1000);
    expect(refresher.hold()).toEqual({ reason: `Jira not reachable since ${hhmm(T0)}: no fresh answer; picking paused, stories in progress carry on` });

    jira.setDown(500);
    const failedAt = t.clock;
    await refresher.refresh();
    const held = refresher.hold();
    expect(held.reason).toMatch(new RegExp(`^Jira not reachable since ${hhmm(failedAt)}: .*\\(500\\).*; picking paused, stories in progress carry on$`));
    // A failure even with a fresh cache holds picking.
    t.clock = new Date(+failedAt + 10_000);
    expect(refresher.hold()).toEqual(held);

    jira.setDown(false);
    await refresher.refresh();
    expect(refresher.hold()).toBeNull();
  });

  it('a lapsed sign-in notifies once, and again only after a good refresh', async () => {
    const { refresher, env, t, signIn } = setup();
    await refresher.refresh();
    fs.rmSync(env.HOME, { recursive: true, force: true });
    await refresher.refresh();
    await refresher.refresh();
    expect(t.expired).toEqual(['Jira sign-in expired; run `foreman jira login`']);
    expect(refresher.hold().reason).toMatch(/run `foreman jira login`; picking paused/);
    signIn();
    await refresher.refresh();
    expect(refresher.hold()).toBeNull();
    fs.rmSync(env.HOME, { recursive: true, force: true });
    await refresher.refresh();
    expect(t.expired).toHaveLength(2);
  });

  it('sends the writes a cache-only source queued, in order, without waiting in update', async () => {
    const { source, refresher } = setup();
    await refresher.refresh();
    let kicked = 0;
    const src = source({ onQueued: () => kicked++ });
    expect(src.update('APP-1', { status: 'in-progress', note: 'Started.', event: 'started' })).toBe(true);
    expect(kicked).toBe(1);
    expect(jira.comments('APP-1')).toEqual([]);
    await refresher.drain();
    expect(jira.comments('APP-1').map((c) => adfToMarkdown(c.body))).toEqual(['Foreman: Started.']);
    expect(jira.issue('APP-1').status).toBe('in-progress');
    // A refresh sends what is queued too.
    src.update('APP-1', { note: 'Still going.' });
    await refresher.refresh();
    expect(jira.comments('APP-1')).toHaveLength(2);
  });

  it('fetches a missing brief with await; the cache-only source then has it', async () => {
    const { source, refresher } = setup();
    await refresher.refresh();
    expect(source().brief('APP-1')).toBeNull();
    expect(refresher.briefTried('APP-1')).toBe(false);
    await refresher.fetchBrief('APP-1');
    expect(refresher.briefTried('APP-1')).toBe(true);
    const { path: file } = source().brief('APP-1');
    expect(fs.readFileSync(file, 'utf8')).toContain('## What\n\nBuild it.\n');
    // A brief Jira will not give is tried once, so the pick is not held for ever.
    expect(await refresher.fetchBrief('APP-9')).toBe(false);
    expect(refresher.briefTried('APP-9')).toBe(true);
  });
});
