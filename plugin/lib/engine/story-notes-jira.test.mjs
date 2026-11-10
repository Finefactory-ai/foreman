// What Foreman writes on the story itself (FM-333), end to end against the fake Atlassian: a story
// goes through its decision and answer, the architect's design, two rounds, a revised design, its
// pull request and its ship, and the issue's comments tell it in order, in plain words, with no
// key, no path and nothing a person cannot read. The kinds that no step of the run makes by
// itself (a session ending, a stopped release, a follow-up) are posted through the outbox too.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../cli/main.mjs';
import { writeToken } from '../jira/auth.mjs';
import { adfToMarkdown } from '../jira/adf.mjs';
import { loadResolved } from '../settings/load.mjs';
import pr from '../adapters/ship/pr.mjs';
import { openStorySource } from './story-source.mjs';
import { noteOnStory, noteSessionProgress } from './story-notes.mjs';
import { machineText, sessionEnding } from './story-note-text.mjs';
import { startFakeJira } from '../../../test/fake-jira.mjs';
import { markedSession } from '../../../test/session-fixture.mjs';
import { fakeCtx } from '../../../test/ship-fakes.mjs';

const SITE = 'acme.atlassian.net';
const SECRET = 'sk_live_abcdef123456';
let jira;
let dir;
let env;

beforeAll(async () => {
  jira = await startFakeJira();
});
afterAll(async () => {
  await jira.close();
});

const state = () => path.join(dir, '.foreman');
const texts = (key = 'APP-5') => jira.comments(key).map((c) => adfToMarkdown(c.body));
const outbox = () => {
  const folder = path.join(state(), 'jira-outbox');
  return fs.existsSync(folder) ? fs.readdirSync(folder).filter((f) => f.endsWith('.json')) : [];
};
const resolved = (features = {}) => {
  const { config } = loadResolved(dir, { env });
  return { ...config, features: { ...config.features, ...features } };
};

function configure(features = {}) {
  fs.writeFileSync(
    path.join(dir, 'foreman.config.json'),
    JSON.stringify({
      version: 1,
      project: { name: 'Acme' },
      checks: [{ run: 'npm test', when: 'always' }],
      stories: { adapter: 'jira', site: SITE, jql: 'project = APP ORDER BY rank' },
      roles: { reviewers: [{ name: 'compliance', agent: 'foreman:compliance-reviewer' }] },
      features,
    }),
  );
}

beforeEach(() => {
  jira.reset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-story-notes-jira-'));
  env = { FOREMAN_PROJECT_DIR: dir, FOREMAN_SLOT: 'w1', HOME: path.join(dir, 'home'), FOREMAN_JIRA_API_BASE: jira.url, FOREMAN_JIRA_AUTH_BASE: jira.url };
  writeToken(SITE, { cloudId: jira.cloudId, site: SITE, ...jira.tokens, expiresAt: '2999-01-01T00:00:00.000Z' }, { env });
  configure();
  jira.addIssue({ key: 'APP-5', summary: 'Profile page' });
  jira.addIssue({ key: 'APP-6', summary: 'Settings page' });
});

async function run(argv) {
  let out = '';
  let err = '';
  const code = await main(argv, { cwd: dir, env, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } });
  return { code, out, err };
}

const PLAN = { ready: true, blocker: '', needs_owner: false, builder: 'developer', resources: [], files: ['src/profile.mjs'], design: 'Add the profile page.\n\nShow the name and the email.', test_plan: 'profile.test.mjs shows the name.', done_when: 'npm test passes.' };
const REVISED = { ...PLAN, files: ['src/profile.mjs', 'src/avatar.mjs'], design: 'Add the profile page.\n\nShow the name, the email and the avatar.' };
const BLOCK = { approved: false, findings: [{ severity: 'blocker', rule: 'the page crashes without an email', where: 'src/profile.mjs:9', observed: 'it throws on a missing email', fix: 'show a dash instead' }, { severity: 'major', rule: 'the name is not escaped', where: 'src/profile.mjs:12', observed: 'a name with a tag breaks the page', fix: 'escape it' }], checked: 'ran it' };
const OK = { approved: true, findings: [], checked: 'ran it' };
const AGENTS = [
  { label: 'architect:APP-5', phase: 'Architect', agentType: 'foreman:architect', output: PLAN },
  { label: 'build:APP-5', phase: 'Build', agentType: 'foreman:builder', output: { complete: true, summary: 'Built it.', files: ['src/profile.mjs'], commands: [], problem: '' } },
  { label: 'test:APP-5#1', phase: 'Test', agentType: 'foreman:tester', output: BLOCK },
  { label: 'fix:APP-5#1', phase: 'Build', agentType: 'foreman:builder', output: { complete: true, summary: 'Fixed it.', files: ['src/profile.mjs'], commands: [], problem: '' } },
  { label: 'test:APP-5#2', phase: 'Test', agentType: 'foreman:tester', output: OK },
  { label: 'compliance:APP-5#2', phase: 'Review', agentType: 'foreman:compliance-reviewer', output: OK },
];

