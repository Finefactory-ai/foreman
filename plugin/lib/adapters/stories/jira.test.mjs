import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeToken } from '../../jira/auth.mjs';
import { buildOrder, nextStory } from '../../engine/pick.mjs';
import { CLIENT_ID, CLIENT_SECRET } from '../../../../test/fake-atlassian.mjs';
import { startFakeJira } from '../../../../test/fake-jira.mjs';
import { storySourceContract } from './contract.mjs';
import { create, JIRA_ID_PATTERN } from './jira.mjs';

// git and child-process heavy: give each test and hook room on a busy machine.
const SLOW_MS = 30_000;
vi.setConfig({ testTimeout: SLOW_MS, hookTimeout: SLOW_MS });

it('gives each test room on a busy machine', ({ task }) => {
  expect(task.timeout).toBe(SLOW_MS);
});

const SITE = 'acme.atlassian.net';
const OWNER_TITLE = 'Owner: approve the budget';
const T0 = new Date('2026-10-17T12:00:00Z');

// One fake for the whole file; each source gets a fresh home and state folder.
let jira;
const dirs = [];
beforeAll(async () => {
  jira = await startFakeJira();
});
afterAll(async () => {
  await jira.close();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function workspace({ expiresAt = '2999-01-01T00:00:00.000Z' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-jira-src-'));
  dirs.push(root);
  const home = path.join(root, 'home');
  const env = { HOME: home, FOREMAN_JIRA_API_BASE: jira.url, FOREMAN_JIRA_AUTH_BASE: jira.url };
  writeToken(SITE, { cloudId: jira.cloudId, site: SITE, ...jira.tokens, expiresAt }, { env });
  return { root, home, env, stateDir: path.join(root, '.foreman') };
}

let clock;
const open = (options = {}, ws = workspace(), ctx = {}) => ({
  ws,
  source: create({ adapter: 'jira', site: SITE, jql: 'project = APP ORDER BY rank', ...options }, { root: ws.root, stateDir: ws.stateDir, env: ws.env, now: () => clock, ...ctx }),
});
const searches = async () => (await jira.requests()).filter((r) => r.path === '/rest/api/3/search/jql').length;
const adf = (...paras) => ({ type: 'doc', version: 1, content: paras.map((p) => (typeof p === 'string' ? { type: 'paragraph', content: [{ type: 'text', text: p }] } : p)) });
const heading = (text, level = 2) => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] });

beforeEach(() => {
  jira.reset();
  clock = T0;
});

storySourceContract({
  name: 'jira (through the fake Atlassian)',
  make: () => {
    jira.reset();
    const { source } = open();
    return {
      source,
      id: (n) => `APP-${n}`,
      ownerTaskTitle: OWNER_TITLE,
      // The contract finds owner tasks by title; Jira finds them by label, so the fixture
      // labels the issue that has the owner-task title.
      addStory: ({ id, title, status, blockedBy = [] }) => {
        jira.addIssue({ key: id, summary: title, status, labels: title === OWNER_TITLE ? ['foreman-owner'] : [] });
        for (const b of blockedBy) jira.blocks(b, id);
      },
      dependsOnLine: (ids) => ({ blockedBy: ids }),
    };
  },
  notes: true,
});

describe('jira story source: options', () => {
  const ctx = () => ({ root: '/x', stateDir: '/x/.foreman', env: {} });
  it('needs site and jql', () => {
    expect(() => create({ adapter: 'jira', jql: 'x' }, ctx())).toThrow('stories.site is required');
    expect(() => create({ adapter: 'jira', site: SITE }, ctx())).toThrow('stories.jql is required');
    expect(() => create({ adapter: 'jira', site: 'not a host', jql: 'x' }, ctx())).toThrow(/stories\.site/);
  });
  it('rejects unknown and badly typed options', () => {
    expect(() => create({ adapter: 'jira', site: SITE, jql: 'x', dir: 'stories' }, ctx())).toThrow('stories.dir is not a known option');
    expect(() => create({ adapter: 'jira', site: SITE, jql: 'x', pollSeconds: -1 }, ctx())).toThrow('stories.pollSeconds');
    expect(() => create({ adapter: 'jira', site: SITE, jql: 'x', ownerLabel: '' }, ctx())).toThrow('stories.ownerLabel');
    expect(() => create({ adapter: 'jira', site: SITE, jql: 'x', transitions: { started: 3 } }, ctx())).toThrow('stories.transitions');
    expect(() => create({ adapter: 'jira', site: SITE, jql: 'x' }, { root: '/x', env: {} })).toThrow(/state folder/);
  });
  it('has the Jira key pattern and create, but no groupSummary', () => {
    const { source } = open();
    expect(source.idPattern).toBe(JIRA_ID_PATTERN);
    const re = new RegExp(`^(?:${JIRA_ID_PATTERN})$`);
    for (const k of ['APP-1', 'A1-22', 'MY_PROJ-305']) expect(re.test(k)).toBe(true);
    for (const k of ['A-1', 'app-1', 'APP1']) expect(re.test(k)).toBe(false);
    expect(source.groupSummary).toBeUndefined();
    expect(typeof source.create).toBe('function');
  });
});

