// `foreman run 1` end to end, for the tokens each agent of a story session used. A fake `claude`
// on the PATH stands in for the session: it prints an init event with a fixed session id, writes
// that session's transcripts (architect, build, test and a security reviewer) and another
// session's files under CLAUDE_CONFIG_DIR/projects, and prints a result event with modelUsage.
// With FAKE_LEARNED set, it first notes learned ids on its slot's story, as `foreman workflow-args`
// does through noteLearned, so the run record can be checked for them.
// With FAKE_HANG set, it prints no result and hangs until it is signalled, for the owner's stop.
// FAKE_SESSION gives it another session id. With FAKE_SEEN_MARK set, it copies its slot's mark
// there once the mark is written. With FAKE_TERM_KILL set, a SIGTERM makes it kill its supervisor
// (SIGKILL) and exit once that is gone: a supervisor that dies before it handles the ending.
// The supervisor reads each agent's tokens into the run record, then removes only that
// session's files; while the session runs, a mark in <stateDir>/session-files/<slot>.json names
// them, so a start-up sweep can remove those of a session whose ending was never handled; an
// interrupt sets keep on it first, so that sweep keeps an interrupted session's files.
// CLAUDE_CONFIG_DIR is a temp folder, so nothing here touches a real one. One case runs a copy of
// the plugin whose slot environment gives the session a CLAUDE_CONFIG_DIR of its own
// (SESSION_CONFIG in test/supervisor-restart-fixture.mjs).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, makeRepos } from '../../../test/state-repos.mjs';
import { fastTick } from '../../../test/fast-tick.mjs';
import { endChild, runForeman, startForeman, useSupervisors } from '../../../test/supervisors.mjs';
import { SESSION_CONFIG } from '../../../test/supervisor-restart-fixture.mjs';
import * as control from '../console/control.mjs';
import { sweepSessionFiles } from './session-files.mjs';

const PLUGIN = fileURLToPath(new URL('../../', import.meta.url));

const SESSION = '5f0c1d2e-3a4b-4c5d-8e6f-708192a3b4c5';
const OTHER = '6a1b2c3d-4e5f-4a6b-9c7d-8e9fa0b1c2d3';

