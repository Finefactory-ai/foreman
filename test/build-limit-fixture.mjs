// The fixture for `foreman run 1` end to end with the build limit, which measures the time since
// the story's last progress, not the session's age (supervisor-build-limit.test.mjs, a story that
// keeps making progress, supervisor-build-limit-steps.test.mjs, one whose agent only takes tool
// steps, supervisor-build-limit-stall.test.mjs, one that stops, and
// supervisor-build-limit-ceiling.test.mjs, one that keeps progressing past the hard ceiling, split
// so their waits run on different workers). A fake `claude` (and `gh`) on the PATH stand in for
// the session and GitHub; FAKE_MODE says what the session does.

import { afterEach, beforeEach } from 'vitest';
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, makeRepos } from './state-repos.mjs';
import { fastTick } from './fast-tick.mjs';
import { endChild, startForeman, useSupervisors } from './supervisors.mjs';

const FOREMAN = fileURLToPath(new URL('../plugin/bin/foreman', import.meta.url));
const HOOK = fileURLToPath(new URL('../plugin/lib/hooks/agent-events.mjs', import.meta.url));

export const SESSION = '4947378a-6485-4e40-9357-671b81c4acf3';
export const PLAN = { ready: true, blocker: '', needs_owner: false, builder: 'developer', resources: [], files: [], design: 'Change acme.mjs.', test_plan: 'acme.test.mjs', done_when: 'npm test' };
const BUILT = { complete: true, summary: 'Built it.', files: ['src/acme.mjs'], commands: [], problem: '' };
const APPROVED = { approved: true, findings: [], checked: 'ran it' };

