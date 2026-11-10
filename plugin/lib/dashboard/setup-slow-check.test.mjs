// POST /api/setup/steps/<id>/check with the doctor's real checks: they run in a child of their own
// (`foreman setup steps --step <id>`), one at a time across steps and with a time limit, so a slow
// project check (a fake `sleep 30` in place of `npm test`) never holds the dashboard's process.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STEP_CHECK_WORDS, createDashboardServer, stepCheckRefusal } from './server.mjs';
import { loadConfig } from '../config/load.mjs';
import { writeCache } from '../setup/status.mjs';
import { stretchByLoad } from '../../../test/slow-tests.mjs';

// Long enough for a cold `foreman setup steps` to reach the check, stretched on a busy machine.
const LIMIT_MS = stretchByLoad(5000);
// How fast the dashboard answers while a check runs: 1 s, stretched on a machine with more
// runnable processes than cores. A held loop answers only after the check, 30 s later.
const ANSWER_MS = stretchByLoad(1000);
const BUSY = 'This step is being checked already. Try again in a moment.';
const OLD = { name: 'tools', step: 'tools', ok: true, level: 'error', detail: 'acme tools were fine', checkedAt: '2026-10-29T09:00:00.000Z' };

let dir;
let state;
let mark;
let servers;
// What the dashboards wrote to their stderr (a failed child's words).
let logged;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foreman-setup-slow-'));
  state = join(dir, '.foreman');
  mark = join(dir, 'mark');
  spawnSync('git', ['init', '-q'], { cwd: dir });
  const config = { version: 1, project: { name: 'Acme' }, checks: [{ run: `echo $$ >> "${mark}"; sleep 30`, when: 'always' }] };
  writeFileSync(join(dir, 'foreman.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  writeCache(state, [OLD]);
  servers = [];
  logged = '';
});
afterEach(async () => {
  for (const s of servers) await new Promise((resolve) => s.close(resolve));
  for (const pid of markPids()) kill(pid);
  rmSync(dir, { recursive: true, force: true });
});

