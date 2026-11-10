// The close of an ended session, read in a child so the supervisor's loop never reads megabytes
// of transcripts or builds a working-tree hash itself.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLOSE_MS, closeSession, fallbackAnswer, runSessionClose } from './session-close.mjs';

const ID = 'ACME-1';
const UUID = '0f3c8a52-6b1d-4c1e-9a77-2d5e4b8c1a90';
const ROLES = {
  architect: { agent: 'foreman:architect' },
  builders: { developer: { agent: 'foreman:builder' } },
  tester: { agent: 'foreman:tester' },
  reviewers: [{ name: 'compliance', agent: 'foreman:compliance-reviewer' }],
};
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete ENV[key];
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, env: ENV, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

let base;
let projects;
let logFile;
let worktree;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'foreman-session-close-'));
  projects = join(base, 'home', '.claude', 'projects');
  mkdirSync(join(projects, '-fake'), { recursive: true });
  logFile = join(base, 'w1.log');
  worktree = join(base, 'repo');
  mkdirSync(worktree);
  git(worktree, 'init', '-q', '-b', 'main');
  writeFileSync(join(worktree, 'a.txt'), 'one\n');
  git(worktree, 'add', '-A');
  git(worktree, 'commit', '-qm', 'start');
  writeFileSync(join(worktree, 'b.txt'), 'untracked\n');
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const line = (o) => `${JSON.stringify(o)}\n`;
const init = line({ type: 'system', subtype: 'init', session_id: UUID, model: 'claude-sonnet-4' });
const resultLine = (text) => line({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, result: text, total_cost_usd: 0.5, session_id: UUID });
const transcript = (output) =>
  [
    line({ type: 'assistant', timestamp: '2026-11-01T10:00:00.000Z', message: { id: 'm1', model: 'claude-sonnet-4', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'tool_use', id: 't1', name: 'StructuredOutput', input: output }] } }),
    line({ type: 'user', timestamp: '2026-11-01T10:00:05.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false, content: 'ok' }] } }),
  ].join('');
const sessionFolder = () => join(projects, '-fake', UUID);
function addSubagent(name, label, phase, agentType, output) {
  const dir = join(sessionFolder(), 'subagents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `agent-${name}.jsonl`), transcript(output));
  writeFileSync(join(dir, `agent-${name}.meta.json`), JSON.stringify({ description: label, workflowPhase: phase, agentType }));
}
const request = (over = {}) => ({ logFile, projects, record: true, keep: false, id: ID, worktree, generated: [], roles: ROLES, ...over });

describe('closeSession', () => {
  it('gives the result a log printed, no tree, removes the session files, and has agents when records are on', () => {
    writeFileSync(logFile, `${init}${resultLine(`Done.\nFACTORY_RESULT: shipped ${ID}`)}`);
    addSubagent('a1', `architect:${ID}`, 'Architect', 'foreman:architect', { ready: true });
    const a = closeSession(request());
    expect(a.result.result).toBe('shipped');
    expect(a.tree).toBeNull();
    expect(a.filesError).toBeNull();
    expect(existsSync(sessionFolder())).toBe(false);
    expect(Array.isArray(a.agents)).toBe(true);
    expect(a.log.sessionId).toBe(UUID);
    expect(a.subagentsRead).toBe(true);
    expect(a.stages.map((s) => s.label)).toEqual([`architect:${ID}`]);
  });

  it('has no agents when records are off, yet still reads the stages', () => {
    writeFileSync(logFile, init);
    addSubagent('a1', `architect:${ID}`, 'Architect', 'foreman:architect', { ready: true });
    const a = closeSession(request({ record: false }));
    expect(a.agents).toBeNull();
    expect(a.stages).toHaveLength(1);
  });

  it('with no result and pipeline transcripts, gives the stages and a 40-hex tree', () => {
    writeFileSync(logFile, init);
    addSubagent('a1', `architect:${ID}`, 'Architect', 'foreman:architect', { ready: true, design: 'x' });
    addSubagent('a2', `build:${ID}`, 'Build', 'foreman:builder', { complete: true });
    const a = closeSession(request());
    expect(a.result.result).toBeNull();
    expect(a.subagentsRead).toBe(true);
    expect(a.stages.map((s) => s.role).sort()).toEqual(['architect', 'builder']);
    expect(a.tree).toMatch(/^[0-9a-f]{40}$/);
  });

  it('leaves the tree null when there is no worktree to hash', () => {
    writeFileSync(logFile, init);
    addSubagent('a1', `architect:${ID}`, 'Architect', 'foreman:architect', { ready: true });
    expect(closeSession(request({ worktree: null })).tree).toBeNull();
  });

  it('keep leaves the files and lists them', () => {
    writeFileSync(logFile, init);
    addSubagent('a1', `architect:${ID}`, 'Architect', 'foreman:architect', { ready: true });
    const a = closeSession(request({ keep: true }));
    expect(a.kept).toEqual([sessionFolder()]);
    expect(existsSync(sessionFolder())).toBe(true);
  });

  it('a missing log gives a null result', () => {
    const a = closeSession(request({ logFile: join(base, 'none.log') }));
    expect(a.result.result).toBeNull();
    expect(a.stages).toEqual([]);
  });

  it('a transcript that cannot be read leaves subagentsRead false and the tree null', () => {
    writeFileSync(logFile, init);
    const dir = join(sessionFolder(), 'subagents');
    mkdirSync(join(dir, 'agent-bad.jsonl'), { recursive: true }); // a folder where a transcript should be
    const a = closeSession(request());
    expect(a.subagentsRead).toBe(false);
    expect(a.tree).toBeNull();
    expect(a.agents).toBeNull();
  });

  it('survives a JSON round trip unchanged', () => {
    writeFileSync(logFile, init);
    addSubagent('a1', `architect:${ID}`, 'Architect', 'foreman:architect', { ready: true });
    const a = closeSession(request());
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
  });
});

describe('runSessionClose', () => {
  const leftovers = (tmp) => readdirSync(tmp).filter((n) => n.startsWith('foreman-close-'));

  it('with the real child gives closeSession\'s answer and leaves no folder', async () => {
    writeFileSync(logFile, init);
    addSubagent('a1', `architect:${ID}`, 'Architect', 'foreman:architect', { ready: true });
    addSubagent('a2', `build:${ID}`, 'Build', 'foreman:builder', { complete: true });
    const tmp = join(base, 'tmp');
    mkdirSync(tmp);
    // closeSession removes the session files, so the direct answer is taken from a copy of the world.
    const expected = closeSession(request({ keep: true }));
    const r = await runSessionClose({ node: process.execPath, request: request({ keep: true }), tmp });
    expect(r.ok).toBe(true);
    expect(r.answer).toEqual(expected);
    expect(leftovers(tmp)).toEqual([]);
  });

  it('passes the request to the child and the answer back through the files', async () => {
    const tmp = join(base, 'tmp');
    mkdirSync(tmp);
    const seen = [];
    const run = async (cmd, args, opts) => {
      seen.push({ cmd, args, opts });
      const requestFile = args[1];
      const answerFile = args[2];
      writeFileSync(answerFile, JSON.stringify({ canned: true }));
      expect(existsSync(requestFile)).toBe(true);
      return { status: 0, timedOut: false };
    };
    const track = new Set();
    const r = await runSessionClose({ node: '/acme/node', request: request(), run, track, tmp });
    expect(r).toEqual({ ok: true, answer: { canned: true } });
    expect(seen[0].cmd).toBe('/acme/node');
    expect(seen[0].args[0]).toMatch(/session-close-child\.mjs$/);
    expect(seen[0].opts).toMatchObject({ timeoutMs: CLOSE_MS, track });
    expect(CLOSE_MS).toBe(6 * 60_000);
    expect(leftovers(tmp)).toEqual([]);
  });

  it.each([
    ['timed out', { status: null, timedOut: true }, 'timed out'],
    ['exit 1', { status: 1, timedOut: false }, 'exit 1'],
    ['could not start', { status: null, timedOut: false, error: 'spawn node ENOENT' }, 'could not start: spawn node ENOENT'],
  ])('gives ok false with why for a child that %s, and leaves no folder', async (_n, result, why) => {
    const tmp = join(base, 'tmp');
    mkdirSync(tmp);
    const r = await runSessionClose({ node: process.execPath, request: request(), run: async () => result, tmp });
    expect(r).toEqual({ ok: false, why });
    expect(leftovers(tmp)).toEqual([]);
  });

  it('gives bad answer for a child that exits 0 with no usable answer', async () => {
    const tmp = join(base, 'tmp');
    mkdirSync(tmp);
    const none = await runSessionClose({ node: process.execPath, request: request(), run: async () => ({ status: 0 }), tmp });
    expect(none).toEqual({ ok: false, why: 'bad answer' });
    const junk = await runSessionClose({
      node: process.execPath,
      request: request(),
      run: async (cmd, args) => (writeFileSync(args[2], 'not json'), { status: 0 }),
      tmp,
    });
    expect(junk).toEqual({ ok: false, why: 'bad answer' });
    expect(leftovers(tmp)).toEqual([]);
  });

  it('never rejects, even when the run throws', async () => {
    const tmp = join(base, 'tmp');
    mkdirSync(tmp);
    const r = await runSessionClose({ node: process.execPath, request: request(), run: async () => Promise.reject(new Error('boom')), tmp });
    expect(r.ok).toBe(false);
    expect(r.why).toContain('boom');
    expect(leftovers(tmp)).toEqual([]);
  });
});

describe('fallbackAnswer', () => {
  it('finds the result at the end of a log over 256 KB', () => {
    const filler = line({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(900) }] } });
    writeFileSync(logFile, `${init}${filler.repeat(400)}${resultLine(`Done.\nFACTORY_RESULT: shipped ${ID}`)}`);
    const a = fallbackAnswer(logFile);
    expect(a.result.result).toBe('shipped');
    expect(a).toMatchObject({ agents: null, kept: [], stages: [], subagentsRead: false, tree: null, filesError: null, stagesError: null });
  });

  it('gives a null result for a missing log', () => {
    expect(fallbackAnswer(join(base, 'none.log')).result.result).toBeNull();
  });
});
