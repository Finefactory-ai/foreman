// GET /api/agents/<id>/transcript and GET /api/slots/<slot>/transcript: a running (or just ended)
// agent's conversation, found only through the supervisor's session marks, redacted, and refused
// for anything that is not a plain id on a dashboard on this computer.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createDashboardServer } from './server.mjs';
import { markSession } from '../engine/session-files.mjs';

const TOKEN = 'acme-dashboard-token-0123456789abcdef';
const U = '4947378a-6485-4e40-9357-671b81c4acf3';
const U2 = '0a1b2c3d-0000-4000-8000-000000000001';
const SECRET = 'acme-file-secret-123';
const ANT = 'sk-ant-api03-ACMESECRETVALUE1';
const CONFIG = { version: 1, project: { name: 'Acme' }, slots: 2, checks: [{ run: 'true', when: 'always' }] };

let dir;
let state;
let projects;
let servers;

const line = (o) => JSON.stringify(o);
const asst = (content, model = 'claude-sonnet-5-5') => line({ type: 'assistant', timestamp: '2026-10-24T09:00:02.000Z', message: { model, content } });
const write = (file, text) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const agentFile = (session, id, wf = 'wf_1') => join(projects, '-tmp-acme', session, 'subagents', 'workflows', wf, `agent-${id}.jsonl`);

function transcript(extra = []) {
  return `${[
    line({ type: 'user', timestamp: '2026-10-24T09:00:01.000Z', message: { content: 'Build ACME-1' } }),
    line({ type: 'attachment' }),
    '{"type":"api-request-blob","x":"y"}',
    asst([{ type: 'text', text: 'Starting the build.' }]),
    asst([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } }]),
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
    ...extra,
  ].join('\n')}\n`;
}

function markW1(session = U) {
  const log = join(state, 'logs', 'w1.log');
  write(log, `${line({ type: 'system', subtype: 'init', session_id: session, model: 'claude-opus-5-5' })}\n`);
  markSession(state, 'w1', { story: 'ACME-1', pid: process.pid, log, projects });
}

const running = (id, role = 'foreman:builder') => write(join(state, 'slots', 'w1', 'agents', `${id}.json`), JSON.stringify({ id, role, since: '2026-10-24T09:00:00.000Z', lastAt: '2026-10-24T09:00:03.000Z', tools: 1 }));

