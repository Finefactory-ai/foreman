import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jiraEnv } from './cache.mjs';

let dir;
let local;
let own;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-jira-env-'));
  local = path.join(dir, '.env.local');
  own = path.join(dir, '.env.foreman');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('jiraEnv', () => {
  it('takes the environment over .env.foreman over .env.local', () => {
    fs.writeFileSync(local, 'JIRA_CLIENT_SECRET=from-local\nJIRA_CLIENT_ID=id-local\n');
    fs.writeFileSync(own, 'JIRA_CLIENT_SECRET=from-foreman\n');
    expect(jiraEnv({}, local, own)).toMatchObject({ JIRA_CLIENT_SECRET: 'from-foreman', JIRA_CLIENT_ID: 'id-local' });
    expect(jiraEnv({ JIRA_CLIENT_SECRET: 'from-env' }, local, own).JIRA_CLIENT_SECRET).toBe('from-env');
  });

  it('takes only registry names from .env.foreman', () => {
    fs.writeFileSync(own, 'ACME_DB_URL=postgres://acme\nJIRA_CLIENT_ID=acme-id\n');
    const env = jiraEnv({}, local, own);
    expect(env.JIRA_CLIENT_ID).toBe('acme-id');
    expect(env).not.toHaveProperty('ACME_DB_URL');
  });

  it('with no .env.foreman, is .env.local under the environment, as before', () => {
    fs.writeFileSync(local, 'JIRA_CLIENT_SECRET=from-local\nACME_URL=u\n');
    expect(jiraEnv({ HOME: '/h' }, local, own)).toEqual({ JIRA_CLIENT_SECRET: 'from-local', ACME_URL: 'u', HOME: '/h' });
    expect(jiraEnv({ HOME: '/h' }, local)).toEqual({ JIRA_CLIENT_SECRET: 'from-local', ACME_URL: 'u', HOME: '/h' });
  });
});
