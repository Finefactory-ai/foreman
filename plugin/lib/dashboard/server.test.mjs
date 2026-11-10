import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardServer, dashboardToken } from './server.mjs';
import { helpBody } from './help.mjs';
import { loadConfig } from '../config/load.mjs';
import { add } from '../console/decisions.mjs';
import { OPTIONS } from '../engine/answers.mjs';
import { addItem, readLedger, updateItem } from '../engine/learning-store.mjs';
import dashboardCommand from '../cli/commands/dashboard.mjs';
import { savePark } from '../engine/parks.mjs';
import { writeRun } from '../engine/run-record.mjs';
import { setLoop, setSlot } from '../engine/state.mjs';
import { openStorySource } from '../engine/story-source.mjs';
import { writeToken } from '../jira/auth.mjs';
import { startFakeJira } from '../../../test/fake-jira.mjs';
import { recording } from '../../../test/with-state-fixture.mjs';
import { RUN_SETUP } from '../setup/steps.mjs';

const TOKEN = 'sekret-token-0123456789abcdef';

let dir;
let state;
let servers;

function project(extra = {}) {
  writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'T' }, slots: 3, checks: [{ run: 'true', when: 'always' }], ...extra }));
  return loadConfig(dir).config;
}

async function start({ host = '127.0.0.1', env = {}, config = project(), ...more } = {}) {
  const cfg = { ...config, console: { ...config.console, host } };
  const server = createDashboardServer({ root: dir, config: cfg, stateDir: state, env, now: () => new Date('2026-10-15T09:00:00Z'), ...more });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, host, resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

const control = () => JSON.parse(readFileSync(join(state, 'control.json'), 'utf8'));
const post = (url, body, headers = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

// A request whose path goes out exactly as written (fetch would tidy the dots away).
function raw(base, path, { method = 'GET', headers = {}, body } = {}) {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function publishStatus(value) {
  mkdirSync(state, { recursive: true });
  const file = join(state, 'status.json');
  writeFileSync(`${file}.tmp`, JSON.stringify(value));
  renameSync(`${file}.tmp`, file);
}

// Reads server-sent events from a fetch response, one { event, data } at a time.
function events(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    async next(ms = 4000) {
      const deadline = Date.now() + ms;
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end !== -1) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const lines = block.split('\n');
          if (lines.every((l) => l.startsWith(':'))) continue;
          const event = lines.find((l) => l.startsWith('event: '))?.slice(7);
          const data = lines.filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
          return { event, data: JSON.parse(data) };
        }
        const left = deadline - Date.now();
        if (left <= 0) throw new Error('no event in time');
        const chunk = await Promise.race([reader.read(), new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), left))]);
        if (chunk.timeout) throw new Error('no event in time');
        if (chunk.done) throw new Error('stream ended');
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
    cancel: () => reader.cancel().catch(() => {}),
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foreman-dashboard-'));
  state = join(dir, '.foreman');
  servers = [];
});
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((resolve) => (s.listening ? s.close(() => resolve()) : resolve()))));
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/status', () => {
  it('serves the published snapshot as no-store JSON', async () => {
    const base = await start();
    publishStatus({ marker: 'published', loop: { state: 'running' }, control: { paused: false } });
    const res = await fetch(`${base}/api/status`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await res.json()).marker).toBe('published');
  });

  it('works out the snapshot when no run has published one, with the control state', async () => {
    const base = await start();
    await post(`${base}/api/control`, { action: 'pause' });
    const snap = await (await fetch(`${base}/api/status`)).json();
    expect(snap.marker).toBeUndefined();
    expect(snap).toHaveProperty('loop');
    expect(snap).toHaveProperty('slots');
    expect(snap.control.paused).toBe(true);
  });

  // A running agent whose command, words and plain-words line all carry a secret value: one from
  // .env.foreman, one from the environment, and a bare token no pattern list names by itself.
  const FILE_SECRET = 'acme-file-secret-123';
  const ENV_SECRET = 'acme-env-secret-456';
  const leaky = () => ({
    id: 'a1', role: 'foreman:builder', since: '2026-10-15T08:00:00.000Z', lastAt: '2026-10-15T08:59:00.000Z', tools: 2,
    raw: `curl -u u:${FILE_SECRET} https://acme.test\necho ${ENV_SECRET} ghp_${'A'.repeat(36)}`,
    says: `Send ${FILE_SECRET}`,
    doing: `$ curl -u u:${FILE_SECRET}`,
  });
  const agentOf = (snap) => snap.slots.flatMap((s) => s.agents).find((a) => a.id === 'a1');
  const expectClean = (agent, body) => {
    for (const v of [FILE_SECRET, ENV_SECRET, 'ghp_' + 'A'.repeat(36)]) expect(body).not.toContain(v);
    expect(body).toContain('•••');
    expect(agent.raw).toContain('\n');
    expect(agent.raw).toContain('curl -u u:•••');
    expect(agent.says).toBe('Send •••');
    expect(agent.doing).toBe('$ curl -u u:•••');
  };
  const withSecrets = () => writeFileSync(join(dir, '.env.foreman'), `ACME_KEY=${FILE_SECRET}\n`);

  it("redacts known secret values from each agent's command and words", async () => {
    withSecrets();
    publishStatus({ loop: { state: 'running' }, control: {}, slots: [{ id: 'w1', agents: [leaky()] }] });
    const base = await start({ env: { ACME_SERVICE_TOKEN: ENV_SECRET } });
    const res = await fetch(`${base}/api/status`);
    expectClean(agentOf(await res.clone().json()), await res.text());
  });

  it('redacts the snapshot worked out here, when no run has published one', async () => {
    withSecrets();
    mkdirSync(join(state, 'slots', 'w1', 'agents'), { recursive: true });
    writeFileSync(join(state, 'slots', 'w1', 'agents', 'a1.json'), JSON.stringify(leaky()));
    const base = await start({ env: { ACME_SERVICE_TOKEN: ENV_SECRET } });
    const res = await fetch(`${base}/api/status`);
    expectClean(agentOf(await res.clone().json()), await res.text());
  });

  it('redacts them for a remote viewer with the token too', async () => {
    withSecrets();
    publishStatus({ loop: { state: 'running' }, control: {}, slots: [{ id: 'w1', agents: [leaky()] }] });
    const base = await start({ host: '0.0.0.0', env: { FOREMAN_DASHBOARD_TOKEN: TOKEN, ACME_SERVICE_TOKEN: ENV_SECRET } });
    const res = await fetch(`${base}/api/status`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expectClean(agentOf(await res.clone().json()), await res.text());
  });

  it('leaves a snapshot without agents, and an agent without those words, alone', async () => {
    publishStatus({ marker: 'plain', control: {}, slots: [{ id: 'w1', agents: [{ id: 'a1', role: 'foreman' }, null, 'x'] }, null] });
    const base = await start();
    const snap = await (await fetch(`${base}/api/status`)).json();
    expect(snap.marker).toBe('plain');
    expect(snap.slots[0].agents[0]).toEqual({ id: 'a1', role: 'foreman' });
  });
});

