// `foreman learn` on a project whose stories come from Jira, against the fake Atlassian. A
// filter such as `statusCategory != Done` leaves shipped issues out of list(), so whether a
// shipped story is itself a follow-up comes from its recorded origin (the overlay).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../main.mjs';
import { writeToken } from '../../jira/auth.mjs';
import { adfToMarkdown } from '../../jira/adf.mjs';
import { startFakeJira } from '../../../../test/fake-jira.mjs';

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

const state = () => path.join(dir, '.foreman');
const ledger = () => JSON.parse(fs.readFileSync(path.join(state(), 'learn.json'), 'utf8'));
const overlayFile = () => path.join(state(), 'stories', 'APP-9.json');
const config = (extra = {}) =>
  fs.writeFileSync(
    path.join(dir, 'foreman.config.json'),
    JSON.stringify({
      version: 1,
      project: { name: 'T' },
      checks: [{ run: 'true', when: 'always' }],
      stories: { adapter: 'jira', site: SITE, jql: 'project = APP AND statusCategory != Done ORDER BY rank' },
      ...extra,
    }),
  );
const minor = (story, rule) => JSON.stringify({ at: '2026-10-15T08:00:00Z', story, result: 'shipped', builder: 'developer', stage: 'review', severity: 'minor', rule, where: 'src/a.js', observed: 'no test for the empty case', fix: 'add one' });

beforeEach(() => {
  jira.reset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-learn-jira-'));
  env = { FOREMAN_PROJECT_DIR: dir, FOREMAN_SLOT: 'w1', HOME: path.join(dir, 'home'), FOREMAN_JIRA_API_BASE: jira.url, FOREMAN_JIRA_AUTH_BASE: jira.url };
  writeToken(SITE, { cloudId: jira.cloudId, site: SITE, ...jira.tokens, expiresAt: '2999-01-01T00:00:00.000Z' }, { env });
  config();
  jira.addIssue({ key: 'APP-2', summary: 'Sign in', status: 'done', inFilter: false });
  jira.addIssue({ key: 'APP-9', summary: 'Follow-ups from APP-2', status: 'done', inFilter: false });
  jira.addIssue({ key: 'APP-5', summary: 'Profile page', status: 'done', inFilter: false });
  jira.addIssue({ key: 'APP-7', summary: 'Open work' });
  fs.mkdirSync(path.join(state(), 'stories'), { recursive: true });
  fs.writeFileSync(overlayFile(), JSON.stringify({ id: 'APP-9', fields: { followUpOf: 'APP-2', completed: '2026-10-15' }, notes: [], status: 'done' }));
  fs.writeFileSync(path.join(state(), 'findings.jsonl'), `${[minor('APP-9', 'Cover the empty case'), minor('APP-5', 'Log errors')].join('\n')}\n`);
});

async function run(argv) {
  let out = '';
  let err = '';
  const code = await main(argv, {
    cwd: dir,
    env,
    now: () => new Date('2026-10-15T09:00:00Z'),
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
  });
  return { code, out, err };
}
const pending = async () => JSON.parse((await run(['decide', 'pending'])).out);

describe('foreman learn with Jira stories: follow-ups of shipped follow-ups', () => {
  it('by default, proposes nothing from a shipped follow-up the filter leaves out', async () => {
    const { code, out, err } = await run(['learn']);
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(out).toContain('APP-9 is itself a follow-up; not proposing follow-ups from it (features.followUpsOfFollowUps is off)');
    expect(out).toContain('Proposed 1 follow-up(s) from minor findings.');
    expect((await pending()).map((i) => i.story)).toEqual(['APP-5']);
    expect(Object.keys(ledger().proposed)).toEqual(['followup:APP-5:log errors']);
  });

  it('--dry-run skips it too', async () => {
    const { code, out } = await run(['learn', '--dry-run']);
    expect(code).toBe(0);
    expect(out).not.toContain('Would ask: Follow up on APP-9');
    expect(out).toContain('Would ask: Follow up on APP-5');
  });

  it('proposes it as before when features.followUpsOfFollowUps is on', async () => {
    config({ features: { followUpsOfFollowUps: true } });
    const { code, out } = await run(['learn']);
    expect(code).toBe(0);
    expect(out).toContain('Proposed 2 follow-up(s) from minor findings.');
    expect((await pending()).map((i) => i.story).sort()).toEqual(['APP-5', 'APP-9']);
  });

  it('decides from the recorded origin, not the title: with no overlay it is proposed', async () => {
    fs.rmSync(overlayFile());
    const { code, out } = await run(['learn']);
    expect(code).toBe(0);
    expect(out).not.toContain('APP-9 is itself a follow-up');
    expect(out).toContain('Proposed 2 follow-up(s) from minor findings.');
    expect((await pending()).map((i) => i.story).sort()).toEqual(['APP-5', 'APP-9']);
  });
});

