import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeJiraCommand } from './jira.mjs';
import { main } from '../main.mjs';
import { readToken, tokenPath, writeToken } from '../../jira/auth.mjs';
import { startFakeAtlassian } from '../../../../test/fake-atlassian.mjs';

const SITE = 'acme.atlassian.net';
let dir;
let home;
let fake;
let output; // every byte written to stdout or stderr in a test

const writeConfig = (stories) => fs.writeFileSync(
  path.join(dir, 'foreman.config.json'),
  JSON.stringify({ version: 1, project: { name: 'T' }, stories }),
);

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-jira-cli-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-jira-home-'));
  fake = await startFakeAtlassian();
  output = '';
  writeConfig({ adapter: 'jira', site: SITE });
  fs.writeFileSync(path.join(dir, '.env.local'), `JIRA_CLIENT_ID=${fake.clientId}\nJIRA_CLIENT_SECRET=${fake.clientSecret}\n`);
});
afterEach(async () => {
  await fake.close();
  delete process.env.JIRA_CLIENT_ID;
  delete process.env.JIRA_CLIENT_SECRET;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

const baseEnv = () => ({ HOME: home, FOREMAN_PROJECT_DIR: dir, FOREMAN_JIRA_AUTH_BASE: fake.url, FOREMAN_JIRA_API_BASE: fake.url });

// Runs `foreman jira <args>`. `onUrl` is called with the authorize URL once it is printed;
// `readLine` answers the --paste prompt.
function run(args, { onUrl, opened, timeoutMs, now, readLine } = {}) {
  let out = '';
  let err = '';
  let seen = false;
  const look = () => {
    if (seen || !onUrl) return;
    const m = /(http:\/\/127\.0\.0\.1:\d+\/authorize\?\S+)/.exec(out);
    if (m) {
      seen = true;
      onUrl(m[1]);
    }
  };
  const command = makeJiraCommand({
    open: (url) => { opened?.push(url); look(); },
    timeoutMs,
    readLine: readLine ?? (async () => { throw new Error('no input'); }),
  });
  const promise = command.run(args, {
    cwd: dir,
    root: dir,
    env: baseEnv(),
    now: now ?? (() => new Date('2026-10-17T12:00:00Z')),
    stdout: { write: (s) => { out += s; output += s; look(); } },
    stderr: { write: (s) => { err += s; output += s; } },
  });
  return promise.then((code) => ({ code, out, err }));
}

// Plays the browser: follow the authorize URL to the fake, which redirects to our callback.
async function browse(authorize, { tamper } = {}) {
  const res = await fetch(authorize, { redirect: 'manual' });
  expect(res.status).toBe(302);
  const callback = new URL(res.headers.get('location'));
  if (tamper) tamper(callback);
  const answer = await fetch(callback);
  return { status: answer.status, text: await answer.text() };
}

const assertNoSecrets = () => {
  for (const s of fake.secrets()) expect(output).not.toContain(s);
};

describe('foreman jira login', () => {
  it('signs in end to end through a scripted callback, and saves the token file', async () => {
    let browsed;
    const r = await run(['login', '--port', '0', '--no-open'], { onUrl: (u) => { browsed = browse(u); } });
    const page = await browsed;
    expect(page.status).toBe(200);
    expect(page.text).toMatch(/Signed in/);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Signed in to ${SITE} as Ada Lovelace`);

    const q = fake.authorizeCalls[0];
    expect(q.scope.split(' ')).toEqual(['read:jira-work', 'write:jira-work', 'read:jira-user', 'offline_access']);
    expect(q.redirect_uri).toMatch(/^http:\/\/localhost:\d+\/callback$/);
    expect(q.state).toMatch(/^[0-9a-f]{32,}$/);

    const saved = readToken(SITE, { env: { HOME: home } });
    expect(saved).toMatchObject({ cloudId: 'cloud-acme-1', site: SITE, account: { accountId: fake.account.accountId, displayName: 'Ada Lovelace' } });
    expect(saved.accessToken).toMatch(/^at-/);
    expect(saved.refreshToken).toMatch(/^rt-/);
    expect(saved.expiresAt).toBe('2026-10-17T13:00:00.000Z');
    expect(saved.savedAt).toBe('2026-10-17T12:00:00.000Z');
    expect(fs.statSync(tokenPath(SITE, { env: { HOME: home } })).mode & 0o777).toBe(0o600);
    assertNoSecrets();
  });

  it('refuses a callback whose state does not match, and saves nothing', async () => {
    let browsed;
    const r = await run(['login', '--port', '0', '--no-open'], {
      onUrl: (u) => { browsed = browse(u, { tamper: (cb) => cb.searchParams.set('state', 'forged') }); },
    });
    const page = await browsed;
    expect(page.status).toBe(400);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/state/i);
    expect(readToken(SITE, { env: { HOME: home } })).toBeNull();
    expect(fake.tokenCalls).toBe(0);
    assertNoSecrets();
  });

  it('opens the browser unless --no-open', async () => {
    const opened = [];
    let browsed;
    const r = await run(['login', '--port', '0'], { opened, onUrl: (u) => { browsed = browse(u); } });
    await browsed;
    expect(r.code).toBe(0);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatch(/\/authorize\?/);
  });

  it('reports an error the user chose at the consent screen', async () => {
    let browsed;
    const r = await run(['login', '--port', '0', '--no-open'], {
      onUrl: (u) => {
        browsed = browse(u, { tamper: (cb) => { cb.searchParams.delete('code'); cb.searchParams.set('error', 'access_denied'); } });
      },
    });
    await browsed;
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/access_denied/);
  });

  it('gives up after the timeout when no callback comes', async () => {
    const r = await run(['login', '--port', '0', '--no-open'], { timeoutMs: 50 });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no sign-in/i);
  });

  it('fails when no accessible site matches stories.site', async () => {
    writeConfig({ adapter: 'jira', site: 'other.atlassian.net' });
    let browsed;
    const r = await run(['login', '--port', '0', '--no-open'], { onUrl: (u) => { browsed = browse(u); } });
    await browsed;
    expect(r.code).toBe(1);
    expect(r.err).toContain('other.atlassian.net');
    expect(r.err).toContain('acme.atlassian.net');
    assertNoSecrets();
  });

  it('needs stories.site', async () => {
    writeConfig({ adapter: 'markdown', dir: 'stories' });
    const r = await run(['login', '--no-open']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/stories\.site/);
  });

  it('names the missing env variables without printing any values', async () => {
    fs.writeFileSync(path.join(dir, '.env.local'), `JIRA_CLIENT_ID=${fake.clientId}\n`);
    const r = await run(['login', '--no-open']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('JIRA_CLIENT_SECRET');
    expect(r.err).toContain('Put JIRA_CLIENT_ID and JIRA_CLIENT_SECRET in .env.foreman.');
    expect(r.err).not.toContain(fake.clientId);
  });

  it("signs in with the keys only in Foreman's own keys file", async () => {
    fs.rmSync(path.join(dir, '.env.local'));
    fs.writeFileSync(path.join(dir, '.env.foreman'), `JIRA_CLIENT_ID=${fake.clientId}\nJIRA_CLIENT_SECRET=${fake.clientSecret}\n`);
    let browsed;
    const r = await run(['login', '--port', '0', '--no-open'], { onUrl: (u) => { browsed = browse(u); } });
    expect((await browsed).status).toBe(200);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    assertNoSecrets();
  });

  it('takes the .env.foreman keys over the .env.local ones', async () => {
    fs.writeFileSync(path.join(dir, '.env.local'), 'JIRA_CLIENT_ID=wrong-id\nJIRA_CLIENT_SECRET=wrong-secret\n');
    fs.writeFileSync(path.join(dir, '.env.foreman'), `JIRA_CLIENT_ID=${fake.clientId}\nJIRA_CLIENT_SECRET=${fake.clientSecret}\n`);
    let browsed;
    const r = await run(['login', '--port', '0', '--no-open'], { onUrl: (u) => { browsed = browse(u); } });
    expect((await browsed).status).toBe(200);
    expect(r.code).toBe(0);
  });

  it('says it could not read .env.foreman when that file cannot be read', async () => {
    fs.mkdirSync(path.join(dir, '.env.foreman'));
    const r = await run(['login', '--no-open']);
    expect(r.code).toBe(1);
    expect(r.err).toBe('Could not read .env.foreman.\n');
  });
});

describe('foreman jira login --paste', () => {
  // Plays a browser on another machine: follows the consent address to the fake, and gives
  // back the callback address it lands on, which nothing is listening at.
  const landing = async (authorize, tamper) => {
    const res = await fetch(authorize, { redirect: 'manual' });
    const callback = new URL(res.headers.get('location'));
    if (tamper) tamper(callback);
    return callback.toString();
  };
  const pasting = (tamper, wrap = (u) => u) => {
    let url;
    const seen = new Promise((resolve) => { url = resolve; });
    return {
      onUrl: (u) => url(u),
      readLine: async () => wrap(await landing(await seen, tamper)),
    };
  };

  it('signs in from the pasted callback address, with no server and no browser', async () => {
    const opened = [];
    const r = await run(['login', '--paste'], { opened, ...pasting() });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(opened).toEqual([]);
    expect(r.out).toMatch(/paste/i);
    expect(r.out).toMatch(/does not load/);
    expect(r.out).toContain(`Signed in to ${SITE} as Ada Lovelace`);
    expect(fake.authorizeCalls[0].redirect_uri).toBe('http://localhost:8765/callback');
    expect(readToken(SITE, { env: { HOME: home } })).toMatchObject({ cloudId: 'cloud-acme-1', site: SITE });
    assertNoSecrets();
  });

  it('takes the address with spaces or quotes around it, and uses --port in the callback', async () => {
    const r = await run(['login', '--paste', '--port', '9911'], pasting(null, (u) => `  "${u}"  \n`));
    expect(r.code).toBe(0);
    expect(fake.authorizeCalls[0].redirect_uri).toBe('http://localhost:9911/callback');
  });

  it('refuses a pasted address whose state does not match, and saves nothing', async () => {
    const r = await run(['login', '--paste'], pasting((cb) => cb.searchParams.set('state', 'forged')));
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/state did not match/);
    expect(fake.tokenCalls).toBe(0);
    expect(readToken(SITE, { env: { HOME: home } })).toBeNull();
  });

  it('reports an error the user chose, and an address that is not the callback', async () => {
    let r = await run(['login', '--paste'], pasting((cb) => { cb.searchParams.delete('code'); cb.searchParams.set('error', 'access_denied'); }));
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/access_denied/);
    r = await run(['login', '--paste'], { readLine: async () => 'not an address' });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/whole address/);
    r = await run(['login', '--paste'], { readLine: async () => 'https://example.com/other?code=x&state=y' });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/callback/);
    expect(fake.tokenCalls).toBe(0);
  });

  it('fails when nothing is pasted', async () => {
    const r = await run(['login', '--paste'], { readLine: async () => { throw new Error('No address was pasted.'); } });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/No address was pasted/);
  });

  it('does not combine with --no-open', async () => {
    expect((await run(['login', '--paste', '--no-open'])).code).toBe(64);
  });
});

function signIn() {
  const { accessToken, refreshToken } = fake.issueTokens();
  writeToken(SITE, {
    cloudId: 'cloud-acme-1', site: SITE, accessToken, refreshToken,
    expiresAt: '2026-10-17T13:00:00.000Z',
    account: { accountId: fake.account.accountId, displayName: 'Ada Lovelace' },
  }, { env: { HOME: home } });
}

describe('foreman jira status', () => {
  it('prints the site, the account and the token expiry', async () => {
    signIn();
    const r = await run(['status']);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Site: ${SITE}`);
    expect(r.out).toContain('Account: Ada Lovelace');
    expect(r.out).toContain('2026-10-17T13:00:00.000Z');
    expect(r.out).not.toMatch(/JQL/);
    assertNoSecrets();
  });

  it('checks the JQL when stories.jql is set, with the count', async () => {
    writeConfig({ adapter: 'jira', site: SITE, jql: 'project = ACME' });
    signIn();
    const r = await run(['status']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('JQL: runs (about 3 issues)');
  });

  it('reports a JQL that fails, with Jira\'s message', async () => {
    writeConfig({ adapter: 'jira', site: SITE, jql: 'INVALID' });
    signIn();
    const r = await run(['status']);
    expect(r.code).toBe(1);
    expect(r.out + r.err).toContain("Error in the JQL Query: 'INVALID'");
    assertNoSecrets();
  });

  it('says to sign in when there is no token file', async () => {
    const r = await run(['status']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('foreman jira login');
  });

  it('says the sign-in expired when the refresh token is no longer valid', async () => {
    writeConfig({ adapter: 'jira', site: SITE, jql: 'project = ACME' });
    signIn();
    const env = { HOME: home };
    writeToken(SITE, { ...readToken(SITE, { env }), refreshToken: 'rt-old', expiresAt: '2026-10-17T11:00:00.000Z' }, { env });
    const r = await run(['status']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('Jira sign-in expired; run `foreman jira login`');
  });
});

describe('foreman jira logout', () => {
  it('deletes the token file', async () => {
    signIn();
    const r = await run(['logout']);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Signed out of ${SITE}`);
    expect(readToken(SITE, { env: { HOME: home } })).toBeNull();
  });

  it('is fine when not signed in', async () => {
    const r = await run(['logout']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Not signed in');
  });
});

describe('foreman jira', () => {
  it('without a known subcommand prints its usage and exits 64', async () => {
    const r = await run(['nope']);
    expect(r.code).toBe(64);
    expect(r.err).toMatch(/login.*status.*logout/s);
  });

  it('is registered with the foreman command line', async () => {
    let out = '';
    await main(['--help'], { cwd: dir, env: { FOREMAN_PROJECT_DIR: dir }, stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } });
    expect(out).toMatch(/^jira\s/m);
  });
});
