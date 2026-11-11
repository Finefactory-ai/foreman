import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { commentSwitch, doneChange, fetchStoryTarget, openProjectStories, openStorySource, storyCommentsOn, storyTarget, storyUpdate } from './story-source.mjs';
import { ACME_QA_ID } from '../../../test/fake-sf.mjs';
import { writeToken } from '../jira/auth.mjs';
import { CLIENT_ID, CLIENT_SECRET } from '../../../test/fake-atlassian.mjs';
import { startFakeJira } from '../../../test/fake-jira.mjs';

let root;
afterEach(() => root && rmSync(root, { recursive: true, force: true }));

describe('openStorySource', () => {
  it('opens the markdown source named in the config', () => {
    root = mkdtempSync(join(tmpdir(), 'story-source-'));
    mkdirSync(join(root, 'stories'));
    writeFileSync(join(root, 'stories', 'S-1.md'), '---\nid: S-1\ntitle: One\nstatus: todo\n---\n');
    const source = openStorySource({ root, config: { stories: { adapter: 'markdown', dir: 'stories' } } });
    expect(source.list().map((s) => s.id)).toEqual(['S-1']);
  });

  it('keeps in-project story status in the state folder', () => {
    root = mkdtempSync(join(tmpdir(), 'story-source-'));
    mkdirSync(join(root, 'stories'));
    writeFileSync(join(root, 'stories', 'S-1.md'), '---\nid: S-1\ntitle: One\nstatus: todo\n---\n');
    const config = { stateDir: 'state', stories: { adapter: 'markdown', dir: 'stories' } };
    openStorySource({ root, config, env: {} }).update('S-1', { status: 'blocked' });
    expect(existsSync(join(root, 'state', 'stories', 'S-1.json'))).toBe(true);
    openStorySource({ root, config, env: { FOREMAN_STATE_DIR: join(root, 'shared') } }).update('S-1', { status: 'blocked' });
    expect(existsSync(join(root, 'shared', 'stories', 'S-1.json'))).toBe(true);
  });

  it('rejects an unknown adapter', () => {
    expect(() => openStorySource({ root: '/x', config: { stories: { adapter: 'linear', dir: 'x' } } })).toThrow('unknown story source: linear');
  });

  it('opens the jira source, with the project env file', () => {
    const source = openStorySource({ root: '/x', config: { envFile: '.env.local', stories: { adapter: 'jira', site: 'acme.atlassian.net', jql: 'project = APP' } }, env: {} });
    expect(source.idPattern).toBe('[A-Z][A-Z0-9_]+-\\d+');
    expect(source.site).toBe('acme.atlassian.net');
  });

  it('opens the salesforce source with the orgs of config.salesforce.orgs', () => {
    root = mkdtempSync(join(tmpdir(), 'story-source-'));
    const config = {
      stateDir: '.foreman',
      pack: 'salesforce',
      salesforce: { orgs: { 'acme-qa': { orgId: ACME_QA_ID } } },
      stories: { adapter: 'salesforce', org: 'acme-qa', where: 'IsClosed = false', pollSeconds: 0 },
    };
    const source = openStorySource({ root, config, env: {}, cacheOnly: true });
    expect(source.idPattern).toBe('\\d{8,10}');
    expect(source.org).toBe('acme-qa');
    // cache-only: nothing cached yet, and no sf call is made
    expect(source.list()).toEqual([]);
  });

  it('refuses a salesforce source whose org is not in config.salesforce.orgs', () => {
    expect(() => openStorySource({ root: '/x', config: { stories: { adapter: 'salesforce', org: 'acme-qa', where: 'IsClosed = false' } }, env: {} })).toThrow('stories.org: acme-qa is not in salesforce.orgs');
  });

  describe("with Foreman's own keys file", () => {
    let jira;
    beforeAll(async () => {
      jira = await startFakeJira();
    });
    afterAll(async () => {
      await jira.close();
    });

    it('hands the jira source foremanEnvFile, so keys only there refresh a token', () => {
      root = mkdtempSync(join(tmpdir(), 'story-source-'));
      const site = 'acme.atlassian.net';
      const env = { HOME: join(root, 'home'), FOREMAN_JIRA_API_BASE: jira.url, FOREMAN_JIRA_AUTH_BASE: jira.url };
      writeToken(site, { cloudId: jira.cloudId, site, ...jira.tokens, expiresAt: '2000-01-01T00:00:00.000Z' }, { env });
      jira.addIssue({ key: 'ACME-1' });
      writeFileSync(join(root, '.env.foreman'), `JIRA_CLIENT_ID=${CLIENT_ID}\nJIRA_CLIENT_SECRET=${CLIENT_SECRET}\n`);
      const config = { envFile: '.env.local', foremanEnvFile: '.env.foreman', stories: { adapter: 'jira', site, jql: 'project = ACME' } };
      expect(openStorySource({ root, config, env }).list().map((s) => s.id)).toEqual(['ACME-1']);
    });
  });

  it('opens the jira source cache-only when asked, so it never calls Jira', () => {
    root = mkdtempSync(join(tmpdir(), 'story-source-'));
    const config = { stories: { adapter: 'jira', site: 'acme.atlassian.net', jql: 'project = ACME' } };
    const env = { HOME: join(root, 'home'), FOREMAN_JIRA_API_BASE: 'http://127.0.0.1:9', FOREMAN_JIRA_AUTH_BASE: 'http://127.0.0.1:9' };
    const source = openStorySource({ root, config, env, cacheOnly: true });
    const started = Date.now();
    expect(source.list()).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(source.brief('ACME-1')).toBeNull();
  });
});