const FAKE_CLAUDE = `#!/usr/bin/env node
const { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const S = process.env.FAKE_SESSION || '${SESSION}';
const O = '${OTHER}';
const id = process.env.FOREMAN_STORY;
const project = join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-tmp-acme');
const put = (file, text) => { mkdirSync(require('node:path').dirname(file), { recursive: true }); writeFileSync(file, text); };
const usage = (i, o, r, w) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: r, cache_creation_input_tokens: w });
const transcript = (i, o, r, w) => JSON.stringify({ type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', usage: usage(i, o, r, w) } }) + '\\n';
const agent = (name, meta, counts) => {
  const wf = join(project, S, 'subagents', 'workflows', 'wf_1');
  put(join(wf, 'agent-' + name + '.jsonl'), transcript(...counts));
  put(join(wf, 'agent-' + name + '.meta.json'), JSON.stringify(meta));
};
const pause = new Int32Array(new SharedArrayBuffer(4));
const waitFor = (ok, ms) => {
  for (const end = Date.now() + ms; !ok() && Date.now() < end; ) Atomics.wait(pause, 0, 0, 100);
};
if (process.env.FAKE_TERM_KILL) {
  process.on('SIGTERM', () => {
    const supervisor = Number(process.env.FOREMAN_SUPERVISOR_PID);
    const up = () => {
      try {
        process.kill(supervisor, 0);
        return true;
      } catch (err) {
        return err.code === 'EPERM';
      }
    };
    try {
      process.kill(supervisor, 'SIGKILL');
    } catch {}
    waitFor(() => !up(), 30000);
    process.exit(0);
  });
}
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: S, model: 'claude-opus-5-5', cwd: process.cwd() }));
put(join(project, S + '.jsonl'), transcript(1, 1, 1, 1));
agent('a1', { agentType: 'foreman:architect', description: 'architect:' + id, workflowPhase: 'Architect' }, [10, 20, 3000, 400]);
agent('a2', { agentType: 'foreman:developer', description: 'build:' + id, workflowPhase: 'Build' }, [20, 40, 6000, 800]);
agent('a3', { agentType: 'foreman:tester', description: 'test:' + id + '#1', workflowPhase: 'Test' }, [5, 10, 1500, 200]);
agent('a4', { agentType: 'foreman:security-reviewer', description: 'security:' + id + '#1', workflowPhase: 'Review' }, [5, 10, 1500, 200]);
if (process.env.FAKE_BAD) mkdirSync(join(project, S, 'subagents', 'workflows', 'wf_1', 'agent-x.jsonl'), { recursive: true });
put(join(project, O + '.jsonl'), transcript(1, 1, 1, 1));
put(join(project, O, 'subagents', 'agent-o1.jsonl'), transcript(1, 1, 1, 1));
if (process.env.FAKE_LEARNED) {
  const slotFile = join(process.env.FOREMAN_STATE_DIR, 'slots', process.env.FOREMAN_SLOT + '.json');
  const slot = JSON.parse(readFileSync(slotFile, 'utf8'));
  slot.story.learned = ['L-2', 'L-1'];
  writeFileSync(slotFile, JSON.stringify(slot));
}
if (process.env.FAKE_SEEN_MARK) {
  const mark = join(process.env.FOREMAN_STATE_DIR, 'session-files', process.env.FOREMAN_SLOT + '.json');
  waitFor(() => existsSync(mark), 30000);
  copyFileSync(mark, process.env.FAKE_SEEN_MARK);
}
if (process.env.FAKE_HANG) setInterval(() => {}, 1000);
else console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: S, num_turns: 12, duration_ms: 1000, total_cost_usd: 0,
  usage: usage(1, 1, 1, 1),
  modelUsage: { 'claude-opus-5-5': { inputTokens: 1000, outputTokens: 1000, cacheReadInputTokens: 100000, cacheCreationInputTokens: 10000 } },
  result: 'Done.\\nFACTORY_RESULT: shipped ' + id }));
`;

const story = `---\nid: ACME-1\ntitle: Story ACME-1\nstatus: todo\ndepends_on: []\n---\n\nDo ACME-1.\n\n## Progress notes\n`;

let repos;
let clone;
let bin;
let config;

function prepare(features = {}, extra = {}) {
  repos = makeRepos({ version: 1, project: { name: 'Acme' }, console: { adapter: 'files' }, features: { keepAwake: false, ...features }, ...extra });
  clone = repos.clone('acme');
  writeFileSync(join(clone, '.gitignore'), '.foreman/\n');
  mkdirSync(join(clone, 'stories'));
  writeFileSync(join(clone, 'stories', 'ACME-1.md'), story);
  git(clone, 'add', '.');
  git(clone, 'commit', '-qm', 'Add ACME-1');
  git(clone, 'push', '-q', 'origin', 'main');
  bin = join(repos.base, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE);
  chmodSync(join(bin, 'claude'), 0o755);
  config = join(repos.base, 'claude-config');
  mkdirSync(config);
}

beforeEach(() => {
  repos = null;
});
afterEach(() => repos?.cleanup());
// After the hooks above, so it runs before them (vitest runs afterEach hooks last first).
useSupervisors();

const runEnv = (extra = {}) => {
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: repos.base, CLAUDE_CONFIG_DIR: config, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...extra };
  for (const key of Object.keys(env)) if (/^(FOREMAN|FACTORY)_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key)) delete env[key];
  return Object.assign(env, fastTick);
};
const runOnce = (extra = {}, foreman) => runForeman(['run', '--foreground', '1'], { cwd: clone, env: runEnv(extra), encoding: 'utf8', timeout: 55_000, ...(foreman ? { bin: foreman } : {}) });

