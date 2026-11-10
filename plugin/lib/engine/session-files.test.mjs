import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AGENT_ID, claudeProjectsDir, collectSessionTokens, findAgentTranscript, keepMark, markedProjects, markedSession, readModel, sessionTranscript, MARKS, markSession, readMark, readSubagents, removeSessionFiles, SESSION_ID, sessionPaths, sessionProjectsDir, sweepSessionFiles, unmarkSession } from './session-files.mjs';

const S = '4947378a-6485-4e40-9357-671b81c4acf3';
const T = '0a1b2c3d-0000-4000-8000-000000000001';

const line = (event) => JSON.stringify(event);
const usage = (input, output, read, write) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: write });
const transcript = (input, output, read, write) => `${line({ type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', usage: usage(input, output, read, write) } })}\n`;

let base;
let projects;
let outside;

const write = (file, text) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const agent = (dir, id, meta, counts) => {
  write(join(dir, `agent-${id}.jsonl`), transcript(...counts));
  if (meta) write(join(dir, `agent-${id}.meta.json`), JSON.stringify(meta));
};

// The session's log: an init and a result event that carry S, with modelUsage.
const LOG = [
  line({ type: 'system', subtype: 'init', session_id: S, model: 'claude-opus-5-5', cwd: '/work/acme' }),
  line({ type: 'result', subtype: 'success', session_id: S, num_turns: 12, usage: usage(1, 1, 1, 1), modelUsage: { 'claude-opus-5-5': { inputTokens: 1000, outputTokens: 1000, cacheReadInputTokens: 100000, cacheCreationInputTokens: 10000 } }, result: 'FACTORY_RESULT: shipped ACME-1' }),
].join('\n');

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'foreman-session-files-'));
  projects = join(base, 'projects');
  outside = join(base, 'elsewhere');
  const p1 = join(projects, '-work-acme');
  const p2 = join(projects, '-work-acme-w2');
  // Session S: its transcript, and a folder with a workflow's agents and one plain subagent.
  write(join(p1, `${S}.jsonl`), transcript(1, 1, 1, 1));
  const wf = join(p1, S, 'subagents', 'workflows', 'wf_1');
  agent(wf, 'a1', { agentType: 'foreman:architect', description: 'architect:ACME-1', workflowPhase: 'Architect' }, [10, 20, 3000, 400]);
  agent(wf, 'a2', { agentType: 'foreman:developer', description: 'build:ACME-1', workflowPhase: 'Build' }, [20, 40, 6000, 800]);
  agent(wf, 'a3', { agentType: 'foreman:tester', description: 'test:ACME-1#1', workflowPhase: 'Test' }, [5, 10, 1500, 200]);
  agent(wf, 'a4', { agentType: 'foreman:security-reviewer', description: 'security:ACME-1#1', workflowPhase: 'Review' }, [5, 10, 1500, 200]);
  write(join(p1, S, 'journal.jsonl'), '{}\n');
  agent(join(p2, S, 'subagents'), 'b1', { agentType: 'Explore' }, [1, 2, 300, 40]);
  // Another session T, an unrelated file, and a symlinked project folder that holds an S file.
  write(join(p1, `${T}.jsonl`), transcript(1, 1, 1, 1));
  write(join(p1, T, 'subagents', 'agent-t1.jsonl'), transcript(1, 1, 1, 1));
  write(join(p1, 'notes.txt'), 'keep me');
  write(join(outside, `${S}.jsonl`), 'not ours');
  mkdirSync(join(outside, S));
  symlinkSync(outside, join(projects, '-linked'));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const kept = () => {
  const p1 = join(projects, '-work-acme');
  for (const p of [projects, p1, join(projects, '-work-acme-w2'), join(p1, `${T}.jsonl`), join(p1, T, 'subagents', 'agent-t1.jsonl'), join(p1, 'notes.txt'), join(outside, `${S}.jsonl`), join(outside, S), join(projects, '-linked')]) {
    expect(existsSync(p), p).toBe(true);
  }
  expect(readFileSync(join(outside, `${S}.jsonl`), 'utf8')).toBe('not ours');
};
const gone = () => {
  for (const p of [join(projects, '-work-acme', `${S}.jsonl`), join(projects, '-work-acme', S), join(projects, '-work-acme-w2', S)]) expect(existsSync(p), p).toBe(false);
};