describe('storyTarget', () => {
  const staged = (extra = {}, into = 'qa') => ({ baseBranch: 'main', ship: { pr: { into } }, ...extra });

  it('is null when pull requests merge into the base branch', () => {
    expect(storyTarget({})).toBeNull();
    expect(storyTarget(undefined)).toBeNull();
    expect(storyTarget(staged({}, 'main'))).toBeNull();
    expect(storyTarget({ baseBranch: 'develop', ship: { pr: { into: 'develop' } } })).toBeNull();
  });

  it('is null for a branch or remote git could read as an option or a path', () => {
    for (const into of ['-x', 'a..b', 'qa/']) expect(storyTarget(staged({}, into))).toBeNull();
    for (const remote of ['-o', 'a/b']) expect(storyTarget(staged({ remote }))).toBeNull();
  });

  it('is the remote and the branch pull requests merge into', () => {
    expect(storyTarget(staged())).toEqual({ remote: 'origin', branch: 'qa' });
    expect(storyTarget(staged({ remote: 'upstream' }))).toEqual({ remote: 'upstream', branch: 'qa' });
    expect(storyTarget({ ship: { pr: { into: 'qa' } } })).toEqual({ remote: 'origin', branch: 'qa' });
  });
});

describe('fetchStoryTarget', () => {
  const config = { baseBranch: 'main', ship: { pr: { into: 'qa' } } };
  const recorder = (status) => {
    const calls = [];
    return { calls, sh: (...call) => (calls.push(call), { status, stdout: '', stderr: '' }) };
  };

  it('makes no call and warns of nothing without a stage branch', () => {
    const { calls, sh } = recorder(1);
    expect(fetchStoryTarget({ root: '/x', config: {}, sh })).toBeNull();
    expect(calls).toEqual([]);
  });

  it('fetches the stage branch into its remote-tracking ref', () => {
    const { calls, sh } = recorder(0);
    expect(fetchStoryTarget({ root: '/x', config, sh })).toBeNull();
    expect(calls).toEqual([['git', ['fetch', '--quiet', 'origin', '+refs/heads/qa:refs/remotes/origin/qa'], { cwd: '/x' }]]);
  });

  it('warns, naming the branch and the remote, when the fetch fails', () => {
    const { sh } = recorder(1);
    const warning = fetchStoryTarget({ root: '/x', config, sh });
    expect(warning).toContain('qa');
    expect(warning).toContain('origin');
  });
});