describe('jira story source: list', () => {
  it('maps an issue to a story', () => {
    jira.addIssue({ key: 'APP-7', summary: 'Add login' });
    const { source } = open();
    expect(source.list()).toEqual([
      { id: 'APP-7', title: 'Add login', ref: `https://${SITE}/browse/APP-7`, status: 'todo', group: '', groupName: '', order: 0, dependsOn: [], blockedBy: '', ownerTask: false, resources: [], followUpOf: '', externalDeps: {} },
    ]);
  });

  it('picks in JQL order, not by key number', () => {
    for (const k of ['APP-12', 'APP-3', 'OPS-100', 'APP-1']) jira.addIssue({ key: k });
    const { source } = open();
    const stories = source.list();
    expect(stories.map((s) => [s.id, s.order])).toEqual([['APP-12', 0], ['APP-3', 1], ['OPS-100', 2], ['APP-1', 3]]);
    expect(nextStory(stories, { idPattern: source.idPattern }).id).toBe('APP-12');
    expect(buildOrder(stories, { idPattern: source.idPattern }).order).toEqual(['APP-12', 'APP-3', 'OPS-100', 'APP-1']);
  });

  it('takes "is blocked by" links as dependsOn, never "blocks"', () => {
    for (const k of ['APP-1', 'APP-2', 'APP-3']) jira.addIssue({ key: k });
    jira.blocks('APP-2', 'APP-1'); // APP-1 is blocked by APP-2; APP-2 blocks APP-1
    jira.relates('APP-3', 'APP-1');
    const { source } = open();
    const byId = Object.fromEntries(source.list().map((s) => [s.id, s.dependsOn]));
    expect(byId).toEqual({ 'APP-1': ['APP-2'], 'APP-2': [], 'APP-3': [] });
    expect(buildOrder(source.list(), { idPattern: source.idPattern }).order).toEqual(['APP-2', 'APP-1', 'APP-3']);
  });

  it('counts a blocker outside the filter as done only when Jira says done', () => {
    jira.addIssue({ key: 'APP-1' });
    jira.addIssue({ key: 'APP-2' });
    jira.addIssue({ key: 'OLD-1', status: 'done', inFilter: false });
    jira.addIssue({ key: 'OLD-2', status: 'in-progress', inFilter: false });
    jira.blocks('OLD-1', 'APP-1');
    jira.blocks('OLD-2', 'APP-2');
    const { source } = open();
    const stories = source.list();
    expect(stories.map((s) => s.id)).toEqual(['APP-1', 'APP-2']);
    const { order, waiting } = buildOrder(stories, { idPattern: source.idPattern });
    expect(order).toEqual(['APP-1']);
    expect(waiting.map((w) => [w.id, w.on])).toEqual([['APP-2', ['OLD-2 (outside the filter, not done)']]]);
    expect(stories[1].externalDeps).toEqual({ 'OLD-2': 'not done' });
  });

  it('marks issues with the owner label as owner tasks', () => {
    jira.addIssue({ key: 'APP-1', labels: ['foreman', 'foreman-owner'] });
    jira.addIssue({ key: 'APP-2', labels: ['foreman', 'needs-human'] });
    expect(open().source.list().map((s) => s.ownerTask)).toEqual([true, false]);
    expect(open({ ownerLabel: 'needs-human' }).source.list().map((s) => s.ownerTask)).toEqual([false, true]);
  });

  it('shows the overlay status until Jira says done, which then wins', () => {
    jira.addIssue({ key: 'APP-1' });
    jira.addIssue({ key: 'APP-2', status: 'in-progress' });
    const { source } = open({ pollSeconds: 0 });
    expect(source.list().map((s) => s.status)).toEqual(['todo', 'todo']);
    expect(source.update('APP-1', { status: 'blocked', fields: { blockedBy: 'needs a key' } })).toBe(true);
    expect(source.list()[0]).toMatchObject({ status: 'blocked', blockedBy: 'needs a key' });
    jira.setIssue('APP-1', { status: 'done' });
    expect(source.list()[0]).toMatchObject({ status: 'done', blockedBy: '' });
    source.update('APP-2', { status: 'done' });
    expect(source.list()[1].status).toBe('done');
  });

  it('lets a dependsOn set through Foreman replace the links', () => {
    for (const k of ['APP-1', 'APP-2', 'APP-3']) jira.addIssue({ key: k });
    jira.blocks('APP-1', 'APP-3');
    const { source } = open();
    source.update('APP-3', { fields: { dependsOn: ['APP-2'] } });
    expect(source.list()[2].dependsOn).toEqual(['APP-2']);
  });

  it('reuses its answer for pollSeconds, across instances, then asks again', async () => {
    jira.addIssue({ key: 'APP-1' });
    const ws = workspace();
    const before = await searches();
    open({}, ws).source.list();
    expect(await searches()).toBe(before + 1);
    jira.addIssue({ key: 'APP-2' });
    clock = new Date(+T0 + 30_000);
    expect(open({}, ws).source.list().map((s) => s.id)).toEqual(['APP-1']);
    expect(await searches()).toBe(before + 1);
    clock = new Date(+T0 + 61_000);
    expect(open({}, ws).source.list().map((s) => s.id)).toEqual(['APP-1', 'APP-2']);
    expect(await searches()).toBe(before + 2);
  });

  it('asks again at once when the JQL changes, or with pollSeconds 0', async () => {
    jira.addIssue({ key: 'APP-1' });
    jira.addIssue({ key: 'APP-2' });
    jira.setFilter('labels = only-two', ['APP-2']);
    const ws = workspace();
    open({}, ws).source.list();
    expect(open({ jql: 'labels = only-two' }, ws).source.list().map((s) => s.id)).toEqual(['APP-2']);
    const before = await searches();
    const { source } = open({ pollSeconds: 0 }, ws);
    source.list();
    source.list();
    expect(await searches()).toBe(before + 2);
  });

  it('says why when the sign-in is missing', () => {
    const ws = workspace();
    fs.rmSync(ws.home, { recursive: true, force: true });
    jira.addIssue({ key: 'APP-1' });
    expect(() => open({}, ws).source.list()).toThrow('Jira sign-in expired; run `foreman jira login`');
  });

  it('refreshes an expired token with the client id and secret from the env file', () => {
    jira.addIssue({ key: 'APP-1' });
    const ws = workspace({ expiresAt: '2000-01-01T00:00:00.000Z' });
    const envFile = path.join(ws.root, '.env.local');
    fs.writeFileSync(envFile, `JIRA_CLIENT_ID=${CLIENT_ID}\nJIRA_CLIENT_SECRET=${CLIENT_SECRET}\n`);
    expect(() => open({}, ws).source.list()).toThrow(/JIRA_CLIENT_ID and JIRA_CLIENT_SECRET must be set/);
    expect(open({}, ws, { envFile }).source.list().map((s) => s.id)).toEqual(['APP-1']);
  });

  it("refreshes an expired token with the keys only in Foreman's own keys file", async () => {
    // A fake of its own: refresh tokens rotate, so the shared one's first pair may be retired.
    const own = await startFakeJira();
    try {
      own.addIssue({ key: 'APP-1' });
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-jira-src-'));
      dirs.push(root);
      const env = { HOME: path.join(root, 'home'), FOREMAN_JIRA_API_BASE: own.url, FOREMAN_JIRA_AUTH_BASE: own.url };
      writeToken(SITE, { cloudId: own.cloudId, site: SITE, ...own.tokens, expiresAt: '2000-01-01T00:00:00.000Z' }, { env });
      const foremanEnvFile = path.join(root, '.env.foreman');
      fs.writeFileSync(foremanEnvFile, `JIRA_CLIENT_ID=${CLIENT_ID}\nJIRA_CLIENT_SECRET=${CLIENT_SECRET}\n`);
      const source = create({ adapter: 'jira', site: SITE, jql: 'project = APP ORDER BY rank' }, { root, stateDir: path.join(root, '.foreman'), env, now: () => clock, envFile: path.join(root, '.env.local'), foremanEnvFile });
      expect(source.list().map((s) => s.id)).toEqual(['APP-1']);
    } finally {
      await own.close();
    }
  });
});