// progress: starts `foreman stage build "step <n>"` every 700 ms for FAKE_PROGRESS_MS (18 s by
// default); once they have all ended it marks its story blocked in the state overlay and prints
// the result.
// steps: never runs `foreman stage`. Every 700 ms for FAKE_PROGRESS_MS (18 s by default) it runs
// the real agent-events hook (FAKE_HOOK) with a PreToolUse for a TodoWrite step of the agent
// a1 (foreman:builder), the way Claude Code does; once they have all ended it sends that agent's
// SubagentStop, then marks its story blocked and prints the result as progress does.
// stall: the first session writes its agents' transcripts, each with the agent the default
// config gives its role (config/defaults.mjs), and waits; the second saves what
// `foreman workflow-args` printed (and leaves the story note in FAKE_QUEUE_NOTE queued, when set), then ends blocked.
const FAKE_CLAUDE = `#!/usr/bin/env node
const { spawn, spawnSync } = require('node:child_process');
const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const id = process.env.FOREMAN_STORY;
const before = readFileSync(process.env.FAKE_CLAUDE_LOG, 'utf8').split('\\n').filter(Boolean).length;
appendFileSync(process.env.FAKE_CLAUDE_LOG, id + '\\n');
const started = Date.now();
let n = 0;
let running = 0;
const finish = () => {
  const stories = join(process.env.FOREMAN_STATE_DIR, 'stories');
  mkdirSync(stories, { recursive: true });
  const file = join(stories, id + '.json');
  let notes = [];
  try {
    notes = JSON.parse(readFileSync(file, 'utf8')).notes || [];
  } catch {
    // no overlay yet
  }
  writeFileSync(file, JSON.stringify({ id, status: 'blocked', blockedBy: 'Fake session', fields: {}, notes }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 18000, result: 'Could not get further.\\nFACTORY_RESULT: blocked ' + id, total_cost_usd: 0, session_id: 'fake' }));
};
const hook = (event) =>
  new Promise((resolve) => {
    const c = spawn(process.execPath, [process.env.FAKE_HOOK], { stdio: ['pipe', 'ignore', 'ignore'] });
    c.on('exit', resolve);
    c.stdin.on('error', () => {});
    c.stdin.end(JSON.stringify({ hook_event_name: event, agent_id: 'a1', agent_type: 'foreman:builder', tool_name: 'TodoWrite', tool_input: {} }));
  });
const steps = async () => {
  const done = Date.now() - started >= (Number(process.env.FAKE_PROGRESS_MS) || 18000);
  if (!done) {
    running++;
    hook('PreToolUse').then(() => running--);
    return setTimeout(steps, 700);
  }
  if (running > 0) return setTimeout(steps, 100);
  await hook('SubagentStop');
  finish();
};
const step = () => {
  const done = Date.now() - started >= (Number(process.env.FAKE_PROGRESS_MS) || 18000);
  if (!done) {
    n++;
    running++;
    spawn(process.execPath, [process.env.FAKE_FOREMAN, 'stage', 'build', 'step ' + n], { stdio: 'ignore' }).on('exit', () => running--);
    return setTimeout(step, 700);
  }
  if (running > 0) return setTimeout(step, 100);
  finish();
};
const at = (m) => new Date(Date.UTC(2026, 9, 29, 10, m)).toISOString();
const agent = (n, label, agentType, phase, from, to, tokens, output) => {
  const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-acme', '${SESSION}', 'subagents', 'workflows', 'wf_1');
  mkdirSync(dir, { recursive: true });
  const lines = [{ type: 'assistant', timestamp: at(from), message: { id: 'm' + n, model: 'claude-opus-5-5', usage: { input_tokens: tokens, output_tokens: 0 }, content: [{ type: 'text', text: 'working' }] } }];
  if (output) {
    lines.push({ type: 'assistant', timestamp: at(to), message: { id: 'o' + n, content: [{ type: 'tool_use', name: 'StructuredOutput', id: 'tu' + n, input: output }] } });
    lines.push({ type: 'user', timestamp: at(to), message: { content: [{ type: 'tool_result', tool_use_id: 'tu' + n, content: 'Structured output provided successfully' }] } });
  } else {
    lines.push({ type: 'assistant', timestamp: at(to), message: { id: 'o' + n, content: [{ type: 'text', text: 'still reviewing' }] } });
  }
  writeFileSync(join(dir, 'agent-a' + n + '.jsonl'), lines.map((l) => JSON.stringify(l)).join('\\n') + '\\n');
  writeFileSync(join(dir, 'agent-a' + n + '.meta.json'), JSON.stringify({ agentType, description: label, workflowPhase: phase }));
};
if (process.env.FAKE_MODE === 'steps') {
  steps();
} else if (process.env.FAKE_MODE !== 'stall') {
  step();
} else if (before === 0) {
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: '${SESSION}', model: 'claude-opus-5-5', cwd: process.cwd() }));
  agent(1, 'architect:' + id, 'foreman:architect', 'Architect', 0, 5, 100, ${JSON.stringify(PLAN)});
  agent(2, 'build:' + id, 'foreman:builder', 'Build', 5, 30, 5000, ${JSON.stringify(BUILT)});
  agent(3, 'test:' + id + '#1', 'foreman:tester', 'Test', 30, 40, 100, ${JSON.stringify(APPROVED)});
  agent(4, 'compliance:' + id + '#1', 'foreman:compliance-reviewer', 'Review', 40, 55, 700, null);
  setInterval(() => {}, 1000);
} else {
  const r = spawnSync(process.execPath, [process.env.FAKE_FOREMAN, 'workflow-args', id], { encoding: 'utf8' });
  writeFileSync(process.env.FAKE_ARGS_OUT, JSON.stringify({ status: r.status, stdout: r.stdout, stderr: r.stderr }));
  // FAKE_QUEUE_NOTE: a story note (JSON) another process leaves queued, after workflow-args has flushed its own.
  // FAKE_ANSWERED_ITEM: a decision (JSON) the owner answered somewhere that queues no note, such as the artifacts page.
  // Both are left to the supervisor's ticks: the session ends once the queue is empty and the overlay
  // holds the answer, or after 10 s.
  const state = process.env.FOREMAN_STATE_DIR;
  if (process.env.FAKE_ANSWERED_ITEM) {
    const item = JSON.parse(process.env.FAKE_ANSWERED_ITEM);
    mkdirSync(join(state, 'decisions'), { recursive: true });
    writeFileSync(join(state, 'decisions', item.id + '.json'), JSON.stringify(item));
  }
  if (process.env.FAKE_QUEUE_NOTE) {
    const pending = join(state, 'story-notes', 'pending');
    mkdirSync(pending, { recursive: true });
    writeFileSync(join(pending, String(Date.now()).padStart(15, '0') + '-abcdef12.json'), process.env.FAKE_QUEUE_NOTE);
  }
  if (process.env.FAKE_QUEUE_NOTE || process.env.FAKE_ANSWERED_ITEM) {
    const { readdirSync } = require('node:fs');
    const started = Date.now();
    const posted = () => {
      try {
        return readFileSync(join(state, 'stories', id + '.json'), 'utf8').includes(process.env.FAKE_ANSWERED_ITEM ? 'The owner answered' : 'Follow-up created');
      } catch {
        return false;
      }
    };
    const wait = setInterval(() => {
      let queued = 1;
      try {
        queued = readdirSync(join(state, 'story-notes', 'pending')).length;
      } catch {
        queued = 0;
      }
      if ((queued === 0 && posted()) || Date.now() - started > 10000) {
        clearInterval(wait);
        finish();
      }
    }, 100);
  } else {
    finish();
  }
}
`;