describe('claudeProjectsDir', () => {
  it('is CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects', () => {
    expect(claudeProjectsDir({ CLAUDE_CONFIG_DIR: '/tmp/acme-claude' }, '/home/acme')).toBe(join('/tmp/acme-claude', 'projects'));
    expect(claudeProjectsDir({}, '/home/acme')).toBe(join('/home/acme', '.claude', 'projects'));
  });
});

describe('sessionProjectsDir', () => {
  it("is where Claude Code writes for a session started with that env: its CLAUDE_CONFIG_DIR, else its HOME's .claude", () => {
    expect(sessionProjectsDir({ CLAUDE_CONFIG_DIR: '/tmp/acme-claude' }, '/home/acme')).toBe(join('/tmp/acme-claude', 'projects'));
    expect(sessionProjectsDir({ HOME: '/home/acme' }, '/elsewhere')).toBe(join('/home/acme', '.claude', 'projects'));
    expect(sessionProjectsDir({}, '/home/acme')).toBe(join('/home/acme', '.claude', 'projects'));
  });
});

describe('sessionPaths', () => {
  it("lists only that session's transcript and folder, never through a symlink", () => {
    expect(sessionPaths(projects, S).sort()).toEqual([join(projects, '-work-acme', S), join(projects, '-work-acme', `${S}.jsonl`), join(projects, '-work-acme-w2', S)].sort());
  });

  it('gives nothing for an id that is not a session id', () => {
    for (const id of ['../x', '', '*', '..', `${S}/..`, null, undefined, 7]) expect(sessionPaths(projects, id)).toEqual([]);
    expect(SESSION_ID.test(S)).toBe(true);
  });

  it('gives nothing for a projects folder that is not there', () => {
    expect(sessionPaths(join(base, 'nowhere'), S)).toEqual([]);
  });
});

describe('readSubagents and removeSessionFiles', () => {
  it('pairs each transcript with its meta, {} when the meta is missing or bad', () => {
    write(join(projects, '-work-acme', S, 'subagents', 'agent-c1.jsonl'), transcript(1, 1, 1, 1));
    write(join(projects, '-work-acme', S, 'subagents', 'agent-c1.meta.json'), '{not json');
    const subs = readSubagents(sessionPaths(projects, S));
    expect(subs).toHaveLength(6);
    expect(subs.find((s) => s.meta.description === 'architect:ACME-1').text).toContain('"output_tokens":20');
    expect(subs.filter((s) => Object.keys(s.meta).length === 0)).toHaveLength(1);
  });

  it('readSubagents never follows a symlinked subagents folder', () => {
    const own = join(projects, '-work-acme-w3', S);
    mkdirSync(own, { recursive: true });
    agent(join(outside, 'agents'), 'z', { agentType: 'Explore' }, [9, 9, 9, 9]);
    symlinkSync(join(outside, 'agents'), join(own, 'subagents'));
    const subs = readSubagents(sessionPaths(projects, S));
    expect(subs).toHaveLength(5);
    expect(subs.filter((s) => s.text.includes('"output_tokens":9'))).toEqual([]);
    removeSessionFiles(sessionPaths(projects, S));
    expect(existsSync(join(outside, 'agents', 'agent-z.jsonl'))).toBe(true);
  });

  it('removes exactly the paths it is given', () => {
    const paths = sessionPaths(projects, S);
    expect(removeSessionFiles(paths).sort()).toEqual([...paths].sort());
    gone();
    kept();
  });
});

