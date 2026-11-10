// The supervisor's Salesforce refresher and its worker: the supervisor reads only the poll cache,
// and this does the sf calls in a child process, on its own timer.

import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { ACME_QA_ID } from '../../../../test/fake-sf.mjs';
import { fakeCasesOrg } from '../../../../test/fake-sf-cases.mjs';
import { create } from './salesforce.mjs';
import { MIN_POLL_SECONDS, SF_EXPIRED_MESSAGE, STALE_POLLS, runWorker, salesforceRefresher } from './salesforce-refresher.mjs';
import { runJob } from './salesforce-worker.mjs';

const WORKER = fileURLToPath(new URL('./salesforce-worker.mjs', import.meta.url));
const T0 = new Date('2026-11-01T12:00:00Z');
const ORG = 'acme-qa';
const ORGS = { [ORG]: { orgId: ACME_QA_ID } };
const OPTIONS = { adapter: 'salesforce', org: ORG, where: "IsClosed = false AND Type = 'Foreman'", pollSeconds: 0, doneWhenField: 'Done_When__c' };
const FEATURES = { salesforceComments: true, salesforceStatuses: true };
const id = (n) => String(n).padStart(8, '0');
const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

const dirs = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

// A refresher whose run does the job in-process against a fake org, the way the worker would.
function setup({ override } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-sf-refresher-'));
  dirs.push(root);
  const stateDir = path.join(root, '.foreman');
  const org = fakeCasesOrg();
  org.addCase({ number: id(1), subject: 'Sign in', description: 'Build it.', fields: { Done_When__c: 'It works.' } });
  org.addCase({ number: id(2), subject: 'Sign out' });
  const t = { clock: T0, expired: [], jobs: [], fail: null };
  const now = () => t.clock;
  const run = async (job, extra = {}) => {
    t.jobs.push(job);
    if (override) {
      const answer = override(job, extra);
      if (answer) return answer;
    }
    if (t.fail) return { ok: false, error: t.fail };
    try {
      return { ok: true, value: await runJob({ job, root, options: OPTIONS, stateDir, env: {}, features: FEATURES, salesforceOrgs: ORGS, ...extra }, { sh: org.sh, now }) };
    } catch (err) {
      return { ok: false, error: { name: err.name, message: err.message, ...(err.code ? { code: err.code } : {}) } };
    }
  };
  const refresher = salesforceRefresher({
    stories: () => OPTIONS,
    stateDir,
    root,
    env: {},
    features: FEATURES,
    salesforceOrgs: ORGS,
    now,
    run,
    onLoginExpired: (err) => t.expired.push(err.message),
  });
  // The supervisor's view: a story source that reads only the cache.
  const source = (extra = {}) => create(OPTIONS, { root, stateDir, env: {}, now, sh: org.sh, salesforceOrgs: ORGS, features: FEATURES, cacheOnly: true, ...extra });
  return { root, stateDir, org, t, refresher, source };
}

describe('salesforce refresher: hold', () => {
  it('is quiet before the first answer and clear after a good refresh', async () => {
    const { refresher, stateDir, source } = setup();
    expect(refresher.hold()).toEqual({ quiet: true, reason: 'waiting for the first answer from Salesforce' });
    await refresher.refresh();
    expect(refresher.hold()).toBeNull();
    expect(fs.existsSync(path.join(stateDir, 'salesforce', 'list.json'))).toBe(true);
    expect(source().list().map((s) => s.id)).toEqual([id(1), id(2)]);
  });

  it('says Salesforce is not reachable, since when and why, after a failed refresh', async () => {
    const { refresher, t } = setup();
    t.fail = { name: 'Error', message: 'timed out after 1 min.' };
    await refresher.refresh();
    expect(refresher.hold()).toEqual({ reason: `Salesforce not reachable since ${hhmm(T0)}: timed out after 1 min; picking paused, stories in progress carry on` });
  });

  it('keeps the first failure time while it keeps failing, and clears on a good refresh', async () => {
    const { refresher, t } = setup();
    t.fail = { name: 'Error', message: 'down' };
    await refresher.refresh();
    t.clock = new Date(+T0 + 600_000);
    await refresher.refresh();
    expect(refresher.hold().reason).toContain(`since ${hhmm(T0)}:`);
    t.fail = null;
    await refresher.refresh();
    expect(refresher.hold()).toBeNull();
  });

  it(`holds when the answer is older than ${STALE_POLLS} polls`, async () => {
    const { refresher, t } = setup();
    await refresher.refresh();
    t.clock = new Date(+T0 + STALE_POLLS * MIN_POLL_SECONDS * 1000);
    expect(refresher.hold()).toBeNull();
    t.clock = new Date(+T0 + STALE_POLLS * MIN_POLL_SECONDS * 1000 + 1);
    expect(refresher.hold()).toEqual({ reason: `Salesforce not reachable since ${hhmm(T0)}: no fresh answer; picking paused, stories in progress carry on` });
  });

  it('never polls faster than every 5 seconds', () => {
    expect(MIN_POLL_SECONDS).toBe(5);
    expect(STALE_POLLS).toBe(5);
  });
});