const FAKE_GH = `#!/bin/sh
case "$1 $2" in
  "pr list") echo "[]" ;;
  *) exit 1 ;;
esac
`;

const TODO = '---\nid: ACME-1\ntitle: Story ACME-1\nstatus: todo\ndepends_on: []\n---\n\nDo ACME-1.\n\n## Progress notes\n';

// The test's repos: the stall case looks in its base for the session files.
export let repos;
let clone;
let bin;
let log;

export function setUp(watchdog) {
  repos = makeRepos({ version: 1, project: { name: 'Acme' }, console: { adapter: 'files' }, features: { keepAwake: false }, learning: { auto: false }, watchdog });
  clone = repos.clone('acme');
  writeFileSync(join(clone, '.gitignore'), '.foreman/\n');
  mkdirSync(join(clone, 'stories'));
  writeFileSync(join(clone, 'stories', 'ACME-1.md'), TODO);
  git(clone, 'add', '.');
  git(clone, 'commit', '-qm', 'Add ACME-1');
  git(clone, 'push', '-q', 'origin', 'main');
  bin = join(repos.base, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE);
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  chmodSync(join(bin, 'claude'), 0o755);
  chmodSync(join(bin, 'gh'), 0o755);
  log = join(repos.base, 'claude.log');
  writeFileSync(log, '');
}

// Registers the hooks that drop each test's repos and end its supervisor (that one first:
// vitest runs afterEach hooks last first).
export function withBuildLimitRepos() {
  beforeEach(() => {
    repos = null;
  });
  afterEach(() => repos?.cleanup());
  useSupervisors();
}

const runEnv = (fake) => {
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: repos.base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', FAKE_CLAUDE_LOG: log, FAKE_FOREMAN: FOREMAN, FAKE_HOOK: HOOK, CLAUDE_CONFIG_DIR: join(repos.base, 'claude') };
  for (const key of Object.keys(env)) if (/^(FOREMAN|FACTORY)_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key)) delete env[key];
  return { ...env, ...fastTick, ...fake };
};

// Runs `foreman run 1` in the foreground until it exits; its events and run records after.
export async function runFactory(fake) {
  const state = join(clone, '.foreman');
  const child = startForeman(['run', '--foreground', '1'], { cwd: clone, env: runEnv(fake), stdio: 'ignore' });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const timer = setTimeout(() => endChild(child), 90_000);
  const code = await exited;
  clearTimeout(timer);
  const events = readFileSync(join(state, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const runs = readdirSync(join(state, 'runs'))
    .filter((f) => f.startsWith('ACME-1-') && f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(state, 'runs', f), 'utf8')))
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  return { code, state, events, runs, sessions: readFileSync(log, 'utf8').split('\n').filter(Boolean) };
}