// The whole story, step by step, as a session and the supervisor take it.
async function tellTheStory() {
  const steps = {};
  expect((await run(['story', 'start', 'APP-5'])).code).toBe(0);
  const added = await run(['decide', 'add', '--story', 'APP-5', '--kind', 'decision', '--title', 'Which avatar service?', '--summary', 'Profiles need a picture.', '--option', 'Gravatar', '--option', 'Upload', '--hint', 'Nothing to store.', '--hint', 'Needs a bucket.', '--recommend', 'Gravatar']);
  expect(added.code, added.err).toBe(0);
  const item = added.out.trim();
  expect((await run(['decide', 'answer', item, 'Upload', '--note', `Use the cheaper one; token ${SECRET}`])).code).toBe(0);

  markedSession(state(), { slot: 'w1', story: 'APP-5', agents: AGENTS });
  noteSessionProgress({ root: dir, config: resolved(), env, slot: 'w1' });
  steps.queued = outbox().length;

  const planFile = path.join(dir, 'plan.json');
  const again = await run(['workflow-args', 'APP-5', '--save-plan']);
  expect(again.code, again.err).toBe(0);
  steps.afterSave = texts().length + outbox().length;

  fs.writeFileSync(planFile, JSON.stringify(REVISED));
  const revised = await run(['story', 'note', 'APP-5', '--kind', 'design', '--file', planFile]);
  expect(revised.code, revised.err).toBe(0);
  steps.revised = revised.out;

  const ctx = fakeCtx({
    story: 'APP-5',
    branch: 'story/app-5',
    root: dir,
    env,
    rules: [['git rev-parse --short HEAD', 'abc1234\n'], ['gh pr view story/app-5', JSON.stringify({ number: 12, url: 'https://github.com/acme/app/pull/12', state: 'OPEN' })], ['gh pr view 12 --json mergeable', 'MERGEABLE']],
  });
  expect((await pr.run(ctx)).ok).toBe(true);
  expect((await run(['story', 'done', 'APP-5', '--note', 'Shipped in #12.'])).code).toBe(0);
  return steps;
}

describe('a story told on its Jira issue, end to end', () => {
  it('shows the decision, its answer, the design, each round, the revision, the pull request and the ship, in order', async () => {
    const steps = await tellTheStory();
    const all = texts();
    expect(all.map((t) => t.split('\n')[0])).toEqual([
      'Foreman: Started.',
      'Foreman: the owner was asked: Which avatar service?',
      'Foreman: the owner answered: Which avatar service?',
      'Foreman: design',
      'Foreman: round 1 sent back',
      'Foreman: round 2 approved',
      'Foreman: design (revised)',
      'Foreman: Pull request ready for review: https://github.com/acme/app/pull/12 (commit abc1234)',
      'Foreman: Shipped in #12.',
    ]);
    // The session's notes waited in the outbox, the same design again added nothing, the revision sent them all.
    expect(steps.queued).toBe(3);
    expect(steps.afterSave).toBe(3 + 3);
    expect(steps.revised).toBe('Recorded the revised design on APP-5.\n');
    expect(outbox()).toEqual([]);

    expect(all[1]).toContain('Profiles need a picture.');
    expect(all[1]).toContain('- Gravatar (recommended): Nothing to store.');
    expect(all[1]).toContain('- Upload: Needs a bucket.');
    expect(all[3]).toContain('The architect chose the developer builder, whose work is: everything.');
    expect(all[3]).toContain('Show the name and the email.');
    expect(all[3]).toContain('profile.test.mjs shows the name.');
    expect(all[4]).toContain('The tester sent it back with 2 findings: 1 blocker and 1 major.');
    expect(all[4]).not.toContain('crashes without an email');
    expect(all[5]).toContain('The tester and the compliance reviewer approved the change.');
    expect(all[6]).toContain('It will now also change src/avatar.mjs.');
    expect(all[6]).toContain('- Show the name, the email and the avatar.');
    expect(all[6]).not.toContain('profile.test.mjs shows the name.');
    for (const text of all) expect(text.startsWith('Foreman:')).toBe(true);
  });

  it('never lets a secret, the home folder or the project path through, and every comment is for a person', async () => {
    await tellTheStory();
    const raw = JSON.stringify(jira.comments('APP-5'));
    for (const leak of [SECRET, env.HOME, dir, fs.realpathSync(dir)]) expect(raw).not.toContain(leak);
    for (const text of texts()) expect(machineText(text), text).toBeNull();
    // The owner's words are quoted, apart from the key.
    const answer = texts()[2];
    expect(answer).toContain('They chose "Upload".');
    expect(answer).toContain('Their note: "Use the cheaper one; token •••"');
  });

  it('writes nothing at all with features.jiraComments off', async () => {
    configure({ jiraComments: false });
    await tellTheStory().catch(() => {});
    expect(jira.comments('APP-5')).toEqual([]);
    expect(outbox()).toEqual([]);
    expect(fs.existsSync(path.join(state(), 'story-notes', 'posted'))).toBe(false);
  });
});