describe('collectSessionTokens', () => {
  it('with keep (a session that ended in an interrupt), reads the tokens and removes nothing', () => {
    const before = sessionPaths(projects, S);
    expect(before).toHaveLength(3);
    const { agents, removed, kept: keptPaths } = collectSessionTokens({ logText: LOG, projects, keep: true });
    expect(agents).toHaveLength(6);
    expect(removed).toEqual([]);
    expect(keptPaths).toEqual(before);
    for (const p of before) expect(existsSync(p)).toBe(true);
    kept();
  });

  it('with keep, a reading failure still removes nothing', () => {
    const read = () => {
      throw new Error('EIO');
    };
    const out = collectSessionTokens({ logText: LOG, projects, read, keep: true });
    expect(out.agents).toBeNull();
    expect(out.removed).toEqual([]);
    expect(out.kept).toHaveLength(3);
    for (const p of out.kept) expect(existsSync(p)).toBe(true);
  });

  it("reads every agent's tokens, then removes only that session's files", () => {
    const { agents, removed, kept: keptPaths } = collectSessionTokens({ logText: LOG, projects });
    expect(keptPaths).toEqual([]);
    const by = (role, name) => agents.find((a) => a.role === role && (!name || a.name === name));
    expect(by('architect')).toMatchObject({ input: 10, output: 20, cacheRead: 3000, cacheWrite: 400, turns: 1, model: 'claude-opus-5-5', round: null });
    expect(by('builder', 'build')).toMatchObject({ input: 20, output: 40, cacheRead: 6000, cacheWrite: 800, round: 1 });
    expect(by('tester')).toMatchObject({ input: 5, output: 10, round: 1 });
    expect(by('reviewer', 'security')).toMatchObject({ agent: 'foreman:security-reviewer', input: 5, output: 10, round: 1 });
    expect(by('other')).toMatchObject({ name: 'Explore', input: 1, output: 2, cacheRead: 300, cacheWrite: 40 });
    // 1000 in - (10 + 20 + 5 + 5 + 1), and so on
    expect(by('orchestration')).toMatchObject({ input: 959, output: 918, cacheRead: 87700, cacheWrite: 8360, turns: 12, model: 'claude-opus-5-5' });
    expect(agents).toHaveLength(6);
    expect(removed).toHaveLength(3);
    gone();
    kept();
  });

  it('still removes the files when reading fails, and records the agents as unknown', () => {
    const read = () => {
      throw new Error('EIO');
    };
    const { agents, removed } = collectSessionTokens({ logText: LOG, projects, read });
    expect(agents).toBeNull();
    expect(removed).toHaveLength(3);
    gone();
    kept();
  });

  it('with record off, only removes', () => {
    const { agents, removed } = collectSessionTokens({ logText: LOG, projects, record: false });
    expect(agents).toBeNull();
    expect(removed).toHaveLength(3);
    gone();
    kept();
  });

  it('with withSubagents, gives the subagents even with record off, and still removes the files', () => {
    const out = collectSessionTokens({ logText: LOG, projects, record: false, withSubagents: true });
    expect(out.agents).toBeNull();
    expect(out.subagents).toHaveLength(5);
    expect(out.subagents.find((s) => s.meta.description === 'test:ACME-1#1').text).toContain('"output_tokens":10');
    expect(out.removed).toHaveLength(3);
    gone();
    kept();
  });

  it('with withSubagents and record on, counts the agents from the same list', () => {
    const out = collectSessionTokens({ logText: LOG, projects, withSubagents: true });
    expect(out.agents).toHaveLength(6);
    expect(out.subagents).toHaveLength(5);
    expect(Object.keys(out).sort()).toEqual(['agents', 'kept', 'removed', 'subagents']);
  });

  it('with withSubagents, gives null subagents when a transcript cannot be read, and still removes the files', () => {
    // The metas read; the transcripts throw.
    const read = (file, enc) => {
      if (String(file).endsWith('.jsonl')) throw new Error('EIO');
      return readFileSync(file, enc);
    };
    const out = collectSessionTokens({ logText: LOG, projects, read, withSubagents: true });
    expect(out).toMatchObject({ agents: null, subagents: null });
    expect(out.removed).toHaveLength(3);
    gone();
    kept();
  });

  it('with withSubagents, gives [] when the log has no session id', () => {
    expect(collectSessionTokens({ logText: '', projects, withSubagents: true })).toEqual({ agents: null, subagents: [], removed: [], kept: [] });
  });

  it('without withSubagents, returns agents, removed and kept only', () => {
    expect(Object.keys(collectSessionTokens({ logText: LOG, projects })).sort()).toEqual(['agents', 'kept', 'removed']);
  });

  it('removes nothing for a log with no session id, or one that is not a session id', () => {
    const noId = line({ type: 'result', result: 'done', modelUsage: { m: { inputTokens: 1 } } });
    expect(collectSessionTokens({ logText: noId, projects })).toEqual({ agents: null, removed: [], kept: [] });
    const badId = LOG.replaceAll(S, '../-work-acme');
    expect(collectSessionTokens({ logText: badId, projects })).toEqual({ agents: null, removed: [], kept: [] });
    expect(existsSync(join(projects, '-work-acme', `${S}.jsonl`))).toBe(true);
    kept();
  });
});