describe('openStorySource with stage branches', () => {
  it('reads a story shipped on the stage branch as done', () => {
    root = mkdtempSync(join(tmpdir(), 'story-source-'));
    const run = (...args) => {
      const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(r.stderr);
      return r.stdout.trim();
    };
    mkdirSync(join(root, 'stories', '.shipped'), { recursive: true });
    writeFileSync(join(root, 'stories', 'S-1.md'), '---\nid: S-1\ntitle: One\nstatus: todo\n---\n');
    writeFileSync(join(root, 'stories', '.shipped', 'S-1.json'), '{"id":"S-1","status":"done","notes":[]}\n');
    writeFileSync(join(root, '.gitignore'), '.foreman/\n');
    run('init', '-q', '-b', 'main');
    run('add', '-A', '-f');
    run('commit', '-qm', 'records');
    run('update-ref', 'refs/remotes/origin/qa', 'HEAD');
    rmSync(join(root, 'stories', '.shipped'), { recursive: true });
    const config = { baseBranch: 'main', ship: { pr: { into: 'qa' } }, stories: { adapter: 'markdown', dir: 'stories' } };
    const source = openStorySource({ root, config, env: { PATH: process.env.PATH } });
    expect(source.list().map((s) => [s.id, s.status])).toEqual([['S-1', 'done']]);
    const plain = openStorySource({ root, config: { ...config, ship: undefined }, env: { PATH: process.env.PATH } });
    expect(plain.list().map((s) => [s.id, s.status])).toEqual([['S-1', 'todo']]);
  });
});

describe('openProjectStories', () => {
  it('opens the source named in the project config', () => {
    root = mkdtempSync(join(tmpdir(), 'story-project-'));
    mkdirSync(join(root, 'stories'));
    writeFileSync(join(root, 'stories', 'S-1.md'), '---\nid: S-1\ntitle: One\nstatus: todo\n---\n');
    writeFileSync(join(root, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'x' } }));
    expect(openProjectStories({ root }).list().map((s) => s.id)).toEqual(['S-1']);
  });

  it('says why when there is no usable config', () => {
    root = mkdtempSync(join(tmpdir(), 'story-project-'));
    expect(() => openProjectStories({ root })).toThrow(/^cannot open stories: : no foreman\.config\.json in /);
  });
});

describe('storyUpdate', () => {
  it('maps fields.status to status and progress to note', () => {
    expect(storyUpdate({ fields: { status: 'blocked', blocked_by: 'x' }, progress: 'hi' })).toEqual({ status: 'blocked', fields: { blocked_by: 'x' }, note: 'hi' });
  });
  it('leaves status out when not given', () => {
    expect(storyUpdate({ progress: 'hi' })).toEqual({ fields: {}, note: 'hi' });
  });
});

describe('doneChange', () => {
  const at = new Date(2026, 9, 15);
  it('folds the note to one line', () => {
    expect(doneChange('line one\n\n  line two\t end', at).note).toBe('line one line two end');
  });
  it('caps the note at 500 characters', () => {
    expect(doneChange('x'.repeat(600), at).note).toHaveLength(500);
  });
  it('marks the story done, with the local date and the shipped event', () => {
    expect(doneChange('Shipped in #4', at)).toEqual({ status: 'done', fields: { completed: '2026-10-15' }, note: 'Shipped in #4', event: 'shipped' });
  });
});

describe('commentSwitch and storyCommentsOn', () => {
  it('names the Jira switch for markdown and Jira, and the Salesforce switch for Salesforce', () => {
    expect(commentSwitch({ stories: { adapter: 'markdown' } })).toBe('jiraComments');
    expect(commentSwitch({ stories: { adapter: 'jira' } })).toBe('jiraComments');
    expect(commentSwitch({})).toBe('jiraComments');
    expect(commentSwitch(undefined)).toBe('jiraComments');
    expect(commentSwitch({ stories: { adapter: 'salesforce' } })).toBe('salesforceComments');
  });

  it('reads that switch from the features, on only when it is true', () => {
    expect(storyCommentsOn({ stories: { adapter: 'jira' }, features: { jiraComments: true, salesforceComments: false } })).toBe(true);
    expect(storyCommentsOn({ stories: { adapter: 'markdown' }, features: { jiraComments: false, salesforceComments: true } })).toBe(false);
    expect(storyCommentsOn({ stories: { adapter: 'salesforce' }, features: { jiraComments: true, salesforceComments: false } })).toBe(false);
    expect(storyCommentsOn({ stories: { adapter: 'salesforce' }, features: { jiraComments: false, salesforceComments: true } })).toBe(true);
    expect(storyCommentsOn({ stories: { adapter: 'salesforce' }, features: {} })).toBe(false);
    expect(storyCommentsOn({})).toBe(false);
  });
});