describe('salesforce refresher: sign-in', () => {
  it('runs onLoginExpired once for an auth error, and again only after a good refresh', async () => {
    const { refresher, t } = setup();
    t.fail = { name: 'SfAuthError', message: 'stopped at once', code: 'auth' };
    await refresher.refresh();
    await refresher.refresh();
    expect(t.expired).toHaveLength(1);
    t.fail = null;
    await refresher.refresh();
    t.fail = { name: 'SfAuthError', message: 'stopped at once', code: 'auth' };
    await refresher.refresh();
    expect(t.expired).toHaveLength(2);
  });

  it('does not run it for any other error', async () => {
    const { refresher, t } = setup();
    t.fail = { name: 'Error', message: 'down', code: 'timeout' };
    await refresher.refresh();
    expect(t.expired).toEqual([]);
  });

  it('says in words what a lapsed sign-in means', () => {
    expect(SF_EXPIRED_MESSAGE).toBe("Foreman's sign-in to the Salesforce org that holds the stories has lapsed: connect it again on Set up › Salesforce, then resume.");
  });

  it('survives an onLoginExpired that throws', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-sf-refresher-'));
    dirs.push(root);
    const refresher = salesforceRefresher({
      stories: () => OPTIONS,
      stateDir: path.join(root, '.foreman'),
      root,
      now: () => T0,
      run: async () => ({ ok: false, error: { name: 'SfAuthError', message: 'x', code: 'auth' } }),
      onLoginExpired: () => {
        throw new Error('notice failed');
      },
    });
    await expect(refresher.refresh()).resolves.toBeUndefined();
    expect(refresher.hold().reason).toContain('Salesforce not reachable');
  });
});

describe('salesforce refresher: briefs', () => {
  it('fetches a brief, writes it, and remembers that it tried', async () => {
    const { refresher, stateDir, t } = setup();
    expect(refresher.briefTried(id(1))).toBe(false);
    expect(await refresher.fetchBrief(id(1))).toBe(true);
    expect(refresher.briefTried(id(1))).toBe(true);
    expect(t.jobs).toEqual(['brief']);
    const text = fs.readFileSync(path.join(stateDir, 'stories', `${id(1)}.md`), 'utf8');
    expect(text).toContain('It works.');
  });

  it('shares one fetch between callers', async () => {
    const { refresher, t } = setup();
    const [a, b] = await Promise.all([refresher.fetchBrief(id(1)), refresher.fetchBrief(id(1))]);
    expect([a, b]).toEqual([true, true]);
    expect(t.jobs).toEqual(['brief']);
  });

  it('resolves false, never rejects, for a Case it does not list or a failed job, and still counts as tried', async () => {
    const { refresher, t } = setup();
    expect(await refresher.fetchBrief(id(9))).toBe(false);
    expect(refresher.briefTried(id(9))).toBe(true);
    t.fail = { name: 'Error', message: 'down' };
    expect(await refresher.fetchBrief(id(1))).toBe(false);
    expect(refresher.briefTried(id(1))).toBe(true);
  });

  it('survives a run that throws', async () => {
    const { refresher } = setup({ override: () => { throw new Error('boom'); } });
    expect(await refresher.fetchBrief(id(1))).toBe(false);
    await expect(refresher.refresh()).resolves.toBeUndefined();
    await expect(refresher.drain()).resolves.toBeUndefined();
  });
});