describe('foreman learn with Jira stories: features.autoCreateFollowUps', () => {
  it('creates the follow-up at once, with priority Low, the labels and a link to its parent', async () => {
    jira.setIssue('APP-5', { labels: ['foreman', 'web'] });
    config({ features: { autoCreateFollowUps: true } });
    const { code, out, err } = await run(['learn']);
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(out).toContain('Created APP-10: Follow-ups from APP-5\n');
    expect(out).toContain('APP-9 is itself a follow-up');
    const issue = jira.issue('APP-10');
    expect(issue).toMatchObject({ summary: 'Follow-ups from APP-5', labels: ['foreman', 'web'], fields: { priority: { name: 'Low' } } });
    expect(jira.links()).toContainEqual({ type: expect.objectContaining({ name: 'Relates' }), outward: 'APP-10', inward: 'APP-5' });
    expect((await pending()).map((i) => i.title)).toEqual(['Foreman created 1 follow-up story']);
  });

  it('writes one "follow-up created" comment with the new key on the story it follows up, and not twice', async () => {
    // APP-5 shipped through Foreman, so it has the overlay a shipped story has.
    fs.writeFileSync(path.join(state(), 'stories', 'APP-5.json'), JSON.stringify({ id: 'APP-5', fields: { completed: '2026-10-15' }, notes: [], status: 'done' }));
    config({ features: { autoCreateFollowUps: true } });
    expect((await run(['learn'])).code).toBe(0);
    const texts = () => jira.comments('APP-5').map((c) => adfToMarkdown(c.body));
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toMatch(/^Foreman: follow-up created\n\nForeman created APP-10 \(Follow-ups from APP-5\) for the minor findings this story left\.\n\nAt 2026-10-15 09:00 UTC, slot w1\.$/);
    expect(jira.comments('APP-9')).toEqual([]);
    await run(['learn']);
    expect(texts()).toHaveLength(1);
  });

  it('the manual "Create a follow-up story" writes the same one comment on the origin', async () => {
    fs.writeFileSync(path.join(state(), 'stories', 'APP-5.json'), JSON.stringify({ id: 'APP-5', fields: { completed: '2026-10-15' }, notes: [], status: 'done' }));
    config({ features: { followUpsOfFollowUps: false } });
    await run(['learn']);
    const [item] = await pending();
    await run(['decide', 'answer', item.id, 'Create a follow-up story']);
    expect((await run(['learn', 'apply', item.id])).code).toBe(0);
    const comments = jira.comments('APP-5').map((c) => adfToMarkdown(c.body));
    expect(comments.filter((t) => t.startsWith('Foreman: follow-up created'))).toHaveLength(1);
    expect(comments.join('\n')).toContain('Foreman created APP-10 (Follow-ups from APP-5)');
  });

  it('writes no comment with features.jiraComments off, and the follow-up is still made', async () => {
    fs.writeFileSync(path.join(state(), 'stories', 'APP-5.json'), JSON.stringify({ id: 'APP-5', fields: {}, notes: [], status: 'done' }));
    config({ features: { autoCreateFollowUps: true, jiraComments: false } });
    const { out } = await run(['learn']);
    expect(out).toContain('Created APP-10');
    expect(jira.comments('APP-5')).toEqual([]);
  });

  it('the manual "Create a follow-up story" sends no priority', async () => {
    config({ features: { followUpsOfFollowUps: false } });
    await run(['learn']);
    const [item] = await pending();
    await run(['decide', 'answer', item.id, 'Create a follow-up story']);
    expect((await run(['learn', 'apply', item.id])).code).toBe(0);
    expect(jira.issue('APP-10').fields).not.toHaveProperty('priority');
  });
});