describe('the session marks', () => {
  let dir;
  beforeEach(() => {
    dir = join(base, 'state');
  });

  it('round-trips a mark, and keepMark turns keep on', () => {
    const log = join(dir, 'logs', 'w1-20261015-090000.log');
    markSession(dir, 'w1', { story: 'ACME-1', pid: 4242, log, projects });
    expect(existsSync(join(MARKS(dir), 'w1.json'))).toBe(true);
    expect(readMark(dir, 'w1')).toEqual({ story: 'ACME-1', pid: 4242, log, projects, keep: false });
    keepMark(dir, 'w1');
    expect(readMark(dir, 'w1')).toEqual({ story: 'ACME-1', pid: 4242, log, projects, keep: true });
    unmarkSession(dir, 'w1');
    expect(readMark(dir, 'w1')).toBeNull();
    expect(existsSync(join(MARKS(dir), 'w1.json'))).toBe(false);
    unmarkSession(dir, 'w1');
  });

  it('keepMark with no mark creates nothing', () => {
    keepMark(dir, 'w2');
    expect(readMark(dir, 'w2')).toBeNull();
    expect(existsSync(join(MARKS(dir), 'w2.json'))).toBe(false);
  });

  it('refuses a slot that is not a slot name', () => {
    for (const slot of ['../x', 'w0', 'x1', '', 'w1/..', undefined]) expect(() => markSession(dir, slot, { story: 'ACME-1', pid: 1, log: 'l', projects })).toThrow();
    expect(existsSync(join(base, 'x.json'))).toBe(false);
  });

  it("keeps another session's mark as <slot>-<pid>.json when a new one is written", () => {
    const log = join(dir, 'logs', 'w1-20261015-090000.log');
    const log2 = join(dir, 'logs', 'w1-20261015-100000.log');
    markSession(dir, 'w1', { story: 'ACME-1', pid: 4242, log, projects });
    markSession(dir, 'w1', { story: 'ACME-2', pid: 5151, log: log2, projects });
    expect(readMark(dir, 'w1')).toEqual({ story: 'ACME-2', pid: 5151, log: log2, projects, keep: false });
    expect(JSON.parse(readFileSync(join(MARKS(dir), 'w1-4242.json'), 'utf8'))).toEqual({ story: 'ACME-1', pid: 4242, log, projects, keep: false });
    expect(readdirSync(MARKS(dir)).sort()).toEqual(['w1-4242.json', 'w1.json']);
  });

  it('overwrites a mark of the same pid, or one with no pid or bad JSON, keeping nothing aside', () => {
    const log = join(dir, 'logs', 'w1-20261015-090000.log');
    const cases = [JSON.stringify({ story: 'ACME-1', pid: 5151, log, projects, keep: false }), JSON.stringify({ story: 'ACME-1', log, projects }), JSON.stringify({ story: 'ACME-1', pid: 'x', log, projects }), JSON.stringify({ story: 'ACME-1', pid: 0, log, projects }), JSON.stringify({ story: 'ACME-1', pid: 1.5, log, projects }), '{not json', '[1]'];
    for (const text of cases) {
      write(join(MARKS(dir), 'w1.json'), text);
      markSession(dir, 'w1', { story: 'ACME-2', pid: 5151, log, projects });
      expect(readdirSync(MARKS(dir)), text).toEqual(['w1.json']);
      expect(readMark(dir, 'w1')).toEqual({ story: 'ACME-2', pid: 5151, log, projects, keep: false });
    }
  });

  it('reads a mark that is bad JSON or not a plain object as null', () => {
    for (const text of ['{not json', '[1]', 'null', '"w"']) {
      write(join(MARKS(dir), 'w3.json'), text);
      expect(readMark(dir, 'w3')).toBeNull();
    }
  });
});

