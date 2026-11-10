// `foreman story ...`, `foreman workflow-args` and the ship `pr` step on a project whose
// stories come from Jira, against the fake Atlassian.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../main.mjs';
import { writeToken } from '../../jira/auth.mjs';
import { adfToMarkdown } from '../../jira/adf.mjs';
import pr from '../../adapters/ship/pr.mjs';
import { startFakeJira } from '../../../../test/fake-jira.mjs';
import { fakeCtx } from '../../../../test/ship-fakes.mjs';

const SITE = 'acme.atlassian.net';
let jira;
let dir;
let env;

beforeAll(async () => {
  jira = await startFakeJira();
});
afterAll(async () => {
  await jira.close();
});

beforeEach(() => {
  jira.reset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-story-jira-'));
  env = { FOREMAN_PROJECT_DIR: dir, FOREMAN_SLOT: 'w1', HOME: path.join(dir, 'home'), FOREMAN_JIRA_API_BASE: jira.url, FOREMAN_JIRA_AUTH_BASE: jira.url };
  writeToken(SITE, { cloudId: jira.cloudId, site: SITE, ...jira.tokens, expiresAt: '2999-01-01T00:00:00.000Z' }, { env });
  fs.writeFileSync(
    path.join(dir, 'foreman.config.json'),
    JSON.stringify({
      version: 1,
      project: { name: 'T' },
      checks: [{ run: 'npm test', when: 'always' }],
      stories: { adapter: 'jira', site: SITE, jql: 'project = APP ORDER BY rank' },
    }),
  );
  jira.addIssue({ key: 'APP-12', summary: 'Sign in', description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Build sign in.' }] }] } });
  jira.addIssue({ key: 'APP-3', summary: 'Sign out' });
  jira.addIssue({ key: 'APP-1', summary: 'Buy the domain', labels: ['foreman-owner'] });
  jira.addIssue({ key: 'APP-5', summary: 'Profile page' });
  jira.blocks('APP-12', 'APP-3');
});

async function run(argv) {
  let out = '';
  let err = '';
  const code = await main(argv, { cwd: dir, env, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } });
  return { code, out, err };
}

describe('Jira stories through the CLI', () => {
  it('story next gives the first issue in JQL order', async () => {
    const { code, out, err } = await run(['story', 'next']);
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ id: 'APP-12', title: 'Sign in', status: 'todo', order: 0 });
  });

  it('story plan lists the issues in JQL order, blockers first', async () => {
    const { code, out } = await run(['story', 'plan']);
    expect(code).toBe(0);
    expect(out).toContain('The factory can build 3 stories, in this order:\n  APP-12 APP-3 APP-5\n');
    expect(out).toContain('1 open owner tasks:\n  APP-1  Buy the domain\n');
  });

  it('workflow-args points story.brief at the written brief', async () => {
    const { code, out, err } = await run(['workflow-args', 'APP-12']);
    expect(err).toBe('');
    expect(code).toBe(0);
    const brief = JSON.parse(out).story.brief;
    expect(brief).toBe(path.join(dir, '.foreman', 'stories', 'APP-12.md'));
    expect(fs.readFileSync(brief, 'utf8')).toContain('## What\n\nBuild sign in.\n');
  });

  it('story start records the overlay, and next keeps the story in progress', async () => {
    expect((await run(['story', 'start', 'APP-5'])).code).toBe(0);
    expect(JSON.parse((await run(['story', 'next'])).out)).toMatchObject({ id: 'APP-5', status: 'in-progress' });
  });

  it('story plan says a blocker outside the filter is not done, not that it is missing', async () => {
    jira.addIssue({ key: 'OLD-1', status: 'in-progress', inFilter: false });
    jira.blocks('OLD-1', 'APP-5');
    const { out } = await run(['story', 'plan']);
    expect(out).toContain('  APP-5  waits on: OLD-1 (outside the filter, not done)\n');
  });

  it('a local stories.jql override changes which issues story next sees', async () => {
    jira.setFilter('labels = later', ['APP-5', 'APP-12']);
    fs.mkdirSync(path.join(dir, '.foreman'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.foreman', 'settings.json'), JSON.stringify({ 'stories.jql': 'labels = later' }));
    expect(JSON.parse((await run(['story', 'next'])).out).id).toBe('APP-5');
    const searches = (await jira.requests()).filter((r) => r.path === '/rest/api/3/search/jql');
    expect(searches.at(-1).body.jql).toBe('labels = later');
  });
});

describe('Jira write-back from the CLI', () => {
  const transitions = { started: 'In Progress', review: 'In Review', blocked: 'Blocked', shipped: 'Done', failed: 'To Do' };
  const configure = (features = {}) => {
    const file = path.join(dir, 'foreman.config.json');
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...config, features, stories: { ...config.stories, transitions } }));
  };
  const texts = (key) => jira.comments(key).map((c) => adfToMarkdown(c.body));

  it('a story lifecycle (start, review, shipped) leaves three Foreman comments and the issue Done', async () => {
    configure();
    expect((await run(['story', 'start', 'APP-5'])).code).toBe(0);
    expect(jira.issue('APP-5').status).toBe('in-progress');

    // The ship pr step finds the pull request and raises review through the story source.
    const ctx = fakeCtx({
      story: 'APP-5',
      branch: 'story/app-5',
      root: dir,
      env,
      rules: [['gh pr view story/app-5', JSON.stringify({ number: 12, url: 'https://github.com/acme/app/pull/12', state: 'OPEN' })], ['gh pr view 12 --json mergeable', 'MERGEABLE']],
    });
    expect((await pr.run(ctx)).ok).toBe(true);
    expect(jira.issue('APP-5').status).toBe('in-review');

    expect((await run(['story', 'done', 'APP-5', '--note', 'Shipped in #12.'])).code).toBe(0);
    expect(texts('APP-5')).toEqual(['Foreman: Started.', 'Foreman: Pull request ready for review: https://github.com/acme/app/pull/12', 'Foreman: Shipped in #12.']);
    expect(jira.issue('APP-5').status).toBe('done');
  });

  it('story block raises blocked, and story end failed raises failed', async () => {
    configure();
    await run(['story', 'start', 'APP-5']);
    expect((await run(['story', 'block', 'APP-5', '--reason', 'needs a key'])).code).toBe(0);
    expect(jira.issue('APP-5').status).toBe('blocked');
    expect((await run(['story', 'end', 'failed', '', 'the', 'tests', 'failed', '--story', 'APP-5'])).code).toBe(0);
    expect(texts('APP-5')).toEqual(['Foreman: Started.', 'Foreman: Blocked: needs a key', 'Foreman: Failed: the tests failed']);
    expect(jira.issue('APP-5').status).toBe('todo');
  });

  it('story end failed names the slot story when --story is not given', async () => {
    configure({ jiraTransitions: false });
    await run(['story', 'start', 'APP-5']);
    expect((await run(['story', 'end', 'failed'])).code).toBe(0);
    expect(texts('APP-5')).toEqual(['Foreman: Started.', 'Foreman: Failed.']);
  });

  it('story end ready-to-promote with no park tells Jira the story failed', async () => {
    configure({ jiraTransitions: false });
    await run(['story', 'start', 'APP-5']);
    const { code, err } = await run(['story', 'end', 'ready-to-promote']);
    expect(code).toBe(1);
    expect(err).toContain('no release is parked for APP-5');
    expect(texts('APP-5')).toEqual(['Foreman: Started.', 'Foreman: Failed: claimed ready-to-promote, but no release is parked']);
  });

  it('with the switches off, nothing is written to Jira', async () => {
    configure({ jiraComments: false, jiraTransitions: false });
    await run(['story', 'start', 'APP-5']);
    await run(['story', 'done', 'APP-5', '--note', 'Shipped.']);
    expect(jira.comments('APP-5')).toEqual([]);
    expect(jira.issue('APP-5').status).toBe('todo');
  });

  it('with Jira down, story start still succeeds and the writes wait in the outbox', async () => {
    configure();
    await run(['story', 'plan']); // a list to fall back on
    jira.setDown(500);
    expect((await run(['story', 'start', 'APP-5'])).code).toBe(0);
    expect(fs.readdirSync(path.join(dir, '.foreman', 'jira-outbox')).filter((f) => f.endsWith('.json'))).toHaveLength(2);
    jira.setDown(false);
    expect((await run(['story', 'done', 'APP-5', '--note', 'Shipped.'])).code).toBe(0);
    expect(texts('APP-5')).toEqual(['Foreman: Started.', 'Foreman: Shipped.']);
    expect(jira.issue('APP-5').status).toBe('done');
  });
});
