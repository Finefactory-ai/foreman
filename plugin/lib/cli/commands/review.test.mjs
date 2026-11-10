// `foreman review --start` and `--wait`, with real processes and a fake engine CLI on PATH: the
// relay is detached, returns at once, and gives the engine's verdict or says it is unavailable.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../main.mjs';

let dir;
let bin;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-review-'));
  bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
});
afterEach(() => {
  const jobs = path.join(dir, 'state', 'review-engine');
  for (const f of fs.existsSync(jobs) ? fs.readdirSync(jobs) : []) {
    if (!f.endsWith('.json') || f.endsWith('.result.json')) continue;
    try {
      process.kill(-JSON.parse(fs.readFileSync(path.join(jobs, f), 'utf8')).pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

const ENGINE = { name: 'antigravity', model: 'claude-opus-4-6-thinking', minutes: 5 };
const config = (reviewers = [{ name: 'security', agent: 'foreman:security-reviewer', engine: ENGINE }]) =>
  fs.writeFileSync(path.join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'Acme' }, roles: { reviewers } }));
const stateOf = () => path.join(dir, 'state');
const relayDir = () => path.join(stateOf(), 'review-engine');
const VERDICT = { approved: false, findings: [{ severity: 'major', rule: 'r', where: 'a.js:1', observed: 'o', fix: 'f' }], checked: 'read the diff' };

// A fake `agy` on PATH: records its arguments, then behaves as `script` says.
function fakeAgy(script) {
  const log = path.join(dir, 'agy.log');
  fs.writeFileSync(path.join(bin, 'agy'), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.4.12; exit 0; fi\nnode -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))' ${JSON.stringify(log)} "$@"\n${script}\n`, { mode: 0o755 });
  return { argv: () => JSON.parse(fs.readFileSync(log, 'utf8')) };
}
const answer = (over = {}) => `echo '${JSON.stringify({ status: 'SUCCESS', response: 'done', structured_output: VERDICT, duration_seconds: 2.5, usage: { input_tokens: 5 }, ...over }).replace(/'/g, "'\\''")}'`;

async function foreman(argv, { withBin = true } = {}) {
  let out = '';
  let err = '';
  const env = { ...process.env, FOREMAN_PROJECT_DIR: dir, FOREMAN_STATE_DIR: stateOf(), FOREMAN_STORY: 'S-1', FOREMAN_SLOT: 'w1', PATH: withBin ? `${bin}:${process.env.PATH}` : '/usr/bin:/bin' };
  delete env.FOREMAN_RUN;
  const code = await main(argv, { cwd: dir, env, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } });
  return { code, out, err };
}

const promptFile = (text = 'Review this.\nLine two.\n') => {
  const file = path.join(dir, 'prompt.md');
  fs.writeFileSync(file, text);
  return { file, chars: text.length };
};
const idOf = (res) => /started the review as (\S+);/.exec(res.out)?.[1];
const unavailable = (res) => {
  expect(res.code).toBe(1);
  const v = JSON.parse(res.out);
  expect(v).toMatchObject({ engine: 'unavailable', approved: false, findings: [], checked: '' });
  return v.reason;
};

async function finish(id, seconds = 10) {
  for (let i = 0; i < 60; i++) {
    const res = await foreman(['review', '--wait', id, '--for', String(seconds)]);
    if (res.code !== 75) return res;
  }
  throw new Error('the review never ended');
}