describe('jira story source: followUpOf(id)', () => {
  const overlayAt = (ws, id, text) => {
    fs.mkdirSync(path.join(ws.stateDir, 'stories'), { recursive: true });
    fs.writeFileSync(path.join(ws.stateDir, 'stories', `${id}.json`), text);
  };

  it('gives the recorded origin of any key, even one Jira does not list, and "" for none', () => {
    const { ws, source } = open();
    overlayAt(ws, 'APP-9', JSON.stringify({ id: 'APP-9', fields: { followUpOf: 'APP-2' }, notes: [], status: 'done' }));
    expect(source.followUpOf('APP-9')).toBe('APP-2');
    expect(source.followUpOf('APP-3')).toBe('');
  });

  it('gives "" for an overlay that is not valid JSON', () => {
    const { ws, source } = open();
    overlayAt(ws, 'APP-9', '{ not json');
    expect(source.followUpOf('APP-9')).toBe('');
  });

  it('makes no Jira call', async () => {
    const { ws, source } = open();
    overlayAt(ws, 'APP-9', JSON.stringify({ id: 'APP-9', fields: { followUpOf: 'APP-2' }, notes: [] }));
    const before = (await jira.requests()).length;
    const searchesBefore = await searches();
    expect(source.followUpOf('APP-9')).toBe('APP-2');
    expect(source.followUpOf('APP-4')).toBe('');
    expect(await searches()).toBe(searchesBefore);
    expect((await jira.requests()).length).toBe(before);
  });
});