// A copy of the plugin with `fixtures` (file -> change) made to it; its `foreman` bin.
function pluginCopy(fixtures) {
  const plug = join(repos.base, 'plug');
  cpSync(PLUGIN, plug, { recursive: true, filter: (src) => !src.endsWith('.test.mjs') });
  for (const [file, change] of Object.entries(fixtures)) writeFileSync(join(plug, file), change(readFileSync(join(plug, file), 'utf8')));
  return join(plug, 'bin', 'foreman');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(what, test, child, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (test()) return;
    if (child.exitCode !== null) throw new Error(`the run exited (${child.exitCode}) while waiting for ${what}`);
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const project = (base = config) => join(base, 'projects', '-tmp-acme');
const runRecords = () => {
  const dir = join(clone, '.foreman', 'runs');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))) : [];
};
const markFile = (slot) => join(clone, '.foreman', 'session-files', `${slot}.json`);
const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const put = (file, text) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const events = () => readFileSync(join(clone, '.foreman', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).text);

const sessionGone = (base) => {
  expect(existsSync(join(project(base), `${SESSION}.jsonl`))).toBe(false);
  expect(existsSync(join(project(base), SESSION))).toBe(false);
};
const otherKept = (base) => {
  expect(existsSync(project(base))).toBe(true);
  expect(existsSync(join(project(base), `${OTHER}.jsonl`))).toBe(true);
  expect(existsSync(join(project(base), OTHER, 'subagents', 'agent-o1.jsonl'))).toBe(true);
};
const isUp = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