describe('GET /api/events', () => {
  it("redacts known secret values from each agent's command and words", async () => {
    writeFileSync(join(dir, '.env.foreman'), 'ACME_KEY=acme-file-secret-123\n');
    publishStatus({
      control: {},
      slots: [{ id: 'w1', agents: [{ id: 'a1', raw: 'curl -u u:acme-file-secret-123 acme-env-secret-456', says: 'Send acme-file-secret-123', doing: '$ acme-env-secret-456' }] }],
    });
    const base = await start({ env: { ACME_SERVICE_TOKEN: 'acme-env-secret-456' } });
    const stream = events(await fetch(`${base}/api/events`));
    try {
      const first = await stream.next();
      expect(first.event).toBe('status');
      const a = first.data.slots[0].agents[0];
      expect(JSON.stringify(a)).not.toMatch(/acme-(file|env)-secret/);
      expect(a.raw).toBe('curl -u u:••• •••');
      expect(a.says).toBe('Send •••');
    } finally {
      stream.cancel();
    }
  });

  it('sends a snapshot on connect and another when status.json changes', async () => {
    const base = await start();
    publishStatus({ marker: 'one', control: {} });
    const res = await fetch(`${base}/api/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const stream = events(res);
    try {
      const first = await stream.next();
      expect(first).toMatchObject({ event: 'status', data: { marker: 'one' } });
      await new Promise((resolve) => setTimeout(resolve, 100));
      publishStatus({ marker: 'two', control: {} });
      let second = await stream.next();
      while (second.data.marker !== 'two') second = await stream.next();
      expect(second.event).toBe('status');
    } finally {
      stream.cancel();
    }
  });

  it('sends another when control.json changes', async () => {
    const base = await start();
    const stream = events(await fetch(`${base}/api/events`));
    try {
      expect((await stream.next()).data.control.paused).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await post(`${base}/api/control`, { action: 'pause' });
      let next = await stream.next();
      while (next.data.control.paused !== true) next = await stream.next();
    } finally {
      stream.cancel();
    }
  });
});

describe('POST /api/control', () => {
  it('pause writes control.json through the control module', async () => {
    const base = await start();
    const res = await post(`${base}/api/control`, { action: 'pause' });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(control().paused).toBe(true);
  });

  it('takes each owner action', async () => {
    const base = await start();
    for (const body of [
      { action: 'resume' },
      { action: 'workers', n: 2 },
      { action: 'slot', slot: 'w3', slotAction: 'park' },
      { action: 'fixed' },
      { action: 'handback', id: 'ABC-1' },
      { action: 'next', id: 'ABC-2' },
    ]) {
      const res = await post(`${base}/api/control`, body);
      expect(res.status, JSON.stringify(body)).toBe(200);
    }
    expect(control()).toMatchObject({ paused: false, workers: 2, slots: { w3: { action: 'park' } }, handBack: { id: 'ABC-1' }, nextStory: 'ABC-2' });
    expect(control().fixedAt).toBeTruthy();
    expect((await post(`${base}/api/control`, { action: 'stop' })).status).toBe(200);
    expect(existsSync(join(state, 'STOP'))).toBe(true);
  });

  it('stop records that the dashboard sent it, and /api/status says who', async () => {
    const base = await start();
    expect((await post(`${base}/api/control`, { action: 'stop' }, { 'user-agent': 'Mozilla/5.0 (Macintosh)' })).status).toBe(200);
    const rec = JSON.parse(readFileSync(join(state, 'STOP'), 'utf8'));
    expect(rec).toEqual({ at: '2026-10-15T09:00:00.000Z', via: 'dashboard', cwd: null, run: false, story: null, slot: null, agent: 'Mozilla/5.0 (Macintosh)' });
    const status = await (await fetch(`${base}/api/status`)).json();
    expect(status.control.stopRequested).toBe(true);
    expect(status.stoppedBy).toMatchObject({ via: 'dashboard', text: 'the dashboard at 09:00 UTC' });
  });

  it('/api/status reads who stopped the run fresh, even over a published status.json', async () => {
    const base = await start();
    publishStatus({ loop: { state: 'running' }, slots: [], stoppedBy: null });
    expect((await (await fetch(`${base}/api/status`)).json()).stoppedBy).toBeNull();
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'STOP'), `${JSON.stringify({ at: '2026-10-15T04:01:15.000Z', via: 'unknown', run: true, story: 'ACME-9' })}\n`);
    expect((await (await fetch(`${base}/api/status`)).json()).stoppedBy.text).toBe("ACME-9's session at 04:01 UTC");
  });

  it('refuses what the CLI refuses, with 400 and the reason', async () => {
    const base = await start();
    for (const body of [
      { action: 'slot', slot: 'w4', slotAction: 'park' },
      { action: 'slot', slot: 'w1', slotAction: 'explode' },
      { action: 'slot', slot: 'w1' },
      { action: 'workers', n: 4 },
      { action: 'workers', n: 0 },
      { action: 'workers', n: 1.5 },
      { action: 'workers', n: '2; rm' },
      { action: 'handback' },
      { action: 'next', id: '../etc' },
      { action: 'explode' },
      {},
      [],
    ]) {
      const res = await post(`${base}/api/control`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(typeof (await res.json()).error).toBe('string');
    }
    expect((await post(`${base}/api/control`, '{not json')).status).toBe(400);
    expect(existsSync(join(state, 'control.json'))).toBe(false);
  });

  it('refuses a body that is not JSON, so a page elsewhere cannot post a simple form', async () => {
    const base = await start();
    const res = await fetch(`${base}/api/control`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"action":"pause"}' });
    expect(res.status).toBe(415);
    expect(existsSync(join(state, 'control.json'))).toBe(false);
  });

  it('refuses a request from another origin', async () => {
    const base = await start();
    const res = await post(`${base}/api/control`, { action: 'pause' }, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(existsSync(join(state, 'control.json'))).toBe(false);
  });

  it('refuses a body over 64 KB with 413', async () => {
    const base = await start();
    const res = await post(`${base}/api/control`, { action: 'pause', pad: 'x'.repeat(70 * 1024) });
    expect(res.status).toBe(413);
    expect(existsSync(join(state, 'control.json'))).toBe(false);
  });
});

describe('decisions', () => {
  it('lists them and records an answer', async () => {
    const base = await start();
    const id = add(state, { story: 'ABC-1', kind: 'decision', title: 'Which?', options: ['yes', 'no'] });
    const items = await (await fetch(`${base}/api/decisions`)).json();
    expect(items.map((i) => i.id)).toEqual([id]);
    const res = await post(`${base}/api/decisions/${id}`, { option: 'yes', note: 'go' });
    expect(res.status).toBe(200);
    const saved = JSON.parse(readFileSync(join(state, 'decisions', `${id}.json`), 'utf8'));
    expect(saved.answer).toMatchObject({ option: 'yes', note: 'go' });
  });

  it('refuses an option not offered with 400', async () => {
    const base = await start();
    const id = add(state, { story: 'ABC-1', kind: 'decision', title: 'Which?', options: ['yes', 'no'] });
    const res = await post(`${base}/api/decisions/${id}`, { option: 'maybe' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not one of the options/);
    expect(JSON.parse(readFileSync(join(state, 'decisions', `${id}.json`), 'utf8')).answer).toBeNull();
  });

  it('refuses an unknown decision', async () => {
    const base = await start();
    expect((await post(`${base}/api/decisions/d-20261015090000-abcd`, { option: 'yes' })).status).toBe(400);
  });
});

describe('the page and other paths', () => {
  it('serves page.html at / with a strict content policy', async () => {
    const base = await start();
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(res.headers.get('content-security-policy')).toMatch(/default-src 'self'/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toBe(readFileSync(new URL('./page.html', import.meta.url), 'utf8'));
  });

  it('serves nothing but page.html or a 404, whatever the path', async () => {
    const base = await start();
    const page = readFileSync(new URL('./page.html', import.meta.url), 'utf8');
    writeFileSync(join(dir, 'secret.txt'), 'do-not-serve');
    for (const path of ['/../../etc/passwd', '/page.html/..', '/%2e%2e/', '/%2e%2e/%2e%2e/etc/passwd', '/page.html', '/secret.txt', '/../secret.txt', '/api/../secret.txt', '//etc/passwd', '/api/status/..', '/server.mjs', '/%2fetc%2fpasswd']) {
      const res = await raw(base, path);
      expect([200, 404], path).toContain(res.status);
      if (res.status === 200) expect(res.body, path).toBe(page);
      expect(res.body, path).not.toContain('do-not-serve');
      expect(res.body, path).not.toContain('root:');
    }
  });

  it('answers a wrong method with 405', async () => {
    const base = await start();
    expect((await fetch(`${base}/api/control`)).status).toBe(405);
    expect((await post(`${base}/api/status`, {})).status).toBe(405);
  });
});

describe('GET /api/tokens', () => {
  const row = (role, name, input, extra = {}) => ({ role, name, agent: null, model: 'claude-opus-5-5', input, output: 0, cacheRead: 0, cacheWrite: 0, turns: 1, round: null, ...extra });
  const seed = () => {
    // The clock is 2026-10-15T09:00Z; the run started at 08:00.
    writeRun(state, { story: 'S-1', slot: 'w1', result: 'shipped', costUsd: 4.5, startedAt: '2026-10-15T08:10:00Z', endedAt: '2026-10-15T08:50:00Z', agents: [row('builder', 'build', 2000), row('reviewer', 'security', 300, { round: 1 })] });
    writeRun(state, { story: 'S-2', slot: 'w1', result: 'shipped', costUsd: 1.5, startedAt: '2026-10-15T06:00:00Z', endedAt: '2026-10-15T07:00:00Z', agents: [row('builder', 'build', 1000)] });
    writeFileSync(join(state, 'learner.jsonl'), `${JSON.stringify({ at: '2026-10-15T08:30:00Z', key: 'f-1', model: 'haiku', costUsd: 0.2, verdict: 'none', error: null, tokens: { input: 40, output: 0, cacheRead: 0, cacheWrite: 0, turns: 1, models: ['haiku'] } })}\n`);
    writeFileSync(join(state, 'state.json'), JSON.stringify({ loop: { state: 'running' }, totals: { since: '2026-10-15T08:00:00Z' } }));
  };

  it('serves the token view from the state folder', async () => {
    seed();
    const base = await start();
    const res = await fetch(`${base}/api/tokens`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('$');
    expect(text).not.toContain('costUsd');
    const v = JSON.parse(text);
    const builder = v.roles.find((r) => r.who === 'builder');
    expect(builder.today.total).toBe(3000);
    // this run started at 08:00, so S-2 (ended 07:00) is not in it
    expect(builder.run.total).toBe(2000);
    expect(v.roles.find((r) => r.who === 'learner').run.total).toBe(40);
    expect(v.stories.map((s) => s.story)).toEqual(['S-1', 'S-2']);
    expect(v.empty).toBe(false);
  });

  it('passes the findings through to the quiet-reviewer hint', async () => {
    // Five stories in the 14 days before 2026-10-15T09:00Z, each with a security review of 30% of its tokens.
    for (let n = 1; n <= 5; n++) {
      writeRun(state, { story: `S-${n}`, slot: 'w1', result: 'shipped', costUsd: 1, startedAt: `2026-10-${String(8 + n).padStart(2, '0')}T08:00:00Z`, endedAt: `2026-10-${String(8 + n).padStart(2, '0')}T09:00:00Z`, agents: [row('builder', 'build', 700), row('reviewer', 'security', 300, { round: 1 })] });
    }
    const base = await start();
    const kinds = async () => (await (await fetch(`${base}/api/tokens`)).json()).hints.map((h) => h.kind);
    expect(await kinds()).toContain('quietReviewer');
    writeFileSync(join(state, 'findings.jsonl'), `${JSON.stringify({ at: '2026-10-14T08:00:00Z', story: 'S-2', stage: 'security', severity: 'minor', rule: 'r' })}\n`);
    expect(await kinds()).not.toContain('quietReviewer');
  });

  it('takes GET only', async () => {
    const base = await start();
    const res = await post(`${base}/api/tokens`, {});
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
  });

  it('answers an empty view with no records', async () => {
    const base = await start();
    expect(await (await fetch(`${base}/api/tokens`)).json()).toMatchObject({ roles: [], stories: [], empty: true });
  });

  it('is a 409 in set-up mode', async () => {
    seed();
    const server = createDashboardServer({ root: dir, config: null, stateDir: state, env: {}, now: () => new Date('2026-10-15T09:00:00Z') });
    servers.push(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/tokens`);
    expect(res.status).toBe(409);
  });
});