async function start({ host = '127.0.0.1', env = {}, config = CONFIG } = {}) {
  const server = createDashboardServer({ root: dir, config: config ? { ...config, console: { host } } : null, stateDir: state, env, now: () => new Date('2026-10-24T09:00:00Z') });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, host, resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

// A request whose path goes out exactly as written.
function raw(base, path, { method = 'GET', headers = {} } = {}) {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end();
  });
}
const get = async (base, path) => {
  const r = await raw(base, path);
  return { ...r, json: r.body ? JSON.parse(r.body) : null };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foreman-transcript-api-'));
  state = join(dir, '.foreman');
  projects = join(dir, 'claude', 'projects');
  servers = [];
  write(join(dir, 'foreman.config.json'), JSON.stringify(CONFIG));
  write(agentFile(U, 'a1'), transcript());
  write(agentFile(U, 'a1').replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType: 'foreman:builder', description: 'build:ACME-1', model: 'sonnet' }));
  write(join(projects, '-tmp-acme', `${U}.jsonl`), transcript());
  markW1();
  running('a1');
});
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((resolve) => (s.listening ? s.close(() => resolve()) : resolve()))));
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/agents/<id>/transcript', () => {
  it('answers the entries of a running agent, with its role, label and model', async () => {
    const base = await start();
    const r = await get(base, '/api/agents/a1/transcript');
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.json).toMatchObject({ id: 'a1', slot: 'w1', role: 'foreman:builder', label: 'build:ACME-1', running: true, model: 'claude-sonnet-5-5', modelName: 'Sonnet 5.5', total: 4, first: 0 });
    expect(r.json.entries.map((e) => e.kind)).toEqual(['task', 'text', 'tool', 'result']);
    expect(r.json.entries[2]).toMatchObject({ says: 'Run the tests', raw: 'npm test', i: 2 });
    expect(r.json.entries.some((e) => e.report)).toBe(false);
  });

  it('gives only what is new after an index while the agent runs', async () => {
    const base = await start();
    const before = await get(base, '/api/agents/a1/transcript');
    appendFileSync(agentFile(U, 'a1'), `${asst([{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: join(dir, 'src', 'a.js') } }])}\n`);
    const last = before.json.entries.at(-1).i;
    const r = await get(base, `/api/agents/a1/transcript?after=${last}`);
    expect(r.status).toBe(200);
    expect(r.json.total).toBe(5);
    expect(r.json.entries).toHaveLength(1);
    expect(r.json.entries[0]).toMatchObject({ i: 4, kind: 'tool', says: 'Reading src/a.js' });
  });

  it('pages back with before', async () => {
    const base = await start();
    const r = await get(base, '/api/agents/a1/transcript?before=2');
    expect(r.json.entries.map((e) => e.i)).toEqual([0, 1]);
    expect(r.json.first).toBe(0);
  });

  it('stays readable after the agent ends, with the last text marked as its report', async () => {
    const base = await start();
    appendFileSync(agentFile(U, 'a1'), `${asst([{ type: 'text', text: 'All done: tests pass.' }])}\n`);
    rmSync(join(state, 'slots', 'w1', 'agents', 'a1.json'));
    const r = await get(base, '/api/agents/a1/transcript');
    expect(r.status).toBe(200);
    expect(r.json.running).toBe(false);
    expect(r.json.entries.at(-1)).toMatchObject({ kind: 'text', text: 'All done: tests pass.', report: true });
    expect(r.json.entries.filter((e) => e.report)).toHaveLength(1);
  });

  it('uses the running agent\'s role when the meta file is missing, and agent when neither', async () => {
    rmSync(agentFile(U, 'a1').replace(/\.jsonl$/, '.meta.json'));
    const base = await start();
    expect((await get(base, '/api/agents/a1/transcript')).json).toMatchObject({ role: 'foreman:builder', label: '' });
    rmSync(join(state, 'slots', 'w1', 'agents', 'a1.json'));
    expect((await get(base, '/api/agents/a1/transcript')).json).toMatchObject({ role: 'agent', label: '' });
  });

  it('is a 404 for an unknown id, in fixed words that do not repeat it', async () => {
    const base = await start();
    const r = await get(base, '/api/agents/a9/transcript');
    expect(r.status).toBe(404);
    expect(r.json.error).toBe('Foreman knows no agent with that id in a story running now.');
    expect(r.body).not.toContain('a9');
  });

  it('does not read an agent of a session that no slot has marked', async () => {
    write(agentFile(U2, 'z1'), transcript());
    const base = await start();
    expect((await get(base, '/api/agents/z1/transcript')).status).toBe(404);
  });

  it('does not read a transcript once the slot\'s mark is gone', async () => {
    const base = await start();
    rmSync(join(state, 'session-files'), { recursive: true });
    expect((await get(base, '/api/agents/a1/transcript')).status).toBe(404);
  });

  it('finds an agent in the second slot', async () => {
    const log = join(state, 'logs', 'w2.log');
    write(log, `${line({ type: 'system', subtype: 'init', session_id: U2 })}\n`);
    markSession(state, 'w2', { story: 'ACME-2', pid: process.pid, log, projects });
    write(agentFile(U2, 'z1'), transcript());
    const base = await start();
    expect((await get(base, '/api/agents/z1/transcript')).json).toMatchObject({ slot: 'w2', id: 'z1' });
  });

  it('is a 404 for an id that holds a path, without touching a file', async () => {
    const base = await start();
    for (const id of ['..%2F..%2Fetc', 'a1.jsonl', '%2e%2e', 'a%2Fb', '..', 'a%00b', 'a'.repeat(65)]) {
      const r = await raw(base, `/api/agents/${id}/transcript`);
      expect(r.status, id).toBe(404);
      expect(r.body, id).not.toContain(id);
      expect(JSON.parse(r.body).error).toBe('Foreman knows no agent with that id in a story running now.');
    }
  });

  it('keeps every secret out of the body', async () => {
    write(join(dir, '.env.foreman'), `ACME_KEY=${SECRET}\n`);
    appendFileSync(agentFile(U, 'a1'), `${asst([{ type: 'text', text: `Found ${ANT} and ${SECRET} in the log.` }])}\n`);
    appendFileSync(agentFile(U, 'a1'), `${asst([{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: `echo ${SECRET}`, description: `Echo ${SECRET}` } }])}\n`);
    const base = await start({ env: { ACME_SERVICE_TOKEN: 'acme-env-secret-456' } });
    appendFileSync(agentFile(U, 'a1'), `${asst([{ type: 'text', text: 'and acme-env-secret-456' }])}\n`);
    const r = await get(base, '/api/agents/a1/transcript');
    for (const v of [ANT, 'ACMESECRETVALUE1', SECRET, 'acme-env-secret-456']) expect(r.body).not.toContain(v);
    expect(r.body).toContain('•••');
  });

  it('keeps every secret out of the role and label', async () => {
    write(join(dir, '.env.foreman'), `ACME_KEY=${SECRET}\n`);
    write(agentFile(U, 'a1').replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType: `foreman:${SECRET}`, description: `build ${SECRET}` }));
    const base = await start();
    const r = await get(base, '/api/agents/a1/transcript');
    expect(r.status).toBe(200);
    expect(r.json.label).toBe('build •••');
    expect(r.json.role).toBe('foreman:•••');
    expect(r.body).not.toContain(SECRET);
  });

  it('parses the file again when the key files change', async () => {
    appendFileSync(agentFile(U, 'a1'), `${asst([{ type: 'text', text: `Found ${SECRET} here.` }])}\n`);
    const base = await start();
    expect((await get(base, '/api/agents/a1/transcript')).body).toContain(SECRET);
    write(join(dir, '.env.foreman'), `ACME_KEY=${SECRET}\n`);
    const r = await get(base, '/api/agents/a1/transcript');
    expect(r.body).not.toContain(SECRET);
    expect(r.body).toContain('•••');
  });
});