describe('the kinds no step of the run makes by itself', () => {
  const at = new Date('2026-10-31T14:05:00Z');
  const ctx = (extra = {}) => ({ root: dir, config: resolved(), env, now: () => at, ...extra });

  it('each posts exactly one comment, through the outbox when cache-only, and a send delivers it', async () => {
    expect((await run(['story', 'start', 'APP-5'])).code).toBe(0); // fills the list the cache-only source reads
    const before = texts().length;
    const cases = [
      ['session', sessionEnding({ stop: 'watchdog', watchdog: 'too-long', next: 'resume', kept: ['architect:APP-5', 'build:APP-5', 'test:APP-5#1'], session: 1 })],
      ['release', { code: 6, stage: 'merge-main', reason: 'The branch conflicts in src/profile.mjs.', pr: 'https://github.com/acme/app/pull/12' }],
      ['follow-up', { id: 'APP-9', title: 'Follow-ups from APP-5' }],
    ];
    for (const [i, [kind, data]] of cases.entries()) {
      expect(noteOnStory(ctx({ cacheOnly: true }), 'APP-5', kind, data), kind).toBe('posted');
      expect(outbox(), kind).toHaveLength(i + 1);
    }
    expect(texts()).toHaveLength(before);
    // The next write sends the queue first, in order.
    const source = openStorySource({ root: dir, config: resolved(), now: () => at, env });
    expect(source.update('APP-5', { note: 'Back to work.' })).toBe(true);
    const sent = texts().slice(before);
    expect(sent.map((t) => t.split('\n')[0])).toEqual(['Foreman: the session stopped', 'Foreman: the release stopped', 'Foreman: follow-up created', 'Foreman: Back to work.']);
    expect(sent[0]).toContain("It will resume, keeping the design, the build and the tester's approval in round 1.");
    expect(sent[1]).toContain('The branch conflicts with the base branch.');
    expect(sent[1]).toContain('The pull request: https://github.com/acme/app/pull/12');
    expect(sent[2]).toContain('Foreman created APP-9 (Follow-ups from APP-5)');
    for (const text of sent.slice(0, 3)) expect(text).toContain('At 2026-10-31 14:05 UTC, slot w1.');
    expect(outbox()).toEqual([]);
  });

  it('a note posted twice is posted once', async () => {
    await run(['story', 'start', 'APP-5']);
    const data = { code: 6, stage: 'merge-main', reason: 'x', pr: null };
    expect(noteOnStory(ctx(), 'APP-5', 'release', data)).toBe('posted');
    expect(noteOnStory(ctx(), 'APP-5', 'release', data)).toBe('repeat');
    expect(texts().filter((t) => t.startsWith('Foreman: the release stopped'))).toHaveLength(1);
  });

  it('features.jiraCommentDetail "full" lists a round\'s findings and "summary" counts them', async () => {
    await run(['story', 'start', 'APP-5']);
    const findings = BLOCK.findings.map((f) => ({ ...f, stage: 'test' }));
    const round = (n) => ({ round: n, approved: false, findings, stages: ['test'], key: `k${n}` });
    expect(noteOnStory(ctx(), 'APP-5', 'round', round(1))).toBe('posted');
    expect(noteOnStory(ctx({ config: resolved({ jiraCommentDetail: 'full' }) }), 'APP-5', 'round', round(2))).toBe('posted');
    const [summary, full] = texts().slice(-2);
    expect(summary).toContain('The tester sent it back with 2 findings: 1 blocker and 1 major.');
    expect(summary).not.toContain('crashes without an email');
    expect(full).toContain('- (blocker) The tester found that the page crashes without an email (src/profile.mjs, line 9): it throws on a missing email. Fix: show a dash instead.');
    expect(full).toContain('- (major) The tester found that the name is not escaped (src/profile.mjs, line 12): a name with a tag breaks the page. Fix: escape it.');
  });

  it('posts nothing for any kind with comments off', async () => {
    await run(['story', 'start', 'APP-5']);
    for (const [kind, data] of [['session', sessionEnding({ stop: 'watchdog', watchdog: 'quiet', next: 'resume', session: 2 })], ['release', { code: 2, stage: 'ci', reason: 'x', pr: null }], ['follow-up', { id: 'APP-9', title: 'x' }]]) {
      expect(noteOnStory(ctx({ config: resolved({ jiraComments: false }) }), 'APP-5', kind, data)).toBe('off');
    }
    expect(texts()).toHaveLength(1);
  });
});