describe('GET /api/history', () => {
  // The clock is 2026-10-15T09:00Z.
  const seed = () => {
    writeRun(state, { story: 'S-1', slot: 'w1', result: 'shipped', costUsd: 4.5, minutes: 40, rounds: 1, stages: { architect: 5, build: 20, test: 5, review: 10 }, startedAt: '2026-10-14T08:00:00Z', endedAt: '2026-10-14T08:40:00Z', agents: [] });
    writeRun(state, { story: 'S-2', slot: 'w1', result: 'failed', costUsd: 1.5, minutes: 60, rounds: 3, startedAt: '2026-10-15T06:00:00Z', endedAt: '2026-10-15T07:00:00Z', agents: [] });
  };

  it('serves the run history per day and for the last 7 days', async () => {
    seed();
    const base = await start();
    const res = await fetch(`${base}/api/history`);
    expect(res.status).toBe(200);
    const v = await res.json();
    expect(v.days).toEqual([
      { day: '2026-10-14', shipped: 1, notShipped: 0, costUsd: 4.5 },
      { day: '2026-10-15', shipped: 0, notShipped: 1, costUsd: 1.5 },
    ]);
    expect(v.week).toMatchObject({ finished: 2, shipped: 1, costUsd: 6, medianMinutes: 40, firstTry: 1, stages: { architect: 5, build: 20, test: 5, review: 10 } });
    expect(v.total).toBe(2);
  });

  it('takes GET only', async () => {
    const base = await start();
    const res = await post(`${base}/api/history`, {});
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
  });

  it('answers an empty history with no records', async () => {
    const base = await start();
    expect(await (await fetch(`${base}/api/history`)).json()).toMatchObject({ since: null, total: 0, week: { finished: 0 } });
  });
});

