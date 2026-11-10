// The Jira story source's write side: comments, transitions, the outbox, depends_on links,
// and create, against the fake Atlassian in a worker thread.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeToken } from '../../jira/auth.mjs';
import { adfToMarkdown } from '../../jira/adf.mjs';
import { buildOrder } from '../../engine/pick.mjs';
import { startFakeJira } from '../../../../test/fake-jira.mjs';
import { create } from './jira.mjs';
import { describeOp } from '../../jira/outbox.mjs';
import { createIssue, sendWrites } from '../../jira/writes.mjs';
import { JiraError } from '../../jira/client.mjs';

const SITE = 'acme.atlassian.net';
const T0 = new Date('2026-10-17T12:00:00Z');
const MAP = { started: 'In Progress', review: 'In Review', blocked: 'Blocked', shipped: 'Done', failed: 'To Do' };
const PR = 'https://github.com/acme/app/pull/12';

let jira;
const dirs = [];
beforeAll(async () => {
  jira = await startFakeJira();
});
afterAll(async () => {
  await jira.close();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
beforeEach(() => {
  jira.reset();
  jira.addIssue({ key: 'APP-1', summary: 'Sign in', labels: ['foreman', 'web'] });
  jira.addIssue({ key: 'APP-2', summary: 'Sign out' });
});

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-jira-write-'));
  dirs.push(root);
  const env = { HOME: path.join(root, 'home'), FOREMAN_JIRA_API_BASE: jira.url, FOREMAN_JIRA_AUTH_BASE: jira.url };
  writeToken(SITE, { cloudId: jira.cloudId, site: SITE, ...jira.tokens, expiresAt: '2999-01-01T00:00:00.000Z' }, { env });
  return { root, env, stateDir: path.join(root, '.foreman') };
}

const open = ({ options = {}, features = { jiraComments: true, jiraTransitions: true }, ws = workspace() } = {}) => ({
  ws,
  source: create(
    { adapter: 'jira', site: SITE, jql: 'project = APP ORDER BY rank', transitions: MAP, ...options },
    { root: ws.root, stateDir: ws.stateDir, env: ws.env, now: () => T0, features },
  ),
});

const texts = (key) => jira.comments(key).map((c) => adfToMarkdown(c.body));
const outbox = (ws) => {
  const dir = path.join(ws.stateDir, 'jira-outbox');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
};
const events = (ws) => {
  const file = path.join(ws.stateDir, 'events.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};

const EVENTS = [
  ['started', { status: 'in-progress', fields: { started: '2026-10-17' }, note: 'Started.', event: 'started' }],
  ['blocked', { status: 'blocked', fields: { blockedBy: 'needs a key' }, note: 'Blocked: needs a key', event: 'blocked' }],
  ['review', { note: `Pull request ready for review: ${PR}`, event: 'review' }],
  ['failed', { note: 'Failed: the tests did not pass.', event: 'failed' }],
  ['shipped', { status: 'done', fields: { completed: '2026-10-17' }, note: 'Shipped in #12.', event: 'shipped' }],
];

describe('jira writes: comments', () => {
  for (const [name, change] of EVENTS) {
    it(`${name} posts "Foreman: <note>" when jiraComments is on`, () => {
      const { source } = open({ features: { jiraComments: true, jiraTransitions: false } });
      expect(source.update('APP-1', change)).toBe(true);
      expect(texts('APP-1')).toEqual([`Foreman: ${change.note}`]);
    });

    it(`${name} posts nothing when jiraComments is off, and still records the overlay`, () => {
      const { source, ws } = open({ features: { jiraComments: false, jiraTransitions: false } });
      expect(source.update('APP-1', change)).toBe(true);
      expect(jira.comments('APP-1')).toEqual([]);
      const ov = JSON.parse(fs.readFileSync(path.join(ws.stateDir, 'stories', 'APP-1.json'), 'utf8'));
      expect(ov.notes[0].text).toBe(change.note);
    });
  }

  it('makes a URL in the note a link', () => {
    const { source } = open({ features: { jiraComments: true, jiraTransitions: false } });
    source.update('APP-1', { note: `Pull request ready for review: ${PR}`, event: 'review' });
    const [comment] = jira.comments('APP-1');
    const nodes = comment.body.content[0].content;
    expect(nodes[0]).toEqual({ type: 'text', text: 'Foreman: Pull request ready for review: ' });
    expect(nodes[1]).toEqual({ type: 'text', text: PR, marks: [{ type: 'link', attrs: { href: PR } }] });
  });

  it('a change with no note posts nothing', () => {
    const { source } = open();
    source.update('APP-1', { fields: { dependsOn: ['APP-2'] } });
    expect(jira.comments('APP-1')).toEqual([]);
    expect(jira.issue('APP-1').status).toBe('todo');
  });
});

describe('jira writes: story notes', () => {
  const NOTE = { kind: 'design', title: 'design', summary: 'The architect chose the developer builder.', text: 'It changes one file.\n\nAt 2026-10-31 14:05 UTC, slot w2.' };

  it('posts exactly one comment, "Foreman: <title>", then the summary and the text', () => {
    const { source } = open();
    expect(source.note('APP-1', NOTE)).toBe(true);
    expect(texts('APP-1')).toEqual(['Foreman: design\n\nThe architect chose the developer builder.\n\nIt changes one file.\n\nAt 2026-10-31 14:05 UTC, slot w2.']);
  });

  it('queues the one comment under cacheOnly, calls onQueued, and the next send delivers it', () => {
    const ws = workspace();
    open({ ws }).source.list(); // a list for the cache-only source to read
    let queued = 0;
    const cached = create({ adapter: 'jira', site: SITE, jql: 'project = APP ORDER BY rank', transitions: MAP }, { root: ws.root, stateDir: ws.stateDir, env: ws.env, now: () => T0, features: { jiraComments: true, jiraTransitions: true }, cacheOnly: true, onQueued: () => (queued += 1) });
    expect(cached.note('APP-1', NOTE)).toBe(true);
    expect(outbox(ws)).toHaveLength(1);
    expect(queued).toBe(1);
    expect(jira.comments('APP-1')).toEqual([]);
    open({ ws }).source.update('APP-2', { note: 'Started.', event: 'started' });
    expect(texts('APP-1')).toHaveLength(1);
    expect(texts('APP-1')[0]).toMatch(/^Foreman: design\n\n/);
    expect(outbox(ws)).toEqual([]);
  });

  it('splits a long text into numbered parts of at most commentLimit characters, the footer only in the last', () => {
    const ws = workspace();
    const source = create({ adapter: 'jira', site: SITE, jql: 'project = APP ORDER BY rank', transitions: MAP }, { root: ws.root, stateDir: ws.stateDir, env: ws.env, now: () => T0, features: { jiraComments: true, jiraTransitions: true }, commentLimit: 400 });
    const paragraphs = Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1}: ${'word '.repeat(11).trim()}.`);
    const footer = 'At 2026-10-31 14:05 UTC, slot w2.';
    expect(source.note('APP-1', { kind: 'design', title: 'design', summary: 'The summary.', text: `${paragraphs.join('\n\n')}\n\n${footer}` })).toBe(true);
    const parts = texts('APP-1');
    expect(parts).toHaveLength(3);
    parts.forEach((part, i) => {
      expect(part.startsWith(`Foreman: design (part ${i + 1} of 3)`), part).toBe(true);
      expect(part.length).toBeLessThanOrEqual(400);
      expect(part.includes(footer)).toBe(i === 2);
    });
    // Nothing is lost, nothing repeated.
    const body = parts.map((p) => p.replace(/^Foreman: design \(part \d of 3\)\n\n/, '')).join('\n\n');
    for (const para of paragraphs) expect(body.split(para)).toHaveLength(2);
  });

  it('counts the part header against the limit, even when each block nearly fills a part', () => {
    const ws = workspace();
    const source = create({ adapter: 'jira', site: SITE, jql: 'project = APP ORDER BY rank' }, { root: ws.root, stateDir: ws.stateDir, env: ws.env, now: () => T0, features: { jiraComments: true }, commentLimit: 400 });
    const block = (n) => `B${n} ${'x'.repeat(125)}`;
    source.note('APP-1', { kind: 'design', title: 'design', summary: '', text: [1, 2, 3, 4, 5, 6].map(block).join('\n\n') });
    const parts = texts('APP-1');
    expect(parts.length).toBeGreaterThan(2);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(400);
    expect(parts.join('\n')).toContain('B6 ');
  });

  it('cuts a block longer than a whole part at a space, so no word is lost', () => {
    const ws = workspace();
    const source = create({ adapter: 'jira', site: SITE, jql: 'project = APP ORDER BY rank' }, { root: ws.root, stateDir: ws.stateDir, env: ws.env, now: () => T0, features: { jiraComments: true }, commentLimit: 300 });
    const words = Array.from({ length: 120 }, (_, i) => `word${i}`);
    source.note('APP-1', { kind: 'design', title: 'design', summary: '', text: words.join(' ') });
    const parts = texts('APP-1');
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(300);
    const back = parts.map((p) => p.replace(/^Foreman: design \(part \d+ of \d+\)\n\n/, '')).join(' ').split(/\s+/);
    expect(back).toEqual(words);
  });

  it('keeps a fenced block whole when it fits, and cuts hard inside one that does not', () => {
    const ws = workspace();
    const source = create({ adapter: 'jira', site: SITE, jql: 'project = APP ORDER BY rank' }, { root: ws.root, stateDir: ws.stateDir, env: ws.env, now: () => T0, features: { jiraComments: true }, commentLimit: 300 });
    const fence = `\`\`\`\n${'line one\n\nline two\n'.repeat(6)}\`\`\``;
    source.note('APP-1', { kind: 'design', title: 'design', summary: 'Short.', text: `${'Intro words. '.repeat(14)}\n\n${fence}\n\nThe end.` });
    const parts = texts('APP-1');
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(300);
    expect(parts.join('')).toContain('The end.');
  });

  it('is true with no write when jiraComments is off, and false for an unknown key', () => {
    const { source, ws } = open({ features: { jiraComments: false, jiraTransitions: false } });
    expect(source.note('APP-1', NOTE)).toBe(true);
    expect(jira.comments('APP-1')).toEqual([]);
    expect(outbox(ws)).toEqual([]);
    expect(open().source.note('APP-99', NOTE)).toBe(false);
    expect(jira.comments('APP-99')).toEqual([]);
  });

  it('never throws: Jira down queues the comment', () => {
    const { source, ws } = open();
    source.list();
    jira.setDown(500);
    expect(() => source.note('APP-1', NOTE)).not.toThrow();
    expect(outbox(ws)).toHaveLength(1);
    jira.setDown(false);
  });
});

describe('jira writes: transitions', () => {
  it('finds the mapped transition by name, ignoring case, and applies it', async () => {
    const { source } = open({ options: { transitions: { started: 'in progress' } }, features: { jiraComments: false, jiraTransitions: true } });
    source.update('APP-1', { status: 'in-progress', note: 'Started.', event: 'started' });
    expect(jira.issue('APP-1').status).toBe('in-progress');
    const posts = (await jira.requests()).filter((r) => r.method === 'POST' && r.path === '/rest/api/3/issue/APP-1/transitions');
    expect(posts.at(-1).body).toEqual({ transition: { id: '21' } });
  });

  it('moves nothing when jiraTransitions is off, or when the event is not mapped', async () => {
    open({ features: { jiraComments: false, jiraTransitions: false } }).source.update('APP-1', { status: 'in-progress', event: 'started' });
    expect(jira.issue('APP-1').status).toBe('todo');
    const before = (await jira.requests()).length;
    open({ options: { transitions: { shipped: 'Done' } }, features: { jiraComments: false, jiraTransitions: true } }).source.update('APP-1', { status: 'in-progress', event: 'started' });
    expect(jira.issue('APP-1').status).toBe('todo');
    expect((await jira.requests()).slice(before).some((r) => r.path.endsWith('/transitions'))).toBe(false);
  });

  it('an unavailable transition gives a comment, not a failure', () => {
    const { source, ws } = open({ features: { jiraComments: true, jiraTransitions: true } });
    // To Do offers In Progress and Done, not In Review.
    expect(source.update('APP-1', { note: `Pull request ready for review: ${PR}`, event: 'review' })).toBe(true);
    expect(jira.issue('APP-1').status).toBe('todo');
    expect(texts('APP-1')).toEqual([`Foreman: Pull request ready for review: ${PR}`, 'Foreman: could not move to In Review from To Do']);
    expect(outbox(ws)).toEqual([]);
    expect(events(ws).map((e) => e.text)).toContain('Jira: could not move APP-1 to In Review from To Do.');
  });

  it('applies the transition after the comment, so the comment lands on the old status', async () => {
    const { source } = open();
    const before = (await jira.requests()).length;
    source.update('APP-1', { status: 'in-progress', note: 'Started.', event: 'started' });
    // The fake keeps every request since it started, and the search is a POST too.
    const writes = (await jira.requests()).slice(before).filter((r) => r.method === 'POST' && r.path !== '/rest/api/3/search/jql').map((r) => r.path);
    expect(writes).toEqual(['/rest/api/3/issue/APP-1/comment', '/rest/api/3/issue/APP-1/transitions']);
  });
});

describe('jira writes: a parked release', () => {
  const PARKED = { status: 'ready-to-promote', note: 'ready to promote: click Promote', event: 'parked' };

  it('comments once, never moves the issue to Done, and lists it as ready-to-promote', () => {
    const { source } = open();
    expect(source.update('APP-1', PARKED)).toBe(true);
    expect(texts('APP-1')).toEqual(['Foreman: ready to promote: click Promote']);
    expect(jira.issue('APP-1').status).toBe('todo');
    expect(source.list().find((s) => s.id === 'APP-1').status).toBe('ready-to-promote');
  });

  it('the same update again posts nothing new', () => {
    const { source } = open();
    source.update('APP-1', PARKED);
    expect(source.update('APP-1', PARKED)).toBe(true);
    expect(texts('APP-1')).toEqual(['Foreman: ready to promote: click Promote']);
    expect(jira.issue('APP-1').status).toBe('todo');
  });
});

describe('jira writes: the outbox', () => {
  it('with Jira down, writes queue and replay in order once it is back', () => {
    const { source, ws } = open();
    source.list(); // a list to fall back on
    jira.setDown(500);
    expect(source.update('APP-1', { status: 'in-progress', note: 'Started.', event: 'started' })).toBe(true);
    expect(source.update('APP-1', { note: `Pull request ready for review: ${PR}`, event: 'review' })).toBe(true);
    expect(outbox(ws)).toHaveLength(4);
    expect(jira.comments('APP-1')).toEqual([]);
    const queued = events(ws).filter((e) => /queued to retry/.test(e.text));
    expect(queued.map((e) => e.text)).toEqual([
      expect.stringMatching(/^Jira: could not send a comment on APP-1 \(.*500.*\); queued to retry\.$/),
      expect.stringMatching(/^Jira: could not send the move of APP-1 to In Progress .*queued to retry\.$/),
      expect.stringMatching(/^Jira: could not send a comment on APP-1 .*queued to retry\.$/),
      expect.stringMatching(/^Jira: could not send the move of APP-1 to In Review .*queued to retry\.$/),
    ]);
    expect(source.list().map((s) => s.status)).toEqual(['in-progress', 'todo']);

    jira.setDown(false);
    expect(source.update('APP-1', { status: 'done', note: 'Shipped in #12.', event: 'shipped' })).toBe(true);
    expect(texts('APP-1')).toEqual(['Foreman: Started.', `Foreman: Pull request ready for review: ${PR}`, 'Foreman: Shipped in #12.']);
    expect(jira.issue('APP-1').status).toBe('done');
    expect(outbox(ws)).toEqual([]);
    expect(events(ws).filter((e) => /from the queue/.test(e.text))).toHaveLength(4);
  });

  it('a later list replays the queue too', () => {
    const { source, ws } = open({ options: { pollSeconds: 0 } });
    source.list();
    jira.setDown(500);
    source.update('APP-1', { note: 'Started.', event: 'started' });
    expect(outbox(ws).length).toBeGreaterThan(0);
    jira.setDown(false);
    source.list();
    expect(texts('APP-1')).toEqual(['Foreman: Started.']);
    expect(outbox(ws)).toEqual([]);
  });

  it('drops a write Jira refuses for good, and says so, so the queue never sticks', () => {
    const { source, ws } = open({ features: { jiraComments: true, jiraTransitions: false } });
    source.list();
    jira.setDown(500);
    source.update('APP-1', { note: 'Started.', event: 'started' });
    // APP-1 is deleted in Jira meanwhile.
    const kept = jira.issue('APP-2');
    jira.reset();
    jira.addIssue({ key: kept.key, summary: kept.summary });
    source.update('APP-2', { note: 'Started.', event: 'started' });
    expect(outbox(ws)).toEqual([]);
    expect(texts('APP-2')).toEqual(['Foreman: Started.']);
    expect(events(ws).map((e) => e.text)).toContainEqual(expect.stringMatching(/^Jira: dropped a comment on APP-1: .*404/));
  });

  it('a failed write never fails the caller, signed out included', () => {
    const { source, ws } = open();
    source.list();
    fs.rmSync(ws.env.HOME, { recursive: true, force: true });
    expect(source.update('APP-1', { status: 'in-progress', note: 'Started.', event: 'started' })).toBe(true);
    expect(outbox(ws)).toHaveLength(2);
    expect(events(ws).at(-1).text).toMatch(/foreman jira login/);
  });
});

describe('jira writes: depends_on as "is blocked by" links', () => {
  const blocksOn = (key) => jira.links().filter((l) => l.type.name === 'Blocks' && l.inward === key).map((l) => l.outward);
  const linkPosts = async (from = 0) => (await jira.requests()).slice(from).filter((r) => r.method === 'POST' && r.path === '/rest/api/3/issueLink');
  const linkDeletes = async (from = 0) => (await jira.requests()).slice(from).filter((r) => r.method === 'DELETE' && /^\/rest\/api\/3\/issueLink\/\d+$/.test(r.path));

  it('writes the link for a new dependency, once', async () => {
    const { source } = open();
    const before = (await jira.requests()).length;
    expect(source.update('APP-1', { fields: { dependsOn: ['APP-2'] } })).toBe(true);
    expect(blocksOn('APP-1')).toEqual(['APP-2']);
    expect(source.list().find((s) => s.id === 'APP-1').dependsOn).toEqual(['APP-2']);
    source.update('APP-1', { fields: { dependsOn: ['APP-2'] } });
    expect(await linkPosts(before)).toHaveLength(1);
    expect((await linkPosts(before))[0].body).toEqual({ type: { name: 'Blocks' }, outwardIssue: { key: 'APP-2' }, inwardIssue: { key: 'APP-1' } });
  });

  it('posts no link Jira already has', async () => {
    jira.blocks('APP-2', 'APP-1');
    const { source } = open();
    const before = (await jira.requests()).length;
    source.update('APP-1', { fields: { dependsOn: ['APP-2'] } });
    expect(await linkPosts(before)).toEqual([]);
    expect(blocksOn('APP-1')).toEqual(['APP-2']);
  });

  it('writes the link with the comments and transitions off, before the comment', async () => {
    const { source } = open({ features: { jiraComments: false, jiraTransitions: false } });
    source.update('APP-1', { status: 'todo', fields: { dependsOn: ['APP-2'] }, note: 'Now waits for APP-2: APP-2 first' });
    expect(blocksOn('APP-1')).toEqual(['APP-2']);
    expect(jira.comments('APP-1')).toEqual([]);

    jira.reset();
    jira.addIssue({ key: 'APP-1', summary: 'Sign in' });
    jira.addIssue({ key: 'APP-2', summary: 'Sign out' });
    const before = (await jira.requests()).length;
    open().source.update('APP-1', { fields: { dependsOn: ['APP-2'] }, note: 'Now waits for APP-2: APP-2 first' });
    const writes = (await jira.requests()).slice(before).filter((r) => r.method === 'POST' && r.path !== '/rest/api/3/search/jql').map((r) => r.path);
    expect(writes).toEqual(['/rest/api/3/issueLink', '/rest/api/3/issue/APP-1/comment']);
  });

  it('removes the link when the dependency comes off, and keeps the others', async () => {
    jira.addIssue({ key: 'APP-3', summary: 'Reset' });
    jira.relates('APP-1', 'APP-3');
    const { source, ws } = open();
    source.update('APP-1', { fields: { dependsOn: ['APP-2', 'APP-3'] } });
    expect(blocksOn('APP-1').sort()).toEqual(['APP-2', 'APP-3']);
    const before = (await jira.requests()).length;
    source.update('APP-1', { fields: { dependsOn: ['APP-3'] } });
    expect(await linkDeletes(before)).toHaveLength(1);
    expect(blocksOn('APP-1')).toEqual(['APP-3']);
    expect(jira.links().filter((l) => l.type.name === 'Relates')).toHaveLength(1);
    source.update('APP-1', { fields: { dependsOn: [] } });
    expect(blocksOn('APP-1')).toEqual([]);
    expect(source.list().find((s) => s.id === 'APP-1').dependsOn).toEqual([]);
    expect(outbox(ws)).toEqual([]);
  });

  it('keeps the link to a blocker outside the filter that is done, which the list leaves out as met', async () => {
    jira.addIssue({ key: 'OLD-1', status: 'done', inFilter: false });
    jira.blocks('OLD-1', 'APP-1');
    const { source } = open();
    const story = source.list().find((s) => s.id === 'APP-1');
    expect(story.dependsOn).toEqual([]);
    const before = (await jira.requests()).length;
    source.update('APP-1', { fields: { dependsOn: [...story.dependsOn, 'APP-2'] } });
    expect(await linkDeletes(before)).toEqual([]);
    expect(blocksOn('APP-1').sort()).toEqual(['APP-2', 'OLD-1']);
    source.update('APP-1', { fields: { dependsOn: [] } });
    expect(blocksOn('APP-1')).toEqual(['OLD-1']);
  });

  it('an unlink with no link to remove sends no DELETE and queues nothing', async () => {
    const { source, ws } = open();
    source.update('APP-1', { fields: { dependsOn: ['APP-2'] } });
    // The link goes in Jira meanwhile.
    jira.reset();
    jira.addIssue({ key: 'APP-1', summary: 'Sign in' });
    jira.addIssue({ key: 'APP-2', summary: 'Sign out' });
    const before = (await jira.requests()).length;
    source.update('APP-1', { fields: { dependsOn: [] } });
    expect(await linkDeletes(before)).toEqual([]);
    expect((await jira.requests()).slice(before).some((r) => r.method === 'GET' && r.path === '/rest/api/3/issue/APP-1')).toBe(true);
    expect(outbox(ws)).toEqual([]);
  });

  it('with Jira down, the unlink waits in the outbox, said in words', () => {
    const { source, ws } = open();
    source.update('APP-1', { fields: { dependsOn: ['APP-2'] } });
    jira.setDown(500);
    source.update('APP-1', { fields: { dependsOn: [] } });
    const queued = outbox(ws).map((f) => JSON.parse(fs.readFileSync(path.join(ws.stateDir, 'jira-outbox', f), 'utf8')));
    expect(queued).toEqual([{ kind: 'unlink', type: 'Blocks', outward: 'APP-2', inward: 'APP-1' }]);
    expect(describeOp(queued[0])).toBe('the removal of the link APP-2 blocks APP-1');
    expect(events(ws).map((e) => e.text)).toContainEqual(expect.stringMatching(/^Jira: could not send the removal of the link APP-2 blocks APP-1 .*queued to retry\.$/));
    jira.setDown(false);
    source.update('APP-2', { note: 'Started.', event: 'started' });
    expect(outbox(ws)).toEqual([]);
    expect(blocksOn('APP-1')).toEqual([]);
  });
});

describe('sendWrites: unlink', () => {
  it('removes each link of the type from the outward issue, ignoring case, and counts none found as sent', async () => {
    const calls = [];
    const links = [
      { id: '1', type: { name: 'Blocks' }, inwardIssue: { key: 'APP-2' } },
      { id: '2', type: { name: 'Relates' }, inwardIssue: { key: 'APP-2' } },
      { id: '3', type: { name: 'Blocks' }, outwardIssue: { key: 'APP-2' } },
      { id: '4', type: { name: 'Blocks' }, inwardIssue: { key: 'APP-9' } },
    ];
    const request = async (method, p) => {
      calls.push([method, p]);
      return method === 'GET' ? { key: 'APP-1', fields: { issuelinks: links } } : null;
    };
    expect(await sendWrites(request, { ops: [{ kind: 'unlink', type: 'blocks', outward: 'APP-2', inward: 'APP-1' }] })).toEqual([{ status: 'sent' }]);
    expect(calls).toEqual([
      ['GET', '/rest/api/3/issue/APP-1?fields=issuelinks'],
      ['DELETE', '/rest/api/3/issueLink/1'],
    ]);
    calls.length = 0;
    expect(await sendWrites(request, { ops: [{ kind: 'unlink', type: 'Blocks', outward: 'APP-7', inward: 'APP-1' }] })).toEqual([{ status: 'sent' }]);
    expect(calls).toEqual([['GET', '/rest/api/3/issue/APP-1?fields=issuelinks']]);
  });
});

describe('jira writes: create', () => {
  const follow = (source, extra = {}) =>
    source.create({ title: 'Follow-ups from APP-1', what: '- fix the thing\n- and the other', doneWhen: 'The thing is fixed.', dependsOn: [], origin: 'APP-1', ...extra });

  it('makes an issue in the origin project, links it, and copies the labels', () => {
    const { source } = open();
    expect(follow(source)).toEqual({ id: 'APP-3', path: null });
    const issue = jira.issue('APP-3');
    expect(issue).toMatchObject({ summary: 'Follow-ups from APP-1', labels: ['foreman', 'web'], status: 'todo', fields: { issuetype: { name: 'Task' } } });
    const md = adfToMarkdown(issue.description);
    expect(md).toBe('- fix the thing\n- and the other\n\n## Done when\n\nThe thing is fixed.');
    expect(jira.links().filter((l) => l.type.name === 'Relates')).toEqual([{ type: expect.objectContaining({ name: 'Relates' }), outward: 'APP-3', inward: 'APP-1' }]);
  });

  it('uses newIssueType, and links each dependency as "is blocked by"', () => {
    const { source } = open({ options: { newIssueType: 'Bug' } });
    const made = follow(source, { dependsOn: ['APP-2'] });
    expect(jira.issue(made.id).fields.issuetype.name).toBe('Bug');
    const story = source.list().find((s) => s.id === made.id);
    expect(story).toMatchObject({ status: 'todo', dependsOn: ['APP-2'], followUpOf: 'APP-1' });
    expect(buildOrder(source.list(), { idPattern: source.idPattern }).order).toEqual(['APP-1', 'APP-2', 'APP-3']);
  });

  it('shows the new issue in list at once, and its brief has What and Done when', () => {
    const { source } = open();
    source.list();
    const made = follow(source);
    expect(source.list().map((s) => s.id)).toEqual(['APP-1', 'APP-2', 'APP-3']);
    const text = fs.readFileSync(source.brief(made.id).path, 'utf8');
    expect(text).toContain('## What\n\n- fix the thing\n- and the other\n');
    expect(text).toContain('## Done when\n\nThe thing is fixed.\n');
  });

  it('a link Jira refuses is dropped and said; the issue still counts as made', () => {
    const { source, ws } = open();
    // Only the dependency link fails: there is no NOPE-1.
    const made = follow(source, { dependsOn: ['NOPE-1'] });
    expect(made.id).toBe('APP-3');
    expect(events(ws).map((e) => e.text)).toContainEqual(expect.stringMatching(/^Jira: dropped the link NOPE-1 blocks APP-3: /));
  });

  it('a create Jira refuses throws, since there is no issue to name', () => {
    jira.setDown(500);
    expect(() => follow(open().source)).toThrow(/500/);
  });

  it('sets the priority by name when given one, with the labels and the link as before', () => {
    const { source } = open();
    expect(follow(source, { priority: 'Low' })).toEqual({ id: 'APP-3', path: null });
    const issue = jira.issue('APP-3');
    expect(issue.fields.priority).toEqual({ name: 'Low' });
    expect(issue.labels).toEqual(['foreman', 'web']);
    expect(jira.links().filter((l) => l.type.name === 'Relates')).toEqual([{ type: expect.objectContaining({ name: 'Relates' }), outward: 'APP-3', inward: 'APP-1' }]);
  });

  it('sends no priority without one', async () => {
    follow(open().source);
    expect(jira.issue('APP-3').fields).not.toHaveProperty('priority');
    const posts = (await jira.requests()).filter((r) => r.method === 'POST' && r.path === '/rest/api/3/issue');
    expect(posts.at(-1).body.fields).not.toHaveProperty('priority');
  });

  it('makes the issue without the priority when the project refuses one', async () => {
    jira.refusePriority(true);
    const before = (await jira.requests()).length;
    const made = follow(open().source, { priority: 'Low' });
    expect(made.id).toBe('APP-3');
    expect(jira.issue('APP-3').fields).not.toHaveProperty('priority');
    const posts = (await jira.requests()).slice(before).filter((r) => r.method === 'POST' && r.path === '/rest/api/3/issue');
    expect(posts.map((p) => p.body.fields.priority ?? null)).toEqual([{ name: 'Low' }, null]);
  });
});

describe('createIssue: priority', () => {
  const origin = { key: 'APP-1', fields: { labels: ['foreman'], project: { key: 'APP' } } };
  const refusing = (errors) => {
    const posts = [];
    const request = async (method, p, body) => {
      if (method === 'GET') return origin;
      posts.push(body.fields);
      if (posts.length === 1) throw new JiraError({ method, path: p, status: 400, errors });
      return { key: 'APP-3' };
    };
    return { posts, request };
  };

  it('rethrows a 400 that is not about the priority, and posts once', async () => {
    const { posts, request } = refusing({ summary: 'You must specify a summary of the issue.' });
    await expect(createIssue(request, { origin: 'APP-1', title: 'T', description: null, priority: 'Low' })).rejects.toThrow(/summary/);
    expect(posts).toHaveLength(1);
  });

  it('posts again without the priority after a 400 about it', async () => {
    const { posts, request } = refusing({ priority: "Field 'priority' cannot be set." });
    expect(await createIssue(request, { origin: 'APP-1', title: 'T', description: null, priority: 'Low' })).toEqual({ key: 'APP-3' });
    expect(posts.map((f) => f.priority ?? null)).toEqual([{ name: 'Low' }, null]);
  });

  it('never retries a refusal when no priority was sent', async () => {
    const { posts, request } = refusing({ priority: "Field 'priority' cannot be set." });
    await expect(createIssue(request, { origin: 'APP-1', title: 'T', description: null })).rejects.toThrow(/priority/);
    expect(posts).toHaveLength(1);
  });

  it('sends no priority for an empty name', async () => {
    const { posts, request } = refusing({ summary: 'x' });
    await expect(createIssue(request, { origin: 'APP-1', title: 'T', description: null, priority: '  ' })).rejects.toThrow();
    expect(posts[0]).not.toHaveProperty('priority');
  });
});
