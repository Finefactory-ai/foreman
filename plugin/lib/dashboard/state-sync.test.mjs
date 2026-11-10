// The dashboard's owner changes on the branch state store: each is pulled first and pushed after
// as one commit with a fixed message (server.mjs changeState), against real repos and a local
// remote. With the files store, FOREMAN_STATE_SYNC=off or a team-layer setting, no git runs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, makeRepos, sh } from '../../../test/state-repos.mjs';
import { io, recording } from '../../../test/with-state-fixture.mjs';
import { createDashboardServer } from './server.mjs';
import { loadConfig } from '../config/load.mjs';
import { add } from '../console/decisions.mjs';
import { OPTIONS } from '../engine/answers.mjs';
import { addItem, readLedger } from '../engine/learning-store.mjs';
import { savePark } from '../engine/parks.mjs';
import { setLoop } from '../engine/state.mjs';
import { withState } from '../state-store/with-state.mjs';

// git heavy: give each test and hook room on a busy machine.
const SLOW_MS = 30_000;
vi.setConfig({ testTimeout: SLOW_MS, hookTimeout: SLOW_MS });

const ROLE = 'learned/traits/developer.md';
const UNREACHABLE = 'Could not get the state from the state branch, so nothing was changed. Try again; foreman status says why.';
const NOT_SENT = 'Saved on this machine, but it did not reach the state branch yet; the next change sends it.';
const now = () => new Date('2026-10-25T09:00:00Z');

let repos;
let a;
let state;
let servers;
let out;
let stderr;
let noteId;

beforeEach(async () => {
  repos = makeRepos({ version: 1, project: { name: 'Acme' }, state: { store: 'branch' } });
  a = repos.clone('a');
  state = join(a, '.foreman');
  servers = [];
  ({ out, stderr } = io());
  await withState({ root: a, env: {}, stderr, sh, sleep: async () => {} }, { write: false }, async () => 0);
  addItem(state, { kind: 'trait', roles: ['developer'], text: 'Acme: give every new route a test.', source: { key: 'untested-routes', stories: ['ACME-1', 'ACME-2'] }, reason: 'two stories shipped untested routes' }, { now: now() });
  noteId = add(state, { story: 'ACME-2', kind: 'decision', title: 'Foreman learned L-1 for developer', options: OPTIONS.learned, hints: OPTIONS.learned.map((o) => `${o}.`) }, now());
});
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((resolve) => (s.listening ? s.close(() => resolve()) : resolve()))));
  repos.cleanup();
});

async function start({ env = {}, stateSh = sh } = {}) {
  const server = createDashboardServer({ root: a, config: loadConfig(a).config, env, stateSh, stateSleep: async () => {}, stderr, now });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

const post = async (url, body) => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
};
const json = (r) => JSON.parse(r.text);
const localDecision = (id) => JSON.parse(readFileSync(join(state, 'decisions', `${id}.json`), 'utf8'));
const remoteDecision = (id) => JSON.parse(repos.remoteFile(`decisions/${id}.json`));
const remoteLedger = () => repos.remoteFile('learning.jsonl').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const subjects = (n) => git(repos.remote, 'log', `-${n}`, '--format=%s', 'foreman-state').split('\n');
const question = () => add(state, { story: 'ACME-3', kind: 'decision', title: 'Which table for Acme orders?', options: ['Reuse', 'New'] }, now());