describe("a story session's tokens per agent", () => {
  it('are written to the run record, and only that session’s files are removed', () => {
    prepare();
    runOnce();
    const records = runRecords();
    expect(records).toHaveLength(1);
    const { agents } = records[0];
    expect(agents.map((a) => a.role)).toEqual(['architect', 'orchestration', 'builder', 'tester', 'reviewer']);
    const by = (role) => agents.find((a) => a.role === role);
    expect(by('architect')).toMatchObject({ name: 'architect', input: 10, output: 20, cacheRead: 3000, cacheWrite: 400 });
    expect(by('builder')).toMatchObject({ name: 'build', round: 1, input: 20, output: 40 });
    expect(by('tester')).toMatchObject({ name: 'test', round: 1, input: 5 });
    expect(by('reviewer')).toMatchObject({ name: 'security', round: 1, input: 5 });
    expect(by('orchestration')).toMatchObject({ input: 960, output: 920, cacheRead: 88000, cacheWrite: 8400, turns: 12, model: 'claude-opus-5-5' });
    expect(records[0].learned).toEqual([]);
    expect('modelMismatches' in records[0]).toBe(false);
    expect(events().filter((e) => e.includes('is set to'))).toEqual([]);
    sessionGone();
    otherKept();
  }, 60_000);

  it('records, and warns of, an agent that ran on another model than its role is set to', () => {
    prepare({}, { roles: { architect: { agent: 'foreman:architect', model: 'opus' }, tester: { agent: 'foreman:tester', model: 'haiku' } } });
    runOnce();
    const records = runRecords();
    expect(records).toHaveLength(1);
    // The fake session runs every agent on Opus: only the tester, set to Haiku, differs.
    expect(records[0].modelMismatches).toEqual([
      { role: 'tester', name: 'test', agent: 'foreman:tester', set: 'haiku', ran: 'claude-opus-5-5', text: 'test (foreman:tester) is set to Haiku but ran on Opus 5.5' },
    ]);
    const warned = events().filter((e) => e.includes('is set to'));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/^ACME-1: test \(foreman:tester\) is set to Haiku but ran on Opus 5\.5; check the role's model with `foreman settings list --group models` and run `foreman doctor`\./);
    const logged = readFileSync(join(clone, '.foreman', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(logged.find((e) => e.text === warned[0]).kind).toBe('warn');
  }, 60_000);

  it('carries the learned ids the session noted into the run record', () => {
    prepare();
    runOnce({ FAKE_LEARNED: '1' });
    const records = runRecords();
    expect(records).toHaveLength(1);
    expect(records[0].learned).toEqual(['L-1', 'L-2']);
    expect(events()).toContain('Factory stopped: Reached the 1 story asked for.');
  }, 60_000);

  it('with run records off: no record, and the session files are still removed', () => {
    prepare({ costMetrics: false });
    runOnce();
    expect(runRecords()).toHaveLength(0);
    expect(events()).toContain('Factory stopped: Reached the 1 story asked for.');
    expect(events().filter((e) => /Could not/.test(e))).toEqual([]);
    sessionGone();
    otherKept();
  }, 60_000);

  it('a transcript that cannot be read still has its session files removed, and the run goes on', () => {
    prepare();
    runOnce({ FAKE_BAD: '1' });
    const records = runRecords();
    expect(records).toHaveLength(1);
    const { agents } = records[0];
    if (agents !== null) expect(agents.every((a) => a.role !== 'other')).toBe(true);
    expect(events()).toContain('Factory stopped: Reached the 1 story asked for.');
    expect(events().filter((e) => /Could not/.test(e))).toEqual([]);
    sessionGone();
    otherKept();
  }, 60_000);

  it("an owner skip records the agents with result 'stopped' and removes the session files", async () => {
    prepare();
    const child = startForeman(['run', '--foreground', '1'], { cwd: clone, env: runEnv({ FAKE_HANG: '1' }) });
    await until('the session files and its mark', () => existsSync(join(project(), `${SESSION}.jsonl`)) && existsSync(join(project(), SESSION, 'subagents', 'workflows', 'wf_1', 'agent-a4.meta.json')) && readJson(markFile('w1')) !== null, child);
    const mark = readJson(markFile('w1'));
    expect(mark).toMatchObject({ story: 'ACME-1', projects: join(config, 'projects'), keep: false });
    expect(Number.isInteger(mark.pid)).toBe(true);
    expect(relative(realpathSync(join(clone, '.foreman', 'logs')), realpathSync(mark.log))).toMatch(/^w1-[^/]+\.log$/);
    control.slotAction(join(clone, '.foreman'), 'w1', 'skip');
    await until('the skip and its run record', () => existsSync(join(clone, '.foreman', 'events.jsonl')) && events().includes('ACME-1 skipped for this run.') && runRecords().length === 1, child);
    await endChild(child);
    await child.exited;
    const records = runRecords();
    expect(records).toHaveLength(1);
    expect(records[0].result).toBe('stopped');
    expect(records[0].agents.map((a) => a.role)).toEqual(['architect', 'builder', 'tester', 'reviewer']);
    expect(records[0].agents.find((a) => a.role === 'builder')).toMatchObject({ input: 20, output: 40 });
    sessionGone();
    otherKept();
    expect(existsSync(markFile('w1'))).toBe(false);
  }, 60_000);

  it("reads the agents from, and removes the files in, the session's own folder when its slot environment sets CLAUDE_CONFIG_DIR", () => {
    prepare();
    const foreman = pluginCopy(SESSION_CONFIG);
    const own = join(repos.base, 'session-config');
    const seen = join(repos.base, 'seen-mark.json');
    runOnce({ ACME_SESSION_CONFIG: own, FAKE_SEEN_MARK: seen }, foreman);
    // The mark the session saw names its own folder, not the supervisor's CLAUDE_CONFIG_DIR.
    expect(readJson(seen)).toMatchObject({ story: 'ACME-1', projects: join(own, 'projects'), keep: false });
    const records = runRecords();
    expect(records).toHaveLength(1);
    expect(records[0].result).toBe('shipped');
    const by = (role) => records[0].agents.find((a) => a.role === role);
    expect(by('architect')).toMatchObject({ input: 10, output: 20 });
    expect(by('builder')).toMatchObject({ name: 'build', round: 1, input: 20, output: 40 });
    expect(by('reviewer')).toMatchObject({ name: 'security', round: 1, input: 5 });
    expect(events().filter((e) => /Could not|session files/.test(e))).toEqual([]);
    sessionGone(own);
    otherKept(own);
    expect(existsSync(project())).toBe(false);
    expect(existsSync(markFile('w1'))).toBe(false);
  }, 60_000);

  it('an interrupt marks the session files to be kept, so a supervisor that dies before the ending leaves them kept', async () => {
    prepare();
    const KEPT = '8c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f';
    const child = startForeman(['run', '--foreground', '1'], { cwd: clone, env: runEnv({ FAKE_HANG: '1', FAKE_TERM_KILL: '1', FAKE_SESSION: KEPT }) });
    await until('the session files and its mark', () => existsSync(join(project(), OTHER, 'subagents', 'agent-o1.jsonl')) && existsSync(join(project(), `${KEPT}.jsonl`)) && readJson(markFile('w1')) !== null, child);
    expect(readJson(markFile('w1')).keep).toBe(false);
    // `foreman run` passes the signal on: the supervisor stops with an interrupt, and the
    // session, on its SIGTERM, kills the supervisor before it can handle the ending.
    process.kill(child.pid, 'SIGTERM');
    await child.exited;
    const mark = readJson(markFile('w1'));
    expect(mark).toMatchObject({ story: 'ACME-1', projects: join(config, 'projects'), keep: true });
    for (const end = Date.now() + 30_000; isUp(mark.pid) && Date.now() < end; ) await sleep(100);
    expect(isUp(mark.pid)).toBe(false);
    expect(events().filter((e) => e.startsWith('Kept the session files of'))).toEqual([]);
    // What the next start's sweep does with that mark (the start-up test below runs it through
    // the supervisor): the files stay, listed as kept, and the mark goes.
    const kept = [join(project(), `${KEPT}.jsonl`), join(project(), KEPT)];
    expect(sweepSessionFiles({ dir: join(clone, '.foreman'), alive: () => false })).toEqual([{ slot: 'w1', story: 'ACME-1', removed: [], kept }]);
    for (const path of kept) expect(existsSync(path), path).toBe(true);
    expect(existsSync(join(project(), KEPT, 'subagents', 'workflows', 'wf_1', 'agent-a2.jsonl'))).toBe(true);
    expect(existsSync(markFile('w1'))).toBe(false);
    otherKept();
  }, 60_000);

  it("at start, removes the files of a session whose ending was never handled, and keeps an interrupted one's", () => {
    prepare();
    const LEFT = '7b2c3d4e-5f6a-4b7c-8d9e-0a1b2c3d4e5f';
    const KEPT = '8c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f';
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    const plant = (slot, story, id, keep) => {
      const log = join(clone, '.foreman', 'logs', `${slot}-20261001-000000.log`);
      put(log, `${JSON.stringify({ type: 'system', subtype: 'init', session_id: id, model: 'claude-opus-5-5', cwd: '/tmp/acme' })}\n`);
      put(join(project(), `${id}.jsonl`), '{}\n');
      put(join(project(), id, 'subagents', `agent-${slot}.jsonl`), '{}\n');
      put(markFile(slot), JSON.stringify({ story, pid: dead, log, projects: join(config, 'projects'), keep }));
    };
    plant('w9', 'ACME-0', LEFT, false);
    plant('w8', 'ACME-8', KEPT, true);
    // Another session's files, as the fake session leaves them, so otherKept() holds before the run too.
    put(join(project(), `${OTHER}.jsonl`), '{}\n');
    put(join(project(), OTHER, 'subagents', 'agent-o1.jsonl'), '{}\n');
    runOnce();
    expect(existsSync(join(project(), `${LEFT}.jsonl`))).toBe(false);
    expect(existsSync(join(project(), LEFT))).toBe(false);
    expect(existsSync(join(project(), `${KEPT}.jsonl`))).toBe(true);
    expect(existsSync(join(project(), KEPT, 'subagents', 'agent-w8.jsonl'))).toBe(true);
    for (const slot of ['w9', 'w8', 'w1']) expect(existsSync(markFile(slot)), slot).toBe(false);
    otherKept();
    const all = events();
    expect(all.filter((e) => e.startsWith('Removed the session files of ACME-0 (w9)'))).toHaveLength(1);
    const kept = all.filter((e) => e.startsWith('Kept the session files of ACME-8 (it ended in an interrupt): '));
    expect(kept).toHaveLength(1);
    expect(kept[0]).toContain(join(project(), `${KEPT}.jsonl`));
    expect(runRecords().map((r) => [r.story, r.result])).toEqual([['ACME-1', 'shipped']]);
    sessionGone();
  }, 60_000);
});