describe('sweepSessionFiles', () => {
  let dir;
  let log;
  const dead = () => false;
  const mark = (slot, extra = {}) => write(join(MARKS(dir), `${slot}.json`), JSON.stringify({ story: `ACME-${slot.slice(1)}`, pid: 999999, log, projects, keep: false, ...extra }));
  const marked = (slot) => existsSync(join(MARKS(dir), `${slot}.json`));
  const still = () => {
    for (const p of [join(projects, '-work-acme', `${S}.jsonl`), join(projects, '-work-acme', S), join(projects, '-work-acme-w2', S)]) expect(existsSync(p), p).toBe(true);
  };

  beforeEach(() => {
    dir = join(base, 'state');
    log = join(dir, 'logs', 'w1-20261015-090000.log');
    write(log, `${LOG}\n`);
  });

  it('removes the files of a session whose ending was never handled, and its mark', () => {
    mark('w1');
    const out = sweepSessionFiles({ dir, alive: dead });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ slot: 'w1', story: 'ACME-1', kept: [] });
    expect(out[0].removed).toHaveLength(3);
    gone();
    kept();
    expect(marked('w1')).toBe(false);
  });

  it('leaves a session that is still alive, asking with its pid and story', () => {
    mark('w2');
    const asked = [];
    expect(sweepSessionFiles({ dir, alive: (m) => (asked.push(m), true) })).toEqual([]);
    expect(asked).toEqual([{ pid: 999999, id: 'ACME-2' }]);
    still();
    expect(marked('w2')).toBe(true);
  });

  it('leaves a slot it is told to skip', () => {
    mark('w3');
    expect(sweepSessionFiles({ dir, skip: ['w3'], alive: dead })).toEqual([]);
    still();
    expect(marked('w3')).toBe(true);
  });

  it('keeps the files of a session that ended in an interrupt, and lists them', () => {
    mark('w4', { keep: true });
    const out = sweepSessionFiles({ dir, alive: dead });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ slot: 'w4', story: 'ACME-4', removed: [] });
    expect(out[0].kept.sort()).toEqual(sessionPaths(projects, S).sort());
    still();
    expect(marked('w4')).toBe(false);
  });

  it('only unmarks a mark whose log is outside the logs folder or whose projects is not an absolute projects folder', () => {
    const outsideLog = join(base, 'w5.log');
    write(outsideLog, `${LOG}\n`);
    for (const extra of [{ log: outsideLog }, { log: join(dir, 'logs', '..', 'w5.log') }, { projects: 'projects' }, { projects: 7 }, { log: 7 }, { projects: base }, { projects: '/' }]) {
      mark('w5', extra);
      const calls = [];
      const read = (...args) => (calls.push(args), readFileSync(...args));
      const out = sweepSessionFiles({ dir, alive: dead, read });
      expect(calls).toEqual([]);
      expect(out).toEqual([{ slot: 'w5', story: 'ACME-5', removed: [], kept: [] }]);
      still();
      expect(existsSync(join(outside, `${S}.jsonl`))).toBe(true);
      expect(existsSync(join(outside, S))).toBe(true);
      expect(marked('w5')).toBe(false);
    }
  });

  it('only unmarks a mark whose log is a symlink out of the logs folder', () => {
    const outsideLog = join(base, 'w5.log');
    write(outsideLog, `${LOG}\n`);
    symlinkSync(outsideLog, join(dir, 'logs', 'w5-link.log'));
    mark('w5', { log: join(dir, 'logs', 'w5-link.log') });
    expect(sweepSessionFiles({ dir, alive: dead })).toEqual([{ slot: 'w5', story: 'ACME-5', removed: [], kept: [] }]);
    still();
    expect(marked('w5')).toBe(false);
  });

  it('takes a log written under another spelling of the state folder (a symlink to it)', () => {
    symlinkSync(dir, join(base, 'state-link'));
    mark('w1', { log: join(base, 'state-link', 'logs', 'w1-20261015-090000.log') });
    expect(sweepSessionFiles({ dir, alive: dead })[0].removed).toHaveLength(3);
    gone();
  });

  it('only unmarks a mark whose log cannot be read', () => {
    mark('w6', { log: join(dir, 'logs', 'missing.log') });
    expect(sweepSessionFiles({ dir, alive: dead })).toEqual([{ slot: 'w6', story: 'ACME-6', removed: [], kept: [] }]);
    still();
    expect(marked('w6')).toBe(false);
  });

  it('carries on past a mark that fails, and names the error in its entry', () => {
    mark('w1');
    mark('w2');
    const alive = (m) => {
      if (m.id === 'ACME-1') throw new Error('ps broke');
      return false;
    };
    const out = sweepSessionFiles({ dir, alive });
    const by = (slot) => out.find((e) => e.slot === slot);
    expect(by('w1')).toMatchObject({ story: 'ACME-1', error: 'ps broke' });
    expect(by('w2').removed).toHaveLength(3);
    gone();
    expect(marked('w2')).toBe(false);
  });

  describe('a mark kept aside as <slot>-<pid>.json', () => {
    const parked = (slot, pid, extra = {}) => write(join(MARKS(dir), `${slot}-${pid}.json`), JSON.stringify({ story: `ACME-${slot.slice(1)}`, pid, log, projects, keep: false, ...extra }));
    const parkedFile = (slot, pid) => existsSync(join(MARKS(dir), `${slot}-${pid}.json`));

    it('sweeps the mark of a session that has ended, and only that file', () => {
      parked('w1', 999999);
      mark('w1', { pid: 123456 });
      const out = sweepSessionFiles({ dir, skip: ['w1'], alive: dead });
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ slot: 'w1', story: 'ACME-1', kept: [] });
      expect(out[0].removed).toHaveLength(3);
      gone();
      kept();
      expect(parkedFile('w1', 999999)).toBe(false);
      expect(marked('w1')).toBe(true);
    });

    it('leaves the mark of a session that is still alive', () => {
      parked('w1', 999999);
      const asked = [];
      expect(sweepSessionFiles({ dir, alive: (m) => (asked.push(m), true) })).toEqual([]);
      expect(asked).toEqual([{ pid: 999999, id: 'ACME-1' }]);
      still();
      expect(parkedFile('w1', 999999)).toBe(true);
    });

    it('keeps the files of a session that ended in an interrupt, and lists them', () => {
      parked('w1', 999999, { keep: true });
      const out = sweepSessionFiles({ dir, alive: dead });
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ slot: 'w1', removed: [] });
      expect(out[0].kept.sort()).toEqual(sessionPaths(projects, S).sort());
      still();
      expect(parkedFile('w1', 999999)).toBe(false);
    });

    it('only unmarks one whose projects is not a Claude projects folder', () => {
      parked('w1', 999999, { projects: base });
      const calls = [];
      const read = (...args) => (calls.push(args), readFileSync(...args));
      expect(sweepSessionFiles({ dir, alive: dead, read })).toEqual([{ slot: 'w1', story: 'ACME-1', removed: [], kept: [] }]);
      expect(calls).toEqual([]);
      still();
      expect(existsSync(join(outside, `${S}.jsonl`))).toBe(true);
      expect(parkedFile('w1', 999999)).toBe(false);
    });

    it('does not take names that are not <slot>-<pid>', () => {
      for (const name of ['w1-0.json', 'w1-x.json', 'w1-12-3.json', 'w1--5.json', 'w0-5.json']) write(join(MARKS(dir), name), JSON.stringify({ story: 'ACME-1', pid: 5, log, projects, keep: false }));
      expect(sweepSessionFiles({ dir, alive: dead })).toEqual([]);
      still();
    });
  });

  it('ignores names that are not slot marks, folders, and a missing marks folder', () => {
    expect(sweepSessionFiles({ dir: join(base, 'nowhere'), alive: dead })).toEqual([]);
    write(join(MARKS(dir), 'notes.json'), JSON.stringify({ story: 'ACME-1', pid: 1, log, projects, keep: false }));
    mkdirSync(join(MARKS(dir), 'w7.json'));
    expect(sweepSessionFiles({ dir, alive: dead })).toEqual([]);
    still();
  });
});