describe('jira story source: brief', () => {
  const read = (source, id) => fs.readFileSync(source.brief(id).path, 'utf8');

  it('writes frontmatter, What and Comments to <stateDir>/stories/<KEY>.md', () => {
    jira.addIssue({ key: 'APP-1', summary: 'Add "login": email', description: adf(heading('Context'), 'Users sign in with **email**.') });
    jira.addComment('APP-1', { author: 'Ada Lovelace', created: '2026-10-15T09:30:00.000+0000', body: adf('First thought.') });
    jira.addComment('APP-1', { author: 'Grace Hopper', created: '2026-10-16T10:00:00.000+0000', body: adf('Second thought.', 'More.') });
    const { source, ws } = open();
    const brief = source.brief('APP-1');
    expect(brief.path).toBe(path.join(ws.stateDir, 'stories', 'APP-1.md'));
    expect(fs.readFileSync(brief.path, 'utf8')).toBe([
      '---',
      'id: APP-1',
      'title: "Add \\"login\\": email"',
      'status: todo',
      `url: https://${SITE}/browse/APP-1`,
      '---',
      '',
      '# APP-1 · Add "login": email',
      '',
      '## What',
      '',
      '## Context',
      '',
      'Users sign in with **email**.',
      '',
      '## Done when',
      '',
      '_Not given in the issue._',
      '',
      '## Comments',
      '',
      '_The last 10, newest first._',
      '',
      '### Grace Hopper, 2026-10-16',
      '',
      'Second thought.',
      '',
      'More.',
      '',
      '### Ada Lovelace, 2026-10-15',
      '',
      'First thought.',
      '',
    ].join('\n'));
  });

  it('takes Done when from a heading in the description and leaves it out of What', () => {
    jira.addIssue({
      key: 'APP-1',
      description: adf('Build the page.', heading('Done when', 3), 'The page loads.', { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'tests pass' }] }] }] }, heading('Notes'), 'Keep it small.'),
    });
    const text = read(open().source, 'APP-1');
    const what = text.split('## What\n')[1].split('\n## Done when\n')[0];
    const done = text.split('\n## Done when\n')[1].split('\n## ')[0];
    expect(what.trim()).toBe('Build the page.\n\n## Notes\n\nKeep it small.');
    expect(done.trim()).toBe('The page loads.\n\n- tests pass');
  });

  it('takes Done when from the custom field, ADF or text', () => {
    jira.addIssue({ key: 'APP-1', description: adf('Build it.'), fields: { customfield_10050: adf('It is **built**.') } });
    jira.addIssue({ key: 'APP-2', description: adf('Build it.'), fields: { customfield_10050: 'Plain text.' } });
    const { source } = open({ doneWhenField: 'customfield_10050' });
    expect(read(source, 'APP-1')).toContain('## Done when\n\nIt is **built**.\n');
    expect(read(source, 'APP-2')).toContain('## Done when\n\nPlain text.\n');
  });

  it('carries the overlay status and progress notes, and honours briefsDir', () => {
    jira.addIssue({ key: 'APP-1' });
    const { source, ws } = open({ briefsDir: 'briefs' });
    source.update('APP-1', { status: 'in-progress', note: 'Started.' });
    const brief = source.brief('APP-1');
    expect(brief.path).toBe(path.join(ws.root, 'briefs', 'APP-1.md'));
    const text = fs.readFileSync(brief.path, 'utf8');
    expect(text).toContain('\nstatus: in-progress\n');
    expect(text).toMatch(/## Progress notes\n\n_Newest first._\n\n- \*\*2026-10-17\*\* — Started\.\n/);
  });

  it('finalize has nothing to change', () => {
    jira.addIssue({ key: 'APP-1' });
    expect(open().source.finalize('APP-1', { note: 'x' })).toEqual({ path: null });
  });
});