function markPids() {
  return existsSync(mark) ? readFileSync(mark, 'utf8').split('\n').filter(Boolean).map(Number) : [];
}
function kill(pid) {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // gone already
  }
}
const gone = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err.code === 'ESRCH';
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Waits until test() holds; `ended`, when given, is a check whose answer means it never will.
async function waitFor(what, test, ms = 30_000, ended = null) {
  let over = false;
  ended?.then(() => { over = true; }, () => { over = true; });
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (test()) return;
    if (over) throw new Error(`the check answered before ${what}${logged ? `; the dashboard logged: ${logged}` : ''}`);
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}${logged ? `; the dashboard logged: ${logged}` : ''}`);
}

// A dashboard, with GET /api/status and /api/setup asked once, so their first-use loading is
// not what the timings below measure.
async function start(more = {}) {
  const stderr = { write: (t) => { logged += t; return true; } };
  const server = createDashboardServer({ root: dir, config: loadConfig(dir).config, stateDir: state, env: {}, setupCheckTimeoutMs: LIMIT_MS, stderr, ...more });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const path of ['/api/status', '/api/setup']) await (await fetch(`${base}${path}`)).text();
  return { server, base };
}
const post = (url) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
const timed = async (url) => {
  const started = Date.now();
  const res = await fetch(url);
  const body = await res.json();
  return { status: res.status, body, ms: Date.now() - started };
};
const stepOf = (body, id) => body.steps.find((s) => s.id === id);

describe('a slow set-up check', () => {
  it('leaves the dashboard answering and the loop ticking, then stops at its time limit', async () => {
    const { base } = await start();
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 20);
    try {
      const sentAt = Date.now();
      const pending = post(`${base}/api/setup/steps/tools/check`);
      await waitFor('the check to start', () => markPids().length > 0, 30_000, pending);
      const status = await timed(`${base}/api/status`);
      expect(status.status).toBe(200);
      expect(status.ms).toBeLessThan(ANSWER_MS);
      const setup = await timed(`${base}/api/setup`);
      expect(setup.status).toBe(200);
      expect(setup.ms).toBeLessThan(ANSWER_MS);
      const tools = stepOf(setup.body, 'tools');
      expect(tools.checking).toBe(true);
      expect(tools.results).toEqual([OLD]);
      expect(stepOf(setup.body, 'project').checking).toBe(false);

      const res = await pending;
      // A loop held by the check would have fired the timer about once in all that time.
      expect(ticks).toBeGreaterThan((Date.now() - sentAt) / 20 / 10);
      expect(res.status).toBe(504);
      const body = await res.json();
      expect(body.error).toBe(STEP_CHECK_WORDS.timedOut(LIMIT_MS));
      expect(body.error).toMatch(/^The checks for this step took longer than \d+ (seconds|minutes?) and were stopped\. Run `foreman doctor` in a terminal to see which one hangs\.$/);
      expect(JSON.stringify(body)).not.toContain('tools');
      const [pid] = markPids();
      await waitFor('the check to end', () => gone(pid), 2000);
      const after = await timed(`${base}/api/setup`);
      expect(stepOf(after.body, 'tools').checking).toBe(false);
      expect(stepOf(after.body, 'tools').results).toEqual([OLD]);
    } finally {
      clearInterval(timer);
    }
  });

  it('starts no second run: the same step is refused, a GET starts nothing, another step waits its turn', async () => {
    const { base } = await start();
    const first = post(`${base}/api/setup/steps/tools/check`).then((res) => ({ res, at: Date.now() }));
    await waitFor('the check to start', () => markPids().length > 0, 30_000, first);
    const second = await post(`${base}/api/setup/steps/tools/check`);
    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({ error: BUSY, retryAfter: 1 });
    expect((await fetch(`${base}/api/setup`)).status).toBe(200);
    const project = post(`${base}/api/setup/steps/project/check`).then(async (res) => ({ res, at: Date.now() }));
    await sleep(300);
    expect(stepOf(await (await fetch(`${base}/api/setup`)).json(), 'project').checking).toBe(true);
    const a = await first;
    const b = await project;
    expect(a.res.status).toBe(504);
    expect(b.res.status).toBe(200);
    expect(b.at).toBeGreaterThanOrEqual(a.at);
    const body = await b.res.json();
    expect(body.step.id).toBe('project');
    expect(body.step.checking).toBe(false);
    expect(body.step.results.find((r) => r.name === 'config')).toMatchObject({ ok: true, step: 'project' });
    expect(markPids()).toHaveLength(1);
  });

  it('closing the dashboard ends the check', async () => {
    const { server, base } = await start({ setupCheckTimeoutMs: 60_000 });
    const pending = post(`${base}/api/setup/steps/tools/check`).catch(() => null);
    await waitFor('the check to start', () => markPids().length > 0, 30_000, pending);
    const [pid] = markPids();
    server.close();
    await waitFor('the check to end', () => gone(pid), 2000);
    await pending;
  });
});

describe('a set-up check whose child fails', () => {
  it('answers 500 in fixed words, and its redacted stderr goes to the log only', async () => {
    const key = 'sk-ant-api03-acmeacmeacme0123456789';
    const fail = join(dir, 'fail.cjs');
    writeFileSync(fail, "process.stderr.write('acme child broke, key ' + process.env.ANTHROPIC_API_KEY + '\\n'); process.exit(1);\n");
    const { base } = await start({ env: { NODE_OPTIONS: `--require=${fail}`, ANTHROPIC_API_KEY: key } });
    const res = await post(`${base}/api/setup/steps/project/check`);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'The checks could not run; run `foreman setup steps` on this computer for the detail.' });
    expect(text).not.toContain('acme child broke');
    expect(text).not.toContain('project');
    expect(logged).toContain('acme child broke');
    expect(logged).not.toContain(key);
    expect(markPids()).toEqual([]);
    const after = await (await fetch(`${base}/api/setup`)).json();
    expect(stepOf(after, 'project').checking).toBe(false);
  });
});

describe('what a step check answers when its child did not finish', () => {
  it('a 504 past the time limit, in minutes from a minute up, else seconds', () => {
    const words = (n) => `The checks for this step took longer than ${n} and were stopped. Run \`foreman doctor\` in a terminal to see which one hangs.`;
    expect(stepCheckRefusal({ timedOut: true, status: null }, 15 * 60_000)).toEqual({ status: 504, error: words('15 minutes') });
    expect(stepCheckRefusal({ timedOut: true, status: null }, 60_000)).toEqual({ status: 504, error: words('1 minute') });
    expect(stepCheckRefusal({ timedOut: true, status: null }, 2500)).toEqual({ status: 504, error: words('3 seconds') });
    expect(stepCheckRefusal({ timedOut: true, status: null }, 1000)).toEqual({ status: 504, error: words('1 second') });
  });

  it('a 500 in fixed words when it failed or could not start, and null when it finished', () => {
    const failed = { status: 500, error: 'The checks could not run; run `foreman setup steps` on this computer for the detail.' };
    expect(stepCheckRefusal({ timedOut: false, status: 1, stderr: 'acme broke' }, 1000)).toEqual(failed);
    expect(stepCheckRefusal({ timedOut: false, status: null, error: 'spawn ENOENT' }, 1000)).toEqual(failed);
    expect(stepCheckRefusal({ timedOut: false, status: null, signal: 'SIGKILL' }, 1000)).toEqual(failed);
    expect(stepCheckRefusal(null, 1000)).toEqual(failed);
    expect(stepCheckRefusal({ timedOut: false, status: 0 }, 1000)).toBeNull();
  });
});