describe('GET /api/help', () => {
  it('serves the help texts', async () => {
    const base = await start();
    const res = await fetch(`${base}/api/help`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await res.json()).toEqual(JSON.parse(JSON.stringify(helpBody())));
  });

  it('takes GET only', async () => {
    const base = await start();
    const res = await post(`${base}/api/help`, {});
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
  });

  it('on another host, needs the token', async () => {
    const base = await start({ host: '0.0.0.0', env: { FOREMAN_DASHBOARD_TOKEN: TOKEN } });
    expect((await raw(base, '/api/help')).status).toBe(401);
    expect((await raw(base, '/api/help', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    const res = await raw(base, '/api/help', { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    expect(res.body).not.toContain(TOKEN);
  });

  it('refuses a request from another origin', async () => {
    const base = await start();
    expect((await fetch(`${base}/api/help`, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
  });
});

const GUIDE_ROUTE = ['/api/help', 'guide'].join('/'); // the removed guide route, built from parts so a search for it finds no live reference

describe('the removed guide route', () => {
  it('is gone: 404 Not found', async () => {
    const base = await start();
    const res = await fetch(`${base}${GUIDE_ROUTE}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found.' });
  });
});

describe('the token', () => {
  it('needs none on 127.0.0.1', async () => {
    const base = await start({ env: { FOREMAN_DASHBOARD_TOKEN: TOKEN } });
    expect((await fetch(`${base}/api/status`)).status).toBe(200);
  });

  it('refuses to start on another host without a token', () => {
    const config = project();
    expect(() => createDashboardServer({ root: dir, config: { ...config, console: { ...config.console, host: '0.0.0.0' } }, stateDir: state, env: {} })).toThrow(/FOREMAN_DASHBOARD_TOKEN/);
  });

  it('on another host, checks the bearer token on every request', async () => {
    const base = await start({ host: '0.0.0.0', env: { FOREMAN_DASHBOARD_TOKEN: TOKEN } });
    const auth = { authorization: `Bearer ${TOKEN}` };
    for (const path of ['/', '/api/status', '/api/events', '/api/decisions', '/nothing']) {
      const res = await raw(base, path);
      expect(res.status, path).toBe(401);
      expect((await raw(base, path, { headers: { authorization: 'Bearer wrong' } })).status, path).toBe(401);
    }
    expect((await post(`${base}/api/control`, { action: 'pause' })).status).toBe(401);
    expect(existsSync(join(state, 'control.json'))).toBe(false);

    expect((await fetch(`${base}/`, { headers: auth })).status).toBe(200);
    expect((await fetch(`${base}/api/status`, { headers: auth })).status).toBe(200);
    expect((await fetch(`${base}/api/decisions`, { headers: auth })).status).toBe(200);
    expect((await post(`${base}/api/control`, { action: 'pause' }, auth)).status).toBe(200);
    const ev = await fetch(`${base}/api/events`, { headers: auth });
    expect(ev.status).toBe(200);
    await ev.body.cancel();
  });

  it('takes ?token= on a GET only', async () => {
    const base = await start({ host: '0.0.0.0', env: { FOREMAN_DASHBOARD_TOKEN: TOKEN } });
    const ev = await fetch(`${base}/api/events?token=${TOKEN}`);
    expect(ev.status).toBe(200);
    await ev.body.cancel();
    expect((await fetch(`${base}/api/status?token=${TOKEN}`)).status).toBe(200);
    expect((await post(`${base}/api/control?token=${TOKEN}`, { action: 'pause' })).status).toBe(401);
  });

  it('reads the token from the env file', async () => {
    writeFileSync(join(dir, '.env.local'), `OTHER=1\nFOREMAN_DASHBOARD_TOKEN=${TOKEN}\n`);
    const base = await start({ host: '0.0.0.0' });
    expect((await fetch(`${base}/api/status`)).status).toBe(401);
    expect((await fetch(`${base}/api/status`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
  });

  it("reads the token from Foreman's own keys file when the environment lacks it, over the env file", () => {
    const config = project();
    writeFileSync(join(dir, '.env.foreman'), `FOREMAN_DASHBOARD_TOKEN=${TOKEN}\n`);
    expect(dashboardToken({ root: dir, config, env: {} })).toBe(TOKEN);
    writeFileSync(join(dir, '.env.local'), 'FOREMAN_DASHBOARD_TOKEN=from-env-local\n');
    expect(dashboardToken({ root: dir, config, env: {} })).toBe(TOKEN);
    expect(dashboardToken({ root: dir, config, env: { FOREMAN_DASHBOARD_TOKEN: 'from-env' } })).toBe('from-env');
  });

  it('names .env.foreman when it will not start for want of a token', () => {
    const config = project();
    expect(() => createDashboardServer({ root: dir, config: { ...config, console: { ...config.console, host: '0.0.0.0' } }, stateDir: state, env: {} })).toThrow(/FOREMAN_DASHBOARD_TOKEN in the environment or in \.env\.foreman/);
  });

  it('never puts the token in a response', async () => {
    const base = await start({ host: '0.0.0.0', env: { FOREMAN_DASHBOARD_TOKEN: TOKEN } });
    const auth = { authorization: `Bearer ${TOKEN}` };
    const bodies = [];
    for (const path of ['/', '/api/status', '/api/decisions', '/nothing']) {
      const res = await raw(base, `${path}?token=${TOKEN}`, { headers: auth });
      bodies.push(res.body, JSON.stringify(res.headers));
      const bad = await raw(base, path, { headers: { authorization: 'Bearer nope' } });
      bodies.push(bad.body, JSON.stringify(bad.headers));
    }
    const res = await post(`${base}/api/control`, { action: TOKEN }, auth);
    bodies.push(await res.text());
    for (const b of bodies) expect(b).not.toContain(TOKEN);
  });
});

describe('foreman dashboard', () => {
  async function runCommand(args, env) {
    let out = '';
    let err = '';
    let stop;
    const until = new Promise((resolve) => { stop = resolve; });
    const done = dashboardCommand.run(args, {
      root: dir,
      env,
      stdout: { write: (s) => { out += s; } },
      stderr: { write: (s) => { err += s; } },
      until,
    });
    return { done, stop, out: () => out, err: () => err };
  }
  const waitFor = async (fn) => {
    for (let i = 0; i < 100 && !fn(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  };

  it('starts the server, prints the URL and closes when asked', async () => {
    project();
    const cmd = await runCommand(['--port', '0'], {});
    await waitFor(() => /http:\/\//.test(cmd.out()));
    const url = /http:\/\/\S+/.exec(cmd.out())[0];
    const snap = await (await fetch(`${url.replace(/\/$/, '')}/api/status`)).json();
    expect(snap).toHaveProperty('loop');
    cmd.stop();
    expect(await cmd.done).toBe(0);
  });

  it('never prints the token', async () => {
    project();
    const cmd = await runCommand(['--port', '0', '--host', '0.0.0.0'], { FOREMAN_DASHBOARD_TOKEN: TOKEN });
    await waitFor(() => /http:\/\//.test(cmd.out()));
    expect(cmd.out()).toMatch(/http:\/\//);
    cmd.stop();
    expect(await cmd.done).toBe(0);
    expect(cmd.out() + cmd.err()).not.toContain(TOKEN);
  });

  it('says to run foreman setup when the project has no config', async () => {
    const cmd = await runCommand([], {});
    expect(await cmd.done).toBe(1);
    expect(cmd.err()).toBe(`${RUN_SETUP}\n`);
    expect(cmd.err()).toContain('foreman setup');
  });

  it('refuses another host without a token, and a bad port', async () => {
    project();
    const a = await runCommand(['--port', '0', '--host', '0.0.0.0'], {});
    expect(await a.done).toBe(1);
    expect(a.err()).toMatch(/FOREMAN_DASHBOARD_TOKEN/);
    const b = await runCommand(['--port', 'abc'], {});
    expect(await b.done).not.toBe(0);
  });
});

describe('/api/waiting', () => {
  let watched;
  // start() with a release watch the test can count.
  async function serve({ host = '127.0.0.1', env = {}, clock = () => new Date('2026-10-15T09:00:00Z') } = {}) {
    const config = project();
    const cfg = { ...config, console: { ...config.console, host } };
    watched = 0;
    const releaseWatch = () => {
      watched += 1;
    };
    const server = createDashboardServer({ root: dir, config: cfg, stateDir: state, env, now: clock, releaseWatch });
    servers.push(server);
    await new Promise((resolve) => server.listen(0, host, resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  const storyFile = (id, title, extra = '', body = '') => {
    mkdirSync(join(dir, 'stories'), { recursive: true });
    writeFileSync(join(dir, 'stories', `${id}.md`), `---\nid: ${id}\ntitle: ${title}\nstatus: todo\n${extra}---\n\n${body}## Progress notes\n\n_Newest first._\n`);
  };
  const ownerTask = () => {
    storyFile('ABC-1', 'Add the key (owner task)');
    storyFile('ABC-2', 'Use the key', 'depends_on: [ABC-1]\n');
    storyFile('ABC-3', 'Show the key', 'depends_on: [ABC-2]\n');
  };
  const halt = () => {
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'HALT'), 'smoke failed on /health');
  };
  const waiting = async (base, headers = {}) => (await fetch(`${base}/api/waiting`, { headers })).json();
  const saved = (id) => JSON.parse(readFileSync(join(state, 'decisions', `${id}.json`), 'utf8'));
  const overlay = (id) => join(state, 'stories', `${id}.json`);

  describe('decisions', () => {
    it('lists a decision with its options and answers it with one', async () => {
      const base = await serve();
      const id = add(state, { story: 'ABC-1', kind: 'decision', title: 'Which?', options: ['yes', 'no'] });
      const item = (await waiting(base)).find((i) => i.id === id);
      expect(item).toMatchObject({ kind: 'decision', title: 'Which?', blocks: ['ABC-1'], actions: [{ id: 'option-0', label: 'yes' }, { id: 'option-1', label: 'no' }] });
      const res = await post(`${base}/api/waiting/${id}`, { action: 'option-1', note: 'later' });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, id, action: 'option-1' });
      expect(saved(id).answer).toMatchObject({ option: 'no', note: 'later' });
      expect((await waiting(base)).some((i) => i.id === id)).toBe(false);
    });

    it('answers a dependency note on FYI with Undo', async () => {
      storyFile('ABC-1', 'Sign in');
      storyFile('ABC-2', 'Sign out', 'depends_on: [ABC-1]\n');
      const base = await serve();
      const id = add(state, { story: 'ABC-2', kind: 'decision', title: 'ABC-2 now waits for ABC-1', summary: 'ABC-2 now waits for ABC-1: ABC-1 must land first', options: ['Undo', 'Keep'] });
      const item = (await waiting(base)).find((i) => i.id === id);
      expect(item).toMatchObject({ group: 'fyi', blocks: [], frees: [], actions: [{ id: 'option-0', label: 'Undo' }, { id: 'option-1', label: 'Keep' }] });
      const res = await post(`${base}/api/waiting/${id}`, { action: 'option-0' });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, id, action: 'option-0' });
      expect(saved(id).answer).toMatchObject({ option: 'Undo' });
    });

    it('a task with no options needs an answer in words', async () => {
      const base = await serve();
      const id = add(state, { story: 'ABC-1', kind: 'task', title: 'Add the key' });
      expect((await waiting(base)).find((i) => i.id === id).actions).toEqual([{ id: 'answer', label: 'Send answer' }]);
      const bad = await post(`${base}/api/waiting/${id}`, { action: 'answer' });
      expect(bad.status).toBe(400);
      expect(saved(id).answer).toBeNull();
      expect((await post(`${base}/api/waiting/${id}`, { action: 'answer', note: 'done it' })).status).toBe(200);
      expect(saved(id).answer).toMatchObject({ option: null, note: 'done it' });
    });
  });

  describe('owner tasks', () => {
    it('lists an open owner task with what it blocks, its file and Mark done', async () => {
      ownerTask();
      const base = await serve();
      expect(await waiting(base)).toEqual([
        { id: 'task:ABC-1', kind: 'owner-task', title: 'Add the key (owner task)', why: 'Frees ABC-2 now. 2 stories wait on it.', blocks: ['ABC-2', 'ABC-3'], frees: ['ABC-2'], link: 'stories/ABC-1.md', actions: [{ id: 'done', label: 'Mark done' }], group: 'now' },
      ]);
    });

    it('Mark done takes the foreman story done path', async () => {
      ownerTask();
      const base = await serve();
      const res = await post(`${base}/api/waiting/task:ABC-1`, { action: 'done' });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, id: 'task:ABC-1', action: 'done' });
      const stories = openStorySource({ root: dir, config: project(), env: {} }).list();
      expect(stories.find((s) => s.id === 'ABC-1').status).toBe('done');
      expect(JSON.parse(readFileSync(overlay('ABC-1'), 'utf8'))).toMatchObject({ status: 'done', fields: { completed: '2026-10-15' }, notes: [{ text: 'Marked done from the dashboard.' }] });
      expect((await waiting(base)).some((i) => i.id === 'task:ABC-1')).toBe(false);
    });

    it('takes the id percent-encoded, as encodeURIComponent sends it', async () => {
      ownerTask();
      const base = await serve();
      const res = await post(`${base}/api/waiting/task%3AABC-1`, { action: 'done' });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, id: 'task:ABC-1', action: 'done' });
      expect(openStorySource({ root: dir, config: project(), env: {} }).list().find((s) => s.id === 'ABC-1').status).toBe('done');
    });

    it('a malformed or unknown encoded id is a 404 that echoes nothing and changes nothing', async () => {
      ownerTask();
      const base = await serve();
      for (const path of ['/api/waiting/%E0%A4%A', '/api/waiting/task%3ANOPE-9']) {
        const res = await post(base + path, { action: 'done' });
        expect(res.status).toBe(404);
        const text = await res.text();
        expect(text).not.toContain('NOPE-9');
        expect(text).not.toContain('%E0');
      }
      expect(existsSync(overlay('ABC-1'))).toBe(false);
    });

    it('folds the note to one line of at most 500 characters', async () => {
      ownerTask();
      const base = await serve();
      expect((await post(`${base}/api/waiting/task:ABC-1`, { action: 'done', note: `first\nsecond ${'y'.repeat(600)}` })).status).toBe(200);
      const [note] = JSON.parse(readFileSync(overlay('ABC-1'), 'utf8')).notes;
      expect(note.text).not.toContain('\n');
      expect(note.text.startsWith('first second ')).toBe(true);
      expect(note.text).toHaveLength(500);
    });
  });

  describe('the halt', () => {
    it('comes first, with its reason and I fixed it, which takes the foreman fixed path', async () => {
      ownerTask();
      halt();
      const base = await serve();
      const list = await waiting(base);
      expect(list.map((i) => i.id)).toEqual(['halt', 'task:ABC-1']);
      expect(list[0].why).toContain('smoke failed');
      expect(list[0].actions).toEqual([{ id: 'fixed', label: 'I fixed it' }]);
      expect((await post(`${base}/api/waiting/halt`, { action: 'fixed' })).status).toBe(200);
      expect(control().fixedAt).toBeTruthy();
    });
  });

  describe('releases ready to promote', () => {
    it('lists a park with its reason, pull request and Check now, which starts foreman release watch', async () => {
      savePark(state, { id: 'ABC-4', step: 'promote', reason: 'waiting for the promotion to QA', check: {}, pr: 'https://github.com/acme/app/pull/4', parkedAt: '2026-10-15T08:00:00.000Z' });
      const base = await serve();
      const item = (await waiting(base)).find((i) => i.id === 'release:ABC-4');
      expect(item).toMatchObject({ kind: 'release', why: 'waiting for the promotion to QA', link: 'https://github.com/acme/app/pull/4', actions: [{ id: 'check', label: 'Check now' }] });
      const res = await post(`${base}/api/waiting/release:ABC-4`, { action: 'check' });
      expect(res.status).toBe(200);
      expect(watched).toBe(1);
    });

    it('starts at most one watch in 10 seconds', async () => {
      savePark(state, { id: 'ABC-4', step: 'promote', reason: 'waiting for the promotion to QA', check: {}, pr: null, parkedAt: '2026-10-15T08:00:00.000Z' });
      let t = new Date('2026-10-15T09:00:00Z').getTime();
      const base = await serve({ clock: () => new Date(t) });
      const check = () => post(`${base}/api/waiting/release:ABC-4`, { action: 'check' });
      expect((await check()).status).toBe(200);
      const again = await check();
      expect(again.status).toBe(200);
      expect(await again.json()).toMatchObject({ ok: true, message: expect.stringMatching(/moments ago/) });
      expect(watched).toBe(1);
      t += 11_000;
      expect((await check()).status).toBe(200);
      expect(watched).toBe(2);
    });
  });

  describe('slots', () => {
    it('lists a parked and a down slot with their actions, and takes one through the slot command', async () => {
      setSlot(state, 'w2', { state: 'parked', parkedFor: 'crash', reason: 'The session stopped twice.' });
      setSlot(state, 'w3', { state: 'down' });
      const base = await serve();
      const list = await waiting(base);
      expect(list.map((i) => i.id).sort()).toEqual(['slot:w2', 'slot:w3']);
      const w2 = list.find((i) => i.id === 'slot:w2');
      expect(w2.actions).toEqual([
        { id: 'resume', label: 'Resume' },
        { id: 'restart', label: 'Restart fresh from main' },
        { id: 'skip', label: 'Skip story' },
        { id: 'takeover', label: 'Take over' },
      ]);
      expect(list.find((i) => i.id === 'slot:w3').actions).toEqual([{ id: 'resume', label: 'Resume' }, { id: 'park', label: 'Park' }]);
      expect((await post(`${base}/api/waiting/slot:w2`, { action: 'restart' })).status).toBe(200);
      expect(control().slots.w2.action).toBe('restart');
    });
  });

  it('the status count is the length of the list, owner tasks included', async () => {
    ownerTask();
    add(state, { story: 'ABC-9', kind: 'task', title: 'Add the other key' });
    const base = await serve();
    const list = await waiting(base);
    const snap = await (await fetch(`${base}/api/status`)).json();
    expect(snap.waiting.count).toBe(list.length);
    expect(list.length).toBe(2);
    expect(snap.waiting.items.map((i) => i.id)).toContain('task:ABC-1');
  });

  it('refuses an unknown id, an action not offered, a body that is not JSON, another origin and a wrong method, changing nothing', async () => {
    ownerTask();
    halt();
    setSlot(state, 'w2', { state: 'parked', parkedFor: 'crash' });
    const id = add(state, { story: 'ABC-1', kind: 'decision', title: 'Which?', options: ['yes', 'no'] });
    const base = await serve();
    const story = readFileSync(join(dir, 'stories', 'ABC-1.md'), 'utf8');
    const unchanged = () => {
      expect(existsSync(join(state, 'control.json'))).toBe(false);
      expect(saved(id).answer).toBeNull();
      expect(existsSync(overlay('ABC-1'))).toBe(false);
      expect(readFileSync(join(dir, 'stories', 'ABC-1.md'), 'utf8')).toBe(story);
    };
    const missing = await post(`${base}/api/waiting/task:NOPE-9`, { action: 'done' });
    expect(missing.status).toBe(404);
    expect(await missing.text()).not.toContain('NOPE-9');
    unchanged();
    const discard = await post(`${base}/api/waiting/slot:w2`, { action: 'discard' });
    expect(discard.status).toBe(400);
    unchanged();
    const wrong = await post(`${base}/api/waiting/halt`, { action: 'done' });
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error).toMatch(/^Unknown action for halt; one of fixed/);
    unchanged();
    expect((await post(`${base}/api/waiting/${id}`, { action: 'option-7' })).status).toBe(400);
    unchanged();
    const plain = await fetch(`${base}/api/waiting/halt`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"action":"fixed"}' });
    expect(plain.status).toBe(415);
    unchanged();
    expect((await post(`${base}/api/waiting/halt`, { action: 'fixed' }, { origin: 'https://evil.example' })).status).toBe(403);
    unchanged();
    const list = await post(`${base}/api/waiting`, { action: 'fixed' });
    expect(list.status).toBe(405);
    expect(list.headers.get('allow')).toBe('GET');
    const get = await fetch(`${base}/api/waiting/halt`);
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    unchanged();
  });

  it('an FYI item takes no action: run:jira is refused and reaches nothing', async () => {
    ownerTask();
    const clock = new Date('2026-10-15T09:00:00Z');
    const since = new Date(clock.getTime() - 10 * 60000);
    const hhmm = `${String(since.getHours()).padStart(2, '0')}:${String(since.getMinutes()).padStart(2, '0')}`;
    setLoop(state, 'paused', `Jira not reachable since ${hhmm}: fetch failed; picking paused, stories in progress carry on`, since);
    const base = await serve({ clock: () => clock });
    expect((await waiting(base)).find((i) => i.id === 'run:jira')).toMatchObject({ kind: 'run', group: 'fyi', actions: [] });
    const control = join(state, 'control.json');
    const story = readFileSync(join(dir, 'stories', 'ABC-1.md'), 'utf8');
    const res = await post(`${base}/api/waiting/run:jira`, { action: 'done' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/^Unknown action for run:jira/);
    expect(existsSync(control)).toBe(false);
    expect(existsSync(overlay('ABC-1'))).toBe(false);
    expect(readFileSync(join(dir, 'stories', 'ABC-1.md'), 'utf8')).toBe(story);
    expect(watched).toBe(0);
  });

  it('a restart pending on new code is an FYI item with no actions, refused, and gone once cleared', async () => {
    ownerTask();
    const since = new Date('2026-10-15T08:50:00Z');
    setLoop(state, 'running', '', since);
    setSlot(state, 'w1', { state: 'building', story: { id: 'ABC-2', title: 'Use the key', stage: 'build' } }, since);
    const file = join(state, 'state.json');
    const pending = (value) => writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), restartPending: value }));
    pending({ from: 'a1b2c3d', to: 'e4f5a6b', since: since.toISOString() });
    const base = await serve();
    expect((await waiting(base)).find((i) => i.id === 'run:restart')).toMatchObject({
      kind: 'run',
      group: 'fyi',
      actions: [],
      title: 'Restarting on new code',
      why: 'New code (a1b2c3d → e4f5a6b): restarting as soon as the slots being set up are ready; the stories in progress keep running.',
    });
    const res = await post(`${base}/api/waiting/run:restart`, { action: 'done' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/^Unknown action for run:restart/);
    expect(existsSync(join(state, 'control.json'))).toBe(false);
    pending(null);
    expect((await waiting(base)).some((i) => i.id === 'run:restart')).toBe(false);
  });

  describe('a self-pause', () => {
    const PAUSED_AT = '2026-10-15T08:00:00.000Z';
    const REASON = 'Three stories in a row did not ship: ACME-1, ACME-2 and ACME-3.';
    const selfPause = () => {
      mkdirSync(state, { recursive: true });
      writeFileSync(join(state, 'state.json'), JSON.stringify({ autoPausedAt: PAUSED_AT, autoPauseReason: REASON }));
    };

    it('Resume on the self-pause item clears it', async () => {
      selfPause();
      const base = await serve();
      expect((await waiting(base)).find((i) => i.id === 'run:paused')).toMatchObject({ kind: 'run', why: REASON, actions: [{ id: 'resume', label: 'Resume' }] });
      const res = await post(`${base}/api/waiting/run:paused`, { action: 'resume' });
      expect(res.status).toBe(200);
      expect((await res.json()).message).toBe('Resumed.');
      const control = JSON.parse(readFileSync(join(state, 'control.json'), 'utf8'));
      expect(control.paused).toBe(false);
      expect(control.resumeAt > PAUSED_AT).toBe(true);
      expect((await waiting(base)).map((i) => i.id)).not.toContain('run:paused');
    });

    it('refuses an action the item does not offer and writes nothing', async () => {
      selfPause();
      const base = await serve();
      const res = await post(`${base}/api/waiting/run:paused`, { action: 'fixed' });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/^Unknown action for run:paused/);
      expect(existsSync(join(state, 'control.json'))).toBe(false);
    });
  });

  describe('an answer that could not be applied', () => {
    const ID = 'd-20261101090000-abcd';
    const failure = { id: ID, story: 'ACME-1', title: 'ACME-1: which store?', step: 'putting ACME-1 back to todo', tries: 1, at: '2026-11-01T09:00:00.000Z', retryAt: '2026-11-01T09:01:00.000Z' };
    const failed = () => {
      mkdirSync(state, { recursive: true });
      writeFileSync(join(state, 'state.json'), JSON.stringify({ answerFailures: [failure] }));
    };

    it('Retry writes answerRetry to control.json', async () => {
      failed();
      const base = await serve();
      expect((await waiting(base)).find((i) => i.id === `run:answer:${ID}`)).toMatchObject({ kind: 'run', group: 'now', actions: [{ id: 'retry', label: 'Retry' }] });
      const res = await post(`${base}/api/waiting/${encodeURIComponent(`run:answer:${ID}`)}`, { action: 'retry' });
      expect(res.status).toBe(200);
      expect((await res.json()).message).toBe('Retrying that answer at the next check.');
      const control = JSON.parse(readFileSync(join(state, 'control.json'), 'utf8'));
      expect(control.answerRetry.id).toBe(ID);
      expect(Number.isNaN(Date.parse(control.answerRetry.at))).toBe(false);
    });

    it('refuses any other action and writes nothing', async () => {
      failed();
      const base = await serve();
      for (const action of ['resume', 'done', 'end']) {
        const res = await post(`${base}/api/waiting/run:answer:${ID}`, { action });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/^Unknown action for run:answer:/);
      }
      expect(existsSync(join(state, 'control.json'))).toBe(false);
    });
  });

  it('on another host, needs the bearer token and never echoes it', async () => {
    ownerTask();
    halt();
    const base = await serve({ host: '0.0.0.0', env: { FOREMAN_DASHBOARD_TOKEN: TOKEN } });
    const auth = { authorization: `Bearer ${TOKEN}` };
    expect((await raw(base, '/api/waiting')).status).toBe(401);
    expect((await raw(base, '/api/waiting', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await post(`${base}/api/waiting/halt`, { action: 'fixed' })).status).toBe(401);
    expect(existsSync(join(state, 'control.json'))).toBe(false);
    expect((await post(`${base}/api/waiting/halt?token=${TOKEN}`, { action: 'fixed' })).status).toBe(401);
    expect(existsSync(join(state, 'control.json'))).toBe(false);
    expect((await post(`${base}/api/waiting/task%3AABC-1`, { action: 'done' })).status).toBe(401);
    expect(existsSync(overlay('ABC-1'))).toBe(false);
    const echo = await post(`${base}/api/waiting/halt`, { action: TOKEN }, auth);
    expect(echo.status).toBe(400);
    expect(await echo.text()).not.toContain(TOKEN);
    const res = await fetch(`${base}/api/waiting`, { headers: auth });
    expect(res.status).toBe(200);
    expect((await res.json()).map((i) => i.id)).toEqual(['halt', 'task:ABC-1']);
    expect((await post(`${base}/api/waiting/halt`, { action: 'fixed' }, auth)).status).toBe(200);
    expect(control().fixedAt).toBeTruthy();
  });

  describe('bundles', () => {
    const FOLLOW = ['Create a follow-up story', 'Ignore'];
    const at = (n) => new Date(`2026-10-15T08:00:0${n}Z`);
    const followUp = (n, options = FOLLOW) => add(state, { story: `ABC-${n}`, kind: 'decision', title: `Follow up on ABC-${n}: 2 minor finding(s)?`, options, summary: '2 minor: a; b' }, at(n));
    const bundlePost = (base, name, body, headers) => post(`${base}/api/waiting/bundle/${name}`, body, headers);

    it('Create all answers every follow-up, and the list then has none', async () => {
      const ids = [followUp(1), followUp(2), followUp(3)];
      const other = add(state, { story: 'ABC-9', kind: 'decision', title: 'Which?', options: ['yes', 'no'] }, at(4));
      const base = await serve();
      expect((await waiting(base)).filter((i) => i.bundle === 'follow-ups').map((i) => i.id).sort()).toEqual([...ids].sort());
      const res = await bundlePost(base, 'follow-ups', { action: 'create-all' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ ok: true, failed: [], message: 'Answered 3.' });
      expect([...body.answered].sort()).toEqual([...ids].sort());
      for (const id of ids) expect(saved(id).answer.option).toBe('Create a follow-up story');
      expect(saved(other).answer).toBeNull();
      const after = await waiting(base);
      expect(after.some((i) => i.bundle)).toBe(false);
      expect(after.map((i) => i.id)).toEqual([other]);
    });

    it('reports a follow-up it could not answer, still with 200', async () => {
      const good = followUp(1);
      const bad = followUp(2, ['Yes', 'No']);
      const base = await serve();
      const res = await bundlePost(base, 'follow-ups', { action: 'ignore-all' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ ok: true, answered: [good], message: 'Answered 1; 1 could not be answered.' });
      expect(body.failed).toEqual([{ id: bad, error: expect.stringContaining('is not one of the options') }]);
      expect(saved(good).answer.option).toBe('Ignore');
      expect(saved(bad).answer).toBeNull();
    });

    it('skips an item already answered', async () => {
      const done = followUp(1);
      const base = await serve();
      expect((await post(`${base}/api/waiting/${done}`, { action: 'option-1' })).status).toBe(200);
      const before = saved(done).answer;
      const fresh = followUp(2);
      const body = await (await bundlePost(base, 'follow-ups', { action: 'create-all' })).json();
      expect(body.answered).toEqual([fresh]);
      expect(saved(done).answer).toEqual(before);
      expect(before.option).toBe('Ignore');
    });

    it('refuses an unknown bundle or action with 400, echoing nothing and saving nothing', async () => {
      const ids = [followUp(1), followUp(2)];
      const base = await serve();
      const nothingSaved = () => {
        for (const id of ids) expect(saved(id).answer).toBeNull();
      };
      const nope = await bundlePost(base, 'nope', { action: 'create-all' });
      expect(nope.status).toBe(400);
      expect((await nope.json()).error).toBe('Unknown bundle; one of follow-ups, traits.');
      nothingSaved();
      const script = await bundlePost(base, encodeURIComponent('<script>alert(1)</script>'), { action: 'create-all' });
      expect(script.status).toBe(400);
      const text = await script.text();
      expect(text).not.toContain('<script>');
      expect(text).not.toContain('script');
      nothingSaved();
      const malformed = await raw(base, '/api/waiting/bundle/%E0%A4%A', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"action":"create-all"}' });
      expect(malformed.status).toBe(400);
      nothingSaved();
      const proto = await bundlePost(base, '__proto__', { action: 'create-all' });
      expect(proto.status).toBe(400);
      nothingSaved();
      const action = await bundlePost(base, 'follow-ups', { action: 'make-all' });
      expect(action.status).toBe(400);
      expect(await action.text()).not.toContain('make-all');
      nothingSaved();
      expect((await bundlePost(base, 'follow-ups', {})).status).toBe(400);
      nothingSaved();
    });

    it('refuses another origin, a body that is not JSON, a GET, and a request without the token', async () => {
      const id = followUp(1);
      const base = await serve();
      expect((await bundlePost(base, 'follow-ups', { action: 'create-all' }, { origin: 'https://evil.example' })).status).toBe(403);
      expect(saved(id).answer).toBeNull();
      const plain = await fetch(`${base}/api/waiting/bundle/follow-ups`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"action":"create-all"}' });
      expect(plain.status).toBe(415);
      expect(saved(id).answer).toBeNull();
      const get = await fetch(`${base}/api/waiting/bundle/follow-ups`);
      expect(get.status).toBe(405);
      expect(get.headers.get('allow')).toBe('POST');
      expect(saved(id).answer).toBeNull();

      const open = await serve({ host: '0.0.0.0', env: { FOREMAN_DASHBOARD_TOKEN: TOKEN } });
      expect((await bundlePost(open, 'follow-ups', { action: 'create-all' })).status).toBe(401);
      expect(saved(id).answer).toBeNull();
      const res = await bundlePost(open, 'follow-ups', { action: 'create-all' }, { authorization: `Bearer ${TOKEN}` });
      expect(res.status).toBe(200);
      expect(saved(id).answer.option).toBe('Create a follow-up story');
    });
  });

  describe('GET /api/waiting/<id>/details', () => {
    const TASK = [
      '## What you need',
      '',
      '- Admin access to the Acme org',
      '- The sandbox name',
      '',
      '## Steps',
      '',
      '1. Open Setup',
      '2. Create a sandbox',
      '3. Share the login',
      '',
      '## Takes',
      '',
      'about 15 minutes',
      '',
      '## Done when',
      '',
      'The sandbox shows in the list.',
      '',
      '',
    ].join('\n');
    const FULL = {
      need: ['Admin access to the Acme org', 'The sandbox name'],
      steps: ['Open Setup', 'Create a sandbox', 'Share the login'],
      effort: 'about 15 minutes',
      doneWhen: 'The sandbox shows in the list.',
    };
    const details = (base, id, headers = {}) => fetch(`${base}/api/waiting/${id}/details`, { headers });

    it('reads What you need, Steps, Takes and Done when from the owner task', async () => {
      storyFile('ABC-1', 'Add the key (owner task)', '', TASK);
      storyFile('ABC-2', 'Use the key', 'depends_on: [ABC-1]\n');
      const base = await serve();
      for (const id of ['task:ABC-1', 'task%3AABC-1']) {
        const res = await details(base, id);
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(await res.json()).toEqual(FULL);
      }
    });

    it('says missing when the task has none of the sections', async () => {
      ownerTask();
      const base = await serve();
      expect(await (await details(base, 'task:ABC-1')).json()).toEqual({ need: [], steps: [], effort: '', doneWhen: '', missing: true });
    });

    it('is a 404 that echoes nothing for an unknown id, a malformed one and an item that is not a task', async () => {
      ownerTask();
      halt();
      const base = await serve();
      for (const id of ['task:NOPE-9', '%E0%A4%A', 'halt']) {
        const res = await details(base, id);
        expect(res.status, id).toBe(404);
        const text = await res.text();
        expect(JSON.parse(text)).toEqual({ error: 'Nothing waiting on you has that id; reload the list.' });
        expect(text).not.toContain('NOPE-9');
        expect(text).not.toContain('%E0');
      }
    });

    it('reads only the first 256 KB of the brief', async () => {
      const filler = '## Notes\n\n' + 'x\n'.repeat(200_000);
      storyFile('ABC-1', 'Add the key (owner task)', '', TASK + filler);
      storyFile('ABC-2', 'Late steps (owner task)', '', filler + TASK);
      const base = await serve();
      expect(await (await details(base, 'task:ABC-1')).json()).toEqual(FULL);
      expect(await (await details(base, 'task:ABC-2')).json()).toEqual({ need: [], steps: [], effort: '', doneWhen: '', missing: true });
    });

    it('takes only GET', async () => {
      ownerTask();
      const base = await serve();
      const res = await post(`${base}/api/waiting/task:ABC-1/details`, {});
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('GET');
    });

    it('on another host, needs the bearer token', async () => {
      storyFile('ABC-1', 'Add the key (owner task)', '', TASK);
      const base = await serve({ host: '0.0.0.0', env: { FOREMAN_DASHBOARD_TOKEN: TOKEN } });
      expect((await raw(base, '/api/waiting/task:ABC-1/details')).status).toBe(401);
      const res = await details(base, 'task:ABC-1', { authorization: `Bearer ${TOKEN}` });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(FULL);
    });
  });
});