describe('salesforce refresher: the outbox', () => {
  it('runs the drain job only when the outbox has entries', async () => {
    const { refresher, t, source, org } = setup();
    await refresher.drain();
    expect(t.jobs).toEqual([]);

    await refresher.refresh();
    let queued = 0;
    const cached = source({ onQueued: () => (queued += 1) });
    expect(cached.update(id(1), { note: 'Started.', event: 'started' })).toBe(true);
    expect(queued).toBe(1);
    expect(org.comments(id(1))).toEqual([]);

    t.jobs.length = 0;
    await refresher.drain();
    expect(t.jobs).toEqual(['drain']);
    expect(org.comments(id(1))).toEqual([{ body: 'Foreman: Started.', published: false }]);

    t.jobs.length = 0;
    await refresher.drain();
    expect(t.jobs).toEqual([]);
  });

  it('sends the queue as part of a refresh', async () => {
    const { refresher, source, org } = setup();
    await refresher.refresh();
    source().update(id(2), { note: 'Blocked.', event: 'blocked' });
    await refresher.refresh();
    expect(org.comments(id(2))).toHaveLength(1);
  });
});

describe('salesforce worker: runJob', () => {
  const ctx = (extra = {}) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-sf-worker-'));
    dirs.push(root);
    const org = fakeCasesOrg();
    org.addCase({ number: id(1), subject: 'Sign in', description: 'Build it.' });
    return { org, input: { root, options: OPTIONS, stateDir: path.join(root, '.foreman'), env: {}, features: FEATURES, salesforceOrgs: ORGS, ...extra } };
  };

  it('refresh writes the cache and counts the Cases', async () => {
    const { org, input } = ctx();
    expect(await runJob({ ...input, job: 'refresh' }, { sh: org.sh })).toEqual({ count: 1 });
    expect(fs.existsSync(path.join(input.stateDir, 'salesforce', 'list.json'))).toBe(true);
  });

  it('brief writes the brief file and says so; an unknown Case writes none', async () => {
    const { org, input } = ctx();
    expect(await runJob({ ...input, job: 'brief', id: id(1) }, { sh: org.sh })).toEqual({ written: true });
    expect(fs.existsSync(path.join(input.stateDir, 'stories', `${id(1)}.md`))).toBe(true);
    expect(await runJob({ ...input, job: 'brief', id: id(9) }, { sh: org.sh })).toEqual({ written: false });
  });

  it('drain sends the queue', async () => {
    const { org, input } = ctx();
    await runJob({ ...input, job: 'refresh' }, { sh: org.sh });
    const cached = create(OPTIONS, { root: input.root, stateDir: input.stateDir, env: {}, sh: org.sh, salesforceOrgs: ORGS, features: FEATURES, cacheOnly: true });
    cached.update(id(1), { note: 'Started.', event: 'started' });
    await runJob({ ...input, job: 'drain' }, { sh: org.sh });
    expect(org.comments(id(1))).toHaveLength(1);
  });

  it('refuses an unknown job and options that fail their check', async () => {
    const { org, input } = ctx();
    await expect(runJob({ ...input, job: 'nonsense' }, { sh: org.sh })).rejects.toThrow(/unknown Salesforce job/);
    await expect(runJob({ ...input, job: 'refresh', options: { adapter: 'salesforce', org: ORG } }, { sh: org.sh })).rejects.toThrow('stories.where or stories.listView is required');
  });

  it('carries the sf error code of a failed refresh', async () => {
    const { org, input } = ctx();
    org.failNext('FROM Organization', { status: null, error: { code: 'ETIMEDOUT' }, stdout: '', stderr: '' });
    await expect(runJob({ ...input, job: 'refresh' }, { sh: org.sh })).rejects.toMatchObject({ code: 'timeout' });
  });
});