describe('findAgentTranscript', () => {
  const paths = () => sessionPaths(projects, S);

  it('finds agent-<id>.jsonl under a workflow folder and directly under subagents', () => {
    expect(findAgentTranscript(paths(), 'a2')).toBe(join(projects, '-work-acme', S, 'subagents', 'workflows', 'wf_1', 'agent-a2.jsonl'));
    expect(findAgentTranscript(paths(), 'b1')).toBe(join(projects, '-work-acme-w2', S, 'subagents', 'agent-b1.jsonl'));
    expect(findAgentTranscript(paths(), 'zz')).toBeNull();
  });

  it('matches the id whole: a prefix of another agent is not it', () => {
    expect(findAgentTranscript(paths(), 'a')).toBeNull();
  });

  it('refuses an id that is not shaped as an agent id', () => {
    expect(AGENT_ID.test('a1')).toBe(true);
    for (const id of ['../x', 'a/b', 'a.jsonl', '', 'a'.repeat(65), undefined, 5]) expect(findAgentTranscript(paths(), id), String(id)).toBeNull();
  });

  it('never reaches a file through a symlinked folder or a symlinked file', () => {
    write(join(outside, 'real', 'agent-s1.jsonl'), transcript(1, 1, 1, 1));
    mkdirSync(join(projects, '-work-acme', S, 'subagents', 'workflows'), { recursive: true });
    symlinkSync(join(outside, 'real'), join(projects, '-work-acme', S, 'subagents', 'workflows', 'wf_link'));
    expect(findAgentTranscript(paths(), 's1')).toBeNull();
    symlinkSync(join(outside, 'real', 'agent-s1.jsonl'), join(projects, '-work-acme', S, 'subagents', 'agent-s2.jsonl'));
    expect(findAgentTranscript(paths(), 's2')).toBeNull();
    expect(findAgentTranscript([join(outside, 'real')], 's1')).toBeNull();
  });

  it('does not follow a symlinked subagents folder', () => {
    write(join(outside, 'sub', 'agent-s3.jsonl'), transcript(1, 1, 1, 1));
    const sess = join(projects, '-work-acme', 'bbbbbbbb-0000-4000-8000-000000000002');
    mkdirSync(sess, { recursive: true });
    symlinkSync(join(outside, 'sub'), join(sess, 'subagents'));
    expect(findAgentTranscript([sess], 's3')).toBeNull();
  });
});