describe('foreman review --start', () => {
  it('refuses a reviewer the config does not have, or one without an engine, as unavailable', async () => {
    config([{ name: 'security', agent: 'a' }]);
    const { file, chars } = promptFile();
    expect(unavailable(await foreman(['review', '--start', '--reviewer', 'security', '--prompt', file, '--chars', String(chars)]))).toMatch(/no engine/);
    expect(unavailable(await foreman(['review', '--start', '--reviewer', 'nobody', '--prompt', file, '--chars', String(chars)]))).toMatch(/nobody/);
  });

  it('says the engine CLI is unavailable when it is not on PATH', async () => {
    config();
    const { file, chars } = promptFile();
    const reason = unavailable(await foreman(['review', '--start', '--reviewer', 'security', '--prompt', file, '--chars', String(chars)], { withBin: false }));
    expect(reason).toMatch(/agy/);
    expect(fs.existsSync(relayDir())).toBe(false);
  });

  it('refuses a prompt copy whose length is off, so a shortened review never runs', async () => {
    config();
    fakeAgy(answer());
    const { file, chars } = promptFile('x'.repeat(1000));
    expect(unavailable(await foreman(['review', '--start', '--reviewer', 'security', '--prompt', file, '--chars', String(chars + 100)]))).toMatch(/1000 characters.*1100/);
    expect(unavailable(await foreman(['review', '--start', '--reviewer', 'security', '--prompt', path.join(dir, 'missing.md'), '--chars', '5']))).toMatch(/could not read/);
    expect((await foreman(['review', '--start', '--reviewer', 'security', '--prompt', file, '--chars', String(chars + 10)])).code).toBe(0);
  });

  it('returns at once with an id, --wait says still running, then prints the engine verdict', async () => {
    config();
    const agy = fakeAgy(`sleep 3\n${answer()}`);
    const { file, chars } = promptFile();
    const t0 = Date.now();
    const started = await foreman(['review', '--start', '--reviewer', 'security', '--prompt', file, '--chars', String(chars)]);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(started.code).toBe(0);
    const id = idOf(started);
    expect(id).toMatch(/^w1-/);
    expect(started.out).toBe(`started the review as ${id}; collect the result with: foreman review --wait ${id}\n`);
    const job = JSON.parse(fs.readFileSync(path.join(relayDir(), `${id}.json`), 'utf8'));
    expect(job).toMatchObject({ id, slot: 'w1', story: 'S-1', reviewer: 'security', engine: ENGINE, cwd: dir });
    expect(fs.readFileSync(path.join(relayDir(), `${id}.prompt.md`), 'utf8')).toBe('Review this.\nLine two.\n');
    fs.rmSync(file); // the agent's own copy may go once started

    const waiting = await foreman(['review', '--wait', id, '--for', '1']);
    expect(waiting.code).toBe(75);
    expect(waiting.out).toMatch(/^still running: /);

    const done = await finish(id);
    expect(done.code).toBe(0);
    expect(JSON.parse(done.out)).toEqual({ engine: 'antigravity', model: ENGINE.model, seconds: 2.5, usage: { input_tokens: 5 }, ...VERDICT });
    const argv = agy.argv();
    expect(argv.slice(0, 2)).toEqual(['-p', 'Review this.\nLine two.\n']);
    expect(argv[argv.indexOf('--model') + 1]).toBe(ENGINE.model);
    expect(argv[argv.indexOf('--print-timeout') + 1]).toBe('5m');
    expect(argv).toContain('--json-schema');
    // The result stays for a second --wait.
    expect((await foreman(['review', '--wait', id])).code).toBe(0);
  });

  it('is unavailable when the engine prints no verdict, or fails', async () => {
    config();
    fakeAgy('echo "quota exhausted" >&2; exit 1');
    const { file, chars } = promptFile();
    const id = idOf(await foreman(['review', '--start', '--reviewer', 'security', '--prompt', file, '--chars', String(chars)]));
    const res = await finish(id);
    expect(unavailable(res)).toMatch(/exit code 1.*quota exhausted/);
  });

  it('notes a quota outage until its reset, and refuses the next relay at once without running the CLI', async () => {
    config();
    const message = 'error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 0h2m0s.\nAGY_ERROR: {"status":"RESOURCE_EXHAUSTED","error_code":429}';
    fakeAgy(`cat >&2 <<'EOF'\n${message}\nEOF\nexit 3`);
    const { file, chars } = promptFile();
    const t0 = Date.now();
    const id = idOf(await foreman(['review', '--start', '--reviewer', 'security', '--prompt', file, '--chars', String(chars)]));
    expect(unavailable(await finish(id))).toMatch(/exit code 3.*quota reached/);
    const down = JSON.parse(fs.readFileSync(path.join(relayDir(), 'down.json'), 'utf8'));
    expect(down).toMatchObject({ engine: 'antigravity', reason: expect.stringMatching(/^error: Individual quota reached/) });
    const left = Date.parse(down.until) - t0;
    expect(left).toBeGreaterThan(2 * 60 * 1000);
    expect(left).toBeLessThan(4 * 60 * 1000);

    fs.rmSync(path.join(dir, 'agy.log'));
    const again = await foreman(['review', '--start', '--reviewer', 'security', '--prompt', promptFile().file, '--chars', String(chars)]);
    expect(unavailable(again)).toMatch(/^the antigravity engine is out of quota until .*: error: Individual quota reached/);
    expect(fs.existsSync(path.join(dir, 'agy.log'))).toBe(false);
    expect(fs.readdirSync(relayDir()).filter((f) => f.endsWith('.prompt.md'))).toHaveLength(1);
  });

  it('is unavailable when the worker is gone without a result', async () => {
    config();
    fakeAgy('sleep 30');
    const { file, chars } = promptFile();
    const id = idOf(await foreman(['review', '--start', '--reviewer', 'security', '--prompt', file, '--chars', String(chars)]));
    const job = JSON.parse(fs.readFileSync(path.join(relayDir(), `${id}.json`), 'utf8'));
    process.kill(-job.pid, 'SIGKILL');
    const res = await finish(id, 2);
    expect(unavailable(res)).toMatch(/gone/);
  });

  it('rejects bad usage', async () => {
    config();
    expect((await foreman(['review'])).code).toBe(64);
    expect((await foreman(['review', '--wait', 'not/an/id'])).code).toBe(64);
    expect((await foreman(['review', '--start', '--reviewer', 'security'])).code).toBe(64);
    expect((await foreman(['review', '--wait', 'w1-1-abc'])).code).toBe(1);
  });
});