describe('salesforce worker: the process', () => {
  const talk = (input) => {
    const r = spawnSync(process.execPath, [WORKER], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8' });
    return JSON.parse(r.stdout);
  };
  const bad = { job: 'refresh', root: '/x', options: { adapter: 'salesforce', org: ORG }, stateDir: '/x/.foreman', env: {}, features: FEATURES, salesforceOrgs: ORGS };

  it('answers { ok: false, error } on stdout for options that fail their check', () => {
    expect(talk(bad)).toEqual({ ok: false, error: { name: 'Error', message: 'stories.where or stories.listView is required' } });
  });

  it('answers { ok: false, error } for input that is not JSON, and for an unknown job', () => {
    expect(talk('not json')).toMatchObject({ ok: false, error: { name: 'SyntaxError' } });
    expect(talk({ ...bad, job: 'nonsense', options: OPTIONS })).toMatchObject({ ok: false, error: { message: expect.stringContaining('unknown Salesforce job') } });
  });

  it('is what the refresher runs by default', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-sf-refresher-'));
    dirs.push(root);
    const refresher = salesforceRefresher({ stories: () => ({ adapter: 'salesforce', org: ORG }), stateDir: path.join(root, '.foreman'), root, env: {}, features: FEATURES, salesforceOrgs: ORGS, now: () => T0 });
    await refresher.refresh();
    expect(refresher.hold().reason).toContain('stories.where or stories.listView is required');
  });
});

describe('salesforce refresher: runWorker', () => {
  // A child that never answers, for the time limit.
  function silentChild() {
    const child = new EventEmitter();
    child.pid = 424242;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal) => {
      child.killed = signal;
    };
    return child;
  }

  it('gives up after its time limit, kills only that child, and resolves with a timeout error', async () => {
    const child = silentChild();
    const killed = [];
    const realKill = process.kill;
    process.kill = (...args) => {
      killed.push(args);
      return true;
    };
    try {
      const out = await runWorker({ job: 'refresh' }, { spawn: () => child, timeoutMs: 20 });
      expect(out).toMatchObject({ ok: false, error: { code: 'timeout' } });
      expect(out.error.message).toMatch(/did not answer/);
      expect(child.killed).toBe('SIGKILL');
      expect(killed).toEqual([]);
    } finally {
      process.kill = realKill;
    }
  });

  // The child answers `text` and closes, the way a real one does: its output first, then 'close'.
  const answer = (child, text) => {
    child.stdout.on('end', () => child.emit('close', 0));
    child.stdout.end(text);
  };

  it('sends the input on stdin, never as an argument', async () => {
    const child = silentChild();
    let args;
    let written = '';
    child.stdin.on('data', (d) => (written += d));
    const done = runWorker({ job: 'refresh', env: { SECRET: 'x' } }, { spawn: (...a) => ((args = a), child), timeoutMs: 60_000 });
    answer(child, JSON.stringify({ ok: true, value: { count: 3 } }));
    expect(await done).toEqual({ ok: true, value: { count: 3 } });
    expect(JSON.parse(written)).toEqual({ job: 'refresh', env: { SECRET: 'x' } });
    expect(JSON.stringify(args[1])).not.toContain('SECRET');
  });

  it('resolves with an error, never rejects, when the child gives no JSON or cannot start', async () => {
    const mute = silentChild();
    const first = runWorker({}, { spawn: () => mute, timeoutMs: 60_000 });
    answer(mute, 'garbage');
    expect(await first).toMatchObject({ ok: false, error: { message: expect.stringContaining('no answer') } });

    const broken = silentChild();
    const second = runWorker({}, { spawn: () => broken, timeoutMs: 60_000 });
    broken.emit('error', new Error('spawn ENOENT'));
    expect(await second).toMatchObject({ ok: false });

    expect(await runWorker({}, { spawn: () => { throw new Error('cannot'); }, timeoutMs: 60_000 })).toMatchObject({ ok: false });
  });
});
