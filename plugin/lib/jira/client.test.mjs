import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jiraClient, JiraError } from './client.mjs';
import { writeToken, readToken, JiraLoginExpired } from './auth.mjs';
import { startFakeAtlassian } from '../../../test/fake-atlassian.mjs';

const SITE = 'acme.atlassian.net';
let home;
let fake;
let env;
let sleeps;
const sleep = async (ms) => { sleeps.push(ms); };
const now = () => new Date('2026-10-17T12:00:00Z');

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-jira-home-'));
  fake = await startFakeAtlassian();
  sleeps = [];
  env = {
    HOME: home,
    FOREMAN_JIRA_AUTH_BASE: fake.url,
    FOREMAN_JIRA_API_BASE: fake.url,
    JIRA_CLIENT_ID: fake.clientId,
    JIRA_CLIENT_SECRET: fake.clientSecret,
  };
  const { accessToken, refreshToken } = fake.issueTokens();
  writeToken(SITE, { cloudId: 'cloud-acme-1', site: SITE, accessToken, refreshToken, expiresAt: '2026-10-17T13:00:00.000Z', account: null }, { env });
});
afterEach(async () => {
  await fake.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const client = () => jiraClient({ site: SITE, env, sleep, now });

describe('jiraClient', () => {
  it('calls /ex/jira/<cloudId>/rest/api/3/... on the API base', async () => {
    const me = await client().request('GET', '/myself');
    expect(me.displayName).toBe('Ada Lovelace');
    expect(fake.requests.at(-1).path).toBe('/ex/jira/cloud-acme-1/rest/api/3/myself');
  });

  it('accepts a full /rest/ path as is, and sends a JSON body', async () => {
    const r = await client().request('POST', '/rest/api/3/search/jql', { jql: 'project = A', maxResults: 1 });
    expect(r).toEqual({ issues: [], isLast: true });
  });

  it('on a 401 refreshes once and retries', async () => {
    const before = readToken(SITE, { env });
    fake.revokeAccessTokens();
    const me = await client().request('GET', '/myself');
    expect(me.displayName).toBe('Ada Lovelace');
    expect(fake.tokenCalls).toBe(1);
    expect(readToken(SITE, { env }).refreshToken).not.toBe(before.refreshToken);
  });

  it('a second 401 after the refresh is an error, not a loop', async () => {
    fake.failNext({ status: 401, times: 2 });
    const err = await client().request('GET', '/myself').catch((e) => e);
    expect(err).toBeInstanceOf(JiraError);
    expect(err.status).toBe(401);
    expect(fake.tokenCalls).toBe(1);
  });

  it('a refresh that fails with invalid_grant surfaces JiraLoginExpired', async () => {
    const r = readToken(SITE, { env });
    writeToken(SITE, { ...r, refreshToken: 'rt-unknown' }, { env });
    fake.revokeAccessTokens();
    await expect(client().request('GET', '/myself')).rejects.toBeInstanceOf(JiraLoginExpired);
  });

  it('on 429 waits Retry-After seconds, then succeeds', async () => {
    fake.failNext({ status: 429, headers: { 'retry-after': '7' } });
    const me = await client().request('GET', '/myself');
    expect(me.displayName).toBe('Ada Lovelace');
    expect(sleeps).toEqual([7000]);
  });

  it('on 503 without Retry-After waits 5 s', async () => {
    fake.failNext({ status: 503 });
    await client().request('GET', '/myself');
    expect(sleeps).toEqual([5000]);
  });

  it('tries 3 times in all, then fails with the status', async () => {
    fake.failNext({ status: 429, headers: { 'retry-after': '2' }, times: 3 });
    const err = await client().request('GET', '/myself').catch((e) => e);
    expect(err).toBeInstanceOf(JiraError);
    expect(err.status).toBe(429);
    expect(sleeps).toEqual([2000, 2000]);
  });

  it('errors carry the status and Jira\'s errorMessages, never the token', async () => {
    const err = await client().request('POST', '/search/jql', { jql: 'INVALID' }).catch((e) => e);
    expect(err).toBeInstanceOf(JiraError);
    expect(err.status).toBe(400);
    expect(err.errorMessages).toEqual(["Error in the JQL Query: 'INVALID'"]);
    expect(err.message).toContain("Error in the JQL Query: 'INVALID'");
    expect(err.message).toContain('400');
    const { accessToken, refreshToken } = readToken(SITE, { env });
    expect(err.message).not.toContain(accessToken);
    expect(JSON.stringify(err)).not.toContain(accessToken);
    expect(JSON.stringify(err)).not.toContain(refreshToken);
  });

  it('refreshes before the call when the token is about to expire', async () => {
    const r = readToken(SITE, { env });
    writeToken(SITE, { ...r, expiresAt: '2026-10-17T12:00:30.000Z' }, { env });
    await client().request('GET', '/myself');
    expect(fake.tokenCalls).toBe(1);
  });
});
