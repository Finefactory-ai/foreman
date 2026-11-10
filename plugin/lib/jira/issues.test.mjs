import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeToken } from './auth.mjs';
import { jiraClient } from './client.mjs';
import { LIST_FIELDS, readBrief, readSnapshot } from './issues.mjs';
import { startFakeJiraHere } from '../../../test/fake-jira.mjs';

const SITE = 'acme.atlassian.net';
let jira;
let home;
let request;

const start = async (opts) => {
  jira = await startFakeJiraHere(opts);
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-issues-'));
  const env = { HOME: home, FOREMAN_JIRA_API_BASE: jira.url, FOREMAN_JIRA_AUTH_BASE: jira.url };
  writeToken(SITE, { cloudId: jira.cloudId, site: SITE, ...jira.tokens, expiresAt: '2999-01-01T00:00:00.000Z' }, { env });
  request = jiraClient({ site: SITE, env }).request;
};
beforeEach(() => start());
afterEach(async () => {
  await jira.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const searches = async () => (await jira.requests()).filter((r) => r.path === '/rest/api/3/search/jql');

describe('readSnapshot', () => {
  it('asks for the list fields with maxResults 100 and keeps the result order', async () => {
    for (const k of ['APP-12', 'APP-3', 'OPS-1']) jira.addIssue({ key: k, summary: `Do ${k}` });
    const snap = await readSnapshot(request, { jql: 'project = APP ORDER BY rank' });
    expect(snap.issues.map((i) => i.key)).toEqual(['APP-12', 'APP-3', 'OPS-1']);
    expect(snap.issues[0]).toEqual({ key: 'APP-12', title: 'Do APP-12', category: 'new', labels: [], blockedBy: [] });
    const [s] = await searches();
    expect(s.body).toEqual({ jql: 'project = APP ORDER BY rank', fields: LIST_FIELDS, maxResults: 100 });
    expect(LIST_FIELDS).toEqual(['summary', 'status', 'issuelinks', 'labels', 'parent']);
  });

  it('follows nextPageToken until isLast', async () => {
    await jira.close();
    await start({ pageSize: 2 });
    for (let n = 1; n <= 5; n += 1) jira.addIssue({ key: `APP-${n}` });
    const snap = await readSnapshot(request, { jql: 'x' });
    expect(snap.issues.map((i) => i.key)).toEqual(['APP-1', 'APP-2', 'APP-3', 'APP-4', 'APP-5']);
    const pages = await searches();
    expect(pages.map((p) => p.body.nextPageToken)).toEqual([undefined, '2', '4']);
  });

  it('reads the status category', async () => {
    jira.addIssue({ key: 'APP-1', status: 'done' });
    jira.addIssue({ key: 'APP-2', status: 'in-progress' });
    const snap = await readSnapshot(request, { jql: 'x' });
    expect(snap.issues.map((i) => i.category)).toEqual(['done', 'indeterminate']);
  });

  it('takes "is blocked by" links from the blocked side only, and ignores other link types', async () => {
    for (const k of ['APP-1', 'APP-2', 'APP-3']) jira.addIssue({ key: k });
    jira.blocks('APP-1', 'APP-2'); // APP-2 is blocked by APP-1
    jira.relates('APP-3', 'APP-2');
    jira.relates('APP-2', 'APP-3');
    const byKey = Object.fromEntries((await readSnapshot(request, { jql: 'x' })).issues.map((i) => [i.key, i.blockedBy]));
    expect(byKey).toEqual({ 'APP-1': [], 'APP-2': ['APP-1'], 'APP-3': [] });
  });

  it('looks up each linked issue outside the filter once, for its status category', async () => {
    jira.addIssue({ key: 'APP-1' });
    jira.addIssue({ key: 'APP-2' });
    jira.addIssue({ key: 'OLD-7', status: 'done', inFilter: false });
    jira.addIssue({ key: 'OLD-8', status: 'in-progress', inFilter: false });
    jira.blocks('OLD-7', 'APP-1');
    jira.blocks('OLD-7', 'APP-2');
    jira.blocks('OLD-8', 'APP-2');
    jira.blocks('APP-1', 'OLD-9'); // APP-1 blocks something else: not looked up
    const snap = await readSnapshot(request, { jql: 'x' });
    expect(snap.outside).toEqual({ 'OLD-7': 'done', 'OLD-8': 'indeterminate' });
    const gets = (await jira.requests()).filter((r) => r.method === 'GET');
    expect(gets.map((g) => [g.path, g.query.fields])).toEqual([
      ['/rest/api/3/issue/OLD-7', 'status'],
      ['/rest/api/3/issue/OLD-8', 'status'],
    ]);
  });

  it('counts a linked issue it cannot see as not done', async () => {
    jira.addIssue({ key: 'APP-1' });
    jira.blocks('GONE-1', 'APP-1');
    const snap = await readSnapshot(request, { jql: 'x' });
    expect(snap.issues[0].blockedBy).toEqual(['GONE-1']);
    expect(snap.outside).toEqual({ 'GONE-1': null });
  });
});

describe('readBrief', () => {
  const adf = (text) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

  it('reads the issue and its last 10 comments, newest first', async () => {
    jira.addIssue({ key: 'APP-1', summary: 'Add login', description: adf('Build it.'), fields: { customfield_10050: adf('It logs in.') } });
    for (let n = 1; n <= 12; n += 1) jira.addComment('APP-1', { author: `User ${n}`, created: `2026-10-${String(n).padStart(2, '0')}T09:00:00.000+0000`, body: adf(`c${n}`) });
    const b = await readBrief(request, { key: 'APP-1', doneWhenField: 'customfield_10050' });
    expect(b).toMatchObject({ key: 'APP-1', title: 'Add login', category: 'new', statusName: 'To Do', description: adf('Build it.'), doneWhen: adf('It logs in.') });
    expect(b.comments).toHaveLength(10);
    expect(b.comments[0]).toEqual({ author: 'User 12', created: '2026-10-12T09:00:00.000+0000', body: adf('c12') });
    const calls = (await jira.requests()).map((r) => [r.path, r.query]);
    expect(calls).toEqual([
      ['/rest/api/3/issue/APP-1', { fields: 'summary,status,description,customfield_10050' }],
      ['/rest/api/3/issue/APP-1/comment', { orderBy: '-created', maxResults: '10' }],
    ]);
  });

  it('has no doneWhen without the field', async () => {
    jira.addIssue({ key: 'APP-1' });
    const b = await readBrief(request, { key: 'APP-1' });
    expect(b.doneWhen).toBeNull();
    expect(b.comments).toEqual([]);
  });
});