describe('sessionTranscript', () => {
  it('returns the regular <id>.jsonl among the paths', () => {
    expect(sessionTranscript(sessionPaths(projects, S), S)).toBe(join(projects, '-work-acme', `${S}.jsonl`));
    expect(sessionTranscript(sessionPaths(projects, S), T)).toBeNull();
  });

  it('refuses a symlink', () => {
    const real = join(outside, 'real.jsonl');
    write(real, transcript(1, 1, 1, 1));
    const link = join(projects, '-work-acme', 'cccccccc-0000-4000-8000-000000000003.jsonl');
    symlinkSync(real, link);
    expect(sessionTranscript([link], 'cccccccc-0000-4000-8000-000000000003')).toBeNull();
  });
});

describe('readModel', () => {
  const file = () => join(base, 'm.jsonl');
  const asst = (model) => line({ type: 'assistant', message: { model, content: [] } });

  it('returns the first assistant line\'s model, skipping synthetic ones and internal lines', () => {
    write(file(), [line({ type: 'user', message: { content: 'task' } }), '{"type":"api-request-blob","x":"' + 'y'.repeat(1000) + '"}', asst('<synthetic>'), asst(''), asst('claude-haiku-4-5-20251001'), asst('claude-opus-5-5')].join('\n'));
    expect(readModel(file())).toBe('claude-haiku-4-5-20251001');
  });

  it('does not parse the api-request lines', () => {
    write(file(), `{"type":"api-request","message":{"model":"claude-opus-5-5"},"type":"assistant"}\n${asst('claude-sonnet-5-5')}\n`);
    expect(readModel(file())).toBe('claude-sonnet-5-5');
  });

  it('is null with no assistant line, a bad line, or no file, and never throws', () => {
    write(file(), `${line({ type: 'user', message: {} })}\nnot json\n{"type":"assista`);
    expect(readModel(file())).toBeNull();
    expect(readModel(join(base, 'nowhere.jsonl'))).toBeNull();
    expect(readModel(base)).toBeNull();
  });

  it('reads no further than max', () => {
    write(file(), `${line({ type: 'user', message: { content: 'x'.repeat(5000) } })}\n${asst('claude-opus-5-5')}\n`);
    expect(readModel(file(), { max: 1000 })).toBeNull();
    expect(readModel(file())).toBe('claude-opus-5-5');
  });
});