describe('GET /api/slots/<slot>/transcript', () => {
  it('answers the story session\'s own conversation as the foreman', async () => {
    const base = await start();
    const r = await get(base, '/api/slots/w1/transcript');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: 'w1', slot: 'w1', role: 'foreman', label: '', running: true, model: 'claude-sonnet-5-5', total: 4 });
  });

  it('is not running once the mark is gone, and then not found', async () => {
    const base = await start();
    rmSync(join(state, 'session-files'), { recursive: true });
    expect((await get(base, '/api/slots/w1/transcript')).status).toBe(404);
  });

  it('is a 404 for a slot beyond config.slots, w0, a path, or a slot with no mark', async () => {
    const base = await start();
    for (const slot of ['w3', 'w0', '..%2F', 'w2', 'w01', 'x1', 'w1.json', 'w9999999999']) {
      const r = await raw(base, `/api/slots/${slot}/transcript`);
      expect(r.status, slot).toBe(404);
      expect(r.body, slot).not.toContain(slot);
    }
  });
});

describe('who may ask, and how', () => {
  it('refuses any method but GET', async () => {
    const base = await start();
    for (const path of ['/api/agents/a1/transcript', '/api/slots/w1/transcript']) {
      for (const method of ['POST', 'PUT', 'DELETE']) {
        const r = await raw(base, path, { method });
        expect(r.status, `${method} ${path}`).toBe(405);
        expect(r.headers.allow).toBe('GET');
      }
    }
  });

  it('is a 400 for after or before that is not a number, or both together', async () => {
    const base = await start();
    for (const q of ['after=abc', 'before=-1', 'after=1234567890', 'after=1&before=2', 'after=&x=1', 'after=1.5']) {
      const r = await get(base, `/api/agents/a1/transcript?${q}`);
      expect(r.status, q).toBe(400);
    }
    expect((await get(base, '/api/agents/a1/transcript?after=1&x=2')).status).toBe(200);
  });

  it('answers a request from another computer with the local-only words, even with the token', async () => {
    const base = await start({ host: '0.0.0.0', env: { FOREMAN_DASHBOARD_TOKEN: TOKEN } });
    for (const path of ['/api/agents/a1/transcript', '/api/slots/w1/transcript']) {
      const r = await raw(base, `${path}?token=${TOKEN}`);
      expect(r.status).toBe(403);
      expect(JSON.parse(r.body).error).toBe('Conversations can be read only on a dashboard that listens on this computer alone (127.0.0.1). To use it from another machine, open it through an SSH tunnel.');
      expect(r.body).not.toContain('a1');
    }
    expect((await raw(base, '/api/agents/a1/transcript')).status).toBe(401);
  });

  it('is a 409 in set-up mode', async () => {
    rmSync(join(dir, 'foreman.config.json'));
    const base = await start({ config: null });
    expect((await raw(base, '/api/agents/a1/transcript')).status).toBe(409);
    expect((await raw(base, '/api/slots/w1/transcript')).status).toBe(409);
  });

  it('refuses a request addressed to another host', async () => {
    const base = await start();
    const r = await raw(base, '/api/agents/a1/transcript', { headers: { host: 'evil.example' } });
    expect(r.status).toBe(403);
  });
});