describe('learned items', () => {
  const ROLE = 'learned/traits/developer.md';
  const V1 = 'Acme: give every new route a test.';
  const V2 = 'Acme: give every new route and every error path a test.';
  const at = { now: new Date('2026-10-15T08:00:00Z') };
  const trait = (text = V1) => addItem(state, { kind: 'trait', roles: ['developer'], text, source: { key: 'untested-routes', stories: ['ABC-1', 'ABC-2'] }, reason: 'two stories shipped untested routes' }, at);
  const update = () => updateItem(state, 'L-1', { text: V2, reason: 'a third story missed the error path' }, at);
  const note = (title, options = OPTIONS.learned) => add(state, { story: 'ABC-2', kind: 'decision', title, options, hints: options.map((o) => `${o}.`) });
  const roleFile = () => (existsSync(join(state, ROLE)) ? readFileSync(join(state, ROLE), 'utf8') : null);
  const ledger = () => readLedger(state);
  const ledgerText = () => readFileSync(join(state, 'learning.jsonl'), 'utf8');
  const waiting = async (base, headers = {}) => (await fetch(`${base}/api/waiting`, { headers })).json();
  const saved = (id) => JSON.parse(readFileSync(join(state, 'decisions', `${id}.json`), 'utf8'));

  describe('on the FYI in /api/waiting', () => {
    it('Undo goes back one version at once, by the owner, and the note leaves the list', async () => {
      trait();
      update();
      const id = note('Foreman changed L-1 for developer');
      const base = await start();
      const item = (await waiting(base)).find((i) => i.id === id);
      expect(item).toMatchObject({ kind: 'learned', group: 'fyi', learned: { id: 'L-1', change: 'update' }, actions: [{ id: 'undo' }, { id: 'keep' }] });
      const res = await post(`${base}/api/waiting/${id}`, { action: 'undo' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, id, action: 'undo', message: 'Undid L-1: back to v1.' });
      expect(roleFile()).toBe(`[L-1] ${V1}\n`);
      expect(ledger().at(-1)).toMatchObject({ id: 'L-1', action: 'undo', by: 'owner', v: 1 });
      expect(saved(id)).toMatchObject({ answer: { option: 'Undo the change' }, appliedAt: '2026-10-15T09:00:00.000Z' });
      expect((await waiting(base)).some((i) => i.id === id)).toBe(false);
    });

    it('Keep writes a keep line and clears the note', async () => {
      trait();
      const id = note('Foreman learned L-1 for developer');
      const base = await start();
      const res = await post(`${base}/api/waiting/${id}`, { action: 'keep' });
      expect(res.status).toBe(200);
      expect((await res.json()).message).toBe('Kept L-1 at v1.');
      expect(ledger().at(-1)).toMatchObject({ id: 'L-1', action: 'keep', by: 'owner', v: 1 });
      expect(roleFile()).toBe(`[L-1] ${V1}\n`);
      expect(saved(id)).toMatchObject({ answer: { option: 'Keep the change' }, appliedAt: '2026-10-15T09:00:00.000Z' });
      expect((await waiting(base)).some((i) => i.id === id)).toBe(false);
    });

    it('Got it on a rollback note clears it and writes no ledger line', async () => {
      trait();
      const id = note('Foreman rolled back L-1 for developer', OPTIONS.rolledBack);
      const base = await start();
      expect((await waiting(base)).find((i) => i.id === id)).toMatchObject({ kind: 'learned', actions: [{ id: 'ok', label: 'Got it' }] });
      const before = ledgerText();
      const res = await post(`${base}/api/waiting/${id}`, { action: 'ok' });
      expect(res.status).toBe(200);
      expect((await res.json()).message).toBe('Note cleared.');
      expect(ledgerText()).toBe(before);
      expect(saved(id)).toMatchObject({ answer: { option: 'Got it' }, appliedAt: '2026-10-15T09:00:00.000Z' });
      expect((await waiting(base)).some((i) => i.id === id)).toBe(false);
    });

    it('refuses an option-N action, naming the ones it takes', async () => {
      trait();
      const id = note('Foreman learned L-1 for developer');
      const base = await start();
      const before = ledgerText();
      const res = await post(`${base}/api/waiting/${id}`, { action: 'option-0' });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(`Unknown action for ${id}; one of undo, keep`);
      expect(ledgerText()).toBe(before);
      expect(saved(id).answer).toBeNull();
    });

    it('a changed snapshot is a 409 with the store\'s words; the note stays and the file is unchanged', async () => {
      trait();
      update();
      const id = note('Foreman changed L-1 for developer');
      writeFileSync(join(state, 'learned/.history/L-1/v1.md'), 'something else');
      const base = await start();
      const res = await post(`${base}/api/waiting/${id}`, { action: 'undo' });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe('the snapshot of L-1 v1 is missing or changed; nothing was undone');
      expect(roleFile()).toBe(`[L-1] ${V2}\n`);
      expect(saved(id)).toMatchObject({ answer: null, appliedAt: null });
      expect((await waiting(base)).some((i) => i.id === id)).toBe(true);
    });

    it('Undo on a note whose item the ledger lost clears the note and writes no ledger', async () => {
      trait();
      const id = note('Foreman learned L-1 for developer');
      rmSync(join(state, 'learning.jsonl'));
      const base = await start();
      const res = await post(`${base}/api/waiting/${id}`, { action: 'undo' });
      expect(res.status).toBe(200);
      expect((await res.json()).message).toBe('L-1 is no longer in the learned list; the note is cleared.');
      expect((await waiting(base)).some((i) => i.id === id)).toBe(false);
      expect(existsSync(join(state, 'learning.jsonl'))).toBe(false);
      expect(roleFile()).toBe(`[L-1] ${V1}\n`);
    });
  });

  describe('/api/learned', () => {
    it('lists the rows, with no text and no path', async () => {
      trait();
      update();
      const base = await start();
      const res = await fetch(`${base}/api/learned`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ items: [{ id: 'L-1', kind: 'trait', roles: ['developer'], v: 2, status: 'on trial', reason: 'a third story missed the error path', by: 'foreman', at: '2026-10-15T08:00:00.000Z' }] });
      const text = JSON.stringify(body);
      for (const gone of ['Acme', 'learned/', 'snapshot', 'sha256']) expect(text).not.toContain(gone);
    });

    it('POST /api/learned/L-1 undo removes a one-version trait and clears its open note', async () => {
      trait();
      const id = note('Foreman learned L-1 for developer');
      const base = await start();
      const res = await post(`${base}/api/learned/L-1`, { action: 'undo' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, id: 'L-1', message: 'Undid L-1: removed.' });
      expect(roleFile()).toBeNull();
      expect(ledger().at(-1)).toMatchObject({ id: 'L-1', action: 'undo', by: 'owner', v: 0 });
      expect(saved(id)).toMatchObject({ answer: { option: 'Undo the change' }, appliedAt: '2026-10-15T09:00:00.000Z' });
      expect((await (await fetch(`${base}/api/learned`)).json()).items[0]).toMatchObject({ id: 'L-1', v: 0, status: 'undone', reason: 'Undone by you' });
    });

    it('takes undo only', async () => {
      trait();
      const base = await start();
      const before = ledgerText();
      for (const body of [{ action: 'keep' }, { action: 'ok' }, {}]) {
        const res = await post(`${base}/api/learned/L-1`, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
      expect(ledgerText()).toBe(before);
    });

    it('an unknown or malformed id is a 404 that echoes nothing and changes nothing', async () => {
      trait();
      const base = await start();
      const before = ledgerText();
      for (const path of ['/api/learned/L-99', '/api/learned/%E0%A4%A', '/api/learned/L-x', '/api/learned/..%2Fx']) {
        const res = await raw(base, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'undo' }) });
        expect(res.status, path).toBe(404);
        expect(JSON.parse(res.body).error).toBe('No learned item has that id; reload the list.');
        for (const echo of ['L-99', '%E0', 'L-x', '..']) expect(res.body, path).not.toContain(echo);
      }
      expect(ledgerText()).toBe(before);
      expect(roleFile()).toBe(`[L-1] ${V1}\n`);
    });

    it('checks the id before the action: a bad id is a 404 whatever the action, and echoes nothing', async () => {
      trait();
      const base = await start();
      const before = ledgerText();
      for (const path of ['/api/learned/L-99', '/api/learned/L-x']) {
        for (const body of [{ action: 'keep' }, { action: 'ok' }, {}, { action: 'undo' }]) {
          const res = await raw(base, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
          const what = `${path} ${JSON.stringify(body)}`;
          expect(res.status, what).toBe(404);
          expect(JSON.parse(res.body).error, what).toBe('No learned item has that id; reload the list.');
          for (const echo of ['L-99', 'L-x']) expect(res.body, what).not.toContain(echo);
        }
      }
      expect(ledgerText()).toBe(before);
    });

    it('runs no git for its owner changes on the files store, and adds no warning', async () => {
      trait();
      const d = add(state, { story: 'ABC-1', kind: 'decision', title: 'Which?', options: ['yes', 'no'] });
      const log = [];
      const cfg = { ...project(), console: { host: '127.0.0.1' } };
      const server = createDashboardServer({ root: dir, config: cfg, stateDir: state, env: {}, stateSh: recording(log), now: () => new Date('2026-10-15T09:00:00Z') });
      servers.push(server);
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      const bodies = [];
      for (const [path, body] of [[`/api/decisions/${d}`, { option: 'yes' }], ['/api/control', { action: 'pause' }], ['/api/learned/L-1', { action: 'undo' }]]) {
        const res = await post(`${base}${path}`, body);
        expect(res.status, path).toBe(200);
        bodies.push(await res.json());
      }
      expect(log).toEqual([]);
      for (const b of bodies) expect(b).not.toHaveProperty('warning');
      expect(bodies[2]).toEqual({ ok: true, id: 'L-1', message: 'Undid L-1: removed.' });
      expect(control().paused).toBe(true);
      expect(roleFile()).toBeNull();
    });

    it('answers a wrong method with 405', async () => {
      trait();
      const base = await start();
      const get = await fetch(`${base}/api/learned/L-1`);
      expect(get.status).toBe(405);
      expect(get.headers.get('allow')).toBe('POST');
      const list = await post(`${base}/api/learned`, { action: 'undo' });
      expect(list.status).toBe(405);
      expect(list.headers.get('allow')).toBe('GET');
      expect(roleFile()).toBe(`[L-1] ${V1}\n`);
    });

    it('refuses another origin and a body that is not JSON, changing nothing', async () => {
      trait();
      const id = note('Foreman learned L-1 for developer');
      const base = await start();
      const before = ledgerText();
      expect((await post(`${base}/api/learned/L-1`, { action: 'undo' }, { origin: 'https://evil.example' })).status).toBe(403);
      expect((await post(`${base}/api/waiting/${id}`, { action: 'undo' }, { origin: 'https://evil.example' })).status).toBe(403);
      expect((await fetch(`${base}/api/learned`, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
      const plain = await fetch(`${base}/api/learned/L-1`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"action":"undo"}' });
      expect(plain.status).toBe(415);
      expect(ledgerText()).toBe(before);
      expect(roleFile()).toBe(`[L-1] ${V1}\n`);
      expect(saved(id)).toMatchObject({ answer: null, appliedAt: null });
    });

    it('on another host, needs the bearer token', async () => {
      trait();
      const id = note('Foreman learned L-1 for developer');
      const base = await start({ host: '0.0.0.0', env: { FOREMAN_DASHBOARD_TOKEN: TOKEN } });
      const before = ledgerText();
      expect((await post(`${base}/api/learned/L-1`, { action: 'undo' })).status).toBe(401);
      expect((await post(`${base}/api/waiting/${id}`, { action: 'undo' })).status).toBe(401);
      expect((await fetch(`${base}/api/learned`)).status).toBe(401);
      expect(ledgerText()).toBe(before);
      expect(roleFile()).toBe(`[L-1] ${V1}\n`);
      expect(saved(id).appliedAt).toBeNull();
      const auth = { authorization: `Bearer ${TOKEN}` };
      expect((await fetch(`${base}/api/learned`, { headers: auth })).status).toBe(200);
      expect((await post(`${base}/api/learned/L-1`, { action: 'undo' }, auth)).status).toBe(200);
      expect(roleFile()).toBeNull();
    });

    it('is a 409 in set-up mode', async () => {
      trait();
      const server = createDashboardServer({ root: dir, config: null, stateDir: state, env: {}, now: () => new Date('2026-10-15T09:00:00Z') });
      servers.push(server);
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      expect((await fetch(`${base}/api/learned`)).status).toBe(409);
      expect((await post(`${base}/api/learned/L-1`, { action: 'undo' })).status).toBe(409);
      expect(roleFile()).toBe(`[L-1] ${V1}\n`);
    });
  });
});

describe('GET /api/waiting/<id>/details on a Jira project', () => {
  const SITE = 'acme.atlassian.net';
  const text = (t) => ({ type: 'text', text: t });
  const para = (t) => ({ type: 'paragraph', content: [text(t)] });
  const heading = (t) => ({ type: 'heading', attrs: { level: 2 }, content: [text(t)] });
  const items = (list) => list.map((t) => ({ type: 'listItem', content: [para(t)] }));
  const DESCRIPTION = {
    type: 'doc',
    version: 1,
    content: [
      heading('What you need'),
      { type: 'bulletList', content: items(['Admin access to the Acme org', 'The sandbox name']) },
      heading('Steps'),
      { type: 'orderedList', content: items(['Open Setup', 'Create a sandbox', 'Share the login']) },
      heading('Takes'),
      para('about 15 minutes'),
      heading('Done when'),
      para('The sandbox shows in the list.'),
    ],
  };
  const FULL = {
    need: ['Admin access to the Acme org', 'The sandbox name'],
    steps: ['Open Setup', 'Create a sandbox', 'Share the login'],
    effort: 'about 15 minutes',
    doneWhen: 'The sandbox shows in the list.',
  };
  let jira;
  let env;

  beforeAll(async () => {
    jira = await startFakeJira();
  });
  afterAll(async () => {
    await jira.close();
  });

  beforeEach(() => {
    jira.reset();
    jira.setDelay(0);
    env = { HOME: join(dir, 'home'), FOREMAN_JIRA_API_BASE: jira.url, FOREMAN_JIRA_AUTH_BASE: jira.url };
    writeToken(SITE, { cloudId: jira.cloudId, site: SITE, ...jira.tokens, expiresAt: '2999-01-01T00:00:00.000Z' }, { env });
    jira.addIssue({ key: 'ACME-1', summary: 'Make the sandbox', labels: ['foreman-owner'], description: DESCRIPTION });
    jira.addIssue({ key: 'ACME-2', summary: 'Buy the domain', labels: ['foreman-owner'], description: { type: 'doc', version: 1, content: [para('Buy acme.example.')] } });
    jira.addIssue({ key: 'ACME-3', summary: 'Use the sandbox' });
    jira.blocks('ACME-1', 'ACME-3');
  });

  async function serve(options = {}) {
    const config = project({ stories: { adapter: 'jira', site: SITE, jql: 'project = ACME ORDER BY rank', pollSeconds: 3600 } });
    const server = createDashboardServer({ root: dir, config, stateDir: state, env, now: () => new Date(), ...options });
    servers.push(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  const waiting = async (base) => (await fetch(`${base}/api/waiting`)).json();
  const details = async (base, id) => (await fetch(`${base}/api/waiting/${id}/details`)).json();
  const issueGets = async (key) => (await jira.requests()).filter((r) => r.method === 'GET' && r.path === `/rest/api/3/issue/${key}`).length;
  const briefFile = (key) => join(state, 'stories', `${key}.md`);

  it('the list never fetches a brief', async () => {
    const base = await serve();
    const before = (await jira.requests()).length;
    expect((await waiting(base)).map((i) => i.id)).toContain('task:ACME-1');
    const asked = (await jira.requests()).slice(before);
    expect(asked.some((r) => r.method === 'GET' && /^\/rest\/api\/3\/issue\/ACME-1(\/comment)?$/.test(r.path))).toBe(false);
    const briefs = existsSync(join(state, 'stories')) ? readdirSync(join(state, 'stories')).filter((f) => f.endsWith('.md')) : [];
    expect(briefs).toEqual([]);
  });

  it('fetches the brief for an owner task, reuses it for 10 minutes, then fetches again', async () => {
    const base = await serve();
    await waiting(base);
    const start = await issueGets('ACME-1');
    expect(await details(base, 'task:ACME-1')).toEqual(FULL);
    expect(await issueGets('ACME-1')).toBe(start + 1);
    expect(existsSync(briefFile('ACME-1'))).toBe(true);

    expect(await details(base, 'task:ACME-1')).toEqual(FULL);
    expect(await issueGets('ACME-1')).toBe(start + 1);

    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(briefFile('ACME-1'), old, old);
    expect(await details(base, 'task:ACME-1')).toEqual(FULL);
    expect(await issueGets('ACME-1')).toBe(start + 2);
  });

  it('says missing for an owner task with no steps written', async () => {
    const base = await serve();
    await waiting(base);
    expect(await details(base, 'task:ACME-2')).toEqual({ need: [], steps: [], effort: '', doneWhen: '', missing: true });
  });

  it('answers pending when Jira is slow, and the fetch carries on and writes the brief', async () => {
    const base = await serve({ briefWaitMs: 100 });
    await waiting(base);
    jira.setDelay(1500);
    const started = Date.now();
    expect(await details(base, 'task:ACME-1')).toEqual({ pending: true });
    expect(Date.now() - started).toBeLessThan(1000);
    jira.setDelay(0);
    let got = { pending: true };
    const deadline = Date.now() + 10_000;
    while (got.pending && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      got = await details(base, 'task:ACME-1');
    }
    expect(got).toEqual(FULL);
  }, 15_000);

  it('reads a fresh brief file without fetching', async () => {
    let calls = 0;
    const fetchBrief = () => {
      calls += 1;
      return new Promise(() => {});
    };
    const base = await serve({ fetchBrief });
    await waiting(base);
    mkdirSync(join(state, 'stories'), { recursive: true });
    writeFileSync(briefFile('ACME-1'), '# ACME-1 · Make the sandbox\n\n## What\n\n### Steps\n\n1. From the file\n\n## Done when\n\nIt is there.\n');
    expect(await details(base, 'task:ACME-1')).toEqual({ need: [], steps: ['From the file'], effort: '', doneWhen: 'It is there.' });
    expect(calls).toBe(0);
  });

  it('uses the old brief file when the fetch is slow', async () => {
    let calls = 0;
    const fetchBrief = () => {
      calls += 1;
      return new Promise(() => {});
    };
    const base = await serve({ fetchBrief, briefWaitMs: 100 });
    await waiting(base);
    mkdirSync(join(state, 'stories'), { recursive: true });
    writeFileSync(briefFile('ACME-1'), '# ACME-1 · Make the sandbox\n\n## What\n\n### Steps\n\n1. From the file\n\n## Done when\n\nIt is there.\n');
    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(briefFile('ACME-1'), old, old);
    expect(await details(base, 'task:ACME-1')).toEqual({ need: [], steps: ['From the file'], effort: '', doneWhen: 'It is there.' });
    expect(calls).toBe(1);
  });

  it('uses the old brief file when the fetch fails', async () => {
    const fetchBrief = () => Promise.reject(new Error('down'));
    const base = await serve({ fetchBrief });
    await waiting(base);
    mkdirSync(join(state, 'stories'), { recursive: true });
    writeFileSync(briefFile('ACME-1'), '# ACME-1 · Make the sandbox\n\n## What\n\n### Steps\n\n1. From the file\n\n## Done when\n\nIt is there.\n');
    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(briefFile('ACME-1'), old, old);
    expect(await details(base, 'task:ACME-1')).toEqual({ need: [], steps: ['From the file'], effort: '', doneWhen: 'It is there.' });
  });
});

describe('stray processes on /api/waiting', () => {
  // The dashboard with a stray finder and ender standing in for the real ones.
  async function serve(left = []) {
    const config = project();
    const found = { listed: true, strays: [{ pid: 1234, rssKb: 10240, where: 'temp' }], mb: 10 };
    const ends = [];
    const strays = {
      find: () => found,
      end: async (list) => {
        ends.push(list);
        return { ended: list.map((s) => s.pid).filter((p) => !left.includes(p)), left };
      },
    };
    setLoop(state, 'running', '', new Date('2026-10-15T08:50:00Z'));
    const file = join(state, 'state.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), strays: { pids: [process.pid], mb: 10, at: '2026-10-15T08:55:00.000Z' } }));
    const server = createDashboardServer({ root: dir, config, stateDir: state, env: {}, now: () => new Date('2026-10-15T09:00:00Z'), strays });
    servers.push(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { base: `http://127.0.0.1:${server.address().port}`, found, ends };
  }
  const waiting = async (base) => (await fetch(`${base}/api/waiting`)).json();

  it('lists them as an FYI item with End them', async () => {
    const { base } = await serve();
    expect((await waiting(base)).find((i) => i.id === 'run:strays')).toMatchObject({ kind: 'run', group: 'fyi', title: '1 stray process running', actions: [{ id: 'end', label: 'End them' }] });
  });

  it('End them ends the strays it finds now', async () => {
    const { base, found, ends } = await serve();
    const res = await post(`${base}/api/waiting/run:strays`, { action: 'end' });
    expect(res.status).toBe(200);
    expect((await res.json()).message).toBe('Ended 1 stray process.');
    expect(ends).toEqual([found.strays]);
  });

  it('says which are still running', async () => {
    const { base } = await serve([1234]);
    const res = await post(`${base}/api/waiting/run:strays`, { action: 'end' });
    expect(res.status).toBe(200);
    expect((await res.json()).message).toBe('Ended 0 stray processes. Still running: pid 1234.');
  });

  it('refuses any other action and ends nothing', async () => {
    const { base, ends } = await serve();
    const res = await post(`${base}/api/waiting/run:strays`, { action: 'resume' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Unknown action for run:strays; one of end');
    expect(ends).toEqual([]);
  });
});