describe('markedSession', () => {
  let dir;
  let log;
  beforeEach(() => {
    dir = join(base, 'state');
    log = join(dir, 'logs', 'w1-20261015-090000.log');
    write(log, `${LOG}\n`);
  });
  const mark = (extra = {}) => write(join(MARKS(dir), 'w1.json'), JSON.stringify({ story: 'ACME-1', pid: 1, log, projects, keep: false, ...extra }));

  it('gives the session id and its paths for a good mark', () => {
    mark();
    const m = markedSession(dir, 'w1');
    expect(m.sessionId).toBe(S);
    expect(m.projects).toBe(projects);
    expect(m.paths).toEqual(sessionPaths(projects, S));
    expect(m.paths.length).toBeGreaterThan(0);
  });

  it('is null with no mark, a log outside <dir>/logs, a relative projects path, or a log with no session id', () => {
    expect(markedSession(dir, 'w1')).toBeNull();
    write(join(base, 'elsewhere.log'), `${LOG}\n`);
    mark({ log: join(base, 'elsewhere.log') });
    expect(markedSession(dir, 'w1')).toBeNull();
    mark({ projects: 'projects' });
    expect(markedSession(dir, 'w1')).toBeNull();
    mark({ projects: base });
    expect(markedSession(dir, 'w1')).toBeNull();
    write(join(dir, 'logs', 'empty.log'), 'plain text\n');
    mark({ log: join(dir, 'logs', 'empty.log') });
    expect(markedSession(dir, 'w1')).toBeNull();
    write(join(dir, 'logs', 'bad.log'), `${line({ type: 'system', subtype: 'init', session_id: '../../x' })}\n`);
    mark({ log: join(dir, 'logs', 'bad.log') });
    expect(markedSession(dir, 'w1')).toBeNull();
  });

  it('reads only the log\'s first 64 KB', () => {
    write(join(dir, 'logs', 'big.log'), `${line({ type: 'system', subtype: 'init', session_id: S })}\n${'x'.repeat(100_000)}\n`);
    mark({ log: join(dir, 'logs', 'big.log') });
    expect(markedSession(dir, 'w1').sessionId).toBe(S);
    write(join(dir, 'logs', 'late.log'), `${'plain line\n'.repeat(10_000)}${line({ type: 'system', subtype: 'init', session_id: S })}\n`);
    mark({ log: join(dir, 'logs', 'late.log') });
    expect(markedSession(dir, 'w1')).toBeNull();
  });
});

describe('markedProjects', () => {
  const log = '/state/logs/w1-20261015-090000.log';
  const good = { story: 'ACME-1', pid: 1, log, projects: '/home/acme/.claude/projects', keep: false };

  it("gives the mark's projects folder when its log is the one asked for", () => {
    expect(markedProjects(good, log)).toBe('/home/acme/.claude/projects');
  });

  it('is null for a null or non-object mark, another log, a relative folder, or one not named projects', () => {
    expect(markedProjects(null, log)).toBeNull();
    expect(markedProjects(undefined, log)).toBeNull();
    expect(markedProjects('w1', log)).toBeNull();
    expect(markedProjects(7, log)).toBeNull();
    expect(markedProjects(good, '/state/logs/other.log')).toBeNull();
    expect(markedProjects({ ...good, projects: 'projects' }, log)).toBeNull();
    expect(markedProjects({ ...good, projects: base }, log)).toBeNull();
    expect(markedProjects({ ...good, projects: '/' }, log)).toBeNull();
    expect(markedProjects({ ...good, projects: 7 }, log)).toBeNull();
    expect(markedProjects({ ...good, projects: undefined }, log)).toBeNull();
  });
});