describe('dashboard owner changes on the branch state store', () => {
  it('a learned Undo lands on the remote state branch as one commit', async () => {
    const base = await start();
    const r = await post(`${base}/api/learned/L-1`, { action: 'undo' });
    expect(r.status).toBe(200);
    expect(json(r)).toEqual({ ok: true, id: 'L-1', message: 'Undid L-1: removed.' });
    expect(remoteLedger().at(-1)).toMatchObject({ id: 'L-1', action: 'undo', by: 'owner', v: 0 });
    expect(repos.remoteFiles()).not.toContain(ROLE);
    expect(remoteDecision(noteId).appliedAt).toBe(now().toISOString());
    expect(subjects(1)).toEqual(['foreman dashboard learning undo']);
  });

  it('a decision answer and a pause each reach the remote as their own commit', async () => {
    const id = question();
    const base = await start();
    const answered = await post(`${base}/api/decisions/${id}`, { option: 'Reuse' });
    expect(answered.status).toBe(200);
    expect(json(answered)).not.toHaveProperty('warning');
    expect(subjects(1)).toEqual(['foreman dashboard decide answer']);
    const paused = await post(`${base}/api/control`, { action: 'pause' });
    expect(paused.status).toBe(200);
    expect(json(paused)).not.toHaveProperty('warning');
    expect(subjects(2)).toEqual(['foreman dashboard control', 'foreman dashboard decide answer']);
    expect(JSON.parse(repos.remoteFile('control.json')).paused).toBe(true);
    expect(remoteDecision(id).answer).toMatchObject({ option: 'Reuse' });
  });

  it('runs two answers sent at once one after the other, and both reach the remote', async () => {
    const first = question();
    const second = question();
    const base = await start();
    const [x, y] = await Promise.all([post(`${base}/api/decisions/${first}`, { option: 'Reuse' }), post(`${base}/api/decisions/${second}`, { option: 'New' })]);
    expect([x.status, y.status]).toEqual([200, 200]);
    expect(remoteDecision(first).answer).toMatchObject({ option: 'Reuse' });
    expect(remoteDecision(second).answer).toMatchObject({ option: 'New' });
    expect(subjects(2)).toEqual(['foreman dashboard decide answer', 'foreman dashboard decide answer']);
  });

  it('starts the second change only after the first has pushed, never waiting on the sync lock', async () => {
    // The first push is turned down once, so its retry waits (holding the sync lock); a change
    // let through meanwhile would poll that lock, a wait of 100 ms each time.
    let pushes = 0;
    const flaky = (cmd, args, opts) => (args.includes('push') && (pushes += 1) === 1 ? { status: 1, stdout: '', stderr: 'rejected' } : sh(cmd, args, opts));
    const waits = [];
    const server = createDashboardServer({ root: a, config: loadConfig(a).config, env: {}, stateSh: flaky, stateSleep: (ms) => { waits.push(ms); return new Promise((done) => setTimeout(done, 150)); }, stderr, now });
    servers.push(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const first = question();
    const second = question();
    const [x, y] = await Promise.all([post(`${base}/api/decisions/${first}`, { option: 'Reuse' }), post(`${base}/api/decisions/${second}`, { option: 'New' })]);
    expect([x.status, y.status]).toEqual([200, 200]);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThanOrEqual(200);
    expect(remoteDecision(first).answer).toMatchObject({ option: 'Reuse' });
    expect(remoteDecision(second).answer).toMatchObject({ option: 'New' });
  });

  // One change per test: each is a full pull and push against the remote, so three in one test
  // ran past the slow-test guard's limit on a busy machine.
  it('a local setting lands with its own message', async () => {
    const base = await start();
    expect((await post(`${base}/api/settings`, { name: 'roles.architect.model', value: 'opus', layer: 'local' })).status).toBe(200);
    expect(subjects(1)).toEqual(['foreman dashboard settings']);
    expect(JSON.parse(repos.remoteFile('settings.json'))).toEqual({ 'roles.architect.model': 'opus' });
  });

  it('a learned Keep from the waiting list lands with its own message', async () => {
    const base = await start();
    expect((await post(`${base}/api/waiting/${noteId}`, { action: 'keep' })).status).toBe(200);
    expect(subjects(1)).toEqual(['foreman dashboard waiting']);
    expect(remoteLedger().at(-1)).toMatchObject({ id: 'L-1', action: 'keep', by: 'owner' });
  });

  it('the Claude key switch lands with its own message', async () => {
    writeFileSync(join(state, 'claude-signin.json'), `${JSON.stringify({ using: 'subscription', since: now().toISOString(), reason: 'credits ran out' })}\n`);
    const base = await start({ env: { ANTHROPIC_API_KEY: 'acme-console-key' } });
    const switched = await post(`${base}/api/setup/claude/use-key`, {});
    expect(json(switched)).toMatchObject({ ok: true });
    expect(subjects(1)).toEqual(['foreman dashboard claude use-key']);
    expect(JSON.parse(repos.remoteFile('claude-signin.json')).using).toBe('key');
  });

  it('is a 503 that changes nothing when the state branch cannot be fetched, with the detail on stderr only', async () => {
    const offline = (cmd, args, opts) => (args.includes('fetch') || args.includes('ls-remote') ? { status: 128, stdout: '', stderr: 'fatal: could not read from remote https://acme.example/secret' } : sh(cmd, args, opts));
    const before = readFileSync(join(state, 'learning.jsonl'), 'utf8');
    const base = await start({ stateSh: offline });
    const r = await post(`${base}/api/learned/L-1`, { action: 'undo' });
    expect(r.status).toBe(503);
    expect(json(r).error).toBe(UNREACHABLE);
    for (const word of ['acme.example', 'could not read', 'origin', repos.remote]) expect(r.text).not.toContain(word);
    expect(readFileSync(join(state, 'learning.jsonl'), 'utf8')).toBe(before);
    expect(readLedger(state).some((l) => l.action === 'undo')).toBe(false);
    expect(existsSync(join(state, ROLE))).toBe(true);
    expect(localDecision(noteId)).toMatchObject({ answer: null, appliedAt: null });
    expect(out.stderr).toMatch(/acme\.example/);
  });

  it('keeps the change here and adds a warning when the push fails', async () => {
    const noPush = (cmd, args, opts) => (args.includes('push') ? { status: 1, stdout: '', stderr: 'rejected by https://acme.example/secret' } : sh(cmd, args, opts));
    const base = await start({ stateSh: noPush });
    const r = await post(`${base}/api/learned/L-1`, { action: 'undo' });
    expect(r.status).toBe(200);
    expect(json(r)).toEqual({ ok: true, id: 'L-1', message: 'Undid L-1: removed.', warning: NOT_SENT });
    expect(r.text).not.toContain('acme.example');
    expect(readLedger(state).at(-1)).toMatchObject({ id: 'L-1', action: 'undo', by: 'owner' });
    const remote = repos.remoteFiles().includes('learning.jsonl') ? remoteLedger() : [];
    expect(remote.some((l) => l.action === 'undo')).toBe(false);
  });

  it('runs no git with FOREMAN_STATE_SYNC=off, and still makes the change here', async () => {
    const log = [];
    const base = await start({ env: { FOREMAN_STATE_SYNC: 'off' }, stateSh: recording(log) });
    const r = await post(`${base}/api/learned/L-1`, { action: 'undo' });
    expect(r.status).toBe(200);
    expect(json(r)).toEqual({ ok: true, id: 'L-1', message: 'Undid L-1: removed.' });
    expect(log).toEqual([]);
    expect(existsSync(join(state, ROLE))).toBe(false);
    expect(readLedger(state).at(-1)).toMatchObject({ action: 'undo', by: 'owner' });
  });

  it('runs no state git for a release Check now, which syncs itself, or for ending the strays', async () => {
    savePark(state, { id: 'ACME-4', step: 'promote', reason: 'waiting for the promotion to QA', check: {}, pr: null, parkedAt: '2026-10-25T08:00:00.000Z' });
    setLoop(state, 'running', '', new Date('2026-10-25T08:50:00Z'));
    const file = join(state, 'state.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), strays: { pids: [process.pid], mb: 10, at: '2026-10-25T08:55:00.000Z' } }));
    const log = [];
    let watched = 0;
    const strays = { find: () => ({ listed: true, strays: [{ pid: 1234, rssKb: 10240, where: 'temp' }], mb: 10 }), end: async (list) => ({ ended: list.map((x) => x.pid), left: [] }) };
    const server = createDashboardServer({ root: a, config: loadConfig(a).config, env: {}, stateSh: recording(log), stateSleep: async () => {}, stderr, now, strays, releaseWatch: () => { watched += 1; } });
    servers.push(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const check = await post(`${base}/api/waiting/release:ACME-4`, { action: 'check' });
    expect(check.status).toBe(200);
    expect(watched).toBe(1);
    const ended = await post(`${base}/api/waiting/run:strays`, { action: 'end' });
    expect(ended.status).toBe(200);
    expect(json(ended).message).toBe('Ended 1 stray process.');
    expect(log).toEqual([]);
  });

  it('runs no state git for a team-layer setting, which edits foreman.config.json', async () => {
    const log = [];
    const base = await start({ stateSh: recording(log) });
    const r = await post(`${base}/api/settings`, { name: 'roles.architect.model', value: 'opus', layer: 'team' });
    expect(r.status).toBe(200);
    expect(json(r)).not.toHaveProperty('warning');
    expect(log).toEqual([]);
    expect(JSON.parse(readFileSync(join(a, 'foreman.config.json'), 'utf8')).roles.architect.model).toBe('opus');
  });
});
